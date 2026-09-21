import { useEffect, useRef, useState } from 'react';
import { Map as MaplibreMap, Marker, type GeoJSONSource } from 'maplibre-gl';
import { animate, useReducedMotion } from 'motion/react';
import type { FeatureCollection } from 'geojson';
import { ALERT, ACCENT } from '../../lib/colors';
import { BASEMAP_STYLE_URL } from '../map/basemap';

/**
 * Where the proposed crew is RIGHT NOW, and the site it has to reach.
 *
 * The approval panel could name both ends in words — "at Seremban depot",
 * "39 km" — but a planner deciding whether to displace booked work is really
 * asking a geographic question: is this crew next door or across the state?
 * Two numbers cannot answer that; a picture can.
 *
 * THE LINE IS A CONNECTOR, NOT A ROUTE, AND THAT IS LOAD-BEARING.
 *
 * The road matrix stores distance and duration, never the polyline — one
 * Dijkstra per depot answers "how far" without ever materialising "which
 * roads". So a solid line traced between these two points would assert a path
 * the system cannot back up, on the one screen whose job is to be checkable.
 * It is drawn dashed for the same reason lib/route.ts draws dashed, and the
 * caption says outright that the distance beside it is the road figure while
 * the line is not the road.
 *
 * Third MapLibre instance in the app, and silent like the second: it never
 * touches useMapInstance, which feeds the Overview's graticule, scale rule and
 * cursor readout. A panel this size publishing its own view would make those
 * describe a 150px box instead of the console.
 */

const LINE_SOURCE = 'dispatch-connector';
const LINE_LAYER = 'dispatch-connector-line';

/** One loop of the travelling token, in ms. Slow enough to read as a journey. */
const TRAVEL_MS = 2600;

export interface DispatchRoutePreviewProps {
  from: { lon: number; lat: number; label: string };
  to: { lon: number; lat: number; label: string };
  /** Road km when measured, great-circle estimate otherwise. */
  distanceKm: number;
  etaMin: number;
  /** True when both figures came from the road matrix. */
  measured: boolean;
}

function connectorGeoJSON(
  from: { lon: number; lat: number },
  to: { lon: number; lat: number },
): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'LineString',
          coordinates: [
            [from.lon, from.lat],
            [to.lon, to.lat],
          ],
        },
      },
    ],
  };
}

function dot(color: string, ring: boolean): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `width:11px;height:11px;border-radius:9999px;background:${color};
    border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);`;
  if (ring) el.className = 'route-pulse';
  return el;
}

export function DispatchRoutePreview({
  from,
  to,
  distanceKm,
  etaMin,
  measured,
}: DispatchRoutePreviewProps) {
  const holder = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const tokenRef = useRef<Marker | null>(null);
  const [ready, setReady] = useState(false);
  const shouldReduceMotion = useReducedMotion();

  // Read the endpoints through refs inside the effect below, so its dependency
  // array can list the COORDINATES rather than the objects. The panel rebuilds
  // `from`/`to` on every render, so depending on the objects would tear down
  // and rebuild three markers — and restart the travel loop — on renders where
  // nothing geographic moved. Same reasoning as RouteMap's routeKey.
  const fromRef = useRef(from);
  fromRef.current = from;
  const toRef = useRef(to);
  toRef.current = to;

  useEffect(() => {
    if (!holder.current || mapRef.current) return;
    const map = new MaplibreMap({
      container: holder.current,
      style: BASEMAP_STYLE_URL,
      center: [from.lon, from.lat],
      zoom: 7,
      // Non-interactive for the same reason RouteMap is: this answers "where
      // is this crew going", not "explore the region". It also keeps the
      // fitted bounds true, so the distance printed underneath always
      // describes exactly what is on screen.
      interactive: false,
      attributionControl: false,
    });
    map.on('load', () => {
      map.addSource(LINE_SOURCE, { type: 'geojson', data: connectorGeoJSON(from, to) });
      map.addLayer({
        id: LINE_LAYER,
        type: 'line',
        source: LINE_SOURCE,
        layout: { 'line-cap': 'round' },
        paint: {
          'line-color': ACCENT,
          'line-width': 2,
          'line-opacity': 0.75,
          // Dashed: see the component doc. A solid line would claim a path.
          'line-dasharray': [2, 2],
        },
      });
      setReady(true);
    });
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // Mount once; the effect below moves everything when the props change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Geometry, markers and framing follow the selected crew.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const a = fromRef.current;
    const b = toRef.current;

    const src = map.getSource(LINE_SOURCE);
    if (src && 'setData' in src) (src as GeoJSONSource).setData(connectorGeoJSON(a, b));

    const markers = [
      new Marker({ element: dot(ACCENT, false) }).setLngLat([a.lon, a.lat]).addTo(map),
      new Marker({ element: dot(ALERT, true) }).setLngLat([b.lon, b.lat]).addTo(map),
    ];

    const token = document.createElement('div');
    token.setAttribute('aria-hidden', 'true');
    token.style.cssText = `width:9px;height:9px;border-radius:9999px;background:#fff;
      border:2px solid ${ACCENT};box-shadow:0 0 0 3px ${ACCENT}33;`;
    const travelling = new Marker({ element: token }).setLngLat([a.lon, a.lat]).addTo(map);
    tokenRef.current = travelling;

    map.fitBounds(
      [
        [Math.min(a.lon, b.lon), Math.min(a.lat, b.lat)],
        [Math.max(a.lon, b.lon), Math.max(a.lat, b.lat)],
      ],
      { padding: 34, duration: 400, maxZoom: 11 },
    );

    // ONE animated element, which is the whole budget this view should spend
    // (excessive-motion: 1-2 per view; the destination's route-pulse is the
    // other). It carries a cause-effect meaning rather than decoration —
    // "this crew leaves HERE and arrives THERE" — which is the thing the
    // static labels could not say.
    let stop: (() => void) | undefined;
    if (shouldReduceMotion) {
      // Not merely slower: no travel at all. The token parks at the midpoint
      // so the direction is still legible from the two coloured ends, and
      // every figure is in the caption regardless.
      travelling.setLngLat([(a.lon + b.lon) / 2, (a.lat + b.lat) / 2]);
    } else {
      const controls = animate(0, 1, {
        duration: TRAVEL_MS / 1000,
        repeat: Infinity,
        // A journey restarts at the origin; it does not reverse into it.
        repeatType: 'loop',
        ease: 'easeInOut',
        onUpdate: (t) => {
          travelling.setLngLat([a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t]);
        },
      });
      stop = () => controls.stop();
    }

    return () => {
      stop?.();
      markers.forEach((m) => m.remove());
      travelling.remove();
      tokenRef.current = null;
    };
  }, [ready, from.lon, from.lat, to.lon, to.lat, shouldReduceMotion]);

  return (
    <figure className="m-0">
      <div
        ref={holder}
        className="h-[150px] w-full overflow-hidden rounded-lg border border-overlay/10"
        role="img"
        aria-label={`Crew ${from.label}; site ${to.label}. ${distanceKm.toFixed(0)} kilometres, about ${etaMin} minutes by road.`}
      />
      <figcaption className="mt-1.5 space-y-0.5">
        <div className="flex items-center gap-1.5 text-micro">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: ACCENT }} />
          <span className="truncate text-muted">{from.label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-micro">
          <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: ALERT }} />
          <span className="truncate text-alert-ink">{to.label}</span>
        </div>
        {/* The honesty line. The figure is the road network's; the line on the
            map is not, and saying so costs one sentence. */}
        <p className="pt-0.5 text-eyebrow leading-relaxed text-dim">
          <span className="tnum">{distanceKm.toFixed(0)} km</span> ·{' '}
          <span className="tnum">{etaMin} min</span>{' '}
          {measured ? 'by road' : 'estimated'} — the dashed line joins the two points, it is
          not the route driven.
        </p>
      </figcaption>
    </figure>
  );
}
