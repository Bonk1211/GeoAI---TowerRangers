// Side table of raw per-factor probabilities (pᵢ) that back the noisy-OR
// client-side scorer. Not part of the frozen Tower contract — the API layer
// would return risk/attribution directly, so this table only exists to make
// the weight sliders re-score locally without a backend.
import { TOWERS, isScored } from './towers';
import { AHP_WEIGHTS, FACTOR_KEYS, type FactorKey } from '../lib/scorer';

export type { FactorKey };

function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(7);

// Back out pᵢ from (risk, attribution share, AHP weight) so noisy-OR at
// baseline weights reproduces the fixture's stored risk. Approximation:
// pᵢ ≈ (share * risk) / weight, clamped to [0, 1].
function deriveProbabilities(risk: number, attribution: Record<string, number>): Record<FactorKey, number> {
  const result = {} as Record<FactorKey, number>;
  for (const key of FACTOR_KEYS) {
    const share = attribution[key] ?? 0;
    const w = AHP_WEIGHTS[key];
    const p = w > 0 ? (share * risk) / w : 0;
    result[key] = Math.min(1, Math.max(0, p));
  }
  return result;
}

export const FACTOR_PROBABILITIES: Record<string, Record<FactorKey, number>> = {};

for (const t of TOWERS) {
  if (!isScored(t)) continue;
  FACTOR_PROBABILITIES[t.tower_id] = deriveProbabilities(t.risk, t.attribution);
}

// Unscored towers get low-noise placeholder probabilities so the scorer
// never crashes if asked about them, though the UI never re-scores unscored towers.
export function probabilitiesFor(tower_id: string): Record<FactorKey, number> {
  return (
    FACTOR_PROBABILITIES[tower_id] ?? {
      flood: rand() * 0.1,
      power: rand() * 0.1,
      terrain: rand() * 0.1,
      equipment: rand() * 0.1,
    }
  );
}
