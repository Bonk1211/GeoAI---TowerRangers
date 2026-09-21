import math

import numpy as np
import pandas as pd
import pytest

from prepare_pilot_dataset import (
    MODEL_COLUMNS,
    SourceError,
    distance_to_paths_m,
    exposure_polygon,
    point_in_polygon,
    sample_array,
    terrain_arrays,
    validate_features,
)


def test_flat_dem_has_zero_slope_and_tri():
    dem = np.full((5, 6), 42.0)
    slope, tri = terrain_arrays(dem, (101.0, 3.0, 101.01, 3.01))

    np.testing.assert_allclose(slope, 0)
    np.testing.assert_allclose(tri, 0)


def test_sample_array_uses_north_up_grid():
    raster = np.array([[1.0, 2.0], [3.0, 4.0]])
    values = sample_array(
        raster,
        pd.Series([100.25, 100.75]),
        pd.Series([3.75, 3.25]),
        (100.0, 3.0, 101.0, 4.0),
    )

    np.testing.assert_array_equal(values, [1.0, 4.0])


def test_distance_to_paths_handles_lines_points_and_polygons():
    polygon = [
        (101.0, 3.0), (101.01, 3.0), (101.01, 3.01),
        (101.0, 3.01), (101.0, 3.0),
    ]
    assert point_in_polygon((101.005, 3.005), polygon)
    assert distance_to_paths_m(101.005, 3.005, [(polygon, True)]) == 0

    point_distance = distance_to_paths_m(
        101.0, 3.0, [([(101.0, 3.001)], False)]
    )
    assert point_distance == pytest.approx(110.574, rel=0.01)

    line_distance = distance_to_paths_m(
        101.0, 3.0,
        [([(100.99, 3.001), (101.01, 3.001)], False)],
    )
    assert line_distance == pytest.approx(110.574, rel=0.01)


def test_worldpop_exposure_polygon_is_about_one_square_kilometre():
    polygon = exposure_polygon(101.6, 3.06)
    ring = polygon["coordinates"][0]
    width = (ring[1][0] - ring[0][0]) * 111_320 * math.cos(math.radians(3.06))
    height = (ring[2][1] - ring[1][1]) * 110_574

    assert width == pytest.approx(1000.0)
    assert height == pytest.approx(1000.0)
    assert ring[0] == ring[-1]


def test_feature_validation_only_allows_documented_missing_fields():
    rows = []
    for index in range(2):
        row = {column: 1.0 for column in MODEL_COLUMNS}
        row.update({
            "tower_id": f"T{index}", "lon": 101.6, "lat": 3.06,
            "radio": "NR", "flash_density": np.nan, "age_years": np.nan,
        })
        rows.append(row)
    report = validate_features(pd.DataFrame(rows))

    assert report["rows"] == 2
    assert not report["model_contract_complete"]
    assert report["missing_by_model_column"]["flash_density"] == 2

    broken = pd.DataFrame(rows)
    broken.loc[0, "hand_m"] = np.nan
    with pytest.raises(SourceError, match="invalid populated model fields"):
        validate_features(broken)
