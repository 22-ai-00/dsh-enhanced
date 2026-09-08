import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { externalEventDigest } from '@dsh-enhanced/assistant-automations/external-event'
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
  let policyAllowed = true; let retired = false; let changed = false; let sourceVersion = '1'; let emitted = true; let wakeState: 'scheduled' | 'dispatched' | 'succeeded' | 'unknown' | 'denied' = 'scheduled'; let materializations = 0; let failure: Error | undefined; let materialized: GoalWakeIntent | undefined
  const claims: unknown[] = []; const retirements: unknown[] = []; let claimFailure: Error | undefined
  const listeners = new Set<() => void>(); const disposers: Array<() => void> = []
  const snapshot = () => ({ protocol: 'dsh-event-source/v1' as const, sourceId: 'event-triggers:file', kind: 'file' as const, version: sourceVersion, configDigest: changed ? 'c'.repeat(64) : 'a'.repeat(64), target: { automationId: 'automation' }, highWaterSequence: 7 })
  let lastAfter = -1
  const event = { protocol: 'dsh-external-event/v1' as const, source: { id: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: 'a'.repeat(64) }, event: { id: 'event', occurredAt: now, receivedAt: now }, observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: 'observed' as const }, trust: { method: 'local-observation' as const, content: 'untrusted' as const }, target: { automationId: 'automation' }, deduplicationKey: 'event-triggers:file:event' }
  const source = { sourceSnapshot: () => { if (retired) throw new Error('retired source'); return snapshot() }, canSettleGoalSource: () => retired && !changed && policyAllowed, firstEventAfter: (_snapshot: unknown, after: number) => { lastAfter = after; return emitted && after < 8 ? ({ sequence: 8, envelope: event }) : undefined }, subscribeSourceChanges: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, claimGoalSource: (claim: unknown) => { claims.push(claim); if (claimFailure) throw claimFailure; return true }, retireGoalSource: (claim: unknown) => { retirements.push(claim); return true } }
  const wake = { preflight: () => {}, materialize: (input: GoalWakeIntent) => { materializations++; materialized = input; if (failure) throw failure }, inspect: () => materialized === undefined ? [] : [{ intent: materialized, state: wakeState }] } as unknown as GoalWakeRuntime
  const ctx = { inject: (_keys: readonly string[], callback: (value: unknown) => () => void) => { callback({ eventTriggers: source }) }, effect: (setup: () => () => void) => { disposers.push(setup()) } } as unknown as Context
  const runtime = new GoalEventWaitRuntime(ctx, path, wake, () => { if (!policyAllowed) throw new Error('assistant-goals: event wait policy denied'); return record }, () => proactive)
  const intent = (): GoalEventWaitIntent => ({ id: 'event-wait', wake: { scope, goalId: record.id, definition: record.definition, native: record.native, attestation: { scope: { workspace: scope.workspace, preset: scope.preset }, principalId: scope.principalId, principalLineage: { principalRecordId: scope.principalRecordId, principalVersion: 1 }, bindingId: 'binding', bindingVersion: 1, bindingGeneration: 1, sessionId: 'session' }, ownerRouteId: 'route', budgetId: 'budget' }, source: snapshot(), createdAt: now - 1, expiresAt: now + 10_000, runTimeoutMs: 1_000 })
  return { runtime, intent, scope, event, close: () => { for (const dispose of disposers) dispose() }, emitChange: () => { for (const listener of listeners) listener() }, get materializations() { return materializations }, get materialized() { return materialized }, get lastAfter() { return lastAfter }, get claims() { return claims }, get retirements() { return retirements }, set claimFailure(value: Error | undefined) { claimFailure = value }, set policyAllowed(value: boolean) { policyAllowed = value }, set retired(value: boolean) { retired = value }, set changed(value: boolean) { changed = value }, set sourceVersion(value: string) { sourceVersion = value }, set emitted(value: boolean) { emitted = value }, set wakeState(value: typeof wakeState) { wakeState = value }, set failure(value: Error | undefined) { failure = value }, set record(value: GoalRecord) { record = value }, get record() { return record } }
}

function preparationFixture() {
  const proactive = { evaluate: () => ({ disposition: 'consume' as const, decision: { eventSequence: 8 } }) }
  const f = fixture(':memory:', undefined, proactive)
  const prepared = f.runtime.prepare({ ...f.intent(), opportunityProfile: 'prepare-profile' })
  const authority = {
    waitId: prepared.intent.id,
    profileId: prepared.intent.opportunityProfile!,
    scope: prepared.intent.wake.scope,
    goalId: prepared.intent.wake.goalId,
    sessionId: prepared.intent.wake.native.sessionId,
    definitionDigest: prepared.intent.wake.definition.digest,
    objective: f.record.native.objective,
    nativeGoalId: prepared.intent.wake.native.goalId,
    nativeRevision: prepared.intent.wake.native.revision,
    ownerRouteId: prepared.intent.wake.ownerRouteId,
    sourceDigest: prepared.intent.source.configDigest,
    sourceId: prepared.intent.source.sourceId,
    eventId: f.event.event.id,
    eventSequence: 8,
    eventDigest: externalEventDigest(f.event),
    expiresAt: prepared.intent.expiresAt,
  }
  return { f, prepared, authority }
}

describe('durable event wait lifecycle', () => {
  it('accepts a paused checkpoint only while its exact wait, source and owner remain current', () => {
    const f = fixture(); f.emitted = false
    expect(f.runtime.acceptsPausedRecord(f.record)).toBe(false)
    f.runtime.prepare(f.intent())
    expect(f.runtime.acceptsPausedRecord(f.record)).toBe(true)
    expect(f.runtime.acceptsPausedRecord({ ...f.record, native: { ...f.record.native, revision: 4 } })).toBe(false)
    f.policyAllowed = false; expect(f.runtime.acceptsPausedRecord(f.record)).toBe(false)
    f.policyAllowed = true; f.changed = true; expect(f.runtime.acceptsPausedRecord(f.record)).toBe(false)
    f.changed = false; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(f.intent().expiresAt)
    expect(f.runtime.acceptsPausedRecord(f.record)).toBe(false); f.close()
  })
  it('captures an already committed event during prepare and does not rematerialize on repeated hints', () => {
    const f = fixture(); const wait = f.runtime.prepare(f.intent())
    expect(wait).toMatchObject({ state: 'materialized', match: { sequence: 8 } }); expect(f.materializations).toBe(1)
    f.emitChange(); f.emitChange(); expect(f.materializations).toBe(1)
  })
  it('claims a dedicated source once and retires it from the trusted goal record before any wake is materialized', () => {
    const f = fixture(); f.emitted = false
    f.runtime.prepare(f.intent())
    expect(f.claims).toHaveLength(2)
    expect(f.claims[1]).toEqual(f.claims[0])
    f.record = { ...f.record, native: { ...f.record.native, phase: 'complete', revision: 5 } }
    f.runtime.reconcile()
    expect(f.retirements).toHaveLength(1)
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'terminal', reason: 'settled' }])

    f.close()
  })
  it('does not persist a waiting row when another goal already owns the dedicated source', () => {
    const f = fixture(); f.emitted = false; f.claimFailure = new Error('already claimed by another goal')
    expect(() => f.runtime.prepare(f.intent())).toThrow(/already claimed/)
    expect(f.runtime.inspect(f.scope, 'goal')).toEqual([])
    expect(f.materializations).toBe(0); f.close()
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
  it('a retired dedicated source permits only final settlement of its dispatched completed Goal', () => {
    const f = fixture(); f.runtime.prepare(f.intent()); f.wakeState = 'dispatched'
    f.record = { ...f.record, native: { ...f.record.native, phase: 'complete', revision: 5 } }; f.retired = true
    f.runtime.reconcile()
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'materialized' }])
    expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'terminal')).not.toThrow()
    expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'before-resume')).toThrow()
    expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'running')).toThrow()
    f.policyAllowed = false; expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'terminal')).toThrow()
    f.policyAllowed = true; f.changed = true; expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'terminal')).toThrow()
    f.changed = false; f.wakeState = 'succeeded'; f.runtime.reconcile()
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'terminal', reason: 'settled' }]); f.close()
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
  it('authorizes a current selected event for read-only preparation without waking or changing the native goal', () => {
    const { f, prepared, authority } = preparationFixture()
    const phase = f.record.native.phase
    expect(prepared.state).toBe('waiting')
    expect(() => f.runtime.assertPreparationCurrent(authority)).not.toThrow()
    expect(f.materializations).toBe(0)
    expect(f.record.native.phase).toBe(phase)
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'waiting' }])
    f.close()
  })
  it('rejects stale or forged preparation authority without waking or changing the native goal', () => {
    const assertRejectedReadOnly = (mutate: (f: ReturnType<typeof fixture>, authority: ReturnType<typeof preparationFixture>['authority']) => void) => {
      const prepared = preparationFixture(); const { f, authority } = prepared
      mutate(f, authority)
      const phase = f.record.native.phase
      expect(() => f.runtime.assertPreparationCurrent(authority)).toThrow()
      expect(f.materializations).toBe(0)
      expect(f.record.native.phase).toBe(phase)
      expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'waiting' }])
      f.close()
    }
    assertRejectedReadOnly((f, authority) => { f.record = { ...f.record, native: { ...f.record.native, revision: authority.nativeRevision + 1 } } })
    assertRejectedReadOnly(f => { f.record = { ...f.record, native: { ...f.record.native, phase: 'complete' } } })
    assertRejectedReadOnly(f => { f.sourceVersion = '2' })
    assertRejectedReadOnly((_f, authority) => { authority.eventDigest = '0'.repeat(64) })
    assertRejectedReadOnly((_f, authority) => { authority.scope = { ...authority.scope, workspace: '/tmp/other-event-wait' } })
  })
  it('rejects expired preparation authority without waking or changing the native goal', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { f, authority } = preparationFixture()
    vi.setSystemTime(authority.expiresAt)
    const phase = f.record.native.phase
    expect(() => f.runtime.assertPreparationCurrent(authority)).toThrow()
    expect(f.materializations).toBe(0)
    expect(f.record.native.phase).toBe(phase)
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'waiting' }])
    f.close()
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
