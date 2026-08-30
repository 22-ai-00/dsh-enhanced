import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { AssistantEvaluationError, AssistantEvaluationService } from '../src/service.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.restart()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-service-'))
  roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  const service = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite') }, { now: () => 5_000 })
  return { ctx, service }
}

describe('assistant evaluation service', () => {
  test('exposes stable append/query/summary/health methods and closes with its Cordis scope', async () => {
    const { ctx, service } = await harness()
    const stored = service.append({
      scope: { workspace: '/work/alpha', preset: 'primary' }, situation: 'weekly-report',
      executionStatus: 'succeeded', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      source: { kind: 'evaluator', id: 'assertions' }, trust: 'trusted', evidence: [], metrics: {},
      occurredAt: 1_000, idempotencyKey: 'service:1', evaluator: { id: 'assertions', version: '1' },
    })
    expect(service.query({ scope: stored.scope, limit: 10 })).toEqual([stored])
    expect(service.summary({ scope: stored.scope, fromOccurredAt: 0, toOccurredAt: 5_000 }).total).toBe(1)
    expect(service.health()).toMatchObject({ ready: true, schemaVersion: 2, outcomes: 1, trustedOutcomes: 1 })
    expect(service.limits()).toMatchObject({ maxSituationBytes: 200, maxQueryLimit: 100, maxEvidenceRefs: 32 })
    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(() => service.health())
      .toThrowError(expect.objectContaining<Partial<AssistantEvaluationError>>({ code: 'disposed' }))
  })

  test('keeps the published situation interoperability floor', () => {
    const ctx = new Context(); contexts.push(ctx)
    expect(() => new AssistantEvaluationService(ctx, { databasePath: ':memory:', maxSituationBytes: 199 }))
      .toThrowError(/invalid configuration/i)
    const metricsCtx = new Context(); contexts.push(metricsCtx)
    expect(() => new AssistantEvaluationService(metricsCtx, { databasePath: ':memory:', maxMetricsBytes: 255 }))
      .toThrowError(/invalid configuration/i)
  })
})
