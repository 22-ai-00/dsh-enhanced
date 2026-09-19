# Owner-operated systemd Host reload attestor

`plugin-control-plane/bin/dsh-systemd-host-attestor.js` is shipped in the
Control Plane bundle. It implements the existing configured Host executable
contract, version `dsh-systemd-host-attestor-1`, for **reload only** on Linux.
It uses the existing signed receipt, request, fence and activation state
machine. It creates no Cordis plugin, AgentLoop, model tool or scheduler.

The owner-operated executable restarts one explicitly authorized systemd
service, observes a fresh stable invocation and signs a schema-2 reload
receipt. Control Plane can then advance to `awaiting-readiness`. Unsupported
phases are rejected before acquiring supervisor authority. A running service
does not establish that the candidate's Fiber is active or its behavior is
correct; readiness and the other five gates still require their own evidence.

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

## Configuration contract

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
digests, prior observation and reserved generation to a private SQLite
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

## Authority and evidence limits

- The signing key and supervisor control belong to the deployment owner.
  This executable does not create users, install units, provision credentials,
  or authorize production activation. Mode checks are not isolation from a
  malicious process sharing the same UID; use a separate supervisor identity
  and protected configuration for that boundary.
- Observation establishes a fresh instance with the pinned effective
  configuration. It does not prove causal attribution to one particular
  systemd job, atomicity against another administrator, plugin readiness,
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
