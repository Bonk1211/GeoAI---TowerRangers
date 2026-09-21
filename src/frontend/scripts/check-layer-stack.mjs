// Run against Vite: PLAYWRIGHT_MODULE=/path/to/playwright node scripts/check-layer-stack.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (/Stack shader|INVALID_|GL_INVALID/.test(message.text())) errors.push(message.text()); });
try {
  await page.goto(process.env.MAP_URL || 'http://localhost:5173/map');
  await page.waitForFunction(() => window.__map?.getLayer('towers-layer'));
  const view = page.getByRole('region', { name: 'Map view', exact: true });
  const panel = page.getByRole('region', { name: 'Map layers', exact: true });
  await view.getByRole('button', { name: 'Stack layers', exact: true }).click();
  await page.getByText('Enable land layers and rainfall to compare ground and sky.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Soil', exact: true }).click();
  await panel.getByRole('switch', { name: 'Show Vegetation vigour (EVI) on map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('ee-vegetation_vigour'));
  await page.getByText('Ground layers stay on the map. Enable rainfall to add a sky layer.', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-stack-layer]').count(), 0, 'Land-only mode has no floating planes');
  await panel.getByRole('button', { name: 'Rain', exact: true }).click();
  await panel.getByRole('switch', { name: 'Show Rainfall on map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('stack-precipitation'));
  await page.waitForFunction(() => window.__map.getPitch() === 70);
  assert.equal(await page.evaluate(() => Boolean(window.__map.getTerrain())), false);
  assert.equal(await page.evaluate(() => Boolean(window.__map.getLayer('ee-precipitation'))), false);
  const labels = page.locator('[data-stack-layer]');
  assert.equal(await labels.count(), 1);
  await page.evaluate(() => window.__map.jumpTo({ center: [104, 5], zoom: 5.5 }));
  await page.waitForFunction(() => document.querySelector('[data-stack-marker]')?.style.visibility === 'visible');
  const skyHeight = await page.locator('[data-stack-marker]').getAttribute('transform');
  await panel.getByRole('button', { name: 'Soil', exact: true }).click();
  await panel.getByRole('switch', { name: 'Show Land cover · 2021 on map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('ee-land_cover'));
  assert.equal(await page.locator('[data-stack-marker]').getAttribute('transform'), skyHeight,
    'Adding ground data does not change sky height');
  assert.deepEqual(await page.evaluate(() => ['vegetation_vigour', 'land_cover'].map((id) => {
    const map = window.__map;
    const layers = map.getStyle().layers;
    return [map.getLayer(`ee-${id}`).type, Boolean(map.getLayer(`stack-${id}`)),
      layers.findIndex((l) => l.id === `ee-${id}`) < layers.findIndex((l) => l.type === 'symbol')];
  })), [['raster', false, true], ['raster', false, true]], 'Land data overlays the ground below place labels');
  await page.waitForFunction(() => window.__map.isSourceLoaded('ee-land_cover-src') && window.__map.isSourceLoaded('ee-vegetation_vigour-src'));
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-stack-layer]')].some((el) => /Loading/.test(el.textContent)));
  await page.screenshot({ path: join(process.env.MAP_SCREENSHOT_DIR || '/tmp', 'layer-stack-ground-sky.png') });
  await panel.getByRole('button', { name: 'Rain', exact: true }).click();
  await panel.getByRole('switch', { name: 'Show Forecast rainfall · next 24 h on map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('stack-forecast_rainfall_24h'));
  assert.equal(await labels.count(), 2);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-stack-layer]')].every((el) => el.style.transform));
  const before = await labels.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  assert(before[1] < before[0], 'Higher layers are displayed above lower layers');
  await view.getByRole('slider', { name: 'Sky layer spacing', exact: true }).focus();
  await page.keyboard.press('End');
  await page.waitForFunction((before) => {
    const els = [...document.querySelectorAll('[data-stack-layer]')];
    return els[0].getBoundingClientRect().top - els[1].getBoundingClientRect().top > before[0] - before[1];
  }, before);
  // Real saved imagery, not a screenshot fixture.
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-stack-layer]')].some((el) => /Loading/.test(el.textContent)));
  await page.screenshot({ path: join(process.env.MAP_SCREENSHOT_DIR || '/tmp', 'layer-stack-1440.png') });
  console.log(await labels.allTextContents());
  const panelBounds = await panel.boundingBox();
  const viewBounds = await view.boundingBox();
  for (const label of await labels.all()) {
    const bounds = await label.boundingBox();
    assert(bounds.x >= panelBounds.x + panelBounds.width && bounds.x + bounds.width <= viewBounds.x,
      'Wider planes keep their names clear of both side panels');
  }
  const markers = page.locator('[data-stack-marker]');
  assert.equal(await markers.count(), 2, 'Every sky layer has a location target');
  const checkMarkers = async () => {
    await page.waitForFunction(() => [...document.querySelectorAll('[data-stack-marker]')]
      .every((el) => el.style.visibility === 'visible'));
    const positions = await markers.evaluateAll((els) => els.map((el) => {
      const rect = el.getBoundingClientRect();
      const line = el.ownerSVGElement.querySelector('[data-stack-guide]');
      return { width: rect.width, height: rect.height, x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        guideX: Number(line.getAttribute('x2')), guideY: Number(line.getAttribute('y2')) };
    }));
    for (const point of positions) {
      assert(point.width >= 36 && point.height >= 36, 'Location target stays large and circular');
      assert(Math.abs(point.width - point.height) < 0.1, 'Pitch does not flatten the target');
      assert(Math.abs(point.x - point.guideX) < 0.1 && Math.abs(point.y - point.guideY) < 0.1,
        'Target centre stays aligned with the connecting guide');
    }
    assert(positions.every((p, i) => i === 0 || p.y < positions[i - 1].y), 'Same point appears at each height');
    const ground = await page.locator('[data-ground-marker]').evaluateAll((els) => els
      .filter((el) => el.style.visibility === 'visible').map((el) => {
        const rect = el.getBoundingClientRect();
        const line = el.ownerSVGElement.querySelector('[data-stack-guide]');
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
          guideX: Number(line.getAttribute('x1')), guideY: Number(line.getAttribute('y1')) };
      }));
    assert.equal(ground.length, 1, 'One shared ground target anchors the sky layers');
    assert(Math.abs(ground[0].x - ground[0].guideX) < 0.1 && Math.abs(ground[0].y - ground[0].guideY) < 0.1,
      'Ground target aligns with the bottom of the sky guide');
    assert(ground[0].y > positions[0].y, 'Ground point is below the sky points');
    return positions.map((p) => p.width);
  };
  const markerWidths = await checkMarkers();
  const markerTransform = await markers.first().getAttribute('transform');
  await page.evaluate(() => window.__map.jumpTo({ bearing: 25, pitch: 55, zoom: 6.2 }));
  await page.waitForFunction((previous) => document.querySelector('[data-stack-marker]').getAttribute('transform') !== previous, markerTransform);
  assert((await checkMarkers()).every((width, i) => Math.abs(width - markerWidths[i]) < 0.1),
    'Target size survives camera rotation, tilt and zoom');
  await page.screenshot({ path: join(process.env.MAP_SCREENSHOT_DIR || '/tmp', 'layer-stack-location-markers.png') });
  await page.evaluate(() => window.__map.jumpTo({ bearing: 0, pitch: 70, zoom: 5.5 }));
  const rainfall = panel.getByRole('switch', { name: 'Show Rainfall on map', exact: true });
  await rainfall.click();
  await rainfall.click();
  await page.waitForFunction(() => window.__map.getLayer('stack-precipitation'));
  assert.deepEqual(await page.evaluate(() => window.__map.getLayersOrder().filter((id) => id.startsWith('stack-'))),
    ['stack-forecast_rainfall_24h', 'stack-precipitation'], 'Async mount and re-enable preserve bottom-to-top sky order');
  await panel.getByRole('button', { name: 'Soil', exact: true }).click();
  await panel.getByRole('button', { name: 'View Vegetation vigour (EVI) settings', exact: true }).click();
  await page.evaluate(() => { window.__groundSource = window.__map.getSource('ee-vegetation_vigour-src'); });
  const opacity = panel.getByRole('slider', { name: 'Opacity', exact: true });
  await opacity.focus();
  await page.keyboard.press('Home');
  await page.waitForFunction(() => window.__map.getPaintProperty('ee-vegetation_vigour', 'raster-opacity') === 0.1);
  assert(await page.evaluate(() => window.__map.getSource('ee-vegetation_vigour-src') === window.__groundSource),
    'Ground opacity reuses the loaded source');
  await panel.getByRole('button', { name: 'Rain', exact: true }).click();
  await panel.getByRole('button', { name: 'View Rainfall settings', exact: true }).click();
  const imageryRequests = [];
  const recordImagery = (request) => { if (/\/maps\/tiles\//.test(request.url())) imageryRequests.push(request.url()); };
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-stack-layer]')].some((el) => /Loading/.test(el.textContent)));
  page.on('request', recordImagery);
  await opacity.focus();
  await page.keyboard.press('Home');
  assert.equal(await opacity.inputValue(), '10');
  await checkMarkers();
  await page.screenshot({ path: join(process.env.MAP_SCREENSHOT_DIR || '/tmp', 'layer-stack-opacity.png') });
  assert.equal(imageryRequests.length, 0, 'Opacity changes reuse loaded textures');
  page.off('request', recordImagery);
  await view.getByRole('button', { name: '3D terrain', exact: true }).click();
  await page.waitForFunction(() => window.__map.getTerrain()?.source === 'terrain-dem' && !window.__map.getLayer('stack-precipitation'));
  await view.getByRole('button', { name: 'Stack layers', exact: true }).click();
  await page.waitForFunction(() => !window.__map.getTerrain() && window.__map.getLayer('stack-precipitation'));
  await view.getByRole('button', { name: '2D map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getPitch() === 0 && !window.__map.getLayer('stack-precipitation') && window.__map.getLayer('ee-precipitation'));
  assert.equal(await labels.count(), 0);
  assert(await page.evaluate(() => window.__map.getSource('ee-vegetation_vigour-src') === window.__groundSource),
    'Ground layers persist across stack, terrain and 2D mode switches');
  await view.getByRole('button', { name: 'Stack layers', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('stack-precipitation') && !window.__map.getLayer('ee-precipitation'));
  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await page.waitForFunction(() => !window.__map.getLayersOrder().some((id) => id.startsWith('stack-') || id.startsWith('ee-')));
  assert.equal(await labels.count(), 0);
  await panel.getByRole('switch', { name: 'Show Rainfall on map', exact: true }).click();
  await page.waitForFunction(() => window.__map.getLayer('stack-precipitation'));
  await page.getByRole('link', { name: 'Investigation', exact: true }).click();
  await page.getByRole('link', { name: 'Map', exact: true }).click();
  await page.waitForFunction(() => window.__map?.getLayer('stack-precipitation'));
  await page.setViewportSize({ width: 390, height: 900 });
  assert(await view.getByRole('button', { name: 'Stack layers', exact: true }).isVisible());
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  // Controlled tile failure must remain visible instead of reading as no signal.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/flood\/tiles\/precipitation/, (route) => route.fulfill({ json: {
    layer_id: 'precipitation', tile_url: '/stack-smoke-missing/{z}/{x}/{y}', tile_access: 'public',
    bounds: [92, -11.5, 142, 29], max_zoom: 8, attribution: 'Test source',
  } }));
  await page.route(/\/api\/stack-smoke-missing\//, (route) => route.fulfill({ status: 503, body: 'Test outage' }));
  await page.reload();
  await page.waitForFunction(() => window.__map?.getLayer('towers-layer'));
  await view.getByRole('button', { name: 'Stack layers', exact: true }).click();
  await panel.getByRole('button', { name: 'Rain', exact: true }).click();
  await panel.getByRole('switch', { name: 'Show Rainfall on map', exact: true }).click();
  await page.locator('[data-stack-layer="precipitation"]').getByText('Tiles unavailable · incomplete coverage', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: land overlays on ground, rainfall in sky, shared location markers, opacity, spacing, mode switches, clear, error states, mobile controls.');
} finally {
  await browser.close();
}
