import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationCameraAt } from './simulationCamera.ts';

test('director assesses priorities before civil dispatch, then holds on the flood before response', () => {
  const targets = {
    site: [116.086, 5.977],
    maintenance: { center: [116.1, 6.0], zoom: 10.7 },
    assessment: { center: [116.25, 5.94], zoom: 9.4 },
    flood: { center: [116.095, 6.011], zoom: 11.2 },
    response: { center: [116.08, 5.96], zoom: 11.5 },
  };
  const at = (time, reduced = false) => simulationCameraAt(time, targets, reduced);
  assert.deepEqual(at(0).center, targets.site);
  assert.equal(at(0).zoom, 13.3);
  assert.deepEqual(at(13_600).center, targets.assessment.center);
  assert.equal(at(13_600).zoom, targets.assessment.zoom);
  assert.equal(at(13_600).pitch, 60);
  for (const time of [14_000, 14_999, 15_000]) assert.deepEqual(at(time), at(13_600));
  assert.deepEqual(at(18_600).center, targets.maintenance.center);
  assert.equal(at(18_600).zoom, targets.maintenance.zoom);
  for (const time of [19_000, 20_500, 22_600, 23_500, 24_000]) {
    assert.deepEqual(at(time), at(18_600));
  }
  assert.deepEqual(at(27_600).center, targets.flood.center);
  assert.equal(at(27_600).zoom, targets.flood.zoom);
  assert.equal(at(27_600).pitch, 52);
  assert.ok(at(25_800).zoom > targets.maintenance.zoom && at(25_800).zoom < targets.flood.zoom);
  for (const time of [27_600, 30_600, 39_999, 40_000, 47_000, 51_000, 53_999, 54_000]) {
    assert.deepEqual(at(time), at(27_600), 'the flood view holds without revisiting later-maintenance towers or spinning');
  }
  assert.ok(at(16_800).zoom > targets.assessment.zoom && at(16_800).zoom < targets.maintenance.zoom);
  assert.deepEqual(at(58_000).center, targets.response.center);
  for (const time of [62_000, 66_000, 68_999]) assert.deepEqual(at(time), at(58_000));
  for (const time of [69_000, 71_999, 72_000, 73_000, 75_000, 76_000, 78_000, 79_999, 82_000, 86_000, 87_999]) {
    assert.deepEqual(at(time), at(58_000), 'drone links and the four-crew split hold the whole corridor');
  }
  assert.equal(at(92_000).zoom, 11.05);
  for (const time of [6_000, 10_000, 15_000, 24_000, 54_000, 88_000, 92_000]) {
    const before = at(time - 1), after = at(time + 1);
    for (const key of ['zoom', 'pitch', 'bearing']) assert.ok(Math.abs(after[key] - before[key]) < 0.0001);
    for (const index of [0, 1]) assert.ok(Math.abs(after.center[index] - before.center[index]) < 0.0001);
  }
  const forward = Array.from({ length: 193 }, (_, i) => at(i * 500));
  for (let i = forward.length - 1; i >= 0; i--) {
    assert.deepEqual(at(i * 500), forward[i]);
    for (const value of [...forward[i].center, forward[i].zoom, forward[i].pitch, forward[i].bearing]) {
      assert.ok(Number.isFinite(value));
    }
  }
  assert.deepEqual(at(28_500, true), at(34_000, true));
  assert.equal(at(33_000, true).pitch, 50);
  assert.equal(at(33_000, true).bearing, -28);
  for (const time of [-Infinity, -1, NaN]) assert.deepEqual(at(time), at(0));
  for (const time of [Infinity, 100_000]) assert.deepEqual(at(time), at(96_000));
});
