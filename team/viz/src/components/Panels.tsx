import { useState } from "react";
import { AlertTriangle, CheckCircle2, Circle, Clock3, Loader2, Play, RotateCcw, ShieldCheck, XCircle, Calculator } from "lucide-react";
import { attr, clock, parseJson, prop, putDesired, Thing, useStore } from "../data/store";
import { fmt, stateLabel, Tone, TONE_COLOR } from "../data/status";
import { HORIZONS } from "../data/geometry";

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

export function PazPanel() {
  const { things } = useStore();
  const act = useAction();
  const state = String(prop(things, "paz", "state") ?? "standby");
  const mode = String(prop(things, "paz", "mode") ?? "auto");
  const title = String(prop(things, "paz", "position", "title") ?? "");
  const cmds = parseJson<Cmd[]>(prop(things, "paz", "commands"), []);
  const detected = prop<number>(things, "paz", "detected_at");
  const resp = prop<number>(things, "paz", "response_time");
  const awaiting = state === "awaiting_dispatcher";
  return (
    <section aria-labelledby="paz-h" className="panel-body">
      <div className="row-between">
        <h2 id="paz-h" className="h2">Противоаварийная защита</h2>
        <Chip state={state === "standby" ? "standby_paz" : state} />
      </div>
      <fieldset className="segmented" aria-label="Режим ПАЗ">
        <legend className="sr-only">Режим ПАЗ</legend>
        {(["auto", "manual"] as const).map((m) => (
          <label key={m} className={mode === m ? "is-on" : ""}>
            <input
              type="radio"
              name="paz-mode"
              value={m}
              checked={mode === m}
              onChange={() => act.run(() => putDesired("control", "paz_mode", { value: m }))}
            />
            {m === "auto" ? "Автоматический" : "Ручной (через диспетчера)"}
          </label>
        ))}
      </fieldset>
      <p className="hint">
        {mode === "auto"
          ? "Команды позиции ПЛА уходят на исполнительные органы сразу после обнаружения."
          : "ПАЗ готовит позицию ПЛА, но ждёт подтверждения диспетчера (или его реакции через 5 мин модельного времени)."}
      </p>
      {state === "standby" ? (
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
              <p>Сигнал: {String(prop(things, "paz", "trigger") ?? "—")}. Обнаружено в {clock(detected, true)}{resp !== null && resp !== undefined ? `, отработано за ${resp} с` : ""}.</p>
            </div>
          </div>
          {awaiting && (
            <button className="btn btn-primary btn-block" disabled={act.busy} onClick={() => act.run(() => putDesired("control", "paz_confirm", { seq: Date.now() }))}>
              <ShieldCheck size={18} aria-hidden /> Подтвердить позицию ПЛА
            </button>
          )}
          <ol className="cmd-list">
            {cmds.map((c, i) => (
              <li key={i} className={`cmd cmd-${c.status}`}>
                {CMD_ICON[c.status] ?? <Circle size={18} aria-hidden />}
                <span className="cmd-note">{c.note}</span>
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
type Option = {
  option: string; title: string; people_safe: number; people_total: number; people_at_risk: number;
  people_injured: number; max_fed: number; smoke_person_min: number; harm: number; fire_mw: number;
};

export function AdvisorPanel() {
  const { things } = useStore();
  const act = useAction();
  const state = String(prop(things, "advisor", "state") ?? "normal");
  const options = parseJson<Option[]>(prop(things, "advisor", "options"), []);
  const est = parseJson<{ label: string; hrr_mw: number; confidence: number; sensors: string[]; edge: string; held?: boolean } | null>(prop(things, "advisor", "estimate"), null);
  const best = String(prop(things, "advisor", "best_option") ?? "");
  const rec = String(prop(things, "advisor", "recommendation") ?? "");
  const audit = String(prop(things, "advisor", "audit") ?? "");
  const at = prop<number>(things, "advisor", "computed_at");
  const maxHarm = Math.max(1, ...options.map((o) => o.harm));
  const awName = est ? String(attr(things, "aw-" + est.edge, "name") ?? est.edge) : "";
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
              <div><dt>Оценка мощности</dt><dd>{fmt(est.hrr_mw, 1)} МВт ({est.held ? "по кривой развития пожара" : `по CO на ${est.sensors[0] ?? "—"}`})</dd></div>
            </dl>
          )}
          <div className="callout callout-info">
            <ShieldCheck size={20} aria-hidden />
            <p>{rec}</p>
          </div>
          <h3 className="h3">Прогноз на 30 минут {at !== undefined && <span className="muted">(от {clock(at)})</span>}</h3>
          <ul className="options">
            {options.map((o) => (
              <li key={o.option} className={o.option === best ? "is-best" : ""}>
                <div className="row-between">
                  <span className="opt-title">{o.title}{o.option === best && <span className="chip chip-ok">рекомендовано</span>}</span>
                </div>
                <div className="harm">
                  <span className="harm-label">индекс ущерба <span className="mono">{Math.round(o.harm)}</span></span>
                  <div className="bar" aria-hidden>
                    <span style={{ width: `${o.harm > 0 ? Math.max(3, (o.harm / maxHarm) * 100) : 0}%` }} className={o.people_injured ? "bar-alarm" : o.people_at_risk ? "bar-warn" : o.harm > 0 ? "bar-smoke" : "bar-ok"} />
                  </div>
                </div>
                <dl className="opt-facts">
                  <div><dt>в безопасности</dt><dd>{o.people_safe}/{o.people_total}</dd></div>
                  <div><dt>под угрозой</dt><dd className={o.people_at_risk ? "t-warn" : ""}>{o.people_at_risk}</dd></div>
                  <div><dt>FED макс.</dt><dd className={o.max_fed >= 0.3 ? "t-warn" : ""}>{o.max_fed.toFixed(2)}</dd></div>
                  <div><dt>в дыму</dt><dd>{o.smoke_person_min} чел.·мин</dd></div>
                </dl>
              </li>
            ))}
          </ul>
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
export function ScenarioPanel() {
  const { things } = useStore();
  const act = useAction();
  const scenarios = (attr<Record<string, { title: string; text: string }>>(things, "control", "scenarios")) ?? {};
  const faults = (attr<Record<string, string>>(things, "control", "faults")) ?? {};
  const active = String(prop(things, "control", "scenario") ?? "normal");
  const activeFaults = (prop<string[]>(things, "control", "scenario", "faults")) ?? [];
  const speed = Number(prop(things, "control", "speed") ?? 10);
  const [choice, setChoice] = useState<string>("bev_lhd");
  const [picked, setPicked] = useState<string[]>([]);
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
    </section>
  );
}

// ---------------------------------------------------------------------------
export function LogPanel() {
  const { things } = useStore();
  const sim = parseJson<[number, string][]>(prop(things, "control", "events"), []).map(([t, e]) => ({ t, e, src: "Шахта" }));
  const paz = parseJson<[number, string][]>(prop(things, "paz", "log"), []).map(([t, e]) => ({ t, e, src: "ПАЗ" }));
  const rows = [...sim, ...paz].sort((a, b) => b.t - a.t).slice(0, 60);
  return (
    <section aria-labelledby="log-h" className="panel-body">
      <h2 id="log-h" className="h2">Журнал событий</h2>
      {rows.length === 0 ? (
        <div className="empty"><Clock3 size={22} aria-hidden /><p>Событий пока нет. Запустите сценарий на вкладке «Сценарии».</p></div>
      ) : (
        <ol className="log" aria-live="polite">
          {rows.map((r, i) => (
            <li key={i} className={/ОТКАЗ|Возгорание|недопустим|пострадал/i.test(r.e) ? "log-alarm" : ""}>
              <time>{clock(r.t, true)}</time>
              <span className={`log-src log-${r.src === "ПАЗ" ? "paz" : "sim"}`}>{r.src}</span>
              <span>{r.e}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
const CONTROLS: Record<string, { feature: string; options: [unknown, string][] }> = {
  "fire-door": { feature: "position", options: [["closed", "Закрыть"], ["open", "Открыть"]] },
  valve: { feature: "position", options: [["open", "Открыть"], ["closed", "Закрыть"]] },
  substation: { feature: "power", options: [["off", "Отключить"], ["on", "Включить"]] },
  fan: { feature: "mode", options: [["reverse", "Реверс"], ["normal", "Нормальный режим"]] },
  conveyor: { feature: "command", options: [["stop", "Остановить"], ["run", "Пустить"]] },
  crusher: { feature: "command", options: [["stop", "Остановить"], ["run", "Пустить"]] },
};

function valueText(p: Record<string, unknown> | undefined) {
  if (!p) return "—";
  const v = p.value;
  if (typeof v === "string" && (v.startsWith("{") || v.startsWith("["))) return "данные";
  const [label] = stateLabel(v);
  const txt = typeof v === "number" ? fmt(v, Number.isInteger(v) ? 0 : 2) : typeof v === "boolean" ? (v ? "да" : "нет") : label;
  return `${txt}${p.unit ? ` ${p.unit}` : ""}`;
}

export function Inspector({ name, onClose }: { name: string; onClose: () => void }) {
  const { things } = useStore();
  const act = useAction();
  const t: Thing | undefined = things[name];
  if (!t) return null;
  const kind = String(t.attributes.kind ?? "");
  const ctl = CONTROLS[kind];
  const feats = Object.entries(t.features ?? {}).filter(([f]) => !["smoke", "events", "fire_truth", "log", "commands", "options", "estimate"].includes(f));
  return (
    <section className="inspector" aria-labelledby="ins-h">
      <div className="row-between">
        <div>
          <h2 id="ins-h" className="h3">{String(t.attributes.name ?? name)}</h2>
          <p className="muted mono">{t.thingId}</p>
        </div>
        <button className="btn btn-ghost" onClick={onClose} aria-label="Закрыть карточку объекта">Закрыть</button>
      </div>
      <dl className="ins-grid">
        {feats.slice(0, 12).map(([f, v]) => (
          <div key={f}>
            <dt>{f}</dt>
            <dd>{valueText(v.properties)}{v.desiredProperties?.value !== undefined && <span className="muted"> → {String(stateLabel(v.desiredProperties.value)[0])}</span>}</dd>
          </div>
        ))}
      </dl>
      {ctl && (
        <div className="actions">
          {ctl.options.map(([v, l]) => (
            <button key={String(v)} className="btn btn-ghost" disabled={act.busy} onClick={() => act.run(() => putDesired(name, ctl.feature, { value: v, by: "dispatcher" }))}>
              {l}
            </button>
          ))}
        </div>
      )}
      {act.error && <p className="error" role="alert">{act.error}</p>}
    </section>
  );
}
