"""Vegetation and ground-condition layers — the other half of the site picture.

Where the flood catalogue answers "is there water here", these answer "what is
the ground and what is growing on it": the conditions MCMC MTSFB TC G041:2023
§6.3.2 (soil) and §6.3.3 (vegetation) make the structure owner's duty. This is a
peer of `flood/`, not a child — neither imports the other, and both sit on
`tiles/engine.py`.

One honesty constraint shapes the whole module, and it is stronger than the
flood one. A flood layer that over-reads is wrong about water. A vegetation
layer described loosely implies a regulatory duty has been discharged because a
satellite saw something green. So every layer's description names what it cannot
answer, and three of the duties in those clauses have no satellite answer here
at all and are said to have none:

    §6.3.2 (b)  compound cracks and land subsidence — needs InSAR time series
    §6.3.2 (c)  ponding *inside* the compound — metres wide; finest layer is 10 m
    §6.3.2 (e)  diesel and engine-oil scheduled waste — not observable
    §6.3.3 (b)  the 1 m perimeter grass cut — below every sensor here

None of these is a risk-index factor. They are context for a site audit, not a
substitute for one.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tiles.ee_session import LayerUnavailable
from tiles.engine import Layer, iso, parse_date, scene_count, window_for

# Same regional extent as the dated flood observations, so a user panning
# between the two panels never crosses an invisible coverage edge.
LAND_LAYER_BBOX = (92.0, -11.5, 142.0, 29.0)

# Sentinel-2's revisit here is about five days; EVI uses the same backward
# window the flood observations use so a single date compares like with like.
S2_LOOKBACK_DAYS = 6

# S2_SR_HARMONIZED carries reflectance scaled by 10000. NDVI is a normalised
# difference so that scale cancels; EVI is NOT — its +L and its coefficients
# assume reflectance in 0..1, so raw DN turns the constant into rounding noise
# and yields a plausible-looking image that is wrong everywhere. Scale first.
S2_REFLECTANCE_SCALE = 0.0001
# Standard MODIS EVI coefficients (Huete et al.), applied to Sentinel-2 bands.
EVI_GAIN, EVI_C1, EVI_C2, EVI_L = 2.5, 6.0, 7.5, 1.0
# Healthy tropical canopy sits around 0.4-0.8; the ramp tops at 0.8 rather than
# 1.0 so the working range is not squeezed into the last third of the palette.
EVI_MAX = 0.8
EVI_PALETTE = ["a1683a", "d9c27e", "b6d47a", "5aa832", "1f6b1f"]

GLO30_DEM = "COPERNICUS/DEM/GLO30"
# The same DEM the per-tower slope_deg comes from, so the wash and the tower
# attribute cannot disagree.
SLOPE_MAX_DEG = 35
SLOPE_PALETTE = ["e8f2e0", "a8d08d", "f2c94c", "e07b39", "b03030"]

WORLDCOVER = "ESA/WorldCover/v200"
# ESA's own class values and palette, kept verbatim: a recoloured land-cover map
# is a map nobody can check against the source.
WORLDCOVER_CLASSES = (
    (10, "Tree cover", "006400"),
    (20, "Shrubland", "ffbb22"),
    (30, "Grassland", "ffff4c"),
    (40, "Cropland", "f096ff"),
    (50, "Built-up", "fa0000"),
    (60, "Bare / sparse vegetation", "b4b4b4"),
    (70, "Snow and ice", "f0f0f0"),
    (80, "Permanent water", "0064c8"),
    (90, "Herbaceous wetland", "0096a0"),
    (95, "Mangroves", "00cf75"),
    (100, "Moss and lichen", "fae6a0"),
)

SMAP_ASSET = "NASA/SMAP/SPL4SMGP/008"
SMAP_BAND = "sm_surface"
# SMAP L4 is 3-hourly; a day is eight granules. The window must clear the
# product's publication lag, and three days does not.
#
# Measured, not assumed: on 2026-08-30 the newest granule in the collection was
# 2026-08-27T22:30Z. A three-day window from that date starts at 08-28 and
# missed it by three and a half hours — so the layer 503'd on the date the UI
# defaults to, which is the only date most people will ever ask for. Seven days
# clears the observed lag with room for the multi-day gaps this collection
# occasionally has.
#
# A longer window costs nothing in correctness because the builder draws the
# most recent granule it finds, never an average, and reports its timestamp. A
# stale reading that says how stale it is beats a 503 on the default date.
SMAP_LOOKBACK_DAYS = 7
SOIL_MOISTURE_PALETTE = ["b8860b", "d9c27e", "8fc7c0", "3d7fd4", "1d4e89"]

CLAY_ASSET = "OpenLandMap/SOL/SOL_CLAY-WFRACTION_USDA-3A1A1A_M/v02"
CLAY_BAND = "b0"  # 0 cm depth: the layer a foundation and its compound sit in.
CLAY_PALETTE = ["ffffcc", "d9f0a3", "78c679", "31a354", "006837"]


def _region(ee):
    return ee.Geometry.Rectangle(list(LAND_LAYER_BBOX))


def build_ground_slope(ee, hf, date: str):
    """Terrain slope in degrees from Copernicus GLO-30.

    Informs §6.3.2(d) "provide slope analysis study during site audit" and
    §6.3.3(a) turfing on slope areas. Regional context at 30 m, not a
    slope-stability study: a compound cut into a hillside can be far steeper
    than its pixel, and GLO-30 is a surface model, so buildings and canopy
    inflate slope near them — the same caveat prepare_pilot_dataset.py records
    for the per-tower slope_deg.

    The projection pin is not optional. ee.Terrain.slope evaluates in the OUTPUT
    projection when its input has none, so a mosaic would yield slope that
    changes with map zoom: plausible at every zoom and correct at none. Same
    family of trap as _sum_at_source_projection in flood/layers.py.
    """
    collection = ee.ImageCollection(GLO30_DEM).select("DEM")
    dem = collection.mosaic().setDefaultProjection(collection.first().projection())
    image = (
        ee.Terrain.slope(dem)
        .visualize(min=0, max=SLOPE_MAX_DEG, palette=SLOPE_PALETTE)
        .clip(_region(ee))
    )
    return image, None, None, {}


def build_land_cover(ee, hf, date: str):
    """ESA WorldCover 10 m, 2021 epoch — what surrounds the structure.

    Fixed epoch, deliberately undated: one global classification for 2021, so a
    date picker would promise currency the product does not have. Clearing or
    regrowth since 2021 does not appear here.
    """
    values = [value for value, _, _ in WORLDCOVER_CLASSES]
    palette = [color for _, _, color in WORLDCOVER_CLASSES]
    cover = ee.ImageCollection(WORLDCOVER).first().select("Map")
    # remap before visualize: class values are 10..100 with gaps, and a palette
    # stretched over min=10,max=100 would colour values that do not exist and
    # shift every class off its own colour.
    image = (
        cover.remap(values, list(range(len(values))))
        .visualize(min=0, max=len(values) - 1, palette=palette)
        .clip(_region(ee))
    )
    return image, None, None, {}


def build_vegetation_vigour(ee, hf, date: str):
    """Cloud-masked Sentinel-2 EVI median over the flood layers' window.

    Greenness of the ground cover around a site — context for the turfing and
    grass maintenance §6.3.3 requires. EVI is not canopy height, not clearance
    from the structure, and far too coarse to show the 1 m perimeter cut
    §6.3.3(b) asks for; the panel says so rather than letting a green wash imply
    compliance.

    EVI rather than NDVI because NDVI saturates in dense tropical canopy, which
    is most of the coverage area: above roughly 0.8 it stops separating a
    plantation from primary forest, and the towers that matter sit under exactly
    that canopy. Computed on Sentinel-2 at 10 m rather than MODIS at 250 m,
    because the question here is what is growing in and around one compound, not
    landscape-scale biomass.

    Reuses window_for and the SCL 4-7 clear mask, so a user comparing this
    against flood_extent on one date is comparing the same imagery.
    """
    start, end = window_for(date, S2_LOOKBACK_DAYS)
    region = _region(ee)
    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start, end)
    )
    n_images = scene_count(collection, "Sentinel-2", start, end)

    def clear_evi(image):
        scl = image.select("SCL")
        # SCL 4-7 retains vegetation, bare ground, water and unclassified land;
        # it screens no-data, bad pixels, shadow, cloud, cirrus and snow/ice.
        clear = scl.gte(4).And(scl.lte(7))
        # Scale to reflectance BEFORE the expression. EVI's +L and its
        # coefficients assume 0..1; on raw DN the constant is rounding noise and
        # the result looks entirely plausible while being wrong everywhere. NDVI
        # hid this because a normalised difference cancels the scale — EVI does
        # not. HARMONIZED is load-bearing too: it shifts post-2022 scenes back to
        # the original baseline, so one scale factor is right across the archive.
        bands = image.updateMask(clear).select(["B8", "B4", "B2"]).multiply(
            S2_REFLECTANCE_SCALE
        )
        evi = bands.expression(
            "gain * ((nir - red) / (nir + c1 * red - c2 * blue + L))",
            {
                "nir": bands.select("B8"),
                "red": bands.select("B4"),
                "blue": bands.select("B2"),
                "gain": EVI_GAIN,
                "c1": EVI_C1,
                "c2": EVI_C2,
                "L": EVI_L,
            },
        ).rename("EVI")
        # The denominator can approach zero over bright or noisy pixels and throw
        # the value to thousands, which drags the median with it.
        return evi.clamp(-1, 1)

    evi = collection.map(clear_evi).median()
    # Masked at or below 0: water and deep shadow return negative EVI, and
    # tinting them brown would read as bare ground.
    image = (
        evi.updateMask(evi.gt(0))
        .visualize(min=0, max=EVI_MAX, palette=EVI_PALETTE)
        .clip(region)
    )
    return image, n_images, (start, end), {}


def build_soil_moisture(ee, hf, date: str):
    """SMAP L4 surface soil moisture (0-5 cm), m3/m3.

    Informs §6.3.2(a) soil-condition checking, and gives §6.3.2(c) ponding an
    antecedent-wetness reading: saturated ground is what turns the next rainfall
    into standing water.

    9 km pixels. One pixel covers many sites and every compound inside them, so
    this is regional wetness state, never site bearing capacity.
    """
    day_end = parse_date(date) + timedelta(days=1)
    day_start = day_end - timedelta(days=SMAP_LOOKBACK_DAYS)
    window_start, window_end = iso(day_start), iso(day_end)
    collection = (
        ee.ImageCollection(SMAP_ASSET)
        .filterDate(window_start, window_end)
        .select(SMAP_BAND)
        .sort("system:time_start", False)
    )
    # Forces the round trip now. An asset id that no longer exists — SMAP L4 v007
    # was withdrawn from the catalogue — would otherwise sail through getMapId()
    # and surface as blank tiles, the one failure this whole stack is arranged to
    # avoid.
    try:
        stamps = collection.aggregate_array("system:time_start").getInfo()
    except Exception as error:
        raise LayerUnavailable(
            f"Earth Engine could not read {SMAP_ASSET} ({error}). SMAP L4 versions "
            "are withdrawn as new ones land; check the Earth Engine catalogue for "
            "the current SPL4SMGP version and update SMAP_ASSET."
        ) from error
    if not stamps:
        raise LayerUnavailable(
            f"no SMAP L4 soil moisture between {day_start.date()} and {day_end.date()}. "
            f"This window is {SMAP_LOOKBACK_DAYS} days wide and already allows for the "
            "product's usual publication lag, so the collection is likely behind — "
            "try an earlier date."
        )
    observed = datetime.fromtimestamp(max(stamps) / 1000, tz=timezone.utc)
    # Most recent granule, not a mean: soil moisture is a state, and averaging a
    # week of it would blur exactly the wetting the layer is read for.
    image = (
        collection.first()
        .visualize(min=0.05, max=0.5, palette=SOIL_MOISTURE_PALETTE)
        .clip(_region(ee))
    )
    # `scenes` and `source_count` stay None deliberately. How many granules sat
    # in the lookback says nothing a reader needs — only one of them is drawn.
    # What matters is which, and how old, so `observed_at` carries it alone. The
    # window is the range searched, as it is on every other layer.
    return image, None, (window_start, window_end), {"observed_at": iso(observed)}


def build_soil_texture(ee, hf, date: str):
    """OpenLandMap clay fraction at 0 cm, % (kg/kg).

    Informs §6.3.2(a) and (b): clay-rich ground shrinks and swells with wetting
    and drying, a common driver of the compound cracking and differential
    settlement those clauses ask owners to watch for.

    A 250 m machine-learning prediction with its own uncertainty, not a borehole.
    It says what kind of ground an area tends to have. It does not say what is
    under one foundation.
    """
    clay = ee.Image(CLAY_ASSET).select(CLAY_BAND)
    image = clay.visualize(min=2, max=60, palette=CLAY_PALETTE).clip(_region(ee))
    return image, None, None, {}


LAND_LAYERS: tuple[Layer, ...] = (
    Layer(
        layer_id="ground_slope",
        label="Ground slope",
        description=(
            "Terrain slope from Copernicus GLO-30, the same surface the per-tower "
            "slope figure comes from. Context for the slope analysis and slope "
            "turfing a site audit covers (MCMC MTSFB TC G041:2023 §6.3.2 d, §6.3.3 a), "
            "not a slope-stability study: a compound cut into a hillside can be much "
            "steeper than its 30 m pixel."
        ),
        kind="ee",
        dated=False,
        unit="°",
        attribution="Copernicus DEM GLO-30 (© ESA, ESA/Airbus/DLR)",
        legend=[
            {"label": "0–5°", "color": "#e8f2e0"},
            {"label": "5–15°", "color": "#a8d08d"},
            {"label": "15–25°", "color": "#f2c94c"},
            {"label": "25–35°", "color": "#e07b39"},
            {"label": "≥35°", "color": "#b03030"},
        ],
        builder=build_ground_slope,
        bounds=LAND_LAYER_BBOX,
        group="land",
    ),
    Layer(
        layer_id="land_cover",
        label="Land cover · 2021",
        description=(
            "ESA WorldCover 10 m, the 2021 epoch — what surrounds each structure. "
            "One fixed classification, not a current view and not a change detector: "
            "clearing or regrowth since 2021 does not appear here."
        ),
        kind="ee",
        dated=False,
        attribution="ESA WorldCover 10 m 2021 v200 (CC BY 4.0) · Zanaga et al. 2022",
        legend=[
            {"label": label, "color": f"#{color}"}
            for _, label, color in WORLDCOVER_CLASSES
        ],
        builder=build_land_cover,
        bounds=LAND_LAYER_BBOX,
        group="land",
    ),
    Layer(
        layer_id="vegetation_vigour",
        label="Vegetation vigour (EVI)",
        description=(
            "Cloud-masked Sentinel-2 EVI over the same window the flood layers use. "
            "Greenness of ground cover around a site — context for turfing and grass "
            "maintenance (§6.3.3). EVI rather than NDVI because NDVI saturates in "
            "dense tropical canopy and stops separating plantation from forest. It is "
            "not canopy height, not clearance from the structure, and far too coarse "
            "to show the 1 m perimeter cut §6.3.3(b) requires."
        ),
        kind="ee",
        unit="EVI",
        attribution="Copernicus Sentinel-2 SR (harmonized) · EVI after Huete et al.",
        legend=[
            {"label": "0.0 bare/hard", "color": "#a1683a"},
            {"label": "0.2", "color": "#d9c27e"},
            {"label": "0.4", "color": "#b6d47a"},
            {"label": "0.6", "color": "#5aa832"},
            {"label": "≥0.8 dense", "color": "#1f6b1f"},
        ],
        builder=build_vegetation_vigour,
        bounds=LAND_LAYER_BBOX,
        group="land",
    ),
    Layer(
        layer_id="soil_moisture",
        label="Surface soil moisture",
        description=(
            "SMAP L4 surface soil moisture, 0–5 cm, from the most recent granule at "
            "or before the selected date. Antecedent wetness — saturated ground is "
            "what turns the next rainfall into standing water (§6.3.2 a, c). At 9 km "
            "one pixel covers many sites; this is regional state, never site bearing "
            "capacity."
        ),
        kind="ee",
        unit="m³/m³",
        attribution="NASA SMAP L4 Global 3-hourly 9 km (SPL4SMGP v008)",
        legend=[
            {"label": "0.05 dry", "color": "#b8860b"},
            {"label": "0.2", "color": "#8fc7c0"},
            {"label": "0.35", "color": "#3d7fd4"},
            {"label": "0.50 saturated", "color": "#1d4e89"},
        ],
        builder=build_soil_moisture,
        bounds=LAND_LAYER_BBOX,
        group="land",
    ),
    Layer(
        layer_id="soil_texture",
        label="Soil clay content",
        description=(
            "OpenLandMap clay fraction at 0 cm. Clay-rich ground shrinks and swells "
            "with wetting and drying, a common driver of the compound cracking and "
            "settlement §6.3.2(a) and (b) ask owners to watch for. A 250 m modelled "
            "prediction with its own uncertainty — it describes an area's ground, not "
            "what is under one foundation."
        ),
        kind="ee",
        dated=False,
        unit="% clay",
        attribution="OpenLandMap (CC BY-SA 4.0) · Hengl 2018, doi:10.5281/zenodo.1476854",
        legend=[
            {"label": "2%", "color": "#ffffcc"},
            {"label": "20%", "color": "#78c679"},
            {"label": "≥60%", "color": "#006837"},
        ],
        builder=build_soil_texture,
        bounds=LAND_LAYER_BBOX,
        group="land",
    ),
)

BY_ID = {layer.layer_id: layer for layer in LAND_LAYERS}
