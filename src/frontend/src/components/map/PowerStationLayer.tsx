import { useEffect } from 'react';
import { usePowerStationQuery } from '../../api/queries';
import { useLiveTower } from '../../api/useLiveTowers';
import { useMapInstance } from '../../state/useMapInstance';
import { useSelection } from '../../state/useSelection';
import { useWeights } from '../../state/useWeights';
import { TOWER_LAYER_ID } from './towerLayer';

const SOURCE_ID = 'power-station';
const LINE_ID = 'power-station-distance';
const POINT_ID = 'power-station-marker';
const LABEL_ID = 'power-station-label';

/** Mounted after the main map is ready; proximity does not imply a supply connection. */
export function PowerStationLayer() {
  const map = useMapInstance((s) => s.map);
  const towerId = useSelection((s) => s.selectedTowerId);
  const weights = useWeights((s) => s.weights);
  const tower = useLiveTower(towerId, weights);
  const { data, error } = usePowerStationQuery(towerId);
  const station = !error && data?.status === 'available' ? data.station : null;
  const lon = tower?.lon;
  const lat = tower?.lat;

  useEffect(() => {
    if (!map || !station || lon === undefined || lat === undefined) return;
    const distance = station.distance_m < 1000
      ? `${Math.round(station.distance_m)} m`
      : `${(station.distance_m / 1000).toFixed(1)} km`;
    const kind = station.kind === 'plant' ? 'Power plant' : 'Substation';
    map.addSource(SOURCE_ID, {
      type: 'geojson',
      attribution: '© OpenStreetMap contributors',
      data: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature', properties: {},
            geometry: { type: 'LineString', coordinates: [[lon, lat], [station.lon, station.lat]] },
          },
          {
            type: 'Feature', properties: {
              label: `${station.name ? `${station.name}\n` : ''}${kind} · ${distance} straight-line`,
            },
            geometry: { type: 'Point', coordinates: [station.lon, station.lat] },
          },
        ],
      },
    });
    map.addLayer({
      id: LINE_ID, type: 'line', source: SOURCE_ID,
      filter: ['==', '$type', 'LineString'],
      paint: { 'line-color': '#b45309', 'line-width': 2.5, 'line-dasharray': [3, 2] },
    }, map.getLayer(TOWER_LAYER_ID) ? TOWER_LAYER_ID : undefined);
    map.addLayer({
      id: POINT_ID, type: 'circle', source: SOURCE_ID,
      filter: ['==', '$type', 'Point'],
      paint: {
        'circle-radius': 7, 'circle-color': '#d97706',
        'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5,
      },
    });
    map.addLayer({
      id: LABEL_ID, type: 'symbol', source: SOURCE_ID,
      filter: ['==', '$type', 'Point'],
      layout: {
        'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'],
        'text-size': 12, 'text-anchor': station.lon <= lon ? 'top-left' : 'top-right', 'text-offset': [0, 1.1],
        'text-max-width': 22, 'text-allow-overlap': true,
      },
      paint: { 'text-color': '#78350f', 'text-halo-color': '#ffffff', 'text-halo-width': 2 },
    });
    return () => {
      for (const id of [LABEL_ID, POINT_ID, LINE_ID]) {
        if (map.getLayer(id)) map.removeLayer(id);
      }
      if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    };
  }, [map, station, lon, lat]);

  return null;
}
