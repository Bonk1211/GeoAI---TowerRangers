import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BEATS,
  TOTAL_DURATION_MS,
  beatsUpTo,
  phaseAt,
  beatById,
} from './simulationTimeline.ts';

test('beats are authored in non-decreasing atMs order', () => {
  for (let i = 1; i < BEATS.length; i++) {
    assert.ok(BEATS[i].atMs >= BEATS[i - 1].atMs, `beat ${BEATS[i].id} is out of order`);
  }
});

test('every beat id is unique', () => {
  const ids = BEATS.map((b) => b.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('beatsUpTo is monotone: a later ms never returns fewer beats', () => {
  const at10 = beatsUpTo(10_000).length;
  const at50 = beatsUpTo(50_000).length;
  const at200 = beatsUpTo(200_000).length;
  assert.ok(at50 >= at10);
  assert.ok(at200 >= at50);
});

test('beatsUpTo never re-fires: the prefix at ms is always a prefix of the prefix at ms+1', () => {
  const earlier = beatsUpTo(30_000).map((b) => b.id);
  const later = beatsUpTo(30_001).map((b) => b.id);
  assert.deepEqual(later.slice(0, earlier.length), earlier);
});

test('beatsUpTo(0) returns exactly the beats authored at atMs 0', () => {
  const zero = beatsUpTo(0);
  assert.ok(zero.length >= 1);
  assert.ok(zero.every((b) => b.atMs === 0));
});

test('beatsUpTo before the first beat returns nothing', () => {
  assert.deepEqual(beatsUpTo(-1), []);
});

test('beatsUpTo at the total duration returns every beat', () => {
  assert.equal(beatsUpTo(TOTAL_DURATION_MS).length, BEATS.length);
});

test('phaseAt covers every phase in order: pre, impact, response, recovery', () => {
  const preBeat = BEATS.find((b) => b.phase === 'pre');
  const impactBeat = BEATS.find((b) => b.phase === 'impact');
  const responseBeat = BEATS.find((b) => b.phase === 'response');
  const recoveryBeat = BEATS.find((b) => b.phase === 'recovery');
  assert.equal(phaseAt(preBeat.atMs), 'pre');
  assert.equal(phaseAt(impactBeat.atMs), 'impact');
  assert.equal(phaseAt(responseBeat.atMs), 'response');
  assert.equal(phaseAt(recoveryBeat.atMs), 'recovery');
});

test('phaseAt boundary is inclusive on the lower edge, exclusive on the upper', () => {
  const impactStart = BEATS.find((b) => b.phase === 'impact').atMs;
  // One ms before the boundary is still the previous phase...
  assert.equal(phaseAt(impactStart - 1), 'pre');
  // ...and exactly at the boundary it has already switched.
  assert.equal(phaseAt(impactStart), 'impact');
});

test('phaseAt at the very end of the timeline is recovery', () => {
  assert.equal(phaseAt(TOTAL_DURATION_MS), 'recovery');
});

test('phaseAt before the first beat degrades to pre rather than throwing', () => {
  assert.equal(phaseAt(-1000), 'pre');
});

test('beatById resolves a known id and returns undefined for an unknown one', () => {
  assert.equal(beatById('forecast')?.id, 'forecast');
  assert.equal(beatById('does-not-exist'), undefined);
});

test('every beat carries an evidence classification consumed by the console badge', () => {
  for (const beat of BEATS) {
    assert.ok(['real', 'mechanism', 'illustrative'].includes(beat.evidence), beat.id);
  }
});

test('every real-evidence beat is a backend beat or renders a value the earlier backend call produced', () => {
  // Per spec §6, 'real' does not mean "this beat itself calls the network" —
  // `optimize` and `generator-dispatch` are the only two live calls (spec
  // §7). A review round found (and fixed) every 'scripted' beat that had
  // been marked 'real' without actually rendering a live-call value — see
  // the P6 build-log entry — so today's table has no such beat, but this
  // test still guards the shape: a FUTURE 'scripted' beat marked 'real'
  // must have a backend beat earlier in the table to have produced the
  // value it renders (the allowlist below documents that exception's shape
  // without currently containing anything, since none is needed today).
  const REAL_WITHOUT_OWN_CALL = new Set();
  let sawBackendBeat = false;
  for (const beat of BEATS) {
    if (beat.kind === 'backend') sawBackendBeat = true;
    if (beat.evidence === 'real' && beat.kind !== 'backend') {
      assert.ok(
        REAL_WITHOUT_OWN_CALL.has(beat.id),
        `${beat.id} claims real evidence without its own backend call and is not on the allowed list`,
      );
      assert.ok(sawBackendBeat, `${beat.id} claims real evidence before any backend beat has run`);
    }
  }
});

test('every beat carries a plain-language headline a judge can read', () => {
  // The whole point of `headline` (2026-09-20, operator review: the console
  // was "too difficult to understand when showing to judges"). These are
  // the specific things that made the transcript unreadable at a glance —
  // pinned so a future beat cannot quietly reintroduce them into the line
  // a first-time viewer actually reads.
  const FORBIDDEN = [
    [/\bPOST\b|\bGET\b|\//, 'an API path or HTTP verb'],
    [/MY_[A-Z0-9]/, 'a raw tower id'],
    [/\bGFS\b|\bGloFAS\b|\bNMC\b|\bMOCN\b|\bPRIME\b|\bPPS\b|\bSESB\b|\bCOW\b|\bBTS\b|\bTX\b/, 'an unexpanded acronym'],
  ];
  for (const beat of BEATS) {
    assert.ok(beat.headline, `${beat.id} has no headline`);
    assert.ok(
      beat.headline.length <= 60,
      `${beat.id} headline is ${beat.headline.length} chars — too long to scan at the rendered width: ${beat.headline}`,
    );
    for (const [pattern, what] of FORBIDDEN) {
      assert.ok(
        !pattern.test(beat.headline),
        `${beat.id} headline contains ${what}, which a judge cannot decode: ${beat.headline}`,
      );
    }
  }
});

test('a headline never claims a number its detail line does not also carry', () => {
  // Both strings resolve through the same `substitutionsFor` lookup, so a
  // placeholder in the headline must have a matching one in the console
  // line — otherwise the headline would render a raw `<n>` forever while
  // the detail below it showed the real figure.
  for (const beat of BEATS) {
    for (const token of ['<n>', '<k>', '<tower_id>', '<crew_id>']) {
      if (beat.headline.includes(token)) {
        assert.ok(
          beat.console.includes(token),
          `${beat.id} headline uses ${token} but its console line does not, so the two can disagree`,
        );
      }
    }
  }
});
