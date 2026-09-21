"""Producer: observed-inundation ground truth for the flood factor.

    python3 src/backend/data/prepare_flood_labels.py

Writes data/malaysia/{flood_labels_gsw.csv, flood_labels_event.csv,
flood_labels_manifest.json}.

WHY A LABEL IS ADMISSIBLE HERE AT ALL. docs/Backend_Handoff.md §0.6 forbids
fabricating a failure label, and the withdrawn maintenance classifier is what
that rule was written about: its target was a quantile cut of a deterministic
function of its own inputs, so its 0.974 AUC measured arithmetic. Nothing here
labels failure, maintenance or outage. Both labels below say one thing only —
*this ground was observed under water by a satellite* — and both come from
outside this project, produced by other people for other purposes, from sensors
the feature table never touches. That is the difference between ground truth
and a restated assumption.

WHAT IT CAN AND CANNOT SCORE. It scores flood exposure: the `flood` membership
in model/risk_index.py, built from hand_m and dist_water_m. It does not score
`equipment` or `power`, which have no inundation signature, and tuning the AHP
weights of those factors against a water label would be exactly the circularity
the classifier died of. model/flood_eval.py therefore reports the flood factor
and the full index side by side, and treats the gap as dilution to measure, not
an error to optimise away.

TWO LABEL SOURCES, WITH OPPOSITE WEAKNESSES.

1. JRC Global Surface Water v1.3 (Pekel et al. 2016), Landsat 1984-2020, 30 m,
   sampled nationwide. `occurrence` is the percentage of clear observations in
   which a pixel was water. Positive = observed under water sometimes but not
   permanently; negative = never once in 36 years. Its weakness is *what* the
   seasonal water is: in Malaysia a large share of non-permanent surface water
   is managed — paddy, aquaculture ponds, ex-mining pools, oil-palm drainage —
   and GSW cannot separate those from floodplain. So this set is large and
   nationwide but its positive class is flood-exposure-plus-wet-agriculture.

2. UNOSAT FL20191217MYS, Sentinel-1, 15 December 2019, Johor. A single real
   flood event, delineated by analysts, with the class field reading literally
   "Flood Water" and an explicit AnalysisExtent polygon that makes the negative
   class well defined — inside the analysed scene, not flooded. Its weakness is
   that it is one event, one date, one state, ~4,900 km^2, 2.0% positive.

Neither alone would carry a claim. Together they do: the confounder in (1) is
absent from (2), and the narrowness of (2) is absent from (1). model/flood_eval.py
tunes on GSW and reports (2) as a held-out event it never fitted.

EXCLUSIONS ARE PART OF THE LABEL, NOT CLEANUP. Permanent water (GSW occurrence
>= PERMANENT_OCCURRENCE) is dropped from both classes rather than counted as a
positive. Rivers and lakes are trivially "inundated" and no tower stands in
one; leaving them in would let a model score highly by finding water bodies,
which is not the question. Pixels with 0 < occurrence < NOISE_OCCURRENCE are
dropped too — at that rate a handful of misregistered Landsat scenes is a
likelier explanation than water.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import shapefile
from matplotlib.path import Path as MplPath

from prepare_pilot_dataset import (
    PC_DATA,
    PC_STAC_SEARCH,
    SourceError,
    cached,
    request_bytes,
    sha256_bytes,
    write_json,
)
from prepare_malaysia_dataset import (
    assign_states,
    distance_fields,
    fetch_hand,
    fetch_states,
    terrain_at_points,
)

GSW_COLLECTION = "jrc-gsw"
GSW_ASSETS = ("occurrence", "seasonality", "recurrence")
UNOSAT_SHP_ZIP = (
    "https://unosat-maps.web.cern.ch/unosat-maps/MY/FL20191217MYS/"
    "FL20191217MYS_SHP.zip"
)
UNOSAT_EVENT = "FL20191217MYS"

CELL_DEGREES = 0.05          # one GSW + one DEM request serves a whole cell
POINTS_PER_CELL_SIDE = 10    # 100 points per cell on a jittered lattice
PERMANENT_OCCURRENCE = 75.0  # at/above this a pixel is a water body, not a site
NOISE_OCCURRENCE = 5.0       # below this, misregistration is the better story


# --- JRC Global Surface Water --------------------------------------------
def gsw_item(lon: float, lat: float, cache: Path, refresh: bool) -> str:
    """GSW ships 10 deg tiles; one covers many cells, so this is cached by tile."""
    tile = (int(math.floor(lon / 10) * 10), int(math.floor(lat / 10) * 10))
    params = urllib.parse.urlencode({
        "collections": GSW_COLLECTION,
        "bbox": f"{lon:.4f},{lat:.4f},{lon + 0.0001:.4f},{lat + 0.0001:.4f}",
        "limit": 5,
    })
    search = json.loads(cached(
        cache / "gsw" / f"item_{tile[0]}_{tile[1]}.json",
        lambda: request_bytes(f"{PC_STAC_SEARCH}?{params}"), refresh))
    features = search.get("features", [])
    if not features:
        raise SourceError(f"no JRC GSW tile covering {lon},{lat}")
    return features[0]["id"]


def gsw_window(item: str, bounds, cache: Path, refresh: bool) -> np.ndarray:
    """(3, h, w) stack of occurrence, seasonality, recurrence at ~30 m.

    All three assets ride one request — the data API accepts repeated `assets`
    and returns them as bands, which is a third of the round trips.
    """
    width = max(8, math.ceil((bounds[2] - bounds[0]) * 3600))
    height = max(8, math.ceil((bounds[3] - bounds[1]) * 3600))
    query = [("collection", GSW_COLLECTION), ("item", item)]
    query += [("assets", asset) for asset in GSW_ASSETS]
    query += [("return_mask", "false"), ("resampling", "nearest")]
    url = (
        f"{PC_DATA}/bbox/{bounds[0]:.6f},{bounds[1]:.6f},{bounds[2]:.6f},"
        f"{bounds[3]:.6f}/{width}x{height}.npy?" + urllib.parse.urlencode(query)
    )
    # Width and height belong in the key. They are pure functions of `bounds`,
    # but the key carried only the ORIGIN, so two requests sharing a min-x/min-y
    # and differing in span returned each other's array — silently, at the wrong
    # shape, with no error. It never bit this module, which only ever asks for one
    # span; it bit the first caller that reused these helpers at a different scale.
    key = f"{item}_{bounds[0]:.4f}_{bounds[1]:.4f}_{width}x{height}.npy"
    payload = cached(cache / "gsw" / key,
                     lambda: request_bytes(url, timeout=180), refresh)
    array = np.load(io.BytesIO(payload))
    if array.shape[0] != len(GSW_ASSETS):
        raise SourceError(f"GSW returned {array.shape[0]} bands, expected 3")
    return array.astype(float)


def sample_grid(array: np.ndarray, lon: np.ndarray, lat: np.ndarray,
                bounds) -> np.ndarray:
    minx, miny, maxx, maxy = bounds
    height, width = array.shape[-2:]
    columns = np.clip(((lon - minx) / (maxx - minx) * width).astype(int), 0, width - 1)
    rows = np.clip(((maxy - lat) / (maxy - miny) * height).astype(int), 0, height - 1)
    return array[..., rows, columns]


def label_from_occurrence(occurrence: np.ndarray) -> np.ndarray:
    """1 observed inundated, 0 never observed as water, -1 excluded.

    -1 is returned rather than dropped here so the caller can report how much
    of the sample each exclusion removed. A silently shrinking denominator is
    how a 2% base rate turns into a 40% one without anyone noticing.
    """
    label = np.full(len(occurrence), -1, dtype=int)
    label[occurrence == 0] = 0
    label[(occurrence >= NOISE_OCCURRENCE) & (occurrence < PERMANENT_OCCURRENCE)] = 1
    return label


def sample_cells(states: dict, n_cells: int, seed: int) -> np.ndarray:
    """Cell corners drawn uniformly over land.

    Uniform-over-land, not uniform-over-towers: the question this set answers is
    "does the flood membership rank ground by observed inundation", and drawing
    cells where towers already are would ask it only where OpenStreetMap
    happens to be well mapped. Rejection sampling against the ADM1 polygons is
    what makes "over land" mean land rather than bounding box, which here is
    mostly the South China Sea.
    """
    rng = np.random.default_rng(seed)
    corners: list[tuple[float, float]] = []
    seen: set[tuple[int, int]] = set()
    west, south, east, north = 98.9, 0.5, 119.5, 7.6
    for _ in range(400):
        if len(corners) >= n_cells:
            break
        draw = 4 * n_cells
        lon = rng.uniform(west, east, draw)
        lat = rng.uniform(south, north, draw)
        inside = assign_states(lon, lat, states) != ""
        for x, y in zip(lon[inside], lat[inside]):
            key = (int(x / CELL_DEGREES), int(y / CELL_DEGREES))
            if key in seen:
                continue
            seen.add(key)
            corners.append((key[0] * CELL_DEGREES, key[1] * CELL_DEGREES))
            if len(corners) >= n_cells:
                break
    if len(corners) < n_cells:
        raise SourceError(f"only found {len(corners)} land cells of {n_cells}")
    return np.array(sorted(corners))


def cell_points(corners: np.ndarray, seed: int) -> pd.DataFrame:
    """A jittered lattice inside every cell.

    Jittered rather than regular: a fixed lattice at 0.00625 deg would beat
    against the 30 m raster grid and sample the same sub-pixel phase in every
    cell, which is a sampling artefact waiting to be mistaken for a result.
    """
    rng = np.random.default_rng(seed + 1)
    side = POINTS_PER_CELL_SIDE
    step = CELL_DEGREES / side
    offsets = (np.arange(side) + 0.5) * step
    grid_x, grid_y = np.meshgrid(offsets, offsets)
    flat_x, flat_y = grid_x.ravel(), grid_y.ravel()
    rows = []
    for index, (x0, y0) in enumerate(corners):
        jitter = rng.uniform(-step / 3, step / 3, (2, len(flat_x)))
        rows.append(pd.DataFrame({
            "cell_id": index,
            "lon": x0 + flat_x + jitter[0],
            "lat": y0 + flat_y + jitter[1],
        }))
    return pd.concat(rows, ignore_index=True)


# --- UNOSAT observed flood event -----------------------------------------
def unosat_paths(cache: Path, refresh: bool) -> dict[str, list[MplPath]]:
    """Compound matplotlib Paths for the analysed extent and the flood water.

    Every layer is WGS84 lon/lat already (checked: the .prj is GCS_WGS_1984),
    so there is no reprojection step to get wrong. Rings become one compound
    path per shape with CLOSEPOLY codes; matplotlib's nonzero winding rule then
    subtracts ESRI's reverse-wound holes for free, which is the whole reason for
    building a compound path instead of testing rings one at a time.
    """
    payload = cached(cache / "unosat_FL20191217MYS_shp.zip",
                     lambda: request_bytes(UNOSAT_SHP_ZIP, timeout=300), refresh)
    archive = zipfile.ZipFile(io.BytesIO(payload))
    layers: dict[str, list[MplPath]] = {"extent": [], "flood": []}
    for name in archive.namelist():
        if not name.endswith(".shp"):
            continue
        base = name[:-4]
        kind = ("extent" if "AnalysisExtent" in base
                else "flood" if "WaterExtent" in base else None)
        if kind is None:
            continue
        reader = shapefile.Reader(
            shp=io.BytesIO(archive.read(base + ".shp")),
            dbf=io.BytesIO(archive.read(base + ".dbf")),
            shx=io.BytesIO(archive.read(base + ".shx")),
        )
        fields = [f[0] for f in reader.fields[1:]]
        for record, shape in zip(reader.records(), reader.shapes()):
            if kind == "flood":
                water_class = str(record[fields.index("Water_Clas")])
                # Only analyst-declared flood water. UNOSAT ships reference and
                # permanent water in this same layer for other activations; a
                # class filter here is what keeps "flooded" from quietly
                # meaning "wet".
                if water_class.strip().lower() != "flood water":
                    continue
            parsed = compound_path(shape)
            layers[kind].append(parsed)
            declared = float(record[fields.index("Area_m2")])
            # The shapefile states its own area, so the ring parse can be
            # checked against it rather than trusted. A hole read as an outer
            # ring, or a dropped part, moves this by far more than the ~2%
            # an equirectangular area costs at these latitudes.
            if declared > 0 and abs(parsed[2] - declared) / declared > 0.05:
                raise SourceError(
                    f"{base}: parsed area {parsed[2]:.0f} m^2 disagrees with the "
                    f"shapefile's stated {declared:.0f} m^2 by more than 5%")
    if not layers["extent"] or not layers["flood"]:
        raise SourceError(f"UNOSAT package missing layers: "
                          f"{ {k: len(v) for k, v in layers.items()} }")
    return layers


def ring_area_m2(ring: np.ndarray) -> float:
    """Signed shoelace area in square metres, equirectangular at the ring's own
    latitude. Sign carries the winding, which is what tells an outer ring from
    a hole; magnitude is only ever used for the cross-check against the
    shapefile's own Area_m2 field."""
    lat0 = float(ring[:, 1].mean())
    x = ring[:, 0] * 111_320 * math.cos(math.radians(lat0))
    y = ring[:, 1] * 110_574
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def compound_path(shape) -> tuple[MplPath, MplPath | None, float]:
    """(outer rings, hole rings, area m^2) for one shapefile shape.

    Holes are separated by winding rather than left to matplotlib, because
    matplotlib does not subtract them: measured on a square with a square hole,
    Path.contains_points returns True for a point in the hole, so a compound
    path unions its subpaths instead of applying a nonzero winding rule. Left
    unhandled that would label every dry island inside a flood polygon as
    flooded — the failure would show up as a slightly optimistic recall and
    nothing else. The shapefile spec winds outer rings clockwise and holes
    counter-clockwise, which in lon/lat is a negative and a positive shoelace
    area respectively.
    """
    points = np.asarray(shape.points, dtype=float)
    starts = list(shape.parts) + [len(points)]
    outer, holes, area = [], [], 0.0
    for begin, end in zip(starts, starts[1:]):
        ring = points[begin:end]
        if len(ring) < 4:
            continue
        signed = ring_area_m2(ring)
        (holes if signed > 0 else outer).append(ring)
        area += -signed
    if not outer:
        raise SourceError("shapefile shape has no outer ring")
    return _rings_to_path(outer), (_rings_to_path(holes) if holes else None), area


def _rings_to_path(rings: list[np.ndarray]) -> MplPath:
    vertices, codes = [], []
    for ring in rings:
        vertices.append(ring)
        codes.extend([MplPath.MOVETO] + [MplPath.LINETO] * (len(ring) - 2)
                     + [MplPath.CLOSEPOLY])
    return MplPath(np.vstack(vertices), codes)


def inside_any(shapes, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """True where a point falls inside an outer ring and outside every hole."""
    points = np.column_stack([lon, lat])
    hit = np.zeros(len(points), dtype=bool)
    for outer, holes, _ in shapes:
        box = outer.get_extents()
        candidates = np.flatnonzero(
            ~hit
            & (points[:, 0] >= box.x0) & (points[:, 0] <= box.x1)
            & (points[:, 1] >= box.y0) & (points[:, 1] <= box.y1)
        )
        if not len(candidates):
            continue
        inside = candidates[outer.contains_points(points[candidates])]
        if holes is not None and len(inside):
            inside = inside[~holes.contains_points(points[inside])]
        hit[inside] = True
    return hit


def event_points(paths: dict, n_points: int, seed: int) -> pd.DataFrame:
    """Uniform points inside the analysed extent, labelled by the flood layer.

    Sampling the analysed extent rather than a bounding box is the point: the
    negative class has to mean "the analyst looked here and saw no flood", not
    "we picked somewhere the analyst never examined".
    """
    rng = np.random.default_rng(seed)
    boxes = [outer.get_extents() for outer, _, _ in paths["extent"]]
    west = min(b.x0 for b in boxes)
    east = max(b.x1 for b in boxes)
    south = min(b.y0 for b in boxes)
    north = max(b.y1 for b in boxes)
    kept_lon, kept_lat = [], []
    for _ in range(200):
        if sum(len(a) for a in kept_lon) >= n_points:
            break
        lon = rng.uniform(west, east, 4 * n_points)
        lat = rng.uniform(south, north, 4 * n_points)
        keep = inside_any(paths["extent"], lon, lat)
        kept_lon.append(lon[keep])
        kept_lat.append(lat[keep])
    lon = np.concatenate(kept_lon)[:n_points]
    lat = np.concatenate(kept_lat)[:n_points]
    if len(lon) < n_points:
        raise SourceError(f"only sampled {len(lon)} points in the UNOSAT extent")
    return pd.DataFrame({
        "lon": lon, "lat": lat,
        "label": inside_any(paths["flood"], lon, lat).astype(int),
    })


# --- shared feature attachment -------------------------------------------
def attach_features(points: pd.DataFrame, states: dict, cache: Path,
                    refresh: bool, workers: int, hand_cache: str) -> pd.DataFrame:
    """The same features, from the same sources, as the tower table.

    Deliberately the same code path (terrain_at_points / fetch_hand /
    distance_fields imported from prepare_malaysia_dataset, not reimplemented):
    an evaluation whose features are computed differently from the ones the
    model will see in production measures the difference between the two
    pipelines as much as it measures the model.
    """
    print("  terrain...", file=sys.stderr)
    terrain = terrain_at_points(points, cache, refresh, workers)
    print("  hand...", file=sys.stderr)
    hand = fetch_hand(points, cache, refresh, cache_name=hand_cache)
    print("  osm water/power...", file=sys.stderr)
    distances = distance_fields(points, cache, refresh)
    out = points.copy()
    out["hand_m"] = hand
    out["slope_deg"] = terrain.slope_deg.to_numpy()
    out["tri"] = terrain.tri.to_numpy()
    out["elevation_m"] = terrain.elevation_m.to_numpy()
    out["dist_water_m"] = distances.dist_water_m.to_numpy()
    out["dist_power_m"] = distances.dist_power_m.to_numpy()
    out["state"] = assign_states(out.lon.to_numpy(), out.lat.to_numpy(), states)
    return out


def build_gsw_set(states: dict, args, cache: Path) -> tuple[pd.DataFrame, dict]:
    corners = sample_cells(states, args.cells, args.seed)
    points = cell_points(corners, args.seed)
    points["state"] = assign_states(points.lon.to_numpy(), points.lat.to_numpy(), states)
    points = points[points.state != ""].reset_index(drop=True)
    print(f"  {len(points)} land points in {args.cells} cells", file=sys.stderr)

    print("  gsw...", file=sys.stderr)
    bands = np.full((len(points), len(GSW_ASSETS)), np.nan)
    groups = points.groupby("cell_id").groups
    # Resolved before the pool starts: gsw_item is cached per 10 deg tile, and
    # letting six workers race to write the same cache file is a corrupt JSON
    # waiting to happen.
    items = {}
    for cell in groups:
        x0, y0 = corners[cell]
        items[cell] = gsw_item(x0 + CELL_DEGREES / 2, y0 + CELL_DEGREES / 2,
                               cache, args.refresh)

    def one(cell):
        index = np.asarray(groups[cell])
        x0, y0 = corners[cell]
        bounds = (x0, y0, x0 + CELL_DEGREES, y0 + CELL_DEGREES)
        stack = gsw_window(items[cell], bounds, cache, args.refresh)
        return index, sample_grid(stack, points.lon.to_numpy()[index],
                                  points.lat.to_numpy()[index], bounds).T

    # Parallel because each window is one independent range read against a
    # 10 deg COG: measured sequentially this stage ran ~12 s per cell, which is
    # latency, not work, and 400 cells of it is over an hour of waiting.
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(one, cell) for cell in groups]
        for number, future in enumerate(as_completed(futures), 1):
            index, values = future.result()
            bands[index] = values
            if number % 50 == 0:
                print(f"  gsw {number}/{len(groups)} cells", file=sys.stderr)

    for i, asset in enumerate(GSW_ASSETS):
        points[f"gsw_{asset}"] = bands[:, i]
    points["label"] = label_from_occurrence(points.gsw_occurrence.to_numpy())

    breakdown = {
        "sampled": int(len(points)),
        "negative_never_water": int((points.label == 0).sum()),
        "positive_seasonal_water": int((points.label == 1).sum()),
        "excluded_permanent_water": int(
            (points.gsw_occurrence >= PERMANENT_OCCURRENCE).sum()),
        "excluded_trace_occurrence": int(
            ((points.gsw_occurrence > 0)
             & (points.gsw_occurrence < NOISE_OCCURRENCE)).sum()),
    }
    kept = points[points.label >= 0].reset_index(drop=True)
    kept = attach_features(kept, states, cache, args.refresh, args.workers,
                           "hand_samples_gsw.json")
    kept = kept[kept.hand_m.notna()].reset_index(drop=True)
    kept["label_source"] = "jrc-gsw-v1.3-occurrence"
    breakdown["rows_written"] = int(len(kept))
    breakdown["positive_rate"] = round(float(kept.label.mean()), 5)
    return kept, breakdown


def build_event_set(states: dict, args, cache: Path) -> tuple[pd.DataFrame, dict]:
    paths = unosat_paths(cache, args.refresh)
    points = event_points(paths, args.event_points, args.seed)
    points = attach_features(points, states, cache, args.refresh, args.workers,
                             "hand_samples_event.json")
    points = points[points.hand_m.notna()].reset_index(drop=True)
    points["label_source"] = f"unosat-{UNOSAT_EVENT}-sentinel1-2019-12-15"
    points["cell_id"] = -1
    return points, {
        "rows_written": int(len(points)),
        "positive_flood_water": int(points.label.sum()),
        "positive_rate": round(float(points.label.mean()), 5),
    }


def prepare(args) -> dict:
    output = args.output.resolve()
    cache = args.cache_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)
    states = fetch_states(cache, args.refresh)

    report = {}
    print("GSW national set...", file=sys.stderr)
    gsw, report["gsw"] = build_gsw_set(states, args, cache)
    gsw.to_csv(output / "flood_labels_gsw.csv", index=False)

    print("UNOSAT event set...", file=sys.stderr)
    event, report["event"] = build_event_set(states, args, cache)
    event.to_csv(output / "flood_labels_event.csv", index=False)

    write_json(output / "flood_labels_manifest.json", {
        "title": "Observed-inundation ground truth for the flood factor",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "label_definition": {
            "positive": f"{NOISE_OCCURRENCE} <= GSW occurrence < "
                        f"{PERMANENT_OCCURRENCE} (observed under water, not permanent)",
            "negative": "GSW occurrence == 0 (never observed as water 1984-2020)",
            "excluded": "permanent water bodies, and trace occurrence below "
                        f"{NOISE_OCCURRENCE}%",
            "event_positive": "inside a UNOSAT polygon classed 'Flood Water', "
                              "15 Dec 2019 Sentinel-1",
            "event_negative": "inside the UNOSAT AnalysisExtent, outside the "
                              "flood polygons",
        },
        "not_a_failure_label": (
            "Neither label records an outage, a fault or a maintenance action. "
            "Both record observed surface water. No failure label exists in "
            "this project and none is created here."
        ),
        "limitations": [
            "GSW non-permanent water in Malaysia includes paddy, aquaculture "
            "and ex-mining ponds, which are managed water rather than flood; "
            "the UNOSAT set is the control for that confound.",
            "The UNOSAT set is one event, one date, two AOIs in Johor.",
            "GSW is Landsat-derived and misses flooding under cloud, which "
            "biases its negatives toward false negatives in the wet season.",
        ],
        "attribution": [
            "Pekel, J-F. et al. (2016) JRC Global Surface Water v1.3, via "
            "Microsoft Planetary Computer.",
            "UNOSAT / UNITAR, FL20191217MYS, CC BY 3.0 IGO.",
            "Copernicus DEM GLO-30; ASF Global 30m HAND v1; OpenStreetMap "
            "contributors (ODbL); geoBoundaries ADM1.",
        ],
        "counts": report,
        "files": {
            name: {"bytes": (output / name).stat().st_size,
                   "sha256": sha256_bytes((output / name).read_bytes())}
            for name in ("flood_labels_gsw.csv", "flood_labels_event.csv")
        },
    })
    return report


def parser() -> argparse.ArgumentParser:
    repo = Path(__file__).resolve().parents[3]
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--output", type=Path, default=repo / "data" / "malaysia")
    p.add_argument("--cache-dir", type=Path,
                   default=repo / "data" / "malaysia" / "cache")
    # Cells, not points-per-cell, is the knob that buys independent
    # information: points 500 m apart inside one 5.5 km cell share a
    # catchment, so the effective sample size tracks the cell count.
    p.add_argument("--cells", type=int, default=400)
    p.add_argument("--event-points", type=int, default=12000)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--seed", type=int, default=20260831)
    p.add_argument("--refresh", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    try:
        report = prepare(args)
    except (SourceError, urllib.error.URLError, urllib.error.HTTPError,
            json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"flood label preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
