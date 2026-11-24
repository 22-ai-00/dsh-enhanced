import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AssistantDeliveryService,
  attentionWordCaps,
  ownerNotificationWithdrawalProtocol,
  type NativeWebOwnerAccess,
  type OwnerNotificationWithdrawal,
  type OwnerRouteAuthority,
} from '../src/index.ts'
import { DeliveryStore } from '../src/store.ts'

const roots: string[] = []
const contexts = new Set<Context>()
const webPrincipal = { channel: 'web', account: 'browser', tenant: 'local', user: 'owner' }
const webConversation = { channel: 'web', account: 'browser', tenant: 'local', kind: 'dm' as const, chat: 'owner-chat' }
const ownerId = 'web/browser/local/owner'
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')
const words = (count: number, prefix = 'item') => Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(' ')

afterEach(async () => {
  await Promise.all([...contexts].map(async ctx => {
    await ctx.fiber.restart()
    contexts.delete(ctx)
  }))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setupWebOwnerFixture(options: Readonly<{ attachOverCap?: boolean; enforce?: boolean }> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-delivery-web-attach-'))
  roots.push(root)
  const dbPath = join(root, 'delivery.sqlite')
  const authority: OwnerRouteAuthority = {
    id: 'web-owner-notice',
    conversation: webConversation,
    principal: webPrincipal,
    workspace: root,
    agentPreset: 'primary',
    policyRef: 'web-owner',
    minimumGeneration: 1,
  }
  const ctx = new Context()
  contexts.add(ctx)
  ctx.provide('agents' as never, { list: () => [], get: () => undefined } as never)
  ctx.provide('sessions' as never, { list: () => [] } as never)
  ctx.provide('llm' as never, {} as never)
  await ctx.plugin(AssistantPolicyService, {
    databasePath: join(root, 'policy.sqlite'),
    rules: [
      {
        id: 'web-owner-notice-send',
        effect: 'allow',
        subject: { kind: 'background', id: 'proactive-engine', workspace: root, principal: ownerId },
        actions: ['send'],
        resource: { kind: 'message', id: '*' },
        context: { initiators: ['background'] },
      },
    ],
  })
  await ctx.plugin(AssistantDeliveryService, {
    databasePath: dbPath,
    spoolPath: join(root, 'spool'),
    schedulerEnabled: false,
    retryBaseMs: 1,
    retryMaxMs: 1,
    ownerRoutes: [authority],
    ...(options.attachOverCap === undefined ? {} : { attentionAttachOverCap: options.attachOverCap }),
    ...(options.enforce === undefined ? {} : { attentionEnforce: options.enforce }),
  })
  const service = ctx.assistantDelivery
  const store = (service as unknown as { deliveryStore: DeliveryStore }).deliveryStore
  store.handoffOwner(webPrincipal)
  const access: NativeWebOwnerAccess = service.bindNativeWebOwner(ctx, {
    principal: webPrincipal,
    workspace: root,
    preset: 'primary',
  })
  const binding = store.createBinding({
    conversation: webConversation,
    principal: webPrincipal,
    workspace: root,
    agentPreset: 'primary',
    sessionId: 'web-owner-session',
    policyRef: 'web-owner',
  })
  const owner = store.getPrincipal(webPrincipal)!
  const drain = async () => {
    await service.tick()
    await service.whenIdle()
    await service.tick()
    await service.whenIdle()
  }
  return { root, dbPath, ctx, service, store, access, binding, owner, authority, drain }
}

describe('Web owner over-cap plain-text attachment delivery', () => {
  test('attaches full UTF-8 OutboundTextAttachment for over-cap Web owner notifications instead of attachment-unsupported', async () => {
    const f = await setupWebOwnerFixture({ attachOverCap: true, enforce: true })
    try {
      const longText = `中文通知摘要：${words(attentionWordCaps.result + 15)} 🚀 https://example.com/report?id=42`
      const expectedDigest = sha256(longText)
      const expectedName = `notice-${expectedDigest.slice(0, 12)}.txt`

      const expiresAt = Date.now() + 60_000
      const overCap = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-overcap-owner-notice',
        text: longText,
        expiresAt,
        attention: { purpose: 'result' },
      })
      const underCap = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-undercap-owner-notice',
        text: 'Short web update.',
        expiresAt: Date.now() + 60_000,
        attention: { purpose: 'result' },
      })

      expect(f.service.inspectAttentionRejections().entries).toEqual([])
      expect(overCap.intent.format).toBe('plain')
      expect(overCap.intent.text).toContain(expectedName)
      expect(overCap.intent.attachment).toEqual({
        kind: 'text',
        name: expectedName,
        mediaType: 'text/plain',
        text: longText,
        sha256: expectedDigest,
      })
      expect(underCap.intent).not.toHaveProperty('attachment')

      await f.drain()
      expect(f.store.getOutbox(overCap.id)).toMatchObject({ status: 'accepted' })
      expect(f.store.getOutbox(underCap.id)).toMatchObject({ status: 'accepted' })

      const listed = f.access.notifications(f.binding.sessionId)
      expect(listed).toHaveLength(2)
      expect(listed).toEqual(expect.arrayContaining([
        {
          id: overCap.id,
          text: overCap.intent.text,
          createdAt: overCap.createdAt,
          status: 'accepted',
          attachment: {
            kind: 'text',
            name: expectedName,
            mediaType: 'text/plain',
            text: longText,
            sha256: expectedDigest,
          },
        },
        {
          id: underCap.id,
          text: 'Short web update.',
          createdAt: underCap.createdAt,
          status: 'accepted',
        },
      ]))
      const underCapListed = listed.find(item => item.id === underCap.id)!
      expect('attachment' in underCapListed).toBe(false)

      // Replay remains idempotent even if attentionAttachOverCap is later disabled.
      ;(f.service as unknown as { config: { attentionAttachOverCap?: boolean } }).config.attentionAttachOverCap = false
      const replayed = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-overcap-owner-notice',
        text: longText,
        expiresAt,
        attention: { purpose: 'result' },
      })
      expect(replayed.id).toBe(overCap.id)
    } finally {
      await f.access.dispose()
    }
  })

  test('allows enqueueBackground and enqueueBackgroundRoute on Web owner to attach over-cap text without attachment-unsupported while preserving native-notice send guards', async () => {
    const f = await setupWebOwnerFixture({ attachOverCap: true, enforce: true })
    try {
      const mdText = `# 报告详情\n\n${words(attentionWordCaps.result + 10)}`
      const mdDigest = sha256(mdText)
      const bg = f.service.enqueueBackground({
        sourceId: 'proactive-engine',
        workspace: f.root,
        bindingId: f.binding.id,
        idempotencyKey: 'web-bg-overcap',
        text: mdText,
        format: 'markdown',
        attention: { purpose: 'result' },
      })
      const routed = f.service.enqueueBackgroundRoute({
        sourceId: 'proactive-engine',
        authorityId: f.authority.id,
        idempotencyKey: 'web-route-overcap',
        text: mdText,
        format: 'markdown',
        attention: { purpose: 'result' },
      })

      expect(f.service.inspectAttentionRejections().entries).toEqual([])
      expect(bg.intent.attachment).toEqual({
        kind: 'text',
        name: `notice-${mdDigest.slice(0, 12)}.md`,
        mediaType: 'text/markdown',
        text: mdText,
        sha256: mdDigest,
      })
      expect(routed.intent.attachment).toEqual(bg.intent.attachment)

      await f.drain()
      // Native Web noticeAdapter preserves its dsh.native-notice trust guard.
      expect(f.store.getOutbox(bg.id)).toMatchObject({ status: 'dead', failureCode: 'native-notice-invalid' })
      expect(f.store.getOutbox(routed.id)).toMatchObject({ status: 'dead', failureCode: 'native-notice-invalid' })
      expect(f.access.notifications(f.binding.sessionId)).toEqual([])
    } finally {
      await f.access.dispose()
    }
  })

  test('preserves ack, withdrawal, expiry, owner revocation, and attachment integrity guards for attached notices', async () => {
    const f = await setupWebOwnerFixture({ attachOverCap: true })
    const database = new DatabaseSync(f.dbPath)
    try {
      const owned = new Set<object>()
      f.ctx.provide('noticeAuthority' as never, {
        ownsOwnerNotificationWithdrawal: (registration: object) => owned.has(registration),
      } as never)
      let withdrawn = false
      const registration: OwnerNotificationWithdrawal = Object.freeze({
        protocol: ownerNotificationWithdrawalProtocol,
        authority: 'noticeAuthority',
        sourceId: 'proactive-engine',
        isWithdrawn: () => withdrawn,
      })
      owned.add(registration)
      const withdrawal = f.service.registerOwnerNotificationWithdrawal(registration)

      const longAttention = words(attentionWordCaps.attention + 10)
      const notice = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-attach-ack-guard',
        text: longAttention,
        expiresAt: Date.now() + 60_000,
        attention: { purpose: 'attention', workItemId: 'wi-1', question: { id: 'q-1', prompt: 'Proceed?' } },
        withdrawable: true,
        withdrawalHandle: withdrawal.handle,
      })
      await f.drain()
      expect(f.access.notifications(f.binding.sessionId)).toHaveLength(1)
      expect(f.access.acknowledgeNotices(f.binding.sessionId, [notice.id], 'delivered')).toEqual({ acknowledged: 1 })
      expect(f.access.notifications(f.binding.sessionId)).toEqual([
        expect.objectContaining({ id: notice.id, status: 'delivered', attachment: expect.objectContaining({ text: longAttention }) }),
      ])

      // Withdrawal closes acknowledgement while keeping the delivered notice listed until read.
      withdrawn = true
      expect(() => f.access.acknowledgeNotices(f.binding.sessionId, [notice.id], 'read')).toThrow()
      expect(f.access.notifications(f.binding.sessionId)).toHaveLength(1)
      withdrawn = false

      // Tampering with stored attachment fails closed in list/ack.
      database.prepare("UPDATE outbox_messages SET intent_json=json_set(intent_json, '$.attachment.sha256', ?) WHERE id=?")
        .run('0'.repeat(64), notice.id)
      expect(f.access.notifications(f.binding.sessionId)).toEqual([])
      expect(() => f.access.acknowledgeNotices(f.binding.sessionId, [notice.id], 'read')).toThrow('native-notice-invalid')

      // Restore valid digest, then confirm monotonic read ack removes from unread list.
      database.prepare("UPDATE outbox_messages SET intent_json=json_set(intent_json, '$.attachment.sha256', ?) WHERE id=?")
        .run(sha256(longAttention), notice.id)
      expect(f.access.acknowledgeNotices(f.binding.sessionId, [notice.id], 'read')).toEqual({ acknowledged: 1 })
      expect(f.access.notifications(f.binding.sessionId)).toEqual([])

      // Expiry and owner revocation continue to fail closed.
      const expiring = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-attach-expired',
        text: words(attentionWordCaps.result + 5),
        expiresAt: Date.now() + 10_000,
        attention: { purpose: 'result' },
      })
      await f.drain()
      const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000)
      try {
        expect(f.access.notifications(f.binding.sessionId)).toEqual([])
        expect(() => f.access.acknowledgeNotices(f.binding.sessionId, [expiring.id], 'delivered')).toThrow()
      } finally {
        clock.mockRestore()
      }

      const revocable = f.service.enqueueOwnerNotification({
        sourceId: 'proactive-engine',
        ownerRouteId: f.authority.id,
        scope: {
          principalId: ownerId,
          principalRecordId: f.owner.id,
          principalVersion: f.owner.version,
          workspace: f.root,
          preset: 'primary',
        },
        sessionId: f.binding.sessionId,
        idempotencyKey: 'web-attach-revoked',
        text: words(attentionWordCaps.result + 5),
        expiresAt: Date.now() + 60_000,
        attention: { purpose: 'result' },
      })
      await f.drain()
      expect(f.access.notifications(f.binding.sessionId).map(n => n.id)).toContain(revocable.id)
      f.store.revokePrincipal(f.owner.id, f.owner.version)
      expect(() => f.access.notifications(f.binding.sessionId)).toThrow()
      expect(() => f.access.acknowledgeNotices(f.binding.sessionId, [revocable.id], 'delivered')).toThrow()

      withdrawal.unregister()
    } finally {
      database.close()
      await f.access.dispose()
    }
  })
})
