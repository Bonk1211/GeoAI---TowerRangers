"""Unit tests for the forecast-driven deadline multiplier.

Network-free by construction: `multiplier_for` is pure, and every
`sample_weather_hazard` path exercised here returns before Earth Engine does any
real work. The two facts no credential-free test can measure — that
reduceRegions gets an explicit scale, and that the module never raises — are
asserted against the source.

Run from src/backend:  python3 flood/test_forecast.py   (or via pytest)
"""

import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from flood import forecast
from flood.forecast import multiplier_for, sample_weather_hazard
from scheduler.config_loader import load_policy

_TOWERS = [{"tower_id": "T1", "lon": 101.61, "lat": 3.07}]


def _policy(**overrides):
    policy = load_policy()
    policy["weather_hazard"] = {**policy["weather_hazard"], **overrides}
    return policy


def test_dry_forecast_earns_nothing():
    """A quiet forecast must leave the deadline exactly where it was.

    Not 0.99, not "almost 1" — exactly 1.0, so absence of weather stays
    distinguishable from a weak effect.
    """
    multiplier, drivers = multiplier_for(0.0, 0.1, _policy())
    assert multiplier == 1.0
    assert drivers == ()


def test_multiplier_never_exceeds_one_even_on_a_bad_config():
    """A config edit above 1.0 must not lengthen a deadline.

    Absence of rain is not evidence of safety, and pushing an SLA date out on a
    three-day model run is the one move here that could damage a site.
    """
    policy = _policy(
        multipliers={"severe_rain": 2.0, "watch_rain": 3.0, "saturated_ground": 5.0}
    )
    multiplier, _ = multiplier_for(500.0, 0.9, policy)
    assert multiplier <= 1.0


def test_multiplier_respects_the_floor():
    """One storm must not collapse every flood-dominant tower onto one date.

    Without the floor the optimizer's priority ordering goes flat and the
    resulting schedule is arbitrary.
    """
    policy = _policy()
    multiplier, drivers = multiplier_for(500.0, 0.9, policy)
    assert multiplier >= policy["weather_hazard"]["min_multiplier"]
    assert set(drivers) == {"severe_rain", "saturated_ground"}


def test_rain_bands_are_exclusive():
    """Severe rain must not also count as watch rain and multiply twice."""
    policy = _policy()
    _, drivers = multiplier_for(
        policy["weather_hazard"]["rain_mm"]["severe"] + 1, None, policy
    )
    assert drivers == ("severe_rain",)


def test_saturated_ground_compounds_with_rain():
    """Wet ground plus more rain is worse than either alone."""
    policy = _policy()
    rain_only, _ = multiplier_for(120.0, 0.1, policy)
    both, _ = multiplier_for(120.0, 0.9, policy)
    assert both < rain_only


def test_missing_soil_moisture_still_yields_a_rain_multiplier():
    """SMAP can be absent. Rain alone must still move the deadline."""
    multiplier, drivers = multiplier_for(120.0, None, _policy())
    assert multiplier < 1.0
    assert drivers == ("severe_rain",)


def test_thresholds_are_inclusive_at_the_boundary():
    """A reading exactly at the threshold counts.

    Off-by-one here silently drops the very events the thresholds were chosen
    to catch.
    """
    policy = _policy()
    watch = policy["weather_hazard"]["rain_mm"]["watch"]
    _, drivers = multiplier_for(float(watch), None, policy)
    assert drivers == ("watch_rain",)


def test_sampler_returns_none_when_disabled():
    """None, not {}.

    Empty means "we asked and nothing is affected"; None means there is no
    forecast in this answer at all, and the UI must render those differently.
    """
    assert sample_weather_hazard(_TOWERS, _policy(enabled=False)) is None


def test_sampler_returns_none_for_no_towers():
    assert sample_weather_hazard([], _policy(enabled=True)) is None


def test_sampler_returns_none_rather_than_raising_without_credentials():
    """A forecast outage must cost the forecast, not /towers.

    With the feature on and no usable Earth Engine session this must return
    quietly — never propagate, or the whole scored-tower response dies with it.
    """
    forecast.clear_cache()
    try:
        result = sample_weather_hazard(_TOWERS, _policy(enabled=True))
    except Exception as error:  # noqa: BLE001 - that is the whole assertion
        raise AssertionError(f"sampler raised instead of returning None: {error!r}")
    assert result is None or isinstance(result, dict)
    forecast.clear_cache()


def test_reduce_regions_passes_an_explicit_scale():
    """Third occurrence of this trap in this codebase.

    reduceRegions reprojects to the output projection unless told otherwise, so
    without a scale the value at a tower point silently becomes a resampled
    neighbour's. Matches the call and the keyword, not a bare noun that also
    appears in the prose above it.
    """
    source = inspect.getsource(forecast._sample)
    assert ".reduceRegions(" in source
    assert "scale=scale" in source
    assert source.index("scale=scale") > source.index(".reduceRegions(")
    # And both call sites must pass a real native resolution, not a default.
    caller = inspect.getsource(forecast.sample_weather_hazard)
    assert "GFS_SCALE_M" in caller and "SMAP_SCALE_M" in caller


def test_scales_match_the_source_resolutions():
    """0.25 degrees and 9 km. Wrong values here resample silently."""
    assert forecast.GFS_SCALE_M == 27_750
    assert forecast.SMAP_SCALE_M == 9_000


def test_hazard_serialises_for_the_frontend_contract():
    """to_dict must carry every field types.ts declares, drivers as a list."""
    hazard = forecast.WeatherHazard(
        multiplier=0.5,
        rain_mm_24h=120.0,
        soil_moisture=0.4,
        drivers=("severe_rain", "saturated_ground"),
        issued_at="2026-08-31T06:00:00Z",
        observed_at="2026-08-27T22:30:00Z",
    )
    payload = hazard.to_dict()
    assert set(payload) == {
        "multiplier",
        "rain_mm_24h",
        "soil_moisture",
        "drivers",
        "issued_at",
        "observed_at",
    }
    assert payload["drivers"] == [
        "severe_rain",
        "saturated_ground",
    ], "must serialise as a JSON list, not a tuple"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
