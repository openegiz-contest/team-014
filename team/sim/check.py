#!/usr/bin/env python3
"""End-to-end check of the running Bolashak solution (`make mine-check`).

Static part: twins and hierarchy in Ditto, live simulation, telemetry in
InfluxDB through Grafana, the dashboard and the visualization. Dynamic part:
starts the bev_lhd what-if scenario through the control twin, waits for the
ПАЗ and the advisor to react, then returns the mine to normal."""

import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

from minecore import NAMESPACE, ditto, thing_id, twins

GRAFANA = os.environ.get("GRAFANA_URL", "http://grafana:3000")
GRAFANA_AUTH = "Basic " + base64.b64encode(f"admin:{os.environ.get('GRAFANA_ADMIN_PASSWORD', '')}".encode()).decode()
VIZ = os.environ.get("VIZ_URL", "http://bolashak-viz")
SCENARIO = os.environ.get("CHECK_SCENARIO", "bev_lhd")
STUDY = os.environ.get("CHECK_STUDY", "bev_lhd_blind")

failed = 0


def ok(msg):
    print(f"  ok    {msg}", flush=True)


def fail(msg):
    global failed
    failed += 1
    print(f"  FAIL  {msg}", flush=True)


def get(url, headers=None, body=None, timeout=20):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST" if body is not None else "GET",
                                 headers={"Content-Type": "application/json", **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        return resp.status, raw


def feature(things, name, feat, key="value"):
    try:
        return things[name]["features"][feat]["properties"].get(key)
    except (KeyError, TypeError, AttributeError):
        return None


def snapshot(names):
    return ditto.get_things(names)


def flux_count(thing, field, minutes=5):
    q = (f'from(bucket: "default") |> range(start: -{minutes}m) '
         f'|> filter(fn: (r) => r.thingId == "{thing_id(thing)}" and r._field == "{field}") |> count()')
    body = {"from": f"now-{minutes}m", "to": "now",
            "queries": [{"refId": "A", "datasource": {"type": "influxdb", "uid": "opentwins-influxdb"}, "query": q}]}
    _, raw = get(f"{GRAFANA}/api/ds/query", {"Authorization": GRAFANA_AUTH}, body)
    frames = json.loads(raw)["results"]["A"].get("frames", [])
    return sum(int(v) for fr in frames for v in (fr["data"]["values"][-1] if fr["data"]["values"] else []))


def check_static():
    defs = twins.definitions()
    print("Двойники в Ditto")
    _, items = ditto.http("GET", f"/api/2/search/things?namespaces={NAMESPACE}&fields=thingId&option=size(200)")
    found = {t["thingId"].split(":", 1)[1] for t in items.get("items", [])}
    missing = sorted(set(defs) - found)
    if not missing:
        ok(f"все {len(defs)} двойников шахты созданы (namespace {NAMESPACE})")
    else:
        fail(f"нет двойников: {', '.join(missing[:10])}")
    things = snapshot(defs)
    orphans = [n for n, t in things.items()
               if n != "mine" and t.get("attributes", {}).get("_parents", "").split(":", 1)[-1] not in things]
    if not orphans:
        ok("иерархия: у каждого двойника есть родитель (_parents), корень — bolashak:mine")
    else:
        fail(f"двойники без родителя: {', '.join(orphans[:10])}")

    print("Симулятор")
    t0 = feature(things, "mine", "sim_time")
    time.sleep(4)
    things = snapshot(["mine", "gvu", "control", "paz", "advisor"])
    t1 = feature(things, "mine", "sim_time")
    if isinstance(t0, (int, float)) and isinstance(t1, (int, float)) and t1 > t0:
        ok(f"модельное время идёт: {t0:.0f} → {t1:.0f} с")
    else:
        fail(f"модельное время не меняется ({t0} → {t1})")
    q = feature(things, "gvu", "airflow")
    if isinstance(q, (int, float)) and 250 <= q <= 450:
        ok(f"ГВУ подаёт {q:.0f} м³/с (расчёт вентсети)")
    else:
        fail(f"расход ГВУ вне ожидаемого диапазона: {q}")
    total = feature(things, "mine", "people_total")
    if isinstance(total, (int, float)) and total > 0:
        ok(f"в смене {total:.0f} чел., позиционирование работает")
    else:
        fail("нет данных о людях в шахте")

    print("Модули")
    for name, label in (("paz", "ПАЗ"), ("advisor", "советчик")):
        state = feature(things, name, "state")
        if state:
            ok(f"{label} на связи, состояние: {state}")
        else:
            fail(f"{label} не публикует состояние")

    print("Телеметрия и Grafana")
    try:
        n = flux_count("mine", "value_sim_time_properties_value", 3)
        if n > 0:
            ok(f"Ditto → Telegraf → InfluxDB: {n} точек по шахте за 3 мин")
        else:
            fail("в InfluxDB нет свежих данных по bolashak:mine")
        get(f"{GRAFANA}/api/dashboards/uid/bolashak-mine", {"Authorization": GRAFANA_AUTH})
        ok("дашборд «Шахта Болашак» загружен в Grafana")
    except (urllib.error.URLError, OSError, KeyError, ValueError) as exc:
        fail(f"Grafana: {exc}")

    print("Визуализация")
    try:
        get(f"{VIZ}/healthz")
        _, raw = get(f"{VIZ}/")
        ok("веб-интерфейс диспетчера отвечает" if b"<div id=\"root\"" in raw else "веб-интерфейс отвечает")
        _, raw = get(f"{VIZ}/api/2/things?ids={thing_id('mine')}")
        if json.loads(raw):
            ok("интерфейс читает двойников через прокси Ditto")
        else:
            fail("прокси Ditto в интерфейсе вернул пустой ответ")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        fail(f"визуализация: {exc}")


def set_scenario(value, seq):
    ditto.http("PUT", f"/api/2/things/{thing_id('control')}/features/scenario/desiredProperties",
               {"value": value, "faults": [], "seq": seq, "by": "mine-check"})


def check_scenario():
    print(f"Сценарий what-if: {SCENARIO}")
    names = ["mine", "control", "paz", "advisor"]
    things = snapshot(names)
    seq = int(feature(things, "control", "scenario", "seq") or 0) + 1
    paz_mode = feature(things, "paz", "mode") or "auto"
    set_scenario(SCENARIO, seq)
    started = paz_done = adv_done = False
    deadline = time.time() + 150
    while time.time() < deadline and not (paz_done and adv_done):
        time.sleep(3)
        things = snapshot(names)
        if not started and feature(things, "control", "scenario") == SCENARIO and \
                feature(things, "control", "scenario", "seq") == seq:
            started = True
            ok("симулятор принял сценарий через двойник bolashak:control")
        pstate = feature(things, "paz", "state")
        if not paz_done and pstate in ("completed", "acting", "awaiting_dispatcher", "fault"):
            if pstate == "completed" or (paz_mode == "manual" and pstate == "awaiting_dispatcher"):
                paz_done = True
                pos = things["paz"]["features"].get("position", {}).get("properties", {})
                ok(f"ПАЗ: сигнал {feature(things, 'paz', 'trigger')}, {pos.get('title') or pos.get('value')}, "
                   f"состояние {pstate}, отработка {feature(things, 'paz', 'response_time')} с")
        if not adv_done and feature(things, "advisor", "state") == "forecast":
            adv_done = True
            ok(f"советчик: {feature(things, 'advisor', 'recommendation')}")
            check_options(feature(things, "advisor", "options"))
    if not started:
        fail("симулятор не принял сценарий")
    if not paz_done:
        fail(f"ПАЗ не отработал за 150 с (состояние {feature(things, 'paz', 'state')})")
    if not adv_done:
        fail("советчик не выдал прогноз за 150 с")
    emergency = feature(things, "mine", "emergency")
    if emergency in ("alarm", "evacuation"):
        ok(f"режим шахты: {emergency}, в безопасности {feature(things, 'mine', 'people_safe')} из "
           f"{feature(things, 'mine', 'people_total')} чел.")

    set_scenario("normal", seq + 1)
    deadline = time.time() + 60
    back = False
    while time.time() < deadline:
        time.sleep(3)
        things = snapshot(names)
        if not back and feature(things, "control", "scenario") == "normal" and \
                feature(things, "mine", "emergency") == "normal":
            back = True
            ok("шахта возвращена в штатный режим")
        cleared = (feature(things, "advisor", "state") == "normal"
                   and feature(things, "advisor", "best_option") == "none"
                   and feature(things, "advisor", "fire_location") == "none"
                   and feature(things, "advisor", "options") == "[]"
                   and feature(things, "advisor", "proposal") == "none")
        if back and cleared:
            ok("советчик сброшен: нет прогноза, лучшего варианта, очага и предложения для ПАЗ")
            return
    if not back:
        fail("шахта не вернулась в штатный режим за 60 с")
    else:
        fail(f"советчик не сброшен после возврата в норму: состояние {feature(things, 'advisor', 'state')}, "
             f"лучший вариант {feature(things, 'advisor', 'best_option')}, "
             f"очаг {feature(things, 'advisor', 'fire_location')}")


def check_options(raw):
    try:
        options = {o["option"]: o for o in json.loads(raw or "[]")}
    except (TypeError, ValueError, KeyError):
        fail("варианты советчика не читаются как JSON")
        return
    missing = [k for k in ("no_paz", "no_new", "normal", "reverse") if k not in options]
    if missing:
        fail(f"у советчика нет вариантов: {', '.join(missing)}")
        return
    bare = [k for k, o in options.items() if not o.get("series")]
    if bare:
        fail(f"у вариантов нет временного ряда: {', '.join(bare)}")
        return
    base, now = options["no_paz"], options["no_new"]
    ok(f"советчик сравнивает с базой: «без ПАЗ» {base['people_safe']}/{base['people_total']} в безопасности, "
       f"FED {base['max_fed']}; «без новых действий» {now['people_safe']}/{now['people_total']}, FED {now['max_fed']}; "
       f"ряд {len(base['series'])} точек")


def check_study():
    """The bench replays a scenario with the protection in auto, manual and off.
    The showcase case must actually endanger people, or it shows nothing."""
    print(f"Стенд сравнения: {STUDY}")
    key, _, fl = STUDY.partition(":")
    faults = [f for f in fl.split(",") if f]
    things = snapshot(["control", "advisor"])
    asked = things["control"].get("features", {}).get("study", {}).get("desiredProperties", {}).get("seq")
    seq = max(int(feature(things, "advisor", "study", "seq") or 0), int(asked or 0)) + 1
    ditto.http("PUT", f"/api/2/things/{thing_id('control')}/features/study/desiredProperties",
               {"value": key, "scenario": key, "faults": faults, "seq": seq, "by": "mine-check"})
    deadline = time.time() + 180
    while time.time() < deadline:
        time.sleep(3)
        st = snapshot(["advisor"])["advisor"]["features"].get("study", {}).get("properties", {})
        if st.get("seq") != seq or st.get("value") not in ("done", "error"):
            continue
        if st["value"] == "error":
            fail(f"стенд: {st.get('message')}")
            return
        runs = {r["mode"]: r for r in json.loads(st.get("runs") or "[]")}
        if not {"auto", "manual", "off"} <= set(runs):
            fail(f"стенд вернул режимы {sorted(runs)}")
            return
        ok(f"стенд: {len(runs)} прогона за {st.get('compute_time')} с")
        for mode in runs:
            r = runs[mode]
            ok(f"  {mode:6} обнаружение {r['detected_at']} с, позиция {r['position']}, в безопасности "
               f"{r['people_safe']}/{r['people_total']}, под угрозой до {r['people_at_risk_max']}, FED {r['max_fed']}")
        a = runs["auto"]
        if a["people_at_risk_max"] > 0 or a["max_fed"] >= 0.3:
            ok("в показательном сценарии люди в опасности даже при автоматической ПАЗ")
        else:
            fail("показательный сценарий никого не подвергает опасности")
        return
    fail("стенд не ответил за 180 с")


def main():
    if not ditto.wait_for_ditto(30):
        print("Ditto недоступен")
        return 1
    check_static()
    if "--static" not in sys.argv:
        check_scenario()
        check_study()
    print()
    print("Проверка пройдена." if not failed else f"Проверка НЕ пройдена: {failed} ошибок.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
