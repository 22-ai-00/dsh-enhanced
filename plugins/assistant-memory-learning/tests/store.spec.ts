import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { canonicalGrowthJson, growthObjectDigest } from '@dsh-enhanced/assistant-growth-contract'
import { LearningStore } from '../src/store.ts'
import type { LearningCursor, LearningIntent, LearningSnapshot } from '../src/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string { const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-learning-store-'))); roots.push(root); return join(root, 'learning.sqlite') }
const grant = { authorityId: 'learning-one', configDigest: 'a'.repeat(64), maxExtractions: 2 }
const owner = { authorityId: grant.authorityId, authorityHash: 'b'.repeat(64), principalId: 'lark/primary/personal/ou_owner',
  principalRecordId: 'principal-one', principalVersion: 1, workspace: '/work/owner', agentPreset: 'standard' }
const delivery = (sequence: number): LearningCursor => ({ protocol: 'assistant-delivery/owner-foreground-source-cursor/v1',
  epoch: 'epoch-one', scopeKey: 'owner-scope', sequence })
const evaluation = (watermark: number): LearningCursor => ({ scopeKey: 'owner-scope', watermark })
function intent(kind: 'fact' | 'experience' = 'fact', version = 1, subject = 'task-one'): Extract<LearningIntent, { inboxId: string }> {
  return { configDigest: grant.configDigest, owner, kind, subject, inboxId: 'inbox-one',
    expectedSourceDigest: 'c'.repeat(64), createdAt: 1, expiresAt: 100_000,
    ...(kind === 'experience' ? { canonical: { outcomeId: 'outcome-one', version, digest: version.toString().repeat(64),
      objectiveStatus: 'not-achieved' as const } } : {}) }
}
function snapshot(item: Extract<LearningIntent, { inboxId: string }>): Extract<LearningSnapshot, { ownerStatement: string }> {
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

test('migrates a populated schema1 database without rewriting jobs, grant, digests or consumption', () => {
  const database = path(), old = new DatabaseSync(database)
  old.exec(`CREATE TABLE grant_record (authority_id TEXT PRIMARY KEY, config_digest TEXT NOT NULL, max_extractions INTEGER NOT NULL, consumed INTEGER NOT NULL DEFAULT 0) STRICT;
    CREATE TABLE cursors (lane TEXT NOT NULL, feed TEXT NOT NULL, cursor_json TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(lane,feed)) STRICT, WITHOUT ROWID;
    CREATE TABLE jobs (id TEXT PRIMARY KEY, lane TEXT NOT NULL, subject TEXT NOT NULL, intent_json TEXT NOT NULL, digest TEXT NOT NULL,
      state TEXT NOT NULL, snapshot_json TEXT, definition_hash TEXT, occurrence_id TEXT, request_json TEXT, result_digest TEXT, reason TEXT) STRICT;
    CREATE INDEX jobs_lane_state ON jobs(lane,state); PRAGMA user_version=1;`)
  old.prepare('INSERT INTO grant_record VALUES(?,?,?,?)').run(grant.authorityId, grant.configDigest, grant.maxExtractions, 1)
  old.prepare('INSERT INTO cursors VALUES(?,?,?,?)').run('owner-one', 'evaluation', JSON.stringify(evaluation(90)), 90)
  const originalIntent = intent()
  const originalId = `memory-learning:${growthObjectDigest({ authorityId: grant.authorityId, kind: originalIntent.kind,
    subject: originalIntent.subject, revision: originalIntent.expectedSourceDigest })}`
  old.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(originalId, 'owner-one', originalIntent.subject, canonicalGrowthJson(originalIntent), growthObjectDigest(originalIntent), 'pending', null, null, null, null, null, null)
  const originalRow = old.prepare('SELECT * FROM jobs').get()
  old.close(); chmodSync(database, 0o600)
  const populated = new LearningStore(database, grant)
  const before = populated.pending('owner-one')[0]!
  populated.close()
  const reopened = new LearningStore(database, grant)
  expect(reopened.get(before.id)).toEqual(before)
  expect(reopened.cursor('owner-one', 'evaluation')).toEqual(evaluation(90))
  expect(reopened.availability().remainingExtractions).toBe(1)
  expect(reopened.cursor('owner-one', 'evaluation-work-items')).toBeUndefined()
  reopened.close()
  const inspect = new DatabaseSync(database)
  expect(inspect.prepare('SELECT * FROM jobs').get()).toEqual(originalRow)
  expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 }); inspect.close()
  expect(() => new LearningStore(database, { ...grant, configDigest: 'f'.repeat(64) })).toThrow(/immutable grant/)
})

test('work-item locator persists before reader availability, with independent cursor and bounded queue', () => {
  const database = path(), store = new LearningStore(database, grant)
  store.stage({ lane: 'owner-one', feed: 'evaluation', cursor: evaluation(90), sequence: 90, subject: 'cursor:old', maxPending: 1 })
  const item: LearningIntent = { configDigest: grant.configDigest, owner, kind: 'experience', sourceKind: 'work-item',
    itemId: 'background-one', subject: 'work-item:background-one', canonical: { outcomeId: 'objective-current', version: 1,
      digest: 'b'.repeat(64), objectiveStatus: 'not-achieved' }, createdAt: 1, expiresAt: 100_000 }
  const append = (sequence: number, input: LearningIntent) => store.stage({ lane: 'owner-one', feed: 'evaluation-work-items',
    cursor: evaluation(sequence), sequence, subject: input.subject, intent: input, maxPending: 1, supersede: true })
  expect(append(1, item)).toBe(true); expect(append(1, item)).toBe(true)
  expect(store.pending('owner-one')).toHaveLength(1)
  expect(store.pending('owner-one')[0]!.intent).not.toHaveProperty('inboxId')
  expect(append(2, { ...item, itemId: 'background-two', subject: 'work-item:background-two' })).toBe(false)
  expect(store.cursor('owner-one', 'evaluation-work-items')).toEqual(evaluation(1))
  const job = store.pending('owner-one')[0]!
  const frozen: LearningSnapshot = { sourceKind: 'work-item', presentationFlags: { brief: { truncated: false, redacted: false }, report: { truncated: false, redacted: false }, feedback: { truncated: false, redacted: false } }, model: { provider: 'original', model: 'fixed' },
    source: { protocol: 'memory-learning-source/work-item/v1', itemId: 'background-one', sourceDigest: 'd'.repeat(64),
      contentDigest: 'e'.repeat(64), canonical: item.canonical! }, taskBrief: 'Untrusted worker context.',
    workerReport: 'Worker claims success.', ownerFeedback: 'The objective was not achieved.', targets: [] }
  store.freeze(job.id, frozen); store.close()
  const restarted = new LearningStore(database, grant)
  expect(restarted.get(job.id)!.snapshot).toEqual(frozen)
  expect(restarted.get(job.id)!.snapshot!.model).not.toHaveProperty('reasoningEffort')
  restarted.close()
})
