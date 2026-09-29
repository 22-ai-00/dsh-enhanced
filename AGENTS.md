# dsh-enhanced agent guide

## Mission

Build an intelligent tool that improves through ordinary use: authenticated task feedback → durable learning → skill/tool/plugin candidate → independent verification → bounded adoption → subsequent tasks → observation/rollback. Evolution includes durable factual/experience memory and engineering capabilities, primarily through creating and dynamically loading Cordis plugins. After initial setup and authorization, the owner should not need to orchestrate each improvement.

This pnpm monorepo contains independently publishable DSH bundles in `plugins/*`; `packages/*` contains shared libraries that never auto-enable.

## Start here

Read [current status](docs/rsi-status.md) for the current boundary and next delivery. Load only the guide and plugin README relevant to the task; do not preload the documentation tree, completed work, historical probes, or research notes.

| Change | Required reference |
| --- | --- |
| Add/restructure a plugin | [Creating a plugin](docs/creating-a-plugin.md); finish package, patch, tests, README and catalog row together. |
| Package boundaries, shared code, Host/Web | [Architecture](docs/architecture.md); preserve independent publication and composition. |
| DSH/Cordis dependency or new upstream API | [Compatibility](docs/compatibility.md); keep baseline and affected packages consistent. |
| Lifecycle, injection, config, effects, isolation, Loader or HMR | [Cordis runtime contracts](docs/cordis-runtime-contracts.md) and `/home/jiataorui/work/github/cordis`; verify executable behavior against this lockfile's installed fork and Loader/Include versions. |
| Acceptance or release | Relevant rows of [acceptance contract](docs/rsi-acceptance.md) and [release guide](docs/releasing.md). |

## Self-iteration principles

- Reuse DSH's native agent loop and Cordis lifecycle; do not add duplicate loops or goal state machines. Models are replaceable suppliers; identity, history and versioned capabilities must survive supplier changes.
- Repair/growth inherits the triggering conversation/task model unless explicitly overridden. Freeze and persist the resolved supplier, budget and acceptance contract per run; never silently switch during recovery.
- Ordinary authenticated outcomes, corrections and repeated work must drive learning without developer orchestration or a preconfigured task acceptance scenario. Fixed scenarios are regression evidence, not the product loop.
- Keep acceptance rules and held-out tasks outside candidate write authority. Promote only from fresh independently checked outcomes, never model self-ratings or successful tool exits alone.
- Judge improvement on subsequent real tasks: quality, cost, latency and regressions. Deduplicate canonical task revisions, fence decisions against corrections/withdrawals, and do not treat deployment association as causal evidence. Use bounded versioned comparisons with the same supplier/budget where needed; retain failed attempts.
- Link actions and peer claims to agent/run identity, capability versions and original evidence. Derive repair triggers from current owner-bound feedback, not global gap records. Enforce existing owner authorization before action; observe afterward, bound changes, retain rollback and reconcile unknown outcomes before retrying.
- Publish the next npm release once an installable deployment supports the ordinary-use loop and passes release verification. Intermediate APIs, pending proposals and repeated hand-run probes do not meet this gate.

## Repository contracts

- User-installable bundles live in `plugins/<kebab-case-name>`, non-activating libraries in `packages/<kebab-case-name>`. Use `pnpm create:plugin <name>`; evolve template and generator together.
- Keep directory, package suffix, Cordis row id, source name and catalog identity stable and unambiguous. `dsh.bundle.patch` must be `./cordis.patch.yml` and mount the published package name; legacy `.dsh-plugin` metadata is invalid.
- Ship `lib/`, `cordis.patch.yml`, `README.md` and `LICENSE`. Host-supplied DSH services are peers; libraries that travel with the plugin are dependencies.
- Put runtime metadata on the value Loader mounts. Validate deployment values with synchronous Standard-Schema `Config`, declare required injections, and own every external resource through Cordis effects/disposers. Follow the detailed runtime contracts for these changes.
- Document filesystem, network, subprocess, credential, browser and install-script authority in the plugin README. Update [plugin catalog](plugins/README.md) when adding, renaming, deprecating or removing a plugin.

## Verification and delivery

Deliver capability-sized commits. After relevant checks and independent review, commit and push an independently usable capability to `dev` before starting another main capability; keep unfinished work out. Bulk version changes belong in a separate release commit when ready.

Run root `pnpm check` before final delivery/publication: manifest validation, zero lint warnings, typechecking, tests, clean build and every package's dry-run pack. Inspect pack file lists when boundaries or `files` change. Capability checks do not replace full verification; skipped external tests do not establish live behavior. Keep development checks focused on changed behavior and concrete risks, not repeated live-model scenarios.

Scope changes to the requested capability/shared contract. Keep generated `lib/`, coverage, tarballs and caches untracked; raw JSON, logs and runtime evidence belong in ignored `docs/evidence/` or CI artifacts. Commit concise commands, results and limitations.

Keep [current status](docs/rsi-status.md) short: goal, capability boundaries, active blockers, next acceptance and latest verification only. Replace superseded entries; remove completed implementation/test/deployment narratives instead of creating another history ledger. Update maintained guides and incoming links when behavior changes; use Git for history and dated research only for rationale.
