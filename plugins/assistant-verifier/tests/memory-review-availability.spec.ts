import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { MemoryReviewRuntime, type MemoryReviewConfig } from '../src/memory-review.ts'
import { SourceReviewStore } from '../src/source-review-store.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

test('availability is a current owner and Policy read of the durable finite grant', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'memory-review-availability-')))
  const owner = { authorityId: 'owner-route', authorityHash: 'a'.repeat(64), principalId: 'lark/app/tenant/owner',
    principalRecordId: 'principal:1', principalVersion: 1, workspace: root, agentPreset: 'assistant' }
  const config: MemoryReviewConfig = { authorityId: 'memory-review-grant', owner, expiresAt: Date.now() + 60_000,
    maxReviews: 2, policy: 'Preserve owner statements.', maxInputBytes: 8192, maxOutputTokens: 512, timeoutMs: 1000 }
  const dbPath = join(root, 'verifier.sqlite')
  const current = { ...owner }
  const delivery = { validateOwnerRoute: vi.fn(() => current) }
  const evaluation = { canonicalHostScope: vi.fn((scope: unknown) => scope) }
  const policy = { evaluate: vi.fn(() => ({ effect: 'allow' })) }
  const services: Record<string, unknown> = { assistantDelivery: delivery, assistantEvaluation: evaluation, assistantPolicy: policy }
  const ctx = { get: (name: string) => services[name] } as unknown as Context
  const runtimes: MemoryReviewRuntime[] = []
  const open = (overrides: Partial<MemoryReviewConfig> = {}) => {
    const runtime = new MemoryReviewRuntime(ctx, { ...config, ...overrides }, dbPath)
    runtimes.push(runtime)
    return runtime
  }
  cleanups.push(async () => { for (const runtime of runtimes) await runtime.close(); await rm(root, { recursive: true, force: true }) })
  const runtime = open()
  const ledgerPath = dbPath + '.memory-reviews'
  const db = new DatabaseSync(ledgerPath)
  const counts = () => ({ grants: (db.prepare('SELECT count(*) AS n FROM grants').get() as { n: number }).n,
    reviews: (db.prepare('SELECT count(*) AS n FROM reviews').get() as { n: number }).n })
  try {
    expect(runtime.inspectAvailability({ owner })).toMatchObject({ authorityId: config.authorityId,
      authorityDigest: acceptanceDigest(config), expiresAt: config.expiresAt, remainingReviews: 2, available: true })
    expect(counts()).toEqual({ grants: 0, reviews: 0 })
    expect(policy.evaluate).toHaveBeenCalledTimes(1)
    expect(runtime.inspectAvailability({ owner: { ...owner, principalVersion: 2 } }).available).toBe(false)
    current.principalVersion = 2
    expect(runtime.inspectAvailability({ owner }).available).toBe(false)
    current.principalVersion = 1
    policy.evaluate.mockReturnValueOnce({ effect: 'deny' })
    expect(runtime.inspectAvailability({ owner }).available).toBe(false)
    delete services.assistantPolicy
    expect(runtime.inspectAvailability({ owner }).available).toBe(false)
    services.assistantPolicy = policy
    delete services.assistantDelivery
    expect(runtime.inspectAvailability({ owner }).available).toBe(false)
    services.assistantDelivery = delivery
    expect(counts()).toEqual({ grants: 0, reviews: 0 })

    const store = new SourceReviewStore(ledgerPath)
    try {
      const grant = { authorityId: config.authorityId, authorityDigest: acceptanceDigest(config), maxReviews: config.maxReviews }
      for (const operationId of ['review:1', 'review:2']) {
        expect(store.claim({ ...grant, operationId, requestDigest: 'b'.repeat(64),
          model: { provider: 'supplier', model: 'task-model' } }).state).toBe('claimed')
      }
      expect(runtime.inspectAvailability({ owner })).toMatchObject({ remainingReviews: 0, available: false })
      expect(open({ maxReviews: 3 }).inspectAvailability({ owner })).toMatchObject({ remainingReviews: 0, available: false })
      expect(open({ expiresAt: Date.now() - 1 }).inspectAvailability({ owner })).toMatchObject({ remainingReviews: 0, available: false })
      expect(counts()).toEqual({ grants: 1, reviews: 2 })
      // Unknown claims have no terminal result and must not be dispatched by this probe.
      expect(store.inspect({ ...grant, operationId: 'review:1', requestDigest: 'b'.repeat(64),
        model: { provider: 'supplier', model: 'task-model' } })).toEqual({ state: 'unknown' })
      db.prepare('UPDATE grants SET used=? WHERE authority=?').run(1, config.authorityId)
      expect(runtime.inspectAvailability({ owner })).toMatchObject({ remainingReviews: 0, available: false })
      db.prepare('UPDATE grants SET used=? WHERE authority=?').run(2, config.authorityId)
      db.prepare('UPDATE grants SET max=? WHERE authority=?').run(-1, config.authorityId)
      expect(runtime.inspectAvailability({ owner })).toMatchObject({ remainingReviews: 0, available: false })
    } finally { store.close() }
  } finally { db.close() }
})
