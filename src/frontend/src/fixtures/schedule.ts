import type { ReserveSlot, ScheduleEntry, ScheduleRun, UnscheduledDetail, WorkOrder } from '../api/types';

const PLACE_NAMES: Record<string, string> = {
  MY_1042: 'Gua Musang',
  MY_1000: 'Kuala Krai',
  MY_1001: 'Machang',
  MY_1002: 'Jeli',
  MY_1003: 'Kuala Lipis',
  MY_1004: 'Tanah Merah',
  MY_1005: 'Pasir Mas',
  MY_1006: 'Bachok',
  MY_1007: 'Pasir Puteh',
  MY_1008: 'Tumpat',
  MY_1009: 'Rantau Panjang',
  MY_1010: 'Kota Bharu',
  MY_1011: 'Kuala Krai',
  MY_1012: 'Dabong',
  MY_1013: 'Tanah Merah',
  MY_1014: 'Machang',
  MY_1015: 'Pasir Puteh',
  MY_1016: 'Jeli',
};

// Mirrors config/actions.yaml duration_hours. Kept in step by hand: this is
// the offline path only, and a mismatch shows up as a bar of the wrong width
// rather than as wrong scheduling.
const DURATION_BY_FACTOR: Record<string, number> = {
  flood: 4,
  terrain: 5,
  lightning: 2,
  equipment: 3,
  power: 2.5,
};

function wo(tower_id: string, dominant: string, urgency: number): WorkOrder {
  const actionByFactor: Record<string, { action: string; crew_type: string; parts: string[] }> = {
    flood: { action: 'Raise cabinet + seal ingress, clear drainage', crew_type: 'civil', parts: ['riser', 'sealant kit'] },
    power: { action: 'Inspect grid connection, service backup supply', crew_type: 'power', parts: ['battery pack', 'contactor'] },
    terrain: { action: 'Stabilize access route, inspect foundation', crew_type: 'civil', parts: ['anchor kit'] },
    equipment: { action: 'Replace generator module', crew_type: 'electrical', parts: ['generator unit'] },
  };
  const a = actionByFactor[dominant] ?? actionByFactor.equipment;
  return {
    tower_id,
    action: a.action,
    crew_type: a.crew_type,
    parts: a.parts,
    urgency_days: urgency,
    why: `Dominant factor: ${dominant}`,
    duration_hours: DURATION_BY_FACTOR[dominant] ?? 3,
  };
}

/**
 * Lays the fixture's crew-days onto a clock so the offline timeline has real
 * geometry to draw.
 *
 * This is fixture *content*, not a client-side derivation: online, every one of
 * these figures comes from scheduler/optimize.py, computed against the actual
 * route. Offline there is no route to measure, so the fixture states a flat
 * FIXTURE_TRAVEL_MIN per leg and says so, rather than the UI inventing travel
 * times behind the planner's back and presenting them as solver output.
 */
const FIXTURE_DAY_START_MIN = 9 * 60;
const FIXTURE_TRAVEL_MIN = 20;

function layOutClock(entries: ScheduleEntry[]): ScheduleEntry[] {
  const cursor = new Map<string, number>();
  return [...entries]
    .sort((a, b) => a.crew_id.localeCompare(b.crew_id) || a.day.localeCompare(b.day) || a.order - b.order)
    .map((e) => {
      const key = `${e.crew_id}__${e.day}`;
      const from = cursor.get(key) ?? FIXTURE_DAY_START_MIN;
      const start = from + FIXTURE_TRAVEL_MIN;
      const end = start + Math.round((e.work_order.duration_hours ?? 3) * 60);
      cursor.set(key, end);
      return { ...e, travel_min: FIXTURE_TRAVEL_MIN, start_min: start, end_min: end };
    });
}

const RAW_ENTRIES: ScheduleEntry[] = [
  { crew_id: 'SEL-C1', day: '2026-08-17', order: 1, tower_id: 'MY_1000', work_order: wo('MY_1000', 'flood', 12), pinned: false },
  { crew_id: 'SEL-C1', day: '2026-08-18', order: 1, tower_id: 'MY_1042', work_order: wo('MY_1042', 'flood', 14), pinned: false },
  { crew_id: 'SEL-C1', day: '2026-08-19', order: 1, tower_id: 'MY_1001', work_order: wo('MY_1001', 'terrain', 20), pinned: false },
  { crew_id: 'SEL-C1', day: '2026-08-21', order: 1, tower_id: 'MY_1002', work_order: wo('MY_1002', 'flood', 18), pinned: false },

  { crew_id: 'SEL-C2', day: '2026-08-17', order: 1, tower_id: 'MY_1003', work_order: wo('MY_1003', 'flood', 15), pinned: false },
  { crew_id: 'SEL-C2', day: '2026-08-18', order: 1, tower_id: 'MY_1004', work_order: wo('MY_1004', 'flood', 16), pinned: false },
  { crew_id: 'SEL-C2', day: '2026-08-19', order: 1, tower_id: 'MY_1005', work_order: wo('MY_1005', 'terrain', 22), pinned: false },

  { crew_id: 'SEL-P1', day: '2026-08-17', order: 1, tower_id: 'MY_1006', work_order: wo('MY_1006', 'power', 10), pinned: false },
  { crew_id: 'SEL-P1', day: '2026-08-19', order: 1, tower_id: 'MY_1007', work_order: wo('MY_1007', 'power', 13), pinned: false },
  {
    crew_id: 'SEL-P1',
    day: '2026-08-20',
    order: 1,
    tower_id: 'MY_1008',
    work_order: wo('MY_1008', 'power', 3),
    pinned: true,
    pin_reason: 'emergency',
  },

  {
    crew_id: 'SEL-C2',
    day: '2026-08-18',
    order: 2,
    tower_id: 'MY_1009',
    work_order: wo('MY_1009', 'flood', 17),
    pinned: true,
    pin_reason: 'planner_override',
  },

  { crew_id: 'SEL-E1', day: '2026-08-17', order: 1, tower_id: 'MY_1010', work_order: wo('MY_1010', 'equipment', 25), pinned: false },
];

export const SCHEDULE_ENTRIES: ScheduleEntry[] = layOutClock(RAW_ENTRIES);

export const UNSCHEDULED_TOWER_IDS: string[] = [
  'MY_1011',
  'MY_1012',
  'MY_1013',
  'MY_1014',
  'MY_1015',
  'MY_1016',
];

// The fixture states its own horizon and reserve as fixture CONTENT, the same
// way it states its own clock times. Handing the readiness board an empty
// reserve would render "0 protected crew-days" as though it were a
// measurement — the zeroed-struct failure the stability chip already shipped.
export const FIXTURE_HORIZON = [
  '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
  '2026-08-21', '2026-08-22', '2026-08-23',
];

// Every (crew_id, day) here must have zero matching entries in RAW_ENTRIES
// below — a reserve slot is a crew-day held free, and if it collides with a
// booked job the readiness board would paint a "held free" band straight
// through work the crew is actually doing. See RAW_ENTRIES for what each
// crew is booked on; the fix-report for task 5 lists the free-day check for
// each of these six slots.
export const FIXTURE_RESERVE: ReserveSlot[] = [
  { crew_id: 'SEL-C2', day: '2026-08-20', crew_type: 'civil' },
  { crew_id: 'SEL-C2', day: '2026-08-21', crew_type: 'civil' },
  { crew_id: 'SEL-C1', day: '2026-08-23', crew_type: 'civil' },
  { crew_id: 'SEL-P1', day: '2026-08-18', crew_type: 'power' },
  { crew_id: 'SEL-P1', day: '2026-08-21', crew_type: 'power' },
  { crew_id: 'SEL-P1', day: '2026-08-23', crew_type: 'power' },
];

// Reasons mirror the unscheduled towers' work: civil-crew flood/terrain jobs
// that lost out on capacity within the fixture's horizon, given plausible
// per-tower SLA deadlines.
export const UNSCHEDULED_DETAIL: UnscheduledDetail[] = [
  { tower_id: 'MY_1011', reason: 'no_capacity', deadline: '2026-08-21', crew_type: 'civil' },
  { tower_id: 'MY_1012', reason: 'no_capacity', deadline: '2026-08-22', crew_type: 'civil' },
  { tower_id: 'MY_1013', reason: 'no_capacity', deadline: '2026-08-20', crew_type: 'civil' },
  { tower_id: 'MY_1014', reason: 'no_capacity', deadline: '2026-08-23', crew_type: 'power' },
  { tower_id: 'MY_1015', reason: 'no_capacity', deadline: '2026-08-22', crew_type: 'power' },
  { tower_id: 'MY_1016', reason: 'no_capacity', deadline: '2026-08-24', crew_type: 'electrical' },
];

export const SCHEDULE_RUN: ScheduleRun = {
  run_id: 'run-2026-08-17',
  horizon: FIXTURE_HORIZON,
  entries: SCHEDULE_ENTRIES,
  reserve: FIXTURE_RESERVE,
  unscheduled: UNSCHEDULED_TOWER_IDS,
  unscheduled_detail: UNSCHEDULED_DETAIL,
  risk_weighted_wait: 2.4,
};

// Live Sunway IDs look like SUNWAY_OPERATOR_C_810851 — operator letter plus
// the source node the site was derived from.
const SUNWAY_ID = /^SUNWAY_OPERATOR_([A-Z])_(\d+)$/;

/**
 * Human label for a tower. Never return a bare ID if anything more meaningful
 * can be derived: the grid, drawer and agent transcript all read as opaque
 * hex-dumps otherwise (Frontend_Build_Plan.md §2.2, §5 grid rule).
 *
 * The Kelantan fixtures have real place names. The Sunway pilot has none —
 * it is a single 2 km² AOI, so a place name would be the same string 132
 * times. Operator + node is the distinction that actually matters there:
 * several operators share one physical mast (A/B/C all sit on node 701753),
 * and that collocation is invisible when every row shows the full ID.
 */
export function placeName(tower_id: string): string {
  const known = PLACE_NAMES[tower_id];
  if (known) return known;
  const sunway = SUNWAY_ID.exec(tower_id);
  if (sunway) return `Operator ${sunway[1]} · site ${sunway[2]}`;
  return tower_id;
}

/**
 * True when placeName() resolves to a real label rather than falling back to
 * the bare tower_id — a real-dataset tower outside the small offline-fixture
 * set (and outside the Sunway id shape) has no name here, so a caller wanting
 * a human label (not "MY_1017 · MY_1017") should prefer another field, e.g.
 * the tower record's own `territory`, instead.
 */
export function hasPlaceName(tower_id: string): boolean {
  return tower_id in PLACE_NAMES || SUNWAY_ID.test(tower_id);
}

/**
 * Site label for the derived `Operator X · site NNNN` form only — skips the
 * PLACE_NAMES table entirely. placeName()'s first branch returns Kelantan
 * town names that contradict the Sunway coordinates every scored tower
 * actually sits in (see CLAUDE.md "Known defects"); this helper exists so
 * callers that only ever see Sunway IDs don't risk hitting that branch.
 * Falls back to the bare tower_id, same as placeName() does.
 */
export function siteLabel(tower_id: string): string {
  const sunway = SUNWAY_ID.exec(tower_id);
  if (sunway) return `Operator ${sunway[1]} · site ${sunway[2]}`;
  return tower_id;
}

/**
 * `siteLabel` split into its two parts, for surfaces that lay the operator and
 * the site out separately rather than as one "Operator A · site 701753"
 * string.
 *
 * Three sites at one location differ only in their operator letter, which sits
 * at the START of the joined label — the hardest position to scan a list by.
 * Splitting lets a row lead with the site and demote the operator, so the rows
 * differ where the eye actually lands.
 *
 * Hoisted out of WorkQueue, which defined it privately; ScheduleGridByTower
 * needs the same split, and two copies of a parse of the same string is how
 * the two views end up disagreeing about what a tower is called.
 */
export function splitSiteLabel(tower_id: string): { operator: string | null; site: string } {
  const parts = siteLabel(tower_id).split(' · ');
  if (parts.length === 2) return { operator: parts[0], site: parts[1] };
  return { operator: null, site: siteLabel(tower_id) };
}
