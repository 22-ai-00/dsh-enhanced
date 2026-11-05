import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantProactiveService } from '../src/index.ts'
import { OpportunityEngine } from '../src/engine.ts'
import { attentionOverlay, tuneProfile, type AttentionOverlay } from '../src/attention-tuning.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const digest = 'a'.repeat(64)
const overlay = (parameters: Partial<AttentionOverlay['parameters']> = {}, version = 1): AttentionOverlay => ({
  version, digest, parameters: { interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false, ...parameters },
})
// utility = 100*0.9 - 10 - 5 - 5 = 70
const remind: OpportunityProfile = { id: 'reminder', mode: 'remind', expectedBenefit: 100, successPpm: 900_000, executionCost: 10, interruptionCost: 5, possibleLoss: 5, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 1_000, maxDecisionsPerGoal: 10, maxExecutionsPerGoal: 0, maxRemindersPerGoal: 5 }
const scope = { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'standard' }
const input = (sequence = 1, more: Partial<OpportunityInput> = {}): OpportunityInput => ({ waitId: 'wait', profileId: remind.id, scope, goalId: 'goal', sessionId: 'session', definitionDigest: 'definition', objective: 'Prepare a report', nativeGoalId: 'native', nativeRevision: 2, ownerRouteId: 'route', sourceDigest: 'source-digest', sourceId: 'event-triggers:file', event: { id: `event-${sequence}`, sequence, digest: `digest-${sequence}`, occurredAt: 1_000 }, expiresAt: Number.MAX_SAFE_INTEGER, ...more })

describe('attention overlay', () => {
  it('rejects malformed, default or out-of-bounds overlays as no overlay', () => {
    expect(attentionOverlay(undefined)).toBeUndefined()
    expect(attentionOverlay({ ...overlay(), version: 0 })).toBeUndefined()
    expect(attentionOverlay({ ...overlay(), digest: null })).toBeUndefined()
    expect(attentionOverlay(overlay({ interruptionCostDelta: 110 }))).toBeUndefined()
    expect(attentionOverlay(overlay({ quietExtensionMinutes: 45 }))).toBeUndefined()
    expect(attentionOverlay(overlay({ interruptionCostDelta: 10 }))).toEqual(overlay({ interruptionCostDelta: 10 }))
  })

  it('only tightens remind profiles and caps the widened quiet window below a day', () => {
    const tuned = tuneProfile({ ...remind, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 420 } }, overlay({ interruptionCostDelta: 20, minimumUtilityDelta: 30, quietExtensionMinutes: 60 }))
    expect(tuned).toMatchObject({ interruptionCost: 25, minimumUtility: 31, quietHours: { startMinute: 1320, endMinute: 480 } })
    const nearlyFull = tuneProfile({ ...remind, quietHours: { timezone: 'UTC', startMinute: 60, endMinute: 0 } }, overlay({ quietExtensionMinutes: 120 }))
    // 1380 quiet minutes leave 59 of room: 29 before, 30 after, 1439 total.
    expect(nearlyFull.quietHours).toEqual({ timezone: 'UTC', startMinute: 31, endMinute: 30 })
    expect(tuneProfile({ ...remind, quietHours: { timezone: 'UTC', startMinute: 100, endMinute: 0 } }, overlay({ quietExtensionMinutes: 120 })).quietHours)
      .toEqual({ timezone: 'UTC', startMinute: 51, endMinute: 50 })
    expect(tuneProfile(remind, overlay({ quietExtensionMinutes: 120 })).quietHours).toBeUndefined()
    const execute = { ...remind, mode: 'execute' as const }
    expect(tuneProfile(execute, overlay({ interruptionCostDelta: 100, muted: true }))).toBe(execute)
  })
})

describe('OpportunityEngine with an overlay', () => {
  it('raises the threshold, records the version and leaves the frozen profile unchanged', () => {
    const engine = new OpportunityEngine(':memory:', [remind], { now: () => 2_000 })
    expect(engine.evaluate(input(1), overlay({ interruptionCostDelta: 40, minimumUtilityDelta: 40 })))
      .toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'below-threshold', utility: 30, attentionTuning: { version: 1, digest } } })
    expect(engine.profileSnapshot(scope, 'goal', remind.id)).toMatchObject({ interruptionCost: 5, minimumUtility: 1 })
    const untuned = engine.evaluate(input(2)).decision
    expect(untuned).toMatchObject({ mode: 'remind', reason: 'reminder', utility: 70 })
    expect(untuned).not.toHaveProperty('attentionTuning')
    engine.close()
  })

  it('mutes new and matured reminders without spending reminder budget', () => {
    let now = 2_000
    const engine = new OpportunityEngine(':memory:', [{ ...remind, mergeWindowMs: 1_000 }], { now: () => now })
    expect(engine.evaluate(input(1))).toMatchObject({ disposition: 'defer', decision: { reason: 'coalescing' } })
    now = 3_001
    expect(engine.evaluate(input(2), overlay({ muted: true }))).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'attention-muted', attentionTuning: { version: 1 } } })
    now = 10_000
    expect(engine.evaluate(input(3), overlay({ muted: true }))).toMatchObject({ disposition: 'consume', decision: { mode: 'suppress', reason: 'attention-muted' } })
    expect(engine.list(scope, 'goal').filter(item => item.mode === 'remind')).toHaveLength(0)
    engine.close()
  })

  it('extends quiet hours on both sides', () => {
    let now = Date.UTC(2026, 0, 1, 22, 30)
    const engine = new OpportunityEngine(':memory:', [{ ...remind, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 60 } }], { now: () => now })
    expect(engine.evaluate(input(1), overlay({ quietExtensionMinutes: 60 })))
      .toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours', eligibleAt: Date.UTC(2026, 0, 2, 2, 0) } })
    now = Date.UTC(2026, 0, 2, 1, 30) // outside the configured window, inside the extension
    expect(engine.evaluate(input(2), overlay({ quietExtensionMinutes: 60 }))).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })
    now = Date.UTC(2026, 0, 2, 2, 0)
    expect(engine.evaluate(input(3), overlay({ quietExtensionMinutes: 60 }))).toMatchObject({ decision: { reason: 'reminder' } })
    engine.close()
  })
})

describe('AssistantProactiveService reading Evaluation', () => {
  const setup = async (evaluation?: unknown) => {
    const ctx = new Context(); contexts.push(ctx)
    const enqueue = vi.fn().mockReturnValue({ id: 'outbox', status: 'pending' })
    ctx.provide('assistantDelivery' as never, { enqueueOwnerNotification: enqueue } as never)
    if (evaluation !== undefined) ctx.provide('assistantEvaluation' as never, evaluation as never)
    await ctx.plugin(AssistantProactiveService, { databasePath: ':memory:', profiles: [remind] })
    return { service: ctx.assistantProactive, enqueue }
  }
  const strip = (value: unknown) => JSON.parse(JSON.stringify(value, (key, item) => key === 'id' || key === 'idempotencyKey' || key === 'firstObservedAt' || key === 'updatedAt' || key === 'eligibleAt' ? undefined : typeof item === 'string' ? item.replace(/opportunity-[0-9a-f-]{36}/g, 'opportunity-*') : item)) as unknown

  it('switch off (no service, undefined, version 0, throwing) is identical to untuned', async () => {
    const baseline = await setup()
    const base = baseline.service.evaluate(input(1))
    for (const evaluation of [
      { currentAttentionTuning: () => undefined },
      { currentAttentionTuning: () => ({ version: 0, digest: null, parameters: overlay().parameters }) },
      { currentAttentionTuning: () => { throw new Error('not configured') } },
    ]) {
      const other = await setup(evaluation)
      expect(strip(other.service.evaluate(input(1)))).toEqual(strip(base))
      expect(strip(other.enqueue.mock.calls[0]![0])).toEqual(strip(baseline.enqueue.mock.calls[0]![0]))
    }
  })

  it('applies the current version for the proactive cohort and mutes delivery', async () => {
    const current = vi.fn().mockReturnValue({ scopeKey: 'x', cohort: {}, source: 'active', ...overlay({ interruptionCostDelta: 10 }) })
    const { service, enqueue } = await setup({ currentAttentionTuning: current })
    expect(service.evaluate(input(1))).toMatchObject({ decision: { reason: 'reminder', utility: 60, attentionTuning: { version: 1 } } })
    expect(current).toHaveBeenCalledWith({ scope: { workspace: '/workspace', preset: 'standard' }, cohort: { lane: 'owner-notification', sourceId: 'assistant-proactive/v1' } })
    expect(enqueue.mock.calls[0]![0].text).toContain('打扰成本 15')
    current.mockReturnValue({ ...overlay({ interruptionCostDelta: 10, muted: true }, 2) })
    expect(service.evaluate(input(2))).toMatchObject({ decision: { reason: 'attention-muted', attentionTuning: { version: 2 } } })
    expect(enqueue).toHaveBeenCalledTimes(1)
  })
})
