"""Unit tests for the flood catalogue and its request handling.

Network-free by construction: nothing here initialises Earth Engine or mints a
map id. What is worth asserting without credentials is the shape of the
catalogue and the order in which a request is rejected — the second of which was
a real defect, where a malformed date reported itself as "earthengine-api is not
installed" and sent the reader after the wrong problem entirely.

Run from src/backend:  python3 flood/test_layers.py   (or via pytest)
"""

import os
from types import SimpleNamespace
import sys
from datetime import timedelta
from pathlib import Path
from unittest.mock import MagicMock

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))
sys.path.insert(0, str(_BACKEND / "data"))

from flood.layers import (
    BY_ID,
    DEFAULT_FLOOD_SENSOR,
    DSWFP_ROOT_ENV,
    FLOOD_EXTENT_SENSORS,
    GFS_FORECAST_HOURS,
    GLOFAS_LAYER,
    GLOFAS_SOURCES,
    MALAYSIA_BBOX,
    NO_USABLE_OBSERVATION_COLOR,
    S1_LOOKBACK_DAYS,
    ASEAN_BBOX,
    FLOOD_LAYERS,
    _compose_flood_extent,
    _complete_hourly_window,
    _glofas_run_from_capabilities,
    _glofas_tile_url,
    _latest_complete_gfs_run,
    dswfp_asset_name,
)
from tiles.engine import (
    InvalidDate,
    InvalidSensor,
    LayerUnavailable,
    _cache_key,
    _now,
    parse_date,
    tiles_for,
    window_for,
)
from api.routes.flood import get_tiles
from fastapi import HTTPException
from prepare_dswfp import KLANG_VALLEY_BBOX, _accept_obsolete_rescale, _masked_daily_gaps, daily_asset_name


def test_catalogue_ids_are_unique_and_indexed():
    ids = [layer.layer_id for layer in FLOOD_LAYERS]
    assert len(ids) == len(set(ids)), f"duplicate layer ids: {ids}"
    assert set(BY_ID) == set(ids)


def test_every_ee_layer_has_a_builder_and_no_static_one_does():
    for layer in FLOOD_LAYERS:
        if layer.kind == "ee":
            assert layer.builder is not None, f"{layer.layer_id} is an EE layer with no builder"
        else:
            assert layer.builder is None, f"{layer.layer_id} is static but carries a builder"


def test_flood_layers_all_declare_the_water_group():
    # Vegetation and ground condition are the peer package `land/`. A flood
    # layer that drifted into the land group would render in the wrong panel.
    for layer in FLOOD_LAYERS:
        assert layer.group == "water", f"{layer.layer_id} is not in the water group"


def test_every_layer_declares_attribution_and_legend():
    # Attribution is a licence obligation for Copernicus, JRC and NASA data, and
    # a legend-less colour on a map is decoration rather than a reading.
    for layer in FLOOD_LAYERS:
        assert layer.attribution.strip(), f"{layer.layer_id} has no attribution"
        assert layer.legend, f"{layer.layer_id} has no legend"


def test_layer_temporal_kinds_and_asean_forecast_bounds():
    assert {layer.temporal_kind for layer in FLOOD_LAYERS} <= {"scenario", "observation", "forecast"}
    assert {layer.kind for layer in FLOOD_LAYERS} <= {"static", "ee", "wms"}
    for layer_id in (
        "forecast_rainfall_24h",
        "glofas_flood_outlook",
        "glofas_rapid_flood_extent",
    ):
        forecast = BY_ID[layer_id]
        assert forecast.temporal_kind == "forecast"
        # ASEAN, not Malaysia. A source box narrower than the source's coverage
        # does not hide the extra data, it culls tile REQUESTS — so the layer
        # renders through low zoom and vanishes on zoom-in. Measured: a GloFAS
        # alert at 20.6N 97.4E survived zoom 4 and disappeared at zoom 5.
        assert forecast.bounds == ASEAN_BBOX

    # The Sentinel-1 diagnostics stay Malaysia-scoped on purpose: they run a
    # per-scene radar screen, so area is Earth Engine compute.
    assert BY_ID["surface_water"].bounds == MALAYSIA_BBOX
    assert BY_ID["s1_backscatter"].bounds == MALAYSIA_BBOX


def test_flood_extent_catalogue_exposes_southeast_asia_sensor_choices():
    flood_extent = BY_ID["flood_extent"]
    assert BY_ID["potential_depth"].bounds == ASEAN_BBOX
    assert flood_extent.bounds == ASEAN_BBOX
    assert DEFAULT_FLOOD_SENSOR == "sentinel-1"
    assert flood_extent.to_dict()["sensors"] == [dict(sensor) for sensor in FLOOD_EXTENT_SENSORS]
    assert flood_extent.to_dict()["sensors"] == [
        {"id": "sentinel-1", "label": "Sentinel-1 SAR"},
        {"id": "sentinel-2", "label": "Sentinel-2 optical"},
        {"id": "landsat", "label": "Landsat 8/9 optical"},
    ]
    assert flood_extent.legend == [
        {"label": "possible flood", "color": "#e63946"},
        {"label": "no usable sensor observation", "color": "#808080"},
    ]
    assert BY_ID["potential_depth"].legend == [
        {"label": "0–<0.5 m deep", "color": "#22c55e"},
        {"label": "0.5–<1 m deep", "color": "#2563eb"},
        {"label": "1–<2 m deep", "color": "#facc15"},
        {"label": "≥2 m deep", "color": "#dc2626"},
    ]
    assert BY_ID["surface_water"].bounds == MALAYSIA_BBOX
    assert BY_ID["s1_backscatter"].bounds == MALAYSIA_BBOX
    assert all(layer.to_dict()["sensors"] == [] for layer in FLOOD_LAYERS if layer is not flood_extent)


def test_flood_extent_renders_selected_sensor_no_coverage_below_flood():
    water = MagicMock(name="selected_sensor_water")
    normal = MagicMock(name="permanent_water")
    land = MagicMock(name="land")
    region = MagicMock(name="region")

    result = _compose_flood_extent(water, normal, land, region)

    water.mask.assert_called_once_with()
    coverage = water.mask.return_value
    coverage.Not.return_value.And.assert_called_once_with(land)
    coverage.Not.return_value.And.return_value.clip.assert_called_once_with(region)
    no_observation = coverage.Not.return_value.And.return_value.clip.return_value
    no_observation.selfMask.return_value.visualize.assert_called_once_with(
        palette=[NO_USABLE_OBSERVATION_COLOR], min=0, max=1
    )

    water.And.assert_called_once_with(normal.Not.return_value)
    water.And.return_value.And.assert_called_once_with(land)
    water.And.return_value.And.return_value.clip.assert_called_once_with(region)
    flood = water.And.return_value.And.return_value.clip.return_value
    flood.selfMask.return_value.visualize.assert_called_once_with(
        palette=["ffb703", "e63946"], min=0, max=1
    )
    gray = no_observation.selfMask.return_value.visualize.return_value
    red = flood.selfMask.return_value.visualize.return_value
    gray.blend.assert_called_once_with(red)
    assert result is gray.blend.return_value


def test_glofas_latest_time_is_pinned_into_the_wms_url():
    document = f"""
        <WMT_MS_Capabilities><Capability><Layer>
          <Layer><Name>not-this-one</Name><Extent name="time" default="1999-01-01T00:00Z"/></Layer>
          <Layer><Name>{GLOFAS_LAYER}</Name><Dimension name="time" units="ISO8601"/>
            <Extent name="time" default="2026-08-30T00:00Z">history/latest/PT24H</Extent>
          </Layer>
          <Layer><Name>RapidFloodMapping</Name><Dimension name="time" units="ISO8601"/>
            <Extent name="time" default="2026-08-29T00:00Z">history/latest/PT24H</Extent>
          </Layer>
        </Layer></Capability></WMT_MS_Capabilities>
    """.encode()
    for source_layer, expected in (
        (GLOFAS_LAYER, "2026-08-30T00:00Z"),
        ("RapidFloodMapping", "2026-08-29T00:00Z"),
    ):
        issued = _glofas_run_from_capabilities(document, source_layer)
        assert issued.isoformat() == expected.replace("Z", ":00+00:00")
        url = _glofas_tile_url(issued, source_layer)
        assert f"LAYERS={source_layer}" in url
        assert f"TIME={expected}" in url
        assert "BBOX={bbox-epsg-3857}" in url


def test_every_wms_catalogue_layer_has_a_source_and_horizon():
    assert {layer.layer_id for layer in FLOOD_LAYERS if layer.kind == "wms"} == set(GLOFAS_SOURCES)
    assert GLOFAS_SOURCES["glofas_rapid_flood_extent"] == ("RapidFloodMapping", 30 * 24)
    rapid = BY_ID["glofas_rapid_flood_extent"]
    assert "1 km" in rapid.description and "greater than 5,000 km²" in rapid.description
    assert rapid.legend == [{"label": "modelled potential inundation", "color": "#72b2ff"}]


def test_window_looks_backwards_from_the_requested_date():
    start, end = window_for("2021-12-20", S1_LOOKBACK_DAYS)
    # Backwards, so the layer never shows water observed after the date asked
    # for; end is exclusive and therefore the following day.
    assert start == "2021-12-14"
    assert end == "2021-12-21"
    assert (parse_date(end) - parse_date(start)).days == S1_LOOKBACK_DAYS + 1


def test_gsmap_requires_24_consecutive_hours():
    hour = 60 * 60 * 1000
    start, end = _complete_hourly_window([i * hour for i in range(24)])
    assert end - start == timedelta(hours=24)

    for incomplete in ([i * hour for i in range(23)], [i * hour for i in range(24) if i != 12] + [24 * hour]):
        try:
            _complete_hourly_window(incomplete)
        except LayerUnavailable:
            continue
        raise AssertionError("an incomplete GSMaP window should not be accepted")


def test_gfs_selects_latest_complete_fresh_run():
    old = int((_now() - timedelta(hours=12)).timestamp() * 1000)
    latest = int((_now() - timedelta(hours=6)).timestamp() * 1000)
    histogram = {str(old): len(GFS_FORECAST_HOURS), f"{latest:.6E}": len(GFS_FORECAST_HOURS)}
    assert _latest_complete_gfs_run(histogram) == int(float(f"{latest:.6E}"))

    try:
        _latest_complete_gfs_run({str(latest): len(GFS_FORECAST_HOURS) - 1})
    except LayerUnavailable:
        pass
    else:
        raise AssertionError("a partial GFS run should not be accepted")


def test_bad_date_is_rejected_before_earth_engine_is_touched():
    # The ordering guard. Without credentials this must still be InvalidDate,
    # never LayerUnavailable — otherwise a typo is reported as a missing
    # dependency and the caller installs earthengine-api for nothing.
    try:
        tiles_for(BY_ID["flood_extent"], "not-a-date")
    except InvalidDate:
        return
    except LayerUnavailable as error:
        raise AssertionError(f"date validation ran after EE init: {error}")
    raise AssertionError("a malformed date should not be accepted")


def test_bad_sensor_is_rejected_before_earth_engine_and_maps_to_400():
    try:
        tiles_for(BY_ID["flood_extent"], "2021-12-20", "all-merged")
    except InvalidSensor:
        pass
    except LayerUnavailable as error:
        raise AssertionError(f"sensor validation ran after EE init: {error}")
    else:
        raise AssertionError("an unsupported sensor should not be accepted")

    try:
        get_tiles("flood_extent", "2021-12-20", "all-merged")
    except HTTPException as error:
        assert error.status_code == 400
    else:
        raise AssertionError("the route should map an unsupported sensor to HTTP 400")


def test_flood_tile_cache_is_partitioned_by_sensor():
    layer = BY_ID["flood_extent"]
    sentinel_1 = _cache_key(layer, "2021-12-20", "sentinel-1")
    sentinel_2 = _cache_key(layer, "2021-12-20", "sentinel-2")
    landsat = _cache_key(layer, "2021-12-20", "landsat")
    assert len({sentinel_1, sentinel_2, landsat}) == 3


def test_unknown_layer_is_a_404_from_the_route_not_an_outage():
    # Resolving the id is the route's job now, so "no such layer" surfaces as a
    # 404 rather than a 503. Retrying a misspelling would never succeed.
    try:
        get_tiles("nonsense", "2021-12-20", DEFAULT_FLOOD_SENSOR)
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("an unknown layer should not yield tiles")


def test_static_layers_are_refused():
    try:
        tiles_for(BY_ID["potential_depth"], "2021-12-20")
    except LayerUnavailable:
        return
    raise AssertionError("a frontend-mounted layer should not yield Earth Engine tiles")


def test_dswfp_asset_name_matches_the_producer():
    # HYDRAFloods appends `_water` to the producer's base path. A drift here
    # would report "no DSWFP export found" for an export that ran perfectly.
    for date in ("2021-12-20", "2024-08-14", "2020-01-01", "2019-03-09"):
        assert f"{daily_asset_name(date)}_water" == dswfp_asset_name(date)


def test_dswfp_missing_days_have_masked_bands_without_inventing_observations():
    class Number(int):
        def subtract(self, value):
            return Number(self - value)

    class Date(Number):
        def difference(self, other, unit):
            return Number(self - other)

        def advance(self, days, unit):
            return Date(self + days)

        def millis(self):
            return int(self) * 86400000

    class Image(dict):
        def rename(self, band):
            return Image(**self, band=band)

        def selfMask(self):
            return Image(**self, masked=self['value'] == 0)

        def set(self, key, value):
            return Image({**self, key: value})

    class Collection(list):
        def map(self, function):
            return Collection(map(function, self))

        def merge(self, other):
            return Collection([*self, *other])

    observed = Image(value=5, band="mndwi", masked=False, **{"system:time_start": Date(1).millis()})
    original = lambda *args, **kwargs: SimpleNamespace(collection=Collection([observed]))
    workflow = SimpleNamespace(_fuse_dataset=original)
    ee = SimpleNamespace(Date=Date, List=SimpleNamespace(sequence=lambda a, b: Collection(range(a, b + 1))),
                         Image=SimpleNamespace(constant=lambda value: Image(value=value)),
                         ImageCollection=SimpleNamespace(fromImages=Collection))
    with _masked_daily_gaps(ee, workflow):
        result = workflow._fuse_dataset(None, 0, 3, target_band="mndwi").collection
        for day in range(3):
            images = [image for image in result if image["system:time_start"] == Date(day).millis()]
            assert images and all(image["band"] == "mndwi" for image in images)
            assert [image["value"] for image in images if not image["masked"]] == ([5] if day == 1 else [])
        assert not any(image["system:time_start"] == Date(3).millis() for image in result)
    assert workflow._fuse_dataset is original


def test_dswfp_ignores_hydrafloods_obsolete_rescale_keyword():
    class Dataset:
        def __init__(self, value):
            self.value = value

    fake_hf = SimpleNamespace(datasets=SimpleNamespace(Dataset=Dataset))
    _accept_obsolete_rescale(fake_hf)
    assert fake_hf.datasets.Dataset("ok", rescale=True).value == "ok"


def test_dswfp_layer_says_what_to_do_when_unconfigured():
    previous = os.environ.pop(DSWFP_ROOT_ENV, None)
    try:
        tiles_for(BY_ID["daily_water"], "2021-12-20")
    except LayerUnavailable as error:
        # It must name the producer, not just fail: an unexported date is the
        # ordinary state of this layer, not an outage.
        assert "prepare_dswfp" in str(error)
    else:
        raise AssertionError("an unconfigured DSWFP root should not yield tiles")
    finally:
        if previous is not None:
            os.environ[DSWFP_ROOT_ENV] = previous


def test_dswfp_region_is_the_klang_valley_not_the_whole_country():
    lon_min, lat_min, lon_max, lat_max = KLANG_VALLEY_BBOX
    area = (lon_max - lon_min) * (lat_max - lat_min)
    # hf.country_bbox("Malaysia") spans the peninsula AND Borneo — about 143
    # square degrees, mostly sea. On a workflow the upstream docs say can take
    # days, running it over that box is the expensive mistake.
    assert area < 5, f"DSWFP AOI is {area:.1f} square degrees; that is country-scale"
    assert lon_min < 101.6 < lon_max and lat_min < 3.07 < lat_max, "AOI must contain the towers"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
