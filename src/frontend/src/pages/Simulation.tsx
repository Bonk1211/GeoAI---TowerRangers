import { useEffect, useState } from 'react';
import { PageHeader } from '../components/ui/Panel';
import { SimulationMap } from '../components/simulation/SimulationMap';
import { SimulationBriefing, SimulationFleet, SimulationSceneCaption, SimulationSignals } from '../components/simulation/SimulationBriefing';
import { SimulationConsole } from '../components/simulation/SimulationConsole';
import { PhaseStrip } from '../components/simulation/PhaseStrip';
import { TransportBar } from '../components/simulation/TransportBar';
import { SimulationBanner } from '../components/simulation/SimulationBanner';
import { SimulationLegend } from '../components/simulation/SimulationLegend';
import { SimulationSummary } from '../components/simulation/SimulationSummary';
import { useSimulationBackendBeats } from '../components/simulation/useSimulationBackendBeats';
import { useSimulation } from '../state/useSimulation';
import { useSimulationRoads } from '../components/simulation/useSimulationRoads';
import './Simulation.css';

export function Simulation() {
  useSimulationBackendBeats();
  useEffect(() => () => useSimulation.getState().pauseSim(), []);
  const [cinematic, setCinematic] = useState(true);
  const roads = useSimulationRoads();
  const elapsedMs = useSimulation(s => Math.floor(s.elapsedMs / 1000) * 1000);
  const stage = elapsedMs < 15000 ? 0 : elapsedMs < 40000 ? 1 : elapsedMs < 54000 ? 2 : elapsedMs < 88000 ? 3 : 4;

  return (
    <div className="simulation-page flex h-full min-h-0 flex-col">
      <PageHeader title="Flood response simulation" subtitle="From early warning to field response. Every decision, in context.">
        <span className="sim-edition"><span /> SABAH / JUL 2024 SCENARIO</span>
      </PageHeader>
      <SimulationBanner />
      <main className="sim-workspace">
        <section className="sim-stage sim-stage-combined" aria-label="Interactive 3D scenario">
          <div className="sim-stage-toolbar">
            <div><span className="sim-eyebrow">OPERATIONS THEATRE</span><span className="sim-stage-location">Sabah west coast <span>/ Malaysia</span></span></div>
            <button className="sim-camera" type="button" aria-pressed={cinematic} onClick={() => setCinematic(!cinematic)} title="Automatic camera follows the scenario. Drag the map to explore freely.">
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3 5h9v10H3zM12 8l5-3v10l-5-3" /></svg>
              {cinematic ? 'Director camera' : 'Free camera'}
            </button>
          </div>
          <div className="sim-map-frame">
            <SimulationMap mode="combined" warning="rain" roads={roads} cinematic={cinematic} onCinematicChange={setCinematic} />
            <SimulationSceneCaption roads={roads} />
            <div className="sim-map-coordinate" aria-hidden="true">06° N &nbsp; 116° E <span>TERRAIN ×1 · SYMBOLS ENLARGED</span></div>
          </div>
          <ol className="sim-story-flow" aria-label="End-to-end decision flow">
            {['Read signals', 'Assess towers', 'Check roads', 'Dispatch crews', 'Review & repeat'].map((label, i) => <li key={label} aria-current={stage === i ? 'step' : undefined} data-complete={stage > i}><span>{String(i + 1).padStart(2, '0')}</span>{label}</li>)}
          </ol>
        </section>
        <aside className="sim-sidebar" aria-label="Scenario decision flow">
          <PhaseStrip />
          <SimulationSignals roads={roads} />
          <details className="sim-transcript" open><summary>Event transcript <span>Evidence & technical detail ↗</span></summary><div className="sim-transcript-body"><SimulationConsole roads={roads} /></div></details>
          <SimulationBriefing />
          <SimulationSummary />
          <SimulationFleet roads={roads} />
          <SimulationLegend />
        </aside>
      </main>
      <TransportBar />
    </div>
  );
}
