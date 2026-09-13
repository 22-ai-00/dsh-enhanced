import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { externalEventDigest } from '@dsh-enhanced/assistant-automations/external-event'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalEventWaitRuntime } from '../src/event-wait.ts'
import { GoalEventWaitStore, type GoalEventWaitIntent } from '../src/event-wait-store.ts'
import type { GoalExecutionRun, GoalRecord } from '../src/types.ts'
import type { GoalWakeIntent } from '../src/wake-store.ts'
import type { GoalWakeRuntime } from '../src/wake.ts'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

type ProactiveInput = {
  waitId: string; profileId: string; scope: GoalRecord['scope']; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string; event: { id: string; sequence: number; digest: string }; expiresAt: number
}
type ProactiveDecisionIdentity = {
  waitId: string; profileId: string; scope: GoalRecord['scope']; goalId: string; sessionId: string
  definitionDigest: string; objective: string; nativeGoalId: string; nativeRevision: number; ownerRouteId: string
  sourceDigest: string; sourceId: string; eventId: string; eventSequence: number; eventDigest: string; expiresAt: number
}
type FakeProactive = { evaluate: (input: ProactiveInput) => { disposition: 'defer' | 'consume' | 'execute'; decision: unknown } }
const executionDecision = (input: ProactiveInput): ProactiveDecisionIdentity => ({
  waitId: input.waitId, profileId: input.profileId, scope: input.scope, goalId: input.goalId, sessionId: input.sessionId,
  definitionDigest: input.definitionDigest, objective: input.objective, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, ownerRouteId: input.ownerRouteId,
  sourceDigest: input.sourceDigest, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence,
  eventDigest: input.event.digest, expiresAt: input.expiresAt,
})

function fixture(path = ':memory:', prior?: GoalRecord, proactive?: FakeProactive) {
  const now = Date.now(); const objective = 'resume after an event'
  const scope = { principalId: 'owner', principalRecordId: 'row', principalVersion: 1, workspace: '/tmp/event-wait', preset: 'primary' }
  let record: GoalRecord = prior ?? { id: 'goal', scope, originalObjective: objective, definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session', goalId: 'native', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: now }, checkpoint: { nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }, version: 1, createdAt: now, updatedAt: now }
  let policyAllowed = true; let retired = false; let changed = false; let sourceVersion = '1'; let emitted = true; let wakeState: 'scheduled' | 'dispatched' | 'succeeded' | 'unknown' | 'denied' = 'scheduled'; let materializations = 0; let failure: Error | undefined; let materialized: GoalWakeIntent | undefined
  const claims: unknown[] = []; const retirements: unknown[] = []; let claimFailure: Error | undefined
  const listeners = new Set<() => void>(); const disposers: Array<() => void> = []
  const snapshot = () => ({ protocol: 'dsh-event-source/v1' as const, sourceId: 'event-triggers:file', kind: 'file' as const, version: sourceVersion, configDigest: changed ? 'c'.repeat(64) : 'a'.repeat(64), target: { automationId: 'automation' }, highWaterSequence: 7 })
  let lastAfter = -1
  const event = { protocol: 'dsh-external-event/v1' as const, source: { id: 'event-triggers:file', kind: 'file' as const, version: '1', configDigest: 'a'.repeat(64) }, event: { id: 'event', occurredAt: now, receivedAt: now }, observation: { digest: 'b'.repeat(64), revision: '1', timeBasis: 'observed' as const }, trust: { method: 'local-observation' as const, content: 'untrusted' as const }, target: { automationId: 'automation' }, deduplicationKey: 'event-triggers:file:event' }
  const source = { sourceSnapshot: () => { if (retired) throw new Error('retired source'); return snapshot() }, canSettleGoalSource: () => retired && !changed && policyAllowed, firstEventAfter: (_snapshot: unknown, after: number) => { lastAfter = after; return emitted && after < 8 ? ({ sequence: 8, envelope: event }) : undefined }, subscribeSourceChanges: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) }, claimGoalSource: (claim: unknown) => { claims.push(claim); if (claimFailure) throw claimFailure; return true }, retireGoalSource: (claim: unknown) => { retirements.push(claim); retired = true; return true } }
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
  it('permits independent completion only for its current exact paused wait and admitted run', () => {
    const f = fixture(); f.emitted = false
    const wait = f.runtime.prepare(f.intent())
    const run: GoalExecutionRun = { intent: { runId: 'run', scope: f.scope, objective: f.record.definition.objective, dependencies: [],
      task: { kind: 'goal-step', ref: 'run', goal: { id: f.record.id, definitionVersion: f.record.definition.version,
        definitionDigest: f.record.definition.digest, stepId: 'step', runId: 'run', sessionId: f.record.native.sessionId,
        nativeGoalId: f.record.native.goalId, nativeRevision: f.record.native.revision - 1 } },
      admission: { issuedAt: Date.now(), expiresAt: wait.intent.expiresAt, maxGoalRounds: f.record.native.maxGoalRounds,
        round: f.record.native.roundsStarted, authorizationDigest: 'a'.repeat(64) } },
      dispatchedAt: Date.now(), execution: { status: 'succeeded', quiescent: true, completedAt: Date.now() } }
    expect(f.runtime.acceptsPausedOutcomeSettlement(f.record, run)).toBe(true)
    expect(f.runtime.acceptsPausedOutcomeSettlement(f.record, { ...run, intent: { ...run.intent, task: { ...run.intent.task,
      goal: { ...run.intent.task.goal, nativeRevision: run.intent.task.goal.nativeRevision - 1 } } } })).toBe(false)
    f.sourceVersion = '2'; expect(f.runtime.acceptsPausedOutcomeSettlement(f.record, run)).toBe(false)
    f.sourceVersion = '1'; f.policyAllowed = false; expect(f.runtime.acceptsPausedOutcomeSettlement(f.record, run)).toBe(false)
    f.policyAllowed = true; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(wait.intent.expiresAt)
    expect(f.runtime.acceptsPausedOutcomeSettlement(f.record, run)).toBe(false); vi.useRealTimers()
    const manual = fixture(); manual.emitted = false
    expect(manual.runtime.acceptsPausedOutcomeSettlement(manual.record, run)).toBe(false)
    f.close(); manual.close()
  })

  it('uses only a settled exact wait as historical proof for an earlier wake completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-wait-history-')); roots.push(root); const path = join(root, 'waits.sqlite')
    const first = fixture(path); first.emitted = false
    const wait = first.runtime.prepare(first.intent())
    const priorWake = { sessionId: first.record.native.sessionId, goalId: first.record.native.goalId,
      revision: first.record.native.revision - 2, roundsStarted: first.record.native.roundsStarted - 1, maxGoalRounds: first.record.native.maxGoalRounds }
    const run: GoalExecutionRun = { intent: { runId: 'resumed-run', scope: first.scope, objective: first.record.definition.objective, dependencies: [],
      task: { kind: 'goal-step', ref: 'resumed-run', goal: { id: first.record.id, definitionVersion: first.record.definition.version,
        definitionDigest: first.record.definition.digest, stepId: 'step', runId: 'resumed-run', sessionId: priorWake.sessionId,
        nativeGoalId: priorWake.goalId, nativeRevision: priorWake.revision + 1 } },
      admission: { issuedAt: Date.now(), expiresAt: wait.intent.expiresAt, maxGoalRounds: priorWake.maxGoalRounds,
        round: first.record.native.roundsStarted, authorizationDigest: 'a'.repeat(64) } },
      dispatchedAt: Date.now(), execution: { status: 'succeeded', quiescent: true, completedAt: Date.now() } }
    const completed = { ...first.record, native: { ...first.record.native, phase: 'complete' as const, revision: first.record.native.revision + 1 } }
    first.record = completed; first.runtime.reconcile()
    expect(first.runtime.inspect(first.scope, completed.id)).toMatchObject([{ state: 'terminal', reason: 'settled' }])
    expect(first.runtime.acceptsHistoricalPausedOutcomeCompletion(completed, priorWake, run)).toBe(true)
    expect(first.runtime.acceptsPausedOutcomeSettlement({ ...completed, native: wait.intent.wake.native }, run)).toBe(false)
    expect(first.runtime.acceptsHistoricalPausedOutcomeCompletion(completed, { ...priorWake, revision: priorWake.revision + 1 }, run)).toBe(false)
    expect(first.runtime.acceptsHistoricalPausedOutcomeCompletion(completed, priorWake, { ...run, execution: { status: 'unknown', quiescent: false, completedAt: Date.now() } })).toBe(false)
    first.close()

    const restarted = fixture(path, completed); restarted.emitted = false
    expect(restarted.runtime.acceptsHistoricalPausedOutcomeCompletion(completed, priorWake, run)).toBe(true)
    restarted.close()

    const matched = fixture(); matched.failure = new Error('materialize failed')
    expect(() => matched.runtime.prepare(matched.intent())).toThrow('materialize failed')
    matched.record = completed
    expect(matched.runtime.acceptsHistoricalPausedOutcomeCompletion(completed, priorWake, run)).toBe(false)
    matched.close()
  })

  it('can leave an earlier completed successor wait behind the durable reconciliation cursor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-wait-cursor-')); roots.push(root); const path = join(root, 'waits.sqlite')
    const f = fixture(path); f.emitted = false
    const initial = f.intent()
    f.record = { ...f.record, native: { ...initial.wake.native, revision: 4, roundsStarted: 2 } }
    const store = new GoalEventWaitStore(path)
    try {
      const child = { ...initial, id: 'a-child', wake: { ...initial.wake, native: { ...initial.wake.native, revision: 4, roundsStarted: 2 } } }
      store.prepare(child)
      for (let index = 0; index < 33; index++) store.prepare({ ...child, id: `b-${String(index).padStart(2, '0')}`,
        wake: { ...child.wake, native: { ...child.wake.native, revision: 100 + index } } })
    } finally { store.close() }
    // The first page establishes a cursor beyond a-child while later rows remain.
    f.runtime.reconcile()
    f.record = { ...f.record, native: { ...initial.wake.native, phase: 'complete', revision: 5, roundsStarted: 2 } }
    // The next page sees only later IDs, so it cannot settle the exact a-child row yet.
    f.runtime.reconcile()
    const observed = new GoalEventWaitStore(path)
    try { expect(observed.get('a-child')).toMatchObject({ state: 'waiting' }) } finally { observed.close() }
    f.close()
  })

  it.each([false, true])('settles only the exact successor of a completed dispatched parent (source already retired: %s)', alreadyRetired => {
    const f = fixture(); const parent = f.runtime.prepare(f.intent())
    if (parent.match === undefined) throw new Error('parent wait did not materialize')
    f.wakeState = 'dispatched'
    f.record = { ...f.record, native: { ...f.record.native, revision: 4, roundsStarted: 2 } }
    f.emitted = false
    const child = f.runtime.prepare({ ...f.intent(), id: 'successor-wait', wake: { ...f.intent().wake,
      native: { ...f.intent().wake.native, revision: 4, roundsStarted: 2 } } })
    expect(child).toMatchObject({ state: 'waiting' })
    f.record = { ...f.record, native: { ...f.record.native, phase: 'complete', revision: 5 } }
    // A parent completion can retire the dedicated source before the cursor
    // returns to this earlier successor row. Settlement still needs the same
    // exact source claim's canSettle authority, not a fresh observation.
    f.retired = alreadyRetired
    expect(() => f.runtime.assertWakeCurrent(parent.match!.wake, 'terminal')).not.toThrow()
    expect(f.runtime.inspect(f.scope, f.record.id).find(wait => wait.intent.id === 'successor-wait')).toMatchObject({ state: 'terminal', reason: 'settled' })
    f.close()
  })

  it('leaves the exact successor waiting when its completed parent loses source settlement authority', () => {
    const f = fixture(); const parent = f.runtime.prepare(f.intent())
    if (parent.match === undefined) throw new Error('parent wait did not materialize')
    f.wakeState = 'dispatched'
    f.record = { ...f.record, native: { ...f.record.native, revision: 4, roundsStarted: 2 } }
    f.emitted = false
    const child = f.runtime.prepare({ ...f.intent(), id: 'denied-successor' })
    expect(child.state).toBe('waiting')
    f.record = { ...f.record, native: { ...f.record.native, phase: 'complete', revision: 5 } }
    f.retired = true; f.changed = true
    expect(() => f.runtime.assertWakeCurrent(parent.match!.wake, 'terminal')).toThrow()
    expect(f.runtime.inspect(f.scope, f.record.id).find(wait => wait.intent.id === child.intent.id)?.state).toBe('waiting')
    f.close()
  })

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
  it('terminalizes an old wait when the parent dependency set changes without a native revision change', () => {
    const f = fixture(); f.emitted = false
    const prepared = f.runtime.prepare(f.intent())
    const dependency = { goalId: 'dependency-a', definitionVersion: 1, definitionDigest: 'a'.repeat(64) }
    f.record = { ...f.record, checkpoint: { ...f.record.checkpoint, dependencies: [dependency.goalId], dependencyBindings: [dependency] }, version: f.record.version + 1 }
    f.emitted = true; f.emitChange()
    expect(f.runtime.inspect(f.scope, f.record.id)).toMatchObject([{ intent: { id: prepared.intent.id }, state: 'terminal', reason: 'invalid-current' }])
    expect(f.materializations).toBe(0)
    f.close()
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
    expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'terminal')).not.toThrow()
    expect(() => f.runtime.assertWakeCurrent(f.materialized!, 'before-resume')).toThrow()
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
    const f = fixture(':memory:', undefined, { evaluate: input => {
      calls++
      return calls === 1
        ? { disposition: 'defer', decision: { eventSequence: input.event.sequence } }
        : { disposition: 'execute', decision: executionDecision(input) }
    } })
    expect(f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' }).state).toBe('waiting')
    expect(f.materializations).toBe(0); vi.advanceTimersByTime(1_000)
    expect(f.materializations).toBe(1); expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'materialized', match: { sequence: 8 } }]); f.close()
  })
  it.each([
    ['waitId', (value: ProactiveDecisionIdentity) => ({ ...value, waitId: 'other-wait' })],
    ['profileId', (value: ProactiveDecisionIdentity) => ({ ...value, profileId: 'other-profile' })],
    ['scope', (value: ProactiveDecisionIdentity) => ({ ...value, scope: { ...value.scope, workspace: '/tmp/other-event-wait' } })],
    ['goalId', (value: ProactiveDecisionIdentity) => ({ ...value, goalId: 'other-goal' })],
    ['sessionId', (value: ProactiveDecisionIdentity) => ({ ...value, sessionId: 'other-session' })],
    ['definitionDigest', (value: ProactiveDecisionIdentity) => ({ ...value, definitionDigest: '0'.repeat(64) })],
    ['objective', (value: ProactiveDecisionIdentity) => ({ ...value, objective: 'other objective' })],
    ['nativeGoalId', (value: ProactiveDecisionIdentity) => ({ ...value, nativeGoalId: 'other-native-goal' })],
    ['nativeRevision', (value: ProactiveDecisionIdentity) => ({ ...value, nativeRevision: value.nativeRevision + 1 })],
    ['ownerRouteId', (value: ProactiveDecisionIdentity) => ({ ...value, ownerRouteId: 'other-route' })],
    ['sourceId', (value: ProactiveDecisionIdentity) => ({ ...value, sourceId: 'event-triggers:other' })],
    ['sourceDigest', (value: ProactiveDecisionIdentity) => ({ ...value, sourceDigest: '0'.repeat(64) })],
    ['eventId', (value: ProactiveDecisionIdentity) => ({ ...value, eventId: 'other-event' })],
    ['eventDigest', (value: ProactiveDecisionIdentity) => ({ ...value, eventDigest: '0'.repeat(64) })],
    ['expiresAt', (value: ProactiveDecisionIdentity) => ({ ...value, expiresAt: value.expiresAt - 1 })],
  ] as const)('rejects an execute decision with the same sequence but mismatched %s', (_field, mutate) => {
    const f = fixture(':memory:', undefined, { evaluate: input => ({ disposition: 'execute', decision: mutate(executionDecision(input)) }) })
    expect(() => f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' })).toThrow('opportunity execution does not bind the observed event')
    expect(f.materializations).toBe(0)
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'waiting' }])
    f.close()
  })
  it('rejects an execute decision bound behind the current event', () => {
    const f = fixture(':memory:', undefined, { evaluate: input => ({
      disposition: 'execute', decision: { ...executionDecision(input), eventSequence: 7 },
    }) })
    expect(() => f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' })).toThrow('opportunity execution does not bind the observed event')
    expect(f.materializations).toBe(0)
    expect(f.runtime.inspect(f.scope, 'goal')).toMatchObject([{ state: 'waiting' }])
    f.close()
  })
  it('waits for a future execute decision event instead of treating an earlier event as its authority', () => {
    const f = fixture(':memory:', undefined, { evaluate: input => ({
      disposition: 'execute', decision: { ...executionDecision(input), eventId: 'event-9', eventSequence: 9, eventDigest: 'f'.repeat(64) },
    }) })
    expect(f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' })).toMatchObject({ state: 'waiting' })
    expect(f.materializations).toBe(0)
    f.close()
  })
  it('denies a selected profile if its service disappears before observation', () => {
    const f = fixture(); const wait = f.runtime.prepare({ ...f.intent(), opportunityProfile: 'execute-profile' })
    expect(wait).toMatchObject({ state: 'terminal', reason: 'denied' }); expect(f.materializations).toBe(0); f.close()
  })
})
