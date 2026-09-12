import { afterEach, describe, expect, test, vi } from 'vitest'
import { SkillStore, type SkillRepairContinuation } from '../src/store.ts'
import { RepairContinuationRuntime, type RepairRuntimePorts } from '../src/repair-runtime.ts'

const scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' }
const authorization = { invocationId: 'repair', ownerRouteId: 'route', source: { goalId: 'source', sessionId: 'session', nativeGoalId: 'native', definitionDigest: 'a'.repeat(64) }, profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'repair-skill', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 1, expiresAt: Date.now() + 60_000 }
function ports(overrides: Partial<RepairRuntimePorts> = {}): RepairRuntimePorts {
  return { assertCurrent() {}, inspectTrigger: async () => ({ proof: 'trigger' }), createRepair: async () => ({ sessionId: 'repair-session', goalId: 'repair-goal' }), inspectRepair: async () => 'achieved', capture: async () => ({ candidateId: 'candidate' }), compare: async () => ({ deploymentId: 'deployment' }), inspectDeployment: async () => 'complete', inspectNextIteration: async () => undefined, assertNextIteration() {}, ...overrides }
}
function created(store: SkillStore, invocationId = 'repair', expiresAt = Date.now() + 60_000, maxIterations = 1): SkillRepairContinuation { return store.createRepairContinuation(scope, { ...authorization, invocationId, expiresAt, maxIterations, ...(maxIterations > 1 ? { profileSequence: [{ id: 'profile', digest: 'b'.repeat(64) }, { id: 'followup', digest: 'd'.repeat(64) }] } : {}) }, { route: 'receipt' }) }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function stage(store: SkillStore, record: SkillRepairContinuation, states: readonly Exclude<SkillRepairContinuation['state'], 'armed'>[]): SkillRepairContinuation {
  let current = record
  for (const state of states) current = store.transitionRepairContinuation(scope, current.id, current.revision, state, current.checkpoint)
  return current
}
afterEach(() => vi.useRealTimers())

describe('repair continuation runtime', () => {
  test('reacquires the original repair once before inspecting it without creating another Goal', async () => {
    const store = new SkillStore(':memory:'), record = stage(store, created(store), ['source-confirmed', 'creating-repair', 'repairing'])
    const order: string[] = [], createRepair = vi.fn()
    const runtime = new RepairContinuationRuntime(store, ports({ createRepair, ensureRepair: async () => { order.push('resume') }, inspectRepair: async () => { order.push('inspect'); return 'achieved' } }))
    await Promise.all([runtime.tick(scope, record.id), runtime.tick(scope, record.id)])
    expect(order).toEqual(['resume', 'inspect']); expect(createRepair).not.toHaveBeenCalled()
    expect(store.getRepairContinuation(scope, record.id)?.state).toBe('repair-achieved')
    await runtime.dispose(); store.close()
  })
  test('an unconfirmed recovery remains unknown without dispatching capture or replacement work', async () => {
    const store = new SkillStore(':memory:'), record = stage(store, created(store), ['source-confirmed', 'creating-repair', 'repairing', 'repair-achieved'])
    const capture = vi.fn(), createRepair = vi.fn()
    const runtime = new RepairContinuationRuntime(store, ports({ capture, createRepair, ensureRepair: async () => { throw new Error('old worker still owns execution') } }))
    await expect(runtime.tick(scope, record.id)).rejects.toThrow('old worker still owns execution')
    expect(store.getRepairContinuation(scope, record.id)).toMatchObject({ state: 'unknown', checkpoint: { failure: 'repair-recovery-unconfirmed' } })
    await runtime.tick(scope, record.id); expect(capture).not.toHaveBeenCalled(); expect(createRepair).not.toHaveBeenCalled()
    await runtime.dispose(); store.close()
  })
  test('checkpoints every durable result and advances one finite phase per tick', async () => {
    const store = new SkillStore(':memory:'), runtime = new RepairContinuationRuntime(store, ports()); let record = created(store)
    for (const state of ['source-confirmed', 'repairing', 'repair-achieved', 'candidate-staged', 'watching', 'complete'] as const) {
      record = await runtime.tick(scope, record.id); expect(record.state).toBe(state)
    }
    expect(record.checkpoint).toMatchObject({ trigger: { proof: 'trigger' }, repair: { sessionId: 'repair-session', goalId: 'repair-goal' }, candidateId: 'candidate', deploymentId: 'deployment' })
    await runtime.dispose(); store.close()
  })
  test.each([
    ['creating-repair', ['source-confirmed', 'creating-repair'], 'createRepair'],
    ['capturing', ['source-confirmed', 'creating-repair', 'repairing', 'repair-achieved', 'capturing'], 'capture'],
    ['comparing', ['source-confirmed', 'creating-repair', 'repairing', 'repair-achieved', 'capturing', 'candidate-staged', 'comparing'], 'compare'],
  ] as const)('recovery marks %s unknown and never repeats its dispatched port', async (_state, states, port) => {
    const store = new SkillStore(':memory:'), record = stage(store, created(store), states), calls = { createRepair: 0, capture: 0, compare: 0 }
    const runtime = new RepairContinuationRuntime(store, ports({ createRepair: async () => { calls.createRepair++; return { sessionId: 's', goalId: 'g' } }, capture: async () => { calls.capture++; return { candidateId: 'c' } }, compare: async () => { calls.compare++; return { deploymentId: 'd' } } }))
    expect(runtime.recover(scope, record.id)).toMatchObject({ state: 'unknown' })
    await expect(runtime.tick(scope, record.id)).resolves.toMatchObject({ state: 'unknown' }); expect(calls[port]).toBe(0)
    await runtime.dispose(); store.close()
  })
  test('single-flights concurrent ticks and rejects failed authority before dispatch', async () => {
    const store = new SkillStore(':memory:'), record = created(store); let calls = 0
    const runtime = new RepairContinuationRuntime(store, ports({ inspectTrigger: async () => { calls++; await Promise.resolve(); return { ok: true } } }))
    await Promise.all([runtime.tick(scope, record.id), runtime.tick(scope, record.id)]); expect(calls).toBe(1)
    const denied = new RepairContinuationRuntime(store, ports({ assertCurrent: () => { throw new Error('revoked') } }))
    await expect(denied.tick(scope, record.id)).rejects.toThrow('revoked')
    expect(store.getRepairContinuation(scope, record.id)).toMatchObject({ state: 'rejected' })
    await runtime.dispose(); await denied.dispose(); store.close()
  })
  test('expiry is terminal before a port dispatch', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const store = new SkillStore(':memory:'), record = created(store, 'expiry', Date.now() + 1); vi.advanceTimersByTime(2)
    let calls = 0; const runtime = new RepairContinuationRuntime(store, ports({ inspectTrigger: async () => { calls++; return {} } }))
    await expect(runtime.tick(scope, record.id)).rejects.toThrow(/expired/); expect(calls).toBe(0); expect(store.getRepairContinuation(scope, record.id)).toMatchObject({ state: 'expired' })
    await runtime.dispose(); store.close()
  })
  test('revoke during await remains terminal and prevents late repair advancement', async () => {
    const store = new SkillStore(':memory:'), initial = created(store, 'revoke'), source = stage(store, initial, ['source-confirmed']), pending = deferred<{ sessionId: string; goalId: string }>()
    const runtime = new RepairContinuationRuntime(store, ports({ createRepair: () => pending.promise }))
    const work = runtime.tick(scope, source.id); await vi.waitFor(() => expect(store.getRepairContinuation(scope, source.id)?.state).toBe('creating-repair'))
    expect(runtime.recover(scope, source.id)).toMatchObject({ state: 'creating-repair' })
    const dispatched = store.getRepairContinuation(scope, source.id)!; store.transitionRepairContinuation(scope, dispatched.id, dispatched.revision, 'revoked', { revoked: true })
    pending.resolve({ sessionId: 'late', goalId: 'late' }); await expect(work).rejects.toThrow()
    expect(store.getRepairContinuation(scope, source.id)).toMatchObject({ state: 'revoked' })
    await runtime.dispose(); store.close()
  })
  test('dispose aborts a port and shares one disposal settlement', async () => {
    const store = new SkillStore(':memory:'), record = created(store, 'dispose'); let aborted = false
    const runtime = new RepairContinuationRuntime(store, ports({ inspectTrigger: async (_record, signal) => await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) }, { once: true })) }))
    const work = runtime.tick(scope, record.id), first = runtime.dispose(), second = runtime.dispose()
    expect(first).toBe(second); await expect(work).rejects.toThrow('aborted'); await first; expect(aborted).toBe(true)
    expect(runtime.recover(scope, record.id)).toMatchObject({ state: 'rejected' }); store.close()
  })
  test('distinguishes failure before dispatch from failure after a checkpointed dispatch', async () => {
    const first = new SkillStore(':memory:'), before = created(first, 'before')
    const denied = new RepairContinuationRuntime(first, ports({ assertCurrent: () => { throw new Error('denied') } }))
    await expect(denied.tick(scope, before.id)).rejects.toThrow('denied'); expect(first.getRepairContinuation(scope, before.id)).toMatchObject({ state: 'rejected' })
    const second = new SkillStore(':memory:'), after = stage(second, created(second, 'after'), ['source-confirmed'])
    const failed = new RepairContinuationRuntime(second, ports({ createRepair: async () => { throw new Error('network') } }))
    await expect(failed.tick(scope, after.id)).rejects.toThrow('network'); expect(second.getRepairContinuation(scope, after.id)).toMatchObject({ state: 'unknown' })
    await denied.dispose(); await failed.dispose(); first.close(); second.close()
  })
  test('two concurrent tickAll callers share one global four-wide sweep and aggregate only after settlement', async () => {
    const store = new SkillStore(':memory:'); for (let index = 0; index < 5; index++) created(store, `all-${index}`)
    let active = 0, peak = 0, calls = 0; const gate = deferred<void>()
    const runtime = new RepairContinuationRuntime(store, ports({ inspectTrigger: async () => { calls++; active++; peak = Math.max(peak, active); await gate.promise; active--; return undefined } }))
    const first = runtime.tickAll(), second = runtime.tickAll(); expect(first).toBe(second)
    await vi.waitFor(() => expect(calls).toBe(4)); gate.resolve(); await first
    expect(calls).toBe(5); expect(peak).toBe(4)
    await runtime.dispose(); store.close()
  })
  test('admits one distinct host-provided successor only after a rejected deployment', async () => {
    const store = new SkillStore(':memory:'), initial = created(store, 'two-round'), watching = stage(store, initial, ['source-confirmed', 'creating-repair', 'repairing', 'repair-achieved', 'capturing', 'candidate-staged', 'comparing', 'watching'])
    const next = { profileId: 'followup', source: { goalId: 'new-goal', sessionId: 'new-session', nativeGoalId: 'new-native', definitionDigest: 'd'.repeat(64) }, trigger: { proof: 'new' }, predecessorDeploymentId: 'deployment' }
    const runtime = new RepairContinuationRuntime(store, ports({ inspectDeployment: async () => 'rejected', inspectNextIteration: async () => next }))
    const advanced = await runtime.tick(scope, watching.id)
    expect(advanced).toMatchObject({ iteration: 1, state: 'rejected' })
    await runtime.dispose(); store.close()
  })
  test('runs two independently sourced repairs through distinct candidate and deployment lifecycles', async () => {
    const store = new SkillStore(':memory:'), first = created(store, 'two-full', Date.now() + 60_000, 2)
    const next = { profileId: 'followup', source: { goalId: 'next-goal', sessionId: 'next-session', nativeGoalId: 'next-native', definitionDigest: 'd'.repeat(64) }, trigger: { proof: 'next' }, predecessorDeploymentId: 'deployment-1' }
    let deployment = 0; const repairs: string[] = []; const candidates: string[] = []
    const runtime = new RepairContinuationRuntime(store, ports({ createRepair: async record => { repairs.push(String((record.checkpoint.source as { goalId?: string } | undefined)?.goalId ?? record.authorization.source.goalId)); return { sessionId: `repair-${repairs.length}`, goalId: `goal-${repairs.length}` } }, capture: async () => ({ candidateId: `candidate-${candidates.push('x')}` }), compare: async () => ({ deploymentId: `deployment-${++deployment}` }), inspectDeployment: async record => record.iteration === 1 ? 'rejected' : 'complete', inspectNextIteration: async () => next }))
    let record = first
    for (let index = 0; index < 13; index++) record = await runtime.tick(scope, record.id)
    expect(record).toMatchObject({ state: 'complete', iteration: 2 })
    expect(repairs).toEqual(['source', 'next-goal']); expect(candidates).toHaveLength(2)
    await runtime.dispose(); store.close()
  })
})
