"""GET /crews -> Crew[] (Backend_Handoff §6, Frontend_Build_Plan §5)."""
from __future__ import annotations

from fastapi import APIRouter

from scheduler.config_loader import load_crews

router = APIRouter(tags=["crews"])


@router.get("/crews")
def get_crews() -> list[dict]:
    return load_crews()
