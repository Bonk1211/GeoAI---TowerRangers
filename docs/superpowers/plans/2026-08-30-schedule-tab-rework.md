# Schedule Tab Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Schedule tab as a readiness board — protected reserve capacity, role-team grouping, a contextual detail panel, and a real work queue — while fixing per-job selection, the two invisible horizon days, and the fabricated optimizer chat.

**Architecture:** The backend gains a reserve carve-out declared in `policy.yaml` and enforced in `optimize.py` before planned assignment, plus three new response fields (`horizon`, `reserve`, `unscheduled_detail`). The frontend replaces its `{crew_id, day}` selection with a per-entry union, splits the calendar into a week strip plus a role-grouped day timeline, moves the map/why/override column into a panel that only mounts on selection, and wires the constraint chat to the real `POST /agent/chat` SSE endpoint.

**Tech Stack:** Python 3 / FastAPI / pytest (backend); React 19 + TypeScript + Vite + Zustand + TanStack Query + MapLibre GL + Tailwind v4 (frontend).

**Spec:** `docs/superpowers/specs/2026-08-30-schedule-tab-rework-design.md`

---

## Global Constraints

Copied from the spec and from `CLAUDE.md`. Every task's requirements implicitly include this section.

**Project rules — violating any of these fails the task**

- **Never fabricate a failure label or failure-probability semantics.** This system schedules maintenance *need* and *urgency*.
- **The optimizer decides; the LLM never does.** The agent calls tools and reports tool output verbatim.
- **`/schedule/preview` must never mutate stored state.** Only `/schedule/pin` commits.
- **Config over code.** Scheduler behaviour changes by editing `config/*.{json,yaml}`, not literals in `scheduler/*.py`.
- **Unscheduled/displaced work is always returned explicitly**, never silently dropped.
- **A fallback must be real fixture data or `null` — never a zeroed struct.** A zeroed object is truthy and defeats every `data ? … : '—'` guard.
- **Never fake a capability the system lacks.** Inert controls render to full visual spec with a `title` explaining why, and use `aria-disabled`, never `disabled` (which removes them from the tab order along with their explanation).
- **Do not shrink `duration_hours`** to make the board look busier.

**Design system — exact values**

- Colour channels: `--color-accent` `#7c3aed` = interface chrome only. `--color-maintain` / `--color-watch` / `--color-ok` / `--color-alert` = data only. **A warm hue on a control is a bug.**
- Two severity ramps, not interchangeable: `bandColor()` for FILLS (≥3:1), `bandInk()` for TEXT and thin marks (≥4.5:1). **`bandColor()` on a `color:` property is a bug.**
- Band colour has exactly one source: `src/frontend/src/lib/colors.ts`.
- Type scale only — `text-eyebrow|micro|ui|body|lead|title|display|hero` (10/11/12/13/15/20/32/40px). **No `text-[Npx]` arbitrary sizes.** (~37 already exist in the map HUD; do not add more.)
- Surfaces are `overlay/<alpha>`, never `white/<alpha>`.
- Elevation from `--shadow-1/2/3` only. No glow.
- Component classes in `index.css` stay inside `@layer components`.
- Blur ceiling `blur(14px) saturate(1.1)` (`--glass-blur`), 8 surfaces app-wide. **Never blur an element that animates position or opacity.**
- `App.tsx` is the only place `h-screen` appears. Pages use `h-full`.

**Platform**

- Windows: use `py` or `python`, not `python3` (Store alias stub).
- Backend commands run from `src/backend/`.
- Frontend has **no `test` script**. Pure `lib/` modules are tested with `node --experimental-strip-types --test <file>` (Node 22). Plain `node --test` fails with `ERR_UNKNOWN_FILE_EXTENSION`.
- `npm run build` + `npm run lint` are necessary but **never sufficient** for a visual, accessibility, or map-rendering change.
- `maplibre-gl` must stay in `optimizeDeps.exclude` in `vite.config.ts`.

**Contract rule**

- `src/backend/api/schemas.py` and `src/frontend/src/api/types.ts` change **together**, in the same commit.

---

## File Structure

### Backend

| File | Responsibility | Action |
|---|---|---|
| `scheduler/optimize.py` | `OptimizeResult`, `ReserveSlot`, `UnscheduledItem`, reserve selection + enforcement | Modify |
| `scheduler/reserve.py` | Pure reserve-slot selection. Separated so it is testable without running a solve | Create |
| `scheduler/test_reserve.py` | Unit tests for reserve selection | Create |
| `scheduler/test_optimize.py` | Solver tests — **first test file this package has had** | Create |
| `scheduler/override.py` | Reserve-preferring pin/emergency insertion | Modify |
| `config/policy.yaml` | `readiness` block | Modify |
| `api/schemas.py` | `ScheduleRunOut` gains `horizon`, `reserve`, `unscheduled_detail`; `ScheduleEntryOut` gains `consumed_reserve` | Modify |
| `api/routes/schedule.py` | `_run_to_response` carries the new fields | Modify |
| `scheduler/store.py` | `StoredRun` carries the new fields | Modify |

### Frontend

| File | Responsibility | Action |
|---|---|---|
| `api/types.ts` | Mirror the backend contract exactly | Modify |
| `api/client.ts` | `getScheduleBaseline`, `streamAgentChat` | Modify |
| `api/queries.ts` | `useBaselineQuery`; drop `useEmergencyDispatch` | Modify |
| `state/useScheduleStore.ts` | `Selection` union, `selectedDay` from horizon, `territory` | Modify |
| `lib/roleTeams.ts` | Crew-type → label, glyph key, answered factors, empty-reason string | Create |
| `lib/readiness.ts` | Reserve counts per role team from `run.reserve` + `run.horizon` | Create |
| `lib/readiness.test.mjs` | Node test for the above | Create |
| `lib/gantt.ts` | Role grouping + reserve spans | Modify |
| `lib/gantt.test.mjs` | Node test for reserve span geometry | Create |
| `lib/scheduleDays.ts` | `dayLabel` only; `SCHEDULE_DAYS` deleted | Modify |
| `components/schedule/DetailPanel.tsx` | Slide-in container, mode dispatch by selection kind | Create |
| `components/schedule/WeekStrip.tsx` | Horizon days, load vs reserve | Create |
| `components/schedule/TimelineBoard.tsx` | Role-grouped crew×hour board | Create |
| `components/schedule/RoleGroup.tsx` | Role header + empty-reason row | Create |
| `components/schedule/ReserveBand.tsx` | Hatched protected span | Create |
| `components/schedule/ReserveDetail.tsx` | Panel mode for a reserve slot | Create |
| `components/schedule/WorkQueue.tsx` | Tabbed queue with `Blocked by` | Create |
| `components/schedule/ReadinessBar.tsx` | Per-team reserve + baseline delta | Create |
| `components/schedule/AgentDock.tsx` | Collapsible shell | Create |
| `components/schedule/TerritorySelect.tsx` | 15 territories, non-Selangor `aria-disabled` | Create |
| `pages/Schedule.tsx` | Re-layout | Modify |
| `components/schedule/{WhySlotPanel,MoveControl,AssignPanel,EmergencyPanel,RouteMap,ScheduleGridByTower,AgentChat}.tsx` | Consume the new selection + horizon | Modify |
| `components/schedule/{ScheduleGrid,DayTabs,UnscheduledBar}.tsx`, `lib/mockReplan.ts` | Deleted | Delete |

---

# Phase 0 — Backend contract

Establishes the shape everything else reads. Ships without behaviour change: no reserve is produced yet, so every field is present but empty and all existing output is byte-identical.

---

### Task 1: `OptimizeResult`, `ReserveSlot`, `UnscheduledItem`

**Files:**
- Modify: `src/backend/scheduler/optimize.py`
- Test: `src/backend/scheduler/test_optimize.py` (create)

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ReserveSlot(crew_id: str, day: str, crew_type: str)` with `.to_dict() -> dict`
  - `UnscheduledItem(tower_id: str, reason: str, deadline: str | None, crew_type: str)` with `.to_dict() -> dict`
  - `UNSCHEDULED_REASONS: frozenset[str]` = `{"no_capacity", "past_sla", "monsoon_blocked", "no_crew_type", "reserved"}`
  - `OptimizeResult` with fields `entries`, `unscheduled`, `risk_weighted_wait`, `horizon: list[str]`, `reserve: list[ReserveSlot]`, `unscheduled_detail: list[UnscheduledItem]`, and `__iter__` yielding the first three
  - `ScheduleEntry.consumed_reserve: bool = False`, included in `to_dict()`

**Why `__iter__`:** four call sites already unpack the return value as a 3-tuple — `agent/tools.py:64`, `api/routes/schedule.py:75`, `scheduler/baseline.py:124` and `:131`, `scheduler/override.py:118`. Making the result tuple-compatible means none of them change in this task, so a regression in Phase 0 is attributable to Phase 0.

- [ ] **Step 1: Write the failing test**

Create `src/backend/scheduler/test_optimize.py`:

```python
"""Solver tests — capacity, reserve, and the result contract.

Run from src/backend:  python3 scheduler/test_optimize.py   (or via pytest)
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.optimize import (
    UNSCHEDULED_REASONS,
    OptimizeResult,
    ReserveSlot,
    ScheduleEntry,
    UnscheduledItem,
)


def test_optimize_result_unpacks_as_a_three_tuple():
    """Four existing call sites unpack this. Breaking that is the one
    regression this refactor could cause, so it is asserted first."""
    result = OptimizeResult(entries=[], unscheduled=["MY_1"], risk_weighted_wait=2.5)
    entries, unscheduled, wait = result
    assert entries == []
    assert unscheduled == ["MY_1"]
    assert wait == 2.5


def test_optimize_result_new_fields_default_empty():
    result = OptimizeResult(entries=[], unscheduled=[], risk_weighted_wait=0.0)
    assert result.horizon == []
    assert result.reserve == []
    assert result.unscheduled_detail == []


def test_reserve_slot_to_dict():
    slot = ReserveSlot(crew_id="SEL-C1", day="2026-08-17", crew_type="civil")
    assert slot.to_dict() == {
        "crew_id": "SEL-C1",
        "day": "2026-08-17",
        "crew_type": "civil",
    }


def test_unscheduled_item_reason_is_from_the_known_set():
    item = UnscheduledItem(
        tower_id="MY_1", reason="no_capacity", deadline="2026-08-20", crew_type="civil"
    )
    assert item.reason in UNSCHEDULED_REASONS
    assert item.to_dict()["deadline"] == "2026-08-20"


def test_schedule_entry_carries_consumed_reserve_and_serialises_it():
    entry = ScheduleEntry(
        crew_id="SEL-C1", day="2026-08-17", order=1, tower_id="MY_1", work_order={}
    )
    assert entry.consumed_reserve is False
    assert entry.to_dict()["consumed_reserve"] is False


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: FAIL — `ImportError: cannot import name 'UNSCHEDULED_REASONS' from 'scheduler.optimize'`

- [ ] **Step 3: Add the dataclasses**

In `src/backend/scheduler/optimize.py`, after the `ScheduleEntry` class, add:

```python
UNSCHEDULED_REASONS = frozenset(
    {"no_capacity", "past_sla", "monsoon_blocked", "no_crew_type", "reserved"}
)


@dataclass(frozen=True)
class ReserveSlot:
    """A crew-day deliberately held free of planned work.

    Readiness capacity: unplanned insertion consumes this FIRST, so a real
    incident displaces nothing. Decided before planned assignment — reserve
    chosen after the fact would not be protected from anything.
    """

    crew_id: str
    day: str  # ISO date
    crew_type: str

    def to_dict(self) -> dict[str, Any]:
        return {"crew_id": self.crew_id, "day": self.day, "crew_type": self.crew_type}


@dataclass(frozen=True)
class UnscheduledItem:
    """Why one tower did not make it onto the board.

    The reason is per-tower and returned explicitly. The UI previously
    printed one static sentence about the monsoon window for the whole
    unscheduled set, in August, which was true of almost none of them.
    """

    tower_id: str
    reason: str  # one of UNSCHEDULED_REASONS
    deadline: str | None  # ISO date the SLA expires, None when unknown
    crew_type: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "tower_id": self.tower_id,
            "reason": self.reason,
            "deadline": self.deadline,
            "crew_type": self.crew_type,
        }


@dataclass
class OptimizeResult:
    """Solver output.

    Iterable as `(entries, unscheduled, risk_weighted_wait)` on purpose: four
    call sites unpack the old 3-tuple, and keeping them working means this
    contract change lands without touching baseline.py, tools.py, override.py
    or the schedule route.
    """

    entries: list[ScheduleEntry]
    unscheduled: list[str]
    risk_weighted_wait: float
    horizon: list[str] = field(default_factory=list)
    reserve: list[ReserveSlot] = field(default_factory=list)
    unscheduled_detail: list[UnscheduledItem] = field(default_factory=list)

    def __iter__(self):
        return iter((self.entries, self.unscheduled, self.risk_weighted_wait))
```

- [ ] **Step 4: Add `consumed_reserve` to `ScheduleEntry`**

In the `ScheduleEntry` dataclass, after `end_min: int = 0`, add:

```python
    # True when this placement was allowed into a reserved crew-day because its
    # SLA deadline left no alternative. Surfaced so a planner can see that
    # readiness capacity was spent, rather than discovering it when an incident
    # finds nothing free.
    consumed_reserve: bool = False
```

And in `to_dict()`, after `"end_min": self.end_min,`, add:

```python
            "consumed_reserve": self.consumed_reserve,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: PASS — 5 passed

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 47 passed (42 existing + 5 new)

- [ ] **Step 6: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "feat(scheduler): add OptimizeResult, ReserveSlot, UnscheduledItem

OptimizeResult is tuple-compatible so the four existing call sites are
unchanged. No behaviour change: reserve and unscheduled_detail are empty."
```

---

### Task 2: `readiness` block in `policy.yaml`

**Files:**
- Modify: `src/backend/config/policy.yaml`
- Create: `src/backend/scheduler/reserve.py`
- Test: `src/backend/scheduler/test_reserve.py` (create)

**Interfaces:**
- Consumes: `ReserveSlot` from Task 1
- Produces: `select_reserve(crews: list[dict], horizon: list[date], policy: dict) -> list[ReserveSlot]`

**Design note:** reserve selection is a pure function in its own module so it can be tested without running a solve, and so the solver's placement loop only has to consult a set.

- [ ] **Step 1: Write the failing test**

Create `src/backend/scheduler/test_reserve.py`:

```python
"""Reserve carve-out selection.

Pure: no solve, no config file read. Run from src/backend:
    python3 scheduler/test_reserve.py   (or via pytest)
"""

import sys
from datetime import date, timedelta
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.reserve import select_reserve

CREWS = [
    {"crew_id": "SEL-C1", "crew_type": "civil", "territory": "Selangor"},
    {"crew_id": "SEL-C2", "crew_type": "civil", "territory": "Selangor"},
    {"crew_id": "SEL-P1", "crew_type": "power", "territory": "Selangor"},
    {"crew_id": "SEL-R1", "crew_type": "rf", "territory": "Selangor"},
]

HORIZON = [date(2026, 8, 17) + timedelta(days=i) for i in range(7)]

POLICY = {
    "readiness": {
        "enabled": True,
        "reserve_crew_days": {"civil": 1, "power": 1, "electrical": 0, "rf": 0},
        "reserve_days": [0, 3, 6],
        "rotate_reserve": True,
        "sla_may_consume_reserve": True,
    }
}


def test_disabled_reserves_nothing():
    policy = {"readiness": {**POLICY["readiness"], "enabled": False}}
    assert select_reserve(CREWS, HORIZON, policy) == []


def test_missing_readiness_block_reserves_nothing():
    """Additive by construction: a policy.yaml without the block behaves
    exactly as it did before readiness existed."""
    assert select_reserve(CREWS, HORIZON, {}) == []


def test_only_the_named_days_carry_reserve():
    slots = select_reserve(CREWS, HORIZON, POLICY)
    days = {s.day for s in slots}
    assert days == {"2026-08-17", "2026-08-20", "2026-08-23"}


def test_empty_reserve_days_means_every_day():
    policy = {"readiness": {**POLICY["readiness"], "reserve_days": []}}
    slots = select_reserve(CREWS, HORIZON, policy)
    assert len({s.day for s in slots}) == 7


def test_counts_per_type_are_honoured():
    slots = select_reserve(CREWS, HORIZON, POLICY)
    # 3 days x (1 civil + 1 power); electrical has no crew, rf reserves 0
    assert len(slots) == 6
    assert sum(1 for s in slots if s.crew_type == "civil") == 3
    assert sum(1 for s in slots if s.crew_type == "power") == 3
    assert not [s for s in slots if s.crew_type == "rf"]


def test_rotation_spreads_reserve_duty_across_the_two_civil_crews():
    """Without rotation SEL-C1 would be benched on all three days and its
    utilisation would read as broken rather than as policy."""
    slots = select_reserve(CREWS, HORIZON, POLICY)
    civil = sorted((s.day, s.crew_id) for s in slots if s.crew_type == "civil")
    assert civil == [
        ("2026-08-17", "SEL-C1"),
        ("2026-08-20", "SEL-C2"),
        ("2026-08-23", "SEL-C1"),
    ]


def test_rotation_off_pins_the_first_crew():
    policy = {"readiness": {**POLICY["readiness"], "rotate_reserve": False}}
    slots = select_reserve(CREWS, HORIZON, policy)
    assert {s.crew_id for s in slots if s.crew_type == "civil"} == {"SEL-C1"}


def test_reserving_more_than_the_roster_holds_reserves_all_of_it():
    """Must not raise or wrap around and reserve the same crew twice."""
    policy = {"readiness": {**POLICY["readiness"], "reserve_crew_days": {"civil": 9}}}
    slots = select_reserve(CREWS, HORIZON, policy)
    day_one = [s for s in slots if s.day == "2026-08-17"]
    assert len(day_one) == 2
    assert {s.crew_id for s in day_one} == {"SEL-C1", "SEL-C2"}


def test_selection_is_deterministic():
    assert select_reserve(CREWS, HORIZON, POLICY) == select_reserve(CREWS, HORIZON, POLICY)


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_reserve.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'scheduler.reserve'`

- [ ] **Step 3: Implement `scheduler/reserve.py`**

```python
"""Reserve carve-out selection (readiness capacity).

Pure and deterministic: given a roster, a horizon and a policy, decide which
crew-days are held free of planned work. Separated from optimize.py so it can
be tested without running a solve, and so the placement loop only has to
consult a set of keys.

The trade this encodes is real and is not free. Selangor has two civil crews
over a seven-day horizon (14 civil crew-days), and a four-hour flood job plus
travel fills a whole eight-hour shift, so the board is already saturated.
Reserving a civil crew EVERY day would take 7 of those 14 and halve the booked
work. `reserve_days` is what keeps the cost bounded — see config/policy.yaml.
"""
from __future__ import annotations

from datetime import date

from scheduler.optimize import ReserveSlot


def select_reserve(
    crews: list[dict],
    horizon: list[date],
    policy: dict,
) -> list[ReserveSlot]:
    readiness = policy.get("readiness") or {}
    if not readiness.get("enabled"):
        return []

    counts: dict[str, int] = readiness.get("reserve_crew_days") or {}
    reserve_days = readiness.get("reserve_days")
    rotate = bool(readiness.get("rotate_reserve", True))

    # An empty or absent list means every day, which is the strongest
    # readiness posture and the most expensive one.
    day_indices = (
        set(range(len(horizon)))
        if not reserve_days
        else {i for i in reserve_days if 0 <= i < len(horizon)}
    )

    by_type: dict[str, list[dict]] = {}
    for crew in crews:
        by_type.setdefault(crew["crew_type"], []).append(crew)
    for crew_list in by_type.values():
        crew_list.sort(key=lambda c: c["crew_id"])

    slots: list[ReserveSlot] = []
    for day_index, day in enumerate(horizon):
        if day_index not in day_indices:
            continue
        for crew_type, wanted in sorted(counts.items()):
            pool = by_type.get(crew_type, [])
            if not pool or wanted <= 0:
                continue
            # Never reserve more crews than exist, and never the same crew
            # twice on one day — a wrap-around would silently under-reserve.
            take = min(int(wanted), len(pool))
            for i in range(take):
                offset = (day_index + i) % len(pool) if rotate else i
                slots.append(
                    ReserveSlot(
                        crew_id=pool[offset]["crew_id"],
                        day=day.isoformat(),
                        crew_type=crew_type,
                    )
                )
    return slots
```

- [ ] **Step 4: Add the `readiness` block to `config/policy.yaml`**

Append to `src/backend/config/policy.yaml`:

```yaml
readiness:
  # Reserve capacity is protected from PLANNED work and is what unplanned
  # incident insertion consumes FIRST, so a real incident displaces nothing.
  # Assumed demo parameters (PRD §13), not operator data.
  enabled: true

  # Crew-days held free, per crew type. A type absent here reserves 0.
  #
  # This is a THROUGHPUT TRADE, not a free win. Selangor has 2 civil crews
  # over a 7-day horizon = 14 civil crew-days, and a 4h flood job plus travel
  # fills a whole 8h shift, so the ceiling is 14 jobs and the board is already
  # saturated at 14 booked / 23 unscheduled. Reserving a civil crew EVERY day
  # would take 7 of those 14 and halve the booked work.
  reserve_crew_days:
    civil: 1
    power: 1
    electrical: 0
    rf: 0

  # Which horizon days carry reserve, by index. Empty list = every day.
  # [0, 3, 6] is evenly spaced so no gap exceeds two consecutive days without
  # civil cover — a defensible rule rather than an arbitrary pick.
  # Costs 3 of 14 civil crew-days: 14 booked -> 11, unscheduled 23 -> 26.
  # If the board needs to look busier, THIS is the lever. Never duration_hours.
  reserve_days: [0, 3, 6]

  # Rotate which crew of a type carries reserve duty, by day index, so the
  # same crew is not benched all week and utilisation stays even.
  rotate_reserve: true

  # A job whose SLA deadline falls inside the horizon may consume reserve
  # rather than go unscheduled. Safety valve: readiness must never cause a
  # missed deadline.
  sla_may_consume_reserve: true
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/backend && pytest scheduler/test_reserve.py -q`
Expected: PASS — 9 passed

Run: `cd src/backend && python3 -c "from scheduler.config_loader import load_policy; print(load_policy()['readiness']['reserve_days'])"`
Expected: `[0, 3, 6]`

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 56 passed

- [ ] **Step 6: Commit**

```bash
git add src/backend/scheduler/reserve.py src/backend/scheduler/test_reserve.py src/backend/config/policy.yaml
git commit -m "feat(scheduler): add reserve carve-out selection

Pure, deterministic, config-driven. Not yet consulted by the solver."
```

---

### Task 3: Expose horizon, reserve and unscheduled reasons from `optimize()`

**Files:**
- Modify: `src/backend/scheduler/optimize.py:184-364` (the `optimize` method)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `select_reserve` (Task 2), `OptimizeResult` / `UnscheduledItem` (Task 1)
- Produces: `Optimizer.optimize(...) -> OptimizeResult` — populated `horizon` and `unscheduled_detail`; `reserve` populated but **not yet enforced** (that is Task 4, so the enforcement regression is isolated)

- [ ] **Step 1: Write the failing test**

Append to `src/backend/scheduler/test_optimize.py` (and add `from datetime import date` plus `from scheduler.optimize import Optimizer` to the imports):

```python
def _tiny_setup():
    """One crew, two towers, one of which cannot fit — the smallest case that
    produces both a placement and an unscheduled reason."""
    crews = [
        {
            "crew_id": "SEL-C1",
            "crew_type": "civil",
            "territory": "Selangor",
            "depot": {"lon": 101.588, "lat": 3.045, "name": "Subang Jaya"},
            "max_travel_km": 40,
            "shift_hours": 8,
        }
    ]
    policy = {
        "planning_horizon_days": 3,
        "shift": {"day_start": "08:00", "hours_default": 8, "min_slot_hours": 1},
        "travel": {"road_factor": 1.3, "avg_speed_kmh": 40, "max_travel_km_default": 50},
        "sla": {"fallback_sla_days": 30},
        "objective": {"travel_weight_lambda": 0.01},
        "monsoon": {"months": [11, 12, 1, 2, 3], "flood_zone_share_threshold": 0.25,
                    "blocked_crew_types": ["civil"]},
        "demo_clock": {"today": "2026-08-17"},
        "readiness": {"enabled": False},
    }
    towers = {
        "T1": {"tower_id": "T1", "lon": 101.59, "lat": 3.05, "risk": 0.9,
               "territory": "Selangor", "urgency_days": 5, "dominant_factor": "flood"},
        "T2": {"tower_id": "T2", "lon": 101.60, "lat": 3.06, "risk": 0.8,
               "territory": "Selangor", "urgency_days": 5, "dominant_factor": "flood"},
    }
    work_orders = [
        {"tower_id": "T1", "crew_type": "civil", "duration_hours": 5.0, "urgency_days": 5},
        {"tower_id": "T2", "crew_type": "civil", "duration_hours": 5.0, "urgency_days": 5},
    ]
    return crews, policy, towers, work_orders


def test_optimize_returns_the_horizon_as_iso_dates():
    crews, policy, towers, work_orders = _tiny_setup()
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert result.horizon == ["2026-08-17", "2026-08-18", "2026-08-19"]


def test_unscheduled_detail_pairs_every_unscheduled_tower_with_a_reason():
    crews, policy, towers, work_orders = _tiny_setup()
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert {d.tower_id for d in result.unscheduled_detail} == set(result.unscheduled)
    for detail in result.unscheduled_detail:
        assert detail.reason in UNSCHEDULED_REASONS
        assert detail.crew_type == "civil"


def test_no_crew_type_is_distinguished_from_no_capacity():
    """A tower needing a crew type the territory does not staff is a roster
    gap, not a capacity problem, and the queue must not blame capacity."""
    crews, policy, towers, work_orders = _tiny_setup()
    work_orders[0]["crew_type"] = "rf"
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    by_id = {d.tower_id: d for d in result.unscheduled_detail}
    assert by_id["T1"].reason == "no_crew_type"


def test_reserve_is_reported_when_enabled():
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": True,
    }
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert [(s.crew_id, s.day) for s in result.reserve] == [("SEL-C1", "2026-08-17")]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: FAIL — `AttributeError: 'tuple' object has no attribute 'horizon'`

- [ ] **Step 3: Implement**

In `optimize.py`, add the import at the top:

```python
from scheduler.reserve import select_reserve
```

Change the `optimize` signature's return annotation from `-> tuple[list[ScheduleEntry], list[str], float]` to `-> OptimizeResult`, and update its docstring's first line to `"""Returns an OptimizeResult, which also unpacks as (entries, unscheduled, wait)."""`

Immediately after `horizon = self._horizon(today)`, add:

```python
        reserve = select_reserve(self.crews, horizon, self.policy)
```

Replace `unscheduled: list[str] = []` with:

```python
        unscheduled: list[str] = []
        unscheduled_detail: list[UnscheduledItem] = []
```

Inside the `for wo in remaining:` loop, immediately after `candidates = self._candidate_crews(wo, tower)`, add:

```python
            # Recorded now because the day loop below cannot distinguish "no
            # crew of this type in this territory" from "every day was full" —
            # by then there are simply no candidates to fail against.
            no_crew_type = not candidates
```

Replace the tail of the loop:

```python
            if not placed:
                unscheduled.append(tower["tower_id"])
```

with:

```python
            if not placed:
                unscheduled.append(tower["tower_id"])
                if no_crew_type:
                    reason = "no_crew_type"
                elif deadline < horizon[0]:
                    reason = "past_sla"
                elif is_monsoon_month(horizon[0], self.policy) and is_flood_zone(
                    tower, self.policy
                ) and wo["crew_type"] in self.policy["monsoon"]["blocked_crew_types"]:
                    reason = "monsoon_blocked"
                else:
                    reason = "no_capacity"
                unscheduled_detail.append(
                    UnscheduledItem(
                        tower_id=tower["tower_id"],
                        reason=reason,
                        deadline=deadline.isoformat(),
                        crew_type=wo["crew_type"],
                    )
                )
```

Replace the final `return` with:

```python
        return OptimizeResult(
            entries=entries,
            unscheduled=unscheduled,
            risk_weighted_wait=risk_weighted_wait,
            horizon=[d.isoformat() for d in horizon],
            reserve=reserve,
            unscheduled_detail=unscheduled_detail,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: PASS — 9 passed

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 60 passed. **If `baseline.py`, `tools.py`, `override.py` or the schedule route fail here, `__iter__` is wrong — fix that, do not change the call sites.**

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "feat(scheduler): return horizon, reserve and per-tower unscheduled reasons

Reserve is reported but not yet enforced — enforcement is the next commit so
any capacity regression is attributable to it."
```

---

### Task 4: Carry the new fields through store, schema and route

**Files:**
- Modify: `src/backend/scheduler/store.py:14-22`
- Modify: `src/backend/api/schemas.py:53-57`
- Modify: `src/backend/api/routes/schedule.py:41-47`, `:75-88`

**Interfaces:**
- Consumes: `OptimizeResult` (Task 3)
- Produces: `GET /schedule/{run_id}` response containing `horizon: string[]`, `reserve: {crew_id, day, crew_type}[]`, `unscheduled_detail: {tower_id, reason, deadline, crew_type}[]`, and `consumed_reserve: boolean` on each entry

- [ ] **Step 1: Write the failing test**

Append to `src/backend/scheduler/test_optimize.py` (add `from fastapi.testclient import TestClient` and `import os` to the imports):

```python
def test_schedule_run_response_carries_the_new_contract_fields():
    """The frontend is built against this shape; api/schemas.py and
    api/types.ts must always change together."""
    os.environ["USE_FIXTURE"] = "1"
    from api.main import app

    client = TestClient(app)
    run_id = client.post("/schedule/optimize", json={}).json()["run_id"]
    body = client.get(f"/schedule/{run_id}").json()

    assert isinstance(body["horizon"], list) and body["horizon"]
    assert all(isinstance(d, str) for d in body["horizon"])
    assert isinstance(body["reserve"], list)
    assert isinstance(body["unscheduled_detail"], list)
    assert {d["tower_id"] for d in body["unscheduled_detail"]} == set(body["unscheduled"])
    if body["entries"]:
        assert "consumed_reserve" in body["entries"][0]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_optimize.py::test_schedule_run_response_carries_the_new_contract_fields -q`
Expected: FAIL — `KeyError: 'horizon'`

- [ ] **Step 3: Widen `StoredRun`**

In `src/backend/scheduler/store.py`, add to `StoredRun` after `risk_weighted_wait: float`:

```python
    horizon: list[str] = field(default_factory=list)
    reserve: list[Any] = field(default_factory=list)  # list[ReserveSlot]
    unscheduled_detail: list[Any] = field(default_factory=list)  # list[UnscheduledItem]
```

(Typed as `Any` to avoid a circular import between `store` and `optimize`; the route is the only consumer and it calls `.to_dict()`.) Add `from typing import Any` if absent.

- [ ] **Step 4: Widen the schema**

In `src/backend/api/schemas.py`, add above `ScheduleRunOut`:

```python
class ReserveSlotOut(BaseModel):
    crew_id: str
    day: str
    crew_type: str


class UnscheduledOut(BaseModel):
    tower_id: str
    reason: str  # no_capacity | past_sla | monsoon_blocked | no_crew_type | reserved
    deadline: str | None
    crew_type: str
```

and extend `ScheduleRunOut`:

```python
class ScheduleRunOut(BaseModel):
    run_id: str
    horizon: list[str] = []
    entries: list[ScheduleEntryOut]
    reserve: list[ReserveSlotOut] = []
    unscheduled: list[str]
    unscheduled_detail: list[UnscheduledOut] = []
    risk_weighted_wait: float
```

Add `consumed_reserve: bool = False` to `ScheduleEntryOut`.

`unscheduled` is retained alongside `unscheduled_detail` so the offline fixture and existing consumers keep working through the migration.

- [ ] **Step 5: Wire the route**

In `src/backend/api/routes/schedule.py`, replace `_run_to_response`:

```python
def _run_to_response(run: StoredRun) -> ScheduleRunOut:
    return ScheduleRunOut(
        run_id=run.run_id,
        horizon=run.horizon,
        entries=[e.to_dict() for e in run.entries],
        reserve=[r.to_dict() for r in run.reserve],
        unscheduled=run.unscheduled,
        unscheduled_detail=[u.to_dict() for u in run.unscheduled_detail],
        risk_weighted_wait=run.risk_weighted_wait,
    )
```

In `optimize_schedule`, replace the unpacking and `StoredRun` construction:

```python
    result = _optimizer.optimize(work_orders, towers_by_id)

    run = StoredRun(
        run_id=run_store.new_run_id(),
        entries=result.entries,
        unscheduled=result.unscheduled,
        risk_weighted_wait=result.risk_weighted_wait,
        horizon=result.horizon,
        reserve=result.reserve,
        unscheduled_detail=result.unscheduled_detail,
        pins=[],
        work_orders_by_tower=work_orders_by_tower,
        towers_by_id=towers_by_id,
    )
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 61 passed

Manual check:
```bash
cd src/backend && USE_FIXTURE=1 uvicorn api.main:app --port 8000 &
curl -s -X POST localhost:8000/schedule/optimize -H 'Content-Type: application/json' -d '{}'
curl -s localhost:8000/schedule/<run_id> | python -m json.tool | head -30
```
Expected: `horizon` has 7 ISO dates; `reserve` has 6 entries; every `unscheduled_detail` row carries a reason.

- [ ] **Step 7: Commit**

```bash
git add src/backend/scheduler/store.py src/backend/api/schemas.py src/backend/api/routes/schedule.py src/backend/scheduler/test_optimize.py
git commit -m "feat(api): carry horizon, reserve and unscheduled reasons in ScheduleRunOut"
```

---

### Task 5: Mirror the contract in `types.ts` and the offline fixture

**Files:**
- Modify: `src/frontend/src/api/types.ts:127-152`
- Modify: `src/frontend/src/fixtures/schedule.ts`

**Interfaces:**
- Consumes: the Task 4 response shape
- Produces: `ReserveSlot`, `UnscheduledReason`, `UnscheduledDetail`, widened `ScheduleRun` and `ScheduleEntry`; `SCHEDULE_RUN` fixture with real `horizon`, `reserve` and `unscheduled_detail`

**Critical:** the fixture must carry **real** values. A `reserve: []` fixture would render a readiness board reporting zero protected capacity as though measured — the same failure mode as the `rho_mean: 0` stability fallback that already shipped once.

- [ ] **Step 1: Update `types.ts`**

```ts
/** A crew-day held free of planned work, so an incident displaces nothing. */
export interface ReserveSlot {
  crew_id: string;
  day: string;
  crew_type: string;
}

/**
 * Why one tower did not make it onto the board. Per-tower and explicit — the
 * bar this replaces printed one static monsoon sentence for the whole set.
 */
export type UnscheduledReason =
  | 'no_capacity'
  | 'past_sla'
  | 'monsoon_blocked'
  | 'no_crew_type'
  | 'reserved';

export interface UnscheduledDetail {
  tower_id: string;
  reason: UnscheduledReason;
  deadline: string | null;
  crew_type: string;
}
```

Add to `ScheduleEntry`:

```ts
  /** True when this placement was allowed into a reserved crew-day on SLA grounds. */
  consumed_reserve?: boolean;
```

Replace `ScheduleRun`:

```ts
export interface ScheduleRun {
  run_id: string;
  /** Every day the solver planned over — `planning_horizon_days` long, 7 today.
   *  Read this, never a hardcoded array: the UI used to render 5 fixed dates
   *  and silently hid any work the solver booked on days 6 and 7. */
  horizon: string[];
  entries: ScheduleEntry[];
  reserve: ReserveSlot[];
  unscheduled: string[]; // tower_ids with no capacity
  unscheduled_detail: UnscheduledDetail[];
  risk_weighted_wait: number; // objective value, for override deltas
}
```

- [ ] **Step 2: Update the offline fixture**

In `src/frontend/src/fixtures/schedule.ts`, add above `SCHEDULE_RUN`:

```ts
// The fixture states its own horizon and reserve as fixture CONTENT, the same
// way it states its own clock times. Handing the readiness board an empty
// reserve would render "0 protected crew-days" as though it were a
// measurement — the zeroed-struct failure the stability chip already shipped.
export const FIXTURE_HORIZON = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
  '2026-08-21', '2026-08-22', '2026-08-23',
];

export const FIXTURE_RESERVE: ReserveSlot[] = [
  { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
  { crew_id: 'SEL-P1', day: '2026-08-17', crew_type: 'power' },
  { crew_id: 'SEL-C2', day: '2026-08-20', crew_type: 'civil' },
  { crew_id: 'SEL-P1', day: '2026-08-20', crew_type: 'power' },
  { crew_id: 'SEL-C1', day: '2026-08-23', crew_type: 'civil' },
  { crew_id: 'SEL-P1', day: '2026-08-23', crew_type: 'power' },
];
```

Add `horizon: FIXTURE_HORIZON`, `reserve: FIXTURE_RESERVE`, and an `unscheduled_detail` array to the `SCHEDULE_RUN` object, giving every id already in its `unscheduled` list a row with `reason: 'no_capacity'`, a `deadline`, and the `crew_type` matching its work order. Import `ReserveSlot` and `UnscheduledDetail` from `../api/types`.

- [ ] **Step 3: Update the empty-run constants**

`state/useScheduleStore.ts:7` and `api/useLiveSchedule.ts:43` both construct `{ run_id: '', entries: [], unscheduled: [], risk_weighted_wait: 0 }`. Add `horizon: [], reserve: [], unscheduled_detail: []` to both. These are pre-load placeholders, not fallbacks — `isLoading` gates them — so empty is correct here.

- [ ] **Step 4: Verify**

Run: `cd src/frontend && npm run build`
Expected: PASS — TypeScript surfaces every site that constructs a `ScheduleRun`; all must be updated.

Run: `cd src/frontend && npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/api/types.ts src/frontend/src/fixtures/schedule.ts src/frontend/src/state/useScheduleStore.ts src/frontend/src/api/useLiveSchedule.ts
git commit -m "feat(api): mirror horizon/reserve/unscheduled_detail in types and fixture

Fixture carries real reserve data, not an empty list — an empty reserve would
render as a measured zero on the readiness board."
```

---

# Phase 1 — Solver reserve enforcement

The only phase that changes what the optimizer produces. Isolated on purpose: if booked counts move, this is where it happened.

---

### Task 6: Protect reserved crew-days from planned work

**Files:**
- Modify: `src/backend/scheduler/optimize.py` (the day/crew loop, ~lines 273-320)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `select_reserve` output already on `OptimizeResult.reserve` (Task 3)
- Produces: planned placement never lands in a reserved `(crew_id, day)`; a tower blocked only by reserve reports `reason: "reserved"`

**Design:** feasibility is computed for *all* crews including reserved ones, then reserved candidates are partitioned out. Skipping reserved crews earlier would make "blocked by reserve" indistinguishable from "no crew could fit", and the queue would blame capacity for a policy decision.

- [ ] **Step 1: Write the failing test**

Append to `src/backend/scheduler/test_optimize.py`:

```python
def test_planned_work_never_lands_in_a_reserved_crew_day():
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    reserved = {(s.crew_id, s.day) for s in result.reserve}
    for entry in result.entries:
        assert (entry.crew_id, entry.day) not in reserved


def test_a_tower_blocked_only_by_reserve_says_so():
    """'reserved' must be distinguishable from 'no_capacity' — one is a policy
    choice the planner can reverse, the other is a hard limit."""
    crews, policy, towers, work_orders = _tiny_setup()
    policy["planning_horizon_days"] = 1
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert result.unscheduled_detail
    assert all(d.reason == "reserved" for d in result.unscheduled_detail)


def test_disabling_readiness_reproduces_the_pre_reserve_schedule():
    """The feature is additive. With readiness off the solver must produce
    byte-identical output to what it produced before reserve existed."""
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {"enabled": False}
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert result.reserve == []
    assert [e.to_dict() for e in result.entries] == [
        e.to_dict()
        for e in Optimizer(crews=crews, policy={**policy, "readiness": {}})
        .optimize(work_orders, towers)
        .entries
    ]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_optimize.py -k reserve -q`
Expected: FAIL — `test_planned_work_never_lands_in_a_reserved_crew_day` asserts a placement is not in a reserved slot, but nothing enforces that yet

- [ ] **Step 3: Implement**

In `optimize()`, after `reserve = select_reserve(...)`, add:

```python
        reserved_keys = {(s.crew_id, s.day) for s in reserve}
        sla_may_consume = bool(
            (self.policy.get("readiness") or {}).get("sla_may_consume_reserve")
        )
```

Inside the `for wo in remaining:` loop, after `no_crew_type = not candidates`, add:

```python
            blocked_by_reserve = False
```

In the crew feasibility loop, change the `feasible.append(...)` line to carry the reserved flag:

```python
                    feasible.append(
                        (leg_min, dist, crew, (crew["crew_id"], day.isoformat()) in reserved_keys)
                    )
```

Replace:

```python
                if not feasible:
                    continue

                feasible.sort(key=lambda x: (x[0], x[1]))
                leg_min, dist, crew = feasible[0]
```

with:

```python
                if not feasible:
                    continue

                # Reserve is protected capacity, so planned work never takes it.
                # Partitioned rather than filtered earlier so "the only crew that
                # fits is on reserve duty" stays distinguishable from "nothing fit".
                open_feasible = [f for f in feasible if not f[3]]
                if not open_feasible:
                    blocked_by_reserve = True
                    continue

                open_feasible.sort(key=lambda x: (x[0], x[1]))
                leg_min, dist, crew, _from_reserve = open_feasible[0]
```

In the unscheduled-reason chain, insert `blocked_by_reserve` **after** `no_crew_type` and **before** `past_sla`:

```python
                if no_crew_type:
                    reason = "no_crew_type"
                elif blocked_by_reserve:
                    reason = "reserved"
                elif deadline < horizon[0]:
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: PASS — 12 passed

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 64 passed (Step 5 adds one more, taking it to 65)

- [ ] **Step 5: Measure the real Sunway cost and pin it**

The spec estimates 14 booked → 11 and 23 unscheduled → 26. **That estimate is unverified — measure, do not assume.**

```bash
cd src/backend && python3 -c "
from adapter.ml_source import load_scored_towers
from scheduler.actions import propose_actions
from scheduler.optimize import Optimizer
from scheduler.config_loader import load_crews, load_policy
towers=[t for t in load_scored_towers() if t['decision']=='maintain']
by_id={t['tower_id']:t for t in towers}
wos=[w.to_dict() for w in propose_actions(towers)]
for enabled in (False, True):
    p=load_policy(); p['readiness']['enabled']=enabled
    r=Optimizer(crews=load_crews(), policy=p).optimize(wos, by_id)
    print(('reserve ON ' if enabled else 'reserve OFF'), 'booked', len(r.entries), 'unscheduled', len(r.unscheduled), 'reserved slots', len(r.reserve))
"
```

Record both lines. Then add a test asserting the **measured** figures, so a later capacity regression is caught:

```python
def test_sunway_reserve_cost_is_the_expected_trade():
    """Readiness costs throughput and the exact cost is pinned here. If this
    fails, capacity changed — decide whether that was intended before
    updating the numbers. Never 'fix' it by shortening duration_hours."""
    from adapter.ml_source import load_scored_towers
    from scheduler.actions import propose_actions
    from scheduler.config_loader import load_crews, load_policy

    towers = [t for t in load_scored_towers() if t["decision"] == "maintain"]
    by_id = {t["tower_id"]: t for t in towers}
    work_orders = [w.to_dict() for w in propose_actions(towers)]

    def run(enabled: bool):
        policy = load_policy()
        policy["readiness"]["enabled"] = enabled
        return Optimizer(crews=load_crews(), policy=policy).optimize(work_orders, by_id)

    off, on = run(False), run(True)
    assert (len(off.entries), len(off.unscheduled)) == (<MEASURED_OFF>)
    assert (len(on.entries), len(on.unscheduled)) == (<MEASURED_ON>)
    assert len(on.entries) < len(off.entries), "reserve must actually cost throughput"
```

Replace `<MEASURED_OFF>` / `<MEASURED_ON>` with the tuples printed above. If the measured cost is far from the spec's estimate, **stop and report it** — `reserve_days` may need retuning, and that is a product decision, not an implementation one.

- [ ] **Step 6: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "feat(scheduler): protect reserved crew-days from planned work

Towers blocked only by reserve report reason 'reserved', distinct from
'no_capacity'. Sunway throughput cost measured and pinned by test."
```

---

### Task 7: SLA-critical work may consume reserve

**Files:**
- Modify: `src/backend/scheduler/optimize.py`
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `sla_may_consume` (Task 6)
- Produces: on a tower's final legal day, reserved capacity becomes eligible and the resulting entry carries `consumed_reserve=True`

**Why:** readiness must never cause a missed deadline. Holding a crew free while a job blows its SLA would be the feature actively harming the thing the product exists to do.

- [ ] **Step 1: Write the failing test**

```python
def test_sla_critical_work_consumes_reserve_rather_than_missing_its_deadline():
    crews, policy, towers, work_orders = _tiny_setup()
    policy["planning_horizon_days"] = 1
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": True,
    }
    for wo in work_orders:
        wo["urgency_days"] = 0  # deadline is today
    for t in towers.values():
        t["urgency_days"] = 0
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert result.entries, "an SLA-critical job must not be left unscheduled by reserve"
    assert result.entries[0].consumed_reserve is True
    assert result.entries[0].to_dict()["consumed_reserve"] is True


def test_reserve_is_not_consumed_when_the_deadline_is_still_far_off():
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": True,
    }
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert all(e.consumed_reserve is False for e in result.entries)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_optimize.py -k sla -q`
Expected: FAIL — `assert result.entries` fails; the job is unscheduled with reason `reserved`

- [ ] **Step 3: Implement**

Replace the partition block from Task 6 with:

```python
                open_feasible = [f for f in feasible if not f[3]]
                # Readiness must never cause a missed deadline. On the last day
                # the SLA allows, reserved capacity becomes eligible — spending
                # readiness is strictly better than blowing the deadline it was
                # being held for.
                took_reserve = False
                if not open_feasible:
                    if sla_may_consume and day >= deadline:
                        open_feasible = list(feasible)
                        took_reserve = True
                    else:
                        blocked_by_reserve = True
                        continue

                open_feasible.sort(key=lambda x: (x[0], x[1]))
                leg_min, dist, crew, from_reserve = open_feasible[0]
                took_reserve = took_reserve and from_reserve
```

and set the flag on the constructed entry — in the `ScheduleEntry(...)` call, after `end_min=start_min + work_min,` add:

```python
                    consumed_reserve=took_reserve,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/backend && pytest scheduler/test_optimize.py -q`
Expected: PASS — 15 passed

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 67 passed. The Task 6 Sunway figures must be unchanged; if they moved, the SLA valve is firing when it should not.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "feat(scheduler): let SLA-critical work consume reserve on its last legal day"
```

---

### Task 8: Overrides and emergencies land in reserve without displacing

**Files:**
- Modify: `src/backend/scheduler/override.py:93-125` (`_resolve_around_pin`)
- Test: `src/backend/scheduler/test_override.py` (create)

**Interfaces:**
- Consumes: `OptimizeResult` (Task 3), reserve enforcement (Task 6)
- Produces: `_resolve_around_pin` returns `OptimizeResult`; a pin into a reserved crew-day drops nothing

**Key finding — this is smaller than it looks.** `pin()` and `emergency()` both route through `_resolve_around_pin`, which passes the new pin to `optimize(pinned=[...])`. Pinned entries are seeded **before** the planned loop and are never subject to the reserve check, so pinning into a reserved crew-day **already works**. What is missing is that the entry is not flagged, and the re-solved run does not carry the new contract fields.

- [ ] **Step 1: Write the failing test**

Create `src/backend/scheduler/test_override.py`:

```python
"""Override behaviour against reserved capacity.

Run from src/backend:  python3 scheduler/test_override.py   (or via pytest)
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.optimize import Optimizer
from scheduler.override import OverrideEngine
from scheduler.test_optimize import _tiny_setup


def _reserved_setup():
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    return crews, policy, towers, work_orders


def test_pinning_into_a_reserved_crew_day_displaces_nothing():
    """The whole argument for reserve. Without it an emergency always bumps
    somebody; with it, the displaced list comes back empty."""
    crews, policy, towers, work_orders = _reserved_setup()
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    reserved = base.reserve[0]

    engine = OverrideEngine(optimizer=optimizer)
    preview = engine.preview(
        current_entries=base.entries,
        current_unscheduled=base.unscheduled,
        current_pins=[],
        tower_id="T2",
        target_crew_id=reserved.crew_id,
        target_day=reserved.day,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
        pin_reason="emergency",
    )
    assert preview.dropped == []


def test_resolve_around_pin_returns_the_full_contract():
    crews, policy, towers, work_orders = _reserved_setup()
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    engine = OverrideEngine(optimizer=optimizer)
    result = engine.pin(
        current_entries=base.entries,
        current_pins=[],
        tower_id="T1",
        target_crew_id="SEL-C1",
        target_day="2026-08-18",
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
    )
    assert result.horizon == ["2026-08-17", "2026-08-18", "2026-08-19"]
    assert result.reserve
    entries, unscheduled, wait = result  # still tuple-compatible
    assert isinstance(wait, float)


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && pytest scheduler/test_override.py -q`
Expected: FAIL — `AttributeError: 'tuple' object has no attribute 'horizon'`

- [ ] **Step 3: Implement**

In `override.py`, change `_resolve_around_pin`'s return annotation from `tuple[list[ScheduleEntry], list[str], float]` to `OptimizeResult`, import it from `scheduler.optimize`, and replace line 118's unpacking:

```python
        entries, unscheduled, wait = self.optimizer.optimize(
```

with:

```python
        result = self.optimizer.optimize(
```

then return `result` directly instead of the tuple. Update `pin()`'s return annotation to `OptimizeResult` — its body already returns `_resolve_around_pin(...)` unchanged.

In `preview()` and `emergency()`, the line `after_entries, after_unscheduled, after_wait = self._resolve_around_pin(...)` keeps working unchanged thanks to `__iter__`. Leave it.

Flag the pin when it lands in reserve — in `optimize()`, in the pinned-seeding loop, after `cd.last_point = (tower["lon"], tower["lat"])`:

```python
                p.consumed_reserve = (p.crew_id, p.day) in reserved_keys
```

- [ ] **Step 4: Update the route to persist the new fields on pin**

In `api/routes/schedule.py`'s pin handler, where the re-solved run is written back to `StoredRun`, add `horizon=`, `reserve=` and `unscheduled_detail=` from the returned `OptimizeResult`, mirroring Task 4's `optimize_schedule` change. Without this a pinned run would answer with an empty horizon and the week strip would go blank after any override.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd src/backend && pytest -q -p no:cacheprovider`
Expected: PASS — 69 passed

Manual check — pin into a reserved slot via the API and confirm `dropped` is empty and `horizon` survives.

- [ ] **Step 6: Commit**

```bash
git add src/backend/scheduler/override.py src/backend/scheduler/optimize.py src/backend/scheduler/test_override.py src/backend/api/routes/schedule.py
git commit -m "feat(scheduler): overrides land in reserve without displacing booked work"
```

---

# Phase 2 — Per-job selection

The smallest change with the largest correctness payoff. Ships before any visual work so a regression here is attributable.

**The bug being fixed:** `WhySlotPanel` resolves the selected cell with `run.entries.find(e => e.crew_id === … && e.day === …)` — the first match only. `GanttBoard` passes `selected={isSelectedCrew}` to every bar in a lane. On a two-job crew-day, both bars highlight together and clicking the second shows the first job's explanation and move control.

---

### Task 9: Replace `SelectedCell` with a `Selection` union

**Files:**
- Modify: `src/frontend/src/state/useScheduleStore.ts`
- Modify: `src/frontend/src/lib/scheduleDays.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Selection =
    | { kind: 'job'; crew_id: string; day: string; tower_id: string }
    | { kind: 'free'; crew_id: string; day: string }
    | { kind: 'reserve'; crew_id: string; day: string }
    | { kind: 'emergency'; tower_id: string; day: string };
  ```
  Store gains `selection: Selection | null`, `select(sel: Selection | null): void`, `territory: string`, `setTerritory(t: string): void`. `selectedCell` and `emergencyTarget` are removed.

- [ ] **Step 1: Rewrite the selection slice**

In `useScheduleStore.ts`, delete the `SelectedCell` and `EmergencyTarget` interfaces and the `selectedCell` / `emergencyTarget` / `selectCell` / `setEmergencyTarget` fields. Add:

```ts
/**
 * What the planner has picked, and what kind of thing it is.
 *
 * Selection used to be {crew_id, day}, which was right when a day was one
 * grid cell. The hour-axis timeline draws one bar per job, so a crew-day
 * selection cannot address the second job of a day — WhySlotPanel resolved it
 * with a .find() on crew+day and always returned the first. The kind tag also
 * replaces the old parallel emergencyTarget field, which could disagree with
 * selectedCell about what was selected.
 */
export type Selection =
  | { kind: 'job'; crew_id: string; day: string; tower_id: string }
  | { kind: 'free'; crew_id: string; day: string }
  | { kind: 'reserve'; crew_id: string; day: string }
  | { kind: 'emergency'; tower_id: string; day: string };

export function isSameSelection(a: Selection | null, b: Selection | null): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  if (a.kind === 'job' && b.kind === 'job') {
    return a.crew_id === b.crew_id && a.day === b.day && a.tower_id === b.tower_id;
  }
  if (a.kind === 'emergency' && b.kind === 'emergency') {
    return a.tower_id === b.tower_id && a.day === b.day;
  }
  return 'crew_id' in a && 'crew_id' in b && a.crew_id === b.crew_id && a.day === b.day;
}
```

and in the store body:

```ts
  selection: null as Selection | null,
  select: (selection: Selection | null) =>
    // selectedDay follows the selection, or the board could hold a selection
    // on a day it is not displaying.
    set(selection ? { selection, selectedDay: selection.day } : { selection: null }),
  territory: 'Selangor',
  setTerritory: (territory: string) => set({ territory }),
```

`selectedDay` keeps its `SCHEDULE_DAYS[0]` seed for now; Task 12 moves it onto the horizon.

- [ ] **Step 2: Migrate every consumer**

Six files read the old fields. Each becomes an exact match rather than a first-match:

- `pages/Schedule.tsx` — the `highlightedTowerId` effect calls `select({ kind: 'job', crew_id: entry.crew_id, day: entry.day, tower_id: entry.tower_id })`.
- `components/schedule/WhySlotPanel.tsx` — replace the whole resolution block:
  ```ts
  const selection = useScheduleStore((s) => s.selection);
  if (!selection) return <p className="p-5 text-xs leading-relaxed text-dim">Select a scheduled slot to see why the optimizer put it there, and to move or pin it.</p>;
  if (selection.kind === 'emergency') return <EmergencyPanel tower_id={selection.tower_id} day={selection.day} onDone={() => select(null)} />;
  if (selection.kind === 'free') return <AssignPanel crew_id={selection.crew_id} day={selection.day} />;
  if (selection.kind === 'reserve') return <ReserveDetail crew_id={selection.crew_id} day={selection.day} />;
  const entry = run.entries.find(
    (e) => e.crew_id === selection.crew_id && e.day === selection.day && e.tower_id === selection.tower_id,
  );
  ```
  `ReserveDetail` does not exist until Task 15 — for this task, render `null` for `kind === 'reserve'` and add a `// TODO(Task 15)` marker. This is the one forward reference in the plan and it is deliberate: splitting it would leave the store half-migrated.
- `components/schedule/GanttBoard.tsx` — `selected` becomes per-bar: `selection?.kind === 'job' && selection.tower_id === bar.entry.tower_id && selection.crew_id === lane.crew.crew_id && selection.day === selectedDay`. `onSelect` passes `{ kind: 'job', …, tower_id: bar.entry.tower_id }`. The free-lane button passes `{ kind: 'free', crew_id, day: selectedDay }`.
- `components/schedule/ScheduleGridByTower.tsx` — cell buttons pass `kind: 'job'` with the entry's `tower_id`; the empty-cell Dispatch button passes `{ kind: 'emergency', tower_id, day }`.
- `components/schedule/UnscheduledBar.tsx` — `routeToOperator` calls `select({ kind: 'emergency', tower_id, day })`.
- `components/schedule/RouteMap.tsx` — reads `selection` and derives `{crew_id, day}` from any kind that has them; keeps drawing the **whole crew-day route** and emphasises the selected stop.

- [ ] **Step 3: Verify**

Run: `cd src/frontend && npm run build`
Expected: PASS. TypeScript is the migration tool here — the union makes every unmigrated site a compile error. **Do not add `as any` to silence one.**

Run: `cd src/frontend && npm run lint`
Expected: PASS

Browser check (backend running, `npm run dev`), on a crew-day with two or more bars:
1. Click the **second** bar. The why panel must name that tower, not the first.
2. Only that bar shows the selected treatment.
3. The move control's tower is the second job.

If the AOI has no multi-bar day (Sunway usually does not — every maintain tower is a 4h civil job), test against the offline fixture by stopping the backend.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/state/useScheduleStore.ts src/frontend/src/pages/Schedule.tsx src/frontend/src/components/schedule/
git commit -m "fix(schedule): make selection per-job instead of per-crew-day

WhySlotPanel resolved the cell with a first-match .find on crew+day, so the
second job of a crew-day showed the first job's explanation and move control."
```

---

# Phase 3 — Layout shell

---

### Task 10: Contextual detail panel

**Files:**
- Create: `src/frontend/src/components/schedule/DetailPanel.tsx`
- Modify: `src/frontend/src/pages/Schedule.tsx`

**Interfaces:**
- Consumes: `Selection` (Task 9)
- Produces: `<DetailPanel />` — renders nothing when `selection` is null

- [ ] **Step 1: Create `DetailPanel.tsx`**

```tsx
import { useScheduleStore } from '../../state/useScheduleStore';
import { RouteMap } from './RouteMap';
import { WhySlotPanel } from './WhySlotPanel';

/**
 * The right column, mounted only when something is selected.
 *
 * It used to be always present at 360px, showing placeholder prose most of the
 * time — the calendar was permanently paying for a panel that was usually
 * empty. Nothing is mounted here at rest, so MapLibre does not initialise a
 * second map instance until a route actually needs drawing.
 *
 * No backdrop-filter: this surface animates its width, and blurring a moving
 * surface is the one thing the blur budget forbids outright. The opaque
 * gradient does the separation work instead.
 */
export function DetailPanel() {
  const selection = useScheduleStore((s) => s.selection);
  const select = useScheduleStore((s) => s.select);

  if (!selection) return null;

  return (
    <aside
      className="glass-raised flex w-[380px] shrink-0 flex-col border-y-0 border-r-0"
      aria-label="Selection detail"
    >
      <div className="flex items-center justify-between border-b border-overlay/10 px-4 py-2.5">
        <h2 className="eyebrow">
          {selection.kind === 'job' && 'Scheduled visit'}
          {selection.kind === 'free' && 'Free crew-day'}
          {selection.kind === 'reserve' && 'Reserve capacity'}
          {selection.kind === 'emergency' && 'Dispatch'}
        </h2>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close detail panel"
          className="rounded-md px-2 py-1 text-micro text-muted transition-colors duration-150 hover:bg-overlay/[0.06] hover:text-fg"
        >
          Close
        </button>
      </div>
      {selection.kind === 'job' && <RouteMap />}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <WhySlotPanel />
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Re-layout `Schedule.tsx`**

Replace the `<aside>` block with `<DetailPanel />`. Move `AgentChat` out of the aside (Task 20 wraps it in `AgentDock`; until then render it as a fixed-height strip under the board). The `<div className="flex min-h-0 flex-1">` wrapper stays — the panel is a flex sibling, so the calendar **re-flows** rather than being overlaid and no bar hides behind the panel.

- [ ] **Step 3: Verify**

Run: `cd src/frontend && npm run build && npm run lint`
Expected: PASS

Browser check:
1. At rest the calendar spans the full width and no panel is present.
2. Selecting a job slides the panel in; the timeline narrows, no bar is occluded.
3. Close returns to full width.
4. Navigate to `/` and confirm the console graticule, cursor readout and scale rule still describe the console — `RouteMap` unmounting must not have disturbed `useMapInstance`.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/schedule/DetailPanel.tsx src/frontend/src/pages/Schedule.tsx
git commit -m "feat(schedule): mount the detail column only on selection"
```

---

# Phase 4 — Week strip and role-grouped timeline

---

### Task 11: `lib/roleTeams.ts`

**Files:**
- Create: `src/frontend/src/lib/roleTeams.ts`

**Interfaces:**
- Produces: `ROLE_TEAMS: RoleTeam[]`, `roleTeam(crewType: string): RoleTeam | undefined`

```ts
import { CREW_TYPE_GLYPH } from './gantt';

/**
 * The four crew types, as capabilities rather than as a flat crew list.
 *
 * The roster was already role-typed and actions.yaml already maps each Annex C
 * factor onto a type — but on the Sunway AOI every maintain-band tower resolves
 * to flood work, so only civil crews were ever drawn and the board read as one
 * undifferentiated pool. Grouping by type is what makes the mapping legible.
 *
 * Identity is carried by grouping, label and glyph, NOT by colour: the cool
 * accent is interface chrome and the warm triad is severity, and a fifth hue
 * would break the property that a warm colour on screen always means risk.
 * Grouping also survives greyscale, which colour does not.
 */
export interface RoleTeam {
  crewType: string;
  label: string;
  /** Annex C factors this team's work orders answer. */
  answers: string;
  glyph: string | undefined;
  /**
   * Shown when the group has no work in the current AOI. Required, not
   * optional — an unexplained empty group reads as a bug, and hiding it would
   * hide a real capability from the planner.
   */
  emptyReason: string;
}

export const ROLE_TEAMS: RoleTeam[] = [
  {
    crewType: 'civil',
    label: 'Civil',
    answers: 'A1 flood · A2 terrain',
    glyph: CREW_TYPE_GLYPH.civil,
    emptyReason: 'No flood or terrain work scheduled in this AOI.',
  },
  {
    crewType: 'power',
    label: 'Power',
    answers: 'A3 grid dependence',
    glyph: CREW_TYPE_GLYPH.power,
    emptyReason: 'No grid-dependence work scheduled in this AOI.',
  },
  {
    crewType: 'rf',
    label: 'RF',
    answers: 'A4 equipment vintage',
    glyph: CREW_TYPE_GLYPH.rf,
    emptyReason: 'No equipment-refresh work scheduled in this AOI.',
  },
  {
    crewType: 'electrical',
    label: 'Electrical',
    answers: 'A5 lightning',
    // Not "no work today" — the factor itself is unavailable on this dataset.
    // prepare_pilot_dataset.py sets flash_density = NaN and the adapter drops
    // the column, so the AHP matrix renormalises to 5x5 and no lightning work
    // order can ever be produced here. Saying "no work" would imply the
    // opposite of what is true.
    emptyReason: 'No lightning work — the A5 factor is unavailable on this dataset.',
    glyph: CREW_TYPE_GLYPH.electrical,
  },
];

export function roleTeam(crewType: string): RoleTeam | undefined {
  return ROLE_TEAMS.find((t) => t.crewType === crewType);
}
```

- [ ] **Verify + commit**

Run: `cd src/frontend && npm run build && npm run lint` → PASS

```bash
git add src/frontend/src/lib/roleTeams.ts
git commit -m "feat(schedule): add role-team identity for the four crew types"
```

---

### Task 12: `WeekStrip.tsx` and horizon-driven days

**Files:**
- Create: `src/frontend/src/components/schedule/WeekStrip.tsx`
- Modify: `src/frontend/src/lib/scheduleDays.ts`, `src/frontend/src/state/useScheduleStore.ts`, `src/frontend/src/components/schedule/MoveControl.tsx`, `ScheduleGridByTower.tsx`
- Delete: `src/frontend/src/components/schedule/DayTabs.tsx`

**This closes the two-invisible-days defect.** `SCHEDULE_DAYS` is deleted outright so it cannot be reintroduced.

- [ ] **Step 1: Strip `scheduleDays.ts` to `dayLabel`**

```ts
/**
 * Day labelling only.
 *
 * SCHEDULE_DAYS used to live here as five hardcoded ISO dates while
 * policy.yaml planned over seven. Anything the solver booked on days 6-7
 * rendered in no tab, no column and no move dropdown — scheduled by the
 * backend and invisible in the UI. Days now come from run.horizon. Do not
 * reintroduce a constant here.
 */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
}
```

Every `SCHEDULE_DAYS` import becomes `useScheduleStore((s) => s.run.horizon)`. In the store, seed `selectedDay: ''` and have `setRun` adopt `run.horizon[0]` when `selectedDay` is empty or absent from the new horizon:

```ts
  setRun: (run) =>
    set((state) => ({
      run,
      selectedDay:
        state.selectedDay && run.horizon.includes(state.selectedDay)
          ? state.selectedDay
          : (run.horizon[0] ?? ''),
    })),
```

- [ ] **Step 2: Create `WeekStrip.tsx`**

Renders one column per `run.horizon` entry. Per day: a load bar whose filled portion is booked crew-days and whose hatched portion is reserve, plus `tnum` counts for jobs and reserve. Selected day carries the accent underline (`border-b-2 border-accent`), matching `NavPill`.

**The load bar's fill uses `--color-accent`, not a band colour** — it counts work, it is not a severity reading. A warm hue here would falsely imply risk. Reserve uses the same hatched `overlay/[0.06]` treatment as `ReserveBand` so the two read as the same thing at two scales.

```tsx
const jobs = run.entries.filter((e) => e.day === day).length;
const reserved = run.reserve.filter((r) => r.day === day).length;
```

Keep `role="tablist"` / `role="tab"` / `aria-selected` from `DayTabs`, and keep the per-day job count — the old five-column grid made load legible at a glance and that must not be lost.

- [ ] **Step 3: Delete `DayTabs.tsx`** and replace its use in `Schedule.tsx` with `<WeekStrip />`, rendered for **both** view modes (the by-site view needs the horizon too).

- [ ] **Step 4: Verify**

Run: `cd src/frontend && npm run build && npm run lint` → PASS

Browser check:
1. **Seven** day columns, not five.
2. `MoveControl`'s day dropdown offers all seven.
3. `ScheduleGridByTower` renders seven day columns.
4. Reserve counts appear on days 0, 3 and 6.
5. Offline: the fixture horizon renders and the fixture reserve shows.

- [ ] **Step 5: Commit**

```bash
git add -A src/frontend/src
git commit -m "feat(schedule): drive days from run.horizon and add the week strip

Deletes SCHEDULE_DAYS. Work the solver booked on horizon days 6-7 was
previously invisible in every view."
```

---

### Task 13: Reserve spans in `lib/gantt.ts`

**Files:**
- Modify: `src/frontend/src/lib/gantt.ts`
- Create: `src/frontend/src/lib/gantt.test.mjs`

**Interfaces:**
- Consumes: `ReserveSlot` (Task 5)
- Produces: `buildLanes(crews, entries, axis, reserve)` — each `GanttLane` gains `reserved: boolean` and `reserveSpan: { leftPct: number; widthPct: number } | null`

- [ ] **Step 1: Write the failing test**

Create `src/frontend/src/lib/gantt.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAxis, buildLanes } from './gantt.ts';

const CREW = {
  crew_id: 'SEL-C1', crew_type: 'civil', territory: 'Selangor', shift_hours: 8,
  depot: { lon: 101.588, lat: 3.045, name: 'Subang Jaya' },
  name: 'Subang Jaya Civil 1', max_travel_km: 40, members: [],
};

test('a reserved crew-day yields a full-width reserve span and no bars', () => {
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, [
    { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].reserved, true);
  assert.equal(lanes[0].bars.length, 0);
  assert.ok(lanes[0].reserveSpan);
  assert.equal(Math.round(lanes[0].reserveSpan.widthPct), 100);
});

test('an unreserved lane has no reserve span', () => {
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, []);
  assert.equal(lanes[0].reserved, false);
  assert.equal(lanes[0].reserveSpan, null);
});

test('utilisation of a reserved lane is null, not zero', () => {
  // Zero would render a 0% meter as though the crew were idle by accident.
  // Reserved capacity is deliberately empty and must read differently.
  const axis = buildAxis([]);
  const lanes = buildLanes([CREW], [], axis, [
    { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
  ]);
  assert.equal(lanes[0].utilisationPct, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/gantt.test.mjs`
Expected: FAIL — `lanes[0].reserved` is `undefined`

- [ ] **Step 3: Implement** — add `reserved` and `reserveSpan` to `GanttLane`, accept a fourth `reserve: ReserveSlot[]` parameter (defaulting to `[]` so existing callers compile), and when a lane's `(crew_id, day)` is reserved, set `reserved: true`, `utilisationPct: null`, and a span covering the axis.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/frontend && node --experimental-strip-types --test src/lib/gantt.test.mjs` → 3 pass

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/lib/gantt.ts src/frontend/src/lib/gantt.test.mjs
git commit -m "feat(schedule): model reserve spans in gantt geometry"
```

---

### Task 14: `TimelineBoard.tsx`, `RoleGroup.tsx`, `ReserveBand.tsx`

**Files:**
- Create: those three
- Delete: `src/frontend/src/components/schedule/GanttBoard.tsx`

`TimelineBoard` keeps everything already correct in `GanttBoard` — `buildAxis`/`buildLanes`, solver-only clocks, drawn travel connectors, the `untimed` fallback, the skipped closing gridline (a 1px rule at `left:100%` makes the whole board scroll by one pixel), and the inward-anchored first/last tick labels.

It adds:
1. **Role grouping** — lanes partitioned by `crew.crew_type` in `ROLE_TEAMS` order, each under a `<RoleGroup>` header carrying label, glyph, `answers`, and the group's aggregate utilisation.
2. **Empty groups render** their `emptyReason` rather than vanishing.
3. **`<ReserveBand>`** for `lane.reserved` — hatched via a CSS `repeating-linear-gradient` on `overlay/[0.06]` with an `overlay/12` hairline, labelled `RESERVE`, `aria-label="Reserve capacity, {crew}, {day}"`, selecting `{ kind: 'reserve', … }`. **No band colour and no accent** — reserve is protected absence, neither risk nor control.
4. **Per-bar selection** from Task 9.

- [ ] **Verify**

Run: `cd src/frontend && npm run build && npm run lint` → PASS

Browser check: four role groups always present; `ELECTRICAL` shows its A5 reason; reserve bands visible but recessive; a reserve band opens `ReserveDetail`; measure the hatch against the panel ground for ≥3:1 on its hairline.

- [ ] **Commit**

```bash
git add -A src/frontend/src/components/schedule
git commit -m "feat(schedule): role-grouped timeline with reserve bands"
```

---

### Task 15: `ReserveDetail.tsx`

**Files:**
- Create: `src/frontend/src/components/schedule/ReserveDetail.tsx`
- Modify: `WhySlotPanel.tsx` (replace the Task 9 `// TODO(Task 15)` marker)

States what the reserve protects: crew, day, role team, the factors that team answers, and the count of unscheduled towers of that `crew_type` waiting. Offers **Spend this reserve** — assigns the highest-risk matching unscheduled tower via `/schedule/pin` with `pin_reason: 'emergency'`, then reports that **nothing was displaced**. That contrast is the entire argument for the feature and the demo must be able to show it.

- [ ] **Verify + commit** — build, lint, and a browser run of the spend flow confirming `dropped` is empty.

```bash
git add src/frontend/src/components/schedule/ReserveDetail.tsx src/frontend/src/components/schedule/WhySlotPanel.tsx
git commit -m "feat(schedule): reserve detail panel with a spend-reserve action"
```

---

# Phase 5 — Work queue

---

### Task 16: `WorkQueue.tsx`

**Files:**
- Create: `src/frontend/src/components/schedule/WorkQueue.tsx`
- Delete: `src/frontend/src/components/schedule/UnscheduledBar.tsx`

Tabs: **Unscheduled** · **SLA at risk** · **Deferred** · **Pinned**, with `tnum` count badges matching the week strip.
Columns: Site · Operator · Factor · Risk · Team · Due · **Blocked by** · action.

The `Blocked by` column is the point of the rewrite. Map `UnscheduledDetail.reason` to copy:

```ts
const BLOCKED_BY: Record<UnscheduledReason, string> = {
  no_capacity: 'No capacity',
  past_sla: 'Past SLA',
  monsoon_blocked: 'Monsoon window',
  no_crew_type: 'No crew of this type',
  reserved: 'Held as reserve',
};
```

This replaces one static sentence — *"Civil work is blocked in flood zones from November to March"* — which rendered in August next to a count that had nothing to do with monsoon.

Risk figures use `bandInk()`; row spines use `bandColor()`. Site labels use the derived `Operator X · site NNNN` form, **not** `placeName()`, whose Kelantan names contradict the Sunway coordinates. Bulk select is out of scope.

- [ ] **Verify + commit** — build, lint, browser check that each row's reason matches what the solver reported and that `reserved` rows appear once Phase 1 is on.

```bash
git add -A src/frontend/src/components/schedule src/frontend/src/pages/Schedule.tsx
git commit -m "feat(schedule): tabbed work queue with per-row blocking reasons"
```

---

# Phase 6 — Readiness readout

---

### Task 17: `lib/readiness.ts`

**Files:**
- Create: `src/frontend/src/lib/readiness.ts`, `src/frontend/src/lib/readiness.test.mjs`

**Interfaces:**
- Produces: `readinessByTeam(run: ScheduleRun, today?: string): TeamReadiness[]` where
  ```ts
  interface TeamReadiness { crewType: string; label: string; reserveDays: number; availableToday: boolean; nextReserveDay: string | null; }
  ```

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readinessByTeam } from './readiness.ts';

const RUN = {
  run_id: 'r', horizon: ['2026-08-17', '2026-08-18', '2026-08-19'],
  entries: [], unscheduled: [], unscheduled_detail: [], risk_weighted_wait: 0,
  reserve: [
    { crew_id: 'SEL-C1', day: '2026-08-17', crew_type: 'civil' },
    { crew_id: 'SEL-C2', day: '2026-08-19', crew_type: 'civil' },
    { crew_id: 'SEL-P1', day: '2026-08-19', crew_type: 'power' },
  ],
};

test('counts reserve crew-days per team', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN).map((t) => [t.crewType, t]));
  assert.equal(byType.civil.reserveDays, 2);
  assert.equal(byType.power.reserveDays, 1);
  assert.equal(byType.rf.reserveDays, 0);
});

test('availableToday is true only when today itself carries reserve', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN, '2026-08-17').map((t) => [t.crewType, t]));
  assert.equal(byType.civil.availableToday, true);
  assert.equal(byType.power.availableToday, false);
});

test('nextReserveDay points at the next protected day, or null', () => {
  const byType = Object.fromEntries(readinessByTeam(RUN, '2026-08-18').map((t) => [t.crewType, t]));
  assert.equal(byType.power.nextReserveDay, '2026-08-19');
  assert.equal(byType.rf.nextReserveDay, null);
});

test('every team is returned even with no reserve at all', () => {
  // A team missing from the readout is indistinguishable from a team with no
  // cover. Four rows, always.
  assert.equal(readinessByTeam({ ...RUN, reserve: [] }).length, 4);
});
```

- [ ] **Step 2–4:** run (FAIL), implement over `ROLE_TEAMS` so all four teams are always returned, run (4 pass), commit.

```bash
git add src/frontend/src/lib/readiness.ts src/frontend/src/lib/readiness.test.mjs
git commit -m "feat(schedule): derive per-team readiness from run.reserve"
```

---

### Task 18: `ReadinessBar.tsx` and the baseline delta

**Files:**
- Create: `src/frontend/src/components/schedule/ReadinessBar.tsx`
- Modify: `src/frontend/src/api/client.ts`, `queries.ts`, `pages/Schedule.tsx`

Add `getScheduleBaseline()` against `GET /schedule/baseline` and a `useBaselineQuery()` hook. **Type it `T | null` and fall back to `null`, never a zeroed object** — a `0%` improvement rendered as a measurement is the `rho_mean: 0` failure again.

`ReadinessBar` renders as a child of `PageHeader` (not a replacement for its top row — that row is shared chrome across every non-map route). Left: four team chips, each `label · N crew-days`, with a filled dot when `availableToday`. Right: **risk-weighted wait vs. naive dispatch**, or `—` when the query is null.

- [ ] **Verify + commit** — build, lint, browser check that offline shows `—` for the delta rather than a fabricated percentage.

```bash
git add -A src/frontend/src
git commit -m "feat(schedule): readiness bar with per-team reserve and baseline delta"
```

---

# Phase 7 — Real agent wiring

---

### Task 19: SSE client for `POST /agent/chat`

**Files:**
- Modify: `src/frontend/src/api/client.ts`
- Create: `src/frontend/src/lib/agentEvents.ts`

**The backend contract, read from `agent/runner.py:14-21` and `format_sse`:**

```
event: text             data: {"text": "..."}
event: tool_call        data: {"name": "...", "input": {...}}
event: tool_result      data: {"name": "...", "output": {...}}
event: constraint_echo  data: {"text": "..."}
event: schedule         data: <ScheduleRun-shaped dict, solver output only>
event: done             data: {}
```

Wire format is `event: <name>\ndata: <json>\n\n`. Both the real Claude path and the deterministic fallback emit this same vocabulary, so one wiring covers both and the frontend never needs to know which is active.

```ts
export type AgentEvent =
  | { event: 'text'; data: { text: string } }
  | { event: 'tool_call'; data: { name: string; input: unknown } }
  | { event: 'tool_result'; data: { name: string; output: unknown } }
  | { event: 'constraint_echo'; data: { text: string } }
  | { event: 'schedule'; data: ScheduleRun }
  | { event: 'done'; data: Record<string, never> };
```

`streamAgentChat(message: string, signal: AbortSignal): AsyncGenerator<AgentEvent>` uses `fetch` + `res.body.getReader()` and splits on `\n\n` — **not** `EventSource`, which cannot issue a POST.

- [ ] **Verify + commit** — a `node` script against a running backend printing the event sequence for `"crew SEL-C2 unavailable Thursday"`.

---

### Task 20: `AgentChat` on the real endpoint, `AgentDock`

**Files:**
- Modify: `src/frontend/src/components/schedule/AgentChat.tsx`
- Create: `src/frontend/src/components/schedule/AgentDock.tsx`
- Delete: `src/frontend/src/lib/mockReplan.ts`

**This is the honesty fix.** `AgentChat` currently labels itself "Optimizer", offers "Re-optimize", replies "Re-optimized. N changes" — and does all of it client-side via `lib/mockReplan.ts`, writing straight into the store with `useScheduleStore.setState` and fabricating the objective as `risk_weighted_wait * (1 + dropped * 0.05)`.

Replace with: send → consume the stream → render `text` chunks incrementally (the real stream replaces `useStreamedText`'s simulation) → show `constraint_echo` as the parsed constraint → on `schedule`, call `setRun(data)` **verbatim**. Never re-describe solver output in the model's own words, and never compute a diff client-side — if a summary is needed, derive it from the before/after runs and label it as such.

`AgentDock` is the collapsible bottom-right shell: collapsed to a single bar by default, expanding over the queue. It may carry glass (it does not animate position, only height) and is reachable without a selection.

Delete `lib/mockReplan.ts`. `lib/agentParser.ts` stays — it is still useful for optimistic local echo before the first event arrives, but **must not** gate or alter what the server returns.

- [ ] **Verify + commit**

Browser check with the backend running: type `crew SEL-C2 unavailable Thursday`, confirm the network tab shows `POST /agent/chat` streaming, that the board updates from the `schedule` event, and that no summary text appears that the server did not send.

If the backend is unreachable the dock must say so plainly — it must not silently fall back to a local re-plan, which is the exact behaviour being removed.

```bash
git rm src/frontend/src/lib/mockReplan.ts
git add -A src/frontend/src
git commit -m "feat(schedule): wire the constraint chat to POST /agent/chat

Removes lib/mockReplan.ts, a client-side re-planner that labelled itself
'Optimizer' and reported fabricated re-optimisation results."
```

---

# Phase 8 — Territory, by-site view, cleanup

---

### Task 21: `TerritorySelect.tsx`

**Files:**
- Create: `src/frontend/src/components/schedule/TerritorySelect.tsx`
- Modify: `TimelineBoard.tsx`, `MoveControl.tsx`, `EmergencyPanel.tsx`, `WorkQueue.tsx`

Replaces `territory === 'Selangor'`, currently hardcoded in four components, with one store field and one selector.

**It cannot be fully live.** `GET /towers` serves 132 Sunway towers only (`adapter/ml_source.py:11-12`); of the 30 crews in `crews.json`, 14 territories carry `members: ["placeholder"]` and have no scorable work. So:

- List **all 15 territories** with crew counts — the national roster becomes visible.
- **Selangor** selectable, and the default.
- Every other option **`aria-disabled`** with `title="No scored towers in this territory — the pilot dataset covers Sunway/Selangor only."`

`aria-disabled` rather than `disabled` follows the AOI-tools and vintage-scrubber precedent: `disabled` removes the option from the tab order, so a keyboard user reaches neither the control nor its explanation. Enabling a territory later is a one-line predicate change.

- [ ] **Verify + commit** — build, lint, keyboard-only check that a disabled option is still reachable and announces its title.

---

### Task 22: `ScheduleGridByTower` to seven columns

**Files:** modify `src/frontend/src/components/schedule/ScheduleGridByTower.tsx`

Retitle to **By site**. Columns come from `run.horizon` (seven, not five). Per-job selection from Task 9. Reserved crew-days shown as a recessive marker so a gap is distinguishable from protected capacity. Keep the day-column shape — a tower takes at most one job per day, so an hour axis buys nothing.

- [ ] **Verify + commit**

---

### Task 23: Delete dead code and refresh `CLAUDE.md`

**Files:**
- Delete: `src/frontend/src/components/schedule/ScheduleGrid.tsx` (152 lines, unimported), `pages/TowerDetail.tsx` (orphaned — `Investigation` serves all three routes)
- Modify: `api/queries.ts` — remove `useEmergencyDispatch` (unused; `EmergencyPanel` correctly routes via `/schedule/pin`, which honours `target_day`, where `/schedule/emergency` always forces "today")
- Modify: `lib/whySlot.ts` — remove the hardcoded `MONSOON_DAYS = ['2026-08-19']`. The online path uses `GET /schedule/why`; the offline path drops the fabricated reason rather than inventing one.
- Modify: `CLAUDE.md`

`CLAUDE.md` edits: the "crew view shows one day / tower view shows the week" paragraph now describes the week strip and role grouping; selection is `{crew_id, day, tower_id}`, not `{crew_id, day}`; add the reserve/readiness model to the solver section; drop the `lib/mockReplan.ts` warning added during the audit, since the file is gone.

- [ ] **Verify**

Run: `cd src/backend && pytest -q -p no:cacheprovider` → all pass
Run: `cd src/frontend && npm run build && npm run lint` → PASS
Run: `cd src/frontend && node --experimental-strip-types --test src/lib/*.test.mjs` → all pass
Run: `cd src/frontend && grep -rn "SCHEDULE_DAYS\|mockReplan\|selectedCell\|emergencyTarget" src/` → **no matches**

- [ ] **Commit**

```bash
git add -A
git commit -m "chore(schedule): remove dead code and refresh CLAUDE.md"
```

---

## Final acceptance

Run the full verification set, then walk the browser checklist from the spec §14:

1. Multi-job crew-day: clicking the second bar shows *that* job.
2. All seven horizon days appear in the week strip and the move dropdown.
3. Empty role groups render their reason string, not blank.
4. Reserve bands are visible, recessive, and not mistakable for booked work.
5. The panel is unmounted with nothing selected; the calendar is full width.
6. Offline: banner shows, readiness renders from fixture reserve, no zeroed struct.
7. `RouteMap` does not disturb the Overview's graticule, cursor readout or scale rule.
8. Contrast measured for the reserve hatch and role headers — not eyeballed.
9. **The demo spends a reserve slot:** dispatch an emergency into a reserved crew-day and show the displaced-work list comes back empty. Without this the reserve reads as wasted capacity, and the whole feature loses its argument.
