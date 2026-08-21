# Lark Channel Implementation Plan

> **Execution rule:** implement every behavior test-first; keep vendor protocol code out of `assistant-delivery`.

**Goal:** Build `@dsh-enhanced/lark-channel` as a thin Feishu/Lark WebSocket adapter that normalizes inbound events into the durable delivery core and translates already-persisted outbound intents into provider calls.

**Boundary:** `assistant-delivery` remains authoritative for pairing, authorization, deduplication, session routing, retries, dead letters, and send ambiguity. This package owns only Lark credentials resolution, SDK lifecycle, event normalization, Lark message/card translation, provider error classification, and connection-gap health facts.

## 1. Bundle and contracts

- [x] Generate `plugins/lark-channel`, declare the official `@larksuiteoapi/node-sdk` runtime dependency and rc.8/Cordis plus `assistant-delivery` peers, add a stable patch row and catalog entry.
- [x] Define a bounded internal channel-client seam so tests never require real credentials or network access.
- [x] Accept only an application id, tenant id, account id, domain, and an environment-variable **name** or future credential handle; reject plaintext app secrets in config.
- [x] Document app scopes/events, network and credential authority, long-connection single-consumer behavior, the SDK reconnect gap, and unsupported multi-node guarantees.

## 2. Inbound normalization

- [x] Write failing tests for DM/group/thread identity mapping, stable message-event ids, command detection, mention requirements, account/tenant isolation, oversized/empty inputs, control characters, stale events, and attachment descriptors treated as untrusted data.
- [x] Normalize messages to `InboundEnvelope` without embedding provider/thread identity in a session string; use the provider message id as the durable event id.
- [x] Require an explicit bot mention for group messages by default, never treat `@all` as a bot mention, and let `assistant-delivery` fail closed for unpaired principals.
- [x] Await `DeliveryAdapterContext.accept` before returning from the SDK listener so provider acknowledgement follows inbox persistence.

## 3. Outbound adapter

- [x] Write failing tests for text, Markdown/card rendering, reply/thread targeting, immutable target/account checks, bounded content, and provider response validation.
- [x] Map definitely-unsent validation/auth/rate-limit failures to `not-sent`; map timeout/connection/unknown exceptions to `unknown` so the core never blindly resends.
- [x] Declare reconciliation and receipts unsupported until Lark exposes a trustworthy idempotency/query seam; never invent exactly-once guarantees.
- [x] Add explicit adapter lifecycle tests for registration, connect failure, disconnect cleanup, reconnect/reconnected health state, and duplicate listener disposal.

## 4. Approval/card and media boundary

- [x] Write failing tests for signed, expiring approval card values, principal/conversation correlation, replay, tampering, rejection, and delayed settlement through `assistant-delivery`.
- [x] Keep arbitrary card JSON and local/remote media sources out of model tools. Provide only bounded, typed adapter helpers whose durable operation is created by the delivery core.
- [x] Quarantine inbound resource metadata as untrusted; defer binary download until an explicitly authorized caller requests a bounded resource.

## 5. Verification

- [x] Run focused tests, zero-warning lint, typecheck, build, and inspect dry-run package contents.
- [x] Install policy + delivery + Lark into an isolated rc.8 profile, verify `--dump-config`, and perform a credential-free startup failure/cleanup smoke.
- [x] Run cross-plugin duplicate/restart/account/thread/pairing tests and then `pnpm check`.

## Evidence-led limitation

The official long-connection transport auto-reconnects but does not expose a replay cursor or history API for missed events. This adapter records reconnect gap state and relies on provider redelivery plus the durable delivery inbox; it must not claim gap-free replay. If Lark later publishes a cursor/backfill contract, add it behind tests before enabling that claim.
