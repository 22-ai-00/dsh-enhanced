# DSH plugin/tool agent self-iteration: research note

Research date: 2026-09-19. Scope: improve this repository as a **self-iterating DSH plugin/tool agent**. Model providers are replaceable suppliers; this is not a proposal to train model weights, build a provider benchmark, or claim unrestricted autonomous RSI.

## Source status and primary-source check

The requested [WeChat article](https://mp.weixin.qq.com/s/3Qg8E9eoPX2rfYepvPSJ3w), by PaperAgent (2026-09-19), was retrieved through Sensight. Its discussion combines Anthropic's measurements, an RSI survey, and program-search examples. We checked the underlying sources before drawing project recommendations:

* [Anthropic's measurement post](https://www.anthropic.com/institute/measuring-pace-of-ai-development) reports AI-led work but no fully autonomous measured R&D subset. Its index uses a frozen task basket and an independent model judge; ratings remain contestable. The appendix describes agent identities that persist across model upgrades and communication linked to original evidence and transcripts. Monitoring covers both pre-action intervention and retrospective review, measured by coverage, review latency, and escalation rate. These are self-reported internal measurements, not independently reproduced results here; a low interception rate alone cannot establish safety.
* The [RSI survey, v2](https://arxiv.org/abs/2607.07663v2) surveys 1,250 papers, distinguishes bounded refinement from open-ended improvement, and proposes a verification hierarchy. This is a survey argument, not proof of unrestricted RSI or a universal ordering of every project's results.
* Google DeepMind's [FunSearch post](https://deepmind.google/blog/funsearch-making-new-discoveries-in-mathematical-sciences-using-large-language-models/) describes proposed programs being evaluated and successful programs informing later proposals. Its [AlphaEvolve post](https://deepmind.google/blog/alphaevolve-a-gemini-powered-coding-agent-for-designing-advanced-algorithms/) likewise connects program search with automated evaluation. Our inference: use independently executable acceptance wherever the task permits it.

## Lessons to apply here

The following are project design recommendations, not claims that the sources prescribe DSH architecture or that these capabilities are already complete:

1. **Separate durable agent identity from supplier identity.** Keep owner lineage, goal history, acquired capability versions, and evidence attached to the agent across provider changes. A provider swap should neither erase experience nor be counted as agent learning. Freeze the supplier contract within each run for reproducibility.
2. **Accumulate reusable capability from real work.** A verified failure or repeated success should inform a candidate skill, tool, workflow, or plugin. Complete the loop through independent acceptance, bounded use, observation, and rollback, then demonstrate benefit on later tasks.
3. **Protect the measuring instrument.** Candidate code must not rewrite its acceptance rules, held-out tasks, or trust roots. Model critique can suggest improvements; outcome receipts establish whether the intended task succeeded. Keep task baskets versioned and compare at equal supplier and budget so a changing workload does not masquerade as improvement.
4. **Make collaboration inspectable.** Reuse existing history and receipt stores to link agent/run identities, capability versions, peer claims, and original source evidence. Do not replace original evidence with chains of agent summaries or introduce a parallel messaging/history platform.
5. **Observe the whole lifecycle.** Connect existing Policy/Actions admission checks to post-run Verifier/Evaluation/Recovery observations. Track monitoring coverage, review latency, and unresolved escalations alongside task quality. Long checks belong in durable Host execution with cancellation, leases, and restart reconciliation; increasing a model's authority lifetime is not a substitute.

## What already maps well to DSH

The repository has much of the correct bounded-loop substrate already; it should be connected and proved before adding a new general "RSI" abstraction.

| Needed loop element | Existing project evidence | Interpretation |
| --- | --- | --- |
| Persistent goal ownership and execution records | [architecture](architecture.md#持续目标上下文); [Goals README](../plugins/assistant-goals/README.md#整体目标验收) | Goals preserves owner lineage, definition/revision, budget and wake identity. Native completion is deliberately not trusted achievement. |
| Independent acceptance and feedback | [Verifier README](../plugins/assistant-verifier/README.md#验收配置); [Goals README](../plugins/assistant-goals/README.md#整体目标验收) | Exact contracts and independent receipts can drive the next step; execution success alone must not. |
| Reusable capability deposits | [Growth Driver](../plugins/assistant-growth-driver/README.md); [Skills](../plugins/assistant-skills/README.md); [Evolution](../plugins/assistant-evolution/README.md#闭环) | Verified repeated workflows can become paused skills; evaluation-backed guidance remains owner-approved and retractable. |
| Bounded source/plugin changes | [Growth Driver source lane](../plugins/assistant-growth-driver/src/growth-agent.ts); [Control Plane](../plugins/plugin-control-plane/README.md) | The agent may only prepare a pending plan in an isolated worktree. It cannot approve, sign, publish, activate, install, or reload it. |
| Controlled rollout and recovery | [current status WP14–WP16](rsi-status.md); [Recovery](../plugins/assistant-recovery/README.md) | Candidate comparison/canary/watch infrastructure exists; WP16's complete authorized remote release/activation chain and WP18's full repository loop remain incomplete. |
| Correct Cordis ownership model | [architecture](architecture.md) and root [AGENTS.md](../AGENTS.md) | Bundle metadata and `inject` belong on the mounted value; effects, timers, agents, leases, and disposers belong to the owning Fiber. Provider replacement and unload are lifecycle events, not exceptional cases. |

The matrix's own evidence boundary matters: local tests, fixtures, a dry-run pack, and a limited real-model run do not establish production autonomy. WP16 now has npm and systemd adapter components, but lacks the complete authorized publish/enable/monitor/rollback evidence chain; WP18 still lacks complete authorized real-repository reuse evidence.

## Keep supplier changes separate from agent learning

The current growth driver intentionally pins `super-relay` / `auto_model/alwaysday1`: see [config.ts](../plugins/assistant-growth-driver/src/config.ts) and the preflight in [index.ts](../plugins/assistant-growth-driver/src/index.ts). Keep this route for current real-model acceptance runs. Its global hard-coding is a future decoupling target: supplier choice should become deployment configuration while run identity and accumulated capabilities remain stable.

Evolve the hard-coded route toward an **owner-configured supplier contract selected before each run and frozen into that run's immutable contract**, reusing native DSH provider routing. Add an adapter only where the existing provider interface lacks a required contract. The supplier contract must expose a capability identity, route/model revision, budget-meter identity, limits, and credential reference; it must not expose a generic raw token to the agent. The Growth Driver should select only from an administrator/owner allowlist, persist the selected contract plus digest before first provider dispatch, and reject provider/model/meter/configuration generation drift during `llm/stream`. Existing tool digest, deadline, cancellation, budget reservation, and post-run evidence checks stay mandatory. A provider removal or reload cancels/settles the run as `unknown` or failed according to the existing ledger semantics; it must never silently fall back to another supplier.

This is supplier interchangeability with reproducibility. It does **not** make model selection an agent tool, and it does not weaken per-run freeze merely to make route switching convenient.

## Prioritized changes

### 1. Finish the production plugin lifecycle before expanding self-modification

First finish reproducible isolated checks and durable Host execution for the existing pending source-plan flow. Then implement one explicitly authorized Control Plane production adapter (WP16). The adapter should accept an immutable package/version/digest plan, build and sign outside the candidate's authority, publish to a named registry, verify the fetched artifact, activate a finite canary, observe independent quality evidence, and close the exact version on regression or retraction.

Acceptance: a controlled external environment demonstrates `prepare → owner approval → immutable build/sign → publish → fetched-artifact verification → finite enablement → independent watch → close/rollback`; a candidate cannot read or alter the signing root or holdout; unknown post-submit state is reconciled rather than retried as a new action.

### 2. Decouple Growth Driver model supplier without weakening its frozen-run gates

Expose the supplier contract above through existing DSH routing, initially retaining the current Super Relay route; add a narrow adapter only if required. Keep route choice out of model-visible tools. Place deployment-specific adapter configuration in validated Config, use live Cordis injection for the selected provider (owned nested injection if optional), and own any subscription/timer through the driver's Fiber.

Acceptance: two approved supplier configurations can run equivalent bounded wakes; every run records one immutable route/meter/limit digest; provider replacement/removal before dispatch prevents dispatch, and after dispatch produces an explicit non-success terminal state with no fallback; the existing Super Relay behavior remains covered as one adapter fixture.

### 3. Use verifier strength to determine what may iterate automatically

Create a small capability classification in existing Skills/Control Plane records: `deterministic`, `external-readback`, `owner-judgment`, or `unknown`, each with exact verifier/receipt references and freshness. Only the first two may enter comparison, finite canary, or low-risk automatic rollback. `owner-judgment` may generate a pending proposal and remain advisory. `unknown` must not count as a success episode.

Acceptance: tests show an LLM self-rating and a successful tool exit cannot promote a skill/plugin; an exact Verifier or repository-readback receipt can; stale/retracted evidence closes the deployment or prevents promotion. Reuse Evaluation/Verifier canonical projections rather than creating a second success ledger.

### 4. Close one real repository-maintenance vertical slice (WP18)

Use the existing Goal, Event Trigger, Isolation, Verifier, Actions, Skills, and Recovery bundles for one narrowly authorized repository. Start with a bounded event class and branch scope. Associate each event with an existing owner goal, work in isolation, require CI/readback receipt, then deposit a reusable skill only after repeated independently verified results.

Acceptance: the same evidence chain includes event dedupe, owner/goal binding, budget and lease, isolated change, immutable commit identity (plus PR identity when that workflow uses one), exact CI/readback, `unknown` reconciliation, stop/revocation, and a later same-budget reuse comparison. Do not call a single successful task a general improvement result.

### 5. Make learning measurable across distinct task families

WP13 still needs 3–5 real high-frequency workflow families; WP06 has not demonstrated strategy benefit. Gather owner-authorized examples with a fixed task definition, input snapshot, supplier contract, agent identity, tools/skill versions, acceptance contract, cost/latency, and outcome. Reserve new tasks before candidate generation and compare baseline/candidate at the same budget.

Acceptance: promotion needs an independent quality pass, no critical regressions, and predeclared improvement threshold on a holdout; all three are recorded per candidate version. A neutral or negative result is retained as evidence and does not promote.

## Decisions to preserve

* Do not create another AgentLoop, goal state machine, generic vector memory system, or a model-training pipeline. DSH's existing loop plus durable goal, evaluator, skill, and control-plane boundaries are the core.
* Keep user-installable capabilities as independent bundles with a stable patch row. Shared supplier contracts belong in `packages/*` only if more than one bundle genuinely consumes them.
* Respect existing owner authorization; obtain approval when extending authority, crossing a configured release gate, or changing a trust root. Do not re-prompt for already authorized routine actions. Automatic recovery may close a proven-bad exact version; it must not invent a replacement.
* Treat model output, tool text, and candidate source as untrusted data. Cordis injection/lifecycle correctness is required for reload and provider replacement, but it is not an OS or credential isolation boundary.

## Maintainer guidance

The concise principles are recorded in root [AGENTS.md](../AGENTS.md#self-iteration-principles). This note contains the rationale and proposed acceptance criteria; it does not authorize a deployment or declare the proposed work complete.

## Evidence limits

This note is architectural research, not evidence of a deployed agent. Anthropic's internal measurements are not independently reproducible here. The RSI survey is not a proof of open-ended improvement. Repository documentation and tests demonstrate specified local behavior; they do not prove real provider behavior, operating-system isolation, production credentials, or long-term task improvement. Those claims require the bounded external acceptance runs above.
