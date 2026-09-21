"""Who could cover for a tower, worked out BEFORE it fails.

A port of `selectRetuningNeighbors` in src/frontend/src/lib/responsePhaseGeometry.ts,
re-framed. That module answers "this cell is down, who retunes?" for the
simulation's response phase. This one answers "this cell is predicted at risk,
does anyone stand to cover it at all?" — a pre-disaster ranking input, not a
response plan.

NOT AN RF CALCULATION, and it must never be presented as one. This repo holds
no azimuth, no antenna height, no EIRP, no frequency band and no sector
inventory; `radio` is the literal string "UNKNOWN" for 1,119 of the 1,164
towers in data/malaysia/tower_feature_table.csv, and exposed_pop, age_years and
flash_density are 0% populated. Everything here is geometry: great-circle
distance and initial bearing between known coordinates. It yields CANDIDATES
FOR AN RF PLANNER TO CONFIRM, never a configuration, and the four things it
cannot say — path loss, capacity, tilt feasibility, a specific azimuth — stay
out of reach until this dataset gains columns it does not have.

Consistent with CLAUDE.md's "never fabricate failure label": every reading here
is conditional ("if this tower fails"). Nothing in this module predicts that it
will.
"""
from __future__ import annotations

import math

# Illustrative search radius, NOT an RF propagation limit. Pinned to
# NEIGHBOR_SEARCH_RADIUS_KM in src/frontend/src/lib/responsePhaseGeometry.ts;
# test_fallback.py asserts these values so the two copies cannot drift apart
# (the same arrangement as CLUSTER_RADIUS_KM / COVERAGE_GAP_RADIUS_KM, which
# already duplicates a constant across that boundary with a test holding them
# equal). Inherited from the simulation rather than fitted to this feature —
# choosing a radius that makes the output look better is exactly the move the
# module docstring above exists to forbid.
SEARCH_RADIUS_KM = 15.0
MAX_CANDIDATES = 3
SECTOR_COUNT = 3

_EARTH_RADIUS_KM = 6371.0
_SECTOR_WIDTH_DEG = 360.0 / SECTOR_COUNT


def haversine_km(a: dict, b: dict) -> float:
    """Great-circle distance between two {lon, lat} dicts, in kilometres."""
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = lat2 - lat1
    dlon = math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * _EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def bearing_deg(a: dict, b: dict) -> float:
    """Initial great-circle bearing from `a` to `b`, normalised to [0, 360).

    A direction to a PLACE. It is not an antenna azimuth and must never be
    rendered as one.
    """
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlon = math.radians(b["lon"] - a["lon"])
    y = math.sin(dlon) * math.cos(lat2)
    x = math.cos(lat1) * math.sin(lat2) - math.sin(lat1) * math.cos(lat2) * math.cos(dlon)
    return (math.degrees(math.atan2(y, x)) + 360.0) % 360.0


def at_risk(t: dict) -> bool:
    """The model's own dispatch band, narrowed to flood.

    Reuses `decision` (model/ensemble.py's band cut) and `dominant_factor`
    (model/risk_index.py's attribution). It adds NO new threshold to the
    system, which is why it was chosen over a tunable attribution cut.

    .get() rather than [] on both keys: an unscored tower carries neither, and
    a KeyError here would take the whole report down for one bad row.
    """
    return t.get("decision") == "maintain" and t.get("dominant_factor") == "flood"


def partition_neighbours(subject: dict, towers: list[dict]) -> tuple[list[dict], list[dict]]:
    """Every other tower within SEARCH_RADIUS_KM, split by whether it is
    expected under the same water.

    Returns `(eligible, co_hazard)`, both nearest-first. `co_hazard` is
    returned rather than silently dropped because "three neighbours, all of
    them flooding too" and "no neighbours at all" are different findings that
    a caller must be able to tell apart — on the live estate they are 5 towers
    and 7 towers respectively, and collapsing them would hide the sharper one.

    Entries carry a `_tower` back-reference for internal use. `cover_candidates`
    strips it; nothing outside this module may read it.
    """
    eligible: list[dict] = []
    co_hazard: list[dict] = []
    for other in towers:
        if other["tower_id"] == subject["tower_id"]:
            continue
        distance_km = haversine_km(subject, other)
        if distance_km <= 0 or distance_km > SEARCH_RADIUS_KM:
            continue
        entry = {
            "tower_id": other["tower_id"],
            "distance_km": round(distance_km, 2),
            "bearing_deg": round(bearing_deg(subject, other), 1),
            "_tower": other,
        }
        (co_hazard if at_risk(other) else eligible).append(entry)
    eligible.sort(key=lambda e: e["distance_km"])
    co_hazard.sort(key=lambda e: e["distance_km"])
    return eligible, co_hazard


def cover_candidates(eligible: list[dict]) -> list[dict]:
    """Up to MAX_CANDIDATES neighbours, spread across bearing sectors.

    The compass is split into SECTOR_COUNT equal sectors and the nearest
    eligible tower in each is taken. Picking the nearest N overall would ignore
    direction entirely: the three closest survivors can easily all sit on the
    same side, leaving the opposite side of the subject with nothing even
    though a plausible neighbour exists further out there.

    A sector with nothing in it is SKIPPED, not backfilled from a denser one.
    Fewer than MAX_CANDIDATES is the honest report of "nothing plausible on
    that side" — and a return of zero is this whole feature's headline finding,
    not a failure.
    """
    picked: list[dict] = []
    used: set[str] = set()
    for sector in range(SECTOR_COUNT):
        start = sector * _SECTOR_WIDTH_DEG
        in_sector = [
            e for e in eligible
            if e["tower_id"] not in used
            and (e["bearing_deg"] - start + 360.0) % 360.0 < _SECTOR_WIDTH_DEG
        ]
        if not in_sector:
            continue
        # `eligible` is already nearest-first, so the first survivor is nearest.
        nearest = in_sector[0]
        picked.append({
            "tower_id": nearest["tower_id"],
            "distance_km": nearest["distance_km"],
            "bearing_deg": nearest["bearing_deg"],
        })
        used.add(nearest["tower_id"])
    return picked


def nearest_other_km(subject: dict, towers: list[dict]) -> float | None:
    """Distance to the nearest other tower in the estate, at ANY distance.

    Deliberately NOT capped at SEARCH_RADIUS_KM, and deliberately counting
    co-hazard towers: it answers "how alone is this site physically", which is
    a different question from "who could cover it". A tower whose nearest
    neighbour is 22 km away should say 22 km, not report nothing.

    None only when no other tower exists at all.
    """
    distances = [
        haversine_km(subject, other)
        for other in towers
        if other["tower_id"] != subject["tower_id"]
    ]
    return round(min(distances), 2) if distances else None


def tower_report(subject: dict, towers: list[dict]) -> dict:
    """One at-risk tower's record.

    No `isolated` boolean: `len(candidates) == 0` already says it, and a
    boolean stored beside the list it summarises is a second copy of the same
    fact that can drift out of agreement with it.
    """
    eligible, co_hazard = partition_neighbours(subject, towers)
    return {
        "tower_id": subject["tower_id"],
        "candidates": cover_candidates(eligible),
        "co_hazard": [
            {"tower_id": c["tower_id"], "distance_km": c["distance_km"]}
            for c in co_hazard
        ],
        "nearest_km": nearest_other_km(subject, towers),
    }


def fallback_report(towers: list[dict]) -> dict:
    """The full envelope: parameters, summary counts, and one record per
    at-risk tower.

    Shaped like FireExposure (a parameters block plus a towers dict) so the two
    "evidence beside the score" features read alike on both sides of the wire.

    `towers` holds ONLY at-risk towers. A tower absent from it is not at risk;
    it is never present with empty lists, because absence is not zero.

    The summary counts are not a contradiction of tower_report's no-boolean
    rule: they summarise ACROSS records rather than restating a field sitting
    beside them, and they let an export consumer report "12 of 78" without
    walking the dict. They are derived here in one place, never assembled
    separately.
    """
    from datetime import datetime, timezone

    subjects = [t for t in towers if at_risk(t)]
    records = {t["tower_id"]: tower_report(t, towers) for t in subjects}
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "parameters": {
            "search_radius_km": SEARCH_RADIUS_KM,
            "max_candidates": MAX_CANDIDATES,
            "sector_count": SECTOR_COUNT,
            "at_risk_rule": "decision == 'maintain' and dominant_factor == 'flood'",
            "basis": "great-circle geometry over tower coordinates; no antenna data",
        },
        "at_risk_count": len(records),
        "isolated_count": sum(1 for r in records.values() if not r["candidates"]),
        "towers": records,
    }


# Computed once per process, like /stability (adapter/ml_source.py) — the at-risk
# set is ~78 towers against a 1,164 pool, about 91,000 haversine evaluations, and
# scored_towers() is process-stable so there is nothing to invalidate against.
_CACHE: dict | None = None


def cached_fallback_report(towers: list[dict]) -> dict:
    global _CACHE
    if _CACHE is None:
        _CACHE = fallback_report(towers)
    return _CACHE


def reset_cache() -> None:
    """Test-only. Nothing on the serving path invalidates this cache."""
    global _CACHE
    _CACHE = None
