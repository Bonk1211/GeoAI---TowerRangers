import { Panel } from '../ui/Panel';
import { Chip, DecisionChip } from '../ui/Chip';
import { AttachmentIcon, CheckIcon, CommentIcon } from '../shell/icons';
import type { CorpusRow } from '../../lib/feedbackCorpus';

/**
 * Every closed ticket as a labelled example.
 *
 * Five columns, not seven: the 0/1 label is carried by the "Field found" chip
 * (the ledger field name stays in the export, where it belongs), and evidence
 * counts shrink to icon + number. States are chips rather than sentences —
 * "no observation to confirm" repeated down a mono column was the heaviest
 * block of text on the page.
 */
export function CorpusLedger({ rows }: { rows: CorpusRow[] }) {
  return (
    <Panel
      title="Training corpus"
      hint="Every closed verdict as a labelled example, and whether it can leave. A row is exportable only when an unlabeled satellite observation exists to carry its label in the ledger's schema. Exported records carry simulated: false — real closures, unlike --simulate's demo confirmations."
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-ui text-dim">
          No verdicts yet. Close a ticket as confirmed or false positive and it lands here.
        </p>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-ui">
            <thead className="text-eyebrow uppercase tracking-wider text-dim">
              <tr>
                <th scope="col" className="py-2 pr-3 font-semibold">Tower</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Model believed</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Field found</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Technician feedback</th>
                <th scope="col" className="py-2 font-semibold">Export</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.ticket_id}
                  className="border-t border-overlay/10 transition-colors hover:bg-overlay/[0.03]"
                >
                  <td className="py-2 pr-3 font-mono text-fg">{row.tower_id}</td>

                  <td className="py-2 pr-3">
                    {row.belief ? (
                      <span className="flex flex-wrap items-center gap-1.5">
                        <DecisionChip decision={row.belief.decision} />
                        <span className="font-mono tnum text-muted">
                          {row.belief.priority.toFixed(2)}
                        </span>
                        <span className="text-dim">{row.belief.dominant_factor}</span>
                        {row.belief_at === 'current' && (
                          <Chip title="No raise-time snapshot — today's score">today</Chip>
                        )}
                      </span>
                    ) : (
                      <span className="text-dim">not scored</span>
                    )}
                  </td>

                  <td className="py-2 pr-3">
                    <span className="flex items-center gap-2">
                      <Chip
                        tone={row.verdict === 'confirmed' ? 'alert' : 'ok'}
                        title={`needed_corrective_maintenance = ${row.needed_corrective_maintenance}`}
                      >
                        {row.verdict === 'confirmed' ? 'Work needed' : 'False positive'}
                      </Chip>
                      {(row.evidence_notes > 0 || row.evidence_attachments > 0) && (
                        <span
                          className="flex items-center gap-2 text-micro text-dim tnum"
                          aria-label={`${row.evidence_notes} notes, ${row.evidence_attachments} files`}
                        >
                          {row.evidence_notes > 0 && (
                            <span className="flex items-center gap-0.5">
                              <CommentIcon /> {row.evidence_notes}
                            </span>
                          )}
                          {row.evidence_attachments > 0 && (
                            <span className="flex items-center gap-0.5 [&_svg]:h-3 [&_svg]:w-3">
                              <AttachmentIcon /> {row.evidence_attachments}
                            </span>
                          )}
                        </span>
                      )}
                    </span>
                  </td>

                  {/* The technician's own words stay visible — without them the
                      page collects feedback and never shows it. */}
                  <td className="max-w-[18rem] py-2 pr-3">
                    {row.factor_correct === null && !row.comment ? (
                      <span className="text-dim">—</span>
                    ) : (
                      <span className="flex min-w-0 flex-col gap-1">
                        {row.factor_correct !== null && (
                          <span>
                            {row.factor_correct ? (
                              <Chip tone="ok">Factor right</Chip>
                            ) : (
                              <Chip tone="alert">
                                Factor wrong{row.actual_factor ? ` → ${row.actual_factor}` : ''}
                              </Chip>
                            )}
                          </span>
                        )}
                        {row.comment && (
                          <span className="truncate text-micro text-dim" title={row.comment}>
                            &ldquo;{row.comment}&rdquo;
                          </span>
                        )}
                      </span>
                    )}
                  </td>

                  <td className="py-2">
                    {row.attachable ? (
                      <Chip tone="ok" icon={<CheckIcon />}>
                        {row.observation?.source ?? 'ready'}
                      </Chip>
                    ) : (
                      <Chip title="No unlabeled observation to confirm">No observation</Chip>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
