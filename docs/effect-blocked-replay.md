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

## Verification

Verified on Linux with Node 24.7.0 on 2026-09-20:

- `pnpm check` exited 0: manifest validation, zero-warning lint, typechecking,
  6,053 tests passed (44 skipped), clean build and 35 plugin dry-run packs.
- The native replay suite passed all 11 cases; the Delivery reply fence suite
  passed all 5 cases. Full package suites passed 459 and 777 tests respectively.
- Pack lists include both new runtime modules and declarations alongside the
  required package files. Raw run data and logs stay local or in CI artifacts.

These checks cover the component boundaries described here; the native replay
suite is Linux-only and does not verify production activation or model quality.

## Evidence limits and next integration

This component's observations are **unsigned and process-local**. They cannot
advance `awaiting-effect-blocked-replay` or replace a Host attestation. Owner
request/case configuration is a trust input; the caller cannot prove its own
authorization merely by supplying `requestDigest`.

The boundary covers native tool bodies and Agent reply admission for these
calls. It does not cover arbitrary Node code, pre/post hooks, other Delivery
Host APIs, filesystem/network access, subprocesses, or a malicious same-UID
plugin. Cordis service routing and Fiber ownership are not OS isolation.
No global `externalEffects = 0` claim is derived from these observations.

The next integration must put immutable cases and durable admission outside
candidate write authority, authenticate a finite Host endpoint, independently
bind systemd/Loader identity and collect fresh external observations, then sign
the existing exact Host request. Unknown execution must reconcile without a
second dispatch. Shadow, canary, soak, health, post-promotion physical recovery
and WP18 repository reuse remain separate work.
