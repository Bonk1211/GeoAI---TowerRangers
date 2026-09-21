import { Panel } from '../ui/Panel';
import type { SiteParameterRecord } from '../../fixtures/siteHistory';
import { bandColor, bandInk } from '../../lib/colors';
import { decisionLabel } from '../../lib/format';

interface Props {
    records: SiteParameterRecord[];
}

export function SiteParamTable({ records }: Props) {
    // Use chronological order, most recent first
    const sorted = [...records].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return (
        <Panel title="Site Parameter Log">
            <div className="flex gap-2 mb-3">
                {['All', 'Last 12 months', 'Last 3 years'].map((tab, i) => (
                    <button key={tab} className={`px-3 py-1 rounded text-eyebrow font-semibold uppercase tracking-wider ${i === 0 ? 'bg-overlay/10 text-fg' : 'bg-transparent text-dim hover:bg-overlay/5'}`}>
                        {tab}
                    </button>
                ))}
            </div>

            <div className="overflow-x-auto">
                <table className="w-full text-left text-ui whitespace-nowrap">
                    <thead>
                        <tr className="text-dim border-b border-overlay/10">
                            <th className="pb-2 pr-4 font-medium">Date</th>
                            <th className="pb-2 pr-4 font-medium text-right">Risk Score</th>
                            <th className="pb-2 pr-4 font-medium text-right">HAND</th>
                            <th className="pb-2 pr-4 font-medium text-right">Dist. Water</th>
                            <th className="pb-2 pr-4 font-medium text-right">Slope</th>
                            <th className="pb-2 pr-4 font-medium text-right">TRI</th>
                            <th className="pb-2 pr-4 font-medium text-right">Density</th>
                            <th className="pb-2 pr-4 font-medium text-right">Dist. Power</th>
                            <th className="pb-2 pr-4 font-medium">Radio</th>
                            <th className="pb-2 font-medium">Decision</th>
                        </tr>
                    </thead>
                    <tbody>
                        {sorted.map((r, idx) => {
                            const bColor = bandColor(r.decision);
                            const bInk = bandInk(r.decision);
                            return (
                                <tr key={idx} className={`border-b border-overlay/5 last:border-0 ${idx === 0 ? 'bg-overlay/[0.02]' : ''} hover:bg-overlay/[0.04]`}>
                                    <td className="py-2.5 pr-4 font-mono text-dim">{r.date}</td>
                                    <td className="py-2.5 pr-4 text-right">
                                        <div className="flex items-center justify-end gap-1.5">
                                            <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: bColor }} />
                                            <span className="font-bold font-mono tnum" style={{ color: bInk }}>{r.risk.toFixed(2)}</span>
                                        </div>
                                    </td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.hand_m.toFixed(1)}m</td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.dist_water_m}m</td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.slope_deg}°</td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.tri.toFixed(1)}</td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.flash_density.toFixed(1)}</td>
                                    <td className="py-2.5 pr-4 text-right font-mono text-fg/80">{r.dist_power_m}m</td>
                                    <td className="py-2.5 pr-4 font-mono text-fg/80">{r.radio}</td>
                                    <td className="py-2.5">
                                        <span className="rounded px-1.5 py-0.5 text-eyebrow uppercase tracking-wider font-bold" style={{ backgroundColor: `${bColor}1f`, color: bInk, border: `1px solid ${bColor}55` }}>
                                            {decisionLabel(r.decision)}
                                        </span>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </Panel>
    );
}
