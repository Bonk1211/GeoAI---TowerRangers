import type { Decision, Tower } from '../api/types.ts';
import { normalizeWeights, type WeightVector } from './scorer.ts';

/**
 * MODELLED SITE PROTECTION — demo surface, frontend only.
 *
 * WHAT THIS IS, AND THE ONE THING IT IS NOT.
 *
 * The pitch problem this answers: dispatching a crew does not move a tower's
 * risk, and it must not. `risk` is standing maintenance need read off the
 * GROUND a site sits on — height above drainage, slope, distance to grid,
 * vegetation. A crew visits, fixes, leaves; the ground is where it was, so the
 * score is where it was. A score that fell on dispatch would be an activity
 * log wearing a risk index's clothes, and it would re-open §0.6 by implying
 * the number was a failure probability we averted.
 *
 * MITIGATION is the other thing, and it is real. A plinth, a barrier, a
 * regrade, a genset CHANGE THE SITE. After one, the tower genuinely is less
 * exposed, and a score that did not move would be the wrong answer.
 *
 * So the rule here is exact: this module never decrements a risk. It changes
 * an INPUT and re-runs the model. `applyProtection` rewrites factor shares and
 * hands them to the same `noisyOrRisk` the offline scorer uses; the risk that
 * comes out is computed, not assigned. That distinction is the whole reason
 * this is defensible on a stage, and `protection.test.mjs` pins it.
 *
 * WHAT IS ASSUMED, STATED PLAINLY.
 *
 * Each mitigation's `residualShare` — what fraction of the factor's exposure
 * survives the works — is an ENGINEERING ASSUMPTION, not a measurement. No
 * dataset in this project observes the post-mitigation state of a Malaysian
 * tower compound, so there is nothing to fit these against. They are ordered
 * plausibly (a full plinth-and-barrier beats a drainage regrade) and every
 * surface that renders them says `ILLUSTRATIVE`. Do not present these numbers
 * as measured effect sizes.
 *
 * WHY THE FACTOR SHARE AND NOT THE RAW FEATURE.
 *
 * The honest version of "raise the plinth 1.5 m" is to raise `hand_m` and
 * re-run the membership curves. The frontend cannot: `lib/scorer.ts` consumes
 * factor PROBABILITIES, and the raw feature table lives on the backend behind
 * `POST /score`, which takes AHP weight overrides and no feature overrides. So
 * the mitigation is expressed one level downstream — as a reduction in the
 * factor's own exposure share — and the re-score below it is genuine. Widening
 * `/score` to accept feature overrides is the upgrade path; until then the
 * `equivalent` string on each mitigation states the physical change the share
 * reduction stands in for, so nobody reads the share as the claim itself.
 *
 * SCALE SEAM — how two estimators are reconciled, and why it is done this way.
 *
 * `/towers` serves the SUPERVISED model (a calibrated probability); the
 * arithmetic here is the NOISY-OR INDEX. They disagree in level — measured on
 * a flood-dominant national tower, served 0.91 against index 0.398 — so
 * reporting the raw index pair would drop a `maintain` tower into `ok` the
 * moment the panel opened, before any mitigation was picked, and the
 * protection surface would visibly contradict the map behind it.
 *
 * The index therefore supplies the RATIO a mitigation causes, and that ratio
 * is applied to the served risk the record arrived with. `riskBefore` is the
 * tower's own served risk by construction, so before/after are on ONE scale
 * and are directly comparable with every unprotected neighbour on the map.
 * The re-score is still genuine — what the index decides is how much exposure
 * the works remove; what it does not decide is where the tower started.
 */

/**
 * Which factor's exposure a mitigation acts on.
 *
 * Written out rather than derived from `scorer.ts`'s `FactorKey`, which is the
 * legacy INDEX factor set — it carries `equipment` (dropped from the served
 * model: its one feature is `UNKNOWN` for 96% of towers) and lacks
 * `vegetation` (added by it). Deriving from it once produced a vegetation
 * mitigation that reduced a share nothing read; see `sharesToProbabilities`.
 */
export type ProtectionFactor = 'flood' | 'power' | 'terrain' | 'vegetation';

export interface Mitigation {
  id: string;
  label: string;
  /** The factor whose share this reduces. */
  factor: ProtectionFactor;
  /** Crew capability that would carry out the works — matches config/actions.yaml vocabulary. */
  crewType: 'civil' | 'power' | 'rf' | 'electrical';
  /** On-site hours. Illustrative, same standing as residualShare. */
  hours: number;
  /** Capital cost in MYR. Illustrative. */
  costMyr: number;
  /**
   * Fraction of the factor's exposure that SURVIVES the works, in [0, 1].
   * 0.55 means "this removes 45% of the flood exposure". Never 0 — no
   * mitigation makes a site immune, and a zero here would let the map paint a
   * protected tower as having no exposure at all.
   */
  residualShare: number;
  /** The physical change the share reduction stands in for. Rendered verbatim. */
  equivalent: string;
  /**
   * What the works do NOT cover. Rendered verbatim on the result panel and
   * required: a mitigation with no stated limit invites "protect everything
   * and the map goes green", which is the reading this whole surface exists to
   * refuse.
   */
  residualNote: string;
}

/**
 * The catalogue. Keyed by factor so the panel can offer a tower the
 * mitigations that address ITS dominant exposure — two towers with different
 * dominant factors get different menus, which is what makes this read as
 * model-driven rather than as one hardcoded happy path.
 */
export const MITIGATIONS: Mitigation[] = [
  {
    id: 'flood_plinth_barrier',
    label: 'Equipment plinth + perimeter barrier',
    factor: 'flood',
    crewType: 'civil',
    hours: 8,
    costMyr: 42_000,
    residualShare: 0.55,
    equivalent: 'Raises equipment above local drainage by ~1.5 m',
    residualNote: 'Rated to the plinth height. Above it, exposure returns in full.',
  },
  {
    id: 'flood_drainage_regrade',
    label: 'Compound drainage regrade',
    factor: 'flood',
    crewType: 'civil',
    hours: 6,
    costMyr: 18_000,
    residualShare: 0.78,
    equivalent: 'Cuts standing-water dwell time in the compound',
    residualNote: 'Moves water off the pad faster. Does not raise the site.',
  },
  {
    id: 'power_backup_genset',
    label: 'Backup genset + transfer switch',
    factor: 'power',
    crewType: 'power',
    hours: 12,
    costMyr: 65_000,
    residualShare: 0.45,
    equivalent: 'Removes dependence on a single grid feed',
    residualNote: 'Runtime is limited by fuel. A multi-day outage still needs a refuel run.',
  },
  {
    id: 'power_battery_bank',
    label: 'Extended battery bank',
    factor: 'power',
    crewType: 'electrical',
    hours: 6,
    costMyr: 28_000,
    residualShare: 0.7,
    equivalent: 'Extends hold-up through short grid interruptions',
    residualNote: 'Hours, not days. Does not cover a sustained outage.',
  },
  {
    id: 'terrain_slope_reinforcement',
    label: 'Slope reinforcement + retaining works',
    factor: 'terrain',
    crewType: 'civil',
    hours: 16,
    costMyr: 88_000,
    residualShare: 0.5,
    equivalent: 'Stabilises the cut slope supporting the compound',
    residualNote: 'Addresses the engineered slope only, not regional ground movement.',
  },
  {
    id: 'vegetation_clearance_program',
    label: 'Vegetation clearance + regrowth control',
    factor: 'vegetation',
    crewType: 'civil',
    hours: 4,
    costMyr: 9_000,
    residualShare: 0.6,
    equivalent: 'Clears the 1 m perimeter and treats regrowth',
    residualNote: 'Regrowth returns. This is a recurring cost, not a one-off.',
  },
];

export function mitigationById(id: string): Mitigation | undefined {
  return MITIGATIONS.find((m) => m.id === id);
}

/**
 * Mitigations offered for a tower, most relevant first.
 *
 * Ordered by that tower's OWN attribution: the factor carrying the largest
 * share leads, and a factor the tower has no exposure to is dropped entirely.
 * A flood-dominant tower therefore opens on flood works; a power-dominant one
 * opens on power works. Offering the whole catalogue in a fixed order would
 * make every tower look identical and invite exactly the "one scripted path"
 * reading this ordering exists to defeat.
 */
export function mitigationsFor(tower: Pick<Tower, 'attribution'>): Mitigation[] {
  const share = (f: ProtectionFactor) => tower.attribution[f] ?? 0;
  return MITIGATIONS.filter((m) => share(m.factor) > 0).sort((a, b) => {
    const diff = share(b.factor) - share(a.factor);
    if (diff !== 0) return diff;
    // Stable within a factor: the bigger intervention first, so the menu reads
    // strongest-to-lightest rather than in catalogue order.
    return a.residualShare - b.residualShare;
  });
}

/** Band cuts. Mirrors `decisionForRisk` in scorer.ts — kept in step deliberately. */
function decisionFor(risk: number): Decision {
  if (risk >= 0.7) return 'maintain';
  if (risk >= 0.4) return 'watch';
  return 'ok';
}

export interface ProtectionDelta {
  /** Attribution BEFORE, as it arrived on the record. */
  sharesBefore: Record<string, number>;
  /** Attribution AFTER, renormalised to sum to 1. */
  sharesAfter: Record<string, number>;
  /**
   * The tower's risk as the record carried it — the served number, so this
   * agrees with the map and every other surface. See the scale seam in the
   * module header.
   */
  riskBefore: number;
  /** The same quantity after the works, moved by the re-scored index ratio. */
  riskAfter: number;
  decisionBefore: Decision;
  decisionAfter: Decision;
  dominantBefore: string;
  dominantAfter: string;
  /** Always <= 0 in practice; reported signed so a no-op reads as 0, not as a win. */
  riskChange: number;
}

function dominantOf(shares: Record<string, number>): string {
  let best = '';
  let bestShare = -1;
  // Object key order is insertion order for string keys, which is stable
  // across the map/filter chain above — but ties are broken by first-seen
  // rather than left to chance, so the same input always names the same factor.
  for (const [factor, value] of Object.entries(shares)) {
    if (value > bestShare) {
      best = factor;
      bestShare = value;
    }
  }
  return best;
}

/**
 * Convert factor shares into the probability vector `noisyOrRisk` expects.
 *
 * Shares are a normalised attribution (they sum to 1); the noisy-OR wants a
 * per-factor exposure in [0, 1]. `scale` maps the share space onto that range,
 * and it is passed IN rather than derived from the vector — which is the whole
 * subtlety here, and got this wrong once.
 *
 * Deriving the scale from each vector's own maximum (`max(shares)`) looks
 * natural and is actively backwards: a flood-dominant tower whose flood share
 * is cut from 0.78 to 0.43 still has flood as its largest factor, so
 * self-scaling pushes it straight back to 1.0 while dividing every OTHER
 * factor by a smaller maximum — every share rises, and the modelled risk comes
 * out HIGHER after the mitigation than before it. Measured on the flood
 * fixture: 0.398 -> 0.431, i.e. protecting the site made it look worse.
 * `protection.test.mjs::risk falls, and falls because the input changed` is
 * the test that caught it and is the reason this argument exists.
 *
 * Both calls in `protectionDelta` therefore share ONE scale, taken from the
 * pre-mitigation vector. Under a fixed scale a reduced share is unambiguously
 * a reduced exposure, which is the only property this function has to
 * preserve.
 */
function sharesToProbabilities(
  shares: Record<string, number>,
  scale: number,
): Record<string, number> {
  const probabilities: Record<string, number> = {};
  // Iterate the SHARES, not `FACTOR_KEYS`, and this is not a stylistic choice.
  //
  // `scorer.ts` predates the served model and its `FACTOR_KEYS` is the old
  // index factor set — flood / power / terrain / EQUIPMENT. The model serves
  // flood / power / terrain / VEGETATION: equipment was dropped (its one
  // feature is `UNKNOWN` for 96% of towers and the booster never split on it)
  // and vegetation was added. Keying off `FACTOR_KEYS` therefore drops
  // `vegetation` silently, and a vegetation mitigation would reduce a share
  // nothing downstream reads.
  //
  // That shipped and was caught against live data: on the national population
  // a vegetation-dominant tower moved 0.943 -> 0.943, delta EXACTLY 0.0000,
  // while every other mitigation on the same tower moved it — the top option
  // on a vegetation-dominant site did nothing at all, which is the single most
  // visible way this surface could fail in front of an audience. Reading the
  // tower's own attribution keys instead makes this total over whatever factor
  // set the backend is serving, including any added later.
  for (const [key, value] of Object.entries(shares)) {
    probabilities[key] = scale > 0 ? Math.min(1, value / scale) : 0;
  }
  return probabilities;
}

/**
 * Noisy-OR over whatever factors the record actually carries.
 *
 * `scorer.ts::noisyOrRisk` is the same formula over the fixed legacy
 * `FACTOR_KEYS`, and it is deliberately not reused here for the reason
 * `sharesToProbabilities` records above: it would silently drop `vegetation`.
 * A factor with no slider weight falls back to `DEFAULT_FACTOR_WEIGHT` rather
 * than to 0 — weighting it at zero would be the same silent-drop bug wearing a
 * different hat, and would make a vegetation mitigation inert again.
 */
const DEFAULT_FACTOR_WEIGHT = 0.2;

function noisyOr(
  probabilities: Record<string, number>,
  weights: Record<string, number>,
): number {
  let product = 1;
  for (const [key, p] of Object.entries(probabilities)) {
    const w = weights[key] ?? DEFAULT_FACTOR_WEIGHT;
    product *= 1 - Math.min(1, Math.max(0, p) * w);
  }
  return 1 - product;
}

/**
 * Re-score one tower under one mitigation.
 *
 * The mitigation multiplies its factor's share by `residualShare`; the
 * remaining shares are renormalised so attribution still sums to 1; the whole
 * vector is re-run through the same noisy-OR the offline scorer uses. Nothing
 * here subtracts from a risk.
 *
 * `weights` are the live slider weights, so a protection preview taken with
 * the flood slider pushed up reflects that — the two controls compose instead
 * of contradicting each other.
 */
export function protectionDelta(
  tower: Pick<Tower, 'attribution'> & { risk?: number },
  mitigation: Mitigation,
  weights: WeightVector,
): ProtectionDelta {
  const sharesBefore = { ...tower.attribution };

  const reduced: Record<string, number> = {};
  for (const [factor, value] of Object.entries(sharesBefore)) {
    reduced[factor] = factor === mitigation.factor ? value * mitigation.residualShare : value;
  }

  const total = Object.values(reduced).reduce((a, b) => a + b, 0);
  const sharesAfter: Record<string, number> = {};
  for (const [factor, value] of Object.entries(reduced)) {
    // A vector that summed to zero cannot be renormalised; fall back to the
    // reduced values rather than dividing by zero and painting NaN.
    sharesAfter[factor] = total > 0 ? value / total : value;
  }

  const normalized = normalizeWeights(weights);
  // One scale, taken from the site as it stands, used for both endpoints. See
  // sharesToProbabilities — a per-vector scale inverts the whole result.
  const scale = Math.max(...Object.values(sharesBefore), 0);
  // The RAW reduced vector drives the risk, not the renormalised one.
  // Renormalising restores the total to 1 by construction, so feeding that
  // back into the noisy-OR would hand it the same total exposure it started
  // with and the risk would barely move — the mitigation would be cosmetic.
  // Shares-after are for the attribution bars, where "share of what remains"
  // is the right reading; risk-after is computed from what actually survives.
  const indexBefore = noisyOr(sharesToProbabilities(sharesBefore, scale), normalized);
  const indexAfter = noisyOr(sharesToProbabilities(reduced, scale), normalized);

  // ANCHORED TO THE TOWER'S OWN SERVED RISK, and this is not cosmetic.
  //
  // `/towers` serves the supervised model; the arithmetic above is the
  // noisy-OR index. They disagree in LEVEL — measured on a flood-dominant
  // national tower, served 0.91 against index 0.398 — because they are
  // different estimators, not because either is wrong. Reporting the raw index
  // pair would put a `maintain`-band tower into `ok` the instant the panel
  // opened, before any mitigation was chosen, which reads as the protection
  // surface disagreeing with the map behind it.
  //
  // So the index supplies the RATIO the mitigation causes, and that ratio is
  // applied to the risk the record actually arrived with. `riskBefore` is then
  // the tower's served risk by construction — the panel opens agreeing with
  // the map — and `riskAfter` moves by the proportion the re-scored index
  // says the works remove. The re-score is still genuine; only its anchor is
  // borrowed, and the alternative anchors a demo to a number the rest of the
  // app never shows.
  //
  // Falls back to the raw index pair when no served risk is available (bare
  // attribution fixtures, and the pure-logic tests), which keeps the function
  // total rather than throwing on a partial record.
  const served = typeof tower.risk === 'number' ? tower.risk : null;
  const ratio = indexBefore > 0 ? indexAfter / indexBefore : 1;
  const riskBefore = served ?? indexBefore;
  const riskAfter = served !== null ? Math.min(1, served * ratio) : indexAfter;

  return {
    sharesBefore,
    sharesAfter,
    riskBefore,
    riskAfter,
    decisionBefore: decisionFor(riskBefore),
    decisionAfter: decisionFor(riskAfter),
    dominantBefore: dominantOf(sharesBefore),
    dominantAfter: dominantOf(sharesAfter),
    riskChange: riskAfter - riskBefore,
  };
}

/** What a committed mitigation leaves on a tower record. */
export interface AppliedProtection {
  mitigationId: string;
  /**
   * The risk this tower carried before the works — the served number, kept so
   * every surface can show the pair without re-deriving it and without
   * reaching for a scale the rest of the app never displays.
   */
  riskBefore: number;
  /** The modelled risk after. This is what `Tower.risk` is overwritten with. */
  riskAfter: number;
  decisionBefore: Decision;
}

/** Session-only record of which towers carry modelled protection. */
export type MitigationMap = Record<string, string>;

/**
 * Overlay committed mitigations onto a scored population.
 *
 * Returns a NEW array only when something is actually protected, so the
 * identity of the untouched array is preserved and the map's source is not
 * rebuilt on every render.
 *
 * The protected tower's `risk`, `decision`, `attribution` and `dominant_factor`
 * are replaced with the re-scored values, and `protection` carries the pair so
 * every surface can show before AND after. `risk_lo`/`risk_hi` collapse onto
 * the new risk: the served interval described the model's uncertainty about a
 * site that no longer matches this record, and carrying it forward would state
 * a confidence band this computation never produced.
 */
export function applyProtection(
  towers: Tower[],
  mitigations: MitigationMap,
  weights: WeightVector,
): Tower[] {
  const ids = Object.keys(mitigations);
  if (ids.length === 0) return towers;

  return towers.map((tower) => {
    const mitigationId = mitigations[tower.tower_id];
    if (!mitigationId) return tower;
    const mitigation = mitigationById(mitigationId);
    if (!mitigation) return tower;

    const delta = protectionDelta(tower, mitigation, weights);
    const protection: AppliedProtection = {
      mitigationId,
      riskBefore: delta.riskBefore,
      riskAfter: delta.riskAfter,
      decisionBefore: tower.decision,
    };

    return {
      ...tower,
      risk: delta.riskAfter,
      risk_lo: delta.riskAfter,
      risk_hi: delta.riskAfter,
      decision: delta.decisionAfter,
      dominant_factor: delta.dominantAfter,
      attribution: delta.sharesAfter,
      protection,
    };
  });
}

/** Format a MYR capital figure for display. Illustrative figures, plainly shown. */
export function formatMyr(value: number): string {
  return `RM ${value.toLocaleString('en-MY')}`;
}
