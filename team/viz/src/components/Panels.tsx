import { useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Clock3, Loader2, Play, RotateCcw, ShieldCheck, ShieldOff, XCircle, Calculator, X, Scale } from "lucide-react";
import { attr, clock, parseJson, prop, putDesired, Thing, useStore } from "../data/store";
import { COLORS, fmt, stateLabel, Tone, TONE_COLOR } from "../data/status";
import { HORIZONS } from "../data/geometry";
import { eventRows } from "../data/events";

export function Chip({ state, label }: { state?: unknown; label?: string }) {
  const [text, tone] = stateLabel(state);
  return <span className={`chip chip-${tone}`}>{label ?? text}</span>;
}

function Kpi({ label, value, unit, tone = "neutral", big = false }: { label: string; value: string; unit?: string; tone?: Tone; big?: boolean }) {
  return (
    <div className={`kpi${big ? " kpi-big" : ""}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" style={tone !== "neutral" ? { color: TONE_COLOR[tone] } : undefined}>
        {value}
        {unit && <span className="kpi-unit"> {unit}</span>}
      </span>
    </div>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// ---------------------------------------------------------------------------
export function StatusPanel() {
  const { things } = useStore();
  const p = (n: string, f: string) => prop<number>(things, n, f);
  const risk = p("mine", "people_at_risk") ?? 0;
  const injured = p("mine", "people_injured") ?? 0;
  const fanMode = String(prop(things, "gvu", "mode") ?? "normal");
  return (
    <section aria-labelledby="st-h" className="panel-body">
      <h2 id="st-h" className="sr-only">Обстановка</h2>
      <div className="kpi-grid">
        <Kpi big label="Людей в шахте" value={fmt(p("mine", "people_underground"))} unit="чел." />
        <Kpi big label="В безопасности" value={fmt(p("mine", "people_safe"))} unit="чел." tone={(p("mine", "people_safe") ?? 0) > 0 ? "ok" : "neutral"} />
        <Kpi label="Под угрозой" value={fmt(risk)} unit="чел." tone={risk > 0 ? "warn" : "neutral"} />
        <Kpi label="Пострадали" value={fmt(injured)} unit="чел." tone={injured > 0 ? "alarm" : "neutral"} />
        <Kpi label="Выдача руды" value={fmt(p("mine", "production"))} unit="т/ч" />
        <Kpi label="Потери добычи" value={fmt(p("mine", "lost_production"))} unit="т" tone={(p("mine", "lost_production") ?? 0) > 0 ? "warn" : "neutral"} />
        <Kpi label="Расход воздуха" value={fmt(p("mine", "airflow"))} unit="м³/с" />
        <Kpi label="Депрессия ГВУ" value={fmt(p("mine", "fan_pressure"))} unit="Па" />
      </div>
      <dl className="facts">
        <div><dt>Режим проветривания</dt><dd><Chip state={fanMode} /></dd></div>
        <div><dt>Вентилятор №1</dt><dd><Chip state={prop(things, "fan-1", "state")} /></dd></div>
        <div><dt>Вентилятор №2</dt><dd><Chip state={prop(things, "fan-2", "state")} /></dd></div>
        <div><dt>Пожарный трубопровод</dt><dd>{fmt(p("fire-main", "pressure"), 1)} бар <Chip state={prop(things, "fire-main", "state")} label={prop(things, "fire-main", "state") === "low" ? "мало" : "норма"} /></dd></div>
        <div><dt>Клетевой подъём</dt><dd><Chip state={prop(things, "hoist-cage", "state")} /></dd></div>
      </dl>
      <table className="table">
        <caption>Горизонты</caption>
        <thead>
          <tr><th scope="col">Горизонт</th><th scope="col">CO макс.</th><th scope="col">Видимость</th><th scope="col">Люди</th></tr>
        </thead>
        <tbody>
          {HORIZONS.map((h) => {
            const co = p(h.id, "co_max") ?? 0;
            const vis = p(h.id, "visibility_min") ?? 50;
            return (
              <tr key={h.id}>
                <th scope="row">{h.label}</th>
                <td className={co >= 50 ? "t-alarm" : co >= 17 ? "t-warn" : ""}>{fmt(co)} ppm</td>
                <td className={vis < 10 ? "t-alarm" : ""}>{fmt(vis)} м</td>
                <td>{fmt(p(h.id, "people"))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

// ---------------------------------------------------------------------------
type Cmd = { twin: string; cmd: string; note: string; status: string; issued: number | null };

const CMD_ICON: Record<string, JSX.Element> = {
  pending: <Clock3 size={18} aria-hidden />,
  issued: <Loader2 size={18} aria-hidden className="spin" />,
  done: <CheckCircle2 size={18} aria-hidden />,
  fault: <XCircle size={18} aria-hidden />,
};

const PAZ_MODES: [string, string][] = [
  ["auto", "Автоматический"],
  ["manual", "Ручной (через диспетчера)"],
  ["off", "Выведена из работы"],
];

const MODE_HINT: Record<string, string> = {
  auto: "Команды позиции ПЛА уходят на исполнительные органы сразу после обнаружения.",
  manual: "ПАЗ готовит позицию ПЛА, но ждёт подтверждения диспетчера (или его реакции через 5 мин модельного времени).",
  off: "Сигналы только записываются в журнал, команды на двери, клапаны и вентиляторы не выдаются. Люди уходят, когда сами заметят дым.",
};

/** "P4" -> "Поз. 4" */
const posLabel = (id: unknown) => (typeof id === "string" && /^P\d+$/.test(id) ? `Поз. ${id.slice(1)}` : String(id ?? ""));

export function PazPanel({ onShow }: { onShow: (twin: string) => void }) {
  const { things } = useStore();
  const act = useAction();
  const [askOff, setAskOff] = useState(false);
  const state = String(prop(things, "paz", "state") ?? "standby");
  const mode = String(prop(things, "paz", "mode") ?? "auto");
  const title = String(prop(things, "paz", "position", "title") ?? "");
  const refined = prop<string>(things, "paz", "position", "refined_from");
  const proposed = prop<string>(things, "paz", "position", "proposed");
  const proposedTitle = prop<string>(things, "paz", "position", "proposed_title");
  const cmds = parseJson<Cmd[]>(prop(things, "paz", "commands"), []);
  const detected = prop<number>(things, "paz", "detected_at");
  const resp = prop<number>(things, "paz", "response_time");
  const trigger = String(prop(things, "paz", "trigger") ?? "");
  const awaiting = state === "awaiting_dispatcher";
  const confirm = () => act.run(() => putDesired("control", "paz_confirm", { seq: Date.now() }));
  const setMode = (m: string) => {
    setAskOff(false);
    act.run(() => putDesired("control", "paz_mode", { value: m }));
  };
  return (
    <section aria-labelledby="paz-h" className="panel-body">
      <div className="row-between">
        <h2 id="paz-h" className="h2">Противоаварийная защита</h2>
        <Chip state={state === "standby" ? "standby_paz" : state} />
      </div>
      <fieldset className="segmented seg-wrap" aria-label="Режим ПАЗ">
        <legend className="sr-only">Режим ПАЗ</legend>
        {PAZ_MODES.map(([m, label]) => (
          <label key={m} className={`${mode === m ? "is-on" : ""}${m === "off" ? " seg-alarm" : ""}`}>
            <input
              type="radio"
              name="paz-mode"
              value={m}
              checked={mode === m}
              onChange={() => (m === "off" ? setAskOff(true) : setMode(m))}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {askOff && mode !== "off" && (
        <div className="callout callout-alarm" role="alertdialog" aria-labelledby="paz-off-h" aria-describedby="paz-off-t">
          <AlertTriangle size={20} aria-hidden />
          <div>
            <strong id="paz-off-h">Вывести ПАЗ из работы?</strong>
            <p id="paz-off-t">{MODE_HINT.off}</p>
            <div className="actions">
              <button className="btn btn-danger" disabled={act.busy} onClick={() => setMode("off")}>Вывести из работы</button>
              <button className="btn btn-ghost" autoFocus onClick={() => setAskOff(false)}>Отмена</button>
            </div>
          </div>
        </div>
      )}
      <p className="hint">{MODE_HINT[mode] ?? MODE_HINT.auto}</p>
      {mode === "off" && state !== "standby" ? (
        <div className="callout callout-alarm">
          <ShieldOff size={20} aria-hidden />
          <div>
            <strong>ПАЗ выведена из работы</strong>
            <p>{trigger ? `Сигнал: ${trigger}, ${clock(detected, true)}. Команды не выдаются.` : "Аварийных сигналов нет. При аварии команды выдаваться не будут."}</p>
          </div>
        </div>
      ) : state === "standby" ? (
        <div className="empty">
          <ShieldCheck size={22} aria-hidden />
          <p>Аварийных сигналов нет. ПАЗ контролирует 16 газоаналитических узлов, бортовые системы техники и вентиляторы ГВУ.</p>
        </div>
      ) : (
        <>
          <div className="callout callout-alarm">
            <AlertTriangle size={20} aria-hidden />
            <div>
              <strong>{title || "Позиция ПЛА"}</strong>
              <p>Сигнал: {trigger || "—"}. Обнаружено в {clock(detected, true)}{resp !== null && resp !== undefined ? `, отработано за ${resp} с` : ""}.</p>
              {refined && <p className="muted">Позиция уточнена из {posLabel(refined)} по предложению советчика.</p>}
            </div>
          </div>
          {proposed ? (
            <div className="callout callout-warn" role="status">
              <Calculator size={20} aria-hidden />
              <div>
                <strong>Советчик предлагает: {proposedTitle || posLabel(proposed)}</strong>
                <p>Действует {title || "текущая позиция"}. Смена позиции — только после подтверждения горного диспетчера.</p>
                <button className="btn btn-primary" disabled={act.busy} onClick={confirm}>
                  <ShieldCheck size={18} aria-hidden /> Подтвердить смену на {posLabel(proposed)}
                </button>
              </div>
            </div>
          ) : awaiting && (
            <button className="btn btn-primary btn-block" disabled={act.busy} onClick={confirm}>
              <ShieldCheck size={18} aria-hidden /> Подтвердить позицию ПЛА
            </button>
          )}
          <ol className="cmd-list">
            {cmds.map((c, i) => (
              <li key={i} className={`cmd cmd-${c.status}`}>
                {CMD_ICON[c.status] ?? <Circle size={18} aria-hidden />}
                {things[c.twin] ? (
                  <button type="button" className="link cmd-note" onClick={() => onShow(c.twin)} title="Показать на модели">{c.note}</button>
                ) : (
                  <span className="cmd-note">{c.note}</span>
                )}
                <span className="cmd-status">{stateLabel(c.status === "fault" ? "fault" : c.status)[0]}</span>
              </li>
            ))}
          </ol>
        </>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
type Point = {
  t: number; safe?: number; risk?: number; fed?: number; injured?: number; smoke_pm?: number; fire_mw?: number;
  co?: Record<string, number>;
};
type Option = {
  option: string; title: string; people_safe: number; people_total: number; people_at_risk: number;
  people_at_risk_max?: number; people_injured: number; max_fed: number; smoke_person_min: number; harm: number;
  fire_mw: number; basis?: string; series?: Point[];
};

const METRICS = [
  { id: "safe", label: "В безопасности", unit: "чел.", digits: 0 },
  { id: "risk", label: "Под угрозой", unit: "чел.", digits: 0 },
  { id: "injured", label: "Пострадали", unit: "чел.", digits: 0 },
  { id: "fed", label: "Доза FED", unit: "", digits: 2 },
  { id: "smoke_pm", label: "В дыму", unit: "чел.·мин", digits: 0 },
  { id: "fire_mw", label: "Очаг", unit: "МВт", digits: 1 },
  { id: "co", label: "CO у выходов", unit: "ppm", digits: 0 },
] as const;
type Metric = (typeof METRICS)[number]["id"];

/** Key points of the CO series published by the advisor and the study bench. */
const CO_POINTS: [string, string][] = [
  ["C480", "клетевой ствол −480"],
  ["C560", "клетевой ствол −560"],
  ["C640", "клетевой ствол −640"],
  ["J560", "убежище −560"],
  ["J640", "убежище −640"],
];

type Line = { id: string; title: string; note?: string; series: Point[]; color: string; dash: string; strong?: boolean };

function niceCeil(v: number) {
  if (v <= 0) return 1;
  const e = 10 ** Math.floor(Math.log10(v));
  const f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}

/** Time series of several runs or options on one axis: forecast of the advisor or runs of the study bench. */
function SeriesChart({ title, lines, total }: { title: string; lines: Line[]; total: number }) {
  const [metric, setMetric] = useState<Metric>("safe");
  const [point, setPoint] = useState(CO_POINTS[0][0]);
  const usable = lines.filter((l) => Array.isArray(l.series) && l.series.length > 1);
  if (!usable.length) return null;
  const has = (id: Metric) => usable.some((l) => l.series.some((p) => (id === "co" ? p.co && Object.keys(p.co).length > 0 : typeof p[id] === "number")));
  const avail = METRICS.filter((m) => has(m.id));
  const m = avail.find((x) => x.id === metric) ?? avail[0];
  const val = (p: Point) => (m.id === "co" ? Number(p.co?.[point] ?? 0) : Number(p[m.id] ?? 0));
  const peak = Math.max(0, ...usable.flatMap((l) => l.series.map(val)));
  const yMax = m.id === "safe" ? Math.max(total, 1) : m.id === "fed" ? niceCeil(Math.max(0.3, peak)) : niceCeil(peak);
  const tMax = Math.max(1, ...usable.flatMap((l) => l.series.map((p) => p.t)));
  const W = 400, H = 170, L = 40, R = 8, T = 10, B = 26;
  const x = (t: number) => L + (t / tMax) * (W - L - R);
  const y = (v: number) => T + (1 - Math.min(v, yMax) / yMax) * (H - T - B);
  const ticks = [0, 0.5, 1].map((k) => yMax * k);
  // solid lines under dashed ones, so a baseline that coincides with an option stays visible
  const layer = (l: Line) => (l.dash ? 2 : l.strong ? 1 : 0);
  const ordered = [...usable].sort((a, b) => layer(a) - layer(b));
  const unit = m.unit ? ` ${m.unit}` : "";
  const pointLabel = CO_POINTS.find(([k]) => k === point)?.[1] ?? point;
  const summary = usable.map((l) => `${l.title}: ${fmt(val(l.series[l.series.length - 1]), m.digits)}${unit}`).join("; ");
  return (
    <div className="chart">
      <div className="ch-head">
        <h3 className="h3">{title}</h3>
        <div className="segmented seg-sm" role="group" aria-label="Показатель">
          {avail.map((x) => (
            <button key={x.id} type="button" aria-pressed={m.id === x.id} className={m.id === x.id ? "is-on" : ""} onClick={() => setMetric(x.id)}>{x.label}</button>
          ))}
        </div>
        {m.id === "co" && (
          <label className="field-inline">
            <span>Точка</span>
            <select value={point} onChange={(e) => setPoint(e.target.value)}>
              {CO_POINTS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${m.label}${m.id === "co" ? `, ${pointLabel}` : ""} через ${Math.round(tMax)} мин: ${summary}`}>
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="#2a323d" />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="ch-axis">{fmt(v, v > 0 && v < 10 && m.digits ? m.digits : 0)}</text>
          </g>
        ))}
        {[0, tMax / 2, tMax].map((t, i) => (
          <text key={t} x={x(t)} y={H - 6} textAnchor={i === 2 ? "end" : "middle"} className="ch-axis">{Math.round(t)} мин</text>
        ))}
        {m.id === "fed" && <line x1={L} x2={W - R} y1={y(0.3)} y2={y(0.3)} stroke={COLORS.warn} strokeDasharray="3 3" />}
        {ordered.map((l) => {
          const d = l.series.map((p, k) => `${k ? "L" : "M"}${x(p.t).toFixed(1)},${y(val(p)).toFixed(1)}`).join(" ");
          return <path key={l.id} d={d} fill="none" stroke={l.color} strokeWidth={l.strong ? 3.5 : 2} strokeDasharray={l.dash} strokeLinejoin="round" />;
        })}
      </svg>
      <ul className="ch-legend">
        {lines.filter((l) => usable.includes(l)).map((l) => (
          <li key={l.id}>
            <svg width="26" height="8" aria-hidden><line x1="0" x2="26" y1="4" y2="4" stroke={l.color} strokeWidth={l.strong ? 4 : 3} strokeDasharray={l.dash} /></svg>
            <span>{l.title}{l.note && <span className="muted"> · {l.note}</span>}</span>
          </li>
        ))}
      </ul>
      {m.id === "fed" && <p className="hint">Пунктир — FED 0,3: с этой дозы бригада считается под угрозой, 1,0 — потеря сознания.</p>}
      {m.id === "smoke_pm" && <p className="hint">Человеко-минуты в дыму нарастающим итогом.</p>}
      {m.id === "co" && <p className="hint">CO в точке «{pointLabel}», ppm.</p>}
      {m.id === "fire_mw" && <p className="hint">Мощность очага, МВт.</p>}
    </div>
  );
}

const OPTION_STYLE: Record<string, { color: string; dash: string }> = {
  normal: { color: COLORS.info, dash: "" },
  reverse: { color: COLORS.warn, dash: "" },
  no_new: { color: COLORS.grey, dash: "6 4" },
  no_paz: { color: COLORS.alarm, dash: "2 4" },
};
const BASELINES = ["no_paz", "no_new"];

/** Decimal point to comma in numbers inside a sentence from a module. */
const ruNum = (s: string) => s.replace(/(\d)\.(\d)/g, "$1,$2");

type Estimate = {
  label: string; hrr_mw: number; confidence?: number; sensors?: string[]; edge: string; held?: boolean;
  method?: string; basis?: string; age_s?: number;
};

function OptionCard({ o, best, maxHarm, baseline }: { o: Option; best: string; maxHarm: number; baseline: boolean }) {
  const riskMax = o.people_at_risk_max ?? o.people_at_risk;
  return (
    <li className={o.option === best ? "is-best" : baseline ? "is-baseline" : ""}>
      <span className="opt-title">
        <svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={OPTION_STYLE[o.option]?.color ?? COLORS.grey} strokeWidth="3" strokeDasharray={OPTION_STYLE[o.option]?.dash} /></svg>
        {o.title}
        {o.option === best && <span className="chip chip-ok">рекомендовано</span>}
        {baseline && <span className="chip chip-neutral">для сравнения</span>}
      </span>
      {o.basis && <span className="muted opt-basis">Расчёт от: {o.basis}</span>}
      <div className="harm">
        <span className="harm-label">индекс ущерба <span className="mono">{fmt(o.harm, o.harm > 0 && o.harm < 10 ? 1 : 0)}</span></span>
        <div className="bar" aria-hidden>
          <span style={{ width: `${o.harm > 0 ? Math.max(3, (o.harm / maxHarm) * 100) : 0}%` }} className={o.people_injured ? "bar-alarm" : riskMax ? "bar-warn" : o.harm > 0 ? "bar-smoke" : "bar-ok"} />
        </div>
      </div>
      <dl className="opt-facts">
        <div><dt>в безопасности</dt><dd>{o.people_safe}/{o.people_total}</dd></div>
        <div><dt>под угрозой (макс.)</dt><dd className={riskMax ? "t-warn" : ""}>{o.people_at_risk} ({riskMax})</dd></div>
        <div><dt>пострадали</dt><dd className={o.people_injured ? "t-alarm" : ""}>{o.people_injured}</dd></div>
        <div><dt>FED макс.</dt><dd className={(o.max_fed ?? 0) >= 0.3 ? "t-warn" : ""}>{fmt(o.max_fed, 2)}</dd></div>
        <div><dt>в дыму</dt><dd>{fmt(o.smoke_person_min)} чел.·мин</dd></div>
        <div><dt>очаг через 30 мин</dt><dd>{fmt(o.fire_mw, 1)} МВт</dd></div>
      </dl>
    </li>
  );
}

function Proposal({ things }: { things: Record<string, Thing> }) {
  const p = things.advisor?.features?.proposal?.properties ?? {};
  const value = p.value;
  if (!value || value === "none") return null;
  const pazPos = prop(things, "paz", "position");
  const pazProposed = prop(things, "paz", "position", "proposed");
  const [text, cls] = pazPos === value
    ? ["ПАЗ ввела эту позицию.", "callout-ok"]
    : pazProposed === value
      ? ["ПАЗ ждёт подтверждения горного диспетчера: вкладка «ПАЗ».", "callout-warn"]
      : p.sent_to_paz
        ? ["Передано в ПАЗ.", "callout-info"]
        : ["Не передано в ПАЗ: по этой аварии предложение уже отправлялось.", "callout-info"];
  const conf = typeof p.confidence === "number" ? `, уверенность ${Math.round(p.confidence * 100)} %` : "";
  return (
    <div className={`callout ${cls}`} role="status">
      <ShieldCheck size={20} aria-hidden />
      <div>
        <strong>Предложение для ПАЗ: {String(p.title ?? posLabel(value))}</strong>
        <p>Очаг: {String(p.fire ?? "—")}{conf}. {p.paz_position ? `У ПАЗ была ${posLabel(p.paz_position)}. ` : ""}{text}</p>
      </div>
    </div>
  );
}

export function AdvisorPanel({ onShow }: { onShow: (twin: string) => void }) {
  const { things } = useStore();
  const act = useAction();
  const state = String(prop(things, "advisor", "state") ?? "normal");
  const options = parseJson<Option[]>(prop(things, "advisor", "options"), []);
  const est = parseJson<Estimate | null>(prop(things, "advisor", "estimate"), null);
  const best = String(prop(things, "advisor", "best_option") ?? "");
  const rec = String(prop(things, "advisor", "recommendation") ?? "");
  const audit = String(prop(things, "advisor", "audit") ?? "");
  const at = prop<number>(things, "advisor", "computed_at");
  const maxHarm = Math.max(1, ...options.map((o) => o.harm ?? 0));
  const awName = est ? String(attr(things, "aw-" + est.edge, "name") ?? est.edge) : "";
  const choices = options.filter((o) => !BASELINES.includes(o.option)).sort((a, b) => Number(b.option === best) - Number(a.option === best));
  const baselines = options.filter((o) => BASELINES.includes(o.option));
  const total = Math.max(0, ...options.map((o) => o.people_total ?? 0));
  const sentences = rec.split(/\.\s(?=[«А-ЯЁ])/);
  const bestTitle = options.find((o) => o.option === best)?.title;
  const bestAt = bestTitle ? sentences.findIndex((s) => s.startsWith(bestTitle)) : -1;
  const headline = ruNum(sentences[Math.max(0, bestAt)] ?? rec);
  const caveat = bestAt > 0 ? ruNum(sentences.slice(0, bestAt).join(". ")) : "";
  const basisName = est?.basis ? (things[est.basis] ? String(things[est.basis].attributes?.name ?? est.basis) : est.basis) : "";
  const method = est ? ruNum(est.method ?? (est.held ? "по кривой развития пожара" : `по CO на ${est.sensors?.[0] ?? "—"}`)) : "";
  const lines: Line[] = [...choices, ...baselines].map((o) => ({
    id: o.option, title: o.title, series: o.series ?? [], ...(OPTION_STYLE[o.option] ?? { color: COLORS.equip, dash: "1 3" }),
    strong: o.option === best, note: o.option === best ? "рекомендовано" : BASELINES.includes(o.option) ? "для сравнения" : undefined,
  }));
  return (
    <section aria-labelledby="adv-h" className="panel-body">
      <div className="row-between">
        <h2 id="adv-h" className="h2">Советчик диспетчера</h2>
        <button className="btn btn-ghost" disabled={act.busy} onClick={() => act.run(() => putDesired("control", "advisor_run", { seq: Date.now() }))}>
          <Calculator size={18} aria-hidden /> Пересчитать
        </button>
      </div>
      {state !== "forecast" ? (
        <div className="empty">
          <Calculator size={22} aria-hidden />
          <p>{rec || "Прогноз строится, когда появляется аварийный сигнал. Советчик видит только данные двойников: показания датчиков, положение дверей и клапанов, режим ГВУ и местоположение людей."}</p>
        </div>
      ) : (
        <>
          {est && (
            <dl className="facts">
              <div><dt>Вероятный очаг</dt><dd>{est.label}</dd></div>
              <div><dt>Выработка</dt><dd>{awName}</dd></div>
              <div><dt>Оценка мощности</dt><dd>{fmt(est.hrr_mw, 1)} МВт</dd></div>
              <div className="facts-wide">
                <dt>Как получена</dt>
                <dd>
                  {method}
                  {basisName && (
                    <> · основание: {things[est.basis!] ? <button type="button" className="link" onClick={() => onShow(est.basis!)}>{basisName}</button> : basisName}</>
                  )}
                </dd>
              </div>
            </dl>
          )}
          <Proposal things={things} />
          {headline && (
            <div className="callout callout-info">
              <ShieldCheck size={20} aria-hidden />
              <div>
                <p><strong>Рекомендация.</strong> {headline}.</p>
                {caveat && <p className="note">{caveat}.</p>}
              </div>
            </div>
          )}
          <h3 className="h3">Прогноз на 30 минут {at !== undefined && <span className="muted">(от {clock(at)})</span>}</h3>
          <p className="hint">Из вариантов решения советчик выбирает лучший. Варианты «для сравнения» показывают, что было бы без защиты или без новых команд, и в выборе не участвуют.</p>
          <h4 className="h4">Варианты решения</h4>
          <ul className="options">
            {choices.map((o) => <OptionCard key={o.option} o={o} best={best} maxHarm={maxHarm} baseline={false} />)}
          </ul>
          {baselines.length > 0 && (
            <>
              <h4 className="h4">Для сравнения</h4>
              <ul className="options">
                {baselines.map((o) => <OptionCard key={o.option} o={o} best={best} maxHarm={maxHarm} baseline />)}
              </ul>
            </>
          )}
          <SeriesChart title="Как меняется обстановка" lines={lines} total={total} />
          {audit && (
            <div className={`callout ${audit.includes("пересмотреть") ? "callout-warn" : "callout-ok"}`}>
              <CheckCircle2 size={20} aria-hidden />
              <p><strong>Проверка ПЛА.</strong> {audit}</p>
            </div>
          )}
        </>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}

// ---------------------------------------------------------------------------
type Run = {
  mode: string; title: string; detected_at?: number | null; position?: string | null; refined_from?: string | null;
  actions_at?: number | null; done_at?: number | null; faults?: number; people_safe: number; people_total: number;
  people_at_risk: number; people_at_risk_max?: number; people_injured: number; max_fed: number; smoke_person_min: number;
  fire_mw_max?: number; fire_mw_end?: number; lost_t?: number; series?: Point[];
};

const RUN_STYLE: Record<string, { color: string; dash: string }> = {
  auto: { color: COLORS.ok, dash: "" },
  manual: { color: COLORS.warn, dash: "6 4" },
  off: { color: COLORS.alarm, dash: "2 4" },
  auto_normal: { color: COLORS.info, dash: "10 4 2 4" },
};

/** Seconds after ignition -> "4 мин 45 с". */
function sinceIgnition(s: number | null | undefined) {
  if (s === null || s === undefined) return "—";
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return m ? `${m} мин${r ? ` ${r} с` : ""}` : `${r} с`;
}

function StudyBlock({ things, scenarios, faultNames, choice, picked }: {
  things: Record<string, Thing>; scenarios: Record<string, { title: string }>; faultNames: Record<string, string>;
  choice: string; picked: string[];
}) {
  const act = useAction();
  const [asked, setAsked] = useState<number | null>(null);
  const st = things.advisor?.features?.study?.properties ?? {};
  const value = String(st.value ?? "idle");
  const runs = parseJson<Run[]>(st.runs, []);
  const waiting = asked !== null && st.seq !== asked;
  const running = waiting || value === "running";
  const ask = () => {
    const seq = Date.now();
    setAsked(seq);
    act.run(() => putDesired("control", "study", { scenario: choice, faults: picked, seq }));
  };
  const stFaults = Array.isArray(st.faults) ? (st.faults as string[]) : [];
  const total = Math.max(0, ...runs.map((r) => r.people_total ?? 0));
  const lines: Line[] = runs.map((r) => ({
    id: r.mode, title: r.title, series: r.series ?? [], ...(RUN_STYLE[r.mode] ?? { color: COLORS.equip, dash: "1 3" }), strong: r.mode === "auto",
  }));
  return (
    <section className="study" aria-labelledby="study-h">
      <h3 id="study-h" className="h3">Сравнить режимы защиты</h3>
      <p className="hint">
        Выбранный сценарий с отмеченными отказами прогоняется на копии модели: ПАЗ в автоматическом режиме, ручной режим
        (диспетчер через 5 мин), без ПАЗ; если позиция требует реверса — ещё та же ПАЗ без реверса. 30 мин после воспламенения,
        живая шахта не меняется.
      </p>
      <button className="btn btn-primary" disabled={running || act.busy} onClick={ask}>
        {running ? <Loader2 size={18} aria-hidden className="spin" /> : <Scale size={18} aria-hidden />}
        {running ? "Идёт расчёт…" : "Сравнить режимы защиты"}
      </button>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <div aria-live="polite">
        {running && <p className="muted">Прогоны на копии модели занимают 3–6 с.</p>}
        {!running && value === "error" && (
          <div className="callout callout-alarm" role="alert">
            <XCircle size={20} aria-hidden />
            <p>Расчёт не выполнен{st.message ? `: ${String(st.message)}` : ""}. Проверьте сценарий и повторите запрос.</p>
          </div>
        )}
        {!running && value === "done" && runs.length > 0 && (
          <div className="study-result">
            <p className="study-head">
              <strong>{scenarios[String(st.scenario)]?.title ?? String(st.scenario ?? "")}</strong>
              {stFaults.length > 0 && <span className="muted"> · отказы: {stFaults.map((f) => faultNames[f] ?? f).join("; ")}</span>}
              {typeof st.compute_time === "number" && <span className="muted"> · расчёт {fmt(st.compute_time, 1)} с</span>}
            </p>
            <ul className="options">
              {runs.map((r) => {
                const riskMax = r.people_at_risk_max ?? r.people_at_risk;
                const s = RUN_STYLE[r.mode] ?? { color: COLORS.equip, dash: "1 3" };
                return (
                  <li key={r.mode} className={r.mode === "auto" ? "is-best" : r.mode === "off" ? "is-baseline" : ""}>
                    <span className="opt-title">
                      <svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={s.color} strokeWidth="3" strokeDasharray={s.dash} /></svg>
                      {r.title}
                    </span>
                    <dl className="opt-facts">
                      <div><dt>обнаружение</dt><dd>{sinceIgnition(r.detected_at)}</dd></div>
                      <div><dt>первые команды</dt><dd>{r.actions_at !== null && r.actions_at !== undefined ? sinceIgnition(r.actions_at) : "не выдавались"}</dd></div>
                      <div><dt>позиция ПЛА</dt><dd>{r.position ? `${posLabel(r.position)}${r.refined_from ? ` (из ${posLabel(r.refined_from)})` : ""}` : "—"}</dd></div>
                      <div><dt>в безопасности</dt><dd>{r.people_safe}/{r.people_total}</dd></div>
                      <div><dt>под угрозой (макс.)</dt><dd className={riskMax ? "t-warn" : ""}>{r.people_at_risk} ({riskMax})</dd></div>
                      <div><dt>пострадали</dt><dd className={r.people_injured ? "t-alarm" : ""}>{r.people_injured}</dd></div>
                      <div><dt>FED макс.</dt><dd className={r.max_fed >= 0.3 ? "t-warn" : ""}>{fmt(r.max_fed, 2)}</dd></div>
                      <div><dt>в дыму</dt><dd>{fmt(r.smoke_person_min)} чел.·мин</dd></div>
                      <div><dt>очаг макс. / в конце</dt><dd>{fmt(r.fire_mw_max, 1)} / {fmt(r.fire_mw_end, 1)} МВт</dd></div>
                      {!!r.faults && <div><dt>отказы исполнения</dt><dd className="t-alarm">{r.faults}</dd></div>}
                    </dl>
                  </li>
                );
              })}
            </ul>
            <SeriesChart title="Ход аварии по режимам" lines={lines} total={total} />
          </div>
        )}
      </div>
    </section>
  );
}

export function ScenarioPanel() {
  const { things } = useStore();
  const act = useAction();
  const scenarios = (attr<Record<string, { title: string; text: string; faults?: string[] }>>(things, "control", "scenarios")) ?? {};
  const faults = (attr<Record<string, string>>(things, "control", "faults")) ?? {};
  const active = String(prop(things, "control", "scenario") ?? "normal");
  const activeFaults = (prop<string[]>(things, "control", "scenario", "faults")) ?? [];
  const speed = Number(prop(things, "control", "speed") ?? 10);
  const [choice, setChoiceRaw] = useState<string>("bev_lhd");
  const [picked, setPicked] = useState<string[]>([]);
  const setChoice = (k: string) => {
    setChoiceRaw(k);
    setPicked(scenarios[k]?.faults ?? []);
  };
  const toggle = (f: string) => setPicked((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]));
  return (
    <section aria-labelledby="sc-h" className="panel-body">
      <h2 id="sc-h" className="h2">Сценарии «что если»</h2>
      <p className="hint">
        Сейчас: <strong>{active === "normal" ? "штатная работа" : scenarios[active]?.title ?? active}</strong>
        {activeFaults.length > 0 && <> · отказы: {activeFaults.map((f) => faults[f] ?? f).join("; ")}</>}
      </p>
      <fieldset className="choices">
        <legend className="h3">Аварийная ситуация</legend>
        {Object.entries(scenarios).map(([k, s]) => (
          <label key={k} className={`choice${choice === k ? " is-on" : ""}`}>
            <input type="radio" name="scenario" value={k} checked={choice === k} onChange={() => setChoice(k)} />
            <span className="choice-title">{s.title}</span>
            <span className="choice-text">{s.text}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="choices">
        <legend className="h3">Отказы защиты (добавить к сценарию)</legend>
        {Object.entries(faults).map(([k, t]) => (
          <label key={k} className="check">
            <input type="checkbox" checked={picked.includes(k)} onChange={() => toggle(k)} />
            <span>{t}</span>
          </label>
        ))}
      </fieldset>
      <div className="actions">
        <button className="btn btn-primary" disabled={act.busy} onClick={() => act.run(() => putDesired("control", "scenario", { value: choice, faults: picked, seq: Date.now() }))}>
          <Play size={18} aria-hidden /> Запустить сценарий
        </button>
        <button className="btn btn-ghost" disabled={act.busy} onClick={() => act.run(() => putDesired("control", "scenario", { value: "normal", faults: [], seq: Date.now() }))}>
          <RotateCcw size={18} aria-hidden /> Сброс в норму
        </button>
      </div>
      <fieldset className="segmented" aria-label="Скорость модели">
        <legend className="h3">Скорость модельного времени</legend>
        {[1, 10, 30, 60].map((s) => (
          <label key={s} className={speed === s ? "is-on" : ""}>
            <input type="radio" name="speed" checked={speed === s} onChange={() => act.run(() => putDesired("control", "speed", { value: s }))} />
            {s}×
          </label>
        ))}
      </fieldset>
      {act.error && <p className="error" role="alert">{act.error}</p>}
      <StudyBlock things={things} scenarios={scenarios} faultNames={faults} choice={choice} picked={picked} />
    </section>
  );
}

// ---------------------------------------------------------------------------
export function LogPanel({ onShow }: { onShow: (twin: string) => void }) {
  const { things } = useStore();
  const rows = eventRows(things);
  return (
    <section aria-labelledby="log-h" className="panel-body">
      <h2 id="log-h" className="h2">Журнал событий</h2>
      {rows.length > 0 && <p className="hint">Строка со ссылкой показывает объект на модели и открывает его карточку.</p>}
      {rows.length === 0 ? (
        <div className="empty"><Clock3 size={22} aria-hidden /><p>Событий пока нет. Запустите сценарий на вкладке «Сценарии».</p></div>
      ) : (
        <ol className="log" aria-live="polite">
          {rows.map((r, i) => (
            <li key={i} className={r.alarm ? "log-alarm" : ""}>
              <time>{clock(r.t, true)}</time>
              <span className={`log-src log-${r.src === "ПАЗ" ? "paz" : "sim"}`}>{r.src}</span>
              {r.twin ? (
                <button type="button" className="link" onClick={() => onShow(r.twin!)} title="Показать на модели">{r.text}</button>
              ) : (
                <span>{r.text}</span>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
const CONTROLS: Record<string, { feature: string; options: [unknown, string][] }> = {
  "fire-door": { feature: "position", options: [["closed", "Закрыть дверь"], ["open", "Открыть дверь"]] },
  valve: { feature: "position", options: [["open", "Открыть клапан"], ["closed", "Закрыть клапан"]] },
  substation: { feature: "power", options: [["off", "Отключить питание"], ["on", "Включить питание"]] },
  fan: { feature: "mode", options: [["reverse", "Реверс вентилятора"], ["normal", "Нормальный режим"]] },
  conveyor: { feature: "command", options: [["stop", "Остановить конвейер"], ["run", "Пустить конвейер"]] },
  crusher: { feature: "command", options: [["stop", "Остановить дробилку"], ["run", "Пустить дробилку"]] },
};

const KIND_LABEL: Record<string, string> = {
  "fire-door": "Противопожарная дверь", valve: "Клапан", substation: "Подстанция", fan: "Вентилятор ГВУ",
  conveyor: "Конвейер", crusher: "Дробилка", "gas-station": "Газоаналитический узел", crew: "Бригада",
  lhd: "Погрузочно-доставочная машина", truck: "Шахтный самосвал", drill: "Буровая установка", bolter: "Установка крепления",
  refuge: "Камера-убежище", airway: "Горная выработка", charger: "Зарядная станция", depot: "Склад ГСМ", hoist: "Подъём",
  shaft: "Ствол", horizon: "Горизонт", "fan-station": "Главная вентиляторная установка", "fire-main": "Пожарный трубопровод",
};

/** Feature name -> label shown in the card; the unit comes from the twin. */
const FEATURE_LABEL: Record<string, string> = {
  position: "Положение", closed: "Закрыта на", opening: "Открыт на", state: "Состояние", power: "Питание", load: "Нагрузка",
  co: "CO", temperature: "Температура", visibility: "Видимость", velocity: "Скорость воздуха", airflow: "Расход воздуха",
  co_max: "CO макс.", visibility_min: "Видимость мин.", temp_max: "Температура макс.", people: "Людей", location: "Местонахождение",
  fed: "Доза FED", self_rescuer: "Самоспасатели", speed: "Скорость", evac_time: "Время выхода", battery: "Заряд батареи",
  payload: "Груз", trips: "Рейсов", fire_alarm: "Пожарная сигнализация", suppression: "Бортовое пожаротушение", command: "Команда",
  throughput: "Производительность", bin: "Бункер", hours: "Наработка", rotation: "Направление вращения", run: "В работе",
  mode: "Режим", occupants: "Внутри", pressure: "Давление", drilled: "Пробурено", bolts: "Установлено анкеров",
  fuel_line: "Топливопровод", queue: "Ожидают подъёма", lifted: "Поднято", hoisted: "Выдано руды", pocket: "Дозаторный бункер",
  alarms: "Тревог", power_kw: "Мощность", active_fan: "Работает", sim_time: "Модельное время",
};

const BOOL_TEXT: Record<string, [string, string]> = {
  fire_alarm: ["пожар", "нет сигнала"],
  run: ["да", "нет"],
};

function valueText(things: Record<string, Thing>, f: string, p: Record<string, unknown> | undefined) {
  if (!p) return "—";
  const v = p.value;
  if (v === undefined || v === null || v === "") return "—";
  if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) return "данные";
  if (f === "location") {
    const aw = String(p.airway ?? v);
    return String(things["aw-" + aw]?.attributes?.name ?? aw);
  }
  if (f === "self_rescuer") return v === "on" ? `включены, запас ${fmt(p.remaining_min)} мин` : `не включены, запас ${fmt(p.remaining_min)} мин`;
  if (f === "active_fan") return String(things[String(v)]?.attributes?.name ?? stateLabel(v)[0]);
  if (f === "evac_time" && typeof v === "number") return `${Math.floor(v / 60)} мин ${Math.round(v % 60)} с`;
  const unit = p.unit && p.unit !== "x" ? ` ${p.unit}` : "";
  if (typeof v === "number") return `${fmt(v, Number.isInteger(v) ? 0 : f === "fed" ? 3 : 1)}${unit}`;
  if (typeof v === "boolean") return (BOOL_TEXT[f] ?? ["да", "нет"])[v ? 0 : 1];
  return `${stateLabel(v)[0]}${unit}`;
}

export function Inspector({ name, onClose }: { name: string; onClose: () => void }) {
  const { things } = useStore();
  const act = useAction();
  const t: Thing | undefined = things[name];
  if (!t) return null;
  const kind = String(t.attributes.kind ?? "");
  const ctl = CONTROLS[kind];
  const feats = Object.entries(t.features ?? {}).filter(([f]) => !["smoke", "events", "fire_truth", "log", "commands", "options", "estimate"].includes(f));
  const ctlState = ctl ? t.features?.[ctl.feature]?.properties?.value : undefined;
  return (
    <section className="inspector" aria-labelledby="ins-h">
      <div className="row-between ins-head">
        <div>
          <h2 id="ins-h" className="h3">{String(t.attributes.name ?? name)}</h2>
          <p className="muted">{KIND_LABEL[kind] ?? "Объект"} · <span className="mono">{t.thingId}</span></p>
        </div>
        <button className="btn btn-icon" onClick={onClose} aria-label="Закрыть карточку объекта" title="Закрыть карточку (Esc)">
          <X size={20} aria-hidden />
        </button>
      </div>
      <dl className="ins-grid">
        {feats.slice(0, 12).map(([f, v]) => (
          <div key={f}>
            <dt>{FEATURE_LABEL[f] ?? f}</dt>
            <dd>
              {valueText(things, f, v.properties)}
              {v.desiredProperties?.value !== undefined && v.desiredProperties.value !== v.properties?.value && (
                <span className="muted"> → команда: {String(stateLabel(v.desiredProperties.value)[0])}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {ctl && (
        <div className="actions" role="group" aria-label="Команды диспетчера">
          {ctl.options.map(([v, l]) => (
            <button key={String(v)} className="btn btn-ghost" disabled={act.busy || ctlState === v}
              onClick={() => act.run(() => putDesired(name, ctl.feature, { value: v, by: "dispatcher" }))}>
              {l}
            </button>
          ))}
        </div>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}
