"""GET /flood/layers, GET /flood/tiles/{layer_id} — live flood overlays.

The catalogue is static metadata and always answers, with or without Earth
Engine, so the frontend can render the layer list and say precisely why a layer
is unavailable. Earth Engine tiles need credentials; the GloFAS WMS does not.

Unavailability is a 503 carrying the operator-facing reason, never an empty
200. A flood layer that renders nothing while reporting success is the failure
mode this whole route is arranged to avoid.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from flood.layers import BY_ID, DEFAULT_FLOOD_SENSOR, FLOOD_LAYERS
from tiles.ee_session import LayerUnavailable, credentials_status
from tiles.engine import InvalidDate, InvalidSensor
from tiles.preload import prepared_tiles_for as tiles_for

router = APIRouter(prefix="/flood", tags=["flood"])


@router.get("/layers")
def get_layers() -> dict:
    """Every layer the map can draw, plus whether Earth Engine is usable.

    `earth_engine.configured` is a statement about the environment, not a
    promise that a tile request will succeed — registration, quota and dataset
    access can still fail, and only /flood/tiles finds that out.
    """
    return {
        "layers": [layer.to_dict() for layer in FLOOD_LAYERS],
        "earth_engine": credentials_status(),
    }


@router.get("/tiles/{layer_id}")
def get_tiles(
    layer_id: str,
    date: str = Query("latest", description="latest saved imagery or YYYY-MM-DD; ignored by undated layers"),
    sensor: str = Query(
        DEFAULT_FLOOD_SENSOR,
        description="Flood observation sensor; ignored by layers without a sensor selector",
    ),
) -> dict:
    """Resolve a tile URL template for one layer on one date.

    The response carries the observation window, selected sensor, and scene
    count actually used — plus `tile_access`, because a URL the browser cannot
    fetch would otherwise present as a blank layer.
    """
    # A misspelled layer is the caller's mistake, not an outage — 503 would tell
    # the frontend to retry something that will never succeed.
    if layer_id not in BY_ID:
        raise HTTPException(status_code=404, detail=f"unknown layer {layer_id!r}")
    try:
        return tiles_for(BY_ID[layer_id], date, sensor)
    except (InvalidDate, InvalidSensor) as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LayerUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
