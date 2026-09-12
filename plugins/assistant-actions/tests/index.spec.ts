import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import plugin, { apply, name, version } from '../src/index.ts'

test('publishes a stable bundle and disposes its actual empty-grant Host service', async () => {
  expect(plugin.name).toBe(name)
  expect(name).toBe('dsh-enhanced-assistant-actions')
  expect(version).toBe(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  const root = await mkdtemp(join(tmpdir(), 'actions-index-')); const ctx = new Context()
  try {
    apply(ctx, { stateRoot: root })
    expect(ctx.get('assistantActions', false)).toBeUndefined()
    const disposeKeychain = ctx.provide('credentialsKeychain' as never, {} as never)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.assistantActions).toBeDefined()
    await disposeKeychain()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('assistantActions', false)).toBeUndefined()
  }
  finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
