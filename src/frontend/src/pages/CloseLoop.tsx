import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../components/ui/Panel';
import { SegmentedTabs, type SegmentedTab } from '../components/ui/Chip';
import { CheckIcon } from '../components/shell/icons';
import {
  ContestedQueue,
  CorpusLedger,
  DisagreementList,
  ExportConfirmations,
  LoopFunnel,
  ScopeNotes,
  VerdictMatrix,
} from '../components/closeloop';
import {
  useContestedObservationsQuery,
  useLedgerObservationsQuery,
  useModelHealthQuery,
  useTowersQuery,
} from '../api/queries';
import { useTicketStore } from '../state/useTicketStore';
import { toCorpus, verdictCounts } from '../lib/feedbackCorpus';
import { funnelCounts, toQueue, type ContestedTower } from '../lib/contestedQueue';

/**
 * Where the human closes the loop.
 *
 * model/feedback.py keeps an append-only observation ledger whose rows only
 * become training data once label_status flips to "confirmed", and append() on
 * the serving path forcibly resets any label to "unlabeled" — "Evidence is
 * never an automatic label". Exactly one writer in the repo performs that flip:
 * --simulate, which marks itself simulated.
 *
 * A technician closing a ticket confirmed/false_positive observes
 * needed_corrective_maintenance, which is the model's own training target. This
 * page shows that corpus accumulating and exports it in the ledger's schema.
 *
 * Nothing here writes to the ledger or retrains anything. The one action the
 * page offers — raising a ticket from the contested queue — writes a TICKET.
 *
 * LAYOUT. One column: the loop as a five-figure strip, then one tab at a time.
 * The previous rail + four stacked panels showed every reading at once, printed
 * the same counts up to three times and explained them in paragraphs. Now each
 * number appears once, explanations live behind hints, and the tab holding
 * outstanding work opens first with its count in alert. The tab is in the URL
 * (?tab=) so a link can land on the corpus directly.
 */
type LoopTab = 'queue' | 'disagreements' | 'corpus';
const LOOP_TABS: LoopTab[] = ['queue', 'disagreements', 'corpus'];

export function CloseLoop() {
  const tickets = useTicketStore((s) => s.tickets);
  const raiseFromContested = useTicketStore((s) => s.raiseFromContested);
  const towersQuery = useTowersQuery();

  // Only the towers that could actually use an observation — a closed ticket
  // carrying a verdict. Asking for the whole estate returns 12,804 rows.
  const closedTowerIds = useMemo(
    () => [...new Set(
      tickets.filter((t) => t.status === 'closed' && t.resolution !== null).map((t) => t.tower_id),
    )],
    [tickets],
  );
  const observationsQuery = useLedgerObservationsQuery(closedTowerIds);
  const contestedQuery = useContestedObservationsQuery();
  const healthQuery = useModelHealthQuery();

  const towers = useMemo(() => towersQuery.data ?? [], [towersQuery.data]);
  const observations = useMemo(() => observationsQuery.data ?? [], [observationsQuery.data]);
  const contested = useMemo(() => contestedQuery.data ?? [], [contestedQuery.data]);
  const ledger = healthQuery.data?.ledger ?? null;

  const rows = useMemo(
    () => toCorpus(tickets, towers, observations),
    [tickets, towers, observations],
  );
  const counts = useMemo(() => verdictCounts(rows), [rows]);
  const exportable = useMemo(() => rows.filter((r) => r.attachable).length, [rows]);

  const queue = useMemo(
    () => toQueue(contested, towers, tickets),
    [contested, towers, tickets],
  );
  const funnel = useMemo(
    () => funnelCounts(ledger, queue.length, rows.length, exportable),
    [ledger, queue.length, rows.length, exportable],
  );
  // Untouched = nobody is on it AND nobody has judged it. Counting merely
  // "unraised" would report a tower adjudicated a minute ago as outstanding.
  const untouched = useMemo(() => queue.filter((e) => !e.raised && !e.judged).length, [queue]);
  const disagreements = useMemo(
    () =>
      rows.filter((r) => r.verdict_agreement === 'disagree' || r.factor_correct === false).length,
    [rows],
  );

  const [params, setParams] = useSearchParams();
  const requested = params.get('tab') as LoopTab | null;
  const tab: LoopTab = requested && LOOP_TABS.includes(requested) ? requested : 'queue';
  const setTab = (next: LoopTab) =>
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        if (next === 'queue') p.delete('tab');
        else p.set('tab', next);
        return p;
      },
      { replace: true },
    );

  const tabs: SegmentedTab<LoopTab>[] = [
    { key: 'queue', label: 'Awaiting a human', count: untouched, countTone: 'alert' },
    { key: 'disagreements', label: 'Disagreements', count: disagreements },
    { key: 'corpus', label: 'Training corpus', count: rows.length },
  ];

  // Confirms the raise in place. The ticket lands on the Tickets board, which
  // is a different route — without this the button would appear to do nothing.
  const [raised, setRaised] = useState<{ tower_id: string; ticket_id: string } | null>(null);

  const onRaise = useCallback(
    (entry: ContestedTower) => {
      const window = entry.observation.observation?.window_recent;
      const ticket = raiseFromContested({
        tower: entry.tower,
        changeRank: entry.change_rank,
        modelSaid: entry.model_said,
        windowRecent: typeof window === 'string' ? window : undefined,
      });
      // null means a live ticket already covered the tower; the row re-renders
      // as "open" on the next pass either way.
      if (ticket) setRaised({ tower_id: entry.tower_id, ticket_id: ticket.ticket_id });
    },
    [raiseFromContested],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PageHeader
        title="Close Loop"
        subtitle="Field verdicts vs model predictions, turned into training labels"
      >
        <ScopeNotes />
        <ExportConfirmations rows={rows} />
      </PageHeader>

      {raised && (
        <div
          role="status"
          className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-ok/25 bg-ok/[0.08] px-6 py-2 text-ui text-muted"
        >
          <span className="text-ok-ink">
            <CheckIcon size={14} />
          </span>
          <span className="font-medium text-fg">{raised.ticket_id}</span> raised for
          <span className="font-mono">{raised.tower_id}</span>
          <Link
            to="/tickets"
            className="rounded font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            Open in Tickets →
          </Link>
          <button
            type="button"
            onClick={() => setRaised(null)}
            className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded text-dim hover:bg-overlay/[0.06] hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl space-y-4 p-4 pb-16 lg:p-6">
          <LoopFunnel counts={funnel} simulated={ledger?.simulated_records ?? null} />

          <SegmentedTabs
            tabs={tabs}
            value={tab}
            onChange={setTab}
            label="Close loop views"
            idPrefix="loop"
          />

          <div role="tabpanel" id={`loop-panel-${tab}`} aria-labelledby={`loop-tab-${tab}`}>
            {tab === 'queue' && (
              <ContestedQueue
                entries={queue}
                loading={contestedQuery.isPending}
                onRaise={onRaise}
              />
            )}
            {tab === 'disagreements' &&
              // The matrix earns a column only when it has counted something;
              // otherwise the list says so in one line and takes the full width.
              (counts.n > 0 ? (
                <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
                  <DisagreementList rows={rows} counts={counts} />
                  <VerdictMatrix counts={counts} />
                </div>
              ) : (
                <DisagreementList rows={rows} counts={counts} />
              ))}
            {tab === 'corpus' && <CorpusLedger rows={rows} />}
          </div>
        </div>
      </div>
    </div>
  );
}
