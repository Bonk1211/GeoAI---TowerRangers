import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MaplibreMap, Marker, type GeoJSONSource } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { CREWS } from '../../fixtures/crews';
import { useScheduleStore } from '../../state/useScheduleStore';
import { useScheduleSelection } from '../../state/useScheduleSelection';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useCrewsQuery } from '../../api/queries';
import { bandColor, ACCENT } from '../../lib/colors';
import { buildRoute, routeBounds, type Route } from '../../lib/route';
import { dayLabel } from '../../lib/scheduleDays';
import { BASEMAP_STYLE_URL } from '../map/basemap';

/**
 * The selected crew-day, drawn.
 *
 * Deliberately NOT wired into useMapInstance. That store is a singleton feeding
 * the Overview's graticule, scale rule and cursor readout; a second map
 * publishing its own view into it would make those read this 200px panel
 * instead of the console.
 *
 * Non-interactive on purpose — this answers "where is this crew going", not
 * "explore the region". The Overview is where you explore. Keeping drag and
 * zoom off also means the fitted bounds stay true, so the distance figures
 * underneath always describe exactly what is on screen.
 */

const LEG_SOURCE = 'route-legs';
const LEG_LAYER = 'route-legs-line';

function legsGeoJSON(route: Route | null): FeatureCollection {
  if (!route) return { type: 'FeatureCollection', features: [] };
  const coords: [number, number][] = [
    [route.depot.lon, route.depot.lat],
    ...route.stops.map((s) => [s.lon, s.lat] as [number, number]),
  ];
  // A single stop still yields two points, so the line is always valid — which
  // matters, because 13 of the 14 offline fixture entries are single-stop.
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
    ],
  };
}

export function RouteMap() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const [ready, setReady] = useState(false);

  const selection = useScheduleStore((s) => s.selection);
  const run = useScheduleStore((s) => s.run);
  const hoveredTowerId = useScheduleSelection((s) => s.hoveredTowerId);
  const setHoveredTower = useScheduleSelection((s) => s.setHoveredTower);
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const crewsQuery = useCrewsQuery();

  const crews = crewsQuery.data ?? CREWS;

  // The route is drawn for the whole crew-day, not just the selected job — an
  // 'emergency' selection carries a tower_id but no crew_id yet, so it has no
  // crew-day to draw.
  const selectionCrewId = selection && 'crew_id' in selection ? selection.crew_id : null;
  const selectionDay = selection && 'crew_id' in selection ? selection.day : null;
  const crewDay = selectionCrewId && selectionDay ? { crew_id: selectionCrewId, day: selectionDay } : null;

  const route = useMemo(() => {
    if (!selectionCrewId || !selectionDay) return null;
    const crew = crews.find((c) => c.crew_id === selectionCrewId);
    if (!crew) return null;
    const entries = run.entries.filter((e) => e.crew_id === selectionCrewId && e.day === selectionDay);
    if (entries.length === 0) return null;
    return buildRoute(entries, crew, new Map(towers.map((t) => [t.tower_id, t])));
  }, [selectionCrewId, selectionDay, crews, run.entries, towers]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new MaplibreMap({
      container: containerRef.current,
      style: BASEMAP_STYLE_URL,
      center: [101.61, 3.07],
      zoom: 9,
      interactive: false,
      attributionControl: false,
    });
    mapRef.current = map;

    map.on('load', () => {
      map.addSource(LEG_SOURCE, { type: 'geojson', data: legsGeoJSON(null) });
      map.addLayer({
        id: LEG_LAYER,
        type: 'line',
        source: LEG_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        // Accent, not a band colour. A leg is chrome describing a path; only a
        // risk reading is allowed to be warm.
        paint: {
          'line-color': ACCENT,
          'line-width': 1.5,
          'line-opacity': 0.7,
          'line-dasharray': [2, 2],
        },
      });
      setReady(true);
    });

    return () => {
      markersRef.current.forEach((m) => m.remove());
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  /**
   * A stable identity for the route's *content*.
   *
   * useLiveTowers hands back a new `towers` array on every render, so the memo
   * above yields a structurally identical but referentially new Route each
   * time. Keying the effects below on the object would re-run fitBounds every
   * render and leave the map permanently mid-animation, and would tear down and
   * rebuild every marker under the user's cursor. Decision is in the key
   * because re-weighting recolours a stop without moving it.
   */
  // Read through a ref inside the effects below, so they depend only on
  // routeKey and the dependency array stays honest rather than suppressed.
  const routeRef = useRef(route);
  routeRef.current = route;

  const routeKey = route
    ? [
        crewDay?.crew_id,
        crewDay?.day,
        ...route.stops.map((s) => `${s.tower_id}:${s.decision ?? '-'}`),
      ].join('|')
    : '';

  // Legs + fitted bounds.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const current = routeRef.current;
    const source = map.getSource(LEG_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(legsGeoJSON(current));
    }
    if (current) {
      map.fitBounds(routeBounds(current), { padding: 26, duration: 350, maxZoom: 13 });
    }
  }, [routeKey, ready]);

  // Markers. Rebuilt wholesale rather than diffed — a route is at most a
  // handful of stops, and diffing DOM markers by tower id would cost more code
  // than it saves.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const current = routeRef.current;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    if (!current) return;

    const depotEl = document.createElement('div');
    depotEl.className = 'route-depot';
    depotEl.title = current.depot.name;
    markersRef.current.push(
      new Marker({ element: depotEl }).setLngLat([current.depot.lon, current.depot.lat]).addTo(map),
    );

    current.stops.forEach((stop) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'route-stop';
      el.textContent = String(stop.order);
      // tower_id, not placeName(): the fixture's place names are Kelantan towns
      // while every scored tower's coordinates fall in the Sunway AOI, so a
      // place name plotted here would contradict its own position.
      el.title = `${stop.tower_id} — ${stop.fromDepotKm.toFixed(1)} km from ${current.depot.name}`;
      el.style.setProperty(
        '--stop-color',
        stop.decision ? bandColor(stop.decision) : 'var(--color-unscored)',
      );
      el.dataset.towerId = stop.tower_id;
      el.addEventListener('mouseenter', () => setHoveredTower(stop.tower_id));
      el.addEventListener('mouseleave', () => setHoveredTower(null));
      markersRef.current.push(
        new Marker({ element: el }).setLngLat([stop.lon, stop.lat]).addTo(map),
      );
    });
  }, [routeKey, ready, setHoveredTower]);

  // Hover highlight, applied to existing marker elements so a pointer moving
  // across the grid does not tear down and rebuild every marker.
  useEffect(() => {
    markersRef.current.forEach((marker) => {
      const el = marker.getElement();
      if (!el.dataset.towerId) return;
      el.classList.toggle('is-hovered', el.dataset.towerId === hoveredTowerId);
    });
  }, [hoveredTowerId, routeKey]);

  return (
    <section className="shrink-0 border-b border-overlay/[0.08]" aria-label="Crew route">
      <div className="relative h-[200px] w-full bg-ink-950">
        <div ref={containerRef} className="h-full w-full" />
        {/* Same dim + vignette as the console, so this reads as one product.
            Both are pointer-events-none or they would swallow marker hovers. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-ink-900"
          style={{ opacity: 0.2 }}
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: 'radial-gradient(122% 92% at 50% 50%, transparent 50%, rgba(242,245,250,.9) 100%)',
          }}
        />
        {!route && (
          /* The empty state sits directly on the basemap with only the .20 wash
             between it and the tiles, where --color-dim measures 1.62:1 and is
             not readable. Rather than darken the copy until it shouts, it gets
             its own surface — which is also the honest reading, since this is a
             message about the panel rather than a label on the map. */
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
            <p className="max-w-[220px] rounded-lg border border-overlay/10 bg-ink-900/90 px-3 py-2 text-center text-micro leading-relaxed text-muted shadow-sm backdrop-blur-[2px]">
              {crewDay
                ? 'No visits scheduled for this crew-day.'
                : 'Select a scheduled slot to see its route.'}
            </p>
          </div>
        )}
      </div>

      {route && crewDay && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2.5">
          <span className="text-ui font-medium text-fg">{crewDay.crew_id}</span>
          <span className="text-micro text-dim">{dayLabel(crewDay.day)}</span>
          <span className="text-micro text-muted">
            {route.stops.length} {route.stops.length === 1 ? 'stop' : 'stops'}
          </span>
          <span className="font-mono text-micro tnum text-muted">{route.totalKm.toFixed(1)} km</span>
          {route.radiusUsePct !== null && (
            <span
              className="ml-auto flex items-center gap-1.5"
              // Straight-line distance measured against a road budget, so this
              // understates. Said plainly in the tooltip rather than dressed up
              // as a true utilisation figure.
              title={`Farthest stop is ${route.maxFromDepotKm.toFixed(1)} km from ${route.depot.name}, against a ${route.maxTravelKm} km limit. Straight-line distance, so real road travel is longer.`}
            >
              <span className="h-1 w-14 overflow-hidden rounded-full bg-overlay/10">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{ width: `${Math.min(100, route.radiusUsePct)}%` }}
                />
              </span>
              <span className="font-mono text-eyebrow tnum text-dim">
                {Math.round(route.radiusUsePct)}% of {route.maxTravelKm} km
              </span>
            </span>
          )}
        </div>
      )}
    </section>
  );
}
