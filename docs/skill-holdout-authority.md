# Independent skill holdout authority

`dsh-skill-holdout` is an operator process shipped by `@dsh-enhanced/assistant-skills`. It keeps a fixed dataset and an Ed25519 signing key outside the candidate execution environment. A trusted executor requests one input at a time, executes the frozen arm, and returns observed output. The authority compares that output with its own expected result and signs a bounded report. It never accepts a caller-supplied verdict and never enables a skill.

This is a runnable judging and recovery boundary, not a declaration that a dataset was historically independent. Operators must independently select and freeze the dataset and pin the authority public key. A signature proves which configured authority judged which scope, two arm digests, dataset, limits, budget binding and observations; it does not prove that the trusted executor honestly ran a model, that training never saw the cases, or that a candidate should be promoted.

## Deployment boundary

Run the authority in a separate evaluation service, VM or container. Mount its private configuration, dataset, key and state only there. Candidate workers must not receive these mounts, the authority stdin, Docker socket, Host filesystem or network access. The trusted controller bridges the authority's pipe and the existing `IsolatedVerifierRunner`; the latter receives only an artifact and the current input. The authority itself does not execute candidate code or require a Docker socket.

The CLI enforces private canonical directories and owned regular single-link files, rejects symlink configuration/key/data, and creates SQLite state with private permissions. These checks do not sandbox a malicious administrator or another trusted Host process. Merely starting the CLI beside an unrestricted candidate shell is insufficient. The container integration test checks the concrete separate-mount boundary; it does not claim whole-Host isolation.

## Operator configuration

Use Node `^22.19.0 || >=24.0.0` on a POSIX system. Create an operator-owned directory with mode `0700`; configuration, dataset and private key files must have mode `0600`. Do not place these files in the candidate workspace or commit them to the repository.

The configuration contains only these fields:

```json
{
  "datasetPath": "/operator/private/dataset.json",
  "privateKeyPath": "/operator/private/authority.pem",
  "statePath": "/operator/private/qualification.sqlite",
  "limits": { "maxToolCalls": 8, "maxOutputBytes": 16384 }
}
```

The private dataset shape is `{id, version, cases}`. Each case has `id`, `kind` (`replay`, `evaluation`, or `regression`), `stdin`, `expectedStdout`, and `expectedExitCode`. Include all three kinds, 3–12 distinct cases, and no more than 256 KiB of case strings. The exact stdout/exit-code judge is suitable for specified command-line program behavior; other task domains require their own independent judge. It is not a substitute for research citation verification or external-system readback.

Supply an Ed25519 private key in PEM form. Distribute the public key separately through trusted operator configuration. Do not accept a public key merely because the same untrusted response contains it.

```sh
dsh-skill-holdout --config /operator/private/config.json
```

One state database belongs to one frozen qualification. A new candidate needs a newly authorized qualification and state database. Reopening an old database preserves its identity and consumed work; it does not refresh its expiry or reset its cells.

## Installed Skills entrypoint

`assistant-skills` accepts an optional `externalHoldouts` array, disabled by default. Each public Host profile contains `id`, `version`, exact owner `scope`, `maxComparisons: 1`, `execution`, and `authority`. `execution` uses the exported `HoldoutExecutionConfig`: immutable candidate image, absolute Docker path, private state root outside the workspace, fixed command and artifact path, finite expiry, repeats and tool/byte/output/time ceilings. Optional typed `inputs` and initial `files` are identical for both arms and their digests are part of the signed budget binding. They must contain only candidate-visible setup, never held-out answers.

`authority` contains an absolute `executable`, fixed `args`, pinned Ed25519 `publicKey`, and exactly one of `datasetDigest` (fixed data) or `generatorDigest` (prospective data). This is trusted operator configuration, never a model-selected command. For a separate container, the executable may be the Host's Docker client with an explicitly configured, restricted authority container command. Do not mount operator data/key directories or Docker sockets into the candidate. A generic process command does not itself establish isolation; deploy the boundary described above.

Obtain the public pins inside the operator environment before configuring the Host:

```sh
dsh-skill-holdout --inspect-config /operator/private/config.json
```

This validates the private inputs and emits only `publicKey`, the configured identity pin, and `limits`; it does not create or consume a qualification database. Transfer those pins through trusted configuration. Use a separate authority state database for every new profile qualification. The profile permits one comparison across sessions; changing the invocation key does not reset its budget. Reusing a consumed authority database or switching its fixed/prospective mode cannot start new work. Expired profiles remain readable after Host restart but cannot execute.

With the existing owner `compare` Policy authorization and a pending candidate whose parent is still active, ask the assistant to qualify that candidate using the named profile. The installed `skill_qualify(candidate_id, profile_id, invocation_id)` tool starts the fixed Host process, executes actual native replay and isolated checks, verifies the signed receipt and pins, closes the process, and only then commits the result to the existing Skills comparison journal. Current owner, Policy, parent, candidate, deadline and service lifetime are checked throughout. Interruption or uncertain settlement becomes `unknown`; the same invocation reads its journal record without restarting the process. A new invocation cannot bypass the one-comparison ceiling.

`skill_comparison_status` exposes only profile id/version/expiry/ceiling or the public result. It excludes command arguments, private paths, public-key configuration, setup files and raw case input/output. The receipt retains public identity digests and the authority public key for verification. Comparison completion does not activate a skill. Explicit owner-requested activation after a fresh trial retains its existing semantics; prospective automatic canary admission uses the separate finite authorization below.

The exported `qualifyHoldout` Host coordinator is also available to trusted integrations. It requires exactly one of `expectedDatasetDigest` or `expectedGeneratorDigest`, `pinnedPublicKey`, bounded `execution`, original baseline/candidate definitions, a cancellable transport and a current-authority callback. The installed service supplies these from the frozen profile, not from model arguments.

## Prospective qualification and finite canary

The shipped prospective profiles cover three deterministic engineering task families. `order-summary/v1` and `order-summary/v2` are versions of the same order-summary family; choose v2 for the ordinary Web example because it sums integer `amountCents`, including negatives, excludes cancelled orders and accepts empty input. `template-render/v1` performs literal, non-recursive replacement of known placeholders while preserving unknown placeholders. `dependency-topological-order/v1` covers dependency ordering. Values are privately randomized only after the exact qualification binding is durably frozen. Inspect the configured profile to obtain its distinct generator digest. Existing state remains resumable with its consumed cells intact; changing the configured version or family cannot start another qualification.

For the supported order-summary task, replace `datasetPath` in the private operator configuration with:

```json
{
  "prospective": { "generator": "order-summary/v1" },
  "privateKeyPath": "/operator/private/authority.pem",
  "statePath": "/operator/private/qualification.sqlite",
  "limits": { "maxToolCalls": 8, "maxOutputBytes": 16384 }
}
```

The task consumes a JSON array of orders, excludes orders whose `status` is `cancelled`, sums integer `cents` by `currency`, and emits a JSON object with sorted currency keys followed by a newline. The generator uses fresh random values and fixed semantic edge cases across replay, evaluation and regression cases. It does not inspect either program to select favorable questions.

For the dependency-ordering family, use `"prospective": { "generator": "dependency-topological-order/v1" }`. Input is newline-delimited text. A valid edge line has exactly two whitespace-separated labels, each matching `[a-z][a-z0-9]{1,31}` (2–32 lowercase ASCII alphanumeric characters, starting with a letter). Blank, malformed, extra-field, digit-leading and overlength lines are ignored; duplicate edges are deduplicated and nodes are the accepted edge endpoints. A DAG emits the lexicographically smallest available node at every step, one node per line with a final newline. A cycle emits exactly `CYCLE\n`. The private dataset has bounded randomized labels, edge order and irrelevant lines: replay is a DAG, evaluation requires re-sorting after a newly ready lexical tie, and regression contains a cycle.

All three families are narrow deterministic fixtures. Other task domains need their own independently governed judge and are not covered by these generators.

Run the installed `dsh-skill-holdout --inspect-config /operator/private/config.json` and use its `publicKey` and `generatorDigest` in `externalHoldouts[].authority`; omit `datasetDigest`. The existing execution configuration still fixes the artifact, command, locally available immutable image and identical budgets. The candidate image must contain the task runtime, such as Node for a JavaScript order summary. Installing this package does not create signing keys, authorize evaluation resources or pull images automatically.

On `begin`, the operator first durably freezes the exact scope, baseline, candidate, budget and optional canary-admission binding with a unique freeze ID. Only then does it generate private cases and sign the certificate binding the exact profile, dataset digest and generation sequence to that frozen request. A failure after the freeze makes that plan unavailable; restart cannot draw a replacement dataset, and a lost acknowledgement resumes the already persisted bytes. Completed receipts can be reread without rerunning cells. Profile, dataset, certificate, receipt or admission drift fails closed. The certificate proves the configured authority's generation sequence; it does not prove training-data history or general intelligence improvement.

Configure owner Policy actions `canary`, `compare`, and `watch` for `{kind: 'evolution', id: 'verified-workflows'}`, plus background `promote`, `watch`, and `rollback` for subject `dsh-enhanced-assistant-skills` in the same owner/workspace. Supply an existing Delivery owner route. Normal `skill_run` and nested tools continue to require their own current permissions and fresh native Goal acceptance.

The owner can request: “Evaluate candidate C using profile P; allow one independently accepted canary run, at most three executions in total, until this expiry; promote only if its comparison and subsequent checks pass, and revert on regression.” The registered `skill_canary(candidate_id, profile_id, invocation_id, owner_route_id, expires_at, max_runs, canary_runs)` performs the comparison and admission. The grant is limited to 1–100 total runs and at most seven days, cannot outlive its comparison profile, and requires `1 <= canary_runs <= max_runs`.

The service rechecks the signed receipt and certificate against the stored candidate and current profile, recomputes all quality gates, and requires candidate checks, positive evaluation gain and critical regressions to pass. It atomically installs the exact candidate version with its deployment quota and rollback watch. Failed, unknown or zero/negative-gain comparisons do not activate it. A fixed-dataset `skill_qualify` receipt alone cannot enter this automatic path.

Run the resulting version through ordinary `skill_run` in fresh Goals. Canary admission initially permits only `canary_runs` executions. Distinct fresh independently achieved Goal outcomes allow promotion; promotion retains the original total-run and expiry limits. Failed or unconfirmed execution blocks the deployment, including recovery after restart. A later independently failed Goal outcome causes the exact version's watch to append the immediate-parent fallback; it never overwrites a newer unrelated version. Expiry or revoked authority blocks further execution and does not grant authority for new compensating actions.

`skill_deployment_status` reports persisted state and charged run IDs; `skill_watches` reports outcome observations. Identical activation retries return the original deployment without requalifying, extending it or resurrecting a rolled-back version. Different deployment parameters conflict after activation. The deployment's `max_runs` limits actual executions; a standalone watch's `max_runs` only limits observations. Outcome reconciliation follows Goals/Verifier signals and dependency restoration, using the existing service lifecycle.

## Trusted pipe protocol

The CLI writes a `ready` message using protocol `assistant-skills/holdout-ipc/v1`, then accepts bounded NDJSON requests `{id, operation, value?}` on stdin. Responses are `{id, ok, value}` or a generic rejection; raw dataset, key or internal errors are never included. Do not expose this pipe as an agent tool.

| Operation | Input | Result |
| --- | --- | --- |
| `begin` | Exact scope/baseline/candidate/budget SHA-256 digests, finite `expiresAt`, `repeats` (2–4) | Frozen public identity, actual limits and cell count; no answers or inputs |
| `next` | None | One signed cell with its arm digest and stdin; no expected output |
| `record` | Exact cell/arm, actual stdout, exit code or null, quiescent/status, artifact digest, bounded tool-call observations | Authority-derived achieved/not-achieved/unknown |
| `finish` | None | Signed public receipt with per-cell verdicts, observation digests and `complete`; no input/output bodies |

Only one cell can be outstanding. Cells alternate arm order and preserve case/repeat identity. Neither duplicate settlement nor a second `next` can repeat work. `unknown`, non-quiescence, expiry or recovery of an outstanding cell ends the qualification conservatively; the report marks unexecuted remaining cells unknown and `complete: false`. A failed program with a known exit code can still satisfy a case whose specification expects that exit code; unknown execution cannot.

Each successful operation commits state before emitting its response. SQLite uses full synchronous durability and an eight-second controller lease renewed every two seconds. A concurrent controller is rejected. Clean shutdown releases the lease; after a crash, wait for the actual persisted lease to expire before reconnecting. An issued cell without a durable result is never reissued. A result committed before its response was lost remains settled. Restoring with changed data, key or limits fails closed.

The authority library and signature helper are available from `@dsh-enhanced/assistant-skills/holdout-authority`. Signatures must be checked against the pinned public key, exact profile digest and exact expected qualification/admission identity. Serialized public authority state excludes raw cases and private keys. In prospective mode, the private SQLite database additionally retains the generated dataset and certificate for recovery; it must remain outside candidate access.

## Validation and remaining gates

Package tests cover signature/binding tampering, limits, single-cell admission, private file permissions, controller exclusion, real process crashes immediately after commit but before acknowledgement, and recovery. The container test uses the production Host pipe, a separately mounted authority and actual `IsolatedVerifierRunner` jobs; a candidate that attempts to access the authority data/key or Docker socket must not gain access.

Run these tests with two explicit locally installed immutable images:

```sh
DSH_ISOLATION_TEST_IMAGE=sha256:CANDIDATE_IMAGE_DIGEST \
DSH_HOLDOUT_TEST_IMAGE=sha256:AUTHORITY_NODE_IMAGE_DIGEST \
pnpm --filter @dsh-enhanced/assistant-skills exec vitest run tests/holdout-cli.spec.ts
```

The candidate image needs the existing Isolation `/bin/sh` and `/bin/busybox` contract. The authority test image additionally needs `/usr/local/bin/node`; no image is automatically pulled. Test data and programs are explicit synthetic fixtures, not evidence of model improvement or production historical independence.

The existing in-process `SealedSkillHoldoutProvider` remains a compatibility binding and does not acquire stronger trust from this CLI. Prospective canary requires the independently configured authority, fair measured comparison, critical regressions, explicit finite deployment authority, and a bound rollback watch. The package integration for the topology profile runs the genuine authority CLI, immutable Docker execution, Skills store/deployment/watch recovery and exact rollback path. Its Goals summary is a faithful Host-capability fixture; Goals' aggregation from actual snapshots is verified independently in the Goals package. Engineering fixture gains do not establish improvement on real user tasks, and none of these profiles proves historical holdout independence. No calendar observation period is required, but those functional gates remain mandatory.
