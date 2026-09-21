# Tower Cover Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute, before any disaster, whether each flood-exposed tower has a neighbour that could stand in for it, and surface the ones that have none as a ranking signal on the predictive namelist.

**Architecture:** A pure Python module (`model/fallback.py`) ports the sector-split neighbour selection that already exists in the frontend's simulation geometry, re-framed from "which towers are down" to "which towers the model puts in the maintain band with flood dominant". One new endpoint serves it; three frontend surfaces consume it, joined client-side on `tower_id`.

**Tech Stack:** Python 3 + FastAPI + pydantic (backend, no new dependencies); React 19 + TypeScript + Tailwind v4 + TanStack Query + MapLibre (frontend, no new dependencies).

**Spec:** `docs/superpowers/specs/2026-09-19-tower-cover-candidates-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **This is geometry, never RF.** The repo holds no azimuth, antenna height, EIRP, frequency band, sector count or tilt range. `radio` is the literal string `UNKNOWN` for 1,119 of 1,164 towers. Output is *candidates for an RF planner to confirm*, never a configuration.
- **Never fabricate a failure label** (CLAUDE.md project rule). Permitted copy: *"if it fails"*, *"cover candidates"*, *"no cover"*. Forbidden anywhere — endpoint names, docstrings, UI copy, commit messages: *"will fail"*, *"failure risk"*, *"outage probability"*, *"predicted failure"*.
- **Every emitted field is a distance, a bearing, a count, or a tower id.** Nothing else.
- **`SEARCH_RADIUS_KM = 15.0`, `MAX_CANDIDATES = 3`, `SECTOR_COUNT = 3`.** These are pinned by test to match `NEIGHBOR_SEARCH_RADIUS_KM` and `MAX_RETUNING_NEIGHBORS` in `src/frontend/src/lib/responsePhaseGeometry.ts`. **Never change a constant to make output look better.**
- **Absence is not zero.** A tower that is not at risk is *absent* from the report, never present with empty lists. A pending fetch renders nothing, never "none found".
- **Band colour has exactly one source:** `src/frontend/src/lib/colors.ts`. No new surface may paint a reading on the severity ramp.
- **All backend commands run from `src/backend/`.** All frontend commands run from `src/frontend/`.
- **Branch:** work continues on `spec/tower-cover-candidates` (already created, holds the spec commit).

### Reference values measured 2026-09-19

| | live branch | `USE_FIXTURE=1` |
|---|---|---|
| towers | 1,164 | 500 |
| at-risk (maintain + flood) | 78 | 35 |
| isolated (0 candidates) | **12** | **0** |
| └ nothing within 15 km | 7 | 0 |
| └ neighbours exist, all at risk | 5 | 0 |

The fixture's whole AOI is ~14 km across, so isolation is structurally impossible there. That is correct output, not a bug. **Demos must run on the live branch.**

---

## File Structure

| file | responsibility | task |
|---|---|---|
| `src/backend/model/fallback.py` | **create** — geometry primitives, at-risk predicate, sector-split selection, report envelope, cache | 1–3 |
| `src/backend/model/test_fallback.py` | **create** — unit tests over hand-built literals | 1–3 |
| `src/backend/model/test_fallback_realdata.py` | **create** — regression pin on the live estate | 4 |
| `src/backend/api/schemas.py` | modify — four pydantic models | 5 |
| `src/backend/api/routes/towers.py` | modify — `GET /towers/fallback` | 5 |
| `src/backend/api/test_towers_fallback.py` | **create** — route-level test | 5 |
| `src/frontend/src/api/types.ts` | modify — four interfaces | 6 |
| `src/frontend/src/api/client.ts` | modify — `getTowerFallback()` | 6 |
| `src/frontend/src/api/queries.ts` | modify — `useTowerFallbackQuery()` | 6 |
| `src/frontend/src/pages/Investigation.tsx` | modify — filter tab, sort option, row line, panel mount | 7, 8 |
| `src/frontend/src/components/investigation/FallbackPanel.tsx` | **create** — four-state detail panel | 8 |
| `src/frontend/src/components/investigation/index.ts` | modify — one export | 8 |
| `src/frontend/src/components/map/towerLayer.ts` | modify — ring source/layer constants + paint | 9 |
| `src/frontend/src/components/map/MapView.tsx` | modify — mount and feed the ring layer | 9 |
| `src/frontend/src/components/simulation/SimulationLegend.tsx` | modify — copy only | 10 |

`model/fallback.py` imports nothing from `api/` or `scheduler/`. It is a pure module over `list[dict]`, testable with literals and no network.

---

## Task 1: Geometry primitives and the at-risk predicate

**Files:**
- Create: `src/backend/model/fallback.py`
- Test: `src/backend/model/test_fallback.py`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `SEARCH_RADIUS_KM: float = 15.0`, `MAX_CANDIDATES: int = 3`, `SECTOR_COUNT: int = 3`
  - `haversine_km(a: dict, b: dict) -> float` — `a`/`b` are dicts with `lon`/`lat` float keys
  - `bearing_deg(a: dict, b: dict) -> float` — initial great-circle bearing, `[0, 360)`
  - `at_risk(t: dict) -> bool`

- [ ] **Step 1: Write the failing test**

Create `src/backend/model/test_fallback.py`:

```python
"""Unit tests for the cover-candidate geometry.

    python3 src/backend/model/test_fallback.py     # or: pytest

Every case is built from literals — no fixture population, no network. That is
deliberate: the USE_FIXTURE estate packs 500 towers into a box ~14 km across,
so it can never produce an isolated tower, and all 35 of its maintain-band
towers are flood-dominant, so it never exercises the dominant_factor half of
at_risk(). Neither branch can be relied on for coverage.
"""

import math

from fallback import (MAX_CANDIDATES, SEARCH_RADIUS_KM, SECTOR_COUNT, at_risk,
                      bearing_deg, haversine_km)


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


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ModuleNotFoundError: No module named 'fallback'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/backend/model/fallback.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ok` for all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/model/fallback.py src/backend/model/test_fallback.py
git commit -m "feat(model): geometry primitives and at-risk predicate for cover candidates

Great-circle distance and initial bearing over tower coordinates, plus the
maintain+flood predicate that selects the at-risk set. No RF data exists in
this repo, so nothing here is a propagation calculation.

Constants pinned by test to their responsePhaseGeometry.ts copies.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Sector-split candidate selection

**Files:**
- Modify: `src/backend/model/fallback.py`
- Test: `src/backend/model/test_fallback.py`

**Interfaces:**
- Consumes: `haversine_km`, `bearing_deg`, `at_risk`, `SEARCH_RADIUS_KM`, `MAX_CANDIDATES`, `SECTOR_COUNT` (Task 1)
- Produces:
  - `partition_neighbours(subject: dict, towers: list[dict]) -> tuple[list[dict], list[dict]]` — returns `(eligible, co_hazard)`. Each entry is `{"tower_id": str, "distance_km": float, "bearing_deg": float, "_tower": dict}`. Both lists are sorted nearest-first and cover only towers within `SEARCH_RADIUS_KM`.
  - `cover_candidates(eligible: list[dict]) -> list[dict]` — up to `MAX_CANDIDATES` entries of `{"tower_id": str, "distance_km": float, "bearing_deg": float}`, one per bearing sector, nearest within each.

- [ ] **Step 1: Write the failing test**

Append to `src/backend/model/test_fallback.py`, **above** the `if __name__` block:

```python
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
```

Add `cover_candidates` and `partition_neighbours` to the import at the top of the test file:

```python
from fallback import (MAX_CANDIDATES, SEARCH_RADIUS_KM, SECTOR_COUNT, at_risk,
                      bearing_deg, cover_candidates, haversine_km,
                      partition_neighbours)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ImportError: cannot import name 'cover_candidates' from 'fallback'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/backend/model/fallback.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ok` for all 17 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/model/fallback.py src/backend/model/test_fallback.py
git commit -m "feat(model): sector-split cover-candidate selection

Ports selectRetuningNeighbors from responsePhaseGeometry.ts: the compass is
split into three sectors and the nearest eligible neighbour in each is taken,
so candidates fan around the subject instead of stacking on the dense side.

Neighbours that are themselves maintain+flood are returned as co_hazard rather
than dropped — 'three neighbours, all flooding too' and 'no neighbours at all'
are different findings.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Per-tower report, envelope, and cache

**Files:**
- Modify: `src/backend/model/fallback.py`
- Test: `src/backend/model/test_fallback.py`

**Interfaces:**
- Consumes: `partition_neighbours`, `cover_candidates`, `at_risk` (Tasks 1–2)
- Produces:
  - `nearest_other_km(subject: dict, towers: list[dict]) -> float | None` — distance to the nearest other tower at **any** distance
  - `tower_report(subject: dict, towers: list[dict]) -> dict` — `{"tower_id", "candidates", "co_hazard", "nearest_km"}`
  - `fallback_report(towers: list[dict]) -> dict` — the full envelope, pure
  - `cached_fallback_report(towers: list[dict]) -> dict` — memoised wrapper
  - `reset_cache() -> None`

- [ ] **Step 1: Write the failing test**

Append to `src/backend/model/test_fallback.py`, above the `if __name__` block:

```python
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
```

Extend the import:

```python
from fallback import (MAX_CANDIDATES, SEARCH_RADIUS_KM, SECTOR_COUNT, at_risk,
                      bearing_deg, cached_fallback_report, cover_candidates,
                      fallback_report, haversine_km, nearest_other_km,
                      partition_neighbours, reset_cache, tower_report)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ImportError: cannot import name 'nearest_other_km' from 'fallback'`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/backend/model/fallback.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd src/backend && python model/test_fallback.py
```

Expected: `ok` for all 28 tests.

- [ ] **Step 5: Commit**

```bash
git add src/backend/model/fallback.py src/backend/model/test_fallback.py
git commit -m "feat(model): cover-candidate report envelope and per-process cache

Shaped like FireExposure — a parameters block plus a towers dict — so the two
'evidence beside the score' features read alike. Only at-risk towers appear;
absence is not zero. No isolated boolean: len(candidates) == 0 says it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Real-data regression pin

**Files:**
- Create: `src/backend/model/test_fallback_realdata.py`

**Interfaces:**
- Consumes: `fallback_report` (Task 3), `fixtures.source.scored_towers`, `fixtures.source.use_fixture`
- Produces: nothing consumed by later tasks

**Why a separate file:** `test_fallback.py` is pure and runs anywhere in milliseconds. This one loads the scoring pipeline and must skip on the fixture branch. Keeping them apart means the fast suite stays fast and unconditional.

- [ ] **Step 1: Write the failing test**

Create `src/backend/model/test_fallback_realdata.py`:

```python
"""Regression pin for the cover-candidate report on the REAL estate.

    python3 src/backend/model/test_fallback_realdata.py     # or: pytest

The point is not to freeze these numbers. A genuine scoring improvement may
move them, and then this file is updated deliberately, in the same commit, with
the new figures recorded below. The point is that a change which silently
EMPTIES this feature fails loudly here instead of shipping a tab reading
"0 towers".

Skips on USE_FIXTURE=1. That population is 500 synthetic towers inside a box
roughly 14 km across, so every tower is within the 15 km search radius of every
other and isolation is structurally impossible — 35 at-risk, 0 isolated. That
is the correct answer for that estate, not a shortfall, and asserting the live
figures against it would be asserting a falsehood.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fixtures.source import scored_towers, use_fixture   # noqa: E402
from model.fallback import fallback_report                # noqa: E402

# Measured 2026-09-19 against the live Malaysian estate (1,164 towers).
EXPECTED_AT_RISK = 78
EXPECTED_ISOLATED = 12
EXPECTED_NOTHING_IN_RANGE = 7    # of the isolated, those with no neighbour at all
EXPECTED_ONLY_CO_HAZARD = 5      # of the isolated, those whose neighbours all flood

# Tolerance, because the scorer is not bit-frozen across environments. Wide
# enough to absorb a boundary tower moving band, narrow enough that a feature
# emptying itself still fails.
TOLERANCE = 3


def _skip_on_fixture(name: str) -> bool:
    if use_fixture():
        print("skip", name, "(USE_FIXTURE=1 cannot produce isolation)")
        return True
    return False


def test_at_risk_set_is_the_expected_size():
    if _skip_on_fixture("test_at_risk_set_is_the_expected_size"):
        return
    report = fallback_report(scored_towers())
    assert abs(report["at_risk_count"] - EXPECTED_AT_RISK) <= TOLERANCE, (
        f"at_risk_count {report['at_risk_count']}, expected ~{EXPECTED_AT_RISK}"
    )


def test_isolated_set_is_non_empty_and_the_expected_size():
    if _skip_on_fixture("test_isolated_set_is_non_empty_and_the_expected_size"):
        return
    report = fallback_report(scored_towers())
    assert report["isolated_count"] > 0, (
        "no isolated towers — the 'No cover' tab would render empty and the "
        "feature would silently say nothing"
    )
    assert abs(report["isolated_count"] - EXPECTED_ISOLATED) <= TOLERANCE, (
        f"isolated_count {report['isolated_count']}, expected ~{EXPECTED_ISOLATED}"
    )


def test_the_two_kinds_of_isolation_are_both_present():
    """The 7/5 split is the reason co_hazard is returned as its own list.
    Those 5 towers — neighbours within 15 km, every one of them flooding in the
    same event — are the feature's strongest single claim, and a change that
    collapsed them into the 7 would destroy it without changing any count."""
    if _skip_on_fixture("test_the_two_kinds_of_isolation_are_both_present"):
        return
    report = fallback_report(scored_towers())
    isolated = [r for r in report["towers"].values() if not r["candidates"]]
    nothing_in_range = [r for r in isolated if not r["co_hazard"]]
    only_co_hazard = [r for r in isolated if r["co_hazard"]]

    assert len(nothing_in_range) > 0, "expected some towers with no neighbour at all"
    assert len(only_co_hazard) > 0, (
        "expected some towers whose only neighbours are themselves at risk"
    )
    assert abs(len(nothing_in_range) - EXPECTED_NOTHING_IN_RANGE) <= TOLERANCE
    assert abs(len(only_co_hazard) - EXPECTED_ONLY_CO_HAZARD) <= TOLERANCE


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
```

- [ ] **Step 2: Run the test to verify it fails, then passes**

This test targets already-written code, so verify the *skip* path fails nothing and the live path actually asserts:

```bash
cd src/backend && USE_FIXTURE=1 python model/test_fallback_realdata.py
```
Expected: three `skip` lines, exit 0.

```bash
cd src/backend && python model/test_fallback_realdata.py
```
Expected: `ok` for all three.

If the live run fails, **do not widen `TOLERANCE` to make it pass.** Investigate why the at-risk set moved.

- [ ] **Step 3: Verify the pin actually bites**

Temporarily break the predicate to confirm the test is not vacuous:

```bash
cd src/backend && python -c "
import sys; sys.path.insert(0,'.')
import model.fallback as f
f.at_risk = lambda t: False
from fixtures.source import scored_towers
r = f.fallback_report(scored_towers())
print('at_risk_count with broken predicate:', r['at_risk_count'])
assert r['at_risk_count'] == 0
print('pin would catch this')
"
```
Expected: `at_risk_count with broken predicate: 0` then `pin would catch this`. No files changed.

- [ ] **Step 4: Commit**

```bash
git add src/backend/model/test_fallback_realdata.py
git commit -m "test(model): pin cover-candidate counts on the live estate

78 at-risk, 12 isolated, split 7 with no neighbour at all and 5 whose
neighbours all flood in the same event. Guards against a scoring change
silently emptying the feature.

Skips on USE_FIXTURE=1, whose AOI is ~14km across and so cannot produce
isolation at a 15km radius.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Pydantic schemas and the endpoint

**Files:**
- Modify: `src/backend/api/schemas.py`
- Modify: `src/backend/api/routes/towers.py`
- Test: `src/backend/api/test_towers_fallback.py` (create)

**Interfaces:**
- Consumes: `cached_fallback_report`, `reset_cache` (Task 3)
- Produces: `GET /towers/fallback` returning the Task 3 envelope; `towers_fallback()` callable directly for tests

- [ ] **Step 1: Write the failing test**

Create `src/backend/api/test_towers_fallback.py`:

```python
"""Route-level tests for GET /towers/fallback.

    python3 src/backend/api/test_towers_fallback.py     # or: pytest

Calls the route function directly rather than through TestClient, matching
api/test_model_health.py. The HTTP layer adds nothing this feature needs
covered — there is no request body, no query parameter and no error branch.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from api.routes import towers as route      # noqa: E402
from model.fallback import reset_cache      # noqa: E402


def test_endpoint_returns_the_envelope_shape():
    reset_cache()
    payload = route.towers_fallback()
    assert set(payload) == {
        "generated_at", "parameters", "at_risk_count", "isolated_count", "towers",
    }


def test_endpoint_describes_the_same_population_towers_serves():
    """Both derive from fixtures/source.scored_towers(), which is the one place
    the USE_FIXTURE branch is decided. A report describing a different estate
    than /towers serves is exactly the drift that module exists to prevent."""
    reset_cache()
    served = {t["tower_id"] for t in route.get_towers()}
    reported = set(route.towers_fallback()["towers"])
    assert reported <= served, reported - served


def test_endpoint_reports_only_at_risk_towers():
    reset_cache()
    by_id = {t["tower_id"]: t for t in route.get_towers()}
    for tower_id in route.towers_fallback()["towers"]:
        t = by_id[tower_id]
        assert t["decision"] == "maintain"
        assert t["dominant_factor"] == "flood"


def test_endpoint_payload_is_json_serialisable():
    """pydantic is not in this path — the route returns a plain dict — so
    nothing will catch a stray numpy scalar except this."""
    import json
    reset_cache()
    json.dumps(route.towers_fallback())


def test_endpoint_is_cached_across_calls():
    reset_cache()
    first = route.towers_fallback()
    assert route.towers_fallback() is first


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd src/backend && python api/test_towers_fallback.py
```

Expected: `AttributeError: module 'api.routes.towers' has no attribute 'towers_fallback'`.

- [ ] **Step 3: Add the schemas**

Append to `src/backend/api/schemas.py`:

```python
class CoverCandidate(BaseModel):
    """A neighbour that could plausibly be asked to help cover a tower's area.

    CANDIDATE FOR RF PLANNING TO CONFIRM, never a configuration. `bearing_deg`
    is the initial great-circle bearing to that neighbour — a direction to a
    PLACE, not an antenna azimuth. This repo holds no azimuth, height, EIRP,
    band or sector data for any tower.
    """

    tower_id: str
    distance_km: float
    bearing_deg: float


class CoHazardNeighbour(BaseModel):
    """A neighbour inside the search radius that is ITSELF flood-exposed, and
    so cannot be counted on. Returned explicitly rather than filtered away:
    "three neighbours, all of them flooding too" is a different and sharper
    finding than "no neighbours at all"."""

    tower_id: str
    distance_km: float


class TowerFallback(BaseModel):
    """One at-risk tower's cover picture.

    No `isolated` field by design — `len(candidates) == 0` says it, and a
    boolean beside the list it summarises can drift out of agreement with it.
    """

    tower_id: str
    candidates: list[CoverCandidate]
    co_hazard: list[CoHazardNeighbour]
    # Nearest other tower at ANY distance, not capped at the search radius and
    # counting co-hazard towers. None only for a single-tower estate.
    nearest_km: float | None


class FallbackParameters(BaseModel):
    search_radius_km: float
    max_candidates: int
    sector_count: int
    at_risk_rule: str
    basis: str


class FallbackReport(BaseModel):
    """`towers` holds ONLY at-risk towers. A tower absent from it is not at
    risk; it is never present with empty lists."""

    generated_at: str
    parameters: FallbackParameters
    at_risk_count: int
    isolated_count: int
    towers: dict[str, TowerFallback]
```

> **Declare every field.** This file already carries the warning learned on the fire evidence: pydantic silently DROPS any key a model does not name. An undeclared field does not error — it vanishes between the backend and the browser.

- [ ] **Step 4: Add the route**

In `src/backend/api/routes/towers.py`, extend the import block:

```python
from fixtures.source import scored_towers, scored_towers_with_weights
from model.fallback import cached_fallback_report
```

and append the route at the end of the file:

```python
@router.get("/towers/fallback")
def towers_fallback() -> dict:
    """Which flood-exposed towers have a neighbour that could stand in, and
    which have none. Geometry only — see model/fallback.py.

    Derived from scored_towers(), NOT a second source: fixtures/source.py is the
    one place the USE_FIXTURE branch is decided, and a cover report describing a
    different tower population than /towers serves is exactly the drift that
    module's docstring exists to prevent.

    Returns a plain dict rather than the FallbackReport model. The model is
    declared in api/schemas.py for the frontend contract and for anything that
    wants to validate the payload; annotating it here would make FastAPI
    re-validate ~78 nested records on a response that is already cached and
    already shaped by one function. /towers does the same.
    """
    return cached_fallback_report(scored_towers())
```

> **Route ordering:** FastAPI matches in declaration order, but `/towers` declares no path parameter, so `/towers/fallback` cannot be swallowed by it. No reordering needed. No change to `api/main.py` either — `towers.router` is already registered at `main.py:60`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd src/backend && python api/test_towers_fallback.py
```
Expected: `ok` for all five.

```bash
cd src/backend && USE_FIXTURE=1 python api/test_towers_fallback.py
```
Expected: `ok` for all five (the fixture branch has 35 at-risk towers, so these assertions still hold).

- [ ] **Step 6: Verify the endpoint over HTTP**

```bash
cd src/backend && uvicorn api.main:app --port 8001 &
sleep 5
curl -s localhost:8001/towers/fallback | python -c "
import json,sys
d=json.load(sys.stdin)
print('at_risk', d['at_risk_count'], 'isolated', d['isolated_count'])
print('basis:', d['parameters']['basis'])
"
kill %1
```
Expected: `at_risk 78 isolated 12` and the basis line naming "no antenna data".

- [ ] **Step 7: Run the whole backend suite**

```bash
cd src/backend && pytest -q
```
Expected: no new failures.

- [ ] **Step 8: Commit**

```bash
git add src/backend/api/schemas.py src/backend/api/routes/towers.py src/backend/api/test_towers_fallback.py
git commit -m "feat(api): GET /towers/fallback

Serves the cover-candidate report over the same scored_towers() source /towers
uses, so the two can never describe different tower populations.

Schemas declare every field — pydantic silently drops undeclared keys, which
already cost this codebase the fire evidence once.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Frontend types, client, and query hook

**Files:**
- Modify: `src/frontend/src/api/types.ts`
- Modify: `src/frontend/src/api/client.ts`
- Modify: `src/frontend/src/api/queries.ts`

**Interfaces:**
- Consumes: `GET /towers/fallback` (Task 5)
- Produces:
  - `CoverCandidate`, `CoHazardNeighbour`, `TowerFallback`, `FallbackReport` (types)
  - `client.getTowerFallback(): Promise<FallbackReport>`
  - `useTowerFallbackQuery(): UseQueryResult<FallbackReport | null>`

- [ ] **Step 1: Add the types**

Append to `src/frontend/src/api/types.ts`:

```ts
/**
 * A neighbour that could plausibly be asked to help cover an at-risk tower.
 *
 * INPUT FOR AN RF PLANNER, never a configuration. `bearing_deg` is the initial
 * great-circle bearing to that neighbour — a direction to a place, not an
 * antenna azimuth. This product holds no azimuth, antenna height, EIRP, band
 * or sector data for any tower, so no surface may render this as an
 * engineering instruction.
 *
 * Mirrors CoverCandidate in src/backend/api/schemas.py.
 */
export interface CoverCandidate {
  tower_id: string;
  distance_km: number;
  bearing_deg: number;
}

/**
 * A neighbour inside the search radius that is itself flood-exposed.
 *
 * Carried separately from `candidates` rather than filtered away, because
 * "three neighbours, all of them flooding too" and "no neighbours at all" are
 * different findings — 5 towers and 7 towers respectively on the live estate.
 */
export interface CoHazardNeighbour {
  tower_id: string;
  distance_km: number;
}

export interface TowerFallback {
  tower_id: string;
  /** 0-3. Empty is a real answer and the feature's headline finding. */
  candidates: CoverCandidate[];
  co_hazard: CoHazardNeighbour[];
  /**
   * Nearest other tower at ANY distance — not capped at the search radius, and
   * counting co-hazard towers. Answers "how alone is this site physically",
   * which is a different question from "who could cover it". Null only for a
   * single-tower estate.
   */
  nearest_km: number | null;
}

/**
 * Which flood-exposed towers have a neighbour that could stand in for them.
 *
 * `towers` holds ONLY at-risk towers (the model's maintain band, narrowed to
 * flood-dominant). A tower absent from the map is NOT at risk — it is never
 * present with empty lists, so absence must not be rendered as a reading.
 *
 * Mirrors FallbackReport in src/backend/api/schemas.py.
 */
export interface FallbackReport {
  generated_at: string;
  parameters: {
    search_radius_km: number;
    max_candidates: number;
    sector_count: number;
    at_risk_rule: string;
    basis: string;
  };
  at_risk_count: number;
  isolated_count: number;
  towers: Record<string, TowerFallback>;
}
```

- [ ] **Step 2: Add the client method**

Append to `src/frontend/src/api/client.ts` (near `getTowers`):

```ts
/**
 * Which flood-exposed towers have a cover candidate and which have none.
 *
 * Derived from the same scored population /towers serves, so the two always
 * describe the same estate. Throws on non-2xx like every other plain route —
 * unlike getFireExposure, this endpoint has no legitimate 503 state, because
 * it reads towers the backend already holds and depends on no external
 * archive or credential.
 */
export function getTowerFallback(): Promise<FallbackReport> {
  return request<FallbackReport>('/towers/fallback');
}
```

Add `FallbackReport` to the existing `import type { ... } from './types'` list at the top of the file.

- [ ] **Step 3: Add the query hook**

Append to `src/frontend/src/api/queries.ts`:

```ts
/**
 * The cover-candidate report, or null when the backend could not be reached.
 *
 * Uses `withOfflineFallback`, UNLIKE `useFireExposureQuery` directly above.
 * That query opts out because it answers non-2xx during completely normal
 * operation — 503 on any date VIIRS has no granule for, 503 with no Earth
 * Engine credentials — so routing it through the shared helper once flipped
 * the entire console to OFFLINE while every other route served live data.
 *
 * This endpoint has no such state. It reads towers the backend already holds,
 * depends on no external archive and no credentials, and is computed once per
 * process. A non-2xx here means the backend genuinely is unreachable, so
 * setting the offline flag is the honest reading.
 *
 * The fallback value is `null`, never an empty report. An empty report would
 * render "no towers lack cover" — a claim. Null means "we could not ask", and
 * every consumer renders nothing for it.
 */
export function useTowerFallbackQuery() {
  return useQuery<FallbackReport | null>({
    queryKey: ['tower-fallback'],
    queryFn: () => withOfflineFallback(() => client.getTowerFallback(), null),
    staleTime: Infinity,
    ...useRecovery(),
  });
}
```

Add `FallbackReport` to the existing type import in `queries.ts`.

> Match the surrounding call sites for `useRecovery()` — check how `useTowersQuery` at `queries.ts:78` spreads it and copy that exactly. If the neighbouring queries do not spread `useRecovery()`, omit it here too.

- [ ] **Step 4: Verify it compiles and lints**

```bash
cd src/frontend && npm run build && npm run lint
```
Expected: both exit 0. `tsc -b` is the real check here — there is no unit test for plumbing.

- [ ] **Step 5: Verify the data actually arrives**

Start both ends (`make dev` from the repo root, or the two commands in CLAUDE.md), open the app, and in the browser console:

```js
await (await fetch('/api/towers/fallback')).json()
```
Expected: an object with `at_risk_count: 78`, `isolated_count: 12`.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/api/types.ts src/frontend/src/api/client.ts src/frontend/src/api/queries.ts
git commit -m "feat(api-client): types, client method and query for the cover report

Falls back to null rather than an empty report: an empty report would render
'no towers lack cover', which is a claim. Null means we could not ask.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Investigation list — the pitch surface

**Files:**
- Modify: `src/frontend/src/pages/Investigation.tsx` (lines 33, 34, 94–99, 188, 214, ~256)

**Interfaces:**
- Consumes: `useTowerFallbackQuery` (Task 6)
- Produces: nothing consumed by later tasks

**This is the task the pitch depends on.** After it, the product can be demonstrated.

- [ ] **Step 1: Wire the query and build a lookup**

In `src/frontend/src/pages/Investigation.tsx`, add to the imports:

```tsx
import { useTowerFallbackQuery } from '../api/queries';
```

Inside the component, after the existing `const { towers, isLoading } = useLiveTowers(weights);`:

```tsx
// Cover candidates, joined on tower_id. Null while the query is in flight or
// the backend is unreachable — the list then shows no cover line at all,
// rather than reporting a fetch in progress as "no cover".
const { data: fallbackReport } = useTowerFallbackQuery();
const fallbackByTower = fallbackReport?.towers ?? null;
```

- [ ] **Step 2: Extend the two enums**

Line 33:
```tsx
type FilterTab = 'ALL' | 'MAINTAIN' | 'WATCH' | 'OK' | 'UNSCHEDULED' | 'ISOLATED';
```

Line 34:
```tsx
type SortOption = 'RISK_DESC' | 'URGENCY_ASC' | 'RISK_ASC' | 'ID_ASC' | 'EXPOSURE_DESC';
```

- [ ] **Step 3: Add the filter branch**

In the `filteredTowers` `useMemo`, beside the existing `if (filterTab === 'UNSCHEDULED') return unscheduled;`:

```tsx
// Flood-exposed towers with no neighbour that could stand in. Empty while the
// report is loading — an unanswered query must not present as "none isolated".
if (filterTab === 'ISOLATED') {
    const record = fallbackByTower?.[tower.tower_id];
    return record !== undefined && record.candidates.length === 0;
}
```

Add `fallbackByTower` to that `useMemo`'s dependency array.

- [ ] **Step 4: Add the sort branch**

In the same `useMemo`'s `.sort(...)` callback, beside the existing comparators:

```tsx
if (sortBy === 'EXPOSURE_DESC') {
    // Isolated first, then thinnest cover, then highest risk as the tiebreak.
    // Towers with no record are not at risk and sort last — Infinity rather
    // than a sentinel so they never interleave with a real candidate count.
    const ca = fallbackByTower?.[a.tower_id]?.candidates.length ?? Infinity;
    const cb = fallbackByTower?.[b.tower_id]?.candidates.length ?? Infinity;
    if (ca !== cb) return ca - cb;
    return b.risk - a.risk;
}
```

- [ ] **Step 5: Add the tab and the sort option**

Line 188, extend the tab array:

```tsx
{(['ALL', 'MAINTAIN', 'WATCH', 'OK', 'UNSCHEDULED', 'ISOLATED'] as FilterTab[]).map((tab) => {
```

The button renders `{tab}`, which would print `ISOLATED`. Give it a label map instead. Add above the `return` of the component:

```tsx
// 'ISOLATED' is the enum key; "No cover" is what it means to a planner.
const FILTER_LABELS: Record<FilterTab, string> = {
    ALL: 'ALL', MAINTAIN: 'MAINTAIN', WATCH: 'WATCH', OK: 'OK',
    UNSCHEDULED: 'UNSCHEDULED', ISOLATED: 'NO COVER',
};
```

and change the button body from `{tab}` to `{FILTER_LABELS[tab]}`.

Line 214, add the option:

```tsx
<option value="EXPOSURE_DESC">Least cover</option>
```

- [ ] **Step 6: Add the row line**

In the list item, inside the existing secondary info bar (`{tScored && (...)}` around line 281), append a third element after the urgency span:

```tsx
{(() => {
    const record = fallbackByTower?.[t.tower_id];
    if (!record) return null;
    return record.candidates.length === 0 ? (
        <span className="text-alert-ink font-semibold">⚠ no cover</span>
    ) : (
        <span className="text-dim">{record.candidates.length} nearby</span>
    );
})()}
```

> The existing bar uses `justify-between` with two children. Adding a third is fine — it will space three ways. If it reads cramped at the 300px sidebar width, change that container to `gap-2` with `flex-wrap` rather than shortening the copy.

- [ ] **Step 7: Verify**

```bash
cd src/frontend && npm run build && npm run lint
```
Expected: both exit 0.

Then browser-check on the **live** backend (not `USE_FIXTURE=1`):

1. "NO COVER" tab shows **12 sites found**.
2. "Least cover" sort puts `⚠ no cover` rows at the top.
3. Rows outside the at-risk set show neither marker.
4. Reload with the backend stopped: no cover markers anywhere, no "0 nearby" anywhere.

Then browser-check on `USE_FIXTURE=1`: the "NO COVER" tab shows **0 sites found**. That is correct for that estate (§3.4 of the spec), not a bug.

- [ ] **Step 8: Commit**

```bash
git add src/frontend/src/pages/Investigation.tsx
git commit -m "feat(investigation): 'No cover' filter and 'Least cover' sort

Puts flood-exposed towers with no standing-in neighbour at the top of the
namelist. A tower can now outrank another of equal risk because nobody would
absorb its loss — a distinction proximity alone cannot make.

Absent report renders no marker at all, never '0 nearby'.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: FallbackPanel

**Files:**
- Create: `src/frontend/src/components/investigation/FallbackPanel.tsx`
- Modify: `src/frontend/src/components/investigation/index.ts`
- Modify: `src/frontend/src/pages/Investigation.tsx` (~line 438)

**Interfaces:**
- Consumes: `useTowerFallbackQuery` (Task 6), `Panel` from `../ui/Panel`, `Tower` type
- Produces: `FallbackPanel({ tower }: { tower: Tower })`

- [ ] **Step 1: Write the component**

Create `src/frontend/src/components/investigation/FallbackPanel.tsx`:

```tsx
import { Panel } from '../ui/Panel';
import { useTowerFallbackQuery } from '../../api/queries';
import type { Tower } from '../../api/types';

interface Props {
    tower: Tower;
}

/**
 * If this tower fails, who could stand in — next to, never inside, its score.
 *
 * Cover candidacy is not one of the model's features, carries no attribution
 * share, and this tower's `risk`, `priority`, `decision` and `attribution`
 * would be identical with this panel switched off. That is why it sits outside
 * ModelTransparencyPanel rather than as a row inside it: position is the first
 * claim a card makes, and a cover row among factor rows would read as another
 * factor before anybody reached the words saying it is not. Same reasoning as
 * FireExposurePanel, which this is modelled on.
 *
 * GEOMETRY, NOT RF. Distance and initial bearing between known coordinates.
 * This product holds no azimuth, antenna height, EIRP, band or sector data —
 * `radio` is UNKNOWN for 1,119 of 1,164 towers — so a bearing here is a
 * direction to a place and never an antenna instruction. The footnote says so
 * on every state, because the number and its caveat must never be separable.
 *
 * Colourless, for the reason EnsembleSignalPanel and FireExposurePanel are:
 * lib/colors.ts owns the severity ramp and a reading painted on it claims a
 * severity it does not have. The one exception is the two isolated states,
 * which may use `alert` — those genuinely ARE a severity statement, about
 * consequence rather than condition.
 *
 * Four resolved states, none of which may collapse into another: not at risk;
 * alone; surrounded but every neighbour floods too; covered. Renders nothing
 * at all while the query is in flight — an "unavailable" line there would
 * report a fetch in progress as an answer.
 */
export function FallbackPanel({ tower }: Props) {
    const { data, isPending } = useTowerFallbackQuery();
    if (isPending) return null;

    const record = data?.towers[tower.tower_id] ?? null;
    // State 1: absent from the report means NOT AT RISK, which is not a finding
    // about cover and must not be rendered as one.
    if (!record) return null;

    const radiusKm = data?.parameters.search_radius_km ?? 15;
    const footnote =
        `Geometry only — distance and direction between towers within ${radiusKm} km. ` +
        'No antenna data. Candidates for RF planning to confirm.';

    const isolated = record.candidates.length === 0;

    return (
        <Panel
            title="If it fails"
            footnote={footnote}
            hint={
                'Which nearby towers could plausibly be asked to help cover this area if this ' +
                'site goes down, worked out before any event. Great-circle geometry over tower ' +
                'coordinates — not a propagation, capacity or antenna-tilt calculation, none of ' +
                'which this dataset supports. Neighbours that are themselves flood-exposed are ' +
                'listed separately, because they cannot be counted on in the same event.'
            }
        >
            {isolated ? (
                <div className="space-y-2">
                    <p className="text-body font-semibold text-alert-ink">
                        Nobody covers this.
                    </p>
                    {record.co_hazard.length > 0 ? (
                        // State 3: the sharper finding. Neighbours exist, and every
                        // one of them is expected under the same water.
                        <p className="text-ui text-muted">
                            {record.co_hazard.length}{' '}
                            {record.co_hazard.length === 1 ? 'tower' : 'towers'} within{' '}
                            {radiusKm} km — all of them flood in the same event.
                        </p>
                    ) : (
                        // State 2: physically alone.
                        <p className="text-ui text-muted">
                            No other tower within {radiusKm} km.
                            {record.nearest_km !== null && (
                                <> Nearest is <span className="tnum text-fg">{record.nearest_km} km</span> away.</>
                            )}
                        </p>
                    )}
                </div>
            ) : (
                // State 4: covered.
                <div className="space-y-2">
                    <ul className="space-y-1">
                        {record.candidates.map((c) => (
                            <li
                                key={c.tower_id}
                                className="flex items-baseline justify-between gap-3 text-ui"
                            >
                                <span className="truncate font-mono text-fg">{c.tower_id}</span>
                                <span className="shrink-0 tnum text-muted">
                                    {c.distance_km} km · {Math.round(c.bearing_deg)}°
                                </span>
                            </li>
                        ))}
                    </ul>
                    {record.co_hazard.length > 0 && (
                        <p className="border-t border-overlay/10 pt-2 text-micro text-dim">
                            {record.co_hazard.length} further{' '}
                            {record.co_hazard.length === 1 ? 'tower' : 'towers'} nearby, but
                            flood-exposed in the same event — not counted above.
                        </p>
                    )}
                </div>
            )}
        </Panel>
    );
}
```

- [ ] **Step 2: Export it**

Append to `src/frontend/src/components/investigation/index.ts`:

```ts
export { FallbackPanel } from './FallbackPanel';
```

- [ ] **Step 3: Mount it**

In `src/frontend/src/pages/Investigation.tsx`, add `FallbackPanel` to the existing import from `'../components/investigation'`, then mount it directly after `<FireExposurePanel tower={activeTower} />` (~line 438):

```tsx
{/*
  Beside the score, not inside it — the same placement argument
  FireExposurePanel makes above. Cover candidacy is not a factor, carries
  no attribution share, and this tower's risk and decision are identical
  with it switched off.
*/}
<FallbackPanel tower={activeTower} />
```

- [ ] **Step 4: Verify**

```bash
cd src/frontend && npm run build && npm run lint
```
Expected: both exit 0.

Browser-check all four states against the **live** backend. Use the "NO COVER" tab from Task 7 to find the isolated towers quickly:

| state | how to reach it | expect |
|---|---|---|
| 1 not at risk | select any `ok`-band tower | panel absent entirely |
| 2 alone | a "NO COVER" tower whose panel shows no co-hazard line | "Nobody covers this." + "Nearest is N km away." |
| 3 all flood | one of the 5 — "NO COVER" towers that DO show a co-hazard line | "Nobody covers this." + "N towers within 15 km — all of them flood in the same event." |
| 4 covered | a maintain+flood tower not in the NO COVER tab | 1–3 rows, each `id · km · bearing°` |

Also confirm the footnote is visible in every rendered state, and stop the backend to confirm the panel disappears rather than claiming anything.

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/investigation/FallbackPanel.tsx src/frontend/src/components/investigation/index.ts src/frontend/src/pages/Investigation.tsx
git commit -m "feat(investigation): FallbackPanel

Four states that never collapse into one another: not at risk, alone,
surrounded but every neighbour floods too, covered. The third is the finding —
a site that looks well connected and is not.

Geometry-only footnote renders on every state, so no distance or bearing is
ever separable from its caveat.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: Overview map ring

**Files:**
- Modify: `src/frontend/src/components/map/towerLayer.ts`
- Modify: `src/frontend/src/components/map/MapView.tsx`

**Interfaces:**
- Consumes: `useTowerFallbackQuery` (Task 6), `towersToGeoJSON` (existing)
- Produces: `ISOLATED_RING_SOURCE_ID`, `ISOLATED_RING_LAYER_ID`, `isolatedRingPaint`

- [ ] **Step 1: Add the layer constants and paint**

Append to `src/frontend/src/components/map/towerLayer.ts`:

```ts
export const ISOLATED_RING_SOURCE_ID = 'towers-isolated';
export const ISOLATED_RING_LAYER_ID = 'towers-isolated-ring';

/**
 * A ring around flood-exposed towers that no neighbour could stand in for.
 *
 * Deliberately NOT a band colour. CLAUDE.md gives lib/colors.ts exactly one
 * job — the tower severity triad — and a ring drawn in one of those three
 * hues would read as a fourth band. This is a different KIND of statement
 * (about consequence, not condition), so it gets a different visual language:
 * an unfilled stroked circle, wider than the band halo it surrounds.
 *
 * Its own layer rather than a filter change: CLAUDE.md requires towers-layer
 * and towers-icon-layer to move together, and the safest way to honour that is
 * to touch neither. This layer is added BENEATH the band halo so decoration
 * never outranks data — the same ordering rule the icon-confetti fix
 * established.
 */
export const isolatedRingPaint: CircleLayerSpecification['paint'] = {
  'circle-radius': 13,
  'circle-color': 'transparent',
  'circle-stroke-width': 1.5,
  'circle-stroke-color': 'rgba(255,255,255,0.55)',
  'circle-stroke-opacity': 0.9,
};
```

> `CircleLayerSpecification` is already imported at the top of this file for `towerPaint`. If it is not, add it to the existing `maplibre-gl` type import.

- [ ] **Step 2: Mount and feed the layer**

In `src/frontend/src/components/map/MapView.tsx`:

1. Import `useTowerFallbackQuery`, plus the three new constants and `towersToGeoJSON`.
2. Where the existing tower source and layers are added, add the ring **before** (i.e. beneath) `TOWER_LAYER_ID`:

```tsx
map.addSource(ISOLATED_RING_SOURCE_ID, { type: 'geojson', data: emptyFeatureCollection() });
map.addLayer({
  id: ISOLATED_RING_LAYER_ID,
  type: 'circle',
  source: ISOLATED_RING_SOURCE_ID,
  paint: isolatedRingPaint,
}, TOWER_LAYER_ID);   // third arg = insert BEFORE this layer, i.e. underneath it
```

3. Add an effect feeding it:

```tsx
// Ring the flood-exposed towers nothing could stand in for. Empty — never a
// partial set — while the report is unavailable: a ring is an assertion, and
// drawing none is the correct output for "we could not ask".
const { data: fallbackReport } = useTowerFallbackQuery();
useEffect(() => {
  const map = mapRef.current;
  if (!map || !ready) return;
  const source = map.getSource(ISOLATED_RING_SOURCE_ID);
  if (!source || !('setData' in source)) return;
  const isolated = fallbackReport
    ? towers.filter((t) => fallbackReport.towers[t.tower_id]?.candidates.length === 0)
    : [];
  (source as GeoJSONSource).setData(towersToGeoJSON(isolated));
}, [ready, towers, fallbackReport]);
```

> Match the surrounding file's own idioms for `mapRef`, `ready`, `emptyFeatureCollection` and `GeoJSONSource` — read the neighbouring effects in `MapView.tsx` and copy their shape rather than the names used here, which are indicative.

- [ ] **Step 3: Verify**

```bash
cd src/frontend && npm run build && npm run lint
```
Expected: both exit 0.

Browser-check on the live backend:

1. 12 rings appear on the Overview map.
2. Each ring sits **behind** its band halo — the halo colour is not obscured.
3. Zoom past z13.5 so tower icons appear: rings still sit beneath both.
4. Toggle a band filter in `BandModule`: **existing behaviour must be unchanged.** Rings are a separate layer and are expected to stay put; if that looks wrong in review, that is a design question to raise, not a filter to add here.
5. Switch to the light theme: the white stroke must still be visible. If it is not, make the stroke colour theme-aware rather than darkening it unconditionally.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/components/map/towerLayer.ts src/frontend/src/components/map/MapView.tsx
git commit -m "feat(map): ring flood-exposed towers with no cover candidate

A stroked ring, not a band colour — lib/colors.ts owns the severity triad and a
fourth hue there would read as a fourth band. Added beneath the band halo as
its own layer, so neither existing tower layer's filter is touched.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 10: Simulation reword

**Files:**
- Modify: `src/frontend/src/components/simulation/SimulationLegend.tsx`
- Modify: `src/frontend/src/components/investigation/FallbackPanel.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: nothing

**Copy only. No logic, no geometry, no animation change.** The cones keep swinging — the animation communicates the concept well and its own doc comment at `SimulationMap.tsx:659` already labels the bearing illustrative. What changes is that no *number shown to a viewer* is a fabricated azimuth.

- [ ] **Step 1: Find every user-visible bearing**

```bash
cd src/frontend && grep -rn "bearing\|azimuth\|°" src/components/simulation/*.tsx
```

Review each hit. A bearing used to *compute polygon geometry* stays. A bearing *rendered as text to the viewer* must go.

- [ ] **Step 2: Replace rendered bearings**

For each text hit found in Step 1, replace the degree readout with the count of retuning neighbours already available in that component's scope. If no bearing is rendered as text anywhere, **record that in the commit message and change nothing** — the audit is the deliverable.

Where the legend describes the cones, make the disclaimer explicit:

```tsx
// Illustrative geometry — see SimulationMap.tsx. The swing direction is
// computed, but this project holds no sector azimuths, so no degree value is
// shown to the viewer as though it were an engineering output.
```

- [ ] **Step 3: Link the panel to the simulation**

In `FallbackPanel.tsx`, inside the isolated branch, after the explanatory paragraph:

```tsx
<Link
    to="/simulation"
    className="inline-block rounded text-micro font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
>
    See what an outage here looks like →
</Link>
```

Add `import { Link } from 'react-router-dom';` at the top of `FallbackPanel.tsx`.

- [ ] **Step 4: Verify**

```bash
cd src/frontend && npm run build && npm run lint
```
Expected: both exit 0.

Browser-check: run the simulation to the `antenna-retune` beat and confirm no degree value is printed anywhere in the console, legend or summary. Then confirm the panel's link navigates to `/simulation`.

- [ ] **Step 5: Final full verification**

```bash
cd src/backend && python model/test_fallback.py && python model/test_fallback_realdata.py && python api/test_towers_fallback.py && pytest -q
```

```bash
cd src/frontend && npm run build && npm run lint
for f in src/lib/*.test.mjs; do node --experimental-strip-types --test "$f"; done
```
Expected: 143 frontend lib tests still pass (this plan adds none there — `responsePhaseGeometry.ts` is untouched).

Then walk the spec's §13 success criteria one by one and confirm each.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/components/simulation src/frontend/src/components/investigation/FallbackPanel.tsx
git commit -m "refactor(simulation): stop showing invented bearings to the viewer

The cones and their swing are unchanged — the animation is a good picture of
Cell Outage Compensation. What changes is that no degree value is presented as
though it were an engineering output, since this project holds no sector
azimuths.

Links the Investigation cover panel to the simulation, so the reactive view
becomes the proof of the predictive finding rather than a feature of its own.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task:

| spec § | requirement | task |
|---|---|---|
| 3.1 | at-risk predicate | 1 |
| 3.2 steps 1–2 | partition by radius and co-hazard | 2 |
| 3.2 step 3 | sector-split selection | 2 |
| 3.2 step 4 | unbounded `nearest_km` | 3 |
| 3.3 | measured counts | 4 |
| 3.4 | fixture branch produces nothing; skip logic | 4, 7 |
| 5.1–5.2 | envelope and field rules | 3, 5 |
| 5.3 | naming constraint | Global Constraints |
| 6.1 | module, constants, docstring | 1–3 |
| 6.2 | cache | 3 |
| 6.3 | route | 5 |
| 6.4 | schemas, declare every field | 5 |
| 7.1 | plumbing, `withOfflineFallback` rationale | 6 |
| 7.2 | three additive edits | 7 |
| 7.3 | four panel states, colour rule, footnote | 8 |
| 7.4 | ring, three constraints | 9 |
| 7.5 | simulation reword | 10 |
| 8 | absent states | 3, 6, 7, 8, 9 |
| 9.1 | nine unit cases | 1–3 |
| 9.2 | real-data regression | 4 |
| 9.3 | build, lint, browser check both branches | 7–10 |
| 11 | terrain LoS — documented, not built | none, by design |

No gaps. §11 is intentionally unimplemented and the spec says so.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no "write tests for the above". Three steps delegate to surrounding code rather than prescribing it — Task 6 Step 3 (`useRecovery()` spread), Task 9 Step 2 (`MapView` idioms), Task 10 Step 2 (which bearings are rendered). Each says explicitly what to read and what to do with it, because inventing those names here would be worse than pointing at the file that owns them.

**Type consistency.** Checked across tasks: `at_risk`, `partition_neighbours`, `cover_candidates`, `nearest_other_km`, `tower_report`, `fallback_report`, `cached_fallback_report`, `reset_cache` are spelled identically in every definition, import, test and call site. The `_tower` back-reference is introduced in Task 2 and explicitly stripped in the same task, with a test asserting it. `FallbackReport.towers` is `Record<string, TowerFallback>` in TypeScript and `dict[str, TowerFallback]` in pydantic. `candidates.length === 0` is the isolation test in Tasks 7, 8 and 9 — never a boolean field, matching Task 3's decision.

One deviation from the spec worth noting: the spec §6.1 lists `fallback_report` as the cached entry point. This plan splits it into a pure `fallback_report` plus `cached_fallback_report`, because a cache inside the pure function would make it untestable for determinism. Task 3's tests cover both.
