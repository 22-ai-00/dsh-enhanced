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

  test('uses root or message identity as a deterministic group thread fallback', () => {
    expect(normalizeLarkMessage(config, message({ chatType: 'group', mentionedBot: true, rootId: 'om_root' }), 100_100))
      .toMatchObject({ outcome: 'accept', envelope: { conversation: { thread: 'om_root' } } })
    expect(normalizeLarkMessage(config, message({ chatType: 'group', mentionedBot: true }), 100_100))
      .toMatchObject({ outcome: 'accept', envelope: { conversation: { thread: 'om_1' } } })
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
