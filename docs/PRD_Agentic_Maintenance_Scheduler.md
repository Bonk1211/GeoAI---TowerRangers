# PRD — Agentic Maintenance Scheduler

**Team TowerRangers (HACK-MY-093)**
**ASEAN GeoAI Fusion 2026 · Innovation track**
**Version:** 1.0 · **Companion to:** [PRD — Tower Health Risk Index](PRD_Tower_Health_Risk_Index.md), [ML Implementation Plan](ML_Implementation_Plan.md)
**Prototype window:** ~1 day, shared with the index build

---

## 1. One-liner

The index says **which towers are fragile and why**. This layer turns that into **what to fix, when, and who goes** — an agent that maps each tower's dominant failure driver to a concrete intervention, packs those interventions into crew-days under real constraints, and replans in natural language when the world changes.

---

## 2. Why this completes the story

The index alone stops at a ranked list. A ranked list is not a decision. The product arc that judges can follow end-to-end is:

```
detect  ──►  decide  ──►  dispatch
(index)      (action)     (schedule)
```

**The load-bearing dependency:** per-factor attribution (§C4 of the ML plan) is what makes "what to fix" derivable at all. A tower scored 0.82 *because of flood* needs drainage and cabinet-raising; the same 0.82 *because of equipment generation* needs a radio refresh and a capex line. Same score, different crew, different parts, different lead time. **Attribution is the join key between the two features** — which is why the ML plan marks it "never cut."

---

## 3. What this is — and deliberately is not

**Is:** a constrained **optimizer** wrapped in an agent. The objective is definitional (minimize risk-weighted exposure time under crew/travel/parts constraints), so unlike the index, **this layer has a legitimate quantitative claim**.

**Is not:** an LLM that invents schedules. The agent **calls tools**; deterministic code decides. The LLM's job is the part no solver can do — turning "Ahmad is on leave Thursday and the Kelantan road is washed out" into constraints, and explaining what changed after a replan.

> Pitch line: *"The model never writes a schedule. It writes constraints, and a solver writes the schedule. That's the difference between an agent and a hallucination."*

**Honesty carry-over:** this layer schedules maintenance that the index has *predicted the need for* — the project claims predictive maintenance as a category (see [Concept Overview §5](Concept_Overview.md)). What stays off-limits is unchanged: no failure probabilities, no accuracy claims. Here we say *prioritize*, *assign*, and *schedule*.

---

## 4. Users

Same population as the index, one step later in their workflow:

- **Primary:** field-maintenance planners — currently schedule by calendar cycle or complaint, not by risk.
- **Secondary:** network-ops planners sizing crews and hardening capex.
- **Crews themselves:** consume the generated work order (action + parts + why).

---

## 5. Product outputs

1. **Work order per at-risk tower** — action, crew type, parts list, urgency, and the attribution sentence that justifies it.
2. **Crew schedule** — assignment of work orders to (crew, day), with route order.
3. **Agent chat** — natural-language constraint entry and replan, with a diff of what moved and why.
4. **Policy-comparison metric** — risk-weighted response time vs. a naive dispatch baseline.

---

## 6. E1 · Action mapping (attribution → intervention)

Deterministic lookup, no ML. The dominant attribution share selects the intervention; ties emit both.

| Dominant factor | Intervention | Crew type | Parts | Lead time |
|---|---|---|---|---|
| Flood | Raise equipment cabinet, seal ingress, clear/​install drainage | Civil | Sealant, cabinet riser, sump | Weeks |
| Terrain | Slope stabilization, access-road check, guy-wire tension | Civil + rigger | Anchors, guy-wire | Weeks |
| Lightning | Surge-arrestor swap, ground-resistance test | Electrical | Arrestor, earth rod | Days |
| Equipment | Radio-unit refresh, spares pre-stage | RF tech | RRU/BBU per generation | Months (capex) |
| Power distance | Battery-bank test, genset service, fuel top-up | Power | Batteries, filters, fuel | Days |

**Output record:**

```python
{
  "tower_id": "MY_1042",
  "risk": 0.82,
  "action": "raise_cabinet_and_seal",
  "crew_type": "civil",
  "parts": ["cabinet_riser", "sealant_kit"],
  "urgency_days": 14,
  "why": "flood 0.41, power 0.28, terrain 0.19, equipment 0.12",
}
```

`why` is copied verbatim from C4 attribution — the explainability chain runs unbroken from raw DEM pixel to the sentence a crew reads.

---

## 7. E2 · Schedule optimizer (the "when")

### 7.1 Objective

Minimize **risk-weighted unserviced time** — every day a risky tower sits unserviced costs its priority:

```
minimize   Σ_t  priority_t × days_until_serviced_t   +   λ · travel_cost
where      priority_t = risk_t × log1p(exposed_pop_t)      # ML plan §C5
           (falls back to risk_t when exposure is unavailable)
```

**Terminology guard:** "exposure" is overloaded in this project. `exposed_pop` = **population affected** (consequence). "Unserviced time" = how long a tower waits. The objective weights the second by the first × risk. Never write "risk-weighted exposure" unqualified in the writeup or the slides.

### 7.2 The crew model — territories and depots

Crews are **not** interchangeable national resources. Each has a home depot and a territory, and that is what makes the travel term in the objective meaningful — without a depot there is no origin to measure from.

```json
{
  "crew_id": "KEL-C1",
  "name": "Kota Bharu Civil 1",
  "crew_type": "civil",
  "depot": { "lon": 102.238, "lat": 6.125, "name": "Kota Bharu" },
  "territory": "Kelantan",
  "max_travel_km": 120,
  "shift_hours": 8,
  "members": ["Ahmad R.", "Faizal M.", "Suriani A."]
}
```

**Naming:** territory-prefixed (`KEL-C1`, not `C1`) so the constraint is legible in the UI without explanation.

**Assignment granularity is the crew, not the individual.** Rostering individuals is a separate problem we do not have time for. Members are still listed, because it is what makes an agent constraint resolve to something concrete: *"Ahmad on leave Thursday"* becomes *"KEL-C1 drops to 2 of 3 members Thursday — capacity reduced,"* rather than being unrepresentable.

**Reference roster (mock, national).** ~16 territories (13 states + 3 federal territories), each with civil / power / electrical / RF crews and one or two depots. Depth is concentrated in scored AOIs; unscored states carry a placeholder crew so the national picture holds without inventing detail that would have to be defended.

### 7.3 Constraints

| Constraint | Source |
|---|---|
| **Territory** — a tower is assignable only to a crew whose territory covers it | Crew config |
| **Depot range** — and whose depot is within `max_travel_km` | Crew config |
| **Crew type** — work order's `crew_type` must match the crew | E1 action mapping |
| Crew count, shift hours per day | Config (assumed for demo, stated as assumption) |
| Travel time between towers | Haversine × road-factor from depot, or OSRM if trivial |
| Part availability date | Parts table (`urgency_days` from E1) |
| SLA cap — any tower above threshold serviced within D days | Policy config |
| **Pinned assignments** — planner overrides are hard constraints | §7.5 |
| **Weather window** — no civil work in flood-zone towers during monsoon | **Reuses the index's own flood layer** |

The territory and depot-range constraints are not decoration: without them the optimizer will happily send a Kota Bharu civil crew to Johor, which any operator spots immediately.

The weather-window constraint is the one place the two features genuinely interlock rather than merely chain: the hazard layer computed for scoring is re-read as a scheduling feasibility mask. ~10 lines, disproportionate demo value.

**Capacity will not be sufficient, and that is correct.** With ~34 maintain-band towers against ~25 crew-days — and crew-type matching further constraining it — some work goes unscheduled. Do not tune the roster until everything fits. A visible backlog is what makes risk ranking *matter*: when capacity is short, order is the whole product. Surface unscheduled work explicitly (frontend §10).

### 7.4 Two implementation tiers

- **Ship-now (must):** greedy priority — sort by `risk × urgency_factor`, bin-pack into crew-days with nearest-neighbour routing. ~50 lines, always terminates, fully explainable.
- **Better (optional):** OR-Tools `routing` VRPTW, penalty-for-dropped-node = tower risk. ~2 h to wire.

Same discipline as noisy-OR vs. weighted-sum: **the greedy stays in as a documented baseline** even after OR-Tools lands, because the delta between them *is* the metric.

### 7.5 Human override — the optimizer proposes, the planner disposes

**No planner adopts a scheduling tool they cannot overrule.** Override is not a concession to a weak model; it is the same posture the index already takes. The index says *"we do not claim to be right, we claim to be auditable."* Override applies that to dispatch. A judge asking "would an operator actually trust this?" gets a concrete answer.

Three override situations, **one mechanism**:

| Situation | Planner action |
|---|---|
| "This job is on the wrong day / wrong crew" | Move it — drag to another cell |
| "This site is down **now**" | Emergency dispatch — force into today |
| "This whole week is wrong" | Adjust constraints, re-run |

All three resolve to **pinning**. A pinned assignment becomes a hard constraint; the optimizer treats it as fixed and re-solves everything else around it. Standard practice in scheduling tools, ~15 lines in the solver.

```python
ScheduleEntry {
  ...
  pinned: bool
  pin_reason: str | None      # "planner_override" | "emergency"
  pinned_by: str | None
}
```

**Two things an override must always show, or it is dangerous rather than useful:**

1. **Its cost.** Pinning a lower-risk tower into Tuesday means something else slips: *"0994 moves to Fri, +3 days unserviced. Risk-weighted wait +8%."* **Never block the override** — planners hold information the model does not — but the trade must be visible before they commit.
2. **What an emergency displaces.** Forcing work into today pushes other work out, possibly off the schedule entirely. Name the displaced jobs.

**Impact preview happens before commit, never after.** Every override renders its knock-on effects with a confirm/cancel step.

**The agent gets override for free.** *"Send someone to 0994 today"* is the same `apply_constraint` path: parse → pin → re-solve → preview → confirm. No new tool, no new solver behaviour — the natural-language route and the click route converge on the same mechanism.

**Overrides are logged**, which yields an adoption signal stronger than any invented ROI figure: *"the planner overrode 3 of 34 assignments; the rest of the plan held."*

---

## 8. E3 · The agentic layer

### 8.1 Where the LLM earns its place

1. **Constraint elicitation** — natural language → solver constraint. No solver does this.
2. **Replan on event** — storm forecast, or a tower's score jumps after a weight change ⇒ re-score, re-optimize, **diff and explain**. This is the agent loop: observe → re-score → re-optimize → justify.
3. **Work-order narrative** — attribution + action → crew-readable brief.
4. **Follow-up questions** — *"why is 1042 before 0871?"* answered against solver state.

**The agent does not schedule, so it cannot be the reason for a schedule.** The reason lives in the optimizer's objective and is derivable from solver state without any LLM:

> *Tower 1042 · Tue 18 · KEL-C1 — risk 0.82, due within 14 days. Scheduled Tuesday: earliest slot where a civil crew within 120 km of its depot has capacity. Monday full (2 jobs); Wednesday blocked by the monsoon window.*

**This "why this slot" readout is deterministic and always renders**, even with the LLM down or slow. The agent sits on top of it for constraints and follow-ups. Keeping the two separate is both an honesty point (the model did not choose this) and a demo-safety property (the explanation cannot fail).

**Wording rule for the UI and the pitch:** the **optimizer assigns** under constraints; the **agent supplies constraints and explains**. Never label an assignment "AI-assigned" — it contradicts §3, which is the strongest line in this document.

### 8.2 Tool surface (LLM orchestrates, code decides)

```
score_towers(weights?)          -> ranked towers + attribution
propose_actions(tower_ids)      -> work orders            (E1)
optimize_schedule(orders, ctx)  -> crew/day assignment    (E2)
apply_constraint(nl_text)       -> parsed constraint + revised context
```

The LLM may **never** emit a schedule directly. Every schedule shown in the UI is a return value of `optimize_schedule`.

### 8.3 Prior art — `geoai.agents`

`geoai/agents/geo_agents.py` ships `GeoAgent` / `STACAgent` / `CatalogAgent` built on **Strands** (`from strands import Agent`), with provider factories (`create_anthropic_model`, `create_openai_model`, `create_bedrock_model`, …) and tool packs (`MapTools`, `STACTools`, `CatalogTools`, `MapSession`).

**Decision: mirror the tool-definition pattern in our backend; do not import it into the web path.** It targets notebooks (`ipywidgets`, `leafmap.maplibregl`, `IPython.display`) and our scheduler tools are domain-specific and absent from it. Cite as prior art; optionally demo `GeoAgent` in a Colab cell as a side artifact.

---

## 9. Headline metric

The index cannot claim accuracy. **This layer can** — because comparing two dispatch policies on identical demand is a policy comparison, not a fabricated label.

> **"Risk-weighted response time reduced X% versus nearest-first dispatch at identical crew capacity."**

Report alongside: mean days-to-service for the top-decile towers, and SLA-breach count under each policy.

---

## 10. Backend surface

**Tables:** `work_orders`, `crews`, `parts_inventory` *(optional)*, `schedule_runs`, `constraints`.

**Endpoints:**

```
POST /schedule/optimize      -> run optimizer, persist schedule_run
GET  /schedule/{run_id}      -> schedule + routes + unscheduled work
POST /schedule/pin           -> pin/unpin an assignment, re-solve  (§7.5)
POST /schedule/preview       -> impact of a proposed override, no commit
POST /schedule/emergency     -> force-insert today, return displacements
GET  /schedule/why/{entry}   -> deterministic "why this slot" readout (§8.1)
POST /schedule/constraint    -> natural-language constraint in
POST /agent/chat             -> SSE stream, tool-calling loop
GET  /crews                  -> roster with depots + territories  (§7.2)
```

`/schedule/preview` and `/schedule/pin` are separate on purpose: preview computes knock-on effects without mutating, so the UI can show the cost of an override before the planner commits.

**Tiering is inherited from the index:** perception stays precomputed. The scorer and the scheduler both run on cached features, so the weight slider still recomputes ranking **and now the schedule** live.

---

## 11. Frontend

Full layout, wireframes, and build order live in the [Frontend Build Plan](Frontend_Build_Plan.md). What this feature requires of the UI:

```
Malaysia map (tower dots — coloured by decision band)
├─ tower click → drawer
│    ├─ score + uncertainty band
│    ├─ factor attribution bars              ← must ship (index core)
│    ├─ recommended action + parts + crew    ← E1
│    ├─ maintenance timeline strip           ← now / scheduled / SLA due / weather window
│    ├─ scheduled slot → links to schedule tab, tower preselected
│    └─ 🚨 dispatch now                      ← emergency override (§7.5)
├─ sidebar: weight sliders
│    └─ rank-stability readout (ρ = …)       ← must ship (validation core)
└─ tab: schedule
     ├─ [ by crew ] / [ by tower ] toggle    ← same data, one groupBy
     ├─ cell click → "why this slot" (deterministic) + pin / move
     ├─ empty-cell click → emergency dispatch for that tower + day
     ├─ unscheduled work, visible                 ← never hide the backlog
     └─ agent chat, below the deterministic readout
```

**Notes**
- Colour bands must be tied to a stated rule (top-decile, or a named risk threshold) and labelled in the legend — never an arbitrary cutoff. Judges probe legends.
- **Per-tower resolution everywhere.** One dot, one row, one score = one physical tower. No state-level aggregation, no choropleth — averaging is exactly what destroys the signal.
- **Schedule cells show place name + risk + dominant factor**, not bare tower IDs. This keeps the explainability thread running into dispatch instead of dropping it at the drawer.
- **Per-tower view uses a timeline strip, not a Gantt.** Work orders are single-visit, so a Gantt would render one bar. A strip showing now → scheduled → SLA due → next weather window carries more information for half the cost. Use a real Gantt only if multi-stage work (survey → parts → civil) lands.
- The agent chat box is small but **carries the entire agentic claim** — without it this reads as a solver, not an agent.
- **Scope is national; perception coverage is staged.** All ~21,000 Malaysian towers render from OpenCellID. The four cheap factors (terrain, lightning, power distance, equipment) are computable nationally; flood and population require geoai perception per AOI. Towers outside a perception AOI carry partial factors and **must be flagged as such in the drawer** — the flag is a roadmap, not an apology.

---

## 12. Scope for ~1 day

**Must ship:** E1 action mapping (~1 h) · greedy scheduler with territory/depot constraints (~2 h) · pinning + override preview (~1 h) · agent with the 4 tools + replan loop (~3 h).

**Cut in order:** OR-Tools VRPTW → parts inventory → multi-week horizon → drag-and-drop override (a dropdown reassignment is 15 minutes and does the same job) → route polylines on map.

**Never cut:** the attribution → action → work-order chain, and human override. The first is why this feature exists rather than being a calendar; the second is why an operator would use it.

**Everything runs on mock crew data initially** — roster, depots, shift hours, part lead times. This is expected and stated; nobody has a telco's crew records. It also unblocks the frontend and the optimizer before any perception finishes. Assumed parameters get labelled in the UI; see [Frontend Build Plan §7.5](Frontend_Build_Plan.md).

---

## 13. Limitations (state openly)

- Crew rosters, depots, territories, shift hours, travel speeds and part lead times are **assumed demo parameters**, not operator data — all stated as assumptions in the UI and writeup.
- The optimizer minimizes risk-weighted unserviced time under those assumptions; it does not model crew skill mix, subcontractor availability, or permit lead times.
- Assignment is at **crew** granularity. Individual rostering is out of scope; member lists exist only so availability constraints resolve to something concrete.
- The baseline comparison is against a simulated naive-dispatch policy, not against a real operator's historical schedule.
- Greedy scheduling is not globally optimal; the OR-Tools tier (if shipped) bounds how far off it is.
- Agent-parsed constraints are shown back to the user for confirmation before entering the solver — parsing errors must be visible, not silent.
- **The optimizer is decision support, not autonomous dispatch.** Every assignment is overridable, override cost is shown but never enforced, and overrides are logged.

---

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| "The LLM is just decoration." | Show the tool-call trace: LLM emits constraints, solver emits schedules. Never a free-text schedule. |
| "Your schedule assumes fake crew data." | State assumptions up front; the *policy delta* is the claim, and it holds under any consistent capacity assumption. |
| Solver runs long mid-demo | Greedy tier is the default path; OR-Tools behind a flag with a cached result. |
| Agent mis-parses a constraint | Parsed constraint echoed to the user for confirmation before the solve. |
| Feature reads as bolted-on | Lead with the weather-window constraint — the hazard layer feeds both scoring and scheduling. |
| "Would a planner actually trust this?" | Human override (§7.5): pin, move, emergency-dispatch, with the cost shown and never enforced. The optimizer proposes; the planner disposes. |
| "A crew can't cover all of Malaysia." | Territory + depot-range constraints (§7.2). Crews are named by territory so the constraint is visible on screen. |
| "Everything fits neatly — did you tune it?" | No. Capacity is deliberately short and the backlog is displayed. Insufficient capacity is what makes risk *ordering* the product. |
