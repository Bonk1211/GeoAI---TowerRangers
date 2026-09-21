import type { Decision, Tower } from '../api/types';
import { distanceToDrainageKm, floodProximity } from '../lib/drainage';

/**
 * Fixture HAND curve, calibrated — not invented.
 *
 * The offline map has to agree with the inundation raster it is drawn under, or
 * the demo shows water everywhere and almost no towers standing in it, which
 * reads as "these sites are fine" rather than "this is mock data". The target is
 * the measured wet-area share of the real GLO-30 HAND raster over the same
 * SUNWAY_BOUNDS box: 15.0 / 19.3 / 27.5 / 34.5 / 45.9 % at the 0.5/1/2/3/5 m
 * stages. Fitting these two constants against that target lands within 0.7
 * percentage points across the whole ladder.
 *
 * Quadratic rise rather than linear or exponential-decay: a floodplain is flat,
 * so ground barely climbs for the first few hundred metres away from drainage
 * and then rises quickly; the soft cap stops it running to absurd heights over
 * a box that is only ~14 km across.
 */
const HAND_RISE = 1.35; // metres per km^2, near the corridor
const HAND_CAP_M = 11; // asymptote away from it

// Deterministic PRNG so the demo data is stable across reloads.
function mulberry32(seed: number) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(42);

const SUNWAY_BOUNDS = { lonMin: 101.55, lonMax: 101.68, latMin: 3.0, latMax: 3.14 };
const MALAYSIA_BOUNDS = { lonMin: 99.6, lonMax: 119.3, latMin: 0.9, latMax: 7.4 };

const RADIOS: Tower['radio'][] = ['GSM', 'UMTS', 'LTE', 'NR'];
const FACTORS = ['flood', 'power', 'terrain', 'equipment'] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function decisionFor(index: number, total: number): Decision {
  // ~7% maintain, ~17% watch, rest ok — assigned by shuffled rank, not uniform.
  const frac = index / total;
  if (frac < 0.07) return 'maintain';
  if (frac < 0.07 + 0.17) return 'watch';
  return 'ok';
}

/**
 * Attribution sums to 1.0, with the flood share driven by where the tower is.
 *
 * This used to take a `floodDominant` coin flip, which made flood attribution
 * independent of position — so a tower on the drainage corridor was no more
 * likely to be flood-dominant than one on high ground, and any flood surface
 * drawn from this data would have been noise.
 */
function attributionFor(prox: number): Record<string, number> {
  // The random term never vanishes: proximity raises the flood share but does
  // not dictate it, so a riverside tower can still fail for a power or
  // equipment reason. A purely geometric flood share would make the map a
  // picture of the drainage line and nothing else.
  const weights = [
    0.12 + prox * 1.25 + rand() * 0.35,
    0.1 + rand() * 0.6,
    0.1 + rand() * 0.6,
    0.1 + rand() * 0.5,
  ];
  const sum = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => w / sum);
  const result: Record<string, number> = {};
  FACTORS.forEach((f, i) => {
    result[f] = Number(shares[i].toFixed(3));
  });
  // correct rounding drift so shares still sum to 1.0
  const drift = 1 - Object.values(result).reduce((a, b) => a + b, 0);
  result[FACTORS[0]] = Number((result[FACTORS[0]] + drift).toFixed(3));
  return result;
}

function riskForDecision(decision: Decision): number {
  if (decision === 'maintain') return 0.7 + rand() * 0.25;
  if (decision === 'watch') return 0.4 + rand() * 0.3;
  return rand() * 0.4;
}

function makeScoredTower(id: string, rankIndex: number, total: number, lon: number, lat: number): Tower {
  const decision = decisionFor(rankIndex, total);
  const prox = floodProximity(lon, lat);
  const attribution = attributionFor(prox);
  // Height above nearest drainage, off the same corridor that drives the flood
  // share — so the offline map cannot ring a tower as standing in water while
  // its attribution says flood is irrelevant. Shape and constants are calibrated
  // against the real raster; see HAND_RISE above. The jitter keeps HAND from
  // being a clean function of distance, which would draw the drainage line a
  // second time in a layer meant to show terrain, not the generator.
  const distKm = distanceToDrainageKm(lon, lat);
  const hand_m = Number(
    Math.max(
      0,
      HAND_CAP_M * (1 - Math.exp((-HAND_RISE * distKm * distKm) / HAND_CAP_M)) +
        (rand() - 0.5) * 0.6,
    ).toFixed(2),
  );
  const dominant_factor = Object.entries(attribution).sort((a, b) => b[1] - a[1])[0][0];
  const risk = riskForDecision(decision);
  const spread = 0.04 + rand() * 0.04;
  const risk_lo = Math.max(0, Number((risk - spread).toFixed(2)));
  const risk_hi = Math.min(1, Number((risk + spread).toFixed(2)));
  const borderline =
    (decision === 'maintain' && risk < 0.75) || (decision === 'watch' && (risk < 0.43 || risk > 0.67));

  return {
    tower_id: id,
    lon,
    lat,
    // Every scored fixture tower sits inside SUNWAY_BOUNDS, so there is exactly
    // one honest territory to give them. That makes AreaModule hide itself
    // offline, which is correct: a filter offering one choice is not a filter.
    // Do not spread these across states to make the control appear — the
    // coordinates would still all be in Selangor, and the console would be
    // labelling towers with a territory they are not in.
    territory: 'Selangor',
    radio: pick(RADIOS),
    risk: Number(risk.toFixed(2)),
    risk_lo,
    risk_hi,
    decision,
    borderline,
    dominant_factor,
    urgency_days: decision === 'maintain' ? 7 + Math.floor(rand() * 14) : decision === 'watch' ? 30 + Math.floor(rand() * 60) : 180,
    attribution,
    hand_m,
    // Offline fixtures never carry a live forecast. null says so; a
    // multiplier of 1.0 would claim we asked and it came back quiet.
    weather: null,
    // Same rule as `weather`. There is no offline isolation forest, so null
    // says "not measured" — a fabricated rank would render as a real reading in
    // calm grey, which is the zeroed-fallback bug the stability chip already
    // shipped once. No flags either: inventing one would put a sentence about
    // crew reach on a tower whose roster we are not looking at.
    novelty: null,
    condition: null,
    // Offline fixtures have no telemetry, so priority is the risk rank alone.
    priority: risk,
    flags: [],
    escalated: false,
  };
}

function makeUnscoredTower(id: string): Tower {
  return {
    tower_id: id,
    lon: MALAYSIA_BOUNDS.lonMin + rand() * (MALAYSIA_BOUNDS.lonMax - MALAYSIA_BOUNDS.lonMin),
    lat: MALAYSIA_BOUNDS.latMin + rand() * (MALAYSIA_BOUNDS.latMax - MALAYSIA_BOUNDS.latMin),
    radio: pick(RADIOS),
    // Unscored towers are drawn uniformly across MALAYSIA_BOUNDS, not derived
    // from any boundary, so naming a state here would be inventing one.
    // areaCounts filters to scored towers, so this never reaches the control.
    territory: 'unassigned',
    risk: 0,
    risk_lo: 0,
    risk_hi: 0,
    decision: 'ok',
    borderline: false,
    dominant_factor: 'unscored',
    urgency_days: 0,
    weather: null,
    attribution: {},
    novelty: null,
    condition: null,
    priority: 0,
    flags: [],
    escalated: false,
  };
}

const SCORED_COUNT = 132;
const UNSCORED_COUNT = 2000;

/**
 * Positions first, then bands by hazard.
 *
 * The ranks used to be shuffled, with the comment "so bands are not spatially
 * clustered by generation order" — the right fix for the wrong problem. It
 * removed clustering caused by the loop counter, but left nothing to cluster
 * them by, so the map showed 132 randomly coloured dots and a viewer could
 * read no geography off it at all.
 *
 * Ranks are now assigned by a hazard score, so the maintain band collects
 * along the drainage corridor. decisionFor still consumes each rank 0..N-1
 * exactly once, so the band counts on screen are unchanged — only where those
 * towers sit is different.
 */
const scoredPositions = Array.from({ length: SCORED_COUNT }, () => ({
  lon: SUNWAY_BOUNDS.lonMin + rand() * (SUNWAY_BOUNDS.lonMax - SUNWAY_BOUNDS.lonMin),
  lat: SUNWAY_BOUNDS.latMin + rand() * (SUNWAY_BOUNDS.latMax - SUNWAY_BOUNDS.latMin),
}));

// Flood is one cause among several, so it takes a little over half the weight.
// At 1.0 the map would be a picture of the river; at 0 it is the noise it was.
const HAZARD_FLOOD_WEIGHT = 0.58;
const hazardOrder = scoredPositions
  .map((p, i) => ({
    i,
    hazard:
      HAZARD_FLOOD_WEIGHT * floodProximity(p.lon, p.lat) + (1 - HAZARD_FLOOD_WEIGHT) * rand(),
  }))
  .sort((a, b) => b.hazard - a.hazard);

// hazardOrder[r] is the tower holding rank r; invert it so each tower knows
// its own rank.
const rankOf = new Array<number>(SCORED_COUNT);
hazardOrder.forEach((entry, rank) => {
  rankOf[entry.i] = rank;
});

const scoredTowers: Tower[] = [];
for (let i = 0; i < SCORED_COUNT; i++) {
  const id = `MY_${String(1000 + i)}`;
  scoredTowers.push(
    makeScoredTower(id, rankOf[i], SCORED_COUNT, scoredPositions[i].lon, scoredPositions[i].lat),
  );
}

// Demo tower — pinned values, must match every wireframe exactly.
const DEMO_TOWER: Tower = {
  tower_id: 'MY_1042',
  lon: 101.605,
  lat: 3.065, // Sunway
  territory: 'Selangor',
  radio: 'LTE',
  risk: 0.82,
  risk_lo: 0.76,
  risk_hi: 0.88,
  decision: 'maintain',
  borderline: false,
  dominant_factor: 'flood',
  urgency_days: 14,
  weather: null,
  novelty: null,
  condition: null,
  priority: 0.82,
  flags: [],
  escalated: false,
  attribution: {
    flood: 0.41,
    power: 0.28,
    terrain: 0.19,
    equipment: 0.12,
  },
  hand_m: 0.4,
  dist_water_m: 83,
  slope_deg: 6.2,
  tri: 1.3,
  flash_density: 2.1,
  dist_power_m: 930,
};

const demoIdx = scoredTowers.findIndex((t) => t.tower_id === 'MY_1042');
if (demoIdx >= 0) {
  scoredTowers[demoIdx] = DEMO_TOWER;
} else {
  scoredTowers[0] = DEMO_TOWER;
}

const unscoredTowers: Tower[] = Array.from({ length: UNSCORED_COUNT }, (_, i) =>
  makeUnscoredTower(`MY_U${String(1 + i)}`),
);

export const TOWERS: Tower[] = [...scoredTowers, ...unscoredTowers];

export const DEMO_TOWER_ID = 'MY_1042';

export function isScored(t: Tower): boolean {
  return t.dominant_factor !== 'unscored';
}
