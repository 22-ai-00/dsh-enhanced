import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import { canonicalConversation, canonicalPrincipal, canonicalTarget } from './canonical.js'
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
  ModelRouteRef,
  OutboxRecord,
  PairingChallenge,
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
    'idempotencyKey', 'bindingId', 'target', 'text', 'format', 'approval', 'modelPicker', 'replyToEventId', 'metadata',
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
  if (format !== 'plain' && format !== 'markdown' && format !== 'approval' && format !== 'model-picker') {
    throw new DeliveryStoreError('invalid-intent', 'outbound format is invalid')
  }
  let approval: OutboundIntent['approval']
  if (format === 'approval') {
    const value = input.approval
    if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(field => !['operationId', 'proposalId', 'expectedVersion', 'expiresAt', 'title'].includes(field))) {
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
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) {
      throw new DeliveryStoreError('invalid-intent', 'approval intent version or expiry is invalid')
    }
    approval = { operationId, proposalId, expectedVersion: value.expectedVersion,
      expiresAt: value.expiresAt, title }
  } else if (input.approval !== undefined) {
    throw new DeliveryStoreError('invalid-intent', 'approval payload requires approval format')
  }
  let modelPicker: ModelPickerIntent | undefined
  if (format === 'model-picker') {
    modelPicker = canonicalModelPicker(input.modelPicker)
  } else if (input.modelPicker !== undefined) {
    throw new DeliveryStoreError('invalid-intent', 'model picker payload requires model-picker format')
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
    ...(replyToEventId === undefined ? {} : { replyToEventId }),
    ...(metadata === undefined ? {} : { metadata }) }
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
  private readonly now: () => number
  private readonly codeGenerator: () => string
  private readonly maxTextBytes: number
  private closed = false

  constructor(options: DeliveryStoreOptions) {
    this.database = openDeliveryDatabase(options.path)
    this.now = options.now ?? Date.now
    this.codeGenerator = options.codeGenerator ?? (() => randomBytes(5).toString('hex').toUpperCase())
    this.maxTextBytes = options.maxTextBytes ?? 65_536
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
        this.database.prepare(`
          UPDATE delivery_principals SET status = 'active', updated_at = ?, version = version + 1 WHERE id = ?
        `).run(now, existing.id)
        result = principalFromRow(this.database.prepare(`
          SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
          FROM delivery_principals WHERE id = ?
        `).get(existing.id) as unknown as PrincipalRow)
      }
      this.database.prepare("UPDATE pairing_challenges SET status = 'consumed', updated_at = ? WHERE id = ?")
        .run(now, row.id)
    })
    if (failure !== undefined) throw failure
    if (result === undefined) throw new DeliveryStoreError('conflict', 'pairing transaction produced no principal')
    return result
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
  }): ConversationBinding {
    this.assertOpen()
    const target = canonicalTarget({ conversation: input.conversation, principal: input.principal })
    const principal = this.getPrincipal(target.principal)
    if (principal?.status !== 'active') {
      throw new DeliveryStoreError('unauthorized-principal', 'binding principal is not active')
    }
    if (!isAbsolute(input.workspace)) throw new DeliveryStoreError('invalid-binding', 'binding workspace must be absolute')
    const workspace = validateBindingText(input.workspace, 'workspace', 4_096)
    const agentPreset = validateBindingText(input.agentPreset, 'agentPreset', 128)
    const sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
    const policyRef = validateBindingText(input.policyRef, 'policyRef', 256)
    const hash = conversationHash(target.conversation)
    const existing = this.getActiveBinding(target.conversation)
    if (existing !== undefined) {
      if (principalHash(existing.principal) !== principalHash(target.principal)) {
        throw new DeliveryStoreError('conflict', 'conversation is already bound to another principal')
      }
      return existing
    }
    const now = this.now()
    const id = `binding_${randomUUID()}`
    try {
      this.database.prepare(`
        INSERT INTO conversation_bindings (
          id, conversation_hash, conversation_json, principal_id, principal_json, workspace, agent_preset,
          session_id, generation, policy_ref, status, created_at, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'active', ?, ?, 1)
      `).run(
        id,
        hash,
        conversationJson(target.conversation),
        principal.id,
        principalJson(target.principal),
        workspace,
        agentPreset,
        sessionId,
        policyRef,
        now,
        now,
      )
    } catch (error) {
      const winner = this.getActiveBinding(target.conversation)
      if (winner !== undefined && principalHash(winner.principal) === principalHash(target.principal)) return winner
      throw error
    }
    return this.getBinding(id)!
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

  rotateBinding(input: { bindingId: string; expectedVersion: number; sessionId: string }): ConversationBinding {
    this.assertOpen()
    const current = this.getBinding(input.bindingId)
    if (current === undefined || current.status !== 'active' || current.version !== input.expectedVersion) {
      throw new DeliveryStoreError('version-conflict', 'active binding version changed or does not exist')
    }
    const sessionId = validateBindingText(input.sessionId, 'sessionId', 512)
    const now = this.now()
    const id = `binding_${randomUUID()}`
    this.transaction(() => {
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
        current.generation + 1,
        current.policyRef,
        now,
        now,
      )
    })
    return this.getBinding(id)!
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
        for (const attachment of envelope.attachments ?? []) {
          const descriptorHash = digest(JSON.stringify(attachment))
          this.database.prepare(`
            INSERT INTO delivery_attachments (
              id, owner_kind, owner_id, media_type, size_bytes, sha256, spool_ref,
              resource_kind, provider_ref, file_name, status, expires_at, created_at
            ) VALUES (?, 'inbox', ?, ?, ?, ?, NULL, ?, ?, ?, 'metadata', NULL, ?)
          `).run(
            `attachment_${digest(`${id}:${attachment.providerRef}`).slice(0, 40)}`,
            id,
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
      SELECT id, owner_kind, owner_id, media_type, size_bytes, sha256, spool_ref,
        resource_kind, provider_ref, file_name, status, expires_at, created_at
      FROM delivery_attachments WHERE owner_kind = ? AND owner_id = ? ORDER BY rowid
    `).all(input.ownerKind, input.ownerId) as unknown as Array<{
      id: string; owner_kind: 'inbox' | 'outbox'; owner_id: string; media_type: string
      size_bytes: number; sha256: string; spool_ref: string | null
      resource_kind: DeliveryAttachment['resourceType'] | null; provider_ref: string | null
      file_name: string | null; status: DeliveryAttachment['status']; expires_at: number | null; created_at: number
    }>
    return rows.map(row => ({
      id: row.id,
      ownerKind: row.owner_kind,
      ownerId: row.owner_id,
      resourceType: row.resource_kind ?? 'file',
      providerRef: row.provider_ref ?? '',
      ...(row.file_name === null ? {} : { fileName: row.file_name }),
      ...(row.media_type === '' ? {} : { mediaType: row.media_type }),
      ...(row.status === 'metadata' && row.size_bytes === 0 ? {} : { sizeBytes: row.size_bytes }),
      ...(row.status === 'metadata' ? {} : { contentSha256: row.sha256 }),
      status: row.status,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      createdAt: row.created_at,
    }))
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
    const now = this.now()
    const claims: { record: InboxRecord; fencingToken: number }[] = []
    this.transaction(() => {
      this.database.prepare(`
        UPDATE inbox_messages SET status = 'dead_letter', failure_code = 'attempts-exhausted',
          next_attempt_at = NULL, updated_at = ?
        WHERE status = 'retry_wait' AND next_attempt_at <= ? AND attempt_count >= ?
      `).run(now, now, input.maxAttempts)
      const candidates = this.database.prepare(`
        SELECT candidate.id FROM inbox_messages AS candidate
        WHERE candidate.status IN ('queued', 'retry_wait')
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND candidate.attempt_count < ?
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
            attempt_count = attempt_count + 1, next_attempt_at = NULL, failure_code = NULL, updated_at = ?
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
        WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND fencing_token = ?
      `).run(
        input.outcome,
        input.outcome === 'retry_wait' ? input.retryAt! : null,
        input.failureCode ?? null,
        now,
        input.inboxId,
        input.ownerId,
        input.fencingToken,
      )
      if (changed.changes !== 1) throw new DeliveryStoreError('stale-fence', 'inbox completion has a stale fence')
      this.database.prepare(`
        UPDATE inbox_attempts SET status = ?, failure_code = ?, finished_at = ?
        WHERE inbox_id = ? AND owner_id = ? AND fencing_token = ? AND status = 'claimed'
      `).run(input.outcome, input.failureCode ?? null, now, input.inboxId, input.ownerId, input.fencingToken)
    })
    return this.getInbox(input.inboxId)!
  }

  markInboxDispatching(input: { inboxId: string; ownerId: string; fencingToken: number }): InboxRecord {
    this.assertOpen()
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE inbox_messages SET failure_code = 'dispatch-started', updated_at = ?
      WHERE id = ? AND status = 'claimed' AND claimed_by = ? AND fencing_token = ?
    `).run(now, input.inboxId, input.ownerId, input.fencingToken)
    if (changed.changes !== 1) throw new DeliveryStoreError('stale-fence', 'inbox dispatch marker has a stale fence')
    return this.getInbox(input.inboxId)!
  }

  recoverInbox(input: { maxAttempts: number }): InboxRecord[] {
    this.assertOpen()
    const now = this.now()
    const recovered: string[] = []
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id, attempt_count, failure_code FROM inbox_messages
        WHERE status = 'claimed' AND lease_until <= ? ORDER BY rowid
      `).all(now) as unknown as { id: string; attempt_count: number; failure_code: string | null }[]
      for (const row of rows) {
        const ambiguous = row.failure_code === 'dispatch-started'
        const exhausted = row.attempt_count >= input.maxAttempts
        this.database.prepare(`
          UPDATE inbox_messages SET status = ?, next_attempt_at = ?, claimed_by = NULL,
            fencing_token = NULL, lease_until = NULL, failure_code = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND lease_until <= ?
        `).run(ambiguous || exhausted ? 'dead_letter' : 'retry_wait', ambiguous || exhausted ? null : now,
          ambiguous ? 'dispatch-ambiguous' : 'lease-expired', now, row.id, now)
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
    const now = this.now()
    const claims: { record: OutboxRecord; fencingToken: number; mode: 'reconcile' | 'send' }[] = []
    this.transaction(() => {
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = 'attempts-exhausted',
          next_attempt_at = NULL, updated_at = ?
        WHERE status = 'retry_wait' AND next_attempt_at <= ? AND attempt_count >= ?
      `).run(now, now, input.maxAttempts)
      const candidates = this.database.prepare(`
        SELECT candidate.id, candidate.status FROM outbox_messages AS candidate
        WHERE candidate.status IN ('pending', 'retry_wait', 'unknown_after_send')
          AND candidate.claimed_by IS NULL
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND candidate.attempt_count < ?
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
        ORDER BY candidate.rowid LIMIT ?
      `).all(now, input.maxAttempts, input.limit) as unknown as { id: string; status: OutboxRecord['status'] }[]
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
        WHERE id = ? AND status = 'attempting' AND claimed_by = ? AND fencing_token = ?
      `).run(
        input.outcome,
        providerMessageId,
        input.outcome === 'retry_wait' ? input.retryAt! : null,
        input.failureCode ?? null,
        now,
        input.outboxId,
        input.ownerId,
        input.fencingToken,
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

  recoverOutbox(input: { maxAttempts: number }): OutboxRecord[] {
    this.assertOpen()
    const now = this.now()
    const recovered: string[] = []
    this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM outbox_messages WHERE status = 'attempting' AND lease_until <= ? ORDER BY rowid
      `).all(now) as unknown as { id: string }[]
      for (const row of rows) {
        this.database.prepare(`
          UPDATE outbox_messages SET status = 'unknown_after_send', claimed_by = NULL, fencing_token = NULL,
            lease_until = NULL, next_attempt_at = NULL, failure_code = 'attempt-lease-expired', updated_at = ?
          WHERE id = ? AND status = 'attempting' AND lease_until <= ?
        `).run(now, row.id, now)
        this.database.prepare(`
          UPDATE outbox_attempts SET status = 'unknown_after_send', failure_code = 'attempt-lease-expired', finished_at = ?
          WHERE outbox_id = ? AND status = 'attempting'
        `).run(now, row.id)
        recovered.push(row.id)
      }
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = 'attempts-exhausted', next_attempt_at = NULL,
          updated_at = ? WHERE status = 'retry_wait' AND next_attempt_at <= ? AND attempt_count >= ?
      `).run(now, now, input.maxAttempts)
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
    const result = this.database.prepare(`
      UPDATE delivery_principals SET status = 'revoked', updated_at = ?, version = version + 1
      WHERE id = ? AND version = ?
    `).run(now, id, expectedVersion)
    if (result.changes !== 1) throw new DeliveryStoreError('version-conflict', 'principal version changed or does not exist')
    const row = this.database.prepare(`
      SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
      FROM delivery_principals WHERE id = ?
    `).get(id) as unknown as PrincipalRow
    return principalFromRow(row)
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
    const current = this.getOutbox(input.outboxId)
    if (current === undefined || !['dead', 'unknown_after_send'].includes(current.status)
      || current.attemptCount !== input.expectedAttemptCount) {
      throw new DeliveryStoreError('version-conflict', 'outbox attempt count or resolvable state changed')
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
  }

  beginApprovalSettlement(input: { operationId: string; payload: unknown }): {
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
    const existing = this.database.prepare(`
      SELECT payload_hash, status, result_json FROM approval_settlements WHERE operation_id = ?
    `).get(operationId) as { payload_hash: string; status: 'completed' | 'pending'; result_json: string | null } | undefined
    if (existing !== undefined) {
      if (existing.payload_hash !== payloadHash) {
        throw new DeliveryStoreError('idempotency-conflict', 'approval operation id was reused with a different payload')
      }
      return { payloadHash, replayed: true,
        ...(existing.result_json === null ? {} : { result: JSON.parse(existing.result_json) as unknown }) }
    }
    const now = this.now()
    this.database.prepare(`
      INSERT INTO approval_settlements (
        operation_id, payload_hash, payload_json, status, result_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', NULL, ?, ?)
    `).run(operationId, payloadHash, payloadJson, now, now)
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

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }

  private transaction(operation: () => void): void {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      operation()
      this.database.exec('COMMIT')
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new DeliveryStoreError('conflict', 'delivery store is closed')
  }
}
