"""Build data/travel_matrix.npz — real road distances and drive times.

Design: docs/superpowers/specs/2026-09-09-osrm-travel-matrix-design.md

PRODUCER ONLY. Nothing in the running application imports this module; the API
reads the artefact through scheduler/travel.py and never talks to OSRM. This
is the same shape as prepare_flood_surface.py and prepare_malaysia_dataset.py:
an explicit, reviewable offline act.

WHY A LOCAL OSRM AND NOT A HOSTED ONE

The requirement is a totally free build with no runtime API calls, which rules
out Google, Mapbox and HERE (paid/metered) and the public OSRM demo server
(forbids production use, rate-limited). Self-hosted OSRM is BSD-2-Clause and
the OSM extract is ODbL — attribution, not payment.

    # one-off, ~20 min on a laptop, needs ~8 GB free
    curl -O https://download.geofabrik.de/asia/malaysia-singapore-brunei-latest.osm.pbf
    docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \\
        osrm-extract -p /opt/car.lua /data/malaysia-singapore-brunei-latest.osm.pbf
    docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \\
        osrm-partition /data/malaysia-singapore-brunei-latest.osrm
    docker run -t -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \\
        osrm-customize /data/malaysia-singapore-brunei-latest.osrm
    docker run -p 5000:5000 -v "${PWD}:/data" ghcr.io/project-osrm/osrm-backend \\
        osrm-routed --algorithm mld /data/malaysia-singapore-brunei-latest.osrm

    cd src/backend && python3 data/prepare_travel_matrix.py

The extract deliberately includes Singapore and Brunei: Brunei splits Sarawak,
so a Sarawak-only extract would report unroutable for legs that really do have
a road, just one that leaves the country.

WHAT IS COMPUTED, AND WHAT IS NOT

  depot -> tower                   20 depots x 1,164 towers = 23,280
  tower -> tower, SAME TERRITORY   149,278
                                   -----------------------------------
                                   ~172,558 pairs, ~1.4 MB

Not the full 1,164^2 = 1,354,896. optimize.py filters candidate crews by exact
territory match before it ever measures a leg, so two towers in different
states can never be consecutive stops for one crew. Those pairs are
unreachable by construction, and lookup() returning None for them is correct.

Tower->tower matters because the solver measures each leg from where the crew
actually IS — the depot for the day's first job, the previous tower after
that. Skipping it leaves mid-route legs on the straight-line estimate.

`--depots-only` builds just the 23,280 depot->tower pairs when disk or time is
short. That is a legitimate staged build rather than a shortcut: the
depot-range check which dispatches a crew to an unbridged island is ITSELF a
depot->tower test, so the headline bug is fixed by this alone. The remaining
pairs then fall back per-pair and matrix_status() reports coverage, so what is
missing is visible instead of silent — which is exactly the property the
three-state design exists to give.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scheduler.config_loader import load_crews  # noqa: E402
from scheduler.travel import (  # noqa: E402
    DEFAULT_MATRIX_PATH,
    ROUTED,
    UNROUTABLE,
    depot_key,
    write_matrix,
)

OSRM_URL = "http://127.0.0.1:5000"

# OSRM's /table takes sources and destinations by index into one coordinate
# list. Keep each request comfortably inside the server's default
# max-table-size (100x100 = 10,000 cells) rather than raising the limit —
# a tuned server is one more thing that has to be reproduced later.
BATCH = 90


def _load_towers() -> list[dict]:
    """Towers from the prepared feature table, via the same adapter the API
    uses — so the matrix covers exactly the population the scheduler serves."""
    from adapter.ml_source import load_scored_towers

    return load_scored_towers()


def _table(coords: list[tuple[float, float]], sources: list[int], dests: list[int]) -> dict:
    """One OSRM /table call. Asks for distance AND duration.

    `annotations=distance,duration` is required — OSRM returns durations only
    by default, and a matrix without distance cannot answer the depot-range
    constraint, which is a distance test.
    """
    pts = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in coords)
    url = (
        f"{OSRM_URL}/table/v1/driving/{pts}"
        f"?sources={';'.join(map(str, sources))}"
        f"&destinations={';'.join(map(str, dests))}"
        f"&annotations=distance,duration"
    )
    with urllib.request.urlopen(url, timeout=180) as r:
        return json.loads(r.read())


def _probe() -> None:
    try:
        with urllib.request.urlopen(f"{OSRM_URL}/route/v1/driving/101.6869,2.9264;101.5185,3.0733", timeout=10) as r:
            json.loads(r.read())
    except (urllib.error.URLError, OSError) as exc:
        raise SystemExit(
            f"No OSRM at {OSRM_URL} ({exc}).\n"
            "Start it with the docker commands in this file's docstring.\n"
            "Nothing was written — the existing matrix, if any, is untouched."
        )


def build(
    limit: int | None = None,
    out: Path | None = None,
    depots_only: bool = False,
) -> int:
    _probe()
    towers = _load_towers()
    if limit:
        towers = towers[:limit]
    crews = load_crews()

    # 30 crews sit on 20 distinct depots; dedupe so a shared depot is one node.
    depots: dict[str, tuple[float, float]] = {}
    for c in crews:
        d = c["depot"]
        depots[depot_key(d["lon"], d["lat"])] = (float(d["lon"]), float(d["lat"]))

    tower_pt = {t["tower_id"]: (float(t["lon"]), float(t["lat"])) for t in towers}
    by_territory: dict[str, list[str]] = defaultdict(list)
    for t in towers:
        by_territory[t.get("territory") or "?"].append(t["tower_id"])

    keys = list(depots) + list(tower_pt)
    point = {**depots, **tower_pt}

    # (sources, destinations) groups. Depots fan out to every tower; towers
    # fan out only within their own territory.
    jobs: list[tuple[list[str], list[str]]] = [(list(depots), list(tower_pt))]
    if not depots_only:
        for ids in by_territory.values():
            if len(ids) > 1:
                jobs.append((ids, ids))

    rows: list[tuple[str, str, float, float, int, bool]] = []
    unroutable = 0
    for src_keys, dst_keys in jobs:
        for si in range(0, len(src_keys), BATCH):
            s_chunk = src_keys[si : si + BATCH]
            for di in range(0, len(dst_keys), BATCH):
                d_chunk = dst_keys[di : di + BATCH]
                coords = [point[k] for k in s_chunk] + [point[k] for k in d_chunk]
                res = _table(
                    coords,
                    list(range(len(s_chunk))),
                    list(range(len(s_chunk), len(s_chunk) + len(d_chunk))),
                )
                dist = res.get("distances") or []
                dur = res.get("durations") or []
                for a, srck in enumerate(s_chunk):
                    for b, dstk in enumerate(d_chunk):
                        if srck == dstk:
                            continue
                        dm = dist[a][b] if a < len(dist) and b < len(dist[a]) else None
                        du = dur[a][b] if a < len(dur) and b < len(dur[a]) else None
                        # null means OSRM found no route. That is a
                        # MEASUREMENT and is recorded as one — writing it as a
                        # missing pair would let the reader fall back to the
                        # straight-line guess OSRM has just contradicted,
                        # which is the entire bug this file exists to fix.
                        if dm is None or du is None:
                            rows.append((srck, dstk, float("nan"), float("nan"), UNROUTABLE, False))
                            unroutable += 1
                        else:
                            rows.append((srck, dstk, dm / 1000.0, du / 60.0, ROUTED, False))
            print(f"  {len(rows):,} pairs…", flush=True)

    out = out or DEFAULT_MATRIX_PATH
    n = write_matrix(
        out,
        keys=keys,
        rows=rows,
        meta={
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "osm_extract": "geofabrik malaysia-singapore-brunei-latest",
            "profile": "car",
            "osrm_url": OSRM_URL,
            "towers": len(tower_pt),
            "depots": len(depots),
            "unroutable": unroutable,
            "note": "free-flow, no traffic model; ferry legs are routed by car.lua",
        },
    )
    print(f"\nwrote {out}  —  {n:,} pairs, {unroutable:,} unroutable")
    return n


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--limit", type=int, default=None, help="towers, for a smoke run")
    ap.add_argument(
        "--depots-only",
        action="store_true",
        help="skip tower->tower legs: 23,280 pairs instead of ~172,558, about "
        "an eighth of the work. A LEGITIMATE partial build, not a shortcut — "
        "the depot-range check that dispatches a crew to an unbridged island "
        "is itself a depot->tower test, so this alone fixes that bug. "
        "Mid-route legs then fall back per-pair and matrix_status() reports "
        "the coverage, so the partialness is visible rather than silent.",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=None,
        help="output path. Point a --limit run HERE, never at the real artefact: "
        "a partial matrix that a later run reads back is exactly how "
        "prepare_malaysia_dataset.py once produced a 97%%-smaller dataset.",
    )
    a = ap.parse_args()
    build(limit=a.limit, out=a.out, depots_only=a.depots_only)
