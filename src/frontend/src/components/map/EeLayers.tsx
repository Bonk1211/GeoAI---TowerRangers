import { useEffect, useRef, useState } from 'react';
import { useMapInstance } from '../../state/useMapInstance';
import { useFloodLayers, DEFAULT_LAYER_OPACITY } from '../../state/useFloodLayers';
import { useLayerTilesQuery } from '../../api/queries';
import { eeLayerId, eeSourceId, eeRasterLayer, eeRasterSource, isSkyLayer } from './eeLayer';
import { TOWER_LAYER_ID } from './towerLayer';
import { groundAnchor, SOUTHEAST_ASIA_BBOX } from './basemap';
import type { MapLayerMeta } from '../../api/types';
import { useMap3D } from '../../state/useMap3D';
import { stackedRasterLayer } from './stackedRasterLayer';
import type { StackRect } from './stackGeometry';

function StackedRaster({ layer, tileUrl, bounds, maxZoom, opacity, level, count, note, attribution }: {
  layer: MapLayerMeta; tileUrl?: string; bounds: StackRect; maxZoom: number;
  opacity: number; level: number; count: number; note: string; attribution: string;
}) {
  const map = useMapInstance((s) => s.map);
  const spacing = useMap3D((s) => s.spacing);
  const label = useRef<HTMLDivElement>(null);
  const axis = useRef<SVGLineElement>(null);
  const guide = useRef<SVGLineElement>(null);
  const marker = useRef<SVGUseElement>(null);
  const groundMarker = useRef<SVGUseElement>(null);
  const settings = useRef<Parameters<typeof stackedRasterLayer>[0] | null>(null);
  const [status, setStatus] = useState('');
  const [west, south, east, north] = bounds;

  useEffect(() => {
    if (!map || !label.current || !axis.current || !guide.current || !marker.current || !groundMarker.current) return;
    const id = `stack-${layer.layer_id}`;
    const options = {
      id, tileUrl, bounds: [west, south, east, north] as StackRect, maxZoom,
      level, count, spacing, opacity, label: label.current, axis: axis.current, guide: guide.current,
      marker: marker.current, groundMarker: groundMarker.current, onStatus: setStatus,
    };
    settings.current = options;
    const mount = () => {
      if (!map.getLayer(id)) {
        map.addLayer(stackedRasterLayer(options));
        // Responses may arrive in any order; translucent planes draw bottom first.
        for (const activeId of useFloodLayers.getState().active) {
          const layerId = `stack-${activeId}`;
          if (map.getLayer(layerId)) map.moveLayer(layerId);
        }
      }
    };
    // MapView mounts us after `load`; pending tiles do not block adding layers.
    mount();
    return () => {
      if (map.getLayer(id)) map.removeLayer(id);
      settings.current = null;
    };
    // Display controls mutate the live layer below; they never reload imagery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layer.layer_id, tileUrl, west, south, east, north, maxZoom]);

  useEffect(() => {
    if (settings.current) Object.assign(settings.current, { level, count, spacing, opacity });
    map?.triggerRepaint();
  }, [map, level, count, spacing, opacity]);

  return <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
    <svg className="absolute inset-0 h-full w-full" aria-hidden="true">
      <line ref={axis} stroke="#7c3aed" strokeWidth="1.5" />
      <line ref={guide} data-stack-guide={layer.layer_id} stroke="#6d28d9" strokeWidth="3" strokeDasharray="6 5" />
      <defs><g id={`stack-target-${layer.layer_id}`}>
        <circle r="14" fill="white" fillOpacity="0.9" stroke="white" strokeWidth="4" />
        <circle r="11" fill="none" stroke="#6d28d9" strokeWidth="3" />
        <path d="M-19 0h6M13 0h6M0-19v6M0 13v6" stroke="white" strokeWidth="6" strokeLinecap="round" />
        <path d="M-19 0h6M13 0h6M0-19v6M0 13v6" stroke="#6d28d9" strokeWidth="2.5" strokeLinecap="round" />
        <circle r="4.5" fill="#6d28d9" />
      </g></defs>
      <use ref={marker} href={`#stack-target-${layer.layer_id}`} data-stack-marker={layer.layer_id}
        style={{ visibility: 'hidden' }} />
      <use ref={groundMarker} href={`#stack-target-${layer.layer_id}`} data-ground-marker={layer.layer_id}
        style={{ visibility: 'hidden' }} />
    </svg>
    <div ref={label} data-stack-layer={layer.layer_id} data-stack-level={level}
      className="absolute left-0 top-0 max-w-64 rounded-md border border-accent/30 bg-ink-900/95 px-2 py-1 shadow-sm">
      <p className="text-ui font-medium text-fg"><span className="mr-1.5 text-accent">Sky {level}</span>{layer.label}</p>
      <p className="text-eyebrow text-muted">{note}</p>
      {tileUrl && status && <p role="status" className="text-micro text-fg">{status}</p>}
      {attribution && <p className="max-w-60 truncate text-eyebrow text-dim" title={attribution}>{attribution}</p>}
    </div>
  </div>;
}

/**
 * Mounts one live raster overlay onto the console map.
 *
 * One component per active layer, so each gets its own tile query and lifecycle
 * — mounting adds the source, unmounting removes it, and a refreshed Earth
 * Engine map id or pinned GloFAS run swaps it. Doing this with a loop of hooks
 * inside MapView would break the moment the active set changed length.
 *
 * It reads the map from useMapInstance and never writes to it. That store is a
 * singleton describing the full-bleed console, and publishing to it from
 * anything else would make the graticule ticks and scale bar describe the wrong
 * map (see the RouteMap note in CLAUDE.md).
 */
function EeLayer({ layer, level, count }: { layer: MapLayerMeta; level: number; count: number }) {
  const layerId = layer.layer_id;
  const map = useMapInstance((s) => s.map);
  const stacked = useMap3D((s) => s.stacked);
  const raised = stacked && isSkyLayer(layerId);
  const date = useFloodLayers((s) => s.date);
  const sensor = useFloodLayers((s) => s.sensor);
  const opacity = useFloodLayers((s) => s.opacity[layerId] ?? DEFAULT_LAYER_OPACITY);
  const { data, error } = useLayerTilesQuery(
    layer.group,
    layerId,
    date,
    true,
    layer.temporal_kind,
    layer.sensors.length ? sensor : undefined,
  );

  const tileUrl = data?.tile_url;
  const attribution = data?.attribution ?? '';
  // A layer whose tiles the browser cannot fetch must not be added at all.
  // Adding it would paint nothing, log nothing, and look identical to "there
  // was no water here" — or, on a land layer, "nothing is growing here", which
  // is the same failure wearing a friendlier face. The
  // panel reads the same query and says why instead. A failed background
  // refresh retains the previous data, so an error must also suppress that
  // now-stale tile template.
  const drawable =
    Boolean(tileUrl) &&
    !error &&
    data?.tile_access !== 'requires_auth' &&
    (layer.temporal_kind !== 'forecast' || Boolean(data?.forecast));
  const bounds = data?.bounds ?? data?.forecast?.bounds ?? layer.bounds ?? SOUTHEAST_ASIA_BBOX;
  const maxZoom = data?.max_zoom ?? 8;
  const [west, south, east, north] = bounds ?? [];

  useEffect(() => {
    if (!map || !tileUrl || !drawable || raised) return;
    const sourceId = eeSourceId(layerId);
    const rasterId = eeLayerId(layerId);
    const mount = () => {
      if (map.getLayer(rasterId)) map.removeLayer(rasterId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);

      const sourceBounds =
        west === undefined ? undefined : ([west, south, east, north] as [number, number, number, number]);
      map.addSource(sourceId, eeRasterSource(tileUrl, attribution, sourceBounds, maxZoom));
      // Below the basemap's labels, like every other ground layer, so place names
      // stay readable through satellite imagery. Falls back to the tower layer if
      // the style carries no symbol layer, and to undefined (append on top) if the
      // towers are not in yet — they are added in the map's own load handler.
      const beforeId =
        groundAnchor(map) ?? (map.getLayer(TOWER_LAYER_ID) ? TOWER_LAYER_ID : undefined);
      map.addLayer({ ...eeRasterLayer(opacity), id: rasterId, source: sourceId }, beforeId);
    };

    // `isStyleLoaded` also waits for every source's tiles. Gating each overlay
    // on it loses concurrent mounts: the first idle handler adds a source and
    // makes it false again for the remaining handlers. The parent owns readiness.
    mount();

    return () => {
      if (map.getLayer(rasterId)) map.removeLayer(rasterId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
    };
    // `opacity` is deliberately not a dependency: the effect below applies it
    // without tearing the source down and refetching every tile.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, layerId, tileUrl, attribution, drawable, west, south, east, north, maxZoom, raised]);

  useEffect(() => {
    if (!map) return;
    const rasterId = eeLayerId(layerId);
    if (map.getLayer(rasterId)) map.setPaintProperty(rasterId, 'raster-opacity', opacity);
  }, [map, layerId, opacity]);

  if (!raised) return null;
  const sourceDate = data?.forecast
    ? `Forecast · ${data.forecast.valid.start.slice(0, 10)}–${data.forecast.valid.end.slice(0, 10)}`
    : data?.observed_at ? `Observed · ${data.observed_at.slice(0, 10)}`
    : !layer.dated ? 'Static source'
    : data?.window ? `Window · ${data.window.start.slice(0, 10)}–${data.window.end.slice(0, 10)}`
    : `Saved · ${data?.date ?? 'date unavailable'}`;
  const note = error ? 'Unavailable · see layer details'
    : data?.tile_access === 'requires_auth' ? 'Unavailable · source requires authentication'
    : !data ? 'Loading source…'
    : !drawable ? 'Unavailable · source metadata incomplete'
    : `${sourceDate}${data.cache_stale ? ' · saved cache' : ''}`;
  return <StackedRaster layer={layer} tileUrl={drawable ? tileUrl : undefined}
    bounds={bounds as StackRect} maxZoom={maxZoom} opacity={opacity} level={level} count={count}
    note={note} attribution={attribution} />;
}

/** Every active live raster overlay. Static layers are drawn elsewhere. */
export function EeLayers({ layers }: { layers: MapLayerMeta[] }) {
  const active = useFloodLayers((s) => s.active);
  const ordered = [...layers].sort((a, b) => active.indexOf(a.layer_id) - active.indexOf(b.layer_id));
  const skyLayers = ordered.filter((layer) => isSkyLayer(layer.layer_id));
  return (
    <>
      {ordered.map((layer) => (
        <EeLayer key={layer.layer_id} layer={layer} level={skyLayers.indexOf(layer) + 1} count={skyLayers.length} />
      ))}
    </>
  );
}
