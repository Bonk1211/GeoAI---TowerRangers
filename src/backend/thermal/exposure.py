"""Per-tower fire screening: which sites had a hotspot near them, and when.

`thermal/layers.py` paints thermal anomalies on the map; this module asks the same
collection, over the same window, which towers had one within `SCREEN_BUFFER_M`.
The answer is evidence a planner reviews — it is not a score, it is not a factor,
and nothing in this file touches `risk`, `priority`, `decision`, the AHP weights
or `attribution`. A tower's condition has not changed because a satellite saw a
warm pixel 3 km away; what has changed is whether someone should go and look.

Four properties the callers depend on:

Failure is None, never an exception. `screen_towers` has no path out that raises:
a fire outage must cost the fire panel, not the route it is rendered beside.

None is not an empty dict. A populated body whose `towers` map is empty means
"we asked and every tower is quiet"; None means "we could not ask at all". The UI
renders those differently, and collapsing them is the zeroed-struct rule in
CLAUDE.md — which shipped once as a stability fixture reporting rho 0.00 in calm
grey, the most alarming reading that model can produce, shown as if measured.

A tower is never written with `hotspot_pixel_days: 0`. Absence from the map is
what "screened, nothing reported" looks like; a zero would read as a measurement.

The tiles and this body come from ONE `snapshot_for` call. `build_active_fire`
reads its `observed_at` and `snapshot_id` from here, so the map and the panel
beside it cannot describe different windows — and `snapshot_id` is what makes a
stale review detectable, because a changed window or a new granule changes it.
"""

from __future__ import annotations

import hashlib
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from thermal.layers import (
    BY_ID,
    CONFIDENCE_LABELS,
    CONFIDENCE_MIN,
    FIRE_LOOKBACK_DAYS,
    FIRE_SCREEN_BBOX,
    VIIRS_ASSET,
    VIIRS_CRS,
    VIIRS_SCALE_M,
    pixel_day_image,
    screen_detections,
)
from fixtures.source import tower_points
from tiles.ee_session import LayerUnavailable, initialise
from tiles.engine import _now, iso, parse_date, window_for

# The screening radius. Assumed, and stated as assumed: 5 km is a review
# catchment, not a calibrated ember-transport or radiant-heat distance, and no
# operator data exists here to calibrate one against. It has to clear the
# sensor, and it does — a 10 km disc is about 26 VIIRS pixels across, so a
# detection anywhere in it is a whole pixel rather than a geolocation edge case.
SCREEN_BUFFER_M = 5000

# Two days. The archive normally publishes the current UTC day's granule only
# well into the working day — measured 2026-09-10, the newest index was 2026252,
# i.e. yesterday — so anything tighter than 24 h would mark the source stale
# every morning and block scheduling on a working feed. 48 h leaves one whole
# missed publication before it says so.
STALE_AFTER_HOURS = 48

# An hour, matching the map id TTL for the same reason. The collection publishes
# once a day, and the reduction behind a snapshot is not free: measured, 1,164
# towers buffered 5 km at 375 m took 10.2 s. Re-asking faster than hourly costs
# ten seconds and returns the same answer.
SNAPSHOT_TTL_SECONDS = 3600

# The exposure body and the map layer must carry the same credit line. Reading
# it off the catalogue record means a licence-attribution edit cannot land in one
# place and silently miss the other.
FIRE_LAYER_ID = "active_fire"

_snapshot_lock = threading.Lock()
_snapshots: dict[str, dict] = {}
# Reduction results, keyed by snapshot_id rather than by date: the id already
# moves with the window, the confidence filter and the newest observation, so a
# hit is the same question asked of the same data. Only the reduceRegions output
# is stored — the body is rebuilt around it on every read so `freshness` is
# measured against the current clock rather than replayed from build time.
_observations: dict[str, dict] = {}


@dataclass(frozen=True)
class FireSnapshot:
    """One resolved source window: what was asked, of what, and how fresh it is.

    `granules` is reported rather than assumed. For `date == today` it is 2 as
    often as 3, because the current UTC day is usually not published yet — a
    2-granule window is a normal answer, not a degraded one.
    """

    snapshot_id: str
    date: str
    window_start: str  # "YYYY-MM-DD" inclusive
    window_end: str  # "YYYY-MM-DD" exclusive
    granules: int
    granule_ids: tuple[str, ...]
    latest_acquisition: str | None  # None when no detection anywhere in the AOI
    built_at: str


def _snapshot_id(
    date: str,
    window_start: str,
    window_end: str,
    granule_ids,
    latest_acquisition: str | None,
) -> str:
    """Deterministic identity for one source window AND its content.

    Not a security digest — an identity. The same source window and the same
    observations rebuild the same id; anything that changes what a planner
    would see changes it, which is what makes a review raised against an
    expired snapshot detectable instead of silently scheduled against data
    nobody looked at.

    CONFIDENCE_MIN and SCREEN_BUFFER_M are in the payload because they change
    what was screened. Two reviews of the same granules under different filters
    are not the same review.

    `latest_acquisition` is in the payload for a reason measured the hard way.
    The granule ids alone were not enough: LANCE revises a day's granule IN
    PLACE as later overpasses are processed, and `system:index` does not move
    when it does. Two screenings of 2026-09-11 hours apart therefore shared an
    id while reporting 21 detection-days at 06:59Z and 32 at 17:56Z — the id
    said "the same evidence" about two different answers, which is precisely
    the guarantee this function exists to make. The newest acquisition moves
    whenever a revision lands, so it is the cheapest content marker available
    and it is already computed.
    """
    payload = "|".join(
        [
            VIIRS_ASSET,
            window_start,
            window_end,
            str(CONFIDENCE_MIN),
            str(SCREEN_BUFFER_M),
            latest_acquisition or "no-detection",
            *granule_ids,
        ]
    )
    return f"viirs-{date}-{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:12]}"


def _latest_acquisition(ee, screened) -> str | None:
    """Newest detection time over the screening bbox, or None if there is none.

    From `acq_epoch`, which is unix SECONDS. Not from `acq_time`, which is
    seconds-of-day (19980 = 05:33 UTC) and yields "hour 199" if read as the FIRMS
    CSV's HHMM without throwing; and not from `system:time_start`, which is
    midnight of the acquisition day and is therefore shared by every detection in
    it rather than being a detection time at all.

    Over FIRE_SCREEN_BBOX rather than the drawn extent: the freshness figure is a
    statement about this fleet's ground, and taking it from a 50-degree box would
    report a fire in Myanmar as news about Malaysian towers.
    """
    reduced = (
        screened.select("acq_epoch")
        .max()
        .reduceRegion(
            reducer=ee.Reducer.max(),
            geometry=ee.Geometry.Rectangle(list(FIRE_SCREEN_BBOX)),
            scale=VIIRS_SCALE_M,
            crs=VIIRS_CRS,
            # Explicit rather than bestEffort: bestEffort silently coarsens the
            # scale until the region fits, and a max taken off a downsampled grid
            # can miss the newest detection entirely.
            maxPixels=int(1e10),
            tileScale=4,
        )
        .getInfo()
    )
    epoch = (reduced or {}).get("acq_epoch")
    if epoch is None:
        return None
    return iso(datetime.fromtimestamp(float(epoch), tz=timezone.utc))


def snapshot_for(date: str) -> FireSnapshot:
    """Resolve (or reuse) the source window behind one date.

    Raises LayerUnavailable — it is the tile path's contract and the route turns
    it into a 503. `screen_towers` is the one that must never raise, and it
    catches this.

    Zero granules is the honest outage: the archive has no image for those days
    (it is missing 2023-12-08..14 and 2024-03-20..24), which is "no observation",
    never "no fire". Zero HOTSPOTS is a different statement entirely and returns
    a perfectly good snapshot with `latest_acquisition` None.
    """
    # Caller input first, before Earth Engine — a malformed date is not an
    # outage, and initialising first makes a typo report itself as missing
    # credentials. Same ordering rule as tiles_for.
    parse_date(date)

    with _snapshot_lock:
        hit = _snapshots.get(date)
        if hit and hit["expires_at"] > _now():
            return hit["snapshot"]

    ee = initialise()
    window_start, window_end = window_for(date, FIRE_LOOKBACK_DAYS)
    collection = ee.ImageCollection(VIIRS_ASSET).filterDate(window_start, window_end)
    try:
        # Forces the round trip now, and the ids are what the snapshot id is
        # built from. Sorted because Earth Engine promises no iteration order,
        # and an id that moved with server-side ordering would look like a
        # changed window every time it was rebuilt.
        granule_ids = tuple(sorted(collection.aggregate_array("system:index").getInfo() or ()))
    except Exception as error:
        raise LayerUnavailable(
            f"Earth Engine could not read {VIIRS_ASSET} for {window_start}..{window_end} "
            f"({error})."
        ) from error

    if not granule_ids:
        raise LayerUnavailable(
            f"no NOAA-20 VIIRS granules in the archive for {window_start}..{window_end}. "
            "That is a gap in the source, not a quiet sky — the collection has known "
            "missing days. Try a nearby date."
        )

    latest = _latest_acquisition(ee, collection.map(screen_detections))
    snapshot = FireSnapshot(
        snapshot_id=_snapshot_id(date, window_start, window_end, granule_ids, latest),
        date=date,
        window_start=window_start,
        window_end=window_end,
        granules=len(granule_ids),
        granule_ids=granule_ids,
        latest_acquisition=latest,
        built_at=iso(_now()),
    )
    with _snapshot_lock:
        _snapshots[date] = {
            "snapshot": snapshot,
            "expires_at": _now() + timedelta(seconds=SNAPSHOT_TTL_SECONDS),
        }
    return snapshot


def _tower_buffers(ee, towers):
    """One FeatureCollection of geodesic discs — reduced in a single call.

    `.buffer(SCREEN_BUFFER_M)` on an ee.Geometry.Point is metres of ground, so
    the disc stays 5 km wide at every latitude rather than becoming a degree box
    that shrinks north of the equator.
    """
    return ee.FeatureCollection(
        [
            ee.Feature(
                ee.Geometry.Point([float(t["lon"]), float(t["lat"])]).buffer(SCREEN_BUFFER_M),
                {"tower_id": t["tower_id"]},
            )
            for t in towers
        ]
    )


def _reduce_over_towers(ee, snapshot: FireSnapshot, towers) -> list[dict]:
    """One reduceRegions over every buffered tower; raw feature properties out.

    Three bands, three readings: `pixel_days_sum` is how many detection-days fell
    in the disc, `max_conf_max` the strongest confidence among them, and
    `latest_epoch_max` the newest detection time.

    `.unweighted()` is load-bearing and is a SEPARATE fix from `crs`. The default
    weighted reducer returns FRACTIONAL pixel counts — measured 6.71 and 11.99 —
    which cannot honestly be called pixel-days. `crs=VIIRS_CRS` fixes the other
    half: without it the reduction resamples onto a 375 m WGS84 grid and counts a
    slightly different pixel set (top tower 38 against 36, 40 towers with
    detections against 41), and a count of satellite pixels that changes with the
    output grid is not a count.

    Each image is screened BEFORE the collection is combined. Mosaicking first
    pairs every detection with the last image's unmasked confidence and reports
    94.6% "low confidence" where correct per-image pairing gives ~3%.
    """
    screened = (
        ee.ImageCollection(VIIRS_ASSET)
        .filterDate(snapshot.window_start, snapshot.window_end)
        .map(screen_detections)
    )
    stack = (
        pixel_day_image(screened)
        .addBands(screened.select("confidence").max().rename("max_conf"))
        .addBands(screened.select("acq_epoch").max().rename("latest_epoch"))
    )
    sampled = stack.reduceRegions(
        collection=_tower_buffers(ee, towers),
        reducer=ee.Reducer.sum().unweighted().combine(
            ee.Reducer.max().unweighted(), sharedInputs=True
        ),
        scale=VIIRS_SCALE_M,
        crs=VIIRS_CRS,
        tileScale=4,
    ).getInfo()
    return [feature.get("properties", {}) for feature in sampled.get("features", [])]


def _age_hours(latest_acquisition: str | None, now: datetime) -> float | None:
    """Hours since the newest detection, or None when there was none.

    None rather than a large number: "nothing has burned near this fleet in the
    window" is not an old reading, and reporting it as one would make a quiet
    sky look like a broken feed.
    """
    if latest_acquisition is None:
        return None
    observed = datetime.strptime(latest_acquisition, "%Y-%m-%dT%H:%M:%SZ").replace(
        tzinfo=timezone.utc
    )
    return round(max(0.0, (now - observed).total_seconds() / 3600.0), 1)


def _exposure_body(
    snapshot: FireSnapshot, towers, observations, now: datetime | None = None
) -> dict:
    """Snapshot + reduced properties -> the /fire/exposure body. Pure; no network.

    Split out so every rule this feature exists for is testable without
    credentials: that a quiet fleet is a populated body rather than an error,
    that no tower is ever written with a zero count, and that staleness is
    computed rather than asserted.
    """
    now = now or _now()
    detected: dict[str, dict] = {}
    for properties in observations:
        tower_id = properties.get("tower_id")
        pixel_days = properties.get("pixel_days_sum")
        confidence = properties.get("max_conf_max")
        epoch = properties.get("latest_epoch_max")
        if tower_id is None or pixel_days is None:
            continue
        pixel_days = int(round(float(pixel_days)))
        if pixel_days < 1:
            # Absence from `towers` is what "screened, nothing reported" looks
            # like. A zero here would read as a measurement of quiet ground and
            # every consumer's `if tower in towers` guard would take the wrong
            # branch.
            continue
        if confidence is None or epoch is None:
            # pixel_days comes off an unmasked band and these two off masked
            # ones. If they disagree we cannot say when or how confidently, and
            # inventing either figure is worse than dropping the row.
            continue
        detected[tower_id] = {
            "tower_id": tower_id,
            "hotspot_pixel_days": pixel_days,
            "max_confidence": CONFIDENCE_LABELS[int(round(float(confidence)))],
            "latest_acquisition": iso(datetime.fromtimestamp(float(epoch), tz=timezone.utc)),
        }

    # Derived from the filter, never retyped: if CONFIDENCE_MIN ever moves, the
    # panel's "nominal and high only" line moves with it instead of lying.
    labels = sorted(CONFIDENCE_LABELS.items())
    age = _age_hours(snapshot.latest_acquisition, now)
    return {
        "snapshot_id": snapshot.snapshot_id,
        "date": snapshot.date,
        "source": VIIRS_ASSET,
        "attribution": BY_ID[FIRE_LAYER_ID].attribution,
        "window": {"start": snapshot.window_start, "end": snapshot.window_end},
        "granules": snapshot.granules,
        "screening": {
            "buffer_m": SCREEN_BUFFER_M,
            "resolution_m": VIIRS_SCALE_M,
            # The selected day plus the lookback. The window is 3 days wide;
            # FIRE_LOOKBACK_DAYS counts only the days BEFORE it.
            "window_days": FIRE_LOOKBACK_DAYS + 1,
            "confidence_included": [
                label for value, label in labels if value >= CONFIDENCE_MIN
            ],
            "confidence_excluded": [
                label for value, label in labels if value < CONFIDENCE_MIN
            ],
        },
        "freshness": {
            "latest_acquisition": snapshot.latest_acquisition,
            "source_age_hours": age,
            # Unknown age counts as stale. "We do not know how old this is" must
            # not be the branch that lets a review be scheduled against it.
            "stale": age is None or age > STALE_AFTER_HOURS,
            "stale_after_hours": STALE_AFTER_HOURS,
        },
        # How many towers were LOOKED AT, which is the denominator the panel
        # needs to say "1,164 screened, none reported" rather than just "none".
        "screened_towers": len(towers),
        "towers_with_detections": len(detected),
        "towers": detected,
    }


def screen_towers(date: str) -> dict | None:
    """Towers with a hotspot within SCREEN_BUFFER_M, or None when we could not ask.

    Returns None — not an empty dict, not a zeroed struct — when earthengine-api
    is absent, when credentials are missing, when the archive has no granule for
    the window, or when any part of the reduction fails. Callers render that as
    "fire screening is unavailable", which is a different statement from "we
    screened every tower and nothing is burning". The same contract
    `flood/forecast.sample_weather_hazard` keeps, for the same reason.

    Population comes from `fixtures.source.tower_points()`, so USE_FIXTURE is
    honoured in the one place that switch lives and a screening request does not
    warm the adapter cache to find out where the towers are.
    """
    towers = tower_points()
    if not towers:
        # Not a quiet answer: with no population nothing was screened, and a body
        # reporting 0 of 0 towers clear would be a measurement of nothing.
        return None

    # Cached on the SNAPSHOT, not on the date. The snapshot id already moves
    # with the window, the filter and the newest observation, so a hit means
    # the reduction would be asked the same question of the same data — and a
    # revision that changes the answer changes the id and misses.
    #
    # Caching only snapshot_for was half a cache: the 1,164-tower reduceRegions
    # after it ran unconditionally, so every call paid ~5-6 s against Earth
    # Engine quota. With the panel refetching every five minutes and the
    # schedule route re-screening on every preview AND every pin — including
    # requests it then refuses — that was most of the cost of the feature.
    # Still None, never a raise: api/routes/schedule.py's _fire_evidence calls
    # this on the pin path and the panel calls it on every render, and neither
    # may be handed an exception. The route recovers the PRECISE reason by
    # calling snapshot_for itself before this — cheap, because the snapshot it
    # resolves is the one this call then reuses from cache.
    try:
        snapshot = snapshot_for(date)
    except (LayerUnavailable, ImportError):
        return None
    except Exception:
        return None

    # The cache holds the REDUCTION, not the finished body. Caching the body was
    # wrong in a way that mattered: `freshness` is computed against the clock, so
    # a hit replayed the age and the `stale` flag from build time. A body built at
    # 47.6 h kept answering "47.6 h, not stale" for another hour after the source
    # had genuinely crossed the 48 h limit — and api/routes/schedule.py's
    # _fire_evidence reads exactly that flag to decide whether an inspection may
    # be scheduled. The expensive half is the 1,164-tower reduceRegions; rebuilding
    # the body around it is free and keeps the clock honest.
    with _snapshot_lock:
        cached = _observations.get(snapshot.snapshot_id)
        if cached and cached["expires_at"] > _now():
            return _exposure_body(snapshot, towers, cached["observations"])

    try:
        ee = initialise()
        observations = _reduce_over_towers(ee, snapshot, towers)
    except (LayerUnavailable, ImportError):
        # A configuration gap, a missing optional dependency, or an archive gap.
        # Not an outage this module reports — the panel simply says it could not
        # ask, and the schedule route refuses to raise an inspection against it.
        return None
    except Exception:
        # Deliberately broad. Earth Engine raises a wide family of errors and not
        # one of them may reach a route: a fire-screening failure must cost the
        # fire panel, never the response it is rendered beside.
        return None

    with _snapshot_lock:
        _observations[snapshot.snapshot_id] = {
            "observations": observations,
            "expires_at": _now() + timedelta(seconds=SNAPSHOT_TTL_SECONDS),
        }
    return _exposure_body(snapshot, towers, observations)


def clear_cache() -> None:
    """Drop every resolved snapshot and screening. Tests and a manual refresh."""
    with _snapshot_lock:
        _snapshots.clear()
        _observations.clear()
