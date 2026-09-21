"""Copy a stopped backend's SQLite cache to Supabase, then verify every image.

Run from src/backend with SUPABASE_URL/SUPABASE_SECRET_KEY in .env:
    .venv/bin/python -m tiles.migrate_cache
Safe to rerun after interruption. This command never contacts Earth Engine.
"""
import argparse
import hashlib
import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from dotenv import load_dotenv


def main():
    load_dotenv()
    from tiles.preload import CACHE_PATH, MapPreloader
    from tiles.supabase_store import BUCKET, SupabaseMapStore

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=CACHE_PATH)
    args = parser.parse_args()
    if not args.cache.is_file():
        parser.error("The existing SQLite cache does not exist")
    cloud = SupabaseMapStore.from_env()
    if cloud is None:
        parser.error("Set SUPABASE_URL and SUPABASE_SECRET_KEY in the backend .env")
    backup = args.cache.with_name(args.cache.stem + "-before-supabase.sqlite3")
    if not backup.exists():
        with sqlite3.connect(args.cache) as source, sqlite3.connect(backup) as target:
            source.backup(target)
    service = MapPreloader(args.cache, cloud=cloud)
    try:
        cloud.pull(service)
        service.cloud_loaded = True
        records = []
        for row in service.db.execute("SELECT id,cache_key,payload,expires,ready,refresh_at,created FROM snapshots ORDER BY created"):
            record = dict(zip(("id", "cache_key", "payload", "expires", "ready", "refresh_at", "created"), row))
            record.update(payload=json.loads(record["payload"]), ready=bool(record["ready"]))
            records.append(record)
        new = [{**r, "ready": False} for r in records if r["id"] not in cloud.snapshots]
        for start in range(0, len(new), 100):
            cloud.request("/rest/v1/map_snapshots", "POST", new[start:start + 100])
        print(f"Copying {len(records)} snapshots; local backup: {backup}", flush=True)

        def upload(row):
            sid, z, x, y, data, mime = row
            key = (sid, z, x, y)
            digest = hashlib.sha256(data).hexdigest()
            existing = cloud.tiles.get(key)
            if existing and (existing["sha256"] != digest or existing["size"] != len(data)):
                raise RuntimeError(f"Immutable tile differs in Supabase: {key}")
            if not existing:
                cloud.request(f"/storage/v1/object/{BUCKET}/{cloud.object_path(key)}", "POST", data, mime=mime)
            return {"snapshot": sid, "z": z, "x": x, "y": y, "mime": mime,
                    "sha256": digest, "size": len(data)}

        # Only copying saved bytes uses parallel I/O; the source queue stays serial.
        count = 0
        cursor = service.db.execute("SELECT snapshot,z,x,y,image,mime FROM tiles WHERE image IS NOT NULL")
        with ThreadPoolExecutor(max_workers=16) as pool:
            while batch := cursor.fetchmany(250):
                tiles = list(pool.map(upload, batch))
                new_tiles = [r for r in tiles if (r["snapshot"], r["z"], r["x"], r["y"]) not in cloud.tiles]
                if new_tiles:
                    cloud.request("/rest/v1/map_tiles", "POST", new_tiles)
                cloud.tiles.update({(r["snapshot"], r["z"], r["x"], r["y"]): r for r in tiles})
                count += len(tiles)
                print(f"Copied {count} tiles", flush=True)

            # Independently read back and check SHA-256, not just upload responses.
            verified = 0
            keys = list(cloud.tiles)
            for start in range(0, len(keys), 250):
                list(pool.map(cloud.download, keys[start:start + 250]))
                verified += len(keys[start:start + 250])
                print(f"Verified {verified} tiles", flush=True)
        for start in range(0, len(records), 100):
            cloud.request("/rest/v1/map_snapshots", "POST", records[start:start + 100])
        with service.db:
            service.db.execute("DELETE FROM map_sync")
        cloud.sync_pending(service)
        print(f"Migrated {len(records)} snapshots and verified {verified} tiles. Backup: {backup}")
    finally:
        service.close()


if __name__ == "__main__":
    main()
