import { chmodSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from '../src/types.ts'
import { GoalWakeStore, type GoalWakeIntent } from '../src/wake-store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function privateRoot(prefix: string): Promise<string> { const root = await mkdtemp(join(tmpdir(), prefix)); roots.push(root); return root }

const scope = { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/work', preset: 'primary' }
function intent(id = 'wake-a'): GoalWakeIntent {
  const objective = 'resume report'
  return { id, scope, goalId: 'goal-business-a', definition: { version: 1, digest: acceptanceDigest({ objective }), objective }, native: { sessionId: 'session-a', goalId: 'native-goal-a', revision: 2, objective, phase: 'paused', roundsStarted: 1, maxGoalRounds: 3, updatedAt: 1 }, attestation: { scope: { workspace: '/work', preset: 'primary' }, principalId: 'lark/bot-1/tenant-a/ou_owner', principalLineage: { principalRecordId: 'owner-row', principalVersion: 1 }, bindingId: 'binding-a', bindingVersion: 1, bindingGeneration: 1, sessionId: 'session-a' }, at: 10, expiresAt: 20, ownerRouteId: 'local/owner', budgetId: 'goal-budget/owner' }
}

describe('GoalWakeStore', () => {
  it('persists immutable preparation and scheduling acknowledgement', () => {
    const store = new GoalWakeStore(':memory:'); const value = intent()
    expect(store.prepare(value)).toEqual(store.prepare(value))
    expect(() => store.prepare({ ...value, budgetId: 'other' })).toThrow(GoalStoreError)
    expect(store.scheduled(value.id, 'a'.repeat(64))).toMatchObject({ state: 'scheduled' })
    expect(store.scheduled(value.id, 'a'.repeat(64))).toMatchObject({ state: 'scheduled' })
    expect(() => store.scheduled(value.id, 'b'.repeat(64))).toThrow(GoalStoreError)
    store.close()
  })

  it('binds exact dependency definitions while accepting dependency-free legacy wakes', () => {
    const store = new GoalWakeStore(':memory:')
    const legacy = intent('wake-legacy')
    expect(store.prepare(legacy).intent).not.toHaveProperty('dependencies')
    const dependency = { goalId: 'dependency-a', definitionVersion: 2, definitionDigest: 'b'.repeat(64) }
    const bound = { ...intent('wake-bound'), dependencies: [dependency] }
    expect(store.prepare(bound).intent.dependencies).toEqual([dependency])
    expect(() => store.prepare({ ...bound, dependencies: [{ ...dependency, definitionDigest: 'invalid' }] })).toThrow(GoalStoreError)
    store.close()
  })

  it('fences concurrent dispatch and keeps dispatched wake unreplayable across restart', async () => {
    const path = join(await privateRoot('goal-wake-'), 'wakes.sqlite')
    const first = new GoalWakeStore(path); first.prepare(intent()); first.scheduled('wake-a', 'a'.repeat(64))
    const second = new GoalWakeStore(path)
    try {
      expect(first.dispatch('wake-a', 'occurrence-a', 10)).toMatchObject({ state: 'dispatched' })
      expect(() => second.dispatch('wake-a', 'occurrence-b', 10)).toThrow(GoalStoreError)
    } finally { first.close(); second.close() }
    const reopened = new GoalWakeStore(path)
    expect(reopened.get('wake-a')).toMatchObject({ state: 'dispatched', occurrenceId: 'occurrence-a' })
    expect(() => reopened.dispatch('wake-a', 'occurrence-c', 11)).toThrow(GoalStoreError)
    reopened.close()
  })

  it('enforces time, authority and terminal boundaries', () => {
    const store = new GoalWakeStore(':memory:'); const value = intent(); store.prepare(value); store.scheduled(value.id, 'a'.repeat(64))
    expect(() => store.dispatch(value.id, 'occurrence-a', 9)).toThrow(GoalStoreError)
    expect(() => store.dispatch(value.id, 'occurrence-a', 20)).toThrow(GoalStoreError)
    expect(store.finish(value.id, 'denied', 11)).toMatchObject({ state: 'denied' })
    expect(store.finish(value.id, 'denied', 12)).toMatchObject({ state: 'denied' })
    expect(() => store.finish(value.id, 'succeeded', 12)).toThrow(GoalStoreError)
    expect(() => store.prepare({ ...intent('bad-owner'), attestation: { ...value.attestation, principalId: 'other' } })).toThrow(GoalStoreError)
    expect(() => store.prepare({ ...intent('bad-definition'), native: { ...value.native, phase: 'active' } })).toThrow(GoalStoreError)
    store.close()
  })

  it('can deny an unmaterialized prepared wake without inventing a definition hash', () => {
    const store = new GoalWakeStore(':memory:'); store.prepare(intent())
    expect(store.finish('wake-a', 'denied', 10)).toMatchObject({ state: 'denied' })
    expect(store.get('wake-a')).not.toHaveProperty('definitionHash')
    store.close()
  })

  it('isolates history by full scope and rejects unsafe or corrupt persistence', async () => {
    const store = new GoalWakeStore(':memory:'); store.prepare(intent()); store.prepare({ ...intent('wake-b'), scope: { ...scope, principalId: 'other', principalRecordId: 'other-row' }, attestation: { ...intent('wake-b').attestation, principalId: 'other', principalLineage: { principalRecordId: 'other-row', principalVersion: 1 } } })
    expect(store.listForGoal(scope, 'goal-business-a')).toHaveLength(1); store.close()
    const path = join(await privateRoot('goal-wake-corrupt-'), 'wakes.sqlite')
    const database = new DatabaseSync(path); database.exec('CREATE TABLE wrong (id TEXT) STRICT; PRAGMA user_version = 1;'); database.close(); chmodSync(path, 0o600)
    expect(() => new GoalWakeStore(path)).toThrow(GoalStoreError)
    const privatePath = join(await privateRoot('goal-wake-private-'), 'wakes.sqlite')
    new GoalWakeStore(privatePath).close(); chmodSync(privatePath, 0o644)
    expect(() => new GoalWakeStore(privatePath)).toThrow(GoalStoreError)
  })
})
