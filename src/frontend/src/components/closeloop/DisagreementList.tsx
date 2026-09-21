import { Link } from 'react-router-dom';
import { Panel } from '../ui/Panel';
import { Chip, DecisionChip } from '../ui/Chip';
import type { CorpusRow, VerdictCounts } from '../../lib/feedbackCorpus';

/**
 * Where the field contradicted the model, as one table.
 *
 * Two independent kinds of error, kept distinguishable because they imply
 * different corrections: the dispatch decision was wrong (verdict_agreement),
 * or the REASON was wrong (factor_correct). A ticket can be both, so they are
 * tags on a row rather than two side-by-side lists — the lists left one half
 * of the panel reading "None." whenever a kind was empty.
 *
 * A wrong decision is named for what it means to an operator: the model
 * dispatched and nothing was wrong (false alarm), or held back and work was
 * needed (missed). "MAINTAIN → nothing wrong" asked the reader to work that out.
 *
 * Each tower links to Investigation, where ModelTransparencyPanel renders the
 * attribution.
 */
function kindOf(row: CorpusRow): 'false_alarm' | 'missed' | null {
  if (row.verdict_agreement !== 'disagree') return null;
  return row.verdict === 'false_positive' ? 'false_alarm' : 'missed';
}

interface DisagreementListProps {
  rows: CorpusRow[];
  /** The 2x2's counts, so an empty tally can be reported in one line. */
  counts: VerdictCounts;
}

export function DisagreementList({ rows, counts }: DisagreementListProps) {
  const shown = rows.filter((r) => r.verdict_agreement === 'disagree' || r.factor_correct === false);
  const fromToday = shown.filter((r) => r.belief_at === 'current').length;
  const allToday = shown.length > 0 && fromToday === shown.length;

  return (
    <Panel
      title="Disagreements"
      hint="Closed tickets where the technician's finding contradicts the model: it dispatched when nothing was wrong (false alarm), held back when work was needed (missed), or blamed the wrong factor. Listed to investigate one by one, not counted as a score."
    >
      {shown.length === 0 ? (
        <p className="py-6 text-center text-ui text-dim">
          No field verdict has contradicted the model yet.
        </p>
      ) : (
        <>
          {fromToday > 0 && (
            <p className="mb-3 text-micro text-dim">
              {allToday ? 'All rows' : `${fromToday} of ${shown.length} rows`} compare against{' '}
              <span className="font-medium text-muted">today&apos;s score</span> — these tickets
              kept no snapshot of what the model believed when raised.
            </p>
          )}
          <div className="scroll-thin overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-ui">
              <thead className="text-eyebrow uppercase tracking-wider text-dim">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-semibold">Tower</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Model said</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">Field found</th>
                  <th scope="col" className="py-2 pr-4 font-semibold">What went wrong</th>
                  <th scope="col" className="py-2 font-semibold">Technician note</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const kind = kindOf(row);
                  return (
                    <tr
                      key={row.ticket_id}
                      className="border-t border-overlay/10 transition-colors hover:bg-overlay/[0.03]"
                    >
                      <td className="whitespace-nowrap py-2.5 pr-4">
                        <Link
                          to={`/investigation/${row.tower_id}`}
                          className="rounded font-mono text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          {row.tower_id}
                        </Link>
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4">
                        <span className="flex items-center gap-1.5">
                          <DecisionChip decision={row.belief?.decision ?? null} />
                          {row.belief_at === 'current' && !allToday && (
                            <span className="text-micro text-dim">(today)</span>
                          )}
                        </span>
                      </td>
                      <td className="whitespace-nowrap py-2.5 pr-4 text-fg">
                        {row.verdict === 'confirmed' ? 'Work needed' : 'Nothing wrong'}
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className="flex flex-wrap items-center gap-1.5">
                          {kind === 'false_alarm' && <Chip tone="watch">False alarm</Chip>}
                          {kind === 'missed' && <Chip tone="alert">Missed</Chip>}
                          {row.factor_correct === false && (
                            <Chip tone="accent">
                              Wrong factor: {row.belief?.dominant_factor ?? '?'}
                              {row.actual_factor ? ` → ${row.actual_factor}` : ''}
                            </Chip>
                          )}
                        </span>
                      </td>
                      <td className="max-w-[16rem] py-2.5">
                        {row.comment ? (
                          <span className="block truncate text-muted" title={row.comment}>
                            &ldquo;{row.comment}&rdquo;
                          </span>
                        ) : (
                          <span className="text-dim">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* The 2x2 lives beside this panel only once it has something to count.
          Four zeros in a grid said nothing; one line says why. */}
      {counts.n === 0 && counts.excluded > 0 && (
        <p className="mt-3 border-t border-overlay/10 pt-3 text-micro text-dim">
          Dispatch-vs-field tally: none yet — all {counts.excluded} verdicts lack a raise-time
          snapshot.
        </p>
      )}
    </Panel>
  );
}
