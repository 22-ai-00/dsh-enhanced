import { mkdtemp, rm } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import {
  DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
  type DeliveryPreferenceFeedback,
  type DeliveryPreferenceRegistration,
} from '../src/types.ts'

const roots: string[] = []
const epoch = '0123456789abcdef0123456789abcdef'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function feedback(
  sequence: number,
  candidateValue: 'helpful' | 'wrong-action' | 'wrong-format',
  principalVersion = 1,
): DeliveryPreferenceFeedback {
  return Object.freeze({
    scope: Object.freeze({ workspace: '/work/owner', preset: 'primary' }),
    principalId: 'lark/bot/tenant/owner',
    principalLineage: Object.freeze({
      principalRecordId: 'principal-owner',
      principalVersion,
    }),
    admissionCursor: Object.freeze({ epoch, sequence }),
    preferenceKey: 'feedback.response',
    candidateValue,
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: 'typed-feedback',
    source: 'direct-owner-feedback',
    occurredAt: 100,
    idempotencyKey: `preference-projection-${principalVersion}-${sequence}-${candidateValue}`,
  })
}

describe('durable preference projection owner lanes', () => {
  test('terminally retires pending, retry, legacy, and unclassified rows across A-to-B-to-A handoff and restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-owner-handoff-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    let now = 100
    const ownerAKey = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
    const ownerBKey = { ...ownerAKey, user: 'replacement' }
    const store = new DeliveryStore({ path, now: () => now })
    const ownerA1 = store.handoffOwner(ownerAKey)
    const event = (sequence: number, candidateValue: 'helpful' | 'wrong-action' | 'wrong-format') => ({
      ...feedback(sequence, candidateValue, ownerA1.version),
      principalLineage: {
        principalRecordId: ownerA1.id,
        principalVersion: ownerA1.version,
      },
    })
    const pending = store.enqueuePreferenceProjection([event(1, 'helpful')])
    const retry = store.enqueuePreferenceProjection([event(2, 'wrong-action')])
    store.deferPreferenceProjection({
      ...retry,
      now,
      retryAt: 1_000,
      failureCode: 'sink-temporary',
    })
    const { principalLineage: _lineage, admissionCursor: _cursor, ...legacyEvent } =
      event(3, 'wrong-format')
    const legacy = store.enqueuePreferenceProjection([legacyEvent as DeliveryPreferenceFeedback])
    const unclassified = store.enqueuePreferenceProjection([event(4, 'helpful')])
    const raw = new DatabaseSync(path)
    try {
      raw.prepare(`
        UPDATE delivery_preference_projection_outbox
        SET lane_kind = 'unclassified', lane_epoch = NULL, lane_workspace = NULL,
          lane_preset = NULL, lane_principal_record_id = NULL,
          lane_principal_version = NULL, admission_sequence = NULL
        WHERE batch_key = ?
      `).run(unclassified.batchKey)
    } finally {
      raw.close()
    }

    now = 200
    store.handoffOwner(ownerBKey)
    const ownerA3 = store.handoffOwner(ownerAKey)
    expect(ownerA3.id).toBe(ownerA1.id)
    expect(ownerA3.version).toBeGreaterThan(ownerA1.version)
    expect(store.listPendingPreferenceProjections()).toEqual([])
    store.requeuePreferenceProjections()
    expect(store.listPendingPreferenceProjections()).toEqual([])
    store.close()

    const audit = new DatabaseSync(path, { readOnly: true })
    try {
      expect(audit.prepare(`
        SELECT batch_key, status, terminal_at, failure_code
        FROM delivery_preference_projection_outbox ORDER BY batch_key
      `).all()).toEqual([
        pending.batchKey,
        retry.batchKey,
        legacy.batchKey,
        unclassified.batchKey,
      ].sort().map(batchKey => expect.objectContaining({
        batch_key: batchKey,
        terminal_at: 200,
        failure_code: 'owner-lineage-retired',
      })))
    } finally {
      audit.close()
    }

    const restarted = new DeliveryStore({ path, now: () => 300 })
    expect(restarted.listPendingPreferenceProjections()).toEqual([])
    expect(restarted.enqueuePreferenceProjection([event(1, 'helpful')])).toMatchObject({
      batchKey: pending.batchKey,
      replayed: true,
    })
    expect(restarted.listPendingPreferenceProjections()).toEqual([])
    restarted.close()
  })

  test('rechecks a previously-read batch under the live owner writer fence before sink I/O', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-owner-fence-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const ownerAKey = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
    const ownerBKey = { ...ownerAKey, user: 'replacement' }
    const reader = new DeliveryStore({ path, now: () => 100 })
    const ownerA1 = reader.handoffOwner(ownerAKey)
    const event = {
      ...feedback(1, 'helpful', ownerA1.version),
      principalLineage: {
        principalRecordId: ownerA1.id,
        principalVersion: ownerA1.version,
      },
    }
    reader.enqueuePreferenceProjection([event])
    const staleRead = reader.listPendingPreferenceProjections()[0]!

    const handoff = new DeliveryStore({ path, now: () => 200 })
    handoff.handoffOwner(ownerBKey)
    handoff.handoffOwner(ownerAKey)
    const sink = vi.fn()
    expect(reader.projectPreferenceProjectionUnderOwnerFence(staleRead, sink)).toBe('ignored')
    expect(sink).not.toHaveBeenCalled()
    expect(() => reader.completePreferenceProjection(staleRead)).not.toThrow()
    expect(() => reader.deferPreferenceProjection({
      ...staleRead,
      now: 200,
      retryAt: 300,
      failureCode: 'late-sink-failure',
    })).not.toThrow()
    expect(reader.listPendingPreferenceProjections()).toEqual([])
    handoff.close()
    reader.close()
  })

  test('the service worker skips Preference when handoff lands after outbox selection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-service-fence-'))
    roots.push(root)
    const ctx = new Context()
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
    })
    try {
      const service = ctx.assistantDelivery
      const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
      const ownerAKey = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
      const ownerBKey = { ...ownerAKey, user: 'replacement' }
      const ownerA1 = store.handoffOwner(ownerAKey)
      store.enqueuePreferenceProjection([{
        ...feedback(1, 'helpful', ownerA1.version),
        principalLineage: { principalRecordId: ownerA1.id, principalVersion: ownerA1.version },
      }])
      const list = store.listPendingPreferenceProjections.bind(store)
      vi.spyOn(store, 'listPendingPreferenceProjections').mockImplementationOnce((...args) => {
        const selected = list(...args)
        store.handoffOwner(ownerBKey)
        store.handoffOwner(ownerAKey)
        return selected
      })

      const append = vi.fn((events: readonly { idempotencyKey: string }[]) =>
        events.map(event => ({ idempotencyKey: event.idempotencyKey, status: 'recorded' as const })))
      const owned = new WeakSet<object>()
      const registration: Readonly<DeliveryPreferenceRegistration> = Object.freeze({
        protocol: DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
        producer: 'preference-learning',
        generation: service.trustedPreferenceProducerGeneration(),
        owner: Object.freeze({
          ownsDeliveryPreferenceRegistration: (candidate: Readonly<DeliveryPreferenceRegistration>) =>
            owned.has(candidate),
        }),
        append,
        appendSynchronously: append,
      })
      owned.add(registration)
      service.registerTrustedPreferenceSink(registration)
      await service.whenIdle()

      expect(append).not.toHaveBeenCalled()
      expect(store.listPendingPreferenceProjections()).toEqual([])
    } finally {
      await ctx.fiber.restart()
    }
  })

  test('replays the same lineage after Preference commits but Delivery loses its ACK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-current-fence-'))
    roots.push(root)
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => 100 })
    const preference = new DatabaseSync(join(root, 'preference.sqlite'))
    preference.exec(`
      CREATE TABLE received_events (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        received_count INTEGER NOT NULL
      ) STRICT;
    `)
    const owner = store.handoffOwner({ channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' })
    const queued = store.enqueuePreferenceProjection([{
      ...feedback(1, 'helpful', owner.version),
      principalLineage: { principalRecordId: owner.id, principalVersion: owner.version },
    }])
    const firstRead = store.listPendingPreferenceProjections()[0]!
    expect(() => store.projectPreferenceProjectionUnderOwnerFence(firstRead, () => {
      preference.prepare(`
        INSERT INTO received_events(idempotency_key, received_count) VALUES (?, 1)
      `).run(firstRead.events[0]!.idempotencyKey)
      // This is the injectable crash seam for end-to-end tests: wrap the
      // fenced `project` callback, let the real synchronous Preference append
      // return (and commit its separate SQLite DB), then throw before Delivery
      // can delete its outbox row.
      throw new Error('simulated crash after Preference commit before Delivery ACK')
    })).toThrow(/after Preference commit/u)
    expect(preference.prepare('SELECT COUNT(*) AS count FROM received_events').get())
      .toEqual({ count: 1 })
    const replay = store.listPendingPreferenceProjections()[0]!
    const sink = vi.fn((entry: typeof replay) => {
      preference.prepare(`
        INSERT INTO received_events(idempotency_key, received_count) VALUES (?, 1)
        ON CONFLICT(idempotency_key) DO NOTHING
      `).run(entry.events[0]!.idempotencyKey)
    })
    expect(store.projectPreferenceProjectionUnderOwnerFence(replay, sink)).toBe('completed')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(preference.prepare('SELECT received_count FROM received_events').get())
      .toEqual({ received_count: 1 })
    expect(store.listPendingPreferenceProjections()).toEqual([])
    expect(() => store.completePreferenceProjection(queued)).not.toThrow()
    preference.close()
    store.close()
  })

  test('selects only exact lane heads even when the earlier retry is not due', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-lane-store-'))
    roots.push(root)
    let now = 100
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => now })
    const old = store.enqueuePreferenceProjection([feedback(1, 'helpful')])
    store.deferPreferenceProjection({
      batchKey: old.batchKey,
      payloadDigest: old.payloadDigest,
      now,
      retryAt: 200,
      failureCode: 'sink-temporary',
    })
    const newer = store.enqueuePreferenceProjection([feedback(2, 'wrong-format')])
    const otherLineage = store.enqueuePreferenceProjection([feedback(3, 'wrong-action', 2)])

    now = 150
    expect(store.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: otherLineage.batchKey }),
    ])
    store.completePreferenceProjection(otherLineage)
    expect(store.listPendingPreferenceProjections()).toEqual([])
    expect(store.hasBlockingPreferenceProjectionBefore({
      scope: { workspace: '/work/owner', preset: 'primary' },
      principalLineage: { principalRecordId: 'principal-owner', principalVersion: 1 },
      admissionCursor: { epoch, sequence: 3 },
    })).toBe(true)
    expect(store.nextPreferenceProjectionAttemptAt()).toBe(200)

    now = 200
    expect(store.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: old.batchKey }),
    ])
    store.completePreferenceProjection(old)
    expect(store.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: newer.batchKey }),
    ])
    store.close()
  })

  test('uses a cursorless rolling-upgrade row as a global barrier until it is terminal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-legacy-lane-'))
    roots.push(root)
    let now = 100
    const store = new DeliveryStore({ path: join(root, 'delivery.sqlite'), now: () => now })
    const { principalLineage: _lineage, admissionCursor: _cursor, ...legacyEvent } = feedback(1, 'helpful')
    const legacy = store.enqueuePreferenceProjection([legacyEvent as DeliveryPreferenceFeedback])
    store.deferPreferenceProjection({
      batchKey: legacy.batchKey,
      payloadDigest: legacy.payloadDigest,
      now,
      retryAt: 200,
      failureCode: 'legacy-sink-temporary',
    })
    const exact = store.enqueuePreferenceProjection([feedback(2, 'wrong-format')])

    now = 150
    expect(store.listPendingPreferenceProjections()).toEqual([])
    expect(store.hasBlockingPreferenceProjectionBefore({
      scope: { workspace: '/work/owner', preset: 'primary' },
      principalLineage: { principalRecordId: 'principal-owner', principalVersion: 1 },
      admissionCursor: { epoch, sequence: 3 },
    })).toBe(true)
    now = 200
    expect(store.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: legacy.batchKey }),
    ])
    store.completePreferenceProjection(legacy)
    expect(store.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: exact.batchKey }),
    ])
    store.close()
  })

  test('terminally quarantines an irreparable row instead of deadlocking its lane forever', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-poison-lane-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const first = new DeliveryStore({ path, now: () => 100 })
    const poisoned = first.enqueuePreferenceProjection([feedback(1, 'helpful')])
    first.close()
    const database = new DatabaseSync(path)
    try {
      database.prepare(`
        UPDATE delivery_preference_projection_outbox
        SET events_json = '[{}]', next_attempt_at = 999999
        WHERE batch_key = ?
      `).run(poisoned.batchKey)
    } finally {
      database.close()
    }

    const reopened = new DeliveryStore({ path, now: () => 200 })
    expect(reopened.hasBlockingPreferenceProjectionBefore({
      scope: { workspace: '/work/owner', preset: 'primary' },
      principalLineage: { principalRecordId: 'principal-owner', principalVersion: 1 },
      admissionCursor: { epoch, sequence: 2 },
    })).toBe(false)
    expect(reopened.listPendingPreferenceProjections()).toEqual([])
    const later = reopened.enqueuePreferenceProjection([feedback(2, 'wrong-action')])
    expect(reopened.listPendingPreferenceProjections()).toEqual([
      expect.objectContaining({ batchKey: later.batchKey }),
    ])
    reopened.close()
    const audit = new DatabaseSync(path, { readOnly: true })
    try {
      expect(audit.prepare(`
        SELECT terminal_at, failure_code
        FROM delivery_preference_projection_outbox WHERE batch_key = ?
      `).get(poisoned.batchKey)).toEqual({
        terminal_at: 200,
        failure_code: 'projection-poison-row',
      })
    } finally {
      audit.close()
    }
  })

  test('converges when two Delivery stores finish or defer the same idempotent head', async () => {
    const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-preference-peer-drain-'))
    roots.push(root)
    const path = join(root, 'delivery.sqlite')
    const first = new DeliveryStore({ path, now: () => 100 })
    const second = new DeliveryStore({ path, now: () => 100 })
    const completed = first.enqueuePreferenceProjection([feedback(1, 'helpful')])
    const firstView = first.listPendingPreferenceProjections()[0]!
    const secondView = second.listPendingPreferenceProjections()[0]!
    expect(firstView.batchKey).toBe(completed.batchKey)
    expect(secondView.batchKey).toBe(completed.batchKey)

    first.completePreferenceProjection(firstView)
    expect(() => second.completePreferenceProjection(secondView)).not.toThrow()

    const peerCompleted = first.enqueuePreferenceProjection([feedback(2, 'wrong-format')])
    const failedPeerView = second.listPendingPreferenceProjections()[0]!
    first.completePreferenceProjection(peerCompleted)
    expect(() => second.deferPreferenceProjection({
      batchKey: failedPeerView.batchKey,
      payloadDigest: failedPeerView.payloadDigest,
      now: 100,
      retryAt: 200,
      failureCode: 'peer-append-failed',
    })).not.toThrow()
    expect(first.listPendingPreferenceProjections()).toEqual([])
    second.close()
    first.close()
  })
})
