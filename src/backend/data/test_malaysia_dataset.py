"""Unit tests for the national dataset and flood-label producers.

Network-free: every test here exercises a pure function on hand-built input, so
the suite says nothing about whether Overpass is up and everything about
whether the geometry, the label thresholds and the deduplication are right.
Those are the parts that would fail silently — a wrong winding rule or an
off-by-one label boundary produces a plausible number, not an exception.

Run from src/backend/data:  python3 test_malaysia_dataset.py   (or via pytest)
"""

import math
from types import SimpleNamespace

import numpy as np
import pandas as pd

from prepare_malaysia_dataset import (
    DEDUPE_METRES,
    DENSIFY_METRES,
    assign_states,
    dedupe_towers,
    densify,
    radio_from_tags,
    tower_query,
)
from prepare_flood_labels import (
    CELL_DEGREES,
    POINTS_PER_CELL_SIDE,
    NOISE_OCCURRENCE,
    PERMANENT_OCCURRENCE,
    cell_points,
    compound_path,
    inside_any,
    label_from_occurrence,
    ring_area_m2,
    sample_grid,
)


# --- OSM tag reading ------------------------------------------------------
def test_radio_takes_the_newest_generation_present():
    """EQUIP in risk_index.py reads radio as the newest equipment on the mast,
    so a site carrying both LTE and NR is an NR site, not an LTE one."""
    assert radio_from_tags({"communication:lte": "yes",
                            "communication:5G": "yes"}) == "NR"
    assert radio_from_tags({"communication:3G": "yes",
                            "communication:4g": "yes"}) == "LTE"
    assert radio_from_tags({"communication:gsm": "yes"}) == "GSM"


def test_radio_is_unknown_rather_than_nan_when_untagged():
    """check_schema forbids NaN outside age_years, and a silent 0.5 default
    would hide the fact that most OSM masts carry no radio tag at all."""
    assert radio_from_tags({}) == "UNKNOWN"
    assert radio_from_tags({"communication:lte": "no"}) == "UNKNOWN"


def test_tower_query_is_bracket_balanced_overpass():
    query = tower_query()
    assert query.count("[") == query.count("]")
    assert query.count("(") == query.count(")")
    assert query.endswith("out center tags;")


# --- deduplication --------------------------------------------------------
def _towers(rows):
    return pd.DataFrame(rows, columns=["osm_type", "osm_id", "lon", "lat"])


def test_dedupe_collapses_a_tower_mapped_as_both_node_and_way():
    metres = DEDUPE_METRES / 2 / 110_574
    kept = dedupe_towers(_towers([
        ["node", 1, 101.0, 3.0],
        ["way", 2, 101.0, 3.0 + metres],
    ]))
    assert len(kept) == 1
    assert kept.iloc[0].osm_type == "way"  # the footprint centre wins


def test_dedupe_keeps_two_genuinely_separate_masts():
    apart = (DEDUPE_METRES * 4) / 110_574
    kept = dedupe_towers(_towers([
        ["node", 1, 101.0, 3.0],
        ["node", 2, 101.0, 3.0 + apart],
    ]))
    assert len(kept) == 2


# --- geometry -------------------------------------------------------------
def test_densify_bounds_the_gap_the_kdtree_has_to_bridge():
    """The KD-tree answers nearest *vertex*; densification is the whole reason
    that stands in for nearest point on a segment."""
    path = densify([(101.0, 3.0), (101.05, 3.0)], lat0=3.0)
    gaps = np.hypot(*(path[1:] - path[:-1]).T)
    assert gaps.max() <= DENSIFY_METRES + 1e-6
    assert len(path) > 100


def test_densify_keeps_a_single_point_intact():
    assert densify([(101.0, 3.0)], lat0=3.0).shape == (1, 2)


def test_assign_states_labels_inside_and_leaves_outside_blank():
    square = [[(100.0, 1.0), (102.0, 1.0), (102.0, 3.0), (100.0, 3.0), (100.0, 1.0)]]
    got = assign_states(np.array([101.0, 105.0]), np.array([2.0, 2.0]),
                        {"Testland": square})
    assert list(got) == ["Testland", ""]


def test_an_enclave_claims_its_own_points_from_the_state_around_it():
    """Kuala Lumpur, Putrajaya and Labuan sit wholly inside another state, and
    fetch_states keeps outer rings only, so a KL tower is inside both polygons.
    Smallest-state-first is what stops the surrounding state taking it — and
    the size measure has to be the LARGEST ring, because a state with offshore
    islets otherwise reports a smaller span than the enclave it contains, which
    is exactly how 38 KL towers were first labelled Selangor.
    """
    big = [[(100.0, 1.0), (104.0, 1.0), (104.0, 5.0), (100.0, 5.0), (100.0, 1.0)],
           [(99.0, 0.9), (99.02, 0.9), (99.02, 0.92), (99.0, 0.92), (99.0, 0.9)]]
    enclave = [[(101.0, 2.0), (102.0, 2.0), (102.0, 3.0), (101.0, 3.0), (101.0, 2.0)]]
    got = assign_states(np.array([101.5, 103.0]), np.array([2.5, 4.0]),
                        {"Surrounding": big, "Enclave": enclave})
    assert list(got) == ["Enclave", "Surrounding"]


def test_compound_path_subtracts_a_hole():
    """matplotlib does NOT do this for us: a compound Path unions its subpaths,
    so Path.contains_points returns True for a point sitting in the hole. Left
    to it, every dry island inside a UNOSAT flood polygon would be labelled
    flooded, and the only symptom would be slightly flattering recall."""
    outer = [(0.0, 0.0), (10.0, 0.0), (10.0, 10.0), (0.0, 10.0), (0.0, 0.0)]
    hole = [(4.0, 4.0), (4.0, 6.0), (6.0, 6.0), (6.0, 4.0), (4.0, 4.0)]
    # Shapefile winding: outer clockwise, hole counter-clockwise.
    shape = SimpleNamespace(points=outer[::-1] + hole[::-1], parts=[0, len(outer)])
    parsed = compound_path(shape)
    inside = inside_any([parsed], np.array([1.0, 5.0]), np.array([1.0, 5.0]))
    assert list(inside) == [True, False]


def test_orientation_decides_outer_from_hole():
    square = np.array([(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)])
    assert ring_area_m2(square) > 0            # counter-clockwise -> hole
    assert ring_area_m2(square[::-1]) < 0      # clockwise -> outer ring


def test_parsed_area_matches_the_ring_geometry():
    """compound_path returns the area it parsed so unosat_paths can check it
    against the shapefile's own Area_m2 field instead of trusting the parse."""
    outer = [(0.0, 0.0), (0.1, 0.0), (0.1, 0.1), (0.0, 0.1), (0.0, 0.0)]
    shape = SimpleNamespace(points=outer[::-1], parts=[0])
    _, holes, area = compound_path(shape)
    assert holes is None
    expected = (0.1 * 111_320 * math.cos(math.radians(0.05))) * (0.1 * 110_574)
    assert abs(area - expected) / expected < 0.01


def test_sample_grid_reads_a_north_up_raster():
    raster = np.array([[[1.0, 2.0], [3.0, 4.0]]])
    bounds = (100.0, 3.0, 100.02, 3.02)
    got = sample_grid(raster, np.array([100.005, 100.015]),
                      np.array([3.015, 3.005]), bounds)
    assert got.tolist() == [[1.0, 4.0]]  # top-left first, bottom-right second


def test_cell_points_stay_inside_their_own_cell():
    corners = np.array([[101.0, 3.0], [102.5, 4.5]])
    points = cell_points(corners, seed=7)
    for index, (x0, y0) in enumerate(corners):
        cell = points[points.cell_id == index]
        assert cell.lon.min() >= x0 and cell.lon.max() <= x0 + CELL_DEGREES
        assert cell.lat.min() >= y0 and cell.lat.max() <= y0 + CELL_DEGREES
    assert len(points) == 2 * POINTS_PER_CELL_SIDE ** 2


# --- label definition -----------------------------------------------------
def test_label_boundaries_are_exactly_where_the_manifest_says():
    occurrence = np.array([0.0, NOISE_OCCURRENCE - 0.1, NOISE_OCCURRENCE,
                           50.0, PERMANENT_OCCURRENCE - 0.1,
                           PERMANENT_OCCURRENCE, 100.0])
    assert label_from_occurrence(occurrence).tolist() == [0, -1, 1, 1, 1, -1, -1]


def test_permanent_water_is_excluded_not_counted_as_a_positive():
    """A river is trivially 'inundated' and no tower stands in one. Counting
    permanent water as a positive would let a model score well by finding water
    bodies, which is a different question from flood exposure."""
    labels = label_from_occurrence(np.array([95.0, 99.0, 100.0]))
    assert set(labels.tolist()) == {-1}


def test_exclusions_are_visible_rather_than_dropped_silently():
    """-1 rather than a shorter array: a denominator that shrinks without being
    reported is how a 2% base rate quietly becomes a 40% one."""
    occurrence = np.array([0.0, 2.0, 10.0, 90.0])
    assert len(label_from_occurrence(occurrence)) == len(occurrence)


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
