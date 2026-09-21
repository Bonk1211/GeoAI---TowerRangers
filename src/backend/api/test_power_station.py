"""Network-free contract check: python3 api/test_power_station.py."""
import json
import math
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import towers
from data import power_stations


def test_station_lookup():
    app = FastAPI()
    app.include_router(towers.router)
    client = TestClient(app)
    tower = {"tower_id": "SITE", "lon": 101.5, "lat": 3.5}
    with TemporaryDirectory() as directory, patch.object(power_stations, "CACHE_DIR", Path(directory)), patch.object(towers, "tower_points", return_value=[tower]):
        url = "/towers/SITE/power-station"
        assert client.get("/towers/unknown/power-station").status_code == 404
        missing = client.get(url).json()
        assert missing["status"] == "unavailable" and missing["station"] is None
        path = Path(directory) / "infra_101_3.json"
        payload = {"osm3s": {"timestamp_osm_base": "2026-09-01T00:00:00Z"}, "elements": [
            # A cable and generator at the tower must never win station lookup.
            {"type": "node", "id": 1, "lon": 101.5, "lat": 3.5, "tags": {"power": "cable"}},
            {"type": "node", "id": 2, "lon": 101.5, "lat": 3.5, "tags": {"power": "generator"}},
            {"type": "node", "id": 3, "lon": 101.52, "lat": 3.5, "tags": {"power": "plant"}},
            {"type": "way", "id": 4, "geometry": [{"lon": 101.509, "lat": 3.499}, {"lon": 101.511, "lat": 3.501}], "tags": {"power": "substation", "name": "Test station"}},
            {"type": "node", "id": 5, "lon": 101.5, "lat": float("nan"), "tags": {"power": "substation"}},
        ]}
        path.write_text(json.dumps(payload))
        reading = client.get(url).json()
        assert reading["status"] == "available"
        assert reading["station"]["osm_id"] == "way/4"
        assert reading["station"]["kind"] == "substation"
        assert reading["station"]["name"] == "Test station"
        assert 1100 < reading["station"]["distance_m"] < 1120
        assert math.isclose(reading["station"]["lon"], 101.51)
        assert reading["source_updated_at"] == "2026-09-01T00:00:00Z"
        assert reading["coverage_bounds"] == [100.95, 2.95, 102.05, 4.05]
        # Changed cache content invalidates the parsed result; no stations is
        # missing evidence, not an all-clear or an invented distant station.
        payload["elements"] = []
        path.write_text(json.dumps(payload))
        assert client.get(url).json()["station"] is None
        path.write_text("{invalid")
        assert client.get(url).json()["status"] == "unavailable"
        payload["remark"] = "query timed out"
        path.write_text(json.dumps(payload))
        assert client.get(url).json()["coverage_bounds"] is None

        # A station across the tile edge beats a farther station in the tower's
        # own tile. The date describes the winning station's saved source.
        tower["lon"] = 101.9
        payload.pop("remark")
        payload["elements"] = [{"type": "node", "id": 10, "lon": 101.5, "lat": 3.5, "tags": {"power": "plant"}}]
        path.write_text(json.dumps(payload))
        adjacent = Path(directory) / "infra_102_3.json"
        payload["osm3s"]["timestamp_osm_base"] = "2026-09-02T00:00:00Z"
        payload["elements"] = [{"type": "node", "id": 11, "lon": 102.1, "lat": 3.5, "tags": {"power": "substation"}}]
        adjacent.write_text(json.dumps(payload))
        reading = client.get(url).json()
        assert reading["station"]["osm_id"] == "node/11"
        assert 22_000 < reading["station"]["distance_m"] < 22_300
        assert reading["source_updated_at"] == "2026-09-02T00:00:00Z"
        # Having stations elsewhere must not manufacture coverage for a tower
        # outside every saved tile (including their query halos).
        tower["lon"] = 103.5
        reading = client.get(url).json()
        assert reading["station"] is None and reading["coverage_bounds"] is None
    power_stations._stations.cache_clear()


if __name__ == "__main__":
    test_station_lookup()
    print("Power station contract check passed")
