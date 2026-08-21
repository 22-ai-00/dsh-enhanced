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

describe('dsh-enhanced-personal-memory entrypoint', () => {
  test('exports the service contract but not the internal store or proposal manager', () => {
    expect(entrypoint.name).toBe('dsh-enhanced-personal-memory')
    expect(entrypoint.version).toBe(manifest.version)
    expect(entrypoint.PersonalMemoryService).toBeTypeOf('function')
    expect((entrypoint as Record<string, unknown>)['MemoryStore']).toBeUndefined()
    expect((entrypoint as Record<string, unknown>)['MemoryProposalManager']).toBeUndefined()
  })

  test('ships bounded private defaults and verified rc.8 peers', () => {
    expect(bundle).toContain("dshHomePath('personal-memory/memory.sqlite')")
    expect(bundle).toContain('snapshotMaxTokens: 2048')
    expect(bundle).toContain('maxImportRecords: 100')
    expect(bundle).toContain('- assistantPolicy')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('catalog:')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent']).toBe('>=0.1.0-rc.8 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-policy']).toBe('>=0.1.0 <0.2.0')
  })

  test('loads through apply when assistant-policy is already composed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'personal-memory-entry-'))
    const ctx = new Context()
    try {
      new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'), rules: [] })
      entrypoint.apply(ctx, { databasePath: join(root, 'memory.sqlite') })
      expect(ctx.personalMemory).toBeDefined()
      await ctx.fiber.restart()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
