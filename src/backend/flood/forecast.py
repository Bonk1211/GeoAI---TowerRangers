"""Per-tower weather hazard: how much the live forecast should pull a deadline in.

This is the point where the forecast layers stop being decorative. `flood/layers.py`
paints rain and soil moisture on the map; this module samples the same two Earth Engine
collections *at the tower points* and turns them into a bounded multiplier that
`scheduler/urgency.py` applies to the weather-coupled part of `urgency_days`.

It does not touch risk. The tower's condition has not changed because a storm is
forecast — only the sensible date to visit it has. Risk, decision, bands and attribution
are computed elsewhere and are unaffected by anything in this file.

Three properties the callers depend on:

Failure is None, never an exception. A forecast outage must degrade the schedule to its
baseline deadlines, not take /towers down with it. Every path out of
`sample_weather_hazard` that cannot produce an answer returns None.

None is not an empty dict. Empty means "we asked and no tower is affected"; None means
"there is no forecast in this answer at all". The UI renders those differently — the
zeroed-struct rule in CLAUDE.md, which shipped once as a stability fixture reporting
rho 0.00 in calm grey.

The multiplier only ever shortens. It is clamped to [min_multiplier, 1.0] in one place,
`multiplier_for`, which is pure and testable without a network.

GloFAS is deliberately absent. It is WMS, so a point query costs one GetFeatureInfo per
tower, but the real reason is that it is river-basin discharge return period: sampling a
basin polygon at a tower's coordinates and calling the result that tower's hazard is a
category error. It says something true about the river and nothing about the ground the
tower stands on. It stays a display layer.

This module imports three constants from `land.layers`, the first import between the two
peer layer packages. It is for SMAP's asset id, band and lookback — reproducing them here
would let the sampled value drift from the layer the operator is looking at. That is the
whole justification; it is not licence to couple these packages further.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from land.layers import SMAP_ASSET, SMAP_BAND, SMAP_LOOKBACK_DAYS
from scheduler.config_loader import load_policy
from tiles.ee_session import LayerUnavailable, initialise

# Native resolutions. Passed explicitly to reduceRegions because it otherwise
# reprojects to the output projection and the value at a tower point silently
# becomes a resampled neighbour's — the same trap as _sum_at_source_projection
# in flood/layers.py and ee.Terrain.slope in land/layers.py.
GFS_SCALE_M = 27_750  # 0.25 degrees at the equator
SMAP_SCALE_M = 9_000

_cache_lock = threading.Lock()
_cache: dict | None = None


@dataclass(frozen=True)
class WeatherHazard:
    """One tower's forecast-driven deadline multiplier, with its reason.

    `drivers` names which thresholds fired, so the drawer and the why-slot can
    say what moved a date rather than showing an unexplained number.
    """

    multiplier: float
    rain_mm_24h: float
    soil_moisture: float | None
    drivers: tuple[str, ...]
    issued_at: str  # GFS run this came from
    observed_at: str | None  # SMAP granule actually read; None when unavailable

    def to_dict(self) -> dict:
        return {
            "multiplier": self.multiplier,
            "rain_mm_24h": self.rain_mm_24h,
            "soil_moisture": self.soil_moisture,
            "drivers": list(self.drivers),
            "issued_at": self.issued_at,
            "observed_at": self.observed_at,
        }


def multiplier_for(
    rain_mm: float, soil: float | None, policy: dict
) -> tuple[float, tuple[str, ...]]:
    """Rain and soil moisture -> (multiplier, drivers). Pure; no network.

    The whole decision lives here so it can be tested without Earth Engine, and
    so the clamp is applied in exactly one place.

    Rain bands are exclusive: severe does not also count as watch. Saturated
    ground compounds with rain, because wet ground plus more rain is worse than
    either alone — the combination is what produces standing water.
    """
    cfg = policy["weather_hazard"]
    multiplier = 1.0
    drivers: list[str] = []

    if rain_mm >= cfg["rain_mm"]["severe"]:
        multiplier *= cfg["multipliers"]["severe_rain"]
        drivers.append("severe_rain")
    elif rain_mm >= cfg["rain_mm"]["watch"]:
        multiplier *= cfg["multipliers"]["watch_rain"]
        drivers.append("watch_rain")

    if soil is not None and soil >= cfg["saturated_m3m3"]:
        multiplier *= cfg["multipliers"]["saturated_ground"]
        drivers.append("saturated_ground")

    # Clamped both ways. Upper: a dry forecast earns nothing, and a config edit
    # above 1.0 must not lengthen a deadline. Lower: without a floor one storm
    # collapses every flood-dominant tower onto the same date.
    multiplier = min(1.0, max(cfg["min_multiplier"], multiplier))
    return multiplier, tuple(drivers)


def _tower_features(ee, towers):
    """One FeatureCollection of tower points — sampled in a single call.

    132 towers is two Earth Engine round trips this way and 264 the naive way.
    """
    return ee.FeatureCollection(
        [
            ee.Feature(
                ee.Geometry.Point([float(t["lon"]), float(t["lat"])]),
                {"tower_id": t["tower_id"]},
            )
            for t in towers
        ]
    )


def _sample(ee, image, points, scale: int, band: str) -> dict[str, float]:
    """reduceRegions with an explicit scale, keyed by tower_id.

    The scale is not optional — see the note on GFS_SCALE_M above.
    """
    sampled = image.reduceRegions(
        collection=points,
        reducer=ee.Reducer.first(),
        scale=scale,
    ).getInfo()
    values: dict[str, float] = {}
    for feature in sampled.get("features", []):
        properties = feature.get("properties", {})
        value = properties.get(band, properties.get("first"))
        if value is not None:
            values[properties["tower_id"]] = float(value)
    return values


def _latest_smap(ee):
    """Most recent SMAP granule and its timestamp, or (None, None).

    Reuses land/layers.py's asset, band and lookback so this cannot drift from
    the soil-moisture layer the operator sees on the map. SMAP L4 publishes
    about three days behind, which is why that lookback is a week.
    """
    now = datetime.now(timezone.utc)
    collection = (
        ee.ImageCollection(SMAP_ASSET)
        .filterDate(
            (now - timedelta(days=SMAP_LOOKBACK_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        )
        .select(SMAP_BAND)
        .sort("system:time_start", False)
    )
    stamps = collection.aggregate_array("system:time_start").getInfo()
    if not stamps:
        return None, None
    observed = datetime.fromtimestamp(max(stamps) / 1000, tz=timezone.utc)
    return collection.first(), observed.strftime("%Y-%m-%dT%H:%M:%SZ")


def sample_weather_hazard(
    towers, policy: dict | None = None
) -> dict[str, WeatherHazard] | None:
    """Per-tower hazards keyed by tower_id, or None when we could not ask.

    Returns None — not an empty dict — when the feature is switched off, when
    earthengine-api is absent, when credentials are missing, or when any part of
    the sampling fails. Callers render that as "no forecast applied", which is a
    different statement from "the forecast is quiet".

    Cached for policy.weather_hazard.cache_minutes: the GFS run is 6-hourly and
    SMAP 3-hourly, so re-sampling faster costs Earth Engine calls and returns
    the same answer.
    """
    policy = policy or load_policy()
    cfg = policy.get("weather_hazard", {})
    if not cfg.get("enabled") or not towers:
        return None

    with _cache_lock:
        if _cache is not None and _cache["expires_at"] > datetime.now(timezone.utc):
            return _cache["hazards"]

    try:
        ee = initialise()
        # Imported here, not at module scope: flood/layers.py owns GFS run
        # selection and completeness checking, and re-deriving it would let the
        # sampled rainfall disagree with the rainfall layer on the map.
        from flood.layers import _latest_gfs_rainfall

        rain_image, forecast = _latest_gfs_rainfall(ee)
        points = _tower_features(ee, towers)
        rain_by_tower = _sample(
            ee, rain_image, points, GFS_SCALE_M, "total_precipitation_surface"
        )

        soil_image, observed_at = _latest_smap(ee)
        soil_by_tower = (
            _sample(ee, soil_image, points, SMAP_SCALE_M, SMAP_BAND)
            if soil_image is not None
            else {}
        )
    except (LayerUnavailable, ImportError):
        # A configuration gap or a missing optional dependency. Not an outage,
        # and not this module's problem to report — the schedule simply keeps
        # its baseline deadlines.
        return None
    except Exception:
        # Deliberately broad. Earth Engine raises a wide family of errors and
        # none of them may reach /towers: a forecast failure must cost the
        # forecast, not the whole scored-tower response.
        return None

    hazards: dict[str, WeatherHazard] = {}
    for tower in towers:
        tower_id = tower["tower_id"]
        rain = rain_by_tower.get(tower_id)
        if rain is None:
            # Outside the forecast footprint. No reading, so no adjustment —
            # distinct from a reading of zero rain, though both leave the
            # deadline alone.
            continue
        soil = soil_by_tower.get(tower_id)
        multiplier, drivers = multiplier_for(rain, soil, policy)
        hazards[tower_id] = WeatherHazard(
            multiplier=multiplier,
            rain_mm_24h=rain,
            soil_moisture=soil,
            drivers=drivers,
            issued_at=forecast["issued_at"],
            observed_at=observed_at,
        )

    with _cache_lock:
        globals()["_cache"] = {
            "hazards": hazards,
            "expires_at": datetime.now(timezone.utc)
            + timedelta(minutes=cfg.get("cache_minutes", 30)),
        }
    return hazards


def clear_cache() -> None:
    """Drop the sampled hazards. For tests and a manual refresh."""
    with _cache_lock:
        globals()["_cache"] = None
