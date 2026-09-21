"""Dominant factor -> work order (PRD §6, Backend_Handoff §2/§8, step 3).

Deterministic lookup against config/actions.yaml. No ML, no hardcoded
factor->crew_type mapping here — changing the YAML changes behaviour
(Backend_Handoff §9 review point #7).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config" / "actions.yaml"


@dataclass(frozen=True)
class WorkOrder:
    """Mirrors Frontend_Build_Plan §5 `WorkOrder` exactly."""

    tower_id: str
    action: str
    crew_type: str
    parts: list[str]
    urgency_days: int
    why: str
    # extra fields beyond the frozen frontend shape — additive, safe to ignore
    label: str = ""
    lead_time_class: str = ""
    # On-site hours from actions.yaml. Travel is NOT included — the optimizer
    # derives that per leg from the route, so the same job costs more of the
    # shift at a far tower than a near one.
    duration_hours: float = 0.0
    risk: float | None = None
    dominant_factor: str = ""
    estimated: bool = False
    # Observed fire evidence, and only on a reviewed fire inspection — None on
    # every order the factor lookup below produces. It rides the WORK ORDER and
    # not the tower record because a tower record is the score's own shape: an
    # attribution key, a dominant_factor, a band. Fire is evidence beside the
    # score, never inside it (docs/Backend_Handoff.md §0.6, §1).
    fire_inspection: dict | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "tower_id": self.tower_id,
            "action": self.action,
            "crew_type": self.crew_type,
            "parts": self.parts,
            "urgency_days": self.urgency_days,
            "why": self.why,
            "label": self.label,
            "lead_time_class": self.lead_time_class,
            "duration_hours": self.duration_hours,
            "risk": self.risk,
            "dominant_factor": self.dominant_factor,
            "estimated": self.estimated,
            "fire_inspection": self.fire_inspection,
        }


def load_action_map(path: Path = CONFIG_PATH) -> dict[str, dict]:
    with open(path, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    # top-level keys are factor names; strip nothing else needed
    return {k: v for k, v in data.items() if isinstance(v, dict)}


def _format_why(attribution: dict[str, float]) -> str:
    """Verbatim attribution -> sentence, sorted descending share (PRD §6)."""
    ordered = sorted(attribution.items(), key=lambda kv: kv[1], reverse=True)
    return ", ".join(f"{factor} {share:.2f}" for factor, share in ordered)


def propose_action(tower: dict, action_map: dict[str, dict] | None = None) -> WorkOrder:
    """One scored-tower record (Backend_Handoff §1 shape) -> one WorkOrder.

    Raises KeyError if `dominant_factor` has no entry in actions.yaml —
    surfaced loudly rather than silently dropping the tower's work order.
    """
    if action_map is None:
        action_map = load_action_map()

    factor = tower["dominant_factor"]
    if factor not in action_map:
        raise KeyError(
            f"tower {tower.get('tower_id')}: dominant_factor {factor!r} has no "
            f"entry in actions.yaml (known: {sorted(action_map)})"
        )
    spec = action_map[factor]

    return WorkOrder(
        tower_id=tower["tower_id"],
        action=spec["action"],
        crew_type=spec["crew_type"],
        parts=list(spec["parts"]),
        urgency_days=int(tower["urgency_days"]),
        why=_format_why(tower["attribution"]),
        label=spec.get("label", ""),
        lead_time_class=spec.get("lead_time_class", ""),
        duration_hours=float(spec.get("duration_hours", 0.0)),
        risk=tower.get("risk"),
        dominant_factor=factor,
        estimated=bool(tower.get("estimated", False)),
    )


# The actions.yaml key a fire inspection is looked up by. Every other key in
# that file is a dominant_factor name and is reached by lookup from the tower
# record; this one is reached by literal name from the function below, because
# no tower ever carries a fire factor.
FIRE_INSPECTION_KEY = "fire_exposure_inspection"


def _format_fire_why(evidence: dict) -> str:
    """Observed fire evidence -> sentence. Counts and timestamps only.

    Deliberately not _format_why(): that renders attribution shares, and a share
    is the score's own language. Writing "fire 0.38" here would put a satellite
    observation into the same sentence shape as an AHP factor and invite the
    reading that the model attributed 0.38 of this tower's risk to fire.
    """
    km = float(evidence["buffer_m"]) / 1000
    # Rendered from the evidence rather than asserted. The route refuses an
    # unconfirmed request with a 400, so today only the confirmed branch is
    # reachable — but a work order that claims an attestation nobody made is
    # exactly the failure this feature is arranged to avoid.
    access = (
        "planner reviewed, safe access confirmed"
        if evidence.get("safe_access_confirmed")
        else "planner reviewed, safe access NOT confirmed"
    )
    return (
        f"fire exposure observed: {int(evidence['hotspot_pixel_days'])} hotspot "
        f"detection-days within {km:g} km, most recent {evidence['observed_at']} "
        f"({evidence['max_confidence']} confidence); {access}"
    )


def propose_fire_inspection(
    tower: dict, evidence: dict, action_map: dict[str, dict] | None = None
) -> WorkOrder:
    """A reviewed fire-exposure inspection for one tower.

    Deliberately not routed through propose_action(): that function reads
    tower["dominant_factor"] and renders `why` from tower["attribution"], and a
    fire inspection has neither. Writing an attribution sentence here would put
    observed fire evidence into the score's own language, which is the one thing
    this feature must not do.

    urgency_days comes from the action's own `target_days`, not from the tower —
    the scored-tower record's urgency_days is the deadline for the maintenance
    need the model measured, and the model never saw the fire.
    """
    if action_map is None:
        action_map = load_action_map()

    spec = action_map[FIRE_INSPECTION_KEY]
    return WorkOrder(
        tower_id=tower["tower_id"],
        action=spec["action"],
        crew_type=spec["crew_type"],
        parts=list(spec["parts"]),
        urgency_days=int(spec["target_days"]),
        why=_format_fire_why(evidence),
        label=spec.get("label", ""),
        lead_time_class=spec.get("lead_time_class", ""),
        duration_hours=float(spec.get("duration_hours", 0.0)),
        risk=tower.get("risk"),
        # Empty, never a fire value: dominant_factor is the argmax of the
        # attribution and selects an intervention, and this order was selected
        # by a planner reviewing an observation instead.
        dominant_factor="",
        fire_inspection=evidence,
    )


def propose_actions(towers: list[dict], action_map: dict[str, dict] | None = None) -> list[WorkOrder]:
    """propose_actions(tower_ids) tool surface (Backend_Handoff §7) — here
    taking full tower records; the agent-tool wrapper resolves ids -> records."""
    if action_map is None:
        action_map = load_action_map()
    return [propose_action(t, action_map) for t in towers]
