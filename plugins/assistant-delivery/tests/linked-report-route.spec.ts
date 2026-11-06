import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryError, AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type { ExternalPrincipalKey } from '../src/types.ts'
import { workItemReplyDigest, type WorkItemReplyConsumerRegistration } from '../src/work-item-replies.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const owner = { channel: 'lark', account: 'bot', tenant: 'tenant', user: 'owner' }
const ownerConversation = { channel: 'lark', account: 'bot', tenant: 'tenant', kind: 'dm' as const, chat: 'owner-chat' }
const alias = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', user: 'alias' }
const aliasConversation = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', kind: 'dm' as const, chat: 'alias-chat' }
const denied = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', user: 'denied' }
const deniedConversation = { channel: 'telegram', account: 'bot-tg', tenant: 'personal', kind: 'dm' as const, chat: 'denied-chat' }
const workspace = '/work/owner'
const sourceId = 'work-items/v1'
const id = (key: ExternalPrincipalKey) => `${key.channel}/${key.account}/${key.tenant}/${key.user}`

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => { await ctx.fiber.restart(); contexts.delete(ctx) }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function start(root: string, options: Readonly<{ orderAcrossLanes?: boolean }> = {}) {
  const ctx = new Context()
  contexts.add(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [
    { id: 'issue', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
      actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
    ...[owner, alias, denied].map(key => ({ id: `confirm-${key.user}`, effect: 'allow' as const, subject: { kind: 'external' as const, id: id(key) },
      actions: ['pair.confirm'], resource: { kind: 'message' as const, id: 'pairing' }, context: { initiators: ['external' as const] } })),
    // Existing Policy decides who may receive this source's sends; `denied` has no rule.
    ...[owner, alias].map(key => ({ id: `send-${key.user}`, effect: 'allow' as const, subject: { kind: 'background' as const, id: sourceId,
      workspace, principal: id(key) }, actions: ['send'], resource: { kind: 'message' as const, id: '*' },
    context: { initiators: ['background' as const] } })),
  ] })
  await ctx.plugin(AssistantDeliveryService, { databasePath: join(root, 'delivery.sqlite'),
    spoolPath: join(root, 'spool'), schedulerEnabled: false, retryBaseMs: 1, retryMaxMs: 1,
    ...(options.orderAcrossLanes === undefined ? {} : { ownerReportRouting: { orderAcrossLanes: options.orderAcrossLanes } }) })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  const sends = { lark: vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'lark-msg' })),
    telegram: vi.fn(async () => ({ outcome: 'accepted' as const, providerMessageId: 'tg-msg' })) }
  for (const [channel, account] of [['lark', 'bot'], ['telegram', 'bot-tg']] as const) {
    await service.registerAdapter({ channel, account, capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain', 'markdown'] },
      start: async () => {}, send: sends[channel] })
  }
  return { ctx, service, store, sends }
}

async function fixture(options: Readonly<{ orderAcrossLanes?: boolean }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'delivery-linked-report-'))
  roots.push(root)
  const live = await start(root, options)
  const pair = (key: ExternalPrincipalKey) => {
    const challenge = live.service.issuePairing('test', key)
    return live.service.confirmPairing({ challengeId: challenge.challenge.id, principal: key, code: challenge.code })
  }
  pair(owner)
  pair(alias)
  pair(denied)
  const bind = (conversation: typeof ownerConversation | typeof aliasConversation, principal: ExternalPrincipalKey, sessionId: string) =>
    live.store.createBinding({ conversation, principal, workspace, agentPreset: 'primary', sessionId, policyRef: 'owner-dm' })
  const origin = bind(ownerConversation, owner, 'owner-session')
  const aliasBinding = bind(aliasConversation, alias, 'alias-session')
  bind(deniedConversation, denied, 'denied-session')
  const link = (key: ExternalPrincipalKey = alias) => live.store.linkPrincipal({ owner, linked: key, expectedLinkedVersion: live.store.getPrincipal(key)!.version })
  // Simulate an unavailable origin channel without touching the owner principal.
  const revokeBindingRow = (bindingId: string) => {
    const db = new DatabaseSync(join(root, 'delivery.sqlite'))
    try { db.prepare(`UPDATE conversation_bindings SET status = 'revoked', version = version + 1 WHERE id = ?`).run(bindingId) } finally { db.close() }
  }
  const dropOrigin = () => revokeBindingRow(origin.id)
  return { ...live, root, pair, origin, aliasBinding, link, dropOrigin, revokeBindingRow }
}

type Fixture = Awaited<ReturnType<typeof fixture>>

const report = (f: Fixture, linkedFallback: readonly string[], key = 'work-item-report:item-1:1') => ({
  sourceId, workspace, originBindingId: f.origin.id, idempotencyKey: key, text: 'Work item done', format: 'markdown' as const,
  itemId: 'item-1', reportRevision: 1, linkedFallback,
})

async function drain(service: AssistantDeliveryService): Promise<void> {
  await service.tick()
  await service.whenIdle()
}

describe('linked work-item report routing', () => {
  test('without a fallback list an unavailable origin still fails closed and queues nothing', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    expect(() => f.service.routeWorkItemReport(report(f, []))).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
  })

  test('the origin wins while it is available and nothing is queued by the route', async () => {
    const f = await fixture()
    f.link()
    expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toEqual({ route: 'origin' })
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    expect(f.store.listOutbox({ bindingId: f.origin.id })).toHaveLength(0)
  })

  test('an unavailable origin routes once to the first eligible owner-listed alias, inspect-only', async () => {
    const f = await fixture()
    f.link(denied)
    f.link()
    f.dropOrigin()
    // `denied` is linked but Policy grants it no send; the route skips it rather than relaxing Policy.
    const routed = f.service.routeWorkItemReport(report(f, [id(denied), id(alias)]))
    expect(routed.route).toBe('linked')
    const outbox = (routed as { outbox: { id: string } }).outbox
    const queued = f.store.getOutbox(outbox.id)!
    const ownerRow = f.store.getPrincipal(owner)!, aliasRow = f.store.getPrincipal(alias)!
    expect(queued.intent).toMatchObject({ bindingId: f.aliasBinding.id, metadata: {
      'dsh.linked-report': 'v1', 'dsh.linked-report.originBindingId': f.origin.id,
      'dsh.linked-report.ownerRecordId': ownerRow.id, 'dsh.linked-report.ownerVersion': String(ownerRow.version),
      'dsh.linked-report.aliasRecordId': aliasRow.id, 'dsh.linked-report.aliasVersion': String(aliasRow.version),
      'dsh.linked-report.bindingVersion': String(f.aliasBinding.version) } })
    await drain(f.service)
    expect(f.sends.telegram).toHaveBeenCalledOnce()
    expect(f.sends.lark).not.toHaveBeenCalled()
    expect(f.store.getOutbox(outbox.id)).toMatchObject({ status: 'accepted' })
    // Plain background lane: a reply on the fallback channel has no report row to continue.
    expect(f.store.workItemReplies.replyReport('telegram', 'bot-tg', 'tg-msg')).toBeUndefined()
  })

  test('a fallback alias that is not linked to the current owner is never used', async () => {
    const f = await fixture()
    f.dropOrigin()
    expect(() => f.service.routeWorkItemReport(report(f, [id(alias)]))).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
  })

  test('the general seams cannot forge the reserved linked-report metadata', async () => {
    const f = await fixture()
    f.link()
    expect(() => f.service.enqueueBackground({ sourceId, workspace, bindingId: f.aliasBinding.id, idempotencyKey: 'forged',
      text: 'forged', metadata: { 'dsh.linked-report': 'v1' } })).toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
  })

  test('unlinking after queueing drops the send', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    const routed = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    const aliasRow = f.store.getPrincipal(alias)!
    f.store.revokePrincipal(aliasRow.id, aliasRow.version)
    await drain(f.service)
    expect(f.sends.telegram).not.toHaveBeenCalled()
    // revokePrincipal also revokes the alias binding, so the generic binding check fires first.
    expect(f.store.getOutbox(routed.outbox.id)).toMatchObject({ status: 'dead', failureCode: 'binding-revoked' })
  })

  test('an owner revoke and relink never revives a report queued under the old link version', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    const routed = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    const before = f.store.getPrincipal(alias)!
    const ownerRow = f.store.getPrincipal(owner)!
    f.store.revokePrincipal(ownerRow.id, ownerRow.version)
    expect(f.store.getPrincipal(alias)!.linkedToId).toBeUndefined()
    f.pair(owner)
    const relinked = f.link()
    expect(relinked.linkedToId).toBe(f.store.getPrincipal(owner)!.id)
    expect(relinked.version).toBeGreaterThan(before.version)
    await drain(f.service)
    expect(f.sends.telegram).not.toHaveBeenCalled()
    expect(f.store.getOutbox(routed.outbox.id)).toMatchObject({ status: 'dead', failureCode: 'linked-report-route-revoked' })
    // A replay of the same report keeps its first destination instead of sending again.
    expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toMatchObject({ route: 'linked', outbox: { id: routed.outbox.id } })
  })

  test('a route survives a Host restart idempotently and is sent exactly once', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    const first = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toMatchObject({ outbox: { id: first.outbox.id } })
    await f.ctx.fiber.restart()
    contexts.delete(f.ctx)
    const restarted = await start(f.root)
    const replay = restarted.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    expect(replay.outbox.id).toBe(first.outbox.id)
    await drain(restarted.service)
    await drain(restarted.service)
    expect(restarted.sends.telegram).toHaveBeenCalledOnce()
    expect(restarted.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(1)
    // The same key reused for a different report is refused, not rerouted.
    expect(() => restarted.service.routeWorkItemReport({ ...report(f, [id(alias)]), itemId: 'item-2' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
  })
  test('a /new rotation of the origin keeps the origin path and never reroutes to the alias', async () => {
    const f = await fixture()
    f.link()
    const successor = f.store.rotateBinding({ bindingId: f.origin.id, expectedVersion: f.origin.version, sessionId: 'owner-session-2' })
    expect(f.store.getBinding(f.origin.id)!.status).toBe('revoked')
    expect(successor).toMatchObject({ status: 'active', conversation: ownerConversation, principal: owner })
    expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toEqual({ route: 'origin' })
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    // Only when the successor is gone too is the origin unavailable.
    f.revokeBindingRow(successor.id)
    expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toMatchObject({ route: 'linked' })
  })

  test('an alias binding rotated after queueing drops the send before any provider call', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    const routed = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    f.store.rotateBinding({ bindingId: f.aliasBinding.id, expectedVersion: f.aliasBinding.version, sessionId: 'alias-session-2' })
    await drain(f.service)
    expect(f.sends.telegram).not.toHaveBeenCalled()
    // The rotated row is revoked, so the generic binding check fires before the linked-report guard.
    expect(f.store.getOutbox(routed.outbox.id)).toMatchObject({ status: 'dead', failureCode: 'binding-revoked' })
  })

  test('a Policy revocation after queueing drops the send with the route-revoked code', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    const routed = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    const evaluate = f.ctx.assistantPolicy.evaluate.bind(f.ctx.assistantPolicy)
    vi.spyOn(f.ctx.assistantPolicy, 'evaluate').mockImplementation(request =>
      request.action === 'send' && request.subject.principal === id(alias)
        ? { ...evaluate(request), effect: 'deny' } as ReturnType<typeof evaluate> : evaluate(request))
    await drain(f.service)
    expect(f.sends.telegram).not.toHaveBeenCalled()
    expect(f.store.getOutbox(routed.outbox.id)).toMatchObject({ status: 'dead', failureCode: 'linked-report-route-revoked' })
  })

  test('the typed and general seams reject the reserved linked-report prefixes', async () => {
    const f = await fixture()
    f.link()
    const typed = { sourceId, workspace, bindingId: f.aliasBinding.id, text: 'forged', itemId: 'item-1', reportRevision: 1 }
    expect(() => f.service.enqueueWorkItemReport({ ...typed, idempotencyKey: 'forged', metadata: { 'dsh.linked-report.itemId': 'item-1' } }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(() => f.service.enqueueWorkItemReport({ ...typed, idempotencyKey: 'linked-report:forged' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(() => f.service.enqueueBackground({ sourceId, workspace, bindingId: f.aliasBinding.id, idempotencyKey: 'linked-report:forged', text: 'forged' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
  })

  test('an alias with several active bindings in the origin workspace/preset is skipped as ambiguous', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    f.store.createBinding({ conversation: { ...aliasConversation, chat: 'alias-chat-2' }, principal: alias, workspace,
      agentPreset: 'primary', sessionId: 'alias-session-2', policyRef: 'owner-dm' })
    expect(() => f.service.routeWorkItemReport(report(f, [id(alias)]))).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
  })

  test.each([
    ['workspace', { workspace: '/work/other', agentPreset: 'primary' }],
    ['preset', { workspace, agentPreset: 'secondary' }],
  ])('an alias bound only in another %s is skipped', async (_label, scope) => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    f.revokeBindingRow(f.aliasBinding.id)
    const other = f.store.createBinding({ conversation: { ...aliasConversation, chat: 'alias-chat-other' }, principal: alias, ...scope,
      sessionId: 'alias-session-other', policyRef: 'owner-dm' })
    expect(() => f.service.routeWorkItemReport(report(f, [id(alias)]))).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    expect(f.store.listOutbox({ bindingId: other.id })).toHaveLength(0)
  })

  test('a fallback record writes the WP19 attention audit row with purpose result and the work item id', async () => {
    const f = await fixture()
    f.link()
    f.dropOrigin()
    // A non-canonical source id is normalized before authorization, like the send guard.
    const routed = f.service.routeWorkItemReport({ ...report(f, [id(alias)]), sourceId: ` ${sourceId} ` }) as { route: 'linked'; outbox: { id: string } }
    expect(f.store.getOutbox(routed.outbox.id)!.intent.metadata).toMatchObject({ 'dsh.linked-report.sourceId': sourceId })
    expect(f.store.attentionAudit.get(routed.outbox.id)).toMatchObject({ outboxId: routed.outbox.id, bindingId: f.aliasBinding.id,
      lane: 'background', sourceId, purpose: 'result', workItemId: 'item-1' })
    await drain(f.service)
    expect(f.sends.telegram).toHaveBeenCalledOnce()
  })

  test('WP22 outcome facts tag only a Host-routed linked report with its origin binding', async () => {
    const f = await fixture()
    f.link()
    const direct = f.service.enqueueBackground({ sourceId, workspace, bindingId: f.origin.id, idempotencyKey: 'direct-1', text: 'direct' })
    // A marker without the reserved key prefix (only reachable by tampering) is not a linked route.
    const tampered = f.service.enqueueBackground({ sourceId, workspace, bindingId: f.origin.id, idempotencyKey: 'direct-2', text: 'tampered' })
    const db = new DatabaseSync(join(f.root, 'delivery.sqlite'))
    try {
      db.prepare(`UPDATE outbox_messages SET intent_json=json_set(intent_json,'$.metadata',json_object('dsh.linked-report','v1',
        'dsh.linked-report.originBindingId','x')) WHERE id=?`).run(tampered.id)
    } finally { db.close() }
    f.dropOrigin()
    const routed = f.service.routeWorkItemReport(report(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
    await drain(f.service)
    const facts = f.service.inspectNotificationOutcomeFacts({ outboxIds: [direct.id, tampered.id, routed.outbox.id] }).facts
    expect(facts.map(fact => fact.outboxId)).toEqual([direct.id, tampered.id, routed.outbox.id])
    expect(facts[0]).not.toHaveProperty('route')
    expect(facts[1]).not.toHaveProperty('route')
    expect(facts[2]).toMatchObject({ bindingId: f.aliasBinding.id, lane: 'background', workItemId: 'item-1',
      route: { kind: 'linked', originBindingId: f.origin.id } })
    expect(Object.isFrozen(facts[2]!.route)).toBe(true)
  })

  describe("prefer: 'recent'", () => {
    // Record one inbound row as the Host would after admission (binding set, processed).
    const inbound = (f: Fixture, bindingId: string, receivedAt: number) => {
      const binding = f.store.getBinding(bindingId)!
      const db = new DatabaseSync(join(f.root, 'delivery.sqlite'))
      try {
        db.prepare(`INSERT INTO inbox_messages (id, channel, account, event_id, envelope_hash, envelope_json, status, binding_id, received_at, updated_at)
          VALUES (?, ?, ?, ?, ?, '{}', 'processed', ?, ?, ?)`).run(`in-${bindingId}-${receivedAt}`, binding.conversation.channel,
          binding.conversation.account, `evt-${bindingId}-${receivedAt}`, 'a'.repeat(64), bindingId, receivedAt, receivedAt)
      } finally { db.close() }
    }
    const recent = (f: Fixture, linkedFallback: readonly string[]) => ({ ...report(f, linkedFallback), prefer: 'recent' as const })
    const allowDeniedSend = (f: Fixture) => {
      const evaluate = f.ctx.assistantPolicy.evaluate.bind(f.ctx.assistantPolicy)
      vi.spyOn(f.ctx.assistantPolicy, 'evaluate').mockImplementation(request =>
        request.action === 'send' && request.subject.principal === id(denied)
          ? { ...evaluate(request), effect: 'allow' } as ReturnType<typeof evaluate> : evaluate(request))
    }

    test("default and explicit 'origin' keep the available origin even when the alias spoke last", async () => {
      const f = await fixture()
      f.link()
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      expect(f.service.routeWorkItemReport(report(f, [id(alias)]))).toEqual({ route: 'origin' })
      expect(f.service.routeWorkItemReport({ ...report(f, [id(alias)]), prefer: 'origin' })).toEqual({ route: 'origin' })
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    })

    test('routes to the linked alias with the newest inbound while the origin is available', async () => {
      const f = await fixture()
      f.link()
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      const routed = f.service.routeWorkItemReport(recent(f, [id(alias)])) as { route: 'linked'; outbox: { id: string } }
      expect(routed.route).toBe('linked')
      expect(f.store.getOutbox(routed.outbox.id)!.intent).toMatchObject({ bindingId: f.aliasBinding.id,
        metadata: { 'dsh.linked-report': 'v1', 'dsh.linked-report.originBindingId': f.origin.id } })
      await drain(f.service)
      expect(f.sends.telegram).toHaveBeenCalledOnce()
      expect(f.sends.lark).not.toHaveBeenCalled()
      // A replay keeps the committed destination.
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toMatchObject({ route: 'linked', outbox: { id: routed.outbox.id } })
    })

    test('the newest inbound wins over list order; ties keep the origin, then list order', async () => {
      const f = await fixture()
      f.link(denied)
      f.link()
      allowDeniedSend(f)
      const deniedBinding = f.store.listActiveBindings().find(binding => binding.principal.user === 'denied')!
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      inbound(f, deniedBinding.id, 3_000)
      const newest = f.service.routeWorkItemReport(recent(f, [id(alias), id(denied)])) as { route: 'linked'; outbox: { id: string } }
      expect(f.store.getOutbox(newest.outbox.id)!.intent.bindingId).toBe(deniedBinding.id)
      // Equal alias timestamps fall back to the owner's list order.
      inbound(f, f.aliasBinding.id, 3_000)
      const tied = f.service.routeWorkItemReport({ ...recent(f, [id(alias), id(denied)]), idempotencyKey: 'work-item-report:item-1:2', reportRevision: 2 }) as
        { route: 'linked'; outbox: { id: string } }
      expect(f.store.getOutbox(tied.outbox.id)!.intent.bindingId).toBe(f.aliasBinding.id)
      // A tie with the origin keeps the origin.
      inbound(f, f.origin.id, 3_000)
      expect(f.service.routeWorkItemReport({ ...recent(f, [id(alias), id(denied)]), idempotencyKey: 'work-item-report:item-1:3', reportRevision: 3 }))
        .toEqual({ route: 'origin' })
    })

    test('without any alias inbound the available origin is kept', async () => {
      const f = await fixture()
      f.link()
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toEqual({ route: 'origin' })
      inbound(f, f.origin.id, 1_000)
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toEqual({ route: 'origin' })
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    })

    test('a disabled or Policy-denied recent alias falls back to the origin', async () => {
      const f = await fixture()
      f.link()
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      const evaluate = f.ctx.assistantPolicy.evaluate.bind(f.ctx.assistantPolicy)
      const spy = vi.spyOn(f.ctx.assistantPolicy, 'evaluate').mockImplementation(request =>
        request.action === 'send' && request.subject.principal === id(alias)
          ? { ...evaluate(request), effect: 'deny' } as ReturnType<typeof evaluate> : evaluate(request))
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toEqual({ route: 'origin' })
      spy.mockRestore()
      f.revokeBindingRow(f.aliasBinding.id)
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toEqual({ route: 'origin' })
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    })

    test('an alias refused by Policy authorize before commit keeps the available origin', async () => {
      const f = await fixture()
      f.link()
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      const evaluate = vi.spyOn(f.ctx.assistantPolicy, 'evaluate')
      // evaluate allows the alias, but authorize (e.g. budget/rate) denies it.
      const authorize = f.ctx.assistantPolicy.authorize.bind(f.ctx.assistantPolicy)
      const authorizeSpy = vi.spyOn(f.ctx.assistantPolicy, 'authorize').mockImplementation((request, options) =>
        request.action === 'send' && request.subject.principal === id(alias)
          ? { ...f.ctx.assistantPolicy.evaluate(request), effect: 'deny', reasonCode: 'budget-exhausted' } as ReturnType<typeof authorize>
          : authorize(request, options))
      expect(f.service.routeWorkItemReport(recent(f, [id(alias)]))).toEqual({ route: 'origin' })
      expect(authorizeSpy.mock.calls.some(([request]) => request.subject.principal === id(alias))).toBe(true)
      // One Policy evaluate per eligible alias during routing (the authorize mock adds one).
      expect(evaluate.mock.calls.filter(([request]) => request.action === 'send' && request.subject.principal === id(alias))).toHaveLength(2)
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
      // With the origin unavailable the same refusal still surfaces.
      f.dropOrigin()
      expect(() => f.service.routeWorkItemReport(recent(f, [id(alias)])))
        .toThrowError(expect.objectContaining({ code: 'policy-denied' }))
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    })

    test('an unavailable origin uses the most recent eligible alias, and an unknown prefer is refused', async () => {
      const f = await fixture()
      f.link(denied)
      f.link()
      allowDeniedSend(f)
      const deniedBinding = f.store.listActiveBindings().find(binding => binding.principal.user === 'denied')!
      inbound(f, deniedBinding.id, 2_000)
      f.dropOrigin()
      const routed = f.service.routeWorkItemReport(recent(f, [id(alias), id(denied)])) as { route: 'linked'; outbox: { id: string } }
      expect(f.store.getOutbox(routed.outbox.id)!.intent.bindingId).toBe(deniedBinding.id)
      expect(() => f.service.routeWorkItemReport({ ...report(f, [id(alias)], 'other-key'), prefer: 'newest' as 'recent' }))
        .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    })
  })

  describe('ownerReportRouting.orderAcrossLanes', () => {
    const tamper = (f: Fixture, sql: string, ...params: Array<string | number>) => {
      const db = new DatabaseSync(join(f.root, 'delivery.sqlite'))
      try { db.prepare(sql).run(...params) } finally { db.close() }
    }
    const inbound = (f: Fixture, bindingId: string, receivedAt: number) => {
      const binding = f.store.getBinding(bindingId)!
      tamper(f, `INSERT INTO inbox_messages (id, channel, account, event_id, envelope_hash, envelope_json, status, binding_id, received_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '{}', 'processed', ?, ?, ?)`, `in-${bindingId}-${receivedAt}`, binding.conversation.channel,
      binding.conversation.account, `evt-${bindingId}-${receivedAt}`, 'a'.repeat(64), bindingId, receivedAt, receivedAt)
    }
    const setStatus = (f: Fixture, outboxId: string, status: string) =>
      tamper(f, `UPDATE outbox_messages SET status = ? WHERE id = ?`, status, outboxId)
    // Operator settlement goes through the public seam so the v9 receipt fence stays satisfied.
    const resolveOutbox = (f: Fixture, outboxId: string, resolution: 'cancel' | 'retry') =>
      f.store.resolveOutbox({ outboxId, expectedAttemptCount: f.store.getOutbox(outboxId)!.attemptCount,
        resolution, operatorId: 'test-operator' })
    // A recovered origin channel: the same binding row becomes active again.
    const restoreOrigin = (f: Fixture) =>
      tamper(f, `UPDATE conversation_bindings SET status = 'active', version = version + 1 WHERE id = ?`, f.origin.id)
    const revision = (f: Fixture, linkedFallback: readonly string[], reportRevision: number, extra: Readonly<{ prefer?: 'recent' }> = {}) =>
      ({ ...report(f, linkedFallback, `work-item-report:item-1:${String(reportRevision)}`), reportRevision, text: `report ${String(reportRevision)}`, ...extra })
    // The two shapes WorkItems uses on the origin: the typed report lane or a plain background notice.
    const originReport = (f: Fixture, kind: 'typed' | 'plain', reportRevision = 1) => {
      const input = { sourceId, workspace, bindingId: f.origin.id, idempotencyKey: `work-item-report:item-1:${String(reportRevision)}`,
        text: `report ${String(reportRevision)}`, format: 'markdown' as const }
      if (kind === 'plain') return f.service.enqueueBackground({ ...input, attention: { purpose: 'result', workItemId: 'item-1' } })
      // Narrow work-item report consumer: every report it is asked about is current.
      const ownerRow = f.store.getPrincipal(owner)!
      const registration: WorkItemReplyConsumerRegistration = { protocol: 1, sourceId, continuationAutomationId: 'reply-worker',
        inspectReport: request => ({ protocol: 'assistant-delivery/work-item-report/v1', itemId: request.itemId, reportRevision: request.reportRevision,
          streamId: request.itemId, reportDigest: workItemReplyDigest(['report', request.itemId, String(request.reportRevision)]), sourceId,
          scope: { workspace, preset: 'primary' }, owner: { principalRecordId: ownerRow.id, principalVersion: ownerRow.version } }),
        inspectChild: () => true, onPending: () => {}, onCancelled: () => {} }
      f.ctx.provide('assistantWorkItems' as never, { ownsWorkItemReplyRegistration: (value: unknown) => value === registration } as never)
      f.service.registerWorkItemReplyConsumer(registration)
      return f.service.enqueueWorkItemReport({ ...input, itemId: 'item-1', reportRevision })
    }
    // Origin rev1 is waiting to retry while the alias spoke last.
    const originWaiting = async (f: Fixture, kind: 'typed' | 'plain') => {
      f.link()
      const first = await originReport(f, kind)
      setStatus(f, first.id, 'retry_wait')
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      return first
    }
    // Alias rev1 is queued while the origin was down; the origin has since recovered.
    const aliasWaiting = (f: Fixture) => {
      f.link()
      f.dropOrigin()
      const first = f.service.routeWorkItemReport(revision(f, [id(alias)], 1)) as { route: 'linked'; outbox: { id: string } }
      expect(first.route).toBe('linked')
      restoreOrigin(f)
      return first
    }

    test.each(['typed', 'plain'] as const)("an unsettled %s origin report keeps the next revision on the origin despite prefer: 'recent'", async kind => {
      const f = await fixture({ orderAcrossLanes: true })
      await originWaiting(f, kind)
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2, { prefer: 'recent' }))).toEqual({ route: 'origin' })
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(0)
    })

    test('an unsettled alias report keeps the next revision on the same alias, sent after it', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      const first = aliasWaiting(f)
      const second = f.service.routeWorkItemReport(revision(f, [id(alias)], 2)) as { route: 'linked'; outbox: { id: string } }
      expect(second.route).toBe('linked')
      expect(f.store.getOutbox(second.outbox.id)!.intent).toMatchObject({ bindingId: f.aliasBinding.id,
        metadata: { 'dsh.linked-report.reportRevision': '2', 'dsh.linked-report.originBindingId': f.origin.id } })
      // While rev1 has an unknown outcome the same-lane claim order holds rev2 back.
      setStatus(f, first.outbox.id, 'unknown_after_send')
      await drain(f.service)
      expect(f.sends.telegram).not.toHaveBeenCalled()
      expect(f.store.getOutbox(second.outbox.id)).toMatchObject({ status: 'pending' })
      resolveOutbox(f, first.outbox.id, 'retry')
      await drain(f.service)
      await drain(f.service)
      const texts = f.sends.telegram.mock.calls.map(call => JSON.stringify(call))
      expect(texts).toHaveLength(2)
      expect(texts[0]).toContain('report 1')
      expect(texts[1]).toContain('report 2')
      expect(f.sends.lark).not.toHaveBeenCalled()
    })

    test('flag off keeps the existing routing for both cases', async () => {
      const f = await fixture()
      await originWaiting(f, 'typed')
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2, { prefer: 'recent' }))).toMatchObject({ route: 'linked' })
      const g = await fixture({ orderAcrossLanes: false })
      aliasWaiting(g)
      expect(g.service.routeWorkItemReport(revision(g, [id(alias)], 2))).toEqual({ route: 'origin' })
      expect(g.store.listOutbox({ bindingId: g.aliasBinding.id })).toHaveLength(1)
    })

    test.each(['dead', 'accepted', 'delivered'])('an earlier report that is %s is not sticky', async status => {
      const f = await fixture({ orderAcrossLanes: true })
      const origin = await originWaiting(f, 'typed')
      setStatus(f, origin.id, status)
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2, { prefer: 'recent' }))).toMatchObject({ route: 'linked' })
      const g = await fixture({ orderAcrossLanes: true })
      const linked = aliasWaiting(g)
      setStatus(g, linked.outbox.id, status)
      expect(g.service.routeWorkItemReport(revision(g, [id(alias)], 2))).toEqual({ route: 'origin' })
    })

    test('only a lower revision of the same item is sticky', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      f.link()
      const later = await originReport(f, 'typed', 3)
      setStatus(f, later.id, 'retry_wait')
      inbound(f, f.origin.id, 1_000)
      inbound(f, f.aliasBinding.id, 2_000)
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2, { prefer: 'recent' }))).toMatchObject({ route: 'linked' })
      expect(f.service.routeWorkItemReport({ ...revision(f, [id(alias)], 4, { prefer: 'recent' }), itemId: 'item-2' })).toMatchObject({ route: 'linked' })
    })

    test('a sticky alias that is revoked, unlisted or no longer linked falls back to normal routing', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      aliasWaiting(f)
      // Removed from the owner's list: the origin is available again.
      expect(f.service.routeWorkItemReport({ ...revision(f, [], 2) })).toEqual({ route: 'origin' })
      const g = await fixture({ orderAcrossLanes: true })
      aliasWaiting(g)
      g.revokeBindingRow(g.aliasBinding.id)
      expect(g.service.routeWorkItemReport(revision(g, [id(alias)], 2))).toEqual({ route: 'origin' })
      // With the origin gone too, the normal rules fail closed rather than block.
      g.dropOrigin()
      expect(() => g.service.routeWorkItemReport(revision(g, [id(alias)], 3))).toThrowError(expect.objectContaining({ code: 'missing-binding' }))
    })

    test('a sticky origin that is unavailable falls back to the linked alias', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      await originWaiting(f, 'typed')
      f.dropOrigin()
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2))).toMatchObject({ route: 'linked' })
    })

    test('an operator-cancelled unknown report is not unsettled', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      const linked = aliasWaiting(f)
      setStatus(f, linked.outbox.id, 'unknown_after_send')
      resolveOutbox(f, linked.outbox.id, 'cancel')
      expect(f.store.getOutbox(linked.outbox.id)).toMatchObject({ status: 'unknown_after_send', failureCode: 'operator-cancelled-unknown' })
      // The cancelled alias row no longer holds the next revision on its lane.
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2))).toEqual({ route: 'origin' })
      const g = await fixture({ orderAcrossLanes: true })
      const origin = await originWaiting(g, 'typed')
      setStatus(g, origin.id, 'unknown_after_send')
      resolveOutbox(g, origin.id, 'cancel')
      // The cancelled origin row no longer overrides prefer: 'recent'.
      expect(g.service.routeWorkItemReport(revision(g, [id(alias)], 2, { prefer: 'recent' }))).toMatchObject({ route: 'linked' })
    })

    test('a sticky alias refusal before commit falls back to the origin; after commit it throws', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      aliasWaiting(f)
      const enqueue = f.store.enqueue.bind(f.store)
      const refusal = vi.spyOn(f.store, 'enqueue').mockImplementationOnce(() => {
        throw new AssistantDeliveryError('missing-binding', 'alias refused before commit')
      })
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2))).toEqual({ route: 'origin' })
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(1)
      refusal.mockRestore()
      // A refusal raised after the linked row committed is final: never pair it with an origin send.
      const committed = vi.spyOn(f.store, 'enqueue').mockImplementationOnce(input => {
        enqueue(input)
        throw new AssistantDeliveryError('missing-binding', 'alias refused after commit')
      })
      expect(() => f.service.routeWorkItemReport(revision(f, [id(alias)], 3)))
        .toThrowError(expect.objectContaining({ code: 'missing-binding' }))
      committed.mockRestore()
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(2)
      await drain(f.service)
      expect(f.sends.lark).not.toHaveBeenCalled()
    })

    test('replay and idempotency are unchanged', async () => {
      const f = await fixture({ orderAcrossLanes: true })
      const first = aliasWaiting(f)
      // A replay of rev1 keeps its committed alias row even though the origin recovered.
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 1))).toMatchObject({ route: 'linked', outbox: { id: first.outbox.id } })
      const second = f.service.routeWorkItemReport(revision(f, [id(alias)], 2)) as { route: 'linked'; outbox: { id: string } }
      expect(f.service.routeWorkItemReport(revision(f, [id(alias)], 2))).toMatchObject({ outbox: { id: second.outbox.id } })
      expect(() => f.service.routeWorkItemReport({ ...revision(f, [id(alias)], 2), itemId: 'item-2' }))
        .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
      expect(f.store.listOutbox({ bindingId: f.aliasBinding.id })).toHaveLength(2)
      // A key already committed on the origin still returns the origin.
      const g = await fixture({ orderAcrossLanes: true })
      await originWaiting(g, 'typed')
      expect(g.service.routeWorkItemReport(revision(g, [id(alias)], 1, { prefer: 'recent' }))).toEqual({ route: 'origin' })
    })
  })
})
