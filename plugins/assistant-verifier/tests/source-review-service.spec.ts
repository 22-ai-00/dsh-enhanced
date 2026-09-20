import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, test, vi } from 'vitest'
import { AssistantVerifierService } from '../src/service.ts'
import { SourceReviewRuntime, type SourceReviewConfig } from '../src/source-review.ts'

// Native execution and runtime drain are covered in separate tests; this seam
// verifies the actual pinned Cordis injection/lifecycle of the optional peer set.
vi.mock('../src/source-review.ts', async original => {
  const actual = await original<typeof import('../src/source-review.ts')>()
  return { ...actual, SourceReviewRuntime: vi.fn(function (this: { available: () => boolean; close: () => Promise<void> }) {
    this.available = () => true; this.close = vi.fn(async () => {})
  }) }
})
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.clearAllMocks() })

test('keeps acceptance active while review peers arrive and disposes each reviewer generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'review-service-')), ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  const sourceReviews: SourceReviewConfig = { authorityId: 'review', expiresAt: Date.now() + 60_000, maxReviews: 1,
    repository: root, git: { path: '/usr/bin/git', sha256: 'a'.repeat(64) }, decisionRoot: root, plugins: ['sample'],
    owner: { authorityId: 'route', authorityHash: 'b'.repeat(64), principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'main' },
    reviewerPrincipal: 'reviewer', policy: 'Review correctness.', maxChangedFiles: 3, maxInputBytes: 4096, maxOutputTokens: 512, timeoutMs: 1000 }
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'state.sqlite'), tickIntervalMs: 0, sourceReviews })
  expect(service.trustedVerificationProducerGeneration()).toEqual(expect.any(String))
  expect(service.canReviewSourceRepair({ decisionRoot: root, owner: { ...sourceReviews.owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }, name: 'sample' })).toBe(false)
  const provider = ctx.plugin({ name: 'test-review-peers', apply(peer: Context) {
    for (const name of ['agents', 'sessions', 'tools', 'llm', 'systemPrompt', 'assistantPolicy']) peer.provide(name as never, {} as never)
  } })
  await provider; await new Promise(resolve => setImmediate(resolve))
  expect(service.canReviewSourceRepair({ decisionRoot: root, owner: { ...sourceReviews.owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }, name: 'sample' })).toBe(true)
  expect(SourceReviewRuntime).toHaveBeenCalledTimes(1)
  const runtime = vi.mocked(SourceReviewRuntime).mock.instances[0]!
  await provider.dispose(); await new Promise(resolve => setImmediate(resolve))
  expect(runtime.close).toHaveBeenCalledTimes(1)
  expect(service.canReviewSourceRepair({ decisionRoot: root, owner: { ...sourceReviews.owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }, name: 'sample' })).toBe(false)
  expect(service.trustedVerificationProducerGeneration()).toEqual(expect.any(String))
})
