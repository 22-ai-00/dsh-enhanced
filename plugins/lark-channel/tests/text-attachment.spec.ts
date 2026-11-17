import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  AssistantDeliveryService,
  attentionWordCaps,
  convertOverCapAttention,
  type DeliveryAdapterContext,
  type OutboundIntent,
  type OutboundTextAttachment,
} from '@dsh-enhanced/assistant-delivery'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { LarkDeliveryAdapter, type LarkAdapterOptions } from '../src/adapter.ts'
import {
  LarkTransportError,
  type LarkSendInput,
  type LarkSendOptions,
  type LarkTextFileUploadInput,
  type LarkTransport,
  type LarkTransportHandlers,
} from '../src/types.ts'

class AttachmentFakeTransport implements LarkTransport {
  handlers: LarkTransportHandlers | undefined
  readonly connect = vi.fn(async () => {})
  readonly disconnect = vi.fn(async () => {})
  readonly addReaction = vi.fn(async () => 'reaction-1')
  readonly createProgress = vi.fn(async () => ({ cotId: 'cot-1', messageId: 'om_cot' }))
  readonly writeProgress = vi.fn(async () => {})
  readonly uploadTextFile = vi.fn(async (_input: LarkTextFileUploadInput) => 'file_v2_attached')
  readonly send = vi.fn(async (_chatId: string, _input: LarkSendInput, _options?: LarkSendOptions) => ({
    messageId: `om_msg_${this.send.mock.calls.length}`,
  }))

  subscribe(handlers: LarkTransportHandlers): () => void {
    this.handlers = handlers
    return () => { if (this.handlers === handlers) this.handlers = undefined }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function makeAttachment(
  text: string,
  mediaType: 'text/plain' | 'text/markdown' = 'text/plain',
  overrides: Partial<OutboundTextAttachment> = {},
): OutboundTextAttachment {
  const hash = sha256(text)
  return {
    kind: 'text',
    name: `notice-${hash.slice(0, 12)}.${mediaType === 'text/markdown' ? 'md' : 'txt'}`,
    mediaType,
    text,
    sha256: hash,
    ...overrides,
  }
}

function baseIntent(overrides: Partial<OutboundIntent> = {}): OutboundIntent {
  return {
    idempotencyKey: 'notice-1',
    bindingId: 'binding-1',
    target: {
      principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
      conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_dm' },
    },
    text: 'summary',
    format: 'plain',
    replyToEventId: 'om_in',
    ...overrides,
  }
}

function fixture(options: LarkAdapterOptions = {}, maxTextBytes = 65_536) {
  const transport = new AttachmentFakeTransport()
  const context: DeliveryAdapterContext = {
    accept: vi.fn(async () => ({ duplicate: false, inboxId: 'inbox-1', status: 'queued' as const })),
    receipt: vi.fn(async () => {}),
  }
  const adapter = new LarkDeliveryAdapter({
    account: 'primary-bot',
    tenant: 'tenant-a',
    requireMentionInGroups: true,
    maxTextBytes,
    staleAfterMs: 60_000,
  }, transport, { now: () => 1_100, ...options })
  return { adapter, context, transport }
}

const cleanupRoots: string[] = []
const cleanupContexts = new Set<Context>()

afterEach(async () => {
  await Promise.all([...cleanupContexts].map(async ctx => {
    await ctx.fiber.restart()
    cleanupContexts.delete(ctx)
  }))
  await Promise.all(cleanupRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Lark delivery adapter text attachments (WP19)', () => {
  test('declares capabilities.textAttachments === true even with a minimal transport', () => {
    const f = fixture()
    expect(f.adapter.capabilities.textAttachments).toBe(true)

    const minimalTransport: LarkTransport = {
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      send: async () => ({ messageId: 'om_sent' }),
    }
    const minimalAdapter = new LarkDeliveryAdapter({
      account: 'primary-bot',
      tenant: 'tenant-a',
      requireMentionInGroups: true,
      maxTextBytes: 65_536,
      staleAfterMs: 60_000,
    }, minimalTransport)
    expect(minimalAdapter.capabilities.textAttachments).toBe(true)
  })

  test('uploads UTF-8 attachment and delivers file message plus inline summary in DM and topic group', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const fullText = Array.from({ length: attentionWordCaps.result + 25 }, (_, i) => `段落${i}`).join(' ')
    const converted = convertOverCapAttention({ text: fullText, format: 'markdown', digest: sha256 })

    const dmResult = await f.adapter.send(baseIntent({
      idempotencyKey: 'overcap-dm-1',
      text: converted.text,
      format: converted.format,
      attachment: converted.attachment,
    }), new AbortController().signal)

    expect(dmResult).toEqual({ outcome: 'accepted', providerMessageId: 'om_msg_2' })
    expect(f.transport.uploadTextFile).toHaveBeenCalledOnce()
    expect(f.transport.uploadTextFile).toHaveBeenCalledWith({
      name: converted.attachment.name,
      mediaType: 'text/markdown',
      text: fullText,
      maxBytes: 65_536,
      signal: expect.any(AbortSignal),
    })
    expect(f.transport.send).toHaveBeenCalledTimes(2)
    expect(f.transport.send).toHaveBeenNthCalledWith(1, 'oc_dm', { fileKey: 'file_v2_attached' }, {
      replyTo: 'om_in',
      requestKey: 'overcap-dm-1:attachment',
      signal: expect.any(AbortSignal),
    })
    expect(f.transport.send).toHaveBeenNthCalledWith(2, 'oc_dm', { text: converted.text }, {
      replyTo: 'om_in',
      requestKey: 'overcap-dm-1',
      signal: expect.any(AbortSignal),
    })
    expect(f.transport.addReaction).toHaveBeenCalledWith('om_in', 'DONE')

    const groupResult = await f.adapter.send(baseIntent({
      idempotencyKey: 'overcap-topic-1',
      text: converted.text,
      format: 'plain',
      attachment: makeAttachment(fullText, 'text/plain'),
      target: {
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: {
          channel: 'lark', account: 'primary-bot', tenant: 'tenant-a',
          kind: 'group', chat: 'oc_group', thread: 'omt_topic_1',
        },
      },
    }), new AbortController().signal)
    expect(groupResult).toEqual({ outcome: 'accepted', providerMessageId: 'om_msg_4' })
    expect(f.transport.send).toHaveBeenNthCalledWith(3, 'oc_group', { fileKey: 'file_v2_attached' }, {
      replyTo: 'om_in',
      replyInThread: true,
      requestKey: 'overcap-topic-1:attachment',
      signal: expect.any(AbortSignal),
    })
    expect(f.transport.send).toHaveBeenNthCalledWith(4, 'oc_group', { text: converted.text }, {
      replyTo: 'om_in',
      replyInThread: true,
      requestKey: 'overcap-topic-1',
      signal: expect.any(AbortSignal),
    })
  })

  test('fails closed on digest mismatch, invalid format/name/size, or missing upload support without sending summary', async () => {
    const f = fixture({}, 128)
    await f.adapter.start(f.context)

    await expect(f.adapter.send(baseIntent({
      attachment: { ...makeAttachment('valid body'), sha256: sha256('tampered body') },
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-attachment-digest-mismatch', retryable: false,
    })

    await expect(f.adapter.send(baseIntent({
      format: 'markdown',
      attachment: makeAttachment('valid body', 'text/markdown'),
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-attachment-unsupported-format', retryable: false,
    })

    await expect(f.adapter.send(baseIntent({
      attachment: makeAttachment('valid body', 'text/plain', { name: '../escape.txt' }),
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-attachment-invalid', retryable: false,
    })

    await expect(f.adapter.send(baseIntent({
      attachment: makeAttachment('你'.repeat(50)),
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-attachment-too-large', retryable: false,
    })

    expect(f.transport.uploadTextFile).not.toHaveBeenCalled()
    expect(f.transport.send).not.toHaveBeenCalled()

    const noUploadTransport: LarkTransport = {
      subscribe: () => () => {},
      connect: async () => {},
      disconnect: async () => {},
      addReaction: async () => 'reaction-1',
      createProgress: async () => ({ cotId: 'cot-1', messageId: 'om_cot' }),
      writeProgress: async () => {},
      send: vi.fn(async () => ({ messageId: 'om_should_not_send' })),
    }
    const noUploadAdapter = new LarkDeliveryAdapter({
      account: 'primary-bot', tenant: 'tenant-a', requireMentionInGroups: true,
      maxTextBytes: 65_536, staleAfterMs: 60_000,
    }, noUploadTransport)
    await expect(noUploadAdapter.send(baseIntent({
      attachment: makeAttachment('full body'),
    }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-attachment-upload-unavailable', retryable: false,
    })
    expect(noUploadTransport.send).not.toHaveBeenCalled()
  })

  test('classifies upload failures accurately and never sends inline summary alone', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const attachment = makeAttachment('full attachment text')

    f.transport.uploadTextFile.mockRejectedValueOnce(new LarkTransportError('rate_limited', 'slow down', 3_000))
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-rate-limited', retryable: true, retryAfterMs: 3_000,
    })

    f.transport.uploadTextFile.mockRejectedValueOnce(new LarkTransportError('send_timeout', 'upload timed out'))
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-send-timeout', retryable: true,
    })

    f.transport.uploadTextFile.mockRejectedValueOnce(new LarkTransportError('upload_failed', 'server 502'))
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-upload-failed', retryable: true,
    })

    f.transport.uploadTextFile.mockRejectedValueOnce(new LarkTransportError('permission_denied', 'missing scope'))
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-permission-denied', retryable: false,
    })

    f.transport.uploadTextFile.mockRejectedValueOnce(new LarkTransportError('format_error', 'bad multipart'))
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-format-error', retryable: false,
    })

    f.transport.uploadTextFile.mockResolvedValueOnce('')
    await expect(f.adapter.send(baseIntent({ attachment }), new AbortController().signal)).resolves.toEqual({
      outcome: 'not-sent', failureCode: 'lark-upload-failed', retryable: true,
    })

    expect(f.transport.send).not.toHaveBeenCalled()
    expect(f.transport.addReaction).not.toHaveBeenCalled()
  })

  test('preserves idempotency across retries and classifies partial-send and abort outcomes safely', async () => {
    const f = fixture()
    await f.adapter.start(f.context)
    const attachment = makeAttachment('full attachment text')

    // 1. Attachment file send fails before reaching provider -> summary is never sent.
    f.transport.send.mockRejectedValueOnce(new LarkTransportError('rate_limited', 'throttled', 500))
    await expect(f.adapter.send(baseIntent({ idempotencyKey: 'k-file-fail', attachment }), new AbortController().signal))
      .resolves.toEqual({ outcome: 'not-sent', failureCode: 'lark-rate-limited', retryable: true, retryAfterMs: 500 })
    expect(f.transport.send).toHaveBeenCalledTimes(1)

    // 2. Attachment file succeeds ('om_file'), summary fails retryably ('rate_limited') ->
    //    retry skips re-uploading/re-sending file and delivers summary with original idempotencyKey.
    f.transport.uploadTextFile.mockClear()
    f.transport.send.mockClear()
    f.transport.send
      .mockResolvedValueOnce({ messageId: 'om_file' })
      .mockRejectedValueOnce(new LarkTransportError('rate_limited', 'summary throttled', 1_500))
      .mockResolvedValueOnce({ messageId: 'om_summary' })

    const retryableFail = await f.adapter.send(baseIntent({ idempotencyKey: 'k-retry', attachment }),
      new AbortController().signal)
    expect(retryableFail).toEqual({
      outcome: 'not-sent', failureCode: 'lark-rate-limited', retryable: true, retryAfterMs: 1_500,
    })
    const retryOk = await f.adapter.send(baseIntent({ idempotencyKey: 'k-retry', attachment }),
      new AbortController().signal)
    expect(retryOk).toEqual({ outcome: 'accepted', providerMessageId: 'om_summary' })
    expect(f.transport.uploadTextFile).toHaveBeenCalledTimes(1)
    expect(f.transport.send).toHaveBeenCalledTimes(3)
    expect(f.transport.send).toHaveBeenNthCalledWith(3, 'oc_dm', { text: 'summary' }, {
      replyTo: 'om_in', requestKey: 'k-retry', signal: expect.any(AbortSignal),
    })

    // 3. Attachment file succeeds ('om_file_partial'), summary hits ambiguous timeout -> unknown with file messageId.
    f.transport.send.mockClear()
    f.transport.send
      .mockResolvedValueOnce({ messageId: 'om_file_partial' })
      .mockRejectedValueOnce(new LarkTransportError('send_timeout', 'timeout'))
    await expect(f.adapter.send(baseIntent({ idempotencyKey: 'k-partial-timeout', attachment }),
      new AbortController().signal)).resolves.toEqual({
      outcome: 'unknown', failureCode: 'lark-send-timeout', providerMessageId: 'om_file_partial',
    })

    // 4. Pre-aborted and mid-upload abort fail as retryable not-sent; abort after file send returns unknown.
    const preAborted = new AbortController()
    preAborted.abort(new Error('stopped'))
    f.transport.uploadTextFile.mockClear()
    f.transport.send.mockClear()
    await expect(f.adapter.send(baseIntent({ idempotencyKey: 'k-pre-abort', attachment }), preAborted.signal))
      .resolves.toEqual({ outcome: 'not-sent', failureCode: 'lark-aborted', retryable: true })
    expect(f.transport.uploadTextFile).not.toHaveBeenCalled()

    const midUpload = new AbortController()
    f.transport.uploadTextFile.mockImplementationOnce(async () => {
      midUpload.abort(new Error('cancelled during upload'))
      throw new LarkTransportError('not_connected', 'cancelled')
    })
    await expect(f.adapter.send(baseIntent({ idempotencyKey: 'k-mid-upload-abort', attachment }), midUpload.signal))
      .resolves.toEqual({ outcome: 'not-sent', failureCode: 'lark-aborted', retryable: true })
    expect(f.transport.send).not.toHaveBeenCalled()

    const betweenSends = new AbortController()
    f.transport.send.mockImplementationOnce(async () => {
      betweenSends.abort(new Error('cancelled after file message'))
      return { messageId: 'om_file_before_abort' }
    })
    await expect(f.adapter.send(baseIntent({ idempotencyKey: 'k-between-abort', attachment }), betweenSends.signal))
      .resolves.toEqual({ outcome: 'unknown', failureCode: 'lark-aborted', providerMessageId: 'om_file_before_abort' })
    expect(f.transport.send).toHaveBeenCalledTimes(1)
  })

  test('integrates end-to-end with AssistantDeliveryService attentionAttachOverCap=true', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lark-attach-e2e-'))
    cleanupRoots.push(root)
    const ctx = new Context()
    cleanupContexts.add(ctx)
    const principal = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' }
    const conversation = { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm' as const, chat: 'oc_dm' }

    await ctx.plugin(AssistantPolicyService, {
      databasePath: join(root, 'policy.sqlite'),
      rules: [
        { id: 'local-pair', effect: 'allow', subject: { kind: 'external', id: 'local:test' },
          actions: ['pair.issue'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['foreground'] } },
        { id: 'owner-pair', effect: 'allow', subject: { kind: 'external', id: 'lark/primary-bot/tenant-a/ou_owner' },
          actions: ['pair.confirm'], resource: { kind: 'message', id: 'pairing' }, context: { initiators: ['external'] } },
        { id: 'notice-send', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root,
          principal: 'lark/primary-bot/tenant-a/ou_owner' }, actions: ['send'], resource: { kind: 'message', id: '*' },
        context: { initiators: ['background'] } },
      ],
    })
    await ctx.plugin(AssistantDeliveryService, {
      databasePath: join(root, 'delivery.sqlite'),
      spoolPath: join(root, 'spool'),
      schedulerEnabled: false,
      attentionAttachOverCap: true,
    })

    const transport = new AttachmentFakeTransport()
    const adapter = new LarkDeliveryAdapter({
      account: 'primary-bot',
      tenant: 'tenant-a',
      requireMentionInGroups: true,
      maxTextBytes: 65_536,
      staleAfterMs: 60_000,
    }, transport, { statusReactions: false })
    await ctx.assistantDelivery.registerAdapter(adapter)

    const challenge = ctx.assistantDelivery.issuePairing('test', principal)
    ctx.assistantDelivery.confirmPairing({ challengeId: challenge.challenge.id, principal, code: challenge.code })
    const store = (ctx.assistantDelivery as unknown as {
      deliveryStore: {
        createBinding(input: unknown): { id: string }
        getOutbox(id: string): { status: string; providerMessageId?: string } | undefined
      }
    }).deliveryStore
    const binding = store.createBinding({
      conversation, principal, workspace: root, agentPreset: 'standard', sessionId: 'session-1', policyRef: 'owner-dm',
    })

    const longBody = Array.from({ length: attentionWordCaps.result + 30 }, (_, i) => `item${i}`).join(' ')
    const queued = ctx.assistantDelivery.enqueueBackground({
      sourceId: 'proactive-engine',
      workspace: root,
      bindingId: binding.id,
      idempotencyKey: 'e2e-overcap-1',
      text: longBody,
      format: 'markdown',
      attention: { purpose: 'result' },
    })

    await ctx.assistantDelivery.tick()
    await ctx.assistantDelivery.whenIdle()

    expect(store.getOutbox(queued.id)).toMatchObject({ status: 'accepted', providerMessageId: 'om_msg_2' })
    expect(transport.uploadTextFile).toHaveBeenCalledWith({
      name: `notice-${sha256(longBody).slice(0, 12)}.md`,
      mediaType: 'text/markdown',
      text: longBody,
      maxBytes: 65_536,
      signal: expect.any(AbortSignal),
    })
    expect(transport.send).toHaveBeenNthCalledWith(1, 'oc_dm', { fileKey: 'file_v2_attached' }, {
      requestKey: 'e2e-overcap-1:attachment',
      signal: expect.any(AbortSignal),
    })
    expect(transport.send).toHaveBeenNthCalledWith(2, 'oc_dm', { text: queued.intent.text }, {
      requestKey: 'e2e-overcap-1',
      signal: expect.any(AbortSignal),
    })
  })
})
