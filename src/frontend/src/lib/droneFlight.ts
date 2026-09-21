import type { RoadPoint } from './simulationRoads.ts';

/**
 * PRIME drone relay geometry (spec §6 Phase 3, the `cow`/`prime` beats).
 *
 * Pure: no React, no MapLibre, no clock of its own. Every value is a
 * function of `elapsedMs`, like the rest of the simulation's geometry, so
 * pausing and seeking reproduce the same frame.
 *
 * WHY A DRONE CARRIES THE COVERAGE. MCMC practice does not send a ground
 * crew through standing water, which the road router now enforces
 * (`avoid_flood`, `scheduler/simulation_routing.py`). That leaves the
 * coverage gap over the flood unreachable by road while the water stands —
 * so the network unit's jeep holds at its outside-flood staging point and
 * the relay flies in. A drone is the one thing on this map allowed over the
 * flood, because it is the one thing not on a road.
 *
 * WHAT IS REAL AND WHAT IS NOT. MCMC's PRIME units are real and are cited in
 * `docs/Disaster_Response_Actions.md`; drone relay is named among their
 * capabilities. The flight path, hover point, timing and coverage radius
 * here are illustrative scenario values. The coverage planner spaces relays
 * across the outage area; it is not a measured radio-propagation model. The beat carrying this stays `illustrative`, and the legend says
 * "illustrative radius" for the same reason the ground units' footprints do.
 *
 * The radius is deliberately `MOBILE_COVERAGE_RADIUS_KM` — the SAME constant
 * the ground-placed devices use, not a larger aerial figure. A higher
 * antenna does extend line of sight, but this project has no propagation
 * model to size that with, and inventing a bigger number because the
 * emitter is airborne would be exactly the kind of plausible-looking
 * fabrication the evidence badges exist to prevent.
 */

/** Drone leaves staging at the `cow` beat (T+6h). */
export const DRONE_LAUNCH_MS = 62_000;
/** On station over the gap; coverage begins here. */
export const DRONE_ON_STATION_MS = 68_000;
/** Returns to staging at the `withdraw` beat (T+36h). */
export const DRONE_RECALL_MS = 88_000;
/** Back at staging; coverage ends. */
export const DRONE_LANDED_MS = 92_000;

export type DronePhase = 'grounded' | 'outbound' | 'on-station' | 'inbound' | 'landed';

export interface DroneState {
  phase: DronePhase;
  /** Where to draw the drone right now. */
  position: RoadPoint;
  /** True while the relay is providing coverage (on station only). */
  covering: boolean;
  /** 0..1 along the current leg, for a progress readout. */
  progress: number;
}

function lerp(from: RoadPoint, to: RoadPoint, t: number): RoadPoint {
  return { lon: from.lon + (to.lon - from.lon) * t, lat: from.lat + (to.lat - from.lat) * t };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

/**
 * The drone's state at `elapsedMs`, flying `staging -> hover -> staging`.
 *
 * Straight-line interpolation, deliberately: a drone is not on the road
 * network and has no route to follow, so bending its path would imply a
 * constraint that does not exist. `reducedMotion` snaps to the endpoints
 * rather than animating, matching how `simulationCrewStepAt` treats the
 * ground units.
 */
export function droneFlightAt(
  elapsedMs: number,
  staging: RoadPoint | null,
  hover: RoadPoint | null,
  reducedMotion = false,
): DroneState | null {
  if (!staging || !hover || !Number.isFinite(elapsedMs)) return null;
  if (elapsedMs < DRONE_LAUNCH_MS) return null;
  if (elapsedMs >= DRONE_LANDED_MS) {
    return { phase: 'landed', position: staging, covering: false, progress: 1 };
  }
  if (elapsedMs < DRONE_ON_STATION_MS) {
    const t = reducedMotion ? 1 : clamp01((elapsedMs - DRONE_LAUNCH_MS) / (DRONE_ON_STATION_MS - DRONE_LAUNCH_MS));
    return { phase: 'outbound', position: lerp(staging, hover, t), covering: false, progress: t };
  }
  if (elapsedMs < DRONE_RECALL_MS) {
    return { phase: 'on-station', position: hover, covering: true, progress: 1 };
  }
  const t = reducedMotion ? 1 : clamp01((elapsedMs - DRONE_RECALL_MS) / (DRONE_LANDED_MS - DRONE_RECALL_MS));
  return { phase: 'inbound', position: lerp(hover, staging, t), covering: false, progress: t };
}
