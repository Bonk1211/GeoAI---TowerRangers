// Run against npm run dev. Uses existing Playwright tooling; set
// PLAYWRIGHT_MODULE to its index.mjs path if it is installed outside this repo.
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.LANDING_URL || 'http://localhost:5173';

try {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    const explore = page.getByRole('link', { name: 'Explore the platform' });
    await explore.waitFor();
    await page.locator('.landing-earth-ready').waitFor();
    await page.locator('.landing-earth img').evaluate((img) => img.decode());
    await page.evaluate(async () => {
      // A returning visitor may have previously enabled terrain mode.
      const { useMap3D } = await import('/src/state/useMap3D.ts');
      useMap3D.getState().setEnabled(true);
      const start = document.startViewTransition.bind(document);
      document.startViewTransition = (update) => {
        const transition = start(update);
        window.landingTransition = transition;
        return transition;
      };
    });
    await explore.focus();
    await page.keyboard.press('Enter');
    await page.evaluate(() => window.landingTransition.ready);
    await page.waitForURL(`${base}/map`);
    const animations = await page.evaluate(() => {
      const running = document.getAnimations();
      for (const animation of running) {
        animation.pause();
        animation.currentTime = 750;
      }
      return running.map((animation) => animation.animationName);
    });
    assert(animations.includes('landing-earth-dive'), 'Globe must zoom');
    assert(animations.includes('landing-map-emerge'), 'Map must emerge beneath the globe');
    assert.equal(await page.locator('.landing').count(), 0, 'Destination must commit before capture');
    assert.equal(await page.evaluate(async () => (await import('/src/state/useMap3D.ts')).useMap3D.getState().enabled), false);
    if (process.env.LANDING_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.LANDING_SCREENSHOTS}/earth-dive-${width}.png` });
      await page.evaluate(() => { for (const animation of document.getAnimations()) animation.currentTime = 1200; });
      await page.screenshot({ path: `${process.env.LANDING_SCREENSHOTS}/map-emerge-${width}.png` });
    }
    await page.evaluate(() => { for (const animation of document.getAnimations()) animation.play(); });
    await page.evaluate(() => window.landingTransition.finished);
    assert.equal(await page.locator('html.entering-platform').count(), 0, 'Transition must clean up');
    await page.getByRole('navigation', { name: 'Sections' }).waitFor();
    assert.equal(await page.evaluate(() => window.__map.getPitch()), 0, 'Map must be flat');
    if (process.env.LANDING_SCREENSHOTS) {
      await page.screenshot({ path: `${process.env.LANDING_SCREENSHOTS}/map-arrival-${width}.png` });
    }
    await page.goBack();
    await explore.waitFor();
  }

  // Hold the real basemap request, then fail it: the globe must wait, and an
  // unavailable provider must reveal the existing error UI instead of trapping navigation.
  const heldRequests = [];
  await page.route('**/styles/positron', (route) => { heldRequests.push(route); });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.getByRole('link', { name: 'Explore the platform' }).click();
  await page.waitForFunction(() => document.getAnimations().some((animation) =>
    animation.animationName === 'landing-earth-dive' && animation.playState === 'paused',
  ));
  assert(heldRequests.length > 0, 'The basemap request must be pending');
  assert.equal(await page.locator('html.entering-platform').count(), 1);
  for (const request of heldRequests) await request.abort();
  await page.waitForFunction(() => !document.documentElement.classList.contains('entering-platform'));
  await page.getByText('Basemap tiles unavailable', { exact: true }).waitFor();
  await page.unroute('**/styles/positron');

  for (const reducedMotion of [true, false]) {
    await page.emulateMedia({ reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    if (!reducedMotion) await page.evaluate(() => { document.startViewTransition = undefined; });
    await page.getByRole('link', { name: 'Explore the platform' }).click();
    await page.waitForURL(`${base}/map`);
    await page.getByRole('navigation', { name: 'Sections' }).waitFor();
    assert.equal(await page.locator('html.entering-platform').count(), 0, 'Fallback must navigate without animation');
  }
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('PASS: desktop/mobile globe zoom and map reveal, keyboard entry, 2D reset, back navigation, slow/failed basemap, reduced motion, unsupported-browser fallback.');
} finally {
  await browser.close();
}
