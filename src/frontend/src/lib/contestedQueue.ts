/**
 * The adjudication queue: towers the imagery contradicts, awaiting a human.
 *
 * feedbackCorpus.ts is the loop's OUTPUT — closed tickets becoming labels.
 * This is its INPUT. model/feedback.py records, for every scored tower, whether
 * the served decision agreed with the sampled EVI window, and on the current
 * estate 848 of those rows disagree across 53 towers. Every one is unlabeled:
 * the model says `ok`, the satellite sees change, and nobody has been.
 *
 * That gap is the reason a human-in-the-loop exists, and the page had no way
 * to show it. Raising a ticket from here is what starts the loop turning:
 * ticket -> technician verdict -> corpus row -> exportable label.
 *
 * Pure. No React, no stores, no fetch — every input arrives as an argument, so
 * the whole thing is testable under `node --test`.
 */
import type { LedgerObservation } from '../api/types';
import type { TowerBelief } from './feedbackCorpus';

/** The three ticket states that mean "someone is already on this tower". */
const LIVE_TICKET_STATUSES = new Set(['open', 'active', 'resolved']);

export interface ContestedTower {
  tower_id: string;
  /** How strongly the imagery contradicts the decision; null when unrecorded. */
  change_rank: number | null;
  /** The decision the ledger row was served against, not today's. */
  model_said: string;
  predicted_priority: number;
  /** The whole ledger row, so a caller can show the raw evidence. */
  observation: LedgerObservation;
  /**
   * The live tower. Carried, not just referenced, because raising a ticket
   * snapshots it — and a snapshot is what puts the closure in the 2x2 with
   * belief_at 'raise' instead of falling back to today's score.
   */
  tower: TowerBelief;
  /** A live ticket covers this tower: someone is on it right now. */
  raised: boolean;
  raised_ticket_id: string | null;
  /**
   * A closed ticket already carries a verdict for this tower.
   *
   * Deliberately separate from `raised`. Adjudicating does NOT remove the
   * tower from the queue, because nothing wrote to the ledger — the row is
   * still unlabeled and the backend still contests it. But offering a bare
   * "Raise ticket" on a tower judged seconds ago invites a duplicate visit,
   * so the UI needs to be able to say which of the two happened.
   */
  judged: boolean;
  judged_ticket_id: string | null;
}

/** The minimum a ticket must expose for the queue to dedupe against it. */
interface TicketLike {
  ticket_id: string;
  tower_id: string;
  status: string;
  resolution?: string | null;
}

function changeRank(row: LedgerObservation): number | null {
  const value = row.observation?.change_rank;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function toQueue(
  contested: LedgerObservation[],
  towers: TowerBelief[],
  tickets: TicketLike[],
): ContestedTower[] {
  const towerById = new Map(towers.map((t) => [t.tower_id, t]));

  // Two independent states. A tower can be both: judged last month and raised
  // again today, in which case the live ticket governs the action.
  const liveTicketByTower = new Map<string, string>();
  const judgedTicketByTower = new Map<string, string>();
  for (const ticket of tickets) {
    if (LIVE_TICKET_STATUSES.has(ticket.status)) {
      if (!liveTicketByTower.has(ticket.tower_id)) {
        liveTicketByTower.set(ticket.tower_id, ticket.ticket_id);
      }
    } else if (ticket.status === 'closed' && ticket.resolution) {
      // A closure with no resolution is not a verdict and labels nothing.
      if (!judgedTicketByTower.has(ticket.tower_id)) {
        judgedTicketByTower.set(ticket.tower_id, ticket.ticket_id);
      }
    }
  }

  const entries: ContestedTower[] = [];
  for (const row of contested) {
    const tower = towerById.get(row.tower_id);
    // A tower the backend no longer serves cannot be ticketed: /schedule/pin
    // 404s on an id outside the scored population. Drop it rather than offer
    // an action that fails.
    if (!tower) continue;
    const raisedTicketId = liveTicketByTower.get(row.tower_id) ?? null;
    const judgedTicketId = judgedTicketByTower.get(row.tower_id) ?? null;
    entries.push({
      tower_id: row.tower_id,
      change_rank: changeRank(row),
      model_said: row.predicted_decision,
      predicted_priority: row.predicted_priority,
      observation: row,
      tower,
      raised: raisedTicketId !== null,
      raised_ticket_id: raisedTicketId,
      judged: judgedTicketId !== null,
      judged_ticket_id: judgedTicketId,
    });
  }

  // Strongest contradiction first. A row with no recorded rank is still a real
  // disagreement, so it sorts last rather than being dropped.
  return entries.sort((a, b) => (b.change_rank ?? -1) - (a.change_rank ?? -1));
}

/**
 * The five stages of the loop, each counted from its own source.
 *
 * Deliberately not derived from one another: `observed` and `in_training` come
 * from the backend ledger, `judged` and `exportable` from the in-memory ticket
 * corpus. Inferring one from another would let a frontend-only number claim
 * backend provenance.
 */
export interface FunnelCounts {
  observed: number | null;
  contested_rows: number | null;
  contested_towers: number;
  judged: number;
  exportable: number;
  in_training: number | null;
}

interface LedgerLike {
  records: number;
  disagree: number;
  eligible_for_training: number;
}

export function funnelCounts(
  ledger: LedgerLike | null,
  contestedTowers: number,
  judged: number,
  exportable: number,
): FunnelCounts {
  return {
    // An unreadable ledger is absence, not zero. Rendering 0 here would claim
    // the satellite observed nothing, which is a different and false statement.
    observed: ledger ? ledger.records : null,
    contested_rows: ledger ? ledger.disagree : null,
    contested_towers: contestedTowers,
    judged,
    exportable,
    in_training: ledger ? ledger.eligible_for_training : null,
  };
}
