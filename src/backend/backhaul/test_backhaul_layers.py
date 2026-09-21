"""Unit tests for the transmission-backbone catalogue.

Network-free by construction: the resolver is never called, so nothing reaches
ITU's GeoServer and nothing initialises Earth Engine. What is worth asserting
without a network is the shape of the catalogue, the isolation of the package
from its three peers, and the honesty of the copy — which here carries more
weight than usual, because the geometry behind it is schematic and the source is
four years old.

The load-bearing test in this file is
test_the_layer_never_enters_the_score_or_the_scheduler. Distance to this
backbone was measured at ROC-AUC 0.6075 against the maintenance label, below
`dist_power_m`'s 0.6919 and far below the served model's 0.910, so the layer is
context and may never become a factor. That is a decision a future edit could
undo in one line, and this test is what makes it fail loudly.

Run from src/backend:  python3 backhaul/test_backhaul_layers.py   (or via pytest)
"""

import ast
import sys
from urllib.parse import unquote
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from fastapi import HTTPException

from backhaul.layers import (
    BACKBONE_LAYERS,
    BACKBONE_SLD,
    BACKBONE_STROKE,
    BY_ID,
    ITU_BACKBONE_LAYER,
    ITU_SOURCE_VINTAGE,
    ITU_WMS_URL,
    _backbone_tile_url,
)
from api.routes.backhaul import get_tiles

_MODULE = Path(__file__).resolve().parent / "layers.py"


def test_the_catalogue_has_one_layer_and_it_is_wms_and_undated():
    # Undated is not an oversight. ITU publishes one continually updated
    # snapshot with no WMS time dimension, so a date picker would promise
    # currency the product does not have — the argument `land_cover` makes for
    # its fixed 2021 epoch.
    assert len(BACKBONE_LAYERS) == 1
    layer = BACKBONE_LAYERS[0]
    assert layer.kind == "wms"
    assert layer.dated is False
    assert layer.resolver is not None
    assert layer.builder is None
    assert BY_ID == {layer.layer_id: layer}


def test_the_layer_group_is_backhaul():
    # The group decides which HUD panel lists it and which cache key its tiles
    # take. The frontend's TILE_KEY/TILE_FN are exhaustive Record<LayerGroup,…>
    # maps, so this string has to match the union member exactly or a fourth
    # group silently routes to another catalogue's endpoint.
    assert BACKBONE_LAYERS[0].group == "backhaul"


def test_no_backbone_layer_touches_earth_engine_or_hydrafloods():
    # This is the one catalogue served entirely from an external WMS. A builder
    # or the hydrafloods flag would make it depend on credentials it never uses,
    # and would turn a reachable layer into one that 503s on a machine with no
    # Earth Engine project.
    for layer in BACKBONE_LAYERS:
        assert layer.builder is None, f"{layer.layer_id} declares an EE builder"
        assert not layer.needs_hydrafloods, f"{layer.layer_id} pulls in HYDRAFloods"
        assert layer.requires_env is None, f"{layer.layer_id} demands an env var"


def test_no_backbone_layer_offers_a_sensor_choice():
    # An empty tuple is what makes the engine skip sensor validation, and the
    # route does not accept the parameter. Declaring sensors here would advertise
    # a control that does not exist.
    for layer in BACKBONE_LAYERS:
        assert not layer.sensors, f"{layer.layer_id} declares a sensor selector"
        assert layer.to_dict()["sensors"] == []


def test_the_tile_template_is_wms_111_in_web_mercator_with_the_bbox_token():
    # 1.1.1 with SRS rather than 1.3.0 with CRS: 1.3.0 flips axis order for some
    # authorities while MapLibre substitutes {bbox-epsg-3857} in
    # west,south,east,north order. Same choice _glofas_tile_url makes.
    url = _backbone_tile_url(ITU_BACKBONE_LAYER)
    assert url.startswith(ITU_WMS_URL)
    assert "VERSION=1.1.1" in url
    assert "SRS=EPSG:3857" in url
    assert "CRS=" not in url
    assert "{bbox-epsg-3857}" in url
    assert "TRANSPARENT=true" in url
    assert "FORMAT=image/png" in url


def test_only_the_publicly_readable_itu_layer_is_requested():
    # The three range_* buffers in the same workspace return
    # "permission denied for table range_10km" as an HTTP 200 WMS
    # ServiceException. Pointing this template at one would yield a layer that
    # looks configured and draws nothing.
    assert ITU_BACKBONE_LAYER == "trx_geocatalogue"
    url = _backbone_tile_url(ITU_BACKBONE_LAYER)
    for denied in ("range_10km", "range_25km", "range_50km"):
        assert denied not in url


def test_the_probe_is_the_content_type_aware_wms_one():
    # Not cosmetic. GeoServer reports a denied table as 200 +
    # application/vnd.ogc.se_xml, so a probe testing only the status code would
    # call an XML error page a drawable tile. _probe_wms_access tests for
    # `image` in the content type, which is what catches it.
    source = _MODULE.read_text(encoding="utf8")
    tree = ast.parse(source)
    resolver = next(
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.FunctionDef) and node.name == "_resolve_backbone"
    )
    called = {
        node.func.id
        for node in ast.walk(resolver)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }
    assert "_probe_wms_access" in called
    assert "_probe_image_access" not in called


def test_the_legend_has_one_row_matching_the_stroke_the_sld_actually_paints():
    # The legend must key off BACKBONE_STROKE, not a repeated literal. The first
    # draft of this entry named fibre, planned and microwave in three hues no
    # tile has ever contained — a key to a picture nobody was painting. One
    # LineSymbolizer means one colour, so one row.
    legend = BACKBONE_LAYERS[0].legend
    assert len(legend) == 1
    assert legend[0]["color"] == BACKBONE_STROKE
    assert BACKBONE_STROKE in BACKBONE_SLD


def test_the_sld_draws_lines_only_and_reclassifies_nothing():
    # Load-bearing. The source's default style buried the corridors under point
    # markers and label haloes — measured at 3,397 black and 1,443 yellow pixels
    # against six pixels of line on one z7 tile. One LineSymbolizer fixes that.
    #
    # The other half matters more: a style may decide what is legible, never
    # what is true. A Filter or a second Rule keyed on `status`/`type_inf` would
    # make the picture assert a classification, on geometry far too coarse to
    # carry it. Symbolizers that would invent marks the source has no geometry
    # for are banned for the same reason.
    assert BACKBONE_SLD.count("<Rule>") == 1
    assert BACKBONE_SLD.count("LineSymbolizer") == 2  # open and close tags
    for banned in ("PointSymbolizer", "TextSymbolizer", "PolygonSymbolizer",
                   "RasterSymbolizer", "<Filter", "<ogc:Filter"):
        assert banned not in BACKBONE_SLD, f"SLD carries {banned}"
    # It must name the layer it styles, or GeoServer silently ignores it and
    # serves the default — the exact render this SLD exists to replace.
    assert f"<Name>{ITU_BACKBONE_LAYER}</Name>" in BACKBONE_SLD


def test_the_tile_url_carries_the_sld_url_encoded_and_stays_a_sane_length():
    # SLD_BODY is inlined into every tile request, so it has to survive as a
    # query parameter: raw angle brackets and the '#' of the colour would
    # truncate the URL at the fragment. Verified end to end at z5..z8, where the
    # full request lands near 850 characters.
    url = _backbone_tile_url(ITU_BACKBONE_LAYER)
    assert "SLD_BODY=" in url
    body = url.split("SLD_BODY=", 1)[1].split("&", 1)[0]
    assert "<" not in body and ">" not in body and "#" not in body
    assert unquote(body) == BACKBONE_SLD
    # With the bbox token still unsubstituted this is the fixed cost; a real
    # tile request adds roughly 60 more characters for the coordinates.
    assert len(url) < 1500, f"tile URL is {len(url)} characters"


def test_the_description_states_vintage_schematic_geometry_and_the_flat_style():
    # Three caveats that cannot be inferred from the picture. A 2022 catalogue
    # drawn over a live map reads as current; a 47.6 km-spaced straight line
    # invites a distance measurement it cannot support; and one flat colour
    # hides a status split the data really has.
    description = BACKBONE_LAYERS[0].description
    assert ITU_SOURCE_VINTAGE in description
    assert "schematic" in description
    assert "47.6 km" in description
    assert "one colour" in description
    # The blunt disclaimer. Without it the layer sits beside the risk panel and
    # reads as an input to it.
    assert "does not feed the tower risk score" in description


def test_the_layer_never_enters_the_score_or_the_scheduler():
    # The load-bearing test. Measured over all 1,164 national towers, distance
    # to this backbone ranks the maintenance label at ROC-AUC 0.6075 — below
    # dist_power_m (0.6919), a column the model already has and with which it is
    # partly collinear (r = 0.386), and far below the served model (0.910). It
    # fails the `detector_auc > model_auc` necessary condition, and 1,009 of
    # 1,164 towers sit within 10 km of a line, so it is near-constant where
    # dispatch is decided. Importing any scoring module here is how that
    # decision would quietly reverse.
    source = _MODULE.read_text(encoding="utf8")
    tree = ast.parse(source)
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module)
    forbidden = ("model", "scheduler", "adapter", "agent")
    for name in imported:
        root = name.split(".")[0]
        assert root not in forbidden, f"backhaul imports {name}: it must stay context-only"


def test_the_package_does_not_import_its_peer_domains():
    # Peers, not a hierarchy: flood/, land/, thermal/ and backhaul/ all sit on
    # tiles/ and none imports another. Asserted against parsed imports rather
    # than grepped prose, because the docstring names the others on purpose.
    source = _MODULE.read_text(encoding="utf8")
    tree = ast.parse(source)
    for node in ast.walk(tree):
        module = None
        if isinstance(node, ast.Import):
            module = ",".join(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            module = node.module
        if not module:
            continue
        for peer in ("flood", "land", "thermal"):
            assert not module.startswith(peer), f"backhaul imports peer domain {module}"


def test_the_offline_fixture_mirrors_this_catalogue():
    # The frontend renders BACKHAUL_CATALOGUE whenever the backend is
    # unreachable, so a drift here shows the operator a legend colour, a label
    # or a caveat the live layer does not have — and offline is exactly when
    # nobody can check. Parsed out of the .ts rather than imported, which is the
    # only way a Python test can hold a TypeScript literal to account.
    fixture = (
        _BACKEND.parent / "frontend" / "src" / "fixtures" / "backhaulLayers.ts"
    )
    if not fixture.exists():  # backend-only checkout
        return
    text = fixture.read_text(encoding="utf8")
    layer = BACKBONE_LAYERS[0]
    assert f"layer_id: '{layer.layer_id}'" in text
    assert f"group: '{layer.group}'" in text
    assert f"kind: '{layer.kind}'" in text
    # The legend hex is the one that has already drifted once in this file's
    # history, and it is the single most visible thing offline.
    assert f"color: '{BACKBONE_STROKE}'" in text
    assert layer.attribution in text
    # The three caveats the layer must never be shown without.
    assert ITU_SOURCE_VINTAGE in text
    assert "schematic" in text
    assert "does not feed the tower risk score" in text


def test_ids_do_not_collide_across_all_four_catalogues():
    # `active` and `opacity` in the frontend store are keyed by layer id across
    # every panel, so a collision would make one layer's toggle move another's.
    from flood.layers import FLOOD_LAYERS
    from land.layers import LAND_LAYERS
    from thermal.layers import FIRE_LAYERS

    catalogues = {
        "backhaul": {layer.layer_id for layer in BACKBONE_LAYERS},
        "fire": {layer.layer_id for layer in FIRE_LAYERS},
        "flood": {layer.layer_id for layer in FLOOD_LAYERS},
        "land": {layer.layer_id for layer in LAND_LAYERS},
    }
    for left in catalogues:
        for right in catalogues:
            if left >= right:
                continue
            overlap = catalogues[left] & catalogues[right]
            assert not overlap, f"{left} and {right} share layer ids: {overlap}"


def test_an_unknown_layer_is_404_not_503():
    # Retrying a misspelling would never succeed, so 503 would tell the frontend
    # to keep asking. A flood layer id lands here too: each route indexes only
    # its own catalogue.
    for unknown in ("flood_extent", "active_fire", "not_a_layer"):
        try:
            get_tiles(unknown)
        except HTTPException as error:
            assert error.status_code == 404, f"{unknown} gave {error.status_code}"
        else:
            raise AssertionError(f"{unknown} should not yield tiles")


if __name__ == "__main__":
    for name, value in sorted(globals().items()):
        if name.startswith("test_") and callable(value):
            value()
            print(f"ok  {name}")
    print("\nall backhaul layer tests passed")
