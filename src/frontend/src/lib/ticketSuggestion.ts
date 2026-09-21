import type { Crew, ScheduleEntry } from '../api/types';
import type { CrewCandidate } from './ticketSkills';
// Explicit .ts on the VALUE imports, and deliberately so: this module is
// covered by a node:test file run through --experimental-strip-types, where
// Node's ESM resolver will not infer an extension. Type-only imports (above)
// are erased before resolution and so never need one — which is why
// inundation.ts, the existing testable module, never had to do this.
// tsconfig.app.json sets allowImportingTsExtensions with noEmit, so this is
// legal for tsc and Vite alike. Dropping the extensions breaks the test.
import { crewPositionNow, type CrewPosition } from './crewPosition.ts';
import { haversineKm } from './geo.ts';

/**
 * Mirrors config/policy.yaml's travel block. Duplicated here rather than
 * fetched because the panel needs a figure before the solver has run, and the
 * solver is the only thing that can produce the real one. Both are DECLARED
 * ASSUMPTIONS in policy.yaml, not measurements — which is why the UI labels
 * anything derived from them as an estimate, and prints the solver's own
 * travel_min once the pin has committed. Sub-project 1a (OSRM road matrix)
 * replaces both ends of this.
 */
export const ROAD_FACTOR = 1.35;
export const AVG_SPEED_KMH = 45;

export interface Suggestion {
  crew: Crew;
  from: CrewPosition;
  /** Road-adjusted km from where the crew is now to the tower. */
  distance_km: number;
  /** Whole minutes: measured when `measured` supplied one, else estimated. */
  eta_min: number;
  /**
   * True when both figures came from the backend road matrix rather than the
   * great-circle assumption. The panel labels an estimate "(est.)" and must
   * not label a measurement that way — nor the reverse.
   */
  measured: boolean;
  /**
   * The matrix says there is NO road between this crew's position and the
   * tower — an island with no fixed link. Distinct from an absent pair, which
   * simply falls back to the estimate.
   */
  unreachable: boolean;
}

/** One measured leg, keyed by the origin's matrix key. */
export interface MeasuredLeg {
  km: number | null;
  minutes: number | null;
  reachable: boolean;
}

/**
 * Orders already-eligible crews by how far each is from the tower RIGHT NOW.
 *
 * Eligibility (issue_type -> crew_type, max_travel_km) is decided upstream by
 * rankCandidateCrews(), which can only measure from the depot. This re-ranks
 * that set against live position, so a crew finishing a job next door outranks
 * one idling at a nearer depot.
 */
export function rankSuggestions(
  candidates: CrewCandidate[],
  entriesToday: ScheduleEntry[],
  tower: { lon: number; lat: number },
  nowMin: number,
  towerCoords: Map<string, { lon: number; lat: number }>,
  placeNameOf: (tower_id: string) => string,
  /**
   * Measured legs from POST /travel/legs, keyed by origin. Optional: the
   * offline path and the first render before the request resolves both have
   * none, and fall back to the great-circle estimate per crew rather than
   * blocking the panel.
   */
  measured?: Map<string, MeasuredLeg>,
): Suggestion[] {
  return candidates
    .map(({ crew }) => {
      const from = crewPositionNow(crew, entriesToday, nowMin, towerCoords, placeNameOf);
      const hit = measured?.get(from.key);

      // No road at all. Sorted last rather than dropped: the panel explains
      // why a crew cannot be used, and silently omitting it would leave the
      // planner wondering where a crew they know is nearby went.
      if (hit && !hit.reachable) {
        return {
          crew,
          from,
          distance_km: Number.POSITIVE_INFINITY,
          eta_min: Number.POSITIVE_INFINITY,
          measured: true,
          unreachable: true,
        };
      }
      if (hit && hit.km != null && hit.minutes != null) {
        return {
          crew,
          from,
          distance_km: hit.km,
          eta_min: Math.round(hit.minutes),
          measured: true,
          unreachable: false,
        };
      }
      const distance_km = haversineKm(from, tower) * ROAD_FACTOR;
      return {
        crew,
        from,
        distance_km,
        eta_min: Math.round((distance_km / AVG_SPEED_KMH) * 60),
        measured: false,
        unreachable: false,
      };
    })
    .sort((a, b) => a.distance_km - b.distance_km);
}
