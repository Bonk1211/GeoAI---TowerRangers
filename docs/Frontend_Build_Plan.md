# Frontend Build Plan

**Companion to:** [Concept Overview](Concept_Overview.md) · [PRD — Tower Health Risk Index](PRD_Tower_Health_Risk_Index.md) · [PRD — Agentic Maintenance Scheduler](PRD_Agentic_Maintenance_Scheduler.md)
**Stack:** React + Vite + TypeScript · MapLibre GL JS
**Build window:** ~1 day, parallel with the ML and backend tiers

---

## 1. What the frontend has to prove

The UI is not a dashboard for its own sake. It carries four claims, and every screen exists to make one of them visible:

| Claim | Where it shows |
|---|---|
| Towers differ in risk, and we know which | Map — colour by decision band |
| The risk is **explainable** | Tower drawer — factor attribution bars |
| The ranking is **not arbitrary** | Weight panel — sliders + stability readout |
| Risk becomes **action** | Drawer work order + schedule tab |

If a screen serves none of these, cut it.

**The one screen most easily forgotten:** the perception proof (§8). Without it the scoring layer looks like a spreadsheet and the deep learning is invisible.

---

## 2. Dashboard layout

Dark theme, ops-tool register. One focal point (the map), a permanently docked explanation panel, and four stat tiles — every region earns its place by carrying a claim.

### 2.1 Navigation — collapsible overlay rail

A thin icon rail pinned to the left edge. **On hover it expands into a labelled panel that floats *above* the content — the page underneath never reflows.** Mouse out, it collapses back to icons.

```
  collapsed (default)              expanded on hover (overlays content)
  ┌────┐                           ┌──────────────────────┐
  │[◈] │  ← MCMC logo              │ [◈] MCMC             │
  ├────┤                           │     TOWER HEALTH     │
  │ ▣  │  ← Overview               ├──────────────────────┤
  │    │                           │ ▎▣  Overview         │  ← active
  │ 📅 │  ← Schedule               │                      │
  │    │                           │  📅 Schedule         │
  │ ⚖  │  ← Weights                │                      │
  │    │                           │  ⚖  Weights          │
  │ 🛰 │  ← Perception             │                      │
  │    │                           │  🛰  Perception      │
  │ 📖 │  ← Method                 │                      │
  └────┘                           │  📖 Method           │
   ~56px                           └──────────────────────┘
                                     ~220px, absolute, shadowed
```

**Brand block.** `MCMC-logo.png` sits at the top of the rail, above the divider. Collapsed it is the mark alone (~32px, centred); expanded the wordmark fades in beside it. Stored at `src/frontend/public/brand/mcmc-logo.png`, referenced as `/brand/mcmc-logo.png` — Vite serves `public/` at the web root, so it needs no import and no bundler handling. Also reuse it as the favicon.

**Why overlay rather than push.** The map is the focal point and wants every pixel. A rail that expands in-flow would resize the map canvas on hover — MapLibre would rescale, and dot positions would shift under the cursor. Overlaying leaves the canvas untouched.

Implementation: fixed-position rail, `width: 56px`, `:hover` → `width: 220px` with a transform transition, `z-index` above the content, drop shadow to lift it. Content pane keeps a static `margin-left: 56px`. Labels fade in with opacity so the icons never jump.

Keyboard: the rail is focusable and expands on focus, so it is not hover-only.

### 2.1.1 What lives in each destination

Two working screens, three evidence pages. The split matters: a judge can be walked straight to a proof artifact instead of hunting for a toggle.

| # | Destination | Contents | Claim it carries |
|---|---|---|---|
| 1 | **▣ Overview** | Malaysia map (all towers, coloured by band) · KPI strip · four stat tiles · docked tower drawer with attribution, work order, timeline, dispatch button | *Towers differ in risk, we know which, and it is explainable* |
| 2 | **📅 Schedule** | Crew×day / tower×day grid with view toggle · "why this slot" readout · pin / move / emergency override · unscheduled backlog · agent chat | *Risk becomes action* |
| 3 | **⚖ Weights** | One slider per factor with AHP baseline ticks · live re-score · stability readout (ρ, top-decile retention) · Monte-Carlo distribution figure · reset-to-AHP | *The ranking is not arbitrary* |
| 4 | **🛰 Perception** | Sentinel-2 tile → water mask → distance-to-water → flood factor, for one tile · footprint extraction sample · which AOIs have been processed | *There is real deep learning here* |
| 5 | **📖 Method** | Factor table with failure mechanisms · membership curve shapes and justifications · AHP matrix + consistency ratio · assumed parameters (crew, capacity, lead times) marked `illustrative` · limitations · data sources | *We know what we assumed and where the limits are* |

**Overview and Schedule are the demo.** Weights, Perception, and Method exist to answer the three questions that follow it — *why those weights, where is the AI, what did you assume* — each in one click rather than a slide.

**Method is the cheapest section by far** (~15 min, static content lifted from [Concept Overview §7](Concept_Overview.md) and the PRD limitations) and disproportionately useful: under questioning, pointing at a page beats reciting from memory.

### 2.2 Overview (default view)

Rail collapsed. Layout is full-width — the map keeps its pixels.

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ◎ │ TowerRangers · Kelantan AOI   Towers 533/21,400 scored · ρ 0.94 · 34 maintain · 12 sched │
├───┼────────────────────────────────────────────────────────────┬─────────────────────────────┤
│ ▣ │                                                            │  MY_1042        ● MAINTAIN  │
│   │   ┌──────────────────────────────────────────────────┐     │  ─────────────────────────  │
│ 📅│   │          MALAYSIA — every dot is one tower       │     │  risk  0.82  (0.76 – 0.88)  │
│   │   │                                                  │     │  LTE · 4.1 km to grid       │
│ ⚖ │   │        ·  ·   ·      ·  ·                        │     │                             │
│   │   │      ·   · ·      ●●◉●   ← scored towers         │     │  WHY                        │
│ 🛰│   │     ·  ·  ·  ·   ●●●●●                           │     │  flood     ████████▌  0.41  │
│   │   │       ·   ·   ·   ●●·                            │     │  power     █████▌     0.28  │
│ 📖│   │    ·    ·    ·  ·                                │     │  terrain   ███▊       0.19  │
│   │   │      · · ·   ·    ·   ← grey = not yet scored    │     │  equipment ██▍        0.12  │
│   │   │   ·   ·    ·   ·                                 │     │                             │
│   │   │        ·  ·    ·  ·                              │     │  WORK ORDER                 │
│   │   │                                                  │     │  Raise cabinet + seal       │
│   │   │  ● maintain (top 10%)  ● watch  ● ok  · unscored │     │  ingress, clear drainage    │
│   │   └──────────────────────────────────────────────────┘     │  crew   civil               │
│   │                                                            │  parts  riser, sealant kit  │
│   ├───────────────┬───────────────┬───────────────┬───────────┤  due    within 14 days      │
│   │ BANDS         │ WHAT DRIVES   │ PEOPLE        │ vs CALEND.│                             │
│   │               │ RISK          │ SERVED        │           │  TIMELINE                   │
│   │ maintain  34  │               │               │  11 / 34  │  now ──●──────────── due    │
│   │   ██          │ flood   ▇▇▇47%│    182k       │           │       Tue 18        28 Aug  │
│   │ watch     87  │ power   ▇▇ 23%│               │ caught by │                             │
│   │   █████       │ terrain ▇  18%│  in maintain  │ age-based │  SCHEDULED                  │
│   │ ok       412  │ equip   ▇  12%│  band cells   │ inspection│  Tue 18 Aug · KEL-C1   →    │
│   │   ████████████│               │               │           │                             │
│   │ top 10% = one │ Kelantan      │  ⓘ derived    │ 23 missed │  [ 🚨 dispatch now ]        │
│   │ crew cycle    │ statewide     │  from footpr. │           │                             │
└───┴───────────────┴───────────────┴───────────────┴───────────┴─────────────────────────────┘
```

### 2.3 Schedule — by crew (dispatch view)

Cell clicked, deterministic "why this slot" showing:

```
┌─────────────────────────────────────────────────────────────────────┬──────────────────────────┐
│  ▲ Schedule · Kelantan     [●by crew ][ by tower ]    ⟲ re-optimize │  WHY THIS SLOT           │
├─────────────────────────────────────────────────────────────────────┤  ──────────────────────  │
│          Mon 17        Tue 18        Wed 19       Thu 20    Fri 21  │  Gua Musang · 1042       │
│  ─────────────────────────────────────────────────────────────────  │  risk 0.82 · flood       │
│  KEL-C1  Kuala Krai   ▸Gua Musang   Machang        —      Jeli      │  due within 14 days      │
│  civil   ● 0.79 flood  ● 0.82 flood  ● 0.68 terr          ● 0.61    │                          │
│  KB depot                                                           │  scheduled Tue because:  │
│                                                                     │  · earliest civil slot   │
│  KEL-C2  Gua Musang   Gua Musang    Kuala Lipis    —      —         │    within 120 km of      │
│  civil   ● 0.74 flood  ● 0.71 flood  ● 0.66 terr                    │    Kota Bharu depot      │
│  GM depot                                                           │  · Mon full (2 jobs)     │
│                                                                     │  · Wed blocked —         │
│  KEL-P1  Tanah Merah   —            Pasir Mas    Bachok    —        │    monsoon window        │
│  power   ● 0.77 power               ● 0.64 power ● 0.59             │                          │
│                                                                     │  [ 📌 pin ]  [ ↔ move ]  │
│  ⚠ 16 civil-crew jobs vs 10 crew-days available — 6 unscheduled     │                          │
│  ⚠ monsoon: civil work blocked in flood zones Nov–Mar               │  AGENT                   │
├─────────────────────────────────────────────────────────────────────┤  › ask or add constraint │
│  UNSCHEDULED (6)   1187 ● 0.80  ·  0994 ● 0.75  ·  0871 ● 0.72  →   │                          │
└─────────────────────────────────────────────────────────────────────┴──────────────────────────┘
```

### 2.4 Schedule — by tower (asset view)

Same `ScheduleEntry[]`, different `groupBy`. Rows become towers; the right panel becomes the maintenance timeline.

```
┌─────────────────────────────────────────────────────────────────────┬──────────────────────────┐
│  ▲ Schedule · Kelantan     [ by crew ][●by tower]     ⟲ re-optimize │  TOWER 1042              │
├─────────────────────────────────────────────────────────────────────┤  ──────────────────────  │
│  TOWER    BAND       Mon 17   Tue 18   Wed 19   Thu 20   Fri 21     │  Gua Musang · flood 0.82 │
│  ─────────────────────────────────────────────────────────────────  │                          │
│  ▸1042    ●maintain    —      KEL-C1     —        —        —        │  TIMELINE                │
│           flood 0.82            📌                                  │  now ─────●───────────── │
│                                                                     │        Tue 18      due   │
│  0871     ●maintain  KEL-C1     —        —        —        —        │        scheduled   Fri   │
│           flood 0.79                                                │                   28 Aug │
│                                                                     │                 monsoon  │
│  0994     ●maintain    —        —        —      KEL-C1     —        │                 Nov ▓▓▓▓ │
│           power 0.75                                                │                          │
│                                                                     │  MAINTENANCE             │
│  1187     ●maintain    —        —        —        —        —        │  raise cabinet + seal    │
│           terrain 0.80        ⚠ unscheduled — no capacity           │  crew   KEL-C1 (civil)   │
│                                                                     │  parts  riser, sealant   │
│  0455     ●maintain    —        —        —      KEL-P1★    —        │  status pinned — planner │
│           power 0.77          ★ emergency dispatch                  │         (emergency)      │
│                                                                     │                          │
│  0912     ●watch       —        —        —        —        —        │  [ 📌 unpin ] [ ↔ move ] │
│           terrain 0.55        (not due — watch only)                │                          │
│                                                                     │  AGENT                   │
│  ⚠ 6 maintain-band towers unscheduled this week                     │  › ask or add constraint │
└─────────────────────────────────────────────────────────────────────┴──────────────────────────┘
```

Differences that matter:

- **One cell lit per row.** A tower gets one visit; the sparsity shows its whole week's disposition at a glance — including whether it is scheduled at all.
- **Watch-band towers appear, visibly idle**, with a reason (`not due`). Answers "what about the non-urgent ones" without a separate screen.
- **Pin (📌) and emergency (★) markers are inline**, so a planner scanning by tower sees overrides without opening each row.
- **The right panel is the timeline strip, not "why this slot."** The asset question is *what is happening to this site over time*, not *why did the solver pick Tuesday*.
- **Banner reframes** from capacity terms ("16 jobs vs 10 crew-days") to asset terms ("6 towers unscheduled") — same fact, different question depending on the view.

### 2.5 Override — preview before commit

Any override renders its knock-on cost with a confirm step. Never blocks.

```
│          Mon 17        Tue 18        Wed 19       Thu 20    Fri 21  │  OVERRIDE PREVIEW        │
│  ─────────────────────────────────────────────────────────────────  │  ──────────────────────  │
│  KEL-C1  Kuala Krai   ┌ ─ ─ ─ ─ ┐   Machang        —      Jeli      │  Moving 1042             │
│  civil   ● 0.79 flood │ 1042 📌 │   ● 0.68 terr           ● 0.61    │  Tue 18 → Thu 20         │
│                       └ ─ ─ ─ ─ ┘        ▲                          │                          │
│                          drop here ──────┘                          │  Knock-on:               │
│                                                                     │  · 0994 → Fri (+3 days)  │
│                                                                     │  · 1187 stays unscheduled│
│                                                                     │                          │
│                                                                     │  risk-weighted wait      │
│                                                                     │  +8%  (2.4 → 2.6)        │
│                                                                     │                          │
│                                                                     │  [ confirm ] [ cancel ]  │
```

### 2.6 Emergency dispatch — two entry points, one mechanism

**From the tower drawer (tab 1)** — emergencies are discovered per-tower ("this site is down"), so the button lives where the tower is:

```
│  MY_0455        ● MAINTAIN          │      │  EMERGENCY DISPATCH               │
│  risk 0.77 · power                  │      │  ───────────────────────────────  │
│  scheduled Thu 20 · KEL-P1          │  →   │  0455 · Tanah Merah               │
│                                     │      │  nearest power crew: KEL-P1       │
│  [ 🚨 dispatch now ]                │      │  available today: 2 of 3 members  │
│                                     │      │                                   │
│                                     │      │  Displaces:                       │
│                                     │      │  · 0912 Mon → Wed                 │
│                                     │      │  · 0640 drops to unscheduled      │
│                                     │      │                                   │
│                                     │      │  [ dispatch ] [ cancel ]          │
```

**From an empty schedule cell (tab 2)** — clicking any empty tower × day cell *is* "assign someone to fix this, on this day," because the grid position already identifies both:

```
│  TOWER    BAND      Mon 17   Tue 18   Wed 19   Thu 20   Fri 21     │  EMERGENCY DISPATCH      │
│  ─────────────────────────────────────────────────────────────────  │  ──────────────────────  │
│  0994     ●maintain  ┌ ─ ─ ┐   —        —        —        —        │  0994 · Tanah Merah      │
│           power 0.75 │ 🚨? │← clicked empty cell, Mon 17           │  power 0.75              │
│                      └ ─ ─ ┘                                        │  → same panel as above   │
```

**One interaction model, two entry points, no new logic.** Filled cell → move/pin. Empty cell → emergency dispatch. The natural-language route (*"emergency — send someone to 0994 today"*) resolves through the same `apply_constraint` → pin → preview → confirm path, so nothing extra is built for it.

### 2.7 Weights — the validation page

Sliders left, consequences right. **Adjacency is the whole argument**: perturb the weights and see, in the same glance, the statement that perturbation barely moves the answer.

```
┌───┬──────────────────────────────────────────┬───────────────────────────────────────────┐
│ ◈ │  Weights · AHP baseline    [ reset ]     │  STABILITY                                │
├───┼──────────────────────────────────────────┤  ───────────────────────────────────────  │
│ ▣ │  flood        ▁▁▁▁▁▁●▁▁▁▁   0.34         │  Spearman ρ vs baseline ranking            │
│   │               ▲ AHP 0.31                 │                                            │
│ 📅│                                          │      ▁▂▄███▇▅▂▁                            │
│   │  power        ▁▁▁▁●▁▁▁▁▁▁   0.24         │     0.86    0.94   1.0                     │
│▎⚖ │               ▲ AHP 0.24                 │                                            │
│   │                                          │  mean ρ          0.94                      │
│ 🛰│  terrain      ▁▁▁●▁▁▁▁▁▁▁   0.21         │  5th percentile  0.86                      │
│   │               ▲ AHP 0.22                 │  top-decile ret. 91%                       │
│ 📖│                                          │  draws           500                       │
│   │  lightning    ▁▁●▁▁▁▁▁▁▁▁   0.12         │                                            │
│   │               ▲ AHP 0.13                 │  ───────────────────────────────────────  │
│   │                                          │  CONSISTENCY                               │
│   │  equipment    ▁●▁▁▁▁▁▁▁▁▁   0.09         │  AHP consistency ratio  CR = 0.06  ✓ <0.1  │
│   │               ▲ AHP 0.10                 │                                            │
│   │                                          │  ───────────────────────────────────────  │
│   │  ⚠ 2 towers crossed a decision band      │  IMPACT OF THIS CHANGE                     │
│   │    since baseline                        │  maintain  34 → 34                         │
│   │                                          │  entered:  1204 (flood ↑)                  │
│   │  ⓘ Sliders re-score live. Perception is  │  left:     0788                            │
│   │    precomputed and never re-runs here.   │  rank shift (mean)  1.4 places             │
└───┴──────────────────────────────────────────┴───────────────────────────────────────────┘
```

- **AHP baseline tick under every slider** so deviation from the defensible starting point is always visible.
- **The ρ distribution is the headline figure** (ML plan D5) — render it here rather than burying it in a slide.
- **Band-crossing warning** turns an abstract rank shift into an operational one: *these specific towers changed decision*.
- **Note that perception never re-runs** — it is why the interaction is instant, and worth saying on screen as well as aloud.

### 2.8 Perception — the deep-learning proof

**The page that stops "this is a weighted spreadsheet."** Left-to-right chain, real images exported once from Colab.

```
┌───┬───────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ │  Perception · Kelantan tile 102.31E 5.88N          model: OmniWaterMask (geoai)        │
├───┼───────────────────────────────────────────────────────────────────────────────────────┤
│ ▣ │  FLOOD DRIVER — from imagery, not from any table                                       │
│   │                                                                                        │
│ 📅│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌──────────────────────┐       │
│   │  │             │   │      ▓▓▓    │   │      ░░░    │   │  tower MY_1042       │       │
│ ⚖ │  │  Sentinel-2 │ → │   ▓▓▓▓▓▓    │ → │   ░░▒▒▒░    │ → │  dist to water  84 m │       │
│   │  │   RGB+NIR   │   │  ▓▓▓  ▓▓    │   │  ░▒▓●▓▒░    │   │  HAND          2.1 m │       │
│▎🛰│  │             │   │             │   │             │   │                      │       │
│   │  └─────────────┘   └─────────────┘   └─────────────┘   │  flood factor        │       │
│ 📖│    raw tile         water mask        distance field   │  p = 0.71            │       │
│   │                     segment_water()                     └──────────────────────┘       │
│   │                                                                                        │
│   │  ─────────────────────────────────────────────────────────────────────────────────    │
│   │  EXPOSURE — building footprints where map data is sparse                               │
│   │                                                                                        │
│   │  ┌─────────────┐   ┌─────────────┐      1,847 footprints in the 2 km service buffer    │
│   │  │             │ → │  ▫▫ ▫  ▫▫   │  →   ≈ 6,200 people served by this tower           │
│   │  │  raw tile   │   │ ▫ ▫▫▫  ▫    │      BuildingFootprintExtractor()                   │
│   │  └─────────────┘   └─────────────┘                                                     │
│   │                                                                                        │
│   │  ─────────────────────────────────────────────────────────────────────────────────    │
│   │  COVERAGE   Kelantan ✓ processed  ·  13 states pending  ·  rerun = change bounding box │
└───┴───────────────────────────────────────────────────────────────────────────────────────┘
```

- **Static images, no live inference.** Exported once to `public/perception/`; nothing here can fail mid-demo.
- **The chain ends in a number that appears elsewhere** — `p = 0.71` is the same flood factor the drawer attributes and the index consumes. That continuity is the point: it proves the deep learning is load-bearing, not a side exhibit.
- **Coverage line doubles as the scalability claim**, in the same honest form the map uses.

### 2.9 Method — assumptions and limits

Static page, ~15 minutes, content lifted from [Concept Overview §7](Concept_Overview.md) and the PRD limitation sections. Somewhere to point when questioned.

```
┌───┬───────────────────────────────────────────────────────────────────────────────────────┐
│ ◈ │  Method                                                                                │
├───┼───────────────────────────────────────────────────────────────────────────────────────┤
│ ▣ │  WHAT WE PREDICT                                                                       │
│   │  Maintenance need, priority, urgency.  NOT failure probability — no public failure     │
│ 📅│  logs exist to calibrate one, and we do not fabricate labels.                          │
│   │                                                                                        │
│ ⚖ │  ─────────────────────────────────────────────────────────────────────────────────    │
│   │  FACTORS AND FAILURE MECHANISMS                                                        │
│ 🛰│  ┌──────────┬─────────────────────────┬───────────────────┬──────────────────────┐    │
│   │  │ factor   │ mechanism               │ curve             │ source               │    │
│▎📖│  ├──────────┼─────────────────────────┼───────────────────┼──────────────────────┤    │
│   │  │ flood    │ ingress, scour, power   │ logistic on HAND  │ Sentinel-2 + DEM     │    │
│   │  │ terrain  │ landslide, wind, access │ logistic, s₀=25°  │ Copernicus DEM       │    │
│   │  │ lightning│ strike damage           │ linear-saturating │ NASA LIS/OTD         │    │
│   │  │ power    │ grid dependence         │ 1-exp(-d/2km)     │ OSM + VIIRS          │    │
│   │  │ equipment│ generation reliability  │ categorical       │ OpenCellID radio     │    │
│   │  └──────────┴─────────────────────────┴───────────────────┴──────────────────────┘    │
│   │                                                                                        │
│   │  COMBINATION   noisy-OR: Risk = 1 − Π(1 − pᵢwᵢ)   — weakest-link, not weighted average │
│   │  WEIGHTS       AHP pairwise, CR = 0.06                                                 │
│   │  BANDS         maintain = top 10% ≈ one inspection cycle at current crew capacity      │
│   │                                                                                        │
│   │  ─────────────────────────────────────────────────────────────────────────────────    │
│   │  ASSUMED PARAMETERS          ⚠ illustrative — not operator data                        │
│   │  crew rosters · depots · territories · shift hours · travel speeds · part lead times   │
│   │                                                                                        │
│   │  ─────────────────────────────────────────────────────────────────────────────────    │
│   │  LIMITATIONS                                                                           │
│   │  · Rank stability bounds arbitrariness — it does not prove the weights are correct.    │
│   │  · Factors are proxies for mechanisms, not observations of failure.                    │
│   │  · Pretrained perception carries a domain gap on ASEAN imagery.                        │
│   │  · Crowd-sourced tower positions are imperfect.                                        │
│   │  · The optimizer is decision support; every assignment is overridable.                 │
└───┴───────────────────────────────────────────────────────────────────────────────────────┘
```

**The assumed-parameters block is deliberately prominent.** Volunteering it is what makes the rest of the numbers credible — and it pre-empts the question rather than waiting for it.

### 2.10 Why this composition

- **Map ≈ 55% of the viewport, all of Malaysia.** The grey-versus-coloured contrast *is* the coverage statement, visible without a caption: national extent, perception staged per AOI.
- **Drawer is docked, not a popup.** It holds the attribution bars — the most important component in the app — so it can never be dismissed or hidden behind a modal. Pre-seed it with the demo tower on load.
- **Four tiles, four claims:** how much work (bands), what is wrong regionally (drivers), who is affected (people), why this beats current practice (vs calendar).
- **Weights and perception are toggles, not permanent panels.** They are proof artifacts you open when challenged; keeping them one click away keeps the default view clean without hiding them.
- **Both schedule views run off one dataset.** `[by crew]` / `[by tower]` is a `groupBy` over the same `ScheduleEntry[]` — no second contract, no second fetch.
- **The deterministic "why this slot" readout sits above the agent chat.** It always renders, even with the LLM down or slow; the agent is additive, never load-bearing for explanation.
- **Unscheduled work is displayed, never hidden.** Capacity is genuinely short. Showing the backlog is what makes risk *ordering* legible as the product.
- **No sparklines, gauges, or pie charts.** There is no time series in this system. Inventing a trend line would contradict the honesty framing that the rest of the project rests on.

---

## 3. Architecture

Static single-page app. All heavy computation is server-side; the frontend renders and re-requests.

```
   React + Vite + TS
        │
        ├── MapLibre GL JS ......... tower map, colour bands, routes
        ├── TanStack Query ......... server state, caching, refetch
        ├── Zustand (or Context) ... UI state: selected tower, weights
        └── Recharts ............... attribution bars, stability figure
        │
        ▼  REST + SSE
   FastAPI backend (cached feature table → scorer → optimizer → agent)
```

**Deliberately excluded:** SSR, auth, a component library beyond a light one, global CSS frameworks beyond Tailwind, routing beyond two tabs. None earn their cost in a one-day build.

**Why the weights live client-side:** the scorer is fast enough to re-run per slider change (numpy over a few thousand towers). Slider moves → debounced POST → new scores → map recolours. The perception tier is never in this path — that decoupling is what makes the interaction feel instant, and it is worth saying aloud during the demo.

---

## 4. Directory layout

```
src/frontend/
  index.html
  package.json
  vite.config.ts
  tailwind.config.js
  public/                      served at web root, no import needed
    brand/
      mcmc-logo.png            nav rail brand block + favicon
    perception/                static proof images exported from Colab
      tile-raw.png
      tile-watermask.png
      tile-footprints.png
    fallback/
      towers.json              demo-safety static data (§12)
      schedule.json
  src/
    main.tsx
    App.tsx                    routes + shell
    pages/
      Overview.tsx             map + tiles + drawer
      Schedule.tsx             grid + override + agent
      Weights.tsx              sliders + stability
      Perception.tsx           imagery → mask → factor
      Method.tsx               assumptions + limitations
    api/
      client.ts                fetch wrappers, base URL from env
      types.ts                 mirrors backend contracts (§5)
    state/
      useWeights.ts            weight sliders + debounce
      useSelection.ts          selected tower id
    components/
      shell/
        NavRail.tsx            collapsed icon rail, hover/focus → overlay panel
      map/
        MapView.tsx            MapLibre init, tower layer, click handling
        towerLayer.ts          GeoJSON source + paint expressions
        Legend.tsx             decision bands, stated thresholds
        RouteLayer.tsx         crew routes (optional)
      tower/
        TowerDrawer.tsx        the money panel
        AttributionBars.tsx    factor contribution chart
        WorkOrderCard.tsx      action, crew, parts, urgency
        TimelineStrip.tsx      now / scheduled / due / weather window
        EmergencyButton.tsx    dispatch now → override preview
      stats/
        KpiStrip.tsx           header numbers
        BandsTile.tsx          maintain/watch/ok counts, filters map
        DriversTile.tsx        dominant-factor mix
        PeopleTile.tsx         population served
        BaselineTile.tsx       vs age-based inspection
      weights/
        WeightPanel.tsx        sliders + reset
        StabilityReadout.tsx   rho + top-decile retention
      schedule/
        ScheduleGrid.tsx       crew × day / tower × day, one groupBy
        ViewToggle.tsx         by crew | by tower
        WhySlotPanel.tsx       deterministic readout, no LLM
        OverridePreview.tsx    knock-on effects + confirm
        EmergencyPanel.tsx     force-insert + displacement list
        UnscheduledBar.tsx     the backlog, always visible
        AgentChat.tsx          NL constraint entry, SSE stream
      perception/
        PerceptionProof.tsx    imagery → water mask → factor (§8)
      method/
        MethodPage.tsx         assumptions, mock parameters, limitations
    lib/
      colors.ts                band palette, single source of truth
      format.ts                score/urgency formatting
```

---

## 5. Data contracts consumed

Types mirror the backend exactly; keep `api/types.ts` in sync with the ML plan §E4 and scheduler PRD §10.

```ts
type Decision = 'maintain' | 'watch' | 'ok';

interface Tower {
  tower_id: string;
  lon: number; lat: number;
  radio: 'GSM' | 'UMTS' | 'LTE' | 'NR';
  risk: number; risk_lo: number; risk_hi: number;
  decision: Decision;
  borderline: boolean;
  dominant_factor: string;
  urgency_days: number;
  attribution: Record<string, number>;   // factor → share, sums to 1
}

interface WorkOrder {
  tower_id: string;
  action: string;
  crew_type: string;
  parts: string[];
  urgency_days: number;
  why: string;
}

interface Crew {
  crew_id: string;                    // territory-prefixed: "KEL-C1"
  name: string;
  crew_type: string;
  depot: { lon: number; lat: number; name: string };
  territory: string;
  max_travel_km: number;
  shift_hours: number;
  members: string[];
}

interface ScheduleEntry {
  crew_id: string;
  day: string;            // ISO date
  order: number;          // visit sequence
  tower_id: string;
  work_order: WorkOrder;
  pinned: boolean;
  pin_reason?: 'planner_override' | 'emergency';
}

interface ScheduleRun {
  run_id: string;
  entries: ScheduleEntry[];
  unscheduled: string[];              // tower_ids with no capacity
  risk_weighted_wait: number;         // objective value, for override deltas
}

interface OverridePreview {           // returned by /schedule/preview
  moved: { tower_id: string; from: string; to: string; delta_days: number }[];
  dropped: string[];
  risk_weighted_wait_before: number;
  risk_weighted_wait_after: number;
}

interface WhySlot {                   // deterministic, no LLM
  tower_id: string; crew_id: string; day: string;
  reasons: string[];                  // rendered as bullets
}

interface Stability {
  rho_mean: number;
  rho_p05: number;
  top_decile_retention: number;
  draws: number;
}
```

**Endpoints used**

```
GET  /towers                 -> Tower[]          (baseline weights)
POST /score      {weights}   -> Tower[]          (slider re-score)
GET  /stability              -> Stability
GET  /crews                  -> Crew[]
POST /schedule/optimize      -> { run_id }
GET  /schedule/{run_id}      -> ScheduleRun
GET  /schedule/why/{entry}   -> WhySlot          (deterministic)
POST /schedule/preview       -> OverridePreview  (no mutation)
POST /schedule/pin           -> ScheduleRun      (commit + re-solve)
POST /schedule/emergency     -> OverridePreview | ScheduleRun
POST /agent/chat             -> SSE stream
```

---

## 6. The map

**One dot = one physical tower. Never a state, never a region.** Every marker carries its own score, band, attribution, and work order. Pahang's ~50 towers are 50 independent scores; two towers 3 km apart can be `maintain` and `ok` because one sits near drainage level in a flood plain and the other is on high ground. That per-asset resolution *is* the product — a state-level average would erase exactly the signal we built. **No choropleth anywhere in this application.**

**Basemap.** MapLibre with a free vector style — no API key, no billing, nothing to expire mid-demo. Fit bounds to peninsular + east Malaysia on load, then zoom to the scored AOI (Kelantan ≈ `[102.25, 5.90]`, zoom 8) on first interaction.

**National extent, partial scoring.** Render **all** Malaysian towers from OpenCellID — points only, no perception required, so the national layer is nearly free. Towers in a scored AOI are coloured by decision band; the rest render grey and hollow, legended *"not yet scored — pipeline reruns per AOI."*

Colour-versus-grey is a **processing-coverage statement, not a geographic claim**: it marks where perception has been run, nothing more. Score a second AOI and those dots colour up individually. Showing this honestly is stronger than implying 21,000 scored towers — the greyed remainder is the scalability argument made visible, and it pre-empts the obvious question instead of inviting it.

**Tower rendering.** One GeoJSON source, one circle layer. Colour driven by a `match` expression on `decision`, radius scaled by risk. Thousands of points stay smooth because paint expressions run on the GPU — no per-marker React components.

```ts
paint: {
  'circle-color': [
    'match', ['get', 'decision'],
    'maintain', COLORS.maintain,
    'watch',    COLORS.watch,
    COLORS.ok,
  ],
  'circle-radius': ['interpolate', ['linear'], ['get', 'risk'], 0, 4, 1, 11],
  'circle-stroke-width': ['case', ['get', 'borderline'], 2, 0],
}
```

**Borderline towers get a visible stroke.** This is the uncertainty band doing real work in the UI rather than being a number nobody reads — a tower whose band straddles a threshold looks different, and that is an honest thing to show.

**Legend must state its rule.** Not "red = high risk" but *"maintain — top 10% by risk, one inspection cycle at current crew capacity."* Judges probe legends; an unexplained cutoff is the cheapest possible thing to be caught on.

**Out-of-AOI towers** render grey and unscored, with a caption that the pipeline reruns per AOI. Do not hide them — the greyed remainder of Malaysia *is* the generalization claim, visible.

---

## 7. Tower drawer — the money panel

**This panel is where the model becomes visible.** It is the only surface in the app that shows ML output directly, so every element must be traceable to a pipeline stage:

| Drawer element | Produced by |
|---|---|
| `risk 0.82` | index — membership functions + noisy-OR (ML plan C1–C2) |
| `(0.76 – 0.88)` | Monte-Carlo draws (D1) |
| `● MAINTAIN` | decision bands (E1) |
| attribution bars | leave-one-out attribution (C4) |
| `within 14 days` | urgency, mechanism-timescale weighted (E2) |
| work order | action mapping (scheduler PRD E1) |

**Be precise about which ML, because it will be asked.** The **deep learning** — geoai water segmentation, building-footprint extraction — runs upstream in the batch tier and produces the *inputs* (flood exposure, population served). The drawer shows the **index layer**, which is deliberately transparent arithmetic over those inputs. Deep learning creates the factors; the index combines them; the drawer explains the combination. This is also why the perception proof panel (§8) exists — without it, the deep learning never appears on screen and the drawer reads as the entire system.

Opens on tower click. Top to bottom, in priority order:

1. **Tower id, decision chip, risk score with band** — `0.82 (0.76–0.88)`. Show the interval, always.
2. **Attribution bars** — horizontal, sorted descending, factor name + share. This is the single most important component in the app; it is what makes the whole system explainable rather than a black box.
3. **Work order card** — action, crew type, parts, `maintain within N days`.
4. **Maintenance timeline strip** — `now ── scheduled ── SLA due ── next weather window`. **Not a Gantt**: work orders are single-visit, so a Gantt would render one bar. The strip answers what a planner actually asks of one asset — when is it scheduled, how much slack remains, when does its window close. Upgrade to stacked bars only if multi-stage work (survey → parts → civil) appears.
5. **Scheduled slot** — crew and date; **clicking it navigates to the schedule tab with that tower preselected and its row highlighted.** Cheap continuity, and it is the natural demo path: risk → why → what → when.
6. **🚨 dispatch now** — emergency override. Lives here because emergencies are discovered per-tower ("this site is down"), not while scanning a schedule grid.

**Provenance flag.** Towers outside a perception AOI carry partial factors. Mark them in the drawer — `flood: estimated — perception not yet run for this AOI`. The flag is a roadmap, not an apology, and building it in from the start avoids retrofitting honesty later.

**Design rule:** a planner should be able to read the drawer aloud as a sentence — *"tower MY_1042, maintain within 14 days, mostly flood, send a civil crew with a riser and sealant, Tuesday."* If it doesn't read that way, the layout is wrong.

---

## 7.5 Stat tiles and KPI strip

### KPI strip (header)

`Towers 533/21,400 scored · ρ 0.94 · 34 maintain · 12 scheduled this week`

Four numbers, all real, all already computed. Gives an instant read before anyone clicks anything.

### The four tiles

| Tile | Content | Source | Why it earns space |
|---|---|---|---|
| **Bands** | 34 maintain / 87 watch / 412 ok, bar-scaled, band colours | decision layer E1 | Answers *"how bad is my network and how much work is that?"* Doubles as the map legend. Clicking a band filters the map. |
| **What drives risk** | flood 47% · power 23% · terrain 18% · equipment 12% | attribution C4, aggregated over the maintain set | A **regional finding**, not a UI stat — *"flood drives 47% of at-risk towers in Kelantan"* is the line judges remember. Free from data you already have. |
| **People served** | 182k in maintain-band cells | building footprints (perception A3) | Converts risk into consequence, and it is the one tile that visibly consumes a deep-learning output. |
| **vs calendar** | 11 of 34 caught by age-based inspection · 23 missed | baseline comparison | The most persuasive single number in the app: it quantifies what current practice misses. |

**Every tile states its own rule.** `34 maintain (top 10% = one crew cycle)`, `ⓘ derived from footprints`. An unexplained number on a dashboard is the cheapest thing in the world to be caught on.

### Mock data rule

Some tiles may run on assumed parameters (crew capacity, cost figures). **Label them `illustrative`.** The cost is one small tag; the benefit is protecting the credibility the rest of the project is built on — a judge who spots an unlabelled invented ROI figure will re-examine every other claim.

Prefer **derived-from-real over invented-but-impressive**: *"182k subscribers served by maintain-band towers"* (from real footprints) beats *"RM 2.4M cost avoided"* (fabricated) every time.

**Available if a tile is needed later:** borderline count, risk-distribution histogram, mean urgency days, radio-generation mix, crew-days required vs available, policy delta (risk-weighted wait, greedy vs nearest-first). **Never:** time series of any kind — no temporal data exists.

---

## 8. Perception proof panel

**The component that stops the "this is a weighted spreadsheet" objection.** Small panel, reachable from the drawer or a map toggle, showing the chain for one tile:

```
Sentinel-2 tile  →  water mask overlay  →  distance-to-water  →  flood factor p
   (raw image)      (segment_water)         (derived)             (0.71)
```

Three static images plus a number, exported once from the Colab notebook. Costs almost nothing and makes the deep learning **visible** — without it, perception happened offscreen and the judge only sees arithmetic.

---

## 9. Weight panel

One slider per factor, plus reset-to-AHP.

- Debounce ~250 ms, then `POST /score`; recolour the map from the response.
- Show the AHP baseline value as a tick on each slider so deviation is visible.
- **Stability readout sits directly beneath the sliders** — `ρ = 0.94, top-decile retention 91% over 500 draws`. Adjacency is the point: the user perturbs weights and sees, in the same glance, the statement that perturbation doesn't matter much.

This panel *is* the validation story. It is the difference between "we picked some weights" and "we bounded how much our weights matter."

---

## 10. Schedule tab

Wireframes in §2.2–2.5. Behaviour:

### View toggle

`[ by crew ]` / `[ by tower ]` — a `groupBy` over one `ScheduleEntry[]`. No second fetch, no second contract.

- **By crew** (dispatch): rows are crews, columns days, cells list towers in visit order. Answers *who goes where*.
- **By tower** (asset): rows are towers, one cell lit per row. Answers *what is happening to this site*, and makes unscheduled towers visible as empty rows.

**Cell content is place name + risk dot + dominant factor**, never a bare tower ID — bare IDs carry no meaning to anyone glancing at the grid. Tower ID goes in the tooltip. This keeps the explainability thread running from map to drawer into dispatch.

### Cell interactions

| Target | Action |
|---|---|
| Filled cell | `GET /schedule/why/{entry}` → deterministic readout + pin / move controls |
| Empty cell (tower view) | Emergency dispatch for that tower on that day — the grid position supplies both |
| Drag a filled cell | `POST /schedule/preview` → knock-on effects → confirm → `POST /schedule/pin` |

**Drag-and-drop is the cuttable part.** A dropdown reassignment takes 15 minutes and does the same job; build it first, upgrade if time allows.

### Override rules

- **Preview before commit, always.** Show which jobs slip, by how many days, and the change in risk-weighted wait. Confirm/cancel.
- **Never block an override.** Planners hold information the model does not. Show the cost; let them proceed.
- **Pinned cells render a 📌**, emergency insertions a ★, and both survive re-optimization.
- **`unpin all`** resets to the pure optimizer solution.

### Always-visible state

- **Unscheduled work**, as a row beneath the grid (crew view) or empty rows (tower view). Never hide the backlog.
- **Capacity warning** in the view's own terms: *"16 civil jobs vs 10 crew-days"* (crew view), *"6 maintain-band towers unscheduled"* (tower view).
- **Active constraint banners** — monsoon window, crew unavailability.

### Agent panel

Sits **below** the deterministic "why this slot" readout, never replacing it. Single input, message list, SSE-streamed.

- **Echo the parsed constraint before solving.** *"Understood: crew KEL-C2 unavailable Thursday 20 Aug. Re-optimize?"* Makes parse errors visible rather than silent, and demonstrates the tool-calling architecture on screen — the model produced a constraint, not a schedule.
- **After a replan, show a diff** — which towers moved and why. Without the diff the chat is a novelty.
- **Never label an assignment "AI-assigned."** The optimizer assigns; the agent supplies constraints and explains. See [scheduler PRD §8.1](PRD_Agentic_Maintenance_Scheduler.md).

**Route rendering on the map is optional.** Cut first if time is short.

---

## 11. Build order

Strictly sequential. Every prefix is a coherent demo — that property is what protects you when time runs out.

| # | Step | Est | Demo state after |
|---|---|---|---|
| 1 | Vite + TS + Tailwind scaffold, overlay nav rail, routes | 0.75 h | Empty shell |
| 2 | MapLibre + tower layer from **mock JSON** matching §4 | 1 h | Coloured map of Malaysia |
| 3 | Tower drawer + attribution bars (mock data) | 1 h | **Explainability visible — core claim 2** |
| 4 | Wire to real `/towers` and `/score` | 0.5 h | Real scores |
| 5 | Weight panel + stability readout | 1 h | **Validation visible — core claim 3** |
| 6 | Work-order card + timeline strip in drawer | 1 h | Risk → action → when |
| 7 | KPI strip + four stat tiles (§7.5) | 1 h | **Dashboard reads at a glance** |
| 8 | Schedule grid, crew view + unscheduled bar | 1 h | Dispatch visible |
| 9 | View toggle (by tower) + "why this slot" readout | 0.5 h | Both perspectives, explained |
| 10 | Override: pin, preview, emergency dispatch | 1.5 h | **Planner can disagree — adoption story** |
| 11 | Agent chat + SSE | 1.5 h | Full agentic loop |
| 12 | Perception proof page | 0.5 h | Deep learning visible |
| 13 | Method page — assumptions, mock params, limitations | 0.25 h | Somewhere to point under questioning |
| 14 | Dark theme pass, legend polish, empty states | 1 h | Presentable |

**Start on mock data (step 2–3) before the backend exists.** The contracts in §4 are frozen, so the frontend never blocks on the ML tier — same decoupling discipline the ML plan applies with its synthetic feature table.

**Cut order under time pressure:** route polylines → drag-and-drop (dropdown instead) → the *people served* and *vs calendar* tiles → tower-view toggle → agent chat → perception panel. Never cut the attribution bars, the weight panel, the bands tile, or override.

**Everything runs on mock data until the model lands.** Contracts in §5 are frozen, so the frontend never blocks on perception or the optimizer. Swap real outputs in behind the same shapes; the provenance flag (§7) marks which factors are real.

**Style last, at step 11.** Skinning is seductive and infinite; build functional-ugly through step 10. A polished shell over mock attribution loses to a plain UI that genuinely re-scores.

---

## 12. Demo-safety rules

Learned-the-hard-way list, all cheap:

- **No live external tile dependency you can't lose.** Cache the basemap style, or accept a plain background — a blank map at judging time is fatal.
- **Every network call has a loading and an error state.** A silent blank panel reads as a broken product.
- **Seed the app with one AOI already loaded.** No "select a region first" step before the story starts.
- **Pin the demo tower.** Have the "new tower, high flood risk" example reachable in one click, not hunted for on stage.
- **Never let the agent block the UI.** Stream tokens; keep a cancel button.
- **Keep a static fallback JSON** of scores and schedule so the frontend runs with the backend down.

---

## 13. Definition of done

- Map renders **all Malaysian towers**, each dot one physical tower; scored towers coloured by decision band, unscored grey; legend states its rule.
- KPI strip and the four stat tiles populate from real outputs; any assumed-parameter tile is tagged `illustrative`.
- Clicking a tower shows score with interval, attribution bars, work order, timeline strip, and scheduled slot; the slot links through to the schedule tab.
- Weight sliders re-score live; stability readout visible beside them.
- Schedule tab toggles between crew and tower views off one dataset; unscheduled work is visible in both.
- Clicking a filled cell gives a deterministic "why this slot"; clicking an empty tower cell offers emergency dispatch.
- An override (move, pin, or emergency) previews its knock-on cost and requires confirmation — and is never blocked.
- Agent accepts one natural-language constraint, echoes it, replans, shows a diff.
- Perception proof panel present; partial-factor towers flagged in the drawer.
- App runs from static fallback data with the backend stopped.
