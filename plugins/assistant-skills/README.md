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
```

Policy must explicitly authorize the desired `inspect`, `save`, `run`, `retire` actions on `{ kind: evolution, id: verified-workflows }` for the exact owner, workspace and preset. Save/run/retire consume configured Policy authorization budgets with stable idempotency keys; catalog reads only preview current authorization. Native tool execution still requires its own current authorization and approval. Saving and retiring also require the current authenticated human request.

After a Goal completes with a current independently achieved outcome, ask the assistant to save it. `skill_save` takes `goal_id`, a kebab-case `name`, `description`, `expected_version` (0 for the first version), and optional `bindings_json`. Each binding is `{ "name": "output_path", "stepId": "<source tool call ID>", "path": "/file_path" }`. The path selects an actual scalar argument and derives its type/default; it does not evaluate code. The saved trace contains at most 32 successful calls and 256 KiB of arguments. Failed, unfinished, recursive skill, goal-control and dynamic orchestration traces are rejected. Catalog descriptions and saved inputs remain task data, not instructions granting authority.

Load the saved skill using the native `skill` tool. Create a new Goal with independently configured acceptance, then call `skill_run` in its admitted native round with `goal_id`, `name`, `version`, `inputs_json`, and a stable `invocation_id`. Missing declared inputs retain their saved defaults. Extra inputs or type mismatches are rejected. Steps execute in recorded order with current owner/Goal/Policy checks before and after each dispatch. This is a tool composition in the existing native Goal, not another agent loop or scheduler.

`skill_status` lists active versions, their typed inputs and exact source acceptance, or reads a `run_id`. An invocation's `succeeded` state only means its tool steps succeeded: the new Goal still needs its own independent acceptance. Version updates use CAS and retain the prior version as provenance. Only the latest active version can run; retiring it does not reactivate an older version. Automatic candidate promotion and rollback are not implemented here.

Only one invocation may be running for a given owner/session/Goal, including concurrent native ToolRuntime callers. A budget denial preserves a failed invocation audit and dispatches no business tool. Repeated invocation IDs never repeat effects, including after Host restart. A different goal, version or input under the same invocation ID is rejected. Interrupted runs recover as `unknown`, with completed step receipts retained; they need explicit inspection and repair. Failure stops remaining steps and returns an actual failed native tool result after preserving the invocation record. No arbitrary effects are automatically reversed: compensation is stop-and-report, not a claim that writes or external actions can be undone.

## Authority and privacy

- Filesystem: creates a private SQLite database (0600), WAL/SHM and new parent directory (0700). The store contains owner-scoped historical tool arguments, input defaults, acceptance references and invocation receipts. These may contain private task content; do not put the database in a shared or public directory. Symlink/nonregular database files are rejected.
- Filesystem/network/subprocess effects during reuse: only through saved, Host-allowlisted native tools with their current approvals, Policy, cancellation and Goal budget. No direct shell, filesystem writer, network client or subprocess runner is supplied by this bundle.
- Credential/browser authority: none added. It neither reads credential stores nor drives a browser. Native tools retain their own requirements.
- Install scripts: no runtime install/postinstall scripts. Build/prepack scripts compile the independently publishable bundle.
- Historical acceptance is checked at capture. It is provenance for the saved workflow, not future task acceptance or a permanent grant. Owner lineage/workspace/preset changes isolate saved data and stop subsequent dispatches.

Validation uses package tests for native tool dispatch, typed inputs, owner isolation, current permission checks, retirement, persistence and no replay, plus `pnpm test:web-owner:real-skill` for the explicitly configured real-route Web scenario. See repository evidence for runs actually completed.
