import type { MapView } from '../state/useMapInstance';

/**
 * Real lat/lon graticule lines for the HUD edge ticks.
 *
 * The 1b spec permits a cosmetic fixed-pitch grid but conditions it: "if you
 * fake it, do not label it with real coordinates." The edge ticks carry real
 * coordinates from map.getBounds(), so the grid lines they belong to are
 * computed from the same bounds — a fixed 120px grid under real labels would
 * read as a coordinate grid that lies.
 */

// Degree steps that produce human-readable labels. Picked so the chosen step
// always lands on round decimals rather than arbitrary fractions.
const STEPS = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01, 0.005, 0.002, 0.001];

/** Largest step that still yields at most `target` lines across `span` degrees. */
export function pickStep(span: number, target = 6): number {
  for (const step of STEPS) {
    if (span / step >= 2 && span / step <= target) return step;
  }
  return span / target > STEPS[0] ? STEPS[0] : STEPS[STEPS.length - 1];
}

export interface Tick {
  /** Degrees. */
  value: number;
  /** Position along the axis, 0-1, where 0 is west (lon) or north (lat). */
  fraction: number;
  label: string;
}

function decimalsFor(step: number): number {
  if (step >= 1) return 1;
  if (step >= 0.1) return 2;
  if (step >= 0.01) return 3;
  return 4;
}

function ticksBetween(lo: number, hi: number, suffixPos: string, suffixNeg: string): Tick[] {
  const span = hi - lo;
  if (!Number.isFinite(span) || span <= 0) return [];
  const step = pickStep(span);
  const decimals = decimalsFor(step);
  const first = Math.ceil(lo / step) * step;
  const out: Tick[] = [];
  for (let v = first; v <= hi + 1e-9; v += step) {
    // Re-round each value: repeated float addition drifts enough to show up in
    // a 3-decimal label.
    const value = Number((Math.round(v / step) * step).toFixed(6));
    if (value < lo) continue;
    const suffix = value >= 0 ? suffixPos : suffixNeg;
    out.push({
      value,
      fraction: (value - lo) / span,
      label: `${Math.abs(value).toFixed(decimals)}\u00b0${suffix}`,
    });
  }
  return out;
}

/** West-to-east, fraction 0 at the west edge. */
export function lonTicks(view: MapView): Tick[] {
  return ticksBetween(view.west, view.east, 'E', 'W');
}

/** North-to-south, fraction 0 at the top edge, matching screen order. */
export function latTicks(view: MapView): Tick[] {
  return ticksBetween(view.south, view.north, 'N', 'S').map((t) => ({
    ...t,
    fraction: 1 - t.fraction,
  }));
}

/**
 * A round distance and the pixel width that represents it, for the scale rule.
 * Targets `targetPx` and snaps down to a 1/2/5 x 10^n metre value.
 */
export function scaleBar(metresPerPixel: number, targetPx = 40): { px: number; label: string } {
  const rawMetres = metresPerPixel * targetPx;
  if (!Number.isFinite(rawMetres) || rawMetres <= 0) return { px: targetPx, label: '—' };
  const magnitude = Math.pow(10, Math.floor(Math.log10(rawMetres)));
  const normalised = rawMetres / magnitude;
  const snapped = (normalised >= 5 ? 5 : normalised >= 2 ? 2 : 1) * magnitude;
  const px = snapped / metresPerPixel;
  const label = snapped >= 1000 ? `${(snapped / 1000).toFixed(snapped % 1000 === 0 ? 0 : 1)} km` : `${snapped} m`;
  return { px, label };
}

/**
 * A graticule line as it actually falls on screen.
 *
 * `fraction` positioning only works while the camera looks straight down: it
 * assumes longitude maps linearly to screen x. Tilt the camera and a meridian
 * becomes a converging line heading for the horizon, so the flat version draws
 * a grid that does not match its own labels — the exact failure the module
 * docstring warns about, arriving by a different route.
 *
 * These are real projected polylines, so they are correct at any pitch, and
 * correct with terrain enabled too (MapLibre's project() accounts for both).
 */
export interface GraticuleLine {
  value: number;
  label: string;
  /** Screen-space polyline, already clipped to what is drawable. */
  points: { x: number; y: number }[];
  /** Where to put the label, or null when the line is off screen. */
  labelAt: { x: number; y: number } | null;
}

/** Samples per line. Enough to stay smooth at high pitch without waste. */
const SAMPLES = 24;

function clipVisible(
  pts: { x: number; y: number }[],
  width: number,
  height: number,
): { x: number; y: number }[] {
  // MapLibre projects points behind the camera to coordinates far outside the
  // canvas; drawing those produces a line shooting across the screen. The
  // margin is generous so lines still enter and leave the frame naturally.
  const mx = width * 2;
  const my = height * 2;
  return pts.filter(
    (p) =>
      Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > -mx && p.x < mx && p.y > -my && p.y < my,
  );
}

function nearestTo(
  pts: { x: number; y: number }[],
  axis: 'x' | 'y',
  target: number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (const p of pts) {
    const d = Math.abs(p[axis] - target);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * Projected graticule for the current view.
 *
 * `project` is injected rather than imported so this module stays pure and
 * node-checkable — the same reason lib/ carries no React.
 *
 * @param labelY screen y the longitude labels sit on
 * @param labelX screen x the latitude labels sit on
 */
export function graticuleGeometry(
  view: MapView,
  project: (lon: number, lat: number) => { x: number; y: number },
  size: { width: number; height: number },
  labelY: number,
  labelX: number,
): { lon: GraticuleLine[]; lat: GraticuleLine[] } {
  const lonVals = ticksBetween(view.west, view.east, 'E', 'W');
  const latVals = ticksBetween(view.south, view.north, 'N', 'S');

  const lon = lonVals.map((t) => {
    const pts = clipVisible(
      Array.from({ length: SAMPLES }, (_, i) =>
        project(t.value, view.south + ((view.north - view.south) * i) / (SAMPLES - 1)),
      ),
      size.width,
      size.height,
    );
    return { value: t.value, label: t.label, points: pts, labelAt: nearestTo(pts, 'y', labelY) };
  });

  const lat = latVals.map((t) => {
    const pts = clipVisible(
      Array.from({ length: SAMPLES }, (_, i) =>
        project(view.west + ((view.east - view.west) * i) / (SAMPLES - 1), t.value),
      ),
      size.width,
      size.height,
    );
    return { value: t.value, label: t.label, points: pts, labelAt: nearestTo(pts, 'x', labelX) };
  });

  return { lon, lat };
}

/** Formats a coordinate pair for the bottom-left cursor readout. */
export function formatCoord(lon: number, lat: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(4)}\u00b0${ns}  ${Math.abs(lon).toFixed(4)}\u00b0${ew}`;
}
