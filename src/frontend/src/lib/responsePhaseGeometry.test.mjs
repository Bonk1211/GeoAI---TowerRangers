import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectRetuningNeighbors,
  retuneBearingAt,
  assignRetuningNeighbors,
  clusterDownTowers,
  RETUNE_STILL_T,
} from './responsePhaseGeometry.ts';
import { bearingDeg } from './coverageGeometry.ts';
import { haversineKm as haversineTestKm } from './geo.ts';

const DOWN = { lon: 116.07, lat: 5.98 };

test('selectRetuningNeighbors excludes the down tower set entirely', () => {
  const candidates = [
    { tower_id: 'A', lon: 116.08, lat: 5.98 },
    { tower_id: 'B', lon: 116.06, lat: 5.97 },
  ];
  const result = selectRetuningNeighbors(DOWN, candidates, new Set(['A']));
  assert.deepEqual(result.map((t) => t.tower_id), ['B']);
});

test('selectRetuningNeighbors excludes towers beyond the search radius', () => {
  const candidates = [
    { tower_id: 'near', lon: 116.08, lat: 5.98 },
    { tower_id: 'far', lon: 118.0, lat: 7.0 }, // hundreds of km away
  ];
  const result = selectRetuningNeighbors(DOWN, candidates, new Set());
  assert.deepEqual(result.map((t) => t.tower_id), ['near']);
});

test('selectRetuningNeighbors caps at 3 and picks the nearest one when candidates share a bearing sector', () => {
  // All four candidates sit within the same 120-degree bearing sector from
  // DOWN (roughly NE), so only the nearest of them (d1) should be picked —
  // sector-spread selection deliberately does not fall back to a second
  // pick from an already-used direction.
  const candidates = [
    { tower_id: 'd1', lon: 116.071, lat: 5.981 },
    { tower_id: 'd2', lon: 116.09, lat: 5.99 },
    { tower_id: 'd3', lon: 116.10, lat: 6.0 },
    { tower_id: 'd4', lon: 116.11, lat: 6.01 },
  ];
  const result = selectRetuningNeighbors(DOWN, candidates, new Set());
  assert.ok(result.length <= 3);
  assert.deepEqual(result.map((t) => t.tower_id), ['d1']);
});

test('selectRetuningNeighbors spreads picks across bearing sectors instead of bunching on one side', () => {
  // One candidate per 120-degree sector (bearings ~10, ~130, ~250 from
  // DOWN) — every one should be picked, not just the globally nearest
  // handful from whichever sector happens to be locally denser.
  const candidates = [
    { tower_id: 'sectorA', lon: 116.0826, lat: 6.0509 }, // bearing ~10
    { tower_id: 'sectorB', lon: 116.1254, lat: 5.9338 }, // bearing ~130
    { tower_id: 'sectorC', lon: 116.0020, lat: 5.9554 }, // bearing ~250
  ];
  const result = selectRetuningNeighbors(DOWN, candidates, new Set());
  assert.deepEqual(new Set(result.map((t) => t.tower_id)), new Set(['sectorA', 'sectorB', 'sectorC']));
});

test('selectRetuningNeighbors excludes the down tower itself (zero distance)', () => {
  const candidates = [{ tower_id: 'self', lon: DOWN.lon, lat: DOWN.lat }];
  const result = selectRetuningNeighbors(DOWN, candidates, new Set());
  assert.deepEqual(result, []);
});

test('retuneBearingAt at t=0 is the nominal (due north) bearing', () => {
  const neighbor = { lon: 116.08, lat: 5.98 };
  assert.equal(retuneBearingAt(neighbor, DOWN, 0), 0);
});

test('retuneBearingAt at t=1 equals the true bearing toward the down tower', () => {
  const neighbor = { lon: 116.0, lat: 5.98 }; // due west of DOWN -> bearing ~90 (east)
  const bearing = retuneBearingAt(neighbor, DOWN, 1);
  assert.ok(Math.abs(bearing - 90) < 1);
});

test('retuneBearingAt is monotone-ish between 0 and 1 (no NaN, stays in range)', () => {
  const neighbor = { lon: 116.0, lat: 5.9 };
  for (const t of [0, 0.25, 0.5, 0.75, 1]) {
    const bearing = retuneBearingAt(neighbor, DOWN, t);
    assert.ok(Number.isFinite(bearing));
    assert.ok(bearing >= 0 && bearing < 360);
  }
});

test('retuneBearingAt clamps t outside [0, 1]', () => {
  const neighbor = { lon: 116.0, lat: 5.98 };
  const atNegative = retuneBearingAt(neighbor, DOWN, -5);
  const atZero = retuneBearingAt(neighbor, DOWN, 0);
  assert.equal(atNegative, atZero);

  const atOver = retuneBearingAt(neighbor, DOWN, 5);
  const atOne = retuneBearingAt(neighbor, DOWN, 1);
  assert.equal(atOver, atOne);
});

test('RETUNE_STILL_T is fully retuned (t=1), the reduced-motion still state', () => {
  assert.equal(RETUNE_STILL_T, 1);
});

test('assignRetuningNeighbors gives each down tower its OWN nearest neighbours, not a shared target', () => {
  const downA = { tower_id: 'downA', lon: 116.0, lat: 5.9 };
  const downB = { tower_id: 'downB', lon: 117.0, lat: 6.9 }; // far away, distinct area
  const nearA = { tower_id: 'nearA', lon: 116.01, lat: 5.91 };
  const nearB = { tower_id: 'nearB', lon: 117.01, lat: 6.91 };
  const result = assignRetuningNeighbors([downA, downB], [nearA, nearB], new Set(['downA', 'downB']));
  const forA = result.find((r) => r.downTower.tower_id === 'downA');
  const forB = result.find((r) => r.downTower.tower_id === 'downB');
  assert.deepEqual(forA.neighbors.map((n) => n.tower_id), ['nearA']);
  assert.deepEqual(forB.neighbors.map((n) => n.tower_id), ['nearB']);
});

test('assignRetuningNeighbors never assigns the same candidate to two down towers', () => {
  const downA = { tower_id: 'downA', lon: 116.0, lat: 5.9 };
  const downB = { tower_id: 'downB', lon: 116.02, lat: 5.92 }; // close to downA
  const midpoint = { tower_id: 'mid', lon: 116.005, lat: 5.905 }; // nearer downA
  const result = assignRetuningNeighbors([downA, downB], [midpoint], new Set(['downA', 'downB']));
  const assignedTo = result.filter((r) => r.neighbors.some((n) => n.tower_id === 'mid'));
  assert.equal(assignedTo.length, 1);
});

test('assignRetuningNeighbors excludes every down tower from candidate pools', () => {
  const downA = { tower_id: 'downA', lon: 116.0, lat: 5.9 };
  const downB = { tower_id: 'downB', lon: 116.02, lat: 5.92 };
  const result = assignRetuningNeighbors([downA, downB], [downA, downB], new Set(['downA', 'downB']));
  for (const r of result) assert.deepEqual(r.neighbors, []);
});

test('assignRetuningNeighbors returns one assignment per down tower, in the input order', () => {
  const downA = { tower_id: 'downA', lon: 116.0, lat: 5.9 };
  const downB = { tower_id: 'downB', lon: 117.0, lat: 6.9 };
  const result = assignRetuningNeighbors([downA, downB], [], new Set(['downA', 'downB']));
  assert.deepEqual(result.map((r) => r.downTower.tower_id), ['downA', 'downB']);
});

test('assignRetuningNeighbors on an empty down-tower list returns nothing', () => {
  assert.deepEqual(assignRetuningNeighbors([], [{ tower_id: 'x', lon: 0, lat: 0 }], new Set()), []);
});

// A single isolated down tower now ring-packs into 8 deployments (1 centre
// + 7 ring positions) against the real COVERAGE_GAP_RADIUS_KM (3.5km) /
// COW_COVERAGE_RADIUS_KM (1.4km) constants — see sitesPerDownTower's doc
// comment. This is the operator-requested behaviour (2026-09-16): send as
// many jeeps as it takes to visibly cover a down tower's own red gap
// circle, not just one per outage pocket.
const SITES_PER_ISOLATED_TOWER = 8;

/** Generates N survivor towers evenly spread in a ring around `center`, so
 *  tests that need "plenty of land witnesses nearby" don't have to
 *  hand-place dozens of coordinates. Placed close enough (0.5-2km) to
 *  witness a ring-packed target under LAND_WITNESS_RADIUS_KM (2.5km),
 *  spread across bearings so every ring position finds a witness. */
function survivorRing(center, count, radiusKm = 1) {
  const R = 6371;
  return Array.from({ length: count }, (_, i) => {
    const bearing = (360 * i) / count;
    const rad = (bearing * Math.PI) / 180;
    const angularDistance = radiusKm / R;
    const lat1 = (center.lat * Math.PI) / 180;
    const lon1 = (center.lon * Math.PI) / 180;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularDistance) + Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(rad),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(rad) * Math.sin(angularDistance) * Math.cos(lat1),
        Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
      );
    return {
      tower_id: `${center.lon},${center.lat}-ring${i}`,
      lon: (lon2 * 180) / Math.PI,
      lat: (lat2 * 180) / Math.PI,
    };
  });
}

test('clusterDownTowers keeps far-apart towers in separate outage pockets', () => {
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const b = { tower_id: 'b', lon: 117.0, lat: 6.9 }; // hundreds of km away
  const clusters = clusterDownTowers([a, b], [...survivorRing(a, 20), ...survivorRing(b, 20)], new Set(['a', 'b']));
  const pocketsForA = new Set(clusters.filter((c) => c.members.some((m) => m.tower_id === 'a')).map((c) => c.members.length));
  const pocketsForB = new Set(clusters.filter((c) => c.members.some((m) => m.tower_id === 'b')).map((c) => c.members.length));
  // Every deployment covering 'a' must report ONLY 'a' as its member (never
  // mixed with 'b's), and vice versa — the two outages never merge into one
  // reported pocket even though each now produces several deployments.
  assert.ok([...pocketsForA].every((n) => n === 1));
  assert.ok([...pocketsForB].every((n) => n === 1));
  const allTowerIdsInAPockets = new Set(
    clusters.filter((c) => c.members.some((m) => m.tower_id === 'a')).flatMap((c) => c.members.map((m) => m.tower_id)),
  );
  assert.deepEqual(allTowerIdsInAPockets, new Set(['a']));
});

test('clusterDownTowers merges towers within the cluster radius into one reported pocket', () => {
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const b = { tower_id: 'b', lon: 116.005, lat: 5.905 }; // ~700m away
  const c = { tower_id: 'c', lon: 116.008, lat: 5.908 }; // close to b, chains transitively
  const survivors = survivorRing(a, 20, 1.5);
  const clusters = clusterDownTowers([a, b, c], survivors, new Set(['a', 'b', 'c']));
  // Every deployment for this pocket must report all three as members —
  // the coarse grouping (who counts as "the same pocket") is unchanged by
  // ring-packing, only how many SITES that pocket gets.
  assert.ok(clusters.length > 0);
  for (const cluster of clusters) {
    assert.deepEqual(cluster.members.map((m) => m.tower_id).sort(), ['a', 'b', 'c']);
  }
});

test('clusterDownTowers sites every deployment at its own ring target, contained within the gap radius', () => {
  // Sites are no longer a real tower's coordinates (2026-09-17 rework) —
  // they are ring-packed points, each within COVERAGE_GAP_RADIUS_KM (3.5km)
  // of the down tower it covers for, i.e. inside the red circle the map
  // draws. A witness tower nearby is required for ACCEPTANCE, but the site
  // itself must never equal a down tower's own coordinates (the map must
  // not draw a jeep exactly on the OFFLINE marker it's covering for).
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const b = { tower_id: 'b', lon: 116.005, lat: 5.905 };
  const survivors = survivorRing(a, 20, 1);
  const downTowerIds = new Set(['a', 'b']);
  const clusters = clusterDownTowers([a, b], [a, b, ...survivors], downTowerIds);
  assert.ok(clusters.length > 0);
  for (const cluster of clusters) {
    assert.ok(haversineTestKm(cluster.site, a) > 0.01, 'site must not sit exactly on down tower a');
    assert.ok(haversineTestKm(cluster.site, b) > 0.01, 'site must not sit exactly on down tower b');
    const nearestMember = cluster.members.reduce((min, m) => Math.min(min, haversineTestKm(m, cluster.site)), Infinity);
    assert.ok(nearestMember <= 3.5, `site must sit within the gap radius of a member it covers, got ${nearestMember}km`);
  }
});

test('clusterDownTowers ring-packs an isolated down tower into multiple deployments when nothing nearby can retune', () => {
  // The core of the operator ask (2026-09-16): one down tower with plenty
  // of nearby witnesses (but nothing that can retune toward it) should get
  // several jeeps, not just one, so their COW_COVERAGE_RADIUS_KM circles
  // can jointly reach most of its COVERAGE_GAP_RADIUS_KM dead-zone rather
  // than leaving most of the red circle uncovered by a single centrally-
  // parked unit. Witnesses are placed at LAND_WITNESS_RADIUS_KM (2.5km) —
  // inside witness range but OUTSIDE NEIGHBOR_SEARCH_RADIUS_KM's retune
  // reach is not achievable simultaneously at this small a scale, so this
  // test instead marks the "survivors" as themselves down (no live neighbour
  // to retune at all) — they still witness the ring targets are on land
  // (LAND_WITNESS_RADIUS_KM accepts a down-tower witness, see that
  // constant's doc comment) without contributing any retune coverage.
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const nearby = survivorRing(a, 30, 1.5);
  const downTowerIds = new Set(['a', ...nearby.map((t) => t.tower_id)]);
  const clusters = clusterDownTowers([a], [a, ...nearby], downTowerIds);
  assert.ok(
    clusters.length >= 4,
    `expected several deployments when nothing nearby can retune, got ${clusters.length}`,
  );
  for (const cluster of clusters) {
    assert.deepEqual(cluster.members.map((m) => m.tower_id), ['a']);
  }
  const siteIds = new Set(clusters.map((c) => c.site.tower_id));
  assert.equal(siteIds.size, clusters.length, 'every deployment must land on a distinct site');
});

test('sitesPerDownTower ring-packs to 8 deployments for the real project constants when nothing can retune', () => {
  // Pins the actual shipped ring size (1 centre + 7 ring positions) against
  // COVERAGE_GAP_RADIUS_KM=3.5 / COW_COVERAGE_RADIUS_KM=1.4 — if either
  // radius constant is retuned, this test forces a look at whether the
  // resulting jeep count still reads as "enough to cover the gap." Uses
  // down-tower witnesses (see the test above) so the retune-first gate
  // (2026-09-17) contributes zero coverage and the full, ungated ring size
  // is what's being pinned here.
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const nearby = survivorRing(a, 30, 1.5);
  const downTowerIds = new Set(['a', ...nearby.map((t) => t.tower_id)]);
  const clusters = clusterDownTowers([a], [a, ...nearby], downTowerIds);
  assert.equal(clusters.length, SITES_PER_ISOLATED_TOWER);
});

test('clusterDownTowers requests fewer COW sites when nearby survivors are already retuning (retune-first gate)', () => {
  // The 'cow' beat's own console line claims "neighbour-cell retune
  // insufficient for terrain" — this pins that the claim is backed by a
  // real computation (2026-09-17), not narration: the SAME isolated down
  // tower with the SAME dense ring of nearby towers requests FEWER COW
  // sites when those towers are SURVIVING (and therefore retune-eligible)
  // than when they are all DOWN (and therefore cannot retune at all, see
  // the two tests above). If this regressed to equal counts, the gate
  // would have stopped doing anything.
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const nearby = survivorRing(a, 30, 1.5);
  const withRetune = clusterDownTowers([a], nearby, new Set(['a'])).length;
  const withoutRetune = clusterDownTowers(
    [a],
    [a, ...nearby],
    new Set(['a', ...nearby.map((t) => t.tower_id)]),
  ).length;
  assert.ok(
    withRetune < withoutRetune,
    `expected retune-covered bearings to reduce COW requests (${withRetune} vs ${withoutRetune})`,
  );
});

test('clusterDownTowers assigns synthetic ids to accepted sites, never a real tower\'s id', () => {
  // A site is a ring-packed point, not a real tower's coordinates — its id
  // must be synthetic (`cow-<n>`) so two pockets that happen to accept
  // sites witnessed by the same survivor are never confused for the same
  // deployment (2026-09-16 regression this guards against structurally).
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const survivor = { tower_id: 'survivor', lon: 116.01, lat: 5.91 };
  const clusters = clusterDownTowers([a], [survivor], new Set(['a']));
  assert.ok(clusters.length > 0, 'a witnessed target near the down tower should produce at least one site');
  for (const cluster of clusters) {
    assert.notEqual(cluster.site.tower_id, 'survivor');
    assert.match(cluster.site.tower_id, /^cow-\d+$/);
  }
});

test('clusterDownTowers deploys nothing when no candidate towers exist anywhere', () => {
  // Zero candidate towers (down or surviving) means no land witness is
  // possible for any ring target. Accepting a target anyway used to ship a
  // real bug: a ring point is pure bearing-and-distance math with no
  // coastline awareness, so it could land over open water with a jeep icon
  // parked on the sea (2026-09-16, operator screenshot). Zero deployments
  // is the honest report of "this project has no evidence this ground is
  // buildable," not something to paper over with a fabricated site.
  const a = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const clusters = clusterDownTowers([a], [], new Set(['a']));
  assert.deepEqual(clusters, []);
});

test('clusterDownTowers accepts a witness that is itself a down tower, not only survivors', () => {
  // Reproduces the shape of the exact live-data regression this module's
  // history is built around (2026-09-16): the Sabah flood scenario's
  // MAX_DOWN_TOWERS=12 flood-share ranking can pick every real tower in a
  // whole area as down, leaving few or no surviving towers nearby. Under
  // the current (2026-09-17) siting rule, the down towers THEMSELVES still
  // witness that the surrounding ground is land — a flooded compound is as
  // much evidence of buildable ground as a working one — so a pocket like
  // this still produces deployments instead of going to zero. Coordinates
  // are the real values from that live incident, not invented.
  const downTowers = [
    { tower_id: 'MY_N10251772774', lon: 116.08648, lat: 5.97694 },
    { tower_id: 'MY_N10264085957', lon: 116.10705, lat: 5.95474 },
    { tower_id: 'MY_N10264190520', lon: 116.11291, lat: 5.95453 },
    { tower_id: 'MY_N10125233295', lon: 116.06722, lat: 5.9534 },
    { tower_id: 'MY_N10125233294', lon: 116.06753, lat: 5.95342 },
    { tower_id: 'MY_N10137863759', lon: 116.10465, lat: 5.95468 },
    { tower_id: 'MY_N10263911645', lon: 116.10469, lat: 5.95426 },
  ];
  const downTowerIds = new Set(downTowers.map((t) => t.tower_id));
  // No survivors at all — only the down towers themselves as witnesses.
  const clusters = clusterDownTowers(downTowers, downTowers, downTowerIds);
  assert.ok(clusters.length > 0, 'a dense cluster of down towers should still witness deployments near itself');
});

test('clusterDownTowers does not chain a long line of towers into one giant reported pocket', () => {
  // Each consecutive pair is ~1.5km apart (nearest-neighbour joinable), but
  // the chain spans roughly 6km end to end — single-linkage would merge all
  // 5 into one pocket, which is the bug this centroid-bounded version fixes.
  const chain = [0, 1, 2, 3, 4].map((i) => ({
    tower_id: `t${i}`,
    lon: 116.0 + i * 0.0135, // ~1.5km per step at this latitude
    lat: 5.9,
  }));
  const survivors = chain.flatMap((t) => survivorRing(t, 6, 1));
  const downTowerIds = new Set(chain.map((t) => t.tower_id));
  const clusters = clusterDownTowers(chain, survivors, downTowerIds);
  const memberSets = new Set(clusters.map((c) => c.members.map((m) => m.tower_id).sort().join(',')));
  assert.ok(memberSets.size > 1, 'a 6km chain must not collapse into a single reported pocket');
  for (const set of memberSets) {
    assert.ok(set.split(',').length < chain.length, 'no single pocket should swallow the whole chain');
  }
});

test('clusterDownTowers gives distinct pockets DISTINCT, separated sites even when witnessed by overlapping survivors', () => {
  // Two pockets far enough apart to stay separate (per CLUSTER_RADIUS_KM)
  // but both witnessed by a shared nearby pool of survivors. Since sites
  // are ring targets (not the survivors' own coordinates), every deployment
  // naturally lands near its own down tower rather than colliding on a
  // shared witness — pinned here so that never regresses.
  const a1 = { tower_id: 'a1', lon: 116.0, lat: 5.9 };
  const b1 = { tower_id: 'b1', lon: 116.05, lat: 5.9 }; // ~5.5km from a1, well outside CLUSTER_RADIUS_KM
  const survivors = [...survivorRing(a1, 10, 1.5), ...survivorRing(b1, 10, 1.5)];
  const downTowerIds = new Set(['a1', 'b1']);
  const clusters = clusterDownTowers([a1, b1], survivors, downTowerIds);
  const forA = clusters.filter((c) => c.members[0].tower_id === 'a1');
  const forB = clusters.filter((c) => c.members[0].tower_id === 'b1');
  assert.ok(forA.length > 0 && forB.length > 0, 'both pockets must produce at least one deployment');
  for (const siteA of forA) {
    for (const siteB of forB) {
      assert.ok(
        haversineTestKm(siteA.site, siteB.site) > 2,
        'sites from different pockets must not collapse onto the same point',
      );
    }
  }
});

test('clusterDownTowers on an empty list returns no clusters', () => {
  assert.deepEqual(clusterDownTowers([], [], new Set()), []);
});

test('clusterDownTowers caps total deployments fleet-wide, round-robin across pockets', () => {
  // Four widely-separated down towers (each its own pocket), each with
  // plenty of nearby survivors — unbounded ring-packing would request
  // ~8 deployments per pocket (32 total). MAX_TOTAL_DEPLOYMENTS (24) must
  // cap that, and round-robin distribution means no pocket should be
  // starved to zero while another pocket gets its full ring.
  const towers = [
    { tower_id: 'a', lon: 116.0, lat: 5.9 },
    { tower_id: 'b', lon: 117.0, lat: 6.9 },
    { tower_id: 'c', lon: 118.0, lat: 7.9 },
    { tower_id: 'd', lon: 119.0, lat: 8.9 },
  ];
  const survivors = towers.flatMap((t) => survivorRing(t, 30, 1.5));
  const downTowerIds = new Set(towers.map((t) => t.tower_id));
  const clusters = clusterDownTowers(towers, survivors, downTowerIds);
  assert.ok(clusters.length <= 24, `expected the fleet-wide cap to hold, got ${clusters.length}`);
  assert.ok(clusters.length < 32, 'cap must actually have trimmed something for this to be a meaningful test');
  const countByTower = new Map();
  for (const c of clusters) {
    const id = c.members[0].tower_id;
    countByTower.set(id, (countByTower.get(id) ?? 0) + 1);
  }
  assert.equal(countByTower.size, 4, 'every one of the four pockets must get at least one deployment');
  const counts = [...countByTower.values()];
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `round-robin should keep counts balanced, got ${counts}`);
});

test('clusterDownTowers keeps a trimmed pocket\'s ring sites spread around the down tower, not bunched on one side', () => {
  // Reproduces the operator-reported "thin uncovered strip" bug (2026-09-16,
  // second screenshot): with several simultaneous pockets sharing one
  // fleet-wide MAX_TOTAL_DEPLOYMENTS budget, a pocket can get trimmed down
  // to only 2-3 of its ring's 7 positions. If ring positions were kept in
  // their original sequential-bearing order (0, 1/7, 2/7, ...), trimming to
  // the first 3 would ALWAYS keep the same low-bearing arc and drop the
  // rest — every capped pocket would systematically miss the same side.
  // spreadOrder's bit-reversal ordering means even a short kept prefix
  // should span most of the circle. Six widely-separated pockets forces
  // heavy trimming (6 x 8 = 48 requested against a 24 cap, so each pocket
  // keeps roughly 4 of its 8).
  const towers = Array.from({ length: 6 }, (_, i) => ({
    tower_id: `t${i}`,
    lon: 116.0 + i * 10, // far enough apart to never share a pocket
    lat: 5.9,
  }));
  const survivors = towers.flatMap((t) => survivorRing(t, 30, 1.5));
  const downTowerIds = new Set(towers.map((t) => t.tower_id));
  const clusters = clusterDownTowers(towers, survivors, downTowerIds);
  for (const tower of towers) {
    const forTower = clusters.filter((c) => c.members[0].tower_id === tower.tower_id);
    if (forTower.length < 2) continue; // nothing to spread-check with 0-1 sites
    const bearings = forTower
      .map((c) => bearingDeg(tower, c.site))
      .sort((a, b) => a - b);
    // Largest angular gap between consecutive kept bearings (wrapping
    // around 360). A bunched-on-one-side selection leaves one huge gap
    // covering most of the circle; a spread selection keeps every gap
    // reasonably close to 360/count.
    let maxGap = 0;
    for (let i = 0; i < bearings.length; i++) {
      const next = bearings[(i + 1) % bearings.length];
      const gap = i === bearings.length - 1 ? 360 - bearings[i] + next : next - bearings[i];
      maxGap = Math.max(maxGap, gap);
    }
    const evenGap = 360 / bearings.length;
    assert.ok(
      maxGap < evenGap * 2.5,
      `pocket ${tower.tower_id} kept ${bearings.length} sites but largest angular gap is ${maxGap.toFixed(0)}° (expected roughly evenly spread, ~${evenGap.toFixed(0)}° apart)`,
    );
  }
});

test('clusterDownTowers deploys nothing when the only nearby tower is too far to witness any ring target', () => {
  // The only other tower available is ~15km from the down tower — beyond
  // LAND_WITNESS_RADIUS_KM (2.5km) of every one of its ring targets (which
  // sit at most COVERAGE_GAP_RADIUS_KM, 3.5km, from the down tower itself).
  // No target has a witness, so no site is accepted. Zero deployments is
  // the honest, non-fabricated result here.
  const down = { tower_id: 'a', lon: 116.0, lat: 5.9 };
  const farTower = { tower_id: 'far', lon: 116.15, lat: 5.9 }; // ~15km away
  const clusters = clusterDownTowers([down], [farTower], new Set(['a']));
  assert.deepEqual(clusters, []);
});
