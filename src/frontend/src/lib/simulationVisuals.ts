// Illustrative normalized scenario values, not measured rainfall, soil moisture or hydraulics.
const RAIN: readonly [number, number][] = [
  [0, 0.2], [8_000, 0.48], [16_000, 0.76], [26_000, 1], [40_000, 1],
  [62_000, 0.78], [80_000, 0.45], [88_000, 0.16], [96_000, 0],
];
const WETNESS: readonly [number, number][] = [
  [0, 0.28], [15_000, 0.5], [26_000, 0.86], [40_000, 0.94],
  [62_000, 0.9], [80_000, 0.78], [88_000, 0.57], [96_000, 0.38],
];
// The delayed rise tells the scenario's sequence; it is not a fitted hydrological
// relationship or a reading from a river gauge. Elevated water lingers after rain.
const RIVER: readonly [number, number][] = [
  [0, 0.16], [8_000, 0.18], [16_000, 0.3], [24_000, 0.62], [32_000, 0.86],
  [47_000, 1], [62_000, 0.9], [80_000, 0.72], [88_000, 0.42], [96_000, 0.24],
];
const FLOOD: readonly [number, number][] = [
  [0, 0], [24_000, 0], [26_000, 1], [80_000, 1], [88_000, 0.35], [96_000, 0],
];

function clampedTime(elapsedMs: number): number {
  return Math.max(0, Math.min(96_000, Number.isNaN(elapsedMs) ? 0 : elapsedMs));
}

/** A slow attention pulse during assessment; seeking and pausing freeze the same frame. */
export function simulationAssessmentPulseAt(elapsedMs: number, reducedMotion = false): number {
  if (reducedMotion || !Number.isFinite(elapsedMs) || elapsedMs < 27_000 || elapsedMs >= 54_000) return 1;
  return 0.2 + 0.8 * (0.5 + 0.5 * Math.cos((elapsedMs - 27_000) / 1600 * Math.PI * 2));
}

function interpolate(points: readonly [number, number][], time: number): number {
  for (let i = 1; i < points.length; i++) {
    const [end, value] = points[i];
    if (time <= end) {
      const [start, previous] = points[i - 1];
      return previous + (value - previous) * ((time - start) / (end - start));
    }
  }
  return points[points.length - 1][1];
}

export function simulationEnvironmentAt(elapsedMs: number): { rain: number; wetness: number; river: number; flood: number } {
  const time = clampedTime(elapsedMs);
  return { rain: interpolate(RAIN, time), wetness: interpolate(WETNESS, time), river: interpolate(RIVER, time), flood: interpolate(FLOOD, time) };
}

/** Selected authored closures, not the whole road network or a live passability
 * feed. Reopening remains closed until the clearance at 88 seconds. */
export function simulationRoadAccessAt(elapsedMs: number): 'open' | 'blocked' | 'reopening' {
  const time = clampedTime(elapsedMs);
  return time < 24_000 || time >= 88_000 ? 'open' : time < 80_000 ? 'blocked' : 'reopening';
}

// Compressed illustrative travel, not measured journey or maintenance durations.
// ponytail: equal-duration legs; use dated schedule playback when real travel/work timing is available.
export function simulationCrewStepAt(
  elapsedMs: number, emergency: boolean, legCount: number, reducedMotion = false,
): { legIndex: number; travel: number } | null {
  const start = emergency ? 54_000 : 15_000;
  const end = emergency ? 88_000 : 40_000;
  if (!Number.isFinite(elapsedMs) || elapsedMs < start || elapsedMs >= end
    || !Number.isSafeInteger(legCount) || legCount <= 0) return null;
  const progress = Math.max(0, Math.min(1, (elapsedMs - start) / (end - start - 1_500))) * legCount;
  const legIndex = Math.min(legCount - 1, Math.floor(progress));
  const legProgress = reducedMotion ? 1 : Math.min(1, progress - legIndex);
  return { legIndex, travel: Math.max(0, Math.min(1, legProgress / 0.65)) };
}

export interface SimulationScene {
  id: string;
  title: string;
  observation: string;
  decision: string;
  action: string;
}

const SCENES: readonly [number, SimulationScene][] = [
  [0, {
    id: 'forecast',
    title: 'Watch the warning signs connect',
    observation: 'Scenario rain strengthens first; ground wetness and river rise follow.',
    decision: 'Read rainfall, ground, river and access conditions together.',
    action: 'Compare exposed sites with the wider maintenance priority list.',
  }],
  [15_000, {
    id: 'prepare',
    title: 'Civil crews complete preventive maintenance',
    observation: 'Civil crews reach the exposed towers before floodwater arrives.',
    decision: 'Finish sealing and drainage work, then confirm the exit route.',
    action: 'Keep the flood corridor clear before water rises.',
  }],
  [19_000, {
    id: 'exit-plan',
    title: 'Finish maintenance. Confirm the exit route.',
    observation: 'The yellow dashed route and arrows show each crew’s planned way out.',
    decision: 'Complete work at the tower before leaving along the confirmed route.',
    action: 'Follow each vehicle continuously from its maintenance site to the dry edge.',
  }],
  [20_500, {
    id: 'evacuate',
    title: 'Maintenance complete — civil crews exit',
    observation: 'Crews follow the yellow routes out of the future flood area.',
    decision: 'Clear the corridor before the flood begins to rise.',
    action: 'Hold the crews at their dry road endpoints.',
  }],
  [23_500, {
    id: 'civil-clear',
    title: 'Civil crews are clear. Flood rise follows.',
    observation: 'Maintenance is complete and the civil vehicles are outside the flood corridor.',
    decision: 'Keep all ground crews outside as water rises.',
    action: 'Monitor flood exposure and prepare remote network support.',
  }],
  [24_000, {
    id: 'impact',
    title: 'Flood reaches the towers',
    observation: 'The authored flood spreads and road access becomes constrained.',
    decision: 'Identify the affected sites and scenario outages in the flood corridor.',
    action: 'Widen the assessment to nearby priority towers before deciding the response order.',
  }],
  [27_000, {
    id: 'prioritise',
    title: 'Priority shifts to flood response',
    observation: 'Blinking towers still need maintenance. The flood emergency takes immediate response priority.',
    decision: 'Prioritise immediate flood response; blinking amber towers retain their maintenance priority.',
    action: 'Keep other maintenance on the follow-up list and check roads into the flood area.',
  }],
  [40_000, {
    id: 'continuity',
    title: 'Protect coverage. Confirm access.',
    observation: 'Rain begins to ease while wet ground, high rivers and blocked access persist.',
    decision: 'Keep flood response first while confirming which affected sites crews can reach.',
    action: 'Support coverage, exclude blocked roads and prepare the available response routes.',
  }],
  [54_000, {
    id: 'staging',
    title: 'Keep PRIME vehicles fixed at the flood edge',
    observation: 'The mobile network vehicles hold outside the flood for their drone links.',
    decision: 'Keep the launch and return positions fixed throughout the response.',
    action: 'Prepare drone relays to reach the flooded towers.',
  }],
  [62_000, {
    id: 'drone-launch',
    title: 'Drones fly in. PRIME vehicles hold position.',
    observation: 'Multiple drones launch from the two stationary PRIME jeeps beyond the flood boundary.',
    decision: 'Use airborne relays while ground access remains flooded.',
    action: 'Maintain each drone’s link to its originating PRIME vehicle.',
  }],
  [68_000, {
    id: 'mobile-support',
    title: 'Drone relays provide temporary coverage',
    observation: 'Drones spread across the outage zone while their PRIME jeeps stay at the edge.',
    decision: 'Keep ground support outside the flood.',
    action: 'Keep two service crews at the south edge and prepare two crews for the longer northern approach.',
  }],
  [72_000, {
    id: 'network-dispatch',
    title: 'South crews hold. Tabobon crews approach the north edge.',
    observation: 'Crews 1 and 2 remain at the south edge. Crews 3 and 4 follow the longer dry-road approach to the northern flood edge.',
    decision: 'Keep both positions supported without moving the PRIME launch vehicles.',
    action: 'Hold crews 3 and 4 at the northern edge when they arrive.',
  }],
  [78_000, {
    id: 'network-hold',
    title: 'Both edge positions are supported',
    observation: 'Two network crews hold at each position; the PRIME vehicles maintain the drone links.',
    decision: 'Keep vehicles clear of the flooded area until recovery is confirmed.',
    action: 'Maintain temporary coverage while the towers recover.',
  }],
  [80_000, {
    id: 'restore',
    title: 'Restore service. Recheck the ground.',
    observation: 'Scenario service returns as rain and river levels ease; road reopening is reviewed.',
    decision: 'Check restoration and access before releasing response capacity.',
    action: 'Keep the same vehicles outside the flood; retain each drone’s return position.',
  }],
  [88_000, {
    id: 'recover',
    title: 'Drones return to their own PRIME vehicles',
    observation: 'Each drone retraces its flight to the stationary vehicle it launched from.',
    decision: 'Retain residual exposure and priority sites outside the flood in the next plan.',
    action: 'Keep the vehicles in place until their drones have landed.',
  }],
];

export function simulationSceneAt(elapsedMs: number, roadUnavailable = false, mobileDeployed = true): SimulationScene {
  const time = clampedTime(elapsedMs);
  if (roadUnavailable && time >= 54_000 && time < 88_000) return {
    id: 'access-hold', title: 'Hold the response until roads are checked',
    observation: 'Road data is unavailable. Crew movement and mobile deployment are on hold.',
    decision: 'Confirm mapped access before dispatching response vehicles.',
    action: 'Keep affected sites in the plan and request a road-access review.',
  };
  if (!mobileDeployed && time >= 68_000 && time < 80_000) return {
    id: 'mobile-access-check', title: 'Confirm the drone relay launch positions',
    observation: 'No drone relay is on station from a confirmed launch position yet.',
    decision: 'Keep the outage gaps visible until mobile radio coverage is available.',
    action: 'Review pending launch access before activating temporary coverage.',
  };
  for (let i = SCENES.length - 1; i >= 0; i--) {
    if (time >= SCENES[i][0]) return SCENES[i][1];
  }
  return SCENES[0][1];
}
