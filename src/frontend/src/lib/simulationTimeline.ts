/**
 * The Disaster Simulation beat table and pure selectors over it.
 * `docs/Disaster_Simulation_Spec.md` §6.
 *
 * No React, no side effects, no map/DOM access — this module only knows
 * "what beat fires when" and "what phase is the clock in". Everything that
 * turns a beat into a map effect or a real backend call lives elsewhere
 * (P3-P4), reading this table rather than duplicating it.
 *
 * Total runtime at 1x is ~2 minutes (`TOTAL_DURATION_MS`), matching spec §6's
 * "short enough to run twice in a Q&A" target.
 */

import { FLOOD_PRIORITY_MS } from './simulationVisuals.ts';

export type SimulationPhase = 'pre' | 'impact' | 'response' | 'recovery';

export type BeatKind = 'scripted' | 'backend';

/**
 * Drives the console's per-line evidence badge (spec §8.1). Three states,
 * each rendered with a WORD as well as a hue so a colour-blind reader is
 * not excluded — this module only carries the classification, never the
 * colour.
 *
 * `real` beats resolve from a live endpoint. `mechanism` beats describe a
 * mechanism that genuinely EXISTS AND RUNS in this codebase today, with
 * only its scenario values scripted — `flood/forecast.py` shortening
 * urgency, `scheduler/reserve.py` holding crew-days, `model/feedback.py`'s
 * observation ledger. `illustrative` beats are real MCMC/telco practice
 * (`docs/Disaster_Response_Actions.md`) that either has no data behind the
 * specific number (antenna bearing, MOCN's "which operator") OR has no
 * built mechanism behind it AT ALL yet (site hardening, COW, PRIME are all
 * marked "not yet built" / "out of scope for now" in that doc's own
 * real-vs-demo-only table) — both failure modes get the same badge, because
 * the distinction the badge exists to carry is "does the codebase actually
 * do this", not "is the number believable".
 *
 * `mechanism` is not a synonym for "scripted but plausible" — see the P6
 * build-log entry for the review that caught exactly that drift and the
 * per-beat table in `docs/Disaster_Response_Actions.md` §"What is real vs
 * demo-only" that settles each one.
 */
export type Evidence = 'real' | 'mechanism' | 'illustrative';

export type SimulationEffectKind =
  | 'flood-onset'
  | 'flood-retract'
  | 'tower-down'
  | 'tower-restore'
  | 'coverage-gap-open'
  | 'coverage-gap-close'
  | 'sector-retune'
  | 'sector-reset'
  | 'mocn-link'
  | 'cow-deploy'
  | 'cow-withdraw'
  | 'crew-route'
  | 'reserve-activate'
  | 'reserve-release';

export interface SimulationEffect {
  kind: SimulationEffectKind;
}

export interface Beat {
  id: string;
  /** Offset from run start, in ms, at 1x speed. */
  atMs: number;
  phase: SimulationPhase;
  /** Scenario clock label shown beside the console line, e.g. "T-72h". */
  clockLabel: string;
  /**
   * Plain-language summary of what just happened — the line a first-time
   * viewer (a hackathon judge, an MCMC officer who has not seen the
   * codebase) reads and understands without decoding anything (2026-09-20).
   *
   * Rules this field exists to enforce, all of which `console` breaks on
   * purpose because it is the technical transcript:
   *   - No API paths. "POST /schedule/optimize" means nothing to a judge.
   *   - No raw tower ids. "MY_N10251772774" is noise at a glance.
   *   - No unexpanded acronyms. GFS, GloFAS, NMC, MOCN, PRIME, PPS and
   *     SESB are all real and all opaque to someone outside the field.
   *   - One line at the rendered width, so the eye can scan the column
   *     rather than read it. Several `console` strings currently wrap to
   *     three or four lines, which is what made the transcript unreadable
   *     at a glance in the first place.
   *
   * May carry the same `<n>`/`<k>`/`<tower_id>` placeholders `console`
   * does; `resolveConsoleLine` fills both from the same live values, so
   * the headline and the detail can never disagree about a number.
   */
  headline: string;
  /** The technical transcript line — kept in full, shown as secondary
   *  detail under `headline`. This is where the caveats, real-event
   *  figures and provenance live; it is deliberately denser than the
   *  headline rather than a duplicate of it. May contain a
   *  `<n>`/`<k>`/`<tower_id>` style placeholder resolved by the caller
   *  from live data — this module only owns the beat's static shape and
   *  timing. */
  console: string;
  kind: BeatKind;
  effect?: SimulationEffect;
  evidence: Evidence;
}

/**
 * Every beat, in the order the spec's four phase tables list them. `atMs`
 * spacing is authored for readability, not physics: pre-event narration runs
 * long enough to cover a solver round-trip (spec §7 rule 1 — the optimize
 * call is prefetched at Start, and the first ~15s of timeline is its cover).
 */
export const BEATS: Beat[] = [
  // --- Phase 1: pre-event (T-72h -> T-24h) ---------------------------------
  {
    id: 'forecast',
    atMs: 0,
    phase: 'pre',
    clockLabel: 'T-72h',
    headline: 'Heavy rain forecast for Sabah west coast',
    console: 'GFS 24h rainfall + GloFAS days 1-3 outlook crossing threshold over Sabah west coast',
    kind: 'scripted',
    effect: { kind: 'flood-onset' },
    evidence: 'mechanism',
  },
  {
    id: 'urgency-shift',
    atMs: 4000,
    phase: 'pre',
    clockLabel: 'T-60h',
    headline: 'Flood-exposed towers moved up the queue (<n> in Sabah)',
    console: 'Urgency multiplier applied to flood-coupled factors — <n> Sabah towers in the maintain-band run',
    kind: 'scripted',
    evidence: 'mechanism',
  },
  {
    id: 'optimize',
    atMs: 9000,
    phase: 'pre',
    clockLabel: 'T-48h',
    headline: 'Maintenance plan built: <n> jobs across <k> crews',
    console: 'POST /schedule/optimize -> <n> work orders across <k> crews',
    kind: 'backend',
    effect: { kind: 'crew-route' },
    evidence: 'real',
  },
  {
    id: 'flood-priority',
    atMs: FLOOD_PRIORITY_MS,
    phase: 'pre',
    clockLabel: 'T-42h',
    headline: 'Priority shifts to flood response',
    console: 'Flood preparation takes priority before civil maintenance dispatch. Prepare exposed towers first, confirm inbound and evacuation routes, and keep other maintenance on the follow-up list.',
    kind: 'scripted',
    evidence: 'illustrative',
  },
  {
    id: 'harden',
    atMs: 15000,
    phase: 'pre',
    clockLabel: 'T-36h',
    headline: 'Civil crews assigned to <n> sites; access checked first',
    console: 'Civil maintenance planned at <n> sites — cabinet raise, ingress seal, drainage clear. Only crews with complete inbound and evacuation routes depart; other sites remain on access hold. Crew, tower and road data are real; pre-emptive dispatch and timing are authored scenario choices.',
    kind: 'scripted',
    effect: { kind: 'crew-route' },
    // Illustrative, and the line now says WHICH HALF is invented rather
    // than leaving the routed vehicles on screen to imply the whole beat is
    // real (2026-09-21, fan-out build).
    //
    // Real: the towers, the civil crews, their Kota Kinabalu depot origin,
    // and every metre of road geometry — these legs are the optimize run's
    // own Sabah civil `raise_cabinet_and_seal` orders, routed through the
    // same /travel/simulation-routes endpoint the emergency legs use. That
    // action IS flood weatherproofing ("Raise equipment cabinet, seal
    // ingress, clear/install drainage", config/actions.yaml).
    //
    // Invented: the TRIGGER. `propose_action()` emits that order from a
    // tower's standing flood risk, never from a forecast, and
    // `flood/forecast.py` only shortens `urgency_days` — no mechanism here
    // turns "storm inbound" into pre-emptive work. docs/
    // Disaster_Response_Actions.md marks site hardening "Real practice, not
    // yet built". Upgrading this beat to 'mechanism' needs a real
    // `flood_preemptive_hardening` key in actions.yaml resolving through
    // propose_action(), which is a backend change this build did not make.
    evidence: 'illustrative',
  },
  {
    id: 'generators',
    atMs: 19000,
    phase: 'pre',
    clockLabel: 'T-24h',
    headline: 'Backup power ready; civil crews confirm exit routes',
    console: 'Portable generators pre-positioned at <n> flood-prone sites on higher ground keep those towers online during the flood. Low-ground sites cannot host generators and rely on mobile drone coverage after power cuts. Civil crews follow the highlighted exit routes before flood onset.',
    kind: 'scripted',
    // Illustrative: generator pre-positioning is not its own built
    // mechanism (docs/Disaster_Response_Actions.md: dispatch is "mostly
    // built" via the existing power factor, but PRE-positioning ahead of
    // an outage is not), and <n> here is a scenario count, not a query
    // over real data.
    evidence: 'illustrative',
  },

  // --- Phase 2: impact (T-0) ------------------------------------------------
  {
    id: 'flood-onset',
    atMs: 24000,
    phase: 'impact',
    clockLabel: 'T-0',
    headline: 'Civil crews clear — floodwater begins rising',
    console: 'Civil maintenance and evacuation complete before the authored flood expands — Penampang, Kota Kinabalu, Tuaran, Kota Marudu',
    kind: 'scripted',
    effect: { kind: 'flood-onset' },
    // Illustrative, not mechanism: this specific polygon is hand-authored
    // scenario geometry (fixtures/scenarios/sabahFlood.ts), not the output
    // of any flood-mapping mechanism in this codebase. Distinct from the
    // `forecast`/`urgency-shift` beats above, whose underlying urgency-
    // coupling mechanism genuinely runs — this beat is the premise those
    // beats warned about arriving, not a re-application of that mechanism.
    evidence: 'illustrative',
  },
  {
    id: 'tower-down',
    atMs: 27000,
    phase: 'impact',
    clockLabel: 'T-0',
    headline: '41 towers knocked offline (real July 2024 event)',
    console: '41 towers affected across 4 districts (real, Jul 2024) — scenario picks <tower_id> as this run\'s dispatch focus',
    kind: 'scripted',
    effect: { kind: 'tower-down' },
    // Illustrative: the line's own text says "scenario picks", and the
    // badge must agree rather than call a stated premise a "mechanism" —
    // caught by mcmc-domain-reviewer, who read this as the badge closest to
    // implying the system itself produced the outage. The "41 towers /
    // 4 districts" figure IS real (docs/Disaster_Response_Actions.md,
    // MCMC/Bernama, Jul 2024) but this run only visualises one tower's
    // dispatch against it — the aggregate is narration, not a rendered count.
    evidence: 'illustrative',
  },
  {
    id: 'cause-breakdown',
    atMs: 30000,
    phase: 'impact',
    clockLabel: 'T-0',
    headline: 'Most outages are power cuts, not broken equipment',
    console: 'Outage cause split (real, Jul 2024): 34/41 power cut by utility for safety, 5/41 access road flooded, 2/41 equipment damage',
    kind: 'scripted',
    // Illustrative: real reported figures (MCMC/Bernama, Jul 2024), but
    // this project's feature table has no per-tower outage-cause field —
    // the split is narrated, not computed from any tower's own record.
    evidence: 'illustrative',
  },
  {
    id: 'taskforce',
    atMs: 34000,
    phase: 'impact',
    clockLabel: 'T+1h',
    headline: 'Response task force activated; spare crew capacity held',
    console: 'Task force activated — MCMC + telco + SESB joint monitoring. Collector sites prioritised first, then other affected sites. Reserve crew-days held.',
    kind: 'scripted',
    effect: { kind: 'reserve-activate' },
    // 'mechanism': the reserve-hold half of this line maps to a real,
    // running mechanism (scheduler/reserve.py). The "collector sites
    // prioritised first" clause is real MCMC practice (task-force meetings
    // are reported to prioritise collector sites) but this project's
    // optimizer has no site-role field to actually order by — stated as
    // fact, not computed, which is why the beat stays 'mechanism' only for
    // the reserve clause and the comment flags the priority clause as
    // narration riding alongside a real mechanism rather than itself real.
    evidence: 'mechanism',
  },

  // --- Phase 3: response (T+1h -> T+12h), remote first, truck rolls last --
  {
    id: 'antenna-retune',
    atMs: 40000,
    phase: 'response',
    clockLabel: 'T+2h',
    headline: '<n> nearby towers re-aimed remotely to cover the gap',
    console: 'NMC remote adjustment — <n> neighbouring cells: downtilt + azimuth widened, TX power boosted',
    kind: 'scripted',
    effect: { kind: 'sector-retune' },
    evidence: 'illustrative',
  },
  {
    id: 'mocn',
    atMs: 47000,
    phase: 'response',
    clockLabel: 'T+3h',
    headline: 'Customers switched onto a rival operator\'s tower',
    console: 'MOCN failover — affected subscribers routed onto surviving cross-operator cell',
    kind: 'scripted',
    effect: { kind: 'mocn-link' },
    evidence: 'illustrative',
  },
  {
    id: 'generator-dispatch',
    atMs: 54000,
    phase: 'response',
    clockLabel: 'T+4h',
    // <n> resolves to the real number of down towers the fan-out dispatch
    // committed against (2026-09-17, operator review) — was a single
    // <tower_id>, which read as "dispatch reaches one site" when the
    // backend call underneath it already fans out to every down tower
    // against the same run_id (see useSimulationBackendBeats.ts). A real
    // flood does not knock out one site, and the console line must not
    // claim a narrower response than the commit it is reporting.
    //
    // Wording changed AGAIN the same day (mcmc-domain-reviewer, C8 review
    // pass): "generator dispatch" named a SPECIFIC action every one of the
    // <n> commits does not necessarily book. `emergency_dispatch` pins each
    // tower's own dominant-factor work order (`_resolve_work_orders`,
    // `api/routes/schedule.py`) — only a POWER-dominant tower resolves to
    // `battery_genset_service` (`config/actions.yaml`); this scenario
    // selects its down towers by FLOOD share (`sabahFlood.ts`), so most
    // resolve to `flood_*` civil work, not a genset. Naming the action
    // "generator dispatch" for a run of mostly non-generator work orders is
    // the same failure mode §0.6 exists to prevent, just on an action
    // label instead of a failure label. "Emergency work orders committed"
    // makes no claim about WHICH action each pin resolved to — only that
    // one was force-inserted today, which every one of the <n> commits
    // genuinely did.
    //
    // Also unstated until now: every commit targets the SAME hardcoded
    // crew (`SABAH_POWER_CREW_ID`, useSimulationBackendBeats.ts) — up to
    // MAX_DOWN_TOWERS (12) emergency pins landing on one crew in one
    // horizon is not a plausible parallel response, and contradicts the
    // real July 2024 record this scenario cites (phased restoration, 14 of
    // 41 towers in ~2 days, not all-at-once). "-> crew SBH-P1" makes that
    // scope visible rather than leaving a viewer to assume a fleet-wide
    // response the run did not commit.
    // Reworded 2026-09-21: with the flood-access rule in force, crews stop
    // at the flood EDGE while the water stands rather than reaching the
    // sites. The /schedule/emergency commit underneath is unchanged and
    // still real — only the claim about arrival is corrected, because the
    // map now (correctly) shows vehicles held outside the polygon.
    headline: 'Emergency work orders committed for <n> offline sites',
    console: 'Emergency work orders committed -> <n> offline sites (crew SBH-P1); crews staged at flood edge pending access — MCMC practice bars ground entry while water stands',
    kind: 'backend',
    effect: { kind: 'crew-route' },
    evidence: 'real',
  },
  {
    id: 'cow',
    atMs: 62000,
    phase: 'response',
    clockLabel: 'T+6h',
    headline: 'Drone relays launch to cover the outage zone',
    console: '<n> airborne relay(s) cover the outage zone; drones launch from two fixed PRIME jeeps outside the flood and return to those same vehicles',
    kind: 'scripted',
    effect: { kind: 'cow-deploy' },
    // Mission count and coverage come from the same authored drone plan.
    // The flight paths and radio radii illustrate a response; they are not
    // measured propagation or a real operator sortie plan.
    evidence: 'illustrative',
  },
  {
    id: 'prime',
    atMs: 70000,
    phase: 'response',
    clockLabel: 'T+12h',
    headline: 'Drone relays spread across the outage zone',
    console: 'Multiple MCMC PRIME drone relays cover the outage zone from two fixed jeep launch positions. No ground crew enters standing water. Relay radius is an authored display figure, not measured propagation',
    kind: 'scripted',
    // Illustrative: docs/Disaster_Response_Actions.md marks PRIME "Real
    // practice, out of scope for now". PRIME units and their drone-relay
    // capability are real and cited there; the flight path, hover point,
    // timing and coverage radius here are all authored scenario values, and
    // no mechanism in this codebase plans a sortie.
    //
    // Reframed 2026-09-21 (operator review). The beat used to say "mobile
    // internet unit sent to an evacuation centre", which this project has
    // no data to place — there is no PPS location in the dataset. What the
    // map can now honestly show is the half that follows from the flood
    // access rule: once ground routes may not cross standing water
    // (`avoid_flood`, scheduler/simulation_routing.py), the jeep CANNOT
    // reach the gap, so the relay that does reach it must be airborne. The
    // radius is deliberately MOBILE_COVERAGE_RADIUS_KM — the same 3.5 km
    // the ground-placed devices use — because a higher antenna does extend
    // line of sight but this project has no propagation model to size that
    // with, and enlarging it because the emitter flies would be exactly the
    // plausible-looking fabrication the evidence badges exist to catch.
    evidence: 'illustrative',
  },

  {
    id: 'network-crews',
    atMs: 72000,
    phase: 'response',
    clockLabel: 'T+12h',
    headline: 'South crews hold; Tabobon crews approach the north edge',
    console: 'Network service crews 1 and 2 remain at the south dry edge. Crews 3 and 4 follow the longer mapped dry-road approach to the northern flood edge near Kampung Tabobon. Both PRIME jeeps stay fixed for drone signal and return.',
    kind: 'scripted',
    evidence: 'illustrative',
  },

  // --- Phase 4: recovery (T+24h -> T+48h) ----------------------------------
  {
    id: 'restore',
    atMs: 80000,
    phase: 'recovery',
    clockLabel: 'T+24h',
    headline: 'All towers back online',
    console: 'Offline sites restored (including <tower_id>). Real Jul 2024 pace: 14/41 towers back within ~2 days, full restoration took longer — this run compresses that into a single recovery beat',
    kind: 'scripted',
    effect: { kind: 'tower-restore' },
    // Illustrative: the inverse of `tower-down` — a scenario premise (the
    // outage resolving) rather than a codebase mechanism producing this
    // specific restoration event. The "14/41 in ~2 days" figure is real
    // (docs/Disaster_Response_Actions.md); stated explicitly so the single
    // clean restore beat does not imply the real event resolved that fast.
    evidence: 'illustrative',
  },
  {
    id: 'withdraw',
    atMs: 88000,
    phase: 'recovery',
    clockLabel: 'T+36h',
    headline: 'Flood receding — temporary equipment pulled back',
    console: 'Each drone returns to its original stationary PRIME vehicle; ground vehicles hold outside the flood. Sectors returned to nominal; reserve released.',
    kind: 'scripted',
    effect: { kind: 'cow-withdraw' },
    // Illustrative: the line is dominated by the temporary-BTS withdrawal
    // and sector reset, neither of which has a built mechanism (no
    // schedulable action type exists for it yet; sector retuning is
    // illustrative geometry per the antenna-retune beat above). Reserve
    // release alone would be 'mechanism' (scheduler/reserve.py is real),
    // but this line does not isolate that clause.
    evidence: 'illustrative',
  },
  {
    id: 'ledger',
    atMs: 96000,
    phase: 'recovery',
    clockLabel: 'T+48h',
    headline: 'Outcome recorded for future model training',
    console: 'Outcome appended to observation ledger — unlabeled until confirmed',
    kind: 'scripted',
    evidence: 'mechanism',
  },
];

/** After the last beat, hold a few seconds before `status` flips to `done`
 *  so the final line is readable rather than snapping straight to a summary. */
export const TAIL_MS = 6000;

export const TOTAL_DURATION_MS = BEATS[BEATS.length - 1].atMs + TAIL_MS;

/**
 * Every beat whose `atMs` has arrived by `ms`, in table order. Monotone in
 * `ms` and never re-fires a beat that has already passed — the caller is
 * expected to diff this against the beats it already rendered (or use
 * `beatAtIndex`/id-based dedupe), which is why this returns the full prefix
 * rather than "beats since last call": a pure function cannot remember what
 * it returned last time, and re-deriving the full prefix from clock state is
 * what makes `seek` (including backwards) correct for free.
 */
export function beatsUpTo(ms: number): Beat[] {
  if (ms < 0) return [];
  return BEATS.filter((b) => b.atMs <= ms);
}

/**
 * The phase the clock is in at `ms`. Each phase owns the half-open interval
 * `[its first beat's atMs, the next phase's first beat's atMs)`; the final
 * phase extends to `TOTAL_DURATION_MS` inclusive of the tail hold. Before the
 * first beat (`ms < 0`, which should not happen but is not asserted against)
 * this still returns `'pre'` rather than throwing, since `'pre'` is the
 * lowest phase and a negative clock is closer to "hasn't started" than to
 * any other phase.
 */
export function phaseAt(ms: number): SimulationPhase {
  const boundaries = phaseBoundaries();
  let phase: SimulationPhase = 'pre';
  for (const b of boundaries) {
    if (ms >= b.atMs) phase = b.phase;
  }
  return phase;
}

function phaseBoundaries(): { phase: SimulationPhase; atMs: number }[] {
  const seen = new Set<SimulationPhase>();
  const boundaries: { phase: SimulationPhase; atMs: number }[] = [];
  for (const beat of BEATS) {
    if (!seen.has(beat.phase)) {
      seen.add(beat.phase);
      boundaries.push({ phase: beat.phase, atMs: beat.atMs });
    }
  }
  return boundaries;
}

/** Look up one beat by id. Used by the store/UI to resolve a fired-beat-id
 *  list back into full beat records without re-filtering the whole table. */
export function beatById(id: string): Beat | undefined {
  return BEATS.find((b) => b.id === id);
}
