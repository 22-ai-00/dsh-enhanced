import { createHash } from 'node:crypto'

/**
 * Delivery requires every group conversation to own an explicit lane. Lark
 * top-level messages do not have a provider root, so they use this private
 * namespace instead. A digest keeps the key bounded even for a maximum-length
 * principal id; Delivery still verifies the exact principal on every binding.
 */
export const LARK_TOP_LEVEL_SENDER_THREAD_PREFIX = 'dsh-lark-top-sender/'

/** Opt-in lane for a Feishu topic-group thread (`message.thread_id`). */
export const LARK_TOPIC_THREAD_PREFIX = 'dsh-lark-topic/'

/**
 * Opt-in lane for a Feishu topic-group thread (`message.thread_id`). The
 * principal is part of the key: Delivery binds one principal per conversation,
 * so the owner and an allowlisted peer bot in the same topic must not collide.
 */
export function larkTopicThread(threadId: string, principalId: string): string {
  const digest = createHash('sha256').update(`${threadId}\u0000${principalId}`, 'utf8').digest('base64url')
  return `${LARK_TOPIC_THREAD_PREFIX}${digest}`
}

export function isLarkTopicThread(thread: string | undefined): boolean {
  return thread !== undefined && thread.startsWith(LARK_TOPIC_THREAD_PREFIX)
}

export function larkTopLevelSenderThread(senderId: string): string {
  const digest = createHash('sha256').update(senderId, 'utf8').digest('base64url')
  return `${LARK_TOP_LEVEL_SENDER_THREAD_PREFIX}${digest}`
}

export function larkProviderReplyThread(rootId: string): string {
  if (rootId.startsWith(LARK_TOP_LEVEL_SENDER_THREAD_PREFIX) || rootId.startsWith(LARK_TOPIC_THREAD_PREFIX)) {
    throw new Error('lark-channel: rootId uses a reserved namespace for synthetic lanes')
  }
  return rootId
}

export function isLarkTopLevelSenderThread(thread: string | undefined): boolean {
  return thread !== undefined && thread.startsWith(LARK_TOP_LEVEL_SENDER_THREAD_PREFIX)
}
