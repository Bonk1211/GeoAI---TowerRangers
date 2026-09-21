import assert from 'node:assert/strict';
import test from 'node:test';

import { WATER_DEPTH_BANDS } from './inundation.ts';

test('exact depth thresholds use the deeper green-blue-yellow-red class', () => {
  assert.deepEqual(
    WATER_DEPTH_BANDS.map(({ min, color }) => [min, color]),
    [
      [0, '#22c55e'],
      [0.5, '#2563eb'],
      [1, '#facc15'],
      [2, '#dc2626'],
    ],
  );
});
