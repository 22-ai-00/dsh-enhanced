/**
 * Fixture schema and loader for captured real-CLI output.
 *
 * A `CliFixture` is one recorded, **redacted** CLI session: the raw stdout JSONL lines
 * emitted by an official coding CLI (`codex`/`claude`/`cursor`/`grok`) for a single
 * scenario, at a pinned CLI version. The `lines` are meant to be fed verbatim to the
 * `src/process.ts` parsing/reducer path (via `runCliText` with an injected spawn), so
 * the format here is the loader-side contract that `tests/fixtures.spec.ts` consumes.
 *
 * Samples are captured out-of-band by `scripts/capture-cli-fixtures.mjs`. This module
 * only reads what has already been captured and redacted; it performs no network,
 * subprocess, or credential access and is safe to import from tests.
 */
import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The four locally-authenticated CLIs whose stdout `src/process.ts` decodes. */
export const fixtureProviders = ['codex', 'claude', 'cursor', 'grok'] as const
export type FixtureProvider = (typeof fixtureProviders)[number]

/**
 * One recorded, redacted CLI session.
 *
 * `lines` are the post-redaction raw JSONL lines (no trailing newline) exactly as the
 * decoder expects to receive them one at a time. `redacted` is a literal `true`: the
 * loader refuses any sample that is not explicitly marked redacted, so an un-scrubbed
 * capture can never silently drive a test.
 */
export interface CliFixture {
  readonly provider: FixtureProvider
  readonly cliVersion: string
  readonly scenario: string
  readonly capturedAt: string
  readonly redacted: true
  readonly lines: string[]
}

/** Directory that holds `<provider>/<version>/<scenario>.json`, resolved from this file. */
function fixturesRoot(): string {
  return dirname(fileURLToPath(import.meta.url))
}

/**
 * Validates the minimal structure of a parsed fixture. Returns the typed fixture, or
 * `undefined` (with a `console.warn`) when the shape is wrong or the sample is not
 * marked `redacted: true` — an un-redacted sample must never reach a decoder.
 */
function validateFixture(value: unknown, source: string): CliFixture | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    console.warn(`[fixtures] skipping ${source}: not a JSON object`)
    return undefined
  }
  const record = value as Record<string, unknown>
  const provider = record.provider
  if (typeof provider !== 'string' || !(fixtureProviders as readonly string[]).includes(provider)) {
    console.warn(`[fixtures] skipping ${source}: unknown provider ${JSON.stringify(provider)}`)
    return undefined
  }
  if (typeof record.cliVersion !== 'string' || record.cliVersion.length === 0) {
    console.warn(`[fixtures] skipping ${source}: missing cliVersion`)
    return undefined
  }
  if (typeof record.scenario !== 'string' || record.scenario.length === 0) {
    console.warn(`[fixtures] skipping ${source}: missing scenario`)
    return undefined
  }
  if (typeof record.capturedAt !== 'string' || record.capturedAt.length === 0) {
    console.warn(`[fixtures] skipping ${source}: missing capturedAt`)
    return undefined
  }
  if (record.redacted !== true) {
    console.warn(`[fixtures] skipping ${source}: not marked "redacted": true — refusing to use a potentially un-scrubbed sample`)
    return undefined
  }
  if (!Array.isArray(record.lines) || record.lines.some(line => typeof line !== 'string')) {
    console.warn(`[fixtures] skipping ${source}: "lines" must be an array of strings`)
    return undefined
  }
  return {
    provider: provider as FixtureProvider,
    cliVersion: record.cliVersion,
    scenario: record.scenario,
    capturedAt: record.capturedAt,
    redacted: true,
    lines: record.lines as string[],
  }
}

/** Parse and validate one `<scenario>.json`, swallowing read/parse errors as skips. */
function readFixtureFile(path: string): CliFixture | undefined {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    console.warn(`[fixtures] skipping ${path}: unreadable (${(error as Error).message})`)
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.warn(`[fixtures] skipping ${path}: invalid JSON (${(error as Error).message})`)
    return undefined
  }
  return validateFixture(parsed, path)
}

/** Read directory entries, returning an empty list on any error (missing/permission). */
function safeReadDir(path: string): Dirent<string>[] {
  if (!existsSync(path)) return []
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/**
 * Synchronously scan `<provider>/<version>/<scenario>.json` under this directory and
 * return every valid, redacted fixture. A missing directory or a directory with no
 * real samples yields an empty array — never a throw — so the suite stays green until
 * captures land.
 */
export function loadFixtures(): CliFixture[] {
  const root = fixturesRoot()
  const fixtures: CliFixture[] = []
  for (const provider of fixtureProviders) {
    const providerDir = join(root, provider)
    for (const version of safeReadDir(providerDir)) {
      if (!version.isDirectory()) continue
      const versionDir = join(providerDir, version.name)
      for (const entry of safeReadDir(versionDir)) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const fixture = readFixtureFile(join(versionDir, entry.name))
        if (fixture) fixtures.push(fixture)
      }
    }
  }
  return fixtures
}

/** True when at least one valid, redacted fixture is on disk. */
export function hasFixtures(): boolean {
  return loadFixtures().length > 0
}
