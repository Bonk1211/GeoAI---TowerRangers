import { readinessByTeam } from '../../lib/readiness';
import { useTerritoryRun } from '../../state/useTerritoryRun';
import { useBaselineQuery } from '../../api/queries';

/**
 * The readiness bar: a compact strip in the Schedule PageHeader, not a
 * replacement for it. Left side shows per-team reserve as four chips (always
 * ROLE_TEAMS order, via readinessByTeam — Task 17); right side shows the
 * optimizer's risk-weighted wait against naive nearest-first dispatch.
 *
 * Chips are chrome, not severity: reserve is protected absence, neither risk
 * nor a control state, so they stay on the cool accent rather than the warm
 * triad reserved for band colour.
 *
 * Counts come from useTerritoryRun(), not the raw store run: the solver
 * plans all 16 territories at once, so the unscoped run.reserve reports
 * national cover — roughly sixteen times the crew the board beside it draws.
 *
 * The delta renders '—' whenever the baseline query has no data — loading,
 * errored, or offline. Never a fabricated 0%: see useBaselineQuery and the
 * rho_mean: 0 precedent in useStabilityQuery.
 */
export function ReadinessBar() {
  const { run } = useTerritoryRun();
  const baselineQuery = useBaselineQuery();
  const baseline = baselineQuery.data ?? null;
  const teams = readinessByTeam(run);

  const deltaLabel =
    baseline !== null ? `${baseline.risk_weighted_wait_reduction_pct.toFixed(0)}%` : '—';

  return (
    <div className="flex items-center gap-3 rounded-lg border border-overlay/10 bg-overlay/[0.04] px-3 py-1.5">
      <div className="flex items-center gap-2.5">
        {teams.map((team) => (
          <div key={team.crewType} className="flex items-center gap-1.5" title={team.label}>
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                team.availableToday ? 'bg-accent' : 'bg-overlay/20'
              }`}
            />
            <span className="text-micro whitespace-nowrap text-muted">
              {team.label} · <span className="tnum">{team.reserveDays}</span> crew-days
            </span>
          </div>
        ))}
      </div>
      <div className="h-4 w-px shrink-0 bg-overlay/10" aria-hidden="true" />
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        <span className="eyebrow">Wait vs. naive</span>
        <span className="tnum text-ui font-medium text-fg">{deltaLabel}</span>
      </div>
    </div>
  );
}
