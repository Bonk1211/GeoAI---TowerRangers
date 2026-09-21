"""The flood layer catalogue and the imagery behind it.

Water only. Vegetation and ground condition are the peer package `land/`;
neither imports the other and both sit on `tiles/engine.py`, which owns the
`Layer` record, the validation ordering, the map-id cache and the access probe.

Each layer here is a small record: what it is called, what it means, how it is
coloured, and — for the ones that need Earth Engine — a builder that turns a
date into an `ee.Image`. The catalogue itself is static metadata and is served
without touching Earth Engine at all, so the frontend can render the layer list,
its legends and its unavailable states whether or not credentials exist.

Two honesty constraints shape what is in here.

Sentinel-1 revisits this latitude roughly every six days, so "the flood layer
for 14 August" is really "the water seen in the fixed window ending 14 August".
Sentinel-2 and Landsat use that same bounded window, with cloud and quality
screening. Every response carries the window and regional scene count actually
used; a window with no regional scenes is an error, while gray map pixels mark
land without a usable local observation.

Satellite water screening also cannot tell a flood from a river.
`surface_water` is everything radar classified as water; `permanent_water` is
what is normally wet (JRC Global Surface Water); `flood_extent` subtracts the
latter and is the only one of the three that means "water where water does not
belong". The optical choices remain screening masks, not calibrated fusion.
"""

from __future__ import annotations

import os
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone

from tiles.ee_session import LayerUnavailable
from tiles.engine import (
    PROBE_TIMEOUT_SECONDS,
    InvalidSensor,
    Layer,
    _now,
    _probe_wms_access,
    _ssl_context,
    iso,
    parse_date,
    scene_count,
    window_for,
)

# Sentinel-1's repeat cycle here is about six days; a single calendar date is
# usually empty. The window runs backwards from the requested date so the layer
# never shows water observed after the date the user asked about.
S1_LOOKBACK_DAYS = 6

# Backscatter thresholds in dB. The regional flood screen uses -16 directly;
# the Malaysia diagnostic layers use it to seed hydrafloods' edge_otsu.
INITIAL_THRESHOLD_DB = -16.0
THRESH_NO_DATA_DB = -20.0

# JRC occurrence percentage at or above which a pixel counts as normally wet.
# 80% is the conventional cut for "permanent" in that dataset: high enough to
# exclude seasonal floodplain, low enough to keep rivers that move in-channel.
#
# Deliberately NOT lowered to 50, though that would look tidier. Measured over
# the Klang Valley for 2021-12-20 it cuts detected flood from 96 km2 to 65 km2,
# and what it removes is seasonal floodplain — exactly the ground that floods.
# A quieter map bought by reclassifying flood-prone land as normally wet is a
# worse map.
PERMANENT_WATER_OCCURRENCE = 80

# Pixels of dilation applied to the permanent-water mask before subtracting it.
#
# JRC is a static 30 m product; a Sentinel-1 scene is a different sensor on a
# different date at a different tide. Their water boundaries disagree by a pixel
# or two, and that disagreement traced a red outline along every coastline and
# riverbank — 18 km2 of "flood" in the Klang Valley that was only misregistration.
# Growing the permanent mask slightly absorbs it. Kept small: each extra pixel
# also erodes genuine flooding on the banks of the rivers that caused it.
PERMANENT_WATER_DILATION_PX = 2

# Retained scope for the Sentinel-1 diagnostic layers only. Those two run a
# per-scene radar screen, so widening them multiplies Earth Engine work by the
# area; the forecast and observation layers no longer use this box.
MALAYSIA_BBOX = (99.0, 0.5, 119.5, 7.5)

# Dated flood observations and the forecast layers both cover ASEAN. The extent
# spans Myanmar's west edge to Indonesian Papua and Rote to northern Myanmar.
#
# `bounds` on a raster source culls TILE REQUESTS; it does not clip pixels. So a
# box narrower than the source's real coverage does not hide the extra data — it
# shows it at low zoom, where one tile straddles the edge and the server paints
# that tile whole, then drops it once the tile stops touching the box. Measured
# on the GloFAS outlook: a Myanmar alert at 20.6N 97.4E rendered through zoom 4
# and vanished at zoom 5. Either a box covers the source or it lies about it.
ASEAN_BBOX = (92.0, -11.5, 142.0, 29.0)

DEFAULT_FLOOD_SENSOR = "sentinel-1"
FLOOD_EXTENT_SENSORS = (
    {"id": DEFAULT_FLOOD_SENSOR, "label": "Sentinel-1 SAR"},
    {"id": "sentinel-2", "label": "Sentinel-2 optical"},
    {"id": "landsat", "label": "Landsat 8/9 optical"},
)
OPTICAL_WATER_THRESHOLD = 0.15
NO_USABLE_OBSERVATION_COLOR = "808080"

# GFS publishes cumulative precipitation for the previous 1–6 hours. Summing
# only six-hour boundaries avoids double-counting and yields the next 24 hours.
GFS_FORECAST_HOURS = (6, 12, 18, 24)
GFS_RUN_LOOKBACK_HOURS = 72
GFS_MAX_RUN_AGE_HOURS = 18

# CEMS GloFAS publishes this river-flood summary daily. The WMS default time is
# source-selected, then pinned into the tile URL so browser caches cannot keep
# yesterday's unnamed "latest" layer alive.
GLOFAS_CAPABILITIES_URL = (
    "https://ows.globalfloods.eu/glofas-ows/ows.py"
    "?SERVICE=WMS&REQUEST=GetCapabilities&VERSION=1.1.1"
)
GLOFAS_WMS_URL = "https://ows.globalfloods.eu/glofas-ows/ows.py"
GLOFAS_LAYER = "sumAL41EGE"
GLOFAS_LEAD_HOURS = 72
GLOFAS_SOURCES = {
    "glofas_flood_outlook": (GLOFAS_LAYER, GLOFAS_LEAD_HOURS),
    "glofas_rapid_flood_extent": ("RapidFloodMapping", 30 * 24),
}
GLOFAS_MAX_RUN_AGE_HOURS = 48
GLOFAS_CAPABILITIES_MAX_BYTES = 2_000_000
















def _sentinel1_scenes(ee, hf, date: str):
    start, end = window_for(date, S1_LOOKBACK_DAYS)
    region = ee.Geometry.Rectangle(list(MALAYSIA_BBOX))
    scenes = hf.Sentinel1(region, start, end)
    n_images = scenes.n_images
    if n_images == 0:
        raise LayerUnavailable(
            f"no Sentinel-1 scenes over Malaysia for {start}..{end}. "
            "Sentinel-1 revisits about every six days — try a nearby date."
        )
    return scenes, n_images, (start, end)


def _sentinel1_water(ee, hf, date: str):
    """Water mask from the Sentinel-1 scenes nearest `date`, plus scene count."""
    scenes, n_images, window = _sentinel1_scenes(ee, hf, date)
    water = scenes.apply_func(
        hf.thresholding.edge_otsu,
        initial_threshold=INITIAL_THRESHOLD_DB,
        band="VV",
        thresh_no_data=THRESH_NO_DATA_DB,
    ).collection.max()
    return water, n_images, window


def _permanent_water_mask(ee):
    occurrence = ee.Image("JRC/GSW1_4/GlobalSurfaceWater").select("occurrence")
    return occurrence.gte(PERMANENT_WATER_OCCURRENCE).unmask(0)


def _land_mask(ee):
    """Land, from SRTM's own coverage.

    SRTM carries no elevation over open water, so its mask is a land mask —
    physical rather than political, which matters twice here: floods do not stop
    at borders, and a country polygon would have drawn one across this map. It
    also keeps the small coastal islands that LSIB's simplified geometry drops,
    and those sit right where the Klang estuary floods.

    Without this the flood layer called the Strait of Malacca flooded: measured
    over the Klang Valley for 2021-12-20, raw detection was 1206 km2, of which
    1091 km2 — 90% — was sea whose tidal edge simply disagreed with JRC's static
    mask. This is a correctness fix, not a cosmetic one.
    """
    return ee.Image("CGIAR/SRTM90_V4").mask().gt(0)


def build_surface_water(ee, hf, date: str):
    water, n_images, window = _sentinel1_water(ee, hf, date)
    region = ee.Geometry.Rectangle(list(MALAYSIA_BBOX))
    image = water.selfMask().visualize(palette=["3d7fd4"], min=0, max=1).clip(region)
    return image, n_images, window, {}




def _sentinel1_screening_mask(ee, date: str):
    start, end = window_for(date, S1_LOOKBACK_DAYS)
    region = ee.Geometry.Rectangle(list(ASEAN_BBOX))
    collection = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(region)
        .filterDate(start, end)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
        .select("VV")
    )
    n_images = scene_count(collection, "Sentinel-1", start, end)
    return collection.median().lt(INITIAL_THRESHOLD_DB), n_images, (start, end)


def _sentinel2_screening_mask(ee, date: str):
    start, end = window_for(date, S1_LOOKBACK_DAYS)
    region = ee.Geometry.Rectangle(list(ASEAN_BBOX))
    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
    )
    n_images = scene_count(collection, "Sentinel-2", start, end)

    def clear_mndwi(image):
        scl = image.select("SCL")
        # SCL 4–7 retains vegetation, bare ground, water and unclassified land;
        # it screens no-data, bad pixels, shadow, cloud, cirrus and snow/ice.
        clear = scl.gte(4).And(scl.lte(7))
        return image.updateMask(clear).normalizedDifference(["B3", "B11"]).rename("MNDWI")

    mndwi = collection.map(clear_mndwi).median()
    return mndwi.gt(OPTICAL_WATER_THRESHOLD), n_images, (start, end)


def _landsat_screening_mask(ee, date: str):
    start, end = window_for(date, S1_LOOKBACK_DAYS)
    region = ee.Geometry.Rectangle(list(ASEAN_BBOX))
    landsat_8 = (
        ee.ImageCollection("LANDSAT/LC08/C02/T1_L2")
        .filterBounds(region)
        .filterDate(start, end)
    )
    landsat_9 = (
        ee.ImageCollection("LANDSAT/LC09/C02/T1_L2")
        .filterBounds(region)
        .filterDate(start, end)
    )
    collection = landsat_8.merge(landsat_9)
    n_images = scene_count(collection, "Landsat 8/9", start, end)

    def clear_mndwi(image):
        # QA_PIXEL bits 0–5 flag fill, dilated cloud, cirrus, cloud, shadow and
        # snow; QA_RADSAT removes saturated observations.
        clear = image.select("QA_PIXEL").bitwiseAnd(0b111111).eq(0)
        clear = clear.And(image.select("QA_RADSAT").eq(0))
        reflectance = image.select(["SR_B3", "SR_B6"]).multiply(0.0000275).add(-0.2)
        green = reflectance.select("SR_B3")
        swir = reflectance.select("SR_B6")
        mndwi = green.subtract(swir).divide(green.add(swir)).rename("MNDWI")
        return mndwi.updateMask(clear)

    mndwi = collection.map(clear_mndwi).median()
    return mndwi.gt(OPTICAL_WATER_THRESHOLD), n_images, (start, end)


def _compose_flood_extent(water, normal, land, region):
    # The mask on `water` is the usable-observation footprint. For optical
    # sensors it already includes the SCL/QA screening applied before median(),
    # so cloud-covered pixels are correctly shown as unobserved rather than dry.
    no_observation = water.mask().Not().And(land).clip(region)
    no_observation_visual = no_observation.selfMask().visualize(
        palette=[NO_USABLE_OBSERVATION_COLOR], min=0, max=1
    )

    # Subtracting normally-wet pixels is what turns "radar saw water" into "water
    # is somewhere it is not usually". Without it every river in the region
    # lights up and the layer says nothing about flooding. The same subtraction
    # is applied to optical screening masks.
    #
    # The dilation and the land mask are the difference between a plausible map
    # and a correct one — see the constants above for what each removes.
    flood = water.And(normal.Not()).And(land).clip(region)
    flood_visual = flood.selfMask().visualize(palette=["ffb703", "e63946"], min=0, max=1)
    return no_observation_visual.blend(flood_visual)


def build_flood_extent(ee, hf, date: str, sensor: str = DEFAULT_FLOOD_SENSOR):
    builders = {
        "sentinel-1": _sentinel1_screening_mask,
        "sentinel-2": _sentinel2_screening_mask,
        "landsat": _landsat_screening_mask,
    }
    # This dict is the real authority on which sources this builder supports, so
    # it does the validating. The engine has already checked the request against
    # the layer's declared `sensors`; this catches the two lists drifting apart,
    # and keeps the builder safe to call directly from a test.
    if sensor not in builders:
        choices = ", ".join(sorted(builders))
        raise InvalidSensor(f"sensor must be one of {choices}, got {sensor!r}")
    water, n_images, window = builders[sensor](ee, date)
    normal = _permanent_water_mask(ee).focal_max(PERMANENT_WATER_DILATION_PX)
    land = _land_mask(ee)
    region = ee.Geometry.Rectangle(list(ASEAN_BBOX))
    return _compose_flood_extent(water, normal, land, region), n_images, window, {}


def build_permanent_water(ee, hf, date: str):
    image = _permanent_water_mask(ee).selfMask().visualize(palette=["1d4e89"], min=0, max=1)
    return image, None, None, {}


def _complete_hourly_window(timestamps_ms: list[int]) -> tuple[datetime, datetime]:
    """Validate 24 consecutive hourly source images and return their time span."""
    hours = [datetime.fromtimestamp(value / 1000, tz=timezone.utc) for value in sorted(timestamps_ms)]
    if len(hours) != 24 or any(b - a != timedelta(hours=1) for a, b in zip(hours, hours[1:])):
        raise LayerUnavailable(
            f"GSMaP has {len(hours)} usable hourly images, not a complete trailing 24-hour window"
        )
    return hours[0], hours[-1] + timedelta(hours=1)


def _latest_complete_gfs_run(histogram: dict[str, int]) -> int:
    """Latest non-stale GFS run carrying every six-hour boundary through +24h."""
    complete = [
        int(float(created))
        for created, count in histogram.items()
        if count == len(GFS_FORECAST_HOURS)
    ]
    if not complete:
        raise LayerUnavailable("GFS has no complete 24-hour forecast run in the last 72 hours")

    issued_ms = max(complete)
    issued = datetime.fromtimestamp(issued_ms / 1000, tz=timezone.utc)
    age = _now() - issued
    if age > timedelta(hours=GFS_MAX_RUN_AGE_HOURS):
        raise LayerUnavailable(
            f"latest complete GFS run is {age.total_seconds() / 3600:.1f} h old; "
            f"refusing data older than {GFS_MAX_RUN_AGE_HOURS} h"
        )
    return issued_ms


def _sum_at_source_projection(ee, collection):
    """Sum an ImageCollection without Earth Engine's synthetic 1-degree grid."""
    projection = ee.Image(collection.first()).projection()
    return collection.sum().setDefaultProjection(projection)


def _latest_gfs_rainfall(ee):
    """Next 24 h rainfall from the latest complete NOAA GFS model run."""
    collection = ee.ImageCollection("NOAA/GFS0P25")
    cutoff_ms = int((_now() - timedelta(hours=GFS_RUN_LOOKBACK_HOURS)).timestamp() * 1000)
    candidates = collection.filter(ee.Filter.inList("forecast_hours", list(GFS_FORECAST_HOURS))).filter(
        ee.Filter.gte("creation_time", cutoff_ms)
    )
    issued_ms = _latest_complete_gfs_run(candidates.aggregate_histogram("creation_time").getInfo())
    run = (
        collection.filter(ee.Filter.eq("creation_time", issued_ms))
        .filter(ee.Filter.inList("forecast_hours", list(GFS_FORECAST_HOURS)))
        .sort("forecast_hours")
    )
    hours = sorted(int(value) for value in run.aggregate_array("forecast_hours").getInfo())
    forecast_times = sorted(int(value) for value in run.aggregate_array("forecast_time").getInfo())
    expected_times = [issued_ms + hour * 60 * 60 * 1000 for hour in GFS_FORECAST_HOURS]
    if hours != list(GFS_FORECAST_HOURS) or forecast_times != expected_times:
        raise LayerUnavailable(
            f"GFS run {iso(datetime.fromtimestamp(issued_ms / 1000, tz=timezone.utc))} "
            "is incomplete or has inconsistent valid times"
        )

    issued = datetime.fromtimestamp(issued_ms / 1000, tz=timezone.utc)
    valid_end = issued + timedelta(hours=GFS_FORECAST_HOURS[-1])
    rain = _sum_at_source_projection(ee, run.select("total_precipitation_surface"))
    return rain, {
        "issued_at": iso(issued),
        "valid": {"start": iso(issued), "end": iso(valid_end)},
        "lead_hours": GFS_FORECAST_HOURS[-1],
        "source_age_seconds": max(0, int((_now() - issued).total_seconds())),
        "bounds": list(ASEAN_BBOX),
    }


def build_forecast_rainfall(ee, hf, date: str):
    rain, forecast = _latest_gfs_rainfall(ee)
    image = (
        rain.updateMask(rain.gt(1))
        .visualize(min=1, max=200, palette=["c7e9f0", "5ab4e0", "2c7fb8", "253494", "8b1e8b"])
        .clip(ee.Geometry.Rectangle(list(ASEAN_BBOX)))
    )
    valid = forecast["valid"]
    return image, None, (valid["start"], valid["end"]), {
        "forecast": forecast,
        "source_count": len(GFS_FORECAST_HOURS),
    }


def build_precipitation(ee, hf, date: str):
    """Latest complete trailing 24-hour GSMaP accumulation, in millimetres.

    JAXA GSMaP rather than GPM IMERG, for freshness: measured over the Klang
    Valley, GSMaP's latest image was 17 h old against IMERG's 27.5 h. Rainfall is
    the leading indicator here — flood extent is what has already happened — so
    ten hours matters more on this layer than on any other.

    `hourlyPrecipRateGC` is the gauge-calibrated band, confirmed populated in the
    near-real-time images rather than lagging behind the raw satellite estimate.

    Note the unit change this swap forces: GSMaP is HOURLY, so summing rates in
    mm/hr over a day gives millimetres directly. IMERG was half-hourly and needed
    the sum halved. Carrying the old 0.5 across would have reported half the real
    rainfall while still looking entirely plausible.
    """
    day_end = parse_date(date) + timedelta(days=1)
    gsmap = (
        ee.ImageCollection("JAXA/GPM_L3/GSMaP/v8/operational")
        .filterDate(
            (day_end - timedelta(days=3)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            day_end.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        .select("hourlyPrecipRateGC")
        .sort("system:time_start", False)
        .limit(24)
        .sort("system:time_start")
    )
    start, end = _complete_hourly_window(gsmap.aggregate_array("system:time_start").getInfo())
    total = _sum_at_source_projection(ee, gsmap)
    # Masked below 1 mm: a trace everywhere would tint the whole country and make
    # the layer look like coverage rather than rainfall.
    #
    # Ramp tops at 200 mm, measured rather than guessed: the 18 Dec 2021 storm
    # that flooded the Klang Valley peaked at 202 mm in 24 h here. The previous
    # 100 mm ceiling would have saturated across the whole upper half of a real
    # event, flattening the worst day into one colour.
    image = total.updateMask(total.gt(1)).visualize(
        min=1, max=200, palette=["c7e9f0", "5ab4e0", "2c7fb8", "253494", "8b1e8b"]
    )
    return image, None, (iso(start), iso(end)), {
        "observed_at": iso(end - timedelta(hours=1)),
        "source_count": 24,
    }


DSWFP_ROOT_ENV = "GEE_DSWFP_ASSET_ROOT"
DSWFP_DAILY_PREFIX = "daily_water"


def dswfp_asset_name(date: str) -> str:
    """`2021-12-20` -> exported asset `daily_water_20211220_water`.

    HYDRAFloods appends `_water` to the base path returned by daily_asset_name()
    in data/prepare_dswfp.py.
    """
    return f"{DSWFP_DAILY_PREFIX}_{parse_date(date).strftime('%Y%m%d')}_water"


def build_daily_water(ee, hf, date: str):
    """Fused daily surface water from a DSWFP export.

    Unlike every other Earth Engine layer here, this one computes nothing: the
    fusion, the harmonic prediction and the thresholding all happened in a batch
    export that ran for hours. This reads the finished asset.

    That is a property of the workflow, not a shortcut. HYDRAFloods builds the
    daily image inline inside export_daily_surface_water and exposes no public
    function returning it, so there is nothing to evaluate lazily at tile time —
    a date that was never exported simply has no image, and saying so plainly
    beats a stack trace from deep inside the EE client.
    """
    root = os.environ.get(DSWFP_ROOT_ENV, "").strip().rstrip("/")
    if not root:
        raise LayerUnavailable(
            f"{DSWFP_ROOT_ENV} is not set, so there is no DSWFP output to read. "
            "Set it to a writable Earth Engine asset folder, then run "
            "src/backend/data/prepare_dswfp.py to produce the three batch outputs."
        )

    asset_id = f"{root}/{dswfp_asset_name(date)}"
    try:
        image = ee.Image(asset_id)
        # Force a server round trip now. Without it an id that does not exist
        # would sail through getMapId() and fail later as blank tiles, which is
        # exactly the silent-empty-layer failure this module is arranged around.
        band_names = image.bandNames().getInfo()
    except Exception as error:
        raise LayerUnavailable(
            f"no DSWFP export found at {asset_id} ({error}). Run:\n"
            f"  python3 src/backend/data/prepare_dswfp.py daily --date {date}"
        ) from error

    # include_flood=True in the producer adds this band; prefer it over raw
    # water, since water alone includes every river and reservoir.
    band = "flood" if "flood" in band_names else "water"
    palette = ["e63946"] if band == "flood" else ["3d7fd4"]
    visual = image.select(band).selfMask().visualize(palette=palette, min=0, max=1)
    return visual, None, None, {}


def build_s1_backscatter(ee, hf, date: str):
    scenes, n_images, window = _sentinel1_scenes(ee, hf, date)
    region = ee.Geometry.Rectangle(list(MALAYSIA_BBOX))
    image = scenes.collection.select("VV").mosaic().visualize(min=-25, max=0).clip(region)
    return image, n_images, window, {}


def _resolve_glofas(layer) -> tuple[str, None, tuple[str, str], dict, str]:
    """Pin the latest CEMS GloFAS run for `layer` into a tile template.

    Attached to the GloFAS entries as their `resolver`, so the tile engine's
    'wms' branch never learns which external service is behind a layer — the
    same separation `builder` gives the 'ee' branch.
    """
    source_layer, lead_hours = GLOFAS_SOURCES[layer.layer_id]
    issued = _latest_glofas_run(source_layer)
    valid_end = issued + timedelta(hours=lead_hours)
    url_format = _glofas_tile_url(issued, source_layer)
    source = {
        "forecast": {
            "issued_at": iso(issued),
            "valid": {"start": iso(issued), "end": iso(valid_end)},
            "lead_hours": lead_hours,
            "source_age_seconds": max(0, int((_now() - issued).total_seconds())),
            "bounds": list(ASEAN_BBOX),
        }
    }
    return url_format, None, (iso(issued), iso(valid_end)), source, _probe_wms_access(url_format)


FLOOD_LAYERS: tuple[Layer, ...] = (
    Layer(
        layer_id="potential_depth",
        label="Potential flood water",
        description=(
            "Terrain reached by the selected water level above nearest drainage across "
            "Southeast Asia, from GLO-30 HAND. Colours show scenario depth (selected "
            "stage minus HAND), not observed water, a forecast or a hazard rating."
        ),
        kind="static",
        dated=False,
        unit="m",
        attribution="ASF Global 30 m HAND v1 (CC0), derived from Copernicus GLO-30",
        legend=[
            {"label": "0–<0.5 m deep", "color": "#22c55e"},
            {"label": "0.5–<1 m deep", "color": "#2563eb"},
            {"label": "1–<2 m deep", "color": "#facc15"},
            {"label": "≥2 m deep", "color": "#dc2626"},
        ],
        temporal_kind="scenario",
        bounds=ASEAN_BBOX,
    ),
    Layer(
        layer_id="flood_extent",
        label="Flood extent",
        description=(
            "Water screened from the selected Sentinel-1, Sentinel-2 or Landsat "
            "imagery, minus JRC permanent water. Optical results are screening "
            "masks, not calibrated multi-sensor fusion. Gray means no usable "
            "local observation."
        ),
        kind="ee",
        attribution=(
            "Copernicus Sentinel-1 and Sentinel-2 · USGS/NASA Landsat 8/9 · "
            "JRC Global Surface Water"
        ),
        legend=[
            {"label": "possible flood", "color": "#e63946"},
            {"label": "no usable sensor observation", "color": "#808080"},
        ],
        builder=build_flood_extent,
        bounds=ASEAN_BBOX,
        sensors=FLOOD_EXTENT_SENSORS,
    ),
    Layer(
        layer_id="daily_water",
        label="Daily water (fused)",
        description=(
            "Sentinel-1 and optical imagery fused through a harmonic model at 30 m "
            "for the Klang Valley only, so a date with no radar pass still has an "
            "answer. Must be exported per date by data/prepare_dswfp.py before it "
            "can be drawn."
        ),
        kind="ee",
        attribution="HYDRAFloods DSWFP · Copernicus Sentinel-1 · Sentinel-2/Landsat",
        legend=[{"label": "flooded", "color": "#e63946"}],
        builder=build_daily_water,
        requires_env=DSWFP_ROOT_ENV,
    ),
    Layer(
        layer_id="surface_water",
        label="Surface water",
        description=(
            "Everything Sentinel-1 read as water in this window, rivers and reservoirs "
            "included. Radar can also read smooth dry surfaces as water."
        ),
        kind="ee",
        attribution="Copernicus Sentinel-1 · HYDRAFloods edge_otsu",
        legend=[{"label": "water", "color": "#3d7fd4"}],
        builder=build_surface_water,
        bounds=MALAYSIA_BBOX,
        needs_hydrafloods=True,
    ),
    Layer(
        layer_id="permanent_water",
        label="Permanent water",
        description=(
            f"Pixels wet at least {PERMANENT_WATER_OCCURRENCE}% of the time in the JRC "
            "record. Context for the two layers above, not a flood reading."
        ),
        kind="ee",
        dated=False,
        attribution="JRC Global Surface Water v1.4",
        legend=[{"label": "normally wet", "color": "#1d4e89"}],
        builder=build_permanent_water,
    ),
    Layer(
        layer_id="glofas_flood_outlook",
        label="GloFAS river flood outlook · days 1–3",
        description=(
            "Latest daily CEMS GloFAS river-discharge outlook. Colours combine "
            "ensemble exceedance of 2-, 5- and 20-year return-period thresholds; "
            "lighter shades mean lower confidence. This is not local flash-flood "
            "coverage, inundation depth or a replacement for official warnings."
        ),
        kind="wms",
        dated=False,
        attribution="Generated using Copernicus Emergency Management Service information (2026)",
        legend=[
            {"label": ">20% chance of ≥2 y", "color": "#f4f4a5"},
            {"label": "2–5 y", "color": "#f2e42a"},
            {"label": "5–20 y", "color": "#f84a4a"},
            {"label": ">20 y", "color": "#e266e2"},
        ],
        temporal_kind="forecast",
        bounds=ASEAN_BBOX,
        resolver=_resolve_glofas,
    ),
    Layer(
        layer_id="glofas_rapid_flood_extent",
        label="GloFAS rapid flood mapping · next 30 days",
        description=(
            "Experimental 1 km CEMS estimate of potentially inundated land where maximum "
            "ensemble-median GloFAS discharge in the 30-day forecast exceeds a 10-year "
            "return period, matched to modelled inundation maps. Data are only generated "
            "for basins greater than 5,000 km²; flood defences are not included. Not "
            "local or flash flooding, event timing, probability, depth or an official warning."
        ),
        kind="wms",
        dated=False,
        attribution="Generated using Copernicus Emergency Management Service information (2026)",
        legend=[{"label": "modelled potential inundation", "color": "#72b2ff"}],
        temporal_kind="forecast",
        bounds=ASEAN_BBOX,
        resolver=_resolve_glofas,
    ),
    Layer(
        layer_id="forecast_rainfall_24h",
        label="Forecast rainfall · next 24 h",
        description=(
            "Rainfall from the latest complete NOAA GFS model run. This is a "
            "ASEAN-wide forecast driver, not predicted flood extent or depth."
        ),
        kind="ee",
        dated=False,
        unit="mm",
        attribution="NOAA/NCEP Global Forecast System 0.25°",
        legend=[
            {"label": "1 mm", "color": "#c7e9f0"},
            {"label": "100 mm", "color": "#2c7fb8"},
            {"label": "200 mm+", "color": "#8b1e8b"},
        ],
        builder=build_forecast_rainfall,
        temporal_kind="forecast",
        bounds=ASEAN_BBOX,
    ),
    Layer(
        layer_id="precipitation",
        label="Rainfall",
        description=(
            "GSMaP rainfall over the latest complete trailing 24 hours at or before "
            "the selected date. Rain leads "
            "flooding by a day or two — the storm that flooded the Klang Valley "
            "fell on 17-18 Dec 2021, by which time the water shown on the 20th "
            "was already standing. Expect them to peak on different dates."
        ),
        kind="ee",
        unit="mm",
        attribution="JAXA GSMaP v8 (gauge-calibrated)",
        legend=[
            {"label": "1 mm", "color": "#c7e9f0"},
            {"label": "100 mm", "color": "#2c7fb8"},
            {"label": "200 mm+", "color": "#8b1e8b"},
        ],
        builder=build_precipitation,
    ),
    Layer(
        layer_id="s1_backscatter",
        label="Raw radar",
        description=(
            "Sentinel-1 VV backscatter in dB, the input to the radar screening "
            "layers. Dark is smooth — open water, wet roads, some roofs."
        ),
        kind="ee",
        unit="dB",
        attribution="Copernicus Sentinel-1 GRD",
        legend=[{"label": "-25 dB", "color": "#000000"}, {"label": "0 dB", "color": "#ffffff"}],
        builder=build_s1_backscatter,
        bounds=MALAYSIA_BBOX,
        needs_hydrafloods=True,
    ),
)

BY_ID = {layer.layer_id: layer for layer in FLOOD_LAYERS}










def _xml_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _glofas_run_from_capabilities(document: bytes, source_layer: str) -> datetime:
    """Read the source-selected latest run for one GloFAS WMS layer."""
    try:
        root = ET.fromstring(document)
    except ET.ParseError as error:
        raise LayerUnavailable(f"GloFAS returned invalid GetCapabilities XML ({error})") from error

    for node in root.iter():
        if _xml_name(node.tag) != "Layer":
            continue
        name = next(
            (child.text for child in node if _xml_name(child.tag) == "Name"),
            None,
        )
        if name != source_layer:
            continue
        extent = next(
            (
                child
                for child in node
                if _xml_name(child.tag) == "Extent" and child.attrib.get("name") == "time"
            ),
            None,
        )
        raw = extent.attrib.get("default", "") if extent is not None else ""
        try:
            issued = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            if issued.tzinfo is None:
                raise ValueError("timezone missing")
            return issued.astimezone(timezone.utc)
        except ValueError as error:
            raise LayerUnavailable(f"GloFAS advertised an invalid default time {raw!r}") from error

    raise LayerUnavailable(f"GloFAS GetCapabilities has no {source_layer!r} layer")


def _latest_glofas_run(source_layer: str) -> datetime:
    request = urllib.request.Request(
        GLOFAS_CAPABILITIES_URL,
        headers={"User-Agent": "starlink-flood-map/1.0"},
    )
    try:
        with urllib.request.urlopen(
            request, timeout=PROBE_TIMEOUT_SECONDS, context=_ssl_context()
        ) as response:
            document = response.read(GLOFAS_CAPABILITIES_MAX_BYTES + 1)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise LayerUnavailable(f"GloFAS GetCapabilities is unavailable ({error})") from error
    if len(document) > GLOFAS_CAPABILITIES_MAX_BYTES:
        raise LayerUnavailable("GloFAS GetCapabilities exceeded the 2 MB safety limit")

    issued = _glofas_run_from_capabilities(document, source_layer)
    age = _now() - issued
    if age < -timedelta(hours=1):
        raise LayerUnavailable(f"GloFAS latest run is unexpectedly in the future ({iso(issued)})")
    if age > timedelta(hours=GLOFAS_MAX_RUN_AGE_HOURS):
        raise LayerUnavailable(
            f"latest GloFAS run is {age.total_seconds() / 3600:.1f} h old; "
            f"refusing data older than {GLOFAS_MAX_RUN_AGE_HOURS} h"
        )
    return issued


def _glofas_tile_url(issued: datetime, source_layer: str) -> str:
    time = issued.strftime("%Y-%m-%dT%H:%MZ")
    return (
        f"{GLOFAS_WMS_URL}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1"
        f"&LAYERS={source_layer}&STYLES=default&FORMAT=image/png&TRANSPARENT=true"
        f"&SRS=EPSG:3857&WIDTH=256&HEIGHT=256&TIME={time}"
        "&BBOX={bbox-epsg-3857}"
    )












