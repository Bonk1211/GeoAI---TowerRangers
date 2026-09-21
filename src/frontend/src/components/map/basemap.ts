import type { Map as MaplibreMap } from 'maplibre-gl';

/** Shared vector basemap: labels remain above imagery and attribution stays intact. */
export const BASEMAP_STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';

export const BASEMAP_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; OpenFreeMap';

/** Mainland and maritime Southeast Asia, including Timor-Leste. */
export const SOUTHEAST_ASIA_BBOX = [92, -11.5, 142, 29] as const;

/** Peninsular Malaysia, Sarawak and Sabah. */
export const MALAYSIA_BBOX = [99.5, 0.8, 119.8, 7.5] as const;

/** Style the geography itself so tower and imagery colours stay unwashed. */
export function applyBasemapStyle(map: MaplibreMap): void {
  const colors: Record<string, string> = {
    background: '#f6f4ef', water: '#dcecf1', park: '#e7ece2',
    landuse_residential: '#edede7', landcover_wood: '#e1e8dc',
    waterway: '#91bacb',
    highway_major_casing: '#c5beb1', highway_motorway_casing: '#bbb4a7',
    highway_motorway_bridge_casing: '#bbb4a7', tunnel_motorway_casing: '#c5beb1',
    highway_major_inner: '#fffaf0', highway_motorway_inner: '#fffaf0',
    highway_motorway_bridge_inner: '#fffaf0',
    highway_major_subtle: '#cec8bd', highway_motorway_subtle: '#c5bcaa',
    boundary_2: '#aab4bd', boundary_3: '#c1c9cd', boundary_disputed: '#aab4bd',
    label_other: '#68727d', label_village: '#68727d', label_town: '#576575',
    label_state: '#647181', label_city: '#425064', label_city_capital: '#354358',
    label_country_1: '#526174', label_country_2: '#526174', label_country_3: '#526174',
    'highway-name-path': '#68727d', 'highway-name-minor': '#68727d',
    waterway_line_label: '#426677', water_name_point_label: '#426677', water_name_line_label: '#426677',
  };
  for (const layer of map.getStyle().layers ?? []) {
    const color = colors[layer.id];
    if (!color) continue;
    if (layer.type === 'background' || layer.type === 'fill' || layer.type === 'line') {
      map.setPaintProperty(layer.id, `${layer.type}-color`, color);
    } else if (layer.type === 'symbol') {
      map.setPaintProperty(layer.id, 'text-color', color);
    }
    if (layer.id === 'waterway' && layer.type === 'line') {
      map.setPaintProperty(layer.id, 'line-width', ['interpolate', ['linear'], ['zoom'], 6, 0.5, 11, 1.2, 15, 2]);
    }
  }
}

/**
 * The layer our ground overlays should be inserted before.
 *
 * Everything that describes the ground — relief, inundation, flood hex, water
 * volume, Earth Engine rasters — belongs under the basemap's labels, so place
 * names stay legible through the water. Towers are not ground: they are the
 * reading this console exists for, and stay on top of everything.
 *
 * Resolved at runtime rather than hardcoded to `waterway_line_label`, because
 * the style is fetched from a third party and can be renumbered without
 * warning. A missing anchor returns undefined, which MapLibre treats as "append
 * on top" — the layer still draws, just above the labels.
 */
export function groundAnchor(map: MaplibreMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  return layers.find((l) => l.type === 'symbol')?.id;
}

/** Centre of the Sunway pilot AOI — every scored tower falls inside it. */
export const AOI_CENTER: [number, number] = [101.61, 3.07];
