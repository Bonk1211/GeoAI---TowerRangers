"""Render potential-inundation surfaces for the Sunway AOI from GLO-30 HAND.

One transparent PNG per flood stage, written into the frontend's public/ tree so
the map console can lay them over the basemap as a MapLibre `image` source. A
stage of h metres means "water standing h metres above the nearest drainage";
the surface marks every pixel whose HAND value is at or below h.

This is a terrain threshold, NOT a hydraulic model and NOT a forecast. It says
which ground sits below a given water level, and nothing about whether that
level will occur, how fast water would arrive, or what would happen to anything
standing on that ground. The same GLO-30 HAND product is sampled per tower as
`hand_m` in data/pilot_sunway/tower_feature_table.csv (see fetch_hand there), so
the surface and the per-site number cannot disagree.

Thresholding happens server-side: ASF's ImageServer accepts a chained
Colormap->Remap rendering rule, which returns a two-colour PNG (transparent dry,
opaque blue wet). That keeps a raster reader out of this backend entirely — the
alternative, pulling the 32-bit float GeoTIFF and thresholding locally, would
need rasterio/GDAL plus a PNG writer for no gain.

Run from anywhere; paths resolve from __file__, not the process CWD:

    python3 src/backend/data/prepare_flood_surface.py
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import urllib.error
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

from prepare_pilot_dataset import SourceError, request_bytes, sha256_bytes, write_json

HAND_EXPORT = (
    "https://gis.asf.alaska.edu/arcgis/rest/services/GlobalHAND/"
    "GLO30_HAND/ImageServer/exportImage"
)
HAND_SERVICE = "ASF GLO-30 HAND v1 (Copernicus GLO-30 derived)"
HAND_LICENSE = "CC0 1.0"

# lon_min, lat_min, lon_max, lat_max.
#
# Wider than the 132 real towers' ~2 km hull (101.592..101.613, 3.057..3.079)
# because fixtures/towers.ts scatters the offline demo towers across this whole
# box. With the tight hull the offline console would ring towers standing on
# bare basemap.
AOI_BBOX = (101.55, 3.00, 101.68, 3.14)

# Metres above nearest drainage. Chosen against the real HAND distribution
# (p50 = 1.12 m, p75 = 3.01 m, max = 15.96 m) so the ladder actually separates
# sites: 40% of towers sit below 0.5 m and 83% below 5 m.
STAGES_M = (0.5, 1.0, 2.0, 3.0, 5.0)

# Must match WATER_RGB in src/frontend/src/components/map/inundationLayer.ts.
WATER_RGB = (43, 108, 184)

TARGET_WIDTH_PX = 1024

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

_THIS_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _THIS_DIR.parent.parent.parent
OUTPUT_DIR = _REPO_ROOT / "src" / "frontend" / "public" / "flood"


def mercator_y(lat_deg: float) -> float:
    """Web Mercator northing for a latitude, in radians of the projected plane."""
    return math.log(math.tan(math.radians(45 + lat_deg / 2)))


def mercator_image_size(bbox: tuple[float, float, float, float], width_px: int) -> tuple[int, int]:
    """Pixel size whose aspect matches the bbox's *Mercator* extent.

    MapLibre warps an `image` source linearly between four corner coordinates in
    Mercator space, so the export has to be Mercator too (imageSR=3857) and its
    aspect has to match. If it does not, ArcGIS quietly expands the bbox to fill
    the requested frame and the coordinates handed to MapLibre no longer describe
    the pixels that came back — the water lands a few hundred metres off, which
    looks entirely plausible on screen.
    """
    lon_min, lat_min, lon_max, lat_max = bbox
    span_x = math.radians(lon_max - lon_min)
    span_y = mercator_y(lat_max) - mercator_y(lat_min)
    return width_px, round(width_px * span_y / span_x)


def rendering_rule(stage_m: float) -> str:
    """ArcGIS raster function that returns wet-blue over transparent-dry.

    Remap sends HAND <= stage to the single class 1 and sends everything above it
    to NoData; Colormap then paints class 1. The NoDataRanges half is what
    produces the alpha channel — remapping dry ground to a second output value
    instead returns an opaque white sheet covering the entire AOI.
    """
    remap = {
        "rasterFunction": "Remap",
        "rasterFunctionArguments": {
            "InputRanges": [-1, stage_m],
            "OutputValues": [1],
            "NoDataRanges": [stage_m, 10000],
            "AllowUnmatched": False,
        },
    }
    colormap = {
        "rasterFunction": "Colormap",
        "rasterFunctionArguments": {
            "Colormap": [[1, *WATER_RGB]],
            "Raster": remap,
        },
    }
    return json.dumps(colormap, separators=(",", ":"))


def stage_slug(stage_m: float) -> str:
    """`2.0 -> "2"`, `0.5 -> "0p5"`.

    Mirrors stageSlug() in src/frontend/src/lib/inundation.ts. The two must agree
    exactly: the filename is the only join between the producer and the layer,
    and a MapLibre `image` source pointed at a 404 renders nothing without
    raising an error anyone will see.
    """
    return f"{stage_m:g}".replace(".", "p")


def stage_file(stage_m: float) -> str:
    return f"hand_le_{stage_slug(stage_m)}.png"


def fetch_stage(stage_m: float, size: tuple[int, int]) -> bytes:
    """Download one thresholded stage as a PNG, or raise SourceError."""
    width, height = size
    query = urllib.parse.urlencode(
        {
            "bbox": ",".join(f"{v:g}" for v in AOI_BBOX),
            "bboxSR": "4326",
            "imageSR": "3857",
            "size": f"{width},{height}",
            "format": "png32",
            "noData": "0",
            "renderingRule": rendering_rule(stage_m),
            "f": "image",
        }
    )
    payload = request_bytes(f"{HAND_EXPORT}?{query}")
    if not payload.startswith(PNG_SIGNATURE):
        # The service answers errors with a JSON body under HTTP 200, so a status
        # check would pass one straight through into a .png file.
        head = payload[:200].decode("utf-8", "replace")
        raise SourceError(f"HAND export for stage {stage_m} m returned non-PNG payload: {head}")
    return payload


def prepare(args: argparse.Namespace) -> dict:
    output: Path = args.output
    output.mkdir(parents=True, exist_ok=True)
    size = mercator_image_size(AOI_BBOX, args.width)

    stages = []
    for stage_m in STAGES_M:
        name = stage_file(stage_m)
        path = output / name
        if path.exists() and not args.refresh:
            payload = path.read_bytes()
        else:
            payload = fetch_stage(stage_m, size)
            path.write_bytes(payload)
        stages.append(
            {
                "stage_m": stage_m,
                "file": name,
                "bytes": len(payload),
                "sha256": sha256_bytes(payload),
            }
        )

    manifest = {
        "bbox": list(AOI_BBOX),
        "bbox_crs": "EPSG:4326",
        "image_crs": "EPSG:3857",
        "image_size": list(size),
        "water_rgb": list(WATER_RGB),
        "stages": stages,
        "source": HAND_SERVICE,
        "source_url": HAND_EXPORT,
        "license": HAND_LICENSE,
        "rendering_rule": rendering_rule(STAGES_M[0]),
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": (
            "Terrain threshold on height above nearest drainage: each surface marks "
            "ground at or below the stated water level. Not a hydraulic model, not a "
            "forecast, and not a statement about any structure standing on that ground."
        ),
    }
    write_json(output / "manifest.json", manifest)
    return manifest


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--output", type=Path, default=OUTPUT_DIR,
        help="output directory (default: src/frontend/public/flood)",
    )
    result.add_argument(
        "--width", type=int, default=TARGET_WIDTH_PX,
        help=f"export width in pixels (default: {TARGET_WIDTH_PX})",
    )
    result.add_argument("--refresh", action="store_true", help="re-download existing stages")
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    if not 256 <= args.width <= 4096:
        print("--width must be between 256 and 4096", file=sys.stderr)
        return 2
    try:
        manifest = prepare(args)
    except (SourceError, urllib.error.URLError, urllib.error.HTTPError) as error:
        print(f"flood surface preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
