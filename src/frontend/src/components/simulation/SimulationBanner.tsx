/**
 * Standing honesty banner. `docs/Disaster_Simulation_Spec.md` §8.2.
 *
 * Not a dismissible toast — it never goes away, because the honesty claim it
 * carries ("flood extent and outages are a stated premise, not a
 * prediction") holds for the entire time the page is open, not just on
 * first load. Shipped ahead of the rest of the P6 honesty surface
 * (evidence badges already ship in SimulationConsole; SimulationLegend
 * lands with the map overlays it names) because a navigable page with a
 * Start button and no on-screen disclaimer would overstate the system the
 * moment someone presses it — CLAUDE.md's §0.6 discipline applies to every
 * intermediate build state, not only the finished one.
 */
export function SimulationBanner() {
  return (
    <div
      role="note"
      className="shrink-0 border-b border-overlay/10 bg-overlay/[0.04] px-4 py-1.5 text-micro text-muted"
    >
      <strong className="font-medium text-fg">Scenario playback.</strong> Storm, flood, outages, closures and fleet reinforcements are authored.
      Assignments come from the optimizer; routes use mapped roads. Mobile coverage is illustrative. Field access is unverified.
    </div>
  );
}
