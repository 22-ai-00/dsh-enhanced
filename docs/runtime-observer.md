# Owner-only live DSH runtime observation

Control Plane's optional `runtimeObserver` provides an authenticated, read-only
view of selected live Loader entries. It uses the existing DSH Host and Cordis
lifecycle. It creates no AgentLoop, model tool, scheduler, signing authority
or additional activation state machine.

This is observation input for a future external readiness signer. It does
not issue a `HostAttestationReceipt` or advance an activation. The existing
systemd attestor still supports reload only.

## Configuration

Provision a canonical owner-private directory outside the candidate profile,
with a 32-byte random authentication key in a regular, single-link mode-0600
file. The directory must be mode 0700. Never reuse a receipt-signing key.
Add this optional Control Plane config:

```text
runtimeObserver:
  socketPath: /absolute/owner-private/runtime.sock
  keyPath: /absolute/owner-private/observer.key
  profilePath: /absolute/dsh-home/profiles/web
  targets:
    - entryId: include:dsh-enhanced-personal-memory
      module: '@dsh-enhanced/personal-memory'
      configDigest: <runtimeConfigDigest of the exact raw row config>
      services: [personalMemory]
```

All fields are required. Allow 1–32 distinct entries and up to 16 required
services per entry. The full Loader entry ID includes its Include ancestry;
the tested DSH launcher uses `include:<patch-row-id>`. Match the effective
composition's exact `name` and raw row config. The digest is bounded canonical
JSON; omitted/null config uses `runtimeConfigDigest(null)`. Non-JSON config,
accessors and cycles are rejected. Config content is not returned.

The published package exports `runtimeConfigDigest()` and
`queryRuntimeObserver({ socketPath, keyPath, signal? })`. An owner script can
import them from `@dsh-enhanced/plugin-control-plane`; querying needs no Agent,
session, model or Control Plane mutation. Socket and key must be owned by the
calling UID, so this channel version is for a trusted Host and caller sharing
an owner identity. It does not provision users, ACLs, keys or supervisor units.

Leaving `runtimeObserver` absent preserves normal bundle behavior. Loader is
an optional Host peer: an owned nested injection starts observation only while
the current provider is present. Config updates use normal stop/start. Key
rotation requires a new observer instance; changing the file does not update
the existing key.

## Observed facts

For each target the sampler resolves the live Loader entry. `active` requires:

- An enabled entry with matching module specifier and config digest.
- An ACTIVE Fiber with live UID/store and no unsettled inertia.
- Active providers for every intrinsic/patch-required injection.
- Every required service resolving in the candidate's realm to that Fiber
  or a descendant, rather than an unrelated provider.

Results include Fiber UIDs and observer-local epochs for current store
objects, plus dependency/service provider identities. Cordis may retain the
UID on config update; every activation creates a new store. Epochs are only
comparable under the same random `observerId`, and are neither durable
generations nor counts of intermediate transitions. Samples also contain a
fresh challenge, time, PID, optional systemd InvocationID, configured profile
path and observer-config digest.

The sampler does not import candidates or invoke their service methods. It
reads framework state, including Loader's enabled-state semantics; trusted
deployment config expressions remain part of framework evaluation.

## Channel and lifecycle

Each query generates a fresh 256-bit challenge. Request and response have
distinct HMAC-SHA256 domains. The client validates MAC, challenge and bounded
JSON schema, and checks socket identity before and after. This authenticates
the configured key holder; it is not an OS peer credential check. The future
attestor must compare PID/InvocationID with independent supervisor evidence.

The listener, clients, timers and key buffer belong to the injected Fiber:
at most eight connections, one request per connection, 1 KiB requests,
64 KiB responses, and a two-second absolute connection deadline. The client
also has a two-second total deadline and caller cancellation. Loader
replacement, owner unload and post-listen server errors share one idempotent
async close: stop admission, destroy clients, close the listener, remove the
owned endpoint and erase the key buffer. Teardown errors are reported; failed
shutdown is not proof of released ownership.

Startup refuses to unlink an existing endpoint, including an apparent stale
socket. After ungraceful Host death the owner must establish that the old
process/listener is gone before removing the stale socket. The observer does
not infer this from a pathname or timeout.

## Evidence and limits

The implementation consumes pinned Cordis 4.0.2 / Loader 1.0.3 public
`resolve`, `Entry.fiber`, `Fiber.state/uid/store/inertia` and reflection realm
and store surfaces. It does not rely on the newer sibling Loader resolver
or HMR behavior. Tests cover pending dependencies, provider replacement,
same-UID Fiber restart, disabled entries, foreign service ownership, late
Loader binding, authentication, cancellation, endpoint collision, server
error and async teardown against the installed runtime.

The [real DSH fixture](evidence/runtime-observer-real-dsh-2026-09-19.json)
uses DSH 0.1.5-rc.2, local built Control Plane and Policy package entries,
a temporary Web profile and transient systemd user service. It checks an
active Policy Fiber/service, stable fresh-challenge samples, actual PID and
InvocationID, socket removal on Host stop, and inactive state after disabling
the candidate in the next Host instance. It makes no model request and changes
no existing production profile or service. Reproduction is in
`scripts/e2e/runtime-observer-real-dsh.mjs`; [engineering validation](evidence/runtime-observer-engineering-2026-09-19.json)
records the root gate and independent review.

Observation does not attest installed artifact bytes, transitive dependency
versions, behavioral quality or uninterrupted availability between samples.
It reports configured module selection and current framework state. Malicious
same-process plugins can mutate framework state or steal same-identity
credentials: Cordis is not a hostile-JavaScript isolation boundary.
Readiness signing must still bind independent deployment pins, exact durable
request, activation fence and supervisor generation, and retain its own
protected receipt key. WP16 and WP18 remain incomplete.
