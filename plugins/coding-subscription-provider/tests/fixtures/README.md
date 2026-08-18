# Coding subscription provider — CLI event fixtures

Status: **PENDING CAPTURE.**

The parser in `src/process.ts` is layered as `decode JSON line → provider-specific
decoder → normalized event → reducer`. To lock that layering against real upstream
drift, each provider needs golden fixtures captured from a **known CLI version**:

- `codex`, `claude`, `cursor`, `grok`
- per version: success, partial-then-success, terminal failure, malformed/unknown,
  auth-source, and (only if the official output carries it) usage.

These are not committed yet because capture requires an **authenticated** local CLI and
a real model turn, which consumes the operator's subscription quota. Capture must be
**explicitly authorized** and, before committing, every sample must be redacted of
account identifiers, filesystem paths, session ids, tokens, and prompt content.

Until then, `tests/process.spec.ts` exercises the parser and lifecycle with synthetic,
hand-written events that mirror the documented shapes — never fabricated "real" samples.
