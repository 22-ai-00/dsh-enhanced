import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import * as entrypoint from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies: Record<string, string>
  peerDependencies: Record<string, string>
  peerDependenciesMeta: Record<string, { optional?: boolean }>
  devDependencies: Record<string, string>
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

  test('ships bounded private defaults and verified rc.1 peers', () => {
    expect(bundle).toContain("dshHomePath('personal-memory/memory.sqlite')")
    expect(bundle).toContain('snapshotMaxTokens: 2048')
    expect(bundle).toContain('maxImportRecords: 100')
    expect(bundle).toContain('- assistantPolicy')
    expect(manifest.dependencies['@deepseek-ai/schemastery']).toBe('catalog:')
    expect(manifest.peerDependencies['@deepseek-ai/dsh-agent']).toBe('>=0.1.2-rc.1 <0.2.0')
    expect(manifest.peerDependencies['@dsh-enhanced/assistant-policy']).toBe('>=0.1.0 <0.2.0')
    expect(manifest.dependencies['@dsh-enhanced/assistant-growth-contract']).toBe('workspace:*')
    expect(manifest.peerDependencies).not.toHaveProperty('@dsh-enhanced/preference-learning')
    expect(manifest.peerDependenciesMeta).not.toHaveProperty('@dsh-enhanced/preference-learning')
    expect(manifest.devDependencies).not.toHaveProperty('@dsh-enhanced/preference-learning')
  })

  test('loads the built package root when preference-learning is unavailable', () => {
    const loader = [
      'export async function resolve(specifier, context, nextResolve) {',
      "  if (specifier === '@dsh-enhanced/preference-learning') {",
      "    const error = new Error('blocked optional peer')",
      "    error.code = 'ERR_MODULE_NOT_FOUND'",
      '    throw error',
      '  }',
      '  return nextResolve(specifier, context)',
      '}',
    ].join('\n')
    const probe = [
      "const entrypoint = await import('@dsh-enhanced/personal-memory')",
      "if (entrypoint.name !== 'dsh-enhanced-personal-memory') process.exit(2)",
      "if (typeof entrypoint.PersonalMemoryService !== 'function') process.exit(3)",
    ].join('\n')
    const result = spawnSync(process.execPath, [
      '--no-warnings',
      '--experimental-loader',
      `data:text/javascript,${encodeURIComponent(loader)}`,
      '--input-type=module',
      '--eval',
      probe,
    ], {
      cwd: fileURLToPath(new URL('../../..', import.meta.url)),
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
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
