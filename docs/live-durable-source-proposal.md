# Real model → durable source check

## Evidence boundary

A bounded Day1 run produced a `personal-memory` repair, and a fresh Host Context completed the durable offline check and retained a `pending-approval` plan. Independent acceptance rejected the frozen baseline and accepted the candidate. The repair was subsequently integrated after review; the original plan was not self-approved.

This establishes the source-proposal and durable-check path. It does not establish autonomous publication, activation, process-crash recovery, or later-task improvement. Changed settings and tool contracts prevent a controlled gain claim. Current delivery and remaining acceptance are maintained in [RSI status](rsi-status.md); superseded timings and test-count snapshots remain in Git history, and raw runs stay local.

## Harness

This owner-run engineering acceptance uses the existing Growth Driver, native
AgentLoop, Policy, Automations Host executor and Control Plane. The model reads
one plugin at a pinned Git commit and submits one bounded modification. Its wake
ends before a fresh Cordis Context performs the offline repository check.

The model supplier is whatever route the owner configures through
`DSH_WEB_REAL_PROVIDER` / `DSH_WEB_REAL_MODEL`. The model authority
remains 240 seconds, with at most 12 model calls, 20 tool calls and 8,192 output
tokens per model request; the separately authorized Host check may take 30 minutes.
The result is a persisted `pending-approval` source plan. This command does not
approve, publish, install or activate that plan.

## Prerequisites

- Build this checkout with `pnpm build` and provide a configured route and
  credential reference for
  [the real-route helper](../scripts/e2e/web-owner-real-route.mjs), selected
  with `DSH_WEB_REAL_PROVIDER` / `DSH_WEB_REAL_MODEL`.
- Prepare the fixed linux-native repository runtime with the owner resource
  preparation entry (`prepareLinuxRsiRepositoryRuntime`). Retain its runtime
  descriptor, manifest inventory and lock digest; re-prepare when the lock changes.
- Use the documented [native runtime boundary](dockerless-runtime.md).
  The nested repository sandbox runs inside the linux-native user namespace,
  cgroup v1 delegation and the pinned seccomp profile. It keeps network disabled,
  non-root execution, no capabilities, and no Host mounts. Its `/proc` exposure is
  limited by the namespace and seccomp policy rather than a container default.
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

The Docker-era source-model smoke was retired with the Docker source-build
backend. Current durable `sourceJobs` coverage is in the `plugin-control-plane`
package tests and the [native runtime boundary](dockerless-runtime.md); the old
option descriptions below are historical contract notes, not runnable commands.
The old probe switches are no longer part of the repository interface.

Every run uses private local state; the evidence records its path. Successful
pending plans retain their registered worktrees for review, and failures retain
their state for reconciliation. Do not remove those directories manually while
their worktree ownership remains unresolved.

The scheduler is explicitly disabled during the model wake. After queue
acceptance the first Context is disposed; a fresh Context opens the same state
and trust, with no model/Agent service, then calls the actual Automations tick.
This proves a **queued job survives Context replacement**, not process-crash
recovery of a running job. Claimed jobs interrupted during execution remain
`unknown` and require resource reconciliation, never automatic replay.

## Independent acceptance and evidence boundary

> **Migration pending:** `personal-memory-source-acceptance.mjs` still
> constructs a Docker-era `IsolatedVerifierRunner({ image, dockerPath })`;
> after the Docker removal the runner constructor requires a linux-native
> `LinuxRuntime` + cgroup roots, so this harness currently throws at
> construction and is fail-closed until migrated to
> `LinuxVerifierRunner` (tracked as the opt-in e2e migration). The command
> shapes below record the intended contract, not a currently runnable command.

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
