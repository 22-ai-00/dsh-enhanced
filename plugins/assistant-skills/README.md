# Assistant Skills

Save a successfully verified Goal's tool workflow and reuse it in a new Goal. The optional bundle publishes private, versioned skills through the native DSH skill catalog and executes fixed steps through the current Agent's native ToolRuntime.

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-skills
```

Install the Goals, Delivery and Policy bundles and native Skills/Tools services in the same Host. Goals must have native execution and independent whole-goal verification configured. This bundle never enables those services or creates acceptance profiles automatically.

Configuration:

```yaml
- id: dsh-enhanced-assistant-skills
  config:
    databasePath: /private/state/assistant-skills.sqlite
    allowedTools: [read, write, edit]
    maxDurationMs: 60000
    candidateTtlMs: 86400000
```

Policy must explicitly authorize the desired `inspect`, `save`, `run`, `retire` actions on `{ kind: evolution, id: verified-workflows }` for the exact owner, workspace and preset. Save/run/retire consume configured Policy authorization budgets with stable idempotency keys; catalog reads only preview current authorization. Native tool execution still requires its own current authorization and approval. Saving and retiring also require the current authenticated human request.

After a Goal completes with a current independently achieved outcome, ask the assistant to save it. `skill_save` takes `goal_id`, a kebab-case `name`, `description`, `expected_version` (0 for the first version), and optional `bindings_json`. Each binding is `{ "name": "output_path", "stepId": "<source tool call ID>", "path": "/file_path" }`. The path selects an actual scalar argument and derives its type/default; it does not evaluate code. The saved trace contains at most 32 successful calls and 256 KiB of arguments. Failed, unfinished, recursive skill, goal-control and dynamic orchestration traces are rejected. Catalog descriptions and saved inputs remain task data, not instructions granting authority.

Load the saved skill using the native `skill` tool. Create a new Goal with independently configured acceptance, then call `skill_run` in its admitted native round with `goal_id`, `name`, `version`, `inputs_json`, and a stable `invocation_id`. Missing declared inputs retain their saved defaults. Extra inputs or type mismatches are rejected. Steps execute in recorded order with current owner/Goal/Policy checks before and after each dispatch. This is a tool composition in the existing native Goal, not another agent loop or scheduler.

`skill_status` lists active versions, their typed inputs and exact source acceptance, or reads a `run_id`. An invocation's `succeeded` state only means its tool steps succeeded: the new Goal still needs its own independent acceptance. Version updates use CAS and retain the prior version as provenance. Only the latest active version can run; retiring it does not reactivate an older version. Candidate trials and owner-requested activation/rollback are described below. Automatic promotion remains unimplemented; finite owner-authorized rollback watches are described below.

Only one invocation may be running for a given owner/session/Goal, including concurrent native ToolRuntime callers. A budget denial preserves a failed invocation audit and dispatches no business tool. Repeated invocation IDs never repeat effects, including after Host restart. A different goal, version or input under the same invocation ID is rejected. Interrupted runs recover as `unknown`, with completed step receipts retained; they need explicit inspection and repair. Failure stops remaining steps and returns an actual failed native tool result after preserving the invocation record. No arbitrary effects are automatically reversed: compensation is stop-and-report, not a claim that writes or external actions can be undone.

## Finite rollback watches

An owner may explicitly create `skill_watch` for one current version and its immediate-parent fallback. It requires the current authenticated owner request, Policy `watch` permission, a configured `owner_route_id`, an absolute `expires_at`, `max_runs`, and `failure_threshold`. The lifetime is at most seven days, `max_runs` is 1–100, and `failure_threshold` is 1–`max_runs`. Policy must also explicitly allow background `watch` and `rollback` on `{ kind: evolution, id: verified-workflows }` for subject `{ kind: background, id: dsh-enhanced-assistant-skills, workspace, principal }`, with background initiator. The route is revalidated before every durable evidence read and immediately before rollback. A revoked or changed route, expiry, retirement, or any version/digest change stops the watch; it does not follow a newer version.

The watch records a durable run watermark at creation and observes only later `skill_run` calls that actually succeed and whose native Goal execution-run binding was durably recorded. A Verifier receipt is merely a nudge: the service rereads Goals' owner-scoped snapshot, matches the exact execution run and immutable Goal definition, then accepts only a fresh, unexpired independent whole-goal `achieved` or `not-achieved` receipt. Each invocation and receipt digest is counted once, up to the first `max_runs` attached runs; it stops as exhausted when all of those runs have qualifying outcomes without reaching the failure threshold. Repeated receipts, old receipts, wrong Goals/runs, old skill versions and unknown evidence do not count. Reconciliation also runs after restart; it creates no scheduler or polling loop.

When the configured number of distinct fresh `not-achieved` outcomes is reached, the service appends the already authorized immediate-parent fallback exactly once. It does not say the skill caused those Goal failures, and it does not promote candidates, infer a gain, change the manual candidate activation rule, or relax comparison/holdout gates. `skill_watches` exposes the durable watch state and observations.

## Candidate trials, activation and rollback

To review a potential replacement while keeping the current skill active:

1. After an independently achieved source Goal, call `skill_candidate` with `goal_id`, `name`, `description`, `bindings_json`, the current `parent_version` (or 0 for a new name), `reason` and `trigger`. The current human owner request is required. `skill_candidates` reads the pending definition and Host-derived structural difference: added/removed tools, changed step digests and input changes. These differences do not measure quality or infer an expanded permission grant.
2. In a fresh admitted Goal with its own acceptance profile, call `skill_trial` with `candidate_id`, `goal_id`, `inputs_json` and a stable `invocation_id`. Trial steps use the ordinary native tools and may have real effects. They retain the same duration limit, owner/Goal checks, current tool approval and budget handling as `skill_run`. Pending candidates are absent from the native catalog.
3. After that exact trial independently achieves its Goal, the owner can request `skill_activate` with `candidate_id` and `trial_run_id`. The accepted source turn must contain exactly that one successful `skill_trial`, with matching candidate, Goal, invocation and inputs. A later repair call or unrelated accepted run cannot authorize activation. Reading an older accepted Goal is allowed only in its original owner Session with an unexpired receipt. The current parent must still match.
4. `skill_rollback` takes `name`, `expected_version` and `target_version`, where the target is the current version's immediate parent. It copies the parent into a new immutable version: activating v2 over v1 and rolling back produces v3 with `restoredFromVersion: 1`. Old versions and runs remain recorded. Repeating the same rollback does not append another version. `skill_reject` discards a pending candidate without changing the active skill.

Policy must separately allow `draft`, `trial`, `activate`, `reject` and `rollback` on the same evolution resource. All mutations use stable Policy authorization keys; draft, activate, reject and rollback require the current authenticated human request. Revoked authority, changed parents, failed/unknown trials and expired candidates prevent activation. Candidate lifetime defaults to 24 hours, configurable from one second to seven days; repeating a draft never extends its original expiry. A previously successful activation can be read back idempotently without reactivating it over a later version.

This delivers owner-reviewed version changes after a verified trial. It does not claim automatic improvement: sealed held-out evaluation and automated candidate generation/promotion remain separate requirements. Finite rollback watches do not establish causal improvement. Trial success is specific to its tested inputs and acceptance profile.

## Actual parent/candidate comparisons

`skill_compare(candidate_id, profile_id, invocation_id)` executes the parent and pending candidate on the same operator-configured inputs and limits. Each arm uses native read/write/edit tools in a private temporary workspace and a separate isolated artifact runner; the Host compares actual behavior against its expected output. Results persist and can be read with `skill_comparison_status` after restart. Failed/unknown attempts are not automatically repeated, and current owner/Policy/parent/expiry are checked during execution.

This optional capability needs the Evaluation and Isolation packages plus an explicit finite comparison profile and Policy `compare` permission. See [comparison configuration and limits](../../docs/skill-comparison-profiles.md). Reports separate evaluation gains from critical regressions; a complete run with zero gain is not an improvement. They never grant promotion permission and do not claim a sealed holdout. The candidate stays pending until a separately authorized lifecycle action changes it.

## Authority and privacy

- Filesystem: creates a private SQLite database (0600), WAL/SHM and new parent directory (0700). The store contains owner-scoped historical tool arguments, input defaults, acceptance references and invocation receipts. These may contain private task content; do not put the database in a shared or public directory. Symlink/nonregular database files are rejected.
- Comparison authority: finite operator-configured offline Docker verification, private benchmark journals and temporary file workspaces; native read/write/edit only. The calling Agent receives no general verifier runner handle or expected-answer payload.
- Filesystem/network/subprocess effects during reuse: only through saved, Host-allowlisted native tools with their current approvals, Policy, cancellation and Goal budget. No direct shell, filesystem writer, network client or subprocess runner is supplied by this bundle.
- Credential/browser authority: none added. It neither reads credential stores nor drives a browser. Native tools retain their own requirements.
- Install scripts: no runtime install/postinstall scripts. Build/prepack scripts compile the independently publishable bundle.
- Historical acceptance is checked at capture. It is provenance for the saved workflow, not future task acceptance or a permanent grant. Owner lineage/workspace/preset changes isolate saved data and stop subsequent dispatches.

Validation uses package tests for native tool dispatch, typed inputs, owner isolation, current permission checks, retirement, persistence and no replay, plus `pnpm test:web-owner:real-skill` (reuse) and `DSH_WEB_REAL_SKILL_CANDIDATE=1 pnpm test:web-owner:real-skill` (candidate lifecycle) for the explicitly configured real-route Web scenario. See repository evidence for runs actually completed.
