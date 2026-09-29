import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryReviewRuntime, validateMemoryReviewConfig, type MemoryReviewConfig } from '../src/memory-review.ts'
import { runNativeMemoryReview } from '../src/memory-review-native.ts'

vi.mock('../src/memory-review-native.ts', () => ({ runNativeMemoryReview: vi.fn() }))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.resetAllMocks() })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-review-runtime-')))
  const owner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'lark/app/tenant/owner',
    principalRecordId: 'principal:1', principalVersion: 1, workspace: root, agentPreset: 'assistant' }
  const request: MemoryLearningReviewRequest = { protocol: 'memory-learning-review/v1', operationId: 'operation:1',
    extractionSessionId: 'extract:1', owner, source: { inboxId: 'inbox:1', sourceDigest: 'b'.repeat(64), contentDigest: 'c'.repeat(64) },
    mutation: { op: 'add', entry: { kind: 'fact', content: 'The owner says the project uses pnpm.' } },
    evidenceQuote: 'The project uses pnpm.' }
  const config: MemoryReviewConfig = { authorityId: 'memory-review-grant', owner, expiresAt: Date.now() + 60_000,
    maxReviews: 1, policy: 'Preserve attributed owner statements.', maxInputBytes: 32768, maxOutputTokens: 512, timeoutMs: 10_000 }
  const content = { contentDigest: request.source.contentDigest,
    input: { text: 'The project uses pnpm.', truncated: false }, reply: { text: 'I used npm.', truncated: false },
    source: { execution: { modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } } }
  const projection = { version: 1, digest: 'd'.repeat(64), disposition: 'upsert' as 'upsert' | 'retract' }
  const task = { owner, judgement: 'owner-feedback', source: { inboxId: 'inbox:1', quiescent: true },
    canonical: { projection, objective: { status: 'not-achieved' } }, ownerRevision: { action: 'initial' },
    feedback: { text: 'You used npm, but this project uses pnpm.', truncated: false } }
  const target = { id: 'memory:1', version: 1, managed: true, kind: 'fact', content: 'The project uses npm.' }
  let deliveryLocked = false
  const delivery = {
    readOwnerForegroundTaskSource: vi.fn(() => { if (deliveryLocked) throw new Error('nested Delivery reader'); return content }),
    withOwnerForegroundTaskSourceFence: vi.fn((_input: unknown, callback: (source: typeof content) => unknown) => {
      if (deliveryLocked) throw new Error('nested Delivery fence')
      deliveryLocked = true
      try { return callback(content) } finally { deliveryLocked = false }
    }),
    inspectOwnerForegroundLearningTask: vi.fn(() => task),
  }
  const evaluation = { canonicalHostScope: vi.fn((scope: unknown) => scope),
    getTrustedForegroundLearningProjection: vi.fn(() => ({ projection, triggerOutcomeId: 'outcome:1' })),
    inspectTrustedTaskOwnerRevision: vi.fn(() => task.ownerRevision),
    listTrustedTaskLearningProjections: vi.fn(() => ({ scopeWatermark: 1 })),
    withTrustedCanonicalScopeWriterFence: vi.fn((_input: unknown, callback: () => unknown) => {
      expect(deliveryLocked).toBe(true)
      return { matched: true, value: callback() }
    }),
  }
  const policy = { evaluate: vi.fn(() => ({ effect: 'allow' })), authorize: vi.fn(() => ({ effect: 'allow' })) }
  const memory = { inspectLearningTarget: vi.fn(() => target) }
  const services: Record<string, unknown> = { assistantDelivery: delivery, assistantEvaluation: evaluation,
    assistantPolicy: policy, personalMemory: memory }
  // Ports are explicit test doubles; native Agent behavior is tested separately.
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  const runtimes: MemoryReviewRuntime[] = []
  const open = (override: Partial<MemoryReviewConfig> = {}) => {
    const runtime = new MemoryReviewRuntime(ctx, { ...config, ...override }, join(root, 'verifier.sqlite'))
    runtimes.push(runtime); return runtime
  }
  cleanups.push(async () => { for (const runtime of runtimes) await runtime.close(); await rm(root, { recursive: true, force: true }) })
  vi.mocked(runNativeMemoryReview).mockResolvedValue({ status: 'approved', reason: 'The owner explicitly states this.', outputDigest: 'e'.repeat(64) })
  return { root, owner, request, config, content, projection, task, target, delivery, evaluation, policy, memory, open }
}

test('rereads original source and freezes its model; lookup and restart replay cannot dispatch again', async () => {
  const f = await fixture(), runtime = f.open()
  expect(runtime.lookup(f.request)).toBeUndefined()
  expect(f.policy.authorize).not.toHaveBeenCalled()
  const receipt = await runtime.run(f.request)
  expect(receipt.status).toBe('approved')
  expect(receipt.model).toEqual(f.content.source.execution.modelSelection)
  expect(f.delivery.readOwnerForegroundTaskSource).toHaveBeenCalledWith(expect.objectContaining({
    inboxId: 'inbox:1', expectedSourceDigest: f.request.source.sourceDigest,
    expectedOwner: { authorityHash: f.owner.authorityHash, principalRecordId: f.owner.principalRecordId, principalVersion: 1 },
  }))
  expect(vi.mocked(runNativeMemoryReview).mock.calls[0]![1].source).toEqual({ ownerStatement: f.content.input.text, assistantReply: f.content.reply.text })
  expect(runtime.lookup(f.request)).toEqual(receipt)
  await runtime.close()
  expect(await f.open().run(f.request)).toEqual(receipt)
  expect(runNativeMemoryReview).toHaveBeenCalledTimes(1)
  expect(f.policy.authorize).toHaveBeenCalledTimes(1)
})

test('lost model outcomes remain unknown across restart and exhaust the finite grant', async () => {
  const f = await fixture(), runtime = f.open()
  vi.mocked(runNativeMemoryReview).mockRejectedValue(new Error('lost model result'))
  expect((await runtime.run(f.request)).status).toBe('unknown')
  await runtime.close()
  const restarted = f.open()
  expect((await restarted.run(f.request)).status).toBe('unknown')
  expect(restarted.lookup(f.request)?.status).toBe('unknown')
  await expect(restarted.run({ ...f.request, operationId: 'operation:2' })).rejects.toThrow('quota')
  expect(runNativeMemoryReview).toHaveBeenCalledTimes(1)
})

test.each(['quote', 'digest', 'truncated', 'withdrawn', 'owner', 'policy'] as const)('rejects %s changes before dispatch', async mode => {
  const f = await fixture()
  if (mode === 'quote') f.request.evidenceQuote = 'unrelated statement'
  if (mode === 'digest') f.content.contentDigest = 'f'.repeat(64)
  if (mode === 'truncated') f.content.input.truncated = true
  if (mode === 'withdrawn') f.task.ownerRevision.action = 'withdraw'
  if (mode === 'owner') f.request.owner = { ...f.owner, principalVersion: 2 }
  if (mode === 'policy') f.policy.evaluate.mockReturnValue({ effect: 'deny' })
  await expect(f.open().run(f.request)).rejects.toThrow()
  expect(runNativeMemoryReview).not.toHaveBeenCalled()
})

test('accepts failure experience only with an exact authenticated canonical outcome', async () => {
  const f = await fixture()
  f.request.mutation = { op: 'add', entry: { kind: 'experience', content: 'Use the project package manager before installing.' } }
  f.request.source.canonical = { outcomeId: 'outcome:1', version: f.projection.version, digest: f.projection.digest, objectiveStatus: 'not-achieved' }
  const runtime = f.open()
  expect((await runtime.run(f.request)).status).toBe('approved')
  expect(vi.mocked(runNativeMemoryReview).mock.calls[0]![1].source.objectiveStatus).toBe('not-achieved')
  f.task.canonical.objective.status = 'achieved'
  expect(() => runtime.lookup(f.request)).toThrow('outcome changed')
  f.task.canonical.objective.status = 'not-achieved'
  f.projection.version++
  expect(() => runtime.lookup(f.request)).toThrow('outcome changed')
})

test('independently reads the exact managed target for removal and fences changes during review', async () => {
  const f = await fixture()
  f.content.input.text = 'Forget the project package manager.'; f.request.evidenceQuote = f.content.input.text
  f.request.mutation = { op: 'remove', id: f.target.id, expectedVersion: f.target.version }
  const runtime = f.open()
  f.target.managed = false
  await expect(runtime.run(f.request)).rejects.toThrow('managed version')
  f.target.managed = true
  vi.mocked(runNativeMemoryReview).mockImplementation(async (_ctx, input) => {
    expect(input.target).toMatchObject({ id: f.target.id, version: 1, content: f.target.content })
    f.target.version++
    return { status: 'approved', reason: 'Owner requested removal.', outputDigest: 'e'.repeat(64) }
  })
  expect((await runtime.run(f.request)).status).toBe('unknown')
})

test('a source withdrawn during generation never becomes an approved durable receipt', async () => {
  const f = await fixture(), runtime = f.open()
  vi.mocked(runNativeMemoryReview).mockImplementation(async () => {
    f.task.ownerRevision.action = 'withdraw'
    return { status: 'approved', reason: 'stale', outputDigest: 'e'.repeat(64) }
  })
  expect((await runtime.run(f.request)).status).toBe('unknown')
  expect(() => runtime.lookup(f.request)).toThrow('withdrawn')
  f.task.ownerRevision.action = 'initial'
  expect(runtime.lookup(f.request)?.status).toBe('unknown')
})

test('an unresolved task objective does not prevent learning an explicit owner fact', async () => {
  const f = await fixture()
  f.projection.disposition = 'retract'
  f.task.canonical.objective.status = 'unknown'
  expect((await f.open().run(f.request)).status).toBe('approved')
})

test('two live connections cannot repeat a pending model admission; close aborts and drains it', async () => {
  const f = await fixture(), first = f.open(), second = f.open()
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  vi.mocked(runNativeMemoryReview).mockImplementation(async (_ctx, input) => {
    started()
    await new Promise<void>(resolve => input.signal.addEventListener('abort', () => resolve(), { once: true }))
    throw new Error('cancelled')
  })
  const pending = first.run(f.request)
  await ready
  expect((await second.run(f.request)).status).toBe('unknown')
  await first.close()
  expect((await pending).status).toBe('unknown')
  expect(runNativeMemoryReview).toHaveBeenCalledTimes(1)
  expect(() => first.run(f.request)).toThrow('disposed')
})

test('configuration and explicit model overrides are immutable across review restart', async () => {
  const f = await fixture()
  expect(() => validateMemoryReviewConfig({ ...f.config, maxReviews: 0 })).toThrow('bound')
  const runtime = f.open({ model: { provider: 'supplier', model: 'fixed-review' } })
  expect((await runtime.run(f.request)).model.model).toBe('fixed-review')
  await runtime.close()
  await expect(f.open().run(f.request)).rejects.toThrow('differs')
  await expect(f.open({ expiresAt: 1 }).run(f.request)).rejects.toThrow('expired')
})
