import { Panel } from '../ui/Panel';
import { useFireExposureQuery } from '../../api/queries';
import { formatRelativeAge } from '../../lib/format';
import type { Tower } from '../../api/types';

interface Props {
    tower: Tower;
}

/**
 * Today, as the archive counts days.
 *
 * `todayIso()` in lib/scheduleDays.ts is deliberately the VIEWER'S local date,
 * because a crew's working week is local. A VIIRS granule is not: the
 * collection carries one image per UTC day, and the backend compares a
 * snapshot's own date against the real UTC date before it will schedule
 * against it. Asking for the local date would request tomorrow's window every
 * night between midnight and 08:00 in Malaysia (UTC+8) — a window the archive
 * cannot have, on a query key nothing else in the app shares.
 */
function utcToday(): string {
    return new Date().toISOString().slice(0, 10);
}

/**
 * What a satellite saw near this site, next to — never inside — its score.
 *
 * Fire is observed evidence. It is not one of the model's twelve features, it
 * is not a factor, it carries no attribution share, and this tower's `risk`,
 * `priority`, `decision` and `attribution` would be identical with the fire
 * layer switched off. That is why the panel sits outside both "Geospatial
 * Environment Signals" and ModelTransparencyPanel rather than as a row inside
 * either: position is the first claim a card makes, and a fire row beside four
 * factor rows would read as a fifth factor before anybody got to the words.
 *
 * Colourless, for the reason EnsembleSignalPanel is. The design system
 * reserves the warm band ramp for tower severity, and a detection count
 * painted on it would say "this site is dangerous" when the reading says "a
 * 375 m pixel within 5 km of it ran hot". `EnvSignalRow` is deliberately NOT
 * reused here, for the sharper version of the same fault: its `share` prop is
 * required and is painted on that ramp, so `share={0}` renders a green "ok 0%"
 * badge — a fabricated claim that the model attributed 0% of this tower's risk
 * to fire, when the model has never heard of fire at all.
 *
 * Four resolved states, none of which may collapse into another: we could not
 * ask; we asked and the window is quiet; we asked and the window is too old to
 * answer with; we asked and something was detected. A count of 0 is never
 * rendered for a tower — an absent id means screened and quiet, and a zero
 * would read as a measurement of no fire rather than as the absence of a
 * report. Renders nothing at all while the query is in flight: an
 * "unavailable" line there would report a fetch in progress as an answer.
 */
export function FireExposurePanel({ tower }: Props) {
    const { data, isPending } = useFireExposureQuery(utcToday());
    if (isPending) return null;

    // `?? null` folds the never-observed error case into the one honest
    // reading of both: we could not ask. The query wrapper resolves a failed
    // fetch to null rather than rejecting, so `undefined` here would mean a
    // rejection that escaped it — which is still "no screening in hand".
    const exposure = data ?? null;
    const record = exposure?.towers[tower.tower_id] ?? null;

    const footnote = exposure
        ? `${exposure.attribution} · ${exposure.screening.window_days}-day window to ${exposure.date}` +
          ` at ${exposure.screening.resolution_m} m, ${exposure.screening.confidence_included.join(' and ')}` +
          ` confidence · snapshot ${exposure.snapshot_id}`
        : 'NOAA-20 VIIRS 375 m thermal anomalies, screened around each tower. Nothing it reports enters the risk score.';

    const bufferKm = exposure ? exposure.screening.buffer_m / 1000 : null;
    const ageHours = exposure?.freshness.source_age_hours ?? null;

    return (
        <Panel title="Fire exposure — observed" footnote={footnote}>
            <div className="space-y-4 text-ui">
                {exposure === null ? (
                    <p className="text-dim">
                        Fire screening is unavailable, so no hotspot evidence can be shown for this
                        site. That is a statement about the screening and not about the ground:
                        nobody asked the satellite, and an absent answer is not an all-clear.
                    </p>
                ) : (
                    <>
                        {exposure.freshness.stale && (
                            <div className="rounded border border-overlay/12 bg-overlay/[0.045] p-3">
                                <div className="eyebrow text-fg/90">Snapshot is stale</div>
                                <p className="mt-1 text-dim">
                                    {ageHours === null
                                        ? 'Nothing was detected anywhere in the screened area, so this snapshot carries no acquisition time and its currency cannot be established.'
                                        : `The newest observation behind it is ${ageHours.toFixed(1)} h old, past the ${exposure.freshness.stale_after_hours} h limit.`}{' '}
                                    An inspection cannot be scheduled against it until fresher data
                                    arrives.
                                </p>
                            </div>
                        )}

                        {record ? (
                            <div>
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="eyebrow">Detection-days within {bufferKm} km</span>
                                    <span className="tnum font-mono text-lead text-fg">
                                        {record.hotspot_pixel_days}
                                    </span>
                                </div>
                                <p className="mt-2 text-dim">
                                    {record.hotspot_pixel_days === 1
                                        ? 'One 375 m pixel-day'
                                        : `${record.hotspot_pixel_days} 375 m pixel-days`}{' '}
                                    inside a {bufferKm} km buffer over{' '}
                                    {exposure.screening.window_days} days, most recent{' '}
                                    {formatRelativeAge(record.latest_acquisition)} at{' '}
                                    <span className="tnum">{record.latest_acquisition}</span> (
                                    {record.max_confidence} confidence). The same burn seen on three
                                    passes counts three — this is a count of satellite pixels, not of
                                    fires and not of damage.
                                </p>
                                <p className="mt-2 text-dim">
                                    A thermal anomaly near the site, not a fire at it: at 375 m a
                                    plantation burn, a gas flare and hot bare ground all read the
                                    same, and none of them says anything about the compound.
                                    Evidence for a planner to review — it is not one of the model's
                                    twelve features and carries no attribution share, so the risk,
                                    band and factor shares above would be identical with the fire
                                    layer switched off.
                                </p>
                            </div>
                        ) : (
                            <p className="text-dim">
                                {exposure.freshness.stale
                                    ? `No detections within ${bufferKm} km were reported in this window, but the window is too old to read as an all-clear.`
                                    : `No fire detections within ${bufferKm} km over the last ${exposure.screening.window_days} days.`}{' '}
                                This site was one of{' '}
                                <span className="tnum">{exposure.screened_towers}</span> screened
                                against the {exposure.date} snapshot. Screened and quiet is a
                                statement about what the satellite reported, not about the state of
                                the compound — and it reaches the score either way, which is to say
                                not at all.
                            </p>
                        )}
                    </>
                )}
            </div>
        </Panel>
    );
}
