import { CSSProperties, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Airway, airways, HORIZONS, namesOfKind, placeOf, pointOn, smokeCells } from "../data/geometry";
import { parseJson, prop, useStore } from "../data/store";
import { COLORS, crewColor, sensorColor } from "../data/status";

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

function nodeName(id: string) {
  return NODE_NAMES[id] ?? NODE_NAMES[id.replace(/\d+$/, "")] ?? id;
}

type Props = { horizon: string; selected: string | null; onSelect: (n: string | null) => void };

function smokeColor(s: number) {
  if (s < 0.05) return COLORS.air;
  if (s < 0.5) return COLORS.smoke;
  return "#c2410c";
}

function keyAct(fn: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fn();
    }
  };
}

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
  const fire = parseJson<{ airway: string; s: number; hrr_mw: number; extinct: boolean } | null>(prop(things, "control", "fire_truth"), null);
  const fireAw = fire && !fire.extinct ? aws.find((a) => a.edge === fire.airway && onLevel(a)) : undefined;

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
    ? [Math.min(...xs) - 140, Math.min(...ys) - 140, Math.max(...xs) - Math.min(...xs) + (compact ? 900 : 560), Math.max(...ys) - Math.min(...ys) + 300]
    : [-160, -1560, 1700, 2040];
  const viewBox = vb.join(" ");
  const svgRef = useRef<SVGSVGElement>(null);
  const [unitsPerPx, setUnitsPerPx] = useState(1);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setUnitsPerPx(1 / Math.min(width / vb[2], height / vb[3]));
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

  return (
    <svg ref={svgRef} style={{ "--u": unitsPerPx } as CSSProperties} className={`mnemonic${compact ? " is-compact" : ""}`} viewBox={viewBox} preserveAspectRatio="xMidYMid meet" role="group" aria-label={`Мнемосхема горизонта ${h.label}`}>
      <defs>
        <pattern id="hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="10" stroke={COLORS.alarm} strokeWidth="3" />
        </pattern>
      </defs>
      {links.map((a, i) => {
        const onA = a.a[2] === h.z;
        const p = onA ? a.a : a.b;
        const q = onA ? a.b : a.a;
        const mx = p[0] + (q[0] - p[0]) * 0.35;
        const my = p[1] + (q[1] - p[1]) * 0.35 + (a.kind === "ramp" ? 90 : 0);
        const sameStart = links.slice(0, i).filter((b) => (b.a[2] === h.z ? b.frm : b.to) === (onA ? a.frm : a.to)).length;
        return (
          <g key={a.id}>
            <line x1={p[0]} y1={-p[1]} x2={mx} y2={-my} stroke={COLORS.airDim} strokeWidth={10} strokeDasharray="18 12" />
            <text x={mx + 14} y={-my + 6 + sameStart * 34} className="mn-note">{a.kind === "ramp" ? "рампа" : "восстающий"} к {q[2] > h.z ? "верхнему" : "нижнему"} горизонту</text>
          </g>
        );
      })}
      {level.map((a) => {
        const cells = smokeCells(things, a);
        const n = cells.length;
        const v = Number(prop(things, a.id, "velocity") ?? 0);
        const mid = pointOn(a, 0.5);
        const ang = (Math.atan2(-(a.b[1] - a.a[1]), a.b[0] - a.a[0]) * 180) / Math.PI + (v < 0 ? 180 : 0);
        const width = Math.sqrt(a.area) * 3.2;
        return (
          <g key={a.id} {...item(a.id, `${a.name}: ${Math.abs(v).toFixed(1)} м/с`)}>
            <line x1={a.a[0]} y1={-a.a[1]} x2={a.b[0]} y2={-a.b[1]} stroke="transparent" strokeWidth={40} />
            {cells.map((s, i) => {
              const p = pointOn(a, i / n);
              const q = pointOn(a, (i + 1) / n);
              return <line key={i} x1={p[0]} y1={-p[1]} x2={q[0]} y2={-q[1]} stroke={smokeColor(s)} strokeWidth={width} strokeLinecap="round" />;
            })}
            {Math.abs(v) > 0.08 && (
              <polygon points="-16,-12 16,0 -16,12" transform={`translate(${mid[0]} ${-mid[1]}) rotate(${-ang})`} fill="#d7e6f5" />
            )}
            {Math.abs(v) > 0.08 && (
              <text x={mid[0]} y={-mid[1] - 22} className="mn-flow" textAnchor="middle">{Math.abs(v).toFixed(1)} м/с</text>
            )}
          </g>
        );
      })}
      {[...nodes.entries()].map(([id, [x, y]]) => (
        <g key={id}>
          <circle cx={x} cy={y} r={shafts.some((s) => s.frm === id || s.to === id) ? 26 : 9} fill="#1c222b" stroke={COLORS.grey} strokeWidth={4} />
          <text x={x + 30} y={y - 26} className="mn-node">{nodeName(id)}</text>
        </g>
      ))}
      {fireAw && fire && (() => {
        const p = pointOn(fireAw, fire.s);
        return (
          <g aria-label={`Очаг пожара ${fire.hrr_mw.toFixed(1)} МВт`}>
            <circle cx={p[0]} cy={-p[1]} r={20 + Math.sqrt(fire.hrr_mw) * 8} fill={COLORS.alarm} opacity={0.35} className="mn-fire" />
            <circle cx={p[0]} cy={-p[1]} r={14} fill={COLORS.alarm} />
            <text x={p[0]} y={-p[1] + 52} className="mn-alarm" textAnchor="middle">очаг {fire.hrr_mw.toFixed(1)} МВт</text>
          </g>
        );
      })()}
      {namesOfKind(things, "fire-door").map((n) => {
        const p = placeOf(things, n);
        if (!inLevel(p)) return null;
        const st = String(prop(things, n, "position") ?? "open");
        const closed = Number(prop(things, n, "closed") ?? 0) > 2;
        return (
          <g key={n} {...item(n, `Дверь ${n}: ${st}`)}>
            <rect x={p![0] - 10} y={-p![1] - 26} width={20} height={52} fill={st === "fault" ? "url(#hatch)" : closed ? COLORS.info : "#0e1116"} stroke={st === "fault" ? COLORS.alarm : COLORS.equip} strokeWidth={4} />
          </g>
        );
      })}
      {namesOfKind(things, "valve").map((n) => {
        const p = placeOf(things, n);
        if (!inLevel(p)) return null;
        const st = String(prop(things, n, "position") ?? "");
        const normal = String(things[n]?.attributes?.normal ?? "");
        const c = st === "fault" ? COLORS.alarm : st !== normal ? COLORS.info : COLORS.grey;
        return (
          <g key={n} {...item(n, `Клапан ${n}: ${st}`)}>
            <polygon points={`${p![0]},${-p![1] - 40} ${p![0] + 14},${-p![1] - 26} ${p![0]},${-p![1] - 12} ${p![0] - 14},${-p![1] - 26}`} fill={c} />
          </g>
        );
      })}
      {namesOfKind(things, "gas-station").map((n) => {
        const p = placeOf(things, n);
        if (!inLevel(p)) return null;
        const st = String(prop(things, n, "state") ?? "ok");
        const co = prop<number>(things, n, "co");
        return (
          <g key={n} {...item(n, `Датчик ${n}: CO ${co ?? "—"} ppm`)}>
            <rect x={p![0] - 13} y={-p![1] + 16} width={26} height={26} rx={4} fill={sensorColor(st)} stroke="#0e1116" strokeWidth={3} />
            {st !== "ok" && <text x={p![0] + 20} y={-p![1] + 38} className={st === "warning" ? "mn-warn" : "mn-alarm"}>{co !== null && co !== undefined ? `${Math.round(co)} ppm` : "отказ"}</text>}
          </g>
        );
      })}
      {namesOfKind(things, "refuge").map((n) => {
        const p = placeOf(things, n);
        if (!inLevel(p)) return null;
        const occ = Number(prop(things, n, "occupants") ?? 0);
        return (
          <g key={n} {...item(n, `Камера-убежище: ${occ} чел.`)}>
            <rect x={p![0] + 30} y={-p![1] + 30} width={64} height={44} rx={4} fill="#0f2a22" stroke={COLORS.ok} strokeWidth={4} />
            <text x={p![0] + 62} y={-p![1] + 60} className="mn-ok" textAnchor="middle">{occ}</text>
          </g>
        );
      })}
      {namesOfKind(things, "lhd", "truck").map((n) => {
        const p = placeOf(things, n);
        if (!inLevel(p)) return null;
        const fireA = prop(things, n, "fire_alarm") === true;
        return (
          <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}`)}>
            <rect x={p![0] - 18} y={-p![1] - 11} width={36} height={22} rx={3} fill={fireA ? COLORS.alarm : COLORS.equip} stroke="#0e1116" strokeWidth={3} />
          </g>
        );
      })}
      {namesOfKind(things, "crew").map((n) => {
        const p = placeOf(things, n);
        const st = String(prop(things, n, "state") ?? "working");
        if (!inLevel(p) || st === "surface") return null;
        const fed = Number(prop(things, n, "fed") ?? 0);
        const ppl = prop<number>(things, n, "people");
        return (
          <g key={n} {...item(n, `${things[n]?.attributes?.name ?? n}: ${ppl} чел.`)}>
            <circle cx={p![0]} cy={-p![1]} r={24} fill={crewColor(st, fed)} stroke="#0e1116" strokeWidth={4} />
            <text x={p![0]} y={-p![1] + 9} className="mn-crew" textAnchor="middle">{ppl}</text>
          </g>
        );
      })}
    </svg>
  );
}
