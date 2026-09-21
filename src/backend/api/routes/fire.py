"""GET /fire/layers, GET /fire/tiles/{layer_id}, GET /fire/exposure — thermal anomalies.

The same contract as /flood and /land over a third catalogue: static metadata
that always answers, and tiles that need Earth Engine. A third route rather than
a group parameter on one, because the catalogues are independent — either can
fail, refresh or be cached without the others — and because a hotspot layer
served from a URL named `flood` would be the one piece of this split left mixed.

Unavailability is a 503 carrying the operator-facing reason, never an empty 200.
A fire layer that renders nothing while reporting success is the failure mode
this route, like its siblings, is arranged to avoid — and it is worse here than
anywhere else, because a blank hotspot layer reads as "nothing burning" rather
than as "we could not ask".

/fire/exposure is the tower-side read of the same snapshot the tiles are built
from. Nothing it returns enters the risk score, the decision bands or the factor
shares: a hotspot near a tower is evidence for a planner to review, and the site
may be untouched.

No `sensor` parameter: this catalogue offers no source choice, and advertising
the parameter would promise a control that does not exist.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from thermal.exposure import screen_towers, snapshot_for
from thermal.layers import BY_ID, FIRE_LAYERS
from tiles.ee_session import LayerUnavailable, credentials_status
from tiles.engine import InvalidDate, parse_date
from tiles.preload import prepared_tiles_for as tiles_for

router = APIRouter(prefix="/fire", tags=["fire"])


@router.get("/layers")
def get_layers() -> dict:
    """Every fire layer the map can draw, plus whether Earth Engine is usable.

    `earth_engine.configured` is a statement about the environment, not a
    promise that a tile request will succeed — registration, quota and dataset
    access can still fail, and only /fire/tiles finds that out. It is the same
    session /flood/layers and /land/layers report on, because there is only one.
    """
    return {
        "layers": [layer.to_dict() for layer in FIRE_LAYERS],
        "earth_engine": credentials_status(),
    }


@router.get("/tiles/{layer_id}")
def get_tiles(
    layer_id: str,
    date: str = Query("latest", description="latest saved imagery or YYYY-MM-DD; ignored by undated layers"),
) -> dict:
    """Resolve a tile URL template for one layer on one date.

    The response carries the observation window and granule count actually used
    — plus `tile_access`, because a URL the browser cannot fetch would otherwise
    present as a blank layer, and `snapshot_id`, so a tile and the tower evidence
    beside it can be shown to describe the same window.
    """
    # A misspelled layer is the caller's mistake, not an outage — 503 would tell
    # the frontend to retry something that will never succeed. A flood or land
    # layer id lands here too: each route indexes only its own catalogue.
    if layer_id not in BY_ID:
        raise HTTPException(status_code=404, detail=f"unknown layer {layer_id!r}")
    try:
        return tiles_for(BY_ID[layer_id], date)
    except InvalidDate as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except LayerUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error


@router.get("/exposure")
def get_exposure(
    date: str = Query(..., description="YYYY-MM-DD; the last day of the 3-day window"),
) -> dict:
    """Which towers had a hotspot within the screening buffer, and which did not.

    A tower absent from `towers` was screened and reported no detections. It is
    never returned with `hotspot_pixel_days: 0` — a zero would read as a
    measurement of quiet ground rather than as absence.

    The two failure modes are kept apart on purpose. `screen_towers` returning
    None means "we could not ask" and becomes a 503; a populated body whose
    `towers` map is empty means "we asked and it is quiet" and is a 200. A
    caller cannot tell those apart from an empty object, and rendering the first
    as the second would say "no fire near this tower" on no evidence at all.
    """
    # Parsed first, before anything touches Earth Engine: a malformed date is
    # the caller's mistake and must come back as a 400 the caller can fix, not
    # as the 503 an uninitialised session would raise a moment later.
    #
    # Inside the try, and that is not decoration. InvalidDate is a ValueError,
    # so an uncaught one leaves FastAPI to render a bare text/plain 500 — and
    # the frontend's error reader only recovers a JSON `detail`, so the panel
    # showed a reason-less failure AND tripped the global offline banner for
    # what was a typed date. The sibling /fire/tiles route below has always
    # caught it; this one did not.
    try:
        parse_date(date)
    except InvalidDate as error:
        raise HTTPException(status_code=400, detail=str(error)) from error

    # Resolve the window FIRST, purely to keep its reason. `screen_towers` may
    # never raise — the schedule route and the map panel both call it and
    # neither can be handed an exception — so it collapses every failure to
    # None, and that collapse destroys the one message an operator can act on.
    # An archive gap ("no granules for 2023-12-08..11, try a nearby date") was
    # being reported as "Earth Engine could not be reached", which is both false
    # and points at the wrong fix. Asking here costs nothing: the snapshot is
    # cached, and screen_towers below reuses this very one.
    try:
        snapshot_for(date)
    except LayerUnavailable as error:
        raise HTTPException(status_code=503, detail=str(error)) from error

    exposure = screen_towers(date)
    if exposure is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "fire screening is unavailable: the source window resolved but the "
                "per-tower reduction did not complete, so no statement about "
                "hotspots near any tower can be made"
            ),
        )
    return exposure
