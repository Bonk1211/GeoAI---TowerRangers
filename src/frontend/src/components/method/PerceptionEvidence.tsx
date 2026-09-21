import { Panel } from '../ui/Panel';

/**
 * How imagery becomes an index input.
 *
 * Salvaged from the Perception tab, which the Close Loop page replaced. That
 * page was 5/7 empty "imagery export pending" placeholders around three real
 * facts, and those three belong here — Method is already the page that explains
 * how the model is built, and these numbers are inputs to it.
 *
 * 0.41 is not an illustration. It is the flood share MY_1042's attribution
 * actually shows, which is why it survived the move.
 */
export function PerceptionEvidence() {
  return (
    <Panel className="mt-5" title="From imagery to input">
      <p className="text-lead leading-relaxed text-muted">
        The flood factor is derived from imagery, not read from a table. A Sentinel-2 tile over
        Sunway (101.605E, 3.065N) is segmented with OmniWaterMask via{' '}
        <a
          href="https://github.com/opengeos/geoai"
          className="text-accent underline underline-offset-2 hover:no-underline"
          target="_blank"
          rel="noreferrer"
        >
          opengeos/geoai
        </a>
        , and the distance-to-water field that falls out is what the index consumes.
      </p>

      <dl className="mt-4 grid gap-2 text-ui sm:grid-cols-3">
        <div className="rounded-lg border border-accent/30 bg-accent/[0.07] px-3 py-2.5">
          <dt className="text-micro text-muted">MY_1042 flood factor</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none tnum text-accent">
            0.41
          </dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            84 m to water · HAND 2.1 m. The same share the tower&apos;s attribution shows — the value
            the index consumes, not a separate illustrative number.
          </p>
        </div>
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-3 py-2.5">
          <dt className="text-micro text-muted">Exposure footprints</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none tnum text-fg">
            1,847
          </dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            From <span className="font-mono">BuildingFootprintExtractor()</span> in the 2 km service
            buffer — about 6,200 people served. Footprints stand in where OSM is sparse.
          </p>
        </div>
        <div className="rounded-lg border border-overlay/10 bg-overlay/[0.02] px-3 py-2.5">
          <dt className="text-micro text-muted">Coverage</dt>
          <dd className="mt-1 font-display text-title font-semibold leading-none text-fg">Sunway</dd>
          <p className="mt-1.5 text-micro leading-snug text-muted">
            Processed. 13 states pending — to extend coverage, change the bounding box and rerun.
          </p>
        </div>
      </dl>
    </Panel>
  );
}
