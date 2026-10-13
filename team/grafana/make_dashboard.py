#!/usr/bin/env python3
"""Generate the Grafana dashboard bolashak.json (python3 make_dashboard.py).

Every panel reads InfluxDB data written by the platform's Telegraf from the
twin events: measurement mqtt_consumer, tag thingId, fields
value_<feature>_properties_value."""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from minecore import layout  # noqa: E402

DS = {"type": "influxdb", "uid": "opentwins-influxdb"}
NS = "bolashak"

# legend names of the series panels: the dispatcher reads places, not twin ids
NAMES = {sid: s["name"].replace("Датчик-узел ", "Узел ") for sid, s in layout.SENSORS.items()}
NAMES.update({"shaft-cage": "Клетевой ствол", "shaft-skip": "Скиповой ствол", "shaft-vent": "Вентиляционный ствол"})
NAMES.update({vid: v["name"].split(" ")[0] + " №" + v["name"].rsplit("№", 1)[-1]
              for vid, v in {**layout.LHDS, **layout.TRUCKS}.items()})


def text_state(thing, feature):
    """Last value only: stat panels on string fields would also show the time column."""
    return flux(thing, feature, fn="last()").replace('keep(columns: ["_time", "_value", "thingId"])', 'keep(columns: ["_value"])')


def flux(thing, feature, regex=False, fn=None):
    sel = f'r.thingId =~ /^{NS}:{thing}/' if regex else f'r.thingId == "{NS}:{thing}"'
    q = ""
    if regex:
        pairs = ", ".join(f'"{NS}:{k}": "{v}"' for k, v in NAMES.items())
        q += f'import "dict"\n\nnames = [{pairs}]\n\n'
    q += ('from(bucket: "default")\n  |> range(start: v.timeRangeStart, stop: v.timeRangeStop)\n'
          f'  |> filter(fn: (r) => {sel} and r._field == "value_{feature}_properties_value")\n')
    if fn:
        q += f"  |> {fn}\n"
    if regex:
        q += ('  |> map(fn: (r) => ({r with name: dict.get(dict: names, key: r.thingId, default: r.thingId)}))\n'
              '  |> keep(columns: ["_time", "_value", "name"])\n  |> group(columns: ["name"])')
    else:
        q += '  |> keep(columns: ["_time", "_value", "thingId"])'
    return q


def target(q, ref="A"):
    return {"refId": ref, "datasource": DS, "query": q}


_id = [0]


def panel(kind, title, targets, x, y, w, h, unit=None, thresholds=None, mappings=None, extra=None, desc=None):
    _id[0] += 1
    p = {
        "id": _id[0], "type": kind, "title": title, "datasource": DS,
        "gridPos": {"x": x, "y": y, "w": w, "h": h},
        "targets": targets,
        "fieldConfig": {"defaults": {"displayName": "${__field.labels.name}" if any(
            "group(columns: [\"name\"])" in t["query"] for t in targets) else title}, "overrides": []},
        "options": {},
    }
    if desc:
        p["description"] = desc
    d = p["fieldConfig"]["defaults"]
    if unit:
        d["unit"] = unit
    if thresholds:
        d["thresholds"] = {"mode": "absolute", "steps": thresholds}
    if mappings:
        d["mappings"] = mappings
    if kind == "stat":
        d["displayName"] = title
        # text states are string fields; "" would select numeric fields only
        p["options"] = {"reduceOptions": {"calcs": ["lastNotNull"], "fields": "/.*/" if mappings else "", "values": False},
                        "colorMode": "background" if thresholds or mappings else "none",
                        "graphMode": "none", "textMode": "value", "justifyMode": "center"}
    if kind == "timeseries":
        d["custom"] = {"lineWidth": 2, "fillOpacity": 6, "showPoints": "never", "spanNulls": True,
                       "thresholdsStyle": {"mode": "line" if thresholds else "off"}}
        p["options"] = {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}}
    if extra:
        for k, v in extra.items():
            p[k] = v
    return p


GREY = "#8592a3"
OK, WARN, ALARM, INFO = "#3fb68b", "#e5a50a", "#ef4b4b", "#4aa3df"


def text_map(pairs):
    return [{"type": "value", "options": {k: {"text": t, "color": c, "index": i} for i, (k, (t, c)) in enumerate(pairs.items())}}]


panels = []
y = 0
stats = [
    ("Людей в шахте", "mine", "people_underground", "none", [{"color": GREY, "value": None}]),
    ("В безопасности", "mine", "people_safe", "none", [{"color": GREY, "value": None}, {"color": OK, "value": 1}]),
    ("Под угрозой", "mine", "people_at_risk", "none", [{"color": GREY, "value": None}, {"color": WARN, "value": 1}]),
    ("Пострадали", "mine", "people_injured", "none", [{"color": GREY, "value": None}, {"color": ALARM, "value": 1}]),
    ("Макс. доза CO (FED)", "mine", "max_fed", "none", [{"color": GREY, "value": None}, {"color": WARN, "value": 0.3}, {"color": ALARM, "value": 1}]),
    ("Выдача руды, т/ч", "mine", "production", "none", None),
]
for i, (title, thing, feat, unit, th) in enumerate(stats):
    panels.append(panel("stat", title, [target(flux(thing, feat))], i * 4, y, 4, 4, unit=unit, thresholds=th))
y += 4
panels.append(panel("stat", "Режим шахты", [target(text_state("mine", "emergency"))], 0, y, 6, 4, mappings=text_map({
    "normal": ("штатный", GREY), "alarm": ("аварийный сигнал", WARN), "evacuation": ("эвакуация", ALARM), "fan_trip": ("остановка ГВУ", ALARM)})))
panels.append(panel("stat", "ПАЗ", [target(text_state("paz", "state"))], 6, y, 6, 4, mappings=text_map({
    "standby": ("дежурный режим", GREY), "acting": ("выполняет ПЛА", INFO), "awaiting_dispatcher": ("ждёт диспетчера", WARN),
    "completed": ("позиция отработана", OK), "fault": ("отказ исполнения", ALARM), "disabled": ("выведена из работы", ALARM)})))
panels.append(panel("stat", "Режим проветривания", [target(text_state("gvu", "mode"))], 12, y, 6, 4, mappings=text_map({
    "normal": ("нормальный", GREY), "reverse": ("реверс", WARN), "stopped": ("остановлен", ALARM)})))
panels.append(panel("stat", "Рекомендация советчика", [target(text_state("advisor", "best_option"))], 18, y, 6, 4, mappings=text_map({
    "none": ("аварии нет", GREY), "normal": ("нормальный режим + ПЛА", OK), "reverse": ("реверс + ПЛА", WARN)})))
y += 4
panels.append(panel("timeseries", "CO на газоаналитических узлах, ppm", [target(flux("gs-", "co", regex=True))], 0, y, 12, 9, unit="ppm",
                    thresholds=[{"color": GREY, "value": None}, {"color": WARN, "value": 17}, {"color": ALARM, "value": 50}],
                    desc="ПДК CO 17 ppm (0,0017 %, Приказ МЧС РК №352), уставка аварии 50 ppm"))
panels.append(panel("timeseries", "Видимость в дыму, м", [target(flux("gs-", "visibility", regex=True))], 12, y, 12, 9, unit="lengthm",
                    thresholds=[{"color": ALARM, "value": None}, {"color": GREY, "value": 10}]))
y += 9
panels.append(panel("timeseries", "Люди", [target(flux("mine", "people_safe"), "A"), target(flux("mine", "people_evacuating"), "B"),
                                           target(flux("mine", "people_at_risk"), "C")], 0, y, 8, 8, unit="none",
                    extra={"fieldConfig": {"defaults": {"custom": {"lineWidth": 2, "fillOpacity": 6, "showPoints": "never", "spanNulls": True}},
                                           "overrides": [
                                               {"matcher": {"id": "byFrameRefID", "options": "A"}, "properties": [{"id": "displayName", "value": "в безопасности"}, {"id": "color", "value": {"mode": "fixed", "fixedColor": OK}}]},
                                               {"matcher": {"id": "byFrameRefID", "options": "B"}, "properties": [{"id": "displayName", "value": "выходят"}, {"id": "color", "value": {"mode": "fixed", "fixedColor": INFO}}]},
                                               {"matcher": {"id": "byFrameRefID", "options": "C"}, "properties": [{"id": "displayName", "value": "под угрозой"}, {"id": "color", "value": {"mode": "fixed", "fixedColor": WARN}}]}]}}))
panels.append(panel("timeseries", "Мощность пожара: сценарий и оценка советчика, МВт",
                    [target(flux("control", "hrr"), "A"), target(flux("advisor", "fire_hrr"), "B")], 8, y, 8, 8, unit="none",
                    extra={"fieldConfig": {"defaults": {"custom": {"lineWidth": 2, "fillOpacity": 0, "showPoints": "never", "spanNulls": True}},
                                           "overrides": [
                                               {"matcher": {"id": "byFrameRefID", "options": "A"}, "properties": [{"id": "displayName", "value": "очаг (сценарий)"}, {"id": "color", "value": {"mode": "fixed", "fixedColor": ALARM}}]},
                                               {"matcher": {"id": "byFrameRefID", "options": "B"}, "properties": [{"id": "displayName", "value": "оценка по датчикам"}, {"id": "color", "value": {"mode": "fixed", "fixedColor": WARN}}]}]}}))
panels.append(panel("timeseries", "Главная вентиляторная установка", [target(flux("gvu", "airflow"), "A"), target(flux("gvu", "pressure"), "B")], 16, y, 8, 8,
                    extra={"fieldConfig": {"defaults": {"custom": {"lineWidth": 2, "fillOpacity": 0, "showPoints": "never", "spanNulls": True}},
                                           "overrides": [
                                               {"matcher": {"id": "byFrameRefID", "options": "A"}, "properties": [{"id": "displayName", "value": "расход, м³/с"}]},
                                               {"matcher": {"id": "byFrameRefID", "options": "B"}, "properties": [{"id": "displayName", "value": "депрессия, Па"}, {"id": "custom.axisPlacement", "value": "right"}]}]}}))
y += 8
panels.append(panel("timeseries", "Расход воздуха по стволам, м³/с", [target(flux("shaft-", "airflow", regex=True))], 0, y, 8, 8))
panels.append(panel("timeseries", "Выдача руды, т/ч", [target(flux("mine", "production"), "A"), target(flux("crusher-640", "throughput"), "B")], 8, y, 8, 8,
                    extra={"fieldConfig": {"defaults": {"custom": {"lineWidth": 2, "fillOpacity": 6, "showPoints": "never", "spanNulls": True}},
                                           "overrides": [
                                               {"matcher": {"id": "byFrameRefID", "options": "A"}, "properties": [{"id": "displayName", "value": "скиповой подъём"}]},
                                               {"matcher": {"id": "byFrameRefID", "options": "B"}, "properties": [{"id": "displayName", "value": "дробилка -640"}]}]}}))
panels.append(panel("timeseries", "Заряд батарей техники, %", [target(flux("(lhd|truck)-", "battery", regex=True))], 16, y, 8, 8, unit="percent"))
y += 8
panels.append(panel("timeseries", "Температура на узлах, °C", [target(flux("gs-", "temperature", regex=True))], 0, y, 12, 8, unit="celsius",
                    thresholds=[{"color": GREY, "value": None}, {"color": ALARM, "value": 60}]))
panels.append(panel("timeseries", "Давление в пожарно-оросительном трубопроводе, бар", [target(flux("fire-main", "pressure"))], 12, y, 12, 8,
                    thresholds=[{"color": ALARM, "value": None}, {"color": GREY, "value": 6}]))

dashboard = {
    "uid": "bolashak-mine",
    "title": "Шахта «Болашак»: безопасность и противоаварийная защита",
    "tags": ["bolashak", "mine", "safety"],
    "timezone": "browser",
    "schemaVersion": 39,
    "version": 1,
    "refresh": "5s",
    "time": {"from": "now-30m", "to": "now"},
    "panels": panels,
    "templating": {"list": []},
    "annotations": {"list": []},
    "editable": True,
}

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bolashak.json")
with open(out, "w", encoding="utf-8", newline="\n") as f:
    json.dump(dashboard, f, ensure_ascii=False, indent=2)
print(f"wrote {out}: {len(panels)} panels")
