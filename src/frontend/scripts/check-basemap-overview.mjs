// Run with Vite and the API serving. Reuse existing tooling via PLAYWRIGHT_MODULE.
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const url = process.env.MAP_URL || 'http://localhost:5173/map';
const errors = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const scored = (tower) => tower.dominant_factor !== 'unscored';

async function population(page, towers) {
  const ids = towers.map((tower) => tower.tower_id).sort();
  await page.waitForFunction(async (ids) => {
    const map = window.__map;
    const source = map?.getSource('towers');
    if (!source || !map.isSourceLoaded('towers')) return false;
    const data = await source.getData();
    return JSON.stringify(data.features.map((feature) => feature.properties.tower_id).sort()) === JSON.stringify(ids);
  }, ids);
}

async function clusters(page) {
  return page.evaluate(async () => {
    const map = window.__map;
    const source = map.getSource('towers');
    const features = [...new Map(map.queryRenderedFeatures({ layers: ['tower-clusters'] })
      .map((feature) => [feature.properties.cluster_id, feature])).values()];
    return Promise.all(features.map(async (feature) => ({
      ...feature.properties,
      coordinates: feature.geometry.coordinates,
      point: map.project(feature.geometry.coordinates),
      leaves: (await source.getClusterLeaves(feature.properties.cluster_id, feature.properties.point_count, 0))
        .map((leaf) => ({ ...leaf.properties, coordinates: leaf.geometry.coordinates })),
    })));
  });
}

function checkCounts(groups) {
  assert(groups.length > 0, 'National overview has clustered towers');
  for (const group of groups) {
    assert.equal(group.point_count, group.leaves.length, 'Total includes every site');
    assert.equal(group.maintain_count,
      group.leaves.filter((leaf) => leaf.scored && leaf.decision === 'maintain').length,
      'Maintain count includes only scored maintain sites');
  }
}

async function open(page) {
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && /MapLibre error|layers\.|clusterProperties/.test(message.text())) errors.push(message.text());
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__map?.getLayer('tower-cluster-count')));
}

try {
  const response = await page.request.get(new URL('/api/towers', url).href);
  assert(response.ok(), 'Live towers API is available');
  const towers = await response.json();
  await open(page);
  await population(page, towers);
  await page.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['tower-clusters'] }).length > 0);
  const national = await clusters(page);
  checkCounts(national);
  const individuals = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['towers-layer'] })
    .map((feature) => feature.properties.tower_id));
  assert.deepEqual([...new Set([...individuals, ...national.flatMap((group) => group.leaves.map((leaf) => leaf.tower_id))])].sort(),
    towers.map((tower) => tower.tower_id).sort(), 'National view represents the complete tower population');
  const sourceStyle = await page.evaluate(() => ({
    source: window.__map.getStyle().sources.towers,
    isolated: window.__map.getLayer('towers-isolated-ring').minzoom,
    rings: window.__map.queryRenderedFeatures({ layers: ['towers-isolated-ring', 'towers-flood-ring'] }).length,
    zoom: window.__map.getZoom(),
    water: window.__map.getPaintProperty('water', 'fill-color'),
    background: window.__map.getPaintProperty('background', 'background-color'),
    corners: [[99.5, 7.5], [119.8, 0.8]].map((point) => window.__map.project(point)),
  }));
  assert.equal(sourceStyle.source.cluster, true);
  assert.equal(sourceStyle.source.clusterMaxZoom, 8);
  assert.equal(sourceStyle.isolated, 9, 'Individual isolation rings start at detail zoom');
  assert(sourceStyle.zoom < 9);
  assert.equal(sourceStyle.rings, 0, 'No isolated/flood rings behind national cluster badges');
  assert.equal(sourceStyle.water, '#dcecf1');
  assert.equal(sourceStyle.background, '#f6f4ef');
  const sidebar = await page.getByRole('region', { name: 'Map view', exact: true }).boundingBox();
  const layersPanel = await page.getByRole('region', { name: 'Map layers', exact: true }).boundingBox();
  assert(sourceStyle.corners.every((point) => point.x > layersPanel.x + layersPanel.width
    && point.x < sidebar.x && point.y > 100 && point.y < 860), 'Malaysia fits between the floating panels');
  if (process.env.MAP_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MAP_SCREENSHOT_DIR}/basemap-overview-national.png` });

  const group = national.find((group) => group.point.x > 340 && group.point.x < sidebar.x - 30
    && group.point.y > 150 && group.point.y < 800);
  assert(group, 'At least one cluster is clear of the floating panels');
  await page.mouse.click(group.point.x, group.point.y);
  await page.waitForFunction((zoom) => window.__map.getZoom() > zoom + 0.2, sourceStyle.zoom);
  assert(await page.getByRole('complementary', { name: 'Selected tower' }).getByText('No selection', { exact: true }).isVisible(),
    'Expanding a cluster does not select a fictitious tower');

  const selected = group.leaves.find((leaf) => leaf.scored) ?? group.leaves[0];
  await page.evaluate((coordinates) => window.__map.jumpTo({ center: coordinates, zoom: 12, padding: 0 }), selected.coordinates);
  await page.waitForFunction(() => window.__map.isSourceLoaded('towers'));
  const point = await page.evaluate((coordinates) => window.__map.project(coordinates), selected.coordinates);
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction((id) => document.querySelector('aside[aria-label="Selected tower"]')?.textContent.includes(id), selected.tower_id);
  assert(await page.getByRole('complementary', { name: 'Selected tower' }).innerText()
    .then((text) => text.includes(selected.tower_id)), 'Individual tower click selects its record');
  if (process.env.MAP_SCREENSHOT_DIR) {
    await page.waitForFunction(() => !/Loading|Finding/.test(document.querySelector('[aria-label="Site surroundings"]')?.textContent ?? 'Loading'));
    await page.screenshot({ path: `${process.env.MAP_SCREENSHOT_DIR}/basemap-overview-selected.png` });
  }

  const band = page.getByRole('region', { name: 'Risk band', exact: true }).getByRole('button', { name: /Maintain$/ });
  await band.click();
  const maintain = towers.filter((tower) => scored(tower) && tower.decision === 'maintain');
  await population(page, maintain);
  const tools = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Map tools' }) });
  await tools.locator('summary').click();
  const area = page.getByRole('region', { name: 'Area', exact: true }).getByRole('button', { name: /Sarawak/ });
  await area.click();
  const filtered = maintain.filter((tower) => tower.territory === 'Sarawak');
  await population(page, filtered);
  const filteredGroups = await clusters(page);
  if (filteredGroups.length) checkCounts(filteredGroups);
  assert(filteredGroups.every((group) => group.point_count === group.maintain_count), 'Band and area filters compose before clustering');
  await page.evaluate(() => window.__map.jumpTo({ zoom: 10 }));
  const rings = await page.evaluate(() => window.__map.queryRenderedFeatures({ layers: ['towers-isolated-ring', 'towers-flood-ring'] })
    .map((feature) => feature.properties));
  assert(rings.every((tower) => tower.decision === 'maintain' && tower.territory === 'Sarawak'), 'No rings from excluded towers');

  await area.click();
  await band.click();
  await population(page, towers);
  const opacity = page.getByRole('slider', { name: 'Score opacity', exact: true });
  await opacity.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.__map.getPaintProperty('tower-clusters', 'circle-opacity') === 0.1
    && window.__map.getPaintProperty('tower-cluster-count', 'text-opacity') === 0.1);
  await population(page, towers);
  await context.close();

  // A live national population can have no unscored records. Keep that boundary reproducible.
  const mocked = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const sample = [
    { tower_id: 'QA_MAINTAIN', dominant_factor: 'flood', decision: 'maintain' },
    { tower_id: 'QA_WATCH', dominant_factor: 'power', decision: 'watch' },
    { tower_id: 'QA_UNSCORED', dominant_factor: 'unscored', decision: 'maintain' },
  ].map((tower, index) => ({ ...towers[0], ...tower, territory: 'QA area', lon: 110.8 + index * 0.0001, lat: 3.1, hand_m: null }));
  await mocked.route('**/api/towers', (route) => route.fulfill({ json: sample }));
  const samplePage = await mocked.newPage();
  await open(samplePage);
  await population(samplePage, sample);
  await samplePage.waitForFunction(() => window.__map.queryRenderedFeatures({ layers: ['tower-clusters'] }).length > 0);
  const sampleGroups = await clusters(samplePage);
  checkCounts(sampleGroups);
  assert.equal(sampleGroups[0].point_count, 3);
  assert.equal(sampleGroups[0].maintain_count, 1);
  await samplePage.getByRole('region', { name: 'Risk band', exact: true }).getByRole('button', { name: /Maintain$/ }).click();
  await population(samplePage, [sample[0]]);
  assert.deepEqual(errors, [], 'No browser runtime or map-style errors');
  console.log('PASS: cluster totals/maintain counts, expansion, site selection, band+area filtering, rings, opacity and unscored sites.');
} finally {
  await browser.close();
}
