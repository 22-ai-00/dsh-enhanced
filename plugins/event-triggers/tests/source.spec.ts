import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, test } from 'vitest'
import { EventTriggersError, EventTriggersService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class Policy extends Service {
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: 'allow' as const, reasonCode: 'allow' } }
}

class Automations extends Service {
  fail = true
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal() { if (this.fail) throw new Error('downstream unavailable') }
}

class Credentials extends Service {
  constructor(ctx: Context) { super(ctx, 'credentialsKeychain') }
  async withSecret<T>(_ctx: Context, _request: unknown, callback: (value: string, signal: AbortSignal) => Promise<T>) {
    return callback('secret', new AbortController().signal)
  }
}

async function service(databasePath: string, automationId = 'task') {
  const ctx = new Context()
  new Policy(ctx); new Automations(ctx); new Credentials(ctx)
  const instance = new EventTriggersService(ctx, {
    databasePath, pollerEnabled: false,
    triggers: [{ id: 'hook', kind: 'webhook', automationId, credentialHandle: 'secret', maxSkewMs: 60_000 }],
  }, { now: () => 10_000 })
  return { ctx, instance }
}

async function ingest(instance: EventTriggersService, nonce: string, timestamp = '10000') {
  const body = Buffer.from('{}')
  const signature = `sha256=${createHmac('sha256', 'secret').update(`${timestamp}\n${nonce}\n`).update(body).digest('hex')}`
  return instance.ingestWebhook('hook', { timestamp, nonce, signature, body })
}

describe('event source reader', () => {
  test('uses durable monotonic production cursors independent of downstream delivery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-source-'))
    roots.push(root)
    const databasePath = join(root, 'events.sqlite')
    const first = await service(databasePath)
    const snapshot = first.instance.sourceSnapshot('hook')
    await ingest(first.instance, 'one')
    expect(first.instance.sourceSnapshot('hook').highWaterSequence).toBe(1)
    const inspected = new DatabaseSync(databasePath)
    expect(inspected.prepare('SELECT trigger_id, sequence, envelope_canonical FROM event_outbox').all())
      .toHaveLength(1)
    inspected.close()
    const event = first.instance.firstEventAfter(snapshot, snapshot.highWaterSequence, 10_000)
    expect(event).toMatchObject({ sequence: 1, envelope: { event: { id: expect.any(String), receivedAt: 10_000 } } })
    expect(() => first.instance.firstEventAfter(snapshot, snapshot.highWaterSequence - 1, 10_000))
      .toThrowError(expect.objectContaining<Partial<EventTriggersError>>({ code: 'source-changed' }))
    await first.ctx.fiber.restart()

    const raw = new DatabaseSync(databasePath)
    raw.exec('DELETE FROM event_outbox; VACUUM')
    raw.close()

    const restarted = await service(databasePath)
    const later = restarted.instance.sourceSnapshot('hook')
    expect(later.highWaterSequence).toBe(1)
    await ingest(restarted.instance, 'two')
    expect(restarted.instance.firstEventAfter(later, later.highWaterSequence, 10_000)?.sequence).toBe(2)
    await restarted.ctx.fiber.restart()
  })

  test('rejects a snapshot after its trigger target changes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-source-retarget-'))
    roots.push(root)
    const databasePath = join(root, 'events.sqlite')
    const initial = await service(databasePath)
    const snapshot = initial.instance.sourceSnapshot('hook')
    await initial.ctx.fiber.restart()
    const retargeted = await service(databasePath, 'other-task')
    expect(() => retargeted.instance.firstEventAfter(snapshot, snapshot.highWaterSequence, 10_000))
      .toThrowError(expect.objectContaining<Partial<EventTriggersError>>({ code: 'source-changed' }))
    await retargeted.ctx.fiber.restart()
  })

  test('orders equal and out-of-order occurrence timestamps by durable sequence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-source-order-'))
    roots.push(root)
    const fixture = await service(join(root, 'events.sqlite'))
    const snapshot = fixture.instance.sourceSnapshot('hook')
    await ingest(fixture.instance, 'same-time', '10000')
    await ingest(fixture.instance, 'older-time', '9000')
    const first = fixture.instance.firstEventAfter(snapshot, snapshot.highWaterSequence, 10_000)!
    const second = fixture.instance.firstEventAfter(snapshot, first.sequence, 10_000)!
    expect([first.sequence, second.sequence]).toEqual([1, 2])
    expect([first.envelope.event.occurredAt, second.envelope.event.occurredAt]).toEqual([10_000, 9_000])
    await fixture.ctx.fiber.restart()
  })

  test('isolates throwing listeners and supports reentrant release', async () => {
    const root = await mkdtemp(join(tmpdir(), 'event-source-subscribe-'))
    roots.push(root)
    const fixture = await service(join(root, 'events.sqlite'))
    let calls = 0
    let release = () => {}
    release = fixture.instance.subscribeSourceChanges(() => {
      calls += 1
      release()
      void fixture.instance.flushPending()
    })
    fixture.instance.subscribeSourceChanges(() => { throw new Error('listener failure') })
    await fixture.instance.flushPending()
    await fixture.instance.flushPending()
    expect(calls).toBe(1)
    await fixture.ctx.fiber.restart()
  })
})
