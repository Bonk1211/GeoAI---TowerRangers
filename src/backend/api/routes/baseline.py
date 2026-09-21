"""GET /schedule/baseline -> policy comparison (PRD §9, step 9).

Additive endpoint — not in Frontend_Build_Plan §5's frozen list (the
frontend doesn't currently fetch it), but doesn't collide with any frozen
shape either. Exists to serve the headline metric for the writeup/demo
without re-deriving it by hand each time.
"""
from __future__ import annotations

from fastapi import APIRouter

from fixtures.source import scored_towers
from scheduler.actions import propose_actions
from scheduler.baseline import compare_policies
from scheduler.optimize import Optimizer

router = APIRouter(tags=["baseline"])

_optimizer = Optimizer()


@router.get("/schedule/baseline")
def get_baseline_comparison() -> dict:
    # Shared with /schedule/optimize and the agent tools via
    # fixtures.source.scored_towers() so they agree on the tower population.
    towers = scored_towers()
    maintain = [t for t in towers if t["decision"] == "maintain"]
    towers_by_id = {t["tower_id"]: t for t in maintain}
    work_orders = [wo.to_dict() for wo in propose_actions(maintain)]

    comparison = compare_policies(work_orders, towers_by_id, _optimizer)
    return comparison.to_dict()
