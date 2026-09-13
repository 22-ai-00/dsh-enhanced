# Live GitHub repository E2E

For installation or initial-session failures, first run the same entry with
`DSH_REPO_SETUP_ONLY=1` and neither live input variable. This stops after the
shipped goal setup discovers the idle owner session. Its observer rejects all
model requests, and its separate output directory contains `setup-proof.json`
rather than a task-completion proof. Fixture flags are optional. This probe
does not validate model behavior, remote access, or goal execution; run the
complete scenario after the concrete setup failure has been fixed.

The existing repository Playwright scenario can use the production Actions and
EventTriggers GitHub transports when `DSH_REPO_LIVE_INPUT` names a private JSON
descriptor. This mode creates a commit and pull request on an already-existing,
isolated test branch in the named repository. It does not create a branch. Do
not use a production repository or branch.

The descriptor is mode `0600`, an absolute regular file, and contains no token
or credential value. Its `credential` object is the exact non-secret Keychain
handle reference already used by the operator's source profile. The test copies
only that reference into its new temporary profile; it never copies or prints a
secret. Environment and OS-Keychain references are reusable. A protected-file
reference is accepted only when its existing path is an absolute private regular
file; the file contents are never read by the harness.

```json
{
  "version": 2,
  "repository": "example/e2e-target",
  "baseBranch": "main",
  "temporaryBranch": "e2e/source-retirement",
  "paths": ["summarize.mjs"],
  "credentialHandle": "github-live-e2e",
  "credential": {
    "id": "github-live-e2e",
    "provider": "environment",
    "consumers": ["dsh-enhanced-assistant-actions", "dsh-enhanced-event-triggers"],
    "purposes": ["github.commit", "github.observe"],
    "maxLeaseMs": 30000,
    "reference": { "environmentName": "DSH_E2E_GITHUB_TOKEN" }
  },
  "expiresAt": 1790000000000,
  "maxActions": 75,
  "maxTotalBytes": 1048576,
  "requiredChecks": [{ "name": "CI", "appId": 7 }],
  "reviewerIds": [42],
  "minApprovals": 1,
  "event": { "maxPolls": 180, "maxFires": 4, "pollIntervalMs": 2000, "requestTimeoutMs": 10000 }
}
```

`temporaryBranch` is the delivery and observation branch and must already exist
before the test starts. Its name is retained for compatibility with the input
format; it is not a request to create a branch. `expiresAt` must be between six
and ten minutes from descriptor validation so it fits the scenario's finite
ten-minute isolation grant and its execution/wake window.

Goal setup first installs the exact owner Policy, delivery grant, route
authority, and bounded automation budgets. Before the model receives the prompt,
the installed EventTriggers service makes
an authenticated read-only baseline observation of the exact repository and
branch using `github.observe`. The test requires one observed source plus a
successful, error-free health row; a missing handle, wrong consumer/purpose,
unusable credential, or inaccessible repository/branch stops there before any
remote write.

Run without either fixture flag:

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
DSH_WEB_REAL_PROVIDER=traex-agent DSH_WEB_REAL_MODEL=gpt-5.6-terra \
DSH_REPO_LIVE_GITHUB=1 \
DSH_REPO_LIVE_INPUT=/absolute/private/live-repository.json \
pnpm exec playwright test --config scripts/e2e/playwright-repo-real.config.mjs
```

The test rejects a missing, non-private, expired, broad, malformed, or
fixture-mixed descriptor before installation or model work. It does not run in
this repository's normal test suite because it commits to the explicitly bounded
existing test branch and creates a pull request. After delivery it waits for the real event
snapshot, a successful wake, the existing repository-readback outcome receipt,
source retirement, and a final restart that produces no new source event.

This scenario repairs only `summarize.mjs`, matching the production admission contract and its independent verification artifact. Prepare a fresh descriptor immediately before running: at goal setup, its fixed deadline must still be more than six minutes away. Installation and container prechecks consume part of that window; an expired or insufficient authorization is rejected, never extended automatically. The read-only baseline verifies observation access; commit and PR write permissions are established only by the subsequent explicitly authorized delivery attempt.

Observation starts during preflight, so its poll budget must cover setup, model execution, and CI/review latency as well as event waiting. The example permits 180 polls at two-second intervals; it does not reserve all polls until the PR exists.
