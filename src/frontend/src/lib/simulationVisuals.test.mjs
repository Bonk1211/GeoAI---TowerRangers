import assert from 'node:assert/strict';
import test from 'node:test';
import { simulationAssessmentPulseAt, simulationCrewStepAt, simulationEnvironmentAt, simulationRoadAccessAt, simulationSceneAt } from './simulationVisuals.ts';

test('assessment markers pulse only during assessment and freeze deterministically', () => {
  for (const [time, opacity] of [[27_000, 1], [27_800, .2], [28_600, 1], [54_000, 1]]) {
    assert.ok(Math.abs(simulationAssessmentPulseAt(time) - opacity) < 1e-12);
  }
  const times = [26_999, 27_000, 27_800, 28_600, 33_000, 39_999, 40_000, 53_999, 54_000];
  const forward = times.map(time => simulationAssessmentPulseAt(time));
  times.toReversed().forEach((time, i) => {
    assert.equal(simulationAssessmentPulseAt(time), forward[forward.length - 1 - i]);
    assert.equal(simulationAssessmentPulseAt(time, true), 1);
  });
  for (const time of [-Infinity, -1, NaN, Infinity, 15_800, 26_999, 54_000, 96_000]) {
    assert.equal(simulationAssessmentPulseAt(time), 1);
  }
});

test('visuals follow authored boundaries and interpolate deterministically when seeking', () => {
  const samples = [
    [0, 0.28, 0], [15_000, 0.5, 0], [26_000, 0.86, 1], [40_000, 0.94, 1],
    [62_000, 0.9, 1], [80_000, 0.78, 1], [88_000, 0.57, 0.35], [96_000, 0.38, 0],
  ];
  for (const [time, wetness, flood] of samples) {
    const actual = simulationEnvironmentAt(time);
    assert.ok(Math.abs(actual.wetness - wetness) < 1e-12);
    assert.ok(Math.abs(actual.flood - flood) < 1e-12);
  }
  assert.equal(simulationEnvironmentAt(24_000).flood, 0);
  assert.equal(simulationEnvironmentAt(25_000).flood, 0.5);
  assert.ok(Math.abs(simulationEnvironmentAt(84_000).flood - 0.675) < 1e-12);
  assert.ok(Math.abs(simulationEnvironmentAt(92_000).flood - 0.175) < 1e-12);
  for (const [time, rain] of [[0, .2], [8_000, .48], [16_000, .76], [26_000, 1], [40_000, 1], [62_000, .78], [80_000, .45], [88_000, .16], [96_000, 0]]) {
    assert.ok(Math.abs(simulationEnvironmentAt(time).rain - rain) < 1e-12);
  }
  assert.ok(Math.abs(simulationEnvironmentAt(4_000).rain - .34) < 1e-12);
  assert.ok(Math.abs(simulationEnvironmentAt(92_000).rain - .08) < 1e-12);
  for (let time = 100; time <= 26_000; time += 100) {
    const previous = simulationEnvironmentAt(time - 100).rain;
    const current = simulationEnvironmentAt(time).rain;
    assert.ok(current >= previous && current - previous < .004);
  }
  for (let time = 40_100; time <= 96_000; time += 100) {
    assert.ok(simulationEnvironmentAt(time).rain <= simulationEnvironmentAt(time - 100).rain);
  }
  for (const [time, river] of [[0, .16], [8_000, .18], [16_000, .3], [24_000, .62], [32_000, .86], [47_000, 1], [62_000, .9], [80_000, .72], [88_000, .42], [96_000, .24]]) {
    assert.ok(Math.abs(simulationEnvironmentAt(time).river - river) < 1e-12);
  }
  assert.ok(Math.abs(simulationEnvironmentAt(20_000).river - .46) < 1e-12);
  // The authored lag matters: rain peaks first, then wet soil, then the river.
  assert.equal(simulationEnvironmentAt(26_000).rain, 1);
  assert.ok(simulationEnvironmentAt(26_000).wetness < simulationEnvironmentAt(40_000).wetness);
  assert.ok(simulationEnvironmentAt(40_000).river < simulationEnvironmentAt(47_000).river);
  assert.ok(simulationEnvironmentAt(47_000).rain < 1);
  const residual = simulationEnvironmentAt(96_000);
  assert.equal(residual.rain, 0);
  assert.equal(residual.flood, 0);
  assert.ok(residual.wetness > 0 && residual.river > 0);
  for (const [time, road] of [[0, 'open'], [23_999, 'open'], [24_000, 'blocked'], [79_999, 'blocked'], [80_000, 'reopening'], [87_999, 'reopening'], [88_000, 'open']]) {
    assert.equal(simulationRoadAccessAt(time), road);
  }

  const scenes = [[0, 'forecast'], [15_000, 'prepare'], [19_000, 'exit-plan'], [20_500, 'evacuate'], [23_500, 'civil-clear'], [24_000, 'impact'],
    [27_000, 'prioritise'], [40_000, 'continuity'], [54_000, 'staging'], [62_000, 'drone-launch'],
    [68_000, 'mobile-support'], [72_000, 'network-dispatch'], [78_000, 'network-hold'], [80_000, 'restore'], [88_000, 'recover']];
  for (let i = 0; i < scenes.length; i++) {
    const [time, id] = scenes[i];
    assert.equal(simulationSceneAt(time).id, id);
    if (i > 0) assert.equal(simulationSceneAt(time - 1).id, scenes[i - 1][1]);
    for (const value of Object.values(simulationSceneAt(time))) assert.ok(value.length > 0);
  }

  for (const time of [54_000, 62_000, 79_500, 87_999]) assert.equal(simulationSceneAt(time, true).id, 'access-hold');
  for (const time of [0, 53_999, 88_000]) assert.deepEqual(simulationSceneAt(time, true), simulationSceneAt(time));
  assert.equal(simulationSceneAt(76_000, false, false).id, 'mobile-access-check');
  assert.equal(simulationSceneAt(76_000, true, false).id, 'access-hold');
  assert.equal(simulationSceneAt(80_000, false, false).id, 'restore');
  const times = [-Infinity, -1, 0, 7_500, 24_500, 33_000, 84_000, 96_000, 100_000, Infinity, NaN];
  const forward = times.map((time) => ({ environment: simulationEnvironmentAt(time), scene: simulationSceneAt(time), road: simulationRoadAccessAt(time) }));
  times.toReversed().forEach((time, i) => {
    const environment = simulationEnvironmentAt(time);
    assert.deepEqual({ environment, scene: simulationSceneAt(time), road: simulationRoadAccessAt(time) }, forward[forward.length - 1 - i]);
    for (const value of Object.values(environment)) {
      assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
    }
  });
  for (const time of [-Infinity, -1, NaN]) {
    assert.deepEqual(simulationEnvironmentAt(time), simulationEnvironmentAt(0));
    assert.deepEqual(simulationSceneAt(time), simulationSceneAt(0));
  }
  for (const time of [100_000, Infinity]) {
    assert.deepEqual(simulationEnvironmentAt(time), simulationEnvironmentAt(96_000));
    assert.deepEqual(simulationSceneAt(time), simulationSceneAt(96_000));
  }
});

test('crew travel shares deterministic leg selection, site holds, and reduced-motion destinations', () => {
  for (const [emergency, start, end] of [[false, 15_000, 40_000], [true, 54_000, 88_000]]) {
    assert.equal(simulationCrewStepAt(start - 1, emergency, 2), null);
    assert.equal(simulationCrewStepAt(end, emergency, 2), null);
    assert.deepEqual(simulationCrewStepAt(start, emergency, 2), { legIndex: 0, travel: 0 });
    const legDuration = (end - start - 1_500) / 2;
    const halfTravel = start + legDuration * 0.325;
    assert.deepEqual(simulationCrewStepAt(halfTravel, emergency, 2), { legIndex: 0, travel: 0.5 });
    assert.deepEqual(simulationCrewStepAt(start + legDuration * 0.8, emergency, 2), { legIndex: 0, travel: 1 });
    assert.deepEqual(simulationCrewStepAt(start + legDuration, emergency, 2), { legIndex: 1, travel: 0 });
    assert.deepEqual(simulationCrewStepAt(end - 1_500, emergency, 2), { legIndex: 1, travel: 1 });
    assert.deepEqual(simulationCrewStepAt(end - 1, emergency, 2), { legIndex: 1, travel: 1 });
    for (const time of [start, start + legDuration, halfTravel, halfTravel]) {
      const step = simulationCrewStepAt(time, emergency, 2);
      assert.deepEqual(simulationCrewStepAt(time, emergency, 2), step);
      assert.deepEqual(simulationCrewStepAt(time, emergency, 2, true), { legIndex: step.legIndex, travel: 1 });
    }
    assert.deepEqual(simulationCrewStepAt(halfTravel, emergency, 2), { legIndex: 0, travel: 0.5 });
    for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(simulationCrewStepAt(start, emergency, count), null);
    }
    for (const time of [NaN, Infinity, -Infinity]) {
      assert.equal(simulationCrewStepAt(time, emergency, 2), null);
    }
  }
});
