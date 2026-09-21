import { create } from 'zustand';
import type { Map as MaplibreMap } from 'maplibre-gl';

/**
 * Holds the live MapLibre instance and a snapshot of what it is currently
 * looking at, so HUD overlays (edge coordinate ticks, cursor readout, scale
 * rule) can derive real values instead of hardcoding them.
 *
 * Before this store, the instance was reachable only through `window.__map` —
 * a devtools escape hatch. Overlays that depend on it are product surface, so
 * they get a real subscription rather than a global.
 *
 * `view` is written from a `move` handler coalesced through
 * requestAnimationFrame: `moveend` alone makes the ticks visibly lag the pan.
 */

export interface MapView {
  west: number;
  east: number;
  south: number;
  north: number;
  zoom: number;
  /**
   * Metres per screen pixel at the map centre.
   *
   * Under pitch this is the scale AT THE CENTRE and nowhere else — the ground
   * stretches away from the camera, so no single number describes the frame.
   * The readout says so rather than implying it holds everywhere.
   */
  metresPerPixel: number;
  /** Camera tilt in degrees. 0 is straight down. */
  pitch: number;
  /** Canvas size in CSS px, needed to project the graticule onto the frame. */
  size: { width: number; height: number };
}

interface MapInstanceState {
  map: MaplibreMap | null;
  view: MapView | null;
  /** null whenever the pointer is outside the canvas. */
  cursor: { lon: number; lat: number } | null;
  setMap: (map: MaplibreMap | null) => void;
  setView: (view: MapView | null) => void;
  setCursor: (cursor: { lon: number; lat: number } | null) => void;
}

export const useMapInstance = create<MapInstanceState>((set) => ({
  map: null,
  view: null,
  cursor: null,
  setMap: (map) => set({ map }),
  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
}));

/** Read the current view off a map instance. */
export function readView(map: MaplibreMap): MapView {
  const b = map.getBounds();
  const zoom = map.getZoom();
  const lat = map.getCenter().lat;
  const canvas = map.getCanvas();
  const width = canvas.clientWidth || 1;
  const height = canvas.clientHeight || 1;

  // Web Mercator ground resolution at the centre latitude and zoom.
  //
  // Deliberately NOT measured with unproject(), which looks like the more
  // rigorous choice and is wrong here: with terrain enabled unproject returns
  // where the ray meets the terrain MESH, so at high vertical exaggeration two
  // pixels either side of centre can strike almost the same point on a steep
  // face. Measured that way, a z15 view reported 0.2 m/px against a true 4.
  // MapLibre defines zoom by the scale at the map centre, so the closed form is
  // exactly right there under any pitch — it is a horizontal ground scale, and
  // stays one.
  const metresPerPixel =
    (156543.03392 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);

  return {
    west: b.getWest(),
    east: b.getEast(),
    south: b.getSouth(),
    north: b.getNorth(),
    zoom,
    metresPerPixel,
    pitch: map.getPitch(),
    size: { width, height },
  };
}
