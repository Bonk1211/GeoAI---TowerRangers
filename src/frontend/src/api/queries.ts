import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BaselineComparison,
  ConfluencePage,
  ConfluenceSearchResult,
  ConfluenceStatus,
  Crew,
  FallbackReport,
  FireExposure,
  IntegrationsReport,
  LayerCatalogue,
  LayerGroup,
  LayerTemporalKind,
  LayerTiles,
  LedgerObservation,
  ScheduleRun,
  Stability,
  Tower,
  ModelHealth,
} from './types';
import * as client from './client';
import { useOffline } from '../state/useOffline';
import { useFloodLayers } from '../state/useFloodLayers';
import { TOWERS } from '../fixtures/towers';
import { CREWS } from '../fixtures/crews';
import { FLOOD_CATALOGUE } from '../fixtures/floodLayers';
import { LAND_CATALOGUE } from '../fixtures/landLayers';
import { FIRE_CATALOGUE } from '../fixtures/fireLayers';
import { BACKHAUL_CATALOGUE } from '../fixtures/backhaulLayers';

// Step 7 offline fallback: on network failure fall back to fixture data and
// flip the global offline flag so the banner shows. Never fall back silently
// — a demo narrated as live while quietly showing fixture data is worse than
// a visible failure.
async function withOfflineFallback<T>(live: () => Promise<T>, fallback: T): Promise<T> {
  try {
    const result = await live();
    useOffline.getState().setOffline(false);
    return result;
  } catch {
    useOffline.getState().setOffline(true);
    return fallback;
  }
}

// How often to re-attempt while degraded.
//
// This exists because `withOfflineFallback` RESOLVES with fixture data instead
// of rejecting. TanStack therefore records a SUCCESS, `retry` never fires, and
// with `staleTime: Infinity` the query never re-runs — so one failed load
// latches the entire tab into offline mode until somebody reloads it by hand.
// Observed: a backend that came up two seconds after the page did stayed
// "unreachable" for the life of the tab, showing 132 Sunway fixture towers in
// place of 1,164 real ones. Plausible enough to be read as real data, which is
// the failure this fallback was written to avoid in the first place.
//
// Infinity remains the steady state — these payloads genuinely do not change
// within a session, and polling a healthy backend for them would be waste. The
// finite window applies ONLY while the offline flag is set, and stops the
// moment a fetch succeeds, because withOfflineFallback clears the flag itself.
const OFFLINE_RETRY_MS = 15_000;

function useRecovery() {
  const offline = useOffline((state) => state.offline);
  return offline
    ? {
        staleTime: 0,
        refetchInterval: OFFLINE_RETRY_MS,
        // Foreground only. A background tab quietly retrying forever is a
        // battery cost with nobody to show the recovery to.
        refetchIntervalInBackground: false,
      }
    : { staleTime: Infinity, refetchInterval: false as const };
}

export function useTowersQuery() {
  const recovery = useRecovery();
  return useQuery<Tower[]>({
    queryKey: ['towers'],
    queryFn: () => withOfflineFallback(client.getTowers, TOWERS),
    ...recovery,
  });
}

export function usePowerStationQuery(towerId: string | null) {
  return useQuery({
    queryKey: ['power-station', towerId],
    queryFn: () => client.getPowerStation(towerId as string),
    enabled: Boolean(towerId),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

// The catalogue is static metadata, so a fixture mirror is a legitimate
// fallback — same standing as TOWERS and CREWS. What it must NOT carry is a
// fabricated Earth Engine status: FLOOD_CATALOGUE sets `earth_engine: null`,
// meaning "we could not ask", which the panel renders differently from a real
// `configured: false`.
export function useFloodLayersQuery() {
  return useQuery<LayerCatalogue>({
    queryKey: ['flood-layers'],
    queryFn: () => withOfflineFallback(client.getFloodLayers, FLOOD_CATALOGUE),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
  });
}

/**
 * The vegetation and ground-condition catalogue.
 *
 * A separate query rather than a merged one, matching the backend split: either
 * catalogue can fail, refresh or fall back to fixtures without the other, and a
 * panel that renders one group must not go blank because the other's route is
 * down. LAND_CATALOGUE carries `earth_engine: null` for the same reason
 * FLOOD_CATALOGUE does.
 */
export function useLandLayersQuery() {
  return useQuery<LayerCatalogue>({
    queryKey: ['land-layers'],
    queryFn: () => withOfflineFallback(client.getLandLayers, LAND_CATALOGUE),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
  });
}

/**
 * The active-fire catalogue, from the third peer backend package.
 *
 * Fixture-backed on the same standing as the other two catalogues and for the
 * same reason: a catalogue is authored static metadata, so FIRE_CATALOGUE is a
 * mirror rather than an invention, and it carries `earth_engine: null` — "we
 * could not ask" — never a fabricated `configured: false`.
 *
 * The exposure query below is the one that must NOT work this way: a screening
 * result is a measurement, and there is no fixture for it.
 */
export function useFireLayersQuery() {
  return useQuery<LayerCatalogue>({
    queryKey: ['fire-layers'],
    queryFn: () => withOfflineFallback(client.getFireLayers, FIRE_CATALOGUE),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
  });
}

/**
 * The transmission-backbone catalogue, from the fourth peer backend package.
 *
 * Fixture-backed on the same standing as the other three: a catalogue is
 * authored static metadata, so BACKHAUL_CATALOGUE is a mirror rather than an
 * invention. Its `earth_engine` is null both offline and online — this is the
 * one catalogue that never reaches Earth Engine, so null is the live answer too.
 */
export function useBackhaulLayersQuery() {
  return useQuery<LayerCatalogue>({
    queryKey: ['backhaul-layers'],
    queryFn: () => withOfflineFallback(client.getBackhaulLayers, BACKHAUL_CATALOGUE),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchIntervalInBackground: true,
  });
}

export function useMapPreparationQuery(date: string) {
  const followLatest = useFloodLayers((s) => s.followLatest);
  const requestDate = followLatest ? 'latest' : date;
  return useQuery({
    queryKey: ['map-preparation', requestDate],
    queryFn: () => client.getMapPreparation(requestDate),
    enabled: requestDate === 'latest' || /^\d{4}-\d{2}-\d{2}$/.test(requestDate),
    staleTime: 5000,
    refetchInterval: 5000,
    retry: false,
  });
}

export function useReloadMaps() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (date: string) => client.reloadMaps({ date }),
    onSuccess: (data, requestedDate) => {
      queryClient.setQueryData(['map-preparation', requestedDate], data);
      void queryClient.invalidateQueries({
        predicate: (query) => ['flood-tiles', 'land-tiles', 'fire-tiles'].includes(String(query.queryKey[0])),
      });
    },
  });
}

// Which route serves a group's tiles, and under which cache key.
//
// Exhaustive Record maps rather than the two `group === 'land' ? … : …`
// ternaries they replaced. Those ternaries type-checked cleanly against a
// widened LayerGroup and routed every new member to the `else` branch, so the
// fire layer was cached under 'flood-tiles' and requested from
// /flood/tiles/{layer_id} — a flood-worded 404 about a layer the flood
// catalogue has never heard of, at runtime, instead of a build failure. A
// fourth group is now a compile error in this file.
const TILE_KEY: Record<LayerGroup, string> = {
  water: 'flood-tiles',
  land: 'land-tiles',
  fire: 'fire-tiles',
  backhaul: 'backhaul-tiles',
};

// Only the flood route takes a sensor: the land, fire and backhaul layers offer
// no source choice and their routes reject the parameter, so those three arms
// drop it rather than forwarding a value the backend would 422 on.
const TILE_FN: Record<LayerGroup, (id: string, date: string, sensor?: string) => Promise<LayerTiles>> = {
  water: (id, date, sensor) => client.getFloodTiles(id, date, sensor),
  land: (id, date) => client.getLandTiles(id, date),
  fire: (id, date) => client.getFireTiles(id, date),
  backhaul: (id, date) => client.getBackhaulTiles(id, date),
};

/**
 * A minted tile template for one Earth Engine layer.
 *
 * Deliberately NOT wrapped in withOfflineFallback. There is no honest fixture
 * for a tile URL — inventing one would point the map at a host that serves
 * nothing, which is precisely the blank-layer failure the backend's
 * `tile_access` probe exists to prevent. The error is surfaced instead, and the
 * panel shows why.
 *
 * Prepared imagery changes only after manual reload. Status changes the query key
 * as each replacement finishes, so selected layers update without a page reload.
 */
export function useLayerTilesQuery(
  group: LayerGroup,
  layerId: string | null,
  date: string,
  enabled: boolean,
  temporalKind: LayerTemporalKind = 'observation',
  sensor?: string,
) {
  const followLatest = useFloodLayers((s) => s.followLatest);
  const requestDate = temporalKind === 'forecast' || followLatest ? 'latest' : date;
  const { data: preparation } = useMapPreparationQuery(date);
  const prepared = preparation?.layers.find((layer) => layer.layer_id === layerId && layer.sensor === (sensor ?? null));
  return useQuery<LayerTiles>({
    // The group is part of the key, not decoration. Layer ids cannot collide
    // across the three catalogues (a backend test asserts it), but a shared key
    // prefix would let one route's 503 invalidate another's entry on refetch.
    queryKey: [TILE_KEY[group], layerId, requestDate, sensor ?? null, prepared?.tile_url],
    queryFn: () => TILE_FN[group](layerId as string, requestDate, sensor),
    select: (data) => ({ ...data, cache_stale: prepared?.cache_stale ?? data.cache_stale,
      cache_detail: prepared?.detail ?? data.cache_detail }),
    enabled: enabled && layerId !== null,
    staleTime: Infinity,
    refetchInterval: false,
    retry: false,
  });
}

/**
 * Which towers a fire screening pass found detections near, for one date.
 *
 * Null, never an empty FireExposure — the useStabilityQuery rule, pointed at
 * the one question in this app where the wrong answer is an all-clear. A
 * resolved body whose `towers` map is empty means "we asked Earth Engine and
 * the window is quiet"; `null` means "we could not ask". A zeroed struct is
 * truthy, so consumers' `data ? … : …` guards would take the resolved branch
 * and render "No fire detections within 5 km" beside a tower nobody screened
 * — the `rho 0.00 in calm grey` failure, inventing a safety claim out of a
 * failed fetch. There is no fixture for observed hotspots, and there must not
 * be one: the honest offline answer is the absence of a screening.
 *
 * `refetchIntervalInBackground` is omitted rather than set false, since false
 * is the default — hotspot evidence is polled for a planner who is looking at
 * it, and a hidden tab re-asking Earth Engine every five minutes buys nobody
 * anything.
 */
export function useFireExposureQuery(date: string) {
  const followLatest = useFloodLayers((s) => s.followLatest);
  const { data: preparation } = useMapPreparationQuery(date);
  const requestDate = followLatest
    ? preparation?.layers.find((layer) => layer.layer_id === 'active_fire')?.date ?? date
    : date;
  return useQuery<FireExposure | null>({
    queryKey: ['fire-exposure', requestDate],
    // Resolves null on failure like withOfflineFallback does, but WITHOUT
    // touching the global offline flag — and that difference is the whole
    // reason this is written out by hand rather than reusing the helper.
    //
    // Every other wrapped query answers non-2xx only when the backend is
    // genuinely unreachable, so flipping the flag there is honest. This one
    // answers non-2xx during completely normal operation: 503 on any date the
    // VIIRS archive has no granule for, 503 with no Earth Engine credentials
    // (a documented supported state — "every other route works without them"),
    // and 400 if the shared date input is cleared. Routing that through the
    // shared helper made a fire-screening gap render "Showing sample data — the
    // API is unreachable" across the whole console, flip StatusChips to
    // OFFLINE, drop every other query to 15 s recovery polling and start
    // resurrecting fixture towers — all while /towers, /crews, /schedule and
    // /flood/* were serving real data. A feature's own absence must not be
    // rendered as a claim about every other surface's provenance.
    queryFn: () => client.getFireExposure(requestDate).catch(() => null),
    staleTime: 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useCrewsQuery() {
  const recovery = useRecovery();
  return useQuery<Crew[]>({
    queryKey: ['crews'],
    queryFn: () => withOfflineFallback(client.getCrews, CREWS),
    ...recovery,
  });
}

// Null, not a zeroed Stability. A zeroed object is truthy, so every consumer's
// `data ? … : '—'` and `data ?? BASELINE` guard silently took the wrong branch
// and rendered rho_mean 0.00 as though it were a measurement — and rho = 0
// happens to mean "the ranking is pure noise", the single most alarming
// reading the model can produce, shown in calm grey while offline. Unlike
// TOWERS and CREWS, there is no fixture stability run to fall back to, so the
// honest fallback is the absence of a value.
/**
 * Measured legs from each candidate crew's CURRENT position to one tower.
 *
 * Enabled only once there is a tower and at least one position to ask about,
 * so opening the panel on an unresolvable ticket fires no request.
 *
 * No offline fallback, deliberately, and it is the same rule
 * useStabilityQuery follows: there is no fixture road matrix, so the honest
 * offline answer is ABSENCE. rankSuggestions() then estimates per crew and
 * the panel labels it "(est.)" — which is exactly what it did before this
 * endpoint existed. A zeroed or fabricated leg would be indistinguishable
 * from a measured one on screen.
 */
export function useTravelLegsQuery(origins: string[], destination: string | null) {
  return useQuery({
    // Origins are sorted into the key so two renders that ask about the same
    // set in a different order share one cache entry.
    queryKey: ['travel-legs', destination, [...origins].sort()],
    queryFn: () => client.getTravelLegs(origins, destination as string),
    enabled: Boolean(destination) && origins.length > 0,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useStabilityQuery() {
  const recovery = useRecovery();
  return useQuery<Stability | null>({
    queryKey: ['stability'],
    queryFn: () => withOfflineFallback<Stability | null>(client.getStability, null),
    ...recovery,
  });
}

// Null, not a fabricated report — the same rule useStabilityQuery follows and
// for a sharper reason. Every number on the health page is a measurement of the
// served model; inventing offline stand-ins would render a confusion matrix
// nobody computed, on a page whose entire job is telling you whether to trust
// the model. There is no fixture, so absence is the honest fallback and the
// page says so.
export function useModelHealthQuery() {
  return useQuery<ModelHealth | null>({
    queryKey: ['model-health'],
    queryFn: () => withOfflineFallback<ModelHealth | null>(client.getModelHealth, null),
    staleTime: 60 * 1000,
  });
}

// Unlabeled rows only: a confirmed observation is already spent, and offering
// it would invite a second confirmation that _confirmed() would dedupe away
// anyway. Empty array is the honest offline fallback here — unlike the health
// report, "no observations" is a real and common state, not a missing
// measurement, so an empty list claims nothing that is not true.
/**
 * Towers the imagery contradicts, awaiting a human.
 *
 * Unconditional — unlike useLedgerObservationsQuery, which needs a tower list
 * to stay small, this response is already one row per tower (27 KB on the
 * current estate) and the queue is the page's starting point rather than a
 * join onto something else.
 */
export function useContestedObservationsQuery() {
  return useQuery<LedgerObservation[]>({
    queryKey: ['ledger-observations', 'contested'],
    queryFn: () => withOfflineFallback<LedgerObservation[]>(
      () => client.getContestedObservations(),
      [],
    ),
    staleTime: 60 * 1000,
  });
}

export function useLedgerObservationsQuery(towerIds: string[]) {
  // Sorted so the cache key is stable under a reordered input, and joined
  // because an array key would re-fetch on every render that rebuilds it.
  const key = [...towerIds].sort().join(',');
  return useQuery<LedgerObservation[]>({
    queryKey: ['ledger-observations', 'unlabeled', key],
    // Nothing to ask about. Skipping the request entirely also avoids the
    // unfiltered 6 MB response an empty tower list would otherwise fetch.
    enabled: towerIds.length > 0,
    queryFn: () => withOfflineFallback<LedgerObservation[]>(
      () => client.getLedgerObservations('unlabeled', towerIds),
      [],
    ),
    staleTime: 60 * 1000,
  });
}

// Same rule as useModelHealthQuery: a Confluence page is real content from an
// external account, so there is no honest offline stand-in. Null means "could
// not ask" (network down) or "not configured" (no CONFLUENCE_* env vars) —
// the caller reads /confluence/status to tell those apart.
export function useConfluenceStatusQuery() {
  return useQuery<ConfluenceStatus | null>({
    queryKey: ['confluence-status'],
    queryFn: () => withOfflineFallback<ConfluenceStatus | null>(client.getConfluenceStatus, null),
    staleTime: 60 * 1000,
  });
}

export function useConfluenceSearchQuery(query: string) {
  return useQuery<ConfluenceSearchResult[] | null>({
    queryKey: ['confluence-search', query],
    queryFn: () =>
      withOfflineFallback<ConfluenceSearchResult[] | null>(
        () => client.searchConfluencePages(query),
        null,
      ),
    enabled: query.trim().length > 0,
    staleTime: 30 * 1000,
  });
}

// Not routed through withOfflineFallback: client.getConfluenceRunbook already
// resolves a 404 (no runbook mapped for this factor) to null without
// throwing, so only a real network/Confluence failure reaches the catch here
// — that is the only case that should flip the offline banner. Conflating
// "no runbook for this factor" with "offline" would make the banner fire on
// nearly every tower, since most factors have no runbook yet.
export function useConfluenceRunbookQuery(factor: string | null) {
  return useQuery<ConfluencePage | null>({
    queryKey: ['confluence-runbook', factor],
    queryFn: async () => {
      try {
        const result = await client.getConfluenceRunbook(factor as string);
        useOffline.getState().setOffline(false);
        return result;
      } catch {
        useOffline.getState().setOffline(true);
        return null;
      }
    },
    enabled: Boolean(factor),
    staleTime: 60 * 1000,
  });
}

export function useConfluencePageQuery(pageId: string | null) {
  return useQuery<ConfluencePage | null>({
    queryKey: ['confluence-page', pageId],
    queryFn: () =>
      withOfflineFallback<ConfluencePage | null>(() => client.getConfluencePage(pageId as string), null),
    enabled: Boolean(pageId),
    staleTime: 60 * 1000,
  });
}

// Weights re-score: keyed on the weight vector so each distinct slider
// position is cached and debounced calls dedupe automatically. Returns null
// on network failure (and flips the offline flag) — the caller then falls
// back to the client-side lib/scorer.ts noisy-OR, offline path only.
export function useScoreQuery(weights: Record<string, number> | null) {
  return useQuery<Tower[] | null>({
    queryKey: ['score', weights],
    queryFn: () => withOfflineFallback(() => client.scoreTowers(weights as Record<string, number>), null),
    enabled: weights !== null,
    staleTime: Infinity,
  });
}

// --- Schedule: optimize is a mutation, never a query --------------------
// Left as a query, refetch-on-focus would silently re-solve the schedule
// under the planner mid-demo (Implementation_Plan step 6b / trap list).

export function useOptimizeSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params?: string[] | { towerIds?: string[]; today?: string }) => {
      if (Array.isArray(params)) {
        return client.optimizeSchedule({ tower_ids: params });
      }
      return client.optimizeSchedule({
        tower_ids: params?.towerIds ?? null,
        today: params?.today ?? null,
      });
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['scheduleRunId'], data.run_id);
    },
  });
}

// Composite id the backend uses for GET /schedule/why/{entry_id} — not part
// of the frozen ScheduleEntry shape, constructed the same way here as
// scheduler/optimize.py's ScheduleEntry.entry_id property.
export function scheduleEntryId(entry: { crew_id: string; day: string; tower_id: string }): string {
  return `${entry.crew_id}__${entry.day}__${entry.tower_id}`;
}

// Null, not a zeroed BaselineComparison, on loading and on failure — the same
// rule as useStabilityQuery. A 0% risk-weighted-wait reduction is a real,
// alarming measurement ("the optimizer did no better than naive dispatch");
// rendering it in place of "we don't know yet" is the rho_mean: 0 failure
// again. There is no fixture baseline run to fall back to offline, so the
// honest fallback is the absence of a value, same as Stability.
export function useBaselineQuery() {
  return useQuery<BaselineComparison | null>({
    queryKey: ['schedule-baseline'],
    queryFn: () => withOfflineFallback<BaselineComparison | null>(client.getScheduleBaseline, null),
    staleTime: Infinity,
  });
}

export function useWhySlotQuery(entryId: string | null) {
  return useQuery({
    queryKey: ['whySlot', entryId],
    queryFn: () => client.getWhySlot(entryId as string),
    enabled: entryId !== null,
    staleTime: Infinity,
  });
}

export function useScheduleRunQuery(runId: string | null) {
  return useQuery<ScheduleRun>({
    queryKey: ['scheduleRun', runId],
    queryFn: () => client.getScheduleRun(runId as string),
    enabled: runId !== null,
    staleTime: Infinity,
  });
}

export function usePreviewOverride() {
  return useMutation({
    mutationFn: (body: client.PreviewRequestBody) => client.previewOverride(body),
  });
}

export function usePinOverride(runId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Omit<client.PinRequestBody, 'run_id'>) =>
      client.pinOverride({ ...body, run_id: runId as string }),
    onSuccess: (run) => {
      queryClient.setQueryData(['scheduleRun', runId], run);
    },
  });
}

// No fixture: the tool list is read from the running code so it cannot drift,
// and a hand-copied offline stand-in would reintroduce exactly that drift.
// Null renders as "backend unreachable"; the Roadmap tab needs no data.
export function useIntegrationsQuery() {
  return useQuery<IntegrationsReport | null>({
    queryKey: ['integrations'],
    queryFn: () => withOfflineFallback<IntegrationsReport | null>(client.getIntegrations, null),
    staleTime: 60 * 1000,
  });
}

/**
 * The cover-candidate report, or null when the backend could not be reached.
 *
 * Uses `withOfflineFallback`, UNLIKE `useFireExposureQuery`. That query opts
 * out because it answers non-2xx during completely normal operation — 503 on
 * any date VIIRS has no granule for, 503 with no Earth Engine credentials — so
 * routing it through the shared helper once flipped the entire console to
 * OFFLINE while every other route served live data.
 *
 * This endpoint has no such state. It reads towers the backend already holds,
 * depends on no external archive and no credentials, and is computed once per
 * process. A non-2xx here means the backend genuinely is unreachable, so
 * setting the offline flag is the honest reading.
 *
 * The fallback value is `null`, never an empty report. An empty report would
 * render "no towers lack cover" — a claim. Null means "we could not ask", and
 * every consumer renders nothing for it.
 *
 * `useRecovery()` supplies staleTime itself (Infinity while healthy, a finite
 * retry window while offline), exactly as useTowersQuery spreads it.
 */
export function useTowerFallbackQuery() {
  const recovery = useRecovery();
  return useQuery<FallbackReport | null>({
    queryKey: ['tower-fallback'],
    queryFn: () => withOfflineFallback<FallbackReport | null>(client.getTowerFallback, null),
    ...recovery,
  });
}
