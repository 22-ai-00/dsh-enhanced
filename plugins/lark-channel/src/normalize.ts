import type { InboundEnvelope } from '@dsh-enhanced/assistant-delivery'
import { larkProviderReplyThread, larkTopLevelSenderThread } from './group-thread.js'
import type { LarkInboundConfig, LarkMessage } from './types.js'

export type LarkIgnoreReason = 'bot-mention-required' | 'empty-content' | 'stale-event'

export type LarkNormalizeResult =
  | { outcome: 'accept'; envelope: InboundEnvelope }
  | { outcome: 'ignore'; reason: LarkIgnoreReason }

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const providerCapabilityPattern = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,255}$/u

function key(value: string, field: string): string {
  const normalized = value.trim()
  if (!keyPattern.test(normalized)) throw new Error(`lark-channel: ${field} is invalid`)
  return normalized
}

function providerCapability(value: string, field: string): string {
  const normalized = value.trim()
  if (!providerCapabilityPattern.test(normalized)) throw new Error(`lark-channel: ${field} is invalid`)
  return normalized
}

function content(value: string, maxTextBytes: number): string {
  if (/\p{Cc}/u.test(value.replaceAll('\n', '').replaceAll('\r', '').replaceAll('\t', ''))) {
    throw new Error('lark-channel: message contains a forbidden control character')
  }
  const normalized = value.replaceAll('\r\n', '\n').trim()
  if (Buffer.byteLength(normalized, 'utf8') > maxTextBytes) {
    throw new Error('lark-channel: message exceeds maxTextBytes')
  }
  return normalized
}

export function normalizeLarkMessage(
  config: LarkInboundConfig,
  input: LarkMessage,
  now: number,
): LarkNormalizeResult {
  if (!Number.isSafeInteger(input.createTime) || input.createTime < 0) {
    throw new Error('lark-channel: createTime is invalid')
  }
  if (now - input.createTime > config.staleAfterMs) return { outcome: 'ignore', reason: 'stale-event' }
  if (input.chatType === 'group' && config.requireMentionInGroups && !input.mentionedBot) {
    return { outcome: 'ignore', reason: 'bot-mention-required' }
  }
  if (input.resources.length > 10) throw new Error('lark-channel: message has too many attachment descriptors')
  const normalizedText = content(input.content, config.maxTextBytes)
  if (normalizedText.length === 0 && input.resources.length === 0) return { outcome: 'ignore', reason: 'empty-content' }
  const text = normalizedText
  const account = key(config.account, 'account')
  const tenant = key(config.tenant, 'tenant')
  const eventId = providerCapability(input.messageId, 'messageId')
  const chat = key(input.chatId, 'chatId')
  const user = key(input.senderId, 'senderId')
  const principal = { channel: 'lark', account, tenant, user }
  const conversation: InboundEnvelope['conversation'] = input.chatType === 'p2p'
    ? { channel: 'lark', account, tenant, kind: 'dm', chat }
    : { channel: 'lark', account, tenant, kind: 'group', chat,
        thread: input.rootId === undefined
          ? larkTopLevelSenderThread(user)
          : larkProviderReplyThread(key(input.rootId, 'rootId')) }
  return {
    outcome: 'accept',
    envelope: {
      channel: 'lark',
      account,
      eventId,
      occurredAt: input.createTime,
      principal,
      conversation,
      kind: text.startsWith('/') ? 'command' : 'text',
      text,
      metadata: {
        providerMessageId: eventId,
        rawContentType: key(input.rawContentType, 'rawContentType'),
        resourceCount: String(Math.min(input.resources.length, 999)),
        ...(input.replyToMessageId === undefined
          ? {}
          : { replyToProviderMessageId: providerCapability(input.replyToMessageId, 'replyToMessageId') }),
      },
      ...(input.resources.length === 0 ? {} : { attachments: input.resources.map(resource => ({
        resourceType: resource.type,
        providerRef: providerCapability(resource.fileKey, 'resource.fileKey'),
        ...(resource.fileName === undefined ? {} : { fileName: resource.fileName }),
      })) }),
    },
  }
}
