"""Map preparation and cached raster transport. No caller-supplied source URLs."""
import math

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field, field_validator

from tiles import engine, preload
from tiles.ee_session import LayerUnavailable

router = APIRouter(prefix="/maps", tags=["maps"])


class Viewport(BaseModel):
    date: str
    bounds: tuple[float, float, float, float]
    zoom: int = Field(ge=0, le=16)

    @field_validator("date")
    @classmethod
    def valid_date(cls, value):
        engine.parse_date(value)
        return value

    @field_validator("bounds")
    @classmethod
    def valid_bounds(cls, value):
        west, south, east, north = value
        if not all(math.isfinite(n) for n in value) or not (
            -180 <= west < east <= 180 and -90 <= south < north <= 90
        ):
            raise ValueError("bounds must be west, south, east, north in geographic coordinates")
        return value


def service():
    if preload._service is None:
        raise HTTPException(503, "Map preloader is not running")
    return preload._service


@router.post("/preload", status_code=202)
def prepare(view: Viewport):
    # Bound work before allocating coordinate sets at a caller-selected zoom.
    west, south, east, north = view.bounds
    n = 2 ** view.zoom
    width = math.ceil((east - west) / 360 * n) + 1
    y = lambda lat: (1 - math.asinh(math.tan(math.radians(max(-85.05112878, min(85.05112878, lat))))) / math.pi) / 2 * n
    height = math.ceil(y(south) - y(north)) + 1
    if width * height > 128:
        raise HTTPException(400, "Viewport exceeds 128 tiles; reduce its area or zoom")
    service().enqueue(view.date, view.bounds, view.zoom)
    return {"status": "view_saved"}


@router.get("/status")
def status(date: str = Query("latest")):
    try:
        return service().status(date)
    except engine.InvalidDate as error:
        raise HTTPException(400, str(error)) from error


@router.post("/reload", status_code=202)
def reload(date: str = Query("latest"), view: Viewport | None = None, resume: bool = Query(False)):
    try:
        resolved_date = service().resolve_date(date, fresh=not resume)
        if view:
            if view.date != resolved_date:
                raise HTTPException(400, "Viewport date must match the reload date")
            prepare(view)
        return service().reload(date, resume=resume)
    except engine.InvalidDate as error:
        raise HTTPException(400, str(error)) from error
    except LayerUnavailable as error:
        raise HTTPException(503, str(error)) from error


@router.get("/tiles/{snapshot}/{z}/{x}/{y}")
def tile(snapshot: str, z: int, x: int, y: int):
    if len(snapshot) != 32 or any(c not in "0123456789abcdef" for c in snapshot):
        raise HTTPException(404, "Unknown map snapshot")
    if not 0 <= z <= 16 or not 0 <= x < 2**z or not 0 <= y < 2**z:
        raise HTTPException(400, "Invalid tile coordinates")
    try:
        data, mime = service().fetch(snapshot, z, x, y).result()
    except Exception as error:
        raise HTTPException(503, str(error)) from error
    return Response(data, media_type=mime, headers={"Cache-Control": "public, max-age=3600"})


@router.get("/hand/{stage}/{z}/{x}/{y}")
def hand(stage: float, z: int, x: int, y: int):
    if stage not in preload.STAGES:
        raise HTTPException(400, "Unknown water level")
    try:
        payload = service().tiles_for(preload.BY_ID[f"hand_{stage:g}"], "")
    except LayerUnavailable as error:
        raise HTTPException(503, str(error)) from error
    snapshot = payload["tile_url"].split("/")[3]
    response = tile(snapshot, z, x, y)
    # Stable HAND URLs describe an unchanging terrain scenario.
    response.headers["Cache-Control"] = "public, max-age=86400"
    return response
