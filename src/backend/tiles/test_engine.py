"""Unit tests for the domain-free tile engine.

Network-free by construction: nothing here initialises Earth Engine or mints a
map id. What is worth asserting without credentials is the order in which a
request is rejected and the shape of what comes back — the first of which was a
real defect, where a malformed date reported itself as "earthengine-api is not
installed" and sent the reader after the wrong problem entirely.

Every layer used here is synthetic. The engine must not need `flood` or `land`
to be testable, and a test that reached for a real catalogue entry would quietly
make it depend on one.

Run from src/backend:  python3 tiles/test_engine.py   (or via pytest)
"""

import inspect
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from tiles.ee_session import credentials_status
from tiles.engine import (
    InvalidDate,
    InvalidSensor,
    Layer,
    LayerUnavailable,
    _cache_key,
    _now,
    _public_payload,
    iso,
    parse_date,
    parse_sensor,
    scene_count,
    tiles_for,
    window_for,
)


def _layer(**overrides) -> Layer:
    base = dict(
        layer_id="synthetic",
        label="Synthetic",
        description="Test fixture.",
        kind="ee",
        attribution="none",
        legend=[{"label": "x", "color": "#000000"}],
        builder=lambda ee, hf, date: None,
    )
    base.update(overrides)
    return Layer(**base)


def test_parse_date_rejects_anything_but_iso_dates():
    parsed = parse_date("2021-12-20")
    assert (parsed.year, parsed.month, parsed.day) == (2021, 12, 20)
    for bad in ("20-12-2021", "2021/12/20", "yesterday", "", "2021-13-01"):
        try:
            parse_date(bad)
        except InvalidDate:
            continue
        raise AssertionError(f"{bad!r} should not parse as a date")


def test_window_looks_backwards_and_takes_the_callers_lookback():
    # The lookback is the caller's because revisit intervals differ by sensor. A
    # default here would silently hand one domain another's cadence.
    start, end = window_for("2021-12-20", 6)
    assert end == "2021-12-21", "the window must include the requested day"
    assert start == "2021-12-14"
    assert (parse_date(end) - parse_date(start)).days == 7
    assert window_for("2021-12-20", 1)[0] == "2021-12-19"


def test_parse_sensor_validates_against_the_layer_not_a_global_list():
    # Against the layer, because the flood sensor list is not universal: a layer
    # in another domain with its own sources would otherwise be checked against
    # Sentinel-1/2/Landsat and reject every valid request.
    layer = _layer(sensors=({"id": "alpha", "label": "A"}, {"id": "beta", "label": "B"}))
    assert parse_sensor(layer, "beta") == "beta"
    for bad in ("sentinel-1", "", "gamma"):
        try:
            parse_sensor(layer, bad)
        except InvalidSensor:
            continue
        raise AssertionError(f"{bad!r} is not a source this layer offers")


def test_bad_date_is_rejected_before_earth_engine_is_touched():
    # The ordering guard. Without credentials this must still be InvalidDate,
    # never LayerUnavailable — otherwise a typo is reported as a missing
    # dependency and the caller installs earthengine-api for nothing.
    try:
        tiles_for(_layer(), "not-a-date")
    except InvalidDate:
        return
    except LayerUnavailable as error:
        raise AssertionError(f"date validation ran after EE init: {error}")
    raise AssertionError("a malformed date should not be accepted")


def test_missing_configuration_is_reported_before_credentials():
    # A layer missing its own environment variable has a configuration gap, not
    # an authentication problem, and reporting it as one sends the reader off to
    # re-check credentials that were never at fault.
    try:
        tiles_for(_layer(requires_env="DEFINITELY_NOT_SET_ANYWHERE"), "2021-12-20")
    except LayerUnavailable as error:
        assert "DEFINITELY_NOT_SET_ANYWHERE" in str(error)
        return
    raise AssertionError("an unconfigured layer should not yield tiles")


def test_static_layers_are_refused():
    try:
        tiles_for(_layer(kind="static", builder=None), "2021-12-20")
    except LayerUnavailable as error:
        assert "frontend" in str(error)
        return
    raise AssertionError("a frontend-mounted layer should not yield tiles")


def test_hydrafloods_is_only_imported_for_layers_that_need_it():
    # A layer that never touches HYDRAFloods must not 503 with "hydrafloods is
    # not installed" on a machine carrying earthengine-api and nothing else.
    source = inspect.getsource(tiles_for)
    assert "needs_hydrafloods" in source
    assert source.index("needs_hydrafloods") < source.index("import hydrafloods")


def test_wms_layers_resolve_through_their_own_resolver():
    # The engine must not know which external service is behind a layer, the
    # same way `builder` keeps it from knowing which dataset an 'ee' layer uses.
    source = inspect.getsource(tiles_for)
    assert "layer.resolver(layer)" in source
    assert "GLOFAS" not in source and "glofas" not in source


def test_cache_key_collapses_dates_for_undated_layers_only():
    dated = _layer(layer_id="dated", dated=True)
    undated = _layer(layer_id="undated", dated=False)
    assert _cache_key(dated, "2021-01-01", None) != _cache_key(dated, "2021-06-01", None)
    assert _cache_key(undated, "2021-01-01", None) == _cache_key(undated, "2021-06-01", None)


def test_cache_key_is_partitioned_by_sensor():
    layer = _layer(sensors=({"id": "a", "label": "A"}, {"id": "b", "label": "B"}))
    assert _cache_key(layer, "2021-12-20", "a") != _cache_key(layer, "2021-12-20", "b")


def test_layer_record_defaults_to_the_water_group_and_publishes_it():
    # The group only decides which panel lists an entry; the engine never reads
    # it. It must survive to_dict, because the frontend splits its panels on it.
    assert _layer().group == "water"
    assert _layer(group="land").to_dict()["group"] == "land"


def test_public_payload_hides_internal_expiry_and_refreshes_forecast_age():
    issued = _now() - timedelta(hours=2)
    payload = {
        "layer_id": "synthetic",
        "expires_at_dt": _now(),
        "forecast": {"issued_at": iso(issued), "source_age_seconds": 0},
    }
    result = _public_payload(payload)
    assert "expires_at_dt" not in result, "an internal datetime must not reach the client"
    assert result["forecast"]["source_age_seconds"] >= 7100


def test_scene_count_names_the_sensor_and_the_region_it_searched():
    class Empty:
        def size(self):
            return self

        def getInfo(self):
            return 0

    try:
        scene_count(Empty(), "Sentinel-2", "2021-12-14", "2021-12-21", region_label="Borneo")
    except LayerUnavailable as error:
        assert "Sentinel-2" in str(error) and "Borneo" in str(error)
        return
    raise AssertionError("an empty collection should not pass as an observation")


def test_credentials_status_never_leaks_secrets():
    status = credentials_status()
    assert set(status) == {
        "project_set",
        "service_account_set",
        "key_file_readable",
        "user_credentials_present",
        "adc_present",
        "mode",
        "configured",
    }
    assert status["mode"] in {"service_account", "user", "adc", "none"}
    # Booleans and one enum only: no paths, no account address, no key material.
    assert isinstance(status["mode"], str)
    assert all(isinstance(v, bool) for k, v in status.items() if k != "mode")


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
