import React, { useState, useMemo, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { isScored } from '../fixtures/towers';
import { CREWS } from '../fixtures/crews';
import { useWeights } from '../state/useWeights';
import { useSelection } from '../state/useSelection';
import { useScheduleSelection } from '../state/useScheduleSelection';
import { useScheduleStore } from '../state/useScheduleStore';
import { useCrewsQuery, useTowerFallbackQuery } from '../api/queries';
import { useLiveTowers } from '../api/useLiveTowers';
import { placeName } from '../fixtures/schedule';
import { buildWorkBreakdown } from '../lib/workBreakdown';
import { GanttChart } from '../components/tower/GanttChart';
import {
    EnvSignalRow,
    ModelTransparencyPanel,
    EnsembleSignalPanel,
    FireExposurePanel,
    FallbackPanel,
    CrewProfileCard,
    CountdownTimeline,
    RiskHistoryChart,
    SiteParamTable,
    VisitReportList
} from '../components/investigation';
import { getHistory, getVisitReports } from '../fixtures/siteHistory';
import { FloodIcon, TerrainIcon, PowerIcon, EquipmentIcon, SearchIcon } from '../components/shell/icons';
import { PageHeader, Panel, Button } from '../components/ui/Panel';
import { formatRisk, formatUrgency, decisionLabel } from '../lib/format';
import { bandColor, bandInk } from '../lib/colors';
import { dispatchDayFor, NO_DISPATCH_DAY_REASON } from '../lib/dispatchTarget';
import type { Tower } from '../api/types';

type FilterTab = 'ALL' | 'MAINTAIN' | 'WATCH' | 'OK' | 'UNSCHEDULED' | 'ISOLATED';
type SortOption = 'RISK_DESC' | 'URGENCY_ASC' | 'RISK_ASC' | 'ID_ASC' | 'EXPOSURE_DESC';

// 'ISOLATED' is the enum key; "NO COVER" is what it means to a planner.
const FILTER_LABELS: Record<FilterTab, string> = {
    ALL: 'ALL', MAINTAIN: 'MAINTAIN', WATCH: 'WATCH', OK: 'OK',
    UNSCHEDULED: 'UNSCHEDULED', ISOLATED: 'NO COVER',
};

export function Investigation() {
    const { towerId: urlTowerId } = useParams<{ towerId?: string }>();
    const navigate = useNavigate();
    const weights = useWeights((s) => s.weights);
    const selectedTowerId = useSelection((s) => s.selectedTowerId);
    const selectTower = useSelection((s) => s.selectTower);
    const setHighlightedTower = useScheduleSelection((s) => s.setHighlightedTower);
    const select = useScheduleStore((s) => s.select);
    const run = useScheduleStore((s) => s.run);
    const crewsQuery = useCrewsQuery();

    const { towers, isLoading } = useLiveTowers(weights);

    // Cover candidates, joined on tower_id. Null while the query is in flight or
    // the backend is unreachable — the list then shows no cover line at all,
    // rather than reporting a fetch in progress as "no cover".
    const { data: fallbackReport } = useTowerFallbackQuery();
    const fallbackByTower = fallbackReport?.towers ?? null;

    const [search, setSearch] = useState('');
    const [filterTab, setFilterTab] = useState<FilterTab>('ALL');
    const [sortBy, setSortBy] = useState<SortOption>('RISK_DESC');

    // Keep selected tower in sync with URL if towerId param is present
    useEffect(() => {
        if (urlTowerId) {
            selectTower(urlTowerId);
        }
    }, [urlTowerId, selectTower]);

    // Determine active tower
    const activeTowerId = urlTowerId || selectedTowerId;

    // Filter and sort tower list
    const filteredTowers = useMemo(() => {
        return towers.filter((tower) => {
            const name = placeName(tower.tower_id).toLowerCase();
            const id = tower.tower_id.toLowerCase();
            const query = search.toLowerCase().trim();
            const matchesSearch = !query || id.includes(query) || name.includes(query);

            if (!matchesSearch) return false;

            if (!isScored(tower)) {
                return filterTab === 'ALL';
            }

            const entry = run.entries.find((e) => e.tower_id === tower.tower_id);
            const unscheduled = !entry && run.unscheduled.includes(tower.tower_id);

            if (filterTab === 'MAINTAIN') return tower.decision === 'maintain';
            if (filterTab === 'WATCH') return tower.decision === 'watch';
            if (filterTab === 'OK') return tower.decision === 'ok';
            if (filterTab === 'UNSCHEDULED') return unscheduled;
            // Flood-exposed towers with no neighbour that could stand in. Empty while
            // the report is loading — an unanswered query must not present as
            // "none isolated".
            if (filterTab === 'ISOLATED') {
                const record = fallbackByTower?.[tower.tower_id];
                return record !== undefined && record.candidates.length === 0;
            }

            return true;
        }).sort((a, b) => {
            const aScored = isScored(a);
            const bScored = isScored(b);

            if (!aScored && !bScored) return a.tower_id.localeCompare(b.tower_id);
            if (!aScored) return 1;
            if (!bScored) return -1;

            if (sortBy === 'RISK_DESC') return b.risk - a.risk;
            if (sortBy === 'RISK_ASC') return a.risk - b.risk;
            if (sortBy === 'URGENCY_ASC') return a.urgency_days - b.urgency_days;
            if (sortBy === 'ID_ASC') return a.tower_id.localeCompare(b.tower_id);
            if (sortBy === 'EXPOSURE_DESC') {
                // Isolated first, then thinnest cover, then highest risk as the
                // tiebreak. Towers with no record are not at risk and sort last —
                // Infinity rather than a sentinel so they never interleave with a
                // real candidate count.
                const ca = fallbackByTower?.[a.tower_id]?.candidates.length ?? Infinity;
                const cb = fallbackByTower?.[b.tower_id]?.candidates.length ?? Infinity;
                if (ca !== cb) return ca - cb;
                return b.risk - a.risk;
            }
            return 0;
        });
    }, [towers, search, filterTab, sortBy, run, fallbackByTower]);

    // Select first tower if none active or active tower not in dataset
    const activeTower = useMemo(() => {
        if (activeTowerId) {
            const found = towers.find((t) => t.tower_id === activeTowerId);
            if (found) return found;
        }
        return filteredTowers[0] ?? towers[0];
    }, [towers, activeTowerId, filteredTowers]);

    const handleSelectTower = (tower: Tower) => {
        selectTower(tower.tower_id);
        navigate(`/investigation/${tower.tower_id}`, { replace: true });
    };

    const goToMap = () => {
        if (activeTower) selectTower(activeTower.tower_id);
        navigate('/map');
    };

    const goToSchedule = () => {
        if (activeTower) setHighlightedTower(activeTower.tower_id);
        navigate('/schedule');
    };

    // null until a schedule run exists to dispatch into — see
    // lib/dispatchTarget.ts. The button states that rather than creating an
    // emergency selection with no day, which posts target_day: "" and 500s.
    const dispatchDay = activeTower ? dispatchDayFor(run, activeTower.tower_id) : null;

    const dispatchNow = () => {
        if (!activeTower || dispatchDay === null) return;
        select({ kind: 'emergency', tower_id: activeTower.tower_id, day: dispatchDay });
        navigate('/schedule');
    };

    const scored = activeTower ? isScored(activeTower) : false;
    const entry = scored && activeTower ? run.entries.find((e) => e.tower_id === activeTower.tower_id) : undefined;
    const crews = crewsQuery.data ?? CREWS;
    const crew = entry ? crews.find((c) => c.crew_id === entry.crew_id) : undefined;
    const band = scored && activeTower ? bandColor(activeTower.decision) : undefined;
    // Fill ramp drives the spine and the dot; ink ramp drives every numeral.
    const ink = scored && activeTower ? bandInk(activeTower.decision) : undefined;
    const breakdown = scored && activeTower ? buildWorkBreakdown(activeTower, crew, entry) : undefined;
    const history = activeTower ? getHistory(activeTower.tower_id, activeTower) : [];
    const visitReports = activeTower ? getVisitReports(activeTower.tower_id, activeTower) : [];

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <PageHeader
                title="Tower Risk & Site Investigation"
                subtitle="In-depth spatial telemetry, risk factor attribution, and maintenance work order analytics"
            >
                <div className="flex items-center gap-2">
                    <Button tone="ghost" onClick={goToMap}>
                        View on Map
                    </Button>
                    <Button tone="primary" onClick={goToSchedule}>
                        View Schedule
                    </Button>
                </div>
            </PageHeader>

            <div className="flex min-h-0 flex-1 overflow-hidden">
                {/* Left Side: Tower List & Filter Panel (Similar to Picture 1) */}
                <aside className="glass-raised flex h-full w-[340px] shrink-0 flex-col border-y-0 border-l-0 border-r border-overlay/10">
                    <div className="flex flex-col gap-3 p-4 border-b border-overlay/10">
                        {/* Search Input */}
                        <div className="relative">
                            <input
                                type="text"
                                placeholder="Search Tower ID or Site..."
                                aria-label="Search towers by ID or site name"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                className="w-full rounded-lg border border-overlay/15 bg-ink-800 px-3 py-2 pl-9 text-ui text-fg placeholder:text-dim focus:border-accent focus:outline-none"
                            />
                            <span
                                className="pointer-events-none absolute left-[11px] top-[9px] text-dim"
                                aria-hidden="true"
                            >
                                <SearchIcon size={14} />
                            </span>
                        </div>

                        {/* Filter Pills */}
                        <div className="flex flex-wrap gap-1">
                            {(['ALL', 'MAINTAIN', 'WATCH', 'OK', 'UNSCHEDULED', 'ISOLATED'] as FilterTab[]).map((tab) => {
                                const isActive = filterTab === tab;
                                return (
                                    <button
                                        key={tab}
                                        onClick={() => setFilterTab(tab)}
                                        className={`rounded-md px-2 py-1 text-eyebrow font-semibold uppercase tracking-wider transition-colors ${isActive
                                            ? 'bg-accent/20 text-accent border border-accent/40'
                                            : 'border border-overlay/10 bg-overlay/[0.03] text-dim hover:text-fg hover:bg-overlay/[0.06]'
                                            }`}
                                    >
                                        {FILTER_LABELS[tab]}
                                    </button>
                                );
                            })}
                        </div>

                        {/* Sort & Count Header */}
                        <div className="flex items-center justify-between text-micro text-dim pt-1">
                            <span>{filteredTowers.length} sites found</span>
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value as SortOption)}
                                aria-label="Sort towers by"
                                className="rounded border border-overlay/15 bg-ink-800 px-2 py-0.5 text-micro text-fg focus:border-accent focus:outline-none"
                            >
                                <option value="RISK_DESC">Highest Risk</option>
                                <option value="URGENCY_ASC">Urgency (Days)</option>
                                <option value="RISK_ASC">Lowest Risk</option>
                                <option value="ID_ASC">Tower ID</option>
                                <option value="EXPOSURE_DESC">Least cover</option>
                            </select>
                        </div>
                    </div>

                    {/* Tower Item Cards List */}
                    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-2 space-y-1.5">
                        {isLoading ? (
                            <div className="p-4 text-center text-ui text-dim">Loading tower telemetry...</div>
                        ) : filteredTowers.length === 0 ? (
                            <div className="p-4 text-center text-ui text-dim">No matching towers found.</div>
                        ) : (
                            filteredTowers.map((t) => {
                                const isSelected = activeTower?.tower_id === t.tower_id;
                                const tScored = isScored(t);
                                const tBand = tScored ? bandColor(t.decision) : 'var(--color-dim)';
                                const tInk = tScored ? bandInk(t.decision) : 'var(--color-dim)';

                                return (
                                    // A button, not a clickable div: this list is the page's
                                    // primary navigation and was unreachable by keyboard, with
                                    // no focus ring and nothing exposed to a screen reader.
                                    <button
                                        key={t.tower_id}
                                        type="button"
                                        onClick={() => handleSelectTower(t)}
                                        aria-current={isSelected ? 'true' : undefined}
                                        className={`group relative block w-full cursor-pointer rounded-lg p-3 text-left transition-all duration-150 border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 ${isSelected
                                            ? 'border-accent/60 bg-accent/10 shadow-md shadow-accent/5'
                                            : 'border-overlay/8 bg-overlay/[0.03] hover:border-overlay/20 hover:bg-overlay/[0.06]'
                                            }`}
                                    >
                                        {/* Status Dot */}
                                        <div className="flex items-start justify-between gap-2">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <span
                                                    className="h-2 w-2 shrink-0 rounded-full"
                                                    style={{ backgroundColor: tBand, boxShadow: isSelected ? `0 0 0 3px ${tBand}33` : undefined }}
                                                />
                                                <div className="min-w-0">
                                                    <div className="font-mono text-ui font-semibold text-fg truncate">
                                                        {t.tower_id}
                                                    </div>
                                                    <div className="text-micro text-dim truncate">
                                                        {placeName(t.tower_id)}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Risk Score Badge */}
                                            {tScored ? (
                                                <div className="text-right shrink-0">
                                                    <div className="font-display text-body font-bold tnum" style={{ color: tInk }}>
                                                        {formatRisk(t.risk)}
                                                    </div>
                                                    <div className="text-eyebrow uppercase font-semibold tracking-wider text-dim">
                                                        {decisionLabel(t.decision)}
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-eyebrow text-dim italic">AOI Gap</span>
                                            )}
                                        </div>

                                        {/* Secondary info bar */}
                                        {tScored && (
                                            <div className="mt-2 flex items-center justify-between text-eyebrow border-t border-overlay/5 pt-1.5 text-muted">
                                                <span>{t.radio}</span>
                                                <span>Maintain in <strong className="text-fg">{formatUrgency(t.urgency_days)}</strong></span>
                                                {/* Absent report renders nothing at all — never "0 nearby". */}
                                                {(() => {
                                                    const record = fallbackByTower?.[t.tower_id];
                                                    if (!record) return null;
                                                    return record.candidates.length === 0 ? (
                                                        <span className="text-alert-ink font-semibold">&#9888; no cover</span>
                                                    ) : (
                                                        <span className="text-dim">{record.candidates.length} nearby</span>
                                                    );
                                                })()}
                                            </div>
                                        )}
                                    </button>
                                );
                            })
                        )}
                    </div>
                </aside>

                {/* Right Side: Detailed Tower Investigation View */}
                <main className="scroll-thin flex-1 overflow-y-auto p-6">
                    {!activeTower ? (
                        <Panel>
                            <p className="text-body text-dim">Select a tower from the list to investigate detailed telemetry.</p>
                        </Panel>
                    ) : !scored ? (
                        <Panel title={`Tower ${activeTower.tower_id}`}>
                            <p className="text-ui text-muted">
                                This tower sits outside the active perception AOI, so it currently has no risk index scoring.
                            </p>
                        </Panel>
                    ) : (
                        <div className="flex flex-col gap-6 max-w-6xl mx-auto">
                            {/* Site Header Banner */}
                            <div
                                className="glass-raised spine relative rounded-2xl p-6 border border-overlay/12 flex flex-col md:flex-row md:items-center justify-between gap-6"
                                style={{ '--spine': band } as React.CSSProperties}
                            >
                                <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                        <h2 className="h-title text-title font-bold">
                                            {placeName(activeTower.tower_id)}
                                        </h2>
                                        <span
                                            className="rounded-md border px-2.5 py-0.5 text-ui font-bold uppercase tracking-wider"
                                            style={{ color: ink, borderColor: `${band}66`, backgroundColor: `${band}1a` }}
                                        >
                                            {decisionLabel(activeTower.decision)}
                                        </span>
                                    </div>
                                    <p className="font-mono text-ui text-dim">
                                        Lat {activeTower.lat.toFixed(4)} · Lon {activeTower.lon.toFixed(4)} · {activeTower.radio} · {crew ? crew.territory : 'Unassigned'}
                                    </p>
                                </div>

                                {/* Score & Urgency Block */}
                                <div className="flex items-center gap-6 border-t border-overlay/10 md:border-t-0 pt-4 md:pt-0">
                                    <div className="text-left md:text-right">
                                        <div className="text-eyebrow uppercase tracking-wider text-dim font-semibold">Health Risk Index</div>
                                        <div className="flex flex-col items-center">
                                            <div className="font-display text-display font-extrabold tnum leading-tight" style={{ color: ink }}>
                                                {formatRisk(activeTower.risk)}
                                            </div>
                                            {/* Uncertainty bar under the score */}
                                            <div className="relative w-full h-[3px] bg-overlay/10 rounded-full mt-1 overflow-hidden">
                                                <div
                                                    className="absolute h-full rounded-full"
                                                    style={{
                                                        left: `${activeTower.risk_lo * 100}%`,
                                                        width: `${(activeTower.risk_hi - activeTower.risk_lo) * 100}%`,
                                                        backgroundColor: band
                                                    }}
                                                />
                                            </div>
                                        </div>
                                    </div>

                                    <div className="h-10 w-px bg-overlay/10 hidden sm:block" />

                                    <div className="text-left">
                                        <div className="text-eyebrow uppercase tracking-wider text-dim font-semibold">Maintenance SLA</div>
                                        <div className="font-display text-title font-bold font-mono">
                                            <span
                                                style={
                                                    activeTower.urgency_days <= 14
                                                        ? { color: 'var(--color-watch-ink)' }
                                                        : undefined
                                                }
                                                className={activeTower.urgency_days <= 14 ? undefined : 'text-fg'}
                                            >
                                                {formatUrgency(activeTower.urgency_days)}
                                            </span>
                                        </div>
                                    </div>

                                    <div className="flex flex-col gap-2 shrink-0">
                                        <Button
                                            tone="danger"
                                            onClick={dispatchNow}
                                            disabled={dispatchDay === null}
                                            title={dispatchDay === null ? NO_DISPATCH_DAY_REASON : undefined}
                                            className="px-4 py-2"
                                        >
                                            Dispatch Crew Now
                                        </Button>
                                        {dispatchDay === null && (
                                            <p className="max-w-[220px] text-micro leading-relaxed text-dim">
                                                {NO_DISPATCH_DAY_REASON}
                                            </p>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {/* Section 2: Env Signals & Model Transparency */}
                            <div className="grid grid-cols-[3fr_2fr] gap-3">
                                <Panel title="Geospatial Environment Signals">
                                    {Boolean(history.length) && (
                                        <div className="space-y-1">
                                            <EnvSignalRow
                                                Icon={FloodIcon}
                                                label="Flood Exposure"
                                                values={[{ key: 'HAND', value: `${history[0].hand_m} m` }, { key: 'Dist', value: `${history[0].dist_water_m} m` }]}
                                                share={activeTower.attribution['flood'] ?? 0}
                                                source="Sentinel-2+DEM"
                                            />
                                            <EnvSignalRow
                                                Icon={TerrainIcon}
                                                label="Terrain Instability"
                                                values={[{ key: 'Slope', value: `${history[0].slope_deg}°` }, { key: 'TRI', value: `${history[0].tri}` }]}
                                                share={activeTower.attribution['terrain'] ?? 0}
                                                source="SRTM"
                                            />
                                            <EnvSignalRow
                                                Icon={PowerIcon}
                                                label="Power Distance"
                                                values={[{ key: 'Dist', value: `${history[0].dist_power_m} m` }]}
                                                share={activeTower.attribution['power'] ?? 0}
                                                source="OpenStreetMap"
                                            />
                                            <EnvSignalRow
                                                Icon={EquipmentIcon}
                                                label="Equipment Load"
                                                values={[{ key: 'Radio', value: history[0].radio }]}
                                                share={activeTower.attribution['equipment'] ?? 0}
                                                source="Asset DB"
                                            />
                                        </div>
                                    )}
                                </Panel>
                                <ModelTransparencyPanel tower={activeTower} />

                                <EnsembleSignalPanel tower={activeTower} />

                                {/*
                                  Observed evidence, and physically outside both panels above it
                                  on purpose. Fire is not a factor, not one of the model's twelve
                                  features and carries no attribution share, so a fire row inside
                                  "Geospatial Environment Signals" would read as a fifth factor
                                  before anybody reached the words saying it is not. It fills the
                                  grid's empty row-2/col-2 cell instead.
                                */}
                                <FireExposurePanel tower={activeTower} />

                                {/*
                                  Beside the score, not inside it — the same placement argument
                                  FireExposurePanel makes above. Cover candidacy is not a factor,
                                  carries no attribution share, and this tower's risk and decision
                                  are identical with it switched off.
                                */}
                                <FallbackPanel tower={activeTower} />
                            </div>

                            {/* Section 4: Crew & Dispatch Team */}
                            <CrewProfileCard crew={crew} entry={entry} />

                            {/* Section 5: Schedule Timeline */}
                            <CountdownTimeline
                                urgencyDays={activeTower.urgency_days}
                                decision={activeTower.decision}
                                scheduledDate={entry?.day}
                            />

                            {/* Section 6 & 7: WBS Table & Gantt Chart */}
                            {breakdown && (
                                <div className="grid grid-cols-[minmax(300px,40%)_minmax(0,1fr)] gap-3 mb-4 items-start">
                                    <Panel title="Intervention Work Breakdown" className="h-full">
                                        <div className="overflow-x-auto min-h-[300px]">
                                            <table className="w-full text-left text-ui">
                                                <thead>
                                                    <tr className="text-dim border-b border-overlay/10">
                                                        <th className="pb-2 pr-3 font-medium">Task</th>
                                                        <th className="pb-2 pr-3 font-medium text-right">Start</th>
                                                        <th className="pb-2 font-medium">PIC</th>
                                                    </tr>
                                                </thead>
                                                <tbody>
                                                    {breakdown.tasks.map((task, i) => {
                                                        // Convert startDay offset to a formatted date String
                                                        const pStart = new Date(breakdown.planStart);
                                                        pStart.setDate(pStart.getDate() + task.startDay);
                                                        const startDateStr = pStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

                                                        return (
                                                            <React.Fragment key={task.code}>
                                                                {i === 0 && (
                                                                    <tr className="bg-overlay/5 border-y border-overlay/10"><td colSpan={3} className="font-bold py-1.5 px-3 text-eyebrow uppercase tracking-widest text-dim rounded-t">PREPARATORY WORKS</td></tr>
                                                                )}
                                                                {i === 2 && (
                                                                    <tr className="bg-overlay/5 border-y border-overlay/10"><td colSpan={3} className="font-bold py-1.5 px-3 text-eyebrow uppercase tracking-widest text-accent mt-2">EXECUTION</td></tr>
                                                                )}
                                                                {i === 3 && (
                                                                    <tr className="bg-overlay/5 border-y border-overlay/10"><td colSpan={3} className="font-bold py-1.5 px-3 text-eyebrow uppercase tracking-widest text-ok-ink mt-2">QA & CLOSEOUT</td></tr>
                                                                )}
                                                                <tr className="border-b border-overlay/5 last:border-0 hover:bg-overlay/[0.02]">
                                                                    <td className="py-2.5 px-3 text-fg font-medium">
                                                                        <span className="text-dim font-mono text-eyebrow mr-2">{task.code}</span>
                                                                        {task.name}
                                                                        <div className="text-eyebrow text-muted font-mono mt-0.5">{task.durationDays}d duration</div>
                                                                    </td>
                                                                    <td className="py-2.5 pr-3 text-right font-mono text-fg/90">{startDateStr}</td>
                                                                    <td className="py-2.5 text-fg/80">{task.pic}</td>
                                                                </tr>
                                                            </React.Fragment>
                                                        );
                                                    })}
                                                </tbody>
                                            </table>
                                        </div>
                                    </Panel>

                                    <Panel title="Gantt Plan" className="h-full">
                                        <div className="min-h-[300px]">
                                            <GanttChart breakdown={breakdown} />
                                        </div>
                                    </Panel>
                                </div>
                            )}

                            {/* Section 8: Risk Score History Chart */}
                            <RiskHistoryChart history={history} visits={visitReports} />

                            {/* Section 9: Site Parameter Log */}
                            <SiteParamTable records={history} />

                            {/* Section 10: Visit Reports */}
                            <VisitReportList reports={visitReports} />
                        </div>
                    )}
                </main>
            </div>
        </div>
    );
}
