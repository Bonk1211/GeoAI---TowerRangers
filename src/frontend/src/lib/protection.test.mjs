import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MITIGATIONS,
  applyProtection,
  mitigationById,
  mitigationsFor,
  protectionDelta,
  formatMyr,
} from './protection.ts';
import { AHP_WEIGHTS } from './scorer.ts';

const FLOOD_TOWER = {
  tower_id: 'MY_TEST_FLOOD',
  lon: 101.6,
  lat: 3.07,
  radio: 'UNKNOWN',
  risk: 0.91,
  risk_lo: 0.86,
  risk_hi: 0.95,
  decision: 'maintain',
  borderline: false,
  dominant_factor: 'flood',
  urgency_days: 11,
  attribution: { flood: 0.78, power: 0.12, terrain: 0.07, vegetation: 0.03 },
  weather: null,
  territory: 'Selangor',
  novelty: null,
  condition: null,
};

const POWER_TOWER = {
  ...FLOOD_TOWER,
  tower_id: 'MY_TEST_POWER',
  dominant_factor: 'power',
  attribution: { flood: 0.1, power: 0.66, terrain: 0.14, vegetation: 0.1 },
};

test('every mitigation leaves residual exposure — none makes a site immune', () => {
  for (const m of MITIGATIONS) {
    assert.ok(m.residualShare > 0, `${m.id} zeroes its factor`);
    assert.ok(m.residualShare < 1, `${m.id} does nothing`);
    assert.ok(m.residualNote.length > 0, `${m.id} states no residual`);
  }
});

test('menu is ordered by the tower own attribution, not catalogue order', () => {
  const flood = mitigationsFor(FLOOD_TOWER);
  const power = mitigationsFor(POWER_TOWER);
  assert.equal(flood[0].factor, 'flood');
  assert.equal(power[0].factor, 'power');
  // The point of the ordering: two towers must not get the same menu.
  assert.notEqual(flood[0].id, power[0].id);
});

test('a factor the tower has no exposure to is not offered', () => {
  const noVeg = { attribution: { flood: 0.9, power: 0.1 } };
  const offered = mitigationsFor(noVeg);
  assert.ok(offered.every((m) => m.factor !== 'vegetation'));
  assert.ok(offered.every((m) => m.factor !== 'terrain'));
});

test('risk falls, and falls because the input changed', () => {
  const m = mitigationById('flood_plinth_barrier');
  const delta = protectionDelta(FLOOD_TOWER, m, AHP_WEIGHTS);
  assert.ok(delta.riskAfter < delta.riskBefore, 'risk did not fall');
  assert.ok(delta.riskChange < 0);
  // The flood share must genuinely be smaller — this is the input change the
  // risk drop is derived from, not a decrement applied to the risk itself.
  assert.ok(delta.sharesAfter.flood < delta.sharesBefore.flood);
});

test('risk is recomputed, never decremented by a fixed amount', () => {
  // Two towers with the same mitigation but different exposure profiles must
  // not move by the same amount. A constant delta would be the signature of a
  // decrement rather than a re-score.
  const m = mitigationById('flood_plinth_barrier');
  const a = protectionDelta(FLOOD_TOWER, m, AHP_WEIGHTS);
  const b = protectionDelta(
    { attribution: { flood: 0.3, power: 0.4, terrain: 0.2, vegetation: 0.1 } },
    m,
    AHP_WEIGHTS,
  );
  assert.notEqual(a.riskChange.toFixed(4), b.riskChange.toFixed(4));
});

test('every offered mitigation moves the score — none is inert', () => {
  // REGRESSION. `scorer.ts::FACTOR_KEYS` is the legacy index factor set
  // (flood/power/terrain/EQUIPMENT) while the served model carries
  // flood/power/terrain/VEGETATION. Keying the arithmetic off FACTOR_KEYS
  // dropped `vegetation` silently, so a vegetation mitigation reduced a share
  // nothing read: measured on the live national population, a
  // vegetation-dominant tower moved 0.943 -> 0.943, delta exactly 0.0000,
  // while every other option on the SAME tower moved it. That is the top
  // option on that tower doing visibly nothing.
  const vegDominant = {
    risk: 0.94,
    attribution: { flood: 0.35, terrain: 0.21, vegetation: 0.37, power: 0.07 },
  };
  for (const m of mitigationsFor(vegDominant)) {
    const d = protectionDelta(vegDominant, m, AHP_WEIGHTS);
    assert.ok(
      d.riskAfter < d.riskBefore,
      `${m.id} left the score unchanged (${d.riskBefore} -> ${d.riskAfter})`,
    );
  }
});

test('a factor with no slider weight still contributes', () => {
  // `vegetation` has no entry in AHP_WEIGHTS. Falling back to 0 rather than to
  // a default would be the same silent-drop bug in a different place.
  const onlyVeg = { risk: 0.9, attribution: { vegetation: 1 } };
  const m = mitigationById('vegetation_clearance_program');
  const d = protectionDelta(onlyVeg, m, AHP_WEIGHTS);
  assert.ok(d.riskAfter < d.riskBefore);
});

test('attribution still sums to 1 after the works', () => {
  for (const m of MITIGATIONS.filter((x) => x.factor === 'flood')) {
    const delta = protectionDelta(FLOOD_TOWER, m, AHP_WEIGHTS);
    const total = Object.values(delta.sharesAfter).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `${m.id} left shares summing to ${total}`);
  }
});

test('removing the dominant exposure can hand dominance to another factor', () => {
  const m = mitigationById('flood_plinth_barrier');
  const delta = protectionDelta(FLOOD_TOWER, m, AHP_WEIGHTS);
  assert.equal(delta.dominantBefore, 'flood');
  // 0.78 * 0.55 = 0.429, still the largest here, so flood holds — the point is
  // that the computation is capable of flipping it, verified below.
  const heavy = protectionDelta(
    { attribution: { flood: 0.4, power: 0.38, terrain: 0.12, vegetation: 0.1 } },
    m,
    AHP_WEIGHTS,
  );
  assert.equal(heavy.dominantBefore, 'flood');
  assert.equal(heavy.dominantAfter, 'power');
});

test('a weights change moves the modelled result — the two controls compose', () => {
  const m = mitigationById('flood_plinth_barrier');
  const base = protectionDelta(FLOOD_TOWER, m, AHP_WEIGHTS);
  const floodHeavy = protectionDelta(FLOOD_TOWER, m, {
    ...AHP_WEIGHTS,
    flood: 0.6,
  });
  assert.notEqual(base.riskAfter.toFixed(4), floodHeavy.riskAfter.toFixed(4));
});

test('applyProtection returns the same array identity when nothing is protected', () => {
  const towers = [FLOOD_TOWER, POWER_TOWER];
  assert.equal(applyProtection(towers, {}, AHP_WEIGHTS), towers);
});

test('applyProtection touches only the protected tower', () => {
  const towers = [FLOOD_TOWER, POWER_TOWER];
  const out = applyProtection(towers, { MY_TEST_FLOOD: 'flood_plinth_barrier' }, AHP_WEIGHTS);
  assert.equal(out[1], POWER_TOWER, 'unprotected tower was rebuilt');
  assert.notEqual(out[0], FLOOD_TOWER);
  assert.ok(out[0].risk < FLOOD_TOWER.risk);
});

test('the protected record keeps both endpoints on the served scale', () => {
  const out = applyProtection(
    [FLOOD_TOWER],
    { MY_TEST_FLOOD: 'flood_plinth_barrier' },
    AHP_WEIGHTS,
  );
  const p = out[0].protection;
  assert.ok(p, 'no protection record written');
  // riskBefore must be the tower's OWN served risk, so the panel opens
  // agreeing with the map rather than quoting an index number nothing else
  // displays.
  assert.equal(p.riskBefore, 0.91);
  assert.equal(out[0].risk, p.riskAfter);
  assert.ok(p.riskAfter < p.riskBefore);
});

test('a served maintain-band tower can be protected down into a lower band', () => {
  // The headline demo beat. It only works because the before/after pair is
  // anchored to the served risk — on the raw index this tower reads 0.398 and
  // opens in `ok`, so there is no band to move out of.
  const out = applyProtection(
    [FLOOD_TOWER],
    { MY_TEST_FLOOD: 'flood_plinth_barrier' },
    AHP_WEIGHTS,
  );
  assert.equal(FLOOD_TOWER.decision, 'maintain');
  assert.notEqual(out[0].decision, 'maintain');
});

test('the uncertainty band collapses rather than carrying a stale interval', () => {
  const out = applyProtection(
    [FLOOD_TOWER],
    { MY_TEST_FLOOD: 'flood_plinth_barrier' },
    AHP_WEIGHTS,
  );
  assert.equal(out[0].risk_lo, out[0].risk);
  assert.equal(out[0].risk_hi, out[0].risk);
});

test('an unknown mitigation id leaves the tower untouched', () => {
  const towers = [FLOOD_TOWER];
  const out = applyProtection(towers, { MY_TEST_FLOOD: 'no_such_thing' }, AHP_WEIGHTS);
  assert.equal(out[0], FLOOD_TOWER);
});

test('formatMyr renders a grouped capital figure', () => {
  assert.equal(formatMyr(42000), 'RM 42,000');
});
