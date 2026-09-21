"""GET /model/health — what the served scorer measured, and what it is doing now.

Two things this route exists to fix.

The training report (`data/malaysia/maintenance_need_report.json`) was written
by the notebook and read by nothing. Every figure the UI showed about the model
was HAND-COPIED into `MethodPage.tsx` — `roc: '0.910', tp: 97, fp: 20` and so on
— and had already drifted from the artifact by the time this route was written.
A number that has to be re-typed after every retrain will be wrong after some
retrain; serving the file is the only version of this that stays true.

And the report alone is not health. It says what the model measured at training
time; it says nothing about what the process is serving right now — whether a
trained artifact was found at all, how many towers each band holds, how many
carry no telemetry. Both halves are returned together.

`ledger` adds counts of actual satellite comparisons. Its reader skips and
counts malformed lines, and returns null when no ledger is available. Serving
initialises the cache first so the first health response includes its batch.

`report` is null on a checkout with no trained model, exactly as `/stability` is
null under the supervised model: absence stays visibly absent rather than
arriving as a zeroed struct that every `data ? ... : '—'` guard reads as a
measurement (see CLAUDE.md on the useStabilityQuery bug).
"""
from __future__ import annotations

import json

from fastapi import APIRouter

from adapter.ml_source import get_stability, load_scored_towers
from api.schemas import LedgerObservationOut
from model import feedback, maintenance_need
from model.ensemble import CHANGE_BLEND_WEIGHT, CONDITION_BLEND_WEIGHT

router = APIRouter(tags=["model"])


def _report() -> dict | None:
    """The training report, or None. Never raises: a corrupt or missing artifact
    is a configuration state, the same contract load_booster() keeps."""
    path = maintenance_need.REPORT_PATH
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001 — a bad artifact must not take the route down
        return None


def _serving() -> dict:
    """What this process is actually serving, derived from the cached records.

    Distinct from the report on purpose. The report describes a training run;
    this describes the rows in memory, and the two can legitimately disagree —
    a checkout with no trained model serves the physical index against a report
    that describes the model.
    """
    towers = load_scored_towers()
    bands: dict[str, int] = {}
    for record in towers:
        bands[record["decision"]] = bands.get(record["decision"], 0) + 1
    return {
        "source": "model" if maintenance_need.load_booster() is not None else "index",
        "towers": len(towers),
        "bands": bands,
        "escalated": sum(1 for r in towers if r.get("escalated")),
        # Null counts, not coverage percentages: "we could not measure this
        # tower" is the fact worth surfacing, and a percentage hides how many.
        "novelty_unavailable": sum(1 for r in towers if r.get("novelty") is None),
        "condition_unavailable": sum(1 for r in towers if r.get("condition") is None),
        "change_unavailable": sum(1 for r in towers if r.get("change") is None),
        "flagged": sum(1 for r in towers if r.get("flags")),
        "blend_weight": CONDITION_BLEND_WEIGHT,
        "change_weight": CHANGE_BLEND_WEIGHT,
        # None under the model — no AHP weights to perturb. Passed through
        # rather than re-derived so this page and /stability cannot disagree.
        "stability": get_stability(),
    }


@router.get("/model/health")
def model_health() -> dict:
    return {"report": _report(), "serving": _serving(), "ledger": _ledger()}


def _ledger() -> dict | None:
    return feedback.summarise()


@router.get("/model/feedback/observations", response_model=list[LedgerObservationOut])
def feedback_observations(
    label_status: str | None = None,
    tower_ids: str | None = None,
) -> list[dict]:
    """Ledger rows, for joining field verdicts to the observations they can
    confirm. Read-only by design: label_status only ever flips through a human
    decision (model/feedback.py's "Evidence is never an automatic label"), and
    this route deliberately offers no way to perform that flip.

    `tower_ids` is a comma-separated allow-list, and callers are expected to
    send one: the unfiltered estate is 12,804 rows and 6 MB. Absent, the full
    set is still returned rather than an arbitrary truncation — a silently
    partial ledger would make a tower look like it had no observation when it
    has one, which is exactly the distinction the Close Loop page reports."""
    wanted = {t for t in (tower_ids or "").split(",") if t} or None
    return feedback.observations(label_status=label_status, tower_ids=wanted)
@router.get("/model/feedback/contested", response_model=list[LedgerObservationOut])
def feedback_contested(agreement: str = "disagree") -> list[dict]:
    """The adjudication queue: one ranked row per tower the imagery contradicts.

    Distinct from /model/feedback/observations, which serves raw rows and needs
    a tower_ids filter to stay small. A contested tower carries one row per
    sampled window — 848 rows across 53 towers on the current estate — so the
    raw endpoint would ship 430 KB to render a 53-entry list. This asks the
    question a human actually has: which towers is a label missing on.

    Read-only, like every other route here. It reports where adjudication is
    absent; it never performs one.
    """
    return feedback.contested(agreement=agreement)
