"""Fire source model: heat release rate and combustion products."""

import math

from . import layout


class Fire:
    """One fire with a t-squared growth, plateau and exponential decay.

    Modifiers reproduce what the protection systems do to a real fire:
    deluge/foam suppression (needs fire-main pressure), cutting power to a
    battery charger, stopping a burning conveyor belt, closing the fuel
    line shut-off valve, and the on-board suppression of battery vehicles
    followed by battery re-ignition (thermal runaway continues inside).
    """

    def __init__(self, ftype):
        self.type = ftype
        self.cfg = layout.FIRE_TYPES[ftype]
        self.edge = self.cfg["edge"]
        self.s = self.cfg["s"]
        self.t = 0.0
        self.hrr_mw = 0.0
        self.factor = 1.0
        self.fuel_cut_at = None
        self.suppressed_at = None
        self.onboard_at = None
        self.extinct = False
        self.energy_gj = 0.0

    def curve(self, t):
        c = self.cfg
        if t <= c["t_peak_s"]:
            return c["peak_mw"] * (t / c["t_peak_s"]) ** 2
        if t <= c["t_peak_s"] + c["plateau_s"]:
            return c["peak_mw"]
        return c["peak_mw"] * math.exp(-(t - c["t_peak_s"] - c["plateau_s"]) / c["decay_s"])

    def step(self, dt, env):
        """env: deluge (bool, effective), powered (bool), running (bool),
        fuel_open (bool), onboard (bool, vehicle system discharged)."""
        if self.extinct:
            return
        self.t += dt
        c = self.cfg
        target = 1.0
        if c.get("powered_factor") and env.get("powered", False):
            target *= c["powered_factor"]
        if c.get("running_factor") and env.get("running", False):
            target *= c["running_factor"]
        if c.get("fuel_valve"):
            if not env.get("fuel_open", True):
                if self.fuel_cut_at is None:
                    self.fuel_cut_at = self.t
                # only the pool already spilled keeps burning
                target *= math.exp(-(self.t - self.fuel_cut_at) / 240.0)
            else:
                self.fuel_cut_at = None
        if env.get("deluge"):
            if self.suppressed_at is None:
                self.suppressed_at = self.t
            target *= c["suppress_factor"]
        else:
            self.suppressed_at = None
        if c.get("reignite") and env.get("onboard"):
            if self.onboard_at is None:
                self.onboard_at = self.t
            since = self.t - self.onboard_at
            # the on-board system knocks the flames down, but the cells in
            # thermal runaway re-ignite the vehicle after about 10 minutes
            if since < 600:
                target *= 0.25
        # first-order lag so that valves and water act over ~45 s
        self.factor += (target - self.factor) * min(1.0, dt / 45.0)
        self.hrr_mw = self.curve(self.t) * self.factor
        self.energy_gj += self.hrr_mw * dt / 1000.0
        if self.t > c["t_peak_s"] and self.hrr_mw < 0.05:
            self.extinct = True
            self.hrr_mw = 0.0

    def products(self):
        """Mass rates, kg/s: CO, soot; convective heat W."""
        q = self.hrr_mw * 1e6
        fuel = q / layout.HEAT_OF_COMBUSTION
        return fuel * self.cfg["co_yield"], fuel * self.cfg["soot_yield"], q * layout.CONVECTIVE_FRACTION
