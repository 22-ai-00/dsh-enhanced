# Owner-operated systemd Host attestor

`plugin-control-plane/bin/dsh-systemd-host-attestor.js` is shipped in the
Control Plane bundle. It implements the existing configured Host executable
contract, version `dsh-systemd-host-attestor-4`, for **reload, readiness and physical rollback** on Linux.
It uses the existing signed receipt, request, fence and activation state
machine. It creates no Cordis plugin, AgentLoop, model tool or scheduler.

The owner-operated executable restarts one explicitly authorized systemd
service, observes a fresh stable invocation and signs a schema-2 reload
receipt. Control Plane can then advance to `awaiting-readiness`. Readiness
uses authenticated live Loader/Fiber observations bound to that signed reload,
and can advance the existing state machine to `awaiting-effect-blocked-replay`.
Other phases are rejected before acquiring supervisor authority. Neither a
running service nor an active candidate establishes behavioral quality.

## Preparing an exact authorized request

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
The current CLI restores profile files; it does not prove that the running Host
has loaded the restored profile. Physical Host rollback remains a separate gap.

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
[real DSH run](evidence/systemd-real-dsh-reload-2026-09-19.json) used
`0.1.5-rc.2` and proved fresh supervisor identity, independently verified signed
reload receipt, and unchanged instance on replay. It loaded no candidate
plugin and made no model request. Its startup observations are additional
test evidence, not a signed readiness phase. The transient service has a
finite runtime limit and is stopped and removed by the fixture.

The [recorded supervisor run](evidence/systemd-reload-supervisor-fixture-2026-09-19.json)
contains actual before/after/replay identities and runtime digests. Full-check
and independent review evidence is recorded in the
[engineering validation](evidence/systemd-host-attestor-engineering-2026-09-19.json).

`scripts/e2e/systemd-readiness-real-dsh.mjs` runs an opt-in disposable DSH Web
profile with actual Control Plane observer and Policy candidate entries. It
checks signed reload → signed readiness, independent signature verification,
byte-identical readiness replay without another Host restart, and refusal after
the Host is replaced with the candidate state changed. The historical v2
[recorded real DSH run](evidence/systemd-readiness-real-dsh-2026-09-19.json)
used fixture requests without Control Plane CAS and retains both signed
receipts and the readiness probe preimage.
The [readiness engineering validation](evidence/systemd-readiness-engineering-2026-09-19.json)
records the full repository check, package inspection, prior failures and
independent review for this capability.

The recorded v3 fixture uses the existing Control Plane store for signed approval,
durable requests, receipt verification and phase CAS, then reopens the ledger.
Set `DSH_READINESS_EXPECT_INACTIVE=1` to start with the candidate disabled and
require signed failed readiness plus durable `rollback-pending`; otherwise the
active candidate must reach `awaiting-effect-blocked-replay`. Catalog integrity,
approval authority and profile staging are explicit fixture inputs. This does
not execute npm installation, CLI profile restoration or physical Host rollback.
The [active-candidate run](evidence/systemd-readiness-positive-real-dsh-2026-09-20.json)
and [inactive-candidate run](evidence/systemd-readiness-negative-real-dsh-2026-09-20.json)
retain signed receipts, probe preimages and the actual phase transitions.
Full-check, independent-review and prior-failure records are in the
[v3 engineering evidence](evidence/systemd-readiness-negative-engineering-2026-09-20.json).

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

Recorded real DSH evidence: [restore](evidence/systemd-rollback-restore-real-dsh-2026-09-20.json),
[stop](evidence/systemd-rollback-stop-real-dsh-2026-09-20.json), and
[engineering checks](evidence/systemd-rollback-engineering-2026-09-20.json).
Each arm retains the signed recovery request/receipt and observation preimage,
CLI-restored pending plan, final persisted plan, and exact runtime hashes.
