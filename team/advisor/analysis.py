"""Forecasts for the dispatcher, built only from what the twins report.

1. Locate the fire: candidate fire loads (plant, depot, chargers, vehicles
   whose detection fired) are scored against the alarmed gas stations,
   following the airflow directions the airway twins report.
2. Estimate its heat release from the CO at the first downstream station.
3. Rebuild a mine model from the twins (actuator positions, fans, people,
   smoke already in the airways) and run it ahead for each option.
4. Rank options by harm to people, then compare with the plan position.
"""

import math

from minecore import layout, pla
from minecore.fire import Fire
from minecore.model import CO_DENSITY, MineModel

HORIZON_S = 1800.0
SAMPLE_S = 120.0


# -- fire location ------------------------------------------------------------------
def flow_dirs(mirror):
    out = {}
    for eid in layout.AIRWAYS:
        q = mirror.prop("aw-" + eid, "airflow", default=None)
        out[eid] = float(q) if q is not None else 0.0
    return out


def downstream_sensors(edge, s, q):
    """Gas stations reached by air leaving point (edge, s), with travel
    distance in metres along the current flow directions."""
    by_edge = {}
    for sid, c in layout.SENSORS.items():
        by_edge.setdefault(c["edge"], []).append((sid, c["s"]))
    reached = {}
    flow = q.get(edge, 0.0)
    if abs(flow) < 0.05:
        return reached
    length = layout.edge_length(edge)
    for sid, ss in by_edge.get(edge, []):
        if (flow > 0 and ss > s) or (flow < 0 and ss < s):
            reached[sid] = abs(ss - s) * length
    node = layout.EDGES[edge]["to"] if flow > 0 else layout.EDGES[edge]["frm"]
    start = (1 - s) * length if flow > 0 else s * length
    frontier = [(start, node)]
    seen = {}
    while frontier:
        frontier.sort()
        d, n = frontier.pop(0)
        if n in seen or n == "ATM":
            continue
        seen[n] = d
        for eid in layout.AIRWAYS:
            e = layout.EDGES[eid]
            f = q.get(eid, 0.0)
            if abs(f) < 0.05:
                continue
            if (f > 0 and e["frm"] == n) or (f < 0 and e["to"] == n):
                ln = layout.edge_length(eid)
                for sid, ss in by_edge.get(eid, []):
                    dist = d + (ss if f > 0 else 1 - ss) * ln
                    reached[sid] = min(reached.get(sid, 1e9), dist)
                frontier.append((d + ln, e["to"] if f > 0 else e["frm"]))
    return reached


def candidates(mirror):
    out = []
    for ftype, c in layout.FIRE_TYPES.items():
        if c.get("vehicle"):
            continue
        out.append(dict(type=ftype, edge=c["edge"], s=c["s"], label=c["name"], source="fire load"))
    for vid in list(layout.LHDS) + list(layout.TRUCKS):
        loc = mirror.things.get(vid, {}).get("features", {}).get("location", {}).get("properties", {})
        if not loc.get("airway"):
            continue
        ftype = "bev_lhd" if vid.startswith("lhd") else "bev_truck"
        alarm = mirror.prop(vid, "fire_alarm") is True
        out.append(dict(type=ftype, edge=loc["airway"], s=float(loc.get("s", 0.5)),
                        label=f"{mirror.attr(vid, 'name', vid)}", source="vehicle", vehicle=vid, alarm=alarm))
    return out


def locate(mirror, q=None):
    alarmed = {s for s in layout.SENSORS if mirror.prop(s, "state") == "alarm"}
    faulty = {s for s in layout.SENSORS if mirror.prop(s, "state") == "fault"}
    q = q or flow_dirs(mirror)
    best = None
    for c in candidates(mirror):
        reach = downstream_sensors(c["edge"], c["s"], q)
        hits = [s for s in reach if s in alarmed]
        quiet_near = [s for s, d in reach.items() if s not in alarmed and s not in faulty and d < 250]
        explained = len(hits) / max(1, len(alarmed)) if alarmed else 0.0
        score = 3.0 * explained - 1.0 * len(quiet_near) - 0.05 * len([s for s in alarmed if s not in reach])
        if c.get("alarm"):
            score += 5.0
        if not hits and not c.get("alarm"):
            continue
        nearest = min(hits, key=lambda s: reach[s]) if hits else None
        cand = dict(c, score=round(score, 2), sensors=sorted(hits), nearest=nearest,
                    distance=round(reach[nearest]) if nearest else 0)
        if best is None or cand["score"] > best["score"]:
            best = cand
    if best is None:
        return None
    best["hrr_mw"] = estimate_hrr(mirror, best)
    total = max(1, len(alarmed))
    best["confidence"] = round(min(1.0, (len(best["sensors"]) / total) * (1.0 if best.get("alarm") or best["sensors"] else 0.5)), 2)
    return best


def estimate_hrr(mirror, cand):
    cfg = layout.FIRE_TYPES[cand["type"]]
    s = cand.get("nearest")
    if not s:
        return round(cfg["peak_mw"] * 0.25, 1)
    co = float(mirror.prop(s, "co", default=0) or 0)
    vel = abs(float(mirror.prop(s, "velocity", default=0) or 0))
    area = layout.EDGES[layout.SENSORS[s]["edge"]]["area"]
    m_co = max(0.0, co - 1.0) * 1e-6 * vel * area * CO_DENSITY
    hrr = m_co / cfg["co_yield"] * layout.HEAT_OF_COMBUSTION / 1e6
    return round(min(hrr, cfg["peak_mw"] * 1.3), 1)


# -- rebuilding the model from the twins -------------------------------------------------
def _desired_value(mirror, name, feature):
    d = mirror.desired(name, feature)
    return d.get("value") if isinstance(d, dict) else None


def model_from_twins(mirror, est):
    m = MineModel()
    m.t = float(mirror.prop("mine", "sim_time", default=0) or 0)
    for fid, fan in m.fans.items():
        state = mirror.prop(fid, "state", default="")
        fan.speed = float(mirror.prop(fid, "speed", default=0) or 0) / 100.0
        fan.mode = mirror.prop(fid, "rotation", default="normal") or "normal"
        fan.tripped = state == "tripped"
        run = _desired_value(mirror, fid, "run")
        fan.desired_run = bool(run) if run is not None else state in ("running", "starting")
        fan.desired_mode = _desired_value(mirror, fid, "mode") or fan.mode
    for did, door in m.doors.items():
        door.pos = float(mirror.prop(did, "closed", default=0) or 0) / 100.0
        door.desired = _desired_value(mirror, did, "position") or ("closed" if door.pos > 0.5 else "open")
        door.stuck = mirror.prop(did, "position") == "fault"
    for vid, v in m.valves.items():
        v.open = float(mirror.prop(vid, "opening", default=0) or 0) / 100.0
        v.desired = _desired_value(mirror, vid, "position") or ("open" if v.open > 0.5 else "closed")
        v.stuck = mirror.prop(vid, "position") == "fault"
    for sid, sub in m.subs.items():
        sub.desired = _desired_value(mirror, sid, "power") or mirror.prop(sid, "power", default="on")
        sub.energized = mirror.prop(sid, "power", default="on") == "on"
    pressure = float(mirror.prop("fire-main", "pressure", default=12) or 12)
    open_deluges = sum(1 for v in m.valves.values() if v.cfg["kind"] == "deluge" and v.open > 0.5)
    if pressure < layout.FIRE_MAIN["nominal_bar"] - 1.2 * open_deluges - 1.0:
        m.faults.add("low_water")
    m.cage_ok = mirror.prop("hoist-cage", "state") != "out_of_service"
    m.conveyor_run = mirror.prop("conveyor-640", "state") == "running"
    m.crusher_run = mirror.prop("crusher-640", "state") != "stopped"
    evac = mirror.prop("mine", "evacuation", default="none")
    m.evac_order = None if evac in (None, "none") else evac
    m.evac_order_at = m.t if m.evac_order else None
    for cid, crew in m.crews.items():
        loc = mirror.things.get(cid, {}).get("features", {}).get("location", {}).get("properties", {})
        if loc.get("airway") in layout.EDGES:
            crew.edge, crew.s = loc["airway"], float(loc.get("s", crew.s))
        crew.state = mirror.prop(cid, "state", default="working") or "working"
        crew.fed = float(mirror.prop(cid, "fed", default=0) or 0)
        sr = mirror.things.get(cid, {}).get("features", {}).get("self_rescuer", {}).get("properties", {})
        crew.sr_on = sr.get("value") == "on"
        crew.sr_left = float(sr.get("remaining_min", layout.SELF_RESCUER_MIN) or 0)
        if crew.state == "evacuating":
            crew.aware_at = m.t
        if crew.state == "in_refuge":
            crew.target = min(layout.REFUGES.values(), key=lambda r: _node_dist(crew, r["node"]))["node"]
    for eid, a in m.air.items():
        if eid not in layout.AIRWAYS:
            continue
        props = mirror.things.get("aw-" + eid, {}).get("features", {})
        smoke = props.get("smoke", {}).get("properties", {}).get("value", "")
        co_max = float(props.get("co_max", {}).get("properties", {}).get("value", 1) or 1) - 1.0
        t_max = float(props.get("temp_max", {}).get("properties", {}).get("value", a.t_amb) or a.t_amb)
        try:
            cells = [float(x) for x in smoke.split(",")] if smoke else []
        except ValueError:
            cells = []
        if len(cells) != a.n:
            continue
        peak = max(cells) or 0.0
        for i, sm in enumerate(cells):
            frac = sm / peak if peak > 0 else 0.0
            a.soot[i] = sm * 30.0 / (50.0 * layout.SOOT_EXTINCTION)
            a.co[i] = max(0.0, co_max) * frac
            a.dtk[i] = max(0.0, t_max - a.t_amb) * frac
    if est:
        f = Fire(est["type"])
        f.edge, f.s = est["edge"], est["s"]
        c = f.cfg
        ratio = min(1.0, max(0.02, est["hrr_mw"] / c["peak_mw"]))
        f.t = c["t_peak_s"] * math.sqrt(ratio)
        f.hrr_mw = est["hrr_mw"]
        m.fire = f
        if est.get("vehicle"):
            v = m.vehicles[est["vehicle"]]
            v.on_fire = True
            v.fire_alarm = True
            v.suppression = "discharged"
            f.onboard_at = f.t - 60.0
        m.emergency_at = m.t
    m.net.solve()
    return m


def _node_dist(crew, node):
    x, y, z = layout.point_on_edge(crew.edge, crew.s)
    nx, ny, nz = layout.node_xyz(node)
    return math.dist((x, y, z), (nx, ny, nz))


# -- options ------------------------------------------------------------------------------
def apply_option(m, option, position):
    if option == "nothing":
        return
    for name, feature, value, _ in (position or {}).get("actions", []):
        m.apply_desired(name, feature, value)
    m.apply_desired("mine", "evacuation", "all")
    for fan in m.fans.values():
        fan.desired_mode = "reverse" if option == "reverse" else "normal"
    if any(f.tripped for f in m.fans.values()):
        for fan in m.fans.values():
            if not fan.tripped:
                fan.desired_run = True


def simulate(m, option, position):
    apply_option(m, option, position)
    t0 = m.t
    series = []
    smoke_pm = 0.0
    while m.t - t0 < HORIZON_S:
        m.step(SAMPLE_S)
        k = m.kpi()
        for c in m.crews.values():
            if not c.safe and (c.vis < 10.0 or (c.co > layout.CO_ALARM_PPM and not c.sr_on)):
                smoke_pm += c.people * SAMPLE_S / 60.0
        series.append(dict(t=round((m.t - t0) / 60), safe=k["people_safe"], risk=k["people_at_risk"],
                           fed=round(k["max_fed"], 3), injured=k["people_injured"]))
    k = m.kpi()
    exits = []
    for n in layout.CAGE_STATIONS:
        exits.append(dict(node=n, co=round(m.node_c[n][0] + 1.0, 1)))
    harm = k["people_injured"] * 1000 + k["people_at_risk"] * 100 + k["max_fed"] * 300 + smoke_pm
    return dict(option=option, people_safe=k["people_safe"], people_total=k["people_total"],
                people_at_risk=k["people_at_risk"], people_injured=k["people_injured"],
                max_fed=round(k["max_fed"], 3), smoke_person_min=round(smoke_pm),
                fire_mw=round(m.fire.hrr_mw, 1) if m.fire else 0.0,
                exits=exits, airflow=round(m.net.q["fan"], 1), harm=round(harm, 1), series=series)


TITLES = {"nothing": "Без действий", "normal": "Нормальный режим + действия ПЛА", "reverse": "Реверс + действия ПЛА"}


def analyse(mirror, position_id=None, last_est=None, q_ref=None):
    """q_ref: airflow directions from before the alarm. The sensors raised the
    alarm under that ventilation, so the fire is traced along it even after the
    protection system has reversed the air.
    last_est: the previous fire estimate, used while the emergency is still
    declared but the air change has moved the smoke away from every sensor."""
    now = float(mirror.prop("mine", "sim_time", default=0) or 0)
    est = (locate(mirror, q_ref) if q_ref else None) or locate(mirror)
    held = False
    if est:
        est["at"] = now
    elif last_est:
        cfg = layout.FIRE_TYPES[last_est["type"]]
        t_old = cfg["t_peak_s"] * math.sqrt(min(1.0, max(0.02, last_est["hrr_mw"] / cfg["peak_mw"])))
        t_new = t_old + max(0.0, now - last_est.get("at", now))
        hrr = round(min(cfg["peak_mw"], cfg["peak_mw"] * (t_new / cfg["t_peak_s"]) ** 2), 1)
        est = dict(last_est, hrr_mw=max(last_est["hrr_mw"], hrr), at=now, held=True,
                   confidence=round(min(0.5, last_est.get("confidence", 0.5)), 2))
        held = True
    fan_trip = any(mirror.prop(f, "state") == "tripped" for f in layout.FANS)
    if not est and not fan_trip:
        return dict(state="normal", estimate=None, options=[], recommendation="", audit="")
    position = None
    if position_id:
        position = next((p for p in pla.POSITIONS if p["id"] == position_id), None)
    if position is None and est:
        alarmed = [s for s in layout.SENSORS if mirror.prop(s, "state") == "alarm"]
        position = pla.match(alarmed, [est["vehicle"]] if est.get("vehicle") else [])
    options = []
    for opt in ("nothing", "normal", "reverse"):
        m = model_from_twins(mirror, est)
        r = simulate(m, opt, position)
        r["title"] = TITLES[opt]
        options.append(r)
    # on a tie keep the plan's ventilation mode, or the current one: no switch without a gain
    current = mirror.prop("gvu", "mode", default="normal")
    preferred = position.get("ventilation", current) if position else current
    ranked = sorted([o for o in options if o["option"] != "nothing"], key=lambda o: o["harm"])
    if ranked[1]["harm"] - ranked[0]["harm"] <= 1 and ranked[1]["option"] == preferred:
        ranked.reverse()
    best = ranked[0]
    other = ranked[1]
    base = options[0]
    def summary(o):
        return (f"под угрозой {o['people_at_risk']} чел., макс. доза FED {o['max_fed']:.2f}, "
                f"в дыму {o['smoke_person_min']} чел.·мин")

    rec = ("Датчики у очага сейчас не в тревоге (воздух изменил направление), прогноз по последнему "
           "найденному месту пожара. " if held else "")
    rec += (f"{best['title']}: через 30 мин в безопасности {best['people_safe']} из {best['people_total']} чел., "
           f"{summary(best)}")
    if best["harm"] < other["harm"] - 1:
        rec += f". «{other['title']}» хуже: {summary(other)}"
    else:
        rec += f". «{other['title']}» даёт тот же результат"
    rec += f". Без действий: {summary(base)}."
    audit = ""
    if position:
        plan_vent = position.get("ventilation", "normal")
        if plan_vent != best["option"] and abs(best["harm"] - other["harm"]) > 1:
            audit = (f"{position['title']}: план предписывает {'реверс' if plan_vent == 'reverse' else 'нормальный режим'}, "
                     f"прогноз показывает, что «{best['title']}» безопаснее. Рекомендуется пересмотреть позицию ПЛА.")
        else:
            audit = f"{position['title']}: решение плана подтверждается прогнозом."
    return dict(state="emergency", estimate=est, options=options, recommendation=rec, audit=audit,
                position=position["id"] if position else None, held=held, best=best["option"])
