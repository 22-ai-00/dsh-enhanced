import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { AssistantProactiveService } from '../src/index.ts'
import { reminderExpiresAt, reminderText } from '../src/reminder.ts'
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

it('bounds queued reminder lifetime before the next quiet interval and uses frozen estimates', () => {
  const at = Date.UTC(2026, 0, 1, 22, 59, 55)
  vi.useFakeTimers(); vi.setSystemTime(at)
  const quietProfile = { ...profile, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 480 } }
  const engine = new OpportunityEngine(':memory:', [quietProfile])
  const event = input(); const decision = engine.evaluate(event).decision
  expect(reminderExpiresAt(decision, engine.profileSnapshot(event.scope, event.goalId, profile.id))).toBe(Date.UTC(2026, 0, 1, 23))
  expect(reminderText(decision, quietProfile)).toContain('净收益分值 70')
  expect(reminderText(decision, quietProfile)).toContain('配置估计')
  engine.close()
})
