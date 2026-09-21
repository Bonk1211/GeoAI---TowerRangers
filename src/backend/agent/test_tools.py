"""Agent-tool contract tests.

Run from src/backend:  python3 agent/test_tools.py   (or via pytest)

The whole file exists because of one bug: optimize_schedule_tool unpacked
OptimizeResult through its legacy 3-tuple __iter__ shim, so it kept compiling
after Task 1 added horizon/reserve/unscheduled_detail while silently throwing
those three away. The frontend lays the entire schedule board out from
run.horizon, so every agent-driven re-optimize returned a schedule the UI
could not render — and nothing failed to make that visible.
"""

import sys
from pathlib import Path

import pytest

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from agent.runner import _dispatch_tool
from agent.tools import optimize_schedule_tool, propose_actions_tool
from fixtures.scored_towers import generate_scored_towers
from scheduler.store import RunStore


@pytest.fixture(autouse=True)
def _use_fixture(monkeypatch):
    """Most tests below build their expected tower population directly from
    generate_scored_towers() (the deterministic mock fixture). agent/tools.py
    routes through fixtures.source.scored_towers(), which only returns that
    same mock population when USE_FIXTURE=1 — otherwise it resolves real
    ML-adapter towers and the ids these tests construct would not match.

    This used to be `os.environ["USE_FIXTURE"] = "1"` at module scope, i.e.
    executed at collection time and never undone, so it leaked into every
    other test module in the same pytest run and made results depend on file
    order. monkeypatch scopes it to one test and restores the previous value
    afterwards; the two tests that need the default branch override it with
    their own monkeypatch.delenv, which still works because that runs after
    this fixture.
    """
    monkeypatch.setenv("USE_FIXTURE", "1")


# Exactly the keys ScheduleRunOut declares in api/schemas.py, which is what
# GET /schedule/{run_id} returns and what the frontend's ScheduleRun type says
# the `schedule` SSE event carries.
SCHEDULE_RUN_KEYS = {
    "run_id",
    "horizon",
    "entries",
    "reserve",
    "unscheduled",
    "unscheduled_detail",
    "risk_weighted_wait",
}


def _run_the_tool(store: RunStore) -> dict:
    df = generate_scored_towers()
    towers = df[df["decision"] == "maintain"].to_dict(orient="records")
    work_orders = propose_actions_tool([t["tower_id"] for t in towers])
    towers_by_id = {t["tower_id"]: t for t in towers}
    return optimize_schedule_tool(work_orders, towers_by_id, store)


def test_optimize_schedule_tool_returns_every_schedule_run_field_not_the_three_tuple():
    """Regression guard for the OptimizeResult.__iter__ shim.

    The shim yields (entries, unscheduled, risk_weighted_wait) only. If this
    tool ever unpacks it again, horizon/reserve/unscheduled_detail vanish from
    the SSE `schedule` event and the board cannot lay itself out. Assert the
    full key set, not a subset, so a future drop is a failure and not a
    silently smaller payload.
    """
    result = _run_the_tool(RunStore())
    assert set(result.keys()) == SCHEDULE_RUN_KEYS, (
        f"missing: {sorted(SCHEDULE_RUN_KEYS - set(result.keys()))}"
    )


def test_optimize_schedule_tool_horizon_is_non_empty_for_a_normal_run():
    """The specific field the bug cost us. An empty horizon is not a
    renderable schedule, so 'the key exists' is not enough."""
    result = _run_the_tool(RunStore())
    assert result["horizon"], "a normal run must plan over a non-empty horizon"
    assert all(isinstance(d, str) for d in result["horizon"])
    assert result["entries"], "a normal run must book some work"


def test_stored_run_matches_what_the_tool_returned():
    """A later GET /schedule/{run_id} must see the same complete run — the
    store used to keep horizon=[] on the agent path, so re-fetching the run
    did not recover the dropped fields either."""
    store = RunStore()
    result = _run_the_tool(store)
    stored = store.get(result["run_id"])
    assert stored is not None
    assert stored.to_dict() == result


def test_runner_dispatch_of_optimize_schedule_carries_the_horizon():
    """End of the path the SSE `schedule` event is emitted from: runner.py
    yields _dispatch_tool's output verbatim as event data."""
    payload = _dispatch_tool("optimize_schedule", {})
    assert set(payload.keys()) == SCHEDULE_RUN_KEYS
    assert payload["horizon"]


def _tower_ids_in(run_dict: dict) -> set[str]:
    """Every tower a run either scheduled or explicitly left unscheduled —
    i.e. the full maintain-decision population that run was planned over."""
    return {e["tower_id"] for e in run_dict["entries"]} | set(run_dict["unscheduled"])


def _assert_route_and_tool_agree_on_tower_source() -> None:
    """Regression guard for the tower-source drift: api/routes/schedule.py
    used to honour USE_FIXTURE while agent/tools.py + agent/runner.py always
    generated the mock fixture regardless of it. A single agent turn through
    POST /agent/chat would then replan over a completely different tower
    population than the board was showing (mock MY_* ids vs. real
    SUNWAY_* ids) — invisible until the frontend stopped re-planning
    locally. Both paths now go through fixtures.source.scored_towers(), so
    under the same env they must plan over exactly the same tower ids."""
    from fastapi.testclient import TestClient

    from api.main import app
    from fixtures.source import scored_towers

    expected = {t["tower_id"] for t in scored_towers() if t["decision"] == "maintain"}
    assert expected, "fixture/adapter under test must yield at least one maintain-decision tower"

    client = TestClient(app)
    optimize_resp = client.post("/schedule/optimize", json={})
    assert optimize_resp.status_code == 200
    run_id = optimize_resp.json()["run_id"]
    route_run = client.get(f"/schedule/{run_id}").json()
    route_ids = _tower_ids_in(route_run)

    tool_run = _dispatch_tool("optimize_schedule", {})
    tool_ids = _tower_ids_in(tool_run)

    assert route_ids == expected, (
        f"schedule route planned over a different tower set than "
        f"fixtures.source.scored_towers(): "
        f"missing={expected - route_ids} extra={route_ids - expected}"
    )
    assert tool_ids == expected, (
        f"optimize_schedule_tool planned over a different tower set than "
        f"fixtures.source.scored_towers(): "
        f"missing={expected - tool_ids} extra={tool_ids - expected}"
    )
    assert route_ids == tool_ids, (
        "schedule route and optimize_schedule_tool disagreed on the tower "
        f"population: route only={route_ids - tool_ids} tool only={tool_ids - route_ids}"
    )

    # GET /towers is the population the MAP and every id-keyed frontend
    # lookup read. It called load_scored_towers() directly and so ignored
    # USE_FIXTURE entirely: under USE_FIXTURE=1 the board planned MY_*
    # towers while /towers served SUNWAY_*, and the work queue degraded to
    # "—" for Operator / Factor / Risk on every row because no id matched.
    towers_resp = client.get("/towers")
    assert towers_resp.status_code == 200
    towers_ids = {t["tower_id"] for t in towers_resp.json()}
    source_ids = {t["tower_id"] for t in scored_towers()}
    assert towers_ids == source_ids, (
        "GET /towers served a different tower population than "
        f"fixtures.source.scored_towers(): "
        f"missing={source_ids - towers_ids} extra={towers_ids - source_ids}"
    )
    assert route_ids <= towers_ids, (
        "the schedule board planned towers GET /towers does not serve: "
        f"{route_ids - towers_ids}"
    )


def test_schedule_route_and_optimize_schedule_tool_agree_on_tower_source_with_use_fixture(monkeypatch):
    """USE_FIXTURE=1 branch: every call site — the schedule route, the agent
    tool and GET /towers — must resolve to the deterministic synthetic
    fixture, and to the same set of tower ids as each other."""
    monkeypatch.setenv("USE_FIXTURE", "1")
    _assert_route_and_tool_agree_on_tower_source()


def test_schedule_route_and_optimize_schedule_tool_agree_on_tower_source_by_default(monkeypatch):
    """Default branch (no USE_FIXTURE): both call sites must resolve to the
    real ML adapter's towers, and to the same set of tower ids as each
    other. This is the exact split that shipped broken: the route served
    real Sunway towers by default while the agent tools always served the
    mock fixture."""
    monkeypatch.delenv("USE_FIXTURE", raising=False)
    _assert_route_and_tool_agree_on_tower_source()


def test_score_route_serves_the_same_tower_population_as_towers_route(monkeypatch):
    """POST /score feeds the same map /towers does, so a weight change must
    never swap the tower population underneath it. Under USE_FIXTURE=1 it
    used to: /score went straight to the real adapter while everything else
    resolved the synthetic fixture."""
    monkeypatch.setenv("USE_FIXTURE", "1")

    from fastapi.testclient import TestClient

    from api.main import app

    client = TestClient(app)
    towers_ids = {t["tower_id"] for t in client.get("/towers").json()}

    score_resp = client.post("/score", json={"weights": {"flood": 0.5, "power": 0.2}})
    assert score_resp.status_code == 200
    score_ids = {t["tower_id"] for t in score_resp.json()}

    assert score_ids == towers_ids, (
        "POST /score served a different tower population than GET /towers: "
        f"missing={towers_ids - score_ids} extra={score_ids - towers_ids}"
    )


def test_score_moves_under_use_fixture_without_changing_the_population(monkeypatch):
    """The inverse of the test this replaces, and it exists for the same
    reason: the semantic half of /score's fixture branch is not covered by
    the population test above.

    The fixture used to carry finished scores and no feature table, so
    score_with_weights had nothing to recompute against and two different
    weight payloads returned byte-identical results — the Weights sliders
    moved and nothing happened. It now builds a synthetic feature table and
    derives risk through model/risk_index.py, so the sliders are
    authoritative here exactly as they are on the real-adapter branch.

    Both halves are pinned together on purpose. Making /score move again by
    falling through to the real adapter would satisfy the first assertion
    while silently re-breaking population agreement with /towers, which is
    the bug that put the special case here in the first place.
    """
    monkeypatch.setenv("USE_FIXTURE", "1")

    from fastapi.testclient import TestClient

    from api.main import app

    client = TestClient(app)
    towers_ids = {t["tower_id"] for t in client.get("/towers").json()}

    flood_heavy = client.post("/score", json={"weights": {"flood": 0.9, "power": 0.05}})
    power_heavy = client.post("/score", json={"weights": {"flood": 0.05, "power": 0.9}})
    assert flood_heavy.status_code == 200 and power_heavy.status_code == 200

    flood_rows = {t["tower_id"]: t for t in flood_heavy.json()}
    power_rows = {t["tower_id"]: t for t in power_heavy.json()}

    assert set(flood_rows) == towers_ids and set(power_rows) == towers_ids, (
        "POST /score served a different tower population than GET /towers under "
        "USE_FIXTURE=1 — the weight overrides must re-score the fixture, not "
        "fall through to the real adapter."
    )

    assert flood_heavy.json() != power_heavy.json(), (
        "POST /score is still weight-inert under USE_FIXTURE=1: two materially "
        "different weight payloads returned identical results."
    )

    # Not just *some* field differing: the flood-weighted run must actually
    # attribute more to flood, which is what the sliders claim to control.
    # Monotone everywhere — the shares come out of one noisy-OR decomposition,
    # so raising flood's weight cannot lower flood's share on any tower. The
    # towers that come out exactly equal are the ones far enough from water
    # that their flood share rounds to zero under both payloads.
    deltas = [
        flood_rows[tid]["attribution"]["flood"] - power_rows[tid]["attribution"]["flood"]
        for tid in towers_ids
    ]
    assert min(deltas) >= 0, "raising the flood weight lowered flood's attribution share"
    assert sum(1 for d in deltas if d > 0) > 0.75 * len(towers_ids), (
        "raising the flood weight moved flood's attribution share on too few "
        f"towers ({sum(1 for d in deltas if d > 0)}/{len(towers_ids)})"
    )

    # And it must reach the decision the planner acts on, not just the shares.
    assert any(flood_rows[tid]["decision"] != power_rows[tid]["decision"] for tid in towers_ids), (
        "no tower changed decision band between the two weight payloads"
    )

    # Determinism: the same payload twice must be byte-identical, because
    # every scheduler test downstream assumes a stable fixture.
    assert client.post("/score", json={"weights": {"flood": 0.9, "power": 0.05}}).json() == (
        flood_heavy.json()
    ), "the fixture stopped being deterministic under a repeated /score request"


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
