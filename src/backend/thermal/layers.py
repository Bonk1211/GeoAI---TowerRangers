"""Active-fire hotspots — observed evidence beside the score, never inside it.

A third peer of `flood/` and `land/` on top of `tiles/engine.py`. It imports
neither of them (a test asserts that by AST) and neither imports it.

The honesty constraint here is stronger than the land one and shapes every line
of copy in this file. A hotspot is a thermal anomaly at 375 m: it can be a
plantation burn, a gas flare, a rubbish fire or hot bare ground, and it says
nothing about any structure inside its pixel. So fire never becomes a risk
factor, never gains an `attribution` share and never sets a `dominant_factor` —
`docs/Backend_Handoff.md` §0.6 and §1 forbid inventing a failure signal, and a
fire share would do exactly that by selecting an intervention. What this layer
produces is something a planner looks at next to the score, and the description
below says so in the catalogue rather than only here.

Three traps sit between the FIRMS mental model and this collection. Each cost
real time to find and none of them raises:

`ee.FeatureCollection(VIIRS_ASSET)` DOES NOT RAISE. It returns a collection
whose `.size()` is 1056 and whose `.first()` is an Image, and filtering it by
`acq_date` or by `inList("confidence", ["n", "h"])` returns 0 with no error.
Anyone writing against the FIRMS *CSV* — where a row is a detection with an
`acq_date` and a letter confidence — gets a silently empty layer. This asset is
an ImageCollection of daily rasters; there are no fire features anywhere in it.

NEVER `.mosaic()` the window. `confidence` is unmasked, so a mosaic takes
confidence from the LAST image at every pixel while taking `Bright_ti4` from
whichever image actually had a detection, pairing each detection with an
unrelated day's confidence. Measured: the mosaic cross-tab reports 94.6% "low
confidence" where correct per-image pairing gives ~3%. Screen each image first,
then combine — which is what `pixel_day_image` does.

`acq_time` is SECONDS-OF-DAY (19980 = 05:33 UTC), not the HHMM integer the FIRMS
CSV carries; parsing it as HHMM yields "hour 199" and does not throw. Use
`acq_epoch`, which is unix seconds. And `system:time_start` is midnight of the
acquisition DAY — every detection that day shares it, so it is not a detection
time and cannot answer "how fresh is this".
"""

from __future__ import annotations

from tiles.engine import Layer, scene_count, window_for

VIIRS_ASSET = "NASA/LANCE/NOAA20_VIIRS/C2"

# Same regional extent as the dated land and flood observations, written by
# value rather than imported: `thermal/` is a peer of both packages and importing a
# constant would be the first thread of exactly the coupling the split removes.
FIRE_LAYER_BBOX = (92.0, -11.5, 142.0, 29.0)

# Malaysia. Narrower than the drawn extent on purpose: freshness and tower
# screening are questions about the towers, and taking the newest acquisition
# from a 50-degree box would report a fire in Myanmar as this fleet's news.
FIRE_SCREEN_BBOX = (99.0, 0.5, 119.5, 7.5)

# The selected day plus the two before it — a 3-day window. Wide enough that a
# single cloudy or missed overpass does not read as "no fire", narrow enough
# that a pixel-day count still describes something current.
FIRE_LOOKBACK_DAYS = 2

# 0 low (excluded) | 1 nominal | 2 high.
#
# The values are exactly {0, 1, 2}; the LABELS are inferred, and saying so is
# the point of this comment. Measured globally for 2026-09-09 over 177,142
# detections: 0 -> 9.22%, 1 -> 83.69%, 2 -> 7.09%. That distribution matches the
# standard VIIRS low/nominal/high ordering, which is why the mapping reads that
# way — but it comes from the distribution, not from a band description.
CONFIDENCE_MIN = 1
CONFIDENCE_LABELS = {0: "low", 1: "nominal", 2: "high"}

# The collection's native resolution and projection. Both are passed explicitly
# to every reduction: reduceRegions otherwise resamples onto the output grid and
# counts a slightly different pixel set — measured over 1,164 towers for
# 2026-09-07..2026-09-10, the top tower read 38 detection-days without `crs`
# against 36 with it, and 40 towers carried detections against 41. A count of
# satellite pixels that changes with the output grid is not a count.
VIIRS_SCALE_M = 375
VIIRS_CRS = "SR-ORG:6974"

# The mask must come from a band that is masked to detections. `confidence` and
# `DayNight` are 0-filled across the whole footprint — 12.7 million zero pixels
# over the Malaysia bbox alone — so `confidence.neq(0)` would read open ocean as
# confidence data and drop every genuine low-confidence detection into the same
# bucket as it. `Bright_ti4, Bright_ti5, frp, acq_time, acq_epoch, line_number`
# are the masked bands; this is one of them.
DETECTION_BAND = "Bright_ti4"

PIXEL_DAY_PALETTE = ["fde047", "f97316", "b91c1c"]


def screen_detections(image):
    """One daily VIIRS image -> only nominal/high-confidence detection pixels.

    The detection mask comes from Bright_ti4, never from confidence: confidence
    is unmasked and 0-filled across the whole footprint, so `confidence.neq(0)`
    would silently DROP every low-confidence detection into the same bucket as
    open ocean and, worse, read 12.7 million ocean pixels as confidence data.
    """
    detected = image.select(DETECTION_BAND).mask()
    keep = image.select("confidence").updateMask(detected).gte(CONFIDENCE_MIN)
    return image.updateMask(detected).updateMask(keep)


def pixel_day_image(screened_collection):
    """Screened daily images -> per-pixel count of days carrying a detection.

    Per-image first, then summed. Combining the window before screening would
    pair each detection with the last image's unmasked confidence — see the
    mosaic trap in the module docstring.
    """
    return (
        screened_collection
        .map(lambda image: image.select("confidence").mask().rename("pixel_days"))
        .sum()
        .unmask(0)
        .rename("pixel_days")
    )


def build_active_fire(ee, hf, date: str):
    """NOAA-20 VIIRS thermal anomalies over a 3-day window, shaded by frequency.

    A pixel-day counts satellite detections, not fires: one long burn seen on
    three consecutive overpasses and three unrelated one-day burns in the same
    pixel are indistinguishable here, and both read 3.

    The archive normally has no granule for the current UTC day until well into
    the working day — measured 2026-09-10, the newest `system:index` was 2026252,
    i.e. 2026-09-09 — so a `date` of today usually yields 2 images, not 3. The
    count actually used is reported rather than assumed; only ZERO granules is an
    outage, and `scene_count` is what raises on it. Zero HOTSPOTS is a legitimate
    quiet answer and must never 503.
    """
    start, end = window_for(date, FIRE_LOOKBACK_DAYS)
    region = ee.Geometry.Rectangle(list(FIRE_LAYER_BBOX))
    collection = ee.ImageCollection(VIIRS_ASSET).filterDate(start, end)
    # "the VIIRS archive" rather than a place: the collection is global daily
    # rasters, so an empty window means the archive has no image for those days
    # (it is missing 2023-12-08..14 and 2024-03-20..24), never that a region was
    # looked at and found quiet.
    n_images = scene_count(
        collection, "NOAA-20 VIIRS", start, end, region_label="the VIIRS archive"
    )
    counts = pixel_day_image(collection.map(screen_detections))
    image = (
        counts.selfMask()
        .visualize(min=1, max=3, palette=PIXEL_DAY_PALETTE)
        .clip(region)
    )

    # Imported here rather than at module scope: thermal/exposure.py imports this
    # module's constants, so a top-level import back would be a cycle. Same
    # deferred-import shape flood/forecast.py uses to reach flood/layers.py.
    #
    # The tiles and the per-tower evidence take their window, their granules and
    # their timestamp from ONE function. Deriving them separately is how a map
    # ends up describing a different window than the panel beside it.
    from thermal.exposure import snapshot_for

    snapshot = snapshot_for(date)
    return image, n_images, (start, end), {
        "observed_at": snapshot.latest_acquisition,
        "snapshot_id": snapshot.snapshot_id,
    }


FIRE_LAYERS: tuple[Layer, ...] = (
    Layer(
        layer_id="active_fire",
        label="Active fire hotspots",
        description=(
            "NOAA-20 VIIRS 375 m thermal anomalies over the selected day and the two "
            "before it, nominal and high confidence only. Each pixel is shaded by how "
            "many of those days carried a detection. A hotspot is a thermal anomaly, "
            "not a fire perimeter and not damage: it can be a plantation burn, a flare "
            "or hot bare ground, and it says nothing about any structure. It does not "
            "feed the tower risk score."
        ),
        kind="ee",
        # Observation, not forecast, and the distinction is load-bearing rather
        # than cosmetic: the frontend rewrites a forecast layer's date to the
        # literal 'latest', which would quietly detach this layer from the date
        # the rest of the console is showing.
        dated=True,
        temporal_kind="observation",
        unit="detection-days",
        attribution="NASA FIRMS / LANCE · NOAA-20 VIIRS 375 m active fire, C2 near real-time",
        legend=[
            {"label": "1 detection-day", "color": "#fde047"},
            {"label": "2 detection-days", "color": "#f97316"},
            {"label": "3 detection-days", "color": "#b91c1c"},
        ],
        builder=build_active_fire,
        bounds=FIRE_LAYER_BBOX,
        # Explicit because the field defaults to "water". Left off, the one fire
        # layer would render inside the flood panel.
        group="fire",
    ),
)

BY_ID = {layer.layer_id: layer for layer in FIRE_LAYERS}
