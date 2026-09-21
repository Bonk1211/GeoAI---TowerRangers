import { useEffect, useState } from 'react';
import { useSimulation } from '../../state/useSimulation';

/**
 * Pop-out notification for the 'optimize' beat's real backend result
 * (2026-09-17, operator review): the beat has always fired at T-48h with
 * `evidence: 'real'` — a genuine `/schedule/optimize` call — but its only
 * on-screen presence was one line buried in the scrolling console
 * transcript. The operator's ask was explicit: the moment the optimizer
 * has packed maintenance-need work orders into crew-days, that is worth a
 * notification a viewer's eye actually lands on, not a line that has
 * already scrolled past by the time the response phase begins.
 *
 * Heading reads "Work orders raised", not "Abnormalities detected"
 * (mcmc-domain-reviewer, C8 review pass) — this system schedules
 * maintenance need and urgency, never a detected fault or anomaly
 * (`docs/Backend_Handoff.md` §0.6), and "abnormality" is anomaly-
 * detection/failure-prediction vocabulary this codebase is not entitled
 * to, on the one card whose entire purpose is to be the thing a viewer's
 * eye lands on first.
 *
 * This card renders ONLY real optimizer output — the same `optimizeRun`
 * `SimulationConsole` already reads — never narrated or invented numbers,
 * matching this beat's own `evidence: 'real'` classification. It appears
 * once `optimizeRun` resolves and stays until the viewer dismisses it or
 * starts a new run (`runSeq` change resets the dismissal), rather than
 * auto-hiding on a timer: a planner-facing alert about 49 work orders is
 * exactly the kind of thing that must not silently disappear before it's
 * read.
 *
 * Two honesty-surface fixes from the same review pass (simulation-ux-
 * reviewer, C8): every other surface on this tab carries a REAL/MECHANISM/
 * ILLUSTRATIVE word badge (SimulationConsole, SimulationLegend) — this
 * card is the single highest-salience element on screen and originally
 * carried none, so it's added here in the same style. And the body text
 * now says "in this scenario run" — the numbers are real backend output,
 * but the FLOOD that produced this optimize call is scripted, and a card
 * floating on top of the map (rather than docked in the console column
 * with SimulationBanner's disclaimer above it) is exactly the kind of
 * element a viewer's eye can land on without ever tracing back up to that
 * banner.
 */
export function WorkOrderAlert() {
  const status = useSimulation((s) => s.status);
  const optimizeStatus = useSimulation((s) => s.optimizeStatus);
  const optimizeRun = useSimulation((s) => s.optimizeRun);
  const runSeq = useSimulation((s) => s.runSeq);
  const [dismissed, setDismissed] = useState(false);
  const [dismissedRunSeq, setDismissedRunSeq] = useState(-1);

  // A new run (Start after Reset, or a replay from 'done') must show the
  // card again even if the previous run's card was dismissed — tracked by
  // runSeq rather than resetting on every render, so a dismiss during THIS
  // run stays dismissed through pause/resume.
  useEffect(() => {
    if (dismissedRunSeq !== runSeq) setDismissed(false);
  }, [runSeq, dismissedRunSeq]);

  if (status === 'idle') return null;
  if (optimizeStatus !== 'ready' || !optimizeRun) return null;
  if (dismissed && dismissedRunSeq === runSeq) return null;

  const crewIds = new Set(optimizeRun.entries.map((e) => e.crew_id));

  return (
    <div
      role="status"
      aria-live="polite"
      className="glass-float pointer-events-auto absolute left-3 top-3 z-20 max-w-[280px] rounded-xl p-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <p className="text-eyebrow font-medium uppercase tracking-wide text-accent">
            Work orders raised
          </p>
          <span
            className="rounded border border-overlay/30 px-1 py-px text-micro font-sans font-medium uppercase tracking-wide text-muted"
            title="Evidence: REAL — live optimizer output"
          >
            REAL
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            setDismissedRunSeq(runSeq);
          }}
          className="-m-0.5 shrink-0 rounded-md p-1.5 text-dim transition-colors hover:bg-overlay/[0.08] hover:text-fg"
        >
          <svg aria-hidden="true" viewBox="0 0 12 12" className="h-3 w-3">
            <path
              d="M2 2l8 8M10 2l-8 8"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>
      <p className="mt-1 text-ui text-fg">
        {optimizeRun.entries.length} work orders raised in this scenario run, dispatching{' '}
        {crewIds.size} crews.
      </p>
      <p className="mt-1 text-micro text-muted">
        Live optimizer output — <code className="font-mono">POST /schedule/optimize</code>.
      </p>
    </div>
  );
}
