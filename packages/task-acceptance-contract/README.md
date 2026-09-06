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
