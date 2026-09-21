/**
 * Nav glyphs. Emoji were replaced with line icons because emoji render in the
 * host OS's own colour and style — on a dark instrument panel they read as
 * pasted-in stickers and break the one-accent rule.
 */
export interface IconProps {
  /** Nav glyphs are drawn at 18px in a rail and 15px in the floating pill. */
  size?: number;
}

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function MapIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z" />
      <path d="M9 4v13M15 6.5v13" />
    </svg>
  );
}

export function CalendarIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

export function SlidersIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </svg>
  );
}

export function SatelliteIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="m8 10 4-4 6 6-4 4-6-6Z" />
      <path d="m6 12-2 2 4 4 2-2M14 4l2-2M20 10l2-2" />
      <path d="M15 17a4 4 0 0 1-4 4" />
    </svg>
  );
}

/**
 * The fire layer group. Base family rather than `tool`, because LayerPanel
 * draws it twice at two sizes — as an 18px category tab and, via
 * `<FireIcon size={15} />`, as the per-layer glyph beside the 15px tool set,
 * exactly as it already does with SatelliteIcon.
 *
 * Stroke-only and uncoloured on purpose. A flame emoji would arrive in the
 * host OS's own orange, and warm hue on this app means tower severity — the
 * one reading observed fire must never borrow, since it enters no score.
 *
 * The leaning tip and the shoulder tongue are not styling. A symmetric flame
 * body is the same shape as FloodIcon's droplet, and the two sit one tab apart
 * in LayerPanel's category strip; rendered side by side, the symmetric draft
 * read as a second water glyph. The asymmetry is what tells them apart, and
 * the tongue's gap is cut wide on purpose — a narrower one closes into a blob
 * as the raster shrinks toward the 15px call site.
 */
export function FireIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M12.8 2.5c3.1 3.7 4.6 6.5 4.6 8.9a5.8 5.8 0 0 1-11.2.9c0-2.4 1.1-4.4 3.3-6.1-.5 2.4 0 4 1.6 4.8-.3-3.2.5-6 1.7-8.5Z" />
    </svg>
  );
}

/**
 * Disaster Simulation nav glyph. A radiating alert triangle rather than a
 * storm cloud or lightning bolt — both of those are already spoken for by
 * hazard/weather affordances elsewhere, and this tab is a scripted scenario
 * playback, not a live weather layer.
 */
export function SimulationIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M12 3.5 21 19H3L12 3.5Z" />
      <path d="M12 9.5v4.2" />
      <circle cx="12" cy="16.4" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TicketIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.6a1.6 1.6 0 0 0 0 2.8V14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.6a1.6 1.6 0 0 0 0-2.8V8Z" />
      <path d="M9.5 6.3v11.4" strokeDasharray="2 2.2" />
    </svg>
  );
}

/** Model health. A trace, not a heart — this reads a scorer, not a patient. */
export function PulseIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M3 12h4l2.5-6 4 12L16 12h5" />
    </svg>
  );
}

/**
 * AOI draw tools. Rendered at 15px inside the HUD's icon-only buttons, so each
 * call site must supply its own aria-label and title — an icon alone is not a
 * name.
 */
const tool = { ...base, width: 15, height: 15 };

export function PolygonIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M12 3.5 20 9l-3 10H7L4 9l8-5.5Z" />
    </svg>
  );
}

export function CircleIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
    </svg>
  );
}

export function RectangleIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
    </svg>
  );
}

export function UploadIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M12 16V4M12 4 8 8M12 4l4 4" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}

export function ChevronIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg {...tool} aria-hidden="true" fill="currentColor" stroke="none">
      <path d="M9 6.5v11l9-5.5-9-5.5Z" />
    </svg>
  );
}

/** Issue Descriptor skill glyph — a pencil-on-page, drafting a description. */
export function DescriptorIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M6 3.5h9L19 7.5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V7a1 1 0 0 0 1 1h3.5" />
      <path d="m9.5 17.5 1-3 5-5 2 2-5 5-3 1Z" />
    </svg>
  );
}

/** Assignee Agent skill glyph — a crew, since it suggests a candidate crew. */
export function AssigneeIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <circle cx="9" cy="8" r="2.6" />
      <path d="M4 19.5c0-3 2.2-5 5-5s5 2 5 5" />
      <circle cx="17" cy="9.5" r="2" />
      <path d="M14.5 19.5c.2-2.2 1.6-3.7 3.5-3.7 1.7 0 3 1.3 3.4 3.2" />
    </svg>
  );
}

/** Validation Assistant skill glyph — a checked clipboard, drafting closeout. */
export function ValidationIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <rect x="5" y="4.5" width="14" height="16" rx="1.5" />
      <path d="M9 3.5h6a1 1 0 0 1 1 1V6H8V4.5a1 1 0 0 1 1-1Z" />
      <path d="m8.5 13 2 2 4.5-4.5" />
    </svg>
  );
}

export function SparkleIcon() {
  return (
    <svg {...tool} aria-hidden="true" fill="currentColor" stroke="none">
      <path d="M12 3.5c.4 2.6 1.2 4.3 2.4 5.1.9.6 2 .9 3.6 1-1.6.1-2.7.4-3.6 1-1.2.8-2 2.5-2.4 5.1-.4-2.6-1.2-4.3-2.4-5.1-.9-.6-2-.9-3.6-1 1.6-.1 2.7-.4 3.6-1 1.2-.8 2-2.5 2.4-5.1Z" />
      <path d="M19 3.2c.2 1.1.5 1.8 1 2.1.4.3.9.4 1.5.4-.6.1-1.1.2-1.5.4-.5.3-.8 1-1 2.1-.2-1.1-.5-1.8-1-2.1-.4-.2-.9-.3-1.5-.4.6 0 1.1-.1 1.5-.4.5-.3.8-1 1-2.1Z" />
    </svg>
  );
}

export function ChevronDownIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export function BellIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M6 9a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 13 6 9Z" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  );
}

export function AttachmentIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M15.5 6.5 8.4 13.6a3 3 0 0 0 4.24 4.24l7.07-7.07a5 5 0 0 0-7.07-7.07L5.5 10.86a7 7 0 0 0 9.9 9.9" />
    </svg>
  );
}

export function BackArrowIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="m11 5-6 7 6 7M5.5 12H20" />
    </svg>
  );
}

export function SearchIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

/**
 * Risk-factor glyphs, one per entry in a tower's `attribution`. These replaced
 * emoji on the Investigation page for the reason at the top of this file — and
 * because an emoji carries its own colour, which on a factor row sits right
 * next to a severity-coloured badge and competes with it.
 */
export function FloodIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M12 3.5c3 3.6 4.5 6.2 4.5 8.3a4.5 4.5 0 0 1-9 0c0-2.1 1.5-4.7 4.5-8.3Z" />
      <path d="M3 19.5c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1" />
    </svg>
  );
}

export function RainIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M6 14a4 4 0 0 1-.5-8 6 6 0 0 1 11.3 1A3.5 3.5 0 0 1 18 14" />
      <path d="m8 16-1 3m5-3-1 3m5-3-1 3" />
    </svg>
  );
}

export function TerrainIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="m2 19 6.5-10 4 5.5L15.5 10 22 19H2Z" />
      <path d="m8.5 9 2 3M15.5 10l1.6 2.4" />
    </svg>
  );
}

/**
 * The transmission-backbone layer group. Nodes joined by trunk lines — a
 * network graph, not a signal-strength fan, because this layer draws physical
 * fibre and microwave corridors between endpoints and says nothing about radio
 * coverage or capacity.
 *
 * Base family rather than `tool`, for FireIcon's reason: LayerPanel draws it at
 * 18px as a category tab and at 15px as a per-layer glyph.
 *
 * Deliberately unlike SatelliteIcon and TerrainIcon, its neighbours in the same
 * strip. The endpoints are filled dots and the trunk runs corner to corner, so
 * at 15px it reads as a link rather than as another angular landform outline —
 * the same disambiguation problem FireIcon solved against FloodIcon's droplet.
 */
export function NetworkIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M6.6 16.4 11 12.1M13 10.2 17.4 6" />
      <circle cx="4.7" cy="18.3" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="11.2" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="19.3" cy="4.7" r="2.2" fill="currentColor" stroke="none" />
      <path d="M4.7 12.4V8.2a3 3 0 0 1 3-3h4" />
    </svg>
  );
}

export function PowerIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M9 3v6M15 3v6" />
      <path d="M6 9h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V9Z" />
      <path d="M12 18v3" />
    </svg>
  );
}

export function EquipmentIcon() {
  return (
    <svg {...tool} aria-hidden="true">
      <path d="M12 8v13M8.5 21h7" />
      <circle cx="12" cy="5.5" r="1.8" />
      <path d="M7.5 9.5a6.5 6.5 0 0 1 0-8M16.5 1.5a6.5 6.5 0 0 1 0 8" />
    </svg>
  );
}

/** Integrations nav glyph — a plug, for third-party Plugin/MCP access into the platform. */
export function PlugIcon({ size = 18 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M9 2v5M15 2v5" />
      <path d="M6.5 7h11v3.5A5.5 5.5 0 0 1 12 16a5.5 5.5 0 0 1-5.5-5.5V7Z" />
      <path d="M12 16v3M9 21.5h6" />
    </svg>
  );
}

export function CheckIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={2.2} aria-hidden="true">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function ArrowRightIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} strokeWidth={2} aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function InfoIcon({ size = 14 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </svg>
  );
}

export function CommentIcon({ size = 12 }: IconProps) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true">
      <path d="M4 5h16v11H9l-5 4V5Z" />
    </svg>
  );
}
