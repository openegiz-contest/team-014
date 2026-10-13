# DESIGN.md — пульт диспетчера шахты «Болашак»

## Brief

- **Product:** a digital twin of the Bolashak underground chromite mine, built for the mine dispatcher and the industrial safety engineer.
- **Mode:** Operate, i.e. a control-room HMI.
- **Single job of the screen:** within 3 seconds the operator sees where the fire is, where the smoke is going, where the people are, and what the protection system and the advisor are doing.
- **3D earns its place:** the mine is a volume. The horizons, shafts and the ventilation raise only make sense in space. The geometry is generated in code from the twins' attributes, with no external assets.

## Direction

The panel follows ISA-101 "high performance HMI":

- the background and normal equipment are low-saliency greys;
- colour is reserved for abnormal states and for people;
- an alarm must never look like decoration.

There are no gradients, glass effects or glow. Depth comes from 1 px borders and tonal steps.

## Tokens

```css
:root {
  /* surfaces */
  --bg: #0e1116;          /* app background */
  --panel: #151a21;       /* panels */
  --panel-2: #1c222b;     /* raised rows, inputs */
  --line: #2a323d;        /* borders */
  --line-strong: #3a4452;
  /* text (contrast on --panel) */
  --text: #e6eaf0;        /* 14.8:1 */
  --text-2: #a9b3c1;      /* 7.9:1 */
  --text-3: #8592a3;      /* 5.2:1, minimum for labels */
  /* process (normal) */
  --air: #6f8aa6;         /* fresh air in airways */
  --equip: #b9c2cf;       /* equipment, normal */
  /* states */
  --ok: #3fb68b;          /* safe / done */
  --warn: #e5a50a;        /* warning, CO above the permissible limit */
  --alarm: #ef4b4b;       /* alarm, fire, fault */
  --alarm-bg: #3a1618;
  --info: #4aa3df;        /* evacuating, in progress */
  --smoke: #9a6b3c;       /* smoke-logged airway */
  --focus: #ffd166;       /* focus ring */
}
```

- **Type:** IBM Plex Sans for the UI and IBM Plex Mono for numbers. Both are bundled with the app via @fontsource, so no CDN is needed. Numbers use tabular figures.
- **Type scale:** 12 for the units caption only, 14 for secondary text, 16 for body, 20 for KPI values, 28 for the headline KPI. Line height is 1.5 for text and 1.2 for numbers.
- **Spacing:** a 4 px base with steps 4, 8, 12, 16, 24 and 32.
- **Radius:** 4 for controls and 6 for panels. There are no pill shapes except the status chip.
- **Elevation:** none. Panels are separated by a 1 px `--line`.
- **Motion:** 150–250 ms ease-out, transform and opacity only. Airflow particles and the fire pulse stop when `prefers-reduced-motion` is set, and the flow direction stays visible as static arrows.

## Component rules

- **Status chip:** carries a text label as well as a colour, and the label states the state in words.
- **Sensors, doors and valves:**
  - normal is grey;
  - a door's closed or open state is shown by shape (a filled plate versus an outline);
  - a fault is red with the word «отказ».
- **People:** working crews are white, evacuating crews blue, safe crews green, at-risk crews amber and injured crews red. The headcount is always shown.
- **One primary action per state:**
  - normal operation: «Запустить сценарий»;
  - manual protection mode during an emergency: «Подтвердить позицию ПЛА».
- **Controls:**
  - targets are at least 44 px;
  - focus is shown by a 2 px `--focus` ring;
  - every control is reachable by keyboard;
  - 3D view presets have keyboard shortcuts 1–4.
- **States:**
  - Loading: a skeleton of panels plus the line "Подключение к Ditto…".
  - Lost connection (stale): a banner showing the time of the last update.
  - No forecast yet (empty): the advisor explains why.
- **Mobile at 390 px:** the top bar, then the 3D view at 55vh, then the panels as tabs. There is no horizontal scroll.
