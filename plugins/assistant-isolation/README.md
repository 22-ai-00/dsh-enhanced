# Assistant Isolation

`@dsh-enhanced/assistant-isolation` adds `isolation_run` to the native DSH ToolRuntime. An operator grants a finite number of offline shell jobs to one authenticated owner, workspace and agent preset. Each job receives only explicitly supplied text files in a fresh scratch directory. Results and artifacts are untrusted process output; exit code zero does not establish that a user goal was achieved.

This is the first actual isolation component of autonomy work packages 08–10. External action/credential brokerage, rollback/compensation and installer bootstrap remain separate delivery requirements. It does not isolate arbitrary Host plugins or replace the native AgentLoop. The Host, Docker daemon, configured image and local operator remain trusted. Each workspace uses a private tmpfs volume with byte and inode hard limits. A persistent pool bounds admitted worker/workspace/keeper reservations across this ledger; it is not a machine-wide guarantee against Docker/kernel overhead or unrelated workloads. Do not treat this initial component as a complete hostile-code production platform.

## Installation

```sh
dsh plugin --profile <profile> add @dsh-enhanced/assistant-isolation
```

Required Host services: `agents`, `tools`, `assistantDelivery`, and `assistantPolicy`. The bundle is independently publishable; installing it does not install or activate peers. Without the services it does not register an execution tool. With no grants it does not execute jobs. No Docker image is downloaded by the plugin.

The supported execution path is a non-root Linux Host process with access to a local Docker daemon at `/var/run/docker.sock`. Configure an already-present, operator-reviewed image **ID** (`sha256:` plus 64 hexadecimal digits), containing `/bin/sh`, a trusted `/bin/busybox` with `sleep`, `stat` and `cat`, and the commands needed for the task. Image-declared `VOLUME` entries are rejected to prevent extra writable Docker volumes. A tag or remote repository digest is not accepted as a substitute for the local immutable image ID. Other platforms or failed Docker operations do not fall back to a Host shell.

## Configuration

```yaml
stateRoot: /absolute/private/assistant-isolation
image: sha256:<64-hex-local-image-id>
dockerPath: /usr/bin/docker
maxConcurrentJobs: 2
maxReservedMemoryMiB: 2048
maxReservedWorkspaceInodes: 32768
grants:
  - id: offline-maintenance
    revision: 1
    principalDigest: <sha256-of-the-authenticated-Delivery-principalId>
    principalRecordId: <current-Delivery-owner-record-id>
    principalVersion: 1
    workspace: /absolute/canonical/project
    agentPreset: primary
    expiresAt: <finite-UTC-epoch-milliseconds>
    maxRuns: 20
    maxTotalDurationMs: 1200000
limits:
  maxDurationMs: 60000
  maxInputBytes: 1048576
  maxOutputBytes: 65536
  maxArtifactBytes: 262144
  maxFiles: 32
  memoryMiB: 256
  workspaceMiB: 64
  workspaceInodes: 4096
  pidsLimit: 64
  cpus: 1
```

Replace the placeholders with the operator's current owner record and runtime configuration. `isolationPrincipalDigest()` is exported for trusted Host configuration tooling. Model arguments cannot supply an owner or create/extend a grant. Policy must allow `execute` on `{ kind: 'tool', id: 'isolation:<grant-id>' }` for the exact scope; ordinary native tool approval remains in force and is not bypassed by this bundle.

The workspace value identifies the authorized task; **the project directory is not mounted**. The tool accepts `grant_id`, `idempotency_key`, `command`, optional `files: [{ path, content }]`, `artifacts: [relativePath]` and `timeout_ms`. Paths must be canonical relative paths. Inputs and requested artifacts have finite count/byte limits, including path text and staged parent inode counts. Inputs are copied into a fresh quota volume; no Host directory is mounted in either container. After the execution container is removed, a separate keeper container retains the volume while the trusted supervisor checks each artifact with absolute-path BusyBox commands. Only regular UTF-8 files without symlink parents or hard links can be exported within one total byte budget. The keeper and volume must then be removed before the result reports quiescence. Binary/invalid UTF-8 console data is omitted; decoded output never expands past the configured byte limit.

Within a configured workspace/preset, the model can call only `isolation_run`, `goal_context` and `goal_checkpoint`. This also blocks Host `bash`, `run_code` and subagent dispatch through ToolRuntime. Revocation or expiry does not release that restriction while the configured scope remains loaded. This is trusted Host routing around the OS-isolated worker; a trusted operator can change or remove the plugin configuration.

## Authorization, stop and recovery

The private SQLite WAL ledger binds each job to exact owner lineage, grant revision, request/image/limits digest, owning Session, idempotency key and absolute deadline. Run count and reserved duration are consumed before creation and are not refunded on failures. Grant IDs retain cumulative usage across revisions. Same-key exact requests return the original outcome; changed requests are rejected. An unknown outcome is never automatically re-executed or promoted to success. Reusing a revoked grant revision cannot reactivate it.

Schema v3 migrates existing v1/v2 job records without erasing them. Before any supervisor can receive create authority, the Host durably commits a fenced `supervisor-spawn-intent`; a crash between fork and the later running-state CAS therefore cannot look like an unstarted job. Legacy records lack this proof and are conservatively treated as already dispatched. Each new job reserves `memoryMiB + workspaceMiB + 32` MiB (worker limit, workspace capacity, and keeper limit) and `workspaceInodes` in the same transaction as grant usage. Prepared/running jobs and all unconfirmed cleanup retain their reservations; an active legacy job with unknown resource use prevents new reservations. Unknown dispatched jobs retain occupancy even after exact-name removal; only jobs durably known never to have been dispatched can use ordinary recovery to release it. Changing pool settings cannot retroactively release reservations. The pool applies to this state root, so separate state roots need an operator-managed aggregate budget.

The native tool cancellation signal (including Agent cancellation), current owner/Policy changes, grant revocation and service disposal stop running jobs. The controller polls authorization every 250 ms while active. A detached supervisor watches the job deadline and Host IPC independently; losing the Host IPC initiates container termination, state inspection and removal, including `setsid` descendants. Stop is asynchronous, with bounded Docker control calls. The plugin reports `quiescent: false` and `unknown` when it cannot confirm cleanup. It cannot undo instructions already executed before a stop was observed. A timed-out creation acknowledgment remains `docker-creation-unconfirmed` and holds its reservation even across Host restart: current object absence alone does not prove a pending daemon request completed. The same protection covers other unknown outcomes after dispatch, including supervisor exit, IPC loss and runner exceptions. Private diagnostic witnesses capture the Linux boot ID, process PID/start ticks and Docker Engine ID around a final supervisor receipt when available. They are stored separately from model-visible results. A restart candidate is not a release authorization: trusted socket-to-daemon binding and an independently proven stop barrier remain operational requirements; do not delete the ledger to force capacity release.

An operator can revoke from a separate terminal, without calling the model:

```sh
dsh-isolation revoke /absolute/private/assistant-isolation offline-maintenance 1
# Optional absolute Docker executable for deployments using another path:
dsh-isolation revoke /absolute/private/assistant-isolation offline-maintenance 1 /absolute/docker
```

This persists revocation first and attempts to remove this grant's exact UUID-named execution containers, keeper containers and workspace volumes. `containersRemoved` reports those removal attempts, not an atomic barrier against an already in-flight Docker request. A running controller also rejects any subsequent start and polls revocation. Return code 2 means cleanup was not confirmed; retain the ledger and investigate Docker availability. Credentials and external action leases are outside this offline entry point.

A durable 30-second controller lease with fencing prevents two live controllers from recovering or spending the same ledger. Heartbeats run every 5 seconds; losing the fence stops jobs and forbids stale outcome writes. A replacement can claim an expired controller lease, walk all recovery pages and remove old execution/keeper containers and workspace volumes without replaying their commands. Recovery retains unknown execution outcomes even when later removal succeeds. The controller ledger must not be deleted to clear an unknown job or exhausted budget.

## Authority and limits

| Surface | Authority |
| --- | --- |
| Filesystem | Host owns a `0700` state directory, `0600` ledger and per-job staging. The worker sees its byte/inode-limited tmpfs workspace plus its configured image. Console/artifact results and diagnostic witnesses persist in the private ledger. The Host reads Linux `/proc`, the protected `/run/docker.pid`, and socket metadata for best-effort diagnostics; missing metadata never grants release. No writable Host bind is exposed. Audit/result retention remains pending; a workspace quota does not bound cumulative ledger growth. |
| Network | Host uses the fixed local Docker Unix socket. The worker has `--network none`, no Host socket/config mount and no external action endpoint. |
| Subprocess | Host starts the fixed configured Docker executable and packaged detached Node supervisor. Workers run `/bin/sh` with non-root UID/GID, read-only image filesystem, dropped capabilities, `no-new-privileges`, memory/CPU/PID limits, bounded `/tmp` and `/dev/shm`, and disabled Docker log storage. A fixed BusyBox keeper retains the job volume across execution-container removal and does not execute job code. |
| Credentials | Worker receives no Host environment or credential files. The Docker daemon access itself is a privileged trusted Host capability. Images must contain no embedded secrets. |
| Browser | None. |
| Install scripts | No runtime provisioning, image pull or privileged install hook. Standard package build/prepack only. |

Whole-machine failure, Docker daemon failure, disk exhaustion and untrusted Host plugins are not solved by IPC cleanup. Unknown jobs remain visible in the ledger and consume active capacity when quiescence is unconfirmed. The same Host user can inspect or modify this database; it is protected from the container worker, not from the trusted operator. Partial scratch cleanup failures are not proof of execution failure and may require operator cleanup once the container is confirmed stopped.

## Verification

```sh
CI=true DSH_ISOLATION_TEST_IMAGE=sha256:<local-image-id> pnpm check
```

Without the environment variable, Docker tests are explicitly skipped. With it, tests use actual containers and the native AgentLoop/ToolRuntime; only the model, Delivery identity and Policy approval in the focused integration fixture are controlled seams. Separate tests exercise Host file/socket/environment separation, a Host HTTP canary, configured cgroup restrictions, workspace exhaustion, output/IPC separation, cancellation, and Host process-group death. Filesystem quota and storage lifecycle probes use actual Docker resources; no image is pulled. These are not evidence of a real cloud model, external account, full user profile or all autonomy work packages being complete.

The optional identity probe `python3 scripts/isolation/daemon-witness-probe.py` runs from the repository root after a build. It requires Python 3, rootlesskit/dockerd and unprivileged Linux namespaces, starts only private rootless daemons, and leaves inspectable logs under `/tmp`. It verifies a real restart, stable Engine ID, changed PID/start ticks, live-process rejection and a surviving volume. Its limited UID/GID map and absent cgroup delegation do not establish worker isolation or production release authority.
