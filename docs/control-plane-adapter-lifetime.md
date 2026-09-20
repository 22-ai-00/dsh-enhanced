# Control Plane adapter process lifetime

The existing release and Host-attestation runners share
`plugin-control-plane/src/adapter-process.ts`. This internal module belongs to
the independently published Control Plane bundle; it adds no plugin graph,
AgentLoop, goal state or model tool.

## Defect and recovery contract

Previously, timeout and output overflow sent SIGKILL only to the direct child
and waited for Node's `close` event. A descendant inheriting stdout could keep
the pipe open after that child died. A controlled baseline run at `50180f7`
configured an 800 ms Host-attestor timeout: 2.5 seconds later the promise was
still pending and its descendant remained alive. Killing that fixture
descendant finally allowed the original TIMEOUT to settle.

Every invoked adapter command now owns a new Linux process group. The runner:

1. Retains the existing descriptor-pinned executable/interpreter and artifact
   FD mapping, exact argv, environment allowlist and bounded stdin/stdout.
2. Starts cleanup on timeout, output overflow, execution failure **or leader
   exit**, including a successful leader that left background helpers.
3. Sends TERM, allows 75 ms, then sends KILL if the group still exists.
   Surviving group members are checked through `/proc`; zombies are already
   stopped and do not retain execution authority.
4. Uses a monotonic 375 ms cleanup deadline, 16 concurrent reads and a 4096 PID
   inspection cap. An absent group takes the fast path. Inspection failure
   still triggers a final KILL attempt and returns a cleanup error.
5. Requires the direct child's `exit` observation. On a potential success,
   stdout gets at most another 100 ms to drain; timeout, overflow and stream
   errors are rechecked afterward. Unclosed pipes are destroyed on settlement.

Existing per-command timeouts are preserved: version probe, capability probe
and execution still use their configured command budgets. Cleanup is bounded
in addition to that budget. Failed spawn and early stdin closure are handled
without an unhandled EPIPE or an unbounded wait for `close`.

Host and release callers keep their existing error contracts. TIMEOUT and
OUTPUT_LIMIT retain those codes; nonzero exit, start failure or an inability
to prove cleanup map to FAILED. No cleanup error becomes a successful receipt
or advances the durable operation. Existing signed receipts, operation IDs,
fences, cached dispatch markers and independent reconciliation remain in use.

## Limits

This is process ownership for trusted owner adapters. A descendant which calls
`setsid()` or otherwise enters a different process group can escape it. The
tests deliberately create such a descendant retaining stdout: the invocation
fails within the cleanup bound, while the test harness must terminate that
escaped process. Strong containment needs an external supervisor/cgroup or
container boundary.

The runner must itself remain alive to execute cleanup. This module does not
provide recovery after the CLI/Host is SIGKILLed, crashes, or the machine loses
power; those cases require owner supervision and durable resource
reconciliation. A blocked kernel operation, unavailable `/proc`, inspection
cap or permission failure yields FAILED rather than a claim of quiescence.

Terminating a local helper does not undo a registry PUT, systemd request,
catalog exchange or other already submitted effect. Adapter implementations
must retain their durable operation identities and reconcile unknown external
outcomes before any new attempt. Process-group cleanup alone does not prove
DSH readiness, canary quality, production activation or rollback.

## Verification and Host integration

Real subprocess tests cover timeout/overflow with inherited stdout, nonzero
exit, successful leaders leaving attached or background descendants, escaped
pipes, late output overflow, stdin EPIPE, failed spawn and inherited FD
ownership. Both public runner paths are exercised; the existing Host
descriptor tests retain independent pathname-swap coverage.

Baseline observations, source digests, full-check results and review scope are
recorded in the engineering evidence.

The [systemd Host attestor](systemd-host-attestor.md) now uses the existing
`probe` → signed receipt → CAS seam for reload, readiness and physical rollback.
It persists operations before supervisor dispatch and binds the exact unit,
profile, plan, fence and invocation, with a separately held signing key.
[Native replay and its finite endpoint](effect-blocked-replay.md) provide
unsigned observations. Replay signing and the shadow/canary/soak/health gates
still need independent measured evidence; recovery bootstrap and Health counters
cannot replace those observations.
