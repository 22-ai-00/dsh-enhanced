import { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import AssistantEvaluationService, { name, version } from '../src/index.ts'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
}
const contexts: Context[] = []
const roots: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('dsh-enhanced-assistant-evaluation', () => {
  it('exposes stable plugin identity', () => {
    expect(name).toBe('dsh-enhanced-assistant-evaluation')
    expect(version).toBe(manifest.version)
  })

  it('provides and disposes the Cordis service', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-index-'))
    roots.push(root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(AssistantEvaluationService, { databasePath: join(root, 'evaluation.sqlite') })
    const service = ctx.assistantEvaluation
    expect(service.health()).toMatchObject({
      ready: true, schemaVersion: 7, outcomes: 0, taskProjections: 0, pendingProjections: 0,
    })
    await ctx.fiber.restart()
    expect(() => service.health()).toThrowError(/disposed/i)
    contexts.splice(contexts.indexOf(ctx), 1)
  })
})
