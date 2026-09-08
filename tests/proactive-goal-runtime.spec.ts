import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalEventWaitRuntime } from '../plugins/assistant-goals/src/event-wait.ts'
import type { GoalEventWaitIntent } from '../plugins/assistant-goals/src/event-wait-store.ts'
import type { GoalRecord } from '../plugins/assistant-goals/src/types.ts'
import type { GoalWakeIntent } from '../plugins/assistant-goals/src/wake-store.ts'
import type { GoalWakeRuntime } from '../plugins/assistant-goals/src/wake.ts'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fixture(path = ':memory:', prior?: GoalRecord, proactive?: { evaluate: (input: unknown) => { disposition: 'defer' | 'consume' | 'execute'; decision: { eventSequence: number } } }) {
  const now = Date.now(); const objective = 'resume after an event'
  const scope = { principalId: 'owner', principalRecordId: 'row', principalVersion: 1, workspace: '/tmp/event-wait', preset: 'primary' }
  let record: GoalRecord = prior ?? { id: 'goal', scope, originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session', goalId: 'native', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: now }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now }
  let policyAllowed = true; let changed = false; let emitted = true; let wakeState: 'scheduled' | 'dispatched' | 'succeeded' | 'unknown' | 'denied' = 'scheduled'; let materializations = 0; let failure: Error | undefined; let materialized: GoalWakeIntent | undefined
  const listeners = new Set<() => void>(); const disposers: Array<() => void> = []
  const snapshot = () => ({ protocol: 'dsh-event-source/v1' as const, sourceId: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: changed ? 'c'.repeat(64) : 'a'.repeat(64), target: { automationId: 'automation' }, highWaterSequence: 7 })
  let lastAfter = -1; let maxSequence = 8
  const source = { sourceSnapshot: () => snapshot(), firstEventAfter: (_snapshot: unknown, after: number) => { lastAfter = after; return emitted && after < maxSequence ? ({ sequence: Math.max(8, after + 1), envelope: { protocol: 'dsh-external-event/v1' as const, source: { id: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: 'a'.repeat(64) }, event: { id: `event-${Math.max(8, after + 1)}`, occurredAt: now, receivedAt: now }, observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: 'observed' as const }, trust: { method: 'local-observation' as const, content: 'untrusted' as const }, target: { automationId: 'automation' }, deduplicationKey: `event-triggers:file:event-${Math.max(8, after + 1)}` } }) : undefined }, subscribeSourceChanges: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const wake = { preflight: () => {}, materialize: (input: GoalWakeIntent) => { materializations++; materialized = input; if (failure) throw failure }, inspect: () => materialized === undefined ? [] : [{ intent: materialized, state: wakeState }] } as unknown as GoalWakeRuntime
  const ctx = { inject: (_keys: readonly string[], callback: (value: unknown) => () => void) => { callback({ eventTriggers: source }) }, effect: (setup: () => () => void) => { disposers.push(setup()) } } as unknown as Context
  const runtime = new GoalEventWaitRuntime(ctx, path, wake, () => { if (!policyAllowed) throw new Error('assistant-goals: event wait policy denied'); return record }, () => proactive)
  const intent = (): GoalEventWaitIntent => ({ id: 'event-wait', wake: { scope, goalId: record.id, definition: record.definition, native: record.native, attestation: { scope: { workspace: scope.workspace, preset: scope.preset }, principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1, sessionId: 'session' }, ownerRouteId: 'route', budgetId: 'budget' }, source: snapshot(), createdAt: now - 1, expiresAt: now + 10_000, runTimeoutMs: 1_000 })
  return { runtime, intent, scope, set maxSequence(value: number) { maxSequence = value }, close: () => { for (const dispose of disposers) dispose() }, emitChange: () => { for (const listener of listeners) listener() }, get materializations() { return materializations }, get materialized() { return materialized }, get lastAfter() { return lastAfter }, set policyAllowed(value: boolean) { policyAllowed = value }, set changed(value: boolean) { changed = value }, set emitted(value: boolean) { emitted = value }, set wakeState(value: typeof wakeState) { wakeState = value }, set failure(value: Error | undefined) { failure = value }, set record(value: GoalRecord) { record = value }, get record() { return record } }
}

// Place in a root-level integration test (not assistant-goals tests: its tsconfig rootDir rejects cross-package source imports).
import { OpportunityEngine } from '../plugins/assistant-proactive/src/engine.ts'
import type { OpportunityInput } from '../plugins/assistant-proactive/src/types.ts'

it('filters an event through the durable opportunity engine, then restores its exact execute wake after restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'event-wait-proactive-')); roots.push(root)
  const engine = new OpportunityEngine(join(root, 'opportunities.sqlite'), [{
    id: 'execute-profile', mode: 'execute', expectedBenefit: 10, successPpm: 1_000_000,
    executionCost: 1, interruptionCost: 1, possibleLoss: 1, minimumUtility: 1,
    mergeWindowMs: 0, cooldownMs: 0, rejectionCooldownMs: 0,
    maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 3, maxRemindersPerGoal: 0,
  }])
  const proactive = { evaluate: (input: unknown) => engine.evaluate(input as OpportunityInput) }
  const path = join(root, 'waits.sqlite'); const first = fixture(path, undefined, proactive); first.failure = new Error('acknowledgement lost')
  expect(() => first.runtime.prepare({ ...first.intent(), opportunityProfile: 'execute-profile' })).toThrow('acknowledgement lost')
  expect(engine.list(first.scope, 'goal')).toMatchObject([{ mode: 'execute', reason: 'execution', state: 'decided' }])
  first.close()
  const second = fixture(path, first.record, proactive); second.emitted = false; second.runtime.reconcile()
  expect(second.materialized).toMatchObject({ id: 'goal-event-wake-event-wait' }); expect(second.materializations).toBe(1)
  second.close(); engine.close()
})

it('matures one real opportunity on the runtime timer after reopening both ledgers', async () => {
  vi.useFakeTimers()
  const root = await mkdtemp(join(tmpdir(), 'proactive-timer-')); roots.push(root)
  const profiles = [{ id: 'filtered', mode: 'execute' as const, expectedBenefit: 10, successPpm: 1_000_000,
    executionCost: 1, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1,
    mergeWindowMs: 2000, cooldownMs: 0, rejectionCooldownMs: 0,
    maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 1, maxRemindersPerGoal: 0 }]
  const enginePath = join(root, 'opportunities.sqlite'), waitPath = join(root, 'waits.sqlite')
  let engine = new OpportunityEngine(enginePath, profiles)
  const bridge = { evaluate: (input: unknown) => engine.evaluate(input as OpportunityInput) }
  const first = fixture(waitPath, undefined, bridge)
  first.runtime.prepare({ ...first.intent(), opportunityProfile: 'filtered' })
  expect(first.materializations).toBe(0)
  const decisionId = engine.list(first.scope)[0]!.id
  first.close(); engine.close()
  engine = new OpportunityEngine(enginePath, profiles)
  const second = fixture(waitPath, first.record, bridge)
  vi.advanceTimersByTime(2000)
  expect(second.materializations).toBe(1)
  expect(engine.list(first.scope)).toMatchObject([{ id: decisionId, reason: 'execution' }])
  vi.advanceTimersByTime(1000); expect(second.materializations).toBe(1)
  second.close(); engine.close()
})

it.each([9, 40])('merges a bounded burst through sequence %s and makes progress after the window; closes expired pending decisions', async (maxSequence) => {
  vi.useFakeTimers()
  const engine = new OpportunityEngine(':memory:', [{ id: 'merge', mode: 'execute', expectedBenefit: 10, successPpm: 1_000_000, executionCost: 0, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1, mergeWindowMs: 2000, cooldownMs: 0, rejectionCooldownMs: 0, maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 1, maxRemindersPerGoal: 0 }])
  const bridge = { evaluate: (input: unknown) => engine.evaluate(input as OpportunityInput), closeWait: engine.closeWait.bind(engine) }
  const first = fixture(':memory:', undefined, bridge)
  first.maxSequence = maxSequence
  const mergedSequence = Math.min(maxSequence, 39)
  first.runtime.prepare({ ...first.intent(), opportunityProfile: 'merge' })
  expect(engine.list(first.scope)).toMatchObject([{ state: 'pending', eventSequence: mergedSequence, observations: mergedSequence - 7 }])
  vi.advanceTimersByTime(2000)
  expect(first.runtime.inspect(first.scope, 'goal')).toMatchObject([{ state: 'materialized', match: { sequence: mergedSequence } }])
  expect(engine.list(first.scope)).toMatchObject([{ state: 'decided', eventSequence: mergedSequence }])
  first.close(); engine.close()
  const expiredEngine = new OpportunityEngine(':memory:', [{ id: 'expire', mode: 'execute', expectedBenefit: 10, successPpm: 1_000_000, executionCost: 0, interruptionCost: 0, possibleLoss: 0, minimumUtility: 1, mergeWindowMs: 20000, cooldownMs: 0, rejectionCooldownMs: 0, maxDecisionsPerGoal: 3, maxExecutionsPerGoal: 1, maxRemindersPerGoal: 0 }])
  const second = fixture(':memory:', undefined, { evaluate: (input: unknown) => expiredEngine.evaluate(input as OpportunityInput), closeWait: expiredEngine.closeWait.bind(expiredEngine) } as never)
  second.runtime.prepare({ ...second.intent(), opportunityProfile: 'expire' })
  vi.advanceTimersByTime(10000)
  expect(second.materializations).toBe(0)
  expect(expiredEngine.list(second.scope)).toMatchObject([{ state: 'decided', reason: 'expired' }])
  second.close(); expiredEngine.close()
})
