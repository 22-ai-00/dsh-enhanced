# Assistant Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `@dsh-enhanced/assistant-policy` as the fail-closed authorization, hard-budget, durable decision, and audit boundary used by every later assistant plugin.

**Architecture:** A pure deterministic evaluator compiles validated ordered rules and evaluates a complete typed subject/action/resource/context request. A Cordis service owns all authorization entry points, SQLite persistence, budget reservation/finalization, emergency stop, delayed approval proposals, and audit. A DSH tools guard delegates tool execution to the same service; consumers cannot supply trusted policy attributes themselves.

**Tech Stack:** TypeScript, Cordis, Schemastery, DSH rc.8 tools/agent/session types, Node `node:sqlite`, Vitest.

## Global Constraints

- Default decision is deny; incomplete subject, workspace, or background initiator context never widens access.
- Ordered deny rules override allows. Emergency stop and exhausted hard budgets override every configurable allow.
- Policy derives trusted agent/session/workspace/tool identity from host objects; caller metadata is untrusted context only.
- SQLite uses WAL, busy timeout, forward-only schema migration, restrictive directory/file modes, transactions, and versioned rows.
- Audit records redact arguments/secrets and use hashes/structured reason codes rather than raw sensitive content.
- Delayed approval is proposal-only until an authenticated principal decides it; DSH open-turn approval remains a separate adapter path.

---

### Task 1: Scaffold the independently publishable bundle

**Files:**
- Create: `plugins/assistant-policy/package.json`
- Create: `plugins/assistant-policy/cordis.patch.yml`
- Create: `plugins/assistant-policy/README.md`
- Create: `plugins/assistant-policy/LICENSE`
- Create: `plugins/assistant-policy/tsconfig.json`
- Create: `plugins/assistant-policy/tsconfig.build.json`
- Create: `plugins/assistant-policy/src/version.ts`
- Modify: `plugins/README.md`

- [x] Run `pnpm create:plugin assistant-policy`.
- [x] Replace generated README placeholders with configuration, examples, data retention, and explicit authority declarations.
- [x] Add Schemastery as a runtime dependency and DSH tools/agent/session/user-approval as optional peers plus cataloged dev dependencies.
- [x] Run `pnpm run validate` and inspect the package manifest/patch/catalog row.

### Task 2: Define and test the deterministic policy model

**Files:**
- Create: `plugins/assistant-policy/tests/evaluator.spec.ts`
- Create: `plugins/assistant-policy/src/types.ts`
- Create: `plugins/assistant-policy/src/evaluator.ts`

- [x] Write tests for exact subject/action/resource matching, wildcard matching, deny precedence, condition matching, stable reason codes, and default deny.
- [x] Run `pnpm --filter @dsh-enhanced/assistant-policy test -- evaluator.spec.ts` and observe module/export failures.
- [x] Implement immutable public types: `PolicySubject`, `PolicyResource`, `PolicyContext`, `PolicyRequest`, `PolicyRule`, `PolicyDecision`, and `DecisionReasonCode`.
- [x] Implement `compilePolicy(rules)` and `evaluatePolicy(compiled, request)` with deterministic specificity/order rules and no I/O.
- [x] Run the focused tests to green and refactor without changing behavior.

### Task 3: Implement hard budgets and emergency stop

**Files:**
- Create: `plugins/assistant-policy/tests/ledger.spec.ts`
- Create: `plugins/assistant-policy/src/ledger.ts`
- Create: `plugins/assistant-policy/src/sqlite.ts`

- [x] Write real temporary-database tests for migration, atomic budget reservation, concurrent overspend prevention, idempotent reservation keys, finalize/release, period rollover, and emergency-stop persistence.
- [x] Run the focused test and observe missing implementation failures.
- [x] Implement a restricted SQLite connection helper and schema for `meta`, `budgets`, `reservations`, `emergency_state`, `approval_proposals`, and `audit_events`.
- [x] Implement `PolicyLedger.reserve`, `finalize`, `release`, `setEmergencyStop`, and `getEmergencyStop` as short transactions with stable error codes.
- [x] Run the focused tests to green, including a two-connection contention case.

### Task 4: Implement approval proposals and sanitized audit

**Files:**
- Create: `plugins/assistant-policy/tests/approval-audit.spec.ts`
- Modify: `plugins/assistant-policy/src/ledger.ts`
- Create: `plugins/assistant-policy/src/redaction.ts`

- [x] Write tests for proposal creation, expiry, authenticated decision, CAS/idempotent replay, wrong-principal denial, complete diff hash retention, argument redaction, and append-only audit querying.
- [x] Run the focused test and observe failures for absent proposal/audit behavior.
- [x] Implement proposal/decision transactions and structured sanitized audit events.
- [x] Run the focused tests to green.

### Task 5: Expose the Cordis service and DSH tool guard

**Files:**
- Create: `plugins/assistant-policy/tests/service.spec.ts`
- Create: `plugins/assistant-policy/tests/tool-guard.spec.ts`
- Create: `plugins/assistant-policy/src/service.ts`
- Replace: `plugins/assistant-policy/src/index.ts`

- [x] Write service tests for config validation, lifecycle disposal, fail-closed identity derivation, evaluation + budget reservation, proposal APIs, audit APIs, and emergency stop.
- [x] Write tool-guard tests using the complete rc.8 `ToolExecution` shape; prove missing agent/session/workspace denies and configured rules allow only the intended tool.
- [x] Run focused tests and observe missing service/guard failures.
- [x] Implement `AssistantPolicyService` and module augmentation as `ctx.assistantPolicy` with `evaluate`, `authorize`, `reserve`, `finalize`, `release`, `propose`, `decideProposal`, `setEmergencyStop`, and bounded `queryAudit` methods.
- [x] Implement `apply(ctx, config)` with Schemastery schema, injected tools service, guard disposer, SQLite disposer, and no leaked timers/handles.
- [x] Run focused tests to green.

### Task 6: Package, compatibility, and acceptance

**Files:**
- Modify: `plugins/assistant-policy/README.md`
- Modify: `plugins/README.md`

- [x] Add acceptance tests for database path containment/permissions, malformed rules/config, audit bounds, expired proposal cleanup, and restart recovery.
- [x] Run `pnpm --filter @dsh-enhanced/assistant-policy run typecheck`.
- [x] Run `pnpm --filter @dsh-enhanced/assistant-policy run build`.
- [x] Run `pnpm --filter @dsh-enhanced/assistant-policy pack --dry-run` and inspect that only `lib`, patch, README, LICENSE, and package metadata ship.
- [x] Run `pnpm check` before marking the package stable enough for core consumers.
