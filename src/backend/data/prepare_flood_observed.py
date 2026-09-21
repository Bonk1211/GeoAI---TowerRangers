"""Observed surface water over the Sunway AOI from Sentinel-1, via HYDRAFloods.

Companion to prepare_flood_surface.py. That script renders *scenario* extents
from terrain — ground below a chosen water level. This one renders an *observed*
extent for a real event, over the identical bounding box and in the identical
projection, so the two can be laid over each other and the scenario checked
against something that actually happened.

The default window brackets the December 2021 Klang Valley flood.

Developer-run, and its output is committed. Nothing at runtime imports Earth
Engine: hydrafloods requires an authenticated Google Earth Engine session, which
is a credentialed live-network call and has no business on a demo path.

    pip install -r ../requirements-flood.txt
    gcloud init && earthengine authenticate
    python3 prepare_flood_observed.py --project <gcp-project-id>

Threshold note: edge_otsu picks its water/land cut from the SAR backscatter
histogram along detected edges rather than from a fixed value, so it adapts to
the scene. It is still a radar classifier — smooth dry surfaces can read as
water and flooding under vegetation can read as land. The output is "what
Sentinel-1 saw", not ground truth, and the manifest entry says so.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

from prepare_flood_surface import (
    AOI_BBOX,
    OUTPUT_DIR,
    PNG_SIGNATURE,
    TARGET_WIDTH_PX,
    WATER_RGB,
    mercator_image_size,
)
from prepare_pilot_dataset import SourceError, request_bytes, sha256_bytes, write_json

# Sentinel-1 VV backscatter, in dB. The initial threshold only seeds edge
# detection; edge_otsu then picks the real cut per scene. -16 dB is the value
# HYDRAFloods' own documentation uses for open water over the Mekong — same
# sensor, comparable tropical setting.
INITIAL_THRESHOLD_DB = -16.0
THRESH_NO_DATA_DB = -20.0

DEFAULT_START = "2021-12-17"
DEFAULT_END = "2021-12-22"


def _import_earth_engine():
    """Import ee + hydrafloods, or raise SourceError naming the setup steps.

    Imported inside a function rather than at module scope so that importing
    this file — which pytest does when it collects this directory — does not
    require Earth Engine to be installed at all.
    """
    try:
        import ee
        import hydrafloods as hf
    except ImportError as error:
        raise SourceError(
            f"Earth Engine dependencies are not installed ({error}). Run:\n"
            "  pip install -r src/backend/requirements-flood.txt\n"
            "  gcloud init && earthengine authenticate"
        ) from error
    return ee, hf


def observed_water_png(args: argparse.Namespace) -> tuple[bytes, int]:
    """Fetch the observed water mask as a PNG, plus the scene count behind it."""
    ee, hf = _import_earth_engine()

    try:
        ee.Initialize(project=args.project)
    except Exception as error:
        # The EE client raises several unrelated exception types for auth,
        # quota and project-configuration failures; all of them mean the same
        # thing to a caller here, and none should fall through as a traceback.
        raise SourceError(
            f"Earth Engine could not initialise for project {args.project!r} ({error}). "
            "Confirm the project has the Earth Engine API enabled, then run:\n"
            "  gcloud init && earthengine authenticate"
        ) from error

    region = ee.Geometry.Rectangle(list(AOI_BBOX))
    scenes = hf.Sentinel1(region, args.start, args.end)
    n_images = scenes.n_images
    if n_images == 0:
        # Raise rather than widening the window automatically. Sentinel-1's
        # revisit here is about six days, so a short window legitimately returns
        # nothing — but silently sliding the dates would make the label on the
        # map ("observed, Dec 2021") describe imagery from a different week.
        raise SourceError(
            f"no Sentinel-1 scenes over the AOI for {args.start}..{args.end}. "
            "Widen the window explicitly with --start/--end."
        )

    water = scenes.apply_func(
        hf.thresholding.edge_otsu,
        initial_threshold=INITIAL_THRESHOLD_DB,
        band="VV",
        thresh_no_data=THRESH_NO_DATA_DB,
    ).collection.max()

    width, height = mercator_image_size(AOI_BBOX, args.width)
    palette = ["%02x%02x%02x" % WATER_RGB]
    # selfMask() before visualize(), or dry ground is painted opaque black and
    # the layer becomes a hole punched in the map rather than a surface on it.
    url = water.selfMask().visualize(palette=palette).getThumbURL(
        {
            "region": region,
            "dimensions": f"{width}x{height}",
            "format": "png",
            # getThumbURL defaults to EPSG:4326. The HAND stages share this
            # image source's coordinates and are exported in Mercator, so an
            # unprojected observed layer would sit visibly offset from them.
            "crs": "EPSG:3857",
        }
    )
    payload = request_bytes(url)
    if not payload.startswith(PNG_SIGNATURE):
        head = payload[:200].decode("utf-8", "replace")
        raise SourceError(f"Earth Engine thumbnail returned non-PNG payload: {head}")
    return payload, n_images


def prepare(args: argparse.Namespace) -> dict:
    output: Path = args.output
    manifest_path = output / "manifest.json"
    if not manifest_path.exists():
        raise SourceError(
            f"{manifest_path} not found — run prepare_flood_surface.py first, so the "
            "observed extent is recorded alongside the stages it is compared against."
        )

    payload, n_images = observed_water_png(args)
    name = f"observed_{args.start}.png"
    (output / name).write_bytes(payload)

    entry = {
        "file": name,
        "bytes": len(payload),
        "sha256": sha256_bytes(payload),
        "start": args.start,
        "end": args.end,
        "sensor": "Copernicus Sentinel-1 GRD, VV",
        "algorithm": (
            f"hydrafloods.thresholding.edge_otsu (initial {INITIAL_THRESHOLD_DB} dB, "
            f"no-data {THRESH_NO_DATA_DB} dB), per-scene max over the window"
        ),
        "scenes": n_images,
        "ee_project": args.project,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "note": (
            "What Sentinel-1 saw in this window, not ground truth. Radar reads some "
            "smooth dry surfaces as water and can miss flooding under vegetation. "
            "Shown alongside the HAND stages for comparison, not as a correction to them."
        ),
    }

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["observed"] = entry
    write_json(manifest_path, manifest)
    return entry


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--project", required=True,
        help="Google Cloud project id with the Earth Engine API enabled",
    )
    result.add_argument("--start", default=DEFAULT_START, help=f"window start (default: {DEFAULT_START})")
    result.add_argument("--end", default=DEFAULT_END, help=f"window end (default: {DEFAULT_END})")
    result.add_argument(
        "--output", type=Path, default=OUTPUT_DIR,
        help="output directory (default: src/frontend/public/flood)",
    )
    result.add_argument(
        "--width", type=int, default=TARGET_WIDTH_PX,
        help=f"export width in pixels (default: {TARGET_WIDTH_PX})",
    )
    return result


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        entry = prepare(args)
    except (SourceError, urllib.error.URLError, urllib.error.HTTPError) as error:
        print(f"observed flood extent preparation failed: {error}", file=sys.stderr)
        return 1
    print(json.dumps(entry, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
