"""API checks for live tower scoring, and for what `risk` actually is.

The risk-provenance tests exist because `risk` was for a while the withdrawn
`maintenance_classifier`'s out-of-fold probability rather than the index — a
substitution nothing in the test suite would have caught. `risk` is now the
SECOND supervised model this file has served (model.maintenance_need), and the
guards below were re-pointed rather than deleted when it landed: they still
distinguish "a real scoring path ran" from "something silently fell through to
a stale or wrong source," they just no longer assume the index is the only
legitimate answer. See adapter/ml_source.py's module docstring for the full
account of why this model is not a repeat of the withdrawn one's failure.
"""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

from fastapi.testclient import TestClient

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from api.main import app
from adapter import ml_source
from model import maintenance_need


def test_risk_carries_a_recognised_distribution():
    """Distinguishes a real scoring path from a broken one by shape, without
    hardcoding which of the two legitimate paths is active in this checkout.

    Deliberately not an equality check against either scorer: the adapter
    drops the `lightning` membership before weighting under the index, and
    calls maintenance_need.score() as a black box under the model, so
    reproducing either exact number here would mean re-implementing the code
    under test and asserting it equals itself.

    Under the index this AOI is compressed near its ceiling (p50 ~ 0.95);
    under the model it is a probability with a base-rate-shaped median
    (typically 0.10-0.35, since maintenance need is a minority-class label).
    Both are legitimate; a NaN, an out-of-[0,1] value, or a degenerate
    single-valued distribution is not.
    """
    risks = sorted(r["risk"] for r in ml_source.load_scored_towers())
    assert risks, "no scored towers"
    assert all(0.0 <= r <= 1.0 for r in risks)
    assert len(set(round(r, 6) for r in risks)) > 10, "risk is suspiciously constant"

    median = risks[len(risks) // 2]
    if maintenance_need.load_booster() is not None:
        assert 0.0 < median < 0.6, (
            f"risk p50 is {median:.3f} under the trained model; expected a "
            "base-rate-shaped probability, not something near the index's "
            "compressed ceiling."
        )
    else:
        assert median > 0.5, (
            f"risk p50 is {median:.3f}; the index on this AOI sits near 0.95. "
            "A low median with no trained model present suggests a probability "
            "has been substituted without a real scorer behind it."
        )


def test_stability_interval_brackets_risk_without_a_correction():
    """risk_lo <= risk <= risk_hi, straight from the perturbation quantiles.

    This held before too, but only because a ratio correction was applied to
    force it — risk and the draws were different quantities on different
    scales. Under the index they are now the same quantity, so it holds by
    construction. Under the model there are no perturbation draws to bracket
    with (see adapter/ml_source._compute_stability_draws), so risk_lo and
    risk_hi collapse to risk itself — the inequality still holds, degenerately,
    which is the honest way to represent "no uncertainty measured" rather than
    fabricating an interval.
    """
    for record in ml_source.load_scored_towers():
        assert record["risk_lo"] <= record["risk"] <= record["risk_hi"], record["tower_id"]


def test_all_three_decision_bands_are_populated():
    """A capacity-anchored quantile cut must actually produce three groups.

    The index is compressed on this AOI (p50 ~ 0.95, IQR ~ 0.10), which is why
    the bands are quantiles rather than fixed thresholds. If one band empties,
    the cut has stopped describing the distribution.
    """
    bands = Counter(r["decision"] for r in ml_source.load_scored_towers())
    for band in ("maintain", "watch", "ok"):
        assert bands[band] > 0, f"band {band!r} is empty: {dict(bands)}"


def test_dominant_factor_is_the_argmax_of_attribution():
    """Read from the shares, not carried alongside them, so they cannot drift."""
    for record in ml_source.load_scored_towers():
        shares = record["attribution"]
        assert record["dominant_factor"] == max(shares, key=shares.get), record["tower_id"]


def test_no_reference_to_the_withdrawn_classifier():
    """Guards the rewire from being partially reverted.

    Names the artifacts rather than the behaviour because the failure mode is a
    reintroduced CSV read, which every behavioural test would still pass.
    """
    source = (Path(__file__).resolve().parent / "ml_source.py").read_text(encoding="utf-8")
    for gone in ("RISK_COLUMN", "maintenance_decisions", "_load_decisions", "ml_decision_by_tower"):
        assert gone not in source, f"{gone} is back in ml_source.py"


def test_towers_and_score_scale_relationship_matches_the_active_source():
    """/towers and /score must agree exactly when both are on the index — the
    original guard, unchanged in that case — and are EXPECTED to disagree once
    /towers serves the supervised model, since /score has no weight-override
    equivalent for a trained model and stays on the index unconditionally
    (see score_with_weights' docstring for why that is a stated product
    inconsistency, not an oversight of this test).

    Before the withdrawn classifier was removed, /towers and /score disagreed
    by ACCIDENT — same intent, different code paths that drifted. What this
    test now guards is narrower and still real: that the two endpoints'
    relationship matches whichever source is actually active, so a future
    change to fall back to the index without updating /score (or vice versa)
    does not silently reintroduce an unexplained mismatch.
    """
    client = TestClient(app)
    scored = {t["tower_id"]: t["risk"] for t in client.post("/score", json={"weights": {}}).json()}
    towers = ml_source.load_scored_towers()

    if maintenance_need.load_booster() is not None:
        disagreements = sum(
            1 for r in towers if abs(r["risk"] - scored[r["tower_id"]]) > 1e-9
        )
        assert disagreements > 0, (
            "expected /towers (model) and /score (index) to disagree with a "
            "trained model present; identical risk suggests /towers silently "
            "fell back to the index without a model actually loading."
        )
    else:
        for record in towers:
            assert abs(record["risk"] - scored[record["tower_id"]]) < 1e-12, record["tower_id"]


def test_score_bbox_filters_before_recomputing_bands_and_validates_input(monkeypatch):
    # POST /score honours USE_FIXTURE like every other tower-source call site,
    # and both branches re-score from their own feature table. This test is
    # about the REAL adapter's path specifically — the tower ids, the CSV-fed
    # feature table and the coordinates it looks up are the real Sunway ones,
    # not the fixture's MY_* population — so it pins the default branch as
    # part of its own subject, not as a defence against another module's
    # leakage. (It was the latter until agent/test_tools.py and
    # scheduler/test_optimize.py stopped mutating os.environ process-wide.)
    monkeypatch.delenv("USE_FIXTURE", raising=False)
    client = TestClient(app)
    unscoped = client.post("/score", json={"weights": {}})
    assert unscoped.status_code == 200
    all_towers = unscoped.json()

    counts = Counter((tower["lon"], tower["lat"]) for tower in all_towers)
    target = next(
        tower
        for tower in all_towers
        if tower["decision"] == "ok" and counts[(tower["lon"], tower["lat"])] == 1
    )
    delta = 1e-7
    bbox = [
        target["lon"] - delta,
        target["lat"] - delta,
        target["lon"] + delta,
        target["lat"] + delta,
    ]
    scoped = client.post("/score", json={"weights": {}, "bbox": bbox})
    assert scoped.status_code == 200
    assert [tower["tower_id"] for tower in scoped.json()] == [target["tower_id"]]
    assert scoped.json()[0]["decision"] == "maintain"

    assert client.post("/score", json={"bbox": [110, 5, 111, 6]}).json() == []
    for invalid in (
        [2, 0, 1, 1],
        [0, 2, 1, 1],
        [-181, 0, 1, 1],
        [0, -91, 1, 1],
        ["NaN", 0, 1, 1],
        [0, 0, 1],
    ):
        assert client.post("/score", json={"bbox": invalid}).status_code == 422


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-v"]))
