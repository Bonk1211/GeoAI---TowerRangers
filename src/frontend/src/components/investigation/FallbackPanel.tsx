import { Link } from 'react-router-dom';
import { Panel } from '../ui/Panel';
import { useTowerFallbackQuery } from '../../api/queries';
import type { Tower } from '../../api/types';

interface Props {
    tower: Tower;
}

/**
 * If this tower fails, who could stand in — next to, never inside, its score.
 *
 * Cover candidacy is not one of the model's features, carries no attribution
 * share, and this tower's `risk`, `priority`, `decision` and `attribution`
 * would be identical with this panel switched off. That is why it sits outside
 * ModelTransparencyPanel rather than as a row inside it: position is the first
 * claim a card makes, and a cover row among factor rows would read as another
 * factor before anybody reached the words saying it is not. Same reasoning as
 * FireExposurePanel, which this is modelled on.
 *
 * GEOMETRY, NOT RF. Distance and initial bearing between known coordinates.
 * This product holds no azimuth, antenna height, EIRP, band or sector data —
 * `radio` is UNKNOWN for 1,119 of 1,164 towers — so a bearing here is a
 * direction to a place and never an antenna instruction. The footnote says so
 * on every state, because the number and its caveat must never be separable.
 *
 * Colourless, for the reason EnsembleSignalPanel and FireExposurePanel are:
 * lib/colors.ts owns the severity ramp and a reading painted on it claims a
 * severity it does not have. The one exception is the two isolated states,
 * which may use `alert` — those genuinely ARE a severity statement, about
 * consequence rather than condition.
 *
 * Four resolved states, none of which may collapse into another: not at risk;
 * alone; surrounded but every neighbour floods too; covered. Renders nothing
 * at all while the query is in flight — an "unavailable" line there would
 * report a fetch in progress as an answer.
 */
export function FallbackPanel({ tower }: Props) {
    const { data, isPending } = useTowerFallbackQuery();
    if (isPending) return null;

    const record = data?.towers[tower.tower_id] ?? null;
    // State 1: absent from the report means NOT AT RISK, which is not a finding
    // about cover and must not be rendered as one.
    if (!record) return null;

    const radiusKm = data?.parameters.search_radius_km ?? 15;
    const footnote =
        `Geometry only — distance and direction between towers within ${radiusKm} km. ` +
        'No antenna data. Candidates for RF planning to confirm.';

    const isolated = record.candidates.length === 0;

    return (
        <Panel
            title="If it fails"
            footnote={footnote}
            hint={
                'Which nearby towers could plausibly be asked to help cover this area if this ' +
                'site goes down, worked out before any event. Great-circle geometry over tower ' +
                'coordinates — not a propagation, capacity or antenna-tilt calculation, none of ' +
                'which this dataset supports. Neighbours that are themselves flood-exposed are ' +
                'listed separately, because they cannot be counted on in the same event.'
            }
        >
            {isolated ? (
                <div className="space-y-2">
                    <p className="text-body font-semibold text-alert-ink">
                        Nobody covers this.
                    </p>
                    {record.co_hazard.length > 0 ? (
                        // State 3: the sharper finding. Neighbours exist, and every
                        // one of them is expected under the same water.
                        <p className="text-ui text-muted">
                            {record.co_hazard.length}{' '}
                            {record.co_hazard.length === 1 ? 'tower' : 'towers'} within{' '}
                            {radiusKm} km — all of them flood in the same event.
                        </p>
                    ) : (
                        // State 2: physically alone.
                        <p className="text-ui text-muted">
                            No other tower within {radiusKm} km.
                            {record.nearest_km !== null && (
                                <> Nearest is <span className="tnum text-fg">{record.nearest_km} km</span> away.</>
                            )}
                        </p>
                    )}
                    {/*
                      The reactive view as PROOF of this predictive finding, not a
                      feature of its own — the simulation is where a viewer can watch
                      one of these sites actually fall.
                    */}
                    <Link
                        to="/simulation"
                        className="inline-block rounded text-micro font-medium text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                    >
                        See what an outage here looks like &rarr;
                    </Link>
                </div>
            ) : (
                // State 4: covered.
                <div className="space-y-2">
                    <ul className="space-y-1">
                        {record.candidates.map((c) => (
                            <li
                                key={c.tower_id}
                                className="flex items-baseline justify-between gap-3 text-ui"
                            >
                                <span className="truncate font-mono text-fg">{c.tower_id}</span>
                                <span className="shrink-0 tnum text-muted">
                                    {c.distance_km} km · {Math.round(c.bearing_deg)}°
                                </span>
                            </li>
                        ))}
                    </ul>
                    {record.co_hazard.length > 0 && (
                        <p className="border-t border-overlay/10 pt-2 text-micro text-dim">
                            {record.co_hazard.length} further{' '}
                            {record.co_hazard.length === 1 ? 'tower' : 'towers'} nearby, but
                            flood-exposed in the same event — not counted above.
                        </p>
                    )}
                </div>
            )}
        </Panel>
    );
}
