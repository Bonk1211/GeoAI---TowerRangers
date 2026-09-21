"""Build data/travel_matrix.npz from an OSM extract, with no Docker and no OSRM.

Design: docs/superpowers/specs/2026-09-09-osrm-travel-matrix-design.md
Sibling of prepare_travel_matrix.py, which does the same job through OSRM.

WHY THIS EXISTS ALONGSIDE THE OSRM PRODUCER

OSRM is the better engine and prepare_travel_matrix.py stays the reference
path. But it needs Docker, Docker needs WSL, and both need administrator
rights and a reboot — which is not available on every machine that needs to
build this artefact. It also wants ~10 GB of scratch space to turn a 450 MB
extract into a routing graph.

This module reads the same extract with pyosmium, builds the drivable graph
directly, and runs one Dijkstra per DEPOT rather than one per pair. There are
20 distinct depots and 1,164 towers, so that is 20 single-source shortest-path
trees instead of 23,280 point-to-point searches — which is what makes a pure
Python build tractable at all. scipy.sparse.csgraph does the search in C.

WHAT IT GIVES UP, STATED PLAINLY

  - Turn restrictions and one-way streets are ignored; the graph is undirected.
    Over 40-150 km inter-town legs this is a small error. It would matter for
    urban last-mile routing, which this scheduler never does.
  - Durations come from a speed-by-road-class table, not a tuned profile.
  - No ferry modelling: a ferry way is simply not drivable here, so an island
    with no bridge comes back UNROUTABLE rather than routed-with-a-ferry.
    That is a DIFFERENT answer from OSRM's and it is the conservative one —
    it refuses to dispatch rather than promising a crossing. Stated in the
    artefact metadata so the run can be read correctly.

WHAT IT GETS RIGHT, WHICH IS THE POINT

  - Real road distance along a real path.
  - Reachability. An island with no fixed link is a disconnected component of
    the road graph, so Dijkstra returns infinity and the pair is recorded
    UNROUTABLE — the exact acceptance case in the spec's §1a, and the thing
    haversine x 1.35 cannot express at any price.

    cd src/backend
    py data/prepare_travel_matrix_osm.py --pbf C:/osrm/malaysia.osm.pbf
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import osmium
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components, dijkstra

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scheduler.config_loader import load_crews  # noqa: E402
from scheduler.travel import (  # noqa: E402
    DEFAULT_MATRIX_PATH,
    ROUTED,
    UNROUTABLE,
    depot_key,
    write_matrix,
)

# Drivable road classes, and the free-flow speed assumed for each.
#
# These replace policy.yaml's single avg_speed_kmh: 45 for EVERY road, which
# is the assumption this whole exercise exists to remove. A federal route and
# a residential lane are not the same road, and the schedule should not price
# them identically.
#
# `_link` classes are slip roads: short, and taken slowly.
SPEED_KMH: dict[str, float] = {
    "motorway": 100.0,
    "trunk": 80.0,
    "primary": 70.0,
    "secondary": 60.0,
    "tertiary": 50.0,
    "unclassified": 40.0,
    "residential": 30.0,
    "motorway_link": 50.0,
    "trunk_link": 45.0,
    "primary_link": 40.0,
    "secondary_link": 35.0,
    "tertiary_link": 30.0,
    "living_street": 20.0,
    "service": 20.0,
}

# Speed for a way tagged access=private, instead of dropping it.
#
# A telecom tower sits at the end of a private access road more often than
# not, and the crew that maintains it is the party authorised to use that
# road — so excluding private ways outright strands the site. Measured: 2 of
# 1,164 towers came back on 126- and 134-node networks disconnected from the
# mainland, each with the tower 30-60 m away, which is the signature of an
# estate whose only link out is tagged private.
#
# Penalised rather than free, because a private way must never become a
# THROUGH route: at 12 km/h any alternative public road wins the shortest-path
# comparison, so the router reaches for one only when there is no other way in
# — which is precisely the last-mile case this is for.
PRIVATE_SPEED_KMH = 12.0

_R_EARTH_KM = 6371.0

# A tower may only snap to a road node whose connected component has at least
# this many nodes.
#
# WHY THIS EXISTS. Snapping to the nearest node FULL STOP strands a tower
# whenever its closest road is a fragment OSM never joined to the network — a
# service road inside a compound, a driveway, a way whose only link was a
# `track` this profile does not treat as drivable. Measured on the first full
# build: 64 towers came back unreachable from all 20 depots, and only 13 were
# on real islands. The other 51 included a tower in central Kuala Lumpur,
# 3 km from the Kuala Lumpur depot, which is not a routing result — it is an
# artefact.
#
# A genuine island keeps its own substantial network (Langkawi's is thousands
# of nodes), so this filter removes stubs without making an unbridged island
# look reachable. That distinction is the whole point: UNROUTABLE has to keep
# meaning "no road", never "bad snap".
MIN_COMPONENT_NODES = 100

# How far a tower may sit from the routable network before we stop claiming a
# road reaches it at all. Beyond this it is UNROUTABLE.
#
# THIS IS NOT A BOUND ON ROUTE LENGTH. The spec rejects that, and rightly: no
# threshold separates 84 km across the Malacca Strait from 60 km up a trunk
# road, and Kuching->Miri is a legitimate 534 km drive. This bounds something
# different — how far the tower is from ANY road, which is a question about
# whether the snap is credible, not about how long the journey is. Routing
# engines carry the same limit for the same reason (OSRM calls it a snapping
# radius).
#
# It is load-bearing because MIN_COMPONENT_NODES alone gets the Perhentian
# Islands WRONG in the opposite direction. Measured: the islands have no
# drivable `highway` ways at all in this extract — only paths and tracks — so
# their nearest routable node is 18.8 km away, ON THE MAINLAND, across open
# water. The component filter cannot save a tower whose island contributes no
# nodes to filter. Without this bound those four towers report as an 18 km
# drive, which is the same lie about the same strait that this whole module
# exists to stop telling.
#
# 10 km is generous for a real access track (the most remote genuine inland
# tower measured here sits 5.0 km off the classified network) and far below
# any of the water crossings (12.3, 17.6, 18.5, 18.8, 19.8 km).
MAX_SNAP_KM = 10.0


class _RoadCollector(osmium.SimpleHandler):
    """Two passes over the extract.

    Pass 1 records which node ids any drivable way references; pass 2 keeps
    the coordinates of only those nodes. A one-pass version would hold every
    node in Malaysia in memory (tens of millions) to keep the ~2 million that
    are actually on a road.
    """

    def __init__(self, want_nodes: set[int] | None):
        super().__init__()
        self.want_nodes = want_nodes
        self.node_lonlat: dict[int, tuple[float, float]] = {}
        self.edges: list[tuple[int, int, float]] = []  # (a, b, speed_kmh)
        self.referenced: set[int] = set()

    def way(self, w):
        hw = w.tags.get("highway")
        if hw is None:
            return
        speed = SPEED_KMH.get(hw)
        if speed is None:
            return  # footway, cycleway, path, steps, track… not drivable
        access = w.tags.get("access")
        if access == "no":
            return  # genuinely closed, not merely restricted
        if access == "private":
            speed = min(speed, PRIVATE_SPEED_KMH)
        refs = [n.ref for n in w.nodes]
        if len(refs) < 2:
            return
        if self.want_nodes is None:
            self.referenced.update(refs)
        else:
            for a, b in zip(refs, refs[1:]):
                self.edges.append((a, b, speed))

    def node(self, n):
        if self.want_nodes is not None and n.id in self.want_nodes:
            self.node_lonlat[n.id] = (n.location.lon, n.location.lat)


def _haversine_km(lon1, lat1, lon2, lat2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = p2 - p1
    dl = np.radians(np.asarray(lon2) - np.asarray(lon1))
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return 2 * _R_EARTH_KM * np.arcsin(np.sqrt(a))


def _load_towers(limit: int | None):
    from adapter.ml_source import load_scored_towers

    t = load_scored_towers()
    return t[:limit] if limit else t


def _parse(pbf: Path, cache: Path):
    """Parse the extract into (lon, lat, src, dst, km, min) arrays, cached.

    The two passes cost ~20 minutes and produce something that only changes
    when the EXTRACT changes — not when the tower list, the snap rule or the
    speed table does. Caching it turns a fix-and-retry cycle from 40 minutes
    into 2, which is the difference between iterating on the snap rule and
    guessing at it.
    """
    if cache.exists():
        print(f"reusing parsed graph {cache.name}", flush=True)
        z = np.load(cache)
        return z["lon"], z["lat"], z["src"], z["dst"], z["km"], z["minutes"]

    print("pass 1/2  scanning drivable ways…", flush=True)
    p1 = _RoadCollector(want_nodes=None)
    p1.apply_file(str(pbf), locations=False)
    wanted = p1.referenced
    print(f"          {len(wanted):,} road nodes referenced", flush=True)

    print("pass 2/2  reading coordinates and edges…", flush=True)
    p2 = _RoadCollector(want_nodes=wanted)
    p2.apply_file(str(pbf), locations=False)
    coords = p2.node_lonlat
    edges = p2.edges
    print(f"          {len(coords):,} nodes, {len(edges):,} edges", flush=True)

    # Compact node ids into contiguous indices for the sparse matrix.
    ids = np.fromiter(coords.keys(), dtype=np.int64)
    order = {int(v): i for i, v in enumerate(ids)}
    lon = np.array([coords[int(i)][0] for i in ids], dtype=np.float64)
    lat = np.array([coords[int(i)][1] for i in ids], dtype=np.float64)

    src, dst, w_km, w_min = [], [], [], []
    for a, b, speed in edges:
        ia, ib = order.get(a), order.get(b)
        if ia is None or ib is None:
            continue  # way crossed the extract boundary
        d = _haversine_km(lon[ia], lat[ia], lon[ib], lat[ib])
        src.append(ia)
        dst.append(ib)
        w_km.append(d)
        w_min.append(d / speed * 60.0)

    lon_a = np.asarray(lon, dtype=np.float64)
    lat_a = np.asarray(lat, dtype=np.float64)
    src_a = np.array(src, dtype=np.int32)
    dst_a = np.array(dst, dtype=np.int32)
    km_a = np.array(w_km, dtype=np.float32)
    min_a = np.array(w_min, dtype=np.float32)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.savez(cache, lon=lon_a, lat=lat_a, src=src_a, dst=dst_a, km=km_a, minutes=min_a)
    print(f"          cached parsed graph -> {cache}", flush=True)
    return lon_a, lat_a, src_a, dst_a, km_a, min_a


def build(pbf: Path, out: Path | None = None, limit: int | None = None,
          cache: Path | None = None) -> int:
    t0 = time.time()
    lon, lat, src, dst, w_km, w_min = _parse(
        pbf, cache or pbf.with_suffix(".graphcache.npz")
    )

    n = len(lon)
    # Undirected: one-ways are ignored (see the module docstring). Symmetrising
    # here rather than at query time keeps the two cost matrices consistent.
    si = np.concatenate([src, dst])
    di = np.concatenate([dst, src])
    g_km = coo_matrix((np.concatenate([w_km, w_km]).astype(np.float64), (si, di)), shape=(n, n)).tocsr()
    g_min = coo_matrix((np.concatenate([w_min, w_min]).astype(np.float64), (si, di)), shape=(n, n)).tocsr()
    print(f"          graph {n:,} x {n:,}, {g_km.nnz:,} directed edges", flush=True)

    # Only nodes on a network of real size are snap targets. See
    # MIN_COMPONENT_NODES for why, and for what it must NOT break.
    ncomp, labels = connected_components(g_km, directed=False)
    sizes = np.bincount(labels)
    ok_comp = sizes >= MIN_COMPONENT_NODES
    snappable = np.flatnonzero(ok_comp[labels])
    print(
        f"          {ncomp:,} components; {ok_comp.sum():,} have >= "
        f"{MIN_COMPONENT_NODES} nodes, giving {len(snappable):,} snap targets "
        f"({100*len(snappable)/n:.1f}% of nodes)",
        flush=True,
    )
    snap_lon = lon[snappable]
    snap_lat = lat[snappable]

    towers = _load_towers(limit)
    crews = load_crews()
    depots: dict[str, tuple[float, float]] = {}
    for c in crews:
        d = c["depot"]
        depots[depot_key(d["lon"], d["lat"])] = (float(d["lon"]), float(d["lat"]))

    def snap(plon: float, plat: float) -> tuple[int, float]:
        """Nearest node ON A REAL NETWORK, and how far off it the point sits.

        Returns the offset as well as the node because the last mile is not
        free: a tower 3 km from the nearest routable road is 3 km further away
        than the graph alone would say, and swallowing that would understate
        every leg to it. The caller adds it back.
        """
        d = _haversine_km(plon, plat, snap_lon, snap_lat)
        i = int(np.argmin(d))
        return int(snappable[i]), float(d[i])

    print(f"snapping {len(depots)} depots + {len(towers)} towers…", flush=True)
    depot_snap = {k: snap(*pt) for k, pt in depots.items()}
    tower_snap = {t["tower_id"]: snap(float(t["lon"]), float(t["lat"])) for t in towers}
    depot_node = {k: v[0] for k, v in depot_snap.items()}
    tower_node = {k: v[0] for k, v in tower_snap.items()}
    stranded = {tid for tid, (_, off) in tower_snap.items() if off > MAX_SNAP_KM}
    if stranded:
        worst = sorted(((off, tid) for tid, (_, off) in tower_snap.items()
                        if tid in stranded), reverse=True)
        print(f"          {len(stranded)} tower(s) sit >{MAX_SNAP_KM:.0f} km from any "
              f"routable road and are recorded UNROUTABLE; worst "
              f"{worst[0][0]:.1f} km ({worst[0][1]})", flush=True)

    keys = list(depots) + list(tower_node)
    rows: list[tuple[str, str, float, float, int, bool]] = []
    unroutable = 0

    # ONE Dijkstra per depot, not one per pair. 20 shortest-path trees answer
    # all 23,280 depot->tower questions; 23,280 point-to-point searches would
    # not finish.
    print(f"routing from {len(depot_node)} depots…", flush=True)
    t_idx = np.array(list(tower_node.values()), dtype=np.int32)
    t_ids = list(tower_node.keys())
    for i, (dk, dnode) in enumerate(depot_node.items(), 1):
        # TWO searches, and each metric gets its OWN optimum on purpose.
        #
        # The shortest route and the fastest route are different roads — a
        # motorway detour is longer in km and shorter in minutes. Reporting
        # one route's km with another's minutes would be incoherent, so each
        # number is the optimum of the question it answers:
        #
        #   km      -> the depot-range check, "is this site within 150 km of
        #              the depot by road", which is a question about distance
        #   minutes -> the shift clock, which is a question about time
        #
        # OSRM answers both from the duration-optimal route instead. The
        # difference is small on inter-town legs and is recorded in the
        # artefact's metadata rather than left for someone to rediscover.
        dist_km = dijkstra(g_km, directed=False, indices=dnode)
        dist_min = dijkstra(g_min, directed=False, indices=dnode)
        for tid, tn in zip(t_ids, t_idx):
            km = dist_km[tn]
            mins = dist_min[tn]
            # np.inf is Dijkstra saying the two points are in DIFFERENT
            # connected components of the road network — an island with no
            # bridge. That is a measurement, and it is recorded as UNROUTABLE
            # so scheduler/travel.py never falls back to the straight line.
            # No road comes within MAX_SNAP_KM of this tower, so there is no
            # honest drive time to report — whatever the graph says about the
            # node we snapped it to.
            if tid in stranded or not np.isfinite(km) or not np.isfinite(mins):
                rows.append((dk, tid, float("nan"), float("nan"), UNROUTABLE, False))
                rows.append((tid, dk, float("nan"), float("nan"), UNROUTABLE, False))
                unroutable += 2
            else:
                # Both snap offsets ride on the leg: depot->network at one end,
                # network->tower at the other. Charged at 40 km/h, since a last
                # mile off the classified network is not motorway driving.
                off = depot_snap[dk][1] + tower_snap[tid][1]
                r_km = float(km) + off
                r_min = float(mins) + off / 40.0 * 60.0
                rows.append((dk, tid, r_km, r_min, ROUTED, False))
                # The RETURN leg, so the solver can charge a crew for driving
                # home. This graph is undirected — one-ways are already out of
                # scope, see the module docstring — so the reverse leg is the
                # same measurement and is written rather than re-derived. An
                # OSRM-built matrix must NOT copy this: its table is directed
                # and the two directions genuinely differ.
                rows.append((tid, dk, r_km, r_min, ROUTED, False))
        print(f"          depot {i}/{len(depot_node)}", flush=True)

    out = out or DEFAULT_MATRIX_PATH
    written = write_matrix(
        out,
        keys=keys,
        rows=rows,
        meta={
            "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "osm_extract": pbf.name,
            "profile": "osm-dijkstra (speed by highway class)",
            "engine": "pyosmium + scipy.sparse.csgraph",
            "towers": len(tower_node),
            "depots": len(depots),
            "unroutable": unroutable,
            "scope": "depot<->tower, both directions",
            "private_speed_kmh": PRIVATE_SPEED_KMH,
            "min_component_nodes": MIN_COMPONENT_NODES,
            "max_snap_km": MAX_SNAP_KM,
            "caveats": "undirected (one-ways ignored); no ferry routing, so an "
            "island with no fixed link is UNROUTABLE rather than ferry-routed; "
            "km is the distance-optimal route and minutes the time-optimal one, "
            "each the optimum of the question it answers (OSRM reports both "
            "from the duration-optimal route)",
        },
    )
    print(
        f"\nwrote {out}\n  {written:,} pairs, {unroutable:,} unroutable, "
        f"{time.time() - t0:.0f}s"
    )
    return written


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pbf", type=Path, required=True, help="OSM extract (.osm.pbf)")
    ap.add_argument("--out", type=Path, default=None)
    ap.add_argument("--limit", type=int, default=None, help="towers, for a smoke run")
    ap.add_argument("--cache", type=Path, default=None,
                    help="parsed-graph cache (default: alongside the .pbf). Delete it "
                         "to force a re-parse after changing the speed table.")
    a = ap.parse_args()
    build(a.pbf, out=a.out, limit=a.limit, cache=a.cache)
