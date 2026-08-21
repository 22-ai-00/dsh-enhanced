import { createHmac } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { EventTriggersError, EventTriggersService } from '../src/service.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class FakePolicy extends Service {
  allow = true
  constructor(ctx: Context) { super(ctx, 'assistantPolicy') }
  authorize() { return { effect: this.allow ? 'allow' : 'deny', reasonCode: this.allow ? 'rule-allow' : 'default-deny' } }
}

class FakeAutomations extends Service {
  fail = false
  readonly events: Array<Record<string, unknown>> = []
  constructor(ctx: Context) { super(ctx, 'assistantAutomations') }
  ingestExternal(input: Record<string, unknown>) {
    if (this.fail) throw new Error('downstream unavailable')
    this.events.push(input)
    return input
  }
}

class FakeCredentials extends Service {
  constructor(ctx: Context, private readonly secret: string) { super(ctx, 'credentialsKeychain') }
  async withSecret<T>(_caller: Context, _request: unknown, callback: (secret: string, signal: AbortSignal) => Promise<T>) {
    return callback(this.secret, new AbortController().signal)
  }
}

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'event-triggers-service-'))
  roots.push(root)
  const watched = join(root, 'watched.txt')
  await writeFile(watched, 'v1')
  const ctx = new Context()
  const policy = new FakePolicy(ctx)
  const automations = new FakeAutomations(ctx)
  new FakeCredentials(ctx, 'super-secret')
  const service = new EventTriggersService(ctx, {
    databasePath: join(root, 'events.sqlite'), allowedFileRoots: [root], allowedHttpHosts: [], pollerEnabled: false,
    triggers: [
      { id: 'file', kind: 'file', automationId: 'file-task', path: watched, fireWhen: 'changed',
        debounceMs: 0, cooldownMs: 0, maxFires: 10 },
      { id: 'hook', kind: 'webhook', automationId: 'hook-task', credentialHandle: 'hook-secret',
        maxSkewMs: 60_000, cooldownMs: 0, maxFires: 10 },
    ],
  }, { now: () => 10_000 })
  return { root, watched, ctx, policy, automations, service }
}

describe('event triggers service', () => {
  test('baselines a file, persists its changed edge, and replays downstream failure', async () => {
    const fixture = await harness()
    await fixture.service.pollOnce()
    expect(fixture.automations.events).toEqual([])
    await writeFile(fixture.watched, 'v2')
    fixture.automations.fail = true
    await expect(fixture.service.pollOnce()).rejects.toThrow(/downstream/i)
    expect(fixture.service.health()).toMatchObject({ pendingEvents: 1 })
    fixture.automations.fail = false
    await fixture.service.flushPending()
    expect(fixture.automations.events).toHaveLength(1)
    await fixture.service.flushPending()
    expect(fixture.automations.events).toHaveLength(1)
    await fixture.ctx.fiber.restart()
  })

  test('verifies HMAC, timestamp and nonce before persisting a webhook event', async () => {
    const fixture = await harness()
    const body = Buffer.from('{"external":"data"}')
    const timestamp = '10000'
    const nonce = 'nonce-1'
    const signature = `sha256=${createHmac('sha256', 'super-secret').update(`${timestamp}\n${nonce}\n`).update(body).digest('hex')}`
    const accepted = await fixture.service.ingestWebhook('hook', { timestamp, nonce, signature, body })
    expect(accepted).toMatchObject({ accepted: true })
    expect(fixture.automations.events.at(-1)).toMatchObject({ sourceId: 'event-triggers:hook', automationId: 'hook-task' })
    await expect(fixture.service.ingestWebhook('hook', { timestamp, nonce, signature, body }))
      .rejects.toThrowError(expect.objectContaining<Partial<EventTriggersError>>({ code: 'replay' }))
    await expect(fixture.service.ingestWebhook('hook', {
      timestamp: '1', nonce: 'nonce-2', signature: 'sha256=' + '0'.repeat(64), body,
    })).rejects.toThrow(/timestamp|signature/i)
    await fixture.ctx.fiber.restart()
  })

  test('fails closed on Policy denial and after disposal', async () => {
    const fixture = await harness()
    fixture.policy.allow = false
    await expect(fixture.service.pollOnce()).rejects.toThrowError(
      expect.objectContaining<Partial<EventTriggersError>>({ code: 'policy-denied' }),
    )
    await fixture.ctx.fiber.restart()
    await expect(fixture.service.pollOnce()).rejects.toThrowError(
      expect.objectContaining<Partial<EventTriggersError>>({ code: 'disposed' }),
    )
  })
})
