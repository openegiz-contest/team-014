#!/usr/bin/env python3
"""Dispatcher advisor service.

Mirrors the twins from the event stream and, while there is an alarm (or
when the dispatcher asks from the panel), forecasts 30 minutes ahead for
each ventilation option and for two baselines (no new actions, no
protection at all), and publishes the ranking, the recommendation and the
audit of the plan position to the `advisor` twin. When it has located the
fire and the protection runs a generic or a different position, it asks
the protection for the specific one (desired `position` of the `paz` twin).
The live forecast reads only twin state: the scenario's ground truth on the
control twin is never used.

On request (desired `study` of the control twin) it also runs the bench
test of a scenario: ПАЗ in auto, the dispatcher alone, no protection
(advisor/study.py), and publishes the results as the `study` feature.
"""

import collections
import copy
import json
import logging
import signal
import sys
import time

from advisor import analysis, study
from minecore import ditto, layout, twins

log = logging.getLogger("advisor")

PERIOD_S = 10.0

# merge patch: None deletes a property left over from the previous forecast
NO_PROPOSAL = {"value": "none", "title": None, "fire": None, "confidence": None, "paz_position": None,
               "sent_to_paz": None}
NORMAL = {"state": {"value": "normal"}, "estimate": {"value": "null"}, "options": {"value": "[]"},
          "best_option": {"value": "none"}, "fire_location": {"value": "none"}, "fire_hrr": {"value": 0.0, "unit": "МВт"},
          "proposal": NO_PROPOSAL, "audit": {"value": ""}}


class Advisor:
    def __init__(self, client):
        self.client = client
        self.mirror = ditto.Mirror()
        self.inbox = collections.deque()
        self.names = list(twins.definitions())
        self.last_run = 0.0
        self.run_seq = None
        self.scenario_seq = None
        self.study_seq = None
        self.was_emergency = False
        self.bench = study.Bench()
        self.forget()

    def forget(self):
        self.last_est = None
        self.last_audit = ""
        self.q_ref = None
        self.pre = None
        self.alarm_seen = {}
        self.first_alarm_at = None
        self.acted = {}
        self.proposed = set()

    def on_connect(self, client, userdata, flags, reason, properties=None):
        client.subscribe("opentwins/#", qos=0)

    def on_message(self, client, userdata, msg):
        ev = ditto.parse_event(msg.payload)
        if ev:
            self.inbox.append(ev)

    def emergency(self):
        return self.mirror.prop("mine", "emergency", default="normal") != "normal"

    def watch_alarms(self, sim_t):
        """Remembers the mine just before the first alarm and when each
        vehicle's on-board detection fired."""
        sensors = any(self.mirror.prop(s, "state") == "alarm" for s in layout.SENSORS)
        vehicles = [v for v in list(layout.LHDS) + list(layout.TRUCKS) if self.mirror.prop(v, "fire_alarm") is True]
        for v in vehicles:
            self.alarm_seen.setdefault(v, sim_t)
        if not self.emergency() and not sensors and not vehicles:
            self.q_ref = analysis.flow_dirs(self.mirror)
            self.pre = copy.deepcopy(self.mirror.things)
        elif self.first_alarm_at is None:
            self.first_alarm_at = sim_t
        if self.first_alarm_at is not None:
            analysis.watch_protection(self.mirror, sim_t, self.acted)

    def tick(self):
        while self.inbox:
            self.mirror.apply(*self.inbox.popleft())
        now = time.monotonic()
        seq = self.mirror.prop("control", "scenario", "seq", 0)
        if seq != self.scenario_seq:
            self.scenario_seq = seq
            self.forget()
            self.last_run = now + 2.0 - PERIOD_S
            self.publish(dict(NORMAL, recommendation={"value": ""}))
            return
        sim_t = self.mirror.prop("mine", "sim_time", default=0)
        self.watch_alarms(sim_t)
        req = self.mirror.desired("control", "study")
        if req and req.get("seq") and req.get("seq") != self.study_seq:
            self.study_seq = req.get("seq")
            self.run_study(req, sim_t)
            return
        req = self.mirror.desired("control", "advisor_run")
        forced = bool(req and req.get("seq") and req.get("seq") != self.run_seq)
        if forced:
            self.run_seq = req.get("seq")
        emergency = self.emergency()
        if not forced and not (emergency and now - self.last_run >= PERIOD_S):
            if self.was_emergency and not emergency:
                self.was_emergency = False
                self.forget()
                self.publish(dict(NORMAL, recommendation={"value": "Аварийных сигналов нет: прогноз не требуется."}))
            return
        self.last_run = now
        self.was_emergency = emergency
        t0 = time.monotonic()
        position = self.mirror.prop("paz", "position", default=None)
        result = analysis.analyse(self.mirror, position if position not in (None, "none", "P7") else None,
                                  last_est=self.last_est if emergency else None, q_ref=self.q_ref,
                                  pre=self.pre if emergency else None, alarm_seen=self.alarm_seen,
                                  first_alarm_at=self.first_alarm_at, acted=self.acted)
        if result.get("estimate"):
            self.last_est = {k: v for k, v in result["estimate"].items() if k != "held"}
        if result.get("held") and self.last_audit:
            result["audit"] = self.last_audit
        elif result.get("audit"):
            self.last_audit = result["audit"]
        wall = time.monotonic() - t0
        if result["state"] == "normal":
            self.publish(dict(NORMAL, recommendation={"value": "Аварийных сигналов нет: прогноз не требуется."},
                              computed_at={"value": sim_t, "unit": "с"}))
            return
        options = result["options"]
        est = result["estimate"]
        prop = result.get("proposal")
        # one proposal per emergency: later alarms come from smoke spread over
        # the network and point less reliably at the fire than the first ones
        send = bool(prop) and not self.proposed
        if prop:
            prop = dict(prop, sent_to_paz=send or prop["value"] in self.proposed)
        self.publish({
            "state": {"value": "forecast"},
            "estimate": {"value": json.dumps(est, ensure_ascii=False)},
            "fire_location": {"value": est["edge"] if est else "none"},
            "fire_hrr": {"value": est["hrr_mw"] if est else 0.0, "unit": "МВт"},
            "options": {"value": json.dumps(options, ensure_ascii=False)},
            "best_option": {"value": result["best"]},
            "recommendation": {"value": result["recommendation"]},
            "audit": {"value": result["audit"]},
            "proposal": prop if prop else NO_PROPOSAL,
            "computed_at": {"value": sim_t, "unit": "с"},
            "compute_time": {"value": round(wall, 2), "unit": "с"},
            "horizon": {"value": analysis.HORIZON_S / 60, "unit": "мин"},
        })
        if send:
            self.proposed.add(prop["value"])
            reason = f"очаг по датчикам — {prop['fire']} (уверенность {prop['confidence']:.0%})"
            ditto.publish(self.client, "paz", ditto.set_desired("paz", "position", {
                "value": prop["value"], "by": "advisor", "reason": reason, "scenario_seq": self.scenario_seq}))
            log.info("proposed %s to the protection: %s", prop["value"], reason)
        log.info("forecast at t=%s: best=%s (%.1fs) %s", sim_t, result["best"], wall, result["audit"])

    def run_study(self, req, sim_t):
        key = req.get("scenario") or req.get("value")
        faults = [f for f in (req.get("faults") or []) if isinstance(f, str)]
        head = {"scenario": key, "faults": faults, "seq": req.get("seq"), "runs": None, "summary": None, "message": None}
        self.publish({"study": dict(head, value="running")})
        try:
            runs, wall = self.bench.study(key, faults)
        except Exception as exc:  # a bad request must not stop the live advisor
            log.exception("study failed")
            self.publish({"study": dict(head, value="error", message=str(exc))})
            return
        self.publish({"study": dict(head, value="done", horizon_min=study.HORIZON_S / 60,
                                    runs=json.dumps(runs, ensure_ascii=False), summary=study.summary(runs),
                                    computed_at=sim_t, compute_time=wall)})
        log.info("study %s %s done in %.1fs", key, faults, wall)

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
    adv.study_seq = (adv.mirror.desired("control", "study") or {}).get("seq")
    if not adv.emergency():
        adv.publish(dict(NORMAL, recommendation={"value": ""}))
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
