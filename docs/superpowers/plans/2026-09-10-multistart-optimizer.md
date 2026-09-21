# Multi-Start Optimizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise schedule quality above single-pass greedy by running the same solver several times under perturbed orderings and keeping the best result — without touching a single constraint.

**Architecture:** `Optimizer.optimize()` already sorts work once and then calls a self-contained `run_pass()`. Tasks 1–5 make one pass cheaper and make the reserve counterfactual separable; Task 6 wraps the existing pass in a seeded, budget-bounded restart loop that re-sorts `remaining` between runs. No feasibility code is modified anywhere in this plan.

**Tech Stack:** Python 3, stdlib only (`random`, `time`), pytest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-10-multistart-optimizer-design.md`

## Global Constraints

- **Determinism is non-negotiable.** `scheduler/test_optimize.py::test_counterfactual_pass_does_not_change_real_placement` asserts two `optimize()` calls return identical entries, reserve and `risk_weighted_wait`. It must stay green after every task. Seed the RNG from policy — never from clock or entropy.
- **`risk_weighted_wait` alone is never a selection criterion.** It accumulates only for placed jobs (`optimize.py:654`, `:696`), so the lowest score across restarts is the restart that scheduled the *least* work. See Task 1.
- **Restart 0 is always the unperturbed baseline** and always runs. This is what guarantees multi-start can never return a worse schedule than today's.
- **Absent policy block means exactly one pass.** Every existing test builds its policy inline without a `restarts` key (e.g. `_tiny_setup()`); all of them must keep today's behaviour bit for bit.
- **No hard constraint, objective formula, or API shape changes.** The feature is worthless if it cannot be described as "same rules, better search".
- **The `tower_id` tie-break survives every sort.** `remaining.sort(key=lambda wo: (key, wo["tower_id"]))` — the second element fixed a real phantom-displacement bug (see the comment at `optimize.py:422-431`).
- **Line numbers re-verified 2026-09-10** against `243d4bb`, after the measured-road-matrix work landed. That work added a **third `leg()` call site** — the return-to-depot leg at `:588` — which Task 4 must also cover.
- Commit messages end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`
- Run tests from `src/backend`: `python -m pytest scheduler/test_optimize.py -v`

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/backend/scheduler/optimize.py` | All solver changes: scoring, config, precomputation, caching, restart loop, reporting | 1–6 |
| `src/backend/scheduler/test_optimize.py` | All tests (house convention: tests sit beside the module) | 1–8 |
| `src/backend/config/policy.yaml` | The restart budget, as assumed parameters | 2 |
| `src/backend/scheduler/override.py` | Force single-pass on the interactive path | 7 |
| `src/backend/scheduler/baseline.py` | Keep the policy comparison apples-to-apples | 8 |

---

### Task 1: Selection criterion

The trap from spec §1, isolated as a pure function so it can be tested with no solver involved. Do this first — it is the piece most likely to be got subtly wrong, and everything downstream depends on it.

**Files:**
- Modify: `src/backend/scheduler/optimize.py` (add after `urgency_factor`, ~line 280)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `priority(tower)` — already defined at `optimize.py:240`
- Produces: `_candidate_score(unscheduled, towers_by_id, risk_weighted_wait, restart_index) -> tuple[float, float, int]`, lower-is-better on every element, safe to compare with `<`

- [ ] **Step 1: Write the failing test**

Add to `src/backend/scheduler/test_optimize.py`:

```python
def test_selection_prefers_more_work_scheduled_over_a_lower_wait():
    """THE trap (design doc §1). risk_weighted_wait accrues only for jobs that
    were PLACED, so a restart that drops a high-risk tower simply stops paying
    for it and scores 'better'. Selecting on wait alone would systematically
    pick the worst schedule in the set and report it as an improvement."""
    towers = {
        "T_HI": {"tower_id": "T_HI", "risk": 0.95},
        "T_LO": {"tower_id": "T_LO", "risk": 0.10},
    }
    # Placed everything, and paid wait for all of it.
    placed_all = _candidate_score([], towers, 50.0, 1)
    # Dropped the 0.95 tower, so it barely accrued anything.
    dropped_important = _candidate_score(["T_HI"], towers, 5.0, 0)
    assert placed_all < dropped_important


def test_selection_weights_unserviced_towers_by_risk_not_count():
    """One 0.95 tower left unserviced is worse than one 0.10 tower left
    unserviced. A plain count would call these equal."""
    towers = {
        "T_HI": {"tower_id": "T_HI", "risk": 0.95},
        "T_LO": {"tower_id": "T_LO", "risk": 0.10},
    }
    dropped_low = _candidate_score(["T_LO"], towers, 10.0, 0)
    dropped_high = _candidate_score(["T_HI"], towers, 10.0, 1)
    assert dropped_low < dropped_high


def test_selection_breaks_exact_ties_on_restart_index():
    """Two genuinely identical candidates must always resolve the same way,
    or the winner depends on iteration order and the run stops being
    reproducible."""
    towers = {"T1": {"tower_id": "T1", "risk": 0.5}}
    assert _candidate_score([], towers, 10.0, 0) < _candidate_score([], towers, 10.0, 3)
```

Add `_candidate_score` to the import block at `test_optimize.py:16-23`:

```python
from scheduler.optimize import (
    UNSCHEDULED_REASONS,
    OptimizeResult,
    Optimizer,
    ReserveSlot,
    ScheduleEntry,
    UnscheduledItem,
    _candidate_score,
)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k selection -v`
Expected: FAIL — `ImportError: cannot import name '_candidate_score'`

- [ ] **Step 3: Write the implementation**

Add to `src/backend/scheduler/optimize.py` immediately after `urgency_factor()` (~line 280):

```python
def _candidate_score(
    unscheduled: list[str],
    towers_by_id: dict[str, dict],
    risk_weighted_wait: float,
    restart_index: int,
) -> tuple[float, float, int]:
    """Ranking key for one restart's result. Lower wins, on every element.

    risk_weighted_wait ALONE is not a valid criterion and never can be: it
    accumulates only for jobs that were placed (the two `risk_weighted_wait
    +=` lines below), so a restart that fails to place a high-risk tower
    simply stops paying for it. Ranking on it directly would systematically
    select the restart that scheduled the LEAST work, while reporting the
    best number — and the fake improvement would grow with the restart count.

    So unserviced risk mass leads. It is risk-weighted rather than a plain
    count because leaving a 0.95 tower unscheduled is not equivalent to
    leaving a 0.10 one, and it introduces no new tunable constant to defend:
    priority() is the same function the sort key and the objective already
    use.

    restart_index last so two genuinely equal candidates always resolve the
    same way; without it the winner depends on iteration order and the run
    stops being reproducible.
    """
    unserviced = sum(
        priority(towers_by_id[t]) for t in unscheduled if t in towers_by_id
    )
    return (unserviced, risk_weighted_wait, restart_index)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k selection -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
feat(scheduler): selection criterion for comparing solver restarts

risk_weighted_wait accrues only for placed jobs, so ranking restarts on it
would pick whichever one scheduled the least work. Rank on unserviced risk
mass first, wait second, restart index last.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Restart budget config

**Files:**
- Modify: `src/backend/scheduler/optimize.py` (add after `_candidate_score`)
- Modify: `src/backend/config/policy.yaml` (append)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Produces: `RestartConfig` (frozen dataclass: `max_restarts`, `time_budget_ms`, `no_improve_stop`, `jitter`, `seed`) and `_restart_config(policy, override=None) -> RestartConfig`

- [ ] **Step 1: Write the failing test**

```python
def test_restart_config_absent_policy_block_means_one_pass():
    """Every existing test builds its policy inline with no `restarts` key.
    All of them must keep today's behaviour bit for bit."""
    cfg = _restart_config({})
    assert cfg.max_restarts == 1


def test_restart_config_disabled_means_one_pass():
    cfg = _restart_config({"restarts": {"enabled": False, "max_restarts": 16}})
    assert cfg.max_restarts == 1


def test_restart_config_reads_an_enabled_block():
    cfg = _restart_config({
        "restarts": {
            "enabled": True,
            "max_restarts": 16,
            "time_budget_ms": 1500,
            "no_improve_stop": 5,
            "jitter": 0.15,
            "seed": 20260910,
        }
    })
    assert cfg.max_restarts == 16
    assert cfg.time_budget_ms == 1500.0
    assert cfg.no_improve_stop == 5
    assert cfg.jitter == 0.15
    assert cfg.seed == 20260910


def test_restart_config_override_forces_single_pass():
    """The interactive override path passes restarts=1 explicitly."""
    cfg = _restart_config({"restarts": {"enabled": True, "max_restarts": 16}}, override=1)
    assert cfg.max_restarts == 1
```

Add `RestartConfig, _restart_config` to the test import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k restart_config -v`
Expected: FAIL — `ImportError: cannot import name '_restart_config'`

- [ ] **Step 3: Write the implementation**

Add to `src/backend/scheduler/optimize.py` after `_candidate_score`:

```python
@dataclass(frozen=True)
class RestartConfig:
    """How much search to spend. See config/policy.yaml `restarts`."""

    max_restarts: int
    time_budget_ms: float
    no_improve_stop: int
    jitter: float
    seed: int


def _restart_config(policy: dict, override: int | None = None) -> RestartConfig:
    """Restart budget from policy, defaulting to today's single unperturbed
    pass whenever the block is missing or disabled.

    Defaulting OFF is deliberate: every solver test builds its policy dict
    inline without this key, and a default-on would silently change what all
    of them are asserting. `override` is how the interactive override path
    (scheduler/override.py) forces single-pass regardless of policy.
    """
    cfg = policy.get("restarts") or {}
    max_restarts = int(cfg.get("max_restarts", 1)) if cfg.get("enabled", False) else 1
    if override is not None:
        max_restarts = int(override)
    return RestartConfig(
        max_restarts=max(1, max_restarts),
        time_budget_ms=float(cfg.get("time_budget_ms", 1500)),
        no_improve_stop=int(cfg.get("no_improve_stop", 5)),
        jitter=float(cfg.get("jitter", 0.15)),
        seed=int(cfg.get("seed", 20260910)),
    )
```

Append to `src/backend/config/policy.yaml`:

```yaml
restarts:
  # Multi-start search. The solver runs the SAME greedy pass several times
  # under slightly different work orderings and keeps the best result — it
  # does not change a single constraint, only which order work is offered in.
  # Restart 0 is always the unperturbed ordering, so the winner is chosen from
  # a set that always contains today's answer and this can never return a
  # worse schedule than single-pass.
  #
  # Assumed demo parameters (PRD §13). Measure before changing max_restarts:
  # cost scales with jobs x days x crews, so the same count behaves very
  # differently on the 132-tower pilot and the 1164-tower national set.
  enabled: true

  # Hard ceiling, restart 0 included. Best-of-N improves roughly
  # logarithmically — most of the achievable gain lands by ~10 and it
  # plateaus around ~25, so 16 sits at the knee.
  max_restarts: 16

  # The real bound. The initial solve is a page-load call, not an
  # interaction: 1.5s is invisible behind a spinner, 5s is not. Raise this
  # first if measurement shows headroom.
  time_budget_ms: 1500

  # Stop after this many consecutive restarts that fail to improve. On an
  # easy instance the first few find the plateau and the rest are waste.
  no_improve_stop: 5

  # Multiplicative jitter on the sort key: key * (1 + U(-j, j)). Multiplicative
  # because the key is a product whose scale varies by dataset, so additive
  # noise would be meaningless on one and overwhelming on another. Too small
  # and every restart reproduces restart 0; too large and the priority
  # ordering stops meaning anything.
  jitter: 0.15

  # Fixed, never clock- or entropy-seeded. Reproducibility is a project
  # invariant — the same reason demo_clock.today is pinned.
  seed: 20260910
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -v`
Expected: all pass — the 4 new ones, and every pre-existing test unchanged (they build policies without a `restarts` key, so they resolve to `max_restarts=1`).

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py src/backend/config/policy.yaml
git commit -m "$(cat <<'EOF'
feat(scheduler): restart budget in policy, defaulting to single-pass

Absent or disabled block resolves to exactly one unperturbed pass, so every
existing inline-policy test keeps today's behaviour.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Hoist crew-type and depot-range filtering out of the hot loop

Spec §5.2. A strict win even at one restart, so it lands and is verified on its own before any restart loop exists.

**Files:**
- Modify: `src/backend/scheduler/optimize.py:516-547` (inside `optimize()`, before `run_pass` is defined, and inside the placement loop)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `self._candidate_crews(wo, tower)` (`:337`), `travel_km(crew, tower, road_factor)`
- Produces: no new public surface — an internal precomputation. Output must be byte-identical to before.

- [ ] **Step 1: Write the characterization test**

This test must pass BEFORE and AFTER the change — it pins that the refactor is behaviour-preserving.

```python
def test_precomputed_candidates_do_not_change_placement():
    """Crew-type/territory filtering and depot range are pure functions of
    (work order, tower, crew) — hoisting them out of the day loop must not
    move a single job. Golden values captured from the pre-hoist solver."""
    crews, policy, towers, work_orders = _tiny_setup()
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    placed = [(e.tower_id, e.crew_id, e.day, e.order) for e in result.entries]
    assert placed == [("T1", "SEL-C1", "2026-08-17", 1), ("T2", "SEL-C1", "2026-08-18", 1)]
    assert result.unscheduled == []
```

- [ ] **Step 2: Run it against the CURRENT code to capture the golden values**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k precomputed -v`

If it fails, the asserted tuple is wrong for this dataset — read the actual value from the failure output and correct the assertion, then re-run until green. **Do not proceed until it is green against unmodified code.** A characterization test that was never green before the refactor proves nothing.

- [ ] **Step 3: Add the precomputation**

In `optimize()`, immediately after `remaining.sort(...)` (`:432`) and before `def run_pass(...)`:

```python
        # Restart-invariant and day-invariant: crew-type/territory matching and
        # depot range are pure functions of (work order, tower, crew), so they
        # are computed once here rather than once per work order per day per
        # pass. Keyed on crew_type as well as tower_id because a tower could in
        # principle carry work orders of different types.
        in_range: dict[tuple[str, str], list[tuple[dict, float]]] = {}
        has_typed_crew: dict[tuple[str, str], bool] = {}
        max_km_default = self.policy["travel"]["max_travel_km_default"]
        for wo in remaining:
            ck = (wo["tower_id"], wo["crew_type"])
            if ck in in_range:
                continue
            tower = towers_by_id[wo["tower_id"]]
            typed = self._candidate_crews(wo, tower)
            has_typed_crew[ck] = bool(typed)
            reachable: list[tuple[dict, float]] = []
            for crew in typed:
                dist = travel_km(crew, tower, road_factor)
                if dist <= crew.get("max_travel_km", max_km_default):
                    reachable.append((crew, dist))
            in_range[ck] = reachable
```

Then in the placement loop, replace `:521-525`:

```python
                candidates = self._candidate_crews(wo, tower)
                # Recorded now because the day loop below cannot distinguish "no
                # crew of this type in this territory" from "every day was full" —
                # by then there are simply no candidates to fail against.
                no_crew_type = not candidates
```

with:

```python
                ck = (wo["tower_id"], wo["crew_type"])
                candidates = in_range[ck]
                # Recorded now because the day loop below cannot distinguish "no
                # crew of this type in this territory" from "every day was full" —
                # by then there are simply no candidates to fail against. Read
                # from has_typed_crew, not from `candidates`: an empty
                # `candidates` now also means "typed crews exist but none are in
                # depot range", which is a capacity reason, not a crew-type one.
                no_crew_type = not has_typed_crew[ck]
```

And replace the head of the feasibility loop (`:539-547`):

```python
                    for crew in candidates:
                        key = (crew["crew_id"], day.isoformat())
                        if key in blocked_keys:
                            continue  # planner-declared unavailability
                        max_km = crew.get("max_travel_km", self.policy["travel"]["max_travel_km_default"])
                        dist = travel_km(crew, tower, road_factor)
                        if dist > max_km:
                            continue  # depot-range constraint
                        cd = state.get(key)
```

with:

```python
                    for crew, dist in candidates:
                        key = (crew["crew_id"], day.isoformat())
                        if key in blocked_keys:
                            continue  # planner-declared unavailability
                        # depot-range constraint already applied when `in_range`
                        # was built — it does not vary by day.
                        cd = state.get(key)
```

- [ ] **Step 4: Run the full solver suite**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -v`
Expected: all pass, including `test_precomputed_candidates_do_not_change_placement` with the same golden values and `test_counterfactual_pass_does_not_change_real_placement`.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
perf(scheduler): hoist crew-type and depot-range filters out of the day loop

Both are pure functions of (work order, tower, crew) and were recomputed for
every work order on every day of every pass. Behaviour-preserving, pinned by
a characterization test captured against the pre-hoist solver.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Memoize `leg()` for the duration of one solve

Spec §5.3.

**Files:**
- Modify: `src/backend/scheduler/optimize.py` (inside `optimize()`, plus the **three** `leg(...)` call sites at ~`:479`, ~`:566` and ~`:588`)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Produces: a local `cached_leg(from_key, from_lon, from_lat, to_key, to_lon, to_lat) -> tuple[float, int]` closure. Not exported.

- [ ] **Step 1: Write the failing test**

```python
def test_leg_results_are_cached_within_one_solve(monkeypatch):
    """The same (origin, destination) pair recurs constantly across days and
    restarts — the tower and depot sets do not move during a solve. Cache per
    optimize() call, never per process, so a reloaded travel matrix can never
    be served stale."""
    import scheduler.optimize as opt

    crews, policy, towers, work_orders = _tiny_setup()
    calls: list[tuple[str, str]] = []
    real_leg = opt.leg

    def counting_leg(from_key, from_lon, from_lat, to_key, to_lon, to_lat, rf, spd):
        calls.append((from_key, to_key))
        return real_leg(from_key, from_lon, from_lat, to_key, to_lon, to_lat, rf, spd)

    monkeypatch.setattr(opt, "leg", counting_leg)
    opt.Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)

    assert len(calls) == len(set(calls)), (
        f"leg() was called {len(calls)} times for {len(set(calls))} distinct "
        "pairs — the cache is not being consulted"
    )
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k leg_results_are_cached -v`
Expected: FAIL — call count exceeds distinct-pair count

- [ ] **Step 3: Write the implementation**

In `optimize()`, add next to the `in_range` precomputation from Task 3:

```python
        # Per-CALL, not per-process: a leg depends only on its two endpoints and
        # the two travel constants, and the endpoint set is fixed for the whole
        # solve. Across restarts the same pairs recur heavily, because restarts
        # differ in the ORDER work is placed, not in which towers exist. Scoped
        # to this call so a reloaded travel matrix can never be served stale.
        leg_cache: dict[tuple[str, str], tuple[float, int]] = {}

        def cached_leg(
            from_key: str, from_lon: float, from_lat: float,
            to_key: str, to_lon: float, to_lat: float,
        ) -> tuple[float, int]:
            ck = (from_key, to_key)
            hit = leg_cache.get(ck)
            if hit is None:
                hit = leg(
                    from_key, from_lon, from_lat,
                    to_key, to_lon, to_lat,
                    road_factor, avg_speed,
                )
                leg_cache[ck] = hit
            return hit
```

Replace the pin-seeding call site (~`:479`):

```python
                    leg_km, travel_min = leg(
                        origin_key, origin[0], origin[1],
                        tower["tower_id"], tower["lon"], tower["lat"],
                        road_factor, avg_speed,
                    )
```

with:

```python
                    leg_km, travel_min = cached_leg(
                        origin_key, origin[0], origin[1],
                        tower["tower_id"], tower["lon"], tower["lat"],
                    )
```

Replace the outbound feasibility call site (~`:566`):

```python
                        leg_km, leg_min = leg(
                            origin_key, origin[0], origin[1],
                            tower["tower_id"], tower["lon"], tower["lat"],
                            road_factor, avg_speed,
                        )
```

with:

```python
                        leg_km, leg_min = cached_leg(
                            origin_key, origin[0], origin[1],
                            tower["tower_id"], tower["lon"], tower["lat"],
                        )
```

And replace the return-to-depot call site (~`:588`) — **added by the measured-road-matrix work after this spec was written**. This is the single hottest of the three: unlike the outbound leg it depends on nothing that varies by day or by cursor position, only on (tower, this crew's depot), yet it is recomputed for every crew on every day of every pass. Keep the comment block above it exactly as it is; replace only the call:

```python
                        _, home_min = leg(
                            tower["tower_id"], tower["lon"], tower["lat"],
                            depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
                            crew["depot"]["lon"], crew["depot"]["lat"],
                            road_factor, avg_speed,
                        )
```

with:

```python
                        _, home_min = cached_leg(
                            tower["tower_id"], tower["lon"], tower["lat"],
                            depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
                            crew["depot"]["lon"], crew["depot"]["lat"],
                        )
```

The cache key is the endpoint pair, so the return leg and the outbound leg occupy **different** entries — `(tower, depot)` and `(depot, tower)` are stored separately. That is correct and must not be "optimized" into one: the matrix carries both directions explicitly because a real road network is not symmetric.

- [ ] **Step 4: Run the full suite**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -v`
Expected: all pass, including the new cache test and the determinism test.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
perf(scheduler): memoize travel legs for the duration of one solve

Keyed on the endpoint pair only and scoped to a single optimize() call, so a
reloaded travel matrix can never be served from a stale cache.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Make the reserve counterfactual runnable against a chosen pass

Spec §5.1. Extract the relabel so Task 6 can run it once on the winner instead of once per restart.

**Files:**
- Modify: `src/backend/scheduler/optimize.py:711-717`
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Produces: `_relabel_reserved(unscheduled_detail, shadow_entries) -> list[UnscheduledItem]`

- [ ] **Step 1: Write the failing test**

```python
def test_relabel_reserved_marks_only_towers_the_shadow_pass_recovered():
    """A tower is 'reserved' iff it is unscheduled in the real pass AND the
    reserve-off shadow pass would have placed it. Nothing else may be
    relabelled, and a pinned shadow placement never counts."""
    detail = [
        UnscheduledItem(tower_id="T_A", reason="no_capacity", deadline="2026-08-20", crew_type="civil"),
        UnscheduledItem(tower_id="T_B", reason="no_capacity", deadline="2026-08-20", crew_type="civil"),
    ]
    shadow = [
        ScheduleEntry(
            crew_id="SEL-C1", day="2026-08-17", order=1, tower_id="T_A",
            work_order={"tower_id": "T_A", "crew_type": "civil"},
            pinned=False, pin_reason=None, pinned_by=None,
        ),
    ]
    out = _relabel_reserved(detail, shadow)
    by_id = {d.tower_id: d.reason for d in out}
    assert by_id["T_A"] == "reserved"
    assert by_id["T_B"] == "no_capacity"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k relabel_reserved -v`
Expected: FAIL — `ImportError: cannot import name '_relabel_reserved'`

- [ ] **Step 3: Write the implementation**

Add at module level in `optimize.py`, after `_candidate_score`:

```python
def _relabel_reserved(
    unscheduled_detail: list[UnscheduledItem],
    shadow_entries: list[ScheduleEntry],
) -> list[UnscheduledItem]:
    """Apply the reserve counterfactual label to one pass's unscheduled detail.

    A tower is 'reserved' iff it is unscheduled in the real pass AND the
    reserve-off shadow pass would have placed it — never decided by anything
    observed during the real pass, so it cannot latch onto an incidental
    reserved crew-day the way the old per-day flag did.

    Extracted so the shadow pass can be run ONCE against the winning restart
    rather than once per restart: it does not touch entries, reserve or
    risk_weighted_wait, so it cannot change which restart wins, and running it
    per restart would double the cost of every one of them for a label thrown
    away N-1 times.
    """
    recoverable = {e.tower_id for e in shadow_entries if not e.pinned}
    return [
        replace(item, reason="reserved") if item.tower_id in recoverable else item
        for item in unscheduled_detail
    ]
```

Replace `optimize.py:711-717` (keep the long comment block above it — it still describes exactly what this does) with:

```python
        if reserved_keys:
            shadow_entries, _shadow_unscheduled, _shadow_detail, _shadow_wait = run_pass(set())
            unscheduled_detail = _relabel_reserved(unscheduled_detail, shadow_entries)
```

- [ ] **Step 4: Run the full suite**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -v`
Expected: all pass, including `test_reserved_label_is_counterfactual_not_sticky` and the determinism test.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
refactor(scheduler): extract the reserve counterfactual relabel

Lets the shadow pass run once against a chosen pass rather than inline, which
is what keeps multi-start at N+1 passes instead of 2N.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: The restart loop

**Files:**
- Modify: `src/backend/scheduler/optimize.py` — `optimize()` signature and the block from `remaining.sort(...)` to the shadow-pass call
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `_candidate_score` (Task 1), `_restart_config`/`RestartConfig` (Task 2), `_relabel_reserved` (Task 5)
- Produces: `Optimizer.optimize(..., restarts: int | None = None)`. `None` reads policy; an int forces that many. Sets local `winner_index`, `restarts_run`, `baseline_wait` for Task 7.

- [ ] **Step 1: Write the failing tests**

```python
def _restart_policy(base: dict, **overrides) -> dict:
    """_tiny_setup()'s policy with restarts enabled."""
    policy = dict(base)
    policy["restarts"] = {
        "enabled": True, "max_restarts": 8, "time_budget_ms": 5000,
        "no_improve_stop": 8, "jitter": 0.3, "seed": 7, **overrides,
    }
    return policy


def test_multistart_is_deterministic_across_calls():
    """Reproducibility is a project invariant. Same input, same schedule,
    every time — the RNG is seeded from policy, never from the clock."""
    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base)
    r1 = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    r2 = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert [e.to_dict() for e in r1.entries] == [e.to_dict() for e in r2.entries]
    assert r1.risk_weighted_wait == r2.risk_weighted_wait


def test_multistart_is_never_worse_than_the_unperturbed_pass():
    """Restart 0 runs the exact ordering used today and always runs, so the
    winner is chosen from a set that always contains today's answer."""
    crews, base, towers, work_orders = _tiny_setup()
    single = Optimizer(crews=crews, policy=base).optimize(work_orders, towers)
    multi = Optimizer(crews=crews, policy=_restart_policy(base)).optimize(work_orders, towers)
    single_score = _candidate_score(single.unscheduled, towers, single.risk_weighted_wait, 0)
    multi_score = _candidate_score(multi.unscheduled, towers, multi.risk_weighted_wait, 0)
    assert multi_score <= single_score


def test_multistart_respects_the_time_budget():
    """A zero budget still runs restart 0 — the budget may only ever cut
    restarts short, never skip the baseline."""
    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base, time_budget_ms=0)
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert result.restarts.restarts_run == 1
    assert result.entries, "a zero budget must still return a real schedule"


def test_explicit_restarts_argument_overrides_policy():
    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base, max_restarts=16)
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers, restarts=1)
    assert result.restarts.restarts_run == 1


def test_multistart_runs_the_shadow_pass_exactly_once(monkeypatch):
    """Spec §5.1 — this is the whole reason multi-start costs N+1 passes and
    not 2N. The counterfactual cannot change which restart wins, so running it
    per restart would double every restart's cost for a label thrown away N-1
    times. Asserted by call counter, never by timing."""
    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base, max_restarts=6)
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    import scheduler.optimize as opt

    shadow_calls = []
    real_relabel = opt._relabel_reserved

    def counting_relabel(detail, shadow_entries):
        shadow_calls.append(len(shadow_entries))
        return real_relabel(detail, shadow_entries)

    monkeypatch.setattr(opt, "_relabel_reserved", counting_relabel)
    result = opt.Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)

    assert result.restarts.restarts_run > 1, "this test is meaningless at N=1"
    assert len(shadow_calls) == 1, (
        f"shadow pass ran {len(shadow_calls)} times across "
        f"{result.restarts.restarts_run} restarts — it must run once, on the winner"
    )


def test_restart_stats_report_a_baseline_win_plainly():
    """winner_index == 0 is a legitimate, informative outcome: it says ordering
    is not what binds this instance. It must be reported, not hidden."""
    crews, base, towers, work_orders = _tiny_setup()
    result = Optimizer(crews=crews, policy=base).optimize(work_orders, towers)
    assert result.restarts.restarts_run == 1
    assert result.restarts.winner_index == 0
    assert result.restarts.improvement_pct == 0.0
    assert result.restarts.baseline_score == result.restarts.winner_score


def test_optimize_result_restarts_defaults_to_none():
    """Optional field, so the 3-tuple unpack contract is untouched."""
    result = OptimizeResult(entries=[], unscheduled=[], risk_weighted_wait=0.0)
    assert result.restarts is None
```

Add `RestartStats` to the test import block alongside the Task 1 and Task 2 additions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k "multistart or restart_stats" -v`
Expected: FAIL — `ImportError: cannot import name 'RestartStats'`

- [ ] **Step 3: Add the imports and the signature**

At the top of `optimize.py`, extend the stdlib imports — `import math` is already there at `:27`, so add two lines after it:

```python
import math
import random
import time
```

Change the `optimize()` signature (`:350-358`) to add one parameter:

```python
    def optimize(
        self,
        work_orders: list[dict],
        towers_by_id: dict[str, dict],
        pinned: list[ScheduleEntry] | None = None,
        today: date | None = None,
        sort_key_fn: Callable[[dict, dict], float] | None = None,
        blocked_crew_days: set[tuple[str, str]] | None = None,
        restarts: int | None = None,
    ) -> OptimizeResult:
```

And add to its docstring, after the `blocked_crew_days` paragraph:

```
        restarts: how many perturbed orderings to try, overriding policy.
        None reads config/policy.yaml's `restarts` block. Pass 1 to force a
        single unperturbed pass — the interactive override path does exactly
        that, because re-drawing the whole board from a different restart on
        every pin would make unrelated jobs jump around for reasons the
        planner cannot see.
```

- [ ] **Step 4: Add the reporting dataclass and its field**

Spec §6 — the measurement is a deliverable in its own right, because it is what PRD §13 promised. Added here rather than in a later task so the loop has somewhere to report into and this task ends fully green.

Add above `OptimizeResult` (`:146`):

```python
@dataclass
class RestartStats:
    """What the multi-start search actually did — the bound PRD §13 promised.

    improvement_pct compares risk_weighted_wait only, so it CAN be negative: a
    winner that schedules more work pays more wait for it, and that is a better
    schedule, not a worse one. The raw figures are carried alongside so nobody
    has to trust the derived one.
    """

    restarts_run: int
    winner_index: int
    baseline_score: float
    winner_score: float
    improvement_pct: float

    def to_dict(self) -> dict:
        return {
            "restarts_run": self.restarts_run,
            "winner_index": self.winner_index,
            "baseline_score": self.baseline_score,
            "winner_score": self.winner_score,
            "improvement_pct": self.improvement_pct,
        }
```

Add the field to `OptimizeResult`, after `unscheduled_detail` (`:161`) and before `__iter__` — which must stay a 3-tuple, since four call sites unpack it:

```python
    restarts: RestartStats | None = None
```

- [ ] **Step 5: Replace the single-pass call with the restart loop**

Replace `remaining.sort(key=lambda wo: (sort_key(wo), wo["tower_id"]))` (`:432`) — leaving the long tie-break comment above it in place — with:

```python
        # Computed once, then reused as the base for every restart's ordering —
        # this also stops priority()/urgency_factor() being recomputed per pass.
        base_keys = {wo["tower_id"]: sort_key(wo) for wo in remaining}
        remaining.sort(key=lambda wo: (base_keys[wo["tower_id"]], wo["tower_id"]))
```

Then replace the single call at `:700`:

```python
        entries, unscheduled, unscheduled_detail, risk_weighted_wait = run_pass(reserved_keys)
```

with:

```python
        # Multi-start. Every restart runs the SAME run_pass() under the same
        # hard constraints; only the order work is offered in changes. Restart
        # 0 is always the unperturbed ordering and always runs, which is what
        # makes this provably non-regressive: the winner is chosen from a set
        # that always contains today's answer.
        cfg = _restart_config(self.policy, override=restarts)
        rng = random.Random(cfg.seed)
        started = time.monotonic()

        best_score: tuple[float, float, int] | None = None
        best_out: tuple[list, list, list, float] | None = None
        best_order: dict[str, float] = base_keys
        winner_index = 0
        restarts_run = 0
        baseline_wait = 0.0
        no_improve = 0

        for i in range(cfg.max_restarts):
            if i > 0:
                # These may only ever CUT the search short. Restart 0 is
                # outside both guards, so a zero budget still yields a real
                # schedule rather than none.
                if (time.monotonic() - started) * 1000.0 >= cfg.time_budget_ms:
                    break
                if no_improve >= cfg.no_improve_stop:
                    break

            if i == 0:
                order = base_keys
            else:
                order = {
                    tid: k * (1.0 + rng.uniform(-cfg.jitter, cfg.jitter))
                    for tid, k in base_keys.items()
                }
            # The tower_id tie-break is not optional: without it, co-located
            # towers with identical keys permute between passes and a dispatch
            # into a free crew-day reports displacement that never happened.
            remaining.sort(key=lambda wo: (order[wo["tower_id"]], wo["tower_id"]))

            out = run_pass(reserved_keys)
            restarts_run += 1
            score = _candidate_score(out[1], towers_by_id, out[3], i)
            if i == 0:
                baseline_wait = out[3]

            if best_score is None or score < best_score:
                best_score, best_out, best_order = score, out, order
                winner_index = i
                no_improve = 0
            else:
                no_improve += 1

        entries, unscheduled, unscheduled_detail, risk_weighted_wait = best_out
```

- [ ] **Step 6: Point the shadow pass at the winner**

Replace the Task 5 shadow block with:

```python
        if reserved_keys:
            # Re-sorted to the WINNER's ordering first. The counterfactual asks
            # "would this tower have been placed with no reserve at all", and
            # that question is only meaningful against the ordering that
            # actually produced the schedule being labelled.
            remaining.sort(key=lambda wo: (best_order[wo["tower_id"]], wo["tower_id"]))
            shadow_entries, _shadow_unscheduled, _shadow_detail, _shadow_wait = run_pass(set())
            unscheduled_detail = _relabel_reserved(unscheduled_detail, shadow_entries)
```

- [ ] **Step 7: Populate the stats at the return**

Replace the `return OptimizeResult(...)` (`:732`) with:

```python
        return OptimizeResult(
            entries=entries,
            unscheduled=unscheduled,
            risk_weighted_wait=risk_weighted_wait,
            horizon=[d.isoformat() for d in horizon],
            reserve=reserve,
            unscheduled_detail=unscheduled_detail,
            restarts=RestartStats(
                restarts_run=restarts_run,
                winner_index=winner_index,
                baseline_score=baseline_wait,
                winner_score=risk_weighted_wait,
                improvement_pct=(
                    round(100.0 * (baseline_wait - risk_weighted_wait) / baseline_wait, 1)
                    if baseline_wait > 0
                    else 0.0
                ),
            ),
        )
```

- [ ] **Step 8: Run the full suite**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -v`
Expected: all pass — the seven new multi-start/stats tests and every pre-existing test, including both determinism tests.

- [ ] **Step 9: Commit**

```bash
git add src/backend/scheduler/optimize.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
feat(scheduler): multi-start search over perturbed work orderings

Runs the same greedy pass under jittered orderings and keeps the best by
unserviced risk mass. Restart 0 is always the unperturbed ordering, so this
can never return a worse schedule than single-pass. Seeded from policy, and
the reserve counterfactual runs once against the winner.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Keep the interactive override path single-pass

Spec §3.1.

**Files:**
- Modify: `src/backend/scheduler/override.py:123-128` (`_resolve_around_pin`)
- Test: `src/backend/scheduler/test_optimize.py`

**Interfaces:**
- Consumes: `Optimizer.optimize(..., restarts=...)` from Task 6

- [ ] **Step 1: Write the failing test**

```python
def test_override_resolve_stays_single_pass():
    """Every /schedule/pin re-solves synchronously while a human waits, and
    re-drawing the board from a different restart on each pin would make
    unrelated jobs jump for reasons the planner cannot see."""
    from scheduler.override import OverrideEngine

    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base, max_restarts=16)
    engine = OverrideEngine(Optimizer(crews=crews, policy=policy))
    result = engine.pin(
        current_entries=[],
        current_pins=[],
        tower_id="T1",
        target_crew_id="SEL-C1",
        target_day="2026-08-17",
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
    )
    assert result.restarts.restarts_run == 1
```

Signatures verified against `scheduler/override.py:86-92` (`OverrideEngine(optimizer)`) and `:181-193` (`pin(...)`) — the keyword names above match exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k override_resolve -v`
Expected: FAIL — `restarts_run` is 16, not 1

- [ ] **Step 3: Write the implementation**

In `scheduler/override.py`, change the `_resolve_around_pin` call (`:123-128`):

```python
        result = self.optimizer.optimize(
            free_work_orders,
            towers_by_id,
            pinned=all_pins,
            today=today,
        )
```

to:

```python
        result = self.optimizer.optimize(
            free_work_orders,
            towers_by_id,
            pinned=all_pins,
            today=today,
            # Single-pass, always. This runs synchronously in the request path
            # while a planner waits on an approval they just clicked, and a
            # different random restart each time would reshuffle unrelated jobs
            # after every pin — churn the confirmation panel cannot explain and
            # the dispatch animation would narrate as if it were consequence.
            # The pin is anchored to a board that was already optimized once.
            restarts=1,
        )
```

- [ ] **Step 4: Run the full suite**

Run: `cd src/backend && python -m pytest scheduler/ -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/override.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
fix(scheduler): keep pin and emergency re-solves single-pass

The override path runs in the request path while a human waits, and a
different restart per pin would reshuffle unrelated jobs unexplainably.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Keep the baseline comparison honest

Spec §3.2, option (a). **This is an integrity fix, not a performance one** — without it the published "beats naive dispatch by X%" figure silently absorbs the multi-start gain and attributes it to the dispatch policy.

**Files:**
- Modify: `src/backend/scheduler/baseline.py:124-133`
- Test: `src/backend/scheduler/test_optimize.py`

- [ ] **Step 1: Write the failing test**

```python
def test_baseline_comparison_runs_both_policies_single_pass():
    """risk_weighted_wait_reduction_pct is only meaningful because both
    policies run through IDENTICAL constraints and differ solely in
    sort_key_fn. Giving the smart policy restarts and the naive one a single
    pass would fold the search gain into a number that claims to measure
    dispatch policy."""
    from scheduler import baseline

    crews, base, towers, work_orders = _tiny_setup()
    policy = _restart_policy(base, max_restarts=16)
    seen: list[int | None] = []
    optimizer = Optimizer(crews=crews, policy=policy)
    real_optimize = optimizer.optimize

    def recording_optimize(*args, **kwargs):
        seen.append(kwargs.get("restarts"))
        return real_optimize(*args, **kwargs)

    optimizer.optimize = recording_optimize
    baseline.compare_policies(work_orders, towers, optimizer=optimizer)

    assert seen == [1, 1], f"both policies must run single-pass, got {seen}"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src/backend && python -m pytest scheduler/test_optimize.py -k baseline_comparison -v`
Expected: FAIL — `got [None, None]`

- [ ] **Step 3: Write the implementation**

In `scheduler/baseline.py`, change both calls (`:124` and `:131`):

```python
    greedy_entries, greedy_unscheduled, greedy_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today
    )
```

```python
    nf_entries, nf_unscheduled, nf_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today, sort_key_fn=nearest_first_key
    )
```

to:

```python
    # Both single-pass, deliberately. This comparison is only meaningful
    # because the two policies run through IDENTICAL constraints and differ
    # solely in sort_key_fn. Multi-start is a SEARCH improvement, not a
    # dispatch-policy one: letting the greedy side use restarts while the
    # naive baseline gets one pass would fold the search gain into a number
    # that claims to measure dispatch policy, and the headline figure would
    # overstate itself by however much the restarts happened to find.
    greedy_entries, greedy_unscheduled, greedy_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today, restarts=1
    )
```

```python
    nf_entries, nf_unscheduled, nf_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today, sort_key_fn=nearest_first_key, restarts=1
    )
```

- [ ] **Step 4: Run the whole backend suite**

Run: `cd src/backend && python -m pytest -q`
Expected: all pass. This is the final gate — the full suite was 274 tests at last count.

- [ ] **Step 5: Commit**

```bash
git add src/backend/scheduler/baseline.py src/backend/scheduler/test_optimize.py
git commit -m "$(cat <<'EOF'
fix(scheduler): run both baseline policies single-pass

Multi-start is a search improvement, not a dispatch-policy one. Letting only
the greedy side use restarts would overstate the published reduction figure.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## After the plan: measure before tuning

`max_restarts: 16` and `time_budget_ms: 1500` are starting points, not findings. On the national dataset:

```bash
cd src/backend && python -c "
import time, statistics
from api.routes.schedule import _optimizer  # same optimizer the route uses
# build work_orders / towers_by_id the way the route does, then:
t = []
for _ in range(5):
    s = time.perf_counter()
    r = _optimizer.optimize(work_orders, towers_by_id)
    t.append(time.perf_counter() - s)
print(f'p50 {statistics.median(t)*1000:.0f}ms  restarts_run={r.restarts.restarts_run}  winner={r.restarts.winner_index}  gain={r.restarts.improvement_pct}%')
"
```

Read `winner_index` across a few runs:

- **Mostly 0** → ordering is not what binds this instance. Stop investing in restarts; the next real gain is regret insertion (spec §8), which attacks the mechanism instead of sampling around it.
- **Frequently > 0 with a meaningful `improvement_pct`** → restarts are earning their cost. Consider raising `time_budget_ms` before `max_restarts`.
- **`restarts_run` well below `max_restarts`** → `no_improve_stop` is doing its job, and the ceiling is not the binding constraint.
