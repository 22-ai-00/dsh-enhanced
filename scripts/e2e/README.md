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
