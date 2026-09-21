export type Decision = 'maintain' | 'watch' | 'ok';
export type LayerTemporalKind = 'scenario' | 'observation' | 'forecast';
export type LayerBounds = [west: number, south: number, east: number, north: number];
/**
 * Which catalogue served a layer, and which HUD panel lists it.
 *
 * Widening this union is deliberately a compile error at `useLayerTilesQuery`,
 * whose TILE_KEY/TILE_FN are exhaustive `Record<LayerGroup, …>` maps rather
 * than the two `group === 'land' ? … : …` ternaries they replaced. Those
 * ternaries type-checked cleanly against a third member and routed it to the
 * `else` branch, so a fire layer was cached under 'flood-tiles' and requested
 * from /flood/tiles/{layer_id} — surfacing as a flood-worded 404 rather than
 * as a build failure.
 */
export type LayerGroup = 'water' | 'land' | 'fire' | 'backhaul';

export interface LayerSensorOption {
  id: string;
  label: string;
}

/**
 * Live forecast reading behind a deadline that moved.
 *
 * Mirrors WeatherHazard.to_dict in src/backend/flood/forecast.py. Present only
 * on live records; `Tower.weather` is null whenever no forecast was applied.
 */
export interface WeatherHazard {
  /** <= 1.0 always. Shortens the weather-coupled share of urgency_days, never lengthens it. */
  multiplier: number;
  rain_mm_24h: number;
  /** Null when SMAP had no usable granule; rain alone still drives the multiplier. */
  soil_moisture: number | null;
  /** Which thresholds fired: 'severe_rain' | 'watch_rain' | 'saturated_ground'. */
  drivers: string[];
  /** GFS run this came from. */
  issued_at: string;
  /** SMAP granule actually read — routinely ~3 days old, so show it, don't imply currency. */
  observed_at: string | null;
}

/**
 * One contextual red flag raised by the rule profiler (model/profiler.py).
 *
 * Rules the supervised model has no column for: whether a crew can reach the
 * site, whether it was scored on a complete feature row, whether a live
 * forecast couples to its dominant factor.
 *
 * Descriptive. Nothing consumes these — they do not enter `risk` and they do
 * not enter `decision`; only `Tower.condition` moves a band. Each flag carried
 * a numeric `weight` while the flags themselves fed an escalation score; that
 * gate was removed on measurement and the weight went with it rather than
 * lingering as a field nothing reads.
 */
export interface TowerFlag {
  /**
   * Stable key from config/profiler.yaml. Group and switch on this, never on
   * `label` — a label is copy and will be reworded.
   */
  id: string;
  label: string;
  /** The sentence to show. Comes from config so every surface says the same thing. */
  detail: string;
}

export interface Tower {
  tower_id: string;
  lon: number;
  lat: number;
  /**
   * 'UNKNOWN' is a real value, not a gap. The national table is built from
   * OpenStreetMap, where 96% of masts carry no generation tag at all, and the
   * backend writes the literal string rather than a null so "we do not know"
   * stays visible instead of hiding inside EQUIP's 0.5 fallback.
   */
  radio: 'GSM' | 'UMTS' | 'LTE' | 'NR' | 'UNKNOWN';
  risk: number;
  risk_lo: number;
  risk_hi: number;
  decision: Decision;
  borderline: boolean;
  dominant_factor: string;
  urgency_days: number;
  attribution: Record<string, number>; // factor -> share, sums to 1
  /**
   * Null means no forecast was applied — the feature is off, or Earth Engine
   * was unreachable. That is a different statement from a forecast that came
   * back quiet, which carries multiplier 1.0 and an empty drivers list. Typed
   * `| null` rather than optional so the compiler forces the distinction.
   */
  weather: WeatherHazard | null;
  /**
   * ADM1 state, and the key the scheduler matches crews on — so the spelling
   * here is crews.json's ('Melaka'), not geoBoundaries' ('Malacca'). The
   * handful of towers whose coordinates fall outside every state outer ring
   * carry 'unassigned'.
   */
  territory: string;
  /**
   * How environmentally unusual this site is, as a percentile rank in [0, 1]
   * over the towers in this response — 0.97 reads as "stranger than 97% of
   * them". Produced by an isolation forest over the same site-environment
   * columns the model reads (model/novelty.py).
   *
   * NOT a risk score and NOT a probability. It is a statement about the
   * TRAINING DISTRIBUTION, not about the tower's condition: a site can be the
   * strangest in Malaysia and need no work. It is deliberately not blended
   * into `risk` — measured, every blend weight makes the model worse — and it
   * does not move `decision` either: gating on it scored WORSE than simply
   * dispatching the same number of towers further down the model's own
   * ranking (F1 0.5751 against 0.5855 at 140 dispatches). `condition` gates
   * instead — same idea, one-sided estimator, and it measures better.
   *
   * Null when it could not be measured: a feature column is missing for this
   * tower, or scikit-learn is not installed on the backend. Null rather than 0,
   * because 0 means "measured, perfectly typical" — the opposite claim, and the
   * same zeroed-struct trap `useStabilityQuery` already fell into. Typed
   * `| null` rather than optional so the compiler forces the branch.
   *
   * Absent from POST /score responses: that endpoint serves the physical index,
   * which has neither the model's design matrix nor its band cut.
   */
  novelty: number | null;
  /**
   * Current-condition rank in [0, 1] from the site's 30-day telemetry block —
   * rectifier alarms, battery sag events, door-open hours (`model/novelty.py`
   * `condition_scores`). 0.9 reads as "noisier than 90% of sites right now".
   *
   * This is the one second-opinion signal that moves the ordering. It is
   * unsupervised — it reads no label — but ONE SIDED, unlike `novelty`, and
   * that distinction is the whole reason it works: an isolation forest scores
   * |deviation|, and a site with unusually FEW alarms is not a site at risk.
   *
   * The supervised model cannot use these counters: they cover 30 days while
   * its label covers 36 months, so no aligned training pair exists. That gap is
   * why an unsupervised layer earns a place here at all.
   *
   * Null when no telemetry exists for this tower. Null, not 0 — 0 would claim
   * "measured, perfectly quiet".
   */
  condition: number | null;
  /** Satellite growth percentile; null when no bi-temporal measurement exists.
   * Absent on /score and offline fixtures, which have no satellite ensemble. */
  change?: number | null;
  /** Contextual red flags, empty when none fired. See TowerFlag. */
  flags: TowerFlag[];
  /**
   * The ordering `decision` is actually cut on: `risk` rank blended with
   * `condition` rank at a fixed weight (`model/ensemble.py`). A percentile in
   * [0, 1], never a probability — `risk` stays the calibrated number.
   *
   * It is a blend rather than a threshold gate because a gate reorders nothing:
   * measured on held-out seeds at a matched dispatch budget, gating scored
   * -0.0125 F1 against LightGBM alone while the blend scores +0.0191, ahead in
   * 5 of 5 seeds.
   */
  priority: number;
  /**
   * True when the blend put this tower in a HIGHER band than its risk alone
   * would have. `decision` already reflects it; this says the second opinion is
   * why, and it is the only reason `risk` can sit below the maintain cut on a
   * maintain-band tower.
   */
  escalated: boolean;
  hand_m?: number;
  dist_water_m?: number;
  slope_deg?: number;
  tri?: number;
  flash_density?: number;
  dist_power_m?: number;
  /**
   * MODELLED SITE PROTECTION — never served by the backend, never sent to it.
   *
   * Present only on records the frontend has overlaid a demo mitigation onto
   * (`lib/protection.ts`). When it is set, this tower's `risk`, `decision`,
   * `attribution` and `dominant_factor` describe a HYPOTHETICAL site — one
   * where a plinth, a genset or a regrade has been modelled — and not the
   * tower as scored by the API.
   *
   * Optional rather than `| null` precisely because it must never be
   * constructed by an API mapper: a record carrying this field is one the
   * frontend built, and any code path that could attach it to a served
   * response is a bug. `riskBefore` is the served risk the record arrived
   * with, so the pair is on one scale and comparable with the unprotected
   * towers around it.
   */
  protection?: import('../lib/protection').AppliedProtection;
}

/**
 * One entry in a layer catalogue.
 *
 * Served by both GET /flood/layers and GET /land/layers — the two domains are
 * peers over one tile engine, so the record they publish is the same and only
 * `group` distinguishes them. Mirrors `Layer.to_dict` in tiles/engine.py.
 */
export interface MapLayerMeta {
  layer_id: string;
  label: string;
  description: string;
  /** Backend raster transport, or a source mounted directly by the frontend. */
  kind: 'ee' | 'wms' | 'static';
  attribution: string;
  legend: { label: string; color: string }[];
  unit: string | null;
  /** False for layers whose content does not vary by date (permanent water). */
  dated: boolean;
  temporal_kind: LayerTemporalKind;
  bounds: LayerBounds | null;
  /** Selectable sources for this product; empty when the layer has one fixed source. */
  sensors: LayerSensorOption[];
  /**
   * Which endpoint served this layer, and which panel lists it.
   *
   * Required rather than optional on purpose: the compiler then refuses any
   * fixture entry that forgets it, which is what keeps the offline mirrors in
   * step with the two backend catalogues.
   */
  group: LayerGroup;
}

/**
 * Whether the backend can reach Earth Engine.
 *
 * `configured` describes the environment, not the outcome — registration,
 * quota and dataset access can still fail, and only a tile request finds out.
 */
export interface EarthEngineStatus {
  project_set: boolean;
  service_account_set: boolean;
  key_file_readable: boolean;
  user_credentials_present: boolean;
  /** gcloud Application Default Credentials — a third viable auth path. */
  adc_present: boolean;
  mode: 'service_account' | 'user' | 'adc' | 'none';
  configured: boolean;
}

export interface LayerCatalogue {
  layers: MapLayerMeta[];
  /** Null when the catalogue came from fixtures — offline we cannot know. */
  earth_engine: EarthEngineStatus | null;
}

export interface LayerForecastMeta {
  issued_at: string;
  valid: { start: string; end: string };
  lead_hours: number;
  source_age_seconds: number;
  bounds: LayerBounds;
}

export interface PowerStationResult {
  tower_id: string;
  status: 'available' | 'unavailable';
  station: {
    osm_id: string;
    name: string | null;
    kind: 'substation' | 'plant';
    lon: number;
    lat: number;
    distance_m: number;
  } | null;
  source: string;
  source_updated_at: string | null;
  coverage_bounds: LayerBounds | null;
  detail: string;
}

/** GET /flood/tiles/{layer_id} — a minted Earth Engine tile template. */
export interface LayerTiles {
  layer_id: string;
  date: string | null;
  sensor: string | null;
  tile_url: string;
  /**
   * Whether the backend could fetch a tile without credentials. 'requires_auth'
   * means the browser will get 403s and the layer would render blank, so the UI
   * must say so rather than draw nothing.
   */
  tile_access: 'public' | 'requires_auth' | 'unknown';
  attribution: string;
  /** Source scenes behind the selected observation; null for layers that use none. */
  scenes: number | null;
  /** The window actually searched — rarely just the requested date. */
  window: { start: string; end: string } | null;
  /** Latest source image included in an observation layer. */
  observed_at: string | null;
  /** Number of source images included, when completeness matters. */
  source_count: number | null;
  forecast: LayerForecastMeta | null;
  /**
   * Opaque id for the exact source window behind this tile, for layers that
   * declare one; null for every layer that does not. The tile engine reads it
   * generically out of the builder's `source` dict and names no dataset.
   *
   * The active-fire tiles and GET /fire/exposure both derive theirs from one
   * `snapshot_for()` call, so the pixels a planner is looking at and the
   * evidence attached to the inspection they raise cannot describe different
   * windows.
   */
  snapshot_id: string | null;
  expires_at: string | null;
  cache_stale?: boolean;
  cache_detail?: string | null;
  /** Saved coverage; deeper map zooms magnify tiles at max_zoom. */
  bounds?: LayerBounds;
  max_zoom?: number;
}

/**
 * One tower's observed fire exposure.
 *
 * Mirrors an entry in the `towers` map returned by `screen_towers` in
 * src/backend/thermal/exposure.py. Evidence beside the score, never inside it —
 * nothing here reaches `risk`, `priority`, `decision` or `attribution`.
 */
export interface FireTowerExposure {
  tower_id: string;
  /**
   * How many days in the window carried a detection inside the buffer. A
   * satellite pixel-day, not a fire and not damage: the same burn observed on
   * three passes counts three.
   */
  hotspot_pixel_days: number;
  /**
   * Highest confidence class kept. Never 'low' — low-confidence detections are
   * screened out before the reduction, so the union has two members, not three.
   */
  max_confidence: 'nominal' | 'high';
  latest_acquisition: string;
}

/**
 * The parameters that produced the `towers` map — mirrors the `screening`
 * block of `screen_towers` in src/backend/thermal/exposure.py.
 *
 * Shown rather than assumed. "A hotspot within 5 km over three days at 375 m"
 * is a far weaker claim than "a fire at this site", and these four numbers are
 * what let a surface state the weaker one instead of implying the stronger.
 */
export interface FireScreening {
  buffer_m: number;
  resolution_m: number;
  window_days: number;
  confidence_included: string[];
  confidence_excluded: string[];
}

/**
 * How old the newest observation behind a snapshot is — mirrors the
 * `freshness` block of `screen_towers` in src/backend/thermal/exposure.py.
 *
 * `latest_acquisition` is null when nothing was detected anywhere in the AOI,
 * and `source_age_hours` is then null too rather than 0 — an age of zero reads
 * as "observed just now", the strongest currency claim available, produced by
 * the one case where nothing was observed at all. `stale` is true in that case
 * as well as past `stale_after_hours`, and the backend refuses to schedule an
 * inspection against a stale snapshot.
 */
export interface FireFreshness {
  latest_acquisition: string | null;
  source_age_hours: number | null;
  stale: boolean;
  stale_after_hours: number;
}

/**
 * GET /fire/exposure — one screening pass over the whole tower population.
 *
 * Mirrors the dict returned by `screen_towers` in src/backend/thermal/exposure.py.
 * The route answers 503 rather than a body when Earth Engine is unusable, so a
 * body in hand always means the question was actually asked: an empty `towers`
 * map is the quiet answer, never the failed one.
 */
export interface FireExposure {
  snapshot_id: string;
  date: string;
  source: string;
  attribution: string;
  window: { start: string; end: string };
  granules: number;
  screening: FireScreening;
  freshness: FireFreshness;
  /** How many towers were LOOKED AT — the denominator behind `towers`. */
  screened_towers: number;
  towers_with_detections: number;
  /** Only towers with at least one detection. An absent id means screened and quiet. */
  towers: Record<string, FireTowerExposure>;
}

/**
 * The evidence a planner reviewed before raising a fire inspection — mirrors
 * FireInspectionEvidence in src/backend/api/schemas.py.
 *
 * Frozen onto the work order at pin time rather than looked up again, so the
 * order still says what was seen once the snapshot it came from has expired.
 */
export interface FireInspectionEvidence {
  snapshot_id: string;
  observed_at: string;
  hotspot_pixel_days: number;
  max_confidence: string;
  buffer_m: number;
  window_days: number;
  reviewed: boolean;
  safe_access_confirmed: boolean;
}

export interface WorkOrder {
  tower_id: string;
  action: string;
  crew_type: string;
  parts: string[];
  urgency_days: number;
  why: string;
  /** On-site hours from actions.yaml. Excludes travel — see ScheduleEntry. */
  duration_hours?: number;
  /**
   * Present only on a reviewed fire-exposure inspection, absent or null on
   * every other order. Such an order is raised by its literal action key
   * rather than from a dominant factor, because no tower ever carries a fire
   * factor — so this field is the only place the order says what was observed.
   */
  fire_inspection?: FireInspectionEvidence | null;
}

export interface Crew {
  crew_id: string; // territory-prefixed: "KEL-C1"
  name: string;
  crew_type: string;
  depot: { lon: number; lat: number; name: string };
  territory: string;
  max_travel_km: number;
  shift_hours: number;
  members: string[];
}

export interface ScheduleEntry {
  crew_id: string;
  day: string; // ISO date
  order: number; // visit sequence
  tower_id: string;
  work_order: WorkOrder;
  pinned: boolean;
  pin_reason?: 'planner_override' | 'emergency';
  /**
   * Minutes from midnight, local. Solver-derived, never assumed: travel_min is
   * the drive from the previous stop (the depot, for order 1), start_min is
   * arrival, end_min adds the work order's duration. The timeline draws bar
   * geometry straight from these, so the board cannot show a slot the
   * optimizer did not commit to.
   */
  travel_min?: number;
  start_min?: number;
  end_min?: number;
  /**
   * True when this placement occupies a reserved crew-day — via a planner
   * pin, an emergency insertion, or (readiness-policy permitting) the SLA
   * valve landing on the tower's final legal day. SLA is one route onto
   * reserve capacity, not the only one.
   */
  consumed_reserve?: boolean;
}

/**
 * A crew-day held free of planned work, so an incident displaces nothing —
 * but only for as long as nothing has landed there. Once a pin, an
 * emergency, or the SLA valve occupies a reserved (crew_id, day), the
 * backend drops it from `ScheduleRun.reserve` rather than continuing to
 * report it as still free (reporting it would tell the UI to paint a
 * "held free" band over a booked job). So `reserve.length` here is reserve
 * days REMAINING for this run, not the readiness quota configured in
 * policy.yaml — those two numbers disagree by design once anything has
 * consumed reserve capacity.
 */
export interface ReserveSlot {
  crew_id: string;
  day: string;
  crew_type: string;
}

/**
 * Why one tower did not make it onto the board. Per-tower and explicit — the
 * bar this replaces printed one static monsoon sentence for the whole set.
 */
export type UnscheduledReason =
  | 'no_capacity'
  | 'past_sla'
  | 'monsoon_blocked'
  | 'no_crew_type'
  | 'reserved'
  // --- coverage, as opposed to capacity ---------------------------------
  // These three were reported as 'no_capacity' until 2026-09-10, which read
  // to a planner as "the crews were busy". They were not: measured on the
  // national roster, 47 of the 50 no_capacity towers had no crew able to
  // reach them on any day, while 108 of 210 crew-days sat completely idle.
  // None of the three is fixable by scheduling differently — they are
  // answered by a depot, a dispatch rule, or nothing at all.
  | 'out_of_range'
  | 'out_of_territory'
  | 'no_route';

export interface UnscheduledDetail {
  tower_id: string;
  reason: UnscheduledReason;
  deadline: string | null;
  crew_type: string;
}

export interface ScheduleRun {
  run_id: string;
  /** Every day the solver planned over — `planning_horizon_days` long, 7 today.
   *  Read this, never a hardcoded array: the UI used to render 5 fixed dates
   *  and silently hid any work the solver booked on days 6 and 7. */
  horizon: string[];
  entries: ScheduleEntry[];
  reserve: ReserveSlot[];
  unscheduled: string[]; // tower_ids with no capacity
  unscheduled_detail: UnscheduledDetail[];
  risk_weighted_wait: number; // objective value, for override deltas
  /**
   * Which travel model produced every km and minute in this run.
   *
   * `matrix`    — measured OSRM road legs (data/travel_matrix.npz).
   * `haversine` — the straight-line estimate: great-circle × 1.35 at 45 km/h.
   *
   * Read it before labelling a drive time. Printing "(est.)" on a measured
   * route understates it; omitting it on an estimate overstates it, and this
   * is the number the whole "we picked the fastest crew" claim rests on.
   * Optional because an offline fixture run has no backend to ask.
   */
  travel_source?: 'matrix' | 'haversine';
}

export interface OverridePreview {
  // returned by /schedule/preview
  moved: { tower_id: string; from: string; to: string; delta_days: number }[];
  dropped: string[];
  risk_weighted_wait_before: number;
  risk_weighted_wait_after: number;
}

export interface WhySlot {
  // deterministic, no LLM
  tower_id: string;
  crew_id: string;
  day: string;
  reasons: string[]; // rendered as bullets
}

export interface Stability {
  rho_mean: number;
  rho_p05: number;
  top_decile_retention: number;
  draws: number;
}

/** One dispatch policy's outcome, as computed by GET /schedule/baseline. */
export interface PolicyResult {
  entries: ScheduleEntry[];
  unscheduled: string[];
  risk_weighted_wait: number;
  mean_days_to_service_top_decile: number | null;
  sla_breach_count: number;
}

/**
 * The optimizer (`greedy`) compared against naive nearest-first dispatch
 * (`nearest_first`). `risk_weighted_wait_reduction_pct` is the headline
 * figure — risk-weighted wait vs. naive dispatch.
 */
export interface BaselineComparison {
  greedy: PolicyResult;
  nearest_first: PolicyResult;
  risk_weighted_wait_reduction_pct: number;
}

/**
 * One scorer's out-of-fold result from the training report.
 *
 * `oracle` is the generator's own latent intensity — the achievable ceiling,
 * never a competitor. A served model landing on it would mean the generator
 * leaked, not that the model is good, which is what `leak_check` tests.
 */
export interface HealthScorer {
  scorer: string;
  ranking: { roc_auc: number; pr_auc: number; base_rate: number };
  at_top_10_percent: {
    true_positive: number;
    false_positive: number;
    false_negative: number;
    true_negative: number;
    precision: number;
    recall: number;
    accuracy: number;
    balanced_accuracy: number;
    f1: number;
    lift_over_random: number;
  };
}

/** One detector measured inside the band where a second opinion could act. */
export interface HealthDetector {
  in_band_auc: number | null;
  model_auc: number | null;
  delta: number | null;
  /** `in_band_auc > model_auc` — the necessary condition for it to be worth acting on. */
  may_gate: boolean;
}

/**
 * The training report, verbatim from `maintenance_need_report.json`.
 *
 * Served rather than bundled: it is rewritten by every retrain, and a copy
 * compiled into the frontend would go stale exactly the way MethodPage's
 * hand-typed table did.
 */
export interface ModelReport {
  synthetic_labels: boolean;
  caveat: string;
  not_a_failure_label: string;
  generator_version: string;
  trained_at?: string;
  encroachment_note?: string;
  dataset: { towers: number; positives: number; base_rate: number; states: number; window: string[] };
  cv: { scheme: string; folds: number; operating_point: string };
  scorers: HealthScorer[];
  leak_check: { gap_to_oracle: number; beats_index_by: number; verdict: string };
  split_check: { random_kfold_pr_auc: number; grouped_pr_auc: number; inflation: number };
  demo_case_checks: { confusion_held: number; confusion_total: number; pairs_held: number; pairs_total: number };
  attribution: { mean_shares: Record<string, number>; dominant_counts: Record<string, number> };
  features: string[];
  factor_groups: Record<string, string[]>;
  second_opinion: {
    note: string;
    telemetry_roc_auc: number;
    blend_weight: number;
    change_weight?: number;
    change_verdict?: string;
    change_blend_sweep?: {
      seed: number; phase: 'sweep' | 'verification'; w_change: number;
      budget: number; f1: number; delta_f1: number; tp: number;
      in_band_auc: number | null; model_auc: number | null;
    }[];
    detectors_in_escalation_band: Record<string, HealthDetector>;
    blend_sweep: { w_novelty: number; roc_auc: number; pr_auc: number }[];
    matched_budget: {
      budget: number;
      lower_cut: { n: number; tp: number; fp: number; precision: number; recall: number; f1: number };
      ensemble: { n: number; tp: number; fp: number; precision: number; recall: number; f1: number };
      delta_f1: number;
    };
    towers_swapped_in: number;
    swapped_in_hits: number;
    novelty_by_quintile: { quintile: number; n: number; base_rate: number; calibration_error: number; roc_auc: number | null }[];
    flag_coverage: Record<string, { towers: number; evaluable: boolean; lift: number | null }>;
    verdict: string;
  };
}

/**
 * What this backend process is serving right now.
 *
 * Deliberately separate from the report, which describes a training run. The
 * two can legitimately disagree: a checkout with no trained artifact serves the
 * physical index against a report that describes the model, and `source` is how
 * you tell.
 */
export interface ModelServing {
  source: 'model' | 'index';
  towers: number;
  bands: Record<string, number>;
  escalated: number;
  /** Counts, not percentages — how many towers we could not measure at all. */
  novelty_unavailable: number;
  condition_unavailable: number;
  change_unavailable: number;
  flagged: number;
  blend_weight: number;
  change_weight: number;
  stability: Stability | null;
}

/** `report` is null on a checkout with no trained model. Null, never a zeroed struct. */
export interface ModelHealth {
  report: ModelReport | null;
  serving: ModelServing;
  ledger: LedgerSummary | null;
}

export interface LedgerSummary {
  version: number;
  records: number;
  malformed: number;
  first_observed: string | null;
  last_observed: string | null;
  agree: number;
  disagree: number;
  indeterminate: number;
  eligible_for_training: number;
  simulated_records: number;
  last_retrain: string | null;
  sources: Record<string, number>;
}

/**
 * One whole row of the observation ledger, from GET /model/feedback/observations.
 *
 * Whole, not a projection: the Close Loop export builds a confirmation by
 * copying one of these and changing two fields, and model/feedback.py's
 * _confirmed() keys candidates on (tower_id, source, observed_at).
 *
 * `agreement` here is model-vs-SATELLITE. The Close Loop page's own
 * `verdict_agreement` is model-vs-TECHNICIAN. Different comparisons, and
 * reading them as one number is the failure that page exists to prevent.
 */
export interface LedgerObservation {
  observed_at: string;
  tower_id: string;
  source: string;
  observation: Record<string, unknown>;
  predicted_priority: number;
  predicted_decision: string;
  agreement: string;
  label_status: string;
  simulated: boolean;
}

/** Whether CONFLUENCE_* env vars are set — never a promise the API is reachable. */
export interface ConfluenceStatus {
  configured: boolean;
  space_key: string | null;
}

export interface ConfluenceSearchResult {
  id: string;
  title: string;
  space_key: string | null;
  url: string;
}

export interface ConfluencePage {
  id: string;
  title: string;
  space_id: string | null;
  url: string;
  body_html: string;
  version: number | null;
}

// --- Integrations (GET /integrations) ---------------------------------------

export interface AgentToolParameter {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: AgentToolParameter[];
}

export interface IntegrationsReport {
  agent: {
    mode: 'claude' | 'fallback';
    /** null on the fallback path, which calls no model. */
    model: string | null;
    tools: AgentTool[];
  };
}

/**
 * A neighbour that could plausibly be asked to help cover an at-risk tower.
 *
 * INPUT FOR AN RF PLANNER, never a configuration. `bearing_deg` is the initial
 * great-circle bearing to that neighbour — a direction to a place, not an
 * antenna azimuth. This product holds no azimuth, antenna height, EIRP, band
 * or sector data for any tower, so no surface may render this as an
 * engineering instruction.
 *
 * Mirrors CoverCandidate in src/backend/api/schemas.py.
 */
export interface CoverCandidate {
  tower_id: string;
  distance_km: number;
  bearing_deg: number;
}

/**
 * A neighbour inside the search radius that is itself flood-exposed.
 *
 * Carried separately from `candidates` rather than filtered away, because
 * "three neighbours, all of them flooding too" and "no neighbours at all" are
 * different findings — 5 towers and 7 towers respectively on the live estate.
 */
export interface CoHazardNeighbour {
  tower_id: string;
  distance_km: number;
}

export interface TowerFallback {
  tower_id: string;
  /** 0-3. Empty is a real answer and the feature's headline finding. */
  candidates: CoverCandidate[];
  co_hazard: CoHazardNeighbour[];
  /**
   * Nearest other tower at ANY distance — not capped at the search radius, and
   * counting co-hazard towers. Answers "how alone is this site physically",
   * which is a different question from "who could cover it". Null only for a
   * single-tower estate.
   */
  nearest_km: number | null;
}

/**
 * Which flood-exposed towers have a neighbour that could stand in for them.
 *
 * `towers` holds ONLY at-risk towers (the model's maintain band, narrowed to
 * flood-dominant). A tower absent from the map is NOT at risk — it is never
 * present with empty lists, so absence must not be rendered as a reading.
 *
 * Mirrors FallbackReport in src/backend/api/schemas.py.
 */
export interface FallbackReport {
  generated_at: string;
  parameters: {
    search_radius_km: number;
    max_candidates: number;
    sector_count: number;
    at_risk_rule: string;
    basis: string;
  };
  at_risk_count: number;
  isolated_count: number;
  towers: Record<string, TowerFallback>;
}
