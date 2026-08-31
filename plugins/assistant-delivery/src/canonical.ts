import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type {
  ConversationBinding,
  ConversationRef,
  DeliveryTarget,
  ExternalPrincipalKey,
  OwnerRouteAuthority,
  OwnerRouteBindingSnapshot,
} from './types.js'

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

/** Canonical identity for trusted local control-plane operators. */
export function canonicalLocalOperatorId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new DeliveryValidationError('invalid-identity', 'operatorId must be a string')
  }
  const normalized = input.normalize('NFC').trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > 256 || hasControl) {
    throw new DeliveryValidationError('invalid-identity', 'operatorId is invalid')
  }
  return normalized
}

/** Canonical identity for a trusted Host background source. */
export function canonicalBackgroundSourceId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new DeliveryValidationError('invalid-identity', 'background source id must be a string')
  }
  const normalized = input.normalize('NFC').trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > 256 || hasControl) {
    throw new DeliveryValidationError('invalid-identity', 'background source id is invalid')
  }
  return normalized
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

function ownerRouteText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new DeliveryValidationError('invalid-identity', `owner route ${field} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes || hasControl) {
    throw new DeliveryValidationError('invalid-identity', `owner route ${field} is invalid`)
  }
  return normalized
}

/** Canonicalize a Host-owned route authority without accepting hidden fields. */
export function canonicalOwnerRouteAuthority(input: OwnerRouteAuthority): OwnerRouteAuthority {
  const value = exactObject(input, [
    'id', 'conversation', 'principal', 'workspace', 'agentPreset', 'policyRef', 'minimumGeneration',
  ], 'invalid-identity')
  const id = ownerRouteText(value.id, 'id', 128)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(id)) {
    throw new DeliveryValidationError('invalid-identity', 'owner route id is invalid')
  }
  const target = canonicalTarget({
    conversation: value.conversation as ConversationRef,
    principal: value.principal as ExternalPrincipalKey,
  })
  const workspace = ownerRouteText(value.workspace, 'workspace', 4_096)
  if (!isAbsolute(workspace)) {
    throw new DeliveryValidationError('invalid-identity', 'owner route workspace must be absolute')
  }
  const agentPreset = ownerRouteText(value.agentPreset, 'agentPreset', 128)
  const policyRef = ownerRouteText(value.policyRef, 'policyRef', 256)
  if (!Number.isSafeInteger(value.minimumGeneration) || Number(value.minimumGeneration) < 1) {
    throw new DeliveryValidationError('invalid-identity', 'owner route minimumGeneration is invalid')
  }
  return {
    id,
    conversation: target.conversation,
    principal: target.principal,
    workspace,
    agentPreset,
    policyRef,
    minimumGeneration: Number(value.minimumGeneration),
  }
}

export function ownerRouteAuthorityHash(input: OwnerRouteAuthority): string {
  const authority = canonicalOwnerRouteAuthority(input)
  return createHash('sha256').update(JSON.stringify(authority)).digest('hex')
}

/** Exact lineage comparison. `status` and `version` are deliberately checked by the caller. */
export function bindingMatchesOwnerRoute(
  binding: Readonly<ConversationBinding>,
  input: Readonly<OwnerRouteAuthority>,
): boolean {
  const authority = canonicalOwnerRouteAuthority(input as OwnerRouteAuthority)
  return JSON.stringify(binding.conversation) === JSON.stringify(authority.conversation)
    && JSON.stringify(binding.principal) === JSON.stringify(authority.principal)
    && binding.workspace === authority.workspace
    && binding.agentPreset === authority.agentPreset
    && binding.policyRef === authority.policyRef
    && binding.generation >= authority.minimumGeneration
}

export function ownerRouteBindingSnapshot(
  authorityInput: Readonly<OwnerRouteAuthority>,
  binding: Readonly<ConversationBinding>,
): OwnerRouteBindingSnapshot {
  const authority = canonicalOwnerRouteAuthority(authorityInput as OwnerRouteAuthority)
  if (!bindingMatchesOwnerRoute(binding, authority)) {
    throw new DeliveryValidationError('route-mismatch', 'binding does not match owner route authority')
  }
  return {
    receiptVersion: 2,
    authorityId: authority.id,
    authorityHash: ownerRouteAuthorityHash(authority),
    bindingId: binding.id,
    bindingVersion: binding.version,
    generation: binding.generation,
    minimumGeneration: authority.minimumGeneration,
  }
}
