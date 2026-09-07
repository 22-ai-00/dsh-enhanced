# @dsh-enhanced/assistant-actions

Experimental trusted Host broker for finite, owner-authorized GitHub commits. It submits explicit file contents to one configured repository/branch, using a short Keychain lease. The model and isolated worker never receive the credential. Default `grants: []` performs no external action. This bundle is not enabled by existing installation scenarios.

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
```

The Keychain handle must allow consumer `dsh-enhanced-assistant-actions`, purpose `github.commit`, and leases up to 30 seconds. Reuse the Keychain provider appropriate for your environment; do not place tokens in this YAML. Policy must separately allow the exact agent/owner `execute` resource `{ kind: tool, id: "action:github:repo-fix" }`, native tool execution of `action_github_commit`, and background `credential.use` for the chosen handle. Any Policy deny or emergency stop remains authoritative. Explicit capability grants skip only Policy's generic risk prompt for this exact broker definition; they do not disable other approval providers or arbitrary tool checks. Policy budget evaluation during polling is read-only; one authorization with a stable action key is charged before credential retrieval and dispatch. Failed credential acquisition does not refund that budget.

Configured workspace/preset scopes permit only `isolation_run`, goal context/checkpoint, and the exact currently preauthorized broker. Ordinary Host shell, generic code dispatch, filesystem tools and nested tool routes are denied there, including after grant expiry/revocation. Removing this bundle removes its guard; operators must retain Isolation routing while workers/scopes remain managed. Trusted Host plugins share Host authority and must be audited; the named consumer check is not OS isolation against a malicious Host plugin.

## Commit and recovery semantics

`action_github_commit` accepts `grantId`, `idempotencyKey`, `expectedHeadOid` (40 lowercase hex characters), `headline`, and `files: [{path, content}]`. Only configured exact paths may be added/updated, at most 32 files and 1 MiB per request including headline/path bytes. The broker supports no deletion, arbitrary endpoint, raw GraphQL, branch creation, PR creation, merge, release, or force push. Those require separate supported actions and authorization.

The fixed GitHub [createCommitOnBranch mutation](https://docs.github.com/en/graphql/reference/commits#createcommitonbranch) binds the expected current head and appends the requested changes to that branch. Its success response is checked against the action marker, repository, branch, parent and resulting ref. A commit receipt is not independent validation of code quality or user-goal completion. The credential owner authors the commit; repository protections and token permissions still apply. Creating a commit can trigger workflows configured for that branch, so the operator's repository/branch/path grant also authorizes those normal repository consequences.

The private SQLite WAL/FULL ledger reserves cumulative actions and bytes before credential retrieval. The short action deadline is at most 30 seconds and never exceeds grant expiry. Two prepared/dispatched/unknown operations may occupy the broker, with a permanent 10,000-record ceiling. Grant revision changes do not refund use; revoking/removing a grant cannot be undone by reloading the same revision. The ledger stores request digests and result metadata, not submitted bodies or credentials.

The dispatch intent is durable before sending HTTP. The broker never retries a dispatched request. Network failures, redirects, GraphQL errors, oversized/mismatched replies, expiry and uncertain cancellation retain `unknown`; restarting does not resend. Reusing the original key reads its historical outcome; changing its request conflicts. New keys aimed at a repository/branch/expected head with an unresolved dispatched/unknown action are blocked across grant revisions. `clientMutationId` is a correlation marker, not a claim of server-side idempotency. Unknown occupancy remains until a future trusted readback/settlement protocol is implemented; do not delete the ledger or relabel keys to reset authorization evidence.

An independent operator can durably revoke while the Host is running:

```sh
dsh-actions revoke /absolute/private/assistant-actions repo-fix 1
```

The Host polls current authorization during an operation and aborts the HTTP request after revocation, expiry, owner loss, emergency stop or disposal. This stops local forwarding; it cannot retract a request GitHub has already accepted. In-flight outcomes require remote readback, and commits may require an explicitly authorized compensating commit. Automatic rollback/reconciliation is not implemented.

## Authority and evidence limits

- Filesystem: Host owns the `0700` state directory and `0600` ledger/WAL/SHM. Keychain reads only its configured provider. No state/credential file is mounted into the offline worker. Lifecycle audits and consumed grant records persist; hard state-root disk quotas/archival remain operator concerns.
- Network: fixed `https://api.github.com/graphql` through Node HTTPS and system certificate validation. No redirect following, retry, proxy environment use, worker networking or user-supplied host/query. Requests and responses are bounded; the token enters only the Authorization header.
- Subprocess: this broker launches none. Keychain OS providers may launch their fixed documented commands; Isolation owns its separate Docker supervisor.
- Credentials: only the trusted Host callback receives the short-lived value. Fixed result/error fields suppress raw response/token echoes. JavaScript strings cannot guarantee memory erasure; Host/root and compromised trusted plugins are outside the worker boundary.
- Browser: none. Install scripts: standard build/prepack only; no token acquisition, image pull, infrastructure provisioning or profile activation.

Tests exercise real SQLite, native ToolRuntime/Policy, Keychain, HTTP sockets, lost acknowledgments, revocation, exact-object preauthorization, and no-repeat recovery. Local HTTP servers model GitHub's protocol; they do not prove a live GitHub account/token deployment or atomic server behavior. Isolation's actual Docker suite independently covers the offline worker boundary. Full real-model repository maintenance, PR follow-up, compensated rollback and user-friendly bootstrap remain unfinished.

The default export is the Cordis plugin object carrying its stable name, Config, apply and inject metadata. Programmatic construction uses the named `AssistantActionsService` export. This preserves the exact caller identity required by Policy when the DSH Loader unwraps the module default.
