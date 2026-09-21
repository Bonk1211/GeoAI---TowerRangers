import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Panel, Button } from '../ui/Panel';
import { Chip, DecisionChip } from '../ui/Chip';
import { CheckIcon } from '../shell/icons';
import type { ContestedTower } from '../../lib/contestedQueue';

interface ContestedQueueProps {
  entries: ContestedTower[];
  loading: boolean;
  onRaise: (entry: ContestedTower) => void;
}

/** How many to show before the operator asks for the rest. */
const PAGE = 8;

function EvidenceBar({ rank }: { rank: number | null }) {
  if (rank === null) return <span className="text-dim">—</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-overlay/[0.08]">
        <span
          className="block h-full rounded-full bg-alert/70"
          style={{ width: `${Math.max(rank * 100, 2)}%` }}
        />
      </span>
      <span className="font-mono tnum text-fg">{rank.toFixed(2)}</span>
    </span>
  );
}

/**
 * Towers the imagery contradicts, worst first — the loop's missing input.
 *
 * The lead sentence and footnote that used to restate the counts are gone: the
 * untouched count is on the tab, and the explanation is behind the hint. What
 * is left is the table and its one action.
 *
 * Raising a ticket here is the only thing on this page that changes anything.
 * It writes a ticket, never the ledger: `label_status` still only moves when a
 * human deliberately appends a confirmation, which is model/feedback.py's
 * "Evidence is never an automatic label" holding at the UI boundary too.
 */
export function ContestedQueue({ entries, loading, onRaise }: ContestedQueueProps) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? entries : entries.slice(0, PAGE);

  return (
    <Panel
      title="Imagery contradicts the model"
      hint="Towers where Sentinel-2 vegetation change disagrees with the served decision, ranked by how far the change sits above the estate. Raising a ticket sends a technician; it records a disagreement worth visiting — it does not label the observation or claim a fault was found."
    >
      {loading ? (
        <div className="space-y-2" aria-busy="true" aria-label="Reading the ledger">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-md bg-overlay/[0.05]" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-ui text-dim">
          Nothing contested — the imagery agrees with every served decision, or the ledger is
          unavailable.
        </p>
      ) : (
        <div className="scroll-thin overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-ui">
            <thead className="text-eyebrow uppercase tracking-wider text-dim">
              <tr>
                <th scope="col" className="py-2 pr-3 font-semibold">Tower</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Model said</th>
                <th scope="col" className="py-2 pr-3 font-semibold">Imagery change</th>
                <th scope="col" className="py-2 pr-3 text-right font-semibold">Priority</th>
                <th scope="col" className="py-2 text-right font-semibold">Action</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr
                  key={entry.tower_id}
                  className="border-t border-overlay/10 transition-colors hover:bg-overlay/[0.03]"
                >
                  <td className="py-2 pr-3">
                    <Link
                      to={`/investigation/${entry.tower_id}`}
                      className="rounded font-mono text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {entry.tower_id}
                    </Link>
                  </td>
                  <td className="py-2 pr-3">
                    <DecisionChip decision={entry.model_said} />
                  </td>
                  <td className="py-2 pr-3">
                    <EvidenceBar rank={entry.change_rank} />
                  </td>
                  <td className="py-2 pr-3 text-right font-mono tnum text-muted">
                    {entry.predicted_priority.toFixed(2)}
                  </td>
                  <td className="py-2 text-right">
                    {entry.raised ? (
                      <Chip tone="ok" icon={<CheckIcon />}>
                        {entry.raised_ticket_id} open
                      </Chip>
                    ) : entry.judged ? (
                      // Still contested — the verdict went to the ticket, not
                      // the ledger, so the backend keeps listing it. Say so
                      // rather than offer a bare button on a judged tower.
                      <span className="inline-flex items-center gap-2">
                        <Chip tone="neutral" title={`Judged on ${entry.judged_ticket_id}`}>
                          Judged
                        </Chip>
                        <button
                          type="button"
                          onClick={() => onRaise(entry)}
                          className="cursor-pointer rounded text-micro font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                        >
                          Raise again
                        </button>
                      </span>
                    ) : (
                      <Button
                        tone="primary"
                        onClick={() => onRaise(entry)}
                        className="min-h-[30px] px-3 text-micro"
                      >
                        Raise ticket
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {entries.length > PAGE && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 cursor-pointer rounded text-ui font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {expanded ? `Show first ${PAGE}` : `Show all ${entries.length}`}
        </button>
      )}
    </Panel>
  );
}
