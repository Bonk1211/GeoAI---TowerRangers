# Real Road Travel Times (OSRM) — Design

**Date:** 2026-09-09
**Scope:** sub-project 1a — replace the straight-line travel estimate with a real road-network
matrix, everywhere the scheduler and the ticket flow measure a drive.
**Depends on:** nothing. Independent of the approval flow and the rearrange animation, both shipped.
**Status:** design, not implemented.

---

## 0. Why this exists

The demo's claim is *"we picked the crew that can get there soonest."* Nothing in the system
measures that. Every distance and every drive time on screen is:

```
road_km      = haversine_km × 1.35          # config/policy.yaml travel.road_factor
drive_min    = road_km / 45 × 60            # config/policy.yaml travel.avg_speed_kmh
```

A straight line between two points on a sphere, multiplied by a constant, divided by a constant.
It is not a route. It does not know about coastlines, rivers, mountains, one-way roads, ferries,
or international borders.

This is the single weakest claim in the product, and it is the one a judge asks about, because
"fastest" is the word doing the work in "smart optimisation". The `(est.)` label the approval
panel prints is honest, but honest about being a guess.

**Everything else in the pipeline is now real** — the risk model, the work orders, the solver, the
ticket escalation, the approval, the rearrangement. This is the last fabricated number on the
critical path.

---

## 1. What the constant actually gets wrong

The detour index (road distance ÷ straight-line distance) is not a constant. It varies with terrain
and network density, and Malaysia contains both extremes at once: peninsular expressway corridors
where it approaches ~1.15, and Bornean road networks where it is far higher.

**A case measured during this project.** Ticket T-1045 landed on a tower in northern Sarawak
(lon 114.08, lat 4.58). The suggestion ranker reported:

| Crew | Depot | Straight-line | ×1.35 → "road km" | Limit |
|---|---|---|---|---|
| SBH-C1 | Kota Kinabalu | 270 km | 365 km | 200 km |
| SWK-C1 | Kuching | 534 km | 721 km | 200 km |

Both were rejected as out of range, which happens to be the right answer. But the *reasoning* is
not: the real drive from Kota Kinabalu to that tower crosses the Brunei border twice and is
substantially longer than 365 km, while the Kuching leg follows the coastal trunk road for most of
its length and has a detour index nothing like the Kota Kinabalu one. **The same constant is applied
to two routes with completely different geometry.** Where the two crews are closer to the limit,
that error decides dispatches.

Three specific failure classes the constant cannot represent:

1. **Water crossings with no fixed link.** See §1a — this one is live in the demo today.
2. **Borders.** Brunei splits Sarawak. A route through it is not equivalent to a route within one
   country for a maintenance crew.
3. **Terrain.** The Titiwangsa range runs down the peninsula's spine. East–west legs cross it;
   north–south legs run beside it. Same haversine, very different drive.

---

## 1a. The reachable bug: island towers with no bridge

An earlier draft of this spec named peninsula ↔ Borneo as the headline failure. **That was wrong,
and the correction matters because it changes what the fix has to do.** Two guards already prevent
it: `optimize.py:290` requires an exact territory match before a crew is ever considered, and the
largest `max_travel_km` in the roster is 200 km against a ≥1,000 km crossing. It cannot happen.

The bug is real at *short* range, inside a single territory. Measured against the live population:

| Island | Towers | Nearest same-territory depot | haversine | `× 1.35` | Limit | Verdict |
|---|---|---|---|---|---|---|
| **Langkawi** | **8** | KDH-C1, Alor Setar | 84 km | **113 km** | 150 km | **IN RANGE** |
| Tioman | 1 | PHG-C1, Kuantan | — | — | 150 km | same class |
| Labuan | 2 | LBN-P1, *on Labuan* | 9 km | 12 km | 60 km | correct |
| Penang Is. | 14 | PNG-E1, Georgetown | 11 km | 15 km | 100 km | correct — bridge |

**Langkawi has no road bridge.** It is ferry or air only. The solver currently believes a mainland
Kedah crew can drive there in about 151 minutes, and `MY_W1315123577` — one of those 8 — has
already appeared on the board in this project's own browser runs and been rescheduled by a
dispatch. Penang and Labuan are correct by accident: Penang has a bridge, and Labuan's depot is on
the island.

This is the acceptance case. It is short-range, inside one territory, involves a real dispatchable
crew, and is invisible to every guard the system has.

---

## 2. Constraints this design must satisfy

Stated by the project owner, and binding:

- **Totally free.** No paid API, no metered service, no key.
- **No watermark or attribution burden on the UI beyond a licence line.**
- **No runtime API calls.** The backend must not depend on a network service to answer
  `/schedule/optimize`.
- **No traffic modelling.** Free-flow only. Time-of-day traffic is explicitly out of scope.

These four together rule out Google Directions, Mapbox Matrix, HERE, and the public OSRM demo server
(which forbids production use and rate-limits). They point at exactly one shape of solution.

---

## 3. The shape: a build-time matrix, not a routing service

**OSRM runs once, offline, on a developer machine. The application never talks to it.**

```
Geofabrik malaysia-latest.osm.pbf   (ODbL, free download)
        ↓  osrm-extract / osrm-partition / osrm-customize   (Docker, one-off, ~20 min)
   local OSRM instance on :5000
        ↓  data/prepare_travel_matrix.py  — POSTs /table/v1/driving/... in batches
   data/travel_matrix.npz   (+ travel_matrix_meta.json)
        ↓  committed or cached, read at API startup
   scheduler/travel.py::lookup(from_id, to_id) -> (km, minutes) | None
        ↓  falls back to haversine × road_factor when the pair is absent
```

Consequences that make this the right shape here:

- The demo machine needs **no Docker, no OSRM, no network**. It reads a file.
- The matrix is **deterministic** — the same input produces the same schedule, which the project
  already protects elsewhere (`demo_clock.today` is pinned for the same reason).
- Regenerating is an explicit, reviewable act, like `prepare_malaysia_dataset.py`.
- **OSRM is BSD-2-Clause**; OSM data is **ODbL**, which requires attribution, not payment. One line
  in the Method page discharges it.

---

## 4. What the matrix must contain — and what it must not

The solver does **not** only measure depot→tower. `optimize.py:417` and `:497` measure the leg
**from where the crew actually is**: the depot for the day's first job, *the previous tower*
thereafter. A depot-only matrix would leave every mid-route leg on the old estimate and produce a
schedule whose first leg is real and whose second is invented — worse than consistent estimation,
because the inconsistency is invisible.

Measured against the live population (1,164 towers, 20 distinct depots across 30 crews,
17 territories):

| Set | Pairs | Note |
|---|---|---|
| depot → tower | 20 × 1,164 = **23,280** | every crew's reachability |
| tower → tower, **all** | 1,164² = 1,354,896 | not needed |
| tower → tower, **same territory** | **149,278** | 11.0% of the full square |
| **Total to compute** | **≈ 172,558** | |

**Restricting tower→tower to within-territory is a real constraint, not an optimisation.**
`optimize.py` filters candidate crews by territory before it ever measures a leg, so two towers in
different states can never be consecutive stops for one crew. Any pair outside the set is
unreachable by construction, and the fallback covers it.

Largest territories: Sarawak 232, Selangor 188, Johor 148, Pahang 96, Kedah 80, Kelantan 78.
Sarawak alone is 53,824 pairs — the biggest single batch, and comfortably within one OSRM `/table`
call series.

Storage: 172,558 pairs × (float32 km + float32 min) ≈ **1.4 MB**. Small enough to commit.

---

## 5. Files

**New**

| File | Purpose |
|---|---|
| `src/backend/data/prepare_travel_matrix.py` | Producer. Batches `/table` requests, writes the npz + meta. Never imported by the app. |
| `src/backend/scheduler/travel.py` | `load_matrix()`, `lookup(from_key, to_key) -> (km, min) \| None`, `matrix_status()`. Pure lookup, no HTTP. |
| `src/backend/scheduler/test_travel.py` | Fallback behaviour, key symmetry, missing-matrix path. |
| `data/travel_matrix.npz` + `.../_meta.json` | The artefact. Meta records OSM extract date, OSRM version, profile, pair count. |

**Changed**

| File | Change |
|---|---|
| `scheduler/optimize.py` | `travel_km()` and the two inline `haversine_km(...) * road_factor` legs consult `travel.lookup()` first. |
| `scheduler/baseline.py:69` | Same, so the greedy-vs-naive delta compares like with like. **Load-bearing** — see §7. |
| `scheduler/explain.py:72,142` | Same, so "why this slot" quotes the number the solver used. |
| `scheduler/override.py:287` | Same, so a pin's recomputed clock matches. |
| `config/policy.yaml` | `travel.source: matrix \| haversine`, and keep `road_factor`/`avg_speed_kmh` as the documented fallback. |
| `api/routes/schedule.py` | Surface `travel_source` on the run so the UI can say which model produced its numbers. |
| `src/frontend/src/lib/ticketSuggestion.ts` | See §6 — this one is subtler than it looks. |
| `src/frontend/src/components/schedule/TicketApprovalPanel.tsx` | Drop `(est.)` when the run reports a real matrix; keep it otherwise. |

**No change:** `agent/`, the risk model, the ticket store, the animation.

---

## 6. The frontend has its own copy of the travel model, and it cannot simply be deleted

`lib/ticketSuggestion.ts` carries `ROAD_FACTOR = 1.35` and `AVG_SPEED_KMH = 45` and computes
`haversineKm(from, tower) * ROAD_FACTOR`. It is **not** dead duplication — it ranks candidate crews
by *where the crew is right now*, derived from `lib/crewPosition.ts`, which is a live position the
backend's matrix cannot be keyed on. A crew mid-route sits at a tower; a crew idle sits at its last
tower; a crew unstarted sits at its depot. All three are matrix keys.

So the frontend does not get its own routing — it gets **the same lookup, over the network**:

- Add `GET /travel?from=<key>&to=<key>` returning `{km, minutes, source}` for a small batch, **or**
  (preferred) have `/schedule/{run_id}` include a `travel` block covering exactly the pairs the
  approval panel could ask about: each candidate crew's current position → the ticket's tower.
  That is at most 30 pairs per ticket and avoids a chatty endpoint.
- `rankSuggestions()` takes the resolved distances as an argument instead of computing them, with
  the haversine path retained as the offline fallback — the same `withOfflineFallback` discipline
  every other query already follows.

**The constants stay exported and stay tested.** `ticketSuggestion.test.mjs` covers them today, and
the offline demo path still needs them. Deleting them to "clean up" would break the offline mode the
project deliberately maintains.

---

## 7. Two behaviour changes this will cause, both intended, one dangerous

**(a) Some dispatches that are possible today will become impossible, and vice versa.**
The depot-range check is `travel_km(crew, tower) > max_travel_km → reject`. Real road distance is
larger than `haversine × 1.35` on most legs, so **crews will drop out of range**, and the count of
`no_crew_type` / out-of-range towers will rise. That is the correct answer replacing a flattering
one, but it will visibly change the board and the "no crew can reach this tower" panel. Expect it,
measure it, and report the before/after count rather than discovering it live.

**(b) The headline metric must not be quietly invalidated.**
`risk_weighted_wait_reduction_pct` is a ratio between the greedy optimiser and `baseline.py`'s
nearest-first dispatch, both run through the same `Optimizer`. **Both sides must move to the matrix
in the same commit.** If only the optimiser gets real distances, the comparison stops being
like-for-like and the headline number becomes meaningless while still rendering plausibly — the
exact failure mode this repo has already documented for `flash_density`, `model_policy_disagreement`
and the GSMaP half-hour factor. `baseline.py:69` is one line and is the whole risk.

---

## 8. Fallback contract — and the resolved sanity-bound question

**Verdict: there is no distance sanity bound, because a distance threshold is the wrong
instrument.** Alor Setar → Langkawi is 84 km and unreachable; Alor Setar → Baling is 60 km up a
trunk road; Kuching → Miri is 534 km and perfectly drivable. No threshold separates those. Anything
that tried would either strand real long land routes or let short sea crossings through — and
Langkawi, the actual bug, is one of the *short* ones.

**The bug is cleared by making the matrix answer three states instead of two.** The ambiguity in
the first draft was that `None` conflated two completely different facts:

| State | Meaning | Encoding | Behaviour |
|---|---|---|---|
| `routed` | OSRM returned a route | km + minutes | use it |
| **`unroutable`** | **OSRM ran and found NO route** | **explicit sentinel + mask bit** | **crew rejected. Never falls back.** |
| `absent` | pair was never computed | not in matrix | fall back to haversine, flagged |

`unroutable` is a **measurement, not a gap** — the single distinction that clears the bug entirely.
OSRM answering "there is no road from Alor Setar to that Langkawi tower" is *information*, and
falling back to haversine after receiving it would be discarding the answer in favour of the guess
it replaced. That is precisely what the first draft did, and it is why it needed a bound to paper
over it. With the three-state encoding, no bound is required and none is used.

`absent` still falls back, per-pair, so a matrix built before a tower was added does not invalidate
the rest of it. `matrix_status()` reports coverage percentage, and regenerating the matrix joins the
dataset-regeneration checklist. A tower added later on an unbridged island would fall back and
reinstate the bug **for that one tower until the matrix is rebuilt** — that is a stale-data problem
with a visible coverage figure, not a modelling hole, and it is the honest residual.

This follows the project's existing rule from CLAUDE.md: **fallback must be real data or `None`,
never a zeroed struct.** A `0.0 km` return would place every crew in range and read as the nearest
possible depot rather than a missing measurement.

### 8a. Ferries: allow, but say so

OSRM's stock `car.lua` **does route over ferries**, assigning them a speed. Left alone, Alor Setar →
Langkawi would come back routable at several hours via the vehicle ferry.

**Keep ferry routing, and carry a `via_ferry` flag per pair.** Excluding ferries would make all 8
Langkawi towers permanently unroutable, and they self-evidently do get maintained — asserting they
cannot be reached is as false as asserting a 151-minute drive. The honest answer is the one that
states the mode: the approval panel shows `4h 10m · includes ferry`, and the planner decides whether
that is acceptable for this crew and this job. A tower reachable only by air stays `unroutable`,
which is then true.

This is the one place free-flow-only bites slightly: a ferry has a timetable, not a speed. The flag
is what makes that visible instead of buried in a number.

---

## 9. What changes on screen

| Surface | Today | After |
|---|---|---|
| Approval panel crew list | `39 km ~51 min drive (est.)` | `41 km · 58 min drive` — no `(est.)` |
| Confirmation | `after a 51 min drive` | real minutes |
| By-site cell | `4h · 15m drive` | real |
| Crew timeline travel connector | proportional to estimate | proportional to route |
| Method page | — | one line: routing by OSRM (BSD-2), road data © OpenStreetMap contributors (ODbL), extract date |
| Run metadata | — | `travel_source: matrix \| haversine` |

The ODbL attribution line is **required**, not optional, and is the entire licence cost.

---

## 10. Verification

- `scheduler/test_travel.py` — lookup hit, lookup miss → `None`, fallback arithmetic unchanged,
  missing-matrix startup, coverage reporting.
- **The Langkawi case is THE acceptance test** (§1a). `MY_W1315123577` and its 7 neighbours must
  come back either `unroutable`, or `routed` with `via_ferry: true` and a duration in hours — never
  a ~151-minute road drive, and never a haversine fallback. Assert it as a test, not a spot check:
  a regression here is silent and puts a crew on a boat it did not book.
- **Sanity pairs, by hand against a map**: Subang Jaya → a Klang Valley tower (detour index ≈
  1.2–1.4); Georgetown → a Penang Island tower (**must route** — the bridge exists, so an
  `unroutable` here means the profile or the extract is wrong); Kuching → Miri (534 km straight-line,
  **must route** — this is the pair a naive distance bound would have wrongly rejected).
- **Assert `unroutable` is never silently downgraded to `absent`.** They take different branches and
  only one falls back; conflating them is exactly the bug this design exists to clear.
- Full `pytest` — **275 passing** before and after, except tests that assert specific distances,
  which must be updated deliberately and named in the commit.
- Re-measure and report: towers in range before vs after; `risk_weighted_wait_reduction_pct` before
  vs after (both sides on the matrix).
- Browser: approve a dispatch, confirm the panel drops `(est.)` and the minutes match the run.

---

## 11. Risks

| Risk | Mitigation |
|---|---|
| Headline metric silently invalidated | §7(b) — both sides in one commit, non-negotiable |
| Matrix built from a stale OSM extract | `_meta.json` records the extract date; `matrix_status()` surfaces it |
| An unbridged island reads as drivable | §8's three-state encoding; §10's Langkawi test |
| A regenerated dataset adds towers the matrix lacks | Per-pair fallback (§8) plus coverage % |
| 1.4 MB artefact in git | Acceptable; if it grows, cache it like `data/malaysia/cache` |
| Docker unavailable to a teammate | Producer-only. The committed artefact means nobody else needs it |
| Free-flow ≠ real drive time | Stated on the Method page. Free-flow is a *route*, which the constant never was — the improvement is real even without traffic |
| A ferry leg is a timetable, not a speed | §8a's `via_ferry` flag surfaces the mode rather than burying it in a duration |
| A tower added after the build sits on an island | Falls back and reinstates the bug for that tower until rebuild; `matrix_status()` coverage makes it visible. Stated residual (§8) |

---

## 12. Out of scope

- Traffic, time-of-day, and historical speed profiles.
- Live re-routing during a shift.
- Any runtime dependency on a routing service.
- Changing `duration_hours` (on-site time) — it is not a travel quantity.
- The agent's `optimize_schedule_tool` date-anchor gap (a separate known defect).
