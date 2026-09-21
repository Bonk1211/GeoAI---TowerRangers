import { useMemo } from 'react';
import {
    ResponsiveContainer,
    ComposedChart,
    Area,
    Line,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ReferenceLine,
    ReferenceArea
} from 'recharts';
import { Panel } from '../ui/Panel';
import type { SiteParameterRecord, VisitReport } from '../../fixtures/siteHistory';
import { bandColor } from '../../lib/colors';
import { formatRisk, formatInterval, decisionLabel } from '../../lib/format';

interface Props {
    history: SiteParameterRecord[];
    visits: VisitReport[];
}

function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' });
}

export function RiskHistoryChart({ history, visits }: Props) {
    const sorted = useMemo(() => [...history].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()), [history]);

    const minDate = sorted.length ? new Date(sorted[0].date).getTime() : 0;
    const maxDate = sorted.length ? new Date(sorted[sorted.length - 1].date).getTime() : 0;
    const completedVisits = useMemo(() =>
        visits.filter((v) => v.completed_date && new Date(v.completed_date).getTime() >= minDate && new Date(v.completed_date).getTime() <= maxDate),
        [visits, minDate, maxDate]);

    // Prepare data for recharts
    const chartData = useMemo(() => sorted.map(pt => ({
        ...pt,
        risk_range: [pt.risk_lo, pt.risk_hi], // range data for Area uncertainty band
        hasVisit: completedVisits.some(v => v.completed_date === pt.date)
    })), [sorted, completedVisits]);

    if (sorted.length === 0) {
        return <Panel title="Risk Score History"><div className="text-body text-dim">No history available</div></Panel>;
    }

    // Derived statistics
    const first = sorted[0].risk;
    const last = sorted[sorted.length - 1].risk;
    const delta = last - first;
    const trend = delta > 0.05 ? 'RISING' : delta < -0.05 ? 'FALLING' : 'STABLE';
    const trendColor = trend === 'RISING' ? 'var(--color-maintain-ink)' : trend === 'FALLING' ? 'var(--color-ok-ink)' : 'var(--color-dim)';
    const trendGlyph = trend === 'RISING' ? '▲' : trend === 'FALLING' ? '▼' : '—';

    const risks = sorted.map((r) => r.risk);
    const maxRisk = Math.max(...risks);
    const minRisk = Math.min(...risks);
    const avgRisk = risks.reduce((s, v) => s + v, 0) / risks.length;
    const latest = sorted[sorted.length - 1];
    const latestColor = bandColor(latest.decision);

    return (
        <Panel title="Risk Score History">
            {/* KPI Cards Strip */}
            <div className="mb-6 grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="rounded-lg border border-overlay/10 bg-overlay/5 p-3">
                    <div className="text-eyebrow font-semibold uppercase tracking-wider text-dim">Trend</div>
                    <div className="mt-1 flex items-baseline gap-1.5 font-display text-title font-bold" style={{ color: trendColor }}>
                        <span>{trendGlyph}</span>
                        <span>{trend}</span>
                    </div>
                    <div className="mt-1 font-mono text-eyebrow text-dim">
                        All-time Δ {(delta > 0 ? "+" : "") + delta.toFixed(2)}
                    </div>
                </div>

                <div className="rounded-lg border border-overlay/10 bg-overlay/5 p-3">
                    <div className="text-eyebrow font-semibold uppercase tracking-wider text-dim">Peak Risk</div>
                    <div className="mt-1 font-display text-title font-bold text-fg">{maxRisk.toFixed(2)}</div>
                    <div className="mt-1 font-mono text-eyebrow text-dim">Historical high</div>
                </div>

                <div className="rounded-lg border border-overlay/10 bg-overlay/5 p-3">
                    <div className="text-eyebrow font-semibold uppercase tracking-wider text-dim">Low Risk</div>
                    <div className="mt-1 font-display text-title font-bold text-fg">{minRisk.toFixed(2)}</div>
                    <div className="mt-1 font-mono text-eyebrow text-dim">Historical low</div>
                </div>

                <div className="rounded-lg border border-overlay/10 bg-overlay/5 p-3">
                    <div className="text-eyebrow font-semibold uppercase tracking-wider text-dim">Average</div>
                    <div className="mt-1 font-display text-title font-bold text-fg">{avgRisk.toFixed(2)}</div>
                    <div className="mt-1 font-mono text-eyebrow text-dim">Mean score</div>
                </div>
            </div>

            {/* Header info */}
            <div className="mb-4 flex items-center gap-2 px-1">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: latestColor }} />
                <div className="leading-tight">
                    <div className="text-ui font-semibold text-fg">Health Risk Index</div>
                    <div className="font-mono text-eyebrow text-dim">{fmtDate(sorted[0].date)} – {fmtDate(latest.date)}</div>
                </div>
            </div>

            {/* Chart Area */}
            <div className="h-[280px] w-full" style={{ outline: 'none' }}>
                <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={chartData} margin={{ top: 10, right: 10, bottom: 0, left: -20 }}>
                        <defs>
                            <linearGradient id="colorRisk" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={latestColor} stopOpacity={0.4} />
                                <stop offset="95%" stopColor={latestColor} stopOpacity={0.01} />
                            </linearGradient>
                        </defs>

                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--color-overlay)" strokeOpacity={0.15} />

                        <XAxis
                            dataKey="date"
                            tickFormatter={fmtDate}
                            tick={{ fill: 'var(--color-dim)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                            axisLine={false}
                            tickLine={false}
                            dy={10}
                        />

                        <YAxis
                            domain={[0, 1]}
                            ticks={[0, 0.25, 0.5, 0.75, 1]}
                            tick={{ fill: 'var(--color-dim)', fontSize: 10, fontFamily: 'var(--font-mono)' }}
                            axisLine={false}
                            tickLine={false}
                        />

                        {/* Crosshair & Tooltip */}
                        <Tooltip
                            content={<CustomTooltip />}
                            cursor={{ stroke: 'var(--color-fg)', strokeWidth: 1.5, strokeOpacity: 0.15, strokeDasharray: '4 4' }}
                            isAnimationActive={false}
                        />

                        {/* Maintain Threshold Danger Zone */}
                        <ReferenceArea y1={0.7} y2={1.0} fill="var(--color-maintain)" fillOpacity={0.06} />
                        <ReferenceLine
                            y={0.7}
                            stroke="var(--color-maintain)"
                            strokeOpacity={0.75}
                            strokeWidth={1.5}
                            label={{
                                position: 'insideTopLeft',
                                value: 'MAINTAIN THRESHOLD',
                                fill: 'var(--color-maintain)',
                                fontSize: 9,
                                fontFamily: 'var(--font-mono)',
                                offset: 10
                            }}
                        />

                        {/* Area under the line */}
                        <Area
                            type="monotone"
                            dataKey="risk"
                            stroke="none"
                            fill="url(#colorRisk)"
                            isAnimationActive={true}
                        />

                        {/* Main Trend Line */}
                        <Line
                            type="monotone"
                            dataKey="risk"
                            stroke={latestColor}
                            strokeWidth={3}
                            dot={<CustomDot />}
                            activeDot={<CustomActiveDot />}
                            isAnimationActive={true}
                        />
                    </ComposedChart>
                </ResponsiveContainer>
            </div>

            {/* Legend */}
            <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-overlay/5 pt-4 text-micro text-dim">
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: bandColor('maintain') }} /> Maintain</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: bandColor('watch') }} /> Watch</span>
                <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: bandColor('ok') }} /> OK</span>
                <span className="flex items-center gap-1.5">
                    <svg width="10" height="10" viewBox="-5 -5 10 10" aria-hidden="true"><path d="M0 -5 L5 0 L0 5 L-5 0 Z" fill="var(--color-accent)" /></svg>
                    Site visit
                </span>
            </div>
        </Panel>
    );
}

// Custom shape for the point dots based on decision
const CustomDot = (props: any) => {
    const { cx, cy, payload } = props;
    const color = bandColor(payload.decision);

    let baseShape;
    if (payload.decision === 'maintain') {
        baseShape = <circle cx={cx} cy={cy} r={5} fill={color} stroke="var(--color-surface)" strokeWidth={1.5} />;
    } else if (payload.decision === 'watch') {
        baseShape = <rect x={cx - 4.5} y={cy - 4.5} width={9} height={9} fill={color} stroke="var(--color-surface)" strokeWidth={1.5} />;
    } else {
        baseShape = <circle cx={cx} cy={cy} r={4} fill={color} stroke="var(--color-surface)" strokeWidth={1.5} />;
    }

    if (payload.hasVisit) {
        return (
            <g>
                {baseShape}
                <VisitShape cx={cx} cy={cy} />
            </g>
        );
    }
    return baseShape;
};

const CustomActiveDot = (props: any) => {
    const { cx, cy, payload } = props;
    const color = bandColor(payload.decision);

    let baseShape;
    if (payload.decision === 'maintain') {
        baseShape = <circle cx={cx} cy={cy} r={7} fill={color} stroke="var(--color-surface)" strokeWidth={2} />;
    } else if (payload.decision === 'watch') {
        baseShape = <rect x={cx - 6} y={cy - 6} width={12} height={12} fill={color} stroke="var(--color-surface)" strokeWidth={2} />;
    } else {
        baseShape = <circle cx={cx} cy={cy} r={6} fill={color} stroke="var(--color-surface)" strokeWidth={2} />;
    }

    if (payload.hasVisit) {
        return (
            <g>
                {baseShape}
                <path d={`M${cx} ${cy - 9} L${cx + 9} ${cy} L${cx} ${cy + 9} L${cx - 9} ${cy} Z`} fill="var(--color-accent)" stroke="var(--color-surface)" strokeWidth={2.5} />
            </g>
        );
    }
    return baseShape;
};

// Custom shape for the Visit markers now intersecting the trendline
const VisitShape = (props: any) => {
    const { cx, cy } = props;
    if (cx === undefined || cy === undefined) return null;
    return (
        <path
            d={`M${cx} ${cy - 7} L${cx + 7} ${cy} L${cx} ${cy + 7} L${cx - 7} ${cy} Z`}
            fill="var(--color-accent)"
            stroke="var(--color-surface)"
            strokeWidth={2}
            className="cursor-pointer"
        />
    );
};

const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
        const dataItem = payload.find((p: any) => p.dataKey === 'risk');
        if (!dataItem) return null;
        const data = dataItem.payload as SiteParameterRecord;

        return (
            <div className="glass-raised overflow-hidden pointer-events-none z-30 min-w-[160px] rounded-lg border border-overlay/10 shadow-[var(--shadow-3)]">
                <div className="border-b border-overlay/10 px-3 py-2 font-mono text-eyebrow font-semibold uppercase tracking-wider text-dim bg-overlay/5">
                    {fmtDate(data.date)}
                </div>
                <div className="px-3 py-2.5 bg-black/10 backdrop-blur-md">
                    <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: bandColor(data.decision) }} />
                        <span className="font-display text-lead font-bold tnum leading-none" style={{ color: bandColor(data.decision) }}>
                            {formatRisk(data.risk)}
                        </span>
                        <span className="text-eyebrow font-semibold uppercase tracking-wider text-dim">
                            {decisionLabel(data.decision)}
                        </span>
                    </div>
                    <div className="mt-2 font-mono text-eyebrow text-dim">
                        <span className="opacity-60">BAND:</span> {formatInterval(data.risk_lo, data.risk_hi)}
                    </div>
                </div>
            </div>
        );
    }
    return null;
}
