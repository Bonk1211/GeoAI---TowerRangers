import { useScheduleStore } from '../../state/useScheduleStore';
import { PX_PER_HOUR } from '../../lib/gantt';

/**
 * Horizontal zoom for the crew timeline — how many pixels an hour is worth.
 *
 * The board draws a full 06:00–20:00 day at a fixed scale, which is what lets
 * a 30-minute job stay a readable 44px instead of collapsing to a sliver on a
 * narrow window. The cost of a fixed scale is that the day no longer adapts to
 * the space it has: after the work queue collapses, the column is taller and
 * wider than the board wants, and the board just sits there at its one size.
 *
 * So the scale is a control rather than a constant. `fit` is the default and
 * solves for "the whole day, no horizontal scroll"; the steps above it trade
 * that overview for detail on a busy lane.
 */
const STEPS: number[] = [64, PX_PER_HOUR, 120, 168];

export function ZoomControl() {
  const hourZoom = useScheduleStore((s) => s.hourZoom);
  const setHourZoom = useScheduleStore((s) => s.setHourZoom);
  const viewMode = useScheduleStore((s) => s.viewMode);

  // The by-site grid has day columns, not an hour axis — there is no hour here
  // to scale, and a live control that changes nothing is worse than no control.
  if (viewMode !== 'crew') return null;

  const fitted = hourZoom === 'fit';
  const currentIndex = fitted ? -1 : STEPS.findIndex((s) => s >= (hourZoom as number));

  const step = (delta: number) => {
    // Stepping out of `fit` starts from the default rather than from whatever
    // width the container happened to resolve to, so the first click lands on
    // a predictable scale instead of a fractional one.
    const from = fitted ? STEPS.indexOf(PX_PER_HOUR) : currentIndex;
    const next = Math.min(STEPS.length - 1, Math.max(0, from + delta));
    setHourZoom(STEPS[next]);
  };

  return (
    <div
      className="glass-field flex h-8 items-center gap-0.5 rounded-lg px-0.5"
      role="group"
      aria-label="Timeline zoom"
    >
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={!fitted && currentIndex <= 0}
        aria-label="Zoom out, show more hours"
        title="Zoom out"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-overlay/[0.06] hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14M5 7h4" />
        </svg>
      </button>

      {/* `Fit` is a toggle, not a third step: it is the only setting whose
          value depends on the container, so it cannot sit on the same scale as
          the fixed ones. */}
      <button
        type="button"
        onClick={() => setHourZoom('fit')}
        aria-pressed={fitted}
        title="Fit the whole day to the window"
        className={`h-7 rounded-md px-2 text-micro font-medium transition-colors duration-150 ${
          fitted ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'
        }`}
      >
        Fit
      </button>

      <button
        type="button"
        onClick={() => step(1)}
        disabled={!fitted && currentIndex >= STEPS.length - 1}
        aria-label="Zoom in, show fewer hours in more detail"
        title="Zoom in"
        className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-overlay/[0.06] hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5 14 14M5 7h4M7 5v4" />
        </svg>
      </button>
    </div>
  );
}
