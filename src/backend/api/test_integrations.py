"""Unit tests for GET /integrations.

The guards are about the page listing something other than what the agent
really has:

  * the listed tools drifting from what the runner actually hands Claude;
  * the fallback path claiming a model it never calls;
  * a key's VALUE reaching the browser when only its presence decides the mode.

Network-free. Run from src/backend:  python -m pytest api/test_integrations.py
"""

import json
import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from agent.runner import AGENT_MODEL
from agent.tools import TOOL_SCHEMAS
from api.routes import integrations as route

SENTINEL = "sk-ant-SENTINEL_must_never_leave_the_backend"


@pytest.fixture(autouse=True)
def no_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def test_tools_are_exactly_what_the_runner_hands_claude():
    tools = route.list_integrations()["agent"]["tools"]
    assert [t["name"] for t in tools] == [s["name"] for s in TOOL_SCHEMAS]


def test_parameters_are_flattened_with_array_item_types():
    tools = {t["name"]: t for t in route.list_integrations()["agent"]["tools"]}

    assert tools["optimize_schedule"]["parameters"] == [
        {"name": "tower_ids", "type": "string[]", "required": True, "description": None}
    ]
    assert tools["score_towers"]["parameters"] == [
        {"name": "weights", "type": "object", "required": False,
         "description": "Optional factor->weight overrides"}
    ]


def test_fallback_reports_no_model():
    agent = route.list_integrations()["agent"]
    assert agent["mode"] == "fallback"
    assert agent["model"] is None  # null, not a model name the fallback never calls


def test_key_switches_mode_and_names_the_runner_model(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SENTINEL)
    agent = route.list_integrations()["agent"]

    assert agent["mode"] == "claude"
    assert agent["model"] == AGENT_MODEL


def test_key_value_never_appears_in_the_payload(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", SENTINEL)
    assert SENTINEL not in json.dumps(route.list_integrations())


def test_whitespace_only_key_is_not_live(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    assert route.list_integrations()["agent"]["mode"] == "fallback"
