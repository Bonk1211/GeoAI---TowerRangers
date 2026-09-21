import { placeName } from '../../fixtures/schedule';
import { Button } from '../ui/Panel';
import type { OverridePreview as OverridePreviewType } from '../../api/types';

interface OverridePreviewProps {
  preview: OverridePreviewType;
  onConfirm: () => void;
  onCancel: () => void;
}

export function OverridePreview({ preview, onConfirm, onCancel }: OverridePreviewProps) {
  const deltaPct = Math.round(
    ((preview.risk_weighted_wait_after - preview.risk_weighted_wait_before) / preview.risk_weighted_wait_before) *
      100,
  );
  const worse = deltaPct > 0;

  return (
    <div className="border-t border-overlay/10 bg-overlay/[0.03] p-5">
      <h3 className="eyebrow mb-3">If you make this move</h3>

      <ul className="space-y-1.5 text-ui">
        {preview.moved.map((m) => (
          <li key={m.tower_id} className="text-muted">
            <span className="text-fg">{placeName(m.tower_id)}</span> moves {m.from.slice(5)} → {m.to.slice(5)}{' '}
            <span className="tnum text-dim">
              ({m.delta_days > 0 ? '+' : ''}
              {m.delta_days}d)
            </span>
          </li>
        ))}
        {preview.dropped.map((id) => (
          <li key={id} className="text-watch-ink">
            <span className="text-fg">{placeName(id)}</span> stays unscheduled
          </li>
        ))}
      </ul>

      <div className="mt-3 flex items-baseline justify-between gap-3 border-t border-overlay/10 pt-3 text-ui">
        <span className="text-muted">Risk-weighted wait</span>
        <span className={`tnum ${worse ? 'text-watch-ink' : 'text-ok-ink'}`}>
          {worse ? '+' : ''}
          {deltaPct}%{' '}
          <span className="text-dim">
            ({preview.risk_weighted_wait_before.toFixed(1)} → {preview.risk_weighted_wait_after.toFixed(1)})
          </span>
        </span>
      </div>

      <div className="mt-4 flex gap-2">
        <Button tone="primary" onClick={onConfirm}>
          Apply move
        </Button>
        <Button onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
