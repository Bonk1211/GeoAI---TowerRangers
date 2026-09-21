import type { Decision } from '../api/types';

// Single source of truth for severity colour. The map layer, the legend, the
// drawer and the schedule grid all read from here — previously the map carried
// its own hardcoded triad and disagreed with every other surface.
// These are the only warm hues used for tower severity. Interface chrome uses
// the cool accent; other map quantities need their own numeric legend.
//
// LIGHT THEME: there are now TWO ramps and they are not interchangeable.
//
//   COLORS      large fills — map circles, bars, spines, chips.  >=3:1
//   INK_COLORS  anything a user READS — labels, values, strokes. >=4.5:1
//
// The dark theme got away with one ramp because a saturated hue on near-black
// clears both bars at once. On white it does not: the old watch #ffb244
// measures 1.90:1 as text and 1.55:1 as a fill. Every value below is measured
// against #ffffff and against the page ground #f2f5fa, worst case shown.
//
// Reach for bandColor() for a fill and bandInk() for text. If you find
// bandColor() driving a `color:` property, that is the bug.
export const COLORS: Record<Decision, string> = {
  maintain: '#e04a2f', // 3.70:1 on ground
  watch: '#c47500', //    3.26:1 on ground
  ok: '#0d9673', //       3.41:1 on ground
};

export const INK_COLORS: Record<Decision, string> = {
  maintain: '#c2321c', // 5.10:1 on ground
  watch: '#8a5300', //    5.79:1 on ground
  ok: '#00735a', //       5.34:1 on ground
};

// Darkened from the dark theme's #4a5878, which measured 1.34:1 as a fill on
// the light basemap — an unscored tower was effectively invisible.
export const UNSCORED_COLOR = '#7c8799'; // 3.32:1 on ground

// The neutral ink twin of UNSCORED_COLOR — same two-ramp discipline as
// COLORS/INK_COLORS above (fills clear 3:1, text/thin marks need 4.5:1).
// UNSCORED_COLOR was measured only as a FILL; using it for text or a thin
// stroke is the exact second-ramp mistake that rule exists to prevent.
export const UNSCORED_INK = '#5a6577'; // >=4.5:1 on ground

// Same violet identity as the dark theme, darkened to carry text and focus.
// The dark theme's #C084FC measures 2.05:1 on white and cannot be read.
export const ACCENT = '#7c3aed'; // 5.21:1 on ground
export const ALERT = '#e01b41'; //  4.36:1 on ground
export const ALERT_INK = '#c2183c'; // 5.51:1 on ground

/** Band colour for a FILL — map circles, bars, spines, chip backgrounds. */
export function bandColor(decision: Decision): string {
  return COLORS[decision];
}

/** Band colour for TEXT or any thin mark that has to be read. */
export function bandInk(decision: Decision): string {
  return INK_COLORS[decision];
}
