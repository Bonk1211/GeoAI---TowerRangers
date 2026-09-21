export function formatRisk(risk: number): string {
  return risk.toFixed(2);
}

export function formatInterval(lo: number, hi: number): string {
  return `${lo.toFixed(2)} – ${hi.toFixed(2)}`;
}

export function formatShare(share: number): string {
  return share.toFixed(2);
}

export function formatUrgency(days: number): string {
  return `within ${days} days`;
}

export function decisionLabel(decision: string): string {
  return decision.toUpperCase();
}

/** "Kelantan Power" -> "KP" — for the crew avatar chip on ticket cards. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** "2d ago" / "5h ago" / "just now" — for ticket cards and fix-note timestamps. */
export function formatRelativeAge(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
