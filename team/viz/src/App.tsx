import { useEffect, useMemo, useState } from "react";
import { Activity, Box, Crosshair, Flame, Map as MapIcon, WifiOff } from "lucide-react";
import { clock, connect, prop, useStore } from "./data/store";
import { airways, fireSpot, HORIZONS } from "./data/geometry";
import { COLORS, fmt, smokeColor, stateLabel } from "./data/status";
import { eventRows } from "./data/events";
import { Scene3D } from "./components/Scene3D";
import { Mnemonic } from "./components/Mnemonic";
import { AdvisorPanel, Chip, Inspector, LogPanel, PazPanel, ScenarioPanel, StatusPanel } from "./components/Panels";
import type { ViewPreset } from "./scene/MineScene";

const TABS = [
  { id: "status", label: "Обстановка" },
  { id: "paz", label: "ПАЗ" },
  { id: "advisor", label: "Советчик" },
  { id: "scenarios", label: "Сценарии" },
  { id: "log", label: "Журнал" },
] as const;
type Tab = (typeof TABS)[number]["id"];

const VIEWS: { id: ViewPreset; label: string }[] = [
  { id: "overview", label: "Вся шахта" },
  { id: "h-480", label: "−480" },
  { id: "h-560", label: "−560" },
  { id: "h-640", label: "−640" },
];

const FOLLOW_KEY = "bolashak.follow";

function useNarrow() {
  const q = "(max-width: 640px)";
  const [narrow, setNarrow] = useState(() => window.matchMedia(q).matches);
  useEffect(() => {
    const m = window.matchMedia(q);
    const on = () => setNarrow(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return narrow;
}

function Swatch({ kind, color }: { kind: string; color?: string }) {
  if (kind === "smoke") {
    const stops = [0, 0.25, 0.6, 1].map((s, i) => <stop key={i} offset={`${(i / 3) * 100}%`} stopColor={smokeColor(s === 0 ? 0 : s)} />);
    return (
      <svg width="64" height="10" aria-hidden>
        <defs><linearGradient id="lg-smoke">{stops}</linearGradient></defs>
        <rect width="64" height="10" rx="3" fill="url(#lg-smoke)" />
      </svg>
    );
  }
  if (kind === "arrow") return <svg width="18" height="12" aria-hidden><path d="M2 1 L16 6 L2 11 Z" fill={color} /></svg>;
  if (kind === "route") return <svg width="26" height="12" aria-hidden><path d="M1 6 H17" stroke={color} strokeWidth="3" /><path d="M16 1 L25 6 L16 11 Z" fill={color} /></svg>;
  if (kind === "fire") return <svg width="14" height="16" aria-hidden><path d="M7 1 C9 5 13 7 13 11 A6 5 0 0 1 1 11 C1 8 4 7 4 4 C5 6 6 6 7 1 Z" fill={color} /></svg>;
  if (kind === "ring") return <svg width="16" height="16" aria-hidden><circle cx="8" cy="8" r="6" fill="none" stroke={color} strokeWidth="2.5" /></svg>;
  if (kind === "person") return <svg width="12" height="16" aria-hidden><circle cx="6" cy="4" r="3" fill={color} /><path d="M2 15 L3 8 H9 L10 15 Z" fill={color} /></svg>;
  return <i className="lg lg-sq" style={{ background: color }} aria-hidden />;
}

function Legend({ narrow }: { narrow: boolean }) {
  const groups: { title: string; items: [string, string | undefined, string][] }[] = [
    {
      title: "Воздух",
      items: [
        ["smoke", undefined, "задымление: видимость 50 → 15 → 7 → менее 5 м"],
        ["arrow", "#e6eef7", "направление струи"],
        ["arrow", "#ffcf66", "реверс струи"],
      ],
    },
    {
      title: "Авария",
      items: [
        ["fire", COLORS.alarm, "очаг пожара"],
        ["ring", COLORS.warn, "оценка советчика"],
        ["route", COLORS.route, "маршрут выхода"],
        ["sq", COLORS.alarm, "авария, отказ"],
        ["sq", COLORS.info, "закрыто / отключено"],
      ],
    },
    {
      title: "Люди",
      items: [
        ["person", COLORS.white, "работают"],
        ["person", COLORS.info, "выходят"],
        ["person", COLORS.ok, "в безопасности"],
        ["person", COLORS.warn, "под угрозой"],
        ["person", COLORS.alarm, "пострадали"],
      ],
    },
  ];
  return (
    <details className="legend-wrap" open={!narrow}>
      <summary>Условные обозначения</summary>
      <div className="legend">
        {groups.map((g) => (
          <ul key={g.title} aria-label={g.title}>
            {g.items.map(([k, c, t]) => (
              <li key={t}><Swatch kind={k} color={c} />{t}</li>
            ))}
          </ul>
        ))}
      </div>
    </details>
  );
}

function Hud({ onShow }: { onShow: (twin: string) => void }) {
  const { things } = useStore();
  const count = Object.keys(things).length;
  const aws = useMemo(() => airways(things), [count]); // eslint-disable-line react-hooks/exhaustive-deps
  const scenario = String(prop(things, "control", "scenario") ?? "normal");
  const emergency = String(prop(things, "mine", "emergency") ?? "normal");
  if (scenario === "normal" && emergency === "normal") return null;
  const scenarios = (things.control?.attributes?.scenarios as Record<string, { title: string }> | undefined) ?? {};
  const started = prop<number>(things, "control", "scenario", "started");
  const simT = prop<number>(things, "mine", "sim_time");
  const elapsed = started !== undefined && started !== null && simT !== undefined ? Math.max(0, simT - started) : null;
  const spot = fireSpot(things, aws);
  const vent = String(prop(things, "gvu", "mode") ?? "normal");
  const safe = prop<number>(things, "mine", "people_safe") ?? 0;
  const total = prop<number>(things, "mine", "people_total") ?? 0;
  const evac = prop<number>(things, "mine", "people_evacuating") ?? 0;
  const risk = (prop<number>(things, "mine", "people_at_risk") ?? 0) + (prop<number>(things, "mine", "people_injured") ?? 0);
  const rows = eventRows(things, 2);
  const mm = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <section className="hud" aria-label="Ход аварии" aria-live="polite">
      <p className="hud-title">
        <Flame size={16} aria-hidden /> {scenarios[scenario]?.title ?? "Аварийный режим"}
        {elapsed !== null && <span className="mono muted"> · t+{mm(elapsed)}</span>}
      </p>
      <dl className="hud-facts">
        <div><dt>Очаг</dt><dd>{spot ? `${fmt(spot.hrr, 1)} МВт` : "не горит"}</dd></div>
        <div><dt>Вентиляция</dt><dd className={vent === "reverse" ? "t-warn" : ""}>{vent === "reverse" ? "реверс" : stateLabel(vent)[0]}</dd></div>
        <div><dt>В безопасности</dt><dd>{safe} из {total}</dd></div>
        <div><dt>Выходят</dt><dd>{evac}</dd></div>
        {risk > 0 && <div><dt>Под угрозой</dt><dd className="t-warn">{risk}</dd></div>}
        {prop(things, "paz", "state") === "disabled" && <div><dt>ПАЗ</dt><dd className="t-alarm">выведена из работы</dd></div>}
      </dl>
      {rows.length > 0 && (
        <ol className="hud-events">
          {rows.map((r, i) => (
            <li key={i} className={r.alarm ? "log-alarm" : ""}>
              <time>{clock(r.t)}</time>
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

export function App() {
  const { things, status, lastUpdate } = useStore();
  const narrow = useNarrow();
  const [tab, setTab] = useState<Tab>("status");
  const [mode, setMode] = useState<"3d" | "2d">("3d");
  const [view, setViewState] = useState<ViewPreset>("overview");
  const [viewNonce, setViewNonce] = useState(0);
  const setView = (v: ViewPreset) => {
    setViewState(v);
    setViewNonce((n) => n + 1);
  };
  const [horizon, setHorizon] = useState("h-560");
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ name: string; nonce: number } | null>(null);
  const [follow, setFollow] = useState(() => localStorage.getItem(FOLLOW_KEY) !== "0");
  const count = Object.keys(things).length;
  const aws = useMemo(() => airways(things), [count]); // eslint-disable-line react-hooks/exhaustive-deps
  const spot = fireSpot(things, aws);
  const seq = String(prop(things, "control", "scenario", "seq") ?? "");

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    localStorage.setItem(FOLLOW_KEY, follow ? "1" : "0");
  }, [follow]);

  // the mnemonic follows the emergency to the burning horizon
  const fireHorizon = spot?.horizon ?? null;
  useEffect(() => {
    if (follow && fireHorizon) setHorizon(fireHorizon);
  }, [follow, fireHorizon, seq]);

  const show = (twin: string) => {
    setSelected(twin);
    setFocus((f) => ({ name: twin, nonce: (f?.nonce ?? 0) + 1 }));
    const h = String(things[twin]?.attributes?._parents ?? "").split(":")[1];
    const z = (things[twin]?.features?.location?.properties?.z ?? things[twin]?.attributes?.z) as number | undefined;
    const hz = HORIZONS.find((x) => x.id === h) ?? (typeof z === "number" ? HORIZONS.find((x) => Math.abs(x.z - z) < 1) : undefined);
    if (hz) setHorizon(hz.id);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i >= 0) {
        setView(VIEWS[i].id);
        if (i > 0) setHorizon(VIEWS[i].id);
      }
      if (e.key === "5") setView("fire");
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const emergency = String(prop(things, "mine", "emergency") ?? "normal");
  const pazState = String(prop(things, "paz", "state") ?? "standby");
  const advState = String(prop(things, "advisor", "state") ?? "normal");
  const simT = prop<number>(things, "mine", "sim_time");
  const speed = prop<number>(things, "control", "speed");
  const loading = status === "loading" && Object.keys(things).length === 0;
  const views = spot ? [...VIEWS, { id: "fire" as ViewPreset, label: "К очагу" }] : VIEWS;

  return (
    <div className={`app emergency-${emergency}`}>
      <a href="#panel" className="skip">К панели управления</a>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden><Activity size={20} /></span>
          <div>
            <h1>Шахта «Болашак»</h1>
            <p className="muted">Донской ГОК · Хромтау · цифровой двойник безопасности</p>
          </div>
        </div>
        <div className="top-status">
          <div className="clock" aria-label="Модельное время">
            <span className="mono">{clock(simT, true)}</span>
            <span className="muted">{speed ? `модель ×${speed}` : ""}</span>
          </div>
          <Chip state={emergency} label={emergency === "normal" ? "штатный режим" : undefined} />
          <span className={`conn conn-${status}`} role="status">
            {status === "live" ? "данные Ditto в реальном времени" : status === "stale" ? `нет обновлений с ${new Date(lastUpdate).toLocaleTimeString("ru-RU")}` : status === "error" ? "нет связи с Ditto" : "подключение…"}
          </span>
        </div>
      </header>

      {status === "error" || status === "stale" ? (
        <div className="banner" role="alert">
          <WifiOff size={18} aria-hidden />
          {status === "error" ? "Нет связи с платформой (Ditto). Повторное подключение каждые 3 с." : "Поток событий прервался, данные обновляются опросом."}
        </div>
      ) : null}

      <main className="layout">
        <section className="stage" aria-label="Модель шахты">
          <div className="stage-bar">
            <div className="segmented" role="tablist" aria-label="Вид">
              <button role="tab" aria-selected={mode === "3d"} className={mode === "3d" ? "is-on" : ""} onClick={() => setMode("3d")}><Box size={16} aria-hidden /> 3D</button>
              <button role="tab" aria-selected={mode === "2d"} className={mode === "2d" ? "is-on" : ""} onClick={() => setMode("2d")}><MapIcon size={16} aria-hidden /> Схема</button>
            </div>
            <div className="segmented" aria-label={mode === "3d" ? "Ракурс" : "Горизонт"}>
              {(mode === "3d" ? views : VIEWS.slice(1)).map((v, i) => {
                const on = mode === "3d" ? view === v.id : horizon === v.id;
                const fire = v.id === "fire";
                return (
                  <button key={v.id} aria-pressed={on} className={`${on ? "is-on" : ""}${fire ? " seg-alarm" : ""}`} title={`Клавиша ${fire ? 5 : mode === "3d" ? i + 1 : i + 2}`}
                    onClick={() => (mode === "3d" ? setView(v.id) : setHorizon(v.id))}>
                    {fire && <Flame size={16} aria-hidden />}
                    {narrow && v.id === "overview" ? "Шахта" : v.label}
                  </button>
                );
              })}
            </div>
            <button type="button" className={`toggle${follow ? " is-on" : ""}`} aria-pressed={follow} onClick={() => setFollow((f) => !f)}
              title="При запуске сценария камера и схема переходят к очагу, после сброса возвращаются к общему виду">
              <Crosshair size={16} aria-hidden /> Следить за аварией
            </button>
          </div>
          {!loading && <Hud onShow={show} />}
          <div className="stage-view">
            {loading ? (
              <div className="skeleton-stage" aria-busy="true"><p>Подключение к Ditto…</p></div>
            ) : mode === "3d" ? (
              <Scene3D selected={selected} onSelect={setSelected} view={view} viewNonce={viewNonce} follow={follow}
                onAutoView={(v) => setViewState(v)} focus={focus} />
            ) : (
              <Mnemonic horizon={horizon} selected={selected} onSelect={setSelected} />
            )}
            {mode === "3d" && !loading && <p className="stage-hint muted">Масштаб условный: стволы сжаты, горизонты раздвинуты, техника и люди увеличены. Перетаскивание — вращение, колесо — масштаб.</p>}
          </div>
          {selected ? <Inspector name={selected} onClose={() => setSelected(null)} /> : <Legend narrow={narrow} />}
        </section>

        <aside className="panel" id="panel" aria-label="Панель диспетчера">
          <div className="tabs" role="tablist" aria-label="Разделы">
            {TABS.map((t) => {
              const badge = (t.id === "paz" && pazState !== "standby") || (t.id === "advisor" && advState === "forecast");
              return (
                <button key={t.id} role="tab" id={`tab-${t.id}`} aria-selected={tab === t.id} aria-controls={`tp-${t.id}`} className={tab === t.id ? "is-on" : ""} onClick={() => setTab(t.id)}>
                  {t.label}
                  {badge && <span className={`dot ${t.id === "paz" && pazState === "awaiting_dispatcher" ? "dot-warn" : "dot-alarm"}`} aria-label="есть события" />}
                </button>
              );
            })}
          </div>
          <div className="tab-panel" role="tabpanel" id={`tp-${tab}`} aria-labelledby={`tab-${tab}`}>
            {loading ? (
              <div className="skeleton" aria-busy="true"><span /><span /><span /><span /></div>
            ) : tab === "status" ? <StatusPanel /> : tab === "paz" ? <PazPanel onShow={show} /> : tab === "advisor" ? <AdvisorPanel onShow={show} /> : tab === "scenarios" ? <ScenarioPanel /> : <LogPanel onShow={show} />}
          </div>
        </aside>
      </main>
      <footer className="foot muted">
        Данные: Eclipse Ditto (OpenEgiz) · {HORIZONS.length} горизонта · {Object.keys(things).length} двойников
      </footer>
    </div>
  );
}
