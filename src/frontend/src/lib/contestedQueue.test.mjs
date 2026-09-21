import test from 'node:test';
import assert from 'node:assert/strict';
import { toQueue, funnelCounts } from './contestedQueue.ts';

function observation(overrides = {}) {
  return {
    observed_at: '2026-09-12T00:00:00+00:00',
    tower_id: 'MY_A',
    source: 's2_change',
    observation: { change_rank: 0.9, evi_delta_per_year: -0.12, window_recent: '2025-09-01/2026-09-01' },
    predicted_priority: 0.4,
    predicted_decision: 'ok',
    agreement: 'disagree',
    label_status: 'unlabeled',
    simulated: false,
    ...overrides,
  };
}

function tower(overrides = {}) {
  return {
    tower_id: 'MY_A',
    risk: 0.3,
    priority: 0.4,
    decision: 'ok',
    dominant_factor: 'change',
    ...overrides,
  };
}

function ticket(overrides = {}) {
  return { ticket_id: 'T-1', tower_id: 'MY_A', status: 'open', resolution: null, ...overrides };
}

test('a contested observation becomes a queue entry joined to its live tower', () => {
  const [entry] = toQueue([observation()], [tower()], []);
  assert.equal(entry.tower_id, 'MY_A');
  assert.equal(entry.change_rank, 0.9);
  assert.equal(entry.model_said, 'ok');
  assert.equal(entry.observation.source, 's2_change');
  // The live tower is what a raised ticket snapshots, so it must be carried.
  assert.equal(entry.tower.dominant_factor, 'change');
});

test('an entry whose tower the backend no longer serves is dropped', () => {
  // Raising a ticket against a tower id the backend has never heard of 404s
  // the moment it reaches /schedule/pin.
  assert.deepEqual(toQueue([observation({ tower_id: 'GHOST' })], [tower()], []), []);
});

test('entries are ranked by change rank, strongest contradiction first', () => {
  const rows = [
    observation({ tower_id: 'MY_A', observation: { change_rank: 0.5 } }),
    observation({ tower_id: 'MY_B', observation: { change_rank: 0.97 } }),
    observation({ tower_id: 'MY_C', observation: { change_rank: 0.8 } }),
  ];
  const towers = [tower({ tower_id: 'MY_A' }), tower({ tower_id: 'MY_B' }), tower({ tower_id: 'MY_C' })];
  assert.deepEqual(toQueue(rows, towers, []).map((e) => e.tower_id), ['MY_B', 'MY_C', 'MY_A']);
});

test('a tower with a live ticket is flagged, not hidden', () => {
  // Hiding it would make the queue silently shrink and leave the operator
  // wondering where the tower went. Flagging keeps the count honest.
  const [entry] = toQueue([observation()], [tower()], [ticket()]);
  assert.equal(entry.raised, true);
  assert.equal(entry.raised_ticket_id, 'T-1');
});

test('a CLOSED ticket reads as judged, not as raised', () => {
  // Two different states with two different meanings: `raised` means someone
  // is on it right now, `judged` means a verdict already exists. Collapsing
  // them would either hide a tower nobody is working (raised) or offer a bare
  // "Raise ticket" on one adjudicated seconds ago (judged).
  const [entry] = toQueue([observation()], [tower()], [ticket({ status: 'closed', resolution: 'confirmed' })]);
  assert.equal(entry.raised, false, 'nobody is currently on it');
  assert.equal(entry.raised_ticket_id, null);
  assert.equal(entry.judged, true, 'but it has been adjudicated');
  assert.equal(entry.judged_ticket_id, 'T-1');
});

test('a tower with no ticket at all is neither raised nor judged', () => {
  const [entry] = toQueue([observation()], [tower()], []);
  assert.equal(entry.raised, false);
  assert.equal(entry.judged, false);
  assert.equal(entry.judged_ticket_id, null);
});

test('a live ticket outranks an older closed one', () => {
  // Re-raised after a previous verdict: someone IS on it, and that is the
  // state that governs whether the button shows.
  const [entry] = toQueue([observation()], [tower()], [
    ticket({ ticket_id: 'T-OLD', status: 'closed', resolution: 'confirmed' }),
    ticket({ ticket_id: 'T-NEW', status: 'active' }),
  ]);
  assert.equal(entry.raised, true);
  assert.equal(entry.raised_ticket_id, 'T-NEW');
  assert.equal(entry.judged, true);
  assert.equal(entry.judged_ticket_id, 'T-OLD');
});

test('a missing change rank sorts last but is still queued', () => {
  const rows = [
    observation({ tower_id: 'MY_A', observation: {} }),
    observation({ tower_id: 'MY_B', observation: { change_rank: 0.1 } }),
  ];
  const towers = [tower({ tower_id: 'MY_A' }), tower({ tower_id: 'MY_B' })];
  const queue = toQueue(rows, towers, []);
  assert.deepEqual(queue.map((e) => e.tower_id), ['MY_B', 'MY_A']);
  assert.equal(queue[1].change_rank, null);
});

test('the funnel counts each stage from its own source, never inferred', () => {
  const ledger = { records: 18624, agree: 5104, disagree: 848, indeterminate: 12672, eligible_for_training: 0 };
  const counts = funnelCounts(ledger, 53, 5, 5);
  assert.deepEqual(counts, {
    observed: 18624,
    contested_rows: 848,
    contested_towers: 53,
    judged: 5,
    exportable: 5,
    in_training: 0,
  });
});

test('the funnel degrades to nulls when the ledger is unavailable', () => {
  // A missing ledger is absence, not zero — rendering 0 observations would
  // claim the satellite saw nothing.
  const counts = funnelCounts(null, 0, 5, 5);
  assert.equal(counts.observed, null);
  assert.equal(counts.contested_rows, null);
  assert.equal(counts.in_training, null);
  assert.equal(counts.judged, 5, 'ticket-derived stages are still known');
});
