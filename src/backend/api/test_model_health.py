"""Unit tests for GET /model/health.

The route exists because the training report was read by nothing and every
figure the UI showed about the model was hand-copied into MethodPage.tsx, where
it drifted. The guards here are about the ways serving it could go wrong:

  * a missing or corrupt artifact taking the route down, when a checkout with no
    trained model must still answer;
  * `report` arriving as a zeroed struct instead of null, which every
    `data ? ... : '—'` guard downstream reads as a measurement;
  * the serving block silently describing something other than what is served.

Network-free. Run from src/backend:  python3 api/test_model_health.py
"""

import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from api.routes import model as route
from model.ensemble import CONDITION_BLEND_WEIGHT


def test_report_is_none_when_the_artifact_is_absent(monkeypatch=None):
    """A checkout with no trained model must still answer. None, never {} —
    an empty dict is truthy and every guard downstream takes the wrong branch."""
    original = route.maintenance_need.REPORT_PATH
    try:
        route.maintenance_need.REPORT_PATH = Path("/nonexistent/report.json")
        assert route._report() is None
    finally:
        route.maintenance_need.REPORT_PATH = original


def test_report_is_none_when_the_artifact_is_corrupt(tmp_path=None):
    """A half-written JSON file is a configuration state, not a 500."""
    import tempfile

    original = route.maintenance_need.REPORT_PATH
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            fh.write("{ this is not json")
            bad = Path(fh.name)
        route.maintenance_need.REPORT_PATH = bad
        assert route._report() is None
    finally:
        route.maintenance_need.REPORT_PATH = original
        bad.unlink(missing_ok=True)


def test_serving_block_describes_the_records_actually_served():
    """The band counts must sum to the tower count, or the block is describing
    something other than what /towers returns."""
    serving = route._serving()
    assert serving["source"] in {"model", "index"}
    assert sum(serving["bands"].values()) == serving["towers"]
    assert serving["blend_weight"] == CONDITION_BLEND_WEIGHT
    for key in ("escalated", "novelty_unavailable", "condition_unavailable", "flagged"):
        assert 0 <= serving[key] <= serving["towers"], key


def test_unavailable_counts_are_counts_not_percentages():
    """'20 towers could not be measured' is the fact worth surfacing; a coverage
    percentage hides how many."""
    serving = route._serving()
    assert isinstance(serving["novelty_unavailable"], int)
    assert isinstance(serving["condition_unavailable"], int)


def test_health_payload_is_json_serialisable():
    """FastAPI would fail at serialisation time, which is a 500 on a page whose
    whole job is telling you whether things are healthy."""
    payload = route.model_health()
    assert set(payload) == {"report", "serving", "ledger"}
    json.dumps(payload, allow_nan=False)


def test_ledger_is_independent_of_training_report():
    from tempfile import TemporaryDirectory
    from unittest.mock import patch
    from api.schemas import LedgerSummary
    from model import feedback

    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"), patch.object(route.maintenance_need, "REPORT_PATH", Path(directory) / "missing.json"):
        assert route.model_health()["ledger"] is None
        feedback.append([feedback.Observation("2026-09-01T00:00:00+00:00", "A", "s2_change",
                                             {"evi_delta_per_year": 0.1}, .9, "maintain", "agree")])
        payload = route.model_health()
        assert payload["report"] is None
        assert payload["ledger"]["records"] == 1
        assert LedgerSummary(**payload["ledger"]).records == 1


def test_report_declares_itself_synthetic_when_present():
    """The page renders provenance above every figure; the field it reads must
    exist and be true while the labels are simulated."""
    report = route._report()
    if report is None:
        return
    assert report.get("synthetic_labels") is True
    assert report.get("caveat", "").strip()
    assert report.get("not_a_failure_label", "").strip()


if __name__ == "__main__":
    import traceback

    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"  ok  {test.__name__}")
        except Exception:
            failed += 1
            print(f"FAIL  {test.__name__}")
            traceback.print_exc()
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(1 if failed else 0)


def test_feedback_observations_returns_whole_rows_and_filters_by_label_status():
    """The frontend copies a row to build a confirmation, so a projection is
    not enough — _confirmed() keys on (tower_id, source, observed_at) and a
    record missing any of them appends an orphan instead of confirming."""
    from tempfile import TemporaryDirectory
    from unittest.mock import patch
    from model import feedback

    with TemporaryDirectory() as directory, patch.object(
        feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"
    ):
        # No ledger file at all is absence, not an error.
        assert route.feedback_observations() == []

        feedback.append([
            feedback.Observation(
                "2026-09-01T00:00:00+00:00", "MY_1010", "s2_change",
                {"evi_delta_per_year": 0.1}, 0.9, "maintain", "agree",
            )
        ])

        rows = route.feedback_observations()
        assert len(rows) == 1
        row = rows[0]
        # Every field Observation carries must survive the trip.
        assert set(row) == {
            "observed_at", "tower_id", "source", "observation",
            "predicted_priority", "predicted_decision", "agreement",
            "label_status", "simulated",
        }
        assert row["tower_id"] == "MY_1010"
        assert row["source"] == "s2_change"
        assert row["label_status"] == "unlabeled"
        assert row["observation"] == {"evi_delta_per_year": 0.1}

        assert route.feedback_observations(label_status="unlabeled") == rows
        assert route.feedback_observations(label_status="confirmed") == []


def test_feedback_contested_ranks_towers_and_is_registered_on_the_app():
    """The adjudication queue the Close Loop page works from.

    Separate from /observations because a contested tower carries ~16 rows and
    the raw endpoint would ship 430 KB to render 53 entries. The route must
    also actually be mounted: a handler that exists but is never included is
    invisible to every test that calls it directly, which is all of these.
    """
    from tempfile import TemporaryDirectory
    from unittest.mock import patch
    from model import feedback

    from api.main import app
    assert "/model/feedback/contested" in set(app.openapi()["paths"])

    with TemporaryDirectory() as directory, patch.object(
        feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"
    ):
        assert route.feedback_contested() == []

        def obs(tower_id, agreement, rank, observed_at="2026-09-01T00:00:00+00:00"):
            return feedback.Observation(
                observed_at, tower_id, "s2_change",
                {"change_rank": rank, "evi_delta_per_year": 0.1},
                0.4, "ok", agreement,
            )

        feedback.append([
            obs("MY_A", "disagree", 0.5),
            obs("MY_A", "disagree", 0.9, "2026-09-02T00:00:00+00:00"),
            obs("MY_B", "disagree", 0.7),
            obs("MY_C", "agree", 0.99),
        ])

        queue = route.feedback_contested()
        assert [r["tower_id"] for r in queue] == ["MY_A", "MY_B"], "one ranked row per tower"
        assert queue[0]["observation"]["change_rank"] == 0.9
        # Whole rows, matching the /observations contract.
        assert set(queue[0]) == {
            "observed_at", "tower_id", "source", "observation",
            "predicted_priority", "predicted_decision", "agreement",
            "label_status", "simulated",
        }
        # The queue is about disagreement, but the parameter is not hardcoded.
        assert [r["tower_id"] for r in route.feedback_contested(agreement="agree")] == ["MY_C"]
