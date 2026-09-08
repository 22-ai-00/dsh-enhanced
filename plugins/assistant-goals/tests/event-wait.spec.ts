import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalEventWaitRuntime } from '../src/event-wait.ts'
import type { GoalEventWaitIntent } from '../src/event-wait-store.ts'
import type { GoalRecord } from '../src/types.ts'
import type { GoalWakeIntent } from '../src/wake-store.ts'
import type { GoalWakeRuntime } from '../src/wake.ts'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function fixture(path = ':memory:', prior?: GoalRecord, proactive?: { evaluate: (input: unknown) => { disposition: 'defer' | 'consume' | 'execute'; decision: { eventSequence: number } } }) {
  const now = Date.now(); const objective = 'resume after an event'
  const scope = { principalId: 'owner', principalRecordId: 'row', principalVersion: 1, workspace: '/tmp/event-wait', preset: 'primary' }
  let record: GoalRecord = prior ?? { id: 'goal', scope, originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session', goalId: 'native', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: now }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now }
  let policyAllowed = true; let changed = false; let emitted = true; let wakeState: 'scheduled' | 'dispatched' | 'succeeded' | 'unknown' | 'denied' = 'scheduled'; let materializations = 0; let failure: Error | undefined; let materialized: GoalWakeIntent | undefined
  const listeners = new Set<() => void>(); const disposers: Array<() => void> = []
  const snapshot = () => ({ protocol: 'dsh-event-source/v1' as const, sourceId: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: changed ? 'c'.repeat(64) : 'a'.repeat(64), target: { automationId: 'automation' }, highWaterSequence: 7 })
  let lastAfter = -1
  const source = { sourceSnapshot: () => snapshot(), firstEventAfter: (_snapshot: unknown, after: number) => { lastAfter = after; return emitted && after < 8 ? ({ sequence: 8, envelope: { protocol: 'dsh-external-event/v1' as const, source: { id: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: 'a'.repeat(64) }, event: { id: 'event', occurredAt: now, receivedAt: now }, observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: 'observed' as const }, trust: { method: 'local-observation' as const, content: 'untrusted' as const }, target: { automationId: 'automation' }, deduplicationKey: 'event-triggers:file:event' } }) : undefined }, subscribeSourceChanges: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) } }
  const wake = { preflight: () => {}, materialize: (input: GoalWakeIntent) => { materializations++; materialized = input; if (failure) throw failure }, inspect: () => materialized === undefined ? [] : [{ intent: materialized, state: wakeState }] } as unknown as GoalWakeRuntime
  const ctx = { inject: (_keys: readonly string[], callback: (value: unknown) => () => void) => { callback({ eventTriggers: source }) }, effect: (setup: () => () => void) => { disposers.push(setup()) } } as unknown as Context
  const runtime = new GoalEventWaitRuntime(ctx, path, wake, () => { if (!policyAllowed) throw new Error('assistant-goals: event wait policy denied'); return record }, () => proactive)
  const intent = (): GoalEventWaitIntent => ({ id: 'event-wait', wake: { scope, goalId: record.id, definition: record.definition, native: record.native, attestation: { scope: { workspace: scope.workspace, preset: scope.preset }, principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1, sessionId: 'session' }, ownerRouteId: 'route', budgetId: 'budget' }, source: snapshot(), createdAt: now - 1, expiresAt: now + 10_000, runTimeoutMs: 1_000 })
  return { runtime, intent, scope, close: () => { for (const dispose of disposers) dispose() }, emitChange: () => { for (const listener of listeners) listener() }, get materializations() { return materializations }, get materialized() { return materialized }, get lastAfter() { return lastAfter }, set policyAllowed(value: boolean) { policyAllowed = value }, set changed(value: boolean) { changed = value }, set emitted(value: boolean) { emitted = value }, set wakeState(value: typeof wakeState) { wakeState = value }, set failure(value: Error | undefined) { failure = value }, set record(value: GoalRecord) { record = value }, get record() { return record } }
}

describe('durable event wait lifecycle', () => {
  it('captures an already committed event during prepare and does not rematerialize on repeated hints', () => {
    const f = fixture(); const wait = f.runtime.prepare(f.intent())
    expect(wait).toMatchObject({ state: 'materialized', match: { sequence: 8 } }); expect(f.materializations).toBe(1)
    f.emitChange(); f.emitChange(); expect(f.materializations).toBe(1)
  })
  it('blocks resumed event wakes after policy revocation, expiry, or source change', () => {
    const policy = fixture(); policy.runtime.prepare(policy.intent()); policy.policyAllowed = false
    expect(() => policy.runtime.assertWakeCurrent(policy.materialized!)).toThrow('event wait policy denied')
    vi.useFakeTimers({ toFake: ['Date'] })
    const expired = fixture(); expired.runtime.prepare(expired.intent()); const wake = expired.materialized!
    vi.setSystemTime(wake.expiresAt)
    expect(() => expired.runtime.assertWakeCurrent(wake)).toThrow()
    vi.useRealTimers()
    const source = fixture(); source.runtime.prepare(source.intent()); source.changed = true
    expect(() => source.runtime.assertWakeCurrent(source.materialized!)).toThrow()
  })
  it('restores the exact matched wake after materialize acknowledgement loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-wait-runtime-')); roots.push(root); const path = join(root, 'waits.sqlite')
    const first = fixture(path); first.failure = new Error('lost acknowledgement')
    expect(() => first.runtime.prepare(first.intent())).toThrow('lost acknowledgement')
    const matched = first.runtime.inspect(first.scope, 'goal')[0]!.match!.wake
    first.close()
    const second = fixture(path, first.record); second.emitted = false; second.runtime.reconcile()
    expect(second.materialized).toEqual(matched); expect(second.materializations).toBe(1); second.close()
  })
  it('expires a persisted match before attempting recovery after its dispatch deadline', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const f = fixture(); f.failure = new Error('scheduler unavailable')
    expect(() => f.runtime.prepare(f.intent())).toThrow('scheduler unavailable')
    const matched = f.runtime.inspect(f.scope, 'goal')[0]!.match!.wake
    vi.setSystemTime(matched.expiresAt); f.runtime.reconcile()
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'terminal', reason: 'expired', match: { wake: matched } }])
    expect(f.materializations).toBe(1); f.close()
  })
  it('keeps the event guard alive when native complete is observed before wake settlement', () => {
    const f = fixture(); f.runtime.prepare(f.intent()); f.wakeState = 'dispatched'
    f.record = { ...f.record, native: { ...f.record.native, phase: 'complete', revision: 5 } }
    f.runtime.reconcile()
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'materialized' }])
    expect(() => f.runtime.assertWakeCurrent(f.materialized!)).not.toThrow()
  })
  it('lets a selected profile prepare without waking and persists its consumed event cursor', () => {
    const proactive = { evaluate: vi.fn(() => ({ disposition: 'consume' as const, decision: { eventSequence: 8 } })) }
    const f = fixture(':memory:', undefined, proactive); const wait = f.intent()
    const prepared = f.runtime.prepare({ ...wait, opportunityProfile: 'prepare-profile' })
    expect(prepared.state).toBe('waiting'); expect(f.materializations).toBe(0)
    f.runtime.reconcile(); expect(f.lastAfter).toBe(8); expect(proactive.evaluate).toHaveBeenCalledTimes(1); f.close()
  })
  it('does not wake while a selected profile defers an event', () => {
    const f = fixture(':memory:', undefined, { evaluate: () => ({ disposition: 'defer', decision: { eventSequence: 8 } }) })
    expect(f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' }).state).toBe('waiting')
    expect(f.materializations).toBe(0); f.close()
  })
  it('matures a deferred selected profile on the durable runtime timer without a new source hint', () => {
    vi.useFakeTimers()
    let calls = 0
    const f = fixture(':memory:', undefined, { evaluate: () => ({ disposition: ++calls === 1 ? 'defer' : 'execute', decision: { eventSequence: 8 } }) })
    expect(f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' }).state).toBe('waiting')
    expect(f.materializations).toBe(0); vi.advanceTimersByTime(1_000)
    expect(f.materializations).toBe(1); expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'materialized', match: { sequence: 8 } }]); f.close()
  })
  it('denies a selected profile if its service disappears before observation', () => {
    const f = fixture(); const wait = f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' })
    expect(wait).toMatchObject({ state: 'terminal', reason: 'denied' }); expect(f.materializations).toBe(0); f.close()
  })
})
