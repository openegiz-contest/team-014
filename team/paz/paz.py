#!/usr/bin/env python3
"""Emergency protection (ПАЗ) for the Bolashak mine.

Watches the twins through the platform's event stream (gas stations,
vehicle fire detection, fans), picks the matching position of the
emergency response plan and issues its commands as `desiredProperties`
of the actuator twins. It then checks the reported state of every
actuator: a door that does not close or a valve that does not open is
logged as a protection failure, and the fallback is applied.

Mode `auto`: commands go out on detection (5 s confirmation).
Mode `manual`: the plan waits for the dispatcher, who either confirms it
on the panel or reacts after DISPATCHER_DELAY_S of simulated time.
"""

import collections
import json
import logging
import os
import signal
import sys
import time

from minecore import ditto, layout, pla, twins

log = logging.getLogger("paz")

CONFIRM_S = 5.0
DISPATCHER_DELAY_S = float(os.environ.get("DISPATCHER_DELAY_S", "300"))
TICK = 1.0

EXPECT = {
    # (feature, commanded value) -> (reported feature, reported value)
    ("position", "closed"): ("position", "closed"),
    ("position", "open"): ("position", "open"),
    ("power", "off"): ("power", "off"),
    ("command", "stop"): ("state", "stopped"),
    ("mode", "reverse"): ("rotation", "reverse"),
    ("mode", "normal"): ("rotation", "normal"),
    ("run", True): ("state", "running"),
    ("evacuation", "all"): ("evacuation", "all"),
}


def timeout_for(name, feature):
    if name in layout.DOORS:
        return layout.DOORS[name]["travel_s"] * 1.5 + 20
    if name in layout.VALVES:
        return layout.VALVES[name]["travel_s"] * 2 + 20
    if feature == "mode":
        return layout.FAN_REVERSE_S + 120
    if feature == "run":
        return layout.FAN_START_S + 90
    return 60.0


class Paz:
    def __init__(self, client):
        self.client = client
        self.mirror = ditto.Mirror()
        self.inbox = collections.deque()
        self.names = list(twins.definitions())
        self.reset(0)
        self.last_pub = {}

    def reset(self, seq):
        self.seq = seq
        self.position = None
        self.detected_at = None
        self.trigger = ""
        self.commands = []        # dicts: name, feature, value, note, due, issued, status, checked
        self.events = []
        self.fan_handled = False
        self.fan_evac = False
        self.low_water_logged = False
        self.extra_alarms = set()
        self.confirm_seq = None
        self.done_at = None

    def log(self, t, text):
        self.events.append([round(t), text])
        del self.events[:-40]
        log.info("[%6.0f] %s", t, text)

    # -- MQTT ----------------------------------------------------------------------
    def on_connect(self, client, userdata, flags, reason, properties=None):
        client.subscribe("opentwins/#", qos=0)

    def on_message(self, client, userdata, msg):
        ev = ditto.parse_event(msg.payload)
        if ev:
            self.inbox.append(ev)

    def drain(self):
        while self.inbox:
            self.mirror.apply(*self.inbox.popleft())

    # -- state helpers ---------------------------------------------------------------------
    def now(self):
        return float(self.mirror.prop("mine", "sim_time", default=0.0) or 0.0)

    def mode(self):
        d = self.mirror.desired("control", "paz_mode")
        if d and d.get("value") in ("auto", "manual"):
            return d["value"]
        return self.mirror.prop("control", "paz_mode", default="auto") or "auto"

    def alarms(self):
        sensors = [s for s in layout.SENSORS if self.mirror.prop(s, "state") == "alarm"]
        vehicles = [v for v in list(layout.LHDS) + list(layout.TRUCKS) if self.mirror.prop(v, "fire_alarm") is True]
        return sensors, vehicles

    # -- planning --------------------------------------------------------------------------
    def plan(self, t, position, manual):
        due = t + (DISPATCHER_DELAY_S if manual else CONFIRM_S)
        cmds = [dict(name=n, feature=f, value=v, note=note) for n, f, v, note in position["actions"]]
        if position.get("ventilation") == "reverse":
            for fid in layout.FANS:
                cmds.append(dict(name=fid, feature="mode", value="reverse",
                                 note=f"реверсировать вентиляционную струю ({fid})"))
        if position.get("evacuation"):
            cmds.append(dict(name="mine", feature="evacuation", value=position["evacuation"],
                             note="вывести людей из шахты"))
        for c in cmds:
            c.update(due=due, issued=None, status="pending")
        self.commands.extend(cmds)

    def issue(self, t, c):
        props = {"value": c["value"], "by": "paz", "position": self.position["id"] if self.position else "P7"}
        ditto.publish(self.client, c["name"], ditto.set_desired(c["name"], c["feature"], props))
        c["issued"] = t
        c["status"] = "issued"
        self.log(t, f"Команда: {c['note']}")

    def verify(self, t, c):
        exp = EXPECT.get((c["feature"], c["value"]))
        if not exp:
            c["status"] = "done"
            return
        rep_feature, rep_value = exp
        actual = self.mirror.prop(c["name"], rep_feature)
        if actual == rep_value:
            c["status"] = "done"
            self.log(t, f"Выполнено: {c['note']} ({round(t - c['issued'])} с)")
        elif t - c["issued"] > timeout_for(c["name"], c["feature"]):
            c["status"] = "fault"
            self.log(t, f"ОТКАЗ: {c['note']} — состояние «{actual}»")
            self.fallback(t, c)

    def fallback(self, t, c):
        name = c["name"]
        if name in layout.DOORS:
            self.log(t, "Резерв: изоляция очага не обеспечена, дым пойдёт по сети — "
                        "вызов ВГСЧ, контроль путей выхода, повторная команда на дверь")
            ditto.publish(self.client, name, ditto.set_desired(name, c["feature"], {"value": c["value"], "by": "paz", "retry": True}))
        elif name in layout.VALVES and layout.VALVES[name]["kind"] == "esd":
            self.log(t, "Резерв: топливо продолжает поступать — перекрыть ручную задвижку на поверхности, вызов ВГСЧ")
        elif name in layout.VALVES:
            self.log(t, "Резерв: автоматическое тушение не работает — тушение силами ВГСЧ")
        elif name in layout.FANS:
            self.log(t, "Резерв: реверс не выполнен — эвакуация по нормальному режиму проветривания")

    # -- main loop ---------------------------------------------------------------------------
    def tick(self):
        self.drain()
        seq = self.mirror.prop("control", "scenario", "seq", 0) or 0
        if seq != self.seq:
            self.reset(seq)
            self.quiet_until = time.monotonic() + 3.0   # let the fresh mine state arrive
            self.log(self.now(), "ПАЗ в дежурном режиме")
        if time.monotonic() < getattr(self, "quiet_until", 0.0):
            return
        t = self.now()
        manual = self.mode() == "manual"
        sensors, vehicles = self.alarms()

        if self.position is None:
            pos = pla.match(sensors, vehicles)
            if pos:
                self.position = pos
                self.detected_at = t
                self.trigger = ", ".join(vehicles + sensors)
                self.log(t, f"Обнаружено: {self.trigger}. Вводится {pos['title']}")
                if manual:
                    self.log(t, "Режим «ручной»: ПАЗ ждёт решения горного диспетчера")
                self.plan(t, pos, manual)
        else:
            new = set(sensors) - self.extra_alarms - set(self.trigger.split(", "))
            for s in sorted(new):
                self.log(t, f"Распространение: аварийный сигнал {s}")
            self.extra_alarms |= set(sensors)

        # dispatcher confirmation from the panel
        conf = self.mirror.desired("control", "paz_confirm")
        if conf and conf.get("seq") and conf.get("seq") != self.confirm_seq:
            self.confirm_seq = conf.get("seq")
            pend = [c for c in self.commands if c["status"] == "pending"]
            if pend:
                self.log(t, "Диспетчер подтвердил ввод позиции ПЛА")
                for c in pend:
                    c["due"] = t

        self.fan_watch(t)

        for c in self.commands:
            if c["status"] == "pending" and t >= c["due"]:
                self.issue(t, c)
            elif c["status"] == "issued":
                self.verify(t, c)

        if any(c["name"].startswith("dv-") and c["status"] in ("issued", "done") for c in self.commands):
            if self.mirror.prop("fire-main", "state") == "low" and not self.low_water_logged:
                self.low_water_logged = True
                self.log(t, "Давление в пожарно-оросительном трубопроводе ниже 6 бар: завеса неэффективна — "
                            "запустить резервный насос, тушение силами ВГСЧ")
        if self.commands and self.done_at is None and all(c["status"] in ("done", "fault") for c in self.commands):
            self.done_at = t
            faults = sum(1 for c in self.commands if c["status"] == "fault")
            self.log(t, f"Позиция ПЛА отработана за {round(t - (self.detected_at or t))} с" +
                     (f", отказов: {faults}" if faults else ""))
        self.publish(t, manual)

    def fan_watch(self, t):
        tripped = [f for f in layout.FANS if self.mirror.prop(f, "state") == "tripped"]
        if not tripped:
            return
        if not self.fan_handled:
            self.fan_handled = True
            self.fan_trip_at = t
            if self.detected_at is None:
                self.detected_at = t
                self.trigger = ", ".join(tripped)
            self.log(t, f"Обнаружено: остановка {', '.join(tripped)}. Вводится {pla.FAN_TRIP['title']}")
            standby = [f for f in layout.FANS if f not in tripped]
            mode = "reverse" if self.position and self.position.get("ventilation") == "reverse" else "normal"
            for f in standby:
                cmds = [dict(name=f, feature="run", value=True, note=f"запустить резервный вентилятор ({f})")]
                if mode == "reverse":
                    cmds.append(dict(name=f, feature="mode", value="reverse", note=f"реверс резервного вентилятора ({f})"))
                for c in cmds:
                    c.update(due=t + (DISPATCHER_DELAY_S if self.mode() == "manual" else CONFIRM_S),
                             issued=None, status="pending")
                self.commands.extend(cmds)
        elif not self.fan_evac and t - self.fan_trip_at > pla.FAN_TRIP["evacuate_after_s"]:
            airflow = float(self.mirror.prop("gvu", "airflow", default=0) or 0)
            if airflow < 0.5 * 350:
                self.fan_evac = True
                self.log(t, "Проветривание не восстановлено за 10 мин — вывод людей")
                self.commands.append(dict(name="mine", feature="evacuation", value="all", note="вывести людей из шахты",
                                          due=t, issued=None, status="pending"))

    def publish(self, t, manual):
        pending = sum(1 for c in self.commands if c["status"] == "pending")
        if self.position is None and not self.fan_handled:
            state = "standby"
        elif pending and manual:
            state = "awaiting_dispatcher"
        elif any(c["status"] == "fault" for c in self.commands):
            state = "fault"
        elif pending or any(c["status"] == "issued" for c in self.commands):
            state = "acting"
        else:
            state = "completed"
        feats = {
            "mode": {"value": "manual" if manual else "auto"},
            "state": {"value": state},
            "position": {"value": self.position["id"] if self.position else ("P7" if self.fan_handled else "none"),
                         "title": self.position["title"] if self.position else
                         (pla.FAN_TRIP["title"] if self.fan_handled else "")},
            "trigger": {"value": self.trigger},
            "detected_at": {"value": round(self.detected_at) if self.detected_at is not None else None, "unit": "с"},
            "response_time": {"value": round(self.done_at - self.detected_at) if self.done_at is not None and self.detected_at is not None else None, "unit": "с"},
            "faults": {"value": sum(1 for c in self.commands if c["status"] == "fault"), "unit": "шт"},
            "commands": {"value": json.dumps([dict(twin=c["name"], cmd=f"{c['feature']}={c['value']}", note=c["note"],
                                                  status=c["status"], issued=c["issued"] and round(c["issued"]))
                                             for c in self.commands], ensure_ascii=False)},
            "log": {"value": json.dumps(self.events[-30:], ensure_ascii=False)},
        }
        changed = {k: v for k, v in feats.items() if self.last_pub.get(k) != v}
        if changed:
            ditto.publish(self.client, "paz", ditto.merge_features("paz", changed))
            self.last_pub.update(changed)
        if "mode" in changed:
            ditto.publish(self.client, "control", ditto.merge_features("control", {"paz_mode": feats["mode"]}))


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not ditto.wait_for_ditto():
        log.error("Ditto not reachable")
        return 1
    client = ditto.mqtt_client("bolashak-paz")
    paz = Paz(client)
    client.on_connect = paz.on_connect
    client.on_message = paz.on_message
    client.loop_start()
    ditto.wait_connected(client)
    paz.mirror.load(paz.names)
    paz.seq = paz.mirror.prop("control", "scenario", "seq", 0) or 0
    stopping = []
    signal.signal(signal.SIGTERM, lambda *_: stopping.append(1))
    signal.signal(signal.SIGINT, lambda *_: stopping.append(1))
    log.info("ПАЗ started, %d twins mirrored", len(paz.mirror.things))
    while not stopping:
        t0 = time.monotonic()
        try:
            paz.tick()
        except Exception:  # keep protecting even if one tick hits bad data
            log.exception("tick failed")
        time.sleep(max(0.0, TICK - (time.monotonic() - t0)))
    client.loop_stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
