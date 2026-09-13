import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { access, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HoldoutProviderError, openHoldoutProvider, type HoldoutProviderConfig, type HoldoutProviderTransport } from '../../src/benchmark/holdout-provider.js'
import { holdoutEnvelopeDigest, parseSignedHoldoutFinish, parseSignedHoldoutInput, parseSignedHoldoutManifest, parseSignedHoldoutVerdict } from '../../src/benchmark/holdout-protocol.js'
import { benchmarkPlanDigest, benchmarkSchedule } from '../../src/benchmark/schema.js'
import type { BenchmarkPlan } from '../../src/benchmark/types.js'

const fixture = fileURLToPath(new URL('../fixtures/benchmark-holdout-authority.mjs', import.meta.url))
const providerSource = fileURLToPath(new URL('../../src/benchmark/holdout-provider.ts', import.meta.url))
const authorityPublicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA55ozyL4kUIpTYO8ZBLMCldgM6R6Ze1uz9UisLaWMfIc=\n-----END PUBLIC KEY-----\n'
const authorityAcceptanceDigest = '6a0a077f7aed63449ce206d2fa6dfddc9148f5c187d17fbe13dd36522141e850'
const providers: HoldoutProviderTransport[] = []

afterEach(async () => { await Promise.all(providers.splice(0).map(provider => provider.close().catch(() => undefined))) })

function config(mode = 'echo', override: Partial<HoldoutProviderConfig> = {}): HoldoutProviderConfig {
  // A real Node authority starts under concurrent package tests; dedicated timeout cases override this normal startup bound to 20ms.
  return { executable: process.execPath, args: [fixture], environment: { HOLDOUT_FIXTURE_MODE: mode, LANG: 'C', LC_ALL: 'C' }, maxLineBytes: 1024, maxStderrBytes: 1024, readyTimeoutMs: 2_000, requestTimeoutMs: 200, closeTimeoutMs: 30, killTimeoutMs: 100, ...override }
}
async function open(mode = 'echo', override: Partial<HoldoutProviderConfig> = {}, signal?: AbortSignal): Promise<HoldoutProviderTransport> {
  const provider = await openHoldoutProvider(config(mode, override), signal); providers.push(provider); return provider
}
function code(error: unknown, expected: HoldoutProviderError['code']): boolean { expect(error).toMatchObject({ code: expected }); return true }
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
async function killOwnedFixtureProcess(pid: number): Promise<void> {
  try { process.kill(pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  const deadline = Date.now() + 250
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
      throw error
    }
    await new Promise<void>(resolveWait => setTimeout(resolveWait, 10))
  }
}
async function runStandalone(script: string): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  return await new Promise(resolveRun => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    child.once('close', code => { clearTimeout(timeout); resolveRun({ code, stdout, stderr }) })
  })
}
async function waitForFixtureFile(path: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    try { await access(path); return } catch { await new Promise<void>(resolveWait => setTimeout(resolveWait, 5)) }
  }
  throw new Error('fixture control handshake timed out')
}

describe('holdout child provider transport', () => {
  it('does not spawn at import time and requires explicit open', async () => {
    await access(fixture)
    await expect(openHoldoutProvider({ ...config(), executable: 'node' })).rejects.toSatisfy((error: unknown) => code(error, 'invalid-config'))
  })

  it('settles an asynchronous spawn failure without an unhandled child error', async () => {
    const missing = fileURLToPath(new URL('../fixtures/missing-holdout-authority', import.meta.url))
    await expect(openHoldoutProvider({ ...config(), executable: missing })).rejects.toSatisfy((error: unknown) => code(error, 'spawn-failed'))
  })

  it('rejects a custom cwd and always uses the fixed root working directory', async () => {
    await expect(openHoldoutProvider({ ...config(), cwd: '/tmp' } as HoldoutProviderConfig)).rejects.toSatisfy((error: unknown) => code(error, 'invalid-config'))
    const provider = await open('echo')
    await expect(provider.request('manifest', {})).resolves.toMatchObject({ operation: 'manifest', cwd: '/' })
  })

  it('accepts fragmented UTF-8 NDJSON and exposes only the explicit child environment', async () => {
    const provider = await open('fragment')
    await expect(provider.request('manifest', { text: '雪' })).resolves.toEqual({ operation: 'manifest', echo: { text: '雪' }, envKeys: [
      'HOLDOUT_FIXTURE_MODE',
      'LANG',
      'LC_ALL',
      ...(process.platform === 'darwin' ? ['__CF_USER_TEXT_ENCODING'] : []),
    ].sort(), cwd: '/' })
  })

  it('enforces one inflight request without poisoning the first request', async () => {
    const provider = await open('fragment')
    const first = provider.request('input', { id: 1 })
    await expect(provider.request('verdict', { id: 2 })).rejects.toSatisfy((error: unknown) => code(error, 'busy'))
    await expect(first).resolves.toMatchObject({ operation: 'input', echo: { id: 1 } })
    await expect(provider.request('finish', { done: true })).resolves.toMatchObject({ operation: 'finish' })
  })

  it('uses unpredictable request ids so a provider cannot preinject the next response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holdout-preinject-'))
    await chmod(root, 0o700)
    const acknowledged = join(root, 'acknowledged'), injected = join(root, 'injected')
    let provider: HoldoutProviderTransport | undefined
    try {
      provider = await open('predict-next-id', { environment: { HOLDOUT_FIXTURE_MODE: 'predict-next-id', LANG: 'C', LC_ALL: 'C', HOLDOUT_FIXTURE_ACKNOWLEDGED_PATH: acknowledged, HOLDOUT_FIXTURE_INJECTED_PATH: injected } })
      await expect(provider.request('manifest', {})).resolves.toMatchObject({ operation: 'manifest' })
      await writeFile(acknowledged, 'received\n', { mode: 0o600 })
      await waitForFixtureFile(injected)
      // A frame that arrives before this random id is known must never settle it.
      await expect(provider.request('input', {})).rejects.toSatisfy((error: unknown) => {
        expect(['closed', 'protocol-error']).toContain((error as HoldoutProviderError).code); return true
      })
      await expect(provider.request('finish', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
    } finally {
      await provider?.close().catch(() => undefined)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('poisons on unsolicited partial bytes after ready and before a request', async () => {
    const provider = await open('ready-unsolicited-partial')
    await new Promise(resolve => setTimeout(resolve, 30))
    await expect(provider.request('manifest', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it('carries signed ordered evidence without transporting oracle material', async () => {
    const provider = await open('authority', { maxLineBytes: 512 * 1024 })
    const publicCase = { id: 'private-case', domain: 'research' as const, inputDigest: sha('private question: answer forty-two'), acceptanceDigest: authorityAcceptanceDigest }
    const dataset = { id: 'synthetic-private', version: 'v1', digest: acceptanceDigest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases: [publicCase] }), split: 'holdout' as const }
    const manifest = parseSignedHoldoutManifest(await provider.request('manifest', { expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest } }), authorityPublicKey)
    const hash = 'a'.repeat(64)
    const plan: BenchmarkPlan = { schemaVersion: 1, id: 'holdout-plan', dataset, comparison: 'capability', cases: manifest.cases, variants: [
      { id: 'baseline', role: 'baseline', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: false, planning: false, review: false, growth: false } },
      { id: 'candidate', role: 'candidate', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: true, planning: false, review: false, growth: false } },
    ], budget: { durationMs: 1_000, inputTokens: 100, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 7 }
    const planDigest = benchmarkPlanDigest(plan), cells = benchmarkSchedule(plan), verdictDigests: string[] = []
    for (const cell of cells) {
      const input = parseSignedHoldoutInput(await provider.request('input', { plan, cell }), manifest, planDigest, cell, authorityPublicKey)
      expect(input).not.toHaveProperty('acceptanceDigest')
      const output = Buffer.from('42'), outputDigest = sha(output)
      const verdict = parseSignedHoldoutVerdict(await provider.request('verdict', { planDigest, cell, inputEnvelopeDigest: holdoutEnvelopeDigest(input), output: { contentType: 'text/plain; charset=utf-8', outputBase64url: output.toString('base64url'), outputDigest } }), manifest, planDigest, cell, outputDigest, authorityPublicKey)
      expect(verdict.verdict).toBe('achieved'); verdictDigests.push(holdoutEnvelopeDigest(verdict))
    }
    const finish = parseSignedHoldoutFinish(await provider.request('finish', { planDigest, cells, verdictEnvelopeDigests: verdictDigests }), manifest, planDigest, cells, verdictDigests, authorityPublicKey)
    expect(finish).toMatchObject({ complete: true, cellCount: cells.length })
  })

  it('permanently rejects skipped and replayed private cells', async () => {
    const publicCase = { id: 'private-case', domain: 'research' as const, inputDigest: sha('private question: answer forty-two'), acceptanceDigest: authorityAcceptanceDigest }
    const dataset = { id: 'synthetic-private', version: 'v1', digest: acceptanceDigest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases: [publicCase] }), split: 'holdout' as const }, hash = 'b'.repeat(64)
    const plan: BenchmarkPlan = { schemaVersion: 1, id: 'ordered-plan', dataset, comparison: 'capability', cases: [publicCase], variants: [
      { id: 'baseline', role: 'baseline', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: false, planning: false, review: false, growth: false } },
      { id: 'candidate', role: 'candidate', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: true, planning: false, review: false, growth: false } },
    ], budget: { durationMs: 1_000, inputTokens: 100, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 7 }
    const cells = benchmarkSchedule(plan), provider = await open('authority', { maxLineBytes: 512 * 1024 })
    await provider.request('manifest', { expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest } })
    await expect(provider.request('input', { plan, cell: cells[1] })).rejects.toSatisfy((error: unknown) => code(error, 'provider-rejected'))
    await expect(provider.request('input', { plan, cell: cells[0] })).rejects.toSatisfy((error: unknown) => code(error, 'closed'))

    const replay = await open('authority', { maxLineBytes: 512 * 1024 })
    const manifest = parseSignedHoldoutManifest(await replay.request('manifest', { expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest } }), authorityPublicKey)
    const planDigest = benchmarkPlanDigest(plan), input = parseSignedHoldoutInput(await replay.request('input', { plan, cell: cells[0] }), manifest, planDigest, cells[0]!, authorityPublicKey)
    const output = Buffer.from('42'), outputDigest = sha(output)
    await replay.request('verdict', { planDigest, cell: cells[0], inputEnvelopeDigest: holdoutEnvelopeDigest(input), output: { contentType: 'text/plain; charset=utf-8', outputBase64url: output.toString('base64url'), outputDigest } })
    await expect(replay.request('input', { plan, cell: cells[0] })).rejects.toSatisfy((error: unknown) => code(error, 'provider-rejected'))
  })

  it('poisons after an authority rejects the first cell input', async () => {
    const provider = await open('authority-reject-input', { maxLineBytes: 512 * 1024 })
    const publicCase = { id: 'private-case', domain: 'research' as const, inputDigest: sha('private question: answer forty-two'), acceptanceDigest: authorityAcceptanceDigest }
    const dataset = { id: 'synthetic-private', version: 'v1', digest: acceptanceDigest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases: [publicCase] }), split: 'holdout' as const }
    const hash = 'c'.repeat(64), plan: BenchmarkPlan = { schemaVersion: 1, id: 'reject-plan', dataset, comparison: 'capability', cases: [publicCase], variants: [
      { id: 'baseline', role: 'baseline', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: false, planning: false, review: false, growth: false } },
      { id: 'candidate', role: 'candidate', versions: { model: hash, prompt: hash, skills: hash, tools: hash, policy: hash, runtime: hash }, features: { memory: true, planning: false, review: false, growth: false } },
    ], budget: { durationMs: 1_000, inputTokens: 100, outputTokens: 100, costUsdMicros: null, toolCalls: 0 }, repeats: 2, seed: 8 }
    await provider.request('manifest', { expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest } })
    await expect(provider.request('input', { plan, cell: benchmarkSchedule(plan)[0] })).rejects.toSatisfy((error: unknown) => code(error, 'provider-rejected'))
    await expect(provider.request('input', { plan, cell: benchmarkSchedule(plan)[0] })).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it.each([
    ['wrong-id', 'protocol-error'], ['extra-field', 'protocol-error'], ['invalid-utf8', 'protocol-error'], ['extra-line', 'protocol-error'], ['response-partial', 'protocol-error'],
  ] as const)('poisons the channel for %s output', async (mode, expected) => {
    const provider = await open(mode)
    await expect(provider.request('manifest', {})).rejects.toSatisfy((error: unknown) => code(error, expected))
    await expect(provider.request('manifest', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it('rejects oversized stdout and stderr during opening without leaking output', async () => {
    for (const [mode, expected, override] of [
      ['oversize-line', 'line-too-large', { maxLineBytes: 256 }],
      ['oversize-stderr', 'stderr-too-large', { maxStderrBytes: 8 }],
    ] as const) await expect(openHoldoutProvider(config(mode, override))).rejects.toSatisfy((error: unknown) => code(error, expected))
  })

  it('rejects a ready line followed by a partial injected frame', async () => {
    await expect(openHoldoutProvider(config('ready-partial'))).rejects.toSatisfy((error: unknown) => code(error, 'protocol-error'))
  })

  it('does not expose stderr contents in errors', async () => {
    await expect(openHoldoutProvider(config('stderr-secret', { maxStderrBytes: 1 }))).rejects.toSatisfy((error: unknown) => { expect(String(error)).not.toContain('secret fixture'); return code(error, 'stderr-too-large') })
  })

  it('enforces ready and request deadlines and permanently poisons the channel', async () => {
    await expect(openHoldoutProvider(config('no-ready', { readyTimeoutMs: 20 }))).rejects.toSatisfy((error: unknown) => code(error, 'ready-timeout'))
    const provider = await open('hang', { requestTimeoutMs: 20 })
    await expect(provider.request('input', {})).rejects.toSatisfy((error: unknown) => code(error, 'request-timeout'))
    await expect(provider.request('finish', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it.skipIf(process.platform === 'win32')('surfaces an unconfirmed startup cleanup instead of the ready deadline', async () => {
    const originalKill = process.kill
    let groupPid: number | undefined
    const kill = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      if (pid < 0) groupPid = -pid
      return true
    }) as typeof process.kill)
    try {
      await expect(openHoldoutProvider(config('no-ready', { readyTimeoutMs: 20, closeTimeoutMs: 20, killTimeoutMs: 20 })))
        .rejects.toSatisfy((error: unknown) => code(error, 'termination-unconfirmed'))
    } finally {
      kill.mockRestore()
      if (groupPid !== undefined) { try { originalKill(-groupPid, 'SIGKILL') } catch { /* child already exited */ } }
    }
  })

  it('poisons on request and parent abort', async () => {
    const requestProvider = await open('hang'), requestAbort = new AbortController()
    const request = requestProvider.request('input', {}, requestAbort.signal); requestAbort.abort(new Error('sensitive reason'))
    await expect(request).rejects.toSatisfy((error: unknown) => { expect(String(error)).not.toContain('sensitive reason'); return code(error, 'aborted') })
    const parentAbort = new AbortController(), parentProvider = await open('hang', {}, parentAbort.signal)
    const pending = parentProvider.request('input', {}); parentAbort.abort()
    await expect(pending).rejects.toSatisfy((error: unknown) => code(error, 'aborted'))
  })

  it('does not write when request serialization synchronously aborts the signal', async () => {
    const provider = await open('echo'), controller = new AbortController()
    const value = { toJSON() { controller.abort(); return { sensitive: false } } }
    await expect(provider.request('input', value, controller.signal)).rejects.toSatisfy((error: unknown) => code(error, 'aborted'))
    await expect(provider.request('manifest', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it('reserves inflight ownership before caller serialization can reenter request', async () => {
    const provider = await open('echo')
    let nested: Promise<unknown> | undefined, nestedHandled: Promise<unknown> | undefined
    const value = { toJSON() { nested = provider.request('verdict', {}); nestedHandled = nested.catch(error => error); return { safe: true } } }
    await expect(provider.request('input', value)).resolves.toMatchObject({ operation: 'input', echo: { safe: true } })
    expect(await nestedHandled).toMatchObject({ code: 'busy' })
    expect(nested).toBeDefined()
    await expect(provider.request('finish', {})).resolves.toMatchObject({ operation: 'finish' })
  })

  it('sends a close hint, escalates TERM to KILL, awaits exit, and is idempotent', async () => {
    const provider = await open('ignore-term', { closeTimeoutMs: 20, killTimeoutMs: 100 })
    const first = provider.close(), second = provider.close()
    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    await expect(provider.request('manifest', {})).rejects.toSatisfy((error: unknown) => code(error, 'closed'))
  })

  it.skipIf(process.platform === 'win32')('terminates a descendant after its provider leader accepts close', async () => {
    const provider = await open('orphan-descendant', { closeTimeoutMs: 20, killTimeoutMs: 100 })
    let descendantPid: number | undefined
    try {
      const response = await provider.request('manifest', {}) as { descendantPid: number }
      const pid = response.descendantPid
      descendantPid = pid
      expect(pid).toBeTypeOf('number')
      await expect(provider.close()).resolves.toBeUndefined()
      await vi.waitFor(() => {
        try { process.kill(pid, 0); throw new Error('descendant remains') }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
      })
    } finally {
      if (descendantPid !== undefined) await killOwnedFixtureProcess(descendantPid)
    }
  })

  it.skipIf(process.platform === 'win32')('keeps standalone top-level await alive until group cleanup settles', async () => {
    const script = `import ts from 'typescript'; import { readFileSync } from 'node:fs';
const source = readFileSync(${JSON.stringify(providerSource)}, 'utf8');
const transformed = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { openHoldoutProvider } = await import('data:text/javascript;base64,' + Buffer.from(transformed).toString('base64'));
const provider = await openHoldoutProvider({ executable: process.execPath, args: [${JSON.stringify(fixture)}], environment: { HOLDOUT_FIXTURE_MODE: 'orphan-descendant', LANG: 'C', LC_ALL: 'C' }, maxLineBytes: 1024, maxStderrBytes: 1024, readyTimeoutMs: 2_000, requestTimeoutMs: 200, closeTimeoutMs: 20, killTimeoutMs: 100 });
console.log('PROVIDER_PID=' + provider.pid); const value = await provider.request('manifest', {}); console.log('DESCENDANT_PID=' + value.descendantPid); await provider.close(); console.log('CLOSE_SETTLED');`
    let output = ''
    try {
      const result = await runStandalone(script)
      output = result.stdout
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('CLOSE_SETTLED')
    } finally {
      const providerPid = Number(/^PROVIDER_PID=(\d+)$/mu.exec(output)?.[1])
      const descendantPid = Number(/^DESCENDANT_PID=(\d+)$/mu.exec(output)?.[1])
      if (Number.isSafeInteger(providerPid) && providerPid > 0) { try { process.kill(-providerPid, 'SIGKILL') } catch { /* group already exited */ } }
      if (Number.isSafeInteger(descendantPid) && descendantPid > 0) await killOwnedFixtureProcess(descendantPid)
    }
  }, 10_000)
})
