"""Shared YAML/JSON config loaders — crews, policy, profiler rules
(Backend_Handoff §0.4: config over code)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

CONFIG_DIR = Path(__file__).resolve().parent.parent / "config"


def load_crews(path: Path | None = None) -> list[dict]:
    path = path or CONFIG_DIR / "crews.json"
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    return data["crews"]


def load_policy(path: Path | None = None) -> dict[str, Any]:
    path = path or CONFIG_DIR / "policy.yaml"
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_profiler(path: Path | None = None) -> dict[str, Any]:
    """config/profiler.yaml — the BehavioralProfiler's rule thresholds.

    Read by model/profiler.py, which is the one place a model/ module imports
    from scheduler/. That direction is unusual here (adapter and scheduler
    import model, not the reverse) and it is a deliberate choice rather than an
    accident: adapter/ml_source.py already imports this module, and the
    alternative is a fourth copy of a six-line YAML reader.
    """
    path = path or CONFIG_DIR / "profiler.yaml"
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)
