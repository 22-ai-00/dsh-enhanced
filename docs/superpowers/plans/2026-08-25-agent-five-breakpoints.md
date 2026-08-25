# Agent Five-Breakpoint Implementation Plan

> **Execution rule:** preserve the current dirty worktree, make no commits or branch moves, and implement every behavior test-first. A focused test must be observed failing for the intended reason before its production change.

**Goal:** Turn the existing DSH plugin set into a safely deployable, Feishu-connected, proactively scheduled, approval-gated learning agent whose LLM route can be supplied by Codex/TraeX without silently selecting a model that cannot execute the mounted tools.

**Acceptance boundary:** This iteration fixes five concrete integration breakpoints. It does not grant the agent autonomous code/config mutation, remove owner approval, or enable proactive execution for existing installs without an explicit supervised-growth choice.

## 1. Trusted proposal-to-Feishu approval bridge

- [x] Add failing Policy tests for a trusted external-principal binding on an Agent, mismatch rejection, canonical proposal display/diff publication, and idempotent publisher replay.
- [x] Add failing Delivery/Lark tests proving approval intents are derived from the stored Policy proposal and exact session binding, bind the displayed diff hash into the signed callback, reject tampering, and do not duplicate cards.
- [x] Add failing Memory/Wiki/Automations/Evolution tests proving model-supplied principals cannot override a trusted Agent binding and every successfully attached proposal publishes through the production approval bridge.
- [x] Implement the transport-neutral publisher seam in Policy, register it from Delivery, persist one stable approval outbox operation per Policy proposal, and retain headless/manual proposal compatibility.
- [x] Add bounded proposal-expiry maintenance so unclicked cards cannot leave domain queues pending forever.

## 2. Capability-aware Codex/TraeX admission

- [x] Add failing provider/Delivery/Automations tests for explicit route capabilities: coding-subscription routes are text-only, TraeX is tool-capable, and unknown routes fail closed when an Agent mounts tools.
- [x] Implement a small Cordis capability registry owned by the LLM-facing provider boundary; providers register route capabilities with their model registration lifecycle.
- [x] Preflight the resolved route only after the Agent preset and scoped tools are mounted. Reject a tool-bearing turn or automation before auth/CLI/network execution when the route is text-only or undeclared.
- [x] Preserve text-only use of Codex routes and tool-bearing use of TraeX; surface a stable actionable error rather than silently dropping schemas or falling through.

## 3. Trustworthy, scoped Evolution evaluation

- [x] Add failing Evolution tests for workspace/preset/principal isolation, no immediate retire from pre-adoption failures, post-adoption attribution, replay conflicts including rule/time, and retire-then-readopt without primary-key collision.
- [x] Extend the durable schema and migration with a canonical scope and evidence attribution. Derive automated outcome scope/rule identity from the executing binding/run rather than model input.
- [x] Split adoption baseline from post-adoption observation windows, require `minSample` fresh attributed episodes before retirement, and generate unique immutable rule IDs.
- [x] Filter guidance by trusted Agent scope and make session guidance injection idempotent across resumed durable sessions.
- [x] Keep both adopt and retire owner-approved; no rule directly mutates code, credentials, policy, or deployment configuration.

## 4. Unattended execution reliability

- [x] Add failing Delivery tests for lease renewal during long Agent/send operations, stale-fence protection, unsupported `unknown_after_send` remaining parked, manual recovery after exhausted attempts, and prompt Lark acceptance after provider send.
- [x] Implement inbox/outbox lease heartbeats and capability-aware unknown reconciliation without consuming retry budget for unsupported adapters. Make operator retry recoverable without reusing stale fencing tokens.
- [x] Add failing Automations tests proving background Agents resolve/mount their configured preset before tool validation and preserve exact scoped tool allowlists.
- [x] Add failing Event tests proving production HTTP sensors use DNS-pinned HTTPS and persisted event outbox rows continue flushing when sensor polling is disabled.
- [x] Implement durable/out-of-band Evolution outcome delivery so a successful automation state transition cannot silently lose learning evidence.

## 5. Explicit supervised-growth deployment mode

- [x] Add failing installer/profile tests for `standard` versus `supervised-growth`; standard remains behaviorally unchanged.
- [x] Include the Evolution bundle in the installable package set while enabling proactive schedules only after the user explicitly selects supervised growth.
- [x] Generate bounded exact Policy rules, budgets, provider/model selection, heartbeat/review automation, and a confirmation guard for profiles that may already contain approved jobs.
- [x] Update install/plugin documentation with the real safety boundary: Codex text-only routes cannot run tool-bearing presets; TraeX/tool-capable routes can; growth remains evidence-based guidance under owner approval.

## 6. End-to-end proof and final review

- [x] Add a real-component root test for Feishu inbound → Agent tool proposal → approval card → signed callback → restart/reconcile → automation execution → budget charge → Evolution evidence → second approval → scoped guidance on the next session.
- [x] Add a real-component root test proving a tool-bearing Delivery turn on a Codex text-only route is rejected before adapter auth or subprocess execution.
- [x] Run focused package suites after each breakpoint, then lint/typecheck/build/dry-run pack and `pnpm check` from the repository root.
- [x] Perform a requirements review and a separate code-quality/security review; resolve all high/medium findings before declaring completion.

## Verification commands

```sh
pnpm exec vitest run tests/personal-assistant-e2e.spec.ts tests/messaging-approval.spec.ts
pnpm --filter @dsh-enhanced/assistant-policy exec vitest run
pnpm --filter @dsh-enhanced/assistant-delivery exec vitest run
pnpm --filter @dsh-enhanced/lark-channel exec vitest run
pnpm --filter @dsh-enhanced/coding-subscription-provider exec vitest run
pnpm --filter @dsh-enhanced/traex-acp-provider exec vitest run
pnpm --filter @dsh-enhanced/assistant-automations exec vitest run
pnpm --filter @dsh-enhanced/assistant-evolution exec vitest run
pnpm --filter @dsh-enhanced/event-triggers exec vitest run
pnpm check
```
