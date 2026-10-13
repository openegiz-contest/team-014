"""Core model of the Bolashak underground chromite mine (Donskoy GOK, Khromtau).

One source of truth for the mine layout, the physics (ventilation network,
fire and smoke, people, equipment) and the mapping to Eclipse Ditto twins.
Used by the simulator, the protection automation (PAZ) and the advisor.
"""

NAMESPACE = "bolashak"


def thing_id(name: str) -> str:
    return f"{NAMESPACE}:{name}"
