"""Unit tests for mechanism-weighted urgency and its weather coupling.

No scheduler tests existed before. This function gained real branching when the
forecast was wired into it, and the branch that matters most is the one that
does *nothing*: an equipment-dominant tower must not have its deadline pulled in
because rain is forecast.

Network-free. The hazard is a stub exposing only `.multiplier`, which is the
whole interface urgency_days uses. That duck-typing is deliberate — importing
flood.forecast here would make /schedule depend on Earth Engine.

Run from src/backend:  python3 scheduler/test_urgency.py   (or via pytest)
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.config_loader import load_policy
from scheduler.urgency import FACTOR_BASE_URGENCY_DAYS, urgency_days


class _Hazard:
    """Minimal stand-in. urgency_days must need nothing but `.multiplier`."""

    def __init__(self, multiplier: float) -> None:
        self.multiplier = multiplier


_POLICY = load_policy()
_SEVERE = _Hazard(0.5)


def test_hazard_none_reproduces_the_pre_forecast_number():
    """The no-credentials path. Passing None must change nothing at all."""
    for shares in (
        {"flood": 0.9, "equipment": 0.1},
        {"equipment": 1.0},
        {"flood": 0.3, "terrain": 0.3, "power": 0.4},
    ):
        assert urgency_days(shares) == urgency_days(shares, None, _POLICY)


def test_equipment_dominant_tower_is_untouched_by_weather():
    """The decision this whole design rests on.

    Rain does not accelerate radio-unit wear-out. If the multiplier were applied
    to the whole blend instead of the coupled share, a 90-day RRU refresh would
    halve because a storm is forecast — a plausible-looking schedule that is
    operationally nonsense.
    """
    shares = {"equipment": 1.0}
    assert urgency_days(shares, _SEVERE, _POLICY) == urgency_days(shares)


def test_flood_dominant_tower_moves_a_long_way():
    shares = {"flood": 1.0}
    baseline = urgency_days(shares)
    with_hazard = urgency_days(shares, _SEVERE, _POLICY)
    assert with_hazard < baseline
    # flood couples at 1.0, so a 0.5 multiplier halves its base timescale.
    assert with_hazard == max(1, round(FACTOR_BASE_URGENCY_DAYS["flood"] * 0.5))


def test_terrain_couples_half_as_strongly_as_flood():
    """A slope saturates and fails more slowly than a cabinet floods.

    Compares each factor's own proportional shift, not raw days — flood and
    terrain have different base timescales (10 vs 30), so raw deltas would not
    be comparable.
    """
    flood_base = urgency_days({"flood": 1.0})
    flood_moved = urgency_days({"flood": 1.0}, _SEVERE, _POLICY)
    terrain_base = urgency_days({"terrain": 1.0})
    terrain_moved = urgency_days({"terrain": 1.0}, _SEVERE, _POLICY)

    flood_shift = (flood_base - flood_moved) / flood_base
    terrain_shift = (terrain_base - terrain_moved) / terrain_base
    assert 0 < terrain_shift < flood_shift
    assert abs(terrain_shift - flood_shift / 2) < 0.05


def test_shift_scales_with_the_flood_share():
    """The multiplier lands on the share, so a barely-flood tower barely moves.

    This is what makes the behaviour physically honest rather than a blanket
    discount applied to everything with any flood exposure at all.
    """
    mostly = {"flood": 0.9, "equipment": 0.1}
    barely = {"flood": 0.05, "equipment": 0.95}
    mostly_shift = (
        urgency_days(mostly) - urgency_days(mostly, _SEVERE, _POLICY)
    ) / urgency_days(mostly)
    barely_shift = (
        urgency_days(barely) - urgency_days(barely, _SEVERE, _POLICY)
    ) / urgency_days(barely)
    assert mostly_shift > barely_shift
    assert barely_shift < 0.05


def test_uncoupled_factors_are_never_scaled():
    """Only what policy.weather_hazard.coupled_factors names may move."""
    coupled = _POLICY["weather_hazard"]["coupled_factors"]
    for factor in FACTOR_BASE_URGENCY_DAYS:
        if factor in coupled:
            continue
        shares = {factor: 1.0}
        assert urgency_days(shares, _SEVERE, _POLICY) == urgency_days(shares), factor


def test_urgency_never_returns_zero():
    """A deadline of 0 days breaks the optimizer's date arithmetic.

    An all-zero shares row could already reach 0 before the multiplier existed;
    shortening makes the case easier to hit.
    """
    assert urgency_days({}) >= 1
    assert urgency_days({}, _Hazard(0.4), _POLICY) >= 1
    assert urgency_days({"flood": 0.0}, _Hazard(0.4), _POLICY) >= 1


def test_missing_factors_contribute_nothing():
    """lightning is dropped on this AOI for null coverage; absence must not raise."""
    assert urgency_days({"flood": 1.0}) == urgency_days({"flood": 1.0, "lightning": 0.0})


def test_a_quiet_forecast_leaves_every_deadline_alone():
    """multiplier 1.0 is "we asked and it is quiet" — no shift, but not None."""
    shares = {"flood": 0.9, "equipment": 0.1}
    assert urgency_days(shares, _Hazard(1.0), _POLICY) == urgency_days(shares)


def test_policy_absent_disables_coupling_entirely():
    """Without a policy there are no coupled factors, so a hazard cannot apply.

    Guards the default-argument path: a caller that forgets the policy gets the
    baseline number, never a silently half-applied multiplier.
    """
    shares = {"flood": 1.0}
    assert urgency_days(shares, _SEVERE) == urgency_days(shares)


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
