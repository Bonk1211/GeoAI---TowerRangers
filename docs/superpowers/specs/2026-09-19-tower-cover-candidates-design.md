# Tower Cover Candidates — Design

**Date:** 2026-09-19
**Scope:** compute, before any disaster, whether a flood-exposed tower has any neighbour that
could stand in for it — and surface the ones that have none as a ranking signal on the
predictive namelist.
**Depends on:** `fixtures/source.py` (the one tower-population switch, already built),
`model/risk_index.py` + `model/ensemble.py` (the band cut, already built),
`lib/responsePhaseGeometry.ts` (the sector-split geometry, already built and tested).
**Status:** design, not yet implemented.
**Replaces:** nothing. Adds one backend module, one endpoint, one panel, and three additive
edits to an existing page.

---

## 0. Why this exists

### 0.1 The positioning problem this solves

The product's selling point is **predictive**: hand MCMC a ranked namelist of towers to watch
*before* a flood, instead of the conventional practice of attending to whichever areas flooded
hardest in the same month last season.

The Simulation tab currently shows the opposite posture. After a tower falls, neighbouring
towers swing their sector cones toward the gap, a MOCN link appears, and COWs deploy. It is a
good animation of a real practice — but it is **reactive**, it is the posture the product is
trying to beat, and the bearing it animates is invented. `SimulationMap.tsx:659` already says so:

> Illustrative geometry — real action, invented bearing (spec §8) — since this project holds no
> sector-level RF data.

Presented on its own, that reads as a claim to an RF capability the repo does not have.

This design does not delete that work. It **inverts its time axis**. The same geometry, run
*before* the event against the model's own flood-exposed set, answers a different and better
question:

> Not "who retunes after this tower falls?" but **"if this tower falls, does anyone stand to
> cover it at all?"**

That answer is a *pre-disaster ranking input*. It sharpens the namelist rather than sitting
beside it, and the reactive animation becomes the proof at the end of the pitch rather than a
feature asking to be judged on its own.

### 0.2 The argument that survives a hostile question

Two towers carry identical flood risk. Conventional ranking cannot separate them. This feature
can:

- Tower A: three surviving neighbours within 15 km. If it drops, some traffic has somewhere to go.
- Tower B: three neighbours within 15 km, **and every one of them floods in the same event.**

Tower B looks perfectly well-connected on a map. It is not. Nothing derived from rainfall
history, month-of-year, or proximity alone will surface that distinction, because the
distinction is *joint* — it is a property of the tower **and** its neighbourhood **and** the
predicted hazard, at once.

Measured on the real Malaysian estate (§3), **five towers** are in exactly that state.

### 0.3 What this is NOT

This is **not an RF calculation and must never be presented as one.** §2 documents the data
audit. The output is *candidates for an RF planner to confirm*, never a configuration. The
distinction is load-bearing and is repeated in the module docstring, the API `parameters` block,
and the UI footnote.

---

## 1. What is already built, and must not be rebuilt

| capability | location | state |
|---|---|---|
| Sector-split neighbour selection | `lib/responsePhaseGeometry.ts:60` `selectRetuningNeighbors` | built, 9 passing tests |
| Great-circle distance | `lib/geo.ts` `haversineKm` | built |
| Initial bearing | `lib/coverageGeometry.ts:37` `bearingDeg` | built |
| Per-outage assignment | `lib/responsePhaseGeometry.ts:148` `assignRetuningNeighbors` | built |
| One tower-population switch | `fixtures/source.py` `scored_towers()` | built |
| Band cut / `decision` | `model/ensemble.py`, served on every Tower record | built |
| "Evidence beside the score" panel pattern | `components/investigation/FireExposurePanel.tsx` | built |
| Filterable, sortable namelist | `pages/Investigation.tsx` | built |
| Constant-drift pinning precedent | `responsePhaseGeometry.ts:188` `CLUSTER_RADIUS_KM` | built |

`selectRetuningNeighbors` is the single most valuable asset here. It already:

- filters candidates to within `NEIGHBOR_SEARCH_RADIUS_KM = 15`
- splits the compass into three 120° sectors and takes the **nearest candidate per sector**,
  so results fan around the subject rather than bunching on whichever side is locally denser
- excludes towers that are themselves unavailable
- caps at three
- **returns fewer than three honestly**, its own doc comment calling that "the honest report of
  nothing plausible on that side, not something to paper over"

That last property is the entire feature. The isolation count this design surfaces is literally
the length of that function's return value.

**The algorithm is therefore not being invented. It is being ported and re-framed.**

---

## 2. Data reality — the audit that constrains every claim

Measured against `data/malaysia/tower_feature_table.csv` (1,164 towers) on 2026-09-19.

### 2.1 Present and complete

| column | populated |
|---|---|
| `lon`, `lat` | 1,164 / 1,164 |
| `elevation_m` | 1,164 / 1,164 |
| `hand_m` | 1,164 / 1,164 |
| `slope_deg`, `tri` | 1,164 / 1,164 |
| `dist_water_m`, `dist_power_m` | 1,164 / 1,164 |

### 2.2 Absent or useless

| column | state |
|---|---|
| `exposed_pop` | **0 / 1,164 populated** |
| `age_years` | **0 / 1,164 populated** |
| `flash_density` | **0 / 1,164 populated** |
| `radio` | 1,164 populated, but **1,119 are the literal string `UNKNOWN`** |
| antenna azimuth | **column does not exist** |
| antenna height | **column does not exist** |
| EIRP / transmit power | **column does not exist** |
| frequency band | **column does not exist** |
| sector count / tilt range | **column does not exist** |
| neighbour / handover relation table | **does not exist** |
| per-cell traffic or capacity | **does not exist** |

### 2.3 What this forbids

Four things are permanently out of reach with this data, and no phase of this design may claim
them:

1. **Path loss / propagation.** Needs EIRP, antenna height, frequency. Have none.
2. **Capacity.** "Can the neighbour carry the extra load?" needs traffic data. Have none.
3. **Tilt feasibility.** Needs sector inventory and electrical tilt range. Have none.
4. **A specific azimuth.** Naming "retune to 147°" as an engineering output would be fabricated.

What *is* reachable is geometry: great-circle distance and initial bearing between known
coordinates, plus — in a documented future phase (§11) — terrain screening against the DEM that
is already loaded.

**Design rule derived from this section:** every field the API emits is a distance, a bearing, a
count, or a tower id. Nothing else.

---

## 3. The rule, and what it measures

### 3.1 The at-risk predicate

```python
def at_risk(t: dict) -> bool:
    return t["decision"] == "maintain" and t["dominant_factor"] == "flood"
```

Chosen over three alternatives:

| alternative | rejected because |
|---|---|
| `decision == "maintain"` (any cause) | an equipment-risk neighbour does not drown with you, so the co-hazard predicate would have to differ from the at-risk predicate — two rules to explain instead of one |
| `weather.multiplier < 1.0` (live GFS/SMAP forecast) | `Tower.weather` is `null` whenever Earth Engine is unreachable **and** on the whole `USE_FIXTURE=1` branch. The feature would render empty in exactly the conditions a demo runs under |
| `attribution["flood"] > threshold` | introduces a second threshold beside the model's own band cut, tunable and therefore arguable |

The chosen rule reuses the model's existing band decision and its existing dominant-factor
attribution. **It adds no new threshold to the system.**

The same predicate defines co-hazard: a neighbour within range for which `at_risk()` is true is
not a candidate — it is expected to be under the same water.

### 3.2 The algorithm

For each tower where `at_risk()` is true:

1. Collect every other tower within `SEARCH_RADIUS_KM = 15.0`.
2. Partition that set: `at_risk()` → `co_hazard`; otherwise → candidate pool.
3. Over the candidate pool, run the sector-split selection: three 120° bearing sectors, nearest
   candidate per sector, no tower used twice, sectors with nothing in them are skipped.
4. Record the nearest other tower **at any distance**, unbounded by the search radius.

Step 4 is deliberately unbounded so the UI can say "nearest tower 22 km" rather than reporting
`null` for a tower that has neighbours just beyond the cut-off. `null` is reserved for a
single-tower estate.

### 3.3 Measured result on the real estate

Run against `scored_towers()` on the live (non-fixture) branch, 2026-09-19:

| reading | value |
|---|---|
| towers total | 1,164 |
| `decision` distribution | ok 815 · watch 232 · **maintain 117** |
| maintain-band dominant factor | **flood 78** · power 26 · vegetation 11 · terrain 2 |
| **at-risk set (maintain + flood)** | **78** |
| with 3 candidates | 40 |
| with 2 candidates | 17 |
| with 1 candidate | 9 |
| **isolated (0 candidates)** | **12** |
| └ nothing at all within 15 km | 7 |
| └ **neighbours within 15 km, all of them at risk** | **5** |
| with ≥ 1 co-hazard neighbour | 55 |

78 is a workable list length — large enough to matter, small enough to act on. 12 isolated is
15% of it: a real finding, not a rounding error and not an alarm on everything.

The 7/5 split is the reason `co_hazard` is returned as its own list rather than silently
filtered out. Those five towers are the feature's strongest single claim.

**These numbers are pinned by a regression test (§9.2)** so that a future scoring change cannot
silently empty this feature.

### 3.4 The fixture branch produces no isolation, and that is correct

Measured on `USE_FIXTURE=1`, same date:

| reading | fixture | live |
|---|---|---|
| towers | 500 | 1,164 |
| AOI span | 0.130° × 0.140° (≈ 14 × 15 km) | national |
| `decision` | ok 380 · watch 85 · maintain 35 | ok 815 · watch 232 · maintain 117 |
| maintain that is flood-dominant | **35 / 35** | 78 / 117 |
| at-risk set | 35 | 78 |
| **isolated** | **0** | **12** |

Two consequences, both of which must be planned around rather than tuned away:

1. **Every fixture tower is within the 15 km radius of every other**, because 500 synthetic
   towers are packed into a box roughly 14 km across. Isolation is therefore structurally
   impossible on that branch. The "No cover" tab renders zero rows.
2. **The flood predicate is not exercised at all** on the fixture, because all 35 maintain-band
   towers are flood-dominant. Any bug in the `dominant_factor` half of `at_risk()` will not show
   up there.

**The radius must not be shrunk to make the fixture produce isolation.** Choosing a parameter to
manufacture a desired output is precisely the dishonesty §0.3 and §2.3 exist to prevent, and the
15 km value is inherited from the existing simulation constant rather than fitted.

What follows from this instead:

- **The demo runs on the live branch.** This is a hard requirement, recorded in §12 as a risk.
- Phase 2's browser check on `USE_FIXTURE=1` verifies the *empty* states render correctly (tab
  shows zero, panel shows state 4 or nothing), not that the feature has findings.
- Unit tests (§9.1) carry the isolation cases with hand-built literals, so coverage does not
  depend on either population.

---

## 4. Architecture

```
scored_towers()            model/fallback.py             api/routes/towers.py
(fixtures/source.py,  ──►  pure functions,         ──►   GET /towers/fallback
 one USE_FIXTURE switch)   in-process cache               │
                                                          ▼
                                       api/queries.ts: useTowerFallbackQuery()
                                                          │
                          ┌───────────────────────────────┼───────────────────────────┐
                          ▼                               ▼                           ▼
              Investigation list              FallbackPanel                  Overview map
              (sort + "No cover" tab)         (detail, 4 states)             (isolated ring)
```

One computation, three consumers, joined client-side on `tower_id`.

### 4.1 Why a separate endpoint, not fields on the Tower record

Adding `cover_*` fields to the Tower record would require implementing them in **both**
`adapter/ml_source.py` and `fixtures/scored_towers.py` and keeping the two in sync forever.
That is precisely the drift `fixtures/source.py` exists to prevent; its docstring records four
call sites that each re-implemented the `USE_FIXTURE` branch and diverged.

`GET /towers/fallback` derives from `scored_towers()` — the same single switch — so both
branches are served by one code path and the report can never describe a different tower
population than `/towers` serves.

### 4.2 Why the backend rather than a `lib/` module

The frontend alternative is real and cheaper: `responsePhaseGeometry.ts` already holds the
geometry, `useLiveTowers` already holds every tower, and a `useMemo` would do. It was rejected
on two grounds:

1. **Exportability.** The deliverable is a namelist handed to MCMC. It must be able to leave the
   browser — reachable by `agent/tools.py` and the Confluence integration. A `lib/` module
   cannot do that without the work being redone.
2. **Layer discipline.** Every one of the sixteen tested `lib/` modules is a *view* concern:
   gantt layout, dispatch animation, ticket copy, simulation geometry. "Which towers have no
   cover" is a claim about the estate, and belongs with `risk_index.py`, `ensemble.py` and
   `novelty.py`.

The accepted cost is ~150 lines of Python partially duplicating tested TypeScript. The codebase
already sanctions that trade with a named pattern: duplicate the constant, pin both copies with a
test (`responsePhaseGeometry.ts:188`).

---

## 5. API contract

### 5.1 `GET /towers/fallback`

Envelope mirrors `FireExposure` — a parameters block plus a towers dict — so the two
"evidence beside the score" features read alike on both sides of the wire.

```jsonc
{
  "generated_at": "2026-09-19T04:12:07Z",
  "parameters": {
    "search_radius_km": 15.0,
    "max_candidates": 3,
    "sector_count": 3,
    "at_risk_rule": "decision == 'maintain' and dominant_factor == 'flood'",
    "basis": "great-circle geometry over tower coordinates; no antenna data"
  },
  "at_risk_count": 78,
  "isolated_count": 12,
  "towers": {
    "MY_W1315123577": {
      "tower_id": "MY_W1315123577",
      "candidates": [
        { "tower_id": "MY_N9455370923", "distance_km": 4.21, "bearing_deg": 137.4 }
      ],
      "co_hazard": [
        { "tower_id": "MY_X8821004412", "distance_km": 3.08 }
      ],
      "nearest_km": 3.08
    }
  }
}
```

### 5.2 Field rules

| field | rule |
|---|---|
| `towers` | **contains only at-risk towers.** A tower absent from this dict is not at risk. It is never present with empty lists — absence is not zero (CLAUDE.md zeroed-struct rule) |
| `candidates` | 0–3 entries, ordered by sector index then distance. Empty is a real and important answer |
| `co_hazard` | neighbours in range that are themselves at risk. Returned explicitly, never silently dropped — same discipline as the optimizer's unscheduled work |
| `nearest_km` | distance to the nearest other tower in the estate — **any** distance, not capped at the search radius, and **counting co-hazard and out-of-range towers alike**. It answers "how alone is this site, physically", which is a different question from "who could cover it". In the §5.1 example it equals a co-hazard tower's distance, and that is correct. `null` only when no other tower exists at all |
| `isolated` | **deliberately absent from the per-tower record.** `len(candidates) == 0` already says it, and a boolean stored beside the list it summarises is a second copy of the same fact that can disagree with the first |
| `at_risk_count`, `isolated_count` | present at the envelope level, and **not** a contradiction of the rule above: they summarise *across* records rather than restating a field sitting next to them, and they let an export or agent consumer report "12 of 78" without walking the dict. They are computed from `towers` in one place, never assembled separately |
| `bearing_deg` | initial great-circle bearing from the at-risk tower to the candidate. It is a *direction to a place*, never an antenna azimuth |

### 5.3 Naming constraint

CLAUDE.md, project-specific rules:

> **Never fabricate failure label or expose failure-probability semantics.** System schedules
> maintenance *need* and *urgency*, not predicted failure events. Endpoint names, docstrings, UI
> copy must stay consistent.

This binds every string in this feature. Permitted: *"if it fails"*, *"cover candidates"*,
*"no cover"*. Forbidden: *"will fail"*, *"failure risk"*, *"outage probability"*, and any
endpoint or field named for a predicted failure event.

---

## 6. Backend design

### 6.1 `src/backend/model/fallback.py` (new)

Pure functions over tower dicts. Imports nothing from `api/` or `scheduler/`, so it is testable
with literals and no network.

```
haversine_km(a, b)               -> float
bearing_deg(a, b)                -> float          # initial great-circle bearing, [0, 360)
at_risk(t)                       -> bool
cover_candidates(subject, pool)  -> list[Candidate]  # the sector-split port
tower_report(subject, towers)    -> TowerFallback
fallback_report(towers)          -> dict            # the full envelope, cached
reset_cache()                    -> None            # for tests
```

Module constants, each with the comment that keeps it honest:

```python
# Illustrative search radius, NOT an RF propagation limit. Pinned to
# NEIGHBOR_SEARCH_RADIUS_KM in src/frontend/src/lib/responsePhaseGeometry.ts;
# test_fallback.py asserts this value so the two copies cannot drift apart
# (same arrangement as CLUSTER_RADIUS_KM / COVERAGE_GAP_RADIUS_KM).
SEARCH_RADIUS_KM = 15.0
MAX_CANDIDATES = 3
SECTOR_COUNT = 3
```

The module docstring must state, in its first paragraph, that this is geometry and not RF, and
must cite the data audit (§2.2) with the `UNKNOWN` radio count — so the next reader cannot reach
for a propagation model without first seeing why there is none.

### 6.2 Cost and caching

The at-risk set is 78 towers against a 1,164 pool — about 91,000 haversine evaluations, roughly
0.2 s in pure Python. Measured acceptable, but recomputing per request is waste.

Cache the envelope in-process at module level, following the precedent set by `/stability`
(`adapter/ml_source.py`, computed once at import and never re-run per request). `scored_towers()`
is process-stable, so the cache key is the process. `reset_cache()` exists for tests only.

### 6.3 `src/backend/api/routes/towers.py` (edit, ~12 lines)

```python
@router.get("/towers/fallback")
def towers_fallback() -> dict:
    # Derived from scored_towers(), NOT a second source: fixtures/source.py is the
    # one place the USE_FIXTURE branch is decided, and a cover report describing a
    # different tower population than /towers serves is exactly the drift that
    # module's docstring exists to prevent.
    return fallback_report(scored_towers())
```

No change to `api/main.py` — `towers.router` is already registered at `main.py:60`. No FastAPI
route-ordering conflict, because `/towers` declares no path parameter.

### 6.4 `src/backend/api/schemas.py` (edit)

`CoverCandidate`, `CoHazardNeighbour`, `TowerFallback`, `FallbackReport`.

Every field must be declared. This file already carries the warning, learned the hard way on the
fire evidence: **pydantic silently drops any key the model does not name.** An undeclared field
does not error; it vanishes between the backend and the browser.

---

## 7. Frontend design

### 7.1 Plumbing

| file | change |
|---|---|
| `api/types.ts` | `CoverCandidate`, `CoHazardNeighbour`, `TowerFallback`, `FallbackReport`. Doc comment: `candidates` is RF-planner input, never a configuration |
| `api/client.ts` | `getTowerFallback()`, following `getFireExposure` |
| `api/queries.ts` | `useTowerFallbackQuery()` |

**The query uses `withOfflineFallback`, unlike the fire query.** `queries.ts:253` explains at
length why fire opts out: it answers non-2xx during completely normal operation (503 on any date
VIIRS has no granule for, 503 with no Earth Engine credentials), so routing it through the shared
helper once flipped the whole console to OFFLINE while every other route served live data.

This feature has no such state. It depends on no external archive and no credentials — it reads
towers the backend already has. A non-2xx here means the backend really is unreachable, so
flipping the offline flag is the honest reading.

### 7.2 `pages/Investigation.tsx` — three additive edits

| location | edit |
|---|---|
| `:33` `FilterTab` | add `'ISOLATED'`; add to the tab array at `:188`, labelled **"No cover"** |
| `:34` `SortOption` | add `'EXPOSURE_DESC'`; add `<option>` at `:214`, labelled **"Most exposed"** |
| `:229` list item | one line beneath the tower id: `⚠ nobody covers this` or `3 nearby` |

Sort comparator for `EXPOSURE_DESC`:

1. isolated (`candidates.length === 0`) first
2. then ascending `candidates.length`
3. then descending `risk` as tiebreak
4. towers with no report (not at risk) sort last

The `ISOLATED` filter tab shows only at-risk towers with zero candidates — 12 rows on today's
data. **This tab is the pitch.** It is the screen where a tower jumps the queue for a reason no
season-and-month method can produce.

### 7.3 `components/investigation/FallbackPanel.tsx` (new)

Structurally a copy of `FireExposurePanel`, which exists for the same reason: observed evidence
positioned *beside* the score, never inside it. Cover candidacy is not one of the model's
features, carries no attribution share, and this tower's `risk`, `priority`, `decision` and
`attribution` are identical with this panel switched off.

Mounted after `<FireExposurePanel>` at `Investigation.tsx:438`, in the same grid.

**Four resolved states, none of which may collapse into another:**

| # | condition | copy |
|---|---|---|
| 1 | tower not in the report | render nothing at all |
| 2 | `candidates` empty, `co_hazard` empty | **"Nobody covers this."** Nearest tower {nearest_km} km. |
| 3 | `candidates` empty, `co_hazard` non-empty | **"{n} towers within 15 km — all of them flood in the same event."** |
| 4 | `candidates` non-empty | list each: id, distance, bearing. Any `co_hazard` follows as a caveat line |

`isPending` returns `null`. Rendering "unavailable" while a fetch is in flight would report a
request in progress as an answer — the fault `FireExposurePanel` documents.

**Colour.** Colourless, for the reason `EnsembleSignalPanel` and `FireExposurePanel` are: CLAUDE.md
gives `lib/colors.ts` exactly one job, the tower severity band, and any reading painted on that
ramp claims a severity it does not have. The single exception is state 2 and state 3, which may
use `alert` — those genuinely *are* a severity statement, about consequence rather than condition.

**Footnote, on every state:**

> Geometry only — distance and direction between towers. No antenna data. Candidates for RF
> planning to confirm.

### 7.4 Overview map ring (phase 4)

A new layer drawing a dashed ring around the 12 isolated towers.

Three constraints, each from an existing rule:

1. **Not a band colour.** `lib/colors.ts` is the single source for the severity triad, and a ring
   in a band colour would read as a fourth band. Use a neutral dashed outline.
2. **A new layer, not a filter.** CLAUDE.md requires `towers-layer` and `towers-icon-layer` to be
   filtered together. This adds a third source/layer, `towers-isolated-ring`, beneath the halo —
   it changes no existing filter, so that rule is satisfied by not touching it.
3. **Decoration must never outrank data.** The ring sits below the band halo in layer order, for
   the reason the icon-confetti defect was fixed: the halo carries the reading.

### 7.5 Simulation reword (phase 5)

Copy only, no logic. In `SimulationConsole` / `SimulationLegend`, replace any invented-bearing
readout with the candidate count. Add a link from `FallbackPanel` to `/simulation`.

The cones keep swinging — the animation communicates the concept well and its own doc comment
already labels the bearing illustrative. What changes is that no number presented to the viewer
is a fabricated azimuth.

---

## 8. Error handling and absent states

| condition | behaviour |
|---|---|
| query pending | panel renders `null`; list shows no cover line; ring layer empty |
| query failed | `withOfflineFallback` — console reports offline, which is accurate |
| tower absent from `towers` dict | normal: not at risk. Not an error, not an empty record |
| `nearest_km` is `null` | only possible with a single-tower estate; panel says "no other tower in the dataset" |
| `candidates` empty | a real answer, and the most important one. Never rendered as "no data" |
| `USE_FIXTURE=1` | runs without error and returns 35 at-risk towers, but **0 isolated** — the synthetic AOI is ~14 km across, so nothing can fall outside the radius (§3.4). The empty tab is the correct output for that population, not a failure |

The distinction that must not be lost anywhere: **"we could not ask" is not "we asked and the
answer is none."** Pending renders nothing; zero candidates renders the alarm.

---

## 9. Testing

### 9.1 `src/backend/model/test_fallback.py` (new)

Uses the `globals()` loop entry point, not `pytest.main` — this module takes no fixtures, per the
convention recorded in CLAUDE.md.

| # | case | asserts |
|---|---|---|
| 1 | lone at-risk tower, nothing within 15 km | `candidates == []`, `co_hazard == []`, `nearest_km` is the real unbounded distance |
| 2 | three candidates at bearings 0°, 120°, 240° | all three selected — sector spread works |
| 3 | three candidates all at bearing ~10° | exactly one selected — sector dedup works |
| 4 | candidate at 16 km | excluded |
| 5 | candidate at 14 km that is itself maintain+flood | lands in `co_hazard`, absent from `candidates` |
| 6 | subject tower itself | never appears in its own lists |
| 7 | run twice on the same input | byte-identical output — determinism |
| 8 | **constant-drift guard** | `SEARCH_RADIUS_KM == 15.0`, `MAX_CANDIDATES == 3`, with a comment naming `NEIGHBOR_SEARCH_RADIUS_KM` in `responsePhaseGeometry.ts` as the copy that must match |
| 9 | non-at-risk tower | absent from `towers` dict entirely |

### 9.2 Real-data regression

A test pinning §3.3's measured counts against `scored_towers()`: at-risk 78, isolated 12,
nothing-within-15 km 7, co-hazard-only 5.

Its purpose is not to freeze the numbers — a genuine scoring improvement may move them, and the
test is then updated deliberately. Its purpose is that a change which silently empties this
feature **fails loudly** instead of shipping a tab reading "0 towers".

Marked so it skips cleanly on the `USE_FIXTURE=1` branch, whose population is synthetic.

### 9.3 Frontend verification

```bash
cd src/frontend
npm run build    # tsc -b && vite build
npm run lint     # oxlint
for f in src/lib/*.test.mjs; do node --experimental-strip-types --test "$f"; done
```

CLAUDE.md is explicit that a passing build does **not** verify visual, accessibility or
map-rendering work. Phases 2–4 additionally require a browser check on both branches
(`USE_FIXTURE=1` and live), covering: the "No cover" tab count, the sort order, all four panel
states, and the ring's layer order beneath the halo.

---

## 10. Phases

Each phase leaves the repo in a shippable state.

| # | scope | files | demo-able after |
|---|---|---|---|
| 1 | algorithm + tests + endpoint | `model/fallback.py`, `model/test_fallback.py`, `api/routes/towers.py`, `api/schemas.py` | backend only (`curl`) |
| 2 | plumbing + list | `api/types.ts`, `api/client.ts`, `api/queries.ts`, `pages/Investigation.tsx` | **yes — this is the pitch** |
| 3 | detail panel | `components/investigation/FallbackPanel.tsx`, `index.ts`, `pages/Investigation.tsx` | yes |
| 4 | map ring | `components/map/towerLayer.ts`, `MapView` | yes |
| 5 | simulation reword | `SimulationConsole`, `SimulationLegend`, `FallbackPanel` | yes |
| 6 | terrain screening | — | **not built; see §11** |

If the clock runs out, **stopping after phase 2 still delivers the argument.** The sort and the
"No cover" tab are the screen the pitch needs. Phases 3–5 are depth.

---

## 11. Phase 6 — terrain line-of-sight screening (documented, not built)

The one genuinely RF-adjacent refinement this data supports, recorded here so it is not
re-derived later.

**Idea.** Sample the DEM along the great-circle path between an at-risk tower and each candidate,
and drop candidates with a ridge between them. This upgrades "nearest neighbour" to "nearest
neighbour that can actually see it" — a real and defensible distinction.

**Feasible because** the elevation infrastructure is already loaded: `elevation_m` is 100%
populated, `terrainLayer.ts` already mounts a DEM, and `flood/forecast.py` already demonstrates
the Earth Engine point-sampling pattern, including the `reduceRegions` reprojection trap.

**Not built now because** it costs an Earth Engine call per tower pair — roughly 200 paths for
today's at-risk set — which is a separate cost and latency decision, and because it would make
the feature depend on credentials the offline and fixture branches do not have. §3.1 rejected
the live-weather predicate for exactly that reason; the same objection applies here.

**Cheap interim proxy, if wanted before then:** compare endpoint `elevation_m` and the subject's
`tri` (terrain ruggedness), and label the result as a proxy rather than a profile. This must be
labelled distinctly from a true line-of-sight result — a ruggedness proxy is not a profile, and
presenting it as one would repeat the error this whole design exists to avoid.

**Still out of reach even with phase 6:** propagation, capacity, tilt feasibility. §2.3 is not
relaxed by terrain data.

---

## 12. Risks

| risk | severity | mitigation |
|---|---|---|
| **The demo is run on `USE_FIXTURE=1` and the pitch screen shows zero isolated towers** | **high** | §3.4. The live branch is a hard requirement for any demo of this feature. Whoever presents must confirm `USE_FIXTURE` is unset before starting; the tab is silently empty rather than erroring, so this fails quietly |
| A scoring change empties the at-risk set and the feature silently shows nothing | high | §9.2 regression test pins the counts and fails loudly |
| The fixture branch never exercises the `dominant_factor` half of `at_risk()` (all 35 of its maintain towers are flood-dominant) | medium | §9.1 case 5 covers it with hand-built literals rather than relying on either population |
| The 15 km radius is questioned as arbitrary | medium | It is. It is labelled illustrative in the module constant, the API `parameters` block and the UI footnote. It is inherited from the existing simulation constant rather than newly invented, and the drift guard keeps the two copies equal |
| Someone reads `bearing_deg` as an antenna azimuth | medium | Field doc, `parameters.basis`, and the UI footnote all say geometry-only. The UI never renders a bearing without the footnote in the same panel |
| The Python port drifts from the TS original | medium | §9.1 case 8 pins the constants; the two implementations are allowed to differ in code but not in parameters |
| The map ring reads as a fourth severity band | low | §7.4 constraint 1 — neutral dashed outline, never a `colors.ts` band colour |
| Phase 4 disturbs the two-tower-layer filter rule | low | §7.4 constraint 2 — a new layer is added; no existing filter is touched |

---

## 13. Success criteria

1. `GET /towers/fallback` returns 78 at-risk towers and 12 isolated on the live branch, and 35
   at-risk / 0 isolated on `USE_FIXTURE=1` — the latter being the correct answer for that
   population, not a shortfall (§3.4).
2. Investigation's "No cover" tab lists exactly the isolated set.
3. "Most exposed" sort puts isolated towers above fully-covered ones of equal risk.
4. FallbackPanel renders all four states, and the five "surrounded but all flood" towers show
   state 3 rather than state 2.
5. No surface anywhere renders a bearing, distance or count without the geometry-only footnote
   reachable in the same view.
6. `npm run build`, `npm run lint`, and the backend suite pass; no string in the diff claims a
   predicted failure event.
