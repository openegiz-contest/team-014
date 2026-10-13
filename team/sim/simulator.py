#!/usr/bin/env python3
"""Bolashak mine simulator.

Runs the mine model (ventilation network, fire and smoke, sensors,
production chain, people) and keeps the twins in Ditto in step with it:
feature properties go out as Ditto protocol `merge` commands on
`telemetry/<twin>`; commands come back as twin events on `opentwins/...`
whenever a module (protection, dispatcher, scenario panel) writes the
`desiredProperties` of a door, valve, fan, substation or the control twin.
The simulator never reads InfluxDB and never bypasses Ditto.
"""

import collections
import json
import logging
import os
import signal
import sys
import time

from minecore import ditto, layout, twins
from minecore.model import MineModel
from minecore.scenarios import FAULTS, SCENARIOS

log = logging.getLogger("sim")

INTERVAL = float(os.environ.get("SIM_INTERVAL", "1.0"))
SPEED = float(os.environ.get("SIM_SPEEDUP", "10"))
WARMUP_S = 7200.0
FULL_REFRESH_TICKS = 30

# twin -> features that accept commands through desiredProperties
COMMAND_FEATURES = {
    **{d: ["position"] for d in layout.DOORS},
    **{v: ["position"] for v in layout.VALVES},
    **{s: ["power"] for s in layout.SUBSTATIONS},
    **{f: ["run", "mode"] for f in layout.FANS},
    **{p: ["command"] for p in ("conveyor-640", "crusher-640", "hoist-skip")},
    **{v: ["command"] for v in list(layout.LHDS) + list(layout.TRUCKS)},
    "mine": ["evacuation"],
}


def fresh_model():
    m = MineModel()
    m.step(WARMUP_S)
    m.events.clear()
    m.lost_t = 0.0
    return m


def desired_updates(name, action, path, value):
    """Yield (feature, desiredProperties) found in one twin event."""
    if action == "deleted":
        return
    if len(path) >= 3 and path[0] == "features" and path[2] == "desiredProperties":
        if len(path) == 3 and isinstance(value, dict):
            yield path[1], value
        elif len(path) == 4:
            yield path[1], {path[3]: value}
    elif len(path) == 2 and path[0] == "features" and isinstance(value, dict):
        if isinstance(value.get("desiredProperties"), dict):
            yield path[1], value["desiredProperties"]
    elif path == ["features"] and isinstance(value, dict):
        for f, fv in value.items():
            if isinstance(fv, dict) and isinstance(fv.get("desiredProperties"), dict):
                yield f, fv["desiredProperties"]


class Simulator:
    def __init__(self, client):
        self.client = client
        self.model = fresh_model()
        self.speed = SPEED
        self.inbox = collections.deque()
        self.last = {}
        self.ticks = 0
        self.seq = 0

    # -- MQTT -------------------------------------------------------------------
    def on_connect(self, client, userdata, flags, reason, properties=None):
        client.subscribe("opentwins/#", qos=0)
        log.info("subscribed to opentwins/#")

    def on_message(self, client, userdata, msg):
        ev = ditto.parse_event(msg.payload)
        if ev:
            self.inbox.append(ev)

    # -- commands ----------------------------------------------------------------------
    def handle_events(self):
        while self.inbox:
            name, action, path, value = self.inbox.popleft()
            for feature, props in desired_updates(name, action, path, value):
                self.command(name, feature, props)

    def command(self, name, feature, props):
        value = props.get("value")
        if name == "control":
            if feature == "scenario":
                seq = props.get("seq", 0)
                if seq and seq == self.seq:
                    return
                self.seq = seq
                self.start(value, props.get("faults") or [], seq)
            elif feature == "speed":
                try:
                    self.speed = max(0.0, min(60.0, float(value)))
                except (TypeError, ValueError):
                    return
                log.info("speed %.0fx", self.speed)
                ditto.publish(self.client, "control",
                              ditto.merge_features("control", {"speed": {"value": self.speed, "unit": "x"}}))
            return
        if value is None:
            return
        log.info("command %s.%s = %s", name, feature, value)
        self.model.apply_desired(name, feature, value)

    def start(self, key, faults, seq):
        """Every scenario starts from a clean, normal mine."""
        log.info("scenario %s faults %s", key, faults)
        self.model = fresh_model()
        self.clear_desired()
        if key and key != "normal":
            sc = SCENARIOS.get(key)
            if sc is None:
                log.warning("unknown scenario %s", key)
                return
            faults = [f for f in list(sc.get("faults", [])) + list(faults) if f in FAULTS]
            self.model.start_scenario({"name": key, "seq": seq, "fire_type": sc.get("fire_type"),
                                       "faults": sorted(set(faults))})
        else:
            self.model.scenario = {"active": False, "name": "normal", "seq": seq}
        self.last.clear()

    def clear_desired(self):
        """Back to normal: drop the commands left on the actuators."""
        for name, feats in COMMAND_FEATURES.items():
            ditto.publish(self.client, name, ditto.merge_raw(name, {f: {"desiredProperties": None} for f in feats}))

    # -- publishing ---------------------------------------------------------------------
    def publish(self):
        snap = twins.snapshot(self.model)
        full = self.ticks % FULL_REFRESH_TICKS == 0
        sent = 0
        for name, feats in snap.items():
            prev = self.last.setdefault(name, {})
            changed = {f: p for f, p in feats.items() if full or prev.get(f) != p}
            if not changed:
                continue
            ditto.publish(self.client, name, ditto.merge_features(name, changed))
            prev.update(changed)
            sent += 1
        return sent

    def run(self, stop):
        while not stop():
            t0 = time.monotonic()
            self.handle_events()
            if self.speed > 0:
                self.model.step(self.speed * INTERVAL)
            sent = self.publish()
            self.ticks += 1
            if self.ticks % 60 == 0:
                m = self.model
                k = m.kpi()
                log.info("t=%6.0f s | %s | %.0f t/h | Q %.0f m3/s | safe %d/%d | fire %s | msgs %d",
                         m.t, m.scenario.get("name", "normal"), m.production_tph(), m.net.q["fan"],
                         k["people_safe"], k["people_total"],
                         f"{m.fire.hrr_mw:.1f} MW" if m.fire and not m.fire.extinct else "-", sent)
            time.sleep(max(0.0, INTERVAL - (time.monotonic() - t0)))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    client = ditto.mqtt_client("bolashak-sim")
    sim = Simulator(client)
    client.on_connect = sim.on_connect
    client.on_message = sim.on_message
    client.loop_start()
    ditto.wait_connected(client)
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(1))
    log.info("simulating at %.0fx, publishing every %.1f s", sim.speed, INTERVAL)
    sim.run(lambda: bool(stopping))
    client.loop_stop()
    client.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(main())
