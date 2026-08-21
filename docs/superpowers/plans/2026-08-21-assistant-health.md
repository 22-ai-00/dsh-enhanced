# Assistant Health Implementation Plan

**Goal:** Aggregate bounded, content-free health/readiness counters from optional assistant services without becoming another truth store or exposing private content.

- [x] Generate `@dsh-enhanced/assistant-health` with Policy required and all observed providers discovered dynamically/optionally.
- [x] Add provider-owned health seams for Memory, Wiki, Automations and Delivery; preserve Credentials/Event existing seams and never read another plugin database/files directly.
- [x] Expose side-effect-free liveness and readiness separately; readiness must not call a model, execute tools, repair state or contact external providers.
- [x] Require exact Agent identity plus Policy for detailed report/tool access.
- [x] Whitelist each provider's boolean/numeric/status output and recursively reject unexpected strings/keys so secrets, prompts, paths and content cannot leak.
- [x] Emit low-cardinality provider/counter data and bounded warning codes; detect only, never fix.
- [x] Test missing/throwing providers, redaction sentinel values, Policy denial, disposal, bounded output and actual cross-provider aggregation.
- [x] Document permissions/non-goals/route-adapter expectations, update catalog, and run tests, lint, typecheck, build and pack inspection.
