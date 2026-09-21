"""Unit tests for the deterministic parts of the flood-surface producer.

No network: every assertion here is about a value computed locally before any
request is made. The two that matter are the Mercator sizing (a wrong aspect
silently shifts the whole surface off the ground it describes) and the NoData
half of the rendering rule (without it the export is an opaque white sheet)."""

import json
import math
import re

from prepare_flood_surface import (
    AOI_BBOX,
    STAGES_M,
    WATER_RGB,
    mercator_image_size,
    mercator_y,
    rendering_rule,
    stage_file,
    stage_slug,
)


def test_mercator_image_size_matches_extent_aspect():
    lon_min, lat_min, lon_max, lat_max = AOI_BBOX
    width, height = mercator_image_size(AOI_BBOX, 1024)
    assert width == 1024
    expected = 1024 * (mercator_y(lat_max) - mercator_y(lat_min)) / math.radians(lon_max - lon_min)
    # Rounding to whole pixels is the only allowed difference. Assert against the
    # projected span rather than the raw degree ratio: the two differ by ~1.5 px
    # here and by far more away from the equator, and the degree ratio is exactly
    # the mistake that puts the surface off the ground it describes.
    assert abs(height - expected) <= 1


def test_rendering_rule_marks_dry_ground_nodata():
    rule = json.loads(rendering_rule(2.0))
    assert rule["rasterFunction"] == "Colormap"
    assert rule["rasterFunctionArguments"]["Colormap"] == [[1, *WATER_RGB]]

    remap = rule["rasterFunctionArguments"]["Raster"]
    assert remap["rasterFunction"] == "Remap"
    args = remap["rasterFunctionArguments"]
    assert args["InputRanges"] == [-1, 2.0]
    assert args["OutputValues"] == [1]
    # The alpha guard: dry ground must become NoData, not a second output class.
    assert args["NoDataRanges"] == [2.0, 10000]
    assert args["AllowUnmatched"] is False


def test_stage_slug_is_filename_safe():
    assert stage_slug(0.5) == "0p5"
    assert stage_slug(2.0) == "2"
    assert stage_file(0.5) == "hand_le_0p5.png"
    for stage_m in STAGES_M:
        assert re.fullmatch(r"[0-9p]+", stage_slug(stage_m))


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
