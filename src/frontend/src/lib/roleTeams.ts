import { CREW_TYPE_GLYPH } from './gantt.ts';

/**
 * The four crew types, as capabilities rather than as a flat crew list.
 *
 * The roster was already role-typed and actions.yaml already maps each Annex C
 * factor onto a type — but on the Sunway AOI every maintain-band tower resolves
 * to flood work, so only civil crews were ever drawn and the board read as one
 * undifferentiated pool. Grouping by type is what makes the mapping legible.
 *
 * Identity is carried by grouping, label, glyph AND colour.
 *
 * It used to be the first three only — the design system reserved colour for
 * chrome and severity, so a fifth hue was refused on the grounds that a warm
 * colour on screen must always mean risk. That held as a principle and failed
 * as a design: the glyph is a 14px grey stroke and the label is 12px, so four
 * capabilities rendered as four identical stripes and the grouping this module
 * exists to express was invisible on the board.
 *
 * The colour is cool (see lib/roleColors.ts for the ramp and the measurements)
 * precisely so the original property survives where it matters: warm still
 * means severity, and a job bar can show its role and its risk at once without
 * the two readings colliding. Grouping, label and glyph all stay — colour is
 * added to them, never substituted for them, so the board still survives
 * greyscale and still reads for a colour-blind planner.
 */
export interface RoleTeam {
  crewType: string;
  label: string;
  /** Annex C factors this team's work orders answer. */
  answers: string;
  glyph: string | undefined;
  /**
   * Key into lib/roleColors.ts. Always equal to `crewType` today — it exists
   * so a future team whose colour should not be derived from its type string
   * can say so, rather than forcing a rename of the crew type itself.
   */
  tone: string;
  /**
   * Shown when the group has no work in the current AOI. Required, not
   * optional — an unexplained empty group reads as a bug, and hiding it would
   * hide a real capability from the planner.
   */
  emptyReason: string;
}

export const ROLE_TEAMS: readonly RoleTeam[] = [
  {
    crewType: 'civil',
    tone: 'civil',
    label: 'Civil',
    answers: 'A1 flood · A2 terrain',
    glyph: CREW_TYPE_GLYPH.civil,
    emptyReason: 'No flood or terrain work scheduled in this AOI.',
  },
  {
    crewType: 'power',
    tone: 'power',
    label: 'Power',
    answers: 'A3 grid dependence',
    glyph: CREW_TYPE_GLYPH.power,
    emptyReason: 'No grid-dependence work scheduled in this AOI.',
  },
  {
    crewType: 'rf',
    tone: 'rf',
    label: 'RF',
    answers: 'A4 equipment vintage',
    glyph: CREW_TYPE_GLYPH.rf,
    emptyReason: 'No equipment-refresh work scheduled in this AOI.',
  },
  {
    crewType: 'electrical',
    tone: 'electrical',
    label: 'Electrical',
    answers: 'A5 lightning',
    // Not "no work today" — the factor itself is unavailable on this dataset.
    // model/risk_index.py's AHP_FACTORS matrix is a fixed 5x5 (flood, terrain,
    // lightning, equipment, power) and ahp_weights() always runs the
    // eigenvector computation over the full 5x5 — it never shrinks. What
    // actually happens is post-hoc column dropping: prepare_pilot_dataset.py
    // sets flash_density = NaN for every row, adapter/ml_source.py then drops
    // the "lightning" column from the noisy-OR input DataFrame, and
    // factor_weights(columns) filters the already-computed weights dict down
    // to the surviving columns (4, or 5 with age). So the lightning membership
    // term is simply absent from the score, and no lightning work order can
    // ever be produced here. Saying "no work" would imply the opposite of
    // what is true.
    emptyReason: 'No lightning work — the A5 factor is unavailable on this dataset.',
    glyph: CREW_TYPE_GLYPH.electrical,
  },
];

export function roleTeam(crewType: string): RoleTeam | undefined {
  return ROLE_TEAMS.find((t) => t.crewType === crewType);
}
