import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { DreamStore, ownData } from '../src/store.ts'
import { TICKET_MODULUS } from '../src/trigger.ts'

const TICKET_MAX = TICKET_MODULUS

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeStore(lane = 'test-lane'): Promise<{ store: DreamStore; root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dream-store-'))
  roots.push(root)
  const path = join(root, 'state', 'dream.sqlite')
  return { store: new DreamStore(path, lane), root, path }
}

const REF = 'a'.repeat(64)

describe('dream store', () => {
  test('records one dream with per-day counter and unique occurrence', async () => {
    const { store } = await makeStore()
    const run = store.beginDream('run-1', 5, '2026-11-08', 1_000, 'f'.repeat(64))
    expect(run.outcome).toBe('running')
    expect(store.countDreams('2026-11-08')).toBe(1)
    expect(() => store.beginDream('run-2', 5, '2026-11-08', 2_000, 'f'.repeat(64))).toThrow()
    const idea = store.recordIdea({
      id: 'idea-1', runId: 'run-1', createdAt: 1_100, dayKey: '2026-11-08',
      summary: 'A playful automation idea', detail: 'detail', evidenceRefs: [REF],
    })
    expect(idea.state).toBe('recorded')
    expect(() => store.recordIdea({
      id: 'idea-2', runId: 'run-1', createdAt: 1_200, dayKey: '2026-11-08',
      summary: 'A playful automation idea', detail: 'duplicate', evidenceRefs: [REF],
    })).toThrow()
    expect(() => store.recordIdea({
      id: 'idea-3', runId: 'run-1', createdAt: 1_300, dayKey: '2026-11-08',
      summary: 'unreferenced', detail: 'd', evidenceRefs: ['zz'],
    })).toThrow()
    store.completeDream('run-1', 2_000, 1)
    expect(store.run('run-1')).toMatchObject({ outcome: 'completed', ideaCount: 1 })
    expect(store.counts()).toEqual({ runs: 1, ideas: 1, recorded: 1 })
    store.close()
  })

  test('transitions follow the finite state machine and persist events', async () => {
    const { store } = await makeStore()
    store.beginDream('run-1', 1, '2026-11-08', 1, 'f'.repeat(64))
    store.recordIdea({
      id: 'idea-1', runId: 'run-1', createdAt: 10, dayKey: '2026-11-08',
      summary: 's', detail: 'd', evidenceRefs: [REF],
    })
    store.transitionIdea('idea-1', 'owner-acknowledged', 'owner', 20)
    store.transitionIdea('idea-1', 'validated', 'host', 30)
    expect(store.idea('idea-1')!.state).toBe('validated')
    expect(() => store.transitionIdea('idea-1', 'rejected', 'host', 40)).toThrow(/not allowed/)
    expect(() => store.transitionIdea('missing', 'validated', 'owner', 50)).toThrow()
    store.close()
  })

  test('interrupts running dreams and prunes expired ideas', async () => {
    const { store } = await makeStore()
    store.beginDream('run-1', 1, '2026-11-08', 1, 'f'.repeat(64))
    store.recordIdea({
      id: 'old', runId: 'run-1', createdAt: 1, dayKey: '2026-01-01',
      summary: 's', detail: 'd', evidenceRefs: [REF],
    })
    store.recordIdea({
      id: 'new', runId: 'run-1', createdAt: 10_000, dayKey: '2026-11-08',
      summary: 's2', detail: 'd', evidenceRefs: [REF],
    })
    store.interrupt()
    expect(store.run('run-1')!.outcome).toBe('interrupted')
    expect(store.prune(10_000 + 86_400_000 * 10, 10)).toBe(1)
    expect(store.idea('old')).toBeUndefined()
    expect(store.idea('new')!.summary).toBe('s2')
    store.close()
    expect(store.isClosed).toBe(true)
  })

  test('prunes an expired idea with lifecycle events instead of failing its foreign key', async () => {
    const { store, path } = await makeStore()
    store.beginDream('run-events', 1, '2026-11-08', 1, 'f'.repeat(64))
    store.recordIdea({
      id: 'old-with-events', runId: 'run-events', createdAt: 1, dayKey: '2026-01-01',
      summary: 's', detail: 'd', evidenceRefs: [REF],
    })
    // A lifecycle event row references the idea; without deleting events first
    // the delete would abort with FOREIGN KEY constraint failed.
    store.transitionIdea('old-with-events', 'owner-acknowledged', 'owner', 2)
    expect(store.prune(10_000 + 86_400_000 * 10, 10)).toBe(1)
    expect(store.idea('old-with-events')).toBeUndefined()
    store.close()
    const check = new DatabaseSync(path)
    const remaining = check.prepare('SELECT COUNT(*) AS n FROM dream_idea_events').get()!
    check.close()
    expect(Number(remaining['n'])).toBe(0)
  })
})

describe('ownData guard', () => {
  test('rejects proxies, getters and oversized text', () => {
    expect(() => ownData(new Proxy({}, {}))).toThrow()
    const withGetter = Object.create(Object.prototype, { value: { get: () => 1 } })
    expect(() => ownData(withGetter)).toThrow()
    expect(() => ownData('x'.repeat(70_000))).toThrow()
    expect(ownData({ nested: { list: [1, true, 'ok'] } })).toEqual({ nested: { list: [1, true, 'ok'] } })
  })
})

describe('lottery tickets and recalls (schema 2)', () => {
  const DIGEST = (n: number) => n.toString(16).padStart(64, '0')

  test('registers tickets idempotently, lists them and rejects invalid rows', async () => {
    const { store } = await makeStore()
    store.upsertTicket({ subjectKind: 'task-projection', subjectKey: 'task-1', value: 123, digest: DIGEST(1), now: 1 })
    store.upsertTicket({ subjectKind: 'task-projection', subjectKey: 'task-1', value: 999, digest: DIGEST(2), now: 2 })
    store.upsertTicket({ subjectKind: 'goal', subjectKey: 'goal-1', value: TICKET_MAX - 1, digest: DIGEST(3), now: 3 })
    expect(store.listTickets()).toEqual([
      { subjectKind: 'task-projection', subjectKey: 'task-1', value: 123, digest: DIGEST(1) },
      { subjectKind: 'goal', subjectKey: 'goal-1', value: TICKET_MAX - 1, digest: DIGEST(3) },
    ])
    expect(() => store.upsertTicket({ subjectKind: 'alien', subjectKey: 'x', value: 1, digest: DIGEST(1), now: 1 })).toThrow()
    expect(() => store.upsertTicket({ subjectKind: 'goal', subjectKey: '', value: 1, digest: DIGEST(1), now: 1 })).toThrow()
    expect(() => store.upsertTicket({ subjectKind: 'goal', subjectKey: 'x', value: TICKET_MAX, digest: DIGEST(1), now: 1 })).toThrow()
    expect(() => store.upsertTicket({ subjectKind: 'goal', subjectKey: 'x', value: 1, digest: 'zz', now: 1 })).toThrow()
    store.close()
  })

  test('records recalls once per slot and reads the latest one', async () => {
    const { store } = await makeStore()
    const recall = { occurrence: 7, drawDigest: DIGEST(9), drawValue: 100, subjectKind: 'goal',
      subjectKey: 'goal-1', ticketValue: 110, distance: 10, at: 1_000 }
    expect(store.recordRecall(recall)).toBe(true)
    expect(store.recordRecall(recall)).toBe(false)
    expect(store.lastRecall()).toEqual({ occurrence: 7, subjectKind: 'goal', subjectKey: 'goal-1', at: 1_000 })
    expect(store.recordRecall({ ...recall, occurrence: 8, at: 2_000 })).toBe(true)
    expect(store.lastRecall()!.occurrence).toBe(8)
    // INSERT OR IGNORE downgrades the CHECK failure to a refusal: the bad row
    // is never stored and the latest recall stays untouched.
    expect(store.recordRecall({ ...recall, occurrence: 9, distance: -1 })).toBe(false)
    expect(store.lastRecall()!.occurrence).toBe(8)
    store.close()
  })

  test('drops tickets of resolved or pruned recorded ideas but keeps active ones', async () => {
    const { store } = await makeStore()
    store.beginDream('run-1', 1, '2026-11-08', 1, 'f'.repeat(64))
    const makeIdea = (id: string) => store.recordIdea({
      id, runId: 'run-1', createdAt: 10, dayKey: '2026-11-08',
      summary: `s-${id}`, detail: 'd', evidenceRefs: [REF],
    })
    makeIdea('idea-open')
    makeIdea('idea-done')
    store.transitionIdea('idea-done', 'validated', 'owner', 20)
    store.upsertTicket({ subjectKind: 'recorded-idea', subjectKey: 'idea-open', value: 1, digest: DIGEST(1), now: 1 })
    store.upsertTicket({ subjectKind: 'recorded-idea', subjectKey: 'idea-done', value: 2, digest: DIGEST(2), now: 1 })
    store.upsertTicket({ subjectKind: 'recorded-idea', subjectKey: 'idea-ghost', value: 3, digest: DIGEST(3), now: 1 })
    store.upsertTicket({ subjectKind: 'goal', subjectKey: 'goal-1', value: 4, digest: DIGEST(4), now: 1 })
    expect(store.pruneResolvedIdeaTickets()).toBe(2)
    const remaining = store.listTickets().map(row => row.subjectKey)
    expect(remaining).toEqual(['goal-1', 'idea-open'])
    // Idempotent: nothing left to prune on the next wake.
    expect(store.pruneResolvedIdeaTickets()).toBe(0)
    store.close()
  })

  test('migrates a schema 1 ledger to 2 without losing dream data', async () => {
    const { store, path } = await makeStore()
    store.beginDream('run-1', 1, '2026-11-08', 1, 'f'.repeat(64))
    store.recordIdea({
      id: 'idea-1', runId: 'run-1', createdAt: 10, dayKey: '2026-11-08',
      summary: 's', detail: 'd', evidenceRefs: [REF],
    })
    store.close()
    // Downgrade the physical file to schema 1 and reopen: the additive
    // migration must keep the dream ledger intact and add the lottery tables.
    const legacy = new DatabaseSync(path)
    legacy.exec('DROP TABLE dream_recalls; DROP TABLE dream_tickets; PRAGMA user_version = 1;')
    legacy.close()
    const migrated = new DreamStore(path, 'test-lane')
    expect(migrated.run('run-1')).toMatchObject({ outcome: 'running', ideaCount: 1 })
    expect(migrated.idea('idea-1')).toMatchObject({ summary: 's', state: 'recorded' })
    migrated.upsertTicket({ subjectKind: 'skill', subjectKey: 'sk', value: 5, digest: DIGEST(1), now: 2 })
    expect(migrated.listTickets()).toHaveLength(1)
    migrated.close()
  })
})
