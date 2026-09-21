"""Single source-selection switch for scored towers (Backend_Handoff §1).

Four call sites used to each re-implement the USE_FIXTURE branch
independently (api/routes/schedule.py, api/routes/baseline.py,
agent/tools.py x2, agent/runner.py) and they drifted: the HTTP route
honoured USE_FIXTURE and served real Sunway towers by default, while every
agent-tool path ignored it and always generated the mock fixture. A single
agent turn through POST /agent/chat would then replan over a completely
different tower population than the one the board was showing, and the
mismatch was invisible until the frontend stopped re-planning locally.

`scored_towers()` is the one place that decision is made now. Every caller
gets a `list[dict]` in the same shape regardless of source.
"""
from __future__ import annotations

import os

from adapter.ml_source import load_scored_towers, load_tower_points, score_with_weights
from fixtures.scored_towers import (
    generate_scored_towers,
    score_fixture_with_weights,
    synthetic_feature_table,
)


def use_fixture() -> bool:
    """The switch itself. Read the env here, never re-test the variable
    elsewhere — every branch on tower source belongs in this module."""
    return os.environ.get("USE_FIXTURE") == "1"


def scored_towers() -> list[dict]:
    """USE_FIXTURE=1 selects the deterministic synthetic fixture (scheduler
    tests, offline demo path). Otherwise (the default) real towers come
    from the ML adapter."""
    if use_fixture():
        return generate_scored_towers().to_dict(orient="records")
    return load_scored_towers()


def scored_towers_with_weights(
    weight_overrides: dict[str, float],
    bbox: tuple[float, float, float, float] | None = None,
) -> list[dict]:
    """POST /score's source selection — the same switch as scored_towers(),
    for the re-scored variant.

    Both branches now recompute risk and attribution from a feature table
    through model/risk_index.py, so the Weights sliders are authoritative on
    either. The fixture used to be the exception: it carried finished scores
    and no features, so /score had to serve its stored records unchanged and
    the sliders moved nothing. fixtures/scored_towers.py now builds a
    synthetic feature table and derives risk from it, which is what closes
    that gap — and it is why /towers and /score still describe the same
    tower population here: they describe the same feature table.
    """
    if use_fixture():
        return score_fixture_with_weights(weight_overrides, bbox)
    return score_with_weights(weight_overrides, bbox)


def tower_points() -> list[dict]:
    """[{tower_id, lon, lat}] for the active population, and nothing else.

    The same USE_FIXTURE switch as scored_towers(), deliberately routed through
    this module rather than read again elsewhere — that duplication is the bug
    this file's docstring records. What differs is the cost: a caller that only
    needs to know WHERE the towers are should not pay to find out how risky they
    are, and on the real branch scored_towers() builds the whole ML cache.

    Both branches stop before scoring. The fixture branch reads its synthetic
    feature table directly rather than calling generate_scored_towers(), which
    re-runs memberships() and attribution() over 500 rows on every call.
    """
    if use_fixture():
        feat = synthetic_feature_table()
        return feat[["tower_id", "lon", "lat"]].to_dict(orient="records")
    return load_tower_points()
