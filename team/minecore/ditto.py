"""Talking to the platform: Ditto HTTP API, Ditto protocol over MQTT, and a
local mirror of the twins kept up to date from the twin events that the
platform publishes on `opentwins/...`."""

import base64
import copy
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request

from . import NAMESPACE, thing_id

log = logging.getLogger("ditto")

DITTO_URL = os.environ.get("DITTO_URL", "http://localhost:8080").rstrip("/")
DITTO_USER = os.environ.get("DITTO_USER", "ditto")
DITTO_PASSWORD = os.environ.get("DITTO_PASSWORD", "")
MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
TELEMETRY = "telemetry"


def _auth():
    return "Basic " + base64.b64encode(f"{DITTO_USER}:{DITTO_PASSWORD}".encode()).decode()


def http(method, path, body=None, timeout=30):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{DITTO_URL}{path}", data=data, method=method,
                                 headers={"Authorization": _auth(), "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, (json.loads(raw) if raw else None)


def wait_for_ditto(tries=90):
    for i in range(tries):
        try:
            status, _ = http("GET", "/api/2/things?ids=" + thing_id("mine"))
            if status < 500:
                return True
        except urllib.error.HTTPError as exc:
            if exc.code < 500:
                return True
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError):
            pass
        time.sleep(2)
    return False


def get_things(names, fields=None):
    out = {}
    names = list(names)
    for i in range(0, len(names), 40):
        ids = ",".join(thing_id(n) for n in names[i:i + 40])
        q = "/api/2/things?ids=" + urllib.parse.quote(ids, safe=",:")
        if fields:
            q += "&fields=" + urllib.parse.quote(fields)
        _, items = http("GET", q)
        for t in items or []:
            out[t["thingId"].split(":", 1)[1]] = t
    return out


# -- Ditto protocol messages ---------------------------------------------------
def merge_features(name, features):
    """Partial update: only the given feature properties are touched, the
    desired properties written by other modules survive."""
    return {
        "topic": f"{NAMESPACE}/{name}/things/twin/commands/merge",
        "headers": {"content-type": "application/merge-patch+json"},
        "path": "/features",
        "value": {f: {"properties": p} for f, p in features.items()},
    }


def merge_raw(name, value):
    return {
        "topic": f"{NAMESPACE}/{name}/things/twin/commands/merge",
        "headers": {"content-type": "application/merge-patch+json"},
        "path": "/features",
        "value": value,
    }


def set_desired(name, feature, props):
    return {
        "topic": f"{NAMESPACE}/{name}/things/twin/commands/modify",
        "path": f"/features/{feature}/desiredProperties",
        "value": props,
    }


def mqtt_client(client_id):
    import paho.mqtt.client as mqtt
    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{client_id}-{os.getpid()}")
    for _ in range(60):
        try:
            client.connect(MQTT_HOST, MQTT_PORT, keepalive=30)
            return client
        except OSError as exc:
            log.warning("MQTT %s:%s not reachable (%s), retrying", MQTT_HOST, MQTT_PORT, exc)
            time.sleep(2)
    raise SystemExit("MQTT not reachable")


def wait_connected(client, timeout=60):
    """QoS 0 messages published before the CONNACK are dropped."""
    end = time.monotonic() + timeout
    while not client.is_connected() and time.monotonic() < end:
        time.sleep(0.1)


def publish(client, name, message):
    client.publish(f"{TELEMETRY}/{name}", json.dumps(message, ensure_ascii=False), qos=0)


# -- events ------------------------------------------------------------------------
def parse_event(payload):
    """Returns (name, action, path list, value) for a twin event of our
    namespace, or None."""
    try:
        msg = json.loads(payload)
    except (ValueError, UnicodeDecodeError):
        return None
    topic = msg.get("topic", "")
    parts = topic.split("/")
    if len(parts) < 6 or parts[0] != NAMESPACE or parts[2] != "things" or parts[4] != "events":
        return None
    path = [p for p in msg.get("path", "/").split("/") if p]
    return parts[1], parts[5], path, msg.get("value")


def deep_merge(dst, src):
    for k, v in src.items():
        if v is None:
            dst.pop(k, None)
        elif isinstance(v, dict) and isinstance(dst.get(k), dict):
            deep_merge(dst[k], v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


class Mirror:
    """name -> thing JSON (attributes, features), updated from events."""

    def __init__(self):
        self.things = {}

    def load(self, names):
        for name, t in get_things(names).items():
            self.things[name] = t

    def apply(self, name, action, path, value):
        thing = self.things.setdefault(name, {"features": {}, "attributes": {}})
        if action == "deleted" and not path:
            self.things.pop(name, None)
            return
        if not path:
            if isinstance(value, dict):
                if action == "merged":
                    deep_merge(thing, value)
                else:
                    self.things[name] = value
            return
        node = thing
        for p in path[:-1]:
            node = node.setdefault(p, {})
            if not isinstance(node, dict):
                return
        last = path[-1]
        if action == "deleted":
            node.pop(last, None)
        elif action == "merged" and isinstance(value, dict) and isinstance(node.get(last), dict):
            deep_merge(node[last], value)
        else:
            node[last] = value

    def prop(self, name, feature, key="value", default=None):
        try:
            return self.things[name]["features"][feature]["properties"].get(key, default)
        except (KeyError, TypeError, AttributeError):
            return default

    def desired(self, name, feature):
        try:
            return self.things[name]["features"][feature].get("desiredProperties")
        except (KeyError, TypeError, AttributeError):
            return None

    def attr(self, name, key, default=None):
        try:
            return self.things[name]["attributes"].get(key, default)
        except (KeyError, AttributeError):
            return default
