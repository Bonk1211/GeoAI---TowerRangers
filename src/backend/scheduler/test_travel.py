"""Tests for scheduler/travel.py — the road-matrix lookup and its fallback.

Run standalone or under pytest, from src/backend/:
    python3 scheduler/test_travel.py
    pytest scheduler/test_travel.py -q

Network-free. Builds its own matrix in a temp file; never touches
data/travel_matrix.npz and never talks to OSRM.

Design under test: docs/superpowers/specs/2026-09-09-osrm-travel-matrix-design.md
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scheduler.travel import (  # noqa: E402
    ROUTED,
    UNROUTABLE,
    TravelMatrix,
    TravelResult,
    depot_key,
    write_matrix,
)

# Alor Setar depot -> a Langkawi tower: the acceptance case from the spec's
# §1a. 84 km of straight line, no bridge.
_ALOR = depot_key(100.370, 6.121)
_LANGKAWI = "MY_W1315123577"
_MAINLAND = "MY_N0000000001"
_FERRY_ISLAND = "MY_N0000000002"


def _matrix(path: Path) -> TravelMatrix:
    write_matrix(
        path,
        keys=[_ALOR, _LANGKAWI, _MAINLAND, _FERRY_ISLAND],
        rows=[
            # from, to, km, minutes, state, via_ferry
            (_ALOR, _MAINLAND, 71.4, 58.0, ROUTED, False),
            (_ALOR, _LANGKAWI, float("nan"), float("nan"), UNROUTABLE, False),
            (_ALOR, _FERRY_ISLAND, 96.2, 250.0, ROUTED, True),
        ],
        meta={"osm_extract": "test", "profile": "car"},
    )
    return TravelMatrix.load(path)


def test_routed_pair_returns_the_measured_leg():
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        got = m.lookup(_ALOR, _MAINLAND)
        assert got is not None
        assert got.state == ROUTED
        assert round(got.km, 1) == 71.4
        assert round(got.minutes) == 58
        assert got.via_ferry is False


def test_unroutable_is_a_measurement_and_must_not_look_like_a_gap():
    """The whole point of the three-state design.

    OSRM ran and found no road. That is an answer, not missing data, so it
    comes back as a result whose state says so — never as None, which the
    caller would fall back on and reinstate the straight-line guess.
    """
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        got = m.lookup(_ALOR, _LANGKAWI)
        assert got is not None, "unroutable must not be reported as absent"
        assert got.state == UNROUTABLE
        assert got.km is None and got.minutes is None
        assert got.reachable is False


def test_absent_pair_is_none_so_the_caller_can_fall_back():
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        assert m.lookup(_LANGKAWI, _MAINLAND) is None
        assert m.lookup("MY_NOT_IN_MATRIX", _MAINLAND) is None


def test_ferry_legs_are_kept_and_flagged():
    """Excluding ferries would make every unbridged island permanently
    unreachable, which is as false as claiming a road drive. Keep the route,
    state the mode."""
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        got = m.lookup(_ALOR, _FERRY_ISLAND)
        assert got is not None and got.state == ROUTED
        assert got.via_ferry is True
        assert got.reachable is True
        assert round(got.minutes) == 250


def test_a_missing_matrix_file_loads_as_empty_rather_than_raising():
    """A checkout with no artefact must still boot and serve schedules on the
    haversine fallback — the same contract load_booster() keeps."""
    with tempfile.TemporaryDirectory() as d:
        m = TravelMatrix.load(Path(d) / "does_not_exist.npz")
        assert m.available is False
        assert m.pair_count == 0
        assert m.lookup(_ALOR, _MAINLAND) is None


def test_status_reports_what_is_loaded():
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        st = m.status()
        assert st["available"] is True
        assert st["pairs"] == 3
        assert st["unroutable"] == 1
        assert st["osm_extract"] == "test"


def test_depot_key_is_stable_and_shared_between_crews_at_one_depot():
    """30 crews sit on 20 distinct depots. Two crews at the same depot must
    hit the same matrix row rather than needing two identical entries."""
    assert depot_key(100.370, 6.121) == depot_key(100.3700004, 6.1210004)
    assert depot_key(100.370, 6.121) != depot_key(101.588, 3.045)
    assert depot_key(100.370, 6.121).startswith("depot:")


def test_lookup_is_directional():
    """OSRM tables are not symmetric (one-way roads, turn restrictions), so a
    reverse lookup must miss rather than silently reusing the forward leg."""
    with tempfile.TemporaryDirectory() as d:
        m = _matrix(Path(d) / "m.npz")
        assert m.lookup(_ALOR, _MAINLAND) is not None
        assert m.lookup(_MAINLAND, _ALOR) is None


def test_result_km_survives_a_round_trip_through_float32():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "m.npz"
        write_matrix(
            p,
            keys=["a", "b"],
            rows=[("a", "b", 123.456, 78.9, ROUTED, False)],
            meta={},
        )
        got = TravelMatrix.load(p).lookup("a", "b")
        assert got is not None
        assert abs(got.km - 123.456) < 0.01
        assert abs(got.minutes - 78.9) < 0.01



# --------------------------------------------------------------------------
# Integration: the spec's acceptance case (§1a / §10).
#
# Langkawi has no road bridge, but 84 km of straight line x 1.35 = 113 km sits
# inside KDH-C1's 150 km limit, so the solver currently dispatches a mainland
# Kedah crew to an island. These two tests pin the fix END TO END: that an
# UNROUTABLE row survives leg(), and that the depot-range check then rejects
# the crew instead of falling back to the straight-line guess OSRM contradicted.
# --------------------------------------------------------------------------

_ALOR_LON, _ALOR_LAT = 100.370, 6.121
_LGK_LON, _LGK_LAT = 99.7300, 6.3500


def _langkawi_matrix(path: Path) -> None:
    write_matrix(
        path,
        keys=[_ALOR, _LANGKAWI],
        rows=[(_ALOR, _LANGKAWI, float("nan"), float("nan"), UNROUTABLE, False)],
        meta={"osm_extract": "test"},
    )


def test_leg_reports_an_unroutable_pair_as_unreachable_not_as_a_guess():
    import scheduler.travel as travel_mod
    from scheduler.optimize import UNREACHABLE, leg

    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "m.npz"
        _langkawi_matrix(p)
        travel_mod.reset_cache()
        travel_mod.get_matrix(p)
        try:
            km, minutes = leg(
                _ALOR, _ALOR_LON, _ALOR_LAT,
                _LANGKAWI, _LGK_LON, _LGK_LAT,
                1.35, 45,
            )
            assert km == UNREACHABLE, f"expected unreachable, got {km:.1f} km"
            assert minutes > 10**8
        finally:
            travel_mod.reset_cache()


def test_the_straight_line_model_is_what_puts_a_crew_on_the_island():
    """Guards the premise. If this ever fails, the bug was fixed elsewhere and
    the test above is no longer testing anything."""
    from scheduler.optimize import haversine_km

    km = haversine_km(_ALOR_LON, _ALOR_LAT, _LGK_LON, _LGK_LAT) * 1.35
    assert km < 150, f"premise broken: {km:.0f} km is no longer inside KDH-C1's limit"


def test_depot_range_rejects_the_island_once_the_matrix_says_unroutable():
    import scheduler.travel as travel_mod
    from scheduler.optimize import travel_km

    crew = {"depot": {"lon": _ALOR_LON, "lat": _ALOR_LAT}, "max_travel_km": 150}
    tower = {"tower_id": _LANGKAWI, "lon": _LGK_LON, "lat": _LGK_LAT}

    # Without a matrix: the bug, reproduced. The path must be one that does
    # NOT exist — a bare reset_cache() would load data/travel_matrix.npz once
    # that artefact is built, and this branch is meant to show the behaviour
    # when there is nothing to load.
    travel_mod.reset_cache()
    travel_mod.get_matrix(Path("no-such-matrix.npz"))
    try:
        before = travel_km(crew, tower, 1.35)
        assert before <= crew["max_travel_km"], "premise: today the crew is 'in range'"
    finally:
        travel_mod.reset_cache()

    # With one: rejected, and NOT by a distance threshold — by the measurement.
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "m.npz"
        _langkawi_matrix(p)
        travel_mod.reset_cache()
        travel_mod.get_matrix(p)
        try:
            after = travel_km(crew, tower, 1.35)
            assert after > crew["max_travel_km"], "unroutable must fail the range check"
        finally:
            travel_mod.reset_cache()


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"ok  {fn.__name__}")
    print(f"\n{len(fns)} tests passed")
