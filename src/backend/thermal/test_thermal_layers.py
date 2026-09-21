"""Unit tests for the active-fire catalogue and its two pure composers.

Network-free by construction: no builder is called, nothing initialises Earth
Engine, and the two composers are exercised against MagicMock images so the call
chain can be read back. What is worth asserting without credentials is the shape
of the catalogue, the honesty of its copy, and three facts inside the module
that no credential-free test could otherwise measure — that the detection mask
comes off a masked band, that the window is summed per day rather than
mosaicked, and that the tiles take their window from the same snapshot the tower
evidence does.

One test here is about the package name rather than the layer. `fire` 0.7.1
(google/python-fire) is installed in this venv as a hydrafloods dependency, and a
regular package beats a namespace portion regardless of sys.path order — so a
`src/backend/fire/` could not be imported at all, and forcing it to win would
have shadowed python-fire for hydrafloods and broken the radar flood layers
silently. The Python package is `thermal/`; everything user-facing is still
called fire.

Run from src/backend:  python3 thermal/test_thermal_layers.py   (or via pytest)
"""

import ast
import importlib.util
import inspect
import sys
from pathlib import Path
from unittest.mock import MagicMock

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from fastapi import HTTPException

from api.routes.fire import get_tiles
from thermal.layers import (
    BY_ID,
    CONFIDENCE_LABELS,
    CONFIDENCE_MIN,
    DETECTION_BAND,
    FIRE_LAYER_BBOX,
    FIRE_LAYERS,
    FIRE_LOOKBACK_DAYS,
    FIRE_SCREEN_BBOX,
    PIXEL_DAY_PALETTE,
    VIIRS_ASSET,
    VIIRS_CRS,
    VIIRS_SCALE_M,
    build_active_fire,
    pixel_day_image,
    screen_detections,
)
from tiles.engine import InvalidDate, LayerUnavailable, tiles_for, window_for

# Limiting words a description may use to state what a layer cannot answer.
# Same set land/test_land_layers.py checks against, for the same reason.
_LIMITS = (" not ", "never", "cannot", "too coarse")


def _imported_top_level(path: Path) -> set[str]:
    """Top-level package names a module imports, read from its AST.

    Parsed rather than grepped throughout this file: both thermal modules
    discuss the flood and land catalogues in their prose on purpose, and a
    substring check would grade the comments instead of the code.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name.split(".")[0] for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    return imported


def test_catalogue_ids_are_unique_and_indexed():
    ids = [layer.layer_id for layer in FIRE_LAYERS]
    assert len(ids) == len(set(ids)), f"duplicate layer ids: {ids}"
    assert set(BY_ID) == set(ids)


def test_the_catalogue_is_one_layer_with_a_builder_in_the_fire_group():
    # `group` defaults to "water" on the Layer record, so leaving it off would
    # render the one fire layer inside the flood panel — beside four layers that
    # DO map to model features, with nothing saying this one does not.
    assert len(FIRE_LAYERS) == 1
    for layer in FIRE_LAYERS:
        assert layer.kind == "ee", f"{layer.layer_id} is not an Earth Engine layer"
        assert layer.builder is not None, f"{layer.layer_id} has no builder"
        assert layer.group == "fire", f"{layer.layer_id} is not in the fire group"
        assert layer.bounds == FIRE_LAYER_BBOX


def test_every_layer_declares_attribution_and_legend():
    # Attribution is a licence obligation for NASA FIRMS/LANCE data, and a
    # legend-less colour on a map is decoration rather than a reading.
    for layer in FIRE_LAYERS:
        assert layer.attribution.strip(), f"{layer.layer_id} has no attribution"
        assert layer.legend, f"{layer.layer_id} has no legend"
        assert "NASA" in layer.attribution and "VIIRS" in layer.attribution


def test_legend_labels_carry_a_number_and_match_the_palette():
    # Warm hues on this map also mean tower severity. A fire legend entry must
    # carry the count it stands for, never a bare adjective — and the colours
    # must be the ones the builder actually paints, or the key describes a map
    # nobody is looking at.
    for layer in FIRE_LAYERS:
        for entry in layer.legend:
            assert any(ch.isdigit() for ch in entry["label"]), (
                f"{layer.layer_id} legend entry {entry['label']!r} carries no number"
            )
    assert [entry["color"] for entry in BY_ID["active_fire"].legend] == [
        f"#{colour}" for colour in PIXEL_DAY_PALETTE
    ]


def test_the_description_says_what_a_hotspot_is_not():
    # The whole feature rests on this sentence. A 375 m thermal anomaly can be a
    # plantation burn, a flare or hot bare ground, and a description that only
    # says "active fire" invites a planner to read damage into it.
    description = BY_ID["active_fire"].description
    assert any(limit in description for limit in _LIMITS)
    assert "375 m" in description
    assert "risk score" in description, "the description must say it does not feed the score"


def test_the_layer_is_a_dated_observation_not_a_forecast():
    # Load-bearing rather than cosmetic: the frontend rewrites a forecast
    # layer's date to the literal 'latest', which would quietly detach this
    # layer from the date the rest of the console is showing.
    layer = BY_ID["active_fire"]
    assert layer.dated is True
    assert layer.temporal_kind == "observation"
    assert layer.unit == "detection-days"


def test_no_fire_layer_declares_a_sensor_selector():
    # There is no second source for this, and an empty tuple is what makes the
    # engine skip sensor validation entirely. The frontend's `sensor` is one
    # global store value shared with the flood panel, so a fire sensor list
    # would fight Sentinel-1/2 selection over the same control.
    for layer in FIRE_LAYERS:
        assert not layer.sensors, f"{layer.layer_id} declares a sensor selector"
        assert layer.to_dict()["sensors"] == []


def test_no_fire_layer_needs_hydrafloods():
    # This is not a radar product. Setting the flag would make the whole group
    # depend on requirements-flood.txt for no reason — and, given the name
    # collision this package is named around, on the very distribution that
    # installs python-fire.
    for layer in FIRE_LAYERS:
        assert not layer.needs_hydrafloods, f"{layer.layer_id} pulls in HYDRAFloods"


def test_confidence_labels_are_the_inferred_low_nominal_high_ordering():
    # The values are exactly {0, 1, 2}; the labels are inferred from the
    # measured global distribution for 2026-09-09 (9.22 / 83.69 / 7.09 %), not
    # read off a band description. Low is excluded, so the two labels a tower
    # can ever carry are nominal and high.
    assert CONFIDENCE_LABELS == {0: "low", 1: "nominal", 2: "high"}
    assert CONFIDENCE_MIN == 1
    assert [
        label for value, label in sorted(CONFIDENCE_LABELS.items()) if value >= CONFIDENCE_MIN
    ] == ["nominal", "high"]


def test_the_reduction_constants_are_the_collections_own_grid():
    # 375 m and SR-ORG:6974 are the asset's native scale and projection. Both
    # are passed to every reduction: without the crs the reduction resamples
    # onto a 375 m WGS84 grid and counts a slightly different pixel set (top
    # tower 38 detection-days against 36, 40 towers with detections against 41),
    # and a count of satellite pixels that changes with the output grid is not a
    # count.
    assert VIIRS_SCALE_M == 375
    assert VIIRS_CRS == "SR-ORG:6974"
    assert VIIRS_ASSET == "NASA/LANCE/NOAA20_VIIRS/C2"


def test_the_screening_bbox_is_malaysia_and_sits_inside_the_drawn_extent():
    # Freshness and tower screening are questions about this fleet's ground.
    # Taking the newest acquisition from the 50-degree drawn extent would report
    # a fire in Myanmar as news about Malaysian towers.
    west, south, east, north = FIRE_SCREEN_BBOX
    layer_west, layer_south, layer_east, layer_north = FIRE_LAYER_BBOX
    assert layer_west <= west < east <= layer_east
    assert layer_south <= south < north <= layer_north
    assert west < 101.61 < east and south < 3.07 < north, "the AOI must be inside it"


def test_screen_detections_masks_from_the_detection_band_never_from_confidence():
    """The mask comes off Bright_ti4, and confidence is only ever a threshold.

    `confidence` and `DayNight` are unmasked and 0-filled across the whole
    footprint — 12.7 million zero pixels over the Malaysia bbox alone — so
    `confidence.neq(0)` would read open ocean as confidence data and drop every
    genuine low-confidence detection into the same bucket as it.

    MagicMock rather than a real image, the way flood/test_layers.py drives
    `_compose_flood_extent`: the call chain is the only thing a credential-free
    test can read, and it is exactly what went wrong.
    """
    bands = {
        DETECTION_BAND: MagicMock(name="bright_ti4"),
        "confidence": MagicMock(name="confidence"),
    }
    image = MagicMock(name="image")
    # Raises on any other band, so this also asserts nothing else is selected.
    image.select.side_effect = lambda band: bands[band]

    result = screen_detections(image)

    detected = bands[DETECTION_BAND].mask.return_value
    bands[DETECTION_BAND].mask.assert_called_once_with()
    # Confidence is thresholded, never masked-from and never compared to zero.
    bands["confidence"].mask.assert_not_called()
    bands["confidence"].neq.assert_not_called()
    bands["confidence"].updateMask.assert_called_once_with(detected)
    bands["confidence"].updateMask.return_value.gte.assert_called_once_with(CONFIDENCE_MIN)

    keep = bands["confidence"].updateMask.return_value.gte.return_value
    image.updateMask.assert_called_once_with(detected)
    image.updateMask.return_value.updateMask.assert_called_once_with(keep)
    assert result is image.updateMask.return_value.updateMask.return_value


def test_pixel_day_image_sums_per_day_masks_and_never_mosaics():
    """Per-image first, then summed — and unmasked to 0 after, not before.

    Mosaicking the window takes confidence from the LAST image at every pixel
    while taking Bright_ti4 from whichever image actually had a detection,
    pairing each detection with an unrelated day's confidence. Measured, the
    mosaic cross-tab reports 94.6% "low confidence" where correct per-image
    pairing gives ~3%.

    The `unmask(0)` is what makes a quiet pixel read 0 rather than masked, so
    the reduction downstream has a number to sum instead of a gap.
    """
    collection = MagicMock(name="screened_collection")

    result = pixel_day_image(collection)

    collection.mosaic.assert_not_called()
    collection.map.assert_called_once()

    # The mapped function is the per-day presence mask. Applied to one image it
    # must take .mask() off the band — a count of DAYS carrying a detection,
    # never the brightness or the confidence value itself.
    per_day = collection.map.call_args[0][0]
    day = MagicMock(name="screened_day")
    assert per_day(day) is day.select.return_value.mask.return_value.rename.return_value
    day.select.assert_called_once_with("confidence")
    day.select.return_value.mask.assert_called_once_with()
    day.select.return_value.mask.return_value.rename.assert_called_once_with("pixel_days")

    mapped = collection.map.return_value
    mapped.sum.assert_called_once_with()
    mapped.sum.return_value.unmask.assert_called_once_with(0)
    assert result is mapped.sum.return_value.unmask.return_value.rename.return_value


def test_the_window_is_the_selected_day_and_the_two_before_it():
    # Three calendar days, end exclusive. Wide enough that a single cloudy or
    # missed overpass does not read as "no fire", narrow enough that a pixel-day
    # count still describes something current.
    assert FIRE_LOOKBACK_DAYS == 2
    assert window_for("2026-09-11", FIRE_LOOKBACK_DAYS) == ("2026-09-09", "2026-09-12")
    assert window_for("2026-03-01", FIRE_LOOKBACK_DAYS) == ("2026-02-27", "2026-03-02")


def test_tiles_and_tower_evidence_come_from_one_snapshot_call():
    """One function resolves the window for both the raster and the panel.

    Deriving them separately is how a map ends up describing a different window
    than the evidence list beside it — and `snapshot_id`, which is what makes an
    expired review detectable, would then mean two different things depending on
    which half of the screen produced it.

    Matches the CALL, not the word: both docstrings discuss the snapshot in
    prose, and matching that would grade the comments.
    """
    from thermal.exposure import screen_towers

    assert "snapshot_for(date)" in inspect.getsource(build_active_fire)
    assert "snapshot_for(date)" in inspect.getsource(screen_towers)


def test_zero_granules_is_an_outage_and_zero_hotspots_is_not():
    """scene_count is reached, and nothing else raises on a quiet sky.

    The archive has no granule for the current UTC day for most of the working
    day (measured 2026-09-10: newest index 2026252, i.e. yesterday), so a `date`
    of today usually yields 2 images rather than 3. Only ZERO granules is the
    honest outage — "the archive has no observation for this window" — and a
    window with images but no detections must come back as a perfectly ordinary
    empty raster.
    """
    source = inspect.getsource(build_active_fire)
    assert "scene_count(" in source
    assert "selfMask()" in source, "a zero-detection window must draw nothing, not 503"


def test_bad_date_is_rejected_before_earth_engine_is_touched():
    # The ordering guard. Without credentials this must still be InvalidDate,
    # never LayerUnavailable — otherwise a typo is reported as a missing
    # dependency and the caller installs earthengine-api for nothing.
    try:
        tiles_for(BY_ID["active_fire"], "not-a-date")
    except InvalidDate:
        return
    except LayerUnavailable as error:
        raise AssertionError(f"date validation ran after EE init: {error}")
    raise AssertionError("a malformed date should not be accepted")


def test_unknown_layer_is_a_404_from_the_route_not_an_outage():
    # A flood or land layer id lands here too: each route indexes only its own
    # catalogue. Retrying a misspelling would never succeed, so 503 would tell
    # the frontend to keep asking.
    try:
        get_tiles("flood_extent", "2026-09-11")
    except HTTPException as error:
        assert error.status_code == 404
    else:
        raise AssertionError("an unknown layer should not yield tiles")


def test_ids_do_not_collide_across_all_three_catalogues():
    # `active` and `opacity` in the frontend store are keyed by layer id across
    # every panel, so a collision would make one layer's toggle move another's.
    # The existing check in land/test_land_layers.py is pairwise land∩flood;
    # this one spans all three, which is the only place they meet.
    from flood.layers import FLOOD_LAYERS
    from land.layers import LAND_LAYERS

    catalogues = {
        "fire": {layer.layer_id for layer in FIRE_LAYERS},
        "flood": {layer.layer_id for layer in FLOOD_LAYERS},
        "land": {layer.layer_id for layer in LAND_LAYERS},
    }
    for left in catalogues:
        for right in catalogues:
            if left >= right:
                continue
            overlap = catalogues[left] & catalogues[right]
            assert not overlap, f"layer ids shared between {left} and {right}: {overlap}"


def test_thermal_modules_import_neither_flood_nor_land():
    # Peers, not parent and child. Two couplings inside the old shared tiles_for
    # were already latent bugs; a fire builder reaching into flood/ would be the
    # first thread of exactly the coupling the split exists to remove.
    for module in ("layers.py", "exposure.py"):
        imported = _imported_top_level(Path(__file__).resolve().parent / module)
        assert "flood" not in imported, f"thermal/{module} imports the flood package"
        assert "land" not in imported, f"thermal/{module} imports the land package"
        assert "tiles" in imported, f"thermal/{module} must sit on the shared tile engine"


def test_nothing_under_src_backend_imports_a_top_level_fire_module():
    """The bug that actually bit, pinned so the next domain package does not.

    `fire` 0.7.1 (google/python-fire) is installed in this venv as a hydrafloods
    dependency, and a regular package with `__init__.py` beats a PEP-420
    namespace portion no matter the sys.path order. So `import fire.exposure`
    raised ModuleNotFoundError against a directory that was plainly there — and
    forcing it to win with an `__init__.py` would have shadowed python-fire for
    hydrafloods and simplecmr/cli.py, breaking the radar flood layers silently
    and only once Earth Engine was actually reached.

    Nothing raises at import time either way: `import fire` succeeds, it is just
    somebody else's package.
    """
    spec = importlib.util.find_spec("fire")
    assert spec is not None and spec.origin is not None
    assert not spec.origin.startswith(str(_BACKEND / "fire")), (
        "src/backend/fire/ is back; it cannot win this name and must not try"
    )

    offenders = []
    for path in sorted(_BACKEND.rglob("*.py")):
        if ".venv" in path.parts or "__pycache__" in path.parts:
            continue
        if "fire" in _imported_top_level(path):
            offenders.append(str(path.relative_to(_BACKEND)))
    assert not offenders, (
        f"these modules import the venv's python-fire, not this package: {offenders}"
    )


def test_the_python_package_is_thermal_while_everything_user_facing_is_fire():
    # The split the name collision forced. The route prefix, the Layer group and
    # the frontend's LayerGroup member all stay 'fire'; only the import path is
    # thermal, and it is the honest name for what the sensor measures anyway.
    from api.routes.fire import router
    from thermal.exposure import screen_towers, snapshot_for

    assert screen_towers.__module__ == "thermal.exposure"
    assert snapshot_for.__module__ == "thermal.exposure"
    assert router.prefix == "/fire"
    assert BY_ID["active_fire"].group == "fire"


def test_exposure_route_rejects_a_malformed_date_as_a_caller_error():
    """400, never 500, and never 503.

    This test exists because the opposite shipped. `parse_date` was called
    OUTSIDE the route's try block, so InvalidDate — a ValueError — escaped
    uncaught and FastAPI rendered a bare text/plain 500. Downstream that is
    worse than it sounds: the frontend's error reader only recovers a JSON
    `detail`, so the panel showed a failure with no reason, and because the
    exposure query is wrapped in withOfflineFallback the throw also tripped the
    app-wide offline banner — all for a mistyped date.

    Reproduced on every malformed shape below before the fix.
    """
    from api.routes.fire import get_exposure

    for bad in ("not-a-date", "2026-13-45", "2026/09/11", "", "11-09-2026", "2026-09-11T00:00:00Z"):
        try:
            get_exposure(bad)
        except HTTPException as error:
            assert error.status_code == 400, f"{bad!r} gave {error.status_code}, want 400"
            continue
        except Exception as error:  # noqa: BLE001 - the point is that nothing else escapes
            raise AssertionError(
                f"{bad!r} raised {type(error).__name__} rather than a 400: {error}"
            ) from error
        raise AssertionError(f"{bad!r} should not be accepted as a date")


def test_every_fire_route_is_registered_on_the_app():
    """The three paths the frontend asks for, spelled as it spells them.

    A router that is written but never included is invisible to every test that
    calls its functions directly — which is all of the others here.
    """
    from api.main import app

    # Read off the OpenAPI schema rather than app.routes. Routers included from
    # another module appear in app.routes as wrapper objects with no `path`, so
    # walking that list finds only the handful of routes declared on the app
    # itself and a missing /fire router would look exactly like a present one.
    paths = set(app.openapi()["paths"])
    for path in ("/fire/layers", "/fire/tiles/{layer_id}", "/fire/exposure"):
        assert path in paths, f"{path} is not registered; registered: {sorted(paths)}"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
