import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService,
  ownerNotificationReplyProtocol,
  ownerNotificationWithdrawalProtocol,
  type OwnerNotificationReply,
  type OwnerNotificationReplyInput,
  type OwnerNotificationReplyOutcome,
  type OwnerNotificationWithdrawal,
  type OwnerRouteAuthority,
} from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

/**
 * Slice 5 Delivery side: an authenticated owner text reply quoting exactly one
 * accepted/delivered/read owner notice is matched, policy-checked, handed to
 * the live registered consumer and marked processed. No network or model call
 * is made; the adapter is a local stub.
 */

const roots: string[] = []
const contexts = new Set<Context>()
const principal = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', user: 'ou_owner' }
const conversation = { channel: 'lark', account: 'bot-1', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_owner' }
const ownerRoute: OwnerRouteAuthority = {
  id: 'attention-question-owner', conversation, principal, workspace: '/work/alpha', agentPreset: 'primary',
  policyRef: 'owner-dm', minimumGeneration: 1,
}
const sourceId = 'assistant-evaluation/attention-owner-notice/v1'
const keyPrefix = 'attention-owner-question:'
const questionId = 'a'.repeat(64)
const noticeKey = `${keyPrefix}${questionId}`

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

interface FixtureOptions {
  replyPolicy?: boolean
  consume?: (input: OwnerNotificationReplyInput) => OwnerNotificationReplyOutcome
}

interface Fixture {
  readonly ctx: Context
  readonly path: string
  readonly service: AssistantDeliveryService
  readonly store: DeliveryStore
  readonly ownerAuthority: Readonly<{ replies: Set<object>; withdrawals: Set<object> }>
  readonly consume: ReturnType<typeof vi.fn<(input: OwnerNotificationReplyInput) => OwnerNotificationReplyOutcome>>
  readonly withdrawal: OwnerNotificationWithdrawal
  readonly withdrawalHandle: string
  enqueueNotice(overrides?: { idempotencyKey?: string; text?: string }): ReturnType<AssistantDeliveryService['enqueueOwnerNotification']>
  drain(): Promise<void>
  reply(eventId: string, text?: string, providerMessageId?: string): ReturnType<AssistantDeliveryService['acceptInbound']>
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-answer-question-'))
  roots.push(root)
  const ctx = new Context()
  contexts.add(ctx)
  try {
    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/ou_owner' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
        { id: 'ingest', effect: 'allow', subject: { kind: 'external', id: 'lark/bot-1/tenant-a/*' },
          actions: ['ingest'], resource: { kind: 'message', id: '*' }, context: { initiators: ['external'] } },
        { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: sourceId, workspace: '/work/alpha',
          principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
          context: { initiators: ['background'] } },
        { id: 'plain-send', effect: 'allow', subject: { kind: 'background', id: 'proactive-engine', workspace: '/work/alpha',
          principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
          context: { initiators: ['background'] } },
        ...(options.replyPolicy === false ? [] : [{ id: 'answer-question', effect: 'allow' as const, subject: {
          kind: 'external' as const, id: 'lark/bot-1/tenant-a/ou_owner', workspace: '/work/alpha',
          principal: 'lark/bot-1/tenant-a/ou_owner' }, actions: ['answer-attention-question'], resource: { kind: 'message' as const, id: '*' },
          context: { initiators: ['external' as const] } }]),
      ],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'), spoolPath: join(root, 'spool'), schedulerEnabled: false,
      retryBaseMs: 1, retryMaxMs: 1, ownerRoutes: [ownerRoute],
    })
    const service = ctx.assistantDelivery
    const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
    const path = join(root, 'delivery.sqlite')
    const challenge = service.issuePairing('test', principal)
    service.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const binding = store.getActiveBinding(conversation) ?? store.createBinding({
      conversation, principal, workspace: '/work/alpha', agentPreset: 'primary', sessionId: 'session-1', policyRef: 'owner-dm',
    })
    const owner = store.getPrincipal(principal)!
    let providerCount = 0
    await service.registerAdapter({
      channel: 'lark', account: 'bot-1',
      capabilities: { reconcileUnknownSend: false, receipts: [], formats: ['plain'] }, start: async () => {},
      send: async () => ({ outcome: 'accepted' as const, providerMessageId: `provider-${++providerCount}` }),
    })
    // The Evaluation service slot is faked: Delivery only asks it to vouch for
    // the exact registration objects this test creates.
    const ownerAuthority = { replies: new Set<object>(), withdrawals: new Set<object>() }
    ctx.provide('assistantEvaluation' as never, {
      ownsOwnerNotificationReply: (value: object) => ownerAuthority.replies.has(value),
      ownsOwnerNotificationWithdrawal: (value: object) => ownerAuthority.withdrawals.has(value),
    } as never)
    const withdrawal: OwnerNotificationWithdrawal = Object.freeze({
      protocol: ownerNotificationWithdrawalProtocol, authority: 'assistantEvaluation', sourceId, isWithdrawn: () => false,
    })
    ownerAuthority.withdrawals.add(withdrawal)
    const withdrawalHandle = service.registerOwnerNotificationWithdrawal(withdrawal).handle
    const consume = vi.fn<(input: OwnerNotificationReplyInput) => OwnerNotificationReplyOutcome>(
      options.consume ?? (() => 'applied'))
    const registration: OwnerNotificationReply = Object.freeze({
      protocol: ownerNotificationReplyProtocol, authority: 'assistantEvaluation', sourceId,
      idempotencyKeyPrefix: keyPrefix, consume,
    })
    ownerAuthority.replies.add(registration)
    service.registerOwnerNotificationReply(registration)
    const enqueueNotice = (overrides: { idempotencyKey?: string; text?: string } = {}) => service.enqueueOwnerNotification({
      sourceId, ownerRouteId: ownerRoute.id,
      scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id, principalVersion: owner.version,
        workspace: '/work/alpha', preset: 'primary' },
      sessionId: binding.sessionId, idempotencyKey: overrides.idempotencyKey ?? noticeKey,
      text: overrides.text ?? 'Attention settings: reply "authorize-once" or "decline".',
      expiresAt: Date.now() + 60_000, withdrawable: true, withdrawalHandle,
    })
    return {
      ctx, path, service, store, ownerAuthority, consume, withdrawal, withdrawalHandle, enqueueNotice,
      drain: async () => { await service.tick(); await service.whenIdle() },
      reply: (eventId, text = 'authorize-once', providerMessageId = 'provider-1') => service.acceptInbound({
        channel: principal.channel, account: principal.account, eventId, occurredAt: Date.now(),
        principal, conversation, kind: 'text', text, metadata: { replyToProviderMessageId: providerMessageId },
      }),
    }
  } catch (error) {
    await ctx.fiber.restart()
    contexts.delete(ctx)
    throw error
  }
}

/** One sent attention notice; returns the durable Outbox row. */
async function sentNotice(f: Fixture, overrides: { idempotencyKey?: string; text?: string } = {}) {
  const queued = f.enqueueNotice(overrides)
  await f.drain()
  return f.store.getOutbox(queued.id)!
}

describe('owner question reply matching', () => {
  test('matches one delivered notice, hands the exact identity to the consumer and marks the Inbox processed', async () => {
    const f = await fixture()
    const notice = await sentNotice(f)
    expect(notice).toMatchObject({ status: 'accepted', providerMessageId: 'provider-1' })
    const envelope = { channel: principal.channel, account: principal.account, eventId: 'reply-1', occurredAt: 1_000,
      principal, conversation, kind: 'text' as const, text: 'authorize-once',
      metadata: { replyToProviderMessageId: 'provider-1' } }
    const accepted = await f.service.acceptInbound(envelope)
    expect(accepted).toMatchObject({ duplicate: false, status: 'processed' })
    expect(f.store.getInbox(accepted.inboxId)).toMatchObject({ status: 'processed' })
    expect(f.consume).toHaveBeenCalledOnce()
    expect(f.consume).toHaveBeenCalledWith(Object.freeze({
      inboxId: accepted.inboxId, envelopeHash: expect.any(String), outboxId: notice.id,
      providerMessageId: 'provider-1', idempotencyKey: noticeKey, sourceId,
      principalId: 'lark/bot-1/tenant-a/ou_owner', text: 'authorize-once',
      receivedAt: expect.any(Number),
    }))
    // Provider redelivery returns the same processed Inbox and does not re-consume.
    expect(await f.service.acceptInbound(envelope)).toMatchObject({ duplicate: true, status: 'processed' })
    expect(f.consume).toHaveBeenCalledOnce()
  })

  test('a duplicate reply event with a new id consumes again, leaving retries to the idempotent consumer', async () => {
    const f = await fixture()
    await sentNotice(f)
    expect(await f.reply('reply-1')).toMatchObject({ status: 'processed' })
    expect(await f.reply('reply-2', 'authorize-once')).toMatchObject({ status: 'processed' })
    expect(f.consume).toHaveBeenCalledTimes(2)
  })

  test('a reply quoting a non-attention notice, a pending notice or an unknown message stays ordinary input', async () => {
    const f = await fixture()
    // A withdrawable notice from another source under an unrelated key.
    const owner = f.store.getPrincipal(principal)!
    const other = f.service.enqueueOwnerNotification({
      sourceId: 'proactive-engine', ownerRouteId: ownerRoute.id,
      scope: { principalId: 'lark/bot-1/tenant-a/ou_owner', principalRecordId: owner.id, principalVersion: owner.version,
        workspace: '/work/alpha', preset: 'primary' }, sessionId: 'session-1', idempotencyKey: 'plain-notice',
      text: 'A proactive reminder.', expiresAt: Date.now() + 60_000,
    })
    await f.drain()
    expect(f.store.getOutbox(other.id)).toMatchObject({ status: 'accepted' })
    // A notice that never left the queue has no provider id to quote.
    const pending = f.enqueueNotice({ idempotencyKey: `${keyPrefix}${'b'.repeat(64)}`, text: 'other question' })
    const cases = [
      await f.reply('ordinary-1', 'authorize-once', 'provider-1'),
      await f.reply('ordinary-2', 'authorize-once', 'provider-2'),
      await f.reply('ordinary-3', 'authorize-once', 'missing-provider'),
    ]
    expect(cases.map(result => result.status)).toEqual(['queued', 'queued', 'queued'])
    expect(f.consume).not.toHaveBeenCalled()
    // A key outside the registered prefix is not matched even for the right source.
    expect(f.store.getOutbox(pending.id)).toMatchObject({ status: 'pending' })
  })

  test('a notice under the right source but an unrelated idempotency key does not match', async () => {
    const f = await fixture()
    const notice = await sentNotice(f, { idempotencyKey: 'unrelated-attention-notice', text: 'not a question' })
    expect(notice).toMatchObject({ status: 'accepted' })
    expect(await f.reply('wrong-key')).toMatchObject({ status: 'queued' })
    expect(f.consume).not.toHaveBeenCalled()
  })

  test('another paired principal quoting the owner notice cannot answer it', async () => {
    const f = await fixture()
    await sentNotice(f)
    const otherPrincipal = { ...principal, user: 'ou_other' }
    const challenge = f.service.issuePairing('test', otherPrincipal)
    // The test policy only confirms the owner; pair the second user directly in the store.
    f.store.confirmPairing({ challengeId: challenge.challenge.id, principal: otherPrincipal, code: challenge.code })
    const otherConversation = { ...conversation, chat: 'oc_other' }
    f.store.createBinding({ conversation: otherConversation, principal: otherPrincipal, workspace: '/work/alpha',
      agentPreset: 'primary', sessionId: 'session-2', policyRef: 'owner-dm' })
    const accepted = await f.service.acceptInbound({ channel: principal.channel, account: principal.account,
      eventId: 'other-principal', occurredAt: Date.now(), principal: otherPrincipal, conversation: otherConversation,
      kind: 'text', text: 'authorize-once', metadata: { replyToProviderMessageId: 'provider-1' } })
    expect(accepted.status).toBe('queued')
    expect(f.consume).not.toHaveBeenCalled()
  })

  test('an explicit policy denial falls through to ordinary input', async () => {
    const f = await fixture({ replyPolicy: false })
    await sentNotice(f)
    expect(await f.reply('denied')).toMatchObject({ status: 'queued' })
    expect(f.consume).not.toHaveBeenCalled()
  })

  test('a transient consumer failure leaves the Inbox pending and a later message retries it first', async () => {
    const f = await fixture({ consume: () => 'transient' })
    await sentNotice(f)
    const held = await f.reply('transient-reply')
    expect(held.status).toBe('received')
    expect(f.consume).toHaveBeenCalledOnce()
    // The consumer recovers; a later ordinary message first drives the older
    // pending reply to completion, then admits itself.
    f.consume.mockReturnValue('applied')
    const later = await f.service.acceptInbound({ channel: principal.channel, account: principal.account,
      eventId: 'later-message', occurredAt: Date.now(), principal, conversation, kind: 'text', text: 'later question' })
    expect(later.status).toBe('queued')
    expect(f.store.getInbox(held.inboxId)).toMatchObject({ status: 'processed' })
    expect(f.consume).toHaveBeenCalledTimes(2)
  })

  test('an ignored consumer outcome keeps the reply on the ordinary path', async () => {
    const f = await fixture({ consume: () => 'ignored' })
    await sentNotice(f)
    expect(await f.reply('ignored', 'not a recognized choice')).toMatchObject({ status: 'queued' })
  })

  test('an unowned or unregistered consumer never matches, and unregister stops matching', async () => {
    const f = await fixture()
    const notice = await sentNotice(f)
    expect(() => f.service.registerOwnerNotificationReply({ protocol: ownerNotificationReplyProtocol,
      authority: 'assistantEvaluation', sourceId, idempotencyKeyPrefix: keyPrefix, consume: () => 'applied' }))
      .toThrowError(expect.objectContaining({ code: 'runtime-conflict' }))
    // Drop the vouched entry: the already-registered object is no longer live.
    f.ownerAuthority.replies.clear()
    expect(await f.reply('after-revoke', 'authorize-once', notice.providerMessageId!)).toMatchObject({ status: 'queued' })
    expect(f.consume).not.toHaveBeenCalled()
  })

  test('an ambiguous provider message id never binds a reply, even without the unique index', async () => {
    const f = await fixture()
    const first = await sentNotice(f)
    const second = await sentNotice(f, { idempotencyKey: `${keyPrefix}${'c'.repeat(64)}`, text: 'second question' })
    expect(second.providerMessageId).toBe('provider-2')
    const database = new DatabaseSync(f.path)
    try {
      database.exec('DROP INDEX outbox_provider_message')
      database.prepare('UPDATE outbox_messages SET provider_message_id = ? WHERE id = ?').run(first.providerMessageId!, second.id)
    } finally {
      database.close()
    }
    expect(await f.reply('ambiguous', 'authorize-once', first.providerMessageId!)).toMatchObject({ status: 'queued' })
    expect(f.consume).not.toHaveBeenCalled()
  })
})
