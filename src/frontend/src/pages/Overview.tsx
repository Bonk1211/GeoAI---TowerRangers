import { MapView } from '../components/map/MapView';
import { MapOverlays } from '../components/hud/MapOverlays';
import { SelectionReticle } from '../components/hud/SelectionReticle';
import { BrandMark } from '../components/shell/BrandMark';
import { NavPill } from '../components/shell/NavPill';
import { StatusChips } from '../components/shell/StatusChips';
import { BandModule } from '../components/hud/BandModule';
import { AreaModule } from '../components/hud/AreaModule';
import { OpacityModule } from '../components/hud/OpacityModule';
import { AoiModule } from '../components/hud/AoiModule';
import { LayerPanel } from '../components/hud/LayerPanel';
import { SelectionHud } from '../components/hud/SelectionHud';
import { ProtectionConsole } from '../components/hud/ProtectionConsole';
import { VintageScrubber } from '../components/hud/VintageScrubber';
import { SearchModule } from '../components/hud/SearchModule';
import { ChevronDownIcon, SlidersIcon } from '../components/shell/icons';
import { MapViewControls } from '../components/hud/MapViewControls';

/**
 * Console HUD.
 *
 * The map owns the whole frame; every control is a small detached module
 * floating over it. Nothing here is a layout parent of the map, so the map is
 * never resized by chrome appearing or disappearing.
 *
 * The wrapper is `pointer-events-none` and each module opts back in. Without
 * that, the invisible positioning boxes around the floating modules would eat
 * clicks meant for towers underneath them.
 */
export function Overview() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapView />
      <MapOverlays />
      <SelectionReticle />

      <div className="pointer-events-none absolute inset-0 z-20">
        {/* Row one of the console bar, unpacked into floating modules. The
            three sit at the same screen positions the bar puts them in, so the
            nav does not jump when you arrive from another route. */}
        <div className="pointer-events-auto absolute left-5 top-[18px]">
          <BrandMark />
        </div>
        <div className="pointer-events-auto absolute left-1/2 top-[18px] -translate-x-1/2">
          <NavPill />
        </div>
        <div className="pointer-events-auto absolute right-5 top-[18px]">
          <StatusChips />
        </div>

        <div className="scroll-thin pointer-events-auto absolute bottom-[52px] left-5 top-[104px] flex w-[300px] flex-col gap-3 overflow-y-auto pr-1 pb-1 [&>*]:shrink-0">
          <LayerPanel />
          <BandModule />
        </div>

        <div className="pointer-events-none absolute bottom-[140px] right-5 top-[104px] flex w-[392px] max-w-[calc(100vw-40px)] flex-col gap-3 xl:w-[464px]">
          <MapViewControls />
          <details className="group glass-float scroll-thin pointer-events-auto max-h-[55%] shrink-0 scroll-pt-12 overflow-y-auto rounded-xl">
            <summary className="sticky top-0 z-10 flex min-h-12 cursor-pointer list-none items-center gap-2.5 rounded-xl bg-ink-900 px-3.5 text-ui font-medium text-muted transition-colors hover:text-accent [&::-webkit-details-marker]:hidden">
              <SlidersIcon size={16} />
              <span className="flex-1">Map tools</span>
              <span className="text-micro font-normal text-dim">View & area</span>
              <span className="transition-transform group-open:rotate-180"><ChevronDownIcon /></span>
            </summary>
            <div className="space-y-2 border-t border-overlay/[0.09] p-2">
              <AreaModule />
              <OpacityModule />
              <AoiModule />
            </div>
          </details>
          <SelectionHud />
        </div>

        {/* Sits above MapLibre's zoom control, which is pinned bottom-right. */}
        <div className="pointer-events-auto absolute bottom-[86px] right-[10px] z-30">
          <SearchModule />
        </div>

        <VintageScrubber />

        {/* The protection transcript. Sits inside the overlay layer at z-40 so
            it covers the floating modules while it runs — it is modal, and a
            reader must not be able to change the weights or the area under a
            score that is mid-computation. Renders null unless a run is in
            flight. */}
        <ProtectionConsole />
      </div>
    </div>
  );
}
