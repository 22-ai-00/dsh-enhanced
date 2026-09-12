import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { afterEach, describe, expect, it } from 'vitest'
import { HoldoutEvidenceStore } from '../../src/benchmark/holdout-evidence.js'
import { createHoldoutEvidenceVerifier, runIndependentHoldout, type HoldoutDelegateBinding, type HoldoutDelegateRequest } from '../../src/benchmark/holdout.js'
import { openHoldoutProvider, type HoldoutProviderConfig, type HoldoutProviderTransport } from '../../src/benchmark/holdout-provider.js'
import { holdoutEnvelopeDigest } from '../../src/benchmark/holdout-protocol.js'
import { benchmarkPlanDigest, benchmarkSchedule } from '../../src/benchmark/schema.js'
import { BenchmarkStore } from '../../src/benchmark/store.js'
import { benchmarkReport } from '../../src/benchmark/report.js'
import type { BenchmarkPlan, BenchmarkResult, BenchmarkVersions } from '../../src/benchmark/types.js'

const fixture = fileURLToPath(new URL('../fixtures/benchmark-holdout-authority.mjs', import.meta.url))
const authorityPublicKey = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA55ozyL4kUIpTYO8ZBLMCldgM6R6Ze1uz9UisLaWMfIc=\n-----END PUBLIC KEY-----\n'
const authorityAcceptanceDigest = '6a0a077f7aed63449ce206d2fa6dfddc9148f5c187d17fbe13dd36522141e850'
const privateInputText = 'private question: answer forty-two'
const rawOracle = '42'
const roots: string[] = []
const providers: HoldoutProviderTransport[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.close().catch(() => undefined)))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function sha(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holdout-process-'))
  roots.push(root)
  await chmod(root, 0o700)
  return root
}

const publicCase = Object.freeze({
  id: 'private-case',
  domain: 'research' as const,
  inputDigest: sha(privateInputText),
  acceptanceDigest: authorityAcceptanceDigest,
})
const dataset = Object.freeze({
  id: 'synthetic-private',
  version: 'v1',
  split: 'holdout' as const,
  digest: acceptanceDigest({ id: 'synthetic-private', version: 'v1', split: 'holdout', cases: [publicCase] }),
})
const versions = (tag: string): BenchmarkVersions => {
  const model = sha('shared-model')
  const value = sha(tag)
  return { model, prompt: value, skills: value, tools: value, policy: value, runtime: value }
}

function plan(id = 'holdout-process-plan'): BenchmarkPlan {
  return {
    schemaVersion: 1,
    id,
    dataset,
    comparison: 'capability',
    cases: [publicCase],
    variants: [
      { id: 'baseline', role: 'baseline', versions: versions('baseline'), features: { memory: false, planning: false, review: false, growth: false } },
      { id: 'candidate', role: 'candidate', versions: versions('candidate'), features: { memory: true, planning: false, review: false, growth: false } },
    ],
    budget: { durationMs: 10_000, inputTokens: 100, outputTokens: 100, costUsdMicros: null, toolCalls: 0 },
    repeats: 2,
    seed: 7,
  }
}

function providerConfig(mode = 'authority'): HoldoutProviderConfig {
  return {
    executable: process.execPath,
    args: [fixture],
    environment: { HOLDOUT_FIXTURE_MODE: mode, LANG: 'C', LC_ALL: 'C' },
    maxLineBytes: 512 * 1024,
    maxStderrBytes: 1024,
    readyTimeoutMs: 500,
    requestTimeoutMs: 1_000,
    closeTimeoutMs: 100,
    killTimeoutMs: 500,
  }
}

async function openAuthority(stats: { providerSpawns: number }, signal?: AbortSignal): Promise<HoldoutProviderTransport> {
  stats.providerSpawns++
  const provider = await openHoldoutProvider(providerConfig(), signal)
  providers.push(provider)
  return provider
}

function delegate(stats: { delegateSpawns: number; delegateCalls: number }, options: { abort?: AbortController } = {}): HoldoutDelegateBinding {
  stats.delegateSpawns++
  return {
    async execute(request: HoldoutDelegateRequest) {
      stats.delegateCalls++
      if (options.abort) {
        queueMicrotask(() => options.abort!.abort())
        await new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
      }
      const text = request.variant.id === 'candidate' ? rawOracle : 'wrong'
      const bytes = Buffer.from(text)
      return {
        output: { contentType: 'text/plain; charset=utf-8', bytes: Uint8Array.from(bytes) },
        versions: request.variant.versions,
        metrics: { inputTokens: 10, outputTokens: 1, costUsdMicros: null, toolCalls: 0, rework: 0, interventions: 0, latencyMs: null },
        executionEvidenceDigest: sha(`delegate-${request.cell.id}`),
        quiescent: true,
      }
    },
    close() {},
  }
}

function assertNoRawHoldoutMaterial(value: unknown): void {
  const visit = (entry: unknown): void => {
    if (typeof entry === 'string') {
      expect(entry).not.toBe(rawOracle)
      expect(entry).not.toContain(privateInputText)
      return
    }
    if (entry === null || typeof entry !== 'object') return
    for (const [key, child] of Object.entries(entry)) {
      expect(key).not.toBe('inputBase64url')
      expect(key).not.toBe('outputBase64url')
      visit(child)
    }
  }
  visit(value)
}

async function readEvidenceObjects(root: string): Promise<unknown[]> {
  const names = (await readdir(root)).filter(name => name.endsWith('.json')).sort()
  return await Promise.all(names.map(async name => JSON.parse(await readFile(join(root, name), 'utf8')) as unknown))
}

describe('independent holdout process integration', () => {
  it('runs a synthetic same-UID authority child for 1 case x 2 arms x 2 repeats, then reopens without spawning authority or delegate', async () => {
    const root = await privateRoot()
    const journalPath = join(root, 'journal.sqlite')
    const evidenceRoot = join(root, 'evidence')
    const currentPlan = plan()
    const expectedCells = benchmarkSchedule(currentPlan)
    const stats = { providerSpawns: 0, delegateSpawns: 0, delegateCalls: 0 }

    // The fixture is a synthetic child owned by the same OS user as the test process.
    // It validates process transport and signed holdout evidence, not Unix user separation.
    const store = new BenchmarkStore(journalPath)
    const evidence = new HoldoutEvidenceStore({ root: evidenceRoot, verifier: createHoldoutEvidenceVerifier(authorityPublicKey) })
    const first = await runIndependentHoldout({
      store,
      evidence,
      plan: currentPlan,
      expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: authorityPublicKey,
      openProvider: signal => openAuthority(stats, signal),
      openDelegate: () => delegate(stats),
    })
    expect(first.results.map(result => result.cell)).toEqual(expectedCells)
    expect(first.results).toHaveLength(4)
    expect(first.results.every(result => result.status === 'completed' && result.reason === 'verified')).toBe(true)
    expect(first.results.filter(result => result.cell.variantId === 'baseline').map(result => result.verdict)).toEqual(['not-achieved', 'not-achieved'])
    expect(first.results.filter(result => result.cell.variantId === 'candidate').map(result => result.verdict)).toEqual(['achieved', 'achieved'])
    expect(stats).toEqual({ providerSpawns: 1, delegateSpawns: 1, delegateCalls: 4 })

    for (const result of first.results) {
      expect(result.evidenceDigest).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/u))
      const verdict = evidence.readVerdict(currentPlan, result.cell, result.evidenceDigest!)
      expect(verdict.receiptDigest).toBe(holdoutEnvelopeDigest(verdict.envelope))
      expect(verdict.envelope.verdict).toBe(result.verdict)
      expect(verdict.envelope.kind).toBe('verdict')
      expect(verdict.host.outputDigest).toBe(verdict.envelope.outputDigest)
      expect(verdict.host.executionEvidenceDigest).toBe(sha(`delegate-${result.cell.id}`))
    }
    const completion = evidence.readPlanCompletion(currentPlan)
    expect(completion).toMatchObject({ planDigest: benchmarkPlanDigest(currentPlan), verdictEvidenceDigests: first.results.map(result => result.evidenceDigest) })
    const finish = evidence.readFinish(currentPlan, completion!.finishEvidenceDigest)
    expect(finish.receiptDigest).toBe(holdoutEnvelopeDigest(finish.envelope))
    expect(evidence.verifyRun(currentPlan, first.results).completion).toEqual(completion)

    const report = benchmarkReport(currentPlan, first.results)
    expect(report).toMatchObject({
      complete: true,
      expectedCells: 4,
      recordedCells: 4,
      promotionAuthorized: false,
      variants: [
        expect.objectContaining({ id: 'baseline', expected: 2, recorded: 2, achieved: 0, notAchieved: 2, unknown: 0 }),
        expect.objectContaining({ id: 'candidate', expected: 2, recorded: 2, achieved: 2, notAchieved: 0, unknown: 0 }),
      ],
    })
    for (const object of await readEvidenceObjects(evidenceRoot)) assertNoRawHoldoutMaterial(object)
    assertNoRawHoldoutMaterial(report)
    evidence.close()
    store.close()

    const reopenedStore = new BenchmarkStore(journalPath)
    const reopenedEvidence = new HoldoutEvidenceStore({ root: evidenceRoot, verifier: createHoldoutEvidenceVerifier(authorityPublicKey), create: false })
    const reopenStats = { providerSpawns: 0, delegateSpawns: 0, delegateCalls: 0 }
    const reopened = await runIndependentHoldout({
      store: reopenedStore,
      evidence: reopenedEvidence,
      plan: currentPlan,
      expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: authorityPublicKey,
      openProvider: () => { reopenStats.providerSpawns++; throw new Error('completed journal must not spawn authority') },
      openDelegate: () => { reopenStats.delegateSpawns++; throw new Error('completed journal must not spawn delegate') },
    })
    expect(reopened.results).toEqual(first.results)
    expect(reopened.completion).toEqual(completion)
    expect(reopenStats).toEqual({ providerSpawns: 0, delegateSpawns: 0, delegateCalls: 0 })
    expect(reopenedEvidence.verifyRun(currentPlan, reopened.results).completion).toEqual(completion)
    reopenedEvidence.close()
    reopenedStore.close()
  }, 20_000)

  it('records one unknown and stops scheduling when the synthetic same-UID authority run is aborted during the first cell', async () => {
    const root = await privateRoot()
    const currentPlan = plan('holdout-process-abort')
    const stats = { providerSpawns: 0, delegateSpawns: 0, delegateCalls: 0 }
    const controller = new AbortController()
    const store = new BenchmarkStore(join(root, 'journal.sqlite'))
    const evidence = new HoldoutEvidenceStore({ root: join(root, 'evidence'), verifier: createHoldoutEvidenceVerifier(authorityPublicKey) })
    const result = await runIndependentHoldout({
      store,
      evidence,
      plan: currentPlan,
      expectedDataset: { id: dataset.id, version: dataset.version, digest: dataset.digest },
      pinnedPublicKey: authorityPublicKey,
      openProvider: signal => openAuthority(stats, signal),
      openDelegate: () => delegate(stats, { abort: controller }),
      signal: controller.signal,
    })
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ status: 'unknown', verdict: 'unknown', evidenceDigest: null })
    expect(['interrupted', 'adapter-error']).toContain(result.results[0]!.reason)
    expect(result.completion).toBeUndefined()
    expect(stats).toEqual({ providerSpawns: 1, delegateSpawns: 1, delegateCalls: 1 })
    expect(store.status(currentPlan.id)).toMatchObject({ runningCell: null, results: [expect.objectContaining({ status: 'unknown' })] })
    expect(() => evidence.verifyRun(currentPlan, result.results as BenchmarkResult[])).toThrow()
    evidence.close()
    store.close()
  }, 20_000)
})
