"""GET /land/layers, GET /land/tiles/{layer_id} — vegetation and ground overlays.

The same contract as /flood over a different catalogue: static metadata that
always answers, and tiles that need Earth Engine. Two routes rather than one
because the catalogues are independent — either can fail, refresh or be cached
without the other — and because a soil layer served from a URL named `flood`
would be the one piece of this split left mixed.

Unavailability is a 503 carrying the operator-facing reason, never an empty 200.
A layer that renders nothing while reporting success is the failure mode this
route, like its sibling, is arranged to avoid — and it is worse here, because a
blank vegetation layer reads as "nothing growing" rather than as "we do not know".

No `sensor` parameter: none of these layers offers a source choice, and
advertising the parameter would promise a control that does not exist.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from land.layers import BY_ID, LAND_LAYERS
from tiles.ee_session import LayerUnavailable, credentials_status
from tiles.engine import InvalidDate
from tiles.preload import prepared_tiles_for as tiles_for

router = APIRouter(prefix="/land", tags=["land"])


@router.get("/layers")
def get_layers() -> dict:
    """Every ground and vegetation layer the map can draw, plus EE usability.

    `earth_engine.configured` is a statement about the environment, not a
    promise that a tile request will succeed — registration, quota and dataset
    access can still fail, and only /land/tiles finds that out. It is the same
    session /flood/layers reports on, because there is only one.
    """
    return {
        "layers": [layer.to_dict() for layer in LAND_LAYERS],
        "earth_engine": credentials_status(),
    }


@router.get("/tiles/{layer_id}")
def get_tiles(
    layer_id: str,
    date: str = Query("latest", description="latest saved imagery or YYYY-MM-DD; ignored by undated layers"),
) -> dict:
    """Resolve a tile URL template for one layer on one date.

    The response carries the observation window and source count actually used —
    plus `tile_access`, because a URL the browser cannot fetch would otherwise
    present as a blank layer.
    """
    # A misspelled layer is the caller's mistake, not an outage — 503 would tell
    # the frontend to retry something that will never succeed. A flood layer id
    # lands here too: each route indexes only its own catalogue.
    if layer_id not in BY_ID:
        raise HTTPException(status_code=404, detail=f"unknown layer {layer_id!r}")
    try:
        return tiles_for(BY_ID[layer_id], date)
    except InvalidDate as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LayerUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
