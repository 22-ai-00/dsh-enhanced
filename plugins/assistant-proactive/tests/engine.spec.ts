import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OpportunityEngine, validateProfile } from '../src/engine.ts'
import type { OpportunityInput, OpportunityProfile } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const profile = (more: Partial<OpportunityProfile> = {}): OpportunityProfile => ({ id: 'proactive-default', mode: 'execute', expectedBenefit: 100, successPpm: 1_000_000, executionCost: 10, interruptionCost: 5, possibleLoss: 5, minimumUtility: 1, mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 60_000, maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 2, maxRemindersPerGoal: 1, ...more })
const scope = { principalId: 'lark/a/t/u', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const input = (sequence = 1, digest = `digest-${sequence}`, more: Partial<OpportunityInput> = {}): OpportunityInput => ({ waitId: 'wait-a', profileId: 'proactive-default', scope, goalId: 'goal-a', sessionId: 'session-a', definitionDigest: 'definition-a', objective: 'Prepare the report when source changes.', nativeGoalId: 'native-a', nativeRevision: 1, ownerRouteId: 'route-a', sourceDigest: 'source-a', sourceId: 'trigger-a', event: { id: `event-${sequence}`, sequence, digest, occurredAt: 1_000 }, expiresAt: Number.MAX_SAFE_INTEGER, ...more })

describe('OpportunityEngine', () => {
  it('persists an exact event decision across reopening without duplicate budget consumption', async () => {
    const root = await mkdtemp(join(tmpdir(), 'proactive-engine-')); roots.push(root); const path = join(root, 'engine.sqlite')
    let now = 2_000
    const first = new OpportunityEngine(path, [profile()], { now: () => now })
    const initial = first.evaluate(input()); expect(initial.disposition).toBe('execute'); first.close()
    const second = new OpportunityEngine(path, [profile({ maxExecutionsPerGoal: 99 })], { now: () => now })
    const replay = second.evaluate(input()); expect(replay).toEqual(initial)
    expect(second.evaluate(input(2)).disposition).toBe('execute')
    expect(second.list(scope, 'goal-a').filter(value => value.reason === 'execution')).toHaveLength(2)
    second.close()
  })

  it('keeps a merge deadline fixed, ignores stale conflicts, and does not let later profile changes relax a goal', () => {
    let now = 10_000
    const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 1_000, maxDecisionsPerGoal: 1 })], { now: () => now })
    const first = engine.evaluate(input(4)); expect(first).toMatchObject({ disposition: 'defer', decision: { reason: 'coalescing', eligibleAt: 11_000, observations: 1 } })
    now = 10_500
    const merged = engine.evaluate(input(5)); expect(merged).toMatchObject({ disposition: 'defer', decision: { eligibleAt: 11_000, observations: 2, eventSequence: 5 } })
    expect(engine.evaluate(input(3, 'conflict')).decision.id).toBe(merged.decision.id)
    now = 11_001
    const later = engine.evaluate(input(6)); expect(later.disposition).toBe('execute')
    expect(engine.evaluate(input(7))).toMatchObject({ disposition: 'consume', decision: { reason: 'budget' } })
    engine.close()
  })

  it('enforces rejection cooldown and quiet hours over a cross-midnight boundary', () => {
    let now = Date.UTC(2026, 0, 1, 23, 30)
    const engine = new OpportunityEngine(':memory:', [profile({ quietHours: { timezone: 'UTC', startMinute: 23 * 60, endMinute: 60 }, mergeWindowMs: 0 })], { now: () => now })
    const quiet = engine.evaluate(input()); expect(quiet).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })
    now = Date.UTC(2026, 0, 2, 1, 1)
    const execution = engine.evaluate(input(2)); expect(execution.disposition).toBe('execute')
    engine.feedback(execution.decision.id, scope, 'rejected')
    expect(engine.evaluate(input(3))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
    now += 60_001
    expect(engine.evaluate(input(4)).disposition).toBe('execute')
    engine.close()
  })

  it('counts prepare/remind decisions separately and validates estimates without presenting them as measured values', () => {
    const prepare = new OpportunityEngine(':memory:', [profile({ mode: 'prepare', maxDecisionsPerGoal: 1 })], { now: () => 2_000 })
    expect(prepare.evaluate(input())).toMatchObject({ disposition: 'consume', decision: { mode: 'prepare', reason: 'prepared', utility: 80 } })
    expect(prepare.evaluate(input(2))).toMatchObject({ decision: { reason: 'budget' } }); prepare.close()
    expect(() => validateProfile(profile({ successPpm: 1_000_001 }))).toThrow('invalid profile')
    expect(() => validateProfile(profile({ successPpm: Number.MAX_SAFE_INTEGER }))).toThrow('invalid profile')
  })

  it('matures a silent single event, then never executes it after expiry', () => {
    let now = 1_000; const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 100 })], { now: () => now })
    const expiring = input(1, 'digest-1', { expiresAt: 2_000 }); const pending = engine.evaluate(expiring); expect(pending.disposition).toBe('defer')
    now = 1_101; expect(engine.evaluate(expiring)).toMatchObject({ disposition: 'execute', decision: { id: pending.decision.id } })
    now = 2_001; expect(engine.evaluate(expiring)).toMatchObject({ disposition: 'consume', decision: { id: pending.decision.id, reason: 'expired' } })
    engine.close()
  })

  it('delays a merged candidate entering quiet hours and suppresses it when utility is below threshold', () => {
    let now = Date.UTC(2026, 0, 1, 22, 59); const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 60_000, quietHours: { timezone: 'UTC', startMinute: 23 * 60, endMinute: 60 } })], { now: () => now })
    engine.evaluate(input()); now = Date.UTC(2026, 0, 1, 23, 1)
    expect(engine.evaluate(input())).toMatchObject({ disposition: 'defer', decision: { reason: 'quiet-hours' } })
    now = Date.UTC(2026, 0, 2, 1, 1); expect(engine.evaluate(input())).toMatchObject({ disposition: 'execute', decision: { reason: 'execution' } }); engine.close()
  })

  it('isolates source sequences and rejects cross-wait replay authority', () => {
    const engine = new OpportunityEngine(':memory:', [profile()], { now: () => 1_000 })
    engine.evaluate(input(9)); expect(engine.evaluate(input(1, 'other-source', { sourceId: 'trigger-b' })).disposition).toBe('execute')
    expect(() => engine.evaluate(input(9, 'digest-9', { waitId: 'other-wait' }))).toThrow('identity conflict'); engine.close()
  })
})

it('does not refund historical executions when an expired event is replayed, or bypass the goal cap with another profile', () => {
  let now = 2_000
  const engine = new OpportunityEngine(':memory:', [profile({ maxExecutionsPerGoal: 1 }), profile({ id: 'higher', maxExecutionsPerGoal: 100 })], { now: () => now })
  const first = { ...input(), expiresAt: 3_000 }; engine.evaluate(first)
  now = 3_001
  expect(engine.evaluate(first)).toMatchObject({ disposition: 'consume', decision: { reason: 'expired' } })
  expect(engine.list(scope)[0]).toMatchObject({ mode: 'execute', reason: 'execution' })
  expect(engine.evaluate({ ...input(2), profileId: 'higher' })).toMatchObject({ disposition: 'consume', decision: { reason: 'budget' } })
  engine.close()
})

it('persists owner rejection across restart and bounds rejected event noise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'proactive-feedback-')); roots.push(root)
  const path = join(root, 'engine.sqlite'); const profiles = [profile({ maxDecisionsPerGoal: 2 })]
  const first = new OpportunityEngine(path, profiles, { now: () => 2_000 })
  const decision = first.evaluate(input()).decision
  expect(() => first.feedback(decision.id, { ...scope, principalVersion: 2 }, 'rejected')).toThrow('unavailable')
  first.feedback(decision.id, scope, 'rejected'); first.close()
  const second = new OpportunityEngine(path, profiles, { now: () => 3_000 })
  expect(second.evaluate(input(2))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  for (let sequence = 3; sequence < 50; sequence++) expect(second.evaluate(input(sequence)).disposition).toBe('consume')
  expect(second.list(scope)).toHaveLength(2)
  second.close()
})

it('rechecks low utility after quiet hours and rejection while another event is pending', () => {
  let now = Date.UTC(2026, 0, 1, 23, 30)
  const low = new OpportunityEngine(':memory:', [profile({ expectedBenefit: 0, quietHours: { timezone: 'UTC', startMinute: 1380, endMinute: 60 } })], { now: () => now })
  low.evaluate(input()); now = Date.UTC(2026, 0, 2, 1, 1)
  expect(low.evaluate(input())).toMatchObject({ disposition: 'consume', decision: { reason: 'below-threshold' } }); low.close()
  const engine = new OpportunityEngine(':memory:', [profile({ mergeWindowMs: 1000 })], { now: () => now })
  engine.evaluate(input()); now += 1000
  const first = engine.evaluate(input()).decision
  engine.evaluate(input(2)); engine.feedback(first.id, scope, 'rejected'); now += 1000
  expect(engine.evaluate(input(2))).toMatchObject({ disposition: 'consume', decision: { reason: 'rejected-cooldown' } })
  engine.close()
})
