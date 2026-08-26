import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'

export interface ExternalPrincipalKey {
  channel: string
  account: string
  tenant: string
  user: string
}

export type ConversationKind = 'dm' | 'group'

export interface ConversationRef {
  channel: string
  account: string
  tenant: string
  kind: ConversationKind
  chat: string
  thread?: string
}

export interface DeliveryTarget {
  conversation: ConversationRef
  principal: ExternalPrincipalKey
}

export interface ConversationBinding {
  id: string
  conversation: ConversationRef
  principal: ExternalPrincipalKey
  workspace: string
  agentPreset: string
  sessionId: string
  generation: number
  policyRef: string
  status: 'active' | 'revoked'
  createdAt: number
  updatedAt: number
  version: number
}

/** A provider/model route without persistence metadata. */
export interface ModelRouteRef {
  provider: string
  model: string
  reasoningEffort?: string
}

/** The authoritative, durable selection shown by one model-picker operation. */
export interface ModelPickerState extends ModelRouteRef {
  revision: number
}

/** A durable provider/model override scoped to one canonical external conversation. */
export interface ConversationModelSelection extends ModelRouteRef {
  updatedAt: number
  version: number
}

export interface InboundEnvelope {
  channel: string
  account: string
  eventId: string
  occurredAt: number
  principal: ExternalPrincipalKey
  conversation: ConversationRef
  kind: 'command' | 'text'
  text: string
  metadata?: Readonly<Record<string, string>>
  attachments?: readonly InboundAttachmentDescriptor[]
}

export type AttachmentResourceType = 'audio' | 'file' | 'image' | 'sticker' | 'video'

export interface InboundAttachmentDescriptor {
  resourceType: AttachmentResourceType
  providerRef: string
  fileName?: string
  mediaType?: string
  sizeBytes?: number
}

export interface DeliveryAttachment {
  id: string
  ownerKind: 'inbox' | 'outbox'
  ownerId: string
  resourceType: AttachmentResourceType
  providerRef: string
  fileName?: string
  mediaType?: string
  sizeBytes?: number
  contentSha256?: string
  /** Complete durable image reference; `spool_ref` is only its private JSON persistence slot. */
  imageRef?: ImageAttachmentRef
  status: 'expired' | 'metadata' | 'quarantined' | 'ready'
  expiresAt?: number
  createdAt: number
}

export type InboxStatus =
  | 'authorized'
  | 'claimed'
  | 'dead_letter'
  | 'processed'
  | 'queued'
  | 'received'
  | 'retry_wait'

export interface InboxRecord {
  id: string
  channel: string
  account: string
  eventId: string
  envelope: InboundEnvelope
  envelopeHash: string
  status: InboxStatus
  bindingId?: string
  attemptCount: number
  nextAttemptAt?: number
  claimedBy?: string
  fencingToken?: number
  leaseUntil?: number
  failureCode?: string
  receivedAt: number
  updatedAt: number
}

export interface OutboundIntent {
  idempotencyKey: string
  bindingId: string
  target: DeliveryTarget
  text: string
  format?: OutboundFormat
  approval?: ApprovalIntent
  modelPicker?: ModelPickerIntent
  permissionPicker?: PermissionPickerIntent
  replyToEventId?: string
  metadata?: Readonly<Record<string, string>>
}

export type OutboundFormat = 'approval' | 'markdown' | 'model-picker' | 'permission-picker' | 'plain'

export interface ApprovalIntent {
  operationId: string
  proposalId: string
  expectedVersion: number
  expiresAt: number
  title: string
  diffHash: string
}

export type PermissionPickerLevel = 'ask' | 'auto' | 'full' | 'custom'

/** The exact permission state and binding snapshot represented by one durable picker card. */
export interface PermissionPickerIntent {
  operationId: string
  issuedAt: number
  expiresAt: number
  current: PermissionPickerLevel
  expectedStateHash: string
  /** AssistantPolicy emergency-stop revision observed when the card was issued. */
  emergencyStopVersion: number
  bindingVersion: number
  sessionId: string
}

export interface ModelPickerIntent {
  operationId: string
  expiresAt: number
  current: ModelRouteRef
  providers: readonly ModelPickerProvider[]
  models: readonly ModelPickerModel[]
  efforts: readonly ModelPickerEffort[]
}

export interface ModelPickerProvider {
  id: string
  name: string
}

export interface ModelPickerModel {
  provider: string
  id: string
  name: string
  effortIds: readonly string[]
}

export interface ModelPickerEffort {
  id: string
  name: string
}

export type OutboxStatus =
  | 'accepted'
  | 'attempting'
  | 'dead'
  | 'delivered'
  | 'pending'
  | 'read'
  | 'retry_wait'
  | 'unknown_after_send'

export interface OutboxRecord {
  id: string
  intent: OutboundIntent
  intentHash: string
  status: OutboxStatus
  providerMessageId?: string
  attemptCount: number
  nextAttemptAt?: number
  claimedBy?: string
  fencingToken?: number
  leaseUntil?: number
  failureCode?: string
  createdAt: number
  updatedAt: number
}

export type ReceiptStatus = 'accepted' | 'delivered' | 'read'

export interface DeliveryReceipt {
  channel: string
  account: string
  providerMessageId: string
  status: ReceiptStatus
  occurredAt: number
  metadata?: Readonly<Record<string, string>>
}

export type AdapterSendResult =
  | { outcome: 'accepted'; providerMessageId: string }
  | { outcome: 'not-sent'; failureCode: string; retryable: boolean; retryAfterMs?: number }
  | { outcome: 'unknown'; failureCode: string; providerMessageId?: string }

export type AdapterReconcileResult =
  | { outcome: 'accepted' | 'delivered' | 'read'; providerMessageId: string }
  | { outcome: 'not-sent' }
  | { outcome: 'unknown' }

export interface InboundImageReadInput {
  eventId: string
  attachment: Readonly<InboundAttachmentDescriptor>
  maxBytes: number
}

export type AdapterInboundImageReadResult =
  | { outcome: 'downloaded'; data: Uint8Array; mediaType: ImageMediaType }
  | { outcome: 'not-downloaded'; failureCode: string; retryable: boolean; retryAfterMs?: number }

/** One open-turn, one-shot tool approval routed to the authenticated conversation owner. */
export interface DeliveryToolApprovalRequest {
  operationId: string
  bindingId: string
  target: DeliveryTarget
  expiresAt: number
  /** SHA-256 over the exact session, call identity, tool name, arguments, and permission state. */
  actionHash: string
  toolName: string
  /** Exact call identity from the current open Session turn. */
  callId: string
  /** Bounded, untrusted display text; never interpreted as instructions. */
  reason?: string
  /** Exact bounded JSON argument text already recorded by the Session. */
  arguments: string
}

export type DeliveryToolApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/**
 * Safe, user-visible execution progress. It intentionally has no tool arguments or tool output.
 *
 * `step` carries the assistant's own already-published summary of what it is doing — the durable
 * `reasoning` block of an `assistant/message`, or the neutral phase label of a step for providers
 * that never emit reasoning at all. Turns that call no tool and write no todo would otherwise leave
 * the channel's progress surface with nothing between `started` and the terminal update.
 *
 * `failed` carries the short failure *code* only. The human-readable provider message may quote the
 * prompt or upstream payloads, so it stays behind this boundary; the code is what makes a failed
 * turn legible instead of leaving the surface stuck on its opening line.
 */
export type DeliveryProgressUpdate =
  | { kind: 'started' }
  | { kind: 'step'; text: string }
  | { kind: 'tool-started'; callId: string; toolName: string }
  | { kind: 'tool-finished'; callId: string; failed: boolean }
  | { kind: 'todos'; todos: readonly DeliveryProgressTodo[] }
  | { kind: 'completed' }
  | { kind: 'failed'; code?: string }

export interface DeliveryProgressTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/** One presentation-only progress update, correlated to a durable inbound message and binding. */
export interface DeliveryProgressIntent {
  bindingId: string
  target: DeliveryTarget
  eventId: string
  update: DeliveryProgressUpdate
}

export interface DeliveryAdapterContext {
  accept(envelope: InboundEnvelope): Promise<{ duplicate: boolean; inboxId: string; status: InboxStatus }>
  receipt(receipt: DeliveryReceipt): Promise<void>
}

export interface DeliveryAdapter {
  readonly channel: string
  readonly account: string
  readonly capabilities: Readonly<{
    reconcileUnknownSend: boolean
    receipts: readonly ReceiptStatus[]
    formats: readonly OutboundFormat[]
    inboundImages?: boolean
    toolApprovals?: boolean
  }>
  start(context: DeliveryAdapterContext): Promise<void | (() => void | Promise<void>)>
  readInboundImage?(
    input: Readonly<InboundImageReadInput>,
    signal: AbortSignal,
  ): Promise<AdapterInboundImageReadResult>
  /** Open-turn and deliberately non-durable; abort/restart/disconnect always fail closed. */
  requestToolApproval?(
    input: Readonly<DeliveryToolApprovalRequest>,
    signal: AbortSignal,
  ): Promise<DeliveryToolApprovalOutcome>
  /** Best-effort UI only; implementations must not treat it as task state or a durable reply. */
  progress?(intent: Readonly<DeliveryProgressIntent>): Promise<void>
  send(intent: Readonly<OutboundIntent>, signal: AbortSignal): Promise<AdapterSendResult>
  reconcileUnknownSend?(record: Readonly<OutboxRecord>, signal: AbortSignal): Promise<AdapterReconcileResult>
}

export interface PairingChallenge {
  id: string
  principal: ExternalPrincipalKey
  expiresAt: number
  status: 'active' | 'consumed' | 'expired' | 'locked'
  attempts: number
  createdAt: number
}

export interface DeliveryPrincipal {
  id: string
  principal: ExternalPrincipalKey
  role: 'linked' | 'owner'
  status: 'active' | 'revoked'
  linkedToId?: string
  createdAt: number
  updatedAt: number
  version: number
}
