"""Layout of the modelled part of the Bolashak mine.

Coordinates are metres: x to the east, y to the north, z is the absolute
elevation. The surface is taken at +420 m so that the -480 m horizon lies
900 m below ground, as ERG publishes for this mine. The working horizons
-480, -560 and -640 (900-1060 m deep) are modelled; the drift layout is a
simplified schematic of the published "ring" of the Vostochny haulage drift
and the South-East drift (2,670 m), not a survey plan.

Every airway is an edge of the ventilation network. Equipment, sensors,
doors, valves and crews are placed on an airway at a fraction `s` of its
length (0 = `frm` node, 1 = `to` node) or at a node.
"""

import math

SURFACE_Z = 420.0
HORIZONS = {
    "h-480": {"z": -480.0, "name": "Горизонт -480 м (откаточный)", "depth_m": 900},
    "h-560": {"z": -560.0, "name": "Горизонт -560 м (добычной)", "depth_m": 980},
    "h-640": {"z": -640.0, "name": "Горизонт -640 м (добычной, дробление)", "depth_m": 1060},
}

# id: (name, x, y, z, horizon or None)
NODES = {
    "ATM": ("Атмосфера", 0.0, 0.0, SURFACE_Z + 40, None),
    "CS0": ("Клетевой ствол, устье", 0.0, 0.0, SURFACE_Z, None),
    "SS0": ("Скиповой ствол, устье", 90.0, -70.0, SURFACE_Z, None),
    "VS0": ("Северный вентиляционный ствол, ГВУ", 650.0, 1450.0, SURFACE_Z, None),
    # horizon -480
    "C480": ("Околоствольный двор клетевого ствола -480", 0.0, 0.0, -480.0, "h-480"),
    "S480": ("Сопряжение скипового ствола -480", 90.0, -70.0, -480.0, "h-480"),
    "E480": ("Восточный штрек, сопряжение с рампой -480", 720.0, 160.0, -480.0, "h-480"),
    "O480": ("Рудное тело «Миллионное» -480", 1350.0, 330.0, -480.0, "h-480"),
    "SE480": ("Юго-Восточный штрек -480", 820.0, -380.0, -480.0, "h-480"),
    "R480": ("Вентиляционный восстающий -480", 1250.0, 760.0, -480.0, "h-480"),
    "V480": ("Вентиляционный ствол, сопряжение -480", 650.0, 1450.0, -480.0, "h-480"),
    # horizon -560
    "C560": ("Околоствольный двор клетевого ствола -560", 0.0, 0.0, -560.0, "h-560"),
    "S560": ("Сопряжение скипового ствола -560", 90.0, -70.0, -560.0, "h-560"),
    "J560": ("Сопряжение рампы -560, камера-убежище", 700.0, 120.0, -560.0, "h-560"),
    "P560": ("Очистной участок «Алмаз-Жемчужина» -560", 1300.0, 280.0, -560.0, "h-560"),
    "B560": ("Зарядная камера аккумуляторной техники -560", 980.0, 520.0, -560.0, "h-560"),
    "R560": ("Вентиляционный восстающий -560", 1250.0, 760.0, -560.0, "h-560"),
    # horizon -640
    "C640": ("Околоствольный двор клетевого ствола -640", 0.0, 0.0, -640.0, "h-640"),
    "S640": ("Дозаторная скипового ствола -640", 90.0, -70.0, -640.0, "h-640"),
    "J640": ("Сопряжение рампы -640, дробильная камера, камера-убежище", 700.0, 100.0, -640.0, "h-640"),
    "P640": ("Очистной участок «Миллионное» -640", 1290.0, 260.0, -640.0, "h-640"),
    "D640": ("Подземный склад ГСМ -640", 520.0, 820.0, -640.0, "h-640"),
    "R640": ("Вентиляционный восстающий -640", 1250.0, 760.0, -640.0, "h-640"),
    "V640": ("Вентиляционный ствол, сопряжение -640", 650.0, 1450.0, -640.0, "h-640"),
}

# Atkinson friction factors alpha, kg/m3 (assumptions from mine ventilation
# textbooks: McPherson, "Subsurface Ventilation Engineering", table 5.1).
A_SHAFT_CAGE = 0.018   # concrete-lined shaft with buntons and cage
A_SHAFT_SKIP = 0.022   # skip shaft with skips and loading equipment
A_SHAFT_VENT = 0.006   # smooth concrete-lined upcast shaft, no fittings
A_DRIFT = 0.011        # arched steel sets with shotcrete (SCP-22 + concrete)
A_RAMP = 0.012
A_RAISE = 0.014        # bored/raw raise
A_CHAMBER = 0.010

# id: dict(frm, to, kind, name, area m2, alpha, length override, regulator R)
# kind: shaft | drift | ramp | raise | chamber | collar | fan
EDGES = {
    # surface links (virtual, not twins)
    "atm_cs": dict(frm="ATM", to="CS0", kind="collar", name="Устье клетевого ствола", area=60.0, alpha=0.0, length=10.0),
    "atm_ss": dict(frm="ATM", to="SS0", kind="collar", name="Устье скипового ствола", area=45.0, alpha=0.0, length=10.0, regulator=0.004),
    "fan": dict(frm="VS0", to="ATM", kind="fan", name="Главная вентиляторная установка", area=50.0, alpha=0.0, length=10.0),
    # cage shaft: main intake, people
    "cs_0_480": dict(frm="CS0", to="C480", kind="shaft", shaft="shaft-cage", name="Клетевой ствол, устье – -480", area=50.3, alpha=A_SHAFT_CAGE),
    "cs_480_560": dict(frm="C480", to="C560", kind="shaft", shaft="shaft-cage", name="Клетевой ствол, -480 – -560", area=50.3, alpha=A_SHAFT_CAGE),
    "cs_560_640": dict(frm="C560", to="C640", kind="shaft", shaft="shaft-cage", name="Клетевой ствол, -560 – -640", area=50.3, alpha=A_SHAFT_CAGE),
    # skip shaft: ore hoisting, secondary intake
    "ss_0_480": dict(frm="SS0", to="S480", kind="shaft", shaft="shaft-skip", name="Скиповой ствол, устье – -480", area=38.5, alpha=A_SHAFT_SKIP),
    "ss_480_560": dict(frm="S480", to="S560", kind="shaft", shaft="shaft-skip", name="Скиповой ствол, -480 – -560", area=38.5, alpha=A_SHAFT_SKIP),
    "ss_560_640": dict(frm="S560", to="S640", kind="shaft", shaft="shaft-skip", name="Скиповой ствол, -560 – -640", area=38.5, alpha=A_SHAFT_SKIP),
    # north ventilation shaft: return (upcast)
    "vs_640_480": dict(frm="V640", to="V480", kind="shaft", shaft="shaft-vent", name="Вентиляционный ствол, -640 – -480", area=50.3, alpha=A_SHAFT_VENT),
    "vs_480_0": dict(frm="V480", to="VS0", kind="shaft", shaft="shaft-vent", name="Вентиляционный ствол, -480 – устье", area=50.3, alpha=A_SHAFT_VENT),
    # horizon -480: the ring of the Vostochny and South-East drifts
    "d480_cs": dict(frm="C480", to="S480", kind="drift", horizon="h-480", name="Околоствольный квершлаг -480", area=26.0, alpha=A_DRIFT, regulator=0.05),
    "d480_c_e": dict(frm="C480", to="E480", kind="drift", horizon="h-480", name="Восточный откаточный штрек -480", area=26.0, alpha=A_DRIFT),
    "d480_e_o": dict(frm="E480", to="O480", kind="drift", horizon="h-480", name="Восточный откаточный штрек -480, рудная часть", area=26.0, alpha=A_DRIFT),
    "d480_s_se": dict(frm="S480", to="SE480", kind="drift", horizon="h-480", name="Юго-Восточный штрек -480", area=24.0, alpha=A_DRIFT),
    "d480_se_o": dict(frm="SE480", to="O480", kind="drift", horizon="h-480", name="Юго-Восточный штрек -480, рудная часть", area=24.0, alpha=A_DRIFT),
    "d480_o_r": dict(frm="O480", to="R480", kind="drift", horizon="h-480", name="Подготовительные выработки «Миллионное» -480", area=26.0, alpha=A_DRIFT, regulator=0.13),
    "d480_r_v": dict(frm="R480", to="V480", kind="drift", horizon="h-480", name="Вентиляционный штрек -480", area=28.0, alpha=A_DRIFT),
    # horizon -560
    "d560_cs": dict(frm="C560", to="S560", kind="drift", horizon="h-560", name="Околоствольный квершлаг -560", area=24.0, alpha=A_DRIFT, regulator=0.05),
    "d560_c_j": dict(frm="C560", to="J560", kind="drift", horizon="h-560", name="Откаточный штрек -560", area=26.0, alpha=A_DRIFT),
    "d560_j_p": dict(frm="J560", to="P560", kind="drift", horizon="h-560", name="Доставочный штрек «Алмаз-Жемчужина» -560", area=26.0, alpha=A_DRIFT),
    "d560_p_r": dict(frm="P560", to="R560", kind="drift", horizon="h-560", name="Вентиляционная сбойка -560", area=20.0, alpha=A_DRIFT, regulator=0.09),
    "d560_j_b": dict(frm="J560", to="B560", kind="chamber", horizon="h-560", name="Заезд в зарядную камеру -560", area=24.0, alpha=A_CHAMBER, regulator=0.8),
    "d560_b_r": dict(frm="B560", to="R560", kind="chamber", horizon="h-560", name="Исходящая зарядной камеры -560", area=16.0, alpha=A_CHAMBER),
    # horizon -640
    "d640_cs": dict(frm="C640", to="S640", kind="drift", horizon="h-640", name="Околоствольный квершлаг -640", area=24.0, alpha=A_DRIFT),
    "d640_c_j": dict(frm="C640", to="J640", kind="drift", horizon="h-640", name="Откаточный штрек -640", area=26.0, alpha=A_DRIFT, regulator=0.02),
    "d640_s_j": dict(frm="J640", to="S640", kind="drift", horizon="h-640", name="Конвейерный штрек -640 (дробилка – дозатор)", area=20.0, alpha=A_DRIFT, regulator=0.25),
    "d640_j_p": dict(frm="J640", to="P640", kind="drift", horizon="h-640", name="Доставочный штрек «Миллионное» -640", area=26.0, alpha=A_DRIFT),
    "d640_p_r": dict(frm="P640", to="R640", kind="drift", horizon="h-640", name="Вентиляционная сбойка -640", area=20.0, alpha=A_DRIFT, regulator=0.15),
    "d640_j_d": dict(frm="J640", to="D640", kind="chamber", horizon="h-640", name="Заезд на склад ГСМ -640", area=20.0, alpha=A_CHAMBER, regulator=3.5),
    "d640_d_v": dict(frm="D640", to="V640", kind="chamber", horizon="h-640", name="Обособленная исходящая склада ГСМ -640", area=14.0, alpha=A_CHAMBER),
    "d640_r_v": dict(frm="R640", to="V640", kind="drift", horizon="h-640", name="Вентиляционный штрек -640", area=24.0, alpha=A_DRIFT),
    # ramp and raises between horizons
    "ramp_640_560": dict(frm="J640", to="J560", kind="ramp", name="Рампа -640 – -560", area=26.0, alpha=A_RAMP, length=570.0),
    "ramp_560_480": dict(frm="J560", to="E480", kind="ramp", name="Рампа -560 – -480", area=26.0, alpha=A_RAMP, length=570.0),
    "rr_560_480": dict(frm="R560", to="R480", kind="raise", name="Вентиляционный восстающий -560 – -480", area=12.0, alpha=A_RAISE),
}


def node_xyz(nid):
    _, x, y, z, _ = NODES[nid]
    return x, y, z


def edge_length(eid):
    e = EDGES[eid]
    if "length" in e:
        return e["length"]
    x1, y1, z1 = node_xyz(e["frm"])
    x2, y2, z2 = node_xyz(e["to"])
    return math.dist((x1, y1, z1), (x2, y2, z2))


def edge_perimeter(eid):
    e = EDGES[eid]
    if e["kind"] == "shaft":
        return math.pi * math.sqrt(4 * e["area"] / math.pi)
    return 3.8 * math.sqrt(e["area"])


def edge_horizon(eid):
    e = EDGES[eid]
    if "horizon" in e:
        return e["horizon"]
    return None


def point_on_edge(eid, s):
    e = EDGES[eid]
    x1, y1, z1 = node_xyz(e["frm"])
    x2, y2, z2 = node_xyz(e["to"])
    return x1 + (x2 - x1) * s, y1 + (y2 - y1) * s, z1 + (z2 - z1) * s


AIRWAYS = [eid for eid, e in EDGES.items() if e["kind"] not in ("collar", "fan")]

# --- protection actuators ---------------------------------------------------

# Fire doors (противопожарные двери): normally open, closed by PAZ.
DOORS = {
    "fd-640-depot": dict(name="Противопожарная дверь склада ГСМ -640", edge="d640_j_d", s=0.08, normal="open", travel_s=30, r_closed=60.0),
    "fd-560-charge": dict(name="Противопожарная дверь зарядной камеры -560", edge="d560_j_b", s=0.08, normal="open", travel_s=30, r_closed=60.0),
    "fd-640-conv": dict(name="Противопожарная дверь конвейерного штрека -640", edge="d640_s_j", s=0.06, normal="open", travel_s=30, r_closed=60.0),
    "fd-480-east": dict(name="Противопожарная дверь Восточного штрека -480", edge="d480_c_e", s=0.05, normal="open", travel_s=40, r_closed=40.0),
    "fd-560-ramp": dict(name="Противопожарная дверь рампы -560", edge="ramp_560_480", s=0.04, normal="open", travel_s=40, r_closed=40.0),
}

# Valves: emergency shut-off of the fuel line, deluge/foam valves, fire main.
VALVES = {
    "esd-fuel-640": dict(name="Аварийный отсечной клапан топливопровода склада ГСМ", kind="esd", edge="d640_j_d", s=0.9, normal="open", travel_s=5, protects="D640"),
    "dv-640-depot": dict(name="Клапан пенного пожаротушения склада ГСМ", kind="deluge", edge="d640_j_d", s=0.95, normal="closed", travel_s=8, protects="D640"),
    "dv-560-charge": dict(name="Клапан водяной завесы зарядной камеры", kind="deluge", edge="d560_j_b", s=0.9, normal="closed", travel_s=8, protects="B560"),
    "dv-640-conv": dict(name="Клапан дренчерной завесы конвейера", kind="deluge", edge="d640_s_j", s=0.5, normal="closed", travel_s=8, protects="d640_s_j"),
}
FIRE_MAIN = dict(name="Пожарно-оросительный трубопровод", edge="cs_0_480", s=0.5, nominal_bar=12.0)

# Underground substations and what they feed (never the fan or drainage).
SUBSTATIONS = {
    "sub-480": dict(name="ЦПП -480", node="C480", feeds=["hoist-skip"]),
    "sub-560": dict(name="ПУПП -560 (зарядная камера)", node="J560", feeds=["charger-560"]),
    "sub-640": dict(name="ПУПП -640 (дробилка, конвейер)", node="J640", feeds=["crusher-640", "conveyor-640"]),
}

FANS = {
    "fan-1": dict(name="Вентилятор главного проветривания №1 (рабочий)", role="duty"),
    "fan-2": dict(name="Вентилятор главного проветривания №2 (резервный)", role="standby"),
}
# Fan pressure curve p = P0 - K*Q|Q| (Pa, m3/s): assumption calibrated for
# about 360 m3/s total, the order of magnitude of deep metal mines.
FAN_P0 = 3000.0
FAN_K = 0.0072
FAN_REV_P0 = 1800.0   # reversed rotation / dampers: lower pressure
FAN_REV_K = 0.0072
FAN_REVERSE_S = 240.0  # changeover time; Order 352 p.884 allows up to 600 s
FAN_START_S = 60.0
FAN_ETA = 0.80

# --- production equipment ---------------------------------------------------

# Epiroc Scooptram ST14 SG and Minetruck MT42 SG: data sheets 9869 0237 01b
# and 9869 0290 01b. Routes are node paths.
LHDS = {
    "lhd-01": dict(name="ПДМ Scooptram ST14 SG №1", model="Epiroc Scooptram ST14 SG", payload_t=14.0, battery_kwh=300.0,
                   route=["P560", "J560"], start_s=0.2),
    "lhd-02": dict(name="ПДМ Scooptram ST14 SG №2", model="Epiroc Scooptram ST14 SG", payload_t=14.0, battery_kwh=300.0,
                   route=["P640", "J640"], start_s=0.6),
    "lhd-03": dict(name="ПДМ Scooptram ST14 SG №3", model="Epiroc Scooptram ST14 SG", payload_t=14.0, battery_kwh=300.0,
                   route=["O480", "E480"], start_s=0.4),
}
TRUCKS = {
    "truck-01": dict(name="Самосвал Minetruck MT42 SG №1", model="Epiroc Minetruck MT42 SG", payload_t=42.0, battery_kwh=465.0,
                     route=["J560", "J640"], start_s=0.1),
    "truck-02": dict(name="Самосвал Minetruck MT42 SG №2", model="Epiroc Minetruck MT42 SG", payload_t=42.0, battery_kwh=465.0,
                     route=["J560", "J640"], start_s=0.6),
    "truck-03": dict(name="Самосвал Minetruck MT42 SG №3", model="Epiroc Minetruck MT42 SG", payload_t=42.0, battery_kwh=465.0,
                     route=["E480", "J560", "J640"], start_s=0.3),
}
# Below 20 % charge a vehicle drives empty to the swap bay of the charging
# chamber, swaps the battery (assumption: 10 min) and returns to its route.
SWAP_NODE = "B560"
BATTERY_SWAP_S = 600.0
DRILLS = {
    "drill-01": dict(name="Буровая установка Simba E70 S", model="Epiroc Simba E70 S", node="P640", edge="d640_j_p", s=0.92),
    "bolter-01": dict(name="Установка крепления Cabletec M10 S", model="Epiroc Cabletec M10 S", node="O480", edge="d480_o_r", s=0.15),
}
FIXED_PLANT = {
    "hoist-skip": dict(name="Скиповая подъёмная машина (автоматизированная)", kind="hoist", node="SS0", skip_t=30.0, cycle_s=100.0),
    "hoist-cage": dict(name="Клетевая подъёмная машина", kind="hoist", node="CS0", cage_people=40, cycle_s=300.0),
    "crusher-640": dict(name="Подземная дробилка -640", kind="crusher", node="J640", edge="d640_s_j", s=0.04, rated_tph=1200.0),
    "conveyor-640": dict(name="Ленточный конвейер -640", kind="conveyor", edge="d640_s_j", s=0.5, rated_tph=1200.0),
    "charger-560": dict(name="Зарядная станция аккумуляторной техники", kind="charger", edge="d560_j_b", s=0.85, power_kw=600.0),
    "depot-640": dict(name="Подземный склад ГСМ (масла, дизтопливо вспомогательной техники)", kind="depot", edge="d640_j_d", s=0.92, stock_m3=40.0),
}

# --- monitoring -------------------------------------------------------------

# Gas analysis stations (CO, smoke/visibility, temperature, air velocity).
SENSORS = {
    "gs-480-c": dict(edge="d480_c_e", s=0.12, name="Датчик-узел околоствольного двора -480"),
    "gs-480-e": dict(edge="d480_e_o", s=0.15, name="Датчик-узел Восточного штрека -480"),
    "gs-480-o": dict(edge="d480_o_r", s=0.5, name="Датчик-узел подготовительного участка -480"),
    "gs-480-se": dict(edge="d480_se_o", s=0.5, name="Датчик-узел Юго-Восточного штрека -480"),
    "gs-480-r": dict(edge="d480_r_v", s=0.5, name="Датчик-узел вентиляционного штрека -480"),
    "gs-560-c": dict(edge="d560_c_j", s=0.12, name="Датчик-узел откаточного штрека -560"),
    "gs-560-p": dict(edge="d560_j_p", s=0.8, name="Датчик-узел очистного участка -560"),
    "gs-560-b": dict(edge="d560_b_r", s=0.15, name="Датчик-узел исходящей зарядной камеры -560"),
    "gs-560-r": dict(edge="d560_p_r", s=0.8, name="Датчик-узел вентиляционной сбойки -560"),
    "gs-640-c": dict(edge="d640_c_j", s=0.12, name="Датчик-узел откаточного штрека -640"),
    "gs-640-conv": dict(edge="d640_s_j", s=0.3, name="Датчик-узел конвейерного штрека -640"),
    "gs-640-p": dict(edge="d640_j_p", s=0.8, name="Датчик-узел очистного участка -640"),
    "gs-640-d": dict(edge="d640_d_v", s=0.15, name="Датчик-узел исходящей склада ГСМ -640"),
    "gs-640-r": dict(edge="d640_r_v", s=0.5, name="Датчик-узел вентиляционного штрека -640"),
    "gs-ramp": dict(edge="ramp_640_560", s=0.2, name="Датчик-узел рампы -640 – -560"),
    "gs-vs": dict(edge="vs_480_0", s=0.95, name="Датчик-узел исходящей струи шахты (ГВУ)"),
}
# Order 352, appendix 20: maximum permissible CO is 0.0017 % by volume.
CO_PDK_PPM = 17.0
CO_ALARM_PPM = 50.0        # alarm setpoint (assumption)
SMOKE_ALARM_VIS_M = 10.0   # visibility below which the smoke channel alarms
TEMP_ALARM_C = 60.0

# --- people -----------------------------------------------------------------

CREWS = {
    "crew-01": dict(name="Бригада очистного участка -560", people=6, edge="d560_j_p", s=0.85),
    "crew-02": dict(name="Бригада бурения -640", people=4, edge="d640_j_p", s=0.88),
    "crew-03": dict(name="Проходческая бригада -480", people=5, edge="d480_o_r", s=0.2),
    "crew-04": dict(name="Электрослесари зарядной камеры -560", people=3, edge="d560_j_b", s=0.7),
    "crew-05": dict(name="Операторы дробилки и конвейера -640", people=3, edge="d640_s_j", s=0.2),
    "crew-06": dict(name="Слесари склада ГСМ -640", people=2, edge="d640_j_d", s=0.7),
    "crew-07": dict(name="Путевая бригада Восточного штрека -480", people=4, edge="d480_e_o", s=0.4),
    "crew-08": dict(name="Стволовые -560", people=2, edge="d560_c_j", s=0.05),
}
REFUGES = {
    "refuge-560": dict(name="Камера-убежище -560", node="J560", capacity=20, air_hours=36),
    "refuge-640": dict(name="Камера-убежище -640", node="J640", capacity=20, air_hours=36),
}
CAGE_STATIONS = ["C480", "C560", "C640"]
SELF_RESCUER_MIN = 50.0     # self-contained self-rescuer, nominal protective time
WALK_SPEED = 1.2            # m/s in clear air; reduced in smoke (Jin's data)

# --- fire scenarios (what-if) ----------------------------------------------

# HRR curves: t^2 growth to the peak, plateau, exponential decay. Peaks are
# anchored to Hansen & Ingason full-scale tests in a Swedish mine (2013):
# a loader peaked at 15.9 MW after 11 min, a drilling rig at 29.4 MW after
# 21 min. Battery, conveyor and depot values are assumptions documented in
# SUBMISSION.md.
FIRE_TYPES = {
    "bev_lhd": dict(name="Пожар ПДМ ST14 SG (тепловой разгон батареи)", edge="d560_j_p", s=0.62, vehicle="lhd-01",
                    peak_mw=16.0, t_peak_s=660.0, plateau_s=600.0, decay_s=900.0, co_yield=0.06, soot_yield=0.12,
                    suppress_factor=0.55, reignite=True),
    "bev_truck": dict(name="Пожар самосвала MT42 SG на рампе", edge="ramp_640_560", s=0.35, vehicle="truck-01",
                      peak_mw=22.0, t_peak_s=900.0, plateau_s=600.0, decay_s=1200.0, co_yield=0.06, soot_yield=0.12,
                      suppress_factor=0.6, reignite=True),
    "charger": dict(name="Пожар в зарядной камере (батарея на зарядке)", edge="d560_j_b", s=0.85, equipment="charger-560",
                    peak_mw=8.0, t_peak_s=480.0, plateau_s=900.0, decay_s=900.0, co_yield=0.05, soot_yield=0.10,
                    suppress_factor=0.35, powered_factor=1.6, deluge="dv-560-charge", power="sub-560"),
    "conveyor": dict(name="Пожар ленты конвейера -640", edge="d640_s_j", s=0.55, equipment="conveyor-640",
                     peak_mw=7.0, t_peak_s=1200.0, plateau_s=900.0, decay_s=900.0, co_yield=0.08, soot_yield=0.10,
                     suppress_factor=0.25, running_factor=2.0, deluge="dv-640-conv", power="sub-640"),
    "substation": dict(name="Пожар трансформатора ЦПП -480 у клетевого ствола", edge="d480_c_e", s=0.04,
                       equipment="sub-480", peak_mw=5.0, t_peak_s=600.0, plateau_s=1200.0, decay_s=900.0,
                       co_yield=0.07, soot_yield=0.11, suppress_factor=1.0, powered_factor=1.3, power="sub-480"),
    "depot": dict(name="Пожар склада ГСМ -640", edge="d640_j_d", s=0.92, equipment="depot-640",
                  peak_mw=25.0, t_peak_s=300.0, plateau_s=1200.0, decay_s=600.0, co_yield=0.04, soot_yield=0.14,
                  suppress_factor=0.3, fuel_valve="esd-fuel-640", deluge="dv-640-depot"),
}
ONBOARD_DETECT_S = 20.0       # on-board fire detection of a vehicle fires this long after ignition
HEAT_OF_COMBUSTION = 30.0e6   # J/kg, mixed rubber/oil/plastics (assumption)
CONVECTIVE_FRACTION = 0.7
SOOT_EXTINCTION = 8700.0      # m2/kg, mass specific extinction (SFPE handbook)
