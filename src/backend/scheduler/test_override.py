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
    somebody; with it, the displaced list comes back empty — and this test
    must fail if the reserve were absent, not just happen to pass because
    this fixture's geometry has slack.

    Discriminating check first: rerun the SAME setup with readiness OFF and
    confirm the crew-day the reserve is protecting is occupied by planned
    work there. That proves the slot the pin below lands on is free only
    BECAUSE a crew-day was deliberately held back, not by fixture luck.

    planning_horizon_days is narrowed to 2 (vs. _reserved_setup's default 3)
    so T2 is genuinely unscheduled in `base`, not merely relocated by the
    pin: with the reserved day0 and only one further open day, the single
    crew can fit exactly one of the two towers before the incident. That
    makes `preview.moved == []` a real assertion — T2 was never in the
    "before" schedule to be recorded as moved — rather than trivially true
    only because _diff happens not to track the pinned tower's own slot
    change.
    """
    crews, policy, towers, work_orders = _reserved_setup()
    policy["planning_horizon_days"] = 2
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    reserved = base.reserve[0]
    assert "T2" in base.unscheduled, (
        "setup assumption broken: T2 must be unscheduled before the pin so "
        "moved==[] is a real assertion, not one _diff can't see"
    )

    off_policy = {**policy, "readiness": {"enabled": False}}
    off_result = Optimizer(crews=crews, policy=off_policy).optimize(work_orders, towers)
    off_occupied = {(e.crew_id, e.day) for e in off_result.entries}
    assert (reserved.crew_id, reserved.day) in off_occupied, (
        "setup is not discriminating: the reserved crew-day is free even "
        "with readiness disabled, so a pin landing there would displace "
        "nothing regardless of whether the reserve exists — this test "
        "would then pass for the wrong reason"
    )

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
    assert preview.moved == []

    # Go further than the diff lists: compare full before/after entry sets.
    # Every (tower_id, crew_id, day) that existed before the pin — other
    # than T2's own entry, which the pin is deliberately relocating — must
    # still be present, unchanged, after the resolve.
    resolved = engine.pin(
        current_entries=base.entries,
        current_pins=[],
        tower_id="T2",
        target_crew_id=reserved.crew_id,
        target_day=reserved.day,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
        pin_reason="emergency",
    )
    before_by_tower = {e.tower_id: (e.crew_id, e.day) for e in base.entries}
    after_by_tower = {e.tower_id: (e.crew_id, e.day) for e in resolved.entries}
    for tower_id, key in before_by_tower.items():
        if tower_id == "T2":
            continue  # T2 is the tower being pinned — it is meant to move
        assert after_by_tower.get(tower_id) == key, (
            f"{tower_id} was displaced by a pin into reserve capacity: "
            f"before={key} after={after_by_tower.get(tower_id)}"
        )
    # And the pin itself must have actually landed on the reserved slot.
    assert after_by_tower["T2"] == (reserved.crew_id, reserved.day)


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


def test_pin_into_reserved_crew_day_flags_consumed_reserve():
    """The entry landing on the reserved crew-day must say so, and the
    reserve list returned by that same resolve must no longer advertise
    that crew-day as still free."""
    crews, policy, towers, work_orders = _reserved_setup()
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    reserved = base.reserve[0]

    engine = OverrideEngine(optimizer=optimizer)
    result = engine.pin(
        current_entries=base.entries,
        current_pins=[],
        tower_id="T2",
        target_crew_id=reserved.crew_id,
        target_day=reserved.day,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
        pin_reason="emergency",
    )
    pinned_entry = next(e for e in result.entries if e.tower_id == "T2")
    assert pinned_entry.crew_id == reserved.crew_id
    assert pinned_entry.day == reserved.day
    assert pinned_entry.consumed_reserve is True

    # the crew-day the pin landed on must not still be reported as reserved
    assert (reserved.crew_id, reserved.day) not in {
        (s.crew_id, s.day) for s in result.reserve
    }


def test_shadow_pass_does_not_corrupt_pinned_entry_fields():
    """Task 6 shipped a pin-seeding loop that writes travel_min/start_min/
    end_min/order/consumed_reserve directly onto the caller-owned pinned
    ScheduleEntry objects, and optimize() runs that seeding loop twice (a
    real pass, then a reserve-off shadow pass used only to compute labels).
    If the seeding loop ever mutates the caller's object instead of
    producing a fresh copy, the second (shadow) pass's write is observable
    on the entry the first (real) pass already returned. Assert the
    returned entry's fields are internally consistent with a pin landing on
    the REAL reserved day, not silently overwritten by the shadow run."""
    crews, policy, towers, work_orders = _reserved_setup()
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    reserved = base.reserve[0]

    engine = OverrideEngine(optimizer=optimizer)
    result = engine.pin(
        current_entries=base.entries,
        current_pins=[],
        tower_id="T2",
        target_crew_id=reserved.crew_id,
        target_day=reserved.day,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
        pin_reason="emergency",
    )
    pinned_entry = next(e for e in result.entries if e.tower_id == "T2")
    # If the shadow pass (reserve treated as empty) had corrupted this via
    # aliasing, consumed_reserve would read False here even though the pin
    # genuinely landed on the reserved crew-day.
    assert pinned_entry.consumed_reserve is True
    assert pinned_entry.order >= 1
    assert pinned_entry.end_min > pinned_entry.start_min >= 0


def test_pin_onto_a_non_reserved_crew_day_does_not_flag_consumed_reserve():
    """Every other new test in this file asserts consumed_reserve is True —
    this is the negative case, so the flag is proven to actually vary with
    where the pin lands rather than being hardcoded True by the seeding
    loop's new consumed_reserve assignment."""
    crews, policy, towers, work_orders = _reserved_setup()
    optimizer = Optimizer(crews=crews, policy=policy)
    base = optimizer.optimize(work_orders, towers)
    reserved = base.reserve[0]

    # planning_horizon_days = 3 in _tiny_setup; day index 1 is never reserved
    # in this setup (reserve_days=[0]).
    non_reserved_day = "2026-08-18"
    assert non_reserved_day != reserved.day

    engine = OverrideEngine(optimizer=optimizer)
    result = engine.pin(
        current_entries=base.entries,
        current_pins=[],
        tower_id="T1",
        target_crew_id=reserved.crew_id,
        target_day=non_reserved_day,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers,
        pin_reason="planner_override",
    )
    pinned_entry = next(e for e in result.entries if e.tower_id == "T1")
    assert pinned_entry.day == non_reserved_day
    assert pinned_entry.consumed_reserve is False


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
