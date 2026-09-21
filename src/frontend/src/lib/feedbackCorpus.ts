/**
 * Closed tickets as training labels.
 *
 * model/maintenance_need.py's target is `needed_corrective_maintenance` — "a
 * work order was raised" — and it is trained on SYNTHETIC labels today. A
 * technician closing a ticket `confirmed` or `false_positive` observes that
 * exact quantity in the field. This module performs the join that turns the
 * one into the other.
 *
 * Pure. No React, no stores, no fetch — every input arrives as an argument, so
 * the whole thing is testable under `node --test`.
 */
import type { ModelSnapshot, Ticket } from '../fixtures/tickets';
import type { LedgerObservation } from '../api/types';

export type { LedgerObservation };

/**
 * The five fields the corpus reads off a tower. `Tower` satisfies this
 * structurally, so callers pass their live towers unchanged — but a test can
 * build one in five lines instead of thirty.
 */
export interface TowerBelief {
  tower_id: string;
  risk: number;
  priority: number;
  decision: 'maintain' | 'watch' | 'ok';
  dominant_factor: string;
}

export type Verdict = 'confirmed' | 'false_positive';
export type Agreement = 'agree' | 'disagree' | 'indeterminate';

export interface CorpusRow {
  ticket_id: string;
  tower_id: string;
  /** The ledger's own field name, deliberately. 1 = confirmed, 0 = false positive. */
  needed_corrective_maintenance: 0 | 1;
  verdict: Verdict;
  raised_by: Ticket['source'];
  belief: ModelSnapshot | null;
  /** 'raise' when a snapshot existed; 'current' when it fell back to today. */
  belief_at: 'raise' | 'current';
  /**
   * Model-vs-TECHNICIAN. Not to be confused with LedgerObservation.agreement,
   * which is model-vs-SATELLITE. Same three words, different comparison —
   * reading them as one number is the failure this feature exists to prevent.
   */
  verdict_agreement: Agreement;
  factor_correct: boolean | null;
  actual_factor: string | null;
  /** The technician's own words. The page must show these or it collects
   *  feedback and never displays it — the same failure it exists to fix. */
  comment: string | null;
  evidence_notes: number;
  evidence_attachments: number;
  /** The unlabeled ledger row this verdict could confirm, WHOLE. */
  observation: LedgerObservation | null;
  attachable: boolean;
  closed_at: string;
}

/**
 * `maintain` is the dispatch band; `watch` and `ok` are both "do not dispatch".
 * So agreement is dispatch-decision against field outcome. `indeterminate` is
 * reserved for a tower with no belief at all — never for a band we do hold,
 * which would quietly drop real disagreements out of the count.
 */
function agreementOf(decision: TowerBelief['decision'] | null, verdict: Verdict): Agreement {
  if (decision === null) return 'indeterminate';
  const dispatched = decision === 'maintain';
  const neededWork = verdict === 'confirmed';
  return dispatched === neededWork ? 'agree' : 'disagree';
}

export function toCorpus(
  tickets: Ticket[],
  towers: TowerBelief[],
  observations: LedgerObservation[],
): CorpusRow[] {
  const towerById = new Map(towers.map((t) => [t.tower_id, t]));

  // Only unlabeled rows are confirmable: a confirmed one is already spent, and
  // _confirmed() counts a (tower, source, window) once however many times it
  // is appended.
  const openByTower = new Map<string, LedgerObservation>();
  for (const obs of observations) {
    if (obs.label_status === 'unlabeled' && !openByTower.has(obs.tower_id)) {
      openByTower.set(obs.tower_id, obs);
    }
  }

  const rows: CorpusRow[] = [];
  for (const ticket of tickets) {
    if (ticket.status !== 'closed' || ticket.resolution === null) continue;
    const verdict = ticket.resolution as Verdict;

    const snapshot = ticket.model_snapshot ?? null;
    const current = towerById.get(ticket.tower_id);
    let belief: ModelSnapshot | null = snapshot;
    if (belief === null && current) {
      belief = {
        risk: current.risk,
        priority: current.priority,
        decision: current.decision,
        dominant_factor: current.dominant_factor,
        captured_at: '',
      };
    }

    const observation = openByTower.get(ticket.tower_id) ?? null;
    const feedback = ticket.model_feedback;

    rows.push({
      ticket_id: ticket.ticket_id,
      tower_id: ticket.tower_id,
      needed_corrective_maintenance: verdict === 'confirmed' ? 1 : 0,
      verdict,
      raised_by: ticket.source,
      belief,
      belief_at: snapshot ? 'raise' : 'current',
      verdict_agreement: agreementOf(belief ? belief.decision : null, verdict),
      factor_correct: feedback ? feedback.accurate : null,
      actual_factor: feedback?.actual_factor ?? null,
      comment: feedback?.comment ?? null,
      evidence_notes: ticket.fix_notes.length,
      evidence_attachments: ticket.fix_notes.filter((n) => n.attachment).length,
      observation,
      attachable: observation !== null,
      closed_at: ticket.fix_notes.at(-1)?.created_at ?? ticket.created_at,
    });
  }
  return rows;
}

export interface VerdictCounts {
  /** maintain + confirmed — the model dispatched and work was needed. */
  caught: number;
  /** maintain + false_positive — it dispatched and nothing was wrong. */
  falseAlarm: number;
  /** watch|ok + confirmed — it did not dispatch and work was needed. */
  missed: number;
  /** watch|ok + false_positive — it did not dispatch and nothing was wrong. */
  quiet: number;
  /** Rows actually counted. Small, and not a random sample — never an accuracy. */
  n: number;
  /** Rows dropped for having no raise-time belief. Reported, not hidden. */
  excluded: number;
}

/**
 * The 2x2, built ONLY from raise-time beliefs.
 *
 * A row whose belief came from today's score is excluded rather than counted:
 * including it would compare a verdict recorded weeks ago against a model that
 * has been rescored since, and present the pair as a measurement. `excluded` is
 * returned so the page can say how many were left out.
 */
export function verdictCounts(rows: CorpusRow[]): VerdictCounts {
  const counts: VerdictCounts = {
    caught: 0, falseAlarm: 0, missed: 0, quiet: 0, n: 0, excluded: 0,
  };
  for (const row of rows) {
    if (row.belief_at !== 'raise' || row.belief === null) {
      counts.excluded += 1;
      continue;
    }
    const dispatched = row.belief.decision === 'maintain';
    const neededWork = row.needed_corrective_maintenance === 1;
    if (dispatched && neededWork) counts.caught += 1;
    else if (dispatched && !neededWork) counts.falseAlarm += 1;
    else if (!dispatched && neededWork) counts.missed += 1;
    else counts.quiet += 1;
    counts.n += 1;
  }
  return counts;
}

/** One line of the export: an Observation with a label, ready to append. */
export interface ConfirmationRecord extends LedgerObservation {
  label_status: 'confirmed';
  simulated: false;
}

/**
 * Confirmations, in model/feedback.py's exact schema.
 *
 * A confirmation is a COPY of the original observation with two fields
 * changed — that is how feedback.py builds one — because _confirmed() keys
 * candidates on (tower_id, source, observed_at). Any record that does not
 * reproduce that triple exactly appends an unrelated row and leaves the
 * original unlabeled forever, and nothing anywhere reports the failure.
 *
 * So predicted_priority, predicted_decision, agreement, source and observed_at
 * are carried over untouched. They were measured when the observation was
 * made; re-deriving them from today's model would overwrite a measurement with
 * a guess.
 *
 * Rows with no observation are omitted. `source` is validated against three
 * satellite values by Observation.__post_init__, and there is no legal value
 * to invent for a verdict that has no satellite row behind it.
 */
export function toObservationRecords(rows: CorpusRow[]): ConfirmationRecord[] {
  const records: ConfirmationRecord[] = [];
  for (const row of rows) {
    if (row.observation === null) continue;
    records.push({
      ...row.observation,
      label_status: 'confirmed',
      simulated: false,
      // Ticket provenance lives INSIDE the free-form observation dict, so no
      // field Observation validates is touched.
      observation: {
        ...row.observation.observation,
        needed_corrective_maintenance: row.needed_corrective_maintenance,
        ticket_id: row.ticket_id,
        closed_at: row.closed_at,
      },
    });
  }
  return records;
}

/** JSON Lines: one compact object per line, exactly as the ledger stores them. */
export function toJsonl(records: ConfirmationRecord[]): string {
  if (records.length === 0) return '';
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
