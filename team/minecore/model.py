"""State and physics of the modelled mine, advanced in fixed time steps.

The same class runs in the simulator (the "real" mine behind the twins) and
inside the advisor, which copies a state rebuilt from the twins and runs it
ahead faster than real time to compare ventilation options.
"""

import heapq
import math
import random
import zlib

from . import layout
from .fire import Fire
from .network import Network, buoyancy_pressure

CO_DENSITY = 1.165     # kg/m3
RHO_AIR = 1.2
CP_AIR = 1005.0
HEAT_DECAY_M = 450.0   # e-folding length of hot-gas cooling by the rock
DT_PHYS = 2.0          # s, physics step
CO_CAP = 30000.0       # ppm
SOOT_CAP = 0.02        # kg/m3
DT_CAP = 900.0         # K
WALKABLE = {"drift", "chamber", "ramp"}
CLEAR_VIS_M = 50.0
CO_BACKGROUND = 1.0    # ppm; battery fleet, no diesel exhaust in production


def ambient_temp(z):
    """Air temperature by depth: 8 C at the collar (Khromtau, October) plus
    auto-compression of the descending air, about 1 K per 100 m."""
    depth = layout.SURFACE_Z - z
    return 8.0 + max(0.0, depth) * 0.0098


def km_h(v):
    return v / 3.6


# --------------------------------------------------------------------------
class Airway:
    def __init__(self, eid):
        e = layout.EDGES[eid]
        self.id = eid
        self.kind = e["kind"]
        self.frm = e["frm"]
        self.to = e["to"]
        self.length = layout.edge_length(eid)
        self.area = e["area"]
        self.n = max(1, min(30, int(round(self.length / 40.0))))
        self.dx = self.length / self.n
        self.vol = self.dx * self.area
        self.co = [0.0] * self.n
        self.soot = [0.0] * self.n
        self.dtk = [0.0] * self.n
        z1 = layout.NODES[self.frm][3]
        z2 = layout.NODES[self.to][3]
        extra = 1.5 if self.kind in ("drift", "chamber") else 0.0
        self.t_amb = (ambient_temp(z1) + ambient_temp(z2)) / 2 + extra

    def cell(self, s):
        return min(self.n - 1, max(0, int(s * self.n)))

    def max_co(self):
        return max(self.co)

    def mean_dt(self):
        return sum(self.dtk) / self.n

    def visibility_at(self, i):
        k = layout.SOOT_EXTINCTION * self.soot[i] + 3.0 / CLEAR_VIS_M
        return min(CLEAR_VIS_M, 3.0 / k)

    def min_visibility(self):
        return min(self.visibility_at(i) for i in range(self.n))


# --------------------------------------------------------------------------
class Door:
    def __init__(self, did):
        self.id = did
        self.cfg = layout.DOORS[did]
        self.pos = 0.0 if self.cfg["normal"] == "open" else 1.0
        self.desired = self.cfg["normal"]
        self.stuck = False

    def step(self, dt):
        target = 1.0 if self.desired == "closed" else 0.0
        if self.stuck and target > self.pos:
            return
        rate = dt / self.cfg["travel_s"]
        self.pos = min(target, self.pos + rate) if target > self.pos else max(target, self.pos - rate)

    @property
    def state(self):
        if self.stuck and self.desired == "closed" and self.pos < 0.98:
            return "fault"
        if self.pos >= 0.98:
            return "closed"
        if self.pos <= 0.02:
            return "open"
        return "closing" if self.desired == "closed" else "opening"

    def resistance(self):
        return self.cfg["r_closed"] * self.pos ** 3


class Valve:
    def __init__(self, vid):
        self.id = vid
        self.cfg = layout.VALVES[vid]
        self.open = 1.0 if self.cfg["normal"] == "open" else 0.0
        self.desired = self.cfg["normal"]
        self.stuck = False

    def step(self, dt):
        if self.stuck:
            return
        target = 1.0 if self.desired == "open" else 0.0
        rate = dt / self.cfg["travel_s"]
        self.open = min(target, self.open + rate) if target > self.open else max(target, self.open - rate)

    @property
    def state(self):
        target_open = self.desired == "open"
        if self.stuck and (self.open > 0.5) != target_open:
            return "fault"
        if self.open >= 0.98:
            return "open"
        if self.open <= 0.02:
            return "closed"
        return "opening" if target_open else "closing"


class Fan:
    def __init__(self, fid):
        self.id = fid
        self.cfg = layout.FANS[fid]
        duty = self.cfg["role"] == "duty"
        self.speed = 1.0 if duty else 0.0
        self.mode = "normal"
        self.desired_run = duty
        self.desired_mode = "normal"
        self.tripped = False
        self.hours = 0.0

    def step(self, dt):
        if self.tripped:
            self.speed = max(0.0, self.speed - dt / 45.0)
            return
        want_speed = 1.0 if self.desired_run else 0.0
        if self.desired_mode != self.mode:
            # changeover: run down, switch rotation/dampers, run up
            self.speed = max(0.0, self.speed - dt / (layout.FAN_REVERSE_S / 2))
            if self.speed <= 0.0:
                self.mode = self.desired_mode
            return
        if want_speed > self.speed:
            ramp = layout.FAN_START_S if self.mode == "normal" else layout.FAN_REVERSE_S / 2
            self.speed = min(want_speed, self.speed + dt / ramp)
        else:
            self.speed = max(want_speed, self.speed - dt / 45.0)
        if self.speed > 0:
            self.hours += dt / 3600.0

    @property
    def state(self):
        if self.tripped:
            return "tripped"
        if self.desired_mode != self.mode:
            return "reversing"
        if self.desired_run and self.speed < 0.99:
            return "starting"
        if self.speed >= 0.99:
            return "running"
        if not self.desired_run and self.speed > 0.01:
            return "stopping"
        return "standby" if self.cfg["role"] == "standby" else "stopped"


class Substation:
    def __init__(self, sid):
        self.id = sid
        self.cfg = layout.SUBSTATIONS[sid]
        self.energized = True
        self.desired = "on"

    def step(self, dt):
        self.energized = self.desired == "on"


# --------------------------------------------------------------------------
class Graph:
    """Undirected graph of walkable / drivable airways for path finding."""

    def __init__(self, kinds):
        self.adj = {}
        for eid, e in layout.EDGES.items():
            if e["kind"] not in kinds:
                continue
            length = layout.edge_length(eid)
            self.adj.setdefault(e["frm"], []).append((e["to"], eid, length))
            self.adj.setdefault(e["to"], []).append((e["frm"], eid, length))

    def shortest(self, starts, targets, weight=None):
        """starts: {node: initial cost}; returns (cost, node path, edge path)."""
        dist = {}
        prev = {}
        heap = [(c, n) for n, c in starts.items()]
        heapq.heapify(heap)
        best = {n: c for n, c in starts.items()}
        while heap:
            c, n = heapq.heappop(heap)
            if n in dist:
                continue
            dist[n] = c
            if n in targets:
                path_n, path_e = [n], []
                while n in prev:
                    pn, eid = prev[n]
                    path_e.append(eid)
                    path_n.append(pn)
                    n = pn
                return c, list(reversed(path_n)), list(reversed(path_e))
            for m, eid, length in self.adj.get(n, []):
                w = length * (weight(eid) if weight else 1.0)
                nc = c + w
                if m not in dist and nc < best.get(m, float("inf")):
                    best[m] = nc
                    prev[m] = (n, eid)
                    heapq.heappush(heap, (nc, m))
        return None


DRIVE = Graph(WALKABLE)
WALK = Graph(WALKABLE)


def edge_dir(eid, from_node):
    return 1 if layout.EDGES[eid]["frm"] == from_node else -1


# --------------------------------------------------------------------------
class Vehicle:
    """Battery LHD or truck cycling along a node route."""

    def __init__(self, vid, kind):
        self.id = vid
        self.kind = kind
        self.cfg = (layout.LHDS if kind == "lhd" else layout.TRUCKS)[vid]
        self.route = self.cfg["route"]
        self.payload = 0.0
        self.soc = 70.0 + 25.0 * self.cfg["start_s"]
        self.trips = 0
        self.speed = 0.0
        self.state = "loading" if kind == "lhd" else "waiting"
        self.timer = 0.0
        self.parked = False
        self.on_fire = False
        self.fire_alarm = False
        self.suppression = "ready"
        self.fixed_pos = None
        self.legs = self._build_legs()
        self.leg = 0
        self.detour = []        # to the battery swap bay and back, ahead of legs[leg]
        self.dist = 0.0
        # spread the fleet around the cycle
        total = sum(leg["length"] for leg in self.legs)
        d = self.cfg["start_s"] * total
        for i, leg in enumerate(self.legs):
            if d <= leg["length"]:
                self.leg, self.dist = i, d
                break
            d -= leg["length"]
        self.state = self._moving_state()

    @staticmethod
    def _make_leg(a, b, loaded):
        _, npath, epath = DRIVE.shortest({a: 0.0}, {b})
        steps = [(eid, npath[k]) for k, eid in enumerate(epath)]
        length = sum(layout.edge_length(eid) for eid, _ in steps)
        return dict(frm=a, to=b, steps=steps, length=length, loaded=loaded)

    def _build_legs(self):
        nodes = self.route + list(reversed(self.route[:-1]))
        return [self._make_leg(nodes[i], nodes[i + 1], i < len(self.route) - 1) for i in range(len(nodes) - 1)]

    def _leg(self):
        return self.detour[0] if self.detour else self.legs[self.leg]

    def _moving_state(self):
        leg = self._leg()
        if self.kind == "lhd":
            return "tramming_loaded" if leg["loaded"] else "tramming_empty"
        return "hauling" if leg["loaded"] else "returning"

    def position(self):
        """(edge, s) of the vehicle."""
        if self.fixed_pos:
            return self.fixed_pos
        leg = self._leg()
        d = self.dist
        for eid, start in leg["steps"]:
            length = layout.edge_length(eid)
            if d <= length or eid == leg["steps"][-1][0]:
                frac = min(1.0, d / length)
                s = frac if layout.EDGES[eid]["frm"] == start else 1.0 - frac
                return eid, s
            d -= length
        eid, start = leg["steps"][-1]
        return eid, 1.0 if layout.EDGES[eid]["frm"] == start else 0.0

    def speed_kmh(self):
        leg = self._leg()
        if self.kind == "lhd":
            return 10.0 if leg["loaded"] else 12.0
        return 12.0 if leg["loaded"] else 16.0

    def step(self, dt, mine):
        if self.on_fire:
            self.speed = 0.0
            self.state = "fire"
            return
        if self.parked:
            self.speed = 0.0
            self.state = "parked"
            return
        if self.state == "charging":
            # battery swap in the bay of the charging chamber (data sheet: swap option);
            # the depleted battery stays there on the charger
            self.timer += dt
            self.speed = 0.0
            if self.timer >= layout.BATTERY_SWAP_S:
                self.soc = 95.0
                self.state = self._moving_state()
            return
        if self.state in ("loading", "dumping", "waiting"):
            self.speed = 0.0
            self.timer += dt
            self._station(mine)
            return
        # moving
        v = km_h(self.speed_kmh())
        self.speed = self.speed_kmh()
        leg = self._leg()
        step = v * dt
        self.dist += step
        kwh_km = (3.5 if leg["loaded"] else 2.0) if self.kind == "lhd" else (6.0 if leg["loaded"] else 3.0)
        self.soc -= kwh_km * step / 1000.0 / self.cfg["battery_kwh"] * 100.0
        if self.dist >= leg["length"]:
            self.dist = leg["length"]
            self._arrive(mine)

    def _arrive(self, mine):
        self.timer = 0.0
        if self.detour:
            leg = self.detour.pop(0)
            self.dist = 0.0
            self.state = "charging" if leg["to"] == layout.SWAP_NODE else self._moving_state()
            return
        leg = self.legs[self.leg]
        if leg["loaded"] and leg["to"] == self.route[-1]:
            self.state = "dumping"
        elif not leg["loaded"] and leg["to"] == self.route[0]:
            self.state = "loading" if self.kind == "lhd" else "waiting"
        else:
            self._next_leg()

    def _next_leg(self):
        self.leg = (self.leg + 1) % len(self.legs)
        self.dist = 0.0
        if self.soc < 20.0 and self.legs[self.leg]["loaded"] is False:
            here = self.legs[self.leg]["frm"]
            self.detour = [self._make_leg(here, layout.SWAP_NODE, False),
                           self._make_leg(layout.SWAP_NODE, here, False)]
        self.state = self._moving_state()

    def _station(self, mine):
        if self.state == "loading":           # LHD mucking at the drawpoint
            if self.timer >= 60.0:
                self.payload = self.cfg["payload_t"]
                self._next_leg()
        elif self.state == "waiting":         # truck under the ore pass chute
            bin_node = self.route[0]
            if mine.bins.get(bin_node, 0.0) >= self.cfg["payload_t"]:
                mine.bins[bin_node] -= self.cfg["payload_t"]
                self.timer = 0.0
                self.state = "loading"
        elif self.state == "dumping":
            dump_s = 20.0 if self.kind == "lhd" else 16.0   # MT42 SG: 16 s
            if self.timer >= dump_s:
                dest = self.route[-1]
                mine.bins[dest] = mine.bins.get(dest, 0.0) + self.payload
                self.payload = 0.0
                self.trips += 1
                self._next_leg()


def _truck_station(vehicle, dt, mine):
    """Trucks: 'loading' means the chute is filling the box (120 s)."""
    if vehicle.kind != "truck" or vehicle.state != "loading":
        return False
    vehicle.timer += dt
    vehicle.speed = 0.0
    if vehicle.timer >= 120.0:
        vehicle.payload = vehicle.cfg["payload_t"]
        vehicle._next_leg()
    return True


# --------------------------------------------------------------------------
class Crew:
    def __init__(self, cid):
        self.id = cid
        self.cfg = layout.CREWS[cid]
        self.people = self.cfg["people"]
        self.edge = self.cfg["edge"]
        self.s = self.cfg["s"]
        self.state = "working"
        self.aware_at = None
        self.react_s = 0.0
        self.path = []          # list of (edge, start_node)
        self.target = None
        self.target_kind = None
        self.sr_on = False
        self.sr_left = layout.SELF_RESCUER_MIN
        self.fed = 0.0
        self.co = 0.0
        self.vis = CLEAR_VIS_M
        self.temp = 20.0
        self.replan_t = 0.0
        self.evac_time = None
        self.speed = 0.0

    @property
    def safe(self):
        return self.state in ("in_refuge", "surface")


# --------------------------------------------------------------------------
class MineModel:
    def __init__(self, seed=7):
        self.rng = random.Random(seed)
        self.t = 0.0
        self.net = Network()
        self.air = {eid: Airway(eid) for eid in layout.EDGES}
        self.node_c = {n: (0.0, 0.0, 0.0) for n in layout.NODES}
        self.doors = {d: Door(d) for d in layout.DOORS}
        self.valves = {v: Valve(v) for v in layout.VALVES}
        self.fans = {f: Fan(f) for f in layout.FANS}
        self.subs = {s: Substation(s) for s in layout.SUBSTATIONS}
        self.vehicles = {v: Vehicle(v, "lhd") for v in layout.LHDS}
        self.vehicles.update({v: Vehicle(v, "truck") for v in layout.TRUCKS})
        self.crews = {c: Crew(c) for c in layout.CREWS}
        self.fire = None
        self.faults = set()
        self.sensor_faults = set()
        self.fire_main_bar = layout.FIRE_MAIN["nominal_bar"]
        self.bins = {"J560": 30.0, "E480": 20.0, "J640": 0.0, "pocket": 60.0}
        self.crusher_run = True
        self.conveyor_run = True
        self.skip_run = True
        self.cage_ok = True
        self.skip_timer = 0.0
        self.cage_timer = 0.0
        self.ore_hoisted = 0.0
        self.hoist_log = []          # (t, tonnes)
        self.crusher_tph = 0.0
        self.conveyor_tph = 0.0
        self.drill_m = 0.0
        self.bolts = 0
        self.evac_order = None       # None | "all" | horizon id
        self.evac_order_at = None
        self.emergency_at = None
        self.lost_t = 0.0
        self.base_tph = 280.0        # planned rate of the modelled block
        self.events = []             # human-readable model events (sim log)
        self.scenario = {"active": False}
        self.net.solve()
        self.sensor_noise = {}

    # -- commands from twins (desired properties) ----------------------------
    def apply_desired(self, name, feature, value):
        if name in self.doors and feature == "position":
            self.doors[name].desired = value
        elif name in self.valves and feature == "position":
            self.valves[name].desired = value
        elif name in self.subs and feature == "power":
            self.subs[name].desired = value
        elif name in self.fans and feature == "run":
            self.fans[name].desired_run = bool(value)
        elif name in self.fans and feature == "mode":
            self.fans[name].desired_mode = value
        elif name == "conveyor-640" and feature == "command":
            self.conveyor_run = value == "run"
        elif name == "crusher-640" and feature == "command":
            self.crusher_run = value == "run"
        elif name == "hoist-skip" and feature == "command":
            self.skip_run = value == "run"
        elif name == "mine" and feature == "evacuation":
            zone = None if value in (None, "none", "") else value
            if zone and not self.evac_order:
                self.evac_order_at = self.t
                self.log(f"Команда эвакуации: {'вся шахта' if zone == 'all' else zone}")
            self.evac_order = zone
        elif name in self.vehicles and feature == "command":
            self.vehicles[name].parked = value == "park"

    def log(self, text):
        self.events.append((self.t, text))
        del self.events[:-60]

    # -- scenarios -----------------------------------------------------------
    def start_scenario(self, sc):
        """sc: fire_type (or None), faults list."""
        self.scenario = dict(sc, active=True, started_at=self.t)
        for f in sc.get("faults", []):
            kind, _, target = f.partition(":")
            self.faults.add(f)
            if kind == "door_stuck" and target in self.doors:
                self.doors[target].stuck = True
            elif kind == "valve_stuck" and target in self.valves:
                self.valves[target].stuck = True
            elif kind == "sensor_fault":
                self.sensor_faults.add(target)
            elif kind == "low_water":
                self.fire_main_bar = 3.5
            elif kind == "fan_trip":
                for fan in self.fans.values():
                    if fan.cfg["role"] == "duty":
                        fan.tripped = True
                self.log("Аварийное отключение рабочего вентилятора ГВУ")
            elif kind == "cage_out":
                self.cage_ok = False
                self.log("Клетевой подъём выведен из работы")
        ft = sc.get("fire_type")
        if ft:
            self.fire = Fire(ft)
            cfg = layout.FIRE_TYPES[ft]
            if cfg.get("vehicle"):
                v = self.vehicles[cfg["vehicle"]]
                v.on_fire = True
                v.parked = True
                v.fixed_pos = (cfg["edge"], cfg["s"])
                v.payload = 0.0
            self.log(f"Возгорание: {cfg['name']}")
        if self.emergency_at is None and (ft or "fan_trip" in sc.get("faults", [])):
            self.emergency_at = self.t

    # -- main step -----------------------------------------------------------
    def step(self, dt_total):
        n = max(1, int(math.ceil(dt_total / DT_PHYS)))
        dt = dt_total / n
        for _ in range(n):
            self._step(dt)

    def _step(self, dt):
        self.t += dt
        for d in self.doors.values():
            d.step(dt)
        for v in self.valves.values():
            v.step(dt)
        for f in self.fans.values():
            f.step(dt)
        for s in self.subs.values():
            s.step(dt)
        self._fire_step(dt)
        self._ventilation(dt)
        self._transport(dt)
        self._production(dt)
        self._people(dt)

    # -- fire ---------------------------------------------------------------
    def _deluge_effective(self, valve_id):
        if not valve_id:
            return False
        v = self.valves[valve_id]
        return v.open > 0.8 and self.fire_main_bar >= 6.0

    def _fire_step(self, dt):
        open_deluges = sum(1 for v in self.valves.values() if v.cfg["kind"] == "deluge" and v.open > 0.5)
        nominal = 3.5 if "low_water" in self.faults else layout.FIRE_MAIN["nominal_bar"]
        self.fire_main_bar = max(0.0, nominal - 1.2 * open_deluges)
        f = self.fire
        if not f or f.extinct:
            return
        c = f.cfg
        env = {}
        if c.get("deluge"):
            env["deluge"] = self._deluge_effective(c["deluge"])
        if c.get("power"):
            env["powered"] = self.subs[c["power"]].energized
        if c.get("running_factor"):
            env["running"] = self.subs["sub-640"].energized and self.conveyor_run
        if c.get("fuel_valve"):
            env["fuel_open"] = self.valves[c["fuel_valve"]].open > 0.05
        if c.get("vehicle"):
            v = self.vehicles[c["vehicle"]]
            if f.t >= layout.ONBOARD_DETECT_S and not v.fire_alarm and v.suppression != "failed":
                if f"onboard_fault:{v.id}" in self.faults:
                    v.suppression = "failed"
                    self.log(f"{v.cfg['name']}: бортовая система обнаружения и тушения не сработала")
                else:
                    v.fire_alarm = True
                    v.suppression = "discharged"
                    self.log(f"{v.cfg['name']}: бортовая система обнаружения пожара сработала, пожаротушение разряжено")
            env["onboard"] = v.suppression == "discharged"
        was = f.extinct
        f.step(dt, env)
        if f.extinct and not was:
            self.log("Очаг пожара затух")

    # -- ventilation ----------------------------------------------------------
    def _ventilation(self, dt):
        net = self.net
        for eid in net.extra_r:
            net.extra_r[eid] = 0.0
        for d in self.doors.values():
            net.extra_r[d.cfg["edge"]] += d.resistance()
        # fans in parallel: the fastest running unit sets the duty point
        best = max(self.fans.values(), key=lambda f: f.speed)
        net.fan_speed = best.speed
        net.fan_mode = best.mode if best.speed > 0 else "stopped"
        for eid, a in self.air.items():
            if a.kind in ("collar", "fan"):
                continue
            net.buoyancy[eid] = buoyancy_pressure(eid, a.t_amb + a.mean_dt(), a.t_amb)
        net.solve(max_iter=60)

    # -- smoke, CO and heat transport -----------------------------------------
    def _transport(self, dt):
        q = self.net.q
        umax = max(abs(q[eid]) / a.area / a.dx for eid, a in self.air.items())
        nsub = max(1, int(math.ceil(dt * umax / 0.9)))
        h = dt / nsub
        for _ in range(nsub):
            self._advect(h)
        # fire source
        f = self.fire
        if f and not f.extinct:
            a = self.air[f.edge]
            k = a.cell(f.s)
            m_co, m_soot, heat = f.products()
            a.co[k] = min(CO_CAP, a.co[k] + m_co / CO_DENSITY * dt / a.vol * 1e6)
            a.soot[k] = min(SOOT_CAP, a.soot[k] + m_soot * dt / a.vol)
            a.dtk[k] = min(DT_CAP, a.dtk[k] + heat * dt / (RHO_AIR * CP_AIR * a.vol))

    def _advect(self, h):
        q = self.net.q
        acc = {n: [0.0, 0.0, 0.0, 0.0] for n in layout.NODES}
        for eid, a in self.air.items():
            flow = q[eid]
            if abs(flow) < 1e-6:
                continue
            node = a.to if flow > 0 else a.frm
            i = a.n - 1 if flow > 0 else 0
            w = abs(flow)
            s = acc[node]
            s[0] += w
            s[1] += w * a.co[i]
            s[2] += w * a.soot[i]
            s[3] += w * a.dtk[i]
        node_c = {}
        for n, s in acc.items():
            if n == "ATM" or s[0] <= 1e-9:
                node_c[n] = (0.0, 0.0, 0.0) if n == "ATM" else self.node_c[n]
            else:
                node_c[n] = (s[1] / s[0], s[2] / s[0], s[3] / s[0])
        self.node_c = node_c
        for eid, a in self.air.items():
            flow = q[eid]
            u = flow / a.area
            cfl = min(1.0, abs(u) * h / a.dx)
            heat_k = math.exp(-abs(u) * h / HEAT_DECAY_M - h / 3600.0)
            co, soot, dtk = a.co, a.soot, a.dtk
            if flow > 1e-6:
                ic, isoot, idt = node_c[a.frm]
                for i in range(a.n - 1, -1, -1):
                    pc = co[i - 1] if i > 0 else ic
                    ps = soot[i - 1] if i > 0 else isoot
                    pt = dtk[i - 1] if i > 0 else idt
                    co[i] -= cfl * (co[i] - pc)
                    soot[i] -= cfl * (soot[i] - ps)
                    dtk[i] = (dtk[i] - cfl * (dtk[i] - pt)) * heat_k
            elif flow < -1e-6:
                ic, isoot, idt = node_c[a.to]
                last = a.n - 1
                for i in range(a.n):
                    pc = co[i + 1] if i < last else ic
                    ps = soot[i + 1] if i < last else isoot
                    pt = dtk[i + 1] if i < last else idt
                    co[i] -= cfl * (co[i] - pc)
                    soot[i] -= cfl * (soot[i] - ps)
                    dtk[i] = (dtk[i] - cfl * (dtk[i] - pt)) * heat_k
            else:
                k = math.exp(-h / 5400.0)
                for i in range(a.n):
                    co[i] *= k
                    soot[i] *= k
                    dtk[i] *= heat_k

    # -- readings ---------------------------------------------------------------
    def reading(self, eid, s):
        a = self.air[eid]
        i = a.cell(s)
        return dict(co=CO_BACKGROUND + a.co[i], vis=a.visibility_at(i), temp=a.t_amb + a.dtk[i],
                    vel=self.net.q[eid] / a.area)

    def sensor(self, sid):
        cfg = layout.SENSORS[sid]
        if sid in self.sensor_faults:
            return dict(state="fault", co=None, vis=None, temp=None, vel=None)
        r = self.reading(cfg["edge"], cfg["s"])
        # crc32, not hash(): str hashes are salted per process, runs must repeat exactly
        noise = self.sensor_noise.setdefault(sid, random.Random(zlib.crc32(sid.encode())))
        co = max(0.0, r["co"] + noise.gauss(0, 0.3))
        temp = r["temp"] + noise.gauss(0, 0.05)
        state = "ok"
        if co >= layout.CO_PDK_PPM:
            state = "warning"
        if co >= layout.CO_ALARM_PPM or r["vis"] < layout.SMOKE_ALARM_VIS_M or temp >= layout.TEMP_ALARM_C:
            state = "alarm"
        return dict(state=state, co=co, vis=r["vis"], temp=temp, vel=r["vel"])

    # -- production -------------------------------------------------------------
    def _production(self, dt):
        evac = self.evac_order is not None
        for v in self.vehicles.values():
            if evac and not v.on_fire:
                v.parked = True
            if _truck_station(v, dt, self):
                continue
            v.step(dt, self)
        powered640 = self.subs["sub-640"].energized
        # crusher -> conveyor -> skip pocket -> skip hoist
        crush_cap = layout.FIXED_PLANT["crusher-640"]["rated_tph"] * dt / 3600.0
        crushed = 0.0
        if powered640 and self.crusher_run and self.conveyor_run and self.bins["pocket"] < 600:
            crushed = min(self.bins["J640"], crush_cap)
            self.bins["J640"] -= crushed
            self.bins["pocket"] += crushed
        self.crusher_tph += (crushed * 3600.0 / dt - self.crusher_tph) * min(1.0, dt / 120.0)
        self.conveyor_tph = self.crusher_tph if (powered640 and self.conveyor_run) else 0.0
        hoist = layout.FIXED_PLANT["hoist-skip"]
        skip_powered = self.subs["sub-480"].energized
        if self.skip_run and skip_powered and self.bins["pocket"] >= 1.0:
            self.skip_timer += dt
            while self.skip_timer >= hoist["cycle_s"]:
                self.skip_timer -= hoist["cycle_s"]
                lift = min(hoist["skip_t"], self.bins["pocket"])
                self.bins["pocket"] -= lift
                self.ore_hoisted += lift
                self.hoist_log.append((self.t, lift))
        self.hoist_log = [(t, w) for t, w in self.hoist_log if self.t - t <= 1800.0]
        if not evac:
            self.drill_m += dt * 0.012          # Simba E70 S, ~43 m/h net
            if self.rng.random() < dt / 900.0:
                self.bolts += 1
        if self.emergency_at is not None:
            self.lost_t += max(0.0, self.base_tph - self.production_tph()) * dt / 3600.0

    def production_tph(self):
        window = min(1800.0, max(self.t, 1.0))
        return sum(w for _, w in self.hoist_log) * 3600.0 / window

    # -- people -------------------------------------------------------------------
    def _edge_hazard(self, eid):
        a = self.air[eid]
        return a.max_co() > 100.0 or a.min_visibility() < 5.0

    def _targets(self):
        targets = {}
        if self.cage_ok:
            for n in layout.CAGE_STATIONS:
                co = self.node_c[n][0]
                if co < 50.0:
                    targets[n] = "cage"
        for rid, r in layout.REFUGES.items():
            targets[r["node"]] = rid
        return targets

    def _plan(self, crew):
        a = self.air[crew.edge]
        length = a.length
        starts = {a.frm: crew.s * length, a.to: (1 - crew.s) * length}
        targets = self._targets()
        res = WALK.shortest(starts, set(targets), weight=lambda e: 25.0 if self._edge_hazard(e) else 1.0)
        if not res:
            return
        _, npath, epath = res
        crew.target = npath[-1]
        crew.target_kind = targets[crew.target]
        # (edge, node at its far end): first along the current airway
        crew.path = [(crew.edge, npath[0])] + [(eid, npath[k + 1]) for k, eid in enumerate(epath)]

    def _people(self, dt):
        for crew in self.crews.values():
            if crew.state == "surface":
                continue
            r = self.reading(crew.edge, crew.s)
            crew.co, crew.vis, crew.temp = r["co"], r["vis"], r["temp"]
            if crew.state in ("in_refuge",):
                continue
            ordered = self.evac_order is not None and (
                self.evac_order == "all" or layout.edge_horizon(crew.edge) == self.evac_order)
            sees_smoke = crew.co > 100.0 or crew.vis < 5.0
            if crew.state == "working" and (ordered or sees_smoke):
                if crew.aware_at is None:
                    crew.aware_at = self.t
                    crew.react_s = 30.0 if ordered else 60.0
                if self.t - crew.aware_at >= crew.react_s:
                    crew.state = "evacuating"
                    crew.replan_t = 0.0
                    self.log(f"{crew.cfg['name']} начала выход")
            if crew.state != "working" and not crew.sr_on and (crew.co > layout.CO_PDK_PPM or crew.vis < 10.0):
                crew.sr_on = True
                self.log(f"{crew.cfg['name']}: включились в самоспасатели")
            # exposure (Purser FED for CO, light work 25 L/min, 30 % COHb)
            protected = crew.sr_on and crew.sr_left > 0
            if crew.sr_on and crew.sr_left > 0:
                crew.sr_left = max(0.0, crew.sr_left - dt / 60.0)
            if not protected and crew.co > 5.0:
                crew.fed += 3.317e-5 * crew.co ** 1.036 * 25.0 * (dt / 60.0) / 30.0
            if crew.temp > 50.0:
                t_inc_min = 5.0e7 * crew.temp ** -3.4
                crew.fed += (dt / 60.0) / t_inc_min
            if crew.fed >= 1.0 and crew.state != "incapacitated":
                crew.state = "incapacitated"
                crew.speed = 0.0
                self.log(f"{crew.cfg['name']}: недопустимая доза угарного газа")
            if crew.state == "evacuating":
                self._walk(crew, dt)
            elif crew.state == "waiting_cage":
                crew.speed = 0.0
        self._cage(dt)

    def _walk(self, crew, dt):
        crew.replan_t -= dt
        if crew.replan_t <= 0 or not crew.path:
            self._plan(crew)
            crew.replan_t = 60.0
        if not crew.path:
            return
        factor = 1.0 if crew.vis >= 10 else (0.6 if crew.vis >= 3 else 0.35)
        if crew.sr_on:
            factor *= 0.85
        if layout.EDGES[crew.edge]["kind"] == "ramp":
            factor *= 0.75
        v = layout.WALK_SPEED * factor
        crew.speed = v
        remaining = v * dt
        while remaining > 0 and crew.path:
            eid, to_node = crew.path[0]
            if eid != crew.edge:
                crew.edge = eid
                crew.s = 0.0 if layout.EDGES[eid]["frm"] != to_node else 1.0
            length = layout.edge_length(eid)
            direction = 1.0 if layout.EDGES[eid]["to"] == to_node else -1.0
            target_s = 1.0 if direction > 0 else 0.0
            left = abs(target_s - crew.s) * length
            if remaining < left:
                crew.s += direction * remaining / length
                remaining = 0
            else:
                crew.s = target_s
                remaining -= left
                crew.path.pop(0)
                if crew.path:
                    nxt, _ = crew.path[0]
                    crew.edge = nxt
                    crew.s = 0.0 if layout.EDGES[nxt]["frm"] == to_node else 1.0
                else:
                    self._arrive(crew, to_node)

    def _arrive(self, crew, node):
        kind = crew.target_kind
        crew.speed = 0.0
        if kind == "cage":
            crew.state = "waiting_cage"
            self.log(f"{crew.cfg['name']} у клетевого ствола ({node})")
        else:
            crew.state = "in_refuge"
            crew.evac_time = self.t - (self.evac_order_at or crew.aware_at or self.t)
            self.log(f"{crew.cfg['name']} в камере-убежище ({node})")

    def _cage(self, dt):
        waiting = [c for c in self.crews.values() if c.state == "waiting_cage"]
        if not waiting or not self.cage_ok:
            self.cage_timer = 0.0
            return
        self.cage_timer += dt
        if self.cage_timer >= layout.FIXED_PLANT["hoist-cage"]["cycle_s"]:
            self.cage_timer = 0.0
            cap = layout.FIXED_PLANT["hoist-cage"]["cage_people"]
            for c in waiting:
                if c.people <= cap:
                    cap -= c.people
                    c.state = "surface"
                    c.evac_time = self.t - (self.evac_order_at or c.aware_at or self.t)
                    self.log(f"{c.cfg['name']} поднята на поверхность")

    # -- KPIs -----------------------------------------------------------------
    def kpi(self):
        crews = self.crews.values()
        total = sum(c.people for c in crews)
        safe = sum(c.people for c in crews if c.safe)
        at_risk = sum(c.people for c in crews if not c.safe and (c.fed >= 0.3 or (c.co > layout.CO_ALARM_PPM and not c.sr_on)))
        injured = sum(c.people for c in crews if c.state == "incapacitated")
        underground = sum(c.people for c in crews if c.state != "surface")
        evacuating = sum(c.people for c in crews if c.state in ("evacuating", "waiting_cage"))
        return dict(people_total=total, people_safe=safe, people_at_risk=at_risk, people_injured=injured,
                    people_underground=underground, people_evacuating=evacuating,
                    max_fed=max(c.fed for c in crews))
