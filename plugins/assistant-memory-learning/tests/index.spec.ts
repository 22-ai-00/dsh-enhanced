import { Context } from '@deepseek-ai/cordis'
import { growthObjectDigest } from '@dsh-ray/assistant-growth-contract'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import plugin, { Config, DEFAULT_LEARNING_OPERATIONAL_CONFIG, AssistantMemoryLearningService, name, version, validateLearningConfig } from '../src/index.ts'
import { MemoryLearningRuntime } from '../src/runtime.ts'
import type { LearningConfig } from '../src/types.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const bundlePatch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

function allPorts() {
  const methods = ['inspectOwnerRouteState', 'inspectSystemOwnedRetirement', 'retireSystemOwned', 'onSchedulerWake', 'validateOwnerRoute', 'listOwnerForegroundTaskSources', 'inspectOwnerForegroundTaskSource',
    'withOwnerForegroundTaskSourcesFence', 'inspectOwnerForegroundLearningTask', 'canonicalHostScope',
    'listTrustedTaskLearningProjections', 'withTrustedCanonicalScopeWriterFence', 'getTrustedForegroundLearningProjection',
    'inspectTrustedTaskOwnerRevision', 'registerHostExecutor', 'reconcileSystem', 'inspectSystemOwnedActivation', 'inspectSystemOwned',
    'listLearningTargets', 'inspectLearningAdoptionAvailability', 'lookupLearningAdoption', 'adoptReviewedLearning',
    'inspectMemoryLearningReviewAvailability', 'reviewMemoryLearning', 'lookupMemoryLearningReview', 'evaluate', 'authorize']
  return Object.fromEntries(methods.map(key => [key, vi.fn()]))
}

describe('dsh-ray-assistant-memory-learning', () => {
  it('exposes stable plugin identity and active-by-default bundle patch', () => {
    expect(name).toBe('dsh-ray-assistant-memory-learning')
    expect(version).toBe(manifest.version)
    expect(bundlePatch).toContain("name: '@dsh-ray/assistant-memory-learning'")
    expect(bundlePatch).not.toContain('disabled: true')
  })

  it('validates authority and budgets synchronously before acquiring resources', () => {
    const result = Config['~standard'].validate({ databasePath: '/tmp/invalid.sqlite' })
    expect(result).not.toBeInstanceOf(Promise)
    expect(result).toHaveProperty('issues')
    expect(plugin.inject).toEqual(AssistantMemoryLearningService.inject)
    expect(plugin.Config).toBe(Config)
    expect(() => validateLearningConfig({})).toThrow(/configuration/)
  })

  it('streamlines owner-bound setup with bounded operational defaults while preserving 19-field config digest', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-learning-defaults-')))
    try {
      const minimal = {
        databasePath: join(root, 'learning.sqlite'),
        authorityId: 'extraction-grant',
        owner: {
          authorityId: 'delivery-owner',
          authorityHash: 'a'.repeat(64),
          principalId: 'lark/bot/tenant/owner',
          principalRecordId: 'principal',
          principalVersion: 1,
          workspace: root,
          agentPreset: 'primary',
        },
        expiresAt: Date.now() + 60_000,
        budgetId: 'learning',
        scanBudgetId: 'scan',
        reviewAuthorityId: 'review',
        reviewAuthorityDigest: 'b'.repeat(64),
        adoptionAuthorityId: 'adopt',
        adoptionGrantDigest: 'c'.repeat(64),
      }
      const normalized = validateLearningConfig(minimal)
      expect(normalized).toEqual({ ...minimal, ...DEFAULT_LEARNING_OPERATIONAL_CONFIG })
      expect(validateLearningConfig({ ...normalized, enabled: true })).toEqual(normalized)
      expect(growthObjectDigest(validateLearningConfig({ ...normalized, enabled: false }))).toBe(growthObjectDigest(normalized))
      expect(() => validateLearningConfig({ ...minimal, maxExtractions: 0 })).toThrow(/bound/)
      expect(() => validateLearningConfig({ ...minimal, extraKey: true })).toThrow(/configuration/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('mounts cleanly in awaiting-owner-binding or explicit opt-out states without opening SQLite or registering automations', async () => {
    const ctx = new Context()
    const port = allPorts()
    const start = vi.spyOn(MemoryLearningRuntime.prototype, 'start').mockImplementation(() => {})
    try {
      for (const key of plugin.inject) ctx.provide(key as never, port as never)

      const dormant = ctx.plugin(plugin, {})
      await dormant
      expect(start).not.toHaveBeenCalled()
      expect(port.registerHostExecutor).not.toHaveBeenCalled()
      expect(port.reconcileSystem).not.toHaveBeenCalled()
      expect(ctx.assistantMemoryLearning.health()).toEqual({
        enabled: true,
        configured: false,
        connected: false,
        lastScanAt: null,
        lastError: null,
        counts: { pending: 0, queued: 0, running: 0, unknown: 0, adopted: 0, rejected: 0, noop: 0, failed: 0, superseded: 0 },
        remainingExtractions: 0,
        available: false,
      })
      await dormant.dispose()

      const disabled = ctx.plugin(plugin, { enabled: false })
      await disabled
      expect(start).not.toHaveBeenCalled()
      expect(port.registerHostExecutor).not.toHaveBeenCalled()
      expect(ctx.assistantMemoryLearning.health()).toMatchObject({
        enabled: false,
        configured: false,
        connected: false,
        available: false,
        remainingExtractions: 0,
      })
      await disabled.dispose()

      const undef = Config['~standard'].validate(undefined)
      expect(undef).toEqual({ value: { enabled: true, configured: false, workItemExperiences: true } })
    } finally {
      await ctx.fiber.restart()
      vi.restoreAllMocks()
    }
  })

  it('mounted default waits for peers and owns runtime disposal when a provider disappears', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-learning-entry-'))), ctx = new Context()
    const config: LearningConfig = { databasePath: join(root, 'learning.sqlite'), authorityId: 'extraction-grant',
      owner: { authorityId: 'delivery-owner', authorityHash: 'a'.repeat(64), principalId: 'lark/bot/tenant/owner',
        principalRecordId: 'principal', principalVersion: 1, workspace: root, agentPreset: 'primary' },
      expiresAt: Date.now() + 60_000, maxExtractions: 2, maxPending: 2, lookbackMs: 60_000,
      policy: 'Retain explicit owner statements.', maxInputBytes: 32_768, maxOutputTokens: 512, timeoutMs: 1000,
      budgetId: 'learning', budgetAmount: 1, scanBudgetId: 'scan', scanBudgetAmount: 1,
      reviewAuthorityId: 'review', reviewAuthorityDigest: 'b'.repeat(64), adoptionAuthorityId: 'adopt', adoptionGrantDigest: 'c'.repeat(64) }
    const port = allPorts()
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
