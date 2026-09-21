"""Unit tests for the cover-candidate geometry.

    python3 src/backend/model/test_fallback.py     # or: pytest

Every case is built from literals — no fixture population, no network. That is
deliberate: the USE_FIXTURE estate packs 500 towers into a box ~14 km across,
so it can never produce an isolated tower, and all 35 of its maintain-band
towers are flood-dominant, so it never exercises the dominant_factor half of
at_risk(). Neither branch can be relied on for coverage.
"""

from fallback import (MAX_CANDIDATES, SEARCH_RADIUS_KM, SECTOR_COUNT, at_risk,
                      bearing_deg, cached_fallback_report, cover_candidates,
                      fallback_report, haversine_km, nearest_other_km,
                      partition_neighbours, reset_cache, tower_report)


def _t(tower_id, lon, lat, decision="ok", dominant_factor="power"):
    """A tower dict carrying only the keys this module reads."""
    return {
        "tower_id": tower_id,
        "lon": lon,
        "lat": lat,
        "decision": decision,
        "dominant_factor": dominant_factor,
    }


def _at(tower_id, lon, lat):
    """An at-risk tower: maintain band, flood dominant."""
    return _t(tower_id, lon, lat, decision="maintain", dominant_factor="flood")


def test_haversine_one_degree_of_latitude():
    """One degree of latitude is ~111.19 km anywhere on the sphere."""
    d = haversine_km(_t("A", 101.0, 3.0), _t("B", 101.0, 4.0))
    assert abs(d - 111.19) < 0.5, d


def test_haversine_is_zero_for_the_same_point():
    assert haversine_km(_t("A", 101.0, 3.0), _t("B", 101.0, 3.0)) == 0.0


def test_bearing_due_north_is_zero():
    b = bearing_deg(_t("A", 101.0, 3.0), _t("B", 101.0, 4.0))
    assert abs(b) < 0.01, b


def test_bearing_due_east_is_about_ninety():
    """Slightly under 90 on a sphere — the great circle bends poleward."""
    b = bearing_deg(_t("A", 101.0, 3.0), _t("B", 102.0, 3.0))
    assert abs(b - 90.0) < 0.5, b


def test_bearing_is_normalised_into_zero_to_360():
    """Due west must read 270, never -90."""
    b = bearing_deg(_t("A", 101.0, 3.0), _t("B", 100.0, 3.0))
    assert 269.0 < b < 271.0, b


def test_at_risk_requires_both_maintain_and_flood():
    assert at_risk(_at("A", 101.0, 3.0)) is True
    assert at_risk(_t("B", 101.0, 3.0, "maintain", "power")) is False
    assert at_risk(_t("C", 101.0, 3.0, "watch", "flood")) is False
    assert at_risk(_t("D", 101.0, 3.0, "ok", "power")) is False


def test_at_risk_tolerates_a_missing_dominant_factor():
    """An unscored tower has no dominant_factor key. It is not at risk; it must
    not raise KeyError and take the whole report down with it."""
    assert at_risk({"tower_id": "E", "lon": 101.0, "lat": 3.0}) is False


def test_constants_match_the_frontend_copies():
    """Pinned to NEIGHBOR_SEARCH_RADIUS_KM and MAX_RETUNING_NEIGHBORS in
    src/frontend/src/lib/responsePhaseGeometry.ts. The two implementations are
    allowed to differ in code but NOT in parameters — same arrangement as
    CLUSTER_RADIUS_KM / COVERAGE_GAP_RADIUS_KM, which this mirrors.

    If you are changing one of these, change the TypeScript copy in the same
    commit. Do not change either to make output look better."""
    assert SEARCH_RADIUS_KM == 15.0
    assert MAX_CANDIDATES == 3
    assert SECTOR_COUNT == 3


# Offsets from (101.0, 3.0) landing mid-sector at bearings ~30, ~150, ~270,
# each about 10 km out. Mid-sector on purpose: a tower placed at exactly 120.0
# sits on a sector boundary where a floating-point wobble decides which side it
# lands on, which would make the test flaky rather than strict.
_N30 = (101.0 + 0.04506, 3.0 + 0.07794)    # bearing ~30, ~10.0 km
_S150 = (101.0 + 0.04506, 3.0 - 0.07794)   # bearing ~150, ~10.0 km
_W270 = (101.0 - 0.09012, 3.0)             # bearing ~270, ~10.0 km


def _subject():
    return _at("SUBJ", 101.0, 3.0)


def test_partition_excludes_towers_beyond_the_radius():
    """0.09 deg of latitude is ~10.0 km (in); 0.15 deg is ~16.7 km (out)."""
    towers = [
        _subject(),
        _t("NEAR", 101.0, 3.09),
        _t("FAR", 101.0, 3.15),
    ]
    eligible, co_hazard = partition_neighbours(_subject(), towers)
    assert [e["tower_id"] for e in eligible] == ["NEAR"]
    assert co_hazard == []


def test_partition_never_includes_the_subject_itself():
    towers = [_subject(), _t("NEAR", 101.0, 3.09)]
    eligible, co_hazard = partition_neighbours(_subject(), towers)
    assert "SUBJ" not in [e["tower_id"] for e in eligible]
    assert "SUBJ" not in [c["tower_id"] for c in co_hazard]


def test_partition_routes_an_at_risk_neighbour_to_co_hazard():
    """A neighbour expected under the same water is not a candidate. This is
    the case the USE_FIXTURE branch can never produce, because all 35 of its
    maintain-band towers are flood-dominant."""
    towers = [
        _subject(),
        _t("SAFE", 101.0, 3.09),
        _at("DROWNS", 101.0, 2.91),
    ]
    eligible, co_hazard = partition_neighbours(_subject(), towers)
    assert [e["tower_id"] for e in eligible] == ["SAFE"]
    assert [c["tower_id"] for c in co_hazard] == ["DROWNS"]


def test_partition_sorts_nearest_first():
    towers = [
        _subject(),
        _t("FARTHER", 101.0, 3.09),
        _t("NEARER", 101.0, 3.03),
    ]
    eligible, _ = partition_neighbours(_subject(), towers)
    assert [e["tower_id"] for e in eligible] == ["NEARER", "FARTHER"]


def test_candidates_fan_across_three_sectors():
    """One per 120-degree sector, so cones spread around the subject instead of
    stacking on whichever side is locally denser."""
    towers = [
        _subject(),
        _t("A", *_N30),
        _t("B", *_S150),
        _t("C", *_W270),
    ]
    eligible, _ = partition_neighbours(_subject(), towers)
    picked = cover_candidates(eligible)
    assert len(picked) == 3
    assert {p["tower_id"] for p in picked} == {"A", "B", "C"}


def test_candidates_take_only_the_nearest_within_one_sector():
    """Three towers on the same side yield ONE candidate, not three. Returning
    fewer than MAX_CANDIDATES is the honest report of nothing plausible on the
    other sides, not a shortfall to paper over."""
    towers = [
        _subject(),
        _t("NEAR", 101.0 + 0.02253, 3.0 + 0.03897),   # ~5 km, bearing ~30
        _t("MID", *_N30),                              # ~10 km, bearing ~30
        _t("FAR", 101.0 + 0.06309, 3.0 + 0.10912),     # ~14 km, bearing ~30
    ]
    eligible, _ = partition_neighbours(_subject(), towers)
    picked = cover_candidates(eligible)
    assert len(picked) == 1
    assert picked[0]["tower_id"] == "NEAR"


def test_candidates_are_capped_at_max():
    """Six towers, two per sector, still yields three."""
    towers = [_subject()]
    for i, (lon, lat) in enumerate([_N30, _S150, _W270]):
        towers.append(_t(f"NEAR{i}", lon, lat))
        # A second tower in the same sector, slightly further out.
        towers.append(_t(f"FAR{i}", 101.0 + (lon - 101.0) * 1.3, 3.0 + (lat - 3.0) * 1.3))
    eligible, _ = partition_neighbours(_subject(), towers)
    assert len(cover_candidates(eligible)) == MAX_CANDIDATES


def test_candidates_of_an_empty_pool_is_empty():
    assert cover_candidates([]) == []


def test_candidate_entries_carry_no_private_keys():
    """The _tower back-reference partition_neighbours carries internally must
    not reach the API surface."""
    towers = [_subject(), _t("A", *_N30)]
    eligible, _ = partition_neighbours(_subject(), towers)
    picked = cover_candidates(eligible)
    assert set(picked[0]) == {"tower_id", "distance_km", "bearing_deg"}


def test_nearest_other_km_is_not_capped_by_the_search_radius():
    """A tower whose nearest neighbour is 22 km away must report 22, not None.
    'How alone is this site physically' is a different question from 'who could
    cover it', and the panel's isolated state prints this number."""
    towers = [_subject(), _t("DISTANT", 101.0, 3.20)]   # ~22.2 km
    d = nearest_other_km(_subject(), towers)
    assert 22.0 < d < 22.5, d


def test_nearest_other_km_is_none_for_a_single_tower_estate():
    assert nearest_other_km(_subject(), [_subject()]) is None


def test_nearest_other_km_counts_co_hazard_towers():
    """It measures physical company, not usable company."""
    towers = [_subject(), _at("DROWNS", 101.0, 3.03), _t("SAFE", 101.0, 3.09)]
    d = nearest_other_km(_subject(), towers)
    assert d < 4.0, d


def test_tower_report_shape():
    towers = [_subject(), _t("A", *_N30)]
    r = tower_report(_subject(), towers)
    assert set(r) == {"tower_id", "candidates", "co_hazard", "nearest_km"}
    assert r["tower_id"] == "SUBJ"
    assert [c["tower_id"] for c in r["candidates"]] == ["A"]
    assert r["co_hazard"] == []


def test_tower_report_has_no_isolated_flag():
    """len(candidates) == 0 already says it. A boolean stored beside the list
    it summarises is a second copy of the same fact that can disagree."""
    r = tower_report(_subject(), [_subject()])
    assert "isolated" not in r
    assert r["candidates"] == []


def test_report_contains_only_at_risk_towers():
    """A tower that is not at risk is ABSENT, never present with empty lists.
    Absence is not zero."""
    towers = [_at("RISKY", 101.0, 3.0), _t("FINE", 101.0, 3.09)]
    report = fallback_report(towers)
    assert set(report["towers"]) == {"RISKY"}


def test_report_envelope_counts():
    towers = [
        _at("ALONE", 105.0, 5.0),                 # far from everything
        _at("COVERED", 101.0, 3.0),
        _t("HELPER", *_N30),
    ]
    report = fallback_report(towers)
    assert report["at_risk_count"] == 2
    assert report["isolated_count"] == 1
    assert report["towers"]["ALONE"]["candidates"] == []
    assert len(report["towers"]["COVERED"]["candidates"]) == 1


def test_report_parameters_block_declares_the_basis():
    """The disclaimer travels with the data, not only in the UI."""
    report = fallback_report([_at("A", 101.0, 3.0)])
    params = report["parameters"]
    assert params["search_radius_km"] == SEARCH_RADIUS_KM
    assert params["max_candidates"] == MAX_CANDIDATES
    assert params["sector_count"] == SECTOR_COUNT
    assert "maintain" in params["at_risk_rule"]
    assert "no antenna data" in params["basis"]


def test_report_is_deterministic():
    towers = [_at("A", 101.0, 3.0), _t("B", *_N30), _t("C", *_S150)]
    first = fallback_report(towers)
    second = fallback_report(towers)
    del first["generated_at"], second["generated_at"]
    assert first == second


def test_cache_returns_the_same_object_until_reset():
    towers = [_at("A", 101.0, 3.0)]
    reset_cache()
    first = cached_fallback_report(towers)
    assert cached_fallback_report(towers) is first
    reset_cache()
    assert cached_fallback_report(towers) is not first


def test_report_is_json_serialisable():
    """No numpy scalars, no tuples, no private keys — this crosses the wire."""
    import json
    towers = [_at("A", 101.0, 3.0), _t("B", *_N30), _at("C", *_S150)]
    dumped = json.dumps(fallback_report(towers))
    assert "_tower" not in dumped


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
