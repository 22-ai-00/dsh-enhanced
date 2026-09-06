import { chmodSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalExecutionStore } from '../src/execution-store.ts'
import { GoalStoreError } from '../src/types.ts'

const scope = { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const intent = (runId = 'run-a') => ({ runId, scope, objective: 'write report', admission: { issuedAt: 1, expiresAt: 1000, maxGoalRounds: 2, round: 1, authorizationDigest: acceptanceDigest({ scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) }, task: { kind: 'goal-step' as const, ref: runId, goal: { id: 'goal-a', definitionVersion: 1, definitionDigest: acceptanceDigest({ objective: 'write report' }), stepId: 'step-a', runId, sessionId: 'session-a', nativeGoalId: 'native-a', nativeRevision: 1 } } })

describe('GoalExecutionStore', () => {
  it('persists idempotent preparation, freezes contract binding, and never redispatches', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-execution-')), 'runs.sqlite')
    const store = new GoalExecutionStore(path)
    expect(store.prepare(intent())).toEqual(store.prepare(intent()))
    expect(() => store.prepare({ ...intent(), objective: 'tampered' })).toThrow(GoalStoreError)
    store.bindAcceptance('run-a', { contractId: 'contract-a', contractDigest: 'b'.repeat(64) })
    expect(() => store.bindAcceptance('run-a', { contractId: 'contract-a', contractDigest: 'c'.repeat(64) })).toThrow(GoalStoreError)
    store.prepare(intent('run-b'))
    expect(() => store.bindAcceptance('run-b', { contractId: 'contract-a', contractDigest: 'b'.repeat(64) })).toThrow(GoalStoreError)
    store.markDispatched('run-a', 10)
    expect(() => store.markDispatched('run-a', 11)).toThrow(GoalStoreError)
    store.close()
    const recovered = new GoalExecutionStore(path)
    expect(recovered.recoverIncomplete()).toMatchObject([{ execution: { status: 'unknown', quiescent: false } }])
    expect(() => recovered.finish('run-a', { status: 'succeeded', quiescent: true, completedAt: 11 })).toThrow(GoalStoreError)
    expect(() => recovered.markDispatched('run-a', 12)).toThrow(GoalStoreError)
    recovered.close()
  })

  it('rejects invalid admission and unsafe file permissions', async () => {
    const store = new GoalExecutionStore(':memory:')
    expect(() => store.prepare({ ...intent(), admission: { ...intent().admission, round: 3 } })).toThrow(GoalStoreError)
    store.close()
    const path = join(await mkdtemp(join(tmpdir(), 'goal-execution-')), 'runs.sqlite')
    new GoalExecutionStore(path).close(); chmodSync(path, 0o644)
    expect(() => new GoalExecutionStore(path)).toThrow(GoalStoreError)
  })

  it('filters by canonical owner scope and goal before applying a bounded newest-first limit', () => {
    const store = new GoalExecutionStore(':memory:')
    for (let index = 0; index < 60; index++) store.prepare({ ...intent(`other-${index}`), scope: { ...scope, principalId: 'other', principalRecordId: 'other-row' }, admission: { ...intent(`other-${index}`).admission, issuedAt: index + 10, expiresAt: index + 11, authorizationDigest: acceptanceDigest({ scope: { ...scope, principalId: 'other', principalRecordId: 'other-row' }, action: 'execute', resource: { kind: 'goal', id: 'business-context' } }) } })
    const early = store.prepare(intent('own-early'))
    const late = store.prepare({ ...intent('own-late'), admission: { ...intent('own-late').admission, issuedAt: 5, expiresAt: 6 } })
    expect(store.listForGoal({ preset: 'default', workspace: '/workspace', principalVersion: 1, principalRecordId: 'owner-row', principalId: 'owner' }, 'goal-a', 1).map(run => run.intent.runId)).toEqual([late.intent.runId])
    expect(store.listForGoal(scope, 'goal-a', 100).map(run => run.intent.runId)).toContain(early.intent.runId)
    expect(() => store.listForGoal(scope, 'goal-a', 0)).toThrow(GoalStoreError)
    store.close()
  })

  it('migrates v1 rows without changing their binding or terminal state and rejects derived-key tampering', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-execution-v1-')), 'runs.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec("CREATE TABLE goal_execution_runs (run_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, contract_id TEXT UNIQUE, contract_digest TEXT, dispatched_at INTEGER, execution_json TEXT) STRICT; PRAGMA user_version = 1;")
    legacy.prepare('INSERT INTO goal_execution_runs VALUES (?, ?, ?, ?, ?, ?)').run('run-a', JSON.stringify(intent()), 'contract-a', 'b'.repeat(64), 1, JSON.stringify({ status: 'unknown', quiescent: false, completedAt: 1 }))
    legacy.close(); chmodSync(path, 0o600)
    const store = new GoalExecutionStore(path)
    expect(store.get('run-a')).toMatchObject({
      acceptance: { contractId: 'contract-a', contractDigest: 'b'.repeat(64) },
      dispatchedAt: 1,
      execution: { status: 'unknown', quiescent: false, completedAt: 1 },
    })
    store.close()
    const corrupt = new DatabaseSync(path)
    corrupt.prepare('UPDATE goal_execution_runs SET goal_id = ? WHERE run_id = ?').run('other-goal', 'run-a')
    corrupt.close()
    expect(() => new GoalExecutionStore(path)).toThrow(GoalStoreError)
  })

  it('requires acceptance and a live deadline, fences competing connections, and cannot declare late success', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-execution-')), 'runs.sqlite')
    const first = new GoalExecutionStore(path)
    const second = new GoalExecutionStore(path)
    try {
      first.prepare(intent())
      expect(() => second.markDispatched('run-a', 10)).toThrow(GoalStoreError)
      first.bindAcceptance('run-a', { contractId: 'contract-a', contractDigest: 'b'.repeat(64) })
      expect(() => second.bindAcceptance('run-a', { contractId: 'contract-b', contractDigest: 'c'.repeat(64) })).toThrow(GoalStoreError)
      expect(() => first.markDispatched('run-a', 1000)).toThrow(GoalStoreError)
      first.markDispatched('run-a', 999)
      expect(() => second.markDispatched('run-a', 999)).toThrow(GoalStoreError)
      expect(() => second.finish('run-a', { status: 'succeeded', quiescent: true, completedAt: 1000 })).toThrow(GoalStoreError)
      second.finish('run-a', { status: 'unknown', quiescent: false, completedAt: 1000 })
      expect(first.get('run-a')?.execution).toMatchObject({ status: 'unknown', quiescent: false })
    } finally { first.close(); second.close() }
  })
})
