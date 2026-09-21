import { useSimulation } from '../../state/useSimulation';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useWeights } from '../../state/useWeights';
import { useCrewsQuery } from '../../api/queries';
import { useReducedMotion } from 'motion/react';
import { BEATS } from '../../lib/simulationTimeline';
import { FLOOD_PRIORITY_MS, simulationEnvironmentAt, simulationSceneAt, simulationRoadAccessAt } from '../../lib/simulationVisuals';
import { simulationAssessmentAt } from '../../lib/simulationWarnings';
import { HARDENING_EXIT_MS, simulationRoadCrewAt } from '../../lib/simulationRoads';
import { bandColor } from '../../lib/colors';
import type { SimulationRoadState } from './useSimulationRoads';
import { responseUnitColor } from './simulationThreeLayer';

export function SimulationSceneCaption({ roads }: { roads: SimulationRoadState }) {
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 100) * 100);
  const status = useSimulation(s => s.status);
  const scene = simulationSceneAt(elapsedMs, roads.unavailable, roads.coverage.deployments.length > 0);
  const clock = BEATS.findLast(b => b.atMs <= elapsedMs)?.clockLabel ?? 'T−72h';
  return <div className="sim-scene-caption">
    <div className="sim-scene-kicker"><span className={status === 'running' ? 'sim-live-dot' : ''} />{status === 'idle' ? 'SCENARIO READY' : status === 'done' ? 'PLAYBACK COMPLETE' : status === 'paused' ? 'PLAYBACK PAUSED' : 'SCENARIO PLAYBACK'}<b>{clock}</b></div>
    <h2>{scene.title}</h2><p>{scene.observation}</p>
  </div>;
}

export function SimulationSignals({ roads }: { roads: SimulationRoadState }) {
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 100) * 100);
  const environment = simulationEnvironmentAt(elapsedMs);
  const roadState = simulationRoadAccessAt(elapsedMs);
  const blockedRoads = new Set(roads.network?.roads.features.filter(feature => roads.blocked.includes(feature.properties.edge_id)).map(feature => feature.properties.way_id)).size;
  return <section className="sim-connected-key" aria-label="Connected warning signals">
      <div className="sim-key-heading"><span className="sim-eyebrow">ONE STORM · CONNECTED SIGNALS</span><span className="sim-key-tag">SCENARIO</span></div>
      <div className="sim-signal-cards">
        {([['Rainfall', environment.rain, '#c0a2ff'], ['Soil moisture', environment.wetness, '#f3bf6b'], ['River level', environment.river, '#72e3ef']] as const).map(([label, value, color]) => <div key={label}>
          <span>{label}</span><strong>{Math.round(value * 100)}<small>/100</small></strong>
          <div className="sim-signal-meter" role="meter" aria-label={`${label} scenario index`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}><i style={{ width: `${value * 100}%`, background: color }} /></div>
        </div>)}
        <div className="sim-road-signal"><span>Blocked roads</span><strong>{roads.network?.status === 'available' ? blockedRoads : '—'}</strong><small>{roads.unavailable ? 'Data unavailable' : roads.loading && !roads.network ? 'Reading network' : roadState === 'reopening' ? 'Clearance pending' : roads.blocked.length ? roads.network?.roads.features.find(feature => roads.blocked.includes(feature.properties.edge_id))?.properties.name ?? 'Route excluded' : 'Scenario closures'}</small></div>
      </div>
    </section>;
}

export function SimulationBriefing() {
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 100) * 100);
  const weights = useWeights(s => s.weights);
  const { towers } = useLiveTowers(weights);
  if (elapsedMs >= HARDENING_EXIT_MS) return null;
  const assessment = simulationAssessmentAt(elapsedMs, towers);
  const priority = towers.filter(t => assessment.prioritySiteIds.includes(t.tower_id)).sort((a, b) => b.priority - a.priority);
  const outsideIds = new Set(assessment.outsideFloodPrioritySiteIds);
  const nearbyPriority = priority.filter(t => assessment.nearbyPrioritySiteIds.includes(t.tower_id));
  return <section className="sim-deployment sim-site-assessment" aria-label="Wider tower risk assessment">
      <div className="sim-panel-heading"><span className="sim-eyebrow">OTHER PRIORITY TOWERS</span><span className="sim-source-tag">MODEL</span></div>
      {elapsedMs >= FLOOD_PRIORITY_MS && <p className="sim-assessment-order"><strong>Flood response first.</strong> Nearby maintenance stays on the follow-up list.</p>}
      <p className="sim-deployment-total"><strong>{outsideIds.size}</strong> priority sites outside the flood footprint</p>
      <ul>{(elapsedMs >= FLOOD_PRIORITY_MS ? nearbyPriority : priority.slice(0, 3)).map(tower => <li key={tower.tower_id}><i className="sim-risk-dot" style={{ background: bandColor(tower.decision) }} /><div><strong>{tower.tower_id}</strong><span>{tower.dominant_factor.replaceAll('_', ' ')} · {outsideIds.has(tower.tower_id) ? 'Outside flood' : 'Flood exposure'}</span></div><b className="sim-priority-label">{tower.decision === 'maintain' ? 'Maintain' : 'Watch'}</b></li>)}</ul>
      <p className="sim-deployment-note">{elapsedMs >= FLOOD_PRIORITY_MS ? `${nearbyPriority.length} nearby priority sites shown. This scenario response order keeps their maintenance needs visible; confirmed crew jobs follow the optimizer.` : 'Flood, terrain, power and equipment factors remain in the model assessment. Scenario weather does not overwrite site scores.'}</p>
    </section>;
}

export function SimulationFleet({ roads }: { roads: SimulationRoadState }) {
  const reducedMotion = useReducedMotion();
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 100) * 100);
  const status = useSimulation(s => s.status);
  const optimizeStatus = useSimulation(s => s.optimizeStatus);
  const emergencyStatus = useSimulation(s => s.emergencyStatus);
  const { data: crews } = useCrewsQuery();
  const unitIds = [...new Set(roads.assignments.filter(leg => leg.unitKind !== 'network-crew' || elapsedMs >= 72_000).map(leg => leg.unitId ?? leg.crewId))];
  if (elapsedMs >= 62_000) {
    const mobileIds = new Set(roads.assignments.filter(leg => leg.unitKind === 'mobile-network').map(leg => leg.unitId ?? leg.crewId));
    unitIds.sort((a, b) => Number(mobileIds.has(b)) - Number(mobileIds.has(a)));
  }
  const activeMobileIds = new Set(roads.coverage.deployments.map(leg => leg.unitId ?? leg.crewId));
  const scenarioFleet = roads.assignments.some(leg => leg.unitId);
  const heading = elapsedMs >= 88_000 ? 'Review response & follow-up' : scenarioFleet ? 'Scenario response fleet' : 'Prepare the crews';
  return <details className="sim-deployment sim-road-dispatch sim-fleet" open aria-label="Road dispatch assessment">
    <summary>
      <span className="sim-eyebrow">{heading.toUpperCase()}</span>
      <span className="sim-source-tag">{scenarioFleet ? 'SCENARIO' : roads.legs.length ? 'OPTIMIZER' : 'AWAITING PLAN'}</span>
      <svg className="sim-fleet-chevron" aria-hidden="true" viewBox="0 0 12 12"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </summary>
    <div className="sim-fleet-body">
      {roads.assignments.length ? <><p className="sim-deployment-total">{scenarioFleet ? <><strong>{unitIds.length}</strong> response units · {new Set(roads.assignments.filter(leg => leg.unitKind !== 'mobile-network').map(leg => leg.entry.tower_id)).size} affected sites</> : <><strong>{roads.assignments.length}</strong> assignments · {unitIds.length} crew{unitIds.length === 1 ? '' : 's'}</>}</p>
        {scenarioFleet && <p className="sim-deployment-note">{elapsedMs < 54_000 ? 'Civil crews finish tower maintenance and leave the flood corridor before water rises.' : 'Both PRIME jeeps stay fixed while multiple drones cover the outage zone. At 1:12, service crews 1 and 2 hold the south edge; crews 3 and 4 follow the longer dry-road approach to the northern flood edge. Every drone returns to its original jeep.'}</p>}
        <div className="sim-route-outcome"><span><b>{roads.legs.filter(leg => leg.road?.status === 'routed').length}</b> mapped routes</span><span><b>{roads.deferred.length}</b> access holds</span></div>
        <ul>{unitIds.map(id => {
          const legs = roads.legs.filter(leg => (leg.unitId ?? leg.crewId) === id);
          const motion = simulationRoadCrewAt(elapsedMs, roads.emergency, legs, Boolean(reducedMotion));
          const leg = motion?.leg ?? legs[0] ?? roads.assignments.find(item => (item.unitId ?? item.crewId) === id)!;
          const crew = crews?.find(c => c.crew_id === leg.crewId);
          const road = leg.road;
          const mobile = leg.unitKind === 'mobile-network';
          const networkCrew = leg.unitKind === 'network-crew';
          const hardening = leg.unitKind === 'hardening';
          const pocketSize = leg.coverageTowerIds?.length;
          const staged = Boolean(motion?.staged);
          const deviceActive = activeMobileIds.has(id);
          const measuredRoad = road;
          const state = roads.unavailable ? 'Access unavailable · hold' : !leg.to || (!leg.unitId && !leg.from) ? 'Location unavailable · hold' : !road ? leg.unitId ? 'Checking staging and mapped roads' : 'Awaiting mapped route' : road.status !== 'routed' ? 'No available road route · hold'
            : motion?.held ? 'Staged · route unavailable' : motion?.working ? 'Stopped · tower maintenance' : motion?.exiting ? 'Maintenance complete · leaving flood corridor'
              : mobile ? elapsedMs >= 92_000 ? 'Fixed edge · assigned drones landed' : elapsedMs >= 88_000 ? 'Fixed edge · receiving returning drones' : deviceActive ? 'Fixed edge · drone relays active' : 'Fixed edge · preparing drone relays'
                : hardening && motion?.stationary ? 'Maintenance complete · safe outside flood'
                  : networkCrew ? elapsedMs >= 96_000 ? 'Response complete · holding outside flood' : motion?.stationary ? 'Holding outside flood · network support' : 'Longer dry-road approach · northern flood edge'
                  : staged ? hardening ? 'Maintenance complete · safe outside flood' : 'Staged outside flood' : !motion ? 'Road route assessed' : motion.travel === 1 ? 'At mapped work-access point' : 'Following mapped road';
          return <li key={id}><span className="sim-crew-icon" style={leg.unitId ? { color: responseUnitColor(id), background: '#183443', borderColor: '#304e5e' } : undefined} aria-hidden="true">{motion?.held || roads.unavailable || staged || mobile ? 'Ⅱ' : motion?.working ? '⚒' : motion?.travel === 1 ? '✓' : motion ? '↗' : '✓'}</span><div><strong>{leg.unitLabel ?? crew?.name ?? id}</strong><span>{leg.unitId ? `${mobile ? 'PRIME drone relay jeep' : networkCrew ? 'Network service equipment truck' : hardening ? 'Civil maintenance vehicle' : 'Repair vehicle'} · ${hardening ? 'Pre-flood maintenance' : road?.staging ? 'Outside-flood staging' : 'Staging point awaiting route'}` : `${crew?.crew_type ?? leg.entry.work_order.crew_type} · ${crew?.members.length ?? '—'} personnel · ${legs.length} jobs`}</span>
            <span className="sim-current-job">{state}<br />{mobile ? `${pocketSize ? `${pocketSize} outage site${pocketSize === 1 ? '' : 's'} in target pocket` : `Outage pocket near ${leg.entry.tower_id}`} · Maintain drone signal from the edge` : networkCrew ? 'Support the network from outside the flood zone' : `${leg.entry.tower_id} · ${leg.entry.work_order.action.replaceAll('_', ' ')}`}</span>
            {mobile && road?.staging ? <span className="sim-road-measure">Fixed launch and return point · jeep stays with its drones</span> : measuredRoad?.status === 'routed' ? <span className="sim-road-measure">{measuredRoad.distance_km == null ? 'Distance unavailable' : measuredRoad.distance_km < 1 ? `${Math.round(measuredRoad.distance_km * 1000)} m by road` : `${measuredRoad.distance_km.toFixed(1)} km by road`} · {measuredRoad.duration_minutes == null ? 'ETA unavailable' : measuredRoad.duration_minutes < 1 ? '<1 min estimated' : `~${Math.round(measuredRoad.duration_minutes)} min estimated`}<br />{networkCrew ? 'Dry road staging · truck remains outside flood' : `Last ${road?.destination_snap ? Math.round(road.destination_snap.distance_m) : '—'} m to site: access unverified`}</span> : road?.reason && <span>{road.reason}</span>}
          </div></li>;
        })}</ul>
        {roads.deferred.length > 0 && <details className="sim-access-holds"><summary>{roads.deferred.length} jobs held for access review</summary><ul>{roads.deferred.map(leg => <li key={leg.id}><div><strong>{leg.entry.tower_id}</strong><span>{leg.road?.reason ?? (roads.unavailable ? 'Road data unavailable.' : 'Mapped location unavailable.')}</span></div></li>)}</ul></details>}
        <p className="sim-deployment-note">{roads.blocked.length} scenario road segments excluded. Routes follow mapped roads; vehicle timing is compressed.{scenarioFleet ? ' Drone coverage is illustrative; supporting vehicles remain outside the flood.' : ''} Final site access needs field confirmation.</p></>
        : <p className="sim-empty">{(roads.emergency ? emergencyStatus : optimizeStatus) === 'error' ? 'Optimizer unavailable. No dispatch is invented.' : status === 'idle' ? 'Play to connect the warning signals, assess sites and follow road dispatch.' : 'Waiting for confirmed assignments…'}</p>}
      <p className="sim-deployment-note">{roads.network?.status === 'available' ? `OpenStreetMap road snapshot · ${roads.network.source_updated_at?.slice(0, 10) ?? 'date unavailable'}` : 'Road network unavailable: movement is held until a route can be checked.'}</p>
    </div>
  </details>;
}
