import { CSSProperties, KeyboardEvent, ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Airway, airways, fireSpot, HORIZONS, namesOfKind, placeOf, pointOn, smokeCells } from "../data/geometry";
import { prop, useStore } from "../data/store";
import { COLORS, crewColor, fmt, sensorColor, smokeColor } from "../data/status";
import { evacRoutes } from "../data/routes";
import { declutter, LabelIn, Rect } from "../data/declutter";

const NODE_NAMES: Record<string, string> = {
  C: "Клетевой ствол",
  S: "Скиповой ствол",
  V: "Вентствол",
  R: "Восстающий",
  J560: "Сопряжение рампы",
  J640: "Сопряжение рампы, дробилка",
  P560: "Очистной участок",
  P640: "Очистной участок",
  B560: "Зарядная камера",
  D640: "Склад ГСМ",
  O480: "Рудное тело",
  E480: "Рампа",
  SE480: "ЮВ штрек",
};

const REVERSE_ARROW = "#ffcf66";

function nodeName(id: string) {
  return NODE_NAMES[id] ?? NODE_NAMES[id.replace(/\d+$/, "")] ?? id;
}

type Props = { horizon: string; selected: string | null; onSelect: (n: string | null) => void };

function keyAct(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

/** px/py: preferred centre offset; startX: preferred offset of the left edge instead of px */
type Lbl = { id: string; text: string; ax: number; ay: number; fs: number; cls: string; priority: number; px?: number; py?: number; startX?: number; mono?: boolean };

export function Mnemonic({ horizon, selected, onSelect }: Props) {
  const { things } = useStore();
  const count = Object.keys(things).length;
  const aws = useMemo(() => airways(things), [count]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = HORIZONS.find((x) => x.id === horizon)!;
  const onLevel = (a: Airway) => a.horizon === horizon;
  const level = aws.filter(onLevel);
  const links = aws.filter((a) => !onLevel(a) && a.kind !== "shaft" && (a.a[2] === h.z || a.b[2] === h.z));
  const shafts = aws.filter((a) => a.kind === "shaft" && (a.a[2] === h.z || a.b[2] === h.z));
  const nodes = new Map<string, [number, number]>();
  for (const a of level) {
    nodes.set(a.frm, [a.a[0], -a.a[1]]);
    nodes.set(a.to, [a.b[0], -a.b[1]]);
  }
  const inLevel = (p: [number, number, number] | null) => p && Math.abs(p[2] - h.z) < 1;
  const spot = fireSpot(things, aws);
  const fireHere = spot && spot.horizon === horizon ? spot : null;
  const reversed = prop(things, "gvu", "mode") === "reverse";
  const routes = evacRoutes(things, aws);
  const prevOff = useRef(new Map<string, [number, number]>());

  const [compact, setCompact] = useState(false);
  const pts: [number, number][] = [...nodes.values()];
  for (const a of links) {
    const p = a.a[2] === h.z ? a.a : a.b;
    const q = a.a[2] === h.z ? a.b : a.a;
    pts.push([p[0] + (q[0] - p[0]) * 0.35, -(p[1] + (q[1] - p[1]) * 0.35)]);
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const vb = pts.length
    ? [Math.min(...xs) - 160, Math.min(...ys) - 160, Math.max(...xs) - Math.min(...xs) + (compact ? 900 : 600), Math.max(...ys) - Math.min(...ys) + 340]
    : [-160, -1560, 1700, 2040];
  const viewBox = vb.join(" ");
  const svgRef = useRef<SVGSVGElement>(null);
  const [u, setU] = useState(1);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setU(1 / Math.min(width / vb[2], height / vb[3]));
      setCompact(width < 560);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [viewBox]); // eslint-disable-line react-hooks/exhaustive-deps

  const item = (name: string, label: string) => ({
    role: "button",
    tabIndex: 0,
    "aria-label": label,
    "aria-pressed": selected === name,
    onClick: () => onSelect(name),
    onKeyDown: keyAct(() => onSelect(name)),
    className: `mn-item${selected === name ? " is-selected" : ""}`,
  });

  const fsNode = Math.max(30, (compact ? 12 : 15) * u);
  const fsAlarm = Math.max(28, 14 * u);
  const fsSmall = Math.max(24, 13 * u);
  const labels: Lbl[] = [];
  const obstacles: Rect[] = [];
  const box = (x: number, y: number, w: number, hh: number) => obstacles.push({ x: x - w / 2, y: y - hh / 2, w, h: hh });

  // ---- shapes ----
  const linkEls = links.map((a, i) => {
    const onA = a.a[2] === h.z;
    const p = onA ? a.a : a.b;
    const q = onA ? a.b : a.a;
    const mx = p[0] + (q[0] - p[0]) * 0.35;
    const my = p[1] + (q[1] - p[1]) * 0.35 + (a.kind === "ramp" ? 90 : 0);
    if (!compact) labels.push({ id: `link-${i}`, text: `${a.kind === "ramp" ? "рампа" : "восстающий"} к ${q[2] > h.z ? "верхнему" : "нижнему"} горизонту`, ax: mx, ay: -my, fs: fsSmall, cls: "mn-note", priority: 1, px: 0, py: fsSmall });
    return <line key={a.id} x1={p[0]} y1={-p[1]} x2={mx} y2={-my} stroke={COLORS.airDim} strokeWidth={10} strokeDasharray="18 12" />;
  });

  const airwayEls = level.map((a) => {
    const cells = smokeCells(things, a);
    const n = cells.length;
    const v = Number(prop(things, a.id, "velocity") ?? 0);
    const mid = pointOn(a, 0.5);
    const ang = (Math.atan2(-(a.b[1] - a.a[1]), a.b[0] - a.a[0]) * 180) / Math.PI + (v < 0 ? 180 : 0);
    const width = Math.sqrt(a.area) * 3.2;
    const flows = Math.abs(v) > 0.08;
    if (flows && !compact) labels.push({ id: `flow-${a.id}`, text: `${Math.abs(v).toFixed(1)} м/с`, ax: mid[0], ay: -mid[1], fs: fsSmall, cls: "mn-flow", priority: 2, py: -(fsSmall + 10), mono: true });
    if (flows) box(mid[0], -mid[1], 36, 28);
    return (
      <g key={a.id} {...item(a.id, `${a.name}: ${Math.abs(v).toFixed(1)} м/с`)}>
        <line x1={a.a[0]} y1={-a.a[1]} x2={a.b[0]} y2={-a.b[1]} stroke="transparent" strokeWidth={40} />
        {cells.map((s, i) => {
          if (s <= 0.04) return null;
          const p = pointOn(a, i / n);
          const q = pointOn(a, (i + 1) / n);
          return <line key={`h${i}`} x1={p[0]} y1={-p[1]} x2={q[0]} y2={-q[1]} stroke={smokeColor(s)} strokeOpacity={0.3} strokeWidth={width * (2 + 1.6 * s)} strokeLinecap="round" />;
        })}
        {cells.map((s, i) => {
          const p = pointOn(a, i / n);
          const q = pointOn(a, (i + 1) / n);
          return <line key={i} x1={p[0]} y1={-p[1]} x2={q[0]} y2={-q[1]} stroke={smokeColor(s)} strokeWidth={width} strokeLinecap="round" />;
        })}
        {flows && (
          <polygon points="-18,-14 18,0 -18,14" transform={`translate(${mid[0]} ${-mid[1]}) rotate(${-ang})`} fill={reversed ? REVERSE_ARROW : "#e6eef7"} stroke="#0e1116" strokeWidth={3} />
        )}
      </g>
    );
  });

  const nodeEls = [...nodes.entries()].map(([id, [x, y]]) => {
    const shaft = shafts.some((s) => s.frm === id || s.to === id);
    const r = shaft ? 26 : 9;
    box(x, y, r * 2, r * 2);
    labels.push({ id: `node-${id}`, text: nodeName(id), ax: x, ay: y, fs: fsNode, cls: "mn-node", priority: 5, startX: r + 8, py: -(fsNode * 0.6 + 14) });
    return <circle key={id} cx={x} cy={y} r={r} fill="#1c222b" stroke={COLORS.grey} strokeWidth={4} />;
  });

  const routeEls: ReactNode[] = [];
  const routeLabels = new Set<string>();
  for (const r of routes) {
    const segs = r.legs.filter((l) => onLevel(l.aw));
    if (!segs.length) continue;
    const pts2 = segs.flatMap((l, i) => {
      const a = pointOn(l.aw, l.s0);
      const b = pointOn(l.aw, l.s1);
      return i === 0 ? [a, b] : [b];
    });
    const d = pts2.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(0)},${(-p[1]).toFixed(0)}`).join(" ");
    routeEls.push(<path key={r.crew} d={d} className="mn-route" fill="none" stroke={COLORS.route} strokeWidth={9} strokeLinejoin="round" markerEnd="url(#route-arrow)" />);
    const last = pts2[pts2.length - 1];
    const endsHere = segs[segs.length - 1] === r.legs[r.legs.length - 1];
    const text = endsHere ? `Выход: ${r.targetLabel}` : `к выходу: ${r.targetLabel}`;
    if (routeLabels.has(text)) continue;
    routeLabels.add(text);
    labels.push({
      id: `route-${text}`,
      text,
      ax: last[0], ay: -last[1], fs: fsSmall, cls: "mn-route-lbl", priority: 6, py: fsSmall + 18,
    });
  }

  let fireEl: ReactNode = null;
  if (fireHere) {
    const p = fireHere.xyz;
    const rr = 20 + Math.sqrt(fireHere.hrr) * 8;
    box(p[0], -p[1], rr * 2, rr * 2);
    labels.push({ id: "fire", text: `очаг ${fmt(fireHere.hrr, 1)} МВт`, ax: p[0], ay: -p[1], fs: fsAlarm, cls: "mn-alarm", priority: 10, py: rr + fsAlarm * 0.7 });
    fireEl = (
      <g aria-label={`Очаг пожара ${fmt(fireHere.hrr, 1)} МВт`}>
        <circle cx={p[0]} cy={-p[1]} r={rr} fill={COLORS.alarm} opacity={0.35} className="mn-fire" />
        <circle cx={p[0]} cy={-p[1]} r={14} fill={COLORS.alarm} />
      </g>
    );
  }

  const doorEls = namesOfKind(things, "fire-door").map((n) => {
    const p = placeOf(things, n);
    if (!inLevel(p)) return null;
    const st = String(prop(things, n, "position") ?? "open");
    const closed = Number(prop(things, n, "closed") ?? 0) > 2;
    box(p![0], -p![1], 24, 56);
    return (
      <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}: ${closed ? "закрыта" : "открыта"}`)}>
        <rect x={p![0] - 10} y={-p![1] - 26} width={20} height={52} fill={st === "fault" ? "url(#hatch)" : closed ? COLORS.info : "#0e1116"} stroke={st === "fault" ? COLORS.alarm : COLORS.equip} strokeWidth={4} />
      </g>
    );
  });

  const valveEls = namesOfKind(things, "valve").map((n) => {
    const p = placeOf(things, n);
    if (!inLevel(p)) return null;
    const st = String(prop(things, n, "position") ?? "");
    const normal = String(things[n]?.attributes?.normal ?? "");
    const c = st === "fault" ? COLORS.alarm : st !== normal ? COLORS.info : COLORS.grey;
    box(p![0], -p![1] - 26, 30, 30);
    return (
      <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}`)}>
        <polygon points={`${p![0]},${-p![1] - 40} ${p![0] + 14},${-p![1] - 26} ${p![0]},${-p![1] - 12} ${p![0] - 14},${-p![1] - 26}`} fill={c} />
      </g>
    );
  });

  const sensorEls = namesOfKind(things, "gas-station").map((n) => {
    const p = placeOf(things, n);
    if (!inLevel(p)) return null;
    const st = String(prop(things, n, "state") ?? "ok");
    const co = prop<number>(things, n, "co");
    box(p![0], -p![1] + 29, 28, 28);
    if (st !== "ok") labels.push({ id: `gs-${n}`, text: co !== null && co !== undefined ? `CO ${Math.round(co)} ppm` : "отказ", ax: p![0], ay: -p![1] + 29, fs: fsAlarm, cls: st === "warning" ? "mn-warn" : "mn-alarm", priority: 8, px: 0, py: fsAlarm + 8, mono: true });
    return (
      <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}: CO ${co ?? "—"} ppm`)}>
        <rect x={p![0] - 13} y={-p![1] + 16} width={26} height={26} rx={4} fill={sensorColor(st)} stroke="#0e1116" strokeWidth={3} />
      </g>
    );
  });

  const refugeEls = namesOfKind(things, "refuge").map((n) => {
    const p = placeOf(things, n);
    if (!inLevel(p)) return null;
    const occ = Number(prop(things, n, "occupants") ?? 0);
    box(p![0] + 62, -p![1] + 52, 68, 48);
    return (
      <g key={n} {...item(n, `Камера-убежище: ${occ} чел.`)}>
        <rect x={p![0] + 30} y={-p![1] + 30} width={64} height={44} rx={4} fill="#0f2a22" stroke={COLORS.ok} strokeWidth={4} />
        <text x={p![0] + 62} y={-p![1] + 60} className="mn-ok" textAnchor="middle">{occ}</text>
      </g>
    );
  });

  const vehicleEls = namesOfKind(things, "lhd", "truck").map((n) => {
    const p = placeOf(things, n);
    if (!inLevel(p)) return null;
    const fireA = prop(things, n, "fire_alarm") === true;
    const truck = things[n]?.attributes?.kind === "truck";
    const x = p![0];
    const y = -p![1];
    box(x, y, 48, 30);
    return (
      <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}`)}>
        <rect x={x - 22} y={y - 12} width={truck ? 28 : 30} height={20} rx={3} fill={fireA ? COLORS.alarm : COLORS.equip} stroke="#0e1116" strokeWidth={3} />
        {truck ? <rect x={x + 6} y={y - 6} width={14} height={14} rx={2} fill={fireA ? COLORS.alarm : COLORS.equip} stroke="#0e1116" strokeWidth={3} />
          : <path d={`M${x + 8},${y - 10} L${x + 24},${y - 4} L${x + 24},${y + 8} L${x + 8},${y + 8} Z`} fill={fireA ? COLORS.alarm : COLORS.equip} stroke="#0e1116" strokeWidth={3} />}
        <circle cx={x - 12} cy={y + 10} r={5} fill="#2b333e" />
        <circle cx={x + 10} cy={y + 10} r={5} fill="#2b333e" />
      </g>
    );
  });

  const crewEls = namesOfKind(things, "crew").map((n) => {
    const p = placeOf(things, n);
    const st = String(prop(things, n, "state") ?? "working");
    if (!inLevel(p) || st === "surface") return null;
    const fed = Number(prop(things, n, "fed") ?? 0);
    const ppl = prop<number>(things, n, "people");
    box(p![0], -p![1], 52, 52);
    return (
      <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}: ${ppl} чел.`)}>
        <circle cx={p![0]} cy={-p![1]} r={24} fill={crewColor(st, fed)} stroke="#0e1116" strokeWidth={4} />
        <text x={p![0]} y={-p![1] + 9} className="mn-crew" textAnchor="middle">{ppl}</text>
      </g>
    );
  });

  // ---- labels ----
  const bounds: Rect = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
  const lin: LabelIn[] = labels.map((l) => ({
    id: l.id, ax: l.ax, ay: l.ay, w: l.text.length * l.fs * (l.mono ? 0.62 : 0.56), h: l.fs * 1.15, priority: l.priority,
    px: l.startX !== undefined ? l.startX + (l.text.length * l.fs * 0.56) / 2 : l.px ?? 0, py: l.py ?? 0, prev: prevOff.current.get(l.id),
  }));
  const placed = declutter(lin, obstacles, bounds, 6);
  const labelEls = labels.map((l, i) => {
    const o = placed.get(l.id)!;
    const L = lin[i];
    prevOff.current.set(l.id, [o.dx, o.dy]);
    const cx = l.ax + o.dx;
    const cy = l.ay + o.dy;
    const ex = Math.max(cx - L.w / 2, Math.min(l.ax, cx + L.w / 2));
    const ey = Math.max(cy - L.h / 2, Math.min(l.ay, cy + L.h / 2));
    const leader = o.moved && Math.hypot(ex - l.ax, ey - l.ay) > 20;
    return (
      <g key={l.id} className="mn-label">
        {leader && <line x1={l.ax} y1={l.ay} x2={ex} y2={ey} className="mn-leader" />}
        <text x={cx} y={cy + l.fs * 0.36} className={l.cls} textAnchor="middle" style={{ fontSize: l.fs }} paintOrder="stroke">{l.text}</text>
      </g>
    );
  });

  return (
    <svg ref={svgRef} style={{ "--u": u } as CSSProperties} className={`mnemonic${compact ? " is-compact" : ""}`} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Мнемосхема горизонта ${h.label}`}>
      <defs>
        <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="10" stroke={COLORS.alarm} strokeWidth="3" />
        </pattern>
        <marker id="route-arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 Z" fill={COLORS.route} />
        </marker>
      </defs>
      {linkEls}
      {airwayEls}
      {nodeEls}
      {routeEls}
      {fireEl}
      {doorEls}
      {valveEls}
      {sensorEls}
      {refugeEls}
      {vehicleEls}
      {crewEls}
      {labelEls}
    </svg>
  );
}
