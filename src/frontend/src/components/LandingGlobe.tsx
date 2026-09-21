import { useEffect, useRef, useState } from 'react';
import { Map as GlobeMap } from 'maplibre-gl';
import { terrainSource } from './map/terrainLayer';

// Keep the camera within Southeast Asia throughout the page.
const places = [
  { name: 'MALAYSIA', longitude: 101.69, latitude: 4.21 },
  { name: 'THAILAND', longitude: 100.99, latitude: 15.87 },
  { name: 'MYANMAR', longitude: 95.96, latitude: 21.91 },
  { name: 'LAOS', longitude: 102.5, latitude: 18 },
  { name: 'CAMBODIA', longitude: 104.99, latitude: 12.57 },
  { name: 'VIETNAM', longitude: 108.28, latitude: 14.06 },
  { name: 'PHILIPPINES', longitude: 122, latitude: 12.88 },
  { name: 'BRUNEI', longitude: 114.73, latitude: 4.53 },
  { name: 'INDONESIA', longitude: 117, latitude: -2.5 },
  { name: 'SINGAPORE', longitude: 103.82, latitude: 1.35 },
  { name: 'MALAYSIA', longitude: 101.69, latitude: 4.21 },
];

export function LandingGlobe() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [placeIndex, setPlaceIndex] = useState(0);

  useEffect(() => {
    const container = containerRef.current;
    const track = container?.closest<HTMLElement>('.landing');
    if (!container || !track) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let map: GlobeMap;
    try {
      // MapLibre returns a partial map when WebGL is unavailable; check first.
      const context = document.createElement('canvas').getContext('webgl2');
      if (!context) throw new Error('WebGL2 unavailable');
      context.getExtension('WEBGL_lose_context')?.loseContext();
      map = new GlobeMap({
        container, interactive: false, attributionControl: false,
        canvasContextAttributes: { alpha: true, antialias: true },
        center: [places[0].longitude, places[0].latitude], zoom: 1,
        style: {
          version: 8,
          projection: { type: 'globe' },
          sources: { countries: { type: 'geojson', data: '/brand/world-countries.geojson' } },
          layers: [
            { id: 'ocean', type: 'background', paint: { 'background-color': '#e4e3e1' } },
            { id: 'land', type: 'fill', source: 'countries', paint: { 'fill-color': '#faf9f5', 'fill-outline-color': '#d4d2cd' } },
            { id: 'coast', type: 'line', source: 'countries', paint: { 'line-color': '#ffffff', 'line-width': .65, 'line-opacity': .8 } },
          ],
        },
      });
    } catch {
      // WebGL can be disabled; the original artwork remains a usable fallback.
      track.classList.add('landing-globe-unavailable');
      return () => track.classList.remove('landing-globe-unavailable');
    }
    map.getCanvas().tabIndex = -1;
    let frame = 0;
    let progress = 0;
    let previousProgress = -1;
    const update = () => {
      frame = 0;
      if (document.documentElement.classList.contains('entering-platform') || track.classList.contains('landing-globe-unavailable')) return;
      const heroHeight = track.querySelector<HTMLElement>('.landing-hero')!.offsetHeight;
      const distance = Math.max(1, track.offsetHeight - window.innerHeight);
      const target = motion.matches ? 0 : Math.max(0, Math.min(1, -track.getBoundingClientRect().top / distance));
      progress = motion.matches || Math.abs(target - progress) < .001 ? target : progress + (target - progress) * .16;
      if (Math.abs(progress - previousProgress) < .0001) return;
      previousProgress = progress;
      const position = progress * (places.length - 1);
      const index = Math.min(Math.floor(position), places.length - 2);
      const from = places[index];
      const to = places[index + 1];
      const fraction = position - index;
      const latitude = from.latitude + (to.latitude - from.latitude) * fraction;
      map.jumpTo({
        center: [from.longitude + (to.longitude - from.longitude) * fraction, latitude],
        // Compensate for latitude so the sphere keeps the same apparent size.
        zoom: Math.log2(container.clientWidth / 117.5) + Math.log2(Math.cos(latitude * Math.PI / 180)),
      });
      track.style.setProperty('--globe-progress', String(progress));
      track.style.setProperty('--globe-fade', String(Math.min(1, progress * distance / (heroHeight * .9))));
      setPlaceIndex(Math.round(position));
      if (progress !== target) schedule();
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(() => { map.resize(); previousProgress = -1; schedule(); });
    resize.observe(container);
    resize.observe(track);
    map.on('load', () => {
      setReady(true);
      map.addSource('relief', { ...terrainSource, maxzoom: 3 });
      map.addLayer({ id: 'relief', type: 'hillshade', source: 'relief', paint: {
        'hillshade-exaggeration': .8,
        'hillshade-shadow-color': '#a5a39e',
        'hillshade-highlight-color': '#ffffff',
        'hillshade-accent-color': '#eeede9',
        'hillshade-illumination-direction': 315,
      } }, 'coast');
      previousProgress = -1;
      schedule();
    });
    map.on('error', (event) => {
      if ('sourceId' in event && event.sourceId === 'countries') {
        setReady(false);
        track.classList.add('landing-globe-unavailable');
      }
    });
    window.addEventListener('scroll', schedule, { passive: true });
    motion.addEventListener('change', schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      window.removeEventListener('scroll', schedule);
      motion.removeEventListener('change', schedule);
      track.classList.remove('landing-globe-unavailable');
      map.remove();
    };
  }, []);

  return <div className="landing-globe-backdrop" aria-hidden="true">
    <div className={`landing-earth${ready ? ' landing-earth-ready' : ''}`} aria-hidden="true">
      <img src="/brand/earth-relief.png" alt="" width="1254" height="1254" fetchPriority="high" />
      <div className="landing-globe-map" style={{ position: 'absolute' }} ref={containerRef} />
      <div className="landing-globe-shading" />
    </div>
    <div className="landing-location" aria-hidden="true">
      <span className="landing-location-point" />
      <span className="landing-country">{places[placeIndex].name}<small>ASEAN · SOUTHEAST ASIA</small></span>
    </div>
  </div>;
}
