import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Map as MaplibreMap,
  NavigationControl,
  type MapGeoJSONFeature,
  type GeoJSONSource,
  type RasterTileSource,
  type FilterSpecification,
  type ExpressionSpecification,
} from 'maplibre-gl';
import type { MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useSelection } from '../../state/useSelection';
import { useMapFilter } from '../../state/useMapFilter';
import { useWeights } from '../../state/useWeights';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useTowerFallbackQuery } from '../../api/queries';
import {
  TOWER_SOURCE_ID,
  TOWER_LAYER_ID,
  TOWER_ICON_LAYER_ID,
  TOWER_ICON_IMAGE_ID,
  overviewTowerPaint,
  towerClustering,
  towerClusterPaint,
  towerClusterLayout,
  TOWER_CLUSTER_LAYER_ID,
  TOWER_CLUSTER_LABEL_ID,
  TOWER_DETAIL_ZOOM,
  towerIconLayout,
  towerIconPaint,
  towerIconOpacity,
  towersToGeoJSON,
  ISOLATED_RING_SOURCE_ID,
  ISOLATED_RING_LAYER_ID,
  isolatedRingPaint,
  PROTECTED_RING_LAYER_ID,
  protectedRingPaint,
  protectedRingFilter,
} from './towerLayer';
import {
  TERRAIN_SOURCE_ID,
  HILLSHADE_LAYER_ID,
  terrainSource,
  hillshadeLayer,
} from './terrainLayer';
import {
  FLOOD_SOURCE_ID,
  FLOOD_FILL_LAYER_ID,
  FLOOD_LINE_LAYER_ID,
  FLOOD_HEX_RADIUS_DEG,
  FLOOD_HEX_MIN_COUNT,
  floodFillLayer,
  floodLineLayer,
} from './floodLayer';
import {
  INUNDATION_SOURCE_ID,
  INUNDATION_LAYER_ID,
  FLOOD_RING_LAYER_ID,
  inundationLayer,
  floodRingPaint,
  floodRingFilter,
} from './inundationLayer';
import { hexbin } from '../../lib/hexbin';
import { FLOOD_STAGES_M } from '../../lib/inundation';
import { apiUrl } from '../../api/client';
import {
  FLOOD_VOLUME_SOURCE_ID,
  FLOOD_VOLUME_LAYER_ID,
  FLOOD_VOLUME_URL,
  floodVolumeLayer,
  depthExpression,
  depthColour,
  volumeFilter,
  skyLayer,
} from './floodVolumeLayer';
import { BASEMAP_STYLE_URL, MALAYSIA_BBOX, SOUTHEAST_ASIA_BBOX, applyBasemapStyle, groundAnchor } from './basemap';
import { EeLayers } from './EeLayers';
import { PowerStationLayer } from './PowerStationLayer';
import { isSkyLayer } from './eeLayer';
import { useMap3D, PITCH_RANGE } from '../../state/useMap3D';
import { useFloodSurface } from '../../state/useFloodSurface';
import { useFloodStage } from '../../state/useFloodStage';
import { DEFAULT_LAYER_OPACITY, useFloodLayers } from '../../state/useFloodLayers';
import { useFireLayersQuery, useFloodLayersQuery, useLandLayersQuery, useMapPreparationQuery } from '../../api/queries';
import { useMapInstance, readView } from '../../state/useMapInstance';
import { useScoreOpacity } from '../../state/useScoreOpacity';
import { isScored } from '../../fixtures/towers';

const handTileUrl = (stage: number) => apiUrl(`/maps/hand/${stage}/{z}/{x}/{y}`);

const MALAYSIA_BOUNDS: [[number, number], [number, number]] = [
  [MALAYSIA_BBOX[0], MALAYSIA_BBOX[1]],
  [MALAYSIA_BBOX[2], MALAYSIA_BBOX[3]],
];
const HAND_OCEAN_MASK_LAYER_ID = 'inundation-ocean-mask';

const SCORED_ONLY: ExpressionSpecification = ['==', ['get', 'scored'], true];

function framePadding(width: number, height: number) {
  return {
    top: Math.min(130, height * 0.2),
    bottom: Math.min(160, height * 0.2),
    left: Math.min(340, width * 0.25),
    right: Math.min(width >= 1280 ? 504 : 432, width * 0.35),
  };
}

export function MapView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const selectTower = useSelection((s) => s.selectTower);
  const bandFilter = useMapFilter((s) => s.bandFilter);
  const areaFilter = useMapFilter((s) => s.areaFilter);
  const setMap = useMapInstance((s) => s.setMap);
  const setView = useMapInstance((s) => s.setView);
  const setCursor = useMapInstance((s) => s.setCursor);
  const scoreOpacity = useScoreOpacity((s) => s.scoreOpacity);
  const floodSurface = useFloodSurface((s) => s.floodSurface);
  const stage = useFloodStage((s) => s.stage);
  const setHandTileError = useFloodStage((s) => s.setTileError);
  const is3D = useMap3D((s) => s.enabled);
  const stacked = useMap3D((s) => s.stacked);
  const pitch3D = useMap3D((s) => s.pitch);
  const exaggeration = useMap3D((s) => s.exaggeration);
  const activeLayers = useFloodLayers((s) => s.active);
  const date = useFloodLayers((s) => s.date);
  const { data: preparation } = useMapPreparationQuery(date);
  const syncLatestDate = useFloodLayers((s) => s.syncLatestDate);
  const savedDate = preparation?.date;
  useEffect(() => { syncLatestDate(savedDate); }, [syncLatestDate, savedDate]);
  const handState = preparation?.layers.find((layer) => layer.layer_id === `hand_${stage}`);
  const handReady = handState?.state === 'ready';
  const scenarioOpacity = useFloodLayers((s) => s.opacity.potential_depth ?? DEFAULT_LAYER_OPACITY);
  const { data: catalogue } = useFloodLayersQuery();
  const { data: landCatalogue } = useLandLayersQuery();
  const { data: fireCatalogue } = useFireLayersQuery();
  // EeLayers routes each active raster to its catalogue's tiles endpoint.
  const liveRasterLayers = [
    ...(catalogue?.layers ?? []),
    ...(landCatalogue?.layers ?? []),
    ...(fireCatalogue?.layers ?? []),
  ].filter((layer) => layer.kind !== 'static' && activeLayers.includes(layer.layer_id));
  // Flood catalogue only: the HAND scenario is a flood layer, and no land layer
  // is temporal_kind 'scenario'.
  const scenarioActive =
    catalogue?.layers.some(
      (layer) => layer.temporal_kind === 'scenario' && activeLayers.includes(layer.layer_id),
    ) ?? false;
  // Read the latest stage when the asynchronous map load creates the rings.
  const stageRef = useRef(stage);
  stageRef.current = scenarioActive ? stage : null;
  const exaggerationRef = useRef(exaggeration);
  exaggerationRef.current = exaggeration;
  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  // Filter before clustering so counts and every tower annotation describe
  // the same population. Unscored sites do not belong to the OK band.
  const visibleTowers = useMemo(() => towers.filter((tower) =>
    (!bandFilter || (isScored(tower) && tower.decision === bandFilter)) &&
    (!areaFilter || (tower.territory ?? 'unassigned') === areaFilter),
  ), [towers, bandFilter, areaFilter]);
  const { data: fallbackReport } = useTowerFallbackQuery();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new MaplibreMap({
      container: containerRef.current,
      style: BASEMAP_STYLE_URL,
      maxPitch: PITCH_RANGE.max,
      bounds: MALAYSIA_BOUNDS,
      fitBoundsOptions: {
        padding: framePadding(containerRef.current.clientWidth, containerRef.current.clientHeight),
      },
    });
    mapRef.current = map;
    (window as unknown as { __map: MaplibreMap }).__map = map;
    setMap(map);

    // The HUD's edge ticks, cursor readout and scale rule derive from the live
    // view. `move` rather than `moveend`, or they visibly lag the pan; coalesced
    // through rAF because this fires far faster than the DOM needs updating.
    let viewFrame = 0;
    const publishView = () => {
      if (viewFrame) return;
      viewFrame = requestAnimationFrame(() => {
        viewFrame = 0;
        setView(readView(map));
      });
    };
    map.on('move', publishView);
    map.on('zoom', publishView);
    map.on('resize', publishView);

    let cursorFrame = 0;
    let pendingCursor: { lon: number; lat: number } | null = null;
    const publishCursor = (e: MapMouseEvent) => {
      pendingCursor = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      if (cursorFrame) return;
      cursorFrame = requestAnimationFrame(() => {
        cursorFrame = 0;
        setCursor(pendingCursor);
      });
    };
    const clearCursor = () => setCursor(null);
    map.on('mousemove', publishCursor);
    map.on('mouseout', clearCursor);

    // Bottom-right, not the default top-right: the HUD's status chips occupy
    // that corner now, and the left column, scrubber and inspector take the
    // others. This is the only corner left clear.
    map.addControl(new NavigationControl({ showCompass: false }), 'bottom-right');

    map.on('error', (e) => {
      // A failed style/tile fetch must not leave a blank canvas on stage —
      // surface it instead of failing silently.
      console.error('MapLibre error', e.error);
      const tileError = e.error as Error & { status?: number; url?: string };
      const sourceId = (e as typeof e & { sourceId?: string }).sourceId;
      if (
        sourceId === INUNDATION_SOURCE_ID ||
        `${tileError.url ?? ''} ${tileError.message}`.includes('/GlobalHAND/GLO30_HAND/')
      ) {
        setHandTileError(
          `ASF HAND tiles are unavailable${tileError.status ? ` (${tileError.status})` : ''}. Change the water level to retry.`,
        );
      }
      setStatus((prev) => (prev === 'ready' ? prev : 'error'));
    });

    map.on('load', () => {
      applyBasemapStyle(map);
      setStatus('ready');
      setView(readView(map));

      // Everything describing the ground goes below the basemap's label
      // layers, so place names stay legible through relief and flood water.
      // The raster basemap could not do this — its labels were baked into the
      // image underneath every overlay. Towers are not ground and stay on top.
      const ground = groundAnchor(map);

      // Relief first, so it lands directly above the basemap fills and below
      // every tower layer. A hillshade painted over the towers would tint the
      // band colours, which are the only thing on this map carrying a reading.
      map.addSource(TERRAIN_SOURCE_ID, terrainSource);
      map.addLayer(
        { ...hillshadeLayer, id: HILLSHADE_LAYER_ID, source: TERRAIN_SOURCE_ID },
        ground,
      );

      // Deeper camera zooms magnify saved HAND tiles without fetching new detail.
      map.addSource(INUNDATION_SOURCE_ID, {
        type: 'raster',
        tiles: [handTileUrl(FLOOD_STAGES_M[0])],
        tileSize: 256,
        maxzoom: 8,
        bounds: [
          SOUTHEAST_ASIA_BBOX[0],
          SOUTHEAST_ASIA_BBOX[1],
          SOUTHEAST_ASIA_BBOX[2],
          SOUTHEAST_ASIA_BBOX[3],
        ],
        attribution: 'ASF Global 30 m HAND v1 (CC0), derived from Copernicus GLO-30',
      });
      map.addLayer(
        { ...inundationLayer, id: INUNDATION_LAYER_ID, source: INUNDATION_SOURCE_ID },
        ground,
      );
      map.setLayoutProperty(INUNDATION_LAYER_ID, 'visibility', 'none');

      // GLO-30 HAND has ocean pixels and coarse overview seams. Reuse the
      // basemap's own coastline as an ocean mask so neither can read as flood.
      const waterLayer = map.getStyle().layers?.find((layer) => layer.id === 'water');
      if (waterLayer?.type === 'fill') {
        const oceanOnly: FilterSpecification = ['==', ['get', 'class'], 'ocean'];
        map.addLayer(
          {
            ...waterLayer,
            id: HAND_OCEAN_MASK_LAYER_ID,
            filter: waterLayer.filter
              ? (['all', waterLayer.filter, oceanOnly] as FilterSpecification)
              : oceanOnly,
          },
          ground,
        );
        map.setLayoutProperty(HAND_OCEAN_MASK_LAYER_ID, 'visibility', 'none');
      }

      // Between the relief and the towers: the flood surface is ground, not a
      // reading, so it must never be painted over a band colour.
      map.addSource(FLOOD_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({ ...floodFillLayer, id: FLOOD_FILL_LAYER_ID, source: FLOOD_SOURCE_ID }, ground);
      map.addLayer({ ...floodLineLayer, id: FLOOD_LINE_LAYER_ID, source: FLOOD_SOURCE_ID }, ground);

      // The 3D water volume. Loaded once and filtered per stage rather than
      // refetched: one geometry carries every stage, since each cell knows the
      // height above drainage at which it turns wet.
      map.addSource(FLOOD_VOLUME_SOURCE_ID, { type: 'geojson', data: FLOOD_VOLUME_URL });
      map.addLayer(
        {
          ...floodVolumeLayer(stageRef.current ?? FLOOD_STAGES_M[0], exaggerationRef.current),
          id: FLOOD_VOLUME_LAYER_ID,
          source: FLOOD_VOLUME_SOURCE_ID,
        },
        ground,
      );
      map.setFilter(FLOOD_VOLUME_LAYER_ID, volumeFilter(stageRef.current));
      map.setLayoutProperty(FLOOD_VOLUME_LAYER_ID, 'visibility', 'none');

      map.addSource(TOWER_SOURCE_ID, {
        ...towerClustering,
        type: 'geojson',
        data: towersToGeoJSON([]),
      });

      map.addLayer({
        id: TOWER_CLUSTER_LAYER_ID,
        type: 'circle',
        source: TOWER_SOURCE_ID,
        filter: ['has', 'point_count'],
        paint: towerClusterPaint,
      });
      map.addLayer({
        id: TOWER_CLUSTER_LABEL_ID,
        type: 'symbol',
        source: TOWER_SOURCE_ID,
        filter: ['has', 'point_count'],
        layout: towerClusterLayout,
        paint: { 'text-color': '#24333d' },
      });

      map.on('click', TOWER_CLUSTER_LAYER_ID, async (e) => {
        const feature = e.features?.[0];
        if (feature?.geometry.type !== 'Point') return;
        const source = map.getSource(TOWER_SOURCE_ID) as GeoJSONSource;
        try {
          const zoom = await source.getClusterExpansionZoom(feature.properties.cluster_id);
          if (mapRef.current !== map) return;
          const { width, height } = map.getCanvas().getBoundingClientRect();
          const padding = framePadding(width, height);
          map.easeTo({
            center: feature.geometry.coordinates as [number, number],
            zoom,
            offset: [(padding.left - padding.right) / 2, (padding.top - padding.bottom) / 2],
            duration: 600,
          });
        } catch {
          // The source can be reclustered by a filter change during the click.
        }
      });
      map.on('mouseenter', TOWER_CLUSTER_LAYER_ID, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', TOWER_CLUSTER_LAYER_ID, () => { map.getCanvas().style.cursor = ''; });

      // Beneath the band halo (third arg = insert BEFORE this layer): the ring
      // is a statement about consequence, the halo is the reading itself, and
      // decoration must never outrank data.
      map.addSource(ISOLATED_RING_SOURCE_ID, {
        type: 'geojson',
        data: towersToGeoJSON([]),
      });

      map.addLayer({
        id: TOWER_LAYER_ID,
        type: 'circle',
        source: TOWER_SOURCE_ID,
        filter: ['!', ['has', 'point_count']],
        paint: overviewTowerPaint,
      });

      map.addLayer({
        id: ISOLATED_RING_LAYER_ID,
        type: 'circle',
        source: ISOLATED_RING_SOURCE_ID,
        minzoom: TOWER_DETAIL_ZOOM,
        paint: isolatedRingPaint,
      }, TOWER_LAYER_ID);

      // Above the halo so the ring is not buried by it, below the icon layer
      // added asynchronously later — the icon is decoration, and it is drawn on
      // the same centre, so it cannot cover a ring of larger radius.
      map.addLayer({
        id: FLOOD_RING_LAYER_ID,
        type: 'circle',
        source: TOWER_SOURCE_ID,
        minzoom: TOWER_DETAIL_ZOOM,
        paint: floodRingPaint,
      });
      map.setFilter(FLOOD_RING_LAYER_ID, floodRingFilter(stageRef.current));

      // BENEATH the halo (third arg = insert before this layer), like the
      // isolated ring and for a reason that bit before it was reasoned about:
      // this ring is wider than the halo it annotates (radius to 16 against
      // the halo's 11), so ON TOP it covers the halo's own click target and
      // every pixel of basemap around it. MapLibre hit-tests the topmost
      // layer, so the ring around a protected tower swallowed clicks meant for
      // OTHER towers near it — measured: after protecting one tower, clicking
      // two different neighbours re-selected the protected one both times, and
      // the selection appeared frozen. Decoration must never outrank data, and
      // here that rule is load-bearing for input and not only for legibility.
      //
      // Shares TOWER_SOURCE_ID and filters on the `protected` property rather
      // than carrying its own source — the set it marks changes on every
      // commit, and a second source would need feeding in lockstep with the
      // first.
      map.addLayer(
        {
          id: PROTECTED_RING_LAYER_ID,
          type: 'circle',
          source: TOWER_SOURCE_ID,
          paint: protectedRingPaint,
        },
        TOWER_LAYER_ID,
      );
      map.setFilter(PROTECTED_RING_LAYER_ID, protectedRingFilter);

      map.on('click', TOWER_LAYER_ID, (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
        const feature = e.features?.[0];
        const towerId = feature?.properties?.tower_id;
        if (typeof towerId === 'string') {
          selectTower(towerId);
        }
      });

      map.on('mouseenter', TOWER_LAYER_ID, () => {
        map.getCanvas().style.cursor = 'pointer';
      });
      map.on('mouseleave', TOWER_LAYER_ID, () => {
        map.getCanvas().style.cursor = '';
      });

      // IMPORTANT: addLayer for the icon symbol must happen AFTER addImage resolves.
      // If addLayer runs first, MapLibre records the icon-image name but the image
      // isn't registered yet, so it silently skips rendering every icon permanently.
      map
        .loadImage('/brand/tower-icon.png')
        .then(({ data: image }) => {
          if (!map.hasImage(TOWER_ICON_IMAGE_ID)) {
            map.addImage(TOWER_ICON_IMAGE_ID, image);
          }
          map.addLayer({
            id: TOWER_ICON_LAYER_ID,
            type: 'symbol',
            source: TOWER_SOURCE_ID,
            layout: towerIconLayout,
            paint: towerIconPaint,
          });
          map.setFilter(TOWER_ICON_LAYER_ID, SCORED_ONLY);
          map.setPaintProperty(TOWER_ICON_LAYER_ID, 'icon-opacity',
            towerIconOpacity(useScoreOpacity.getState().scoreOpacity));

          map.on('click', TOWER_ICON_LAYER_ID, (e: MapMouseEvent & { features?: MapGeoJSONFeature[] }) => {
            const feature = e.features?.[0];
            const towerId = feature?.properties?.tower_id;
            if (typeof towerId === 'string') {
              selectTower(towerId);
            }
          });
          map.on('mouseenter', TOWER_ICON_LAYER_ID, () => {
            map.getCanvas().style.cursor = 'pointer';
          });
          map.on('mouseleave', TOWER_ICON_LAYER_ID, () => {
            map.getCanvas().style.cursor = '';
          });
        })
        .catch((err) => {
          console.error('tower icon failed to load', err);
          // icon layer simply renders nothing extra — halo layer still works
        });
    });

    return () => {
      if (viewFrame) cancelAnimationFrame(viewFrame);
      if (cursorFrame) cancelAnimationFrame(cursorFrame);
      map.off('move', publishView);
      map.off('zoom', publishView);
      map.off('resize', publishView);
      map.off('mousemove', publishCursor);
      map.off('mouseout', clearCursor);
      map.remove();
      mapRef.current = null;
      setMap(null);
      setView(null);
      setCursor(null);
      setHandTileError(null);
    };
  }, [selectTower, setMap, setView, setCursor, setHandTileError]);

  // Score opacity is chrome, not data: it scales how loudly the scored towers
  // draw without changing which ones are present. Unscored towers keep their
  // own much fainter treatment so they never compete with a real reading.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    if (map.getLayer(TOWER_LAYER_ID)) {
      map.setPaintProperty(TOWER_LAYER_ID, 'circle-opacity', [
        'case',
        ['==', ['get', 'scored'], false],
        scoreOpacity * 0.36,
        scoreOpacity,
      ]);
    }
    if (map.getLayer(TOWER_ICON_LAYER_ID)) {
      map.setPaintProperty(TOWER_ICON_LAYER_ID, 'icon-opacity', towerIconOpacity(scoreOpacity));
    }
    if (map.getLayer(TOWER_CLUSTER_LAYER_ID)) {
      map.setPaintProperty(TOWER_CLUSTER_LAYER_ID, 'circle-opacity', scoreOpacity);
      map.setPaintProperty(TOWER_CLUSTER_LAYER_ID, 'circle-stroke-opacity', scoreOpacity);
      map.setPaintProperty(TOWER_CLUSTER_LABEL_ID, 'text-opacity', scoreOpacity);
    }
  }, [scoreOpacity, status]);

  // Depends on `status` as well as `towers`: the source is created inside the
  // map's 'load' handler, so an earlier run of this effect can find neither a
  // source nor a pending 'load' event to wait for (isStyleLoaded() is already
  // true, but addSource has not run yet) and silently drop the data. Re-running
  // once status flips to 'ready' guarantees one apply after the source exists.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const source = map.getSource(TOWER_SOURCE_ID);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(towersToGeoJSON(visibleTowers));
    }
  }, [visibleTowers, status]);

  // Ring the flood-exposed towers nothing could stand in for. Empty — never a
  // partial set — while the report is unavailable: a ring is an assertion, and
  // drawing none is the correct output for "we could not ask".
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    const source = map.getSource(ISOLATED_RING_SOURCE_ID);
    if (source && 'setData' in source) {
      const isolated = fallbackReport
        ? visibleTowers.filter((t) => fallbackReport.towers[t.tower_id]?.candidates.length === 0)
        : [];
      (source as GeoJSONSource).setData(towersToGeoJSON(isolated));
    }
  }, [visibleTowers, status, fallbackReport]);

  // 3D: terrain mesh, camera tilt, sky and the water volume are driven together
  // because they are one scene. The exaggeration is shared with the extrusion
  // below, so the banded water estimate and ground use one vertical scale.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;

    if (is3D && !stacked) {
      // The same DEM the hillshade already uses — setTerrain needs no new source.
      if (map.getSource(TERRAIN_SOURCE_ID)) {
        map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
      }
      map.setSky(skyLayer);
      // easeTo rather than setPitch: an instant tilt is disorienting when the
      // ground under the pointer swings across the screen.
      map.easeTo({ pitch: pitch3D, duration: 600 });
    } else {
      map.setTerrain(null);
      map.easeTo({ pitch: stacked ? 70 : 0, duration: 500 });
    }
  }, [is3D, stacked, pitch3D, exaggeration, status]);

  // The water volume. Visible only in 3D and only with a stage chosen: seen
  // from directly above an extrusion is edge-on, and reads as a flat fill that
  // merely duplicates the raster already underneath it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;
    if (!map.getLayer(FLOOD_VOLUME_LAYER_ID)) return;

    const activeStage = scenarioActive ? stage : null;
    const show = is3D && !stacked && activeStage !== null;
    map.setLayoutProperty(FLOOD_VOLUME_LAYER_ID, 'visibility', show ? 'visible' : 'none');
    map.setFilter(FLOOD_VOLUME_LAYER_ID, volumeFilter(activeStage));
    if (activeStage !== null) {
      // BOTH paint properties. Height and colour each encode depth, and both
      // bake the stage in as a literal, so updating only one leaves the other
      // computing against whatever stage the layer was created with — water
      // that still looks blue while its colour means nothing.
      map.setPaintProperty(
        FLOOD_VOLUME_LAYER_ID,
        'fill-extrusion-height',
        depthExpression(activeStage, exaggeration),
      );
      map.setPaintProperty(FLOOD_VOLUME_LAYER_ID, 'fill-extrusion-color', depthColour(activeStage));
    }
  }, [is3D, stacked, stage, scenarioActive, exaggeration, status]);

  // Flood stage scenario. ArcGIS thresholds each regional tile server-side;
  // changing stage only swaps the tile template and tower/volume filters.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;

    const activeStage = scenarioActive && handReady ? stage : null;
    setHandTileError(scenarioActive && stage !== null && !handReady
      ? handState?.detail ?? 'Preparing water-level maps in the background…' : null);
    if (map.getLayer(FLOOD_RING_LAYER_ID)) {
      map.setFilter(FLOOD_RING_LAYER_ID, floodRingFilter(activeStage));
    }
    if (!map.getLayer(INUNDATION_LAYER_ID)) return;

    map.setLayoutProperty(
      INUNDATION_LAYER_ID,
      'visibility',
      activeStage === null ? 'none' : 'visible',
    );
    if (map.getLayer(HAND_OCEAN_MASK_LAYER_ID)) {
      map.setLayoutProperty(
        HAND_OCEAN_MASK_LAYER_ID,
        'visibility',
        activeStage === null ? 'none' : 'visible',
      );
    }
    if (activeStage === null) return;

    const source = map.getSource(INUNDATION_SOURCE_ID);
    if (source && 'setTiles' in source) {
      (source as RasterTileSource).setTiles([handState?.tile_url ? apiUrl(handState.tile_url) : handTileUrl(activeStage)]);
    }
  }, [stage, scenarioActive, status, setHandTileError, handReady, handState?.detail, handState?.tile_url]);

  useEffect(() => {
    const map = mapRef.current;
    if (map?.getLayer(INUNDATION_LAYER_ID)) {
      map.setPaintProperty(INUNDATION_LAYER_ID, 'raster-opacity', scenarioOpacity);
    }
  }, [scenarioOpacity, status]);

  // Flood surface. Binned from the same `towers` array the marks come from, so
  // the surface and the dots can never describe different data.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || status !== 'ready') return;

    const visibility = floodSurface ? 'visible' : 'none';
    for (const id of [FLOOD_FILL_LAYER_ID, FLOOD_LINE_LAYER_ID]) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', visibility);
    }
    // Nothing to bin while hidden — skip the work rather than keeping a
    // surface up to date that no one is looking at.
    if (!floodSurface) return;

    const source = map.getSource(FLOOD_SOURCE_ID);
    if (!source || !('setData' in source)) return;
    const points = towers
      .filter((t) => t.dominant_factor !== 'unscored' && typeof t.attribution?.flood === 'number')
      .map((t) => ({ lon: t.lon, lat: t.lat, value: t.attribution.flood }));
    (source as GeoJSONSource).setData(
      hexbin(points, FLOOD_HEX_RADIUS_DEG, FLOOD_HEX_MIN_COUNT),
    );
  }, [towers, status, floodSurface]);

  return (
    <div className="relative h-full w-full bg-ink-950">
      <div ref={containerRef} className="h-full w-full" />
      {/* Each child owns its raster and, in stack view, its level label.
          Gated on `status` so the style exists first. */}
      {status === 'ready' && <EeLayers layers={liveRasterLayers} />}
      {status === 'ready' && activeLayers.includes('power_station') && <PowerStationLayer />}
      {stacked && !liveRasterLayers.some((layer) => isSkyLayer(layer.layer_id)) && <p role="status"
        className="pointer-events-none absolute bottom-20 left-1/2 z-20 max-w-xs -translate-x-1/2 rounded-lg border border-accent/20 bg-ink-900 px-3 py-2 text-center text-ui text-fg">
        {activeLayers.length === 0 ? 'Enable land layers and rainfall to compare ground and sky.' : 'Ground layers stay on the map. Enable rainfall to add a sky layer.'}
      </p>}
      {status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/80 text-body text-muted">
          Loading map…
        </div>
      )}
      {status === 'error' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-ink-950 px-6 text-center">
          <div className="text-lead font-medium text-watch-ink">Basemap tiles unavailable</div>
          <p className="max-w-sm text-ui leading-relaxed text-dim">
            The basemap couldn't be reached. Tower scores and the schedule are unaffected — only the background
            imagery is missing. Check the network connection and reload.
          </p>
        </div>
      )}
    </div>
  );
}
