"""Flood depth polygons for the 3D water volume, derived from the stage masks.

The 2D flood surface is five PNG masks, each marking ground at or below one
stage above nearest drainage. Because those masks are strictly nested — a pixel
wet at 0.5 m is wet at every stage above it — the stack already encodes a banded
HAND field: a pixel's band is the lowest stage at which it turns wet.

For a chosen stage h, h - b is the minimum depth consistent with bucket b, so
one set of polygons carries every stage and the frontend picks that banded
lower-bound estimate without refetching anything.

Polygons rather than the raster, because MapLibre extrudes vector geometry and
not rasters. A draped raster follows the ground and shows no volume at all,
which is exactly the thing 3D is here to show.

Reads the committed PNGs, so it needs no network and no Earth Engine — run
prepare_flood_surface.py first if they are missing.

    python3 src/backend/data/prepare_flood_volume.py
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from prepare_flood_surface import AOI_BBOX, OUTPUT_DIR, STAGES_M, stage_file

# Grid cells across the wider axis of the AOI.
#
# The masks are 1024 px across ~14.4 km, or about 14 m a pixel — far finer than
# a water volume needs and far more geometry than is sensible to ship. 64 cells
# puts each quad at roughly 225 m, which still reads as a shaped water body at
# the zoom this layer is looked at, while keeping the file small enough to commit.
DEFAULT_CELLS = 64

OUTPUT_NAME = "flood_volume.geojson"


class VolumeError(RuntimeError):
    """Inputs are missing or inconsistent."""


def _load_masks(source: Path) -> tuple[np.ndarray, tuple[int, int]]:
    """Wet/dry boolean array per stage, shallowest first."""
    try:
        from PIL import Image
    except ImportError as error:
        raise VolumeError(
            f"pillow is required to read the stage masks ({error}). "
            "Run: pip install -r src/backend/requirements-flood.txt"
        ) from error

    masks = []
    shape = None
    for stage in STAGES_M:
        path = source / stage_file(stage)
        if not path.exists():
            raise VolumeError(
                f"{path} not found. Run prepare_flood_surface.py first — this script "
                "derives depth from those masks and fetches nothing itself."
            )
        # Alpha carries the mask: the rendering rule made dry ground NoData, so
        # transparent is dry and opaque is wet.
        alpha = np.array(Image.open(path).convert("RGBA"))[:, :, 3] > 0
        if shape is None:
            shape = alpha.shape
        elif alpha.shape != shape:
            raise VolumeError(f"{path} is {alpha.shape}, expected {shape}")
        masks.append(alpha)
    return np.stack(masks), (shape[1], shape[0])


def band_field(masks: np.ndarray) -> np.ndarray:
    """Lowest stage index at which each pixel is wet; len(STAGES_M) where dry.

    Nesting is asserted rather than assumed: it is a property of thresholding a
    single HAND raster, and if it ever fails the bands below are meaningless.
    """
    for i in range(1, len(masks)):
        lost = int((masks[i - 1] & ~masks[i]).sum())
        if lost:
            raise VolumeError(
                f"stage {STAGES_M[i]} m does not contain stage {STAGES_M[i - 1]} m "
                f"({lost} pixels dry out as the water rises) — the masks are not nested, "
                "so they cannot be read as depth bands"
            )
    # argmax finds the first True; where nothing is wet it returns 0, so mask
    # those back out to the dry sentinel.
    first = np.argmax(masks, axis=0)
    return np.where(masks.any(axis=0), first, len(masks))


def cell_bands(bands: np.ndarray, cells: int) -> tuple[np.ndarray, int, int]:
    """Downsample to a coarse grid, taking each cell's median band.

    Median rather than min: min is the wettest pixel in the cell and would grow
    the water outward at every step, making the flooded area a function of grid
    resolution rather than of the terrain.
    """
    h, w = bands.shape
    nx = cells
    ny = max(1, round(cells * h / w))
    ys = np.linspace(0, h, ny + 1).astype(int)
    xs = np.linspace(0, w, nx + 1).astype(int)
    out = np.full((ny, nx), len(STAGES_M), dtype=int)
    for j in range(ny):
        for i in range(nx):
            block = bands[ys[j] : ys[j + 1], xs[i] : xs[i + 1]]
            if block.size:
                out[j, i] = int(np.median(block))
    return out, nx, ny


def to_geojson(grid: np.ndarray, nx: int, ny: int) -> dict:
    lon_min, lat_min, lon_max, lat_max = AOI_BBOX
    dlon = (lon_max - lon_min) / nx
    dlat = (lat_max - lat_min) / ny

    features = []
    for j in range(ny):
        for i in range(nx):
            band = int(grid[j, i])
            if band >= len(STAGES_M):
                continue  # dry above the top of the ladder — nothing to draw
            # Row 0 is the top of the image, which is the northern edge.
            north = lat_max - j * dlat
            south = north - dlat
            west = lon_min + i * dlon
            east = west + dlon
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [
                            [
                                [round(west, 6), round(south, 6)],
                                [round(east, 6), round(south, 6)],
                                [round(east, 6), round(north, 6)],
                                [round(west, 6), round(north, 6)],
                                [round(west, 6), round(south, 6)],
                            ]
                        ],
                    },
                    # First stage bucket at which this cell turns wet. The
                    # client uses h - hand as a lower-bound depth estimate.
                    "properties": {"hand": STAGES_M[band]},
                }
            )
    return {"type": "FeatureCollection", "features": features}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=OUTPUT_DIR)
    parser.add_argument("--output", type=Path, default=OUTPUT_DIR / OUTPUT_NAME)
    parser.add_argument("--cells", type=int, default=DEFAULT_CELLS)
    args = parser.parse_args(argv)

    try:
        masks, (w, h) = _load_masks(args.source)
        bands = band_field(masks)
        grid, nx, ny = cell_bands(bands, args.cells)
        fc = to_geojson(grid, nx, ny)
    except VolumeError as error:
        print(f"flood volume preparation failed: {error}", file=sys.stderr)
        return 1

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(fc, separators=(",", ":")) + "\n", encoding="utf-8")

    wet = len(fc["features"])
    by_band: dict[float, int] = {}
    for f in fc["features"]:
        key = f["properties"]["hand"]
        by_band[key] = by_band.get(key, 0) + 1
    print(f"source masks : {w}x{h}")
    print(f"grid         : {nx}x{ny}  ({nx * ny} cells)")
    print(f"wet cells    : {wet}  ({100 * wet / (nx * ny):.1f}%)")
    for stage in STAGES_M:
        print(f"  hand <= {stage:<4} {by_band.get(stage, 0):>5} cells")
    print(f"written      : {args.output} ({args.output.stat().st_size / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
