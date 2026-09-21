import { useState, type ReactNode } from 'react';
import { Button, PageHeader, Panel } from '../components/ui/Panel';
import { useIntegrationsQuery } from '../api/queries';
import type { AgentTool, IntegrationsReport } from '../api/types';

/**
 * How this platform plugs into others.
 *
 * Product-facing on purpose: it describes the surface other systems integrate
 * with, not the backend's own plumbing (Earth Engine, Supabase and the rest are
 * implementation detail and do not belong on a customer-facing screen).
 *
 * Two tabs, with different provenance, and the page never blurs them:
 *   - Agent tools is LIVE — read from GET /integrations, i.e. the exact tool
 *     schemas the runner hands Claude, so it cannot drift from the code.
 *   - Roadmap is PLANNED — integrations that are not built, each naming the
 *     existing route it would build on so the gap is concrete.
 */

type Tone = 'ok' | 'watch' | 'neutral';

const TONE_CHIP: Record<Tone, string> = {
  ok: 'border-ok/45 bg-ok/12 text-ok-ink',
  watch: 'border-watch/45 bg-watch/12 text-watch-ink',
  neutral: 'border-overlay/15 bg-overlay/[0.05] text-muted',
};

function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-micro font-medium ${TONE_CHIP[tone]}`}
    >
      {children}
    </span>
  );
}

function Tag({ children, mono = false }: { children: ReactNode; mono?: boolean }) {
  return (
    <span
      className={`rounded border border-overlay/15 bg-overlay/[0.04] px-1.5 py-0.5 text-micro text-dim ${mono ? 'font-mono' : ''}`}
    >
      {children}
    </span>
  );
}

// Local, unexported: shell/icons.tsx has no info glyph on main, and a private
// one here cannot collide with a shared icon added later.
function InfoIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 7.5h.01" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Agent tools (live)
// ---------------------------------------------------------------------------

function ToolCard({ tool }: { tool: AgentTool }) {
  return (
    <Panel>
      <h2 className="font-mono text-ui font-semibold text-fg">{tool.name}</h2>
      <p className="mt-1.5 text-ui leading-relaxed text-muted">{tool.description}</p>
      {tool.parameters.length === 0 ? (
        <p className="mt-3 text-micro text-dim">Takes no parameters.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          {/* table-fixed + explicit widths so columns line up from card to card */}
          <table className="w-full min-w-[32rem] table-fixed text-left text-micro">
            <thead>
              <tr className="border-b border-overlay/10">
                <th scope="col" className="eyebrow w-[34%] pb-1.5 pr-4 font-normal">
                  Parameter
                </th>
                <th scope="col" className="eyebrow w-[18%] pb-1.5 pr-4 font-normal">
                  Type
                </th>
                <th scope="col" className="eyebrow pb-1.5 font-normal">
                  Description
                </th>
              </tr>
            </thead>
            <tbody>
              {tool.parameters.map((p) => (
                <tr key={p.name} className="border-b border-overlay/[0.06] last:border-0">
                  <td className="py-1.5 pr-4 align-top font-mono text-fg/85">
                    {p.name}
                    {p.required ? (
                      <span className="ml-1 font-sans text-dim">required</span>
                    ) : (
                      <span className="ml-1.5 font-sans text-dim">optional</span>
                    )}
                  </td>
                  <td className="py-1.5 pr-4 align-top font-mono text-dim">{p.type}</td>
                  <td className="py-1.5 align-top text-muted">{p.description ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function AgentToolsTab({
  data,
  isLoading,
  onRetry,
}: {
  data: IntegrationsReport | null | undefined;
  isLoading: boolean;
  onRetry: () => void;
}) {
  if (isLoading) return <p className="text-ui text-dim">Reading the agent's tool set…</p>;

  if (!data) {
    // No fixture: a hand-copied tool list is the drift this tab exists to avoid.
    return (
      <Panel spine="var(--color-alert)">
        <p className="text-ui font-semibold text-fg">Tool list unavailable</p>
        <p className="mt-1 text-ui text-muted">
          The backend did not answer. This tab reads the tools straight from the running code, so there is no
          offline copy to show instead.
        </p>
        <Button className="mt-3" onClick={onRetry}>
          Try again
        </Button>
      </Panel>
    );
  }

  const { agent } = data;
  const live = agent.mode === 'claude';

  return (
    <div className="space-y-3">
      <Panel spine={live ? undefined : 'var(--color-watch)'}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={live ? 'ok' : 'watch'}>{live ? 'Live model' : 'Deterministic fallback'}</Chip>
          {agent.model && <Tag mono>{agent.model}</Tag>}
          <span className="text-micro text-dim">{agent.tools.length} tools</span>
        </div>
        <p className="mt-2 text-ui leading-relaxed text-muted">
          {live
            ? 'Claude chooses which of these tools to call and in what order.'
            : 'No model is called. The agent runs a fixed parse → echo → optimize sequence over the same tools, so it works with no network and no API key.'}{' '}
          Either way, <span className="text-fg/90">a schedule only ever comes from optimize_schedule</span> — the
          model is never allowed to write one itself.
        </p>
      </Panel>

      {agent.tools.map((tool) => (
        <ToolCard key={tool.name} tool={tool} />
      ))}

      <p className="flex items-start gap-2 px-1 text-micro leading-relaxed text-dim">
        <span className="mt-px shrink-0">
          <InfoIcon />
        </span>
        These are the tool definitions the platform hands to its own agent, read from the running code. Opening
        them to external assistants over MCP is on the Roadmap.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roadmap (planned — not built)
// ---------------------------------------------------------------------------

interface PlannedIntegration {
  name: string;
  summary: string;
  /** What already exists that it would build on — keeps the plan grounded. */
  buildsOn: string[];
}

const PLANNED: PlannedIntegration[] = [
  {
    name: 'MCP server for the scheduling tools',
    summary:
      'Expose score_towers, propose_actions, optimize_schedule and apply_constraint over MCP so other assistants can plan against the same solver.',
    buildsOn: ['agent/tools.py TOOL_SCHEMAS', 'POST /schedule/optimize'],
  },
  {
    name: 'CMMS work-order sync',
    summary:
      'Push committed crew-day assignments into an operator maintenance system as work orders, and read closures back.',
    buildsOn: ['POST /schedule/pin', 'GET /schedule/{run_id}'],
  },
  {
    name: 'Crew mobile push',
    summary:
      'Send each crew its day — stops, travel legs and the runbook for each fault — to a field-technician app.',
    buildsOn: ['POST /travel/legs', 'GET /confluence/runbook/{factor}'],
  },
  {
    name: 'Risk index export',
    summary: 'Scheduled export of scored towers, with factor attribution, to an operator data lake.',
    buildsOn: ['GET /towers', 'GET /model/health'],
  },
  {
    name: 'MetMalaysia forecast feed',
    summary:
      'Warnings for heavy rain and monsoon surge, to move flood-exposed jobs before the weather rather than after.',
    buildsOn: ['Flood layers', 'Schedule monsoon constraint'],
  },
];

function RoadmapTab() {
  return (
    <div className="space-y-3">
      <p className="px-1 text-ui text-muted">
        Planned integrations — none of these are built yet. Each names the existing route it would build on.
      </p>
      {PLANNED.map((item) => (
        <Panel key={item.name}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-ui font-semibold text-fg">{item.name}</h2>
            <Chip tone="neutral">Planned</Chip>
          </div>
          <p className="mt-1.5 text-ui leading-relaxed text-muted">{item.summary}</p>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-0.5">Builds on</span>
            {item.buildsOn.map((b) => (
              <Tag key={b} mono>
                {b}
              </Tag>
            ))}
          </div>
        </Panel>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type TabKey = 'tools' | 'roadmap';

export function Integrations() {
  const { data, isLoading, refetch } = useIntegrationsQuery();
  const [tab, setTab] = useState<TabKey>('tools');

  const tabs: { key: TabKey; label: string; count: number | null }[] = [
    { key: 'tools', label: 'Agent tools', count: data ? data.agent.tools.length : null },
    { key: 'roadmap', label: 'Roadmap', count: PLANNED.length },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Integrations"
        subtitle="How this platform plugs into other systems — what it exposes today, and what is planned."
      />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-4 p-4 pb-16">
          <nav aria-label="Integration views" className="flex gap-1 rounded-xl bg-overlay/[0.03] p-[5px]">
            {tabs.map(({ key, label, count }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                aria-current={tab === key ? 'page' : undefined}
                className={`flex items-center gap-2 rounded-[9px] px-3.5 py-2 text-ui transition-colors duration-150 ${
                  tab === key
                    ? 'bg-accent/15 font-medium text-accent'
                    : 'text-muted hover:bg-overlay/[0.06] hover:text-fg'
                }`}
              >
                {label}
                {count !== null && (
                  <span className="rounded-full bg-overlay/[0.08] px-1.5 py-0.5 text-micro tnum">{count}</span>
                )}
              </button>
            ))}
          </nav>

          {tab === 'tools' ? (
            <AgentToolsTab data={data} isLoading={isLoading} onRetry={() => void refetch()} />
          ) : (
            <RoadmapTab />
          )}
        </div>
      </div>
    </div>
  );
}
