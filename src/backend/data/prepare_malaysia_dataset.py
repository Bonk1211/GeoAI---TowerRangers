"""Producer: a Malaysia-wide tower feature table, same §1 contract as the pilot.

    python3 src/backend/data/prepare_malaysia_dataset.py

Writes data/malaysia/{tower_feature_table.csv, osm_towers.csv, manifest.json,
quality_report.json}. Attribution lives in the manifest rather than a separate
source_registry.csv: every row here draws on the same four sources, so a
per-row registry would repeat one line 1,164 times.

WHY THIS EXISTS. data/pilot_sunway/tower_feature_table.csv holds 132 towers
inside a 5.7 km^2 box. Every quantitative claim the project has had to withdraw
traces to that box: the risk index is compressed there (p50 ~ 0.95, IQR 0.10)
because the AOI really is flat, and model/signal_performance.py returned a null
result whose diagnosis was "the fix is a wider AOI, not a better estimator".
This producer is that wider AOI. It is the same six-factor feature table over
every communication tower OpenStreetMap has in Malaysia, across 16 states and
about 7 degrees of latitude, so that factors which cannot vary inside Sunway
(terrain, above all) have room to.

WHAT IS AND IS NOT NEW HERE. Nothing about the *model* changes: this is
perception (phases A+B) at national extent, and model/risk_index.py consumes
the output unchanged. The tower positions are OSM's, not an operator asset
register, and OSM completeness varies by state — Selangor is mapped far more
densely than Sarawak, so tower *counts* per state are a statement about
OpenStreetMap, not about telecom deployment. Nothing downstream may read a
count here as coverage.

STILL NO FAILURE LABELS. This table carries no outage, no fault and no
maintenance record, exactly as the pilot carries none. It supports an
interpretable index. Ground truth for the flood factor arrives separately, from
observed inundation, in prepare_flood_labels.py — see that file for why an
observed-water label is admissible where a failure label is not.

REQUEST BUDGET, AND WHY IT IS SHAPED THIS WAY. Naive per-tower sampling would
be ~1200 requests per raster source. Instead:
  * Copernicus DEM is fetched as one window per occupied 0.1 deg subcell,
    clamped to the 1 deg DEM tile that contains it, so slope and TRI are
    computed on a real neighbourhood rather than sampled per point.
  * OpenStreetMap water and power come one request per occupied 1 deg tile
    (~25 requests), and nearest-distance is then answered from a KD-tree over
    vertices densified to <=30 m. Nearest-vertex stands in for nearest-point on
    segment; densification bounds that substitution's error at ~15 m, which is
    far inside the 150 m decay scale water distance feeds.
  * ASF HAND is a multipoint sample, 40 points per request.
Every response is cached under --cache-dir, so a re-run costs nothing.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.path import Path as MplPath
from scipy.spatial import cKDTree

from prepare_pilot_dataset import (
    MODEL_COLUMNS,
    OVERPASS,
    PC_DATA,
    PC_STAC_SEARCH,
    COPDEM_COLLECTION,
    HAND_SAMPLES,
    SourceError,
    cached,
    element_paths,
    is_power,
    is_water,
    post_form,
    request_bytes,
    sample_array,
    sha256_bytes,
    stable_coordinate,
    terrain_arrays,
    write_json,
)

GEOBOUNDARIES = "https://www.geoboundaries.org/api/current/gbOpen/MYS/ADM1/"

# Malaysia spans peninsula and Borneo; the gap between them is sea, and the
# tile loop only ever visits tiles that actually contain a tower.
MALAYSIA_BBOX = (98.9, 0.5, 119.5, 7.6)

SUBCELL_DEGREES = 0.1     # DEM window size; 0.11 deg at 1 arcsec is ~400x400 px
OSM_PAD_DEGREES = 0.05    # water/power search halo around each 1 deg tile
DENSIFY_METRES = 30.0     # KD-tree vertex spacing, bounds nearest-vertex error
DEDUPE_METRES = 25.0      # a tower mapped as both a node and a way footprint

# OSM radio hints are sparse and inconsistently cased. Highest-generation tag
# present wins, because EQUIP in risk_index.py reads radio as "newest equipment
# on the mast" — a site carrying NR is not a GSM-era refresh risk.
RADIO_TAGS = (
    ("NR", ("communication:5g", "communication:5G")),
    ("LTE", ("communication:lte", "communication:LTE", "communication:4g",
             "communication:4G", "communication:4g+", "communication:4G+")),
    ("UMTS", ("communication:3g", "communication:3G", "communication:umts")),
    ("GSM", ("communication:2g", "communication:2G", "communication:gsm")),
)
TRUTHY = {"yes", "true", "1"}


# --- boundaries -----------------------------------------------------------
def fetch_states(cache: Path, refresh: bool) -> dict:
    """geoBoundaries ADM1 -> {state name: [ring, ...]} in lon/lat.

    States are the spatial holdout groups everything downstream splits on, so
    they are fetched here rather than derived from coordinates. A tower's state
    is a property of the tower, not of the evaluation that later uses it.
    """
    meta = json.loads(cached(
        cache / "geoboundaries_mys_adm1_meta.json",
        lambda: request_bytes(GEOBOUNDARIES), refresh))
    payload = cached(
        cache / "geoboundaries_mys_adm1.geojson",
        lambda: request_bytes(meta["gjDownloadURL"], timeout=180), refresh)
    collection = json.loads(payload)
    states: dict[str, list] = {}
    for feature in collection["features"]:
        name = feature["properties"]["shapeName"]
        geometry = feature["geometry"]
        polygons = (
            geometry["coordinates"] if geometry["type"] == "MultiPolygon"
            else [geometry["coordinates"]]
        )
        # Outer ring only. Holes here are enclaves between states, and a point
        # in one is still in Malaysia; dropping them costs a handful of border
        # towers a state label and never invents one.
        states[name] = [
            [(float(x), float(y)) for x, y in polygon[0]] for polygon in polygons
        ]
    if len(states) < 13:
        raise SourceError(f"expected >=13 Malaysian states, got {len(states)}")
    return states


def assign_states(lon: np.ndarray, lat: np.ndarray, states: dict) -> np.ndarray:
    """Vectorised point-in-polygon. matplotlib's Path is the one already-present
    dependency that does this in C; a Python ray cast over 1200 towers x ~200k
    boundary vertices would not finish in reasonable time."""
    out = np.full(len(lon), "", dtype=object)
    points = np.column_stack([lon, lat])
    # Smallest state first. Kuala Lumpur, Putrajaya and Labuan are enclaves
    # wholly inside another state, and fetch_states keeps outer rings only, so
    # a KL tower falls inside BOTH Kuala Lumpur and the Selangor ring that
    # surrounds it. Testing in file order gave it whichever came first in the
    # GeoJSON — Selangor — which is wrong on a screen that labels towers by
    # territory and wrong for dispatch, since crews.json rosters Kuala Lumpur
    # separately. Ordering by bounding-box area lets the enclave claim its own
    # points before the surrounding state is ever tested.
    def ring_span(rings):
        # max, not min: a state's size is its largest part. Selangor is a
        # MultiPolygon whose smallest ring is an offshore islet with a tinier
        # bounding box than the whole of Kuala Lumpur, so taking the minimum
        # sorted Selangor first and handed it the 38 KL towers anyway.
        return max((r[:, 0].max() - r[:, 0].min()) * (r[:, 1].max() - r[:, 1].min())
                   for r in (np.asarray(ring) for ring in rings))

    for name, rings in sorted(states.items(), key=lambda kv: ring_span(kv[1])):
        for ring in rings:
            array = np.asarray(ring)
            box = (
                (points[:, 0] >= array[:, 0].min()) & (points[:, 0] <= array[:, 0].max())
                & (points[:, 1] >= array[:, 1].min()) & (points[:, 1] <= array[:, 1].max())
            )
            candidates = np.flatnonzero(box & (out == ""))
            if not len(candidates):
                continue
            hit = MplPath(array).contains_points(points[candidates])
            out[candidates[hit]] = name
    return out


# --- towers ---------------------------------------------------------------
def tower_query() -> str:
    mast_tower = '["man_made"~"^(mast|tower|communications_tower)$"]'
    return (
        "[out:json][timeout:600];"
        'area["ISO3166-1"="MY"][admin_level=2]->.my;('
        f'nwr{mast_tower}["tower:type"="communication"](area.my);'
        'nwr["man_made"="communications_tower"](area.my);'
        'nwr["communication:mobile_phone"](area.my);'
        'nwr["man_made"="mast"](area.my);'
        ");out center tags;"
    )


def radio_from_tags(tags: dict) -> str:
    """Newest generation the tags claim, else UNKNOWN.

    UNKNOWN is a string, not NaN, on purpose: risk_index.check_schema forbids
    NaN outside age_years, and EQUIP.map(...).fillna(0.5) already gives an
    unlabelled mast the neutral equipment membership. Writing UNKNOWN keeps
    "we do not know" visible in the CSV instead of hiding inside a default.
    """
    for radio, keys in RADIO_TAGS:
        for key in keys:
            if str(tags.get(key, "")).lower() in TRUTHY:
                return radio
    return "UNKNOWN"


def fetch_towers(cache: Path, output: Path, refresh: bool) -> pd.DataFrame:
    payload = cached(
        cache / "osm_towers.json",
        lambda: overpass_post(tower_query()),
        refresh,
    )
    osm = json.loads(payload)
    if "remark" in osm:
        raise SourceError(f"Overpass returned a remark: {osm['remark']}")
    rows = []
    for element in osm.get("elements", []):
        tags = element.get("tags", {})
        if element["type"] == "node":
            lon, lat = element.get("lon"), element.get("lat")
        else:
            centre = element.get("center") or {}
            lon, lat = centre.get("lon"), centre.get("lat")
        if lon is None or lat is None:
            continue
        rows.append({
            "osm_type": element["type"],
            "osm_id": int(element["id"]),
            "lon": float(lon),
            "lat": float(lat),
            "man_made": tags.get("man_made", ""),
            "tower_type": tags.get("tower:type", ""),
            "operator": tags.get("operator", ""),
            "name": tags.get("name", ""),
            "radio": radio_from_tags(tags),
            "mobile_phone": str(tags.get("communication:mobile_phone", "")),
            "tags_json": json.dumps(tags, sort_keys=True, ensure_ascii=False),
        })
    if not rows:
        raise SourceError("Overpass returned no Malaysian towers")
    towers = pd.DataFrame(rows)
    towers = dedupe_towers(towers)
    towers = towers.sort_values(["lon", "lat"]).reset_index(drop=True)
    towers["tower_id"] = [
        f"MY_{row.osm_type[0].upper()}{row.osm_id}" for row in towers.itertuples()
    ]
    raw = output / "raw" / "osm_towers.json"
    raw.parent.mkdir(parents=True, exist_ok=True)
    raw.write_bytes(payload)
    return towers


def dedupe_towers(towers: pd.DataFrame) -> pd.DataFrame:
    """Collapse a tower mapped twice (node inside its own way footprint).

    Grid-snap then KD-tree within DEDUPE_METRES. The way is kept over the node
    when both exist, because the way carries the structure's footprint and
    therefore the better centre.
    """
    if len(towers) < 2:
        return towers
    lat0 = float(towers.lat.mean())
    xy = np.column_stack([
        towers.lon.to_numpy() * 111_320 * math.cos(math.radians(lat0)),
        towers.lat.to_numpy() * 110_574,
    ])
    tree = cKDTree(xy)
    keep = np.ones(len(towers), dtype=bool)
    # Ways first, so a way always claims the cluster before its node is tested:
    # the way carries the footprint, so its centre is the better position.
    order = np.argsort((towers.osm_type == "node").to_numpy(), kind="stable")
    for i in order:
        if not keep[i]:
            continue
        for j in tree.query_ball_point(xy[i], DEDUPE_METRES):
            if j != i:
                keep[j] = False
    return towers[keep].copy()


# --- Copernicus DEM: slope, TRI, elevation --------------------------------
def dem_item(tile: tuple[int, int], cache: Path, refresh: bool) -> str:
    """STAC item id for the 1 deg GLO-30 tile whose lower-left corner is `tile`."""
    lon, lat = tile
    params = urllib.parse.urlencode({
        "collections": COPDEM_COLLECTION,
        "bbox": f"{lon + 0.5:.4f},{lat + 0.5:.4f},{lon + 0.5001:.4f},{lat + 0.5001:.4f}",
        "limit": 5,
    })
    search = json.loads(cached(
        cache / "dem" / f"item_{lon}_{lat}.json",
        lambda: request_bytes(f"{PC_STAC_SEARCH}?{params}"), refresh))
    features = search.get("features", [])
    if not features:
        raise SourceError(f"no Copernicus DEM tile covering {tile}")
    return features[0]["id"]


def dem_window(item: str, bounds: tuple[float, float, float, float],
               cache: Path, refresh: bool) -> np.ndarray:
    width = max(8, math.ceil((bounds[2] - bounds[0]) * 3600))
    height = max(8, math.ceil((bounds[3] - bounds[1]) * 3600))
    url = (
        f"{PC_DATA}/bbox/{bounds[0]:.6f},{bounds[1]:.6f},{bounds[2]:.6f},{bounds[3]:.6f}"
        f"/{width}x{height}.npy?" + urllib.parse.urlencode({
            "collection": COPDEM_COLLECTION, "item": item, "assets": "data",
            "return_mask": "false", "resampling": "bilinear",
        })
    )
    # Width and height belong in the key. They are pure functions of `bounds`,
    # but the key carried only the ORIGIN, so two requests sharing a min-x/min-y
    # and differing in span returned each other's array — silently, at the wrong
    # shape, with no error. It never bit this module, which only ever asks for one
    # span; it bit the first caller that reused these helpers at a different scale.
    key = f"{item}_{bounds[0]:.4f}_{bounds[1]:.4f}_{width}x{height}.npy"
    payload = cached(cache / "dem" / key,
                     lambda: request_bytes(url, timeout=180), refresh)
    array = np.load(io.BytesIO(payload))
    if array.ndim != 3 or array.shape[0] != 1:
        raise SourceError(f"unexpected Copernicus DEM array shape {array.shape}")
    return array[0].astype(float)


def terrain_at_points(points: pd.DataFrame, cache: Path, refresh: bool,
                      workers: int) -> pd.DataFrame:
    """slope_deg, tri and elevation_m for every point, one DEM window per
    occupied subcell. Windows are clamped to their 1 deg DEM tile so a window
    never straddles two items, which would silently mix two rasters."""
    lon = points.lon.to_numpy()
    lat = points.lat.to_numpy()
    tiles = np.column_stack([np.floor(lon).astype(int), np.floor(lat).astype(int)])
    sub = np.column_stack([
        np.floor(lon / SUBCELL_DEGREES).astype(int),
        np.floor(lat / SUBCELL_DEGREES).astype(int),
    ])
    groups: dict[tuple, list[int]] = defaultdict(list)
    for i in range(len(points)):
        groups[(tiles[i, 0], tiles[i, 1], sub[i, 0], sub[i, 1])].append(i)

    items = {}
    for tx, ty, _, _ in groups:
        if (tx, ty) not in items:
            items[(tx, ty)] = dem_item((tx, ty), cache, refresh)

    out = np.full((len(points), 3), np.nan)

    def one(key):
        tx, ty, sx, sy = key
        pad = SUBCELL_DEGREES / 10
        bounds = (
            max(tx, sx * SUBCELL_DEGREES - pad),
            max(ty, sy * SUBCELL_DEGREES - pad),
            min(tx + 1, (sx + 1) * SUBCELL_DEGREES + pad),
            min(ty + 1, (sy + 1) * SUBCELL_DEGREES + pad),
        )
        dem = dem_window(items[(tx, ty)], bounds, cache, refresh)
        slope, tri = terrain_arrays(dem, bounds)
        rows = groups[key]
        series_lon = pd.Series(lon[rows])
        series_lat = pd.Series(lat[rows])
        return rows, np.column_stack([
            sample_array(slope, series_lon, series_lat, bounds),
            sample_array(tri, series_lon, series_lat, bounds),
            sample_array(dem, series_lon, series_lat, bounds),
        ])

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(one, key): key for key in groups}
        for done, future in enumerate(as_completed(futures), 1):
            rows, values = future.result()
            out[rows] = values
            if done % 50 == 0:
                print(f"  dem {done}/{len(groups)} subcells", file=sys.stderr)

    if not np.isfinite(out).all():
        raise SourceError("Copernicus DEM sampling left gaps")
    return pd.DataFrame(out, columns=["slope_deg", "tri", "elevation_m"],
                        index=points.index)


# --- ASF HAND -------------------------------------------------------------
def fetch_hand(points: pd.DataFrame, cache: Path, refresh: bool,
               batch: int = 400, cache_name: str = "hand_samples.json") -> np.ndarray:
    """Multipoint HAND sample, 400 points per request.

    The pilot used 40. Measured against the live ImageServer, 500 points also
    return in 1.6 s — the request is dominated by the raster lookup, not the
    point count — so the pilot's batch size would have cost 10x the round trips
    for no gain. 400 leaves headroom under the form-encoded body size.
    """
    coordinates = list(zip(points.lon.to_numpy(), points.lat.to_numpy()))
    unique = sorted({(round(x, 7), round(y, 7)) for x, y in coordinates})

    def load() -> bytes:
        samples = []
        for start in range(0, len(unique), batch):
            chunk = unique[start:start + batch]
            geometry = {"points": [[float(x), float(y)] for x, y in chunk],
                        "spatialReference": {"wkid": 4326}}
            response = json.loads(post_form(HAND_SAMPLES, {
                "geometry": json.dumps(geometry, separators=(",", ":")),
                "geometryType": "esriGeometryMultipoint",
                "returnFirstValueOnly": "true", "f": "json",
            }, timeout=180))
            if "error" in response:
                raise SourceError(f"ASF HAND error: {response['error']}")
            samples.extend(response.get("samples", []))
            print(f"  hand {start + len(chunk)}/{len(unique)}", file=sys.stderr)
        return json.dumps({"samples": samples}, separators=(",", ":")).encode()

    response = json.loads(cached(cache / cache_name, load, refresh))
    table = {}
    for sample in response.get("samples", []):
        value = float(sample["value"])
        if not math.isfinite(value) or value < 0:
            continue
        table[stable_coordinate(sample["location"]["x"], sample["location"]["y"])] = value
    values = np.array([
        table.get(stable_coordinate(x, y), np.nan) for x, y in coordinates
    ])
    # A stale cache is the realistic way this goes wrong: a smoke run with
    # --limit writes hand_samples.json for 40 points, and a later full run
    # reads it back and finds nothing for the other 1,100. Without this guard
    # the effect is not an error but a quietly 97% smaller dataset, reported
    # only as a "dropped_no_hand" line nobody reads. ASF genuinely returns no
    # value for a few coastal points, so a small shortfall is tolerated.
    missing = float(np.isnan(values).mean())
    if missing > 0.05:
        raise SourceError(
            f"ASF HAND covered only {1 - missing:.1%} of {len(coordinates)} points "
            f"— delete {cache / cache_name} and re-run if it was written by a "
            "smaller --limit run"
        )
    return values


# --- OSM water and power distance ----------------------------------------
# Public Overpass instances answer a 1 deg box of Malaysian waterways in about
# a minute, and sometimes not at all: measured, tile 110,0 (interior Sarawak)
# returned 504 after several minutes. A gateway timeout on a heavy query is
# ordinary operation for a free endpoint, not an exceptional condition, so it is
# retried against a second instance rather than aborting a run that already
# holds an hour of cached raster sampling.
OVERPASS_ENDPOINTS = (
    OVERPASS,
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
)
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def overpass_post(query: str, timeout: int = 900, attempts: int = 6) -> bytes:
    """POST to Overpass, rotating endpoints and backing off on the statuses a
    loaded public instance actually returns."""
    last: Exception | None = None
    for attempt in range(attempts):
        endpoint = OVERPASS_ENDPOINTS[attempt % len(OVERPASS_ENDPOINTS)]
        try:
            payload = post_form(endpoint, {"data": query}, timeout=timeout)
        except urllib.error.HTTPError as error:
            if error.code not in RETRYABLE_STATUS:
                raise
            last = error
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            last = error
        else:
            # Overpass reports its own timeout as a "remark" inside a 200
            # response — the same failure wearing a success code — and appends
            # it after "elements", so the tail is where it shows up and a 20 MB
            # parse is not needed to find it.
            if b'"remark"' not in payload[-4000:]:
                return payload
            last = SourceError(f"Overpass remark from {endpoint}")
        wait = min(90, 10 * 2 ** attempt)
        print(f"    overpass retry {attempt + 1}/{attempts} in {wait}s "
              f"({type(last).__name__})", file=sys.stderr)
        time.sleep(wait)
    raise SourceError(f"Overpass failed after {attempts} attempts: {last}")


def infrastructure_query(bounds: tuple[float, float, float, float]) -> str:
    west, south, east, north = bounds
    bbox = f"({south:.5f},{west:.5f},{north:.5f},{east:.5f})"
    return (
        "[out:json][timeout:900];("
        f'way["waterway"~"^(river|stream|canal|drain|ditch)$"]{bbox};'
        f'nwr["natural"="water"]{bbox};'
        f'way["power"~"^(line|minor_line|cable)$"]{bbox};'
        f'nwr["power"~"^(substation|plant|generator)$"]{bbox};'
        ");out geom tags;"
    )


def densify(path: list[tuple[float, float]], lat0: float) -> np.ndarray:
    """Project to local metres and insert vertices so no gap exceeds
    DENSIFY_METRES. The KD-tree that consumes this answers nearest *vertex*;
    densifying is what makes that a stand-in for nearest point on segment."""
    scale_x = 111_320 * math.cos(math.radians(lat0))
    projected = np.array([[x * scale_x, y * 110_574] for x, y in path])
    if len(projected) == 1:
        return projected
    pieces = [projected[:1]]
    for a, b in zip(projected, projected[1:]):
        span = math.hypot(*(b - a))
        steps = int(span // DENSIFY_METRES)
        if steps > 0:
            fractions = np.linspace(0, 1, steps + 2)[1:, None]
            pieces.append(a + (b - a) * fractions)
        else:
            pieces.append(b[None, :])
    return np.vstack(pieces)


def distance_fields(points: pd.DataFrame, cache: Path, refresh: bool,
                    max_distance_m: float = 20_000.0) -> pd.DataFrame:
    """dist_water_m and dist_power_m, one Overpass request per occupied tile.

    Points are answered from the tile they fall in, whose query box is padded
    by OSM_PAD_DEGREES so a feature just over the tile edge is still found.
    Beyond max_distance_m the value saturates: both memberships (exp_decay at
    150 m, exp_sat at 2 km) are numerically flat long before that, so a farther
    true distance would not change any score, and pretending to resolve it
    would claim precision the padded box cannot deliver.
    """
    lon = points.lon.to_numpy()
    lat = points.lat.to_numpy()
    tiles = defaultdict(list)
    for i in range(len(points)):
        tiles[(int(math.floor(lon[i])), int(math.floor(lat[i])))].append(i)

    water = np.full(len(points), max_distance_m)
    power = np.full(len(points), max_distance_m)

    for number, ((tx, ty), rows) in enumerate(sorted(tiles.items()), 1):
        bounds = (tx - OSM_PAD_DEGREES, ty - OSM_PAD_DEGREES,
                  tx + 1 + OSM_PAD_DEGREES, ty + 1 + OSM_PAD_DEGREES)
        print(f"  osm tile {number}/{len(tiles)} {tx},{ty}", file=sys.stderr)
        payload = cached(
            cache / "osm" / f"infra_{tx}_{ty}.json",
            lambda b=bounds: overpass_post(infrastructure_query(b)),
            refresh,
        )
        osm = json.loads(payload)
        if "remark" in osm:
            raise SourceError(f"Overpass remark on tile {tx},{ty}: {osm['remark']}")
        lat0 = ty + 0.5
        buckets = {"water": [], "power": []}
        for element in osm.get("elements", []):
            tags = element.get("tags", {})
            for kind, test in (("water", is_water), ("power", is_power)):
                if test(tags):
                    for path in element_paths(element):
                        buckets[kind].append(densify(path, lat0))
        scale_x = 111_320 * math.cos(math.radians(lat0))
        query = np.column_stack([lon[rows] * scale_x, lat[rows] * 110_574])
        for kind, target in (("water", water), ("power", power)):
            if not buckets[kind]:
                continue
            tree = cKDTree(np.vstack(buckets[kind]))
            distance, _ = tree.query(query, distance_upper_bound=max_distance_m)
            target[rows] = np.minimum(np.nan_to_num(distance, posinf=max_distance_m),
                                      max_distance_m)
    return pd.DataFrame({"dist_water_m": water, "dist_power_m": power},
                        index=points.index)


# --- assembly -------------------------------------------------------------
def build_feature_table(towers: pd.DataFrame, terrain: pd.DataFrame,
                        hand: np.ndarray, distances: pd.DataFrame,
                        states: np.ndarray) -> pd.DataFrame:
    table = pd.DataFrame({
        "tower_id": towers.tower_id.to_numpy(),
        "lon": towers.lon.to_numpy(),
        "lat": towers.lat.to_numpy(),
        "radio": towers.radio.to_numpy(),
        "dist_water_m": distances.dist_water_m.to_numpy(),
        "hand_m": hand,
        "slope_deg": terrain.slope_deg.to_numpy(),
        "tri": terrain.tri.to_numpy(),
        # Unresolved for the same reasons as the pilot: the LIS/OTD lightning
        # climatology needs an authenticated NASA acquisition, and no source
        # gives tower installation dates. NaN, never an imputed number.
        "flash_density": np.nan,
        "dist_power_m": distances.dist_power_m.to_numpy(),
        "age_years": np.nan,
        # WorldPop is a per-point API call; at 1200 towers it is the slowest
        # source by an order of magnitude and it feeds no factor in
        # risk_index.memberships (exposure is consequence, not hazard). Kept in
        # the contract as NaN rather than dropped, so the column list still
        # matches the pilot's.
        "exposed_pop": np.nan,
        "elevation_m": terrain.elevation_m.to_numpy(),
        "state": states,
        "osm_type": towers.osm_type.to_numpy(),
        "osm_id": towers.osm_id.to_numpy(),
        "operator": towers.operator.to_numpy(),
        "tower_source": "OpenStreetMap contributors / ODbL",
        "terrain_source": "Copernicus DEM GLO-30 via Microsoft Planetary Computer",
        "hand_source": "ASF Global 30m HAND v1",
        "water_power_source": "OpenStreetMap contributors / ODbL",
    })
    return table[table.hand_m.notna()].reset_index(drop=True)


def quality_report(table: pd.DataFrame, dropped: int) -> dict:
    numeric = ("dist_water_m", "hand_m", "slope_deg", "tri", "dist_power_m",
               "elevation_m")
    return {
        "rows": int(len(table)),
        "dropped_no_hand": int(dropped),
        "unique_tower_ids": int(table.tower_id.nunique()),
        "states": {k: int(v) for k, v in
                   table.state.replace("", "unassigned").value_counts().items()},
        "radio": {k: int(v) for k, v in table.radio.value_counts().items()},
        "model_contract_complete": False,
        "intentional_unresolved_fields": {
            "flash_density": "LIS/OTD climatology needs authenticated NASA acquisition",
            "age_years": "no source gives tower installation dates",
            "exposed_pop": "per-point WorldPop call, and no risk factor consumes it",
        },
        "numeric_ranges": {
            column: {"min": round(float(table[column].min()), 4),
                     "max": round(float(table[column].max()), 4),
                     "median": round(float(table[column].median()), 4)}
            for column in numeric
        },
        "caveats": [
            "Tower positions are OpenStreetMap features, not an operator asset "
            "register; per-state counts describe OSM completeness, not deployment.",
            "No outage, fault or maintenance label is present anywhere in this table.",
            "Water and power distances saturate at 20 km, where both membership "
            "curves are already flat.",
        ],
    }


def prepare(args) -> dict:
    output = args.output.resolve()
    cache = args.cache_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    print("states...", file=sys.stderr)
    states = fetch_states(cache, args.refresh)
    print("towers...", file=sys.stderr)
    towers = fetch_towers(cache, output, args.refresh)
    if args.limit:
        towers = towers.head(args.limit).reset_index(drop=True)
    print(f"  {len(towers)} towers", file=sys.stderr)

    print("terrain...", file=sys.stderr)
    terrain = terrain_at_points(towers, cache, args.refresh, args.workers)
    print("hand...", file=sys.stderr)
    hand = fetch_hand(towers, cache, args.refresh)
    print("osm water/power...", file=sys.stderr)
    distances = distance_fields(towers, cache, args.refresh)
    assigned = assign_states(towers.lon.to_numpy(), towers.lat.to_numpy(), states)

    table = build_feature_table(towers, terrain, hand, distances, assigned)
    dropped = len(towers) - len(table)

    towers.to_csv(output / "osm_towers.csv", index=False)
    table.to_csv(output / "tower_feature_table.csv", index=False)
    report = quality_report(table, dropped)
    write_json(output / "quality_report.json", report)
    write_json(output / "manifest.json", {
        "title": "Malaysia-wide OpenStreetMap communication tower feature table",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "bbox_wgs84": list(MALAYSIA_BBOX),
        "model_columns": list(MODEL_COLUMNS),
        "attribution": [
            "© OpenStreetMap contributors; data available under ODbL 1.0.",
            "Copernicus DEM GLO-30 Public, accessed through Microsoft Planetary Computer.",
            "Global 30m HAND © 2022 Alaska Satellite Facility, CC0 1.0.",
            "geoBoundaries ADM1 (gbOpen), CC BY 4.0.",
        ],
        "files": {
            name: {"bytes": (output / name).stat().st_size,
                   "sha256": sha256_bytes((output / name).read_bytes())}
            for name in ("tower_feature_table.csv", "osm_towers.csv")
        },
    })
    return report


def parser() -> argparse.ArgumentParser:
    repo = Path(__file__).resolve().parents[3]
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--output", type=Path, default=repo / "data" / "malaysia")
    p.add_argument("--cache-dir", type=Path,
                   default=repo / "data" / "malaysia" / "cache")
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--limit", type=int, default=0,
                   help="only process the first N towers (smoke test)")
    p.add_argument("--refresh", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        report = prepare(args)
    except (SourceError, urllib.error.URLError, urllib.error.HTTPError,
            json.JSONDecodeError) as error:
        print(f"malaysia dataset preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
