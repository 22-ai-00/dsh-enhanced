# @dsh-enhanced/task-acceptance-contract

An inert shared wire library for immutable task acceptance contracts and
independently produced verification receipts. It declares no DSH bundle and
does not activate services, tools, jobs, network access, filesystem access, or
subprocesses. It only validates plain JSON-compatible values, normalizes scope
paths with Node `path`, and calculates canonical SHA-256 digests with Node
`crypto`.

The exported canonical JSON helper has a finite 1MiB serialization budget.
Contract canonical payloads are separately capped at 256KiB. Target-readback
JSON values collectively consume at most 64KiB, and receipt evidence must fit
the accepted contract's `maxEvidenceBytes` as well as a 1MiB receipt payload
cap.

The package does not make a receipt trusted. A Host-owned producer must bind an
accepted contract to its durable authority and independently obtain evidence.

`task-acceptance/v1` and `task-verification/v1` retain their original task
identity (`automation-run` or `foreground-turn`) and canonical digest form.
`v2` is reserved for durable native-goal execution: it only accepts a
`goal-step` task with its immutable goal definition digest and version, step,
run, session, native goal ID, and native revision. A verification receipt must
use the matching protocol version and reproduce the complete task identity.
`v3` is reserved for whole-goal assessment: it only accepts a `goal-outcome`
task whose `ref` is its assessment ID and whose binding contains the immutable
goal definition ID, version and digest, assessment ID, session ID, and native
goal ID. It deliberately has no step, run, or native revision fields. The
immutable contract itself freezes the acceptance criteria, profile, and bounds;
an assessment must not substitute a separate criteria digest. A v3 receipt
must use `task-verification/v3` and reproduce that complete binding. Existing
v1 and v2 canonical payloads and digests remain unchanged.
The wire library validates and binds these values; a Host producer remains
responsible for obtaining them from an authoritative goal lifecycle.
