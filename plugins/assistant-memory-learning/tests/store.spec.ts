import { chmodSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { LearningStore } from '../src/store.ts'
import type { LearningCursor, LearningIntent, LearningSnapshot } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string { const root = mkdtempSync(join(tmpdir(), 'memory-learning-store-')); roots.push(root); return join(root, 'learning.sqlite') }
const grant = { authorityId: 'learning-one', configDigest: 'a'.repeat(64), maxExtractions: 2 }
const owner = { authorityId: grant.authorityId, authorityHash: 'b'.repeat(64), principalId: 'lark/primary/personal/ou_owner',
  principalRecordId: 'principal-one', principalVersion: 1, workspace: '/work/owner', agentPreset: 'standard' }
const delivery = (sequence: number): LearningCursor => ({ protocol: 'assistant-delivery/owner-foreground-source-cursor/v1',
  epoch: 'epoch-one', scopeKey: 'owner-scope', sequence })
const evaluation = (watermark: number): LearningCursor => ({ scopeKey: 'owner-scope', watermark })
function intent(kind: 'fact' | 'experience' = 'fact', version = 1, subject = 'task-one'): LearningIntent {
  return { configDigest: grant.configDigest, owner, kind, subject, inboxId: 'inbox-one',
    expectedSourceDigest: 'c'.repeat(64), createdAt: 1, expiresAt: 100_000,
    ...(kind === 'experience' ? { canonical: { outcomeId: 'outcome-one', version, digest: version.toString().repeat(64),
      objectiveStatus: 'not-achieved' as const } } : {}) }
}
function snapshot(item: LearningIntent): LearningSnapshot {
  return { model: { provider: 'fixture', model: 'fixed' }, source: { inboxId: item.inboxId,
    sourceDigest: item.expectedSourceDigest!, contentDigest: 'd'.repeat(64), ...(item.canonical ? { canonical: item.canonical } : {}) },
  ownerStatement: 'Owner states a fact.', assistantReply: 'Assistant answer.', targets: [] }
}
function stage(store: LearningStore, item: LearningIntent, sequence = 1, feed: 'delivery' | 'evaluation' = 'delivery',
  supersede = false): boolean {
  return store.stage({ lane: 'owner-one', feed, cursor: feed === 'delivery' ? delivery(sequence) : evaluation(sequence),
    sequence, subject: item.subject, intent: item, maxPending: 2, supersede })
}

test('persists intent before cursor, restarts, and keeps feeds independent for late canonical outcomes', () => {
  const database = path(); const store = new LearningStore(database, grant)
  const fact = intent(); expect(stage(store, fact)).toBe(true)
  expect(stage(store, fact)).toBe(true)
  expect(store.pending('owner-one')).toHaveLength(1)
  expect(store.cursor('owner-one', 'delivery')).toEqual(delivery(1))
  expect(store.cursor('owner-one', 'evaluation')).toBeUndefined()
  store.close()
  const reopened = new LearningStore(database, grant)
  expect(reopened.pending('owner-one')[0]?.intent).toEqual(fact)
  const experience = intent('experience')
  expect(stage(reopened, experience, 1, 'evaluation')).toBe(true)
  expect(reopened.cursor('owner-one', 'evaluation')).toEqual(evaluation(1))
  expect(reopened.cursor('owner-one', 'delivery')).toEqual(delivery(1))
  expect(reopened.counts('owner-one')).toMatchObject({ pending: 2, queued: 0 })
  reopened.close()
})

test('backpressure does not advance cursor and newer canonical experience supersedes only matching active experience', () => {
  const store = new LearningStore(path(), grant)
  const old = intent('experience'); const other = intent('fact', 1, 'other-task')
  stage(store, old, 1, 'evaluation'); stage(store, other, 2)
  expect(store.stage({ lane: 'owner-one', feed: 'evaluation', cursor: evaluation(3), sequence: 3,
    subject: 'third-task', intent: intent('fact', 1, 'third-task'), maxPending: 2 })).toBe(false)
  expect(store.cursor('owner-one', 'evaluation')).toEqual(evaluation(1))
  expect(stage(store, intent('experience', 2), 3, 'evaluation', true)).toBe(true)
  expect(store.pending('owner-one')).toHaveLength(2)
  expect(store.counts('owner-one')).toMatchObject({ pending: 2, superseded: 1 })
  expect(store.get(store.pending('owner-one').find(job => job.intent.subject === 'other-task')!.id)?.state).toBe('pending')
  expect(() => store.stage({ lane: 'owner-one', feed: 'delivery', cursor: { ...delivery(3), epoch: 'other-epoch' },
    sequence: 3, subject: 'task', maxPending: 2 })).toThrow(/epoch/)
  store.close()
})

test('freezes once, binds definition, claims at most once, persists request before interruption and guards terminal result', () => {
  const database = path(); const store = new LearningStore(database, { ...grant, maxExtractions: 1 })
  const input = intent(); stage(store, input)
  const id = store.pending('owner-one')[0]!.id
  expect(store.freeze(id, snapshot(input)).state).toBe('queued')
  expect(store.freeze(id, snapshot(input)).state).toBe('queued')
  expect(() => store.freeze(id, { ...snapshot(input), assistantReply: 'changed' })).toThrow(/immutable/)
  store.bind(id, 'e'.repeat(64))
  expect(() => store.bind(id, 'f'.repeat(64))).toThrow(/immutable/)
  const claimed = store.claim(id, 'e'.repeat(64), 'occurrence-one')
  expect(claimed.state).toBe('running')
  expect(store.availability()).toEqual({ remainingExtractions: 0, available: false })
  expect(() => store.claim(id, 'e'.repeat(64), 'occurrence-one')).toThrow()
  const request = { protocol: 'memory-learning-review/v1' as const, operationId: id, extractionSessionId: 'memory-extract-one',
    owner, source: snapshot(input).source, mutation: { op: 'add' as const, entry: { kind: 'fact' as const, content: 'Owner states a fact.' } },
    evidenceQuote: 'Owner states a fact.' }
  expect(store.saveRequest(id, 'occurrence-one', request).request).toEqual(request)
  expect(store.saveRequest(id, 'occurrence-one', request).request).toEqual(request)
  expect(() => store.saveRequest(id, 'occurrence-one', { ...request, evidenceQuote: 'wrong' })).toThrow(/immutable/)
  expect(() => store.saveRequest(id, 'occurrence-one', { ...request,
    source: { ...request.source, sourceDigest: 'f'.repeat(64) } })).toThrow(/frozen source/)
  const second = intent('fact', 1, 'task-two'); stage(store, second, 2)
  const secondId = store.pending('owner-one').find(job => job.id !== id)!.id
  store.freeze(secondId, snapshot(second)); store.bind(secondId, 'e'.repeat(64))
  expect(() => store.claim(secondId, 'e'.repeat(64), 'occurrence-two')).toThrow(/quota/)
  expect(store.get(secondId)?.state).toBe('queued')
  store.interrupt('owner-one')
  expect(store.get(id)).toMatchObject({ state: 'unknown', occurrenceId: 'occurrence-one', request })
  expect(() => store.claim(id, 'e'.repeat(64), 'new-occurrence')).toThrow()
  store.close()
  const restarted = new LearningStore(database, { ...grant, maxExtractions: 1 })
  expect(restarted.get(id)?.request).toEqual(request)
  restarted.settle(id, 'adopted', 'reviewed', 'f'.repeat(64), 'occurrence-one')
  expect(() => restarted.settle(id, 'failed', 'late failure', undefined, 'occurrence-one')).toThrow(/terminal/)
  expect(() => restarted.settle(id, 'adopted', 'reviewed', 'f'.repeat(64), 'other-occurrence')).toThrow(/occurrence/)
  restarted.close()
})

test('pins grant and rejects damaged digest and unsafe database paths', () => {
  const database = path(); const store = new LearningStore(database, grant); stage(store, intent()); const id = store.pending('owner-one')[0]!.id; store.close()
  expect(() => new LearningStore(database, { ...grant, configDigest: 'f'.repeat(64) })).toThrow(/grant/)
  expect(() => new LearningStore(database, { ...grant, maxExtractions: 3 })).toThrow(/grant/)
  const raw = new DatabaseSync(database); raw.prepare('UPDATE jobs SET digest=? WHERE id=?').run('0'.repeat(64), id); raw.close()
  const damaged = new LearningStore(database, grant)
  expect(() => damaged.get(id)).toThrow(/digest/)
  damaged.close()
  const unsafe = path(); rmSync(unsafe, { force: true }); symlinkSync(database, unsafe)
  expect(() => new LearningStore(unsafe, grant)).toThrow(/private/)
  chmodSync(database, 0o644)
  expect(() => new LearningStore(database, grant)).toThrow(/private/)
  const exposed = path(); chmodSync(join(exposed, '..'), 0o755)
  expect(() => new LearningStore(exposed, grant)).toThrow(/parent/)
})
