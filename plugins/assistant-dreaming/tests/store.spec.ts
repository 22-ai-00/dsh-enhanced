import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { DreamStore, ownData } from '../src/store.ts'

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
