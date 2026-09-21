# Schedule Tab Rework — Design

**Date:** 2026-08-30
**Status:** Design, awaiting review
**Scope:** `src/frontend/src/pages/Schedule.tsx` + `components/schedule/`, `src/backend/scheduler/optimize.py`, `src/backend/config/policy.yaml`, `api/schemas.py`

---

## 0. Why this rework

The Schedule tab is the "dispatch" third of the product arc. Its machinery is sound — solver-derived clocks, real preview/pin endpoints, honest offline fallback — but the surface around that machinery has three structural problems and one identity problem.

**Structural**

1. **Selection granularity is `{crew_id, day}`, not per-job.** `WhySlotPanel` resolves the cell with `run.entries.find(e => e.crew_id === … && e.day === …)` — the *first* match only. In `GanttBoard`, every bar in a lane receives `selected={isSelectedCrew}`, so all bars highlight together and clicking the second job of a day shows the first job's explanation and move control. The tab's core promise — *interrogate any placement* — is broken on exactly the days that matter most.
2. **Two days of the plan are invisible.** `policy.yaml` sets `planning_horizon_days: 7`; `lib/scheduleDays.ts` hardcodes five ISO dates. Work the solver books on days 6–7 renders in no tab, no column, and no move dropdown. It is silently dropped from the UI while the backend considers it scheduled — a direct violation of *"unscheduled/displaced work is always returned explicitly"*, one layer up.
3. **The right column is always mounted and always costs 360px**, even with nothing selected, where it shows only placeholder prose. The calendar — the thing the planner actually reads — is squeezed for a panel that is empty most of the time.

**Identity**

4. **Four of the five role teams never appear.** On the Sunway AOI every maintain-band tower resolves to `flood` → `civil`, so only `SEL-C1`/`SEL-C2` are ever drawn. `SEL-P1` (power), `SEL-E1` (electrical) and `SEL-R1` (rf) exist in `crews.json` and are correctly mapped in `actions.yaml`, but the board never shows them. The result reads as one undifferentiated pool of "crews" rather than five distinct capabilities answering five distinct risk factors.

**And one honesty defect that must not survive the rework**

5. `AgentChat` is labelled **"Optimizer"**, offers a **"Re-optimize"** button, replies **"Re-optimized. 3 changes"** — and is entirely client-side. It imports `lib/mockReplan.ts` (a regex parser plus a local reshuffle), writes results straight into the store via `useScheduleStore.setState`, and fabricates the objective as `risk_weighted_wait * (1 + dropped * 0.05)`. `POST /agent/chat` exists on the backend with the real tool-calling loop and is never called. This breaks two written project rules simultaneously: *"The optimizer decides; the LLM never does"* and *"never fake a capability the system lacks."*

---

## 1. A correction that shaped the design

The brief asked to rename crews from "Operator A / B / C" to role-specific teams. **Those are not crew names.** `fixtures/schedule.ts:149-154` renders any Sunway tower ID as `Operator ${A} · site ${node}` — the anonymised *telco operator* sharing a physical mast, from source data grouped by `Operatorname` + `Node`. In the reported screenshot they are the **left column of the by-tower view**: sites, not teams.

The crews are already role-typed, and already map onto the Annex C factor set:

| Annex C | Factor | Model column | Intervention (`actions.yaml`) | Crew type | Duration |
|---|---|---|---|---|---|
| A1 | Flood / ingress | `flood` | Raise cabinet, seal ingress, drainage | **civil** | 4.0h |
| A2 | Terrain | `terrain` | Slope stabilisation, guy-wire tension | **civil** | 5.0h |
| A3 | Grid dependence | `power` | Battery-bank test, genset, fuel | **power** | 2.5h |
| A4 | Equipment vintage | `equipment` | Radio-unit refresh, spares pre-stage | **rf** | 3.0h |
| A5 | Lightning | `lightning` | Surge-arrestor swap, ground test | **electrical** | 2.0h |
| A6 | Population | — | *not an intervention* | *ranking multiplier* | — |

Two caveats carried forward, both already documented in the source files and neither to be papered over:

- **A5 is dead on Sunway.** `prepare_pilot_dataset.py:795-796` sets `flash_density = np.nan`; the adapter drops the column and the AHP matrix renormalises to 5×5. So `electrical` crews have no work to be assigned. The UI must not imply otherwise.
- **A2 is folded into `civil`.** `actions.yaml` states this explicitly: *"assignment granularity is crew, not skill — mapped to civil since our crews are not split finer than that."*

**Decision: keep four crew types. Do not invent a fifth team, and do not invent a Rapid Response unit.** The defect is visibility, not taxonomy. This design makes the four teams structurally visible and gives each a readable identity.

---

## 2. Decisions locked

| # | Decision | Choice |
|---|---|---|
| D1 | Tab purpose | **Readiness board** is the hero and the demo priority; classic dispatch retained as a manual path |
| D2 | Backend scope | **Frontend + config + solver** |
| D3 | Reserve model | **Reserve carve-out declared in `policy.yaml`**, enforced in `optimize.py` |
| D4 | Role teams | **Keep 4 types, make all 4 visible** — no fabricated capability |
| D5 | Calendar structure | **Week strip + day timeline**, timeline grouped by role team |
| D6 | Unscheduled work | **Bottom tabbed work queue** with a real per-row `Blocked by` column |
| D7 | Map | **Contextual** — lives in the slide-in panel, not persistent |
| D8 | Reserve sizing | **Whole crew-days, on selected days only.** 1 civil crew held free on 3 of the 7 horizon days. A partial shift cannot absorb a 4h flood job, so fractional reserve buys nothing; reserving *every* day halves the board. See §6.2. |
| D9 | "By site" view | **Kept**, reworked to 7 columns and per-job selection. It is the only surface answering per-site coverage across the week. |
| D10 | Territory | **Selector renders all 15 territories; non-Selangor are `aria-disabled` with an explanatory `title`.** See §7.1. |
| D11 | Agent input | **Collapsible bottom-right dock** (`AgentDock`), reachable without a selection. |

---

## 3. Target UX flow

The loop the redesign must serve, in order:

1. **Arrive → the week is already solved.** No "generate" button. `POST /schedule/optimize` fires once on mount.
2. **Read readiness first.** Header answers *"if a predicted risk fires today, who absorbs it?"* — reserve crew-days per role team, and how much of the week is still protected.
3. **Read the week's shape.** Week strip: all seven horizon days, planned load vs protected reserve per day.
4. **Drop into a day.** Crew×hour timeline, grouped by role team, reserve drawn as protected bands.
5. **Interrogate one job.** Click a bar → panel slides in with route, deterministic why, and override controls. **Per job, not per crew-day.**
6. **Override with the cost shown.** Preview before commit, unchanged.
7. **Work the backlog.** Tabbed queue underneath, each row carrying its own reason for not being scheduled.
8. **Change the rules.** Constraint in plain English → real `POST /agent/chat` → real re-solve → reviewable diff.

---

## 4. Layout architecture

### Default state — nothing selected

```
+------------------------------------------------------------------+
| Schedule            [Readiness: civil 5 · power 7 · rf 6 · elec 7]|
| Crew assignments, Sunway AOI      [Timeline|By site] [Search] [..]|
+------------------------------------------------------------------+
| WEEK   Mon17    Tue18    Wed19    Thu20    Fri21    Sat22   Sun23 |
|        ####..   #####.   ##....   ###...   ####..   ......  ......|
|        4 job    6 job    2 job    3 job    4 job    free    free  |
|        2 rsv    1 rsv    3 rsv    2 rsv    2 rsv    5 rsv   5 rsv |
+------------------------------------------------------------------+
|          6A   7A   8A   9A  10A  11A  12P   1P   2P   3P   4P    |
| CIVIL  ---------------------------------------------------------- |
|  SEL-C1  |    [## site 701905 ##]-15m-[## 216175 ##]   ::::::   | |
|  SEL-C2  |  [### site 810851 ###]          :: RESERVE ::        | |
| POWER  ---------------------------------------------------------- |
|  SEL-P1  |              :::::::: RESERVE ::::::::                | |
| RF     ---------------------------------------------------------- |
|  SEL-R1  |  [## 12252 ##]         :::::: RESERVE ::::::          | |
| ELECTRICAL  ------------------------------------------------------ |
|  SEL-E1  |  No lightning work in this AOI - A5 factor unavailable | |
+------------------------------------------------------------------+
| [Unscheduled 23] [SLA at risk 8] [Deferred 4] [Pinned 6]          |
| Site     Op  Factor  Risk  Team   Due      Blocked by             |
| 810851   C   Flood   0.99  Civil  Aug 19   No capacity            |
| 216175   B   Flood   0.99  Civil  Aug 18   No capacity            |
+------------------------------------------------------------------+
```

### Selected state — one job

The panel slides in from the right at 380px; the calendar re-flows rather than being overlaid, so no bar is hidden behind the panel.

```
+---------------------------------------------+--------------------+
| WEEK strip (unchanged)                      |  ROUTE MAP         |
+---------------------------------------------+  depot -> stops    |
| timeline, narrowed                          +--------------------+
|                                             |  WHY THIS SLOT     |
|                                             |  reasons list      |
+---------------------------------------------+--------------------+
| work queue, narrowed                        |  MOVE / PIN        |
|                                             |  [preview->commit] |
+---------------------------------------------+--------------------+
```

**Panel is one container with four content modes**, chosen by selection kind:

| Selection | Panel content |
|---|---|
| A booked job | RouteMap + WhySlot + MoveControl |
| A free (non-reserve) crew-day | AssignPanel — unscheduled candidates, most urgent first |
| A reserve band | ReserveDetail — what this reserve protects, and "spend it" action |
| An emergency target | EmergencyPanel |
| Nothing | *panel is not mounted* |

`AgentChat` moves **out** of the panel and into a collapsed dock at the bottom-right of the calendar area, so a constraint can be typed without a selection and without stealing panel height. Expanded it overlays the queue; collapsed it is a single bar.

---

## 5. Calendar structure

### 5.1 Week strip (`WeekStrip.tsx`)

Replaces `DayTabs.tsx`. Renders **`run.horizon`**, not a hardcoded array — this closes the days 6–7 defect.

Per day, three stacked readings:
- A load bar: filled segments = booked crew-days, hatched segments = protected reserve, empty = genuinely free.
- Job count (`tnum`).
- Reserve count (`tnum`).

Selected day carries the accent underline, same treatment `NavPill` uses, so the tab strip reads as chrome and not as data.

Non-negotiable: the bar's filled portion uses `--color-accent` (chrome — it counts *work*, it is not a severity reading). It must **not** use a band colour. A warm hue here would falsely imply risk.

### 5.2 Timeline board (`TimelineBoard.tsx`)

Replaces `GanttBoard.tsx`. Keeps everything already correct about it — `buildAxis`/`buildLanes` from `lib/gantt.ts`, solver-only clocks, drawn travel connectors, the `untimed` fallback, the skipped closing gridline, the inward-anchored end tick labels.

Adds four things:

1. **Role-team grouping.** Lanes group under a role header (`CIVIL`, `POWER`, `RF`, `ELECTRICAL`) rather than being one flat list of Selangor crews. This is the single change that makes the A1–A6 mapping legible: the board's vertical axis becomes *capability*, and a planner can see at a glance that the week is entirely civil work.
2. **Empty role groups render, with an honest reason.** An `ELECTRICAL` group with no work says so — *"No lightning work in this AOI — A5 factor unavailable"* — rather than vanishing. Same discipline as the inert AOI tools: render to spec, explain why nothing is there, never fake it.
3. **Reserve bands.** A `(crew_id, day)` in `run.reserve` draws a hatched, non-interactive band across the lane's free span, labelled `RESERVE`. It is selectable (opens ReserveDetail) but visually recessive — it is protected *absence*, and must never compete with a bar.
4. **Per-job selection.** Each bar is independently selectable and independently `aria-pressed`.

### 5.3 Selection model change

```ts
// before
interface SelectedCell { crew_id: string; day: string; }

// after
type Selection =
  | { kind: 'job';       crew_id: string; day: string; tower_id: string }
  | { kind: 'free';      crew_id: string; day: string }
  | { kind: 'reserve';   crew_id: string; day: string }
  | { kind: 'emergency'; tower_id: string; day: string };
```

`WhySlotPanel`'s `.find` becomes an exact three-key match. Every consumer that currently reads `selectedCell` (`RouteMap`, `WhySlotPanel`, `MoveControl`, `AssignPanel`, `ScheduleGridByTower`) is updated in the same change — this is the one refactor that cannot be staged, because a half-migrated store would silently keep resolving the wrong entry.

`RouteMap` continues to draw the **whole crew-day route** (it answers "where is this crew going"), with the selected job's stop emphasised. It still must never call `setMap`/`setView` on `useMapInstance`.

---

## 6. Readiness / reserve model

### 6.1 Config (`config/policy.yaml`)

```yaml
readiness:
  # Reserve capacity is protected from PLANNED work and is what unplanned
  # incident insertion consumes FIRST, so a real incident displaces nothing.
  # Assumed demo parameters (PRD §13), not operator data.
  enabled: true

  # Crew-days held free, per crew type. A type absent here reserves 0.
  #
  # Sizing is deliberate and is a THROUGHPUT TRADE, not a free win. Selangor
  # has 2 civil crews over a 7-day horizon = 14 civil crew-days, and a 4h
  # flood job plus travel fills a whole 8h shift, so the ceiling is 14 jobs
  # and the board is already saturated at 14 booked / 23 unscheduled.
  # Reserving a civil crew EVERY day would take 7 of those 14 and halve the
  # booked work. Reserving on selected days keeps the board credible while
  # still buying a real, demonstrable response capability.
  reserve_crew_days:
    civil: 1
    power: 1
    electrical: 0
    rf: 0

  # Which horizon days carry reserve, by index. Empty list = every day.
  # [0, 3, 6] is evenly spaced so no gap exceeds two consecutive days without
  # civil cover — a defensible rule rather than an arbitrary pick.
  # Costs 3 of 14 civil crew-days: 14 booked -> 11, unscheduled 23 -> 26.
  reserve_days: [0, 3, 6]

  # Rotate which crew of a type carries reserve duty, by day index, so the
  # same crew is not benched all week and utilisation stays even.
  rotate_reserve: true

  # A job whose SLA deadline falls inside the horizon may consume reserve
  # rather than go unscheduled. Safety valve: readiness must never cause a
  # missed deadline.
  sla_may_consume_reserve: true
```

### 6.2 Solver (`scheduler/optimize.py`)

Reserve must be decided **before** planned assignment, or it is not protected.

1. Build the horizon as today.
2. For each day whose index is in `reserve_days` (or every day, if that list is empty), and each `crew_type`, select `reserve_crew_days[crew_type]` crews to hold. With `rotate_reserve`, selection is `crews_of_type[(day_index + i) % len(crews_of_type)]` — deterministic, no RNG, demo-stable.
3. Mark those `(crew_id, day)` pairs reserved. `_place()` skips them for planned work.
4. If a tower's SLA deadline is the current day and `sla_may_consume_reserve` is true, allow placement into reserve, and record `consumed_reserve: true` on the entry.
5. Pin and emergency insertion (`override.py`) prefer reserved capacity and only fall through to displacement when no reserve of the right type exists that day.

**Fallback discipline:** with `enabled: false`, or `reserve_crew_days` absent, behaviour is byte-identical to today. The feature is additive.

**Consequence to expect and not "fix":** reserve *will* increase the unscheduled count. On Sunway, expected movement is **14 booked → 11, unscheduled 23 → 26**. That is the honest trade being visualised — readiness costs throughput — and the work queue's `Blocked by` column will say `reserved` for exactly those rows, so the cost is attributable rather than mysterious.

If the board needs to look busier, the lever is **`reserve_days`**, never `duration_hours`. Shrinking a job's on-site hours to fit more work is a documented project prohibition and would make every clock on the timeline a lie.

**Readiness must be bought where the risk is.** Reserving only `power`/`rf`/`electrical` would cost zero throughput — those teams have no Sunway work at all — but it would reserve idle capacity against risks this AOI does not have. Flood (A1) is the dominant factor here and flood needs `civil`, so `civil` is where reserve has to be spent for the claim to mean anything.

### 6.3 Readiness readout (`ReadinessBar`, in `PageHeader`)

Per role team: protected crew-days remaining this week, and whether any is available **today**. Derived in `lib/readiness.ts` from `run.reserve` + `run.horizon`. Pure, dependency-free, therefore checkable with a short `node` script against hand-computed values — the closest thing to a unit test this frontend has.

Also surfaced here: **risk-weighted wait vs. naive dispatch**, from `GET /schedule/baseline`. This number is the headline claim of the whole dispatch layer and currently appears nowhere on the dispatch screen except inside an override preview.

---

## 7. Role team identity

No new teams. Each of the four existing types gets a consistent, non-colour identity so the board reads as four capabilities:

| Type | Board label | Answers | Glyph |
|---|---|---|---|
| `civil` | **Civil** | A1 flood, A2 terrain | existing `CREW_TYPE_GLYPH` |
| `power` | **Power** | A3 grid dependence | existing |
| `rf` | **RF** | A4 equipment vintage | existing |
| `electrical` | **Electrical** | A5 lightning | existing |

Each role header carries the label, the glyph, the factors it answers, and the group's aggregate utilisation.

> **SUPERSEDED 2026-09-02.** The paragraph below was overruled during the
> schedule-tab UI/UX rework. Crew capability now carries its own hue, from
> `lib/roleColors.ts`; see the amendment in CLAUDE.md's design-system rule for
> the reasoning and the measurements. The claim that grouping/label/glyph alone
> is sufficient did not survive contact with the rendered board — at 14px grey
> glyph and 12px label the four capabilities were indistinguishable. Grouping,
> label and glyph all remain; colour was added to them, not substituted for
> them, so the greyscale argument below still holds.

**Colour is deliberately not the identity channel.** It is already fully spoken for — cool accent = chrome, warm triad = severity. Role identity is carried by **grouping, label, and glyph**, which also survives greyscale. This is the same reasoning that already made the pin marker a shape (triangle = emergency, disc = planner) rather than a colour.

---

### 7.1 Territory selector (`TerritorySelect.tsx`)

`territory === 'Selangor'` is currently hardcoded in four components (`GanttBoard`, `MoveControl`, `EmergencyPanel`, `UnscheduledBar`). This rework replaces all four with one selector in `PageHeader`, backed by one store field.

**It cannot be fully live, and must not pretend to be.** `GET /towers` serves 132 Sunway towers only (`adapter/ml_source.py:11-12` — `maintenance_decisions.csv` plus `data/pilot_sunway/`). `crews.json` carries 30 crews across 15 territories, but 14 of those hold `members: ["placeholder"]` and have zero scorable work. A live selector would render 14 empty boards.

Behaviour:

- The dropdown lists **all 15 territories**, each with its crew count, so the national roster is visible and the product reads as national rather than as a Selangor-only tool.
- **Selangor** is selectable and is the default.
- Every other territory is **`aria-disabled`**, not `disabled`, carrying `title="No scored towers in this territory — the pilot dataset covers Sunway/Selangor only."`

`aria-disabled` rather than `disabled` is deliberate and follows the established precedent for the AOI tools and the model-vintage scrubber: `disabled` removes the option from the tab order, so a keyboard user would reach neither the control nor the explanation of why it is inert.

When non-Sunway scored data lands, enabling a territory is a one-line change to the predicate — no restructuring.

---

## 8. Work queue (`WorkQueue.tsx`)

Replaces `UnscheduledBar.tsx`.

Tabs: **Unscheduled** · **SLA at risk** · **Deferred** · **Pinned**. Counts on each tab, same `tnum` badge treatment as the week strip.

Columns: Site · Operator · Factor · Risk · Team · Due · **Blocked by** · action.

The `Blocked by` column is the point of the rewrite. Today the bar prints one static sentence — *"Civil work is blocked in flood zones from November to March"* — in **August**, next to a count that has nothing to do with monsoon. Per-row reasons come from the backend as an enum:

- `no_capacity` — no crew-day of the right type had room inside the shift
- `past_sla` — deadline falls before the first day the solver could place it
- `monsoon_blocked` — flood-zone tower, civil work, monsoon month
- `no_crew_type` — no crew of the required type in this territory
- `reserved` — capacity existed but was held as reserve

Row click selects the row; the panel opens with assignment candidates. Bulk select + bulk assign is **out of scope** for this rework (YAGNI — one planner, one AOI, 23 rows).

---

## 9. Design system application

Nothing new is invented. Everything below already exists and is reused verbatim.

**Type.** `--text-eyebrow` (10px) for role headers and column heads; `--text-micro` (11px) for lane sub-labels and travel pills; `--text-ui` (12px) for bar labels and queue cells; `--text-body` (13px) for panel prose; `--text-title` (20px) via `.h-title` for the page heading. **No arbitrary `text-[Npx]`.** If a role is genuinely missing, add a step to `@theme` — do not inline.

**Colour.**
- Chrome — `--color-accent` (#7c3aed): selection, focus, week-strip load bars, utilisation meters, day underline.
- Data — `bandColor()` for fills (bar left rules, queue row spines, ≥3:1), `bandInk()` for text (risk figures in queue cells, ≥4.5:1). **`bandColor()` on a `color:` property is a bug.**
- Reserve — deliberately **neither**. Reserve is protected *absence*, not a risk reading and not a control. It renders as a hatched `overlay/[0.06]` fill with an `overlay/12` hairline. Introducing a fifth hue would break the two-channel rule the whole app rests on.

**Surfaces.** `overlay/<alpha>` throughout — never `white/<alpha>`. Panel and queue use `.glass-raised`; elevation from `--shadow-1/2/3` only, no glow.

**Blur budget.** The tab currently spends 1 glass surface (the right aside). After the rework it spends 2 (slide-in panel, agent dock). Within the app-wide ceiling of 8. **The slide-in panel animates position — so it must not carry `backdrop-filter` while animating.** Apply blur only after the transition settles, or use an opaque gradient for the panel and reserve glass for the dock.

**Layout ownership.** `App.tsx` remains the only `h-screen`. The Schedule page is `h-full` and lets the flex chain size it. The week strip and the queue are `shrink-0`; the timeline is the `min-h-0 flex-1` scroll region.

**Nav.** `PageHeader` continues to render `BrandMark` / `NavPill` / `StatusChips`. `ReadinessBar` is added as a child of `PageHeader`, not as a replacement for its top row — editing that row changes navigation on every non-map route at once.

---

## 10. Component inventory

**New**
- `components/schedule/WeekStrip.tsx`
- `components/schedule/TimelineBoard.tsx`
- `components/schedule/RoleGroup.tsx`
- `components/schedule/ReserveBand.tsx`
- `components/schedule/DetailPanel.tsx` — slide-in container, mode dispatch
- `components/schedule/ReserveDetail.tsx`
- `components/schedule/WorkQueue.tsx`
- `components/schedule/ReadinessBar.tsx`
- `components/schedule/AgentDock.tsx` — collapsible shell around `AgentChat`
- `components/schedule/TerritorySelect.tsx` — all 15 territories, non-Selangor `aria-disabled`
- `lib/readiness.ts`, `lib/roleTeams.ts`

**Changed**
- `pages/Schedule.tsx` — full re-layout
- `state/useScheduleStore.ts` — `Selection` union; `selectedDay` seeded from `run.horizon`
- `lib/gantt.ts` — role grouping, reserve spans
- `lib/scheduleDays.ts` — `dayLabel` only; `SCHEDULE_DAYS` deleted, days come from `run.horizon`
- `components/schedule/{WhySlotPanel,MoveControl,AssignPanel,EmergencyPanel}.tsx` — take an entry, not a cell; day dropdown reads the horizon
- `components/schedule/RouteMap.tsx` — emphasise selected stop; still never publishes to `useMapInstance`
- `components/schedule/ScheduleGridByTower.tsx` — 7 columns; per-job selection
- `components/schedule/AgentChat.tsx` — wired to `POST /agent/chat` SSE
- `api/queries.ts` / `api/types.ts` — horizon, reserve, unscheduled detail, baseline query

**Deleted**
- `components/schedule/ScheduleGrid.tsx` — dead, unimported, 152 lines
- `components/schedule/DayTabs.tsx` — absorbed by `WeekStrip`
- `components/schedule/UnscheduledBar.tsx` — replaced by `WorkQueue`
- `lib/mockReplan.ts` — the fabricated re-planner
- `api/queries.ts::useEmergencyDispatch` — unused; `EmergencyPanel` correctly routes via `/schedule/pin`

---

## 11. Contract changes

`api/schemas.py` and `src/frontend/src/api/types.ts` must change **together** (existing project rule).

```python
class ScheduleRunOut(BaseModel):
    run_id: str
    horizon: list[str]                       # NEW - ISO dates, len == planning_horizon_days
    entries: list[ScheduleEntryOut]
    reserve: list[ReserveSlotOut]            # NEW - {crew_id, day, crew_type}
    unscheduled: list[str]                   # kept, unchanged shape
    unscheduled_detail: list[UnscheduledOut] # NEW - {tower_id, reason, deadline, crew_type}
    risk_weighted_wait: float
```

`ScheduleEntryOut` gains `consumed_reserve: bool = False`.

`unscheduled` is retained alongside `unscheduled_detail` so the offline fixture and any existing consumer keep working through the migration; it is removed only once nothing reads it.

**Offline fixture must be updated in the same change.** `fixtures/schedule.ts` needs a `horizon` and a `reserve` list, or the offline path renders a readiness board with no reserve and the demo lies while claiming to be offline. Per the standing rule: **a fallback must be real fixture data or `null` — never a zeroed struct.** `readiness` with all-zero counts is exactly the `rho_mean: 0` failure mode that already shipped once.

---

## 12. Defects this rework closes

| Defect | Closed by |
|---|---|
| Per-job selection broken on multi-job days | §5.3 selection union |
| Horizon days 6–7 invisible | §5.1 `run.horizon` |
| Right panel always costs 360px | §4 contextual panel |
| Four role teams never visible | §5.2 role grouping + §7 |
| `AgentChat` fakes the optimizer | §10, wire to `/agent/chat`, delete `mockReplan` |
| Static monsoon prose in August | §8 per-row `Blocked by` |
| `MONSOON_DAYS` hardcoded in `lib/whySlot.ts` | Removed. The online path already uses `GET /schedule/why`; the offline path drops the fabricated monsoon reason rather than inventing one, and keeps only the reasons derivable from fixture state. |
| Baseline delta never shown | §6.3 `ReadinessBar` |
| Dead code (`ScheduleGrid`, `useEmergencyDispatch`) | §10 |

**Already fixed by the map-module work merged in `1b9e3fa` / `834bc08`** — verified, and noted here because `CLAUDE.md`'s "Known defects" section is now stale on both:
- **CARTO watermark — resolved.** Both map instances now share `BASEMAP_STYLE_URL` from `components/map/basemap.ts` (OpenFreeMap Positron, vector, keyless). `RouteMap` imports the same constant, so the schedule panel's map inherited the fix. Contrast figures measured against Positron still hold, because it is the same cartography.
- **`flood-hex-fill` — resolved.** `['zoom']` is now the top-level `interpolate` input in `floodLayer.ts:67-75`.

**Explicitly NOT closed** (pre-existing, must not be silently attributed to this work):
- **`PLACE_NAMES` contradiction — offline fixture only.** `fixtures/schedule.ts` books `MY_10xx` IDs that `placeName()` resolves to Kelantan towns, while `fixtures/towers.ts` places scored towers inside `SUNWAY_BOUNDS` in Selangor. Live data uses `SUNWAY_OPERATOR_X_NNNNN` and resolves correctly to `Operator X · site NNNN`. This rework uses the derived `Operator X · site NNNN` form in the timeline and queue, which is honest for live data; the fixture contradiction is left for a separate fixture fix.

**Follow-up:** update `CLAUDE.md`'s "Known defects" section to drop the two resolved entries. Out of scope for this rework, but it should not go stale much longer — the whole point of that section is that a symptom is not misattributed to code that is working correctly.

---

## 13. Build sequence

Each phase leaves the app building, linting, and usable.

| Phase | Work | Depends on |
|---|---|---|
| **0** | Backend contract: `horizon`, `reserve`, `unscheduled_detail`, `consumed_reserve`; `policy.yaml` `readiness` block; mirror in `types.ts`; update offline fixture | — |
| **1** | Solver reserve carve-out in `optimize.py` + reserve-aware insertion in `override.py`; tests | 0 |
| **2** | Frontend `Selection` union; migrate all five consumers; fix the `.find` | 0 |
| **3** | Layout shell: `Schedule.tsx` re-layout, `DetailPanel` slide-in, full-width default | 2 |
| **4** | `WeekStrip` + `TimelineBoard` with role grouping and reserve bands; delete `DayTabs` | 1, 3 |
| **5** | `WorkQueue` with per-row `Blocked by`; delete `UnscheduledBar` | 0, 3 |
| **6** | `ReadinessBar` incl. baseline delta; `lib/readiness.ts` | 1, 3 |
| **7** | `AgentChat` → real `/agent/chat` SSE via `lib/agentParser.ts`; `AgentDock`; delete `mockReplan.ts` | 3 |
| **8** | Cleanup: delete dead code, `ScheduleGridByTower` to 7 columns, `placeName` policy | all |

Phase 2 is the smallest change with the largest correctness payoff and should not be deferred behind the visual work.

---

## 14. Verification

**Backend:** `cd src/backend && pytest -q`. New tests for the reserve carve-out:
- reserve slots are never filled by planned work
- `enabled: false` reproduces today's output byte-for-byte
- `rotate_reserve` distributes reserve duty across the horizon deterministically
- only the days named in `reserve_days` carry reserve; an empty list reserves every day
- with `reserve_days: [0, 3, 6]` on the Sunway fixture, booked count drops 14 → 11 and unscheduled rises 23 → 26 (asserted exactly, so a silent capacity regression is caught)
- an SLA-critical job consumes reserve rather than going unscheduled
- emergency insertion into reserve displaces nothing

**Frontend:** there is no test runner. `npm run build` (`tsc -b && vite build`) and `npm run lint` (oxlint) are necessary, not sufficient. Per the standing rule, **a passing build does not verify a visual, accessibility, or map-rendering change** — and cannot catch the MapLibre worker bug, which is dev-only.

Browser checks required before any completion claim:
1. Multi-job crew-day: click the second bar, confirm the panel shows *that* job.
2. All seven horizon days appear in the week strip and the move dropdown.
3. Empty role groups render with their reason string, not blank.
4. Reserve bands are visible, recessive, and not mistakable for booked work.
5. Panel is unmounted with nothing selected; calendar is full width.
6. Offline mode: banner shows, readiness renders from fixture reserve, no zeroed struct.
7. `RouteMap` does not disturb the Overview's graticule, cursor readout or scale rule.
8. Contrast: reserve hatch and role headers measured, not eyeballed.

`lib/readiness.ts`, `lib/gantt.ts` and `lib/roleTeams.ts` are dependency-free and get a `node` script checked against hand-computed values.

---

## 15. Risks

| Risk | Mitigation |
|---|---|
| Reserve makes the Sunway board look emptier and the unscheduled count worse | Bounded by design: `reserve_days: [0, 3, 6]` costs 3 of 14 civil crew-days, not 7. Surface the cost — the queue says `reserved` on exactly those rows and the readiness readout states what it buys. Tune `reserve_days` if needed; never `duration_hours`. |
| Reserve is added but no incident is ever demoed against it, so it reads as wasted capacity | The demo must actually spend a reserve slot: dispatch an emergency into a reserved crew-day and show that the displaced-work list comes back **empty**. That contrast — displacement without reserve, none with it — is the entire argument for the feature. |
| Selection refactor touches five components at once | Phase 2 is isolated and ships before any visual work, so a regression is attributable. |
| Slide-in panel animating with `backdrop-filter` | Never blur an animating surface — existing rule. Opaque gradient on the panel. |
| `/agent/chat` SSE contract may not match `lib/agentParser.ts` | Read `agent/runner.py`'s event vocabulary **before** editing the component. Both the real Claude path and the deterministic fallback emit the same events, so one wiring covers both. |
| Empty role groups read as a bug rather than as information | The reason string is required, not optional; an unexplained empty group is worse than no group. |

---

## 16. Resolved during design

All four questions raised in review are settled and folded in above (D8–D11).

| Question | Resolution |
|---|---|
| Reserve sizing | Whole crew-days on selected days (`reserve_days: [0, 3, 6]`). A fractional shift cannot absorb a 4h flood job; reserving every day would halve the board. |
| "By site" view | Kept, reworked to 7 columns. Only surface answering per-site weekly coverage. |
| Territory | Full 15-territory selector; non-Selangor `aria-disabled` with explanation (§7.1). |
| Agent input | Collapsible bottom-right dock, reachable without a selection. |

## 17. Assumptions this design rests on

Stated so a later reader does not mistake them for findings:

- `planning_horizon_days: 7` stays 7. If it changes, `run.horizon` carries it and the week strip adapts without code change.
- `demo_clock.today` remains fixed at `2026-08-17` for demo determinism. The week strip labels days from the horizon, not from the wall clock.
- Reserve figures in `policy.yaml` are **assumed demo parameters, not operator data** — same standing as the rest of that file and the `crews.json` roster, and must stay flagged `assumed: true` in the API response.
- No new scored-tower data arrives during this rework. If it does, §7.1's territory predicate is the only thing that changes.
