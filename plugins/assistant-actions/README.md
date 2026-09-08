# @dsh-enhanced/assistant-actions

Experimental trusted Host broker for finite, owner-authorized GitHub commits and repository workflow actions. It submits explicit file contents to one configured repository/branch, using a short Keychain lease. The model and isolated worker never receive the credential. Default `grants: []` registers no GitHub tools and performs no external action. The autonomy installation includes the bundle without repository authority; configure an explicit grant and Keychain handle to use it.

## Installation and compatibility

Install this bundle with matching checkout/release versions of `assistant-policy`, `assistant-delivery`, `credentials-keychain`, and `assistant-isolation` when shell execution is needed. The entrypoint waits for Policy, Delivery and Keychain; tool registration additionally needs native Agents and Tools. It requires DSH `0.1.2-rc.1`, Cordis `^4.0.1`, Node `^22.19.0 || >=24`, Linux private-file ownership semantics, and the Policy preauthorization/evaluateAgent methods introduced with this broker. Old Policy versions cannot activate this capability. Optional peer metadata prevents npm from treating Host services as embedded libraries; it does not make runtime authentication optional.

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-actions
dsh --profile web --dump-config
```

Use a current owner record and an existing non-production branch for first deployment. Configuration grants contain no token:

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
    repoWorkflow: # omitted means branch/PR writes are unavailable
      baseBranch: main
      allowBranchCreate: true
      allowPullRequest: true
```

The Keychain handle must allow consumer `dsh-enhanced-assistant-actions`, purpose `github.commit`, and leases up to 30 seconds. Reuse the Keychain provider appropriate for your environment; do not place tokens in this YAML. Policy must separately allow the exact agent/owner `execute` resource `{ kind: tool, id: "action:github:repo-fix" }`, native tool execution of `action_github_commit`, and background `credential.use` for the chosen handle. Any Policy deny or emergency stop remains authoritative. Explicit capability grants skip only Policy's generic risk prompt for this exact broker definition; they do not disable other approval providers or arbitrary tool checks. Policy budget evaluation during polling is read-only; one authorization with a stable action key is charged before credential retrieval and dispatch. Failed credential acquisition does not refund that budget.

Configured workspace/preset scopes permit only `isolation_run`, read-only `isolation_grants`, goal context/checkpoint, and the exact currently preauthorized broker. Ordinary Host shell, generic code dispatch, filesystem tools and nested tool routes are denied there, including after grant expiry/revocation. Removing this bundle removes its guard; operators must retain Isolation routing while workers/scopes remain managed. Trusted Host plugins share Host authority and must be audited; the named consumer check is not OS isolation against a malicious Host plugin.

## Commit and recovery semantics

`action_github_commit` accepts `grantId`, `idempotencyKey`, `expectedHeadOid` (40 lowercase hex characters), `headline`, and `files: [{path, content}]`. Only configured exact paths may be added/updated, at most 32 files and 1 MiB per request including headline/path bytes. If `repoWorkflow` is explicitly present, `action_github_branch(grantId,idempotencyKey,baseHeadOid)` can create only the grant branch from only its configured base, and `action_github_pr(grantId,idempotencyKey,expectedHeadOid,title,body)` can create only that branch-to-base PR. `action_github_inspect` reads one grant-scoped repository, branch, allowed file, PR, checks, or reviews snapshot; snapshots are observed state, never proof that an earlier mutation settled. Checks and reviews return one bounded page (20 checks or 30 reviews), with `truncated` and `untrusted` metadata; an incomplete page cannot establish an overall CI/review verdict. File reads accept only exact-path UTF-8 blobs up to 64 KiB. PR creation validates its receipt against both repositories and head/base refs; GitHub provides no atomic expected-head CAS for that endpoint. Every inspect call consumes a durable `maxActions` reservation, including across restarts. No merge, deletion, release, force push, arbitrary endpoint, issue mutation, review mutation, or raw API access is supported.

The fixed GitHub [createCommitOnBranch mutation](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch) binds the expected current head and appends the requested changes to that branch. Its success response is checked against the action marker, repository, branch, parent and resulting ref. A commit receipt is not independent validation of code quality or user-goal completion. The credential owner authors the commit; repository protections and token permissions still apply. Creating a commit can trigger workflows configured for that branch, so the operator's repository/branch/path grant also authorizes those normal repository consequences.

The private SQLite WAL/FULL ledger reserves cumulative actions and bytes before credential retrieval. The short action deadline is at most 30 seconds and never exceeds grant expiry. Two prepared/dispatched operations may occupy the broker. Unknown mutations retain write occupancy, while bounded reads remain available for investigation; unknown reads do not permanently exhaust concurrency. The permanent ledger ceiling is 10,000 records. Grant revision changes do not refund use; revoking/removing a grant cannot be undone by reloading the same revision. Ledger schema v2 explicitly records commit/branch/PR/inspect kinds and migrates existing v1 rows as commits without replay. The ledger stores request digests and result metadata, not submitted bodies or credentials.

The dispatch intent is durable before sending HTTP. The broker never retries a dispatched request. Network failures, redirects, API errors, oversized/mismatched replies, expiry and uncertain cancellation retain `unknown`; restarting does not resend. Reusing the original key reads its historical outcome; changing its request conflicts. New keys aimed at a repository/branch/expected head with an unresolved dispatched/unknown action are blocked across grant revisions. An API marker is a correlation marker, not a claim of server-side idempotency. A public branch, PR, or commit marker cannot prove that a late request was stopped; remote readback stays observed state unless a specific settlement proof is implemented. Unknown occupancy remains until a future trusted settlement protocol is implemented; do not delete the ledger or relabel keys to reset authorization evidence.

An independent operator can durably revoke while the Host is running:

```sh
dsh-actions revoke /absolute/private/assistant-actions repo-fix 1
```

The Host polls current authorization during an operation and aborts the HTTP request after revocation, expiry, owner loss, emergency stop or disposal. This stops local forwarding; it cannot retract a request GitHub has already accepted. In-flight outcomes require remote readback, and commits may require an explicitly authorized compensating commit. Automatic rollback/reconciliation is not implemented.

## Authority and evidence limits

- Filesystem: Host owns the `0700` state directory and `0600` ledger/WAL/SHM. Keychain reads only its configured provider. No state/credential file is mounted into the offline worker. Lifecycle audits and consumed grant records persist; hard state-root disk quotas/archival remain operator concerns.
- Network: fixed `https://api.github.com/graphql` and grant-scoped `https://api.github.com/repos/...` through Node HTTPS and system certificate validation. No redirect following, retry, proxy environment use, worker networking or user-supplied host/query. Requests and responses are bounded; the token enters only the Authorization header.
- Subprocess: this broker launches none. Keychain OS providers may launch their fixed documented commands; Isolation owns its separate Docker supervisor.
- Credentials: only the trusted Host callback receives the short-lived value. Fixed result/error fields suppress raw response/token echoes. JavaScript strings cannot guarantee memory erasure; Host/root and compromised trusted plugins are outside the worker boundary.
- Browser: none. Install scripts: standard build/prepack only; no token acquisition, image pull, infrastructure provisioning or profile activation.

Tests exercise real SQLite, native ToolRuntime/Policy, Keychain, HTTP sockets, lost acknowledgments, revocation, exact-object preauthorization, and no-repeat recovery. Local HTTP servers model GitHub's protocol; they do not prove a live GitHub account/token deployment or atomic server behavior. Isolation's actual Docker suite independently covers the offline worker boundary. Full real-model repository maintenance, PR follow-up, compensated rollback and user-friendly bootstrap remain unfinished.

The default export is the Cordis plugin object carrying its stable name, Config, apply and inject metadata. Programmatic construction uses the named `AssistantActionsService` export. This preserves the exact caller identity required by Policy when the DSH Loader unwraps the module default.

## Deliver independently accepted artifacts

Add `verifiedDelivery: { ownerRouteId: <existing-owner-route>, budgetId: <finite-automation-runs-budget> }` to a grant to require accepted-artifact delivery. Use matching checkout versions of Goals, Verifier, Isolation and Automations. Enable the existing Automations scheduler and configure the route and budget; a goal admission with `wake` already provisions these prerequisites. The destination branch must already exist. This mode rejects the grant's direct commit, branch and PR mutation tools; bounded repository inspection remains available.

`action_github_grants` discovers only the current owner's permitted repository, branch, paths, expiry and delivery mode. It returns no credential handle or secret. During an admitted native artifact Goal round, `action_github_deliver` accepts `grantId`, `idempotencyKey`, `expectedHeadOid`, `headline`, `paths` and optional `pullRequest: {title,body}`. It stores a delivery intent and returns `awaiting-verification`; it does not accept file contents or imply that a commit exists. Export those exact paths through Isolation. By default, each path must have passed isolated-process criteria in both the source step and whole-goal receipt. An explicit grant field `verifiedDelivery.acceptance: goal-step` authorizes intermediate delivery after the exact source run has ended successfully and quiescently and its independent step receipt accepts every exported path. The original Goal may remain active or paused for further work; this mode does not prove its overall outcome or require that every intermediate delivery waits for an event. Omitted acceptance (or `goal-outcome`) preserves the original final-outcome requirement. Changing the mode requires a new grant revision, and each persisted intent keeps its original mode.

After source-run completion/quiescence and the configured independent acceptance, the Host reads the exact accepted artifact bytes, verifies their digests against the required receipt(s), and schedules a one-shot Automations Host task. It reuses the existing ActionLedger and Keychain lease to commit, then optionally creates the fixed branch-to-base PR using the returned commit OID. The former Agent need not remain alive. Owner lineage, route binding version/generation, goal definition/run, current grant revision, expiry, Policy and artifact evidence are rechecked before and during credential forwarding. A commit can succeed while PR creation fails; the persisted result preserves both outcomes and requires attention rather than silently claiming full delivery.

Policy must allow the new native tools, the exact `action:github:<grantId>` resource for the owner Agent **and** background subject `dsh-enhanced-assistant-actions`, and the existing credential lease. For scheduling, allow `reconcile` and `execute` for the configured principal/workspace on automation IDs `verified-delivery-*`, with the finite `automation-runs` budget. The Host executor identity is `assistant-actions-verified-delivery/v1`. Result notifications additionally require that background subject to `send` to the original binding's exact `message` resource in the same principal/workspace. These grants are explicit; the plugin does not add Policy rules or credentials itself.

`action_github_delivery_status(grantId,idempotencyKey)` reads the original Session's persisted delivery status and commit/PR result only while its captured owner identity still matches. After a terminal commit/PR outcome is durably recorded, the Host queues one owner-route-bound `enqueueOwnerNotification` result with a stable key. The notice reports `succeeded`, `failed`, or `unknown` and the actual commit/PR result; queued means accepted by Delivery, never that the owner read it. The original route, identity, grant expiry and Policy are rechecked before enqueue, so a rebound owner receives no historical delivery result. A failed enqueue leaves the Action terminal result unchanged and is retried after restart; an accepted enqueue is not repeated. The private `verified-delivery.sqlite` stores metadata, the request, terminal results and notification queue state, never artifact contents or credentials. Pending and scheduled intents reconcile after the required services are available at startup, Goal changes, and durable Verifier receipt nudges; interrupted executing intents become `unknown` and never redispatch. Receipt expiry or artifact pruning prevents later delivery. Receipt nudges carry no authority or artifact bytes: the Host rereads current evidence. Temporarily unavailable step evidence stays pending; restart compensates for lost nudges. Evaluation retains its independent durable receipt consumer. The ledger has a 10,000-intent ceiling; no automatic compensation or unknown settlement is claimed.
