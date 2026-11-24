import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import PreferenceLearningService, { Config, name, preferenceCatalog, version } from '../src/index.ts'
import { preferenceSchemaVersion } from '../src/sqlite.ts'

const roots: string[] = []
const contexts: Context[] = []
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dsh-enhanced-preference-learning', () => {
  test('exposes stable plugin identity and a fixed four-tier catalog', () => {
    expect(name).toBe('dsh-enhanced-preference-learning')
    expect(version).toBe(manifest.version)
    expect(new Set(Object.values(preferenceCatalog).map(entry => entry.riskTier)))
      .toEqual(new Set(['T0', 'T1', 'T2', 'T3']))
    expect(Object.isFrozen(preferenceCatalog)).toBe(true)
  })

  test('provides and disposes the Cordis service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'preference-learning-index-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite') })
    await ctx.plugin(PreferenceLearningService, { databasePath: join(root, 'preferences.sqlite') })
    const service = ctx.assistantPreferenceLearning
    expect(service.health()).toMatchObject({ ready: true, enabled: true, schemaVersion: preferenceSchemaVersion })
    await ctx.fiber.restart()
    expect(() => service.health()).toThrowError(/disposed/i)
    contexts.splice(contexts.indexOf(ctx), 1)
  })

  test('defaults enabled and autonomousT1Enabled to true in Config and bundle patch while honoring explicit opt-outs', () => {
    const defaulted = Config({ databasePath: '/unused/preferences.sqlite' })
    expect(defaulted).toMatchObject({
      enabled: true,
      autonomousT1Enabled: true,
      minSignalsForActivation: 2,
      minBehavioralSignalsForActivation: 6,
      minConfidenceBps: 7500,
      maxContradictionBps: 2500,
      maxActiveOverlays: 6,
      maxReviewHypotheses: 20,
      maxOverlayBytes: 2048,
      maintenanceIntervalMs: 3_600_000,
      maintenanceBatchSize: 500,
      promotionReconcileLimit: 50,
    })
    expect(bundle).toContain('enabled: true')
    expect(bundle).toContain('autonomousT1Enabled: true')
    expect(Config({ databasePath: '/unused/preferences.sqlite', enabled: false }).enabled).toBe(false)
    expect(Config({ databasePath: '/unused/preferences.sqlite', autonomousT1Enabled: false }).autonomousT1Enabled).toBe(false)
  })
})
