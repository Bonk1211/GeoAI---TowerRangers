import { Panel } from '../ui/Panel';
import type { VisitReport } from '../../fixtures/siteHistory';

interface Props {
    reports: VisitReport[];
}

export function VisitReportList({ reports }: Props) {
    return (
        <Panel title="Visit Reports">
            <div className="flex gap-2 mb-4">
                {['All', 'Completed', 'Pending'].map((tab, i) => (
                    <button key={tab} className={`px-3 py-1 rounded text-eyebrow font-semibold uppercase tracking-wider ${i === 0 ? 'bg-overlay/10 text-fg' : 'bg-transparent text-dim hover:bg-overlay/5'}`}>
                        {tab}
                    </button>
                ))}
            </div>

            <div className="relative border-l border-overlay/10 ml-3 space-y-6 pb-4">
                {reports.map((report) => {
                    const isPending = report.status === 'pending';
                    const isCompleted = report.status === 'completed';

                    return (
                        <div key={report.id} className="relative pl-6">
                            {/* Timeline dot */}
                            <div
                                className={`absolute left-0 -translate-x-1/2 w-2.5 h-2.5 rounded-full border-2 border-ink-950 ${isPending ? 'bg-watch' : isCompleted ? 'bg-ok' : 'bg-dim'
                                    }`}
                            />

                            <div className="flex flex-wrap items-start justify-between gap-4">
                                <div>
                                    <div className="flex items-center gap-2 mb-1">
                                        <span className="font-mono text-fg font-bold text-ui">{report.id}</span>
                                        <span className={`text-eyebrow uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${isPending ? 'bg-watch/10 text-watch-ink' : 'bg-ok/10 text-ok-ink'
                                            }`}>
                                            {report.status}
                                        </span>
                                        <span className="text-ui text-dim">
                                            {isPending ? `Scheduled: ${report.scheduled_date}` : report.completed_date}
                                        </span>
                                    </div>

                                    <div className="text-body text-fg/90 font-medium mb-1">{report.action}</div>
                                    <div className="text-ui text-dim mb-2 max-w-2xl">{report.description}</div>

                                    <div className="flex flex-wrap items-center gap-4 text-ui font-mono">
                                        <div className="text-muted">Crew: <span className="text-fg/80">{report.crew_id}</span></div>

                                        {report.risk_before !== undefined && report.risk_after !== undefined && (
                                            <div className="text-muted">
                                                Risk: <span className="text-maintain-ink">{report.risk_before}</span> → <span className="text-ok-ink">{report.risk_after}</span>
                                                <span className="text-ok-ink ml-1">
                                                    (↓-{Math.round((report.risk_before - report.risk_after) * 100)}%)
                                                </span>
                                            </div>
                                        )}
                                    </div>
                                </div>

                                <div>
                                    {isPending ? (
                                        <button className="text-eyebrow text-watch-ink hover:text-fg uppercase tracking-widest font-semibold">Work Order →</button>
                                    ) : (
                                        <button className="text-eyebrow text-ok-ink hover:text-fg uppercase tracking-widest font-semibold flex items-center gap-1">
                                            View Report <span className="text-eyebrow">↗</span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>

            <button className="w-full mt-4 py-2 border border-dashed border-overlay/10 rounded text-ui text-dim hover:text-fg hover:bg-overlay/[0.02] transition-colors font-medium">
                + Log New Visit Report
            </button>
        </Panel>
    );
}
