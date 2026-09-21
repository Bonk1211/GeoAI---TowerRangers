import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_FLOOD_DATE, useFloodLayers } from './useFloodLayers.ts';

test('latest imagery follows saved dates and never overrides an explicit historical selection', () => {
  const store = useFloodLayers.getState();
  try {
    store.syncLatestDate(undefined);
    assert.equal(useFloodLayers.getState().date, DEFAULT_FLOOD_DATE);
    assert.equal(useFloodLayers.getState().followLatest, true);
    store.syncLatestDate('2026-09-12');
    assert.equal(useFloodLayers.getState().date, '2026-09-12');
    store.syncLatestDate('2026-09-14');
    assert.equal(useFloodLayers.getState().date, '2026-09-14');
    store.setDate('2026-09-01');
    store.syncLatestDate('2026-09-12');
    assert.equal(useFloodLayers.getState().date, '2026-09-01');
    assert.equal(useFloodLayers.getState().followLatest, false);
    store.useLatest();
    store.syncLatestDate('2026-09-14');
    assert.equal(useFloodLayers.getState().date, '2026-09-14');
  } finally {
    useFloodLayers.setState(store, true);
  }
});
