"""Durable map metadata and private tile objects, with SQLite as a local buffer.

Only the backend receives the Supabase secret. One backend owns the refresh queue;
this is not a distributed scheduler. All network operations have bounded timeouts.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

from tiles import engine
from tiles.ee_session import LayerUnavailable

BUCKET = "map-cache"


class SupabaseMapStore:
    # ponytail: one backend owns refreshes; add database leases before using multiple workers.
    def __init__(self, url, secret):
        parsed = urlparse(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.path not in ("", "/") or parsed.query or parsed.fragment or parsed.username:
            raise ValueError("SUPABASE_URL must be an HTTPS project origin")
        if not secret.startswith("sb_secret_"):
            raise ValueError("SUPABASE_SECRET_KEY must be a backend secret key (sb_secret_...)")
        self.url = url.rstrip("/")
        self.secret = secret
        self.lock = threading.RLock()
        self.tiles = {}
        self.snapshots = {}
        self.limits = {}

    @classmethod
    def from_env(cls):
        url, secret = os.getenv("SUPABASE_URL", ""), os.getenv("SUPABASE_SECRET_KEY", "")
        if not url and not secret:
            return None
        return cls(url, secret)

    def request(self, path, method="GET", body=None, *, mime="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode() if body is not None else None
        # Secret keys are not JWTs: use apikey, never Authorization: Bearer.
        headers = {"apikey": self.secret, "Content-Type": mime,
                   "Prefer": "resolution=merge-duplicates,return=minimal", "x-upsert": "true"}
        request = urllib.request.Request(self.url + path, data=data, headers=headers, method=method)
        for attempt in range(3):
            try:
                with urllib.request.urlopen(request, timeout=30, context=engine._ssl_context()) as response:
                    data = response.read(5 * 1024 * 1024 + 1)
                    if len(data) > 5 * 1024 * 1024:
                        raise LayerUnavailable("Supabase cache response exceeded the size limit")
                    return data
            except urllib.error.HTTPError as error:
                # Do not relay URLs, upstream response bodies or credentials to the UI.
                if error.code not in (408, 502, 503, 504) or attempt == 2:
                    raise LayerUnavailable(f"Supabase map cache returned HTTP {error.code}; saved local tiles remain available") from None
            except (urllib.error.URLError, TimeoutError, OSError):
                if attempt == 2:
                    raise LayerUnavailable("Supabase map cache is unreachable; saved local tiles remain available") from None
            # All writes here are idempotent upserts or deletes.
            time.sleep(2 ** attempt)

    def rows(self, table, *, order):
        offset = 0
        while True:
            page = json.loads(self.request("/rest/v1/" + table + "?" + urlencode({
                "select": "*", "order": order, "limit": 500, "offset": offset})))
            yield from page
            if len(page) < 500:
                return
            offset += len(page)

    def attach(self, service):
        """A persistent outbox makes interrupted uploads retryable without Earth Engine."""
        with service.lock, service.db:
            first = not service.db.execute("SELECT 1 FROM sqlite_master WHERE name='map_sync'").fetchone()
            service.db.executescript("""
                CREATE TABLE IF NOT EXISTS map_sync (snapshot TEXT PRIMARY KEY, revision INTEGER NOT NULL);
                CREATE TRIGGER IF NOT EXISTS map_snapshot_insert AFTER INSERT ON snapshots BEGIN
                    INSERT INTO map_sync VALUES (NEW.id, 1) ON CONFLICT(snapshot) DO UPDATE SET revision=revision+1;
                END;
                CREATE TRIGGER IF NOT EXISTS map_snapshot_update AFTER UPDATE ON snapshots BEGIN
                    INSERT INTO map_sync VALUES (NEW.id, 1) ON CONFLICT(snapshot) DO UPDATE SET revision=revision+1;
                END;
                CREATE TRIGGER IF NOT EXISTS map_tile_insert AFTER INSERT ON tiles BEGIN
                    INSERT INTO map_sync VALUES (NEW.snapshot, 1) ON CONFLICT(snapshot) DO UPDATE SET revision=revision+1;
                END;
                CREATE TRIGGER IF NOT EXISTS map_snapshot_delete AFTER DELETE ON snapshots BEGIN
                    DELETE FROM map_sync WHERE snapshot=OLD.id;
                END;
            """)
            if first:
                service.db.execute("INSERT INTO map_sync SELECT id, 1 FROM snapshots")

    def pull(self, service):
        with self.lock:
            snapshots = list(self.rows("map_snapshots", order="created.asc,id.asc"))
            tiles = list(self.rows("map_tiles", order="snapshot.asc,z.asc,x.asc,y.asc"))
            limits = list(self.rows("map_rate_limits", order="source.asc"))
            with service.lock, service.db:
                pending = {r[0] for r in service.db.execute("SELECT snapshot FROM map_sync")}
                for row in snapshots:
                    if row["id"] not in pending:
                        service.db.execute(
                            "INSERT INTO snapshots (id,cache_key,payload,expires,ready,refresh_at,created) VALUES (?,?,?,?,?,?,?) "
                            "ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,expires=excluded.expires,"
                            "ready=excluded.ready,refresh_at=excluded.refresh_at,created=excluded.created",
                            (row["id"], row["cache_key"], json.dumps(row["payload"]), row["expires"],
                             int(row["ready"]), row["refresh_at"], row["created"]))
                for row in tiles:
                    service.db.execute("INSERT OR IGNORE INTO tiles VALUES (?,?,?,?,NULL,?)",
                                       (row["snapshot"], row["z"], row["x"], row["y"], row["mime"]))
                for row in snapshots:
                    if row["id"] not in pending:
                        service.db.execute("DELETE FROM map_sync WHERE snapshot=?", (row["id"],))
                for row in limits:
                    service.db.execute("INSERT INTO rate_limits VALUES (?,?,?) ON CONFLICT(source) DO UPDATE SET "
                                       "retry_at=excluded.retry_at,delay=excluded.delay WHERE excluded.retry_at>retry_at",
                                       (row["source"], row["retry_at"], row["delay"]))
                service.retry_at, service.retry_delay = service.db.execute(
                    "SELECT retry_at,delay FROM rate_limits WHERE source=?", (service.ee_source,)
                ).fetchone() or (0, 0)
            self.snapshots = {r["id"]: r for r in snapshots}
            self.tiles = {(r["snapshot"], r["z"], r["x"], r["y"]): r for r in tiles}
            self.limits = {r["source"]: (r["retry_at"], r["delay"]) for r in limits}

    @staticmethod
    def object_path(key):
        return "/".join(map(str, key))

    def download(self, key):
        row = self.tiles.get(key)
        if row is None:
            raise LayerUnavailable("Tile is not stored in Supabase")
        data = self.request(f"/storage/v1/object/authenticated/{BUCKET}/{self.object_path(key)}")
        if len(data) != row["size"] or hashlib.sha256(data).hexdigest() != row["sha256"]:
            raise LayerUnavailable("Stored map tile failed its integrity check")
        return data, row["mime"]

    def sync(self, service, sid, *, ready=None):
        with self.lock:
            with service.lock:
                row = service.db.execute("SELECT id,cache_key,payload,expires,ready,refresh_at,created FROM snapshots WHERE id=?", (sid,)).fetchone()
                if not row:
                    return
                revision = service.db.execute("SELECT revision FROM map_sync WHERE snapshot=?", (sid,)).fetchone()
                tiles = service.db.execute("SELECT z,x,y,image,mime FROM tiles WHERE snapshot=? AND image IS NOT NULL", (sid,)).fetchall()
            record = dict(zip(("id", "cache_key", "payload", "expires", "ready", "refresh_at", "created"), row))
            record.update(payload=json.loads(record["payload"]), ready=bool(record["ready"] if ready is None else ready))
            if sid not in self.snapshots:
                self.request("/rest/v1/map_snapshots", "POST", {**record, "ready": False})
            for z, x, y, data, mime in tiles:
                key = (sid, z, x, y)
                if key in self.tiles:
                    continue
                self.request(f"/storage/v1/object/{BUCKET}/{self.object_path(key)}", "POST", data, mime=mime)
                tile = {"snapshot": sid, "z": z, "x": x, "y": y, "mime": mime,
                        "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                self.request("/rest/v1/map_tiles", "POST", tile)
                self.tiles[key] = tile
            # Publish only after every local image has reached durable storage.
            self.request("/rest/v1/map_snapshots", "POST", record)
            self.snapshots[sid] = record
            if revision:
                with service.lock, service.db:
                    service.db.execute("DELETE FROM map_sync WHERE snapshot=? AND revision=?", (sid, revision[0]))

    def sync_pending(self, service):
        with service.lock:
            pending = [r[0] for r in service.db.execute("SELECT snapshot FROM map_sync")]
        for sid in pending:
            if service.stopped.is_set():
                return
            self.sync(service, sid)
        with self.lock:
            value = (service.retry_at, service.retry_delay)
            if self.limits.get(service.ee_source, (0, 0)) != value:
                self.request("/rest/v1/map_rate_limits", "POST", {
                    "source": service.ee_source, "retry_at": value[0], "delay": value[1]})
                self.limits[service.ee_source] = value
