"""Solver tests — capacity, reserve, and the result contract.

Run from src/backend:  python3 scheduler/test_optimize.py   (or via pytest)
"""

import sys
from datetime import date, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.optimize import (
    UNSCHEDULED_REASONS,
    OptimizeResult,
    Optimizer,
    ReserveSlot,
    ScheduleEntry,
    UnscheduledItem,
    _candidate_score,
    _relabel_reserved,
    _restart_config,
)
from scheduler.reserve import select_reserve


@pytest.fixture
def use_fixture_towers(monkeypatch):
    """USE_FIXTURE=1, scoped to the one test that asks for it.

    Only the two route-level tests below need the deterministic synthetic
    tower population; the solver tests build their own towers inline. This
    used to be a bare `os.environ["USE_FIXTURE"] = "1"` inside those two
    tests, which was never undone — so once either ran, every later test
    module in the same pytest process saw the fixture branch and results
    depended on file order. adapter/test_ml_source.py had to carry a
    defensive delenv purely because of that. monkeypatch restores the prior
    value when the test ends.
    """
    monkeypatch.setenv("USE_FIXTURE", "1")


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


def test_precomputed_candidates_do_not_change_placement():
    """Crew-type/territory filtering and depot range are pure functions of
    (work order, tower, crew) — hoisting them out of the day loop must not
    move a single job. Golden values captured from the pre-hoist solver."""
    crews, policy, towers, work_orders = _tiny_setup()
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    placed = [(e.tower_id, e.crew_id, e.day, e.order) for e in result.entries]
    assert placed == [("T1", "SEL-C1", "2026-08-17", 1), ("T2", "SEL-C1", "2026-08-18", 1)]
    assert result.unscheduled == []


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


def _tied_towers_setup():
    """Three co-located towers with IDENTICAL risk, urgency and coordinates —
    the real dataset has exactly this: SUNWAY_OPERATOR_{A,B,C}_701934 are
    three operators' equipment on one mast. Two days of one crew's capacity
    fit two of the three 5h jobs, so which tower loses out is decided purely
    by sort order."""
    crews, policy, _, _ = _tiny_setup()
    policy = {**policy, "planning_horizon_days": 2}
    towers = {
        f"T_{op}": {
            "tower_id": f"T_{op}", "lon": 101.59, "lat": 3.05, "risk": 0.9,
            "territory": "Selangor", "urgency_days": 5, "dominant_factor": "flood",
        }
        for op in ("A", "B", "C")
    }
    work_orders = [
        {"tower_id": f"T_{op}", "crew_type": "civil", "duration_hours": 5.0,
         "urgency_days": 5}
        for op in ("A", "B", "C")
    ]
    return crews, policy, towers, work_orders


def test_exactly_tied_towers_do_not_depend_on_work_order_sequence():
    """Ties must break on tower_id, never on position in the work-order list.

    Python's sort is stable, so a bare float key leaves exact ties in input
    order — and the re-solve path does not control that order:
    OverrideEngine._resolve builds its work-order list by iterating a SET of
    tower ids, whose iteration order is hash-based and shifts when membership
    changes. So pinning one tower silently permuted the tied group, and a
    dispatch into a FREE reserve crew-day reported displaced work when
    nothing was displaced: one tied tower swapped out, its identical twin
    swapped in, net placements unchanged. Measured against the live API
    before the fix: 30 of 36 reserve dispatches reported that phantom;
    after: 0."""
    crews, policy, towers, work_orders = _tied_towers_setup()

    def placed(orders):
        return {
            e.tower_id
            for e in Optimizer(crews=crews, policy=policy).optimize(orders, towers).entries
        }

    forward = placed(work_orders)
    assert len(forward) == 2, "setup must force exactly one tower to lose"
    assert placed(list(reversed(work_orders))) == forward
    assert placed([work_orders[1], work_orders[2], work_orders[0]]) == forward


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


def test_out_of_range_is_distinguished_from_no_capacity():
    """A tower no crew can drive to is a COVERAGE gap, not a busy fleet.

    Measured on the real roster: 45 of the 50 towers reported as
    'no_capacity' were rejected by the depot-range filter before the day
    loop ever ran, while 108 crew-days sat completely idle. Telling a
    planner the fleet had no capacity was the most misleading string in
    the product — it points at scheduling when the fix is a depot.
    """
    crews, policy, towers, work_orders = _tiny_setup()
    # Same territory, same crew type — only the distance disqualifies it.
    towers["T1"]["lon"] = 103.5  # ~200 km east, well past SEL-C1's 40 km cap
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    by_id = {d.tower_id: d for d in result.unscheduled_detail}
    assert by_id["T1"].reason == "out_of_range"


def test_out_of_territory_is_distinguished_from_out_of_range():
    """A crew of the right type IS within driving range — it just belongs to
    another territory. That is a dispatch-rule question the planner can
    actually answer, and it must not be hidden inside a range excuse."""
    crews, policy, towers, work_orders = _tiny_setup()
    # A second crew, same type, close enough to serve T1 — but foreign.
    crews.append(
        {
            "crew_id": "NSN-C1",
            "crew_type": "civil",
            "territory": "Negeri Sembilan",
            "depot": {"lon": 101.60, "lat": 3.06, "name": "Seremban"},
            "max_travel_km": 40,
            "shift_hours": 8,
        }
    )
    # Push T1 out of SEL-C1's reach but leave it on NSN-C1's doorstep.
    towers["T1"]["lon"], towers["T1"]["lat"] = 101.601, 3.061
    crews[0]["max_travel_km"] = 1  # SEL-C1 can no longer reach anything
    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    by_id = {d.tower_id: d for d in result.unscheduled_detail}
    assert by_id["T1"].reason == "out_of_territory"


def test_no_route_is_distinguished_from_out_of_range():
    """OSRM proving there is no road is a different fact from a tower being
    far away, and only one of them can be fixed by moving a depot. leg()
    returns UNREACHABLE for such a pair; the reason chain must not launder
    that into a distance complaint."""
    crews, policy, towers, work_orders = _tiny_setup()

    class _NoRoadMatrix:
        available = True

        @staticmethod
        def lookup(a, b):
            class _M:
                reachable = False
                km = float("inf")
                minutes = 10**9

            return _M()

    import scheduler.optimize as opt_mod

    original = opt_mod.get_matrix
    opt_mod.get_matrix = lambda: _NoRoadMatrix()
    try:
        result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    finally:
        opt_mod.get_matrix = original

    by_id = {d.tower_id: d for d in result.unscheduled_detail}
    assert by_id["T1"].reason == "no_route"
    assert by_id["T2"].reason == "no_route"


def test_new_coverage_reasons_are_in_the_known_set():
    """api/schemas.py documents this set and the frontend switches on it —
    a reason the UI has no branch for renders as a blank badge."""
    assert {"out_of_range", "out_of_territory", "no_route"} <= UNSCHEDULED_REASONS


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


def test_schedule_run_response_carries_the_new_contract_fields(use_fixture_towers):
    """The frontend is built against this shape; api/schemas.py and
    api/types.ts must always change together."""
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


def test_pin_route_response_carries_the_full_contract(use_fixture_towers):
    """Nothing in the suite previously exercised POST /schedule/pin or
    POST /schedule/emergency at all. The persistence of horizon/reserve/
    unscheduled_detail on those handlers — the exact thing that stops the
    week strip going blank after an override — used to rest entirely on a
    manual TestClient check written up in prose. Mirrors the
    optimize_schedule route-assertion pattern above, for /schedule/pin."""
    from api.main import app

    client = TestClient(app)
    run_id = client.post("/schedule/optimize", json={}).json()["run_id"]
    before = client.get(f"/schedule/{run_id}").json()
    assert before["unscheduled"], "fixture must leave something unscheduled to pin"

    tower_id = before["unscheduled"][0]
    target_crew_id = before["entries"][0]["crew_id"]
    target_day = before["horizon"][0]

    resp = client.post(
        "/schedule/pin",
        json={
            "run_id": run_id,
            "tower_id": tower_id,
            "target_crew_id": target_crew_id,
            "target_day": target_day,
            "pin_reason": "planner_override",
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    # The exact regression this test exists to catch: a pinned run answering
    # with an empty horizon (week strip goes blank) or dropping reserve /
    # unscheduled_detail because the route unpacked a bare tuple instead of
    # persisting the full OptimizeResult.
    assert body["horizon"] == before["horizon"]
    assert body["horizon"], "horizon must survive a pin, not come back empty"
    assert isinstance(body["reserve"], list)
    assert isinstance(body["unscheduled_detail"], list)
    assert {d["tower_id"] for d in body["unscheduled_detail"]} == set(body["unscheduled"])

    pinned = next(e for e in body["entries"] if e["tower_id"] == tower_id)
    assert pinned["crew_id"] == target_crew_id
    assert pinned["day"] == target_day
    assert pinned["pinned"] is True
    assert "consumed_reserve" in pinned


def test_planned_work_never_lands_in_a_reserved_crew_day():
    """Checked against select_reserve's own OWN, UNFILTERED output — not
    result.reserve. optimize() now drops any slot something has actually
    consumed from result.reserve (so the UI never paints a "held free" band
    over booked work), which means result.reserve is not "everything that
    was reserved" once an SLA-critical placement or an override has landed
    somewhere in reserve. Asserting against result.reserve here would make
    this test close to a tautology: if planned work DID land on a reserved
    crew-day, the filter would just remove that slot from result.reserve
    and this assertion would still pass. select_reserve's own selection is
    the ground truth of what was actually held back, filter or no filter."""
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    today = date.fromisoformat(policy["demo_clock"]["today"])
    horizon = [today + timedelta(days=i) for i in range(policy["planning_horizon_days"])]
    reserved = {(s.crew_id, s.day) for s in select_reserve(crews, horizon, policy)}
    assert reserved, "setup must actually reserve something or this test proves nothing"

    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    for entry in result.entries:
        assert (entry.crew_id, entry.day) not in reserved


def test_a_tower_blocked_only_by_reserve_says_so():
    """'reserved' must be distinguishable from 'no_capacity' — one is a policy
    choice the planner can reverse, the other is a hard limit.

    Only T1's work order is kept here. _tiny_setup's single crew can fit one
    5-hour job into an 8-hour shift, so with both T1 and T2 present the two
    compete for that one slot even at planning_horizon_days = 1 — the second
    tower would stay unscheduled with the reserve off too, and correctly
    must NOT be labelled 'reserved'. Keeping only T1 isolates the case this
    test is actually named for: a tower that would have been scheduled had
    the reserve not existed.
    """
    crews, policy, towers, work_orders = _tiny_setup()
    work_orders = [wo for wo in work_orders if wo["tower_id"] == "T1"]
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


def test_reserve_cost_is_the_expected_trade():
    """Readiness costs throughput and the exact cost is pinned here. If this
    fails, capacity or the dispatch population changed — decide whether that was intended before
    updating the numbers. Never 'fix' it by shortening duration_hours.

    Re-measured 2026-09-13 after merging the generator v2.3 retrain with
    measured road travel, return-to-depot costs, and multi-start search.
    The retrain changes the maintain-band population and interventions;
    the scheduler changes how those orders fit into crew-days. Neither
    branch's previous counts describe the combined inputs and solver.

    The 117 orders give (57, 60) off / (49, 68) on, with 57 reserve slots.
    Restart 1 wins both runs under the committed seven-restart policy.
    Crew capacity, action durations, and return-leg constraints stay intact.
    Change blend weight remains zero.

    What the sum pins matters more than either number: 57 + 60 == 49 + 68 ==
    117 both ways. Readiness may move an order from booked to unscheduled, it
    may never drop one — the §4 invariant that displaced work is always
    returned explicitly.
    """
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
    assert (len(off.entries), len(off.unscheduled)) == (57, 60)
    assert (len(on.entries), len(on.unscheduled)) == (49, 68)
    assert len(on.entries) < len(off.entries), "reserve must actually cost throughput"
    for run_result in (off, on):
        assert len(run_result.entries) + len(run_result.unscheduled) == len(work_orders), (
            "every work order must come back booked or unscheduled, never dropped"
        )


def test_reason_is_by_counterfactual_not_a_sticky_per_day_flag():
    """A tower that fails on a reserved day AND on every other day for an
    ordinary capacity reason must NOT be labelled 'reserved' — that label is
    reserved (no pun intended) for towers that would actually have been
    scheduled had the reserve not existed.

    The prior sticky-flag implementation latched 'reserved' onto any tower
    that hit even one day where the only feasible crew(s) were all on
    reserve duty, and never reconciled that against every other day failing
    for a plain capacity reason. `test_a_tower_blocked_only_by_reserve_says_so`
    used planning_horizon_days = 1, which collapses the horizon to a single
    day and — with only two towers competing for one crew-day — happens to
    still expose *a* distinction, but does not exercise the case that
    actually broke on the real Sunway data: a multi-day horizon where the
    reserved day and the ordinary-capacity days are different days.

    Setup: one crew, one slot per day (5h job in an 8h shift), a 3-day
    horizon, day 0 reserved. Three decoy towers (T_HI1..3) outrank T_TARGET
    in the sort order and, between them, occupy every open crew-day whether
    or not the reserve exists — so T_TARGET can never be scheduled, reserve
    or no reserve. It must report 'no_capacity', not 'reserved'.
    """
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
        "readiness": {
            "enabled": True,
            "reserve_crew_days": {"civil": 1},
            "reserve_days": [0],
            "rotate_reserve": True,
            "sla_may_consume_reserve": False,
        },
    }
    towers = {
        "T_HI1": {"tower_id": "T_HI1", "lon": 101.59, "lat": 3.05, "risk": 0.95,
                  "territory": "Selangor", "urgency_days": 30, "dominant_factor": "flood"},
        "T_HI2": {"tower_id": "T_HI2", "lon": 101.59, "lat": 3.05, "risk": 0.90,
                  "territory": "Selangor", "urgency_days": 30, "dominant_factor": "flood"},
        "T_HI3": {"tower_id": "T_HI3", "lon": 101.59, "lat": 3.05, "risk": 0.85,
                  "territory": "Selangor", "urgency_days": 30, "dominant_factor": "flood"},
        "T_TARGET": {"tower_id": "T_TARGET", "lon": 101.59, "lat": 3.05, "risk": 0.10,
                     "territory": "Selangor", "urgency_days": 30, "dominant_factor": "flood"},
    }
    work_orders = [
        {"tower_id": t, "crew_type": "civil", "duration_hours": 5.0, "urgency_days": 30}
        for t in ("T_HI1", "T_HI2", "T_HI3", "T_TARGET")
    ]

    result = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)

    by_id = {d.tower_id: d for d in result.unscheduled_detail}
    assert "T_TARGET" in by_id, "T_TARGET must not have been scheduled by this setup"
    assert by_id["T_TARGET"].reason == "no_capacity", (
        "T_TARGET fails on every day for an ordinary capacity reason (three "
        "higher-priority towers occupy every open crew-day whether or not "
        "the reserve exists) — labelling it 'reserved' would be the sticky "
        "per-day flag bug reappearing."
    )
    # T_HI3 is the contrasting case in the same fixture: it loses out only
    # because the reserve removes a day's worth of capacity, and it *would*
    # have been scheduled without the reserve — genuinely 'reserved'.
    if "T_HI3" in by_id:
        assert by_id["T_HI3"].reason == "reserved"


def test_counterfactual_pass_does_not_change_real_placement():
    """The shadow pass exists only to compute labels. It must not leak into
    entries, reserve, or risk_weighted_wait — running optimize() twice with
    reserve enabled must be deterministic and match a version of this
    function that never takes the shadow-pass branch (i.e. same result
    whether or not there happens to be anything to relabel)."""
    crews, policy, towers, work_orders = _tiny_setup()
    policy["readiness"] = {
        "enabled": True,
        "reserve_crew_days": {"civil": 1},
        "reserve_days": [0],
        "rotate_reserve": True,
        "sla_may_consume_reserve": False,
    }
    r1 = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    r2 = Optimizer(crews=crews, policy=policy).optimize(work_orders, towers)
    assert [e.to_dict() for e in r1.entries] == [e.to_dict() for e in r2.entries]
    assert [s.to_dict() for s in r1.reserve] == [s.to_dict() for s in r2.reserve]
    assert r1.risk_weighted_wait == r2.risk_weighted_wait


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


if __name__ == "__main__":
    # Delegates to pytest rather than calling each test_* in globals()
    # directly: two of these tests now take a fixture argument
    # (use_fixture_towers), which only a real pytest run can supply. Same
    # standalone entry point as every other test module in this tree.
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
