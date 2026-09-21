import { placeName, hasPlaceName } from '../../fixtures/schedule';
import { useScheduleStore } from '../../state/useScheduleStore';
import { usePendingTickets } from '../../state/usePendingTickets';
import { AlertIcon } from '../shell/icons';

/**
 * The announce half of the ticket hand-off: a pinned index of tickets waiting
 * on a decision, sitting above Ranger's transcript.
 *
 * Deliberately NOT a Block in AgentChat's transcript
 * (docs/superpowers/specs/2026-09-03-ticket-approval-flow-design.md §2.2):
 * transcript blocks are local streaming state, they scroll away, and they can
 * be lost when the planner sends a message. This region touches the SSE path
 * not at all. It is also not a glass surface — the dock already spends one of
 * the eight blur budget slots and nesting another buys nothing.
 */
export function TicketApprovalStrip() {
  const pending = usePendingTickets();
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);

  if (pending.length === 0) return null;

  const day = run.horizon[0];

  return (
    <div className="shrink-0 border-b border-overlay/10 px-3 py-2.5">
      <div className="eyebrow mb-1.5 flex items-center gap-1.5 text-alert-ink">
        <span className="[&>svg]:h-3 [&>svg]:w-3">
          <AlertIcon />
        </span>
        Awaiting approval ({pending.length})
      </div>
      <ul className="space-y-1.5">
        {pending.map((t) => (
          <li
            key={t.ticket_id}
            className="spine glass-field flex items-center justify-between gap-2 rounded-lg py-1.5 pl-2.5 pr-1.5"
            style={{ '--spine': 'var(--color-alert)' } as React.CSSProperties}
          >
            <span className="min-w-0">
              <span className="block truncate text-ui font-medium text-fg">
                {hasPlaceName(t.tower_id) ? placeName(t.tower_id) : t.tower_id}
              </span>
              <span className="block truncate font-mono text-eyebrow text-dim">{t.ticket_id}</span>
            </span>
            {/* No day yet means the schedule has not loaded; approving into a
                day outside the horizon is what EmergencyPanel's own
                dayIsPlannable guard exists to prevent. */}
            {day ? (
              <button
                type="button"
                onClick={() => select({ kind: 'ticket_approval', ticket_id: t.ticket_id, day })}
                className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1 text-micro font-semibold text-accent transition-colors duration-150 hover:bg-accent hover:text-white"
              >
                Review
              </button>
            ) : (
              <span className="shrink-0 text-micro text-dim">waiting for schedule</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
