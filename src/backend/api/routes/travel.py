"""POST /travel/legs — measured road legs for a handful of points.

Why this exists, when the scheduler already reads the matrix directly.

The Schedule tab's approval panel ranks candidate crews by where each crew
IS right now — on site at a tower, idle at the last tower it worked, or back
at its depot (frontend `lib/crewPosition.ts`). That position is a live,
per-render quantity the solver never stored, so the run object cannot carry
the legs for it and the panel had to estimate them with great-circle x 1.35
at a flat 45 km/h. It printed "(est.)" and was honest about it, but "we sent
the crew that can get there soonest" is the product's central claim and it
was the one number still being guessed.

This is a pure matrix lookup, no solving and no routing: the approval panel
asks about at most one tower and the ~30 crews in the roster, and each answer
is a dictionary hit. Pairs the matrix does not hold come back `null` rather
than estimated — the caller already owns a fallback and a fabricated number
here would be indistinguishable from a measured one.

Deliberately NOT under /schedule: `/schedule/{run_id}` would shadow it, the
same trap api/main.py's registration order already documents for
/schedule/baseline.
"""
from __future__ import annotations

import math
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator

from scheduler import simulation_routing
from scheduler.travel import get_matrix

router = APIRouter(tags=["travel"])

# One approval panel asks about one tower and at most the whole roster. The
# cap is here so a caller cannot turn a lookup endpoint into a bulk export of
# the matrix one request at a time.
MAX_ORIGINS = 60


class TravelLegsRequest(BaseModel):
    """`origins` are matrix keys, not coordinates.

    A tower's key is its tower_id; a depot's is `depot:<lon>:<lat>` rounded to
    5 dp (scheduler.travel.depot_key). The frontend builds them from the same
    crew records it already holds, so no coordinate rounding happens twice.
    """

    origins: list[str] = Field(..., max_length=MAX_ORIGINS)
    destination: str


class TravelLeg(BaseModel):
    origin: str
    km: float | None = None
    minutes: float | None = None
    # False means the matrix says there is no road at all between these two —
    # an island with no fixed link. Distinct from a pair the matrix simply
    # does not contain, which is absent from `legs` entirely.
    reachable: bool = True
    via_ferry: bool = False


class TravelLegsResponse(BaseModel):
    source: str  # "matrix" | "haversine"
    destination: str
    legs: list[TravelLeg]


@router.post("/travel/legs", response_model=TravelLegsResponse)
def travel_legs(req: TravelLegsRequest) -> TravelLegsResponse:
    matrix = get_matrix()
    legs: list[TravelLeg] = []
    for origin in req.origins:
        got = matrix.lookup(origin, req.destination)
        if got is None:
            continue  # absent: the caller falls back, and must be able to tell
        legs.append(
            TravelLeg(
                origin=origin,
                km=got.km,
                minutes=got.minutes,
                reachable=got.reachable,
                via_ferry=got.via_ferry,
            )
        )
    return TravelLegsResponse(
        source="matrix" if matrix.available else "haversine",
        destination=req.destination,
        legs=legs,
    )


class RoadPoint(BaseModel):
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)


class SimulationRoadLeg(BaseModel):
    id: str = Field(min_length=1, max_length=160)
    from_: RoadPoint = Field(alias="from")
    to: RoadPoint
    # Ordered crew/day groups defer unreachable stops. Only the first planned
    # origin is used; later legs depart the last successfully reached road node.
    sequence_group: str | None = Field(default=None, min_length=1, max_length=160)
    stage_outside_flood: bool = False
    destination_outside_flood: bool = False
    # Ground crews may not drive THROUGH standing water. Set for the impact
    # and response window only: MCMC practice permits access before a flood
    # and during recovery, so the caller clears this for pre-event and
    # post-recession legs rather than the router assuming a window.
    avoid_flood: bool = False


class FloodPolygon(BaseModel):
    type: Literal["Polygon"]
    coordinates: list[list[tuple[float, float]]]

    @field_validator("coordinates")
    @classmethod
    def simple_ring(cls, coordinates):
        if len(coordinates) != 1 or not 4 <= len(coordinates[0]) <= 128:
            raise ValueError("Flood polygon needs one closed ring of 4–128 vertices")
        ring = coordinates[0]
        if any(not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90 for lon, lat in ring):
            raise ValueError("Flood polygon coordinates must be finite longitude/latitude")
        if ring[0] != ring[-1] or len(set(ring[:-1])) != len(ring) - 1:
            raise ValueError("Flood polygon must be closed without repeated vertices")
        if max(p[0] for p in ring) - min(p[0] for p in ring) > 180:
            raise ValueError("Flood polygon cannot cross the antimeridian")
        def cross(a, b, c):
            return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        edges = list(zip(ring, ring[1:]))
        for i, (a, b) in enumerate(edges):
            for j, (c, d) in enumerate(edges[i + 1:], i + 1):
                if j == i + 1 or (i == 0 and j == len(edges) - 1):
                    continue
                overlap = max(min(a[0], b[0]), min(c[0], d[0])) <= min(max(a[0], b[0]), max(c[0], d[0])) and max(min(a[1], b[1]), min(c[1], d[1])) <= min(max(a[1], b[1]), max(c[1], d[1]))
                if overlap and cross(a, b, c) * cross(a, b, d) <= 0 and cross(c, d, a) * cross(c, d, b) <= 0:
                    raise ValueError("Flood polygon must not intersect itself")
        if abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in edges)) < 1e-12:
            raise ValueError("Flood polygon must enclose an area")
        return coordinates


class SimulationRoadRequest(BaseModel):
    legs: list[SimulationRoadLeg] = Field(min_length=1, max_length=64)
    blocked_edge_ids: list[str] = Field(default_factory=list, max_length=256)
    flood_polygon: FloodPolygon | None = None

    @model_validator(mode="after")
    def require_flood_polygon(self):
        if self.flood_polygon is None and any(leg.stage_outside_flood or leg.destination_outside_flood or leg.avoid_flood for leg in self.legs):
            raise ValueError("Outside-flood staging, deployment or avoidance requires flood_polygon")
        return self


@router.get("/travel/simulation-network")
def simulation_network():
    network = simulation_routing.get_network()
    if network is None:
        empty = {"type": "FeatureCollection", "features": []}
        return {"status": "unavailable", "source_updated_at": None, "bounds": None,
            "roads": empty, "rivers": empty, "blocked_edge_ids": [], "limitations": simulation_routing.LIMITATIONS}
    return network.description()


@router.post("/travel/simulation-routes")
def simulation_routes(req: SimulationRoadRequest):
    if len({leg.id for leg in req.legs}) != len(req.legs):
        raise HTTPException(400, "Route leg IDs must be unique")
    network = simulation_routing.get_network()
    blocked = frozenset(req.blocked_edge_ids)
    if network is not None and blocked.difference(network.edges):
        raise HTTPException(400, "Unknown scenario closure edge; reload the road snapshot")
    legs = []
    positions = {}
    staged_groups, reached_groups, staging_points = set(), set(), {}
    ring = tuple(req.flood_polygon.coordinates[0]) if req.flood_polygon else None
    for leg in req.legs:
        origin = (leg.from_.lon, leg.from_.lat)
        group = leg.sequence_group
        if group is not None:
            if group not in positions and group not in staged_groups:
                if leg.stage_outside_flood:
                    staged_groups.add(group)
                else:
                    positions[group] = origin
            origin = positions.get(group, origin)
        stage_origin = leg.stage_outside_flood if group is None else group in staged_groups and group not in positions
        origin_source = "previous_stop" if group in reached_groups else "mapped_staging" if stage_origin else "requested_origin"
        if network is None:
            result = {"status": "unavailable", "coordinates": [], "edge_ids": [], "distance_km": None,
                "duration_minutes": None, "origin_snap": None, "destination_snap": None,
                "last_mile": "unverified", "reason": "The saved OSM road network is unavailable."}
        else:
            destination = (leg.to.lon, leg.to.lat)
            # `avoid_flood` binds on BOTH paths: a leg that neither stages nor
            # deploys outside the flood still must not drive through it.
            avoid = network.flood_nodes(ring) if (leg.avoid_flood and ring) else frozenset()
            result = (network.staged_route(origin, destination, blocked, ring, stage_origin,
                                           leg.destination_outside_flood, leg.avoid_flood)
                      if stage_origin or leg.destination_outside_flood
                      else network.route(origin, destination, blocked, avoid))
            if group is not None and result.get("staging"):
                staging_points[group] = result["staging"]
            if group is not None and result["status"] == "routed":
                reached = result["destination_snap"]
                positions[group] = (reached["lon"], reached["lat"])
                reached_groups.add(group)
        legs.append({"id": leg.id, **result, "origin_source": origin_source,
            "staging": staging_points.get(group, result.get("staging")), "deployment": result.get("deployment")})
    # Earlier deferred jobs still belong to the group's eventual staging point.
    for leg, result in zip(req.legs, legs):
        if leg.sequence_group in staging_points:
            result["staging"] = staging_points[leg.sequence_group]
    return {"source_updated_at": network.updated_at if network else None,
        "blocked_edge_ids": sorted(blocked), "limitations": simulation_routing.LIMITATIONS, "legs": legs}
