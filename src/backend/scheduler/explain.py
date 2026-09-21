"""Deterministic "why this slot" (PRD §8.1, Backend_Handoff §2/§7, step 5).

Renders from solver state alone — no LLM, must render with the agent down
or slow. Re-derives the same feasibility checks optimize.py used for the
assigned day and each earlier-in-horizon day it rejected, so the readout
explains the greedy choice rather than re-solving.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from scheduler.optimize import (
    ScheduleEntry,
    _hhmm_to_min,
    is_flood_zone,
    is_monsoon_month,
    leg,
)
from scheduler.travel import depot_key


@dataclass
class WhySlot:
    """Mirrors Frontend_Build_Plan §5 `WhySlot` exactly."""

    tower_id: str
    crew_id: str
    day: str
    reasons: list[str]

    def to_dict(self) -> dict[str, Any]:
        return {
            "tower_id": self.tower_id,
            "crew_id": self.crew_id,
            "day": self.day,
            "reasons": self.reasons,
        }


# Driver key -> the phrase a planner reads. A fixed dict, not generated copy:
# these strings say why a crew is going sooner and must not drift per render.
# None of them implies a failure event — the deadline moved, the tower did not
# change (Backend_Handoff §0.6).
_DRIVER_PHRASES = {
    "severe_rain": "heavy rain forecast in the next 24 h",
    "watch_rain": "rain forecast in the next 24 h",
    "saturated_ground": "ground already saturated",
}


def _jobs_on(entries: list[ScheduleEntry], crew_id: str, day: str) -> list[ScheduleEntry]:
    return [e for e in entries if e.crew_id == crew_id and e.day == day]


def explain_slot(
    entry: ScheduleEntry,
    tower: dict,
    crew: dict,
    all_entries: list[ScheduleEntry],
    policy: dict,
    today: date | None = None,
) -> WhySlot:
    """Builds the bullet list for one ScheduleEntry against the rest of the
    committed schedule. Deterministic given (entry, tower, crew, entries, policy)."""
    reasons: list[str] = []

    assigned_day = date.fromisoformat(entry.day)
    road_factor = policy["travel"]["road_factor"]
    max_km = crew.get("max_travel_km", policy["travel"]["max_travel_km_default"])
    # Distance AND minutes from one call, so the explanation quotes the same
    # figures the solver committed to. Deriving the minutes here from km and
    # an average speed would silently reinstate the straight-line model on the
    # one screen whose job is saying why the solver chose this slot.
    dist, depot_min = leg(
        depot_key(crew["depot"]["lon"], crew["depot"]["lat"]),
        crew["depot"]["lon"],
        crew["depot"]["lat"],
        tower.get("tower_id", ""),
        tower["lon"],
        tower["lat"],
        road_factor,
        policy["travel"]["avg_speed_kmh"],
    )

    def _clock(minutes: int) -> str:
        return f"{minutes // 60:02d}:{minutes % 60:02d}"

    reasons.append(
        f"earliest {crew['crew_type']} slot within {int(max_km)} km of "
        f"{crew['depot']['name']} depot ({dist:.0f} km away)"
    )
    if entry.end_min > entry.start_min:
        reasons.append(
            f"on site {_clock(entry.start_min)}–{_clock(entry.end_min)} "
            f"after a {entry.travel_min} min drive"
            + (" from the depot" if entry.order == 1 else " from the previous stop")
        )

    # The work order's deadline first, the tower's only as a fallback. These are
    # the same number for every action the dominant-factor lookup produces —
    # propose_action copies it off the tower record — so the distinction was
    # invisible until fire_exposure_inspection became the first action carrying
    # its own `target_days`. optimize.py builds the SLA from the WORK ORDER, so
    # reading the tower here made the one deterministic explanation surface
    # narrate a deadline the solver never used: "due within 12 days" for a job
    # it had actually booked against 7.
    urgency_days = entry.work_order.get("urgency_days")
    if urgency_days is None:
        urgency_days = tower.get("urgency_days")
    if urgency_days is not None:
        reasons.append(f"due within {urgency_days} days")

    # A tower in this run on the second opinion rather than on its standing
    # risk must say so. Without this a planner sees a low-risk site dispatched
    # ahead of higher-risk ones with no stated reason, which is the kind of
    # unexplained ordering this readout exists to prevent. Rendered from the
    # stored record like everything else here.
    if tower.get("escalated"):
        condition = tower.get("condition")
        detail = (
            f" (site counters above {condition:.0%} of the estate)"
            if isinstance(condition, (int, float))
            else ""
        )
        reasons.append(
            "moved up a band by recent site telemetry, not by standing risk" + detail
        )

    # A deadline that moved must say why, in the same deterministic breath as
    # every other reason here. Rendered from the stored record, never fetched:
    # this readout's contract is that it works with the agent down or slow.
    weather = tower.get("weather")
    if weather and weather.get("multiplier", 1.0) < 1.0:
        drivers = ", ".join(_DRIVER_PHRASES.get(d, d) for d in weather.get("drivers", []))
        if drivers:
            reasons.append(f"brought forward — {drivers}")

    # walk days strictly before the assigned day and explain why each was skipped
    horizon_start = today or (assigned_day - timedelta(days=7))
    day_cursor = horizon_start
    while day_cursor < assigned_day:
        day_iso = day_cursor.isoformat()
        same_crew_jobs = _jobs_on(all_entries, crew["crew_id"], day_iso)

        if is_monsoon_month(day_cursor, policy) and is_flood_zone(tower, policy):
            if entry.work_order["crew_type"] in policy["monsoon"]["blocked_crew_types"]:
                reasons.append(
                    f"{day_cursor.strftime('%a')} blocked — monsoon window "
                    f"(flood-zone civil work suspended)"
                )
                day_cursor += timedelta(days=1)
                continue

        # Capacity is hours, not a job count, so say how the hours went —
        # "Tue full (2 jobs)" told the planner nothing about whether a third
        # would have fitted.
        if same_crew_jobs:
            shift_h = float(crew.get("shift_hours", policy["shift"]["hours_default"]))
            day_start = _hhmm_to_min(policy["shift"]["day_start"])
            booked_min = max((e.end_min for e in same_crew_jobs), default=day_start) - day_start
            free_min = int(shift_h * 60) - booked_min
            work_min = int(round(float(entry.work_order.get("duration_hours") or 0) * 60))
            if free_min < work_min + depot_min:
                reasons.append(
                    f"{day_cursor.strftime('%a')} full — "
                    f"{booked_min / 60:.1f}h of {shift_h:.0f}h booked, "
                    f"{max(0, free_min) / 60:.1f}h left"
                )

        day_cursor += timedelta(days=1)

    if entry.pinned:
        reason_label = entry.pin_reason or "planner_override"
        who = f" by {entry.pinned_by}" if entry.pinned_by else ""
        reasons.append(f"pinned{who} ({reason_label}) — held fixed across re-optimization")

    return WhySlot(
        tower_id=entry.tower_id,
        crew_id=entry.crew_id,
        day=entry.day,
        reasons=reasons,
    )
