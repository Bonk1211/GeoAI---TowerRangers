"""Unit tests for per-tower fire screening — the body, and the two failure modes.

Network-free by construction. `_exposure_body` is pure and is split out of
`screen_towers` for exactly this reason, so every rule the feature exists for is
checkable without credentials: that a quiet fleet is a populated body rather than
an error, that no tower is ever written with a zero count, and that an unknown
source age counts as stale. The paths that do reach Earth Engine are exercised
with `initialise` swapped out in a try/finally — the same in-place swap
api/test_model_health.py uses on REPORT_PATH — because this machine may well have
working credentials, and a test that quietly succeeds against the live archive is
not a unit test.

The two facts no credential-free test can measure — that the reduction is
unweighted and that it is pinned to the collection's own projection — are
asserted against the AST of the call rather than the text of the function, since
the docstring above that call explains both using the same words.

Run from src/backend:  python3 thermal/test_thermal_exposure.py   (or via pytest)
"""

import ast
import inspect
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import MagicMock

_BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_BACKEND))

from scheduler.optimize import haversine_km  # one haversine in this repo, not three
from thermal import exposure
from thermal.exposure import (
    SCREEN_BUFFER_M,
    SNAPSHOT_TTL_SECONDS,
    STALE_AFTER_HOURS,
    FireSnapshot,
    _age_hours,
    _exposure_body,
    _snapshot_id,
    _tower_buffers,
    screen_towers,
    snapshot_for,
)
from thermal.layers import BY_ID, FIRE_LOOKBACK_DAYS, VIIRS_SCALE_M
from tiles.engine import InvalidDate, LayerUnavailable, window_for

_NOW = datetime(2026, 9, 11, 12, 0, 0, tzinfo=timezone.utc)

# Three towers spread across the screening bbox, so a latitude-dependent
# geometry mistake has somewhere to show up.
_TOWERS = [
    {"tower_id": "MY_1", "lon": 101.61, "lat": 3.07},
    {"tower_id": "MY_2", "lon": 103.76, "lat": 1.49},
    {"tower_id": "MY_3", "lon": 117.89, "lat": 4.24},
]


def _snapshot(latest: str | None = "2026-09-10T06:59:00Z", date: str = "2026-09-11") -> FireSnapshot:
    """A resolved window with two granules — the ordinary case, not three.

    The archive normally has no granule for the current UTC day until well into
    the working day, so a 2-granule window is a normal answer rather than a
    degraded one, and nothing here may assume otherwise.
    """
    start, end = window_for(date, FIRE_LOOKBACK_DAYS)
    return FireSnapshot(
        snapshot_id="viirs-2026-09-11-09715ed2147d",
        date=date,
        window_start=start,
        window_end=end,
        granules=2,
        granule_ids=("2026252", "2026253"),
        latest_acquisition=latest,
        built_at="2026-09-11T09:00:00Z",
    )


def _observation(tower_id: str, pixel_days, confidence=1, at: str = "2026-09-10T06:59:00Z") -> dict:
    """One reduceRegions feature's properties, in the shape getInfo returns them."""
    epoch = datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    return {
        "tower_id": tower_id,
        "pixel_days_sum": pixel_days,
        "max_conf_max": confidence,
        "latest_epoch_max": epoch,
    }


def _reduce_regions_keywords() -> dict[str, str]:
    """The keyword arguments of the reduceRegions call, as unparsed source.

    Parsed rather than grepped: the docstring immediately above that call
    explains why `.unweighted()` and `crs` are there and uses both words
    verbatim, so a substring check would keep passing on the prose alone after
    the call itself had lost them — which is the failure this whole file is
    arranged around.
    """
    tree = ast.parse(inspect.getsource(exposure._reduce_over_towers))
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and getattr(node.func, "attr", "") == "reduceRegions":
            return {keyword.arg: ast.unparse(keyword.value) for keyword in node.keywords}
    raise AssertionError("_reduce_over_towers no longer calls reduceRegions")


def test_a_quiet_fleet_is_a_populated_body_not_an_error():
    """"We asked and it is quiet" is a measurement and must look like one.

    None means "we could not ask". These two must never collapse: an empty
    `towers` map rendered as "no fire near this tower" when screening was
    actually unavailable is the zeroed-struct failure in its most dangerous
    form.
    """
    body = _exposure_body(_snapshot(), _TOWERS, [], now=_NOW)
    assert body is not None
    assert body["towers"] == {}
    assert body["towers_with_detections"] == 0
    assert body["screened_towers"] == len(_TOWERS)
    assert body["granules"] == 2
    assert body["snapshot_id"] == "viirs-2026-09-11-09715ed2147d"


def test_no_tower_is_ever_written_with_zero_pixel_days():
    """Absence from the map is what "screened, nothing reported" looks like.

    A zero would read as a measurement of quiet ground, and every consumer's
    `if tower_id in towers` guard would take the wrong branch.
    """
    body = _exposure_body(
        _snapshot(),
        _TOWERS,
        [
            _observation("MY_1", 0),
            _observation("MY_2", 0.0),
            _observation("MY_3", 4),
        ],
        now=_NOW,
    )
    assert set(body["towers"]) == {"MY_3"}
    assert all(record["hotspot_pixel_days"] >= 1 for record in body["towers"].values())
    assert body["towers_with_detections"] == 1


def test_a_row_with_no_time_or_confidence_is_dropped_rather_than_invented():
    # pixel_days comes off an unmasked band and the other two off masked ones.
    # If they disagree we cannot say when or how confidently, and inventing
    # either figure is worse than dropping the row.
    rows = [
        {"tower_id": "MY_1", "pixel_days_sum": 3, "max_conf_max": None, "latest_epoch_max": 1.0},
        {"tower_id": "MY_2", "pixel_days_sum": 3, "max_conf_max": 1, "latest_epoch_max": None},
        {"tower_id": None, "pixel_days_sum": 3, "max_conf_max": 1, "latest_epoch_max": 1.0},
        {"tower_id": "MY_3", "pixel_days_sum": None},
    ]
    assert _exposure_body(_snapshot(), _TOWERS, rows, now=_NOW)["towers"] == {}


def test_pixel_days_are_whole_counts_and_confidence_is_a_word():
    # `.unweighted()` is what keeps the sum whole upstream; this is the contract
    # the frontend reads, where `hotspot_pixel_days` is declared `number` and
    # rendered as a count. A fractional "6.71 detection-days" is not a count.
    body = _exposure_body(
        _snapshot(),
        _TOWERS,
        [_observation("MY_1", 21, confidence=1), _observation("MY_2", 2.0, confidence=2)],
        now=_NOW,
    )
    assert body["towers"]["MY_1"]["hotspot_pixel_days"] == 21
    assert isinstance(body["towers"]["MY_1"]["hotspot_pixel_days"], int)
    assert body["towers"]["MY_1"]["max_confidence"] == "nominal"
    assert body["towers"]["MY_2"]["max_confidence"] == "high"
    assert body["towers"]["MY_1"]["latest_acquisition"] == "2026-09-10T06:59:00Z"


def test_unknown_source_age_counts_as_stale():
    """"We do not know how old this is" must not be the branch that lets a
    review be scheduled against it.

    latest_acquisition is None when nothing burned anywhere in the screening
    bbox during the window — a perfectly good snapshot — but it leaves the age
    unknowable, and the schedule route refuses on `stale`.
    """
    freshness = _exposure_body(_snapshot(latest=None), _TOWERS, [], now=_NOW)["freshness"]
    assert freshness["latest_acquisition"] is None
    assert freshness["source_age_hours"] is None
    assert freshness["stale"] is True
    assert freshness["stale_after_hours"] == STALE_AFTER_HOURS


def test_staleness_is_measured_against_the_stated_limit():
    # 48 h leaves one whole missed publication before the source is called
    # stale. Anything tighter than 24 h would mark it stale every morning, on a
    # working feed, because the current UTC day is usually not published yet.
    assert STALE_AFTER_HOURS == 48
    fresh = _NOW - timedelta(hours=STALE_AFTER_HOURS - 1)
    old = _NOW - timedelta(hours=STALE_AFTER_HOURS + 1)
    for moment, stale in ((fresh, False), (old, True)):
        body = _exposure_body(
            _snapshot(latest=moment.strftime("%Y-%m-%dT%H:%M:%SZ")), _TOWERS, [], now=_NOW
        )
        assert body["freshness"]["stale"] is stale, moment


def test_age_is_measured_from_the_acquisition_and_never_runs_negative():
    # A granule timestamped slightly ahead of this clock is a clock difference,
    # not a reading from the future; reporting -0.3 h would look like a bug in
    # the feed rather than in the comparison.
    assert _age_hours(None, _NOW) is None
    assert _age_hours("2026-09-11T06:00:00Z", _NOW) == 6.0
    assert _age_hours("2026-09-11T18:00:00Z", _NOW) == 0.0


def test_the_confidence_filter_is_derived_from_the_threshold_not_retyped():
    # If CONFIDENCE_MIN ever moves, the panel's "nominal and high only" line
    # moves with it instead of lying.
    screening = _exposure_body(_snapshot(), _TOWERS, [], now=_NOW)["screening"]
    assert screening["confidence_included"] == ["nominal", "high"]
    assert screening["confidence_excluded"] == ["low"]


def test_window_days_counts_the_selected_day_as_well_as_the_lookback():
    # FIRE_LOOKBACK_DAYS counts only the days BEFORE the selected one, so the
    # window the panel reports is one wider than it. Off by one here and the
    # copy says "2 days" over a 3-day count.
    screening = _exposure_body(_snapshot(), _TOWERS, [], now=_NOW)["screening"]
    assert screening["window_days"] == FIRE_LOOKBACK_DAYS + 1 == 3
    assert screening["buffer_m"] == SCREEN_BUFFER_M
    assert screening["resolution_m"] == VIIRS_SCALE_M


def test_the_body_carries_the_catalogue_attribution_rather_than_its_own_copy():
    # A licence-attribution edit must not be able to land on the map layer and
    # silently miss the panel beside it.
    body = _exposure_body(_snapshot(), _TOWERS, [], now=_NOW)
    assert body["attribution"] == BY_ID["active_fire"].attribution
    assert body["source"] == "NASA/LANCE/NOAA20_VIIRS/C2"
    assert body["window"] == {"start": "2026-09-09", "end": "2026-09-12"}


def test_screened_towers_is_the_denominator_not_the_detection_count():
    # The figure that lets the panel say "1,164 screened, none reported" rather
    # than just "none", which is the difference between a measurement and a
    # blank.
    body = _exposure_body(_snapshot(), _TOWERS, [_observation("MY_1", 3)], now=_NOW)
    assert body["screened_towers"] == 3
    assert body["towers_with_detections"] == 1


def test_snapshot_id_is_deterministic_and_moves_with_every_input():
    """The id IS the review's expiry, so anything that changes what was screened
    must change it.

    Not a security digest — an identity. A changed window, a newly published
    granule, or a REVISION of a granule already in the window is what makes a
    review raised against expired evidence detectable instead of silently
    scheduled.
    """
    stamp = "2026-09-11T06:59:00Z"
    base = _snapshot_id("2026-09-11", "2026-09-09", "2026-09-12", ("2026252", "2026253"), stamp)
    assert base == _snapshot_id(
        "2026-09-11", "2026-09-09", "2026-09-12", ("2026252", "2026253"), stamp
    )
    assert base.startswith("viirs-2026-09-11-")
    # A new granule landed.
    assert base != _snapshot_id(
        "2026-09-11", "2026-09-09", "2026-09-12", ("2026252", "2026253", "2026254"), stamp
    )
    # The window moved.
    assert base != _snapshot_id(
        "2026-09-11", "2026-09-08", "2026-09-12", ("2026252", "2026253"), stamp
    )
    # A granule was REVISED IN PLACE. This is the case the granule ids alone
    # could not see, and it is not hypothetical: two live screenings of
    # 2026-09-11 hours apart shared an id while reporting 21 detection-days at
    # 06:59Z and 32 at 17:56Z, because LANCE reprocesses a day's granule as
    # later overpasses arrive and system:index does not move when it does.
    assert base != _snapshot_id(
        "2026-09-11", "2026-09-09", "2026-09-12", ("2026252", "2026253"), "2026-09-11T17:56:00Z"
    )
    # A window with no detections at all still gets a stable id rather than one
    # that changes every time None is hashed differently.
    quiet = _snapshot_id("2026-09-11", "2026-09-09", "2026-09-12", ("2026252",), None)
    assert quiet == _snapshot_id("2026-09-11", "2026-09-09", "2026-09-12", ("2026252",), None)
    assert quiet != base


def test_bad_date_is_rejected_before_earth_engine_is_touched():
    # The ordering guard again, on the snapshot path this time. A malformed date
    # is not an outage, and initialising first makes a typo report itself as
    # missing credentials.
    try:
        snapshot_for("not-a-date")
    except InvalidDate:
        return
    except LayerUnavailable as error:
        raise AssertionError(f"date validation ran after EE init: {error}")
    raise AssertionError("a malformed date should not be accepted")


def test_a_cached_snapshot_is_answered_without_touching_earth_engine():
    """The TTL cache is consulted before `initialise`, not after.

    The reduction behind a snapshot is not free — measured, 1,164 towers
    buffered 5 km at 375 m took 10.2 s — and the collection publishes once a
    day, so re-asking faster than hourly costs ten seconds and returns the same
    answer. Here the cache is seeded and Earth Engine is made to raise, so a
    cache miss is unmistakable.
    """
    assert SNAPSHOT_TTL_SECONDS == 3600
    original = exposure.initialise
    seeded = _snapshot()
    try:
        def refuse():
            raise AssertionError("initialise() was reached on a cache hit")

        exposure.initialise = refuse
        exposure.clear_cache()
        with exposure._snapshot_lock:
            exposure._snapshots["2026-09-11"] = {
                "snapshot": seeded,
                "expires_at": exposure._now() + timedelta(seconds=SNAPSHOT_TTL_SECONDS),
            }
        assert snapshot_for("2026-09-11") is seeded
    finally:
        exposure.initialise = original
        exposure.clear_cache()


def test_screen_towers_returns_none_rather_than_raising_when_it_cannot_ask():
    """None, not {} — and never an exception.

    A fire outage must cost the fire panel, not the response it is rendered
    beside. The same contract `flood/forecast.sample_weather_hazard` keeps, for
    the same reason.
    """
    original_initialise = exposure.initialise
    original_points = exposure.tower_points
    try:
        def refuse():
            raise LayerUnavailable("earthengine-api is not installed")

        exposure.initialise = refuse
        exposure.tower_points = lambda: list(_TOWERS)
        exposure.clear_cache()
        assert screen_towers("2026-09-11") is None
    finally:
        exposure.initialise = original_initialise
        exposure.tower_points = original_points
        exposure.clear_cache()


def test_screen_towers_swallows_an_unexpected_error_rather_than_propagating_it():
    # Deliberately broad upstream: Earth Engine raises a wide family of errors
    # and not one of them may reach a route. An EEException is not a
    # LayerUnavailable and would otherwise escape the narrow except.
    original_initialise = exposure.initialise
    original_points = exposure.tower_points
    try:
        def explode():
            raise RuntimeError("EEException: user memory limit exceeded")

        exposure.initialise = explode
        exposure.tower_points = lambda: list(_TOWERS)
        exposure.clear_cache()
        try:
            result = screen_towers("2026-09-11")
        except Exception as error:  # noqa: BLE001 - that is the whole assertion
            raise AssertionError(f"screen_towers raised instead of returning None: {error!r}")
        assert result is None
    finally:
        exposure.initialise = original_initialise
        exposure.tower_points = original_points
        exposure.clear_cache()


def test_an_empty_population_is_not_a_quiet_answer():
    # With no towers, nothing was screened. A body reporting "0 of 0 clear"
    # would be a measurement of nothing, and the panel would render it as good
    # news.
    original = exposure.tower_points
    try:
        exposure.tower_points = list
        assert screen_towers("2026-09-11") is None
    finally:
        exposure.tower_points = original


def test_the_screening_radius_is_five_km_of_ground():
    """5,000 m, and metres of GROUND rather than a degree box.

    Assumed and stated as assumed: 5 km is a review catchment, not a calibrated
    ember-transport or radiant-heat distance, and no operator data exists here
    to calibrate one against. What it does have to do is clear the sensor, and
    it does — a 10 km disc is about 26 VIIRS pixels across, so a detection
    anywhere in it is a whole pixel rather than a geolocation edge case.

    Checked against the repo's one haversine rather than a second copy of the
    formula.
    """
    assert SCREEN_BUFFER_M == 5000
    radius_km = SCREEN_BUFFER_M / 1000.0
    lon, lat = 101.61, 3.07
    km_per_degree_east = haversine_km(lon, lat, lon + 1.0, lat)
    edge = radius_km / km_per_degree_east
    assert haversine_km(lon, lat, lon + edge * 0.98, lat) < radius_km
    assert haversine_km(lon, lat, lon + edge * 1.02, lat) > radius_km
    assert 2 * SCREEN_BUFFER_M / VIIRS_SCALE_M > 20, "the disc must clear the pixel grid"

    # And why the buffer is taken on a geodesic point rather than in degrees: a
    # fixed longitude span covers less ground the further north it sits, so the
    # same degree box would quietly shrink between Johor and Sabah.
    assert haversine_km(lon, 6.5, lon + 1.0, 6.5) < km_per_degree_east


def test_the_buffer_constant_is_what_reaches_the_geometry():
    # No credential-free test can measure the disc itself, so assert the call:
    # one geodesic Point per tower, buffered by SCREEN_BUFFER_M, carrying the
    # tower_id the reduction reads back.
    ee = MagicMock(name="ee")
    _tower_buffers(ee, _TOWERS)

    assert ee.Geometry.Point.call_count == len(_TOWERS)
    ee.Geometry.Point.assert_any_call([101.61, 3.07])
    ee.Geometry.Point.assert_any_call([117.89, 4.24])
    point = ee.Geometry.Point.return_value
    assert point.buffer.call_count == len(_TOWERS)
    point.buffer.assert_called_with(SCREEN_BUFFER_M)
    ee.Feature.assert_any_call(point.buffer.return_value, {"tower_id": "MY_1"})


def test_the_reduction_is_unweighted():
    """Both halves of the combined reducer, or the counts come back fractional.

    The default weighted reducer returns FRACTIONAL pixel counts — measured 6.71
    and 11.99 — which cannot honestly be called pixel-days. A separate fix from
    the projection below: the weighted reducer returns fractions regardless of
    crs.
    """
    reducer = _reduce_regions_keywords()["reducer"]
    assert reducer.count(".unweighted()") == 2, (
        f"both reducers must be unweighted, got {reducer!r}"
    )
    assert "sharedInputs=True" in reducer, "sum and max must read the same bands"


def test_the_reduction_is_pinned_to_the_collections_own_projection():
    # Without `crs` the reduction resamples onto a 375 m WGS84 grid and counts a
    # slightly different pixel set — measured over 1,164 towers for
    # 2026-09-07..2026-09-10, the top tower read 38 detection-days instead of 36
    # and 40 towers carried detections instead of 41, at the same runtime. A
    # count of satellite pixels that changes with the output grid is not a count.
    keywords = _reduce_regions_keywords()
    assert keywords["scale"] == "VIIRS_SCALE_M"
    assert keywords["crs"] == "VIIRS_CRS"
    assert keywords["tileScale"] == "4"


def test_each_day_is_screened_before_the_window_is_combined():
    # Mosaicking first pairs every detection with the last image's unmasked
    # confidence and reports 94.6% "low confidence" where correct per-image
    # pairing gives ~3%. `.map(screen_detections)` must therefore come before
    # anything that flattens the collection.
    source = inspect.getsource(exposure._reduce_over_towers)
    assert ".map(screen_detections)" in source
    assert ".mosaic()" not in source
    assert source.index(".map(screen_detections)") < source.index("pixel_day_image(")


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
