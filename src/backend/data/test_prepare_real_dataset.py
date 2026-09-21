"""Unit tests for deterministic real-source parsing and validation."""

import csv
import io
import json
from prepare_real_dataset import (
    OBSERVATION_COLUMNS,
    parse_geospatial_page,
    parse_observations,
    primary_series_ids,
)


def test_parse_geospatial_next_frame():
    tools = [{
        "id": "1", "name": "Example", "slug": "example",
        "websiteUrl": "https://example.test", "categories": [],
    }]
    chunk = '1e:{"tools":' + json.dumps(tools) + ',"children":[]}'
    frame = json.dumps([1, chunk])
    html = f"<script>self.__next_f.push({frame})</script>"
    assert parse_geospatial_page(html) == tools


def test_primary_series_expands_collection_overviews():
    details = [
        {"codeID": 10},
        {"collection": "Grouped", "codes": [{
            "collectionOverview": [{"codeID": 20}],
            "indicatorOverview": [{"codeID": 21}],
        }]},
    ]
    assert primary_series_ids(details) == [10, 20, 21]


def test_parse_observations_repairs_unquoted_source_newline():
    output = io.StringIO(newline="")
    writer = csv.writer(output, lineterminator="\n")
    writer.writerow(OBSERVATION_COLUMNS)
    prefix = [
        "1", "code", "Series", "unit", "database", "2025", "Malaysia", "MYS",
        "", "", "", "1.2", "", "Ministry of Posts and ",
    ]
    writer.writerow(prefix)
    writer.writerow(["Telematics", "2026-01-01"])
    rows, repaired = parse_observations(output.getvalue().encode())
    assert repaired == 1
    assert len(rows) == 1
    assert rows[0]["Source"] == "Ministry of Posts and \nTelematics"
    assert rows[0]["LastModifiedOn"] == "2026-01-01"


if __name__ == "__main__":
    for name, function in sorted(globals().items()):
        if name.startswith("test_"):
            function()
            print("ok", name)
