import { placeName } from '../../fixtures/schedule';
import { dayLabel } from '../../lib/scheduleDays';
import type { Selection } from '../../state/useScheduleStore';
import { useScheduleSelection } from '../../state/useScheduleSelection';
import { bandColor, bandInk } from '../../lib/colors';
import { roleColor, roleInk, tintedChip } from '../../lib/roleColors';
import { clockLabel, durationLabel, type GanttAxis, type GanttBar, type GanttLane } from '../../lib/gantt';
import type { RoleTeam } from '../../lib/roleTeams';
import type { Tower } from '../../api/types';
import { ReserveBand } from './ReserveBand';

/**
 * Left rail width, shared with TimelineBoard's hour-axis header so the axis
 * lines up.
 *
 * Widened from 208px when the rail became a two-row grid: at 208 the depot
 * line and the utilisation meter could not share a row without the meter
 * wrapping, which is what made the column read as a ragged stack rather than
 * as a rail.
 */
export const RAIL = '224px';

function GlyphIcon({ d, className = 'h-3.5 w-3.5' }: { d: string | undefined; className?: string }) {
  if (!d) return null;
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`${className} shrink-0`} fill="none">
      <path d={d} stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The team glyph in a role-tinted chip — the same tinted-chip construction the
 * map console uses for its band chip, at rail scale. This is what carries role
 * identity down the length of the board once the group header has scrolled
 * away.
 */
function RoleChip({ team, size = 'sm' }: { team: RoleTeam; size?: 'sm' | 'md' }) {
  const box = size === 'md' ? 'h-6 w-6' : 'h-5 w-5';
  return (
    <span
      aria-hidden="true"
      className={`${box} flex shrink-0 items-center justify-center rounded-md border`}
      style={tintedChip(roleColor(team.tone), roleInk(team.tone))}
    >
      <GlyphIcon d={team.glyph} className={size === 'md' ? 'h-3.5 w-3.5' : 'h-3 w-3'} />
    </span>
  );
}

/**
 * The crew's avatar disc — initials in a role-tinted circle.
 *
 * The rail is a roster, and a roster reads as a contact list: a face, a name,
 * what they do, and one figure about them. There are no crew photographs in
 * this dataset (the roster is `crews.json`: an id, a type, a depot), so the
 * disc carries derived initials rather than a placeholder portrait — an empty
 * avatar frame would promise an identity the data cannot supply.
 *
 * aria-hidden because the crew id sits beside it in text; the initials are a
 * compression of that same string, not extra information.
 */
function CrewAvatar({ crewId, team }: { crewId: string; team: RoleTeam }) {
  // "SEL-C1" -> "C1": the territory prefix is identical for every crew in the
  // rail, so initialling it would give every row the same disc.
  const initials = (crewId.split('-').pop() ?? crewId).slice(0, 2).toUpperCase();
  return (
    <span
      aria-hidden="true"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border text-micro font-semibold"
      style={tintedChip(roleColor(team.tone), roleInk(team.tone), '1f', '59')}
    >
      {initials}
    </span>
  );
}

/**
 * Utilisation as a meter row, built to the same recipe as the map console's
 * band rows: a 5px track, a fill that transitions its width, and a
 * fixed-width tabular percentage so the column cannot jitter as numbers
 * update.
 *
 * The fill ramp escalates with load — role hue while there is slack, accent
 * as the crew fills, and the watch band once it is effectively committed — so
 * an over-committed crew is findable by scanning the rail rather than by
 * reading every percentage. Colour is never the only channel: the percentage
 * and the title/aria text say the same thing in words.
 */
function UtilisationChip({ lane, team }: { lane: GanttLane; team: RoleTeam }) {
  if (lane.reserved) {
    return <span className="text-micro text-dim">Reserved</span>;
  }
  if (lane.utilisationPct === null) {
    return <span className="text-micro text-dim">Free</span>;
  }

  const pct = lane.utilisationPct;
  const fill =
    pct > 85 ? 'var(--color-watch)' : pct >= 60 ? 'var(--color-accent)' : roleColor(team.tone);
  const load = pct > 85 ? 'near capacity' : pct >= 60 ? 'well committed' : 'has slack';
  const words = `${durationLabel(lane.bookedMin)} of ${durationLabel(lane.shiftMin)} committed — ${load}`;

  return (
    <span className="flex shrink-0 flex-col items-end gap-1" title={words} aria-label={words}>
      <span className="flex items-center gap-1 text-muted">
        {/* The clock says what the number measures. Without it a bare
            percentage beside a name reads as a score for the crew rather than
            as how much of their day is committed. */}
        <svg viewBox="0 0 16 16" aria-hidden="true" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.8V8l2.2 1.4" strokeLinecap="round" />
        </svg>
        <span className="tnum text-micro font-medium">{pct}%</span>
      </span>
      <span className="h-[5px] w-10 overflow-hidden rounded-full bg-overlay/[0.07]">
        <span
          className="block h-full rounded-full transition-[width] duration-300"
          style={{ width: `${pct}%`, backgroundColor: fill }}
        />
      </span>
    </span>
  );
}

/**
 * Average utilisation across the lanes in a group that have a rated
 * utilisation (bars, not reserved, not empty). `null` when nothing in the
 * group can be rated — an all-reserved or all-empty group must not report a
 * fabricated 0%.
 */
function aggregateUtilisation(lanes: GanttLane[]): number | null {
  const rated = lanes.filter((l) => l.utilisationPct !== null);
  if (rated.length === 0) return null;
  // An "average" over one crew is that crew's own number, printed a second
  // time a few pixels above itself. On this territory most groups staff one
  // rated crew, so the header meter was almost always a duplicate of the rail
  // meter directly under it — two identical readouts implying two different
  // measurements. A group figure only earns its place once it is aggregating
  // something.
  if (rated.length < 2) return null;
  const totalBooked = rated.reduce((sum, l) => sum + l.bookedMin, 0);
  const totalShift = rated.reduce((sum, l) => sum + l.shiftMin, 0);
  if (totalShift === 0) return null;
  return Math.min(100, Math.round((totalBooked / totalShift) * 100));
}

interface BarProps {
  bar: GanttBar;
  tower: Tower | undefined;
  selected: boolean;
  onSelect: () => void;
}

function Bar({ bar, tower, selected, onSelect }: BarProps) {
  const setHoveredTower = useScheduleSelection((s) => s.setHoveredTower);
  const { entry } = bar;
  const band = tower ? bandColor(tower.decision) : 'var(--color-accent)';
  const ink = tower ? bandInk(tower.decision) : 'var(--color-accent)';
  const wide = bar.widthPct > 11;

  return (
    <>
      {/* Travel connector. The drive between two stops is drawn, not
          implied, so a crew-day reads as a route rather than a stack of
          unrelated jobs. */}
      {bar.travelMin > 0 && bar.travelWidthPct > 0.4 && (
        <div
          className="pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center justify-center"
          style={{ left: `${bar.travelLeftPct}%`, width: `${bar.travelWidthPct}%` }}
        >
          <span className="h-px w-full bg-overlay/25" />
          {/* 2.4% is roughly a 15-minute leg on a full 10-hour axis — below
              that the pill is wider than the gap it labels and starts
              overlapping the bars either side. */}
          {bar.travelWidthPct > 2.4 && (
            <span className="tnum absolute whitespace-nowrap rounded bg-ink-900 px-1 text-eyebrow text-dim">
              {bar.travelMin}m
            </span>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={onSelect}
        onMouseEnter={() => setHoveredTower(entry.tower_id)}
        onMouseLeave={() => setHoveredTower(null)}
        onFocus={() => setHoveredTower(entry.tower_id)}
        onBlur={() => setHoveredTower(null)}
        aria-pressed={selected}
        aria-label={`${placeName(entry.tower_id)}, ${clockLabel(bar.startMin)} to ${clockLabel(
          bar.endMin,
        )}, ${entry.crew_id}${entry.pinned ? ', pinned' : ''}`}
        title={`${placeName(entry.tower_id)} · ${clockLabel(bar.startMin)}–${clockLabel(bar.endMin)} · ${durationLabel(
          bar.durationMin,
        )}${bar.travelMin ? ` · ${bar.travelMin}m drive` : ''}`}
        /* The severity ramp used to reach this bar as a 3px left border and
           nothing else — about 2% of a 46px bar's area on a white fill, which
           is why every bar on the board looked alike. The band now washes the
           whole surface via the same tinted-chip recipe the map console's band
           chip uses, and the spine stays on top of it.

           Hover and selection change colour and shadow only. Anything that
           changed the box would reflow a row of absolutely-positioned bars
           under the pointer that is hovering them. */
        className={`group absolute top-1/2 flex -translate-y-1/2 items-center gap-2 overflow-hidden rounded-lg border px-2 text-left transition-[background-color,border-color,box-shadow] duration-150 ${
          selected ? 'shadow-[var(--shadow-2)] ring-2 ring-accent' : 'hover:shadow-[var(--shadow-1)]'
        }`}
        style={{
          left: `${bar.leftPct}%`,
          width: `${bar.widthPct}%`,
          height: '46px',
          backgroundColor: selected ? `${band}2e` : `${band}1a`,
          borderColor: `${band}66`,
          borderLeft: `3px solid ${band}`,
        }}
      >
        <span className="flex min-w-0 flex-col justify-center">
          <span className="flex items-center gap-1 truncate text-ui font-semibold text-fg">
            {entry.pinned && (
              <svg viewBox="0 0 12 12" aria-hidden="true" className="h-2.5 w-2.5 shrink-0" fill="none">
                {/* Shape, not just colour: an emergency is a triangle, a planner
                    pin is a disc, so the two survive a greyscale print. */}
                {entry.pin_reason === 'emergency' ? (
                  <path d="M6 1 11 10.5H1Z" fill="var(--color-alert)" />
                ) : (
                  <circle cx="6" cy="6" r="4" fill="var(--color-accent)" />
                )}
              </svg>
            )}
            <span className="truncate">{placeName(entry.tower_id)}</span>
          </span>
          {wide && (
            <span className="tnum truncate text-eyebrow text-muted">{clockLabel(bar.startMin)}</span>
          )}
        </span>

        {/* The risk value, as the map console draws a band chip: ink text
            inside a band-edged chip. Only when the bar is wide enough to hold
            it without crowding out the place name, which is the label that
            identifies the job.

            The chip lightens rather than deepens. Measured: bandInk on a band
            wash over the already-band-washed bar gives 4.09:1 for maintain and
            4.38:1 for ok — both under AA for a 10px value the planner has to
            read. Lifting the chip toward white instead puts the worst case at
            5.38:1, and reads as a raised chip rather than a darker smear on an
            already-tinted bar. */}
        {wide && tower && (
          <span
            className="tnum ml-auto shrink-0 rounded border bg-white/70 px-1.5 py-0.5 text-eyebrow font-semibold"
            style={{ color: ink, borderColor: `${band}59` }}
          >
            {tower.risk.toFixed(2)}
          </span>
        )}
      </button>
    </>
  );
}

interface RoleGroupProps {
  team: RoleTeam;
  /**
   * Whether this crew type has any work behind it this run — booked on any
   * day, or waiting to be scheduled. False means the role is workless, not
   * merely idle today, which is what `team.emptyReason` describes.
   */
  hasWork: boolean;
  lanes: GanttLane[];
  axis: GanttAxis;
  selectedDay: string;
  selection: Selection | null;
  select: (sel: Selection | null) => void;
  towersById: Map<string, Tower>;
  /**
   * Set of crew ids the active filter matches. Lanes outside it are dimmed
   * rather than removed — see TimelineBoard for why. `null` means no filter
   * is active and every lane renders at full strength.
   */
  matchedCrewIds: Set<string> | null;
  /**
   * Intrinsic pixel width of the lane area, from `axisWidthPx`. Lanes are
   * sized in pixels rather than stretched to the column so an hour is always
   * the same width and a long day overflows into a horizontal scroll instead
   * of compressing every bar.
   */
  laneWidth: number;
}

/**
 * One capability group — civil, power, rf or electrical — grouping the
 * crew-day lanes for that `crew_type` under a header carrying the team
 * label, glyph, the Annex C factor(s) its work orders answer, and the
 * group's aggregate utilisation.
 *
 * Empty groups render their `emptyReason` rather than vanishing: on the
 * Sunway AOI most towers resolve to civil work, so an unexplained missing
 * group would read as a bug rather than as "this capability has nothing to
 * do here today."
 *
 * `lanes.length === 0` is only one of the two ways a group can be empty, and
 * on the demo territory it is the one that never happens: Selangor staffs all
 * four types, so the electrical group used to draw a staffed lane inviting
 * "Free — assign work" for work that cannot exist (A5 is absent from the
 * dataset). When `hasWork` is false the reason is stated at the lane instead
 * — spec 5.2(2) / 14 check 3.
 */
export function RoleGroup({
  team,
  hasWork,
  lanes,
  axis,
  selectedDay,
  selection,
  select,
  towersById,
  matchedCrewIds,
  laneWidth,
}: RoleGroupProps) {
  const span = axis.endMin - axis.startMin;
  const tickPct = (t: number) => ((t - axis.startMin) / span) * 100;
  const aggPct = aggregateUtilisation(lanes);
  const hue = roleColor(team.tone);
  const hueInk = roleInk(team.tone);

  return (
    <section aria-label={team.label} style={{ borderLeft: `3px solid ${hue}` }}>
      {/* The header is a role-tinted band rather than another white strip. The
          wash fades out to the right so it never competes with the bars it
          sits above, and the rail-width spacer is a real element: the old
          `paddingLeft: calc(RAIL - 16px)` was arithmetic guessing at where the
          rail's own padding put its content, and it did not land on it. */}
      <div
        className="sticky top-9 z-[5] flex items-center border-b border-overlay/[0.07] py-2 backdrop-blur-sm"
        style={{
          background: `linear-gradient(90deg, ${hue}1f, ${hue}0a 42%, rgba(242,245,250,0.94) 82%)`,
        }}
      >
        {/* Sticky alongside the rails below it, and carrying its own copy of
            the header wash so the group label does not scroll away from the
            crews it labels. */}
        <div
          className="sticky left-0 z-[1] flex shrink-0 items-center gap-2 px-3.5"
          style={{ width: RAIL, background: `linear-gradient(90deg, ${hue}1f, ${hue}17)` }}
        >
          <RoleChip team={team} size="md" />
          {/* The Annex C factors this team answers (`team.answers`) used to sit
              beside the label as a pill. It is provenance — why this crew type
              exists at all — not something a planner reads while placing work,
              and repeating it on every group turned four header rows into four
              lines of compliance footnote across the board. It stays reachable
              on hover and to a screen reader, where provenance belongs. */}
          <span
            className="text-body font-semibold"
            style={{ color: hueInk }}
            title={`${team.label} — answers ${team.answers}`}
          >
            {team.label}
            <span className="sr-only"> — answers {team.answers}</span>
          </span>
        </div>

        {aggPct !== null && (
          /* Sits beside the pill, not pushed to the far right with ml-auto:
             the row is now as wide as the whole scrollable day, so "right"
             is off-screen until the planner scrolls to the end of it. */
          <span
            className="ml-3 flex items-center gap-1.5"
            title={`Group utilisation, averaged across ${lanes.filter((l) => l.utilisationPct !== null).length} rated crews`}
          >
            <span className="h-[5px] w-10 overflow-hidden rounded-full bg-overlay/[0.09]">
              <span
                className="block h-full rounded-full transition-[width] duration-300"
                style={{ width: `${aggPct}%`, backgroundColor: hue }}
              />
            </span>
            <span className="tnum text-micro text-muted">{aggPct}%</span>
          </span>
        )}
      </div>

      {lanes.length === 0 ? (
        <p className="border-b border-overlay/[0.07] px-4 py-3 text-micro text-dim">{team.emptyReason}</p>
      ) : (
        lanes.map((lane) => {
          const isSelectedLane =
            selection !== null &&
            'crew_id' in selection &&
            selection.crew_id === lane.crew.crew_id &&
            selection.day === selectedDay;
          // Filtered-out lanes recede but stay in place, so the board keeps
          // its shape and the planner does not lose their position in it.
          const dimmed = matchedCrewIds !== null && !matchedCrewIds.has(lane.crew.crew_id);
          return (
            <div
              key={lane.crew.crew_id}
              className={`flex border-b border-overlay/[0.07] transition-[background-color,opacity] duration-150 ${
                dimmed ? 'opacity-45' : 'opacity-100'
              } ${isSelectedLane ? 'bg-accent/[0.07]' : 'hover:bg-overlay/[0.02]'}`}
            >
              {/* Crew rail, laid out as a contact row: avatar, then name over
                  role, then the one figure about them aligned right.

                  Sticky on the horizontal axis so the roster stays readable
                  while the day scrolls underneath it — a timeline you can
                  scroll away from its own row labels is a grid with no key.
                  It needs an opaque background for the bars to pass behind,
                  which is why this is bg-ink-900 and not a glass surface. */}
              <div
                className="sticky left-0 z-[4] flex shrink-0 items-center gap-2.5 border-r border-overlay/[0.07] px-3.5 py-2.5"
                style={{
                  width: RAIL,
                  // color-mix on the accent token rather than a hardcoded
                  // tint: the rail must be OPAQUE (bars scroll behind it), so
                  // it cannot use the row's accent/[0.07] wash, and a literal
                  // hex here would be a fifth place the accent is spelled out.
                  background: isSelectedLane
                    ? 'color-mix(in srgb, var(--color-accent) 7%, var(--color-ink-900))'
                    : 'var(--color-ink-900)',
                }}
              >
                <CrewAvatar crewId={lane.crew.crew_id} team={team} />

                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-ui font-semibold text-fg">{lane.crew.crew_id}</span>
                  {/* team.label, not capitalize(crew_type): CSS capitalize
                      turns "rf" into "Rf". The team already carries the
                      correct display name for every role. */}
                  <span className="truncate text-micro text-muted">
                    {team.label} · {lane.crew.depot.name}
                  </span>
                </span>

                <span className="ml-auto">
                  <UtilisationChip lane={lane} team={team} />
                </span>
              </div>

              {/* Lane */}
              <div className="relative min-h-[68px] shrink-0" style={{ width: laneWidth }}>
                {/* Hour gridlines, kept low-contrast so they never compete with
                    bars. The closing tick is deliberately skipped: a 1px rule
                    at left:100% overflows the lane and makes the whole board
                    scrollable by exactly one pixel, which renders as a
                    full-width scrollbar. */}
                {axis.ticks.slice(0, -1).map((t, i) => (
                  <span
                    key={t}
                    aria-hidden="true"
                    className="absolute inset-y-0 border-l border-overlay/[0.06]"
                    style={{
                      left: `${tickPct(t)}%`,
                      // Alternating hour bands. A bar's x-position is
                      // otherwise readable only by tracing up to the axis;
                      // the wash gives the eye something to count against.
                      // Width is measured to the NEXT tick rather than assumed
                      // uniform, because buildAxis can emit a short final hour.
                      width: `${(axis.ticks[i + 1] !== undefined ? tickPct(axis.ticks[i + 1]) : 100) - tickPct(t)}%`,
                      backgroundColor: i % 2 === 1 ? 'rgba(13,21,38,0.025)' : 'transparent',
                    }}
                  />
                ))}

                {lane.reserved ? (
                  <ReserveBand
                    crew_id={lane.crew.crew_id}
                    dayLabel={dayLabel(selectedDay)}
                    selected={selection?.kind === 'reserve' && isSelectedLane}
                    onSelect={() => select({ kind: 'reserve', crew_id: lane.crew.crew_id, day: selectedDay })}
                  />
                ) : lane.bars.length === 0 ? (
                  hasWork ? (
                    <button
                      type="button"
                      onClick={() => select({ kind: 'free', crew_id: lane.crew.crew_id, day: selectedDay })}
                      aria-label={`Free day, ${lane.crew.crew_id}, ${dayLabel(selectedDay)}`}
                      /* The role tint arrives on hover through a custom
                         property rather than an inline borderColor, so the
                         resting and hovered states stay in CSS where the
                         transition can interpolate between them. */
                      className="absolute inset-x-1 inset-y-0.5 rounded-lg border border-dashed border-overlay/10 text-micro text-dim transition-colors duration-150 hover:border-[color:var(--role-hue)] hover:bg-overlay/[0.04] hover:text-muted"
                      style={{ '--role-hue': `${hue}59` } as React.CSSProperties}
                    >
                      Free — assign work
                    </button>
                  ) : (
                    <p className="absolute inset-y-0 left-3 flex items-center pr-3 text-micro text-dim">
                      {team.emptyReason}
                    </p>
                  )
                ) : (
                  lane.bars.map((bar) => (
                    <Bar
                      key={bar.entry.tower_id}
                      bar={bar}
                      tower={towersById.get(bar.tower_id)}
                      selected={
                        selection?.kind === 'job' &&
                        selection.tower_id === bar.entry.tower_id &&
                        selection.crew_id === lane.crew.crew_id &&
                        selection.day === selectedDay
                      }
                      onSelect={() =>
                        select({
                          kind: 'job',
                          crew_id: lane.crew.crew_id,
                          day: selectedDay,
                          tower_id: bar.entry.tower_id,
                        })
                      }
                    />
                  ))
                )}

                {lane.untimed && (
                  <p className="absolute inset-y-0 left-3 flex items-center text-micro text-watch-ink">
                    Scheduled, but this run carries no times
                  </p>
                )}
              </div>
            </div>
          );
        })
      )}
    </section>
  );
}
