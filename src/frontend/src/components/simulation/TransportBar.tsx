import { useSimulation } from '../../state/useSimulation';
import { TOTAL_DURATION_MS } from '../../lib/simulationTimeline';
import { useLiveTowers } from '../../api/useLiveTowers';
import { useWeights } from '../../state/useWeights';

const SPEEDS = [1, 2, 4] as const;
const time = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export function TransportBar() {
  const status = useSimulation((s) => s.status);
  const elapsedMs = useSimulation((s) => s.elapsedMs);
  const speed = useSimulation((s) => s.speed);
  const weights = useWeights((s) => s.weights);
  const { towers, isLoading } = useLiveTowers(weights);
  const waitingForSites = isLoading || towers.length === 0;
  const handlePlayPause = () => {
    const sim = useSimulation.getState();
    if (status === 'idle' || status === 'done') sim.start(towers);
    else if (status === 'running') sim.pauseSim();
    else sim.resumeSim();
  };

  return (
    <div className="sim-transport" role="group" aria-label="Simulation transport">
      <button className="sim-play" type="button" disabled={waitingForSites && (status === 'idle' || status === 'done')} onClick={handlePlayPause} aria-label={status === 'running' ? 'Pause' : 'Play'}>
        <svg viewBox="0 0 12 12" aria-hidden="true">{status === 'running' ? <path d="M2 1h3v10H2zM7 1h3v10H7z" /> : <path d="m3 1 8 5-8 5z" />}</svg>
        {waitingForSites && status === 'idle' ? isLoading ? 'Loading sites…' : 'No sites available' : status === 'running' ? 'Pause' : status === 'paused' ? 'Resume' : status === 'done' ? 'Replay' : 'Play scenario'}
      </button>
      <button className="sim-reset" type="button" aria-label="Reset simulation" title="Reset simulation" onClick={() => useSimulation.getState().resetSim()}>↺</button>
      <span className="sim-time tnum">{time(elapsedMs)} <span>/ {time(TOTAL_DURATION_MS)}</span></span>
      <div className="sim-timeline">
        <div className="sim-timeline-labels" aria-hidden="true"><span>PREPARE</span><span>IMPACT</span><span>RESPOND</span><span>RECOVER</span></div>
        <input type="range" disabled={waitingForSites && status === 'idle'} aria-label="Scrub scenario time" aria-valuetext={`${time(elapsedMs)} of ${time(TOTAL_DURATION_MS)}`} min={0} max={TOTAL_DURATION_MS} step={100} value={elapsedMs} onChange={(e) => {
          const sim = useSimulation.getState();
          // A first seek needs the same scenario selection as Play.
          if (sim.status === 'idle') sim.start(towers);
          useSimulation.getState().seekSim(Number(e.target.value));
        }} />
      </div>
      <div className="sim-speeds" role="group" aria-label="Playback speed">{SPEEDS.map((s) => <button key={s} type="button" aria-pressed={speed === s} onClick={() => useSimulation.getState().setSpeed(s)}>{s}×</button>)}</div>
    </div>
  );
}
