"""Unit tests for the signal panel producer.

Network-free. The haversine check runs against hand-computed values; the panel
invariants run against the generated CSV when it exists and return early when it
does not, so a fresh checkout without the artifact still passes.

Run from src/backend:  python3 data/test_signal_panel.py   (or via pytest)
"""

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))
sys.path.insert(0, str(_BACKEND / "data"))

import pandas as pd

from prepare_signal_panel import (
    ENVIRONMENT_COLUMNS,
    FEATURE_TABLE_CSV,
    MIN_MEASUREMENTS_PER_NODE,
    OUTPUT_CSV,
    TIMESTAMP_FORMAT,
    _node_environment,
)
from scheduler.optimize import haversine_km


def test_link_distance_uses_the_repo_haversine_against_known_values():
    """The control variable is computed, not assumed.

    Checked against physical constants — one degree of latitude is ~111.2 km —
    rather than against another call to the same function, which would assert
    nothing at all.
    """
    assert abs(haversine_km(0.0, 0.0, 0.0, 1.0) - 111.19) < 0.1
    assert abs(haversine_km(0.0, 0.0, 1.0, 0.0) - 111.19) < 0.1
    assert haversine_km(101.61, 3.07, 101.61, 3.07) == 0.0
    # Sunway AOI scale: 0.01 degrees of longitude is roughly 1.1 km.
    assert 1.0 < haversine_km(101.60, 3.07, 101.61, 3.07) < 1.2


def test_timestamp_format_is_the_archive_dotted_form():
    """2024.12.03_15.52.02 — dots, not dashes.

    A wrong format silently NaTs every row and the panel comes out empty rather
    than failing loudly.
    """
    parsed = pd.to_datetime("2024.12.03_15.52.02", format=TIMESTAMP_FORMAT)
    assert (parsed.year, parsed.month, parsed.day) == (2024, 12, 3)
    assert (parsed.hour, parsed.minute, parsed.second) == (15, 52, 2)


def test_threshold_is_set_where_median_error_is_tolerable():
    """Guards the constant against being lowered for convenience.

    sigma(Level) ~ 11 dB, so a median over n samples has SE ~ 1.25*11/sqrt(n).
    Below n=20 that exceeds 3.1 dB against an ~11 dB between-site spread.
    """
    assert MIN_MEASUREMENTS_PER_NODE >= 20


def test_node_environment_is_one_unambiguous_row_per_node():
    """Several operators share a mast; they must agree on its environment.

    If colocated rows disagreed, `first()` would silently pick one and the panel
    would carry a different environment than the site actually has.
    """
    env = _node_environment()
    assert env["node"].is_unique
    assert not env[ENVIRONMENT_COLUMNS].isna().any().any()

    feat = pd.read_csv(FEATURE_TABLE_CSV)
    feat["node"] = feat["tower_id"].str.rsplit("_", n=1).str[-1].astype(int)
    spread = feat.groupby("node")[ENVIRONMENT_COLUMNS].nunique().max()
    assert (spread == 1).all(), f"colocated rows disagree on environment: {spread.to_dict()}"


def _panel():
    return pd.read_csv(OUTPUT_CSV) if OUTPUT_CSV.exists() else None


def test_panel_has_one_row_per_node_session():
    panel = _panel()
    if panel is None:
        return
    assert not panel.duplicated(subset=["node", "SessionID"]).any()


def test_panel_drops_thin_nodes():
    panel = _panel()
    if panel is None:
        return
    totals = panel.groupby("node")["n_measurements"].sum()
    assert (totals >= MIN_MEASUREMENTS_PER_NODE).all(), "a node below the floor survived"


def test_panel_carries_environment_and_group_for_every_row():
    panel = _panel()
    if panel is None:
        return
    for column in [*ENVIRONMENT_COLUMNS, "physical_site_group", "link_distance_m", "session_ts"]:
        assert column in panel.columns, column
        assert not panel[column].isna().any(), f"{column} has nulls"
    # The group IS the node: CV must never split a shared mast across folds.
    assert (panel["physical_site_group"] == panel["node"]).all()


def test_panel_distances_are_physically_plausible_for_a_2km_aoi():
    """Tens of kilometres would mean the node join went wrong."""
    panel = _panel()
    if panel is None:
        return
    assert panel["link_distance_m"].min() >= 0
    assert panel["link_distance_m"].max() < 5000, "link distance exceeds the AOI by far"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
