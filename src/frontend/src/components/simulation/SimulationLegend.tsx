import type { Evidence } from '../../lib/simulationTimeline';
import { UNSCORED_INK } from '../../lib/colors';
import { MOBILE_COVERAGE_RADIUS_KM } from '../../lib/simulationCoverage';

/**
 * Names every overlay the simulation map draws, and which evidence category
 * it falls in. `docs/Disaster_Simulation_Spec.md` §8.3 — not optional, and
 * ships even if the rest of the honesty surface had to be cut, per §13's
 * "a demo without it overstates the system."
 *
 * The distinction this copy carries is deliberately "the action is real"
 * vs "this specific number/geometry is simulated" — never "this whole
 * thing is made up" (`docs/Disaster_Response_Actions.md`). Antenna retune
 * genuinely is what MCMC does; this project simply has no sector-level RF
 * data to compute the bearing for real.
 */
// Evidence classifications here MUST agree with lib/simulationTimeline.ts's
// per-beat classifications for the same concept — a review round caught
// 'mechanism' being used as a default for "scripted but plausible" rather
// than "this drawing mechanism genuinely exists in the codebase today",
// which is the distinction the badge exists to carry. See that file's
// Evidence doc comment and docs/Disaster_Response_Actions.md's real-vs-
// demo-only table, which settles each one.
const LEGEND_ENTRIES: { label: string; swatch: 'rain' | 'closure' | 'flood' | 'soil' | 'gap' | 'outage' | 'cone' | 'mocn' | 'device' | 'cow' | 'route' | 'generator'; evidence: Evidence }[] = [
  { label: 'Rainfall intensity', swatch: 'rain', evidence: 'illustrative' },
  { label: 'River / stream geometry (OSM)', swatch: 'flood', evidence: 'real' },
  { label: 'Relative river level (0–100)', swatch: 'flood', evidence: 'illustrative' },
  { label: 'Blocked road segments', swatch: 'closure', evidence: 'illustrative' },
  { label: 'Road route, excluding scenario closures', swatch: 'route', evidence: 'real' },
  // Hand-authored scenario polygon, not a flood-mapping mechanism's output.
  { label: 'Flood extent', swatch: 'flood', evidence: 'illustrative' },
  { label: 'Soil saturation cells (0–100 index)', swatch: 'soil', evidence: 'illustrative' },
  // Invented radius, not a propagation model (spec §15).
  { label: 'Remaining outage gap', swatch: 'gap', evidence: 'illustrative' },
  // The stated scenario premise itself — badging this 'mechanism' would
  // read as the system having produced the outage, which is the one thing
  // §0.6 forbids implying.
  { label: 'Tower outage (OFFLINE)', swatch: 'outage', evidence: 'illustrative' },
  // docs/Disaster_Response_Actions.md: pre-positioning ahead of an outage
  // (as opposed to dispatching one afterward) has no built mechanism —
  // sites come from the scenario's own flood-share ranking, not a query.
  { label: 'Generator on higher ground · tower stays online', swatch: 'generator', evidence: 'illustrative' },
  // The route, the crew and the tower are real optimizer and road-network
  // output — these are the run's own Sabah civil `raise_cabinet_and_seal`
  // orders. What is invented is the TRIGGER: nothing in this system
  // proposes pre-emptive work from a forecast, so the beat and this row
  // both stay 'illustrative'. See the `harden` beat in simulationTimeline.ts.
  { label: 'Pre-event hardening crew (route real, trigger scenario)', swatch: 'route', evidence: 'illustrative' },
  { label: 'Retuned sector cone', swatch: 'cone', evidence: 'illustrative' },
  { label: 'MOCN cross-operator link', swatch: 'mocn', evidence: 'illustrative' },
  { label: 'Outside-flood staging / response fleet', swatch: 'route', evidence: 'illustrative' },
  { label: 'PRIME jeeps: fixed drone launch and return positions', swatch: 'route', evidence: 'illustrative' },
  { label: 'Network service trucks: south hold / extended northern approach', swatch: 'route', evidence: 'illustrative' },
  // The jeep holds at outside-flood staging (MCMC practice: no ground crew
  // through standing water, enforced by the router's `avoid_flood`), so the
  // relay that reaches the gap is airborne. Radius is the SAME authored
  // 3.5 km the ground devices used — a higher antenna does extend line of
  // sight, but this project has no propagation model to size that with.
  { label: 'PRIME drone relays (spread across the outage zone)', swatch: 'device', evidence: 'illustrative' },
  { label: `Drone relay coverage / ${MOBILE_COVERAGE_RADIUS_KM} km illustrative radius`, swatch: 'cow', evidence: 'illustrative' },
  // Only drawn once /schedule/emergency has actually committed (P4) — the
  // route never appears without a real backend run behind it, so 'real'
  // describes what's on screen whenever this mark is visible at all rather
  // than a standing claim about every run.
  { label: 'Crew assignment (optimizer)', swatch: 'route', evidence: 'real' },
  { label: 'Crew movement and work progress', swatch: 'route', evidence: 'illustrative' },
  // Ground routes are held outside the flood while it stands; the roads
  // themselves are real OSM geometry, the access rule is MCMC practice.
  { label: 'Routes avoid the flood while water stands (MCMC access practice)', swatch: 'route', evidence: 'illustrative' },
];

const EVIDENCE_LABEL: Record<Evidence, string> = {
  real: 'REAL',
  mechanism: 'MECHANISM',
  illustrative: 'ILLUSTRATIVE',
};

const EVIDENCE_HINT: Record<Evidence, string> = {
  real: 'Sourced records, mapped roads or live optimizer output; road passability still needs field confirmation.',
  mechanism: 'The mechanism exists in this codebase; values here are scripted for the scenario.',
  // Two distinct reasons collapse into one badge on purpose (see the
  // Evidence doc comment in lib/simulationTimeline.ts): some illustrative
  // marks have no data behind the specific geometry (antenna bearing, MOCN
  // attribution), others have no built mechanism at all yet (site
  // hardening, COW, PRIME). Both read the same on screen because the
  // distinction that matters here is "the codebase cannot do this for
  // real today", not which specific reason applies.
  illustrative: 'Authored scenario conditions or response geometry; not measurements or a prediction.',
};

function Swatch({ kind }: { kind: (typeof LEGEND_ENTRIES)[number]['swatch'] }) {
  const common = 'h-3 w-3 shrink-0';
  switch (kind) {
    case 'rain':
      return <span aria-hidden="true" className={`${common} rounded-sm`} style={{ background: '#925ee0' }} />;
    case 'closure':
      return <span aria-hidden="true" className="w-3 shrink-0 border-t-[3px] border-dashed" style={{ borderColor: '#e95850' }} />;
    case 'flood':
      return (
        <span
          aria-hidden="true"
          className={`${common} rounded-sm`}
          style={{ backgroundColor: '#279fcb', opacity: 0.6 }}
        />
      );
    case 'soil':
      return <span aria-hidden="true" className={`${common} rounded-sm`} style={{ background: 'linear-gradient(90deg, #ccca97, #ad752f)' }} />;
    case 'gap':
      return <span aria-hidden="true" className={`${common} rounded-sm`} style={{ background: '#ff655e' }} />;
    case 'outage':
      // UNSCORED_INK, not a hardcoded hex — the same constant
      // SimulationMap's outage ring/label already draws from.
      return (
        <span
          aria-hidden="true"
          className={`${common} rounded-full border-2`}
          style={{ borderColor: UNSCORED_INK }}
        />
      );
    case 'cone':
      return <span aria-hidden="true" className={`${common} rounded-sm bg-overlay/16`} />;
    case 'mocn':
      return (
        <span
          aria-hidden="true"
          className="h-0 w-3 shrink-0 border-t-2 border-dashed border-overlay/60"
        />
      );
    case 'cow':
      return <span aria-hidden="true" className={`${common} rounded-[2px]`} style={{ background: '#32e6a5' }} />;
    case 'device':
      return <svg aria-hidden="true" className={common} viewBox="0 0 16 16" fill="none" stroke="#32e6a5" strokeWidth="1.4"><path d="M4 2a6 6 0 0 0 0 8M12 2a6 6 0 0 1 0 8M8 6v8M5 14h6" /><circle cx="8" cy="4" r="1.3" /></svg>;
    case 'generator':
      return <span aria-hidden="true" className={`${common} rounded-full bg-overlay/70`} />;
    case 'route':
      return <span aria-hidden="true" className={`${common} rounded-sm`} style={{ background: 'linear-gradient(#24343d 30%, #65f5ff 30% 70%, #24343d 70%)' }} />;
    default:
      return null;
  }
}

export function SimulationLegend() {
  return (
    <details
      className="group shrink-0 rounded-xl border border-overlay/10 bg-overlay/[0.03] p-3 open:pb-3"
      aria-label="Map legend and evidence key"
    >
      <summary className="eyebrow mb-2 flex cursor-pointer list-none items-center justify-between select-none">
        Legend
        <svg
          aria-hidden="true"
          viewBox="0 0 12 12"
          className="h-3 w-3 shrink-0 text-dim transition-transform group-open:rotate-180"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </summary>
      {/* Capped and scrollable rather than growing to fit 7 rows plus the
          footer: the console above is the narration and must stay the
          taller element in the right column even at reduced viewport
          heights — a legend that outgrows it inverts what the reader is
          meant to be looking at (flagged by simulation-ux-reviewer). */}
      <ul className="scroll-thin max-h-[132px] space-y-1.5 overflow-y-auto pr-0.5">
        {LEGEND_ENTRIES.map((entry) => (
          <li key={entry.label} className="flex items-center gap-2 text-ui">
            <Swatch kind={entry.swatch} />
            <span className="text-muted">{entry.label}</span>
            <span
              className="ml-auto shrink-0 rounded border border-overlay/20 px-1 py-px text-micro font-sans uppercase tracking-wide text-dim"
              title={EVIDENCE_HINT[entry.evidence]}
            >
              {EVIDENCE_LABEL[entry.evidence]}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 border-t border-overlay/[0.09] pt-2 text-micro leading-snug text-dim">
        Cyan follows mapped roads. Red excludes authored road closures. Fleet reinforcements and staging are authored;
        their targets come from optimizer assignments. PRIME vehicles remain at fixed dry positions;
        green coverage follows their airborne drone relays. Each drone returns to its original vehicle.
        Red shows the remaining outage gap. These footprints are illustrative, not measured signal or full restoration.
        Batteries provide backup power; drone relays provide temporary network coverage.
        Final site access remains unverified.{' '}
        REAL is sourced geometry or optimizer output. MECHANISM exists in this codebase with scripted
        values. ILLUSTRATIVE identifies authored rain, flood and soil conditions, coverage,
        travel and work animation. Terrain uses elevation tiles at their original height;
        towers and vehicles are enlarged for visibility. Cyan rings mark flood-response priority;
        amber rings retain nearby maintenance for follow-up, without changing site bands. Equipment
        condition uses synthetic demo telemetry, not observed field alarms.
      </p>
    </details>
  );
}
