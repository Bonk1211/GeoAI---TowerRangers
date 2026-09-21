"""The tile engine every map layer is minted through.

Domain-free by construction: it names no dataset, no sensor and no place. A
layer is a record with a builder (Earth Engine) or a resolver (an external WMS),
and this module turns one of those plus a date into a tile URL the browser can
fetch. `flood/` and `land/` are peers on top of it and neither imports the other.

Three rules live here rather than in any domain, because getting them wrong in
one domain and right in another is how a map starts lying:

Validation runs caller-input first, then per-layer configuration, then
credentials. Initialising Earth Engine before parsing a date made a typo report
itself as "earthengine-api is not installed" and sent the reader after entirely
the wrong problem.

Map ids are cached. Minting is cheap next to tile serving, but Earth Engine
warns against creating map ids at anything like tile-fetch rates, and panning
the map would do exactly that.

A layer that cannot be drawn says so. Every response carries `tile_access`,
because a URL the browser is not allowed to fetch renders an empty overlay, logs
nothing, and looks identical to "there is nothing here".
"""

from __future__ import annotations

import math
import os
import ssl
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

from .ee_session import LayerUnavailable, initialise

# Earth Engine map ids are documented as valid for "a few hours" and callers are
# told to be resilient to expiry. An hour is comfortably inside that and means a
# long demo re-mints once rather than dying halfway through.
MAPID_TTL_SECONDS = 3600

# The tile used to ask whether a minted URL is fetchable without credentials.
#
# Zoom matters more than it looks. Earth Engine computes each tile on demand, so
# a coarse tile makes it run the whole algorithm across an enormous area: a z7
# probe over Malaysia took >30s and timed out, which the probe then reported as
# "unknown" — a local timeout masquerading as a fact about access. The same
# request at z11 over the AOI returns in under two seconds, and is also what a
# browser looking at the towers actually asks for.
PROBE_LON, PROBE_LAT, PROBE_ZOOM = 101.61, 3.07, 11
PROBE_TIMEOUT_SECONDS = 45

_cache_lock = threading.Lock()
_cache: dict[tuple[str, str, str | None], dict] = {}



@dataclass(frozen=True)
class Layer:
    layer_id: str
    label: str
    description: str
    #: 'ee' layers need Earth Engine; 'wms' resolves a live external tile source;
    #: 'static' layers are mounted directly by the frontend (local assets or a
    #: public tile service). One catalogue describes the whole stack the map can draw.
    kind: str
    attribution: str
    legend: list[dict] = field(default_factory=list)
    unit: str | None = None
    dated: bool = True
    builder: Callable | None = None
    #: Environment variable this layer cannot work without. Checked before Earth
    #: Engine is initialised, so a configuration gap reports itself as one rather
    #: than as an authentication failure — the same ordering argument as
    #: parse_date below.
    requires_env: str | None = None
    temporal_kind: str = "observation"
    bounds: tuple[float, float, float, float] | None = None
    sensors: tuple[dict[str, str], ...] = ()
    #: Only the radar layers use HYDRAFloods. Importing it unconditionally would
    #: make every layer that does not need it fail on a machine that has
    #: earthengine-api and nothing else installed.
    needs_hydrafloods: bool = False
    #: How a 'wms' layer resolves its live tile template. Keeps the tile engine
    #: from knowing which external service is behind any particular layer, the
    #: same way `builder` keeps it from knowing which dataset an 'ee' layer uses.
    resolver: Callable | None = None
    #: Which catalogue and which HUD panel this layer belongs to. The engine does
    #: not read it; it exists so one panel component can serve two domains.
    group: str = "water"

    def to_dict(self) -> dict:
        return {
            "layer_id": self.layer_id,
            "label": self.label,
            "description": self.description,
            "kind": self.kind,
            "attribution": self.attribution,
            "legend": self.legend,
            "unit": self.unit,
            "dated": self.dated,
            "temporal_kind": self.temporal_kind,
            "bounds": list(self.bounds) if self.bounds else None,
            "sensors": [dict(sensor) for sensor in self.sensors],
            "group": self.group,
        }


def iso(value: datetime) -> str:
    return value.strftime("%Y-%m-%dT%H:%M:%SZ")


def window_for(date: str, lookback_days: int) -> tuple[str, str]:
    """Inclusive-start, exclusive-end window ending the day after `date`.

    The lookback is the caller's, not this module's: revisit intervals differ by
    sensor, and a default here would silently give one domain another's cadence.
    """
    end = parse_date(date)
    start = end - timedelta(days=lookback_days)
    return start.strftime("%Y-%m-%d"), (end + timedelta(days=1)).strftime("%Y-%m-%d")


def scene_count(
    collection, sensor_label: str, start: str, end: str, region_label: str = "Southeast Asia"
) -> int:
    """Count scenes intersecting the regional bbox, not coverage at each pixel."""
    n_images = collection.size().getInfo()
    if n_images == 0:
        raise LayerUnavailable(
            f"no {sensor_label} scenes over {region_label} for {start}..{end}; "
            "try a nearby date"
        )
    return n_images


class InvalidDate(ValueError):
    """The caller sent a date this service cannot parse.

    Separate from LayerUnavailable because it is the caller's mistake, not an
    outage: retrying will never help, and the route turns it into a 400 rather
    than a 503.
    """


class InvalidSensor(ValueError):
    """The caller selected a sensor this layer does not provide."""


def parse_date(date: str) -> datetime:
    try:
        return datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as error:
        raise InvalidDate(f"date must be YYYY-MM-DD, got {date!r}") from error


def parse_sensor(layer, sensor: str) -> str:
    """Validate `sensor` against the sources this layer actually offers.

    Against the layer rather than a module-global list, because the list is not
    universal: a layer in another domain with its own source choice would
    otherwise be validated against the flood sensors and reject every valid
    request.
    """
    allowed = {item["id"] for item in layer.sensors}
    if sensor not in allowed:
        choices = ", ".join(sorted(allowed))
        raise InvalidSensor(f"sensor must be one of {choices}, got {sensor!r}")
    return sensor


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _public_payload(payload: dict) -> dict:
    result = {k: v for k, v in payload.items() if k != "expires_at_dt"}
    forecast = result.get("forecast")
    if forecast:
        issued = datetime.strptime(forecast["issued_at"], "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc
        )
        result["forecast"] = {
            **forecast,
            "source_age_seconds": max(0, int((_now() - issued).total_seconds())),
        }
    return result


def _probe_tile() -> tuple[int, int, int]:
    """Slippy-map z/x/y covering the AOI at PROBE_ZOOM."""
    n = 2**PROBE_ZOOM
    x = int((PROBE_LON + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(math.radians(PROBE_LAT))) / math.pi) / 2.0 * n)
    return PROBE_ZOOM, x, y


def _ssl_context() -> ssl.SSLContext:
    """A context with a usable CA bundle.

    Python installed from python.org on macOS ships without one wired up, so the
    default context raises CERTIFICATE_VERIFY_FAILED against every HTTPS host —
    which this probe was reporting as "unknown tile access", a local trust
    problem disguised as a fact about Earth Engine. Mirrors the same helper in
    data/prepare_pilot_dataset.py, preferring certifi when it is present.
    """
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        default = ssl.get_default_verify_paths().cafile
        if (not default or not Path(default).exists()) and Path("/etc/ssl/cert.pem").exists():
            return ssl.create_default_context(cafile="/etc/ssl/cert.pem")
        return ssl.create_default_context()


def _probe_image_access(url: str) -> str:
    try:
        with urllib.request.urlopen(
            url, timeout=PROBE_TIMEOUT_SECONDS, context=_ssl_context()
        ) as response:
            content_type = response.headers.get("Content-Type", "")
            return "public" if response.status == 200 and "image" in content_type else "requires_auth"
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise LayerUnavailable("Source tile requests are rate limited (HTTP 429)") from error
        return "requires_auth" if error.code in (401, 403) else "unknown"
    except (urllib.error.URLError, TimeoutError, OSError):
        return "unknown"


def _probe_tile_access(url_format: str) -> str:
    """Ask whether the minted tile URL is fetchable without credentials.

    Earth Engine's documentation says that without an API key the tile URL
    requires the credentials passed to ee.Initialize(). Whether a given project
    hands back publicly fetchable tiles is therefore a property of its setup, not
    something to assume — and the browser cannot tell us, because a 403 on a
    raster source renders an empty layer and fires no error anyone will see.
    Fetching one tile from here turns that into a fact the response can carry.
    """
    z, x, y = _probe_tile()
    url = url_format.format(z=z, x=x, y=y)
    return _probe_image_access(url)


def _probe_wms_access(url_format: str) -> str:
    """Probe one Web-Mercator tile after replacing MapLibre's WMS bbox token."""
    z, x, y = _probe_tile()
    half_world = 20_037_508.342789244
    span = 2 * half_world / (2**z)
    west = -half_world + x * span
    east = west + span
    north = half_world - y * span
    south = north - span
    bbox = f"{west},{south},{east},{north}"
    return _probe_image_access(url_format.replace("{bbox-epsg-3857}", bbox))


def _cache_key(layer: Layer, date: str, sensor: str | None) -> tuple[str, str, str | None]:
    return (layer.layer_id, date if layer.dated else "static", sensor)


def tiles_for(
    layer,
    date: str,
    sensor: str = "",
    *,
    refresh: bool = False,
) -> dict:
    """Resolve (or reuse) a tile URL for one layer on one date.

    Takes a resolved layer record rather than an id: the caller owns the
    catalogue and has already turned an unknown id into a 404, and this way the
    engine serves any catalogue rather than one module-global.

    Cached per layer, date and selected sensor until shortly before the map id
    expires. Minting is cheap next to tile serving, but Earth Engine warns
    against creating map ids at anything like tile-fetch rates, and panning the
    map would do exactly that.
    """
    layer_id = layer.layer_id
    if layer.kind == "static":
        raise LayerUnavailable(
            f"layer {layer_id!r} is mounted by the frontend, not the tile API"
        )

    # Before touching Earth Engine: a malformed date is not an outage, and
    # initialising first made a typo report itself as "earthengine-api is not
    # installed", which sends the reader after entirely the wrong problem.
    if layer.dated:
        parse_date(date)

    # Sensor validation belongs beside date validation: both are caller input
    # and must fail before credentials or Earth Engine availability are checked.
    selected_sensor = parse_sensor(layer, sensor) if layer.sensors else None

    # Also before Earth Engine: a layer missing its own configuration is not an
    # authentication problem, and reporting it as one sends the reader off to
    # re-check credentials that were never at fault.
    if layer.requires_env and not os.environ.get(layer.requires_env, "").strip():
        raise LayerUnavailable(
            f"{layer.requires_env} is not set, so {layer_id!r} has no output to read. "
            "Set it to a writable Earth Engine asset folder, then produce the "
            "three batch outputs with src/backend/data/prepare_dswfp.py."
        )

    key = _cache_key(layer, date, selected_sensor)
    with _cache_lock:
        hit = _cache.get(key)
        if not refresh and hit and hit["expires_at_dt"] > _now() + timedelta(minutes=5):
            return _public_payload(hit)

    if layer.kind == "wms":
        url_format, scenes, window, source, tile_access = layer.resolver(layer)
    else:
        ee = initialise()
        # Per-layer, not unconditional. Only the radar products reach HYDRAFloods,
        # and importing it for every layer made ones that never touch it fail on
        # a machine carrying earthengine-api and nothing else.
        hf = None
        if layer.needs_hydrafloods:
            try:
                import hydrafloods as hf
            except ImportError as error:
                raise LayerUnavailable(
                    f"hydrafloods is not installed ({error}). "
                    "Run: pip install -r src/backend/requirements-flood.txt"
                ) from error

        try:
            if selected_sensor:
                image, scenes, window, source = layer.builder(ee, hf, date, selected_sensor)
            else:
                image, scenes, window, source = layer.builder(ee, hf, date)
            mapid = image.getMapId({})
        except LayerUnavailable:
            raise
        except Exception as error:
            raise LayerUnavailable(
                f"Earth Engine could not build {layer_id!r} for {date}: {error}"
            ) from error

        url_format = mapid["tile_fetcher"].url_format
        tile_access = _probe_tile_access(url_format)

    expires_at = _now() + timedelta(seconds=MAPID_TTL_SECONDS)
    payload = {
        "layer_id": layer_id,
        "date": date if layer.dated else None,
        "sensor": selected_sensor,
        "tile_url": url_format,
        "tile_access": tile_access,
        "attribution": layer.attribution,
        "scenes": scenes,
        "window": {"start": window[0], "end": window[1]} if window else None,
        "observed_at": source.get("observed_at"),
        "source_count": source.get("source_count"),
        "forecast": source.get("forecast"),
        # Optional and generic: a layer whose tiles are one read of a wider
        # source snapshot can name that snapshot here, so a caller can show that
        # the raster and whatever it renders beside it describe the same window.
        # Most layers have no such thing and return None — the engine neither
        # knows nor cares which datasets do.
        "snapshot_id": source.get("snapshot_id"),
        "expires_at": expires_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    with _cache_lock:
        _cache[key] = {**payload, "expires_at_dt": expires_at}
    return _public_payload(payload)


def clear_cache() -> None:
    """Drop every minted map id. For tests and for a manual refresh."""
    with _cache_lock:
        _cache.clear()
