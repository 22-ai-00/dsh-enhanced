import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { MemoryLearningReviewRequest } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantVerifierService } from '../src/service.ts'
import { MemoryReviewRuntime, type MemoryReviewConfig } from '../src/memory-review.ts'

vi.mock('../src/memory-review.ts', async original => {
  const actual = await original<typeof import('../src/memory-review.ts')>()
  return { ...actual, MemoryReviewRuntime: vi.fn(function (this: {
    run: () => Promise<unknown>; lookup: () => undefined; close: () => Promise<void>
  }) {
    this.run = vi.fn(async () => ({ status: 'approved' })); this.lookup = vi.fn(() => undefined)
    this.close = vi.fn(async () => {})
  }) }
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks() })

test('waits for authenticated source services and drains each reviewer when its Cordis peers disappear', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-review-service-'))), ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const memoryReviews: MemoryReviewConfig = { authorityId: 'review', expiresAt: Date.now() + 60_000, maxReviews: 1,
    owner: { authorityId: 'route', authorityHash: 'b'.repeat(64), principalId: 'lark/app/tenant/owner',
      principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'main' },
    policy: 'Preserve attributed owner statements.', maxInputBytes: 8192, maxOutputTokens: 512, timeoutMs: 1000 }
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'state.sqlite'), tickIntervalMs: 0, memoryReviews })
  // Runtime/source validation has separate tests; this checks the service seam.
  const request = {} as MemoryLearningReviewRequest
  expect(service.lookupMemoryLearningReview(request)).toBeUndefined()
  expect(() => service.reviewMemoryLearning(request)).toThrow('unavailable')
  const native = ctx.plugin({ name: 'test-memory-review-native-peers', apply(peer: Context) {
    for (const name of ['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy']) peer.provide(name as never, {} as never)
  } })
  await native; await new Promise(resolve => setImmediate(resolve))
  expect(MemoryReviewRuntime).not.toHaveBeenCalled()
  const sources = ctx.plugin({ name: 'test-memory-review-source-peers', apply(peer: Context) {
    for (const name of ['assistantDelivery', 'assistantEvaluation']) peer.provide(name as never, {} as never)
  } })
  await sources; await new Promise(resolve => setImmediate(resolve))
  expect(MemoryReviewRuntime).toHaveBeenCalledTimes(1)
  expect(await service.reviewMemoryLearning(request)).toEqual({ status: 'approved' })
  const runtime = vi.mocked(MemoryReviewRuntime).mock.instances[0]!
  await sources.dispose(); await new Promise(resolve => setImmediate(resolve))
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(service.lookupMemoryLearningReview(request)).toBeUndefined()
  expect(() => service.reviewMemoryLearning(request)).toThrow('unavailable')
  expect(service.trustedVerificationProducerGeneration()).toEqual(expect.any(String))
})
