// OFFLINE PATH ONLY (step 7). When the API is reachable, weight changes are
// scored server-side via POST /score (step 6e) — the server is authoritative.
// This noisy-OR re-implementation exists solely so the demo keeps working,
// visibly offline-banner-flagged, when the backend is unreachable.
export const FACTOR_KEYS = ['flood', 'power', 'terrain', 'equipment'] as const;
export type FactorKey = (typeof FACTOR_KEYS)[number];

// AHP pairwise baseline — CR = 0.06, see Method page.
export const AHP_WEIGHTS: Record<FactorKey, number> = {
  flood: 0.31,
  power: 0.24,
  terrain: 0.22,
  equipment: 0.1,
};
// Note: lightning appears in the Method factor table but has no attribution
// share on this AOI (flash_density is 100% null over Sunway; fixture towers
// carry flood/power/terrain/equipment only) — omitted from the slider set to
// keep weights and attribution consistent.

export type WeightVector = Record<FactorKey, number>;

// noisy-OR: Risk = 1 − Π(1 − pᵢ·wᵢ)
export function noisyOrRisk(probabilities: Record<FactorKey, number>, weights: WeightVector): number {
  let product = 1;
  for (const key of FACTOR_KEYS) {
    const p = probabilities[key] ?? 0;
    const w = weights[key] ?? 0;
    product *= 1 - Math.min(1, p * w);
  }
  return 1 - product;
}

export function normalizeWeights(weights: WeightVector): WeightVector {
  const sum = FACTOR_KEYS.reduce((a, k) => a + weights[k], 0) || 1;
  const result = {} as WeightVector;
  for (const key of FACTOR_KEYS) {
    result[key] = weights[key] / sum;
  }
  return result;
}

export function decisionForRisk(risk: number): 'maintain' | 'watch' | 'ok' {
  if (risk >= 0.7) return 'maintain';
  if (risk >= 0.4) return 'watch';
  return 'ok';
}
