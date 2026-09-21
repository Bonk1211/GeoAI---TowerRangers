"""The four agent tools (PRD §8.2, Backend_Handoff §7, step 8).

    score_towers(weights?)          -> ranked towers + attribution   [proxies to ML side]
    propose_actions(tower_ids)      -> work orders                   [ours]
    optimize_schedule(orders, ctx)  -> crew/day assignment           [ours]
    apply_constraint(nl_text)       -> parsed constraint + revised context [ours]

The LLM orchestrates by calling these; it never emits a schedule directly.
Every schedule shown anywhere is a return value of optimize_schedule.
Mirrors the tool-definition pattern in geoai/agents/geo_agents.py as prior
art (Strands-based) — not imported, since it targets notebooks.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

from fixtures.source import scored_towers as _scored_towers
from scheduler.actions import propose_actions as _propose_actions
from scheduler.config_loader import load_crews
from scheduler.optimize import Optimizer
from scheduler.store import RunStore, StoredRun

_optimizer = Optimizer()


def _crew_id_for_member(name_fragment: str) -> str | None:
    """Resolves a member's first/last name to their crew_id (PRD §7.2:
    'Ahmad on leave Thursday' must resolve to something concrete)."""
    frag = name_fragment.lower()
    for crew in load_crews():
        for member in crew["members"]:
            if frag in member.lower():
                return crew["crew_id"]
    return None


def score_towers(weights: dict[str, float] | None = None) -> list[dict]:
    """Proxies to the ML side's scorer (via fixtures.source.scored_towers,
    the same source the HTTP schedule route uses). Weights are accepted for
    shape parity with the real endpoint (PRD §8.2) but this mock does not
    re-score — that logic is owned by the ML teammates (Backend_Handoff §0.1)."""
    return _scored_towers()


def propose_actions_tool(tower_ids: list[str]) -> list[dict]:
    towers = [t for t in _scored_towers() if t["tower_id"] in set(tower_ids)]
    return [wo.to_dict() for wo in _propose_actions(towers)]


def optimize_schedule_tool(
    work_orders: list[dict],
    towers_by_id: dict[str, dict],
    run_store: RunStore,
    constraints: "ParsedConstraint | None" = None,
) -> dict:
    """Runs the real greedy optimizer (scheduler/optimize.py) and persists a
    new run. This is the only tool that produces a schedule — the LLM calls
    it and reports what came back, per PRD §8.1."""
    pinned = constraints.to_pins(work_orders) if constraints else []
    blocked_crew_days = constraints.to_blocked_crew_days() if constraints else set()
    # Capture the OptimizeResult itself. This used to unpack it as
    # `entries, unscheduled, wait = ...` via OptimizeResult.__iter__, the
    # legacy 3-tuple shim — which compiled fine while silently discarding
    # horizon, reserve and unscheduled_detail. The frontend lays the entire
    # board out from run.horizon, so an agent-driven re-optimize produced a
    # schedule the UI could not render. See test_tools.py.
    result = _optimizer.optimize(
        work_orders, towers_by_id, pinned=pinned, blocked_crew_days=blocked_crew_days
    )
    run = StoredRun(
        run_id=run_store.new_run_id(),
        entries=result.entries,
        unscheduled=result.unscheduled,
        risk_weighted_wait=result.risk_weighted_wait,
        horizon=result.horizon,
        reserve=result.reserve,
        unscheduled_detail=result.unscheduled_detail,
        pins=pinned,
        work_orders_by_tower={wo["tower_id"]: wo for wo in work_orders},
        towers_by_id=towers_by_id,
    )
    run_store.save(run)
    # Same serialisation GET /schedule/{run_id} returns, by construction.
    return run.to_dict()


@dataclass
class ParsedConstraint:
    """Structured output of apply_constraint — echoed to the planner before
    solving (PRD §13, Backend_Handoff §7: 'parse errors visible, not silent')."""

    kind: str  # "crew_unavailable" | "emergency_dispatch" | "unparsed"
    crew_id: str | None = None
    day: str | None = None
    tower_id: str | None = None
    member: str | None = None  # set when resolved from a member name, not a bare crew_id
    raw_text: str = ""
    confidence: str = "low"  # "high" | "low" — low triggers a confirm prompt

    def echo(self) -> str:
        if self.kind == "crew_unavailable":
            if self.member:
                return (
                    f"Understood: {self.member} unavailable {self.day} "
                    f"({self.crew_id} capacity reduced). Re-optimize?"
                )
            return f"Understood: crew {self.crew_id} unavailable {self.day}. Re-optimize?"
        if self.kind == "emergency_dispatch":
            return f"Understood: emergency dispatch to {self.tower_id} today. Re-optimize?"
        return f"Could not confidently parse constraint from: {self.raw_text!r}. Please rephrase."

    def to_pins(self, work_orders: list[dict]) -> list:
        """Only emergency_dispatch constraints translate into a pin — a hard
        instruction to place a specific tower today. crew_unavailable is a
        capacity exclusion, not a placement, so it is expressed instead via
        to_blocked_crew_days() and enforced as a candidate filter inside
        optimize(), not as a pin here."""
        return []

    def to_blocked_crew_days(self) -> set[tuple[str, str]]:
        """crew_unavailable -> the one (crew_id, day) the optimizer must
        treat as zero-capacity on the re-solve. This used to be echoed and
        logged only — 'crew SEL-C1 unavailable Thursday' confirmed back to
        the planner but never actually removed from the candidate pool, so
        a re-optimize after stating it could return the identical board.
        Resolved crew_id only: apply_constraint already turns a bare member
        name (e.g. 'Ahmad') into its crew_id before this is ever called, so
        there is nothing further to resolve here."""
        if self.kind == "crew_unavailable" and self.crew_id and self.day:
            return {(self.crew_id, self.day)}
        return set()


_WEEKDAYS = {
    "monday": 0, "mon": 0, "tuesday": 1, "tue": 1, "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "friday": 4, "fri": 4, "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}


def _next_weekday_iso(weekday_name: str, today: date) -> str | None:
    target = _WEEKDAYS.get(weekday_name.lower())
    if target is None:
        return None
    delta = (target - today.weekday()) % 7
    delta = delta or 7  # "today" phrased as a weekday name means next occurrence
    from datetime import timedelta

    return (today + timedelta(days=delta)).isoformat()


def apply_constraint(nl_text: str, today: date | None = None) -> ParsedConstraint:
    """Natural language -> structured constraint. No LLM required for the
    ship-now tier: rule-based parsing over a small, demo-scoped grammar, so
    this renders even with the LLM down (PRD §8.1's determinism guarantee
    extended to constraint parsing as a fallback path). If an LLM is wired
    into the runner, it may call this tool with its own extracted slots
    instead of raw text — same function, same echo contract either way.
    """
    today = today or date.fromisoformat(_optimizer.policy["demo_clock"]["today"])
    text = nl_text.strip()
    lower = text.lower()

    crew_match = re.search(r"\b([A-Z]{2,4}-[A-Za-z]\d+)\b", text)
    tower_match = re.search(r"\b(MY_\d{3,5}|\d{4})\b", text)

    if "unavailable" in lower or "on leave" in lower or "leave" in lower:
        crew_id = crew_match.group(1) if crew_match else None
        member = None
        if crew_id is None:
            # try resolving a member's name instead (PRD §7.2: "Ahmad on
            # leave Thursday" -> KEL-C1, not left unrepresentable)
            leading_words = re.findall(r"[A-Z][a-zA-Z]+", text)
            for word in leading_words:
                resolved = _crew_id_for_member(word)
                if resolved:
                    crew_id = resolved
                    member = word
                    break
        day_iso = None
        for name in _WEEKDAYS:
            if re.search(rf"\b{name}\b", lower):
                day_iso = _next_weekday_iso(name, today)
                break
        if crew_id and day_iso:
            return ParsedConstraint(
                kind="crew_unavailable",
                crew_id=crew_id,
                day=day_iso,
                member=member,
                raw_text=text,
                confidence="high",
            )

    if "emergency" in lower or "send someone" in lower or "today" in lower or "dispatch now" in lower:
        tower_id = tower_match.group(1) if tower_match else None
        if tower_id:
            if not tower_id.startswith("MY_"):
                tower_id = f"MY_{tower_id}"
            return ParsedConstraint(
                kind="emergency_dispatch",
                tower_id=tower_id,
                day=today.isoformat(),
                raw_text=text,
                confidence="high",
            )

    return ParsedConstraint(kind="unparsed", raw_text=text, confidence="low")


TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "name": "score_towers",
        "description": (
            "Get ranked towers with risk score and per-factor attribution. "
            "Proxies to the ML scoring side; optional weights re-rank."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "weights": {
                    "type": "object",
                    "description": "Optional factor->weight overrides",
                }
            },
        },
    },
    {
        "name": "propose_actions",
        "description": "Map a list of tower_ids to work orders (action, crew_type, parts, why).",
        "input_schema": {
            "type": "object",
            "properties": {
                "tower_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tower_ids"],
        },
    },
    {
        "name": "optimize_schedule",
        "description": (
            "Run the constrained optimizer over a set of work orders and "
            "return the crew/day assignment. This is the ONLY way a "
            "schedule is produced — never emit one yourself."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "tower_ids": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["tower_ids"],
        },
    },
    {
        "name": "apply_constraint",
        "description": (
            "Parse a natural-language scheduling constraint (crew leave, "
            "emergency dispatch) into a structured constraint. Always echo "
            "the parsed result back to the user before re-optimizing."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "nl_text": {"type": "string"},
            },
            "required": ["nl_text"],
        },
    },
]
