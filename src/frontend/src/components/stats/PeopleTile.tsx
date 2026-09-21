import { isScored } from '../../fixtures/towers';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { Panel } from '../ui/Panel';

// Illustrative: population-per-footprint-cell factor is an assumed parameter,
// not a real footprint extraction result (perception exports aren't wired yet).
const ASSUMED_PEOPLE_PER_MAINTAIN_TOWER = 5350;

export function PeopleTile() {
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const maintainCount = towers.filter((t) => isScored(t) && t.decision === 'maintain').length;
  const people = maintainCount * ASSUMED_PEOPLE_PER_MAINTAIN_TOWER;

  return (
    <Panel title="People served" footnote="Illustrative — assumes 5,350 people per maintain-band tower.">
      <div className="flex items-baseline gap-2">
        <span className="font-display text-display font-semibold leading-none tracking-tight tnum text-fg">
          {(people / 1000).toFixed(0)}k
        </span>
        <span className="text-ui text-muted">people</span>
      </div>
      <p className="mt-2 text-ui leading-relaxed text-muted">
        live in cells covered by the{' '}
        <span className="tnum text-fg">{maintainCount}</span> towers flagged for maintenance.
      </p>
    </Panel>
  );
}
