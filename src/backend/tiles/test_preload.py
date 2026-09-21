"""Run: .venv/bin/python -m pytest tiles/test_preload.py -q (no network)."""
import json
import threading
import time
from datetime import timedelta
from email.message import Message
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError

import pytest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api.routes import flood, land, fire, maps
from tiles import engine, preload, ee_session

PNG = b"\x89PNG\r\n\x1a\nrendered-test-tile"
DATE = "2026-09-12"


class ImageResponse:
    status = 200
    headers = Message()
    headers["Content-Type"] = "image/png"

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return PNG


def payload(layer, date, sensor="", *, refresh=False):
    return {"layer_id": layer.layer_id, "date": date if layer.dated else None,
            "sensor": sensor or None, "tile_url": f"https://example.test/{layer.layer_id}/{time.time_ns()}/{{z}}/{{x}}/{{y}}",
            "tile_access": "public", "forecast": None,
            "expires_at": engine.iso(engine._now() + timedelta(hours=1))}


def finish(service):
    for future, _ in list(service.jobs.values()):
        future.result(timeout=5)


def test_startup_never_fetches_and_manual_reload_covers_all_variants():
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload), \
            patch.object(preload, "tile_coords", return_value={(4, 12, 7)}), \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            service.start()
            assert not service.jobs
            assert all(row["state"] == "unavailable" for row in service.status(DATE)["layers"])
            service.reload(DATE)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                status = service.status(DATE)
                if all(row["state"] == "ready" for row in status["layers"]):
                    break
                time.sleep(.01)
            assert all(row["state"] == "ready" for row in status["layers"]), status
            expected = {(layer.layer_id, sensor["id"] if sensor else None)
                        for layer in (*preload.FLOOD_LAYERS, *preload.LAND_LAYERS, *preload.FIRE_LAYERS)
                        if layer.kind != "static" for sensor in (layer.sensors or (None,))}
            expected |= {(f"hand_{stage:g}", None) for stage in preload.STAGES}
            assert {(row["layer_id"], row["sensor"]) for row in status["layers"]} == expected
            assert all(call.args[0].group != "backhaul" for call in engine.tiles_for.call_args_list)
        finally:
            service.close()


def test_status_lists_saved_dates_without_fetching_unsaved_today():
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload), \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            assert service.status(DATE)["saved_dates"] == []
            for layer, date in [(preload.BY_ID["soil_moisture"], DATE),
                                (preload.BY_ID["active_fire"], "2026-09-10"),
                                (preload.BY_ID["land_cover"], "2026-09-13")]:
                service.queue(layer, date, "", {(4, 12, 7)})
            finish(service)
            with service.db:
                # Incomplete and obsolete snapshots must not become the default date.
                key = service.key(preload.BY_ID["soil_moisture"], "2026-09-13", "")
                service.db.execute("INSERT INTO snapshots (id,cache_key,payload,ready) VALUES ('unfinished',?,'{}',0)", (key,))
                old_key = json.loads(key)
                old_key[0] = "obsolete-version"
                service.db.execute("INSERT INTO snapshots (id,cache_key,payload,ready) VALUES ('obsolete',?,'{}',1)", (json.dumps(old_key),))
            with patch.object(engine, "tiles_for", side_effect=AssertionError("unexpected EE request")), \
                    patch.object(preload.urllib.request, "urlopen", side_effect=AssertionError("unexpected network request")):
                status = service.status("2026-09-13")
                assert status["date"] == "2026-09-13"
                assert status["saved_dates"] == [DATE, "2026-09-10"]
                assert next(r for r in status["layers"] if r["layer_id"] == "soil_moisture")["state"] == "unavailable"
        finally:
            service.close()


def test_rendered_cache_survives_restart_and_all_routes_read_it_without_upstream():
    app = FastAPI()
    for router in (flood.router, land.router, fire.router, maps.router):
        app.include_router(router)
    with TemporaryDirectory() as directory:
        path = Path(directory) / "cache.db"
        service = preload.MapPreloader(path)
        try:
            with patch.object(engine, "tiles_for", side_effect=payload), \
                    patch.object(preload, "tile_coords", return_value={(4, 12, 7), (5, 24, 15)}), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                service.reload(DATE)
                finish(service)
        finally:
            service.close()
        service = preload.MapPreloader(path)
        release_downloads = threading.Event()
        try:
            for _ in range(8):
                service.images.submit(release_downloads.wait)
            sid = service.snapshot(service.key(preload.BY_ID["land_cover"], DATE, ""))[0]
            assert service.fetch(sid, 4, 12, 7).result(timeout=.5)[0] == PNG, "ready tiles must bypass busy download workers"
            sid = service.snapshot(service.key(preload.BY_ID["permanent_water"], DATE, ""))[0]
            assert service.fetch(sid, 5, 24, 15).result(timeout=.5)[0] == PNG
            with patch.object(preload, "_service", service), \
                    patch.object(engine, "tiles_for", side_effect=AssertionError("request rebuilt a map")), \
                    patch.object(preload.urllib.request, "urlopen", side_effect=AssertionError("request rendered a tile")), \
                    TestClient(app) as client:
                for route, layer in (("flood", "flood_extent"), ("land", "soil_moisture"), ("fire", "active_fire")):
                    response = client.get(f"/{route}/tiles/{layer}?date={DATE}")
                    assert response.status_code == 200, response.text
                    url = response.json()["tile_url"]
                    tile = client.get(url.format(z=4, x=12, y=7))
                    assert tile.status_code == 200 and tile.content == PNG
                assert client.get("/maps/hand/2/4/12/7").content == PNG
                assert client.get("/land/tiles/soil_moisture?date=bad").status_code == 400
                assert "frontend" in client.get(f"/flood/tiles/potential_depth?date={DATE}").json()["detail"]
                assert client.get(f"/flood/tiles/flood_extent?date={DATE}&sensor=bad").status_code == 400
                assert client.get("/maps/tiles/" + "a" * 32 + "/17/0/0").status_code == 400
                assert client.post("/maps/preload", json={"date": DATE, "bounds": [-180, -85, 180, 85], "zoom": 16}).status_code == 400
                assert client.post("/maps/preload", json={"date": DATE, "bounds": [1, 2, 0, 3], "zoom": 4}).status_code == 422
        finally:
            release_downloads.set()
            service.close()


def test_duplicate_preparation_is_coalesced_and_refresh_keeps_previous_ready_map():
    layer = preload.BY_ID["land_cover"]
    entered, release = threading.Event(), threading.Event()
    def render(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return ImageResponse()
    with TemporaryDirectory() as directory:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            with patch.object(engine, "tiles_for", side_effect=payload) as build, \
                    patch.object(preload.urllib.request, "urlopen", side_effect=render) as download:
                service.queue(layer, DATE, "", {(4, 12, 7)})
                assert entered.wait(5)
                for _ in range(5):
                    service.queue(layer, DATE, "", {(4, 12, 7)})
                assert service.snapshot(service.key(layer, DATE, "")) is None, "metadata alone isn't ready"
                release.set()
                finish(service)
                assert build.call_count == download.call_count == 1
                old = service.tiles_for(layer, DATE)
                with service.lock, service.db:
                    service.db.execute("UPDATE snapshots SET refresh_at=?", (time.time() - 1,))
                entered.clear()
                release.clear()
                service.queue(layer, DATE, "", {(4, 12, 7)})
                assert entered.wait(5)
                assert service.tiles_for(layer, DATE)["tile_url"] == old["tile_url"]
                release.set()
                finish(service)
                assert service.tiles_for(layer, DATE)["tile_url"] != old["tile_url"]
        finally:
            release.set()
            service.close()


def test_failed_sources_retry_without_blocking_siblings_and_expired_urls_keep_saved_tiles():
    with TemporaryDirectory() as directory:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        bad, good = preload.BY_ID["soil_texture"], preload.BY_ID["land_cover"]
        def build(layer, *args, **kwargs):
            if layer == bad:
                raise engine.LayerUnavailable("source unavailable")
            return payload(layer, *args, **kwargs)
        try:
            with patch.object(engine, "tiles_for", side_effect=build), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                for layer in (bad, good):
                    service.queue(layer, DATE, "", {(4, 12, 7)})
                finish(service)
                assert service.snapshot(service.key(good, DATE, ""))
                assert not service.snapshot(service.key(bad, DATE, ""))
                assert service.errors[service.key(bad, DATE, "")][1] == "source unavailable"
            with patch.object(engine, "tiles_for", side_effect=payload), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()), \
                    patch.object(preload, "RETRY_SECONDS", 0):
                service.queue(bad, DATE, "", {(4, 12, 7)})
                finish(service)
                assert service.snapshot(service.key(bad, DATE, ""))
            with service.lock, service.db:
                service.db.execute("UPDATE snapshots SET expires=?", (time.time() - 1,))
            saved = service.tiles_for(good, DATE)
            sid = saved["tile_url"].split("/")[3]
            assert not saved["cache_stale"], "source URL expiry must not expire the rendered buffer"
            assert service.fetch(sid, 4, 12, 7).result(timeout=1)[0] == PNG
            with service.lock, service.db:
                service.db.execute("UPDATE snapshots SET refresh_at=?", (time.time() - 1,))
            assert not service.tiles_for(good, DATE)["cache_stale"]
            with service.lock, service.db:
                service.db.execute("UPDATE snapshots SET refresh_at=?", (time.time() - 365 * 24 * 3600,))
            assert service.snapshot(service.key(good, DATE, "")) is not None
        finally:
            service.close()


def test_manual_reload_is_serial_and_saved_maps_do_not_expire_or_refresh_on_restart():
    clock = [engine._now()]
    events = []
    def build(layer, *args, **kwargs):
        events.append("build")
        return payload(layer, *args, **kwargs)
    def render(*args, **kwargs):
        events.append("tile")
        return ImageResponse()
    with TemporaryDirectory() as directory, \
            patch.object(engine, "_now", side_effect=lambda: clock[0]), \
            patch.object(preload.time, "time", side_effect=lambda: clock[0].timestamp()), \
            patch.object(preload, "tile_coords", return_value={(4, 12, 7)}), \
            patch.object(engine, "tiles_for", side_effect=build) as builds, \
            patch.object(preload.urllib.request, "urlopen", side_effect=render) as downloads:
        path = Path(directory) / "cache.db"
        service = preload.MapPreloader(path)
        try:
            service.reload(DATE)
            finish(service)
            assert builds.call_count == downloads.call_count == 22
            assert events == ["build", "tile"] * 22
            service.close()
            service = preload.MapPreloader(path)
            clock[0] += timedelta(days=365)
            service.start()
            for _ in range(3):
                service.enqueue(DATE, (101, 3, 102, 4), 12)
                service.enqueue("2025-01-01")
            assert not service.jobs
            assert builds.call_count == downloads.call_count == 22
            status = service.status(DATE)
            assert status["refresh_interval_seconds"] is None
            assert all(row["state"] == "ready" and row["next_refresh_at"] is None for row in status["layers"])
            service.reload(DATE)
            finish(service)
            assert builds.call_count == 44
        finally:
            service.close()


def test_reload_api_keeps_buffer_visible_and_coalesces_repeated_clicks():
    entered, release = threading.Event(), threading.Event()
    def render(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return ImageResponse()
    app = FastAPI()
    app.include_router(maps.router)
    with TemporaryDirectory() as directory, \
            patch.object(preload, "tile_coords", return_value={(4, 12, 7)}), \
            patch.object(engine, "tiles_for", side_effect=payload) as builds:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            with patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                service.reload(DATE)
                finish(service)
            old = service.status(DATE)
            builds.reset_mock()
            with patch.object(preload.urllib.request, "urlopen", side_effect=render), \
                    patch.object(preload, "_service", service), TestClient(app) as client:
                assert client.post("/maps/reload?date=bad").status_code == 400
                assert client.post(f"/maps/reload?date={DATE}", json={"date": "2025-01-01", "bounds": [101, 3, 102, 4], "zoom": 12}).status_code == 400
                assert client.post(f"/maps/reload?date={DATE}", json={"date": DATE, "bounds": [-180, -85, 180, 85], "zoom": 16}).status_code == 400
                response = client.post(f"/maps/reload?date={DATE}", json={"date": DATE, "bounds": [101, 3, 101.1, 3.1], "zoom": 12})
                assert response.status_code == 202 and entered.wait(5)
                assert service.views[DATE][:2] == ((101, 3, 101.1, 3.1), 12)
                assert all(row["loading"] for row in response.json()["layers"])
                for _ in range(3):
                    assert client.post(f"/maps/reload?date={DATE}").status_code == 202
                for row in old["layers"]:
                    assert client.get(row["tile_url"].format(z=4, x=12, y=7)).content == PNG
                release.set()
                finish(service)
                status = client.get(f"/maps/status?date={DATE}").json()
                assert builds.call_count == 22
                assert all(not row["loading"] and not row["cache_stale"] for row in status["layers"])
                assert all(before["tile_url"] != after["tile_url"] for before, after in zip(old["layers"], status["layers"]))
        finally:
            release.set()
            service.close()


def test_uncached_tiles_and_dates_never_contact_source_even_after_url_expiry():
    layer = preload.BY_ID["soil_moisture"]
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload) as build, \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()) as download:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            service.queue(layer, DATE, "", {(4, 12, 7)})  # A manual worker pass.
            finish(service)
            sid = service.snapshot(service.key(layer, DATE, ""))[0]
            with service.db:
                service.db.execute("UPDATE snapshots SET expires=0, refresh_at=0")
            assert service.fetch(sid, 4, 12, 7).result(timeout=1)[0] == PNG
            for coord in [(4, 13, 7), (10, 800, 503)]:
                with pytest.raises(engine.LayerUnavailable, match="Reload all maps"):
                    service.fetch(sid, *coord).result(timeout=1)
            with pytest.raises(engine.LayerUnavailable, match="Reload all maps"):
                service.tiles_for(layer, "2025-01-01")
            service.enqueue(DATE, (101, 3, 102, 4), 12)
            assert build.call_count == download.call_count == 1
            assert service.tiles_for(layer, DATE)["expires_at"] is None
            with patch.object(preload, "_service", None), pytest.raises(engine.LayerUnavailable):
                preload.prepared_tiles_for(layer, DATE)
            assert build.call_count == 1
        finally:
            service.close()


def test_429_stops_queued_siblings_and_cooldown_survives_restart_and_manual_reload():
    layer = preload.BY_ID["soil_moisture"]
    clock = [time.time()]
    headers = Message()
    headers["Retry-After"] = "120"
    limited = HTTPError("https://example.test", 429, "Too Many Requests", headers, None)
    def build(item, *args, **kwargs):
        if item.kind == "ee":
            # The URL probe wraps HTTP errors; the shared queue must retain them.
            engine._probe_image_access("https://example.test")
        return payload(item, *args, **kwargs)
    with TemporaryDirectory() as directory, \
            patch.object(preload.time, "time", side_effect=lambda: clock[0]), \
            patch.object(preload, "tile_coords", return_value={(4, 12, 7)}), \
            patch.object(engine, "tiles_for", side_effect=build) as builds, \
            patch.object(preload.urllib.request, "urlopen", side_effect=limited) as network:
        path = Path(directory) / "cache.db"
        service = preload.MapPreloader(path)
        try:
            for item in preload.LAYERS:
                if item.kind == "ee":
                    for sensor in ([s["id"] for s in item.sensors] or [""]):
                        service.queue(item, DATE, sensor, {(4, 12, 7)})
            finish(service)
            assert builds.call_count == network.call_count == 1
            assert service.retry_at == clock[0] + 120
            service.close()
            service = preload.MapPreloader(path)
            # Public WMS providers still work while EE is paused.
            with patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                service.reload(DATE)
                finish(service)
            assert service.cooldown(layer)
            assert network.call_count == 1
            assert all(row["state"] == "ready" for row in service.status(DATE)["layers"] if row["layer_id"].startswith("hand_"))
            clock[0] += 121
            headers.replace_header("Retry-After", "0")
            service.queue(layer, DATE, "", {(4, 12, 7)})
            finish(service)
            assert network.call_count == 2
            assert service.retry_at == clock[0] + 120, "successive 429s increase the backoff"
        finally:
            service.close()


def test_shutdown_cancels_queue_without_starting_another_request():
    entered, release = threading.Event(), threading.Event()
    def render(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return ImageResponse()
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload) as build, \
            patch.object(preload.urllib.request, "urlopen", side_effect=render) as download:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        service.reload(DATE)
        assert entered.wait(5)
        closing = threading.Thread(target=service.close)
        closing.start()
        try:
            assert service.stopped.wait(1)
        finally:
            release.set()
            closing.join(5)
        assert not closing.is_alive()
        assert build.call_count == download.call_count == 1


def test_hand_rendering_matches_depth_bands_and_wms_tiles_use_mercator_bounds():
    for stage in preload.STAGES:
        rule = json.loads(parse_qs(urlparse(preload.hand_url(stage)).query)["renderingRule"][0])
        remap = rule["rasterFunctionArguments"]["Raster"]["rasterFunctionArguments"]
        assert remap["OutputValues"] == ([2, 1] if stage == .5 else [3, 2, 1] if stage == 1 else [4, 3, 2, 1])
        ranges = remap["InputRanges"]
        for i in range(0, len(ranges), 2):
            assert ranges[i] < ranges[i + 1]
            if i:
                assert ranges[i] == ranges[i - 1]
        assert ranges[-1] == remap["NoDataRanges"][0]
    bbox = preload.tile_url("https://example.test?bbox={bbox-epsg-3857}", 0, 0, 0)
    assert bbox.endswith("-20037508.342789244,-20037508.342789244,20037508.342789244,20037508.342789244")


def test_reload_covers_every_zoom_through_eight_and_limits_all_sources_to_asean():
    with TemporaryDirectory() as directory:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        try:
            with patch.object(service, "queue") as queue:
                service.enqueue(DATE, reload=True)
                assert len(queue.call_args_list) == 22
                assert sum(len(call.args[3]) for call in queue.call_args_list) == 31326
                for call in queue.call_args_list:
                    assert {coord[0] for coord in call.args[3]} == set(range(9))
                queue.reset_mock()
                service.enqueue(DATE, (80, 2, 81, 3), 5, reload=True)
                queue.assert_not_called()
                queue.reset_mock()
                service.enqueue(DATE, (101.60, 3.06, 101.62, 3.08), 16, reload=True)
                for call in queue.call_args_list:
                    layer, date, _, coords = call.args
                    assert date == DATE
                    assert {coord[0] for coord in coords} == {8}
        finally:
            service.close()


def test_earth_engine_permission_is_scoped_to_manual_workers_even_after_initialization():
    from concurrent.futures import ThreadPoolExecutor
    fake_ee = object()
    with patch.object(ee_session, "manual_only", True), patch.object(ee_session, "_initialised", True), \
            patch.object(ee_session, "_import_ee", return_value=fake_ee) as sdk:
        with pytest.raises(engine.LayerUnavailable, match="Reload all maps"):
            ee_session.initialise()
        sdk.assert_not_called()
        with ee_session.allow_requests():
            assert ee_session.initialise() is fake_ee
            with ThreadPoolExecutor(max_workers=1) as pool:
                with pytest.raises(engine.LayerUnavailable, match="Reload all maps"):
                    pool.submit(ee_session.initialise).result()
        with pytest.raises(engine.LayerUnavailable, match="Reload all maps"):
            ee_session.initialise()
        assert sdk.call_count == 1


def test_api_startup_and_uncached_screening_never_initialize_earth_engine():
    from api.main import lifespan
    from tiles.supabase_store import SupabaseMapStore
    from thermal import exposure
    from flood import forecast
    app = FastAPI(lifespan=lifespan)
    for router in (maps.router, flood.router, land.router, fire.router):
        app.include_router(router)
    with TemporaryDirectory() as directory:
        service = preload.MapPreloader(Path(directory) / "cache.db")
        with patch.object(preload, "MapPreloader", return_value=service), \
                patch.object(SupabaseMapStore, "from_env", return_value=None), \
                patch.object(ee_session, "_import_ee", side_effect=AssertionError("unexpected EE call")) as sdk, \
                patch.dict(exposure._snapshots, {}, clear=True), patch.object(forecast, "_cache", None), \
                TestClient(app) as client:
            assert client.post("/maps/preload", json={"date": DATE, "bounds": [101, 3, 102, 4], "zoom": 8}).json()["status"] == "view_saved"
            assert client.get(f"/maps/status?date={DATE}").json()["refresh_interval_seconds"] is None
            for route in (f"/flood/tiles/flood_extent?date={DATE}", f"/land/tiles/soil_moisture?date={DATE}",
                          f"/fire/tiles/active_fire?date={DATE}", f"/fire/exposure?date={DATE}",
                          "/maps/tiles/" + "a" * 32 + "/12/3200/2010"):
                response = client.get(route)
                assert response.status_code == 503, response.text
                assert "Reload all maps" in response.json()["detail"]
            assert forecast.sample_weather_hazard([{"tower_id": "T1", "lon": 101, "lat": 3}],
                                                  {"weather_hazard": {"enabled": True}}) is None
            assert not service.jobs
            sdk.assert_not_called()
            fake_ee = object()
            def build(layer, date, sensor="", **kwargs):
                assert ee_session.initialise() is fake_ee
                return payload(layer, date, sensor, **kwargs)
            with patch.object(ee_session, "_import_ee", return_value=fake_ee), \
                    patch.object(ee_session, "_initialised", True), \
                    patch.object(engine, "tiles_for", side_effect=build) as builds, \
                    patch.object(preload, "tile_coords", return_value={(4, 12, 7)}), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                assert client.post(f"/maps/reload?date={DATE}").status_code == 202
                finish(service)
                assert builds.call_count == 22
                assert all(row["state"] == "ready" for row in service.status(DATE)["layers"])


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
