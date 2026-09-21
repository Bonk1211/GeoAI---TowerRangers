import type { Beat } from './simulationTimeline';
import type { ScheduleRun } from '../api/types';

/**
 * Resolves a beat's `<placeholder>` tokens against real backend results.
 * Pure and dependency-free (no React), so it is unit-testable like the
 * other `lib/` modules — `SimulationConsole.tsx` is the only caller.
 *
 * Placeholders are resolved from whichever run the beat's `id` implies:
 * `optimize`/`urgency-shift` (the pre-event narration) read `optimizeRun`;
 * `harden` reads the first Sabah entry of `optimizeRun`; `generators` reads
 * `generatorSiteCount` — the scenario's own `generatorSiteSelector` count
 * (2026-09-17), NOT `downTowerCount`: pre-positioning ahead of an event and
 * how many towers that event later takes down are different quantities
 * that happened to share a value before this fix, which is exactly the
 * kind of coincidence that reads as a real relationship until the two
 * numbers diverge on a different scenario; `cow` reads `cowClusterCount` —
 * the same `clusterDownTowers` grouping the map uses for deployment sites,
 * so the console's count and the number of jeep icons on screen never
 * disagree.
 * `antenna-retune` reads `retuneNeighborCount` — the summed
 * `assignRetuningNeighbors` cell count the map is drawing cones for, so the
 * console's number and the cones on screen never disagree (the same
 * discipline `cow` follows). This beat shipped with a `<n>` in its text and
 * NO case here, so the console printed the literal token to the viewer; the
 * `BEATS`-wide leak test added alongside this case is what stops the next one.
 * `generator-dispatch` reads `emergencyRun.entries` filtered to
 * `pin_reason === 'emergency'` (2026-09-17 — was a single scenario
 * down-tower id; the underlying dispatch now fans out to every down tower
 * against the same `run_id`, so the text reports how many sites the commit
 * actually reached rather than naming just the first). `emergencyRun`'s
 * arrival separately gates the console's REAL/degraded badge for that
 * beat, which is `SimulationConsole`'s job, not this function's. Every
 * other beat's text is already complete and passes through unchanged.
 *
 * A beat whose backing run has not resolved yet keeps its raw
 * `<placeholder>` text rather than inventing a number — the caller
 * (`SimulationConsole`) is responsible for showing a "resolving…"/degraded
 * state alongside it, this function only ever fills in what it actually
 * has.
 */
export interface ConsoleLineContext {
  optimizeRun: ScheduleRun | null;
  emergencyRun: ScheduleRun | null;
  sabahTowerIds: Set<string>;
  downTowerId: string | null;
  cowClusterCount: number;
  generatorSiteCount: number;
  /**
   * Retuning neighbour cells, or null when the geometry has not been
   * computed yet (towers still loading, no down tower chosen). Null is NOT
   * zero: zero is a real finding — nothing eligible within range — and is
   * printed as such, while null keeps the raw placeholder rather than
   * inventing a count, per this module's rule above.
   */
  retuneNeighborCount: number | null;
  /**
   * Pre-event hardening units the map is drawing routed vehicles for, or
   * null before the legs have resolved (towers/crews still loading, the
   * optimize run not yet back, roads unavailable). Same discipline as
   * `cowClusterCount` and `retuneNeighborCount`: the console reads the
   * SAME array the map draws from, so the sentence and the vehicles on
   * screen can never disagree about how many crews went out.
   *
   * Null is not zero. Zero is a real finding — this run's solver output
   * contains no Sabah civil flood order — and the beat keeps its raw
   * placeholder rather than announcing "0 sites" as though that were a
   * dispatch, which is what the caller's degraded state is for.
   */
  hardeningSiteCount: number | null;
}

/**
 * The substitutions a given beat's text needs, or `null` when the backing
 * run has not resolved yet (caller keeps the raw placeholder text).
 *
 * Split out from the formatting (2026-09-20) so `headline` and `console`
 * resolve through the SAME lookup: a beat's plain-language headline and its
 * technical detail line both carry `<n>`/`<tower_id>` placeholders, and two
 * separate switch statements would be two places for a number to drift.
 * One resolver, applied to whichever string the caller asks for.
 */
function substitutionsFor(beat: Beat, context: ConsoleLineContext): Record<string, string> | null {
  const {
    optimizeRun, emergencyRun, sabahTowerIds, downTowerId,
    cowClusterCount, generatorSiteCount, retuneNeighborCount, hardeningSiteCount,
  } = context;

  switch (beat.id) {
    case 'urgency-shift': {
      if (!optimizeRun) return null;
      const n = optimizeRun.entries.filter((e) => sabahTowerIds.has(e.tower_id)).length;
      return { '<n>': String(n) };
    }
    case 'optimize': {
      if (!optimizeRun) return null;
      const crewIds = new Set(optimizeRun.entries.map((e) => e.crew_id));
      return {
        '<n>': String(optimizeRun.entries.length),
        '<k>': String(crewIds.size),
      };
    }
    case 'harden': {
      // Zero defers alongside null here, unlike `cow`/`antenna-retune`
      // where zero is a publishable finding ("nothing eligible in range").
      // This beat asserts crews WERE dispatched, so "0 sites" would be the
      // line contradicting itself; the caller shows it degraded instead.
      if (!hardeningSiteCount) return null;
      return { '<n>': String(hardeningSiteCount) };
    }
    case 'generators':
      return { '<n>': String(generatorSiteCount) };
    case 'cow':
      return { '<n>': String(cowClusterCount) };
    case 'antenna-retune': {
      if (retuneNeighborCount === null) return null;
      return { '<n>': String(retuneNeighborCount) };
    }
    case 'tower-down': {
      if (!downTowerId) return null;
      return { '<tower_id>': downTowerId };
    }
    case 'generator-dispatch': {
      if (!emergencyRun) return null;
      const n = emergencyRun.entries.filter((e) => e.pin_reason === 'emergency').length;
      return { '<n>': String(n) };
    }
    case 'restore': {
      if (!downTowerId) return null;
      return { '<tower_id>': downTowerId };
    }
    default:
      return {};
  }
}

function applySubstitutions(template: string, subs: Record<string, string> | null): string {
  if (!subs) return template;
  let out = template;
  for (const [token, value] of Object.entries(subs)) {
    out = out.replace(token, value);
  }
  return out;
}

export function resolveConsoleLine(beat: Beat, context: ConsoleLineContext): string {
  return applySubstitutions(beat.console, substitutionsFor(beat, context));
}

/**
 * The beat's plain-language headline with the same live values filled in —
 * what `SimulationConsole` renders as the primary line (2026-09-20). Shares
 * `substitutionsFor` with `resolveConsoleLine` by construction, so the
 * headline's "<n> jobs" and the detail's "<n> work orders" are always the
 * same n.
 */
export function resolveHeadline(beat: Beat, context: ConsoleLineContext): string {
  return applySubstitutions(beat.headline, substitutionsFor(beat, context));
}
