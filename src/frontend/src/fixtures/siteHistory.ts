export interface SiteParameterRecord {
    date: string;           // ISO date of assessment "2026-08-25"
    risk: number;           // 0–1
    risk_lo: number;
    risk_hi: number;
    decision: 'maintain' | 'watch' | 'ok';
    hand_m: number;         // Height Above Nearest Drainage (m)
    dist_water_m: number;   // Distance to nearest water body (m)
    slope_deg: number;      // Terrain slope (degrees)
    tri: number;            // Terrain Ruggedness Index
    flash_density: number;  // Lightning fl/km²/yr
    dist_power_m: number;   // Distance to power grid (m)
    radio: 'GSM' | 'UMTS' | 'LTE' | 'NR' | 'UNKNOWN';
    notes?: string;         // optional field-team note
}

export interface VisitReport {
    id: string;             // "MAINT-2026-008"
    status: 'pending' | 'completed' | 'cancelled';
    scheduled_date: string; // ISO
    completed_date?: string;
    crew_id: string;
    crew_name: string;
    action: string;         // work order action label
    description: string;    // summary of work done / planned
    risk_before?: number;
    risk_after?: number;
    report_url?: string;    // future: link to PDF report
}

// ---------------------------------------------------------------------------
// Deterministic PRNG — same mulberry32 used in towers.ts, re-seeded per tower
// ---------------------------------------------------------------------------
function makeRand(seed: number) {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function seedFromId(towerId: string): number {
    let h = 0;
    for (let i = 0; i < towerId.length; i++) {
        h = (Math.imul(31, h) + towerId.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}

// ---------------------------------------------------------------------------
// Option B: derive GIS base values from attribution shares
// ---------------------------------------------------------------------------
function deriveGisBase(
    attribution: Record<string, number>,
    // 'UNKNOWN' arrives from the national table, where 96% of OSM masts carry
    // no generation tag. Nothing here branches on radio — it is passed through
    // to the record unchanged — so the widening costs nothing and the string
    // reaches the UI intact rather than being coerced into a generation the
    // source never claimed.
    radio: 'GSM' | 'UMTS' | 'LTE' | 'NR' | 'UNKNOWN',
    rand: () => number
) {
    const flood = attribution['flood'] ?? 0;
    const terrain = attribution['terrain'] ?? 0;
    const power = attribution['power'] ?? 0;

    // HAND: inversely proportional to flood share
    // High flood (>0.4) → very low HAND 0.2–1.0 m (near drainage)
    // Low flood (<0.15) → high HAND 3.0–6.0 m (safely elevated)
    const hand_m = flood > 0.4
        ? Number((0.2 + rand() * 0.8).toFixed(1))
        : flood > 0.25
            ? Number((1.0 + rand() * 1.5).toFixed(1))
            : Number((2.5 + rand() * 3.5).toFixed(1));

    // dist_water: also inversely proportional to flood share
    const dist_water_m = flood > 0.4
        ? Math.round(50 + rand() * 150)
        : flood > 0.25
            ? Math.round(200 + rand() * 250)
            : Math.round(450 + rand() * 500);

    // slope: proportional to terrain share
    const slope_deg = terrain > 0.35
        ? Number((18 + rand() * 17).toFixed(1))   // steep 18–35°
        : terrain > 0.2
            ? Number((8 + rand() * 10).toFixed(1))    // moderate 8–18°
            : Number((2 + rand() * 6).toFixed(1));    // gentle 2–8°

    // TRI: also follows terrain
    const tri = terrain > 0.35
        ? Number((2.5 + rand() * 1.5).toFixed(1))
        : terrain > 0.2
            ? Number((1.2 + rand() * 1.3).toFixed(1))
            : Number((0.6 + rand() * 0.7).toFixed(1));

    // flash_density: NOT attributable.
    //
    // This read attribution['lightning'], but FACTORS is flood/power/terrain/
    // equipment — there is no lightning factor, so the share was always
    // undefined, the high branch was unreachable, and every tower in the
    // fixture got the same low 1.0-3.0 range. Lightning is a site property the
    // model does not currently score, so it is drawn from the tower's own seed
    // and varies per site without claiming a factor that does not exist.
    const flash_density = Number((0.8 + rand() * 4.4).toFixed(1));

    // dist_power: inversely proportional to power share
    const dist_power_m = power > 0.35
        ? Math.round(1500 + rand() * 1500)
        : power > 0.2
            ? Math.round(700 + rand() * 800)
            : Math.round(200 + rand() * 500);

    return { hand_m, dist_water_m, slope_deg, tri, flash_density, dist_power_m, radio };
}

// ---------------------------------------------------------------------------
// Action / crew templates per dominant factor
// ---------------------------------------------------------------------------
const FACTOR_ACTIONS: Record<string, { action: string; crew_id: string; crew_name: string; description: string }[]> = {
    flood: [
        {
            action: 'Civil & drainage works', crew_id: 'SEL-C1', crew_name: 'Subang Jaya Civil 1',
            description: 'Foundation grout repaired · Drainage cleared · Ground condition reset · Settlement remedied'
        },
        {
            action: 'Flood barrier installation', crew_id: 'KEL-C1', crew_name: 'Kota Bharu Civil 1',
            description: 'Flood berm constructed · Drainage channels cleared · Sand-bagging completed'
        },
    ],
    terrain: [
        {
            action: 'Structural reinforcement', crew_id: 'SEL-C2', crew_name: 'Shah Alam Civil 2',
            description: 'Slope stabilisation works · Retaining mesh installed · Access road cleared'
        },
    ],
    power: [
        {
            action: 'Power system service', crew_id: 'SEL-E1', crew_name: 'Shah Alam Electrical 1',
            description: 'Generator serviced · Power transfer switch tested · Grid connection inspected'
        },
    ],
    equipment: [
        {
            action: 'RF unit refresh', crew_id: 'SEL-R1', crew_name: 'Petaling Jaya RF 1',
            description: 'Radio unit replaced · Antenna alignment verified · RRU software updated'
        },
    ],
};

function getTemplate(factor: string, rand: () => number) {
    const list = FACTOR_ACTIONS[factor] ?? FACTOR_ACTIONS['equipment'];
    return list[Math.floor(rand() * list.length)];
}

// ---------------------------------------------------------------------------
// Generate 5-snapshot history + visit reports for a tower
// ---------------------------------------------------------------------------
import type { Tower } from '../api/types';

const GENERATED_CACHE: Record<string, { history: SiteParameterRecord[]; visits: VisitReport[] }> = {};

/**
 * Cache key, not just the tower id.
 *
 * The newest snapshot is the tower's live risk, and risk is recomputed from
 * the weight sliders. Keying on id alone meant the history was frozen at
 * whatever the weights happened to be the first time a site was opened: move a
 * slider, come back, and the page header showed the new risk while the chart
 * and the parameter log still plotted the old one as "today".
 */
function cacheKey(tower: Tower): string {
    return `${tower.tower_id}:${tower.risk.toFixed(3)}:${tower.dominant_factor}`;
}

// Pre-seeded MY_1042 is the demo anchor — always use the hand-crafted data
const MY1042_HISTORY: SiteParameterRecord[] = [
    {
        date: '2026-08-25', risk: 0.94, risk_lo: 0.88, risk_hi: 0.97, decision: 'maintain',
        hand_m: 0.4, dist_water_m: 83, slope_deg: 6.2, tri: 1.3, flash_density: 2.1, dist_power_m: 930, radio: 'LTE',
        notes: 'Risk spike post-flood season. Immediate action required.'
    },
    {
        date: '2025-10-14', risk: 0.48, risk_lo: 0.43, risk_hi: 0.54, decision: 'watch',
        hand_m: 1.1, dist_water_m: 240, slope_deg: 5.8, tri: 1.2, flash_density: 2.0, dist_power_m: 980, radio: 'LTE',
        notes: 'Post-maintenance assessment. Drainage cleared.'
    },
    {
        date: '2024-03-22', risk: 0.31, risk_lo: 0.27, risk_hi: 0.36, decision: 'ok',
        hand_m: 2.3, dist_water_m: 410, slope_deg: 6.0, tri: 1.4, flash_density: 1.9, dist_power_m: 1050, radio: 'LTE'
    },
    {
        date: '2023-08-05', risk: 0.55, risk_lo: 0.49, risk_hi: 0.61, decision: 'watch',
        hand_m: 0.9, dist_water_m: 150, slope_deg: 5.9, tri: 1.3, flash_density: 2.2, dist_power_m: 920, radio: 'LTE'
    },
    {
        date: '2023-01-10', risk: 0.28, risk_lo: 0.23, risk_hi: 0.33, decision: 'ok',
        hand_m: 2.5, dist_water_m: 500, slope_deg: 6.1, tri: 1.2, flash_density: 1.8, dist_power_m: 1100, radio: 'UMTS',
        notes: 'Initial baseline. Tower commissioned.'
    },
];

const MY1042_VISITS: VisitReport[] = [
    {
        id: 'MAINT-2026-008', status: 'pending',
        scheduled_date: '2026-09-12', crew_id: 'SEL-E1', crew_name: 'Shah Alam Electrical 1',
        action: 'Electrical system service',
        description: 'Full electrical inspection · Earthing system service · Power system audit · Lightning arrestor check'
    },
    {
        id: 'MAINT-2025-041', status: 'completed',
        scheduled_date: '2025-10-12', completed_date: '2025-10-14',
        crew_id: 'SEL-C1', crew_name: 'Subang Jaya Civil 1',
        action: 'Civil & drainage works',
        description: 'Foundation grout repaired · Drainage cleared · Ground condition reset · Settlement remedied',
        risk_before: 0.71, risk_after: 0.48, report_url: '#'
    },
    {
        id: 'MAINT-2024-019', status: 'completed',
        scheduled_date: '2024-03-20', completed_date: '2024-03-22',
        crew_id: 'SEL-R1', crew_name: 'Petaling Jaya RF 1',
        action: 'RF unit refresh',
        description: 'Radio unit replaced · Antenna alignment verified · RRU software updated',
        risk_before: 0.55, risk_after: 0.31, report_url: '#'
    },
    {
        id: 'MAINT-2023-007', status: 'completed',
        scheduled_date: '2023-08-05', completed_date: '2023-08-05',
        crew_id: 'SEL-C1', crew_name: 'Subang Jaya Civil 1',
        action: 'Initial baseline inspection',
        description: 'Tower commissioned. Baseline parameter log recorded.',
        risk_after: 0.28, report_url: '#'
    },
];

function generateForTower(tower: Tower): { history: SiteParameterRecord[]; visits: VisitReport[] } {
    const rand = makeRand(seedFromId(tower.tower_id));
    const base = deriveGisBase(tower.attribution, tower.radio, rand);

    const history: SiteParameterRecord[] = [];
    const visits: VisitReport[] = [];

    // Snapshot 1 — "today" / latest assessment  (matches the current risk)
    history.push({
        date: '2026-08-25',
        risk: tower.risk,
        risk_lo: tower.risk_lo,
        risk_hi: tower.risk_hi,
        decision: tower.decision,
        ...base,
        notes: tower.risk > 0.7
            ? `Risk elevated. Primary driver: ${tower.dominant_factor}.`
            : tower.risk > 0.4
                ? 'Monitoring in progress.'
                : 'Site within normal parameters.',
    });

    // If high-risk → there is an upcoming pending visit
    if (tower.decision === 'maintain') {
        const daysAhead = 7 + Math.floor(rand() * 14);
        const d = new Date('2026-08-25');
        d.setDate(d.getDate() + daysAhead);
        const tpl = getTemplate(tower.dominant_factor, rand);
        visits.push({
            id: `MAINT-2026-${Math.floor(100 + rand() * 899)}`,
            status: 'pending',
            scheduled_date: d.toISOString().split('T')[0],
            crew_id: tpl.crew_id,
            crew_name: tpl.crew_name,
            action: tpl.action,
            description: tpl.description,
        });
    }

    // Snapshots 2-5 - walk backwards in time.
    //
    // MONTHS_BACK used to be [14, 9, 18, 26], which is not monotonic: step 2
    // landed five months *newer* than step 1. Both consumers sort by date
    // before drawing, so the dates looked fine while the risk trajectory was
    // dealt onto them out of order - the chart drew a zigzag that no sequence
    // of deltas could produce, and visits were pinned to the wrong snapshots.
    const RISK_DELTAS = [-0.28, -0.10, +0.18, -0.22];  // trajectory shape
    const MONTHS_BACK = [9, 14, 18, 26];   // months from now, strictly increasing
    let rollingRisk = tower.risk;

    for (let i = 0; i < 4; i++) {
        rollingRisk = Math.max(0.05, Math.min(0.95, rollingRisk + RISK_DELTAS[i]));
        const d = new Date('2026-08-25');
        d.setMonth(d.getMonth() - MONTHS_BACK[i]);
        const dateStr = d.toISOString().split('T')[0];
        const rLo = Number(Math.max(0, rollingRisk - 0.05).toFixed(2));
        const rHi = Number(Math.min(1, rollingRisk + 0.05).toFixed(2));
        const dec: SiteParameterRecord['decision'] = rollingRisk > 0.7 ? 'maintain' : rollingRisk > 0.35 ? 'watch' : 'ok';

        // GIS values vary slightly from the base (noise ± 15%)
        history.push({
            date: dateStr,
            risk: Number(rollingRisk.toFixed(2)),
            risk_lo: rLo,
            risk_hi: rHi,
            decision: dec,
            hand_m: Number((base.hand_m * (0.85 + rand() * 0.3)).toFixed(1)),
            dist_water_m: Math.round(base.dist_water_m * (0.85 + rand() * 0.3)),
            slope_deg: Number((base.slope_deg * (0.9 + rand() * 0.2)).toFixed(1)),
            tri: Number((base.tri * (0.9 + rand() * 0.2)).toFixed(1)),
            flash_density: Number((base.flash_density * (0.9 + rand() * 0.2)).toFixed(1)),
            dist_power_m: Math.round(base.dist_power_m * (0.9 + rand() * 0.2)),
            radio: base.radio,
        });
    }

    // Completed visits are derived from the finished history, not from the
    // deltas.
    //
    // The old test was `RISK_DELTAS[i] < -0.15`, but the deltas run backwards
    // in time: a negative one means the OLDER snapshot is lower, i.e. risk rose
    // afterwards. It recorded a successful repair at exactly the points where
    // risk climbed. risk_before was fabricated as rollingRisk + 0.25 rather
    // than read from the neighbouring snapshot, so a report could claim a
    // starting risk the log never showed.
    const chronological = [...history].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 1; i < chronological.length; i++) {
        const before = chronological[i - 1];
        const after = chronological[i];
        if (before.risk - after.risk < 0.15) continue;
        const tpl = getTemplate(tower.dominant_factor, rand);
        visits.push({
            id: `MAINT-${after.date.slice(0, 4)}-${String(Math.floor(100 + rand() * 899))}`,
            status: 'completed',
            scheduled_date: after.date,
            completed_date: after.date,
            crew_id: tpl.crew_id,
            crew_name: tpl.crew_name,
            action: tpl.action,
            description: tpl.description,
            risk_before: before.risk,
            risk_after: after.risk,
            report_url: '#',
        });
    }

    // Sort visits newest first
    visits.sort((a, b) => b.scheduled_date.localeCompare(a.scheduled_date));

    return { history, visits };
}

// ---------------------------------------------------------------------------
// Public API
// Pass the live tower object directly to avoid fixture ID mismatches when
// the backend uses different IDs (e.g. SUNWAY_OPERATOR_C_810851 vs MY_*).
// ---------------------------------------------------------------------------
import { TOWERS } from './towers';

export function getHistory(towerId: string, liveTower?: Tower): SiteParameterRecord[] {
    if (towerId === 'MY_1042') return MY1042_HISTORY;

    // Prefer the passed-in live tower, fall back to fixture lookup
    const tower = liveTower ?? TOWERS.find(t => t.tower_id === towerId);
    if (!tower || tower.dominant_factor === 'unscored') return [];

    const key = cacheKey(tower);
    if (!GENERATED_CACHE[key]) GENERATED_CACHE[key] = generateForTower(tower);
    return GENERATED_CACHE[key].history;
}

export function getVisitReports(towerId: string, liveTower?: Tower): VisitReport[] {
    if (towerId === 'MY_1042') return MY1042_VISITS;

    // Prefer the passed-in live tower, fall back to fixture lookup
    const tower = liveTower ?? TOWERS.find(t => t.tower_id === towerId);
    if (!tower || tower.dominant_factor === 'unscored') return [];

    const key = cacheKey(tower);
    if (!GENERATED_CACHE[key]) GENERATED_CACHE[key] = generateForTower(tower);
    return GENERATED_CACHE[key].visits;
}

