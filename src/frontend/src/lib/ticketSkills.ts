import { CREWS } from '../fixtures/crews';
import { TOWERS } from '../fixtures/towers';
import { placeName } from '../fixtures/schedule';
import { haversineKm } from './geo';
import { crewTypeForFactor } from './actions';
import type { Ticket } from '../fixtures/tickets';
import type { Crew } from '../api/types';

// Mirrors the crew_type vocabulary in src/backend/config/actions.yaml
// (civil | power | electrical | rf), mapped from the ticket-side issue_type
// vocabulary rather than the tower-side dominant_factor one — the two don't
// share a word list. 'Other' has no fixed trade, so it isn't filtered by type.
const ISSUE_TYPE_TO_CREW_TYPE: Record<string, string | null> = {
  Equipment: 'rf',
  Power: 'power',
  Structural: 'civil',
  Other: null,
};

export interface CrewCandidate {
  crew: Crew;
  distance_km: number;
}

/**
 * Which crew capability this ticket needs, or null if nothing can say.
 *
 * "Other" maps to null — the reporter did not know what kind of fault it was.
 * That is a statement about the REPORTER, not about the tower, and treating
 * it as "any crew will do" ranked a Power crew alongside a Civil one for a
 * vegetation-dominant site purely on depot distance.
 *
 * The model already knows what is wrong with the tower. actions.yaml maps its
 * dominant factor to the crew type that answers it (vegetation -> civil) and
 * lib/actions.ts mirrors that map. So when the ticket cannot say, ask the
 * tower.
 *
 * Exported because the drawer's manual assignee picker must narrow to the
 * same capability the suggestion path ranks. Two copies of this rule is how
 * a planner ends up hand-assigning a crew the optimiser would have refused.
 */
export function crewTypeForTicket(
  ticket: Ticket,
  tower?: { dominant_factor?: string },
): string | null {
  return (
    ISSUE_TYPE_TO_CREW_TYPE[ticket.issue_type] ??
    (tower?.dominant_factor ? crewTypeForFactor(tower.dominant_factor) : null)
  );
}

export interface RankCandidateOptions {
  /**
   * The live tower record (api/useLiveTowers.ts::useLiveTower). Pass it
   * whenever the caller has one — the fixture fallback below cannot resolve a
   * real-dataset tower_id.
   */
  tower?: { lon: number; lat: number; dominant_factor?: string };
  /** The live roster (api/queries.ts::useCrewsQuery). */
  crews?: Crew[];
  limit?: number;
  /**
   * Drop the depot-range filter, returning the nearest crews of the right
   * type however far away they are.
   *
   * For EXPLAINING an empty result, never for dispatching one. "No crew is in
   * range" is unfalsifiable on its own — the planner cannot tell a genuinely
   * remote tower from a misconfigured roster, and both look like a broken
   * panel. A tower in northern Sarawak is 270 km from the nearest civil depot
   * against a 200 km limit; saying so turns a dead end into a fact.
   */
  ignoreRange?: boolean;
}

/**
 * Assignee Agent — real, deterministic. Same two hard constraints
 * scheduler/optimize.py applies for ML work orders: crew_type must match the
 * work, and depot->site distance must clear the crew's max_travel_km. There
 * is no tower `territory` field to filter on directly, so distance is the
 * substitute — it already captures the same "is this crew anywhere near it"
 * question the territory filter answers on the backend.
 *
 * PASS THE LIVE TOWER AND CREWS. The fixture fallbacks exist only so older
 * call sites keep compiling, and both of them silently mislead on real data:
 *
 *  - `TOWERS` is the offline mock (MY_1000-MY_1043). A ticket raised by the
 *    Tickets page's demo button carries a real OSM id (MY_N10736133691), which
 *    is absent from it — so the lookup fails and this returns [] for exactly
 *    the tickets the feature exists to serve. It reads as "no crew in range".
 *  - `CREWS` is a 12-crew fixture; config/crews.json rosters 30 across all 16
 *    territories. Ranking against the fixture cannot offer a Penang or Sabah
 *    crew for a tower in those states, even though the solver has one.
 */
export function rankCandidateCrews(
  ticket: Ticket,
  options: RankCandidateOptions = {},
): CrewCandidate[] {
  const tower = options.tower ?? TOWERS.find((t) => t.tower_id === ticket.tower_id);
  if (!tower) return [];
  const roster = options.crews ?? CREWS;
  const limit = options.limit ?? 3;
  const crewType = crewTypeForTicket(ticket, tower);

  return roster
    .filter((c) => !crewType || c.crew_type === crewType)
    .map((crew) => ({ crew, distance_km: haversineKm(crew.depot, tower) }))
    .filter((c) => options.ignoreRange || c.distance_km <= c.crew.max_travel_km)
    .sort((a, b) => a.distance_km - b.distance_km)
    .slice(0, limit);
}

/**
 * Issue Descriptor — mocked. Canned per-issue-type expansion, not live
 * reasoning over the ticket text. Must read as a draft, never as fact.
 */
export function draftDescription(ticket: Ticket): string {
  const tower = TOWERS.find((t) => t.tower_id === ticket.tower_id);
  const site = tower ? placeName(tower.tower_id) : ticket.tower_id;
  const byType: Record<string, string> = {
    Equipment:
      'Likely a hardware fault local to the unit rather than a network-wide issue. Suggested next step: on-site visual inspection of the affected module, check for loose connectors or corrosion before ordering a replacement part.',
    Power:
      'Consistent with a degraded battery or unstable grid feed. Suggested next step: load-test the backup supply and verify grid voltage stays in range under peak draw.',
    Structural:
      'Physical condition issue at the site, not an equipment fault. Suggested next step: inspect the affected structure and surrounding ground/drainage for the underlying cause before scheduling repair.',
    Other:
      'Not enough detail yet to narrow this to a known category. Suggested next step: request a follow-up photo or note from the reporter before dispatching a crew.',
  };
  const body = byType[ticket.issue_type] ?? byType.Other;
  return `${site}: ${body}`;
}

/**
 * Validation Assistant — mocked, draft only. Never sets resolution or moves
 * status itself (docs/Ticket_System_Handoff.md §5) — the human still clicks
 * Confirm Issue / Mark False Positive.
 */
export function draftCloseoutSummary(ticket: Ticket): string {
  const tower = TOWERS.find((t) => t.tower_id === ticket.tower_id);
  const site = tower ? placeName(tower.tower_id) : ticket.tower_id;
  const lastNote = ticket.fix_notes[ticket.fix_notes.length - 1];
  if (!lastNote) {
    return `${site}: no fix note on file yet — ask the assignee to log what was done before validating.`;
  }
  return `${site}: ${lastNote.author} reported "${lastNote.text}" on ${new Date(lastNote.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. Consistent with a resolved ${ticket.issue_type.toLowerCase()} issue — review before confirming.`;
}
