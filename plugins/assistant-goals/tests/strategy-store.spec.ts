import { chmodSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { describe, expect, it } from 'vitest'
import { GoalStrategyStore } from '../src/strategy-store.ts'
import { GoalStoreError } from '../src/types.ts'

const scope = { principalId: 'owner', principalRecordId: 'owner-row', principalVersion: 1, workspace: '/workspace', preset: 'default' }
const intent = (id = 'strategy-a', createdAt = 1) => ({ id, goalId: 'goal-a', parentRunId: 'run-a', parentSessionId: 'session-parent', definitionVersion: 1, definitionDigest: 'a'.repeat(64), scope, kind: 'investigate' as const, requestDigest: 'b'.repeat(64), provider: 'provider', model: 'model-id', maxChildren: 2, maxDurationMs: 300_000, createdAt, expiresAt: createdAt + 300_000 })
const child = (sessionId: string, stopReason = 'complete', quiescent = true) => ({ sessionId, stopReason, quiescent, diagnostics: { toolRejections: 0, output: 'accepted' as const } })
const legacySchema = "CREATE TABLE goal_strategy_records (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, children_json TEXT NOT NULL, completed_at INTEGER, outcome TEXT, output_digest TEXT, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT; CREATE INDEX goal_strategy_scope_goal_created ON goal_strategy_records(scope_key, goal_id, created_at DESC, id ASC); PRAGMA user_version = 1;"

describe('GoalStrategyStore', () => {
  it('persists preparation idempotently and detects conflicting replays', () => {
    const store = new GoalStrategyStore(':memory:')
    expect(store.prepare(intent()).created).toBe(true)
    expect(store.prepare(intent())).toMatchObject({ created: false, record: { state: 'prepared', version: 1 } })
    expect(() => store.prepare({ ...intent(), provider: 'other' })).toThrow(GoalStoreError)
    store.close()
  })

  it('fences competing connections while binding native children', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-strategy-')), 'strategy.sqlite')
    const first = new GoalStrategyStore(path); const second = new GoalStrategyStore(path)
    try {
      first.prepare(intent())
      const starting = first.dispatch('strategy-a', 1, 2)
      expect(() => second.dispatch('strategy-a', 1, 2)).toThrow(GoalStoreError)
      const bound = first.bindChild('strategy-a', starting.version, 'child-a', 3)
      expect(() => second.bindChild('strategy-a', starting.version, 'child-b', 3)).toThrow(GoalStoreError)
      expect(second.settle('strategy-a', bound.version, { children: [child('child-a')], outcome: 'advice', outputDigest: 'c'.repeat(64), quiescent: true, terminationReason: 'completed' }, 4)).toMatchObject({ state: 'settled', version: 4, outcome: 'advice', terminationReason: 'completed', children: [{ diagnostics: { toolRejections: 0, output: 'accepted' } }] })
      expect(first.inspect(scope, 'strategy-a')?.children[0]?.diagnostics).toEqual({ toolRejections: 0, output: 'accepted' })
    } finally { first.close(); second.close() }
  })

  it('marks incomplete work unknown on restart without reviving it', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-strategy-')), 'strategy.sqlite')
    const first = new GoalStrategyStore(path); first.prepare(intent()); first.dispatch('strategy-a', 1, 2); first.close()
    const recovered = new GoalStrategyStore(path)
    try {
      recovered.recoverIncomplete(4)
      expect(recovered.inspect(scope, 'strategy-a')).toMatchObject({ state: 'unknown', outcome: 'unknown', completedAt: 4, terminationReason: 'recovered-unknown' })
      expect(() => recovered.dispatch('strategy-a', 2, 5)).toThrow(GoalStoreError)
    } finally { recovered.close() }
  })

  it('makes a non-quiescent settlement terminally unknown', () => {
    const store = new GoalStrategyStore(':memory:')
    store.prepare(intent()); store.dispatch('strategy-a', 1, 2)
    store.bindChild('strategy-a', 2, 'child-a', 3)
    expect(store.settle('strategy-a', 3, { children: [child('child-a', 'timeout', false)], outcome: 'execution-failed', outputDigest: 'c'.repeat(64), quiescent: false, terminationReason: 'unconfirmed-stop' }, 4))
      .toMatchObject({ state: 'unknown', outcome: 'unknown', terminationReason: 'unconfirmed-stop', children: [{ sessionId: 'child-a' }] })
    store.close()
  })

  it('never binds duplicate or excess children and cannot omit a pending child at settlement', () => {
    const store = new GoalStrategyStore(':memory:')
    store.prepare(intent()); store.dispatch('strategy-a', 1, 2)
    store.bindChild('strategy-a', 2, 'child-a', 3)
    expect(() => store.bindChild('strategy-a', 3, 'child-a', 4)).toThrow(GoalStoreError)
    const second = store.bindChild('strategy-a', 3, 'child-b', 4)
    expect(() => store.bindChild('strategy-a', second.version, 'child-c', 5)).toThrow(GoalStoreError)
    expect(() => store.settle('strategy-a', second.version, { children: [child('child-a')], outcome: 'advice', quiescent: true, terminationReason: 'completed' }, 5)).toThrow(GoalStoreError)
    store.close()
  })

  it('isolates exact owners and rejects unsafe private database paths', async () => {
    const store = new GoalStrategyStore(':memory:')
    store.prepare(intent('early', 1)); store.prepare(intent('newer', 3)); store.prepare({ ...intent('other', 4), scope: { ...scope, principalId: 'other', principalRecordId: 'other-row' } })
    for (const isolated of [{ ...scope, principalId: 'other' }, { ...scope, principalRecordId: 'other-row' }, { ...scope, principalVersion: 2 }, { ...scope, workspace: '/other' }, { ...scope, preset: 'other' }]) expect(store.inspect(isolated, 'early')).toBeUndefined()
    expect(store.list(scope, 'goal-a', 1).map(record => record.intent.id)).toEqual(['newer'])
    store.close()
    const path = join(await mkdtemp(join(tmpdir(), 'goal-strategy-')), 'strategy.sqlite')
    new GoalStrategyStore(path).close(); chmodSync(path, 0o644)
    expect(() => new GoalStrategyStore(path)).toThrow(GoalStoreError)
  })

  it('migrates schema 1 cold records without inventing child observations', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-strategy-v1-')), 'strategy.sqlite')
    const database = new DatabaseSync(path)
    try {
      database.exec(legacySchema)
      database.prepare("INSERT INTO goal_strategy_records(id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at) VALUES (?, ?, 'settled', 3, ?, 4, 'advice', ?, ?, 'goal-a', 1)").run('strategy-a', JSON.stringify(intent()), JSON.stringify([{ sessionId: 'child-a', stopReason: 'completed', quiescent: true }]), 'c'.repeat(64), acceptanceCanonicalJson(scope))
    } finally { database.close() }
    chmodSync(path, 0o600)
    const migrated = new GoalStrategyStore(path)
    try {
      expect(migrated.inspect(scope, 'strategy-a')).toMatchObject({ state: 'settled', outcome: 'advice', terminationReason: 'unknown', children: [{ sessionId: 'child-a' }] })
      expect(migrated.inspect(scope, 'strategy-a')?.children[0]).not.toHaveProperty('diagnostics')
    } finally { migrated.close() }
    const reopened = new GoalStrategyStore(path)
    try { expect(reopened.inspect(scope, 'strategy-a')?.terminationReason).toBe('unknown') } finally { reopened.close() }
  })

  it('rolls back schema upgrade when a legacy record cannot be validated', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'goal-strategy-invalid-v1-')), 'strategy.sqlite')
    const database = new DatabaseSync(path)
    database.exec(legacySchema)
    database.prepare("INSERT INTO goal_strategy_records(id,intent_json,state,version,children_json,scope_key,goal_id,created_at) VALUES ('invalid','{}','prepared',1,'[]','{}','goal-a',1)").run()
    database.close(); chmodSync(path, 0o600)
    expect(() => new GoalStrategyStore(path)).toThrow(GoalStoreError)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      expect(check.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 })
      expect(check.prepare('PRAGMA table_info(goal_strategy_records)').all().map(row => row.name)).not.toContain('termination_reason')
    } finally { check.close() }
  })
})
