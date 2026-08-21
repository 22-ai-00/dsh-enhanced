# Assistant Delivery Implementation Plan

> **Execution rule:** implement every checkbox test-first and keep the transport-neutral core independently publishable.

**Goal:** Build `@dsh-enhanced/assistant-delivery` as the single durable, policy-gated message core for inbound channel events, owner pairing, conversation/session bindings, outbound delivery, receipts, reconciliation, and dead letters.

**Boundary:** The plugin owns typed routing identities and SQLite ledgers but no vendor SDK. Channel adapters register through `ctx.assistantDelivery`; Automations enqueue stable intents; Lark supplies transport normalization/send/reconcile. Execution and delivery remain separate state machines.

## 1. Bundle and public contracts

- [x] Generate `plugins/assistant-delivery`, declare rc.8 Cordis/Agent/Session peers plus `assistant-policy`, add a stable patch row and catalog entry.
- [x] Define canonical `ExternalPrincipalKey`, `ConversationRef`, `ConversationBinding`, `DeliveryTarget`, inbound envelope, outbound intent, adapter capabilities/result, receipts, attempts, and fixed error codes.
- [x] Validate and canonicalize every typed key without parsing provider identity from a compound session string; cap all text, metadata, identifiers, and retention settings.
- [x] Document permissions, PII retention, single-host semantics, delivery ambiguity, supervisor needs, adapter obligations, and the exact non-goals.

## 2. Hardened SQLite and identity/pairing

- [x] Write failing tests for absolute private database/spool paths, `0700`/`0600`, WAL/FULL/busy timeout, forward migrations, and future-schema refusal.
- [x] Implement strict tables for principals, pairing challenges, bindings, inbox, inbox attempts, outbox, outbox attempts, receipts, attachments, and duty leases.
- [x] Write failing owner pairing tests for empty allowlist fail-closed, code hash-at-rest, TTL, constant-time verification, single use, replay, attempt cap, revocation, restart, account/tenant confusion, and explicit cross-platform linking.
- [x] Implement local code issuance/confirmation as non-model service operations; never expose stored hashes, raw principals, provider secrets, or arbitrary route creation to tools.

## 3. Durable inbox and session binding

- [x] Write failing duplicate/out-of-order/restart tests proving `(channel, account, eventId)` is persisted before adapter acknowledgement and repeated delivery returns the same row.
- [x] Implement `received→authorized→queued→claimed→processed|retry_wait|dead_letter`, per-binding lane ordering, bounded attempts, claim leases/fencing, and exact-boundary recovery.
- [x] Write failing binding tests for owner DM, generation-preserving `/new`, lookup/resume/create single-flight, thread/account/tenant isolation, optimistic versioning, and resume failure that never overwrites history.
- [x] Implement immutable typed binding keys and a processor seam; only an approved principal can acquire/create a session binding, and raw external content is tagged untrusted.

## 4. Durable outbox, adapter registry, and reconciliation

- [x] Write failing tests proving an outbox row is committed before network send and duplicate `idempotencyKey` returns the same immutable intent or conflicts on changed content/target.
- [x] Implement `pending→attempting→accepted→delivered|read`, `retry_wait`, `dead`, and `unknown_after_send`; keep append-only attempts and receipts separate.
- [x] Write failing adapter tests for registration/disposal, capability checks, lane ordering, bounded concurrency, 429 Retry-After, jittered 5xx retry, permanent 4xx dead-letter, provider-accepted response loss, restart, and reconciliation.
- [x] Never blindly retry an ambiguous attempt: call `reconcileUnknownSend` when supported; otherwise preserve `unknown_after_send` for explicit operator resolution.
- [x] Implement receipt monotonicity/idempotency and reject a receipt whose adapter/account/provider message does not match the stored attempt.

## 5. Cordis service, Policy integration, and tools

- [x] Implement `ctx.assistantDelivery` with adapter registration, inbound accept/ack decision, pairing administration, binding lookup/new generation, enqueue, receipt ingestion, tick/start/stop/whenIdle, history/DLQ, retry/cancel, and processor registration—without exporting the store.
- [x] Require `assistant-policy`; authorize external ingestion, recipient-bound sends, pairing/linking, and operator recovery with explicit subjects/resources. Unknown identity or background `ask` fails closed.
- [x] Add only bounded read/intent tools needed by an Agent: reply-to-current-binding and delivery status. Models cannot construct arbitrary channel/account/chat IDs or pair owners.
- [x] Add delayed-approval correlation using a stable operation id, reread exact target/content hash after approval, and reject expired/revoked/changed decisions.

## 6. Agent/session integration and verification

- [x] Write rc.8 mock-Agent integration tests: approved owner DM creates/resumes one persisted root session, duplicate event creates no second turn, `/new` increments generation, and restart resumes the same binding.
- [x] Prove inbound persistence/ack precedes Agent enqueue; clearly distinguish persisted, authorized, queued, claimed, turn-ended, and receipt states without claiming exactly-once turns.
- [x] Add targeted crash-boundary tests around send/receipt transitions, claim fencing, redaction/path/size validation, and 100-restart inbox dedup.
- [x] Run focused tests, zero-warning lint, typecheck, build, inspect dry-run package contents, real rc.8 `--dump-config` and startup smoke, then `pnpm check`.
