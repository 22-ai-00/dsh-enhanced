# Event Triggers Implementation Plan

**Goal:** Add bounded file, HTTP/JSON and authenticated webhook sensors that persist observations and stable external-event outbox rows before delegating execution to `assistant-automations`.

- [x] Generate `@dsh-enhanced/event-triggers` with Policy and Automations injection; Credentials is optional and only required by webhook configs.
- [x] Validate static trigger definitions, unique ids, allowlisted file roots/HTTP hosts, authenticated host-gateway webhook ingestion, limits and no arbitrary command/shell sensor.
- [x] Add private SQLite state for baseline, edge revision, debounce/cooldown/TTL/max-fires, nonce replay protection and pending/delivered event outbox.
- [x] Implement file existence/content-hash sensors with lexical/realpath/symlink containment and bounded reads.
- [x] Implement HTTP/JSON sensors with HTTPS, exact host allowlist, DNS public-address checks per request, manual redirects, timeout/body fences and bounded JSON pointer extraction.
- [x] Implement HMAC-SHA256 webhook verification with credential handles, timestamp skew and nonce/event-id dedup; require the loopback host gateway to enforce bind, body and rate limits before calling the service.
- [x] Persist observation/fire before calling Automations and replay pending outbox rows on restart using stable event ids.
- [x] Test baseline, repeated/changed edges, debounce/cooldown/max-fires/TTL, restart replay, SSRF/redirect/body fences, signature/nonce failure and cleanup.
- [x] Document permissions/non-goals/references, update catalog, and run tests, lint, typecheck, build and pack inspection.
