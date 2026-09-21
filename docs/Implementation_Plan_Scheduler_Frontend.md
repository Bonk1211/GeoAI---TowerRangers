# Implementation Plan — Scheduler + Frontend

**Audience: you.** Derived from [Integration_Gaps.md](Integration_Gaps.md); the ML half is [Implementation_Plan_ML.md](Implementation_Plan_ML.md).

**Every step here runs with zero ML dependency.** Steps 1–7 take today's ML artefacts exactly as they are — degenerate risk distribution and all — and produce a working end-to-end demo. ML improvements then land into a system already carrying traffic.

**AOI: Sunway, Selangor.** Settled.

---

## 0. The order, and the one reason it is this order

| Step | Side | Cost | Blocked by | Produces |
|---|---|---|---|---|
| **1** Relocate crews + fixtures to Selangor | scheduler | 20 min | — | Non-empty schedule |
| **2** Relocate frontend fixtures + map view | frontend | 15 min | — | Map matches the data |
| **3** Adapter reads the real ML CSV | scheduler | 45 min | — | Real towers over HTTP |
| **4** Derive the missing contract fields | scheduler | 45 min | 3 | Full record shape |
| **5** API client + one live page | frontend | 45 min | 3 | First real network call |
| **6** Wire remaining pages | frontend | 1 h | 5 | End-to-end demo |
| **7** Offline fallback + error states | frontend | 30 min | 6 | Demo survives a dead laptop |
| **8** Adopt ML improvements | both | ongoing | ML | Quality, not function |

**Step 1 is first because its failure is silent.** The optimizer filters candidate crews by exact territory string ([optimize.py:139](../src/backend/scheduler/optimize.py#L139)):

```python
if territory is not None and crew["territory"] != territory:
```

Kelantan-tagged towers against Selangor crews return an **empty schedule with no error**. Nothing logs, nothing throws. The most expensive kind of bug to meet live.

**Verify after every step.** A step is not done until its check passes.

---

## STEP 1 — Relocate crews and fixtures (scheduler, 20 min)

### 1a. Crew roster

[`src/backend/config/crews.json`](../src/backend/config/crews.json) holds two placeholder Selangor crews (`SEL-C1`, `SEL-R1`) among 28 national ones. Selangor now needs the depth Kelantan had — **five crews, all four crew types**, with named members so the crew view renders something.

| crew_id | Name | Type | Depot | lon, lat | max_travel_km |
|---|---|---|---|---|---|
| `SEL-C1` | Subang Jaya Civil 1 | civil | Subang Jaya | 101.588, 3.045 | 40 |
| `SEL-C2` | Shah Alam Civil 1 | civil | Shah Alam | 101.518, 3.073 | 50 |
| `SEL-P1` | Petaling Jaya Power 1 | power | Petaling Jaya | 101.644, 3.107 | 40 |
| `SEL-E1` | Shah Alam Electrical 1 | electrical | Shah Alam | 101.518, 3.073 | 50 |
| `SEL-R1` | Petaling Jaya RF 1 | rf | Petaling Jaya | 101.644, 3.107 | 60 |

**`max_travel_km` drops from Kelantan's 120–150 to 40–60. Deliberate.** The AOI spans ~15 km; at 120 km the depot-range constraint never rejects anything, and a constraint that never binds is decoration. At 40–60 km it covers Sunway comfortably while remaining a real limit — which matters if a judge asks what the constraints actually do.

Replace `"placeholder"` members with names in the Kelantan roster's style. **Leave every other territory untouched** — they carry the national scalability claim.

Update the `_comment`: Kelantan is no longer the reference AOI.

### 1b. Scheduler fixture

[`src/backend/fixtures/scored_towers.py`](../src/backend/fixtures/scored_towers.py) lines 31–34:

```python
AOI_LON_RANGE = (101.55, 101.68)   # was (101.40, 102.60)
AOI_LAT_RANGE = (3.00, 3.14)       # was (4.60, 6.25)
AOI_TERRITORY = "Selangor"         # was "Kelantan"
```

Fix the comment on line 31 too — it says "Kelantan AOI bounding box".

Leave `FACTOR_BASE_URGENCY_DAYS` alone. It is a mechanism timescale, not geography, and step 4d promotes it to production.

### ✅ Check

```bash
cd src/backend
python -c "
from fixtures.scored_towers import generate_scored_towers
from scheduler.actions import propose_actions
from scheduler.optimize import Optimizer
t = generate_scored_towers().to_dict(orient='records')
m = [x for x in t if x['decision']=='maintain']
wo = [w.to_dict() for w in propose_actions(m)]
e, u, wait = Optimizer().optimize(wo, {x['tower_id']:x for x in m})
print(f'entries={len(e)} unscheduled={len(u)} wait={wait:.1f}')
print('crews used:', sorted({x.crew_id for x in e}))
"
```

**Pass:** `entries` > 0, every crew ID starts `SEL-`.
**Fail (`entries=0`):** territory strings differ. Compare character for character — `"Selangor"` vs `"selangor"` fails silently.

---

## STEP 2 — Relocate frontend fixtures and map (frontend, 15 min)

Cosmetic until step 5, but do it now: a map centred on Kelantan while the API serves Selangor makes wiring bugs indistinguishable from data bugs.

### 2a. Fixture bounds

[`src/frontend/src/fixtures/towers.ts`](../src/frontend/src/fixtures/towers.ts) line 17:

```ts
const SUNWAY_BOUNDS = { lonMin: 101.55, lonMax: 101.68, latMin: 3.00, latMax: 3.14 };
```

Rename `KELANTAN_BOUNDS` throughout. **Leave `MALAYSIA_BOUNDS`** — the greyed national layer is the scalability claim and does not move.

**Drop the scored count to 132** to match the real pilot exactly. 500 fixture towers becoming 132 live is a visible discontinuity at step 5, and someone will ask.

### 2b. Map default view

[`src/frontend/src/components/map/MapView.tsx`](../src/frontend/src/components/map/MapView.tsx) line 16:

```ts
const AOI_CENTER: [number, number] = [101.61, 3.07];
```

Zoom `8` → **`11`**. Sunway spans ~15 km against Kelantan's ~200 km; at zoom 8 the whole scored cluster collapses into a few overlapping pixels.

Rename `zoomToKelantan` (line 79) to `zoomToAoi`. Its one-shot `click`/`dragstart`/`wheel` binding is good behaviour — keep the mechanism, rename the identifier.

### ✅ Check

`npm run dev`. **Pass:** national view first, one interaction zooms to Sunway, dots individually distinguishable — not a blob.

```bash
grep -rin "kelantan" src/frontend/src     # expect no hits
```

---

## STEP 3 — Adapter serving real ML data (scheduler, 45 min)

Decision from [gaps §5.1](Integration_Gaps.md): **the scheduler backend serves the ML routes.** One base URL for the frontend; the ML team keeps working in notebooks.

### 3a. New module

`src/backend/adapter/ml_source.py` — reads `src/backend/model/ml/maintenance_decisions.csv` (132 rows), maps to the [Backend_Handoff §1](Backend_Handoff.md) record shape, caches in memory at import.

| Contract field | Source | Notes |
|---|---|---|
| `tower_id`, `lon`, `lat`, `radio` | direct | |
| `risk` | `oof_maintenance_probability` | **See below — not what the gaps doc guessed** |
| `decision` | `maintenance_decision` | 2 states now, 3 after step 4b |
| `dominant_factor` | `dominant_factor` | direct |
| `territory` | literal `"Selangor"` | Not in the CSV; the AOI is known, not computed |
| `attribution` | derive — step 4a | |
| `risk_lo`/`risk_hi`/`borderline` | derive — step 4c | |
| `urgency_days` | derive — step 4d | |

### ⚠️ On `risk` — chosen by measurement, not by name

The obvious pick is `dispatch_priority_score` — it is named for exactly this job. **Measuring the candidates says otherwise:**

| Column | p10 | p50 | p90 | IQR |
|---|---|---|---|---|
| `technical_risk` | 0.568 | 0.948 | 0.987 | 0.091 |
| `dispatch_priority_score` | 0.542 | 0.871 | 0.937 | **0.113** |
| `oof_maintenance_probability` | 0.005 | 0.124 | 0.942 | **0.529** |

`dispatch_priority_score` is `technical_risk × exposure_factor` ([notebook:298](../notebooks/generate_maintenance_decision_notebook.py)) — multiplying a degenerate score by an exposure term inherits the degeneracy. IQR 0.113 against 0.091 is not a meaningful improvement.

**Use `oof_maintenance_probability`.** IQR 0.529, honestly out-of-fold rather than fitted, and by construction spread across [0,1].

**Two things this obliges you to do:**

1. **Say so in the module docstring and on the Method page.** The displayed risk is a model probability, not the physical index. A judge may well ask why — have the answer ready, and it is a good answer: the index is currently degenerate on this AOI and substituting a held-out probability is more honest than displaying a flat one.
2. **Make it one constant, easy to revert.** Once ML lands the flood recalibration ([ML plan §1](Implementation_Plan_ML.md)), `dispatch_priority_score` becomes the right field — it carries the operational meaning. This substitution is temporary by design.

```python
RISK_COLUMN = "oof_maintenance_probability"   # revert to dispatch_priority_score post-recalibration
```

### 3b. Three routes

New router `src/backend/api/routes/towers.py`, registered in [`main.py`](../src/backend/api/main.py) beside the existing four:

```
GET  /towers      -> list[Tower]     cached adapter records
POST /score       -> list[Tower]     re-score with client weight overrides
GET  /stability   -> Stability       rho_mean, rho_p05, top_decile_retention, draws
```

`/score` takes `{ weights: {factor: number} }` and calls `risk_index.score()` with them — this makes the Weights sliders authoritative server-side ([gaps §5.3](Integration_Gaps.md)). It needs the **feature table**, not the decisions CSV, so load `data/pilot_sunway/tower_feature_table.csv` as well.

`/stability` wraps [`validate.d1_weight_stability`](../src/backend/model/validate.py#L38), which runs 500 draws. **Compute once at startup and cache** — 500 noisy-OR passes per request will visibly stall the Weights page.

Register literal paths **before** parameterised ones, matching the existing `baseline`-before-`schedule` comment in `main.py`.

### 3c. Point the optimizer at real towers

[`schedule.py:57`](../src/backend/api/routes/schedule.py#L57) calls `generate_scored_towers()` directly:

```python
from adapter.ml_source import load_scored_towers
towers = load_scored_towers()      # was generate_scored_towers().to_dict(...)
```

**Keep the fixture importable** — step 7 uses it as the offline fallback and the scheduler tests depend on its determinism. Use an env flag (`USE_FIXTURE=1`) rather than deleting the call.

### ✅ Check

```bash
cd src/backend && uvicorn api.main:app --reload --port 8000
```
```bash
curl -s localhost:8000/towers | python -c "import json,sys; d=json.load(sys.stdin); print(len(d), d[0])"
curl -s localhost:8000/stability
```

**Pass:** 132 records, real `tower_id`s from the CSV, `/stability` returns four numbers.
**Fail (`FileNotFoundError`):** the CSV path resolves against the process CWD. Resolve from `__file__` instead.

---

## STEP 4 — Derive the missing contract fields (scheduler, 45 min)

Four fields [`api/types.ts`](../src/frontend/src/api/types.ts) demands that the CSV does not carry. **All four derivable now**, each later replaceable by a real ML column without the frontend moving.

**Rule for the whole step: every derived field is marked as derived** — in the docstring and on the Method page. Deriving is fine. Deriving silently, so it reads as measured, is not.

### 4a. `attribution` — recompute, don't wait

The feature table has every input and `risk_index.attribution()` is already written:

```python
from model.risk_index import memberships, factor_weights, attribution
import pandas as pd

feat = pd.read_csv("data/pilot_sunway/tower_feature_table.csv")
p = memberships(feat)
p = p.drop(columns=["lightning"], errors="ignore")   # 100% null in this AOI (gaps §4)
risk, shares = attribution(p, factor_weights(p.columns))
```

Join on `tower_id`, attach as a dict per record. **Identical maths to the notebook** — same functions, same params — so it cannot diverge as long as both call `risk_index`. When ML exports shares directly, delete this and read the column; the record shape is unchanged.

⚠️ **Expect flood to dominate.** Mean flood share 0.916, 104/132 above 0.9. Bars will render near-full-width flood on most towers until ML recalibrates `hand_h0`. **This is correct on today's data — do not fix it in the frontend.** Rendering a flat AOI as flood-dominated is the honest output; a cosmetic tweak hiding it is the failure mode.

### 4b. `decision` — three bands

CSV gives two (`MAINTENANCE` 37 / `NO_MAINTENANCE_NOW` 95). Contract wants three.

Band on `RISK_COLUMN`, **capacity-anchored** per [ML plan §6.5 E1](ML_Implementation_Plan.md):

```
maintain = top ~10%   one inspection cycle at current crew capacity
watch    = next ~20%  visible to planners, not dispatched
ok       = remainder
```

**Derive cut points from quantiles of the actual distribution, not hardcoded 0.7/0.4.** Hardcoded thresholds against a p50 of 0.948 put everything in one band.

**Preserve the ML team's own call:** where `maintenance_decision == "MAINTENANCE"`, the tower is `maintain` regardless of quantile. Your banding adds the middle state; it does not overrule theirs.

### 4c. `risk_lo` / `risk_hi` / `borderline`

`d1_weight_stability` runs 500 perturbed draws and discards per-tower spread. Retain it:

```python
draws = np.array(draws)                          # (500, n_towers) — don't reduce
risk_lo = np.quantile(draws, 0.05, axis=0)
risk_hi = np.quantile(draws, 0.95, axis=0)
```

`borderline` = the interval straddles a band edge, so the band is not robust to weight uncertainty. Exactly the tower a planner should check by hand, and what the drawer's borderline ring means.

### 4d. `urgency_days` — you own it, explicitly

[Gaps §2](Integration_Gaps.md) left the owner open. **Decided: scheduler.** The fixture already implements it correctly ([`scored_towers.py:22`](../src/backend/fixtures/scored_towers.py#L22)) — promote `FACTOR_BASE_URGENCY_DAYS` and `_urgency_days()` out of the fixture into a shared module.

Mechanism-weighted, blending base timescales by attribution share. **Not the risk score rescaled** — lightning arrives in days, equipment over quarters; one risk number cannot express that.

**Tell ML it is settled, in writing.** If both sides emit it, the schedule and the drawer contradict each other on screen.

### ✅ Check

```bash
curl -s localhost:8000/towers | python -c "
import json,sys
from collections import Counter
d = json.load(sys.stdin)
req = {'tower_id','lon','lat','radio','risk','risk_lo','risk_hi','decision',
       'borderline','dominant_factor','urgency_days','attribution'}
print('missing:', req - set(d[0]) or 'none')
print(Counter(t['decision'] for t in d))
print('shares sum to 1:', all(abs(sum(t['attribution'].values())-1) < 0.01 for t in d))
print('lo<=risk<=hi:', all(t['risk_lo'] <= t['risk'] <= t['risk_hi'] for t in d))
print('borderline:', sum(t['borderline'] for t in d))
"
```

**Pass:** no missing fields, all three decisions present, shares sum to 1, intervals bracket risk.

---

## STEP 5 — API client and one live page (frontend, 45 min)

**Wire one page fully before touching the others.** Every later page reuses this client; a mistake here made once becomes a mistake made five times if you fan out first.

### 5a. Client

`src/frontend/src/api/client.ts` — thin typed fetch wrappers returning the existing [`api/types.ts`](../src/frontend/src/api/types.ts) types. **Those types are the frozen contract. Do not redefine them** — the adapter conforms to them, not the reverse.

`.env.development`:
```
VITE_API_BASE=http://localhost:8000
```

`.env` files stay out of git; commit `.env.example`.

CORS is already open in [`main.py:16`](../src/backend/api/main.py#L16) (`allow_origins=["*"]`, flagged prototype-only), so no server change needed.

### 5b. TanStack Query on Overview

`QueryClientProvider` at the [`App.tsx`](../src/frontend/src/App.tsx) root, then convert Overview's tower source from the fixture import to `useQuery(['towers'], getTowers)`.

`staleTime: Infinity` for `/towers` and `/stability` — both static per run, and refetching mid-demo makes the map flicker for nothing.

**Three states, all visible:** loading, error, success. A blank map is the worst failure mode on stage — you cannot tell a dead API from an empty result.

### ✅ Check

Both servers up. **Pass:** dots render from the network — confirm in the Network tab, not by looking at the map. Then stop the backend and reload: an **error message**, not a blank map, and not a silent fixture fallback (that arrives deliberately at step 7).

---

## STEP 6 — Wire the remaining pages (frontend, 1 h)

Same client, one page at a time.

**6a. Tower drawer** — reads the same `['towers']` query, no new call. Confirm attribution bars render real shares and the borderline ring appears where step 4c set the flag.

**6b. Schedule** — `POST /schedule/optimize` for the run ID, then `GET /schedule/{run_id}`. **`optimize` is a mutation, not a query** — left as a query, refetch-on-focus silently re-solves the schedule while the user is looking at it. Both views (crew and tower) read one `ScheduleRun`.

**6c. Override and emergency** — `POST /schedule/preview` on interaction, `POST /schedule/pin` on confirm. Preview is non-mutating by design ([schedule.py:113](../src/backend/api/routes/schedule.py#L113)); keep it that way in the UI — **nothing commits until the planner confirms.** Invalidate the run query after a successful pin.

**6d. Why-this-slot** — `GET /schedule/why/{entry_id}`, `entry_id` being the composite `crew_id__day__tower_id` ([schedule.py:90](../src/backend/api/routes/schedule.py#L90)). Deterministic, no LLM. **Keep it visually distinct from the agent chat** — one is a solver explanation, the other a language model, and conflating them undermines the trustworthy half.

**6e. Weights** — sliders call `POST /score`; the server becomes authoritative. Keep [`lib/scorer.ts`](../src/frontend/src/lib/scorer.ts) **only** for the step 7 offline path, marked as such in a comment, or the two implementations drift. Debounce ~300 ms.

**6f. Perception and Method** — mostly static, three required edits:
- Mark **lightning as unavailable for this AOI** (`flash_density` 100% null) rather than listing it as active, and state the index runs on **4 factors** ([gaps §4](Integration_Gaps.md)).
- State which column backs the displayed risk (step 3a) **and why** — this is the substitution a judge is most likely to probe.
- State that `urgency_days` is scheduler-derived (step 4d).

**6g. Cheap and strong — disagreement badge.** `model_policy_disagreement` is already in the CSV: **6 of 132 towers** where the learned model and the policy rule disagree. Pass it through the adapter and badge them in the drawer — *"model and policy rule disagree — worth a human look."* ~20 min, and it demonstrates the human-in-the-loop claim with real output instead of asserting it.

### ✅ Check

Walk the [Frontend_Handoff §5](Frontend_Handoff.md) five must-works against live data. **No page may still import from `src/fixtures/` on its primary path** — grep for it.

---

## STEP 7 — Offline fallback (frontend, 30 min)

Competition venues have bad wi-fi. This is not polish.

Wrap the client: on network failure fall back to the fixture module **and set a visible banner** — *"offline data — API unreachable."*

**Never fall back silently.** A demo showing fixture data while you narrate it as live is worse than one that visibly failed.

Keep fixture bounds identical to the AOI (step 2a) so the fallback is not obviously different geography.

### ✅ Check

Kill the backend mid-session. **Pass:** app keeps working, banner visible, nothing claims the data is live.

---

## STEP 8 — Adopt ML improvements

All quality, not function. The demo works without every one of these.

| ML delivers | You do | Effort |
|---|---|---|
| Flood recalibration ([ML §1](Implementation_Plan_ML.md)) | **Flip `RISK_COLUMN` to `dispatch_priority_score`**, update Method page | 15 min |
| Attribution shares as columns | Delete step 4a recompute, read the column | 10 min |
| Three-band `decision` | Delete step 4b banding, pass through | 15 min |
| `risk_lo`/`risk_hi` | Delete step 4c, read columns | 15 min |
| AHP re-derived over 4 factors | Nothing — `factor_weights()` reads it | 0 |

**Every derived field is designed to be deleted.** That is why step 4 derives into the same record shape ML will eventually emit.

**Chase them for the flood recalibration only.** It is the sole item that changes what a judge sees, and it is what lets you put the physical index back at the centre of the demo instead of a model probability.

---

## 9. Time to a working demo

| Milestone | Cumulative |
|---|---|
| Non-empty Selangor schedule (1–2) | ~35 min |
| Real ML data over HTTP (3–4) | ~2 h 05 |
| First live page (5) | ~2 h 50 |
| **Full end-to-end demo (6)** | **~3 h 50** |
| Demo-safe with fallback (7) | ~4 h 20 |

**About half a working day, blocked on nobody.**

---

## 10. Traps

- **Territory string mismatch** empties the schedule silently. No error. Step 1's check catches it; nothing else will.
- **Do not cosmetically fix flood dominance.** It is the honest rendering of a flat urban AOI on current parameters. It gets fixed in the membership curve or stated plainly — not in CSS.
- **`/stability` uncached** runs 500 noisy-OR passes per request and stalls the Weights page.
- **Do not redefine the frontend types.** `api/types.ts` is the contract; the adapter conforms to it.
- **Silent fixture fallback** is the single most dangerous shortcut here. Banner or bust.
- **Route shadowing** — literal paths register before parameterised ones. `main.py` already carries this comment for `baseline` vs `schedule`.
- **`optimize` is a mutation.** As a TanStack query, refetch-on-focus re-solves the schedule under the user mid-demo.
- **`RISK_COLUMN` is a temporary substitution.** Leave it undocumented and it looks like the physical index when it is a model probability.

---

## 11. What is already right

Do not "fix" any of this during integration:

- The scheduler API works end-to-end over HTTP against its fixture — routes, override preview, emergency dispatch, baseline comparison.
- The frontend implements every component the build plan specifies, including override, both schedule views, and the evidence pages.
- Non-mutating preview is correctly separated from committing pin.
- The deterministic why-this-slot path is correctly separated from the agent.
- Config-driven crews, policy, and actions — no hardcoded rosters.
