import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareRoadMotion, roadHoldPoint, roadPositionAt } from './simulationRoadMotion.ts';

test('vehicles follow exact road bends by distance, including duplicate vertices and seek endpoints', () => {
  const vertices = [[0, 0], [0, 0], [.01, 0], [.01, .03], [.01, .03]];
  const road = prepareRoadMotion(vertices);
  const samples = [0, .125, .25, .5, .75, 1].map(t => roadPositionAt(road, t));
  assert.deepEqual([samples[0].lon, samples[0].lat], vertices[0]);
  assert.deepEqual([samples.at(-1).lon, samples.at(-1).lat], vertices.at(-1));
  assert.ok(Math.abs(samples[1].lon - .005) < 1e-10);
  assert.equal(samples[1].lat, 0);
  assert.equal(samples[3].lon, .01);
  assert.ok(Math.abs(samples[3].lat - .01) < 1e-10);
  for (let i = samples.length - 1; i >= 0; i--) {
    assert.deepEqual(roadPositionAt(road, [0, .125, .25, .5, .75, 1][i]), samples[i]);
  }
  assert.deepEqual(roadPositionAt(road, -.1), samples[0]);
  assert.deepEqual(roadPositionAt(road, 2), samples.at(-1));
  for (const points of [[[116, 6]], [[116, 6], [116, 6], [116, 6]]]) {
    const stationary = roadPositionAt(prepareRoadMotion(points), .8);
    assert.deepEqual([stationary.lon, stationary.lat], [116, 6]);
  }
  assert.equal(prepareRoadMotion([]), null);
  assert.equal(prepareRoadMotion([[116, 6], [NaN, 6]]), null);

  const first = { entry: { day: '2026-09-20' }, from: { lon: 116, lat: 6 }, road: { status: 'routed', coordinates: [[116, 6], [116.01, 6]] } };
  const held = { entry: { day: '2026-09-20' }, from: { lon: 116.011, lat: 6.001 }, road: { status: 'blocked', coordinates: [] } };
  const nextDay = { entry: { day: '2026-09-21' }, from: { lon: 116, lat: 6 } };
  assert.deepEqual(roadHoldPoint([first, held], held), { lon: 116.01, lat: 6 });
  assert.deepEqual(roadHoldPoint([first, held, nextDay], nextDay), { lon: 116, lat: 6 });
  assert.deepEqual(roadHoldPoint([nextDay], nextDay), nextDay.from);
});

test('road dispatch preserves missing jobs and holds movement after a blocked leg', async () => {
  const { simulationRoadLegs, simulationRoadCrewAt } = await import('./simulationRoads.ts');
  const crew = { crew_id: 'crew', territory: 'Sabah', depot: { lon: 116, lat: 6 } };
  const entries = ['missing', 'known', 'tomorrow'].map((tower_id, i) => ({ crew_id: 'crew', tower_id, order: i, day: i === 2 ? '2026-09-21' : '2026-09-20', pin_reason: 'emergency' }));
  const towers = [{ tower_id: 'known', lon: 116.01, lat: 6 }, { tower_id: 'tomorrow', lon: 116.02, lat: 6 }];
  const legs = simulationRoadLegs({ entries }, [crew], towers, true, new Set(entries.map(e => e.tower_id)));
  assert.equal(legs.length, 3);
  assert.equal(legs[0].to, null);
  assert.deepEqual(legs[1].from, crew.depot);
  assert.deepEqual(legs[2].from, crew.depot);
  assert.equal(simulationRoadCrewAt(54_000, true, legs).held, true);
  assert.equal(simulationRoadCrewAt(67_000, true, legs).leg, legs[0]);
  assert.equal(simulationRoadCrewAt(67_000, true, legs).travel, 0);
  legs[2].road = { status: 'routed', coordinates: [[116, 6], [116.02, 6]] };
  assert.equal(simulationRoadCrewAt(78_000, true, legs).leg, legs[2]);
  assert.equal(simulationRoadCrewAt(78_000, true, legs).held, false);
  assert.equal(simulationRoadCrewAt(88_000, true, legs), null);
});

test('two PRIME bases stay fixed while southern crews hold and northern crews take the extended approach', async () => {
  const { simulationResponseLegs, simulationRoadCrewAt, simulationRoadRequests, simulationNetworkCrewPosts } = await import('./simulationRoads.ts');
  const { haversineKm } = await import('./geo.ts');
  const saved = Array.from({ length: 12 }, (_, i) => ({ id: `job-${i}`, crewId: 'SBH-P1',
    entry: { tower_id: `site-${i}`, day: '2026-09-20', crew_id: 'SBH-P1', order: i },
    from: { lon: 116.073, lat: 5.98 }, to: { lon: 116.1, lat: 5.95 + i * .01 } }));
  const before = structuredClone(saved);
  const fleet = simulationResponseLegs(saved);
  const prime = fleet.filter(leg => leg.unitKind === 'mobile-network');
  const crews = fleet.filter(leg => leg.unitKind === 'network-crew');
  assert.equal(fleet.length, 6);
  assert.equal(prime.length, 2);
  assert.equal(crews.length, 4);
  assert.deepEqual(prime.flatMap(leg => leg.coverageTowerIds).sort(), saved.map(leg => leg.entry.tower_id).sort());
  assert.deepEqual(simulationResponseLegs(saved.toReversed()), fleet);
  assert.deepEqual(simulationResponseLegs([]), []);
  assert.deepEqual(saved, before);
  assert.ok(fleet.every(leg => leg.crewId === 'SBH-P1' && leg.entry.crew_id === 'SBH-P1'));
  const requests = simulationRoadRequests(fleet);
  assert.equal(requests.length, 2, 'crew transfers are assessed only after PRIME posts resolve');
  assert.ok(requests.every(request => request.avoid_flood && request.destination_outside_flood && request.stage_outside_flood));
  for (const [i, leg] of prime.entries()) {
    assert.equal(roadHoldPoint([leg], leg), null, 'unresolved staging never falls back to a flooded depot');
    leg.road = { status: 'routed', staging: { lon: 116.13, lat: 6 + i * .075 },
      coordinates: Array.from({ length: 11 }, (_, j) => [116.13 + j / 10_000, 6 + i * .075]),
      departure_route: { status: 'routed', coordinates: [[116.3, 6], [116.2, 6]] } };
    for (const reduced of [false, true]) for (const time of [54_000, 62_000, 68_000, 76_000, 79_999, 80_000, 88_000, 92_000, 102_000]) {
      const motion = simulationRoadCrewAt(time, true, [leg], reduced);
      assert.equal(motion.travel, 0, 'PRIME never leaves its drone launch position');
      assert.equal(motion.returning, false);
      assert.equal(motion.stationary, true);
      assert.equal(motion.deployed, time >= 68_000);
    }
    assert.equal(simulationRoadCrewAt(NaN, true, [leg]), null);
  }
  const posts = simulationNetworkCrewPosts(prime.map(leg => leg.road));
  assert.equal(new Set(posts.map(post => JSON.stringify(post.from))).size, 4, 'four mapped starting posts remain separately visible');
  for (const post of posts.slice(0, 2)) assert.equal(post.from.lat, prime[0].road.staging.lat, 'the southern pair keeps its existing posts');
  for (const post of posts.slice(2)) {
    assert.ok(post.from.lat > 6.10 && post.from.lat < 6.15, 'the moving pair starts farther along the northern approach');
    assert.ok(haversineKm(post.from, post.to) > 5 && haversineKm(post.from, post.to) < 15, 'the northern pair has a substantially longer approach');
  }
  assert.deepEqual(simulationNetworkCrewPosts([undefined, prime[1].road]).slice(2), posts.slice(2), 'northern posts do not depend on the southern base');
  for (const [index, leg] of crews.entries()) {
    const post = posts[index];
    leg.from = post.from;
    leg.road = { status: 'routed', staging: post.from, coordinates: [[post.from.lon, post.from.lat], [post.to.lon, post.to.lat]] };
    assert.equal(simulationRoadCrewAt(71_999, true, [leg]), null);
    const positions = [72_000, 74_000, 78_000, 80_000, 88_000, 92_000, 102_000].map(time => {
      const state = simulationRoadCrewAt(time, true, [leg]);
      return roadPositionAt(prepareRoadMotion(leg.road.coordinates), state.travel);
    });
    if (index < 2) {
      assert.ok(positions.every(point => point.lon === post.from.lon && point.lat === post.from.lat));
      assert.equal(simulationRoadCrewAt(74_000, true, [leg]).staged, true);
    } else {
      assert.equal(simulationRoadCrewAt(76_000, true, [leg]).stationary, false, 'the drive stays visible for six seconds');
      assert.ok(haversineKm(positions[0], positions[1]) > 0 && haversineKm(positions[1], positions[2]) > 0);
      assert.ok(positions.every(point => point.lat > 6.06 && point.lat < 6.15), 'the entire drive stays in the northern approach');
      assert.equal(positions[2].lon, post.to.lon);
      assert.ok(positions.slice(2).every(point => point.lon === post.to.lon));
    }
    const forward = simulationRoadCrewAt(74_000, true, [leg]);
    simulationRoadCrewAt(92_000, true, [leg]);
    assert.deepEqual(simulationRoadCrewAt(74_000, true, [leg]), forward, 'reverse seeks reproduce the exact same movement');
    const pending = { ...leg, road: undefined };
    assert.deepEqual(roadHoldPoint([pending], pending), post.from);
    assert.equal(simulationRoadCrewAt(74_000, true, [pending]).held, true);
  }
});
