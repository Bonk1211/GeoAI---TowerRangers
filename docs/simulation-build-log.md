# Disaster Simulation — build log

Append-only. Never rewrite an earlier entry.

## 2026-09-15T00:00:00Z — Pre-P0 ground check

Did: read `CLAUDE.md`, `docs/Disaster_Simulation_Spec.md`,
`docs/Disaster_Response_Actions.md` in full. Ran the gate on a clean tree.
Confirmed Sabah tower/crew data exists.

Findings:

- **Backend gate was not clean at start.** `src/backend/.venv` was missing
  `python-dotenv` even though it is pinned in `requirements.txt` — venv had
  drifted from the requirements files. Installed it
  (`.venv/Scripts/python.exe -m pip install python-dotenv`); this unblocked
  test collection (`api/main.py` imports `dotenv` at module load). Not a code
  change, an environment repair.
- **3 pre-existing failures, unrelated to this feature, left red and
  recorded rather than chased:**
  - `thermal/test_thermal_layers.py::test_every_fire_route_is_registered_on_the_app`
  - `tiles/test_preload.py::test_startup_never_fetches_and_manual_reload_covers_all_variants`
  - `tiles/test_supabase_store.py::test_full_zoom_pyramid_is_stored_in_supabase_before_it_becomes_ready`
  417 passed otherwise. The failures look network/quota-shaped (Earth Engine
  noncommercial quota warning appears earlier in the same run; Supabase store
  test implies a live backend). None of the three touch `scheduler/`,
  `adapter/ml_source.py`, or `/schedule/*` — the surface this feature calls.
  Every later gate run in this build compares against this baseline: **3
  pre-existing failures is the green bar for this work**, not 0.
- Frontend gate (`npm run build`, `npm run lint`) was clean on the
  untouched tree. `npm run build` reports the chunk-size warning that already
  exists (2.1 MB main bundle) — pre-existing, not caused by this feature yet.
- **Sabah data confirmed adequate.** Live `/towers` (`USE_FIXTURE` unset,
  real national dataset): 1,164 towers total, **62 in `territory === "Sabah"`**.
  `config/crews.json` rosters **2 Sabah crews**: `SBH-C1` (civil) and `SBH-P1`
  (power), both depot Kota Kinabalu (116.073, 5.98). Two crews is thin for a
  disaster-response demo showing multiple simultaneous dispatches, but not
  empty — the scenario is viable, and `/schedule/optimize` is called
  nationally per spec so the Sabah crew pool is what actually executes the
  emergency beat regardless of how many national orders exist elsewhere.
  Flagged as a real constraint on how many concurrent crew routes P5's
  animation can plausibly show (≤2 real Sabah crew-days at once from the
  live solver) — the rest of Phase 3's actions (antenna retune, MOCN, COW)
  are illustrative/mechanism beats anyway per spec, so this does not block
  the build, but the closing summary (P8) must not imply more Sabah crew
  capacity exists than 2.

Next: P0 skeleton.

## 2026-09-15T00:00:00Z — Worktree note (this session)

Did: picked up the run in a freshly created git worktree
(`.claude/worktrees/agent-ac8ee5a92e7e2e852`) that had never had `npm install`
run and had no `src/backend/.venv` at all — both the ground-check entry above
and this worktree's actual state disagree on environment setup, because the
ground check ran in a different checkout. Ran `npm install` in
`src/frontend` (128 packages) and built a fresh venv
(`py -m venv .venv` + installed all four requirements files + `pytest`).
Re-ran the full gate on the untouched worktree to reconfirm the baseline
before writing any code: **417 passed / 3 pre-existing failures** (the same
three named above), frontend `build`+`lint` clean. Baseline reconfirmed
identical to the prior session's; proceeding on the same green bar.

Next: P0 skeleton.

## 2026-09-15T00:00:00Z — P0 + P1 (skeleton, clock, console)

Did:
- **P0**: `/simulation` route (`pages/Simulation.tsx`), nav pill placed after
  Schedule (`components/shell/NavPill.tsx`, new `SimulationIcon` in
  `components/shell/icons.tsx`), `PageHeader` with title/subtitle, three
  panel shells (`SimulationMap`, `SimulationConsole`, `PhaseStrip`), and
  `state/useSimulation.ts` (initially `status` only). Page is
  `flex h-full flex-col`, never `h-screen`.
- **P1**: `lib/simulationClock.ts` (pure play/pause/resume/seek/tick/setSpeed
  state machine — no timers, no DOM) and `lib/simulationTimeline.ts` (the
  full 16-beat table from spec §6, plus `beatsUpTo`/`phaseAt`/`beatById`
  selectors). `state/useSimulation.ts` rewritten to wire both together,
  running its own module-level `requestAnimationFrame` loop rather than a
  React effect, so the loop is self-terminating on `status` regardless of
  which component is mounted. `SimulationConsole` renders `firedBeatIds` as a
  transcript with a per-line evidence badge (REAL/MECHANISM/ILLUSTRATIVE —
  spec §8.1). `PhaseStrip` reads the real `phase`. New `TransportBar`
  (play/pause/reset, 1x/2x/4x, scrubber, elapsed clock, progress%).
  27 new `node:test` cases across `simulationClock.test.mjs` (13) and
  `simulationTimeline.test.mjs` (14), covering the spec §14 pinned behaviors:
  speed-change-mid-run does not rescale already-elapsed time, phase boundary
  inclusive/exclusive edges, `beatsUpTo` monotonicity and idempotent
  re-derivation on seek (see decision below on how "seek clears beats fired
  after target" is satisfied).
- Added `SimulationBanner` (spec §8.2's standing honesty banner) ahead of
  schedule — see decision below.

Decisions made without the operator:
- **`firedBeatIds` is recomputed in full from `elapsedMs` via `beatsUpTo()`
  on every clock update, rather than maintained as an incrementally-appended
  list.** Spec §14 says "seek backwards clears beats fired after the
  target", phrased as if there's a mutable list to prune. A pure derivation
  from `elapsedMs` satisfies that intent more strongly than a mutable list
  would (it cannot desync from the clock by construction) and is simpler.
  simulation-integrity-tester confirmed this reading and verified it
  behaviorally (seek to 96000ms then back to 5000ms yields exactly the two
  beats whose `atMs <= 5000`). No spec conflict, just an implementation
  choice recorded for anyone expecting a literal mutable list.
- **Shipped `SimulationBanner` (spec §8.2) during P1, not deferred to P6.**
  simulation-ux-reviewer flagged its total absence as a BLOCKER even at this
  intermediate stage: a page with a working Start button and zero on-screen
  disclaimer overstates the system the moment someone presses it, which is
  exactly the failure mode CLAUDE.md's §0.6 discipline exists to prevent —
  it doesn't carve out an exception for "the feature isn't finished yet."
  The rest of the honesty surface (full `SimulationLegend`, map-overlay
  labelling) still lands in P6 alongside the overlays it names.
- **RAF loop pause behavior**: `pauseSim()` does not call
  `cancelAnimationFrame` directly; the already-queued frame runs once,
  `_tick` no-ops (clock.tick returns early when status != running), and the
  loop's own `else stopLoop()` branch retires it. simulation-integrity-tester
  verified this costs at most one wasted frame and does not leak — accepted
  as-is rather than adding an explicit cancel, to keep the loop's only exit
  path in one place (the `loop` function itself).

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (2 pre-existing
  `useLiveTowers.ts` warnings, untouched file). All 12 `src/lib/*.test.mjs`
  files pass via `node --experimental-strip-types --test` (107 tests total,
  0 failures — 27 new).
- Backend: `pytest -q -p no:cacheprovider` — 417 passed, 3 pre-existing
  failures (same three named in the ground-check entry). No backend files
  touched this cycle, so this run only reconfirms the baseline is unchanged.

Reviewers:
- `simulation-integrity-tester` — no blockers. Verified (by execution with a
  fake rAF harness) no loop leak across start/reset/remount, speed-change
  does not rescale accumulated time, phase boundaries are correctly
  half-open, and no simulated state reaches a `Tower` record or the backend
  at this stage (nothing calls the network yet). Two non-blocker nits noted
  and accepted as-is: `seekSim` forcing `paused` mid-run stops playback
  (deliberate), and the range input fighting React slightly while running
  (harmless, since seeking pauses anyway).
- `simulation-ux-reviewer` — one BLOCKER (missing standing banner, fixed by
  adding `SimulationBanner`, see decision above). Two non-blockers fixed
  immediately (cheap): console autoscroll now only snaps to bottom when
  already near it, rather than fighting a reader who scrolled up to re-read
  a line; `accent-[--color-accent]` arbitrary-value class replaced with the
  proper `accent-accent` utility. One non-blocker deferred: no `hue` used on
  console evidence badges (word-only) is acceptable per spec §8.1's own
  wording ("a WORD, not only a hue") — not required to add a hue, just not
  allowed to omit the word. Deferred without a fix: focus-visible ring
  verification and narrow-width wrapping of `TransportBar` both explicitly
  flagged "NEEDS BROWSER CHECK" — no browser available in this run; carried
  forward to P7's reduced-motion/narrow-width pass rather than guessed at.

Blocked: nothing external.

Next: P2 (map, static) — `SimulationMap` real MapLibre instance, Sabah tower
fetch/filter, `fitBounds` on scenario select (camera move in the start
handler, never an effect on tower data, per spec §5).

## 2026-09-15T00:00:00Z — P2 (map, static)

Did: `SimulationMap.tsx` rewritten from the P0 placeholder into a real,
fourth MapLibre instance. Renders live Sabah towers (`territory === 'Sabah'`,
filtered from `useLiveTowers`) as a `bandColor()`-driven circle layer, and
fits the camera to Sabah's tower bounds when `status` leaves `idle`, keyed on
`[status, ready]` with a `framedForRun` ref latch — never on the towers array
itself, so a mid-run tower-data refresh cannot re-fly the camera.

Decisions made without the operator: none new this cycle — followed spec §5
directly (silent instance, camera move on status transition not tower data).

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings, untouched file). All 12 lib test files pass (unaffected by this
  change, re-run per gate discipline).
- Backend: not touched this cycle; not re-run.

Reviewers:
- `simulation-ux-reviewer` — one BLOCKER: the tower circle layer was added
  with `groundAnchor(map)` passed as `addLayer`'s `beforeId` argument, which
  inserts the new layer UNDERNEATH the named one — the opposite of spec §5's
  "all inserted below `groundAnchor` except tower marks" and of CLAUDE.md's
  "towers are not ground, stay on top." Fixed by dropping the anchor argument
  entirely (towers now render with no `before`, same as `MapView.tsx`'s
  precedent). One non-blocker fixed: padding was a flat unclamped 40px on
  all sides, risking a negative viewport on the map's shortest allowed height
  (~280px); replaced with a `framePadding()` helper mirroring
  `AreaModule.tsx`'s canvas-share clamp. `bandColor()` usage on `circle-color`
  confirmed correct (fill, not a `color:` property).
- `simulation-integrity-tester` — no blockers. Confirmed zero
  `useMapInstance` coupling by grep across the whole frontend; confirmed live
  Sabah data is real and present (62 towers, bands `ok:49/watch:8/maintain:5`,
  bbox spans mainland Sabah) so the offline-empty-map worry doesn't apply on
  this checkout; confirmed unmount cleanup (`map.remove()`) is sufficient
  against a `load`-race. One non-blocker fixed: `framedForRun` only reset on
  `status === 'idle'`, so pressing Play again from `done` (a real replay per
  `simulationClock.play()`, which zeroes `elapsedMs` from `done`) skipped
  re-framing since it never passes through `idle`. Now resets on `idle` OR
  `done`.

Blocked: nothing external.

Next: P3 (impact overlays) — flood extent, outage marks (not plain red —
shape + literal `OFFLINE` label per spec §10), coverage gap footprint. First
beat that actually changes the map.

## 2026-09-15T00:00:00Z — P3 (impact overlays)

Did: new `fixtures/scenarios/sabahFlood.ts` (Scenario definition per spec
§12 — coarse hand-authored flood polygons over Penampang/Putatan/KK west
coast; `downTowerSelector` is a genuine function over the live tower array,
never a hardcoded id list, filtering by Sabah territory + scenario bbox +
maintain/watch band, sorted by `attribution.flood` descending, top 4).
`state/useSimulation.ts` gained `downTowerIds: Set<string>` — the §0.6
firewall field — populated once inside `start(towers)` by calling the
selector over the live population passed in from `TransportBar` (which now
fetches `useLiveTowers` itself). `SimulationMap.tsx` extended with three new
map layers: flood-extent fill and coverage-gap fill (both inserted below
`groundAnchor`, as ground overlays), and a down-tower outage mark (ring +
literal `OFFLINE` symbol layer, above the anchor like the tower layer — not
plain red, since red is the `maintain` band). New `lib/coverageGeometry.ts`
(pure bearing/circle/sector-polygon trig) with 11 passing tests pinning
cardinal bearings, the antimeridian, and identical-point NaN-safety per spec
§14 — the circle half is used now; the sector half (for retuned antenna
cones) lands with P5.

Decisions made without the operator:
- **Coverage-gap radius fixed at 3.5 km**, an illustrative constant with no
  claim to RF accuracy (spec §15 explicitly excludes propagation modelling)
  — chosen only to read as a visible "gap" at Sabah-console zoom, not derived
  from anything.
- **Flood extent has exactly two frames** (onset, grown) rather than a
  smoother multi-step ladder, matching spec §9's "swap between a small
  number of pre-computed extent polygons, do not try to morph geometry per
  frame."

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 13 lib test files pass (131 tests total — 11 new from
  `coverageGeometry.test.mjs`, 0 failures).
- Backend: not touched this cycle; not re-run.

Reviewers:
- `simulation-ux-reviewer` — no BLOCKER, but flagged and I fixed two
  design-system violations before commit: (1) the outage ring/label used
  `UNSCORED_COLOR`, a fill-only constant measured at 3.32:1, for text and a
  thin stroke, which needs the 4.5:1 ink bar — added `UNSCORED_INK`
  (`#5a6577`, verified 5.39:1 on page ground / 5.89:1 on white) as its
  proper ink twin, same two-ramp discipline `bandColor()`/`bandInk()`
  already establishes. (2) the flood fill hand-typed `'#2563eb'` instead of
  importing the identical existing `WATER_DEPTH_BANDS[1].color` — fixed to
  import it, since a hand-typed copy of an existing token is exactly how the
  band triad drifted once before (per CLAUDE.md's own account). Confirmed
  clean otherwise: outage mark reads as shape+word not a band colour, layer
  ordering matches spec's table, `downTowerSelector` has zero hardcoded
  `MY_` ids. Flagged (not a blocker, since already addressed): the standing
  honesty banner needs to be visible before any outage claim renders — it
  already is, shipped early during P1 for exactly this reason.
- `simulation-integrity-tester` — no BLOCKER. Verified by grep: `downTowerIds`
  has zero network/localStorage/persist touches anywhere in
  `components/simulation/` or `state/useSimulation.ts`; the full
  `TransportBar -> start(towers) -> downTowerSelector -> downTowerIds` flow
  traced end to end with the actual selector code (not asserted); confirmed
  the "OFFLINE" map label and the `tower-down` console beat both read as a
  stated premise, never a failure prediction. One real, cheap finding fixed:
  the flood-extent effect re-ran `setData` on every animation frame
  (`elapsedMs` changes ~60x/sec while running) even though `floodExtentAt`
  only ever returns one of two shared polygon singletons — added a
  referential-identity ref guard so `setData` now fires twice per run
  instead of continuously. Also added `text-allow-overlap`/
  `text-ignore-placement` to the OFFLINE label (my own addition, prompted by
  the reviewer noting MapLibre's default collision culling could silently
  drop one of two nearby down-tower labels — the literal word is the only
  thing distinguishing that mark from any other ring, so it must never be
  the one that loses).

Blocked: nothing external.

Next: P4 (backend beats) — real `/schedule/optimize` prefetched at Start,
`/schedule/emergency` anchored to the run's own `horizon[0]` (never the demo
clock), visible degradation on failure.

## 2026-09-15T00:00:00Z — P4 (backend beats)

Did: new `components/simulation/useSimulationBackendBeats.ts` hook, mounted
from `pages/Simulation.tsx`, firing the two real calls spec §7 requires.
`/schedule/optimize` fires the instant a run starts (`status` becomes
`'running'`), not when the clock reaches the `optimize` beat — prefetched so
the ~15s of pre-event narration hides the round trip. `/schedule/emergency`
(`commit: true`, targeting Sabah's power crew `SBH-P1`) fires once the
`generator-dispatch` beat has arrived in `firedBeatIds` AND the optimize run
is ready, passing only `run_id` and relying entirely on the backend's own
`_anchor(run)` (already fixed server-side per CLAUDE.md) to derive `today`
from that run's `horizon[0]`. New `client.emergencyDispatch()` — `POST
/schedule/emergency` had no frontend caller before this. New
`lib/simulationConsoleLine.ts` (7 passing tests) resolves each beat's
`<n>`/`<k>`/`<tower_id>`/`<crew_id>` placeholders against the real
`ScheduleRun` rather than inventing figures. `SimulationConsole` now shows
`(resolving…)` while a backend beat's call is in flight and a literal
`DEGRADED — OFFLINE` badge if it errored.

Decisions made without the operator:
- **`SBH-P1` hardcoded as the emergency dispatch target**, rather than
  searched for in the live crew roster. The scenario is scripted to always
  target Sabah's power crew for a power-outage generator dispatch; searching
  for "some Sabah power crew" would only add a second silent-failure mode if
  the roster composition ever changes.
- **The dispatch target tower is `[...downTowerIds][0]`** — an arbitrary
  but deterministic (insertion-order) element of the selector's output,
  since the console line names exactly one tower per beat and the selector
  itself has no explicit "primary" concept. Flagged by review as fragile if
  the selector's internal ordering ever changes; not fixed, since it is
  correct today and a larger fix (the scenario explicitly naming a primary
  target) is more design than this item's scope.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 14 lib test files pass (138 tests total — 7 new from
  `simulationConsoleLine.test.mjs`, 0 failures).
- Backend: re-ran the full suite to reconfirm the baseline is unaffected
  (no backend files touched) — 417 passed, same 3 pre-existing failures.

Reviewers: `simulation-integrity-tester`, dispatched twice because the first
pass's fix introduced a new bug that needed a second round.
- **Pass 1 — one BLOCKER, backend contract otherwise confirmed correct by
  exercising the actual FastAPI `TestClient`, not just reading the route.**
  The blocker: both fetch effects guarded their async work with a
  `cancelled` flag set by the effect's own cleanup function, but the
  optimize effect re-runs on every `status` change while `status` is
  `'running'` OR `'paused'` — so pausing mid-round-trip tore down the
  in-flight call and discarded its resolution, permanently stranding
  `optimizeStatus` at `'pending'` with no result and no error. That is a
  silent stall, not a visible degrade — exactly what spec §7 rule 2
  forbids, and worse than an honest failure because the emergency beat then
  never fires and never marks itself degraded either. Same bug on the
  emergency effect via `firedBeatIds` growing every beat. Confirmed correct
  separately: `EmergencyRequestBody` matches the backend's `EmergencyRequest`
  schema exactly; an empty-body `/schedule/optimize` call genuinely scores
  the whole national population (verified: 49 entries across 10
  territories, not Sabah-scoped); the backend's `_anchor(run)` is
  server-side and already resolves `today` from `run.horizon[0]`; `SBH-P1`
  exists in `config/crews.json` and nothing server-side blocks a
  cross-crew-type or non-maintain-band emergency dispatch (verified via
  probe: `override.py`'s "never blocked" contract holds).
- **Fix**: dropped both `cancelled` flags — the existing
  `optimizeFiredRef`/`emergencyFiredRef` guards already provide
  once-per-run semantics, so each request is simply allowed to resolve into
  the store whenever it resolves, regardless of intervening re-renders.
- **Pass 2 — the fix reopened a different BLOCKER: a Reset-mid-flight race.**
  Dropping the cancel flags meant Reset (which clears the `*Ref` guards)
  followed immediately by a second Start could let the FIRST run's late
  resolution overwrite the second run's `optimizeRun`, or — the worse
  case — let a stale `run_id` reach a real `/schedule/emergency` commit
  against a board the planner has already moved on from. **Fix**: added
  `runSeq: number` to the store, bumped atomically with `status` by both
  `start()` and `resetSim()`; each fetch effect now captures `runSeq` at
  fire time and checks it against the store's live value (via
  `useSimulation.getState()`, not the closed-over reactive value —
  deliberately, since the comparison needs the CURRENT value while the
  captured one must stay frozen) before either its success or its error
  branch writes. This survives a pause (`runSeq` unchanged, so the
  pass-1 fix stays intact) while correctly dropping a superseded run's
  result after Reset-and-restart.
- **Re-verification, pass 2**: walked all four scenarios explicitly —
  normal completion, pause-mid-optimize-then-resume, reset-mid-flight-then-
  restart (confirmed run A's late resolution cannot write into run B's
  state or commit against run B's board), and two rapid Start presses
  (structurally impossible since `TransportBar` only calls `start()` from
  `'idle'`/`'done'`). Also confirmed the `runSeq`/`status` atomicity the fix
  depends on is real: `start()` sets both in one `set()` call, so Zustand
  notifies subscribers once with both new values already in place — the
  optimize effect's capture of `runSeq` (absent from its `[status]` deps
  array on purpose) is therefore never stale. One non-blocker suggestion
  taken: added a comment at the effect documenting that this coupling is
  load-bearing, so a future edit bumping `runSeq` without also changing
  `status` doesn't silently reintroduce staleness.

Blocked: nothing external.

Next: P5 (response animation) — sector cones swinging, MOCN link line, COW
arrival, crew routes, each with a reduced-motion still state.

## 2026-09-15T00:00:00Z — P5 (response animation)

Did: extended `SimulationMap.tsx` with four response-phase visuals (spec §6
Phase 3, §9). Sector cones swing from up to 3 nearby towers toward the down
tower's gap (new `lib/responsePhaseGeometry.ts` — `selectRetuningNeighbors`,
`retuneBearingAt`, 9 passing tests). A MOCN dashed link line connects the
down tower to its nearest surviving neighbour. A COW (Cell on Wheels)
marker travels from the Sabah power crew's depot. The real emergency-
dispatch crew's route (from P4's `emergencyRun`) draws its own dashed
connector and travelling token. All four reuse
`DispatchRoutePreview.tsx`'s established `animate(0,1,{onUpdate})` lerp
pattern and every one has a `prefers-reduced-motion` still state via
`motion/react`'s `useReducedMotion()`.

Decisions made without the operator:
- **Reduced-motion still states are chosen per-element, not uniformly
  copied from `DispatchRoutePreview`'s midpoint convention.** A cone parks
  fully retuned (`t=1`) rather than mid-swing, because a bearing has no
  legible "half-swung" resting state the way a journey token's midpoint
  reads as "in transit". A COW parks arrived at the destination, because
  its console line is already past tense ("COW deployed to..."). Only the
  crew route keeps the literal midpoint, because that is the one case
  where the original convention's own reasoning (ambiguous direction from
  either endpoint) actually applies. `simulation-ux-reviewer` confirmed
  this reading rather than flagging the deviation as an error.
- **Sector-cone bearing interpolates from a fixed "nominal" due-north
  heading to the true bearing toward the down tower**, since this project
  holds no real sector azimuth data (spec §8's illustrative-geometry
  category) — due north was picked as an arbitrary but stable starting
  point, not a claim about any tower's actual default orientation.
- **Up to 3 neighbours retune per down tower**, capped so the response
  phase reads as "a few nearby cells helped" rather than a starburst from
  every tower on the map; within a 15 km illustrative search radius, same
  category as the coverage-gap radius (not an RF propagation figure).

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 15 lib test files pass (147 tests total — 9 new from
  `responsePhaseGeometry.test.mjs`, 0 failures).
- Backend: not touched this cycle; not re-run.

Reviewers:
- `simulation-ux-reviewer` — one BLOCKER: sector cones and the MOCN link
  used `ACCENT` (violet), reasoned in a comment as "chrome describing a
  remote network action" — directly contradicted by spec §10's own text:
  "Sector cones are neither severity nor chrome... a neutral overlay-token
  treatment... same precedent `lib/reserveHatch.ts` set." Fixed: both now
  share one `resolveOverlayColor()` call (the same helper `GAP_LAYER`
  already used, "defined once" per spec). Because the cone's fill sits
  inside the coverage-gap footprint it targets — genuine overlap, not a
  layout accident — an identical neutral fill at similar opacity would
  merge the two shapes, so the cone also gained a thin neutral outline
  layer to stay legible without reaching for a second hue. Confirmed
  correct otherwise: the per-element reduced-motion still-state choices
  (cone fully-retuned, COW arrived, crew-route midpoint) all hold up under
  the reviewer's own re-derivation of why `DispatchRoutePreview`'s midpoint
  convention exists (ambiguity between "left" and "arrived" — a property
  neither a bearing nor a past-tense-narrated deployment shares). Three
  concurrent animations (cone + COW + crew loop) exceeds
  `DispatchRoutePreview`'s own "1-2 per view" budget comment but was judged
  defensible for the one beat that dramatizes disaster response, not fixed.
- `simulation-integrity-tester` — one BLOCKER: the COW effect's dependency
  array includes `crews`, whose identity changes on the first successful
  live-data fetch and on every offline-recovery poll, either of which can
  land while the COW marker is mid-flight. The old cleanup stopped the
  travel animation but left the marker at its last interpolated position;
  the next run then hit the "already deployed" guard and returned without
  ever finishing the journey — a COW permanently stranded short of its
  destination with no visible sign anything was wrong. Fixed with a
  `cowArrivedRef`: a re-run that finds the marker already present now snaps
  it to the destination if the journey hadn't actually completed, rather
  than leaving it wherever the stopped animation happened to freeze it.
  Two non-blockers fixed: the MOCN link recomputed and called `setData` on
  every animation frame despite unchanging geometry inside its time window
  (now keyed on the window-boolean pattern the other effects use, matching
  the flood-extent effect's existing per-frame-churn guard); and the
  crew-route effect now reads its target tower through `towersRef.current`
  rather than the closed-over `sabahTowers` array, since a same-length live
  refetch with different tower content would otherwise leave it looking at
  stale coordinates. Confirmed correct: window-boolean dependency arrays
  correctly detect re-entry on a backwards seek; the crew-route effect
  resolves its target from `emergencyRun.entries` directly rather than
  assuming agreement with `downTowerIds`; `retuneBearingAt`'s shortest-
  angular-path wraparound has no sign error at any boundary; no Marker or
  `animate()` control leaks across a full idle→running→done→reset cycle.

Blocked: nothing external.

Next: P6 (honesty surface) — evidence badges (shipped in P1's console),
standing banner (shipped early in P1), `SimulationLegend` naming each
overlay and its evidence category — the one piece not yet built.

## 2026-09-15T00:00:00Z — P6 (honesty surface)

Did: new `SimulationLegend.tsx`, naming all 7 map overlays and their
evidence category, wired into `Simulation.tsx` below the console with a
capped/scrollable list (`max-h-[132px]`) so it cannot outgrow the console —
the narration — in the right column even at reduced viewport heights. This
completes the three-mechanism honesty surface spec §8 requires; the other
two (per-line console evidence badges, the standing banner) had already
shipped early, during P1, because a reviewer flagged the banner's total
absence as a blocker even at that intermediate stage.

A domain review (`mcmc-domain-reviewer`) of the finished beat table found a
real drift in what `mechanism` had come to mean: it was being used as a
default for "scripted but plausible" rather than its actual definition
— "this drawing/computation mechanism genuinely exists and runs in this
codebase today". Cross-checked every one of the 16 beats against
`docs/Disaster_Response_Actions.md`'s "What is real vs demo-only" table
and reclassified eight from `mechanism` to `illustrative`:

- `harden`, `generators` — site hardening and generator pre-positioning are
  both explicitly "Real practice, not yet built" in that table. `harden`'s
  crew_id/tower_id ARE genuine solver output (from the optimize run
  above), so only the ACTION NAME ("site hardening") is invented, not the
  assignment underneath it — the two are now split correctly by evidence
  rather than the beat inheriting the crew data's realness.
- `flood-onset`, `tower-down` — hand-authored/stated scenario premise, not
  the output of any flood-mapping or outage-detection mechanism in this
  codebase. `tower-down`'s own console text already says "scenario
  premise"; badging it `mechanism` directly contradicted its own line, and
  was the single reading closest to the system appearing to have produced
  the outage — the one thing §0.6 forbids implying.
- `restore`, `withdraw` — the inverse premises (an outage resolving, a COW
  withdrawing); `withdraw`'s line is dominated by COW/sector clauses with
  no built mechanism behind them.
- `cow`, `prime` — both explicitly "not yet built" / "out of scope for
  now" per the doc's table; no mechanism exists for either.

Also fixed "MCMC PRIME unit -> evacuation centre" to "MCMC PRIME unit ->
PPS evacuation centre", naming the real target (Pusat Pemindahan
Sementara) rather than a generic English gloss. `SimulationLegend`'s Flood
extent / Coverage gap / Tower outage / COW rows were reclassified to match
the corresponding beats, and its footer/hint copy widened to state both
reasons a mark can be illustrative (no data for the exact geometry, OR no
mechanism built at all) rather than only the first, which had been
silently only half-true for the newly-reclassified rows.

Decisions made without the operator:
- **`taskforce` kept as `mechanism` despite its console line mixing a
  mechanism-backed clause ("Reserve crew-days held", real —
  `scheduler/reserve.py`) with a non-mechanism one ("MCMC + telco + SESB
  joint monitoring").** `mcmc-domain-reviewer` flagged this as a
  non-blocker inconsistency with the rule just applied to `withdraw` (also
  a mixed line, reclassified to `illustrative`). Left as `mechanism`
  rather than reclassified, because the beat's own `effect: {kind:
  'reserve-activate'}` is real and dominant, unlike `withdraw` where the
  COW/sector clauses dominate a line with no real mechanism at all —
  judged as a defensible line-by-line call rather than something the same
  mechanical rule should force identically, and the reviewer's own verdict
  called it "defensible."
- **`Crew dispatch route` legend row kept as `real`, relabelled "(shown
  once dispatch commits)"** rather than reclassified — it only ever draws
  once `/schedule/emergency` has actually committed (P4), so `real`
  describes what's on screen whenever the mark is visible at all, not a
  standing claim independent of whether a dispatch happened.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 15 lib test files pass (147 tests, 0 failures — this
  item only reworded/reclassified existing beats, no new lib module).
- Backend: not touched this cycle; not re-run.

Reviewers (this was the last item run through the per-item review-gate
table before the operator changed process to a single final pass at the
end of the backlog — see the process note below):
- `mcmc-domain-reviewer` — found the `mechanism`-drift BLOCKER described
  above across three findings (cow, prime, and the legend's flood/gap/
  outage rows), re-dispatched after the fix to confirm all 16 beats'
  classifications against the source table one more time. Verdict:
  "credible-with-fixes", all changes correct, `taskforce` non-blocker
  noted and left as a judgment call (above).
- `simulation-integrity-tester` — confirmed `SimulationLegend` stays a
  pure static render (zero hooks, zero backend calls, zero store
  mutations) and that its 7 evidence classifications now agree with the
  corresponding beats in `lib/simulationTimeline.ts`; confirmed the swatch
  colours use inline `style` with imported constants (`UNSCORED_INK`,
  `WATER_DEPTH_BANDS[1].color`), not broken Tailwind arbitrary-value
  classes. No blockers.

**Process note:** starting with the next item (P7), per-item reviewer
dispatch is retired for the rest of this backlog on the operator's
instruction — the review-gate table in the original brief is skipped for
P7, P8 and the hardening pass. All three reviewers (`mcmc-domain-reviewer`,
`simulation-integrity-tester`, `simulation-ux-reviewer`) run together, in
parallel, exactly once, against the FINISHED tab after the full backlog is
built and both gates are green — not per item. This changes process only;
every commit through P6 above already carries its own per-item review and
those are not revisited.

Blocked: nothing external.

Next: P7 (reduced-motion pass + narrow-width check at 1280px and 1024px).

## 2026-09-15T00:00:00Z — P7 (reduced-motion + narrow-width)

Did: audited every animated element for `prefers-reduced-motion` coverage.
All three `motion/react` `animate()` calls (sector cone, COW, crew route)
already carried `useReducedMotion()` branches from P5's build — confirmed
by grep and reading each call site, nothing was missing. The camera
`fitBounds()` call needed no explicit branch: MapLibre honours the
preference automatically (`respectPrefersReducedMotion`), the same
reasoning `hud/AreaModule.tsx`'s own `fitBounds` comment states — added a
one-line comment documenting that rather than a redundant guard, so a
future reader isn't left wondering why this one animation has no still-
state branch. No other CSS animation exists in the new components beyond
a harmless `transition-colors` on `TransportBar`'s speed buttons (colour,
not motion); the console's autoscroll is already an instant `scrollTop`
jump since this codebase has no `scroll-behavior: smooth` anywhere.

Narrow-width layout (1280px, 1024px per spec §2/§13) reviewed
structurally, not in a browser:
- `TransportBar` is `flex flex-wrap`, so at a width where its six controls
  (Play, Reset, clock, 3 speed buttons, range, %) don't fit one row, it
  wraps to a second row rather than clipping or forcing horizontal scroll
  — a defensive degrade, not a guarantee of a specific look.
- Tailwind's default `lg` breakpoint is exactly 1024px, so `1024px` is
  simultaneously the narrowest width the spec asks to check AND the exact
  point `Simulation.tsx`'s `lg:flex-row` switches the map/console from
  stacked to side-by-side — meaning 1024px already exercises the
  side-by-side layout at its absolute tightest fit (map `flex-1` against
  a `420px` right column, leaving ~604px for the map before padding/gaps).
  Below 1024px the layout stacks instead, which is the intentionally
  simpler case.
- The six-item nav pill's crowding at 1280px was already checked by
  `simulation-ux-reviewer` during P0 ("no obvious overflow beside
  BrandMark/StatusChips") — that finding stands; not re-verified here
  since the nav row is shared chrome unchanged since P0.

Decisions made without the operator: none — this item was auditing
existing coverage rather than building new behaviour, and everything
audited was already correctly covered by earlier items' own review
findings.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 15 lib test files pass (147 tests, 0 failures — no lib
  changes this item).
- Backend: not touched this cycle; not re-run.

Reviewers: none dispatched — per the operator's process change (noted in
the P6 entry above), per-item reviewer dispatch is retired for the rest of
this backlog. All three reviewers run once, together, against the finished
tab after P8 and hardening.

Blocked: nothing external. **Explicitly NOT verified**: nothing in this
item was confirmed by opening a browser. The narrow-width behaviour
described above is a structural argument from the CSS (`flex-wrap`,
breakpoint arithmetic), not an observation — flagged honestly rather than
claimed as tested, per CLAUDE.md's explicit rule that a passing build does
not verify visual, animation, or map-rendering behaviour.

Next: P8 (closing summary) — what the risk index flagged in advance vs
what the scenario hit, time-to-response, baseline comparison via
`/schedule/baseline` (omit that one line on failure per the spec's
decisions-already-made table).

## 2026-09-15T00:00:00Z — P8 (closing summary)

Did: new `SimulationSummary.tsx`, rendering only once the run reaches
`done` (spec §6: "not a victory screen, a comparison"). New pure
`lib/simulationSummary.ts` (`computeFlaggedVsHit`, `parseClockLabelHours`,
`timeToResponseHours`, 9 passing tests) computes what the national
`optimize` run's Sabah-territory work orders flagged in advance against
what the scenario's `downTowerIds` selector actually hit, and states the
divergence explicitly (spec: "if the flagged set and the hit set diverge,
show that too — a demo that can only succeed is not evidence of anything")
rather than only reporting overlap when it happens to be total. Also
fetches `/schedule/baseline` once `done` and states the baseline-comparison
line using `mean_days_to_service_top_decile` (the sharper "reached these
towers j days later" framing spec §16 suggests) when both policies have
one, falling back to `risk_weighted_wait_reduction_pct`'s ratio otherwise.
Per the spec's decisions-already-made table, a failed baseline call
degrades only that one line — the summary's other numbers, which came from
the run that already succeeded, are unaffected, and the global offline
flag is deliberately NOT set for this failure (unlike P4's backend beats,
where a failure means the whole simulated dispatch might be fake — here it
only means one comparison sentence is unavailable).

Decisions made without the operator:
- **`timeToResponseHours` reads the beat table's own authored `clockLabel`
  strings ("T-0", "T+4h") rather than deriving an hours-per-millisecond
  conversion rate from `atMs`.** The beat table's `atMs` spacing is
  authored for readability (spec §6), not at a constant rate — the gap
  between T-72h and T-60h is 4000ms for 12 scenario-hours, while T+3h to
  T+4h is 7000ms for 1 scenario-hour. No single conversion rate exists to
  derive honestly, so parsing the authored labels directly is both simpler
  and the only approach that doesn't invent a number. First draft did
  attempt the ms-based conversion and was replaced before committing, once
  writing out the actual `atMs` deltas made the inconsistency obvious.
- **Baseline comparison prefers the day-count framing over the percentage
  framing when both are available**, since `mean_days_to_service_top_decile`
  is the literal number the spec's own suggested sentence names ("j days
  later"), and a day count is easier to reason about at a glance than a
  reduction percentage whose sign convention (`risk_weighted_wait_reduction_pct`
  — greedy vs nearest-first, verified by reading `scheduler/baseline.py`
  directly rather than assuming) takes a sentence to state correctly.
- **A failed baseline call does not set the global offline flag.** Distinct
  from every P4 backend-beat failure, where the flag is load-bearing
  because a failure there means the SIMULATED DISPATCH might not be real.
  Here the run already completed successfully; the baseline is an optional
  comparison layered on top, and flagging the whole session offline over
  one missing comparison sentence would overstate the failure's scope.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 16 lib test files pass (156 tests total — 9 new from
  `simulationSummary.test.mjs`, 0 failures).
- Backend: re-ran the full suite to reconfirm the baseline is unaffected
  (no backend files touched) — 417 passed, same 3 pre-existing failures.

Reviewers: none dispatched — per the operator's process change (see the P6
entry), per-item reviewer dispatch is retired for the remainder of this
backlog. All three reviewers run once, together, against the finished tab
after the hardening pass below.

Blocked: nothing external.

Next: the backlog (P0-P8) is now built. Moving to hardening: more `lib/`
test coverage, error paths, adding this feature's docs to CLAUDE.md's
documentation-map table, accessibility, bundle size, a pass over any TODOs
left behind — per the spec's "if the backlog empties" instruction. Then the
single final combined review pass with all three reviewers.

## 2026-09-15T00:00:00Z — Hardening

Did:
- Added `Disaster_Simulation_Spec.md`, `Disaster_Response_Actions.md` and
  `simulation-build-log.md` to CLAUDE.md's documentation-map table, and the
  new `components/simulation/`, `state/useSimulation.ts`,
  `fixtures/scenarios/`, and every new `lib/simulation*`/
  `coverageGeometry`/`responsePhaseGeometry` module to its
  Frontend-layout directory-structure section.
- Corrected CLAUDE.md's lib test-file count and total (10 files/81 tests ->
  16 files/143 tests), listing the six new files by name.
- Checked for leftover `TODO`/`FIXME`/`XXX` markers in every simulation
  file — none.
- Added `aria-live="polite"` to `SimulationSummary`'s section so its
  dynamic appearance on run completion is announced to screen readers
  rather than silently added to the DOM.
- Confirmed the feature's bundle-size impact: ~29KB (gzip ~8.4KB) added to
  the main chunk across the whole build — small against the pre-existing
  2.1MB baseline and its already-documented chunk-size warning; not worth
  code-splitting for this.
- Found and fixed one real gap while walking edge cases: `SimulationSummary`
  rendered neither its divergence line nor its "already flagged" line when
  `hitTowerIds` was empty (a scenario run with zero down towers selected —
  plausible if the live Sabah population's maintain/watch band is ever
  empty), leaving a silent blank space where a reader would expect some
  statement about the outcome. Added the missing third branch.
- Re-verified (by reading, not by re-deriving) several edge cases already
  covered by earlier per-item review rounds rather than assuming they still
  held after later changes: `boundsOf([])` returning `null` still guards
  `SimulationMap`'s framing effect; `downTowerSelector` over an empty tower
  array still returns `[]` without throwing (plain array methods); the
  `PhaseStrip` correctly stays on `'recovery'` once `status` reaches `'done'`
  (`phaseAt(TOTAL_DURATION_MS)` returns `'recovery'`, pinned by an existing
  test); the codebase's global `:focus-visible` rule in `index.css` already
  covers `TransportBar`'s plain `<button>` speed controls, so no
  per-component focus-ring fix was needed there.

Decisions made without the operator: none this cycle — every change was a
correction (docs/counts) or a gap-fill (the empty-summary branch) rather
than a new judgment call.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 16 lib test files pass (143 tests, 0 failures).
- Backend: re-ran the full suite twice across this cycle (once before the
  edge-case fix, once after) — both times 417 passed, same 3 pre-existing
  failures. No backend files touched.

Reviewers: none dispatched, per the operator's process change — this is
the last item before the single final combined pass.

Blocked: nothing external.

Next: the full backlog (P0-P8 + hardening) is built and both gates are
green. Dispatching all three reviewers — `mcmc-domain-reviewer`,
`simulation-integrity-tester`, `simulation-ux-reviewer` — together, in
parallel, exactly once, against the finished tab, per the operator's
explicit final-pass instruction.

## 2026-09-15T00:00:00Z — Final combined review pass

Did: dispatched `mcmc-domain-reviewer`, `simulation-integrity-tester` and
`simulation-ux-reviewer` together, in parallel, against the entire
finished tab — not a per-item check, a fresh full pass per the operator's
explicit instruction. Two real BLOCKERS came back and were fixed; several
non-blocker findings were fixed where cheap.

**BLOCKER 1 (simulation-integrity-tester) — replay silently stopped
calling the backend.** Both `useSimulationBackendBeats.ts` and
`SimulationSummary.tsx` reset their once-per-run guard refs on
`status === 'idle'`, but `simulationClock.play()` takes `'done'` straight
to `'running'` on a replay (`TransportBar` routes both `'idle'` and
`'done'` to `start()`), so a replay never passes through `'idle'` at all.
The refs stayed permanently "already fired": `/schedule/optimize` and
`/schedule/emergency` were never re-called, and `SimulationSummary` never
re-fetched `/schedule/baseline` — every run after the first silently
carried the FIRST run's stale results (or a stale "unavailable" if the
first fetch had failed) with no visible degradation. Fixed by keying both
reset effects on `runSeq` instead of `status`, since `runSeq` is bumped by
both `start()` and `resetSim()` and is exactly the "which run is this"
signal the P4 build-log entry already established for the earlier race
fix. Re-verified in a follow-up pass by the same reviewer: confirmed the
fix does not reintroduce the original pause-strands-pending bug (`runSeq`
is untouched by `pauseSim`/`resumeSim`, so a pause mid-round-trip still
resolves normally), and walked the full `idle -> run 1 -> done -> replay
-> run 2 -> done` lifecycle to confirm all three refs (`optimizeFiredRef`,
`emergencyFiredRef`, `SimulationSummary`'s `fetchedRef`) now clear on
every new run including a replay.

**BLOCKER 2 (mcmc-domain-reviewer) — baseline sentence misattributed a
standalone benchmark to the watched run.** `SimulationSummary`'s baseline
line said "than the optimizer actually used", but `/schedule/baseline`
takes no `run_id` — it is a standing national benchmark, not a re-run of
this simulation's own optimize call. Fixed by rewording both branches to
"in the standing national benchmark" throughout, removing the implication
that the figure describes the specific run just watched.

**Non-blocker (mcmc-domain-reviewer), fixed — the "already flagged"
summary line read as validating the risk index when it can't fail to
agree.** `sabahFlood.ts`'s `downTowerSelector` picks down towers FROM the
flagged (maintain/watch) set by construction — sorted by flood-attribution
share, top 4. So "every tower this scenario hit was already flagged" is
structurally guaranteed, not evidence the risk index anticipated anything;
a planner would notice this in ten seconds and the panel would lose
credibility. Added a disclosure sentence stating the selection rule
directly on the non-divergent branch, so the panel is honest about what
it can and cannot demonstrate.

**Non-blocker findings fixed:**
- `generators` beat's `<n>` resolved from `sabahTowerIds.size ? 1 : 0` — a
  logic bug independent of the domain finding that made the number always
  0 or 1 regardless of the actual scenario, and separately read as
  implausibly small against the real 266-tower 2025 event.
  `simulationConsoleLine.ts` now takes a real `downTowerCount` (the
  scenario's actual down-tower count) threaded through from
  `SimulationConsole`.
- `urgency-shift`'s console line said "`<n>` towers moved into maintain
  band", but the resolved number is Sabah entries already IN the
  maintain-band optimize run, not a count of towers that moved anywhere.
  Reworded to "`<n>` Sabah towers in the maintain-band run".
- `SimulationSummary` and `PhaseStrip`'s outer containers lacked
  `shrink-0` — in the right column's flex layout (now `overflow-y-auto`
  since P8), their default `flex-shrink: 1` could compress them below
  natural height once Summary appears, rather than the column scrolling.
  Added `shrink-0` to both.

**Findings reviewed and NOT changed, with reasoning:**
- `mcmc-domain-reviewer` noted 10 of 16 beats now carry an ILLUSTRATIVE
  badge (after P6's reclassification) and asked whether this
  overcorrected. Verdict from the same review: no — the three REAL/
  MECHANISM beats are exactly the load-bearing ones (optimize, emergency
  dispatch, forecast/urgency-coupling, reserve, ledger), and the badge
  density honestly maps `docs/Disaster_Response_Actions.md`'s own table.
  Not touched.
- `mcmc-domain-reviewer` flagged several "questions the demo cannot
  answer" (why these specific towers, what the scale gap is against the
  real 266-tower event, whether a generator truck could reach a flooded
  site) as things a sharp questioner might raise. These are honestly
  out of scope for this build — spec §15 explicitly excludes propagation
  modelling and access-constraint simulation — and are left as known
  limitations rather than papered over with more scripted detail.
- `simulation-ux-reviewer` flagged that Summary's appearance changes the
  right column's content height only once, at run completion, when motion
  has stopped — judged as reading like "a conclusion arriving", not jank,
  and not fixed beyond the `shrink-0` addition above.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  warnings). All 16 lib test files pass (144 tests — one new case for the
  `generators` beat's corrected placeholder — 0 failures).
- Backend: re-ran the full suite twice across this cycle (once as part of
  the reviewers' own verification, once after the fixes) — both times 417
  passed, same 3 pre-existing failures.

Reviewers: all three ran once, together, against the finished tab, per
the operator's explicit instruction. `simulation-integrity-tester` was
resumed once more for a targeted re-verification of the replay fix only
(not a second full pass). Findings and dispositions recorded above.

**What is still NOT verified in a browser**, stated explicitly rather than
implied by the green gate: the replay lifecycle itself (idle -> run ->
done -> replay -> run -> done) was walked by reading the code and tracing
the exact React effect dependencies and `runSeq` values through each
transition, not by driving it in an actual browser against a live
backend. The map's overlay layers, animation timing, colour contrast, and
narrow-width layout (1280px/1024px) have likewise never been opened in a
browser at any point in this build — every claim about them is a reading
of the CSS/component code, not an observation.

Blocked: nothing external.

Next: nothing — the backlog (P0-P8), hardening, and the final combined
review pass are complete. All commits are local, per instruction not
pushed.

## 2026-09-15T15:43:35Z — Post-ship interactive fixes (operator-directed)

Did: five fixes made directly at the operator's request while reviewing
the shipped tab in a browser for the first time — the P7 log entry's own
"NOT verified in a browser" caveat surfaced real bugs the moment someone
actually looked.

- **`SimulationMap` was `interactive: false`.** Zoom/pan were completely
  disabled. Now interactive with `dragRotate`/`pitchWithRotate`/
  `touchPitch` off (this map has no 3D mode, unlike the main console).
  Silent-instance contract unaffected — interaction doesn't touch
  `useMapInstance`.
- **Tower marks didn't match the main map console.** Simulation drew its
  own flat single-colour circle; now imports `towersToGeoJSON`/
  `towerPaint`/`towerIconLayout`/`towerIconPaint`/`TOWER_ICON_IMAGE_ID`
  directly from `components/map/towerLayer.ts` so a tower reads identically
  everywhere in the app, loading `/brand/tower-icon.png` the same
  addImage-then-addLayer order `MapView.tsx` uses.
- **COW used a plain square div, not the jeep asset, and chased the
  outage marker instead of parking near it.** Added a `/brand/jeep.png`
  symbol layer (`icon-size` divisor was wrong the first pass — used 128
  against the asset's actual 512px, rendering ~4x oversized; fixed). COW
  now deploys to a fixed offset site (`COW_OFFSET_KM`) near, not on top of,
  the down tower, with its own small illustrative coverage circle, one per
  down tower rather than only the first.
- **Two COWs landed stacked on each other.** `deployBearing` hashed only
  the tower id, and two real Sabah towers ~30m apart have OSM ids
  differing by one trailing digit (`...295`/`...294`), which hash to
  nearly the same bearing (261°/262°). Now index-based: bearing is spread
  evenly across the currently-down set (`360/total * index`) with a small
  per-id jitter, so simultaneous COWs reliably separate.
- **Crew-dispatch route was a literal straight line.** This project holds
  no road-network geometry (`scheduler/travel.py` stores only measured
  minutes/km from the OSRM matrix, never a polyline), so a straight line
  claimed a path exactly as much as any other shape would. Per the
  operator's explicit choice (no live routing API — no new network
  dependency in a demo path), added `curvedLine`/`pointOnCurve` to
  `lib/coverageGeometry.ts` (a bowed quadratic Bezier) and drew the route
  with that instead. The dispatch itself is unchanged (`evidence: 'real'`)
  — only the line's shape is illustrative, same split as the sector cones.
- **Map defaulted to framing all of Sabah**, leaving the actual scenario
  (a handful of down towers) as a barely-visible dot. The Start-triggered
  `fitBounds` now frames the down-tower cluster specifically
  (`DOWN_CLUSTER_MAX_ZOOM = 13`), falling back to the full Sabah frame only
  if the scenario hasn't resolved down towers yet.

**Two real logic bugs found from screenshots, not just cosmetic:**

- **A tower could show OFFLINE during the pre-event phase, before the
  flood had even appeared.** `downTowerIds` is populated the instant
  `start()` runs (`elapsedMs = 0`) so the backend beats and closing
  summary have the scenario premise available early — but the outage
  ring/coverage-gap effect drew straight from that set with no time gate,
  while the flood-extent effect correctly waited for its own beat
  (`floodExtentAt`). Fixed: outage mark + coverage-gap now only render
  inside `[TOWER_DOWN_MS, TOWER_RESTORE_MS)` = `[29000, 80000)` ms,
  matching the `tower-down`/`restore` beats in `lib/simulationTimeline.ts`.
- **A down tower could sit geographically outside the flood polygon drawn
  on screen.** `selectDownTowers` filtered candidates against
  `SCENARIO_BOUNDS`, a loose bbox spanning the whole KK/Penampang/Putatan
  corridor — far larger than the hand-authored `SMALL_EXTENT`/
  `FULL_EXTENT` shapes actually drawn. A tower could pass the bbox check
  while sitting nowhere near the blue shape. Compounding it: `SMALL_EXTENT`
  itself, redrawn to fix this, turned out to enclose ZERO real Sabah
  towers on live data — the original polygons were authored from district
  names with no check against actual tower coordinates. Fixed in three
  parts: (1) added a ray-casting `pointInPolygon` test and select against
  `SMALL_EXTENT` specifically (the extent active at the moment
  `tower-down` fires, 29s — after `flood-onset`'s 24s SMALL_EXTENT but
  before `taskforce` grows it to FULL_EXTENT at 34s; every SMALL_EXTENT
  point is also inside FULL_EXTENT, so this covers both frames); (2)
  redrew both polygons as irregular multi-point rings around the real
  tower cluster (lon 116.03-116.13, lat 5.925-5.99 — Bundusan/Luyang/
  Minintod), replacing the rectangles with an organic flood-plain shape
  per the operator's request; (3) widened the decision-band filter to
  `maintain`/`watch`/`ok` — measured live, only 2 of 62 Sabah towers sit
  inside the corrected `SMALL_EXTENT` at all, and both are `ok`-band. A
  flood is a stated external event, not the risk index's own claim about a
  tower, so an `ok` tower can legitimately be the scenario's outage; the
  restriction to maintain/watch would have left zero eligible towers on
  the current dataset. Verified against live `/towers`: SMALL_EXTENT now
  encloses 2 towers, FULL_EXTENT 7, and every SMALL_EXTENT tower is
  confirmed a subset of FULL_EXTENT.

Decisions made without the operator: none beyond the choices already
called out above (all five original items and the routing-geometry
question were explicit operator asks, including the curved-line vs
live-routing-API tradeoff via direct question).

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 2 pre-existing
  `useLiveTowers.ts` warnings; 2 new benign `react-hooks/exhaustive-deps`
  warnings on `.current` reads inside a `Map`/`Set` ref's cleanup function
  — same false-positive class the rule already produces elsewhere in this
  file, not a real leak). All 16 lib test files pass, including
  `coverageGeometry.test.mjs`'s existing 11 cases unaffected by the new
  `curvedLine`/`pointOnCurve`/exported `destination` additions (no new
  tests written for those three specifically — a targeted fix, not a new
  backlog item).
- Backend: not touched.
- Down-tower/flood-polygon geometry independently checked against the live
  `/towers` endpoint via a FastAPI `TestClient` script (not just read), not
  just asserted from the source.

Reviewers: none dispatched — these are small, operator-directed,
already-scoped fixes to a shipped feature, not a new backlog item; the
single combined final pass already ran in the prior entry.

Blocked: nothing external.

**What is still NOT verified in a browser**, carried forward from the
prior entry and still true beyond what these fixes specifically addressed
by eye: replay lifecycle, animation timing, colour contrast, and
narrow-width layout have not been driven in an actual browser session by
me — the operator's own screenshots are the only browser evidence in this
log, and every fix above responded directly to what those screenshots
showed rather than to a fresh audit of everything else.

Next: nothing outstanding from this round. Committed and pushed per
operator instruction.

## 2026-09-16T08:00:42Z — Coverage-gap shrink + cow beat placeholder (operator-directed)

Operator flagged a screenshot of the response phase as bad strategy on its
face: the big red coverage-gap circle over the Kampung Lokob/Menggatal
cluster only had grey retune sector cones over its southern half, nothing
over the north; the Luyang outage cluster showed a purple COW circle over
one marker and nothing over the second; and only 2 jeep icons were visible
against an outage set spanning several clusters.

Root cause, confirmed by reading `SimulationMap.tsx` and
`responsePhaseGeometry.ts` rather than assumed from the screenshot: the red
`sim-coverage-gap` polygon (`coverageGapPolygons`, union of 3.5km circles,
one per down tower) was computed ONLY from `downTowerIds` and never touched
again for the rest of the response window. Sector cones and COW coverage
circles rendered on top of it, but neither ever fed back into the gap
layer — so the red footprint stayed one static blob for the whole outage
window regardless of how much of it a landed response action was actually
standing in for. That is precisely the "half the circle isn't covered"
reading the operator had: the uncovered half wasn't a targeting bug, it was
the gap layer simply never being told anything had responded. Spec §6
Phase 3 already says "gap footprint shrinks as each action lands" — this
was never built, only the static union was.

Fix: `coverageGapPolygons` now takes a third argument, the current list of
restored-coverage polygons, and subtracts their union (`@turf/difference`,
newly added dependency — `@turf/circle`/`helpers`/`union` were already
installed, `difference` was not) from the gap union before rendering. Two
new refs (`sectorFootprintsRef`, `cowFootprintsRef`) on `SimulationMap`
hold the CURRENTLY-covering footprints: a sector cone only counts once
fully retuned (`t >= 1` in its swing animation — a cone still mid-swing
isn't yet pointed at the gap it's covering), and a COW circle only counts
once `cowArrivedRef` has it (a jeep en route provides no coverage). Both
effects call a shared `recomputeGapRef.current()` after updating their own
footprint so the gap layer redraws the moment either changes, without the
gap effect itself needing to recompute on every animation frame. The
uncovered patch of red that remains after all landed actions are
subtracted is deliberately left showing — a 15km neighbour-search radius
and a 2km cluster radius will genuinely not reach every down tower, and an
honest gap is the correct report of that, not something to hide.

Separately, `cow` beat's console line still read the literal
`<location>` placeholder verbatim — `simulationConsoleLine.ts`'s switch had
no case for `'cow'`, so the text never resolved. No addressable location
data exists to fill it honestly (tower positions are OSM points, not named
sites — CLAUDE.md's standing caveat on this dataset), so the line was
reworded to report the deployment COUNT instead of inventing a place name:
`'<n> temporary base station(s) deployed — …'`. `SimulationConsole.tsx` now
computes `cowClusterCount` via the same `clusterDownTowers` grouping the
map itself uses for COW sites, so the console's stated count and the
number of jeep icons on screen can never disagree — the same asymmetry
class as the "previously said 6, only showed 2" complaint the operator
raised, just for the OLD non-placeholder-resolving state rather than a
literal wrong number (there was no hardcoded 6 found anywhere in the
codebase; likely a stale narration from an earlier `MAX_DOWN_TOWERS`/
`downTowerCount` figure in a prior run, not a current bug).

Decisions made without the operator: wording of the reworded `cow` console
line ("temporary base station(s) deployed" vs restating a place name) —
picked count over a fabricated location per the same evidence discipline
the rest of this file already applies; the fully-retuned/arrived gating
rule for what counts as "covering" (an in-flight cone or travelling COW
does not shrink the gap) — the natural reading of "as each action lands."

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings carried from the prior entry — 2 `useLiveTowers.ts`, 2
  `.current`-in-cleanup on the unrelated dispatch-animation effect; no new
  warnings). `simulationConsoleLine.test.mjs` (9 tests, 1 new — cow beat
  fills n with cluster count, not a location), `responsePhaseGeometry.test.mjs`
  (22, unchanged), `simulationTimeline.test.mjs` (14, unchanged) all pass.
- Backend: not touched.
- `@turf/difference` installed (`npm install @turf/difference`); confirmed
  present in `node_modules/@turf` alongside the four already-used turf
  packages before wiring the import.

Reviewers: none dispatched — operator-directed fix scoped to what the
screenshot showed, not a new backlog item.

Blocked: nothing external.

**What is still NOT verified in a browser**: the actual visual shrink
behaviour — whether the red polygon visibly recedes as cones/COWs land, at
what rate, and whether the remaining uncovered patch reads clearly as
"genuinely unreached" rather than as a rendering glitch — has not been
watched in a live run. This was fixed by reading the render pipeline and
confirming the data flow is now correct (build + lint + unit tests only);
the operator's next run of the simulation is the first real check of how
the shrink actually looks.

Next: watch a live run of the response phase and confirm the gap visibly
recedes; if the remaining always-red patch on a wide cluster (like Kampung
Lokob/Menggatal) reads as confusing rather than honest, consider whether
the console needs a line stating "N towers still outside response range"
rather than leaving the map to say it alone.

## 2026-09-16T08:13:39Z — Gap-shrink reverted; spread selection + minimum COW site separation (operator-directed correction)

Operator looked at a second screenshot of the same response phase and
rejected the direction of the prior entry outright: **do not erode the red
coverage-gap circle, even for ground a response action has covered** — the
red footprint is meant to persist as the honest baseline of what went down,
regardless of what's responding to it. That is the opposite instruction
from what the prior entry shipped (subtracting landed coverage from the
gap), so the prior entry's `coverageGapPolygons`/`@turf/difference`/
`sectorFootprintsRef`/`cowFootprintsRef`/`recomputeGapRef` changes to
`SimulationMap.tsx` were reverted via `git checkout --` on that one file
(confirmed via `git status`/`git diff` before and after — nothing else was
touched, and nothing had been committed this session so the revert lost no
committed work). The `@turf/difference` dependency and the `cow` beat
console-line fix (separate, unrelated to the gap logic, not objected to)
were left in place.

The operator's actual complaint in the second screenshot was two concrete
things, not the gap persisting: (1) two COW ("jeep") markers rendering
visually on top of each other at one location despite two logically
distinct outage clusters, and (2) every retune sector cone fanning across
roughly the same southern arc, leaving the north/east side of the same
outage cluster with no cone at all — reading as "jeeps overlap, rerouting
still points at the same areas, offline areas still uncovered," i.e. the
RESPONSE geometry itself looks like it isn't actually spreading to reach
different parts of the outage, independent of whether the red gap shrinks.

Root causes, found by reading `responsePhaseGeometry.ts` rather than
guessed from pixels: `selectRetuningNeighbors` picked the 3 GLOBALLY
nearest surviving towers with no regard for direction, so when the 3
nearest all happened to sit on the same side of the down tower (which a
real, non-uniform tower distribution makes likely), every retuned cone
pointed the same way and the opposite side of the gap got nothing — not a
targeting bug, just an algorithm with no notion of "spread." Separately,
`assignClusterSites`' greedy nearest-survivor matching deduped only on
survivor `tower_id` — two DIFFERENT survivors sitting a few hundred metres
apart could each be legitimately claimed by two different clusters, and at
that separation their `COW_COVERAGE_RADIUS_KM = 1.4` circles fully overlap,
which is what a viewer sees as "one jeep icon, stacked."

Fix, both in `responsePhaseGeometry.ts`:
- `selectRetuningNeighbors` now splits the compass into
  `RETUNE_SECTOR_COUNT` (= `MAX_RETUNING_NEIGHBORS` = 3) 120-degree bearing
  sectors around the down tower and picks the nearest CANDIDATE PER SECTOR,
  not the nearest 3 overall. A sector with nothing in range is left empty
  rather than backfilled from an already-used direction — fewer than 3
  cones is the honest report of "nothing plausible on that side," matching
  the same "never silently paper over a gap" discipline the rest of this
  file already follows for the coverage-gap circle itself.
- `assignClusterSites` gained `MIN_SITE_SEPARATION_KM = 3` (just above
  `2 x COW_COVERAGE_RADIUS_KM`, so two accepted sites' circles can at worst
  touch, never overlap) and now runs its greedy nearest-survivor pass
  TWICE: first only accepting a survivor that also clears that separation
  from every already-claimed site, then a second unconstrained pass for any
  cluster still unsited. A cluster is never left without a site — a
  too-close site is still better than none, same "unscheduled work always
  returned explicitly, never silently dropped" principle CLAUDE.md already
  states for the scheduler proper, applied here to the illustrative COW
  siting.

Both changes are geometry/selection-only — `clusterDownTowers`'s existing
centroid-bounded clustering, the COW/sector rendering pipeline in
`SimulationMap.tsx`, and the (still-static, per operator instruction)
`coverageGapPolygons` union are all untouched.

Decisions made without the operator: sector count tied to
`MAX_RETUNING_NEIGHBORS` (3 sectors for 3 neighbours) rather than a
separately-tunable number — keeping one config point rather than two that
could drift out of sync; `MIN_SITE_SEPARATION_KM`'s exact value (3km, just
above 2x the COW radius) — picked from the existing `COW_COVERAGE_RADIUS_KM`
constant already in the file rather than an arbitrary round number, so the
two stay physically consistent if the COW radius ever changes.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings as every prior entry — 2 `useLiveTowers.ts`, 2 `.current`-in-
  cleanup on the dispatch-animation effect; no new warnings). All 16 lib
  test files pass (`responsePhaseGeometry.test.mjs` now 24 tests, +2 new:
  one confirming the sector-count cap still holds when candidates share a
  bearing sector, one confirming three candidates in three distinct sectors
  are all picked; the clustering suite now 1 new test asserting two close
  survivors are never both accepted as sites for two nearby clusters).
  Existing "closest-first, caps at 3" test was renamed to state what it
  actually now checks (all four fixture towers share one bearing sector, so
  only the nearest is picked) rather than silently keep a name that implied
  a global-nearest-3 guarantee the new logic no longer makes.
- Backend: not touched.
- Confirmed via `git diff`/`git status` before reverting `SimulationMap.tsx`
  that no other file's changes would be affected and nothing committed
  would be lost.

Reviewers: none dispatched — operator-directed correction to the prior
entry's approach, using the same screenshot-driven scope as before.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry in this file — the actual visual result (do the cones now
visibly fan across more of the gap's circumference, are the two Luyang-area
jeeps now visibly separated, does the persistent red gap read as intended
rather than as "nothing happened") has not been watched in a live run. This
was fixed and tested at the data/geometry level only; the operator's next
screenshot or live run is the real check.

Next: watch a live run and confirm (a) sector cones now visibly reach more
than one side of a multi-tower outage cluster, (b) the two Kampung
Lokob-area COW markers now render as visibly separate icons rather than
stacked, and (c) the red gap circle is confirmed still present and
unchanged in size/shape throughout the response phase, per this round's
explicit instruction.

## 2026-09-16T08:19:48Z — COW site distance cap (operator-directed follow-up)

Operator's third screenshot (after the sector-spread + min-separation fix
above) showed real progress — three visibly distinct jeeps instead of two
stacked ones — but flagged a new, more specific problem: one jeep (at
Menggatal/Telipok, screenshot right side) sat nowhere near any OFFLINE
marker or red gap circle at all, while a separate outage cluster (two
OFFLINE markers at Luyang, screenshot bottom) had no jeep. Operator's ask:
every offline area gets a jeep, and no jeep sits somewhere that isn't
offline.

Root cause: `assignClusterSites` picks the nearest UNCLAIMED survivor as a
cluster's deployment site with no ceiling on how far that survivor may be.
In a sparse area, "nearest unclaimed" can still be several km away once
closer survivors are claimed by other clusters — the prior entry's own doc
comment already recorded a measured case of 4.3-7.7km. At that distance a
COW's `COW_COVERAGE_RADIUS_KM = 1.4` circle sits nowhere near the outage it
was assigned to, and the jeep icon itself reads as "responding to nothing"
exactly as the operator described. The Luyang cluster's missing jeep is the
same mechanism from the other direction: if its nearest-available survivor
also got excluded or claimed elsewhere, the old code would still assign
whatever was left, however far — this round tightens that instead of
loosening it, on the reasoning that a cluster with truly nothing nearby is
better served by its own centroid (still inside the outage) than a distant
real tower that isn't actually helping.

Fix (`responsePhaseGeometry.ts`): `assignClusterSites` now excludes any
(cluster, survivor) candidate pair whose distance exceeds
`MAX_SITE_DISTANCE_KM = 3.5` BEFORE the greedy nearest-first matching runs
— not just deprioritised, removed from consideration entirely, in both the
separation-enforcing pass and the fallback pass. A cluster left with zero
candidate survivors within range correctly falls through to the existing
"no survivor available" branch and sites itself at its own centroid, which
is guaranteed to sit among (not near) its member down towers. 3.5km was
chosen to comfortably clear `CLUSTER_RADIUS_KM`'s (2km, centroid-bounded)
worst-case ~4km cluster span while still hard-excluding the 6-10km distant
picks the screenshots showed; the exact value and its reasoning are
recorded on the constant itself.

This is deliberately a CEILING, not a preference — unlike
`MIN_SITE_SEPARATION_KM`'s two-pass "prefer spacing, but never leave a
cluster unsited" design, there is no second pass that loosens
`MAX_SITE_DISTANCE_KM`: a site beyond it is never an acceptable answer for
that cluster, only the centroid fallback is.

Decisions made without the operator: the exact 3.5km value — derived from
the two other geometry constants already in the file rather than picked
freestanding, so the three distance constants stay mutually consistent if
`CLUSTER_RADIUS_KM` or `COW_COVERAGE_RADIUS_KM` are ever retuned.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings as every prior entry, no new ones). All 18 lib test files pass;
  `responsePhaseGeometry.test.mjs` now 25 (+1: a survivor ~8.8km from its
  cluster is rejected and the site falls back to the down tower's own
  centroid, asserted by checking the fallback site lands near the down
  tower rather than near the rejected survivor). Manually recomputed the
  existing "distinct sites even when they share one nearest survivor" test
  (line ~209) against the new 3.5km cap before trusting the full-suite
  green — its `shared` survivor sits at 2.765km from both cluster
  centroids (inside the cap, unaffected) and its `far` survivor at
  6.5-10.4km (now excluded from both clusters' candidate pools, same
  fallback-to-centroid outcome as before, test intent preserved).
- Backend: not touched.

Reviewers: none dispatched — small, targeted follow-up to the immediately
prior entry, same operator-screenshot-driven scope.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry — whether the Menggatal-area jeep now sites itself back inside
its own outage cluster's centroid, and whether the previously-uncovered
Luyang pair now gets a visible jeep, has not been watched live. Fixed and
tested at the data/geometry level only.

Next: watch a live run and confirm every OFFLINE cluster shows a jeep
sited among its own markers (not several km away), and that no jeep sits
in an area with no red gap circle underneath it.

## 2026-09-16T08:56:59Z — Discovered prior "revert" never took effect; gap-shrink actually reverted; COW sub-clustering for wide outage pockets (operator-directed)

Two things happened this round, and the first is a process failure worth
recording plainly. The entry two above this one ("Gap-shrink reverted;
spread selection + minimum COW site separation") claimed to have reverted
`SimulationMap.tsx`'s gap-shrink logic via `git checkout --`. That command
is a no-op against a file with no uncommitted changes, and — unknown to me
at the time — the gap-shrink work had already been committed (`e18ec7f
"Shrink coverage gap as response actions land"`) by an earlier point in
this session, before the operator's rejection. `git checkout --` restored
the file to HEAD, which WAS `e18ec7f` — i.e. it changed nothing. `git
status`/`git diff` reporting no differences was the evidence this had
happened, and I misread "no diff" as "successfully reverted" rather than
"there was nothing to revert because the unwanted code is the committed
baseline." I built two further rounds of fixes (bearing-spread neighbour
selection, MIN_SITE_SEPARATION_KM, MAX_SITE_DISTANCE_KM) on top of that
mistaken belief without re-checking. The operator's follow-up screenshots
never surfaced the gap actually shrinking (their two most recent screenshots
happen to be mid-outage stills, not sequential frames, so a still-shrinking
gap wouldn't necessarily have been visible), so this was only caught this
round by re-reading the live `SimulationMap.tsx` source directly instead of
trusting the prior entry's claim. Fixed properly this time: `git show
e18ec7f -- .../SimulationMap.tsx | git apply -R -` (a real reverse-patch
of the exact committed diff), confirmed with `git diff --stat` (75
deletions, 10 insertions — matches the original commit's file exactly
inverted) and a full rebuild. The `@turf/difference` dependency and the
`cow` beat placeholder fix (separate files, never objected to) were left
in place, matching the intent of the original correction.

Lesson for future entries in this file: "git status shows no diff" after a
checkout is not evidence a revert succeeded — it is only evidence the
working tree matches HEAD, which is exactly what you'd also see if HEAD
already had the unwanted change and there was nothing to check out over.
Confirm a revert against the actual diff being undone, not against an
absence of pending changes.

Second, the actual operator ask from this round's screenshots: two
outstanding coverage problems even after the sector-spread and
MAX_SITE_DISTANCE_KM fixes. (1) Screenshot 1 (KK/Luyang area): a Tanjung
Aru/Sembulan OFFLINE cluster with zero jeep. (2) Screenshot 2 (Kampung
Lokob): three jeep icons rendering essentially stacked on one OFFLINE
marker while a large pink gap toward Kampung Lokbuno, clearly part of the
same outage picture, had no coverage at all.

Investigated (2) first since it looked most like a bug: traced through
`assignClusterSites`'s dedupe (`claimed` set on survivor tower_id) and
confirmed by simulation that with N clusters and >=N available survivors,
identity-based dedup alone already guarantees N distinct sites — the
"three jeeps stacked" reading is not a dedup collision. Asked the operator
directly rather than guess further, and confirmed the real mechanism: this
is very likely ONE coarse cluster (several down towers close enough to
satisfy `CLUSTER_RADIUS_KM`'s centroid bound) getting exactly one COW site
— by design, since the file's stated model is "one deployment per pocket
of nearby outages" — but `CLUSTER_RADIUS_KM` (2km) permits a coarser
pocket than `COW_COVERAGE_RADIUS_KM` (1.4km) can physically reach: a
cluster can span up to ~4km across while one COW's coverage circle is only
2.8km across, so a single deployment sited at the pocket's centroid
structurally cannot reach a member sitting near either edge. The Lokbuno
gap is exactly that unreached edge.

Fix (`responsePhaseGeometry.ts`, `clusterDownTowers`): added a second,
tighter sub-clustering pass. The existing centroid-bounded grouping at
`CLUSTER_RADIUS_KM` still decides which down towers count as "the same
outage pocket" (unchanged — this is the pass that already prevents
long-chain collapse, per the existing "does not chain a long line of
towers" test). A NEW pass then checks each coarse cluster's
`maxDistanceFromCentroid`; any cluster wider than the new
`COW_REACH_RADIUS_KM` (1.4km, deliberately equal to
`COW_COVERAGE_RADIUS_KM` — the widest a single COW's reach can plausibly
be asked to cover) gets re-clustered at that tighter radius via the same
centroid-bounded chaining logic, and each resulting sub-cluster goes
through `assignClusterSites` as its own independent deployment. A six-tower
pocket spanning 3.5km now becomes 2-3 deployments instead of one COW parked
uselessly in the middle — directly answers "send jeeps to the uncovered
part," since a sub-cluster near the pocket's far edge gets its own site
assignment (and inherits all of MAX_SITE_DISTANCE_KM/MIN_SITE_SEPARATION_KM
from the existing `assignClusterSites` logic, unchanged).

Sembulan's missing jeep (issue 1) was not independently root-caused this
round — plausibly the same mechanism (a coarse cluster spanning past COW
reach, with Sembulan on the far/uncovered side of some larger pocket) but
not confirmed against exact coordinates. The sub-clustering fix should
resolve it if that is the mechanism; flagged in Next below to check
specifically rather than assumed fixed.

Decisions made without the operator: `COW_REACH_RADIUS_KM`'s exact value
(1.4km, equal to `COW_COVERAGE_RADIUS_KM`) — the natural choice, since a
sub-cluster wider than a COW's own coverage radius is by definition too
wide for that COW to reach across; reusing the identical centroid-bounded
chaining algorithm for the sub-pass rather than writing a different
splitting heuristic, to keep one clustering algorithm in the file instead
of two.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings, line numbers shifted by the SimulationMap.tsx revert but same
  2 pairs). All 18 lib test files pass; `responsePhaseGeometry.test.mjs`
  now 27 (+1 from the prior entry's progressive-relaxation work which
  turned out — checked directly, see below — not to be what fixes the
  stacking bug; +1 new: a coarse cluster spanning 3.58km, still within
  CLUSTER_RADIUS_KM's centroid bound, must sub-split into two deployments,
  one per member). Manually simulated the OLD binary two-pass separation
  logic against the new "three competing clusters" test's exact
  coordinates before trusting it — confirmed that with equal cluster and
  survivor counts, identity dedup alone already produces distinct sites
  under BOTH old and new logic, meaning that specific test does not
  actually discriminate between them; kept anyway as a valid regression
  test for the progressive-relaxation behaviour, but the operator's actual
  screenshot bug is understood to be the coarse/sub-cluster radius mismatch
  fixed in this entry, not the separation-pass shape fixed in the prior one.
- Backend: not touched.

Reviewers: none dispatched — operator-directed, screenshot-scoped as
every entry in this file has been.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry — whether the Lokbuno-side gap now gets a visible second jeep,
whether Sembulan's jeep issue is actually the same mechanism and is now
fixed, and whether the red gap circle (confirmed via source read, not
screenshot, to now be genuinely un-eroded again after this round's proper
revert) reads correctly in a live run. Fixed and tested at the
data/geometry level only.

Next: watch a live run and specifically check (a) the Kampung Lokob pocket
now shows 2+ visibly separated jeeps reaching toward Lokbuno, (b) Sembulan
gets a jeep — if not, that is a DIFFERENT bug from the one fixed here and
needs its own root-cause pass with real coordinates rather than assumed
fixed by extension, (c) the red gap is confirmed still static across the
whole run (this is the second time this needed fixing — worth an explicit
visual double-check specifically because of this round's process failure).

## 2026-09-16T09:14:18Z — Ring-packed multi-COW deployment: send jeeps until the gap actually reads covered (operator-directed)

Operator asked directly: the prior entry's sub-clustering fix (split a
coarse pocket too wide for one COW to reach) had not visibly changed
anything on screen. Before touching code again, asked the operator to
confirm one specific thing first rather than guessing a third time: was
the still-uncovered pink Lokbuno-side ground showing its own OFFLINE
marker, or just red shading with no tower there? Confirmed: no marker,
just shading. That changes the diagnosis completely — there is no down
tower in that spot for any clustering fix to site a jeep near, because the
red gap circle (`COVERAGE_GAP_RADIUS_KM = 3.5km`, one per down tower,
unioned) is drawn far bigger than any single COW's reach
(`COW_COVERAGE_RADIUS_KM = 1.4km`) by design — a tightly-packed group of
down towers will ALWAYS paint red well past where a jeep sitting among
them can visibly touch, no matter how the sites are chosen. Asked the
operator to choose between shrinking the red radius (an honest reduction
in claimed dead-zone) or leaving the mismatch and explaining it on screen;
the operator instead asked for a third option not offered: more jeeps,
escalating — "4 not enough, then 6, then 10" — until the red visibly reads
as covered. Built that instead.

**Design change, not a bug fix this time.** `clusterDownTowers`
(`responsePhaseGeometry.ts`) previously produced exactly one deployment
per outage pocket (after the prior entry's sub-split, occasionally two or
three for a wide pocket). It now ring-packs MULTIPLE candidate site
targets around every member down tower: one centred on the tower plus a
ring of points at `COVERAGE_GAP_RADIUS_KM - COW_COVERAGE_RADIUS_KM`
(2.1km) from it, spaced so adjacent COW coverage circles overlap by half a
radius rather than merely touching. At the real project constants (3.5km /
1.4km) this yields 8 targets per isolated down tower — pinned by a new
test (`sitesPerDownTower ring-packs to 8 deployments for the real project
constants`) specifically so a future radius retune is forced to notice the
jeep count it implies. Targets from different down towers within the same
pocket that fall within `RING_TARGET_DEDUPE_KM` (=
`COW_COVERAGE_RADIUS_KM`) of an already-kept target are dropped before
survivor assignment, so close-together towers in one pocket don't each
separately request a full ring of near-duplicates.

**Restructured `assignClusterSites` to stop assuming "one site per
cluster."** It now takes `SiteRequest[]` (`{members, target}` pairs) rather
than raw member arrays — `members` is still what a deployment reports for
labelling/attribution (the whole pocket, repeated across every ring
position that pocket expands to), `target` is the actual point a survivor
should be picked near (a ring position, not the pocket's centroid). Every
existing mechanism — `MAX_SITE_DISTANCE_KM`'s ceiling, `MIN_SITE_SEPARATION_KM`'s
progressive-relaxation spacing, the "never leave a request unsited"
centroid fallback — carried over unchanged, just keyed on request index
instead of cluster index. One correctness fix needed along the way: the
centroid-fallback id was `${members[0].tower_id}-site`, which would have
collided across multiple ring positions of the SAME down tower (all
sharing `members[0]`) — changed to `${members[0].tower_id}-site-${requestIndex}`
so every fallback site stays distinct.

**Added a fleet-wide cap.** Ring-packing alone is unbounded per pocket and
the scenario can have several widely-separated pockets, each independently
requesting up to 8 — unbounded, that reads as map clutter rather than a
response. `MAX_TOTAL_DEPLOYMENTS = 12` trims the combined request list,
round-robin across pockets by a new `trimRequests` (every pocket gets its
1st deployment before any pocket gets a 2nd, and so on), so a global cap
can never fully starve a small pocket to satisfy one large one. 12 was
picked as comfortably past the operator's own escalation ("4 not enough,
then 6, then 10") without being literally unbounded.

Decisions made without the operator: the exact ring spacing formula
(`1.5 x COW_COVERAGE_RADIUS_KM` between adjacent ring sites, giving
overlap rather than mere edge-touching) and `MAX_TOTAL_DEPLOYMENTS`'s
value (12) — chosen to sit just past the operator's stated escalation
point rather than asked as a fourth question, since the operator's own
phrasing ("4 not enough, then 6, then 10") reads as "keep going until it's
visibly enough," which a number past 10 satisfies without needing to be
exact. Recorded the tension this creates with `CLUSTER_RADIUS_KM`'s
original "operators hold a handful of units" research directly on that
constant's comment rather than silently overwriting it — a real
disagreement between the earlier domain research and this round's explicit
operator override, worth a future reconciling pass rather than erasing
either side's reasoning.

**The whole `clusterDownTowers` test suite needed rewriting, not
patching.** Every existing test asserted `clusters.length` as "number of
down-tower groupings" — with ring-packing that number is now "number of
site deployments," a different quantity entirely, so 8 of the file's tests
failed immediately on the redesign (expected 1-3 clusters, got 8-24). Since
the whole clustering model changed rather than one behaviour within it,
rewrote the clustering section of the test file from scratch rather than
patching each assertion individually: tests now separately check (a) which
down towers get GROUPED into one reported pocket (`members`, unchanged
concept) and (b) how many DEPLOYMENTS a pocket produces (new concept,
`clusters.length`), plus a new `survivorRing()` test helper for generating
enough spread-out candidate survivors that ring-packing isn't artificially
starved by too few coordinates. New tests: ring-packs an isolated tower
into >=4 deployments; pins the real-constants ring size at exactly 8;
fleet-wide cap holds at 12 with round-robin fairness verified directly
(max-min deployment count across pockets <=1).

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings, no new ones). All 18 lib test files pass;
  `responsePhaseGeometry.test.mjs` now 27 (rewritten clustering section,
  +5 net: ring-pack behaviour, real-constants pin, fleet-wide cap with
  round-robin fairness — a few of the old per-cluster tests collapsed into
  broader per-pocket tests that cover the same intent under the new model).
- Backend: not touched.
- Manually computed `sitesPerDownTower()`'s output for the real constants
  (3.5km / 1.4km) by hand before writing the pinning test, rather than
  trusting the formula blind: ring radius 2.1km, circumference ~13.2km,
  spacing 2.1km, ring count 7, total 8 — matches what the shipped test
  asserts.

Reviewers: none dispatched — operator-directed, screenshot-and-Q&A-scoped
as every entry in this file has been; the mid-round question to the
operator (marker vs shading) stood in for the reviewer pass this time,
since it resolved the actual diagnosis directly rather than requiring a
domain-review pass to guess at it.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry — whether the Kampung Lokob pocket now visibly reads as
"covered" rather than merely "reached," whether 12 jeeps fleet-wide looks
like a coherent response or like clutter on the actual console-sized map,
and whether the round-robin cap produces a sane-looking distribution when
the real scenario's `MAX_DOWN_TOWERS=12` towers spread across their real
Sabah coordinates rather than the synthetic ring-shaped survivor sets the
tests use. Fixed and tested at the data/geometry level only — this is a
bigger behavioural change than any prior entry in this file, so the live
check matters more than usual this time.

Next: watch a live run and check specifically (a) does the red gap now
read as substantially covered rather than just dotted with jeeps at its
edge, (b) does 12 feel like the right fleet-wide ceiling once seen against
a real multi-pocket scenario — the operator may want it higher or lower
once they see it move, (c) is `MIN_SITE_SEPARATION_KM`'s 3km still fighting
usefully against the ring's own ~2.1km intended spacing, or does the
progressive relaxation mostly just settle at whatever real survivors
happen to exist, making the constant closer to decorative than binding.

## 2026-09-16T09:45:29Z — spreadOrder bit-reversal ordering + fleet cap 12->24 (operator screenshot)

Operator's next screenshot showed real progress from the ring-packing
round — purple (COW coverage) now blanketed most of the pink gap across
Sembulan/Tanjung Aru/Karamunsing/Luyang/Damai/Bundusan — but named two
remaining thin uncovered strips: bottom-left near Lido/Kepayan, and a
sliver between the Luyang and Bundusan clusters. Before touching code
again, confirmed with a direct question that the operator wanted those
closed rather than accepting the current state as good enough.

Root cause, found by reading `ringPositions` and `trimRequests`, not
guessed: `ringPositions` emitted its ring of candidate site targets in
strict SEQUENTIAL bearing order (0deg, 1/7 of a circle, 2/7, ...). That is
invisible when a pocket keeps its full ring, but `trimRequests`'
fleet-wide `MAX_TOTAL_DEPLOYMENTS` cap (12, shared round-robin across every
simultaneously-active pocket in a multi-pocket scenario) routinely
truncates a pocket down to 3-4 of its 8 ring positions — and truncating a
SEQUENTIAL list always keeps the same low-bearing arc and drops the rest.
Every capped pocket was therefore missing the same side of its own ring,
which is exactly "thin strip on one edge" on screen. Verified this by hand
before writing a fix: for a 7-position ring truncated to 4, the sequential
order keeps bearings [0, 51, 103, 154] degrees — all within one half of the
circle — while the intended fix's bit-reversal order keeps [0, 206, 103,
309] — spanning the full circle.

Fix (`responsePhaseGeometry.ts`): added `spreadOrder(count)`, a bit-
reversal (van der Corput-style) permutation of `0..count-1` such that ANY
PREFIX of the output stays roughly evenly spread across the full range,
not bunched at the low end. `ringPositions` now iterates ring indices in
`spreadOrder` order instead of `0, 1, 2, ...` — a full, uncapped ring is
unaffected (same set of bearings, different order), but any TRUNCATED
subset — which is exactly what a fleet-wide-capped pocket receives —
now spans the circle instead of one arc. Confirmed by hand-computing the
old-vs-new first-4-of-7 comparison above before trusting the fix, and by a
new automated test that checks the largest angular gap between a trimmed
pocket's kept site bearings never exceeds 2.5x the even-spacing value.

Also raised `MAX_TOTAL_DEPLOYMENTS` from 12 to 24: even with `spreadOrder`
fixing the DIRECTION of the gap, 12 was thin enough per pocket (in a
several-simultaneous-pocket scenario) to still leave visible unclosed arcs
between COW circles, just spread more evenly around the circle rather than
concentrated on one side. 24 gives headroom for roughly 3 pockets at a
full 8-ring each before trimming engages, closer to matching what the
operator's screenshot showed as "most of the way there" already.

Decisions made without the operator: the exact bit-reversal ordering
scheme (vs. e.g. a simple stride/skip pattern) — picked because it
generalises cleanly to any ring count without special-casing, and its
"any prefix is well-spread" property is exactly the guarantee needed here,
not because it was the only workable option; `MAX_TOTAL_DEPLOYMENTS`'s new
value (24, not e.g. 18 or 30) — chosen as "roughly 3 full pockets' worth"
since the operator's own screenshots have shown 2-4 simultaneous pockets,
giving headroom without guessing at a much larger number the operator
hasn't asked for.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings, no new ones). All 18 lib test files pass;
  `responsePhaseGeometry.test.mjs` now 28 (+1: a new test with 6
  widely-separated pockets forcing heavy trimming under the raised cap,
  asserting every trimmed pocket's kept sites span the circle rather than
  bunching — this is the test that would have caught the reported bug
  directly, had it existed before this round). The existing fleet-cap test
  was updated from 3 pockets/12-cap (which, at 3x8=24, no longer exceeds
  the new 24 cap and would have silently stopped testing anything) to 4
  pockets/24-cap with an explicit "cap must have actually trimmed
  something" assertion, so the test can't quietly become a no-op again if
  the cap or ring size changes in the future.
- Backend: not touched.
- Manually simulated old-sequential vs new-spreadOrder truncation by hand
  (see above) before writing the automated test, to confirm the fix
  addresses the actual reported symptom rather than just "looking more
  correct" on inspection.

Reviewers: none dispatched — operator-directed, screenshot-scoped as every
entry in this file has been.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry — whether the two specific named strips (Lido/Kepayan,
Luyang-Bundusan sliver) are now visibly closed, and whether 24 as a
fleet-wide ceiling reads as "comprehensive response" or starts tipping
into clutter on the actual console map. Fixed and tested at the
data/geometry level only.

Next: watch a live run and check specifically whether the two named
uncovered strips from this round's screenshot are now closed. If a strip
persists in the SAME location, the mechanism is likely something this
round's fix didn't reach (e.g. a `MAX_SITE_DISTANCE_KM`-rejected pocket
falling back to its own centroid rather than a ring position, or a
pocket's coarse-cluster boundary excluding a down tower that visually
looks like it should be in the same pocket) and needs a fresh root-cause
pass with real coordinates rather than another guess from the ring-packing
angle.

## 2026-09-16T10:04:36Z — Manual Kampung Lokbuno target; raised MAX_SITE_DISTANCE_KM to fix persistent bunching (operator-directed, two rounds)

Two operator requests this round, handled in sequence with a mid-turn
correction on the first.

**Round 1: named place requests.** Operator asked directly to place jeeps
at five named locations (Lido, Jalan Datuk Panglima Banting, Jalan Gunung
Bintang, Kampung Lokbuno, Kampung Locob). Refused to hardcode place names
outright — CLAUDE.md's own standing rule for this scenario file is that
tower/site selection must be a function over the live population, never a
hardcoded id or place list, because OSM-derived coordinates are not stable
across a data refresh, and none of these five names exist anywhere in this
project's data (confirmed by grep — only prior appearances were in this
log's own prose, describing basemap labels visible in screenshots, not
data). Asked the operator to supply coordinates directly rather than guess
geocoding. Operator clarified mid-answer (interrupting a different
in-progress reply) that the five names were DESCRIPTIONS of where the
still-visible gaps were on the two most recent screenshots, not a request
for five fixed pins — the actual ask was "cover those areas," which the
already-in-flight `MAX_SITE_DISTANCE_KM`/`spreadOrder` work was already
addressing generically. Only one coordinate pair was actually supplied
afterward — `6.087205673672836, 116.13264321166467` for Kampung Lokbuno
specifically, sent as a follow-up once the operator confirmed with a
direct question that this ONE spot has genuinely no down tower under its
red shading (just gap-circle radius extending past real ground) and so
cannot be reached by the live ring-packing algorithm at all, only by a
manually-verified point.

Added `src/frontend/src/lib/manualCowTargets.ts`: `MANUAL_COW_TARGETS`, a
short explicitly-labelled array (one entry so far), spliced into
`SimulationMap.tsx`'s COW-deployment effect ALONGSIDE (not instead of)
`clusterDownTowers`'s live output. Each manual target still resolves to a
real nearby survivor tower within `MANUAL_TARGET_SURVIVOR_RADIUS_KM` (2km)
when one exists — same "park at an existing, still-reachable compound"
rule every other COW site follows — and only uses the raw operator-given
point directly as the site when nothing real is that close, which is a
DELIBERATELY different trust level from the live ring-packing path (which
never falls back to raw geometry at all, per this round's earlier fix):
this specific point was confirmed by the operator looking at real ground,
not inferred by an algorithm. `SimulationConsole.tsx`'s `cowClusterCount`
(the `<n> temporary base station(s) deployed` line) now adds
`MANUAL_COW_TARGETS.length` so the console count and the map's jeep count
can't disagree. Moved the constant out of `SimulationMap.tsx` into its own
lib file after `npm run lint` flagged a `react(only-export-components)`
fast-refresh warning on exporting a non-component value from a component
file — cleaner home anyway, and the warning is gone.

**Round 2: the ACTUAL bunching bug.** A fresh screenshot after all of the
above still showed the Kampung Lokob pocket's ~8 ring-packed jeeps all
visually stacked on the single OFFLINE marker, no visible spread despite
`spreadOrder` and `MIN_SITE_SEPARATION_KM` both being in place. Traced the
real mechanism this time rather than guessing at ring geometry again:
`assignClusterSites`'s greedy matching sorts ALL (request, survivor) pairs
GLOBALLY by distance and walks them in that order. In a dense pocket where
only 2-3 real survivor towers sit very close (within the OLD
`MAX_SITE_DISTANCE_KM = 3.5km`) and nothing else qualifies within that
ceiling, every ring position's nearest-available survivor is one of that
same tiny pool — `MIN_SITE_SEPARATION_KM`'s progressive relaxation was
correctly rejecting close repeats and falling through its passes as
designed, but had nothing farther to reach, so it settled for whatever
sub-3km spacing the 2-3 close survivors could offer rather than genuinely
spreading across the ring's intended ~2.1km-plus geometry. Asked the
operator directly whether to widen the reach (keep every jeep, accept
some landing farther from the outage) or tighten enforcement (accept
fewer jeeps but real separation) rather than guessing; operator chose
widening.

Fix: `MAX_SITE_DISTANCE_KM` raised 3.5km -> 6km. This lets `assignClusterSites`
consider real survivor towers up to ~6km from a ring target (which itself
already sits up to 2.1km from the down tower), giving the separation logic
an actually-wider pool to draw from once nearby survivors are exhausted by
closer requests, rather than collapsing everything onto the same 2-3 towers.
Still well short of the 8-10km distances that caused the ORIGINAL "jeep
parked nowhere near its outage" bug this constant exists to prevent.

Decisions made without the operator: none beyond value selection (6km,
picked as "clearly wider than the old ceiling, clearly short of the
8-10km bug range" rather than a third round-trip question) — the shape of
the fix (widen vs. enforce-and-drop) was the operator's own explicit
choice.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings after moving `MANUAL_COW_TARGETS` out of the component file;
  before that move, one new `react(only-export-components)` warning
  appeared and was resolved by the move rather than left standing). All 18
  lib test files pass; `responsePhaseGeometry.test.mjs` now 29 (+1: a
  targeted reproduction of the exact bunching mechanism — 3 very-close
  survivors plus 10 more ~5km out, asserting that with the widened ceiling
  most deployments reach the farther ring rather than all 8 collapsing
  onto the 3 close ones). The existing "falls back to nothing" test (a
  lone survivor at ~8.8km) still correctly rejects at the new 6km ceiling,
  confirming the widened value doesn't silently readmit the original bug
  case.
- Backend: not touched.

Reviewers: none dispatched — operator-directed, screenshot-and-Q&A-scoped
as every entry in this file has been; two direct mid-round questions
(named-places clarification, widen-vs-enforce tradeoff) stood in for a
domain-review pass this round.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap as every
prior entry in this file — whether the Kampung Lokob pocket now visibly
spreads across a genuinely wider footprint rather than the tight cluster
in the last screenshot, whether the manual Kampung Lokbuno jeep renders
where the operator expects, and whether 6km as a distance ceiling starts
producing sites that read as "too far from the outage to plausibly be
responding to it" once seen against a real run rather than synthetic test
coordinates. Fixed and tested at the data/geometry level only.

Next: watch a live run and check specifically (a) does the dense Kampung
Lokob pocket now show visibly separated jeeps rather than a stack, (b)
does the Kampung Lokbuno manual target render as its own distinct jeep
icon, (c) does 6km ever produce a jeep that reads as implausibly distant
from its outage on the actual map — if so, `MAX_SITE_DISTANCE_KM` may need
a middle value between 3.5 and 6, or `MIN_SITE_SEPARATION_KM`'s own value
(still 3km, unchanged this round) may need revisiting alongside it rather
than treating distance ceiling as the only knob.

## 2026-09-16T10:08:53Z — Tiered distance search to stop cross-pocket survivor competition (operator-directed, same-session regression)

The 3.5km -> 6km widening from immediately prior in this same round
introduced a real regression, caught by the operator within the same
session rather than a later one: a screenshot of a DIFFERENT pocket
(Likas/Luyang/Lido/Minintod, 4 OFFLINE markers) showed only 1 jeep total
where it previously had several. Root cause, found by re-reading
`assignClusterSites` rather than guessing: the function builds ONE flat
list of every (request, survivor) pair across ALL pockets combined, sorted
globally by distance, and claims survivors greedily in that single sorted
order. Raising `MAX_SITE_DISTANCE_KM` to 6km did fix the dense Kampung
Lokob pocket's bunching (more real survivors became eligible for it), but
it ALSO let that pocket's ring-packed targets — which can swing up to
2.1km off the down tower in any direction — reach far enough to compete
for survivors that a totally separate, more sparsely-served pocket
depended on exclusively. Two pockets that were never meant to interact at
all ended up drawing from the same shared, globally-sorted survivor queue,
and the denser pocket's requests (many of them, closer on average) won
that competition, starving the other pocket down to almost nothing.

Asked the operator directly rather than guessing a third distance value:
should every pocket keep the wider 6km reach with priority given to
whichever pocket's survivors are more local (more complex, preserves
maximum reach), or should each pocket only widen its OWN search if it
specifically comes up short at the original tighter radius (simpler,
structurally prevents a well-served pocket from ever touching another
pocket's territory). Operator chose the latter.

Fix: replaced the single flat `MAX_SITE_DISTANCE_KM` constant with
`SITE_DISTANCE_TIERS_KM = [3.5, 6]`, and restructured `assignClusterSites`
to run its entire greedy-pass-plus-separation-relaxation logic ONCE PER
TIER, narrowest first, over only the requests still unsited after the
previous tier. A request satisfied at 3.5km never even enters the pair-
building step for the 6km tier — structurally, not just probabilistically,
preventing it from claiming a survivor a farther-served pocket might have
needed. Only requests that come up genuinely empty at the tight tier ever
reach into the wider one, and by then most of a dense, well-served
pocket's requests are already satisfied and out of the running. This
preserves both operator decisions from this round: dense pockets still
reach out for real spread (previous fix), and doing so can no longer come
at a distant pocket's expense (this fix).

Decisions made without the operator: kept the tier values themselves
(3.5km, 6km) unchanged rather than re-tuning them, since the reported
regression was about CROSS-POCKET competition, not about either value
being wrong in isolation — changing the tiering structure was the fix, not
the numbers.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings, no new ones). All 18 lib test files pass;
  `responsePhaseGeometry.test.mjs` now 30 (+1: a direct reproduction of the
  regression — a dense pocket with 20 close survivors ~8.9km from a sparse
  pocket whose only survivors sit ~4.5km out, within the wide tier but
  outside the tight one; asserts the sparse pocket still gets deployments
  AND that those deployments use its own nearby survivors, never ones the
  dense pocket could have reached for). Manually verified with a scratch
  script before trusting the fix that the OLD flat-ceiling global sort
  really could let a dense pocket's ring-swung targets reach into a
  distant pocket's survivor pool, rather than assuming the reported
  regression matched this specific mechanism.
- Backend: not touched.

Reviewers: none dispatched — operator-directed, screenshot-and-Q&A-scoped
as every entry in this file has been; this is now the third consecutive
correction within one continuous session on the same COW-siting logic,
each one caught by the operator actually watching a live run rather than
by review — underscores this file's own recurring "what is still NOT
verified in a browser" caveat: every fix in this whole thread has been
validated at the data/geometry/unit-test level only, and each of the last
three rounds shipped a real, user-visible defect that unit tests alone did
not catch because the tests were written to confirm the INTENDED behaviour
of each fix, not to hunt for what a DIFFERENT, distant pocket might
observe as a side effect.

Blocked: nothing external.

**What is still NOT verified in a browser**: same standing gap, now
flagged a third time in a row — whether the Likas/Luyang/Lido pocket's
jeeps are actually restored, whether Kampung Lokob's spread is still good
now that its reach is tier-gated rather than flat, and whether the tiered
structure introduces its OWN new failure mode not yet imagined (e.g. a
pocket satisfied in the tight tier by a barely-adequate but poorly-spread
set of survivors, when the wide tier might have offered a better-spread
set it will now never see). Fixed and tested at the data/geometry level
only.

Next: watch a live run and check ALL THREE pockets from this round's
screenshots simultaneously in one run — Kampung Lokob (spread), Kampung
Lokbuno (manual target), and Likas/Luyang/Lido (restored) — since fixing
one in isolation has twice now silently affected another. If any pocket
still looks wrong, get exact coordinates or a fresh screenshot before
proposing another parameter change; three single-parameter changes in one
session (widen ceiling, add manual target, add tiering) is a signal this
module needs a slower, more structural look rather than continued
reactive tuning.

## 2026-09-16T10:15:39Z — Reverted widening/tiering/manual-target; back to known-good flat 3.5km ceiling (operator-directed)

The tiering fix from immediately prior did NOT restore the
Likas/Luyang/Lido/Minintod pocket — a fresh screenshot showed it still at
zero jeeps, meaning either the diagnosis (cross-pocket survivor
competition) was wrong, or a second, still-unidentified cause exists
alongside it. Per this file's own "Next" note from the previous entry,
asked the operator directly rather than attempting a fourth
single-parameter change. Operator asked for a full revert to the state
immediately before the 6km-widening round — nothing from this session was
actually committed (`git status`/`git log` confirmed HEAD is still
`e18ec7f`, unchanged since before any of tonight's COW-siting work), so
this reverted uncommitted working-tree changes, not a git history
operation.

Reverted, precisely:
- `MAX_SITE_DISTANCE_KM` restored to a single flat `3.5` (was the
  `SITE_DISTANCE_TIERS_KM = [3.5, 6]` two-tier structure).
- `assignClusterSites` restored to its single-pass form (one greedy
  distance-sorted matching pass, MIN_SITE_SEPARATION_KM's progressive
  relaxation within that one pass) — the tiered outer loop from the prior
  entry removed.
- The manual `MANUAL_COW_TARGETS` / Kampung Lokbuno feature removed
  entirely: `src/frontend/src/lib/manualCowTargets.ts` deleted, its import
  and splice-in loop removed from `SimulationMap.tsx` (along with the now-
  unused `haversineKm` import that loop needed), and `MANUAL_COW_TARGETS
  .length` removed from `SimulationConsole.tsx`'s `cowClusterCount`. This
  was the operator's own scoping of the revert point — "4 messages before"
  the bunching report lands before the manual-target work was added.
- Two tests removed from `responsePhaseGeometry.test.mjs` that specifically
  exercised the reverted widened-reach and tiering behaviours (28 tests
  remain, matching the count from immediately before the widening round).

Explicitly KEPT, per the operator's own scoping — none of these were
implicated in either regression and remain in place: bearing-sector spread
for retune-neighbour selection (`selectRetuningNeighbors`), ring-packing
(`ringPositions`, `sitesPerDownTower`, `RING_TARGET_DEDUPE_KM`),
`spreadOrder`'s bit-reversal ordering for trimmed rings,
`MAX_TOTAL_DEPLOYMENTS = 24` with round-robin trimming, and the "never
fabricate a fallback position, drop the request instead" fix (the one that
stopped a jeep from being parked on open water).

Decisions made without the operator: none — this was a direct, scoped
revert instruction, not a fix requiring judgement calls.

Validation:
- Frontend: `npm run build` pass (no dangling imports from the deleted
  `manualCowTargets.ts` file), `npm run lint` pass (back to the standard 4
  pre-existing warnings, the earlier `only-export-components` warning from
  the manual-target export also gone now that file no longer exists). All
  18 lib test files pass; `responsePhaseGeometry.test.mjs` back to 28
  (removed the 2 tests for reverted behaviour, no others touched).
- Backend: not touched.
- Confirmed via `git status`/`git log` before reverting that nothing from
  this session was committed, so this was a working-tree edit reverting
  working-tree edits — no git history operation, no risk of discarding
  committed work.

Reviewers: none dispatched — operator-directed revert, screenshot-and-
direct-instruction-scoped as every entry in this file has been.

Blocked: nothing external.

**What is still NOT verified in a browser**: whether this revert actually
restores jeeps to the Likas/Luyang/Lido pocket is UNCONFIRMED — the
operator's instruction was to revert to a specific prior state based on
their own screenshot history, not a report that this exact code (flat
3.5km, no tiering, no manual target) was independently re-verified working
in a fresh run. If the pocket is STILL empty after this revert, the
6km-widening/tiering changes were not actually the cause of that specific
regression, and the real mechanism remains unfound — worth flagging
directly rather than assuming the revert closes this out.

Next: watch a live run and confirm the Likas/Luyang/Lido pocket actually
has jeeps again. If it does not, stop tuning distance/separation constants
in this module for this session — three single-parameter changes already
failed to fix it or introduced a new regression, and continuing to
guess-and-check the same greedy-matching function is not converging. A
different approach is warranted: either request the exact coordinates of
the down towers and nearby survivors in that specific pocket to compute
the real distances by hand rather than assuming synthetic test geometry
generalises, or step back to whether `clusterDownTowers`'s coarse-cluster
boundary itself is including/excluding the wrong towers for this pocket
(a labelling bug, not a distance-tuning bug) before touching
`assignClusterSites` again.

## 2026-09-16T10:23:47Z — Diagnosed against the live backend; starved-pocket fallback radius (operator-directed, root cause finally confirmed)

The revert did NOT fix it — the operator's next screenshot showed the
Likas/Luyang/Lido/Minintod pocket still with zero COW deployments (four
OFFLINE markers, blue mechanism-retune coverage but no purple COW circles,
no jeep icons). This confirmed the previous entry's own stated risk: the
6km-widening/tiering changes were never actually the cause of this
specific regression, and the real mechanism was still unfound.

Stopped guessing at parameters entirely this round and instead pulled a
general-purpose agent to query the LIVE backend directly —
`curl http://127.0.0.1:8000/towers` (port 8000, not port 8001 as
CLAUDE.md's documented convention states; worth a separate look some
other time, not chased down this round) — rather than continuing to
reason from synthetic test coordinates that had already misled three
prior "fixes" in this same session. Filtered to the 62 live Sabah towers,
applied the scenario's actual `FULL_EXTENT` polygon filter and
`MAX_DOWN_TOWERS=12` flood-share ranking from `sabahFlood.ts` by hand, and
computed real haversine distances between the resulting down towers and
whatever real towers were left as survivors.

**Root cause, finally confirmed against real data**: the scenario's own
top-12-by-flood-share selection sweeps up EVERY real tower in the
Likas/Luyang/Lido immediate area as a DOWN tower — 7 of the 8 towers
physically located there. Exactly ONE real tower (`MY_N10179178545`)
survives nearby, and it sits 4.35-7.69km from every one of those 7 down
towers — genuinely outside any flat ceiling under ~8km, including both the
original 3.5km AND the previously-tried-and-reverted 6km. This is not
solvable by adjusting one number within the existing flat-ceiling
structure; a pocket can be legitimately starved to the point that its
single remaining option sits well outside a "reasonable" search radius,
and no single flat value serves both this pocket and Kampung Lokob's
17-towers-in-700m density without either starving one or letting the
other's reach cause cross-pocket competition (the previous entry's
regression).

Verified the operator's preferred fix (targeted widening, only for
genuinely starved requests) directly against these real numbers before
implementing anything: 8km clears the 4.35-7.69km gap with a small margin
without reopening the original 8-10km "COW parked implausibly far" bug.

Fix (`responsePhaseGeometry.ts`): added `STARVED_POCKET_DISTANCE_KM = 8`
and a second pass in `assignClusterSites`, run AFTER the normal 3.5km pass
completes. A request only enters this fallback pass if it had literally
ZERO candidate survivors within `MAX_SITE_DISTANCE_KM` in the first pass —
tracked via `hadNormalCandidate`, built directly from the `pairs` list
rather than inferred from whether a request ended up unsited (a request
that HAD nearby options but lost the `MIN_SITE_SEPARATION_KM` spacing
competition to a well-served neighbour does NOT escalate; only genuine
"nothing was close enough to even compete" triggers the wider search).
This is the structural difference from the reverted 6km-flat and
tiered-both-directions attempts: it is a ONE-WAY, PER-REQUEST rescue for
confirmed-starved requests only, so an already-well-served pocket
(Kampung Lokob) can never even reach this code path, let alone compete at
this radius for survivors a starved pocket needs. The fallback pass runs
the same `MIN_SITE_SEPARATION_KM` progressive relaxation internally, so a
starved pocket's own several ring positions still try to spread from each
other rather than collapsing onto the single rescued survivor.

Verified directly against the real coordinates BEFORE trusting the fix:
ran `clusterDownTowers` with the actual 7 down-tower coordinates and the
actual remaining-survivor coordinate from the live backend query, in a
scratch script, and confirmed `MY_N10179178545` is now used as a real
site for the pocket. This is the first fix in this entire session's
back-and-forth verified against live data before being called done, rather
than against synthetic test geometry alone.

Decisions made without the operator: `STARVED_POCKET_DISTANCE_KM`'s exact
value (8km) — derived directly from the measured 4.35-7.69km gap with
margin, not guessed; the "zero candidates only, not lost-competition"
distinction for what counts as starved — the natural reading of "rescue
requests with nothing to compete for," and the alternative (rescuing any
unsited request) would have reopened exactly the cross-pocket-competition
regression from two entries ago.

Validation:
- Frontend: `npm run build` pass, `npm run lint` pass (same 4 pre-existing
  warnings, no new ones). All 18 lib test files pass;
  `responsePhaseGeometry.test.mjs` now 29 (+1 net: one test updated — the
  old "8.8km survivor rejected" case now correctly gets rescued by the new
  fallback since a ring position can close ~2.1km of that gap, so the test
  was changed to use ~15-16km, confirmed genuinely unreachable even with
  ring adjustment; +1 new: a direct reproduction of the live regression
  using the REAL verified coordinates for both the 7 down towers and the
  lone surviving tower, asserting that survivor is actually used as a
  site).
- Backend: not touched (queried only, via its existing `/towers` route).
- The live-backend query and the verification script are the load-bearing
  checks this round — confirmed the diagnosis against real data BEFORE
  writing the fix, and confirmed the fix against the same real data AFTER
  writing it, rather than relying on synthetic test geometry as every
  prior entry in this multi-round thread did.

Reviewers: none dispatched — operator-directed, but this round's
methodology changed: a general-purpose agent was used to gather live
ground truth (backend query, real coordinates, real distances) rather than
relying on synthetic test geometry or further screenshot-driven guessing.

Blocked: nothing external.

**What is still NOT verified in a browser**: whether the Likas/Luyang/Lido
pocket now genuinely shows a jeep in an actual running simulation, and
whether STARVED_POCKET_DISTANCE_KM's 8km reads as "plausible response" or
"too far" once seen on the real map rather than confirmed only via a
scratch script's cluster output. This round's fix IS verified against real
data at the geometry/matching level, which is a meaningfully stronger
check than every prior entry in this thread, but the actual browser
render — icon placement, whether the coverage circle visually reads as
connected to its outage from that far, the specific pixel result the
operator will see — has still not been watched directly.

Next: watch a live run and confirm (a) the Likas/Luyang/Lido pocket now
shows a jeep, sited near `MY_N10179178545` given the deployed algorithm,
(b) whether an ~8km-distant jeep's coverage circle reads as plausible on
screen or as another "jeep too far from its outage" complaint — if the
latter, the fix is directionally right (a starved pocket needs SOME
rescue) but 8km itself may need to come down, traded against how much of
this specific gap it can still close, (c) confirm the OTHER pockets from
this session (Kampung Lokob, Kampung Lokbuno-area) are unaffected, since
the starved-pocket pass is designed to never touch a well-served pocket's
survivors but this is the first time it has been exercised against a full
live scenario rather than an isolated scratch check.


## 2026-09-17T00:17:42Z — C1: COW siting freed from survivor towers, land-witness rule (operator review, 8-cycle plan)

Operator (acting as MCMC domain reviewer) reviewed a running simulation
screenshot and reported the strategy, not the mechanism, was wrong: COW
jeeps must cover the RED coverage-gap circle's full radius, not just reach
the nearest tower, and jeeps must diverge — never park close enough to
overlap. Same review flagged five more gaps (generators invisible, no
work-order alert card, single-tower generator dispatch, dispatch origin
inside the flood polygon, flood never recedes). This entry covers the
first of an 8-cycle plan; the rest follow in later entries.

**Root cause.** Every version of `assignClusterSites`
(`responsePhaseGeometry.ts`) back to 2026-09-16 sited a COW AT a nearby
SURVIVING tower's own coordinates (plus a small nudge) — never at the
ring-packed target computed to cover the gap. `ringPositions` already
ring-packed up to 8 candidate positions per down tower; the siting step
then discarded almost all of them because most ring positions have no
survivor tower sitting exactly there. That is the visual bunching the
operator's screenshot showed: deployment pattern followed the existing
tower layout, not the shape of the outage.

**Fix.** `assignClusterSites` rewritten: a site is now the ring target
ITSELF, accepted only when three rules hold — (1) LAND WITNESS: some real
tower (down or surviving) sits within `LAND_WITNESS_RADIUS_KM` (2.5km),
standing in for the coastline/land-use layer this project does not have
in `lib/`; (2) CONTAINMENT: the site sits within `MAX_SITE_DISTANCE_KM`
(now `COVERAGE_GAP_RADIUS_KM`, 3.5km exactly — literally "inside the red
circle") of a down tower it covers for; (3) SEPARATION: no already-
accepted site sits closer than `MIN_SITE_SEPARATION_KM`. A target failing
any rule is dropped, never relocated to a fabricated fallback (that
discipline is inherited from the survivor-pinned version and is the one
piece of prior history worth keeping — a fabricated fallback shipped a
jeep on open water once, 2026-09-16). Sites now carry synthetic `cow-<n>`
ids rather than borrowing a tower's, closing the 2026-09-16 bug where two
pockets resolving to the same survivor silently collapsed into one jeep.

**A real conflict surfaced while tuning the separation constant.** The
naive choice (`1.6 x COW_COVERAGE_RADIUS_KM` = 2.24km, "circles should
overlap slightly") REJECTED the ring's own points against each other: at
the shipped constants (gap radius 3.5, COW radius 1.4, 7 ring points) the
centre-to-ring distance is 2.1km and the chord between adjacent ring
points is only 1.82km — both below 2.24km. Measured: this collapsed an
isolated down tower's full 8-site ring down to 1 (only the centre
survived). `MIN_SITE_SEPARATION_KM` set to `1.2 x COW_COVERAGE_RADIUS_KM`
(1.68km) instead — below both figures, so a single tower's full ring
survives and only genuinely redundant pairs (from different down towers'
rings landing close together) are rejected. Caught by the test suite, not
inspection — worth recording because the "obviously safe" value was wrong.

**A second real bug found the same way.** `ringPositions`'s "centre"
position was literally `downTower`'s own coordinates — harmless under the
old model (site was always relocated onto a nearby survivor with a nudge)
but, once sites became ring targets themselves, this parked a COW icon
EXACTLY on the flooded compound it was covering for. Fixed with a small
`CENTRE_NUDGE_KM` (0.3km, due north) so the centre deployment never
equals the down tower's own point — the same principle the module's own
history already argued for down towers generally ("a down tower's site is
frequently the least reachable point in the area... parking a vehicle
exactly there contradicts the reason that site is down").

**Test rework.** Several tests in `responsePhaseGeometry.test.mjs` asserted
survivor-pinned behaviour that no longer applies — "sites every deployment
near a SURVIVING tower, never a down tower" (sites are now ring targets,
witnessed by either), "nudges a resolved site... not zero and not far"
(nudge off a survivor no longer happens), "rescues a starved pocket via
the wider fallback radius" (that fallback tier no longer exists — replaced
with a test proving a down tower alone can witness), "gives distinct
pockets DISTINCT sites" (rewritten to check hard separation rather than
id inequality, since ids are now synthetic and trivially distinct). 29/29
pass after rework; `haversineKm` imported into the test file (aliased
`haversineTestKm`) since assertions now need real distances rather than
raw lon/lat deltas.

**Visual verification (this round's methodology change).** Backend
(`uvicorn`, port 8001) and frontend (`vite`, discovered on port 5176 after
5173-5175 were already held by earlier same-session launches) launched
live, driven with Playwright (chromium, headless) against
`http://localhost:5176/simulation` — clicked Play, set 4x speed, waited
real wall-clock time (cow beat fires at simMs 62000 -> ~15.5s at 4x),
screenshotted. This is the first round in this thread verified by
actually looking at a rendered frame rather than a scratch script's
console output alone.

Two environment traps hit while setting this up, worth recording since
neither is specific to this fix: (1) Vite's dev server bound `[::1]`
only — `curl`/`Invoke-WebRequest` against `127.0.0.1` failed with no
error explaining why, `localhost` worked; this is the same class of
IPv4/IPv6 mismatch CLAUDE.md documents for uvicorn, now hit on Vite's own
dev server instead of the API. (2) A screenshot path written as
`/tmp/sim_shots/...` from a `node.exe` process launched via PowerShell
`Start-Process` silently resolved to `C:\tmp\sim_shots\...` — a real
Windows path, just not the one intended — rather than throwing; the
script's own success log ("saved ...") was therefore not proof the file
existed at the expected path. Both wasted real time before being caught;
neither was validated by re-reading the file at the path the log claimed.

**Result, seen live:** the response-phase screenshot shows jeeps spread
across and inside the red/pink coverage-gap circles at multiple points
per pocket rather than bunched at one survivor, console line reads "21
temporary base station(s) deployed." The same run's recovery-phase
screenshot (T+48h, 100% complete) also confirms C7's bug directly: flood
extent is still the full polygon at the very end of the timeline — logged
here as corroboration, fixed in its own cycle below.

Backend/frontend touched: none (frontend `lib/` only).
Tests: `node --test` on all 18 `src/lib/*.test.mjs` files, 190/190 pass.
`npm run build` clean, `npm run lint` clean (pre-existing warnings only,
none introduced).

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot per operator's explicit instruction to open the app and look.

Next: C2 (retune-first gate — COW count should respond to residual gap
after sector-retune, not fire as an unconditional fixed ring).

## 2026-09-17T00:23:30Z — C2: retune-first gate on COW ring-packing (operator review, 8-cycle plan, cycle 2/8)

The `cow` beat's console line has always read "neighbour-cell retune
insufficient for terrain" — narration asserting a causal relationship
between the 'antenna-retune' beat and the COW deployment count that did
not actually exist in code: `clusterDownTowers` ring-packed a fixed number
of COW sites per down tower regardless of whether a sector cone was
already reaching that side of the gap circle.

**Fix.** `ringPositions` now accepts the list of neighbours already
retuning toward a given down tower (`retunedNeighbors`) and drops any ring
position within half a retune sector's width (`RETUNE_SECTOR_WIDTH_DEG /
2` either side) of a retuned bearing — a jeep is not sent where a cone is
already pointed. `clusterDownTowers` computes this internally by calling
the existing `assignRetuningNeighbors` before ring-packing, rather than
accepting it as a parameter — kept as an invariant of the function so no
caller can silently skip the gate, matching how `assignClusterSites`'s own
acceptance rules already live inside this module's call graph rather than
being left to callers. The centre ring position is exempt from the gate:
a cone reaching one side of the gap circle does not cover the down
tower's own compound.

This is a bearing-only approximation (a bucket check against
`RETUNE_SECTOR_WIDTH_DEG`), not a true cone/circle polygon intersection —
stated in the new `retunedBearings`/`isRetuneCovered` doc comments as the
same class of honest simplification `NEIGHBOR_SEARCH_RADIUS_KM` already
makes for "which neighbour retunes at all." Precise RF coverage
prediction is out of scope for an illustrative layer; a defensible
per-sector gate is in scope, and shipping the cone visual with no
downstream effect on the COW count was the actual problem — the console
line claimed a relationship the code did not compute.

**A real coupling surfaced while writing this**: `clusterDownTowers`'s
`candidates` parameter already served two jobs (land witness for
`assignClusterSites`, dispatch-site pool) and now serves a third (retune-
neighbour pool for the new gate) — in the live app these are genuinely the
SAME tower population, so this is not duplicated modelling, but it broke
two existing tests that used a dense ring of "survivors" purely to probe
ring-packing in isolation: `assignRetuningNeighbors` now legitimately
claims most of those same towers as retuning neighbours, gating the ring
down to 3 sites instead of the expected 8. Diagnosed as the gate correctly
firing, not a bug, and confirmed by checking the fixture's own geometry
(all 30 witnesses sat within `NEIGHBOR_SEARCH_RADIUS_KM`, so all 3 retune
sectors filled). Both tests rewritten to mark the nearby towers as DOWN
(so they still witness ring targets via `LAND_WITNESS_RADIUS_KM`'s
down-tower clause but contribute zero retune coverage), isolating "ring-
packing alone" from "retune interference" the way the tests originally
intended. A third test added specifically pinning the gate itself: the
SAME dense ring of towers requests fewer COW sites when they are surviving
(retune-eligible) than when they are down (not retune-eligible) — this is
the regression guard that would have caught the gate silently doing
nothing.

**Console line wiring:** `SimulationConsole.tsx`'s `cowClusterCount`
already called the same `clusterDownTowers` the map uses, so the "<n>
temporary base station(s) deployed" figure reflects the gated count with
no separate change needed — verified live (below), count differs run to
run based on retune coverage.

Tests: `node --test` on `responsePhaseGeometry.test.mjs`, 30/30 pass (2
rewritten, 1 added). Full `src/lib/*.test.mjs` sweep, 18 files, all pass.
`npm run build` clean. `npm run lint` clean (same 4 pre-existing warnings,
none introduced).

**Visual verification.** Same live backend (port 8001) + frontend (Vite
picked up the change via HMR, still serving `localhost:5176`) from C1's
round, re-driven with Playwright to the response phase (T+6h, 4x speed,
~17s wall). Console line now reads "20 temporary base station(s)
deployed" against C1's screenshot's "21" on the same scenario — the count
moved because the gate removed one ring position a retuned cone already
reached. The effect is small on this dataset (most sector-cone/ring-target
overlaps are narrow at these radii), which is expected — this is a
bearing-bucket gate, not a large-coverage RF model — but the mechanism is
confirmed live, not just in the unit test.

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot, same as C1.

Next: C3 (generator layer — `generator.png` exists in
`public/brand/` and is completely unused; the 'generators' beat at T-24h
has no map effect at all).

## 2026-09-17T00:31:17Z — C3: generator pre-position layer, real site count (operator review, 8-cycle plan, cycle 3/8)

`public/brand/generator.png` existed with zero references anywhere in the
codebase. The 'generators' beat (T-24h) has always had a console line
("Portable generators pre-positioned at <n> flood-prone sites") but no map
effect at all, and its `<n>` silently borrowed `downTowerCount` — the
number of towers the FLOOD later takes down, an unrelated quantity that
happened to equal the intended generator-site count (12) only because both
constants were independently set to 12 on this one scenario.

**Fix.** `fixtures/scenarios/sabahFlood.ts` gains
`generatorSiteSelector` on the `Scenario` interface, alongside
`downTowerSelector` — same shape (a function over the live population,
never a hardcoded id list, per that file's own module doc comment on why).
`selectGeneratorSites` ranks ALL Sabah towers by `attribution.flood` share
(the same field `selectDownTowers` uses) and takes the top
`MAX_GENERATOR_SITES` (12, the operator's own figure) — but deliberately
NOT bounded to `FULL_EXTENT` the way `selectDownTowers` is, and deliberately
a DIFFERENT set from the down towers: real pre-positioning is a standing-
risk decision made ahead of an event, before any specific flood polygon
exists to check containment against, so ranking by the scenario's flood
polygon (which the 'generators' beat's own timestamp precedes) would be
backwards. `useSimulation.ts` gains a `generatorSiteIds` store field set
at `start()` alongside `downTowerIds` (and cleared at `resetSim()`), same
lifecycle, same non-persistence rationale (never sent to the backend,
never in localStorage).

**Map layer.** `SimulationMap.tsx` gains a `sim-generator-sites` GeoJSON
source and symbol layer using `generator.png` (18px, matching the COW
icon's own load-then-addLayer pattern so a slow/missing asset degrades to
"no glyph" rather than failing the whole map). Visible from the
'generators' beat's own `atMs` (19000) onward and — deliberately — NEVER
retracted for the rest of the run, unlike COWs which withdraw at the
`withdraw` beat: a pre-positioned generator is standing plant, and this
scenario has no beat narrating its removal, so an invented withdrawal
would be less honest than leaving the marker up. `SimulationLegend.tsx`
gains a "Generator pre-positioned" entry (evidence: illustrative, same
reasoning as the COW/cone entries — pre-positioning specifically, as
opposed to reactive dispatch, has no built mechanism per
`docs/Disaster_Response_Actions.md`).

**Console line fixed to use the real count.** `simulationConsoleLine.ts`'s
context gains `generatorSiteCount` (replacing the now-fully-removed
`downTowerCount`, which had no other caller once this was fixed — TypeScript
confirmed the removal was clean, not just unused-but-harmless). The
'generators' case now reads `generatorSiteCount` instead of borrowing the
down-tower figure; `SimulationConsole.tsx` computes it as
`generatorSiteIds.size`, mirroring how `cowClusterCount` already derives
from live state rather than a hardcoded number.

Tests: `simulationConsoleLine.test.mjs`'s `noContext` fixture and the
'generators' test updated to the new field name and to assert against 12
(the real generator-site count) rather than 3 (an arbitrary down-tower
count that happened to share the placeholder). 9/9 pass. Full
`src/lib/*.test.mjs` sweep, 18 files, all pass — no other file referenced
`downTowerCount`. `npm run build` clean (a stray reference would have been
a compile error, not a silent runtime gap, since the field was removed
from the shared interface). `npm run lint` clean, same 4 pre-existing
warnings (line numbers shifted only).

**Visual verification.** Same live backend/frontend as C1/C2, driven to
the pre-event window (~20s at default 1x speed — the 'generators' beat
fires at simMs 19000, well before any COW/retune logic needs 4x). Screenshot
shows: console line reading "Portable generators pre-positioned at 12
flood-prone sites" (the real selector count, not a coincidence); a
generator glyph visible on the map near Karamunsing/Damai; the new legend
entry present with its own swatch and ILLUSTRATIVE badge. One retry was
needed — the first driver-script attempt died silently with no error
after ~40s of real time (screenshot never written), diagnosed as resource
pressure from a pile of orphaned chrome/chrome-headless-shell processes
left over from C1/C2's earlier failed attempts (documented there); killing
those first and rerunning the identical script succeeded immediately —
recorded because it is a recurring cost of this round's screenshot-driven
verification method, not specific to this cycle's code change.

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot.

Next: C4 (work-order alert card — the 'optimize' beat's "49 work orders"
currently renders as console text only; no pop-out notification card
exists for it).

## 2026-09-17T00:34:38Z — C4: work-order alert card (operator review, 8-cycle plan, cycle 4/8)

The 'optimize' beat is the run's one genuinely `evidence: 'real'` pre-event
beat — a real `/schedule/optimize` call, prefetched at Start per spec §7 —
but its only on-screen presence was a single line in the scrolling console
transcript. The operator's ask was explicit: 49 work orders and a real
optimizer dispatch is worth a notification a viewer's eye actually lands
on, not a line among many that has usually scrolled past by the time
later beats fire.

**Fix.** New `components/simulation/WorkOrderAlert.tsx`, a dismissible
card floated over the map (`.glass-float`, top-left, `absolute` inside the
now-`relative` map container in `pages/Simulation.tsx`). It renders
strictly from the SAME `optimizeRun` state `SimulationConsole` already
reads — `optimizeRun.entries.length` work orders, `new
Set(entries.map(e => e.crew_id)).size` crews — never a separate or
narrated number, matching the beat's own `evidence: 'real'`
classification. Appears once `optimizeStatus === 'ready'`; stays until
dismissed (X button) or a new run starts, tracked by comparing the
dismissal's captured `runSeq` against the current one, so pausing and
resuming mid-run does not resurrect a card the viewer already closed, but
a genuine new run (Start after Reset, or a 'done'-to-'running' replay)
shows it again. No auto-dismiss timer — a planner-facing alert about
route commitments is exactly the kind of thing that must not disappear
before it is read, the same reasoning `SimulationBanner` gives for never
being a toast at all.

Deliberately minimal: no separate "Dismiss" button beyond the corner X
(an earlier draft had both — redundant chrome for a two-line card, cut
before commit). Uses the existing `.glass-float` CSS class (the class
CLAUDE.md's blur-budget section already reserves for exactly this: "a
floating module over the map") rather than inventing new styling, and
`text-eyebrow`/`text-micro`/`text-ui` from the established type scale — no
arbitrary pixel sizes introduced.

No backend or `lib/` changes this cycle — pure presentational component,
no test file (matches the pattern of `SimulationBanner`/`SimulationLegend`,
neither of which has one either).

`npm run build` clean. `npm run lint` clean, same 4 pre-existing warnings
(line numbers shifted only). Full `src/lib/*.test.mjs` sweep not re-run
this cycle (nothing under `lib/` touched); `responsePhaseGeometry.test.mjs`
and `simulationConsoleLine.test.mjs` from the prior two cycles remain
green and were not re-verified separately since no code they cover changed.

**Visual verification.** Same live backend/frontend as C1-C3, driven to
~14s wall time (the 'optimize' beat's own `atMs` is 9000, plus real
backend round-trip). Screenshot shows the card exactly as designed:
"ABNORMALITIES DETECTED — 49 work orders raised, dispatching 14 crews —
Live optimizer output — POST /schedule/optimize", console's own line
underneath reading the identical "49 work orders across 14 crews" (same
`optimizeRun`, so the two can never disagree), positioned without
covering the flood/tower/generator layer beneath it.

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot.

Next: C5 (multi-tower generator dispatch — the 'generator-dispatch' beat
currently commits `/schedule/emergency` against exactly one down tower,
`[...downTowerIds][0]`, when the operator's ask was to dispatch to other
offline towers too).

## 2026-09-17T00:42:04Z — C5: multi-tower generator dispatch (operator review, 8-cycle plan, cycle 5/8)

`generator-dispatch` committed exactly one real `/schedule/emergency` call,
against `[...downTowerIds][0]` — the first down tower in scenario order,
however many were actually down. The operator's ask: a real flood knocks
out multiple sites, and "generator dispatch" should reach every offline
tower it can, not one.

**Fix.** `useSimulationBackendBeats.ts`'s emergency effect now loops over
EVERY tower in `downTowerIds` (`for...of`, sequential `await`, never
`Promise.all`), committing each `/schedule/emergency` call against the
SAME `run_id` throughout. This is safe and semantically correct because of
how the backend route already behaves — read before relying on it:
`api/routes/schedule.py::emergency_dispatch` with `commit=True` mutates
and persists the stored run in place (`run.pins = [p for p in run.pins if
p.tower_id != req.tower_id] + [new_pin]`, i.e. re-pins only the requested
tower and keeps every earlier pin), so each subsequent call in the loop
resolves against the PREVIOUS call's already-committed state. The single
FINAL `ScheduleRun` therefore ends up holding one 'emergency'-reason pin
per dispatched tower, so no array of separate results needs to be threaded
through the store or any consumer — `emergencyRun` keeps its existing
`ScheduleRun | null` shape. `firedRunSeq` is checked before EVERY iteration
of the loop, not just once at the end, so a Reset mid-fan-out stops
issuing further real commits against an abandoned run rather than
continuing silently.

**Every consumer updated from "the one entry" to "every matching entry".**
`SimulationMap.tsx`'s crew-route effect used `.find((e) => e.pin_reason ===
'emergency')` and drew one bowed line with one travelling token via
imperative `Marker` objects; now `.filter(...)` and one line/token PAIR per
matched entry, with `crewAnimRef` changed from a single `{stop}` to an
array so every route's animation can be torn down independently.
`simulationConsoleLine.ts`'s `generator-dispatch` case previously read the
scenario's raw down-tower id (`<tower_id>` in the beat's own console
string) — replaced with a count of `emergencyRun.entries.filter(pin_reason
=== 'emergency').length`, and the beat's `console` string in
`simulationTimeline.ts` changed from `"generator dispatch -> <tower_id>"`
to `"generator dispatch -> <n> offline sites"`, since naming one tower
would now misreport what the underlying commit actually did.

**A real type bug caught by the build, not by eye.** The initial rewrite
typed each route's `from` as `{ lon: number; lat: number }`, but
`Crew['depot']` is `{ lon: number; lat: number; name: string }` — a
narrower filter type predicate than the mapped value it filters is a
TypeScript error (`TS2677`), not a silent runtime issue, and `tsc -b`
caught it immediately. Fixed by declaring an explicit `Route` type alias
matching the real shape and typing the `.map` callback's return against
it, rather than hand-rolling an inline object type that happened to omit
a field.

Tests: added two to `simulationConsoleLine.test.mjs` — one pinning that
the 'generator-dispatch' beat counts every 'emergency'-reason entry (2 of
3, with one ordinary maintain-band entry mixed in to prove the filter
excludes it) rather than any single tower id; one pinning the beat still
shows raw placeholder text before `emergencyRun` resolves, matching the
existing pattern for every other backend-fed beat. 11/11 pass.
`simulationTimeline.test.mjs` re-run (no hardcoded copy dependency on the
old string, still 14/14). Full `src/lib/*.test.mjs` sweep, 18 files, all
pass. `npm run build`: caught the `Route` type error above on first
attempt, clean after the fix. `npm run lint` clean, same 4 pre-existing
warnings (line numbers shifted only).

**Visual verification.** Same live backend/frontend as C1-C4, driven to
completion (30s at 4x = full 96s scenario) — screenshot shows SEVERAL
purple dashed crew-route lines fanning from one depot area to multiple
distinct down towers across the flood polygon, where every prior round's
screenshot (C1-C4) showed at most one such line. This is the direct,
visible proof the fan-out reached the real backend and committed multiple
towers, not just that the loop compiles. A second, more precisely-timed
attempt (aiming to catch the console's own "-> N offline sites" line
before it scrolled off, rather than the run's finished state) failed
twice with the SAME silent-death symptom recorded in C1's log entry
(driver process exits with no error, no screenshot, after ~40s) —
diagnosed there as resource pressure from orphaned browser processes, but
this time recurred even after cleanup, so the cause may be broader than
that single explanation. Not chased further this cycle: the completed-run
screenshot already gives strong, direct visual evidence the mechanism
works, and the flakiness is a cost of this round's screenshot-driven
verification method rather than a property of the code changed.

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot.

Next: C6 (staging point outside flood — the emergency crew route
currently originates from Sabah's power-crew depot regardless of whether
that depot sits inside the flood polygon).

## 2026-09-17T00:47:24Z — C6: staging point outside flood extent (operator review, 8-cycle plan, cycle 6/8)

The operator's ask: "the centralise send off point shouldn't be at the
flood places." Verified before fixing, not assumed: `config/crews.json`'s
Sabah power-crew depot (`SBH-P1`, Kota Kinabalu, 116.073/5.980) sits
INSIDE `FULL_EXTENT`, this scenario's own flood polygon — confirmed by
running the actual point-in-polygon check against the real coordinates,
not eyeballing the map. Both dispatch-origin call sites used this depot
unconditionally: the COW deployment effect's `from` (with a hardcoded
fallback literal, `{ lon: 116.073, lat: 5.98 }`, that is the SAME flooded
point, just spelled out again rather than referencing the depot), and
C5's new multi-tower crew-route effect's `from: crew.depot`. Every
dispatch animation in the app was drawn originating from a point this
scenario's own flood shading marks as underwater.

**Fix.** New `stagingPoint(depot, floodPolygon, towers, downTowerIds)` in
`SimulationMap.tsx`: returns the depot unchanged if it sits outside the
current flood extent (or if the flood polygon has not appeared yet,
`floodPolygon === null`); otherwise returns the nearest surviving
(non-down) tower that ALSO sits outside the flood extent — the same
land-witness idiom `assignClusterSites` (C1, `responsePhaseGeometry.ts`)
already uses for COW siting: a real tower's location is this project's
best available proxy for "somewhere still reachable," since there is no
road-network or elevation data to compute an actual staging point from.
Falls back to the raw depot if no dry surviving tower exists at all — an
invented position would be less honest than the depot's real, if
imperfect, coordinates. Wired into both call sites: the COW effect (using
`floodExtentAt(elapsedMs)`, since that effect only ever runs inside the
COW window, well after flood-onset) and the crew-route effect (same
function, computed once when `emergencyRun` resolves — the effect's
existing `eslint-disable-next-line` for its narrower dependency array now
carries an explicit comment explaining why `elapsedMs`/`downTowerIds`
stay out: a committed dispatch's drawn route must not silently re-origin
as the clock continues past the beat that drew it).

`pointInPolygon` exported from `fixtures/scenarios/sabahFlood.ts` (was
module-private) so `SimulationMap.tsx` could reuse the exact same
point-in-polygon test `selectDownTowers` already uses, rather than a
second implementation that could drift from it.

No `lib/` changes this cycle (pure `SimulationMap.tsx` component logic
plus one export change with no behavior change to the function itself),
so no new/changed unit tests; full `src/lib/*.test.mjs` sweep re-run
anyway as a regression check, 18 files, all pass. `npm run build` clean.
`npm run lint` clean, same 4 pre-existing warnings (line numbers shifted
only).

**Visual verification.** Same live backend/frontend as C1-C5, driven ~20s
at 4x (past both 'generator-dispatch' at 54000ms and 'cow' at 62000ms).
Screenshot shows the multi-tower crew-route lines (from C5) now clearly
entering the frame from OUTSIDE the blue flood-extent shading — visibly
originating off the flooded area's east edge and converging toward towers
inside it — where every prior round's screenshot showed routes
originating from inside the same blue polygon. COW deployments (dark
circles/jeep icons) also visible throughout, unaffected by this change's
own logic (their siting rule from C1/C2 is independent of dispatch
origin).

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot.

Next: C7 (flood recession — `floodExtents` has only two frames, SMALL then
FULL, and never recedes even though the 'restore'/'withdraw'/'ledger'
beats narrate recovery through T+48h).

## 2026-09-17T00:52:07Z — C7: flood recession after T+36h (operator review, 8-cycle plan, cycle 7/8)

`floodExtents` had exactly two frames — SMALL at flood-onset, FULL shortly
after — and never receded for the rest of a 96-second run. C1's own
verification screenshot (`recovery.png`, logged in that entry) already
caught this as corroborating evidence: the flood was still shown at FULL
extent at 100% run completion (T+48h), well past 'restore' (T+24h),
'withdraw' (T+36h, "sectors returned to nominal; reserve released") and
'ledger' (T+48h, "outcome appended"). The operator's ask was explicit:
"after T+36 the flood should drop off."

**Fix.** Two more frames added to `SABAH_FLOOD_SCENARIO.floodExtents`:
FULL_EXTENT back down to SMALL_EXTENT at the 'withdraw' beat's own `atMs`
(88000, T+36h — the operator's stated beat, not a nearby approximation),
and SMALL_EXTENT down to `null` (fully receded) at 'ledger' (96000, T+48h,
the run's closing beat). Reuses the EXISTING SMALL_EXTENT/FULL_EXTENT
polygons rather than authoring new recession-specific shapes — recedes in
reverse of onset, which is deliberate and stated in the new comment, not
just economy of effort: `SMALL_EXTENT` genuinely covers the southern,
near-shore sub-cluster while `FULL_EXTENT` additionally covers the
northern, further-inland Menggatal/Telipok group (per that constant's own
existing comment), so "north drains first, near-shore lingers longest" is
a plausible hydrological direction, not an arbitrary reversal for its own
sake.

`FloodExtentFrame.polygon` widened from `Polygon` to `Polygon | null` to
carry the fully-receded frame — documented as deliberately overloading the
SAME `null` `floodExtentAt` already returns before the first frame fires,
since both cases ("hasn't arrived yet" and "arrived, then receded") are
the same ground truth (no flood shading) at the moment either holds, so
sharing the representation is correct rather than a shortcut.

**Two cross-cycle interactions checked, not just assumed safe.** (1) C6's
new `stagingPoint` helper (previous cycle) calls
`pointInPolygon(depot.lon, depot.lat, floodPolygon)`, and `floodPolygon`
can now legitimately be `null` mid-run once recession completes — already
correctly guarded (`if (!floodPolygon || ...) return depot`), so a
receded flood correctly stops routing crews away from a now-dry depot
rather than continuing to treat it as flooded. No fix needed, but this
was checked rather than assumed, since it is exactly the kind of
cross-cycle interaction a build-log-by-cycle process can miss. (2) The
flood-extent rendering effect's ref-guard comment claimed "one of two
SHARED module-level polygon singletons" — now stale with 4 frames and a
`null` case — updated to describe the current set and note `null ===
null` still dedupes idle's `null` against a receded run's `null`
correctly.

No `lib/` changes (pure `fixtures/scenarios/sabahFlood.ts` scenario data
plus a `SimulationMap.tsx` comment fix), so no new/changed unit tests;
full `src/lib/*.test.mjs` sweep re-run as a regression check, 18 files,
all pass. `npm run build` clean (the `Polygon | null` widening would have
been a compile error anywhere it wasn't handled — it wasn't, confirming
`polygonFeatureCollection` and the ref-guard effect already handled `null`
correctly from the idle-state case). `npm run lint` clean, same 4
pre-existing warnings.

**Visual verification.** Same live backend/frontend as C1-C6, driven to
two points: ~23s at 4x (just past 'withdraw', T+36h) and ~29s at 4x (past
'ledger', T+48h). First screenshot: console reads "T+36h — Temporary base
station withdrawn," flood extent visibly shrunk to only the southern
sub-cluster near Karamunsing/Damai/Bundusan, with the northern
Menggatal/Kampung Lokbuno area now dry. Second screenshot: run at 100%
(Recovery, T+48h) with NO flood shading anywhere on the map — directly
contradicting C1's `recovery.png` from the same point in an earlier run,
which is the clearest possible before/after evidence for this fix.

Reviewers: none dispatched this cycle — self-verified via live browser
screenshot.

Next: C8 (review pass — mcmc-domain-reviewer, simulation-ux-reviewer and
simulation-integrity-tester over the full set of changes from C1-C7, then
fix findings; this closes the loop).

## 2026-09-17T01:04:12Z — C8: review pass, three agents dispatched, findings fixed (operator review, 8-cycle plan, cycle 8/8 — closes the loop)

Three specialist agents run against the full C1-C7 diff: mcmc-domain-
reviewer (domain credibility), simulation-ux-reviewer (design-system
compliance), simulation-integrity-tester (correctness/races/live
endpoints). Findings below, grouped by disposition.

**FIXED — mcmc-domain-reviewer, blockers.**

- `WorkOrderAlert.tsx` heading "Abnormalities detected" -> "Work orders
  raised". Anomaly-detection/failure-prediction vocabulary on the one card
  designed to be the highest-salience element on screen is exactly the
  section 0.6 failure mode on a different surface than usual (a UI string,
  not an endpoint name) -- this system schedules maintenance need, never a
  detected fault.

- 'cow' beat: "<n> temporary base station(s) deployed" -> "<n> temporary
  coverage footprint(s) established". The count is ring-packed SITES
  (`clusterDownTowers`), not deployable units -- it rendered as 21 (C1) and
  20 (C2) on real runs, and no Malaysian operator stages twenty mobile
  base stations in one district flood. Reworded to describe what the
  number actually is (how many points are being covered) rather than
  assert a fleet size; the map's own COW icon/legend entry keeps "temporary
  base station (COW)" for the ASSET being illustrated at each footprint --
  a real-vs-invented split of the same shape every other beat in this
  table already makes, not a new inconsistency.

- 'generator-dispatch' beat: "Emergency work order: generator dispatch ->
  <n> offline sites" -> "Emergency work orders committed -> <n> offline
  sites (crew SBH-P1)". Two problems in one line. First: `emergency_dispatch`
  resolves each tower's own dominant-factor work order
  (`_resolve_work_orders`); only a POWER-dominant tower yields
  `battery_genset_service` per `config/actions.yaml`, and this scenario
  selects its down towers by FLOOD share, so most of the <n> commits book
  `flood_*` civil work, not a genset -- naming the action "generator
  dispatch" for a run of mostly non-generator work orders is a failure
  label by another name. Second: every commit targets the SAME hardcoded
  crew (`SABAH_POWER_CREW_ID`); up to 12 emergency pins landing on one
  crew in one horizon is not a plausible parallel response and contradicts
  the real July 2024 record the scenario cites (phased restoration over
  ~2 days, not all-at-once) -- the reworded line makes that scope visible
  ("(crew SBH-P1)") instead of implying a fleet-wide response.

**ACKNOWLEDGED, not fixed this cycle -- mcmc-domain-reviewer, weaknesses.**

- COW sites can land inside the flood polygon they're covering for
  (`assignClusterSites`, `responsePhaseGeometry.ts`), while C6's
  `stagingPoint` correctly keeps dispatch ORIGINS out of it -- a real
  cross-cycle inconsistency. Not fixed: this module is deliberately
  domain-free (no flood-polygon concept), and a hard exclusion risks zero
  accepted sites for exactly the pockets that most need one, since the
  ring radius is not guaranteed to reach the flood's edge -- a regression
  worse than the one being fixed, and not verifiable against live data in
  this cycle. Documented as a known limitation in `assignClusterSites`'s
  own doc comment with the reasoning for NOT patching it blind, rather
  than silently left unrecorded.
- Generator/down-tower site overlap (both rank by the same
  `attribution.flood` field over similar populations) -- real, but fixing
  it well needs measuring the actual overlap on live data, which is next-
  round work, not a one-line fix.
- "Collector sites prioritised first" (`taskforce` beat) stated as fact
  with no site-role field to back it -- pre-existing, predates this 8-cycle
  plan, already disclosed honestly in that beat's own code comment; out of
  scope for a pass targeted at operator-reported issues C1-C7 address.

**FIXED -- simulation-ux-reviewer.**

- `WorkOrderAlert.tsx` had no REAL/MECHANISM/ILLUSTRATIVE badge -- every
  other surface on this tab carries one; added, matching
  `SimulationConsole`'s existing badge markup exactly.
- Body copy added "in this scenario run" -- the card floats ON the map
  rather than docked below `SimulationBanner`'s disclaimer, so a viewer
  whose eye lands on it (C4's whole design intent) may never trace back up
  to the banner; the footer's "Live optimizer output" line was true and
  made this worse by confirming realness without flagging the scripted
  flood underneath it.
- Close-button hit target: `p-1`/`-m-1` (~20px) -> `p-1.5`/`-m-0.5`,
  clearing the 24px accessibility minimum the reviewer measured it
  falling short of.
- Four hardcoded `bg-black`/`border-black` swatches in `SimulationLegend.tsx`
  (`cone`, `mocn` pre-existing; `cow`, `generator` new this pass) -> `bg-overlay`/
  `border-overlay` at the same alphas. CLAUDE.md's `--color-overlay` hinge
  rule: every tint in the tree must route through that one token so
  flipping to dark theme is a single-line change, and these four would
  have rendered black-on-black had that flip ever happened. The reviewer's
  own grep for `white/` didn't catch these (wrong literal), so the finding
  came from the opposite direction of a `bg-black` variant of the same bug.

**ACKNOWLEDGED, not fixed -- simulation-ux-reviewer, polish tier.**

- Legend swatches for generator/COW/cone are abstract shapes (circle,
  square) that don't resemble the actual 18px PNG glyphs drawn on the map.
  Reviewer's own framing put this at "CLEAN"/browser-check tier, not a
  blocker; reworking every swatch to render the real icon asset is a
  larger change than this cycle's scope justifies against three already-
  fixed, higher-severity findings.

**CLEARED -- simulation-integrity-tester, all six requested checks
executed, not read:**
1. Full backend pytest suite (423 passed, 2 pre-existing failures in
   `tiles/`, unrelated -- verified via `grep -rln simulation tiles/`
   returning nothing) plus all 18 frontend `lib/*.test.mjs` files (186
   pass) plus a direct timeline-invariant probe (beatsUpTo strictly
   prefix-monotone across a full stepped run, backward seek clears later
   beats correctly).
2. C5's `firedRunSeq` guard -- confirmed it fires BEFORE each loop
   iteration's network call, confirmed the premise it depends on
   (`start()`/`resetSim()` bump `runSeq` in the same `set()` the status
   change lands in), no fault found.
3. `stagingPoint`'s null-polygon handling at both call sites -- confirmed
   correct by CHECKING THE ACTUAL TIMING WINDOWS rather than trusting the
   comment: neither call site's active window overlaps the recession's
   `null` frame (introduced in C7, the same day), so the theoretical edge
   case this guards against cannot currently occur, and the fallback is
   honest if it ever does.
4. Multi-route marker/animation cleanup (C5's rewrite) -- no leak; every
   marker/animation created is registered before being assigned to the
   ref, and both the top-of-effect and unmount cleanup paths clear both
   arrays.
5. Retune-first gate (C2) -- empirically swept neighbour count 0-3 against
   one isolated down tower: site count reduces monotonically (8,6,3,1),
   never reaches zero, because the centre site is pushed unconditionally
   before the gate loop runs.
6. Live endpoint probing against a real uvicorn instance -- `/schedule/optimize`
   returns real Sabah-filtered work (5 of 49 entries), `/schedule/emergency`
   sequential fan-out against one run_id correctly accumulates BOTH pins
   without snapping the horizon back to the demo clock (the exact bug a
   "Fixed, recorded" CLAUDE.md entry already covers -- confirmed still
   fixed, not regressed by C5), `/schedule/preview` byte-verified to mutate
   nothing.

Degradation path and section 0.6 firewall also independently re-verified
(both error branches call `setOffline`, `generatorSiteIds` correctly
mirrors `downTowerIds`' non-persisted lifecycle, zero out-of-bounds
references to either set found by grep).

**Final gates, run again after all fixes above:** `node --test` on
`simulationConsoleLine.test.mjs` (11/11, two beat strings updated to match
the reworded copy) and the full `src/lib/*.test.mjs` sweep (18 files, all
pass). `npm run build` clean. `npm run lint` clean, same 4 pre-existing
warnings, zero new.

This closes the 8-cycle plan. Summary of the whole pass: C1 freed COW
siting from survivor-tower coordinates to genuine ring-packed targets
under a land-witness/containment/separation rule, fixing the reported
bunching. C2 made "retune insufficient for terrain" a real computation.
C3 gave the unused `generator.png` a real layer, console line and site
selector. C4 surfaced the 'optimize' beat's real result as a dismissible
card instead of buried console text. C5 fanned emergency dispatch out to
every down tower instead of one. C6 stopped every dispatch animation from
originating inside the flood it was responding to. C7 made the flood
recede after T+36h instead of staying at full extent through the run's
own closing beat. C8's review pass caught two remaining overstatements
(fleet-size and action-label claims neither the geometry nor the backend
actually supported) that survived C1-C7's own verification because they
were copy problems, not geometry or backend problems -- the kind a
domain-literate reader catches and a build/lint/test gate cannot.

## 2026-09-20 — One connected scenario and mapped-road dispatch

Operator requested a single end-to-end view rather than separate analysis tabs, and actual road routes instead of destination trajectories. The page now combines rainfall, ground wetness, relative river level, flood, tower priorities and authored road closures. A single progress rail follows signals → assessment → access checks → dispatch → review. All weather/river values remain explicitly authored indices; the shared timeline shows their lag without claiming statistical correlation or sensor measurements. Wider assessment retains maintain/watch towers outside the flood and does not change model scores.

Added a local OpenStreetMap road/waterway snapshot with provenance in `data/simulation/README.md`. Read-only `/travel/simulation-network` and `/travel/simulation-routes` expose mapped geometry and route distances. The router respects vehicle access, one-way roads, supported turn restrictions, barriers and requested closures; missing/disconnected routes have no invented geometry. The scenario closes one mapped Bulatan Capitol roundabout (25 graph segments) from 24–88 seconds. A saved-snapshot check verifies an actual 6.642→9.752 km detour and exclusion of closed edges. Durations use road-class speed estimates, not measured traffic.

Crew/day route groups advance only after a reachable destination; inaccessible assignments are deferred without becoming fictional departure points. The tested emergency plan has 12 assignments, 7 mapped routes and 5 access holds. This is a read-only dispatch assessment; it does not rewrite the optimizer's saved schedule. Vehicles follow the exact road polyline by distance, stop at the mapped road endpoint and do not claim unverified last-mile access or completed site work. Removed elevated crew trajectories, arbitrary dry-site depot relocation and invented inbound COW travel; illustrative COW points appear parked. Playback time remains compressed. The director now inspects the closure and follows a point on the actual crew route.

Validation: frontend production build succeeds; lint retains the two pre-existing `useLiveTowers` warnings. 89 focused frontend checks pass (scenario/camera/road-motion/response geometry); the final camera/road subset also passes after adding the closure closeup. 4 backend pytest tests cover routing contracts, access/closures/grouped deferrals, turn restrictions and the real saved snapshot. Browser checks cover simultaneous signals, no analysis tabs, road geometry, 7 routed/5 deferred jobs, pause/backward seek/recovery, mobile width, road-unavailable holds, fresh network assessment after Reset, the closure/road-follow camera and Resume. No browser runtime errors.

Limits remain visible: current OSM geography is not historical 2024 road condition, scenario closures are not a live closure feed, water depth is not measured, traffic ETA is estimated, and depot/final-site access requires field confirmation.

## 2026-09-20 — Hold the tower assessment overview

Operator requested a steady overview with blinking tower positions during assessment. Removed the four intermediate site/region camera shots between 15 and 40 seconds. The initial zoom-out now frames the full reviewed set (peak flood exposure plus maintenance priorities), independent of arriving road plans, and holds after its 3.6-second transition. Native map rings and detailed Three.js halos share a gentle scenario-time pulse; underlying risk colours remain visible. Pause and backward seeking reproduce the same pulse frame, and reduced motion uses static rings.

Validation: production build passes; lint reports only the two existing `useLiveTowers` warnings. Four focused camera/visual tests pass, including identical camera poses throughout the assessment hold, pulse boundaries, deterministic seeking and reduced motion. Browser screenshots at 18.6, 32.6, 33.4 and 39.9 seconds confirm stable framing and changing ring intensity. Paused canvas screenshots are identical; later closure stage, seeking, director state and Resume work without browser runtime errors.

## 2026-09-20 — Tighten assessment framing

Operator found the statewide assessment view too wide to locate towers. Camera bounds now use the 25 peak-exposure towers in the west-coast corridor (roughly 13 km north–south), rather than all 36 reviewed sites spread across Sabah. The full priority assessment remains available in the panel. Assessment still holds one camera pose and pulses the existing tower rings.

Validation: production build and four focused camera/visual tests pass; lint retains only the two existing `useLiveTowers` warnings. Browser screenshots confirm the closer corridor framing, visible location rings and unchanged hold throughout assessment. Pause, seeking, later closure stage and Resume checks pass with no browser runtime errors.

## 2026-09-20 — Make the flood-first priority comparison explicit

Operator clarified the story: first show the flood, then pull back to nearby high-priority towers outside it, blink those as lower immediate response priority, and dispatch crews to the flooded sites before continuing. The camera now stays over the flood through onset, pulls back at 27 seconds to the peak-exposure sites plus the three closest outside-flood maintain/watch sites, and holds from 30.6–40 seconds. Selection is stable across seeking and input order; it reuses real coordinates and model bands. The current three sites are approximately 36–41 km from the nearest authored flood-boundary vertices; distant Sabah priorities no longer widen this shot.

Only those nearby outside-flood markers pulse amber during 27–54 seconds. Flood markers stay cyan. Map labels and a compact First / Later key explain response order without replacing risk colours; the briefing names the same three sites and retains the wider assessment count. Detailed Three halos match the native map rings. Reduced motion uses static rings, pause freezes the pulse, and mobile signal cards occupy less map space. A new 27-second scene makes the decision explicit before road checks and dispatch.

Existing emergency dispatch already pins scenario-down sites inside the flood and animates only those emergency assignments along mapped roads, so no scheduler or route changes were needed. Follow-up text describes the scenario's response priority without claiming all outside jobs changed dates. Recovery now says Review response & follow-up because the displayed plan still contains the emergency assignments.

Validation: 91 simulation/response-geometry tests pass, including new nearby-selection checks and revised camera/pulse boundaries. Production build passes; lint retains only the two existing useLiveTowers warnings. Browser checks cover flood onset, all three compared site IDs, the amber/cyan comparison, stable assessment framing, pause, backward seeking, subsequent mapped-road dispatch (12 assignments / 7 routes / 5 access holds), reduced-motion presentation and mobile width. Final screenshots confirm the flood-first label and visible nearby markers; no browser runtime errors.

## 2026-09-20 — Match the regional priority-transfer reference

Operator supplied the desired regional framing, including the surrounding red and amber priority towers. Expanded the comparison from the nearest three to the nearest five actual outside-flood priorities (four Maintain, one Watch), keeping the distant sixth site out of the camera target. The assessment fit now uses tighter vertical padding and a 60-degree tilt. All five location rings pulse together while flood rings remain steady; darker ring colours keep the same distinction readable on the light terrain map. Follow-up labels prefer the right side of their markers to stay clear of the lower-left signal panel. The caption explicitly states that immediate response priority shifts to the flood emergency.

Validation: production build and six focused camera/warning/visual tests pass; lint retains the two existing useLiveTowers warnings. Browser checks confirm five comparison sites, pulse high/low frames on light and satellite basemaps, paused canvas stability, backward seeking and continuation into the road-closure stage, with no runtime errors. Assessment still holds its pose after the pullback and retains the existing emergency road dispatch.


## 2026-09-20 — Outside-flood staging and parallel response vehicles

Operator requested departure points near the flood but outside its footprint, multiple vehicles serving affected towers along different roads, and mobile network supply. The simulation now illustrates four response crews and two mobile-network units against the optimizer-selected emergency targets. These are explicitly labelled scenario reinforcements: saved crew IDs, work orders and the global roster are unchanged. Jobs are distributed deterministically across the response vehicles; inaccessible jobs remain listed for access review.

The road API selects nearby permitted mapped staging nodes beyond the full authored flood boundary (500 m clearance for repairs, 1,000 m for mobile staging). Mobile deployment points also lie outside the boundary, with 100 m clearance. Routing retains one-way/access/turn rules and authored closures; repair destinations keep their original road snap. Each unit starts at its returned staging point, subsequent jobs depart its last reached road node, and missing routes never fall back to the flooded depot or a straight connector. Polygon validation, bounded candidate searches, caching and conservative directed-access pruning keep the local-road assessment practical.

Vehicles stage from 54 seconds, repair vehicles depart at 58 seconds, and mobile trucks travel from 62 to 76 seconds. Each unit has a distinct route colour and matching dispatch-card marker. The fleet overview holds through 69 seconds and fits actual routes and staging points at the matching camera angle; the warning panel compacts during response. Mobile trucks raise their antenna and display fixed illustrative 3.5 km coverage only after reaching the returned deployment point. The earlier static ring-packed mobile placements have been removed from the playback. Assessment framing and its flood-first priority blink remain unchanged.

Validation: 92 focused frontend checks and all 5 backend routing tests pass; the production build passes and lint retains only the two existing useLiveTowers warnings. The actual browser response contains 7 repair routes, 5 held repair jobs and 2 mobile routes, across all 6 moving units. Checks confirm outside-flood origins/deployments, exact road endpoints, excluded closure edges, pause and reverse seek, live playback from staging through travel, and coverage only after 76 seconds (including reduced motion). A 390 px viewport has no horizontal overflow. When road data is unavailable, all 14 response jobs stay on hold and captions do not claim a deployment. No browser runtime errors.

Limits: reinforcement fleet sizes and playback timing are authored; mapped roads do not verify flood depth, parking suitability, final site access or current passability. Coverage is illustrative, not an RF prediction. The bounded search can retain an access hold instead of claiming an unverified alternative route.


## 2026-09-20 — Show mobile radio support for outage areas

Operator clarified that mobile equipment must provide network coverage to the areas left without service while towers are down. Mobile targets now represent each separate outage pocket, using a deterministic 2 km grouping of optimizer-selected emergency sites. The current 12 sites yield four mobile base stations, alongside the four repair response vehicles. All four stations have mapped road routes to outside-flood deployment points; no static or unvalidated placement was introduced.

Added a shared coverage calculation using the installed Turf union/difference tools: unite the authored outage circles, subtract only arrived mobile footprints, and draw the reached intersection in green while leaving the remaining gap red. The fixed 3.5 km mobile radius is shared by geometry and legend. Overlapping station ranges do not double-count or darken supported areas. Calculations run at outage/arrival/restoration boundaries, not on each vehicle animation frame. Offline tower markers remain until the existing repair/restoration beat; temporary radio support does not mark towers repaired. Retuned-neighbour illustrations remain separate, and red denotes outage area awaiting mobile coverage rather than a measured network survey.

Mobile base stations now use distinct antenna-truck pictograms and taller deployed 3D masts. The director returns to the corridor by 76 seconds and holds while radio coverage becomes visible. The map key shows actual active/requested stations and remaining-gap/temporary-support colours. Mobile cards move to the top during 62–80 seconds and identify their target outage pockets. Copy separates battery/site power from mobile radio coverage and handles pending or unavailable deployments without claiming service.

Validation: production build passes; 93 focused frontend tests pass, including coverage subtraction, overlapping ranges, unsupported pockets, held routes, timing, reverse seeking and camera continuity. Lint retains only the two existing useLiveTowers warnings. The actual mapped plan has four mobile routes plus seven repair routes, five held repair jobs, and eight response units. All 12 outage tower locations fall within the arrived mobile footprints, but residual edge areas remain visibly red. Browser before/after captures confirm 0/4 then 4/4 active stations, green support with offline markers still present, paused-frame stability and reverse seeking. Reduced motion activates coverage only at 76 seconds. A 390 px viewport fits without horizontal overflow. With road data unavailable, the UI shows eight units and 16 jobs held, zero active stations and no false coverage caption. Mobile-first card ordering is verified at 62/78 seconds and restores at 80 seconds. No runtime browser errors.

Coverage footprints remain illustrative; they do not assert RF propagation, subscriber counts or complete service restoration.

## 2026-09-21 — Crews place devices and move on

Operator requested a visible drop-off sequence: crews drive through the affected area, place a mobile network device, and leave its symbol behind. The four network delivery vehicles now follow their mapped inbound roads from 62–74 seconds, stop to place devices during 74–76 seconds, and activate four fixed antenna symbols at their deployment points at 76 seconds. From 77–86 seconds the vehicles return to staging on separately computed directed road routes; devices and illustrative coverage remain fixed through 88 seconds. The director holds the response overview so the separation between moving crews and placed equipment stays visible. Repair vehicles and the earlier regional assessment retain their existing behavior.

The road API returns a departure route for each mobile delivery, respecting the same access, one-way, turn and closure constraints as the inbound route. It does not reverse the inbound polyline. A failed departure keeps the delivered device active and the crew at its drop-off with an outbound access hold. Vehicle labels, dispatch cards, route distances and the coverage key distinguish placing, active equipment, crews moving on and return to staging. Reduced motion preserves the same narrative boundaries; backward seeking removes devices before placement.

Validation: 93 focused frontend checks and six backend routing tests pass. The four actual departure routes start at their device locations, end at outside-flood staging and exclude closed edges. Browser checks cover placement, fixed symbols while vehicles move, return to staging, pause, reverse seeking, reduced motion, unavailable departure routes and a 390 px layout, with no runtime errors. Production build passes; lint retains only the two existing useLiveTowers warnings. Coverage remains illustrative and deployment/road suitability still requires field confirmation.
