"""Tool-calling loop + SSE (Backend_Handoff §2/§7, step 8).

The LLM may never emit a schedule directly (PRD §8.2) — every schedule
shown is the return value of optimize_schedule_tool, and the runner reports
that value verbatim rather than asking the model to describe it.

Two paths:
  - ANTHROPIC_API_KEY set: real Claude tool-calling loop.
  - not set: deterministic fallback (apply_constraint -> echo -> optimize),
    same tool functions, no model call. This is what "renders even with the
    LLM down or slow" (PRD §8.1) means applied to the agent itself, and it
    is also what keeps the demo safe with no network dependency (§12).

Either path streams the same SSE event vocabulary, so the frontend does not
need to know which one is active:
  event: text            -- a chunk of assistant prose
  event: tool_call        -- {name, input}
  event: tool_result       -- {name, output}
  event: constraint_echo   -- the parsed-constraint confirmation string
  event: schedule          -- the ScheduleRun-shaped dict, solver output only
  event: done               -- terminal
"""
from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from typing import Any

from agent.tools import (
    TOOL_SCHEMAS,
    ParsedConstraint,
    apply_constraint,
    optimize_schedule_tool,
    propose_actions_tool,
    score_towers,
)
from fixtures.source import scored_towers as _scored_towers
from scheduler.store import run_store

# Named so GET /integrations reports the model this loop actually calls, rather
# than a second literal that drifts the first time someone changes this one.
AGENT_MODEL = "claude-sonnet-5"

SYSTEM_PROMPT = """You are Ranger, the autonomous scheduling and dispatch optimizer for a telecom tower \
maintenance system. You orchestrate four tools; you never invent a \
schedule yourself. When the planner states a constraint (a crew being \
unavailable, an emergency dispatch), call apply_constraint first and \
relay its echo string back to the user verbatim before doing anything \
else. Only call optimize_schedule after the constraint has been echoed. \
Never describe a crew/day assignment in your own words — always call \
optimize_schedule and report its result."""


def _constraint_from_dict(d: dict[str, Any] | None) -> ParsedConstraint | None:
    """Reconstructs the dataclass apply_constraint's tool-result dict was
    flattened from, so a later optimize_schedule call in the same turn can
    enforce it. An 'unparsed' constraint (low confidence, nothing resolved)
    carries no crew_id/day/tower_id worth enforcing — treated as no
    constraint at all rather than passed through as an empty one."""
    if not d or d.get("kind") in (None, "unparsed"):
        return None
    return ParsedConstraint(
        kind=d["kind"],
        crew_id=d.get("crew_id"),
        day=d.get("day"),
        tower_id=d.get("tower_id"),
        member=d.get("member"),
        raw_text=d.get("raw_text", ""),
        confidence=d.get("confidence", "low"),
    )


def _dispatch_tool(
    name: str, tool_input: dict[str, Any], constraint: ParsedConstraint | None = None
) -> Any:
    """Executes one of the four tools by name. Single choke point so both
    the real-model path and the fallback path share identical tool
    behaviour — the only difference is who decides to call them.

    `constraint` carries whatever apply_constraint most recently resolved in
    this turn, forward into the next optimize_schedule call. It used to go
    nowhere: the constraint was echoed to the planner and then discarded,
    so 'crew SEL-C1 unavailable Thursday' followed by a re-optimize could
    return the identical board — the crew-day exclusion was never told to
    the solver. Only optimize_schedule consults this parameter.
    """
    if name == "score_towers":
        return score_towers(tool_input.get("weights"))
    if name == "propose_actions":
        return propose_actions_tool(tool_input["tower_ids"])
    if name == "optimize_schedule":
        # Shared with the HTTP schedule route via fixtures.source.scored_towers()
        # so an agent-driven re-optimize plans over the same tower population
        # the board is already showing.
        all_towers = _scored_towers()
        tower_ids = tool_input.get("tower_ids")
        if tower_ids:
            wanted = set(tower_ids)
            towers_records = [t for t in all_towers if t["tower_id"] in wanted]
        else:
            towers_records = [t for t in all_towers if t["decision"] == "maintain"]
        work_orders = propose_actions_tool([t["tower_id"] for t in towers_records])
        towers_by_id = {t["tower_id"]: t for t in towers_records}
        return optimize_schedule_tool(work_orders, towers_by_id, run_store, constraints=constraint)
    if name == "apply_constraint":
        pc = apply_constraint(tool_input["nl_text"])
        return {
            "kind": pc.kind,
            "crew_id": pc.crew_id,
            "day": pc.day,
            "tower_id": pc.tower_id,
            "member": pc.member,
            "echo": pc.echo(),
            "confidence": pc.confidence,
        }
    raise ValueError(f"unknown tool: {name}")


async def _run_fallback(user_text: str) -> AsyncIterator[dict[str, Any]]:
    """No-LLM path: parse the message as a constraint, echo it, and if it
    resolved with high confidence, re-optimize and stream the new schedule.
    Deterministic, no network call — the demo-safety path (§12)."""
    yield {"event": "tool_call", "data": {"name": "apply_constraint", "input": {"nl_text": user_text}}}
    result = _dispatch_tool("apply_constraint", {"nl_text": user_text})
    yield {"event": "tool_result", "data": {"name": "apply_constraint", "output": result}}
    yield {"event": "constraint_echo", "data": {"text": result["echo"]}}

    if result["confidence"] != "high":
        yield {"event": "text", "data": {"text": result["echo"]}}
        yield {"event": "done", "data": {}}
        return

    yield {"event": "text", "data": {"text": "Re-optimizing against the updated constraint."}}
    yield {"event": "tool_call", "data": {"name": "optimize_schedule", "input": {}}}
    schedule = _dispatch_tool("optimize_schedule", {}, constraint=_constraint_from_dict(result))
    yield {"event": "tool_result", "data": {"name": "optimize_schedule", "output": {"run_id": schedule["run_id"]}}}
    yield {"event": "schedule", "data": schedule}
    yield {"event": "done", "data": {}}


async def _run_anthropic(user_text: str, api_key: str) -> AsyncIterator[dict[str, Any]]:
    """Real Claude tool-calling loop. Model decides which tools to call and
    in what order; this function only executes tools and streams events —
    it never lets model text stand in for a schedule (system prompt +
    the fact that 'schedule' events only ever come from _dispatch_tool)."""
    import anthropic

    client = anthropic.AsyncAnthropic(api_key=api_key)
    messages: list[dict[str, Any]] = [{"role": "user", "content": user_text}]
    # Carries the most recently resolved constraint across tool calls within
    # this turn, so a model-issued optimize_schedule call enforces whatever
    # apply_constraint just echoed — the model is never asked to re-state
    # the constraint in its own tool_input for this to work.
    last_constraint: ParsedConstraint | None = None

    for _ in range(6):  # bounded loop — never spin forever on a stuck tool chain
        response = await client.messages.create(
            model=AGENT_MODEL,
            max_tokens=1024,
            system=SYSTEM_PROMPT,
            tools=TOOL_SCHEMAS,
            messages=messages,
        )

        text_parts = [b.text for b in response.content if b.type == "text"]
        for t in text_parts:
            if t:
                yield {"event": "text", "data": {"text": t}}

        tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
        if not tool_use_blocks:
            break

        messages.append({"role": "assistant", "content": response.content})
        tool_results = []
        for block in tool_use_blocks:
            yield {"event": "tool_call", "data": {"name": block.name, "input": block.input}}
            try:
                output = _dispatch_tool(block.name, block.input, constraint=last_constraint)
            except Exception as exc:  # tool error surfaced to the model, not swallowed
                output = {"error": str(exc)}
            yield {"event": "tool_result", "data": {"name": block.name, "output": output}}

            if block.name == "apply_constraint" and isinstance(output, dict) and "echo" in output:
                last_constraint = _constraint_from_dict(output)
                yield {"event": "constraint_echo", "data": {"text": output["echo"]}}
            if block.name == "optimize_schedule" and isinstance(output, dict) and "entries" in output:
                yield {"event": "schedule", "data": output}

            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": json.dumps(output, default=str),
                }
            )
        messages.append({"role": "user", "content": tool_results})

        if response.stop_reason != "tool_use":
            break

    yield {"event": "done", "data": {}}


async def run_agent_turn(user_text: str) -> AsyncIterator[dict[str, Any]]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        async for event in _run_anthropic(user_text, api_key):
            yield event
    else:
        async for event in _run_fallback(user_text):
            yield event


def format_sse(event: dict[str, Any]) -> str:
    return f"event: {event['event']}\ndata: {json.dumps(event['data'], default=str)}\n\n"
