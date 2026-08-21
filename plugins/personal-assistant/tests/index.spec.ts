import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test } from 'vitest'
import { apply, name, version } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dependencies?: Record<string, string>
}
const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

describe('personal-assistant core meta-bundle', () => {
  test('has a stable package entrypoint and exact four core dependencies', () => {
    expect(name).toBe('dsh-enhanced-personal-assistant')
    expect(version).toBe(manifest.version)
    expect(manifest.dependencies).toMatchObject({
      '@dsh-enhanced/assistant-automations': 'workspace:*',
      '@dsh-enhanced/assistant-policy': 'workspace:*',
      '@dsh-enhanced/personal-memory': 'workspace:*',
      '@dsh-enhanced/personal-wiki': 'workspace:*',
    })
  })

  test('mounts one unique meta row and keeps conservative defaults', () => {
    expect([...patch.matchAll(/^\s+- id: (\S+)$/gm)].map(match => match[1]))
      .toEqual(['dsh-enhanced-personal-assistant'])
    expect(patch).toContain("name: '@dsh-enhanced/personal-assistant'")
    expect(patch).toContain('rules: []')
    expect(patch).toContain('budgets: []')
    expect(patch).toContain('schedulerEnabled: false')
    expect(patch).not.toContain('@dsh-enhanced/assistant-delivery')
    expect(patch).not.toContain('@dsh-enhanced/lark-channel')
  })

  test('composes the four public Cordis services in one plugin lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'personal-assistant-meta-'))
    roots.push(root)
    const ctx = new Context()
    await apply(ctx, {
      assistantPolicy: { databasePath: join(root, 'policy.sqlite'), rules: [], budgets: [] },
      personalMemory: { databasePath: join(root, 'memory.sqlite') },
      personalWiki: { vaultRoot: join(root, 'vault'), databasePath: join(root, 'wiki.sqlite') },
      assistantAutomations: { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'),
        schedulerEnabled: false },
    })
    expect(ctx.assistantPolicy.health()).toMatchObject({ emergencyStop: false })
    expect(ctx.personalMemory.health()).toMatchObject({ activeRecords: 0 })
    expect(ctx.personalWiki.health()).toMatchObject({ pages: 0 })
    expect(ctx.assistantAutomations.health()).toMatchObject({ activeAutomations: 0 })
    await ctx.fiber.restart()
  })
})
