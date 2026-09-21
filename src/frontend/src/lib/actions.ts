// Mirrors src/backend/config/actions.yaml — dominant factor -> intervention.
// Deterministic lookup, no ML. Keep in sync with the backend file by hand;
// changing intervention behaviour still belongs in actions.yaml, not here.
interface ActionSpec {
  action: string;
  label: string;
  crew_type: string;
  parts: string[];
}

// Mirrors scheduler/actions.py's constant of the same name. A literal string
// spelled out at each call site is how the backend and this mirror drift apart
// without either side failing: an unknown key here resolves to flood work
// rather than throwing.
export const FIRE_INSPECTION_KEY = 'fire_exposure_inspection';

export const FACTOR_ACTIONS: Record<string, ActionSpec> = {
  flood: {
    action: 'raise_cabinet_and_seal',
    label: 'Raise equipment cabinet, seal ingress, clear/install drainage',
    crew_type: 'civil',
    parts: ['cabinet_riser', 'sealant_kit', 'sump_pump'],
  },
  terrain: {
    action: 'slope_stabilize_and_tension',
    label: 'Slope stabilization, access-road check, guy-wire tension',
    crew_type: 'civil',
    parts: ['ground_anchors', 'guy_wire'],
  },
  lightning: {
    action: 'surge_arrestor_swap',
    label: 'Surge-arrestor swap, ground-resistance test',
    crew_type: 'electrical',
    parts: ['surge_arrestor', 'earth_rod'],
  },
  equipment: {
    action: 'radio_unit_refresh',
    label: 'Radio-unit refresh, spares pre-stage',
    crew_type: 'rf',
    parts: ['rru_bbu_module'],
  },
  power: {
    action: 'battery_genset_service',
    label: 'Battery-bank test, genset service, fuel top-up',
    crew_type: 'power',
    parts: ['batteries', 'genset_filters', 'fuel'],
  },
  // Added with the supervised scorer — EVI and land cover became per-tower
  // features, not only map tiles, so `vegetation` is now a real dominant
  // factor. Before this entry existed, actionForFactor's DEFAULT_ACTION
  // fallback silently relabelled a vegetation-dominant tower's work order as
  // a flood one rather than erroring.
  vegetation: {
    action: 'vegetation_clearance',
    label: 'Clear encroaching vegetation, restore guy-wire and access clearance',
    crew_type: 'civil',
    parts: ['brush_cutter_consumables'],
  },
  // The one entry here that is NOT a dominant factor. No tower ever carries a
  // fire factor — observed fire sits beside the score, never inside it — so
  // actionForFactor() never reaches this key, and neither does the backend's
  // propose_action(). It is looked up by its literal name: from
  // propose_fire_inspection() there, from FIRE_INSPECTION_KEY here.
  //
  // Mirrored anyway, because the lookup below falls back to flood SILENTLY
  // where the backend raises KeyError for the same input. Without this entry a
  // fire inspection read through this file renders as "Raise equipment
  // cabinet, seal ingress" with a flood parts list — the vegetation bug above,
  // in a form a planner would act on. The yaml entry also carries
  // `target_days: 7`, the only deadline in that file, because a fire
  // inspection has no scored-tower record to inherit urgency_days from; the
  // backend reads it, nothing on this side does, so it is not mirrored.
  [FIRE_INSPECTION_KEY]: {
    action: 'fire_exposure_inspection',
    label: 'Post-fire site inspection: compound, cable ladder, feeder runs, fuel store, earthing',
    crew_type: 'civil',
    parts: [],
  },
};

const DEFAULT_ACTION: ActionSpec = FACTOR_ACTIONS.flood;

export function actionForFactor(dominant_factor: string): ActionSpec {
  return FACTOR_ACTIONS[dominant_factor] ?? DEFAULT_ACTION;
}

export function crewTypeForFactor(dominant_factor: string): string {
  return actionForFactor(dominant_factor).crew_type;
}
