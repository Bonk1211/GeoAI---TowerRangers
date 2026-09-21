"""Pydantic request/response models. Response shapes mirror
Frontend_Build_Plan §5 exactly — field names and nesting must not drift."""
from __future__ import annotations

import math
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


class Depot(BaseModel):
    lon: float
    lat: float
    name: str


class Crew(BaseModel):
    crew_id: str
    name: str
    crew_type: str
    depot: Depot
    territory: str
    max_travel_km: float
    shift_hours: float
    members: list[str]


class FireInspectionRequest(BaseModel):
    """What a planner sends to raise a reviewed fire-exposure inspection.

    The snapshot id is the review's expiry: /schedule/pin refuses the request
    when it no longer matches the current screening, so an inspection can never
    be scheduled against evidence the planner did not actually see.
    """

    snapshot_id: str
    safe_access_confirmed: bool


class FireInspectionEvidence(BaseModel):
    """The observation a reviewed inspection was raised against, carried on the
    work order so the board can show WHY a tower is being visited.

    Counts and timestamps only — no share, no band, no factor. Fire is observed
    evidence beside the maintenance score, never inside it.
    """

    snapshot_id: str
    observed_at: str
    hotspot_pixel_days: int
    max_confidence: str
    buffer_m: int
    window_days: int
    reviewed: bool = True
    safe_access_confirmed: bool


class WorkOrder(BaseModel):
    tower_id: str
    action: str
    crew_type: str
    parts: list[str]
    urgency_days: int
    why: str
    duration_hours: float = 0.0  # on-site hours; travel is separate (see entry)
    # Declared, not incidental: pydantic silently DROPS any key this model does
    # not name, so without this line the evidence scheduler/actions.py attaches
    # to a fire work order never reaches the browser at all. None on every
    # ordinary order — absence, not a zeroed struct.
    fire_inspection: FireInspectionEvidence | None = None


class ScheduleEntryOut(BaseModel):
    crew_id: str
    day: str
    order: int
    tower_id: str
    work_order: WorkOrder
    pinned: bool
    pin_reason: Literal["planner_override", "emergency"] | None = None
    # Minutes from midnight, local. Solver-derived, not assumed — the timeline
    # draws bar geometry directly from these.
    travel_min: int = 0
    start_min: int = 0
    end_min: int = 0
    consumed_reserve: bool = False


class ReserveSlotOut(BaseModel):
    """A reserved crew-day that is STILL FREE as of this ScheduleRun — once a
    pin, an emergency, or the SLA valve occupies a (crew_id, day) chosen for
    reserve, the optimizer drops it from this list rather than reporting it
    as still held free. So len(reserve) here is reserve days REMAINING for
    this run, not the policy quota configured in policy.yaml's readiness
    block — a UI counting "N reserve days left" from this list is counting
    something different from that configured quota by design."""

    crew_id: str
    day: str
    crew_type: str


class UnscheduledOut(BaseModel):
    tower_id: str
    # Capacity : no_capacity | past_sla | monsoon_blocked | reserved
    # Coverage : out_of_range | out_of_territory | no_route | no_crew_type
    # The coverage set is not fixable by scheduling differently — see
    # scheduler/optimize.py _coverage_reason for what separates them.
    reason: str
    deadline: str | None
    crew_type: str


class ScheduleRunOut(BaseModel):
    run_id: str
    horizon: list[str] = []
    entries: list[ScheduleEntryOut]
    reserve: list[ReserveSlotOut] = []
    unscheduled: list[str]
    unscheduled_detail: list[UnscheduledOut] = []
    risk_weighted_wait: float
    # Which travel model produced every km and minute in this run: "matrix"
    # for measured OSRM road legs, "haversine" for the straight-line estimate.
    # Surfaced because the UI labels an estimate "(est.)" and must not label a
    # measurement that way, or the other way round.
    travel_source: str = "haversine"


class OverridePreviewOut(BaseModel):
    moved: list[dict[str, Any]]
    dropped: list[str]
    risk_weighted_wait_before: float
    risk_weighted_wait_after: float


class WhySlotOut(BaseModel):
    tower_id: str
    crew_id: str
    day: str
    reasons: list[str]


class OptimizeRequest(BaseModel):
    tower_ids: list[str] | None = None  # None = all maintain-band towers
    today: str | None = None  # ISO date (YYYY-MM-DD) to anchor the planning horizon


class OptimizeResponse(BaseModel):
    run_id: str


class PreviewRequest(BaseModel):
    run_id: str
    tower_id: str
    target_crew_id: str
    target_day: str
    pinned_by: str | None = None
    # Present only when the planner is raising a reviewed fire inspection. The
    # route validates it (snapshot, freshness, detections, crew, day) before
    # anything is built; scheduler/override.py stays free of any path that
    # refuses, which is its documented contract.
    fire_inspection: FireInspectionRequest | None = None


class PinRequest(BaseModel):
    run_id: str
    tower_id: str
    target_crew_id: str
    target_day: str
    pinned_by: str | None = None
    pin_reason: Literal["planner_override", "emergency"] = "planner_override"
    fire_inspection: FireInspectionRequest | None = None


class ScoreRequest(BaseModel):
    weights: dict[str, float] = Field(default_factory=dict)
    bbox: tuple[float, float, float, float] | None = None

    @field_validator("bbox")
    @classmethod
    def validate_bbox(
        cls, bbox: tuple[float, float, float, float] | None
    ) -> tuple[float, float, float, float] | None:
        if bbox is None:
            return None
        west, south, east, north = bbox
        if not all(math.isfinite(value) for value in bbox):
            raise ValueError("bbox coordinates must be finite")
        if not -180 <= west < east <= 180:
            raise ValueError("bbox must satisfy -180 <= west < east <= 180")
        if not -90 <= south < north <= 90:
            raise ValueError("bbox must satisfy -90 <= south < north <= 90")
        return bbox


class EmergencyRequest(BaseModel):
    run_id: str
    tower_id: str
    crew_id: str
    pinned_by: str | None = None
    commit: bool = False


class LedgerSummary(BaseModel):
    version: int
    records: int
    malformed: int
    first_observed: str | None
    last_observed: str | None
    agree: int
    disagree: int
    indeterminate: int
    eligible_for_training: int
    simulated_records: int
    last_retrain: str | None
    sources: dict[str, int]


class LedgerObservationOut(BaseModel):
    """One whole ledger row. Mirrors model/feedback.py's Observation exactly —
    the frontend copies these to build confirmations, so a narrower shape here
    would silently break the (tower_id, source, observed_at) key that decides
    whether a confirmation lands on the right observation."""

    observed_at: str
    tower_id: str
    source: str
    observation: dict[str, Any]
    predicted_priority: float
    predicted_decision: str
    agreement: str
    label_status: str
    simulated: bool


class CoverCandidate(BaseModel):
    """A neighbour that could plausibly be asked to help cover a tower's area.

    CANDIDATE FOR RF PLANNING TO CONFIRM, never a configuration. `bearing_deg`
    is the initial great-circle bearing to that neighbour — a direction to a
    PLACE, not an antenna azimuth. This repo holds no azimuth, height, EIRP,
    band or sector data for any tower.
    """

    tower_id: str
    distance_km: float
    bearing_deg: float


class CoHazardNeighbour(BaseModel):
    """A neighbour inside the search radius that is ITSELF flood-exposed, and
    so cannot be counted on. Returned explicitly rather than filtered away:
    "three neighbours, all of them flooding too" is a different and sharper
    finding than "no neighbours at all"."""

    tower_id: str
    distance_km: float


class TowerFallback(BaseModel):
    """One at-risk tower's cover picture.

    No `isolated` field by design — `len(candidates) == 0` says it, and a
    boolean beside the list it summarises can drift out of agreement with it.
    """

    tower_id: str
    candidates: list[CoverCandidate]
    co_hazard: list[CoHazardNeighbour]
    # Nearest other tower at ANY distance, not capped at the search radius and
    # counting co-hazard towers. None only for a single-tower estate.
    nearest_km: float | None


class FallbackParameters(BaseModel):
    search_radius_km: float
    max_candidates: int
    sector_count: int
    at_risk_rule: str
    basis: str


class FallbackReport(BaseModel):
    """`towers` holds ONLY at-risk towers. A tower absent from it is not at
    risk; it is never present with empty lists."""

    generated_at: str
    parameters: FallbackParameters
    at_risk_count: int
    isolated_count: int
    towers: dict[str, TowerFallback]
