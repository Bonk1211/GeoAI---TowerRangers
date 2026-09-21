import { haversineKm } from './geo.ts';
import type { Crew, ScheduleEntry } from '../api/types';

/**
 * Every crew a planner may hand a ticket to, sorted into what the solver
 * would actually accept.
 *
 * WHY THIS EXISTS.
 *
 * The drawer's Assignee dropdown printed all 30 crews split only by
 * crew_type. Measured against a real Kelantan Power ticket, the group headed
 * "Power — suits this issue" offered eight crews of which ONE was
 * dispatchable:
 *
 *     KEL-P1  Kelantan       96 km   limit 100 km   IN RANGE
 *     TRG-P1  Terengganu    167 km   limit 150 km   too far
 *     PHG-P1  Pahang        235 km   limit 150 km   too far
 *     PLS-P1  Perlis        218 km   limit 100 km   too far
 *     SEL-P1  Selangor      222 km   limit  40 km   too far
 *     MLK-P1  Melaka        331 km   limit 100 km   too far
 *     SBH-P1  Sabah        1600 km   limit 200 km   too far
 *     LBN-P1  Labuan       1506 km   limit  60 km   too far
 *
 * A crew 1,600 km away across the South China Sea sat in the same list as the
 * one crew that could go, with nothing separating them. Worse, the SAME
 * drawer already disagreed with itself: the "Assignee Agent — suggested
 * crews" block below the dropdown is range-filtered and showed 1 while the
 * dropdown above showed 8.
 *
 * WHAT THIS DOES NOT DO: it never removes a crew. The range and capability
 * rules are the solver's, and a planner overriding them deliberately is a
 * real workflow — `scheduler/override.py` exists to honour exactly that and
 * documents a "never blocked" contract. So an unreachable crew stays
 * selectable; it just stops being presented as an equal option.
 *
 * `in_range` is defined EXACTLY as `rankCandidateCrews` defines it
 * (depot->site great-circle <= max_travel_km), because making the dropdown
 * agree with the suggestion block is the entire point. A third definition
 * here would recreate the disagreement it is fixing. The solver also requires
 * an exact territory match, which range usually implies but not always near a
 * state border — that is reported per crew rather than folded into the
 * grouping, so one rule stays one rule.
 */

export type CrewFit = 'in_range' | 'out_of_range' | 'other_capability';

/**
 * What a crew already owes the board across the whole planning horizon.
 *
 * THE HORIZON, NOT ONE DAY, and that was a correction. The first version read
 * `horizon[0]`, which is what the emergency approval path dispatches into —
 * but this dropdown books no day at all (`assignCrew` records a crew on the
 * ticket and nothing else), so a single day was arbitrary. It was also the
 * emptiest one: measured on a live national run, day 0 held 1 of 54 entries,
 * so 29 of 30 crews read "free that day" and the column said nothing.
 */
export interface CrewLoad {
  /** Jobs booked anywhere in the horizon. */
  jobs: number;
  /** How many distinct days carry at least one of them. */
  daysBooked: number;
  /** Days in the horizon, so the ratio is readable without a second source. */
  horizonDays: number;
  /** On-site plus travel minutes, over TIMED entries only. */
  bookedMin: number;
  /** Shift length times horizon days — the crew's capacity over the plan. */
  shiftMin: number;
  /**
   * Entries with no clock fields. Counted, never estimated — `lib/gantt.ts`
   * reports such a lane as `untimed` rather than inventing geometry for it,
   * and inventing minutes here would be the same bug wearing a different hat.
   */
  untimed: number;
}

export interface CrewOption {
  crew: Crew;
  fit: CrewFit;
  /** Depot to site, great-circle. Null when the tower could not be resolved. */
  distanceKm: number | null;
  /** Kilometres past this crew's own limit. Null unless out of range. */
  overByKm: number | null;
  /** False when the solver's exact-territory rule would refuse this crew. */
  territoryMatch: boolean | null;
  /** Null when there is no solved run — absence, never a zeroed load. */
  load: CrewLoad | null;
}

export interface CrewOptionGroups {
  /** The capability this ticket needs, or null when nothing can say. */
  neededType: string | null;
  inRange: CrewOption[];
  outOfRange: CrewOption[];
  otherCapability: CrewOption[];
  /** Days the loads describe, or 0 when there is no solved run to read. */
  horizonDays: number;
}

export interface GroupCrewOptionsInput {
  /**
   * The capability this ticket needs, from `ticketSkills.crewTypeForTicket()`.
   *
   * PASSED IN, NOT DERIVED HERE, for two reasons. It keeps that rule in one
   * place — the drawer already calls it, and a second caller re-deriving
   * "which trade does this need" is how the vegetation/Power mismatch got in
   * the first time. And it keeps this module free of runtime imports beyond
   * `geo.ts`: `ticketSkills` pulls three fixture modules whose own imports
   * carry no file extensions, which Node's ESM resolver refuses under
   * --experimental-strip-types, so importing it here would make this module
   * untestable by the pattern every other tested lib/ module uses.
   */
  neededType: string | null;
  /** Live tower record. Without it no distance can be computed. */
  tower?: { lon: number; lat: number; territory?: string } | null;
  crews: Crew[];
  /** The solved run's entries, or an empty list when nothing is solved. */
  entries?: ScheduleEntry[];
  /**
   * The solved run's horizon. An EMPTY horizon disables the load column
   * entirely — an unsolved board must read as absence, never as an empty
   * diary, which is the same rule `withOfflineFallback` follows for a zeroed
   * struct.
   */
  horizon?: string[];
}

function loadFor(crew: Crew, entries: ScheduleEntry[], horizonDays: number): CrewLoad {
  let jobs = 0;
  let bookedMin = 0;
  let untimed = 0;
  const days = new Set<string>();
  for (const e of entries) {
    if (e.crew_id !== crew.crew_id) continue;
    jobs += 1;
    days.add(e.day);
    if (typeof e.start_min === 'number' && typeof e.end_min === 'number') {
      bookedMin += e.end_min - e.start_min + (e.travel_min ?? 0);
    } else {
      untimed += 1;
    }
  }
  return {
    jobs,
    daysBooked: days.size,
    horizonDays,
    bookedMin,
    shiftMin: crew.shift_hours * 60 * horizonDays,
    untimed,
  };
}

export function groupCrewOptions({
  neededType,
  tower,
  crews,
  entries = [],
  horizon = [],
}: GroupCrewOptionsInput): CrewOptionGroups {
  // A solved horizon with no entries for a crew is a real answer (it is
  // free); no horizon at all is not an answer. Only the latter suppresses the
  // load column.
  const horizonDays = horizon.length;
  const inHorizon =
    horizonDays > 0 ? entries.filter((e) => horizon.includes(e.day)) : [];

  const options: CrewOption[] = crews.map((crew) => {
    const distanceKm = tower ? haversineKm(crew.depot, tower) : null;
    const capable = !neededType || crew.crew_type === neededType;
    const reachable = distanceKm !== null && distanceKm <= crew.max_travel_km;
    const fit: CrewFit = !capable ? 'other_capability' : reachable ? 'in_range' : 'out_of_range';
    return {
      crew,
      fit,
      distanceKm,
      overByKm:
        fit === 'out_of_range' && distanceKm !== null ? distanceKm - crew.max_travel_km : null,
      territoryMatch: tower?.territory ? crew.territory === tower.territory : null,
      load: horizonDays > 0 ? loadFor(crew, inHorizon, horizonDays) : null,
    };
  });

  // Nearest first within every group, including the override groups: a
  // planner deliberately reaching past the range limit still wants the least
  // unreasonable option at the top. Crews with no distance (unknown tower)
  // sort last rather than first, which is where an unknown belongs.
  const byDistance = (a: CrewOption, b: CrewOption) =>
    (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity);

  return {
    neededType,
    horizonDays,
    inRange: options.filter((o) => o.fit === 'in_range').sort(byDistance),
    outOfRange: options.filter((o) => o.fit === 'out_of_range').sort(byDistance),
    otherCapability: options.filter((o) => o.fit === 'other_capability').sort(byDistance),
  };
}

/**
 * The trailing half of an option's label — everything after the crew name.
 *
 * One function so the <option> text and any future row rendering cannot
 * drift; an <option> can carry only text, which is exactly why the distance
 * and the reason have to be IN the string rather than beside it.
 */
export function optionDetail(o: CrewOption): string {
  const parts: string[] = [o.crew.crew_id, o.crew.territory];
  if (o.distanceKm !== null) {
    parts.push(`${Math.round(o.distanceKm)} km`);
  }
  if (o.fit === 'out_of_range' && o.overByKm !== null) {
    parts.push(`past its ${o.crew.max_travel_km} km range by ${Math.round(o.overByKm)} km`);
  }
  if (o.territoryMatch === false && o.fit !== 'other_capability') {
    parts.push('another territory');
  }
  if (o.load) {
    parts.push(loadLabel(o.load));
  }
  return parts.join(' · ');
}

/**
 * A crew's commitments over the plan, in a few words.
 *
 * Jobs and days rather than hours. A manual assignment books no day, so the
 * planner's question is "is this crew already busy", which a 4.5h/56h ratio
 * answers far worse than "4 jobs on 3 of 7 days" — and the hours are a lower
 * bound anyway whenever any entry is untimed.
 *
 * "free" is only ever said when the crew has NOTHING in the horizon. A crew
 * carrying untimed work is reported as booked, because the one thing this
 * label must not do is promise capacity the board cannot back up.
 */
export function loadLabel(load: CrewLoad): string {
  if (load.jobs === 0) {
    return load.horizonDays === 7 ? 'free all week' : `free all ${load.horizonDays} days`;
  }
  const job = load.jobs === 1 ? '1 job' : `${load.jobs} jobs`;
  return `${job} on ${load.daysBooked}/${load.horizonDays} days`;
}
