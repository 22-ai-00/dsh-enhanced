import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantProactiveService } from '../src/index.ts'
import { reminderContentDigest, reminderExpiresAt, reminderText } from '../src/reminder.ts'
import { assessAttention, countAttentionWords } from '@dsh-enhanced/assistant-delivery'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OpportunityEngine } from '../src/engine.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'
const contexts: Context[] = []
afterEach(async () => { vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const profile: OpportunityProfile = { id: 'reminder', mode: 'remind', expectedBenefit: 100, successPpm: 900000, executionCost: 10, interruptionCost: 5, possibleLoss: 5, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 1000, maxDecisionsPerGoal: 10, maxExecutionsPerGoal: 0, maxRemindersPerGoal: 1 }
const input = (): OpportunityInput => ({ waitId: 'wait', profileId: profile.id, scope: { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'standard' }, goalId: 'goal', sessionId: 'session', definitionDigest: 'definition', objective: 'Prepare a report', nativeGoalId: 'native', nativeRevision: 2, ownerRouteId: 'route', sourceDigest: 'source-digest', sourceId: 'event-triggers:file', event: { id: 'event', sequence: 1, digest: 'digest', occurredAt: Date.now() }, expiresAt: Date.now() + 3600000 })

it('requires a notification delivery capability before accepting the reminder profile', async () => {
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:', profiles: [profile] })
  expect(() => ctx.assistantProactive.assertProfile(profile.id)).toThrow('reminder delivery service unavailable')
})

it('retries an unconfirmed enqueue with the same owner-bound text and id, without reserving another reminder', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const enqueue = vi.fn().mockImplementationOnce(() => { throw new Error('queue unavailable') }).mockReturnValue({ id: 'outbox', status: 'pending' })
  ctx.provide('assistantDelivery' as never, { enqueueOwnerNotification: enqueue } as never)
  await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:', profiles: [profile] })
  const service = ctx.assistantProactive; const event = input()
  expect(() => service.evaluate(event)).toThrow('queue unavailable')
  const result = service.evaluate(event)
  expect(result).toMatchObject({ disposition: 'consume', decision: { mode: 'remind', reason: 'reminder' } })
  expect(enqueue.mock.calls[1]).toEqual(enqueue.mock.calls[0])
  expect(enqueue.mock.calls[0]![0]).toMatchObject({ sourceId: 'assistant-proactive/v1', scope: event.scope, sessionId: event.sessionId, ownerRouteId: event.ownerRouteId, expiresAt: event.expiresAt })
  expect(enqueue.mock.calls[0]![0].text).toContain('目标仍在等待。本次仅提醒，未执行目标任务。')
  expect(service.evaluate({ ...event, event: { ...event.event, id: 'second', sequence: 2, digest: 'second-digest' } })).toMatchObject({ decision: { reason: 'budget' } })
  expect(enqueue).toHaveBeenCalledTimes(2)
})

it('bounds queued reminder lifetime before the next quiet interval using the frozen profile', () => {
  const at = Date.UTC(2026, 0, 1, 22, 59, 55)
  vi.useFakeTimers(); vi.setSystemTime(at)
  const quietProfile = { ...profile, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 480 } }
  const engine = new OpportunityEngine(':memory:', [quietProfile])
  const event = input(); const decision = engine.evaluate(event).decision
  expect(reminderExpiresAt(decision, engine.profileSnapshot(event.scope, event.goalId, profile.id))).toBe(Date.UTC(2026, 0, 1, 23))
  engine.close()
})

it('owner-facing text carries the objective but no estimates, utility, identifiers or event metadata', () => {
  const engine = new OpportunityEngine(':memory:', [profile])
  const event = input(); const decision = engine.evaluate(event).decision
  const text = reminderText(decision)
  expect(text).toContain('目标：Prepare a report')
  expect(text).toContain('未执行目标任务')
  for (const hidden of ['配置估值', '净收益', '预期收益', '成功系数', '执行成本', '打扰成本', '潜在损失', '70', decision.id, 'opportunity-', event.sourceId, event.event.id, event.event.digest, event.waitId, event.ownerRouteId, event.sessionId, 'proactive_'])
    expect(text).not.toContain(hidden)
  expect(reminderText({ objective: 'x'.repeat(1000) })).toContain(`${'x'.repeat(200)}…`)
  expect(countAttentionWords(reminderText({ objective: '准备周报' }))).toBeLessThan(60)
  const ledger = { questionAsked: () => false, questionAnswered: () => false, questionWorkItem: () => undefined } as never
  // Purpose is still undeclared (stage 1 default); the text itself no longer trips the estimate/identifier codes.
  expect(assessAttention({ text, ledger })).toMatchObject({ purpose: 'result', verdict: 'would-accept', reasons: ['missing-purpose'] })
  engine.close()
})

it('does not resend an unchanged reminder for the same goal source, across restart, until content or feedback changes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'proactive-reminder-'))
  try {
    const path = join(directory, 'proactive.sqlite')
    const many = { ...profile, maxRemindersPerGoal: 10 }
    const event = input()
    const next = (sequence: number, change: Partial<OpportunityInput> = {}): OpportunityInput => ({ ...event, ...change, event: { ...event.event, id: `event-${sequence}`, sequence, digest: `digest-${sequence}` } })
    let engine = new OpportunityEngine(path, [many])
    const first = engine.evaluate(next(1)).decision
    expect(first).toMatchObject({ mode: 'remind', reason: 'reminder' })
    expect(engine.evaluate(next(2))).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'unchanged' } })
    engine.close()
    engine = new OpportunityEngine(path, [many])
    // Replay of the original event keeps its decision and delivery key.
    expect(engine.evaluate(next(1)).decision).toMatchObject({ id: first.id, mode: 'remind' })
    expect(engine.evaluate(next(3)).decision).toMatchObject({ mode: 'suppress', reason: 'unchanged' })
    // Another source of the same goal is independent.
    expect(engine.evaluate({ ...next(1), sourceId: 'event-triggers:other' }).decision).toMatchObject({ mode: 'remind', reason: 'reminder' })
    // A goal revision changes the result the owner would act on.
    const revised = engine.evaluate(next(4, { nativeRevision: 3 })).decision
    expect(revised).toMatchObject({ mode: 'remind', reason: 'reminder' })
    expect(reminderContentDigest(revised)).not.toBe(reminderContentDigest(first))
    expect(engine.evaluate(next(5, { nativeRevision: 3 })).decision).toMatchObject({ reason: 'unchanged' })
    // Owner feedback settles the reminder; the next event may remind again.
    engine.feedback(revised.id, event.scope, 'accepted')
    expect(engine.evaluate(next(6, { nativeRevision: 3 })).decision).toMatchObject({ mode: 'remind', reason: 'reminder' })
    engine.close()
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

it('a matured coalesced reminder is also deduplicated against the last sent one', () => {
  let now = 1_000
  const merged = { ...profile, mergeWindowMs: 100, maxRemindersPerGoal: 10 }
  const engine = new OpportunityEngine(':memory:', [merged], { now: () => now })
  const event = { ...input(), expiresAt: 1_000_000 }
  const at = (sequence: number): OpportunityInput => ({ ...event, event: { ...event.event, id: `e${sequence}`, sequence, digest: `d${sequence}` } })
  expect(engine.evaluate(at(1)).disposition).toBe('defer')
  now = 1_200
  expect(engine.evaluate(at(1)).decision).toMatchObject({ mode: 'remind', reason: 'reminder' })
  now = 1_300
  expect(engine.evaluate(at(2)).disposition).toBe('defer')
  now = 1_500
  expect(engine.evaluate(at(2)).decision).toMatchObject({ mode: 'suppress', reason: 'unchanged' })
  engine.close()
})

it('service sends one owner notification for repeated unchanged events', async () => {
  const ctx = new Context(); contexts.push(ctx)
  const enqueue = vi.fn().mockReturnValue({ id: 'outbox', status: 'pending' })
  ctx.provide('assistantDelivery' as never, { enqueueOwnerNotification: enqueue } as never)
  await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:', profiles: [{ ...profile, maxRemindersPerGoal: 10 }] })
  const event = input()
  ctx.assistantProactive.evaluate(event)
  expect(ctx.assistantProactive.evaluate({ ...event, event: { ...event.event, id: 'second', sequence: 2, digest: 'second-digest' } })).toMatchObject({ decision: { reason: 'unchanged' } })
  expect(enqueue).toHaveBeenCalledTimes(1)
  expect(enqueue.mock.calls[0]![0].text).not.toMatch(/opportunity-|配置估值|event-triggers/u)
})
