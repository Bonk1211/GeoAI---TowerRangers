import { Panel } from '../ui/Panel';
import type { Tower } from '../../api/types';

interface Props {
    tower: Tower;
}

/**
 * Layers 2 and 3 — what the supervised model did not see.
 *
 * One of these moves the ordering and the rest do not. `condition` — a
 * one-sided read of the 30-day telemetry block — is blended into the priority
 * the bands are cut on, and earns it: measured inside that band it ranks the
 * label above the model, and at a matched dispatch budget the blend beats
 * LightGBM alone in 5 of 5 held-out seeds where a threshold gate lost. `novelty` cannot, and used to: an isolation forest scores
 * |deviation| while maintenance need is monotone, so it lost a matched-budget
 * comparison against simply lowering the cut. Both are shown; only one is
 * allowed to act.
 *
 * Deliberately colourless. `novelty` is a warm-data quantity, and the design
 * system reserves the warm band ramp for tower severity: painting a novelty
 * rank on it would say "this site is dangerous" when the reading says "this
 * site is unusual". The number carries its own scale, so it needs no hue at
 * all, and the flag rows are chrome.
 *
 * Renders nothing when there is nothing to say. An empty panel headed
 * "Environment novelty" reads as a measurement of zero.
 */
export function EnsembleSignalPanel({ tower }: Props) {
    const hasNovelty = tower.novelty !== null;
    const hasCondition = tower.condition !== null;
    if (!hasNovelty && !hasCondition && tower.flags.length === 0) return null;

    const pct = hasNovelty ? Math.round(tower.novelty! * 100) : null;
    const condPct = hasCondition ? Math.round(tower.condition! * 100) : null;

    return (
        <Panel
            title="Second Opinion"
            footnote="Isolation forest over site environment, plus deterministic context rules"
        >
            <div className="space-y-4 text-xs">
                {tower.escalated && (
                    <div className="rounded border border-overlay/12 bg-overlay/[0.045] p-3">
                        <div className="text-[10px] font-semibold uppercase tracking-wider text-fg/90">
                            Escalated to maintain
                        </div>
                        <p className="mt-1 text-dim">
                            The model scored this site below the dispatch cut, but its live
                            counters are running hot, so the blended ordering moved it up a
                            band. Its risk figure and its band disagree on purpose — the model
                            has no telemetry history to learn from.
                        </p>
                    </div>
                )}

                {condPct !== null && (
                    <div>
                        <div className="mb-2 flex items-baseline justify-between">
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                                Current condition
                            </span>
                            <span className="tnum font-mono text-sm text-fg">{condPct}%</span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-overlay/10">
                            <div className="h-full rounded-full bg-overlay/40" style={{ width: `${condPct}%` }} />
                        </div>
                        <p className="mt-2 text-dim">
                            Noisier than {condPct}% of sites over the last 30 days — rectifier
                            alarms, battery sag, door-open hours. The risk model cannot read
                            these: the counters are 30 days old and its training window is 36
                            months.
                        </p>
                    </div>
                )}

                <div>
                    <div className="mb-2 flex items-baseline justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">
                            Environment novelty
                        </span>
                        <span className="tnum font-mono text-sm text-fg">
                            {/* Null, not 0.00. 0.00 would claim "measured, perfectly typical". */}
                            {pct === null ? '—' : `${pct}%`}
                        </span>
                    </div>
                    {pct === null ? (
                        <p className="text-dim">
                            Not measured — this site is missing one or more model features, and
                            imputing them would invent an observation.
                        </p>
                    ) : (
                        <>
                            <div className="h-1 w-full overflow-hidden rounded-full bg-overlay/10">
                                <div
                                    className="h-full rounded-full bg-overlay/40"
                                    style={{ width: `${pct}%` }}
                                />
                            </div>
                            <p className="mt-2 text-dim">
                                More unusual than {pct}% of towers in this view. A statement about
                                how far the site sits from what the model was fitted on — not a
                                risk score, and not a probability that anything is wrong.
                            </p>
                        </>
                    )}
                </div>

                {tower.flags.length > 0 && (
                    <div>
                        <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-dim">
                            Context flags
                        </div>
                        <ul className="space-y-2">
                            {/* Keyed on `id`, never `label` — a label is copy. */}
                            {tower.flags.map((flag) => (
                                <li key={flag.id} className="flex gap-2">
                                    <span className="mt-px text-dim" aria-hidden="true">
                                        &#9873;
                                    </span>
                                    <div>
                                        <span className="font-semibold text-fg/90">{flag.label}</span>
                                        <span className="ml-2 text-dim">{flag.detail}</span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </Panel>
    );
}
