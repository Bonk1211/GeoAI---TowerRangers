import { useScheduleStore } from '../../state/useScheduleStore';
import { RouteMap } from './RouteMap';
import { WhySlotPanel } from './WhySlotPanel';

/**
 * The right column, mounted only when something is selected.
 *
 * It used to be always present at 360px, showing placeholder prose most of the
 * time — the calendar was permanently paying for a panel that was usually
 * empty. Nothing is mounted here at rest, so MapLibre does not initialise a
 * second map instance until a route actually needs drawing.
 *
 * It IS blurred, which it deliberately was not before. The old rule here was
 * that this surface animates its width and blurring a resizing surface is the
 * one thing the blur budget forbids outright — but the width animation went
 * away when the panel started mounting and unmounting instead, and the .glass-
 * raised fill it kept (0.94..0.88 white) left its own backdrop-filter with
 * nothing to show. `.panel-enter` animates transform and opacity only, so the
 * prohibition the old note was protecting still holds.
 */
export function DetailPanel() {
  const selection = useScheduleStore((s) => s.selection);
  const select = useScheduleStore((s) => s.select);

  if (!selection) return null;

  return (
    <aside
      /* Docked beside the board for its FULL height, not overlaid on the
         calendar.

         Overlaying it made the glass work — there was finally something behind
         it — but tied its height to the calendar's: expand the work queue and
         the panel shrank with it until the route map and the pin button were
         unreachable. A detail panel that disappears when you open the table
         you are cross-referencing it against is the wrong trade.

         It keeps its own gutter (m-2, rounded, shadow) rather than sitting
         flush, so it still reads as a card floating in the frame rather than a
         wall bolted to the edge, and the ambient wash on the page ground shows
         through the frost. */
      className="glass-panel panel-enter m-2 ml-0 flex w-[380px] shrink-0 flex-col overflow-hidden rounded-2xl"
      aria-label="Selection detail"
    >
      <div className="flex items-center justify-between border-b border-overlay/10 px-4 py-2.5">
        <h2 className="eyebrow">
          {selection.kind === 'job' && 'Scheduled visit'}
          {selection.kind === 'free' && 'Free crew-day'}
          {selection.kind === 'reserve' && 'Reserve capacity'}
          {selection.kind === 'emergency' && 'Dispatch'}
          {selection.kind === 'ticket_approval' && 'Emergency ticket'}
          {selection.kind === 'fire_inspection' && 'Fire exposure review'}
        </h2>
        {/* 32px square rather than the old text link: an icon-only control on
            a glass surface needs a real box to be findable, and this is the
            panel's only dismiss affordance. The accessible name stays on the
            aria-label since the glyph carries no text. */}
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close detail panel"
          title="Close"
          className="glass-field flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:text-fg"
        >
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>
      {/* Inset and rounded so the map reads as a card sitting inside the
          glass, rather than as a rectangle bleeding through it. */}
      {selection.kind === 'job' && (
        <div className="overflow-hidden rounded-xl border border-overlay/10 mx-3 mt-3 shadow-[var(--shadow-1)]">
          <RouteMap />
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <WhySlotPanel />
      </div>
    </aside>
  );
}
