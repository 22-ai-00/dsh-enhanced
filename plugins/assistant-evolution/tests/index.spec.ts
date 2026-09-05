import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import * as entrypoint from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
}
const bundle = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('dsh-enhanced-assistant-evolution entrypoint', () => {
  test('exports the service contract but not the internal store or guidance builder', () => {
    expect(entrypoint.name).toBe('dsh-enhanced-assistant-evolution')
    expect(entrypoint.version).toBe(manifest.version)
    expect(entrypoint.AssistantEvolutionService).toBeTypeOf('function')
    expect((entrypoint as Record<string, unknown>)['EvolutionStore']).toBeUndefined()
    expect((entrypoint as Record<string, unknown>)['buildGuidance']).toBeUndefined()
  })

  test('declares the policy dependency and bounded private defaults', () => {
    expect(entrypoint.inject).toEqual(['assistantPolicy', 'assistantEvaluation'])
    expect(bundle).toContain("dshHomePath('assistant-evolution/evolution.sqlite')")
    expect(bundle).toContain('- assistantPolicy')
    expect(bundle).toContain('- assistantEvaluation')
    expect(bundle).toContain('- assistantAutomations')
    expect(bundle).toContain('minSample: 5')
    expect(bundle).toContain('maxEvidenceSamples: 8')
    expect(bundle).toContain('maxGuidanceBytes: 4096')
    expect(bundle).toContain('reconcileIntervalMs: 15000')
    expect(bundle).toContain('autonomousRollback: false')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('catalog:')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent']).toBe('>=0.1.2-rc.1 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-policy']).toBe('>=0.1.0 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-evaluation']).toBe('>0.1.7 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-automations']).toBe('>0.1.7 <0.2.0')
  })

  test('loads through apply when assistant-policy is already composed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-entry-'))
    const ctx = new Context()
    try {
      new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
      new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite') })
      entrypoint.apply(ctx, { databasePath: join(root, 'evolution.sqlite'), reconcileIntervalMs: 0 })
      expect(ctx.assistantEvolution).toBeInstanceOf(entrypoint.AssistantEvolutionService)
      // Nothing is learned before an owner approves anything.
      expect(ctx.assistantEvolution.guidance()).toBe('')
    } finally {
      await ctx.fiber.restart()
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('refuses to load without assistant-policy rather than running ungoverned', () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-nopolicy-'))
    const ctx = new Context()
    try {
      expect(() => entrypoint.apply(ctx, { databasePath: join(root, 'evolution.sqlite') }))
        .toThrowError(/assistantPolicy service is required/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a relative database path instead of guessing a location', () => {
    const ctx = new Context()
    const root = mkdtempSync(join(tmpdir(), 'assistant-evolution-relpath-'))
    try {
      new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
      expect(() => entrypoint.apply(ctx, { databasePath: 'relative/evolution.sqlite' }))
        .toThrowError(/absolute/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
