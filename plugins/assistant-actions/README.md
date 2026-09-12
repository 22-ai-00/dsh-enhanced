# @dsh-enhanced/assistant-actions

Experimental finite, owner-authorized GitHub action bundle. Its Cordis-facing service preserves the existing tool and Host API, while deployment selects one of two explicit backends: legacy `embedded-compat`, or the versioned `external-unix-v1` broker. Embedded mode keeps the existing trusted-Host Keychain/ledger/HTTPS path. External mode sends signed, bounded requests to a separately started `dsh-actions-broker` process, which owns the credential, authoritative grants, journal and GitHub HTTPS connection. Neither mode gives a credential to the model or isolated worker. An empty grant set exposes no usable GitHub authority.

## Installation and compatibility

Install this bundle with matching checkout/release versions of `assistant-policy`, `assistant-delivery`, and `assistant-isolation` when shell execution is needed. Embedded compatibility mode additionally needs `credentials-keychain`; external mode deliberately does not ask the Host Keychain for the GitHub token. Tool registration also needs native Agents and Tools. The bundle requires DSH `0.1.2-rc.1`, Cordis `^4.0.1`, Node `^22.19.0 || >=24`, Linux and POSIX private-file ownership semantics for the external Unix sockets, and the Policy preauthorization/evaluateAgent methods introduced with this broker. The package dependency on `koffi` supplies the broker's fixed Linux `getsockopt(SO_PEERCRED)` binding. Optional peer metadata controls package installation only; it does not make runtime authentication optional.

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-actions
dsh --profile web --dump-config
```

Use a current owner record and an existing non-production branch for first deployment. The following is the legacy embedded-compatible shape; configuration grants contain no token:

```yaml
stateRoot: /absolute/private/assistant-actions
grants:
  - id: repo-fix
    revision: 1
    principalDigest: <sha256-of-current-principal-id>
    principalRecordId: <current-owner-record-id>
    principalVersion: 1
    workspace: /absolute/project
    agentPreset: primary
    repository: owner/repository
    branch: automation/fix
    paths: [src/example.ts, tests/example.spec.ts]
    credentialHandle: github-repository-token
    expiresAt: <absolute-unix-milliseconds>
    maxActions: 10
    maxTotalBytes: 1048576
    rollback: # omitted means that no forward commit can be compensated
      allowRollback: true
      budgetId: github-compensation
      maxActions: 2
      maxTotalBytes: 1048576
    repoWorkflow: # omitted means branch/PR writes are unavailable
      baseBranch: main
      allowBranchCreate: true
      allowPullRequest: true
```

In embedded mode the Keychain handle must allow consumer `dsh-enhanced-assistant-actions`, purpose `github.commit`, and leases up to 30 seconds. A rollback-enabled grant also requires purpose `github.compensate`; commit permission does not imply compensation permission. Reuse the Keychain provider appropriate for the environment and never place a token in this YAML. Policy must separately allow the exact agent/owner `execute` resource `{ kind: tool, id: "action:github:repo-fix" }`, native tool execution of `action_github_commit`, and background `credential.use` for the chosen handle. Any Policy deny or emergency stop remains authoritative. Explicit capability grants skip only Policy's generic risk prompt for this exact broker definition; they do not disable other approval providers or arbitrary tool checks. Policy budget evaluation during polling is read-only; one authorization with a stable action key is charged before credential retrieval and dispatch. Failed credential acquisition does not refund that budget.

### External Unix broker

`external-unix-v1` is opt-in and fail-closed. The Host config names the canonical action Unix socket, pinned broker identity/public key, client signing key, expected action-socket ownership/mode, protocol timeouts and a minimum broker generation. The separately managed daemon reads its own strict configuration and private state. That daemon configuration—not the Host mirror—is authoritative for grant revision, owner/binding generation, repository, branch, paths, limits, allowed operations, allowed inspect kinds and the credential locator. External mode accepts expected-head `commit`, `repository`, `branch`, grant-path-scoped `file`, and explicitly authorized `pull-request`, `checks`, and `reviews` inspection. PR-related inspection requires a grant-fixed `destination.baseBranch`, distinct from the head branch, plus an exact request PR number. Both repositories and both refs are verified before any observation is returned. External verified delivery queues independently accepted artifacts for a broker commit followed by an explicitly authorized PR, and supports fresh repository-goal readback. Branch creation and compensation remain unsupported in external mode and never fall back to embedded execution. Direct model PR creation remains embedded-only; external PR creation is used by the trusted verified-delivery handoff.

The Host-side configuration uses the exact read-only grant projection below. `grants` must be empty in external mode. `externalGrants.allowedOperations` and `externalGrants.allowedInspectKinds` let the Host conservatively limit discovery and preauthorization before contacting the broker; the latter accepts all six inspect kinds, with `destination.baseBranch` required for PR-related kinds. Existing grants without the new kinds retain their original canonical digest and authority; enabling these reads requires a new broker-issued grant and matching projection. The projection still contains no credential locator, `clientKeyId`, client identity, policy/emergency epochs, or rollback authority. Optional `verifiedDelivery` metadata binds the Host owner route, finite scheduling budget and acceptance mode to the broker-issued grant; it is not a credential or a broker-side artifact verifier. The broker-owned grant remains authoritative, so matching projection fields can only narrow Host exposure and cannot expand broker authority. Its `grantDigest` must match the authoritative daemon grant; `source` binds the input classification and provenance. `maxCostUnits` mirrors the grant's finite cumulative `github-api-units` budget (one unit for a commit, PR creation or repository/branch/file/PR inspection; two units for checks or reviews, which first resolve the exact PR head); it is not a currency or provider-billing guarantee.

```yaml
stateRoot: /absolute/private/assistant-actions-host
broker:
  mode: external-unix-v1
  actionSocketPath: /run/dsh-actions-broker/action/broker.sock
  brokerId: github-primary
  brokerPublicKeyPath: /absolute/private/host/broker-public.pem
  clientKeyId: host-primary
  clientSigningKeyPath: /absolute/private/host/client-private.pem
  clientInstanceId: dsh-host-primary
  clientGeneration: 1
  requestTimeoutMs: 30000
  helloTtlMs: 30000
  expectedSocketUid: <broker-uid>
  expectedSocketGid: <dedicated-action-gid>
  expectedSocketMode: 432 # 0660
  expectedSocketParentUid: <broker-uid>
  expectedSocketParentGid: <dedicated-action-gid>
  expectedSocketParentMode: 488 # 0750; use 448 (0700) for same-UID-only access
  expectedBrokerPeerUid: <broker-uid>
  expectedBrokerPeerGid: <broker-primary-gid>
  minimumBrokerGeneration: 1
grants: []
externalGrants:
  - id: repo-fix
    revision: 1
    grantDigest: <sha256-issued-by-broker>
    owner:
      principalDigest: <sha256-of-current-principal-id>
      principalRecordId: <current-owner-record-id>
      principalVersion: 1
      workspace: /absolute/project
      preset: primary
      bindingId: <current-delivery-binding-id>
      bindingVersion: 1
      bindingGeneration: 1
    sessionId: <exact-owner-session-id>
    destination:
      classification: github-repository
      repository: owner/repository
      branch: automation/fix
      paths: [src/example.ts, tests/example.spec.ts]
    expiresAt: <absolute-unix-milliseconds>
    maxActions: 10
    maxTotalBytes: 1048576
    allowedOperations: [commit, inspect]
    allowedInspectKinds: [repository, branch, file]
    source:
      classification: internal
      provenanceDigest: <sha256-of-source-provenance>
    maxCostUnits: 10
```

The Host verifies the action socket's parent and socket metadata against all six `expectedSocket*` fields before and after connecting. After connect and before reading the server hello, its package-provided Linux `SO_PEERCRED` inspector must also report the exact `expectedBrokerPeerUid`/`expectedBrokerPeerGid`; this prevents a pathname-compatible process under another identity from serving the connection. For a separate Host UID, provision a dedicated group (or an equivalent ACL), make the Host a member, and pair a traversable group-owned parent such as `0750` with an action socket mode such as `0660`; both Host and daemon configs must pin those deployed UID/GID/mode values. A same-UID-only layout can instead keep the parent `0700` and socket `0600`. These filesystem permissions only make the endpoint reachable and do not replace signed protocol authentication or either side's live peer-credential check.

The wire protocol is `assistant-actions/github-broker/v1`: a four-byte big-endian length followed by canonical UTF-8 JSON, with an 8 MiB request ceiling and 2 MiB response ceiling. A fresh connection receives a short-lived signed challenge; client requests and broker receipts use pinned Ed25519 keys and bind broker/client generations, request and payload digests, owner lineage, Session, grant revision, destination, deadline, Policy/emergency epochs and finite budget. Unknown fields, non-canonical JSON, invalid signatures, stale generations, oversized/truncated/trailing frames, socket identity changes, timeouts and unavailable daemons are rejected. Action requests are accepted only on the action socket; signed operator requests are accepted only on the admin socket. The client performs no automatic retry.
The server, Host client and administrator must use three pairwise-distinct Ed25519 key pairs and distinct client/admin key identifiers. Equal key material is rejected before either listener is opened, even when different files contain it.

Start and administer the daemon explicitly with the package executable; the Cordis plugin never spawns it. `serve` and the administrative commands deliberately use separate configuration files:

```sh
dsh-actions-broker serve /absolute/private/broker-serve.json
dsh-actions-broker status /absolute/private/broker-admin.json
dsh-actions-broker stop /absolute/private/broker-admin.json <expected-control-version> operator-request
dsh-actions-broker resume /absolute/private/broker-admin.json <expected-control-version> <expected-generation>
dsh-actions-broker revoke /absolute/private/broker-admin.json <expected-control-version> <grant-id> <revision> <grant-digest> <policy-epoch> <emergency-epoch> operator-request
```

The relevant transport/admission fields in the serve configuration are separate for the two listeners (the full file also contains the broker keys, state, credentials, grants and policy fields):

```json
{
  "actionSocketPath": "/run/dsh-actions-broker/action/broker.sock",
  "adminSocketPath": "/run/dsh-actions-broker/admin/broker.sock",
  "expectedClientPeerUid": 1001,
  "expectedClientPeerGid": 2001,
  "expectedAdminPeerUid": 1002,
  "expectedAdminPeerGid": 2002,
  "expectedActionSocketUid": 1000,
  "expectedActionSocketGid": 2001,
  "expectedActionParentMode": 488,
  "expectedActionSocketMode": 432,
  "expectedAdminSocketUid": 1000,
  "expectedAdminSocketGid": 2002,
  "expectedAdminParentMode": 488,
  "expectedAdminSocketMode": 432,
  "maxActionConnections": 32,
  "maxAdminConnections": 4,
  "maxConcurrentRequests": 2
}
```

Here the decimal modes are `0750`, `0660`, `0750`, and `0660`, respectively. Choose UID/GID values for the actual deployment rather than copying these placeholders. The operator configuration names only the admin endpoint:

```json
{
  "adminSocketPath": "/run/dsh-actions-broker/admin/broker.sock",
  "brokerId": "github-primary",
  "minimumBrokerGeneration": 1,
  "brokerPublicKeyPath": "/absolute/private/operator/broker-public.pem",
  "adminKeyId": "operator-primary",
  "adminPrivateKeyPath": "/absolute/private/operator/admin-private.pem",
  "adminInstanceId": "operator-primary",
  "adminGeneration": 1,
  "expectedAdminSocketUid": 1000,
  "expectedAdminSocketGid": 2002,
  "expectedAdminSocketMode": 432,
  "expectedAdminParentUid": 1000,
  "expectedAdminParentGid": 2002,
  "expectedAdminParentMode": 488,
  "expectedBrokerPeerUid": 1000,
  "expectedBrokerPeerGid": 1000,
  "requestTimeoutMs": 30000,
  "helloTtlMs": 30000
}
```

Both configuration paths must be canonical absolute paths to owner-owned, `0600`, nonsymlink regular files containing only the exact JSON keys for their command class. The serve config has distinct `actionSocketPath` and `adminSocketPath` values. It independently pins `expectedClientPeerUid`/`expectedClientPeerGid` and `expectedAdminPeerUid`/`expectedAdminPeerGid`; action/admin socket ownership uses the respective `expectedActionSocketUid`/`expectedActionSocketGid` and `expectedAdminSocketUid`/`expectedAdminSocketGid`; and the two endpoints have separate `expectedActionParentMode`/`expectedActionSocketMode` and `expectedAdminParentMode`/`expectedAdminSocketMode`. `maxActionConnections` and `maxAdminConnections` bound the listeners independently, while `maxConcurrentRequests` bounds action execution only. The serve config contains `adminKeyId` and `adminPublicKeyPath`, but never the administrative private key.

The operator config used by `status`, `stop`, `resume`, and `revoke` contains only `adminSocketPath`—never `actionSocketPath`—plus the pinned broker public identity, admin signing identity, expected admin parent/socket ownership/mode, `expectedBrokerPeerUid`/`expectedBrokerPeerGid`, and protocol limits. In particular it contains `adminKeyId`, `adminPrivateKeyPath`, `adminInstanceId`, and `adminGeneration`; it does not contain daemon credentials, client keys or the server private key. Like the Host client, the operator client checks pathname identity, then verifies the connected broker's kernel peer UID/GID before reading the signed hello.

`stop` also accepts `security-response` or `maintenance`; `revoke` also accepts `security-response`, `grant-replaced`, or `grant-expired`. Administrative requests use that separately pinned signing identity and the dedicated bounded admin socket rather than opening SQLite directly. An action connection cannot carry an admin request, and action connection/request saturation does not consume the admin listener's reserved connection capacity. The `stop` command is a durable emergency admission stop: it rejects new actions, terminalizes/aborts affected in-flight work and advances the emergency epoch, but it does not exit the daemon or close the admin control plane; use the service manager, `SIGTERM`, or `SIGINT` to stop the process. `resume` advances the durable emergency epoch again, so it cannot revive an old request. Before binding either socket, `serve` requires Linux and the package-provided `koffi` native binding for `getsockopt(SO_PEERCRED)` to be available. Unsupported/non-Linux hosts or an unavailable native binding fail closed before bind; accepted connections must then match the role-specific peer UID/GID. Pathname ownership alone is not treated as peer authentication. Secrets and private-key bytes must not be supplied through argv, environment, Host config, tool input or IPC.

Deployments may make the action parent/socket group-accessible (for example through a dedicated group or an equivalent ACL) so a Host running under an independent UID can connect, while still pinning the resulting action parent/socket metadata and the Host peer UID/GID. The admin parent/socket should remain private to the broker/operator trust boundary. These access controls permit transport access only; Ed25519 request authentication and the broker-owned grant remain authoritative.

Configured workspace/preset scopes permit only `isolation_run`, read-only `isolation_grants`, goal context/checkpoint, and the exact currently preauthorized broker. Ordinary Host shell, generic code dispatch, filesystem tools and nested tool routes are denied there, including after grant expiry/revocation. Removing this bundle removes its guard; operators must retain Isolation routing while workers/scopes remain managed. Trusted Host plugins share Host authority and must be audited; the named consumer check is not OS isolation against a malicious Host plugin.

## Commit and recovery semantics

`action_github_commit` accepts `grantId`, `idempotencyKey`, `expectedHeadOid` (40 lowercase hex characters), `headline`, and `files: [{path, content}]`. Only configured exact paths may be added/updated, at most 32 files and 1 MiB per request including headline/path bytes. Both backends support that expected-head commit. External v1 inspection includes the grant-scoped snapshots described below; file reads accept only exact-path UTF-8 blobs up to 64 KiB.

Both modes support explicitly scoped pull-request, checks, and reviews inspection. Those snapshots are observed state, never proof that an earlier mutation settled. Checks and reviews return one bounded page (20 checks or 30 reviews), with `truncated` and `untrusted` metadata; an incomplete page cannot establish an overall CI/review verdict. Embedded mode can also expose `action_github_branch` and `action_github_pr` when `repoWorkflow` explicitly authorizes them. PR creation validates its receipt against both repositories and head/base refs, but GitHub provides no atomic expected-head CAS for that endpoint. External PR-related reads require the exact base branch in both the authoritative grant and Host projection. These read kinds alone do not authorize branch or PR creation; PR creation requires a separate `pull-request` operation grant. Every inspection consumes the selected backend's durable `maxActions` reservation, including across restarts. Neither mode supports merge, release, force push, arbitrary endpoints, issue/review mutation or raw API access.

The fixed GitHub [createCommitOnBranch mutation](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch) binds the expected current head and appends the requested changes to that branch. Its success response is checked against the action marker, repository, branch, parent and resulting ref. A commit receipt is not independent validation of code quality or user-goal completion. The credential owner authors the commit; repository protections and token permissions still apply. Creating a commit can trigger workflows configured for that branch, so the operator's repository/branch/path grant also authorizes those normal repository consequences.

For external PR follow-up, the operator issues a grant with `destination.baseBranch: main` (the head `destination.branch` must differ) and `allowedInspectKinds: [pull-request, checks, reviews]`, with `inspect` in `allowedOperations`; install the exact generated projection in `externalGrants`. The agent can then use `action_github_inspect` with the grant ID, `kind`, and `pullRequestNumber`. Checks and reviews resolve that PR's current head before reading the bounded result page. Responses retain `untrusted` and `truncated`; a successful read does not establish task completion, CI success, or review approval.

For external verified delivery, the operator adds `verifiedDelivery: { ownerRouteId, budgetId, acceptance }` to a new broker grant and its exact projection, with `commit` and optionally `pull-request` in `allowedOperations`. `goal-step` permits intermediate delivery while the original goal waits for remote CI/review; the default `goal-outcome` waits for whole-goal acceptance. Model calls to raw commit/PR cannot bypass this handoff. The Host owns only `verified-delivery.sqlite` for scheduling, historical signed receipts and notification state; the broker owns the authoritative action ledger and credentials. Artifact bytes are reconstructed from current independently accepted Goals evidence and are not copied into this handoff journal. Signed receipts establish historical broker results; current owner/goal/grant checks and fresh scoped reads are still required to establish a repository outcome. Broker generation and policy/emergency epoch changes during readback invalidate the observation.

The formal Web goal admission accepts `repositoryDelivery.externalGrantId` instead of `credentialHandle`. It verifies an already configured external projection against the exact bound owner/Session, repository, paths, limits, admission owner route and budget, and installs only the necessary Host policy/Verifier configuration. It never issues a broker grant or copies credentials. The operator must provision the broker and matching projection first. External repository event polling is not yet wired through this admission; external tasks with `events` fail closed.

External ledger schema v2 transactionally upgrades v1 requests and credential leases, preserving grant, action, budget and audit history. A pending or unknown PR holds the same repository/head/base scope across grants and revisions; a successful PR also prevents another request for the same expected head. A different expected head can be a new operation only after the previous PR operation is known successful. This does not settle an unknown remote write. Uncertain commits hold their repository/branch/expected-head scope, while bounded investigation reads remain available.

The selected backend's private SQLite WAL/FULL journal reserves cumulative actions and bytes before credential retrieval. External mode makes the daemon the sole grant/journal writer and GitHub HTTP originator; the Host neither opens the broker database nor treats its deployment mirror as authority. The external token is read only from a daemon-UID-owned Linux protected file, never an environment variable. The short action deadline is at most 30 seconds and never exceeds grant expiry. Prepared/dispatched action occupancy is bounded by `maxConcurrentRequests`. Unknown mutations retain write occupancy, while bounded reads remain available for investigation; unknown reads do not permanently exhaust concurrency. Grant revision changes do not refund use, and removing or revoking a revision leaves a tombstone rather than making it reusable. Embedded ledger schema v3 still supports its existing v1/v2 migration and compensation records; external journal schema and daemon generation are a separate, forward-only boundary.

The dispatch intent is durable before sending HTTP. Neither backend retries a dispatched request. In external mode, a recovered `prepared` row is terminal `failed`; a recovered `dispatched` row, lost acknowledgement, network failure, process/socket loss or uncertain post-send cancellation is `unknown`. Reusing the original key can only return its durable historical outcome; changing its payload conflicts. New keys aimed at a repository/branch/expected head with an unresolved dispatched/unknown mutation are blocked across grant revisions. An API marker is correlation only, not server-side idempotency. Do not delete either journal or relabel keys to reset authorization evidence.

An independent operator can durably revoke an embedded grant while the Host is running:

```sh
dsh-actions revoke /absolute/private/assistant-actions repo-fix 1
```

External revocation uses the signed `dsh-actions-broker revoke` control request shown above; the external CLI never opens the daemon journal. Both paths stop local forwarding after revocation, expiry, owner loss, emergency stop or disposal, but cannot retract a request GitHub already accepted. Any uncertain in-flight outcome stays unknown.

### Explicit compensating commits (embedded compatibility only)

Rollback is opt-in per grant through `rollback: { allowRollback: true, budgetId, maxActions, maxTotalBytes }`. It is a separate authority and finite budget, not an implication of ordinary commit permission. When a compensation is requested, the trusted Host reads every grant-scoped path at the immutable parent commit named by the forward receipt's `expectedHeadOid` — never earlier, and never from caller-supplied data. Only an exact UTF-8 file response or an exact 404 corroborated by that same immutable commit is accepted: the Host first reads the commit (`git/commits/{oid}`) and its recursive tree (`git/trees/{tree_sha}`), then requires every contents result or 404 to agree with the tree's blob index. Redirects, malformed or truncated content, non-UTF-8 bytes, a missing/truncated/mismatched tree index, a 404 contradicted by a tree blob, or a blob OID disagreement fails the capture closed and sends no compensation commit. This keeps a fine-grained token lacking Contents read, or a blob larger than the Contents API serves, from turning a live file into a deletion. Responses above the bounded file/count/aggregate limits also fail closed. The full present/absent preimage and its digest remain in the private ledger and are never accepted from, or returned to, the model. A successful rollback-enabled commit adds only a redacted `forwardReceipt` containing `forwardActionId`, `forwardActionVersion`, `forwardRequestDigest` and `forwardCommitOid`.

The owner may request one compensation for that exact succeeded forward receipt. The request supplies `grantId`, a new `idempotencyKey` and those four receipt values; it supplies no file contents, paths or preimage. The broker binds the current owner/session, grant revision, repository, branch, exact forward action/version/request digest/commit OID, captured path set, current rollback authority and its dedicated action/byte budget. A legacy commit, failed or unknown forward outcome, mismatched receipt, changed/revoked grant, exhausted rollback budget or missing private preimage is rejected. One forward action has at most one compensation record, so changing the compensation key cannot create a second attempt.

Compensation first confirms that the grant branch still points exactly at the forward commit. It then uses the same fixed GitHub `createCommitOnBranch` mutation with `expectedHeadOid` equal to that forward commit: paths that previously existed are restored and paths created by the forward commit are deleted. This is an ordinary append-only commit with one parent. The broker never force-pushes, resets, rewrites history or calls `updateRef`; a later branch head is a hard conflict rather than authority to erase intervening work. The durable intent becomes `dispatched` before the single GraphQL send. A timeout, cancellation, redirect, malformed/mismatched acknowledgement or lost response is `unknown` and is never replayed, including after restart. Reusing the same request only reads its durable result.

This file restoration is intentionally narrow. It does not delete or close a pull request, cancel or erase CI runs, retract reviews/comments/messages/notifications, undo workflow or webhook side effects, reverse deployments/releases, or remove the forward and compensation commits from history. It also does not promise semantic reversal when external systems acted on the forward commit. Those effects require their own explicit authority and protocols; none are inferred from `allowRollback`.

## Authority and evidence limits

- Filesystem: embedded mode keeps the existing Host-owned `0700` state directory and `0600` ledger/WAL/SHM. External mode requires private Host key files plus a broker-owned private state/credential boundary and separately controlled action/admin Unix-socket paths. The action endpoint may grant an independent Host UID access through a deployment-managed group or ACL; the admin endpoint remains private. The daemon validates each configured parent and socket independently before use. No state/credential file is mounted into the offline worker. Lifecycle audits and consumed grants persist; hard state-root disk quotas/archival remain operator concerns.
- Network: fixed `https://api.github.com/graphql` and grant-scoped `https://api.github.com/repos/...` through Node HTTPS and system certificate validation. No redirect following, retry, proxy environment use, worker networking or user-supplied host/query. Requests and responses are bounded; the token enters only the Authorization header.
- Subprocess: the Cordis Host facade never launches `dsh-actions-broker`; an operator/service manager owns that process. The daemon itself launches no worker subprocess. Embedded Keychain OS providers may launch their fixed documented commands; Isolation owns its separate Docker supervisor.
- Credentials: embedded mode passes a short-lived value only to the trusted Host callback. External mode reads the selected credential inside the daemon and forbids credential-shaped fields on its canonical wire; the Host receives only signed, redacted results. JavaScript strings cannot guarantee memory erasure. A same-UID deployment is process separation, not protection from a malicious same-UID Host; an independent service identity and state ownership remain deployment requirements for that stronger claim.
- Data classification: `source.classification` and `provenanceDigest` are operator-issued grant fields that the Host signs and the broker matches exactly; they are not an independent classifier or proof that content is safe. The broker rejects every configured credential's exact value plus a finite set of common credential-shaped literals, but encoded, split, or unknown secrets can evade this defense. Treat it as defense in depth, not general semantic DLP.
- Browser: none. Install scripts: standard build/prepack only. Installing the package does not start or manage the daemon, create an independent UID or systemd unit, generate or manage keys/credentials, provision infrastructure, or grant a repository action.

Tests exercise real SQLite, native ToolRuntime/Policy, the embedded Keychain path, signed Unix framing, local HTTP sockets, lost acknowledgments, revocation/stop, exact-object preauthorization and no-repeat recovery. A root integration test starts the built production CLI in a real child process for `serve`/`status`/`stop` and a pre-dispatch rejection; a second child imports the built core/server with a controlled transport, is killed after durable dispatch, and proves restart returns `unknown` without a second transport call. These local, same-UID fixtures do not prove a live GitHub account/token deployment, the production GitHub transport after a process crash, independent-UID hardening or remote atomicity. Isolation's actual Docker suite independently covers the offline worker boundary. Full real-model repository maintenance, live-GitHub compensated rollback, PR follow-up, service-manager lifecycle and user-friendly key/bootstrap provisioning remain unfinished.

The default export is the Cordis plugin object carrying its stable name, Config, apply and inject metadata. Programmatic construction uses the named `AssistantActionsService` export. This preserves the exact caller identity required by Policy when the DSH Loader unwraps the module default.

## Deliver independently accepted artifacts

Both backends can add `verifiedDelivery: { ownerRouteId: <existing-owner-route>, budgetId: <finite-automation-runs-budget> }` to a grant to require accepted-artifact delivery. External mode requires this metadata on the broker-issued grant and its matching Host projection; the credential and authoritative action journal remain in the broker. Use matching checkout versions of Goals, Verifier, Isolation and Automations. Enable the existing Automations scheduler and configure the route and budget; a goal admission with `wake` already provisions these prerequisites. The destination branch must already exist. This mode rejects the grant's direct commit, branch and PR mutation tools; bounded repository inspection remains available.

`action_github_grants` discovers only the current owner's permitted repository, branch, paths, expiry and delivery mode. It returns no credential handle or secret. During an admitted native artifact Goal round, `action_github_deliver` accepts `grantId`, `idempotencyKey`, `expectedHeadOid`, `headline`, `paths` and optional `pullRequest: {title,body}`. It stores a delivery intent and returns `awaiting-verification`; it does not accept file contents or imply that a commit exists. Export those exact paths through Isolation. By default, each path must have passed isolated-process criteria in both the source step and whole-goal receipt. An explicit grant field `verifiedDelivery.acceptance: goal-step` authorizes intermediate delivery after the exact source run has ended successfully and quiescently and its independent step receipt accepts every exported path. The original Goal may remain active or paused for further work; this mode does not prove its overall outcome or require that every intermediate delivery waits for an event. Omitted acceptance (or `goal-outcome`) preserves the original final-outcome requirement. Changing the mode requires a new grant revision, and each persisted intent keeps its original mode.

After source-run completion/quiescence and the configured independent acceptance, the Host reads the exact accepted artifact bytes, verifies their digests against the required receipt(s), and schedules a one-shot Automations Host task. Embedded mode reuses the existing ActionLedger and Keychain lease; external mode sends a signed request to the broker. Both commit, then optionally create the fixed branch-to-base PR using the returned commit OID. The former Agent need not remain alive. Owner lineage, route binding version/generation, goal definition/run, current grant revision, expiry, Policy and artifact evidence are rechecked before and during credential forwarding. A commit can succeed while PR creation fails; the persisted result preserves both outcomes and requires attention rather than silently claiming full delivery.

Policy must allow the new native tools, the exact `action:github:<grantId>` resource for the owner Agent **and** background subject `dsh-enhanced-assistant-actions`, and, in embedded mode, the existing credential lease. For scheduling, allow `reconcile` and `execute` for the configured principal/workspace on automation IDs `verified-delivery-*`, with the finite `automation-runs` budget. The Host executor identity is `assistant-actions-verified-delivery/v1`. Result notifications additionally require that background subject to `send` to the original binding's exact `message` resource in the same principal/workspace. These grants are explicit; the plugin does not add Policy rules or credentials itself.

`action_github_delivery_status(grantId,idempotencyKey)` reads the original Session's persisted delivery status and commit/PR result only while its captured owner identity still matches. After a terminal commit/PR outcome is durably recorded, the Host queues one owner-route-bound `enqueueOwnerNotification` result with a stable key. The notice reports `succeeded`, `failed`, or `unknown` and the actual commit/PR result; queued means accepted by Delivery, never that the owner read it. The original route, identity, grant expiry and Policy are rechecked before enqueue, so a rebound owner receives no historical delivery result. A failed enqueue leaves the Action terminal result unchanged and is retried after restart; an accepted enqueue is not repeated. The private `verified-delivery.sqlite` stores metadata, the request, terminal results and notification queue state, never artifact contents or credentials. Pending and scheduled intents reconcile after the required services are available at startup, Goal changes, and durable Verifier receipt nudges; interrupted executing intents become `unknown` and never redispatch. Receipt expiry or artifact pruning prevents later delivery. Receipt nudges carry no authority or artifact bytes: the Host rereads current evidence. Temporarily unavailable step evidence stays pending; restart compensates for lost nudges. Evaluation retains its independent durable receipt consumer. The ledger has a 10,000-intent ceiling; no automatic compensation or unknown settlement is claimed.


## Fresh repository outcome verification

Verifier's optional `repository-readback` authority calls the Host-only backend for the latest exact Goal's step-verified delivery. Embedded mode requires succeeded commit/PR ledger records. External mode verifies the persisted broker signatures and reconstructs their payload digests from the currently accepted artifacts; the Host stores no artifact bytes or credential. Both require the original owner route and grant revision, the independently accepted source step, and the assessment's succeeded/quiescent native execution. A later assessment may verify an earlier source round; a newer pending or unknown delivery prevents fallback to an older success.

The selected backend reads checks, reviews, PR and branch afresh through the existing Policy, credential leases and action ledger. External mode also rejects observations spanning a broker generation or policy/emergency epoch change; signed historical receipts alone cannot prove the current repository outcome. Each read consumes one action, with source and authorization checks across asynchronous waits. Required check names and app identities, configured reviewers, repository/base/branch and actual delivered head must match. Truncated, mismatched or unavailable data cannot pass. This interface is not a model tool, creates no events and does not complete a Goal itself. Tests use a GitHub transport fixture; real remote verification is separate.
