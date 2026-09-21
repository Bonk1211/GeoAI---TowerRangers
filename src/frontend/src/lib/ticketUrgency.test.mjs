import assert from 'node:assert/strict';
import test from 'node:test';

import { slaStatus, reportedAgeLabel } from './ticketUrgency.ts';

test('no SLA on the ticket is stated, not silently treated as met', () => {
  const s = slaStatus(null, '2026-09-08');
  assert.equal(s.level, 'none');
  assert.match(s.label, /No SLA/i);
});

test('a dispatch landing after the SLA reports how late it is', () => {
  const s = slaStatus('2026-09-10', '2026-09-13');
  assert.equal(s.level, 'breach');
  assert.equal(s.days, -3);
  assert.match(s.label, /3 days late/);
});

test('landing exactly on the SLA day is met, not breached', () => {
  const s = slaStatus('2026-09-10', '2026-09-10');
  assert.equal(s.level, 'due');
  assert.equal(s.days, 0);
});

test('one day of slack is flagged tight rather than comfortable', () => {
  assert.equal(slaStatus('2026-09-10', '2026-09-09').level, 'tight');
  assert.equal(slaStatus('2026-09-10', '2026-09-08').level, 'tight');
});

test('three or more days of slack is comfortable', () => {
  const s = slaStatus('2026-09-14', '2026-09-08');
  assert.equal(s.level, 'ok');
  assert.equal(s.days, 6);
});

test('a singular day does not read as "1 days"', () => {
  assert.match(slaStatus('2026-09-10', '2026-09-11').label, /1 day late/);
  assert.doesNotMatch(slaStatus('2026-09-10', '2026-09-11').label, /1 days/);
});

test('an unparseable SLA is treated as absent rather than as a breach', () => {
  assert.equal(slaStatus('not-a-date', '2026-09-08').level, 'none');
});

test('reported age counts whole days and names today as today', () => {
  assert.equal(reportedAgeLabel('2026-09-08T09:00:00Z', new Date('2026-09-08T18:00:00Z')), 'today');
  assert.equal(reportedAgeLabel('2026-09-07T09:00:00Z', new Date('2026-09-08T18:00:00Z')), 'yesterday');
  assert.equal(reportedAgeLabel('2026-09-03T09:00:00Z', new Date('2026-09-08T18:00:00Z')), '5 days ago');
});

test('a future timestamp does not render as negative days', () => {
  assert.equal(reportedAgeLabel('2026-09-20T09:00:00Z', new Date('2026-09-08T18:00:00Z')), 'today');
});
