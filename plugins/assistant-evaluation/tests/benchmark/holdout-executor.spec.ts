import { createHash, createPrivateKey, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldoutEvidenceStore } from '../../src/benchmark/holdout-evidence.js'
import { openHoldoutProvider, type HoldoutProviderConfig, type HoldoutProviderTransport } from '../../src/benchmark/holdout-provider.js'
import { holdoutUnsignedCanonicalJson } from '../../src/benchmark/holdout-protocol.js'
import { createHoldoutEvidenceVerifier, runIndependentHoldout, runIndependentHoldoutInContext, type HoldoutDelegateBinding } from '../../src/benchmark/holdout.js'
import { runBenchmark } from '../../src/benchmark/runner.js'
import { benchmarkSchedule } from '../../src/benchmark/schema.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import type { BenchmarkPlan, BenchmarkResult } from '../../src/benchmark/types.js'

const fixture = fileURLToPath(new URL('../fixtures/benchmark-holdout-authority.mjs', import.meta.url))
const publicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA55ozyL4kUIpTYO8ZBLMCldgM6R6Ze1uz9UisLaWMfIc=\n-----END PUBLIC KEY-----\n'
const fixturePrivateKey = createPrivateKey('-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIFJ2wvKo99Cp2NVDEXfLpW/ynV8fu2n3VIK1lQHXMZ3x\n-----END PRIVATE KEY-----\n')
const acceptance = '6a0a077f7aed63449ce206d2fa6dfddc9148f5c187d17fbe13dd36522141e850'
const roots: string[] = []
const providers: HoldoutProviderTransport[] = []
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const versions = { model: sha('model'), prompt: sha('prompt'), skills: sha('skills'), tools: sha('tools'), policy: sha('policy'), runtime: sha('runtime') }
const publicCase = { id: 'private-case', domain: 'research' as const, inputDigest: sha('private question: answer forty-two'), acceptanceDigest: acceptance }
const dataset = { id: 'synthetic-private', version: 'v1', split: 'holdout' as const, digest: acceptanceDigest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases: [publicCase] }) }
const plan = (): BenchmarkPlan => ({ schemaVersion: 1, id: 'holdout-executor', dataset, comparison: 'capability', cases: [publicCase], variants: [
  { id: 'baseline', role: 'baseline', versions, features: { memory: false, planning: false, review: false, growth: false } },
  { id: 'candidate', role: 'candidate', versions, features: { memory: true, planning: false, review: false, growth: false } },
], budget: { durationMs: 2_000, inputTokens: 100, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 7 })

function root(): string { const path = mkdtempSync(join(tmpdir(), 'holdout-executor-')); roots.push(path); return path }
function providerConfig(mode = 'authority'): HoldoutProviderConfig { return {
  executable: process.execPath, args: [fixture], environment: { HOLDOUT_FIXTURE_MODE: mode, LANG: 'C', LC_ALL: 'C' },
  maxLineBytes: 512 * 1024, maxStderrBytes: 1024, readyTimeoutMs: 500, requestTimeoutMs: 500, closeTimeoutMs: 50, killTimeoutMs: 100,
} }
function fixtureProvider(mode = 'authority') { return async (signal?: AbortSignal): Promise<HoldoutProviderTransport> => {
  const provider = await openHoldoutProvider(providerConfig(mode), signal); providers.push(provider); return provider
} }
function resources(currentPlan = plan()) {
  const directory = root(), state = join(directory, 'evidence'); mkdirSync(state, { mode: 0o700 })
  return { plan: currentPlan, store: new BenchmarkStore(join(directory, 'journal.sqlite')),
    evidence: new HoldoutEvidenceStore({ root: state, verifier: createHoldoutEvidenceVerifier(publicKey), create: false }) }
}
const resigned = <T extends object>(value: T): T & { signature: string } => ({ ...value, signature: sign(null, Buffer.from(holdoutUnsignedCanonicalJson(value)), fixturePrivateKey).toString('base64url') })
function delegate(output = '42', override: Partial<HoldoutDelegateBinding> = {}) {
  const close = vi.fn(async () => {})
  const execute = vi.fn(async ({ input }: Parameters<HoldoutDelegateBinding['execute']>[0]) => {
    expect(new TextDecoder().decode(input.bytes)).toBe('private question: answer forty-two')
    return { output: { contentType: 'text/plain; charset=utf-8', bytes: Uint8Array.from(Buffer.from(output)) }, versions,
      metrics: { inputTokens: 10, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: 0, interventions: 0, latencyMs: null },
      executionEvidenceDigest: sha('execution-' + input.bytes.byteLength + '-' + execute.mock.calls.length), quiescent: true }
  })
  return { binding: { execute, close, ...override } as HoldoutDelegateBinding, execute, close }
}
afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.close().catch(() => undefined)))
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('independent holdout runner integration', () => {
  it('runs the signed ordered authority flow, persists only commitments, and verifies a zero-spawn replay', async () => {
    const state = resources(), model = delegate(), openProvider = vi.fn(fixtureProvider()), openDelegate = vi.fn(async () => model.binding)
    const writeFinish = vi.spyOn(state.evidence, 'writeFinish').mockImplementation(function (this: HoldoutEvidenceStore, input) {
      const status = state.store.status(state.plan.id)
      expect(status.results).toHaveLength(benchmarkSchedule(state.plan).length - 1)
      expect(status.runningCell).toEqual(benchmarkSchedule(state.plan).at(-1))
      expect(model.close).toHaveBeenCalledTimes(1)
      return HoldoutEvidenceStore.prototype.writeFinish.call(this, input)
    })
    const first = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })
    expect(first.results).toHaveLength(benchmarkSchedule(state.plan).length)
    expect(first.results.every(result => result.status === 'completed' && result.verdict === 'achieved')).toBe(true)
    expect(first.completion).toBeDefined(); expect(writeFinish).toHaveBeenCalledTimes(1); expect(model.execute).toHaveBeenCalledTimes(first.results.length)
    expect(model.close).toHaveBeenCalledTimes(1); expect(openProvider).toHaveBeenCalledTimes(1)
    const second = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })
    expect(second).toEqual(first); expect(openProvider).toHaveBeenCalledTimes(1); expect(openDelegate).toHaveBeenCalledTimes(1)
    const evidenceText = readdirSync(join(roots.at(-1)!, 'evidence')).filter(name => name.endsWith('.json'))
      .map(name => readFileSync(join(roots.at(-1)!, 'evidence', name), 'utf8')).join('\n')
    expect(evidenceText).not.toContain('private question: answer forty-two'); expect(evidenceText).not.toContain('"42"')
    state.store.close(); state.evidence.close()
  })

  it('fails before provider startup when the operator pin, partial journal, or finish marker differs', async () => {
    const pinned = resources(), openProvider = vi.fn(fixtureProvider()), openDelegate = vi.fn(async () => delegate().binding)
    await expect(runIndependentHoldout({ ...pinned, expectedDataset: { id: dataset.id, version: dataset.version, digest: sha('wrong') },
      pinnedPublicKey: publicKey, openProvider, openDelegate })).rejects.toThrow(/operator-pinned/)
    expect(openProvider).not.toHaveBeenCalled()

    const partial = resources(); partial.store.create(partial.plan)
    const cell = benchmarkSchedule(partial.plan)[0]!, now = Date.now(); partial.store.start(partial.plan.id, cell, now)
    const result: BenchmarkResult = { cell, status: 'unknown', verdict: 'unknown', metrics: { inputTokens: null, outputTokens: null, costUsdMicros: null, toolCalls: null, rework: null, interventions: null, latencyMs: null }, evidenceDigest: null, reason: 'interrupted', startedAt: now, completedAt: now }
    partial.store.finish(partial.plan.id, result)
    const terminal = await runIndependentHoldout({ ...partial, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey, openProvider, openDelegate })
    expect(terminal.results).toEqual([result]); expect(openProvider).not.toHaveBeenCalled()

    const stale = resources(); stale.store.create(stale.plan); stale.store.start(stale.plan.id, benchmarkSchedule(stale.plan)[0]!, Date.now())
    await expect(runIndependentHoldout({ ...stale, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })).rejects.toThrow(/running intent/)
    expect(openProvider).not.toHaveBeenCalled(); expect(openDelegate).not.toHaveBeenCalled()

    const complete = resources()
    await runBenchmark(complete.store, complete.plan, { execute: async request => ({ versions: request.variant.versions, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest, verdict: 'achieved', metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, evidenceDigest: sha('unbacked-' + request.cell.id), quiescent: true }) })
    await expect(runIndependentHoldout({ ...complete, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })).rejects.toThrow(/finish marker/)
    expect(openProvider).not.toHaveBeenCalled(); expect(openDelegate).not.toHaveBeenCalled()
    pinned.store.close(); pinned.evidence.close(); partial.store.close(); partial.evidence.close(); stale.store.close(); stale.evidence.close(); complete.store.close(); complete.evidence.close()
  })

  it('rejects startup manifest failure without creating a cell intent or opening the delegate', async () => {
    const state = resources(), openDelegate = vi.fn(async () => delegate().binding)
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: fixtureProvider('reject'), openDelegate })).rejects.toThrow(/provider-rejected/)
    expect(state.store.status(state.plan.id)).toEqual({ results: [], runningCell: null }); expect(openDelegate).not.toHaveBeenCalled()
    state.store.close(); state.evidence.close()
  })

  it('keeps an openProvider rejection outside the cell journal and never opens the delegate', async () => {
    const state = resources(), openDelegate = vi.fn(async () => delegate().binding), openProvider = vi.fn(async () => { throw new Error('spawn failed') })
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })).rejects.toThrow(/spawn failed/)
    expect(state.store.status(state.plan.id)).toEqual({ results: [], runningCell: null })
    expect(openProvider).toHaveBeenCalledTimes(1); expect(openDelegate).not.toHaveBeenCalled()
    state.store.close(); state.evidence.close()
  })

  it('rejects a completed prefix before spawning provider or delegate', async () => {
    const state = resources(), openProvider = vi.fn(fixtureProvider()), openDelegate = vi.fn(async () => delegate().binding)
    state.store.create(state.plan)
    const cell = benchmarkSchedule(state.plan)[0]!, now = Date.now(); state.store.start(state.plan.id, cell, now)
    state.store.finish(state.plan.id, { cell, status: 'completed', verdict: 'achieved', metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: 1 }, evidenceDigest: sha('prefix'), reason: 'verified', startedAt: now, completedAt: now })
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })).rejects.toThrow(/partial holdout recovery/)
    expect(openProvider).not.toHaveBeenCalled(); expect(openDelegate).not.toHaveBeenCalled()
    state.store.close(); state.evidence.close()
  })

  it('turns provider, identity and quiescence failures into unknown and never schedules a successor', async () => {
    for (const failure of ['provider', 'versions', 'quiescent'] as const) {
      const state = resources(), model = delegate(), wrongVersions = { ...versions, runtime: sha('drift') }
      if (failure === 'versions') model.binding.execute = vi.fn(async () => ({ output: { contentType: 'text/plain', bytes: Uint8Array.from([52, 50]) }, versions: wrongVersions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('execution'), quiescent: true }))
      if (failure === 'quiescent') model.binding.execute = vi.fn(async () => ({ output: { contentType: 'text/plain', bytes: Uint8Array.from([52, 50]) }, versions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('execution'), quiescent: false }))
      const openProvider = failure === 'provider' ? async (signal?: AbortSignal): Promise<HoldoutProviderTransport> => {
        const opened = await fixtureProvider()(signal)
        return { pid: opened.pid, close: () => opened.close(), request: (operation, value, requestSignal) => {
          if (operation === 'input') return Promise.reject(new Error('fixture input failure'))
          return opened.request(operation, value, requestSignal)
        } }
      } : fixtureProvider()
      const output = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey,
        openProvider, openDelegate: async () => model.binding })
      expect(output.results).toHaveLength(1); expect(output.results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', reason: 'adapter-error' })
      expect(output.completion).toBeUndefined(); expect(model.close).toHaveBeenCalledTimes(failure === 'provider' ? 0 : 1)
      state.store.close(); state.evidence.close()
    }
  })

  it('fails a signed input identity drift inside the runner and closes without a successor', async () => {
    const state = resources(), model = delegate(), opened = await fixtureProvider()(), operations: string[] = []
    const provider: HoldoutProviderTransport = { pid: opened.pid, close: () => opened.close(), async request(operation, value, signal) {
      operations.push(operation)
      const response = await opened.request(operation, value, signal)
      if (operation !== 'input') return response
      return { ...(response as object), signature: 'a'.repeat(86) }
    } }
    const output = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => provider, openDelegate: async () => model.binding })
    expect(output.results).toHaveLength(1); expect(output.results[0]).toMatchObject({ status: 'unknown', reason: 'adapter-error' })
    expect(operations).toEqual(['manifest', 'input']); expect(model.execute).not.toHaveBeenCalled(); expect(model.close).not.toHaveBeenCalled()
    state.store.close(); state.evidence.close()
  })

  it('persists a signed unknown verdict as failure evidence and does not finish or run another cell', async () => {
    const state = resources(), model = delegate(), opened = await fixtureProvider()(), operations: string[] = []
    const provider: HoldoutProviderTransport = { pid: opened.pid, close: () => opened.close(), async request(operation, value, signal) {
      operations.push(operation)
      const response = await opened.request(operation, value, signal)
      if (operation !== 'verdict') return response
      const { signature: _signature, ...unsigned } = response as Record<string, unknown> & { signature: string }
      return resigned({ ...unsigned, verdict: 'unknown' })
    } }
    const output = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => provider, openDelegate: async () => model.binding })
    expect(output.results).toHaveLength(1); expect(output.results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', reason: 'adapter-error' })
    expect(output.results[0]!.evidenceDigest).toMatch(/^[a-f0-9]{64}$/u); expect(operations).toEqual(['manifest', 'input', 'verdict'])
    expect(state.evidence.readPlanCompletion(state.plan)).toBeUndefined(); expect(model.execute).toHaveBeenCalledTimes(1)
    state.store.close(); state.evidence.close()
  })

  it('bounds output, zeroes delegate-owned bytes, and awaits close before completing the final cell', async () => {
    const state = resources(), bytes = Uint8Array.from(Buffer.from('42')), close = vi.fn(async () => {}), execute = vi.fn(async () => ({
      output: { contentType: 'text/plain', bytes }, versions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('execution'), quiescent: true,
    }))
    const output = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey,
      openProvider: fixtureProvider(), openDelegate: async () => ({ execute, close }), maxOutputBytes: 8 })
    expect(output.completion).toBeDefined(); expect(close).toHaveBeenCalledTimes(1); expect([...bytes]).toEqual([0, 0])
    state.store.close(); state.evidence.close()
  })

  it('suppresses a late delegate result after timeout and confirms bounded cleanup', async () => {
    const current = plan(); current.budget.durationMs = 20
    const state = resources(current), bytes = Uint8Array.from(Buffer.from('42')), operations: string[] = [], opened = await fixtureProvider()()
    const provider: HoldoutProviderTransport = { pid: opened.pid, close: () => opened.close(), request(operation, value, signal) { operations.push(operation); return opened.request(operation, value, signal) } }
    let release!: () => void
    const close = vi.fn(async () => release())
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); return {
      output: { contentType: 'text/plain', bytes }, versions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('late-execution'), quiescent: true,
    } })
    const output = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => provider, openDelegate: async () => ({ execute, close }), delegateCloseTimeoutMs: 100 })
    expect(output.results).toHaveLength(1); expect(output.results[0]).toMatchObject({ status: 'unknown', reason: 'timeout' })
    expect(operations).toEqual(['manifest', 'input']); expect(close).toHaveBeenCalledTimes(1); expect([...bytes]).toEqual([0, 0])
    expect(state.evidence.readPlanCompletion(state.plan)).toBeUndefined()
    state.store.close(); state.evidence.close()
  })

  it('rejects when delegate cleanup cannot be confirmed within the configured bound', async () => {
    const state = resources(), model = delegate('42', { close: () => new Promise<void>(() => {}) })
    const started = performance.now()
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: fixtureProvider(), openDelegate: async () => model.binding, delegateCloseTimeoutMs: 20 })).rejects.toThrow(/cleanup was not confirmed/)
    expect(performance.now() - started).toBeLessThan(1_000); expect(state.evidence.readPlanCompletion(state.plan)).toBeUndefined()
    const results = state.store.results(state.plan.id); expect(results.at(-1)).toMatchObject({ status: 'unknown', reason: 'adapter-error' })
    state.store.close(); state.evidence.close()
  })

  it('still awaits delegate cleanup when provider close throws synchronously', async () => {
    const state = resources(), opened = await fixtureProvider()(), order: string[] = []
    const provider: HoldoutProviderTransport = { pid: opened.pid, request: (operation, value, signal) => opened.request(operation, value, signal), close() { order.push('provider'); void opened.close(); throw new Error('provider close failed') } }
    const close = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 20)); order.push('delegate') })
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => provider, openDelegate: async () => ({ ...delegate().binding, close }) })).rejects.toThrow(/provider close failed/)
    expect(order).toEqual(['provider', 'delegate']); expect(close).toHaveBeenCalledTimes(1); expect(state.evidence.readPlanCompletion(state.plan)).toBeUndefined()
    state.store.close(); state.evidence.close()
  })

  it('boundedly observes pending execution even when delegate close fails', async () => {
    const current = plan(); current.budget.durationMs = 20
    const state = resources(current), opened = await fixtureProvider()(), finished = vi.fn()
    let release!: () => void
    const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve }); finished(); return {
      output: { contentType: 'text/plain', bytes: Uint8Array.from([52, 50]) }, versions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('late-close-failure'), quiescent: true,
    } })
    const close = vi.fn(async () => { setTimeout(release, 20); throw new Error('delegate close failed') })
    await expect(runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => opened, openDelegate: async () => ({ execute, close }), delegateCloseTimeoutMs: 100 })).rejects.toThrow(/delegate close failed/)
    expect(finished).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1)
    expect(state.evidence.readPlanCompletion(state.plan)).toBeUndefined()
    state.store.close(); state.evidence.close()
  })

  it('never upgrades an unknown journal after the finish marker publication crash window', async () => {
    const state = resources(), model = delegate(), openProvider = vi.fn(fixtureProvider()), openDelegate = vi.fn(async () => model.binding)
    const writeFinish = vi.spyOn(state.evidence, 'writeFinish').mockImplementationOnce(function (this: HoldoutEvidenceStore, input) {
      HoldoutEvidenceStore.prototype.writeFinish.call(this, input)
      throw new Error('simulated crash after marker publication')
    })
    const first = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })
    expect(writeFinish).toHaveBeenCalledTimes(1); expect(first.completion).toBeUndefined()
    expect(first.results).toHaveLength(benchmarkSchedule(state.plan).length)
    expect(first.results.at(-1)).toMatchObject({ status: 'unknown', verdict: 'unknown', reason: 'adapter-error' })
    expect(state.evidence.readPlanCompletion(state.plan)).toBeDefined()
    const second = await runIndependentHoldout({ ...state, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider, openDelegate })
    expect(second).toEqual(first); expect(openProvider).toHaveBeenCalledTimes(1); expect(openDelegate).toHaveBeenCalledTimes(1)
    state.store.close(); state.evidence.close()
  })

  it('binds a pending run to the current Cordis Fiber and awaits abort cleanup on unload', async () => {
    const directory = root(), evidenceRoot = join(directory, 'fiber-evidence'), databasePath = join(directory, 'fiber.sqlite')
    const ctx = new Context()
    let running!: Promise<Readonly<{ results: readonly BenchmarkResult[] }>>
    let release!: () => void
    const close = vi.fn(async () => release())
    const providerClose = vi.fn(async () => {})
    const plugin = (fiberContext: Context): void => {
      running = runIndependentHoldoutInContext(fiberContext, { plan: plan(), databasePath, evidenceRoot,
        expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey,
        openProvider: async signal => {
          const opened = await fixtureProvider()(signal)
          providerClose.mockImplementation(() => opened.close())
          return { pid: opened.pid, request: (operation, value, requestSignal) => opened.request(operation, value, requestSignal), close: providerClose }
        },
        openDelegate: async () => ({ close, async execute() { await new Promise<void>(resolve => { release = resolve }); return {
          output: { contentType: 'text/plain', bytes: Uint8Array.from([52, 50]) }, versions, metrics: { inputTokens: 1, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, executionEvidenceDigest: sha('late-fiber'), quiescent: true,
        } } }), delegateCloseTimeoutMs: 100 })
    }
    const fiber = await ctx.plugin(plugin)
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    await fiber.dispose()
    const settled = await running
    expect(settled.results).toHaveLength(1); expect(settled.results[0]).toMatchObject({ status: 'unknown', reason: 'interrupted' })
    expect(close).toHaveBeenCalledTimes(1); expect(providerClose).toHaveBeenCalledTimes(1)
    expect(() => new BenchmarkStore(databasePath).close()).not.toThrow()
    expect(() => new HoldoutEvidenceStore({ root: evidenceRoot, verifier: createHoldoutEvidenceVerifier(publicKey), create: false }).close()).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('bounds an uncooperative provider startup during Fiber unload and closes a late provider without requests', async () => {
    const directory = root(), evidenceRoot = join(directory, 'late-provider-evidence'), databasePath = join(directory, 'late-provider.sqlite')
    const ctx = new Context(), request = vi.fn(), close = vi.fn(async () => {})
    let resolve!: (provider: HoldoutProviderTransport) => void
    let running!: Promise<Readonly<{ results: readonly BenchmarkResult[] }>>
    const provider: HoldoutProviderTransport = { pid: 1, request, close }
    const fiber = await ctx.plugin((fiberContext: Context) => {
      running = runIndependentHoldoutInContext(fiberContext, { plan: plan(), databasePath, evidenceRoot,
        expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey,
        openProvider: async () => new Promise<HoldoutProviderTransport>(accept => { resolve = accept }),
        openDelegate: async () => delegate().binding, providerTimeoutMs: 20 })
    })
    const started = performance.now()
    await fiber.dispose()
    expect(performance.now() - started).toBeLessThan(1_000)
    await expect(running).rejects.toThrow(/provider startup was not confirmed/)
    resolve(provider)
    await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
    expect(request).not.toHaveBeenCalled()
    expect(() => new BenchmarkStore(databasePath).close()).not.toThrow()
    expect(() => new HoldoutEvidenceStore({ root: evidenceRoot, verifier: createHoldoutEvidenceVerifier(publicKey), create: false }).close()).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('bounds provider startup and does not publish success when provider cleanup fails', async () => {
    const startup = resources(), never = vi.fn(async () => new Promise<HoldoutProviderTransport>(() => {}))
    const started = performance.now()
    await expect(runIndependentHoldout({ ...startup, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: never, openDelegate: async () => delegate().binding, providerTimeoutMs: 20,
    })).rejects.toThrow(/provider startup was not confirmed/)
    expect(performance.now() - started).toBeLessThan(1_000); expect(startup.store.status(startup.plan.id)).toEqual({ results: [], runningCell: null })
    expect(startup.evidence.readPlanCompletion(startup.plan)).toBeUndefined()
    startup.store.close(); startup.evidence.close()

    const closing = resources(), provider: HoldoutProviderTransport = {
      pid: 1, request: async () => new Promise<never>(() => {}), close: async () => { throw new Error('provider close failed') },
    }
    await expect(runIndependentHoldout({ ...closing, expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: publicKey, openProvider: async () => provider, openDelegate: async () => delegate().binding, providerTimeoutMs: 20,
    })).rejects.toThrow(/provider close failed/)
    expect(closing.store.status(closing.plan.id)).toEqual({ results: [], runningCell: null })
    expect(closing.evidence.readPlanCompletion(closing.plan)).toBeUndefined()
    closing.store.close(); closing.evidence.close()
  })

  it('closes Fiber-owned stores and removes its effect after natural completion', async () => {
    const directory = root(), evidenceRoot = join(directory, 'natural-evidence'), databasePath = join(directory, 'natural.sqlite')
    const ctx = new Context(), model = delegate()
    let running!: Promise<Readonly<{ results: readonly BenchmarkResult[] }>>
    const plugin = (fiberContext: Context): void => {
      running = runIndependentHoldoutInContext(fiberContext, { plan: plan(), databasePath, evidenceRoot,
        expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest }, pinnedPublicKey: publicKey,
        openProvider: fixtureProvider(), openDelegate: async () => model.binding })
    }
    const fiber = await ctx.plugin(plugin)
    const output = await running
    expect(output.results.every(result => result.status === 'completed')).toBe(true); expect(model.close).toHaveBeenCalledTimes(1)
    expect(fiber.ctx.fiber.getEffects()).toEqual([])
    expect(() => new BenchmarkStore(databasePath).close()).not.toThrow()
    expect(() => new HoldoutEvidenceStore({ root: evidenceRoot, verifier: createHoldoutEvidenceVerifier(publicKey), create: false }).close()).not.toThrow()
    await fiber.dispose(); await ctx.fiber.dispose()
  })
})
