import { useScheduleStore } from '../../state/useScheduleStore';

const OPTIONS = [
  { mode: 'crew' as const, label: 'By crew' },
  { mode: 'tower' as const, label: 'By site' },
];

export function ViewToggle() {
  const viewMode = useScheduleStore((s) => s.viewMode);
  const setViewMode = useScheduleStore((s) => s.setViewMode);

  return (
    <div
      role="group"
      aria-label="Schedule layout"
      className="flex gap-0.5 rounded-lg border border-overlay/12 bg-overlay/[0.04] p-0.5"
    >
      {OPTIONS.map(({ mode, label }) => (
        <button
          key={mode}
          type="button"
          aria-pressed={viewMode === mode}
          onClick={() => setViewMode(mode)}
          className={`min-h-[28px] rounded-md px-3 text-ui font-medium transition-colors duration-150 ${
            viewMode === mode ? 'bg-accent/15 text-accent' : 'text-muted hover:text-fg'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
