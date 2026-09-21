import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Map as MaplibreMap } from 'maplibre-gl';
import type { LayerTiles, MapLayerMeta, PowerStationResult, Tower } from '../../api/types';
import { useFloodLayersQuery, useLandLayersQuery, useLayerTilesQuery, usePowerStationQuery } from '../../api/queries';
import { useFloodLayers } from '../../state/useFloodLayers';
import { useMapInstance } from '../../state/useMapInstance';
import { surroundingsReading, switchRainLayer, withinLayer } from '../../lib/surroundings';
import { BASEMAP_STYLE_URL, groundAnchor } from '../map/basemap';
import { eeRasterLayer, eeRasterSource } from '../map/eeLayer';

type Station = NonNullable<PowerStationResult['station']>;

/** Small, noninteractive maps; the main map remains the only published map instance. */
function LayerPreview({ tower, tiles, station, status }: {
  tower: Tower; tiles?: LayerTiles; station?: Station; status?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState(false);
  const [ready, setReady] = useState(false);
  const { lon, lat } = tower;
  const tileUrl = tiles?.tile_url;
  const west = tiles?.bounds?.[0], south = tiles?.bounds?.[1];
  const east = tiles?.bounds?.[2], north = tiles?.bounds?.[3];
  const maxZoom = tiles?.max_zoom ?? 8;
  const stationLon = station?.lon, stationLat = station?.lat;

  useEffect(() => {
    if (!container.current) return;
    setMapError(false);
    setReady(false);
    const map = new MaplibreMap({
      container: container.current, style: BASEMAP_STYLE_URL, center: [lon, lat], zoom: 10,
      interactive: false, attributionControl: false, renderWorldCopies: false,
    });
    map.on('error', () => setMapError(true));
    map.on('load', () => {
      if (tileUrl) {
        const bounds = west === undefined ? undefined : [west, south!, east!, north!] as [number, number, number, number];
        map.addSource('imagery', eeRasterSource(tileUrl, '', bounds, maxZoom));
        map.addLayer({ ...eeRasterLayer(0.85), id: 'imagery', source: 'imagery' }, groundAnchor(map));
      }
      map.addSource('site', { type: 'geojson', data: {
        type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [lon, lat] },
      } });
      if (stationLon !== undefined && stationLat !== undefined) {
        map.fitBounds([[Math.min(lon, stationLon), Math.min(lat, stationLat)],
          [Math.max(lon, stationLon), Math.max(lat, stationLat)]], { padding: 26, maxZoom: 14, duration: 0 });
        map.addSource('connection', { type: 'geojson', data: {
          type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[lon, lat], [stationLon, stationLat]] },
        } });
        map.addLayer({ id: 'connection', type: 'line', source: 'connection',
          paint: { 'line-color': '#a16207', 'line-width': 2, 'line-dasharray': [2, 2] } });
        map.addSource('station', { type: 'geojson', data: {
          type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [stationLon, stationLat] },
        } });
        map.addLayer({ id: 'station', type: 'circle', source: 'station',
          paint: { 'circle-radius': 5, 'circle-color': '#a16207', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
      }
      map.addLayer({ id: 'site', type: 'circle', source: 'site', paint: {
        'circle-radius': 5, 'circle-color': '#7c3aed', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2,
      } });
      setReady(true);
    });
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(container.current);
    return () => { resize.disconnect(); map.remove(); };
  }, [lon, lat, tileUrl, west, south, east, north, maxZoom, stationLon, stationLat]);

  const message = status || (mapError ? 'Map unavailable' : !ready ? 'Loading map…' : '');
  return <div className="relative h-[160px] shrink-0 overflow-hidden bg-ink-800" aria-hidden="true">
    <div ref={container} className="pointer-events-none h-full w-full" />
    {message ? <div className="absolute inset-0 flex items-center justify-center bg-ink-900/80 px-3 text-center text-micro text-muted">{message}</div>
      : <span className="absolute left-2 top-2 rounded bg-ink-900/95 px-1.5 py-0.5 text-[10px] font-medium text-accent shadow-sm">● Tower</span>}
  </div>;
}

function SurroundingsCard({ tower, title, layerId, available, station, children }: {
  tower: Tower; title: string; layerId: string; available: boolean; station?: Station; children: ReactNode;
}) {
  const active = useFloodLayers((s) => s.active.includes(layerId));
  const toggleLayer = useFloodLayers((s) => s.toggleLayer);
  const map = useMapInstance((s) => s.map);
  const toggle = () => {
    toggleLayer(layerId);
    if (active || !map) return;
    const { width, height } = map.getCanvas().getBoundingClientRect();
    map.fitBounds([[Math.min(tower.lon, station?.lon ?? tower.lon) - 0.006, Math.min(tower.lat, station?.lat ?? tower.lat) - 0.006],
      [Math.max(tower.lon, station?.lon ?? tower.lon) + 0.006, Math.max(tower.lat, station?.lat ?? tower.lat) + 0.006]], {
      padding: { left: Math.min(340, width * 0.25), right: Math.min(492, width * 0.35),
        top: Math.min(130, height * 0.2), bottom: Math.min(200, height * 0.25) }, maxZoom: 12, duration: 700,
    });
  };
  return <button type="button" onClick={toggle} aria-label={`${title} layer`} aria-pressed={active}
    aria-describedby={`surroundings-${layerId}-reading`}
    disabled={!available && !active}
    className={`group flex min-w-0 flex-col overflow-hidden rounded-xl border bg-ink-900 text-left transition-colors disabled:cursor-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&>*]:w-full ${active ? 'border-accent ring-1 ring-accent/25' : 'border-overlay/15 enabled:hover:border-accent/60'}`}>
    <span className="flex items-center justify-between gap-1 px-2.5 py-2 text-ui font-semibold text-fg">
      {title}<span className={`text-[10px] font-medium ${active ? 'text-accent' : 'text-dim'}`}>{active ? 'On map' : available ? 'View ↗' : 'No data'}</span>
    </span>
    {children}
  </button>;
}

function RasterCard({ tower, layer, title }: { tower: Tower; layer: MapLayerMeta; title: string }) {
  const date = useFloodLayers((s) => s.date);
  const sensor = useFloodLayers((s) => s.sensor);
  const { data, error, isPending } = useLayerTilesQuery(layer.group, layer.layer_id, date, true,
    layer.temporal_kind, layer.sensors.length ? sensor : undefined);
  const covered = withinLayer(tower, data?.bounds ?? data?.forecast?.bounds ?? layer.bounds ?? undefined);
  const available = Boolean(data?.tile_url) && !error && covered && data?.tile_access !== 'requires_auth'
    && (layer.temporal_kind !== 'forecast' || Boolean(data?.forecast));
  const status = isPending ? 'Loading imagery…' : !covered ? 'Outside saved coverage'
    : !available ? 'Imagery unavailable' : undefined;
  const reading = available ? surroundingsReading(layer.layer_id, data, tower.weather) : null;
  const flood = layer.layer_id === 'flood_extent';
  const soil = layer.layer_id === 'soil_moisture';
  const value = flood ? (typeof tower.hand_m === 'number' ? `${tower.hand_m.toFixed(1)} m` : '—')
    : reading === null ? '—' : soil ? `${reading.toFixed(2)} m³/m³` : `${reading.toFixed(1)} mm`;
  const caption = flood ? 'above nearest drainage' : soil ? 'regional soil moisture' : 'rainfall over 24 hours';
  const sourceDate = data?.forecast ? `Forecast ${data.forecast.valid.start.slice(0, 10)} → ${data.forecast.valid.end.slice(0, 10)}`
    : data?.observed_at ? `Observed ${data.observed_at.slice(0, 10)}`
    : data?.window ? `Window to ${data.window.end.slice(0, 10)}` : 'Source date unavailable';
  return <SurroundingsCard tower={tower} title={title} layerId={layer.layer_id} available={available}>
    <LayerPreview tower={tower} tiles={available ? data : undefined} status={status} />
    <div id={`surroundings-${layer.layer_id}-reading`} className="space-y-1.5 px-2.5 py-2">
      {status && <span className="sr-only">{status}.</span>}
      {!flood && reading === null && <span className="sr-only">Site reading unavailable.</span>}
      <div><p className="text-lead font-semibold leading-tight tnum text-fg">{value}</p>
        <p className="text-micro text-muted">{caption}</p></div>
      <div aria-label={`${title} legend`}>
        <div className="flex h-1.5 overflow-hidden rounded-full">{layer.legend.map((item) =>
          <span key={item.label} className="flex-1" style={{ backgroundColor: item.color }} />)}</div>
        <div className="mt-0.5 flex justify-between gap-1 text-[10px] text-muted">
          <span>{layer.legend[0]?.label}</span><span className="text-right">{layer.legend.at(-1)?.label}</span>
        </div>
      </div>
      <p className="text-[10px] leading-snug text-dim">{sourceDate}{data?.cache_stale ? ' · saved' : ''}</p>
    </div>
  </SurroundingsCard>;
}

function PowerCard({ tower }: { tower: Tower }) {
  const { data, isPending, error } = usePowerStationQuery(tower.tower_id);
  const station = !error && data?.status === 'available' ? data.station ?? undefined : undefined;
  const distance = station ? station.distance_m < 1000 ? `${Math.round(station.distance_m)} m`
    : `${(station.distance_m / 1000).toFixed(1)} km` : '—';
  return <SurroundingsCard tower={tower} title="Power station" layerId="power_station" available={Boolean(station)} station={station}>
    <LayerPreview tower={tower} station={station} status={isPending ? 'Finding station…' : !station ? 'Station data unavailable' : undefined} />
    <div id="surroundings-power_station-reading" className="space-y-1.5 px-2.5 py-2">
      <div><p className="text-lead font-semibold leading-tight tnum text-fg">{distance}</p>
        <p className="text-micro text-muted">straight-line distance</p></div>
      <p className="line-clamp-2 min-h-7 text-micro text-fg">{station?.name || (station?.kind === 'plant' ? 'Mapped power plant' : station ? 'Mapped substation' : isPending ? 'Finding station…' : 'Station data unavailable')}</p>
      <p className="text-[10px] leading-snug text-dim">{data?.source_updated_at ? `OSM snapshot ${data.source_updated_at.slice(0, 10)}` : 'Source date unavailable'}</p>
      <p className="text-[10px] leading-snug text-dim">Nearest in saved coverage; supply connection unverified.</p>
    </div>
  </SurroundingsCard>;
}

export function SiteSurroundings({ tower }: { tower: Tower }) {
  const { data: flood } = useFloodLayersQuery();
  const { data: land } = useLandLayersQuery();
  const latest = useFloodLayers((s) => s.followLatest);
  const rainId = latest ? 'forecast_rainfall_24h' : 'precipitation';
  const previousRain = useRef(rainId);
  useEffect(() => {
    const previous = previousRain.current;
    previousRain.current = rainId;
    if (previous !== rainId) useFloodLayers.setState((s) => ({ active: switchRainLayer(s.active, previous, rainId) }));
  }, [rainId]);
  const layers = [flood?.layers.find((l) => l.layer_id === 'flood_extent'),
    flood?.layers.find((l) => l.layer_id === rainId), land?.layers.find((l) => l.layer_id === 'soil_moisture')];
  return <section className="border-t border-overlay/[0.09] px-3 py-3" aria-label="Site surroundings">
    <div className="mb-2.5 flex items-baseline justify-between gap-2">
      <h3 className="eyebrow">Site surroundings</h3><span className="text-micro text-dim">Select a card to explore</span>
    </div>
    <div className="grid grid-cols-2 items-stretch gap-2">
      {layers.map((layer, i) => layer ? <RasterCard key={layer.layer_id} tower={tower} layer={layer} title={['Flood', 'Rainfall', 'Soil'][i]} />
        : <div key={i} className="flex min-h-52 items-center justify-center rounded-xl border border-overlay/15 text-micro text-dim">Loading {['flood', 'rainfall', 'soil'][i]}…</div>)}
      <PowerCard tower={tower} />
    </div>
    <p className="mt-2 text-[10px] leading-snug text-dim">
      Map © OpenStreetMap / OpenFreeMap · Imagery: {latest ? 'GFS' : 'GSMaP'}, SMAP, Copernicus / USGS. Source dates shown per card.
    </p>
  </section>;
}
