import { isScored } from '../../fixtures/towers';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { COLORS } from '../../lib/colors';
import { Panel } from '../ui/Panel';

import { PieChart, Pie, Cell, ResponsiveContainer } from 'recharts';

// Illustrative: "caught by age-based inspection" needs tower install-age data
// we don't have in the fixture; the split below is an assumed ratio for the demo.
const ASSUMED_CAUGHT_FRACTION = 0.32;

export function BaselineTile() {
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const maintainCount = towers.filter((t) => isScored(t) && t.decision === 'maintain').length;
  const caught = Math.round(maintainCount * ASSUMED_CAUGHT_FRACTION);
  const missed = maintainCount - caught;

  const data = [
    { name: 'Caught', value: caught, color: COLORS.ok },
    { name: 'Missed', value: missed, color: COLORS.maintain },
  ];

  return (
    <Panel title="Versus calendar inspection" footnote="Illustrative — assumes a 32% catch rate on age-based rounds.">
      <div className="flex items-center gap-4">
        <div className="relative h-[92px] w-[92px] shrink-0">
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data}
                cx="50%"
                cy="50%"
                innerRadius="70%"
                outerRadius="100%"
                stroke="none"
                dataKey="value"
                isAnimationActive={false}
              >
                {data.map((entry) => (
                  <Cell key={entry.name} fill={entry.color} />
                ))}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-display text-title font-semibold leading-none tnum text-fg">{caught}</span>
            <span className="text-eyebrow tnum text-dim">of {maintainCount}</span>
          </div>
        </div>

        <dl className="min-w-0 space-y-2 text-ui">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLORS.ok }} />
            <dt className="text-muted">Caught by calendar</dt>
            <dd className="tnum text-fg">{caught}</dd>
          </div>
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: COLORS.maintain }} />
            <dt className="text-muted">Missed</dt>
            <dd className="tnum text-fg">{missed}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
