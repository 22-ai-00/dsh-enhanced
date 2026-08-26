import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { canonicalConversation, canonicalPrincipal, canonicalTarget } from './canonical.js'
import {
  isExactDeliveryCommand,
  isPermissionDeliveryCommand,
  parseDeliveryCommand,
  permissionDispatchRecoveryCode,
  permissionDispatchRecoveryFromFailureCode,
} from './session-commands.js'
import { openDeliveryDatabase } from './sqlite.js'
import type {
  ConversationBinding,
  ConversationModelSelection,
  ConversationRef,
  DeliveryAttachment,
  DeliveryPrincipal,
  DeliveryReceipt,
  ExternalPrincipalKey,
  InboundEnvelope,
  InboxRecord,
  OutboundIntent,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  OutboxRecord,
  PairingChallenge,
  PermissionPickerIntent,
} from './types.js'

export type DeliveryStoreErrorCode =
  | 'conflict'
  | 'idempotency-conflict'
  | 'invalid-binding'
  | 'invalid-envelope'
  | 'invalid-intent'
  | 'not-found'
  | 'pairing-expired'
  | 'pairing-invalid'
  | 'pairing-locked'
  | 'pairing-principal-mismatch'
  | 'pairing-replayed'
  | 'receipt-mismatch'
  | 'stale-fence'
  | 'unauthorized-principal'
  | 'version-conflict'

export class DeliveryStoreError extends Error {
  constructor(readonly code: DeliveryStoreErrorCode, message: string) {
    super(message)
    this.name = 'DeliveryStoreError'
  }
}

interface DeliveryStoreOptions {
  path: string
  now?: () => number
  codeGenerator?: () => string
  maxTextBytes?: number
}

type InboundDispatchBindingSnapshot = Pick<
  ConversationBinding,
  'conversation' | 'generation' | 'id' | 'principal' | 'sessionId' | 'version'
>

export interface ApprovalDispatchCursor {
  createdAt: number
  proposalId: string
}

export interface ApprovalDispatchCursorState {
  version: number
  after?: ApprovalDispatchCursor
}

interface PairingRow {
  id: string
  principal_json: string
  expires_at: number
  status: PairingChallenge['status']
  attempts: number
  created_at: number
}

interface PrincipalRow {
  id: string
  principal_json: string
  role: DeliveryPrincipal['role']
  status: DeliveryPrincipal['status']
  linked_to_id: string | null
  created_at: number
  updated_at: number
  version: number
}

interface BindingRow {
  id: string
  conversation_json: string
  principal_json: string
  workspace: string
  agent_preset: string
  session_id: string
  generation: number
  policy_ref: string
  status: ConversationBinding['status']
  created_at: number
  updated_at: number
  version: number
}

interface ModelSelectionRow {
  provider: string
  model: string
  reasoning_effort: string | null
  updated_at: number
  version: number
}

interface ModelPickerStateRow {
  binding_id: string
  revision: number
  provider: string
  model: string
  reasoning_effort: string | null
}

interface ModelSelectionSettlementRow {
  binding_id: string
  conversation_hash: string
  command_epoch: number
  payload_hash: string
  status: 'completed' | 'pending' | 'processing'
  result_json: string | null
  attempt_count: number
  claimed_by: string | null
  lease_until: number | null
}

interface ModelSelectionSettlementCompletionRow extends ModelSelectionSettlementRow {
  binding_status: ConversationBinding['status']
  principal_status: DeliveryPrincipal['status']
}

interface InboxRow {
  id: string
  channel: string
  account: string
  event_id: string
  envelope_hash: string
  envelope_json: string
  status: InboxRecord['status']
  binding_id: string | null
  attempt_count: number
  next_attempt_at: number | null
  claimed_by: string | null
  fencing_token: number | null
  lease_until: number | null
  failure_code: string | null
  received_at: number
  updated_at: number
}

interface OutboxRow {
  id: string
  intent_hash: string
  intent_json: string
  status: OutboxRecord['status']
  provider_message_id: string | null
  attempt_count: number
  next_attempt_at: number | null
  claimed_by: string | null
  fencing_token: number | null
  lease_until: number | null
  failure_code: string | null
  created_at: number
  updated_at: number
}

interface AttachmentRow {
  id: string
  owner_kind: 'inbox' | 'outbox'
  owner_id: string
  ordinal: number
  media_type: string
  size_bytes: number
  sha256: string
  spool_ref: string | null
  resource_kind: DeliveryAttachment['resourceType'] | null
  provider_ref: string | null
  file_name: string | null
  status: DeliveryAttachment['status']
  expires_at: number | null
  created_at: number
}

const imageMediaTypes = new Set<ImageMediaType>(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function invalidImageRef(): never {
  throw new DeliveryStoreError('conflict', 'inbound image reference is invalid')
}

function canonicalImageRef(input: unknown): ImageAttachmentRef {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidImageRef()
  const value = input as Record<string, unknown>
  const required = ['attachmentId', 'mediaType', 'bytes', 'width', 'height']
  if (required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => ![...required, 'name'].includes(key))
    || typeof value.attachmentId !== 'string'
    || value.attachmentId.length < 1 || value.attachmentId.length > 512
    || /\p{Cc}/u.test(value.attachmentId)
    || typeof value.mediaType !== 'string'
    || !imageMediaTypes.has(value.mediaType as ImageMediaType)
    || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 1
    || !Number.isSafeInteger(value.width) || (value.width as number) < 1
    || !Number.isSafeInteger(value.height) || (value.height as number) < 1
    || (value.name !== undefined && (typeof value.name !== 'string' || value.name.length < 1
      || value.name.length > 255 || value.name === '.' || value.name === '..' || /[\\/\p{Cc}]/u.test(value.name)))) {
    invalidImageRef()
  }
  return {
    attachmentId: value.attachmentId as ImageAttachmentRef['attachmentId'],
    mediaType: value.mediaType as ImageMediaType,
    bytes: value.bytes as number,
    width: value.width as number,
    height: value.height as number,
    ...(value.name === undefined ? {} : { name: value.name as string }),
  }
}

function persistedImageRef(row: AttachmentRow): ImageAttachmentRef {
  if (row.spool_ref === null || !/^[a-f0-9]{64}$/u.test(row.sha256)) invalidImageRef()
  let parsed: unknown
  try {
    parsed = JSON.parse(row.spool_ref)
  } catch {
    invalidImageRef()
  }
  const ref = canonicalImageRef(parsed)
  if (row.media_type !== ref.mediaType || row.size_bytes !== ref.bytes) invalidImageRef()
  return ref
}

function sameImageRef(left: ImageAttachmentRef, right: ImageAttachmentRef): boolean {
  return left.attachmentId === right.attachmentId
    && left.mediaType === right.mediaType
    && left.bytes === right.bytes
    && left.width === right.width
    && left.height === right.height
    && left.name === right.name
}

function attachmentFromRow(row: AttachmentRow): DeliveryAttachment {
  const imageRef = row.status === 'ready' && row.resource_kind === 'image'
    ? persistedImageRef(row)
    : undefined
  return {
    id: row.id,
    ownerKind: row.owner_kind,
    ownerId: row.owner_id,
    resourceType: row.resource_kind ?? 'file',
    providerRef: row.provider_ref ?? '',
    ...(row.file_name === null ? {} : { fileName: row.file_name }),
    ...(row.media_type === '' ? {} : { mediaType: row.media_type }),
    ...(row.status === 'metadata' && row.size_bytes === 0 ? {} : { sizeBytes: row.size_bytes }),
    ...(row.status === 'metadata' ? {} : { contentSha256: row.sha256 }),
    ...(imageRef === undefined ? {} : { imageRef }),
    status: row.status,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    createdAt: row.created_at,
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function principalJson(principal: ExternalPrincipalKey): string {
  return JSON.stringify(canonicalPrincipal(principal))
}

function principalHash(principal: ExternalPrincipalKey): string {
  return digest(principalJson(principal))
}

function conversationJson(conversation: ConversationRef): string {
  return JSON.stringify(canonicalConversation(conversation))
}

function conversationHash(conversation: ConversationRef): string {
  return digest(conversationJson(conversation))
}

function modelRoutePart(value: string, field: 'effort' | 'model' | 'provider'): string {
  const normalized = value.trim()
  const valid = field === 'provider'
    ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(normalized)
    : normalized.length <= (field === 'effort' ? 128 : 512) && !/[\s\p{Cc}]/u.test(normalized)
  if (!valid) throw new DeliveryStoreError('invalid-binding', `${field} is invalid`)
  return normalized
}

function canonicalModelPickerState(input: ModelPickerState): ModelPickerState {
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) {
    throw new DeliveryStoreError('invalid-binding', 'model picker revision is invalid')
  }
  const provider = modelRoutePart(input.provider, 'provider')
  const model = modelRoutePart(input.model, 'model')
  const reasoningEffort = input.reasoningEffort === undefined
    ? undefined
    : modelRoutePart(input.reasoningEffort, 'effort')
  return { revision: input.revision, provider, model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}

function canonicalModelRoute(input: ModelRouteRef): ModelRouteRef {
  const state = canonicalModelPickerState({ ...input, revision: 0 })
  return { provider: state.provider, model: state.model,
    ...(state.reasoningEffort === undefined ? {} : { reasoningEffort: state.reasoningEffort }) }
}

function modelPickerStateFromRow(row: ModelPickerStateRow): ModelPickerState {
  return { revision: row.revision, provider: row.provider, model: row.model,
    ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }) }
}

function sameModelPickerState(left: ModelPickerState, right: ModelPickerState): boolean {
  return left.revision === right.revision && left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function pairingFromRow(row: PairingRow): PairingChallenge {
  return {
    id: row.id,
    principal: JSON.parse(row.principal_json) as ExternalPrincipalKey,
    expiresAt: row.expires_at,
    status: row.status,
    attempts: row.attempts,
    createdAt: row.created_at,
  }
}

function principalFromRow(row: PrincipalRow): DeliveryPrincipal {
  return {
    id: row.id,
    principal: JSON.parse(row.principal_json) as ExternalPrincipalKey,
    role: row.role,
    status: row.status,
    ...(row.linked_to_id === null ? {} : { linkedToId: row.linked_to_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

function bindingFromRow(row: BindingRow): ConversationBinding {
  return {
    id: row.id,
    conversation: JSON.parse(row.conversation_json) as ConversationRef,
    principal: JSON.parse(row.principal_json) as ExternalPrincipalKey,
    workspace: row.workspace,
    agentPreset: row.agent_preset,
    sessionId: row.session_id,
    generation: row.generation,
    policyRef: row.policy_ref,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  }
}

const bindingSelect = `
  SELECT id, conversation_json, principal_json, workspace, agent_preset, session_id,
    generation, policy_ref, status, created_at, updated_at, version
  FROM conversation_bindings
`

const inboxSelect = `
  SELECT id, channel, account, event_id, envelope_hash, envelope_json, status, binding_id,
    attempt_count, next_attempt_at, claimed_by, fencing_token, lease_until, failure_code,
    received_at, updated_at
  FROM inbox_messages
`

const outboxSelect = `
  SELECT id, intent_hash, intent_json, status, provider_message_id, attempt_count,
    next_attempt_at, claimed_by, fencing_token, lease_until, failure_code, created_at, updated_at
  FROM outbox_messages
`

function validateBindingText(value: string, field: string, max: number): string {
  const normalized = value.trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || normalized.length > max || hasControl) {
    throw new DeliveryStoreError('invalid-binding', `${field} is invalid`)
  }
  return normalized
}

function boundedMaintenanceLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DeliveryStoreError('conflict', `invalid ${label} maintenance limit`)
  }
  return limit
}

function inboxFromRow(row: InboxRow): InboxRecord {
  return {
    id: row.id,
    channel: row.channel,
    account: row.account,
    eventId: row.event_id,
    envelope: JSON.parse(row.envelope_json) as InboundEnvelope,
    envelopeHash: row.envelope_hash,
    status: row.status,
    ...(row.binding_id === null ? {} : { bindingId: row.binding_id }),
    attemptCount: row.attempt_count,
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.fencing_token === null ? {} : { fencingToken: row.fencing_token }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
  }
}

function outboxFromRow(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    intent: JSON.parse(row.intent_json) as OutboundIntent,
    intentHash: row.intent_hash,
    status: row.status,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    attemptCount: row.attempt_count,
    ...(row.next_attempt_at === null ? {} : { nextAttemptAt: row.next_attempt_at }),
    ...(row.claimed_by === null ? {} : { claimedBy: row.claimed_by }),
    ...(row.fencing_token === null ? {} : { fencingToken: row.fencing_token }),
    ...(row.lease_until === null ? {} : { leaseUntil: row.lease_until }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function invalidEnvelope(message: string): never {
  throw new DeliveryStoreError('invalid-envelope', message)
}

function canonicalEnvelope(input: InboundEnvelope, maxTextBytes: number): InboundEnvelope {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalidEnvelope('inbound envelope must be an object')
  const allowed = ['channel', 'account', 'eventId', 'occurredAt', 'principal', 'conversation', 'kind', 'text', 'metadata', 'attachments']
  if (Object.keys(input).some(key => !allowed.includes(key))) invalidEnvelope('inbound envelope contains an unknown field')
  const principal = canonicalPrincipal(input.principal)
  const conversation = canonicalConversation(input.conversation)
  let channel: string
  let account: string
  let eventId: string
  try {
    channel = validateBindingText(input.channel, 'channel', 256)
    account = validateBindingText(input.account, 'account', 256)
    eventId = validateBindingText(input.eventId, 'eventId', 512)
  } catch {
    invalidEnvelope('inbound routing identifier is invalid')
  }
  if (
    channel !== principal.channel || channel !== conversation.channel
    || account !== principal.account || account !== conversation.account
    || principal.tenant !== conversation.tenant
  ) invalidEnvelope('inbound envelope routing namespaces do not match')
  if (!Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) invalidEnvelope('occurredAt is invalid')
  if (input.kind !== 'command' && input.kind !== 'text') invalidEnvelope('inbound kind is invalid')
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > maxTextBytes) {
    invalidEnvelope('inbound text exceeds its byte budget')
  }
  let metadata: Record<string, string> | undefined
  if (input.metadata !== undefined) {
    const entries = Object.entries(input.metadata)
    if (entries.length > 16) invalidEnvelope('inbound metadata has too many entries')
    metadata = {}
    for (const [metadataKey, value] of entries) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(metadataKey) || typeof value !== 'string' || value.length > 256) {
        invalidEnvelope('inbound metadata is invalid')
      }
      metadata[metadataKey] = value
    }
  }
  let attachments: InboundEnvelope['attachments']
  if (input.attachments !== undefined) {
    if (!Array.isArray(input.attachments) || input.attachments.length > 10) {
      invalidEnvelope('inbound attachments exceed the descriptor budget')
    }
    attachments = input.attachments.map(item => {
      if (item === null || typeof item !== 'object' || Array.isArray(item)
        || Object.keys(item).some(field => !['resourceType', 'providerRef', 'fileName', 'mediaType', 'sizeBytes'].includes(field))) {
        invalidEnvelope('inbound attachment descriptor shape is invalid')
      }
      if (!['audio', 'file', 'image', 'sticker', 'video'].includes(item.resourceType)) {
        invalidEnvelope('inbound attachment resource type is invalid')
      }
      if (typeof item.providerRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,511}$/u.test(item.providerRef)) {
        invalidEnvelope('inbound attachment provider reference is invalid')
      }
      if (item.fileName !== undefined && (typeof item.fileName !== 'string' || item.fileName.length > 255
        || item.fileName === '.' || item.fileName === '..' || /[\\/\p{Cc}]/u.test(item.fileName))) {
        invalidEnvelope('inbound attachment file name is invalid')
      }
      if (item.mediaType !== undefined && (typeof item.mediaType !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/u.test(item.mediaType))) {
        invalidEnvelope('inbound attachment media type is invalid')
      }
      if (item.sizeBytes !== undefined && (!Number.isSafeInteger(item.sizeBytes)
        || item.sizeBytes < 0 || item.sizeBytes > 100 * 1024 * 1024)) {
        invalidEnvelope('inbound attachment size is invalid')
      }
      return {
        resourceType: item.resourceType,
        providerRef: item.providerRef,
        ...(item.fileName === undefined ? {} : { fileName: item.fileName }),
        ...(item.mediaType === undefined ? {} : { mediaType: item.mediaType }),
        ...(item.sizeBytes === undefined ? {} : { sizeBytes: item.sizeBytes }),
      }
    })
  }
  return {
    channel,
    account,
    eventId,
    occurredAt: input.occurredAt,
    principal,
    conversation,
    kind: input.kind,
    text: input.text,
    ...(metadata === undefined ? {} : { metadata }),
    ...(attachments === undefined ? {} : { attachments }),
  }
}

function canonicalMetadata(input: Readonly<Record<string, string>> | undefined, kind: 'intent' | 'receipt'):
Record<string, string> | undefined {
  if (input === undefined) return undefined
  const entries = Object.entries(input)
  if (entries.length > 16) {
    throw new DeliveryStoreError(kind === 'intent' ? 'invalid-intent' : 'receipt-mismatch', `${kind} metadata has too many entries`)
  }
  const output: Record<string, string> = {}
  for (const [metadataKey, value] of entries) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(metadataKey) || typeof value !== 'string' || value.length > 256) {
      throw new DeliveryStoreError(kind === 'intent' ? 'invalid-intent' : 'receipt-mismatch', `${kind} metadata is invalid`)
    }
    output[metadataKey] = value
  }
  return output
}

function canonicalIntent(input: OutboundIntent, binding: ConversationBinding, maxTextBytes: number): OutboundIntent {
  const allowed = [
    'idempotencyKey', 'bindingId', 'target', 'text', 'format', 'approval', 'modelPicker', 'permissionPicker',
    'replyToEventId', 'metadata',
  ]
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
    throw new DeliveryStoreError('invalid-intent', 'outbound intent shape is invalid')
  }
  let idempotencyKey: string
  let bindingId: string
  try {
    idempotencyKey = validateBindingText(input.idempotencyKey, 'idempotencyKey', 512)
    bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
  } catch {
    throw new DeliveryStoreError('invalid-intent', 'outbound intent identifier is invalid')
  }
  if (bindingId !== binding.id) throw new DeliveryStoreError('invalid-intent', 'outbound intent binding does not exist')
  const target = canonicalTarget(input.target)
  if (
    conversationHash(target.conversation) !== conversationHash(binding.conversation)
    || principalHash(target.principal) !== principalHash(binding.principal)
  ) throw new DeliveryStoreError('invalid-intent', 'outbound target does not match its binding')
  if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > maxTextBytes) {
    throw new DeliveryStoreError('invalid-intent', 'outbound text exceeds its byte budget')
  }
  const format = input.format ?? 'plain'
  if (format !== 'plain' && format !== 'markdown' && format !== 'approval' && format !== 'model-picker'
    && format !== 'permission-picker') {
    throw new DeliveryStoreError('invalid-intent', 'outbound format is invalid')
  }
  let approval: OutboundIntent['approval']
  if (format === 'approval') {
    const value = input.approval
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => ![
        'operationId', 'proposalId', 'expectedVersion', 'expiresAt', 'title', 'diffHash',
      ].includes(field)) || Object.keys(value).length !== 6) {
      throw new DeliveryStoreError('invalid-intent', 'approval intent shape is invalid')
    }
    let operationId: string
    let proposalId: string
    let title: string
    try {
      operationId = validateBindingText(value.operationId, 'operationId', 256)
      proposalId = validateBindingText(value.proposalId, 'proposalId', 256)
      title = validateBindingText(value.title, 'title', 120)
    } catch {
      throw new DeliveryStoreError('invalid-intent', 'approval intent text is invalid')
    }
    if (!Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1
      || typeof value.diffHash !== 'string' || !/^[a-f0-9]{64}$/u.test(value.diffHash)) {
      throw new DeliveryStoreError('invalid-intent', 'approval intent version or expiry is invalid')
    }
    approval = { operationId, proposalId, expectedVersion: value.expectedVersion,
      expiresAt: value.expiresAt, title, diffHash: value.diffHash }
  } else if (input.approval !== undefined) {
    throw new DeliveryStoreError('invalid-intent', 'approval payload requires approval format')
  }
  let modelPicker: ModelPickerIntent | undefined
  if (format === 'model-picker') {
    modelPicker = canonicalModelPicker(input.modelPicker)
  } else if (input.modelPicker !== undefined) {
    throw new DeliveryStoreError('invalid-intent', 'model picker payload requires model-picker format')
  }
  let permissionPicker: PermissionPickerIntent | undefined
  if (format === 'permission-picker') {
    permissionPicker = canonicalPermissionPicker(input.permissionPicker, binding)
  } else if (input.permissionPicker !== undefined) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker payload requires permission-picker format')
  }
  let replyToEventId: string | undefined
  if (input.replyToEventId !== undefined) {
    try {
      replyToEventId = validateBindingText(input.replyToEventId, 'replyToEventId', 512)
    } catch {
      throw new DeliveryStoreError('invalid-intent', 'reply event id is invalid')
    }
  }
  const metadata = canonicalMetadata(input.metadata, 'intent')
  return { idempotencyKey, bindingId, target, text: input.text, format,
    ...(approval === undefined ? {} : { approval }),
    ...(modelPicker === undefined ? {} : { modelPicker }),
    ...(permissionPicker === undefined ? {} : { permissionPicker }),
    ...(replyToEventId === undefined ? {} : { replyToEventId }),
    ...(metadata === undefined ? {} : { metadata }) }
}

function canonicalPermissionPicker(
  input: PermissionPickerIntent | undefined,
  binding: ConversationBinding,
): PermissionPickerIntent {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => ![
      'operationId', 'issuedAt', 'expiresAt', 'current', 'expectedStateHash', 'emergencyStopVersion',
      'bindingVersion', 'sessionId',
    ].includes(field)) || Object.keys(input).length !== 8) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker intent shape is invalid')
  }
  let operationId: string
  let sessionId: string
  try {
    operationId = validateBindingText(input.operationId, 'operationId', 256)
    sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
  } catch {
    throw new DeliveryStoreError('invalid-intent', 'permission picker identifier is invalid')
  }
  if (!Number.isSafeInteger(input.issuedAt) || input.issuedAt < 1
    || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1
    || input.issuedAt >= input.expiresAt) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker lifetime is invalid')
  }
  if (input.current !== 'ask' && input.current !== 'auto' && input.current !== 'full' && input.current !== 'custom') {
    throw new DeliveryStoreError('invalid-intent', 'permission picker current level is invalid')
  }
  if (typeof input.expectedStateHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.expectedStateHash)) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker state hash is invalid')
  }
  if (!Number.isSafeInteger(input.emergencyStopVersion) || input.emergencyStopVersion < 0) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker emergency-stop version is invalid')
  }
  if (!Number.isSafeInteger(input.bindingVersion) || input.bindingVersion < 1
    || input.bindingVersion !== binding.version || sessionId !== binding.sessionId) {
    throw new DeliveryStoreError('invalid-intent', 'permission picker binding snapshot is invalid')
  }
  return {
    operationId,
    issuedAt: input.issuedAt,
    expiresAt: input.expiresAt,
    current: input.current,
    expectedStateHash: input.expectedStateHash,
    emergencyStopVersion: input.emergencyStopVersion,
    bindingVersion: input.bindingVersion,
    sessionId,
  }
}

function canonicalModelPicker(input: ModelPickerIntent | undefined): ModelPickerIntent {
  if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => ![
      'operationId', 'expiresAt', 'current', 'providers', 'models', 'efforts',
    ].includes(field)) || Object.keys(input).length !== 6) {
    throw new DeliveryStoreError('invalid-intent', 'model picker intent shape is invalid')
  }
  const operationId = validateBindingText(input.operationId, 'operationId', 256)
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 1) {
    throw new DeliveryStoreError('invalid-intent', 'model picker expiry is invalid')
  }
  const current = canonicalPickerRoute(input.current)
  if (!Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 20
    || !Array.isArray(input.models) || input.models.length < 1 || input.models.length > 50
    || !Array.isArray(input.efforts) || input.efforts.length > 20) {
    throw new DeliveryStoreError('invalid-intent', 'model picker option budget is invalid')
  }
  const providers = input.providers.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || Object.keys(entry).some(field => !['id', 'name'].includes(field))) {
      throw new DeliveryStoreError('invalid-intent', 'model picker provider is invalid')
    }
    return { id: modelRoutePart(entry.id, 'provider'), name: validateBindingText(entry.name, 'provider.name', 120) }
  })
  if (new Set(providers.map(entry => entry.id)).size !== providers.length) {
    throw new DeliveryStoreError('invalid-intent', 'model picker providers contain duplicates')
  }
  const efforts = input.efforts.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 2 || Object.keys(entry).some(field => !['id', 'name'].includes(field))) {
      throw new DeliveryStoreError('invalid-intent', 'model picker effort is invalid')
    }
    return { id: modelRoutePart(entry.id, 'effort'), name: validateBindingText(entry.name, 'effort.name', 120) }
  })
  if (new Set(efforts.map(entry => entry.id)).size !== efforts.length) {
    throw new DeliveryStoreError('invalid-intent', 'model picker efforts contain duplicates')
  }
  const effortIds = new Set(efforts.map(entry => entry.id))
  const providerIds = new Set(providers.map(entry => entry.id))
  const models = input.models.map(entry => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).length !== 4
      || Object.keys(entry).some(field => !['provider', 'id', 'name', 'effortIds'].includes(field))
      || !Array.isArray(entry.effortIds) || entry.effortIds.length > 20) {
      throw new DeliveryStoreError('invalid-intent', 'model picker model is invalid')
    }
    const provider = modelRoutePart(entry.provider, 'provider')
    if (!providerIds.has(provider)) throw new DeliveryStoreError('invalid-intent', 'model picker model provider is missing')
    const linkedEfforts: string[] = entry.effortIds.map((id: unknown) => {
      if (typeof id !== 'string') throw new DeliveryStoreError('invalid-intent', 'model picker model effort is invalid')
      return modelRoutePart(id, 'effort')
    })
    if (new Set(linkedEfforts).size !== linkedEfforts.length
      || linkedEfforts.some((id: string) => !effortIds.has(id))) {
      throw new DeliveryStoreError('invalid-intent', 'model picker model efforts are invalid')
    }
    return { provider, id: modelRoutePart(entry.id, 'model'),
      name: validateBindingText(entry.name, 'model.name', 120), effortIds: linkedEfforts }
  })
  if (new Set(models.map(entry => `${entry.provider}\0${entry.id}`)).size !== models.length) {
    throw new DeliveryStoreError('invalid-intent', 'model picker models contain duplicates')
  }
  return { operationId, expiresAt: input.expiresAt, current, providers, models, efforts }
}

function canonicalPickerRoute(input: ModelPickerIntent['current']): ModelPickerIntent['current'] {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(field => !['provider', 'model', 'reasoningEffort'].includes(field))) {
    throw new DeliveryStoreError('invalid-intent', 'model picker current route is invalid')
  }
  return {
    provider: modelRoutePart(input.provider, 'provider'),
    model: modelRoutePart(input.model, 'model'),
    ...(input.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: modelRoutePart(input.reasoningEffort, 'effort') }),
  }
}

function getPairingStatement(database: DatabaseSync): StatementSync {
  return database.prepare(`
    SELECT id, principal_json, expires_at, status, attempts, created_at
    FROM pairing_challenges WHERE id = ?
  `)
}

export class DeliveryStore {
  private readonly database: DatabaseSync
  private readonly databaseInstanceId: string
  private readonly now: () => number
  private readonly codeGenerator: () => string
  private readonly maxTextBytes: number
  private closed = false

  constructor(options: DeliveryStoreOptions) {
    this.database = openDeliveryDatabase(options.path)
    this.now = options.now ?? Date.now
    this.codeGenerator = options.codeGenerator ?? (() => randomBytes(5).toString('hex').toUpperCase())
    this.maxTextBytes = options.maxTextBytes ?? 65_536
    const instance = this.database.prepare(`
      SELECT instance_id FROM delivery_instance WHERE singleton = 1
    `).get() as { instance_id: string } | undefined
    if (instance === undefined || !/^[0-9a-f]{32}$/u.test(instance.instance_id)) {
      this.database.close()
      this.closed = true
      throw new DeliveryStoreError('conflict', 'delivery database instance namespace is missing or invalid')
    }
    this.databaseInstanceId = instance.instance_id
  }

  instanceId(): string {
    this.assertOpen()
    return this.databaseInstanceId
  }

  issuePairing(
    input: ExternalPrincipalKey,
    options: { ttlMs: number; maxAttempts: number },
  ): { challenge: PairingChallenge; code: string } {
    this.assertOpen()
    const principal = canonicalPrincipal(input)
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 86_400_000) {
      throw new DeliveryStoreError('conflict', 'pairing ttl must be between 1 ms and 24 hours')
    }
    if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 10) {
      throw new DeliveryStoreError('conflict', 'pairing maxAttempts must be between 1 and 10')
    }
    const code = this.codeGenerator()
    if (!/^[A-Z0-9]{8,32}$/u.test(code)) throw new DeliveryStoreError('conflict', 'pairing generator returned an invalid code')
    const now = this.now()
    const json = principalJson(principal)
    const hash = digest(json)
    const salt = randomBytes(16).toString('hex')
    const codeHash = scryptSync(code, salt, 32).toString('hex')
    const id = `pair_${randomUUID()}`
    this.transaction(() => {
      this.database.prepare(`
        UPDATE pairing_challenges SET status = 'expired', updated_at = ?
        WHERE principal_hash = ? AND status = 'active'
      `).run(now, hash)
      this.database.prepare(`
        INSERT INTO pairing_challenges (
          id, principal_hash, principal_json, code_salt, code_hash, status, attempts, max_attempts,
          expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)
      `).run(id, hash, json, salt, codeHash, options.maxAttempts, now + options.ttlMs, now, now)
    })
    return { challenge: pairingFromRow(getPairingStatement(this.database).get(id) as unknown as PairingRow), code }
  }

  confirmPairing(input: {
    challengeId: string
    principal: ExternalPrincipalKey
    code: string
  }): DeliveryPrincipal {
    this.assertOpen()
    const principal = canonicalPrincipal(input.principal)
    const json = principalJson(principal)
    const hash = digest(json)
    const now = this.now()
    let result: DeliveryPrincipal | undefined
    let failure: DeliveryStoreError | undefined
    this.transaction(() => {
      const row = this.database.prepare(`
        SELECT id, principal_hash, principal_json, code_salt, code_hash, status, attempts,
          max_attempts, expires_at, created_at, updated_at
        FROM pairing_challenges WHERE id = ?
      `).get(input.challengeId) as {
        id: string; principal_hash: string; principal_json: string; code_salt: string; code_hash: string
        status: PairingChallenge['status']; attempts: number; max_attempts: number; expires_at: number
        created_at: number; updated_at: number
      } | undefined
      if (row === undefined) {
        failure = new DeliveryStoreError('not-found', 'pairing challenge was not found')
        return
      }
      if (row.status === 'consumed') {
        failure = new DeliveryStoreError('pairing-replayed', 'pairing challenge was already consumed')
        return
      }
      if (row.status === 'locked') {
        failure = new DeliveryStoreError('pairing-locked', 'pairing challenge is locked')
        return
      }
      if (row.status === 'expired' || now >= row.expires_at) {
        this.database.prepare("UPDATE pairing_challenges SET status = 'expired', updated_at = ? WHERE id = ?")
          .run(now, row.id)
        failure = new DeliveryStoreError('pairing-expired', 'pairing challenge expired')
        return
      }
      const suppliedPrincipalHash = Buffer.from(hash, 'hex')
      const expectedPrincipalHash = Buffer.from(row.principal_hash, 'hex')
      if (
        suppliedPrincipalHash.length !== expectedPrincipalHash.length
        || !timingSafeEqual(suppliedPrincipalHash, expectedPrincipalHash)
      ) {
        failure = new DeliveryStoreError('pairing-principal-mismatch', 'pairing challenge belongs to another principal')
        return
      }
      const suppliedCodeHash = scryptSync(input.code, row.code_salt, 32)
      const expectedCodeHash = Buffer.from(row.code_hash, 'hex')
      if (suppliedCodeHash.length !== expectedCodeHash.length || !timingSafeEqual(suppliedCodeHash, expectedCodeHash)) {
        const attempts = row.attempts + 1
        const locked = attempts >= row.max_attempts
        this.database.prepare('UPDATE pairing_challenges SET attempts = ?, status = ?, updated_at = ? WHERE id = ?')
          .run(attempts, locked ? 'locked' : 'active', now, row.id)
        failure = new DeliveryStoreError(locked ? 'pairing-locked' : 'pairing-invalid', locked
          ? 'pairing challenge locked after too many attempts'
          : 'pairing code is invalid')
        return
      }
      const existing = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals WHERE key_hash = ?
      `).get(hash) as PrincipalRow | undefined
      if (existing === undefined) {
        const count = (this.database.prepare("SELECT COUNT(*) AS count FROM delivery_principals WHERE role = 'owner' AND status = 'active'")
          .get() as { count: number }).count
        const id = `principal_${randomUUID()}`
        this.database.prepare(`
          INSERT INTO delivery_principals (
            id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, 'active', NULL, ?, ?, 1)
        `).run(id, hash, json, count === 0 ? 'owner' : 'linked', now, now)
        result = principalFromRow(this.database.prepare(`
          SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
          FROM delivery_principals WHERE id = ?
        `).get(id) as unknown as PrincipalRow)
      } else {
        const anotherOwner = existing.role === 'owner' && existing.status === 'revoked'
          ? this.database.prepare(`
            SELECT id FROM delivery_principals
            WHERE role = 'owner' AND status = 'active' AND id <> ? LIMIT 1
          `).get(existing.id) as { id: string } | undefined
          : undefined
        const linkedOwner = existing.role === 'linked'
          && existing.status === 'revoked'
          && existing.linked_to_id !== null
          ? this.database.prepare(`
            SELECT id FROM delivery_principals
            WHERE id = ? AND role = 'owner' AND status = 'active'
          `).get(existing.linked_to_id) as { id: string } | undefined
          : undefined
        const retiredLink = existing.role === 'linked'
          && existing.status === 'revoked'
          && linkedOwner === undefined
        if (anotherOwner !== undefined || retiredLink) {
          // A trusted local handoff is the only operation allowed to rotate
          // owner authority. A linked identity may only be reactivated while
          // its explicit root is still the active owner. Consuming this
          // otherwise-valid challenge prevents replay without restoring stale
          // authority from a retired owner or legacy orphan.
          failure = new DeliveryStoreError(
            'unauthorized-principal',
            retiredLink
              ? 'ordinary pairing cannot reactivate a link without its active owner'
              : 'ordinary pairing cannot reactivate a former owner while another owner is active',
          )
        } else {
          this.database.prepare(`
            UPDATE delivery_principals SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?
          `).run(now, existing.id)
          result = principalFromRow(this.database.prepare(`
            SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
            FROM delivery_principals WHERE id = ?
          `).get(existing.id) as unknown as PrincipalRow)
        }
      }
      this.database.prepare("UPDATE pairing_challenges SET status = 'consumed', updated_at = ? WHERE id = ?")
        .run(now, row.id)
    })
    if (failure !== undefined) throw failure
    if (result === undefined) throw new DeliveryStoreError('conflict', 'pairing transaction produced no principal')
    return result
  }

  /**
   * Trusted local owner rotation. Unlike an ordinary pairing, this promotes
   * the exact replacement principal and retires every previous active owner in
   * one SQLite transaction, so setup can never leave two active owners or turn
   * the newly discovered owner into a merely linked identity.
   */
  handoffOwner(input: ExternalPrincipalKey): DeliveryPrincipal {
    this.assertOpen()
    const principal = canonicalPrincipal(input)
    const json = principalJson(principal)
    const hash = digest(json)
    const now = this.now()
    return this.transaction(() => {
      let replacement = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals WHERE key_hash = ? AND principal_json = ?
      `).get(hash, json) as PrincipalRow | undefined
      const activeOwners = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals WHERE role = 'owner' AND status = 'active'
      `).all() as unknown as PrincipalRow[]

      if (replacement === undefined) {
        const id = `principal_${randomUUID()}`
        this.database.prepare(`
          INSERT INTO delivery_principals (
            id, key_hash, principal_json, role, status, linked_to_id, created_at, updated_at, version
          ) VALUES (?, ?, ?, 'owner', 'active', NULL, ?, ?, 1)
        `).run(id, hash, json, now, now)
        replacement = this.database.prepare(`
          SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
          FROM delivery_principals WHERE id = ?
        `).get(id) as unknown as PrincipalRow
      } else if (replacement.role !== 'owner'
        || replacement.status !== 'active'
        || replacement.linked_to_id !== null) {
        this.database.prepare(`
          UPDATE delivery_principals
          SET role = 'owner', status = 'active', linked_to_id = NULL, updated_at = ?, version = version + 1
          WHERE id = ?
        `).run(now, replacement.id)
      }

      // Revoke every linked identity not explicitly rooted in the replacement.
      // This covers both legacy NULL orphans and identities whose former owner
      // was revoked before the handoff. Exclude the replacement (which may
      // itself have arrived as an orphan) before promoting it above.
      this.database.prepare(`
        UPDATE conversation_bindings
        SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE status = 'active' AND principal_id IN (
          SELECT id FROM delivery_principals
          WHERE role = 'linked' AND status = 'active' AND id <> ?
            AND (linked_to_id IS NULL OR linked_to_id <> ?)
        )
      `).run(now, replacement.id, replacement.id)
      this.database.prepare(`
        UPDATE delivery_principals
        SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE role = 'linked' AND status = 'active' AND id <> ?
          AND (linked_to_id IS NULL OR linked_to_id <> ?)
      `).run(now, replacement.id, replacement.id)

      for (const owner of activeOwners) {
        if (owner.id === replacement.id) continue
        this.database.prepare(`
          UPDATE delivery_principals
          SET status = 'revoked', updated_at = ?, version = version + 1
          WHERE id = ? AND role = 'owner' AND status = 'active'
        `).run(now, owner.id)
        this.database.prepare(`
          UPDATE conversation_bindings
          SET status = 'revoked', updated_at = ?, version = version + 1
          WHERE principal_id = ? AND status = 'active'
        `).run(now, owner.id)
      }
      // A challenge issued before the handoff must not be able to reactivate a
      // retired owner after setup has returned successfully.
      this.database.prepare(`
        UPDATE pairing_challenges SET status = 'expired', updated_at = ? WHERE status = 'active'
      `).run(now)
      const result = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals WHERE id = ?
      `).get(replacement.id) as unknown as PrincipalRow
      return principalFromRow(result)
    })
  }

  isAuthorizedPrincipal(input: ExternalPrincipalKey): boolean {
    this.assertOpen()
    const row = this.database.prepare('SELECT status FROM delivery_principals WHERE key_hash = ?')
      .get(principalHash(input)) as { status: DeliveryPrincipal['status'] } | undefined
    return row?.status === 'active'
  }

  getPrincipal(input: ExternalPrincipalKey): DeliveryPrincipal | undefined {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
      FROM delivery_principals WHERE key_hash = ?
    `).get(principalHash(input)) as PrincipalRow | undefined
    return row === undefined ? undefined : principalFromRow(row)
  }

  createBinding(input: {
    conversation: ConversationRef
    principal: ExternalPrincipalKey
    workspace: string
    agentPreset: string
    sessionId: string
    policyRef: string
    expectedGeneration?: number
  }): ConversationBinding {
    this.assertOpen()
    const target = canonicalTarget({ conversation: input.conversation, principal: input.principal })
    if (!isAbsolute(input.workspace)) throw new DeliveryStoreError('invalid-binding', 'binding workspace must be absolute')
    const workspace = validateBindingText(input.workspace, 'workspace', 4_096)
    const agentPreset = validateBindingText(input.agentPreset, 'agentPreset', 128)
    const sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
    const policyRef = validateBindingText(input.policyRef, 'policyRef', 256)
    if (input.expectedGeneration !== undefined
      && (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1)) {
      throw new DeliveryStoreError('invalid-binding', 'binding expectedGeneration is invalid')
    }
    const hash = conversationHash(target.conversation)
    const canonicalConversationJson = conversationJson(target.conversation)
    const canonicalPrincipalJson = principalJson(target.principal)
    const canonicalPrincipalHash = principalHash(target.principal)
    const now = this.now()
    const id = `binding_${randomUUID()}`
    return this.transaction(() => {
      const principalRow = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals
        WHERE key_hash = ? AND principal_json = ? AND status = 'active'
      `).get(canonicalPrincipalHash, canonicalPrincipalJson) as PrincipalRow | undefined
      if (principalRow === undefined) {
        throw new DeliveryStoreError('unauthorized-principal', 'binding principal is not active')
      }
      const principal = principalFromRow(principalRow)
      const existingRow = this.database.prepare(`
        ${bindingSelect}
        WHERE conversation_hash = ? AND conversation_json = ? AND status = 'active'
      `).get(hash, canonicalConversationJson) as BindingRow | undefined
      if (existingRow !== undefined) {
        const existing = bindingFromRow(existingRow)
        if (principalHash(existing.principal) !== canonicalPrincipalHash) {
          throw new DeliveryStoreError('conflict', 'conversation is already bound to another principal')
        }
        if (input.expectedGeneration !== undefined && existing.generation !== input.expectedGeneration) {
          throw new DeliveryStoreError('version-conflict', 'binding generation changed before creation')
        }
        return existing
      }
      const generation = this.nextBindingGenerationByHash(hash)
      if (input.expectedGeneration !== undefined && generation !== input.expectedGeneration) {
        throw new DeliveryStoreError('version-conflict', 'binding generation changed before creation')
      }
      this.database.prepare(`
        INSERT INTO conversation_bindings (
          id, conversation_hash, conversation_json, principal_id, principal_json, workspace, agent_preset,
          session_id, generation, policy_ref, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(
        id,
        hash,
        canonicalConversationJson,
        principal.id,
        canonicalPrincipalJson,
        workspace,
        agentPreset,
        sessionId,
        generation,
        policyRef,
        now,
        now,
      )
      return this.getBinding(id)!
    })
  }

  /**
   * Snapshot the generation a newly-created session must use.  `createBinding`
   * revalidates this value under `BEGIN IMMEDIATE` when passed as
   * `expectedGeneration`, so a concurrent generation change fails closed.
   */
  nextBindingGeneration(input: ConversationRef): number {
    this.assertOpen()
    return this.nextBindingGenerationByHash(conversationHash(canonicalConversation(input)))
  }

  getActiveBinding(input: ConversationRef): ConversationBinding | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${bindingSelect} WHERE conversation_hash = ? AND status = 'active'`)
      .get(conversationHash(input)) as BindingRow | undefined
    return row === undefined ? undefined : bindingFromRow(row)
  }

  getBinding(id: string): ConversationBinding | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${bindingSelect} WHERE id = ?`).get(id) as BindingRow | undefined
    return row === undefined ? undefined : bindingFromRow(row)
  }

  listBindings(input: ConversationRef): ConversationBinding[] {
    this.assertOpen()
    return (this.database.prepare(`${bindingSelect} WHERE conversation_hash = ? ORDER BY generation DESC`)
      .all(conversationHash(input)) as unknown as BindingRow[]).map(bindingFromRow)
  }

  /** Read-only operator query.  Callers must apply their own exact route checks. */
  listActiveBindings(): ConversationBinding[] {
    this.assertOpen()
    return (this.database.prepare(`${bindingSelect} WHERE status = 'active' ORDER BY created_at, id`)
      .all() as unknown as BindingRow[]).map(bindingFromRow)
  }

  getBindingBySession(sessionId: string): ConversationBinding | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${bindingSelect} WHERE session_id = ?`).get(sessionId) as BindingRow | undefined
    return row === undefined ? undefined : bindingFromRow(row)
  }

  getModelSelection(input: ConversationRef): ConversationModelSelection | undefined {
    this.assertOpen()
    const conversation = canonicalConversation(input)
    const row = this.database.prepare(`
      SELECT provider, model, reasoning_effort, updated_at, version
      FROM conversation_model_selections
      WHERE conversation_hash = ? AND conversation_json = ?
    `).get(conversationHash(conversation), conversationJson(conversation)) as ModelSelectionRow | undefined
    return row === undefined ? undefined : {
      provider: row.provider,
      model: row.model,
      ...(row.reasoning_effort === null ? {} : { reasoningEffort: row.reasoning_effort }),
      updatedAt: row.updated_at,
      version: row.version,
    }
  }

  setModelSelection(
    input: ConversationRef,
    route: ModelRouteRef,
  ): ConversationModelSelection {
    this.assertOpen()
    const conversation = canonicalConversation(input)
    const provider = modelRoutePart(route.provider, 'provider')
    const model = modelRoutePart(route.model, 'model')
    const reasoningEffort = route.reasoningEffort === undefined
      ? undefined
      : modelRoutePart(route.reasoningEffort, 'effort')
    const current = this.getModelSelection(conversation)
    if (current?.provider === provider && current.model === model
      && current.reasoningEffort === reasoningEffort) return current
    const now = this.now()
    this.database.prepare(`
      INSERT INTO conversation_model_selections (
        conversation_hash, conversation_json, provider, model, reasoning_effort, updated_at, version
      ) VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(conversation_hash) DO UPDATE SET
        conversation_json = excluded.conversation_json,
        provider = excluded.provider,
        model = excluded.model,
        reasoning_effort = excluded.reasoning_effort,
        updated_at = excluded.updated_at,
        version = conversation_model_selections.version + 1
    `).run(conversationHash(conversation), conversationJson(conversation), provider, model, reasoningEffort ?? null, now)
    return this.getModelSelection(conversation)!
  }

  clearModelSelection(input: ConversationRef): boolean {
    this.assertOpen()
    const conversation = canonicalConversation(input)
    return this.database.prepare(`
      DELETE FROM conversation_model_selections
      WHERE conversation_hash = ? AND conversation_json = ?
    `).run(conversationHash(conversation), conversationJson(conversation)).changes === 1
  }

  beginModelCommand(input: ConversationRef): number {
    this.assertOpen()
    const conversation = canonicalConversation(input)
    return this.transaction(() => this.advanceModelCommandEpoch(conversation))
  }

  commitModelCommand(input: {
    conversation: ConversationRef
    expectedEpoch: number
    route?: ModelRouteRef
  }): { applied: false } | { applied: true; selection?: ConversationModelSelection } {
    this.assertOpen()
    if (!Number.isSafeInteger(input.expectedEpoch) || input.expectedEpoch < 1) {
      throw new DeliveryStoreError('version-conflict', 'model command epoch is invalid')
    }
    const conversation = canonicalConversation(input.conversation)
    const route = input.route === undefined ? undefined : canonicalModelRoute(input.route)
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT epoch FROM conversation_model_epochs
        WHERE conversation_hash = ? AND conversation_json = ?
      `).get(conversationHash(conversation), conversationJson(conversation)) as { epoch: number } | undefined
      if (current?.epoch !== input.expectedEpoch) return { applied: false }
      if (route === undefined) {
        this.clearModelSelection(conversation)
        return { applied: true }
      }
      return { applied: true, selection: this.setModelSelection(conversation, route) }
    })
  }

  rotateBinding(input: { bindingId: string; expectedVersion: number; sessionId: string }): ConversationBinding {
    this.assertOpen()
    const sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
    const now = this.now()
    const id = `binding_${randomUUID()}`
    return this.transaction(() => {
      const current = this.getBinding(input.bindingId)
      if (current === undefined || current.status !== 'active' || current.version !== input.expectedVersion) {
        throw new DeliveryStoreError('version-conflict', 'active binding version changed or does not exist')
      }
      const generation = this.nextBindingGenerationByHash(conversationHash(current.conversation))
      if (generation !== current.generation + 1) {
        throw new DeliveryStoreError('version-conflict', 'binding generation changed before rotation')
      }
      const updated = this.database.prepare(`
        UPDATE conversation_bindings SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(now, current.id, input.expectedVersion)
      if (updated.changes !== 1) throw new DeliveryStoreError('version-conflict', 'active binding version changed')
      const principal = this.getPrincipal(current.principal)
      if (principal?.status !== 'active') throw new DeliveryStoreError('unauthorized-principal', 'binding principal is not active')
      this.database.prepare(`
        INSERT INTO conversation_bindings (
          id, conversation_hash, conversation_json, principal_id, principal_json, workspace, agent_preset,
          session_id, generation, policy_ref, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(
        id,
        conversationHash(current.conversation),
        conversationJson(current.conversation),
        principal.id,
        principalJson(current.principal),
        current.workspace,
        current.agentPreset,
        sessionId,
        generation,
        current.policyRef,
        now,
        now,
      )
      return this.getBinding(id)!
    })
  }

  /**
   * Consume one exact `/new` Inbox while rotating its binding.
   *
   * The Inbox transition is part of the same SQLite commit as revoking the
   * previous binding and inserting its successor. Consequently a provider
   * replay can observe either the entirely old state or the entirely new
   * state, never a rotated binding paired with an unconsumed command.
   */
  rotateBindingAndQueueCommand(input: {
    bindingId: string
    expectedVersion: number
    sessionId: string
    inboxId: string
  }): { binding: ConversationBinding; inbox: InboxRecord } {
    this.assertOpen()
    const bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
    const inboxId = validateBindingText(input.inboxId, 'inboxId', 256)
    const sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new DeliveryStoreError('version-conflict', 'active binding version is invalid')
    }
    const now = this.now()
    const nextBindingId = `binding_${randomUUID()}`
    return this.transaction(() => {
      const current = this.getBinding(bindingId)
      const command = this.getInbox(inboxId)
      if (current === undefined || current.status !== 'active' || current.version !== input.expectedVersion) {
        throw new DeliveryStoreError('version-conflict', 'active binding version changed or does not exist')
      }
      if (command === undefined) {
        throw new DeliveryStoreError('not-found', 'new-session command Inbox was not found')
      }
      if (!['received', 'authorized'].includes(command.status)
        || !isExactDeliveryCommand(parseDeliveryCommand(command.envelope), 'new', 'clear')) {
        throw new DeliveryStoreError('conflict', 'Inbox is not an unconsumed exact new-session command')
      }
      if (conversationHash(command.envelope.conversation) !== conversationHash(current.conversation)
        || principalHash(command.envelope.principal) !== principalHash(current.principal)) {
        throw new DeliveryStoreError('conflict', 'new-session command does not belong to the binding')
      }
      const generation = this.nextBindingGenerationByHash(conversationHash(current.conversation))
      if (generation !== current.generation + 1) {
        throw new DeliveryStoreError('version-conflict', 'binding generation changed before rotation')
      }
      const principal = this.getPrincipal(current.principal)
      if (principal?.status !== 'active') {
        throw new DeliveryStoreError('unauthorized-principal', 'binding principal is not active')
      }
      const revoked = this.database.prepare(`
        UPDATE conversation_bindings SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE id = ? AND status = 'active' AND version = ?
      `).run(now, current.id, input.expectedVersion)
      if (revoked.changes !== 1) {
        throw new DeliveryStoreError('version-conflict', 'active binding version changed')
      }
      this.database.prepare(`
        INSERT INTO conversation_bindings (
          id, conversation_hash, conversation_json, principal_id, principal_json, workspace, agent_preset,
          session_id, generation, policy_ref, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, 1)
      `).run(
        nextBindingId,
        conversationHash(current.conversation),
        conversationJson(current.conversation),
        principal.id,
        principalJson(current.principal),
        current.workspace,
        current.agentPreset,
        sessionId,
        generation,
        current.policyRef,
        now,
        now,
      )
      const queued = this.database.prepare(`
        UPDATE inbox_messages
        SET status = 'queued', binding_id = ?, next_attempt_at = NULL, failure_code = NULL,
          claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status IN ('received', 'authorized')
      `).run(nextBindingId, now, inboxId)
      if (queued.changes !== 1) {
        throw new DeliveryStoreError('conflict', 'new-session command queue transition lost a race')
      }
      return {
        binding: this.getBinding(nextBindingId)!,
        inbox: this.getInbox(inboxId)!,
      }
    })
  }

  acceptInbound(input: InboundEnvelope): { duplicate: boolean; record: InboxRecord } {
    this.assertOpen()
    const envelope = canonicalEnvelope(input, this.maxTextBytes)
    const json = JSON.stringify(envelope)
    const hash = digest(json)
    const existing = this.database.prepare(`${inboxSelect} WHERE channel = ? AND account = ? AND event_id = ?`)
      .get(envelope.channel, envelope.account, envelope.eventId) as InboxRow | undefined
    if (existing !== undefined) {
      if (existing.envelope_hash !== hash) {
        throw new DeliveryStoreError('idempotency-conflict', 'provider event id was reused with a different envelope')
      }
      return { duplicate: true, record: inboxFromRow(existing) }
    }
    const now = this.now()
    const id = `inbox_${randomUUID()}`
    try {
      this.transaction(() => {
        this.database.prepare(`
          INSERT INTO inbox_messages (
            id, channel, account, event_id, envelope_hash, envelope_json, status,
            attempt_count, received_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'received', 0, ?, ?)
        `).run(id, envelope.channel, envelope.account, envelope.eventId, hash, json, now, now)
        for (const [ordinal, attachment] of (envelope.attachments ?? []).entries()) {
          const descriptorHash = digest(JSON.stringify(attachment))
          this.database.prepare(`
            INSERT INTO delivery_attachments (
              id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256, spool_ref,
              resource_kind, provider_ref, file_name, status, expires_at, created_at
            ) VALUES (?, 'inbox', ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'metadata', NULL, ?)
          `).run(
            `attachment_${digest(`${id}:${ordinal}:${attachment.providerRef}`).slice(0, 40)}`,
            id,
            ordinal,
            attachment.mediaType ?? '',
            attachment.sizeBytes ?? 0,
            descriptorHash,
            attachment.resourceType,
            attachment.providerRef,
            attachment.fileName ?? null,
            now,
          )
        }
      })
    } catch (error) {
      const winner = this.database.prepare(`${inboxSelect} WHERE channel = ? AND account = ? AND event_id = ?`)
        .get(envelope.channel, envelope.account, envelope.eventId) as InboxRow | undefined
      if (winner !== undefined && winner.envelope_hash === hash) return { duplicate: true, record: inboxFromRow(winner) }
      throw error
    }
    return { duplicate: false, record: this.getInbox(id)! }
  }

  listAttachments(input: { ownerKind: 'inbox' | 'outbox'; ownerId: string }): DeliveryAttachment[] {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256, spool_ref,
        resource_kind, provider_ref, file_name, status, expires_at, created_at
      FROM delivery_attachments WHERE owner_kind = ? AND owner_id = ? ORDER BY ordinal
    `).all(input.ownerKind, input.ownerId) as unknown as AttachmentRow[]
    return rows.map(attachmentFromRow)
  }

  /**
   * Return complete durable image references in the provider descriptor order.
   * `undefined` means the image descriptors have not been materialized yet.
   */
  listReadyInboundImageRefs(inboxId: string): readonly ImageAttachmentRef[] | undefined {
    this.assertOpen()
    const rows = this.database.prepare(`
      SELECT id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256, spool_ref,
        resource_kind, provider_ref, file_name, status, expires_at, created_at
      FROM delivery_attachments
      WHERE owner_kind = 'inbox' AND owner_id = ? AND resource_kind = 'image'
      ORDER BY ordinal
    `).all(inboxId) as unknown as AttachmentRow[]
    if (rows.length === 0) return []
    if (rows.every(row => row.status === 'metadata')) return undefined
    if (rows.some(row => row.status !== 'ready')) {
      throw new DeliveryStoreError('conflict', 'inbound images have inconsistent materialization state')
    }
    return rows.map(persistedImageRef)
  }

  /** Atomically persist one ordered image batch while the caller still owns the live inbox lease. */
  commitInboundImageRefs(input: {
    inboxId: string
    ownerId: string
    fencingToken: number
    images: readonly { ref: ImageAttachmentRef; contentSha256: string }[]
  }): readonly ImageAttachmentRef[] {
    this.assertOpen()
    if (typeof input.inboxId !== 'string' || input.inboxId.length < 1 || input.inboxId.length > 256
      || typeof input.ownerId !== 'string' || input.ownerId.length < 1 || input.ownerId.length > 256
      || /\p{Cc}/u.test(input.inboxId) || /\p{Cc}/u.test(input.ownerId)
      || !Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new DeliveryStoreError('stale-fence', 'inbound image commit has an invalid fence')
    }
    if (!Array.isArray(input.images)) {
      throw new DeliveryStoreError('conflict', 'inbound image reference batch is invalid')
    }
    const now = this.now()
    return this.transaction(() => {
      const claim = this.database.prepare(`
        SELECT binding.status AS binding_status, principal.status AS principal_status
        FROM inbox_messages AS inbox
        LEFT JOIN conversation_bindings AS binding ON binding.id = inbox.binding_id
        LEFT JOIN delivery_principals AS principal ON principal.id = binding.principal_id
        WHERE inbox.id = ? AND inbox.status = 'claimed' AND inbox.claimed_by = ?
          AND inbox.fencing_token = ? AND inbox.lease_until > ?
      `).get(input.inboxId, input.ownerId, input.fencingToken, now) as {
        binding_status: ConversationBinding['status'] | null
        principal_status: DeliveryPrincipal['status'] | null
      } | undefined
      if (claim === undefined) {
        throw new DeliveryStoreError('stale-fence', 'inbound image commit has a stale fence')
      }
      if (claim.binding_status !== 'active' || claim.principal_status !== 'active') {
        throw new DeliveryStoreError('unauthorized-principal', 'inbound image authority was revoked before commit')
      }

      const rows = this.database.prepare(`
        SELECT id, owner_kind, owner_id, ordinal, media_type, size_bytes, sha256, spool_ref,
          resource_kind, provider_ref, file_name, status, expires_at, created_at
        FROM delivery_attachments
        WHERE owner_kind = 'inbox' AND owner_id = ? AND resource_kind = 'image'
        ORDER BY ordinal
      `).all(input.inboxId) as unknown as AttachmentRow[]
      if (rows.length !== input.images.length) {
        throw new DeliveryStoreError('conflict', 'inbound image reference count does not match its descriptors')
      }
      const images = input.images.map(image => {
        if (image === null || typeof image !== 'object' || Array.isArray(image)
          || !Object.hasOwn(image, 'ref') || !Object.hasOwn(image, 'contentSha256')
          || Object.keys(image).some(key => !['ref', 'contentSha256'].includes(key))
          || typeof image.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(image.contentSha256)) {
          invalidImageRef()
        }
        return { ref: canonicalImageRef(image.ref), contentSha256: image.contentSha256 }
      })

      if (rows.every(row => row.status === 'ready')) {
        const persisted = rows.map(persistedImageRef)
        if (persisted.some((ref, index) => !sameImageRef(ref, images[index]!.ref)
          || rows[index]!.sha256 !== images[index]!.contentSha256)) {
          throw new DeliveryStoreError('conflict', 'inbound image references are immutable')
        }
        return persisted
      }
      if (rows.some(row => row.status !== 'metadata')) {
        throw new DeliveryStoreError('conflict', 'inbound images have inconsistent materialization state')
      }

      for (const [index, row] of rows.entries()) {
        const image = images[index]!
        const changed = this.database.prepare(`
          UPDATE delivery_attachments
          SET media_type = ?, size_bytes = ?, sha256 = ?, spool_ref = ?, status = 'ready'
          WHERE id = ? AND owner_kind = 'inbox' AND owner_id = ? AND resource_kind = 'image'
            AND status = 'metadata'
        `).run(
          image.ref.mediaType,
          image.ref.bytes,
          image.contentSha256,
          JSON.stringify(image.ref),
          row.id,
          input.inboxId,
        )
        if (changed.changes !== 1) {
          throw new DeliveryStoreError('conflict', 'inbound image batch changed during commit')
        }
      }
      return images.map(image => image.ref)
    })
  }

  queueInbox(inboxId: string, bindingId: string): InboxRecord {
    this.assertOpen()
    const record = this.getInbox(inboxId)
    const binding = this.getBinding(bindingId)
    if (record === undefined || binding === undefined || binding.status !== 'active') {
      throw new DeliveryStoreError('not-found', 'inbox or active binding was not found')
    }
    if (
      conversationHash(record.envelope.conversation) !== conversationHash(binding.conversation)
      || principalHash(record.envelope.principal) !== principalHash(binding.principal)
    ) throw new DeliveryStoreError('conflict', 'inbox envelope does not belong to the binding')
    if (record.status === 'queued' && record.bindingId === bindingId) return record
    if (record.status !== 'received' && record.status !== 'authorized') {
      throw new DeliveryStoreError('conflict', `cannot queue inbox in ${record.status}`)
    }
    const now = this.now()
    this.transaction(() => {
      if (record.status === 'received') {
        this.database.prepare(`
          UPDATE inbox_messages SET status = 'authorized', binding_id = ?, updated_at = ?
          WHERE id = ? AND status = 'received'
        `).run(bindingId, now, inboxId)
      }
      const queued = this.database.prepare(`
        UPDATE inbox_messages SET status = 'queued', binding_id = ?, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'authorized'
      `).run(bindingId, now, inboxId)
      if (queued.changes !== 1) throw new DeliveryStoreError('conflict', 'inbox queue transition lost a race')
    })
    return this.getInbox(inboxId)!
  }

  /**
   * Establish a durable command boundary before `/stop` or `/new` is queued.
   *
   * Every earlier record in the same binding that has not crossed the exact
   * dispatch marker becomes terminal in one transaction. A normal claim
   * carrying `dispatch-started` is deliberately left live because the external
   * Agent may have observed it already. Exact permission commands instead get
   * a durable cancelled-recovery marker before the runtime is asked to abort.
   */
  cancelUndispatchedInboxBefore(input: {
    bindingId: string
    beforeInboxId: string
    failureCode: string
  }): {
    cancelled: number
    dispatching: number
    claimedInboxIds: string[]
    dispatchingInboxIds: string[]
  } {
    this.assertOpen()
    const bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
    const beforeInboxId = validateBindingText(input.beforeInboxId, 'beforeInboxId', 256)
    const failureCode = validateBindingText(input.failureCode, 'failureCode', 256)
    const boundary = this.getInbox(beforeInboxId)
    const binding = this.getBinding(bindingId)
    if (boundary === undefined || binding === undefined || binding.status !== 'active') {
      throw new DeliveryStoreError('not-found', 'inbox cancellation boundary or active binding was not found')
    }
    if (conversationHash(boundary.envelope.conversation) !== conversationHash(binding.conversation)
      || principalHash(boundary.envelope.principal) !== principalHash(binding.principal)) {
      throw new DeliveryStoreError('conflict', 'inbox cancellation boundary does not belong to the binding')
    }
    const bindingConversationJson = conversationJson(binding.conversation)
    const bindingPrincipalJson = principalJson(binding.principal)
    const now = this.now()
    return this.transaction(() => {
      const boundaryRow = this.database.prepare('SELECT rowid FROM inbox_messages WHERE id = ?')
        .get(beforeInboxId) as { rowid: number } | undefined
      if (boundaryRow === undefined) {
        throw new DeliveryStoreError('not-found', 'inbox cancellation boundary was not found')
      }
      const dispatchingRows = this.database.prepare(`
        SELECT id, envelope_json FROM inbox_messages
        WHERE rowid < ? AND status = 'claimed' AND failure_code = 'dispatch-started'
          AND (binding_id = ? OR (
            json_extract(envelope_json, '$.conversation') = json(?)
            AND json_extract(envelope_json, '$.principal') = json(?)
          ))
        ORDER BY rowid
      `).all(boundaryRow.rowid, bindingId, bindingConversationJson, bindingPrincipalJson) as unknown as {
        id: string
        envelope_json: string
      }[]
      for (const row of dispatchingRows) {
        let permission = false
        try {
          permission = isPermissionDeliveryCommand(JSON.parse(row.envelope_json) as InboundEnvelope)
        } catch {}
        if (!permission) continue
        const marked = this.database.prepare(`
          UPDATE inbox_messages SET failure_code = 'permission-cancelled-recovery', updated_at = ?
          WHERE id = ? AND status = 'claimed' AND failure_code = 'dispatch-started'
        `).run(now, row.id)
        if (marked.changes !== 1) {
          throw new DeliveryStoreError('conflict', 'permission cancellation marker lost its dispatch fence')
        }
      }
      const claimedRows = this.database.prepare(`
        SELECT id FROM inbox_messages
        WHERE rowid < ? AND status = 'claimed' AND failure_code IS NULL
          AND (binding_id = ? OR (
            json_extract(envelope_json, '$.conversation') = json(?)
            AND json_extract(envelope_json, '$.principal') = json(?)
          ))
        ORDER BY rowid
      `).all(boundaryRow.rowid, bindingId, bindingConversationJson, bindingPrincipalJson) as unknown as { id: string }[]
      this.database.prepare(`
        UPDATE inbox_attempts SET status = 'dead_letter', failure_code = ?, finished_at = ?
        WHERE status = 'claimed' AND inbox_id IN (
          SELECT id FROM inbox_messages
          WHERE rowid < ? AND status = 'claimed' AND failure_code IS NULL
            AND (binding_id = ? OR (
              json_extract(envelope_json, '$.conversation') = json(?)
              AND json_extract(envelope_json, '$.principal') = json(?)
            ))
        )
      `).run(failureCode, now, boundaryRow.rowid, bindingId, bindingConversationJson, bindingPrincipalJson)
      const cancelled = this.database.prepare(`
        UPDATE inbox_messages SET status = 'dead_letter', failure_code = ?, next_attempt_at = NULL,
          claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
        WHERE rowid < ?
          AND (binding_id = ? OR (
            json_extract(envelope_json, '$.conversation') = json(?)
            AND json_extract(envelope_json, '$.principal') = json(?)
          ))
          AND (status IN ('received', 'authorized', 'queued', 'retry_wait')
            OR (status = 'claimed' AND failure_code IS NULL))
      `).run(failureCode, now, boundaryRow.rowid, bindingId, bindingConversationJson, bindingPrincipalJson)
      const cancelledCount = Number(cancelled.changes)
      if (!Number.isSafeInteger(cancelledCount)) {
        throw new DeliveryStoreError('conflict', 'inbox cancellation count is outside the safe integer range')
      }
      return {
        cancelled: cancelledCount,
        dispatching: dispatchingRows.length,
        claimedInboxIds: claimedRows.map(row => row.id),
        dispatchingInboxIds: dispatchingRows.map(row => row.id),
      }
    })
  }

  getInbox(id: string): InboxRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${inboxSelect} WHERE id = ?`).get(id) as InboxRow | undefined
    return row === undefined ? undefined : inboxFromRow(row)
  }

  getInboxByProviderEvent(channel: string, account: string, eventId: string): InboxRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${inboxSelect} WHERE channel = ? AND account = ? AND event_id = ?`)
      .get(channel, account, eventId) as InboxRow | undefined
    return row === undefined ? undefined : inboxFromRow(row)
  }

  /** Return the oldest durable admission that did not finish before another Inbox. */
  findPendingInboundBefore(input: {
    conversation: ConversationRef
    principal: ExternalPrincipalKey
    beforeInboxId: string
  }): InboxRecord | undefined {
    this.assertOpen()
    const target = canonicalTarget({ conversation: input.conversation, principal: input.principal })
    const beforeInboxId = validateBindingText(input.beforeInboxId, 'beforeInboxId', 256)
    const boundary = this.database.prepare('SELECT rowid FROM inbox_messages WHERE id = ?')
      .get(beforeInboxId) as { rowid: number } | undefined
    if (boundary === undefined) throw new DeliveryStoreError('not-found', 'inbound recovery boundary Inbox was not found')
    const row = this.database.prepare(`${inboxSelect}
      WHERE rowid < ? AND status IN ('received', 'authorized')
        AND json_extract(envelope_json, '$.conversation') = json(?)
        AND json_extract(envelope_json, '$.principal') = json(?)
      ORDER BY rowid LIMIT 1
    `).get(
      boundary.rowid,
      conversationJson(target.conversation),
      principalJson(target.principal),
    ) as InboxRow | undefined
    return row === undefined ? undefined : inboxFromRow(row)
  }

  listInbox(input: { bindingId?: string; limit?: number } = {}): InboxRecord[] {
    this.assertOpen()
    const limit = Math.max(1, Math.min(100, input.limit ?? 20))
    const rows = input.bindingId === undefined
      ? this.database.prepare(`${inboxSelect} ORDER BY received_at DESC, rowid DESC LIMIT ?`).all(limit)
      : this.database.prepare(`${inboxSelect} WHERE binding_id = ? ORDER BY received_at DESC, rowid DESC LIMIT ?`)
        .all(input.bindingId, limit)
    return (rows as unknown as InboxRow[]).map(inboxFromRow)
  }

  health(): {
    pendingInbox: number
    deadLetterInbox: number
    pendingOutbox: number
    deadLetterOutbox: number
    unknownOutbox: number
  } {
    this.assertOpen()
    const scalar = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count
    return {
      pendingInbox: scalar("SELECT COUNT(*) AS count FROM inbox_messages WHERE status IN ('received', 'authorized', 'queued', 'claimed', 'retry_wait')"),
      deadLetterInbox: scalar("SELECT COUNT(*) AS count FROM inbox_messages WHERE status = 'dead_letter'"),
      pendingOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status IN ('pending', 'attempting', 'retry_wait')"),
      deadLetterOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'dead'"),
      unknownOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'unknown_after_send'"),
    }
  }

  getApprovalDispatchCursor(): ApprovalDispatchCursorState {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT after_created_at, after_proposal_id, version
      FROM approval_dispatch_cursor WHERE singleton = 1
    `).get() as { after_created_at: number | null; after_proposal_id: string | null; version: number } | undefined
    if (row === undefined) return { version: 0 }
    return {
      version: row.version,
      ...(row.after_created_at === null || row.after_proposal_id === null
        ? {}
        : { after: { createdAt: row.after_created_at, proposalId: row.after_proposal_id } }),
    }
  }

  advanceApprovalDispatchCursor(input: {
    expectedVersion: number
    after?: Readonly<ApprovalDispatchCursor>
  }): ApprovalDispatchCursorState {
    this.assertOpen()
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new DeliveryStoreError('stale-fence', 'approval dispatch cursor fence is invalid')
    }
    let after: ApprovalDispatchCursor | undefined
    if (input.after !== undefined) {
      if (!Number.isSafeInteger(input.after.createdAt) || input.after.createdAt < 0) {
        throw new DeliveryStoreError('stale-fence', 'approval dispatch cursor time is invalid')
      }
      after = { createdAt: input.after.createdAt,
        proposalId: validateBindingText(input.after.proposalId, 'proposalId', 256) }
    }
    return this.transaction(() => {
      const current = this.getApprovalDispatchCursor()
      if (current.version !== input.expectedVersion) {
        throw new DeliveryStoreError('stale-fence', 'approval dispatch cursor changed')
      }
      const now = this.now()
      const values = [after?.createdAt ?? null, after?.proposalId ?? null]
      const changed = current.version === 0
        ? this.database.prepare(`
          INSERT INTO approval_dispatch_cursor (
            singleton, after_created_at, after_proposal_id, version, updated_at
          ) VALUES (1, ?, ?, 1, ?)
          ON CONFLICT(singleton) DO NOTHING
        `).run(...values, now)
        : this.database.prepare(`
          UPDATE approval_dispatch_cursor
          SET after_created_at = ?, after_proposal_id = ?, version = version + 1, updated_at = ?
          WHERE singleton = 1 AND version = ?
        `).run(...values, now, input.expectedVersion)
      if (changed.changes !== 1) {
        throw new DeliveryStoreError('stale-fence', 'approval dispatch cursor changed')
      }
      return this.getApprovalDispatchCursor()
    })
  }

  deadLetterInbox(inboxId: string, failureCode: string): InboxRecord {
    this.assertOpen()
    const failure = validateBindingText(failureCode, 'failureCode', 256)
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE inbox_messages SET status = 'dead_letter', failure_code = ?, next_attempt_at = NULL,
        claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
      WHERE id = ? AND status NOT IN ('processed', 'dead_letter')
    `).run(failure, now, inboxId)
    if (changed.changes !== 1) {
      const current = this.getInbox(inboxId)
      if (current?.status === 'dead_letter') return current
      throw new DeliveryStoreError('conflict', 'inbox cannot be dead-lettered in its current state')
    }
    return this.getInbox(inboxId)!
  }

  claimInbox(input: {
    ownerId: string
    leaseMs: number
    limit: number
    maxAttempts: number
    maintenanceLimit?: number
  }): { record: InboxRecord; fencingToken: number }[] {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) throw new DeliveryStoreError('conflict', 'invalid inbox lease')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new DeliveryStoreError('conflict', 'invalid inbox claim limit')
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      throw new DeliveryStoreError('conflict', 'invalid inbox max attempts')
    }
    const maintenanceLimit = boundedMaintenanceLimit(input.maintenanceLimit, input.limit, 'inbox')
    const now = this.now()
    const claims: { record: InboxRecord; fencingToken: number }[] = []
    this.transaction(() => {
      this.database.prepare(`
        UPDATE inbox_messages SET status = 'dead_letter', failure_code = 'attempts-exhausted',
          next_attempt_at = NULL, updated_at = ?
        WHERE rowid IN (
          SELECT rowid FROM inbox_messages
          WHERE status = 'retry_wait' AND next_attempt_at <= ? AND attempt_count >= ?
            AND (failure_code IS NULL OR failure_code NOT IN (
              'permission-dispatch-recovery',
              'permission-cancelled-recovery',
              'permission-failure-notice-recovery'
            ))
          ORDER BY rowid LIMIT ?
        )
      `).run(now, now, input.maxAttempts, maintenanceLimit)
      const candidates = this.database.prepare(`
        SELECT candidate.id FROM inbox_messages AS candidate
        WHERE candidate.status IN ('queued', 'retry_wait')
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND (candidate.status = 'queued' OR candidate.attempt_count < ? OR candidate.failure_code IN (
            'permission-dispatch-recovery',
            'permission-cancelled-recovery',
            'permission-failure-notice-recovery'
          ))
          AND candidate.binding_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM inbox_messages AS earlier
            WHERE earlier.binding_id = candidate.binding_id
              AND earlier.rowid < candidate.rowid
              AND earlier.status NOT IN ('processed', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM inbox_messages AS active
            WHERE active.binding_id = candidate.binding_id AND active.status = 'claimed'
          )
        ORDER BY candidate.rowid LIMIT ?
      `).all(now, input.maxAttempts, input.limit) as unknown as { id: string }[]
      for (const candidate of candidates) {
        const current = this.getInbox(candidate.id)!
        const fencingToken = current.attemptCount + 1
        const changed = this.database.prepare(`
          UPDATE inbox_messages SET status = 'claimed', claimed_by = ?, fencing_token = ?, lease_until = ?,
            attempt_count = attempt_count + 1, next_attempt_at = NULL,
            failure_code = CASE WHEN failure_code IN (
              'permission-dispatch-recovery',
              'permission-cancelled-recovery',
              'permission-failure-notice-recovery'
            ) THEN failure_code ELSE NULL END,
            updated_at = ?
          WHERE id = ? AND status IN ('queued', 'retry_wait')
        `).run(ownerId, fencingToken, now + input.leaseMs, now, current.id)
        if (changed.changes !== 1) continue
        this.database.prepare(`
          INSERT INTO inbox_attempts (id, inbox_id, attempt_number, owner_id, fencing_token, status, created_at)
          VALUES (?, ?, ?, ?, ?, 'claimed', ?)
        `).run(`inbox_attempt_${randomUUID()}`, current.id, fencingToken, ownerId, fencingToken, now)
        claims.push({ record: this.getInbox(current.id)!, fencingToken })
      }
    })
    return claims
  }

  finishInbox(input: {
    inboxId: string
    ownerId: string
    fencingToken: number
    outcome: 'dead_letter' | 'processed' | 'retry_wait'
    failureCode?: string
    retryAt?: number
  }): InboxRecord {
    this.assertOpen()
    const now = this.now()
    if (input.outcome === 'retry_wait' && (!Number.isSafeInteger(input.retryAt) || input.retryAt! < now)) {
      throw new DeliveryStoreError('conflict', 'retry_wait requires a current or future retryAt')
    }
    this.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE inbox_messages SET status = ?, next_attempt_at = ?, claimed_by = NULL, fencing_token = NULL,
          lease_until = NULL, failure_code = ?, updated_at = ?
        WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND fencing_token = ? AND lease_until > ?
      `).run(
        input.outcome,
        input.outcome === 'retry_wait' ? input.retryAt! : null,
        input.failureCode ?? null,
        now,
        input.inboxId,
        input.ownerId,
        input.fencingToken,
        now,
      )
      if (changed.changes !== 1) throw new DeliveryStoreError('stale-fence', 'inbox completion has a stale fence')
      this.database.prepare(`
        UPDATE inbox_attempts SET status = ?, failure_code = ?, finished_at = ?
        WHERE inbox_id = ? AND owner_id = ? AND fencing_token = ? AND status = 'claimed'
      `).run(input.outcome, input.failureCode ?? null, now, input.inboxId, input.ownerId, input.fencingToken)
    })
    return this.getInbox(input.inboxId)!
  }

  markInboxDispatching(input: {
    inboxId: string
    ownerId: string
    fencingToken: number
    binding: Readonly<InboundDispatchBindingSnapshot>
  }): InboxRecord {
    this.assertOpen()
    let bindingId: string
    let sessionId: string
    let bindingConversationJson: string
    let bindingPrincipalJson: string
    try {
      bindingId = validateBindingText(input.binding.id, 'binding.id', 256)
      sessionId = validateBindingText(input.binding.sessionId, 'binding.sessionId', 512)
      bindingConversationJson = conversationJson(input.binding.conversation)
      bindingPrincipalJson = principalJson(input.binding.principal)
    } catch {
      throw new DeliveryStoreError('invalid-binding', 'inbox dispatch binding snapshot is invalid')
    }
    if (!Number.isSafeInteger(input.binding.version) || input.binding.version < 1
      || !Number.isSafeInteger(input.binding.generation) || input.binding.generation < 1) {
      throw new DeliveryStoreError('invalid-binding', 'inbox dispatch binding snapshot is invalid')
    }
    const now = this.now()
    return this.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE inbox_messages AS inbox SET failure_code = CASE WHEN failure_code IN (
          'permission-dispatch-recovery',
          'permission-cancelled-recovery',
          'permission-failure-notice-recovery'
        ) THEN failure_code ELSE 'dispatch-started' END, updated_at = ?
        WHERE inbox.id = ? AND inbox.status = 'claimed' AND inbox.claimed_by = ?
          AND inbox.fencing_token = ? AND inbox.lease_until > ? AND inbox.binding_id = ?
          AND EXISTS (
            SELECT 1 FROM conversation_bindings AS binding
            JOIN delivery_principals AS principal ON principal.id = binding.principal_id
            WHERE binding.id = inbox.binding_id AND binding.id = ? AND binding.status = 'active'
              AND binding.version = ? AND binding.session_id = ? AND binding.generation = ?
              AND binding.conversation_json = ? AND binding.principal_json = ?
              AND principal.status = 'active' AND principal.key_hash = ? AND principal.principal_json = ?
          )
      `).run(
        now,
        input.inboxId,
        input.ownerId,
        input.fencingToken,
        now,
        bindingId,
        bindingId,
        input.binding.version,
        sessionId,
        input.binding.generation,
        bindingConversationJson,
        bindingPrincipalJson,
        principalHash(input.binding.principal),
        bindingPrincipalJson,
      )
      if (changed.changes === 1) return this.getInbox(input.inboxId)!

      const claim = this.database.prepare(`
        SELECT binding_id FROM inbox_messages
        WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND fencing_token = ? AND lease_until > ?
      `).get(input.inboxId, input.ownerId, input.fencingToken, now)
      if (claim === undefined) {
        throw new DeliveryStoreError('stale-fence', 'inbox dispatch marker has a stale fence')
      }
      const principal = this.database.prepare(`
        SELECT status FROM delivery_principals WHERE key_hash = ? AND principal_json = ?
      `).get(principalHash(input.binding.principal), bindingPrincipalJson) as {
        status: DeliveryPrincipal['status']
      } | undefined
      if (principal?.status !== 'active') {
        throw new DeliveryStoreError('unauthorized-principal', 'inbox dispatch principal is not active')
      }
      throw new DeliveryStoreError('invalid-binding', 'inbox dispatch binding snapshot is no longer active')
    })
  }

  renewInboxClaim(input: {
    inboxId: string
    ownerId: string
    fencingToken: number
    leaseMs: number
  }): boolean {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new DeliveryStoreError('stale-fence', 'inbox lease renewal is invalid')
    }
    const now = this.now()
    return this.database.prepare(`
      UPDATE inbox_messages SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND fencing_token = ? AND lease_until > ?
    `).run(now + input.leaseMs, now, input.inboxId, ownerId, input.fencingToken, now).changes === 1
  }

  recoverInbox(input: { maxAttempts: number; limit?: number }): InboxRecord[] {
    this.assertOpen()
    const limit = boundedMaintenanceLimit(input.limit, 100, 'inbox recovery')
    const now = this.now()
    const recovered: string[] = []
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id, event_id, binding_id, attempt_count, failure_code, envelope_json FROM inbox_messages
        WHERE status = 'claimed' AND lease_until <= ? ORDER BY rowid LIMIT ?
      `).all(now, limit) as unknown as {
        id: string
        event_id: string
        binding_id: string | null
        attempt_count: number
        failure_code: string | null
        envelope_json: string
      }[]
      for (const row of rows) {
        let interruptedPermission = false
        if (row.failure_code === 'dispatch-started') {
          try {
            interruptedPermission = isPermissionDeliveryCommand(JSON.parse(row.envelope_json) as InboundEnvelope)
          } catch {}
        }
        const existingPermissionRecovery = permissionDispatchRecoveryFromFailureCode(row.failure_code ?? undefined)
        const permissionCommand = interruptedPermission || existingPermissionRecovery !== undefined
        const terminalOutbox = !permissionCommand || row.binding_id === null
          ? undefined
          : this.database.prepare(`
              SELECT id FROM outbox_messages
              WHERE idempotency_key IN (?, ?) AND binding_id = ?
                AND json_valid(intent_json)
                AND json_extract(intent_json, '$.replyToEventId') = ?
            `).get(
              `inbound:${row.id}:reply`,
              `inbound:${row.event_id}:reply`,
              row.binding_id,
              row.event_id,
            )
        if (terminalOutbox !== undefined) {
          const changed = this.database.prepare(`
            UPDATE inbox_messages SET status = 'processed', next_attempt_at = NULL, claimed_by = NULL,
              fencing_token = NULL, lease_until = NULL, failure_code = NULL, updated_at = ?
            WHERE id = ? AND status = 'claimed' AND lease_until <= ?
          `).run(now, row.id, now)
          if (changed.changes !== 1) continue
          this.database.prepare(`
            UPDATE inbox_attempts SET status = 'processed', failure_code = NULL, finished_at = ?
            WHERE inbox_id = ? AND status = 'claimed'
          `).run(now, row.id)
          recovered.push(row.id)
          continue
        }
        const permissionRecovery = interruptedPermission
          ? permissionDispatchRecoveryCode('commit')
          : existingPermissionRecovery === undefined
            ? undefined
            : permissionDispatchRecoveryCode(existingPermissionRecovery)
        const ambiguous = row.failure_code === 'dispatch-started' && permissionRecovery === undefined
        const exhausted = row.attempt_count >= input.maxAttempts && permissionRecovery === undefined
        const changed = this.database.prepare(`
          UPDATE inbox_messages SET status = ?, next_attempt_at = ?, claimed_by = NULL,
            fencing_token = NULL, lease_until = NULL, failure_code = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND lease_until <= ?
        `).run(ambiguous || exhausted ? 'dead_letter' : 'retry_wait', ambiguous || exhausted ? null : now,
          ambiguous ? 'dispatch-ambiguous' : permissionRecovery ?? 'lease-expired', now, row.id, now)
        if (changed.changes !== 1) continue
        this.database.prepare(`
          UPDATE inbox_attempts SET status = 'lost', failure_code = 'lease-expired', finished_at = ?
          WHERE inbox_id = ? AND status = 'claimed'
        `).run(now, row.id)
        recovered.push(row.id)
      }
    })
    return recovered.map(id => this.getInbox(id)!)
  }

  enqueue(input: OutboundIntent): OutboxRecord {
    this.assertOpen()
    const binding = this.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active') {
      throw new DeliveryStoreError('invalid-intent', 'outbound intent requires an active binding')
    }
    const intent = canonicalIntent(input, binding, this.maxTextBytes)
    if (intent.idempotencyKey.startsWith('inbound:') && intent.idempotencyKey.endsWith(':reply')) {
      const replyEventId = intent.replyToEventId
      const inbox = replyEventId === undefined
        ? undefined
        : this.getInboxByProviderEvent(
            binding.conversation.channel,
            binding.conversation.account,
            replyEventId,
          )
      const currentKey = inbox === undefined ? undefined : `inbound:${inbox.id}:reply`
      const legacyKey = replyEventId === undefined ? undefined : `inbound:${replyEventId}:reply`
      if (inbox === undefined
        || inbox.bindingId !== binding.id
        || conversationHash(inbox.envelope.conversation) !== conversationHash(binding.conversation)
        || principalHash(inbox.envelope.principal) !== principalHash(binding.principal)
        || (intent.idempotencyKey !== currentKey && intent.idempotencyKey !== legacyKey)) {
        throw new DeliveryStoreError(
          'invalid-intent',
          'inbound reply idempotency namespace requires the exact bound Inbox event',
        )
      }
    }
    const json = JSON.stringify(intent)
    const hash = digest(json)
    const existing = this.database.prepare(`${outboxSelect} WHERE idempotency_key = ?`)
      .get(intent.idempotencyKey) as OutboxRow | undefined
    if (existing !== undefined) {
      if (existing.intent_hash !== hash) {
        throw new DeliveryStoreError('idempotency-conflict', 'outbox idempotency key was reused with a different intent')
      }
      return outboxFromRow(existing)
    }
    const now = this.now()
    const id = `outbox_${randomUUID()}`
    try {
      this.database.prepare(`
        INSERT INTO outbox_messages (
          id, idempotency_key, binding_id, intent_hash, intent_json, channel, account, lane_hash,
          status, attempt_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)
      `).run(
        id,
        intent.idempotencyKey,
        intent.bindingId,
        hash,
        json,
        intent.target.conversation.channel,
        intent.target.conversation.account,
        conversationHash(intent.target.conversation),
        now,
        now,
      )
    } catch (error) {
      const winner = this.database.prepare(`${outboxSelect} WHERE idempotency_key = ?`)
        .get(intent.idempotencyKey) as OutboxRow | undefined
      if (winner !== undefined && winner.intent_hash === hash) return outboxFromRow(winner)
      throw error
    }
    return this.getOutbox(id)!
  }

  getOutbox(id: string): OutboxRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${outboxSelect} WHERE id = ?`).get(id) as OutboxRow | undefined
    return row === undefined ? undefined : outboxFromRow(row)
  }

  getApprovalIntent(operationId: string, bindingId: string): NonNullable<OutboundIntent['approval']> | undefined {
    this.assertOpen()
    const operation = validateBindingText(operationId, 'operationId', 256)
    const binding = validateBindingText(bindingId, 'bindingId', 256)
    const row = this.database.prepare(`${outboxSelect}
      WHERE json_extract(intent_json, '$.bindingId') = ?
        AND json_extract(intent_json, '$.approval.operationId') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(binding, operation) as OutboxRow | undefined
    return row === undefined ? undefined : outboxFromRow(row).intent.approval
  }

  getModelPicker(operationId: string, bindingId: string): ModelPickerIntent | undefined {
    this.assertOpen()
    const operation = validateBindingText(operationId, 'operationId', 256)
    const binding = validateBindingText(bindingId, 'bindingId', 256)
    const row = this.database.prepare(`${outboxSelect}
      WHERE json_extract(intent_json, '$.bindingId') = ?
        AND json_extract(intent_json, '$.modelPicker.operationId') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(binding, operation) as OutboxRow | undefined
    return row === undefined ? undefined : outboxFromRow(row).intent.modelPicker
  }

  getPermissionPicker(operationId: string, bindingId: string): PermissionPickerIntent | undefined {
    return this.getPermissionPickerRecord(operationId, bindingId)?.intent.permissionPicker
  }

  getPermissionPickerRecord(operationId: string, bindingId: string): OutboxRecord | undefined {
    this.assertOpen()
    const operation = validateBindingText(operationId, 'operationId', 256)
    const bindingKey = validateBindingText(bindingId, 'bindingId', 256)
    const row = this.database.prepare(`${outboxSelect}
      WHERE binding_id = ? AND json_valid(intent_json)
        AND json_extract(intent_json, '$.permissionPicker.operationId') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(bindingKey, operation) as OutboxRow | undefined
    if (row === undefined) return undefined
    const binding = this.getBinding(bindingKey)
    if (binding === undefined) throw new DeliveryStoreError('invalid-intent', 'permission picker binding does not exist')
    const record = outboxFromRow(row)
    const intent = canonicalIntent(record.intent, binding, this.maxTextBytes)
    if (intent.format !== 'permission-picker' || intent.permissionPicker?.operationId !== operation
      || digest(JSON.stringify(intent)) !== record.intentHash) {
      throw new DeliveryStoreError('invalid-intent', 'persisted permission picker intent is invalid')
    }
    return { ...record, intent }
  }

  getModelPickerState(operationId: string, bindingId: string): ModelPickerState | undefined {
    this.assertOpen()
    const operation = validateBindingText(operationId, 'operationId', 512)
    const binding = validateBindingText(bindingId, 'bindingId', 256)
    const row = this.database.prepare(`
      SELECT binding_id, revision, provider, model, reasoning_effort
      FROM model_picker_states WHERE operation_id = ? AND binding_id = ?
    `).get(operation, binding) as ModelPickerStateRow | undefined
    return row === undefined ? undefined : modelPickerStateFromRow(row)
  }

  advanceModelPicker(input: {
    operationId: string
    bindingId: string
    expected: ModelPickerState
    next: ModelRouteRef
  }): { applied: boolean; state: ModelPickerState } {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    const bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
    const expected = canonicalModelPickerState(input.expected)
    const next = canonicalModelRoute(input.next)
    const binding = this.getBinding(bindingId)
    if (binding?.status !== 'active') {
      throw new DeliveryStoreError('invalid-binding', 'model picker requires an active binding')
    }
    return this.transaction(() => {
      const settlement = this.database.prepare(`
        SELECT operation_id FROM model_selection_settlements WHERE operation_id = ?
      `).get(operationId)
      if (settlement !== undefined) {
        throw new DeliveryStoreError('idempotency-conflict', 'model picker is already being settled')
      }
      const row = this.database.prepare(`
        SELECT binding_id, revision, provider, model, reasoning_effort
        FROM model_picker_states WHERE operation_id = ?
      `).get(operationId) as ModelPickerStateRow | undefined
      if (row === undefined) {
        if (expected.revision !== 0) {
          throw new DeliveryStoreError('version-conflict', 'model picker state does not exist at the expected revision')
        }
        const now = this.now()
        this.database.prepare(`
          INSERT INTO model_picker_states (
            operation_id, binding_id, revision, provider, model, reasoning_effort, created_at, updated_at
          ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)
        `).run(operationId, bindingId, next.provider, next.model, next.reasoningEffort ?? null, now, now)
        return { applied: true, state: { ...next, revision: 1 } }
      }
      if (row.binding_id !== bindingId) {
        throw new DeliveryStoreError('idempotency-conflict', 'model picker operation belongs to another binding')
      }
      const current = modelPickerStateFromRow(row)
      if (!sameModelPickerState(current, expected)) return { applied: false, state: current }
      if (current.revision >= Number.MAX_SAFE_INTEGER) {
        throw new DeliveryStoreError('version-conflict', 'model picker revision is exhausted')
      }
      const now = this.now()
      const revision = current.revision + 1
      const changed = this.database.prepare(`
        UPDATE model_picker_states
        SET revision = ?, provider = ?, model = ?, reasoning_effort = ?, updated_at = ?
        WHERE operation_id = ? AND binding_id = ? AND revision = ?
      `).run(revision, next.provider, next.model, next.reasoningEffort ?? null,
        now, operationId, bindingId, current.revision)
      if (changed.changes !== 1) {
        throw new DeliveryStoreError('version-conflict', 'model picker state changed during navigation')
      }
      return { applied: true, state: { ...next, revision } }
    })
  }

  listOutbox(input: { bindingId?: string; limit?: number } = {}): OutboxRecord[] {
    this.assertOpen()
    const limit = Math.max(1, Math.min(100, input.limit ?? 20))
    const rows = input.bindingId === undefined
      ? this.database.prepare(`${outboxSelect} ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit)
      : this.database.prepare(`${outboxSelect} WHERE json_extract(intent_json, '$.bindingId') = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(input.bindingId, limit)
    return (rows as unknown as OutboxRow[]).map(outboxFromRow)
  }

  claimOutbox(input: {
    ownerId: string
    leaseMs: number
    limit: number
    maxAttempts: number
    /** Undefined preserves the legacy store-level behavior; an empty list parks every unknown lane. */
    unknownReconcileRoutes?: readonly Readonly<{ channel: string; account: string }>[]
    /** Locally active work that must not be reclaimed even if its durable lease was externally lost. */
    excludeIds?: readonly string[]
    maintenanceLimit?: number
  }): { record: OutboxRecord; fencingToken: number; mode: 'reconcile' | 'send' }[] {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) throw new DeliveryStoreError('conflict', 'invalid outbox lease')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new DeliveryStoreError('conflict', 'invalid outbox claim limit')
    }
    if (!Number.isSafeInteger(input.maxAttempts) || input.maxAttempts < 1 || input.maxAttempts > 100) {
      throw new DeliveryStoreError('conflict', 'invalid outbox max attempts')
    }
    if ((input.unknownReconcileRoutes?.length ?? 0) > 100 || (input.excludeIds?.length ?? 0) > 100) {
      throw new DeliveryStoreError('conflict', 'outbox claim routes and exclusions must be bounded')
    }
    const maintenanceLimit = boundedMaintenanceLimit(input.maintenanceLimit, input.limit, 'outbox')
    const routes = input.unknownReconcileRoutes?.map(route => ({
      channel: validateBindingText(route.channel, 'channel', 128),
      account: validateBindingText(route.account, 'account', 128),
    }))
    const excludeIds = input.excludeIds?.map(id => validateBindingText(id, 'outboxId', 256)) ?? []
    const routeClause = routes === undefined
      ? ''
      : routes.length === 0
        ? "AND candidate.status <> 'unknown_after_send'"
        : `AND (candidate.status <> 'unknown_after_send' OR (${routes
          .map(() => '(candidate.channel = ? AND candidate.account = ?)').join(' OR ')}))`
    const excludeClause = excludeIds.length === 0
      ? ''
      : `AND candidate.id NOT IN (${excludeIds.map(() => '?').join(', ')})`
    const routeParameters = routes?.flatMap(route => [route.channel, route.account]) ?? []
    const now = this.now()
    const claims: { record: OutboxRecord; fencingToken: number; mode: 'reconcile' | 'send' }[] = []
    this.transaction(() => {
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = 'attempts-exhausted',
          next_attempt_at = NULL, updated_at = ?
        WHERE rowid IN (
          SELECT candidate.rowid FROM outbox_messages AS candidate
          WHERE candidate.status = 'retry_wait' AND candidate.next_attempt_at <= ?
            AND (
              SELECT COUNT(*) FROM outbox_attempts AS history
              WHERE history.outbox_id = candidate.id AND history.operation = 'send'
            ) >= ?
          ORDER BY candidate.rowid LIMIT ?
        )
      `).run(now, now, input.maxAttempts, maintenanceLimit)
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = 'reconcile-attempts-exhausted',
          next_attempt_at = NULL, updated_at = ?
        WHERE rowid IN (
          SELECT candidate.rowid FROM outbox_messages AS candidate
          WHERE candidate.status = 'unknown_after_send'
            AND (
              SELECT COUNT(*) FROM outbox_attempts AS history
              WHERE history.outbox_id = candidate.id AND history.operation = 'reconcile'
            ) >= ?
          ORDER BY candidate.rowid LIMIT ?
        )
      `).run(now, input.maxAttempts, maintenanceLimit)
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = CASE
            WHEN status = 'unknown_after_send' THEN 'binding-revoked-unknown'
            ELSE 'binding-revoked'
          END,
          next_attempt_at = NULL, updated_at = ?
        WHERE rowid IN (
          SELECT candidate.rowid FROM outbox_messages AS candidate
          WHERE candidate.status IN ('pending', 'retry_wait', 'unknown_after_send')
            AND NOT EXISTS (
              SELECT 1 FROM conversation_bindings AS binding
              WHERE binding.id = candidate.binding_id AND binding.status = 'active'
            )
          ORDER BY candidate.rowid LIMIT ?
        )
      `).run(now, maintenanceLimit)
      const candidates = this.database.prepare(`
        SELECT candidate.id, candidate.status FROM outbox_messages AS candidate
        WHERE candidate.status IN ('pending', 'retry_wait', 'unknown_after_send')
          AND candidate.claimed_by IS NULL
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND (
            candidate.status = 'pending'
            OR (candidate.status = 'retry_wait' AND (
              SELECT COUNT(*) FROM outbox_attempts AS history
              WHERE history.outbox_id = candidate.id AND history.operation = 'send'
            ) < ?)
            OR (candidate.status = 'unknown_after_send' AND (
              SELECT COUNT(*) FROM outbox_attempts AS history
              WHERE history.outbox_id = candidate.id AND history.operation = 'reconcile'
            ) < ?)
          )
          AND EXISTS (
            SELECT 1 FROM conversation_bindings AS binding
            WHERE binding.id = candidate.binding_id AND binding.status = 'active'
          )
          ${routeClause}
          ${excludeClause}
          AND NOT EXISTS (
            SELECT 1 FROM outbox_messages AS earlier
            WHERE earlier.lane_hash = candidate.lane_hash
              AND earlier.rowid < candidate.rowid
              AND earlier.status NOT IN ('accepted', 'delivered', 'read', 'dead')
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox_messages AS active
            WHERE active.lane_hash = candidate.lane_hash AND active.status = 'attempting'
          )
        ORDER BY candidate.rowid
        LIMIT ?
      `).all(now, input.maxAttempts, input.maxAttempts, ...routeParameters, ...excludeIds, input.limit) as unknown as {
        id: string; status: OutboxRecord['status']
      }[]
      for (const candidate of candidates) {
        const current = this.getOutbox(candidate.id)!
        const mode = candidate.status === 'unknown_after_send' ? 'reconcile' : 'send'
        const fencingToken = current.attemptCount + 1
        const changed = this.database.prepare(`
          UPDATE outbox_messages SET status = 'attempting', claimed_by = ?, fencing_token = ?, lease_until = ?,
            attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?
          WHERE id = ? AND status = ? AND claimed_by IS NULL
        `).run(ownerId, fencingToken, now + input.leaseMs, now, current.id, candidate.status)
        if (changed.changes !== 1) continue
        this.database.prepare(`
          INSERT INTO outbox_attempts (
            id, outbox_id, attempt_number, owner_id, fencing_token, operation, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'attempting', ?)
        `).run(`outbox_attempt_${randomUUID()}`, current.id, fencingToken, ownerId, fencingToken, mode, now)
        claims.push({ record: this.getOutbox(current.id)!, fencingToken, mode })
      }
    })
    return claims
  }

  renewOutboxClaim(input: {
    outboxId: string
    ownerId: string
    fencingToken: number
    leaseMs: number
  }): boolean {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new DeliveryStoreError('stale-fence', 'outbox lease renewal is invalid')
    }
    const now = this.now()
    return this.database.prepare(`
      UPDATE outbox_messages SET lease_until = ?, updated_at = ?
      WHERE id = ? AND status = 'attempting' AND claimed_by = ? AND fencing_token = ? AND lease_until > ?
    `).run(now + input.leaseMs, now, input.outboxId, ownerId, input.fencingToken, now).changes === 1
  }

  finishOutbox(input: {
    outboxId: string
    ownerId: string
    fencingToken: number
    outcome: 'accepted' | 'dead' | 'retry_wait' | 'unknown_after_send'
    providerMessageId?: string
    failureCode?: string
    retryAt?: number
  }): OutboxRecord {
    this.assertOpen()
    const now = this.now()
    if (input.outcome === 'accepted' && input.providerMessageId === undefined) {
      throw new DeliveryStoreError('conflict', 'accepted delivery requires a provider message id')
    }
    if (input.outcome === 'retry_wait' && (!Number.isSafeInteger(input.retryAt) || input.retryAt! < now)) {
      throw new DeliveryStoreError('conflict', 'retry_wait requires a current or future retryAt')
    }
    let providerMessageId: string | null = null
    if (input.providerMessageId !== undefined) {
      try {
        providerMessageId = validateBindingText(input.providerMessageId, 'providerMessageId', 512)
      } catch {
        throw new DeliveryStoreError('conflict', 'provider message id is invalid')
      }
    }
    this.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE outbox_messages SET status = ?, provider_message_id = COALESCE(?, provider_message_id),
          next_attempt_at = ?, claimed_by = NULL, fencing_token = NULL, lease_until = NULL,
          failure_code = ?, updated_at = ?
        WHERE id = ? AND status = 'attempting' AND claimed_by = ? AND fencing_token = ? AND lease_until > ?
      `).run(
        input.outcome,
        providerMessageId,
        input.outcome === 'retry_wait' ? input.retryAt! : null,
        input.failureCode ?? null,
        now,
        input.outboxId,
        input.ownerId,
        input.fencingToken,
        now,
      )
      if (changed.changes !== 1) throw new DeliveryStoreError('stale-fence', 'outbox completion has a stale fence')
      this.database.prepare(`
        UPDATE outbox_attempts SET status = ?, provider_message_id = ?, failure_code = ?, finished_at = ?
        WHERE outbox_id = ? AND owner_id = ? AND fencing_token = ? AND status = 'attempting'
      `).run(input.outcome, providerMessageId, input.failureCode ?? null, now,
        input.outboxId, input.ownerId, input.fencingToken)
    })
    return this.getOutbox(input.outboxId)!
  }

  recoverOutbox(input: { maxAttempts: number; limit?: number }): OutboxRecord[] {
    this.assertOpen()
    const limit = boundedMaintenanceLimit(input.limit, 100, 'outbox recovery')
    const now = this.now()
    const recovered: string[] = []
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM outbox_messages WHERE status = 'attempting' AND lease_until <= ? ORDER BY rowid LIMIT ?
      `).all(now, limit) as unknown as { id: string }[]
      for (const row of rows) {
        const changed = this.database.prepare(`
          UPDATE outbox_messages SET status = 'unknown_after_send', claimed_by = NULL, fencing_token = NULL,
            lease_until = NULL, next_attempt_at = NULL, failure_code = 'attempt-lease-expired', updated_at = ?
          WHERE id = ? AND status = 'attempting' AND lease_until <= ?
        `).run(now, row.id, now)
        if (changed.changes !== 1) continue
        this.database.prepare(`
          UPDATE outbox_attempts SET status = 'unknown_after_send', failure_code = 'attempt-lease-expired', finished_at = ?
          WHERE outbox_id = ? AND status = 'attempting'
        `).run(now, row.id)
        recovered.push(row.id)
      }
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = 'attempts-exhausted', next_attempt_at = NULL,
          updated_at = ? WHERE rowid IN (
            SELECT candidate.rowid FROM outbox_messages AS candidate
            WHERE candidate.status = 'retry_wait' AND candidate.next_attempt_at <= ?
              AND (
                SELECT COUNT(*) FROM outbox_attempts AS history
                WHERE history.outbox_id = candidate.id AND history.operation = 'send'
              ) >= ?
            ORDER BY candidate.rowid LIMIT ?
          )
      `).run(now, now, input.maxAttempts, limit)
    })
    return recovered.map(id => this.getOutbox(id)!)
  }

  recordReceipt(input: DeliveryReceipt): OutboxRecord {
    this.assertOpen()
    let channel: string
    let account: string
    let providerMessageId: string
    try {
      channel = validateBindingText(input.channel, 'channel', 256)
      account = validateBindingText(input.account, 'account', 256)
      providerMessageId = validateBindingText(input.providerMessageId, 'providerMessageId', 512)
    } catch {
      throw new DeliveryStoreError('receipt-mismatch', 'receipt identifiers are invalid')
    }
    if (!['accepted', 'delivered', 'read'].includes(input.status) || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
      throw new DeliveryStoreError('receipt-mismatch', 'receipt status or time is invalid')
    }
    const metadata = canonicalMetadata(input.metadata, 'receipt')
    const receipt: DeliveryReceipt = { channel, account, providerMessageId, status: input.status,
      occurredAt: input.occurredAt, ...(metadata === undefined ? {} : { metadata }) }
    const json = JSON.stringify(receipt)
    const hash = digest(json)
    const row = this.database.prepare(`
      SELECT id FROM outbox_messages WHERE channel = ? AND account = ? AND provider_message_id = ?
    `).get(channel, account, providerMessageId) as { id: string } | undefined
    if (row === undefined) throw new DeliveryStoreError('receipt-mismatch', 'receipt does not match an outbox attempt')
    const existing = this.database.prepare(`
      SELECT receipt_hash FROM delivery_receipts
      WHERE channel = ? AND account = ? AND provider_message_id = ? AND status = ?
    `).get(channel, account, providerMessageId, input.status) as { receipt_hash: string } | undefined
    if (existing !== undefined) {
      if (existing.receipt_hash !== hash) {
        throw new DeliveryStoreError('idempotency-conflict', 'receipt status was reused with changed content')
      }
      return this.getOutbox(row.id)!
    }
    const now = this.now()
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO delivery_receipts (
          id, channel, account, provider_message_id, status, receipt_hash, receipt_json, occurred_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(`receipt_${randomUUID()}`, channel, account, providerMessageId, input.status, hash, json, input.occurredAt, now)
      const current = this.getOutbox(row.id)!
      const rank: Record<string, number> = { accepted: 1, delivered: 2, read: 3 }
      if ((rank[input.status] ?? 0) > (rank[current.status] ?? 0)) {
        this.database.prepare('UPDATE outbox_messages SET status = ?, updated_at = ? WHERE id = ?')
          .run(input.status, now, row.id)
      }
    })
    return this.getOutbox(row.id)!
  }

  revokePrincipal(id: string, expectedVersion: number): DeliveryPrincipal {
    this.assertOpen()
    const now = this.now()
    return this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE delivery_principals SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE id = ? AND version = ?
      `).run(now, id, expectedVersion)
      if (result.changes !== 1) {
        throw new DeliveryStoreError('version-conflict', 'principal version changed or does not exist')
      }
      this.database.prepare(`
        UPDATE conversation_bindings SET status = 'revoked', updated_at = ?, version = version + 1
        WHERE principal_id = ? AND status = 'active'
      `).run(now, id)
      const row = this.database.prepare(`
        SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
        FROM delivery_principals WHERE id = ?
      `).get(id) as unknown as PrincipalRow
      return principalFromRow(row)
    })
  }

  linkPrincipal(input: {
    owner: ExternalPrincipalKey
    linked: ExternalPrincipalKey
    expectedLinkedVersion: number
  }): DeliveryPrincipal {
    this.assertOpen()
    const owner = this.getPrincipal(input.owner)
    const linked = this.getPrincipal(input.linked)
    if (owner?.status !== 'active' || owner.role !== 'owner') {
      throw new DeliveryStoreError('unauthorized-principal', 'principal link requires an active owner')
    }
    if (linked?.status !== 'active' || linked.id === owner.id) {
      throw new DeliveryStoreError('unauthorized-principal', 'linked principal must be a distinct active principal')
    }
    if (linked.version !== input.expectedLinkedVersion) {
      throw new DeliveryStoreError('version-conflict', 'linked principal version changed')
    }
    if (linked.linkedToId === owner.id) return linked
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE delivery_principals SET role = 'linked', linked_to_id = ?, updated_at = ?, version = version + 1
      WHERE id = ? AND version = ? AND status = 'active'
    `).run(owner.id, now, linked.id, input.expectedLinkedVersion)
    if (changed.changes !== 1) throw new DeliveryStoreError('version-conflict', 'linked principal version changed')
    return this.getPrincipal(input.linked)!
  }

  resolveInbox(input: {
    inboxId: string
    expectedAttemptCount: number
    resolution: 'cancel' | 'retry'
  }): InboxRecord {
    this.assertOpen()
    const current = this.getInbox(input.inboxId)
    if (current?.status !== 'dead_letter' || current.attemptCount !== input.expectedAttemptCount) {
      throw new DeliveryStoreError('version-conflict', 'dead-letter inbox attempt count or state changed')
    }
    if (input.resolution === 'retry') {
      const binding = current.bindingId === undefined ? undefined : this.getBinding(current.bindingId)
      if (binding?.status !== 'active') throw new DeliveryStoreError('conflict', 'dead-letter inbox has no active binding')
    }
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE inbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND status = 'dead_letter' AND attempt_count = ?
    `).run(input.resolution === 'retry' ? 'queued' : 'dead_letter',
      input.resolution === 'retry' ? null : 'operator-cancelled', now, input.inboxId, input.expectedAttemptCount)
    if (changed.changes !== 1) throw new DeliveryStoreError('version-conflict', 'dead-letter inbox changed')
    return this.getInbox(input.inboxId)!
  }

  resolveOutbox(input: {
    outboxId: string
    expectedAttemptCount: number
    resolution: 'cancel' | 'retry'
  }): OutboxRecord {
    this.assertOpen()
    return this.transaction(() => {
      const current = this.getOutbox(input.outboxId)
      if (current === undefined || !['dead', 'unknown_after_send'].includes(current.status)
        || current.attemptCount !== input.expectedAttemptCount) {
        throw new DeliveryStoreError('version-conflict', 'outbox attempt count or resolvable state changed')
      }
      if (input.resolution === 'retry') {
        const binding = this.getBinding(current.intent.bindingId)
        if (binding?.status !== 'active') {
          throw new DeliveryStoreError('conflict', 'resolvable outbox has no active binding')
        }
      }
      const now = this.now()
      const changed = this.database.prepare(`
        UPDATE outbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL,
          claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND attempt_count = ?
      `).run(input.resolution === 'retry' ? 'pending' : 'dead',
        input.resolution === 'retry' ? null : 'operator-cancelled', now,
        input.outboxId, current.status, input.expectedAttemptCount)
      if (changed.changes !== 1) throw new DeliveryStoreError('version-conflict', 'resolvable outbox changed')
      return this.getOutbox(input.outboxId)!
    })
  }

  beginApprovalSettlement(input: { operationId: string; payload: unknown; createIfMissing?: boolean }): {
    payloadHash: string
    replayed: boolean
    result?: unknown
  } {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    const payloadJson = JSON.stringify(input.payload)
    if (payloadJson === undefined || payloadJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'approval settlement payload is invalid or too large')
    }
    const payloadHash = digest(payloadJson)
    const selectSettlement = this.database.prepare(`
      SELECT payload_hash, payload_json, status, result_json FROM approval_settlements WHERE operation_id = ?
    `)
    const readSettlement = () => selectSettlement.get(operationId) as {
      payload_hash: string
      payload_json: string
      status: 'completed' | 'pending'
      result_json: string | null
    } | undefined
    const replay = (existing: ReturnType<typeof readSettlement>) => {
      if (existing === undefined) {
        throw new DeliveryStoreError('version-conflict', 'approval settlement winner disappeared')
      }
      if (existing.payload_hash !== payloadHash || existing.payload_json !== payloadJson) {
        throw new DeliveryStoreError('idempotency-conflict', 'approval operation id was reused with a different payload')
      }
      return { payloadHash, replayed: true,
        ...(existing.result_json === null ? {} : { result: JSON.parse(existing.result_json) as unknown }) }
    }
    const existing = readSettlement()
    if (existing !== undefined) {
      return replay(existing)
    }
    if (input.createIfMissing === false) {
      throw new DeliveryStoreError('not-found', 'approval settlement has no durable operation to recover')
    }
    const now = this.now()
    const inserted = this.database.prepare(`
      INSERT INTO approval_settlements (
        operation_id, payload_hash, payload_json, status, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING
    `).run(operationId, payloadHash, payloadJson, now, now)
    if (inserted.changes !== 1) return replay(readSettlement())
    return { payloadHash, replayed: false }
  }

  completeApprovalSettlement(input: { operationId: string; payloadHash: string; result: unknown }): unknown {
    this.assertOpen()
    const resultJson = JSON.stringify(input.result)
    if (resultJson === undefined || resultJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'approval settlement result is invalid or too large')
    }
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE approval_settlements SET status = 'completed', result_json = ?, updated_at = ?
      WHERE operation_id = ? AND payload_hash = ? AND status = 'pending'
    `).run(resultJson, now, input.operationId, input.payloadHash)
    if (changed.changes !== 1) {
      const replay = this.database.prepare(`
        SELECT result_json FROM approval_settlements
        WHERE operation_id = ? AND payload_hash = ? AND status = 'completed'
      `).get(input.operationId, input.payloadHash) as { result_json: string } | undefined
      if (replay !== undefined) return JSON.parse(replay.result_json) as unknown
      throw new DeliveryStoreError('version-conflict', 'approval settlement changed before completion')
    }
    return JSON.parse(resultJson) as unknown
  }

  beginModelSelectionSettlement(input: {
    operationId: string
    bindingId: string
    expected: ModelPickerState
    payload: unknown
    createIfMissing?: boolean
  }): {
    payloadHash: string
    replayed: boolean
    status: 'completed' | 'pending'
    result?: unknown
  } {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    const bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
    const expected = canonicalModelPickerState(input.expected)
    const payloadJson = JSON.stringify({ bindingId, expected, payload: input.payload })
    if (payloadJson === undefined || payloadJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'model selection settlement payload is invalid or too large')
    }
    const payloadHash = digest(payloadJson)
    const binding = this.getBinding(bindingId)
    if (binding?.status !== 'active') {
      throw new DeliveryStoreError('invalid-binding', 'model selection requires an active binding')
    }
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT binding_id, conversation_hash, command_epoch, payload_hash, status, result_json,
          attempt_count, claimed_by, lease_until
        FROM model_selection_settlements WHERE operation_id = ?
      `).get(operationId) as ModelSelectionSettlementRow | undefined
      if (existing !== undefined) {
        if (existing.binding_id !== bindingId || existing.payload_hash !== payloadHash) {
          throw new DeliveryStoreError('idempotency-conflict', 'model selection operation was reused with a different payload')
        }
        return { payloadHash, replayed: true,
          status: existing.status === 'completed' ? 'completed' as const : 'pending' as const,
          ...(existing.result_json === null ? {} : { result: JSON.parse(existing.result_json) as unknown }) }
      }
      if (input.createIfMissing === false) {
        throw new DeliveryStoreError('not-found', 'expired model selection has no pending settlement to resume')
      }
      const row = this.database.prepare(`
        SELECT binding_id, revision, provider, model, reasoning_effort
        FROM model_picker_states WHERE operation_id = ?
      `).get(operationId) as ModelPickerStateRow | undefined
      if (row === undefined) {
        if (expected.revision !== 0) {
          throw new DeliveryStoreError('version-conflict', 'model picker state does not exist at the expected revision')
        }
      } else {
        if (row.binding_id !== bindingId) {
          throw new DeliveryStoreError('idempotency-conflict', 'model picker operation belongs to another binding')
        }
        if (!sameModelPickerState(modelPickerStateFromRow(row), expected)) {
          throw new DeliveryStoreError('version-conflict', 'model picker confirmation used a stale revision')
        }
      }
      const now = this.now()
      const commandEpoch = this.advanceModelCommandEpoch(binding.conversation)
      this.database.prepare(`
        INSERT INTO model_selection_settlements (
          operation_id, binding_id, conversation_hash, command_epoch, payload_hash,
          payload_json, status, result_json, outbox_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)
      `).run(operationId, bindingId, conversationHash(binding.conversation), commandEpoch,
        payloadHash, payloadJson, now, now)
      return { payloadHash, replayed: false, status: 'pending' as const }
    })
  }

  claimModelSelectionSettlements(input: {
    ownerId: string
    leaseMs: number
    limit?: number
  }): Array<{
    operationId: string
    bindingId: string
    payloadHash: string
    payload: unknown
    fencingToken: number
  }> {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new DeliveryStoreError('conflict', 'model selection lease is invalid')
    }
    const limit = input.limit ?? 10
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new DeliveryStoreError('conflict', 'model selection claim limit is invalid')
    }
    const now = this.now()
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE model_selection_settlements
        SET status = 'pending', claimed_by = NULL, lease_until = NULL, updated_at = ?
        WHERE status = 'processing' AND lease_until <= ?
      `).run(now, now)
      const rows = this.database.prepare(`
        SELECT operation_id, binding_id, payload_hash, payload_json, attempt_count
        FROM model_selection_settlements
        WHERE status = 'pending'
        ORDER BY created_at, operation_id LIMIT ?
      `).all(limit) as unknown as Array<{
        operation_id: string
        binding_id: string
        payload_hash: string
        payload_json: string
        attempt_count: number
      }>
      const claims: Array<{
        operationId: string
        bindingId: string
        payloadHash: string
        payload: unknown
        fencingToken: number
      }> = []
      for (const row of rows) {
        const fencingToken = row.attempt_count + 1
        const changed = this.database.prepare(`
          UPDATE model_selection_settlements
          SET status = 'processing', attempt_count = ?, claimed_by = ?, lease_until = ?, updated_at = ?
          WHERE operation_id = ? AND status = 'pending'
        `).run(fencingToken, ownerId, now + input.leaseMs, now, row.operation_id)
        if (changed.changes !== 1) continue
        const stored = JSON.parse(row.payload_json) as { payload?: unknown }
        claims.push({ operationId: row.operation_id, bindingId: row.binding_id,
          payloadHash: row.payload_hash, payload: stored.payload, fencingToken })
      }
      return claims
    })
  }

  nextModelSelectionClaimAt(): number | undefined {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT status, lease_until FROM model_selection_settlements
      WHERE status IN ('pending', 'processing')
      ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE lease_until END, created_at
      LIMIT 1
    `).get() as { status: 'pending' | 'processing'; lease_until: number | null } | undefined
    if (row === undefined) return undefined
    return row.status === 'pending' ? this.now() : row.lease_until ?? this.now()
  }

  renewModelSelectionSettlement(input: {
    operationId: string
    ownerId: string
    fencingToken: number
    leaseMs: number
  }): boolean {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 256)
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1
      || !Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new DeliveryStoreError('stale-fence', 'model selection lease renewal is invalid')
    }
    const now = this.now()
    return this.database.prepare(`
      UPDATE model_selection_settlements SET lease_until = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'processing' AND claimed_by = ?
        AND attempt_count = ? AND lease_until > ?
    `).run(now + input.leaseMs, now, operationId, ownerId, input.fencingToken, now).changes === 1
  }

  completeModelSelectionSettlement(input: {
    operationId: string
    payloadHash: string
    result: unknown
    selection?: { conversation: ConversationRef; route: ModelRouteRef }
    reply?: OutboundIntent
    superseded?: { result: unknown; reply?: OutboundIntent }
    ownerId?: string
    fencingToken?: number
  }): unknown {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    if (!/^[a-f0-9]{64}$/u.test(input.payloadHash)) {
      throw new DeliveryStoreError('conflict', 'model selection payload hash is invalid')
    }
    const resultJson = JSON.stringify(input.result)
    if (resultJson === undefined || resultJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'model selection settlement result is invalid or too large')
    }
    const supersededResultJson = input.superseded === undefined ? resultJson : JSON.stringify(input.superseded.result)
    if (supersededResultJson === undefined || supersededResultJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'superseded model selection result is invalid or too large')
    }
    const ownerId = input.ownerId === undefined ? undefined : validateBindingText(input.ownerId, 'ownerId', 256)
    if ((ownerId === undefined) !== (input.fencingToken === undefined)
      || (input.fencingToken !== undefined && (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1))) {
      throw new DeliveryStoreError('stale-fence', 'model selection completion fence is invalid')
    }
    return this.transaction(() => {
      const current = this.database.prepare(`
        SELECT settlement.binding_id, settlement.conversation_hash, settlement.command_epoch,
          settlement.payload_hash, settlement.status, settlement.result_json,
          settlement.attempt_count, settlement.claimed_by, settlement.lease_until,
          binding.status AS binding_status, principal.status AS principal_status
        FROM model_selection_settlements AS settlement
        JOIN conversation_bindings AS binding ON binding.id = settlement.binding_id
        JOIN delivery_principals AS principal ON principal.id = binding.principal_id
        WHERE settlement.operation_id = ?
      `).get(operationId) as ModelSelectionSettlementCompletionRow | undefined
      if (current?.payload_hash !== input.payloadHash) {
        throw new DeliveryStoreError('version-conflict', 'model selection settlement does not match the pending operation')
      }
      if (current.status === 'completed') {
        if (current.result_json === null) {
          throw new DeliveryStoreError('version-conflict', 'completed model selection settlement has no result')
        }
        return JSON.parse(current.result_json) as unknown
      }
      if (ownerId !== undefined && (current.status !== 'processing' || current.claimed_by !== ownerId
        || current.attempt_count !== input.fencingToken || current.lease_until === null
        || current.lease_until <= this.now())) {
        throw new DeliveryStoreError('stale-fence', 'model selection completion lost its lease')
      }
      if (ownerId === undefined && current.status !== 'pending') {
        throw new DeliveryStoreError('version-conflict', 'model selection settlement is already being processed')
      }
      const epoch = this.database.prepare(`
        SELECT epoch FROM conversation_model_epochs WHERE conversation_hash = ?
      `).get(current.conversation_hash) as { epoch: number } | undefined
      const superseded = epoch?.epoch !== current.command_epoch
      const reply = superseded && input.superseded !== undefined ? input.superseded.reply : input.reply
      const completedResultJson = superseded ? supersededResultJson : resultJson
      if ((reply !== undefined || (!superseded && input.selection !== undefined))
        && (current.binding_status !== 'active' || current.principal_status !== 'active')) {
        throw new DeliveryStoreError('unauthorized-principal', 'model selection authority was revoked before completion')
      }
      if (reply !== undefined && reply.bindingId !== current.binding_id) {
        throw new DeliveryStoreError('conflict', 'model selection reply does not belong to the settlement binding')
      }
      if (!superseded && input.selection !== undefined) {
        if (reply === undefined) {
          throw new DeliveryStoreError('conflict', 'model selection cannot commit without a durable reply')
        }
        if (conversationJson(input.selection.conversation) !== conversationJson(reply.target.conversation)) {
          throw new DeliveryStoreError('conflict', 'model selection route and reply target different conversations')
        }
        this.setModelSelection(input.selection.conversation, input.selection.route)
      }
      const outbox = reply === undefined ? undefined : this.enqueue(reply)
      const now = this.now()
      const changed = this.database.prepare(`
        UPDATE model_selection_settlements
        SET status = 'completed', result_json = ?, outbox_id = ?, claimed_by = NULL,
          lease_until = NULL, updated_at = ?
        WHERE operation_id = ? AND payload_hash = ? AND status = ?
      `).run(completedResultJson, outbox?.id ?? null, now, operationId, input.payloadHash, current.status)
      if (changed.changes !== 1) {
        throw new DeliveryStoreError('version-conflict', 'model selection settlement changed before completion')
      }
      return JSON.parse(completedResultJson) as unknown
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private advanceModelCommandEpoch(conversation: ConversationRef): number {
    const hash = conversationHash(conversation)
    const json = conversationJson(conversation)
    const now = this.now()
    this.database.prepare(`
      INSERT INTO conversation_model_epochs (conversation_hash, conversation_json, epoch, updated_at)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(conversation_hash) DO UPDATE SET
        conversation_json = excluded.conversation_json,
        epoch = conversation_model_epochs.epoch + 1,
        updated_at = excluded.updated_at
    `).run(hash, json, now)
    return (this.database.prepare(`
      SELECT epoch FROM conversation_model_epochs
      WHERE conversation_hash = ? AND conversation_json = ?
    `).get(hash, json) as { epoch: number }).epoch
  }

  private nextBindingGenerationByHash(hash: string): number {
    const row = this.database.prepare(`
      SELECT COALESCE(MAX(generation), 0) AS maximum FROM conversation_bindings
      WHERE conversation_hash = ?
    `).get(hash) as { maximum: number }
    const generation = row.maximum + 1
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new DeliveryStoreError('conflict', 'conversation binding generation is exhausted')
    }
    return generation
  }

  private assertOpen(): void {
    if (this.closed) throw new DeliveryStoreError('conflict', 'delivery store is closed')
  }
}
