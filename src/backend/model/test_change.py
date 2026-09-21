"""Network-free checks for one-sided growth, missing evidence and the blend.

Run from src/backend: python3 model/test_change.py (or pytest).
"""
import ast
import sys
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

_BACKEND = Path(__file__).resolve().parent.parent
for p in (str(_BACKEND), str(_BACKEND / "data")):
    if p not in sys.path:
        sys.path.insert(0, p)

import numpy as np
import pandas as pd
from model import change, ensemble
from model.profiler import BehavioralProfiler, PREDICATES
import prepare_land_change as producer


def test_change_is_one_sided_and_aligned():
    frame = pd.DataFrame({"tower_id": ["A", "B", "C"], "evi_delta_per_year": [-.5, 0, .5]})
    scores = change.change_scores(["C", "A", "B", "missing"], frame)
    assert scores[1] == scores[2] < scores[0] and np.isnan(scores[3])
    assert change.change_scores([], frame).size == 0


def test_change_never_abs():
    tree = ast.parse(Path(change.__file__).read_text())
    assert not any(isinstance(n, ast.Call) and
                   (getattr(n.func, "id", None) in {"abs", "absolute"} or
                    getattr(n.func, "attr", None) in {"abs", "absolute"}) for n in ast.walk(tree))


def test_missing_or_corrupt_change_stays_nan():
    with TemporaryDirectory() as directory, patch.object(change, "CHANGE_CSV", Path(directory) / "missing.csv"):
        assert np.isnan(change.change_scores(["A"])).all()
        change.CHANGE_CSV.write_text('not,a,table\n"')
        assert np.isnan(change.change_scores(["A"])).all()
    assert np.isnan(change.change_scores(["A"], pd.DataFrame({"tower_id": ["A"]}))).all()
    frame = pd.DataFrame({"tower_id": ["A", "B"], "evi_delta_per_year": [np.inf, "bad"]})
    assert np.isnan(change.change_scores(["A", "B"], frame)).all()


def test_blend_change_none_is_todays_behaviour():
    rng = np.random.default_rng(0)
    risk, condition = rng.random((2, 100))
    condition[::3] = np.nan
    r = pd.Series(risk).rank(pct=True).to_numpy()
    c = pd.Series(condition).rank(pct=True).to_numpy()
    known = np.isfinite(c)
    original = r.copy()
    original[known] = (1 - ensemble.CONDITION_BLEND_WEIGHT) * r[known] + ensemble.CONDITION_BLEND_WEIGHT * c[known]
    expected = pd.Series(original).rank(pct=True).to_numpy()
    for evidence in (None, np.full(100, np.nan)):
        np.testing.assert_array_equal(ensemble.blend_priority(risk, condition, evidence, change_weight=.15), expected)
    np.testing.assert_array_equal(ensemble.blend_priority(risk, condition, rng.random(100), change_weight=0), expected)


def test_blend_three_ranks_and_partial_evidence_renormalises():
    risk = np.array([.4, .7, .1, .8, .3, .6])
    condition = np.array([.2, np.nan, .1, .8, np.nan, .5])
    growth = np.array([np.nan, .6, .4, .9, np.nan, .2])
    r, c, g = [pd.Series(v).rank(pct=True).to_numpy() for v in (risk, condition, growth)]
    # All four availability cases: condition only, change only, both, neither.
    raw = [(.6*r[0] + .25*c[0])/.85, (.6*r[1] + .15*g[1])/.75,
           .6*r[2] + .25*c[2] + .15*g[2], .6*r[3] + .25*c[3] + .15*g[3],
           r[4], .6*r[5] + .25*c[5] + .15*g[5]]
    result = ensemble.blend_priority(risk, condition, growth, change_weight=.15)
    np.testing.assert_array_equal(result, pd.Series(raw).rank(pct=True).to_numpy())
    before = risk.copy()
    for which in range(3):
        inputs = [np.ones(3)] * 3
        inputs[which] = np.array([.1, .5, .9])
        assert np.all(np.diff(ensemble.blend_priority(*inputs, change_weight=.15)) > 0)
    np.testing.assert_array_equal(before, risk)
    assert ensemble.blend_priority([], [], [], change_weight=.15).size == 0


def test_disagreement_needs_evidence_and_uses_yaml():
    profiler = BehavioralProfiler()
    assert set(profiler.rules) == set(PREDICATES)
    high = PREDICATES["model_high_ground_quiet"]
    low = PREDICATES["model_low_ground_active"]
    row = pd.Series(dtype=float)
    record = {"decision": "maintain", "priority": .95, "condition": .1, "change": .2}
    assert high(profiler, record, row) and not low(profiler, record, row)
    assert low(profiler, {**record, "priority": .3, "decision": "ok", "change": .95}, row)
    for unavailable in (None, np.nan):
        assert not high(profiler, {**record, "change": unavailable}, row)
        assert not low(profiler, {**record, "change": unavailable}, row)
        assert not high(profiler, {**record, "condition": unavailable}, row)


def test_producer_reuses_sampler_and_rejects_missing_before_writing():
    with TemporaryDirectory() as directory:
        root = Path(directory)
        table = root / "towers.csv"
        pd.DataFrame({"tower_id": ["A", "B"], "lon": [101., 102.], "lat": [3., 4.]}).to_csv(table, index=False)
        args = producer.parser().parse_args(["--tower-table", str(table), "--cache-dir", str(root), "--out", str(root / "out.csv"), "--manifest", str(root / "manifest.json"), "--end-date", "2026-09-12"])
        def reduction(ee, end, **kwargs):
            assert kwargs["count_scenes"] is True
            recent = end == date(2026, 9, 12)
            def sampler(chunk):
                return {"scene_count": 10, "features": [
                    {"properties": {"tower_id": "A", "evi_median": .6 if recent else .2}},
                    {"properties": {"tower_id": "B", "evi_median": .1 if recent else .5}},
                ]}
            from datetime import timedelta
            return sampler, ["evi_median", "evi_p10"], ((end - timedelta(days=365)).isoformat(), end.isoformat())
        with patch.object(producer, "initialise", return_value=object()), patch.object(producer, "evi_reduction", side_effect=reduction):
            manifest = producer.build(args)
            frame = pd.read_csv(args.out)
            np.testing.assert_allclose(frame.evi_delta_per_year, [.2, -.2])
            assert frame.land_cover_changed.isna().all()
            assert manifest["scene_counts"] == {"recent": [10], "baseline": [10]}
            # A second run must use cached responses while retaining counts.
            assert producer.build(args)["scene_counts"] == manifest["scene_counts"]
        original = args.out.read_bytes()
        response = {"features": [], "scene_count": 0}
        with patch.object(producer, "initialise", return_value=object()), patch.object(producer, "evi_reduction", side_effect=reduction), patch.object(producer, "cached_chunk", return_value=response):
            try:
                producer.build(args)
                raise AssertionError("empty windows must stop the producer")
            except ValueError as error:
                assert "no Sentinel-2 scenes" in str(error)
        assert args.out.read_bytes() == original
        response = {"scene_count": 10, "features": [
            {"properties": {"tower_id": "A", "evi_median": .4}},
        ]}
        with patch.object(producer, "initialise", return_value=object()), patch.object(producer, "evi_reduction", side_effect=reduction), patch.object(producer, "cached_chunk", return_value=response):
            try:
                producer.build(args)
                raise AssertionError("missing pixels must stop the producer")
            except SystemExit as error:
                assert "50.0%" in str(error)
        assert args.out.read_bytes() == original


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
