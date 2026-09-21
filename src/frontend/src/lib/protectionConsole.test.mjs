import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BEAT_INTERVAL_MS,
  protectionBeats,
  transcriptDurationMs,
} from './protectionConsole.ts';
import { mitigationById, protectionDelta } from './protection.ts';
import { AHP_WEIGHTS } from './scorer.ts';

const TOWER = { attribution: { flood: 0.78, power: 0.12, terrain: 0.07, vegetation: 0.03 } };
const MITIGATION = mitigationById('flood_plinth_barrier');
const DELTA = protectionDelta(TOWER, MITIGATION, AHP_WEIGHTS);
const BEATS = protectionBeats('Subang', MITIGATION, DELTA, 'SEL-C1');

test('every beat carries an evidence class', () => {
  for (const b of BEATS) {
    assert.ok(b.evidence === 'mechanism' || b.evidence === 'illustrative', b.id);
  }
});

test('no beat claims to be real — nothing here is observed', () => {
  assert.ok(BEATS.every((b) => b.evidence !== 'real'));
});

test('every field-activity beat is marked illustrative', () => {
  // These are the four beats that describe a crew doing something. If any one
  // of them ever reads as mechanism, the demo is claiming a dispatch happened.
  const byId = Object.fromEntries(BEATS.map((b) => [b.id, b]));
  assert.equal(byId['crew-assigned'].evidence, 'illustrative');
  assert.equal(byId['crew-enroute'].evidence, 'illustrative');
  assert.equal(byId['works-complete'].evidence, 'illustrative');
});

test('the en-route beat says outright that no crew was dispatched', () => {
  const byId = Object.fromEntries(BEATS.map((b) => [b.id, b]));
  assert.match(byId['crew-enroute'].detail, /no crew has been dispatched/i);
});

test('the transcript ends on residual exposure, not on the win', () => {
  assert.equal(BEATS[BEATS.length - 1].id, 'residual');
  assert.equal(BEATS[BEATS.length - 1].detail, MITIGATION.residualNote);
});

test('the result beat quotes the same numbers the delta carries', () => {
  const byId = Object.fromEntries(BEATS.map((b) => [b.id, b]));
  assert.ok(byId['result'].detail.includes(DELTA.riskBefore.toFixed(2)));
  assert.ok(byId['result'].detail.includes(DELTA.riskAfter.toFixed(2)));
});

test('headlines carry no tower ids or api paths', () => {
  for (const b of BEATS) {
    assert.ok(!b.headline.includes('MY_'), b.id);
    assert.ok(!b.headline.includes('/'), b.id);
  }
});

test('dominant-factor flip is mentioned only when it flips', () => {
  const flipped = protectionDelta(
    { attribution: { flood: 0.4, power: 0.38, terrain: 0.12, vegetation: 0.1 } },
    MITIGATION,
    AHP_WEIGHTS,
  );
  const withFlip = protectionBeats('X', MITIGATION, flipped, 'SEL-C1');
  const flipLine = withFlip.find((b) => b.id === 'result').detail;
  assert.match(flipLine, /dominant factor/);

  const noFlipLine = BEATS.find((b) => b.id === 'result').detail;
  assert.ok(!noFlipLine.includes('dominant factor'));
});

test('transcript duration covers every beat plus the commit delay', () => {
  assert.ok(transcriptDurationMs(BEATS.length) > BEATS.length * BEAT_INTERVAL_MS);
});
