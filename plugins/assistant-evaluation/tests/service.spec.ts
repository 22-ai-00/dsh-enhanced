import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantEvaluationError,
  AssistantEvaluationService,
  canonicalEvaluationHostScope,
} from '../src/service.ts'
import { installTrustedTestProducers } from './trusted-producer-fixture.ts'

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
  const producers = installTrustedTestProducers(ctx)
  const service = new AssistantEvaluationService(ctx, { databasePath: join(root, 'evaluation.sqlite') }, { now: () => 5_000 })
  return { ctx, service, ...producers }
}

describe('assistant evaluation service', () => {
  test('exposes stable append/query/summary/health methods and closes with its Cordis scope', async () => {
    const { automations, ctx, service } = await harness()
    const stored = automations.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'weekly-report', situation: 'automation:weekly-report', runId: 'run-service-1',
      executionMode: 'production',
      executionStatus: 'succeeded', objectiveStatus: 'unknown', deliveryStatus: 'not-required',
      metrics: {}, occurredAt: 1_000, idempotencyKey: 'service:1', evaluatorVersion: 'terminal-v1',
    })
    expect(service.query({ scope: stored.scope, limit: 10 })).toEqual([stored])
    expect(service.summary({ scope: stored.scope, fromOccurredAt: 0, toOccurredAt: 5_000 }).total).toBe(1)
    expect(service.health()).toMatchObject({
      ready: true, schemaVersion: 7, outcomes: 1, trustedOutcomes: 1,
      taskProjections: 1, conflictedTaskProjections: 0, pendingProjections: 1,
    })
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

  test('returns only an exact immutable trusted Host receipt', async () => {
    const { automations, service } = await harness()
    const scope = { workspace: '/work/alpha', preset: 'primary' }
    const trusted = automations.append({
      scope,
      automationId: 'growth',
      situation: 'automation:growth',
      runId: 'run-1',
      executionMode: 'production',
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'not-required',
      metrics: { inputTokens: 99 },
      occurredAt: 1_000,
      idempotencyKey: 'trusted:1',
      evaluatorVersion: 'terminal-v1',
    })
    const untrusted = service.append({
      scope,
      situation: 'automation:untrusted',
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'not-required',
      source: { kind: 'evaluator', id: 'self-review' },
      trust: 'self-reported',
      evidence: [],
      metrics: {},
      occurredAt: 1_000,
      idempotencyKey: 'untrusted:1',
      evaluator: { id: 'self-review', version: '1' },
    })
    const hostScope = canonicalEvaluationHostScope(scope)
    const receipt = service.getTrustedOutcome({ scope: hostScope, outcomeId: trusted.id })
    expect(receipt).toEqual({
      id: trusted.id,
      scope,
      scopeKey: trusted.scopeKey,
      situation: trusted.situation,
      executionStatus: 'succeeded',
      objectiveStatus: 'achieved',
      deliveryStatus: 'not-required',
      source: trusted.source,
      trust: 'trusted',
      evidence: trusted.evidence,
      occurredAt: 1_000,
      evaluator: trusted.evaluator,
    })
    expect(Object.isFrozen(receipt)).toBe(true)
    expect(Object.isFrozen(receipt!.evidence[0])).toBe(true)
    expect(receipt).not.toHaveProperty('metrics')
    expect(receipt).not.toHaveProperty('idempotencyKey')
    expect(receipt).not.toHaveProperty('recordedAt')
    expect(service.getTrustedOutcome({ scope: hostScope, outcomeId: untrusted.id })).toBeUndefined()
    expect(service.getTrustedOutcome({
      scope: canonicalEvaluationHostScope({ workspace: '/work/other', preset: 'primary' }),
      outcomeId: trusted.id,
    })).toBeUndefined()
  })

  test('durably retries and exactly settles trusted objective projection when Evolution attaches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-evaluation-projection-'))
    roots.push(root)
    const ctx = new Context(); contexts.push(ctx)
    const { automations } = installTrustedTestProducers(ctx)
    let now = 5_000
    const service = new AssistantEvaluationService(ctx, {
      databasePath: join(root, 'evaluation.sqlite'),
      projectionIntervalMs: 0,
      projectionRetryBaseMs: 10,
      projectionRetryMaxMs: 10,
    }, { now: () => now })
    let available = false
    const calls: string[] = []
    ctx.provide('assistantEvolution' as never, {
      async projectTrustedEvaluationTaskRevision(input: { evaluationId: string }) {
        calls.push(input.evaluationId)
        if (!available) throw Object.assign(new Error('offline'), { code: 'sink-unavailable' })
        const receipt = service.getTrustedTaskLearningProjection({
          scope: canonicalEvaluationHostScope({ workspace: '/work/alpha', preset: 'primary' }),
          outcomeId: input.evaluationId,
        })!
        const projection = receipt.projection
        return {
          triggerOutcomeId: input.evaluationId,
          subjectKind: projection.subjectKind,
          subjectRef: projection.subjectRef,
          version: projection.version,
          digest: projection.digest,
          scopeWatermark: receipt.scopeWatermark,
          disposition: projection.disposition,
          status: 'applied' as const,
        }
      },
    } as never)
    const outcome = automations.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      automationId: 'verified-task', situation: 'automation:verified-task', runId: 'run-projection-1',
      executionMode: 'production',
      executionStatus: 'succeeded', objectiveStatus: 'achieved', deliveryStatus: 'not-required',
      metrics: {}, occurredAt: 4_900, idempotencyKey: 'projection:1', evaluatorVersion: 'terminal-v1',
    })
    // Cordis publishes a newly provided optional service asynchronously. Wait
    // for that lifecycle edge, then require the durable retry state to settle.
    await vi.waitFor(() => {
      expect(calls).toEqual([outcome.id])
      expect(service.health()).toMatchObject({
        pendingProjections: 1, retryingProjections: 1, projectionAttempts: 1,
      })
    })
    await service.whenProjectionIdle()

    available = true
    now += 10
    expect(await service.reconcileProjection({
      scope: canonicalEvaluationHostScope(outcome.scope),
      evaluationId: outcome.id,
      operationId: 'recovery:projection:1',
    })).toMatchObject({ evaluationId: outcome.id, status: 'recorded', attemptCount: 1 })
    expect(await service.reconcileProjection({
      scope: canonicalEvaluationHostScope(outcome.scope),
      evaluationId: outcome.id,
      operationId: 'recovery:projection:1',
    })).toMatchObject({ evaluationId: outcome.id, status: 'recorded', attemptCount: 1 })
    expect(calls).toEqual([outcome.id, outcome.id])
    expect(service.health()).toMatchObject({ pendingProjections: 0 })
  })

  test('rejects serialized Host scopes and malformed outcome ids', async () => {
    const { service } = await harness()
    const scope = canonicalEvaluationHostScope({ workspace: '/work/alpha', preset: 'primary' })
    expect(Object.isFrozen(scope)).toBe(true)
    expect(() => service.getTrustedOutcome({ scope: { ...scope } as typeof scope, outcomeId: 'outcome-1' }))
      .toThrowError(expect.objectContaining<Partial<AssistantEvaluationError>>({ code: 'invalid-input' }))
    expect(() => service.getTrustedOutcome({ scope, outcomeId: 'bad\nid' }))
      .toThrowError(expect.objectContaining<Partial<AssistantEvaluationError>>({ code: 'invalid-input' }))
  })

  test('rejects a public caller that labels its own outcome trusted', async () => {
    const { service } = await harness()
    expect(() => service.append({
      scope: { workspace: '/work/alpha', preset: 'primary' },
      situation: 'forged-trusted-outcome',
      executionStatus: 'succeeded', objectiveStatus: 'achieved', deliveryStatus: 'not-required',
      source: { kind: 'evaluator', id: 'caller-controlled' }, trust: 'trusted', evidence: [], metrics: {},
      occurredAt: 1_000, idempotencyKey: 'forged:1', evaluator: { id: 'caller', version: '1' },
    })).toThrowError(expect.objectContaining<Partial<AssistantEvaluationError>>({ code: 'forbidden' }))
  })

  test('attests only exact live registrations created by this Evaluation instance', async () => {
    const { automations, ctx, delivery, service } = await harness()
    const automationRegistration = automations.currentRegistration()!
    const deliveryRegistration = delivery.currentRegistration()!
    expect(service.ownsTrustedAutomationEvaluationRegistration(automationRegistration)).toBe(true)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(deliveryRegistration)).toBe(true)
    expect(service.ownsTrustedAutomationEvaluationRegistration({ ...automationRegistration })).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration({ ...deliveryRegistration })).toBe(false)

    await ctx.fiber.restart()
    contexts.splice(contexts.indexOf(ctx), 1)
    expect(service.ownsTrustedAutomationEvaluationRegistration(automationRegistration)).toBe(false)
    expect(service.ownsTrustedDeliveryEvaluationRegistration(deliveryRegistration)).toBe(false)
  })
})
