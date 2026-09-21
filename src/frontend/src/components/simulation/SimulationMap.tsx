import { useEffect, useMemo, useRef, useState } from 'react';
import { Map as MaplibreMap, NavigationControl, AttributionControl, LngLat, type GeoJSONSource, type SymbolLayerSpecification } from 'maplibre-gl';
import { useReducedMotion } from 'motion/react';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { BASEMAP_STYLE_URL, applyBasemapStyle, groundAnchor } from '../map/basemap';
import { hillshadeLayer, TERRAIN_SOURCE_ID, HILLSHADE_LAYER_ID } from '../map/terrainLayer';
import { skyLayer } from '../map/floodVolumeLayer';
import { createSimulationThreeLayer, responseUnitColor, RESPONSE_VEHICLE_3D_ZOOM, type SimulationLayerMode } from './simulationThreeLayer';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useWeights } from '../../state/useWeights';
import { useSimulation } from '../../state/useSimulation';
import { useCrewsQuery } from '../../api/queries';
import { CREWS } from '../../fixtures/crews';
import { boundsOf, haversineKm } from '../../lib/geo';
import { UNSCORED_INK, ALERT } from '../../lib/colors';
import { sectorPolygon } from '../../lib/coverageGeometry';
import {
  towersToGeoJSON,
  towerPaint,
  towerIconLayout,
  towerIconPaint,
  TOWER_ICON_IMAGE_ID,
} from '../map/towerLayer';
import { retuneBearingAt, assignRetuningNeighbors, RETUNE_STILL_T } from '../../lib/responsePhaseGeometry';
import { floodExtentAt, SABAH_FLOOD_SCENARIO } from '../../fixtures/scenarios/sabahFlood';
import { simulationCameraAt } from '../../lib/simulationCamera';
import { FLOOD_PRIORITY_MS, simulationAssessmentPulseAt, simulationEnvironmentAt } from '../../lib/simulationVisuals';
import { simulationAssessmentAt, simulationWarningsAt, type SimulationWarningId } from '../../lib/simulationWarnings';
import type { SimulationRoadState } from './useSimulationRoads';
import { HARDENING_EXIT_MS, simulationRoadCrewAt, type SimulationRoadLeg } from '../../lib/simulationRoads';
import { prepareRoadMotion, roadHoldPoint, roadPositionAt } from '../../lib/simulationRoadMotion';
import { droneFlightAt, DRONE_LAUNCH_MS } from '../../lib/droneFlight';
import type { Tower } from '../../api/types';

/** Isolated map: never publish this camera through the overview's useMapInstance. */
const FLOOD_SOURCE = 'sim-flood-ground';
const FLOOD_LAYER = 'sim-flood-ground-fill';
const WARNING_FOOTPRINT = 'sim-warning-footprint';
const RAINFALL_LAYER = 'sim-rainfall-intensity';
const WARNING_SITES = 'sim-warning-sites';
const ASSESSMENT_LABELS = 'sim-assessment-labels';
const TOWER_SOURCE = 'sim-towers';
const TOWER_LAYER = 'sim-towers-circle';
const TOWER_ICON_LAYER = 'sim-towers-icon';
const TOWER_3D_HANDOFF_ZOOM = 13.5;
const GAP_SOURCE = 'sim-coverage-gap';
const GAP_LAYER = 'sim-coverage-gap-fill';
const SUPPORTED_SOURCE = 'sim-temporary-network';
const DOWN_SOURCE = 'sim-down-tower';
const DOWN_RING_LAYER = 'sim-down-tower-ring';
const DOWN_LABEL_LAYER = 'sim-down-tower-label';
const SECTOR_SOURCE = 'sim-sector-cone';
const SECTOR_LAYER = 'sim-sector-cone-fill';
const MOCN_SOURCE = 'sim-mocn-link';
const MOCN_LAYER = 'sim-mocn-link-line';
const COW_COVERAGE_SOURCE = 'sim-cow-coverage';
const COW_COVERAGE_LAYER = 'sim-cow-coverage-fill';
const FLEET_SOURCE = 'sim-response-fleet';
const DEVICE_SOURCE = 'sim-network-devices';
const STAGING_SOURCE = 'sim-response-staging';
const GENERATOR_SOURCE = 'sim-generator-sites';
const GENERATOR_ICON_LAYER = 'sim-generator-icon-layer';
const SATELLITE_SOURCE = 'sim-satellite';
const SATELLITE_LAYER = 'sim-satellite-image';
const ROAD_SOURCE = 'sim-road-routes';
const BLOCKED_ROAD_SOURCE = 'sim-blocked-roads';
const RIVER_SOURCE = 'sim-mapped-rivers';

/** Illustrative sector-cone reach — same "reads on a console map" logic as
 *  the coverage-gap radius, not a propagation figure. */
const SECTOR_RADIUS_KM = 6;
const SECTOR_WIDTH_DEG = 65;

const VEHICLE_ICON_ID = 'sim-response-vehicle';
const BASE_STATION_ICON_ID = 'sim-mobile-base-station';
const DEVICE_ICON_ID = 'sim-radio-device';

const DRONE_SOURCE = 'sim-prime-drones';
const DRONE_ICON_ID = 'sim-prime-drone';
const DRONE_ICON_URL = '/brand/drone.png';
/** Source asset is 512px square, like `/brand/jeep.png`; the ratio is what
 *  MapLibre's `icon-size` wants, so the rendered size stays readable if the
 *  artwork is ever re-exported at another resolution. */
const DRONE_ICON_SIZE_PX = 30;
const DRONE_ICON_SOURCE_PX = 512;

const GENERATOR_ICON_ID = 'sim-generator-icon';
const GENERATOR_ICON_URL = '/brand/generator.png';
const GENERATOR_ICON_SIZE_PX = 34;
const GENERATOR_ICON_SOURCE_PX = 256;

/** Beats that bound the response-phase animation window, from
 *  lib/simulationTimeline.ts. Cones/MOCN/COW are visible from the moment
 *  the antenna-retune beat fires until the withdraw beat retracts them —
 *  spec §6 Phase 4 ("Map: overlays retract; cones return to nominal"). */
const GENERATOR_PREPOSITION_MS = 19000; // 'generators' beat's atMs
const TOWER_DOWN_MS = 27000; // 'tower-down' beat's atMs
const RETUNE_START_MS = 40000; // 'antenna-retune' beat's atMs
const MOCN_START_MS = 47000; // 'mocn' beat's atMs
const TOWER_RESTORE_MS = 80000; // 'restore' beat's atMs
const WITHDRAW_MS = 88000; // 'withdraw' beat's atMs
/** How long the cone takes to swing from nominal to fully-retuned, once the
 *  antenna-retune beat fires. Short enough to read as a discrete event
 *  inside a ~2-minute total run, per spec §9's animation budget. */
const RETUNE_SWING_MS = 2500;

const EMPTY_TOWER_IDS: Set<string> = new Set();

function emptyFeatureCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

function downTowerPoints(towers: Tower[], downTowerIds: Set<string>): FeatureCollection {
  const down = towers.filter((t) => downTowerIds.has(t.tower_id));
  const features: Feature<Point>[] = down.map((t) => ({
    type: 'Feature',
    properties: { tower_id: t.tower_id },
    geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
  }));
  return { type: 'FeatureCollection', features };
}

interface SimulationMapProps {
  mode: SimulationLayerMode;
  warning: SimulationWarningId;
  cinematic: boolean;
  onCinematicChange: (enabled: boolean) => void;
  roads: SimulationRoadState;
}

export function SimulationMap({ mode, warning, roads, cinematic, onCinematicChange }: SimulationMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MaplibreMap | null>(null);
  const [ready, setReady] = useState(false);
  const [mapFailure, setMapFailure] = useState<'webgl' | 'style' | 'context' | null>(null);
  const [mapAttempt, setMapAttempt] = useState(0);
  const [viewportRevision, setViewportRevision] = useState(0);
  const [satellite, setSatellite] = useState(true);
  const [imageryUnavailable, setImageryUnavailable] = useState(false);
  const basemapLabels = useRef<SymbolLayerSpecification[]>([]);

  const weights = useWeights((s) => s.weights);
  const { towers } = useLiveTowers(weights);
  const status = useSimulation((s) => s.status);
  const runSeq = useSimulation((s) => s.runSeq);
  const elapsedMs = useSimulation((s) => s.elapsedMs);
  const downTowerIds = useSimulation((s) => s.downTowerIds);
  const generatorSiteIds = useSimulation((s) => s.generatorSiteIds);
  const emergencyRun = useSimulation((s) => s.emergencyRun);
  const optimizeRun = useSimulation((s) => s.optimizeRun);
  const crewsQuery = useCrewsQuery();
  const crews = crewsQuery.data ?? CREWS;
  const shouldReduceMotion = useReducedMotion();

  const sabahTowers = useMemo(() => towers.filter((t) => t.territory === 'Sabah'), [towers]);
  const roadUnits = useMemo(() => {
    const groups = new Map<string, SimulationRoadLeg[]>();
    for (const leg of roads.legs) {
      const id = leg.unitId ?? leg.crewId;
      const legs = groups.get(id) ?? [];
      legs.push(leg);
      groups.set(id, legs);
    }
    return [...groups].map(([id, legs]) => ({ id, legs, color: responseUnitColor(id) }));
  }, [roads.legs]);
  const roadPaths = useMemo(() => new Map(roads.legs.flatMap(leg => {
    const path = leg.road?.status === 'routed' ? prepareRoadMotion(leg.road.coordinates) : null;
    const departure = leg.road?.departure_route;
    const departurePath = departure?.status === 'routed' ? prepareRoadMotion(departure.coordinates) : null;
    return path ? [[leg.id, { inbound: path, departure: departurePath }] as const] : [];
  })), [roads.legs]);
  // Keep civil vehicles at their dry exit points until response handover.
  const hardeningVisible = status !== 'idle' && elapsedMs >= 15_000 && elapsedMs < 54_000
    && roads.legs.some(leg => leg.unitKind === 'hardening');
  const responseVisible = status !== 'idle' && elapsedMs >= 54_000;
  /** Either convoy is on screen — the shared route/vehicle layers draw for both. */
  const fleetVisible = responseVisible || hardeningVisible;
  const exitRouteVisible = elapsedMs >= 19_000;
  const peakAssessment = useMemo(() => simulationAssessmentAt(26_000, sabahTowers), [sabahTowers]);
  const floodBounds = useMemo(() => {
    const ids = new Set(peakAssessment.exposedSiteIds);
    return boundsOf(sabahTowers.filter(tower => ids.has(tower.tower_id)));
  }, [sabahTowers, peakAssessment]);
  // Compare the flood with its closest outside priorities, not distant Sabah outliers.
  const assessmentBounds = useMemo(() => {
    const ids = new Set([...peakAssessment.exposedSiteIds, ...peakAssessment.nearbyPrioritySiteIds]);
    return boundsOf(sabahTowers.filter(tower => ids.has(tower.tower_id)));
  }, [sabahTowers, peakAssessment]);
  const maintenanceBounds = useMemo(() => boundsOf(roads.legs.filter(leg => leg.unitKind === 'hardening' && leg.road?.status === 'routed')
    .flatMap(leg => [...(leg.road?.coordinates ?? []), ...(leg.road?.departure_route?.coordinates ?? [])]
      .map(([lon, lat]) => ({ lon, lat })))), [roads.legs]);
  const warningTime = Math.floor(elapsedMs / 1000) * 1000;
  const showLaterMaintenance = elapsedMs >= FLOOD_PRIORITY_MS && elapsedMs < HARDENING_EXIT_MS;
  const rainIntensity = simulationEnvironmentAt(Math.floor(elapsedMs / 33) * 33).rain;
  const warningSiteIds = useMemo(() => {
    if (mode !== 'combined') return simulationWarningsAt(warningTime, sabahTowers).find((signal) => signal.id === warning)!.siteIds;
    const assessment = simulationAssessmentAt(warningTime, sabahTowers);
    return [...assessment.exposedSiteIds, ...(showLaterMaintenance ? assessment.nearbyPrioritySiteIds : [])];
  },
    [warningTime, sabahTowers, warning, mode, showLaterMaintenance]);
  const detailSite = useMemo(() => {
    const ids = downTowerIds.size ? downTowerIds : new Set(SABAH_FLOOD_SCENARIO.downTowerSelector(sabahTowers));
    const candidates = sabahTowers.filter(tower => ids.has(tower.tower_id));
    const anchor = { lon: 116.087, lat: 5.978 };
    // A real southern site keeps closeups clear of the densely co-located northern cluster.
    return candidates.length ? candidates.reduce((nearest, tower) =>
      haversineKm(anchor, tower) < haversineKm(anchor, nearest) ? tower : nearest) : anchor;
  }, [sabahTowers, downTowerIds]);

  const towersRef = useRef(sabahTowers);
  towersRef.current = sabahTowers;
  const snapshot = { towers: sabahTowers, crews, elapsedMs, status, downTowerIds, optimizeRun, emergencyRun,
    mode, warning, warningSiteIds, nearbyPrioritySiteIds: peakAssessment.nearbyPrioritySiteIds,
    roadLegs: roads.legs, roadEmergency: roads.emergency, reducedMotion: Boolean(shouldReduceMotion) };
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const cinematicChangeRef = useRef(onCinematicChange);
  cinematicChangeRef.current = onCinematicChange;

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    let map: MaplibreMap;
    try {
      // MapLibre returns early, rather than throwing, when WebGL2 is unavailable.
      const probe = document.createElement('canvas').getContext('webgl2');
      if (!probe) { setMapFailure('webgl'); return; }
      probe.getExtension('WEBGL_lose_context')?.loseContext();
      map = new MaplibreMap({
        container: containerRef.current,
        style: BASEMAP_STYLE_URL,
        center: [detailSite.lon, detailSite.lat],
        zoom: 12.2,
        pitch: 60,
        bearing: -28,
        maxPitch: 70,
        attributionControl: false,
        canvasContextAttributes: { antialias: true },
      });
    } catch {
      containerRef.current.replaceChildren();
      containerRef.current.classList.remove('maplibregl-map');
      setMapFailure('webgl');
      return;
    }
    mapRef.current = map;
    let contextLost = false;
    const showInitialStyleError = (event: { sourceId?: string; error: { message: string } }) => {
      // Tile outages must not hide a usable map; only a missing root style does.
      if (!contextLost && !map.getStyle()?.layers?.length) setMapFailure('style');
      if (event.sourceId === SATELLITE_SOURCE || event.error.message.includes('services.arcgisonline.com')) {
        setSatellite(false);
        setImageryUnavailable(true);
      }
    };
    const loseContext = () => { contextLost = true; setReady(false); setMapFailure('context'); };
    // Custom Three layers are not restored by MapLibre; rebuild this map only.
    const restoreContext = () => setMapAttempt((attempt) => attempt + 1);
    map.on('error', showInitialStyleError);
    map.on('webglcontextlost', loseContext);
    map.on('webglcontextrestored', restoreContext);
    map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    map.addControl(new AttributionControl({ compact: true }), 'bottom-right');
    const releaseCamera = (event: { originalEvent?: unknown }) => {
      if (event.originalEvent) cinematicChangeRef.current(false);
    };
    map.on('dragstart', releaseCamera);
    map.on('rotatestart', releaseCamera);
    map.on('pitchstart', releaseCamera);
    map.on('zoomstart', releaseCamera);
    const resize = new ResizeObserver(() => {
      map.resize();
      setViewportRevision((revision) => revision + 1);
    });
    resize.observe(containerRef.current);

    map.on('load', () => {
      setMapFailure(null);
      applyBasemapStyle(map);
      const anchor = groundAnchor(map);
      basemapLabels.current = (map.getStyle().layers ?? []).filter((layer): layer is SymbolLayerSpecification => layer.type === 'symbol');
      map.addSource(SATELLITE_SOURCE, {
        type: 'raster', tileSize: 256, maxzoom: 19,
        tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
        attribution: 'Imagery &copy; <a href="https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer">Esri, Vantor, Earthstar Geographics, and the GIS User Community</a>',
      });
      map.addLayer({ id: SATELLITE_LAYER, type: 'raster', source: SATELLITE_SOURCE,
        paint: { 'raster-saturation': -0.22, 'raster-brightness-max': 0.93, 'raster-fade-duration': 350 } }, anchor);
      // Mapterhorn removes the Gaya Island spikes in the legacy AWS DEM.
      // Its global tiles stop at z12; 512px tiles retain the former z13 resolution.
      map.addSource(TERRAIN_SOURCE_ID, {
        type: 'raster-dem', encoding: 'terrarium', tileSize: 512, maxzoom: 12,
        tiles: ['https://tiles.mapterhorn.com/{z}/{x}/{y}.webp'],
        attribution: '<a href="https://mapterhorn.com/attribution">&copy; Mapterhorn</a>',
      });
      map.addLayer({ id: HILLSHADE_LAYER_ID, source: TERRAIN_SOURCE_ID, ...hillshadeLayer,
        paint: { ...hillshadeLayer.paint, 'hillshade-shadow-color': '#182c30',
          'hillshade-exaggeration': ['interpolate', ['linear'], ['zoom'], 10, 0.32, 15, 0.12] } }, anchor);
      map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration: 1 });
      map.setSky(skyLayer);
      // Existing OSM footprints only; render height only where the vector source supplies it.
      const buildings = map.getStyle().layers.find(layer => layer.type === 'fill' && layer['source-layer'] === 'building');
      if (buildings && 'source' in buildings) {
        map.addLayer({ id: 'sim-buildings', type: 'fill-extrusion', source: buildings.source,
          'source-layer': 'building', minzoom: 13,
          filter: ['>', ['coalesce', ['get', 'render_height'], 0], 0],
          paint: { 'fill-extrusion-color': '#aab6ae', 'fill-extrusion-opacity': 0.75,
            'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
            'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] } }, anchor);
      }
      // A draped footprint keeps the scenario readable between tessellated wave vertices.
      map.addSource(FLOOD_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: FLOOD_LAYER, source: FLOOD_SOURCE, type: 'fill',
        paint: { 'fill-color': '#279fcb', 'fill-opacity': 0.18 } }, anchor);
      map.addSource(WARNING_FOOTPRINT, { type: 'geojson', data: emptyFeatureCollection() });
      // MapLibre drapes the tint over every hill; rainfall is not a water-height surface.
      map.addLayer({ id: RAINFALL_LAYER, source: WARNING_FOOTPRINT, type: 'fill',
        paint: { 'fill-color': '#b9c9f5', 'fill-opacity': 0, 'fill-opacity-transition': { duration: 0 }, 'fill-color-transition': { duration: 0 } } }, anchor);
      map.addLayer({ id: WARNING_FOOTPRINT, source: WARNING_FOOTPRINT, type: 'line',
        paint: { 'line-color': '#75e1e8', 'line-width': 2, 'line-dasharray': [3, 3], 'line-opacity': 0.85 } }, anchor);

      map.addSource(GAP_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer(
        {
          id: GAP_LAYER,
          type: 'fill',
          source: GAP_SOURCE,
          paint: {
            // The shared assessment removes only the area reached by deployed mobile coverage.
            'fill-color': ALERT,
            'fill-opacity': 0.28,
          },
        },
        anchor,
      );
      map.addLayer({ id: `${GAP_LAYER}-outline`, source: GAP_SOURCE, type: 'line',
        paint: { 'line-color': '#ff786e', 'line-width': 1.8, 'line-opacity': 0.9 } }, anchor);

      // Sector cones (retuned neighbour coverage) and the MOCN link line are
      // both illustrative response-phase geometry — real action, invented
      // geometry (spec §8, §9) — and sit below the anchor like the flood/gap
      // fills, since they describe ground-level coverage rather than a
      // tower mark.
      //
      // The legacy retune cones remain separate from mobile-network support.
      const overlayColor = '#000000';
      map.addSource(SECTOR_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer(
        {
          id: SECTOR_LAYER,
          type: 'fill',
          source: SECTOR_SOURCE,
          paint: {
            'fill-color': overlayColor,
            'fill-opacity': 0.10,
          },
        },
        anchor,
      );
      // No outline layer: at a dense outage cluster several cones overlap,
      // and a stroke per cone drew as a wire tangle on top of the fills
      // (the radial spoke pattern in review). The fill alone still reads as
      // a distinct cone shape against the red gap fill beneath it.

      map.addSource(MOCN_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer(
        {
          id: MOCN_LAYER,
          type: 'line',
          source: MOCN_SOURCE,
          layout: { 'line-cap': 'round' },
          paint: {
            'line-color': overlayColor,
            'line-width': 3,
            'line-opacity': 0.95,
            // Dashed for the same reason DispatchRoutePreview's connector is
            // dashed: this line asserts a network relationship, not a
            // physical path, and dashing keeps that honest at a glance.
            'line-dasharray': [1, 1.5],
          },
        },
        anchor,
      );

      // Full station range is only an outline. The green fill below is the
      // intersection with the outage gap, so overlapping ranges never darken it.
      map.addSource(COW_COVERAGE_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: COW_COVERAGE_LAYER, source: COW_COVERAGE_SOURCE, type: 'line',
        paint: { 'line-color': '#65ffce', 'line-width': 1.5, 'line-opacity': 0.45, 'line-dasharray': [3, 2] } }, anchor);
      map.addSource(SUPPORTED_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: SUPPORTED_SOURCE, source: SUPPORTED_SOURCE, type: 'fill',
        paint: { 'fill-color': '#13d9a4', 'fill-opacity': 0.46 } }, anchor);
      map.addLayer({ id: `${SUPPORTED_SOURCE}-outline`, source: SUPPORTED_SOURCE, type: 'line',
        paint: { 'line-color': '#65ffce', 'line-width': 2.5, 'line-opacity': 0.95 } }, anchor);
      for (const [source, label, color] of [[GAP_SOURCE, 'AWAITING MOBILE COVERAGE', '#ffaaa0'], [SUPPORTED_SOURCE, 'TEMPORARY NETWORK', '#8dffdc']]) {
        map.addLayer({ id: `${source}-label`, source, type: 'symbol',
          layout: { 'text-field': label, 'text-font': ['Noto Sans Bold'], 'text-size': 11, 'text-max-width': 16 },
          paint: { 'text-color': color, 'text-halo-color': '#102632', 'text-halo-width': 2 } });
      }

      // Towers are not ground (CLAUDE.md, "Towers are not ground and stay on
      // top") and belong ABOVE groundAnchor's labels, so this and the
      // down-tower marks below must NOT pass `anchor` as addLayer's
      // beforeId — that argument means "insert underneath this layer".
      map.addSource(TOWER_SOURCE, { type: 'geojson', data: towersToGeoJSON(towersRef.current) });
      // Same halo + icon pair the main map console draws (components/map/
      // towerLayer.ts) — "the tower icon/dot should follow the map tabs" —
      // rather than this map's own flat dot, so a tower reads identically
      // wherever it appears in the app.
      map.addLayer({
        id: TOWER_LAYER,
        type: 'circle',
        source: TOWER_SOURCE,
        maxzoom: TOWER_3D_HANDOFF_ZOOM,
        paint: towerPaint,
      });
      map.addSource(WARNING_SITES, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: WARNING_SITES, source: WARNING_SITES, type: 'circle', maxzoom: TOWER_3D_HANDOFF_ZOOM,
        paint: { 'circle-radius': 13, 'circle-color': 'transparent',
          'circle-stroke-color': ['case', ['==', ['get', 'secondary'], true], '#ffc66d', '#75e1e8'], 'circle-stroke-width': 2.5,
          'circle-radius-transition': { duration: 0 }, 'circle-stroke-opacity-transition': { duration: 0 } } });
      map.addSource(ASSESSMENT_LABELS, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: ASSESSMENT_LABELS, source: ASSESSMENT_LABELS, type: 'symbol',
        filter: ['==', ['get', 'secondary'], true],
        layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Bold'],
          'text-variable-anchor': ['left', 'right', 'top', 'bottom'], 'text-radial-offset': 2,
          'text-justify': 'auto', 'text-max-width': 15 },
        paint: { 'text-color': ['case', ['==', ['get', 'secondary'], true], '#ffd18a', '#a6f9ff'],
          'text-halo-color': '#102632', 'text-halo-width': 2 } });
      map.addLayer({ id: `${ASSESSMENT_LABELS}-flood`, source: ASSESSMENT_LABELS, type: 'symbol',
        filter: ['==', ['get', 'secondary'], false],
        layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Bold'],
          'text-anchor': 'right', 'text-offset': [-2, 0], 'text-max-width': 20, 'text-allow-overlap': true },
        paint: { 'text-color': '#a6f9ff', 'text-halo-color': '#102632', 'text-halo-width': 2 } });

      // Outage mark: spec §10 is explicit this must NOT be plain red (red is
      // the maintain band). A neutral desaturated ring plus a literal
      // OFFLINE text label carries it instead — shape and text, not hue.
      // UNSCORED_INK, not UNSCORED_COLOR: the ring stroke and text are both
      // thin marks/text (>=4.5:1 bar), and UNSCORED_COLOR was only ever
      // measured as a FILL (>=3:1) — the same two-ramp mistake bandColor()
      // vs bandInk() exists to prevent.
      map.addSource(DOWN_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({
        id: DOWN_RING_LAYER,
        type: 'circle',
        source: DOWN_SOURCE,
        paint: {
          'circle-radius': 9,
          'circle-color': 'transparent',
          'circle-stroke-width': 2.5,
          'circle-stroke-color': UNSCORED_INK,
        },
      });
      map.addLayer({
        id: DOWN_LABEL_LAYER,
        type: 'symbol',
        source: DOWN_SOURCE,
        layout: {
          'text-field': 'OFFLINE',
          'text-size': 10,
          'text-offset': [0, 1.3],
          'text-anchor': 'top',
          'text-font': ['Noto Sans Bold'],
          // Thin dense-cluster labels; every individual outage retains its ring.
          'text-allow-overlap': false,
          'text-ignore-placement': false,
        },
        paint: {
          'text-color': UNSCORED_INK,
          'text-halo-color': '#ffffff',
          'text-halo-width': 1.2,
        },
      });

      // Tower icon on top of the halo, same asset and gate as the main map
      // console (components/map/towerLayer.ts) — addLayer must run AFTER
      // addImage resolves, or MapLibre records the icon-image name with
      // nothing registered yet and silently never renders it.
      map
        .loadImage('/brand/tower-icon.png')
        .then(({ data: image }) => {
          if (mapRef.current !== map) return;
          if (!mapRef.current.hasImage(TOWER_ICON_IMAGE_ID)) {
            mapRef.current.addImage(TOWER_ICON_IMAGE_ID, image);
          }
          if (mapRef.current.getLayer(TOWER_ICON_LAYER)) return;
          mapRef.current.addLayer({
            id: TOWER_ICON_LAYER,
            type: 'symbol',
            source: TOWER_SOURCE,
            // Both 2D marks hand off together to the detailed Three.js mast.
            maxzoom: TOWER_3D_HANDOFF_ZOOM,
            layout: towerIconLayout,
            paint: towerIconPaint,
          });
        })
        .catch(() => {
          // Missing icon asset: the coloured halo alone still carries the
          // band reading, so this is not fatal to the map.
        });

      map.addSource(STAGING_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: STAGING_SOURCE, type: 'circle', source: STAGING_SOURCE,
        paint: { 'circle-radius': 8, 'circle-color': '#102632', 'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 3 } });
      map.addLayer({ id: `${STAGING_SOURCE}-labels`, type: 'symbol', source: STAGING_SOURCE,
        layout: { 'text-field': ['get', 'label'], 'text-size': 10, 'text-font': ['Noto Sans Bold'],
          'text-variable-anchor': ['left', 'right', 'bottom', 'top'], 'text-radial-offset': 1.8, 'text-max-width': 16 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#102632', 'text-halo-width': 2 } });
      map.addSource(FLEET_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: FLEET_SOURCE, type: 'circle', source: FLEET_SOURCE, maxzoom: RESPONSE_VEHICLE_3D_ZOOM,
        paint: { 'circle-radius': 13, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#102632', 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: `${FLEET_SOURCE}-labels`, type: 'symbol', source: FLEET_SOURCE,
        layout: { 'text-field': ['get', 'label'], 'text-size': 11, 'text-font': ['Noto Sans Bold'],
          'text-anchor': 'bottom', 'text-offset': [0, -1.8], 'text-max-width': 18 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#102632', 'text-halo-width': 2 } });
      // Network service crews use equipment trucks; PRIME launch vehicles use jeeps.
      const stationIcon = document.createElement('canvas');
      stationIcon.width = stationIcon.height = 96;
      const ink = stationIcon.getContext('2d');
      if (ink) {
        ink.lineJoin = ink.lineCap = 'round';
        ink.fillStyle = '#f4fffd'; ink.strokeStyle = '#163441'; ink.lineWidth = 4;
        ink.beginPath(); ink.roundRect(12, 30, 47, 35, 4); ink.fill(); ink.stroke();
        ink.beginPath(); ink.roundRect(59, 45, 24, 20, 3); ink.fill(); ink.stroke();
        ink.fillStyle = '#163441'; ink.fillRect(63, 48, 14, 9);
        for (const x of [27, 69]) {
          ink.beginPath(); ink.arc(x, 67, 7, 0, Math.PI * 2); ink.fill();
          ink.strokeStyle = '#f4fffd'; ink.lineWidth = 2; ink.stroke();
        }
        map.addImage(BASE_STATION_ICON_ID, ink.getImageData(0, 0, 96, 96), { pixelRatio: 2 });
        map.addLayer({ id: `${FLEET_SOURCE}-base-stations`, type: 'symbol', source: FLEET_SOURCE, maxzoom: RESPONSE_VEHICLE_3D_ZOOM,
          filter: ['==', ['get', 'kind'], 'network-crew'],
          layout: { 'icon-image': BASE_STATION_ICON_ID, 'icon-size': 0.8, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      }
      map.loadImage('/brand/jeep.png').then(({ data }) => {
        if (mapRef.current !== map) return;
        if (!map.hasImage(VEHICLE_ICON_ID)) map.addImage(VEHICLE_ICON_ID, data);
        map.addLayer({ id: `${FLEET_SOURCE}-vehicles`, type: 'symbol', source: FLEET_SOURCE, maxzoom: RESPONSE_VEHICLE_3D_ZOOM,
          filter: ['!=', ['get', 'kind'], 'network-crew'],
          layout: { 'icon-image': VEHICLE_ICON_ID, 'icon-size': 26 / 512, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      }).catch(() => { /* The coloured vehicle marker remains if its decorative asset fails. */ });

      map.addSource(DEVICE_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: DEVICE_SOURCE, type: 'circle', source: DEVICE_SOURCE,
        paint: { 'circle-radius': 16, 'circle-color': '#123b35', 'circle-stroke-color': '#65ffce', 'circle-stroke-width': 3 } });
      const deviceIcon = document.createElement('canvas');
      deviceIcon.width = deviceIcon.height = 64;
      const radio = deviceIcon.getContext('2d');
      if (radio) {
        radio.lineCap = radio.lineJoin = 'round';
        radio.fillStyle = '#f4fffd'; radio.strokeStyle = '#123b35'; radio.lineWidth = 3;
        radio.beginPath(); radio.roundRect(20, 40, 24, 16, 3); radio.fill(); radio.stroke();
        radio.strokeStyle = '#f4fffd'; radio.lineWidth = 4;
        radio.beginPath(); radio.moveTo(32, 42); radio.lineTo(32, 18); radio.stroke();
        for (const radius of [12, 22]) {
          radio.beginPath(); radio.arc(32, 20, radius, -0.7, 0.7); radio.stroke();
          radio.beginPath(); radio.arc(32, 20, radius, Math.PI - 0.7, Math.PI + 0.7); radio.stroke();
        }
        radio.fillStyle = '#65ffce'; radio.beginPath(); radio.arc(32, 18, 4, 0, Math.PI * 2); radio.fill();
        map.addImage(DEVICE_ICON_ID, radio.getImageData(0, 0, 64, 64), { pixelRatio: 2 });
        map.addLayer({ id: `${DEVICE_SOURCE}-icon`, type: 'symbol', source: DEVICE_SOURCE,
          layout: { 'icon-image': DEVICE_ICON_ID, 'icon-size': 1, 'icon-allow-overlap': true, 'icon-ignore-placement': true } });
      }
      map.addLayer({ id: `${DEVICE_SOURCE}-labels`, type: 'symbol', source: DEVICE_SOURCE,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
          'text-variable-anchor': ['top', 'left', 'right', 'bottom'], 'text-radial-offset': 1.9 },
        paint: { 'text-color': '#8dffdc', 'text-halo-color': '#102632', 'text-halo-width': 2 } });

      // PRIME drone relay. Added last of the response marks so it paints
      // ABOVE the coverage circle it carries — the drone is the thing
      // providing that coverage, and a circle drawn over it would read as
      // the relay sitting under its own footprint.
      map.addSource(DRONE_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      // A ring under the icon, so the relay is still locatable while the
      // artwork is loading and if it fails to load at all.
      map.addLayer({ id: DRONE_SOURCE, type: 'circle', source: DRONE_SOURCE,
        paint: { 'circle-radius': 11, 'circle-color': '#1b3a52', 'circle-opacity': 0.85,
          'circle-stroke-color': ['get', 'color'], 'circle-stroke-width': 2.5 } });
      map.addLayer({ id: `${DRONE_SOURCE}-labels`, type: 'symbol', source: DRONE_SOURCE,
        layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Bold'], 'text-size': 11,
          'text-anchor': 'bottom', 'text-offset': [0, -2.1], 'text-max-width': 18 },
        paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#102632', 'text-halo-width': 2 } });
      map.loadImage(DRONE_ICON_URL).then(({ data }) => {
        if (mapRef.current !== map) return;
        if (!map.hasImage(DRONE_ICON_ID)) map.addImage(DRONE_ICON_ID, data);
        if (map.getLayer(`${DRONE_SOURCE}-icon`)) return;
        map.addLayer({ id: `${DRONE_SOURCE}-icon`, type: 'symbol', source: DRONE_SOURCE,
          layout: { 'icon-image': DRONE_ICON_ID, 'icon-size': DRONE_ICON_SIZE_PX / DRONE_ICON_SOURCE_PX,
            'icon-allow-overlap': true, 'icon-ignore-placement': true },
        }, `${DRONE_SOURCE}-labels`);
      }).catch(() => { /* The ring above stays if the decorative asset fails. */ });

      map.addSource(GENERATOR_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });

      const addGeneratorLayer = () => {
        if (map.getLayer(GENERATOR_ICON_LAYER)) return;
        map.addLayer({
          id: GENERATOR_ICON_LAYER,
          type: 'symbol',
          source: GENERATOR_SOURCE,
          layout: {
            'icon-image': GENERATOR_ICON_ID,
            'icon-size': GENERATOR_ICON_SIZE_PX / GENERATOR_ICON_SOURCE_PX,
            'icon-offset': [220, -110],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
            // A crowded label must never suppress the generator itself.
            'text-optional': true,
            'text-field': 'GENERATOR · ONLINE',
            'text-size': 10,
            'text-font': ['Noto Sans Bold'],
            'text-anchor': 'top',
            'text-offset': [2.9, 0.5],
          },
          paint: { 'text-color': '#8dffdc', 'text-halo-color': '#102632', 'text-halo-width': 2 },
        }, DRONE_SOURCE);
      };

      if (map.hasImage(GENERATOR_ICON_ID)) {
        addGeneratorLayer();
      } else {
        map
          .loadImage(GENERATOR_ICON_URL)
          .then((result) => {
            if (mapRef.current !== map || map.hasImage(GENERATOR_ICON_ID)) return;
            mapRef.current.addImage(GENERATOR_ICON_ID, result.data);
            addGeneratorLayer();
          })
          .catch(() => {
            // Icon asset missing is a static-asset problem, not a reason to
            // fail the whole map — the console line still says generators
            // were pre-positioned even without the glyph.
          });
      }

      // Measured road paths are draped by MapLibre, retaining every mapped bend.
      map.addSource(RIVER_SOURCE, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: RIVER_SOURCE, type: 'line', source: RIVER_SOURCE,
        paint: { 'line-color': '#3ca9d5', 'line-width': 1, 'line-opacity': 0.65 } }, anchor);
      map.addSource(ROAD_SOURCE, { type: 'geojson', data: emptyFeatureCollection(), tolerance: 0 });
      map.addLayer({ id: `${ROAD_SOURCE}-casing`, type: 'line', source: ROAD_SOURCE,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#112c39', 'line-width': 7, 'line-opacity': 0.95 } }, anchor);
      map.addLayer({ id: ROAD_SOURCE, type: 'line', source: ROAD_SOURCE,
        filter: ['!=', ['get', 'exit'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': ['case', ['==', ['get', 'kind'], 'mobile-network'], 4.5, 3.5], 'line-opacity': 0.95 } }, anchor);
      map.addLayer({ id: `${ROAD_SOURCE}-exit`, type: 'line', source: ROAD_SOURCE,
        filter: ['==', ['get', 'exit'], true],
        paint: { 'line-color': '#ffdf59', 'line-width': 5, 'line-dasharray': [2, 1.5],
          'line-opacity': 1, 'line-opacity-transition': { duration: 0 } } }, anchor);
      map.addLayer({ id: `${ROAD_SOURCE}-exit-arrows`, type: 'symbol', source: ROAD_SOURCE,
        filter: ['==', ['get', 'exit'], true],
        layout: { 'symbol-placement': 'line', 'symbol-spacing': 70, 'text-field': '❯',
          'text-font': ['Noto Sans Bold'], 'text-size': 18, 'text-keep-upright': false },
        paint: { 'text-color': '#ffdf59', 'text-halo-color': '#112c39', 'text-halo-width': 2 } });
      map.addSource(BLOCKED_ROAD_SOURCE, { type: 'geojson', data: emptyFeatureCollection(), tolerance: 0 });
      map.addLayer({ id: `${BLOCKED_ROAD_SOURCE}-casing`, type: 'line', source: BLOCKED_ROAD_SOURCE,
        paint: { 'line-color': '#381921', 'line-width': 9 } }, anchor);
      map.addLayer({ id: BLOCKED_ROAD_SOURCE, type: 'line', source: BLOCKED_ROAD_SOURCE,
        paint: { 'line-color': '#ff6b62', 'line-width': 5, 'line-dasharray': [1, 0.6] } }, anchor);
      map.addSource(`${BLOCKED_ROAD_SOURCE}-markers`, { type: 'geojson', data: emptyFeatureCollection() });
      map.addLayer({ id: `${BLOCKED_ROAD_SOURCE}-marker`, type: 'circle', source: `${BLOCKED_ROAD_SOURCE}-markers`,
        paint: { 'circle-color': '#ff6b62', 'circle-radius': 6, 'circle-stroke-color': '#fff4ec', 'circle-stroke-width': 2 } });
      map.addLayer({ id: `${BLOCKED_ROAD_SOURCE}-label`, type: 'symbol', source: `${BLOCKED_ROAD_SOURCE}-markers`,
        layout: { 'text-field': ['concat', 'ROAD CLOSED\n', ['get', 'name']], 'text-size': 11,
          'text-font': ['Noto Sans Regular'], 'text-anchor': 'bottom', 'text-offset': [0, -1], 'text-allow-overlap': true },
        paint: { 'text-color': '#fff5ef', 'text-halo-color': '#702b2c', 'text-halo-width': 2 } });
      map.addLayer(createSimulationThreeLayer(() => snapshotRef.current));
      // Dropped equipment must remain legible above 3D geometry and road-closure marks.
      // The drone rides last of all: it is airborne, so anything painting
      // over it would read as the relay flying under the ground it covers.
      for (const id of [DEVICE_SOURCE, `${DEVICE_SOURCE}-icon`, `${DEVICE_SOURCE}-labels`, GENERATOR_ICON_LAYER,
        DRONE_SOURCE, `${DRONE_SOURCE}-icon`, `${DRONE_SOURCE}-labels`]) {
        if (map.getLayer(id)) map.moveLayer(id);
      }
      setReady(true);
      if (import.meta.env.DEV) (window as unknown as { __simulationMap?: MaplibreMap }).__simulationMap = map;
    });

    return () => {
      resize.disconnect();
      map.off('error', showInitialStyleError);
      map.off('webglcontextlost', loseContext);
      map.off('webglcontextrestored', restoreContext);
      map.remove();
      if (import.meta.env.DEV) delete (window as unknown as { __simulationMap?: MaplibreMap }).__simulationMap;
      mapRef.current = null;
      setReady(false);
    };
    // Recreate only after an explicit retry or WebGL restoration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapAttempt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setLayoutProperty(SATELLITE_LAYER, 'visibility', satellite ? 'visible' : 'none');
    map.setPaintProperty(DOWN_RING_LAYER, 'circle-stroke-color', satellite ? '#f2f5f4' : UNSCORED_INK);
    map.setPaintProperty(DOWN_LABEL_LAYER, 'text-color', satellite ? '#f2f5f4' : UNSCORED_INK);
    map.setPaintProperty(DOWN_LABEL_LAYER, 'text-halo-color', satellite ? '#24343d' : '#ffffff');
    map.setPaintProperty(MOCN_LAYER, 'line-color', satellite ? '#ffffff' : '#24343d');
    for (const label of basemapLabels.current) {
      map.setPaintProperty(label.id, 'text-color', satellite ? '#f5f7ed' : label.paint?.['text-color']);
      map.setPaintProperty(label.id, 'text-halo-color', satellite ? '#203b35' : label.paint?.['text-halo-color']);
      map.setPaintProperty(label.id, 'text-halo-width', satellite ? 1.5 : label.paint?.['text-halo-width']);
    }
  }, [ready, satellite]);

  // Live tower refreshes update the source without moving the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(TOWER_SOURCE);
    if (source && 'setData' in source) {
      (source as GeoJSONSource).setData(towersToGeoJSON(sabahTowers));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sabahTowers]);

  const floodPolygon = status === 'idle' ? null : floodExtentAt(elapsedMs);
  useEffect(() => {
    if (!ready) return;
    const source = mapRef.current?.getSource(FLOOD_SOURCE) as GeoJSONSource | undefined;
    source?.setData({ type: 'FeatureCollection', features: floodPolygon
      ? [{ type: 'Feature', properties: {}, geometry: floodPolygon }] : [] });
  }, [ready, floodPolygon]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // Response geometry stays visible across analysis views; source data gates its phase.
    map.setLayoutProperty(FLOOD_LAYER, 'visibility', mode === 'rain' || mode === 'soil' || (mode === 'warnings' && warning !== 'flood') ? 'none' : 'visible');
  }, [ready, mode, warning]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const visible = mode === 'combined' || mode === 'rain' || (mode === 'warnings' && warning === 'rain');
    map.setPaintProperty(RAINFALL_LAYER, 'fill-color', ['interpolate', ['linear'], rainIntensity,
      0, '#b9c9f5', 0.5, '#7f7ada', 1, '#49318c']);
    map.setPaintProperty(RAINFALL_LAYER, 'fill-opacity', visible
      ? (0.1 + rainIntensity * (mode === 'combined' ? 0.22 : 0.41)) * Math.min(1, rainIntensity / 0.12) : 0);
  }, [ready, mode, warning, rainIntensity]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const rainfall = mode === 'combined' || mode === 'rain' || (mode === 'warnings' && warning === 'rain');
    const polygon = rainfall ? warningTime < 96_000 ? SABAH_FLOOD_SCENARIO.floodExtents[1].polygon : null
      : mode === 'warnings' && warning === 'flood'
        ? warningTime < 24_000 ? SABAH_FLOOD_SCENARIO.floodExtents[1].polygon : floodExtentAt(warningTime) : null;
    (map.getSource(WARNING_FOOTPRINT) as GeoJSONSource).setData({ type: 'FeatureCollection', features: polygon
      ? [{ type: 'Feature', properties: {}, geometry: polygon }] : [] });
    const points = downTowerPoints(sabahTowers, new Set(mode === 'warnings' || mode === 'combined' ? warningSiteIds : []));
    for (const feature of points.features) feature.properties = { ...feature.properties,
      secondary: mode === 'combined' && peakAssessment.nearbyPrioritySiteIds.includes(feature.properties?.tower_id) };
    (map.getSource(WARNING_SITES) as GeoJSONSource).setData(points);
    const labels: Feature<Point>[] = [];
    if (mode === 'combined' && warningTime >= FLOOD_PRIORITY_MS && warningTime < 54_000) {
      if (floodBounds) labels.push({ type: 'Feature', properties: { label: 'FIRST · FLOOD RESPONSE', secondary: false },
        geometry: { type: 'Point', coordinates: [(floodBounds.west + floodBounds.east) / 2, (floodBounds.south + floodBounds.north) / 2] } });
      for (const tower of showLaterMaintenance ? sabahTowers.filter(t => peakAssessment.nearbyPrioritySiteIds.includes(t.tower_id)) : []) {
        labels.push({ type: 'Feature', properties: { label: 'LATER · MAINTENANCE', secondary: true },
          geometry: { type: 'Point', coordinates: [tower.lon, tower.lat] } });
      }
    }
    (map.getSource(ASSESSMENT_LABELS) as GeoJSONSource).setData({ type: 'FeatureCollection', features: labels });
  }, [ready, mode, warning, warningTime, sabahTowers, warningSiteIds, peakAssessment, floodBounds, showLaterMaintenance]);

  const assessmentPulse = simulationAssessmentPulseAt(Math.floor(elapsedMs / 33) * 33, Boolean(shouldReduceMotion));
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(WARNING_SITES, 'circle-stroke-opacity', ['case', ['==', ['get', 'secondary'], true], assessmentPulse, 1]);
    map.setPaintProperty(WARNING_SITES, 'circle-radius', ['case', ['==', ['get', 'secondary'], true], 13 + (1 - assessmentPulse) * 7, 13]);
  }, [ready, assessmentPulse]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(WARNING_SITES, 'circle-stroke-color', ['case', ['==', ['get', 'secondary'], true],
      satellite ? '#ffc66d' : '#98520b', satellite ? '#75e1e8' : '#087d91']);
  }, [ready, satellite]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const network = roads.network;
    (map.getSource(RIVER_SOURCE) as GeoJSONSource).setData(network?.rivers ?? emptyFeatureCollection());
    (map.getSource(BLOCKED_ROAD_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection',
      features: network?.roads.features.filter(feature => roads.blocked.includes(feature.properties.edge_id)) ?? [] });
    const closedWays = new Map(network?.roads.features.filter(feature => roads.blocked.includes(feature.properties.edge_id)).map(feature => [feature.properties.way_id, feature]));
    const markers: Feature<Point>[] = [...closedWays.values()].map(feature => ({ type: 'Feature', properties: { name: feature.properties.name },
      geometry: { type: 'Point', coordinates: feature.geometry.coordinates[0] } }));
    (map.getSource(`${BLOCKED_ROAD_SOURCE}-markers`) as GeoJSONSource).setData({ type: 'FeatureCollection', features: markers });
    const features: Feature<LineString>[] = fleetVisible ? roads.legs.filter((leg, index) => leg.road?.status === 'routed' && leg.road.coordinates.length >= 2
      && !roads.legs.slice(0, index).some(previous => (previous.unitId ?? previous.crewId) === (leg.unitId ?? leg.crewId)
        && previous.entry.day === leg.entry.day && previous.road?.status !== 'routed')).map(leg => ({
      type: 'Feature', properties: { id: leg.id, color: responseUnitColor(leg.unitId ?? leg.crewId), kind: leg.unitKind ?? 'repair' },
      geometry: { type: 'LineString', coordinates: leg.road!.coordinates },
    })) : [];
    if (hardeningVisible && exitRouteVisible) {
      for (const leg of roads.legs) {
        const departure = leg.road?.departure_route;
        if (leg.road?.status === 'routed' && departure?.status === 'routed' && departure.coordinates.length >= 2) features.push({
          type: 'Feature', properties: { id: `${leg.id}:departure`, color: '#ffdf59', kind: leg.unitKind, exit: true },
          geometry: { type: 'LineString', coordinates: departure.coordinates },
        });
      }
    }
    (map.getSource(ROAD_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    const staging: Feature<Point>[] = responseVisible ? roadUnits.flatMap(unit => {
      if (unit.legs[0]?.unitKind !== 'mobile-network') return [];
      const point = unit.legs[0]?.road?.staging;
      return point ? [{ type: 'Feature' as const,
        properties: { color: unit.color, label: `OUTSIDE FLOOD · ${unit.legs[0].unitLabel ?? unit.id}` },
        geometry: { type: 'Point' as const, coordinates: [point.lon, point.lat] } }] : [];
    }) : [];
    (map.getSource(STAGING_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: staging });
    map.triggerRepaint();
  }, [ready, roads.network, roads.blocked, roads.legs, responseVisible, fleetVisible, hardeningVisible, exitRouteVisible, roadUnits]);

  const exitReveal = Math.max(0, Math.min(1, (Math.floor(elapsedMs / 100) * 100 - 19_000) / 1_500));
  useEffect(() => {
    if (!ready) return;
    mapRef.current?.setPaintProperty(`${ROAD_SOURCE}-exit`, 'line-opacity', exitReveal);
  }, [ready, exitReveal]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.setPaintProperty(RIVER_SOURCE, 'line-width', ['*', 0.65 + simulationEnvironmentAt(warningTime).river * 0.65,
      ['interpolate', ['linear'], ['zoom'], 9, ['case', ['==', ['get', 'waterway'], 'river'], 1.2, 0.25],
        14, ['case', ['==', ['get', 'waterway'], 'river'], 3, 1.1], 18, 4]]);
  }, [ready, warningTime]);

  // Generator sites stay online throughout the flood; withdraw after restoration.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(GENERATOR_SOURCE);
    if (!source || !('setData' in source)) return;
    const visible =
      status !== 'idle' && elapsedMs >= GENERATOR_PREPOSITION_MS && elapsedMs < WITHDRAW_MS;
    if (!visible) {
      (source as GeoJSONSource).setData(emptyFeatureCollection());
      return;
    }
    const sites = towersRef.current.filter((t) => generatorSiteIds.has(t.tower_id));
    const features: Feature<Point>[] = sites.map((t) => ({
      type: 'Feature',
      properties: { tower_id: t.tower_id },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    }));
    (source as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status, elapsedMs >= GENERATOR_PREPOSITION_MS, elapsedMs < WITHDRAW_MS, generatorSiteIds, sabahTowers]);

  // Outage marks + coverage-gap footprints. Both are driven off the same
  // §0.6-firewalled downTowerIds set, but ONLY inside the tower-down window
  // — `downTowerIds` is populated at Start (elapsedMs 0) so the backend
  // beats and the closing summary have the scenario premise available
  // early, but the 'tower-down' beat itself does not fire until T-0
  // (TOWER_DOWN_MS), and 'restore' at TOWER_RESTORE_MS brings it back. This
  // effect used to render the OFFLINE ring from frame one regardless of
  // elapsed time, so a tower read as down during the pre-event narration —
  // before the flood extent had even appeared — which is exactly the
  // "how is it offline before the flood happened" bug a domain reviewer
  // would catch immediately.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const downSource = map.getSource(DOWN_SOURCE);
    const inWindow = status !== 'idle' && elapsedMs >= TOWER_DOWN_MS && elapsedMs < TOWER_RESTORE_MS;
    const visibleIds = inWindow ? downTowerIds : EMPTY_TOWER_IDS;
    if (downSource && 'setData' in downSource) {
      (downSource as GeoJSONSource).setData(downTowerPoints(sabahTowers, visibleIds));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status, elapsedMs >= TOWER_DOWN_MS, elapsedMs < TOWER_RESTORE_MS, sabahTowers, downTowerIds]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource(GAP_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: roads.coverage.remaining ? [roads.coverage.remaining] : [] });
    (map.getSource(SUPPORTED_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: roads.coverage.supported ? [roads.coverage.supported] : [] });
  }, [ready, roads.coverage.remaining, roads.coverage.supported]);

  // Use the exact playback time so seeking to a dispatch boundary shows its vehicles.
  const fleetTime = elapsedMs;

  // Shared missions size the relay fleet to the full outage footprint and retain each home vehicle.
  const droneUnits = useMemo(() => roads.coverage.missions.flatMap(mission => {
    const drone = droneFlightAt(fleetTime, mission.staging, mission.hover, Boolean(shouldReduceMotion));
    if (!drone) return [];
    const state = drone.phase === 'outbound' ? 'DRONE OUTBOUND'
      : drone.phase === 'on-station' ? 'RELAY ON STATION'
      : drone.phase === 'inbound' ? 'DRONE RETURNING' : 'DRONE LANDED';
    return [{ ...mission, color: responseUnitColor(mission.unitId), drone, state }];
  }), [roads.coverage.missions, fleetTime, shouldReduceMotion]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    // Draw the combined reach once, without a tangle of overlapping circle outlines.
    (map.getSource(COW_COVERAGE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection',
      features: roads.coverage.reach ? [roads.coverage.reach] : [] });
    (map.getSource(DEVICE_SOURCE) as GeoJSONSource).setData(emptyFeatureCollection());
    const drones: Feature<Point>[] = droneUnits.map(unit => ({
      type: 'Feature',
      properties: { unit_id: unit.id, parent_unit_id: unit.unitId, color: unit.color, label: `${unit.label}\n${unit.state}` },
      geometry: { type: 'Point', coordinates: [unit.drone.position.lon, unit.drone.position.lat] },
    }));
    (map.getSource(DRONE_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: drones });
  }, [ready, droneUnits, roads.coverage.reach]);

  // Timeline-derived poses remain correct on pause, speed changes and backward seek.
  const retuneProgress = shouldReduceMotion ? RETUNE_STILL_T
    : Math.max(0, Math.min(1, Math.floor((elapsedMs - RETUNE_START_MS) / 33) * 33 / RETUNE_SWING_MS));
  const retuneAssignments = useMemo(() => assignRetuningNeighbors(
    sabahTowers.filter((tower) => downTowerIds.has(tower.tower_id)), sabahTowers, downTowerIds,
  ), [sabahTowers, downTowerIds]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(SECTOR_SOURCE) as GeoJSONSource | undefined;
    if (!source) return;
    const visible = status !== 'idle' && elapsedMs >= RETUNE_START_MS && elapsedMs < WITHDRAW_MS;
    const features: Feature<Polygon>[] = visible ? retuneAssignments.flatMap(({ downTower, neighbors }) =>
      neighbors.map((neighbor) => ({
        type: 'Feature', properties: { tower_id: neighbor.tower_id },
        geometry: sectorPolygon(neighbor, retuneBearingAt(neighbor, downTower, retuneProgress), SECTOR_WIDTH_DEG, SECTOR_RADIUS_KM),
      })),
    ) : [];
    source.setData({ type: 'FeatureCollection', features });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status, elapsedMs >= RETUNE_START_MS, elapsedMs < WITHDRAW_MS, retuneProgress, retuneAssignments]);

  // MOCN link: a dashed line between the down tower and its nearest
  // surviving neighbour, standing for a cross-operator failover (spec §6
  // 'mocn' beat). Illustrative attribution — real practice, invented "which
  // operator" (spec §8, `docs/Disaster_Response_Actions.md`).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const source = map.getSource(MOCN_SOURCE);
    if (!source || !('setData' in source)) return;
    const geoSource = source as GeoJSONSource;

    const inWindow = status !== 'idle' && elapsedMs >= MOCN_START_MS && elapsedMs < WITHDRAW_MS;
    const downTowers = towersRef.current.filter((t) => downTowerIds.has(t.tower_id));
    if (!inWindow || downTowers.length === 0) {
      geoSource.setData(emptyFeatureCollection());
      return;
    }
    // One link per down tower, to ITS OWN nearest surviving neighbour — same
    // per-outage assignment as the sector-cone effect above, not one line
    // from a single shared down tower (which drew every failover as if only
    // one tower had failed).
    const lines: Feature<LineString>[] = retuneAssignments
      .filter(({ neighbors }) => neighbors.length > 0)
      .map(({ downTower, neighbors }) => ({
        type: 'Feature',
        properties: { tower_id: downTower.tower_id },
        geometry: {
          type: 'LineString',
          coordinates: [
            [downTower.lon, downTower.lat],
            [neighbors[0].lon, neighbors[0].lat],
          ],
        },
      }));
    geoSource.setData({ type: 'FeatureCollection', features: lines });
    // Keyed on the WINDOW BOOLEANS, not raw elapsedMs — line geometry never
    // changes once inside the window (same fixed tower pairs), so there is
    // nothing to redraw every animation frame. Raw elapsedMs would call
    // setData ~60x/sec for unchanging lines, the same per-frame churn the
    // flood-extent effect's ref guard exists to avoid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, status, elapsedMs >= MOCN_START_MS, elapsedMs < WITHDRAW_MS, downTowerIds, retuneAssignments]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const vehicles: Feature<Point>[] = [];
    for (const unit of fleetVisible ? roadUnits : []) {
      // `emergency` is the unit's own nature, not a constant: a hardening
      // convoy drives in the pre-event window and passing `true` for it
      // would put it through the response branch's 54s gate and return null.
      const hardening = unit.legs[0]?.unitKind === 'hardening';
      const motion = simulationRoadCrewAt(fleetTime, !hardening, unit.legs, Boolean(shouldReduceMotion));
      if (!motion || (hardening && motion.held)) continue;
      const paths = roadPaths.get(motion.leg.id);
      const path = motion.returning ? paths?.departure : paths?.inbound;
      const point = motion.held ? roadHoldPoint(unit.legs, motion.leg)
        : path ? roadPositionAt(path, motion.travel) : null;
      if (!point) continue;
      const network = motion.leg.unitKind === 'mobile-network';
      const state = motion.held ? 'ACCESS HOLD'
        : hardening ? motion.working ? 'MAINTENANCE · EXIT ROUTE READY'
          : motion.returning ? motion.travel === 1 ? 'CLEAR OF FLOOD AREA' : 'EXITING · FOLLOW YELLOW ROUTE' : 'TO MAINTENANCE SITE'
        : network ? fleetTime < DRONE_LAUNCH_MS ? 'PRIME · FIXED LAUNCH POSITION'
          : fleetTime < 88_000 ? 'PRIME · HOLDING DRONE LINK' : 'PRIME · RECEIVING OWN DRONE'
        : motion.staged ? 'HOLDING · INITIAL FLOOD EDGE'
        : motion.travel === 1 ? 'HOLDING · NORTHERN FLOOD EDGE' : 'LONGER DRY-ROAD APPROACH · NORTH EDGE';
      vehicles.push({ type: 'Feature', properties: { unit_id: unit.id, color: unit.color, kind: motion.leg.unitKind ?? 'repair',
        label: `${motion.leg.unitLabel ?? unit.id}\n${state}` },
        geometry: { type: 'Point', coordinates: [point.lon, point.lat] } });
    }
    (map.getSource(FLEET_SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: vehicles });
  }, [ready, fleetTime, fleetVisible, roadUnits, roadPaths, shouldReduceMotion]);

  // Freeze assignment geography per solver result: live tower refreshes must not redirect a shot.
  const routeFrames = useRef<{
    run: number;
    response?: { id: string; west: number; south: number; east: number; north: number };
  }>({ run: -1 });
  // One camera timeline, like the scene: no wall-clock transitions survive a pause or seek.
  const cameraTime = Math.floor(elapsedMs / 33) * 33;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    map.triggerRepaint();
    if (!cinematic) return;
    if (status !== 'running') map.stop();
    const live = snapshotRef.current;
    if (routeFrames.current.run !== runSeq) routeFrames.current = { run: runSeq };
    if (live.roadEmergency) {
      const mapped = live.roadLegs.filter(leg => leg.road?.status === 'routed');
      const geometryKey = `${live.emergencyRun?.run_id}:${live.roadLegs.map(leg => `${leg.id}:${leg.road?.status}:${leg.road?.distance_km}:${leg.road?.departure_route?.distance_km}`).join('|')}`;
      if (routeFrames.current.response?.id !== geometryKey) {
        const staging = live.roadLegs.flatMap(leg => leg.road?.staging ? [leg.road.staging] : []);
        const vertices = mapped.flatMap(leg => [...leg.road!.coordinates,
          ...(leg.road!.departure_route?.status === 'routed' ? leg.road!.departure_route.coordinates : [])].map(([lon, lat]) => ({ lon, lat })));
        const box = boundsOf([...vertices, ...staging]);
        if (box) routeFrames.current.response = { id: geometryKey, ...box };
      }
    }
    const canvas = map.getCanvas();
    const fit = Math.min(0, Math.log2(Math.max(240, Math.min(canvas.clientWidth, canvas.clientHeight * 1.5)) / 760));
    const overview = (box: ReturnType<typeof boundsOf> | undefined, framing: 'default' | 'comparison' | 'flood' | 'response' = 'default') => {
      const comparison = framing === 'comparison';
      const flood = framing === 'flood';
      const response = framing === 'response';
      const camera = box ? map.cameraForBounds([[box.west, box.south], [box.east, box.north]], {
        bearing: response ? 32 : -12, pitch: response ? 54 : comparison ? 60 : 52, maxZoom: 12.2,
        // Fleet fitting uses its actual viewing angle; pitch leaves room above and below the road corridor.
        padding: { top: Math.min(response ? 40 : flood ? 100 : comparison ? 80 : 150, canvas.clientHeight * 0.24), bottom: Math.min(response || flood ? 80 : comparison ? 100 : 220, canvas.clientHeight * 0.3),
          left: Math.min(110, canvas.clientWidth * 0.15), right: Math.min(80, canvas.clientWidth * 0.1) },
      }) : null;
      return { center: camera?.center ? LngLat.convert(camera.center).toArray() : [detailSite.lon, detailSite.lat] as [number, number],
        zoom: camera?.zoom !== undefined ? camera.zoom - fit : 12.2 };
    };
    const pose = simulationCameraAt(cameraTime, {
      site: [detailSite.lon, detailSite.lat], maintenance: overview(maintenanceBounds ?? floodBounds), assessment: overview(assessmentBounds, 'comparison'),
      flood: overview(floodBounds, 'flood'), response: overview(routeFrames.current.response ?? floodBounds, 'response'),
    }, Boolean(shouldReduceMotion));
    // Closeups preserve the mast between the story caption and the lower legend.
    map.jumpTo({ ...pose, zoom: pose.zoom + fit,
      padding: { top: 0, bottom: 0, left: Math.min(180, canvas.clientWidth * 0.2), right: 0 } });
  }, [ready, cameraTime, status, cinematic, shouldReduceMotion, viewportRevision, runSeq, optimizeRun?.run_id, emergencyRun?.run_id, detailSite, roads.legs, roads.emergency, roads.network, assessmentBounds, maintenanceBounds, floodBounds]);

  const selectView = (view: 'overview' | 'detail' | 'top' | 'warnings') => {
    const map = mapRef.current;
    if (!map || !ready) return;
    onCinematicChange(false);
    if (view === 'warnings') {
      const box = boundsOf(sabahTowers.filter((tower) => warningSiteIds.includes(tower.tower_id)));
      if (!box) return;
      const height = map.getCanvas().clientHeight;
      map.fitBounds([[box.west, box.south], [box.east, box.north]], {
        maxZoom: 14, pitch: 45, bearing: -12,
        padding: { top: Math.min(140, height * 0.24), bottom: Math.min(340, height * 0.48), left: 40, right: 40 },
        duration: shouldReduceMotion ? 0 : 1_800,
      });
      return;
    }
    const fit = Math.min(0, Math.log2(Math.max(240, map.getCanvas().clientWidth) / 760));
    map.easeTo({
      center: view === 'detail' ? [detailSite.lon, detailSite.lat] : [116.095, 6.011],
      zoom: (view === 'detail' ? 15 : view === 'top' ? 11.4 : 11.05) + fit,
      pitch: view === 'top' ? 0 : 60, bearing: view === 'detail' ? -24 : -12,
      padding: { top: 0, bottom: 0, left: Math.min(180, map.getCanvas().clientWidth * 0.2), right: 0 },
      duration: shouldReduceMotion ? 0 : 1_800,
    });
  };

  useEffect(() => { mapRef.current?.triggerRepaint(); }, [mode, warning, warningSiteIds, sabahTowers, crews, optimizeRun, emergencyRun, downTowerIds]);

  return (
    <div className="relative h-full w-full overflow-hidden" role="region"
      aria-label="Interactive 3D map of Sabah flood scenario, risk factors and crew response">
      <div ref={containerRef} className="h-full w-full" />
      {!mapFailure && <div className="sim-view-presets" aria-label="Map views">
        <div className="sim-view-presets__views" role="group" aria-label="Camera presets">
          {mode === 'warnings' && <button type="button" disabled={!ready || !warningSiteIds.length} onClick={() => selectView('warnings')}>Review sites</button>}
          <button type="button" disabled={!ready} onClick={() => selectView('overview')}>Overview</button>
          <button type="button" disabled={!ready} onClick={() => selectView('detail')}>Site detail</button>
          <button type="button" disabled={!ready} onClick={() => selectView('top')}>Top view</button>
        </div>
        <button type="button" className="sim-view-presets__imagery" disabled={!ready} aria-pressed={satellite}
          onClick={() => { setSatellite(!satellite); setImageryUnavailable(false); }}>Satellite</button>
        {imageryUnavailable && <p className="sim-imagery-notice" role="status">Imagery unavailable · showing map</p>}
      </div>}
      {mapFailure && <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-ink-950 px-8 text-center" role="status">
        <h3 className="text-title font-semibold text-fg">{mapFailure === 'style' ? 'Basemap unavailable' : '3D map unavailable'}</h3>
        <p className="max-w-sm text-body text-muted">{mapFailure === 'webgl'
          ? 'This browser could not start 3D graphics. Enable hardware acceleration or try another browser.'
          : mapFailure === 'context'
            ? 'The browser paused 3D graphics. The map will recover when graphics become available.'
            : 'The basemap could not load. Check your connection and try again.'}</p>
        <p className="text-ui text-muted">Scenario playback and the event transcript are still available.</p>
        <button type="button" className="rounded-lg border border-overlay/15 bg-ink-900 px-4 py-2 text-ui font-medium text-accent"
          onClick={() => { setMapFailure(null); setMapAttempt((attempt) => attempt + 1); }}>Retry map</button>
      </div>}
    </div>
  );
}
