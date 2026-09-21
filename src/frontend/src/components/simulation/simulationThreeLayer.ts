import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MercatorCoordinate, type CustomLayerInterface, type Map as MapLibreMap, type MapSourceDataEvent } from 'maplibre-gl';
import type { Tower } from '../../api/types';
import { SABAH_FLOOD_SCENARIO, pointInPolygon } from '../../fixtures/scenarios/sabahFlood';
import { bandColor } from '../../lib/colors';
import { simulationAssessmentPulseAt, simulationEnvironmentAt } from '../../lib/simulationVisuals';
import { simulationRoadCrewAt, type SimulationRoadLeg } from '../../lib/simulationRoads';
import { prepareRoadMotion, roadHoldPoint, roadPositionAt } from '../../lib/simulationRoadMotion';
import type { SimulationWarningId } from '../../lib/simulationWarnings';

export type SimulationLayerMode = 'combined' | 'risk' | 'flood' | 'soil' | 'response' | 'warnings' | 'rain';

export const RESPONSE_VEHICLE_3D_ZOOM = 13.5;
const UNIT_COLORS: Record<string, string> = {
  'network-crew-1': '#65f5ff', 'network-crew-2': '#ffdf59', 'network-crew-3': '#ff91ae', 'network-crew-4': '#baff75',
  'mobile-network-1': '#c8a4ff', 'mobile-network-2': '#94baff',
  'mobile-network-3': '#ffb4ee', 'mobile-network-4': '#7bf7d3',
  // Pre-event hardening crews (T-36h). A cool teal/green ramp, deliberately
  // distinct from the response units above so a viewer does not read the
  // pre-event convoy as the emergency one arriving early — these drive
  // before the flood exists, toward towers that are still online.
  'hardening-1': '#5fe0c0', 'hardening-2': '#7fd4a8',
  'hardening-3': '#4fc9d8', 'hardening-4': '#8ae0e8',
};
export function responseUnitColor(unitId: string): string { return UNIT_COLORS[unitId] ?? '#65f5ff'; }

interface SceneSnapshot {
  towers: Tower[];
  elapsedMs: number;
  status: string;
  downTowerIds: Set<string>;
  roadLegs: SimulationRoadLeg[];
  roadEmergency: boolean;
  mode: SimulationLayerMode;
  warning: SimulationWarningId;
  warningSiteIds: string[];
  nearbyPrioritySiteIds: string[];
  reducedMotion: boolean;
}

const ORIGIN = MercatorCoordinate.fromLngLat([116.1, 6]);
const METER = ORIGIN.meterInMercatorCoordinateUnits();
const FULL_EXTENT = SABAH_FLOOD_SCENARIO.floodExtents[1].polygon!;
const SMALL_EXTENT = SABAH_FLOOD_SCENARIO.floodExtents[0].polygon!;
const UP = new THREE.Vector3(0, 1, 0);
const clamp = (n: number) => Math.max(0, Math.min(1, n));

function position(lon: number, lat: number, elevation = 0): THREE.Vector3 {
  const p = MercatorCoordinate.fromLngLat([lon, lat]);
  return new THREE.Vector3((p.x - ORIGIN.x) / METER, elevation, (ORIGIN.y - p.y) / METER);
}

function coordinates(p: THREE.Vector3) {
  return new MercatorCoordinate(ORIGIN.x + p.x * METER, ORIGIN.y - p.z * METER).toLngLat();
}

interface Site {
  tower: Tower;
  group: THREE.Group;
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  reviewHalo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  beacon: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
}

interface Route {
  group: THREE.Group;
  vehicle: THREE.Group;
  legs: SimulationRoadLeg[];
  roads: Map<string, { inbound: NonNullable<ReturnType<typeof prepareRoadMotion>>; departure: ReturnType<typeof prepareRoadMotion> }>;
}

/** Geographically registered presentation geometry. Water and soil are illustrative
 * scenario surfaces, not hydraulic/soil measurements. Mast, vehicle and layer heights
 * are exaggerated for a district-scale camera; assignments and risk bands stay real. */
export function createSimulationThreeLayer(read: () => SceneSnapshot): CustomLayerInterface {
  let map: MapLibreMap;
  let renderer: THREE.WebGLRenderer | undefined;
  const camera = new THREE.Camera();
  const scene = new THREE.Scene();
  // MapLibre's terrain example: local x=east, y=up, z=north, measured in metres.
  scene.rotation.x = Math.PI / 2;
  scene.scale.z = -1;
  const transform = new THREE.Matrix4().makeTranslation(ORIGIN.x, ORIGIN.y, 0)
    .scale(new THREE.Vector3(METER, -METER, METER));
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const geometry = <T extends THREE.BufferGeometry>(value: T): T => { geometries.add(value); return value; };
  const material = <T extends THREE.Material>(value: T): T => { materials.add(value); return value; };
  const sites: Site[] = [];
  const routes: Route[] = [];
  const soilPositions: THREE.Vector3[] = [];
  const rainPositions: THREE.Vector3[] = [];
  const soil = new THREE.Group();
  const infrastructure = new THREE.Group();
  let soilMesh: THREE.InstancedMesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
  let water: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  let rain: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  let towerKey = '';
  let terrainDirty = true;
  let lastSoilWetness = -1;
  let previousRoadLegs: SimulationRoadLeg[] | undefined;
  const dummy = new THREE.Object3D();
  const soilDry = new THREE.Color('#ccca97');
  const soilWet = new THREE.Color('#ad752f');
  const tint = new THREE.Color();
  const vehiclePosition = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const terrainHeight = (p: THREE.Vector3) => map.queryTerrainElevation(coordinates(p)) ?? 0;
  const onTerrain = (event: MapSourceDataEvent) => {
    if (event.sourceId === map.getTerrain()?.source) terrainDirty = true;
  };

  // Build the lattice once: every site reuses one mesh, not dozens of draw calls.
  const frameParts: THREE.BufferGeometry[] = [];
  const frameBar = new THREE.CylinderGeometry(1, 1, 1, 6);
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const corner = (index: number, level: number) => new THREE.Vector3(
    corners[index][0] * (24 - level * 4), 9 + level * 45, corners[index][1] * (24 - level * 4),
  );
  function bar(from: THREE.Vector3, to: THREE.Vector3, radius: number) {
    const delta = to.clone().sub(from);
    const matrix = new THREE.Matrix4().compose(from.clone().add(to).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(UP, delta.clone().normalize()), new THREE.Vector3(radius, delta.length(), radius));
    frameParts.push(frameBar.clone().applyMatrix4(matrix));
  }
  for (let side = 0; side < 4; side++) {
    const next = (side + 1) % 4;
    bar(corner(side, 0), corner(side, 4), 2.7);
    for (let level = 0; level < 4; level++) {
      bar(corner(side, level), corner(next, level + 1), 1.4);
      bar(corner(next, level), corner(side, level + 1), 1.4);
      bar(corner(side, level + 1), corner(next, level + 1), 1.8);
    }
  }
  const mastGeometry = geometry(mergeGeometries(frameParts)!);
  frameBar.dispose();
  for (const part of frameParts) part.dispose();
  const boxGeometry = geometry(new THREE.BoxGeometry(1, 1, 1));
  const platformGeometry = geometry(new THREE.CylinderGeometry(22, 22, 3, 24));
  const foundationGeometry = geometry(new THREE.CylinderGeometry(43, 47, 7, 32));
  const collarGeometry = geometry(new THREE.CylinderGeometry(19, 20, 15, 16));
  const beaconGeometry = geometry(new THREE.SphereGeometry(9, 12, 8));
  const haloGeometry = geometry(new THREE.RingGeometry(52, 74, 64));
  const reviewHaloGeometry = geometry(new THREE.RingGeometry(96, 114, 64));
  const reviewHaloMaterial = material(new THREE.MeshBasicMaterial({ color: '#b5f4ff', transparent: true,
    opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  const followupHaloMaterial = material(new THREE.MeshBasicMaterial({ color: '#ffc66d', transparent: true,
    opacity: 0.95, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  const mastMaterial = material(new THREE.MeshStandardMaterial({ color: '#b8c5ce', metalness: 0.48, roughness: 0.32 }));
  const panelMaterial = material(new THREE.MeshStandardMaterial({ color: '#e9edf0', metalness: 0.15, roughness: 0.32 }));
  const concreteMaterial = material(new THREE.MeshStandardMaterial({ color: '#b5b8ae', roughness: 0.94 }));
  const truckWheelGeometry = geometry(new THREE.CylinderGeometry(6.5, 6.5, 4.5, 16).rotateZ(Math.PI / 2));
  const hubGeometry = geometry(new THREE.CylinderGeometry(3, 3, 4.8, 12).rotateZ(Math.PI / 2));
  const truckWindowMaterial = material(new THREE.MeshStandardMaterial({ color: '#234b63', metalness: 0.35, roughness: 0.15 }));
  const wheelMaterial = material(new THREE.MeshStandardMaterial({ color: '#17232a', roughness: 0.92 }));
  const vehicleMaterials = new Map<string, THREE.MeshStandardMaterial>();

  // A shared contact shadow grounds the models without extra render passes on MapLibre's context.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 64;
  const shadowContext = shadowCanvas.getContext('2d');
  let shadowTexture: THREE.CanvasTexture | undefined;
  if (shadowContext) {
    const gradient = shadowContext.createRadialGradient(32, 32, 3, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(5, 17, 25, 0.48)');
    gradient.addColorStop(0.4, 'rgba(5, 17, 25, 0.24)');
    gradient.addColorStop(1, 'rgba(5, 17, 25, 0)');
    shadowContext.fillStyle = gradient;
    shadowContext.fillRect(0, 0, 64, 64);
    shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    textures.add(shadowTexture);
  }
  const shadowGeometry = geometry(new THREE.PlaneGeometry(170, 150).rotateX(-Math.PI / 2));
  const shadowMaterial = material(new THREE.MeshBasicMaterial({ map: shadowTexture, color: '#ffffff', transparent: true,
    opacity: shadowTexture ? 1 : 0, depthWrite: false, toneMapped: false }));

  function box(parent: THREE.Group, size: [number, number, number], at: [number, number, number], surface: THREE.Material) {
    const mesh = new THREE.Mesh(boxGeometry, surface);
    mesh.scale.set(...size);
    mesh.position.set(...at);
    parent.add(mesh);
    return mesh;
  }

  function makeVehicle(unitId: string, equipmentTruck: boolean) {
    const truck = new THREE.Group();
    const color = responseUnitColor(unitId);
    let accent = vehicleMaterials.get(color);
    if (!accent) {
      accent = material(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.23 }));
      vehicleMaterials.set(color, accent);
    }
    box(truck, [22, 5, 48], [0, 8, 0], wheelMaterial);
    box(truck, [23, 18, 29], [0, 19, -9], panelMaterial);
    box(truck, [22, 14, 17], [0, 17, 15], panelMaterial);
    box(truck, [19, 10, 13], [0, 28, 12], truckWindowMaterial);
    box(truck, [23, 2, 17], [0, 34, 12], panelMaterial);
    box(truck, [12, 3, 4], [0, 37, 12], accent);
    box(truck, [23.4, 4, 27], [0, 20, -9], accent);
    box(truck, [24, 3, 3], [0, 9, 25], mastMaterial);
    for (const x of [-8, 8]) box(truck, [5, 3, 1], [x, 17, 23.8], panelMaterial);
    for (const x of [-12, 12]) for (const z of [-15, 16]) {
      const wheel = new THREE.Mesh(truckWheelGeometry, wheelMaterial);
      const hub = new THREE.Mesh(hubGeometry, mastMaterial);
      wheel.position.set(x, 6.5, z);
      hub.position.copy(wheel.position);
      truck.add(wheel, hub);
    }
    if (equipmentTruck) {
      box(truck, [25, 10, 28], [0, 33, -10], panelMaterial);
      box(truck, [26, 4, 29], [0, 39, -10], accent);
    }
    return truck;
  }

  function rebuildSites(towers: Tower[]) {
    for (const site of sites) {
      site.halo.material.dispose(); materials.delete(site.halo.material);
      site.beacon.material.dispose(); materials.delete(site.beacon.material);
    }
    sites.length = 0;
    infrastructure.clear();
    for (const tower of towers) {
      if (!Number.isFinite(tower.lon) || !Number.isFinite(tower.lat)) continue;
      const group = new THREE.Group();
      group.position.copy(position(tower.lon, tower.lat));
      const mast = new THREE.Mesh(mastGeometry, mastMaterial);
      const foundation = new THREE.Mesh(foundationGeometry, concreteMaterial);
      foundation.position.y = 4;
      const platform = new THREE.Mesh(platformGeometry, mastMaterial);
      platform.position.y = 158;
      const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
      shadow.position.set(16, 0.5, 9);
      group.add(mast, foundation, platform, shadow);
      box(group, [16, 24, 13], [30, 18, 17], panelMaterial);
      box(group, [16.2, 8, 1], [30, 17, 23.6], wheelMaterial);
      const color = bandColor(tower.decision);
      const signalMaterial = material(new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.32, roughness: 0.45 }));
      const beacon = new THREE.Mesh(beaconGeometry, signalMaterial);
      beacon.position.y = 200;
      const collar = new THREE.Mesh(collarGeometry, signalMaterial);
      collar.position.y = 140;
      group.add(collar);
      for (let sector = 0; sector < 3; sector++) {
        const angle = sector * Math.PI * 2 / 3;
        const panel = box(group, [11, 38, 7], [Math.sin(angle) * 20, 181, Math.cos(angle) * 20], panelMaterial);
        panel.rotation.y = angle;
        const stripe = box(group, [11.2, 13, 7.2], [Math.sin(angle) * 20, 172, Math.cos(angle) * 20], signalMaterial);
        stripe.rotation.y = angle;
      }
      const halo = new THREE.Mesh(haloGeometry, material(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })));
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = 3;
      const reviewHalo = new THREE.Mesh(reviewHaloGeometry, reviewHaloMaterial);
      reviewHalo.rotation.x = -Math.PI / 2;
      reviewHalo.position.y = 18;
      reviewHalo.visible = false;
      group.add(beacon, halo, reviewHalo);
      infrastructure.add(group);
      sites.push({ tower, group, halo, reviewHalo, beacon });
    }
    terrainDirty = true;
  }

  function createEnvironment() {
    const points = FULL_EXTENT.coordinates[0].slice(0, -1).map(([lon, lat]) => position(lon, lat));
    const shape = new THREE.Shape(points.map(p => new THREE.Vector2(p.x, p.z)));
    const outline = new THREE.ShapeGeometry(shape);
    const flat = outline.toNonIndexed();
    outline.dispose();
    const source = flat.getAttribute('position');
    const vertices: number[] = [];
    const arrivals: number[] = [];
    // Tessellate once so the scenario surface follows the actual terrain DEM.
    function triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, depth: number) {
      if (depth) {
        const ab = a.clone().add(b).multiplyScalar(0.5);
        const bc = b.clone().add(c).multiplyScalar(0.5);
        const ca = c.clone().add(a).multiplyScalar(0.5);
        triangle(a, ab, ca, depth - 1); triangle(ab, b, bc, depth - 1);
        triangle(ca, bc, c, depth - 1); triangle(ab, bc, ca, depth - 1);
        return;
      }
      for (const p of [a, b, c]) {
        vertices.push(p.x, 0, p.y);
        const coord = coordinates(new THREE.Vector3(p.x, 0, p.y));
        arrivals.push(pointInPolygon(coord.lng, coord.lat, SMALL_EXTENT) ? 0 : 0.36 + 0.53 * clamp((coord.lat - 5.925) / 0.153));
      }
    }
    for (let i = 0; i < source.count; i += 3) {
      triangle(new THREE.Vector3().fromBufferAttribute(source, i), new THREE.Vector3().fromBufferAttribute(source, i + 1), new THREE.Vector3().fromBufferAttribute(source, i + 2), 3);
    }
    flat.dispose();
    const surface = geometry(new THREE.BufferGeometry());
    surface.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    surface.setAttribute('arrival', new THREE.Float32BufferAttribute(arrivals, 1));
    water = new THREE.Mesh(surface, material(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { time: { value: 0 }, flood: { value: 0 }, opacity: { value: 1 } },
      vertexShader: `
        attribute float arrival;
        varying float vArrival;
        varying vec2 vGround;
        void main() {
          vArrival = arrival;
          vGround = position.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform float time;
        uniform float flood;
        uniform float opacity;
        varying float vArrival;
        varying vec2 vGround;
        void main() {
          float coverage = smoothstep(vArrival, vArrival + 0.1, flood);
          if (coverage < 0.01) discard;
          float swell = dot(vGround, vec2(0.007, 0.011)) - time * 0.65;
          float crosswind = dot(vGround, vec2(-0.018, 0.009)) + time * 0.9;
          float ripple = dot(vGround, vec2(0.037, 0.026)) + sin(swell) * 1.5 - time * 1.5;
          float waves = sin(swell) * 0.5 + sin(crosswind) * 0.28 + sin(ripple) * 0.12;
          vec3 normal = normalize(vec3(
            cos(swell) * 0.10 - cos(crosswind) * 0.07 + cos(ripple) * 0.05,
            1.0, cos(swell) * 0.12 + cos(crosswind) * 0.06 + cos(ripple) * 0.04));
          float glint = pow(max(dot(normal, normalize(vec3(0.14, 1.0, 0.20))), 0.0), 120.0);
          float shoreline = 1.0 - smoothstep(0.0, 0.22, flood - vArrival);
          vec3 color = mix(vec3(0.018, 0.15, 0.20), vec3(0.06, 0.33, 0.39), 0.5 + waves * 0.3);
          color += vec3(0.36, 0.48, 0.49) * glint * 0.26 + vec3(0.08, 0.12, 0.11) * shoreline;
          gl_FragColor = vec4(color, coverage * (0.52 + glint * 0.09) * opacity);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })));
    water.renderOrder = 1;
    water.frustumCulled = false;
    scene.add(water);

    const minX = Math.min(...points.map(p => p.x));
    const maxX = Math.max(...points.map(p => p.x));
    const minZ = Math.min(...points.map(p => p.z));
    const maxZ = Math.max(...points.map(p => p.z));
    const rainVertices: number[] = [];
    const rainPhases: number[] = [];
    const rainTips: number[] = [];
    // Authored weather illustration: seeded streaks follow the scenario clock, not a measured rain rate.
    for (let i = 0; i < 10000; i++) {
      const p = new THREE.Vector3(minX + (maxX - minX) * ((i * 0.61803398875) % 1), 0,
        minZ + (maxZ - minZ) * ((i * 0.75487766625) % 1));
      const coord = coordinates(p);
      if (!pointInPolygon(coord.lng, coord.lat, FULL_EXTENT)) continue;
      rainPositions.push(p);
      rainVertices.push(p.x, 0, p.z, p.x, 0, p.z);
      const phase = (i * 0.41421356237) % 1;
      rainPhases.push(phase, phase);
      rainTips.push(0, 1);
    }
    const rainGeometry = geometry(new THREE.BufferGeometry());
    rainGeometry.setAttribute('position', new THREE.Float32BufferAttribute(rainVertices, 3));
    rainGeometry.setAttribute('phase', new THREE.Float32BufferAttribute(rainPhases, 1));
    rainGeometry.setAttribute('tip', new THREE.Float32BufferAttribute(rainTips, 1));
    rain = new THREE.LineSegments(rainGeometry, material(new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: { time: { value: 0 }, intensity: { value: 0 } },
      vertexShader: `
        attribute float phase;
        attribute float tip;
        uniform float time;
        uniform float intensity;
        varying float vTip;
        void main() {
          vTip = tip;
          vec3 drop = position + vec3(20.0, 70.0 + intensity * 150.0, -12.0) * tip;
          drop.y += mod(phase * 1100.0 - time * 560.0, 1100.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(drop, 1.0);
        }`,
      fragmentShader: `
        uniform float intensity;
        varying float vTip;
        void main() {
          float alpha = (0.28 + intensity * 0.4) * mix(0.3, 1.0, vTip) * smoothstep(0.0, 0.15, intensity);
          gl_FragColor = vec4(0.78, 0.91, 1.0, alpha);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    })));
    rain.frustumCulled = false;
    rain.renderOrder = 2;
    rain.visible = false;
    scene.add(rain);
    const radius = 270;
    for (let row = 0, z = minZ; z < maxZ; row++, z += radius * 1.65) {
      for (let x = minX + (row % 2) * radius * 0.95; x < maxX; x += radius * 1.9) {
        const p = new THREE.Vector3(x, 0, z);
        const fits = Array.from({ length: 6 }, (_, i) => {
          const c = coordinates(new THREE.Vector3(x + Math.sin(i * Math.PI / 3) * radius, 0, z + Math.cos(i * Math.PI / 3) * radius));
          return pointInPolygon(c.lng, c.lat, FULL_EXTENT);
        }).every(Boolean);
        if (fits) soilPositions.push(p);
      }
    }
    soilMesh = new THREE.InstancedMesh(geometry(new THREE.CylinderGeometry(radius * 0.93, radius * 0.93, 1, 6)), material(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.67, roughness: 0.75, depthWrite: false })), soilPositions.length);
    soilMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    soilMesh.frustumCulled = false;
    soil.add(soilMesh);
    scene.add(soil, infrastructure);
  }

  function rebuildRoutes(legs: SimulationRoadLeg[]) {
    for (const route of routes) scene.remove(route.group);
    routes.length = 0;
    const crews = new Map<string, SimulationRoadLeg[]>();
    for (const leg of legs) {
      const unitId = leg.unitId ?? leg.crewId;
      const jobs = crews.get(unitId) ?? [];
      jobs.push(leg);
      crews.set(unitId, jobs);
    }
    for (const [unitId, jobs] of crews) {
      const group = new THREE.Group();
      const vehicle = makeVehicle(unitId, jobs[0]?.unitKind === 'network-crew');
      const roads: Route['roads'] = new Map();
      for (const leg of jobs) {
        if (leg.road?.status !== 'routed') continue;
        const road = prepareRoadMotion(leg.road.coordinates);
        const departure = leg.road.departure_route;
        if (road) roads.set(leg.id, { inbound: road,
          departure: departure?.status === 'routed' ? prepareRoadMotion(departure.coordinates) : null });
      }
      group.add(vehicle);
      scene.add(group);
      routes.push({ group, vehicle, legs: jobs, roads });
    }
  }

  function updateTerrain() {
    for (const site of sites) site.group.position.y = terrainHeight(site.group.position) + 5;
    for (const p of soilPositions) p.y = terrainHeight(p) + 7;
    const rainVertices = rain.geometry.getAttribute('position');
    for (let i = 0; i < rainPositions.length; i++) {
      const elevation = terrainHeight(rainPositions[i]) + 18;
      rainVertices.setY(i * 2, elevation);
      rainVertices.setY(i * 2 + 1, elevation);
    }
    rainVertices.needsUpdate = true;
    const positions = water.geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      vehiclePosition.fromBufferAttribute(positions, i);
      positions.setY(i, terrainHeight(vehiclePosition) + 14);
    }
    positions.needsUpdate = true;
    lastSoilWetness = -1;
    terrainDirty = false;
  }

  return {
    id: 'sim-three-scene', type: 'custom', renderingMode: '3d',
    onAdd(instance, gl) {
      map = instance;
      renderer = new THREE.WebGLRenderer({ canvas: map.getCanvas(), context: gl, antialias: true });
      renderer.autoClear = false;
      renderer.toneMapping = THREE.AgXToneMapping;
      renderer.toneMappingExposure = 1.1;
      scene.add(new THREE.HemisphereLight('#d9edff', '#626b50', 1.7));
      const sun = new THREE.DirectionalLight('#fff0d8', 3.2);
      sun.position.set(-4000, 6000, -3000);
      const skyFill = new THREE.DirectionalLight('#a9cfff', 0.8);
      skyFill.position.set(3000, 1500, 4000);
      scene.add(sun, skyFill);
      createEnvironment();
      map.on('sourcedata', onTerrain);
    },
    render(_gl, args) {
      if (!renderer) return;
      const state = read();
      const nextTowerKey = state.towers.map(t => `${t.tower_id}:${t.lon}:${t.lat}:${t.decision}`).join('|');
      if (nextTowerKey !== towerKey) { rebuildSites(state.towers); towerKey = nextTowerKey; }
      if (terrainDirty) updateTerrain();
      if (previousRoadLegs !== state.roadLegs) {
        rebuildRoutes(state.roadLegs);
        previousRoadLegs = state.roadLegs;
      }
      const ms = Math.max(0, Number.isFinite(state.elapsedMs) ? state.elapsedMs : 0);
      const environment = simulationEnvironmentAt(ms);
      const motionTime = state.reducedMotion ? 0 : ms / 1000;
      const warnings = state.mode === 'warnings';
      const combined = state.mode === 'combined';
      const showRain = combined || state.mode === 'rain' || (warnings && state.warning === 'rain');
      water.visible = (warnings ? state.warning === 'flood' : state.mode !== 'soil' && state.mode !== 'rain') && environment.flood > 0;
      water.material.uniforms.time.value = motionTime;
      water.material.uniforms.flood.value = environment.flood;
      water.material.uniforms.opacity.value = combined || state.mode === 'response' ? 0.6 : 1;
      soil.visible = combined || state.mode === 'soil' || (warnings && state.warning === 'soil');
      soilMesh.material.opacity = combined ? 0.2 : 0.67;
      rain.visible = showRain && environment.rain > 0;
      if (rain.visible) {
        rain.material.uniforms.time.value = motionTime;
        rain.material.uniforms.intensity.value = environment.rain;
        rain.geometry.setDrawRange(0, Math.floor(rainPositions.length * (0.15 + environment.rain * 0.85)) * 2);
      }
      if (soil.visible && Math.abs(lastSoilWetness - environment.wetness) > 0.001) {
        for (let i = 0; i < soilPositions.length; i++) {
          const p = soilPositions[i];
          const wetness = clamp(environment.wetness + Math.sin(p.x * 0.0007 + p.z * 0.0005) * 0.06);
          const height = 20 + wetness * 130;
          dummy.position.set(p.x, p.y + height / 2, p.z);
          dummy.scale.set(1, height, 1);
          dummy.updateMatrix();
          soilMesh.setMatrixAt(i, dummy.matrix);
          soilMesh.setColorAt(i, tint.copy(soilDry).lerp(soilWet, wetness));
        }
        soilMesh.instanceMatrix.needsUpdate = true;
        if (soilMesh.instanceColor) soilMesh.instanceColor.needsUpdate = true;
        lastSoilWetness = environment.wetness;
      }
      const reviewIds = new Set(state.warningSiteIds);
      const nearbyPriorityIds = new Set(state.nearbyPrioritySiteIds);
      const assessmentPulse = simulationAssessmentPulseAt(Math.floor(ms / 33) * 33, state.reducedMotion);
      followupHaloMaterial.opacity = 0.95 * assessmentPulse;
      for (const site of sites) {
        const down = ms >= 27000 && ms < 80000 && state.downTowerIds.has(site.tower.tower_id);
        site.beacon.material.emissiveIntensity = down ? 0.18 : 0.32;
        site.halo.scale.setScalar(1 + Math.sin(motionTime * 1.4) * 0.035);
        site.reviewHalo.visible = (combined || warnings) && reviewIds.has(site.tower.tower_id);
        const secondary = combined && nearbyPriorityIds.has(site.tower.tower_id);
        site.reviewHalo.material = secondary ? followupHaloMaterial : reviewHaloMaterial;
        site.reviewHalo.scale.setScalar(secondary ? 1 + (1 - assessmentPulse) * 0.3 : 1);
      }
      // Presentation enlargement keeps a dispatched crew legible from district to site view.
      const vehicleScale = Math.max(1.8, Math.min(10, 1.8 * 2 ** (14 - map.getZoom())));
      for (const route of routes) {
        // Hardening units drive in the PRE-EVENT window, when
        // `roadEmergency` is false by construction — gating the whole loop
        // on it would leave the 3D convoy invisible for the entire
        // T-36h beat while the 2D route lines below it were drawn.
        const hardening = route.legs[0]?.unitKind === 'hardening';
        const step = simulationRoadCrewAt(ms, !hardening, route.legs, state.reducedMotion);
        route.group.visible = step !== null && !(hardening && step.held) && map.getZoom() >= RESPONSE_VEHICLE_3D_ZOOM;
        if (!step || (hardening && step.held)) continue;
        const paths = route.roads.get(step.leg.id);
        const road = step.returning ? paths?.departure : paths?.inbound;
        route.vehicle.rotation.y = 0;
        if (step.held) {
          const heldAt = roadHoldPoint(route.legs, step.leg);
          route.group.visible = route.group.visible && heldAt !== null;
          if (!heldAt) continue;
          vehiclePosition.copy(position(heldAt.lon, heldAt.lat));
        } else if (road) {
          const point = roadPositionAt(road, step.travel);
          vehiclePosition.copy(position(point.lon, point.lat));
          direction.copy(position(...point.to)).sub(position(...point.from));
          if (direction.lengthSq() > 0) route.vehicle.rotation.y = Math.atan2(direction.x, direction.z);
        } else {
          route.group.visible = false;
          continue;
        }
        // Query at the interpolated road point so the vehicle follows terrain between vertices.
        vehiclePosition.y = terrainHeight(vehiclePosition) + 3;
        route.vehicle.scale.setScalar(vehicleScale);
        route.vehicle.position.copy(vehiclePosition);
      }
      camera.projectionMatrix.fromArray(args.defaultProjectionData.mainMatrix).multiply(transform);
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      renderer.resetState();
      renderer.render(scene, camera);
      renderer.resetState();
      if (state.status === 'running' && !state.reducedMotion) map.triggerRepaint();
    },
    onRemove() {
      map.off('sourcedata', onTerrain);
      for (const value of geometries) value.dispose();
      for (const value of materials) value.dispose();
      for (const value of textures) value.dispose();
      renderer?.dispose();
      renderer = undefined;
      scene.clear();
    },
  };
}
