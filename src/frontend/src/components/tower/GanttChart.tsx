import type { WorkBreakdown, WbsTask } from '../../lib/workBreakdown';
import { addDays } from '../../lib/workBreakdown';

interface GanttChartProps {
  breakdown: WorkBreakdown;
  /** Floor on the chart width, in days. Omit it — the chart sizes itself to
   * the plan's actual span plus a short lead-in, so it doesn't render two or
   * three empty weeks after a short work order finishes. */
  horizonDays?: number;
}

const ROW_H = 40; // px, fixed so connector geometry can be computed without measuring the DOM
const LABEL_W = 168; // px

function fmt(date: Date): string {
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

// Three tiers of the interface accent, not the risk triad — a Gantt bar is a
// schedule position, never a severity reading, so it must not borrow
// maintain/watch/ok (docs/CLAUDE.md "cool accent = chrome, warm = risk").
function phaseTone(index: number, total: number): { fill: string; border: string } {
  if (index === 0) return { fill: 'var(--color-overlay)', border: 'var(--color-overlay)' }; // prep: quiet
  if (index === total - 1) return { fill: 'var(--color-accent-deep)', border: 'var(--color-accent-deep)' }; // closeout: deepest
  return { fill: 'var(--color-accent)', border: 'var(--color-accent)' }; // execution: full accent
}

/** Horizontal position of a day offset, as a 0–100 percentage of the timeline area. */
function pct(day: number, totalDays: number): number {
  return (day / totalDays) * 100;
}

/** Anchor an edge-aware label so it never gets clipped by the timeline's own bounds. */
function edgeTranslate(p: number): string {
  if (p <= 1) return 'translateX(0)';
  if (p >= 99) return 'translateX(-100%)';
  return 'translateX(-50%)';
}

export function GanttChart({ breakdown, horizonDays = 0 }: GanttChartProps) {
  const { planStart, tasks } = breakdown;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const planStartDate = new Date(planStart);
  planStartDate.setHours(0, 0, 0, 0);
  const daysSinceStart = Math.floor((today.getTime() - planStartDate.getTime()) / 86_400_000);

  // Size to the plan itself: the last task's end, or today if today falls
  // later (a backlog item's plan starts "now" so this is usually the same
  // day), plus a few days of lead-in — never a flat 30-day floor that leaves
  // most of the chart blank for an 8-day work order.
  const tasksEnd = Math.max(...tasks.map((t) => t.startDay + t.durationDays), 0);
  const totalDays = Math.max(horizonDays, tasksEnd + 3, daysSinceStart + 3, 7);

  const todayPct = daysSinceStart >= 0 && daysSinceStart <= totalDays ? pct(daysSinceStart, totalDays) : null;

  // Week ticks, plus the final day if the horizon doesn't land on a week
  // boundary — but not both when they'd sit close enough to collide.
  const weekTicks = [];
  for (let d = 0; d <= totalDays; d += 7) weekTicks.push(d);
  const lastTick = weekTicks[weekTicks.length - 1];
  if (totalDays - lastTick >= 3) weekTicks.push(totalDays);
  else if (totalDays !== lastTick) weekTicks[weekTicks.length - 1] = totalDays;

  const connectors = tasks
    .map((task, i) => ({ task, i, prev: tasks[i - 1] }))
    .filter((t): t is { task: WbsTask; i: number; prev: WbsTask } => Boolean(t.prev) && t.task.dependsOn === t.prev?.code);

  return (
    <div className="overflow-x-auto">
      <div className="flex" style={{ minWidth: `${LABEL_W + Math.max(220, totalDays * 24)}px` }}>
        {/* Label column */}
        <div className="shrink-0 pr-3" style={{ width: `${LABEL_W}px` }}>
          <div style={{ height: 28 }} />
          {tasks.map((task) => (
            <div key={task.code} className="flex items-center border-b border-overlay/5" style={{ height: ROW_H }}>
              <span className="truncate text-ui text-fg">
                <span className="mr-1.5 font-mono text-eyebrow text-dim">{task.code}</span>
                {task.name}
              </span>
            </div>
          ))}
        </div>

        {/* Timeline area — everything below is positioned as a % of this element's own width */}
        <div className="relative min-w-0 flex-1">
          {/* Week header */}
          <div className="relative border-b border-overlay/10" style={{ height: 28 }}>
            {weekTicks.map((d) => (
              <span
                key={d}
                className="absolute top-0 whitespace-nowrap text-eyebrow uppercase tracking-wider text-dim"
                style={{ left: `${pct(d, totalDays)}%`, transform: edgeTranslate(pct(d, totalDays)) }}
              >
                {fmt(addDays(planStart, d))}
              </span>
            ))}
          </div>

          {/* Day/week gridlines + zebra rows, all behind the bars */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0" style={{ top: 28 }}>
            {weekTicks.map((d) => (
              <div
                key={d}
                className="absolute top-0 bottom-0 border-l border-overlay/8"
                style={{ left: `${pct(d, totalDays)}%` }}
              />
            ))}
            {tasks.map((task, i) =>
              i % 2 === 1 ? (
                <div
                  key={task.code}
                  className="absolute inset-x-0 bg-overlay/[0.02]"
                  style={{ top: i * ROW_H, height: ROW_H }}
                />
              ) : null,
            )}
          </div>

          {/* Today marker */}
          {todayPct !== null && (
            <div
              className="pointer-events-none absolute bottom-0 z-20 border-l-2 border-accent"
              style={{ left: `${todayPct}%`, top: 28 }}
            >
              <span
                className="absolute top-0 whitespace-nowrap rounded-b-sm bg-accent px-1 py-0.5 text-eyebrow font-bold uppercase tracking-wide text-white"
                style={{ transform: `${edgeTranslate(todayPct)} translateY(-100%)` }}
              >
                Today
              </span>
            </div>
          )}

          {/* Dependency connectors — bars sit end-to-end with no gap, so each
              connector is a short vertical joiner between row centres rather
              than a routed elbow. */}
          {connectors.map(({ task, i, prev }) => {
            const x = pct(prev.startDay + prev.durationDays, totalDays);
            const top = 28 + (i - 1) * ROW_H + ROW_H / 2;
            const bottom = 28 + i * ROW_H + ROW_H / 2 - 5;
            return (
              <div
                key={task.code}
                className="pointer-events-none absolute z-10 border-l border-dashed border-overlay/25"
                style={{ left: `${x}%`, top, height: Math.max(0, bottom - top) }}
              >
                <svg
                  width="8"
                  height="6"
                  viewBox="0 0 8 6"
                  className="absolute -translate-x-1/2"
                  style={{ top: bottom - top - 1 }}
                  aria-hidden="true"
                >
                  <path d="M0 0 L4 6 L8 0 Z" fill="var(--color-overlay)" opacity="0.35" />
                </svg>
              </div>
            );
          })}

          {/* Bars */}
          {tasks.map((task, i) => {
            const tone = phaseTone(i, tasks.length);
            const left = pct(task.startDay, totalDays);
            const width = pct(task.durationDays, totalDays);
            return (
              <div
                key={task.code}
                className="absolute flex items-center border-b border-overlay/5"
                style={{ left: 0, right: 0, top: i * ROW_H + 28, height: ROW_H }}
              >
                <div
                  className="h-6 rounded-full border shadow-[var(--shadow-1)]"
                  style={{
                    marginLeft: `${left}%`,
                    width: `${width}%`,
                    backgroundColor: `color-mix(in srgb, ${tone.fill} 22%, transparent)`,
                    borderColor: `color-mix(in srgb, ${tone.border} 55%, transparent)`,
                  }}
                  title={`${task.name}: ${fmt(addDays(planStart, task.startDay))} – ${fmt(
                    addDays(planStart, task.startDay + task.durationDays),
                  )} · ${task.pic}`}
                />
              </div>
            );
          })}

          {/* Spacer to give the absolutely-positioned rows above their height */}
          <div style={{ height: tasks.length * ROW_H }} />
        </div>
      </div>
    </div>
  );
}
