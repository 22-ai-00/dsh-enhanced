import { Context } from '@deepseek-ai/cordis'
import { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test } from 'vitest'
// The real Lark adapter (built lib), driven by a fake transport: no Bot, no network.
import { LarkDeliveryAdapter } from '../../lark-channel/lib/adapter.js'
import type { DeliveryStore } from '../../assistant-delivery/lib/store.js'
import { AssistantWorkItemsService, type Config } from '../src/index.ts'

// WP20 slice 2: the inbound adapter path into the intake ledger, end to end
// through real Delivery and real WorkItems in observe mode.
const roots: string[] = [], contexts: Context[] = []
const owner = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
const ownerPrincipalId = 'lark/primary-bot/tenant-a/ou_owner'

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

interface Message {
  messageId: string; chatId: string; chatType: 'p2p' | 'group'; senderId: string; content: string; rawContentType: string
  resources: never[]; mentionAll: boolean; mentionedBot: boolean; createTime: number; replyToMessageId?: string
}

class FakeTransport {
  handlers: { message(value: Message): Promise<void> } | undefined
  // A provider redelivery repeats the same event, timestamp included.
  readonly createTime = Date.now()
  async connect() {}
  async disconnect() {}
  async send() { return { messageId: 'om_sent' } }
  async addReaction() { return 'reaction-1' }
  subscribe(handlers: { message(value: Message): Promise<void> }) { this.handlers = handlers; return () => { this.handlers = undefined } }
  async emit(overrides: Partial<Message>) {
    await this.handlers!.message({ messageId: 'om_1', chatId: 'oc_dm', chatType: 'p2p', senderId: owner.user, content: 'please check the build',
      rawContentType: 'text', resources: [], mentionAll: false, mentionedBot: false, createTime: this.createTime, ...overrides })
  }
}

function query(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try { return db.prepare(sql).all() as Record<string, unknown>[] } finally { db.close() }
}

async function fixture(intakeLedger: Config['intakeLedger'] | null = { enabled: true }) {
  const root = await mkdtemp(join(tmpdir(), 'work-items-intake-adapter-')); roots.push(root)
  const ctx = new Context(); contexts.push(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: ownerPrincipalId }, actions: ['ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
  ] }).await()
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false }).await()
  const store = (ctx.assistantDelivery as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const pair = store.issuePairing(owner, { ttlMs: 60000, maxAttempts: 3 }); store.confirmPairing({ challengeId: pair.challenge.id, principal: owner, code: pair.code })
  const transport = new FakeTransport()
  const adapter = new LarkDeliveryAdapter({ account: owner.account, tenant: owner.tenant, requireMentionInGroups: true,
    maxTextBytes: 65_536, staleAfterMs: 60_000 }, transport as never)
  await ctx.assistantDelivery.registerAdapter(adapter)
  const databasePath = join(root, 'items.sqlite')
  const config: Config = { enabled: true, mode: 'observe', databasePath, workRoot: join(root, 'work'), ...(intakeLedger === null ? {} : { intakeLedger }) }
  let fork = ctx.plugin(AssistantWorkItemsService, config); await fork.await()
  const restart = async () => { await fork.dispose(); fork = ctx.plugin(AssistantWorkItemsService, config); await fork.await() }
  const ledger = () => query(databasePath, 'SELECT source, source_event_id, decision, reason, strength, strength_reason, signals, content_digest FROM work_item_intake ORDER BY recorded_at, source_event_id')
  const sideEffects = () => ({
    items: query(databasePath, 'SELECT count(*) AS n FROM work_item')[0]!['n'],
    dispatches: query(databasePath, 'SELECT count(*) AS n FROM work_item_dispatch')[0]!['n'],
    outbox: query(join(root, 'delivery.sqlite'), 'SELECT count(*) AS n FROM outbox_messages')[0]!['n'],
  })
  return { ctx, root, databasePath, transport, ledger, sideEffects, restart, inbox: () => query(join(root, 'delivery.sqlite'), 'SELECT event_id FROM inbox_messages ORDER BY event_id') }
}

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

describe('intake ledger through the inbound adapter path', () => {
  test('stores, deduplicates, filters and replays Lark messages without admitting work', async () => {
    const f = await fixture()
    await f.transport.emit({})                                                            // stored: allowlisted DM
    await f.transport.emit({})                                                            // replay: Lark redelivery of om_1
    await f.transport.emit({ messageId: 'om_2' })                                         // duplicate: same digest, new event
    await f.transport.emit({ messageId: 'om_3', chatId: 'oc_group', chatType: 'group', content: 'lunch?' }) // filtered: unaddressed group
    await f.transport.emit({ messageId: 'om_4', senderId: 'ou_stranger', content: 'hi bot' })              // filtered: not allowlisted
    // A non-allowlisted reply is never a thread follow-up, whatever it replies to.
    await f.transport.emit({ messageId: 'om_5', senderId: 'ou_stranger', content: 'follow', replyToMessageId: 'om_sent' })

    const rows = f.ledger()
    expect(rows.map(row => [row['source_event_id'], row['decision'], row['reason'], row['strength']])).toEqual([
      ['primary-bot/om_1', 'stored', 'strength-explicit', 'explicit'],
      ['primary-bot/om_2', 'duplicate', 'duplicate-content', 'explicit'],
      ['primary-bot/om_3', 'filtered', 'unaddressed-group-disabled', 'inferred'],
      ['primary-bot/om_4', 'filtered', expect.any(String), 'ignore'],
      ['primary-bot/om_5', 'filtered', expect.any(String), 'ignore'],
    ])
    expect(rows.every(row => row['source'] === 'lark-channel')).toBe(true)
    expect(rows[0]!['content_digest']).toBe(sha256('please check the build'))
    expect(JSON.parse(String(rows[4]!['signals']))).toMatchObject({ senderAllowlisted: false, threadFollowUp: false })
    expect(JSON.parse(String(rows[2]!['signals']))).toMatchObject({ senderAllowlisted: true, addressed: false, groupMessage: true })

    // Observation never changes the adapter's own acceptance or gating.
    expect(f.inbox().map(row => row['event_id'])).toEqual(['om_1', 'om_2', 'om_4', 'om_5'])
    expect(f.sideEffects()).toEqual({ items: 0, dispatches: 0, outbox: 0 })

    // A replay after a WorkItems restart still writes no second row.
    await f.restart()
    await f.transport.emit({})
    await f.transport.emit({ messageId: 'om_6', content: 'a new request' })
    expect(f.ledger().map(row => row['source_event_id'])).toEqual(
      ['primary-bot/om_1', 'primary-bot/om_2', 'primary-bot/om_3', 'primary-bot/om_4', 'primary-bot/om_5', 'primary-bot/om_6'])
    expect(f.sideEffects()).toEqual({ items: 0, dispatches: 0, outbox: 0 })

    // Metadata only: no message body reaches the WorkItems database.
    for (const suffix of ['', '-wal']) {
      let bytes: Buffer
      try { bytes = readFileSync(`${f.databasePath}${suffix}`) } catch { continue }
      for (const body of ['please check the build', 'lunch?', 'hi bot', 'a new request']) expect(bytes.includes(Buffer.from(body))).toBe(false)
    }
  })

  test('honours the per-source group opt-in', async () => {
    const f = await fixture({ enabled: true, sources: { 'lark-channel': { unaddressedGroupMessages: true } } })
    await f.transport.emit({ messageId: 'om_g', chatId: 'oc_group', chatType: 'group', content: 'lunch?' })
    expect(f.ledger()).toEqual([expect.objectContaining({ decision: 'stored', strength: 'inferred' })])
    expect(f.inbox()).toEqual([])
  })

  test('the disabled default registers no observer and writes no ledger row', async () => {
    const f = await fixture(null)
    await f.transport.emit({})
    expect(f.ledger()).toEqual([])
    expect(f.inbox().map(row => row['event_id'])).toEqual(['om_1'])
    expect(f.ctx.assistantWorkItems.ownsInboundIntakeObserver({ protocol: 1, observe: () => {} })).toBe(false)
  })

  test('stops observing once WorkItems is disposed', async () => {
    const f = await fixture()
    await f.transport.emit({})
    expect(f.ledger()).toHaveLength(1)
    const service = f.ctx.assistantWorkItems
    service.close()
    await f.transport.emit({ messageId: 'om_after_close', content: 'after close' })
    expect(f.inbox().map(row => row['event_id'])).toEqual(['om_1', 'om_after_close'])
    expect(query(f.databasePath, 'SELECT count(*) AS n FROM work_item_intake')[0]!['n']).toBe(1)
  })
})
