# Memory Wiki Bridge Implementation Plan

**Goal:** Add two explicit, deterministic knowledge-promotion workflows that read only public provider seams and create target-side proposals without a third truth store or automatic approval.

- [x] Generate `@dsh-enhanced/memory-wiki-bridge` with hard Memory/Wiki injection and no database/filesystem/network authority.
- [x] Add exact bounded `personalMemory.read(ids)` provider seam with visibility, Policy and missing-source checks.
- [x] Implement selected Memory ids+versions → derived Wiki create/update proposal with `memory://` provenance and complete diff delegated to Wiki.
- [x] Implement exact Wiki id+revision → Memory add proposal containing a bounded summary and `wiki://` provenance.
- [x] Compute stable idempotency from direction, source ids/versions/revisions, target and normalized content; do not accept a caller key that can omit provenance.
- [x] Keep both flows foreground Agent-only and reject missing, background or relative-workspace identity before reading either provider.
- [x] Register `knowledge_promote` and `knowledge_pin` tools with bounded schemas and proposal-only output.
- [x] Test replay, source deletion/version change, target revision CAS, provider rejection, tainted provenance and service disposal.
- [x] Document non-goals/references, update catalog, and run tests, lint, typecheck, build and pack inspection.
