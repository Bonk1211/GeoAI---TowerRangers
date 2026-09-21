import type { WorkOrder } from '../../api/types';
import { formatUrgency } from '../../lib/format';

interface WorkOrderCardProps {
  workOrder: WorkOrder;
}

export function WorkOrderCard({ workOrder }: WorkOrderCardProps) {
  return (
    <div className="p-4">
      <h3 className="eyebrow mb-2.5">Work order</h3>
      <p className="text-body leading-snug text-fg">{workOrder.action}</p>

      <dl className="mt-3 space-y-2.5 border-t border-overlay/10 pt-3 text-ui">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-dim">Crew type</dt>
          <dd className="rounded-md border border-overlay/12 bg-overlay/[0.05] px-2 py-0.5 text-fg">
            {workOrder.crew_type}
          </dd>
        </div>
        <div>
          <dt className="text-dim">Parts</dt>
          <dd className="mt-1.5 flex flex-wrap gap-1.5">
            {workOrder.parts.map((part) => (
              <span
                key={part}
                className="rounded-md border border-overlay/12 bg-overlay/[0.05] px-1.5 py-0.5 font-mono text-micro text-muted"
              >
                {part}
              </span>
            ))}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-dim">Due</dt>
          <dd className="text-watch-ink">{formatUrgency(workOrder.urgency_days)}</dd>
        </div>
      </dl>
    </div>
  );
}
