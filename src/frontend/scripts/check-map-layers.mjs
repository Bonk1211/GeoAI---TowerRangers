// Run with Vite serving the app:
// PLAYWRIGHT_MODULE=/path/to/playwright node --experimental-strip-types scripts/check-map-layers.mjs
// Optional: MAP_URL, MAP_SCREENSHOT_DIR, PLAYWRIGHT_BROWSER_PATH (existing Chromium executable).
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOOD_CATALOGUE } from '../src/fixtures/floodLayers.ts';
import { LAND_CATALOGUE } from '../src/fixtures/landLayers.ts';

const require = createRequire(import.meta.url);
const { chromium, expect } = require(process.env.PLAYWRIGHT_MODULE
  ? join(process.env.PLAYWRIGHT_MODULE, 'test') : 'playwright/test');
const screenshots = process.env.MAP_SCREENSHOT_DIR ?? join(tmpdir(), 'starlink-map-layers');
await mkdir(screenshots, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_BROWSER_PATH });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  const backhaulRequests = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/backhaul/')) backhaulRequests.push(request.url());
  });
  // Only layer responses are controlled. Real map chrome, stores and queries run normally.
  await page.route(/\/(flood|land)\/layers(?:\?|$)/, (route) => route.fulfill({
    json: route.request().url().includes('/land/') ? LAND_CATALOGUE : FLOOD_CATALOGUE,
  }));
  await page.route(/\/(flood|land)\/tiles\//, (route) => route.fulfill({
    status: 503, json: { detail: 'Smoke check: satellite source unavailable.' },
  }));
  await page.goto(process.env.MAP_URL ?? 'http://localhost:5173/map');
  const panel = page.getByRole('region', { name: 'Map layers', exact: true });
  const category = (name) => panel.getByRole('button', { name, exact: true });
  const toggle = (name) => panel.getByRole('switch', { name: `Show ${name} on map`, exact: true });
  const chip = (name) => panel.getByRole('button', { name: `View ${name} settings`, exact: true });
  const activeChips = panel.getByRole('button', { name: /^View .+ settings$/ });

  await expect(category('Flood')).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.getByRole('group', { name: 'Layer categories' }).getByRole('button')).toHaveCount(4);
  await expect(category('Network')).toHaveCount(0);
  await expect(panel.getByText('0 enabled', { exact: true }).first()).toBeVisible();
  await expect(toggle('Flood extent')).toHaveAttribute('aria-checked', 'false');
  await expect(activeChips).toHaveCount(0);
  const initialScreenshot = join(screenshots, 'map-layers-initial.png');
  await page.screenshot({ path: initialScreenshot, animations: 'disabled' });
  console.log(initialScreenshot);

  await category('Rain').click();
  await expect(toggle('Rainfall')).toBeVisible();
  await expect(toggle('Forecast rainfall · next 24 h')).toBeVisible();
  await expect(toggle('Flood extent')).toHaveCount(0);
  await expect(toggle('Surface soil moisture')).toHaveCount(0);
  await category('Soil').focus();
  await page.keyboard.press('Space');
  await expect(category('Soil')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle('Surface soil moisture')).toHaveAttribute('aria-checked', 'false');
  await expect(panel.locator('article').first()).toContainText('Surface soil moisture');
  await expect(toggle('Soil clay content')).toBeVisible();
  await expect(toggle('Vegetation vigour (EVI)')).toBeAttached();
  await category('Rain').focus();
  await page.keyboard.press('Enter');
  await expect(category('Rain')).toHaveAttribute('aria-pressed', 'true');
  await expect(activeChips).toHaveCount(0);

  await toggle('Rainfall').focus();
  await page.keyboard.press('Space');
  await expect(toggle('Rainfall')).toHaveAttribute('aria-checked', 'true');
  await expect(category('Rain')).toContainText('1 enabled');
  await expect(chip('Rainfall')).toBeVisible();
  await expect(panel.locator('article').getByRole('status')).toContainText('Unavailable');
  const rainDetails = panel.locator('#flood-header-precipitation');
  await expect(rainDetails).toHaveAttribute('aria-expanded', 'false');
  await rainDetails.click();
  await expect(rainDetails).toHaveAttribute('aria-expanded', 'true');
  const date = panel.getByLabel('Observation date · shared');
  await date.fill('2021-12-20');
  const opacity = panel.getByRole('slider', { name: 'Opacity', exact: true });
  await opacity.focus();
  await page.keyboard.press('Home');
  await expect(opacity).toHaveValue('10');
  await toggle('Forecast rainfall · next 24 h').click();
  await expect(rainDetails).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('#flood-header-forecast_rainfall_24h')).toHaveAttribute('aria-expanded', 'false');
  await toggle('Forecast rainfall · next 24 h').click();
  await expect(rainDetails).toHaveAttribute('aria-expanded', 'true');
  await rainDetails.click();
  await expect(rainDetails).toHaveAttribute('aria-expanded', 'false');
  await expect(panel.locator('article').getByRole('status')).toContainText('Unavailable');

  await category('Soil').click();
  await expect(toggle('Surface soil moisture')).toHaveAttribute('aria-checked', 'false');
  await toggle('Surface soil moisture').click();
  await expect(category('Soil')).toContainText('1 enabled');
  await expect(category('Rain')).toContainText('1 enabled');
  await expect(activeChips).toHaveCount(2);
  const soilDetails = panel.locator('#flood-header-soil_moisture');
  await expect(soilDetails).toHaveAttribute('aria-expanded', 'false');
  await soilDetails.click();
  await expect(panel.getByLabel('Observation date · shared')).toHaveValue('2021-12-20');
  await category('Flood').click();
  await expect(toggle('Flood extent')).toHaveAttribute('aria-checked', 'false');
  await toggle('Flood extent').click();
  await expect(panel.locator('#flood-header-flood_extent')).toHaveAttribute('aria-expanded', 'false');
  await expect(category('Flood')).toContainText('1 enabled');
  await expect(activeChips).toHaveCount(3);
  await chip('Rainfall').click();
  await expect(category('Rain')).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle('Rainfall')).toHaveAttribute('aria-checked', 'true');
  await expect(opacity).toHaveValue('10');
  await expect(date).toHaveValue('2021-12-20');
  await toggle('Rainfall').click();
  await expect(toggle('Rainfall')).toHaveAttribute('aria-checked', 'false');
  await expect(category('Rain')).toContainText('0 enabled');
  await expect(chip('Rainfall')).toHaveCount(0);
  await expect(activeChips).toHaveCount(2);

  for (const viewport of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await chip('Surface soil moisture').click();
    const nav = await page.getByRole('navigation', { name: 'Sections' }).boundingBox();
    const header = panel.locator('header');
    const headerBox = await header.boundingBox();
    assert.ok(nav && headerBox && headerBox.y >= nav.y + nav.height,
      'Layer header must sit below the app navigation');
    for (const name of ['Flood', 'Rain', 'Soil']) {
      await expect(category(name)).toBeVisible();
      await category(name).click({ trial: true });
    }
    await panel.getByRole('slider', { name: 'Opacity', exact: true }).scrollIntoViewIfNeeded();
    const stickyBox = await header.boundingBox();
    assert.ok(stickyBox && stickyBox.y >= nav.y + nav.height,
      'Sticky layer navigation must remain below app navigation while scrolling');
    await category('Rain').click();
    await expect(toggle('Rainfall')).toBeVisible();
    const firstRow = await panel.locator('article').first().boundingBox();
    const resetHeader = await header.boundingBox();
    assert.ok(firstRow && resetHeader && firstRow.y >= resetHeader.y + resetHeader.height - 1,
      'Changing category must reveal the first row below its sticky header');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
      'Desktop layout must not overflow horizontally');
    const file = join(screenshots, `map-layers-${viewport.width}x${viewport.height}.png`);
    await page.screenshot({ path: file, animations: 'disabled' });
    console.log(file);
  }

  for (const [group, name] of [
    ['Flood', 'Daily water (fused)'], ['Rain', 'Rainfall'],
    ['Rain', 'Forecast rainfall · next 24 h'], ['Soil', 'Soil clay content'],
  ]) {
    await category(group).click();
    await toggle(name).click();
  }
  await expect(activeChips).toHaveCount(6);
  await chip('Soil clay content').click();
  await expect.poll(async () => {
    const header = await panel.locator('header').boundingBox();
    const row = await panel.locator('#flood-header-soil_texture').boundingBox();
    return row.y - header.y - header.height;
  }, { message: 'A layer shortcut must clear the header when six enabled chips wrap' }).toBeGreaterThanOrEqual(0);

  await panel.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(activeChips).toHaveCount(0);
  for (const name of ['Flood', 'Rain', 'Soil']) {
    await expect(category(name)).toContainText('0 enabled');
    await category(name).click();
    for (const control of await panel.getByRole('switch').all()) {
      await expect(control).toHaveAttribute('aria-checked', 'false');
    }
  }
  assert.deepEqual(runtimeErrors, [], 'No uncaught browser errors');
  assert.deepEqual(backhaulRequests, [], 'The main map must not request the retired network layer');
  console.log('Map layer smoke check passed: keyboard, grouping, toggles, shared settings, persistence, errors and desktop layout.');
} finally {
  await browser.close();
}
