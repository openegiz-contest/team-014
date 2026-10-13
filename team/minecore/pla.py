"""Positions of the emergency response plan (ПЛА) as data.

Each position says which signals start it and which commands the
protection system issues: shut-off and deluge valves, fire doors, power
cuts, plant stops, the ventilation mode and the evacuation zone. The
protection module executes them; the advisor audits them against forecasts.
"""

POSITIONS = [
    dict(id="P1", title="Поз. 1. Пожар склада ГСМ -640",
         sensors=["gs-640-d"], vehicles=[],
         actions=[("esd-fuel-640", "position", "closed", "закрыть отсечной клапан топливопровода"),
                  ("dv-640-depot", "position", "open", "включить пенное пожаротушение склада"),
                  ("fd-640-depot", "position", "closed", "закрыть противопожарную дверь склада")],
         ventilation="normal", evacuation="all"),
    dict(id="P2", title="Поз. 2. Пожар в зарядной камере -560",
         sensors=["gs-560-b"], vehicles=[],
         actions=[("sub-560", "power", "off", "снять напряжение с зарядной камеры"),
                  ("dv-560-charge", "position", "open", "включить водяную завесу"),
                  ("fd-560-charge", "position", "closed", "закрыть противопожарную дверь камеры")],
         ventilation="normal", evacuation="all"),
    dict(id="P3", title="Поз. 3. Пожар конвейерного штрека -640",
         sensors=["gs-640-conv"], vehicles=[],
         actions=[("conveyor-640", "command", "stop", "остановить конвейер"),
                  ("crusher-640", "command", "stop", "остановить дробилку"),
                  ("sub-640", "power", "off", "снять напряжение с конвейера и дробилки"),
                  ("dv-640-conv", "position", "open", "включить дренчерную завесу"),
                  ("fd-640-conv", "position", "closed", "закрыть противопожарную дверь штрека")],
         ventilation="normal", evacuation="all"),
    dict(id="P4", title="Поз. 4. Пожар самоходной техники на очистных участках",
         sensors=["gs-560-p", "gs-640-p", "gs-480-o"], vehicles=["lhd-01", "lhd-02", "lhd-03"],
         actions=[], ventilation="normal", evacuation="all"),
    dict(id="P5", title="Поз. 5. Пожар самосвала на рампе",
         sensors=["gs-ramp"], vehicles=["truck-01", "truck-02", "truck-03"],
         actions=[], ventilation="normal", evacuation="all"),
    dict(id="P6", title="Поз. 6. Пожар в околоствольном дворе -480 (свежая струя)",
         sensors=["gs-480-c"], vehicles=[],
         actions=[("sub-480", "power", "off", "снять напряжение с ЦПП -480")],
         ventilation="reverse", evacuation="all"),
]

# generic position for an alarm that no specific position covers
GENERIC = dict(id="P0", title="Поз. 0. Аварийная загазованность / задымление", actions=[],
               ventilation="normal", evacuation="all")

FAN_TRIP = dict(id="P7", title="Поз. 7. Аварийная остановка вентилятора главного проветривания",
                standby_start_s=120.0, evacuate_after_s=600.0)


FIRE_POSITION = {"depot": "P1", "charger": "P2", "conveyor": "P3", "bev_lhd": "P4", "bev_truck": "P5",
                 "substation": "P6"}


def for_fire(fire_type):
    """Plan position for a located fire of the given type."""
    pid = FIRE_POSITION.get(fire_type)
    return next((p for p in POSITIONS if p["id"] == pid), None)


def match(alarmed_sensors, alarmed_vehicles):
    """First position whose vehicles or sensors are in alarm."""
    for p in POSITIONS:
        if any(v in alarmed_vehicles for v in p["vehicles"]):
            return p
    for p in POSITIONS:
        if any(s in alarmed_sensors for s in p["sensors"]):
            return p
    if alarmed_sensors:
        return GENERIC
    return None
