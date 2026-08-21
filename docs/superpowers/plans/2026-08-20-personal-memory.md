# Personal Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `@dsh-enhanced/personal-memory` as a bounded, scoped, approval-gated store for short durable facts, preferences, instructions, and experiences, with stable retrieval snapshots and DSH tools.

**Architecture:** The plugin owns one hardened SQLite database and exposes only `ctx.personalMemory`; consumers never receive the store. User-global and absolute-workspace scopes are combined with user/agent ownership and agent preset. Reads are side-effect free. Every add/replace/remove mutation is a durable proposal tied to `assistant-policy`; an approved proposal re-reads its target version and commits with CAS. A session-start listener injects one frozen, token-bounded snapshot, while explicit search remains available through a tool.

**Tech Stack:** TypeScript, Cordis, Schemastery, DSH rc.8 agent/session/tools/LLM message helpers, Node `node:sqlite`, `@dsh-enhanced/assistant-policy`, Vitest.

## Global Constraints

- Store only short stable memory; long research, documents, and project notes belong in `personal-wiki`.
- Missing cwd or agent preset fails closed; no fallback into an accidental shared scope.
- Background callers may propose but never commit without a principal decision.
- Content has hard byte/token/count budgets, stable content hashes, provenance, trust, confidence, sensitivity, TTL, supersession, and version.
- Search/list/snapshot never update recall counters or any other state.
- Every proposal stores an exact mutation payload locally but no secret-bearing raw diff in policy/audit; decisions use principal binding and CAS.
- Injected content is wrapped as untrusted knowledge data, never as instructions from the plugin.

---

### Task 1: Scaffold and package contract

- [x] Run `pnpm create:plugin personal-memory` and add package/patch/catalog metadata.
- [x] Add Schemastery runtime dependency; add Cordis, DSH agent/llm/session/tools, assistant-policy peers and dev dependencies.
- [x] Configure an rc.8 `dshHomePath('personal-memory/memory.sqlite')` default and conservative snapshot/search/memory-size caps.
- [x] Replace README placeholders with scope, approval, retention, permissions, examples, and non-goals.

### Task 2: Schema, identity, and read model

- [x] Write failing real-SQLite tests for migrations, permissions, user-global/workspace × user/agent preset isolation, TTL, tombstones, and future-schema refusal.
- [x] Implement stable public types and a hardened SQLite helper with forward migrations.
- [x] Implement deterministic identity/scope validation using absolute cwd and non-empty preset.
- [x] Implement side-effect-free `get`, `list`, JSON export, and bounded import validation.

### Task 3: Retrieval and frozen snapshots

- [x] Write failing tests for exact phrase, ASCII tokens, CJK unigram/bigram recall, title/kind bonus, confidence/trust ordering, deduplication, and deterministic ties.
- [x] Implement rebuildable token rows and deterministic ranking without external vector services.
- [x] Write failing tests for top-K, byte/token budgets, global+workspace merge, expired exclusion, immutability, and stable session snapshots.
- [x] Implement `search` and `snapshot`; snapshot output must be deep frozen and wrapped as `<memory_source>` data.

### Task 4: Approval-gated CAS mutations

- [x] Write failing tests for add/replace/remove proposal creation, idempotent replay, principal binding, rejection, expiry, target-version CAS, content dedupe, and restart recovery.
- [x] Implement proposal rows and `propose`/`decideProposal` through `ctx.assistantPolicy`, with transactionally applied memory/token/audit rows only after approval.
- [x] Implement JSON import as a bounded proposal batch and export as versioned JSON without internal database fields.
- [x] Prove callers cannot directly commit or access the SQLite handle.

### Task 5: Cordis service and DSH tools/session integration

- [x] Write failing lifecycle/config/service-injection tests and implement `PersonalMemoryService` as `ctx.personalMemory`.
- [x] Write failing tests for `memory_search` and proposal-only `memory_manage`; use complete rc.8 executions and policy authorization.
- [x] Write failing rc.8 `agent/session-start` tests for a single frozen snapshot, missing identity fail-close, no empty injection, and data-not-instruction framing.
- [x] Implement tool registration and session listener with Cordis-owned disposers.

### Task 6: Acceptance

- [x] Run focused tests, typecheck, build, lint, and dry-run pack inspection.
- [x] Run real rc.8 ToolRuntime/Agent integration and isolated profile `--dump-config` smoke.
- [x] Run `pnpm check` and mark the master-plan memory item complete only after the full repository stays green.
