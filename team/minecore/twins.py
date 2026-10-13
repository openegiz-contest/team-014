"""Twin definitions (Ditto things) and the mapping model state -> features.

Hierarchy (attribute `_parents`):

    mine
    ├── h-480 / h-560 / h-640   horizons: airways, doors, valves, substations,
    │                            gas stations, plant, refuges
    ├── shaft-cage / shaft-skip / shaft-vent   shaft airways
    ├── gvu                     main fan station: fan-1, fan-2
    ├── fire-main               fire and dust suppression main
    ├── hoist-skip / hoist-cage
    ├── fleet                   LHDs, trucks, drill rigs (they move between horizons)
    ├── personnel               crews
    └── control / paz / advisor

Relations are attributes holding thing ids: `airway`, `feeds`, `fed_by`,
`protects`, `zone`, `upstream`/`downstream` nodes.
"""

import json

from . import layout, thing_id
from .model import CLEAR_VIS_M
from .scenarios import FAULTS, SCENARIOS

CLOCK_OFFSET_S = 6 * 3600   # the model starts at 06:00 and warms up to 08:00

POLICY = "default:basic_policy"


def _attrs(name, kind, parent=None, **extra):
    a = {"name": name, "_isType": False, "kind": kind}
    if parent:
        a["_parents"] = thing_id(parent)
    a.update(extra)
    return a


def _place(eid, s):
    x, y, z = layout.point_on_edge(eid, s)
    return {"airway": thing_id("aw-" + eid), "s": s, "x": round(x, 1), "y": round(y, 1), "z": round(z, 1)}


def airway_parent(eid):
    e = layout.EDGES[eid]
    if e.get("shaft"):
        return e["shaft"]
    if e.get("horizon"):
        return e["horizon"]
    return "mine"


def node_parent(nid):
    return layout.NODES[nid][4] or "mine"


def edge_parent(eid):
    """Horizon of an airway; ramps and raises belong to their lower horizon."""
    e = layout.EDGES[eid]
    return e.get("horizon") or node_parent(e["frm"])


def definitions():
    """Ordered dict name -> (attributes, initial features). Parents first."""
    d = {}

    def add(name, attrs, features=None):
        d[name] = (attrs, features or {})

    add("mine", _attrs("Шахта «Болашак» (Донской ГОК, АО «ТНК «Казхром»)", "mine",
                       location="Хромтау, Актюбинская область", lat=50.2726, lon=58.4466,
                       surface_elevation_m=layout.SURFACE_Z, design_capacity_mtpa=7.5, deposits="Миллионное, Алмаз-Жемчужина",
                       mining_depth_m="800-1200",
                       ore="хромитовая руда", source="ERG / Kazchrome public data, see SUBMISSION.md"))
    for hid, h in layout.HORIZONS.items():
        add(hid, _attrs(h["name"], "horizon", "mine", elevation_m=h["z"], depth_m=h["depth_m"]))
    shafts = {
        "shaft-cage": ("Клетевой ствол (воздухоподающий, спуск-подъём людей)", "intake", 7.6),
        "shaft-skip": ("Скиповой ствол (выдача руды, воздухоподающий)", "intake", 7.0),
        "shaft-vent": ("Северный вентиляционный ствол (исходящая струя)", "return", 8.0),
    }
    for sid, (name, role, dia) in shafts.items():
        add(sid, _attrs(name, "shaft", "mine", role=role, diameter_m=dia, depth_m=1060))
    add("gvu", _attrs("Главная вентиляторная установка (ГВУ), северный ствол", "fan-station", "mine",
                      shaft=thing_id("shaft-vent"), method="всасывающий", reverse_time_limit_s=600))
    for fid, f in layout.FANS.items():
        add(fid, _attrs(f["name"], "fan", "gvu", role=f["role"], p0_pa=layout.FAN_P0, k=layout.FAN_K,
                        start_s=layout.FAN_START_S, reverse_s=layout.FAN_REVERSE_S),
            {"run": {"properties": {"value": f["role"] == "duty"}},
             "mode": {"properties": {"value": "normal"}}})
    add("fire-main", _attrs(layout.FIRE_MAIN["name"], "fire-main", "mine",
                            nominal_bar=layout.FIRE_MAIN["nominal_bar"], min_deluge_bar=6.0))
    add("fleet", _attrs("Самоходная техника на аккумуляторах (Epiroc)", "fleet", "mine"))
    add("personnel", _attrs("Персонал в шахте (система позиционирования)", "personnel", "mine"))
    for eid in layout.AIRWAYS:
        e = layout.EDGES[eid]
        add("aw-" + eid, _attrs(e["name"], "airway", airway_parent(eid), airway_kind=e["kind"],
                                frm=e["frm"], to=e["to"], length_m=round(layout.edge_length(eid), 1),
                                area_m2=e["area"], alpha=e["alpha"], regulator=e.get("regulator", 0.0),
                                frm_xyz=layout.node_xyz(e["frm"]), to_xyz=layout.node_xyz(e["to"])))
    for did, c in layout.DOORS.items():
        add(did, _attrs(c["name"], "fire-door", edge_parent(c["edge"]), travel_s=c["travel_s"],
                        normal=c["normal"], **_place(c["edge"], c["s"])),
            {"position": {"properties": {"value": c["normal"]}}})
    for vid, c in layout.VALVES.items():
        add(vid, _attrs(c["name"], "valve", edge_parent(c["edge"]), valve_kind=c["kind"], normal=c["normal"],
                        travel_s=c["travel_s"], protects=c["protects"], **_place(c["edge"], c["s"])),
            {"position": {"properties": {"value": c["normal"]}}})
    for sid, c in layout.SUBSTATIONS.items():
        add(sid, _attrs(c["name"], "substation", node_parent(c["node"]), node=c["node"],
                        feeds=[thing_id(x) for x in c["feeds"]]),
            {"power": {"properties": {"value": "on"}}})
    for vid, c in {**layout.LHDS, **layout.TRUCKS}.items():
        add(vid, _attrs(c["name"], "lhd" if vid.startswith("lhd") else "truck", "fleet", model=c["model"],
                        payload_t=c["payload_t"], battery_kwh=c["battery_kwh"], route=c["route"]),
            {"command": {"properties": {"value": "auto"}}})
    for vid, c in layout.DRILLS.items():
        add(vid, _attrs(c["name"], "drill" if vid.startswith("drill") else "bolter", "fleet", model=c["model"],
                        **_place(c["edge"], c["s"])))
    for pid, c in layout.FIXED_PLANT.items():
        if c["kind"] == "hoist":
            parent = "mine"
            extra = {"shaft": thing_id("shaft-skip" if pid == "hoist-skip" else "shaft-cage")}
        else:
            parent = edge_parent(c["edge"])
            extra = _place(c["edge"], c["s"])
        fed_by = [s for s, sc in layout.SUBSTATIONS.items() if pid in sc["feeds"]]
        if fed_by:
            extra["fed_by"] = thing_id(fed_by[0])
        specs = {k: v for k, v in c.items() if k not in ("name", "kind", "edge", "s", "node")}
        feats = {"command": {"properties": {"value": "run"}}} if pid in ("hoist-skip", "crusher-640", "conveyor-640") else {}
        add(pid, _attrs(c["name"], c["kind"], parent, **specs, **extra), feats)
    for sid, c in layout.SENSORS.items():
        add(sid, _attrs(c["name"], "gas-station", edge_parent(c["edge"]), channels=["CO", "smoke", "T", "v"],
                        co_pdk_ppm=layout.CO_PDK_PPM, co_alarm_ppm=layout.CO_ALARM_PPM, **_place(c["edge"], c["s"])))
    for rid, c in layout.REFUGES.items():
        x, y, z = layout.node_xyz(c["node"])
        add(rid, _attrs(c["name"], "refuge", node_parent(c["node"]), node=c["node"], capacity=c["capacity"],
                        air_hours=c["air_hours"], x=x, y=y, z=z))
    for cid, c in layout.CREWS.items():
        add(cid, _attrs(c["name"], "crew", "personnel", headcount=c["people"],
                        self_rescuer_min=layout.SELF_RESCUER_MIN, workplace=_place(c["edge"], c["s"])))
    add("control", _attrs("Пульт сценариев и режимов (тренажёр диспетчера)", "control", "mine",
                          scenarios={k: {"title": v["title"], "text": v["text"], "faults": v.get("faults", [])}
                                     for k, v in SCENARIOS.items()},
                          faults=FAULTS),
        {"scenario": {"properties": {"value": "normal", "faults": [], "seq": 0}},
         "speed": {"properties": {"value": 10, "unit": "x"}},
         "paz_mode": {"properties": {"value": "auto"}},
         "study": {"properties": {"value": "none"}}})
    add("paz", _attrs("Противоаварийная автоматическая защита (ПАЗ) по ПЛА", "paz", "mine"),
        {"mode": {"properties": {"value": "auto"}}, "state": {"properties": {"value": "standby"}}})
    add("advisor", _attrs("Советчик диспетчера: прогноз режимов проветривания", "advisor", "mine"),
        {"state": {"properties": {"value": "normal"}}, "best_option": {"properties": {"value": "none"}},
         "fire_location": {"properties": {"value": "none"}}, "proposal": {"properties": {"value": "none"}},
         "study": {"properties": {"value": "idle"}}})
    return d


def thing_bodies():
    out = {}
    for name, (attrs, features) in definitions().items():
        out[thing_id(name)] = {"policyId": POLICY, "attributes": attrs, "features": features}
    return out


# --------------------------------------------------------------------------
def _v(value, unit=None, **extra):
    p = {"value": value}
    if unit:
        p["unit"] = unit
    p.update(extra)
    return p


def _r(x, nd=2):
    return None if x is None else round(float(x), nd)


def _xyz(eid, s):
    x, y, z = layout.point_on_edge(eid, s)
    return dict(airway=eid, s=round(s, 3), x=round(x, 1), y=round(y, 1), z=round(z, 1))


def emergency_state(m, alarms):
    if m.evac_order:
        return "evacuation"
    if any(f.tripped for f in m.fans.values()) and m.net.fan_speed < 0.5:
        return "fan_trip"
    if alarms:
        return "alarm"
    return "normal"


def snapshot(m):
    """name -> {feature: properties} for every twin the simulator drives."""
    out = {}
    net = m.net
    kpi = m.kpi()
    sensors = {sid: m.sensor(sid) for sid in layout.SENSORS}
    alarms = [s for s, r in sensors.items() if r["state"] == "alarm"]
    fan_q = net.q["fan"]
    fan_dp = net.fan_pressure(fan_q)[0] if net.fan_mode != "stopped" else 0.0
    clock = m.t + CLOCK_OFFSET_S
    hh = int(clock // 3600) % 24
    mm = int(clock % 3600 // 60)
    out["mine"] = {
        "people_total": _v(kpi["people_total"], "чел"),
        "people_underground": _v(kpi["people_underground"], "чел"),
        "people_safe": _v(kpi["people_safe"], "чел"),
        "people_evacuating": _v(kpi["people_evacuating"], "чел"),
        "people_at_risk": _v(kpi["people_at_risk"], "чел"),
        "people_injured": _v(kpi["people_injured"], "чел"),
        "max_fed": _v(_r(kpi["max_fed"], 3), "FED"),
        "production": _v(_r(m.production_tph(), 0), "т/ч"),
        "ore_hoisted": _v(_r(m.ore_hoisted, 0), "т"),
        "lost_production": _v(_r(m.lost_t, 0), "т"),
        "airflow": _v(_r(abs(fan_q), 1), "м³/с"),
        "fan_pressure": _v(_r(abs(fan_dp), 0), "Па"),
        "emergency": _v(emergency_state(m, alarms)),
        "evacuation": _v(m.evac_order or "none"),
        "alarms": _v(len(alarms), "шт"),
        "sim_time": _v(_r(m.t, 0), "с", clock=f"{hh:02d}:{mm:02d}"),
    }
    for hid in layout.HORIZONS:
        eids = [e for e in layout.AIRWAYS if layout.EDGES[e].get("horizon") == hid]
        out[hid] = {
            "co_max": _v(_r(max(m.air[e].max_co() for e in eids) + 1.0, 1), "ppm"),
            "visibility_min": _v(_r(min(m.air[e].min_visibility() for e in eids), 1), "м"),
            "people": _v(sum(c.people for c in m.crews.values()
                             if c.state != "surface" and edge_parent(c.edge) == hid), "чел"),
            "alarms": _v(sum(1 for s in alarms if edge_parent(layout.SENSORS[s]["edge"]) == hid), "шт"),
        }
    for sid in ("shaft-cage", "shaft-skip", "shaft-vent"):
        eids = [e for e in layout.AIRWAYS if layout.EDGES[e].get("shaft") == sid]
        q = net.q[eids[0]]
        out[sid] = {"airflow": _v(_r(q, 1), "м³/с"),
                    "velocity": _v(_r(q / layout.EDGES[eids[0]]["area"], 2), "м/с"),
                    "co_max": _v(_r(max(m.air[e].max_co() for e in eids) + 1.0, 1), "ppm")}
    active = max(m.fans.values(), key=lambda f: f.speed)
    out["gvu"] = {
        "mode": _v(net.fan_mode),
        "airflow": _v(_r(abs(fan_q), 1), "м³/с"),
        "pressure": _v(_r(abs(fan_dp), 0), "Па"),
        "power_kw": _v(_r(abs(fan_q * fan_dp) / layout.FAN_ETA / 1000.0, 0), "кВт"),
        "active_fan": _v(active.id if active.speed > 0.01 else "none"),
    }
    for fid, f in m.fans.items():
        out[fid] = {"state": _v(f.state), "speed": _v(_r(f.speed * 100, 0), "%"),
                    "rotation": _v(f.mode), "hours": _v(_r(f.hours, 2), "ч")}
    out["fire-main"] = {"pressure": _v(_r(m.fire_main_bar, 1), "бар"),
                        "state": _v("ok" if m.fire_main_bar >= 6.0 else "low")}
    for eid in layout.AIRWAYS:
        a = m.air[eid]
        q = net.q[eid]
        out["aw-" + eid] = {
            "airflow": _v(_r(q, 1), "м³/с"),
            "velocity": _v(_r(q / a.area, 2), "м/с"),
            "co_max": _v(_r(a.max_co() + 1.0, 1), "ppm"),
            "visibility_min": _v(_r(a.min_visibility(), 1), "м"),
            "temp_max": _v(_r(a.t_amb + max(a.dtk), 1), "°C"),
            # smoke density per cell (0 clear .. 1 dense), compact for the 3D view
            "smoke": _v(",".join(str(round(min(1.0, layout.SOOT_EXTINCTION * x * CLEAR_VIS_M / 30.0), 2))
                                 for x in a.soot)),
        }
    for did, door in m.doors.items():
        out[did] = {"position": _v(door.state), "closed": _v(_r(door.pos * 100, 0), "%")}
    for vid, v in m.valves.items():
        out[vid] = {"position": _v(v.state), "opening": _v(_r(v.open * 100, 0), "%")}
    loads = {"hoist-skip": 1200.0, "charger-560": 600.0, "crusher-640": 400.0, "conveyor-640": 250.0}
    for sid, s in m.subs.items():
        kw = sum(loads.get(x, 0) for x in s.cfg["feeds"]) if s.energized else 0.0
        out[sid] = {"power": _v("on" if s.energized else "off"), "load": _v(_r(kw * 0.7, 0), "кВт")}
    for vid, v in m.vehicles.items():
        eid, s = v.position()
        out[vid] = {"state": _v(v.state), "speed": _v(_r(v.speed, 1), "км/ч"),
                    "payload": _v(_r(v.payload, 1), "т"), "battery": _v(_r(v.soc, 1), "%"),
                    "trips": _v(v.trips, "рейсов"), "location": _v(eid, **_xyz(eid, s)),
                    "fire_alarm": _v(v.fire_alarm), "suppression": _v(v.suppression)}
    evac = m.evac_order is not None
    out["drill-01"] = {"state": _v("parked" if evac else "drilling"), "drilled": _v(_r(m.drill_m, 1), "м")}
    out["bolter-01"] = {"state": _v("parked" if evac else "bolting"), "bolts": _v(m.bolts, "шт")}
    p640 = m.subs["sub-640"].energized
    out["hoist-skip"] = {"state": _v("running" if m.skip_run and m.subs["sub-480"].energized else "stopped"),
                         "hoisted": _v(_r(m.ore_hoisted, 0), "т"), "pocket": _v(_r(m.bins["pocket"], 0), "т")}
    waiting = sum(c.people for c in m.crews.values() if c.state == "waiting_cage")
    lifted = sum(c.people for c in m.crews.values() if c.state == "surface")
    out["hoist-cage"] = {"state": _v(("lifting" if waiting else "ready") if m.cage_ok else "out_of_service"),
                         "queue": _v(waiting, "чел"), "lifted": _v(lifted, "чел")}
    out["crusher-640"] = {"state": _v("running" if p640 and m.crusher_run and m.crusher_tph > 5 else
                                      ("idle" if p640 and m.crusher_run else "stopped")),
                          "throughput": _v(_r(m.crusher_tph, 0), "т/ч"), "bin": _v(_r(m.bins["J640"], 0), "т")}
    out["conveyor-640"] = {"state": _v("running" if p640 and m.conveyor_run else "stopped"),
                           "throughput": _v(_r(m.conveyor_tph, 0), "т/ч")}
    charger_on = m.subs["sub-560"].energized
    out["charger-560"] = {"state": _v("charging" if charger_on else "de-energized"),
                          "power_kw": _v(420 if charger_on else 0, "кВт")}
    depot_fire = m.fire is not None and m.fire.type == "depot" and not m.fire.extinct
    out["depot-640"] = {"state": _v("fire" if depot_fire else "normal"),
                        "fuel_line": _v("open" if m.valves["esd-fuel-640"].open > 0.05 else "isolated")}
    for sid, r in sensors.items():
        out[sid] = {"state": _v(r["state"]), "co": _v(_r(r["co"], 1), "ppm"),
                    "visibility": _v(_r(r["vis"], 1), "м"), "temperature": _v(_r(r["temp"], 1), "°C"),
                    "velocity": _v(_r(r["vel"], 2), "м/с")}
    for rid, rc in layout.REFUGES.items():
        inside = sum(c.people for c in m.crews.values() if c.state == "in_refuge" and c.target == rc["node"])
        out[rid] = {"occupants": _v(inside, "чел"), "state": _v("occupied" if inside else "ready")}
    for cid, c in m.crews.items():
        out[cid] = {"state": _v(c.state), "people": _v(c.people, "чел"),
                    "location": _v(c.edge, **_xyz(c.edge, c.s)),
                    "co": _v(_r(c.co, 1), "ppm"), "fed": _v(_r(c.fed, 3), "FED"),
                    "self_rescuer": _v("on" if c.sr_on else "off", remaining_min=_r(c.sr_left, 1)),
                    "speed": _v(_r(c.speed, 2), "м/с"),
                    "evac_time": _v(_r(c.evac_time, 0), "с")}
    fire = m.fire
    out["control"] = {
        "scenario": _v(m.scenario.get("name", "normal"), faults=sorted(m.faults), seq=m.scenario.get("seq", 0),
                       started=_r(m.scenario.get("started_at"), 0)),
        "fire_truth": _v(json.dumps({"type": fire.type, "airway": fire.edge, "s": fire.s,
                                     "hrr_mw": round(fire.hrr_mw, 2), "extinct": fire.extinct,
                                     "t": round(fire.t)} if fire else None, ensure_ascii=False)),
        "hrr": _v(_r(fire.hrr_mw if fire else 0.0, 2), "МВт"),
        "events": _v(json.dumps([[round(t), e] for t, e in m.events[-25:]], ensure_ascii=False)),
    }
    return out
