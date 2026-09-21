"""In-memory schedule-run store. Competition prototype (~1 day) — no DB.
Keyed by run_id; holds everything a later preview/pin/why call needs to
operate on that run's state without re-deriving it from scratch.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any

from scheduler.optimize import ScheduleEntry


@dataclass
class StoredRun:
    run_id: str
    entries: list[ScheduleEntry]
    unscheduled: list[str]
    risk_weighted_wait: float
    horizon: list[str] = field(default_factory=list)
    reserve: list[Any] = field(default_factory=list)  # list[ReserveSlot]
    unscheduled_detail: list[Any] = field(default_factory=list)  # list[UnscheduledItem]
    pins: list[ScheduleEntry] = field(default_factory=list)
    work_orders_by_tower: dict[str, dict] = field(default_factory=dict)
    towers_by_id: dict[str, dict] = field(default_factory=dict)
    override_log: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """The one wire serialisation of a run.

        Both `GET /schedule/{run_id}` and the agent's optimize_schedule tool
        render a run through this, so the two can no longer disagree about
        which fields a caller gets. They did: the tool built its own dict of
        four keys and dropped horizon/reserve/unscheduled_detail, which the
        frontend lays the whole board out from.
        """
        return {
            "run_id": self.run_id,
            "horizon": self.horizon,
            "entries": [e.to_dict() for e in self.entries],
            "reserve": [r.to_dict() for r in self.reserve],
            "unscheduled": self.unscheduled,
            "unscheduled_detail": [u.to_dict() for u in self.unscheduled_detail],
            "risk_weighted_wait": self.risk_weighted_wait,
        }


class RunStore:
    def __init__(self) -> None:
        self._runs: dict[str, StoredRun] = {}

    def new_run_id(self) -> str:
        return f"run_{uuid.uuid4().hex[:12]}"

    def save(self, run: StoredRun) -> None:
        self._runs[run.run_id] = run

    def get(self, run_id: str) -> StoredRun | None:
        return self._runs.get(run_id)

    def latest(self) -> StoredRun | None:
        if not self._runs:
            return None
        return list(self._runs.values())[-1]


# module-level singleton — fine for a single-process demo backend
run_store = RunStore()
