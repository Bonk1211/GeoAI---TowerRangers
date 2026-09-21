# Backend Handoff — Scheduler Build Brief

**Covers:** the maintenance scheduler — action mapping, the optimizer, human override, the agent tool surface, and the API that serves them.

**Does NOT cover:** the risk index, membership curves, AHP weights, the decision layer, or rank-stability validation. **Those are owned by the ML teammates** ([ML_Implementation_Plan.md](ML_Implementation_Plan.md) phases C, D, E). Nor geoai perception, which runs offline on Colab.

**Context:** a risk index scores every Malaysian tower and explains *which* factor drives the risk. This service takes those scored towers and answers the next three questions — *what maintenance does each need, who goes, and when.* Competition prototype, ~1 day.

Detail lives in [PRD_Agentic_Maintenance_Scheduler.md](PRD_Agentic_Maintenance_Scheduler.md). Where it disagrees with this page, it wins.

---

## 0. Ground rules

1. **The scored-tower record is your input boundary.** You consume it (§1); you never compute it. If a field is missing or wrong, raise it with the ML owners — do not reimplement scoring locally.
2. **Start on mock scored towers.** The ML side is building in parallel. Generate a fixture matching §1 in the first thirty minutes and build everything against it. Swap in the real endpoint when it lands.
3. **The optimizer decides; the LLM never does.** The agent emits constraints and explanations. Every schedule the UI shows is a return value of the solver. This is the project's central pitch line — do not blur it.
4. **Config over code.** Crew roster, policy thresholds, urgency base-days, part lead times — editable data files, not literals buried in functions. They must be auditable and tunable during the demo.
5. **Capacity is deliberately short.** Do not tune the roster until everything fits. The backlog is what makes risk *ordering* meaningful.
6. **Never fabricate a failure label**, and never expose an endpoint implying failure probability. This system schedules maintenance *need*, not predicted failure events.

---

## 1. Input contract — what the ML side hands you

One record per tower. **You consume this; you do not produce it.**

```python
{
  "tower_id": "MY_1042",
  "lon": 102.21, "lat": 5.88,
  "radio": "LTE",
  "risk": 0.82, "risk_lo": 0.76, "risk_hi": 0.88,
  "decision": "maintain",           # maintain | watch | ok
  "borderline": False,
  "dominant_factor": "flood",       # argmax of attribution
  "urgency_days": 14,
  "attribution": {                  # factor → share, sums to 1.0
    "flood": 0.41, "power": 0.28, "terrain": 0.19, "equipment": 0.12
  }
}
```

**Two fields do all the work for you:** `dominant_factor` selects the intervention (§3), and `urgency_days` becomes the scheduling deadline. `attribution` is passed through verbatim into the work order's `why` string so the explanation chain stays unbroken from imagery to crew brief.

**Observed fire exposure is not in this record, and must never be added to it.** The record above is the whole tower contract: no `fire` key in `attribution`, no fire value for `dominant_factor`, nothing on `risk`/`risk_lo`/`risk_hi`. Hotspot evidence reaches you by two other routes only — the separate `GET /fire/exposure` response, which is read beside the score rather than inside it, and a `fire_inspection` block on the **work order** raised by `propose_fire_inspection()`. That is a sibling of `propose_action()`, not a widening of it: `propose_action` keys on `dominant_factor` and renders `why` from `attribution`, and a fire inspection has neither, so its `why` is an evidence sentence ("fire exposure observed: N hotspot detection-days within 5 km …") rather than an attribution sentence. The reason is §0.6. A 375 m thermal anomaly can be a plantation burn, a flare or hot bare ground; giving it an attribution share would let the argmax dispatch a crew off a satellite's guess at what is warm, which is precisely the failure signal this system may not invent. The evidence is server-derived on every request — a client posts only which snapshot it reviewed and that access was confirmed, never a pixel count it could choose.

**Coordination points with the ML owners** — settle these early, they are cheap now and expensive later:
- Confirm `urgency_days` is mechanism-weighted, not the risk score rescaled. A lightning-driven tower is more urgent than an equally-scored equipment-driven one because the failure mode arrives sooner. If they have not built it that way, that is their fix, not yours.
- Confirm ties in `attribution` are resolvable — you need a deterministic dominant factor.
- Agree how estimated factors are flagged, so work orders built on estimates can be marked in the UI.

---

## 2. Layout

```
src/backend/
  scheduler/
    actions.py        dominant factor → work order
    optimize.py       greedy assignment under constraints
    override.py       pinning, preview, emergency insertion
    explain.py        deterministic "why this slot"
    baseline.py       naive-dispatch comparison (the metric)
  config/
    crews.json        roster: depots, territories, members
    actions.yaml      factor → intervention, crew type, parts, lead time
    policy.yaml       SLA caps, shift hours, travel assumptions, monsoon window
  agent/
    tools.py          the four tools, typed
    runner.py         tool-calling loop, SSE
  api/
    main.py           FastAPI app
    routes/
  fixtures/
    scored_towers.py  mock input until the ML endpoint lands
```

---

## 3. Build order

Hand back for review after **step 3**, **step 5**, and **step 8**.

| # | Step | Est | Done when |
|---|---|---|---|
| 1 | Mock scored-tower fixture matching §1 | 0.5 h | ~500 towers, ~7% maintain, plausible attribution |
| 2 | Crew roster config — depots, territories, types, members | 0.5 h | ~5 Kelantan crews + placeholders per state |
| 3 | Action mapping: dominant factor → work order | 0.75 h | **Action, crew type, parts, `why` string** ← review |
| 4 | Greedy optimizer with all constraints | 2 h | Assignments + explicit unscheduled list |
| 5 | Deterministic "why this slot" | 0.5 h | **Renders from solver state, no LLM** ← review |
| 6 | Override: pin, preview, emergency insertion | 1.5 h | Preview returns knock-on cost without mutating |
| 7 | FastAPI routes (§6) | 1.5 h | All endpoints return the frontend's frozen shapes |
| 8 | Agent tool surface + SSE loop | 2 h | **Four tools; constraint echoed before solving** ← review |
| 9 | Baseline comparison + policy delta | 0.75 h | Greedy vs nearest-first, risk-weighted wait |

---

## 4. The optimizer

### Objective

Minimize **risk-weighted unserviced time** — every day a risky tower waits costs its priority:

```
minimize   Σ_t  priority_t × days_until_serviced_t   +   λ · travel_cost
where      priority_t = risk_t × log1p(exposed_pop_t)
           (falls back to risk_t when exposure is unavailable)
```

### Constraints — all of these, none optional

| Constraint | Why it matters |
|---|---|
| **Territory** — tower assignable only to a crew covering it | Without it the solver sends Kota Bharu civil to Johor. Judges spot this instantly. |
| **Depot range** — and whose depot is within `max_travel_km` | Makes travel cost meaningful |
| **Crew type** — work order's `crew_type` must match | A power tech cannot do civil drainage work |
| Shift hours / jobs per crew-day | Capacity |
| Travel time between towers | Haversine × road-factor from depot; OSRM only if trivial |
| SLA cap — `urgency_days` from the input record | The deadline |
| **Pinned assignments** | Planner overrides are hard constraints (§5) |
| **Weather window** — no civil work in flood-zone towers during monsoon | Reuses the index's flood layer — the one place the two features genuinely interlock |

### Implementation

**Greedy first, and it may be all you ship.** Sort by `priority × urgency_factor`, bin-pack into crew-days with nearest-neighbour routing. ~50 lines, always terminates, fully explainable.

OR-Tools VRPTW is optional. **If it lands, keep greedy as the documented baseline** — the delta between them is the metric.

**Return unscheduled work explicitly.** Never silently drop a tower that did not fit.

---

## 5. Human override — the adoption story

No planner adopts a scheduler they cannot overrule. Three situations, **one mechanism**:

| Situation | Action |
|---|---|
| Wrong day or wrong crew | Move — pin to a different cell |
| Site is down now | Emergency — force into today |
| Whole week is wrong | Adjust constraints, re-run |

All three are **pinning**: a pinned assignment becomes a hard constraint and the solver re-solves everything else around it.

```python
ScheduleEntry {
  ...
  pinned: bool
  pin_reason: str | None     # "planner_override" | "emergency"
  pinned_by: str | None
}
```

**Two hard requirements:**

1. **Preview must not mutate.** `/schedule/preview` computes knock-on effects and returns them; `/schedule/pin` commits. This separation is what lets the UI show an override's cost before the planner accepts it.
2. **Never block an override.** Show the cost — which jobs slip, by how many days, the change in risk-weighted wait — then let the planner proceed. They hold information the model does not.

Emergency insertion must return **what it displaced**, including anything pushed off the schedule entirely.

Log overrides. *"The planner overrode 3 of 34; the rest held"* is an adoption signal no invented ROI figure can match.

---

## 6. Endpoints

Shapes are frozen — the frontend is already building against them ([Frontend_Build_Plan §5](Frontend_Build_Plan.md)). Mirror those types exactly.

```
GET  /crews                  -> Crew[]
POST /schedule/optimize      -> { run_id }
GET  /schedule/{run_id}      -> ScheduleRun        entries + unscheduled + objective
GET  /schedule/why/{entry}   -> WhySlot            deterministic, no LLM
POST /schedule/preview       -> OverridePreview    no mutation
POST /schedule/pin           -> ScheduleRun        commit + re-solve
POST /schedule/emergency     -> OverridePreview | ScheduleRun
GET  /schedule/baseline      -> baseline run       nearest-first, for the risk-weighted-wait delta
POST /agent/chat             -> SSE stream
GET  /model/health           -> { report, serving, ledger } training-run report + THIS process's state + observation counts
GET  /flood/layers           -> LayerCatalogue     + earth_engine credential status
GET  /flood/tiles/{layer}    -> LayerTiles         ?date= &sensor=
GET  /land/layers            -> LayerCatalogue     peer catalogue, no sensor choice
GET  /land/tiles/{layer}     -> LayerTiles         ?date=
GET  /fire/layers            -> LayerCatalogue     one layer, active_fire
GET  /fire/tiles/{layer}     -> LayerTiles         ?date=  no sensor; populates snapshot_id
GET  /fire/exposure          -> FireExposure       ?date=  per-tower hotspot screening
```

**The list had drifted, and everything below `/agent/chat` in the original block is a record rather than a new promise.** `/schedule/baseline`, the flood and land catalogues and `/model/health` were all serving before this section was updated, so a reader treating §6 as the API surface was reading an older snapshot of it. The eight original lines are still the frozen scheduler shapes; the added lines are what the app actually exposes today.

**Owned by the ML side, not you:** `GET /towers`, `POST /score`, `GET /stability`. Agree early whether they serve those routes from the same FastAPI app or a separate one — either works, but the frontend needs one base URL.

---

## 7. The agent

Four tools, typed, deterministic underneath:

```
score_towers(weights?)          -> ranked towers + attribution   [proxies to ML side]
propose_actions(tower_ids)      -> work orders                   [yours]
optimize_schedule(orders, ctx)  -> crew/day assignment           [yours]
apply_constraint(nl_text)       -> parsed constraint + revised context  [yours]
```

- **The LLM may never emit a schedule.** It calls `optimize_schedule` and reports what came back.
- **Echo the parsed constraint before solving**, so parse errors are visible rather than silent. *"Understood: KEL-C2 unavailable Thursday 20 Aug. Re-optimize?"*
- **"Why this slot" is not an agent feature.** It derives from solver state and must render with the LLM down or slow. Plain endpoint, built at step 5, before the agent exists.
- **Natural-language override costs nothing extra.** *"Send someone to 0994 today"* routes through `apply_constraint` → pin → preview → confirm, the same path as a click.
- Mirror the tool-definition pattern in `geoai/agents/geo_agents.py` (Strands-based) as prior art, but **do not import it** — it targets notebooks (`ipywidgets`, `IPython.display`).

---

## 8. Tests worth writing

- No tower assigned to a crew outside its territory or beyond `max_travel_km`.
- No work order assigned to a mismatched `crew_type`.
- Pinned assignments survive re-optimization.
- `/schedule/preview` leaves stored state byte-identical.
- Emergency insertion returns a displacement list that accounts for every moved or dropped job.
- Unscheduled towers are returned, never silently dropped.
- Civil work is not scheduled into flood-zone towers inside the monsoon window.
- Every work order's `crew_type` and `parts` are derivable from its `dominant_factor` via config, not hardcoded.

---

## 9. Reviewer pass

After steps 3, 5, and 8. **Scope:** correctness of action mapping, scheduling, and override logic. Not the ML, not the frontend, not API style.

Check, in priority order:

1. **Contract conformance** — endpoints return exactly the frozen shapes; `unscheduled`, `pinned`, `pin_reason` present and populated, not stubbed.
2. **Constraint enforcement** — attempt an assignment violating each constraint in §4 and confirm rejection. Territory and crew-type violations are the most likely to pass silently.
3. **Preview purity** — `/schedule/preview` must not mutate stored state.
4. **Override never blocked** — cost is reported, but the planner can always proceed.
5. **Emergency displacement completeness** — every job moved or dropped appears in the response.
6. **"Why this slot" independence** — renders with the agent disabled.
7. **Config-driven, not hardcoded** — changing `actions.yaml` or `crews.json` changes behaviour without touching code.
8. **Honesty rules** — no endpoint implies failure probability; no assignment labelled "AI-assigned"; assumed parameters identified as such.

**Output:** one line per finding, `path:line: <severity>: <problem>. <fix>.` Most severe first. No praise, no refactor suggestions.

---

## 10. Open items

- **Integration point with the ML side.** Agree the scored-tower shape and the base URL early. Until then, `fixtures/scored_towers.py` stands in.
- **Baseline comparison (step 9)** is the headline metric: *"risk-weighted wait reduced X% versus nearest-first dispatch at identical crew capacity."* Comparing two dispatch policies on identical demand is a legitimate quantitative claim — unlike accuracy, which the index cannot claim.
- **Crew data is mock** — rosters, depots, shift hours, part lead times. Expected and stated; nobody has a telco's crew records. Label assumed parameters in the API response so the UI can tag them.
