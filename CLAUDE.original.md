# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Predictive maintenance for Malaysian telecom towers, built for the ASEAN GeoAI Fusion 2026 hackathon (Innovation track). Full narrative in `docs/Concept_Overview.md`. Three-stage arc:

```
detect                    decide                      dispatch
Tower Health Risk Index → Action + urgency          → Crew schedule
(ML, unsupervised,         (dominant risk factor       (greedy optimizer,
 physics-based)             -> work order + SLA)        constraints, agent overlay)
```

- **Layer 1 — Risk Index** (`src/backend/model/`): scores every tower 0-1 with an uncertainty band and per-factor attribution (flood, terrain, lightning, equipment, power). Not a failure predictor — no failure labels exist anywhere in this project, and code must not imply one (see `docs/Backend_Handoff.md` §0.6).
- **Layer 2 — Scheduler** (`src/backend/scheduler/` + `agent/`): turns `dominant_factor` + `urgency_days` into work orders, then a greedy solver packs them into crew-days under territory/depot/crew-type/SLA/monsoon constraints. **The optimizer decides; the LLM never emits a schedule** — the agent only calls tools and reports their return values verbatim.

`docs/Backend_Handoff.md` is the authoritative spec for the scheduler/agent/API surface — read it before touching `src/backend/scheduler/`, `agent/`, or `api/`. `docs/ML_Implementation_Plan.md` covers the risk-index phases (perception, membership curves, AHP weights, attribution, rank-stability validation).

## Commands

### Backend (`src/backend/`, Python)

On Windows, `python3` resolves to the Microsoft Store alias stub and fails — use `py` (or `python`). The `python3` spellings below are the POSIX form; substitute `py` on Windows. `pytest` is **not** in `requirements.txt`, so install it separately if you want the pytest paths.

```bash
pip install -r src/backend/requirements.txt
pip install pytest        # not in requirements.txt

# Run the API (from src/backend/, so `api`/`scheduler`/`model` resolve as top-level packages)
cd src/backend && uvicorn api.main:app --reload

# Tests — modules use relative imports and are runnable standalone or via pytest,
# always from within src/backend/ (or the specific subpackage, per each file's own docstring)
cd src/backend && python3 model/test_risk_index.py              # 9 tests
cd src/backend && python3 data/test_prepare_pilot_dataset.py    # 5 tests
cd src/backend && python3 data/test_prepare_real_dataset.py     # 3 tests
# or: cd src/backend && pytest -q       # 17 tests across the three files
cd src/backend && python3 flood/test_layers.py                   # 8 tests, no network
cd src/backend && pytest model/test_risk_index.py::test_bounds   # single test
```

Earth Engine flood layers (optional — every other route works without them):
```bash
pip install -r src/backend/requirements-flood.txt
gcloud init && earthengine authenticate      # or use a service account
export GEE_PROJECT=<gcp-project-id>          # must have the Earth Engine API enabled
# headless alternative to `earthengine authenticate`:
export GEE_SERVICE_ACCOUNT_EMAIL=<sa@project.iam.gserviceaccount.com>
export GEE_PRIVATE_KEY_FILE=/path/to/key.json
curl localhost:8000/flood/layers             # catalogue + credential status; always answers
```

Regenerate datasets (writes into `data/`, and `src/frontend/public/flood/`):
```bash
python3 src/backend/data/prepare_pilot_dataset.py   # data/pilot_sunway — real Sunway feature table
python3 src/backend/data/prepare_real_dataset.py    # data/real_sources — ASEAN ITU + catalog data
python3 src/backend/data/prepare_flood_surface.py   # flood/*.png — HAND stage masks (2D)
python3 src/backend/data/prepare_flood_volume.py    # flood/flood_volume.geojson — depth polygons (3D)
```

### Frontend (`src/frontend/`, React + TypeScript + Vite)

```bash
cd src/frontend
npm install
npm run dev       # Vite dev server
npm run build      # tsc -b && vite build
npm run lint       # oxlint
npm run preview
```

Requires `VITE_API_BASE` (see `.env.example`) pointing at the backend, default `http://localhost:8000`.

There is **no test runner in the frontend** — `lint` is oxlint and `build` is `tsc -b && vite build`. Verification of UI work is `build` + `lint` plus checking it in a browser; do not claim a visual, accessibility, or map-rendering change is verified on the strength of a passing build. In particular `npm run build` cannot catch the MapLibre worker bug described below, which is dev-only.

### Notebook

`notebooks/maintenance_decision_training.ipynb` is the executed end-to-end ML workflow (baseline vs logistic regression vs random forest, physically-grouped validation) over the real Sunway feature table; exports to `artifacts/ml/`. Regenerate the notebook source from `notebooks/generate_maintenance_decision_notebook.py`.

## Architecture

### Backend layout (`src/backend/`)

```
model/       risk_index.py — membership curves -> noisy-OR -> AHP-weighted score -> leave-one-out attribution
             validate.py — rank-stability check (perturb weights, confirm high-risk set is stable)
             ml/ — trained maintenance-decision classifier artifacts (joblib + metadata), from the notebook
adapter/     ml_source.py — maps prepared CSVs into the scored-tower contract the scheduler consumes
scheduler/   actions.py     dominant factor -> work order (crew type, parts, why-string) via config/actions.yaml
             optimize.py    greedy assignment: sorts by priority x urgency, bin-packs into crew-days
             override.py    pin / preview / emergency insertion — preview never mutates stored state
             explain.py     deterministic "why this slot" — renders from solver state, no LLM
             baseline.py    naive nearest-first dispatch, for the risk-weighted-wait delta metric
             store.py       schedule run storage
config/      crews.json (roster/depots/territories), actions.yaml (factor -> intervention), policy.yaml
             (SLA caps, shift hours, travel assumptions, monsoon window) — config over code; the scheduler's
             behavior should change by editing these files, not by editing scheduler/*.py
agent/       tools.py — four typed tools: score_towers, propose_actions, optimize_schedule, apply_constraint
             runner.py — tool-calling loop + SSE. Uses real Claude tool-calling when ANTHROPIC_API_KEY is set;
             otherwise a deterministic fallback (apply_constraint -> echo -> optimize) with the same SSE
             event vocabulary, so the frontend never needs to know which path is active.
api/         main.py (FastAPI app, single base URL for both scheduler and ML-owned routes), routes/ (one
             module per resource: agent, baseline, crews, schedule, towers), schemas.py
fixtures/    scored_towers.py — mock scored-tower fixture, stands in until the ML pipeline's endpoint lands
```

Key invariant: the **scored-tower record** (`tower_id`, `risk`, `decision`, `dominant_factor`, `urgency_days`, `attribution`, documented in `docs/Backend_Handoff.md` §1) is the contract boundary between the risk index and the scheduler. The scheduler consumes it and never recomputes scoring.

Route registration order in `api/main.py` matters: `baseline` is registered before `schedule` because `/schedule/baseline` would otherwise be shadowed by `schedule.router`'s `/schedule/{run_id}`.

### Frontend layout (`src/frontend/src/`)

- `pages/` — top-level routed views: Overview, Schedule, Weights, Method, Perception, TowerDetail.
- `components/{hud,map,schedule,tower,stats,weights,shell,method,perception}/` — grouped by feature area, not by component type. Two exceptions: `components/ui/Panel.tsx` holds the shared `Panel`/`PageHeader`/`Button`/`Stat` primitives every feature area composes from, and `components/shell/` holds the app-wide chrome (`BrandMark`, `NavPill`, `StatusChips`, `OfflineBanner`) that both the map console and `PageHeader` render. `components/hud/` is map-console-only.
- `api/` — `client.ts` (fetch wrapper), `queries.ts` (TanStack Query hooks), `types.ts` (mirrors backend response shapes exactly — keep in sync with `api/schemas.py`), `useLiveTowers.ts`/`useLiveSchedule.ts`.
- `state/` — Zustand stores (`useScheduleStore`, `useScheduleSelection`, `useWeights`, `useSelection`, `useMapFilter`, `useOffline`, `useMapInstance`, `useScoreOpacity`).
- `lib/` — pure logic, no React: `scorer.ts`, `stability.ts`, `whySlot.ts`, `overridePreview.ts`, `agentParser.ts` (SSE event parsing), `aggregate.ts`, `scheduleDays.ts`, `colors.ts`, `geo.ts` (haversine), `graticule.ts` (tick/scale maths), `route.ts` (crew-day -> drawable route). Because these are dependency-free they are the only frontend code that can be checked without a browser — a short `node` script against hand-computed values is the closest thing to a unit test this frontend has.
- `fixtures/` — local mock data for offline/demo mode, mirroring the backend fixtures.

The API response shapes are frozen (frontend built against them ahead of backend completion) — when changing a backend endpoint's shape, `api/schemas.py` and `src/frontend/src/api/types.ts` must be updated together.

**Live-vs-offline data flow.** Every query goes through `withOfflineFallback()` in `api/queries.ts`: on a network failure it returns the matching `fixtures/` data *and* sets the global `useOffline` flag, which renders `OfflineBanner`. The rule that makes this safe is that the fallback is never silent — a demo narrated as live while quietly showing fixtures is worse than a visible failure.

**A fallback must be real data or `null` — never a zeroed struct.** `withOfflineFallback` takes whatever you hand it, and a zeroed object is truthy, so every consumer's `data ? … : '—'` and `data ?? BASELINE` guard silently takes the wrong branch. This shipped: `useStabilityQuery` fell back to `{rho_mean: 0, …}`, so while offline the status chip rendered `ρ 0.00` and `/weights` rendered `Draws 0` as though they were measurements — and ρ = 0 happens to mean "the ranking is pure noise", the most alarming reading the model can produce, shown in calm grey. `TOWERS` and `CREWS` are legitimate fallbacks because a real fixture exists; there is no fixture stability run, so the honest fallback is absence. Type the query `T | null` so the compiler enforces the guards. `useLiveTowers(weights)` sits on top and is the single source of truth for "towers as scored by the current slider weights"; the map and every console module read from it so they recolour together. At baseline weights it passes `/towers` through; off-baseline it debounces ~300ms and calls `POST /score` (server authoritative), falling back to the client-side `lib/scorer.ts` noisy-OR only when genuinely offline.

**The design system has one governing rule: cool accent = interface chrome, warm triad = risk severity, never mixed.** `--color-accent` (violet `#7c3aed`) carries nav, focus, controls, and interactive states; `--color-maintain`/`--color-watch`/`--color-ok` and `--color-alert` are reserved for data. A warm colour appearing on a control is a bug — it destroys the property that a warm hue on screen always means "this is a risk reading". Tokens live in `@theme` in `src/index.css`. The accent's *value* has changed twice (cyan -> violet -> darkened violet for the light theme) but its *role* never does; if you find a warm hue on a control, that is the bug, not the token. `.spine` is a band-coloured edge applied to any surface carrying a tower's severity via a `--spine` custom property.

**The app is light-themed, and severity has two ramps that are not interchangeable.** `lib/colors.ts` exports `bandColor()` for FILLS (map circles, bars, spines, chip backgrounds; >=3:1) and `bandInk()` for TEXT and thin marks (>=4.5:1); the Tailwind equivalents are `bg-watch` versus `text-watch-ink`. The dark theme needed only one ramp because a saturated hue on near-black clears both bars at once — on white it does not, and the old `#ffb244` measures 1.90:1 as text. **`bandColor()` driving a `color:` property is a bug.**

**`--color-overlay` is the hinge the whole theme turns on.** Every surface tint and hairline in the component tree is written as `overlay/<alpha>` (146 usages) rather than as a literal, so the ink/paper polarity of the entire app is one token. It is `#0d1526` here; setting it to `#ffffff`, alongside the ground and text ramps in `@theme`, is most of what returning to the dark theme would take. Do not reintroduce `white/<alpha>` utilities — they hardcode the polarity back into 38 files.

**Elevation is carried by shadow, not glow.** `--shadow-1/2/3` in `:root` are the only elevation steps; every glow the dark theme used (spine bleed, slider thumb ring, route-depot halo, selected-dot halo) was removed, because a glow on a light ground reads as a rendering artefact. `.spine` compensates with a 3px rule instead of the old 2px-plus-glow.

**Contrast on the map console is measured, not assumed — and the polarity is the opposite of what it was.** The basemap is Positron (now served by OpenFreeMap, see below) under a **white** wash at **0.20**, so the worst case for the console's dark text is the basemap's DARKEST patch (its own label ink), not its brightest as it was on Dark Matter. Measured against the current composite that worst case gives 3.09:1. Any new text placed over the basemap must clear 3:1 against that composite. The graticule labels and bottom-left readout use `--color-fg`, which is heavier than a secondary readout would normally take: that is deliberate, and it is what buys the wash down from 0.35 to 0.20. At 0.35 the white wash collapsed the land/water boundary, and on a map of a peninsula the coastline is most of the information. A `text-shadow` (a light halo now, not a dark one) improves legibility but does not change the measured ratio. The failing candidates are named in comments at each site.

**Component classes in `index.css` must stay inside `@layer components`.** Unlayered CSS beats *every* layered Tailwind utility regardless of specificity, so an unlayered `.glass { border: 1px }` silently defeats `border-x-0` on the element, and an unlayered `position: relative` defeats `absolute`. Both have already shipped as bugs here — the (since removed) map `Legend` was pushed out of the map and down over the stat tiles, and the border-side resets on the page headers were being ignored. These classes are *defaults*; a utility on the element must always win. Pseudo-element rules (`.spine::after`, `.glass-sheen::before`) carry no utility conflict and stay unlayered.

**The basemap is OpenFreeMap's Positron, and it is vector.** CARTO's keyless endpoint stamps "API KEY REQUIRED" across every labelled tile (verified with `X-Cache: MISS`, since a probe off a warm edge cache comes back clean and is the easy way to misdiagnose it). OpenFreeMap serves the same open Positron cartography, which is precisely why it was chosen over Esri Light Gray or anything else: every contrast figure here was measured against Positron, and a different cartography would have voided all of them. Re-measured after the swap anyway — `--color-fg` on the composite's darkest patch is **3.09:1**, still clearing the 3:1 bar but tighter than CARTO's 4.43:1, because OpenFreeMap renders label ink slightly darker. Treat that as the margin to protect: anything that darkens the basemap further needs re-measuring, not assuming. Both instances read `BASEMAP_STYLE_URL` from `components/map/basemap.ts` — the config used to be duplicated inline in `MapView` and `RouteMap`, so one could drift from the other. Vector also changed layer ordering for the better: `groundAnchor(map)` finds the style's first symbol layer, and every ground overlay (relief, inundation, flood hex, water volume, Earth Engine rasters) is inserted **before** it so place names stay legible through the water. Towers are not ground and stay on top. The anchor is resolved at runtime rather than hardcoded to `waterway_line_label`, because the style is third-party and can be renumbered; a missing anchor yields `undefined`, which MapLibre reads as "append on top" — the layer still draws. Caveat: OpenFreeMap is donation-funded with no SLA, fine here and worth revisiting before production.

**The map console (`/`) is full-bleed and owns the whole frame.** `Overview.tsx` composes `MapView` plus floating modules from `components/hud/`; no chrome is a layout parent of the map, so the map is never resized by a panel appearing. Three things about it are easy to break:

- **Pointer events.** The overlay wrapper is `pointer-events-none` and each module opts back in with `pointer-events-auto`. Without that discipline the invisible positioning boxes around floating modules swallow clicks meant for towers underneath them. Everything in `MapOverlays.tsx` (dim, graticule, vignette, ticks, readout) stays non-interactive.
- **Stacking.** HUD overlays are later siblings carrying `z-10`/`z-20`, so MapLibre's own control corners are pinned to `z-index: 30` in `index.css` or the dim and vignette paint over the zoom buttons. The zoom control also lives bottom-right, not the MapLibre default top-right, because the status chips occupy that corner.
- **Blur budget: 8 surfaces, ceiling `blur(14px) saturate(1.1)` (`--glass-blur`).** Never blur an element that animates position or opacity, and never over a moving map at full strength. The vignette in `MapOverlays.tsx` is load-bearing, not decoration — it does the contrast work `backdrop-filter` would otherwise have to, and it now fades toward the page ground rather than toward black, so the map dissolves into the app instead of into a hole. Every glass surface also carries an opaque-ish gradient so it degrades acceptably when `backdrop-filter` is unsupported, and `prefers-reduced-transparency` swaps them solid.

**`useMapInstance` is how chrome reads the map.** The edge coordinate ticks, cursor readout and scale rule derive from `map.getBounds()`, published from a `move` handler coalesced through `requestAnimationFrame` (`moveend` alone makes the ticks visibly lag a pan). `window.__map` stays a devtools escape hatch only — product surfaces get the store, which has a real subscription and teardown. `lib/graticule.ts` holds the pure tick/scale maths; the graticule lines are drawn from the same bounds as the labels, because a fixed-pitch grid under real coordinate labels is a readout that lies.

**`useMapInstance` is a singleton, and there is now more than one map.** `RouteMap` on `/schedule` is a second MapLibre instance and deliberately never calls `setMap`/`setView` — if it did, the console's ticks, cursor readout and scale rule would start describing a 200px side panel instead of the map they label. Any future embedded map must stay silent the same way; only the full-bleed console publishes.

**Navigation is a single pill; there is no rail.** `PageHeader` in `components/ui/Panel.tsx` *is* the console bar — its top row renders `BrandMark` / `NavPill` / `StatusChips` at the same screen positions the map console floats them at, so the nav does not move as you navigate. Editing `PageHeader` therefore changes navigation on every non-map route at once. Overview does not use `PageHeader`; it positions the same three components itself.

**The shell owns viewport height.** `App.tsx` is the only place `h-screen` appears; pages use `h-full` and let the flex chain size them. Pages used to declare their own `h-screen`, which added the `OfflineBanner`'s height on top of a full viewport and pushed the bottom of every screen out of view whenever offline mode kicked in.

**Controls with no backend are inert and say so, and use `aria-disabled` rather than `disabled`.** The AOI tools and the model-vintage scrubber have no endpoint behind them (nothing in `src/backend/api/` accepts an area; no vintage field exists). They render to full visual spec but do nothing, with a `title` explaining why. `disabled` would remove them from the tab order, so a keyboard user would reach neither the control nor the explanation. Do not wire either to a fabricated response — the same rule as the offline banner: never fake a capability the system lacks.

**The Earth Engine flood layers are optional at every level, and the map did not change to get them.** `flood/` (backend) mints XYZ tile templates from `ee.Image.getMapId()`; `components/map/eeLayer.ts` + `EeLayers.tsx` mount them as ordinary `type: 'raster'` sources, the same shape as the CARTO basemap and the Tilezen DEM. No projection, camera or graticule change was needed, and none should be. Three rules hold this together. `earthengine-api`/`hydrafloods` stay in `requirements-flood.txt`, so the app boots and serves every other route without them — `flood/ee_session.py` is the only place either is imported, and it raises `FloodUnavailable` carrying the setup steps rather than a traceback. **A layer that cannot be drawn must say so, never render empty**: map ids expire in about an hour (hence the refetch), and Earth Engine tile URLs are not necessarily fetchable without credentials, so the backend fetches one tile itself and reports `tile_access` — `requires_auth` means the frontend deliberately does *not* add the layer, because a 403 raster paints nothing and logs nothing. And **the date is not the imagery date**: Sentinel-1 revisits about every six days, so every response carries the `window` and `scenes` actually used, and a date with no coverage is an error rather than a silently widened search. Config: `GEE_PROJECT` plus either `GEE_SERVICE_ACCOUNT_EMAIL` + `GEE_PRIVATE_KEY_FILE` (headless) or `earthengine authenticate` (laptop only). `fixtures/floodLayers.ts` mirrors the backend `CATALOGUE` and must change with it; its `earth_engine: null` means "we could not ask" and is rendered differently from a real `configured: false`.

**`flood_extent` subtracts three things, and two of them are corrections, not taste.** Raw `edge_otsu` water minus JRC permanent water reported **1206 km²** flooded over the Klang Valley on 2021-12-20 — of which **1091 km² was the Strait of Malacca**, whose tidal edge simply disagrees with JRC's static 30 m mask. So the layer is masked to land via SRTM's own coverage (`_land_mask`) — physical, not political, because floods do not stop at borders and a country polygon draws one across the map. Boundary misregistration between a static mask and a radar scene also traced a false outline along every coastline and riverbank; dilating the permanent-water mask by `PERMANENT_WATER_DILATION_PX` absorbs it (a further 18 km²). What was *not* done: dropping `PERMANENT_WATER_OCCURRENCE` from 80 to 50 would cut the result to 65 km² and look tidier, but it reclassifies seasonal floodplain as normally wet — the exact ground that floods. A quieter map bought that way is a worse map.

**The tile-access probe is easy to make lie.** It answers "can the browser fetch this", and two local faults made it answer "unknown" for reasons that had nothing to do with access: python.org macOS builds ship without a usable CA bundle (`CERTIFICATE_VERIFY_FAILED`), and the original z7 probe tile made Earth Engine run the whole algorithm across peninsular Malaysia and time out. It now uses a certifi-backed SSL context and a z11 tile over the AOI — 1.7 s instead of >30 s, and what a browser actually requests. Verified against a live project: Earth Engine tiles come back **200 image/png with no credentials**, so `tile_access` is `public` and the frontend draws them directly; no tile proxy is needed.

**DSWFP is a batch pipeline, not a request-time layer.** HYDRAFloods' Daily Surface Water Fusion Process (`data/prepare_dswfp.py`) is three chained `ee.batch.Export` tasks — samples → harmonics → one image per day — each writing an Earth Engine asset the next consumes. They return `None`, take 30 minutes to *days*, and nothing is displayable until they finish, so this is a producer like `prepare_flood_surface.py`, never a route. `build_daily_water` in `flood/layers.py` only *reads* the finished asset: HYDRAFloods builds the daily image inline inside `export_daily_surface_water` and exposes no public function returning it, so there is nothing to evaluate lazily and a date that was never exported simply has no image. Three traps, all verified the hard way: the published Getting Started page is **stale against the installed code** (`harmonic_coefs` is really `harmonic_image`, `output_confidence` is really `include_confidence`, and `output_asset_path` is a required positional in stages 1–2, so the page's `None` raises `ValueError`); `hf.country_bbox("Malaysia")` returns the LSIB *bounds*, which span the peninsula **and** Borneo — 144× the Klang Valley box, mostly sea, on a workflow that already takes days; and the asset name (`daily_water_YYYYMMDD`) is the only join between producer and layer, so `daily_asset_name()` and `dswfp_asset_name()` are pinned together by a test. A layer may declare `requires_env`, checked *before* `ee.Initialize()` for the same reason the date is: a configuration gap must not report itself as an authentication failure.

**There are two flood layers, and they answer different questions.** `floodLayer.ts` paints *attribution share* — how much of the model's risk it assigns to flood, averaged per 2 km hex. `inundationLayer.ts` paints *ground*: a HAND threshold surface showing which land sits at or below a chosen water level. Both use the same blue register for the reason `floodLayer.ts` sets out (neither is chrome nor a severity band), and both live behind controls in `OpacityModule` rather than in new floating panels, because the console is at its eight-surface blur ceiling. The inundation PNGs are **committed assets** under `src/frontend/public/flood/`, generated by `src/backend/data/prepare_flood_surface.py` — which makes it the one map layer that still draws with the network down, the basemap included. The bbox and the stage ladder are declared once per language (`AOI_BBOX`/`STAGES_M` in the producer, `INUNDATION_BBOX`/`FLOOD_STAGES_M` in `lib/inundation.ts`) and **must be changed together**: the asset filename is the only join between them, and a MapLibre `image` source pointed at a 404 renders nothing and reports nothing. Two things about the export are load-bearing and easy to get wrong — `imageSR=3857` plus a Mercator-matched aspect ratio (a degree ratio is off by only ~1.5px here, so it survives a glance while putting the water a few hundred metres off the ground it describes), and the rendering rule's `NoDataRanges`, which is what produces the alpha; remapping dry ground to a second output value returns an opaque white sheet over the whole AOI. `hydrafloods` + `earthengine-api` are producer-only (`requirements-flood.txt`) and **must never reach `requirements.txt`** — they need an authenticated Earth Engine session, which has no business on a demo path.

**`maplibre-gl` must stay out of Vite's dep pre-bundler** (`optimizeDeps: { exclude: [...] }` in `vite.config.ts`). MapLibre resolves its Web Worker via `new Worker(new URL(...))`; the pre-bundler rewrites that specifier into `.vite/deps/` without emitting the chunk, so the worker 404s. The failure mode is silent and very misleading: all GeoJSON parsing and tiling happens in that worker, so every circle/symbol layer renders empty while raster basemap tiles keep working (they decode on the main thread), and `map.on('error')` never fires. Symptom is "the map loads fine but has no towers on it". Dev-only — production builds are unaffected, so `npm run build` passing proves nothing here. Diagnose with `window.__map` (exposed by `MapView`): `isStyleLoaded()` stuck `false` plus `querySourceFeatures('towers').length === 0` is this bug, not a paint or filter problem.

## Known defects (verified, not yet fixed)

Recorded so they are not rediscovered from scratch, and so a symptom is not misattributed to code that is working correctly.

- **Fixture place names contradict fixture coordinates.** `fixtures/schedule.ts` `PLACE_NAMES` labels the scheduled towers with Kelantan towns (`MY_1042` = "Gua Musang"), while `makeScoredTower` in `fixtures/towers.ts` places every scored tower inside `SUNWAY_BOUNDS` in Selangor. Anything that plots a tower next to its name shows the contradiction — this is why `RouteMap` labels stops by `tower_id` rather than calling `placeName()`.
- **`ScheduleEntry.order` is almost always 1 in the offline fixture** (13 of 14 entries), so any route or sequence UI must look deliberate with a single stop rather than assuming multi-stop routes. Multi-stop routes appear only from the live optimizer.

## Project-specific rules that affect code changes

- **Never fabricate a failure label or expose failure-probability semantics.** This system schedules maintenance *need* and *urgency*, not predicted failure events (`docs/Backend_Handoff.md` §0, `docs/Concept_Overview.md` §5). Endpoint names, docstrings, and UI copy must stay consistent with this.
- **The optimizer decides; the LLM never does.** Any change to `agent/` must preserve: the model calls tools and reports tool output verbatim, and `optimize_schedule` output is never re-described in the model's own words.
- **`/schedule/preview` must never mutate stored state** — only `/schedule/pin` commits. This separation is load-bearing for the override UX.
- **Config over code** for scheduler behavior: crew roster, action mapping, and policy thresholds live in `config/*.{json,yaml}`, not literals in `scheduler/*.py`.
- **Unscheduled/displaced work is always returned explicitly**, never silently dropped (applies to `optimize.py` and emergency insertion in `override.py`).
- **Band colour has exactly one source: `src/frontend/src/lib/colors.ts`.** The map layer, the console's `BandModule`, `SelectionHud`, `TowerDrawer` and the schedule grids all import from it. `towerLayer.ts` previously carried its own hardcoded triad and drifted, so the map rendered towers in different colours than the legend that explained them.
- **The map's two tower layers move together.** `towers-layer` (coloured circle halo) carries the band/risk signal; `towers-icon-layer` (the tower PNG) is decoration on top of it and shares the same source. Any filter applied to one must be applied to both, or band-filtering leaves icons floating with no halo underneath. The icon PNG is raster, not SDF, so `icon-color` cannot tint it — band colour lives on the circle and must stay visible under the icon (`docs/Tower_Icon_Layer_Plan.md`). Decoration must never outrank data: with `icon-allow-overlap`/`icon-ignore-placement` both `true`, MapLibre skipped collision culling entirely and ~130 icons stacked into confetti that buried the band colours at AOI zoom. Culling only thins decoration — the halo is a circle layer, which never collides, so every tower keeps its reading.
- **The map's zoom bands hand off to each other, and each gate has exactly one definition.** Hillshade relief fades *out* across z10→z12.5; tower icons fade *in* across z12.5→z13.5. Relief is informative where the Titiwangsa range is and terrain actually varies; icons are legible only once towers are far enough apart. `TOWER_ICON_ZOOM_GATE` is exported from `towerLayer.ts` because `MapView` re-applies `icon-opacity` (multiplied by the score-opacity slider) and previously inlined a second hardcoded copy of the curve — editing the gate in one place looked correct until someone touched the slider, which then reverted it.
- **3D is a mode, and the readouts were fixed before it was allowed on.** `useMap3D` tilts the camera, calls `setTerrain` on the DEM `terrainLayer.ts` already loads, and raises `flood-volume-extrusion`. Three things had to become true first. The graticule is now **projected polylines** (`graticuleGeometry`), not CSS fractions: a fraction assumes longitude maps linearly to screen x, which tilt destroys — and the same rework fixed a standing bug where lines sat at true fractions while labels were spread with `justify-between`, so the two only agreed by luck. The scale rule stays the **closed form at the map centre** and is labelled "at centre" when pitched; measuring it with `unproject()` looks more rigorous and is wrong, because with terrain on it returns where the ray hits the MESH, so at high exaggeration two pixels either side of centre strike nearly the same point on a steep face — a z15 view measured 0.2 m/px against a true 4. And **terrain and water share one exaggeration factor**: stretching them differently would not exaggerate the scene, it would falsify the depth of water relative to the ground it covers. The factor is never silent — the HUD prints it, because 5 m of water across a 14 km AOI is 0.035% of the frame and any readable 3D flood is an exaggerated one. It defaults to ×10 rather than ×20 after looking at both: the tower AOI carries 82 m of real relief (SRTM −22 m to 60 m), and ×20 renders a coastal plain as an alpine range, which is a stronger falsehood than a flat map. Known artefact: the DEM holds small negative values over water (Sunway's flooded tin-mining ponds), which exaggeration turns into pits.

**Depth is carried in height AND colour, and the ramp stays cool.** The obvious reference for an intensity ramp is weather radar's green-yellow-red, and it is wrong here: warm hues are the severity triad, so a red pool would read as "this area is in the maintain band" — a verdict about a tower, which a depth in metres is not. `DEPTH_RAMP` gets its discrimination from lightness instead, spanning 40× shallow-to-deep across five stops reusing hues already in the flood register (the first four-stop attempt spanned 12× and was unreadable at 62% opacity). Both paint properties bake the stage in as a literal, so **both must be re-set when the stage changes** — updating only `fill-extrusion-height` leaves `fill-extrusion-color` computing against whatever stage the layer was created with, which ships as water that still looks blue while its colour means nothing. That shipped once and is why the depth legend exists: a ramp with no key is decoration.

**The 3D water is vector, and its geometry is derived from the 2D masks.** MapLibre extrudes geometry, never rasters — a raster draped on terrain follows the ground and shows no volume at all, which is the one thing 3D is there for. `data/prepare_flood_volume.py` reads the committed stage PNGs, and because they are strictly nested (asserted, not assumed) the stack already encodes a banded HAND field: a cell's band is the lowest stage at which it turns wet. So one 419 KB GeoJSON carries every stage — depth at stage h is `h - hand`, computed client-side — and the producer needs no network and no Earth Engine. The volume is drawn only when 3D is on: seen from directly above an extrusion is edge-on and merely duplicates the raster beneath it.

**Relief is `hillshade` when 3D is off, and then the camera stays top-down.** `terrainLayer.ts` adds a keyless AWS/Tilezen terrarium DEM below every tower layer. Real 3D terrain only reads under a pitched camera, and pitch would invalidate both the graticule's edge ticks and the scale bar's `metresPerPixel` — everything `lib/graticule.ts` derives assumes an unpitched view. Do not add pitch without reworking those readouts first. The hillshade's default `accent-color` is a blue cast and is neutralised, because the cool accent already means "interface chrome" on this screen. Under the light theme the relief inverts: on Dark Matter the shading was carried by a lifted highlight against a near-black shadow, whereas on Positron the tiles *are* the highlight, so the shadow does the work and the highlight goes white.
