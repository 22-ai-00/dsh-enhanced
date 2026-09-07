import { chmodSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { acceptanceDigest, createTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { GoalOutcomeStore, type GoalOutcomeDefinition } from '../src/outcome-store.ts'
import { GoalStoreError } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function privateRoot(): Promise<string> { const root = await mkdtemp(join(tmpdir(), 'goal-outcome-')); roots.push(root); return root }
const scope = { principalId: 'owner-a', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/work', preset: 'primary' }
const objective = 'ship the durable report'
const definition = { version: 3, digest: acceptanceDigest({ objective }), objective }

function acceptance(assessmentId = 'assessment-a', id = `contract-${assessmentId}`, expiresAt = 1000): Extract<TaskAcceptanceContract, { protocol: 'task-acceptance/v3' }> {
  const contract = createTaskAcceptanceContract({
    protocol: 'task-acceptance/v3' as const, id,
    scope: { workspace: '/work', preset: 'primary' }, owner: { principalRecordId: 'owner-row', principalVersion: 1 },
    task: { kind: 'goal-outcome', ref: assessmentId, goal: { id: 'goal-a', definitionVersion: 3, definitionDigest: definition.digest, assessmentId, sessionId: 'session-a', nativeGoalId: 'native-a' } },
    objective, profile: { id: 'goal-outcome-profile', version: 1, digest: 'a'.repeat(64) }, issuedAt: 10, expiresAt,
    criteria: [{ id: 'readback', kind: 'target-readback', authority: { id: 'authority-a', digest: 'b'.repeat(64) }, objectId: 'report', expected: [{ pointer: '/status', value: 'done' }] }],
    bounds: { maxDurationMs: 100, maxEvidenceBytes: 1000 },
  })
  if (contract.protocol !== 'task-acceptance/v3') throw new Error('expected v3 fixture')
  return contract
}
function input(template = acceptance()): GoalOutcomeDefinition { return { scope, goalId: 'goal-a', definition, sessionId: 'session-a', nativeGoalId: 'native-a', template } }

describe('GoalOutcomeStore', () => {
  it('binds one immutable v3 whole-goal template and copies its frozen grader policy', () => {
    const store = new GoalOutcomeStore(':memory:')
    const bound = store.bind(input())
    expect(store.bind(input())).toEqual(bound)
    expect(store.prepare(bound, acceptance())).toMatchObject({ contract: { protocol: 'task-acceptance/v3', task: { kind: 'goal-outcome', ref: 'assessment-a' } } })
    const later = acceptance('assessment-b', 'contract-assessment-b')
    expect(store.prepare(bound, later, 'round-2')).toMatchObject({ triggerRunId: 'round-2' })
    expect(() => store.prepare(bound, acceptance('assessment-c', 'contract-assessment-c'), 'round-2')).toThrow(GoalStoreError)
    const alteredCriteria = { ...acceptance('assessment-c', 'contract-assessment-c'), criteria: [] }
    expect(() => store.prepare(bound, alteredCriteria)).toThrow(GoalStoreError)
    expect(() => store.prepare(bound, acceptance('assessment-d', 'contract-assessment-d', 1001))).toThrow(GoalStoreError)
    expect(() => store.bind({ ...input(), nativeGoalId: 'other-native' })).toThrow(GoalStoreError)
    store.close()
  })

  it('migrates v1 assessments without changing frozen definitions or executions', async () => {
    const path = join(await privateRoot(), 'legacy.sqlite')
    const old = new GoalOutcomeStore(path)
    const bound = old.bind(input())
    old.prepare(bound, acceptance(), 'legacy-run')
    old.markDispatched('assessment-a', 11)
    old.finish('assessment-a', { status: 'succeeded', quiescent: true, completedAt: 12 })
    const before = old.get('assessment-a')
    old.close()
    const database = new DatabaseSync(path)
    database.exec('DROP INDEX goal_outcome_scope_goal_issued; DROP INDEX goal_outcome_trigger_run; ALTER TABLE goal_outcome_assessments DROP COLUMN created_seq; CREATE INDEX goal_outcome_scope_goal_issued ON goal_outcome_assessments(scope_key, goal_id, issued_at DESC); PRAGMA user_version = 1;')
    database.close()
    const migrated = new GoalOutcomeStore(path)
    try {
      expect(migrated.getByTriggerRun(scope, 'goal-a', definition.version, 'legacy-run')).toEqual(before)
      expect(migrated.getDefinition(scope, 'goal-a', definition.version)).toEqual(bound)
      expect(migrated.recoverIncomplete(20)).toBe(0)
    } finally { migrated.close() }
  })

  it('uses the assessment task reference and contract identity as immutable global fences', () => {
    const store = new GoalOutcomeStore(':memory:'); const bound = store.bind(input())
    store.prepare(bound, acceptance())
    const reusedId = acceptance('assessment-b', 'contract-assessment-a')
    expect(() => store.prepare(bound, reusedId)).toThrow(GoalStoreError)
    const accepted = acceptance('assessment-c', 'contract-assessment-c')
    const badRef = { ...accepted, task: { ...accepted.task, ref: 'not-the-assessment' } }
    expect(() => store.prepare(bound, badRef)).toThrow(GoalStoreError)
    expect(store.getByContract('contract-assessment-a')?.contract.task.ref).toBe('assessment-a')
    store.close()
  })

  it('fences concurrent dispatch and never redispatches an incomplete recovered assessment', async () => {
    const path = join(await privateRoot(), 'outcomes.sqlite')
    const first = new GoalOutcomeStore(path); const bound = first.bind(input()); first.prepare(bound, acceptance())
    const second = new GoalOutcomeStore(path)
    try {
      expect(first.markDispatched('assessment-a', 11).dispatchedAt).toBe(11)
      expect(() => second.markDispatched('assessment-a', 12)).toThrow(GoalStoreError)
    } finally { first.close(); second.close() }
    const reopened = new GoalOutcomeStore(path)
    expect(reopened.get('assessment-a')).toMatchObject({ dispatchedAt: 11 })
    expect(() => reopened.markDispatched('assessment-a', 12)).toThrow(GoalStoreError)
    expect(reopened.finish('assessment-a', { status: 'unknown', quiescent: false, completedAt: 12 }).execution).toMatchObject({ status: 'unknown' })
    expect(() => reopened.finish('assessment-a', { status: 'succeeded', quiescent: true, completedAt: 13 })).toThrow(GoalStoreError)
    reopened.close()
  })

  it('isolates full scopes and definition versions before applying a newest-first limit', () => {
    const store = new GoalOutcomeStore(':memory:')
    const one = store.bind(input()); store.prepare(one, acceptance('assessment-old', 'contract-old'))
    store.prepare(one, acceptance('assessment-new', 'contract-new'), 'round-2')
    const other = { ...input(acceptance('other', 'contract-other')), scope: { ...scope, principalId: 'owner-b', principalRecordId: 'owner-b-row' } }
    const { digest: _digest, ...otherPayload } = other.template
    other.template = createTaskAcceptanceContract({ ...otherPayload, owner: { ...other.template.owner, principalRecordId: 'owner-b-row' } }) as typeof other.template
    store.bind(other); store.prepare(other, other.template)
    // Both fixture contracts are issued in the same millisecond.  Creation order,
    // rather than a lexicographic assessment ID, determines the newest record.
    expect(store.list(scope, 'goal-a', 1).map(item => item.contract.id)).toEqual(['contract-new'])
    expect(store.getDefinition(scope, 'goal-a', 3)).toMatchObject({ nativeGoalId: 'native-a' })
    expect(store.getDefinition(scope, 'goal-a', 4)).toBeUndefined()
    expect(store.list({ ...scope, principalId: 'owner-b', principalRecordId: 'owner-b-row' }, 'goal-a')).toHaveLength(1)
    store.close()
  })

  it('rejects unsafe files and corrupt stored v3 state', async () => {
    const unsafe = join(await privateRoot(), 'outcomes.sqlite'); new GoalOutcomeStore(unsafe).close(); chmodSync(unsafe, 0o644)
    expect(() => new GoalOutcomeStore(unsafe)).toThrow(GoalStoreError)
    const corrupt = join(await privateRoot(), 'outcomes.sqlite'); const db = new DatabaseSync(corrupt)
    db.exec("CREATE TABLE goal_outcome_definitions (x TEXT) STRICT; PRAGMA user_version = 1;"); db.close(); chmodSync(corrupt, 0o600)
    expect(() => new GoalOutcomeStore(corrupt)).toThrow(GoalStoreError)
  })

  it('persists trigger lookup across restart and rejects a row whose definition diverges from its frozen binding', async () => {
    const path = join(await privateRoot(), 'outcomes.sqlite')
    const first = new GoalOutcomeStore(path); const bound = first.bind(input())
    first.prepare(bound, acceptance(), 'trigger-a'); first.close()
    const reopened = new GoalOutcomeStore(path)
    expect(reopened.getByTriggerRun(scope, 'goal-a', 3, 'trigger-a')?.contract.id).toBe('contract-assessment-a')
    reopened.close()
    const database = new DatabaseSync(path)
    if (bound.template.protocol !== 'task-acceptance/v3') throw new Error('expected v3 fixture')
    const { digest, task: originalTask, ...payload } = bound.template
    void digest
    const template = createTaskAcceptanceContract({ ...payload, task: { ...originalTask, goal: { ...originalTask.goal, sessionId: 'session-tampered', nativeGoalId: 'native-tampered' } } })
    if (template.protocol !== 'task-acceptance/v3') throw new Error('expected v3 fixture')
    const alternate = { ...bound, sessionId: 'session-tampered', nativeGoalId: 'native-tampered', template }
    database.prepare("UPDATE goal_outcome_assessments SET definition_json = ? WHERE assessment_id = ?").run(JSON.stringify(alternate), 'assessment-a')
    database.close()
    expect(() => new GoalOutcomeStore(path)).toThrow(GoalStoreError)
  })

  it('never records an unknown execution as quiescent', () => {
    const store = new GoalOutcomeStore(':memory:'); const bound = store.bind(input())
    store.prepare(bound, acceptance()); store.markDispatched('assessment-a', 11)
    expect(() => store.finish('assessment-a', { status: 'unknown', quiescent: true, completedAt: 12 })).toThrow(GoalStoreError)
    store.close()
  })

  it('only explicit recovery marks a dispatched assessment unknown after restart', async () => {
    const path = join(await privateRoot(), 'outcomes.sqlite')
    const first = new GoalOutcomeStore(path); const bound = first.bind(input())
    first.prepare(bound, acceptance()); first.markDispatched('assessment-a', 11)
    // A non-dispatched assessment remains an unverified pending record.
    first.prepare(bound, acceptance('assessment-b', 'contract-assessment-b'))
    first.close()
    const reopened = new GoalOutcomeStore(path)
    expect(reopened.get('assessment-a')?.execution).toBeUndefined()
    expect(reopened.recoverIncomplete(12)).toBe(1)
    expect(reopened.recoverIncomplete(13)).toBe(0)
    expect(reopened.get('assessment-a')?.execution).toEqual({ status: 'unknown', quiescent: false, completedAt: 12 })
    expect(reopened.get('assessment-b')?.execution).toBeUndefined()
    reopened.close()
  })
})
