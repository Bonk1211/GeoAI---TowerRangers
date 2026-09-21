import { todayIso } from '../lib/scheduleDays';
import { create } from 'zustand';
import type { ScheduleEntry, ScheduleRun } from '../api/types';
import type { DispatchAnimation } from '../lib/dispatchAnimation';

export type ScheduleViewMode = 'crew' | 'tower';

const EMPTY_RUN: ScheduleRun = {
  run_id: '',
  horizon: [],
  entries: [],
  reserve: [],
  unscheduled: [],
  unscheduled_detail: [],
  risk_weighted_wait: 0,
};

/**
 * What the planner has picked, and what kind of thing it is.
 *
 * Selection used to be {crew_id, day}, which was right when a day was one
 * grid cell. The hour-axis timeline draws one bar per job, so a crew-day
 * selection cannot address the second job of a day — WhySlotPanel resolved it
 * with a .find() on crew+day and always returned the first. The kind tag also
 * replaces the old parallel field that separately tracked an emergency
 * dispatch target, which could disagree with the old cell-selection field
 * about what was actually selected.
 */
export type Selection =
  | { kind: 'job'; crew_id: string; day: string; tower_id: string }
  | { kind: 'free'; crew_id: string; day: string }
  | { kind: 'reserve'; crew_id: string; day: string }
  | { kind: 'emergency'; tower_id: string; day: string }
  // Raised from the Ranger dock's pending-ticket strip, for a ticket
  // useAutoDispatch flagged schedule_pending. Carries day like every other
  // variant so select() keeps the board on the day being decided.
  | { kind: 'ticket_approval'; ticket_id: string; day: string }
  // Raised from the map, not from the board: a tower with a satellite hotspot
  // inside its screening buffer that a planner has asked to review for an
  // inspection. It carries no crew_id because no crew has been chosen yet —
  // choosing one, and attesting to safe access, is what the review panel is
  // for. It does carry `day`, as every variant must: select() below reads
  // selection.day into selectedDay unconditionally.
  | { kind: 'fire_inspection'; tower_id: string; day: string };

interface ScheduleStoreState {
  // Identifies the live run on the backend; null until the first optimize
  // call resolves (api/useLiveSchedule.ts owns fetching the run itself).
  runId: string | null;
  setRunId: (id: string) => void;
  // Set only if the optimizer call fails outright (step 7 offline path) —
  // holds the fixture run so the schedule pages keep working, banner-flagged.
  // Mutated locally (no backend to call), mirroring the old fixture-only
  // pin/move/emergency behaviour.
  offlineRun: ScheduleRun | null;
  setOfflineRun: (run: ScheduleRun | null) => void;
  offlinePin: (tower_id: string, crew_id: string, day: string) => void;
  offlineUnpinAll: () => void;
  offlineMove: (tower_id: string, crew_id: string, day: string) => void;
  offlineInsertEmergency: (entry: ScheduleEntry, displaced: string[]) => void;
  // The active ScheduleRun shown across all schedule child components.
  // Populated by Schedule.tsx via setRun() whenever useLiveSchedule() resolves.
  run: ScheduleRun;
  setRun: (run: ScheduleRun) => void;
  viewMode: ScheduleViewMode;
  setViewMode: (mode: ScheduleViewMode) => void;
  /**
   * What the most recently approved dispatch did to the board, for the
   * by-site grid to animate and badge. Display state only — it is derived
   * from two runs the store already holds, so clearing it changes nothing
   * about the plan.
   */
  dispatchAnimation: DispatchAnimation | null;
  setDispatchAnimation: (a: Omit<DispatchAnimation, 'token'>) => void;
  /** Re-runs the same sequence; the grid keys its transition off `token`. */
  replayDispatchAnimation: () => void;
  clearDispatchAnimation: () => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  /**
   * The day the crew timeline is showing. The old grid put all five days on
   * screen at once because a day was one cell wide; an hour-axis timeline
   * cannot do that without becoming unreadable, so the day moves up into an
   * explicit tab strip. select() keeps selectedDay in sync with whatever was
   * just selected, so the board never holds a selection on a day it is not
   * displaying.
   */
  selectedDay: string;
  setSelectedDay: (day: string) => void;
  selection: Selection | null;
  select: (sel: Selection | null) => void;
  territory: string;
  setTerritory: (t: string) => void;
  currentWeekStart: string;
  setCurrentWeekStart: (d: string) => void;
  calendarTeamFilter: string;
  setCalendarTeamFilter: (f: string) => void;
  /**
   * Horizontal scale of the timeline in CSS pixels per hour, or `'fit'` to
   * size an hour so the whole day lands inside the column with no horizontal
   * scroll.
   *
   * Lives in the store rather than in TimelineBoard because the control that
   * changes it sits in the page header, which is not an ancestor of the board.
   */
  hourZoom: number | 'fit';
  setHourZoom: (z: number | 'fit') => void;
  /**
   * Whether the Ranger dock is expanded, and the prompt text a contextual
   * entry point wants it to open with.
   *
   * Ranger stays a GLOBAL surface — it re-solves the whole board, so it is
   * deliberately not mounted inside the per-selection detail panel, which
   * unmounts whenever nothing is selected and whose own actions
   * (preview/pin) are scoped and reversible in a way a re-solve is not.
   * What the panel gets instead is the ability to hand Ranger a starting
   * sentence, which is the part that was actually missing: acting on a
   * selected job used to mean retyping its crew and day from scratch.
   *
   * The seed is a DRAFT, never a sent message. The agent re-solves the
   * board, so the planner must read and agree to the sentence first —
   * `askAgent` fills the composer and stops.
   */
  agentOpen: boolean;
  agentSeed: string | null;
  /** Open the dock with `text` as the composer's draft. */
  askAgent: (text: string) => void;
  setAgentOpen: (open: boolean) => void;
  /** Called once the composer has taken the seed, so it cannot re-apply. */
  clearAgentSeed: () => void;
  calendarStatusFilter: string;
  setCalendarStatusFilter: (f: string) => void;
}

export const useScheduleStore = create<ScheduleStoreState>((set) => ({
  runId: null,
  setRunId: (id) => set({ runId: id }),
  // The real current date, resolved at store creation — not a hardcoded
  // '2026-08-17'. That constant was the flood-demo week, so the schedule
  // opened on a fixed week in the past and silently stayed there: the "Today"
  // button existed but nothing ever pressed it, and the board's dates drifted
  // further from the system clock every day the project ran. The demo week is
  // still one click away (DateNavigator's "Demo Week"), which is the right
  // relationship — a demo is a destination, not the default.
  currentWeekStart: todayIso(),
  setCurrentWeekStart: (currentWeekStart) => set({ currentWeekStart }),
  calendarTeamFilter: 'all',
  setCalendarTeamFilter: (calendarTeamFilter) => set({ calendarTeamFilter }),
  // Opens fitted: a board that arrives already scrolled sideways hides work
  // without saying so. Zooming in is a deliberate act; being scrolled by
  // default is not.
  hourZoom: 'fit',
  setHourZoom: (hourZoom) => set({ hourZoom }),

  agentOpen: false,
  agentSeed: null,
  askAgent: (agentSeed) => set({ agentSeed, agentOpen: true }),
  setAgentOpen: (agentOpen) => set({ agentOpen }),
  clearAgentSeed: () => set({ agentSeed: null }),
  calendarStatusFilter: 'all',
  setCalendarStatusFilter: (calendarStatusFilter) => set({ calendarStatusFilter }),
  offlineRun: null,
  setOfflineRun: (run) => set({ offlineRun: run }),
  offlinePin: (tower_id, crew_id, day) =>
    set((state) =>
      state.offlineRun
        ? {
            offlineRun: {
              ...state.offlineRun,
              entries: state.offlineRun.entries.map((e) =>
                e.tower_id === tower_id ? { ...e, crew_id, day, pinned: true, pin_reason: 'planner_override' } : e,
              ),
            },
          }
        : {},
    ),
  offlineUnpinAll: () =>
    set((state) =>
      state.offlineRun
        ? {
            offlineRun: {
              ...state.offlineRun,
              entries: state.offlineRun.entries.map((e) => ({ ...e, pinned: false, pin_reason: undefined })),
            },
          }
        : {},
    ),
  offlineMove: (tower_id, crew_id, day) =>
    set((state) =>
      state.offlineRun
        ? {
            offlineRun: {
              ...state.offlineRun,
              entries: state.offlineRun.entries.map((e) => (e.tower_id === tower_id ? { ...e, crew_id, day } : e)),
            },
          }
        : {},
    ),
  // Mirrors scheduler/optimize.py's `occupied_reserved` rule: a reserve slot
  // reports a crew-day held FREE, so once something lands on it the slot is
  // gone. Leaving it in place kept RoleGroup's `lane.reserved` branch true,
  // which is checked before `lane.bars`, so the lane went on drawing a
  // ReserveBand over the job just booked and the new bar was never drawn at
  // all. This is the declared demo-safety path, so it failed exactly when
  // the network already had.
  offlineInsertEmergency: (entry, displaced) =>
    set((state) =>
      state.offlineRun
        ? {
            offlineRun: {
              ...state.offlineRun,
              entries: [...state.offlineRun.entries.filter((e) => e.tower_id !== entry.tower_id), entry],
              reserve: state.offlineRun.reserve.filter(
                (r) => !(r.crew_id === entry.crew_id && r.day === entry.day),
              ),
              unscheduled: state.offlineRun.unscheduled.filter((id) => id !== entry.tower_id).concat(displaced),
            },
            selection: null,
          }
        : {},
    ),
  run: EMPTY_RUN,
  // selectedDay follows the horizon the backend actually returned: kept if
  // still present, otherwise reset to the new horizon's first day. A
  // re-optimise can shift the horizon, and a selectedDay that no longer
  // exists in it would render an empty board.
  setRun: (run) =>
    set((state) => ({
      run,
      selectedDay:
        state.selectedDay && run.horizon.includes(state.selectedDay)
          ? state.selectedDay
          : (run.horizon[0] ?? ''),
    })),
  viewMode: 'crew',
  setViewMode: (mode) => set({ viewMode: mode }),
  dispatchAnimation: null,
  setDispatchAnimation: (a) => set({ dispatchAnimation: { ...a, token: 1 } }),
  replayDispatchAnimation: () =>
    set((s) =>
      s.dispatchAnimation
        ? { dispatchAnimation: { ...s.dispatchAnimation, token: s.dispatchAnimation.token + 1 } }
        : {},
    ),
  clearDispatchAnimation: () => set({ dispatchAnimation: null }),
  searchQuery: '',
  setSearchQuery: (query) => set({ searchQuery: query }),
  selectedDay: '',
  setSelectedDay: (day) => set({ selectedDay: day }),
  selection: null,
  select: (selection) =>
    // selectedDay follows the selection, or the board could hold a selection
    // on a day it is not displaying.
    set(selection ? { selection, selectedDay: selection.day } : { selection: null }),
  territory: 'Selangor',
  setTerritory: (territory) => set({ territory }),
}));
