import { formatMyr, type Mitigation, type ProtectionDelta } from './protection.ts';

/**
 * The beat table for the protection console.
 *
 * WHY A CONSOLE RUNS BEFORE THE MAP MOVES.
 *
 * A tower that simply recolours on click shows a RESULT and hides the
 * MECHANISM, and the mechanism is the whole argument: an input changed, and
 * the model was re-run over it. The transcript makes that visible — a work
 * order is raised, a crew is assigned, works complete, the site is re-scored —
 * and only then does the map change. Audiences read the sequence as causal
 * because it is.
 *
 * EVIDENCE BADGES ARE LOAD-BEARING, NOT DECORATION.
 *
 * Same discipline as `simulationTimeline.ts` and for the same reason. Three
 * classes, and each line carries its own word on screen:
 *
 *   'mechanism'    — this really is how the system works. A work order really
 *                    is raised from the dominant factor; the re-score really
 *                    is the app's own noisy-OR over modified inputs.
 *   'illustrative' — nothing happened. No crew was dispatched, no works were
 *                    carried out, and the cost and duration are assumed
 *                    figures. Every beat describing field activity is this,
 *                    and the badge is the only thing standing between a demo
 *                    and a false claim.
 *
 * There is deliberately no 'real' class here. Not one beat in this sequence
 * touches the backend or observes anything, and offering the badge would
 * invite a future edit to reach for it.
 */
export type ProtectionEvidence = 'mechanism' | 'illustrative';

export interface ProtectionBeat {
  id: string;
  /** Plain language, no ids, no paths. What the audience reads. */
  headline: string;
  /** The technical line beneath it. May carry ids and figures. */
  detail: string;
  evidence: ProtectionEvidence;
}

/** Milliseconds between beats. Slow enough to read, short enough to hold a room. */
export const BEAT_INTERVAL_MS = 750;

/** How long after the last beat the map is allowed to change. */
export const MAP_COMMIT_DELAY_MS = 400;

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function risk(value: number): string {
  return value.toFixed(2);
}

/**
 * Build the transcript for one modelled mitigation.
 *
 * Every figure is passed in — nothing is invented here, and nothing is
 * recomputed. `delta` comes from `protectionDelta`, so the numbers on screen
 * and the numbers written onto the tower are the same numbers.
 */
export function protectionBeats(
  towerLabel: string,
  mitigation: Mitigation,
  delta: ProtectionDelta,
  crewId: string,
): ProtectionBeat[] {
  const beats: ProtectionBeat[] = [
    {
      id: 'work-order',
      headline: 'Work order raised',
      detail: `${mitigation.id} · ${mitigation.crewType} crew · ${mitigation.hours} h on site · ${formatMyr(mitigation.costMyr)}`,
      evidence: 'mechanism',
    },
    {
      id: 'crew-assigned',
      headline: 'Maintenance team assigned',
      detail: `${crewId} · ${mitigation.crewType} capability · ${towerLabel}`,
      evidence: 'illustrative',
    },
    {
      id: 'crew-enroute',
      headline: 'Team en route to site',
      detail: 'Modelled only — no crew has been dispatched and no schedule was changed.',
      evidence: 'illustrative',
    },
    {
      id: 'works-complete',
      headline: 'Protection works complete',
      detail: `${mitigation.equivalent}. Assumed effect, not a measured one.`,
      evidence: 'illustrative',
    },
    {
      id: 'rescore',
      headline: 'Re-scoring the site against the changed ground',
      detail: `${mitigation.factor} exposure ${pct(delta.sharesBefore[mitigation.factor] ?? 0)} -> ${pct(delta.sharesAfter[mitigation.factor] ?? 0)} · noisy-OR re-run over modified inputs`,
      evidence: 'mechanism',
    },
    {
      id: 'result',
      headline: 'Site re-scored',
      detail: `risk ${risk(delta.riskBefore)} -> ${risk(delta.riskAfter)} · band ${delta.decisionBefore} -> ${delta.decisionAfter}${
        delta.dominantAfter !== delta.dominantBefore
          ? ` · dominant factor ${delta.dominantBefore} -> ${delta.dominantAfter}`
          : ''
      }`,
      evidence: 'mechanism',
    },
    {
      id: 'residual',
      headline: 'Residual exposure remains',
      detail: mitigation.residualNote,
      evidence: 'mechanism',
    },
  ];

  return beats;
}

/** Total run time of a transcript, for sizing the commit timer. */
export function transcriptDurationMs(beatCount: number): number {
  return beatCount * BEAT_INTERVAL_MS + MAP_COMMIT_DELAY_MS;
}
