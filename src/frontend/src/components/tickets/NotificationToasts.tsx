import { useEffect } from 'react';
import { useTicketStore } from '../../state/useTicketStore';
import { BellIcon } from '../shell/icons';

const AUTO_DISMISS_MS = 4500;

/**
 * Notifier (§5) — mocked, in-app only. No real email/push send, so this is
 * the only place that behavior is visible; it must never claim more than it
 * does. aria-live announces it for screen readers without stealing focus.
 */
export function NotificationToasts() {
  const notifications = useTicketStore((s) => s.notifications);
  const dismiss = useTicketStore((s) => s.dismissNotification);

  useEffect(() => {
    if (notifications.length === 0) return;
    const timers = notifications.map((n) => setTimeout(() => dismiss(n.id), AUTO_DISMISS_MS));
    return () => timers.forEach(clearTimeout);
  }, [notifications, dismiss]);

  if (notifications.length === 0) return null;

  return (
    <div
      aria-live="polite"
      className="pointer-events-none absolute right-4 top-4 z-30 flex w-72 flex-col gap-2"
    >
      {notifications.map((n) => (
        <div
          key={n.id}
          className="glass-raised pointer-events-auto flex items-start gap-2 rounded-lg p-2.5 text-xs text-fg rise"
        >
          <span className="mt-0.5 shrink-0 text-accent" aria-hidden="true">
            <BellIcon />
          </span>
          <span className="min-w-0 flex-1 leading-snug">{n.text}</span>
          <button
            type="button"
            onClick={() => dismiss(n.id)}
            aria-label="Dismiss notification"
            className="shrink-0 rounded px-1 text-dim hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
