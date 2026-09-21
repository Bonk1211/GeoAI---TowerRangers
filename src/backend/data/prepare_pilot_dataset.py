"""Build the source-backed Sunway/Klang Valley tower-risk pilot dataset.

The build combines a CC BY 4.0 Malaysian cellular measurement archive with
Copernicus GLO-30 terrain, ASF GLO-30 HAND, OpenStreetMap infrastructure, and
WorldPop 2025 exposure.  It retains the provider payloads, derives one row per
anonymous operator/site, and writes explicit quality/provenance reports.

Lightning and installation age are deliberately left null: public lightning
climatologies are too coarse to distinguish sites inside this small AOI (and
the NASA download requires Earthdata authentication), while first observation
is not an installation date.  The output therefore supports the four grounded
core fields without silently manufacturing the two unavailable fields.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import math
import re
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

DATASET_ID = "dx5xyyfz2y"
DATASET_VERSION = 1
DATASET_DOI = "10.17632/dx5xyyfz2y.1"
MENDELEY_PAGE = f"https://data.mendeley.com/datasets/{DATASET_ID}/{DATASET_VERSION}"
MENDELEY_FILES = (
    f"https://data.mendeley.com/public-api/datasets/{DATASET_ID}/files"
    f"?folder_id=root&version={DATASET_VERSION}"
)
MENDELEY_ZIP = (
    f"https://data.mendeley.com/public-api/zip/{DATASET_ID}/download/"
    f"{DATASET_VERSION}"
)
PC_STAC_SEARCH = "https://planetarycomputer.microsoft.com/api/stac/v1/search"
PC_DATA = "https://planetarycomputer.microsoft.com/api/data/v1/item"
COPDEM_COLLECTION = "cop-dem-glo-30"
HAND_SAMPLES = (
    "https://gis.asf.alaska.edu/arcgis/rest/services/GlobalHAND/"
    "GLO30_HAND/ImageServer/getSamples"
)
OVERPASS = "https://overpass-api.de/api/interpreter"
WORLDPOP = "https://api.worldpop.org/v2"
USER_AGENT = "starlink-tower-risk-pilot/1.0 (source-backed research dataset)"

MODEL_COLUMNS = (
    "tower_id", "lon", "lat", "radio", "dist_water_m", "hand_m",
    "slope_deg", "tri", "flash_density", "dist_power_m", "age_years",
    "exposed_pop",
)


class SourceError(RuntimeError):
    """Raised when a provider response violates the expected data contract."""


def _ssl_context() -> ssl.SSLContext:
    paths = ssl.get_default_verify_paths()
    cafile = paths.cafile
    if (not cafile or not Path(cafile).exists()) and Path("/etc/ssl/cert.pem").exists():
        cafile = "/etc/ssl/cert.pem"
    return ssl.create_default_context(cafile=cafile)


def request_bytes(
    url: str,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 180,
    attempts: int = 4,
) -> bytes:
    request_headers = {"User-Agent": USER_AGENT, **(headers or {})}
    for attempt in range(attempts):
        try:
            request = urllib.request.Request(
                url, data=data, headers=request_headers,
                method="POST" if data is not None else "GET",
            )
            with urllib.request.urlopen(
                request, timeout=timeout, context=_ssl_context()
            ) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code not in {429, 500, 502, 503, 504} or attempt + 1 == attempts:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt + 1 == attempts:
                raise
        time.sleep(2**attempt)
    raise AssertionError("unreachable")


def post_form(url: str, values: dict[str, str], timeout: int = 180) -> bytes:
    return request_bytes(
        url,
        data=urllib.parse.urlencode(values).encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=timeout,
    )


def post_json(url: str, value: dict, timeout: int = 60) -> dict:
    payload = request_bytes(
        url,
        data=json.dumps(value, separators=(",", ":")).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        timeout=timeout,
    )
    return json.loads(payload)


def cached(
    path: Path,
    fetcher,
    refresh: bool,
) -> bytes:
    if path.exists() and not refresh:
        return path.read_bytes()
    payload = fetcher()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return payload


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def stable_coordinate(lon: float, lat: float) -> str:
    return f"{lon:.7f},{lat:.7f}"


def download_mendeley(cache: Path, output: Path, refresh: bool) -> tuple[pd.DataFrame, dict]:
    manifest_payload = cached(
        cache / "mendeley_files.json",
        lambda: request_bytes(
            MENDELEY_FILES,
            headers={"Accept": "application/vnd.mendeley-public-dataset.1+json"},
        ),
        refresh,
    )
    file_records = json.loads(manifest_payload)
    if not isinstance(file_records, list) or len(file_records) != 4:
        raise SourceError("Mendeley file manifest no longer contains four files")
    expected_names = {
        "raw_dataset.csv", "processed_dataset.csv", "preprocessing.py", "README.txt"
    }
    if {item["filename"] for item in file_records} != expected_names:
        raise SourceError("Mendeley archive file set changed")

    archive = cached(
        cache / "sunway_dataset.zip",
        lambda: request_bytes(MENDELEY_ZIP, timeout=300),
        refresh,
    )
    raw_dir = output / "raw" / "mendeley"
    raw_dir.mkdir(parents=True, exist_ok=True)
    extracted = {}
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        by_basename = {Path(name).name: name for name in bundle.namelist() if not name.endswith("/")}
        if set(by_basename) != expected_names:
            raise SourceError("Mendeley ZIP content does not match its public manifest")
        for record in file_records:
            name = record["filename"]
            payload = bundle.read(by_basename[name])
            expected_hash = record["content_details"]["sha256_hash"]
            if sha256_bytes(payload) != expected_hash:
                raise SourceError(f"Mendeley hash mismatch for {name}")
            target = raw_dir / name
            target.write_bytes(payload)
            extracted[name] = {
                "bytes": len(payload),
                "sha256": expected_hash,
            }
    (output / "raw" / "mendeley_files.json").write_bytes(manifest_payload)

    raw = pd.read_csv(raw_dir / "raw_dataset.csv")
    processed = pd.read_csv(raw_dir / "processed_dataset.csv")
    if raw.shape != (30925, 51):
        raise SourceError(f"unexpected raw Sunway shape: {raw.shape}")
    if len(processed) != len(raw):
        raise SourceError("processed and raw Sunway row counts differ")
    return raw, {
        "archive_sha256": sha256_bytes(archive),
        "files": extracted,
        "raw_rows": len(raw),
        "raw_columns": len(raw.columns),
        "processed_rows": len(processed),
    }


def derive_sites(raw: pd.DataFrame) -> pd.DataFrame:
    required = {
        "Timestamp", "Operatorname", "Node", "NetworkTech", "Node_Longitude",
        "Node_Latitude", "SessionID", "Level", "Accuracy",
    }
    if missing := sorted(required - set(raw.columns)):
        raise SourceError(f"Sunway raw dataset is missing columns: {missing}")
    if raw[list(required)].drop(columns=["Level", "Accuracy"]).isna().any().any():
        raise SourceError("Sunway site identifiers or coordinates contain nulls")

    rows = []
    grouped = raw.groupby(["Operatorname", "Node"], sort=True, dropna=False)
    for (operator, node), group in grouped:
        coordinates = group[["Node_Longitude", "Node_Latitude"]].drop_duplicates()
        if len(coordinates) != 1:
            raise SourceError(f"site {operator}/{node} has unstable node coordinates")
        tech = sorted(group["NetworkTech"].dropna().unique())
        unsupported = set(tech) - {"4G", "5G"}
        if unsupported:
            raise SourceError(f"unsupported radio technologies: {sorted(unsupported)}")
        radio = "NR" if "5G" in tech else "LTE"
        node_text = str(int(node)) if float(node).is_integer() else str(node)
        operator_code = re.sub(r"[^A-Za-z0-9]+", "_", str(operator)).strip("_").upper()
        rows.append({
            "tower_id": f"SUNWAY_{operator_code}_{node_text.replace('.', '_')}",
            "anonymous_operator": operator,
            "source_node": node_text,
            "lon": float(coordinates.iloc[0]["Node_Longitude"]),
            "lat": float(coordinates.iloc[0]["Node_Latitude"]),
            "radio": radio,
            "technologies_observed": "|".join(tech),
            "measurement_count": len(group),
            "session_count": int(group["SessionID"].nunique()),
            "first_observed": group["Timestamp"].min(),
            "last_observed": group["Timestamp"].max(),
            "median_signal_level": float(group["Level"].median()),
            "median_gps_accuracy_m": float(group["Accuracy"].median()),
        })
    sites = pd.DataFrame(rows).sort_values("tower_id").reset_index(drop=True)
    if len(sites) != 132 or sites["tower_id"].duplicated().any():
        raise SourceError(f"expected 132 unique operator-sites, found {len(sites)}")
    if not sites["lon"].between(-180, 180).all() or not sites["lat"].between(-90, 90).all():
        raise SourceError("invalid site coordinates")
    return sites


def site_bounds(sites: pd.DataFrame, padding_degrees: float) -> tuple[float, float, float, float]:
    return (
        float(sites.lon.min() - padding_degrees),
        float(sites.lat.min() - padding_degrees),
        float(sites.lon.max() + padding_degrees),
        float(sites.lat.max() + padding_degrees),
    )


def fetch_dem(
    sites: pd.DataFrame, cache: Path, output: Path, refresh: bool
) -> tuple[np.ndarray, tuple[float, float, float, float], str]:
    bounds = site_bounds(sites, 0.0025)
    params = urllib.parse.urlencode({
        "collections": COPDEM_COLLECTION,
        "bbox": ",".join(f"{value:.7f}" for value in bounds),
        "limit": 10,
    })
    search = json.loads(cached(
        cache / "copdem_search.json",
        lambda: request_bytes(f"{PC_STAC_SEARCH}?{params}"),
        refresh,
    ))
    features = search.get("features", [])
    if len(features) != 1:
        raise SourceError(f"expected one Copernicus DEM tile, found {len(features)}")
    item = features[0]["id"]
    width = max(3, math.ceil((bounds[2] - bounds[0]) * 3600))
    height = max(3, math.ceil((bounds[3] - bounds[1]) * 3600))
    url = (
        f"{PC_DATA}/bbox/{bounds[0]:.7f},{bounds[1]:.7f},"
        f"{bounds[2]:.7f},{bounds[3]:.7f}/{width}x{height}.npy?"
        + urllib.parse.urlencode({
            "collection": COPDEM_COLLECTION,
            "item": item,
            "assets": "data",
            "return_mask": "false",
            "resampling": "bilinear",
        })
    )
    payload = cached(
        cache / "sunway_dem.npy", lambda: request_bytes(url), refresh
    )
    array = np.load(io.BytesIO(payload))
    if array.shape != (1, height, width) or not np.isfinite(array).all():
        raise SourceError(f"invalid Copernicus DEM array: {array.shape}")
    raw_path = output / "raw" / "copernicus_dem.npy"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(payload)
    write_json(output / "raw" / "copernicus_dem_metadata.json", {
        "collection": COPDEM_COLLECTION,
        "item": item,
        "bounds_wgs84": bounds,
        "shape": list(array.shape),
        "source_url": url,
    })
    return array[0], bounds, item


def terrain_arrays(
    dem: np.ndarray, bounds: tuple[float, float, float, float]
) -> tuple[np.ndarray, np.ndarray]:
    minx, miny, maxx, maxy = bounds
    height, width = dem.shape
    latitude = (miny + maxy) / 2
    dx = (maxx - minx) * 111_320 * math.cos(math.radians(latitude)) / width
    dy = (maxy - miny) * 110_574 / height
    grad_y, grad_x = np.gradient(dem.astype(float), dy, dx)
    slope = np.degrees(np.arctan(np.hypot(grad_x, grad_y)))
    padded = np.pad(dem.astype(float), 1, mode="edge")
    tri_squared = np.zeros_like(dem, dtype=float)
    for row_delta in range(3):
        for col_delta in range(3):
            if row_delta == 1 and col_delta == 1:
                continue
            neighbor = padded[
                row_delta:row_delta + height,
                col_delta:col_delta + width,
            ]
            tri_squared += (neighbor - dem) ** 2
    return slope, np.sqrt(tri_squared)


def sample_array(
    array: np.ndarray,
    lon: pd.Series,
    lat: pd.Series,
    bounds: tuple[float, float, float, float],
) -> np.ndarray:
    minx, miny, maxx, maxy = bounds
    height, width = array.shape
    columns = np.floor((lon.to_numpy() - minx) / (maxx - minx) * width).astype(int)
    rows = np.floor((maxy - lat.to_numpy()) / (maxy - miny) * height).astype(int)
    columns = np.clip(columns, 0, width - 1)
    rows = np.clip(rows, 0, height - 1)
    return array[rows, columns]


def fetch_hand(
    sites: pd.DataFrame, cache: Path, output: Path, refresh: bool
) -> dict[str, float]:
    unique = sites[["lon", "lat"]].drop_duplicates().sort_values(["lon", "lat"])
    coordinates = unique.to_records(index=False).tolist()

    def load() -> bytes:
        samples = []
        for start in range(0, len(coordinates), 40):
            points = coordinates[start:start + 40]
            geometry = {
                "points": [[float(lon), float(lat)] for lon, lat in points],
                "spatialReference": {"wkid": 4326},
            }
            response = json.loads(post_form(HAND_SAMPLES, {
                "geometry": json.dumps(geometry, separators=(",", ":")),
                "geometryType": "esriGeometryMultipoint",
                "returnFirstValueOnly": "true",
                "f": "json",
            }))
            if "error" in response:
                raise SourceError(f"ASF HAND error: {response['error']}")
            samples.extend(response.get("samples", []))
        return json.dumps({"samples": samples}, separators=(",", ":")).encode()

    payload = cached(cache / "hand_samples.json", load, refresh)
    response = json.loads(payload)
    result = {}
    for sample in response.get("samples", []):
        location = sample["location"]
        value = float(sample["value"])
        if not math.isfinite(value) or value < 0:
            raise SourceError(f"invalid HAND value: {value}")
        result[stable_coordinate(location["x"], location["y"])] = value
    if len(result) != len(coordinates):
        raise SourceError(
            f"HAND returned {len(result)} coordinate values for {len(coordinates)} sites"
        )
    raw_path = output / "raw" / "asf_hand_samples.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(payload)
    return result


def overpass_query(bounds: tuple[float, float, float, float]) -> str:
    west, south, east, north = bounds
    bbox = f"({south:.7f},{west:.7f},{north:.7f},{east:.7f})"
    return (
        "[out:json][timeout:180];("
        f'way["waterway"~"^(river|stream|canal|drain|ditch)$"]{bbox};'
        f'nwr["natural"="water"]{bbox};'
        f'way["power"~"^(line|minor_line|cable)$"]{bbox};'
        f'nwr["power"~"^(substation|plant|generator)$"]{bbox};'
        f'nwr["communication:mobile_phone"]{bbox};'
        f'nwr["man_made"~"^(mast|tower|communications_tower)$"]'
        f'["tower:type"="communication"]{bbox};'
        f'nwr["man_made"="communications_tower"]{bbox};'
        ");out geom tags;"
    )


def fetch_osm(
    sites: pd.DataFrame, cache: Path, output: Path, refresh: bool
) -> tuple[dict, tuple[float, float, float, float]]:
    bounds = site_bounds(sites, 0.05)
    payload = cached(
        cache / "osm_infrastructure.json",
        lambda: post_form(OVERPASS, {"data": overpass_query(bounds)}, timeout=240),
        refresh,
    )
    osm = json.loads(payload)
    if "remark" in osm:
        raise SourceError(f"Overpass returned a remark: {osm['remark']}")
    if not osm.get("elements"):
        raise SourceError("Overpass returned no infrastructure elements")
    raw_path = output / "raw" / "osm_infrastructure.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(payload)
    return osm, bounds


def is_water(tags: dict) -> bool:
    return "waterway" in tags or tags.get("natural") == "water" or "water" in tags


def is_power(tags: dict) -> bool:
    return tags.get("power") in {
        "line", "minor_line", "cable", "substation", "plant", "generator"
    }


def is_communications(tags: dict) -> bool:
    return (
        "communication:mobile_phone" in tags
        or tags.get("man_made") in {"mast", "tower", "communications_tower"}
    )


def element_paths(element: dict) -> list[list[tuple[float, float]]]:
    if element["type"] == "node" and "lon" in element:
        return [[(float(element["lon"]), float(element["lat"]))]]
    if "geometry" in element:
        return [[(float(p["lon"]), float(p["lat"])) for p in element["geometry"]]]
    paths = []
    for member in element.get("members", []):
        if "geometry" in member:
            paths.append([
                (float(point["lon"]), float(point["lat"]))
                for point in member["geometry"]
            ])
    return [path for path in paths if path]


def point_in_polygon(point: tuple[float, float], polygon: list[tuple[float, float]]) -> bool:
    x, y = point
    inside = False
    for index in range(len(polygon) - 1):
        x1, y1 = polygon[index]
        x2, y2 = polygon[index + 1]
        crosses = (y1 > y) != (y2 > y)
        if crosses and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def distance_to_paths_m(
    lon: float,
    lat: float,
    paths: list[tuple[list[tuple[float, float]], bool]],
) -> float:
    x_scale = 111_320 * math.cos(math.radians(lat))
    y_scale = 110_574
    best = math.inf
    for path, polygon in paths:
        if polygon and len(path) >= 4 and point_in_polygon((lon, lat), path):
            return 0.0
        projected = [((x - lon) * x_scale, (y - lat) * y_scale) for x, y in path]
        if len(projected) == 1:
            best = min(best, math.hypot(*projected[0]))
            continue
        for (x1, y1), (x2, y2) in zip(projected, projected[1:]):
            dx, dy = x2 - x1, y2 - y1
            denominator = dx * dx + dy * dy
            if denominator == 0:
                distance = math.hypot(x1, y1)
            else:
                t = max(0.0, min(1.0, -(x1 * dx + y1 * dy) / denominator))
                distance = math.hypot(x1 + t * dx, y1 + t * dy)
            best = min(best, distance)
    if not math.isfinite(best):
        raise SourceError("no usable OSM geometry available for distance calculation")
    return best


def osm_layers(osm: dict) -> tuple[list, list, pd.DataFrame, dict]:
    water_paths, power_paths, communications = [], [], []
    counts = {"water": 0, "power": 0, "communications": 0}
    for element in osm["elements"]:
        tags = element.get("tags", {})
        paths = element_paths(element)
        if is_water(tags):
            counts["water"] += 1
            polygon = tags.get("natural") == "water" or "water" in tags
            water_paths.extend((path, polygon and path[0] == path[-1]) for path in paths)
        if is_power(tags):
            counts["power"] += 1
            polygon = tags.get("power") in {"substation", "plant", "generator"}
            power_paths.extend((path, polygon and path[0] == path[-1]) for path in paths)
        if is_communications(tags):
            counts["communications"] += 1
            for path in paths[:1]:
                lon = sum(point[0] for point in path) / len(path)
                lat = sum(point[1] for point in path) / len(path)
                communications.append({
                    "osm_type": element["type"],
                    "osm_id": element["id"],
                    "lon": lon,
                    "lat": lat,
                    "name": tags.get("name", ""),
                    "operator": tags.get("operator", ""),
                    "man_made": tags.get("man_made", ""),
                    "mobile_phone": tags.get("communication:mobile_phone", ""),
                    "tags_json": json.dumps(tags, sort_keys=True, ensure_ascii=False),
                })
    return water_paths, power_paths, pd.DataFrame(communications), counts


def exposure_polygon(lon: float, lat: float, half_side_m: float = 500) -> dict:
    dy = half_side_m / 110_574
    dx = half_side_m / (111_320 * math.cos(math.radians(lat)))
    ring = [
        [lon - dx, lat - dy], [lon + dx, lat - dy],
        [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


def worldpop_one(lon: float, lat: float) -> dict:
    submission = post_json(f"{WORLDPOP}/population", {
        "geojson": exposure_polygon(lon, lat),
        "year": 2025,
        "resolution": "100m",
    })
    task_id = submission.get("task_id")
    if not task_id:
        raise SourceError(f"WorldPop submission failed: {submission}")
    for attempt in range(30):
        status = json.loads(request_bytes(f"{WORLDPOP}/tasks/{task_id}", timeout=60))
        state = str(status.get("status", "")).lower()
        if state == "success":
            return status
        if state in {"failure", "failed", "revoked"}:
            raise SourceError(f"WorldPop task failed: {status}")
        time.sleep(min(1 + attempt / 5, 4))
    raise SourceError(f"WorldPop task timed out: {task_id}")


def fetch_worldpop(
    sites: pd.DataFrame,
    cache: Path,
    output: Path,
    refresh: bool,
    workers: int,
) -> dict[str, float]:
    cache_path = cache / "worldpop_exposure.json"
    partial_path = cache / "worldpop_exposure.partial.json"
    if cache_path.exists() and not refresh:
        payload = cache_path.read_bytes()
    else:
        unique = sites[["lon", "lat"]].drop_duplicates().sort_values(["lon", "lat"])
        coordinates = unique.to_records(index=False).tolist()
        results = {}
        if partial_path.exists() and not refresh:
            results = json.loads(partial_path.read_bytes())
        remaining = [
            (float(lon), float(lat)) for lon, lat in coordinates
            if stable_coordinate(float(lon), float(lat)) not in results
        ]
        with ThreadPoolExecutor(max_workers=workers) as executor:
            pending = {
                executor.submit(worldpop_one, float(lon), float(lat)): (float(lon), float(lat))
                for lon, lat in remaining
            }
            for future in as_completed(pending):
                lon, lat = pending[future]
                try:
                    results[stable_coordinate(lon, lat)] = future.result()
                finally:
                    partial_path.parent.mkdir(parents=True, exist_ok=True)
                    partial_path.write_text(
                        json.dumps(results, separators=(",", ":"), sort_keys=True),
                        encoding="utf-8",
                    )
        payload = json.dumps(results, separators=(",", ":"), sort_keys=True).encode()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(payload)
    records = json.loads(payload)
    exposure = {}
    for key, record in records.items():
        result = record.get("result") or {}
        value = float(result.get("total_population", math.nan))
        if not math.isfinite(value) or value < 0:
            raise SourceError(f"invalid WorldPop result for {key}: {record}")
        if result.get("data_year") != 2025:
            raise SourceError(f"unexpected WorldPop year for {key}: {result}")
        exposure[key] = value
    expected = sites[["lon", "lat"]].drop_duplicates().shape[0]
    if len(exposure) != expected:
        raise SourceError(f"WorldPop returned {len(exposure)} results for {expected} sites")
    raw_path = output / "raw" / "worldpop_exposure.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_bytes(payload)
    return exposure


def source_registry() -> list[dict]:
    return [
        {
            "source_id": "sunway-cellular-2025", "used": True,
            "name": "An Urban Multi-Operator QoE-Aware Dataset",
            "url": MENDELEY_PAGE, "version": "1 (2025-06-16)", "license": "CC BY 4.0",
            "model_columns": "tower_id|lon|lat|radio", "grain": "measurement; derived operator-site",
            "coverage": "2 km² around Sunway University, Selangor; 2024-12 to 2025-04",
            "quality_note": "132 anonymous operator-node combinations; node positions are centroid-estimated and source-validated with OpenCellID/field inspection.",
        },
        {
            "source_id": "cop-dem-glo-30", "used": True,
            "name": "Copernicus DEM GLO-30 Public (2021)",
            "url": "https://registry.opendata.aws/copernicus-dem/", "version": "2021",
            "license": "Copernicus DEM licence (free basis)",
            "model_columns": "slope_deg|tri", "grain": "30 m raster",
            "coverage": "Sunway AOI window", "quality_note": "DSM includes vegetation/buildings; terrain derivatives use a 3x3 neighborhood.",
        },
        {
            "source_id": "glo-30-hand", "used": True,
            "name": "Global 30m Height Above Nearest Drainage",
            "url": "https://registry.opendata.aws/glo-30-hand/", "version": "v1 / Copernicus 2021",
            "license": "CC0 1.0", "model_columns": "hand_m", "grain": "30 m raster sample",
            "coverage": "every unique Sunway site coordinate", "quality_note": "Provider ImageServer samples retained verbatim.",
        },
        {
            "source_id": "osm-live", "used": True,
            "name": "OpenStreetMap infrastructure via Overpass",
            "url": "https://www.openstreetmap.org/copyright",
            "version": "live extract; timestamp in quality_report.json",
            "license": "ODbL 1.0; © OpenStreetMap contributors",
            "model_columns": "dist_water_m|dist_power_m", "grain": "OSM node/way/relation geometry",
            "coverage": "site envelope plus ~5.5 km", "quality_note": "Community completeness varies; raw response timestamp is retained.",
        },
        {
            "source_id": "worldpop-r2025a", "used": True,
            "name": "WorldPop Malaysia 2025 constrained population",
            "url": "https://hub.worldpop.org/geodata/summary?id=74271", "version": "R2025A v1",
            "license": "CC BY 4.0; cite DOI 10.5258/SOTON/WP00839",
            "model_columns": "exposed_pop", "grain": "2025 population summed in a 1 km square around each site",
            "coverage": "every unique Sunway site coordinate", "quality_note": "100 m alpha population estimates; value is exposure context, not a tower attribute.",
        },
        {
            "source_id": "nasa-lis-vhrfc", "used": False,
            "name": "NASA LIS 0.1° Very High Resolution Full Climatology",
            "url": "https://ghrc.nsstc.nasa.gov/pub/lis/climatology/LIS/VHRFC/", "version": "V1",
            "license": "US Government work / NASA open data; Earthdata login required",
            "model_columns": "flash_density", "grain": "0.1° climatology cell",
            "coverage": "global tropics", "quality_note": "Not used: one cell cannot distinguish this ~2 km AOI and download requires user authentication.",
        },
        {
            "source_id": "opencellid-mcc502", "used": False,
            "name": "OpenCellID Malaysia MCC 502 export", "url": "https://opencellid.org/downloads",
            "version": "daily / trailing 18 months", "license": "CC BY-SA 4.0",
            "model_columns": "tower_id|lon|lat|radio", "grain": "radio cell",
            "coverage": "Malaysia", "quality_note": "Preferred ASEAN-scale source, but a registered API token is required; Sunway CC BY data is used for this pilot.",
        },
        {
            "source_id": "jrc-gsw-1-4", "used": False,
            "name": "JRC Global Surface Water v1.4", "url": "https://global-surface-water.appspot.com/",
            "version": "1984-2021", "license": "Copernicus, free with attribution",
            "model_columns": "dist_water_m", "grain": "30 m raster",
            "coverage": "global", "quality_note": "Recommended sensitivity layer; OSM vector distance is used in the present build.",
        },
        {
            "source_id": "overture-buildings", "used": False,
            "name": "Overture Maps buildings", "url": "https://docs.overturemaps.org/guides/buildings/",
            "version": "monthly release", "license": "per-theme/upstream attribution terms",
            "model_columns": "exposure cross-check", "grain": "building footprint",
            "coverage": "global", "quality_note": "Recommended exposure QA against WorldPop; not a population substitute.",
        },
        {
            "source_id": "ghsl-age-r2025a", "used": False,
            "name": "GHSL GHS-AGE R2025A", "url": "https://data.europa.eu/doi/10.2905/JRC.YCNTMNG",
            "version": "R2025A", "license": "CC BY 4.0", "model_columns": "none",
            "grain": "100 m dominant built-stock age", "coverage": "global",
            "quality_note": "Rejected as tower age: surrounding building-stock age is not equipment installation age.",
        },
    ]


def validate_features(features: pd.DataFrame) -> dict:
    if features["tower_id"].duplicated().any():
        raise SourceError("duplicate tower IDs in feature table")
    nonnegative = (
        "dist_water_m", "hand_m", "slope_deg", "tri", "dist_power_m", "exposed_pop"
    )
    invalid = {
        column: int((features[column].isna() | (features[column] < 0)).sum())
        for column in nonnegative
    }
    if any(invalid.values()):
        raise SourceError(f"invalid populated model fields: {invalid}")
    missing = {column: int(features[column].isna().sum()) for column in MODEL_COLUMNS}
    expected_missing = {"flash_density": len(features), "age_years": len(features)}
    actual_missing = {key: value for key, value in missing.items() if value}
    if actual_missing != expected_missing:
        raise SourceError(f"unexpected model missingness: {actual_missing}")
    return {
        "rows": len(features),
        "unique_tower_ids": int(features.tower_id.nunique()),
        "duplicate_tower_ids": int(features.tower_id.duplicated().sum()),
        "model_contract_complete": False,
        "missing_by_model_column": missing,
        "intentional_unresolved_fields": {
            "flash_density": "not usable at this AOI grain without authenticated NASA acquisition",
            "age_years": "no tower installation-date source; first observation is not installation",
        },
        "numeric_ranges": {
            column: {
                "min": round(float(features[column].min()), 6),
                "max": round(float(features[column].max()), 6),
            }
            for column in nonnegative
        },
    }


def prepare(args) -> dict:
    output = args.output.resolve()
    cache = args.cache_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)

    raw, mendeley_quality = download_mendeley(cache, output, args.refresh)
    sites = derive_sites(raw)
    dem, dem_bounds, dem_item = fetch_dem(sites, cache, output, args.refresh)
    slope, tri = terrain_arrays(dem, dem_bounds)
    hand = fetch_hand(sites, cache, output, args.refresh)
    osm, osm_bounds = fetch_osm(sites, cache, output, args.refresh)
    water_paths, power_paths, communications, osm_counts = osm_layers(osm)
    exposure = fetch_worldpop(
        sites, cache, output, args.refresh, args.worldpop_workers
    )

    features = sites.copy()
    features["elevation_m"] = sample_array(dem, sites.lon, sites.lat, dem_bounds)
    features["slope_deg"] = sample_array(slope, sites.lon, sites.lat, dem_bounds)
    features["tri"] = sample_array(tri, sites.lon, sites.lat, dem_bounds)
    features["hand_m"] = [
        hand[stable_coordinate(lon, lat)] for lon, lat in zip(sites.lon, sites.lat)
    ]
    features["dist_water_m"] = [
        distance_to_paths_m(lon, lat, water_paths)
        for lon, lat in zip(sites.lon, sites.lat)
    ]
    features["dist_power_m"] = [
        distance_to_paths_m(lon, lat, power_paths)
        for lon, lat in zip(sites.lon, sites.lat)
    ]
    features["exposed_pop"] = [
        exposure[stable_coordinate(lon, lat)] for lon, lat in zip(sites.lon, sites.lat)
    ]
    features["exposure_definition"] = "WorldPop 2025 total in 1 km square centered on site"
    features["flash_density"] = np.nan
    features["flash_density_status"] = "not_used_coarser_than_aoi_and_login_required"
    features["age_years"] = np.nan
    features["age_status"] = "unknown_not_imputed"
    features["tower_source"] = DATASET_DOI
    features["terrain_source"] = f"{COPDEM_COLLECTION}/{dem_item}"
    features["hand_source"] = "ASF GLO-30 HAND v1"
    features["water_power_source"] = "OpenStreetMap contributors / ODbL"
    features["population_source"] = "WorldPop R2025A 2025 100m"

    quality = validate_features(features)
    timestamp = osm.get("osm3s", {}).get("timestamp_osm_base")
    quality.update({
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "aoi": {
            "name": "Sunway University dense urban cellular pilot, Selangor, Malaysia",
            "measurement_bounds_wgs84": [
                float(raw.Longitude.min()), float(raw.Latitude.min()),
                float(raw.Longitude.max()), float(raw.Latitude.max()),
            ],
            "site_bounds_wgs84": [
                float(sites.lon.min()), float(sites.lat.min()),
                float(sites.lon.max()), float(sites.lat.max()),
            ],
        },
        "mendeley": mendeley_quality,
        "sites": {
            "operator_sites": len(sites),
            "physical_coordinate_locations": int(
                sites[["lon", "lat"]].drop_duplicates().shape[0]
            ),
            "operators_anonymized": int(sites.anonymous_operator.nunique()),
            "measurement_rows": len(raw),
            "duplicate_full_measurement_rows": int(raw.duplicated().sum()),
            "first_measurement": str(raw.Timestamp.min()),
            "last_measurement": str(raw.Timestamp.max()),
            "sessions": int(raw.SessionID.nunique()),
            "technology_counts_measurements": {
                str(key): int(value) for key, value in raw.NetworkTech.value_counts().items()
            },
            "radio_counts_sites": {
                str(key): int(value) for key, value in features.radio.value_counts().items()
            },
        },
        "osm": {
            "timestamp": timestamp,
            "bounds_wgs84": osm_bounds,
            "elements": len(osm["elements"]),
            "classified_elements": osm_counts,
            "water_geometry_paths": len(water_paths),
            "power_geometry_paths": len(power_paths),
        },
        "worldpop": {
            "unique_queries": len(exposure),
            "year": 2025,
            "resolution": "100m",
            "aggregation": "1 km square centered on site",
        },
    })

    sites.to_csv(output / "operator_sites.csv", index=False, lineterminator="\n")
    features.to_csv(
        output / "tower_feature_table.csv", index=False, lineterminator="\n",
        columns=[*MODEL_COLUMNS, *[c for c in features if c not in MODEL_COLUMNS]],
    )
    if communications.empty:
        communications = pd.DataFrame(columns=[
            "osm_type", "osm_id", "lon", "lat", "name", "operator",
            "man_made", "mobile_phone", "tags_json",
        ])
    communications.to_csv(
        output / "osm_communications.csv", index=False, lineterminator="\n"
    )
    pd.DataFrame(source_registry()).to_csv(
        output / "source_registry.csv", index=False, lineterminator="\n"
    )
    write_json(output / "quality_report.json", quality)

    tracked = [
        path for path in sorted(output.rglob("*"))
        if path.is_file() and path.name != "manifest.json"
    ]
    manifest = {
        "title": "Sunway source-backed tower health risk pilot dataset",
        "generated_at": quality["generated_at"],
        "aoi": quality["aoi"],
        "model_contract_complete": False,
        "ready_fields": [
            "tower_id", "lon", "lat", "radio", "dist_water_m", "hand_m",
            "slope_deg", "tri", "dist_power_m", "exposed_pop",
        ],
        "unresolved_fields": ["flash_density", "age_years"],
        "files": {
            str(path.relative_to(output)): {
                "bytes": path.stat().st_size,
                "sha256": sha256_file(path),
            }
            for path in tracked
        },
        "attribution": [
            "Kabeer, M., Nordin, R., Behjati, M. (2025), DOI 10.17632/dx5xyyfz2y.1 (CC BY 4.0).",
            "Copernicus DEM GLO-30 Public, accessed through Microsoft Planetary Computer.",
            "Global 30m HAND © 2022 Alaska Satellite Facility, CC0 1.0.",
            "© OpenStreetMap contributors; data available under ODbL 1.0.",
            "WorldPop R2025A Malaysia 2025, DOI 10.5258/SOTON/WP00839.",
        ],
        "limitations": [
            "Operator names are anonymized and node positions are source-estimated centroids, not an operator asset register.",
            "OpenStreetMap infrastructure completeness varies; distances mean nearest mapped feature.",
            "WorldPop exposure is an estimated 2025 population within a 1 km square, not a count of affected subscribers.",
            "Copernicus GLO-30 is a surface model; buildings and vegetation can affect local slope/TRI.",
            "Lightning is intentionally not imputed; tower installation age is unknown.",
            "No outage/failure labels are present. This supports an interpretable index, not predictive-accuracy claims.",
        ],
    }
    write_json(output / "manifest.json", manifest)
    return quality


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--output", type=Path, default=Path("data/pilot_sunway"),
        help="output directory (default: data/pilot_sunway)",
    )
    result.add_argument(
        "--cache-dir", type=Path, default=Path(".cache/pilot_sunway"),
        help="download cache (default: .cache/pilot_sunway)",
    )
    result.add_argument("--refresh", action="store_true", help="ignore cached payloads")
    result.add_argument(
        "--worldpop-workers", type=int, default=4,
        help="concurrent WorldPop requests (default: 4)",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not 1 <= args.worldpop_workers <= 8:
        print("--worldpop-workers must be between 1 and 8", file=sys.stderr)
        return 2
    try:
        quality = prepare(args)
    except (
        SourceError, urllib.error.URLError, urllib.error.HTTPError,
        json.JSONDecodeError, zipfile.BadZipFile,
    ) as error:
        print(f"pilot dataset preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(quality, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
