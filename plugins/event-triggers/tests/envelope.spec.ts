import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { canonicalExternalEventEnvelope, externalEventDigest, type ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import { EventTriggerStore } from '../src/store.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function provenance(eventId: string, revision: string): Readonly<{ canonical: string; digest: string }> {
  const envelope: ExternalEventEnvelope = {
    protocol: 'dsh-external-event/v1',
    source: { id: 'event-triggers:file', kind: 'file', version: '0.1.24', configDigest: 'a'.repeat(64) },
    event: { id: eventId, occurredAt: 1_000, receivedAt: 1_000 },
    observation: { digest: 'b'.repeat(64), revision, timeBasis: 'observed' },
    trust: { method: 'local-observation', content: 'untrusted' },
    target: { automationId: 'task' },
    deduplicationKey: `event-triggers:file:${eventId}`,
  }
  return { canonical: canonicalExternalEventEnvelope(envelope), digest: externalEventDigest(envelope) }
}

describe('event provenance outbox', () => {
  test('writes the event-id-bound envelope in the same durable outbox row and validates it after reopen', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-envelope-'))
    roots.push(root)
    const path = join(root, 'events.sqlite')
    const store = new EventTriggerStore({ path, now: () => 1_000 })
    expect(store.observe({
      triggerId: 'file', fingerprint: 'first', truthy: true, occurredAt: 1_000,
      fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10, envelope: provenance,
    })).toEqual([])
    const [created] = store.observe({
      triggerId: 'file', fingerprint: 'second', truthy: true, occurredAt: 1_000,
      fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10, envelope: provenance,
    })
    expect(created?.envelope).toEqual(provenance(created!.eventId, 'edge:1'))
    store.close()

    const reopened = new EventTriggerStore({ path, now: () => 1_000 })
    expect(reopened.pending()[0]?.envelope).toEqual(created?.envelope)
    reopened.close()

    const raw = new DatabaseSync(path)
    raw.prepare("UPDATE event_outbox SET envelope_digest = '0' || substr(envelope_digest, 2) WHERE id = ?").run(created!.id)
    raw.close()
    await chmod(path, 0o600)
    const corrupted = new EventTriggerStore({ path, now: () => 1_000 })
    expect(() => corrupted.pending()).toThrow(/provenance/i)
    corrupted.close()
  })

  test('rejects a callback envelope that does not bind the generated outbox row', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-envelope-binding-'))
    roots.push(root)
    const store = new EventTriggerStore({ path: join(root, 'events.sqlite'), now: () => 1_000 })
    expect(store.observe({
      triggerId: 'other', fingerprint: 'first', truthy: true, occurredAt: 1_000,
      fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10,
    })).toEqual([])
    expect(() => store.observe({
      triggerId: 'other', fingerprint: 'second', truthy: true, occurredAt: 1_000,
      fireWhen: 'changed', debounceMs: 0, cooldownMs: 0, maxFires: 10, envelope: provenance,
    })).toThrow(/does not bind/i)
    expect(store.pending()).toEqual([])
    store.close()
  })
})
