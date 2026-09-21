"""Regression pin for the cover-candidate report on the REAL estate.

    python3 src/backend/model/test_fallback_realdata.py     # or: pytest

The point is not to freeze these numbers. A genuine scoring improvement may
move them, and then this file is updated deliberately, in the same commit, with
the new figures recorded below. The point is that a change which silently
EMPTIES this feature fails loudly here instead of shipping a tab reading
"0 towers".

Skips on USE_FIXTURE=1. That population is 500 synthetic towers inside a box
roughly 14 km across, so every tower is within the 15 km search radius of every
other and isolation is structurally impossible — 35 at-risk, 0 isolated. That
is the correct answer for that estate, not a shortfall, and asserting the live
figures against it would be asserting a falsehood.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures.source import scored_towers, use_fixture   # noqa: E402
from model.fallback import fallback_report                # noqa: E402

# Measured 2026-09-19 against the live Malaysian estate (1,164 towers).
EXPECTED_AT_RISK = 78
EXPECTED_ISOLATED = 12
EXPECTED_NOTHING_IN_RANGE = 7    # of the isolated, those with no neighbour at all
EXPECTED_ONLY_CO_HAZARD = 5      # of the isolated, those whose neighbours all flood

# Tolerance, because the scorer is not bit-frozen across environments. Wide
# enough to absorb a boundary tower moving band, narrow enough that a feature
# emptying itself still fails.
TOLERANCE = 3

# Returned by a test that did not run. The __main__ runner prints "ok" only for
# tests that actually asserted something — a skipped check reporting "ok" is
# the same "absence is not zero" error this whole feature exists to avoid.
SKIPPED = object()


def _skip_on_fixture(name: str) -> bool:
    if use_fixture():
        print("skip", name, "(USE_FIXTURE=1 cannot produce isolation)")
        return True
    return False


def test_at_risk_set_is_the_expected_size():
    if _skip_on_fixture("test_at_risk_set_is_the_expected_size"):
        return SKIPPED
    report = fallback_report(scored_towers())
    assert abs(report["at_risk_count"] - EXPECTED_AT_RISK) <= TOLERANCE, (
        f"at_risk_count {report['at_risk_count']}, expected ~{EXPECTED_AT_RISK}"
    )


def test_isolated_set_is_non_empty_and_the_expected_size():
    if _skip_on_fixture("test_isolated_set_is_non_empty_and_the_expected_size"):
        return SKIPPED
    report = fallback_report(scored_towers())
    assert report["isolated_count"] > 0, (
        "no isolated towers — the 'No cover' tab would render empty and the "
        "feature would silently say nothing"
    )
    assert abs(report["isolated_count"] - EXPECTED_ISOLATED) <= TOLERANCE, (
        f"isolated_count {report['isolated_count']}, expected ~{EXPECTED_ISOLATED}"
    )


def test_the_two_kinds_of_isolation_are_both_present():
    """The 7/5 split is the reason co_hazard is returned as its own list.
    Those 5 towers — neighbours within 15 km, every one of them flooding in the
    same event — are the feature's strongest single claim, and a change that
    collapsed them into the 7 would destroy it without changing any count."""
    if _skip_on_fixture("test_the_two_kinds_of_isolation_are_both_present"):
        return SKIPPED
    report = fallback_report(scored_towers())
    isolated = [r for r in report["towers"].values() if not r["candidates"]]
    nothing_in_range = [r for r in isolated if not r["co_hazard"]]
    only_co_hazard = [r for r in isolated if r["co_hazard"]]

    assert len(nothing_in_range) > 0, "expected some towers with no neighbour at all"
    assert len(only_co_hazard) > 0, (
        "expected some towers whose only neighbours are themselves at risk"
    )
    assert abs(len(nothing_in_range) - EXPECTED_NOTHING_IN_RANGE) <= TOLERANCE
    assert abs(len(only_co_hazard) - EXPECTED_ONLY_CO_HAZARD) <= TOLERANCE


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            if fn() is not SKIPPED:
                print("ok", name)
