import { useSimulation } from '../../state/useSimulation';
import type { SimulationPhase } from '../../lib/simulationTimeline';

/** Four phase markers, current one lit — reads the store's real `phase`,
 *  itself derived from `lib/simulationTimeline.ts::phaseAt`. */
const PHASES: { id: SimulationPhase; label: string; clockLabel: string }[] = [
  { id: 'pre', label: 'Pre-event', clockLabel: 'T-72h' },
  { id: 'impact', label: 'Impact', clockLabel: 'T-0' },
  { id: 'response', label: 'Response', clockLabel: 'T+2h' },
  { id: 'recovery', label: 'Recovery', clockLabel: 'T+24h' },
];

export function PhaseStrip() {
  const status = useSimulation((s) => s.status);
  const phase = useSimulation((s) => s.phase);
  const currentPhase = status === 'idle' ? null : phase;

  const activeIndex = currentPhase ? PHASES.findIndex((p) => p.id === currentPhase) : -1;

  return (
    <ol
      className="flex shrink-0 items-start rounded-xl border border-overlay/10 bg-overlay/[0.03] p-3"
      aria-label="Scenario phase"
    >
      {PHASES.map((p, i) => {
        const active = p.id === currentPhase;
        const done = activeIndex >= 0 && i < activeIndex;
        return (
          <li
            key={p.id}
            aria-current={active ? 'step' : undefined}
            className="flex flex-1 items-start"
          >
            {i > 0 && (
              <span
                aria-hidden="true"
                className={`mt-[5px] h-px flex-1 ${done || active ? 'bg-accent/60' : 'bg-overlay/15'}`}
              />
            )}
            <div className="flex flex-col items-center gap-1 px-1">
              <span
                aria-hidden="true"
                className={`h-2.5 w-2.5 shrink-0 rounded-full ${
                  active ? 'bg-accent' : done ? 'bg-accent/50' : 'bg-overlay/25'
                }`}
              />
              <span
                className={`whitespace-nowrap text-ui ${active ? 'font-medium text-fg' : 'text-muted'}`}
              >
                {p.label}
              </span>
              <span className="font-mono text-micro tnum text-dim">{p.clockLabel}</span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
