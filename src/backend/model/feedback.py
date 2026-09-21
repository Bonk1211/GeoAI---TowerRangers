"""Append-only satellite observations. Evidence is never an automatic label.

Demo confirmation only: python3 -m model.feedback --simulate
The command appends simulated confirmations and writes a simulation manifest.
Retraining remains a manual notebook run.
"""
from __future__ import annotations

import argparse
import json
import math
from collections import Counter
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from model import maintenance_need
from model.maintenance_need import DATA_DIR

LEDGER_PATH = DATA_DIR / "observation_log.jsonl"
LEDGER_VERSION = 1


@dataclass(frozen=True)
class Observation:
    observed_at: str
    tower_id: str
    source: str
    observation: dict
    predicted_priority: float
    predicted_decision: str
    agreement: str
    label_status: str = "unlabeled"
    simulated: bool = False

    def __post_init__(self):
        when = datetime.fromisoformat(self.observed_at.replace("Z", "+00:00"))
        if when.utcoffset() is None or when.utcoffset().total_seconds() != 0:
            raise ValueError("observed_at must be UTC")
        object.__setattr__(self, "observed_at", when.isoformat())
        if not isinstance(self.tower_id, str) or not self.tower_id.strip():
            raise ValueError("tower_id is required")
        if self.source not in {"viirs_fire", "s1_flood_extent", "s2_change"}:
            raise ValueError("unknown observation source")
        if not isinstance(self.observation, dict) or not self.observation:
            raise ValueError("a raw observation is required")
        if not math.isfinite(self.predicted_priority) or not 0 <= self.predicted_priority <= 1:
            raise ValueError("priority must be a finite rank in [0, 1]")
        if self.predicted_decision not in {"maintain", "watch", "ok"}:
            raise ValueError("unknown decision")
        if self.agreement not in {"agree", "disagree", "indeterminate"}:
            raise ValueError("unknown agreement")
        if self.label_status not in {"unlabeled", "confirmed"} or type(self.simulated) is not bool:
            raise ValueError("invalid label provenance")
        json.dumps(self.observation, allow_nan=False)


def _write(observations: list[Observation]) -> int:
    if not observations:
        return 0
    # Validate the whole batch before writing, so invalid JSON cannot leave a
    # partially recorded batch. Normal writes remain O(1) per observation.
    lines = [(json.dumps(asdict(obs), allow_nan=False) + "\n").encode("utf-8") for obs in observations]
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    # ponytail: one serving process writes this local ledger; use file locking
    # or a database if multiple worker processes need to write concurrently.
    with LEDGER_PATH.open("a+b") as handle:
        if handle.tell():
            handle.seek(-1, 2)
            if handle.read(1) != b"\n":
                handle.write(b"\n")  # preserve a torn final line, then start a new record
        handle.writelines(lines)
    return len(lines)


def append(observations: list[Observation]) -> int:
    """Serving-path writes always start unlabeled, regardless of caller input."""
    return _write([replace(obs, label_status="unlabeled") for obs in observations])


def _read() -> tuple[list[dict], int] | None:
    rows, malformed = [], 0
    try:
        with LEDGER_PATH.open("rb") as handle:
            for line in handle:
                try:
                    rows.append(asdict(Observation(**json.loads(line))))
                except (ValueError, TypeError, AttributeError, OverflowError):
                    malformed += 1
        return rows, malformed
    except Exception:  # noqa: BLE001 — an unreadable artifact is unavailable, not empty
        return None


def observations(
    label_status: str | None = None,
    tower_ids: set[str] | None = None,
) -> list[dict]:
    """Ledger rows, WHOLE, for callers that need to copy one.

    A confirmation is built by copying an observation and changing two fields
    (see the --simulate path below), and _confirmed() keys candidates on
    (tower_id, source, observed_at). A projection cannot be copied, and
    rebuilding one would overwrite measured predicted_priority/agreement
    values with whatever the model says today.  So this returns every field.

    `tower_ids` is not an optimisation detail — the estate carries 12,804
    unlabeled observations and serving them all is a 6 MB response. A caller
    that wants the rows for a handful of closed tickets asks for those towers.

    Read-only. Missing or unreadable ledger reads as empty, matching
    summarise()'s contract that absence is not an error.
    """
    data = _read()
    if data is None:
        return []
    rows, _malformed = data
    if label_status is not None:
        rows = [row for row in rows if row["label_status"] == label_status]
    if tower_ids is not None:
        rows = [row for row in rows if row["tower_id"] in tower_ids]
    return rows


def contested(agreement: str = "disagree") -> list[dict]:
    """The adjudication queue: towers the satellite contradicts, worst first.

    observations() serves raw ledger rows and a tower carries one per sampled
    window, so the disagree rows run ~16 deep per tower — 848 rows across 53
    towers, 430 KB to render a 53-entry list. This is the same data asked as
    the question a human actually has: WHICH TOWERS should I go look at.

    So it collapses to one row per tower, keeping that tower's strongest
    evidence, and ranks by it. Rows already labelled are dropped: a confirmed
    observation has been adjudicated and is no longer waiting on anyone.

    Whole rows, like observations() — the caller may still need to copy one,
    and rebuilding a projection would overwrite measured values.

    Read-only. This never writes, and it never labels: it only says where a
    label is missing. Missing or unreadable ledger reads as empty.
    """
    data = _read()
    if data is None:
        return []
    rows, _malformed = data
    # A confirmation is an ADDITIONAL row, never an edit, so the unlabeled
    # original outlives it. Testing label_status alone would leave an
    # adjudicated tower in the queue forever. Key on the same triple
    # _confirmed() uses, so "spent" means the same thing in both places.
    spent = {(row["tower_id"], row["source"], row["observed_at"]) for row in _confirmed(rows)}
    strongest: dict[str, dict] = {}
    for row in rows:
        if row["agreement"] != agreement or row["label_status"] != "unlabeled":
            continue
        if (row["tower_id"], row["source"], row["observed_at"]) in spent:
            continue
        current = strongest.get(row["tower_id"])
        if current is None or _change_rank(row) > _change_rank(current):
            strongest[row["tower_id"]] = row
    return sorted(strongest.values(), key=_change_rank, reverse=True)


def _change_rank(row: dict) -> float:
    """How strongly the imagery contradicts the served decision.

    change_rank rides in the raw observation dict, which Observation validates
    as JSON-serialisable but not for any particular key. A source that omits
    it sorts last rather than raising — it is still a real disagreement and
    still belongs in the queue.
    """
    value = row["observation"].get("change_rank")
    return value if isinstance(value, (int, float)) and math.isfinite(value) else -1.0


def _confirmed(rows: list[dict]) -> list[dict]:
    # Confirmations are additional records, never edits. A source/window/site
    # yields at most one candidate even after repeated process starts.
    candidates = {}
    for row in rows:
        label = row["observation"].get("needed_corrective_maintenance")
        if row["label_status"] == "confirmed" and type(label) in (int, bool) and label in (0, 1):
            key = (row["tower_id"], row["source"], row["observed_at"])
            candidates[key] = {**row, "needed_corrective_maintenance": int(label)}
    return list(candidates.values())


def _last_retrain() -> str | None:
    try:
        value = json.loads(maintenance_need.REPORT_PATH.read_text()).get("trained_at")
        return datetime.fromisoformat(value.replace("Z", "+00:00")).isoformat()
    except Exception:  # noqa: BLE001 — missing/corrupt training metadata means unknown
        return None


def summarise() -> dict | None:
    """Real record counts; None for absence, malformed lines skipped and counted."""
    data = _read()
    if data is None:
        return None
    rows, malformed = data
    dates = sorted(row["observed_at"] for row in rows)
    agreement = Counter(row["agreement"] for row in rows)
    return {
        "version": LEDGER_VERSION, "records": len(rows), "malformed": malformed,
        "first_observed": dates[0] if dates else None,
        "last_observed": dates[-1] if dates else None,
        "agree": agreement["agree"], "disagree": agreement["disagree"],
        "indeterminate": agreement["indeterminate"],
        "eligible_for_training": len(_confirmed(rows)),
        "simulated_records": sum(row["simulated"] for row in rows),
        "last_retrain": _last_retrain(),
        "sources": dict(Counter(row["source"] for row in rows)),
    }


def promote_to_training() -> pd.DataFrame:
    """Confirmed outcomes only. Empty when none; this never retrains anything."""
    data = _read()
    return pd.DataFrame(_confirmed(data[0]) if data else [])


def observations_for(records: list[dict], change: pd.DataFrame | None, rules: dict) -> list[Observation]:
    """Compare served priorities with the actual sampled EVI windows.

    Agree/disagree are descriptive threshold comparisons, not model accuracy.
    The observation timestamp is the recent window's end, not process startup.
    """
    required = {"tower_id", "evi_delta_per_year", "evi_median_recent", "evi_median_baseline",
                "window_recent", "window_baseline"}
    if change is None or not required.issubset(change.columns):
        return []
    by_id = change.set_index("tower_id")
    quiet, active = rules["model_high_ground_quiet"], rules["model_low_ground_active"]
    out = []
    for record in records:
        score = record.get("change")
        if score is None or record["tower_id"] not in by_id.index:
            continue
        row = by_id.loc[record["tower_id"]]
        if row[list(required - {"tower_id"})].isna().any():
            continue
        growing = score >= active["min_change"]
        is_quiet = (record.get("condition") is not None
                    and score <= quiet["max_change"]
                    and record["condition"] <= quiet["max_condition"])
        high = record["decision"] == "maintain"
        low = record["priority"] < active["max_priority"]
        agreement = ("disagree" if (high and is_quiet) or (low and growing) else
                     "agree" if (high and growing) or (low and is_quiet) else "indeterminate")
        try:
            start, end = str(row["window_recent"]).split("/")
            datetime.fromisoformat(start)
            observed = datetime.fromisoformat(end).replace(tzinfo=timezone.utc).isoformat()
            raw = {key: float(row[key]) for key in
                   ("evi_delta_per_year", "evi_median_recent", "evi_median_baseline")}
            raw.update({"window_recent": str(row.window_recent),
                        "window_baseline": str(row.window_baseline), "change_rank": score})
            out.append(Observation(observed, record["tower_id"], "s2_change", raw,
                                   record["priority"], record["decision"], agreement))
        except (ValueError, TypeError):
            continue  # malformed source metadata is not a measured observation
    return out


def simulate_confirmation(labels_path: Path) -> int:
    """Demo-only append of explicitly simulated outcomes; never a serving call."""
    manifest = json.loads(labels_path.with_name("maintenance_manifest.json").read_text())
    if manifest.get("synthetic") is not True:
        raise ValueError("--simulate requires labels declared synthetic in maintenance_manifest.json")
    labels = pd.read_csv(labels_path).set_index("tower_id")["needed_corrective_maintenance"]
    data = _read()
    rows = data[0] if data else []
    confirmed = {(r["tower_id"], r["source"], r["observed_at"]) for r in _confirmed(rows)}
    updates = []
    for row in rows:
        key = (row["tower_id"], row["source"], row["observed_at"])
        if key in confirmed or row["tower_id"] not in labels.index:
            continue
        label = labels.loc[row["tower_id"]]
        if label not in (0, 1):
            raise ValueError("synthetic outcomes must be binary")
        updates.append(Observation(**{**row, "label_status": "confirmed", "simulated": True,
                      "observation": {**row["observation"], "needed_corrective_maintenance": int(label)}}))
        confirmed.add(key)
    count = _write(updates)
    LEDGER_PATH.parent.mkdir(parents=True, exist_ok=True)
    LEDGER_PATH.with_suffix(".manifest.json").write_text(json.dumps({
        "version": LEDGER_VERSION, "simulated": True, "appended_confirmations": count,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "note": "Demo confirmations from synthetic labels; no real work order confirmed these observations.",
    }, indent=2) + "\n")
    return count


def main() -> None:
    global LEDGER_PATH
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--simulate", action="store_true")
    parser.add_argument("--ledger", type=Path, default=LEDGER_PATH)
    parser.add_argument("--labels", type=Path, default=DATA_DIR / "maintenance_labels.csv")
    args = parser.parse_args()
    LEDGER_PATH = args.ledger
    if args.simulate:
        simulate_confirmation(args.labels)
    print(json.dumps(summarise(), indent=2))


if __name__ == "__main__":
    main()
