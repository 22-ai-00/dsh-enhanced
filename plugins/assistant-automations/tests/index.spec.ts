import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
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

describe('dsh-enhanced-assistant-automations', () => {
  test('exports the public service/types but not mutable store or runner internals', () => {
    expect(entrypoint.name).toBe('dsh-enhanced-assistant-automations')
    expect(entrypoint.version).toBe(manifest.version)
    expect(entrypoint.AssistantAutomationsService).toBeTypeOf('function')
    expect((entrypoint as Record<string, unknown>)['AutomationStore']).toBeUndefined()
    expect((entrypoint as Record<string, unknown>)['AutomationCoordinator']).toBeUndefined()
    expect((entrypoint as Record<string, unknown>)['AutomationProposalManager']).toBeUndefined()
  })

  test('ships disabled private defaults and verified rc.8 peers', () => {
    expect(bundle).toContain("dshHomePath('assistant-automations/state.sqlite')")
    expect(bundle).toContain("dshHomePath('assistant-automations/runs')")
    expect(bundle).toContain('- assistantPolicy')
    expect(bundle).toContain('schedulerEnabled: false')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('catalog:')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent']).toBe('>=0.1.0-rc.8 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-policy']).toBe('>=0.1.0 <0.2.0')
  })

  test('loads through apply when assistant-policy is already composed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'assistant-automations-entry-'))
    const ctx = new Context()
    try {
      new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
      entrypoint.apply(ctx, {
        databasePath: join(root, 'automations.sqlite'),
        runsPath: join(root, 'runs'),
        schedulerEnabled: false,
      })
      expect(ctx.assistantAutomations).toBeDefined()
      await ctx.fiber.restart()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
