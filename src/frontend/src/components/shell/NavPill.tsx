import type { JSX } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  MapIcon,
  SearchIcon,
  TicketIcon,
  CalendarIcon,
  SatelliteIcon,
  SimulationIcon,
  type IconProps,
} from './icons';

const NAV_ITEMS: {
  to: string;
  label: string;
  Icon: (props: IconProps) => JSX.Element;
  alsoActiveUnder?: string[];
}[] = [
  { to: '/map', label: 'Map', Icon: MapIcon },
  // Investigation owns /tower/:towerId as well, so it has to claim the active
  // state for a path NavLink would not match on its own.
  { to: '/investigation', label: 'Investigation', Icon: SearchIcon, alsoActiveUnder: ['/tower'] },
  { to: '/tickets', label: 'Tickets', Icon: TicketIcon },
  { to: '/schedule', label: 'Schedule', Icon: CalendarIcon },
  // Placed after Schedule so the pill reads in pipeline order — detect
  // (Map, Investigation), decide (Tickets, Schedule), then the scenario that
  // exercises all of it (docs/Disaster_Simulation_Spec.md §2).
  { to: '/simulation', label: 'Simulation', Icon: SimulationIcon },
  { to: '/loop', label: 'Close Loop', Icon: SatelliteIcon },
];

/**
 * Top-centre navigation for the full-bleed Overview route.
 *
 * This replaced a fixed rail, whose active state leaned on a spine running
 * down the rail's edge. There is no spine here, so the active item is carried
 * by `aria-current` too. NavLink sets that itself when active — the point is
 * that it must not be suppressed, since colour alone would otherwise be the
 * only cue.
 */
interface NavPillProps {
  /**
   * `float` draws its own glass chip, for sitting directly on the map.
   * `inline` draws no surface, for sitting inside a bar that already has one.
   */
  variant?: 'float' | 'inline';
}

export function NavPill({ variant = 'float' }: NavPillProps) {
  const { pathname } = useLocation();

  return (
    <nav
      aria-label="Sections"
      className={`flex gap-1 rounded-xl p-[5px] ${
        variant === 'float' ? 'glass-float' : 'bg-overlay/[0.03]'
      }`}
    >
      {NAV_ITEMS.map(({ to, label, Icon, alsoActiveUnder }) => {
        // NavLink only sets aria-current when its own match succeeds, which it
        // does not for the paths a section merely adopts. Without this the
        // adopted path would be signalled by colour alone.
        const adopted = alsoActiveUnder?.some((prefix) => pathname.startsWith(prefix)) ?? false;
        return (
        <NavLink
          key={to}
          to={to}
          end={to === '/map'}
          aria-current={adopted ? 'page' : undefined}
          className={({ isActive }) =>
            [
              'flex items-center gap-[7px] rounded-[9px] px-[11px] py-2 text-ui transition-colors duration-150',
              isActive || adopted
                ? 'bg-accent/15 font-medium text-accent'
                : 'text-muted hover:bg-overlay/[0.06] hover:text-fg',
            ].join(' ')
          }
        >
          {/* The glyph is decoration over the label, never a substitute for
              it — each icon is aria-hidden and the text is the accessible
              name. Below lg the label collapses to sr-only rather than being
              removed, so a six-item pill fits beside the brand and status
              chips at narrow widths without any item losing its name. */}
          <Icon size={15} />
          <span className="sr-only lg:not-sr-only">{label}</span>
        </NavLink>
        );
      })}
    </nav>
  );
}
