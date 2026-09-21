"""Two annual Sentinel-2 EVI windows -> measured change per tower.

Run from src/backend: python3 data/prepare_land_change.py
Smoke: --limit 20 --cache-dir /tmp/lc-smoke (outputs go there too).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd

_THIS_DIR = Path(__file__).resolve().parent
for _p in (str(_THIS_DIR.parent), str(_THIS_DIR)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from prepare_land_features import (  # noqa: E402
    DATA_DIR, DEFAULT_CHUNK, MAX_MISSING_FRACTION, TOWER_TABLE,
    cached_chunk, check_missing, chunks, evi_reduction, load_towers, sampled_frame,
)
from prepare_pilot_dataset import write_json  # noqa: E402
from tiles.ee_session import LayerUnavailable, initialise  # noqa: E402

# Matching seasons two years apart avoids confusing seasonality with regrowth.
BASELINE_GAP_DAYS = 730
CACHE_DIR = DATA_DIR / "cache" / "land_change"
OUT_CSV = DATA_DIR / "land_change.csv"
MANIFEST = DATA_DIR / "land_change_manifest.json"


def build(args) -> dict:
    towers = load_towers(args.tower_table, args.limit)
    if towers.empty or towers.tower_id.duplicated().any():
        raise ValueError("Change sampling requires a nonempty, unique tower table")
    ee = initialise()
    end = date.fromisoformat(args.end_date)
    out = towers[["tower_id"]].copy()
    windows, scene_counts = {}, {}
    for name, window_end in (
        ("recent", end), ("baseline", end - timedelta(days=BASELINE_GAP_DAYS))
    ):
        # Reuse the exact SCL mask, reflectance scaling and EVI coefficients.
        sampler, columns, window = evi_reduction(ee, window_end, count_scenes=True)
        windows[name] = list(window)
        frames, counts = [], []
        # run_sampler discards response metadata. Keep its shared primitives so
        # scene counts survive cached runs, including empty baseline windows.
        for chunk in chunks(towers, args.chunk_size):
            identity = hashlib.sha256(chunk.to_csv(index=False).encode()).hexdigest()[:16]
            key = f"evi_{window[0]}_{window[1]}_{identity}"
            print(f"  {name}: {len(chunk)} towers", flush=True)
            response = cached_chunk(args.cache_dir, key, lambda c=chunk: sampler(c), args.refresh)
            counts.append(response["scene_count"])
            frames.append(sampled_frame(response, columns))
        scene_counts[name] = counts
        sampled = pd.concat(frames, ignore_index=True)[["tower_id", "evi_median"]]
        out = out.merge(sampled.rename(columns={"evi_median": f"evi_median_{name}"}),
                        on="tower_id", how="left", validate="one_to_one")
        if not all(counts):
            raise ValueError(f"{name} has a chunk with no Sentinel-2 scenes; not writing a partial file")

    out["evi_delta_per_year"] = (
        out.evi_median_recent - out.evi_median_baseline
    ) / (BASELINE_GAP_DAYS / 365.0)
    missing = check_missing(out, ["evi_median_recent", "evi_median_baseline", "evi_delta_per_year"])
    # WorldCover is a single 2021 epoch: EVI change cannot establish a class change.
    out["land_cover_changed"] = pd.Series(pd.NA, index=out.index, dtype="boolean")
    for name, window in windows.items():
        out[f"window_{name}"] = "/".join(window)
    manifest = {
        "synthetic": False, "rows": len(out), "windows": windows,
        "scene_counts": scene_counts, "missing_fraction": missing,
        "max_missing_fraction": MAX_MISSING_FRACTION,
        "years_between": BASELINE_GAP_DAYS / 365.0,
        "source": "COPERNICUS/S2_SR_HARMONIZED",
        "note": "Scene counts are per chunk and may overlap. EVI is ground greenness, "
                "not canopy height or clearance. land_cover_changed is unmeasured: "
                "the available WorldCover layer has only one epoch.",
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(args.out, index=False)
    write_json(args.manifest, manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--tower-table", type=Path, default=TOWER_TABLE)
    p.add_argument("--cache-dir", type=Path, default=CACHE_DIR)
    p.add_argument("--out", type=Path)
    p.add_argument("--manifest", type=Path)
    p.add_argument("--limit", type=int)
    p.add_argument("--chunk-size", type=int, default=DEFAULT_CHUNK)
    p.add_argument("--end-date", default=date.today().isoformat())
    p.add_argument("--refresh", action="store_true")
    return p


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    if args.chunk_size <= 0 or (args.limit is not None and args.limit <= 0):
        raise SystemExit("--chunk-size and --limit must be positive")
    if args.limit and args.cache_dir.resolve() == CACHE_DIR.resolve():
        raise SystemExit("Pass --cache-dir /tmp/<something> for a --limit smoke run")
    args.out = args.out or (args.cache_dir / OUT_CSV.name if args.limit else OUT_CSV)
    args.manifest = args.manifest or (args.cache_dir / MANIFEST.name if args.limit else MANIFEST)
    try:
        manifest = build(args)
    except LayerUnavailable as error:
        raise SystemExit(f"Earth Engine unavailable: {error}") from error
    print(json.dumps(manifest, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
