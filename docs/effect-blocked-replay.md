# Native effect-blocked replay

Control Plane exports `EffectBlockedReplayRuntime` for an owner-operated Host
integration. It rehearses a finite case set using the installed DSH ToolRuntime
and Delivery reply admission, retaining one observation for each actual denial.
It does not call a model or create an AgentLoop, scheduler, or activation state
machine. Models remain interchangeable suppliers.
The runtime observer contract currently makes this component Linux-only.

## Ownership and execution

Mount the runtime inside a Cordis child with required `tools`, `loader`,
`assistantDelivery` and `agents` injection. Pass the existing `RuntimeObserverConfig`: its
targets must identify the exact candidate entries, configuration digests and
required services. The sampler reads the current Loader rather than importing
candidate code. The provider implementation and Fiber store for all three
injected services and the native Agent registry are also pinned for the lifetime
of the runtime. The Agent must be registered in that Host and resolve the same
Tools and Delivery realms; foreign Agents are rejected before dispatch.

The owner creates a fresh idle Agent through the existing native
`ctx.agents.create()` and gives its **AgentHandle** to `runtime.run()`:

```ts
await runtime.run({
  handle,
  operationId: 'owner-replay-1',
  requestDigest, // exact owner request; not an authorization by itself
  expiresAt: Date.now() + 30_000,
  signal,
  cases: [
    { id: 'tool-1', kind: 'tool', name: 'candidate_tool', arguments: {} },
    { id: 'reply-1', kind: 'delivery', text: 'finite replay reply' },
  ],
})
```

The case set is cloned and hashed before ownership transfers. It contains
2–32 cases, including both effect classes, within a maximum 60-second deadline.
Each runtime admits at most 1,024 distinct operation IDs; repeated IDs are
rejected rather than executed again. This is an in-memory admission bound, not
a persistent retry protocol. Validation failure before admission leaves the
handle with the caller; every admitted run consumes and disposes its handle,
including failed or cancelled runs.

For a tool case, the runtime calls the real `agent.ctx.tools.execute()` with an
exact call ID and arguments. A native monotonic guard must observe and deny the
same parsed arguments before the tool body. An earlier Policy denial, unknown
tool, argument normalization mismatch, changed final result, or missing guard
record is not accepted as this guard's proof. Native pre-execution hooks remain
in force; the runtime never grants approval or overrides an existing denial.

For a reply case, the runtime calls the current Delivery `reply()` method. The
new `blockAgentRepliesForReplay()` fence executes at `prepareAgentReply()` before
binding lookup, Policy and Outbox insertion. It records the actual normalized
reply input digest and throws an operation-bound error. A missing binding or
unrelated exception cannot pass this check. Calling Delivery directly avoids
executing a shadowed `delivery_reply` tool body during the rehearsal.

Reply tombstones, and tool tombstones while their owning runtime remains
mounted, keep the exact Agent blocked after close, expiry, failure or a completed
run. They do not block other Agents. Reply tombstones
survive ordinary Delivery provider replacement within the same loaded module;
the caller must still discard the consumed Agent. No claim is made that an
old Agent remains safe after replacing the module implementation itself.

Before and after each case, the runtime checks the same Loader entry/Fiber
epochs, dependencies, services and observer identity. Changes reject the run.
It checks once more after the Agent handle has been disposed and the Agent has
disappeared from the native registry. The returned
observation contains the request and case digests, Session identity, runtime
binding and ordered attempt records; no result is returned before cleanup.
Owner Fiber disposal aborts admitted runs and drains them before removing the
guard. Cancellation remains cooperative: trusted DSH hooks and native disposal
must settle; an external supervisor is required to impose a hard process limit.

## Delivery interface

`blockAgentRepliesForReplay(agent, { operationId, maximumAttempts, expiresAt })`
is a Host-only reduction of reply authority. It grants no send permission and
is not exposed as a model tool. Its frozen handle has `snapshot()` and `close()`;
the snapshot includes bounded, immutable per-attempt records. Closing, expiry,
attempt exhaustion and Agent Fiber teardown never restore sending permission.
The same fence covers ordinary replies and completed preference-turn replies.

## Authenticated finite endpoint

Optional Control Plane `replayEndpoint` configuration mounts a Cordis child
with `tools`, `loader`, `assistantDelivery`, and `agents` injection:

```ts
replayEndpoint: {
  runtime: { socketPath, keyPath, profilePath, targets },
  journalPath: '/owner-private/replay.sqlite',
  authority: {
    operationId, requestDigest, notBefore, expiresAt,
    cases: [
      { id: 'tool-1', kind: 'tool', name: 'candidate_tool', arguments: {} },
      { id: 'reply-1', kind: 'delivery', text: 'blocked reply' },
    ],
  },
  agent: { cwd, preset, provider, model },
  timeoutMs: 30_000,
}
```

The owner fixes one operation and case set, a maximum 24-hour authority window,
and a 100–60,000 ms execution deadline. Creation records the configured preset
in session metadata and supplies the provider/model options. It does not mount
that preset: required tools must already be registered by Host startup hooks.
The endpoint submits no model prompt and does not override Policy.
Existing startup hooks and tool registrations still apply.
Agent creation and arbitrary hooks are outside the two replay effect boundaries.

Socket/key and journal paths must be outside the candidate profile in canonical,
private directories. The key is 32 random bytes in an owner-only file. When
`runtimeObserver` is also configured, its socket and key material must be distinct.
Callers of the exported install helpers must preserve this separation too.
Unix modes and HMAC do not isolate a malicious same-UID process; that requires
separate deployment identities and protected owner state.

Host/Agent identity uses the native `dsh-scope` peer, shared with the Host's
AgentLoop. It must resolve to the same module instance: its scope tag is a
module-local Symbol. Mixing a workspace dependency copy with another Host's
runtime is unsupported. A runtime owner must be unscoped, and an admitted
Agent's context must carry that exact Agent as its native scope key.

`queryReplayEndpoint({ socketPath, keyPath, action, operationId, requestDigest,
timeoutMs, signal })` supports `execute` and read-only `query`, authenticated by
a fresh HMAC challenge. Clients cannot submit cases, results or counters. There
is no automatic retry or model tool. Connections and message sizes are bounded.
Owner unload closes admission, cancels work, awaits native cleanup, then removes
its own socket and closes SQLite; cancellation remains cooperative.

Before Agent creation, a private SQLite WAL/FULL journal durably reserves the
operation and exact config/request/case digests. Only the first reservation can
dispatch. Concurrent requests, lost acknowledgements and process restarts
cannot regain that permission:

| Status | Meaning |
| --- | --- |
| `not-started` | Query found no reservation. |
| `unknown` | Reserved without a confirmed completed observation; never automatically rerun. |
| `completed` | Stored result still matches the current sampler and provider generation. |
| `stale` | A stored completion exists but endpoint/provider/candidate identity changed. |

A completed response preserves the original observation. Restarting the
endpoint changes its sampler identity, making stored completion stale. Expired
authority refuses both actions. Failed or cancelled runs stay unknown. Removing
the journal or assigning a new operation to bypass uncertainty is not recovery;
an owner must reconcile the prior operation externally.

A hard-killed process cannot remove its socket. Before restarting, the owning
supervisor must prove the old process group has stopped and remove only that
Host's stale socket inode. The endpoint deliberately does not unlink an
existing socket or reset the journal on startup.

### Actual DSH Host probe

After building the workspace, run the opt-in Linux/systemd user fixture:

```sh
DSH_REPLAY_FIXTURE=1 DSH_REPLAY_DSH=/absolute/path/to/dsh \
  node scripts/e2e/replay-endpoint-real-dsh.mjs --output /tmp/replay-host.json
```

It creates disposable profiles and four actual DSH processes. The Control
Plane copy resolves native peers from that CLI's dependency closure. A fixture
startup hook registers the probe tool; no preset mounting or model prompt is
required. The owner independently binds process IDs and systemd invocation
IDs, checks authentication rejection, completed-result caching, `stale` after
restart, and SIGKILL during pre-execute followed by persistent `unknown`.
Each operation creates exactly one Agent and executes zero probe tool bodies;
the same journal survives restart. Dead socket cleanup is explicit owner
recovery after supervisor quiescence. Temporary profiles and units are removed.

This probe passed with DSH CLI `0.1.5-rc.2` on 2026-09-20. It uses local built
packages and a controlled probe, so it does not establish npm artifact identity,
model quality, independent global effect observation or production activation.

## Verification

Verified on Linux with Node 24.7.0 on 2026-09-20:

- `pnpm check` exited 0: manifest validation, zero-warning lint, typechecking,
  6,070 tests passed (44 skipped), clean build and 35 package dry-run packs (32 plugins and 3 shared libraries).
- The native replay suite passed all 12 cases; the Delivery reply fence suite
  passed all 5 cases. Full package suites passed 476 and 777 tests respectively.
- Endpoint and journal suites passed 11 and 5 cases, including authenticated
  native execution, concurrent admission, timeout/unload, persistent unknown,
  stale cached results and durable request/case binding checks.
- Pack lists include the runtime, endpoint/protocol and journal modules and declarations alongside the
  required package files. Raw run data and logs stay local or in CI artifacts.

These checks cover the component boundaries described here; the native replay
suite is Linux-only and does not verify production activation or model quality.

## Evidence limits and next integration

This component's observations are **unsigned and process-local**. They cannot
advance `awaiting-effect-blocked-replay` or replace a Host attestation. Owner
request/case configuration is a trust input; the caller cannot prove its own
authorization merely by supplying `requestDigest`.

New Control Plane Host requests use schema 2 and bind the exact preceding
applied signed receipt. An effect-blocked replay request therefore carries the
readiness receipt digest and Host generation; ordinary phases cannot advance
generation. The ledger rechecks this chain before dispatch and apply. This
prevents substituting a later generation or another phase's evidence, but it
does not prove process/invocation identity or observe external effects. Those
remain responsibilities of the independent attestor and its deployment.

The boundary covers native tool bodies and Agent reply admission for these
calls. It does not cover arbitrary Node code, pre/post hooks, other Delivery
Host APIs, filesystem/network access, subprocesses, or a malicious same-UID
plugin. Cordis service routing and Fiber ownership are not OS isolation.
No global `externalEffects = 0` claim is derived from these observations.

The next integration must deploy immutable cases and durable admission outside
candidate write authority, independently bind systemd/Loader identity and
collect fresh external observations, then sign the existing exact Host request.
There is also an authorization timing gap: the current endpoint freezes its
operation/request digest in startup Config, while a real schema-2 replay request
can only be prepared after readiness is applied. The standalone endpoint fixture
uses a preselected digest; it does not establish that full chain. A late owner
signature must bind the prepared request without changing the signed deployment
files or restarting the Host; no such grant path is implemented yet.
The successful attestation contract requires `externalEffects = 0`; native
denials alone cannot establish it. The endpoint therefore issues no signed
receipt and does not advance activation. External observer and endpoint samplers
have different epoch namespaces: compare stability within each channel and bind
process/invocation/profile/module/config identity across channels. Shadow, canary,
soak, health, post-promotion physical recovery and WP18 reuse remain separate work.
