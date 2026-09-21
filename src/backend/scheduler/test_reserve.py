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


TWO_TERRITORY_CREWS = [
    {"crew_id": "SEL-C1", "crew_type": "civil", "territory": "Selangor"},
    {"crew_id": "SEL-C2", "crew_type": "civil", "territory": "Selangor"},
    {"crew_id": "JHR-C1", "crew_type": "civil", "territory": "Johor"},
    {"crew_id": "JHR-C2", "crew_type": "civil", "territory": "Johor"},
]


def test_each_territory_gets_its_own_reserve():
    """Readiness is territorial: a Johor civil crew cannot cover a Selangor
    incident, so reservation must not be pooled nationally. Both territories
    here have the same shape (2 civil crews, reserve_crew_days civil=1), so
    both must show up on every reserve day — one national reservation is not
    enough to prove per-territory scoping, this checks both are non-empty."""
    policy = {
        "readiness": {
            "enabled": True,
            "reserve_crew_days": {"civil": 1},
            "reserve_days": [0],
            "rotate_reserve": True,
            "sla_may_consume_reserve": False,
        }
    }
    slots = select_reserve(TWO_TERRITORY_CREWS, HORIZON, policy)
    selangor_crew_ids = {"SEL-C1", "SEL-C2"}
    johor_crew_ids = {"JHR-C1", "JHR-C2"}
    reserved_crew_ids = {s.crew_id for s in slots}
    assert reserved_crew_ids & selangor_crew_ids, "Selangor got no reserve"
    assert reserved_crew_ids & johor_crew_ids, "Johor got no reserve"
    # Exactly one crew from each territory reserved on the single reserve day.
    assert len(slots) == 2


def test_a_territorys_reserve_names_only_that_territorys_crews():
    """The bug this fixes: rotation offset landing entirely on a different
    territory's crews while the intended territory is never actually
    withheld."""
    policy = {
        "readiness": {
            "enabled": True,
            "reserve_crew_days": {"civil": 1},
            "reserve_days": [0, 1, 2, 3],
            "rotate_reserve": True,
            "sla_may_consume_reserve": False,
        }
    }
    slots = select_reserve(TWO_TERRITORY_CREWS, HORIZON, policy)
    crews_by_id = {c["crew_id"]: c["territory"] for c in TWO_TERRITORY_CREWS}
    # Every reserve day must reserve exactly one Selangor crew and one Johor
    # crew — never two from the same territory, never zero from one. The
    # set-equality check alone would pass with e.g. 3 Selangor + 1 Johor
    # slots on a day, so the count assertion is what actually pins "exactly
    # one" rather than just "at least one of each".
    for day in {s.day for s in slots}:
        day_slots = [s for s in slots if s.day == day]
        assert len(day_slots) == 2
        territories = [crews_by_id[s.crew_id] for s in day_slots]
        assert sorted(territories) == ["Johor", "Selangor"]


MIXED_TERRITORY_CREWS = [
    {"crew_id": "SEL-C1", "crew_type": "civil", "territory": "Selangor"},
    {"crew_id": "SEL-C2", "crew_type": "civil", "territory": "Selangor"},
    # No "territory" key at all — the case that raised TypeError: sorting
    # {"Selangor", None} compares a str to None, which Python does not
    # define an ordering for.
    {"crew_id": "UNK-C1", "crew_type": "civil"},
]


def test_a_crew_missing_territory_does_not_crash_sorting():
    """A roster where some crews carry `territory` and some don't must not
    raise TypeError from sorting a set containing both None and str."""
    policy = {
        "readiness": {
            "enabled": True,
            "reserve_crew_days": {"civil": 1},
            "reserve_days": [0],
            "rotate_reserve": True,
            "sla_may_consume_reserve": False,
        }
    }
    slots = select_reserve(MIXED_TERRITORY_CREWS, HORIZON, policy)
    # Selangor (2 crews) and the untagged group (1 crew) are each their own
    # territory bucket, so both get their own reservation on the one
    # reserve day: one Selangor crew, plus UNK-C1 (the only member of the
    # missing-territory bucket).
    assert len(slots) == 2
    assert {s.crew_id for s in slots} & {"SEL-C1", "SEL-C2"}
    assert "UNK-C1" in {s.crew_id for s in slots}


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
