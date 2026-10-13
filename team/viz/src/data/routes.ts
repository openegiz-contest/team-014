import { Airway, HORIZONS, namesOfKind, XYZ } from "./geometry";
import { attr, prop, Thing } from "./store";

const WALKABLE = new Set(["drift", "chamber", "ramp"]);
const CAGE_STATIONS = ["C480", "C560", "C640"];
const CO_CAGE_LIMIT = 50;

export type EvacRoute = {
  crew: string;
  people: number;
  state: string;
  points: XYZ[];
  /** airway edges with the walking direction, for the per-horizon mnemonic */
  legs: { aw: Airway; s0: number; s1: number }[];
  target: string;
  targetLabel: string;
  key: string;
};

type Adj = Map<string, { to: string; aw: Airway }[]>;

function nodeXYZ(aws: Airway[]) {
  const m = new Map<string, XYZ>();
  for (const a of aws) {
    m.set(a.frm, a.a);
    m.set(a.to, a.b);
  }
  return m;
}

function horizonLabel(z: number) {
  return HORIZONS.find((h) => Math.abs(h.z - z) < 1)?.label ?? `${z} м`;
}

/** CO at a node: the gas station on an adjacent airway that is closest to the node. */
function nodeCo(things: Record<string, Thing>, aws: Airway[], node: string) {
  let best: { d: number; co: number } | null = null;
  for (const gs of namesOfKind(things, "gas-station")) {
    const awName = String(attr(things, gs, "airway") ?? "").split(":")[1];
    const aw = aws.find((a) => a.id === awName);
    if (!aw || (aw.frm !== node && aw.to !== node)) continue;
    const s = Number(attr(things, gs, "s") ?? 0.5);
    const d = (aw.frm === node ? s : 1 - s) * aw.length;
    const co = Number(prop(things, gs, "co") ?? 0);
    if (!best || d < best.d) best = { d, co };
  }
  return best?.co ?? 0;
}

/**
 * Exit routes of the crews during an emergency. The positioning twins publish
 * where each crew is; the route is the shortest walk along drifts, chambers and
 * ramps to the nearest cage station with breathable air or a refuge chamber,
 * avoiding airways that the twins report as smoke-logged (CO over 100 ppm or
 * visibility under 5 m), the same rule the mine model uses for people.
 */
export function evacRoutes(things: Record<string, Thing>, aws: Airway[]): EvacRoute[] {
  const emergency = String(prop(things, "mine", "emergency") ?? "normal");
  const ordered = String(prop(things, "mine", "evacuation") ?? "none") !== "none";
  if (emergency === "normal" && !ordered) return [];
  const walk = aws.filter((a) => WALKABLE.has(a.kind));
  if (!walk.length) return [];
  const adj: Adj = new Map();
  const add = (n: string, e: { to: string; aw: Airway }) => {
    if (!adj.has(n)) adj.set(n, []);
    adj.get(n)!.push(e);
  };
  const weight = new Map<string, number>();
  for (const a of walk) {
    add(a.frm, { to: a.to, aw: a });
    add(a.to, { to: a.frm, aw: a });
    const co = Number(prop(things, a.id, "co_max") ?? 0);
    const vis = Number(prop(things, a.id, "visibility_min") ?? 50);
    weight.set(a.id, a.length * (co > 100 || vis < 5 ? 25 : 1));
  }
  const xyz = nodeXYZ(aws);
  const targets = new Map<string, string>();
  if (prop(things, "hoist-cage", "state") !== "out_of_service") {
    for (const n of CAGE_STATIONS) {
      if (xyz.has(n) && nodeCo(things, aws, n) < CO_CAGE_LIMIT) targets.set(n, `Клетевой ствол ${horizonLabel(xyz.get(n)![2])}`);
    }
  }
  for (const r of namesOfKind(things, "refuge")) {
    const node = String(attr(things, r, "node") ?? "");
    if (xyz.has(node)) targets.set(node, `Убежище ${horizonLabel(xyz.get(node)![2])}`);
  }
  if (!targets.size) return [];

  const out: EvacRoute[] = [];
  for (const crew of namesOfKind(things, "crew")) {
    const state = String(prop(things, crew, "state") ?? "working");
    if (!(state === "evacuating" || (state === "working" && ordered))) continue;
    const loc = things[crew]?.features?.location?.properties as Record<string, unknown> | undefined;
    const aw = walk.find((a) => a.edge === String(loc?.airway ?? loc?.value ?? ""));
    if (!aw || typeof loc?.x !== "number") continue;
    const s = Number(loc.s ?? 0);
    const here: XYZ = [Number(loc.x), Number(loc.y), Number(loc.z)];

    const dist = new Map<string, number>([[aw.frm, s * weight.get(aw.id)!], [aw.to, (1 - s) * weight.get(aw.id)!]]);
    const prev = new Map<string, { from: string; aw: Airway }>();
    const done = new Set<string>();
    let goal: string | null = null;
    for (;;) {
      let n: string | null = null;
      let dn = Infinity;
      for (const [k, d] of dist) if (!done.has(k) && d < dn) { n = k; dn = d; }
      if (n === null) break;
      if (targets.has(n)) { goal = n; break; }
      done.add(n);
      for (const e of adj.get(n) ?? []) {
        const nd = dn + weight.get(e.aw.id)!;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, { from: n, aw: e.aw });
        }
      }
    }
    if (!goal) continue;
    const nodes: string[] = [goal];
    const edges: Airway[] = [];
    while (prev.has(nodes[0])) {
      const p = prev.get(nodes[0])!;
      edges.unshift(p.aw);
      nodes.unshift(p.from);
    }
    const first = nodes[0];
    const legs: EvacRoute["legs"] = [{ aw, s0: s, s1: aw.frm === first ? 0 : 1 }];
    edges.forEach((e, i) => legs.push({ aw: e, s0: e.frm === nodes[i] ? 0 : 1, s1: e.frm === nodes[i] ? 1 : 0 }));
    const points: XYZ[] = [here, ...nodes.map((n) => xyz.get(n)!)];
    out.push({
      crew,
      people: Number(prop(things, crew, "people") ?? 0),
      state,
      points,
      legs,
      target: goal,
      targetLabel: targets.get(goal)!,
      key: `${crew}:${aw.edge}:${nodes.join(">")}`,
    });
  }
  return out;
}
