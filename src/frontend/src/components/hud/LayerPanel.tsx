import { useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useFireExposureQuery,
  useFireLayersQuery,
  useFloodLayersQuery,
  useLandLayersQuery,
  useLayerTilesQuery,
  useMapPreparationQuery,
  useReloadMaps,
} from '../../api/queries';
import { useFloodLayers, DEFAULT_LAYER_OPACITY } from '../../state/useFloodLayers';
import { useFloodStage } from '../../state/useFloodStage';
import { useSelection } from '../../state/useSelection';
import { useScheduleStore } from '../../state/useScheduleStore';
import { FLOOD_STAGES_M } from '../../lib/inundation';
import { formatRelativeAge } from '../../lib/format';
import { dispatchDayFor, NO_DISPATCH_DAY_REASON } from '../../lib/dispatchTarget';
import type { MapLayerMeta } from '../../api/types';
import { Button } from '../ui/Panel';
import { isSkyLayer } from '../map/eeLayer';
import { ChevronDownIcon, FireIcon, FloodIcon, RainIcon, SatelliteIcon, TerrainIcon } from '../shell/icons';

/**
 * Categories organise the catalogue; toggles independently control the map.
 * Water and land keep their own queries and availability states.
 */

const CATEGORIES = [
  { id: 'flood', label: 'Flood', title: 'Flood & water', hint: 'Water extent, river outlooks and terrain scenarios.', Icon: FloodIcon },
  { id: 'rain', label: 'Rain', title: 'Rainfall', hint: 'Compare observed rain with the next 24-hour forecast.', Icon: RainIcon },
  { id: 'soil', label: 'Soil', title: 'Soil & ground', hint: 'Soil moisture, clay content, slope and vegetation.', Icon: TerrainIcon },
  { id: 'fire', label: 'Fire', title: 'Fire & hotspots', hint: 'Satellite thermal anomalies near towers, observed only.', Icon: FireIcon },
] as const;
type Category = (typeof CATEGORIES)[number]['id'];

function categoryOf(layer: MapLayerMeta): Category {
  // Fire first. There is no default-reject branch below — the tail returns
  // 'flood' for anything it does not recognise — so a group tested after the
  // rain check would file every fire layer under the Flood tab with a
  // FloodIcon beside it and look entirely deliberate.
  if (layer.group === 'fire') return 'fire';
  if (layer.group === 'land') return 'soil';
  return isSkyLayer(layer.layer_id) ? 'rain' : 'flood';
}

function StatusNote({ tone, children }: { tone: 'warn' | 'info'; children: ReactNode }) {
  const cls =
    tone === 'warn'
      ? 'border-maintain/35 bg-maintain/10 text-maintain-ink'
      : 'border-overlay/[0.12] bg-overlay/[0.04] text-dim';
  return (
    <p
      aria-live="polite"
      className={`mt-2 rounded-lg border px-2.5 py-1.5 text-[10.5px] leading-snug ${cls}`}
    >
      {children}
    </p>
  );
}

function formatUtc(value: string): string {
  return `${new Date(value).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  })} UTC`;
}

/** Whole days between an observation and the date the operator asked about. */
function daysBefore(observedAt: string, date: string): number {
  const observed = new Date(observedAt).getTime();
  const asked = new Date(`${date}T23:59:59Z`).getTime();
  return Math.max(0, Math.floor((asked - observed) / 86_400_000));
}

function LayerGlyph({ layer }: { layer: MapLayerMeta }) {
  if (layer.group === 'fire') return <FireIcon size={15} />;
  if (categoryOf(layer) === 'rain') return <RainIcon />;
  // Existing glyphs, reused rather than drawn: imagery-derived land layers get
  // the satellite mark, ground-derived ones the terrain mark.
  if (layer.group === 'land') {
    return layer.layer_id === 'vegetation_vigour' || layer.layer_id === 'land_cover' ? (
      <SatelliteIcon size={15} />
    ) : (
      <TerrainIcon />
    );
  }
  if (layer.temporal_kind === 'scenario') return <TerrainIcon />;
  if (layer.layer_id === 's1_backscatter' || layer.layer_id === 'daily_water') {
    return <SatelliteIcon size={15} />;
  }
  return <FloodIcon />;
}

/** The per-layer body: legend, provenance, opacity, and whatever went wrong. */
function LayerBody({ layer }: { layer: MapLayerMeta }) {
  const date = useFloodLayers((s) => s.date);
  const setDate = useFloodLayers((s) => s.setDate);
  const sensor = useFloodLayers((s) => s.sensor);
  const setSensor = useFloodLayers((s) => s.setSensor);
  const opacity = useFloodLayers((s) => s.opacity[layer.layer_id] ?? DEFAULT_LAYER_OPACITY);
  const setOpacity = useFloodLayers((s) => s.setOpacity);
  const active = useFloodLayers((s) => s.active.includes(layer.layer_id));
  const stage = useFloodStage((s) => s.stage);
  const handTileError = useFloodStage((s) => s.tileError);
  const setStage = useFloodStage((s) => s.setStage);

  // Only ask for live tiles while drawn. Earth Engine mints a map id; GloFAS
  // resolves the source-selected latest WMS run before returning its template.
  const usesTiles = layer.kind !== 'static';
  const { data, error, isFetching } = useLayerTilesQuery(
    layer.group,
    layer.layer_id,
    date,
    usesTiles && active,
    layer.temporal_kind,
    layer.sensors.length ? sensor : undefined,
  );
  const pct = Math.round(opacity * 100);

  return (
    <div
      id={`flood-body-${layer.layer_id}`}
      role="region"
      aria-labelledby={`flood-header-${layer.layer_id}`}
      className="border-t border-overlay/[0.09] bg-ink-900 px-3 pb-3 pt-3"
    >
      <p className="text-micro text-muted">{layer.description}</p>

      {layer.dated && (
        <div className="mt-3">
          {layer.sensors.length > 0 && (
            <>
              <label
                htmlFor={`flood-sensor-${layer.layer_id}`}
                className="mb-1.5 block text-[10.5px] font-medium text-muted"
              >
                Sensor
              </label>
              <select
                id={`flood-sensor-${layer.layer_id}`}
                value={sensor}
                onChange={(event) => setSensor(event.target.value)}
                className="mb-3 h-8 w-full rounded-lg border border-overlay/[0.14] bg-ink-900 px-2 text-[11px] text-fg"
              >
                {layer.sensors.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </>
          )}
          <label
            htmlFor={`flood-date-${layer.layer_id}`}
            className="mb-1.5 block text-[10.5px] font-medium text-muted"
          >
            Observation date · shared
          </label>
          <input
            id={`flood-date-${layer.layer_id}`}
            type="date"
            value={date}
            onChange={(event) => setDate(event.target.value)}
            className="h-8 w-full rounded-lg border border-overlay/[0.14] bg-ink-900 px-2 text-[11px] tnum text-fg"
          />
        </div>
      )}

      {layer.temporal_kind === 'scenario' && (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <label htmlFor="flood-stage-panel" className="text-[10.5px] font-medium text-muted">
              Water level
            </label>
            <span className="text-[10.5px] tnum text-fg">
              {stage === null ? 'off' : `${stage} m`}
            </span>
          </div>
          <input
            id="flood-stage-panel"
            className="slider-hit"
            type="range"
            min={0}
            max={FLOOD_STAGES_M.length}
            step={1}
            value={stage === null ? 0 : (FLOOD_STAGES_M as readonly number[]).indexOf(stage) + 1}
            aria-valuetext={stage === null ? 'off' : `${stage} metres above nearest drainage`}
            onChange={(event) => {
              const index = Number(event.target.value);
              setStage(index === 0 ? null : FLOOD_STAGES_M[index - 1]);
            }}
          />
          {active && (
            <StatusNote tone="info">
              The 2D HAND surface covers Southeast Asia. Tower rings and the optional 3D volume
              remain limited to the Sunway pilot, where tower-level HAND was measured.
            </StatusNote>
          )}
          {active && handTileError && <StatusNote tone="warn">{handTileError}</StatusNote>}
        </div>
      )}

      {layer.legend.length > 0 && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          {layer.layer_id === 'potential_depth' && (
            <span className="text-[10px] text-muted">Scenario depth:</span>
          )}
          {layer.legend.map((entry) => (
            <span key={entry.label} className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-[3px] border border-overlay/20"
                style={{ backgroundColor: entry.color }}
              />
              <span className="text-[10px] text-dim">{entry.label}</span>
            </span>
          ))}
        </div>
      )}

      {/* Unconditional on the land group. A vegetation layer read loosely
          implies a regulatory duty has been discharged because a satellite saw
          something green, and three of the duties these layers speak to have no
          satellite answer at all. */}
      {layer.group === 'land' && active && (
        <StatusNote tone="warn">
          Context for a site audit, not a substitute for one. Compound cracks, land
          subsidence, ponding inside the compound and the 1 m perimeter grass cut are below
          what any layer here can see, and none of these feeds the tower risk score.
        </StatusNote>
      )}

      {/* The land note above was the only such disclaimer in this panel, and it
          is gated on its own group. A fire layer without an equivalent sits in
          the same chrome beside four layers that DO map to model features, with
          nothing saying it is different — and a warm raster over a tower reads
          as a hazard the score already knows about. */}
      {layer.group === 'fire' && active && (
        <StatusNote tone="warn">
          Observed thermal anomalies, not a fire perimeter and not damage. Nothing here
          enters the tower risk score, the decision bands or the factor shares — a hotspot
          near a tower is evidence for a planner to review, and the site may be untouched.
        </StatusNote>
      )}

      <div className="mt-3">
        <div className="mb-1.5 flex items-baseline justify-between gap-2">
          <label htmlFor={`op-${layer.layer_id}`} className="text-[10.5px] text-muted">
            Opacity
          </label>
          <span className="text-[10.5px] tnum text-fg">{pct}%</span>
        </div>
        <input
          id={`op-${layer.layer_id}`}
          className="slider-hit"
          type="range"
          min={10}
          max={100}
          step={1}
          value={pct}
          aria-valuetext={`${pct} percent`}
          onChange={(e) => setOpacity(layer.layer_id, Number(e.target.value) / 100)}
        />
      </div>

      {usesTiles && active && isFetching && !data && (
        <StatusNote tone="info">
          Loading prepared map…
        </StatusNote>
      )}

      {usesTiles && active && error && (
        <StatusNote tone="warn">
          {(error as Error).message.replace(/^GET \S+ failed: \d+ [^—]*— ?/, '')}
        </StatusNote>
      )}

      {usesTiles && active && data?.cache_detail && (
        <StatusNote tone="warn">{data.cache_detail}</StatusNote>
      )}

      {/* The backend fetched a tile itself and got 401/403, so this browser will
          too. Saying nothing here would leave a switched-on layer painting
          nothing at all. */}
      {data?.tile_access === 'requires_auth' && (
        <StatusNote tone="warn">
          {layer.kind === 'wms'
            ? 'GloFAS refused anonymous tile access, so this layer is not drawn.'
            : 'Earth Engine returned a tile URL this browser is not allowed to fetch, so the layer is not drawn. The project needs an API key, or the backend needs to proxy tiles.'}
        </StatusNote>
      )}

      {/* A selected date resolves to a bounded sensor window. Showing that
          window and its regional scene count keeps the label honest. */}
      {data?.window && data.scenes !== null && (
        <StatusNote tone="info">
          {data.scenes} {data.sensor ? layer.sensors.find((option) => option.id === data.sensor)?.label : 'source'}{' '}
          {data.scenes === 1 ? 'scene' : 'scenes'}
          {layer.layer_id === 'flood_extent' ? ' across Southeast Asia' : ''} from {data.window.start} to{' '}
          {data.window.end}.
        </StatusNote>
      )}

      {layer.sensors.length > 0 && active && (
        <StatusNote tone="warn">
          {sensor === 'sentinel-1'
            ? 'Radar screening can confuse smooth dry surfaces with water. Verify possible flood pixels before operational use.'
            : 'Optical water is cloud-masked screening data. It can miss water under cloud or confuse shadows and dark surfaces; verify before operational use.'}
        </StatusNote>
      )}

      {/* One granule is drawn, not a composite, and the search window is wide
          enough to clear a multi-day publication lag. That makes staleness the
          fact worth stating: a week-old soil reading shown as though current is
          the quiet version of the blank-layer failure. */}
      {layer.group === 'land' && data?.observed_at && (
        <StatusNote tone="info">
          Drawing the most recent observation at or before the selected date:{' '}
          {formatUtc(data.observed_at)}
          {(() => {
            const age = daysBefore(data.observed_at, data.date ?? date);
            return age > 0 ? ` — ${age} day${age === 1 ? '' : 's'} before the saved map date.` : '.';
          })()}
        </StatusNote>
      )}

      {data?.observed_at && data.source_count !== null && (
        <StatusNote tone="info">
          {data.source_count} hourly source images from {data.window?.start} to {data.window?.end}; latest at{' '}
          {data.observed_at}.
        </StatusNote>
      )}

      {data?.forecast && (
        <StatusNote tone="info">
          Issued {formatUtc(data.forecast.issued_at)} · valid {formatUtc(data.forecast.valid.start)}–
          {formatUtc(data.forecast.valid.end)} · {Math.round(data.forecast.source_age_seconds / 60)} min old.
          Covers Malaysia. In 3D, colours drape over terrain; they are not predicted water depth.
        </StatusNote>
      )}

      {layer.kind === 'wms' && active && (
        <StatusNote tone="warn">
          River-basin screening only. A blank view does not rule out local or flash flooding, and
          the terrain relief is not forecast water depth.
        </StatusNote>
      )}

      {layer.temporal_kind === 'forecast' && active && data && !data.forecast && (
        <StatusNote tone="warn">Forecast metadata is missing, so this layer is not drawn.</StatusNote>
      )}

      <p className="mt-2 text-[9.5px] leading-snug text-dim">{layer.attribution}</p>
    </div>
  );
}

/**
 * Which towers this screening pass found a hotspot near, for the date the
 * panel is already showing.
 *
 * Keyed on `useFloodLayers.date` — the same date the raster above is drawn
 * for — so the list and the pixels under it can never describe different days.
 *
 * Four states, none of them collapsible into another. A null query is "we
 * could not ask" and must never render as "no fires"; a resolved body with no
 * detections is a measurement, and says how many towers were looked at; a
 * stale source names its own age, because scheduling is refused against it;
 * and the list itself states the buffer, the window and the confidence filter,
 * since "a hotspot within 5 km over three days at 375 m" is a far weaker claim
 * than "a fire at this tower".
 *
 * Deliberately colourless. The warm ramp for this feature exists once, in the
 * map legend the backend Layer record carries; a row on the severity ramp
 * would read as a band, and fire enters no band, no score and no share.
 */
function FireExposureList() {
  const date = useFloodLayers((s) => s.date);
  const selectTower = useSelection((s) => s.selectTower);
  const select = useScheduleStore((s) => s.select);
  const run = useScheduleStore((s) => s.run);
  const navigate = useNavigate();
  const { data, isPending } = useFireExposureQuery(date);

  const frame = 'mt-3 border-t border-overlay/[0.09] pt-3';
  const heading = <h4 className="eyebrow mb-1.5">Towers near a hotspot</h4>;

  // Silence while the screening is in flight. Every other phrasing available
  // here is a claim about what was observed, and nothing has been yet.
  if (isPending) {
    return (
      <p role="status" className={`${frame} text-micro text-dim`}>
        Screening towers against this window…
      </p>
    );
  }

  if (!data) {
    return (
      <div className={frame}>
        {heading}
        <p className="text-micro leading-snug text-dim">
          Fire screening is unavailable, so no hotspot evidence can be shown. That is a
          missing screening pass, not an absence of fire.
        </p>
      </div>
    );
  }

  const { freshness, screening } = data;

  if (data.towers_with_detections === 0) {
    return (
      <div className={frame}>
        {heading}
        <p className="text-micro leading-snug text-dim">
          <span className="tnum text-muted">{data.screened_towers}</span> towers screened, no
          detections reported in this window.
        </p>
      </div>
    );
  }

  // Staleness CAVEATS the list; it does not replace it. Returning early here
  // suppressed every affected tower on any historical date — 85 towers with real
  // detections hidden behind a sentence about source age — and the sentence was
  // misleading too: `stale` is measured from the newest DETECTION anywhere in the
  // screening bbox, not from granule publication, so a complete historical window
  // is stale by construction. What staleness actually blocks is SCHEDULING, and
  // that is what the note now says.
  const staleNote = freshness.stale ? (
    <StatusNote tone="warn">
      {freshness.source_age_hours === null ? (
        <>No detection reached this window at all, so nothing here can be dated.</>
      ) : (
        <>
          The newest detection behind this screening is{' '}
          <span className="tnum">{freshness.source_age_hours.toFixed(1)} h</span> old, past the{' '}
          {freshness.stale_after_hours} h limit.
        </>
      )}{' '}
      The observations below still stand; an inspection cannot be scheduled against them until
      fresher data arrives.
    </StatusNote>
  ) : null;

  // ISO-Z strings sort lexicographically in time order, so this is the
  // descending sort the panel wants without parsing 40 dates to get it.
  const rows = Object.values(data.towers)
    .sort((a, b) => b.latest_acquisition.localeCompare(a.latest_acquisition))
    .map((row) => ({ ...row, day: dispatchDayFor(run, row.tower_id) }));
  // Null only when no run is loaded, which is a condition of the whole list
  // rather than of any one tower — so the reason is stated once, beneath it.
  const undispatchable = rows.some((row) => row.day === null);

  const review = (tower_id: string, day: string | null) => {
    if (day === null) return;
    select({ kind: 'fire_inspection', tower_id, day });
    navigate('/schedule');
  };

  return (
    <div className={frame}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        {heading}
        <span className="text-eyebrow tnum text-dim">
          {data.towers_with_detections} of {data.screened_towers}
        </span>
      </div>

      {staleNote}

      <ul className="scroll-thin max-h-[188px] space-y-1.5 overflow-y-auto pr-0.5">
        {rows.map((row) => (
          <li key={row.tower_id} className="rounded-lg border border-overlay/[0.10] bg-ink-900">
            <button
              type="button"
              /* No aria-label here. One overriding the button's own content is
                 what a screen reader announces INSTEAD of it, so "Select MY_N…"
                 replaced the row's primary datum — the detection-day count — and
                 the one number the row exists to convey was never read out. The
                 content below already names the tower and the count; the unit is
                 spelled out so it is announced as words rather than a bare
                 number. */
              onClick={() => selectTower(row.tower_id)}
              className="flex w-full items-baseline gap-2 rounded-t-lg px-2 pt-1.5 text-left transition-colors hover:bg-overlay/[0.05]"
            >
              <span className="min-w-0 flex-1 truncate font-mono text-micro text-fg">
                {row.tower_id}
              </span>
              <span className="shrink-0 text-ui tnum text-fg">{row.hotspot_pixel_days}</span>
              <span className="shrink-0 text-eyebrow text-dim">detection-days</span>
            </button>
            <div className="flex items-center justify-between gap-2 px-2 pb-1.5">
              <span className="min-w-0 truncate text-eyebrow text-dim">
                {formatRelativeAge(row.latest_acquisition)} · {row.max_confidence}
              </span>
              <Button
                tone="ghost"
                aria-label={`Review inspection for ${row.tower_id}`}
                onClick={() => review(row.tower_id, row.day)}
                disabled={row.day === null}
                title={row.day === null ? NO_DISPATCH_DAY_REASON : undefined}
                className="h-8 shrink-0"
              >
                Review inspection
              </Button>
            </div>
          </li>
        ))}
      </ul>

      {undispatchable && (
        <p className="mt-2 text-eyebrow leading-snug text-dim">{NO_DISPATCH_DAY_REASON}</p>
      )}

      <p className="mt-2 border-t border-overlay/[0.09] pt-2 text-eyebrow leading-snug text-dim">
        Hotspots within <span className="tnum">{screening.buffer_m / 1000} km</span> of a tower,
        over the <span className="tnum">{screening.window_days}</span> days ending {data.date}, at{' '}
        <span className="tnum">{screening.resolution_m} m</span>.{' '}
        {screening.confidence_included.join(' and ')} confidence only;{' '}
        {screening.confidence_excluded.join(', ')} excluded. A detection-day counts satellite
        passes, not fires and not damage.
      </p>
    </div>
  );
}

function LayerRow({ layer }: { layer: MapLayerMeta }) {
  const active = useFloodLayers((s) => s.active.includes(layer.layer_id));
  const expanded = useFloodLayers((s) => s.expanded === layer.layer_id);
  const toggleLayer = useFloodLayers((s) => s.toggleLayer);
  const setExpanded = useFloodLayers((s) => s.setExpanded);
  const date = useFloodLayers((s) => s.date);
  const sensor = useFloodLayers((s) => s.sensor);
  const stage = useFloodStage((s) => s.stage);
  const handTileError = useFloodStage((s) => s.tileError);
  // Keep a compact status visible even when the settings are collapsed.
  const { data, error, isFetching } = useLayerTilesQuery(
    layer.group, layer.layer_id, date, active && layer.kind !== 'static',
    layer.temporal_kind, layer.sensors.length ? sensor : undefined,
  );
  const unavailable = active && (layer.kind === 'static'
    ? stage !== null && Boolean(handTileError)
    : Boolean(error) || data?.tile_access === 'requires_auth' ||
      Boolean(data && layer.temporal_kind === 'forecast' && !data.forecast));
  const status = unavailable ? 'Unavailable · view details'
    : active && data?.cache_stale ? 'Cached imagery · refresh pending'
    : active && layer.kind === 'static' && stage === null ? 'Choose a water level'
    : active && isFetching && !data ? 'Loading layer…'
    : active && data?.date ? `Saved for ${data.date}` : null;

  return (
    <article
      className={`overflow-hidden rounded-xl border transition-colors ${
        active ? 'border-accent/35 bg-accent/[0.04]' : 'border-overlay/[0.10] bg-ink-900'
      }`}
    >
      <div className="flex items-center gap-1 p-1">
        <h3 className="min-w-0 flex-1">
          <button
            id={`flood-header-${layer.layer_id}`}
            type="button"
            aria-expanded={expanded}
            aria-controls={`flood-body-${layer.layer_id}`}
            onClick={() => setExpanded(layer.layer_id)}
            className="flex min-h-16 w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-overlay/[0.04]"
          >
            <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-accent/10 text-accent' : 'bg-ink-950 text-dim'}`}>
              <LayerGlyph layer={layer} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-ui font-medium leading-snug text-fg">{layer.label}</span>
              <span className="mt-1 flex items-center gap-1 text-eyebrow capitalize text-dim">
                {layer.temporal_kind === 'observation' ? 'Observed' : layer.temporal_kind}
                <span aria-hidden="true">·</span>
                <span>{expanded ? 'Less' : 'Details'}</span>
                <span className={`transition-transform ${expanded ? 'rotate-180' : ''}`}><ChevronDownIcon /></span>
              </span>
            </span>
          </button>
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={active}
          aria-label={`Show ${layer.label} on map`}
          onClick={() => toggleLayer(layer.layer_id)}
          className="flex min-h-11 w-11 shrink-0 flex-col items-center justify-center gap-1 rounded-lg transition-colors hover:bg-overlay/[0.05]"
        >
          <span aria-hidden="true" className={`relative h-[18px] w-8 rounded-full transition-colors ${active ? 'bg-accent' : 'bg-overlay/25'}`}>
            <span className={`absolute left-[3px] top-[3px] h-3 w-3 rounded-full bg-ink-900 shadow-sm transition-transform ${active ? 'translate-x-[14px]' : ''}`} />
          </span>
          <span aria-hidden="true" className={`text-eyebrow font-medium ${active ? 'text-accent' : 'text-dim'}`}>{active ? 'On' : 'Off'}</span>
        </button>
      </div>
      {status && (
        <p role="status" className={`px-3 pb-2 text-micro ${unavailable ? 'text-maintain-ink' : 'text-dim'}`}>{status}</p>
      )}
      {expanded && <LayerBody layer={layer} />}
    </article>
  );
}

export function LayerPanel() {
  const flood = useFloodLayersQuery();
  const land = useLandLayersQuery();
  const fire = useFireLayersQuery();
  const date = useFloodLayers((s) => s.date);
  const followLatest = useFloodLayers((s) => s.followLatest);
  const useLatest = useFloodLayers((s) => s.useLatest);
  const { data: preparation } = useMapPreparationQuery(date);
  const reload = useReloadMaps();
  const loading = preparation?.layers.some((layer) => layer.loading) ?? false;
  const ready = preparation?.layers.filter((layer) => layer.state === 'ready' && !layer.cache_stale && !layer.loading).length ?? 0;
  const paused = Boolean(preparation?.retry_at);
  const reloadIssues = preparation?.layers.filter((layer) => layer.detail && !layer.loading) ?? [];
  const active = useFloodLayers((s) => s.active);
  const expanded = useFloodLayers((s) => s.expanded);
  const setExpanded = useFloodLayers((s) => s.setExpanded);
  const [category, setCategory] = useState<Category>('flood');
  const panelRef = useRef<HTMLElement>(null);
  const allLayers = [
    ...(flood.data?.layers ?? []),
    ...(land.data?.layers ?? []),
    ...(fire.data?.layers ?? []),
  ];
  // Which catalogue's loading state and Earth-Engine footer this tab reports.
  // A binary here was the bug: the Fire tab would sit on 'Loading layers…' for as
  // long as the flood query was pending, and then describe the flood catalogue's
  // credentials under a fire layer.
  const CATALOGUE_FOR: Record<Category, typeof flood.data> = {
    flood: flood.data,
    rain: flood.data,
    soil: land.data,
    fire: fire.data,
  };
  const catalogue = CATALOGUE_FOR[category];
  const current = CATEGORIES.find((item) => item.id === category)!;
  const layers = allLayers.filter((layer) => categoryOf(layer) === category);
  // Lead the Soil category with the two soil products; retain every land layer.
  if (category === 'soil') {
    layers.sort((a, b) => Number(b.layer_id.startsWith('soil_')) - Number(a.layer_id.startsWith('soil_')));
  }
  const enabled = allLayers.filter((layer) => active.includes(layer.layer_id));

  return (
    <section ref={panelRef} aria-label="Map layers" className="glass-float rounded-2xl">
      <header className="sticky top-0 z-10 rounded-t-2xl border-b border-overlay/[0.09] bg-ink-900 p-3.5">
        <div className="mb-3 flex items-center justify-between gap-2">
          <div>
            <p className="eyebrow mb-1">Explore the map</p>
            <h2 className="h-title text-lead">Map layers</h2>
          </div>
          <span aria-live="polite" className={`rounded-full px-2.5 py-1 text-micro ${enabled.length ? 'bg-accent/10 text-accent' : 'bg-ink-950 text-dim'}`}>
            {enabled.length} enabled
          </span>
        </div>
        <div className="mb-3 space-y-1.5">
          <p className="text-micro text-muted">{followLatest ? 'Latest saved imagery · newest date: ' : 'Observation date: '}<time dateTime={date}>{date}</time></p>
          {!followLatest && <Button tone="ghost" onClick={useLatest}>Use latest saved imagery</Button>}
          {preparation?.saved_dates?.length ? <p className="text-micro text-dim">
            Saved dates: {preparation.saved_dates.join(', ')}
          </p> : null}
          <Button tone="ghost" onClick={() => reload.mutate(followLatest ? 'latest' : date)}
            disabled={reload.isPending || loading || paused || !/^\d{4}-\d{2}-\d{2}$/.test(date)}>
            {reload.isPending || loading ? 'Loading maps…' : 'Reload all maps'}
          </Button>
          <p role="status" className="text-micro text-dim">
            {preparation ? `${ready}/${preparation.layers.length} maps ready · ` : ''}Refreshes only when you click Reload all maps.
            {followLatest && ' Reload fetches the latest source window available through today.'}
            {loading && ' Loading one at a time; saved maps stay visible.'}
            {preparation?.retry_at && ` Earth Engine reload available after ${formatUtc(preparation.retry_at)}.`}
          </p>
          {reload.error && <StatusNote tone="warn">{reload.error.message}</StatusNote>}
          {reloadIssues.length > 0 && <details className="text-micro text-dim">
            <summary className="cursor-pointer">Map variants that could not be updated: {reloadIssues.length}. Showing saved imagery where available.</summary>
            <ul className="mt-1 space-y-1">
              {reloadIssues.map((layer) => <li key={`${layer.layer_id}:${layer.sensor ?? ''}`}>
                {allLayers.find((item) => item.layer_id === layer.layer_id)?.label ?? layer.layer_id.replaceAll('_', ' ')}{layer.sensor ? ` · ${layer.sensor}` : ''}: {layer.detail}
              </li>)}
            </ul>
          </details>}
          {preparation?.progress && <p className="text-micro text-dim" role="status">
            {preparation.progress.layer_id.replaceAll('_', ' ')}{preparation.progress.sensor ? ` · ${preparation.progress.sensor}` : ''}: {preparation.progress.loaded.toLocaleString()}/{preparation.progress.total.toLocaleString()} tiles
            {preparation.progress.phase === 'saving' ? ' · Saving to Supabase…' : ' · Fetching…'}
          </p>}
          <p className="text-micro text-dim">Saves ASEAN at zooms 0–8. Deeper zooms enlarge saved images without fetching new detail.</p>
          {preparation?.storage_error && <StatusNote tone="warn">Saved maps are available. Cloud storage is temporarily unavailable; reload when it reconnects.</StatusNote>}
        </div>
        <div role="group" aria-label="Layer categories" className="grid grid-cols-4 gap-1.5 rounded-xl bg-ink-950 p-1.5">
          {CATEGORIES.map(({ id, label, Icon }) => {
            const count = enabled.filter((layer) => categoryOf(layer) === id).length;
            return (
              <button
                key={id}
                type="button"
                aria-label={label}
                aria-describedby={`map-layer-count-${id}`}
                aria-pressed={category === id}
                aria-controls="map-layer-list"
                onClick={() => {
                  setCategory(id);
                  panelRef.current?.scrollIntoView({ block: 'start' });
                }}
                className={`relative flex min-h-16 flex-col items-center justify-center gap-1.5 rounded-lg text-ui font-medium transition-colors ${
                  category === id ? 'bg-accent text-white shadow-sm' : 'text-muted hover:bg-ink-900 hover:text-accent'
                }`}
              >
                <Icon />
                <span>{label}</span>
                {count > 0 && <span aria-hidden="true" className={`absolute right-1.5 top-1 rounded-full px-1 text-eyebrow ${category === id ? 'bg-white/20 text-white' : 'bg-accent/10 text-accent'}`}>{count}</span>}
                <span id={`map-layer-count-${id}`} className="sr-only">{count} enabled</span>
              </button>
            );
          })}
        </div>
        {enabled.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-micro text-muted">Enabled layers</span>
              <button type="button" onClick={() => useFloodLayers.setState({ active: [] })} className="min-h-8 rounded-md px-2 text-micro font-medium text-accent hover:bg-accent/10">Clear all</button>
            </div>
            <div className="scroll-thin flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
              {enabled.map((layer) => (
                <button
                  key={layer.layer_id}
                  type="button"
                  aria-label={`View ${layer.label} settings`}
                  onClick={() => {
                    setCategory(categoryOf(layer));
                    if (expanded !== layer.layer_id) setExpanded(layer.layer_id);
                    requestAnimationFrame(() => {
                      const header = document.getElementById(`flood-header-${layer.layer_id}`);
                      header?.focus({ preventScroll: true });
                      const row = header?.closest('article');
                      const navigation = panelRef.current?.querySelector('header');
                      const rail = panelRef.current?.parentElement;
                      // Enabled chips wrap, so clear the actual header height.
                      if (row && navigation && rail) {
                        rail.scrollTop += row.getBoundingClientRect().top - navigation.getBoundingClientRect().bottom - 12;
                      }
                    });
                  }}
                  className="min-h-8 max-w-full truncate rounded-lg border border-accent/20 bg-accent/[0.06] px-2 text-micro text-accent transition-colors hover:bg-accent/15"
                >
                  {layer.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </header>

      <div id="map-layer-list" role="region" aria-label={current.title} className="p-3">
        <div className="mb-3 px-0.5">
          <h3 className="text-ui font-semibold text-fg">{current.title}</h3>
          <p className="mt-1 text-micro text-dim">{current.hint}</p>
        </div>
        {!catalogue ? <p role="status" className="py-3 text-ui text-dim">Loading layers…</p> : (
          <div className="space-y-2">
            {layers.map((layer) => <LayerRow key={layer.layer_id} layer={layer} />)}
          </div>
        )}
        {/* The affected-tower list belongs to the category, not to any one layer:
            the screening runs whether or not the raster is switched on, and a
            planner asking "which of my towers are near a fire" should not have to
            draw the map to find out. It lives inside this panel rather than in a
            new floating module because the console's blur budget is already spent
            (see the glass-surface count in CLAUDE.md). */}
        {category === 'fire' && <FireExposureList />}
      </div>

      <footer className="space-y-2 border-t border-overlay/[0.09] px-3.5 py-3 text-micro text-dim">
        <p>Layers stay on when you switch categories.</p>
        {catalogue?.earth_engine === null ? (
          <p>Backend unreachable — satellite layers are unavailable.
            {category === 'flood' && ' Regional HAND tiles still need network access to ASF.'}
            {category === 'fire' && ' Hotspot screening needs the same connection, so no tower evidence can be shown either.'}
          </p>
        ) : catalogue && !catalogue.earth_engine?.configured ? (
          <p>Satellite layers are unavailable until the data connection is configured.</p>
        ) : null}
      </footer>
    </section>
  );
}
