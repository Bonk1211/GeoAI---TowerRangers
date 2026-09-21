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
  LayerTiles,
  LedgerObservation,
  ModelHealth,
  OverridePreview,
  PowerStationResult,
  ScheduleRun,
  Stability,
  Tower,
  WhySlot,
} from './types';
import { SseFrameBuffer, type AgentEvent } from '../lib/agentEvents';

// Same-origin by default: Vite proxies /api to the backend (see
// vite.config.ts). An absolute URL here would reintroduce cross-origin
// requests, and with them preflights, preflight caching and every way those
// can be interfered with — which is what this default exists to avoid. Set
// VITE_API_BASE to an absolute URL only when pointing at a deployed backend.
const API_BASE = import.meta.env.VITE_API_BASE ?? '/api';

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export interface MapPreparation {
  date: string;
  saved_dates?: string[];
  refresh_interval_seconds: number | null;
  retry_at: string | null;
  storage: 'local' | 'supabase';
  storage_error: string | null;
  progress?: { layer_id: string; sensor: string | null; loaded: number; total: number; phase: 'fetching' | 'saving' } | null;
  layers: {
    layer_id: string; sensor: string | null; state: 'ready' | 'preparing' | 'unavailable';
    date?: string | null;
    detail: string | null; cache_stale: boolean; loading: boolean;
    next_refresh_at: string | null; tile_url: string | null;
  }[];
}

export function getMapPreparation(date = 'latest'): Promise<MapPreparation> {
  return request(`/maps/status?${new URLSearchParams({ date })}`);
}

export function reloadMaps(view: { date: string; bounds?: ScoreBounds; zoom?: number }): Promise<MapPreparation> {
  return request(`/maps/reload?${new URLSearchParams({ date: view.date })}`, {
    method: 'POST', body: view.bounds ? JSON.stringify(view) : undefined,
  });
}

async function preparedTiles(path: string): Promise<LayerTiles> {
  const data = await request<LayerTiles>(path);
  return { ...data, tile_url: data.tile_url.startsWith('/') ? apiUrl(data.tile_url) : data.tile_url };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    // FastAPI puts the operator-facing reason in `detail`, and for /flood/tiles
    // that reason IS the feature — "no Sentinel-1 scenes for this window", "set
    // GEE_PROJECT". Discarding it and reporting a bare 503 would leave the UI
    // unable to say anything useful about why a layer is missing.
    const detail = await res
      .clone()
      .json()
      .then((body: { detail?: unknown }) => (typeof body?.detail === 'string' ? body.detail : ''))
      .catch(() => '');
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(
      `${init?.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}${suffix}`,
    );
  }
  return res.json() as Promise<T>;
}

export function getTowers(): Promise<Tower[]> {
  return request<Tower[]>('/towers');
}

export function getPowerStation(towerId: string): Promise<PowerStationResult> {
  return request(`/towers/${encodeURIComponent(towerId)}/power-station`);
}

/**
 * Which flood-exposed towers have a cover candidate and which have none.
 *
 * Derived from the same scored population /towers serves, so the two always
 * describe the same estate. Throws on non-2xx like every other plain route —
 * unlike getFireExposure, this endpoint has no legitimate 503 state, because
 * it reads towers the backend already holds and depends on no external
 * archive or credential.
 */
export function getTowerFallback(): Promise<FallbackReport> {
  return request<FallbackReport>('/towers/fallback');
}

export function getModelHealth(): Promise<ModelHealth> {
  return request<ModelHealth>('/model/health');
}

export function getLedgerObservations(
  labelStatus?: string,
  towerIds?: string[],
): Promise<LedgerObservation[]> {
  const params = new URLSearchParams();
  if (labelStatus) params.set('label_status', labelStatus);
  // Always send the tower list when the caller has one: the estate carries
  // 12,804 unlabeled observations and the unfiltered response is 6 MB.
  if (towerIds && towerIds.length > 0) params.set('tower_ids', towerIds.join(','));
  return request<LedgerObservation[]>(`/model/feedback/observations?${params}`);
}

/**
 * The adjudication queue: one ranked row per tower the imagery contradicts.
 *
 * A separate endpoint from getLedgerObservations, not a filter on it. A
 * contested tower carries one row per sampled window — 848 rows across 53
 * towers — so asking /observations for agreement=disagree would ship 430 KB
 * to render a 53-entry list. The backend collapses to the strongest window
 * per tower and this asks for that directly: 27 KB.
 */
export function getContestedObservations(): Promise<LedgerObservation[]> {
  return request<LedgerObservation[]>('/model/feedback/contested');
}

export type ScoreBounds = [west: number, south: number, east: number, north: number];

export function scoreTowers(
  weights: Record<string, number>,
  bbox?: ScoreBounds,
): Promise<Tower[]> {
  return request<Tower[]>('/score', {
    method: 'POST',
    body: JSON.stringify({ weights, ...(bbox ? { bbox } : {}) }),
  });
}

export function getStability(): Promise<Stability> {
  return request<Stability>('/stability');
}

export function getFloodLayers(): Promise<LayerCatalogue> {
  return request<LayerCatalogue>('/flood/layers');
}

export function getConfluenceStatus(): Promise<ConfluenceStatus> {
  return request<ConfluenceStatus>('/confluence/status');
}

/** The agent's tool set, as the runner hands it to Claude. Offline on the backend. */
export function getIntegrations(): Promise<IntegrationsReport> {
  return request<IntegrationsReport>('/integrations');
}

export function searchConfluencePages(query: string): Promise<ConfluenceSearchResult[]> {
  return request<{ results: ConfluenceSearchResult[] }>(
    `/confluence/search?q=${encodeURIComponent(query)}`,
  ).then((body) => body.results);
}

export function getConfluencePage(pageId: string): Promise<ConfluencePage> {
  return request<ConfluencePage>(`/confluence/pages/${encodeURIComponent(pageId)}`);
}

/**
 * dominant_factor -> its runbook page, via config/confluence_runbooks.yaml.
 * Bypasses `request()`'s throw-on-!ok: a 404 here means "no runbook mapped
 * for this factor yet", an expected, common state (most factors have none),
 * not a failure — conflating it with a network/Confluence-down error would
 * flip the global offline banner for something that isn't offline at all.
 * Returns null for 404 specifically; anything else still throws.
 */
export async function getConfluenceRunbook(factor: string): Promise<ConfluencePage | null> {
  const res = await fetch(`${API_BASE}/confluence/runbook/${encodeURIComponent(factor)}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GET /confluence/runbook/${factor} failed: ${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<ConfluencePage>;
}

/** The vegetation and ground-condition catalogue, from the peer backend package. */
export function getLandLayers(): Promise<LayerCatalogue> {
  return request<LayerCatalogue>('/land/layers');
}

/** The active-fire catalogue, from the third peer backend package. */
export function getFireLayers(): Promise<LayerCatalogue> {
  return request<LayerCatalogue>('/fire/layers');
}

/**
 * The transmission-backbone catalogue, from the fourth peer backend package.
 *
 * Its `earth_engine` is always null, and that is correct rather than missing:
 * ITU serves the backbone from its own GeoServer, so this catalogue never asks
 * Earth Engine anything and has no credential state of its own to report.
 */
export function getBackhaulLayers(): Promise<LayerCatalogue> {
  return request<LayerCatalogue>('/backhaul/layers');
}

/**
 * Mint a tile template for one flood layer.
 *
 * Throws on 503, which is what the backend returns when Earth Engine is not
 * usable — the message carries the operator-facing reason and is meant to be
 * shown, not swallowed.
 */
export function getFloodTiles(layerId: string, date = 'latest', sensor?: string): Promise<LayerTiles> {
  const params = new URLSearchParams({ date });
  if (sensor) params.set('sensor', sensor);
  return preparedTiles(`/flood/tiles/${layerId}?${params}`);
}

/**
 * Mint a tile template for one land layer.
 *
 * No `sensor` parameter: no land layer offers a source choice, and the route
 * does not accept one. Same 503 contract as the flood tiles above.
 */
export function getLandTiles(layerId: string, date = 'latest'): Promise<LayerTiles> {
  const params = new URLSearchParams({ date });
  return preparedTiles(`/land/tiles/${layerId}?${params}`);
}

/**
 * Mint a tile template for one fire layer.
 *
 * No `sensor` parameter, and not by omission: the HUD's sensor selection is a
 * single global control, so a fire source list would fight the flood layer's
 * Sentinel-1/2/Landsat choice over the same widget. The route accepts none.
 * Same 503 contract as the flood and land tiles above.
 */
export function getFireTiles(layerId: string, date = 'latest'): Promise<LayerTiles> {
  const params = new URLSearchParams({ date });
  return preparedTiles(`/fire/tiles/${layerId}?${params}`);
}

/**
 * Mint a tile template for one backbone layer.
 *
 * `date` is sent for symmetry with the three routes above — the shared tile
 * hook passes one for every group — and the backend ignores it, because the
 * layer is undated. No `sensor`: the route accepts none. Same 503 contract,
 * and it matters here for a reason specific to this source: the sibling
 * `range_*` layers in the same ITU workspace answer a permission error with
 * HTTP 200 and an XML body, so `tile_access` is the only thing standing
 * between that and a blank overlay reported as success.
 */
export function getBackhaulTiles(layerId: string, date = 'latest'): Promise<LayerTiles> {
  const params = new URLSearchParams({ date });
  return preparedTiles(`/backhaul/tiles/${layerId}?${params}`);
}

/**
 * Which towers a fire screening pass found detections near, for one date.
 *
 * Throws rather than resolving empty when Earth Engine is unusable: the backend
 * answers 503 there instead of a body, so a resolved response always means the
 * question was actually asked and an empty `towers` map is the quiet answer
 * rather than a failed one. Callers must keep those two apart — see
 * useFireExposureQuery, which falls back to null and never to a struct.
 */
export function getFireExposure(date: string): Promise<FireExposure> {
  const params = new URLSearchParams({ date });
  return request<FireExposure>(`/fire/exposure?${params}`);
}

export function getCrews(): Promise<Crew[]> {
  return request<Crew[]>('/crews');
}

export interface TravelLegsOut {
  source: 'matrix' | 'haversine';
  destination: string;
  legs: { origin: string; km: number | null; minutes: number | null; reachable: boolean; via_ferry: boolean }[];
}

/**
 * Measured road legs from a set of positions to one tower.
 *
 * A pair the matrix does not hold is simply ABSENT from `legs` — never
 * returned as a zero or an estimate. The caller distinguishes the three
 * states (measured / no road / unknown) and only the last one falls back.
 */
export function getTravelLegs(origins: string[], destination: string): Promise<TravelLegsOut> {
  return request<TravelLegsOut>('/travel/legs', {
    method: 'POST',
    body: JSON.stringify({ origins, destination }),
  });
}

export interface OptimizeRequestBody {
  tower_ids?: string[] | null;
  today?: string | null;
}

export function optimizeSchedule(body: OptimizeRequestBody = {}): Promise<{ run_id: string }> {
  return request<{ run_id: string }>('/schedule/optimize', { method: 'POST', body: JSON.stringify(body) });
}

export function getScheduleRun(runId: string): Promise<ScheduleRun> {
  return request<ScheduleRun>(`/schedule/${runId}`);
}

export function getWhySlot(entryId: string): Promise<WhySlot> {
  return request<WhySlot>(`/schedule/why/${entryId}`);
}

export function getScheduleBaseline(): Promise<BaselineComparison> {
  return request<BaselineComparison>('/schedule/baseline');
}

export interface PreviewRequestBody {
  run_id: string;
  tower_id: string;
  target_crew_id: string;
  target_day: string;
  pinned_by?: string | null;
  /**
   * Present only when the planner is raising a reviewed fire-exposure
   * inspection, carrying the snapshot they actually reviewed. The backend
   * compares it against the current one and refuses with 409 when the source
   * has moved underneath the review — which is the whole reason the id is
   * derived from the source window rather than minted per request.
   *
   * PinRequestBody extends this interface, so preview and pin are checked
   * against the same body and a preview cannot pass validation the pin fails.
   */
  fire_inspection?: { snapshot_id: string; safe_access_confirmed: boolean } | null;
}

export function previewOverride(body: PreviewRequestBody): Promise<OverridePreview> {
  return request<OverridePreview>('/schedule/preview', { method: 'POST', body: JSON.stringify(body) });
}

export interface PinRequestBody extends PreviewRequestBody {
  pin_reason?: 'planner_override' | 'emergency';
}

export function pinOverride(body: PinRequestBody): Promise<ScheduleRun> {
  return request<ScheduleRun>('/schedule/pin', { method: 'POST', body: JSON.stringify(body) });
}

export interface EmergencyRequestBody {
  run_id: string;
  tower_id: string;
  crew_id: string;
  pinned_by?: string | null;
  commit?: boolean;
}

/**
 * Force-insert today. `commit: false` (the default) returns an
 * `OverridePreview` with displacement; `commit: true` commits and returns
 * the new `ScheduleRun`. The Disaster Simulation's `generator-dispatch` beat
 * always calls this with `commit: true` — it wants the real board update,
 * not a preview to review — per `docs/Disaster_Simulation_Spec.md` §7.
 */
export function emergencyDispatch(body: EmergencyRequestBody): Promise<OverridePreview | ScheduleRun> {
  return request<OverridePreview | ScheduleRun>('/schedule/emergency', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/**
 * Stream `POST /agent/chat`'s SSE response as `AgentEvent`s.
 *
 * Deliberately not `EventSource`: EventSource can only issue GET requests,
 * and this endpoint requires a POST body (`{ message }`), so the stream is
 * read by hand via `fetch` + `res.body.getReader()`.
 */
export async function* streamAgentChat(
  message: string,
  signal: AbortSignal,
): AsyncGenerator<AgentEvent> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/agent/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal,
    });
  } catch (err) {
    // An abort during the fetch itself is normal operation, not a failure —
    // let the generator end quietly rather than surface an AbortError.
    if (signal.aborted) return;
    throw err;
  }

  if (!res.ok) {
    const detail = await res
      .clone()
      .json()
      .then((body: { detail?: unknown }) => (typeof body?.detail === 'string' ? body.detail : ''))
      .catch(() => '');
    const suffix = detail ? ` — ${detail}` : '';
    throw new Error(`POST /agent/chat failed: ${res.status} ${res.statusText}${suffix}`);
  }

  if (!res.body) {
    throw new Error('POST /agent/chat failed: response had no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buffer = new SseFrameBuffer();

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (err) {
        // The consumer aborting mid-stream is normal operation, not an error
        // — end the generator cleanly instead of throwing.
        if (signal.aborted) return;
        throw err;
      }
      if (result.done) break;

      const chunk = decoder.decode(result.value, { stream: true });
      for (const event of buffer.push(chunk)) {
        yield event;
        if (event.event === 'done') return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
