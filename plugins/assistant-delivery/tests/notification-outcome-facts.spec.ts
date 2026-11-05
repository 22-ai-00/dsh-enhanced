import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService, NOTIFICATION_OUTCOME_FACTS_PROTOCOL } from '../src/index.ts'
import type { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => { await ctx.fiber.restart(); contexts.delete(ctx) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-outcome-facts-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
        actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
      { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
      { id: 'owner-ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
        actions: ['ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
      { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: 'proactive-engine', workspace: '/work/alpha',
        principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
      context: { initiators: ['background'] } },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false, retryBaseMs: 1, retryMaxMs: 1,
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const challenge = service.issuePairing('test', principal)
  service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
  const binding = store.createBinding({ conversation, principal, workspace: '/work/alpha',
    agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm' })
  let sent = 0
  const send = vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: `provider-${++sent}` }))
  await service.registerAdapter({ channel: 'lark', account: 'bot-1',
    capabilities: { reconcileUnknownSend: false, receipts: ['delivered', 'read'], formats: ['plain', 'markdown'] }, start: async () => {}, send })
  const background = (idempotencyKey: string, text: string) => service.enqueueBackground({
    sourceId: 'proactive-engine', workspace: '/work/alpha', bindingId: binding.id, idempotencyKey, text, format: 'plain' })
  const drain = async () => {
    for (let calls = -1; calls !== send.mock.calls.length;) { calls = send.mock.calls.length; await service.tick(); await service.whenIdle() }
  }
  const reply = (eventId: string, providerMessageId: string) => service.acceptInbound({
    channel: 'lark', account: 'bot-1', eventId, occurredAt: Date.now(), principal, conversation, kind: 'text', text: 'private reply text',
    metadata: { replyToProviderMessageId: providerMessageId } } as Parameters<AssistantDeliveryService['acceptInbound']>[0])
  const database = (store as unknown as { database: DatabaseSync }).database
  return { service, store, binding, background, drain, reply, database }
}

describe('notification outcome facts (WP22 read adapter)', () => {
  test('pages audit rows with transport, receipts, reply reaction and owner judgement; never text', async () => {
    const f = await fixture()
    const first = f.background('n-1', 'Build finished.')
    const second = f.background('n-2', 'Deploy finished.')
    const empty = f.service.inspectNotificationOutcomeFacts({ afterSequence: 99 })
    expect(empty).toEqual({ protocol: NOTIFICATION_OUTCOME_FACTS_PROTOCOL, facts: [], hasMore: false, nextAfterSequence: null })
    const before = f.service.inspectNotificationOutcomeFacts({})
    expect(before.facts.map(fact => [fact.outboxId, fact.transport.status, fact.transport.acceptedAt])).toEqual([
      [first.id, 'pending', undefined], [second.id, 'pending', undefined]])

    await f.drain()
    f.store.recordReceipt({ channel: 'lark', account: 'bot-1', providerMessageId: 'provider-1', status: 'delivered', occurredAt: 5_000 })
    await f.reply('reply-1', 'provider-1')
    await f.reply('reply-2', 'provider-1')
    f.database.prepare(`INSERT INTO delivery_owner_objective_commands(inbox_id, source_outbox_id, principal_record_id, principal_version,
      version, objective_status, command_json, result_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run('inbox-x', second.id, 'principal', 1, 2, 'not-achieved', '{}', '{}')
    f.database.prepare(`INSERT INTO delivery_owner_objective_commands(inbox_id, source_outbox_id, principal_record_id, principal_version,
      version, objective_status, command_json, result_json) VALUES (?,?,?,?,?,?,?,?)`)
      .run('inbox-y', second.id, 'principal', 1, 3, 'achieved', '{}', '{"error":"stale"}')

    const page = f.service.inspectNotificationOutcomeFacts({ limit: 1 })
    expect(page).toMatchObject({ hasMore: true, nextAfterSequence: 1 })
    const [one] = page.facts
    expect(one).toMatchObject({
      auditSequence: 1, outboxId: first.id, bindingId: f.binding.id, scope: { workspace: '/work/alpha', preset: 'primary' },
      lane: 'background', sourceId: 'proactive-engine', purpose: 'result', verdict: 'would-accept',
      transport: { status: 'delivered', deliveredAt: 5_000 }, reaction: { count: 2 },
    })
    expect(one!.transport.acceptedAt).toEqual(expect.any(Number))
    expect(one).not.toHaveProperty('judgement')
    expect(JSON.stringify(page)).not.toMatch(/Build finished|private reply text/)

    const rest = f.service.inspectNotificationOutcomeFacts({ afterSequence: 1, limit: 1 })
    expect(rest).toMatchObject({ hasMore: false, nextAfterSequence: 2 })
    expect(rest.facts[0]).toMatchObject({ outboxId: second.id, judgement: { source: 'owner-objective', version: 2, objectiveStatus: 'not-achieved' } })
    expect(rest.facts[0]).not.toHaveProperty('reaction')

    expect(f.service.inspectNotificationOutcomeFacts({ outboxIds: [second.id, 'missing', first.id] }).facts.map(fact => fact.outboxId))
      .toEqual([second.id, first.id])
    expect(Object.isFrozen(one)).toBe(true)
  })

  test('rejects malformed input', async () => {
    const f = await fixture()
    for (const input of [
      { limit: 0 }, { limit: 501 }, { afterSequence: -1 }, { outboxIds: [''] },
      { outboxIds: Array.from({ length: 501 }, (_, index) => `id-${index}`) }, { outboxIds: ['a'], limit: 1 },
    ]) expect(() => f.service.inspectNotificationOutcomeFacts(input), JSON.stringify(input).slice(0, 80)).toThrow()
  })
})
