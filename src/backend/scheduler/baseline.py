"""Naive-dispatch comparison — the headline metric (PRD §9, Backend_Handoff
§2, step 9).

"Risk-weighted response time reduced X% versus nearest-first dispatch at
identical crew capacity." Comparing two dispatch *policies* on identical
demand and identical constraints is a legitimate quantitative claim (unlike
the risk index, which cannot claim accuracy — Concept_Overview §6).

Both policies run through the same Optimizer.optimize() — same territory,
depot-range, crew-type, shift, SLA, monsoon constraints, same crew roster,
same work orders. The only thing that differs is sort_key_fn: which job a
dispatcher works on next. That is what makes "identical crew capacity" true
rather than asserted.

  - greedy (ours):        priority (risk * log1p(exposed_pop)) * urgency_factor, descending
  - nearest-first (naive): distance from the nearest feasible crew's depot, ascending
                            — a dispatcher who just works whatever is closest,
                            blind to risk or urgency (the status quo this project argues against)
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from typing import Any

from scheduler.optimize import Optimizer, ScheduleEntry, travel_km


@dataclass
class PolicyResult:
    entries: list[ScheduleEntry]
    unscheduled: list[str]
    risk_weighted_wait: float
    mean_days_to_service_top_decile: float | None
    sla_breach_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "entries": [e.to_dict() for e in self.entries],
            "unscheduled": self.unscheduled,
            "risk_weighted_wait": self.risk_weighted_wait,
            "mean_days_to_service_top_decile": self.mean_days_to_service_top_decile,
            "sla_breach_count": self.sla_breach_count,
        }


@dataclass
class BaselineComparison:
    greedy: PolicyResult
    nearest_first: PolicyResult
    risk_weighted_wait_reduction_pct: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "greedy": self.greedy.to_dict(),
            "nearest_first": self.nearest_first.to_dict(),
            "risk_weighted_wait_reduction_pct": self.risk_weighted_wait_reduction_pct,
        }


def _nearest_first_key(optimizer: Optimizer, work_order: dict, tower: dict) -> float:
    """Distance from the tower to its nearest feasible-type crew depot,
    ascending — the naive policy processes whatever is physically closest
    first, with no notion of risk or urgency."""
    road_factor = optimizer.policy["travel"]["road_factor"]
    candidates = optimizer._candidate_crews(work_order, tower)
    if not candidates:
        return float("inf")
    return min(travel_km(c, tower, road_factor) for c in candidates)


def _score_policy(
    optimizer: Optimizer,
    entries: list[ScheduleEntry],
    unscheduled: list[str],
    risk_weighted_wait: float,
    towers_by_id: dict[str, dict],
    today: date,
) -> PolicyResult:
    """Mean days-to-service for the top-decile-risk towers, and SLA-breach
    count — reported alongside the headline number (PRD §9)."""
    all_towers = sorted(towers_by_id.values(), key=lambda t: t["risk"], reverse=True)
    decile_cut = max(1, len(all_towers) // 10)
    top_decile_ids = {t["tower_id"] for t in all_towers[:decile_cut]}

    entries_by_tower = {e.tower_id: e for e in entries}
    top_decile_days = []
    for tid in top_decile_ids:
        entry = entries_by_tower.get(tid)
        if entry is not None:
            days = (date.fromisoformat(entry.day) - today).days
            top_decile_days.append(days)
    mean_days = sum(top_decile_days) / len(top_decile_days) if top_decile_days else None

    sla_breaches = 0
    for e in entries:
        tower = towers_by_id.get(e.tower_id)
        if tower is None:
            continue
        deadline_days = int(tower.get("urgency_days", optimizer.policy["sla"]["fallback_sla_days"]))
        actual_days = (date.fromisoformat(e.day) - today).days
        if actual_days > deadline_days:
            sla_breaches += 1
    sla_breaches += len(unscheduled)  # never-serviced towers are SLA breaches by definition

    return PolicyResult(
        entries=entries,
        unscheduled=unscheduled,
        risk_weighted_wait=risk_weighted_wait,
        mean_days_to_service_top_decile=mean_days,
        sla_breach_count=sla_breaches,
    )


def compare_policies(
    work_orders: list[dict],
    towers_by_id: dict[str, dict],
    optimizer: Optimizer | None = None,
    today: date | None = None,
) -> BaselineComparison:
    optimizer = optimizer or Optimizer()
    today = today or date.fromisoformat(optimizer.policy["demo_clock"]["today"])

    # Both single-pass, deliberately. This comparison is only meaningful
    # because the two policies run through IDENTICAL constraints and differ
    # solely in sort_key_fn. Multi-start is a SEARCH improvement, not a
    # dispatch-policy one: letting the greedy side use restarts while the
    # naive baseline gets one pass would fold the search gain into a number
    # that claims to measure dispatch policy, and the headline figure would
    # overstate itself by however much the restarts happened to find.
    greedy_entries, greedy_unscheduled, greedy_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today, restarts=1
    )

    def nearest_first_key(wo: dict, tower: dict) -> float:
        return _nearest_first_key(optimizer, wo, tower)

    nf_entries, nf_unscheduled, nf_wait = optimizer.optimize(
        work_orders, towers_by_id, today=today, sort_key_fn=nearest_first_key, restarts=1
    )

    greedy_result = _score_policy(
        optimizer, greedy_entries, greedy_unscheduled, greedy_wait, towers_by_id, today
    )
    nf_result = _score_policy(
        optimizer, nf_entries, nf_unscheduled, nf_wait, towers_by_id, today
    )

    reduction_pct = 0.0
    if nf_wait > 0:
        reduction_pct = round(100.0 * (nf_wait - greedy_wait) / nf_wait, 1)

    return BaselineComparison(
        greedy=greedy_result,
        nearest_first=nf_result,
        risk_weighted_wait_reduction_pct=reduction_pct,
    )
