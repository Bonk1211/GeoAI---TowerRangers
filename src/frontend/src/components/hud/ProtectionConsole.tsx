import { useEffect, useMemo, useRef, useState } from 'react';
import { useWeights } from '../../state/useWeights';
import { useMitigations } from '../../state/useMitigations';
import { useLiveTower } from '../../api/useLiveTowers';
import { placeName } from '../../fixtures/schedule';
import {
  BEAT_INTERVAL_MS,
  MAP_COMMIT_DELAY_MS,
  protectionBeats,
  type ProtectionEvidence,
} from '../../lib/protectionConsole';
import { mitigationById, protectionDelta } from '../../lib/protection';

/**
 * The transcript that runs between choosing a protection and the map changing.
 *
 * WHY THIS EXISTS AT ALL. A tower that simply recolours when you click shows a
 * RESULT and hides the MECHANISM — and here the mechanism is the entire
 * argument, because the claim being made is not "the number went down", it is
 * "an input changed and the model was re-run over it". The transcript makes
 * that sequence visible, and the map is held at its previous colours until the
 * last line lands, so the causal order reads correctly rather than the result
 * arriving first and the explanation chasing it. The store keeps `running`
 * disjoint from `applied` for exactly that reason: nothing is committed until
 * the transcript ends, so a tower is never half-protected.
 *
 * EVERY LINE CARRIES A WORD, NOT ONLY A HUE — the same rule
 * `SimulationConsole` keeps, for the same reason: a colour-blind reader, a
 * projector with the contrast wound down, and a photograph of a screen all
 * lose hue and none of them lose text. The beats describing field activity
 * read ILLUSTRATIVE because no crew was dispatched, and that badge is the only
 * thing standing between this demo and a false claim.
 *
 * REDUCED MOTION. The reveal is a timer rather than a CSS animation, so
 * `prefers-reduced-motion` is honoured by showing the whole transcript at once
 * and committing after the same short delay. A user who asked for less motion
 * still gets every line and every badge — nothing is skipped, only the
 * staggering is.
 */
const EVIDENCE_LABEL: Record<ProtectionEvidence, string> = {
  mechanism: 'MECHANISM',
  illustrative: 'ILLUSTRATIVE',
};

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function ProtectionConsole() {
  const running = useMitigations((s) => s.running);
  const commit = useMitigations((s) => s.commit);
  const cancel = useMitigations((s) => s.cancel);
  const weights = useWeights((s) => s.weights);
  const tower = useLiveTower(running?.towerId ?? null, weights);

  const [revealed, setRevealed] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const beats = useMemo(() => {
    if (!tower || !running) return [];
    const mitigation = mitigationById(running.mitigationId);
    if (!mitigation) return [];
    const delta = protectionDelta(tower, mitigation, weights);
    // A plausible crew id in the roster's shape. Illustrative, like every
    // other field-activity figure here — the real optimizer picks crews by
    // insertion cost, and nothing in this transcript consults it.
    const crewId = `${(tower.territory ?? 'MY').slice(0, 3).toUpperCase()}-${mitigation.crewType
      .slice(0, 1)
      .toUpperCase()}1`;
    return protectionBeats(placeName(tower.tower_id), mitigation, delta, crewId);
  }, [tower, running, weights]);

  // Drive the reveal, then commit. One timer chain, torn down on unmount and
  // on any change of run — a leaked timer would commit after the console had
  // closed, or on top of a run the operator had already replaced.
  useEffect(() => {
    if (!running || beats.length === 0) return;
    setRevealed(0);

    const { towerId, mitigationId } = running;
    const timers: number[] = [];

    if (prefersReducedMotion()) {
      setRevealed(beats.length);
      timers.push(
        window.setTimeout(() => commit(towerId, mitigationId), MAP_COMMIT_DELAY_MS),
      );
    } else {
      for (let i = 0; i < beats.length; i += 1) {
        timers.push(window.setTimeout(() => setRevealed(i + 1), BEAT_INTERVAL_MS * (i + 1)));
      }
      timers.push(
        window.setTimeout(
          // `commit` also clears `running`, which unmounts this console and
          // releases the map — the commit and the close are one action, so the
          // two can never disagree about whether the run finished.
          () => commit(towerId, mitigationId),
          BEAT_INTERVAL_MS * beats.length + MAP_COMMIT_DELAY_MS,
        ),
      );
    }

    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [running, beats, commit]);

  // Keep the newest line in view without moving the page behind the dialog.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revealed]);

  if (!running || !tower || beats.length === 0) return null;

  const visible = beats.slice(0, revealed);

  return (
    <div
      className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-ink-950/45 px-5"
      role="dialog"
      aria-modal="true"
      aria-label="Modelling site protection"
    >
      <div className="glass-float w-full max-w-[520px] overflow-hidden rounded-[14px]">
        <header className="flex items-center justify-between gap-3 border-b border-overlay/[0.09] px-4 py-3">
          <div className="min-w-0">
            <h2 className="eyebrow text-accent">Modelling protection</h2>
            <p className="mt-0.5 truncate text-ui font-medium text-fg">
              {placeName(tower.tower_id)}
            </p>
          </div>
          <span aria-hidden="true" className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />
        </header>

        <div ref={scrollRef} className="scroll-thin max-h-[52vh] overflow-y-auto px-4 py-3">
          <ol className="space-y-2.5">
            {visible.map((beat) => (
              <li key={beat.id} className="flex gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent/70"
                />
                <div className="min-w-0 flex-1">
                  <p className="text-body font-medium leading-snug text-fg">{beat.headline}</p>
                  <p className="mt-0.5 font-mono text-micro leading-snug tnum text-muted">
                    {beat.detail}
                  </p>
                  <span
                    className={`mt-1 inline-block rounded border px-1.5 py-px text-eyebrow font-semibold uppercase tracking-wider ${
                      beat.evidence === 'mechanism'
                        ? 'border-accent/35 bg-accent/[0.08] text-accent'
                        : 'border-watch/40 bg-watch/[0.12] text-watch-ink'
                    }`}
                  >
                    {EVIDENCE_LABEL[beat.evidence]}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-overlay/[0.09] px-4 py-2.5">
          <p className="text-micro leading-snug text-dim">
            No crew dispatched. No schedule changed.
          </p>
          <button
            type="button"
            onClick={cancel}
            className="shrink-0 rounded-md border border-overlay/[0.12] px-2.5 py-1 text-micro font-medium text-muted transition-colors hover:text-fg"
          >
            Skip
          </button>
        </footer>
      </div>
    </div>
  );
}
