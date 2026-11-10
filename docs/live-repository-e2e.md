# Live GitHub repository E2E

> **Migration pending:** the repository-autonomy E2E still creates a
> Docker-era verifier configuration. The current Host accepts Linux-native
> verification, so this Playwright scenario (including setup-only mode) is not
> a runnable validation path yet. The contract below is retained for migration.
> Migrate the scenario and preserve its repository, task, restart, and
> readback checks before restoring a runnable command.

The historical repository Playwright scenario was designed to use the production Actions and
EventTriggers GitHub transports when `DSH_REPO_LIVE_INPUT` names a private JSON
descriptor. The v3 commit mode creates a direct commit on an already-existing,
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
  "version": 3,
  "deliveryMode": "commit",
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
  "requiredChecks": [{ "name": "verify", "appId": 15368 }],
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

The JSON example above is retained as the historical v3 input contract. Its
scenario is not executable while the native migration above is pending.

The intended test rejects a missing, non-private, expired, broad, malformed, or
fixture-mixed descriptor before installation or model work. It is not part of
this repository's normal test suite because it commits to the explicitly bounded
existing test branch. Its intended post-delivery checks wait for the real event
snapshot, a successful wake, the existing repository-readback outcome receipt,
source retirement, and a final restart that produces no new source event.

The migrated scenario must retain the `summarize.mjs`-only repair scope, matching the production admission contract and its independent verification artifact. Its fresh descriptor must preserve the original timing constraint: at goal setup, its fixed deadline must still be more than six minutes away. Installation and linux-native runtime prechecks consume part of that window; an expired or insufficient authorization is rejected, never extended automatically. The repo-autonomy harness itself still constructs Docker-era runner config and is fail-closed pending the native migration tracked in [RSI status](rsi-status.md). The read-only baseline verifies observation access; commit write permission is established only by the subsequent explicitly authorized delivery attempt.

Observation starts during preflight, so its poll budget must cover setup, model execution, and CI latency as well as event waiting. The example permits 180 polls at two-second intervals; it does not reserve all polls until the commit exists.

Version 3 requires `deliveryMode: "commit"` and rejects reviewer fields; no PR or reviewer account is needed. `requiredChecks` must use actual check-run names and app IDs from the controlled repository, not the workflow title. The example is a GitHub Actions check named `verify`. Only the delivered commit is eligible for outcome verification; an advanced branch head cannot satisfy it. The finite test window requires a check that can finish within that window.

The historical v2 contract retains explicit PR/reviewer behavior. Its controlled-transport variant used `DSH_REPO_VERIFIED_DELIVERY=fixture DSH_REPO_EVENT_SOURCE=fixture DSH_REPO_DELIVERY_MODE=commit` without live input variables. Migration must preserve the production Goal, Actions, event, verification and feedback checks against controlled remote responses; those results do not establish a real GitHub write.

The historical `DSH_REPO_REQUIRE_PREAUTHORIZED=1` mode required the admitted task to complete without additional tool approvals. Migration must preserve immediate failure when an approval appears, the diagnostic `approvals.json`, and refusal to accept that prompt. Expired or invalid wait authority must remain a denied request.
