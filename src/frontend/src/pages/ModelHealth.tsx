import { PageHeader } from '../components/ui/Panel';
import { useModelHealthQuery } from '../api/queries';
import {
  AttributionSummary,
  GuardrailChecks,
  ObservationLedger,
  ProvenanceBanner,
  ScorerTable,
  SecondOpinionReport,
  ServingState,
} from '../components/health';

/**
 * What the served scorer measured, and what it is doing right now.
 *
 * Everything here is read from `GET /model/health` — the training report as the
 * notebook wrote it, plus live counts off the adapter's cached records. Nothing
 * on this page is a literal. The Method page carried a hand-typed copy of the
 * scorer table for one release and had already drifted from the artifact, which
 * is the reason this route exists.
 *
 * Order is deliberate. Provenance first, because every figure below is measured
 * against synthetic labels. Guardrails second, because a leaked generator or an
 * inflated split makes the numbers under them meaningless and a reader who
 * meets the confusion matrix first will believe it before reaching the caveat.
 */
export function ModelHealth() {
  const { data, isLoading, isError } = useModelHealthQuery();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Model Health"
        subtitle="What the served scorer measured, and what it is serving now."
      />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-4 p-4 pb-16">
          {isLoading && <p className="text-xs text-dim">Reading the training report…</p>}

          {/* No fixture, so absence is stated rather than filled in. Rendering a
              fabricated confusion matrix on the page whose job is telling you
              whether to trust the model would be the worst place in the app to
              invent a number. */}
          {!isLoading && !data && (
            <div className="rounded border border-overlay/15 bg-overlay/[0.045] p-4 text-xs">
              <div className="font-semibold text-fg/90">No health data</div>
              <p className="mt-1 text-dim">
                {isError
                  ? 'The backend did not answer. There is no offline stand-in for this page — every number on it is a measurement, and a fabricated one here would be worse than none.'
                  : 'The backend answered but had nothing to report.'}
              </p>
            </div>
          )}

          {data && (
            <>
              {data.report ? (
                <ProvenanceBanner report={data.report} />
              ) : (
                <div className="rounded border border-overlay/15 bg-overlay/[0.045] p-4 text-xs">
                  <div className="font-semibold text-fg/90">No training report on this checkout</div>
                  <p className="mt-1 text-dim">
                    {' '}
                    Run <code className="font-mono">notebooks/maintenance_need.ipynb</code> to produce
                    one. The serving state below is still live.
                  </p>
                </div>
              )}

              <ServingState serving={data.serving} />

              {data.report && (
                <>
                  <GuardrailChecks report={data.report} ledger={data.ledger} />
                  <ScorerTable report={data.report} />
                  <SecondOpinionReport report={data.report} />
                </>
              )}
              <ObservationLedger ledger={data.ledger} />
              {data.report && <AttributionSummary report={data.report} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
