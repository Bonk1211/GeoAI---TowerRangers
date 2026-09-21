import type { Tower } from '../api/types';
import { floodExtentAt, pointInPolygon } from '../fixtures/scenarios/sabahFlood.ts';
import { haversineKm } from './geo.ts';
import { simulationEnvironmentAt, simulationRoadAccessAt } from './simulationVisuals.ts';

export type SimulationWarningId = 'rain' | 'flood' | 'soil' | 'access' | 'power' | 'condition' | 'river' | 'road';

export interface SimulationWarning {
  id: SimulationWarningId;
  label: string;
  value: string;
  unit: string;
  evidence: 'SCENARIO' | 'MODEL' | 'SITE DATA' | 'DEMO TELEMETRY';
  observation: string;
  action: string;
  siteIds: string[];
}

const WARNING_BEATS: readonly [number, SimulationWarningId][] = [
  [0, 'rain'], [4_000, 'flood'], [8_000, 'soil'], [12_000, 'access'],
  [15_000, 'power'], [19_000, 'condition'],
];

function scenarioTime(elapsedMs: number): number {
  return Math.max(0, Math.min(96_000, Number.isNaN(elapsedMs) ? 0 : elapsedMs));
}

export function simulationWarningAt(elapsedMs: number): SimulationWarningId {
  const time = scenarioTime(elapsedMs);
  return WARNING_BEATS.findLast(([at]) => time >= at)?.[1] ?? 'rain';
}

/** Connect scenario exposure to existing maintenance bands without changing either. */
export function simulationAssessmentAt(elapsedMs: number, towers: Tower[]): {
  exposedSiteIds: string[];
  prioritySiteIds: string[];
  outsideFloodPrioritySiteIds: string[];
  nearbyPrioritySiteIds: string[];
  reviewSiteIds: string[];
} {
  const time = scenarioTime(elapsedMs);
  const prospective = floodExtentAt(26_000);
  const footprint = time < 24_000 ? prospective : floodExtentAt(time);
  const sabah = towers.filter((tower) => tower.territory === 'Sabah');
  const priority = sabah.filter((tower) => tower.decision === 'maintain' || tower.decision === 'watch');
  const exposedSiteIds = sabah.filter((tower) => footprint && pointInPolygon(tower.lon, tower.lat, footprint)).map((tower) => tower.tower_id);
  const prioritySiteIds = priority.map((tower) => tower.tower_id);
  const outside = priority.filter((tower) => !prospective || !pointInPolygon(tower.lon, tower.lat, prospective));
  const outsideFloodPrioritySiteIds = outside.map((tower) => tower.tower_id);
  const peakBoundary = (prospective?.coordinates[0] ?? []).map(([lon, lat]) => ({ lon, lat }));
  // ponytail: vertex proximity suffices for camera framing; use edge distances if it informs routing.
  const nearbyPrioritySiteIds = outside.map(tower => ({ id: tower.tower_id,
    distance: Math.min(...peakBoundary.map(point => haversineKm(point, tower))) }))
    .filter(site => Number.isFinite(site.distance))
    .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
    .slice(0, 5).map(site => site.id);
  return { exposedSiteIds, prioritySiteIds, outsideFloodPrioritySiteIds, nearbyPrioritySiteIds,
    reviewSiteIds: [...new Set([...prioritySiteIds, ...exposedSiteIds])] };
}

/** The historical scenario changes; current model records do not become historical observations. */
export function simulationWarningsAt(elapsedMs: number, towers: Tower[]): SimulationWarning[] {
  const time = scenarioTime(elapsedMs);
  const sabah = towers.filter((tower) => tower.territory === 'Sabah');
  const prospective = floodExtentAt(26_000);
  const footprint = time < 24_000 ? prospective : floodExtentAt(time);
  const inFootprint = sabah.filter((tower) => footprint && pointInPolygon(tower.lon, tower.lat, footprint));
  const prospectiveIds = sabah.filter((tower) => prospective && pointInPolygon(tower.lon, tower.lat, prospective)).map((tower) => tower.tower_id);
  const handKnown = inFootprint.filter((tower) => Number.isFinite(tower.hand_m));
  const lowGround = handKnown.filter((tower) => tower.hand_m! <= 5);
  const groundContext = handKnown.length
    ? ` ${lowGround.length} of ${handKnown.length} mapped sites in this footprint sit within 5 m above drainage; this is terrain exposure, not water depth.`
    : '';

  // An empty fixture flags array is not an evaluated all-clear. Other returned
  // profiler flags establish that an assessment exists without inventing one.
  const accessKnown = sabah.filter((tower) => Array.isArray(tower.flags) && tower.flags.length > 0);
  const access = accessKnown.filter((tower) => tower.flags.some((flag) => flag.id === 'out_of_crew_range' || flag.id === 'monsoon_blocked'));
  const powerKnown = sabah.filter((tower) => Number.isFinite(tower.attribution?.power)
    && tower.dominant_factor && tower.dominant_factor !== 'unscored');
  const power = powerKnown.filter((tower) => tower.dominant_factor === 'power');
  const conditionKnown = sabah.filter((tower) => Number.isFinite(tower.condition)
    && tower.condition! >= 0 && tower.condition! <= 1);
  const condition = conditionKnown.filter((tower) => tower.condition! >= 0.85);
  const environment = simulationEnvironmentAt(time);
  const wetness = Math.round(environment.wetness * 100);
  const river = Math.round(environment.river * 100);
  const road = simulationRoadAccessAt(time);
  const emptySites = sabah.length === 0;

  return [
    {
      id: 'rain', label: 'Heavy rainfall',
      value: time >= 96_000 ? 'Cleared' : time >= 40_000 ? 'Easing' : time >= 16_000 ? 'Heavy' : 'Building',
      unit: 'scenario intensity', evidence: 'SCENARIO',
      observation: time < 24_000
        ? 'Scenario rainfall intensifies first; soil wetness and river rise follow. This authored sequence illustrates combined warning signs, not a measured correlation.'
        : time < 40_000
          ? 'The scenario storm is active over the flood corridor. Rain intensity is illustrative, not a live forecast.'
          : time < 96_000 ? 'Scenario rainfall eases while residual ground and access exposure still need review.'
            : 'The scenario rain has cleared. Residual site and access conditions still need review.',
      action: time < 24_000 ? 'Read rain, soil and river conditions alongside the full maintenance priority list.' : time < 80_000
        ? 'Check local conditions before sending crews into the affected corridor.' : 'Confirm conditions before releasing reserve crews.',
      siteIds: prospectiveIds,
    },
    {
      id: 'flood', label: 'Flood exposure', value: emptySites ? '—' : String(inFootprint.length),
      unit: time < 24_000 ? 'sites in planned footprint' : 'sites in scenario footprint', evidence: 'SCENARIO',
      observation: emptySites ? 'Sabah site records are unavailable; exposure cannot be counted.'
        : (time < 24_000
          ? 'Mapped sites overlap the scenario’s future flood footprint; this is the authored premise, not a prediction.'
          : footprint ? 'Mapped sites overlap the current authored flood footprint; overlap does not prove an outage.'
            : 'The authored flood footprint has receded; this does not confirm field conditions.') + groundContext,
      action: time < 24_000 ? 'Review drainage and cabinet protection, including priority sites outside the footprint.' : time < 80_000
        ? 'Assess exposed sites alongside maintenance priorities beyond the flood before dispatch.' : 'Inspect residual exposure and keep unresolved work in the next plan.',
      siteIds: inFootprint.map((tower) => tower.tower_id),
    },
    {
      id: 'soil', label: 'Ground saturation', value: String(wetness), unit: '/ 100 · scenario index', evidence: 'SCENARIO',
      observation: `${wetness} / 100 is an illustrative wetness index, not measured soil moisture.${time >= 40_000 ? ' Ground stays wet after scenario rainfall begins to ease.' : ' Wetness rises behind the strengthening rain and accompanies the river rise.'}`,
      action: time < 24_000 ? 'Check drainage and ground conditions before the storm.' : 'Inspect ground and access conditions before site work.',
      siteIds: prospectiveIds,
    },
    {
      id: 'access', label: 'Crew access limits', value: accessKnown.length ? String(access.length) : '—',
      unit: accessKnown.length ? 'flagged sites' : 'assessment unavailable', evidence: 'SITE DATA',
      observation: accessKnown.length
        ? `${access.length} of ${accessKnown.length} Sabah sites with returned assessments carry depot-range or monsoon crew restrictions. These are planning constraints, not observed road closures.`
        : 'No usable Sabah access assessment was returned. An empty flag list does not establish safe access.',
      action: access.length ? 'Review depot reach and crew restrictions before committing a route.' : 'Confirm route access and crew reach before dispatch.',
      siteIds: access.map((tower) => tower.tower_id),
    },
    {
      id: 'power', label: 'Power vulnerability', value: powerKnown.length ? String(power.length) : '—',
      unit: powerKnown.length ? 'power-led sites' : 'model unavailable', evidence: 'MODEL',
      observation: powerKnown.length
        ? `${power.length} of ${powerKnown.length} scored Sabah sites have power as their leading maintenance factor. This is model attribution, not a grid-status feed.`
        : 'No usable Sabah power attribution was returned; a missing score does not indicate reliable power.',
      action: time < 24_000 ? 'Review battery condition, generator readiness and fuel before impact.'
        : 'Confirm actual power status before assigning battery or generator work.',
      siteIds: power.map((tower) => tower.tower_id),
    },
    {
      id: 'condition', label: 'Equipment condition', value: conditionKnown.length ? String(condition.length) : '—',
      unit: conditionKnown.length ? 'sites in top 15% rank' : 'telemetry unavailable', evidence: 'DEMO TELEMETRY',
      observation: conditionKnown.length
        ? `${condition.length} of ${conditionKnown.length} Sabah sites with demo telemetry have condition rank ≥ 0.85. These synthetic 30-day alarm counters give a relative rank, not observed faults or failure probability.`
        : 'No usable Sabah condition ranks were returned. Missing telemetry does not mean equipment is quiet.',
      action: 'Verify alarms and battery condition before selecting the maintenance work.',
      siteIds: condition.map((tower) => tower.tower_id),
    },
    {
      id: 'river', label: 'River level', value: String(river), unit: '/ 100 · relative scenario level', evidence: 'SCENARIO',
      observation: `${river} / 100 is an authored relative river level, not gauge metres, discharge or a forecast.${time < 47_000 ? ' The delayed rise follows rainfall and ground wetting in this scenario.' : ' River levels fall later than rainfall and remain elevated during recovery.'}`,
      action: time < 24_000 ? 'Review low-lying sites and access crossings alongside rising rain and ground wetness.'
        : time < 88_000 ? 'Keep affected crossings under review while choosing available routes.' : 'Confirm local river and ground conditions before clearing follow-up work.',
      siteIds: prospectiveIds,
    },
    {
      id: 'road', label: 'Blocked roads',
      value: road === 'blocked' ? 'Closures active' : road === 'reopening' ? 'Checks pending' : time < 24_000 ? 'No closures yet' : 'Closures clear',
      unit: 'scenario road state', evidence: 'SCENARIO',
      observation: road === 'blocked'
        ? 'Authored closures constrain selected road segments, not the whole network. Road geometry does not provide live closure or passability data.'
        : road === 'reopening'
          ? 'Scenario road reopening checks are pending. The selected closures remain active until the authored clearance at T+36h.'
          : time < 24_000
            ? 'No authored road closure has begun. This is the scenario baseline, not confirmation that every road is passable.'
            : 'Scenario closures clear; this does not confirm field access. Residual ground conditions still need inspection.',
      action: road === 'open' ? 'Check route availability before dispatch and retain unresolved access work.'
        : 'Exclude closed segments; review an available route or hold the journey when none is available.',
      siteIds: road === 'open' ? [] : prospectiveIds,
    },
  ];
}
