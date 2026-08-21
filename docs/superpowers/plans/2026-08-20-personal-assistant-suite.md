# Personal Assistant Plugin Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reliable, independently publishable DSH personal-assistant suite: four universal core plugins, a separate Lark messaging slice, guarded credential access, a core-only meta-bundle, and four P1 capability plugins.

**Architecture:** Every user-installable capability is a self-contained bundle under `plugins/*`. Cross-plugin calls use typed Cordis services and never direct database/file access. SQLite-backed plugins own separate databases; `personal-wiki` owns a Markdown vault plus rebuildable indexes. Host DSH rc.8 remains the source of agent, session, tool, approval, workflow, job, and sandbox primitives.

**Tech Stack:** TypeScript 6, Node.js 22/24 (`node:sqlite`), Cordis 4.0.1, Schemastery 3.18.1, Vitest 4, DSH 0.1.0-rc.8, pnpm 11.

## Global Constraints

- Preserve independent package publication and DSH patch composition.
- Write every behavior test before its production implementation and observe the intended RED failure.
- Use real SQLite/filesystem behavior in tests; mock only provider/network boundaries.
- Treat community repositories only as design references; do not add them as dependencies.
- Fail closed when agent, workspace, principal, credential, or route identity is absent.
- Put write authorization, CAS checks, budgets, and audit at service boundaries so consumers cannot bypass them.
- Document filesystem, network, subprocess, credentials, browser, and install-script authority in every README.
- Finish each package with focused tests, typecheck, build, dry-run pack inspection, then finish the suite with `pnpm check` and rc.8 profile smoke tests.

---

## Phase 0: Compatibility Baseline

- [x] Add `tests/dsh-compatibility.spec.ts` asserting all cataloged DSH packages are `0.1.0-rc.8`, all DSH peers start at rc.8, and `docs/compatibility.md` records commit `141eb6fef83422698aef7a981029e843e8161534`.
- [x] Run the focused test and observe it fail against rc.6.
- [x] Update `pnpm-workspace.yaml`, affected peer ranges, compatibility prose, and `pnpm-lock.yaml` without altering unrelated user changes.
- [x] Run the focused test, root validation, existing plugin tests, typecheck, and build.
- [x] Verify representative bundle patches with the rc.8 CLI/profile composition surface.

## Phase 1: Four Universal Core Plugins

- [x] Execute [Assistant Policy detailed plan](./2026-08-20-assistant-policy.md).
- [x] Write and execute `2026-08-20-personal-memory.md`: scoped SQLite memory, frozen retrieval snapshots, proposal/approval/CAS mutation, budgets, import/export, audit, and service conformance.
- [x] Write and execute `2026-08-20-personal-wiki.md`: safe Markdown truth store, stable identifiers, BM25 CJK search, bounded read/upsert/lint, path containment, atomic write, proposal/approval, and rebuildable index.
- [x] Write and execute `2026-08-21-assistant-automations.md`: persistent schedules, occurrence/task/run ledger, leases/fencing, misfire/overlap/timezone handling, recovery, and agent wake isolation.
- [x] Run cross-core tests proving consumers use only `ctx.assistantPolicy`, `ctx.personalMemory`, `ctx.personalWiki`, and `ctx.assistantAutomations` service seams.

## Phase 2: Messaging and Credentials

- [x] Write and execute `2026-08-21-assistant-delivery.md`: typed identity/session binding, durable inbox/outbox, idempotency, receipts, retry/DLQ, pairing, attachment metadata quarantine, and unknown-after-send reconciliation.
- [x] Write and execute `2026-08-21-lark-channel.md`: Lark event normalization, reconnect-gap reporting, text/Markdown/typed approval cards, approval correlation, and all routing/durability delegated to `assistant-delivery`; binary transfer/edit and replay cursor remain deferred.
- [x] Write and execute `2026-08-21-credentials-keychain.md`: allowlisted secret handles, OS-backed storage providers, no plaintext tool output, scoped lease/revocation, audit, and bounded subprocess execution without broad environment inheritance.
- [x] Run targeted crash-window, duplicate-event, unknown-send, cross-account/thread, pairing replay, secret-redaction, credential-revocation, and Lark lifecycle integration tests.

## Phase 3: Core Meta-Bundle

- [x] Add `plugins/personal-assistant` only after the four core package gates pass.
- [x] Make its patch compose exactly the four core packages with conservative defaults and no Lark, delivery, credentials, or P1 dependencies.
- [x] Test patch contents and `--dump-config`, update the catalog/README, and inspect the dry-run package.

## Phase 4: P1 Plugins

- [x] Write and execute `2026-08-21-assistant-heartbeat.md`: reconcile per-agent desired state into system-owned automation rows, active hours, busy coalescing, scratch CAS, no-op suppression, and cost hard stop.
- [x] Write and execute `2026-08-21-event-triggers.md`: file/HTTP/HMAC webhook sensors, baseline/edge/debounce/cooldown/TTL/event-id dedup, SSRF/redirect/body fences, and no arbitrary shell sensor.
- [x] Write and execute `2026-08-21-memory-wiki-bridge.md`: memory-to-Wiki and Wiki-to-memory proposals with stable provenance and idempotency; no third truth store or direct storage access.
- [x] Write and execute `2026-08-21-assistant-health.md`: bounded health/audit/redaction reporting through services, without exposing secrets or raw private content.

## Phase 5: System Verification and Release Readiness

- [x] Run package-level tests with targeted transaction, lease, restart, duplicate, and provider-ambiguity boundaries represented in package tests.
- [x] Run real DSH rc.8 E2E profiles for core-only, core+Lark, core+credentials, and all-P1 compositions.
- [x] Run a final `pnpm check`; inspect every plugin dry-run file list and confirm generated output is untracked.
- [x] Review permissions/readmes, license attributions, migrations, exported service types, configuration schemas, and compatibility declarations.
- [x] Use `verification-before-completion`, then `finishing-a-development-branch`, before claiming the persistent goal complete.

## Explicitly Deferred

- Browser/RPA, PDF/DOCX/web ingest, second message channel, vector retrieval, autonomous unapproved memory writes, automatic Git operations, multi-node scheduling, and generalized shared-contract packages.
