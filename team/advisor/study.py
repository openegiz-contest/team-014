"""Bench test of the emergency plan: one what-if scenario, three ways of
protecting the mine, each run on a private copy of the mine model.

  auto    ПАЗ in automatic mode
  manual  the same plan executed by the dispatcher, 5 min after the alarm
  off     no protection: people leave only when they notice the smoke

The protection is the real ПАЗ code (team/paz): it reads twin-shaped
state built from the model and its commands go back to the model as
desired properties, exactly as on the stand, only without Ditto in
between. The advisor's part is the fire location only: on the first
alarm and then every ADVISOR_PERIOD_S it proposes the plan position of the
located fire to the ПАЗ, as the live advisor does (the forecast itself is
not needed here). The scenario starts from the same warmed-up mine as the
simulator's, so the numbers repeat run after run.
"""

import copy
import json
import logging
import time

from advisor import analysis
from minecore import ditto, layout, pla, twins
from minecore.scenarios import FAULTS, SCENARIOS
from paz import paz as paz_module
from sim.simulator import fresh_model

HORIZON_S = 1800.0
TICK_S = 5.0
SAMPLE_S = 60.0
ADVISOR_PERIOD_S = 100.0   # live advisor: every 10 s of wall time at the default x10
KEY_POINTS = analysis.KEY_POINTS
MODES = {
    "auto": "ПАЗ, автоматический режим",
    "manual": "Ручной режим: диспетчер вводит позицию через 5 мин",
    "off": "Без ПАЗ: люди уходят, когда сами увидят дым",
}
# run only when the plan position reverses the air: the same ПАЗ, normal ventilation
NO_REVERSE = ("auto_normal", "ПАЗ, автоматический режим, но без реверса: проветривание нормальное")


class ModelLink:
    """Stands in for the MQTT client of the ПАЗ: desired properties it
    publishes become commands of the model."""

    def __init__(self, model):
        self.model = model

    def publish(self, topic, payload, qos=0):
        msg = json.loads(payload)
        name = msg["topic"].split("/")[1]
        path = [p for p in msg.get("path", "").split("/") if p]
        if len(path) == 3 and path[0] == "features" and path[2] == "desiredProperties":
            value = (msg.get("value") or {}).get("value")
            if value is not None:
                self.model.apply_desired(name, path[1], value)


def twin_state(m, mode):
    things = {name: {"features": {f: {"properties": p} for f, p in feats.items()}}
              for name, feats in twins.snapshot(m).items()}
    things["control"]["features"]["paz_mode"] = {"properties": {"value": mode}}
    return things


def in_smoke(c):
    return not c.safe and (c.vis < 10.0 or (c.co > layout.CO_ALARM_PPM and not c.sr_on))


def run(base, key, faults, mode, seq=1):
    m = copy.deepcopy(base)
    sc = SCENARIOS[key]
    faults = sorted({f for f in list(sc.get("faults", [])) + list(faults) if f in FAULTS})
    m.start_scenario({"name": key, "seq": seq, "fire_type": sc.get("fire_type"), "faults": faults})
    t0 = m.t
    link = ModelLink(m)
    paz = paz_module.Paz(link)
    paz.seq = seq
    if mode == NO_REVERSE[0]:
        plan = paz.plan
        paz.plan = lambda t, position, manual, due=None: plan(t, dict(position, ventilation="normal"), manual, due)
    mirror = paz.mirror = ditto.Mirror()
    series, smoke_pm, fire_max, risk_max = [], 0.0, 0.0, 0
    next_sample = t0 + SAMPLE_S
    q_ref, request, next_locate = None, None, None
    while m.t - t0 < HORIZON_S - 1e-6:
        mirror.things = twin_state(m, "auto" if mode == NO_REVERSE[0] else mode)
        alarm = any(mirror.prop(s, "state") == "alarm" for s in layout.SENSORS) or \
            any(v.fire_alarm for v in m.vehicles.values())
        if not alarm and next_locate is None:
            q_ref = analysis.flow_dirs(mirror)
        elif alarm and mode != "off" and (next_locate is None or m.t >= next_locate):
            # the advisor locates the fire as on the stand: on the first alarm, then every 100 s
            next_locate = m.t + ADVISOR_PERIOD_S
            est = (analysis.locate(mirror, q_ref) if q_ref else None) or analysis.locate(mirror)
            located = pla.for_fire(est["type"]) if est else None
            if located and request is None and (paz.position is None or paz.position["id"] != located["id"]):
                request = {"value": located["id"], "by": "advisor", "scenario_seq": seq,
                           "reason": f"очаг по датчикам — {est['label']} (уверенность {est['confidence']:.0%})"}
        if request:
            mirror.things["paz"] = {"features": {"position": {"desiredProperties": request}}}
        paz.tick()
        m.step(TICK_S)
        k = m.kpi()
        smoke_pm += sum(c.people for c in m.crews.values() if in_smoke(c)) * TICK_S / 60.0
        risk_max = max(risk_max, k["people_at_risk"])
        if m.fire:
            fire_max = max(fire_max, m.fire.hrr_mw)
        if m.t >= next_sample - 1e-6:
            next_sample += SAMPLE_S
            series.append(dict(t=round((m.t - t0) / 60), safe=k["people_safe"], risk=k["people_at_risk"],
                               injured=k["people_injured"], fed=round(k["max_fed"], 3),
                               smoke_pm=round(smoke_pm), fire_mw=round(m.fire.hrr_mw, 1) if m.fire else 0.0,
                               co={n: round(m.node_c[n][0] + 1.0, 1) for n in KEY_POINTS}))
    k = m.kpi()

    def rel(x):
        return None if x is None else round(x - t0)

    return dict(mode=mode, title=MODES.get(mode) or NO_REVERSE[1],
                detected_at=rel(paz.detected_at), position=paz.position["id"] if paz.position else None,
                refined_from=paz.refined_from, actions_at=rel(min((c["issued"] for c in paz.commands if c["issued"]), default=None)),
                done_at=rel(paz.done_at), faults=sum(1 for c in paz.commands if c["status"] == "fault"),
                people_safe=k["people_safe"], people_total=k["people_total"], people_at_risk=k["people_at_risk"],
                people_at_risk_max=risk_max, people_injured=k["people_injured"], max_fed=round(k["max_fed"], 3),
                smoke_person_min=round(smoke_pm), fire_mw_max=round(fire_max, 1),
                fire_mw_end=round(m.fire.hrr_mw, 1) if m.fire else 0.0, lost_t=round(m.lost_t),
                crews=[dict(id=c.id, people=c.people, state=c.state, fed=round(c.fed, 3)) for c in m.crews.values()],
                log=[[round(t - t0), e] for t, e in paz.events if t >= t0][-14:], series=series)


class Bench:
    def __init__(self):
        self.base = None

    def study(self, key, faults, modes=tuple(MODES)):
        if key not in SCENARIOS or not SCENARIOS[key].get("fire_type") and not SCENARIOS[key].get("faults"):
            raise ValueError(f"unknown scenario {key}")
        quiet = logging.getLogger("paz")
        level = quiet.level
        quiet.setLevel(logging.WARNING)
        try:
            if self.base is None:
                self.base = fresh_model()
            wall = time.monotonic()
            runs = [run(self.base, key, faults, mode) for mode in modes]
            auto = next((r for r in runs if r["mode"] == "auto"), None)
            pos = next((p for p in pla.POSITIONS if auto and p["id"] == auto["position"]), None)
            if pos and pos.get("ventilation") == "reverse":
                runs.append(run(self.base, key, faults, NO_REVERSE[0]))
        finally:
            quiet.setLevel(level)
        return runs, round(time.monotonic() - wall, 1)


def summary(runs):
    parts = []
    for r in runs:
        parts.append(f"{r['title']}: в безопасности {r['people_safe']} из {r['people_total']}, "
                     f"под угрозой {r['people_at_risk']} (макс. {r['people_at_risk_max']}), пострадали {r['people_injured']}, "
                     f"FED {r['max_fed']:.2f}, в дыму {r['smoke_person_min']} чел.·мин")
    return "; ".join(parts) + "."
