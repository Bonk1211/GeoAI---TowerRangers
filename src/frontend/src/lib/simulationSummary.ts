import type { ScheduleRun } from '../api/types';

/**
 * Pure computation for the Disaster Simulation's closing summary.
 * `docs/Disaster_Simulation_Spec.md` §6 "Summary panel at end", §1's
 * "Optimize scope" decision.
 *
 * Not a victory screen — a comparison. What the risk index flagged in
 * advance (the national `optimize` run's Sabah-territory entries) versus
 * what the scenario actually hit (the scripted `downTowerIds` set). If the
 * two diverge, this module says so rather than only reporting overlap —
 * "a demo that can only succeed is not evidence of anything" (spec §6).
 */

export interface FlaggedVsHitSummary {
  /** Sabah tower_ids the national optimize run scheduled maintenance for. */
  flaggedTowerIds: string[];
  /** Sabah tower_ids the scenario selected as down. */
  hitTowerIds: string[];
  /** Towers both flagged AND hit — the system dispatched to sites the
   *  flood then actually struck. */
  bothFlaggedAndHit: string[];
  /** Hit but NOT flagged — the flood hit a site the standing risk index
   *  had not already prioritised. Shown, not hidden, per spec §6. */
  hitButNotFlagged: string[];
  /** Flagged but not (in this scenario) hit — routine maintenance work
   *  elsewhere in Sabah, unrelated to this flood. Contextual, not a gap. */
  flaggedButNotHit: string[];
  /** Of the national optimize run's total entries, how many were in Sabah
   *  at all — the "of N national orders, k were in the districts the
   *  flood hit" framing spec §1 calls for. */
  nationalOrderCount: number;
  sabahOrderCount: number;
}

/**
 * Compares the national optimize run's Sabah-territory work orders against
 * the scenario's down-tower set. `sabahTowerIds` scopes which of the run's
 * entries count as "in Sabah" — the run itself carries no territory field
 * per entry, only a `tower_id`, so the caller supplies the live Sabah
 * population's id set to filter by.
 */
export function computeFlaggedVsHit(
  optimizeRun: ScheduleRun | null,
  downTowerIds: Set<string>,
  sabahTowerIds: Set<string>,
): FlaggedVsHitSummary {
  const nationalOrderCount = optimizeRun?.entries.length ?? 0;
  const sabahEntries = optimizeRun?.entries.filter((e) => sabahTowerIds.has(e.tower_id)) ?? [];
  const flaggedTowerIds = [...new Set(sabahEntries.map((e) => e.tower_id))];
  const hitTowerIds = [...downTowerIds];

  const flaggedSet = new Set(flaggedTowerIds);
  const hitSet = new Set(hitTowerIds);

  return {
    flaggedTowerIds,
    hitTowerIds,
    bothFlaggedAndHit: hitTowerIds.filter((id) => flaggedSet.has(id)),
    hitButNotFlagged: hitTowerIds.filter((id) => !flaggedSet.has(id)),
    flaggedButNotHit: flaggedTowerIds.filter((id) => !hitSet.has(id)),
    nationalOrderCount,
    sabahOrderCount: sabahEntries.length,
  };
}

/**
 * Parses a beat's `clockLabel` (e.g. "T+4h", "T-0", "T+12h") into signed
 * hours relative to impact. Returns `null` for a label this format can't
 * parse — the caller shows nothing rather than a wrong number, since every
 * clockLabel in `lib/simulationTimeline.ts` is hand-authored prose, not a
 * guaranteed-parseable machine format.
 */
export function parseClockLabelHours(label: string): number | null {
  // The 'h' suffix is optional: lib/simulationTimeline.ts writes the impact
  // beats' label as the literal "T-0", not "T-0h" — both must parse to the
  // same zero.
  const match = /^T([+-])(\d+)h?$/.exec(label);
  if (!match) return null;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * Number(match[2]);
}

/**
 * Time-to-response in scenario hours: the difference between the
 * `tower-down` beat's clockLabel ("T-0") and the `generator-dispatch`
 * beat's ("T+4h"). Reads the AUTHORED scenario clock labels directly
 * rather than deriving a ms-to-hour conversion rate — the beat table's
 * `atMs` spacing is authored for readability (spec §6), not at a constant
 * hours-per-ms rate, so no such rate exists to derive honestly. Returns
 * `null` if either label fails to parse, rather than a wrong number.
 */
export function timeToResponseHours(towerDownLabel: string, dispatchLabel: string): number | null {
  const downHours = parseClockLabelHours(towerDownLabel);
  const dispatchHours = parseClockLabelHours(dispatchLabel);
  if (downHours === null || dispatchHours === null) return null;
  return dispatchHours - downHours;
}
