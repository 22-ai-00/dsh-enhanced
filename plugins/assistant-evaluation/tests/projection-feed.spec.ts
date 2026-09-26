import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { EvaluationStore, EvaluationStoreError } from '../src/store.ts'
import type { EvaluationScope, OutcomeEnvelope } from '../src/types.ts'

const roots: string[] = []
const scope: EvaluationScope = { workspace: '/work/feed', preset: 'primary' }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path() { const root = mkdtempSync(join(tmpdir(), 'evaluation-feed-')); roots.push(root); return join(root, 'evaluation.sqlite') }
function outcome(id: string, run = id, overrides: Partial<OutcomeEnvelope> = {}): OutcomeEnvelope {
  return { scope, situation: `automation:${run}`, executionStatus: 'succeeded', objectiveStatus: 'achieved', deliveryStatus: 'not-required', source: { kind: 'automation', id: 'assistant-automations' }, trust: 'trusted', evidence: [{ kind: 'automation-run', ref: run }], metrics: {}, occurredAt: 1000, idempotencyKey: id, evaluator: { id: 'assistant-automations', version: 'terminal-v1' }, ...overrides }
}

test('pages current trusted heads and survives restart without duplicate watermarks', () => {
  const database = path(), first = new EvaluationStore({ path: database, now: () => 2000 })
  const one = first.append(outcome('one', 'one')), two = first.append(outcome('two', 'two'))
  first.append(outcome('self', 'self', { trust: 'self-reported' }))
  const page1 = first.listTaskLearningProjectionFeed(scope, undefined, 1)
  expect(page1.items).toHaveLength(1); expect(page1.hasMore).toBe(true)
  const page2 = first.listTaskLearningProjectionFeed(scope, page1.nextCursor, 10)
  expect(page2.items).toHaveLength(1); expect(page2.items.map(item => item.receipt.triggerOutcomeId).sort()).toEqual([one.id, two.id].filter(id => page1.items.every(item => item.receipt.triggerOutcomeId !== id)))
  const watermark = first.listTaskLearningProjectionFeed(scope, undefined, 10).scopeWatermark; first.close()
  const reopened = new EvaluationStore({ path: database, now: () => 2000 })
  expect(reopened.listTaskLearningProjectionFeed(scope, undefined, 10).scopeWatermark).toBe(watermark)
  reopened.close()
})

test('rejects foreign and future cursors plus invalid limits while same timestamps remain ordered', () => {
  const store = new EvaluationStore({ path: path(), now: () => 2000 }); store.append(outcome('a')); store.append(outcome('b'))
  const page = store.listTaskLearningProjectionFeed(scope, undefined, 10)
  expect(page.items.map(item => item.watermark)).toEqual(page.items.map(item => item.watermark).sort((a, b) => a - b))
  expect(() => store.listTaskLearningProjectionFeed(scope, { scopeKey: 'foreign', watermark: 0 }, 1)).toThrow(EvaluationStoreError)
  expect(() => store.listTaskLearningProjectionFeed(scope, { scopeKey: page.nextCursor.scopeKey, watermark: page.scopeWatermark + 1 }, 1)).toThrow(EvaluationStoreError)
  expect(() => store.listTaskLearningProjectionFeed(scope, undefined, 0)).toThrow(EvaluationStoreError)
  for (const cursor of [null, [], {}, { ...page.nextCursor, extra: true }, { ...page.nextCursor, watermark: -1 },
    { ...page.nextCursor, watermark: 1.5 }]) {
    expect(() => store.listTaskLearningProjectionFeed(scope, cursor as typeof page.nextCursor, 1)).toThrow(EvaluationStoreError)
  }
  store.close()
})

test('owner revision lookup follows the current exact lineage and withdraws it', () => {
  const store = new EvaluationStore({ path: path(), now: () => 2000 }), terminal = store.append(outcome('owner-terminal', 'owner-run'))
  const owner = (id: string, status: 'achieved' | 'unknown') => outcome(id, 'owner-run', {
    objectiveStatus: status, deliveryStatus: 'delivered', source: { kind: 'user-feedback', id: 'assistant-delivery/typed-owner-feedback' },
    evidence: [{ kind: 'automation-run', ref: 'owner-run' }, { kind: 'delivery-outbox', ref: 'owner-result' }], evaluator: { id: 'assistant-delivery-owner-feedback', version: '2' },
  })
  const lineage = { principalRecordId: 'owner-record', principalVersion: 1 }
  const initial = store.append(owner('owner-initial', 'achieved'), { ...lineage, action: 'initial', operationId: 'owner-1' })
  const before = store.listTaskLearningProjectionFeed(scope, undefined, 10)
  expect(store.inspectTaskOwnerRevision(scope, terminal.id, 'owner-record', 1)).toMatchObject({ outcomeId: initial.id, version: 1, action: 'initial', operationId: 'owner-1' })
  expect(store.inspectTaskOwnerRevision(scope, terminal.id, 'other', 1)).toBeUndefined()
  expect(store.inspectTaskOwnerRevision(scope, terminal.id, 'owner-record', 2)).toBeUndefined()
  store.append(owner('owner-repeat', 'achieved'), { ...lineage, action: 'initial', operationId: 'owner-repeat-operation' })
  // Same-value acknowledgements cannot replace the original evidence text
  // that Delivery resolves through the canonical operation identity.
  expect(store.inspectTaskOwnerRevision(scope, terminal.id, 'owner-record', 1)).toMatchObject({ outcomeId: initial.id, version: 1, operationId: 'owner-1' })
  const withdrawal = store.append(owner('owner-withdraw', 'unknown'), { ...lineage, action: 'withdraw', operationId: 'owner-2', expectedVersion: 1, previousStatus: 'achieved' })
  const update = store.listTaskLearningProjectionFeed(scope, before.nextCursor, 10)
  expect(update.items).toHaveLength(1); expect(update.items[0]!.receipt.projection.disposition).toBe('retract')
  expect(store.inspectTaskOwnerRevision(scope, terminal.id, 'owner-record', 1)).toMatchObject({ outcomeId: withdrawal.id, version: 2, action: 'withdraw', objectiveStatus: 'unknown', operationId: 'owner-2' })
  store.close()
})

test('migrates populated v11 once without changing retained evidence or canonical versions', () => {
  const database = path()
  let store = new EvaluationStore({ path: database, now: () => 2000 })
  store.append(outcome('legacy-a')); store.append(outcome('legacy-b'))
  const before = store.listTaskLearningProjectionFeed(scope, undefined, 10)
  store.close()
  const legacy = new DatabaseSync(database)
  const audit = legacy.prepare('SELECT * FROM evaluation_outcomes ORDER BY id').all()
  legacy.exec("DROP TABLE evaluation_task_projection_feed_heads; UPDATE evaluation_schema_meta SET value = '11' WHERE key = 'schema-version'; PRAGMA user_version = 11")
  legacy.close()
  store = new EvaluationStore({ path: database, now: () => 2000 })
  const migrated = store.listTaskLearningProjectionFeed(scope, undefined, 10)
  expect(migrated.scopeWatermark).toBe(before.scopeWatermark + 2)
  expect(migrated.items.map(item => item.watermark)).toEqual([before.scopeWatermark + 1, before.scopeWatermark + 2])
  for (const item of migrated.items) {
    expect(item.receipt.projection).toEqual(before.items.find(old => old.receipt.projection.subjectRef === item.receipt.projection.subjectRef)!.receipt.projection)
  }
  store.close()
  const check = new DatabaseSync(database, { readOnly: true })
  expect(check.prepare('SELECT * FROM evaluation_outcomes ORDER BY id').all()).toEqual(audit)
  expect(check.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  check.close()
  store = new EvaluationStore({ path: database, now: () => 2000 })
  expect(store.listTaskLearningProjectionFeed(scope, undefined, 10)).toEqual(migrated)
  store.close()
})

test('does not miss another connection updating a consumed subject between pages', () => {
  const database = path()
  let time = 2000
  const reader = new EvaluationStore({ path: database, now: () => ++time })
  const writer = new EvaluationStore({ path: database, now: () => ++time })
  try {
    reader.append(outcome('first')); reader.append(outcome('second'))
    const page = reader.listTaskLearningProjectionFeed(scope, undefined, 1)
    expect(page.items[0]!.receipt.projection.subjectRef).toBe('first')
    writer.append(outcome('first-updated', 'first', { objectiveStatus: 'not-achieved' }))
    writer.append(outcome('third'))
    writer.append(outcome('external', 'external', { trust: 'external' }))
    const next = reader.listTaskLearningProjectionFeed(scope, page.nextCursor, 10)
    expect(next.items.map(item => item.receipt.projection.subjectRef)).toEqual(['second', 'first', 'third'])
    expect(next.items[1]!.receipt.objective?.status).toBe('not-achieved')
    expect(next.items.every(item => item.receipt.scopeWatermark === next.scopeWatermark)).toBe(true)
    expect(reader.listTaskLearningProjectionFeed(scope, next.nextCursor, 10).items).toEqual([])
  } finally { writer.close(); reader.close() }
})

test('reads the existing trusted trigger when a newer primary does not change learning', () => {
  const database = path()
  let time = 2000
  const store = new EvaluationStore({ path: database, now: () => ++time })
  try {
    const first = store.append(outcome('verified', 'foreground', {
      source: { kind: 'evaluator', id: 'fixture-verifier' }, evaluator: { id: 'fixture-verifier', version: '1' },
      evidence: [{ kind: 'foreground-turn', ref: 'foreground' }],
    }))
    const before = store.listTaskLearningProjectionFeed(scope, undefined, 10)
    const newer = store.append(outcome('delivered', 'foreground', {
      source: { kind: 'delivery', id: 'fixture-delivery' }, objectiveStatus: 'unknown', deliveryStatus: 'delivered',
      evidence: [{ kind: 'foreground-turn', ref: 'foreground' }],
    }))
    const check = new DatabaseSync(database, { readOnly: true })
    try {
      expect(check.prepare('SELECT primary_outcome_id FROM evaluation_task_projections').get()).toMatchObject({ primary_outcome_id: newer.id })
      expect(check.prepare('SELECT evaluation_id FROM evaluation_projection_outbox WHERE evaluation_id = ?').get(newer.id)).toBeUndefined()
    } finally { check.close() }
    expect(store.listTaskLearningProjectionFeed(scope, undefined, 10)).toEqual(before)
    expect(before.items[0]!.receipt.triggerOutcomeId).toBe(first.id)
  } finally { store.close() }
})
