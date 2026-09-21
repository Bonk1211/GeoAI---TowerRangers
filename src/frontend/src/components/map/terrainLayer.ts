import type { HillshadeLayerSpecification, RasterDEMSourceSpecification } from 'maplibre-gl';

/**
 * Elevation relief.
 *
 * This is the one piece of "3D" on the map that is not decoration: `terrain` is
 * one of the four factors the model scores, and until now the map asserted that
 * terrain drives ~18% of risk while drawing a perfectly flat world. Hillshade
 * makes that factor legible — a highland tower looks like a highland tower.
 *
 * Hillshade rather than `setTerrain`: real 3D terrain only reads under a pitched
 * camera, and pitching would invalidate two things that assume a top-down view —
 * the graticule's edge ticks and the scale bar's metresPerPixel, both derived in
 * lib/graticule.ts. Relief shading gives the elevation read with the camera flat,
 * so no readout on the screen starts lying.
 */

export const TERRAIN_SOURCE_ID = 'terrain-dem';
export const HILLSHADE_LAYER_ID = 'hillshade-layer';

/**
 * AWS Terrain Tiles (Mapzen terrarium encoding). Keyless and public, verified
 * serving over Malaysia at both regional and AOI zoom.
 *
 * maxzoom 13 is the dataset's own limit, not a style choice — MapLibre
 * overzooms past it rather than requesting tiles that would 404.
 */
export const terrainSource: RasterDEMSourceSpecification = {
  type: 'raster-dem',
  tiles: ['https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'],
  encoding: 'terrarium',
  tileSize: 256,
  maxzoom: 13,
  attribution:
    '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Tilezen Joerd</a>',
};

export const hillshadeLayer: Omit<HillshadeLayerSpecification, 'id' | 'source'> = {
  type: 'hillshade',
  paint: {
    // Shadow carries the relief; highlight is kept very low because the ground
    // is near-black and a bright highlight would read as haze rather than as a
    // lit slope. Accent is neutralised for the same reason — the default is a
    // blue cast that would put a second cool hue on a screen where the cool
    // accent already means "interface chrome".
    // LIGHT THEME: relief inverts. On Dark Matter the shadow was near-black and
    // the highlight had to be lifted to #6b7a99 to be seen at all. On Positron
    // the tiles ARE the highlight, so the shading is carried entirely by the
    // shadow, and the highlight is pulled to white so ridges read as light
    // rather than as a grey film over the basemap.
    'hillshade-shadow-color': '#5d6880',
    'hillshade-highlight-color': '#ffffff',
    // Still neutralised: MapLibre's default accent is a blue cast, and the cool
    // accent already means "interface chrome" on this screen.
    'hillshade-accent-color': '#e9eef6',
    'hillshade-illumination-direction': 315,

    /**
     * Strongest at regional zoom, gone by the time you reach the AOI.
     *
     * This is deliberately the inverse of the tower icons' zoom gate. Relief is
     * informative where the Titiwangsa range is — z6-z10, where the terrain
     * factor actually varies — and is nothing but noise over the Klang Valley
     * lowland at z12+, where it would sit underneath the densest cluster of
     * towers and compete with the band colours for the same pixels.
     */
    'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 6, 0.55, 10, 0.34, 12.5, 0],
  },
};
