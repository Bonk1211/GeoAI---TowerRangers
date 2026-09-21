// Run with Vite and the real backend serving the app. No route or tower fixtures.
// Optional arguments: [Playwright module path] [screenshot directory].
// PLAYWRIGHT_MODULE and SIMULATION_SCREENSHOT_DIR offer the same options.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { difference } from '@turf/difference';
import { union } from '@turf/union';
import { featureCollection } from '@turf/helpers';
import { floodExtentAt, pointInPolygon } from '../src/fixtures/scenarios/sabahFlood.ts';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || process.argv[2] || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1512, height: 982 }, reducedMotion: 'no-preference' });
const errors = [];
const routeRequests = [];
const routeReads = [];
const routeCalls = [];
const fullFlood = floodExtentAt(26_000);
const screenshotDir = process.env.SIMULATION_SCREENSHOT_DIR || process.argv[3];
if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
  if (new URL(request.url()).pathname.endsWith('/travel/simulation-routes')) routeCalls.push(request.postDataJSON());
});
page.on('response', response => {
  if (!new URL(response.url()).pathname.endsWith('/travel/simulation-routes')) return;
  const record = { request: response.request().postDataJSON(), status: response.status() };
  routeRequests.push(record);
  routeReads.push(response.json().then(body => { record.body = body; }));
});

const distance = (a, b) => Math.hypot((a[0] - b[0]) * 110_600, (a[1] - b[1]) * 111_200);
const units = (frame, prefix) => frame.fleet.filter(unit => unit.id.startsWith(prefix));
const at = (frame, id, type = 'fleet') => frame[type].find(unit => unit.id === id)?.position;
const positions = frame => Object.fromEntries(['fleet', 'drones'].map(kind => [kind,
  frame[kind].map(({ id, position }) => ({ id, position }))]));

async function snapshot() {
  return page.evaluate(async () => {
    const map = window.__simulationMap;
    const read = async name => (await map.getSource(name).getData()).features;
    const marks = features => features.map(feature => ({
      id: feature.properties.unit_id,
      parentId: feature.properties.parent_unit_id,
      position: feature.geometry.coordinates,
      screen: [map.project(feature.geometry.coordinates).x, map.project(feature.geometry.coordinates).y],
      label: feature.properties.label,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const [fleet, drones, flood, coverage, gaps, roads, down, generators, labels, warnings] = await Promise.all([
      'sim-response-fleet', 'sim-prime-drones', 'sim-flood-ground',
      'sim-cow-coverage', 'sim-coverage-gap', 'sim-road-routes', 'sim-down-tower', 'sim-generator-sites',
      'sim-assessment-labels', 'sim-warning-sites',
    ].map(read));
    return { fleet: marks(fleet), drones: marks(drones), flood: flood.length,
      coverage: coverage.length, gaps: gaps.length, roads: roads.length,
      coverageShapes: coverage, gapShapes: gaps,
      offlineSites: down.length,
      offlineIds: down.map(feature => feature.properties.tower_id), generators,
      renderedGenerators: [...new Set(map.queryRenderedFeatures({ layers: ['sim-generator-icon-layer'] })
        .map(feature => feature.properties.tower_id))],
      laterLabels: labels.filter(feature => feature.properties.secondary).length,
      laterHighlights: warnings.filter(feature => feature.properties.secondary).length,
      assessmentVisible: Boolean(document.querySelector('.sim-site-assessment')),
      camera: { center: map.getCenter().toArray(), zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() },
      caption: document.querySelector('.sim-scene-caption')?.textContent };
  });
}

async function seek(ms) {
  await page.getByRole('slider', { name: 'Scrub scenario time' }).evaluate((element, value) => {
    // Exercise exact phase boundaries without the UI's 100ms thumb rounding.
    element.step = '1';
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, ms);
  // React effects update GeoJSON after the controlled range input commits.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(() => {
    const map = window.__simulationMap;
    return map && ['sim-response-fleet', 'sim-prime-drones', 'sim-flood-ground',
      'sim-cow-coverage', 'sim-coverage-gap', 'sim-road-routes'].every(id => map.isSourceLoaded(id));
  });
  assert.equal(Number(await page.getByRole('slider', { name: 'Scrub scenario time' }).inputValue()), ms);
  return snapshot();
}

async function waitForFleet(prefix, count) {
  // waitForFunction treats a Promise as truthy in this Playwright version.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (units(await snapshot(), prefix).length >= count) return;
    await page.waitForTimeout(100);
  }
  assert.fail(`Waiting for ${count} ${prefix} vehicles timed out`);
}

function assertDry(frame, time) {
  for (const unit of frame.fleet) assert(!pointInPolygon(...unit.position, fullFlood),
    `${unit.id} is inside the flood at ${time}ms: ${unit.position}`);
}

async function screenshot(name) {
  if (screenshotDir) await page.screenshot({ path: `${screenshotDir}/simulation-${name}.png` });
}

try {
  await page.goto(process.env.SIMULATION_URL || 'http://localhost:5173/simulation', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__simulationMap?.getSource('sim-response-fleet'));
  await page.waitForFunction(() => window.__simulationMap?.getLayer('sim-response-fleet-vehicles'));
  await page.waitForFunction(() => window.__simulationMap?.getLayer('sim-generator-icon-layer'));
  const vehicleIcons = await page.evaluate(() => {
    const map = window.__simulationMap;
    return ['sim-response-fleet-base-stations', 'sim-response-fleet-vehicles'].map(id => ({
      filter: map.getFilter(id), icon: map.getLayoutProperty(id, 'icon-image'),
    }));
  });
  assert.deepEqual(vehicleIcons, [
    { filter: ['==', ['get', 'kind'], 'network-crew'], icon: 'sim-mobile-base-station' },
    { filter: ['!=', ['get', 'kind'], 'network-crew'], icon: 'sim-response-vehicle' },
  ], 'Network crews use the equipment truck; fixed PRIME vehicles use the jeep');
  await screenshot('initial');
  const signals = page.getByRole('region', { name: 'Connected warning signals', exact: true });
  assert(await signals.evaluate(element => Boolean(element.closest('.sim-sidebar'))), 'Signals belong in the sidebar');
  assert.equal(await page.locator('.sim-map-frame .sim-connected-key').count(), 0, 'Signals do not obscure the map');
  assert.equal(await page.getByText('Understand before dispatch.', { exact: true }).count(), 0, 'Removed briefing must stay absent');
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();

  for (const time of [10_000, 14_999]) {
    const priority = await seek(time);
    assert.match(priority.caption, /Priority shifts to flood response/);
    assert.equal(priority.fleet.length, 0, 'The priority decision is shown before civil crews depart');
    assert.equal(priority.flood, 0, 'Priority changes ahead of flood onset');
    assert(priority.laterLabels > 0 && priority.laterHighlights > 0 && priority.assessmentVisible,
      'Later maintenance is visible during the opening priority briefing');
  }
  await screenshot('priority-before-dispatch');
  assert.match((await seek(15_000)).caption, /Civil crews complete preventive maintenance/);
  await seek(17_000);
  await waitForFleet('hardening-', 1);
  const working = await seek(19_000);
  const civilIds = units(working, 'hardening-').map(unit => unit.id);
  assert(civilIds.length > 0, `Live mapped civil maintenance must be visible: ${JSON.stringify(working)}`);
  assert(working.generators.every(feature => feature.properties.tower_id !== 'MY_N12462360044'),
    'The northern Telipok/Menggatal tower must not receive a generator');
  const civilTargets = new Set(routeCalls.flatMap(call => call.legs)
    .filter(leg => leg.id.startsWith('hardening-') && !leg.id.endsWith(':exit'))
    .map(leg => leg.id.split(':').at(-1)));
  assert.deepEqual(new Set(working.generators.map(feature => feature.properties.tower_id)), civilTargets,
    'Civil maintenance targets the higher-ground generator sites; inaccessible routes still hold');
  const callsDuringCivilExit = routeCalls.length;
  const workingLater = await seek(20_400);
  for (const id of civilIds) assert.deepEqual(at(workingLater, id), at(working, id), `${id} holds while performing maintenance`);
  assert.equal(working.flood, 0, 'No flood before civil maintenance finishes');
  const exiting = await seek(22_000);
  assert.equal(exiting.laterLabels, 0, 'Later-maintenance labels clear when civil work finishes');
  assert.equal(exiting.laterHighlights, 0, 'Later-maintenance highlights clear when civil work finishes');
  assert.equal(exiting.assessmentVisible, false);
  assert.match(exiting.caption, /rerout|exit|withdraw|dry|higher|clear/i, 'Civil withdrawal has an explicit explanation');
  assert(civilIds.some(id => distance(at(working, id), at(exiting, id)) > 20), 'Civil crews visibly drive out');
  for (const boundary of [19_000, 20_500, 23_500, 24_000]) {
    const before = await seek(boundary - 1);
    const after = await seek(boundary);
    for (const id of civilIds) {
      assert(at(before, id) && at(after, id), `${id} must not vanish at ${boundary}ms`);
      assert(distance(at(before, id), at(after, id)) < 200, `${id} jumps at ${boundary}ms`);
    }
  }
  const cleared = await seek(23_600);
  assert.equal(cleared.flood, 0);
  assertDry(cleared, 23_600);
  assert.equal(routeCalls.length, callsDuringCivilExit, 'Rerouting from 19–24s uses stable assessed paths');
  await screenshot('civil-clear');
  for (const time of [24_000, 25_000, 27_000, 40_000, 53_900]) {
    const frame = await seek(time);
    assert(frame.flood > 0, `Flood appears after civil exit at ${time}ms`);
    assertDry(frame, time);
    assert.equal(frame.laterLabels, 0, `Later-maintenance labels stay cleared at ${time}ms`);
    assert.equal(frame.laterHighlights, 0, `Later-maintenance highlights stay cleared at ${time}ms`);
    assert.equal(frame.assessmentVisible, false);
    for (const generator of frame.generators) {
      assert(!frame.offlineIds.includes(generator.properties.tower_id), 'A generator tower must stay online during the flood');
    }
  }
  const floodView = await seek(30_000);
  await screenshot('flood-focus');
  for (const time of [33_000, 40_000, 47_000, 53_900]) {
    const camera = (await seek(time)).camera;
    assert(distance(camera.center, floodView.camera.center) < 1, 'Hold the flood corridor instead of revisiting later-maintenance sites');
    for (const key of ['zoom', 'pitch', 'bearing']) assert(Math.abs(camera[key] - floodView.camera[key]) < 1e-6,
      `Keep the flood framing steady at ${time}ms (${key})`);
  }
  await seek(40_000);
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await page.waitForFunction(() => !window.__simulationMap.isMoving());
  await page.waitForFunction(expected => new Set(window.__simulationMap.queryRenderedFeatures({ layers: ['sim-generator-icon-layer'] })
    .map(feature => feature.properties.tower_id)).size >= expected, working.generators.length);
  const impact = await snapshot();
  assert.equal(impact.renderedGenerators.length, impact.generators.length, 'Every generator icon renders despite nearby label collisions');
  for (const gap of impact.gapShapes) {
    const polygons = gap.geometry.type === 'Polygon' ? [gap.geometry.coordinates] : gap.geometry.coordinates;
    assert(polygons.every(rings => rings.length === 1), 'Generator footprints cannot cut holes in the outage circles');
  }
  await screenshot('generators-satellite');
  await page.getByRole('button', { name: 'Satellite', exact: true }).click();
  await screenshot('generators-map');
  await page.getByRole('button', { name: 'Satellite', exact: true }).click();
  await page.getByRole('button', { name: 'Free camera', exact: true }).click();
  console.log(`Civil flow passed: ${civilIds.length} routed units maintain, visibly exit and clear the flood before 24s.`);

  await seek(54_000);
  await waitForFleet('mobile-network-', 2);
  await page.locator('.sim-route-outcome').getByText('6 mapped routes', { exact: true }).waitFor({ timeout: 60_000 });
  const responseStart = await snapshot();
  const primeIds = units(responseStart, 'mobile-network-').map(unit => unit.id);
  assert.equal(primeIds.length, 2, 'Two PRIME vehicles anchor the two response areas');
  const baseline = new Map(primeIds.map(id => [id, at(responseStart, id)]));
  const frames = new Map();
  let callsBeforeRestoration;
  for (const time of [54_000, 62_100, 68_100, 71_900, 72_100, 74_000, 76_100, 78_100, 79_900, 80_000, 82_000, 88_000, 92_100, 96_000]) {
    const frame = await seek(time);
    frames.set(time, frame);
    assertDry(frame, time);
    for (const id of primeIds) assert.deepEqual(at(frame, id), baseline.get(id), `${id} must remain fixed at ${time}ms`);
    assert.equal(units(frame, 'network-crew-').length, time < 72_000 ? 0 : 4, `Exactly four network crews from 72s (${time}ms)`);
    assert.equal(units(frame, 'response-').length, 0, 'No unrelated repair vehicles spawn during recovery');
    if (time === 79_900) callsBeforeRestoration = routeCalls.length;
    if (time >= 80_000) assert.equal(routeCalls.length, callsBeforeRestoration, `Restoration must not replace ground routes (${time}ms)`);
    if ([72_100, 74_000, 78_100, 82_000, 92_100].includes(time)) await screenshot(String(time));
  }
  const dispatch = frames.get(72_100);
  const arrived = frames.get(78_100);
  for (const id of ['network-crew-1', 'network-crew-2']) {
    assert.deepEqual(at(arrived, id), at(dispatch, id), `${id} stays at the initial position`);
    assert(distance(at(arrived, id), baseline.get('mobile-network-1')) < 2_000, `${id} stays at a nearby dry post`);
  }
  for (const id of ['network-crew-3', 'network-crew-4']) {
    const northHome = baseline.get('mobile-network-2');
    const southHome = baseline.get('mobile-network-1');
    assert(distance(at(dispatch, id), northHome) < 15_000, `${id} starts on the extended northern approach`);
    assert(distance(at(arrived, id), baseline.get('mobile-network-2')) < 2_000, `${id} arrives near the second PRIME position`);
    assert(distance(at(frames.get(74_000), id), at(dispatch, id)) > 20, `${id} visibly drives the extended northern approach`);
    assert(distance(at(frames.get(76_100), id), at(arrived, id)) > 100, `${id} keeps moving beyond the old four-second window`);
    const screens = [72_100, 74_000, 76_100, 78_100].map(time => frames.get(time).fleet.find(unit => unit.id === id).screen);
    const pixels = screens.slice(1).reduce((sum, point, i) => sum + Math.hypot(point[0] - screens[i][0], point[1] - screens[i][1]), 0);
    console.log(`${id} visible movement: ${pixels.toFixed(1)}px over six seconds`);
    assert(pixels > 26, `${id} moves more than a vehicle icon width on screen (${pixels.toFixed(1)}px)`);
    for (const time of [72_100, 74_000, 76_100, 79_900, 80_000, 82_000, 88_000, 92_100, 96_000]) {
      const position = at(frames.get(time), id);
      assert(distance(position, northHome) < distance(position, southHome), `${id} stays in the northern response area (${time}ms)`);
      assert(distance(position, northHome) < 15_000, `${id} stays within the extended northern approach (${time}ms)`);
    }
  }
  assert.equal(new Set(units(dispatch, 'network-crew-').map(unit => unit.position.join(','))).size, 4, 'Four distinct initial crew posts');
  assert.equal(new Set(units(arrived, 'network-crew-').map(unit => unit.position.join(','))).size, 4, 'Four distinct final crew posts');
  const stableIds = arrived.fleet.map(unit => unit.id);
  for (const time of [80_000, 82_000, 88_000, 92_100, 96_000]) {
    assert.deepEqual(frames.get(time).fleet.map(unit => unit.id), stableIds, `Vehicle identities stay unchanged after restoration (${time}ms)`);
    assert.deepEqual(positions(frames.get(time)).fleet, positions(arrived).fleet, `Ground vehicles stay parked after their response (${time}ms)`);
  }
  const onStation = frames.get(68_100);
  assert(onStation.drones.length > 0, 'Area planning supplies relays for the unprotected outage sites');
  assert(onStation.drones.length < onStation.offlineSites, 'Relay count follows area coverage, not one drone per tower');
  assert.equal(await signals.locator('.sim-signal-cards > div').count(), 4, 'Four signal cards remain during playback');
  assert.equal(await signals.locator(':scope > :not(.sim-key-heading):not(.sim-signal-cards)').count(), 0, 'Signals contain only their heading and four cards');
  assert.equal(new Set(onStation.drones.map(drone => drone.id)).size, onStation.drones.length, 'Every drone has a stable unique identity');
  assert.deepEqual([...new Set(onStation.drones.map(drone => drone.parentId))].sort(), primeIds, 'Both fixed PRIME vehicles launch their own drones');
  for (const parentId of primeIds) {
    const group = onStation.drones.filter(drone => drone.parentId === parentId);
    if (group.length < 2) continue;
    const spacing = group.map(drone => Math.min(...group.filter(other => other !== drone)
      .map(other => distance(drone.position, other.position))));
    assert(Math.min(...spacing) > 3_000, 'Relays spread across the affected area instead of clustering at towers');
    assert(Math.max(...spacing) - Math.min(...spacing) < 50, 'Local relay spacing is uniform');
  }
  const originalGaps = frames.get(62_100).gapShapes;
  assert(originalGaps.length > 0, 'The initial outage footprint is visible before drones reach station');
  // Failed-tower footprints stay intact until the airborne radio reaches them.
  for (const time of [68_100, 71_900, 72_100, 74_000, 76_100, 79_900]) {
    const frame = frames.get(time);
    assert.equal(frame.gaps, 0, `No red outage gap remains while the relays hold station (${time}ms)`);
    assert(frame.coverage > 0, 'The combined on-station drone footprint is visible');
    // Check drawn footprints against the original red geometry independently of the UI's gap selector.
    const visibleCoverage = frame.coverageShapes.length === 1 ? frame.coverageShapes[0] : union(featureCollection(frame.coverageShapes));
    for (const gap of originalGaps) assert.equal(difference(featureCollection([gap, visibleCoverage])), null,
      `Actual airborne footprints cover the complete original outage area (${time}ms)`);
  }
  for (const drone of onStation.drones) {
    const home = baseline.get(drone.parentId);
    assert(home, `${drone.id} identifies its own PRIME vehicle`);
    assert(distance(drone.position, home) > 100, `${drone.id} flies to its coverage area`);
    const launch = at(frames.get(62_100), drone.id, 'drones');
    assert(launch && distance(launch, home) < distance(drone.position, home) * .03 + 1, `${drone.id} launches from its parent PRIME vehicle`);
    const landed = frames.get(92_100).drones.find(unit => unit.id === drone.id);
    assert.equal(landed?.parentId, drone.parentId, `${drone.id} retains its assigned vehicle`);
    assert(distance(landed.position, home) < 1, `${drone.id} returns to its own vehicle`);
  }
  console.log(`Response flow passed: fixed PRIME anchors, southern crews holding, extended northern routes, full outage coverage from ${onStation.drones.length} drones, and every drone returns home.`);

  const paused = await seek(74_000);
  await page.waitForTimeout(350);
  assert.deepEqual(positions(await snapshot()), positions(paused), 'Pause freezes every vehicle and drone');
  assert.deepEqual(positions(paused), positions(frames.get(74_000)), 'Backward seek reproduces the exact response frame');
  const priorityAgain = await seek(14_000);
  assert.match(priorityAgain.caption, /Priority shifts to flood response/);
  assert.equal(priorityAgain.fleet.length, 0, 'Rewinding to the priority decision clears later dispatch');
  assert(priorityAgain.laterLabels > 0 && priorityAgain.laterHighlights > 0 && priorityAgain.assessmentVisible,
    'Rewinding restores the opening priority briefing');
  const rewound = await seek(19_000);
  assert.deepEqual(positions(rewound), positions(working), 'Backward seek reproduces the civil maintenance frame');
  assert.equal(rewound.drones.length, 0, 'Rewinding clears future drones');
  await page.getByRole('button', { name: '4×', exact: true }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  assert(Number(await page.getByRole('slider', { name: 'Scrub scenario time' }).inputValue()) > 19_300, 'Playback advances after resume at 4×');
  await seek(92_100);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Mobile page has no horizontal overflow');
  assert(await signals.evaluate(element => Boolean(element.closest('.sim-sidebar'))));
  await screenshot('mobile');

  await Promise.all(routeReads);
  assert(routeRequests.length > 0, 'Validation used actual backend route results');
  for (const record of routeRequests) {
    assert.equal(record.status, 200, 'Live road routing request succeeds');
    for (const request of record.request.legs.filter(leg => leg.avoid_flood)) {
      const result = record.body.legs.find(leg => leg.id === request.id);
      assert.equal(result.status, 'routed', `Live dry route resolves: ${request.id}`);
      if (/^network-crew-[34]:/.test(request.id)) {
        const previousKm = request.id.startsWith('network-crew-3:') ? 1.966 : 2.179;
        assert(Math.abs(result.distance_km - previousKm - 10) < .3, `Northern crews travel 10km farther: ${request.id} (${result.distance_km}km)`);
        const northHome = baseline.get('mobile-network-2');
        assert(distance(result.coordinates[0], northHome) < 15_000, `${request.id} starts on the northern approach`);
      }
      const coordinates = result.coordinates;
      for (let index = 0; index < coordinates.length; index++) {
        const start = coordinates[Math.max(0, index - 1)];
        const end = coordinates[index];
        const steps = Math.max(1, Math.ceil(distance(start, end) / 25));
        for (let step = 0; step <= steps; step++) {
          const point = start.map((value, axis) => value + (end[axis] - value) * step / steps);
          assert(!pointInPolygon(...point, fullFlood), `Live ground route crosses flood: ${request.id}`);
        }
      }
    }
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log(`PASS: live simulation flow, pause/resume/reverse seek and mobile layout; ${routeRequests.length} real route assessments verified.`);
} catch (error) {
  await screenshot('failure').catch(() => {});
  console.error('Simulation check diagnostics:', JSON.stringify({ errors, routeCalls: routeCalls.length,
    frame: await snapshot().catch(() => null) }));
  throw error;
} finally {
  await browser.close();
}
