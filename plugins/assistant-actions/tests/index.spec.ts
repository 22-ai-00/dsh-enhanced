import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { apply, name, version } from '../src/index.ts'

test('publishes a stable bundle and disposes its actual empty-grant Host service', async () => {
  expect(name).toBe('dsh-enhanced-assistant-actions')
  expect(version).toBe(JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version)
  const root = await mkdtemp(join(tmpdir(), 'actions-index-')); const ctx = new Context()
  try { apply(ctx, { stateRoot: root }); expect(ctx.assistantActions).toBeDefined() }
  finally { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
