import { useEffect, useState } from "react";
import { Activity, Box, Map as MapIcon, WifiOff } from "lucide-react";
import { clock, connect, prop, useStore } from "./data/store";
import { HORIZONS } from "./data/geometry";
import { COLORS } from "./data/status";
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

function Legend() {
  const items: [string, string, string][] = [
    [COLORS.air, "bar", "свежая струя"],
    [COLORS.smoke, "bar", "задымление"],
    ["#d7e6f5", "arrow", "направление струи"],
    [COLORS.white, "dot", "бригада работает"],
    [COLORS.info, "dot", "выходит"],
    [COLORS.ok, "dot", "в безопасности"],
    [COLORS.warn, "dot", "под угрозой"],
    [COLORS.alarm, "sq", "авария / отказ"],
  ];
  return (
    <ul className="legend" aria-label="Условные обозначения">
      {items.map(([c, k, t]) => (
        <li key={t}><i className={`lg lg-${k}`} style={{ background: c }} aria-hidden />{t}</li>
      ))}
    </ul>
  );
}

export function App() {
  const { things, status, lastUpdate } = useStore();
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

  useEffect(() => {
    connect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input, textarea, select")) return;
      const i = ["1", "2", "3", "4"].indexOf(e.key);
      if (i >= 0) {
        setView(VIEWS[i].id);
        if (i > 0) setHorizon(VIEWS[i].id);
      }
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
              {(mode === "3d" ? VIEWS : VIEWS.slice(1)).map((v, i) => {
                const on = mode === "3d" ? view === v.id : horizon === v.id;
                return (
                  <button key={v.id} aria-pressed={on} className={on ? "is-on" : ""} title={`Клавиша ${mode === "3d" ? i + 1 : i + 2}`}
                    onClick={() => (mode === "3d" ? setView(v.id) : setHorizon(v.id))}>
                    {v.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="stage-view">
            {loading ? (
              <div className="skeleton-stage" aria-busy="true"><p>Подключение к Ditto…</p></div>
            ) : mode === "3d" ? (
              <Scene3D selected={selected} onSelect={setSelected} view={view} viewNonce={viewNonce} />
            ) : (
              <Mnemonic horizon={horizon} selected={selected} onSelect={setSelected} />
            )}
            {mode === "3d" && !loading && <p className="stage-hint muted">Вертикальный масштаб условный: стволы сжаты, горизонты раздвинуты. Перетаскивание — вращение, колесо — масштаб.</p>}
          </div>
          {selected ? <Inspector name={selected} onClose={() => setSelected(null)} /> : <Legend />}
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
            ) : tab === "status" ? <StatusPanel /> : tab === "paz" ? <PazPanel /> : tab === "advisor" ? <AdvisorPanel /> : tab === "scenarios" ? <ScenarioPanel /> : <LogPanel />}
          </div>
        </aside>
      </main>
      <footer className="foot muted">
        Данные: Eclipse Ditto (OpenEgiz) · {HORIZONS.length} горизонта · {Object.keys(things).length} двойников
      </footer>
    </div>
  );
}
