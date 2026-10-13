import { attr, prop, Thing } from "./store";

export type XYZ = [number, number, number];

export type Airway = {
  id: string;          // twin name, e.g. aw-d560_j_p
  edge: string;        // d560_j_p
  name: string;
  kind: string;
  horizon: string | null;
  frm: string;
  to: string;
  a: XYZ;
  b: XYZ;
  length: number;
  area: number;
  cells: number;
};

export const HORIZONS = [
  { id: "h-480", z: -480, label: "−480 м" },
  { id: "h-560", z: -560, label: "−560 м" },
  { id: "h-640", z: -640, label: "−640 м" },
];

export const SURFACE_Z = 420;

/** Vertical scale is conditional: the 900 m of shafts above the -480
 * horizon are compressed, the 160 m between working horizons stretched. */
export function worldY(z: number) {
  return z >= -480 ? (z + 480) * 0.14 : (z + 480) * 1.15;
}

export function toWorld([x, y, z]: XYZ): XYZ {
  return [x * 0.5 - 330, worldY(z), -y * 0.5 + 180];
}

export function airways(things: Record<string, Thing>): Airway[] {
  const out: Airway[] = [];
  for (const [name, t] of Object.entries(things)) {
    if (t.attributes?.kind !== "airway") continue;
    const a = t.attributes.frm_xyz as XYZ | undefined;
    const b = t.attributes.to_xyz as XYZ | undefined;
    if (!a || !b) continue;
    const length = Number(t.attributes.length_m ?? 0);
    const parent = String(t.attributes._parents ?? "");
    out.push({
      id: name,
      edge: name.slice(3),
      name: String(t.attributes.name ?? name),
      kind: String(t.attributes.airway_kind ?? "drift"),
      horizon: parent.includes(":h-") ? parent.split(":")[1] : null,
      frm: String(t.attributes.frm ?? ""),
      to: String(t.attributes.to ?? ""),
      a,
      b,
      length,
      area: Number(t.attributes.area_m2 ?? 20),
      cells: Math.max(1, Math.min(30, Math.round(length / 40))),
    });
  }
  return out.sort((p, q) => p.id.localeCompare(q.id));
}

export function pointOn(aw: Airway, s: number): XYZ {
  return [aw.a[0] + (aw.b[0] - aw.a[0]) * s, aw.a[1] + (aw.b[1] - aw.a[1]) * s, aw.a[2] + (aw.b[2] - aw.a[2]) * s];
}

export function smokeCells(things: Record<string, Thing>, aw: Airway): number[] {
  const raw = prop<string>(things, aw.id, "smoke");
  if (!raw) return new Array(aw.cells).fill(0);
  const v = raw.split(",").map(Number);
  return v.length ? v : new Array(aw.cells).fill(0);
}

export function placeOf(things: Record<string, Thing>, name: string): XYZ | null {
  const t = things[name];
  if (!t) return null;
  const loc = t.features?.location?.properties as Record<string, number> | undefined;
  if (loc && typeof loc.x === "number") return [loc.x, loc.y, loc.z];
  const x = attr<number>(things, name, "x");
  if (typeof x === "number") return [x, attr<number>(things, name, "y") ?? 0, attr<number>(things, name, "z") ?? 0];
  const wp = t.attributes?.workplace as Record<string, number> | undefined;
  if (wp && typeof wp.x === "number") return [wp.x, wp.y, wp.z];
  return null;
}

export type FireTruth = { type?: string; airway: string; s: number; hrr_mw: number; extinct: boolean; t?: number };

export type FireSpot = { aw: Airway; s: number; xyz: XYZ; horizon: string; hrr: number };

export function horizonOfZ(z: number) {
  return HORIZONS.reduce((b, h) => (Math.abs(h.z - z) < Math.abs(b.z - z) ? h : b)).id;
}

/** The burning spot from the scenario twin (`control.fire_truth`), if a fire is active. */
export function fireSpot(things: Record<string, Thing>, aws: Airway[]): FireSpot | null {
  const raw = prop<string>(things, "control", "fire_truth");
  if (typeof raw !== "string") return null;
  let f: FireTruth | null = null;
  try {
    f = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!f || f.extinct || !(f.hrr_mw > 0.05)) return null;
  const aw = aws.find((a) => a.edge === f!.airway);
  if (!aw) return null;
  const xyz = pointOn(aw, f.s);
  return { aw, s: f.s, xyz, horizon: aw.horizon ?? horizonOfZ(xyz[2]), hrr: f.hrr_mw };
}

export function kindOf(things: Record<string, Thing>, name: string) {
  return String(things[name]?.attributes?.kind ?? "");
}

export function namesOfKind(things: Record<string, Thing>, ...kinds: string[]) {
  return Object.keys(things)
    .filter((n) => kinds.includes(kindOf(things, n)))
    .sort();
}
