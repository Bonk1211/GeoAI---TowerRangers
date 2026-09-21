# Frontend Handoff — Build Brief

**For the implementer.** Read [Frontend_Build_Plan.md](Frontend_Build_Plan.md) for wireframes and rationale; this page is the executable summary. Where the two disagree, the build plan wins.

**Context in one paragraph:** predictive maintenance for Malaysian telecom towers. A risk index scores every tower from open geospatial data and explains *why* per factor; a scheduler turns those explanations into work orders and packs them into crew-days. This is the UI for both. Competition prototype, ~1 day, judged on defensibility as much as polish.

---

## 0. Ground rules

1. **Mock data only.** No backend exists. Build against the contracts in [Frontend_Build_Plan §5](Frontend_Build_Plan.md) and a local fixture file. Contracts are frozen — do not invent fields; if something is missing, flag it rather than improvising.
2. **Build in the order given (§4).** Every prefix must be a coherent demo. Do not start step *n+1* until *n* renders.
3. **Functional before beautiful.** The dark-theme pass is the *last* step. A polished shell over broken interactions is the failure mode to avoid.
4. **Never fabricate a number without labelling it.** Any figure resting on assumed parameters carries an `illustrative` tag. This is a hard rule, not a preference — the whole project's credibility rests on it.
5. **No time-series charts anywhere.** There is no temporal data. Inventing a trend line contradicts the project's stated position.
6. **Ask rather than guess** on anything that changes a claim the UI makes. Layout details are yours to decide.

---

## 1. Stack

| | |
|---|---|
| Framework | React + Vite + TypeScript |
| Map | MapLibre GL JS (free vector style, no API key) |
| Server state | TanStack Query |
| UI state | Zustand or Context (selected tower, weights, view mode) |
| Charts | Recharts |
| Styling | Tailwind |
| Routing | React Router — five routes, see §3 |

**Excluded on purpose:** SSR, auth, component libraries, anything needing an API key, anything loading from a CDN at runtime.

---

## 2. Setup

```
cd src/frontend
npm create vite@latest . -- --template react-ts
npm i maplibre-gl @tanstack/react-query zustand recharts react-router-dom
npm i -D tailwindcss postcss autoprefixer && npx tailwindcss init -p
```

Assets already in place:

```
src/frontend/public/brand/mcmc-logo.png     ← nav rail + favicon, ref as /brand/mcmc-logo.png
src/frontend/public/perception/             ← proof images (placeholders until Colab exports land)
src/frontend/public/fallback/               ← static demo-safety JSON
```

---

## 3. Routes

| Route | Page | Purpose |
|---|---|---|
| `/` | Overview | Map + KPI strip + 4 stat tiles + tower drawer |
| `/schedule` | Schedule | Crew/tower grid, override, agent |
| `/weights` | Weights | Sliders + stability proof |
| `/perception` | Perception | Static deep-learning proof chain |
| `/method` | Method | Assumptions + limitations (static) |

Nav is a **collapsible overlay rail** — 56px icons, expands to ~220px on hover *and* focus, absolutely positioned above content, `margin-left: 56px` fixed on the content pane. **It must not reflow the page**: an in-flow rail resizes the MapLibre canvas on hover and tower dots shift under the cursor.

---

## 4. Build order

Stop and hand back for review after **step 3**, **step 7**, and **step 11**.

| # | Step | Est | Done when |
|---|---|---|---|
| 1 | Scaffold, overlay nav rail, five routes, mock fixtures | 0.75 h | All five routes reachable, rail expands without reflow |
| 2 | MapLibre + tower layer from mock JSON | 1 h | ~500 coloured dots + greyed unscored, legend states its rule |
| 3 | Tower drawer + attribution bars | 1 h | **Click a tower → score, interval, sorted factor bars** ← review |
| 4 | KPI strip + four stat tiles | 1 h | Tiles populate from fixture; bands tile filters the map |
| 5 | Weights page: sliders + stability readout | 1 h | Sliders re-score from a client-side scorer; ρ figure renders |
| 6 | Work-order card + timeline strip in drawer | 1 h | Action, crew, parts, `now → scheduled → due → monsoon` |
| 7 | Schedule grid, crew view + unscheduled bar | 1 h | **Grid renders, backlog visible** ← review |
| 8 | View toggle (by tower) + "why this slot" | 0.5 h | Toggle is one `groupBy`; readout is deterministic, no LLM |
| 9 | Override: pin, preview, emergency dispatch | 1.5 h | Preview shows knock-on cost, confirm/cancel, never blocks |
| 10 | Agent chat (mock streamed responses) | 1.5 h | Echoes parsed constraint, shows replan diff |
| 11 | Perception + Method pages | 0.75 h | **Static content, images from `public/`** ← review |
| 12 | Dark theme pass, empty states, error states | 1 h | Every fetch has loading + error; nothing blank on failure |

---

## 5. The five things that must work

If time runs out, these are what survive. They are the project's four claims plus the adoption story.

1. **Attribution bars** in the tower drawer — the system's explainability, and the join between risk and action.
2. **Weight sliders + stability readout adjacent to each other** — perturb, see the ranking hold.
3. **Bands tile** — how much work exists, with its rule stated (`top 10% = one crew cycle`).
4. **Override with impact preview** — the planner can disagree; the cost is shown but never enforced.
5. **Unscheduled backlog, visible** — capacity is genuinely short, and that is what makes ranking matter.

**Cut order under pressure:** route polylines → drag-and-drop (use a dropdown) → people-served and vs-calendar tiles → tower-view toggle → agent chat → perception page.

---

## 6. Mock data to generate

One fixture module, shapes exactly per [Frontend_Build_Plan §5](Frontend_Build_Plan.md).

- **~500 scored towers** clustered in Kelantan (approx. `101.3–102.7E, 4.5–6.3N`) + **~2,000 unscored** scattered nationally. Real OpenCellID download is optional; random points within state bounds are fine.
- **Bands:** ~7% maintain, ~17% watch, rest ok — do not make it uniform.
- **Attribution** must sum to 1.0 per tower, with a plausible dominant factor. Flood should dominate ~45% of the maintain set so the drivers tile reads correctly.
- **Crews:** ~5 in Kelantan (`KEL-C1` Kota Bharu civil, `KEL-C2` Gua Musang civil, `KEL-P1` power, `KEL-E1` electrical, `KEL-R1` RF), each with depot coordinates, `max_travel_km`, `shift_hours`, 2–3 named members. One placeholder crew per other state.
- **Schedule:** ~12 entries across 5 days, **deliberately leaving ~6 maintain-band towers unscheduled.** Do not make everything fit.
- **One pinned entry and one emergency entry** so those UI states are exercised from the start.
- **Demo tower `MY_1042`** — pin these values, they appear in every wireframe: risk 0.82 (0.76–0.88), maintain, flood 0.41 / power 0.28 / terrain 0.19 / equipment 0.12, LTE, 3 years old, Gua Musang, scheduled Tue with `KEL-C1`. **It must be the app's default selection on load** — the demo opens on it, nobody should hunt for it on stage.

**A client-side scorer is needed for the sliders** (noisy-OR: `1 − Π(1 − pᵢwᵢ)`), so re-scoring is instant without a backend. Keep it in `lib/` and swap for the API later.

---

## 7. Traps

- **Do not aggregate by state.** One dot / one row / one score = one physical tower. No choropleth anywhere. Averaging destroys the entire signal.
- **Schedule cells show place name + risk + dominant factor**, never bare tower IDs — bare IDs are unreadable at a glance.
- **Never label an assignment "AI-assigned."** The optimizer assigns; the agent supplies constraints and explains. This contradicts the project's central pitch line otherwise.
- **The "why this slot" readout must render without the LLM.** It is derived from solver state; the agent panel sits below it and is additive.
- **Grey unscored towers are a feature**, not a gap to hide. They make the national-scalability claim visible.
- **Colour thresholds must be labelled with their rule** in the legend and on the bands tile.
- **Per-tower view uses a timeline strip, not a Gantt.** Work orders are single-visit; a Gantt renders one bar.

---

## 8. Reviewer pass

After steps 3, 7, and 11, a reviewer agent inspects the work. Its brief:

**Scope:** UI/UX quality and functional defects in the implemented tabs. Not architecture, not the ML, not the docs.

**Check, in priority order:**

1. **Contract conformance** — components consume the §5 types faithfully; no invented fields, no silently dropped ones (`borderline`, `pinned`, `risk_lo/hi`, `unscheduled` are the ones most likely to be forgotten).
2. **The five must-works (§5)** — present and functional, not stubbed.
3. **Honesty rules** — every derived number labelled with its rule; assumed-parameter figures tagged `illustrative`; no time-series charts; no "AI-assigned" phrasing.
4. **Interaction defects** — click targets that do nothing, state that fails to reset between selections, drawer not updating on tower change, view toggle losing selection, override preview not cancelling cleanly.
5. **Map specifics** — does the nav rail hover reflow the canvas? Do dots shift? Does the legend match the actual paint expression? Are unscored towers visually distinct from `ok` towers?
6. **Loading and error states** — every fetch path. A blank panel reads as a broken product.
7. **Theme correctness** — contrast on the band colours, readable in both themes if both are supported.
8. **Accessibility basics** — rail reachable by keyboard, focus visible, click targets ≥ 32px.

**Output format:** one line per finding, `path:line: <severity>: <problem>. <fix>.` Severity ordered most-severe first. No praise, no restating what works, no scope creep into refactors. If nothing is wrong, say so in one line.

**Explicitly out of scope:** styling opinions unless they impair legibility or contradict a stated design rule; suggestions to add features; performance work unless something is visibly janky.

---

## 9. Open items

- `POST /score` currently returns `Tower[]` with no baseline ranking, but the Weights page shows an *impact of this change* panel. **Fetch the baseline once on mount and diff client-side** — do not add a field to the contract.
- Perception images do not exist yet. Use labelled placeholders; the Colab exports land later.
- Basemap style URL should be vendored or cached before demo day — a live tile dependency that fails on stage is fatal.
