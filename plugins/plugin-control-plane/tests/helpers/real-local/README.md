# D3a-0b real-local activation fixtures (test-only)

These files are test fixtures, never shipped:

- `release.ts` builds a disposable git repository/remote and drives the real
  `bin/dsh-local-release-adapter.js` through all eight release phases, with
  test-only Ed25519 identities and a local `file:` registry.
- `activation.ts` creates a real profile from the installed dsh default web
  profile, builds the real control-plane package peer closure, installs the
  registry tarball through the real `dsh plugin` CLI, and drives
  `activatePluginPlan`.
- `host-attestor.mjs` is a test-only schema-2 Host attestor. It starts/stops a
  real `dsh --profile` process and samples the shipped `queryRuntimeObserver`
  before signing reload/readiness receipts with a disposable key. It is not
  referenced by any shipped trust file or profile.

## Entry discovery rule

After activation swaps the profile, read the actual profile
`cordis.patch.yml` and locate the installed candidate entry inside it. If the
entry is absent the fixture inserts the already-installed package into the
profile patch `insert` group before starting the Host, then reads the entry
back from the same file. The observed Loader entry id/name/config are read
back and written into the control-plane runtime observer targets; no entry id
is guessed before the install exists. There is no bundle-patch fallback: this
dsh version composes installed bundles directly into the profile root.

## Safety semantics

Because the activation plan intentionally has no `liveQualification`, a passed
readiness attestation lands on `awaiting-effect-blocked-replay`, not
`awaiting-live-tasks`: absent independent effect evidence the deployment must
not advance. The bounded live-qualification/commit path is D3a-1 and requires an
owner-bound prepared modify release plus handoff.
