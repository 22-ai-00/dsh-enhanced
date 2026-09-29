import { Context } from '@deepseek-ai/cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import plugin, { Config, AssistantMemoryLearningService, name, version, validateLearningConfig } from '../src/index.ts'
import { MemoryLearningRuntime } from '../src/runtime.ts'
import type { LearningConfig } from '../src/types.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}

describe('dsh-enhanced-assistant-memory-learning', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-memory-learning')
    expect(version).toBe(manifest.version)
  })

  it('validates authority and budgets synchronously before acquiring resources', () => {
    const result = Config['~standard'].validate({ databasePath: '/tmp/invalid.sqlite' })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toHaveProperty('issues')
    expect(plugin.inject).toEqual(AssistantMemoryLearningService.inject)
    expect(plugin.Config).toBe(Config)
    expect(() => validateLearningConfig({})).toThrow(/configuration/)
  })

  it('mounted default waits for peers and owns runtime disposal when a provider disappears', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memory-learning-entry-')), ctx = new Context()
    const config: LearningConfig = { databasePath: join(root, 'learning.sqlite'), authorityId: 'extraction-grant',
      owner: { authorityId: 'delivery-owner', authorityHash: 'a'.repeat(64), principalId: 'lark/bot/tenant/owner',
        principalRecordId: 'principal', principalVersion: 1, workspace: root, agentPreset: 'primary' },
      expiresAt: Date.now() + 60_000, maxExtractions: 2, maxPending: 2, lookbackMs: 60_000,
      policy: 'Retain explicit owner statements.', maxInputBytes: 32_768, maxOutputTokens: 512, timeoutMs: 1000,
      budgetId: 'learning', budgetAmount: 1, scanBudgetId: 'scan', scanBudgetAmount: 1,
      reviewAuthorityId: 'review', reviewAuthorityDigest: 'b'.repeat(64), adoptionAuthorityId: 'adopt', adoptionGrantDigest: 'c'.repeat(64) }
    const methods = ['validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource',
      'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask', 'canonicalHostScope',
      'listTrustedTaskLearningProjections', 'withTrustedCanonicalScopeWriterFence', 'getTrustedForegroundLearningProjection',
      'inspectTrustedTaskOwnerRevision', 'registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned',
      'listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning',
      'inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview', 'evaluate', 'authorize']
    const port = Object.fromEntries(methods.map(key => [key, vi.fn()]))
    // This test isolates the mounted Cordis lifecycle. Dispatch is exercised
    // independently against real Automations in runtime.spec.ts.
    const start = vi.spyOn(MemoryLearningRuntime.prototype, 'start').mockImplementation(() => {})
    const close = vi.spyOn(MemoryLearningRuntime.prototype, 'close')
    try {
      for (const key of plugin.inject.filter(key => key !== 'assistantVerifier')) ctx.provide(key as never, port as never)
      const fiber = ctx.plugin(plugin, config)
      await fiber
      expect(existsSync(config.databasePath)).toBe(false)
      expect(start).not.toHaveBeenCalled()
      const provider = ctx.plugin({ apply(providerCtx: Context) { providerCtx.provide('assistantVerifier', port as never) } })
      await provider; await fiber.await()
      expect(start).toHaveBeenCalledOnce()
      expect(existsSync(config.databasePath)).toBe(true)
      await provider.dispose(); await fiber.await()
      expect(close).toHaveBeenCalledOnce()
      expect(ctx.get('assistantMemoryLearning')).toBeUndefined()
    } finally {
      await ctx.fiber.restart(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true })
    }
  })
})
