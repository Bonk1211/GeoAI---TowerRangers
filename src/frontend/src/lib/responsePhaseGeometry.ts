// Explicit .ts on these VALUE imports, deliberately: this module is covered
// by a node:test file run through --experimental-strip-types, where Node's
// ESM resolver will not infer an extension (see ticketSuggestion.ts for the
// established precedent and CLAUDE.md's account of why).
import { haversineKm } from './geo.ts';
import { bearingDeg, destination } from './coverageGeometry.ts';

/**
 * Pure selectors for the response-phase animation (spec §6 Phase 3, §9).
 * No React, no MapLibre — this module only decides WHICH towers assist a
 * down tower and WHAT bearing a sector cone should swing toward. The actual
 * polygon/animation code lives in `coverageGeometry.ts` and
 * `SimulationMap.tsx`.
 */

export interface LonLat {
  lon: number;
  lat: number;
}

export interface NeighborTower extends LonLat {
  tower_id: string;
}

/** How far a neighbouring tower can be and still plausibly retune toward a
 *  down tower's gap. Illustrative, like the coverage-gap radius — not an RF
 *  propagation limit (spec §15). */
const NEIGHBOR_SEARCH_RADIUS_KM = 15;

/** At most this many neighbours retune per down tower, so the response
 *  phase reads as "a few nearby cells helped", not a starburst of cones
 *  from every tower on the map. */
const MAX_RETUNING_NEIGHBORS = 3;

/** `selectRetuningNeighbors` splits the compass into this many bearing
 *  sectors (120° each, for 3 neighbours) and takes the nearest candidate
 *  PER SECTOR rather than the nearest N overall. Picking nearest-N ignored
 *  direction entirely: on a real run, the 3 closest surviving towers to a
 *  down tower can easily all sit on the same side (e.g. all south of it,
 *  because that's where the rest of the cluster happens to be), which
 *  leaves the opposite side of the coverage gap with no retuned cone at
 *  all even though a plausible neighbour exists further out on that side.
 *  Splitting by bearing is what makes the cones fan around the gap instead
 *  of stacking on whichever side is locally denser. */
const RETUNE_SECTOR_COUNT = MAX_RETUNING_NEIGHBORS;
const RETUNE_SECTOR_WIDTH_DEG = 360 / RETUNE_SECTOR_COUNT;

/**
 * The candidate non-down towers to retune toward `downTower`, spread across
 * bearing sectors so the resulting cones fan around the gap rather than
 * bunching on whichever side happens to have the most towers. Within each
 * sector, picks the nearest candidate; sectors with no candidate inside
 * `NEIGHBOR_SEARCH_RADIUS_KM` are simply skipped (fewer than
 * `MAX_RETUNING_NEIGHBORS` neighbours is the honest report of "nothing
 * plausible on that side," not something to paper over by falling back to a
 * closer duplicate direction). Excludes the down tower itself and every
 * other currently-down tower (a dead cell cannot retune to help another
 * dead cell).
 */
export function selectRetuningNeighbors(
  downTower: LonLat,
  candidates: NeighborTower[],
  downTowerIds: Set<string>,
): NeighborTower[] {
  const inRange = candidates
    .filter((t) => !downTowerIds.has(t.tower_id))
    .map((t) => ({
      tower: t,
      distanceKm: haversineKm(downTower, t),
      bearing: bearingDeg(downTower, t),
    }))
    .filter(({ distanceKm }) => distanceKm > 0 && distanceKm <= NEIGHBOR_SEARCH_RADIUS_KM);

  const picked: NeighborTower[] = [];
  const usedIds = new Set<string>();
  for (let sector = 0; sector < RETUNE_SECTOR_COUNT; sector++) {
    const sectorStart = sector * RETUNE_SECTOR_WIDTH_DEG;
    const inSector = inRange
      .filter(({ bearing, tower }) => {
        if (usedIds.has(tower.tower_id)) return false;
        return (bearing - sectorStart + 360) % 360 < RETUNE_SECTOR_WIDTH_DEG;
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);
    const nearest = inSector[0];
    if (nearest) {
      picked.push(nearest.tower);
      usedIds.add(nearest.tower.tower_id);
    }
  }
  return picked;
}

/**
 * The bearing a neighbouring tower's sector should point at `t` within
 * `[0, 1]` of the retune animation's progress: it starts at the neighbour's
 * OWN nominal outward bearing (away from its own coverage center — here
 * simplified to due-north, since this project holds no real sector
 * azimuths) and swings toward the down tower as `t` advances. Pure
 * function of `t`, so the caller can drive it from either a live animation
 * frame or a fixed reduced-motion value.
 */
export function retuneBearingAt(neighbor: LonLat, downTower: LonLat, t: number): number {
  const targetBearing = bearingDeg(neighbor, downTower);
  const nominalBearing = 0; // due north — illustrative default sector heading
  const clamped = Math.max(0, Math.min(1, t));
  // Shortest angular path from nominal to target, so a neighbour due south
  // of its own nominal heading doesn't visibly spin the long way around.
  let delta = targetBearing - nominalBearing;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return (nominalBearing + delta * clamped + 360) % 360;
}

/** The reduced-motion still value for retuneBearingAt: fully retuned,
 *  parked at its final bearing rather than mid-swing (spec §9 — every
 *  animation needs an equivalent still state; DispatchRoutePreview parks
 *  its token at the midpoint, but a cone's meaningful "settled" state is
 *  fully pointed at the gap, not half-swung). */
export const RETUNE_STILL_T = 1;

export interface NeighborAssignment {
  downTower: NeighborTower;
  neighbors: NeighborTower[];
}

/**
 * One retune assignment PER down tower, each with its own nearest
 * neighbours — the real-world basis is 3GPP-era Cell Outage Compensation
 * (SON COC): a surviving cell retunes toward the outage it actually shares
 * a neighbour/handover relation with, not toward whichever outage happens
 * to be first on a list. Geographic nearest-down-tower is this project's
 * stand-in for "strongest handover relation" (no ANR data, no RSRP), which
 * is the same honest-simplification move `NEIGHBOR_SEARCH_RADIUS_KM`
 * already makes.
 *
 * A candidate neighbour is assigned to at most ONE down tower — its
 * nearest — rather than appearing in every down tower's list. Real COC is
 * genuinely many-to-many (a cell between two outages can compensate for
 * both, typically by widening beamwidth rather than picking one azimuth),
 * but this project only has a single-target `sectorPolygon`/
 * `retuneBearingAt` shape — one cone, one bearing — so "assign to nearest,
 * never duplicate" is the closest single-target approximation of that
 * many-to-many reality without inventing a beamwidth-widening model this
 * codebase has no geometry for. Distinct from `selectRetuningNeighbors`
 * (single down tower, closest-first, capped at 3), this wraps it per down
 * tower and resolves the cross-assignment.
 */
export function assignRetuningNeighbors(
  downTowers: (NeighborTower)[],
  candidates: NeighborTower[],
  downTowerIds: Set<string>,
): NeighborAssignment[] {
  if (downTowers.length === 0) return [];
  // Nearest down tower per candidate, ties broken by array order (stable,
  // deterministic — not that a real tie at this precision is likely).
  const nearestDownTowerId = new Map<string, string>();
  for (const candidate of candidates) {
    if (downTowerIds.has(candidate.tower_id)) continue;
    let best: { id: string; distanceKm: number } | null = null;
    for (const down of downTowers) {
      const distanceKm = haversineKm(down, candidate);
      if (distanceKm <= 0) continue;
      if (!best || distanceKm < best.distanceKm) best = { id: down.tower_id, distanceKm };
    }
    if (best) nearestDownTowerId.set(candidate.tower_id, best.id);
  }

  return downTowers.map((down) => {
    const ownCandidates = candidates.filter((c) => nearestDownTowerId.get(c.tower_id) === down.tower_id);
    return { downTower: down, neighbors: selectRetuningNeighbors(down, ownCandidates, downTowerIds) };
  });
}

/** How close down towers must be to count as the SAME reported outage
 *  pocket (`DeploymentCluster.members`) — labelling only. Originally also
 *  governed deployment COUNT (research summary, 2026-09-16,
 *  mcmc-domain-reviewer: a real mobile base station replaces coverage, not
 *  an individual asset, and operators hold a handful of units, not dozens),
 *  which is why this stayed at 2km — inside the unit's own coverage radius
 *  (`COW_COVERAGE_RADIUS_KM`) plus margin. That single-COW-per-pocket
 *  design was explicitly overridden by the operator the same day: ring-
 *  packing (`ringPositions`, `sitesPerDownTower`) now deliberately deploys
 *  several COWs per pocket so the map visibly covers the pocket's own red
 *  gap circle, which is a real tension with the "operators hold a handful"
 *  research this constant's value was originally chosen from — recorded
 *  here rather than silently dropped, since a future pass reconciling the
 *  two should read both sides. */
const CLUSTER_RADIUS_KM = 2;

export interface DeploymentCluster {
  /** The deployment SITE — a ring-packed point near the outage it covers
   *  for, accepted only when a real tower (down or surviving) witnesses
   *  the ground is buildable. Carries a synthetic `cow-<n>` id, not a real
   *  tower's — see `assignClusterSites`'s doc comment for why siting moved
   *  off survivor towers entirely (2026-09-17). */
  site: NeighborTower;
  /** Every down tower this one deployment is standing in for. */
  members: NeighborTower[];
}

/** The illustrative dead-zone radius drawn around EACH down tower
 *  (`COVERAGE_GAP_RADIUS_KM` in SimulationMap.tsx) — duplicated here rather
 *  than imported, since `SimulationMap.tsx` imports FROM this module and a
 *  cross-import back would be circular. A test in this module's own test
 *  file pins both files' copies to the same value (3.5) so they cannot
 *  silently drift apart. Needed here because ring-packing (`ringPositions`,
 *  `sitesPerDownTower`) has to know how big the red footprint it's trying
 *  to reach actually is, not just how far apart down towers are. */
const COVERAGE_GAP_RADIUS_KM = 3.5;

/** How many COW sites, ringed around ONE down tower, it takes for their
 *  `COW_COVERAGE_RADIUS_KM` circles to jointly reach most of that tower's
 *  own `COVERAGE_GAP_RADIUS_KM` dead-zone circle — the operator's explicit
 *  ask (2026-09-16): "4 not enough, then 6, then 10," i.e. send as many
 *  jeeps as it takes to visibly cover the red, not just enough to reach the
 *  down towers themselves. A ring at radius `COVERAGE_GAP_RADIUS_KM -
 *  COW_COVERAGE_RADIUS_KM` (2.1km) has circumference ~13.2km; spaced so
 *  adjacent COW circles overlap by half a radius rather than merely
 *  touching (`1.5 x COW_COVERAGE_RADIUS_KM` apart, 2.1km) gives ~6 ring
 *  sites, plus one centred on the down tower itself for the middle of the
 *  circle the ring alone leaves thin — 7 total per down tower before
 *  cross-tower deduplication thins overlapping sites in a multi-tower
 *  cluster back down. Recomputed from the two radius constants rather than
 *  hardcoded, so retuning either radius keeps the ring proportionate. */
function sitesPerDownTower(): number {
  const ringRadius = COVERAGE_GAP_RADIUS_KM - COW_COVERAGE_RADIUS_KM;
  if (ringRadius <= 0) return 1; // COW already reaches the whole gap from the centre
  const ringCircumference = 2 * Math.PI * ringRadius;
  const spacing = 1.5 * COW_COVERAGE_RADIUS_KM;
  const ringCount = Math.max(1, Math.ceil(ringCircumference / spacing));
  return ringCount + 1; // +1 for the centre site
}

/** Same value SimulationMap.tsx uses for a parked COW's own coverage
 *  circle — duplicated for the same reason `COVERAGE_GAP_RADIUS_KM` is
 *  above (no circular import), kept in sync by the same cross-check test. */
const COW_COVERAGE_RADIUS_KM = 1.4;

/**
 * Ring-packs candidate deployment TARGETS around `downTower` so their
 * `COW_COVERAGE_RADIUS_KM` circles jointly reach most of that tower's
 * `COVERAGE_GAP_RADIUS_KM` dead-zone — one centre point plus a ring of
 * `sitesPerDownTower() - 1` points evenly spaced by bearing at
 * `COVERAGE_GAP_RADIUS_KM - COW_COVERAGE_RADIUS_KM` from the tower. These
 * ARE the sites now (2026-09-17) — `assignClusterSites` only checks a
 * target against a land witness, containment and separation before
 * accepting it; it no longer relocates the target onto a survivor tower.
 */
/**
 * Reorders `0..count-1` so that ANY PREFIX of the result is still roughly
 * evenly spread across the full range, not clustered at the low end — a
 * bit-reversal permutation (van der Corput-style ordering). Needed because
 * `trimRequests` (see `MAX_TOTAL_DEPLOYMENTS`) can truncate one pocket's
 * ring positions down to a handful when a fleet-wide cap is shared across
 * several pockets, and `ringPositions` originally emitted bearings in
 * sequential order (0, 1/N, 2/N, ...) — any truncated prefix of THAT
 * ordering keeps only the low-bearing side of the ring and drops the rest,
 * which reads on screen as "coverage only on one side, gap on the other"
 * exactly where a fleet-wide-capped pocket needed spread the most (2026-09-16,
 * operator screenshot: thin uncovered strips at the edges of otherwise
 * well-covered pockets). Order 0,1,2,3 (count=4) -> bit-reversed indices
 * 0,2,1,3, so the first two entries already sit opposite each other around
 * the circle rather than adjacent.
 */
function spreadOrder(count: number): number[] {
  if (count <= 2) return Array.from({ length: count }, (_, i) => i);
  const bits = Math.ceil(Math.log2(count));
  const seen = new Set<number>();
  const order: number[] = [];
  for (let i = 0; order.length < count; i++) {
    let reversed = 0;
    for (let b = 0; b < bits; b++) {
      reversed = (reversed << 1) | ((i >> b) & 1);
    }
    if (reversed < count && !seen.has(reversed)) {
      seen.add(reversed);
      order.push(reversed);
    }
  }
  return order;
}

/** The "centre" ring position is nudged this far off the down tower's own
 *  coordinates, due north — enough that it never equals the down tower's
 *  point (2026-09-17 fix: `ringPositions` originally returned `downTower`
 *  itself as the centre point, which parked a COW icon exactly on the
 *  flooded compound it was covering for once sites stopped being
 *  relocated onto survivor towers — the same siting mistake the module's
 *  own history warns against: "a down tower's site is frequently the
 *  least reachable point in the area... parking a vehicle exactly there
 *  contradicts the reason that site is down"). Small enough that it is
 *  still "at the down tower's location" for coverage purposes. */
const CENTRE_NUDGE_KM = 0.3;

/**
 * Retune-first gate (2026-09-17, operator review): the `cow` beat's own
 * console line claims "neighbour-cell retune insufficient for terrain" —
 * but until now that was narration only. COWs ring-packed unconditionally,
 * whether or not a sector cone was already reaching that side of the down
 * tower's gap circle. This function makes the claim true: a retuning
 * neighbour's cone points FROM the neighbour TOWARD the down tower, so it
 * plausibly helps the side of the gap circle FACING that neighbour. A ring
 * position within half a retune sector's width of a retuned bearing is
 * dropped — a jeep is not sent where a cone is already pointed. `bearing`
 * is the neighbour's bearing AS SEEN FROM the down tower (not the reverse),
 * matching how `selectRetuningNeighbors` already buckets candidates.
 *
 * This is a bearing-only approximation, not a polygon intersection: a real
 * cone (radius `SECTOR_RADIUS_KM`, width `SECTOR_WIDTH_DEG` — both live in
 * SimulationMap.tsx) does not reach every metre of the gap circle on that
 * side, and this function does not model that falloff. It is the same
 * class of honest simplification `NEIGHBOR_SEARCH_RADIUS_KM` already makes
 * for "which neighbour retunes at all" — precise RF coverage prediction is
 * out of scope for an illustrative layer; a defensible per-sector gate is
 * in scope, and half-measures (rendering the cone without ever letting it
 * change a downstream decision) is what "insufficient for terrain" being
 * pure narration amounted to.
 */
function retunedBearings(downTower: LonLat, retunedNeighbors: LonLat[]): number[] {
  return retunedNeighbors.map((n) => bearingDeg(downTower, n));
}

function isRetuneCovered(bearing: number, retunedBearingsList: number[]): boolean {
  const halfSector = RETUNE_SECTOR_WIDTH_DEG / 2;
  return retunedBearingsList.some((rb) => {
    const delta = Math.abs(((bearing - rb + 540) % 360) - 180);
    return delta <= halfSector;
  });
}

function ringPositions(downTower: LonLat, retunedNeighbors: LonLat[] = []): LonLat[] {
  const total = sitesPerDownTower();
  const retunedBearingsList = retunedBearings(downTower, retunedNeighbors);
  const positions: LonLat[] = [];
  // The centre site is never gated by retune — a cone reaching one side of
  // the gap circle does not cover the down tower's own compound, which is
  // what the centre site stands in for.
  positions.push(destination(downTower, 0, CENTRE_NUDGE_KM));
  const ringRadius = COVERAGE_GAP_RADIUS_KM - COW_COVERAGE_RADIUS_KM;
  if (ringRadius <= 0) return positions;
  const ringCount = total - 1;
  for (const i of spreadOrder(ringCount)) {
    const bearing = (360 * i) / ringCount;
    if (isRetuneCovered(bearing, retunedBearingsList)) continue;
    positions.push(destination(downTower, bearing, ringRadius));
  }
  return positions;
}

/**
 * Groups down towers into deployment clusters by proximity, bounded on
 * CLUSTER CENTROID distance, not on nearest-member (single-linkage would
 * chain: A joins because it's near B, C joins because it's near A, and a
 * dozen towers scattered across a whole district collapse into one cluster
 * even though the two ends are 10+ km apart — this shipped and left most
 * OFFLINE markers with no visible coverage at all, since one temporary
 * base station's illustrative radius cannot plausibly reach that far).
 * Bounding on the running centroid keeps a cluster's total footprint close
 * to `CLUSTER_RADIUS_KM` regardless of chain length. This coarse grouping
 * decides which down towers count as "the same outage pocket" for
 * labelling and attribution (`DeploymentCluster.members`) — it no longer
 * decides how many COWs a pocket gets. That is `ringPositions`' job: every
 * member down tower ring-packs its OWN set of candidate site targets (2026-
 * 09-16, operator ask — "send more jeeps until the red is actually
 * covered," not just enough to reach the down towers themselves), deduped
 * against each other within the pocket by `RING_TARGET_DEDUPE_KM`, so a
 * wide or dense pocket gets as many deployments as it takes to reach its
 * own dead-zone circles rather than a fixed one-per-pocket. `candidates` is
 * the full live population (down and surviving towers both) — needed
 * because a target is accepted only when some real tower nearby witnesses
 * the ground is buildable; see `assignClusterSites`. Order of the input
 * array does not change which towers end up in the same coarse cluster,
 * only which cluster comes first in the output.
 */
/** How close two ring-packed target points must be before the second is
 *  dropped as redundant with the first, when their SOURCE down towers sit
 *  close enough (within the same coarse cluster) that their rings
 *  legitimately overlap. Set equal to `COW_COVERAGE_RADIUS_KM` — two
 *  targets closer than one COW's own radius would site two jeeps to cover
 *  what one jeep parked between them already reaches. This is a looser
 *  dedupe than `MIN_SITE_SEPARATION_KM` (which spaces out already-ACCEPTED
 *  sites in `assignClusterSites`); this one runs on ring TARGETS before
 *  acceptance even starts, so a dense coarse cluster's many overlapping
 *  per-tower rings collapse into a sane number of distinct targets rather
 *  than requesting (and then separately trying to site) far more sites
 *  than the ground actually needs. */
const RING_TARGET_DEDUPE_KM = COW_COVERAGE_RADIUS_KM;

/** Ceiling on total COW deployments across the WHOLE scenario, not per
 *  pocket. Ring-packing alone is unbounded — a scenario with several
 *  widely-separated outage pockets, each ring-packing its own
 *  `sitesPerDownTower()` (8 at the real constants), can request dozens of
 *  deployments. When the raw request count exceeds this, `trimRequests`
 *  keeps them ROUND-ROBIN across pockets — every pocket gets its first
 *  deployment before any pocket gets a second, its second before any gets
 *  a third, and so on — so a fleet-wide cap never starves a small pocket to
 *  fully satisfy one large one; combined with `spreadOrder`'s bit-reversal
 *  ordering, each pocket's kept subset also stays spread around its own
 *  ring rather than bunched on one side. Raised 12 -> 24 (2026-09-16,
 *  operator screenshot after the first ring-packing round): with several
 *  simultaneous pockets sharing one fleet-wide budget, 12 was thin enough
 *  per pocket to leave visible directional gaps even after the ordering
 *  fix — 24 gives a multi-pocket run headroom for ~3 pockets at a full
 *  8-ring each before trimming engages at all. */
const MAX_TOTAL_DEPLOYMENTS = 24;

/** Keeps at most MAX_TOTAL_DEPLOYMENTS of `requests`, round-robin by pocket
 *  (grouped by `members` reference identity, which every ring position
 *  within one pocket shares — see `clusterDownTowers`). Pockets are
 *  visited in the order their first request appears, so results stay
 *  deterministic for a given input order. */
function trimRequests(requests: SiteRequest[]): SiteRequest[] {
  if (requests.length <= MAX_TOTAL_DEPLOYMENTS) return requests;
  const byPocket = new Map<NeighborTower[], SiteRequest[]>();
  const pocketOrder: NeighborTower[][] = [];
  for (const request of requests) {
    let bucket = byPocket.get(request.members);
    if (!bucket) {
      bucket = [];
      byPocket.set(request.members, bucket);
      pocketOrder.push(request.members);
    }
    bucket.push(request);
  }
  const kept: SiteRequest[] = [];
  let round = 0;
  while (kept.length < MAX_TOTAL_DEPLOYMENTS) {
    let addedThisRound = false;
    for (const pocket of pocketOrder) {
      if (kept.length >= MAX_TOTAL_DEPLOYMENTS) break;
      const bucket = byPocket.get(pocket)!;
      if (round < bucket.length) {
        kept.push(bucket[round]);
        addedThisRound = true;
      }
    }
    if (!addedThisRound) break; // every pocket's requests exhausted
    round++;
  }
  return kept;
}

export function clusterDownTowers(
  downTowers: NeighborTower[],
  candidates: NeighborTower[],
  downTowerIds: Set<string>,
): DeploymentCluster[] {
  // Retune-first gate (2026-09-17): compute which neighbours are already
  // retuning toward each down tower BEFORE ring-packing COW sites, so a
  // ring position on the side a cone already reaches is never requested in
  // the first place. Computed internally (not accepted as a parameter) so
  // the coupling is an invariant of this function, not something a caller
  // could forget to wire up — the same reason `assignClusterSites`'s three
  // acceptance rules live inside `clusterDownTowers`'s own call graph
  // rather than being left to the caller to apply.
  const retuneAssignments = assignRetuningNeighbors(downTowers, candidates, downTowerIds);
  const retunedNeighborsByDownTower = new Map<string, LonLat[]>();
  for (const { downTower, neighbors } of retuneAssignments) {
    retunedNeighborsByDownTower.set(downTower.tower_id, neighbors);
  }

  // Coarse grouping: which down towers count as "the same outage pocket"
  // for labelling/attribution purposes (DeploymentCluster.members). Every
  // COW deployment ring-packed within a pocket still reports that pocket's
  // full member list, not just the one down tower its ring came from.
  const coarseClusters: NeighborTower[][] = [];
  for (const tower of downTowers) {
    const joinable = coarseClusters.find(
      (cluster) => haversineKm(centroidOf(cluster), tower) <= CLUSTER_RADIUS_KM,
    );
    if (joinable) {
      joinable.push(tower);
    } else {
      coarseClusters.push([tower]);
    }
  }

  // Within each pocket, ring-pack enough candidate SITE TARGETS around
  // every member down tower that their COW coverage circles can jointly
  // reach most of that tower's own dead-zone circle (spec-driven operator
  // ask, 2026-09-16: "send more jeeps until the red is actually covered,"
  // not just enough to reach the down towers themselves) MINUS whatever a
  // retuned neighbour's cone already plausibly reaches (2026-09-17 — see
  // `ringPositions`'s retune-gate doc comment). A pocket with several
  // close-together down towers produces heavily overlapping rings, so
  // targets within RING_TARGET_DEDUPE_KM of an already-kept target are
  // dropped before site acceptance — otherwise a 3-tower pocket would
  // request 3x sitesPerDownTower() sites when most of them sit almost on
  // top of each other. The resulting fleet-wide total is then capped by
  // `trimRequests` (`MAX_TOTAL_DEPLOYMENTS`) so several widely-separated
  // pockets can't jointly request dozens of jeeps.
  const requests: SiteRequest[] = [];
  for (const members of coarseClusters) {
    const keptTargets: LonLat[] = [];
    for (const tower of members) {
      const retunedNeighbors = retunedNeighborsByDownTower.get(tower.tower_id) ?? [];
      for (const target of ringPositions(tower, retunedNeighbors)) {
        if (keptTargets.some((t) => haversineKm(t, target) < RING_TARGET_DEDUPE_KM)) continue;
        keptTargets.push(target);
        requests.push({ members, target });
      }
    }
  }
  return assignClusterSites(trimRequests(requests), candidates, downTowerIds);
}

function centroidOf(towers: NeighborTower[]): { lon: number; lat: number } {
  return {
    lon: towers.reduce((sum, t) => sum + t.lon, 0) / towers.length,
    lat: towers.reduce((sum, t) => sum + t.lat, 0) / towers.length,
  };
}

/**
 * How far a ring target may sit from the NEAREST REAL TOWER (surviving or
 * down) and still be treated as plausible ground for a temporary base
 * station.
 *
 * This constant changed ROLE on 2026-09-17, which matters more than its
 * value. Every earlier version of this module used survivor proximity as
 * the SITE ITSELF: a COW was parked at (a small nudge off) a surviving
 * tower, and a ring target with no survivor nearby was dropped. That is
 * what the operator's review reported as jeeps bunching together and
 * leaving most of the red coverage-gap circle empty — the deployment
 * pattern was dictated by where towers happen to already stand, not by the
 * shape of the outage the deployment exists to cover.
 *
 * A real temporary BTS is trucked to a spot chosen for the gap it fills (a
 * field, a car park, a roadside, an evacuation centre), not to another
 * operator's compound. So a COW now parks AT ITS RING TARGET, and a nearby
 * real tower is required only as a WITNESS that the target is on buildable
 * land — the honest proxy this project can support, since it holds no
 * coastline, road or land-use layer in `lib/`. A tower exists there,
 * therefore the ground there is dry, reachable and built on.
 *
 * That still rules out the specific bug the survivor rule was protecting
 * against (a ring target falling over open water gets no witness, so it is
 * dropped — 2026-09-16 operator screenshot), while no longer forcing the
 * deployment pattern to mirror the tower pattern. The witness may be a
 * DOWN tower: a flooded tower's compound proves the surrounding area is
 * land just as well as a working one does, and in a badly-hit pocket the
 * down towers are most of the evidence available.
 *
 * 2.5km is wider than the old 3.5km site ceiling was tight, because it
 * measures a different thing — "is there any development near this
 * point," not "is this a plausible parking spot for a unit serving that
 * point." Set below `COVERAGE_GAP_RADIUS_KM` (3.5) so a witness is always
 * nearer to the target than the outage edge is.
 */
const LAND_WITNESS_RADIUS_KM = 2.5;

/**
 * Minimum distance between two accepted deployment sites — the operator's
 * explicit constraint (2026-09-17): jeeps "cannot be near to each other
 * (it will overlap), they has to be diverge but still keep within the
 * offline radius."
 *
 * Now a HARD rule, not the progressive-relaxation preference it was while
 * sites were pinned to survivor towers. That relaxation existed because a
 * site's position was not freely choosable — if the only two survivors in
 * a pocket sat 300m apart, the loop had to either accept them bunched or
 * deploy nothing. Parking at ring targets removes that bind entirely:
 * `ringPositions` already spaces its targets by ~2.1km around the ring, so
 * the separation rule now rejects genuine redundancy rather than fighting
 * the tower layout.
 *
 * Set to `1.2 x COW_COVERAGE_RADIUS_KM` (1.68km) rather than the old flat
 * 3km. Two COW circles at this spacing overlap noticeably, which is what
 * continuous coverage across a gap actually requires — the old `2 x
 * radius` "may at worst just touch" rule leaves a cusp of uncovered ground
 * between every adjacent pair, and enough of those cusps is the
 * thin-uncovered-strips complaint.
 *
 * This ceiling MUST stay below `ringPositions`' own ring geometry, not just
 * near it: at the real constants (`COVERAGE_GAP_RADIUS_KM` 3.5,
 * `COW_COVERAGE_RADIUS_KM` 1.4, 7 ring points) the centre-to-ring distance
 * is 2.1km and the chord between ADJACENT ring points is only ~1.82km —
 * so any separation ceiling above 1.82km silently rejects the ring's own
 * intended points against each other (measured: at 2.24km, every one of
 * the 7 ring sites collided with the centre site and was dropped, leaving
 * 1 deployment instead of 8 — the exact bunching bug this rework exists to
 * fix, reintroduced by the separation rule itself). 1.68km sits below both
 * figures, so a single tower's full ring survives and only genuinely
 * redundant pairs (from DIFFERENT down towers' rings landing close
 * together) are rejected.
 */
const MIN_SITE_SEPARATION_KM = 1.2 * COW_COVERAGE_RADIUS_KM;

/**
 * A deployment site must sit within this distance of at least one of the
 * down towers it is covering for — the second half of the operator's
 * constraint ("but still keep within the offline radius (red circle)").
 * Equal to `COVERAGE_GAP_RADIUS_KM` exactly: the red circle drawn on the
 * map IS the containment boundary, so a jeep outside it is visibly outside
 * the outage it claims to serve, which is the "jeep too far from its
 * outage" complaint that drove three rounds of ceiling-tuning in this
 * module's history.
 *
 * Ring targets are generated at `COVERAGE_GAP_RADIUS_KM -
 * COW_COVERAGE_RADIUS_KM` from their own down tower, so they satisfy this
 * by construction — it is enforced anyway, as a guard against a future
 * change to `ringPositions` silently pushing sites outside the footprint
 * the map draws.
 */
const MAX_SITE_DISTANCE_KM = COVERAGE_GAP_RADIUS_KM;

/** One requested deployment: `members` is what it's standing in for (for
 *  labelling/attribution — usually the whole logical cluster, repeated
 *  across every ring position that cluster expands to), `target` is the
 *  point the unit actually parks at, subject to the land-witness,
 *  separation and containment rules below. Splitting these apart is what
 *  lets one down-tower cluster request several ring-packed sites (see
 *  `ringPositions`) while every one of them still reports the same
 *  `members` list. */
interface SiteRequest {
  members: NeighborTower[];
  target: LonLat;
}

/**
 * Resolves ring-packed targets into actual deployment sites.
 *
 * Reworked 2026-09-17 (operator review) from every earlier survivor-pinned
 * version. A site is now the ring target itself, accepted when all three
 * hold:
 *
 *   1. LAND WITNESS — some real tower lies within
 *      `LAND_WITNESS_RADIUS_KM`, standing in for the coastline/land-use
 *      layer this project does not have. See that constant for why the
 *      witness may be a down tower.
 *   2. CONTAINMENT — the site is within `MAX_SITE_DISTANCE_KM` of a down
 *      tower it covers for, i.e. inside the red gap circle the map draws.
 *   3. SEPARATION — no already-accepted site is closer than
 *      `MIN_SITE_SEPARATION_KM`, so units diverge instead of stacking.
 *
 * A target failing any of the three is DROPPED rather than moved to a
 * fallback position. That rule is inherited unchanged from the survivor-
 * pinned versions and is the one piece of this function's history worth
 * preserving: a fabricated fallback (the raw pocket centroid, in one
 * shipped version) put a jeep icon on open water. A pocket can therefore
 * still legitimately produce fewer deployments than its ring requested —
 * the honest report of what this project can justify, not something to
 * paper over.
 *
 * Sites are given synthetic ids (`cow-<n>`) rather than borrowing a
 * tower's. Callers key their per-run dedupe maps on `site.tower_id`, and
 * the previous version's reuse of a survivor's id is exactly what let two
 * pockets resolving to the same survivor silently collapse into one jeep
 * (2026-09-16). A deployment is its own object now, so its identity is
 * its own too.
 *
 * KNOWN LIMITATION (flagged by mcmc-domain-reviewer, C8 review pass,
 * unresolved): this module is domain-free — it knows nothing of any flood
 * polygon (see the module doc comment) — so a ring target inside the
 * outage's own dead-zone circle is accepted purely on land-witness/
 * containment/separation, with no check against where the flood itself
 * currently sits. `stagingPoint` in `SimulationMap.tsx` (C6, the SAME day)
 * correctly keeps a dispatch ORIGIN out of the flood; nothing equivalent
 * keeps a COW's PARKING SITE out of it, so a site can legitimately land
 * inside the blue shading it is meant to be covering FOR. A hard exclusion
 * was considered and deliberately not added here: the down towers this
 * function ring-packs around are, by construction, INSIDE the flood
 * footprint (`selectDownTowers` in sabahFlood.ts requires it), and the
 * ring radius (`COVERAGE_GAP_RADIUS_KM - COW_COVERAGE_RADIUS_KM`, 2.1km)
 * is not guaranteed to reach the flood's edge — rejecting every in-flood
 * target outright risks zero accepted sites for exactly the pockets that
 * most need one, which would be a worse regression than the one being
 * fixed. The honest real-world picture (a unit staged at the flood's edge
 * or on locally high ground within it, not literally in open water) needs
 * either a coastline/elevation signal this project does not have, or a
 * softer preference (accept an in-flood site only when no dry alternative
 * exists nearby) that was not verified against live data in this cycle —
 * left for the next round rather than shipped unverified.
 */
function assignClusterSites(
  requests: SiteRequest[],
  candidates: NeighborTower[],
  downTowerIds: Set<string>,
): DeploymentCluster[] {
  const accepted: DeploymentCluster[] = [];
  const acceptedPoints: LonLat[] = [];

  requests.forEach(({ members, target }) => {
    // 1. Land witness — any real tower nearby, down or surviving.
    const hasWitness = candidates.some((t) => haversineKm(t, target) <= LAND_WITNESS_RADIUS_KM);
    if (!hasWitness) return;

    // 2. Containment — inside the gap circle of a tower it covers for.
    const contained = members.some((m) => haversineKm(m, target) <= MAX_SITE_DISTANCE_KM);
    if (!contained) return;

    // 3. Separation — diverged from every site already placed.
    if (acceptedPoints.some((p) => haversineKm(p, target) < MIN_SITE_SEPARATION_KM)) return;

    acceptedPoints.push(target);
    accepted.push({
      site: { tower_id: `cow-${accepted.length + 1}`, lon: target.lon, lat: target.lat },
      members,
    });
  });

  void downTowerIds; // witness rule accepts down towers too — see LAND_WITNESS_RADIUS_KM
  return accepted;
}
