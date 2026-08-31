import { describe, expect, test } from 'vitest'
import { normalizeLarkMessage } from '../src/normalize.ts'
import type { LarkInboundConfig, LarkMessage } from '../src/types.ts'

const config: LarkInboundConfig = {
  account: 'primary-bot',
  tenant: 'tenant-a',
  requireMentionInGroups: true,
  maxTextBytes: 128,
  staleAfterMs: 60_000,
}

function message(overrides: Partial<LarkMessage> = {}): LarkMessage {
  return {
    messageId: 'om_1',
    chatId: 'oc_1',
    chatType: 'p2p',
    senderId: 'ou_owner',
    content: 'hello',
    rawContentType: 'text',
    resources: [],
    mentionAll: false,
    mentionedBot: false,
    createTime: 100_000,
    ...overrides,
  }
}

describe('Lark inbound normalization', () => {
  test('maps a DM to exact typed principal/conversation identities', () => {
    expect(normalizeLarkMessage(config, message(), 100_100)).toEqual({
      outcome: 'accept',
      envelope: {
        channel: 'lark',
        account: 'primary-bot',
        eventId: 'om_1',
        occurredAt: 100_000,
        principal: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', user: 'ou_owner' },
        conversation: { channel: 'lark', account: 'primary-bot', tenant: 'tenant-a', kind: 'dm', chat: 'oc_1' },
        kind: 'text',
        text: 'hello',
        metadata: { providerMessageId: 'om_1', rawContentType: 'text', resourceCount: '0' },
      },
    })
  })

  test('preserves an exact provider reply target as bounded non-prompt metadata', () => {
    expect(normalizeLarkMessage(config, message({
      messageId: 'om_feedback', content: '/feedback helpful', replyToMessageId: 'om_answer',
    }), 100_100)).toMatchObject({
      outcome: 'accept',
      envelope: { metadata: { replyToProviderMessageId: 'om_answer' } },
    })
    expect(() => normalizeLarkMessage(config, message({
      replyToMessageId: '../om_answer',
    }), 100_100)).toThrow(/replyToMessageId/i)
  })

  test('isolates group conversations by provider thread and requires a direct bot mention', () => {
    const accepted = normalizeLarkMessage(config, message({
      chatType: 'group', mentionedBot: true, rootId: 'om_root', threadId: 'omt_thread', content: '/new',
    }), 100_100)
    expect(accepted).toMatchObject({ outcome: 'accept', envelope: {
      kind: 'command',
      conversation: { kind: 'group', chat: 'oc_1', thread: 'om_root' },
    } })

    expect(normalizeLarkMessage(config, message({ chatType: 'group' }), 100_100)).toEqual({
      outcome: 'ignore', reason: 'bot-mention-required',
    })
    expect(normalizeLarkMessage(config, message({ chatType: 'group', mentionAll: true }), 100_100)).toEqual({
      outcome: 'ignore', reason: 'bot-mention-required',
    })
  })

  test('uses a stable per-sender synthetic thread for standalone group messages', () => {
    expect(normalizeLarkMessage(config, message({ chatType: 'group', mentionedBot: true, rootId: 'om_root' }), 100_100))
      .toMatchObject({ outcome: 'accept', envelope: { conversation: { thread: 'om_root' } } })
    const first = normalizeLarkMessage(config, message({
      messageId: 'om_top_1', chatType: 'group', mentionedBot: true,
    }), 100_100)
    const second = normalizeLarkMessage(config, message({
      messageId: 'om_top_2', chatType: 'group', mentionedBot: true,
    }), 100_100)
    const otherSender = normalizeLarkMessage(config, message({
      messageId: 'om_top_3', chatType: 'group', mentionedBot: true, senderId: 'ou_other',
    }), 100_100)
    const firstConversation = (first as { envelope: { conversation: { thread: string } } }).envelope.conversation
    const secondConversation = (second as { envelope: { conversation: { thread: string } } }).envelope.conversation
    const otherConversation = (otherSender as { envelope: { conversation: { thread: string } } }).envelope.conversation
    expect(firstConversation).toMatchObject({ kind: 'group', chat: 'oc_1' })
    expect(firstConversation.thread).toMatch(/^dsh-lark-top-sender\/[A-Za-z0-9_-]{43}$/u)
    expect(secondConversation).toEqual(firstConversation)
    expect(otherConversation.thread).not.toBe(firstConversation.thread)
  })

  test('keeps real reply roots provider-addressable and disjoint from the synthetic namespace', () => {
    const first = normalizeLarkMessage(config, message({
      messageId: 'om_reply_1', chatType: 'group', mentionedBot: true, rootId: 'om_root_1',
    }), 100_100)
    const second = normalizeLarkMessage(config, message({
      messageId: 'om_reply_2', chatType: 'group', mentionedBot: true, rootId: 'om_root_2',
    }), 100_100)
    expect(first).toMatchObject({ outcome: 'accept', envelope: { conversation: { thread: 'om_root_1' } } })
    expect(second).toMatchObject({ outcome: 'accept', envelope: { conversation: { thread: 'om_root_2' } } })
    expect(() => normalizeLarkMessage(config, message({
      messageId: 'om_reply_reserved', chatType: 'group', mentionedBot: true,
      rootId: `dsh-lark-top-sender/${'a'.repeat(43)}`,
    }), 100_100)).toThrow(/rootId.*reserved namespace/iu)
  })

  test('drops stale/empty messages and rejects malformed or oversized provider data', () => {
    expect(normalizeLarkMessage(config, message({ createTime: 1 }), 100_100)).toEqual({
      outcome: 'ignore', reason: 'stale-event',
    })
    expect(normalizeLarkMessage(config, message({ content: '  ' }), 100_100)).toEqual({
      outcome: 'ignore', reason: 'empty-content',
    })
    expect(() => normalizeLarkMessage(config, message({ senderId: 'bad:id' }), 100_100)).toThrow(/senderId/i)
    expect(() => normalizeLarkMessage(config, message({ content: 'x'.repeat(129) }), 100_100)).toThrow(/maxTextBytes/i)
    expect(() => normalizeLarkMessage(config, message({ content: 'hello\0secret' }), 100_100)).toThrow(/control/i)
  })

  test('keeps resources as bounded untrusted facts without leaking raw payloads', () => {
    const result = normalizeLarkMessage(config, message({
      resources: [{ type: 'file', fileKey: 'file_1', fileName: 'report.pdf' }],
      raw: { authorization: 'secret', downloadUrl: 'https://example.invalid/private' },
    }), 100_100)
    expect(result).toMatchObject({ outcome: 'accept', envelope: {
      metadata: { resourceCount: '1' },
      attachments: [{ resourceType: 'file', providerRef: 'file_1', fileName: 'report.pdf' }],
    } })
    expect(JSON.stringify(result)).not.toContain('authorization')
    expect(JSON.stringify(result)).not.toContain('downloadUrl')
  })

  test('accepts a resource-only event without placing provider keys in prompt text', () => {
    const result = normalizeLarkMessage(config, message({
      content: '', resources: [{ type: 'image', fileKey: 'image_secret_key' }], rawContentType: 'image',
    }), 100_100)
    expect(result).toMatchObject({ outcome: 'accept', envelope: {
      text: '',
      attachments: [{ resourceType: 'image', providerRef: 'image_secret_key' }],
    } })
    expect((result as { envelope: { text: string } }).envelope.text).not.toContain('image_secret_key')
  })

  test('rejects path-like provider message and resource capabilities before persistence', () => {
    expect(() => normalizeLarkMessage(config, message({ messageId: '../om_1' }), 100_100)).toThrow(/messageId/i)
    expect(() => normalizeLarkMessage(config, message({
      resources: [{ type: 'image', fileKey: 'https://example.invalid/private' }],
    }), 100_100)).toThrow(/resource\.fileKey/i)
  })
})
