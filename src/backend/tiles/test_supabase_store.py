"""Offline checks for durable writes, cold restores and interrupted uploads."""
import json
import os
import threading
import time
from copy import deepcopy
from tempfile import TemporaryDirectory
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse
from urllib.error import HTTPError, URLError

import pytest

from tiles import engine, preload
from tiles.ee_session import LayerUnavailable
from tiles.supabase_store import SupabaseMapStore
from tiles.test_preload import DATE, PNG, ImageResponse, finish, payload


class Cloud(SupabaseMapStore):
    def __init__(self, state=None):
        super().__init__("https://cache.example.test", "sb_secret_test")
        self.state = state if state is not None else {
            "map_snapshots": {}, "map_tiles": {}, "map_rate_limits": {}, "objects": {}}
        self.offline = False
        self.fail_upload = False

    def request(self, path, method="GET", body=None, *, mime="application/json"):
        if self.offline:
            raise LayerUnavailable("Supabase map cache is unreachable")
        if path.startswith("/storage/"):
            if method == "POST":
                if self.fail_upload:
                    raise LayerUnavailable("Supabase upload failed")
                self.state["objects"][path.split("map-cache/")[1]] = body
                return b"{}"
            if method == "DELETE":
                for key in body["prefixes"]:
                    self.state["objects"].pop(key, None)
                return b"[]"
            return self.state["objects"][path.split("map-cache/")[1]]
        parsed = urlparse(path)
        table = parsed.path.rsplit("/", 1)[1]
        query = parse_qs(parsed.query)
        if method == "GET":
            rows = list(self.state[table].values())
            start = int(query.get("offset", [0])[0])
            return json.dumps(rows[start:start + 500]).encode()
        if method == "DELETE":
            sid = query["id"][0].removeprefix("eq.")
            self.state[table].pop(sid, None)
            self.state["map_tiles"] = {k: v for k, v in self.state["map_tiles"].items() if k[0] != sid}
            return b""
        for row in body if isinstance(body, list) else [body]:
            key = (row["snapshot"], row["z"], row["x"], row["y"]) if table == "map_tiles" else row.get("id", row.get("source"))
            self.state[table][key] = deepcopy(row)
        return b""


def restored_service(path, cloud):
    service = preload.MapPreloader(path, cloud=cloud)
    cloud.pull(service)
    service.cloud_loaded = True
    return service


@pytest.mark.parametrize("source_changed", [False, True])
def test_manual_resume_after_restart_reuses_tiles_and_skips_complete_variants(source_changed):
    good, partial = preload.BY_ID["land_cover"], preload.BY_ID["vegetation_vigour"]
    coords = {(4, 12, 7), (5, 24, 15)}
    cloud = Cloud()
    with TemporaryDirectory() as directory:
        path = Path(directory) / "cache.db"
        service = restored_service(path, cloud)
        try:
            with patch.object(engine, "tiles_for", side_effect=payload), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                service.queue(good, DATE, "", coords)
                service.queue(partial, DATE, "", {min(coords)})
                finish(service)
            complete_sid = service.snapshot(service.key(good, DATE, ""))[0]
            partial_sid = service.snapshot(service.key(partial, DATE, ""))[0]
            with service.db:
                service.db.execute("UPDATE snapshots SET expires=0")
                service.db.execute("UPDATE snapshots SET ready=0 WHERE id=?", (partial_sid,))
            cloud.sync_pending(service)
        finally:
            service.close()
        # Restore from cloud metadata: already stored tiles may have no local bytes.
        service = restored_service(Path(directory) / "restored.db", Cloud(cloud.state))
        def renewed(layer, *args, **kwargs):
            result = payload(layer, *args, **kwargs)
            if source_changed:
                result["observed_at"] = "new observation"
            return result
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from api.routes import maps
        app = FastAPI()
        app.include_router(maps.router)
        try:
            with patch.object(preload, "LAYERS", (good, partial)), \
                    patch.object(preload, "tile_coords", return_value=coords), \
                    patch.object(preload, "_service", service), \
                    patch.object(engine, "tiles_for", side_effect=renewed) as build, \
                    patch.object(preload.urllib.request, "urlopen", side_effect=[TimeoutError(), ImageResponse(), ImageResponse()]) as download, \
                    patch.object(service.stopped, "wait", return_value=False), TestClient(app) as client:
                assert client.post(f"/maps/reload?date={DATE}&resume=true").status_code == 202
                finish(service)
                assert build.call_count == 1 and build.call_args.args[0] == partial
                assert download.call_count == (3 if source_changed else 2)
                assert service.snapshot(service.key(good, DATE, ""))[0] == complete_sid
                sid = service.snapshot(service.key(partial, DATE, ""))[0]
                assert (sid != partial_sid) == source_changed
                assert {key[1:] for key in service.cloud.tiles if key[0] == sid} == coords
                assert service.cloud.snapshots[sid]["ready"]
                assert service.cloud.download((partial_sid, *min(coords)))[0] == PNG
                build.reset_mock()
                download.reset_mock()
                client.post(f"/maps/reload?date={DATE}&resume=true")
                finish(service)
                build.assert_not_called()
                download.assert_not_called()
        finally:
            service.close()


@pytest.mark.parametrize("code", [503, 504, 403])
def test_storage_retries_transient_http_errors_only(code):
    cloud = SupabaseMapStore("https://cache.example.test", "sb_secret_test")
    error = HTTPError(cloud.url, code, "test", {}, None)
    with patch("tiles.supabase_store.urllib.request.urlopen", side_effect=[error, ImageResponse()]) as request, \
            patch("tiles.supabase_store.time.sleep"):
        if code == 403:
            with pytest.raises(LayerUnavailable, match="403"):
                cloud.request("/storage/v1/object/map-cache/test", "POST", PNG)
            assert request.call_count == 1
        else:
            assert cloud.request("/storage/v1/object/map-cache/test", "POST", PNG) == PNG
            assert request.call_count == 2
            assert request.call_args_list[0].args[0] is request.call_args_list[1].args[0]


def test_cloud_restore_integrity_and_local_outage_buffer():
    layer = preload.BY_ID["land_cover"]
    coord = (4, 12, 7)
    cloud = Cloud()
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload), \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
        service = restored_service(Path(directory) / "first.db", cloud)
        try:
            service.queue(layer, DATE, "", {coord})
            finish(service)
            sid = service.snapshot(service.key(layer, DATE, ""))[0]
            assert cloud.state["map_snapshots"][sid]["ready"]
            assert len(cloud.state["map_tiles"]) == 1
            assert cloud.download((sid, *coord)) == (PNG, "image/png")
            service.retry_at, service.retry_delay = time.time() + 900, 900
            cloud.sync_pending(service)
        finally:
            service.close()

        restored = Cloud(cloud.state)
        service = restored_service(Path(directory) / "empty.db", restored)
        unblock = threading.Event()
        busy = service.images.submit(unblock.wait)
        try:
            assert service.retry_at > time.time()
            with patch.object(engine, "tiles_for", side_effect=AssertionError("contacted Earth Engine")):
                service.enqueue(DATE)
                assert not service.jobs  # Metadata knows the tile is already durable.
                assert service.fetch(sid, *coord).result(timeout=2) == (PNG, "image/png")
                assert service.db.execute("SELECT count(*) FROM map_sync").fetchone()[0] == 0
                assert not busy.done()  # Cold Storage reads bypass the source queue.
                restored.offline = True
                assert service.fetch(sid, *coord).result(timeout=.1) == (PNG, "image/png")
                restored.offline = False
                restored.state["objects"][restored.object_path((sid, *coord))] = b"corrupt"
                with pytest.raises(LayerUnavailable, match="integrity"):
                    restored.download((sid, *coord))
        finally:
            unblock.set()
            service.close()


def test_compute_project_switch_preserves_saved_maps_but_not_quota_or_asset_source():
    layer = preload.BY_ID["daily_water"]
    coord = (4, 12, 7)
    cloud = Cloud()
    with TemporaryDirectory() as directory, patch.dict(os.environ, {
        "GEE_PROJECT": "old-project", "GEE_DSWFP_ASSET_ROOT": "projects/old-project/assets/dswfp",
    }):
        service = restored_service(Path(directory) / "old.db", cloud)
        try:
            with patch.object(engine, "tiles_for", side_effect=payload), \
                    patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
                service.queue(layer, DATE, "", {coord})
                finish(service)
            key = service.key(layer, DATE, "")
            sid = service.snapshot(key)[0]
            service.retry_at, service.retry_delay = time.time() + 900, 900
            cloud.sync_pending(service)
        finally:
            service.close()

        os.environ["GEE_PROJECT"] = "new-project"
        with patch.object(engine, "tiles_for", side_effect=AssertionError("contacted Earth Engine")), \
                patch.object(preload.urllib.request, "urlopen", side_effect=AssertionError("fetched source tile")):
            service = restored_service(Path(directory) / "new.db", Cloud(cloud.state))
            try:
                assert service.key(layer, DATE, "") == key
                assert service.ee_source == "ee:new-project" and service.retry_at == 0
                assert service.tiles_for(layer, DATE)["tile_url"].split("/")[3] == sid
                assert service.fetch(sid, *coord).result(timeout=2) == (PNG, "image/png")
                with pytest.raises(LayerUnavailable, match="Reload all maps"):
                    service.fetch(sid, 16, 50000, 32000).result(timeout=1)
                service.enqueue(DATE)
                assert not service.jobs
            finally:
                service.close()

            os.environ["GEE_DSWFP_ASSET_ROOT"] = "projects/new-project/assets/dswfp"
            service = restored_service(Path(directory) / "new.db", Cloud(cloud.state))
            try:
                assert service.key(layer, DATE, "") != key
                with pytest.raises(LayerUnavailable, match="Reload all maps"):
                    service.tiles_for(layer, DATE)
            finally:
                service.close()


def test_full_zoom_pyramid_is_stored_in_supabase_before_it_becomes_ready():
    cloud = Cloud()
    layer = preload.BY_ID["surface_water"]
    original = cloud.request
    published = []
    def request(path, method="GET", body=None, **kwargs):
        if path == "/rest/v1/map_snapshots" and method == "POST" and body["ready"]:
            assert len(cloud.state["objects"]) == 133
            assert {row["z"] for row in cloud.state["map_tiles"].values()} == set(range(9))
            published.append(body["id"])
        return original(path, method, body, **kwargs)
    with TemporaryDirectory() as directory, patch.object(preload, "LAYERS", (layer,)), \
            patch.object(engine, "tiles_for", side_effect=payload), \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()), \
            patch.object(cloud, "request", side_effect=request):
        service = restored_service(Path(directory) / "cache.db", cloud)
        try:
            service.reload(DATE)
            finish(service)
            sid = service.snapshot(service.key(layer, DATE, ""))[0]
            assert published == [sid]
            assert service.tiles_for(layer, DATE)["max_zoom"] == 8
            assert service.tiles_for(layer, DATE)["bounds"] == layer.bounds
            assert len(cloud.state["map_tiles"]) == 133
            assert service.status(DATE)["progress"] is None
        finally:
            service.close()


def test_interrupted_upload_keeps_old_map_and_retries_after_restart_without_source():
    layer = preload.BY_ID["land_cover"]
    cloud = Cloud()
    with TemporaryDirectory() as directory, patch.object(engine, "tiles_for", side_effect=payload), \
            patch.object(preload.urllib.request, "urlopen", return_value=ImageResponse()):
        path = Path(directory) / "cache.db"
        service = restored_service(path, cloud)
        try:
            key = service.key(layer, DATE, "")
            service.queue(layer, DATE, "", {(4, 12, 7)})
            finish(service)
            old = service.snapshot(key)[0]
            with service.db:
                service.db.execute("UPDATE snapshots SET refresh_at=?", (time.time() - 1,))
            cloud.fail_upload = True
            service.queue(layer, DATE, "", {(4, 12, 7), (4, 13, 7)})
            finish(service)
            new = service.snapshot(key, ready=False)[0]
            assert new != old
            assert service.snapshot(key)[0] == old
            assert not cloud.state["map_snapshots"][new]["ready"]
            assert service.db.execute("SELECT 1 FROM map_sync WHERE snapshot=?", (new,)).fetchone()
            with pytest.raises(LayerUnavailable, match="upload failed"), service.upstream(layer):
                raise AssertionError("A queued sibling contacted its source after the upload failed")
        finally:
            service.close()

        cloud = Cloud(cloud.state)
        service = restored_service(path, cloud)
        try:
            with patch.object(engine, "tiles_for", side_effect=AssertionError("refetched source")):
                cloud.sync_pending(service)
                service.enqueue(DATE)
            assert service.snapshot(key)[0] == old
            assert not cloud.state["map_snapshots"][new]["ready"]
            assert cloud.download((new, 4, 13, 7)) == (PNG, "image/png")
            assert old in cloud.state["map_snapshots"]
            assert not service.jobs
        finally:
            service.close()


def test_pagination_and_secret_header():
    cloud = Cloud()
    cloud.state["map_rate_limits"] = {str(i): {"source": str(i), "retry_at": 0, "delay": 0} for i in range(1003)}
    assert len(list(cloud.rows("map_rate_limits", order="source.asc"))) == 1003
    real = SupabaseMapStore("https://cache.example.test", "sb_secret_test")
    with patch("tiles.supabase_store.urllib.request.urlopen", side_effect=[URLError("disconnected"), ImageResponse()]) as request, \
            patch("tiles.supabase_store.time.sleep"):
        real.request("/rest/v1/map_snapshots")
    assert request.call_count == 2
    sent = request.call_args.args[0]
    assert sent.get_header("Apikey") == "sb_secret_test"
    assert sent.get_header("Authorization") is None
    assert request.call_args.kwargs["timeout"] == 30


def test_cloud_outage_does_not_block_startup_or_local_images():
    cloud = Cloud()
    cloud.offline = True
    with TemporaryDirectory() as directory:
        # Construction must not make a network call; synchronization runs in _run.
        with patch.object(cloud, "pull", side_effect=AssertionError("blocking startup")):
            service = preload.MapPreloader(Path(directory) / "cache.db", cloud=cloud)
        try:
            service.start()
            deadline = time.monotonic() + 2
            while not service.storage_error and time.monotonic() < deadline:
                time.sleep(.01)
            assert service.storage_error
            assert not service.jobs
            sid = "a" * 32
            with service.db:
                service.db.execute("INSERT INTO tiles VALUES (?,?,?,?,?,?)", (sid, 1, 0, 0, PNG, "image/png"))
            assert service.fetch(sid, 1, 0, 0).result(timeout=.1) == (PNG, "image/png")
        finally:
            service.close()
