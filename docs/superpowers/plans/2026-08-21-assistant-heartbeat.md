# Assistant Heartbeat Implementation Plan

**Goal:** Add a bounded, restart-safe heartbeat policy layer that reconciles one system-owned row per configured agent into `assistant-automations` without owning another scheduler or database.

- [x] Generate `@dsh-enhanced/assistant-heartbeat` as an independently publishable bundle with hard Cordis injection of Policy and Automations.
- [x] Validate per-agent active-hour, timezone, interval, workspace/model/tool, scratch-path and hard-stop configuration; fail closed on unsafe paths or missing identity.
- [x] Store only human-readable scratch Markdown using atomic write and SHA-256 revision CAS; never create a timer/task ledger.
- [x] Reconcile non-empty scratch into a deterministic system-owned automation row; empty scratch pauses/suppresses work without invoking a model.
- [x] Encode active hours in the automation cron schedule, use `queue-one` coalescing, bounded output/tool limits and a stable configuration revision idempotency key.
- [x] Suppress `HEARTBEAT_OK`/empty output at the delivery boundary contract and expose bounded, content-free status.
- [x] Cover empty scratch, CAS conflict, stable ownership, timezone/active-hours schedule bounds, idempotent restart, disposal and policy denial with tests.
- [x] Document permissions/non-goals/references, update the catalog, and run tests, lint, typecheck, build and dry-run pack.
