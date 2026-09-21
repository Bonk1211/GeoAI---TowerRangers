"""GET /backhaul/layers, GET /backhaul/tiles/{layer_id} — transmission backbone.

The same contract as /flood, /land and /fire over a fourth catalogue: static
metadata that always answers, and a tile URL that can fail. Its own route rather
than an entry in one of the others because the catalogues are independent —
either can fail, refresh or be cached without the rest — and because a backbone
layer served from a URL named `flood` would be the one piece of the peer split
left mixed.

One difference from its three siblings is worth stating: nothing here touches
Earth Engine. ITU publishes the backbone through its own GeoServer, so the
catalogue reports no `earth_engine` status of its own — see get_layers below.

Unavailability is a 503 carrying the operator-facing reason, never an empty 200.
A layer that renders nothing while reporting success is the failure mode every
one of these routes is arranged to avoid, and here it would read as "no backbone
in this region" — a claim about infrastructure nobody checked.

No `sensor` parameter: this layer offers no source choice, and advertising the
parameter would promise a control that does not exist.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from backhaul.layers import BACKBONE_LAYERS, BY_ID
from tiles.ee_session import LayerUnavailable
from tiles.engine import InvalidDate
from tiles.preload import prepared_tiles_for as tiles_for

router = APIRouter(prefix="/backhaul", tags=["backhaul"])


@router.get("/layers")
def get_layers() -> dict:
    """Every backbone layer the map can draw.

    `earth_engine` is null and always will be. The field is part of the shared
    LayerCatalogue shape the frontend reads, so it is present rather than
    omitted; null is the honest value because this catalogue never asks Earth
    Engine anything, and reporting a live `configured: false` here would send a
    reader to fix credentials that were never on this layer's path. The same
    reasoning the offline fixtures use for the same field.
    """
    return {
        "layers": [layer.to_dict() for layer in BACKBONE_LAYERS],
        "earth_engine": None,
    }


@router.get("/tiles/{layer_id}")
def get_tiles(
    layer_id: str,
    date: str = Query("latest", description="accepted and ignored; this catalogue is undated"),
) -> dict:
    """Resolve a tile URL template for one backbone layer.

    `date` is accepted for symmetry with the other three tile routes — the
    frontend's shared query hook sends one for every group — and ignored,
    because the layer is `dated=False` and the tile engine skips date handling
    for it. The parameter description says so rather than letting a caller infer
    that a date filters anything.

    The response carries `tile_access`, because a URL the browser cannot fetch
    would otherwise present as a blank layer. That is not hypothetical here: the
    sibling `range_*` layers in the same ITU workspace return a permission error
    as an HTTP 200 XML document, which is precisely the case the probe catches.
    """
    # A misspelled layer is the caller's mistake, not an outage — 503 would tell
    # the frontend to retry something that will never succeed. A flood, land or
    # fire layer id lands here too: each route indexes only its own catalogue.
    if layer_id not in BY_ID:
        raise HTTPException(status_code=404, detail=f"unknown layer {layer_id!r}")
    try:
        return tiles_for(BY_ID[layer_id], date)
    except InvalidDate as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LayerUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
