import type { RasterLayerSpecification, RasterSourceSpecification } from 'maplibre-gl';
import type { LayerBounds } from '../../api/types';

/**
 * Earth Engine overlays as ordinary XYZ raster tiles.
 *
 * This is the whole reason the map did not need replacing to show live flood
 * imagery: Earth Engine hands back a `{z}/{x}/{y}` template from getMapId, which
 * is the same shape as the CARTO basemap and the Tilezen DEM already in this
 * style. Nothing about the camera, the graticule or the projection changes.
 *
 * Two properties of that template drive the code around it. The map id expires
 * after roughly an hour, so the source is rebuilt rather than assumed permanent
 * — see useLayerTilesQuery's refetch interval. And whether the browser may fetch
 * those tiles without credentials depends on the Earth Engine project's setup;
 * the backend probes one tile and reports `tile_access`, because a 403 here
 * renders an empty layer and fires no error the console will show.
 */

const PREFIX = 'ee-';

/** Only atmospheric measurements are raised; flood forecasts describe ground water. */
export function isSkyLayer(layerId: string): boolean {
  return layerId === 'precipitation' || layerId === 'forecast_rainfall_24h';
}

export function eeSourceId(layerId: string): string {
  return `${PREFIX}${layerId}-src`;
}

export function eeLayerId(layerId: string): string {
  return `${PREFIX}${layerId}`;
}

/** True for any layer id this module owns, used when reconciling the map. */
export function isEeLayerId(id: string): boolean {
  return id.startsWith(PREFIX);
}

export function eeRasterSource(
  tileUrl: string,
  attribution: string,
  bounds?: LayerBounds,
  maxZoom = 8,
): RasterSourceSpecification {
  return {
    type: 'raster',
    tiles: [tileUrl],
    tileSize: 256,
    // Deeper camera zooms magnify the saved image without asking for new tiles.
    maxzoom: maxZoom,
    attribution,
    ...(bounds ? { bounds } : {}),
  };
}

export function eeRasterLayer(opacity: number): Omit<RasterLayerSpecification, 'id' | 'source'> {
  return {
    type: 'raster',
    paint: {
      'raster-opacity': opacity,
      // Same reasoning as the inundation layer: the default cross-fade dissolves
      // one date into the next, which reads as water moving. These are discrete
      // observations days apart, so they snap.
      'raster-fade-duration': 0,
    },
  };
}
