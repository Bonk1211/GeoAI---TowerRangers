"""Network-free ledger checks; never touch a developer's observations.

Run from src/backend: python3 model/test_feedback.py (or pytest).
"""
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

_BACKEND = Path(__file__).resolve().parent.parent
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import pandas as pd
from model import feedback
from model.profiler import BehavioralProfiler


def observation(**kwargs):
    return feedback.Observation(**{
        "observed_at": "2026-09-01T00:00:00+00:00", "tower_id": "A", "source": "s2_change",
        "observation": {"evi_delta_per_year": .1}, "predicted_priority": .95,
        "predicted_decision": "maintain", "agreement": "agree", **kwargs,
    })


def test_ledger_append_and_summarise_and_missing():
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        assert feedback.summarise() is None
        assert feedback.promote_to_training().empty
        assert feedback.append([]) == 0 and not feedback.LEDGER_PATH.exists()
        assert feedback.append([observation()]) == 1
        original = feedback.LEDGER_PATH.read_bytes()
        assert feedback.append([observation(tower_id="B", agreement="disagree"), observation(tower_id="C", agreement="indeterminate")]) == 2
        assert feedback.LEDGER_PATH.read_bytes().startswith(original)
        summary = feedback.summarise()
        assert summary["records"] == 3
        assert summary["agree"] == summary["disagree"] == summary["indeterminate"] == 1
        assert summary["sources"] == {"s2_change": 3}
        assert summary["eligible_for_training"] == 0
        assert summary["first_observed"] == summary["last_observed"] == observation().observed_at


def test_ledger_label_status_always_unlabeled_and_confirmation_gate():
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        confirmed = observation(label_status="confirmed", observation={"evi_delta_per_year": .1, "needed_corrective_maintenance": 1})
        feedback.append([confirmed])
        assert json.loads(feedback.LEDGER_PATH.read_text())["label_status"] == "unlabeled"
        assert feedback.promote_to_training().empty
        # An external work-order confirmation is append-only; repeated records
        # cannot duplicate a training candidate for the same observed window.
        feedback._write([confirmed, confirmed])
        candidate = feedback.promote_to_training()
        assert len(candidate) == 1 and candidate.label_status.iloc[0] == "confirmed"
        assert candidate.needed_corrective_maintenance.iloc[0] == 1
        assert feedback.summarise()["eligible_for_training"] == 1


def test_ledger_simulated_counted_separately_and_manifest_marked():
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        root = Path(directory)
        feedback.append([observation(), observation(tower_id="B", agreement="disagree")])
        pd.DataFrame({"tower_id": ["A", "B"], "needed_corrective_maintenance": [1, 0]}).to_csv(root / "labels.csv", index=False)
        (root / "maintenance_manifest.json").write_text('{"synthetic": true}')
        assert feedback.simulate_confirmation(root / "labels.csv") == 2
        assert feedback.simulate_confirmation(root / "labels.csv") == 0
        summary = feedback.summarise()
        assert summary["records"] == 4 and summary["simulated_records"] == 2
        assert summary["eligible_for_training"] == 2
        assert feedback.promote_to_training().simulated.all()
        assert json.loads(feedback.LEDGER_PATH.with_suffix(".manifest.json").read_text())["simulated"] is True


def test_ledger_malformed_lines_skipped_and_counted():
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        feedback.append([observation()])
        with feedback.LEDGER_PATH.open("ab") as handle:
            handle.write(b'{"broken":\nnull\n{}\n\xff')
        feedback.append([observation(tower_id="B")])
        summary = feedback.summarise()
        assert summary["malformed"] == 4 and summary["records"] == 2
        assert feedback.promote_to_training().empty
        with patch.object(feedback, "LEDGER_PATH", Path(directory)):
            assert feedback.summarise() is None


def test_observations_capture_raw_windows_and_served_comparison():
    profiler = BehavioralProfiler()
    frame = pd.DataFrame({"tower_id": ["A", "B", "C"], "evi_delta_per_year": [.1, -.1, .2],
                          "evi_median_recent": [.6, .2, .6], "evi_median_baseline": [.4, .4, .2],
                          "window_recent": ["2025-09-01/2026-09-01"] * 3,
                          "window_baseline": ["2023-09-02/2024-09-01"] * 3})
    records = [
        {"tower_id": "A", "priority": .95, "decision": "maintain", "change": .9, "condition": .7},
        {"tower_id": "B", "priority": .95, "decision": "maintain", "change": .2, "condition": .1},
        {"tower_id": "C", "priority": .2, "decision": "ok", "change": .95, "condition": None},
        {"tower_id": "missing", "priority": .2, "decision": "ok", "change": None, "condition": .1},
    ]
    batch = feedback.observations_for(records, frame, profiler.rules)
    assert [o.agreement for o in batch] == ["agree", "disagree", "disagree"]
    assert batch[0].observation["evi_delta_per_year"] == .1
    assert all(o.label_status == "unlabeled" and not o.simulated for o in batch)
    assert all(o.observed_at == "2026-09-01T00:00:00+00:00" for o in batch)
    assert feedback.observations_for(records, None, profiler.rules) == []
    records[1]["condition"] = None
    assert feedback.observations_for(records, frame, profiler.rules)[1].agreement == "indeterminate"


def test_invalid_observation_cannot_be_appended():
    for bad in ({"predicted_priority": float("nan")}, {"observation": {"delta": float("nan")}},
                {"observed_at": "2026-09-01"}, {"simulated": "false"}):
        try:
            observation(**bad)
            raise AssertionError("invalid observation was accepted")
        except ValueError:
            pass


def test_concurrent_first_requests_capture_once():
    from concurrent.futures import ThreadPoolExecutor
    from time import sleep
    from adapter import ml_source

    cache = object()
    def build():
        sleep(.02)
        return cache
    with patch.object(ml_source, "_cache", None), patch.object(ml_source, "_AdapterCache", side_effect=build) as constructor:
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: ml_source._get_cache(), range(4)))
        assert all(result is cache for result in results)
        assert constructor.call_count == 1


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
            traceback.print_exc()
    print(f"{len(tests) - failed}/{len(tests)} passed")
    raise SystemExit(bool(failed))


def test_contested_returns_one_ranked_row_per_tower():
    """The adjudication queue: towers the satellite contradicts, worst first.

    A tower carries one observation per sampled window, so the raw disagree
    rows run ~16 deep per tower. The queue is a list of TOWERS to go look at,
    not a list of rows, so this collapses to the strongest evidence per tower
    — otherwise the caller ships 430 KB to render 53 entries.
    """
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        feedback.append([
            # Two windows on tower A. The 0.9 row is the one worth showing.
            observation(tower_id="A", agreement="disagree", observation={"change_rank": .5}),
            observation(tower_id="A", agreement="disagree", observation={"change_rank": .9},
                        observed_at="2026-09-02T00:00:00+00:00"),
            observation(tower_id="B", agreement="disagree", observation={"change_rank": .7}),
            # Not contested: must not appear at all.
            observation(tower_id="C", agreement="agree", observation={"change_rank": .99}),
            observation(tower_id="D", agreement="indeterminate", observation={"change_rank": .99}),
        ])

        queue = feedback.contested()

        assert [row["tower_id"] for row in queue] == ["A", "B"], "ranked by change_rank, one row per tower"
        assert queue[0]["observation"]["change_rank"] == .9, "keeps the strongest window, not the first seen"
        # Whole rows, like observations() — the caller may still need to copy one.
        assert set(queue[0]) >= {"observed_at", "tower_id", "source", "observation",
                                 "predicted_priority", "predicted_decision", "agreement",
                                 "label_status", "simulated"}


def test_contested_ignores_rows_already_labelled_and_survives_absence():
    """A confirmed row is spent: it has already been adjudicated."""
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        # Absence reads as empty, matching summarise()'s contract.
        assert feedback.contested() == []

        feedback.append([observation(tower_id="A", agreement="disagree", observation={"change_rank": .9})])
        assert len(feedback.contested()) == 1

        # _write bypasses append()'s unlabeled reset, which is how a real
        # confirmation lands. The tower drops out of the queue once judged.
        feedback._write([feedback.Observation(**{
            **feedback.observations(tower_ids={"A"})[0],
            "label_status": "confirmed",
            "observation": {"change_rank": .9, "needed_corrective_maintenance": 1},
        })])
        assert [r["tower_id"] for r in feedback.contested()] == [], "an adjudicated tower leaves the queue"


def test_contested_tolerates_rows_without_a_change_rank():
    """change_rank comes from the raw observation dict and is not validated by
    Observation, so a source that omits it must not crash the queue."""
    with TemporaryDirectory() as directory, patch.object(feedback, "LEDGER_PATH", Path(directory) / "log.jsonl"):
        feedback.append([
            observation(tower_id="A", agreement="disagree", observation={"evi_delta_per_year": .1}),
            observation(tower_id="B", agreement="disagree", observation={"change_rank": .4}),
        ])
        queue = feedback.contested()
        assert [row["tower_id"] for row in queue] == ["B", "A"], "rankless rows sort last, but still appear"
