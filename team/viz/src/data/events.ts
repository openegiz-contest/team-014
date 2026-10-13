import { parseJson, prop, Thing } from "./store";

export type EventRow = { t: number; text: string; src: "Шахта" | "ПАЗ"; twin: string | null; alarm: boolean };

const ID_RE = /\b(?:fd|dv|esd|gs|fan|sub|lhd|truck|crew|refuge|charger|conveyor|crusher|depot|drill|bolter)-[a-z0-9-]*[a-z0-9]/g;
const ALARM_RE = /ОТКАЗ|Возгорание|недопустим|пострадал/i;

/** Twin that an event line is about: an id in the text, a PAZ command note, or a twin name. */
function matcher(things: Record<string, Thing>) {
  const names = Object.entries(things)
    .map(([n, t]) => [n, String(t.attributes?.name ?? "")] as const)
    .filter(([, s]) => s.length >= 8)
    .sort((a, b) => b[1].length - a[1].length);
  const cmds = parseJson<{ twin: string; note: string }[]>(prop(things, "paz", "commands"), []);
  return (text: string): string | null => {
    for (const m of text.match(ID_RE) ?? []) if (things[m]) return m;
    for (const c of cmds) if (c.note && text.includes(c.note) && things[c.twin]) return c.twin;
    for (const [n, s] of names) if (text.includes(s)) return n;
    return null;
  };
}

export function eventRows(things: Record<string, Thing>, limit = 60): EventRow[] {
  const match = matcher(things);
  const sim = parseJson<[number, string][]>(prop(things, "control", "events"), []).map(([t, e]) => ({ t, text: e, src: "Шахта" as const }));
  const paz = parseJson<[number, string][]>(prop(things, "paz", "log"), []).map(([t, e]) => ({ t, text: e, src: "ПАЗ" as const }));
  return [...sim, ...paz]
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map((r) => ({ ...r, twin: match(r.text), alarm: ALARM_RE.test(r.text) }));
}
