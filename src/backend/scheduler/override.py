"""Override: pin, preview, emergency insertion (PRD §7.5, Backend_Handoff §2/§5, step 6).

One mechanism for all three override situations (wrong slot, emergency,
whole week wrong): pinning. A pinned assignment becomes a hard constraint
and the solver re-solves everything else around it.

Two hard requirements (Backend_Handoff §5):
  1. Preview must not mutate. preview() operates on copies only; the caller's
     stored run/state is never touched.
  2. Never block an override. There is no validation path here that raises
     or refuses — worst case is reported as cost (more unscheduled, more
     wait), never as a rejection. The planner holds information the model
     does not.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass
from datetime import date
from typing import Any

from scheduler.optimize import OptimizeResult, Optimizer, ScheduleEntry


@dataclass
class OverridePreview:
    """Mirrors Frontend_Build_Plan §5 `OverridePreview` exactly."""

    moved: list[dict[str, Any]]  # {tower_id, from, to, delta_days}
    dropped: list[str]
    risk_weighted_wait_before: float
    risk_weighted_wait_after: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "moved": self.moved,
            "dropped": self.dropped,
            "risk_weighted_wait_before": self.risk_weighted_wait_before,
            "risk_weighted_wait_after": self.risk_weighted_wait_after,
        }


def _index_by_tower(entries: list[ScheduleEntry]) -> dict[str, ScheduleEntry]:
    return {e.tower_id: e for e in entries}


def _days_between(day_a: str, day_b: str) -> int:
    return (date.fromisoformat(day_b) - date.fromisoformat(day_a)).days


def _diff(
    before: list[ScheduleEntry],
    before_unscheduled: list[str],
    after: list[ScheduleEntry],
    after_unscheduled: list[str],
) -> tuple[list[dict], list[str]]:
    """Every tower that changed slot or fell off the schedule entirely."""
    before_by_tower = _index_by_tower(before)
    after_by_tower = _index_by_tower(after)

    moved: list[dict] = []
    for tower_id, before_entry in before_by_tower.items():
        after_entry = after_by_tower.get(tower_id)
        if after_entry is None:
            continue  # counted in dropped below
        if (before_entry.crew_id, before_entry.day) != (after_entry.crew_id, after_entry.day):
            moved.append(
                {
                    "tower_id": tower_id,
                    # ISO date only — matches Frontend_Build_Plan §5's
                    # OverridePreview.moved[].from/to exactly. Crew changes
                    # are visible separately via the entry's own crew_id.
                    "from": before_entry.day,
                    "to": after_entry.day,
                    "delta_days": _days_between(before_entry.day, after_entry.day),
                }
            )

    # dropped = scheduled before, unscheduled after (newly displaced entirely)
    before_unsched_set = set(before_unscheduled)
    dropped = [tid for tid in after_unscheduled if tid not in before_unsched_set]

    return moved, dropped


class OverrideEngine:
    """Wraps an Optimizer to compute pin/preview/emergency against a given
    (entries, unscheduled, work_orders, towers_by_id) solver state."""

    def __init__(self, optimizer: Optimizer | None = None):
        self.optimizer = optimizer or Optimizer()

    def _resolve_around_pin(
        self,
        current_entries: list[ScheduleEntry],
        current_pins: list[ScheduleEntry],
        new_pin: ScheduleEntry,
        work_orders_by_tower: dict[str, dict],
        towers_by_id: dict[str, dict],
        today: date | None = None,
    ) -> OptimizeResult:
        """Re-solve everything except pinned entries, with new_pin added as a
        hard constraint. Operates entirely on copies passed in — caller
        decides whether to persist the result."""
        all_pins = [copy.deepcopy(p) for p in current_pins if p.tower_id != new_pin.tower_id]
        all_pins.append(new_pin)
        pinned_tower_ids = {p.tower_id for p in all_pins}

        # every tower that was ever in this schedule run (scheduled or not),
        # minus the ones now pinned, goes back through the optimizer
        all_tower_ids = {e.tower_id for e in current_entries} | set(work_orders_by_tower)
        # sorted(): all_tower_ids is a set, so iterating it raw hands the
        # optimizer a hash-ordered list whose sequence shifts when membership
        # changes. The optimizer breaks exact ties on tower_id and so no
        # longer depends on this, but a re-solve should not feed it a
        # different sequence for the same inputs in the first place.
        free_work_orders = [
            work_orders_by_tower[tid]
            for tid in sorted(all_tower_ids)
            if tid in work_orders_by_tower and tid not in pinned_tower_ids
        ]

        result = self.optimizer.optimize(
            free_work_orders,
            towers_by_id,
            pinned=all_pins,
            today=today,
            # Single-pass, always. This runs synchronously in the request path
            # while a planner waits on an approval they just clicked, and a
            # different random restart each time would reshuffle unrelated jobs
            # after every pin — churn the confirmation panel cannot explain and
            # the dispatch animation would narrate as if it were consequence.
            # The pin is anchored to a board that was already optimized once.
            restarts=1,
        )
        return result

    def preview(
        self,
        current_entries: list[ScheduleEntry],
        current_unscheduled: list[str],
        current_pins: list[ScheduleEntry],
        tower_id: str,
        target_crew_id: str,
        target_day: str,
        work_orders_by_tower: dict[str, dict],
        towers_by_id: dict[str, dict],
        pin_reason: str = "planner_override",
        pinned_by: str | None = None,
        today: date | None = None,
    ) -> OverridePreview:
        """Computes knock-on effects of pinning tower_id to (crew, day).
        Operates on copies only — never mutates caller state (Backend_Handoff §5)."""
        wo = work_orders_by_tower[tower_id]
        new_pin = ScheduleEntry(
            crew_id=target_crew_id,
            day=target_day,
            order=1,
            tower_id=tower_id,
            work_order=wo,
            pinned=True,
            pin_reason=pin_reason,
            pinned_by=pinned_by,
        )

        before_wait = self._objective_of(current_entries, towers_by_id, today)

        after_entries, after_unscheduled, after_wait = self._resolve_around_pin(
            current_entries,
            current_pins,
            new_pin,
            work_orders_by_tower,
            towers_by_id,
            today=today,
        )

        moved, dropped = _diff(
            current_entries, current_unscheduled, after_entries, after_unscheduled
        )

        return OverridePreview(
            moved=moved,
            dropped=dropped,
            risk_weighted_wait_before=before_wait,
            risk_weighted_wait_after=after_wait,
        )

    def pin(
        self,
        current_entries: list[ScheduleEntry],
        current_pins: list[ScheduleEntry],
        tower_id: str,
        target_crew_id: str,
        target_day: str,
        work_orders_by_tower: dict[str, dict],
        towers_by_id: dict[str, dict],
        pin_reason: str = "planner_override",
        pinned_by: str | None = None,
        today: date | None = None,
    ) -> OptimizeResult:
        """Commits the pin and re-solves. Returns the OptimizeResult (also
        tuple-unpackable as (entries, unscheduled, risk_weighted_wait)) for
        the caller to persist as the new ScheduleRun. Never blocked — no
        feasibility check gates this call; the planner's instruction is
        taken as given (Backend_Handoff §5)."""
        wo = work_orders_by_tower[tower_id]
        new_pin = ScheduleEntry(
            crew_id=target_crew_id,
            day=target_day,
            order=1,
            tower_id=tower_id,
            work_order=wo,
            pinned=True,
            pin_reason=pin_reason,
            pinned_by=pinned_by,
        )
        return self._resolve_around_pin(
            current_entries, current_pins, new_pin, work_orders_by_tower, towers_by_id, today=today
        )

    def emergency(
        self,
        current_entries: list[ScheduleEntry],
        current_unscheduled: list[str],
        current_pins: list[ScheduleEntry],
        tower_id: str,
        crew_id: str,
        work_orders_by_tower: dict[str, dict],
        towers_by_id: dict[str, dict],
        today: date | None = None,
        pinned_by: str | None = None,
        commit: bool = False,
    ) -> OverridePreview | OptimizeResult:
        """Force tower_id onto crew_id today. Same pin mechanism, day fixed
        to 'today' and pin_reason='emergency'. commit=False returns an
        OverridePreview (no mutation); commit=True returns the resolved
        schedule state to persist. Displacement (moved + dropped) is always
        computed so the caller can name what today's forced insertion pushed
        out, including anything dropped off the schedule entirely."""
        today = today or date.fromisoformat(self.optimizer.policy["demo_clock"]["today"])
        day_iso = today.isoformat()

        if not commit:
            return self.preview(
                current_entries,
                current_unscheduled,
                current_pins,
                tower_id,
                crew_id,
                day_iso,
                work_orders_by_tower,
                towers_by_id,
                pin_reason="emergency",
                pinned_by=pinned_by,
                today=today,
            )

        return self.pin(
            current_entries,
            current_pins,
            tower_id,
            crew_id,
            day_iso,
            work_orders_by_tower,
            towers_by_id,
            pin_reason="emergency",
            pinned_by=pinned_by,
            today=today,
        )

    def _objective_of(
        self,
        entries: list[ScheduleEntry],
        towers_by_id: dict[str, dict],
        today: date | None,
    ) -> float:
        """Recompute risk_weighted_wait for a given entries snapshot, without
        re-solving — used to report the 'before' figure in a preview."""
        today = today or date.fromisoformat(self.optimizer.policy["demo_clock"]["today"])
        road_factor = self.optimizer.policy["travel"]["road_factor"]
        lam = float(self.optimizer.policy["objective"]["travel_weight_lambda"])
        crews_by_id = {c["crew_id"]: c for c in self.optimizer.crews}

        total = 0.0
        for e in entries:
            tower = towers_by_id.get(e.tower_id)
            crew = crews_by_id.get(e.crew_id)
            if tower is None or crew is None:
                continue
            from scheduler.optimize import priority, travel_km

            day = date.fromisoformat(e.day)
            days_until_serviced = max(0, (day - today).days)
            dist = travel_km(crew, tower, road_factor)
            total += priority(tower) * days_until_serviced + lam * dist
        return total
