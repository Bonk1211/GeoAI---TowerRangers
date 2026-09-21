"""Terrestrial transmission backbone — context beside the score, never inside it.

The fourth peer on `tiles/engine.py`, alongside `flood/`, `land/` and
`thermal/`. It imports none of them and none of them imports it. Unlike those
three it reaches no Earth Engine at all: ITU publishes the backbone through its
own GeoServer, so this catalogue is one `kind="wms"` layer whose resolver pins a
GetMap template the way `flood/layers.py::_resolve_glofas` pins GloFAS.

Why it is context and cannot be a risk factor
---------------------------------------------
Distance to this backbone was measured against the maintenance label over all
1,164 national towers before the layer was written, because the standing rule in
this project is that a second opinion earns its place only by beating what is
already served:

    ROC-AUC  distance to nearest operational fibre : 0.6075
    ROC-AUC  dist_power_m (already in FEATURES)    : 0.6919
    ROC-AUC  the served maintenance model          : 0.910
    corr(dist_fibre, dist_power)                   : 0.386

It loses to a column the model already has, and is partly collinear with it.
That is the same `detector_auc > model_auc` necessary condition the second
opinion is held to (`model/second_opinion.py`, reported under
`second_opinion.detectors_in_escalation_band`), and it fails it. It is also
near-constant where dispatch is decided — 1,009 of 1,164 towers sit within
10 km of a line — which is the shape of the GSW columns that were dropped at
lift 0.99x. So nothing here touches `risk`, `priority`, `attribution`,
`urgency_days` or the decision bands, and `AHP_FACTORS` is unchanged.

The caveat that would matter on revisiting: the maintenance label is synthetic
and its generator never saw fibre, so that measurement shows this adds nothing
to *this* pipeline — it cannot show backhaul is irrelevant to real maintenance.
Re-run it against real work orders before treating the question as settled.

Why the geometry must be described as schematic
------------------------------------------------
Measured over the 382 links in the Malaysia/Borneo bbox: the median link
carries **2 vertices** and the median spacing between vertices is **47.6 km**.
These are straight lines drawn between endpoints, not surveyed duct routes. A
48 km straight line does not cross the Titiwangsa range the way fibre does, so
any per-tower distance read off this layer is a distance to a drawn line and
not to cable in the ground. The layer description says exactly that, for the
same reason the land catalogue names the duties satellite cannot answer: a
plausible-looking line invites a measurement it cannot support.

ITU's own record is equally clear about provenance. The data is compiled from
"operator websites, annual reports, company presentations" as well as direct
requests, and operator validation is "a work in progress". Published
2022-12-31. `ITU_SOURCE_VINTAGE` carries that date into the UI rather than
leaving the reader to assume currency.

What is and is not reachable
----------------------------
The GeoServer advertises four layers. Only one of them renders:

    trx_geocatalogue   200 image/png        — the backbone links
    range_10km         permission denied for table range_10km
    range_25km         permission denied (same)
    range_50km         permission denied (same)

The three `range_*` buffers are the distance-to-fibre-node rings behind ITU's
Broadband Capacity Indicator 7, and they are exactly what a proximity read would
want. They are not public: GeoServer returns a PostgreSQL permission error
inside a WMS ServiceException, which is an HTTP 200 carrying
`application/vnd.ogc.se_xml`. That matters because a 200 is what a naive probe
calls success — the engine's `_probe_wms_access` tests the content type and so
reports `requires_auth` instead, which is why this resolver reuses it rather
than testing the status code.

The source's default style is not usable, so this layer carries its own
-----------------------------------------------------------------------
GetLegendGraphic advertises four rules selected purely by geometry type — an
opaque raster, a grey polygon, a blue line, and a red square point. None reads
`status` or `type_inf`. Rendering it is worse than that legend suggests: on one
z7 tile the default style drew 3,397 black and 1,443 yellow pixels of point
markers and label haloes against **six pixels** of the blue line. The corridors
the layer exists to show were buried under node decoration two orders of
magnitude louder than themselves.

So `BACKBONE_SLD` below ships one LineSymbolizer and nothing else, inlined into
every tile request as `SLD_BODY`. On the same tile that draws 8,934 pixels, all
of them the stroke. The distinction that keeps this honest: the SLD suppresses
symbols the source would otherwise paint, and it invents no geometry and
reclassifies nothing. A style may decide what is legible; it may never decide
what is true.

It stays ONE rule and one colour even though `status` and `type_inf` are right
there in the data and could be styled apart. At ~47.6 km vertex spacing a
three-hue key would invite precisely the per-tower reading the layer
description spends a paragraph refusing. The legend has one row to match, and
the status split is stated in words instead. The honest fix for the underlying
question is vector data through the open WFS, not a richer raster.
"""

from __future__ import annotations

from urllib.parse import quote

from tiles.engine import Layer, _probe_wms_access

# ITU's GeoServer for the BBmaps transmission-network geocatalogue.
ITU_WMS_URL = "https://bbmaps.itu.int/geoserver/itu-geocatalogue/wms"

# The one layer in that workspace a request without credentials may draw.
ITU_BACKBONE_LAYER = "trx_geocatalogue"

# Publication date on ITU's own GeoNetwork record. Surfaced rather than hidden:
# a 2022 backbone drawn over a live map reads as current unless it says so.
ITU_SOURCE_VINTAGE = "2022-12-31"

# Matches the other three catalogues' regional extent so a user panning between
# panels never crosses an invisible coverage edge. The source is global; this is
# the window this app draws, and `bounds` culls tile requests to it.
BACKBONE_LAYER_BBOX = (92.0, -11.5, 142.0, 29.0)

# Measured over the 382 links inside the Malaysia/Borneo bbox on 2026-09-20.
# Quoted in the description so the caveat carries a number rather than an
# adjective. Recompute these if the source is ever re-pulled.
MEDIAN_VERTEX_SPACING_KM = 47.6
MEASURED_LINK_COUNT = 382


# The stroke the backbone draws in. A cool, desaturated blue: on this app warm
# hue means tower severity and the violet accent means interface chrome, so a
# context layer may take neither. Matches the tone `permanent_water` uses for
# the same "standing background fact" role.
BACKBONE_STROKE = "#1d4e89"

# An inline SLD, sent with every tile, because the source's own default style is
# not usable as a map layer.
#
# Measured rather than assumed. GetLegendGraphic advertises four rules selected
# purely by geometry type — an opaque raster, a grey polygon, a blue line, and a
# red square point — none of which reads `status` or `type_inf`. Rendered, that
# default puts BLACK POINT MARKERS AND LABEL HALOES over the whole extent: on one
# z7 tile it drew 3,397 black and 1,443 yellow pixels against **6 pixels of the
# blue line**, so the corridors this layer exists to show were buried under
# node decoration two orders of magnitude louder than themselves.
#
# The SLD below carries one LineSymbolizer and nothing else, so only the links
# draw. Same tile: 8,934 pixels, all of them the stroke. It suppresses symbols
# the source would otherwise paint; it invents no geometry and reclassifies
# nothing, which keeps it on the right side of the line this module draws
# everywhere else — a style may decide what is legible, never what is true.
#
# Deliberately ONE rule and one colour. Styling `status` or `type_inf` apart is
# possible here and is not done: the geometry is schematic at ~47.6 km vertex
# spacing, and a three-hue key would invite exactly the per-tower reading the
# description spends a paragraph refusing. The legend has one row to match.
#
# Encoded length is ~563 characters, giving tile URLs near 850 — comfortably
# inside every practical GET limit, verified at z5 through z8.
BACKBONE_SLD = (
    "<StyledLayerDescriptor version='1.0.0' xmlns='http://www.opengis.net/sld'>"
    "<NamedLayer><Name>{layer}</Name><UserStyle><FeatureTypeStyle><Rule>"
    "<LineSymbolizer><Stroke>"
    "<CssParameter name='stroke'>{stroke}</CssParameter>"
    "<CssParameter name='stroke-width'>1.5</CssParameter>"
    "<CssParameter name='stroke-opacity'>0.9</CssParameter>"
    "</Stroke></LineSymbolizer>"
    "</Rule></FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>"
).format(layer=ITU_BACKBONE_LAYER, stroke=BACKBONE_STROKE)

_SLD_BODY_ENCODED = quote(BACKBONE_SLD)


def _backbone_tile_url(source_layer: str) -> str:
    """A MapLibre-ready GetMap template for one ITU WMS layer.

    WMS 1.1.1 with `SRS=EPSG:3857` rather than 1.3.0 with `CRS`, because 1.3.0
    flips axis order for some authorities and MapLibre substitutes a plain
    `{bbox-epsg-3857}` in west,south,east,north order. 1.1.1 takes that order
    verbatim, which is the same choice `_glofas_tile_url` makes for the same
    reason.

    The style is ours, and it had to be. See BACKBONE_SLD.
    """
    return (
        f"{ITU_WMS_URL}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1"
        f"&LAYERS={source_layer}&STYLES=&FORMAT=image/png&TRANSPARENT=true"
        "&SRS=EPSG:3857&WIDTH=256&HEIGHT=256"
        f"&SLD_BODY={_SLD_BODY_ENCODED}"
        "&BBOX={bbox-epsg-3857}"
    )


def _resolve_backbone(layer) -> tuple[str, None, None, dict, str]:
    """Pin the ITU backbone into a tile template.

    Undated, so no window and no scene count — ITU publishes one continually
    updated snapshot with no time dimension, and advertising a date picker would
    promise currency the product does not have. The same argument `land_cover`
    makes for its fixed 2021 epoch.

    `observed_at` is deliberately NOT set. It means "this is when the thing was
    observed", and a compiled catalogue with a publication date is not an
    observation. The vintage travels in the description and in the frontend
    fixture instead, where it reads as provenance rather than as a measurement.

    The access probe is the engine's shared `_probe_wms_access`, and it is the
    right one here for a reason worth naming: GeoServer reports a denied table
    as a *ServiceException document* with HTTP 200 and
    `Content-Type: application/vnd.ogc.se_xml`, not as a 403. That helper tests
    for `image` in the content type, so it returns `requires_auth` rather than
    calling an XML error page a drawable tile — which is exactly what the three
    `range_*` buffer layers would do if anyone pointed this resolver at them.
    """
    url_format = _backbone_tile_url(ITU_BACKBONE_LAYER)
    return url_format, None, None, {}, _probe_wms_access(url_format)


BACKBONE_LAYERS: tuple[Layer, ...] = (
    Layer(
        layer_id="transmission_backbone",
        label="Transmission backbone · ITU",
        description=(
            "Terrestrial fibre and microwave backbone links from the ITU Broadband "
            "Maps geocatalogue, published 2022-12-31 and compiled partly from "
            "operator websites, annual reports and company presentations — ITU "
            "records operator validation as still in progress. "
            "The geometry is schematic: across the links covering Malaysia the "
            f"median spacing between vertices is about {MEDIAN_VERTEX_SPACING_KM:g} km, "
            "so these are straight lines drawn between endpoints, not surveyed duct "
            "routes. Read it as which corridors carry backbone, never as how far a "
            "tower sits from cable in the ground. Every link draws in one colour, so "
            "operational, planned and microwave corridors are indistinguishable on the "
            "map even though the data separates them. It carries no operator, no "
            "capacity and no redundancy information, and it does not feed the tower "
            "risk score."
        ),
        kind="wms",
        dated=False,
        attribution="ITU Broadband Maps (BBmaps) terrestrial transmission networks, 2022",
        # One entry, because this layer draws one colour — now by our choice
        # rather than the source's accident. BACKBONE_SLD carries a single
        # LineSymbolizer, so operational, planned and microwave links all render
        # in BACKBONE_STROKE. Keyed off that constant rather than repeating the
        # hex, so the legend cannot drift from what the tiles actually paint.
        # That drift is not hypothetical: the first draft of this entry carried
        # a three-hue key naming fibre, planned and microwave in colours no tile
        # has ever contained — a key to a picture nobody was painting, which is
        # the failure the water-depth bins exist to prevent. The status split is
        # real in the data and is stated in the description; it is simply not
        # something the map distinguishes.
        legend=[{"label": "backbone link (fibre or microwave)", "color": BACKBONE_STROKE}],
        bounds=BACKBONE_LAYER_BBOX,
        resolver=_resolve_backbone,
        group="backhaul",
    ),
)

BY_ID = {layer.layer_id: layer for layer in BACKBONE_LAYERS}
