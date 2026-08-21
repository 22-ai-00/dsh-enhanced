# Credentials Keychain Implementation Plan

> **Execution rule:** implement test-first; no model-facing tool may reveal, enumerate, write, or delete credentials.

**Goal:** Build `@dsh-enhanced/credentials-keychain` as the suite's audited secret-handle service for trusted plugin consumers such as `lark-channel`.

**Boundary:** Secret values remain in an OS keychain or a specifically named process environment entry. The plugin owns handle policy, provider invocation, bounded leases, revocation and a secret-free SQLite ledger; it is not a password manager UI and cannot sandbox a malicious in-process plugin.

## 1. Bundle and typed contracts

- [x] Generate the independent bundle, require `assistant-policy`, add a stable patch/catalog row, Schemastery config and exact rc.8-compatible peers.
- [x] Define exact credential handles for `environment`, `macos-keychain`, and `linux-secret-service`, with allowlisted consumer plugin ids, purposes and maximum lease TTL.
- [x] Derive consumer identity from the Cordis caller context/fiber; document that this is a guard for trusted plugins, not process isolation.
- [x] Reject secret values, commands, arbitrary executable paths, broad environment inheritance, duplicate ids, unsafe locator fields and unbounded output/TTL.

## 2. OS provider boundary

- [x] Write failing tests for one-name environment reads, macOS `security find-generic-password`, Linux `secret-tool lookup`, fixed argv/no shell, minimal environment, timeout, output bound, nonzero exit and stderr redaction.
- [x] Implement provider runners with injectable spawn boundary; never put secret values in argv, logs, config, errors or audit.
- [x] Keep mutation/deletion of OS keychain entries out of v0.1; operators provision them with OS-native tools.

## 3. Lease/revocation/audit ledger

- [x] Write failing tests for absolute private SQLite path, WAL/FULL/busy timeout, forward migration and future-schema refusal.
- [x] Implement append-only lease/audit metadata with active/completed/failed/expired/revoked state, idempotency key, consumer, purpose and timestamps but no value/locator.
- [x] Write failing tests for handle/consumer/purpose allowlists, policy default deny, TTL abort, concurrent revocation, idempotent replay and restart visibility.
- [x] Expose `withSecret(callerContext, request, callback)` so the value exists only inside a bounded callback; always settle/abort the lease in `finally`.

## 4. Consumer integration and verification

- [x] Add metadata-only health/list/revoke operations for local operators; no Agent tools and no secret-bearing return type.
- [x] Change `lark-channel` to prefer a configured credential handle and run its adapter lifecycle inside a credential lease; retain named-env mode only as an explicit compatibility fallback.
- [x] Test Lark lease revocation/expiry disconnects the adapter and neither service/log/SQLite/config includes the value.
- [x] Run focused tests, lint, typecheck, build, dry-run pack, isolated rc.8 config/startup smoke, then `pnpm check`.

## Explicit limitations

- JavaScript strings cannot be reliably zeroized; callbacks must not retain or log the value.
- A malicious plugin in the same Node.js process can bypass a cooperative service boundary. Strong isolation belongs to the separate runtime/plugin-isolation work, not this bundle.
- v0.1 does not write, rotate or delete OS credentials and does not expose secret operations to an Agent.
