# Coding subscription provider — CLI event fixtures

Status: **PENDING CAPTURE** — capture tooling is ready; no real samples are committed yet.

The parser in `src/process.ts` is layered as `decode JSON line → provider-specific
decoder → normalized event → reducer`. To lock that layering against real upstream
drift, each provider needs golden fixtures captured from a **known CLI version**:

- `codex`, `claude`, `cursor`, `grok`
- per version: `success`, `partial-then-success`, `terminal-failure`, `malformed`,
  `auth-source`, and (only if the official output carries it) `usage`.

These are not committed yet because capture requires an **authenticated** local CLI and
a real model turn, which consumes the operator's subscription quota. Capture must be
**explicitly authorized** and, before committing, every sample must be redacted of
account identifiers, filesystem paths, session ids, tokens, and prompt content.

Until real samples land, `tests/process.spec.ts` exercises the parser and lifecycle with
synthetic, hand-written events that mirror the documented shapes — never fabricated
"real" samples — and `tests/fixtures.spec.ts` stays a green no-op.

## Tooling (ready now)

### `scripts/capture-cli-fixtures.mjs`

An operator-run Node ESM tool (NOT part of the automated suite) that spawns a real CLI,
records its stdout JSONL, redacts it, and writes a `CliFixture` JSON file.

```
node scripts/capture-cli-fixtures.mjs \
  --provider <codex|claude|cursor|grok> \
  --scenario <success|partial-then-success|terminal-failure|malformed|auth-source|usage> \
  --version <cliVersion> \
  --prompt "<safe test prompt>" \
  --i-understand-this-uses-quota
```

- **It consumes real subscription quota.** It refuses to spawn without
  `--i-understand-this-uses-quota`. Use `--dry-run` to preview argv and the output path
  without spending quota.
- Redaction is **on by default**. `--no-redact` marks the fixture `"redacted": false`,
  which the loader and tests then **refuse** (debugging only).
- Output goes to `tests/fixtures/<provider>/<version>/<scenario>.json`.
- The provider argv it uses mirrors `src/providers.ts`; keep them in sync if presets change.

### `tests/fixtures/schema.ts`

Defines the `CliFixture` type and the loader:

```ts
interface CliFixture {
  provider: 'codex' | 'claude' | 'cursor' | 'grok'
  cliVersion: string
  scenario: string
  capturedAt: string
  redacted: true
  lines: string[] // redacted raw JSONL, one entry per stdout line, fed to the decoder
}

loadFixtures(): CliFixture[] // scans <provider>/<version>/<scenario>.json; [] if none
hasFixtures(): boolean
```

The loader validates minimal structure and **skips (with `console.warn`) any sample not
marked `redacted: true`**, so an un-scrubbed capture can never silently drive a test. A
missing directory or no valid samples yields `[]` — never a throw.

### `tests/fixtures.spec.ts`

Fixture-driven regression test. It replays each fixture's `lines` through the production
`runCliText` path (via an injected fake spawn) and asserts scenario semantics:

- `success` / `partial-then-success` → resolves with non-empty assistant text.
- `terminal-failure` → fails closed (rejects).
- `malformed` / `auth-source` / `usage` → must settle without crashing or hanging.

With **no fixtures on disk it passes as a no-op** (one always-on loader sanity test, no
per-fixture tests registered). It **activates automatically** the moment samples land.

> Note: `src/process.ts` does not export its per-line decoders (`decodeJsonLine`,
> `parseProviderEvent`, `decode*Event`), so scenario-level settlement is only observable
> end-to-end through `runCliText`. The exported `parseAssistantText` / `parseAssistantEvent`
> are line-level only and cannot express terminal/auth settlement — hence the reducer path.

## Redaction checklist (verify manually before committing)

Redaction is best-effort defense-in-depth, **not** a guarantee. Before committing any
fixture, open it and confirm **none** of the following remain:

- [ ] Absolute filesystem paths (`/Users/…`, `/home/…`, `/root/…`, `C:\Users\…`).
- [ ] The operator's home directory.
- [ ] Email addresses.
- [ ] Tokens / API keys / secrets (`Bearer …`, `sk-…`, long hex/base64 blobs,
      `token`/`apiKey`/`secret`/`authorization` JSON fields).
- [ ] Session ids / thread ids / request ids / UUIDs.
- [ ] Any verbatim echo of the prompt or any account identifier.
- [ ] `"redacted": true` is present (the loader refuses anything else).

## Coverage matrix (per provider × version)

| Provider | success | partial-then-success | terminal-failure | malformed | auth-source | usage |
|----------|:-------:|:--------------------:|:----------------:|:---------:|:-----------:|:-----:|
| codex    | needed  | needed               | needed           | needed    | needed      | if emitted |
| claude   | needed  | needed               | needed           | needed    | needed      | if emitted |
| cursor   | needed  | needed               | needed           | needed    | required¹   | if emitted |
| grok     | needed  | needed               | needed           | needed    | needed      | if emitted |

¹ Cursor requires a `system/init` event reporting `apiKeySource: "login"`; without it the
bridge fails closed on `MISSING_AUTH_EVENT`. The `auth-source` fixture is the place to
capture that init event.
