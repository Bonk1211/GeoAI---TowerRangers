"""Per-tower vegetation, soil and observed-water features, sampled at the points.

`land/layers.py` renders these same sources as map tiles. A tile is something a
person looks at; a model needs a number per site, and nothing in this repo
produced one. This is that producer: it takes the towers in
`data/malaysia/tower_feature_table.csv` and writes one row each into
`data/malaysia/land_features.csv`.

Every asset id, band name and scale constant is imported from `land/layers.py`,
so the number a model trains on and the wash a planner sees come from the same
place. Two of them are load-bearing and are re-stated at their use sites,
because getting either wrong produces output that looks entirely plausible:

  * Sentinel-2 reflectance is scaled by 10000 and EVI's `+L` does NOT cancel
    that scale. Multiply before the expression or every value is wrong.
  * A masked pixel comes back as a MISSING PROPERTY, not NaN. `sampleRegions`
    simply omits the key, so a silent join loss looks like a clean run. Every
    sampler here reindexes against the full tower list, and the resulting
    missing rate is checked against MAX_MISSING_FRACTION rather than reported.

`flood/forecast.py` samples tower points too and is deliberately not reused:
its `_sample` takes `Reducer.first()` and drops absent values into a dict,
which is right for a hazard multiplier (absent means "do not apply") and wrong
here, where a missing pixel must survive as an explicit NaN and count against
the ceiling. It is also a request-time module on the scheduler path, which a
batch producer should not be importing.

Observed water (JRC GSW v1.3) is sampled here rather than through
`prepare_flood_labels.py`'s tile-cache path. Same product, same version — that
script caches 10-degree tiles because it samples 38,948 points across 400 cells,
where the cache pays for itself. These points do not need it, and fetching here
means `prepare_maintenance_records.py` never touches the network, which is what
lets its tests stay offline.

Needs Earth Engine credentials — see tiles/ee_session.py. Every other route and
producer in this backend works without them.

    cd src/backend && python3 data/prepare_land_features.py
    cd src/backend && python3 data/prepare_land_features.py --limit 20 --cache-dir /tmp/lf-smoke

NEVER point --limit at data/malaysia/cache. A partial file is read back by the
next full run; that is how a 97%-smaller dataset shipped once already.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

_THIS_DIR = Path(__file__).resolve().parent
_BACKEND_DIR = _THIS_DIR.parent
for _p in (str(_BACKEND_DIR), str(_THIS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from land.layers import (  # noqa: E402
    CLAY_ASSET,
    CLAY_BAND,
    EVI_C1,
    EVI_C2,
    EVI_GAIN,
    EVI_L,
    S2_REFLECTANCE_SCALE,
    SMAP_ASSET,
    SMAP_BAND,
    WORLDCOVER,
    WORLDCOVER_CLASSES,
)
from prepare_pilot_dataset import write_json  # noqa: E402
from tiles.ee_session import LayerUnavailable, initialise  # noqa: E402

_REPO_ROOT = _BACKEND_DIR.parent.parent
DATA_DIR = _REPO_ROOT / "data" / "malaysia"
TOWER_TABLE = DATA_DIR / "tower_feature_table.csv"
OUT_CSV = DATA_DIR / "land_features.csv"
MANIFEST = DATA_DIR / "land_features_manifest.json"
CACHE_DIR = DATA_DIR / "cache" / "land_features"

# JRC Global Surface Water v1.3 — the version prepare_flood_labels.py pulls from
# Planetary Computer, so a tower's occurrence here and a label point's
# occurrence there mean the same thing.
GSW_ASSET = "JRC/GSW1_3/GlobalSurfaceWater"

# Sentinel-2 revisit here is ~5 days. land/layers.py uses a 6-day window because
# a tile answers "what did it look like on this date"; a site's standing
# vegetation state is a different question, and a short window in the tropics is
# mostly holes.
#
# Measured, not assumed: at 90 days the SCL cloud mask left 15% of towers with
# no clear observation at all, which tripped MAX_MISSING_FRACTION. A full year
# clears it. The cost is real and small — a 12-month median cannot show a
# seasonal change, and this column is read as a site's standing ground cover
# rather than a dated observation, which is what it now honestly is.
EVI_WINDOW_DAYS = 365
# Scenes above this are almost entirely removed by the SCL mask anyway, and
# dropping them shortens the collection the reducer has to walk.
MAX_CLOUD_PCT = 80

# SMAP L4 is 3-hourly: a year is ~2,900 granules, which times out. One granule
# per day is ~365 and answers the same question — this is antecedent wetness
# state, not a diurnal cycle.
SMAP_WINDOW_DAYS = 365
SMAP_HOUR = 1  # L4 granules land at 01:30, 04:30, ...; hour 1 takes one per day

# A mast often stands on a small cleared pad inside whatever the site actually
# is, so the centre pixel describes the pad. The mode over a small buffer
# describes the setting.
LAND_COVER_BUFFER_M = 100

# Native resolutions. Sampling below native invents detail; above it averages
# away the thing being measured.
S2_SCALE = 10
SMAP_SCALE = 9000
CLAY_SCALE = 250
WORLDCOVER_SCALE = 10
GSW_SCALE = 30

# Matches fetch_hand's rule in prepare_malaysia_dataset.py, which exists because
# a partial run once reported its loss as a drop count and produced a
# 97%-smaller dataset that went unnoticed.
MAX_MISSING_FRACTION = 0.05

# EVI is the heaviest reduction here; smaller chunks keep each getInfo() inside
# Earth Engine's request budget.
DEFAULT_CHUNK = 150

FEATURE_COLUMNS = [
    "evi_median",
    "evi_p10",
    "soil_moisture_mean",
    "soil_moisture_p90",
    "clay_pct",
    "land_cover_class",
    "gsw_occurrence_pct",
    "gsw_recurrence_pct",
]

WORLDCOVER_LABELS = {value: label for value, label, _ in WORLDCOVER_CLASSES}


# --- helpers ---------------------------------------------------------------
def load_towers(path: Path, limit: int | None) -> pd.DataFrame:
    if not path.exists():
        raise SystemExit(
            f"{path} not found — run data/prepare_malaysia_dataset.py first."
        )
    towers = pd.read_csv(path, usecols=["tower_id", "lon", "lat"])
    if limit:
        towers = towers.head(limit)
    return towers.reset_index(drop=True)


def chunks(frame: pd.DataFrame, size: int):
    for start in range(0, len(frame), size):
        yield frame.iloc[start : start + size]


def point_collection(ee, frame: pd.DataFrame, buffer_m: int = 0):
    features = []
    for row in frame.itertuples(index=False):
        geometry = ee.Geometry.Point([float(row.lon), float(row.lat)])
        if buffer_m:
            geometry = geometry.buffer(buffer_m)
        features.append(ee.Feature(geometry, {"tower_id": row.tower_id}))
    return ee.FeatureCollection(features)


def sampled_frame(response: dict, columns: list[str]) -> pd.DataFrame:
    """An Earth Engine sample response -> a frame keyed on tower_id.

    A masked pixel yields a feature whose properties simply lack the band key,
    so `.get(column)` returning None is the normal representation of "no
    observation" and must stay NaN rather than becoming 0.0. A zero EVI means
    bare ground; a missing one means we could not see.
    """
    rows = []
    for feature in response.get("features", []):
        properties = feature.get("properties", {})
        row = {"tower_id": properties.get("tower_id")}
        for column in columns:
            value = properties.get(column)
            row[column] = float(value) if value is not None else np.nan
        rows.append(row)
    if not rows:
        return pd.DataFrame(columns=["tower_id", *columns])
    return pd.DataFrame(rows)


def cached_chunk(cache: Path, key: str, builder, refresh: bool) -> dict:
    """Mirrors prepare_pilot_dataset.cached, for a JSON response rather than
    bytes — the expensive call being avoided is an Earth Engine getInfo()."""
    path = cache / f"{key}.json"
    if path.exists() and not refresh:
        return json.loads(path.read_text(encoding="utf-8"))
    payload = builder()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def run_sampler(towers, cache, refresh, chunk_size, name, sampler, columns, version=""):
    """Sample one source over every chunk, then merge onto the full tower list.

    Concatenating and de-duplicating is what converts Earth Engine's silent
    omission of a masked pixel into an explicit NaN on the left join in build(),
    which is the only form the missing-rate check can see.

    `version` goes in the cache key and must encode every parameter that changes
    what the sampler returns — the window dates, above all. Without it, widening
    --evi-days reads back the narrower window's cached response and reports the
    old numbers under the new setting, which is the same silent-stale-cache
    failure this module's header warns about for --limit.
    """
    frames = []
    total = (len(towers) + chunk_size - 1) // chunk_size
    for index, chunk in enumerate(chunks(towers, chunk_size), start=1):
        key = f"{name}_{version}_{index:04d}of{total:04d}_{len(chunk)}".replace("__", "_")
        print(f"  {name}: chunk {index}/{total} ({len(chunk)} towers)", flush=True)
        response = cached_chunk(cache, key, lambda c=chunk: sampler(c), refresh)
        frames.append(sampled_frame(response, columns))
    if not frames:
        return pd.DataFrame(columns=["tower_id", *columns])
    out = pd.concat(frames, ignore_index=True)
    # A duplicate tower_id would multiply rows on the join in build().
    return out.drop_duplicates(subset="tower_id", keep="first")


# --- sources ---------------------------------------------------------------
def evi_reduction(ee, end: date, window_days: int = EVI_WINDOW_DAYS, *, count_scenes=False):
    """Cloud-masked Sentinel-2 EVI, median and 10th percentile over the window.

    From land/layers.build_vegetation_vigour, with two deliberate differences: a
    year-long window (a site's standing state, not a dated observation), and a
    percentile alongside the median, because what encroaches on a compound is
    the sparse-season floor rather than the typical greenness.
    """
    start = end - timedelta(days=window_days)

    def clear_evi(image):
        scl = image.select("SCL")
        # SCL 4-7 keeps vegetation, bare ground, water and unclassified land;
        # it screens no-data, bad pixels, shadow, cloud, cirrus and snow.
        clear = scl.gte(4).And(scl.lte(7))
        # Scale to reflectance BEFORE the expression. EVI's +L and its
        # coefficients assume 0..1; on raw DN the constant is rounding noise and
        # the result looks entirely plausible while being wrong everywhere. NDVI
        # hides this because a normalised difference cancels the scale.
        bands = (
            image.updateMask(clear)
            .select(["B8", "B4", "B2"])
            .multiply(S2_REFLECTANCE_SCALE)
        )
        return (
            bands.expression(
                "gain * ((nir - red) / (nir + c1 * red - c2 * blue + L))",
                {
                    "nir": bands.select("B8"),
                    "red": bands.select("B4"),
                    "blue": bands.select("B2"),
                    "gain": EVI_GAIN,
                    "c1": EVI_C1,
                    "c2": EVI_C2,
                    "L": EVI_L,
                },
            )
            .rename("EVI")
            # The denominator approaches zero over bright or noisy pixels and
            # throws the value to thousands, dragging the median with it.
            .clamp(-1, 1)
        )

    def sampler(chunk: pd.DataFrame) -> dict:
        points = point_collection(ee, chunk)
        collection = (
            ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
            .filterBounds(points.geometry().bounds())
            .filterDate(start.isoformat(), end.isoformat())
            .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", MAX_CLOUD_PCT))
            .map(clear_evi)
        )
        # Change detection caches this count alongside the sample. An empty
        # window is unmeasured, never an image of zero greenness.
        count = collection.size().getInfo() if count_scenes else None
        if count == 0:
            return {"features": [], "scene_count": 0}
        reduced = collection.reduce(
            ee.Reducer.median().combine(ee.Reducer.percentile([10]), sharedInputs=True)
        ).rename(["evi_median", "evi_p10"])
        response = reduced.sampleRegions(
            collection=points, scale=S2_SCALE, geometries=False
        ).getInfo()
        if count_scenes:
            response["scene_count"] = count
        return response

    return sampler, ["evi_median", "evi_p10"], (start.isoformat(), end.isoformat())


def soil_moisture_reduction(ee, end: date):
    """SMAP L4 surface soil moisture (0-5 cm): mean and 90th percentile, m3/m3.

    Mean is the site's normal wetness; p90 is how wet it gets, which is what
    turns the next rainfall into standing water. 9 km pixels — regional wetness
    state, never site bearing capacity.
    """
    start = end - timedelta(days=SMAP_WINDOW_DAYS)

    collection = (
        ee.ImageCollection(SMAP_ASSET)
        .filterDate(start.isoformat(), end.isoformat())
        .filter(ee.Filter.calendarRange(SMAP_HOUR, SMAP_HOUR, "hour"))
        .select(SMAP_BAND)
    )
    # Forces the round trip now. SMAP L4 v007 was withdrawn from the catalogue,
    # and an asset id that no longer resolves otherwise sails through and
    # surfaces as a column of nulls — which reads as "dry everywhere".
    try:
        count = collection.size().getInfo()
    except Exception as error:  # noqa: BLE001 — EE raises many unrelated types
        raise LayerUnavailable(
            f"Earth Engine could not read {SMAP_ASSET} ({error}). SMAP L4 versions "
            "are withdrawn as new ones land; check the Earth Engine catalogue for "
            "the current SPL4SMGP version and update SMAP_ASSET in land/layers.py."
        ) from error
    if not count:
        raise LayerUnavailable(
            f"no SMAP L4 granules between {start} and {end}. The collection is "
            "likely behind its usual publication lag — try an earlier --end-date."
        )
    print(f"  soil_moisture: {count} daily granules in window", flush=True)

    reduced = collection.reduce(
        ee.Reducer.mean().combine(ee.Reducer.percentile([90]), sharedInputs=True)
    ).rename(["soil_moisture_mean", "soil_moisture_p90"])

    def sampler(chunk: pd.DataFrame) -> dict:
        return reduced.sampleRegions(
            collection=point_collection(ee, chunk),
            scale=SMAP_SCALE,
            geometries=False,
        ).getInfo()

    return (
        sampler,
        ["soil_moisture_mean", "soil_moisture_p90"],
        (start.isoformat(), end.isoformat()),
    )


def clay_reduction(ee):
    """OpenLandMap clay fraction at 0 cm, % — the layer a foundation sits in.

    A 250 m machine-learning prediction with its own uncertainty, not a
    borehole. It says what kind of ground an area tends to have; it does not say
    what is under one foundation.
    """
    image = ee.Image(CLAY_ASSET).select(CLAY_BAND).rename("clay_pct")

    def sampler(chunk: pd.DataFrame) -> dict:
        return image.sampleRegions(
            collection=point_collection(ee, chunk), scale=CLAY_SCALE, geometries=False
        ).getInfo()

    return sampler, ["clay_pct"], None


def land_cover_reduction(ee):
    """ESA WorldCover class, mode within LAND_COVER_BUFFER_M of the mast.

    ESA's own class values, kept verbatim — a recoloured or renumbered land
    cover map is one nobody can check against the source.

    `WORLDCOVER` is an ImageCollection holding one global 2021 classification,
    not an Image; `.first()` is how land/layers.build_land_cover reaches it, and
    ee.Image(...) on it fails with "is not an Image". Fixed 2021 epoch: clearing
    or regrowth since then does not appear here.
    """
    image = (
        ee.ImageCollection(WORLDCOVER).first().select("Map").rename("land_cover_class")
    )

    def sampler(chunk: pd.DataFrame) -> dict:
        return image.reduceRegions(
            collection=point_collection(ee, chunk, LAND_COVER_BUFFER_M),
            reducer=ee.Reducer.mode(),
            scale=WORLDCOVER_SCALE,
        ).getInfo()

    return sampler, ["mode"], None


def gsw_reduction(ee):
    """JRC GSW occurrence and recurrence at the tower point, %.

    Nothing is excluded here, and that is the difference from
    prepare_flood_labels.py, which drops permanent water from both classes.
    That exclusion exists because a *label* of "is this pixel flooded" is
    trivially satisfied by a river, so a model could score well by finding water
    bodies. A tower standing beside permanent water is not a trivial case — it
    is a genuinely high-exposure site, and its occurrence is a real feature.
    """
    image = ee.Image(GSW_ASSET).select(["occurrence", "recurrence"])

    def sampler(chunk: pd.DataFrame) -> dict:
        return image.sampleRegions(
            collection=point_collection(ee, chunk), scale=GSW_SCALE, geometries=False
        ).getInfo()

    return sampler, ["occurrence", "recurrence"], None


# --- assembly --------------------------------------------------------------
def check_missing(frame: pd.DataFrame, columns: list[str]) -> dict:
    """Missing rate per column, raising past the threshold rather than reporting.

    Reporting a drop count is what let a partial cache through last time. The
    exception is the point: a run that could not see most of the country should
    fail loudly, not write a file that looks fine.

    GSW is exempt from the ceiling: its mask covers land only, and a tower far
    from any water body legitimately has no value. Those become 0.0 below, which
    is the correct reading — never observed under water — and not a guess.
    """
    report = {}
    for column in columns:
        fraction = float(frame[column].isna().mean())
        report[column] = round(fraction, 4)
        if column.startswith("gsw_"):
            continue
        if fraction > MAX_MISSING_FRACTION:
            raise SystemExit(
                f"{column} is missing for {fraction:.1%} of towers, above the "
                f"{MAX_MISSING_FRACTION:.0%} ceiling. Earth Engine omits masked "
                "pixels silently, so this is either persistent cloud over the "
                "window (widen --evi-days) or a source that returned nothing. "
                "Not writing a partial file."
            )
    return report


def build(args) -> dict:
    ee = initialise()
    towers = load_towers(args.tower_table, args.limit)
    print(f"{len(towers)} towers from {args.tower_table}", flush=True)

    cache = args.cache_dir
    cache.mkdir(parents=True, exist_ok=True)
    end = date.fromisoformat(args.end_date)

    out = towers.copy()
    windows: dict[str, list[str] | None] = {}

    evi_sampler, evi_columns, evi_window = evi_reduction(ee, end, args.evi_days)
    smap_sampler, smap_columns, smap_window = soil_moisture_reduction(ee, end)
    clay_sampler, clay_columns, _ = clay_reduction(ee)
    cover_sampler, cover_columns, _ = land_cover_reduction(ee)
    gsw_sampler, gsw_columns, _ = gsw_reduction(ee)

    sources = [
        ("evi", evi_sampler, evi_columns, evi_window, {}),
        ("soil_moisture", smap_sampler, smap_columns, smap_window, {}),
        ("clay", clay_sampler, clay_columns, None, {}),
        (
            "land_cover",
            cover_sampler,
            cover_columns,
            None,
            {"mode": "land_cover_class"},
        ),
        (
            "gsw",
            gsw_sampler,
            gsw_columns,
            None,
            {"occurrence": "gsw_occurrence_pct", "recurrence": "gsw_recurrence_pct"},
        ),
    ]

    for name, sampler, columns, window, rename in sources:
        # Undated sources (clay, land cover, GSW) are fixed epochs, so an empty
        # version is correct — there is no parameter that could change them.
        version = "-".join(window) if window else ""
        frame = run_sampler(
            towers, cache, args.refresh, args.chunk_size, name, sampler, columns, version
        )
        if rename:
            frame = frame.rename(columns=rename)
        out = out.merge(frame, on="tower_id", how="left")
        windows[name] = list(window) if window else None

    # Reducer.mode() returns a FLOAT, and it carries floating-point error: the
    # raw values come back as 49.99999999999996, 49.99999999999998, 50.0 for
    # what is one ESA class. Two bugs follow if this is not rounded. int()
    # truncates toward zero, so 49.999... becomes 49 — not a class at all, which
    # is how 49 towers ended up with a null land_cover_label. And because this
    # column is a *categorical* model feature, those near-identical floats would
    # become distinct category levels, shattering one class into a dozen and
    # quietly wrecking the vegetation factor.
    out["land_cover_class"] = out["land_cover_class"].round()

    missing = check_missing(out, FEATURE_COLUMNS)
    # Only after the check: GSW's land-only mask means "no water ever recorded
    # here", which is a real 0 and not an imputation.
    out[["gsw_occurrence_pct", "gsw_recurrence_pct"]] = out[
        ["gsw_occurrence_pct", "gsw_recurrence_pct"]
    ].fillna(0.0)

    out["land_cover_label"] = out["land_cover_class"].map(
        lambda v: WORLDCOVER_LABELS.get(int(v)) if pd.notna(v) else None
    )

    columns = ["tower_id", *FEATURE_COLUMNS, "land_cover_label"]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out[columns].to_csv(args.out, index=False)

    manifest = {
        "synthetic": False,
        "rows": int(len(out)),
        "end_date": args.end_date,
        "windows": windows,
        "missing_fraction": missing,
        "sources": {
            "vegetation": "Copernicus Sentinel-2 SR Harmonized, EVI (MODIS coefficients)",
            "soil_moisture": SMAP_ASSET,
            "soil_texture": f"{CLAY_ASSET} band {CLAY_BAND}",
            "land_cover": WORLDCOVER,
            "surface_water": GSW_ASSET,
        },
        "scales_m": {
            "evi": S2_SCALE,
            "soil_moisture": SMAP_SCALE,
            "clay": CLAY_SCALE,
            "land_cover": WORLDCOVER_SCALE,
            "gsw": GSW_SCALE,
        },
        "caveats": [
            "SMAP is 9 km: regional wetness state, never site bearing capacity.",
            "Clay is a 250 m ML prediction with its own uncertainty, not a borehole.",
            "EVI is ground-cover greenness — not canopy height, not clearance from "
            "the structure, and far too coarse for the 1 m perimeter cut MCMC MTSFB "
            "TC G041:2023 6.3.3(b) requires.",
            "GSW nulls are filled with 0 (never observed under water); every other "
            "column keeps NaN, because a missing reading is not a measurement.",
        ],
    }
    write_json(args.manifest, manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--tower-table", type=Path, default=TOWER_TABLE)
    p.add_argument("--out", type=Path, default=OUT_CSV)
    p.add_argument("--manifest", type=Path, default=MANIFEST)
    p.add_argument(
        "--cache-dir",
        type=Path,
        default=CACHE_DIR,
        help="NEVER point a --limit run at the real cache directory.",
    )
    p.add_argument("--limit", type=int, default=None, help="smoke-run row cap")
    p.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK)
    p.add_argument(
        "--evi-days",
        type=int,
        default=EVI_WINDOW_DAYS,
        help="Sentinel-2 lookback. Widen if the missing-rate check trips on cloud.",
    )
    p.add_argument("--end-date", default=date.today().isoformat())
    p.add_argument("--refresh", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.limit and args.cache_dir == CACHE_DIR:
        raise SystemExit(
            "--limit with the real cache directory writes a partial result that a "
            "later full run reads back. Pass --cache-dir /tmp/<something> instead."
        )
    try:
        manifest = build(args)
    except LayerUnavailable as error:
        raise SystemExit(f"Earth Engine unavailable: {error}") from error
    print(json.dumps(manifest, indent=2, sort_keys=True))
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
