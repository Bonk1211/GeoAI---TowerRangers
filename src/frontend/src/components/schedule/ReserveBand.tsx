import { RESERVE_HATCH_STYLE } from '../../lib/reserveHatch';

interface ReserveBandProps {
  crew_id: string;
  dayLabel: string;
  selected: boolean;
  onSelect: () => void;
}

/**
 * Full-width band for a lane whose crew-day is reserved (see
 * `GanttLane.reserveSpan` in `lib/gantt.ts` — always the full axis, since a
 * ReserveSlot marks the whole day, not an intraday clock range).
 *
 * Selecting it dispatches `{ kind: 'reserve', crew_id, day }`. Nothing renders
 * for that selection yet — `ReserveDetail` is Task 15 — so `WhySlotPanel`
 * correctly falls through to `null` for now.
 */
export function ReserveBand({ crew_id, dayLabel, selected, onSelect }: ReserveBandProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Reserve capacity, ${crew_id}, ${dayLabel}`}
      title="Held free — protected reserve capacity"
      /* Nearly the full lane, not inset-2. A reserved crew-day is the whole
         day — GanttLane.reserveSpan is always the full axis — so a band that
         floated with 8px of clearance on every side read as an object placed
         inside the day rather than as the day itself being held. The remaining
         vertical clearance is 2px, just enough to keep the band off the row
         rules above and below it. */
      className={`absolute inset-x-1 inset-y-0.5 flex items-center justify-center gap-1.5 overflow-hidden rounded-lg border bg-overlay/[0.06] transition-colors duration-150 ${
        selected ? 'border-accent/60' : 'border-overlay/12 hover:border-overlay/25'
      }`}
    >
      {/* The hatch rides its own layer at low opacity, not the button itself.
          --color-overlay is #0d1526, so painting the gradient at full strength
          turned a full-width band into black barber-pole striping — the
          loudest mark on a board where reserve is meant to recede behind
          booked work. Area scales apparent contrast: the same pattern that
          reads as a quiet texture in the week meter's 6px bar reads as a
          warning stripe across a whole lane. Keeping it off the button leaves
          the border and the RESERVE label at full strength. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.14]"
        style={RESERVE_HATCH_STYLE}
      />
      <span className="relative text-eyebrow font-medium tracking-wide text-dim">RESERVE</span>
    </button>
  );
}
