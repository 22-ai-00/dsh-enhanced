import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { Agent } from '@deepseek-ai/dsh-agent'

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

/**
 * Host-owned authority for one stable owner delivery route.
 *
 * The authority follows only monotonic generations of the exact canonical
 * conversation/principal/workspace/preset/policy lineage. It is deployment
 * configuration, not model input or a model-callable capability.
 */
export interface OwnerRouteAuthority {
  id: string
  conversation: ConversationRef
  principal: ExternalPrincipalKey
  workspace: string
  agentPreset: string
  policyRef: string
  minimumGeneration: number
}

/** Immutable route evidence captured when a binding is resolved or enqueued. */
export interface OwnerRouteBindingSnapshot {
  receiptVersion: 2
  authorityId: string
  authorityHash: string
  bindingId: string
  bindingVersion: number
  generation: number
  minimumGeneration: number
}

export interface ResolvedOwnerRoute {
  authorityId: string
  binding: ConversationBinding
  snapshot: OwnerRouteBindingSnapshot
}

/** Content-free Host receipt proving that one exact configured owner route is live. */
export interface OwnerRouteValidationReceipt {
  receiptVersion: 2
  authorityId: string
  authorityHash: string
  principalId: string
  /** Exact durable Delivery principal row, so the same external id cannot ABA. */
  principalRecordId: string
  principalVersion: number
  workspace: string
  agentPreset: string
  bindingVersion: number
  generation: number
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

/** Durable Delivery owner-row lineage. Version changes on revoke/reactivation, preventing owner ABA. */
export interface DeliveryOwnerLineage {
  readonly principalRecordId: string
  readonly principalVersion: number
}

/** Durable total order minted by the Delivery database when an Inbox is admitted. */
export interface DeliveryAdmissionCursor {
  /** Immutable Delivery database epoch. Cursors from different epochs are never comparable. */
  readonly epoch: string
  readonly sequence: number
}

/** Closed key/value catalog emitted by Delivery's authenticated `/feedback` command. */
export type DeliveryPreferenceSelection =
  | { readonly preferenceKey: 'feedback.response'; readonly candidateValue:
    | 'helpful' | 'not-helpful' | 'too-long' | 'too-short'
    | 'wrong-format' | 'wrong-action' | 'unwanted-reminder' }
  | { readonly preferenceKey: 'recommendation.ranking'; readonly candidateValue:
    'recency' | 'familiarity' | 'evidence' }
  | { readonly preferenceKey: 'response.explanation_depth'; readonly candidateValue:
    'result-first' | 'balanced' | 'tutorial' }
  | { readonly preferenceKey: 'response.language'; readonly candidateValue: 'zh-CN' | 'en' }
  | { readonly preferenceKey: 'response.structure'; readonly candidateValue:
    'prose' | 'bullets' | 'mixed' }
  | { readonly preferenceKey: 'response.verbosity'; readonly candidateValue:
    'concise' | 'balanced' | 'detailed' }
  | { readonly preferenceKey: 'suggestion.frequency'; readonly candidateValue: 'low' | 'normal' }

/**
 * Immutable Host-attested feedback event. Delivery, not a model or listener,
 * owns every field and the downstream idempotency identity.
 */
export type DeliveryPreferenceFeedback = Readonly<{
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage?: Readonly<DeliveryOwnerLineage>
  /** Optional only so a rolling upgrade can parse and fail closed on legacy queued projections. */
  readonly admissionCursor?: Readonly<DeliveryAdmissionCursor>
  readonly stance: 'support'
  readonly actorTrust: 'owner-authenticated'
  readonly interpretationTrust: 'explicit-selection' | 'typed-feedback'
  readonly source: 'direct-owner-feedback'
  readonly occurredAt: number
  readonly idempotencyKey: string
  /** Optional exact reply target; identifiers only, never message content. */
  readonly exposureTarget?: Readonly<{
    sourceInboxId: string
    sourceOutboxId: string
  }>
}> & DeliveryPreferenceSelection

/**
 * Content-free observation emitted only after one authenticated owner turn has
 * completed, its session has flushed, and its exact reply Outbox is durable.
 */
export type DeliveryPreferenceCompletionIdentity = Readonly<{
  bindingId: string
  bindingVersion: number
  sessionId: string
  sourceEventId: string
  sourceInboxId: string
  replyOutboxId: string
}>

export type DeliveryPreferenceObservation = Readonly<{
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage?: Readonly<DeliveryOwnerLineage>
  readonly admissionCursor?: Readonly<DeliveryAdmissionCursor>
  readonly preferenceKey: 'response.language'
  readonly candidateValue: 'zh-CN' | 'en'
  readonly stance: 'support'
  readonly actorTrust: 'owner-authenticated'
  readonly interpretationTrust: 'behavioral-inference'
  readonly source: 'delivery-observation'
  readonly occurredAt: number
  readonly idempotencyKey: string
  readonly completion: DeliveryPreferenceCompletionIdentity
}>

/** A successful owner turn with a durable reply, even when no behavior classifier emits a signal. */
export type DeliveryPreferenceCompletion = Readonly<{
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage?: Readonly<DeliveryOwnerLineage>
  readonly admissionCursor?: Readonly<DeliveryAdmissionCursor>
  readonly actorTrust: 'owner-authenticated'
  readonly source: 'delivery-completion'
  readonly occurredAt: number
  readonly idempotencyKey: string
  readonly completion: DeliveryPreferenceCompletionIdentity
}>

export type DeliveryPreferenceEvent =
  | DeliveryPreferenceCompletion
  | DeliveryPreferenceFeedback
  | DeliveryPreferenceObservation

export type DeliveryLearningControlAction =
  | 'explain'
  | 'forget'
  | 'pause'
  | 'resume'
  | 'rollback'
  | 'status'

export interface DeliveryLearningExplanation {
  readonly key: string
  readonly value: string
  readonly state: 'active' | 'inactive' | 'rolled-back' | 'shadow' | 'suppressed'
  readonly version: number
  readonly supportingSignals: number
  readonly contradictingSignals: number
  readonly evidenceMass: number
}

/** Content-free owner command minted only after Delivery revalidates the exact Inbox binding. */
export interface DeliveryLearningControlRequest {
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage: Readonly<DeliveryOwnerLineage>
  readonly admissionCursor: Readonly<DeliveryAdmissionCursor>
  readonly action: DeliveryLearningControlAction
  /** Required only for rollback; it must be one exact Host-catalog T1 key. */
  readonly preferenceKey?: string
  readonly occurredAt: number
  readonly idempotencyKey: string
}

export interface DeliveryLearningScopeStatus {
  /** Compatibility summary; use the independent fields below for decisions. */
  readonly mode: 'active' | 'disabled' | 'paused'
  readonly administrativelyEnabled: boolean
  readonly collectionMode: 'active' | 'paused'
  readonly signals: number
  readonly hypotheses: number
  /** Active catalog hypotheses retained in the ledger, even while suppressed. */
  readonly storedActiveOverlays: number
  /** Overlays that may currently enter a prompt after both gates are applied. */
  readonly effectiveActiveOverlays: number
  /** Compatibility alias for effectiveActiveOverlays. */
  readonly activeOverlays: number
  readonly shadowHypotheses: number
}

export type DeliveryLearningControlReceipt =
  | Readonly<{
    outcome: 'applied'
    action: DeliveryLearningControlAction
    idempotencyKey: string
    replayed: boolean
    state: Readonly<DeliveryLearningScopeStatus>
    deletedSignals?: number
    deletedHypotheses?: number
    explanation?: readonly Readonly<DeliveryLearningExplanation>[]
    rolledBack?: boolean
    rolledBackVersion?: number
  }>
  | Readonly<{
    outcome: 'stale'
    action: DeliveryLearningControlAction
    idempotencyKey: string
  }>

export type DeliveryLearningControlListener = (
  request: Readonly<DeliveryLearningControlRequest>,
) => Readonly<DeliveryLearningControlReceipt> | Promise<Readonly<DeliveryLearningControlReceipt>>

/** Durable acknowledgement returned by the single authoritative sink. */
export interface DeliveryPreferenceFeedbackReceipt {
  readonly idempotencyKey: string
  readonly status: 'recorded'
}

export type DeliveryPreferenceFeedbackListener = (
  events: readonly Readonly<DeliveryPreferenceEvent>[],
) => readonly Readonly<DeliveryPreferenceFeedbackReceipt>[]
  | Promise<readonly Readonly<DeliveryPreferenceFeedbackReceipt>[]>

/**
 * Process-local writer used while Delivery holds its SQLite owner-lineage
 * fence. Implementations must commit before returning and must never call back
 * into Delivery; the fixed lock order is Delivery -> Preference.
 */
export type DeliveryPreferenceSynchronousFeedbackListener = (
  events: readonly Readonly<DeliveryPreferenceEvent>[],
) => readonly Readonly<DeliveryPreferenceFeedbackReceipt>[]

export const DELIVERY_PREFERENCE_PROJECTION_PROTOCOL =
  'assistant-delivery/preference-projection/v2' as const

/** Process-local ownership proof minted by the exact Preference Learning instance. */
export interface DeliveryPreferenceRegistrationOwner {
  ownsDeliveryPreferenceRegistration(
    registration: Readonly<DeliveryPreferenceRegistration>,
  ): boolean
}

export interface DeliveryPreferenceRegistration {
  readonly protocol: typeof DELIVERY_PREFERENCE_PROJECTION_PROTOCOL
  readonly producer: 'preference-learning'
  readonly generation: string
  readonly owner: DeliveryPreferenceRegistrationOwner
  append: DeliveryPreferenceFeedbackListener
  /** Optional rolling-upgrade capability; current Preference instances always provide it. */
  appendSynchronously?: DeliveryPreferenceSynchronousFeedbackListener
  control?: DeliveryLearningControlListener
}

/** Exact current Delivery turn; identifiers only, never message or model content. */
export interface DeliveryPreferenceTurnAttestation {
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage: Readonly<DeliveryOwnerLineage>
  readonly bindingId: string
  readonly bindingVersion: number
  readonly sessionId: string
  readonly sourceEventId: string
  readonly sourceInboxId: string
  readonly turn: number
}

/** Content-free owner identity for a currently bound Agent outside prompt assembly. */
export interface DeliveryPreferencePrincipalAttestation {
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly principalId: string
  readonly principalLineage: Readonly<DeliveryOwnerLineage>
  readonly bindingId: string
  readonly bindingVersion: number
  readonly sessionId: string
}

/** Structural Host contract consumed by Preference without a reverse package dependency. */
export interface DeliveryPreferenceProducer {
  trustedPreferenceProducerGeneration(): string
  registerTrustedPreferenceSink(
    registration: Readonly<DeliveryPreferenceRegistration>,
  ): () => void
  currentPreferenceTurn(agent: Agent): Readonly<DeliveryPreferenceTurnAttestation> | undefined
  preferencePrincipalForAgent(
    agent: Agent,
  ): Readonly<DeliveryPreferencePrincipalAttestation> | undefined
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
  admissionCursor: Readonly<DeliveryAdmissionCursor>
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

export type ModelSelectionRejectionReason =
  | 'authorization-revoked'
  | 'invalid-effort'
  | 'model-unavailable'
  | 'provider-model-mismatch'
  | 'provider-unavailable'
  | 'selection-superseded'

export type ModelSelectionResult =
  | { status: 'pending' }
  | { status: 'rejected'; reason: ModelSelectionRejectionReason }
  | { status: 'selected'; selection: ModelRouteRef }

export type ModelSelectionTerminalResult = Exclude<ModelSelectionResult, { status: 'pending' }>

/** Exact, replay-safe identity for one durable model-picker confirmation. */
export interface ModelSelectionSettlementInput {
  operationId: string
  callbackEventId: string
  callbackChatId: string
  cardMessageId: string
  bindingId: string
  principal: ExternalPrincipalKey
  provider: string
  modelProvider: string
  model: string
  reasoningEffort?: string
  expectedRevision: number
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

export type DeadLetterResolutionKind = 'inbox' | 'outbox'

export type DeadLetterResolutionStatus = 'dead' | 'dead_letter' | 'unknown_after_send'

/**
 * Immutable operator-resolution receipt for one exact terminal attempt.
 *
 * A retry receipt only resolves the referenced attempt. If a later attempt
 * fails, its larger attemptCount has no receipt and is actionable again.
 */
export interface DeadLetterResolutionReceipt {
  receiptVersion: 1
  kind: DeadLetterResolutionKind
  id: string
  attemptCount: number
  resolution: 'cancel' | 'retry'
  originalStatus: DeadLetterResolutionStatus
  originalFailureCode?: string
  operatorId: string
  createdAt: number
}

export interface DeadLetterResolutionResult<T extends InboxRecord | OutboxRecord> {
  record: T
  receipt: DeadLetterResolutionReceipt
  /** True when the exact same operator decision was already durably committed. */
  replayed: boolean
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

/**
 * Domain-authoritative terminal state for an owner approval card.
 *
 * Policy `approved` is only a decision. This receipt is emitted by the domain
 * after its own atomic settlement and is therefore the only state that may be
 * rendered as an applied change.
 */
export interface ApprovalApplicationPresentation {
  kind: 'approval-application'
  policyProposalId: string
  localProposalId: string
  applicationStatus: 'applied' | 'conflicted' | 'expired' | 'rejected'
  operation: 'adopt' | 'owner-undo' | 'retire'
  terminalAt: number
  receiptDigest: string
  ruleId?: string
  resultingRuleVersion?: number
  ruleStatus?: 'active' | 'retired'
}

/** Mutable projection of one Automation incident generation onto one provider message. */
export interface AutomationIncidentPresentation {
  kind: 'automation-incident'
  incidentId: string
  automationId: string
  definitionHash: string
  stage: 'claim' | 'materialize' | 'terminal'
  state: 'open' | 'recovering' | 'resolved'
  failureClass: 'budget' | 'cancelled' | 'configuration' | 'execution'
    | 'infrastructure' | 'policy' | 'provider' | 'timeout' | 'unknown'
  failurePhase: string
  failureCode: string
  sideEffectState: 'none' | 'possible' | 'unknown'
  retryability: 'after-intervention' | 'safe' | 'unsafe' | 'unknown'
  lifecycleGeneration: number
  /** Same monotonic value as the enclosing desired-presentation revision. */
  incidentRevision: number
  openedAt: number
  updatedAt: number
  resolvedAt?: number
}

export type DeliveryPresentation = ApprovalApplicationPresentation | AutomationIncidentPresentation

export interface DeliveryPresentationUpdate {
  /** Stable producer-owned lifecycle identity. */
  presentationKey: string
  /** Idempotency identity of the original message that must be replaced. */
  originalOutboxIdempotencyKey: string
  /** Monotonic desired presentation revision. */
  revision: number
  presentation: Readonly<DeliveryPresentation>
}

export interface StoredDeliveryPresentation extends DeliveryPresentationUpdate {
  status: 'attempting' | 'dead' | 'pending' | 'presented' | 'retry_wait'
  attemptCount: number
  presentedRevision: number
  providerMessageId?: string
  failureCode?: string
  createdAt: number
  updatedAt: number
}

/**
 * Private Host-to-Host protocol for domain-owned presentation projections.
 *
 * The Delivery service mints each registration and owns its `publish` closure.
 * A producer never receives a general Delivery write API: it only receives the
 * one registration bound to its exact live instance and generation.
 */
export const TRUSTED_DELIVERY_PRESENTATION_PRODUCER_PROTOCOL =
  'assistant-delivery/trusted-presentation-producer/v1' as const

/** Process-local ownership proof carried by a Delivery-minted registration. */
export interface TrustedDeliveryPresentationRegistrationOwner {
  ownsTrustedDeliveryPresentationRegistration(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): boolean
}

/**
 * One ephemeral, revocable publisher issued by Delivery to a trusted domain
 * producer. It is intentionally not an Agent tool or a durable wire payload.
 */
export interface TrustedDeliveryPresentationRegistration {
  readonly protocol: typeof TRUSTED_DELIVERY_PRESENTATION_PRODUCER_PROTOCOL
  readonly producer: 'assistant-automations' | 'assistant-evolution'
  readonly generation: string
  readonly owner: TrustedDeliveryPresentationRegistrationOwner
  publish(input: DeliveryPresentationUpdate): StoredDeliveryPresentation
}

/** Structural Host contract implemented by the two authorized producers. */
export interface TrustedDeliveryPresentationProducer {
  trustedDeliveryPresentationProducerGeneration(): string
  registerTrustedDeliveryPresentationSink(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): () => void
}

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
 * Bounded, user-visible execution progress.
 *
 * `step` carries a neutral execution phase, never model reasoning/thinking content. Tool updates
 * carry redacted previews so an adapter can render useful call details for an audience it considers
 * private; adapters must still account for the target conversation before publishing them. Preview
 * strings are presentation-only and are not durable Delivery state.
 *
 * `failed` carries the short failure *code* only. The human-readable provider message may quote the
 * prompt or upstream payloads, so it stays behind this boundary; the code is what makes a failed
 * turn legible instead of leaving the surface stuck on its opening line.
 */
export type DeliveryProgressUpdate =
  | { kind: 'started' }
  | { kind: 'step'; text: string }
  | { kind: 'tool-started'; callId: string; toolName: string; argumentsPreview?: string }
  | { kind: 'tool-finished'; callId: string; failed: boolean; resultPreview?: string; code?: string }
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
  /** Replace one exact bot-authored durable message with a domain terminal projection. */
  updatePresentation?(
    providerMessageId: string,
    presentation: Readonly<DeliveryPresentation>,
    signal: AbortSignal,
  ): Promise<void>
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
