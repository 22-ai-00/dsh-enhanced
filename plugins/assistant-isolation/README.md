# Assistant Isolation

Host-only `inspectIsolationGrant({ stateRoot, grant, now? })` supplies a read-only schema 7/8 snapshot for operator diagnostics. It compares every configured grant field with persisted authority and reports revocation, expiry, historical run/duration reservations across revisions, and active/unknown jobs. It never creates or migrates a database, claims a controller, renews authority, refunds reservations, or returns commands/artifacts. Missing, unsupported or corrupt state is unavailable. `available` refers only to these grant checks; the Web owner doctor combines it with owner checks and a real temporary isolation probe. It is not a Policy, resource-admission or complete autonomy verdict.

After a Host crash, startup waits up to 31 seconds for the previous controller's
30-second lease to expire naturally. The service and its injected consumers stay
pending until controller acquisition and recovery finish. An owner that keeps
renewing is never forcibly replaced; expiry is not rewritten, and uncertain jobs
retain their existing recovery rules. Unloading during the wait cancels admission
and closes the ledger without a later claim. Startup supervisors must allow this
lease interval plus ordinary boot time before treating readiness as a failure.

`@dsh-enhanced/assistant-isolation` adds `isolation_run` to the native DSH ToolRuntime. An operator grants a finite number of offline shell jobs to one authenticated owner, workspace and agent preset. Each job receives only explicitly supplied text files in a fresh scratch directory. Results and artifacts are untrusted process output; exit code zero does not establish that a user goal was achieved.

This is the first actual isolation component of autonomy work packages 08–10. External action/credential brokerage, rollback/compensation and installer bootstrap remain separate delivery requirements. It does not isolate arbitrary Host plugins or replace the native AgentLoop. The Host, local operator, configured runtime and kernel remain trusted; the Docker backend also trusts its daemon and image. Each workspace uses a private tmpfs volume with byte and inode hard limits. A persistent pool bounds admitted worker/workspace/keeper reservations across this ledger; it is not a machine-wide guarantee against runtime/kernel overhead or unrelated workloads. Do not treat this initial component as a complete hostile-code production platform.

## Native Linux building blocks

The Host-only `runLinuxNamespace`, `LinuxCgroupLease`, and `LinuxRuntime`
exports provide Docker-free execution on non-root Linux. The public tool accepts
explicit `backend: 'linux-native'` configuration; the private verifier also
accepts `LinuxVerifierRunnerConfig` below. Omitting `backend` retains Docker
configuration semantics. Production setup still selects its existing backend
until installation and owner migration are integrated.

`runLinuxNamespace` uses fixed `unshare`, mount, bubblewrap and Python/libseccomp
programs, with a shipped digest-checked syscall policy. It exposes system runtime
directories and explicit read-only runtime roots, creates bounded workspace/tmp
tmpfs mounts, and uses a 1 MiB shared-memory mount. The candidate has UID/GID
65534, no effective capabilities, no network, a private PID view and a clean
environment. It cannot see Host Home, sysfs, credentials or control sockets.
Only the repository profile allows nested user namespaces for repository tests.
The caller must keep exposed runtime roots free of secrets. Input and exported
UTF-8 artifacts have separate 1 MiB bounds. The separate repository API below
provides binary transport without expanding this text API's permissions.

The keeper's fixed gate waits for `beforeKeeperStart` before unshare, mounts or
staging. A separate candidate gate waits until `beforeStart` admits its exact
PID/start time to resource controls. `afterExit` must prove the candidate group
quiet before export; `onStop` must reconcile it after cancellation or failure.
Callback failure or timeout returns `unknown`. The trusted keeper independently
revokes work on Host disconnect or deadline. `namespaceExited` only proves that
keeper's close; it is not a durable resource-cleanup or task-success receipt.

`LinuxCgroupLease` configures and reads back CPU, memory including swap, and PID
limits in pre-delegated v1 controllers. Admission is one-shot; shutdown fences
late admission and uses freezer/pidfd checks before proving all groups empty.
Recovery checks boot, owner and directory identities. V2 admission is currently
rejected because its process-placement path has not been verified. The caller
still owns pre-creation durable intent, controller exclusivity, orphan recovery,
keeper resource reservations, authorization and budgets. The repository's
one-time delegation script is an operator provisioning aid, not a privileged
runtime broker or a sudo rule for a writable checkout.

`LinuxRuntime` verification binds Node, native pnpm, frozen dependencies and
retained store/cache to device/inode and deterministic tree hashes. It rejects
outside links, writable contents and drift. None of these exports activates a
service, reads provider credentials, accesses a browser, downloads images or
runs an install lifecycle script. See the [delivery boundary](../../docs/dockerless-runtime.md)
for remaining integration and acceptance.

### Public native execution

Configure `backend: 'linux-native'` and `linux: { runtime, cgroupRoots }` alongside
the existing `stateRoot`, finite `grants`, limits and storage policy. `runtime`
is the digest-pinned `LinuxRuntime` prepared by the native toolchain bootstrap;
`cgroupRoots` identifies the current user's verified v1 controller delegation.
The synchronous Cordis Config rejects invalid bindings and insufficient pools;
service readiness and every newly admitted request recheck the runtime tree.
This branch does not require an image or resolve a Docker socket.

`isolation_run` keeps its existing request, owner/Policy checks, goal artifact
binding and cancellation contract. Inline files enter a fresh bounded workspace;
exported artifacts come back only after cleanup proof. Node and pnpm use the
pinned runtime PATH. The ledger reserves worker, keeper, workspace, temporary
and shared-memory allowances before dispatch. Changing backend or contract
under an existing idempotency key is a conflict and never creates a new job.

Startup and background recovery use each job's persisted backend. Native cleanup
uses the original contract and private receipts; a native-configured service
leaves historical Docker unknown resources occupied for their original cleanup
path. Switching configuration does not extend grants or reset budgets.

`dsh-isolation probe-native /absolute/runtime-config.json` accepts an owned JSON
file containing exactly `{ runtime, cgroupRoots }`. It tests pinned Node,
non-root execution, a canary artifact and actual cleanup without Docker or a
production grant. Unproven cleanup retains its private evidence directory.
`reconcile /absolute/private/state-root` dispatches cleanup by persisted backend;
Docker arguments are unused for a native-only ledger. `revoke` first persists
revocation and lets a live controller stop its work. For pending native jobs it
also reports `nativeResourcesQuiescent` and `nativeRetained`; exit 2 indicates
that cleanup is not yet confirmed. It never takes over a live controller.

Positive result retention first commits the ledger's result digest, then
replaces native journal/receipt bodies with digest-only records. Interrupted
replacement is retried with the same controller and row-version checks. Unknown
or unproven work retains its recovery evidence; the default zero-retention
policy keeps all bodies. Cached results continue through the ledger and cannot
replay execution after body pruning.

### Durable native verification

`IsolatedVerifierRunner` accepts either the existing Docker configuration or an
explicit `backend: 'linux-native'` configuration with a verified `LinuxRuntime`
and delegated `cgroupRoots`. `LinuxVerifierRunner` is also exported directly.
The API remains `run(key, artifact, stdin, signal)` and `close()`; the fixed
operator command receives `artifact` and `input` files in the private workspace.
Its PATH uses the pinned runtime's Node/pnpm. Ordinary agent tools do not receive
this constructor or the verifier's authority.

The native backend reuses the same schema 8 ledger, finite verification grant,
controller lease, idempotency key and resource pool. It keeps execution records
in a private `linux-executions` child directory. Kernel resource identity and a
durable create intent precede execution. Worker and keeper have separate groups;
the keeper has 128 MiB memory including swap, 64 PIDs and 0.5 CPU. Reservations
include both groups plus workspace, temporary and shared-memory allowances.
Runtime drift, lost authorization or controller fencing stops new admission.

The shared `prepareLinuxExecutionIntent` / `runLinuxExecution` helpers own the
durable journal, both group lifetimes and private receipts. Recovery reads
original identities and proves actual group/workspace absence. A missing or
partial creation record never grants permission to run the command again or to
signal an unidentified process. Proven cleanup releases active capacity while
preserving an existing unknown result and its consumed run/duration budget.
Historical Docker/macOS rows retain their own backend identity; switching this
API does not reconcile those external resources or reset their grants.

These APIs still require non-root Linux with verified v1 delegation and the
fixed namespace dependencies. Installer migration, behavior certificates and
release/adoption remain separate integration steps. V2, arm64 execution and a reboot with changed kernel
resource identity remain outside the current live acceptance.

### Durable repository execution

Host-only `prepareLinuxRepositoryIntent`, `runLinuxRepositoryExecution`,
`readLinuxRepositoryReceipt` and `reconcileLinuxRepositoryExecution` share the
same durable execution engine. They require an explicit schema 2 or 3 repository
contract, a frozen command/archive/artifact binding, and caller-owned finite
authorization and controller admission. This is not an agent-visible tool or a
complete source-build adapter.

`runLinuxRepositoryNamespace` transports a SHA-256-bound archive of at most
64 MiB through a dedicated input pipe and a read-only `/input/source.tar` mount.
It exports at most 32 MiB of binary artifacts through a separate pipe after the
candidate group is proven quiet. Neither transport pipe reaches the candidate.
Repository limits allow an 8 GiB workspace, 4 GiB executable temporary mount,
nested namespaces and a 30-minute deadline. Ordinary execution retains its
existing bounds and non-executable temporary mount.

The durable receipt contains artifact paths, lengths and hashes; bytes remain in
an owner-only bounded spool. Reading a successful receipt rechecks both kernel
absence and spool integrity. Failed or unknown executions return no binary
artifacts, and a recovered identity never dispatches the command again. Partial
creation and failed writes retain their original recovery fences.

`linuxJobResourceReservation` includes every tmpfs, keeper capacity and durable
spool; the ledger enforces these minima for both repository schemas. At the maximum artifact
size, the execution spool and journal allowance is 108 MiB. A caller that stages
its own archive or output pack must reserve that additional storage before
staging.

Schema 3 additionally binds a `userNamespace` mapping, `systemSnapshot` and the
packaged execution implementation digest. It uses the owner's existing
`/etc/subuid` and `/etc/subgid` allocation and digest-pinned, system-owned
`newuidmap`/`newgidmap` helpers; execution never allocates or widens those ranges.
Namespace UID/GID 0 map to the Host owner, and candidate UID/GID 65534 map to the
allocated subordinate identity. The fixed entry drops UID/GID privileges, clears
supplementary groups and all capabilities, enables no-new-privileges and waits for an independent Host
check before executing candidate code. The Host persists both namespace and
candidate witnesses before START. An absent witness can prove a failed setup
quiet, but cannot authorize candidate execution or a successful result.

The system snapshot copies a fixed closure of system tools and shared
libraries from trusted root-owned paths, bounded to 640 MiB and 32,768 entries.
An optional verified `LinuxRuntime` supplies only its pinned Node executable at
`/usr/bin/node`; separate provenance binds that copy to the runtime and its
original Node digest. This supports nested repository tests without depending
on a Host Node installation. The snapshot hashes the inventory and bytes,
rewrites only internal symlinks and mounts the result read-only; it does not
mount the Host's `/etc` or mutable executable search paths. Schema 3 provides a
fixed `dsh-sandbox` hostname and a read-only synthetic `/etc/hostname`. A separate 8 MiB /
16,384-inode identity mount is included in schema 3 reservations. Recovery uses
the original namespace ancestry, PID start times, freezer membership and pidfds
before terminating descendants; allowing a subordinate UID alone is insufficient.
Schema 1/2 jobs retain their original single-identity cleanup interpretation.

Host-only `LinuxRepositoryRunner` adds a private, immutable finite authority,
controller lease and schema 8 ledger to these repository primitives. It reserves
capacity before calling the archive factory, freezes the archive digest and
command under the source-job key, and passes a cancellation signal to the
factory. Factory deadlines, grant expiry and controller loss abort that signal
before settling the job. A trusted factory must honor cancellation and await its
child processes; the runner does not isolate arbitrary Host callbacks.

The runner reserves another 256 MiB of Host staging memory and 96 MiB of staging
storage in addition to the execution minima. Reopening the same authority keeps
its original expiry and consumed run/duration budget. A repeated key never
reruns the factory or command; binary results require the original successful
receipt, intact spool and fresh resource-absence proof. Foreign ledgers are
rejected before migration or controller acquisition. `close()` fences admission
and waits for active work and recovery.

A private, single-use admission refusal can prove that this call never created
an execution. It is valid only for the original runner, request, controller and
state-directory/database identities; a concurrent or later call with the same
key invalidates it. Ledger refusals require a known rejection before any insert
and a confirmed rollback. Callers consume the proof after their own cleanup,
immediately before settling their original task. Missing records, uncertain
database errors and historical interrupted calls do not provide this proof;
`inspectQuiescence()` still returns `unknown` for a missing key. No spent budget
is refunded and no command is replayed.

Providing both `userNamespace` and `systemSnapshot` selects schema 3; omitting
both retains schema 2. Mixed or partial configuration is rejected. A ledger
containing one repository schema cannot be reopened as the other schema.

Control Plane's explicit Linux source-build adapter uses this runner for exact
Git-tree preparation, frozen offline installation, root `pnpm check` and pack
verification. Behavior verification and release/adoption still need their own
native integration; repository execution alone does not authorize adoption.

## Native macOS execution primitive

The Host-only `runNativeMacProcess` export runs one digest-pinned Node process
under `/usr/bin/sandbox-exec`, without Docker. Its deny-default policy permits
only system runtime reads, explicitly approved canonical runtime roots and a
private workspace. The workspace is read-only unless the trusted caller explicitly
sets `workspaceWritable: true`. Network and child processes are denied; file
access is limited to these approved paths. Strict ancestors receive exact
metadata access for Node ESM path resolution. macOS Node startup additionally
requires directory-data access to literal `/`, exposing only the root directory's
top-level names; unapproved descendants and other ancestors remain unreadable.
Runtime roots are bound to their device/inode; the executable is checked against
its approved SHA-256 before dispatch. A trusted caller can set
`sourceType: 'module'` for fixed ESM source; the primitive's default remains
CommonJS. The child receives a clean environment,
bounded input/output and a finite deadline. Cancellation and timeout kill the
process; only a confirmed process close reports `quiescent: true`.

This is a low-level building block, not an alternate backend for `isolation_run`
or `IsolatedVerifierRunner`. The caller must own authorization, durable budget
reservation, idempotency, crash recovery and safe staging. Keep runtime roots
minimal and free of credentials. Approval covers every readable file under a
runtime root, including existing hard-link aliases; directory device/inode checks
do not authenticate its contents. The caller must provision trusted runtime
contents and exclude aliases to unrelated Host files. Workspace staging rejects
symbolic links, hard links and special files before dispatch.
Writable workspaces have no hard disk quota; this primitive also has no hard
memory or CPU quota. Do not infer Docker resource limits or a complete native
RSI installation from a successful invocation. Native tests run on macOS and
use only temporary canaries, an ephemeral loopback listener and disposable
processes; they require no Docker installation.

The Host-only `NativeMacVerifierRunner` adds a durable finite grant to this
single-process primitive. Its `backend: 'macos-seatbelt'` configuration pins an
approved `NativeMacRuntime` (Node SHA-256, root device/inode and deterministic
tree hashes, module directory, package versions) and a fixed trusted Node
source. `run(key, files, stdin, signal)` stages bounded text files in a fresh
read-only worker workspace. `inspectQuiescence(key)` returns `quiescent` only
when the private supervisor close receipt matches the ledger job, input digest
and nonce. The detached supervisor kills its candidate when the Host IPC
disconnects; an absent or invalid receipt leaves the job `unknown`, occupies
active capacity and cannot be replayed. A new Host must wait for the old
controller lease to expire before recovering it. The private native state
root is bound separately from Docker state and is never a runtime read root.
Runtime tree hashing rejects special files, hard links, external symbolic
links and group/world-writable contents; internal pnpm links are allowed only
when their resolved targets remain inside the same root. Admission bounds runs,
cumulative duration, concurrent jobs and observed storage growth. Seatbelt
does not provide hard memory, CPU or disk quotas for this runner. It is a
trusted verifier API, not the public `isolation_run` tool.

## Installation

```sh
dsh plugin --profile <profile> add @dsh-enhanced/assistant-isolation
```

Required Host services: `agents`, `tools`, `assistantDelivery`, and `assistantPolicy`. The bundle is independently publishable; installing it does not install or activate peers. Without the services it does not register an execution tool. With no grants it does not execute jobs. No Docker image is downloaded by the plugin.

The Docker backend supports a non-root Linux or macOS Host process with access to a local Docker daemon. Linux defaults to `/var/run/docker.sock`; macOS defaults to the current user's Docker Desktop socket at `~/.docker/run/docker.sock`. The socket must exist at runtime and remain the same local Unix socket through creation, execution and cleanup. macOS requires an owner-owned socket and private Docker run directory; a remote `DOCKER_HOST`, Docker context or socket path outside that user directory is never used. Configure an already-present, operator-reviewed image **ID** (`sha256:` plus 64 hexadecimal digits), containing `/bin/sh`, a trusted `/bin/busybox` with `sleep`, `stat` and `cat`, and the commands needed for the task. Image-declared `VOLUME` entries are rejected to prevent extra writable Docker volumes. A tag or remote repository digest is not accepted as a substitute for the local immutable image ID. Failed Docker operations do not fall back to a Host shell.

## Configuration

```yaml
stateRoot: /absolute/private/assistant-isolation
image: sha256:<64-hex-local-image-id>
dockerPath: /usr/bin/docker
# Optional: socketPath: /Users/<owner>/.docker/run/docker.sock on macOS.
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

Replace the placeholders with the operator's current owner record and runtime configuration. `isolationPrincipalDigest()` is exported for trusted Host configuration tooling. Model arguments cannot supply an owner or create/extend a grant. Policy must allow `execute` on both `tool:isolation_run` and `tool:isolation:<grant-id>` for the exact scope. Matching finite-grant preauthorization can skip the redundant risk prompt; native Policy denials, call budgets and other guards remain in force (details below).

The workspace value identifies the authorized task; **the project directory is not mounted**. The tool accepts `grant_id`, `idempotency_key`, `command`, optional `files: [{ path, content }]`, `artifacts: [relativePath]` and `timeout_ms`. Paths must be canonical relative paths. Inputs and requested artifacts have finite count/byte limits, including path text and staged parent inode counts. Inputs are copied into a fresh quota volume; no Host directory is mounted in either container. After the execution container is removed, a separate keeper container retains the volume while the trusted supervisor checks each artifact with absolute-path BusyBox commands. Only regular UTF-8 files without symlink parents or hard links can be exported within one total byte budget. The keeper and volume must then be removed before the result reports quiescence. Binary/invalid UTF-8 console data is omitted; decoded output never expands past the configured byte limit.

Within a configured workspace/preset, the model sees only the same named surface that the Host routing guard accepts: `isolation_run`, `isolation_grants`, `goal_context`, `goal_checkpoint`, and the fixed preauthorized goal or GitHub broker tools when installed. It does not see Host filesystem, shell, `run_code`, or subagent tools. This presentation applies only after the live Agent resolves to the current Delivery owner lineage and exact workspace/preset; ordinary or unbound Agents keep their normal tool surface. A scoped model-facing system section states that each `isolation_run` gets a fresh scratch workspace, accepts starting material only as inline files, and has no Host project mount or network. It contains no Host path, credential, task answer, or tool-call sequence. Revocation or expiry does not release the configured scope restriction while the bundle remains loaded. This is trusted Host routing around the OS-isolated worker; a trusted operator can change or remove the plugin configuration.

## Authorization, stop and recovery

The private SQLite WAL ledger binds each job to exact owner lineage, grant revision, request/image/limits digest, owning Session, idempotency key and absolute deadline. A private state-root marker binds recovery to the configured Docker socket path; changing that path requires a separate state root. Legacy Linux ledgers without the marker can only continue on their original `/var/run/docker.sock`. Run count and reserved duration are consumed before creation and are not refunded on failures. Grant IDs retain cumulative usage across revisions. Same-key exact requests return the original outcome; changed requests are rejected. An unknown outcome is never automatically re-executed or promoted to success. Reusing a revoked grant revision cannot reactivate it.

Schema v6 migrates existing v1/v2/v3/v4/v5 job records without erasing them. It retains the v5 rule that, before any supervisor can receive create authority, the Host durably commits a fenced `supervisor-spawn-intent`; a crash between fork and the later running-state CAS therefore cannot look like an unstarted job. Legacy records lack this proof and are conservatively treated as already dispatched. Each new job reserves `memoryMiB + workspaceMiB + 32` MiB (worker limit, workspace capacity, and keeper limit) and `workspaceInodes` in the same transaction as grant usage. Prepared/running jobs and all unconfirmed cleanup retain their reservations; an active legacy job with unknown resource use prevents new reservations. Unknown dispatched jobs retain occupancy after ordinary exact-name removal. A separate reconciliation path can release resource reservations only with the complete request receipt and stop evidence described below. Jobs durably known never to have been dispatched can still use ordinary recovery. Changing pool settings cannot retroactively release reservations. The pool applies to this state root, so separate state roots need an operator-managed aggregate budget.

The native tool cancellation signal (including Agent cancellation), current owner/Policy changes, grant revocation and service disposal stop running jobs. The controller polls authorization every 250 ms while active. A detached supervisor watches the job deadline and Host IPC independently; losing the Host IPC initiates container termination, state inspection and removal, including `setsid` descendants. Stop is asynchronous, with bounded Docker control calls. The plugin reports `quiescent: false` and `unknown` when it cannot confirm cleanup. It cannot undo instructions already executed before a stop was observed. A timed-out creation acknowledgment remains `docker-creation-unconfirmed` and holds its reservation even across Host restart: current object absence alone does not prove a pending daemon request completed. The same protection covers other unknown outcomes after dispatch, including supervisor exit, IPC loss and runner exceptions. Private diagnostic witnesses capture the Linux boot ID, process PID/start ticks and Docker Engine ID around a final supervisor receipt when available. They are stored separately from model-visible results. A restart candidate is not a release authorization: trusted socket-to-daemon binding and an independently proven stop barrier remain operational requirements; do not delete the ledger to force capacity release.

A final supervisor receipt now records whether every create/start/copy/exec command returned normally and every CLI closed. On Linux, when that private `requestsSettled` flag is true, the original supervisor has exited, and the exact Docker daemon generation is unchanged, the Host can remove and independently inspect all three UUID-named resources. A fresh opaque cleanup receipt, the original witness, current controller fence and job version are required in the same ledger transaction to release reservations. macOS does not fabricate Linux process witnesses; an unknown dispatched job retains its reservation pending a separately proven stop barrier. The original `unknown` outcome, output, run count and consumed duration remain unchanged; commands are never replayed. The audit stores the exact resources and their removal/absence observations.

The live Host checks a bounded page of pending records every five seconds without overlapping sweeps. With the Host stopped, an operator can invoke the same path:

```sh
dsh-isolation reconcile /absolute/private/assistant-isolation
# Optional Docker executable:
dsh-isolation reconcile /absolute/private/assistant-isolation /absolute/docker
```

The command reports checked, released and retained counts and refuses to take over a live controller. Legacy receipts, interrupted mutating calls (including timeout or output overflow of `start --attach` or artifact `exec`), missing final IPC, and changed daemon generations retain occupancy. Systemd socket/service invocation metadata is diagnostic only: daemon restart does not prove containerd/shim execution stopped. Automatic release of these ambiguous cases is still unsupported.

An operator can revoke from a separate terminal, without calling the model:

```sh
dsh-isolation revoke /absolute/private/assistant-isolation offline-maintenance 1
# Optional absolute Docker executable for deployments using another path:
dsh-isolation revoke /absolute/private/assistant-isolation offline-maintenance 1 /absolute/docker
```

This persists revocation first and attempts to remove this grant's exact UUID-named execution containers, keeper containers and workspace volumes. `containersRemoved` reports those removal attempts, not an atomic barrier against an already in-flight Docker request. A running controller also rejects any subsequent start and polls revocation. Return code 2 means cleanup was not confirmed; retain the ledger and investigate Docker availability. Credentials and external action leases are outside this offline entry point.

A durable 30-second controller lease with fencing prevents two live controllers from recovering or spending the same ledger. Heartbeats run every 5 seconds; losing the fence stops jobs and forbids stale outcome writes. A replacement can claim an expired controller lease, walk all recovery pages and remove old execution/keeper containers and workspace volumes without replaying their commands. Recovery retains unknown execution outcomes even when later removal succeeds. The controller ledger must not be deleted to clear an unknown job or exhausted budget.

## Stored results and admission

`storage.maxStateBytes` defaults to 256 MiB and `storage.maxJobRecords` to 10,000. Before admitting a new key, the Host observes the entire private state tree, including SQLite/WAL/SHM and staging, and atomically reserves future growth alongside active jobs. Missing, stale, or unsafe observations reject new jobs. Existing exact idempotency keys remain readable even when observation fails or either ceiling is reached. Job rows, identities, grant usage, request digests, outcome metadata, and lifecycle audits are never deleted or refunded; controller renewals no longer append one audit row every five seconds.

This is an **observed admission guard**, not a hard disk quota: filesystem changes, SQLite WAL writers/readers, directory allocation, and unrelated Host activity can exceed an observation. The planned allowance is `6 * (maxOutputBytes + maxArtifactBytes) + maxInputBytes + 2 MiB` per active job. Reusable SQLite pages are reported but never credited against staging reservations. A separate filesystem quota remains the operator's responsibility if a hard state-root ceiling is required. Separate roots have independent budgets.

`storage.resultRetentionMs` defaults to **0 (keep all result bodies)**. A positive age explicitly permits pruning only old `succeeded`, `failed`, `cancelled`, or `timed-out` results whose workers are confirmed quiescent. All `unknown` results remain intact, including unknown-but-quiescent results. A pruned result keeps its outcome, reason, exit code and identity and adds `retention.kind: "pruned"`, format version, pruning time, SHA-256/UTF-8 byte counts for the original recursively key-sorted JSON and each body/artifact. Empty body fields with this marker mean **content was removed**, not that the command originally produced nothing. Bodies smaller than their replacement metadata are retained. Pruning does not provide secure deletion from backups, old WAL readers, or filesystem media.

The live Host checks a bounded page of 16 eligible jobs at most once per minute, cleans only their exact stopped staging directories, and checkpoints the WAL. It preserves unknown/live/orphan staging. New databases use incremental vacuum; upgraded databases retain their existing page-reuse mode without an automatic full VACUUM. A pinned reader yields `checkpoint: "busy"` and is not interrupted. Logical bytes removed are not a claim of physical bytes freed.

With the Host stopped, the operator can run the same single-page maintenance:

```sh
dsh-isolation maintain /absolute/private/state-root
# Explicitly permit pruning results older than one day:
dsh-isolation maintain /absolute/private/state-root 86400000
# Continue a page using the returned cursor:
dsh-isolation maintain /absolute/private/state-root 86400000 <after-job-id>
```

The default command keeps bodies. Maintenance rejects a competing live controller. An empty cursor ends a sweep; subsequent periodic sweeps start over. The model has no maintenance or retention-configuration tool. Reaching the permanent job-row ceiling requires an explicit operator policy change; deleting the ledger would erase idempotency and cumulative authorization evidence and is not a reset procedure.

## Worker-protected audit archive

The Host-only archive command copies the supported schema 7/8 lifecycle audit into canonical, hash-linked NDJSON batches. The archive is immutable by protocol and content address: a published batch is never overwritten, and any conflicting content is rejected; this is not an operating-system immutable-bit guarantee. The command freezes a SQLite audit high-water mark and reads only through that fixed snapshot. The main database schema and data, including audit, jobs, grants and controller state, remain unchanged; a SQLite read-only snapshot may create or use WAL/SHM coordination sidecars. Repeating an interrupted or completed export is idempotent: already committed matching batches are retained. Files are committed with private permissions using a synced exclusive temporary file, a no-overwrite hard link, temporary unlink and directory sync; a matching crash residue is recovered under the archive lock. The verifier checks the complete local batch chain, including canonical records, contiguous sequence numbers and the previous-batch digest, and reports the source binding plus external anchor tuple `{ archiveInstanceId, highestSequence, headDigest }`. An empty or control-only directory is not a verifiable archive.

Prepare two distinct canonical, operator-owned directories before running the command; neither directory may be a symlink, group/other-accessible, or the same directory. The archive command does not create or loosen the state root. For a new archive directory, use an owner-only umask and mode explicitly:

```sh
umask 077
mkdir /absolute/private/archive-directory
chmod 0700 /absolute/private/archive-directory
dsh-isolation archive-audit /absolute/private/state-root /absolute/private/archive-directory
# Optional positive page/batch size:
dsh-isolation archive-audit /absolute/private/state-root /absolute/private/archive-directory 100
dsh-isolation verify-audit /absolute/private/archive-directory
```

Both commands emit one JSON result on stdout and diagnostics on stderr. The archive root is operator storage and is never mounted or bind-mounted into a worker; workers continue to receive only their isolated quota volume and configured image. This makes the archive protected from the worker, not from the Host trust domain.

The local hash chain proves integrity and linkage relative to a trusted digest; hashes are not signatures and do not establish authenticity or nonrepudiation. A malicious or compromised same-UID Host or root can replace the database and archive, recompute the whole chain, or roll back/delete a tail (or the full archive). Local verification alone cannot detect those attacks. After each successful export, preserve `{ archiveInstanceId, highestSequence, headDigest }` in a protected external monotonic store and compare it during later verification; detection of whole-chain replacement and tail/full rollback depends on that external anchor.

## Authority and limits

| Surface | Authority |
| --- | --- |
| Filesystem | Host owns a `0700` state directory, `0600` ledger and per-job staging. A separate operator-owned `0700` audit archive may contain canonical hash-linked NDJSON batches; neither state nor archive root is mounted or bind-mounted into a worker. The worker sees its byte/inode-limited tmpfs workspace plus its configured image or approved native runtime roots. Console/artifact results and diagnostic witnesses persist in the private ledger. The Host reads Linux `/proc`, the protected `/run/docker.pid`, and socket metadata for best-effort diagnostics; missing metadata never grants release. No writable Host bind is exposed. Observed storage admission and opt-in result retention are described below; they are not a hard filesystem quota. |
| Network | Docker uses its fixed local Unix socket; native Linux does not contact Docker. Workers have no network, Host socket/config mount or external action endpoint. |
| Subprocess | Native Linux uses the fixed packaged keeper, unshare, mount, bubblewrap and Python/libseccomp programs described above. Docker starts the fixed configured Docker executable and packaged detached Node supervisor, and may read fixed docker.service/docker.socket properties through /usr/bin/systemctl for diagnostics. Workers run `/bin/sh` with non-root UID/GID, read-only image filesystem, dropped capabilities, `no-new-privileges`, memory/CPU/PID limits, bounded `/tmp` and `/dev/shm`, and disabled Docker log storage. A fixed BusyBox keeper retains the job volume across execution-container removal and does not execute job code. |
| Credentials | Worker receives no Host environment or credential files. The Docker daemon access itself is a privileged trusted Host capability. Images and approved runtime roots must contain no embedded secrets. |
| Browser | None. |
| Install scripts | No runtime provisioning, image pull or privileged install hook. Standard package build/prepack only. |

Whole-machine failure, Docker daemon failure, disk exhaustion and untrusted Host plugins are not solved by IPC cleanup. Unknown jobs remain visible in the ledger and consume active capacity when quiescence is unconfirmed. The same Host user can inspect or modify this database; it is protected from the container worker, not from the trusted operator. Partial scratch cleanup failures are not proof of execution failure and may require operator cleanup once the container is confirmed stopped.

## Verification

```sh
CI=true DSH_ISOLATION_TEST_IMAGE=sha256:<local-image-id> pnpm check
```

Without the environment variable, Docker tests are explicitly skipped. With it, tests use actual containers and the native AgentLoop/ToolRuntime; the model and Delivery identity are controlled seams; the finite-grant fixture uses the actual default-deny Policy, ApprovalService and native ToolRuntime. Separate tests exercise Host file/socket/environment separation, a Host HTTP canary, configured cgroup restrictions, workspace exhaustion, output/IPC separation, cancellation, and Host process-group death. Filesystem quota and storage lifecycle probes use actual Docker resources; no image is pulled. These are not evidence of a real cloud model, external account, full user profile or all autonomy work packages being complete.

The optional identity probe `python3 scripts/isolation/daemon-witness-probe.py` runs from the repository root after a build. It requires Python 3, rootlesskit/dockerd and unprivileged Linux namespaces, starts only private rootless daemons, and leaves inspectable logs under `/tmp`. It verifies a real restart, stable Engine ID, changed PID/start ticks, live-process rejection and a surviving volume. Its limited UID/GID map and absent cgroup delegation do not establish worker isolation or production release authority.

## Operator readiness and native preauthorization

`dsh-isolation probe sha256:<local-image-id> [/absolute/docker [/absolute/docker.sock]]` exercises the production supervisor, non-root/read-only-root execution, work volume, artifact export and cleanup with a fixed nonce task. On macOS the default Docker executable is `/usr/local/bin/docker`; pass its absolute path if installed elsewhere. It creates private temporary staging and never pulls an image. Successful or confirmed-quiescent probes remove staging; unknown cleanup retains `probe.json` with exact job/container/image/socket metadata for operator investigation. This diagnostic does not create a production grant or reset a ledger, and does not replace task-specific resource validation.

With matching Policy and Isolation builds, the exact registered `isolation_run` definition can skip a redundant risk prompt only while its owner/scope grant and live Policy evaluation permit the normalized request. Same-name scoped tools cannot borrow this registration. Native tool authorization remains independent: configure `execute` on `tool:isolation_run` as well as `tool:isolation:<grant-id>`; explicit denials still win. A default-deny Policy is supported without allowing unrelated tools.

Only a newly admitted job consumes its grant-operation Policy budget, under stable key `isolation:<jobId>`. Polling and exact idempotency replay evaluate current authority without consuming that budget again. If an operator separately attaches a budget to native `tool:isolation_run`, that is a distinct per-tool-call budget and still charges call attempts, including result retrieval. Omit that additional budget when the intended limit is per job. Grant run/runtime reservations are cumulative and are not refunded on failure.

The default export is the Cordis plugin object with stable name, Config and apply metadata; use the named `AssistantIsolationService` export for programmatic construction. The DSH Loader unwraps default exports, so dropping the plugin name there would prevent trusted tool registration.

### 可信目标产物与独立验收

schema v6 新增可空的 artifact admission 绑定，v1–v5 行迁移后保留且不会被追认为目标产物。Host 在真实 Goals native round 内，于隔离任务派发前固定 step acceptance ID/digest、run、turn 与声明输出路径；相同幂等键不会重新绑定。运行中若原 admission 改变则取消。私有 `readAcceptedArtifact` 只读取同一 v4 step scope/owner/Session 的成功、已静止、有效期内且正文未清理的产物；较新的同路径失败尝试禁止回退旧结果。

Host Verifier 可使用导出的 `IsolatedVerifierRunner` 在独立私有 stateRoot 中验收复制产物。该类没有模型工具入口，固定 authority/镜像/命令、次数、累计预留时长及期限，可选 `socketPath` 与普通隔离任务遵循相同的本地 Docker socket 约束，并复用相同 Docker supervisor 和资源边界。验收任务与原产物 job 是不同 ID；验收不在宿主执行模型代码。未知派发仍保留资源占用且不自动重放，重复 setup 或重启也不会重置预算。

The read-only `isolation_grants` tool exposes usable grant IDs and remaining limits only for the current authenticated owner and workspace/preset. It applies live Policy, principal lineage, expiry and revocation checks; it cannot create or extend grants and returns no credentials or Host paths. When Policy allows discovery and at least one grant remains usable for that exact owner, the Host registers its exact tool definition for finite preauthorization so this read-only query skips the redundant native risk prompt. Revocation, expiry, owner/scope mismatch, Policy denial, tool replacement, or bundle unload removes that preauthorization. Use a returned ID with `isolation_run`.

Native skill benchmark cells may expose `skill_run` and `skill_status` through the same preauthorization gate. Only the exact Skills definitions with a current, owner-bound isolation-only delegation can execute. This does not enable Host filesystem/shell tools or ordinary saved workflows in an isolated scope; every nested isolation job still needs its own finite grant. See [native skill reuse](../../docs/native-skill-reuse.md).
