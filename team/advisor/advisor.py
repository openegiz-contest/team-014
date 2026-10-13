#!/usr/bin/env python3
"""Dispatcher advisor service.

Mirrors the twins from the event stream and, while there is an alarm (or
when the dispatcher asks from the panel), forecasts 30 minutes ahead for
each ventilation option and publishes the ranking, the recommendation and
the audit of the plan position to the `advisor` twin. It reads only twin
state: the scenario's ground truth on the control twin is never used.
"""

import collections
import json
import logging
import signal
import sys
import time

from advisor import analysis
from minecore import ditto, twins

log = logging.getLogger("advisor")

PERIOD_S = 10.0


class Advisor:
    def __init__(self, client):
        self.client = client
        self.mirror = ditto.Mirror()
        self.inbox = collections.deque()
        self.names = list(twins.definitions())
        self.last_run = 0.0
        self.run_seq = None
        self.scenario_seq = None
        self.was_emergency = False
        self.last_est = None
        self.last_audit = ""
        self.q_ref = None

    def on_connect(self, client, userdata, flags, reason, properties=None):
        client.subscribe("opentwins/#", qos=0)

    def on_message(self, client, userdata, msg):
        ev = ditto.parse_event(msg.payload)
        if ev:
            self.inbox.append(ev)

    def emergency(self):
        if self.mirror.prop("mine", "emergency", default="normal") != "normal":
            return True
        return False

    def tick(self):
        while self.inbox:
            self.mirror.apply(*self.inbox.popleft())
        now = time.monotonic()
        seq = self.mirror.prop("control", "scenario", "seq", 0)
        if seq != self.scenario_seq:
            self.scenario_seq = seq
            self.last_est = None
            self.last_audit = ""
            self.last_run = now + 2.0 - PERIOD_S
            self.publish({"state": {"value": "normal"}, "estimate": {"value": "null"}, "options": {"value": "[]"},
                          "recommendation": {"value": ""}, "audit": {"value": ""}})
            return
        if not self.emergency() and not any(self.mirror.prop(s, "state") == "alarm" for s in analysis.layout.SENSORS):
            self.q_ref = analysis.flow_dirs(self.mirror)
        req = self.mirror.desired("control", "advisor_run")
        forced = bool(req and req.get("seq") and req.get("seq") != self.run_seq)
        if forced:
            self.run_seq = req.get("seq")
        emergency = self.emergency()
        if not forced and not (emergency and now - self.last_run >= PERIOD_S):
            if self.was_emergency and not emergency:
                self.was_emergency = False
                self.last_est = None
                self.last_audit = ""
            return
        self.last_run = now
        self.was_emergency = emergency
        t0 = time.monotonic()
        position = self.mirror.prop("paz", "position", default=None)
        result = analysis.analyse(self.mirror, position if position not in (None, "none", "P7", "P0") else None,
                                  last_est=self.last_est if emergency else None, q_ref=self.q_ref)
        if result.get("estimate"):
            self.last_est = {k: v for k, v in result["estimate"].items() if k != "held"}
        if result.get("held") and self.last_audit:
            result["audit"] = self.last_audit
        elif result.get("audit"):
            self.last_audit = result["audit"]
        wall = time.monotonic() - t0
        sim_t = self.mirror.prop("mine", "sim_time", default=0)
        if result["state"] == "normal":
            self.publish({"state": {"value": "normal"}, "estimate": {"value": "null"}, "options": {"value": "[]"},
                          "recommendation": {"value": "Аварийных сигналов нет: прогноз не требуется."},
                          "audit": {"value": ""}, "computed_at": {"value": sim_t, "unit": "с"}})
            return
        options = [{k: v for k, v in o.items()} for o in result["options"]]
        best = min((o for o in options if o["option"] != "nothing"), key=lambda o: o["harm"])
        est = result["estimate"]
        self.publish({
            "state": {"value": "forecast"},
            "estimate": {"value": json.dumps(est, ensure_ascii=False)},
            "fire_location": {"value": est["airway"] if est and "airway" in est else (est["edge"] if est else "none")},
            "fire_hrr": {"value": est["hrr_mw"] if est else 0.0, "unit": "МВт"},
            "options": {"value": json.dumps(options, ensure_ascii=False)},
            "best_option": {"value": best["option"]},
            "recommendation": {"value": result["recommendation"]},
            "audit": {"value": result["audit"]},
            "computed_at": {"value": sim_t, "unit": "с"},
            "compute_time": {"value": round(wall, 2), "unit": "с"},
            "horizon": {"value": analysis.HORIZON_S / 60, "unit": "мин"},
        })
        log.info("forecast at t=%s: best=%s (%.1fs) %s", sim_t, best["option"], wall, result["audit"])

    def publish(self, feats):
        ditto.publish(self.client, "advisor", ditto.merge_features("advisor", feats))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not ditto.wait_for_ditto():
        log.error("Ditto not reachable")
        return 1
    client = ditto.mqtt_client("bolashak-advisor")
    adv = Advisor(client)
    client.on_connect = adv.on_connect
    client.on_message = adv.on_message
    client.loop_start()
    ditto.wait_connected(client)
    adv.mirror.load(adv.names)
    adv.scenario_seq = adv.mirror.prop("control", "scenario", "seq", 0)
    if not adv.emergency():
        adv.publish({"state": {"value": "normal"}})
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(1))
    log.info("advisor started, %d twins mirrored", len(adv.mirror.things))
    while not stopping:
        try:
            adv.tick()
        except Exception:
            log.exception("tick failed")
        time.sleep(1.0)
    client.loop_stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
