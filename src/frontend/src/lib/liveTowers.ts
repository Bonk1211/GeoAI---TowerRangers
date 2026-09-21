import type { Tower } from '../api/types';
import { TOWERS, isScored } from '../fixtures/towers';
import { FACTOR_PROBABILITIES } from '../fixtures/factorProbabilities';
import { FACTOR_KEYS, decisionForRisk, noisyOrRisk, normalizeWeights, type WeightVector } from './scorer';

function liveAttribution(probs: Record<string, number>, weights: WeightVector): Record<string, number> {
  // Leave-one-out style contribution: each factor's pᵢ·wᵢ share of the sum.
  const contributions = FACTOR_KEYS.map((k) => Math.max(0, (probs[k] ?? 0) * (weights[k] ?? 0)));
  const sum = contributions.reduce((a, b) => a + b, 0) || 1;
  const result: Record<string, number> = {};
  FACTOR_KEYS.forEach((k, i) => {
    result[k] = Number((contributions[i] / sum).toFixed(3));
  });
  return result;
}

// OFFLINE PATH ONLY (step 7) — when POST /score is unreachable, re-derives
// risk/decision/borderline/attribution from slider weights against the fixed
// fixture probability table so the map + drawer still recolour, clearly
// offline-banner-flagged, instead of freezing.
export function liveScoredTowers(weights: WeightVector): Tower[] {
  const normalized = normalizeWeights(weights);
  return TOWERS.map((t) => {
    if (!isScored(t)) return t;
    const probs = FACTOR_PROBABILITIES[t.tower_id];
    if (!probs) return t;
    const risk = noisyOrRisk(probs, normalized);
    const decision = decisionForRisk(risk);
    const borderline = Math.abs(risk - 0.7) < 0.03 || Math.abs(risk - 0.4) < 0.03;
    const attribution = liveAttribution(probs, normalized);
    const dominant_factor = Object.entries(attribution).sort((a, b) => b[1] - a[1])[0][0];
    return {
      ...t,
      risk: Number(risk.toFixed(2)),
      decision,
      borderline,
      attribution,
      dominant_factor,
    };
  });
}

// OFFLINE PATH ONLY (step 7) — same fallback as liveScoredTowers, single tower.
export function liveTower(tower_id: string, weights: WeightVector): Tower | undefined {
  const t = TOWERS.find((tw) => tw.tower_id === tower_id);
  if (!t || !isScored(t)) return t;
  const probs = FACTOR_PROBABILITIES[tower_id];
  if (!probs) return t;
  const normalized = normalizeWeights(weights);
  const risk = noisyOrRisk(probs, normalized);
  const decision = decisionForRisk(risk);
  const borderline = Math.abs(risk - 0.7) < 0.03 || Math.abs(risk - 0.4) < 0.03;
  const attribution = liveAttribution(probs, normalized);
  const dominant_factor = Object.entries(attribution).sort((a, b) => b[1] - a[1])[0][0];
  return { ...t, risk: Number(risk.toFixed(2)), decision, borderline, attribution, dominant_factor };
}
