import test from 'node:test';
import assert from 'node:assert/strict';
import { toCorpus } from './feedbackCorpus.ts';

function ticket(over = {}) {
  return {
    ticket_id: 'T-1',
    tower_id: 'MY_1',
    title: 't',
    description: 'd',
    issue_type: 'Structural',
    reporter: 'field-tech-01',
    status: 'closed',
    assignee_crew_id: null,
    created_at: '2026-09-01T00:00:00Z',
    target_sla: null,
    fix_notes: [],
    resolution: 'confirmed',
    source: 'manual',
    ...over,
  };
}

function tower(over = {}) {
  return {
    tower_id: 'MY_1',
    risk: 0.8,
    priority: 0.82,
    decision: 'maintain',
    dominant_factor: 'flood',
    ...over,
  };
}

function observation(over = {}) {
  return {
    observed_at: '2026-08-20T00:00:00+00:00',
    tower_id: 'MY_1',
    source: 's2_change',
    observation: { evi_delta_per_year: 0.1 },
    predicted_priority: 0.9,
    predicted_decision: 'maintain',
    agreement: 'agree',
    label_status: 'unlabeled',
    simulated: false,
    ...over,
  };
}

test('confirmed is label 1, false_positive is label 0', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'T-1', resolution: 'confirmed' }),
     ticket({ ticket_id: 'T-2', resolution: 'false_positive' })],
    [tower()],
    [],
  );
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.ticket_id === 'T-1').needed_corrective_maintenance, 1);
  assert.equal(rows.find((r) => r.ticket_id === 'T-2').needed_corrective_maintenance, 0);
});

test('only closed tickets carrying a verdict enter the corpus', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'T-open', status: 'open', resolution: null }),
     ticket({ ticket_id: 'T-active', status: 'active', resolution: null }),
     ticket({ ticket_id: 'T-resolved', status: 'resolved', resolution: null }),
     ticket({ ticket_id: 'T-closed-no-verdict', status: 'closed', resolution: null }),
     ticket({ ticket_id: 'T-good', status: 'closed', resolution: 'confirmed' })],
    [tower()],
    [],
  );
  assert.deepEqual(rows.map((r) => r.ticket_id), ['T-good']);
});

test('a snapshot gives belief_at raise; its absence falls back to the current score', () => {
  const snap = {
    risk: 0.91, priority: 0.93, decision: 'maintain',
    dominant_factor: 'power', captured_at: '2026-08-25T00:00:00Z',
  };
  const [withSnap] = toCorpus([ticket({ model_snapshot: snap })], [tower()], []);
  assert.equal(withSnap.belief_at, 'raise');
  assert.equal(withSnap.belief.priority, 0.93);
  assert.equal(withSnap.belief.dominant_factor, 'power');

  const [without] = toCorpus([ticket()], [tower()], []);
  assert.equal(without.belief_at, 'current');
  assert.equal(without.belief.priority, 0.82);
});

test('a tower the app has never scored yields no belief at all', () => {
  const [row] = toCorpus([ticket({ tower_id: 'MY_GHOST' })], [tower()], []);
  assert.equal(row.belief, null);
  assert.equal(row.belief_at, 'current');
  assert.equal(row.verdict_agreement, 'indeterminate');
});

test('verdict_agreement reads maintain as dispatch and watch/ok as do-not', () => {
  const at = (decision, resolution) =>
    toCorpus(
      [ticket({ resolution, model_snapshot: {
        risk: 0.5, priority: 0.5, decision, dominant_factor: 'flood',
        captured_at: '2026-08-25T00:00:00Z' } })],
      [tower()],
      [],
    )[0].verdict_agreement;

  assert.equal(at('maintain', 'confirmed'), 'agree');         // caught it
  assert.equal(at('maintain', 'false_positive'), 'disagree'); // false alarm
  assert.equal(at('watch', 'confirmed'), 'disagree');         // missed it
  assert.equal(at('ok', 'confirmed'), 'disagree');            // missed it
  assert.equal(at('watch', 'false_positive'), 'agree');       // correctly quiet
  assert.equal(at('ok', 'false_positive'), 'agree');          // correctly quiet
});

test('an unlabeled observation for the tower makes the row attachable', () => {
  const [row] = toCorpus([ticket()], [tower()], [observation()]);
  assert.equal(row.attachable, true);
  assert.equal(row.observation.source, 's2_change');
  assert.equal(row.observation.observed_at, '2026-08-20T00:00:00+00:00');
});

test('no observation, or an already-confirmed one, leaves the row unattachable', () => {
  const [none] = toCorpus([ticket()], [tower()], []);
  assert.equal(none.attachable, false);
  assert.equal(none.observation, null);

  const [done] = toCorpus([ticket()], [tower()], [observation({ label_status: 'confirmed' })]);
  assert.equal(done.attachable, false);
  assert.equal(done.observation, null);

  const [other] = toCorpus([ticket()], [tower()], [observation({ tower_id: 'MY_OTHER' })]);
  assert.equal(other.attachable, false);
});

test('evidence counts separate notes from attachments', () => {
  const [row] = toCorpus(
    [ticket({ fix_notes: [
      { author: 'a', created_at: 'x', text: 'one' },
      { author: 'a', created_at: 'x', text: 'two',
        attachment: { name: 'p.jpg', type: 'image/jpeg', size: 10, dataUrl: 'data:,' } },
    ] })],
    [tower()],
    [],
  );
  assert.equal(row.evidence_notes, 2);
  assert.equal(row.evidence_attachments, 1);
});

test('model feedback surfaces as factor_correct and actual_factor', () => {
  const [row] = toCorpus(
    [ticket({ model_feedback: {
      accurate: false, actual_factor: 'power', author: 'a',
      created_at: '2026-09-02T00:00:00Z' } })],
    [tower()],
    [],
  );
  assert.equal(row.factor_correct, false);
  assert.equal(row.actual_factor, 'power');
  assert.equal(row.comment, null);

  const [bare] = toCorpus([ticket()], [tower()], []);
  assert.equal(bare.factor_correct, null);
  assert.equal(bare.actual_factor, null);
  assert.equal(bare.comment, null);
});

test("the technician's comment is carried onto the row", () => {
  const [row] = toCorpus(
    [ticket({ model_feedback: {
      accurate: true, comment: 'cabinet seal was the real issue', author: 'a',
      created_at: '2026-09-02T00:00:00Z' } })],
    [tower()],
    [],
  );
  assert.equal(row.factor_correct, true);
  assert.equal(row.comment, 'cabinet seal was the real issue');
});

test('an empty ticket list yields an empty corpus rather than throwing', () => {
  assert.deepEqual(toCorpus([], [], []), []);
});

import { verdictCounts, toObservationRecords, toJsonl } from './feedbackCorpus.ts';

test('the matrix counts only raise-time beliefs, and reports what it excluded', () => {
  const snap = (decision) => ({
    risk: 0.5, priority: 0.5, decision, dominant_factor: 'flood',
    captured_at: '2026-08-25T00:00:00Z',
  });
  const rows = toCorpus(
    [ticket({ ticket_id: 'A', resolution: 'confirmed', model_snapshot: snap('maintain') }),
     ticket({ ticket_id: 'B', resolution: 'false_positive', model_snapshot: snap('maintain') }),
     ticket({ ticket_id: 'C', resolution: 'confirmed', model_snapshot: snap('ok') }),
     ticket({ ticket_id: 'D', resolution: 'false_positive', model_snapshot: snap('watch') }),
     ticket({ ticket_id: 'E', resolution: 'confirmed' })], // no snapshot -> excluded
    [tower()],
    [],
  );
  const counts = verdictCounts(rows);
  assert.equal(counts.caught, 1);
  assert.equal(counts.falseAlarm, 1);
  assert.equal(counts.missed, 1);
  assert.equal(counts.quiet, 1);
  assert.equal(counts.n, 4);
  assert.equal(counts.excluded, 1);
});

test('the export reproduces the observation key triple byte-identically', () => {
  // THE test. _confirmed() keys on (tower_id, source, observed_at); a drifted
  // triple appends an orphan row and the original stays unlabeled forever,
  // silently.
  const obs = observation();
  const rows = toCorpus([ticket({ resolution: 'confirmed' })], [tower()], [obs]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.tower_id, obs.tower_id);
  assert.equal(record.source, obs.source);
  assert.equal(record.observed_at, obs.observed_at);
});

test('measured fields are carried, never recomputed from the current tower', () => {
  const obs = observation({ predicted_priority: 0.9, predicted_decision: 'maintain', agreement: 'agree' });
  // The tower's priority is 0.82 and differs on purpose.
  const rows = toCorpus([ticket()], [tower({ priority: 0.82 })], [obs]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.predicted_priority, 0.9);
  assert.equal(record.predicted_decision, 'maintain');
  assert.equal(record.agreement, 'agree');
});

test('every exported record is a real, confirmed, non-simulated closure', () => {
  const rows = toCorpus([ticket({ resolution: 'false_positive' })], [tower()], [observation()]);
  const [record] = toObservationRecords(rows);

  assert.equal(record.label_status, 'confirmed');
  assert.equal(record.simulated, false);
  assert.equal(record.observation.needed_corrective_maintenance, 0);
  // Original observation payload survives alongside the label.
  assert.equal(record.observation.evi_delta_per_year, 0.1);
  // Provenance, inside the free-form dict so no validated field is touched.
  assert.equal(record.observation.ticket_id, 'T-1');
});

test('unattachable rows are omitted entirely rather than given a fake source', () => {
  const rows = toCorpus(
    [ticket({ ticket_id: 'has-obs' }), ticket({ ticket_id: 'no-obs', tower_id: 'MY_ALONE' })],
    [tower(), tower({ tower_id: 'MY_ALONE' })],
    [observation()],
  );
  assert.equal(rows.length, 2);
  const records = toObservationRecords(rows);
  assert.equal(records.length, 1);
  assert.equal(records[0].observation.ticket_id, 'has-obs');
});

test('jsonl is one compact json object per line, newline-terminated', () => {
  const rows = toCorpus([ticket()], [tower()], [observation()]);
  const text = toJsonl(toObservationRecords(rows));
  assert.ok(text.endsWith('\n'));
  const lines = text.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).tower_id, 'MY_1');
  assert.ok(!lines[0].includes('\n'));
});

test('an empty corpus exports nothing and counts zero without throwing', () => {
  assert.deepEqual(toObservationRecords([]), []);
  assert.equal(toJsonl([]), '');
  const counts = verdictCounts([]);
  assert.equal(counts.n, 0);
  assert.equal(counts.caught, 0);
});
