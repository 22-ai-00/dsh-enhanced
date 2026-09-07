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

The browser asks the model to create a two-round goal for an order-summarization program, end the foreground turn, then write the program during a native goal round. Only the model writes the program. The installed Verifier executes a captured artifact with fixed inputs and exact expected outputs, separately records v2 step and v3 whole-goal receipts, and the test requires independently achieved whole-goal status and native completion. Cases cover summing repeated currencies, key order, cancelled orders, negative amounts and empty input. Native workspace-write permissions and explicit browser approvals remain in use. Each browser approval must match the same session's actual tool call and exact allowed arguments; successful runs also require the corresponding persisted `allowed-once` decisions.

The test-only tool guard restricts Goal creation to the exact objective and round limit, file operations to the single `summarize.mjs` artifact, and additionally permits reading Goal state and writing todo notes. Shell commands, other files, explicit goal completion and permission escalation are rejected. The prompt guides the model to skip planning/inspection tools; this is a guided runtime smoke test, not a comparative reasoning benchmark.

A test-only Host guard permits at most ten real model dispatches and a single five-minute window starting at the first dispatch. It records call and usage metadata, cancels active Agents at the deadline, and does not fabricate usage for unfinished streams. This is **not** the production cumulative token/cost budget: the subscription transport cannot impose a server-side output token ceiling, so this experiment does not register a Goal budget meter or claim a monetary hard limit. Cancellation does not prove the remote provider stopped billing or that arbitrary subprocess descendants terminated.

Artifacts under `.cache/web-owner-real-e2e/` retain model-call metadata, the generated source, independent receipts and redacted Host/browser evidence. The profile and its Host are removed on completion or failure. The local checker runs under the same OS user; this experiment is not proof of the planned isolated worker/credential broker or hidden-evaluation boundary, long-term autonomy, or comparative model gains.
