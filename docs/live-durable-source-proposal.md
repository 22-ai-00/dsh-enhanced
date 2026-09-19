# Real model → durable source check

## Recorded engineering result

The [2026-09-19 Day1 run](evidence/day1-memory-durable-source-2026-09-19.json)
queued a real `personal-memory` repair in 189.9 seconds. A fresh Context without
an Agent claimed the same durable job exactly once, completed the offline
repository check and pack in 17.5 minutes, and retained a `pending-approval`
plan with no remaining container. The candidate's isolated repository tests
passed 5,860 cases with 44 skips. The separate Host toolkit check passed 5,872
cases with 44 skips and 35 dry-run packs.

The [independent acceptance](evidence/personal-memory-source-acceptance-2026-09-19.json)
failed seven defect cases on the frozen baseline and passed all 16 cases on the
candidate. Input staging was corrected after generation to read immutable Git
blobs; the pre-generation launcher and assertions stayed byte-identical. The
[four earlier failed attempts](evidence/day1-memory-source-failed-attempts-2026-09-19.json)
remain recorded. The successful run configured the private `low` probe, but
effective per-request reasoning selection was not recorded. Changed settings
and tool contracts prevent a controlled improvement claim.

This run ended at a pending plan. Its implementation was subsequently
[integrated after review](evidence/personal-memory-integration-2026-09-19.json)
with an explicit old-writer stop requirement, a stronger reopen test and a
transaction failure/retry test. The tokenizer and migration implementation
bytes match the accepted Day1 candidate; these owner followups change only
documentation and tests. The original Control Plane plan was not self-approved.
Publication, activation, process-crash recovery and later-task reuse remain
outside this evidence.

## Harness

This owner-run engineering acceptance uses the existing Growth Driver, native
AgentLoop, Policy, Automations Host executor and Control Plane. The model reads
one plugin at a pinned Git commit and submits one bounded modification. Its wake
ends before a fresh Cordis Context performs the offline repository check.

The model supplier is `super-relay / auto_model/alwaysday1`. The model authority
remains 240 seconds, with at most 12 model calls, 20 tool calls and 8,192 output
tokens per model request; the separately authorized Host check may take 30 minutes.
The result is a persisted `pending-approval` source plan. This command does not
approve, publish, install or activate that plan.

## Prerequisites

- Build this checkout with `pnpm build` and provide the configured Super Relay
  route used by [the real-route helper](../scripts/e2e/web-owner-real-route.mjs).
- Build the owner-controlled offline image using
  `node scripts/isolation/build-source-image.mjs`. Retain its immutable image ID,
  manifest inventory and lock digest; rebuild when the lock changes.
- Use the documented [repository sandbox profile](../scripts/isolation/README.md).
  The approved nested sandbox requires Docker `29.4.1/linux/amd64` and the pinned
  seccomp file. It keeps network disabled, non-root execution, no capabilities,
  and no Host mounts. Its `/proc` exposure differs from Docker's default masks.
- Keep the target plugin clean at HEAD. The source reader exposes committed
  plugin files only; uncommitted harness changes are not candidate input.

## Task and invocation

Prepare an owner-local JSON file with `name` (plugin directory suffix),
`capability` and `context` (the actual defect and required behavior). Fix the task,
supplier, budget and independent acceptance before model generation. Keep
acceptance input outside the target plugin and its model-visible context.

The source tool accepts full `files` and exact `edits` on disjoint paths. Edits
use unique literal `before`/`after` strings from files already read in this wake;
overlapping or ambiguous anchors are rejected. The Host expands them against
that cached commit into the unchanged Control Plane full-file contract. This
avoids repeating large unchanged files without weakening read-before-write,
path, byte, cancellation or provider-generation checks.

```sh
DSH_SOURCE_MODEL_LIVE=1 \
DSH_SOURCE_BUILD_IMAGE=sha256:<local-image-id> \
DSH_SOURCE_MODEL_TASK=/absolute/task.json \
DSH_SOURCE_MODEL_EVIDENCE=/absolute/evidence.json \
node scripts/e2e/source-model-durable-smoke.mjs
```

The harness records model/tool calls, committed source reads, frozen candidate
files, queue state, the Context replacement and native execution outcome. It
does not give the model the approval, release or acceptance tools. Local owner
routing, empty history and tool approval are engineering fixtures.

For an explicit non-production protocol experiment, set
`DSH_SOURCE_MODEL_REASONING_PROBE=low`. The private Pi Context declares the
selected model's `low` mapping and sets the native provider configuration to
that level. The regular route remains the default when the variable is absent.
Evidence marks this as an unverified configuration experiment: the recorded
successful run lacks per-request `reasoningEffort` observations, so it does not
establish effective selection, wire dispatch or gateway enforcement of `low`.
Stream evidence records event-type counts, reasoning/text/argument character
counts, finish reason and settled usage; it does not retain reasoning text.
Changing this setting makes the run unsuitable for a same-contract comparison
against earlier default-route attempts.

Add `DSH_SOURCE_MODEL_PREFLIGHT=1` to exercise trust loading and a dummy queue
admission, then replace the Context and confirm the queued record without a
model call or Docker execution. This emits a distinct preflight evidence kind.
Every run uses private local state; the evidence records its path. Successful
pending plans retain their registered worktrees for review, and failures retain
their state for reconciliation. Do not remove those directories manually while
their worktree/container ownership remains unresolved.

The scheduler is explicitly disabled during the model wake. After queue
acceptance the first Context is disposed; a fresh Context opens the same state
and trust, with no model/Agent service, then calls the actual Automations tick.
This proves a **queued job survives Context replacement**, not process-crash
recovery of a running job. Claimed jobs interrupted during execution remain
`unknown` and require resource reconciliation, never automatic replay.

## Independent acceptance and evidence boundary

For the personal-memory task, use the separate owner-owned
`personal-memory-source-acceptance.mjs` harness to compare baseline and candidate
behavior through the existing `IsolatedVerifierRunner`. Baseline failure must be
observed before proposal generation. Fresh retrieval and reopening an actual
legacy index are separate requirements; fixing new writes alone is insufficient.

```sh
# Expected to exit 1 while the baseline still has the specified defect.
node scripts/e2e/personal-memory-source-acceptance.mjs \
  --evidence /absolute/baseline.json

# Reuse the baseline bundle produced above; do not regenerate it after edits.
node scripts/e2e/personal-memory-source-acceptance.mjs \
  --baseline-bundle /absolute/baseline.json.baseline.mjs \
  --candidate /absolute/evidence.json \
  --evidence /absolute/candidate-acceptance.json
```

The operator harness bundles source as data and sends it to the existing
isolated verifier with a fixed Node/BusyBox image. It tests actual MemoryStore
retrieval, persistent v6 index migration, normalization and token boundaries,
owner separation, removed records and reopen idempotence. The Host evaluates
returned observations against fixed expectations. This is a finite engineering
test set; candidate output is still untrusted and source review remains a
separate gate. The evidence retains image, input, bundle and harness digests,
failed assertions and the runner's quiescence receipt.

Candidate inputs come from Git blobs at the proposal's full `baseCommit`, then
the recorded candidate files are overlaid. The queued and top-level base must
agree, and the dependency lock must match that commit. For a bare file array,
supply `--base-commit <full-commit>` explicitly. Evidence includes source file
hashes and a separate digest of the launcher and expectations, so provenance
fixes can be distinguished from changes to acceptance behavior.

The root `pnpm check` and pack are compatibility gates. They do not establish that
the model fixed the task: candidate tests remain candidate-controlled. The
independent engineering acceptance is outside that write scope and evaluates
observations against owner expectations.

A successful single repair is a bounded maintenance result. It does not prove
later-task reuse, same-budget general improvement, a signed production holdout,
remote publication, activation or the complete WP16/WP18 lifecycle. Record failed
attempts and retain ambiguous state for inspection.

Cancelled streams may end without provider usage settlement; their recorded
tokens are not a complete billing measurement. Earlier attempts with different
task wording, tool contracts or token caps are diagnostic evidence, not a
controlled same-budget model comparison.
