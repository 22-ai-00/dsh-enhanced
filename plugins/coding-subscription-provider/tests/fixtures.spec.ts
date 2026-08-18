/**
 * Fixture-driven regression tests for the CLI stdout parser.
 *
 * These replay real, **redacted** CLI sessions — captured out-of-band by
 * `scripts/capture-cli-fixtures.mjs` and stored under `tests/fixtures/<provider>/<version>/`
 * — through the exact `src/process.ts` path used in production (`runCliText` with an
 * injected fake spawn). They lock the layered decoder against upstream CLI drift.
 *
 * `src/process.ts` does not export its per-line decoders (`decodeJsonLine`,
 * `parseProviderEvent`, the per-provider `decode*Event`), so scenario-level semantics
 * (successful terminal vs. fail-closed) can only be observed end-to-end through
 * `runCliText`. That is what these tests drive. (The line-level `parseAssistantText` /
 * `parseAssistantEvent` helpers ARE exported, but they cannot express terminal/auth
 * settlement, so the reducer path is the right target here.)
 *
 * No real fixtures are committed yet. Until they land, `loadFixtures()` returns an empty
 * array and only the always-on sanity test runs, so this file passes cleanly and never
 * reports "no test found". The moment a captured sample is dropped on disk, its
 * scenario-specific assertions activate automatically.
 */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runCliText, type SpawnProcess } from '../src/process.ts'
import { buildInvocation } from '../src/providers.ts'
import { hasFixtures, loadFixtures, type CliFixture } from './fixtures/schema.ts'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  kills: (NodeJS.Signals | number | undefined)[] = []
  kill(signal?: NodeJS.Signals | number): boolean { this.kills.push(signal); return true }
  spawn(): void { this.emit('spawn') }
  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void { this.emit('close', code, signal) }
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const values: string[] = []
  for await (const value of iterable) values.push(value)
  return values
}

interface ReplayResult {
  readonly outcome: 'resolved' | 'rejected'
  readonly text: string[]
  readonly error?: unknown
}

/**
 * Feed a fixture's redacted JSONL lines through `runCliText` via a fake child and report
 * how the invocation settled. `terminal-failure` fixtures are replayed with a non-zero
 * child close so a failed turn fails closed even when its failure is not (or only
 * partially) expressed in the recorded stdout; every other scenario closes cleanly and
 * lets the decoder decide.
 */
async function replay(fixture: CliFixture): Promise<ReplayResult> {
  const child = new FakeChild()
  const spawn = (() => child) as unknown as SpawnProcess
  const invocation = buildInvocation(fixture.provider, { cwd: '/repo', prompt: 'fixture-replay' })
  const pending = collect(runCliText(invocation, { spawn, killGraceMs: 50, timeoutMs: 5_000 }))
  // Attach handlers immediately so a rejection is never left unhandled while we drive the child.
  const settled: Promise<ReplayResult> = pending.then(
    text => ({ outcome: 'resolved', text }),
    (error: unknown) => ({ outcome: 'rejected', text: [], error }),
  )
  await Promise.resolve()
  child.spawn()
  for (const line of fixture.lines) child.stdout.write(`${line}\n`)
  // Let all stdout lines flush through the line reader before the child closes.
  await new Promise(resolve => setTimeout(resolve, 0))
  child.finish(fixture.scenario === 'terminal-failure' ? 1 : 0, null)
  return settled
}

describe('captured CLI fixtures', () => {
  const fixtures = loadFixtures()

  // Always-on: keeps the file non-empty when no fixtures are captured yet, and asserts
  // the loader stays quiet and only ever surfaces redacted samples.
  it('loads captured fixtures without throwing and only exposes redacted samples', () => {
    expect(Array.isArray(fixtures)).toBe(true)
    expect(hasFixtures()).toBe(fixtures.length > 0)
    for (const fixture of fixtures) {
      expect(fixture.redacted).toBe(true)
      expect(Array.isArray(fixture.lines)).toBe(true)
    }
    if (fixtures.length === 0) {
      // No captures on disk: nothing to replay. The suite passes as a no-op placeholder.
      expect(hasFixtures()).toBe(false)
    }
  })

  // Registers one replay test per captured fixture; registers nothing (harmlessly) when
  // the array is empty, so the suite activates automatically once samples land.
  for (const fixture of fixtures) {
    describe(`${fixture.provider} @ ${fixture.cliVersion}`, () => {
      it(`${fixture.scenario} settles with scenario-appropriate semantics`, async () => {
        const result = await replay(fixture)
        switch (fixture.scenario) {
          case 'success':
          case 'partial-then-success':
            // A recognized, authenticated turn must produce assistant text and settle successfully.
            expect(result.outcome).toBe('resolved')
            expect(result.text.join('')).not.toBe('')
            break
          case 'terminal-failure':
            // A failed turn must fail closed — never surface partial output as a success.
            expect(result.outcome).toBe('rejected')
            break
          default:
            // malformed / auth-source / usage and any future scenario: the only hard
            // requirement is that the parser neither crashes nor hangs — it must settle.
            expect(['resolved', 'rejected']).toContain(result.outcome)
        }
      })
    })
  }
})
