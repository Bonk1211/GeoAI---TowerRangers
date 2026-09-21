import { Panel } from '../ui/Panel';
import type { Tower } from '../../api/types';
import { bandColor } from '../../lib/colors';
import { formatRisk } from '../../lib/format';

interface Props {
    tower: Tower;
}

/**
 * Rank, not identity.
 *
 * This panel used to give each factor its own hue (#3b82f6 / #f59e0b /
 * #10b981 / #8b5cf6) — four colours, none of them in the theme, two of them
 * close enough to the watch and ok bands to read as severity. The console
 * renders this same `tower.attribution` object in AttributionBars, where the
 * leading driver carries the accent and the rest recede. Matching that keeps
 * one meaning per colour inside tower analysis: cool is chrome, the warm
 * tower triad is severity. Numerically keyed map rasters are separate.
 */
function rankColor(rank: number): string {
    if (rank === 0) return 'var(--color-accent)';
    return `rgba(13,21,38,${[0.34, 0.24, 0.17][rank - 1] ?? 0.12})`;
}

export function ModelTransparencyPanel({ tower }: Props) {
    const isScored = tower.dominant_factor !== 'unscored';
    if (!isScored) return null;

    const band = bandColor(tower.decision);
    const att = tower.attribution;
    const factors = Object.keys(att).sort((a, b) => att[b] - att[a]);

    return (
        <Panel title="Model Transparency" footnote="Noisy-OR combination of probabilistic risk factors">
            <div className="space-y-4 text-ui">
                <div>
                    <div className="text-dim mb-2 text-eyebrow uppercase tracking-wider font-semibold">AHP Factor Weights</div>
                    <div className="h-4 w-full flex rounded overflow-hidden">
                        {factors.map((f, i) => (
                            <div
                                key={f}
                                style={{ width: `${(att[f] * 100).toFixed(1)}%`, backgroundColor: rankColor(i) }}
                                title={`${f}: ${att[f]}`}
                            />
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-3 text-eyebrow text-dim mt-2">
                        {factors.map((f, i) => (
                            <div key={f} className="flex items-center gap-1">
                                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: rankColor(i) }} />
                                <span className="capitalize">{f} ({(att[f] * 100).toFixed(0)}%)</span>
                            </div>
                        ))}
                    </div>
                </div>

                <div className="bg-overlay/[0.045] p-3 rounded border border-overlay/10 font-mono text-micro text-sub">
                    Risk = 1 - Π(1 - pᵢ·wᵢ)
                </div>

                <div>
                    <div className="text-dim mb-3 text-eyebrow uppercase tracking-wider font-semibold">Prediction Uncertainty</div>
                    <div className="relative h-6 flex items-center">
                        {/* Base line 0-1 */}
                        <div className="absolute w-full h-px bg-overlay/12" />

                        {/* Uncertainty band [risk_lo, risk_hi] */}
                        <div
                            className="absolute h-1 rounded-full z-10"
                            style={{
                                left: `${tower.risk_lo * 100}%`,
                                width: `${(tower.risk_hi - tower.risk_lo) * 100}%`,
                                backgroundColor: `${band}44`,
                                borderLeft: `1px solid ${band}88`,
                                borderRight: `1px solid ${band}88`
                            }}
                        />

                        {/* Point estimate */}
                        <div
                            className="absolute w-2 h-2 rounded-full shadow-lg z-20"
                            style={{
                                left: `max(0%, min(100%, calc(${tower.risk * 100}% - 4px)))`,
                                backgroundColor: band
                            }}
                        />
                    </div>
                    <div className="flex justify-between text-eyebrow mt-2 text-dim font-sans">
                        <span>0.0</span>
                        <span className="font-mono">{formatRisk(tower.risk_lo)} — {formatRisk(tower.risk_hi)}</span>
                        <span>1.0</span>
                    </div>
                </div>
            </div>
        </Panel>
    );
}
