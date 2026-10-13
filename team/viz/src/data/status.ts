export type Tone = "neutral" | "ok" | "warn" | "alarm" | "info";

export const COLORS = {
  air: "#6f8aa6",
  airDim: "#3d4c5c",
  equip: "#b9c2cf",
  ok: "#3fb68b",
  warn: "#e5a50a",
  alarm: "#ef4b4b",
  info: "#4aa3df",
  smoke: "#9a6b3c",
  smokeLight: "#c8913f",
  smokeMid: "#e8702a",
  smokeDense: "#ff3d1a",
  route: "#4aa3df",
  white: "#e6eaf0",
  grey: "#8592a3",
};

/** Smoke density per airway cell (0..1, from the twin) to visibility, as in the
 * simulator: vis = 3 / (0.6 s + 0.06), capped at 50 m. */
export function smokeVisibility(s: number) {
  return Math.min(50, 3 / (0.6 * Math.max(0, s) + 0.06));
}

const SMOKE_STOPS: [number, string][] = [
  [0.03, COLORS.air],
  [0.25, COLORS.smokeLight],
  [0.6, COLORS.smokeMid],
  [1, COLORS.smokeDense],
];

function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Airway colour by smoke density: steel blue (clear) to amber, orange and red-orange (visibility under 5 m). */
export function smokeColor(s: number) {
  if (s <= SMOKE_STOPS[0][0]) return COLORS.air;
  for (let i = 1; i < SMOKE_STOPS.length; i++) {
    const [s1, c1] = SMOKE_STOPS[i];
    if (s <= s1 || i === SMOKE_STOPS.length - 1) {
      const [s0, c0] = SMOKE_STOPS[i - 1];
      const k = Math.min(1, Math.max(0, (s - s0) / (s1 - s0)));
      const a = hexRgb(c0);
      const b = hexRgb(c1);
      const m = a.map((v, j) => Math.round(v + (b[j] - v) * k));
      return `#${m.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    }
  }
  return COLORS.smokeDense;
}

export const TONE_COLOR: Record<Tone, string> = {
  neutral: COLORS.grey,
  ok: COLORS.ok,
  warn: COLORS.warn,
  alarm: COLORS.alarm,
  info: COLORS.info,
};

const LABELS: Record<string, [string, Tone]> = {
  ok: ["норма", "neutral"],
  warning: ["выше ПДК", "warn"],
  alarm: ["авария", "alarm"],
  fault: ["отказ", "alarm"],
  open: ["открыта", "neutral"],
  closed: ["закрыта", "neutral"],
  opening: ["открывается", "info"],
  closing: ["закрывается", "info"],
  on: ["включено", "neutral"],
  off: ["отключено", "info"],
  running: ["работает", "neutral"],
  starting: ["пуск", "info"],
  stopping: ["останов", "info"],
  standby: ["резерв", "neutral"],
  stopped: ["остановлен", "neutral"],
  reversing: ["реверсирование", "warn"],
  tripped: ["аварийно отключён", "alarm"],
  normal: ["норма", "neutral"],
  reverse: ["реверс", "warn"],
  working: ["работает", "neutral"],
  evacuating: ["выходит", "info"],
  waiting_cage: ["у ствола", "info"],
  in_refuge: ["в убежище", "ok"],
  surface: ["на поверхности", "ok"],
  incapacitated: ["пострадали", "alarm"],
  parked: ["остановлен", "neutral"],
  fire: ["пожар", "alarm"],
  charging: ["замена батареи", "neutral"],
  loading: ["погрузка", "neutral"],
  dumping: ["разгрузка", "neutral"],
  waiting: ["ожидание", "neutral"],
  tramming_loaded: ["с грузом", "neutral"],
  tramming_empty: ["порожняком", "neutral"],
  hauling: ["с грузом", "neutral"],
  returning: ["порожняком", "neutral"],
  low: ["низкое давление", "alarm"],
  ready: ["готов", "neutral"],
  lifting: ["подъём людей", "info"],
  out_of_service: ["не работает", "alarm"],
  idle: ["без нагрузки", "neutral"],
  "de-energized": ["обесточена", "info"],
  standby_paz: ["дежурный режим", "neutral"],
  acting: ["выполняет", "info"],
  awaiting_dispatcher: ["ждёт диспетчера", "warn"],
  completed: ["отработала", "ok"],
  disabled: ["выведена из работы", "alarm"],
  evacuation: ["эвакуация", "alarm"],
  fan_trip: ["остановка ГВУ", "alarm"],
  occupied: ["заняты", "ok"],
  pending: ["в очереди", "neutral"],
  issued: ["отправлена", "info"],
  done: ["выполнено", "ok"],
  drilling: ["бурение", "neutral"],
  bolting: ["крепление", "neutral"],
  isolated: ["перекрыт", "info"],
  auto: ["автоматически", "neutral"],
  manual: ["вручную", "neutral"],
  stop: ["стоп", "info"],
  run: ["пуск", "neutral"],
  none: ["нет", "neutral"],
  forecast: ["прогноз", "info"],
};

export function stateLabel(state: unknown): [string, Tone] {
  const s = String(state ?? "");
  return LABELS[s] ?? [s || "—", "neutral"];
}

export function crewColor(state: string, fed: number) {
  if (state === "incapacitated") return COLORS.alarm;
  if (fed >= 0.3) return COLORS.warn;
  if (state === "in_refuge" || state === "surface") return COLORS.ok;
  if (state === "evacuating" || state === "waiting_cage") return COLORS.info;
  return COLORS.white;
}

export function sensorColor(state: string) {
  if (state === "alarm" || state === "fault") return COLORS.alarm;
  if (state === "warning") return COLORS.warn;
  return COLORS.grey;
}

export function fmt(v: unknown, digits = 0) {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
