import { chmod, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
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
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
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

  test('enforces webhook cooldown durably without consuming the fire budget', async () => {
    let now = 1_000
    const value = await fixture(() => now)
    const first = value.store.acceptWebhook({
      triggerId: 'hook-cooldown', eventId: 'nonce-1', occurredAt: now, cooldownMs: 1_000, maxFires: 2,
    })
    expect(first.accepted).toBe(true)
    now = 1_500
    expect(value.store.acceptWebhook({
      triggerId: 'hook-cooldown', eventId: 'nonce-2', occurredAt: now, cooldownMs: 1_000, maxFires: 2,
    })).toMatchObject({ accepted: false, reason: 'cooldown' })
    value.store.close()

    now = 2_000
    const reopened = new EventTriggerStore({ path: value.path, now: () => now })
    expect(reopened.acceptWebhook({
      triggerId: 'hook-cooldown', eventId: 'nonce-2', occurredAt: now, cooldownMs: 1_000, maxFires: 2,
    }).accepted).toBe(true)
    expect(reopened.acceptWebhook({
      triggerId: 'hook-cooldown', eventId: 'nonce-3', occurredAt: 3_000, cooldownMs: 1_000, maxFires: 2,
    })).toMatchObject({ accepted: false, reason: 'limit' })
    reopened.close()
  })

  test('uses trusted receipt time rather than signed occurrence time for webhook cooldown', async () => {
    const value = await fixture(() => 100_000)
    expect(value.store.acceptWebhook({
      triggerId: 'receipt-time', eventId: 'old-signed-time', occurredAt: 40_000, acceptedAt: 100_000,
      cooldownMs: 30_000, maxFires: 10,
    }).accepted).toBe(true)
    expect(value.store.acceptWebhook({
      triggerId: 'receipt-time', eventId: 'new-signed-time', occurredAt: 100_000, acceptedAt: 100_000,
      cooldownMs: 30_000, maxFires: 10,
    })).toMatchObject({ accepted: false, reason: 'cooldown' })
    value.store.close()
  })

  test('migrates a v1 outbox without losing pending events', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-triggers-v1-'))
    roots.push(root)
    const path = join(root, 'events.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE trigger_state (
        trigger_id TEXT PRIMARY KEY, first_observed_at INTEGER NOT NULL, last_observed_at INTEGER NOT NULL,
        last_fingerprint TEXT NOT NULL, last_truthy INTEGER NOT NULL CHECK (last_truthy IN (0, 1)),
        edge_revision INTEGER NOT NULL DEFAULT 0, pending_fingerprint TEXT, pending_since INTEGER,
        pending_revision INTEGER, last_fire_at INTEGER, fire_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE event_outbox (
        id TEXT PRIMARY KEY, trigger_id TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE, occurred_at INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered')), attempts INTEGER NOT NULL DEFAULT 0,
        delivered_at INTEGER, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX event_outbox_pending ON event_outbox(status, created_at, id);
      INSERT INTO event_outbox VALUES ('outbox-v1', 'legacy', 'event-v1', 1000, 'pending', 2, NULL, 1000);
      PRAGMA user_version = 1;
    `)
    legacy.close()
    await chmod(path, 0o600)

    const migrated = new EventTriggerStore({ path, now: () => 2_000 })
    expect(migrated.pending()).toEqual([expect.objectContaining({ id: 'outbox-v1', attempts: 2, status: 'pending' })])
    expect(migrated.health()).toMatchObject({ pendingEvents: 1, retryingEvents: 1, quarantinedEvents: 0 })
    migrated.close()
    const inspected = new DatabaseSync(path, { readOnly: true })
    expect(inspected.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
    inspected.close()
  })

  test('persists retry, quarantine, and trigger failure health across reopen', async () => {
    let now = 1_000
    const value = await fixture(() => now)
    const retry = value.store.acceptWebhook({
      triggerId: 'retry', eventId: 'nonce-retry', occurredAt: now, cooldownMs: 0, maxFires: 10,
    })
    const poison = value.store.acceptWebhook({
      triggerId: 'poison', eventId: 'nonce-poison', occurredAt: now + 1, cooldownMs: 0, maxFires: 10,
    })
    if (!retry.accepted || !poison.accepted) throw new Error('test setup failed')
    value.store.markAttempt(retry.event.id)
    value.store.markRetry(retry.event.id, 'downstream unavailable', 2_000)
    now = 1_100
    value.store.quarantine(poison.event.id, 'trigger is no longer configured')
    value.store.markTriggerFailure('remote', 'DNS timed out', now)
    expect(value.store.pending()).toEqual([])
    expect(value.store.health()).toMatchObject({
      pendingEvents: 1, retryingEvents: 1, quarantinedEvents: 1, failingTriggers: 1,
      lastOutboxError: 'trigger is no longer configured', lastTriggerError: 'DNS timed out',
    })
    value.store.close()

    now = 2_000
    const reopened = new EventTriggerStore({ path: value.path, now: () => now })
    expect(reopened.pending()).toEqual([
      expect.objectContaining({ id: retry.event.id, attempts: 1, lastError: 'downstream unavailable' }),
    ])
    expect(reopened.health()).toMatchObject({ retryingEvents: 1, quarantinedEvents: 1, failingTriggers: 1 })
    reopened.markTriggerSuccess('remote', now)
    expect(reopened.health()).toMatchObject({ failingTriggers: 0 })
    reopened.close()
  })

  test('bounds hostile diagnostic values without breaking retry isolation', async () => {
    const value = await fixture()
    const accepted = value.store.acceptWebhook({
      triggerId: 'hostile-error', eventId: 'nonce', occurredAt: 1_000, cooldownMs: 0, maxFires: 10,
    })
    if (!accepted.accepted) throw new Error('test setup failed')
    value.store.markAttempt(accepted.event.id)
    const hostile = new Error('hostile')
    const coercion = vi.fn(() => { throw new Error('hostile coercion') })
    Object.defineProperty(hostile, 'message', {
      value: { toString: coercion },
    })

    expect(() => value.store.markRetry(accepted.event.id, hostile, 2_000)).not.toThrow()
    expect(coercion).not.toHaveBeenCalled()
    expect(value.store.health()).toMatchObject({ lastOutboxError: 'unknown failure' })
    value.store.close()
  })
})
