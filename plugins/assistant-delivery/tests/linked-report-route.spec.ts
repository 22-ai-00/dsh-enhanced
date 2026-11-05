import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { AssistantDeliveryService } from '../src/service.ts'
import { DeliveryStore } from '../src/store.ts'
import type { ExternalPrincipalKey } from '../src/types.ts'

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

async function start(root: string) {
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
    spoolPath: join(root, 'spool'), schedulerEnabled: false, retryBaseMs: 1, retryMaxMs: 1 })
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

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'delivery-linked-report-'))
  roots.push(root)
  const live = await start(root)
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
})
