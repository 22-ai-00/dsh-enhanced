import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
import { EventTriggerStore, EventTriggerStoreError } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(now: () => number = () => 1_000) {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-store-'))
  roots.push(root)
  const path = join(root, 'state', 'events.sqlite')
  return { root, path, store: new EventTriggerStore({ path, now }) }
}

describe('event trigger state store', () => {
  test('opens private WAL storage and refuses future schemas', async () => {
    const value = await fixture()
    expect((await stat(join(value.root, 'state'))).mode & 0o777).toBe(0o700)
    expect((await stat(value.path)).mode & 0o777).toBe(0o600)
    const db = new DatabaseSync(value.path, { readOnly: true })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    db.close(); value.store.close()

    const future = join(value.root, 'future.sqlite')
    const newer = new DatabaseSync(future); newer.exec('PRAGMA user_version = 99'); newer.close(); await chmod(future, 0o600)
    expect(() => new EventTriggerStore({ path: future }))
      .toThrowError(expect.objectContaining<Partial<EventTriggerStoreError>>({ code: 'schema-too-new' }))
  })

  test('uses baseline, debounce, cooldown and stable edge outbox ids', async () => {
    let now = 1_000
    const value = await fixture(() => now)
    const options = { triggerId: 'file-a', fireWhen: 'changed' as const, debounceMs: 500,
      cooldownMs: 1_000, maxFires: 10 }
    expect(value.store.observe({ ...options, fingerprint: 'v1', truthy: true, occurredAt: now })).toEqual([])
    now = 2_000
    expect(value.store.observe({ ...options, fingerprint: 'v2', truthy: true, occurredAt: now })).toEqual([])
    now = 2_499
    expect(value.store.observe({ ...options, fingerprint: 'v2', truthy: true, occurredAt: now })).toEqual([])
    now = 2_500
    const first = value.store.observe({ ...options, fingerprint: 'v2', truthy: true, occurredAt: now })
    expect(first).toHaveLength(1)
    expect(value.store.observe({ ...options, fingerprint: 'v2', truthy: true, occurredAt: now })).toEqual([])
    now = 2_600
    value.store.observe({ ...options, fingerprint: 'v3', truthy: true, occurredAt: now })
    now = 3_100
    expect(value.store.observe({ ...options, fingerprint: 'v3', truthy: true, occurredAt: now })).toEqual([])
    now = 3_500
    const second = value.store.observe({ ...options, fingerprint: 'v3', truthy: true, occurredAt: now })
    expect(second).toHaveLength(1)
    expect(second[0]?.eventId).not.toBe(first[0]?.eventId)
    expect(value.store.pending()).toHaveLength(2)
    value.store.markDelivered(first[0]!.id)
    expect(value.store.pending()).toEqual([second[0]])
    value.store.close()
    const reopened = new EventTriggerStore({ path: value.path, now: () => now })
    expect(reopened.pending()).toEqual([second[0]])
    reopened.close()
  })

  test('fires only false-to-true, enforces TTL/maxFires, and deduplicates webhook event ids', async () => {
    const value = await fixture()
    const options = { triggerId: 'truth', fireWhen: 'truthy' as const, debounceMs: 0,
      cooldownMs: 0, maxFires: 1, ttlMs: 1_000 }
    expect(value.store.observe({ ...options, fingerprint: 'false', truthy: false, occurredAt: 1_000 })).toEqual([])
    expect(value.store.observe({ ...options, fingerprint: 'true', truthy: true, occurredAt: 1_100 })).toHaveLength(1)
    value.store.observe({ ...options, fingerprint: 'false-2', truthy: false, occurredAt: 1_200 })
    expect(value.store.observe({ ...options, fingerprint: 'true-2', truthy: true, occurredAt: 1_300 })).toEqual([])
    expect(value.store.observe({ ...options, fingerprint: 'late', truthy: false, occurredAt: 2_001 })).toEqual([])

    const hook = value.store.acceptWebhook({ triggerId: 'hook', eventId: 'nonce-1', occurredAt: 2_000, maxFires: 10 })
    expect(hook.accepted).toBe(true)
    expect(value.store.acceptWebhook({ triggerId: 'hook', eventId: 'nonce-1', occurredAt: 2_000, maxFires: 10 }))
      .toMatchObject({ accepted: false, event: hook.event })
    value.store.close()
  })
})
