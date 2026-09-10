# Native Web owner browser regression

Run from the repository root after `CI=true pnpm build`, with DSH `0.1.2-rc.1` on PATH and a Playwright Chromium installation:

```sh
CI=true pnpm test:web-owner
```

To use an existing Chromium executable:

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:web-owner
```

This separate integration command requires a real DSH installation and browser; `pnpm check` does not run it. Missing prerequisites fail the command. It installs the five Web scenario bundles into a fresh temporary `DSH_HOME`, invokes the shipped owner setup CLI, and launches the real Web Host. Only the model is deterministic and capped at six calls. The browser uses the actual launch authentication, native UI, HTTP RPC and WebSocket streams; no transport interception or fabricated owner/Goal rows are used.

The test checks denied unauthenticated and untrusted-origin API requests, native session creation, one explicit tool approval, streamed reply, owner binding, processed Inbox, business Goal persistence and released Session lease. It then stops and restarts the Host, authenticates a fresh browser context and sends another prompt to the same persisted session. Identity and original objective must remain unchanged; native goal rounds may advance within the original limit. This is transport/runtime evidence, not real-model reasoning quality, verified goal achievement, multi-day execution or OS isolation evidence.

Artifacts live under ignored `.cache/web-owner-e2e/`. Launch credentials are redacted from Host output, and traces/HAR/video are disabled. Temporary profiles are removed and the test's Host process is stopped in cleanup. Tests never activate a user's existing profile or change account credentials.

## Real-model whole-goal experiment

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium pnpm test:web-owner:real
```

This opt-in command sends real requests through the installed Codex subscription adapter and requires an existing supported ChatGPT subscription login and `zstd` on PATH to read the actual compressed Session audit log. It uses `gpt-5.6-terra` by default; set `DSH_WEB_REAL_MODEL` to select another supported model. It never copies credentials into the temporary profile or changes the user's existing profile. It is separate from both the deterministic browser regression and `pnpm check`.

To reuse an already configured gateway through the production `llm-pi-ai` adapter:

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  DSH_WEB_REAL_SOURCE_HOME="$HOME/.dsh" \
  DSH_WEB_REAL_PROVIDER=super-relay DSH_WEB_REAL_MODEL=auto_model/alwaysday1 \
  pnpm test:web-owner:real
```

`DSH_WEB_REAL_PROVIDER` is the provider key in `llm-pi-ai.providers`, and `DSH_WEB_REAL_MODEL` is its configured model ID, not its display name. The helper copies only that selected public route into the temporary home. Its `apiKeyEnv` is resolved from the current environment or the exact reference in the source `.credentials.yaml` and passed only in the temporary child environment. It refuses credential-bearing URLs, unsupported fields, an existing target settings file, and source/target aliases. It never writes to the source profile. Multiple configured models require an explicit model selection. This supports existing compatible gateway routes without requiring DeepSeek credentials; the default remains the Codex subscription route above.

The browser asks the model to create a two-round goal for an order-summarization program with `start_native_rounds: true`. The successful tool result ends the foreground turn through the native `concludeTurn()` API; the native goal driver then owns continuation and the model writes the program during a goal round. Only the model writes the program. The installed Verifier executes a captured artifact with fixed inputs and exact expected outputs, separately records v2 step and v3 whole-goal receipts, and the test requires independently achieved whole-goal status and native completion. Cases cover summing repeated currencies, key order, cancelled orders, negative amounts and empty input. Native workspace-write permissions and explicit browser approvals remain in use. Each browser approval must match the same session's actual tool call and exact allowed arguments; successful runs also require the corresponding persisted `allowed-once` decisions.

The test-only tool guard restricts Goal creation to the exact objective and round limit, file operations to the single `summarize.mjs` artifact, and additionally permits reading Goal state. Tool schemas are filtered from the actual claimed native input: the foreground creates the goal and hands off, then has no tools; the native goal round receives artifact tools. Artifact writes outside a logged native goal turn are rejected. The production `goal_create` description explains the distinction between the owner turn and subsequent native rounds; the optional handoff closes the owner turn on successful creation. Omitting it preserves the existing opportunity to configure event waits or schedules in the same owner turn. Shell commands, other files, explicit goal completion and permission escalation are rejected. The prompt guides the model to skip planning/inspection tools; this is a guided runtime smoke test, not a comparative reasoning benchmark.

A test-only Host guard permits at most ten real model dispatches and a single five-minute window starting at the first dispatch. It records call and usage metadata, cancels active Agents at the deadline, and does not fabricate usage for unfinished streams. This is **not** the production cumulative token/cost budget: the subscription transport cannot impose a server-side output token ceiling, and a custom gateway requires its own trusted input bound, so this experiment does not register a Goal budget meter or claim a monetary hard limit. A gateway returning tool calls and usage is separate evidence from enforcing a production cumulative Goal token budget. Cancellation does not prove the remote provider stopped billing or that arbitrary subprocess descendants terminated.

After verified completion and lease release, the test stops the actual Host, starts a second Host on the same temporary home, authenticates a fresh browser context and opens the persisted Session. It checks the original Goal identity/scope/native state, the generated artifact hash and actual model reply remain unchanged, with no additional model dispatch. This is completed-goal reload evidence; unfinished event-triggered goal recovery remains a separate scenario. Audit assertions require artifact write calls to belong to actual native goal turns, not the foreground request.

Artifacts under `.cache/web-owner-real-e2e/` retain model-call metadata, the generated source, independent receipts and redacted Host/browser evidence. The profile and its Host are removed on completion or failure. The local checker runs under the same OS user; this experiment is not proof of the planned isolated worker/credential broker or hidden-evaluation boundary, long-term autonomy, or comparative model gains.

For real file-event recovery, use the same route environment with `pnpm test:web-owner:real-event`.
This creates a disposable owner Session, lets the real model call `goal_create` and
`goal_wait_event`, restarts the Host, then changes a watched file. The original
Goal must resume, write the artifact, pass independent step/outcome verification,
and preserve its visible reply in the original Web Session without a duplicate
outbox message. The test rereads the persisted Session after shutdown. Reobserving identical bytes
and a subsequent new file event must not replay the completed wait.

The Goal uses explicit `executionBudget.mode: calls`: six native model calls,
six tool calls, a ten-minute absolute lifetime and an exact configured route.
This provides no token or monetary ceiling. The experiment separately caps ten
DSH model invocations including owner setup, retaining the count across Host
restarts, and sends finite output-limit hints. Unexpected tool approvals are
rejected through the real UI (at most three); only exact authorized calls can be
approved. No model, event or goal state is
fabricated. A test-only no-op Host executor consumes the watched source's ordinary
automation lane; that executor does not implement a product workflow. Artifacts
are under `.cache/web-owner-real-event-e2e/`. Existing strict token budgets remain
separate and still require a trustworthy meter.

## Finite offline autonomy installation

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  DSH_ISOLATION_TEST_IMAGE=sha256:<existing-local-image-id> pnpm test:autonomy
```

This separate opt-in test runs the actual local installer (including install/build) in a fresh temporary home, repeats the shipped setup to check unchanged grant expiry, then sends two browser prompts through the actual Web Host. The deterministic six-call model fixture requests an offline `isolation_run` and then retrieves the same idempotency key. Assertions require no per-call approval, one persisted successful job, one duration reservation, owner/scope binding, and real artifact `answer.txt` containing `42`. This proves the installed native wiring and Docker execution, not real-model intelligence, business-goal achievement or complete autonomy.

The test chooses an independent available preflight port and never stops an existing service. It needs a compatible local Docker image and non-root Host. Artifacts are under ignored `.cache/autonomy-e2e/`; temporary profiles and the test Host are removed, launch credentials are redacted, and traces/video are disabled. Unknown Docker resources follow the production fail-closed recovery semantics.

## Installed Goal admission and restart

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  DSH_ISOLATION_TEST_IMAGE=sha256:<existing-local-image-id> pnpm test:autonomy:setup
```

This scenario installs autonomy, prepares a real Web owner Session, stops its Host, then invokes the shipped `dsh-web-owner-setup --goal-admission ... --session-id ...` twice with a private task file outside the workspace. The CLI owns all Goal, verifier, budget and wake configuration; repeated setup must preserve patch bytes. After restart, the browser selects the admitted model using the native model menu because DSH preserves the old Session's model selection.

The foreground schedules a wake and the test restarts the actual Host again. Assertions require two native rounds on the same Session, a failing artifact followed by a corrected artifact, separate step/outcome receipts, four settled production budget reservations and a succeeded persisted wake without per-action approvals. One preparation-only adapter reply and seven mocked paid HTTP responses make execution deterministic; production DeepSeek serialization/metering, Goals, verification and Docker execution remain real. This is not a paid DeepSeek request or a model-quality benchmark. Artifacts are under ignored `.cache/autonomy-goal-setup-e2e/` with the same authentication redaction and cleanup rules.


## Real model repository event continuation

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
  DSH_WEB_REAL_PROVIDER=codex-subscription DSH_WEB_REAL_MODEL=gpt-5.6-terra \
  DSH_REPO_VERIFIED_DELIVERY=fixture DSH_REPO_EVENT_SOURCE=fixture \
  pnpm exec playwright test --config scripts/e2e/playwright-repo-real.config.mjs
```

The installed profile receives an ordinary repair-and-delivery request. The model chooses tools and creates its own finite Goal; the test does not supply trigger IDs, invoke Goal tools or select tool order. After an independently accepted intermediate PR and a durable event wait, it restarts the real Host while CI/review remain pending, returns to the original Session, and changes only the remote fixture state. Assertions bind the resumed Goal and source execution to an event after the saved cursor, require fresh repository outcome evidence for the actual committed head and visible feedback, then check that another restart and unchanged observation create no duplicate event or commit/PR.

GitHub DNS/HTTPS and commit/PR responses are explicit transport substitutes, including the non-production Keychain token. The model route, installer, Policy, Keychain lease, EventTriggers observer/cursor, Goals, Automations, Delivery and Docker verifier run as actual components. This is not live GitHub authentication or remote CI/review evidence. The event experiment allows at most 26 model dispatches with a 300-second task budget; installer and cleanup have a separate test timeout. It needs the exact local Docker image configured in the spec. No ordinary profile is modified, and no provider credential is retained in artifacts.

For a failed integration that needs local diagnosis, set `DSH_REPO_RETAIN_FAILURE=1`. The Host and browser still stop, but `retained-environment.json` points to the private temporary profile and original Session so a restart/UI check can reuse it without repeating model work. The default deletes this environment; remove a retained directory after diagnosis because it includes the private test configuration. Startup diagnostics retain only session/header/workspace identifiers, not credentials or model request headers.

## Automatic workflow capture and reuse

`pnpm test:web-owner:real-capture` exercises an isolated fresh Web profile with the existing real model route. The owner asks for a finite task and preauthorizes a pending skill candidate in the same request. The test requires independent source acceptance, automatic capture without a later save request, a Host/browser restart, candidate replay in a fresh Goal after removal of the original artifact, fresh independent acceptance, explicit owner activation, and persistent readback without duplicate capture or replay.

```sh
CI=true DSH_CAPTURE_RETAIN_FAILURE=1 \
PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/chromium \
DSH_WEB_REAL_PROVIDER=codex-subscription DSH_WEB_REAL_MODEL=gpt-5.6-terra \
pnpm test:web-owner:real-capture
```

The observer bounds the entire experiment to 24 model dispatches; each Goal has an explicit eight-call/twelve-tool budget. It does not replace prompts, filter the model's tool catalog, prescribe tool arguments/order, or force round completion. Browser approvals permit only the task's file tools, owner Goal/skill controls, and session-local todo updates. The configured reusable tool allowlist is read/write/edit/glob/grep/todo_write/get_goal. The verifier runs the exported program on independent fixed cases; this is not an OS-sealed holdout or measured improvement experiment. Automatic activation is not exercised or authorized.

Artifacts are written under `.cache/web-owner-real-capture-e2e/`. With `DSH_CAPTURE_RETAIN_FAILURE=1`, failure stops the Host/browser and retains its private temporary home; `retained-environment.json` identifies the directory for local diagnosis without another model task. Delete that directory after diagnosis. With the option absent, private temporary data is removed on success and failure. Never publish the private home or raw session contents.

## Template-render prospective canary contract

```sh
CI=true PLAYWRIGHT_CHROMIUM_EXECUTABLE=/usr/bin/google-chrome \
  DSH_HOLDOUT_TEST_IMAGE=sha256:<existing-local-image-id> \
  pnpm test:web-owner:real-canary
```

This opt-in project runs the independent `web-owner-real-canary.spec.mjs`
browser journey against the real TraeX ACP route; other model providers are
rejected. It needs a pinned local holdout image and is separate from
`pnpm check`. Do not use the older order-summary scenario as evidence for this
canary.

The journey uses separate baseline, failure, repair, control, promotion and
negative-control Sessions. The baseline Goal creates the recursive
`render.mjs`, passes the legacy public checks and saves `template-render`
version 1. The failure Session then performs version 1 `skill_run` as its only
business action: the run itself succeeds, but independent strict literal
one-pass verification records the whole Goal as `not-achieved`. The repair
Session first reproduces version 1, then reads and edits only `render.mjs`; its
strict Goal is independently `achieved`. `skill_failure_candidate` is called
with the exact failure and repair Goal/Session identities, the repair edit id
and parent version 1, so the failed outcome remains causal candidate evidence.

After a Host restart, `runtimeCanaryAdmission()` derives the complete
`assistant-skills/canary-admission/v1` object only from persisted parent,
candidate, strict Goal/native Goal and outcome-contract rows. It binds the
parent and candidate definition digests, strict Goal definition digest and
outcome profile id/version/digest. A private isolated holdout pinned to the
`template-render/v1` generator must observe positive candidate gain before
version 2 enters its finite canary; this prospective result does not authorize
promotion by itself.

Promotion requires a fresh exact-family Goal whose only business action is the
exact version 2 `skill_run` and whose independent outcome is `achieved`; the
background canary observation then promotes it without `skill_activate`. A
separate negative-control Goal uses the same strict objective and outcome
profile but supplies the declared `implementation` input containing the
recursive implementation. Its `not-achieved` outcome causes the finite watch to
roll back to a new immutable version 3 restored from version 1. A final Host
restart requires definitions, runs, comparisons, deployments, watches, Goals,
verification records, processed Inbox rows and model-dispatch count to remain
unchanged, proving no replay or resurrection.

The reusable-tool allowlist is only `read` and `edit`, scoped to `render.mjs`;
`bash`, `skill_activate` and other manual artifact/control paths are forbidden,
and any surfaced `bash` approval is rejected in the browser. Model-visible
comparison/deployment status is checked recursively for private receipt
material; private SQLite and holdout evidence is inspected only by the test
process. Artifacts are under `.cache/web-owner-real-canary-e2e/`: failures retain
Playwright trace/video/screenshots plus Host, model, transport and DOM evidence.
Set `DSH_CAPTURE_RETAIN_FAILURE=1` to also retain the private temporary profile
and write `retained-environment.json`; otherwise the profile is removed. Delete
retained environments after diagnosis and never publish their contents.
