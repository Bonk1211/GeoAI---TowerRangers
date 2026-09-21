Setup = 3 pieces, port each to new project:

1. CLAUDE.md — rules doc (non-negotiable)
Repo-root file. Agent reads it first, every session, automatically. Must contain:

Hard money/security rules (if any) — things that must NEVER happen
Architecture map (what depends on what)
"Gotchas" — real incidents that already bit you, written as rules with reasoning (not just "don't do X" but why, so agent judges edge cases right)
Commands (test/lint/build/single-test)
Without this doc, overnight agent has no guardrails — brief alone isn't enough, CLAUDE.md is what stopped e.g. averaging consensus scores or selling puts.

2. OVERNIGHT-PROMPT.md (or whatever name) — the one-shot brief
Structure that worked, copy shape:

Section 0: one question, asked once, with default-if-no-reply — so agent doesn't stall
Section 1: hard rules (money, keys, disqualifiers, honesty, process) — restates/sharpens CLAUDE.md for this specific run
Section 2: research phase first, cite sources, write findings to a doc before coding
Section 3: prioritized backlog, each item scoped to "done when gate passes + pushed"
Section 4: validation gate — exact commands, must pass before every push
Section 5: docs/commits/push discipline — small commits, docs updated same commit, push after every item not just at end
Section 6: keep-going rules — timebox per item (~90min), never stop to ask, log blockers and move on
Section 7: stop conditions — explicit, so it doesn't run forever or quit early
Section 8: final report format
3. docs/overnight-log.md — append-only audit trail
Agent creates/appends this itself per cycle. You don't pre-write it, just tell agent (in the prompt) to keep one, format:


## <timestamp> — <item>
Did: ...
Decisions made without operator: ... (+ reasoning)
Validation: pass/fail, commands run
Blocked: ...
Next: ...
How to actually run it
Write CLAUDE.md for new project (adapt rules to that domain's real risks).
Write the overnight prompt, backlog specific to that project's actual gaps.
Paste prompt as first message to fresh Claude Code session in that repo.
Walk away. Agent self-dispatches subagents for research/parallel work as needed — no separate config for that, comes free from Agent tool access.
Morning: read docs/overnight-log.md final report section, review diffs, decide what to keep/reverse.
Want me to draft CLAUDE.md + OVERNIGHT-PROMPT.md skeletons for your other project now? Tell me 

## Example

# Overnight autonomous run — Aegis (MUBA Hackathon 2026)

You are working unattended overnight on the repository at
`/Users/user/Workspace/Projects/MUBA-Hackathon` (project name: **Aegis**).
The operator is asleep. You will not get another chance to ask anything.

Your job, in order: **research → implement → validate → fix → document → push.**
Then pick up the next item and do it again, until the stop conditions at the
bottom are met.

**Read `CLAUDE.md` in the repo root before you touch anything.** It contains
non-negotiable project rules (bigint money, no averaging of consensus scores,
the AI gates spending, honesty constraints). Those rules outrank anything in
this brief that appears to contradict them. If you find a genuine conflict,
follow `CLAUDE.md` and note the conflict in the log.

---

## 0. The single question you are allowed to ask

Ask this **once**, as your very first action, in one message. Then never ask
the operator anything again for the rest of the run.

> Before I start the overnight run, four things I can't determine myself:
> 1. **Push target** — `origin` is `git@github.com:ZhuHengg/MUBA-Hackathon.git`
>    (SSH) but `gh` is authenticated as `jqc-lgtm` over HTTPS. Should I push
>    there (switching to HTTPS if SSH fails), or somewhere else?
> 2. **`BASE_RPC_URL`** — paste one if you want me to develop and rehearse the
>    live chain feed against real Base mainnet reads. Without it I stay in
>    replay mode and build the feed against recorded data.
> 3. **`GONKA_API_KEY`** — I am assuming you do *not* want to hand me one, and
>    will validate the inference path entirely against a fake client. Confirm,
>    or paste a key if you'd rather I prove it end to end.
> 4. **Anything you want reprioritised** from the backlog in section 3?

**If no reply arrives within 10 minutes, proceed with these defaults and say so
in the log:** push to the existing `origin` (falling back to
`https://github.com/ZhuHengg/MUBA-Hackathon.git` if SSH auth fails); no
`BASE_RPC_URL`, so `AEGIS_MODE=replay` throughout; no Gonka key, so all
inference is validated against a fake client; backlog order exactly as written.

After that message, you are on your own. When you hit ambiguity, **decide,
write down the decision and its reasoning in the log, and keep moving.** Never
stop to ask. Never idle waiting for a reply.

---

## 1. Hard rules — violating any of these fails the run

**Money and keys.**
- **Never set `AEGIS_MODE=live`.** Not temporarily, not in a test, not "just to
  see". `replay` is the default; `dry-run` only if the operator supplied a
  `BASE_RPC_URL`.
- Never create, import, generate, or read a private key. `AGENT_PRIVATE_KEY`
  and `MAKER_PRIVATE_KEY` stay empty. Never sign or broadcast a transaction.
  Never request, move, or bridge funds.
- Never weaken, bypass, or add an escape hatch to `packages/hedge/src/safety.ts`.
  If a test needs a permissive policy, construct a separate policy instance in
  the test — do not relax `DEFAULT_LIMITS` or the mode gate.
- The real Base mainnet trade is the operator's job, awake. You prepare the
  path and write the checklist. You do not execute it.

**Track disqualifiers.**
- No OpenAI/Anthropic/Google/any non-Gonka model call may exist anywhere in the
  verification path (`packages/gonka`, `apps/web/app/api/verify`, the pipeline's
  Stage 2). This would disqualify the Gonka submission outright. You may use
  your own tools for *research*; you may not wire a foreign model into product
  code.
- Every inference must surface its Gonka request ID and public receipt URL.
  Never drop, summarise, or fabricate one.

**Honesty (these are product requirements, from `CLAUDE.md`).**
- Never claim ~90x returns. Payout multiples are computed from live pricing.
- Never present a replayed fixture as a live detection. `simulated: true` must
  render in the UI.
- Never show payout projections with the zero-payout rows hidden.
- Never soften a documented constraint (30s RFQ floor, bilateral close, 2–5s
  inference) to make progress look better.

**Process.**
- Never `git push --force`, never rewrite pushed history, never `--no-verify`.
- Never commit `.env`, any key, or `docs/reference/vendor/` (all gitignored —
  keep it that way).
- Never delete or skip a failing test to make the suite green. Never weaken an
  assertion to make it pass. Fix the code or fix a genuinely wrong test, and say
  which in the commit message.
- Never push a red build. The validation gate in section 4 passes, or you don't
  push.

---

## 2. Phase 1 — Research (do this first, and do it properly)

This phase is the point of the run. Do not shortcut it to get to coding.

**2a. Refresh the reference corpus.**

```bash
./docs/reference/fetch.sh          # idempotent; papers + repos already present
```

Nine papers are already in `docs/reference/vendor/papers/` and five upstream
repos in `docs/reference/vendor/repos/`. Confirm they're intact; re-fetch what
isn't. `docs/reference/README.md` explains why each one is there — read it
first, it is the map for this phase.

**2b. Read the papers.** All nine. Actually read them, don't skim the abstracts.

Detection (informs the Watchtower, `packages/core/src/anomaly.ts`):
`flashguard-realtime-flashloan-defense-2503.01944`,
`smartcat-realtime-price-manipulation-2502.03718`,
`lookahead-adversarial-contracts-2401.07261`,
`pmdetector-llm-price-manipulation-2510.21272`,
`ai-fraud-detection-defi-survey-2308.15992`.

Consensus and calibration (informs `packages/gonka/src/consensus.ts`):
`beyond-component-strength-calibration-2511.21729`,
`majority-rules-llm-ensemble-2511.15714`,
`confidence-calibration-multi-agent-2404.09127`,
`overconfidence-llm-as-judge-2508.06225`.

**2c. Read the upstream source you actually depend on.**
- `vendor/repos/thetanuts-sdk/src/modules/optionBook.ts` — verify every symbol
  in our hand-written `packages/hedge/src/sdk-surface.ts` against it. This file
  is a structural mirror of the SDK and **TypeScript cannot detect drift**;
  auditing it against real source is one of the highest-value things you will do
  tonight. Record every discrepancy.
- `vendor/repos/thetanuts-sdk/docs/rfq/lifecycle.md` — the four-phase auction.
- `vendor/repos/thetanuts-agentkit/src/safety.ts` and `SKILL.md` — the policy
  design we mirrored, and their prompt-injection trust boundaries.
- `vendor/repos/react-bits/src/ts-tailwind/` — component source for the UI work
  later. `ts-tailwind` variant only.

**2d. Research online.** Use web search/fetch for things the local corpus can't
tell you:
- Are `moonshotai/Kimi-K2.6` and `MiniMaxAI/MiniMax-M2.7` still valid model IDs
  on `gonkarouter.io`? Is the `GET /v1/receipts/{id}` endpoint still public and
  no-auth? Does the response shape still match `GonkaReceipt` in
  `packages/gonka/src/client.ts`?
- Is `@thetanuts-finance/thetanuts-client` still at `0.3.0`? Any breaking
  changes in a newer patch? (0.x minors *and patches* have shipped breaking
  changes here — see `CLAUDE.md`.)
- **Real addresses and real baselines.** `apps/sentinel/src/watchtower.ts`
  currently watches `0x0000...0000` with an invented $15M baseline. Find real,
  verifiable Base/Ethereum bridge escrows, exchange hot wallets, and protocol
  treasuries, and derive defensible outflow baselines from public data. Cite
  your sources inline.
- At least one **real historical exploit** with real on-chain data, recent
  enough to be checkable, that you can turn into a genuine backtest.
- Any newer literature (2026) on real-time DeFi exploit detection or LLM
  ensemble calibration. If you find something materially better than what's in
  `fetch.sh`, add it to the `PAPERS` array and to `docs/reference/README.md`.

**2e. Write the findings.** Create `docs/research/literature-to-implementation.md`.
For every paper and every significant finding, three columns of substance:

| What it says | What we change in this codebase | What we deliberately do *not* change, and why |

This document is the bridge between phase 1 and everything after it. Every
implementation task in section 3 that the research touches must cite a line in
this file. If a paper implies we should change something and we decide not to,
that refusal gets written down too.

**Commit and push at the end of phase 1** before writing any implementation
code.

---

## 3. Phase 2 — Implementation backlog, in priority order

Work these top to bottom. Each item is done when it passes the section 4
validation gate, its docs are updated in the same commit, and it's pushed.

**P0 — Baseline. Do this before anything else, including research.**
There are currently **zero commits** on `main` and everything is untracked; the
entire project exists on one disk. Establish the baseline first:
- `pnpm install`, confirm the toolchain runs.
- Create `.env` from `.env.example` with `AEGIS_MODE=replay` and empty keys.
- Verify push access per the operator's answer. If SSH fails, switch `origin`
  to the HTTPS URL for the authenticated account and retry.
- Commit everything currently untracked in a small number of coherent commits
  (not one giant blob — separate toolchain/config, `packages/*`, `apps/*`,
  `docs/*`), and push to `main`.
- `pnpm test` currently **fails**: `packages/hedge` has no test files and vitest
  exits 1. Make the suite green — either by adding the P4 tests early or by a
  documented interim placeholder that P4 replaces. A red baseline makes every
  later validation ambiguous.

**P1 — Fixtures must be generated by the scorer, not hand-written.**
`packages/core/fixtures/incidents/exchange-hack.json` declares `score: 88`, but
running its own evidence through `combineWeights` yields **81**. The fixtures
and the code disagree. Also, that fixture's highest-weight corroborator is a
`news-signal` evidence item, and `scoreOutflows` cannot emit that kind at all —
so the flagship demo asset contains evidence the real detector cannot produce.
Build a fixture generator (`packages/core/scripts/generate-fixtures.ts` or
similar) that produces every fixture from real `Outflow[]` inputs through the
real scorer, and regenerate all three. Add a test that fails if any committed
fixture's `score` differs from what the scorer computes for its evidence.

**P2 — Wire the news/context retrieval that already exists in the type system.**
`NewsContext` is defined in `packages/gonka/src/prompts.ts`, threaded through
`buildSignalPrompt` and `Verifier.verifySignal(signal, news?)` — and **no caller
ever passes it**. Neither `apps/sentinel/src/pipeline.ts:64` nor
`apps/sentinel/src/replay.ts:63`. Every prompt in existence therefore ends with
"No corroborating public reports were found at detection time," which means the
models are re-rating our own heuristics rather than cross-checking anything
external. Fix it:
- Define a `NewsSource` interface with a fixture-backed implementation (works
  offline, deterministic for replay) and an HTTP implementation behind config.
- Pass context from both the pipeline and replay.
- Make `news-signal` an evidence kind the Watchtower can genuinely emit.
- This is the single change that makes the Gonka track's "analyse against live
  data" claim true rather than aspirational. Treat it as such.

**P3 — Calibrated consensus, per the literature.**
`docs/reference/README.md` already concedes the caveat: unanimity is only sound
if model errors are partially independent and confidence is calibrated, and LLM
verbalized confidence is systematically overconfident. Implement what phase 1
concludes — likely abstention/quorum handling, per-model calibration metadata
recorded on `ModelOpinion`, and explicit treatment of correlated error. **Keep
unanimity as the spending gate and never average scores** (`CLAUDE.md`). Write
`docs/adr/0006-*.md` for whatever you change, in the same house style as
0001–0005: Context, Decision, Consequences (good *and* bad), Alternatives
rejected.

**P4 — Tests where the money is.**
`packages/core` has 15 passing tests and `packages/gonka` has 8, both covering
pure logic that cannot lose money. `packages/hedge` — safety policy, sizing, and
the hand-maintained SDK cast — has **zero**. Invert that:
- A fake `ThetanutsSurface` so the execution layer is testable without a chain
  (this is already a follow-up item in ADR-0004).
- `SafetyPolicy`: every rejection code, the mode gate, lifetime budget
  accumulation, and specifically a test named so that
  `pnpm --filter @aegis/hedge exec vitest run -t 'never permits selling'`
  matches it.
- `sizeProtectivePut`: budget is never exceeded, the live-quote guard throws,
  zero-payout rows appear where the strike isn't breached, multiples are honest.
- `HedgeRouter`: OptionBook decline falls through to RFQ; a `SafetyRejection`
  is terminal and does **not** retry the other venue.
- Decimal round-trips: USDC 6dp, prices/strikes 8dp, `numContracts` 18dp.

**P5 — The live chain feed.**
`apps/sentinel/src/index.ts` currently logs "Live watchtower not yet wired" and
exits. Implement `eth_getLogs` polling as assessed in the `TODO(day 3)` block in
`watchtower.ts` (option 2 — it's recommended there for good reasons). Replace
`WATCHED_SUBJECTS` with the real addresses and defensible baselines from 2d.
Without a `BASE_RPC_URL`, build it against recorded log fixtures and make the
transport swappable so it runs live the moment a URL exists.

**P6 — The public surface.**
- Rate-limit `POST /api/verify` **before** anything else here. It is an
  unmetered LLM endpoint on our key with a `TODO(day 6)` where the limiter
  should be, and the Gonka track requires it be publicly reachable.
- Make `/verify` interactive: submit a claim, render each model's score and
  reasoning, and every request ID as a clickable receipt link.
- Make the dashboard render real `IncidentRecord`s: verdict, request IDs as
  links, reasoning traces, honest payout projections including zero rows,
  `simulated` badges, and rejections shown alongside hedges rather than hidden.
- Components from `vendor/repos/react-bits/src/ts-tailwind/` only. One WebGL
  background per page maximum. Nothing animated behind live data. Add any new
  peer dep to the pnpm catalog, pinned.

**P7 — Live-path preparation (no execution).**
A `dry-run` rehearsal harness, and `docs/product/live-trade-checklist.md`: the
exact ordered steps, env vars, approvals, and failure modes for the operator to
run the real mainnet trade awake. Include what to do when the OptionBook has no
matching order and when no market maker bids — both are counterparty behaviours
invisible in dry-run, and both are on the critical path for the Thetanuts bar.

**If the backlog empties**, do not stop. Move to hardening: more test coverage,
error-path tests, `docs/hackathon/04-submission-requirements.md` checklist
accuracy, README quality (the Gonka track requires Gonka Router documentation in
it), accessibility, `prefers-reduced-motion`, bundle size, and a pass over every
`TODO(day N)` still in the source.

---

## 4. The validation gate

Run **all** of these. Every one passes before you commit and push:

```bash
pnpm install                          # if deps changed
pnpm typecheck                        # tsc --build --force, all projects
pnpm --filter @aegis/web typecheck    # web is NOT in the root build
pnpm lint                             # biome check .
pnpm test                             # every package
pnpm --filter @aegis/web build
pnpm replay                           # all fixtures, against the fake client
```

Rules for the gate:
- Fix **every** error and every warning you introduced. "Pre-existing" is not an
  excuse if you can fix it cheaply; note it in the log if you can't.
- `biome.json` is **strict JSON**. A `//` comment silently invalidates it and
  Biome reformats the entire repo to its defaults. If you need comments, rename
  to `biome.jsonc`.
- Adding a subpath export to `@aegis/core` requires editing its `exports` map —
  typechecking will not catch a missing one; it fails at runtime with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`.
- Versions are pinned in the pnpm catalog in `pnpm-workspace.yaml`, never in an
  individual `package.json`.
- If validation fails, that is the work. Fix it, re-run the whole gate, repeat
  until green. Do not move to the next backlog item with a red gate.

---

## 5. Docs, commits, and pushing

**Docs are not a follow-up task.** Update them in the *same commit* as the code:
- `CLAUDE.md` when a rule, command, or gotcha changes.
- A new `docs/adr/000N-*.md` for every structural decision, matching the
  existing house style — including an honest "Consequences → Bad" section and
  "Alternatives rejected". The existing ADRs are the quality bar; match it.
- `docs/reference/README.md` if you add papers or repos.
- `docs/hackathon/04-submission-requirements.md` checklist boxes, kept truthful.
- The `README.md` must document the Gonka Router integration — it's a named
  deliverable for that track.

**Commits.** Small and coherent. Imperative subject line. Body explains *why*,
not what. End every commit message with:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**Push to `main` after every item that passes the gate.** Not once at the end.
The operator wants to wake up to incremental, pushed progress. If a push is
rejected, pull/rebase and retry — never force.

**Keep a log at `docs/overnight-log.md`**, committed and pushed with each cycle.
One entry per cycle, appended, never rewritten:

```
## <ISO timestamp> — <item>
Did: ...
Decisions made without the operator: ... (and the reasoning)
Validation: <pass/fail, which commands>
Blocked: ... (if anything, with exact steps for the human)
Next: ...
```

---

## 6. Keeping going

- **You do not stop to ask questions.** After the one message in section 0, the
  operator is unreachable. Ambiguity resolves to: pick the option most
  consistent with `CLAUDE.md`, the lowest-risk one where money or track
  requirements are involved, write down why, continue.
- **Timebox.** No more than ~90 minutes on a single item. If it isn't
  converging, park it with detailed notes in the log, move to the next item, and
  come back later with fresh context.
- **Blocked by something only a human can supply** (funds, a secret, an account,
  a decision with real-money consequences)? Mark it `BLOCKED-EXTERNAL` in the
  log with the exact steps for the operator, then move on immediately. Never
  wait. Never work around it by doing something you were told not to do.
- **A failing test is work, not a blocker.** So is a type error, a lint error,
  and a broken build.
- **Do not narrate at length or ask for approval.** Work, validate, commit,
  push, log, next.

---

## 7. Stop conditions

Stop only when one of these is true:
1. Every backlog item **and** the hardening list are done, validated, and
   pushed.
2. You hit a hard external limit (rate limit, exhausted context, no network) and
   have logged and pushed all work in progress.
3. Continuing would require violating a rule in section 1.

**Do not stop because the backlog item you're on is hard, because you've been
running a long time, or because it feels like a natural pause.**

---

## 8. Final report

When you stop, leave a summary as your last message and append it to
`docs/overnight-log.md`:

- What landed, with commit SHAs, and the pushed branch.
- The research findings that changed the implementation, and which changed
  nothing (and why).
- **What is blocked on the operator**, with exact steps — especially the real
  Base mainnet trade, which is the binary bar for the Thetanuts track and is
  still unmet.
- Anything you decided on the operator's behalf that they might want to reverse.
- The honest state of the validation gate at the moment you stopped.

Be accurate. If something is half-done, say it is half-done. A truthful report
of partial progress is worth more than a confident one that isn't true.
