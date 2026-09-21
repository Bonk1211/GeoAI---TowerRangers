// Run with Vite serving the app. PLAYWRIGHT_MODULE can point to existing tooling.
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));

try {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(process.env.MAP_URL || 'http://localhost:5173/map', { waitUntil: 'domcontentloaded' });
    const view = page.getByRole('region', { name: 'Map view', exact: true });
    const flat = view.getByRole('button', { name: '2D map', exact: true });
    const terrain = view.getByRole('button', { name: '3D terrain', exact: true });
    const stacked = view.getByRole('button', { name: 'Stack layers', exact: true });
    const tools = page.locator('details').filter({ has: page.locator('summary', { hasText: 'Map tools' }) });
    await view.waitFor();
    assert(await view.evaluate((view) => !view.closest('details')), 'Map modes must be outside expandable tools');
    assert.equal(await tools.getAttribute('open'), null, 'Switch is available with Map Tools closed');
    assert.equal(await flat.getAttribute('aria-pressed'), 'true');
    assert.equal(await terrain.getAttribute('aria-pressed'), 'false');
    assert.equal(await stacked.getAttribute('aria-pressed'), 'false');
    for (const button of [flat, terrain, stacked]) {
      assert(await button.evaluate((button) => {
        const r = button.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight
          && button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      }), 'Mode buttons must be visible and unobstructed');
    }
    await page.waitForFunction(() => window.__map?.getSource('terrain-dem'));
    await terrain.click();
    await page.waitForFunction(() => window.__map?.getPitch() > 54 && window.__map?.getTerrain()?.source === 'terrain-dem');
    assert.equal(await terrain.getAttribute('aria-pressed'), 'true');
    assert.equal(await flat.getAttribute('aria-pressed'), 'false');
    assert.equal(await stacked.getAttribute('aria-pressed'), 'false');
    assert.equal(await tools.getAttribute('open'), null);
    assert(await view.getByText('Heights ×10', { exact: true }).isVisible(), 'Exaggeration stays visible without opening tools');
    if (process.env.MAP_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MAP_SCREENSHOT_DIR}/map-view-3d-${width}.png` });

    if (width === 1440) {
      await tools.locator('summary').click();
      await page.getByRole('slider', { name: 'Vertical', exact: true }).focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => window.__map?.getTerrain()?.exaggeration === 11);
      assert(await view.getByText('Heights ×11', { exact: true }).isVisible(), 'Switch reflects advanced settings');
      await tools.locator('summary').click();
    }

    await stacked.click();
    await page.waitForFunction(() => window.__map?.getPitch() === 70 && !window.__map?.getTerrain());
    assert.equal(await stacked.getAttribute('aria-pressed'), 'true');
    assert.equal(await flat.getAttribute('aria-pressed'), 'false');
    assert.equal(await terrain.getAttribute('aria-pressed'), 'false');
    assert.equal(await tools.getAttribute('open'), null);
    assert(await view.getByText('Ground & sky', { exact: true }).isVisible());
    if (process.env.MAP_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MAP_SCREENSHOT_DIR}/map-view-stacked-${width}.png` });

    await flat.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.__map?.getPitch() === 0 && !window.__map?.getTerrain());
    assert.equal(await flat.getAttribute('aria-pressed'), 'true');
    assert.equal(await terrain.getAttribute('aria-pressed'), 'false');
    assert.equal(await stacked.getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('switch', { name: '3D terrain & water' }).count(), 0, 'No duplicate hidden mode toggle');
    if (process.env.MAP_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.MAP_SCREENSHOT_DIR}/map-view-2d-${width}.png` });
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('PASS: standalone desktop/mobile 2D, 3D and stacked controls, real terrain and camera changes, keyboard operation, advanced-setting sync and return to flat map.');
} finally {
  await browser.close();
}
