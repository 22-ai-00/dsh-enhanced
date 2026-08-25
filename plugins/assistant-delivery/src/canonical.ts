import type { ConversationRef, DeliveryTarget, ExternalPrincipalKey } from './types.js'

export type DeliveryValidationErrorCode =
  | 'invalid-conversation'
  | 'invalid-identity'
  | 'route-mismatch'

export class DeliveryValidationError extends Error {
  constructor(readonly code: DeliveryValidationErrorCode, message: string) {
    super(message)
    this.name = 'DeliveryValidationError'
  }
}

const keyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u

function exactObject(input: unknown, fields: readonly string[], code: DeliveryValidationErrorCode): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeliveryValidationError(code, `${code}: expected an object`)
  }
  const value = input as Record<string, unknown>
  if (Object.keys(value).some(key => !fields.includes(key))) {
    throw new DeliveryValidationError(code, `${code}: unknown field`)
  }
  return value
}

function key(value: unknown, field: string, code: DeliveryValidationErrorCode): string {
  if (typeof value !== 'string') throw new DeliveryValidationError(code, `${field} must be a string`)
  const normalized = value.trim()
  if (!keyPattern.test(normalized)) throw new DeliveryValidationError(code, `${field} is invalid`)
  return normalized
}

export function canonicalPrincipal(input: ExternalPrincipalKey): ExternalPrincipalKey {
  const value = exactObject(input, ['channel', 'account', 'tenant', 'user'], 'invalid-identity')
  return {
    channel: key(value.channel, 'channel', 'invalid-identity'),
    account: key(value.account, 'account', 'invalid-identity'),
    tenant: key(value.tenant, 'tenant', 'invalid-identity'),
    user: key(value.user, 'user', 'invalid-identity'),
  }
}

/**
 * Stable Policy identity for one typed external principal.
 *
 * Components are encoded independently before joining so a provider-owned `/`
 * can never move a value across component boundaries. Legacy-safe identifiers
 * retain their existing representation.
 */
export function externalPrincipalId(input: ExternalPrincipalKey): string {
  const principal = canonicalPrincipal(input)
  return [principal.channel, principal.account, principal.tenant, principal.user]
    .map(component => encodeURIComponent(component))
    .join('/')
}

export function canonicalConversation(input: ConversationRef): ConversationRef {
  const value = exactObject(input, ['channel', 'account', 'tenant', 'kind', 'chat', 'thread'], 'invalid-conversation')
  if (value.kind !== 'dm' && value.kind !== 'group') {
    throw new DeliveryValidationError('invalid-conversation', 'conversation kind must be dm or group')
  }
  const conversation: ConversationRef = {
    channel: key(value.channel, 'channel', 'invalid-conversation'),
    account: key(value.account, 'account', 'invalid-conversation'),
    tenant: key(value.tenant, 'tenant', 'invalid-conversation'),
    kind: value.kind,
    chat: key(value.chat, 'chat', 'invalid-conversation'),
  }
  if (value.thread !== undefined) conversation.thread = key(value.thread, 'thread', 'invalid-conversation')
  if (conversation.kind === 'group' && conversation.thread === undefined) {
    throw new DeliveryValidationError('invalid-conversation', 'group conversations require an explicit thread')
  }
  if (conversation.kind === 'dm' && conversation.thread !== undefined) {
    throw new DeliveryValidationError('invalid-conversation', 'dm conversations cannot specify a thread')
  }
  return conversation
}

export function canonicalTarget(input: DeliveryTarget): DeliveryTarget {
  const value = exactObject(input, ['conversation', 'principal'], 'invalid-conversation')
  const conversation = canonicalConversation(value.conversation as ConversationRef)
  const principal = canonicalPrincipal(value.principal as ExternalPrincipalKey)
  if (
    conversation.channel !== principal.channel
    || conversation.account !== principal.account
    || conversation.tenant !== principal.tenant
  ) {
    throw new DeliveryValidationError('route-mismatch', 'principal and conversation namespaces do not match')
  }
  return { conversation, principal }
}
