# Assistant Automations Implementation Plan

> **Execution rule:** Follow strict TDD. Every behavior item starts with a focused failing test, records the intended RED, then receives only the production code needed for GREEN.

**Goal:** Implement `@dsh-enhanced/assistant-automations` as the cold-start, single-host durable scheduler and isolated Agent runner for the personal-assistant suite.

**Architecture:** SQLite is the runtime authority for immutable automation snapshots, stable occurrences, tasks, attempts, runs, and the singleton duty-owner lease. Pure schedule code computes UTC instants from `at`, anchored `every`, and five-field cron/IANA timezone definitions. A coordinator first materializes stable occurrence IDs, then claims tasks under a global fencing token, and only then invokes a replaceable runner. The DSH runner creates a fresh persisted rc.8 root Agent, applies a hard tool allowlist plus a background policy binding, drives one prompt, flushes its Session, writes a private bounded run artifact, and disposes the live handle. Execution state never implies delivery state.

**Tech Stack:** TypeScript, Cordis, Schemastery, DSH rc.8 agent/LLM/session/tools services, `assistant-policy`, Node `Intl`, `node:sqlite`, Vitest.

## Global Constraints

- This is a single-host scheduler. SQLite connections may compete across processes, but shared-network-filesystem or distributed consensus is out of scope.
- Do not use the official session-local schedule service as a daemon. Timers only wake the coordinator; SQLite `nextRunAt`, occurrence uniqueness, leases, and fencing are authoritative after restart.
- Stable `occurrenceId = sha256(automationId + trigger kind + scheduledAt/externalEventId)`. Persist occurrence before task claim.
- Never claim exactly-once external side effects. A crash after an Agent may have used a tool but before the run commits becomes `unknown` unless the immutable definition explicitly opted into idempotent retry.
- Fresh Agents carry an immutable workspace, preset identity, provider/model, timeout, output-token cap, tool-call cap, and tool allowlist snapshot. Background policy can only further deny.
- Run artifact persistence precedes optional delivery enqueue. Delivery failure or absence never changes a successful execution into a failed execution.
- No shell command construction, broad environment inheritance, browser, event sensors, heartbeat, DAG, or second scheduler database in P0.

---

### Task 1: Scaffold and package contract

- [x] Run `pnpm create:plugin assistant-automations`; add the package, stable Cordis row, catalog entry, LICENSE, and rc.8 peers for Cordis/agent/LLM/session/tools plus `assistant-policy`.
- [x] Configure private `state.sqlite` and `runs` paths, conservative tick/lease/concurrency/artifact/catch-up limits, and disabled-by-default background execution until policy explicitly allows it.
- [x] Document single-host semantics, required supervisor, full authority surface, execution-vs-delivery split, crash ambiguity, install order, configuration, and non-goals.

### Task 2: Schedule parser and deterministic occurrence planning

- [x] Write failing tests for canonical `at`, anchored fixed intervals without drift, and strict five-field cron grammar (`*`, list, range, step).
- [x] Write failing IANA timezone tests for DST spring gaps, fall overlaps, leap day, timezone changes, and invalid zones/fields.
- [x] Implement pure `nextOccurrence`/`dueOccurrences` functions with UTC millisecond output, standard DOM/DOW semantics, explicit scan bounds, and no ambient timer/state access.
- [x] Write failing misfire tests for `skip`, `latest`, and bounded replay plus a grace window; cap all catch-up work and advance the durable cursor beyond `now` atomically.

### Task 3: Hardened SQLite ledger and immutable definitions

- [x] Write failing tests for absolute paths, `0700` directories, `0600` database, WAL/FULL/busy timeout, forward migration, and future-schema refusal.
- [x] Implement separate strict tables for automation, occurrence, task, attempt, run, and duty lease. Keep output artifact refs and delivery refs separate from execution status.
- [x] Write failing validation/idempotency tests for immutable definition snapshots, stable occurrence IDs, duplicate materialization, pause/resume/delete, external event IDs, and bounded history.
- [x] Implement create/list/get/change/materialize/history APIs with short `BEGIN IMMEDIATE` transactions, optimistic definition versions, canonical JSON, and fixed error codes.

### Task 4: Duty ownership, task state machine, and fencing

- [x] Write failing two-owner tests for acquire/renew/takeover, monotonic fencing tokens, stale claim/heartbeat/commit denial, and expiry at exact boundaries.
- [x] Write failing recovery tests: expired `claimed` safely returns to scheduled; expired `running` becomes `unknown`, or requeues only when `retrySafety=idempotent` and attempts remain.
- [x] Implement short-transaction claim, start, heartbeat, cancel-request, completion, and recovery transitions over `scheduled/claimed/running/succeeded/failed/timed_out/cancelled/lost/unknown` with append-only attempts.
- [x] Write model/state tests for overlap `skip`, `queue-one`, and `cancel-previous`; never let an old fencing token mutate the winner's task or run.

### Task 5: Coordinator, timer lifecycle, and artifacts

- [x] Write failing fake-clock/fake-runner tests for startup catch-up, clock rollback, bounded concurrency, no duplicate occurrence across 100 restarts, transient runner rejection, timeout, cancellation, and clean shutdown.
- [x] Implement a coordinator whose explicit `tick()` renews duty, recovers, materializes, claims, and launches; one Cordis-owned timer only selects the next wake and never owns schedule truth.
- [x] Write failing real-filesystem tests for bounded `0600` JSON artifacts, same-directory fsync+rename, path containment, no partial visibility, and stable idempotent artifact replay.
- [x] Implement artifact-before-run-commit ordering. Preserve a bounded preview in SQLite and keep optional delivery enqueue as a later, separately recorded step with stable key `automation:<occurrenceId>:<bindingId>`.

### Task 6: Approval-gated automation changes and service seam

- [x] Write failing durable proposal tests for exact create/pause/resume/delete snapshots, idempotency, principal/version/TTL binding, rejection, expiry, restart recovery, and changed-definition conflicts.
- [x] Implement all model-initiated mutations through `assistant-policy` proposals. Policy stores only diff hash/summary; the local automation DB stores the exact change. No tool commits a definition directly.
- [x] Write failing lifecycle/config/injection tests and implement `ctx.assistantAutomations`, deriving foreground identity from rc.8 session headers and using explicit `background` subjects for duty/claim authorization.
- [x] Expose service methods for proposal/decision, list/history, safe dry-run, external occurrence ingestion for future event-triggers, start/stop/tick, and cancellation without exposing the store.

### Task 7: Fresh rc.8 Agent runner and bounded tools

- [x] Write failing runner contract tests for deterministic fresh session IDs, immutable provider/model/workspace/preset, background initiator binding, tool visibility/guard allowlist, tool-call cap, timeout/cancel, session flush, outcome parsing, and handle disposal.
- [x] Implement the runner through `ctx.agents.create`, `installModelSelection`, scoped `ctx.tools.restrict` plus a monotonic scoped guard, one plugin-source follow-up, `whenIdle`, Session event summarization, and `ctx.sessions.flush`.
- [x] Reserve configured policy budget before execution and finalize known usage; never release a reservation after ambiguous execution. Dry-run uses the same runner path with an empty tool allowlist and no delivery.
- [x] Add real mock-LLM rc.8 E2E proving a fresh persisted root Agent can use explicitly allowed Memory/Wiki tools while disallowed/global/scoped tools remain denied.

### Task 8: Tools and acceptance

- [x] Write failing ToolRuntime tests for `automation_create`, `automation_list`, `automation_manage`, `automation_run` (safe dry-run), and `automation_history`; avoid official `schedule_*` names and host paths.
- [x] Ensure every output is bounded, every mutation returns a proposal, read tools are side-effect free, and missing Agent/preset/absolute workspace fails closed.
- [x] Run focused tests, zero-warning lint, typecheck, build, and inspect the dry-run package file list.
- [x] Run an isolated real rc.8 `assistant-policy → assistant-automations` profile through `--dump-config` and startup smoke, then run `pnpm check` before marking the master-plan automation item complete.
