import { Panel } from '../ui/Panel';
import { bandColor, bandInk } from '../../lib/colors';
import type { Decision } from '../../api/types';

interface Props {
    urgencyDays: number;
    decision: Decision;
    /** ISO date the crew is (or would be) dispatched — the assigned schedule
     * slot if one exists, otherwise the illustrative work-order plan start. */
    scheduledDate?: string;
}

const MS_PER_DAY = 86_400_000;

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * MS_PER_DAY);
}

function fmt(date: Date): string {
    return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Same rule the scheduler's monsoon window uses: 1 Nov, rolling to next year
// once it's passed. Duplicated locally rather than imported — this is a
// three-line date calc, not a shared contract (components/tower/TimelineStrip
// keeps its own copy for the same reason).
function nextMonsoonStart(from: Date): Date {
    const candidate = new Date(from.getFullYear(), 10, 1); // Nov 1
    return candidate >= from ? candidate : new Date(from.getFullYear() + 1, 10, 1);
}

export function CountdownTimeline({ urgencyDays, decision, scheduledDate }: Props) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const monsoon = nextMonsoonStart(today);
    const visit = scheduledDate ? new Date(scheduledDate) : addDays(today, Math.max(0, urgencyDays));
    const span = monsoon.getTime() - today.getTime() || 1;
    const pct = (d: Date) => Math.min(100, Math.max(0, ((d.getTime() - today.getTime()) / span) * 100));
    const visitPct = pct(visit);
    const visitBeyondMonsoon = visit.getTime() > monsoon.getTime();

    const daysToMonsoon = Math.round((monsoon.getTime() - today.getTime()) / MS_PER_DAY);
    const showMonsoonChip = daysToMonsoon <= 60;

    const isOverdue = urgencyDays < 0;
    const isAtRisk = urgencyDays >= 0 && urgencyDays <= 7;
    const label = isOverdue ? 'Overdue' : isAtRisk ? 'At risk' : 'Within policy';
    const ink = bandInk(decision);
    const band = bandColor(decision);

    // Fortnightly ticks between today and the monsoon window give the track a
    // real scale to read, instead of two dots on a bare line.
    const ticks: Date[] = [];
    for (let d = addDays(today, 14); d < monsoon; d = addDays(d, 14)) ticks.push(d);

    return (
        <Panel title="Scheduling Countdown">
            <div className="flex flex-col gap-6 md:flex-row md:items-center">
                <div className="min-w-0 flex-1">
                    <div className="relative mx-1" style={{ height: '2.75rem' }}>
                        {/* Track */}
                        <div className="absolute top-1/2 h-1.5 w-full -translate-y-1/2 rounded-full bg-overlay/10" />

                        {/* Fortnight ticks */}
                        {ticks.map((t) => (
                            <div key={t.toISOString()} className="absolute top-1/2 -translate-y-1/2" style={{ left: `${pct(t)}%` }}>
                                <div className="h-2.5 w-px -translate-x-1/2 bg-overlay/20" />
                                <div className="mt-2 -translate-x-1/2 whitespace-nowrap font-mono text-[9px] text-dim">{fmt(t)}</div>
                            </div>
                        ))}

                        {/* Today */}
                        <div className="absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
                            <div className="h-3 w-3 rounded-full border-2 border-ink-900 bg-dim shadow-[var(--shadow-1)]" />
                        </div>
                        {/* Below the track, not above — "Site Visit" already claims that
                            space at the same x when a tower's visit falls on or near today,
                            which is the common case for anything still in the backlog. */}
                        <div className="absolute left-0 top-5 text-[10px] font-semibold uppercase tracking-wide text-dim">Today</div>

                        {/* Site visit marker */}
                        <div className="absolute top-1/2 z-20 -translate-y-1/2" style={{ left: `${visitPct}%`, transform: 'translate(-50%, -50%)' }}>
                            <div
                                className="h-3.5 w-3.5 rounded-full border-2 border-ink-900 shadow-[var(--shadow-1)]"
                                style={{ backgroundColor: band }}
                            />
                        </div>
                        <div
                            className="absolute -top-5 whitespace-nowrap rounded-sm px-1 text-[10px] font-bold"
                            style={{ left: `${visitPct}%`, transform: 'translateX(-50%)', color: ink, backgroundColor: 'var(--color-ink-900)' }}
                        >
                            Site Visit · {fmt(visit)}
                        </div>

                        {/* Monsoon window */}
                        <div className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2">
                            <div className="h-3 w-3 rounded-full border-2 border-ink-900 bg-watch shadow-[var(--shadow-1)]" />
                        </div>
                        <div className="absolute right-0 -top-5 translate-x-1/2 whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-watch-ink">
                            Monsoon Window
                        </div>
                    </div>

                    <div className="mt-1 flex items-center justify-between gap-3">
                        {showMonsoonChip && (
                            <div className="inline-block rounded border border-watch/20 bg-watch/10 px-2 py-0.5 text-[10px] font-medium text-watch-ink">
                                Approaching {fmt(monsoon)} monsoon season · {daysToMonsoon}d out
                            </div>
                        )}
                        {visitBeyondMonsoon && (
                            <div className="inline-block rounded border border-maintain/30 bg-maintain/10 px-2 py-0.5 text-[10px] font-medium text-maintain-ink">
                                Visit falls after the monsoon window
                            </div>
                        )}
                    </div>
                </div>

                {/* Merge: main's responsive stacking (the panel wrapped badly
                    below md) with this branch's named type scale. main's side
                    reintroduced text-[10px]/text-4xl/text-xl/text-xs, which the
                    type-scale refactor exists to remove. Colour comes from
                    `ink` — the branch's `colorClass` no longer exists here. */}
                <div className="shrink-0 border-t border-overlay/10 pt-4 text-right md:border-l md:border-t-0 md:pl-6 md:pt-0">
                    <div className="text-eyebrow font-semibold uppercase tracking-wider text-dim">Time Remaining</div>
                    <div className="font-display text-display font-extrabold tnum" style={{ color: ink }}>
                        {Math.max(0, urgencyDays)}<span className="text-title">d</span>
                    </div>
                    <div className="text-ui font-semibold uppercase" style={{ color: ink }}>{label}</div>
                </div>
            </div>
        </Panel>
    );
}
