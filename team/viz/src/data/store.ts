import { useSyncExternalStore } from "react";

export const NS = "bolashak";

export type Props = Record<string, unknown> & { value?: unknown; unit?: string };
export type Feature = { properties?: Props; desiredProperties?: Props };
export type Thing = {
  thingId: string;
  attributes: Record<string, unknown>;
  features: Record<string, Feature>;
};

type Status = "loading" | "live" | "stale" | "error";

type Snapshot = {
  things: Record<string, Thing>;
  status: Status;
  lastUpdate: number;
  version: number;
  error?: string;
};

let snap: Snapshot = { things: {}, status: "loading", lastUpdate: 0, version: 0 };
const listeners = new Set<() => void>();
let pending = false;

function emit() {
  if (pending) return;
  pending = true;
  // coalesce bursts of twin events into at most ~4 renders per second
  setTimeout(() => {
    pending = false;
    snap = { ...snap, version: snap.version + 1 };
    listeners.forEach((l) => l());
  }, 250);
}

function deepMerge(dst: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    if (v === null) {
      delete dst[k];
    } else if (typeof v === "object" && !Array.isArray(v) && typeof dst[k] === "object" && dst[k] !== null && !Array.isArray(dst[k])) {
      deepMerge(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = v;
    }
  }
}

function nameOf(thingId: string) {
  return thingId.startsWith(NS + ":") ? thingId.slice(NS.length + 1) : thingId;
}

function applyThing(partial: Partial<Thing> & { thingId?: string }) {
  if (!partial.thingId || !partial.thingId.startsWith(NS + ":")) return;
  const name = nameOf(partial.thingId);
  const cur = snap.things[name] ?? { thingId: partial.thingId, attributes: {}, features: {} };
  deepMerge(cur as unknown as Record<string, unknown>, partial as Record<string, unknown>);
  snap.things[name] = cur;
  snap.lastUpdate = Date.now();
  if (snap.status !== "live") snap.status = "live";
  emit();
}

async function loadAll() {
  const items: Thing[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const opt = `size(200)${cursor ? `,cursor(${cursor})` : ""}`;
    const r = await fetch(`/api/2/search/things?namespaces=${NS}&option=${encodeURIComponent(opt)}`);
    if (!r.ok) throw new Error(`Ditto search HTTP ${r.status}`);
    const body = await r.json();
    items.push(...(body.items ?? []));
    if (!body.cursor) break;
    cursor = body.cursor;
  }
  for (const t of items) snap.things[nameOf(t.thingId)] = t;
  snap.lastUpdate = Date.now();
}

let es: EventSource | null = null;
let pollTimer: number | undefined;

function startStream() {
  es?.close();
  es = new EventSource(`/api/2/things?namespaces=${NS}`);
  es.onmessage = (ev) => {
    if (!ev.data) return;
    try {
      applyThing(JSON.parse(ev.data));
    } catch {
      /* keep-alive or non-JSON line */
    }
  };
  es.onerror = () => {
    snap.status = "stale";
    emit();
    if (!pollTimer) {
      pollTimer = window.setInterval(async () => {
        try {
          await loadAll();
          snap.status = "live";
          emit();
        } catch {
          snap.status = "error";
          emit();
        }
      }, 3000);
    }
  };
  es.onopen = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = undefined;
    }
  };
}

let started = false;

export function connect() {
  if (started) return;
  started = true;
  void open();
}

async function open() {
  try {
    await loadAll();
    if (Object.keys(snap.things).length < 50) {
      // twins are still being created by the setup job
      setTimeout(open, 3000);
      return;
    }
    snap.status = "live";
    emit();
  } catch (e) {
    snap.status = "error";
    snap.error = String(e);
    emit();
    setTimeout(open, 3000);
    return;
  }
  startStream();
  window.setInterval(() => {
    if (snap.status === "live" && Date.now() - snap.lastUpdate > 10000) {
      snap.status = "stale";
      emit();
    }
  }, 2000);
}

export function useStore() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snap,
  );
}

export function getSnapshot() {
  return snap;
}

export function prop<T = unknown>(things: Record<string, Thing>, name: string, feature: string, key = "value"): T | undefined {
  return things[name]?.features?.[feature]?.properties?.[key] as T | undefined;
}

export function attr<T = unknown>(things: Record<string, Thing>, name: string, key: string): T | undefined {
  return things[name]?.attributes?.[key] as T | undefined;
}

export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string") return fallback;
  try {
    const v = JSON.parse(raw);
    return (v ?? fallback) as T;
  } catch {
    return fallback;
  }
}

export async function putDesired(name: string, feature: string, props: Record<string, unknown>) {
  const r = await fetch(`/api/2/things/${NS}:${name}/features/${feature}/desiredProperties`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(props),
  });
  if (!r.ok && r.status !== 204) throw new Error(`Команда не принята: HTTP ${r.status}`);
}

export const CLOCK_OFFSET_S = 6 * 3600;

export function clock(simT: number | undefined, withSeconds = false) {
  if (simT === undefined || simT === null) return "--:--";
  const t = Math.max(0, simT + CLOCK_OFFSET_S);
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return withSeconds ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(h)}:${pad(m)}`;
}
