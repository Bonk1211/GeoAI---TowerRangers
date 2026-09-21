"""Prepare every overlay before selection, and serve buffered, durable tiles.

Only an explicit reload contacts source providers. Viewport changes record the
area for the next reload. Supabase persists completed work; SQLite buffers it.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sqlite3
import threading
import time
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlencode

from backhaul.layers import BACKBONE_LAYERS
from flood.layers import ASEAN_BBOX, FLOOD_LAYERS
from land.layers import LAND_LAYERS
from thermal.layers import FIRE_LAYERS
from tiles import engine, ee_session
from tiles.ee_session import LayerUnavailable

LOG = logging.getLogger(__name__)
STAGES = (0.5, 1, 2, 3, 5)
MAX_SAVED_ZOOM = 8
RETRY_SECONDS = 60
UNCACHED_DETAIL = "This area or date is not saved. Use Reload all maps to fetch it."
CACHE_PATH = Path(os.environ.get(
    "MAP_CACHE_PATH", Path(__file__).resolve().parents[3] / ".cache" / "maps.sqlite3"
))


def hand_url(stage: float) -> str:
    bands = [(0, .5, 1, [34, 197, 94]), (.5, 1, 2, [37, 99, 235]),
             (1, 2, 3, [250, 204, 21]), (2, math.inf, 4, [220, 38, 38])]
    ranges = [(max(0, stage - hi + 1e-6), stage - lo + 1e-6, value)
              for lo, hi, value, _ in reversed(bands) if stage - lo + 1e-6 > 0]
    rule = {"rasterFunction": "Colormap", "rasterFunctionArguments": {
        "Colormap": [[value, *rgb] for _, _, value, rgb in bands],
        "Raster": {"rasterFunction": "Remap", "rasterFunctionArguments": {
            "InputRanges": [edge for lo, hi, _ in ranges for edge in (lo, hi)],
            "OutputValues": [value for _, _, value in ranges],
            "NoDataRanges": [stage + 1e-6, 10000], "AllowUnmatched": False,
        }},
    }}
    return ("https://gis.asf.alaska.edu/arcgis/rest/services/GlobalHAND/GLO30_HAND/"
            "ImageServer/exportImage?bbox={bbox-epsg-3857}&" + urlencode({
                "bboxSR": 3857, "imageSR": 3857, "size": "256,256", "format": "png32",
                "noData": 0, "renderingRule": json.dumps(rule), "f": "image",
            }))


def _hand_resolver(layer):
    return hand_url(float(layer.layer_id.removeprefix("hand_"))), None, None, {}, "public"


LAYERS = tuple(layer for layer in (*FLOOD_LAYERS, *LAND_LAYERS, *FIRE_LAYERS)
               if layer.kind != "static") + tuple(
    engine.Layer(layer_id=f"hand_{stage:g}", label=f"HAND {stage:g} m", description="",
                 kind="wms", attribution=FLOOD_LAYERS[0].attribution, dated=False,
                 bounds=ASEAN_BBOX, resolver=_hand_resolver)
    for stage in STAGES
)
# Retain access to saved backbone tiles without including them in map reloads.
BY_ID = {layer.layer_id: layer for layer in (*LAYERS, *BACKBONE_LAYERS)}


def coverage_bounds(layer):
    west, south, east, north = layer.bounds or ASEAN_BBOX
    return (max(west, ASEAN_BBOX[0]), max(south, ASEAN_BBOX[1]),
            min(east, ASEAN_BBOX[2]), min(north, ASEAN_BBOX[3]))


def tile_url(template: str, z: int, x: int, y: int) -> str:
    span = 40075016.68557849 / 2**z
    west, north = -20037508.342789244 + x * span, 20037508.342789244 - y * span
    return (template.replace("{bbox-epsg-3857}", f"{west},{north-span},{west+span},{north}")
            .replace("{z}", str(z)).replace("{x}", str(x)).replace("{y}", str(y)))


def tile_coords(bounds, zoom):
    west, south, east, north = bounds
    n = 2**zoom
    def x(lon):
        return max(0, min(n - 1, int((lon + 180) / 360 * n)))
    def y(lat):
        lat = max(-85.05112878, min(85.05112878, lat))
        return max(0, min(n - 1, int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)))
    return {(zoom, tx, ty) for tx in range(x(west), x(east) + 1)
            for ty in range(y(north), y(south) + 1)}


def rate_limit_error(error):
    match = None
    while error is not None:
        if (getattr(error, "code", None) == 429
                or getattr(getattr(error, "resp", None), "status", None) == 429
                or any(term in str(error).lower() for term in
                       ("429", "too many requests", "compute quota", "rate limit exceeded"))):
            match = error
        error = error.__cause__
    return match


def source_signature(value):
    forecast = value.get("forecast")
    return ([value.get(k) for k in ("date", "sensor", "scenes", "window", "observed_at", "source_count", "snapshot_id")],
            {k: v for k, v in forecast.items() if k != "source_age_seconds"} if forecast else None)


class MapPreloader:
    def __init__(self, path=CACHE_PATH, *, cloud=None):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY, cache_key TEXT, payload TEXT, expires REAL, ready INTEGER
            );
            CREATE INDEX IF NOT EXISTS snapshot_key ON snapshots(cache_key, expires);
            CREATE TABLE IF NOT EXISTS tiles (
                snapshot TEXT, z INTEGER, x INTEGER, y INTEGER, image BLOB, mime TEXT,
                PRIMARY KEY (snapshot, z, x, y)
            );
            CREATE TABLE IF NOT EXISTS rate_limits (
                source TEXT PRIMARY KEY, retry_at REAL, delay REAL
            );
        """)
        if "refresh_at" not in {row[1] for row in self.db.execute("PRAGMA table_info(snapshots)")}:
            # Retain the persisted schema for existing caches; this no longer expires images.
            with self.db:
                self.db.execute("ALTER TABLE snapshots ADD COLUMN refresh_at REAL NOT NULL DEFAULT 0")
        if "created" not in {row[1] for row in self.db.execute("PRAGMA table_info(snapshots)")}:
            with self.db:
                self.db.execute("ALTER TABLE snapshots ADD COLUMN created REAL NOT NULL DEFAULT 0")
                self.db.execute("UPDATE snapshots SET created=? + rowid * 0.000001", (time.time(),))
        self.lock = threading.RLock()
        self.upstream_lock = threading.Lock()
        self.ee_source = "ee:" + os.environ.get("GEE_PROJECT", "")
        self.retry_at, self.retry_delay = self.db.execute(
            "SELECT retry_at, delay FROM rate_limits WHERE source=?", (self.ee_source,)
        ).fetchone() or (0, 0)
        self.stopped = threading.Event()
        # Separate pools: preparing a map waits for tiles, so sharing one pool deadlocks.
        self.maps = ThreadPoolExecutor(max_workers=1, thread_name_prefix="map-preload")
        self.images = ThreadPoolExecutor(max_workers=1, thread_name_prefix="map-render")
        self.cloud_images = ThreadPoolExecutor(max_workers=4, thread_name_prefix="map-storage") if cloud else None
        self.cloud = cloud
        self.cloud_loaded = False
        self.storage_error = None
        self.jobs = {}
        self.downloads = {}
        self.errors = {}
        self.progress = None
        self.views = {}
        self.thread = None
        # Invalidate when rendering or asset sources change, not the compute project.
        files = [Path(engine.__file__)] + [
            Path(__file__).parents[1] / group / "layers.py" for group in ("flood", "land", "thermal")]
        self.version = hashlib.sha256(b"".join(p.read_bytes() for p in files)
            + "".join(hand_url(stage) for stage in STAGES).encode()
            + os.environ.get("GEE_DSWFP_ASSET_ROOT", "").encode()).hexdigest()[:16]
        if cloud:
            cloud.attach(self)

    def key(self, layer, date, sensor):
        return json.dumps([self.version, *engine._cache_key(layer, date, sensor or None)])

    def snapshot(self, key, ready=True):
        with self.lock:
            row = self.db.execute(
                "SELECT id, payload, refresh_at FROM snapshots WHERE cache_key=? "
                + ("AND ready=1 " if ready else "") + "ORDER BY created DESC, rowid DESC LIMIT 1",
                (key,),
            ).fetchone()
        return (row[0], json.loads(row[1]), row[2]) if row else None

    def saved_dates(self, layer=None, sensor=""):
        with self.lock:
            keys = [json.loads(row[0]) for row in self.db.execute(
                "SELECT DISTINCT cache_key FROM snapshots WHERE ready=1")]
        return sorted({key[2] for key in keys if key[0] == self.version
                       and key[1] in BY_ID and BY_ID[key[1]].dated
                       and key[2] != "static"
                       and (layer is None or (key[1] == layer.layer_id and key[3] == (sensor or None)))}, reverse=True)

    def resolve_date(self, date="latest", layer=None, sensor="", *, fresh=False):
        if date not in ("", "latest"):
            engine.parse_date(date)
            return date
        saved = [] if fresh else self.saved_dates(layer, sensor)
        return saved[0] if saved else engine._now().strftime("%Y-%m-%d")

    def start(self):
        if not self.cloud:
            return
        self.thread = threading.Thread(target=self._run, name="map-refresh", daemon=True)
        self.thread.start()

    def close(self):
        self.stopped.set()
        if self.thread:
            self.thread.join()
        self.images.shutdown(wait=False, cancel_futures=True)
        if self.cloud_images:
            self.cloud_images.shutdown(wait=False, cancel_futures=True)
        self.maps.shutdown(wait=True, cancel_futures=True)
        self.images.shutdown(wait=True, cancel_futures=True)
        if self.cloud_images:
            self.cloud_images.shutdown(wait=True, cancel_futures=True)
        self.db.close()

    def cooldown(self, layer):
        with self.lock:
            if layer.kind == "ee" and self.retry_at > time.time():
                retry = datetime.fromtimestamp(self.retry_at, timezone.utc).strftime("%H:%M:%S UTC")
                return f"Earth Engine is rate limited; map requests paused until {retry}. Cached tiles remain available."
        return None

    @contextmanager
    def upstream(self, layer):
        # Only manual reload workers enter this context. Permission is thread-local.
        with self.upstream_lock, ee_session.allow_requests():
            if self.stopped.is_set():
                raise LayerUnavailable("Map preloader is stopping")
            if self.cloud and (not self.cloud_loaded or self.storage_error):
                raise LayerUnavailable(self.storage_error or "Supabase map cache is loading")
            detail = self.cooldown(layer)
            if detail:
                raise LayerUnavailable(detail)
            try:
                yield
            except Exception as error:
                limited = rate_limit_error(error) if layer.kind == "ee" else None
                if limited is None:
                    raise
                headers = getattr(limited, "headers", None) or getattr(limited, "resp", None) or {}
                retry = headers.get("Retry-After", headers.get("retry-after", ""))
                try:
                    seconds = float(retry)
                except (TypeError, ValueError):
                    try:
                        seconds = parsedate_to_datetime(retry).timestamp() - time.time()
                    except (TypeError, ValueError, OverflowError):
                        seconds = 0
                with self.lock, self.db:
                    self.retry_delay = min(30 * 60, max(RETRY_SECONDS, self.retry_delay * 2))
                    self.retry_at = time.time() + max(self.retry_delay, seconds if math.isfinite(seconds) else 0)
                    self.db.execute("INSERT OR REPLACE INTO rate_limits VALUES (?, ?, ?)",
                                    (self.ee_source, self.retry_at, self.retry_delay))
                detail = self.cooldown(layer)
                LOG.warning(detail)
                raise LayerUnavailable(detail) from error
            else:
                if layer.kind == "ee" and self.retry_delay:
                    with self.lock, self.db:
                        self.retry_at = self.retry_delay = 0
                        self.db.execute("DELETE FROM rate_limits WHERE source=?", (self.ee_source,))

    def _run(self):
        while not self.stopped.is_set():
            try:
                if self.cloud:
                    try:
                        if not self.cloud_loaded:
                            self.cloud.pull(self)
                            self.cloud_loaded = True
                        self.cloud.sync_pending(self)
                        self.storage_error = None
                    except LayerUnavailable as error:
                        self.storage_error = str(error)
                        raise
            except Exception:
                LOG.exception("Map storage synchronization failed; retrying")
            self.stopped.wait(RETRY_SECONDS)

    def enqueue(self, date, bounds=None, zoom=None, *, reload=False, resume=False):
        engine.parse_date(date)
        if bounds is not None:
            with self.lock:
                # ponytail: retain 8 recently viewed dates; use a job queue for a larger archive.
                self.views.pop(date, None)
                self.views[date] = (bounds, zoom, time.time())
                while len(self.views) > 8:
                    del self.views[next(iter(self.views))]
        if not reload:
            return  # Viewing a map only records the viewport; it never fetches imagery.
        for layer in LAYERS:
            region = coverage_bounds(layer)
            if bounds is not None:
                region = (max(region[0], bounds[0]), max(region[1], bounds[1]),
                          min(region[2], bounds[2]), min(region[3], bounds[3]))
                if region[0] >= region[2] or region[1] >= region[3]:
                    continue
            # Save every level through z8; the browser magnifies these at deeper zooms.
            zooms = range(MAX_SAVED_ZOOM + 1) if zoom is None else (min(zoom, MAX_SAVED_ZOOM),)
            coords = set().union(*(tile_coords(region, z) for z in zooms))
            for sensor in ([item["id"] for item in layer.sensors] or [""]):
                self.queue(layer, date, sensor, coords, resume=resume)

    def reload(self, date="latest", *, resume=False):
        requested_date = date
        date = self.resolve_date(date, fresh=not resume)
        with self.lock, self.db:
            if self.cloud and (not self.cloud_loaded or self.storage_error):
                raise LayerUnavailable(self.storage_error or "Map storage is still loading; retry Reload all maps shortly")
            if any(not future.done() for future, _ in self.jobs.values()):
                return self.status(requested_date)
            for layer in LAYERS:
                for sensor in ([item["id"] for item in layer.sensors] or [""]):
                    key = self.key(layer, date, sensor)
                    job = self.jobs.get(key)
                    if not job or job[0].done():
                        self.errors.pop(key, None)
            view = self.views.get(date, (None, None, 0))
            self.views[date] = (*view[:2], time.time())
            self.enqueue(date, reload=True, resume=resume)
            if view[0] is not None:
                self.enqueue(date, *view[:2], reload=True, resume=resume)
            return self.status(requested_date)

    def queue(self, layer, date, sensor, coords, *, resume=False):
        key = self.key(layer, date, sensor)
        with self.lock:
            if self.stopped.is_set() or self.cooldown(layer) or (self.cloud and (not self.cloud_loaded or self.storage_error)):
                return
            job = self.jobs.get(key)
            if job and not job[0].done():
                job[1].update(coords)
                return
            error = self.errors.get(key)
            if error and time.time() - error[0] < RETRY_SECONDS:
                return
            wanted = set(coords)
            future = self.maps.submit(self._prepare, layer, date, sensor, key, wanted, resume=resume)
            self.jobs[key] = (future, wanted)

    def _prepare(self, layer, date, sensor, key, wanted, *, resume=False):
        try:
            cached = self.snapshot(key, ready=False) if resume else None
            done = set()
            if cached:
                sid, payload, _ = cached
                with self.lock:
                    done = set(self.db.execute("SELECT z,x,y FROM tiles WHERE snapshot=?", (sid,)))
                    expires, ready = self.db.execute("SELECT expires,ready FROM snapshots WHERE id=?", (sid,)).fetchone()
                    if ready and wanted <= done:
                        return  # Complete snapshots need neither source requests nor uploads.
            if not cached or (wanted - done and expires <= time.time()):
                with self.upstream(layer):
                    renewed = engine.tiles_for(layer, date, sensor, refresh=True)
                if renewed["tile_access"] == "requires_auth":
                    raise LayerUnavailable("Source tiles require authentication")
                if cached and source_signature(renewed) != source_signature(payload):
                    # Keep the previous imagery; never combine different forecast runs.
                    LOG.info("Source changed; starting a new snapshot for %s %s", layer.layer_id, sensor)
                    cached, done = None, set()
                payload = renewed
                expires = datetime.strptime(payload["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(
                    tzinfo=timezone.utc).timestamp()
            with self.lock, self.db:
                self.progress = {"layer_id": layer.layer_id, "sensor": sensor or None,
                                 "loaded": len(wanted & done), "total": len(wanted), "phase": "fetching"}
                if cached:
                    self.db.execute("UPDATE snapshots SET payload=?,expires=? WHERE id=?",
                                    (json.dumps(payload), expires, sid))
                else:
                    sid = hashlib.sha256((key + payload["tile_url"] + str(time.time_ns())).encode()).hexdigest()[:32]
                    self.db.execute("INSERT INTO snapshots (id,cache_key,payload,expires,ready,refresh_at,created) VALUES (?, ?, ?, ?, 0, 0, ?)",
                                    (sid, key, json.dumps(payload), expires, time.time()))
            while not self.stopped.is_set():
                with self.lock:
                    batch = wanted - done
                if not batch:
                    break
                for coord in sorted(batch):
                    if self.stopped.is_set():
                        return
                    self.fetch(sid, *coord, from_reload=True).result()
                    with self.lock:
                        self.progress["loaded"] += 1
                        self.progress["total"] = len(wanted)
                done.update(batch)
            if self.stopped.is_set():
                return
            if self.cloud:
                with self.lock:
                    self.progress["phase"] = "saving"
                try:
                    self.cloud.sync(self, sid, ready=True)
                except LayerUnavailable as error:
                    self.storage_error = str(error)
                    raise
            with self.lock, self.db:
                self.db.execute("UPDATE snapshots SET ready=1 WHERE id=?", (sid,))
                self.errors.pop(key, None)
            LOG.info("Map ready: %s %s %s (%s tiles)", layer.layer_id, date, sensor, len(done))
        except Exception as error:
            if self.stopped.is_set():
                return
            with self.lock:
                self.errors[key] = (time.time(), str(error))
            if not self.cooldown(layer):
                LOG.warning("Map preload unavailable: %s %s %s: %s", layer.layer_id, date, sensor, error)
        finally:
            with self.lock:
                self.progress = None

    def fetch(self, sid, z, x, y, *, from_reload=False):
        key = (sid, z, x, y)
        with self.lock:
            # A ready tile must never queue behind slow upstream downloads.
            cached = self.db.execute(
                "SELECT image, mime FROM tiles WHERE snapshot=? AND z=? AND x=? AND y=?", key
            ).fetchone()
            if cached and cached[0] is not None:
                result = Future()
                result.set_result(cached)
                return result
            if not from_reload and not (self.cloud and cached):
                result = Future()
                result.set_exception(LayerUnavailable(UNCACHED_DETAIL))
                return result
            future = self.downloads.get(key)
            if future is None:
                if self.cloud and cached:
                    future = self.cloud_images.submit(self._download_cloud, key)
                else:
                    future = self.images.submit(self._download, *key)
                self.downloads[key] = future
                future.add_done_callback(lambda _: self._download_done(key))
            return future

    def _download_done(self, key):
        with self.lock:
            self.downloads.pop(key, None)

    def _download_cloud(self, key):
        data, mime = self.cloud.download(key)
        with self.lock, self.db:
            self.db.execute("UPDATE tiles SET image=?,mime=? WHERE snapshot=? AND z=? AND x=? AND y=?",
                            (data, mime, *key))
        return data, mime

    def _download(self, sid, z, x, y):
        with self.lock:
            row = self.db.execute("SELECT image, mime FROM tiles WHERE snapshot=? AND z=? AND x=? AND y=?",
                                  (sid, z, x, y)).fetchone()
            if row and row[0] is not None:
                return row
            row = self.db.execute("SELECT payload, expires FROM snapshots WHERE id=?", (sid,)).fetchone()
        if not row:
            raise LayerUnavailable("Unknown map snapshot")
        if self.stopped.is_set():
            raise LayerUnavailable("Map preloader is stopping")
        payload = json.loads(row[0])
        layer = BY_ID[payload["layer_id"]]
        with self.upstream(layer):
            if row[1] <= time.time():
                key = self.key(layer, payload["date"] or "", payload["sensor"] or "")
                with self.lock:
                    error = self.errors.get(key)
                if error and time.time() - error[0] < RETRY_SECONDS:
                    raise LayerUnavailable(error[1])
                renewed = engine.tiles_for(layer, payload["date"] or "", payload["sensor"] or "", refresh=True)
                # A long manual reload may outlive its URL, but a different
                # observation/forecast must not be mixed into the saved imagery.
                if source_signature(renewed) != source_signature(payload):
                    detail = "Source data changed; use Reload all maps to load new areas"
                    with self.lock:
                        self.errors[key] = (time.time(), detail)
                    raise LayerUnavailable(detail)
                if renewed["tile_access"] == "requires_auth":
                    raise LayerUnavailable("Source tiles require authentication")
                expires = datetime.strptime(renewed["expires_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
                with self.lock, self.db:
                    self.db.execute("UPDATE snapshots SET payload=?, expires=? WHERE id=?",
                                    (json.dumps(renewed), expires, sid))
                payload = renewed
            url = tile_url(payload["tile_url"], z, x, y)
            for attempt in range(3):
                try:
                    with urllib.request.urlopen(url, timeout=60, context=engine._ssl_context()) as response:
                        mime = response.headers.get_content_type()
                        data = response.read(5 * 1024 * 1024 + 1)
                        valid_image = (data.startswith(b"\x89PNG\r\n\x1a\n") or data.startswith(b"\xff\xd8\xff")
                                       or (data.startswith(b"RIFF") and data[8:12] == b"WEBP"))
                        if response.status != 200 or mime not in ("image/png", "image/jpeg", "image/webp") or not valid_image or len(data) > 5 * 1024 * 1024:
                            raise LayerUnavailable("Source did not return a usable image tile")
                    break
                except urllib.error.HTTPError as error:
                    if error.code not in (408, 502, 503, 504) or attempt == 2:
                        raise
                except (urllib.error.URLError, TimeoutError, OSError):
                    if attempt == 2:
                        raise
                if self.stopped.wait(2 ** attempt):
                    raise LayerUnavailable("Map preloader is stopping")
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO tiles VALUES (?, ?, ?, ?, ?, ?)",
                            (sid, z, x, y, data, mime))
        return data, mime

    def tiles_for(self, layer, date="latest", sensor=""):
        if layer.kind == "static":
            raise LayerUnavailable(f"layer {layer.layer_id!r} is mounted by the frontend, not the tile API")
        sensor = engine.parse_sensor(layer, sensor) if layer.sensors else ""
        if layer.dated:
            date = self.resolve_date(date, layer, sensor)
        key = self.key(layer, date, sensor)
        cached = self.snapshot(key)
        if cached:
            sid, payload, _ = cached
            return {**engine._public_payload(payload), "tile_url": f"/maps/tiles/{sid}/{{z}}/{{x}}/{{y}}",
                    "bounds": coverage_bounds(layer), "max_zoom": MAX_SAVED_ZOOM,
                    "expires_at": None, "cache_stale": False, "cache_detail": None}
        with self.lock:
            error = self.errors.get(key)
        raise LayerUnavailable(self.cooldown(layer) or self.storage_error or (error[1] if error else UNCACHED_DETAIL))

    def status(self, date="latest"):
        latest = date in ("", "latest")
        date = self.resolve_date(date)
        result = []
        for layer in LAYERS:
            for sensor in ([item["id"] for item in layer.sensors] or [""]):
                layer_date = self.resolve_date("latest", layer, sensor) if latest and layer.dated else date
                key = self.key(layer, layer_date, sensor)
                cached = self.snapshot(key)
                with self.lock:
                    # A latest reload may prepare today while yesterday stays visible.
                    job_key = key
                    if latest:
                        candidates = [k for k in self.jobs if
                                      (parts := json.loads(k))[1] == layer.layer_id
                                      and parts[3] == (sensor or None) and parts[2] >= layer_date]
                        job_key = max(candidates, key=lambda k: (not self.jobs[k][0].done(), json.loads(k)[2]), default=key)
                    error = self.errors.get(job_key)
                    job = self.jobs.get(job_key)
                detail = self.cooldown(layer) or self.storage_error or (error[1] if error else None)
                loading = bool(job and not job[0].done())
                result.append({"layer_id": layer.layer_id, "sensor": sensor or None,
                               "date": cached[1].get("date") if cached else None,
                               "state": "ready" if cached else "preparing" if loading else "unavailable",
                               "detail": detail or (UNCACHED_DETAIL if not cached and not loading else None),
                               "cache_stale": False,
                               "loading": loading,
                               "tile_url": f"/maps/tiles/{cached[0]}/{{z}}/{{x}}/{{y}}" if cached else None,
                               "next_refresh_at": None})
        with self.lock:
            progress = dict(self.progress) if self.progress else None
        return {"date": date, "layers": result, "refresh_interval_seconds": None,
                "progress": progress, "saved_dates": self.saved_dates(),
                "storage": "supabase" if self.cloud else "local", "storage_error": self.storage_error,
                "retry_at": engine.iso(datetime.fromtimestamp(self.retry_at, timezone.utc)) if self.retry_at > time.time() else None}


_service: MapPreloader | None = None


def prepared_tiles_for(layer, date="latest", sensor=""):
    if _service is None:
        if layer.dated and date not in ("", "latest"):
            engine.parse_date(date)
        if layer.sensors:
            engine.parse_sensor(layer, sensor)
        raise LayerUnavailable("Map cache is not running; automatic source requests are disabled")
    return _service.tiles_for(layer, date, sensor)
