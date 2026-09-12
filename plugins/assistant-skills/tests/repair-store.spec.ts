import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { SkillStore, type SkillRepairAuthorizationInput } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const scope = { principalId: 'owner-a', principalRecordId: 'record-a', principalVersion: 1, workspace: '/tmp/workspace', preset: 'primary' }
const otherScope = { ...scope, principalId: 'owner-b', principalRecordId: 'record-b' }
function input(overrides: Partial<SkillRepairAuthorizationInput> = {}): SkillRepairAuthorizationInput {
  return { invocationId: 'repair-invocation', ownerRouteId: 'owner-route', source: { goalId: 'goal', sessionId: 'session', nativeGoalId: 'native-goal', definitionDigest: 'a'.repeat(64) },
    profileId: 'profile', profileDigest: 'b'.repeat(64), skillName: 'read-report', parentVersion: 1, parentDigest: 'c'.repeat(64), maxIterations: 2, expiresAt: Date.now() + 60_000, ...overrides }
}
async function database() { const root = await mkdtemp(join(tmpdir(), 'assistant-skills-repair-')); roots.push(root); return join(root, 'skills.sqlite') }
function toWatching(store: SkillStore, value: ReturnType<SkillStore['createRepairContinuation']>) {
  let current = value
  for (const state of ['source-confirmed', 'creating-repair', 'repairing', 'repair-achieved', 'capturing', 'candidate-staged', 'comparing', 'watching'] as const) {
    current = store.transitionRepairContinuation(scope, current.id, current.revision, state, { state, ...(state === 'watching' ? { deploymentId: 'deployment' } : {}) })
  }
  return current
}

describe('SkillStore repair continuations', () => {
  it('idempotently records an immutable authorization and rejects conflicting replays', () => {
    const store = new SkillStore(':memory:'), receipt = { route: 'receipt' }, authorization = input(), first = store.createRepairContinuation(scope, authorization, receipt)
    expect(store.createRepairContinuation(scope, authorization, receipt)).toEqual(first)
    expect(first).toMatchObject({ id: `skill-repair-${acceptanceDigest([scope, 'owner-route', 'repair-invocation'])}`, authorizationDigest: acceptanceDigest(authorization), iteration: 1, revision: 1, state: 'armed', checkpoint: {} })
    expect(() => store.createRepairContinuation(scope, input({ profileId: 'other-profile' }), receipt)).toThrow(/conflict/u)
    expect(() => store.createRepairContinuation(scope, input(), { route: 'other-receipt' })).toThrow(/conflict/u)
    store.close()
  })

  it('isolates scoped reads while allowing the trusted host listing path', () => {
    const store = new SkillStore(':memory:'), first = store.createRepairContinuation(scope, input(), { receipt: 1 })
    const second = store.createRepairContinuation(otherScope, input(), { receipt: 1 })
    expect(first.id).not.toBe(second.id)
    expect(store.getRepairContinuation(otherScope, first.id)).toBeUndefined()
    expect(store.listRepairContinuations(scope)).toEqual([first])
    expect(store.listRepairContinuations()).toEqual([first, second].sort((a, b) => a.id.localeCompare(b.id)))
    store.close()
  })

  it('uses revision CAS across store instances and preserves in-flight records after reopen', async () => {
    const path = await database(), first = new SkillStore(path), created = first.createRepairContinuation(scope, input(), { receipt: 'r' })
    const second = new SkillStore(path)
    const advanced = first.transitionRepairContinuation(scope, created.id, created.revision, 'source-confirmed', { source: true })
    expect(() => second.transitionRepairContinuation(scope, created.id, created.revision, 'source-confirmed', {})).toThrow(/conflict/u)
    first.close(); second.close()
    const reopened = new SkillStore(path)
    expect(reopened.getRepairContinuation(scope, created.id)).toEqual(advanced)
    reopened.close()
  })

  it('permits only finite unexpired iterations from watching', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const store = new SkillStore(':memory:'), created = store.createRepairContinuation(scope, input({ profileSequence: [{ id: 'profile', digest: 'b'.repeat(64) }, { id: 'followup', digest: 'd'.repeat(64) }] }), { receipt: true })
    const watching = toWatching(store, created)
    const next = { profileId: 'followup', source: { goalId: 'next-goal', sessionId: 'next-session', nativeGoalId: 'next-native', definitionDigest: 'd'.repeat(64) }, trigger: { proof: 'next' }, predecessorDeploymentId: 'deployment' }
    const second = store.nextRepairIteration(scope, watching.id, watching.revision, next)
    expect(second).toMatchObject({ iteration: 2, state: 'armed', checkpoint: { profileId: 'followup', source: next.source, trigger: next.trigger, predecessorDeploymentId: 'deployment' } })
    expect(() => store.nextRepairIteration(scope, second.id, second.revision, next)).toThrow(/unavailable/u)
    const wrong = toWatching(store, store.createRepairContinuation(scope, input({ invocationId: 'wrong-profile', profileSequence: [{ id: 'profile', digest: 'b'.repeat(64) }, { id: 'followup', digest: 'd'.repeat(64) }] }), { receipt: 3 }))
    expect(() => store.nextRepairIteration(scope, wrong.id, wrong.revision, { ...next, profileId: 'other' })).toThrow(/unavailable/u)
    const expiresSoon = store.createRepairContinuation(scope, input({ invocationId: 'expired-repair', expiresAt: Date.now() + 1 }), { receipt: 2 })
    const expiredWatching = toWatching(store, expiresSoon); vi.advanceTimersByTime(2)
    expect(() => store.nextRepairIteration(scope, expiredWatching.id, expiredWatching.revision, next)).toThrow(/unavailable/u)
    store.close()
  })
  it('persists cumulative model and tool admission charges without revising the continuation', () => {
    const store = new SkillStore(':memory:'), created = store.createRepairContinuation(scope, input(), { receipt: true })
    expect(store.repairUsage(scope, created.id)).toEqual({ modelCalls: 0, toolCalls: 0 })
    expect(store.chargeRepairUsage(scope, created.id, 'model', 2)).toEqual({ modelCalls: 1, toolCalls: 0 })
    expect(store.chargeRepairUsage(scope, created.id, 'tool', 1)).toEqual({ modelCalls: 1, toolCalls: 1 })
    expect(store.chargeRepairUsage(scope, created.id, 'model', 2)).toEqual({ modelCalls: 2, toolCalls: 1 })
    expect(() => store.chargeRepairUsage(scope, created.id, 'model', 2)).toThrow(/exhausted/u)
    expect(() => store.chargeRepairUsage(scope, created.id, 'tool', 1)).toThrow(/exhausted/u)
    expect(store.getRepairContinuation(scope, created.id)?.revision).toBe(created.revision)
    store.close()
  })

  it('rejects skipped stages and cannot reactivate terminal states', () => {
    const store = new SkillStore(':memory:'), created = store.createRepairContinuation(scope, input(), { receipt: true })
    expect(() => store.transitionRepairContinuation(scope, created.id, created.revision, 'repairing', {})).toThrow(/conflict/u)
    const rejected = store.transitionRepairContinuation(scope, created.id, created.revision, 'rejected', { reason: 'policy' })
    expect(() => store.transitionRepairContinuation(scope, rejected.id, rejected.revision, 'armed', {})).toThrow(/conflict/u)
    store.close()
  })

  it('rejects malformed authorizations, route receipts, and checkpoint payloads', () => {
    const store = new SkillStore(':memory:')
    expect(() => store.createRepairContinuation(scope, input({ maxIterations: 5 }), {})).toThrow(/invalid/u)
    expect(() => store.createRepairContinuation(scope, input({ parentDigest: 'nope' }), {})).toThrow(/invalid/u)
    expect(() => store.createRepairContinuation(scope, input(), Number.POSITIVE_INFINITY)).toThrow(/invalid/u)
    const created = store.createRepairContinuation(scope, input(), {})
    const accessor = Object.create(null, { value: { enumerable: true, get: () => 'bad' } })
    expect(() => store.transitionRepairContinuation(scope, created.id, created.revision, 'source-confirmed', accessor)).toThrow(/invalid/u)
    expect(() => store.transitionRepairContinuation(scope, created.id, created.revision, 'source-confirmed', { huge: 'x'.repeat(128 * 1024) })).toThrow(/invalid/u)
    store.close()
  })
})
