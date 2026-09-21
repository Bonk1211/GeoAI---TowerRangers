"""GET /integrations — the tool surface this platform offers to other systems.

The Integrations page is product-facing: it shows how this platform plugs into
others, not the backend's own plumbing. Its one live section is the agent's tool
set, served from here so the page lists exactly the tools the runner hands
Claude rather than a hand-typed copy that drifts the first time a tool changes.
Everything else on that page (the roadmap) is labelled as planned in the UI.

Offline and free: reads the tool schemas and whether ANTHROPIC_API_KEY is
present, never the network, and never a secret value.
"""
from __future__ import annotations

import os
from typing import Any

from fastapi import APIRouter

from agent.runner import AGENT_MODEL
from agent.tools import TOOL_SCHEMAS

router = APIRouter(prefix="/integrations", tags=["integrations"])


def _tool_parameters(schema: dict[str, Any]) -> list[dict[str, Any]]:
    props = schema.get("properties", {})
    required = set(schema.get("required", []))
    out = []
    for name, spec in props.items():
        kind = spec.get("type", "any")
        if kind == "array":
            kind = f"{spec.get('items', {}).get('type', 'any')}[]"
        out.append({
            "name": name,
            "type": kind,
            "required": name in required,
            "description": spec.get("description"),
        })
    return out


@router.get("")
def list_integrations() -> dict[str, Any]:
    live = bool(os.environ.get("ANTHROPIC_API_KEY", "").strip())
    return {
        "agent": {
            "mode": "claude" if live else "fallback",
            # null on the fallback path, which calls no model.
            "model": AGENT_MODEL if live else None,
            "tools": [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": _tool_parameters(tool.get("input_schema", {})),
                }
                for tool in TOOL_SCHEMAS
            ],
        },
    }
