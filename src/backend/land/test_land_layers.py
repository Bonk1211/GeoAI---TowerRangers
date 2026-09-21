"""Unit tests for the vegetation and ground-condition catalogue.

Network-free by construction: no builder is called, nothing initialises Earth
Engine. What is worth asserting without credentials is the shape of the
catalogue, the honesty of its copy, and two ordering facts inside builders that
no credential-free test could otherwise measure.

Run from src/backend:  python3 land/test_land_layers.py   (or via pytest)
"""

import ast
import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from land.layers import (
    BY_ID,
    LAND_LAYER_BBOX,
    LAND_LAYERS,
    SMAP_LOOKBACK_DAYS,
    WORLDCOVER_CLASSES,
    build_ground_slope,
    build_vegetation_vigour,
)

# Limiting words a description may use to state what a layer cannot answer.
_LIMITS = (" not ", "never", "cannot", "too coarse")


def test_catalogue_ids_are_unique_and_indexed():
    ids = [layer.layer_id for layer in LAND_LAYERS]
    assert len(ids) == len(set(ids)), f"duplicate layer ids: {ids}"
    assert set(BY_ID) == set(ids)


def test_every_layer_has_a_builder_and_the_land_group():
    for layer in LAND_LAYERS:
        assert layer.kind == "ee", f"{layer.layer_id} is not an Earth Engine layer"
        assert layer.builder is not None, f"{layer.layer_id} has no builder"
        assert layer.group == "land", f"{layer.layer_id} is not in the land group"
        assert layer.bounds == LAND_LAYER_BBOX


def test_every_layer_declares_attribution_and_legend():
    # Attribution is a licence obligation for Copernicus, ESA, NASA and
    # OpenLandMap data, and a legend-less colour on a map is decoration rather
    # than a reading.
    for layer in LAND_LAYERS:
        assert layer.attribution.strip(), f"{layer.layer_id} has no attribution"
        assert layer.legend, f"{layer.layer_id} has no legend"


def test_layer_temporal_kinds_are_observations():
    # Measurements and classifications, not scenarios or forecasts — including
    # the undated ones. The frontend renders this value as a badge.
    assert {layer.temporal_kind for layer in LAND_LAYERS} == {"observation"}


def test_no_land_layer_declares_a_sensor_selector():
    # There is no second source for any of these, and an empty tuple is what
    # makes the engine skip sensor validation entirely. A sensor here would be
    # checked against a list this domain does not own.
    for layer in LAND_LAYERS:
        assert not layer.sensors, f"{layer.layer_id} declares a sensor selector"


def test_no_land_layer_needs_hydrafloods():
    # None of these is a radar product. Setting the flag would make the whole
    # group depend on requirements-flood.txt for no reason.
    for layer in LAND_LAYERS:
        assert not layer.needs_hydrafloods, f"{layer.layer_id} pulls in HYDRAFloods"


def test_legends_are_quantified_or_named_classes():
    # Warm hues on this map also mean tower severity. A land legend entry must
    # carry a number or an ESA land-cover class name, never a bare adjective.
    classes = {label for _, label, _ in WORLDCOVER_CLASSES}
    for layer in LAND_LAYERS:
        for entry in layer.legend:
            label = entry["label"]
            assert any(ch.isdigit() for ch in label) or label in classes, (
                f"{layer.layer_id} legend entry {label!r} carries no number or class"
            )


def test_worldcover_classes_match_the_esa_palette_exactly():
    # A recoloured or reordered land-cover map cannot be checked against ESA's
    # own legend, and remap() pairs these two lists positionally.
    values = [value for value, _, _ in WORLDCOVER_CLASSES]
    assert values == sorted(values)
    assert len(values) == len(set(values)) == 11
    assert (10, "Tree cover", "006400") in WORLDCOVER_CLASSES
    assert (50, "Built-up", "fa0000") in WORLDCOVER_CLASSES


def test_evi_scales_reflectance_before_applying_the_expression():
    # NDVI is a normalised difference and the Sentinel-2 x10000 scale cancels.
    # EVI's +L and its coefficients do not: on raw DN the constant is rounding
    # noise and every pixel is wrong while the image still looks plausible. No
    # credential-free test can measure that, so assert the ordering.
    source = inspect.getsource(build_vegetation_vigour)
    assert "S2_REFLECTANCE_SCALE" in source
    # Match the call, not the word: the comment above it also says "expression",
    # and matching that would have this test grade the prose instead of the code.
    assert source.index("S2_REFLECTANCE_SCALE") < source.index(".expression(")
    assert "clamp" in source, "EVI must be clamped; its denominator can near zero"


def test_ground_slope_pins_its_projection_before_computing_slope():
    # ee.Terrain.slope evaluates in the OUTPUT projection when its input has
    # none, so a mosaicked DEM yields slope that changes with map zoom: plausible
    # at every zoom and correct at none.
    source = inspect.getsource(build_ground_slope)
    # Match the call, not the name: the docstring above explains the trap using
    # the same words, and matching those would grade the prose, not the code.
    assert source.index("setDefaultProjection") < source.index("ee.Terrain.slope(")


def test_smap_window_clears_the_products_publication_lag():
    """The lookback must survive SMAP L4 publishing days behind real time.

    Measured against the live collection on 2026-08-30: the newest granule was
    2026-08-27T22:30Z, about 2.6 days back. A three-day window started at 08-28
    and missed it by three and a half hours, so the layer 503'd on today's date
    — the one date the UI defaults to and therefore the only one most people
    ever ask for. Anything below five days re-opens that.

    Widening is safe: the builder draws the single most recent granule it finds
    and reports its timestamp, so a wider window yields a stale-but-labelled
    reading rather than an error.
    """
    assert SMAP_LOOKBACK_DAYS >= 5, (
        f"a {SMAP_LOOKBACK_DAYS}-day window does not clear the observed ~3-day lag"
    )


def test_clause_coverage_is_stated_not_implied():
    # A vegetation layer described loosely implies a regulatory duty has been
    # discharged because a satellite saw something green. Every description that
    # cites a clause must also say what it cannot do.
    for layer in LAND_LAYERS:
        if "§6.3" not in layer.description:
            continue
        assert any(limit in layer.description for limit in _LIMITS), (
            f"{layer.layer_id} cites a clause without stating its limits"
        )


def test_ids_do_not_collide_with_the_flood_catalogue():
    # active/opacity in the frontend store are keyed by layer id across both
    # panels, so a collision would make one layer's toggle move the other's.
    # The only place the two catalogues meet in the backend, deliberately.
    from flood.layers import FLOOD_LAYERS

    overlap = {l.layer_id for l in LAND_LAYERS} & {l.layer_id for l in FLOOD_LAYERS}
    assert not overlap, f"layer ids shared with the flood catalogue: {overlap}"


def test_land_module_does_not_import_flood():
    # Peers, not parent and child. A land builder reaching into flood/ would
    # re-create the coupling the split exists to remove.
    #
    # Parsed, not grepped: the prose here refers to the flood catalogue in
    # several places on purpose, and a substring check would grade the comments.
    tree = ast.parse((Path(__file__).resolve().parent / "layers.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert "flood" not in imported, f"land/layers.py imports the flood package: {imported}"
    assert "tiles" in imported, "land/layers.py must sit on the shared tile engine"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
