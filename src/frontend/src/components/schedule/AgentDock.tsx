import { AgentChat } from './AgentChat';
import { usePendingTickets } from '../../state/usePendingTickets';
import { useScheduleStore } from '../../state/useScheduleStore';

/**
 * The bottom-right floating dock for "Ranger" — the autonomous scheduling & dispatch optimizer.
 *
 * A genuinely frosted widget, which it previously only claimed to be: every
 * surface here used to fill at 0.90-0.95 white, so the backdrop-filter under
 * them had almost nothing left to show and the dock rendered as a white card
 * with an expensive blur attached. `.glass-dock` fills at 0.66..0.56 and the
 * violet bloom behind it (see the ::before below) gives the frost something
 * worth refracting.
 */
export function AgentDock() {
  // Open/closed lives in the store, not in local state: the detail panel can
  // hand Ranger a drafted constraint ("ask about this visit"), and it has to
  // be able to open the dock to deliver it.
  const open = useScheduleStore((s) => s.agentOpen);
  const setOpen = useScheduleStore((s) => s.setAgentOpen);
  // A pending approval must be visible without opening the dock — the dock is
  // collapsed by default, and an approval nobody can see is one that never
  // happens.
  const pendingCount = usePendingTickets().length;

  return (
    <div
      /* The ambient violet bloom is drawn behind the dock, not on it: a
         backdrop-filter can only frost what is already painted underneath,
         and over a white board there is otherwise nothing there. It is
         pointer-events-none and sits at -z-10 so it never intercepts a click
         meant for the board. */
      /* Absolute inside the calendar area, not fixed to the viewport. Fixed
         positioning anchored it to the bottom-right of the window, which is
         exactly where the work queue keeps its search, refresh and collapse
         controls — so the pill sat on top of them and, once the queue was
         collapsed, covered the very control that reopens it. Anchoring it to
         the board means it floats over the calendar it optimises and can never
         reach the queue's chrome.

         Left, not right: the right edge of the schedule now belongs to the
         detail panel, and a floating dock stacked on top of an open panel
         covers the pin button it is meant to complement. */
      className={`group/dock absolute bottom-3 left-4 z-40 flex flex-col transition-all duration-300 ease-out before:pointer-events-none before:absolute before:-inset-8 before:-z-10 before:rounded-full before:bg-[radial-gradient(circle_at_30%_80%,rgba(124,58,237,0.22),transparent_65%)] before:opacity-0 before:transition-opacity before:duration-300 ${
        open
          ? 'glass-dock h-[540px] w-[420px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] rounded-3xl before:opacity-100'
          : 'glass-dock h-[46px] w-auto rounded-full before:opacity-60 hover:before:opacity-100 hover:scale-[1.02]'
      }`}
    >
      {/* Collapsed Pill Trigger */}
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-expanded={false}
          aria-controls="agent-dock-body"
          className="flex h-full items-center gap-2.5 px-3.5 py-1.5 text-left transition-transform duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 rounded-full"
        >
          {/* Glowing Avatar */}
          <div className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-tr from-violet-600 to-indigo-500 text-white shadow-md shadow-violet-500/30">
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
            <span className="absolute -top-0.5 -right-0.5 flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500 ring-1 ring-white"></span>
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-ui font-semibold text-fg tracking-tight">Ranger</span>
            <span className="rounded-full bg-accent/12 px-2 py-0.5 text-[9.5px] font-medium text-accent">Optimizer</span>
          </div>

          <span className="text-eyebrow text-muted pl-1 font-medium">Ask to optimize…</span>

          {pendingCount > 0 && (
            <span className="flex items-center gap-1 rounded-full border border-alert/40 bg-alert/10 px-2 py-0.5 text-eyebrow font-semibold text-alert-ink">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-alert" />
              {pendingCount} awaiting approval
            </span>
          )}

          <div className="glass-field ml-1 flex h-6 w-6 items-center justify-center rounded-full text-muted group-hover/dock:text-fg">
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M4 10l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </button>
      ) : (
        <div
          id="agent-dock-body"
          className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-3xl"
        >
          <AgentChat onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}
