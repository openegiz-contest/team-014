"""Forecasts for the dispatcher, built only from what the twins report.

1. Locate the fire: candidate fire loads (plant, depot, chargers, vehicles
   whose detection fired) are scored against the alarmed gas stations,
   following the airflow directions the airway twins report.
2. Estimate its heat release and age: from the CO mass flow at downstream
   stations, corrected for the time the smoke took to get there, or from
   the time since a vehicle's on-board detection fired.
3. Rebuild a mine model from the twins (actuator positions, fans, people,
   smoke already in the airways) and run it ahead for each option. Two of
   them are baselines: no new actions from now on, and no protection at
   all (the mine from just before the alarm, with the fire but without
   anything the protection has done since).
4. Rank the ventilation options by harm to people, then compare with the
   plan position and propose a more specific one when the fire is located.
"""

import math

from minecore import ditto, layout, pla
from minecore.fire import Fire
from minecore.model import CO_BACKGROUND, CO_DENSITY, MineModel

HORIZON_S = 1800.0
SAMPLE_S = 120.0
ACT_LAG_S = 30.0
KEY_POINTS = {"C480": "клетевой ствол −480", "C560": "клетевой ствол −560", "C640": "клетевой ствол −640",
              "J560": "убежище −560", "J640": "убежище −640"}


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
    """Best candidate fire for the current alarms, or None. Only the place:
    the heat release is estimated separately (estimate())."""
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
        cand = dict(c, score=round(score, 2), sensors=sorted(hits, key=lambda s: reach[s]), nearest=nearest,
                    distance=round(reach[nearest]) if nearest else 0, reach=reach)
        if best is None or cand["score"] > best["score"]:
            best = cand
    if best is None:
        return None
    total = max(1, len(alarmed))
    best["confidence"] = round(min(1.0, (len(best["sensors"]) / total) * (1.0 if best.get("alarm") or best["sensors"] else 0.5)), 2)
    return best


def _curve(ftype, t):
    return Fire(ftype).curve(max(0.0, t))


def _age_for(ftype, hrr):
    """Age at which a free-burning fire of this type reaches `hrr` (growth phase)."""
    c = layout.FIRE_TYPES[ftype]
    return c["t_peak_s"] * math.sqrt(min(1.0, max(0.0, hrr) / c["peak_mw"]))


def _vehicle_hrr(ftype, age):
    """Heat release of a vehicle fire `age` s after ignition with the on-board
    system discharged at detection (knock-down, then re-ignition)."""
    f = Fire(ftype)
    while f.t < age:
        f.step(min(5.0, age - f.t), {"onboard": f.t >= layout.ONBOARD_DETECT_S})
    return f.hrr_mw


def protection(mirror, ftype):
    """Protective states acting on this fire load that the twins show now."""
    c = layout.FIRE_TYPES[ftype]
    on = set()
    if c.get("fuel_valve") and mirror.prop(c["fuel_valve"], "position") == "closed":
        on.add("fuel_cut")
    if (c.get("deluge") and mirror.prop(c["deluge"], "position") == "open"
            and mirror.prop("fire-main", "state") == "ok"):
        on.add("deluge")
    if c.get("powered_factor") and mirror.prop(c["power"], "power") == "off":
        on.add("unpowered")
    if c.get("running_factor") and mirror.prop("conveyor-640", "state") == "stopped":
        on.add("stopped")
    return on


def watch_protection(mirror, now, acted):
    """Keeps acted[f"{fire type}:{state}"] = time the state was first seen."""
    for ftype in layout.FIRE_TYPES:
        on = protection(mirror, ftype)
        for state in ("fuel_cut", "deluge", "unpowered", "stopped"):
            key = f"{ftype}:{state}"
            if state in on:
                acted.setdefault(key, now)
            else:
                acted.pop(key, None)


def _factor(cfg, since, t):
    """Fire factor at time t given since[state] = when each protective state began.
    The fire responds with a 45 s lag; ACT_LAG_S stands for most of it."""
    def on(state):
        return state in since and t >= since[state] + ACT_LAG_S
    f = 1.0
    if cfg.get("running_factor") and not on("stopped"):
        f *= cfg["running_factor"]
    if cfg.get("powered_factor") and not on("unpowered"):
        f *= cfg["powered_factor"]
    if cfg.get("deluge") and on("deluge"):
        f *= cfg["suppress_factor"]
    if "fuel_cut" in since and t > since["fuel_cut"]:
        f *= math.exp(-(t - since["fuel_cut"]) / 240.0)
    return f


def estimate(mirror, cand, now, alarm_seen=None, first_alarm_at=None, last=None, acted=None, q_ref=None):
    """Fills hrr_mw, age_s, method and basis of a located fire.

    CO method: the CO mass flow through a downstream station gives the heat
    release when that air passed the fire, distance/velocity ago. Divided
    by what the protection did to the fire at that moment, it gives the age
    on the t-squared curve; the fire now is the curve at age + delay times
    what the protection does now. The largest value over the stations is
    kept: where the smoke splits, one branch carries only part of it.
    Stations in nearly still air (behind a closed door) are skipped.
    Vehicle method, when the on-board system fired: time since detection.
    last: the previous estimate of the same fire; its age only grows.
    acted: watch_protection() record, so that the moment of each action is known.
    q_ref: airflows from before the alarm (flow_dirs())."""
    ftype = cand["type"]
    cfg = layout.FIRE_TYPES[ftype]
    since = max(0.0, now - first_alarm_at) if first_alarm_at is not None else 0.0
    floor = since
    if last and last.get("type") == ftype and last.get("age_s") is not None:
        floor = max(floor, last["age_s"] + max(0.0, now - last.get("at", now)))
    began = {}
    for state in protection(mirror, ftype):
        began[state] = (acted or {}).get(f"{ftype}:{state}",
                                         first_alarm_at if first_alarm_at is not None else now)
    f_now = _factor(cfg, began, now)
    hrr = age = None
    method, basis = "", None
    vid = cand.get("vehicle")
    if vid and cand.get("alarm") and alarm_seen and vid in alarm_seen:
        age = now - alarm_seen[vid] + layout.ONBOARD_DETECT_S
        hrr, basis = _vehicle_hrr(ftype, age), vid
        method = f"по времени от срабатывания бортовой системы ({round(age)} с) и кривой натурных испытаний"
    else:
        best = None
        for sid, dist in cand.get("reach", {}).items():
            if mirror.prop(sid, "state") == "fault":
                continue
            co = float(mirror.prop(sid, "co", default=0) or 0) - CO_BACKGROUND
            vel = abs(float(mirror.prop(sid, "velocity", default=0) or 0))
            eid = layout.SENSORS[sid]["edge"]
            area = layout.EDGES[eid]["area"]
            # the air arriving now left the fire before the protection slowed it
            vel_t = max(vel, abs((q_ref or {}).get(eid, 0.0)) / area)
            if co < 2.0 or vel < 0.3 or dist / vel_t > 900.0:
                continue
            m_co = co * 1e-6 * vel * area * CO_DENSITY
            hrr_s = m_co / cfg["co_yield"] * layout.HEAT_OF_COMBUSTION / 1e6
            if hrr_s < 0.02:
                continue
            delay = dist / vel_t
            f_then = max(1e-3, _factor(cfg, began, now - delay))
            a = max(_age_for(ftype, hrr_s / f_then) + delay, floor)
            h = _curve(ftype, a) * f_now
            if best is None or h > best[0]:
                best = (h, a, sid, hrr_s, delay)
        if best:
            hrr, age, basis, hrr_s, delay = best
            method = (f"по CO на {basis} ({hrr_s:.1f} МВт {round(delay)} с назад) "
                      "с учётом развития пожара и действий защиты")
    if hrr is None:
        age = max(floor, since + 60.0)
        hrr = _curve(ftype, age) * f_now
        method = ("по кривой развития пожара от предыдущей оценки" if last else
                  "по кривой развития пожара от первого аварийного сигнала")
    cand["hrr_mw"] = round(min(hrr, cfg["peak_mw"] * 1.3), 1)
    cand["age_s"] = round(age)
    if "fuel_cut" in began:
        cand["fuel_cut_age_s"] = round(age - (now - began["fuel_cut"]))
    cand["method"] = method
    cand["basis"] = basis
    if basis in layout.SENSORS:
        cand["sensors"] = [basis] + [s for s in cand.get("sensors", []) if s != basis]
    return cand


# -- rebuilding the model from the twins -------------------------------------------------
def _desired_value(mirror, name, feature):
    d = mirror.desired(name, feature)
    return d.get("value") if isinstance(d, dict) else None


def _place_fire(m, est, age):
    f = Fire(est["type"])
    f.edge, f.s = est["edge"], est["s"]
    f.t = max(0.0, age)
    free = max(1e-6, f.curve(f.t))
    f.hrr_mw = est["hrr_mw"] if est.get("hrr_mw") is not None else free
    f.factor = min(2.5, max(0.02, f.hrr_mw / free))
    if est.get("fuel_cut_age_s") is not None and est["fuel_cut_age_s"] <= f.t:
        f.fuel_cut_at = est["fuel_cut_age_s"]
    m.fire = f
    if est.get("vehicle"):
        v = m.vehicles[est["vehicle"]]
        v.on_fire = True
        v.parked = True
        v.fixed_pos = (est["edge"], est["s"])
        if not est.get("alarm"):
            v.suppression = "failed"
        elif f.t >= layout.ONBOARD_DETECT_S:
            v.fire_alarm = True
            v.suppression = "discharged"
            f.onboard_at = layout.ONBOARD_DETECT_S
    m.emergency_at = m.t


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
        _place_fire(m, est, est.get("age_s", 0.0))
    m.net.solve()
    return m


def counterfactual(pre_things, mirror, est, now):
    """The mine as it would be without the protection: the twins from just
    before the first alarm (doors open, plant running, people at work), the
    fire set back to its estimated age at that moment. Physical faults that
    the twins have shown since (a tripped fan, the cage out of service) stay."""
    pre = ditto.Mirror()
    pre.things = pre_things
    m = model_from_twins(pre, None)
    for fid, fan in m.fans.items():
        if mirror.prop(fid, "state") == "tripped":
            fan.tripped = True
    if mirror.prop("hoist-cage", "state") == "out_of_service":
        m.cage_ok = False
    if est:
        age0 = est.get("age_s", 0.0) - (now - m.t)
        if age0 < 0:
            m.step(-age0)
            age0 = 0.0
        _place_fire(m, dict(est, hrr_mw=None), age0)
    m.net.solve()
    return m


def rolled_back(mirror, est):
    """Fallback baseline when no pre-alarm state was recorded: today's twins
    with every actuator back to normal and no evacuation order."""
    m = model_from_twins(mirror, est)
    for door in m.doors.values():
        door.desired = door.cfg["normal"]
    for v in m.valves.values():
        v.desired = v.cfg["normal"]
    for sub in m.subs.values():
        sub.desired = "on"
    for fan in m.fans.values():
        fan.desired_mode = "normal"
        fan.desired_run = fan.cfg["role"] == "duty"
    m.conveyor_run = m.crusher_run = True
    m.evac_order = m.evac_order_at = None
    for crew in m.crews.values():
        if crew.state == "evacuating":
            crew.state, crew.aware_at = "working", None
    return m


def _node_dist(crew, node):
    x, y, z = layout.point_on_edge(crew.edge, crew.s)
    nx, ny, nz = layout.node_xyz(node)
    return math.dist((x, y, z), (nx, ny, nz))


# -- options ------------------------------------------------------------------------------
def apply_option(m, option, position):
    if option in ("no_paz", "no_new"):
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


def simulate(m, option, position, t_from=None):
    """Runs the model to t_from + HORIZON_S; reports what happens after t_from
    (now). A counterfactual starts earlier and is first brought up to now."""
    apply_option(m, option, position)
    t0 = m.t if t_from is None else t_from
    while m.t < t0 - 1e-6:
        m.step(min(SAMPLE_S, t0 - m.t))
    series = []
    smoke_pm = 0.0
    while m.t - t0 < HORIZON_S - 1e-6:
        m.step(SAMPLE_S)
        k = m.kpi()
        for c in m.crews.values():
            if not c.safe and (c.vis < 10.0 or (c.co > layout.CO_ALARM_PPM and not c.sr_on)):
                smoke_pm += c.people * SAMPLE_S / 60.0
        series.append(dict(t=round((m.t - t0) / 60), safe=k["people_safe"], risk=k["people_at_risk"],
                           fed=round(k["max_fed"], 3), injured=k["people_injured"], smoke_pm=round(smoke_pm),
                           fire_mw=round(m.fire.hrr_mw, 1) if m.fire else 0.0,
                           co={n: round(m.node_c[n][0] + 1.0, 1) for n in KEY_POINTS}))
    k = m.kpi()
    exits = [dict(node=n, co=round(m.node_c[n][0] + 1.0, 1)) for n in layout.CAGE_STATIONS]
    harm = k["people_injured"] * 1000 + k["people_at_risk"] * 100 + k["max_fed"] * 300 + smoke_pm
    return dict(option=option, people_safe=k["people_safe"], people_total=k["people_total"],
                people_at_risk=k["people_at_risk"], people_at_risk_max=max((s["risk"] for s in series), default=0),
                people_injured=k["people_injured"], max_fed=round(k["max_fed"], 3), smoke_person_min=round(smoke_pm),
                fire_mw=round(m.fire.hrr_mw, 1) if m.fire else 0.0,
                exits=exits, airflow=round(m.net.q["fan"], 1), harm=round(harm, 1), series=series)


TITLES = {"no_paz": "Без ПАЗ (если бы защита не сработала)", "no_new": "Без новых действий",
          "normal": "Нормальный режим + действия ПЛА", "reverse": "Реверс + действия ПЛА"}


def _position(pid):
    return next((p for p in pla.POSITIONS if p["id"] == pid), None)


def analyse(mirror, paz_position=None, last_est=None, q_ref=None, pre=None, alarm_seen=None, first_alarm_at=None,
            acted=None):
    """paz_position: the position the protection has entered (id or None).
    q_ref: airflow directions from before the alarm. The sensors raised the
    alarm under that ventilation, so the fire is traced along it even after the
    protection system has reversed the air.
    last_est: the previous fire estimate, used while the emergency is still
    declared but the air change has moved the smoke away from every sensor.
    pre: the twins just before the first alarm, for the no-protection baseline.
    acted: when each protective state was first seen (watch_protection())."""
    now = float(mirror.prop("mine", "sim_time", default=0) or 0)
    est = (locate(mirror, q_ref) if q_ref else None) or locate(mirror)
    held = False
    if est:
        estimate(mirror, est, now, alarm_seen, first_alarm_at, last_est, acted, q_ref)
        est.pop("reach", None)
        est["at"] = now
    elif last_est:
        age = last_est.get("age_s", 0.0) + max(0.0, now - last_est.get("at", now))
        free_old = max(1e-6, _curve(last_est["type"], last_est.get("age_s", 0.0)))
        factor = last_est["hrr_mw"] / free_old
        est = dict(last_est, age_s=round(age), hrr_mw=round(_curve(last_est["type"], age) * factor, 1), at=now, held=True,
                   method="по кривой развития пожара: датчики у очага не в тревоге после смены направления воздуха",
                   confidence=round(min(0.5, last_est.get("confidence", 0.5)), 2))
        held = True
    fan_trip = any(mirror.prop(f, "state") == "tripped" for f in layout.FANS)
    if not est and not fan_trip:
        return dict(state="normal", estimate=None, options=[], recommendation="", audit="", proposal=None)
    paz_pos = _position(paz_position) if paz_position else None
    located = pla.for_fire(est["type"]) if est else None
    position = located or paz_pos
    if position is None and est:
        alarmed = [s for s in layout.SENSORS if mirror.prop(s, "state") == "alarm"]
        position = pla.match(alarmed, [est["vehicle"]] if est.get("vehicle") else [])
    options = []
    if pre:
        m = counterfactual(pre, mirror, est, now)
    else:
        m = rolled_back(mirror, est)
    options.append(dict(simulate(m, "no_paz", None, t_from=now), title=TITLES["no_paz"],
                        basis="состояние до тревоги" if pre else "текущее состояние, исполнительные органы в норме"))
    for opt in ("no_new", "normal", "reverse"):
        m = model_from_twins(mirror, est)
        options.append(dict(simulate(m, opt, position), title=TITLES[opt]))
    # on a tie keep the plan's ventilation mode, or the current one: no switch without a gain
    current = mirror.prop("gvu", "mode", default="normal")
    preferred = position.get("ventilation", current) if position else current
    ranked = sorted([o for o in options if o["option"] in ("normal", "reverse")], key=lambda o: o["harm"])
    if ranked[1]["harm"] - ranked[0]["harm"] <= 1 and ranked[1]["option"] == preferred:
        ranked.reverse()
    best, other = ranked
    by = {o["option"]: o for o in options}

    def summary(o):
        return (f"под угрозой {o['people_at_risk']} чел. (макс. {o['people_at_risk_max']}), макс. доза FED {o['max_fed']:.2f}, "
                f"в дыму {o['smoke_person_min']} чел.·мин")

    rec = ("Датчики у очага сейчас не в тревоге (воздух изменил направление), прогноз по последнему "
           "найденному месту пожара. " if held else "")
    rec += (f"{best['title']}: через 30 мин в безопасности {best['people_safe']} из {best['people_total']} чел., "
            f"{summary(best)}")
    if best["harm"] < other["harm"] - 1:
        rec += f". «{other['title']}» хуже: {summary(other)}"
    else:
        rec += f". «{other['title']}» даёт тот же результат"
    rec += f". Без новых действий: {summary(by['no_new'])}. Без ПАЗ: {summary(by['no_paz'])}."
    audit_parts = []
    proposal = None
    if located and (paz_pos is None or paz_pos["id"] != located["id"]):
        proposal = dict(value=located["id"], title=located["title"], fire=est["label"],
                        confidence=est.get("confidence"), paz_position=paz_pos["id"] if paz_pos else None)
        if paz_pos is None or paz_pos["id"] == pla.GENERIC["id"]:
            audit_parts.append(f"ПАЗ ввела {paz_pos['title'] if paz_pos else 'только общий сигнал'}: место пожара не определено. "
                               f"По датчикам и направлениям воздуха очаг — {est['label']}; предлагается {located['title']}.")
        else:
            audit_parts.append(f"ПАЗ ввела {paz_pos['title']}, а очаг по датчикам — {est['label']}: "
                               f"предлагается {located['title']}, переход после подтверждения диспетчера.")
    if position:
        plan_vent = position.get("ventilation", "normal")
        if plan_vent != best["option"] and abs(best["harm"] - other["harm"]) > 1:
            audit_parts.append(f"{position['title']}: план предписывает {'реверс' if plan_vent == 'reverse' else 'нормальный режим'}, "
                               f"прогноз показывает, что «{best['title']}» безопаснее. Рекомендуется пересмотреть позицию ПЛА.")
        else:
            audit_parts.append(f"{position['title']}: решение плана о проветривании подтверждается прогнозом.")
    return dict(state="emergency", estimate=est, options=options, recommendation=rec, audit=" ".join(audit_parts),
                position=position["id"] if position else None, held=held, best=best["option"], proposal=proposal)
