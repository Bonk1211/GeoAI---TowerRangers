# Disaster Simulation Tab — Build Spec

Status: **spec, not yet built.** Written 2026-09-15. Companion to
`docs/Disaster_Response_Actions.md`, which establishes *what* MCMC actually does
during a flood and which parts of it are citable. This document specifies *how we
show it*: a new route that plays the Sabah flood scenario as a timed sequence over
a real map, with a console transcript beside it.

Read `docs/Disaster_Response_Actions.md` first — its timeline is the source of the
beats below, and its real-vs-simulated table is what the on-screen labels must
honour.

---

## 0. What this is, and the one sentence that governs it

A **scripted timeline that calls the real optimizer at the dispatch beats.**

The clock is ours. The crew assignments are the solver's. Everything the backend
cannot compute — antenna retune geometry, MOCN failover, COW coverage radius — is
animation, and says so on screen.

That split is the whole design. It exists because the alternative framings each
fail in a specific way:

- *Fully scripted* would make the scheduling claim decorative, and the optimizer is
  the entire point of Layer 2. A judge who asks "is that a real schedule?" must get
  yes.
- *Live-agent-driven* puts 10–40 s of LLM latency and an `ANTHROPIC_API_KEY`
  dependency between the user pressing Start and anything happening, and the agent
  may not choose the beat the narrative needs. `agent/runner.py` already ships a
  deterministic `_run_fallback` for exactly this reason; the simulation is a
  scripted path by the same logic, one level up.

**§0.6 still binds.** `docs/Backend_Handoff.md` §0.6 forbids fabricating failure
labels or failure-probability semantics. A simulated outage is not a prediction and
must never become one:

- Simulated down-state lives **only** in the simulation store. It is never written
  into a `Tower` record, never sent to the backend, never persisted.
- No screen in the simulation may say a tower *will* fail, or state a probability
  of failure. It says *"in this scenario, this tower is down"* — a stated premise,
  not a model output.
- The risk index's role here is unchanged and is the honest one: it is what
  **flagged the site beforehand**. The scenario's premise is "the flood happened";
  the system's claim is "we had already dispatched to the sites it hit".

---

## 1. Decisions already made

| Question | Decision | Consequence |
|---|---|---|
| Sim engine | Scripted timeline, real `/schedule/optimize` + `/schedule/emergency` at dispatch beats | Deterministic runtime; real crew names; works offline via existing fixture fallback |
| Down-state storage | `useSimulation` store only, `Set<string>` | No schema change, no §0.6 exposure, other pages unaffected |
| Tower data | Real towers from `/towers`, filtered to `territory === 'Sabah'` | Real coordinates and risk scores; `config/crews.json` already rosters Sabah crews |
| Deliverable | This spec first, then build | — |

---

## 2. Route and navigation

New page at **`/simulation`**, `pages/Simulation.tsx`.

Registration is two edits:
- `App.tsx` — one `<Route path="/simulation" element={<Simulation />} />`.
- `components/shell/NavPill.tsx` — one entry in `NAV_ITEMS` (`:17-25`).

**Nav has room.** After the tab trim, `NAV_ITEMS` holds five entries — Map,
Investigation, Tickets, Schedule, Health. A sixth fits without crowding the brand
mark or status chips, so Simulation ships as a top-level pill item. Still verify
the top row at 1280px and 1024px before calling the item done: below `lg` every
label collapses to `sr-only` (`NavPill.tsx:86`), leaving six icons in a row.

Place it **after Schedule**, so the pill reads in pipeline order — detect
(Map, Investigation), decide (Tickets, Schedule), then the scenario that exercises
all of it.

The page uses `PageHeader` (`components/ui/Panel.tsx:55-93`) like every non-map
route, so nav does not move between pages. It must **not** declare `h-screen` —
`App.tsx` owns viewport height (`:23-26`); the page is `flex h-full flex-col`.

---

## 3. Layout

Full-height, two regions under the header. Map dominant, console secondary.

```
┌────────────────────────────────────────────────────────────────┐
│ PageHeader: BrandMark · NavPill · StatusChips                  │
│             "Disaster Simulation"  [Scenario ▾] [▶ Start] [↺]  │
├─────────────────────────────────────────┬──────────────────────┤
│                                         │  PHASE STRIP         │
│                                         │  ● T-72h  pre-event  │
│                                         │  ○ T-0    impact     │
│              MAP                        │  ○ T+6h   response   │
│        (Sabah, simulation              │  ○ T+48h  recovery   │
│         overlays, animation)            ├──────────────────────┤
│                                         │  CONSOLE             │
│                                         │  monospace, streamed │
│                                         │  autoscroll          │
│                                         │  [timestamp] line    │
│                                         │                      │
├─────────────────────────────────────────┴──────────────────────┤
│ TRANSPORT: ◀▶ ── clock T+06:14 ── [1× 2× 4×] ── progress bar   │
└────────────────────────────────────────────────────────────────┘
```

Proportions: map ~62% width, right column ~38% (min 380px, max 520px). Below
`lg`, stack — map on top at fixed height, console below. The transport bar spans
full width because it governs both.

### Why the console sits beside the map, not under it

The two are read together: a console line lands *as* its animation plays, and the
eye must reach both without scrolling. Stacked vertically at demo-projector
aspect ratios one of them falls below the fold.

---

## 4. Components

New directory `components/simulation/`, following the existing feature-area
grouping (`components/{hud,map,schedule,tower,…}/`).

| File | Responsibility |
|---|---|
| `SimulationMap.tsx` | The MapLibre instance. **Silent** — never calls `setMap`/`setView` (see §5). |
| `SimulationConsole.tsx` | Monospace transcript. New component; nothing like it exists (`AgentChat` is chat bubbles, not a log). |
| `PhaseStrip.tsx` | Four phase markers, current one lit. Reads `phase` from the store. |
| `TransportBar.tsx` | Play/pause, scrub, speed (1×/2×/4×), elapsed clock, progress. |
| `ScenarioPicker.tsx` | Scenario select. Ships with one entry (Sabah) — a select with one option is honest about being a seam, a hardcoded title is not. |
| `SimulationLegend.tsx` | What the overlay marks mean, and which are illustrative. Not optional — see §8. |
| `ActionCard.tsx` | The card that surfaces per-beat detail (crews assigned, ETA, what was retuned). |

New pure modules in `lib/`, each dependency-free and therefore testable with the
existing `node --experimental-strip-types --test` pattern (see CLAUDE.md — ten such
test files exist):

| File | Responsibility |
|---|---|
| `lib/simulationTimeline.ts` | The beat table (§6) and pure selectors: `beatsUpTo(ms)`, `phaseAt(ms)`, `totalDurationMs`. **No React, no side effects.** |
| `lib/simulationClock.ts` | rAF clock: elapsed ms, speed multiplier, play/pause/seek. Pure state machine + a tick function; the rAF driver is a thin hook over it. |
| `lib/coverageGeometry.ts` | Bearing from A to B, and the sector-cone GeoJSON polygon for a retuned antenna. Pure trig. |

New store `state/useSimulation.ts` (Zustand, matching the existing store pattern).

---

## 5. Map instance — the rule that must not be broken

`SimulationMap` is the **fourth** MapLibre instance in this app and must be silent
like the second and third.

`RouteMap.tsx:15-27` and `DispatchRoutePreview.tsx:26-30` both carry a comment
explaining why they never touch `useMapInstance`: the console's graticule ticks,
cursor readout and scale rule all derive from whichever map published itself. A
second publisher makes the map console's chrome describe a panel it is not
labelling. `SimulationMap` follows them exactly — **no `setMap`, no `setView`, no
`setCursor`.**

Reuse from `components/map/basemap.ts`: `BASEMAP_STYLE_URL` (never inline a style
URL — it drifted once), and `groundAnchor(map)` so simulation overlays insert
below the first symbol layer and place names stay legible through them. Towers are
not ground and stay on top.

Camera: `fitBounds` to the Sabah tower set on scenario select, using the padding
discipline from `hud/AreaModule.tsx:28-41` — asymmetric and clamped to a share of
the canvas, so a narrow window loosens the fit rather than asking `fitBounds` to
solve a negative viewport. One difference from `AreaModule`: nothing floats over
this map, so padding can be near-symmetric; the clamp still matters.

Zoom-to-scenario is a **camera move in the start handler**, not an effect on tower
data. `useLiveTowers` returns a fresh array identity on most renders
(`useLiveTowers.ts:38-60`, worked around in `AreaModule.tsx:88-95` and
`RouteMap.tsx:120-131`); an effect keyed on it would re-fly the camera mid-run.

### Map layers the simulation adds

All inserted below `groundAnchor` except tower marks:

| Layer | Type | Carries |
|---|---|---|
| `sim-flood-extent` | fill | The scenario's flood polygon, animated in over the impact phase |
| `sim-coverage-gap` | fill | Dead-zone footprint around a down tower |
| `sim-sector-cone` | fill | Retuned antenna sector, one per assisting tower (from `coverageGeometry`) |
| `sim-down-tower` | circle/symbol | Outage mark on affected towers |
| `sim-dispatch-route` | line | Crew route, dashed, with a moving marker |
| `sim-cow` | symbol | Deployed mobile base station |

The existing tower layers (`towerLayer.ts`) render underneath unchanged — the
simulation adds marks, it does not recolour the population. **Whatever filter
applies to `towers-layer` must also apply to `towers-icon-layer`** (CLAUDE.md:
band-filtering one without the other leaves icons floating with no halo).

---

## 6. The timeline

Total runtime **~2 minutes at 1×**. Long enough to read, short enough to run twice
in a Q&A.

Each beat is a row in `lib/simulationTimeline.ts`. Shape:

```ts
interface Beat {
  id: string;
  atMs: number;              // offset from run start, at 1x
  phase: 'pre' | 'impact' | 'response' | 'recovery';
  clockLabel: string;        // scenario time, e.g. "T-72h"
  console: string;           // the transcript line
  kind: 'scripted' | 'backend';   // backend beats await a real call
  effect?: SimulationEffect; // what the map does
  evidence?: 'real' | 'illustrative';  // drives the console badge
}
```

### Phase 1 — Pre-event (T-72h → T-24h)

| Beat | Console line | Backing |
|---|---|---|
| `forecast` | `GFS 24h rainfall + GloFAS days 1-3 outlook crossing threshold over Sabah west coast` | **Real mechanism** (`flood/forecast.py`), scripted values in sim |
| `urgency-shift` | `Urgency multiplier applied to flood-coupled factors — N towers moved into maintain band` | Real mechanism (`scheduler/urgency.py`); count from the actual filtered set |
| `optimize` | `POST /schedule/optimize → <n> work orders across <k> crews` | **Real call.** Crew names, counts, days are the solver's |
| `harden` | `Site hardening dispatched: <tower_id> … (civil crew <crew_id>)` | Real assignment from the run above |
| `generators` | `Portable generators pre-positioned at <n> flood-prone sites` | Real practice, scripted placement |

Map: flood forecast overlay fades in; flagged towers pulse; crew routes draw from
depots with the `DispatchRoutePreview` moving-marker pattern.

### Phase 2 — Impact (T-0)

| Beat | Console line | Backing |
|---|---|---|
| `flood-onset` | `Flood extent expanding — Penampang, Putatan` | Scenario premise |
| `tower-down` | `Signal loss: <tower_id> (power outage)` | **Scenario premise, stated as such** |
| `taskforce` | `Task force activated — MCMC + telco + SESB joint monitoring. Reserve crew-days held.` | Real practice; reserve mechanism is real (`scheduler/reserve.py`) |

Map: flood polygon grows; affected towers switch to outage mark; coverage gap
appears as a footprint.

**This is the beat where §0.6 is closest to the line.** The console line is
`Signal loss: MY_xxx` — an observation inside a stated scenario. It must never read
as `MY_xxx predicted to fail` or carry a probability.

### Phase 3 — Response (T+1h → T+12h) — escalating, in the real order

Ordered exactly as `Disaster_Response_Actions.md` §T+hours: remote actions first,
truck rolls only when remote cannot cover.

| Beat | Console line | Backing |
|---|---|---|
| `antenna-retune` | `NMC remote adjustment — <n> neighbouring cells: downtilt + azimuth widened, TX power boosted` | **Real action, illustrative geometry** |
| `mocn` | `MOCN failover — affected subscribers routed onto surviving cross-operator cell` | **Real action, illustrative attribution** |
| `generator-dispatch` | `Emergency work order: generator dispatch → <tower_id>` | **Real call** (`/schedule/emergency`) |
| `cow` | `COW deployed to <location> — terrain prevents neighbour-cell coverage` | Real action, scripted placement |
| `prime` | `MCMC PRIME unit → evacuation centre (satellite backhaul, Wi-Fi, drone relay)` | Real practice, out of tower scope |

Map: **sector cones swing** from neighbouring towers toward the gap (the visual you
described); MOCN link line draws between operators; COW icon travels in and its
coverage footprint appears; gap footprint shrinks as each action lands.

### Phase 4 — Recovery (T+24h → T+48h)

| Beat | Console line | Backing |
|---|---|---|
| `restore` | `<tower_id> restored — permanent power returned` | Scenario |
| `withdraw` | `COW withdrawn; sectors returned to nominal; reserve released` | Scenario |
| `ledger` | `Outcome appended to observation ledger — unlabeled until confirmed` | **Real mechanism** (`model/feedback.py`), and the honest note that it is unlabeled |

Map: overlays retract; cones return to nominal; towers return to band colour.

### Summary panel at end

Not a victory screen — a comparison. What the risk index flagged in advance versus
what the scenario actually hit, and the time-to-response. If the flagged set and
the hit set diverge, **show that too**; a demo that can only succeed is not
evidence of anything.

---

## 7. Backend beats — how the real calls are woven in

Two beats (`optimize`, `generator-dispatch`) call live endpoints. Three rules:

1. **Prefetch, don't block.** Fire `/schedule/optimize` when the user presses
   Start, not when the clock reaches the beat. Store the promise. The beat renders
   when *both* the clock has arrived and the promise resolved. The first ~15 s of
   timeline is pre-event narration, which is ample cover for a solver call.
2. **A failed call degrades to scripted, visibly.** On error the beat still fires,
   the console line prints with an `offline` badge, and the existing
   `withOfflineFallback` machinery sets the global offline flag so `OfflineBanner`
   appears. Never a silent substitution — CLAUDE.md is explicit that a narrated-as-
   live demo quietly showing fixtures is worse than a visible failure.
3. **Anchor the run.** `/schedule/emergency` re-solves against `_anchor(run)`,
   i.e. `run.horizon[0]`, not the demo clock. That is already fixed backend-side
   (`api/routes/schedule.py`); the simulation must pass the run it got from the
   `optimize` beat, or the second call lands in a different horizon than the first.

**Do not seed text into the agent composer as part of this.** `agent/tools.py`'s
no-API-key parser turns any 4-digit number plus a trigger word ("emergency",
"dispatch now") into an emergency dispatch against a *different* tower, and
`ParsedConstraint.to_pins()` returns `[]`, so the turn silently re-optimizes the
whole board. The simulation calls the schedule routes directly and never routes
through the chat parser.

---

## 8. Honesty surface — non-negotiable

Three mechanisms, because this is the screen most able to overstate what the
system does:

1. **Per-line evidence badge in the console.** Each line carries one of:
   - `real` — this came from a live endpoint (solver output, tower data)
   - `mechanism` — the mechanism exists in this codebase, values are scripted
   - `illustrative` — real MCMC practice, but this project has no data to compute
     it; geometry and attribution are simulated
   Three states, each with a **word** and not only a hue — the Model Health page
   sets this precedent precisely so a colour-blind reader is not excluded.

2. **A standing banner on the page**, not a dismissible toast: *"Scenario playback.
   Flood extent and outages are a stated premise, not a prediction. Crew
   assignments are live optimizer output."*

3. **`SimulationLegend`** naming each overlay and which category it falls in.

The distinction the copy must carry, from `Disaster_Response_Actions.md`, is
**"the action is real" vs "this specific number is simulated"** — not "this whole
thing is made up". Antenna retune genuinely is what MCMC does; we simply cannot
compute the bearing from data we hold.

---

## 9. Animation

`motion` v13 is already a dependency and is the established tool here.

- **Moving markers along a route**: the existing primitive is
  `DispatchRoutePreview.tsx:180-195` — `animate(0, 1, { duration, onUpdate })`
  lerping `Marker.setLngLat` along a line. Reuse that shape for crew vehicles and
  the COW.
- **Sector cones swinging**: animate the bearing value, regenerate the cone
  polygon per frame via `coverageGeometry`, and `setData` on the GeoJSON source.
  Cap at ~30 fps for the polygon rebuild; the eye cannot tell and it keeps the
  main thread free.
- **Flood extent growth**: interpolate `fill-opacity` and swap between a small
  number of pre-computed extent polygons. Do not try to morph geometry per frame.
- **Pulse/arrival**: `.route-pulse` already exists in `index.css:543`.
- **`prefers-reduced-motion`**: honour it. `DispatchRoutePreview.tsx:176-179`
  shows the established treatment — park the token at its midpoint rather than
  animating. Every simulation animation needs an equivalent still state, and the
  timeline must remain fully legible without any motion at all.

**Blur budget.** CLAUDE.md caps glass surfaces at 8 and forbids blurring anything
that animates over a moving map. The console and phase strip are static panels and
may be glass; nothing on the map canvas gets `backdrop-filter`.

---

## 10. Colour

The design system's governing rule is unchanged: **cool accent = interface chrome;
warm = data severity.**

- Transport controls, phase strip, console chrome, scenario picker → `--color-accent`.
- Tower risk marks → `bandColor()` for fills, `bandInk()` for text
  (`lib/colors.ts`). Never `bandColor()` on a `color:` property.
- Flood depth overlay → the existing `WATER_DEPTH_BANDS` ramp **with its numeric
  legend**. Those warm hues also appear in decision bands, which is exactly why
  CLAUDE.md makes the numeric key mandatory.
- **Outage mark** needs a new treatment and must not simply be red — red is
  `maintain` band. Suggested: a neutral desaturated fill plus a distinct ring and a
  literal `OFFLINE` label. Shape and text carry it, not hue.
- **Sector cones** are neither severity nor chrome. Follow the precedent
  `lib/reserveHatch.ts` set for reserve capacity: a neutral `overlay`-token
  treatment, defined **once** and imported everywhere it is drawn. Four hand-typed
  copies of a hue string is how the band triad drifted before.
- Type: the eight named steps only (`--text-eyebrow|micro|ui|body|lead|title|
  display|hero`). No `text-[13px]`. The console is `font-mono` + `.tnum`, which
  also disables Fira Code ligatures — mandatory, or `->` in a log line silently
  becomes one glyph.

---

## 11. Store shape

```ts
// state/useSimulation.ts
interface SimulationState {
  scenarioId: string | null;
  status: 'idle' | 'running' | 'paused' | 'done';
  elapsedMs: number;
  speed: 1 | 2 | 4;

  firedBeatIds: string[];          // ordered, drives the console
  phase: 'pre' | 'impact' | 'response' | 'recovery';

  // Simulation-local, never written to a Tower record:
  downTowerIds: Set<string>;
  retunedSectors: { towerId: string; bearingDeg: number; targetId: string }[];
  deployedCows: { id: string; lon: number; lat: number }[];

  // Real backend results captured during the run:
  optimizeRun: ScheduleRun | null;
  emergencyRun: ScheduleRun | null;

  start(scenarioId: string): void;
  pause(): void;
  resume(): void;
  seek(ms: number): void;
  reset(): void;
}
```

`downTowerIds` as a `Set<string>` in this store is the §0.6 firewall. It is read by
the map overlay and nothing else. It is not serialized, not sent to the backend,
and not merged into any `Tower` object.

---

## 12. Scenario definition

`fixtures/scenarios/sabahFlood.ts`:

```ts
interface Scenario {
  id: 'sabah-flood-2025';
  label: string;
  territory: 'Sabah';
  bounds: [number, number, number, number];
  floodExtents: { atMs: number; polygon: GeoJSON.Polygon }[];
  downTowerSelector: (towers: Tower[]) => string[];
  beats: Beat[];
}
```

`downTowerSelector` is a **function over the live population, not a hardcoded id
list**, because tower ids come from OSM and a hardcoded id that vanishes on the
next dataset rebuild would break the demo silently. Select by geography and band —
e.g. the highest-flood-share towers inside the flood polygon — so the scenario
survives a data refresh.

Flood polygons: hand-authored from the real 2025 event's affected districts
(Penampang, Putatan, Kota Kinabalu west coast). Coarse is fine and honest; they are
labelled as scenario premise, not as an observation.

---

## 13. Build order

Each step ends somewhere demoable — no half-built intermediate states.

1. **Skeleton** — route, nav entry, `PageHeader`, three empty panels, store with
   `status` only. Navigable, obviously unfinished.
2. **Clock + console** — `simulationClock.ts`, `simulationTimeline.ts` with beats
   but no map effects, `SimulationConsole`, `TransportBar`, `PhaseStrip`. Press
   Start, watch lines land on time. **Unit tests for both lib modules here**, while
   they are still pure.
3. **Map, static** — `SimulationMap` (silent instance), Sabah towers, `fitBounds`
   on scenario select. No animation.
4. **Impact overlays** — flood extent, outage marks, coverage gap. First beat that
   changes the map.
5. **Backend beats** — real `/schedule/optimize` and `/schedule/emergency`, with
   prefetch and visible offline degradation.
6. **Response animation** — sector cones, MOCN link, COW arrival, crew routes.
7. **Honesty surface** — evidence badges, banner, legend. *(Listed last only
   because it annotates finished content; if the build is cut short, this ships
   anyway. A demo without it overstates the system.)*
8. **Reduced-motion pass + narrow-width check** — including the nav-crowding
   decision from §2.

---

## 14. Testing

No React test infrastructure exists in this repo (`package.json` has no `test`
script; `lint` is oxlint, `build` is `tsc -b && vite build`). Follow the existing
pattern instead: the three `lib/` modules are dependency-free, so they get
`node --experimental-strip-types --test` files alongside the ten that already
exist.

```bash
cd src/frontend
node --experimental-strip-types --test src/lib/simulationTimeline.test.mjs
node --experimental-strip-types --test src/lib/simulationClock.test.mjs
node --experimental-strip-types --test src/lib/coverageGeometry.test.mjs
```

**Value imports in a tested `lib/` module need explicit `.ts` extensions; type-only
imports must not have them.** Node's ESM resolver will not infer an extension, and
the failure appears only under the test runner while the build and bundle stay
green. `ticketSuggestion.ts` carries the extensions and a comment saying why.

Worth pinning in tests:
- `beatsUpTo(ms)` is monotone and never re-fires a beat.
- `phaseAt(ms)` covers every boundary, inclusive-exclusive stated explicitly.
- Speed change mid-run preserves elapsed scenario time (the classic bug: switching
  1× → 2× jumps the clock because the multiplier was applied to accumulated time
  rather than to the delta).
- `seek` backwards clears beats fired after the target.
- Bearing maths: cardinal directions, the antimeridian, and identical points (which
  must not produce `NaN`).

UI verification is `npm run build` + `npm run lint` + a browser pass. Per CLAUDE.md,
a passing build does **not** verify visual, animation or map-rendering behaviour —
and `npm run build` specifically cannot catch the MapLibre worker bug, which is
dev-only.

---

## 15. Explicitly out of scope

- Any RF propagation model. The cones are geometry, not physics.
- Any backend simulation service. The timeline is client-side.
- MicroFish or any agent-based simulation framework — evaluated and rejected: its
  model is agents evolving strategies under selection pressure, which is not what a
  scripted response timeline needs, and it would add a heavy dependency for
  bearing arithmetic.
- Writing simulated state to the backend or into any `Tower` record.
- Multi-scenario authoring UI. One scenario, behind a picker that can take more.
- Real outage telemetry ingestion. When that data exists it belongs on the live
  map, not here.

---

## 16. Open questions

1. **Nav placement** — ninth pill item, or grouped under Schedule (§2)?
2. **Does the pre-event optimize call use the whole national population or Sabah
   only?** Sabah-only is faster and focused; national is more honest about how the
   planner really runs, and lets the summary state *"of N national maintain-band
   orders, k were in the affected districts"*, which is a stronger claim.
3. **Should the summary panel compare against the baseline dispatcher?**
   `scheduler/baseline.py` and the `risk_weighted_wait_reduction_pct` metric
   already exist, and "nearest-first would have reached these towers j days later"
   is the sharpest number available. Costs one more backend call.
