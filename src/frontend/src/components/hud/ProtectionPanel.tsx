import { useState } from 'react';
import type { Tower } from '../../api/types';
import { useWeights } from '../../state/useWeights';
import { useMitigations } from '../../state/useMitigations';
import {
  formatMyr,
  mitigationById,
  mitigationsFor,
  protectionDelta,
  type Mitigation,
} from '../../lib/protection';
import { bandColor, bandInk } from '../../lib/colors';
import { formatRisk, decisionLabel } from '../../lib/format';
import { Button } from '../ui/Panel';

/**
 * Choose a modelled site protection for one tower, and see what it would do.
 *
 * THE SECOND HALF OF A TWO-HALF STORY. The `Dispatch now` button beside this
 * one sends a crew and does NOT move the score, because a crew visit does not
 * move the ground. This panel models works that DO change the site — a plinth,
 * a genset, a regrade — and the score moves because an input changed and the
 * model was re-run over it. Presenting both, side by side, is what separates
 * opex from capex on this screen and what stops "dispatch" from being quietly
 * mistaken for "fixed".
 *
 * Every figure rendered here is assumed rather than measured, and the panel
 * says so in its own footer rather than leaving it to a caption elsewhere.
 * `residualNote` is rendered for the selected option before the user commits,
 * not after — the limit of the works is part of the choice, not a disclaimer
 * attached to the result.
 */
export function ProtectionPanel({ tower, onClose }: { tower: Tower; onClose: () => void }) {
  const weights = useWeights((s) => s.weights);
  const applied = useMitigations((s) => s.applied);
  const start = useMitigations((s) => s.start);
  const remove = useMitigations((s) => s.remove);

  const existing = applied[tower.tower_id];
  const options = mitigationsFor(tower);
  const [choice, setChoice] = useState<string | null>(options[0]?.id ?? null);

  // A tower already carrying modelled protection shows what it carries and
  // offers to withdraw it, rather than offering a second mitigation on top of
  // a score that already reflects the first. Stacking would compound two
  // assumed effect sizes into a number nobody could defend.
  if (existing) {
    const mitigation = mitigationById(existing);
    const p = tower.protection;
    return (
      <section className="border-t border-overlay/[0.09] px-4 py-3.5" aria-label="Modelled protection">
        <h3 className="eyebrow mb-2 text-accent">Modelled protection</h3>
        <p className="text-body leading-snug text-fg">{mitigation?.label ?? existing}</p>
        {p && (
          <p className="mt-1.5 text-micro tnum text-muted">
            risk {formatRisk(p.riskBefore)} &rarr; {formatRisk(p.riskAfter)} &middot;{' '}
            {decisionLabel(p.decisionBefore)} &rarr; {decisionLabel(tower.decision)}
          </p>
        )}
        {mitigation && (
          <p className="mt-2 text-micro leading-snug text-dim">{mitigation.residualNote}</p>
        )}
        <Button
          tone="ghost"
          onClick={() => remove(tower.tower_id)}
          className="mt-3 h-9 w-full"
        >
          Withdraw modelled protection
        </Button>
      </section>
    );
  }

  if (options.length === 0) {
    return (
      <section className="border-t border-overlay/[0.09] px-4 py-3.5">
        <h3 className="eyebrow mb-2">Modelled protection</h3>
        <p className="text-micro leading-snug text-dim">
          No modelled works apply &mdash; this tower carries no exposure in a factor the
          catalogue addresses.
        </p>
      </section>
    );
  }

  const selected = choice ? mitigationById(choice) : undefined;
  const delta = selected ? protectionDelta(tower, selected, weights) : null;

  return (
    <section className="border-t border-overlay/[0.09] px-4 py-3.5" aria-label="Model protection">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="eyebrow text-accent">Model protection</h3>
        <span className="text-micro text-dim">
          {tower.dominant_factor}-dominant
        </span>
      </div>

      <p className="mb-3 text-micro leading-snug text-muted">
        Works that change the site itself. Ordered by this tower&rsquo;s own exposure.
      </p>

      <div role="radiogroup" aria-label="Protection works" className="space-y-1.5">
        {options.map((m) => (
          <MitigationOption
            key={m.id}
            mitigation={m}
            share={tower.attribution[m.factor] ?? 0}
            checked={choice === m.id}
            onSelect={() => setChoice(m.id)}
          />
        ))}
      </div>

      {selected && delta && (
        <div className="mt-3 rounded-lg border border-overlay/[0.12] bg-overlay/[0.04] px-3 py-2.5">
          <p className="text-micro text-muted">If these works were carried out</p>
          <div className="mt-1.5 flex items-baseline gap-2">
            <span className="text-lead font-semibold tnum" style={{ color: bandInk(delta.decisionBefore) }}>
              {formatRisk(delta.riskBefore)}
            </span>
            <span aria-hidden="true" className="text-micro text-dim">&rarr;</span>
            <span className="text-title font-semibold tnum" style={{ color: bandInk(delta.decisionAfter) }}>
              {formatRisk(delta.riskAfter)}
            </span>
            <span
              className="ml-auto rounded-md border px-1.5 py-0.5 text-eyebrow font-semibold uppercase tracking-wider"
              style={{
                color: bandInk(delta.decisionAfter),
                borderColor: `${bandColor(delta.decisionAfter)}66`,
                backgroundColor: `${bandColor(delta.decisionAfter)}1a`,
              }}
            >
              {decisionLabel(delta.decisionAfter)}
            </span>
          </div>
          <p className="mt-1.5 text-micro leading-snug text-dim">{selected.equivalent}.</p>
          <p className="mt-1 text-micro leading-snug text-dim">{selected.residualNote}</p>

          {/* A SMALL MOVE IS A RESULT, NOT A FAULT, AND HAS TO SAY SO.
              815 of the 1,164 national towers sit in the `ok` band, where the
              best available works move the score by a median 0.003 — against
              0.184 in the maintain band. That is the model being right: there
              is little exposure to remove from a site that has little. But a
              reader who clicks an `ok` tower first sees a number barely move
              and reasonably concludes the feature is broken, so the panel
              states the reason rather than leaving the silence to be
              misread. */}
          {delta.riskBefore - delta.riskAfter < 0.02 && (
            <p className="mt-2 border-t border-overlay/[0.09] pt-2 text-micro leading-snug text-muted">
              Barely moves &mdash; this site carries little exposure to remove. Capital works
              earn their cost on the high-exposure sites, which is what the ranking is for.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex gap-2">
        <Button tone="ghost" onClick={onClose} className="h-9 flex-1">
          Cancel
        </Button>
        <Button
          tone="primary"
          onClick={() => choice && start(tower.tower_id, choice)}
          disabled={!choice}
          className="h-9 flex-1"
        >
          Model it
        </Button>
      </div>

      <p className="mt-2 text-micro leading-relaxed text-dim">
        Modelled only. Costs, durations and effect sizes are engineering assumptions, not
        measurements, and nothing here dispatches a crew or changes a schedule.
      </p>
    </section>
  );
}

function MitigationOption({
  mitigation,
  share,
  checked,
  onSelect,
}: {
  mitigation: Mitigation;
  share: number;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${
        checked
          ? 'border-accent/45 bg-accent/[0.07]'
          : 'border-overlay/[0.1] hover:border-overlay/[0.2] hover:bg-overlay/[0.04]'
      }`}
    >
      <input
        type="radio"
        name="mitigation"
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-accent"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-ui font-medium leading-snug text-fg">{mitigation.label}</span>
        <span className="mt-0.5 block text-micro text-muted">
          {formatMyr(mitigation.costMyr)} &middot; {mitigation.crewType} &middot;{' '}
          <span className="tnum">{mitigation.hours} h</span>
        </span>
        <span className="mt-0.5 block text-micro text-dim">
          addresses {mitigation.factor} &middot;{' '}
          <span className="tnum">{Math.round(share * 100)}%</span> of this site&rsquo;s exposure
        </span>
      </span>
    </label>
  );
}
