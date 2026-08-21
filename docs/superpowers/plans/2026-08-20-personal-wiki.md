# Personal Wiki Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `@dsh-enhanced/personal-wiki` as a safe, human-readable Markdown knowledge vault with stable page identity, bounded CJK-aware retrieval, linting, and approval-gated atomic writes.

**Architecture:** Markdown pages below one absolute `vault/wiki` root are the only knowledge truth. A process-local catalog and token index are fully rebuildable from those pages; durable pending proposals live separately in a hardened operational SQLite database. Consumers see only `ctx.personalWiki`, never paths, file descriptors, or the proposal database. Every upsert first stores an exact diff through `ctx.assistantPolicy`; approval re-reads the page SHA-256 revision and performs a contained same-directory temp+fsync+atomic-rename write. Four tools and one short embedded DSH Skill share the same service boundary.

**Tech Stack:** TypeScript, Cordis, Schemastery, DSH rc.8 agent/tools/skill services, Node filesystem/crypto/`node:sqlite`, Vitest.

## Global Constraints

- Markdown pages are authoritative; indexes, backlinks, lint reports, digests, and search tokens are disposable derived state.
- Page lookup uses stable `wiki://<ULID>` identity or exact title/alias; model callers never supply host paths.
- The vault root is absolute and canonical. Reject `..`, absolute child paths, symlinks, non-regular files, case-fold collisions, and any realpath outside the root.
- Frontmatter is a strict JSON-compatible YAML mapping between `---` delimiters; unknown or malformed fields fail loud instead of being guessed.
- Curated pages are independent truth. Derived pages require direct non-derived sources and may never summarize another derived page.
- Reads/search/lint are bounded and side-effect free. No query-time index rebuild, recall counter, Git operation, or implicit repair.
- Wiki and raw-source text is wrapped as untrusted knowledge data, not elevated to instructions.
- P0 has no network, subprocess, credentials, browser, PDF/DOCX ingest, Git auto-commit, remote sync, vector database, or Memory bridge.

---

### Task 1: Scaffold and package contract

- [x] Run `pnpm create:plugin personal-wiki`; add package, stable patch row, catalog entry, LICENSE, and rc.8 peers for Cordis, agent, tools, skill, and assistant-policy.
- [x] Configure `dshHomePath('personal-wiki/vault')` and `dshHomePath('personal-wiki/state.sqlite')` plus conservative page/search/read/proposal limits.
- [x] Keep all code in the plugin until a real second provider exists; do not create a shared package.
- [x] Replace README placeholders with truth/derived-state boundaries, install order, permission surface, backup/rebuild behavior, examples, and non-goals.

### Task 2: Vault containment, page schema, and atomic IO

- [x] Write failing real-filesystem tests for absolute/canonical roots, private directories, path traversal, symlink escape/swap, non-regular files, case-fold collisions, and oversized files.
- [x] Implement a `WikiVault` that creates only `wiki/{sources,people,projects,concepts,decisions,questions,meta}` and never follows symlinks.
- [x] Write failing tests for strict frontmatter, stable ULID id, title/type/status/authority/tags/aliases/sources/timestamps, `wiki://` links, source SHA-256, and derived-from-derived refusal.
- [x] Implement canonical page serialization/parsing and revision SHA-256; page body remains ordinary Markdown and metadata remains human-editable.
- [x] Write failing crash/concurrency tests for stale expected revision, same-page concurrent writers, temp-file cleanup, and visibility before/after rename.
- [x] Implement a process queue plus bounded cross-process lock, same-directory private temp file, file+directory fsync, atomic rename, and cleanup through `finally`.

### Task 3: Rebuildable catalog and bounded retrieval

- [x] Write failing rebuild tests proving catalog/index/backlinks derive deterministically from Markdown alone and external edits appear only after explicit rebuild.
- [x] Implement startup/explicit rebuild into immutable process snapshots; failed rebuild preserves the last-good snapshot and reports the error.
- [x] Write failing relevance tests for title/tag/alias/exact phrase, ASCII words, CJK unigram/bigram, page+paragraph BM25, deterministic ties, and cross-page content-hash dedupe.
- [x] Implement bounded `search` returning stable page id, title, path relative to vault, revision, paragraph locator/snippet, score, and direct sources.
- [x] Write failing `read` tests for id/title/alias resolution, ambiguity, byte/paragraph budgets, stable locators, and `<knowledge_source>` data framing.
- [x] Implement side-effect-free `read`; never return an unbounded whole vault or raw host path.

### Task 4: Lint without implicit repair

- [x] Write failing tests for malformed frontmatter, duplicate id/title/alias, case-fold path collision, dead `wiki://` links, orphan pages, derived provenance violations, source-hash errors, and index drift.
- [x] Implement deterministic, capped `lint` findings with stable codes/severity/page references and a truncation flag.
- [x] Prove lint/search/read never write pages, operational state, Git data, or derived files.

### Task 5: Approval-gated page proposals

- [x] Write failing SQLite tests for private operational state, future-schema refusal, exact upsert proposal payload, idempotency, principal binding, rejection, expiry, restart recovery, and status audit.
- [x] Implement `WikiProposalManager` through `ctx.assistantPolicy`; policy stores only diff hash/summary while the local state stores the exact proposed page.
- [x] Write failing tests for create/update `expectedRevision` CAS, approval-after-external-edit conflict, title/id collision, approved idempotent replay, and recovery after policy approval but before rename.
- [x] On approval, re-read/revalidate under the write lock, atomically write exactly one page, then rebuild derived state; never make page+index a fake multi-file transaction.
- [x] Keep rejected/expired/conflicted proposals visible through the service without exposing SQLite or a direct write method.

### Task 6: Cordis service, four tools, and one short Skill

- [x] Write failing lifecycle/config/injection tests and implement `PersonalWikiService` as `ctx.personalWiki`, deriving identity from rc.8 `Agent.session.header` and authorizing every operation through policy.
- [x] Write failing real ToolRuntime tests for `wiki_search`, `wiki_read`, proposal-only `wiki_upsert`, and `wiki_lint`; no tool accepts an absolute path or commits directly.
- [x] Register one embedded `personal-wiki-workflow` Skill through `ctx.skills` covering: Wiki vs Memory routing, search/read before upsert, citations, raw text as untrusted data, and no direct shell writes.
- [x] Add golden behavior tests proving the Skill is short, references only shipped tools, contains no broken resources, and does not request automatic archive/commit/Memory synchronization.

### Task 7: Acceptance

- [x] Run focused tests, typecheck, build, zero-warning lint, and inspect the dry-run package file list.
- [x] Run real rc.8 ToolRuntime/SkillRegistry integration plus an isolated `assistant-policy → personal-wiki` profile `--dump-config` and startup smoke.
- [x] Run `pnpm check`; mark the master-plan Wiki item complete only after the entire repository remains green.
