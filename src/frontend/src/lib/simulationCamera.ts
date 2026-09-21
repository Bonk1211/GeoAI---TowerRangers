export interface SimulationCameraPose {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

interface CameraTargets {
  site: [number, number];
  maintenance: { center: [number, number]; zoom: number };
  assessment: { center: [number, number]; zoom: number };
  response: { center: [number, number]; zoom: number };
  responseSite: [number, number];
  closure?: [number, number];
}

/** Shot timing uses only scenario time, so pausing and seeking reproduce the same pose. */
export function simulationCameraAt(elapsedMs: number, targets: CameraTargets, reducedMotion = false): SimulationCameraPose {
  const time = Math.max(0, Math.min(96_000, Number.isNaN(elapsedMs) ? 0 : elapsedMs));
  const { site, maintenance, response } = targets;
  const corridor: [number, number] = [116.095, 6.011];
  const shots = [
    { at: 0, center: site, zoom: 13.3, pitch: 60, bearing: -28 },
    { at: 6_000, center: corridor, zoom: 11.05, pitch: 48, bearing: -16 },
    { at: 15_000, ...maintenance, pitch: 54, bearing: -12 },
    { at: 27_000, ...targets.assessment, pitch: 60, bearing: -12 },
    { at: 40_000, center: corridor, zoom: 11.15, pitch: 50, bearing: 48 },
    { at: 47_000, center: targets.closure ?? site, zoom: targets.closure ? 15.3 : 12.8, pitch: 57, bearing: 64 },
    { at: 54_000, ...response, pitch: 54, bearing: 32 },
    { at: 88_000, center: corridor, zoom: 11.05, pitch: 48, bearing: 12 },
    { at: 92_000, center: site, zoom: 12.2, pitch: 60, bearing: -28 },
  ];
  const index = Math.max(0, shots.findLastIndex(shot => shot.at <= time));
  const next = shots[index];
  const previous = shots[Math.max(0, index - 1)];
  // Hold the whole response corridor so both fixed bases and the 2/2 crew split stay visible.
  const t = reducedMotion ? 1 : Math.min(1, (time - next.at) / 3_600);
  const eased = t * t * (3 - 2 * t);
  const mix = (a: number, b: number) => a + (b - a) * eased;
  return {
    center: [mix(previous.center[0], next.center[0]), mix(previous.center[1], next.center[1])],
    zoom: mix(previous.zoom, next.zoom),
    pitch: reducedMotion ? 50 : mix(previous.pitch, next.pitch),
    bearing: reducedMotion ? -28 : mix(previous.bearing, next.bearing),
  };
}
