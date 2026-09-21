// Compliance-audit checklists for the ticket drawer's Fix Notes panel.
// Source: MCMC MTSFB TC G041:2023 Annex B/C, ported from
// docs/MCMC_Fix_Note_Checklists.md — keep both in sync if a row changes.
//
// Pure data, no React — same convention as lib/ticketSkills.ts. Keyed by the
// ticket's issue_type (fixtures/tickets.ts ISSUE_TYPES), with a fallback for
// any value outside that fixed set since issue_type is free text at report
// time, not a real enum.

export interface ChecklistItem {
  id: string;
  item: string;
  requirement: string;
}

export interface ChecklistDef {
  title: string;
  source: string;
  items: ChecklistItem[];
}

const EQUIPMENT: ChecklistItem[] = [
  { id: 'eq-1', item: 'Antenna & mount condition', requirement: 'No defects, deformation, loose/missing hardware' },
  { id: 'eq-2', item: 'Feed line condition', requirement: 'Flanges/seals/jacket intact, properly secured, grounded' },
  { id: 'eq-3', item: 'Electrical components', requirement: 'Comply with MCMC MTSFB TC G040 §7.1.2.1.10' },
  { id: 'eq-4', item: 'Earthing continuity', requirement: 'Within max resistance per G040 §7.1.2.2.4' },
  { id: 'eq-5', item: 'Earthing connections', requirement: 'Electrodes-to-earth connections intact, no corrosion' },
  { id: 'eq-6', item: 'Lightning protection rod', requirement: 'Present at top of structure' },
  { id: 'eq-7', item: 'Standby power (genset/rectifier)', requirement: 'Starts on test; battery, fuel, ATS/controller functional' },
  { id: 'eq-8', item: 'Diesel/oil management', requirement: 'No leaks; managed to avoid scheduled waste (§6.3.2e)' },
  { id: 'eq-9', item: 'Other appurtenances', requirement: 'Sensors, floodlights etc. secured, no loose hardware' },
];

const POWER: ChecklistItem[] = [
  { id: 'pw-1', item: 'Earthing system — copper tape', requirement: 'Corrosion-free' },
  { id: 'pw-2', item: 'Earthing system — fasteners/connections', requirement: 'Tight and secure' },
  { id: 'pw-3', item: 'Lightning arrestor', requirement: 'In tag, functional' },
  { id: 'pw-4', item: 'Aviation light controller', requirement: 'Flasher / photo control / alarms functional' },
  { id: 'pw-5', item: 'Electrical wiring', requirement: 'Weather-tight, secure, no damage' },
  { id: 'pw-6', item: 'Power supply to active equipment', requirement: 'No fire-risk indicators (arcing, heat, burnt insulation)' },
];

const STRUCTURAL: ChecklistItem[] = [
  { id: 'st-1', item: 'Members (legs, bracing)', requirement: 'No damaged/loose/missing members' },
  { id: 'st-2', item: 'Bolts & locking devices', requirement: 'No loose/missing' },
  { id: 'st-3', item: 'Welded connections', requirement: 'No visible cracks' },
  { id: 'st-4', item: 'Base plate', requirement: 'No cracks in base metal or plate stiffeners' },
  { id: 'st-5', item: 'Finishing', requirement: 'Paint/galvanising good, rust/corrosion-free' },
  { id: 'st-6', item: 'Foundation — ground condition', requirement: 'No settlement, movement, earth cracks, erosion' },
  { id: 'st-7', item: 'Foundation — concrete condition', requirement: 'No cracking, spalling, honeycombing' },
  { id: 'st-8', item: 'Anchorage', requirement: 'Nuts tight, locking device present, grout good' },
  { id: 'st-9', item: 'Climbing facilities & platform', requirement: 'Secured, in-tag' },
];

const OTHER: ChecklistItem[] = [
  { id: 'ot-1', item: 'Site drainage', requirement: 'Proper system, no blockage, smooth flow to disperse point' },
  { id: 'ot-2', item: 'Soil condition', requirement: 'No major cracks, land subsidence, water ponding' },
  { id: 'ot-3', item: 'Slope', requirement: 'Slope analysis on file if applicable' },
  { id: 'ot-4', item: 'Vegetation', requirement: 'Grass cut ~1 m outside perimeter/fencing; slope turfing intact' },
  { id: 'ot-5', item: 'Aesthetic / housekeeping', requirement: 'Minimised visual intrusion, no theft/vandalism risk' },
  { id: 'ot-6', item: 'Site access', requirement: 'Logbook maintained, access process followed' },
];

const CHECKLISTS: Record<string, ChecklistDef> = {
  Equipment: { title: 'Equipment', source: 'MCMC TC G041:2023, Annex B', items: EQUIPMENT },
  Power: { title: 'Power', source: 'MCMC TC G041:2023, Annex B §6.1.3', items: POWER },
  Structural: { title: 'Structural', source: 'MCMC TC G041:2023, Annex B/C', items: STRUCTURAL },
  Other: { title: 'Other / Environment', source: 'MCMC TC G041:2023, Annex B §6.3', items: OTHER },
};

export function checklistForIssueType(issueType: string): ChecklistDef {
  return CHECKLISTS[issueType] ?? CHECKLISTS.Other;
}
