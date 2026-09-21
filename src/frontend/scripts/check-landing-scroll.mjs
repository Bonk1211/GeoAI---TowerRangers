// Run with npm run dev and existing Playwright tooling (see check-landing-transition.mjs).
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const base = process.env.LANDING_URL || 'http://localhost:5173';

async function dragPage() {
  await page.mouse.move(12, 650);
  await page.mouse.down();
  await page.mouse.move(12, 350, { steps: 12 });
  assert.equal(await page.locator('.landing-dragging').count(), 1, 'Background drag must capture the pointer');
  await page.mouse.up();
  assert.equal(await page.locator('.landing-dragging').count(), 0, 'Releasing must restore the cursor');
}

async function settledScroll() {
  return page.evaluate(() => new Promise((resolve) => setTimeout(() => resolve(scrollY), 180)));
}

try {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.locator('.landing-earth-ready').waitFor();
    assert.equal(await page.evaluate(async () => (await import('/src/state/useMapInstance.ts')).useMapInstance.getState().map), null,
      'Decorative globe must not take over the operational map store');
    await dragPage();
    const released = await page.evaluate(() => scrollY);
    assert(released >= 290, 'Dragging up must scroll down with the pointer');
    await page.waitForFunction((y) => scrollY > y + 20, released);
    await page.keyboard.press('Escape');
    const stopped = await page.evaluate(() => scrollY);
    assert.equal(await settledScroll(), stopped, 'Keyboard input must stop momentum');
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => Number(document.querySelector('.landing').style.getPropertyValue('--globe-progress')) === 0);

    if (width === 1440) {
      const text = await page.locator('#hero-title').evaluate((title) => {
        const range = document.createRange();
        range.selectNodeContents(title.firstChild);
        const rect = range.getBoundingClientRect();
        return { x: rect.x, y: rect.y + rect.height / 2, width: rect.width };
      });
      await page.mouse.move(text.x + 2, text.y);
      await page.mouse.down();
      await page.mouse.move(text.x + text.width * .8, text.y, { steps: 8 });
      await page.mouse.up();
      assert(await page.evaluate(() => getSelection().toString().length > 0), 'Text remains selectable');
      assert.equal(await page.evaluate(() => scrollY), 0, 'Text selection must not drag the page');
      await page.evaluate(() => getSelection().removeAllRanges());
      await dragPage();
      await page.mouse.wheel(0, -100);
      const afterWheel = await settledScroll();
      assert.equal(await settledScroll(), afterWheel, 'Wheel scrolling must cancel drag momentum');
      await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForFunction(() => Number(document.querySelector('.landing').style.getPropertyValue('--globe-progress')) === 0);
    }
    const start = await page.locator('.landing-globe-map canvas').screenshot();
    const backdropTop = (await page.locator('.landing-globe-backdrop').boundingBox()).y;
    const stops = ['MALAYSIA', 'THAILAND', 'MYANMAR', 'LAOS', 'CAMBODIA', 'VIETNAM', 'PHILIPPINES', 'BRUNEI', 'INDONESIA', 'SINGAPORE', 'MALAYSIA'];
    let opacity = 1;
    for (let i = 1; i < stops.length; i++) {
      await page.locator('.landing').evaluate((track, progress) => {
        const top = track.getBoundingClientRect().top + scrollY;
        scrollTo({ top: top + (track.offsetHeight - innerHeight) * progress, behavior: 'instant' });
      }, i / (stops.length - 1));
      await page.waitForFunction((name) => document.querySelector('.landing-country')?.firstChild?.textContent === name, stops[i]);
      assert.equal((await page.locator('.landing-globe-backdrop').boundingBox()).y, backdropTop, 'Globe stays behind the content as the page scrolls');
      const nextOpacity = await page.locator('.landing-earth').evaluate((earth) => Number(getComputedStyle(earth).opacity));
      assert(nextOpacity <= opacity && nextOpacity >= .23, 'Globe fades gradually but remains visible');
      opacity = nextOpacity;
      if (i === 5) {
        const rotated = await page.locator('.landing-globe-map canvas').screenshot();
        assert(!start.equals(rotated), 'Globe surface must change, not just the country label');
        assert((await page.locator('.landing-hero').boundingBox()).y < 0, 'Content scrolls naturally without a pinned hero');
      }
    }
    assert(opacity < .3, 'Globe stays subtle behind the lower content');
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.waitForFunction(() => Number(document.querySelector('.landing').style.getPropertyValue('--globe-progress')) === 0);
    assert((await page.locator('.landing-country').textContent()).startsWith('MALAYSIA'), 'Scrolling up must restore the first view');
    assert.equal(await page.locator('.landing-earth').evaluate((earth) => getComputedStyle(earth).opacity), '1');
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'No horizontal overflow');
    if (width > 760) await page.getByRole('link', { name: 'The platform', exact: true }).click();
    else await page.getByRole('link', { name: 'Scroll to explore ASEAN' }).click();
    await page.waitForURL('**/#platform');
    assert((await page.locator('#platform').boundingBox()).y >= 0, 'Content remains reachable after the globe');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.landing-earth')).opacity) < .3);
    if (process.env.LANDING_SCREENSHOTS) await page.screenshot({ path: `${process.env.LANDING_SCREENSHOTS}/asean-content-${width}.png` });
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.landing-earth-ready').waitFor();
  await dragPage();
  const reducedRelease = await page.evaluate(() => scrollY);
  assert.equal(await settledScroll(), reducedRelease, 'Reduced motion disables release momentum');
  await page.evaluate(() => scrollTo(0, 400));
  assert.equal(await page.locator('.landing-hero').evaluate((hero) => getComputedStyle(hero).position), 'relative');
  assert.equal(await page.locator('.landing-globe-backdrop').evaluate((globe) => getComputedStyle(globe).position), 'absolute');
  assert((await page.locator('.landing-country').textContent()).startsWith('MALAYSIA'));

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 640 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.locator('.landing-hero').evaluate((hero) => getComputedStyle(hero).position), 'relative', 'Short screens must not be trapped in a tall sticky hero');

  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      return type.includes('webgl') ? null : getContext.call(this, type, ...args);
    };
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.locator('.landing-globe-unavailable').waitFor();
  assert.equal(await page.locator('.landing-globe-backdrop').evaluate((globe) => getComputedStyle(globe).position), 'absolute');
  assert.equal(await page.locator('.landing-earth img').evaluate((img) => getComputedStyle(img).opacity), '1');
  await page.getByRole('link', { name: 'Explore the platform' }).waitFor();
  assert.deepEqual(errors, [], 'No browser runtime errors');
  console.log('PASS: drag scrolling and momentum, keyboard/wheel interruption, text selection, desktop/mobile ASEAN rotation and fade, reverse scrolling, isolated map state, navigation, reduced motion and WebGL fallback.');
} finally {
  await browser.close();
}
