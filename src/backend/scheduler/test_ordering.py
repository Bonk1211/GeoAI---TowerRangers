"""Unit tests for the ordering the optimizer actually dispatches on.

The decision bands are cut on the blended `priority` (model risk rank plus the
telemetry condition rank — model/ensemble.py), so a tower can be in the maintain
band because its live counters are running hot rather than because its standing
risk is high. Everything downstream has to agree with that, and for one release
it did not: banding moved to the blend while scheduler.optimize.priority() still
read `risk`, so an escalated tower entered the dispatch list and immediately
sorted to the bottom of it.

These pin the two halves together, and pin the fallback that keeps the mock
fixture and the Backend_Handoff §1 minimum contract working.

Network-free. Run from src/backend:  python3 scheduler/test_ordering.py
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from scheduler.config_loader import load_policy
from scheduler.explain import explain_slot
from scheduler.optimize import ScheduleEntry, priority


def _tower(**overrides) -> dict:
    base = {
        "tower_id": "MY_0001",
        "lon": 101.61,
        "lat": 3.11,
        "risk": 0.12,
        "urgency_days": 14,
        "attribution": {"flood": 0.9, "terrain": 0.1},
        "dominant_factor": "flood",
        "weather": None,
        "flags": [],
        "escalated": False,
    }
    base.update(overrides)
    return base


def test_priority_uses_the_blend_not_raw_risk():
    """The regression this file exists for. A tower with low standing risk and
    a high blended priority must outrank one with the reverse."""
    hot = _tower(risk=0.10, priority=0.95)
    cold = _tower(risk=0.60, priority=0.40)
    assert priority(hot) > priority(cold)


def test_priority_falls_back_to_risk_when_the_blend_is_absent():
    """The mock fixture and any §1-minimum record carry no `priority`. They must
    still sort, by risk, rather than raising."""
    assert priority(_tower(risk=0.42)) == 0.42
    assert priority({"tower_id": "X", "risk": 0.7}) == 0.7


def test_priority_still_scales_by_exposed_population():
    """The exposed-population term is unchanged by the switch — it multiplies
    whichever ordering is in use."""
    import math

    plain = _tower(priority=0.5)
    populated = _tower(priority=0.5, exposed_pop=1000)
    assert priority(populated) == 0.5 * math.log1p(1000)
    assert priority(plain) == 0.5


def test_priority_of_zero_population_is_not_a_crash():
    assert priority(_tower(priority=0.5, exposed_pop=0)) == 0.0


def test_explain_says_when_the_second_opinion_put_a_tower_in_the_run():
    """A planner seeing a low-risk site dispatched ahead of higher-risk ones
    must be told why, or the ordering reads as arbitrary."""
    policy = load_policy()
    crew = {
        "crew_id": "SEL-C1",
        "crew_type": "civil",
        "depot": {"lon": 101.6, "lat": 3.1, "name": "Shah Alam"},
        "max_travel_km": 120,
    }
    entry = ScheduleEntry(
        crew_id="SEL-C1", day="2026-08-18", order=1, tower_id="MY_0001",
        work_order={}, pinned=False,
    )

    escalated = explain_slot(
        entry, _tower(escalated=True, condition=0.93), crew, [entry], policy,
    )
    joined = " ".join(escalated.reasons)
    assert "telemetry" in joined, escalated.reasons
    assert "93%" in joined, escalated.reasons

    plain = explain_slot(entry, _tower(), crew, [entry], policy)
    assert not any("telemetry" in r for r in plain.reasons)


def test_explain_survives_a_record_with_no_condition():
    """`escalated` true with `condition` null cannot happen through the adapter,
    but the readout must not crash on a hand-built or older record."""
    policy = load_policy()
    crew = {
        "crew_id": "SEL-C1", "crew_type": "civil",
        "depot": {"lon": 101.6, "lat": 3.1, "name": "Shah Alam"}, "max_travel_km": 120,
    }
    entry = ScheduleEntry(
        crew_id="SEL-C1", day="2026-08-18", order=1, tower_id="MY_0001",
        work_order={}, pinned=False,
    )
    out = explain_slot(entry, _tower(escalated=True, condition=None), crew, [entry], policy)
    assert any("telemetry" in r for r in out.reasons)


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  ok  {test.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL  {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)
