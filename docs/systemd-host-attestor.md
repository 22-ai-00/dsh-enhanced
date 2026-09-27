# Owner-operated systemd Host attestor

`plugin-control-plane/bin/dsh-systemd-host-attestor.js` is shipped in the
Control Plane bundle. It implements the existing configured Host executable
contract, version `dsh-systemd-host-attestor-8`, for **reload, readiness, physical rollback and runtime continuity** on Linux.
It uses the existing signed receipt, request, fence and activation state
machine. It creates no Cordis plugin, AgentLoop, model tool or scheduler.

The owner-operated executable restarts one explicitly authorized systemd
service, observes a fresh stable invocation and signs a schema-2 reload
receipt. Control Plane can then advance to `awaiting-readiness`. Readiness
uses authenticated live Loader/Fiber observations bound to that signed reload,
and can advance the existing state machine to `awaiting-effect-blocked-replay`.
Other activation phases are rejected before acquiring supervisor authority. Neither a
running service nor an active candidate establishes behavioral quality.

The executable accepts **schema-2 Host requests**. Each request includes a
`predecessor` binding with the prior applied operation ID, receipt ID, phase,
full signed receipt digest and Host generation. Reload has no predecessor.
Readiness must name the exact reload retained in this signer's private journal;
changing the receipt ID or digest is rejected even if the owner has authorized
the altered request. Rollback may have no predecessor when no phase was applied
under its recovery fence. Config schemas 1–3 and signed receipt schema 2 retain
their existing meanings; they are separate from the request schema.

## Runtime continuity after restart

A successful deployment remains under observation after its activation finishes.
Its original readiness signature binds one process and one set of Cordis instances;
restarting that process cannot make the old signature describe the replacement.
The target Host therefore queues a separate `dsh-runtime-epoch-request` after native
startup, or when a foreground task detects a changed runtime. Queueing holds the
current owner task source fence. The existing coordinator Automation invokes the
attestor outside the target service cgroup; it does not create another scheduler.

The standing resolver checks the latest successful deployment, its open watch,
original owner, approval, readiness and deployment files, and the current grant.
It derives an exact schema-5 observation configuration. Historical activation and
handoff expiry do not erase an adopted deployment; the standing grant's original
start, expiry and revocation boundaries still apply. Runtime epoch operations have
a separate count capped by the same grant's `maximumReloads` value and do not reset
or consume its accumulated reload count. No new user configuration is required.

This path issues **no restart command**. It checks systemd identity before and after
authenticated runtime samples, requires active target instances and unchanged pinned
files, and signs the complete runtime identity. It retains observations in
`runtime-epochs.sqlite`, beside the unchanged `reload.sqlite`. Sequence numbers may
skip expired requests, but an older signer cannot commit after a newer sequence.
Retries of these read-only observations remain tied to the original request.

Control Plane schema 26 keeps the requests and accepted proofs separately from
activation plans and their original receipts. Only the latest successful epoch can
admit a foreground task; its signature must predate task dispatch and both task
endpoints must match the same runtime. Tasks during the coordinator's recovery
interval are not retrospectively attributed. A failed, stale or withdrawn proof
cannot establish continuity. This covers an unchanged deployment after a process
restart or instance replacement; migrating Host versions and their frozen authority
configuration is a separate update transaction.

## Continuity through managed Host maintenance

Control Plane schema 27 adds an append-only `deployment_host_maintenance` journal.
A stopped-Home update signs the transition with the installation's existing Host
key. Each record binds the original applied readiness, plan and activation, the
previous maintenance record, and old/new executor, unit properties, profile files
and rollback files. A new record requires the current successful deployment and
open watch, with no unsettled successor. Original plan, approval, readiness,
checkpoint and watch rows are retained unchanged. The installer checks every original
and copied ledger before changing any authority: unfinished source jobs, releases,
activation plans, runtime proofs and observation batches must first be reconciled
on the original Host. This preserves replay of already issued authorization receipts.

Readers verify the chain against the original readiness key before projecting
current deployment files and recovery baselines. Physical rollback checks both
the rebased candidate and its rebased backup. The standing resolver derives
schema 6 for a maintained deployment; the attestor checks the first record against
its retained reload configuration and the last against the current configuration.
It then samples the new runtime without another restart. Historical Host generation
and authorization limits are preserved; a maintenance signature is not a new
approval or evidence of behavioral improvement.

The installer must update both Host plugin cohorts and the copied authority
programs together. This protocol does not by itself migrate package dependencies,
grant configurations, or service definitions. Cross-version installer verification
and frozen local cohort updates are tracked in [RSI status](rsi-status.md).

## Automatic authorization within an installation grant

For unattended source adoption, use configuration schema 4 with the shipped
`dsh-systemd-host-authority` resolver. It derives each exact operation's inner
schema-1/2/3 config (or schema 5/6 for runtime continuity) from the existing Control Plane ledger and a private finite
installation grant. It does not ask the user to edit a request digest for each
update. Existing explicit configs below remain supported.

```text
schemaVersion: 4
template:
  authority, keyId, privateKeyPath, stateRoot
  executable, interpreter, processHelper, systemctl
  scope, unit, unitProperties, timeoutMs, stableWindowMs, pollIntervalMs
  readiness: { client: { path, sha256 }, observer: RuntimeObserverConfig }
  recoveryReadiness: { client: { path, sha256 }, observer: RuntimeObserverConfig }
resolver:
  executable: { path, sha256 }
  interpreter: null | { path, sha256 }
  configPath, configSha256
  timeoutMs: 1000..60000
```

The resolver's private JSON config has `schemaVersion: 1`, `statePath` (its
durable SQLite journal), `controlDatabasePath`, `trustPath`, `template` (exactly
equal to the wrapper template), and `grant`. The grant fixes `id`, `notBefore`,
`expiresAt`, `maximumReloads` (1–1000), source `owner`, target `profile`, allowed
`packages`, `coordinatorId`, `hostDeploymentInputs`, and `liveQualification`.
The source-adoption config, adoption approval grant and Host grant must agree
on both the deployment inputs and finite trial terms. This initial resolver
supports owner-bound source adoption with the bounded-live contract.
`readiness` identifies the intended candidate runtime; `recoveryReadiness`
independently identifies the original runtime after restore. Configure both
explicitly when entry IDs or config digests differ between versions.

`hostDeploymentInputs` is a nonempty list of unique relative files in the
profile. Include the candidate's entry/config files required by the runtime
observer. The signed activation dossier fixes these logical paths. Before
exposing the staged profile, activation records hashes of the three core
profile files, declared candidate inputs and the original deployment inputs.
Internal pnpm symlinks are resolved and remapped to the final profile path.
Activation detaches declared pnpm hardlinks into byte-identical private files
before recording their hashes; external links, aliases and group/other-writable
files are rejected. Every declared input must exist in both candidate and
original profile when restoring an existing deployment. New paths absent from
the original profile require a different recovery-input contract and are not
covered by this initial witness format.
This is an input witness, not a complete inventory or proof of quality.

The resolver requires a durable claimed operation, its exact signed approval,
source/release binding, current handoff and deployment witness. It reserves
each reload against the grant's persistent quota before returning any config.
While the operation and its authority remain current, reusing the same
operation returns the same config without renewing the grant. Expiry or
revocation also blocks replay of a forward config already reserved in the
journal. An unknown dispatch then needs reconciliation from retained signed
receipts; this resolver does not add unattended unknown-outcome recovery or
permission to retry a restart.
Rollback uses the recorded original files and a proven recovery obligation;
an expired forward grant does not authorize another deployment. Never delete
the journal to reset quotas or bypass an unknown outcome. A staging retry with
a different fence cannot reuse an old immutable witness.
Keep the original grant, resolver config, trust and keys available until its
exposed deployments settle: rotating those inputs under an existing grant ID
is rejected, including during recovery.

The wrapper pins the resolver and config bytes, passes only the exact request,
and rejects changes to static supervisor/key/observer authority. The
resolver interpreter may be null only for a native ELF executable; scripts
must name a pinned native ELF interpreter, including the shipped JavaScript wrapper. The
outer Host timeout must also cover resolver execution and cleanup. Provision all
private resources outside the candidate profile. Runtime continuity requires
Control Plane schema 27 and attestor version 8 together. Complete pending older
operations using their original pinned binary before changing trust; their
issuer identity cannot be rewritten. The standing wrapper remains schema 4;
its resolver produces flat schema 5 for ordinary runtime continuity or schema 6
when a signed Host maintenance chain is present. The [supervised installer](../plugins/lark-channel/docs/rsi-setup.md)
prepares both Hosts, source/build resources and signing keys; invoking this
resolver alone does not perform that installation.
If package-manager files have multiple hardlinks, provision the signer and
resolver as a private single-link package tree, including their `bin/` and
`lib/` modules. Copying only the resolver wrapper loses its relative imports.

## Preparing an explicit exact authorized request

1. Register the executable, its **single-link native Node interpreter**, hashes,
   version, receipt authority/key and finite timeout in the existing
   `hostAttestor` trust configuration. Allow only
   `DSH_SYSTEMD_HOST_ATTESTOR_CONFIG` for its private config path. The outer
   timeout must cover config validation, the inner observation timeout and
   bounded process cleanup. Installed interpreters with hardlinks require an
   owner-managed private copy with a separately recorded hash.
2. Once activation is awaiting reload, prepare its durable request:

   ```sh
   dsh-plugin-control probe --prepare-only --plan-id PLAN \
     --expected-revision REVISION --expected-fence FENCE
   ```

   This outputs the configured request and persists its operation identity. It
   does not invoke the attestor or advance activation. Repeating preparation
   returns the same request. The owner can compute its digest using the
   package's `lib/attestation.js` `hostAttestationRequestDigest` function.
3. Provision the private config below, including that **exact request digest**.
   The request itself is unsigned. Merely matching a profile or plan is not
   authorization to restart. Changing its operation ID, issuer, timestamp or
   TTL invalidates the authorization.
4. Run the same `probe` command without `--prepare-only`, from outside the
   target service's cgroup. The existing Control Plane authority verifies the
   signed receipt and applies the normal CAS transition.

## Reload configuration contract

All fields are required; unknown fields are rejected. Config, private key and
state directory must be canonical, owner-private, and outside the candidate
profile. Executables, helpers and profile files must be stable regular files,
with one link and no group/other write permission. The attestor pins its own
running script/interpreter and the systemctl command through open descriptors.
The shared `lib/adapter-process.js` is hash-checked before data-URL import.

```text
schemaVersion: 1
authority, keyId: registered receipt identity
privateKeyPath: private Ed25519 PKCS#8 key
stateRoot: persistent private supervisor journal directory
executable, interpreter, processHelper: { path, sha256 }
systemctl: { path, sha256, interpreter: null | { path, sha256 } }
scope: "user" | "system"
unit: "dsh-profile-<profile.name>.service"
unitProperties:
  FragmentPath, DropInPaths, ExecStart, Environment, WorkingDirectory,
  User, Group, Type, KillMode: exact expected strings
profileFiles: [{ path, sha256 }, ...]
authorization:
  installationId, ledger: { id, path }, profile: { name, path },
  plan: { id, digest }, activation: { id, fence },
  previousHostGeneration, requestDigest, notBefore, expiresAt
timeoutMs: 1000..60000
stableWindowMs: 50..10000
pollIntervalMs: 25..1000
```

`profileFiles` contains 3–32 unique paths under the exact canonical
`profiles/<name>` directory and must include `package.json`, `pnpm-lock.yaml`
and `cordis.patch.yml`. Pin additional owner-required config inputs as needed.
These pins detect changes to the declared deployment inputs; they do not
inventory every installed module or prove that the candidate was loaded.

Capture the expected effective `unitProperties` from the owner-controlled
service definition and check its DSH executable, `--profile`, `DSH_HOME`,
working directory and credentials against the intended deployment. `ExecStart`
uses the `systemctl show` representation up to `ignore_errors`, ending in
` ; }`; per-invocation `start_time`, PID and exit status are excluded from this
configuration comparison. Multiple ExecStart records are rejected. Supported
service types are `simple`, `exec` and `notify`; `KillMode` must be `control-group`.

User scope fixes the bus to `/run/user/<uid>/bus` and its private runtime
directory. System scope uses the system manager. Commands receive a fixed
minimal environment, never ambient Node options, caller bus overrides or
model-provided argv. The optional systemctl interpreter supports explicitly
pinned owner commands; controlled tests use this seam, while the real
supervisor fixture uses `/usr/bin/systemctl` directly.

## Dispatch, observation and recovery

Control Plane schema 22 and later commit a dispatch claim before invoking this executable,
then releases its own database writer lock. A second `probe` never invokes a
claimed operation whose receipt is missing. Retrieve the original request's
signed receipt from the owner-controlled attestor and submit it with
`dsh-plugin-control attest --plan-id PLAN --expected-revision REVISION
--expected-fence FENCE --receipt /private/receipt.json`. This command verifies
and records the receipt without restarting the service. Do not delete either
journal or create a new operation to bypass an unknown result. The attestor's
own recovery behavior below is distinct from automatic Control Plane dispatch.

Before dispatch the attestor validates config/request/pins, reads exact unit
identity and requires a stable active/running prior instance. It rejects a
target cgroup containing itself. It then commits the operation, request/config
digests, full request/config, prior observation and reserved generation to a private SQLite
WAL/FULL journal, syncing its parent directory before supervisor I/O.

Only the transaction that first reserves the operation can submit `restart`.
The same operation can subsequently return its unchanged cached receipt or
observe the supervisor again. A timeout, nonzero systemctl exit, killed
attestor, missing acknowledgement or interruption after reservation never
permits another restart. Even a crash before actual submission conservatively
leaves an unresolved operation. Unchanged observations do not become success.

Acceptance requires a different InvocationID and MainPID, active/running
state, zero ControlPID, unchanged effective unit properties/profile pins,
and a stable successor tuple/NRestarts over the configured window. The
receipt's probe digest covers retained prior/successor observations, samples,
request/config digests and observation time. Signing and replay retain the
original expiry; authorization expiry cannot be extended through a retry.

Generations follow Control Plane's **installation-wide** sequence, including
alternating profiles. All profiles of one installation must retain the same
supervisor journal. A new operation cannot bypass an unresolved predecessor.
Initial attachment may seed from the owner's approved previous generation;
deleting or replacing this journal is not a recovery procedure.

## Readiness configuration and evidence

Use the same configured executable and private supervisor journal. After reload,
prepare the next exact request using `probe --prepare-only`, then provision:

```text
schemaVersion: 2
# All schema-1 base fields remain required, except authorization changes below.
authorization:
  installationId, ledger, profile, plan, activation,
  hostGeneration, requestDigest, notBefore, expiresAt
readiness:
  reloadOperationId: exact completed reload operation
  client: { path, sha256 } # shipped lib/runtime-observer-protocol.js
  observer: { socketPath, keyPath, profilePath, targets }
  deploymentFiles: [{ path, sha256 }, ...]
```

The observer config is the exact [runtime observer configuration](runtime-observer.md)
installed in the target Host. Its helper imports only Node builtins and is
hash-checked before data-URL import; the receipt key stays in the external
attestor. Declare 1–128 unique deployment file pins covering the candidate entry,
package manifest and other owner-required artifacts. These are declared disk
input checks, not proof of loaded memory bytes or a complete dependency inventory.
The request's `minimumChecks` must be 1–256; counts are never silently reduced.
All queries, subprocesses and delays share the configured finite deadline.

Readiness requires the installation's latest reserved reload operation to be
completed, still unexpired, and equal to `reloadOperationId` and `hostGeneration`.
It verifies the retained reload signature, request/config digests, observation
probe digest and exact installation, ledger, profile, plan and activation/fence.
A later reload in any profile of the installation, even unresolved, invalidates
this binding. Deployment properties, supervisor identity and profile pins must
match the signed reload. No readiness path calls `restart`.

For at least `max(2, minimumChecks)` fresh HMAC queries over `stableWindowMs`,
checks require:

- systemd's full current successor tuple both before and after each query;
- observer PID/InvocationID matching that tuple, the exact profile and observer
  config digest, a fresh challenge and an in-query timestamp;
- every selected entry present with exact module/config and required service names;
- unchanged observer identity, candidate instance epochs and all dependency and
  service provider instances throughout the window;
- unchanged channel key and profile/deployment file pins.

If every selected entry is active with live dependency/service instances, the
receipt is `passed`. A stable authenticated entry with `active: false` instead
counts as a failed check and produces a signed `failed` receipt after the same
minimum checks and stable window. Inactive entries may have null Fiber,
dependency or service instances; these establish that the configured capability
is not ready. Missing entries, module/config mismatch, failed authentication,
supervisor drift, changing runtime state or query failures remain unconfirmed
and produce no receipt. They must not be converted into a signed failure.

A failed readiness receipt enters the existing Control Plane rollback path.
The CLI restores profile files and retains `rollback-pending`. The signed
[physical rollback](#physical-rollback) phase then independently verifies the
restored Host or stopped originally absent profile before advancing the ledger.

The signed readiness `probeDigest` covers the reload receipt digest and successor,
request/config digests, channel key digest, stable runtime identity, sample
challenges/timestamps/digests, window and observation time. The receipt uses the
reload generation without incrementing it. Existing Control Plane verification
checks its signature and minimum-count/zero-failure contract; these additional
bindings are enforced by this owner-configured attestor.

The private journal reserves one readiness operation per reload. Retries only
observe; a completed retry must still match the retained runtime and reload,
then returns the byte-identical original receipt without extending expiry.
Concurrent calls converge on that receipt; drift or expiry refuses replay.
Unknown outcomes never acquire restart authority.

### Version and journal migration

Version 2 added schema-2 readiness while retaining schema-1 reload configuration.
Version 3 retains both schemas and adds signed stable-negative readiness.
Its executable/version pins must be updated through owner configuration before
preparing requests. Pending older-version requests cannot be silently converted;
retain their pinned binary for reconciliation. The journal adds nullable raw
request/config columns transactionally. Historical reload rows lacking this
context remain valid historical reload records but cannot authorize readiness;
do not synthesize their missing context or delete the journal to bypass it.

## Authority and evidence limits

- The signing key and supervisor control belong to the deployment owner.
  This executable does not create users, install units, provision credentials,
  or authorize production activation. Mode checks are not isolation from a
  malicious process sharing the same UID; use a separate supervisor identity
  and protected configuration for that boundary.
- Observation establishes a fresh instance with the pinned effective
  configuration. It does not prove causal attribution to one particular
  systemd job, atomicity against another administrator, behavioral quality,
  effect blocking, canary quality, health or physical rollback.
- Keep other deployment writers serialized while the operation runs. Killing
  the local helper cannot revoke a restart already accepted by systemd. If the
  attestor dies, systemd remains the resource owner; recovery uses its actual
  state, not a second blind restart.
- A systemctl subprocess can outlive a killed attestor. For process cleanup
  after owner death, run the attestor under its own supervisor/cgroup, separate
  from the target Host. The process-group helper needs its owner alive to
  reclaim children; the killed-owner test explicitly cleans its remaining
  command fixture. Neither this adapter nor authorization expiry retracts an
  already accepted supervisor request.
- A successful reload advances only one existing phase. WP16's complete
  production enable/monitor/rollback and WP18's repository reuse loop remain
  incomplete.

## Sources and verification

The existing installer already checks effective service configuration and
fresh/stable invocation identity in
`scripts/install/lifecycle-profile.mjs` (`inspectServiceUnit`,
`readRawServiceState`, `startAndAcceptServices`). Its journal Web-ready marker
is not used here as candidate readiness evidence. Systemd's
[v252 D-Bus contract](https://github.com/systemd/systemd/blob/v252/man/org.freedesktop.systemd1.xml)
documents the supervisor's unit/restart interfaces. Local verification uses
systemd 252 and the installed runtime, without changing the pinned Cordis ABI.

Tests exercise the real packaged command, descriptor-pinned Host runner,
independent receipt verification, concurrency, lost acknowledgement, killed
issuer, fixed-request authorization, generation and drift rejection.
`scripts/e2e/systemd-reload-attestor.mjs` additionally creates a unique transient
user service containing an idle Node process, observes its actual restart,
checks unchanged receipt/instance on replay, and removes the fixture. This is
supervisor integration evidence, not a deployed DSH Host or plugin evaluation.

The same script accepts `DSH_SYSTEMD_FIXTURE_DSH=/absolute/path/to/dsh` to boot
the actual shipped Web template in a new temporary home/profile. It waits for
the invocation-bound Web startup marker before and after restart. The
real DSH run used
`0.1.5-rc.2` and proved fresh supervisor identity, independently verified signed
reload receipt, and unchanged instance on replay. It loaded no candidate
plugin and made no model request. Its startup observations are additional
test evidence, not a signed readiness phase. The transient service has a
finite runtime limit and is stopped and removed by the fixture.

The recorded supervisor run
contains actual before/after/replay identities and runtime digests. Current
repository verification is summarized in [RSI status](rsi-status.md).

`scripts/e2e/systemd-readiness-real-dsh.mjs` runs an opt-in disposable DSH Web
profile with actual Control Plane observer and Policy candidate entries. It
checks signed reload → signed readiness, independent signature verification,
byte-identical readiness replay without another Host restart, and refusal after
the Host is replaced with the candidate state changed.
The fixture uses the existing Control Plane store for signed approval,
durable requests, receipt verification and phase CAS, then reopens the ledger.
Set `DSH_READINESS_EXPECT_INACTIVE=1` to start with the candidate disabled and
require signed failed readiness plus durable `rollback-pending`; otherwise the
active candidate must reach `awaiting-effect-blocked-replay`. Catalog integrity,
approval authority and profile staging are explicit fixture inputs. The default
readiness branch stops there; `DSH_READINESS_ROLLBACK=restore|stop` additionally
exercises CLI profile restoration/removal and physical Host recovery as described
below. Neither branch performs npm installation.
The active-candidate default branch also mounts a replay endpoint before the
signed reload, then signs the actual prepared replay request after readiness.
It checks native replay with unchanged PID/invocation, observer/Fiber identities
and deployment pins, retaining `awaiting-effect-blocked-replay`. The endpoint
observation is unsigned and does not attest global absence of external effects.
The fixture retains signed receipts, probe preimages and actual phase
transitions locally. Current engineering verification is summarized in
[RSI status](rsi-status.md); historical verification is available in Git history.

For runtime continuity, run the same fixture with:

```sh
DSH_READINESS_FIXTURE=1 \
DSH_READINESS_DSH=/absolute/path/to/dsh \
DSH_READINESS_RUNTIME_EPOCH=1 \
node scripts/e2e/systemd-readiness-real-dsh.mjs --output /tmp/runtime-epoch-evidence.json
```

This mode seeds a successful deployment checkpoint after genuine reload/readiness,
restarts the temporary Host, rejects the old readiness, and captures the new
schema-5 proof. It checks unchanged historical journal rows, no additional restart,
and stopped unit/process cleanup. It does not exercise a real owner grant,
coordinator dispatch, model call or ordinary-user feedback adoption.

Managed Host maintenance additionally has an offline integration fixture:

```sh
pnpm exec vitest run --dir tests tests/host-rsi-update.test.ts --testTimeout=120000
```

It uses actual compiled owner configuration, copied authority programs, signing
keys and SQLite ledgers. Two Host migrations are followed by a new source release
and activation through the Control Plane APIs, removal of the superseded backup,
and a third migration. Original history, bootstrap, identities and used grant
records must survive. External release adapters and successful runtime checkpoints
are explicit fixture inputs; this is not a live deployment or owner-task test.
The separate `tests/host-lifecycle.test.ts` transaction fixtures also simulate
the service supervisor and Home process census. They exercise transaction and
crash-recovery ordering; production process-census rejection remains covered by
the installer tests, not by these controlled recovery fixtures.
The native runtime-continuity command above also passed with attestor v8 on
DSH `0.1.5-rc.3`; that checks schema-5 compatibility, not a live schema-6 Host upgrade.

## Physical rollback

Schema-15 Control Plane captures immutable hashes (including explicit file
absence) of the original `package.json`, `pnpm-lock.yaml` and
`cordis.patch.yml` before staging. Before making the staged profile Host-visible, the CLI permanently
requires physical recovery if activation later fails. CLI restores the
backup tree, or removes an originally absent profile, verifies the captured
core files, then persists `rollbackProfileRestored`. It releases the filesystem
lease and keeps `rollback-pending`; the activation fence is now fixed.
Changing current trust configuration cannot remove this requirement.

Prepare the rollback request with the same `probe --prepare-only` command.
Its requirements bind `action: restore | stop`, the original `baselineFiles`,
`previousHostGeneration` and `minimumChecks`. Provision a **schema-3** private
attestor config with the same common fields as reload:

- `authorization.previousHostGeneration` and exact `requestDigest` bind the
  prepared recovery operation and its current activation fence.
- For `restore`, `profileFiles` equals the three original baseline pins. Each pin may explicitly record file absence with `sha256: null`;
  absence is checked before dispatch and throughout observation. `readiness` contains `client`,
  `observer` and `deploymentFiles`, as in schema 2, without `reloadOperationId`.
  The restored profile must already provide the authenticated observer and
  the owner-selected baseline Loader entries/services.
- For `stop`, `profileFiles` is empty and `readiness` is `null`. The profile
  must be absent, including no dangling symlink; its real parent must exist.

Run `probe` to execute the prepared operation. The private supervisor journal
reserves the next installation generation before one restart or stop. Lost
acknowledgements and process death replay the same operation by observation
only. An unresolved previous generation blocks recovery until reconciled.
A successful restore requires a fresh stable Host PID/invocation, retirement
of the prior PID, unchanged baseline files, and authenticated ready baseline
Fibers/services for the complete observation window. Stop requires stable
`inactive/dead`, zero main/control PIDs, no pending supervisor job, retirement
of the prior PID, and no remaining tasks in the unit cgroup subtree. A transient unit may
become `not-found` after stop; this is accepted only after the same operation
has durably observed its loaded original unit, with inactive/zero-PID state
and retirement checks against that retained original cgroup.

The cgroup check uses the actual kernel filesystem: unified v2
`cgroup.events: populated 0`, or recursive `tasks` reads in the legacy
`/sys/fs/cgroup/systemd` hierarchy. A removed cgroup is accepted as removed;
permission and other read errors fail. Kernel semantics are documented in
[cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html#organizing-processes-and-threads)
and [legacy cgroups](https://docs.kernel.org/admin-guide/cgroup-v1/cgroups.html).
The attestor verifies its own PID in the mounted hierarchy and requires the
original unit’s parent cgroup to remain visible on that kernel filesystem. An
invisible parent, root-only ambiguous namespace, or mismapped hierarchy is
refused; a missing leaf alone does not establish visibility. The supervisor
and attestor must see the same host cgroup hierarchy.

Only a signed passing recovery receipt advances `rolled-back` and reopens
the capability gap. Failed, unavailable or ambiguous recovery remains
pending. Cached recovery receipts are returned byte-identically only after
fresh supervisor/runtime revalidation; they cannot be replayed after expiry,
runtime drift or a newer generation. No retry automatically issues another
restart/stop. Separate external writers must be serialized by the owner; the
receipt proves the bounded observation window, not perpetual future state.

Pre-Host staging failures retain filesystem-only rollback. Historical
terminal records are unchanged; migrated in-flight plans have no invented
baseline and require owner recovery if their original pins are unavailable.
Core-file pins and declared deployment pins do not inventory every dependency
or reverse database migrations, delivered messages or other external effects.

The opt-in disposable fixture covers both actions through actual CLI file
restoration and descriptor-pinned `probe`:

```sh
DSH_READINESS_FIXTURE=1 \
DSH_READINESS_DSH=/absolute/path/to/dsh \
DSH_READINESS_ROLLBACK=restore \
node scripts/e2e/systemd-readiness-real-dsh.mjs --output /tmp/restore.json
# Repeat with DSH_READINESS_ROLLBACK=stop for an originally absent profile.
```

Initial package/catalog installation remains a fixture input. This is not
production publication or proof of behavioral improvement.

Each arm retains local signed recovery requests/receipts and observation
preimages, the CLI-restored pending plan, final persisted plan, and exact runtime
hashes. Current schema-2 request verification covers real reload/readiness and
restore on DSH CLI `0.1.5-rc.2`. The active-candidate probe also rejects a
correctly signed synthetic replay receipt with a substituted Host generation;
that negative fixture does not observe external effects. See [RSI status](rsi-status.md)
for current verification and remaining acceptance work.
