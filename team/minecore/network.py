"""Ventilation network solver (Hardy Cross loop method).

Each airway obeys the square law p = R*Q|Q| (Atkinson). Sources of pressure
are the main fan (its characteristic curve, normal or reversed) and natural
ventilation pressure from hot fire gases in inclined airways (buoyancy).
Flows from the previous solution are used as the starting point, so a
re-solve after a door closes or the fan reverses takes a few iterations.
"""

import math

from . import layout

RHO0 = 1.2      # kg/m3, reference air density
G = 9.81
T_REF_K = 293.0


def atkinson_resistance(eid):
    e = layout.EDGES[eid]
    if e["alpha"] <= 0:
        base = 1e-5
    else:
        base = e["alpha"] * layout.edge_perimeter(eid) * layout.edge_length(eid) / e["area"] ** 3
    return base + e.get("regulator", 0.0)


class Network:
    def __init__(self):
        self.edges = list(layout.EDGES)
        self.nodes = list(layout.NODES)
        self.base_r = {eid: atkinson_resistance(eid) for eid in self.edges}
        self.extra_r = {eid: 0.0 for eid in self.edges}     # doors, blockages
        self.q = {eid: 0.0 for eid in self.edges}           # m3/s, + means frm -> to
        self.buoyancy = {eid: 0.0 for eid in self.edges}    # Pa, acting frm -> to
        # Fan: mode normal | reverse | stopped, speed fraction 0..1
        self.fan_mode = "normal"
        self.fan_speed = 1.0
        self.loops = self._find_loops()

    # -- topology ------------------------------------------------------------
    def _find_loops(self):
        """Fundamental loops: one per chord of a BFS spanning tree."""
        adj = {n: [] for n in self.nodes}
        for eid in self.edges:
            e = layout.EDGES[eid]
            adj[e["frm"]].append((e["to"], eid))
            adj[e["to"]].append((e["frm"], eid))
        root = "ATM"
        parent = {root: (None, None)}
        order = [root]
        for n in order:
            for m, eid in adj[n]:
                if m not in parent:
                    parent[m] = (n, eid)
                    order.append(m)
        tree = {eid for (_, eid) in parent.values() if eid}

        def ancestors(n):
            out = [n]
            while parent[n][0] is not None:
                n = parent[n][0]
                out.append(n)
            return out

        loops = []
        for eid in self.edges:
            if eid in tree:
                continue
            e = layout.EDGES[eid]
            # loop: chord frm->to, then tree path from `to` back to `frm`
            anc_frm = set(ancestors(e["frm"]))
            common = next(n for n in ancestors(e["to"]) if n in anc_frm)
            loop = [(eid, 1)]
            # from `to` up to common
            n = e["to"]
            while n != common:
                pn, peid = parent[n]
                pe = layout.EDGES[peid]
                loop.append((peid, 1 if pe["frm"] == n else -1))
                n = pn
            # from common down to `frm`: reverse of frm's path up to common
            down = []
            n = e["frm"]
            while n != common:
                pn, peid = parent[n]
                pe = layout.EDGES[peid]
                down.append((peid, 1 if pe["to"] == n else -1))
                n = pn
            loop.extend(reversed(down))
            loops.append(loop)
        return loops

    # -- characteristics -----------------------------------------------------
    def resistance(self, eid):
        return self.base_r[eid] + self.extra_r[eid]

    def fan_pressure(self, q):
        """Pressure the fan adds in the VS0 -> ATM direction, and dp/dq."""
        s = self.fan_speed
        if self.fan_mode == "normal" and s > 0:
            p0, k = layout.FAN_P0 * s * s, layout.FAN_K
            return p0 - k * q * abs(q), -2 * k * abs(q)
        if self.fan_mode == "reverse" and s > 0:
            p0, k = layout.FAN_REV_P0 * s * s, layout.FAN_REV_K
            return -(p0 + k * q * abs(q)), -2 * k * abs(q)
        return 0.0, 0.0

    def source(self, eid, q):
        p, dp = (self.fan_pressure(q) if eid == "fan" else (0.0, 0.0))
        return p + self.buoyancy[eid], dp

    def stopped_fan_resistance(self):
        return 0.0 if (self.fan_speed > 0 and self.fan_mode != "stopped") else 0.08

    # -- solve ---------------------------------------------------------------
    def solve(self, max_iter=300, tol=0.005):
        self.extra_r["fan"] = self.stopped_fan_resistance()
        for it in range(max_iter):
            worst = 0.0
            for loop in self.loops:
                f = 0.0
                df = 0.0
                for eid, sgn in loop:
                    q = self.q[eid]
                    r = self.resistance(eid)
                    h, dh = self.source(eid, q)
                    f += sgn * (r * q * abs(q) - h)
                    df += 2 * r * abs(q) - dh
                if df < 1e-9:
                    df = 1e-9 + sum(self.resistance(e) for e, _ in loop)
                dq = -f / df
                # damping keeps the first iterations from a cold start sane
                dq = max(-80.0, min(80.0, dq))
                for eid, sgn in loop:
                    self.q[eid] += sgn * dq
                worst = max(worst, abs(dq))
            if worst < tol:
                return it + 1
        return max_iter

    def node_balance(self):
        bal = {n: 0.0 for n in self.nodes}
        for eid in self.edges:
            e = layout.EDGES[eid]
            bal[e["frm"]] -= self.q[eid]
            bal[e["to"]] += self.q[eid]
        return bal

    def pressure_drop(self, eid):
        q = self.q[eid]
        return self.resistance(eid) * q * abs(q)


def buoyancy_pressure(eid, t_avg_c, t_amb_c):
    """Natural draught of hot gas in an airway, Pa, acting frm -> to."""
    e = layout.EDGES[eid]
    if e["kind"] in ("collar", "fan"):
        return 0.0
    z1 = layout.NODES[e["frm"]][3]
    z2 = layout.NODES[e["to"]][3]
    dz = z2 - z1
    if abs(dz) < 1.0:
        return 0.0
    t = t_avg_c + 273.15
    ta = t_amb_c + 273.15
    if t <= ta:
        return 0.0
    return RHO0 * G * dz * (1.0 - ta / t)


if __name__ == "__main__":
    net = Network()
    n = net.solve()
    print(f"loops={len(net.loops)} iterations={n}")
    total = net.q["fan"]
    print(f"total airflow {total:.1f} m3/s, fan pressure {net.fan_pressure(total)[0]:.0f} Pa")
    for eid in layout.AIRWAYS:
        a = layout.EDGES[eid]["area"]
        print(f"{eid:14s} Q={net.q[eid]:7.1f} m3/s  v={net.q[eid] / a:5.2f} m/s  R={net.resistance(eid):.5f}")
    print("max imbalance", max(abs(v) for v in net.node_balance().values()))
