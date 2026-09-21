// Single source of truth for crew-capability colour, and a deliberate sibling
// of lib/colors.ts rather than a competing system: same two-ramp construction,
// same measured-not-eyeballed discipline, same fill-vs-ink split.
//
// WHY THIS FILE EXISTS AT ALL
//
// The design system's original rule allowed colour to carry only two things —
// interface chrome (the cool accent) and tower severity (the warm triad) — so
// crew capability was left to grouping, label and glyph. lib/roleTeams.ts said
// so explicitly. In practice the glyph is a 14px grey stroke and the label is
// 12px, so on a 900px board Civil / Power / RF / Electrical rendered as four
// identical stripes and the capability grouping — the whole point of the
// role-grouped timeline — was invisible.
//
// The rule was overruled for the schedule tab. Crew type now carries a hue.
//
// WHY THESE HUES AND NOT WARMER ONES
//
// The ramp is cool (indigo / sky / cyan / slate) for a legibility reason, not
// because the old prohibition survives. A job bar carries role AND severity
// simultaneously — role on its group and rail, severity on its own fill and
// risk chip. If role could be orange, a reader could not tell which of the two
// a given warm mark was answering. Cool role + warm severity keeps both
// readable on the same element. Warm on a control is still a bug.
//
// TWO RAMPS, NOT INTERCHANGEABLE — the same trap lib/colors.ts documents:
//
//   ROLE_COLORS  large fills — chip washes, spines, meter fills.  >=3:1
//   ROLE_INK     anything a user READS — labels, glyph strokes.   >=4.5:1
//
// Every value below is measured against #ffffff and against the page ground
// #f2f5fa, worst case (the ground) shown. The ink ramp is additionally
// measured against its OWN 10% wash composited on the ground — which is what
// a chip actually renders as, and is the figure that matters for the group
// header and the rail chip. Lowest of those is 5.81:1 (rf), clearing AA.
//
// Mirrored as --color-role-* tokens in index.css so Tailwind utilities
// resolve; components should prefer these functions, because they carry the
// unknown-crew-type fallback.

/** Role colour for a FILL — chip washes, spines, meter fills. */
export const ROLE_COLORS: Record<string, string> = {
  civil: '#4f46e5', //      5.75:1 on ground — indigo
  power: '#0369a1', //      5.43:1 on ground — sky
  rf: '#0e7490', //         4.90:1 on ground — cyan
  electrical: '#64748b', // 4.35:1 on ground — slate
};

/** Role colour for TEXT or any thin mark that has to be read. */
export const ROLE_INK: Record<string, string> = {
  civil: '#4338ca', //      7.23:1 on ground
  power: '#075985', //      6.92:1 on ground
  rf: '#155e75', //         6.65:1 on ground
  electrical: '#475569', // 6.93:1 on ground
};

// A crew_type the roster carries but this file does not know about must not
// render as `undefined` (which CSS drops, leaving an uncoloured mark that reads
// as "no capability" rather than "unrecognised capability"). It falls back to
// the neutral slate the electrical team already uses.
const FALLBACK = ROLE_COLORS.electrical;
const FALLBACK_INK = ROLE_INK.electrical;

/** Role colour for a FILL. Falls back to neutral slate for unknown types. */
export function roleColor(crewType: string): string {
  return ROLE_COLORS[crewType] ?? FALLBACK;
}

/** Role colour for TEXT. Falls back to neutral slate for unknown types. */
export function roleInk(crewType: string): string {
  return ROLE_INK[crewType] ?? FALLBACK_INK;
}

/**
 * The tinted-chip recipe the map console already uses for its band chip
 * (components/hud/SelectionHud.tsx): ink text, a 40%-alpha border, and a
 * 10%-alpha wash. Hoisted into a function because the schedule tab now draws
 * this same construction at four different scales — group header, rail chip,
 * job bar, risk chip — and four hand-typed copies of `${hue}66` is how the
 * band triad drifted out of sync across the map layer in the first place.
 *
 * `wash` and `line` are alpha suffixes on a 6-digit hex, so the caller can
 * tune emphasis without recomputing a colour.
 */
export function tintedChip(
  fill: string,
  ink: string,
  wash = '1a',
  line = '66',
): { color: string; backgroundColor: string; borderColor: string } {
  return {
    color: ink,
    backgroundColor: `${fill}${wash}`,
    borderColor: `${fill}${line}`,
  };
}
