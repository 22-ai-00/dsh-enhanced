# Assistant Skills

Save a successfully verified Goal's tool workflow and reuse it in a new Goal. The optional bundle publishes private, versioned skills through the native DSH skill catalog and executes fixed steps through the current Agent's native ToolRuntime.

```sh
dsh plugin --profile web add @dsh-enhanced/assistant-skills
```

Install the Goals, Delivery and Policy bundles and native Skills/Tools services in the same Host. Goals must be `@dsh-enhanced/assistant-goals >=0.1.25 <0.2.0` and have native execution and independent whole-goal verification configured; the minimum supplies the Host-only failure-evidence and exact-run-proof APIs used by failure candidates and causal canary watches. This bundle never enables those services or creates acceptance profiles automatically.

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

Load the saved skill using the native `skill` tool. Create a new Goal with independently configured acceptance, then call `skill_run` with `goal_id`, `name`, `version`, `inputs_json`, and a stable `invocation_id`. If the exact current owner Goal is active but lacks an admitted native round, it returns `awaiting-native-round`, performs no step or durable invocation, and ends the owner turn; the Host native driver starts the round and that round repeats the same invocation ID. Missing declared inputs retain their saved defaults. Extra inputs or type mismatches are rejected. Steps execute in recorded order with current owner/Goal/Policy checks before and after each dispatch. This is a tool composition in the existing native Goal, not another agent loop, scheduler, or queued job.

`skill_status` lists active versions, their typed inputs and exact source acceptance, or reads a `run_id`. An invocation's `succeeded` state only means its tool steps succeeded: the new Goal still needs its own independent acceptance. Version updates use CAS and retain the prior version as provenance. Only the latest active version can run; retiring it does not reactivate an older version. Candidate trials and owner-requested activation/rollback are described below. Automatic promotion and rollback are limited to qualified finite canary deployments with an operator-pinned task family; public standalone watches are observation-only.

Only one invocation may be running for a given owner/session/Goal, including concurrent native ToolRuntime callers. A budget denial preserves a failed invocation audit and dispatches no business tool. Repeated invocation IDs never repeat effects, including after Host restart. A different goal, version or input under the same invocation ID is rejected. An `unknown` or running invocation also fences a different invocation ID for that same skill or candidate trial in the same Goal, so unresolved external effects cannot be retried by changing the key; use a distinct new Goal only after explicit repair. Interrupted runs recover as `unknown`, with completed step receipts retained; they need explicit inspection and repair. Failure stops remaining steps and returns an actual failed native tool result after preserving the invocation record. No arbitrary effects are automatically reversed: compensation is stop-and-report, not a claim that writes or external actions can be undone.

Newly captured standard `write`/`edit` workflows always declare `fileObservations`. A declaration grants no read permission: execution refuses it unless the current Host allowlist permits `read`. Each declaration performs a native read of the instantiated target immediately before its mutation, through the same owner, Goal, tool permissions and budget. Only a structured `FS_NOT_FOUND` may satisfy a write's absent-file observation; edit requires a successful read. Denial, cancellation, other read errors and a concurrent file-version change stop execution. These reads have distinct audit/checkpoint entries and count toward the 32-call limit, argument limit and isolated comparison budget. They do not disable the Host filesystem guard. Existing definitions without declarations keep their original semantics and digest; recapture, trial and authorize a new version to adopt the new preconditions. Failed invocations remain non-replayable.

A successful `skill_run` inside an independently accepted source Goal may be captured as fixed, bound steps only after the Host verifies the exact stored invocation, owner/session/Goal/native execution, inputs, active definition version and complete successful checkpoints. The original source call and bounded `runExpansions` proof stay in provenance; reusable steps contain the resolved ordinary tools, not a recursive `skill_run`. Missing, failed, unknown, mismatched or superseded invocations cannot be expanded. The new candidate still needs its own trial or prospective qualification before activation.

Distinct successful invocations of the same skill retain their own bound inputs and ordered steps when captured together. Repeated responses for the same durable invocation are rejected as a capture source; they do not prove a second execution and must not create duplicate replay steps.

Successful, schema-valid `todo_write` planning updates and parameterless `skill_status` catalog reads remain in source provenance and are omitted from reusable action steps. They cannot be parameter binding targets. Failed source probes remain provenance only; they do not grant an absent-file exception.

## Owner-preauthorized capture

During the current authenticated owner turn that creates an active Goal, `skill_capture(owner_route_id, goal_id, name, description, parent_version, expires_at, start_native_rounds?)` can register one finite capture for that exact owner Session and native Goal. `owner_route_id` is an explicitly configured public owner-route identifier. It records the owner-route receipt, immutable Goal definition digest, native Goal identity, and current parent version/digest. The explicit expiry is at most seven days. With the optional `start_native_rounds: true`, a successful registration ends the owner turn and hands the Goal to the Host native driver for execution and later extraction. On registration failure, or when omitted or `false`, the turn stays open so the owner can compose other authorized schedule or wait work. The capture does not create an AgentLoop or execute Goal work. Registration grants no replay, comparison, trial, activation, or broader tool authority.

After a Verifier receipt nudge, startup, or a normal skill reconciliation, the service asks the Goals Host-only `inspectOwnerVerifiedWorkflowSource` bridge to reread the exact source. Only a cold, quiescent, independently `achieved` source with the same route, owner scope, Goal definition, native identity and parent can create one durable pending candidate from its actual successful trace. The normal definition allowlist still rejects unsupported traces. A Host may explicitly allowlist parameterless native `get_goal` as a read-only trace step; `create_goal`, `update_goal`, other `goal_*` controls and recursive skill/workflow tools remain rejected; the exact successful source-Goal `goal_checkpoint` exception below is provenance only and is never replayed. Goals may attach its trusted `failedObservations` of allowed read-only probes as immutable provenance. They are not definition steps and are never replayed. Any unconfirmed call, failed or unknown non-probe call, or failed write still prevents Goals from producing a capture source. The capture and candidate are committed together; replay and restart do not make another candidate. `skill_captures` exposes `pending`, `captured`, `revoked`, `expired`, `unsupported`, or `unknown` durable state.

For an iterative Goal, the owner bridge may provide contiguous native-round `segments`. The final whole-goal receipt accepts the resulting work; earlier segments establish successful, quiescent execution, not individual goal achievement. Skills validates the final segment against the v1 top-level source and builds its execution steps from all segments in order, preserving an initial write followed by a later repair. Failed observations remain provenance only. The 32-call and 256-KiB argument bounds apply to the entire sequence. A missing round, changed definition, or failed/unknown effect prevents automatic extraction; reuse still requires a fresh Goal and new independent acceptance.

A successful `goal_checkpoint` with the exact source Goal ID and strictly validated planning parameters remains in the immutable source trace but is excluded from executable steps. These are historical planning notes, not read-only observations, acceptance or future authority. They cannot receive input bindings, and their IDs and bytes still count toward the full trace bounds. Planning-only traces, failed checkpoints, foreign Goal IDs and other Goal controls remain rejected. Dependencies between executable steps skip these non-replayed notes.

Background capture requires a separate explicit Policy `capture` rule for subject `{ kind: background, id: dsh-enhanced-assistant-skills, workspace, principal }` and the exact evolution resource, plus a stable capture authorization budget key. Route, Policy, parent, and definition are checked before and after the Goals Host read. Revocation, expiry, parent/definition drift, and unsupported traces stop the record. The typed Goals bridge reports `pending` or `unavailable` while a source may still become complete; `unknown` and `rejected` bridge failures are recorded as terminal capture `unknown` and never replayed automatically. Captured candidates remain private and pending until the existing owner-requested trial/activation flow runs.

## Failure-driven candidates

`skill_failure_candidate` accepts either the legacy exact `trigger_goal_id` / `trigger_session_id` pair for one failure, or `failure_locators` plus `minimum_occurrences` for a bounded repeated-failure window. The latter contains only 1–32 `{ session_id, goal_id }` locators; callers cannot submit outcomes, receipts, trace digests, failure categories or provenance. Goals rereads each locator through its current Host-only capability and aggregates only distinct, exact, independently accepted `not-achieved` runs. Every failure and the repair must retain the same owner route, scope, immutable Goal definition and outcome profile, while using independent Goal, Session, native Goal, execution run, contract and receipt identities. The repair must be one exact independently `achieved`, complete Goal accepted later than every failure. A minimum of two produces `repeated-not-achieved`; one retains `objective-not-achieved`. Invalid, expired, changed or mixed evidence fails closed. The public candidate keeps the existing v1 failure metadata fields and adds `count` / `digest` aliases for repeated windows; raw Goal, Session, run, contract, receipt and trace identities remain private.

The repair's successful trace supplies the pending candidate definition; the failures supply its Host-derived trigger and provenance. The model-visible candidate projection exposes only the failure category, count and integrity digest, never the locator list, owner route, Session/native Goal/run identities, receipts or raw proof. Candidate creation still requires current owner, route, Policy, parent and definition checks. It does not activate the candidate, authorize a comparison or prove that the repair is better than its parent.

## Finite outcome watches

An owner may explicitly create `skill_watch` for one current version and its immediate-parent fallback metadata. It requires the current authenticated owner request, Policy `watch` permission, a configured `owner_route_id`, an absolute `expires_at`, `max_runs`, and `failure_threshold`. The lifetime is at most seven days, `max_runs` is 1–100, and `failure_threshold` is 1–`max_runs`. Policy must also explicitly allow background `watch` on `{ kind: evolution, id: verified-workflows }` for subject `{ kind: background, id: dsh-enhanced-assistant-skills, workspace, principal }`, with background initiator. The route is revalidated before every durable evidence read. A revoked or changed route, expiry, retirement, or any version/digest change stops the watch; it does not follow a newer version.

The watch records a durable run watermark at creation and observes only later `skill_run` calls that actually succeed and whose native Goal execution-run binding was durably recorded. A Verifier receipt is merely a nudge: the service rereads Goals' owner-scoped snapshot, matches the exact execution run and immutable Goal definition, then accepts only a fresh, unexpired independent whole-goal `achieved` or `not-achieved` receipt. Each invocation and receipt digest is counted once, up to the first `max_runs` attached runs; it stops as exhausted when all of those runs have qualifying outcomes without reaching the failure threshold. Repeated receipts, old receipts, wrong Goals/runs, old skill versions and unknown evidence do not count. Reconciliation also runs after restart; it creates no scheduler or polling loop.

Public `skill_watch` has no operator-pinned task family, so it is strictly observation-only: neither `achieved` nor `not-achieved` changes the active version, and `failure_threshold` is retained only as bounded watch metadata. `skill_watches` exposes the durable state and observations. Only the qualified canary flow below creates a watch with an exact operator-pinned task family and a matching deployment record; only that pair may automatically promote or append the immediate-parent fallback. A Goal from another task family cannot authorize either mutation.

Qualified canary deployments additionally consume Evaluation's Host-only current `goal-outcome/<assessmentId>` projection. Skills subscribes to Evaluation lifecycle-scoped task-change nudges, performs a cold reread when the provider appears or is replaced, and unsubscribes with the injected provider fiber. A notification carries no authority: every reconciliation rereads the exact canonical scope and assessment. Provider absence leaves the durable deployment intact but cannot admit or dispatch new deployed work.

The first accepted canary observation freezes an immutable binding of run ID, assessment subject, Verifier receipt digest and validity times, execution-trace digest, and operator-pinned task-family digest. Later Evaluation revisions may replace only the canonical status for that exact binding. A strictly newer `not-achieved` revision replaces an earlier achieved observation; an exact `retract` removes it and records durable invalidation. Same-version duplicates are idempotent only when digest and disposition are identical, lower versions cannot restore evidence, and subject/scope/owner/run/profile drift is rejected. For a qualified deployment, correction or retract reaches the existing exact-version rollback transaction: it appends the pre-bound immediate parent only if the watched version, definition and fallback digests are still current, and never overwrites a later version. Restart preserves the latest canonical revision and cannot resurrect a withdrawn success.

Evaluation's `withTrustedCanonicalTaskWriterFence` holds the exact scope watermark plus subject/ref/version/digest/disposition while Skills atomically replaces or invalidates the observation, reconciles deployment state and, when required, writes the rollback version. Promotion fences every canonical observation counted toward quorum, so an unrelated stale success cannot authorize the transition. Before a deployed invocation is claimed, again after its quota slot is reserved, and before every native tool dispatch, Skills rereads and briefly fences every recorded canonical revision; an Evaluation change also aborts active deployed executions. Missing/replaced Evaluation, changed evidence or a failed fence closes admission before claim; a failure after reservation is recorded as `unknown` and cannot replay. The synchronous fence cannot remain held across an asynchronous external tool, so a non-cooperative tool may still complete after a later correction; its effects are not undone and the run remains conservatively unknown. New qualified watches use `canonical-goal-outcome/v2`; legacy or malformed active qualified deployments without exact canonical evidence are blocked on reopen without changing the active definition. This revision monitor is limited to qualified canary deployments. Standalone watches deliberately retain their legacy immutable-receipt, observation-only behavior, and no other deployment cohort is claimed.

## Candidate trials, activation and rollback

To review a potential replacement while keeping the current skill active:

1. After an independently achieved source Goal, call `skill_candidate` with `goal_id`, `name`, `description`, `bindings_json`, the current `parent_version` (or 0 for a new name), `reason` and `trigger`. The current human owner request is required. `skill_candidates` reads the pending definition and Host-derived structural difference: added/removed tools, changed step digests and input changes. These differences do not measure quality or infer an expanded permission grant.
2. In a fresh Goal with its own acceptance profile, call `skill_trial` with `candidate_id`, `goal_id`, `inputs_json` and a stable `invocation_id`. Before an admitted native round it returns the same no-work `awaiting-native-round` handoff and the next native round repeats that ID. Trial steps use the ordinary native tools and may have real effects once admitted. They retain the same duration limit, owner/Goal checks, current tool approval and budget handling as `skill_run`. Pending candidates are absent from the native catalog.
3. After that exact trial independently achieves its Goal, the owner can request `skill_activate` with `candidate_id` and `trial_run_id`. The accepted source turn must contain exactly one successful `skill_trial`, with matching candidate, Goal, invocation and inputs, as its only business execution. It may also contain only successful, parameter-validated metadata reads: `get_goal({})`, `skill_candidates({})` or its exact candidate ID, `skill_status({})` or its exact trial run ID, and `goal_context({})` or the exact Goal with omitted or `false` focus. A later repair call, another trial, business tool, control mutation, unknown field, failed/unknown call, or unrelated accepted run cannot authorize activation. Reading an older accepted Goal is allowed only in its original owner Session with an unexpired receipt. The current parent must still match.
4. `skill_rollback` takes `name`, `expected_version` and `target_version`, where the target is the current version's immediate parent. It copies the parent into a new immutable version: activating v2 over v1 and rolling back produces v3 with `restoredFromVersion: 1`. Old versions and runs remain recorded. Repeating the same rollback does not append another version. `skill_reject` discards a pending candidate without changing the active skill.

To activate with an observation watch in the same commit, use `skill_activate_watched(candidate_id, trial_run_id, owner_route_id, expires_at, max_runs, failure_threshold)`. It requires an existing parent, the same exact independently accepted trial and current owner request, `activate` and `watch` permissions, and background `watch` authority for the current owner route. The new immutable version, candidate activation and exact-version watch are written in one SQLite transaction. Invalid or failed watch storage leaves the parent active. A repeated request must retain the exact watch parameters and route binding; it returns the original activation and current watch state without extending the watch. This public flow has no operator-pinned task family, so its observations cannot promote or roll back the active version. The finite watch bounds monitoring, not the lifetime or total executions of the skill.

Policy must separately allow `draft`, `trial`, `activate`, `reject` and `rollback` on the same evolution resource. All mutations use stable Policy authorization keys; draft, activate, reject and rollback require the current authenticated human request. Revoked authority, changed parents, failed/unknown trials and expired candidates prevent activation. Candidate lifetime defaults to 24 hours, configurable from one second to seven days; repeating a draft never extends its original expiry. A previously successful activation can be read back idempotently without reactivating it over a later version.

This delivers owner-reviewed version changes after a verified trial. Owner-preauthorized capture can form one pending candidate from an exact independently achieved successful trace, and the failure entrypoint above can form one from one or more exact independently accepted failures followed by a later exact achieved repair. Partial, unknown, mixed-task and unverified broader traces remain unsupported. Prospective comparison and finite automatic canary admission use the separate entrypoint below; finite rollback watches and trial success alone do not establish causal improvement.

## Actual parent/candidate comparisons

`skill_compare(candidate_id, profile_id, invocation_id)` executes the parent and pending candidate on the same operator-configured inputs and limits. Each arm uses native read/write/edit tools in a private temporary workspace and a separate isolated artifact runner; the Host compares actual behavior against its expected output. Results persist and can be read with `skill_comparison_status` after restart. Failed/unknown attempts are not automatically repeated, and current owner/Policy/parent/expiry are checked during execution.

This optional capability needs the Evaluation and Isolation packages plus an explicit finite comparison profile and Policy `compare` permission. See [comparison configuration and limits](../../docs/skill-comparison-profiles.md). A Host may also register an opaque, Host-attested comparison plan; its binding digest is recorded, but this bundle ships no production plan provider and the attestation does not prove OS-level sealing, historical independence, or model inaccessibility. Reports separate evaluation gains from critical regressions; a complete run with zero gain is not an improvement. They never grant promotion permission or establish independent holdout evidence. The candidate stays pending until a separately authorized lifecycle action changes it.

## Independent operator judging process

The installed `dsh-skill-holdout --config /private/config.json` CLI holds an operator-selected dataset and Ed25519 key in a separate evaluation process. It issues one input at a time to a trusted executor, independently checks actual output, and signs a report bound to the exact scope, arms, dataset, limits and budget identity. State is committed before responses; concurrent controllers are fenced and a recovered unconfirmed cell is never reissued. Deploy the authority outside candidate workers and pin its public key independently. The CLI is not a model tool and does not execute candidate code, supply an in-process sealed provider, prove historical data independence, or authorize promotion. See [configuration, pipe protocol and deployment boundaries](../../docs/skill-holdout-authority.md).

Configure a finite `externalHoldouts` profile with the exact owner scope, candidate execution limits, fixed authority command, public-key and dataset pins. `dsh-skill-holdout --inspect-config` exports those public pins without consuming a qualification. With current owner and Policy `compare` authorization, `skill_qualify(candidate_id, profile_id, invocation_id)` runs the external judge through the installed Skills service and records its signed result in the existing comparison journal. Each profile permits one qualification across sessions. The same invocation never restarts completed or unknown work, including after Host restart. The private command/configuration, setup files and raw case inputs/outputs are absent from tool responses; public signed receipts contain identity digests and the verification public key. Comparison still grants no automatic activation.

`skill_comparison_status` labels configured local profiles with `kind: "local"` and `executionTool: "skill_compare"`, and external profiles with `kind: "external"` and `executionTool: "skill_qualify"`. A prospective external profile exposes `canaryExecutionTool: "skill_canary"` only when its configured public profile pins both a `generatorDigest` and the exact `canaryAdmission`; that field identifies the available entrypoint, never authorization. Profile IDs are opaque operator-selected IDs: when the owner did not provide the exact configured ID, query `skill_comparison_status` and use its exact `id`; never derive one from a dataset, generator, task or version label. `skill_canary` starts its own prospective comparison and deploys only after all qualification and authorization gates pass; it does not make a prior qualification an additional permitted attempt. Status remains owner-scoped and omits authority keys, private inputs, commands and state paths. Candidate and canary mutation responses use the same explicit public projection: source traces, owner/session/native Goal identities, route receipts, individual run IDs and raw failure evidence remain Host-private, while stable public digests, counts, lifecycle state and structural differences remain available for review and subsequent calls.

### Finite automatic canary

An operator can instead configure a supported `prospective.generator` in the private authority and pin the inspected `generatorDigest` in the Host profile, omitting `datasetDigest`. The authority freezes the candidate/baseline/budget before generating private random cases. `order-summary/v1` and `order-summary/v2` are versions of one order-summary family; v2 uses integer `amountCents`, including negative values, cancelled orders and empty input, while v1 retains its nonnegative `cents` contract and digest. `template-render/v1` is the second family. `dependency-topological-order/v1` is the third: it accepts only edge lines containing exactly two labels matching `[a-z][a-z0-9]{1,31}`, ignores blank/malformed lines, deduplicates edges, and emits the lexicographically smallest topological order one node per line or `CYCLE\n`. Its private replay/evaluation/regression cases cover a DAG, a dynamically introduced lexical tie and a cycle. Each profile has a distinct inspected pin; changing profiles cannot reset a consumed authority. These are three deterministic engineering task families, not arbitrary task domains, historical training independence or real-model gain.

With a current owner request, `canary`/`compare`/`watch` Policy permissions and current background `promote`/`watch`/`rollback` authority, `skill_canary(candidate_id, profile_id, invocation_id, owner_route_id, expires_at, max_runs, canary_runs)` compares and admits a candidate only when its signed prospective receipt passes candidate checks, positive evaluation gain and critical regressions. On that complete all-gates result the status reports `heldoutIndependence: attested-after-freeze`; it attests only that the binding was frozen before the pinned generator produced the private cases and the pinned authority signed each cell, so deterministic replay could not pre-read answers — not process separation, enforced Docker flags, OS/kernel isolation or training-history independence. Every other path reports `unproven`. Exact version activation, the execution quota and rollback watch commit atomically. Standalone qualification receipts do not grant permission.

Use ordinary `skill_run` in fresh native Goals. Initially only `canary_runs` executions are allowed; fresh distinct independently achieved outcomes promote the version within the original `max_runs` total and expiry. Promotion and every later deployed dispatch require those accepted observations to remain the current fenced Evaluation revisions. Limits are 1–100 total runs and at most seven days, no later than the qualification profile's expiry. Failed or unknown runs retain their charged slot and block further execution, including after restart. A later canonical `not-achieved` correction or withdrawal of a previously accepted Goal outcome triggers the same exact-version parent rollback; revoked authority, unavailable canonical evidence or expiry prevents further use. `skill_deployment_status` exposes durable state and charged runs. Identical activation retries cannot renew or resurrect a deployment.

See the [operator configuration and complete authorization flow](../../docs/skill-holdout-authority.md#prospective-qualification-and-finite-canary). Engineering tests with synthetic programs verify admission and lifecycle behavior; they do not establish real user-task or model intelligence gains. The candidate runs in the existing isolated artifact runner; the private authority's files, pipe and keys remain outside its authority. No additional network, credential or install-script authority is granted by this tool.

Fixed replay comparison now retains validated workspace-contained glob/grep and parameterless get_goal as explicitly omitted observations. Their original steps still count against the declared tool-call and byte limits; reports also state actual executed tool calls. They do not run, produce fabricated results or change the immutable source. Other controls and unsupported tools remain rejected by the offline comparator.

## Authority and privacy

- Filesystem: creates a private SQLite database (0600), WAL/SHM and new parent directory (0700). The store contains owner-scoped historical tool arguments, input defaults, acceptance references and invocation receipts. These may contain private task content; do not put the database in a shared or public directory. Symlink/nonregular database files are rejected.
- Comparison authority: finite operator-configured offline Docker verification, private benchmark journals and temporary file workspaces; native read/write/edit only. The calling Agent receives no general verifier runner handle or expected-answer payload.
- Filesystem/network/subprocess effects during reuse: only through saved, Host-allowlisted native tools with their current approvals, Policy, cancellation and Goal budget. The optional external qualification configuration additionally authorizes a fixed Host subprocess and isolated candidate verification; its executable, arguments and container mounts are trusted operator choices, never model arguments.
- Credential/browser authority: the separately invoked operator CLI reads only its configured private Ed25519 key, dataset and configuration files, and writes its private qualification SQLite state. It uses stdin/stdout for a trusted controller and has no network listener or browser. The ordinary Skills service does not load these files or gain signing authority. Native tools retain their own requirements.
- Install scripts: no runtime install/postinstall scripts. Build/prepack scripts compile the independently publishable bundle.
- Historical acceptance is checked at capture. It is provenance for the saved workflow, not future task acceptance or a permanent grant. Owner lineage/workspace/preset changes isolate saved data and stop subsequent dispatches.

Validation uses package tests for native tool dispatch, typed inputs, owner isolation, current permission checks, retirement, persistence and no replay, plus `pnpm test:web-owner:real-skill` (reuse) and `DSH_WEB_REAL_SKILL_CANDIDATE=1 pnpm test:web-owner:real-skill` (candidate lifecycle) for the explicitly configured real-route Web scenario. See repository evidence for runs actually completed.

The capture/canary Web tests can use an already logged-in TraeX account in a fresh temporary profile: `DSH_WEB_REAL_PROVIDER=traex-agent DSH_WEB_REAL_MODEL=gpt-5.6-terra pnpm test:web-owner:real-canary`. Select a model available in that account's current catalog; omitting `DSH_WEB_REAL_MODEL` uses TraeX's `default`. This installs the TraeX adapter only in the test profile, binds it to the test workspace, and never falls back to the Codex subscription route. Canary tests also require `DSH_HOLDOUT_TEST_IMAGE` with the pinned Node image and an available Chromium executable. Call/deadline limits remain enforced; TraeX usage is not treated as a verified token or monetary cap.

### Owner-authorized repair continuation (experimental)

An operator may configure `repairProfiles` to expose `skill_repair_arm`,
`skill_repair_status`, and `skill_repair_revoke`. The owner selects a profile and
an exact source Goal, route, invocation id and expiry. One authorization permits
a finite sequence of independent repair Goals, each with its own prospective
comparison and canary. `maxIterations` defaults to one and is limited to four;
`followupProfileIds` explicitly names every subsequent profile in order. Arming
freezes the full sequence and its digests. The sequence cannot renew its expiry,
expand tool/model authority, or reset cumulative model/tool call budgets.

A repair profile contains `id`, exact `scope` (principal id, record id/version,
workspace and preset), `skillName`, `taskFamilyId`, `description`, optional typed
capture `bindings`, `externalHoldoutProfileId`, `provider`, `model`,
`allowedTools`, `maxGoalRounds`, `maxModelCalls`, `maxToolCalls`,
`maxOutputTokens`, `maxDurationMs`, `canaryRuns`, and `maxCanaryRuns`, plus optional
`maxIterations` and `followupProfileIds`. Each followup uses the same owner, skill
and model route with no broader tool, output, round or duration limits.
The selected external holdout must use a prospective `generatorDigest` and
`canaryAdmissionTemplate`:

```json
{
  "protocol": "assistant-skills/canary-admission-template/v1",
  "skillName": "saved-workflow",
  "taskFamily": {
    "goalDefinitionDigest": "<exact configured Goal definition digest>",
    "outcomeProfile": { "id": "task-outcome", "version": 1, "digest": "<profile digest>" }
  }
}
```

A template and a static `canaryAdmission` are mutually exclusive. The Host fills
in the actual parent and newly captured candidate digests after independent
repair acceptance. Model tools cannot supply evaluator cases, rewrite this
configuration, create another Goal, or promote themselves. The ordinary public
capture/canary tools retain their current-human-request requirements.

Install the native Goal service and goal-round driver before creating repair
Agents. Configure Goals' preauthorized round limit, independent native-round and
whole-goal acceptance, and a compatible registered budget meter. The selected
preset and model must support the required native tool protocol. Background
Policy must permit both identities: the configured preset's background Agent
needs Goal `create/observe/execute`, its allowed file tools, and Skills
`draft/compare/canary/watch`; the `dsh-enhanced-assistant-skills` background
service needs `draft/compare/canary/promote/watch/rollback`. Scope both to the
authorized principal and workspace. `notify: true` additionally requires the
service's background message `send` permission. Allowing only the service does
not authorize the Agent's candidate capture. `repairProfiles` is empty by default; manual skills do not
acquire these runtime dependencies or start repair Agents.

When the source Goal has stopped and has an exact independent `not-achieved`
receipt, the Host creates a separate root Session in the authorized workspace.
The native driver owns model rounds. The model receives the original objective
and chooses its repair; the Host supplies no repaired program. It captures only
an independently accepted repair trace, then uses the existing external holdout
and canary gates. Each boundary rechecks the durable intent, profile, owner
route, source definition, parent version, expiry and background policy. A
process-local capability links Goals to the current Skills instance; it is not
isolation from arbitrary malicious plugins sharing the same Host process.

Repair profiles may grant only the native workspace file tools `read`, `write`,
`edit`, and `read_image`. Shell, code transport, network, and arbitrary preset
tools are rejected when an automatic repair profile is loaded because this
bundle cannot state or enforce their authority as a workspace file boundary.
For those native file calls, a repair Agent accepts relative paths and absolute
paths under its configured workspace. It rejects malformed arguments, parent
traversal, paths outside that workspace, and any symlink traversed below the
workspace before delegating to the native tool. This is an authorization
boundary for the repair Agent, not an OS sandbox. The pinned native tool API
opens a pathname after the check rather than accepting a directory/file
descriptor, so it cannot prevent a same-UID concurrent replacement between the
check and native open.

A successor starts only after the prior version is promoted and a distinct
new task using that version has independently failed under the next configured
acceptance profile. The source run must have started strictly after the immutable
promotion time. Old promoted records without that evidence cannot authorize a
successor. Each iteration uses a fresh Session; the previous Agent closes before
continuation advances. Profile changes, revoked authority and expiry prevent
new work.

`skill_repair_arm` accepts `notify: true` only from the owner route Session and
with current background send Policy. It freezes that Session and route receipt
for iteration and final-result notices through Delivery’s durable Outbox. Stable
keys deduplicate notices across runtime ticks and restarts.

Armed waits and deployed watches survive restart. Safe repair checkpoints can
also resume under the conditions below; uncertain dispatches surface `unknown`
without creating a second repair. Status includes the exact repair Session/Goal
and candidate/deployment references. The `test:web-owner:real-repair` journey checks
two successive improvements, future-task promotion, original-session feedback
and absence of replay after completion and restart. `skill_repair_revoke` stops the remaining continuation; completed
filesystem effects or a deployed version require their existing explicit
rollback controls. Repair Agents use the configured workspace, model route and
tool authority, and may write files there; they are not an OS sandbox. Calls and
deadlines are finite; token or monetary accounting still depends on the route's
registered meter. No installation script or credential authority is added.

### Repair checkpoint recovery

The dev increment after v0.1.31 persists an execution fence per authorized repair
iteration. A cold Linux Host may reacquire it only when the prior process is
proven gone in the same PID namespace and no model or tool effect remains
pending. Tool completion also requires its native Session result to be flushed.
Successful disposal permits reattachment in the same process. Expiry alone never
permits takeover. Missing legacy execution records, unreadable process identity,
different PID namespaces and unfinished external work remain unconfirmed.

Reattachment loads the original Session and native Goal, revalidates current
owner, route, source, profile and Policy, and retains cumulative call counts,
native rounds and the original absolute deadline. Only an active, disarmed Goal
can resume execution; completed Goals can be reattached for evidence processing.
Human-paused, blocked, cleared, changed or expired Goals are not automatically
rearmed. Interrupted capture/comparison dispatches remain `unknown`.

The cross-process test kills a Host after a completed first round and its
independent acceptance, then verifies that a second Host finishes the same Goal
and writes a real artifact within the remaining budget. It uses the pinned
SessionPersistence, native Goal driver and repair runtime with a deterministic
model adapter and fixture owner/policy evidence. It does not establish live-model
crash recovery, arbitrary subprocess cleanup or cross-platform cold recovery.
