"""Nearest mapped station across saved OSM tiles, separate from grid proximity.

Distances use station nodes or the centre of an area's bounding box. They do
not identify the utility supplying a tower, a cable route, or unmapped stations.
"""
from __future__ import annotations

from functools import lru_cache
import json
import math
from pathlib import Path

from data.prepare_pilot_dataset import element_paths
from model.fallback import haversine_km

CACHE_DIR = Path(__file__).resolve().parents[3] / "data/malaysia/cache/osm"
# Same query halo as prepare_malaysia_dataset.distance_fields; retained caches
# contain no bbox metadata, so this documents their producer's spatial extent.
OSM_PAD_DEGREES = 0.05


@lru_cache(maxsize=64)
def _stations(path: Path, modified_ns: int) -> tuple[list[dict], str | None]:
    """Cache parsed station points; file modification invalidates a saved tile."""
    payload = json.loads(path.read_text())
    if not isinstance(payload, dict) or "remark" in payload or not isinstance(payload.get("elements"), list):
        raise ValueError("Incomplete OSM cache")
    stations = []
    for element in payload["elements"]:
        if not isinstance(element, dict):
            continue
        tags = element.get("tags", {})
        if not isinstance(tags, dict) or tags.get("power") not in {"substation", "plant"}:
            continue
        try:
            points = [point for path in element_paths(element) for point in path]
            if not points or not all(
                math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90
                for lon, lat in points
            ):
                continue
            lons, lats = zip(*points)
            stations.append({
                "osm_id": f"{element['type']}/{element['id']}",
                "name": tags.get("name") or tags.get("name:en") or None,
                "kind": tags["power"],
                "lon": (min(lons) + max(lons)) / 2,
                "lat": (min(lats) + max(lats)) / 2,
            })
        except (KeyError, TypeError, ValueError):
            continue
    metadata = payload.get("osm3s") or {}
    source_date = metadata.get("timestamp_osm_base") if isinstance(metadata, dict) else None
    return stations, source_date if isinstance(source_date, str) else None


def nearest_power_station(tower: dict) -> dict:
    """A missing tile or station is unavailable evidence, never zero distance."""
    result = {
        "tower_id": tower["tower_id"],
        "status": "unavailable",
        "station": None,
        "source": "OpenStreetMap contributors / ODbL",
        "source_updated_at": None,
        "coverage_bounds": None,
        "detail": "Station data unavailable for this location.",
    }
    if not all(math.isfinite(tower[key]) for key in ("lon", "lat")):
        return result
    candidates = {}
    for path in sorted(CACHE_DIR.glob("infra_*_*.json")):
        try:
            _, tx, ty = path.stem.split("_")
            tx, ty = int(tx), int(ty)
            stations, source_date = _stations(path, path.stat().st_mtime_ns)
        except (OSError, ValueError):
            continue
        west, south = tx - OSM_PAD_DEGREES, ty - OSM_PAD_DEGREES
        east, north = tx + 1 + OSM_PAD_DEGREES, ty + 1 + OSM_PAD_DEGREES
        if result["coverage_bounds"] is None and west <= tower["lon"] <= east and south <= tower["lat"] <= north:
            # This box confirms coverage AT THE TOWER; it is not an envelope
            # implying continuous data across the gaps between saved tiles.
            result["coverage_bounds"] = [west, south, east, north]
        for station in stations:
            previous = candidates.get(station["osm_id"])
            if previous is None or (source_date or "") > (previous[1] or ""):
                candidates[station["osm_id"]] = (station, source_date)
    if result["coverage_bounds"] is None:
        return result
    if not candidates:
        result["detail"] = "No mapped station with usable coordinates in the saved coverage."
        return result
    # ponytail: scan ~6k saved stations; add a spatial index if the estate grows.
    station, source_date = min(candidates.values(), key=lambda item: haversine_km(tower, item[0]))
    result.update(
        status="available",
        station={**station, "distance_m": round(haversine_km(tower, station) * 1000)},
        source_updated_at=source_date,
        detail="Nearest mapped station across saved tiles; straight-line distance to its mapped centre, not a verified supply connection.",
    )
    return result
