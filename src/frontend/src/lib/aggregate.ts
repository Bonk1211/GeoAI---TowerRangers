import type { Tower } from '../api/types';
import { isScored } from '../fixtures/towers';

export interface BandCounts {
  maintain: number;
  watch: number;
  ok: number;
}

export function bandCounts(towers: Tower[]): BandCounts {
  const scored = towers.filter(isScored);
  return {
    maintain: scored.filter((t) => t.decision === 'maintain').length,
    watch: scored.filter((t) => t.decision === 'watch').length,
    ok: scored.filter((t) => t.decision === 'ok').length,
  };
}

export function scoredCount(towers: Tower[]): number {
  return towers.filter(isScored).length;
}

export interface DriverShare {
  factor: string;
  pct: number;
}

/**
 * Mean attribution share per factor across the maintain set — the same
 * quantity the drawer's "Why this score" panel shows, aggregated.
 *
 * Previously this counted `dominant_factor` instead. That collapses each
 * tower to a single winner, so on an AOI with one prevailing hazard every
 * factor but the winner is absent from the map entirely and the tile renders
 * a lone 100% bar — indistinguishable from a broken chart, and it drops the
 * information that the other factors are non-zero. Averaging the shares keeps
 * every factor present and lets the tile agree with the drawer.
 */
export function driverMix(towers: Tower[]): DriverShare[] {
  const maintainTowers = towers.filter((t) => isScored(t) && t.decision === 'maintain');
  if (maintainTowers.length === 0) return [];
  const totals: Record<string, number> = {};
  for (const t of maintainTowers) {
    for (const [factor, share] of Object.entries(t.attribution)) {
      totals[factor] = (totals[factor] ?? 0) + share;
    }
  }
  return Object.entries(totals)
    .map(([factor, sum]) => ({ factor, pct: sum / maintainTowers.length }))
    .sort((a, b) => b.pct - a.pct);
}

export interface AreaCount {
  territory: string;
  total: number;
  maintain: number;
}

/**
 * Towers per territory, with the maintain count that decides ordering.
 *
 * Sorted by maintain-band count and then by total, rather than alphabetically
 * or by size alone: the list is a filter control on a console whose job is
 * dispatch, so the territory with the most work to do belongs at the top. A
 * plain size sort would lead with whichever state OpenStreetMap has mapped
 * most thoroughly, which is a statement about OSM and not about the network.
 *
 * `unassigned` is kept rather than dropped. It is a handful of towers whose
 * coordinates fall outside every ADM1 outer ring, and silently hiding them
 * would make the territory counts fail to add up to the tower total for
 * reasons nobody could see on screen.
 */
export function areaCounts(towers: Tower[]): AreaCount[] {
  const byTerritory = new Map<string, AreaCount>();
  for (const t of towers.filter(isScored)) {
    const territory = t.territory || 'unassigned';
    const row = byTerritory.get(territory) ?? { territory, total: 0, maintain: 0 };
    row.total += 1;
    if (t.decision === 'maintain') row.maintain += 1;
    byTerritory.set(territory, row);
  }
  return [...byTerritory.values()].sort(
    (a, b) => b.maintain - a.maintain || b.total - a.total || a.territory.localeCompare(b.territory),
  );
}
