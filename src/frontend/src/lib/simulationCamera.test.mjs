import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationCameraAt } from './simulationCamera.ts';

test('director pulls back after flooding to compare nearby priorities, holds, and preserves later shots', () => {
  const targets = {
    site: [116.086, 5.977],
    maintenance: { center: [116.1, 6.0], zoom: 10.7 },
    assessment: { center: [116.25, 5.94], zoom: 9.4 },
    response: { center: [116.08, 5.96], zoom: 11.5 },
    responseSite: [116.104, 5.954],
  };
  const at = (time, reduced = false) => simulationCameraAt(time, targets, reduced);
  assert.deepEqual(at(0).center, targets.site);
  assert.equal(at(0).zoom, 13.3);
  assert.deepEqual(at(18_600).center, targets.maintenance.center);
  assert.equal(at(18_600).zoom, targets.maintenance.zoom);
  for (const time of [19_000, 22_600, 24_000, 26_999]) {
    assert.deepEqual(at(time), at(18_600));
  }
  assert.deepEqual(at(30_600).center, targets.assessment.center);
  assert.equal(at(30_600).zoom, targets.assessment.zoom);
  assert.equal(at(30_600).pitch, 60);
  assert.ok(at(28_800).zoom > targets.assessment.zoom && at(28_800).zoom < targets.maintenance.zoom);
  for (const time of [30_600, 33_000, 35_000, 39_999]) assert.deepEqual(at(time), at(30_600));
  assert.ok(at(16_800).zoom > targets.maintenance.zoom && at(16_800).zoom < at(15_000).zoom);
  assert.deepEqual(at(58_000).center, targets.response.center);
  const closure = [116.076, 5.989];
  assert.deepEqual(simulationCameraAt(51_000, { ...targets, closure }).center, closure);
  assert.equal(simulationCameraAt(51_000, { ...targets, closure }).zoom, 15.3);
  for (const time of [62_000, 66_000, 68_999]) assert.deepEqual(at(time), at(58_000));
  for (const time of [69_000, 71_999, 72_000, 73_000, 75_000, 76_000, 78_000, 79_999, 82_000, 86_000, 87_999]) {
    assert.deepEqual(at(time), at(58_000), 'drone links and the four-crew split hold the whole corridor');
  }
  assert.equal(at(92_000).zoom, 11.05);
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
