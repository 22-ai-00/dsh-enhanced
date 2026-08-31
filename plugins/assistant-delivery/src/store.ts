import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { DatabaseSync, StatementSync } from 'node:sqlite'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ApprovalDispatchRouteV2 } from '@dsh-enhanced/assistant-policy'
import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  WORKFLOW_TRACE_SOURCE_ID,
  growthObjectDigest,
  validateResolvedWorkflowAutomationTemplate,
  validateWorkflowAutomationTemplate,
  validateWorkflowAutomationTemplateContent,
  validateWorkflowTraceRevision,
  workflowAutomationTemplateContentDigest,
  workflowArgumentShapeDigest,
  workflowScopeKey,
  workflowTraceRevisionDigest,
  type ResolvedWorkflowAutomationTemplate,
  type WorkflowAutomationTemplate,
  type WorkflowAutomationTemplateContent,
  type WorkflowStepFingerprint,
  type WorkflowTraceRevision,
  type WorkflowTraceSourceAttestation,
} from '@dsh-enhanced/assistant-growth-contract'
import {
  bindingMatchesOwnerRoute,
  canonicalBackgroundSourceId,
  canonicalConversation,
  canonicalLocalOperatorId,
  canonicalOwnerRouteAuthority,
  canonicalPrincipal,
  canonicalTarget,
  externalPrincipalId,
  ownerRouteAuthorityHash,
  ownerRouteBindingSnapshot,
} from './canonical.js'
import {
  feedbackDispatchRecoveryCode,
  isFeedbackDeliveryCommand,
  isFeedbackDispatchRecoveryCode,
  isExactDeliveryCommand,
  isLearningDeliveryCommand,
  isLearningDispatchRecoveryCode,
  isLearningRetryableFailureCode,
  isPermissionDeliveryCommand,
  isWorkflowDeliveryCommand,
  isWorkflowDispatchRecoveryCode,
  learningDispatchRecoveryCode,
  parseDeliveryCommand,
  permissionDispatchRecoveryCode,
  permissionDispatchRecoveryFromFailureCode,
  workflowDispatchRecoveryCode,
} from './session-commands.js'
import { parseFeedbackCommand } from './feedback-command.js'
import { openDeliveryDatabase } from './sqlite.js'
import {
  deriveDeterministicallyDeidentifiedWorkflowTemplate,
  getDeterministicallyDeidentifiedWorkflowTemplate,
} from './workflow-auto-producer.js'
import type {
  ConversationBinding,
  ConversationModelSelection,
  ConversationRef,
  DeadLetterResolutionKind,
  DeadLetterResolutionReceipt,
  DeadLetterResolutionResult,
  DeadLetterResolutionStatus,
  DeliveryAttachment,
  DeliveryPreferenceEvent,
  DeliveryPresentation,
  DeliveryPresentationUpdate,
  DeliveryPrincipal,
  DeliveryReceipt,
  ExternalPrincipalKey,
  InboundEnvelope,
  InboxRecord,
  OutboundIntent,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  OwnerApprovalForPreferenceInput,
  OwnerRouteAuthority,
  OutboxRecord,
  PairingChallenge,
  PermissionPickerIntent,
  StoredDeliveryPresentation,
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

export interface OwnerRouteDispatchGuard {
  readonly ownerRoutes: readonly Readonly<OwnerRouteAuthority>[]
  /** False is an explicit revocation; throw means the check is unavailable and must be retried without I/O. */
  readonly authorize: (input: {
    authority: Readonly<OwnerRouteAuthority>
    sourceId: string
    idempotencyKey: string
  }) => boolean
}

export type OwnerRouteDispatchValidation =
  | { kind: 'not-route' }
  | { kind: 'authorized' }
  | { kind: 'deferred'; failureCode: string }
  | { kind: 'denied'; failureCode: string }

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
  admission_epoch: string
  admission_sequence: number
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

interface ApprovalOutboxRouteRow {
  outbox_id: string
  route_version: number
  source_id: string
  binding_id: string
  binding_version: number
  binding_generation: number
  workspace: string
  principal: string
  principal_record_id: string
  principal_version: number
}

interface DeliveryPresentationRow {
  presentation_key: string
  original_outbox_idempotency_key: string
  revision: number
  payload_hash: string
  payload_json: string
  status: StoredDeliveryPresentation['status']
  attempt_count: number
  presented_revision: number
  next_attempt_at: number | null
  claimed_by: string | null
  fencing_token: number | null
  lease_until: number | null
  provider_message_id: string | null
  failure_code: string | null
  created_at: number
  updated_at: number
}

interface WorkflowTraceRevisionRow {
  subject_ref: string
  version: number
  source_generation: number
  source_authority_digest: string
  scope_key: string
  workspace: string
  preset: string
  disposition: WorkflowTraceRevision['disposition']
  digest: string
  payload_json: string
  created_at: number
}

interface WorkflowTraceOutboxRow extends WorkflowTraceRevisionRow {
  status: 'delivered' | 'pending' | 'retry_wait'
  attempt_count: number
  next_attempt_at: number
  failure_code: string | null
  updated_at: number
}

interface WorkflowVerifiedTaskFeedbackRow {
  source_outbox_id: string
  source_inbox_id: string
  feedback_inbox_id: string
  binding_id: string
  binding_version: number
  binding_generation: number
  principal_record_id: string
  objective_status: 'achieved' | 'partial' | 'not-achieved'
  task_ref: string
  task_evidence_digest: string
  trace_subject_ref: string | null
  trace_version: number | null
  trace_digest: string | null
  template_ref: string | null
  created_at: number
}

interface PreferenceProjectionOutboxRow {
  batch_key: string
  payload_digest: string
  events_json: string
  status: 'pending' | 'retry_wait'
  attempt_count: number
  next_attempt_at: number
  failure_code: string | null
  lane_kind: 'exact' | 'legacy' | 'unclassified'
  lane_epoch: string | null
  lane_workspace: string | null
  lane_preset: string | null
  lane_principal_record_id: string | null
  lane_principal_version: number | null
  admission_sequence: number | null
  terminal_at: number | null
  created_at: number
  updated_at: number
}

interface PreferenceProjectionLane {
  epoch: string
  workspace: string
  preset: string
  principalRecordId: string
  principalVersion: number
  admissionSequence: number
}

interface WorkflowTemplateRow {
  template_ref: string
  template_digest: string
  scope_key: string
  workspace: string
  preset: string
  owner_binding_id: string
  content_json: string
  privacy_kind: WorkflowAutomationTemplate['privacyAttestation']['kind']
  privacy_attestation_id: string
  privacy_attestation_digest: string
  review_receipt_json: string
  status: 'active' | 'revoked'
  review_inbox_id: string
  source_inbox_id: string
  source_outbox_id: string
  created_at: number
  updated_at: number
  version: number
}

export interface WorkflowTraceOutboxEntry {
  revision: Readonly<WorkflowTraceRevision>
  status: WorkflowTraceOutboxRow['status']
  attemptCount: number
  nextAttemptAt: number
  failureCode?: string
  updatedAt: number
}

export interface PreferenceProjectionOutboxEntry {
  batchKey: string
  payloadDigest: string
  events: readonly Readonly<DeliveryPreferenceEvent>[]
  lane?: Readonly<PreferenceProjectionLane>
  attemptCount: number
  nextAttemptAt: number
  failureCode?: string
}

export type PreferenceProjectionFenceResult = 'completed' | 'ignored' | 'missing'

export interface OwnerWorkflowTraceCommandResult {
  revision: Readonly<WorkflowTraceRevision>
  template?: Readonly<WorkflowAutomationTemplate>
  replayed: boolean
}

/**
 * The durable result of an authenticated owner objective judgement over one
 * ordinary Agent reply.  Only an achieved judgement with a closed-set,
 * deterministic template can create a workflow trace.
 */
export type VerifiedWorkflowTraceFeedbackResult =
  | Readonly<{
      outcome: 'trace-recorded'
      revision: Readonly<WorkflowTraceRevision>
      template: Readonly<WorkflowAutomationTemplate>
      replayed: boolean
    }>
  | Readonly<{
      outcome: 'no-trace'
      reason: 'objective-not-achieved' | 'privacy-abstained'
      replayed: boolean
    }>

export interface StoredWorkflowTemplate {
  resolved: Readonly<ResolvedWorkflowAutomationTemplate>
  review: Readonly<{
    bindingId: string
    bindingVersion: number
    bindingGeneration: number
    principalId: string
    reviewInboxId: string
    sourceInboxId: string
    sourceOutboxId: string
  }>
  status: WorkflowTemplateRow['status']
  version: number
}

function workflowTraceRevision(row: WorkflowTraceRevisionRow): Readonly<WorkflowTraceRevision> {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.payload_json) as unknown
  } catch {
    throw new DeliveryStoreError('conflict', 'workflow trace revision payload is corrupt')
  }
  const revision = validateWorkflowTraceRevision(parsed)
  if (revision.subjectRef !== row.subject_ref || revision.version !== row.version
    || revision.source.sourceId !== WORKFLOW_TRACE_SOURCE_ID
    || revision.source.generation !== row.source_generation
    || revision.source.authorityDigest !== row.source_authority_digest
    || workflowScopeKey(revision.scope) !== row.scope_key
    || revision.scope.workspace !== row.workspace || revision.scope.preset !== row.preset
    || revision.disposition !== row.disposition || revision.digest !== row.digest) {
    throw new DeliveryStoreError('conflict', 'workflow trace revision columns do not match payload')
  }
  return revision
}

function workflowTraceOutboxEntry(row: WorkflowTraceOutboxRow): WorkflowTraceOutboxEntry {
  return Object.freeze({
    revision: workflowTraceRevision(row),
    status: row.status,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    updatedAt: row.updated_at,
  })
}

function preferenceProjectionBatchKey(events: readonly Readonly<DeliveryPreferenceEvent>[]): string {
  const identities = events.map(event => event.idempotencyKey)
  return `delivery-preference-v1:${createHash('sha256')
    .update('assistant-delivery-preference-projection-v1\0')
    .update(JSON.stringify(identities))
    .digest('hex')}`
}

function exactPreferenceProjectionKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) {
    throw new DeliveryStoreError('invalid-intent', `${label} contains unsupported fields`)
  }
}

function exactPreferenceProjectionText(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') {
    throw new DeliveryStoreError('invalid-intent', `${label} must be a string`)
  }
  const normalized = validateBindingText(value, label, max)
  if (normalized !== value) {
    throw new DeliveryStoreError('invalid-intent', `${label} is not canonical`)
  }
  return value
}

function canonicalPreferenceProjectionScope(value: unknown): Readonly<{
  workspace: string
  preset: string
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection scope is invalid')
  }
  const record = value as Readonly<Record<string, unknown>>
  exactPreferenceProjectionKeys(record, ['workspace', 'preset'], 'preference projection scope')
  return Object.freeze({
    workspace: exactPreferenceProjectionText(record['workspace'], 'preference workspace', 4_096),
    preset: exactPreferenceProjectionText(record['preset'], 'preference preset', 200),
  })
}

function canonicalPreferenceCompletionIdentity(value: unknown): Readonly<{
  bindingId: string
  bindingVersion: number
  sessionId: string
  sourceEventId: string
  sourceInboxId: string
  replyOutboxId: string
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryStoreError('invalid-intent', 'preference completion identity is invalid')
  }
  const record = value as Readonly<Record<string, unknown>>
  exactPreferenceProjectionKeys(record, [
    'bindingId', 'bindingVersion', 'sessionId', 'sourceEventId', 'sourceInboxId', 'replyOutboxId',
  ], 'preference completion identity')
  if (!Number.isSafeInteger(record['bindingVersion']) || (record['bindingVersion'] as number) < 1) {
    throw new DeliveryStoreError('invalid-intent', 'preference binding version is invalid')
  }
  return Object.freeze({
    bindingId: exactPreferenceProjectionText(record['bindingId'], 'preference bindingId', 500),
    bindingVersion: record['bindingVersion'] as number,
    sessionId: exactPreferenceProjectionText(record['sessionId'], 'preference sessionId', 500),
    sourceEventId: exactPreferenceProjectionText(record['sourceEventId'], 'preference sourceEventId', 500),
    sourceInboxId: exactPreferenceProjectionText(record['sourceInboxId'], 'preference sourceInboxId', 500),
    replyOutboxId: exactPreferenceProjectionText(record['replyOutboxId'], 'preference replyOutboxId', 500),
  })
}

function canonicalPreferencePrincipalLineage(value: unknown): Readonly<{
  principalRecordId: string
  principalVersion: number
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryStoreError('invalid-intent', 'preference principal lineage is invalid')
  }
  const record = value as Readonly<Record<string, unknown>>
  exactPreferenceProjectionKeys(
    record,
    ['principalRecordId', 'principalVersion'],
    'preference principal lineage',
  )
  if (!Number.isSafeInteger(record['principalVersion']) || (record['principalVersion'] as number) < 1) {
    throw new DeliveryStoreError('invalid-intent', 'preference principal lineage version is invalid')
  }
  return Object.freeze({
    principalRecordId: exactPreferenceProjectionText(
      record['principalRecordId'],
      'preference principal record id',
      500,
    ),
    principalVersion: record['principalVersion'] as number,
  })
}

function canonicalPreferenceAdmissionCursor(value: unknown): Readonly<{
  epoch: string
  sequence: number
}> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryStoreError('invalid-intent', 'preference admission cursor is invalid')
  }
  const record = value as Readonly<Record<string, unknown>>
  exactPreferenceProjectionKeys(record, ['epoch', 'sequence'], 'preference admission cursor')
  if (typeof record['epoch'] !== 'string' || !/^[0-9a-f]{32}$/u.test(record['epoch'])
    || !Number.isSafeInteger(record['sequence']) || (record['sequence'] as number) < 1) {
    throw new DeliveryStoreError('invalid-intent', 'preference admission cursor is invalid')
  }
  return Object.freeze({
    epoch: record['epoch'],
    sequence: record['sequence'] as number,
  })
}

function canonicalPreferenceProjectionEvent(value: unknown): Readonly<DeliveryPreferenceEvent> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection event is invalid')
  }
  const record = value as Readonly<Record<string, unknown>>
  const source = record['source']
  const scope = canonicalPreferenceProjectionScope(record['scope'])
  const occurredAt = record['occurredAt']
  if (!Number.isSafeInteger(occurredAt) || (occurredAt as number) < 0) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection occurredAt is invalid')
  }
  const idempotencyKey = exactPreferenceProjectionText(
    record['idempotencyKey'],
    'preference event idempotencyKey',
    200,
  )
  if (record['actorTrust'] !== 'owner-authenticated') {
    throw new DeliveryStoreError('invalid-intent', 'preference projection actor is invalid')
  }
  const optionalAuthorityKeys = [
    ...(record['principalLineage'] === undefined ? [] : ['principalLineage']),
    ...(record['admissionCursor'] === undefined ? [] : ['admissionCursor']),
  ]
  const admissionCursor = record['admissionCursor'] === undefined
    ? undefined
    : canonicalPreferenceAdmissionCursor(record['admissionCursor'])
  if (source === 'delivery-completion') {
    exactPreferenceProjectionKeys(record, [
      'scope', 'principalId', ...optionalAuthorityKeys, 'actorTrust', 'source',
      'occurredAt', 'idempotencyKey', 'completion',
    ], 'preference completion')
    return Object.freeze({
      scope,
      principalId: exactPreferenceProjectionText(record['principalId'], 'preference principalId', 500),
      ...(record['principalLineage'] === undefined
        ? {}
        : { principalLineage: canonicalPreferencePrincipalLineage(record['principalLineage']) }),
      ...(admissionCursor === undefined ? {} : { admissionCursor }),
      actorTrust: 'owner-authenticated',
      source,
      occurredAt: occurredAt as number,
      idempotencyKey,
      completion: canonicalPreferenceCompletionIdentity(record['completion']),
    })
  }
  if (source === 'delivery-observation') {
    exactPreferenceProjectionKeys(record, [
      'scope', 'principalId', ...optionalAuthorityKeys, 'preferenceKey', 'candidateValue', 'stance',
      'actorTrust', 'interpretationTrust', 'source', 'occurredAt', 'idempotencyKey', 'completion',
    ], 'preference observation')
    if (record['preferenceKey'] !== 'response.language'
      || (record['candidateValue'] !== 'zh-CN' && record['candidateValue'] !== 'en')
      || record['stance'] !== 'support'
      || record['interpretationTrust'] !== 'behavioral-inference') {
      throw new DeliveryStoreError('invalid-intent', 'preference observation selection is invalid')
    }
    return Object.freeze({
      scope,
      principalId: exactPreferenceProjectionText(record['principalId'], 'preference principalId', 500),
      ...(record['principalLineage'] === undefined
        ? {}
        : { principalLineage: canonicalPreferencePrincipalLineage(record['principalLineage']) }),
      ...(admissionCursor === undefined ? {} : { admissionCursor }),
      preferenceKey: 'response.language',
      candidateValue: record['candidateValue'],
      stance: 'support',
      actorTrust: 'owner-authenticated',
      interpretationTrust: 'behavioral-inference',
      source,
      occurredAt: occurredAt as number,
      idempotencyKey,
      completion: canonicalPreferenceCompletionIdentity(record['completion']),
    })
  }
  if (source !== 'direct-owner-feedback') {
    throw new DeliveryStoreError('invalid-intent', 'preference projection source is invalid')
  }
  exactPreferenceProjectionKeys(record, [
    'scope', 'principalId', ...optionalAuthorityKeys, 'preferenceKey', 'candidateValue', 'stance',
    'actorTrust', 'interpretationTrust', 'source', 'occurredAt', 'idempotencyKey', 'exposureTarget',
  ], 'preference feedback')
  if (record['stance'] !== 'support'
    || (record['interpretationTrust'] !== 'explicit-selection'
      && record['interpretationTrust'] !== 'typed-feedback')) {
    throw new DeliveryStoreError('invalid-intent', 'preference feedback trust is invalid')
  }
  const key = record['preferenceKey']
  const candidate = record['candidateValue']
  const catalog: Readonly<Record<string, readonly string[]>> = {
    'feedback.response': [
      'helpful', 'not-helpful', 'too-long', 'too-short', 'wrong-format',
      'wrong-action', 'unwanted-reminder',
    ],
    'recommendation.ranking': ['recency', 'familiarity', 'evidence'],
    'response.explanation_depth': ['result-first', 'balanced', 'tutorial'],
    'response.language': ['zh-CN', 'en'],
    'response.structure': ['prose', 'bullets', 'mixed'],
    'response.verbosity': ['concise', 'balanced', 'detailed'],
    'suggestion.frequency': ['low', 'normal'],
  }
  if (typeof key !== 'string' || typeof candidate !== 'string'
    || !catalog[key]?.includes(candidate)) {
    throw new DeliveryStoreError('invalid-intent', 'preference feedback selection is invalid')
  }
  let exposureTarget: Readonly<{ sourceInboxId: string; sourceOutboxId: string }> | undefined
  if (record['exposureTarget'] !== undefined) {
    if (typeof record['exposureTarget'] !== 'object' || record['exposureTarget'] === null
      || Array.isArray(record['exposureTarget'])) {
      throw new DeliveryStoreError('invalid-intent', 'preference exposure target is invalid')
    }
    const target = record['exposureTarget'] as Readonly<Record<string, unknown>>
    exactPreferenceProjectionKeys(target, ['sourceInboxId', 'sourceOutboxId'], 'preference exposure target')
    exposureTarget = Object.freeze({
      sourceInboxId: exactPreferenceProjectionText(
        target['sourceInboxId'], 'preference exposure sourceInboxId', 500,
      ),
      sourceOutboxId: exactPreferenceProjectionText(
        target['sourceOutboxId'], 'preference exposure sourceOutboxId', 500,
      ),
    })
  }
  return Object.freeze({
    scope,
    principalId: exactPreferenceProjectionText(record['principalId'], 'preference principalId', 500),
    ...(record['principalLineage'] === undefined
      ? {}
      : { principalLineage: canonicalPreferencePrincipalLineage(record['principalLineage']) }),
    ...(admissionCursor === undefined ? {} : { admissionCursor }),
    preferenceKey: key,
    candidateValue: candidate,
    stance: 'support',
    actorTrust: 'owner-authenticated',
    interpretationTrust: record['interpretationTrust'],
    source,
    occurredAt: occurredAt as number,
    idempotencyKey,
    ...(exposureTarget === undefined ? {} : { exposureTarget }),
  } as DeliveryPreferenceEvent)
}

function preferenceProjectionLane(
  events: readonly Readonly<DeliveryPreferenceEvent>[],
): Readonly<PreferenceProjectionLane> | undefined {
  const exact = events.map(event => event.principalLineage !== undefined
    && event.admissionCursor !== undefined)
  if (exact.every(value => !value)) return undefined
  if (!exact.every(Boolean)) {
    throw new DeliveryStoreError(
      'invalid-intent',
      'preference projection batch mixes exact and legacy owner authority',
    )
  }
  const first = events[0]!
  const lineage = first.principalLineage!
  const cursor = first.admissionCursor!
  const lane = Object.freeze({
    epoch: cursor.epoch,
    workspace: first.scope.workspace,
    preset: first.scope.preset,
    principalRecordId: lineage.principalRecordId,
    principalVersion: lineage.principalVersion,
    admissionSequence: cursor.sequence,
  })
  if (events.some(event => event.admissionCursor!.epoch !== lane.epoch
    || event.admissionCursor!.sequence !== lane.admissionSequence
    || event.scope.workspace !== lane.workspace || event.scope.preset !== lane.preset
    || event.principalLineage!.principalRecordId !== lane.principalRecordId
    || event.principalLineage!.principalVersion !== lane.principalVersion)) {
    throw new DeliveryStoreError(
      'invalid-intent',
      'preference projection batch spans multiple owner admission lanes',
    )
  }
  return lane
}

function preferenceProjectionPayload(
  events: readonly Readonly<DeliveryPreferenceEvent>[],
): {
  batchKey: string
  digest: string
  json: string
  events: readonly Readonly<DeliveryPreferenceEvent>[]
  lane?: Readonly<PreferenceProjectionLane>
} {
  if (!Array.isArray(events) || events.length < 1 || events.length > 16) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection batch must contain 1-16 events')
  }
  const canonicalEvents = Object.freeze(events.map(event => canonicalPreferenceProjectionEvent(event)))
  const lane = preferenceProjectionLane(canonicalEvents)
  const identities = canonicalEvents.map(event => event.idempotencyKey)
  if (new Set(identities).size !== identities.length) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection batch contains duplicate events')
  }
  const json = JSON.stringify(canonicalEvents)
  if (Buffer.byteLength(json, 'utf8') > 131_072) {
    throw new DeliveryStoreError('invalid-intent', 'preference projection batch exceeds its byte cap')
  }
  return {
    batchKey: preferenceProjectionBatchKey(canonicalEvents),
    digest: createHash('sha256').update(json).digest('hex'),
    json,
    events: canonicalEvents,
    ...(lane === undefined ? {} : { lane }),
  }
}

function preferenceProjectionOutboxEntry(
  row: PreferenceProjectionOutboxRow,
): PreferenceProjectionOutboxEntry {
  let parsed: unknown
  try {
    parsed = JSON.parse(row.events_json) as unknown
  } catch {
    throw new DeliveryStoreError('conflict', 'preference projection payload is corrupt')
  }
  if (!Array.isArray(parsed)) {
    throw new DeliveryStoreError('conflict', 'preference projection payload is not a batch')
  }
  const payload = preferenceProjectionPayload(parsed as DeliveryPreferenceEvent[])
  if (payload.batchKey !== row.batch_key || payload.digest !== row.payload_digest
    || payload.json !== row.events_json) {
    throw new DeliveryStoreError('conflict', 'preference projection columns do not match payload')
  }
  const storedLaneColumns = [
    row.lane_epoch,
    row.lane_workspace,
    row.lane_preset,
    row.lane_principal_record_id,
    row.lane_principal_version,
    row.admission_sequence,
  ]
  if (row.lane_kind === 'exact') {
    if (storedLaneColumns.some(value => value === null) || payload.lane === undefined
      || row.lane_epoch !== payload.lane.epoch
      || row.lane_workspace !== payload.lane.workspace
      || row.lane_preset !== payload.lane.preset
      || row.lane_principal_record_id !== payload.lane.principalRecordId
      || row.lane_principal_version !== payload.lane.principalVersion
      || row.admission_sequence !== payload.lane.admissionSequence) {
      throw new DeliveryStoreError('conflict', 'preference projection lane columns do not match payload')
    }
  } else if (row.lane_kind === 'legacy'
    && (payload.lane !== undefined || storedLaneColumns.some(value => value !== null))) {
    throw new DeliveryStoreError('conflict', 'legacy preference projection has exact lane authority')
  }
  return Object.freeze({
    batchKey: row.batch_key,
    payloadDigest: row.payload_digest,
    events: payload.events,
    ...(payload.lane === undefined ? {} : { lane: payload.lane }),
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
  })
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

interface DeadLetterResolutionRow {
  kind: DeadLetterResolutionKind
  message_id: string
  attempt_count: number
  receipt_version: 1
  resolution: DeadLetterResolutionReceipt['resolution']
  original_status: DeadLetterResolutionStatus
  original_failure_code: string | null
  operator_id: string
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

function deadLetterResolutionFromRow(row: DeadLetterResolutionRow): DeadLetterResolutionReceipt {
  return {
    receiptVersion: row.receipt_version,
    kind: row.kind,
    id: row.message_id,
    attemptCount: row.attempt_count,
    resolution: row.resolution,
    originalStatus: row.original_status,
    ...(row.original_failure_code === null ? {} : { originalFailureCode: row.original_failure_code }),
    operatorId: row.operator_id,
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
    (SELECT epoch FROM delivery_inbox_admissions WHERE inbox_id = inbox_messages.id)
      AS admission_epoch,
    (SELECT admission_sequence FROM delivery_inbox_admissions WHERE inbox_id = inbox_messages.id)
      AS admission_sequence,
    received_at, updated_at
  FROM inbox_messages
`

const outboxSelect = `
  SELECT id, intent_hash, intent_json, status, provider_message_id, attempt_count,
    next_attempt_at, claimed_by, fencing_token, lease_until, failure_code, created_at, updated_at
  FROM outbox_messages
`

const deliveryPresentationSelect = `
  SELECT presentation_key, original_outbox_idempotency_key, revision, payload_hash, payload_json,
    status, attempt_count, presented_revision, next_attempt_at, claimed_by, fencing_token,
    lease_until, provider_message_id, failure_code, created_at, updated_at
  FROM delivery_presentations
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

function approvalRouteText(value: unknown, field: string, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new DeliveryStoreError('invalid-intent', `approval route ${field} is invalid`)
  }
  const normalized = value.normalize('NFC').trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || normalized !== value || Buffer.byteLength(normalized, 'utf8') > maxBytes || hasControl) {
    throw new DeliveryStoreError('invalid-intent', `approval route ${field} is invalid`)
  }
  return normalized
}

function canonicalApprovalDispatchRoute(input: unknown): ApprovalDispatchRouteV2 {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeliveryStoreError('invalid-intent', 'approval route must be a v2 object')
  }
  const route = input as Record<string, unknown>
  const fields = [
    'bindingGeneration', 'bindingId', 'bindingVersion', 'principal', 'principalRecordId',
    'principalVersion', 'routeVersion', 'sourceId', 'workspace',
  ]
  if (Object.keys(route).sort().join(',') !== fields.join(',') || route.routeVersion !== 2) {
    throw new DeliveryStoreError('invalid-intent', 'approval route must be complete route version 2')
  }
  const sourceId = approvalRouteText(route.sourceId, 'sourceId', 256)
  const bindingId = approvalRouteText(route.bindingId, 'bindingId', 512)
  const workspace = approvalRouteText(route.workspace, 'workspace', 4_096)
  const principal = approvalRouteText(route.principal, 'principal', 512)
  const principalRecordId = approvalRouteText(route.principalRecordId, 'principalRecordId', 500)
  if (!isAbsolute(workspace)
    || !Number.isSafeInteger(route.bindingVersion) || (route.bindingVersion as number) < 1
    || !Number.isSafeInteger(route.bindingGeneration) || (route.bindingGeneration as number) < 1
    || !Number.isSafeInteger(route.principalVersion) || (route.principalVersion as number) < 1) {
    throw new DeliveryStoreError('invalid-intent', 'approval route fence is invalid')
  }
  return Object.freeze({
    routeVersion: 2,
    sourceId,
    bindingId,
    bindingVersion: route.bindingVersion as number,
    bindingGeneration: route.bindingGeneration as number,
    workspace,
    principal,
    principalRecordId,
    principalVersion: route.principalVersion as number,
  })
}

function approvalRouteFromRow(row: ApprovalOutboxRouteRow): ApprovalDispatchRouteV2 {
  return canonicalApprovalDispatchRoute({
    routeVersion: row.route_version,
    sourceId: row.source_id,
    bindingId: row.binding_id,
    bindingVersion: row.binding_version,
    bindingGeneration: row.binding_generation,
    workspace: row.workspace,
    principal: row.principal,
    principalRecordId: row.principal_record_id,
    principalVersion: row.principal_version,
  })
}

function sameApprovalRoute(left: ApprovalDispatchRouteV2, right: ApprovalDispatchRouteV2): boolean {
  return left.routeVersion === right.routeVersion
    && left.sourceId === right.sourceId
    && left.bindingId === right.bindingId
    && left.bindingVersion === right.bindingVersion
    && left.bindingGeneration === right.bindingGeneration
    && left.workspace === right.workspace
    && left.principal === right.principal
    && left.principalRecordId === right.principalRecordId
    && left.principalVersion === right.principalVersion
}

function resolutionOperatorId(value: unknown): string {
  try {
    return canonicalLocalOperatorId(value)
  } catch {
    throw new DeliveryStoreError('conflict', 'dead-letter operator identity is invalid')
  }
}

function boundedMaintenanceLimit(value: number | undefined, fallback: number, label: string): number {
  const limit = value ?? fallback
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new DeliveryStoreError('conflict', `invalid ${label} maintenance limit`)
  }
  return limit
}

function inboxFromRow(row: InboxRow): InboxRecord {
  if (!/^[0-9a-f]{32}$/u.test(row.admission_epoch)
    || !Number.isSafeInteger(row.admission_sequence) || row.admission_sequence < 1) {
    throw new DeliveryStoreError('conflict', 'Inbox admission cursor is missing or corrupt')
  }
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
    admissionCursor: Object.freeze({
      epoch: row.admission_epoch,
      sequence: row.admission_sequence,
    }),
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

function deliveryPresentationFromRow(row: DeliveryPresentationRow): StoredDeliveryPresentation {
  let presentation: DeliveryPresentation
  try {
    presentation = canonicalDeliveryPresentation(JSON.parse(row.payload_json) as DeliveryPresentation)
    const canonicalJson = JSON.stringify(presentation)
    if (canonicalJson !== row.payload_json || digest(canonicalJson) !== row.payload_hash
      || !Number.isSafeInteger(row.revision) || row.revision < 1
      || !Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0
      || !Number.isSafeInteger(row.presented_revision) || row.presented_revision < 0
      || row.presented_revision > row.revision
      || !Number.isSafeInteger(row.created_at) || !Number.isSafeInteger(row.updated_at)
      || (row.status === 'presented' && row.provider_message_id === null)) {
      throw new Error('invalid stored presentation')
    }
  } catch {
    throw new DeliveryStoreError('invalid-intent', 'stored delivery presentation is invalid')
  }
  return {
    presentationKey: row.presentation_key,
    originalOutboxIdempotencyKey: row.original_outbox_idempotency_key,
    revision: row.revision,
    presentation,
    status: row.status,
    attemptCount: row.attempt_count,
    presentedRevision: row.presented_revision,
    ...(row.provider_message_id === null ? {} : { providerMessageId: row.provider_message_id }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function canonicalDeliveryPresentation(input: DeliveryPresentation): DeliveryPresentation {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new DeliveryStoreError('invalid-intent', 'delivery presentation kind is invalid')
  }
  if (input.kind === 'automation-incident') {
    const allowed = new Set([
      'kind', 'incidentId', 'automationId', 'definitionHash', 'stage', 'state',
      'failureClass', 'failurePhase', 'failureCode', 'sideEffectState', 'retryability',
      'lifecycleGeneration', 'incidentRevision', 'openedAt', 'updatedAt', 'resolvedAt',
    ])
    if (Object.keys(input).some(key => !allowed.has(key))) {
      throw new DeliveryStoreError('invalid-intent', 'automation incident presentation shape is invalid')
    }
    const incidentId = validateBindingText(input.incidentId, 'incidentId', 500)
    const automationId = validateBindingText(input.automationId, 'automationId', 500)
    const token = (value: unknown): value is string => typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(value)
    if (!/^[a-f0-9]{64}$/u.test(input.definitionHash)
      || !['claim', 'materialize', 'terminal'].includes(input.stage)
      || !['open', 'recovering', 'resolved'].includes(input.state)
      || !['budget', 'cancelled', 'configuration', 'execution', 'infrastructure',
        'policy', 'provider', 'timeout', 'unknown'].includes(input.failureClass)
      || !token(input.failurePhase) || !token(input.failureCode)
      || !['none', 'possible', 'unknown'].includes(input.sideEffectState)
      || !['after-intervention', 'safe', 'unsafe', 'unknown'].includes(input.retryability)
      || !Number.isSafeInteger(input.lifecycleGeneration) || input.lifecycleGeneration < 1
      || !Number.isSafeInteger(input.incidentRevision) || input.incidentRevision < 1
      || !Number.isSafeInteger(input.openedAt) || input.openedAt < 0
      || !Number.isSafeInteger(input.updatedAt) || input.updatedAt < input.openedAt
      || (input.state === 'resolved') !== (input.resolvedAt !== undefined)
      || (input.resolvedAt !== undefined
        && (!Number.isSafeInteger(input.resolvedAt) || input.resolvedAt < input.openedAt))) {
      throw new DeliveryStoreError('invalid-intent', 'automation incident presentation is invalid')
    }
    return Object.freeze({
      kind: 'automation-incident' as const,
      incidentId,
      automationId,
      definitionHash: input.definitionHash,
      stage: input.stage,
      state: input.state,
      failureClass: input.failureClass,
      failurePhase: input.failurePhase,
      failureCode: input.failureCode,
      sideEffectState: input.sideEffectState,
      retryability: input.retryability,
      lifecycleGeneration: input.lifecycleGeneration,
      incidentRevision: input.incidentRevision,
      openedAt: input.openedAt,
      updatedAt: input.updatedAt,
      ...(input.resolvedAt === undefined ? {} : { resolvedAt: input.resolvedAt }),
    })
  }
  if (input.kind !== 'approval-application') {
    throw new DeliveryStoreError('invalid-intent', 'delivery presentation kind is invalid')
  }
  const allowed = new Set([
    'kind', 'policyProposalId', 'localProposalId', 'applicationStatus', 'operation',
    'terminalAt', 'receiptDigest', 'ruleId', 'resultingRuleVersion', 'ruleStatus',
  ])
  if (Object.keys(input).some(key => !allowed.has(key))) {
    throw new DeliveryStoreError('invalid-intent', 'delivery presentation shape is invalid')
  }
  const policyProposalId = validateBindingText(input.policyProposalId, 'policyProposalId', 200)
  const localProposalId = validateBindingText(input.localProposalId, 'localProposalId', 200)
  if (!['applied', 'conflicted', 'expired', 'rejected'].includes(input.applicationStatus)
    || !['adopt', 'owner-undo', 'retire'].includes(input.operation)
    || !Number.isSafeInteger(input.terminalAt) || input.terminalAt < 0
    || !/^[a-f0-9]{64}$/u.test(input.receiptDigest)) {
    throw new DeliveryStoreError('invalid-intent', 'approval application presentation is invalid')
  }
  const ruleId = input.ruleId === undefined
    ? undefined
    : validateBindingText(input.ruleId, 'ruleId', 200)
  const resultingRuleVersion = input.resultingRuleVersion
  if (resultingRuleVersion !== undefined
    && (!Number.isSafeInteger(resultingRuleVersion) || resultingRuleVersion < 1)) {
    throw new DeliveryStoreError('invalid-intent', 'presentation rule version is invalid')
  }
  if (input.ruleStatus !== undefined && input.ruleStatus !== 'active' && input.ruleStatus !== 'retired') {
    throw new DeliveryStoreError('invalid-intent', 'presentation rule status is invalid')
  }
  if (input.applicationStatus === 'applied'
    && (ruleId === undefined || resultingRuleVersion === undefined || input.ruleStatus === undefined)) {
    throw new DeliveryStoreError('invalid-intent', 'applied presentation requires exact rule terminal state')
  }
  return Object.freeze({
    kind: 'approval-application' as const,
    policyProposalId,
    localProposalId,
    applicationStatus: input.applicationStatus,
    operation: input.operation,
    terminalAt: input.terminalAt,
    receiptDigest: input.receiptDigest,
    ...(ruleId === undefined ? {} : { ruleId }),
    ...(resultingRuleVersion === undefined ? {} : { resultingRuleVersion }),
    ...(input.ruleStatus === undefined ? {} : { ruleStatus: input.ruleStatus }),
  })
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

const ownerRouteReceiptKeys = [
  'dsh.route.authority',
  'dsh.route.authorityHash',
  'dsh.route.bindingVersion',
  'dsh.route.generation',
  'dsh.route.initialBindingId',
  'dsh.route.initialBindingVersion',
  'dsh.route.initialGeneration',
  'dsh.route.minimumGeneration',
  'dsh.route.receiptVersion',
  'dsh.route.sourceHash',
  'dsh.route.sourceId',
] as const

interface OwnerRouteReceiptEvidence {
  authorityId: string
  authorityHash: string
  bindingVersion: number
  generation: number
  initialBindingId: string
  initialBindingVersion: number
  initialGeneration: number
  minimumGeneration: number
  sourceHash: string
  sourceId: string
}

type ParsedOwnerRouteReceipt =
  | { kind: 'not-route' }
  | { kind: 'invalid' }
  | { kind: 'route'; evidence: OwnerRouteReceiptEvidence }

type InspectedOwnerRouteDispatch =
  | { kind: 'not-route' }
  | { kind: 'deferred'; failureCode: string }
  | { kind: 'denied'; failureCode: string }
  | {
    kind: 'authorized'
    authority: OwnerRouteAuthority
    binding: ConversationBinding
    evidence: OwnerRouteReceiptEvidence
  }

function exactPositiveIntegerText(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9][0-9]*$/u.test(value)) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : undefined
}

function parseOwnerRouteReceipt(record: Readonly<OutboxRecord>): ParsedOwnerRouteReceipt {
  const metadata = record.intent.metadata
  const authorityId = metadata?.['dsh.route.authority']
  if (authorityId === undefined) return { kind: 'not-route' }
  if (metadata === undefined
    || Object.keys(metadata).length !== ownerRouteReceiptKeys.length
    || Object.keys(metadata).some(key => !(ownerRouteReceiptKeys as readonly string[]).includes(key))
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(authorityId)
    || !/^[a-f0-9]{64}$/u.test(metadata['dsh.route.authorityHash'] ?? '')
    || !/^[a-f0-9]{64}$/u.test(metadata['dsh.route.sourceHash'] ?? '')
    || metadata['dsh.route.receiptVersion'] !== '2'
    || !['plain', 'markdown'].includes(record.intent.format ?? 'plain')
    || record.intent.approval !== undefined
    || record.intent.modelPicker !== undefined
    || record.intent.permissionPicker !== undefined
    || record.intent.replyToEventId !== undefined) return { kind: 'invalid' }
  let sourceId: string
  let initialBindingId: string
  try {
    sourceId = canonicalBackgroundSourceId(metadata['dsh.route.sourceId'])
    initialBindingId = validateBindingText(metadata['dsh.route.initialBindingId']!, 'initialBindingId', 256)
  } catch {
    return { kind: 'invalid' }
  }
  const bindingVersion = exactPositiveIntegerText(metadata['dsh.route.bindingVersion'])
  const generation = exactPositiveIntegerText(metadata['dsh.route.generation'])
  const initialBindingVersion = exactPositiveIntegerText(metadata['dsh.route.initialBindingVersion'])
  const initialGeneration = exactPositiveIntegerText(metadata['dsh.route.initialGeneration'])
  const minimumGeneration = exactPositiveIntegerText(metadata['dsh.route.minimumGeneration'])
  const sourceHash = metadata['dsh.route.sourceHash']!
  if (bindingVersion === undefined || generation === undefined
    || initialBindingVersion === undefined || initialGeneration === undefined
    || minimumGeneration === undefined
    || sourceId !== metadata['dsh.route.sourceId']
    || digest(sourceId) !== sourceHash) return { kind: 'invalid' }
  return {
    kind: 'route',
    evidence: {
      authorityId,
      authorityHash: metadata['dsh.route.authorityHash']!,
      bindingVersion,
      generation,
      initialBindingId,
      initialBindingVersion,
      initialGeneration,
      minimumGeneration,
      sourceHash,
      sourceId,
    },
  }
}

function ownerRouteReceiptMetadata(input: {
  authority: Readonly<OwnerRouteAuthority>
  binding: Readonly<ConversationBinding>
  sourceId: string
  initial?: Pick<OwnerRouteReceiptEvidence,
    'initialBindingId' | 'initialBindingVersion' | 'initialGeneration'>
}): Readonly<Record<string, string>> {
  const snapshot = ownerRouteBindingSnapshot(input.authority, input.binding)
  const initial = input.initial ?? {
    initialBindingId: snapshot.bindingId,
    initialBindingVersion: snapshot.bindingVersion,
    initialGeneration: snapshot.generation,
  }
  return {
    'dsh.route.authority': snapshot.authorityId,
    'dsh.route.authorityHash': snapshot.authorityHash,
    'dsh.route.bindingVersion': String(snapshot.bindingVersion),
    'dsh.route.generation': String(snapshot.generation),
    'dsh.route.initialBindingId': initial.initialBindingId,
    'dsh.route.initialBindingVersion': String(initial.initialBindingVersion),
    'dsh.route.initialGeneration': String(initial.initialGeneration),
    'dsh.route.minimumGeneration': String(snapshot.minimumGeneration),
    'dsh.route.receiptVersion': String(snapshot.receiptVersion),
    'dsh.route.sourceHash': digest(input.sourceId),
    'dsh.route.sourceId': input.sourceId,
  }
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
    const now = this.now()
    const authorityDigest = growthObjectDigest({
      contract: 'assistant-delivery-workflow-trace-source/v1',
      databaseInstanceId: this.databaseInstanceId,
      sourceId: WORKFLOW_TRACE_SOURCE_ID,
    })
    this.database.prepare(`
      INSERT INTO workflow_trace_source(
        singleton, contract_version, generation, authority_digest, created_at, updated_at
      ) VALUES (1, 1, 1, ?, ?, ?)
      ON CONFLICT(singleton) DO NOTHING
    `).run(authorityDigest, now, now)
    const traceSource = this.database.prepare(`
      SELECT contract_version, generation, authority_digest
      FROM workflow_trace_source WHERE singleton = 1
    `).get() as { contract_version: number; generation: number; authority_digest: string } | undefined
    if (traceSource?.contract_version !== ASSISTANT_GROWTH_CONTRACT_VERSION
      || traceSource.generation < 1 || !/^[a-f0-9]{64}$/u.test(traceSource.authority_digest)
      || traceSource.authority_digest !== authorityDigest) {
      this.database.close()
      this.closed = true
      throw new DeliveryStoreError('conflict', 'workflow trace source authority is missing or stale')
    }
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
      // Projection authority is the exact durable owner row, not the external
      // principal string. In particular, A -> B -> A gives A a new row
      // version. Retire every batch that cannot belong to this exact version
      // in the same transaction as the handoff so restart/requeue can never
      // resurrect an older owner's evidence. Legacy and unclassified rows are
      // deliberately included because they cannot prove an exact lineage.
      this.database.prepare(`
        UPDATE delivery_preference_projection_outbox
        SET terminal_at = ?, failure_code = 'owner-lineage-retired',
          next_attempt_at = 9007199254740991, updated_at = ?
        WHERE terminal_at IS NULL AND status IN ('pending', 'retry_wait')
          AND NOT (
            lane_kind = 'exact'
            AND lane_principal_record_id = ?
            AND lane_principal_version = ?
          )
      `).run(now, now, result.id, result.version)
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

  private getBindingPrincipal(bindingId: string): DeliveryPrincipal | undefined {
    const row = this.database.prepare(`
      SELECT principal.id, principal.principal_json, principal.role, principal.status,
        principal.linked_to_id, principal.created_at, principal.updated_at, principal.version
      FROM conversation_bindings AS binding
      JOIN delivery_principals AS principal ON principal.id = binding.principal_id
      WHERE binding.id = ?
    `).get(bindingId) as PrincipalRow | undefined
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

  /** Snapshot one exact active owner binding under the Delivery write fence. */
  resolveApprovalRouteByBinding(input: Readonly<{
    sourceId: string
    bindingId: string
    scope: Readonly<{ workspace: string; preset: string }>
    principalId?: string
  }>): ApprovalDispatchRouteV2 | undefined {
    this.assertOpen()
    let sourceId: string
    let bindingId: string
    let workspace: string
    let preset: string
    let principalId: string | undefined
    try {
      sourceId = canonicalBackgroundSourceId(input.sourceId)
      bindingId = approvalRouteText(input.bindingId, 'bindingId', 512)
      workspace = approvalRouteText(input.scope.workspace, 'workspace', 4_096)
      preset = approvalRouteText(input.scope.preset, 'preset', 256)
      principalId = input.principalId === undefined
        ? undefined
        : approvalRouteText(input.principalId, 'principalId', 512)
    } catch {
      throw new DeliveryStoreError('invalid-binding', 'approval route resolution input is invalid')
    }
    if (!isAbsolute(workspace)) {
      throw new DeliveryStoreError('invalid-binding', 'approval route workspace is invalid')
    }
    return this.transaction(() => {
      const binding = this.getBinding(bindingId)
      const owner = binding === undefined ? undefined : this.getBindingPrincipal(binding.id)
      const currentPrincipalId = binding === undefined ? undefined : externalPrincipalId(binding.principal)
      if (binding?.status !== 'active' || binding.workspace !== workspace || binding.agentPreset !== preset
        || owner?.status !== 'active' || owner.role !== 'owner'
        || JSON.stringify(owner.principal) !== JSON.stringify(binding.principal)
        || currentPrincipalId === undefined
        || (principalId !== undefined && currentPrincipalId !== principalId)) return undefined
      return Object.freeze({
        routeVersion: 2 as const,
        sourceId,
        bindingId: binding.id,
        bindingVersion: binding.version,
        bindingGeneration: binding.generation,
        workspace: binding.workspace,
        principal: currentPrincipalId,
        principalRecordId: owner.id,
        principalVersion: owner.version,
      })
    })
  }

  /** Resolve one unique current owner from content-free Host authority evidence. */
  resolveOwnerApprovalForPreference(
    input: Readonly<OwnerApprovalForPreferenceInput>,
  ): ApprovalDispatchRouteV2 | undefined {
    this.assertOpen()
    let sourceId: string
    let workspace: string
    let preset: string
    let principalId: string
    let principalRecordId: string
    try {
      sourceId = canonicalBackgroundSourceId(input.sourceId)
      workspace = approvalRouteText(input.scope.workspace, 'workspace', 4_096)
      preset = approvalRouteText(input.scope.preset, 'preset', 256)
      principalId = approvalRouteText(input.principalId, 'principalId', 512)
      principalRecordId = approvalRouteText(
        input.principalLineage.principalRecordId,
        'principalRecordId',
        500,
      )
    } catch {
      throw new DeliveryStoreError('invalid-binding', 'owner approval authority input is invalid')
    }
    if (!isAbsolute(workspace)
      || !Number.isSafeInteger(input.principalLineage.principalVersion)
      || input.principalLineage.principalVersion < 1
      || !Number.isSafeInteger(input.ownerGeneration) || input.ownerGeneration < 1) {
      throw new DeliveryStoreError('invalid-binding', 'owner approval authority fence is invalid')
    }
    return this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT binding.id, binding.conversation_json, binding.principal_json, binding.workspace,
          binding.agent_preset, binding.session_id, binding.generation, binding.policy_ref,
          binding.status, binding.created_at, binding.updated_at, binding.version
        FROM conversation_bindings AS binding
        JOIN delivery_principals AS principal ON principal.id = binding.principal_id
        WHERE binding.status = 'active' AND binding.workspace = ? AND binding.agent_preset = ?
          AND principal.id = ? AND principal.version = ?
          AND principal.status = 'active' AND principal.role = 'owner'
        ORDER BY binding.id LIMIT 2
      `).all(
        workspace,
        preset,
        principalRecordId,
        input.principalLineage.principalVersion,
      ) as unknown as BindingRow[]
      if (rows.length !== 1) return undefined
      const binding = bindingFromRow(rows[0]!)
      const owner = this.getBindingPrincipal(binding.id)
      if (externalPrincipalId(binding.principal) !== principalId
        || binding.generation !== input.ownerGeneration
        || owner?.status !== 'active' || owner.role !== 'owner'
        || owner.id !== principalRecordId || owner.version !== input.principalLineage.principalVersion
        || JSON.stringify(owner.principal) !== JSON.stringify(binding.principal)) return undefined
      return Object.freeze({
        routeVersion: 2 as const,
        sourceId,
        bindingId: binding.id,
        bindingVersion: binding.version,
        bindingGeneration: binding.generation,
        workspace: binding.workspace,
        principal: principalId,
        principalRecordId,
        principalVersion: input.principalLineage.principalVersion,
      })
    })
  }

  getBindingBySession(sessionId: string): ConversationBinding | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${bindingSelect} WHERE session_id = ?`).get(sessionId) as BindingRow | undefined
    return row === undefined ? undefined : bindingFromRow(row)
  }

  /** Read one exact Agent owner attestation under a single SQLite snapshot. */
  getPreferencePrincipalForSession(input: Readonly<{
    sessionId: string
    workspace: string | undefined
    preset: string | undefined
  }>): Readonly<{ binding: ConversationBinding; principal: DeliveryPrincipal }> | undefined {
    this.assertOpen()
    if (typeof input.sessionId !== 'string' || typeof input.workspace !== 'string'
      || typeof input.preset !== 'string') return undefined
    return this.transaction(() => {
      const binding = this.getBindingBySession(input.sessionId)
      const principal = binding === undefined ? undefined : this.getBindingPrincipal(binding.id)
      if (binding?.status !== 'active' || binding.sessionId !== input.sessionId
        || binding.workspace !== input.workspace || binding.agentPreset !== input.preset
        || principal?.status !== 'active' || principal.role !== 'owner'
        || JSON.stringify(principal.principal) !== JSON.stringify(binding.principal)) return undefined
      return Object.freeze({ binding, principal })
    })
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

  /**
   * Remove one now-invalid persisted effort without replacing a newer model choice.
   *
   * Model capability directories are intentionally live data: an effort selected yesterday can
   * disappear when a provider changes a model or account entitlement.  The compare-and-swap keeps
   * a concurrently chosen provider/model/effort authoritative instead of silently applying this
   * recovery to it.
   */
  clearStaleModelReasoningEffort(input: {
    conversation: ConversationRef
    expected: Pick<ConversationModelSelection, 'provider' | 'model' | 'reasoningEffort' | 'version'>
  }): { applied: false } | { applied: true; selection: ConversationModelSelection } {
    this.assertOpen()
    const conversation = canonicalConversation(input.conversation)
    const expected = canonicalModelRoute(input.expected)
    const staleEffort = expected.reasoningEffort
    if (staleEffort === undefined) return { applied: false }
    const changed = this.database.prepare(`
      UPDATE conversation_model_selections
      SET reasoning_effort = NULL, updated_at = ?, version = version + 1
      WHERE conversation_hash = ? AND conversation_json = ?
        AND provider = ? AND model = ? AND reasoning_effort = ? AND version = ?
    `).run(
      this.now(),
      conversationHash(conversation),
      conversationJson(conversation),
      expected.provider,
      expected.model,
      staleEffort,
      input.expected.version,
    )
    if (changed.changes !== 1) return { applied: false }
    const selection = this.getModelSelection(conversation)
    if (selection === undefined || selection.reasoningEffort !== undefined) {
      throw new DeliveryStoreError('conflict', 'stale reasoning effort recovery did not persist')
    }
    return { applied: true, selection }
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
      const boundaryRow = this.database.prepare(`
        SELECT admission.admission_sequence
        FROM inbox_messages AS message
        JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
        WHERE message.id = ?
      `).get(beforeInboxId) as { admission_sequence: number } | undefined
      if (boundaryRow === undefined) {
        throw new DeliveryStoreError('not-found', 'inbox cancellation boundary was not found')
      }
      const dispatchingRows = this.database.prepare(`
        SELECT message.id, message.envelope_json FROM inbox_messages AS message
        JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
        WHERE admission.admission_sequence < ?
          AND message.status = 'claimed' AND message.failure_code = 'dispatch-started'
          AND (binding_id = ? OR (
            json_extract(envelope_json, '$.conversation') = json(?)
            AND json_extract(envelope_json, '$.principal') = json(?)
          ))
        ORDER BY admission.admission_sequence
      `).all(boundaryRow.admission_sequence, bindingId, bindingConversationJson, bindingPrincipalJson) as unknown as {
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
        SELECT message.id FROM inbox_messages AS message
        JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
        WHERE admission.admission_sequence < ?
          AND message.status = 'claimed' AND message.failure_code IS NULL
          AND (binding_id = ? OR (
            json_extract(envelope_json, '$.conversation') = json(?)
            AND json_extract(envelope_json, '$.principal') = json(?)
          ))
        ORDER BY admission.admission_sequence
      `).all(boundaryRow.admission_sequence, bindingId, bindingConversationJson, bindingPrincipalJson) as unknown as { id: string }[]
      this.database.prepare(`
        UPDATE inbox_attempts SET status = 'dead_letter', failure_code = ?, finished_at = ?
        WHERE status = 'claimed' AND inbox_id IN (
          SELECT message.id FROM inbox_messages AS message
          JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
          WHERE admission.admission_sequence < ?
            AND message.status = 'claimed' AND message.failure_code IS NULL
            AND (binding_id = ? OR (
              json_extract(envelope_json, '$.conversation') = json(?)
              AND json_extract(envelope_json, '$.principal') = json(?)
            ))
        )
      `).run(failureCode, now, boundaryRow.admission_sequence, bindingId, bindingConversationJson, bindingPrincipalJson)
      const cancelled = this.database.prepare(`
        UPDATE inbox_messages SET status = 'dead_letter', failure_code = ?, next_attempt_at = NULL,
          claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id IN (
          SELECT message.id FROM inbox_messages AS message
          JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
          WHERE admission.admission_sequence < ?
            AND (message.binding_id = ? OR (
              json_extract(message.envelope_json, '$.conversation') = json(?)
              AND json_extract(message.envelope_json, '$.principal') = json(?)
            ))
            AND (message.status IN ('received', 'authorized', 'queued', 'retry_wait')
              OR (message.status = 'claimed' AND message.failure_code IS NULL))
        )
      `).run(failureCode, now, boundaryRow.admission_sequence, bindingId, bindingConversationJson, bindingPrincipalJson)
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
    const boundary = this.database.prepare(`
      SELECT admission.admission_sequence
      FROM inbox_messages AS message
      JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
      WHERE message.id = ?
    `).get(beforeInboxId) as { admission_sequence: number } | undefined
    if (boundary === undefined) throw new DeliveryStoreError('not-found', 'inbound recovery boundary Inbox was not found')
    const row = this.database.prepare(`${inboxSelect}
      JOIN delivery_inbox_admissions AS pending_admission ON pending_admission.inbox_id = inbox_messages.id
      WHERE pending_admission.admission_sequence < ? AND status IN ('received', 'authorized')
        AND json_extract(envelope_json, '$.conversation') = json(?)
        AND json_extract(envelope_json, '$.principal') = json(?)
      ORDER BY pending_admission.admission_sequence LIMIT 1
    `).get(
      boundary.admission_sequence,
      conversationJson(target.conversation),
      principalJson(target.principal),
    ) as InboxRow | undefined
    return row === undefined ? undefined : inboxFromRow(row)
  }

  listInbox(input: { bindingId?: string; limit?: number } = {}): InboxRecord[] {
    this.assertOpen()
    const limit = Math.max(1, Math.min(100, input.limit ?? 20))
    const rows = input.bindingId === undefined
      ? this.database.prepare(`${inboxSelect} ORDER BY received_at DESC, admission_sequence DESC LIMIT ?`).all(limit)
      : this.database.prepare(`${inboxSelect} WHERE binding_id = ? ORDER BY received_at DESC, admission_sequence DESC LIMIT ?`)
        .all(input.bindingId, limit)
    return (rows as unknown as InboxRow[]).map(inboxFromRow)
  }

  getDeadLetterResolution(input: {
    kind: DeadLetterResolutionKind
    id: string
    attemptCount: number
  }): DeadLetterResolutionReceipt | undefined {
    this.assertOpen()
    if (!['inbox', 'outbox'].includes(input.kind)
      || !Number.isSafeInteger(input.attemptCount) || input.attemptCount < 0) {
      throw new DeliveryStoreError('conflict', 'dead-letter resolution identity is invalid')
    }
    const id = validateBindingText(input.id, 'messageId', 256)
    const row = this.database.prepare(`
      SELECT kind, message_id, attempt_count, receipt_version, resolution, original_status,
        original_failure_code, operator_id, created_at
      FROM dead_letter_resolutions
      WHERE kind = ? AND message_id = ? AND attempt_count = ?
    `).get(input.kind, id, input.attemptCount) as DeadLetterResolutionRow | undefined
    return row === undefined ? undefined : deadLetterResolutionFromRow(row)
  }

  health(): {
    pendingInbox: number
    /** All retained Inbox rows in dead_letter, including operator-resolved tombstones. */
    deadLetterInbox: number
    actionableDeadLetterInbox: number
    resolvedDeadLetterInbox: number
    pendingOutbox: number
    /** All retained Outbox rows in dead, including operator-resolved tombstones. */
    deadLetterOutbox: number
    actionableDeadLetterOutbox: number
    resolvedDeadLetterOutbox: number
    /** All retained ambiguous Outbox rows, including operator-resolved tombstones. */
    unknownOutbox: number
    actionableUnknownOutbox: number
    resolvedUnknownOutbox: number
    pendingPresentations: number
    deadPresentations: number
  } {
    this.assertOpen()
    const scalar = (sql: string) => (this.database.prepare(sql).get() as { count: number }).count
    return {
      pendingInbox: scalar("SELECT COUNT(*) AS count FROM inbox_messages WHERE status IN ('received', 'authorized', 'queued', 'claimed', 'retry_wait')"),
      deadLetterInbox: scalar("SELECT COUNT(*) AS count FROM inbox_messages WHERE status = 'dead_letter'"),
      actionableDeadLetterInbox: scalar(`
        SELECT COUNT(*) AS count FROM inbox_messages AS message
        WHERE message.status = 'dead_letter' AND NOT EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'inbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      resolvedDeadLetterInbox: scalar(`
        SELECT COUNT(*) AS count FROM inbox_messages AS message
        WHERE message.status = 'dead_letter' AND EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'inbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      pendingOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status IN ('pending', 'attempting', 'retry_wait')"),
      deadLetterOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'dead'"),
      actionableDeadLetterOutbox: scalar(`
        SELECT COUNT(*) AS count FROM outbox_messages AS message
        WHERE message.status = 'dead' AND NOT EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'outbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      resolvedDeadLetterOutbox: scalar(`
        SELECT COUNT(*) AS count FROM outbox_messages AS message
        WHERE message.status = 'dead' AND EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'outbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      unknownOutbox: scalar("SELECT COUNT(*) AS count FROM outbox_messages WHERE status = 'unknown_after_send'"),
      actionableUnknownOutbox: scalar(`
        SELECT COUNT(*) AS count FROM outbox_messages AS message
        WHERE message.status = 'unknown_after_send' AND NOT EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'outbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      resolvedUnknownOutbox: scalar(`
        SELECT COUNT(*) AS count FROM outbox_messages AS message
        WHERE message.status = 'unknown_after_send' AND EXISTS (
          SELECT 1 FROM dead_letter_resolutions AS resolution
          WHERE resolution.kind = 'outbox' AND resolution.message_id = message.id
            AND resolution.attempt_count = message.attempt_count AND resolution.resolution = 'cancel'
        )
      `),
      pendingPresentations: scalar(
        "SELECT COUNT(*) AS count FROM delivery_presentations WHERE status IN ('pending', 'attempting', 'retry_wait')",
      ),
      deadPresentations: scalar("SELECT COUNT(*) AS count FROM delivery_presentations WHERE status = 'dead'"),
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
        WHERE id IN (
          SELECT candidate.id FROM inbox_messages AS candidate
          JOIN delivery_inbox_admissions AS candidate_admission
            ON candidate_admission.inbox_id = candidate.id
          WHERE candidate.status = 'retry_wait' AND candidate.next_attempt_at <= ?
            AND candidate.attempt_count >= ?
            AND (candidate.failure_code IS NULL OR candidate.failure_code NOT IN (
              'permission-dispatch-recovery',
              'permission-cancelled-recovery',
              'permission-failure-notice-recovery',
              'feedback-dispatch-recovery',
              'learning-dispatch-recovery',
              'workflow-dispatch-recovery'
            ))
          ORDER BY candidate_admission.admission_sequence LIMIT ?
        )
      `).run(now, now, input.maxAttempts, maintenanceLimit)
      const candidates = this.database.prepare(`
        SELECT candidate.id FROM inbox_messages AS candidate
        JOIN conversation_bindings AS candidate_binding
          ON candidate_binding.id = candidate.binding_id
        JOIN delivery_inbox_admissions AS candidate_admission
          ON candidate_admission.inbox_id = candidate.id
        WHERE candidate.status IN ('queued', 'retry_wait')
          AND (candidate.next_attempt_at IS NULL OR candidate.next_attempt_at <= ?)
          AND (candidate.status = 'queued' OR candidate.attempt_count < ? OR candidate.failure_code IN (
            'permission-dispatch-recovery',
            'permission-cancelled-recovery',
            'permission-failure-notice-recovery',
            'feedback-dispatch-recovery',
            'learning-dispatch-recovery',
            'workflow-dispatch-recovery'
          ))
          AND candidate.binding_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM inbox_messages AS earlier
            JOIN conversation_bindings AS earlier_binding
              ON earlier_binding.id = earlier.binding_id
            JOIN delivery_inbox_admissions AS earlier_admission
              ON earlier_admission.inbox_id = earlier.id
            WHERE earlier_binding.workspace = candidate_binding.workspace
              AND earlier_binding.agent_preset = candidate_binding.agent_preset
              AND earlier_binding.principal_id = candidate_binding.principal_id
              AND earlier_admission.admission_sequence < candidate_admission.admission_sequence
              AND earlier.status NOT IN ('processed', 'dead_letter')
          )
          AND NOT EXISTS (
            SELECT 1 FROM inbox_messages AS active
            JOIN conversation_bindings AS active_binding
              ON active_binding.id = active.binding_id
            WHERE active_binding.workspace = candidate_binding.workspace
              AND active_binding.agent_preset = candidate_binding.agent_preset
              AND active_binding.principal_id = candidate_binding.principal_id
              AND active.status = 'claimed'
          )
        ORDER BY candidate_admission.admission_sequence LIMIT ?
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
              'permission-failure-notice-recovery',
              'feedback-dispatch-recovery',
              'learning-dispatch-recovery',
              'workflow-dispatch-recovery'
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
          'permission-failure-notice-recovery',
          'feedback-dispatch-recovery',
          'learning-dispatch-recovery',
          'workflow-dispatch-recovery'
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
        SELECT message.id, message.event_id, message.binding_id, message.attempt_count,
          message.failure_code, message.envelope_json
        FROM inbox_messages AS message
        JOIN delivery_inbox_admissions AS admission ON admission.inbox_id = message.id
        WHERE message.status = 'claimed' AND message.lease_until <= ?
        ORDER BY admission.admission_sequence LIMIT ?
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
        let interruptedFeedback = false
        let interruptedLearning = false
        let interruptedWorkflow = false
        if (row.failure_code === 'dispatch-started') {
          try {
            const envelope = JSON.parse(row.envelope_json) as InboundEnvelope
            interruptedPermission = isPermissionDeliveryCommand(envelope)
            interruptedFeedback = isFeedbackDeliveryCommand(envelope)
            interruptedLearning = isLearningDeliveryCommand(envelope)
            interruptedWorkflow = isWorkflowDeliveryCommand(envelope)
          } catch {}
        }
        const existingPermissionRecovery = permissionDispatchRecoveryFromFailureCode(row.failure_code ?? undefined)
        const feedbackRecovery = interruptedFeedback || isFeedbackDispatchRecoveryCode(row.failure_code ?? undefined)
        const learningRecovery = interruptedLearning
          || isLearningDispatchRecoveryCode(row.failure_code ?? undefined)
          || isLearningRetryableFailureCode(row.failure_code ?? undefined)
        const workflowRecovery = interruptedWorkflow || isWorkflowDispatchRecoveryCode(row.failure_code ?? undefined)
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
        const ambiguous = row.failure_code === 'dispatch-started'
          && permissionRecovery === undefined && !feedbackRecovery && !learningRecovery && !workflowRecovery
        const exhausted = row.attempt_count >= input.maxAttempts
          && permissionRecovery === undefined && !feedbackRecovery && !learningRecovery && !workflowRecovery
        const changed = this.database.prepare(`
          UPDATE inbox_messages SET status = ?, next_attempt_at = ?, claimed_by = NULL,
            fencing_token = NULL, lease_until = NULL, failure_code = ?, updated_at = ?
          WHERE id = ? AND status = 'claimed' AND lease_until <= ?
        `).run(ambiguous || exhausted ? 'dead_letter' : 'retry_wait', ambiguous || exhausted ? null : now,
          ambiguous ? 'dispatch-ambiguous'
            : permissionRecovery ?? (feedbackRecovery
              ? feedbackDispatchRecoveryCode
              : learningRecovery
                ? learningDispatchRecoveryCode
                : workflowRecovery ? workflowDispatchRecoveryCode : 'lease-expired'),
          now, row.id, now)
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
    return this.enqueueIntent(input, false)
  }

  private enqueueIntent(input: OutboundIntent, approvalRouteValidated: boolean): OutboxRecord {
    this.assertOpen()
    const binding = this.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active') {
      throw new DeliveryStoreError('invalid-intent', 'outbound intent requires an active binding')
    }
    const intent = canonicalIntent(input, binding, this.maxTextBytes)
    if (intent.format === 'approval' && !approvalRouteValidated) {
      throw new DeliveryStoreError('invalid-intent', 'approval Outbox requires an exact v2 route fence')
    }
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

  /**
   * Atomically revalidate one immutable Policy route and insert its approval
   * Outbox. Legacy routes are deliberately not accepted by this boundary.
   */
  enqueueApprovalRoute(input: {
    route: Readonly<ApprovalDispatchRouteV2>
    intent: Readonly<{
      approval: NonNullable<OutboundIntent['approval']>
      idempotencyKey: string
      text: string
    }>
  }): OutboxRecord {
    this.assertOpen()
    const route = canonicalApprovalDispatchRoute(input.route)
    return this.transaction(() => {
      const binding = this.getBinding(route.bindingId)
      const owner = binding === undefined ? undefined : this.getBindingPrincipal(binding.id)
      if (binding === undefined || binding.status !== 'active'
        || binding.version !== route.bindingVersion
        || binding.generation !== route.bindingGeneration
        || binding.workspace !== route.workspace
        || externalPrincipalId(binding.principal) !== route.principal
        || owner?.status !== 'active' || owner.role !== 'owner'
        || owner.id !== route.principalRecordId || owner.version !== route.principalVersion
        || externalPrincipalId(owner.principal) !== route.principal) {
        throw new DeliveryStoreError('invalid-binding', 'approval route exact owner fence changed')
      }
      const intent = canonicalIntent({
        idempotencyKey: input.intent.idempotencyKey,
        bindingId: binding.id,
        target: { conversation: binding.conversation, principal: binding.principal },
        text: input.intent.text,
        format: 'approval',
        approval: input.intent.approval,
      }, binding, this.maxTextBytes)
      const intentHash = digest(JSON.stringify(intent))
      const winnerRow = this.database.prepare(`${outboxSelect} WHERE idempotency_key = ?`)
        .get(intent.idempotencyKey) as OutboxRow | undefined
      if (winnerRow !== undefined) {
        const receiptRow = this.database.prepare(`
          SELECT outbox_id, route_version, source_id, binding_id, binding_version, binding_generation,
            workspace, principal, principal_record_id, principal_version
          FROM approval_outbox_routes WHERE outbox_id = ?
        `).get(winnerRow.id) as ApprovalOutboxRouteRow | undefined
        let receipt: ApprovalDispatchRouteV2 | undefined
        try {
          receipt = receiptRow === undefined ? undefined : approvalRouteFromRow(receiptRow)
        } catch {}
        if (winnerRow.intent_hash !== intentHash || receipt === undefined || !sameApprovalRoute(receipt, route)) {
          throw new DeliveryStoreError(
            'idempotency-conflict',
            'approval Outbox winner does not match the exact immutable v2 route and intent',
          )
        }
        return outboxFromRow(winnerRow)
      }
      const outbox = this.enqueueIntent(intent, true)
      this.database.prepare(`
        INSERT INTO approval_outbox_routes(
          outbox_id, route_version, source_id, binding_id, binding_version, binding_generation,
          workspace, principal, principal_record_id, principal_version
        ) VALUES (?, 2, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        outbox.id,
        route.sourceId,
        route.bindingId,
        route.bindingVersion,
        route.bindingGeneration,
        route.workspace,
        route.principal,
        route.principalRecordId,
        route.principalVersion,
      )
      return outbox
    })
  }

  /**
   * Resolve and enqueue one Host-owned stable owner route under the same
   * `BEGIN IMMEDIATE` fence as Outbox insertion.
   *
   * This closes the `/new` race between an earlier read and insertion. An
   * existing idempotency winner is returned without mutation (including
   * `unknown_after_send`) only after both the current route and the winner's
   * immutable historical route receipt are revalidated.
   */
  enqueueOwnerRoute(input: {
    authority: OwnerRouteAuthority
    sourceId: string
    sourceHash: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
  }): OutboxRecord {
    this.assertOpen()
    const authority = canonicalOwnerRouteAuthority(input.authority)
    let sourceId: string
    try {
      sourceId = canonicalBackgroundSourceId(input.sourceId)
    } catch {
      throw new DeliveryStoreError('invalid-intent', 'owner route source id is invalid')
    }
    if (typeof input.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(input.sourceHash)
      || digest(sourceId) !== input.sourceHash) {
      throw new DeliveryStoreError('invalid-intent', 'owner route source hash is invalid')
    }
    let idempotencyKey: string
    try {
      idempotencyKey = validateBindingText(input.idempotencyKey, 'idempotencyKey', 512)
    } catch {
      throw new DeliveryStoreError('invalid-intent', 'owner route idempotency key is invalid')
    }
    return this.transaction(() => {
      const current = this.getActiveBinding(authority.conversation)
      const owner = current === undefined ? undefined : this.getPrincipal(current.principal)
      if (current === undefined || current.status !== 'active'
        || !bindingMatchesOwnerRoute(current, authority)
        || owner?.status !== 'active' || owner.role !== 'owner') {
        throw new DeliveryStoreError('invalid-binding', 'active binding does not match owner route authority')
      }

      const winnerRow = this.database.prepare(`${outboxSelect} WHERE idempotency_key = ?`)
        .get(idempotencyKey) as OutboxRow | undefined
      const winner = winnerRow === undefined ? undefined : outboxFromRow(winnerRow)
      const binding = winner === undefined ? current : this.getBinding(winner.intent.bindingId)
      if (binding === undefined || !bindingMatchesOwnerRoute(binding, authority)) {
        throw new DeliveryStoreError('idempotency-conflict', 'owner route idempotency winner has another lineage')
      }
      let receiptMetadata: Readonly<Record<string, string>>
      if (winner === undefined) {
        receiptMetadata = ownerRouteReceiptMetadata({ authority, binding, sourceId })
      } else {
        const parsed = parseOwnerRouteReceipt(winner)
        const evidence = parsed.kind === 'route' ? parsed.evidence : undefined
        const initialBinding = evidence === undefined ? undefined : this.getBinding(evidence.initialBindingId)
        const exactReceipt = evidence !== undefined
          && evidence.authorityId === authority.id
          && evidence.authorityHash === ownerRouteAuthorityHash(authority)
          && evidence.bindingVersion === binding.version - (binding.status === 'revoked' ? 1 : 0)
          && evidence.generation === binding.generation
          && evidence.minimumGeneration === authority.minimumGeneration
          && evidence.sourceId === sourceId
          && evidence.sourceHash === input.sourceHash
          && initialBinding !== undefined
          && bindingMatchesOwnerRoute(initialBinding, authority)
          && evidence.initialBindingVersion
            === initialBinding.version - (initialBinding.status === 'revoked' ? 1 : 0)
          && evidence.initialGeneration === initialBinding.generation
        if (!exactReceipt || winner.intent.metadata === undefined) {
          throw new DeliveryStoreError(
            'idempotency-conflict',
            'owner route idempotency winner has an invalid immutable route receipt',
          )
        }
        receiptMetadata = winner.intent.metadata
      }
      const expected = canonicalIntent({
        idempotencyKey,
        bindingId: binding.id,
        target: { conversation: binding.conversation, principal: binding.principal },
        text: input.text,
        format: input.format ?? 'plain',
        metadata: receiptMetadata,
      }, binding, this.maxTextBytes)
      if (winner !== undefined) {
        if (winner.intentHash !== digest(JSON.stringify(expected))) {
          throw new DeliveryStoreError(
            'idempotency-conflict',
            'owner route idempotency key was reused with a different immutable intent',
          )
        }
        return winner
      }
      return this.enqueue(expected)
    })
  }

  getOutbox(id: string): OutboxRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${outboxSelect} WHERE id = ?`).get(id) as OutboxRow | undefined
    return row === undefined ? undefined : outboxFromRow(row)
  }

  getOutboxByIdempotencyKey(idempotencyKeyInput: string): OutboxRecord | undefined {
    this.assertOpen()
    const idempotencyKey = validateBindingText(idempotencyKeyInput, 'idempotencyKey', 200)
    const row = this.database.prepare(`${outboxSelect} WHERE idempotency_key = ?`)
      .get(idempotencyKey) as OutboxRow | undefined
    return row === undefined ? undefined : outboxFromRow(row)
  }

  /** Persist the latest desired replacement for one exact durable message. */
  publishDeliveryPresentation(input: DeliveryPresentationUpdate): StoredDeliveryPresentation {
    this.assertOpen()
    const presentationKey = validateBindingText(input.presentationKey, 'presentationKey', 500)
    const originalOutboxIdempotencyKey = validateBindingText(
      input.originalOutboxIdempotencyKey,
      'originalOutboxIdempotencyKey',
      200,
    )
    if (!Number.isSafeInteger(input.revision) || input.revision < 1
      || input.revision > Number.MAX_SAFE_INTEGER) {
      throw new DeliveryStoreError('invalid-intent', 'presentation revision is invalid')
    }
    const presentation = canonicalDeliveryPresentation(input.presentation)
    const payloadJson = JSON.stringify(presentation)
    const payloadHash = digest(payloadJson)
    const now = this.now()
    return this.transaction(() => {
      const current = this.database.prepare(`${deliveryPresentationSelect} WHERE presentation_key = ?`)
        .get(presentationKey) as unknown as DeliveryPresentationRow | undefined
      if (current !== undefined) {
        if (input.revision < current.revision) {
          throw new DeliveryStoreError('version-conflict', 'presentation revision is older than durable desired state')
        }
        if (input.revision === current.revision) {
          if (current.original_outbox_idempotency_key !== originalOutboxIdempotencyKey
            || current.payload_hash !== payloadHash || current.payload_json !== payloadJson) {
            throw new DeliveryStoreError(
              'idempotency-conflict',
              'presentation revision was reused with different content',
            )
          }
          return deliveryPresentationFromRow(current)
        }
        if (current.original_outbox_idempotency_key !== originalOutboxIdempotencyKey) {
          throw new DeliveryStoreError(
            'idempotency-conflict',
            'presentation lifecycle was retargeted to another durable message',
          )
        }
        this.database.prepare(`
          UPDATE delivery_presentations
          SET revision = ?, payload_hash = ?, payload_json = ?, status = 'pending',
            next_attempt_at = NULL, claimed_by = NULL, fencing_token = NULL, lease_until = NULL,
            failure_code = NULL, updated_at = ?
          WHERE presentation_key = ? AND revision = ?
        `).run(input.revision, payloadHash, payloadJson, now, presentationKey, current.revision)
      } else {
        this.database.prepare(`
          INSERT INTO delivery_presentations(
            presentation_key, original_outbox_idempotency_key, revision, payload_hash, payload_json,
            status, attempt_count, presented_revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'pending', 0, 0, ?, ?)
        `).run(
          presentationKey,
          originalOutboxIdempotencyKey,
          input.revision,
          payloadHash,
          payloadJson,
          now,
          now,
        )
      }
      const saved = this.database.prepare(`${deliveryPresentationSelect} WHERE presentation_key = ?`)
        .get(presentationKey) as unknown as DeliveryPresentationRow
      return deliveryPresentationFromRow(saved)
    })
  }

  getDeliveryPresentation(presentationKeyInput: string): StoredDeliveryPresentation | undefined {
    this.assertOpen()
    const presentationKey = validateBindingText(presentationKeyInput, 'presentationKey', 500)
    const row = this.database.prepare(`${deliveryPresentationSelect} WHERE presentation_key = ?`)
      .get(presentationKey) as DeliveryPresentationRow | undefined
    return row === undefined ? undefined : deliveryPresentationFromRow(row)
  }

  claimDeliveryPresentation(input: {
    ownerId: string
    leaseMs: number
    /** Lifecycles already attempted by this drain pass. */
    excludePresentationKeys?: readonly string[]
  }): { presentation: StoredDeliveryPresentation; fencingToken: number } | undefined {
    this.assertOpen()
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 500)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1) {
      throw new DeliveryStoreError('conflict', 'presentation lease is invalid')
    }
    if ((input.excludePresentationKeys?.length ?? 0) > 100) {
      throw new DeliveryStoreError('conflict', 'presentation exclusions exceed their bound')
    }
    const excluded = input.excludePresentationKeys?.map(key =>
      validateBindingText(key, 'presentationKey', 500)) ?? []
    const exclusionClause = excluded.length === 0
      ? ''
      : `AND presentation_key NOT IN (${excluded.map(() => '?').join(', ')})`
    const now = this.now()
    return this.transaction(() => {
      // Quarantine bounded poison rows in-place before claiming a later valid
      // lifecycle. A malformed earliest row must never starve the queue.
      for (let inspected = 0; inspected < 100; inspected += 1) {
        const current = this.database.prepare(`${deliveryPresentationSelect}
          WHERE (status = 'pending'
            OR (status = 'retry_wait' AND next_attempt_at <= ?)
            OR (status = 'attempting' AND lease_until <= ?))
          ${exclusionClause}
          ORDER BY created_at, presentation_key LIMIT 1`)
          .get(now, now, ...excluded) as unknown as DeliveryPresentationRow | undefined
        if (current === undefined) return undefined
        try {
          deliveryPresentationFromRow(current)
        } catch {
          this.database.prepare(`
            UPDATE delivery_presentations
            SET status = 'dead', next_attempt_at = NULL, claimed_by = NULL,
              lease_until = NULL, failure_code = 'presentation-poison-row', updated_at = ?
            WHERE presentation_key = ? AND revision = ?
          `).run(now, current.presentation_key, current.revision)
          continue
        }
        const fencingToken = (current.fencing_token ?? 0) + 1
        const changed = this.database.prepare(`
          UPDATE delivery_presentations
          SET status = 'attempting', attempt_count = attempt_count + 1,
            claimed_by = ?, fencing_token = ?, lease_until = ?, next_attempt_at = NULL,
            failure_code = NULL, updated_at = ?
          WHERE presentation_key = ? AND revision = ?
            AND COALESCE(fencing_token, 0) = ?
            AND (status = 'pending'
              OR (status = 'retry_wait' AND next_attempt_at <= ?)
              OR (status = 'attempting' AND lease_until <= ?))
        `).run(
          ownerId,
          fencingToken,
          now + input.leaseMs,
          now,
          current.presentation_key,
          current.revision,
          current.fencing_token ?? 0,
          now,
          now,
        )
        if (changed.changes !== 1) throw new DeliveryStoreError('stale-fence', 'presentation claim changed')
        const claimed = this.database.prepare(`${deliveryPresentationSelect} WHERE presentation_key = ?`)
          .get(current.presentation_key) as unknown as DeliveryPresentationRow
        return { presentation: deliveryPresentationFromRow(claimed), fencingToken }
      }
      return undefined
    })
  }

  finishDeliveryPresentation(input: {
    presentationKey: string
    revision: number
    ownerId: string
    fencingToken: number
    outcome: 'presented' | 'retry_wait' | 'dead'
    providerMessageId?: string
    failureCode?: string
    nextAttemptAt?: number
  }): StoredDeliveryPresentation {
    this.assertOpen()
    const presentationKey = validateBindingText(input.presentationKey, 'presentationKey', 500)
    const ownerId = validateBindingText(input.ownerId, 'ownerId', 500)
    if (!Number.isSafeInteger(input.revision) || input.revision < 1
      || !Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new DeliveryStoreError('stale-fence', 'presentation completion fence is invalid')
    }
    const providerMessageId = input.providerMessageId === undefined
      ? undefined
      : validateBindingText(input.providerMessageId, 'providerMessageId', 512)
    const failureCode = input.failureCode === undefined
      ? undefined
      : validateBindingText(input.failureCode, 'failureCode', 500)
    if (input.outcome === 'presented' && providerMessageId === undefined) {
      throw new DeliveryStoreError('conflict', 'presented replacement requires provider message identity')
    }
    if (input.outcome !== 'presented' && failureCode === undefined) {
      throw new DeliveryStoreError('conflict', 'failed replacement requires a failure code')
    }
    if (input.outcome === 'retry_wait'
      && (!Number.isSafeInteger(input.nextAttemptAt) || input.nextAttemptAt! < 0)) {
      throw new DeliveryStoreError('conflict', 'replacement retry time is invalid')
    }
    const now = this.now()
    const changed = this.database.prepare(`
      UPDATE delivery_presentations
      SET status = ?, presented_revision = CASE WHEN ? = 'presented' THEN revision ELSE presented_revision END,
        provider_message_id = COALESCE(?, provider_message_id), failure_code = ?, next_attempt_at = ?,
        claimed_by = NULL, lease_until = NULL, updated_at = ?
      WHERE presentation_key = ? AND revision = ? AND status = 'attempting'
        AND claimed_by = ? AND fencing_token = ?
    `).run(
      input.outcome,
      input.outcome,
      providerMessageId ?? null,
      failureCode ?? null,
      input.outcome === 'retry_wait' ? input.nextAttemptAt! : null,
      now,
      presentationKey,
      input.revision,
      ownerId,
      input.fencingToken,
    )
    if (changed.changes !== 1) {
      throw new DeliveryStoreError('stale-fence', 'presentation completion lost its claim or revision')
    }
    return this.getDeliveryPresentation(presentationKey)!
  }

  /** Exact provider-addressed lookup used only to bind authenticated replies. */
  getOutboxByProviderMessage(channelInput: string, accountInput: string, providerMessageIdInput: string): OutboxRecord | undefined {
    this.assertOpen()
    const channel = validateBindingText(channelInput, 'channel', 256)
    const account = validateBindingText(accountInput, 'account', 256)
    const providerMessageId = validateBindingText(providerMessageIdInput, 'providerMessageId', 512)
    const row = this.database.prepare(`${outboxSelect}
      WHERE channel = ? AND account = ? AND provider_message_id = ?`)
      .get(channel, account, providerMessageId) as OutboxRow | undefined
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
    return this.getModelPickerRecord(operationId, bindingId)?.intent.modelPicker
  }

  getModelPickerRecord(operationId: string, bindingId: string): OutboxRecord | undefined {
    this.assertOpen()
    const operation = validateBindingText(operationId, 'operationId', 256)
    const bindingKey = validateBindingText(bindingId, 'bindingId', 256)
    const row = this.database.prepare(`${outboxSelect}
      WHERE binding_id = ? AND json_valid(intent_json)
        AND json_extract(intent_json, '$.modelPicker.operationId') = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`).get(bindingKey, operation) as OutboxRow | undefined
    if (row === undefined) return undefined
    const binding = this.getBinding(bindingKey)
    if (binding === undefined) throw new DeliveryStoreError('invalid-intent', 'model picker binding does not exist')
    const record = outboxFromRow(row)
    const intent = canonicalIntent(record.intent, binding, this.maxTextBytes)
    if (intent.format !== 'model-picker' || intent.modelPicker?.operationId !== operation
      || digest(JSON.stringify(intent)) !== record.intentHash) {
      throw new DeliveryStoreError('invalid-intent', 'persisted model picker intent is invalid')
    }
    return { ...record, intent }
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

  /** Recheck a claimed route immediately before provider I/O. */
  validateClaimedOwnerRoute(
    recordInput: Readonly<OutboxRecord>,
    guard: Readonly<OwnerRouteDispatchGuard>,
  ): OwnerRouteDispatchValidation {
    this.assertOpen()
    const record = this.getOutbox(recordInput.id)
    if (record === undefined || record.status !== 'attempting'
      || record.fencingToken !== recordInput.fencingToken
      || record.claimedBy !== recordInput.claimedBy) {
      return { kind: 'denied', failureCode: 'owner-route-claim-changed' }
    }
    const inspected = this.inspectOwnerRouteDispatch(record, guard)
    return inspected.kind === 'authorized'
      ? { kind: 'authorized' }
      : inspected
  }

  /** Recheck a durable owner route before mutating its exact provider message. */
  validatePresentationOwnerRoute(
    recordInput: Readonly<OutboxRecord>,
    guard: Readonly<OwnerRouteDispatchGuard>,
  ): OwnerRouteDispatchValidation {
    this.assertOpen()
    const record = this.getOutbox(recordInput.id)
    if (record === undefined || record.intentHash !== recordInput.intentHash
      || record.intent.idempotencyKey !== recordInput.intent.idempotencyKey
      || record.providerMessageId !== recordInput.providerMessageId) {
      return { kind: 'denied', failureCode: 'owner-route-message-changed' }
    }
    const inspected = this.inspectOwnerRouteDispatch(record, guard)
    return inspected.kind === 'authorized'
      ? { kind: 'authorized' }
      : inspected
  }

  private inspectOwnerRouteDispatch(
    record: Readonly<OutboxRecord>,
    guard: Readonly<OwnerRouteDispatchGuard>,
  ): InspectedOwnerRouteDispatch {
    const parsed = parseOwnerRouteReceipt(record)
    if (parsed.kind === 'not-route') return parsed
    if (parsed.kind === 'invalid') {
      return { kind: 'denied', failureCode: 'owner-route-receipt-invalid' }
    }
    const evidence = parsed.evidence
    const authorities = new Map<string, OwnerRouteAuthority>()
    try {
      for (const input of guard.ownerRoutes) {
        const authority = canonicalOwnerRouteAuthority(input as OwnerRouteAuthority)
        if (authorities.has(authority.id)) {
          return { kind: 'denied', failureCode: 'owner-route-authority-invalid' }
        }
        authorities.set(authority.id, authority)
      }
    } catch {
      return { kind: 'denied', failureCode: 'owner-route-authority-invalid' }
    }
    const authority = authorities.get(evidence.authorityId)
    if (authority === undefined) {
      return { kind: 'denied', failureCode: 'owner-route-authority-revoked' }
    }
    if (ownerRouteAuthorityHash(authority) !== evidence.authorityHash
      || authority.minimumGeneration !== evidence.minimumGeneration) {
      return { kind: 'denied', failureCode: 'owner-route-authority-changed' }
    }
    const binding = this.getBinding(record.intent.bindingId)
    const initialBinding = this.getBinding(evidence.initialBindingId)
    if (binding === undefined || initialBinding === undefined) {
      return { kind: 'denied', failureCode: 'owner-route-receipt-invalid' }
    }
    try {
      const canonical = canonicalIntent(record.intent, binding, this.maxTextBytes)
      if (digest(JSON.stringify(canonical)) !== record.intentHash
        || !bindingMatchesOwnerRoute(binding, authority)
        || !bindingMatchesOwnerRoute(initialBinding, authority)
        || evidence.bindingVersion !== binding.version - (binding.status === 'revoked' ? 1 : 0)
        || evidence.generation !== binding.generation
        || evidence.initialBindingVersion
          !== initialBinding.version - (initialBinding.status === 'revoked' ? 1 : 0)
        || evidence.initialGeneration !== initialBinding.generation) {
        return { kind: 'denied', failureCode: 'owner-route-receipt-invalid' }
      }
    } catch {
      return { kind: 'denied', failureCode: 'owner-route-receipt-invalid' }
    }
    const current = this.getActiveBinding(authority.conversation)
    if (current === undefined) {
      return { kind: 'denied', failureCode: 'owner-route-binding-missing' }
    }
    const owner = this.getPrincipal(current.principal)
    if (!bindingMatchesOwnerRoute(current, authority)
      || owner?.status !== 'active' || owner.role !== 'owner') {
      return { kind: 'denied', failureCode: 'owner-route-binding-drift' }
    }
    if (current.generation < evidence.generation
      || current.generation < authority.minimumGeneration) {
      return { kind: 'denied', failureCode: 'owner-route-generation-below-floor' }
    }
    try {
      if (!guard.authorize({ authority, sourceId: evidence.sourceId,
        idempotencyKey: record.intent.idempotencyKey })) {
        return { kind: 'denied', failureCode: 'owner-route-policy-revoked' }
      }
    } catch {
      return { kind: 'deferred', failureCode: 'owner-route-policy-check-failed' }
    }
    return { kind: 'authorized', authority, binding: current, evidence }
  }

  private ownerRouteIsProvablyUnsent(record: Readonly<OutboxRecord>): boolean {
    if (!['pending', 'retry_wait'].includes(record.status)
      || record.claimedBy !== undefined || record.providerMessageId !== undefined) return false
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM outbox_attempts
      WHERE outbox_id = ? AND status IN ('accepted', 'unknown_after_send', 'reconciled', 'attempting')
    `).get(record.id) as { count: number }
    return row.count === 0
  }

  private rebindOwnerRouteBeforeClaim(
    record: Readonly<OutboxRecord>,
    inspected: Extract<InspectedOwnerRouteDispatch, { kind: 'authorized' }>,
  ): boolean {
    if (record.intent.bindingId === inspected.binding.id) return true
    const metadata = ownerRouteReceiptMetadata({
      authority: inspected.authority,
      binding: inspected.binding,
      sourceId: inspected.evidence.sourceId,
      initial: inspected.evidence,
    })
    let intent: OutboundIntent
    try {
      intent = canonicalIntent({
        ...record.intent,
        bindingId: inspected.binding.id,
        target: { conversation: inspected.binding.conversation, principal: inspected.binding.principal },
        metadata,
      }, inspected.binding, this.maxTextBytes)
    } catch {
      return false
    }
    const intentJson = JSON.stringify(intent)
    const intentHash = digest(intentJson)
    return this.database.prepare(`
      UPDATE outbox_messages
      SET binding_id = ?, intent_hash = ?, intent_json = ?, channel = ?, account = ?, lane_hash = ?, updated_at = ?
      WHERE id = ? AND status = ? AND claimed_by IS NULL AND intent_hash = ?
    `).run(
      inspected.binding.id,
      intentHash,
      intentJson,
      inspected.binding.conversation.channel,
      inspected.binding.conversation.account,
      conversationHash(inspected.binding.conversation),
      this.now(),
      record.id,
      record.status,
      record.intentHash,
    ).changes === 1
  }

  private deadLetterOwnerRouteBeforeClaim(
    record: Readonly<OutboxRecord>,
    ownerId: string,
    failureCode: string,
    now: number,
  ): boolean {
    if (!['pending', 'retry_wait'].includes(record.status)
      || !Number.isSafeInteger(record.attemptCount + 1)) return false
    const attemptNumber = record.attemptCount + 1
    const changed = this.database.prepare(`
      UPDATE outbox_messages
      SET status = 'dead', attempt_count = attempt_count + 1, next_attempt_at = NULL,
        claimed_by = NULL, fencing_token = NULL, lease_until = NULL, failure_code = ?, updated_at = ?
      WHERE id = ? AND status = ? AND claimed_by IS NULL AND intent_hash = ?
    `).run(failureCode, now, record.id, record.status, record.intentHash)
    if (changed.changes !== 1) return false
    this.database.prepare(`
      INSERT INTO outbox_attempts (
        id, outbox_id, attempt_number, owner_id, fencing_token, operation, status,
        failure_code, created_at, finished_at
      ) VALUES (?, ?, ?, ?, ?, 'send', 'dead', ?, ?, ?)
    `).run(`outbox_attempt_${randomUUID()}`, record.id, attemptNumber, ownerId,
      attemptNumber, failureCode, now, now)
    return true
  }

  private deferOwnerRouteBeforeClaim(
    record: Readonly<OutboxRecord>,
    failureCode: string,
    now: number,
    retryAt: number,
  ): boolean {
    if (!['pending', 'retry_wait'].includes(record.status)) return false
    return this.database.prepare(`
      UPDATE outbox_messages
      SET status = 'retry_wait', next_attempt_at = ?, failure_code = ?, updated_at = ?
      WHERE id = ? AND status = ? AND claimed_by IS NULL AND intent_hash = ?
    `).run(retryAt, failureCode, now, record.id, record.status, record.intentHash).changes === 1
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
    ownerRouteGuard?: Readonly<OwnerRouteDispatchGuard>
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
    const validatedOwnerRouteIds: string[] = []
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
            AND NOT EXISTS (
              SELECT 1 FROM dead_letter_resolutions AS resolution
              WHERE resolution.kind = 'outbox' AND resolution.message_id = candidate.id
                AND resolution.attempt_count = candidate.attempt_count AND resolution.resolution = 'cancel'
            )
            AND (
              SELECT COUNT(*) FROM outbox_attempts AS history
              WHERE history.outbox_id = candidate.id AND history.operation = 'reconcile'
            ) >= ?
          ORDER BY candidate.rowid LIMIT ?
        )
      `).run(now, input.maxAttempts, maintenanceLimit)
      const ownerRouteRows = this.database.prepare(`
        SELECT id FROM outbox_messages
        WHERE status IN ('pending', 'retry_wait') AND claimed_by IS NULL
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          AND json_type(intent_json, '$.metadata."dsh.route.authority"') IS NOT NULL
        ORDER BY rowid LIMIT ?
      `).all(now, maintenanceLimit) as unknown as { id: string }[]
      const ownerRouteGuard = input.ownerRouteGuard ?? { ownerRoutes: [], authorize: () => false }
      for (const row of ownerRouteRows) {
        const record = this.getOutbox(row.id)
        if (record === undefined) continue
        const inspected = this.inspectOwnerRouteDispatch(record, ownerRouteGuard)
        if (inspected.kind === 'deferred') {
          this.deferOwnerRouteBeforeClaim(
            record,
            inspected.failureCode,
            now,
            now + Math.max(1, Math.min(input.leaseMs, 30_000)),
          )
          continue
        }
        if (inspected.kind !== 'authorized') {
          const failureCode = inspected.kind === 'denied'
            ? inspected.failureCode
            : 'owner-route-receipt-invalid'
          this.deadLetterOwnerRouteBeforeClaim(record, ownerId, failureCode, now)
          continue
        }
        if (!this.ownerRouteIsProvablyUnsent(record)) {
          this.deadLetterOwnerRouteBeforeClaim(record, ownerId, 'owner-route-send-proof-missing', now)
          continue
        }
        if (!this.rebindOwnerRouteBeforeClaim(record, inspected)) {
          this.deadLetterOwnerRouteBeforeClaim(record, ownerId, 'owner-route-rebind-conflict', now)
          continue
        }
        validatedOwnerRouteIds.push(record.id)
      }
      this.database.prepare(`
        UPDATE outbox_messages SET status = 'dead', failure_code = CASE
            WHEN status = 'unknown_after_send' THEN 'binding-revoked-unknown'
            ELSE 'binding-revoked'
          END,
          next_attempt_at = NULL, updated_at = ?
        WHERE rowid IN (
          SELECT candidate.rowid FROM outbox_messages AS candidate
          WHERE candidate.status IN ('pending', 'retry_wait', 'unknown_after_send')
            AND json_type(candidate.intent_json, '$.metadata."dsh.route.authority"') IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM dead_letter_resolutions AS resolution
              WHERE resolution.kind = 'outbox' AND resolution.message_id = candidate.id
                AND resolution.attempt_count = candidate.attempt_count AND resolution.resolution = 'cancel'
            )
            AND NOT EXISTS (
              SELECT 1 FROM conversation_bindings AS binding
              WHERE binding.id = candidate.binding_id AND binding.status = 'active'
            )
          ORDER BY candidate.rowid LIMIT ?
        )
      `).run(now, maintenanceLimit)
      const ownerRouteClaimClause = validatedOwnerRouteIds.length === 0
        ? `AND (
            json_type(candidate.intent_json, '$.metadata."dsh.route.authority"') IS NULL
            OR candidate.status = 'unknown_after_send'
          )`
        : `AND (
            json_type(candidate.intent_json, '$.metadata."dsh.route.authority"') IS NULL
            OR candidate.status = 'unknown_after_send'
            OR candidate.id IN (${validatedOwnerRouteIds.map(() => '?').join(', ')})
          )`
      const candidates = this.database.prepare(`
        SELECT candidate.id, candidate.status FROM outbox_messages AS candidate
        WHERE candidate.status IN ('pending', 'retry_wait', 'unknown_after_send')
          AND candidate.claimed_by IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM dead_letter_resolutions AS resolution
            WHERE resolution.kind = 'outbox' AND resolution.message_id = candidate.id
              AND resolution.attempt_count = candidate.attempt_count AND resolution.resolution = 'cancel'
          )
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
          AND (
            EXISTS (
              SELECT 1 FROM conversation_bindings AS binding
              WHERE binding.id = candidate.binding_id AND binding.status = 'active'
            ) OR (
              candidate.status = 'unknown_after_send'
              AND json_type(candidate.intent_json, '$.metadata."dsh.route.authority"') IS NOT NULL
            )
          )
          ${ownerRouteClaimClause}
          ${routeClause}
          ${excludeClause}
          AND NOT EXISTS (
            SELECT 1 FROM outbox_messages AS earlier
            WHERE earlier.lane_hash = candidate.lane_hash
              AND earlier.rowid < candidate.rowid
              AND earlier.status NOT IN ('accepted', 'delivered', 'read', 'dead')
              AND NOT EXISTS (
                SELECT 1 FROM dead_letter_resolutions AS resolution
                WHERE resolution.kind = 'outbox' AND resolution.message_id = earlier.id
                  AND resolution.attempt_count = earlier.attempt_count AND resolution.resolution = 'cancel'
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox_messages AS active
            WHERE active.lane_hash = candidate.lane_hash AND active.status = 'attempting'
          )
        ORDER BY candidate.rowid
        LIMIT ?
      `).all(now, input.maxAttempts, input.maxAttempts, ...validatedOwnerRouteIds,
        ...routeParameters, ...excludeIds, input.limit) as unknown as {
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
        this.database.prepare(`
          UPDATE outbox_messages
          SET status = ?, failure_code = NULL, next_attempt_at = NULL,
            claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
          WHERE id = ?
        `)
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
    operatorId: string
  }): DeadLetterResolutionResult<InboxRecord> {
    this.assertOpen()
    const operatorId = resolutionOperatorId(input.operatorId)
    if (!['cancel', 'retry'].includes(input.resolution)
      || !Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 0) {
      throw new DeliveryStoreError('version-conflict', 'dead-letter inbox resolution identity is invalid')
    }
    return this.transaction(() => {
      const current = this.getInbox(input.inboxId)
      const existing = this.getDeadLetterResolution({ kind: 'inbox', id: input.inboxId,
        attemptCount: input.expectedAttemptCount })
      if (existing !== undefined) {
        if (current !== undefined && existing.resolution === input.resolution
          && existing.operatorId === operatorId) {
          return { record: current, receipt: existing, replayed: true }
        }
        throw new DeliveryStoreError('version-conflict', 'dead-letter inbox decision already settled')
      }
      if (current?.status !== 'dead_letter' || current.attemptCount !== input.expectedAttemptCount) {
        throw new DeliveryStoreError('version-conflict', 'dead-letter inbox attempt count or state changed')
      }
      if (input.resolution === 'retry') {
        const binding = current.bindingId === undefined ? undefined : this.getBinding(current.bindingId)
        if (binding?.status !== 'active') {
          throw new DeliveryStoreError('conflict', 'dead-letter inbox has no active binding')
        }
      }
      const now = this.now()
      this.database.prepare(`
        INSERT INTO dead_letter_resolutions (
          kind, message_id, attempt_count, receipt_version, resolution, original_status,
          original_failure_code, operator_id, created_at
        ) VALUES ('inbox', ?, ?, 1, ?, 'dead_letter', ?, ?, ?)
      `).run(input.inboxId, input.expectedAttemptCount, input.resolution,
        current.failureCode ?? null, operatorId, now)
      const changed = this.database.prepare(`
        UPDATE inbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'dead_letter' AND attempt_count = ?
      `).run(input.resolution === 'retry' ? 'queued' : 'dead_letter',
        input.resolution === 'retry' ? null : 'operator-cancelled', now,
        input.inboxId, input.expectedAttemptCount)
      if (changed.changes !== 1) throw new DeliveryStoreError('version-conflict', 'dead-letter inbox changed')
      return {
        record: this.getInbox(input.inboxId)!,
        receipt: this.getDeadLetterResolution({ kind: 'inbox', id: input.inboxId,
          attemptCount: input.expectedAttemptCount })!,
        replayed: false,
      }
    })
  }

  resolveOutbox(input: {
    outboxId: string
    expectedAttemptCount: number
    resolution: 'cancel' | 'retry'
    operatorId: string
  }): DeadLetterResolutionResult<OutboxRecord> {
    this.assertOpen()
    const operatorId = resolutionOperatorId(input.operatorId)
    if (!['cancel', 'retry'].includes(input.resolution)
      || !Number.isSafeInteger(input.expectedAttemptCount) || input.expectedAttemptCount < 0) {
      throw new DeliveryStoreError('version-conflict', 'outbox resolution identity is invalid')
    }
    return this.transaction(() => {
      const current = this.getOutbox(input.outboxId)
      const existing = this.getDeadLetterResolution({ kind: 'outbox', id: input.outboxId,
        attemptCount: input.expectedAttemptCount })
      if (existing !== undefined) {
        if (current !== undefined && existing.resolution === input.resolution
          && existing.operatorId === operatorId) {
          return { record: current, receipt: existing, replayed: true }
        }
        throw new DeliveryStoreError('version-conflict', 'outbox decision already settled')
      }
      if (current === undefined || !['dead', 'unknown_after_send'].includes(current.status)
        || current.attemptCount !== input.expectedAttemptCount) {
        throw new DeliveryStoreError('version-conflict', 'outbox attempt count or resolvable state changed')
      }
      if (input.resolution === 'retry') {
        if (current.status === 'unknown_after_send'
          && parseOwnerRouteReceipt(current).kind !== 'not-route') {
          throw new DeliveryStoreError(
            'conflict',
            'unknown owner route sends cannot move lineage or be replayed',
          )
        }
        const binding = this.getBinding(current.intent.bindingId)
        if (binding?.status !== 'active') {
          throw new DeliveryStoreError('conflict', 'resolvable outbox has no active binding')
        }
      }
      const now = this.now()
      this.database.prepare(`
        INSERT INTO dead_letter_resolutions (
          kind, message_id, attempt_count, receipt_version, resolution, original_status,
          original_failure_code, operator_id, created_at
        ) VALUES ('outbox', ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(input.outboxId, input.expectedAttemptCount, input.resolution, current.status,
        current.failureCode ?? null, operatorId, now)
      const targetStatus = input.resolution === 'retry'
        ? 'pending'
        : current.status
      const targetFailure = input.resolution === 'retry'
        ? null
        : current.status === 'unknown_after_send' ? 'operator-cancelled-unknown' : 'operator-cancelled'
      const changed = this.database.prepare(`
        UPDATE outbox_messages SET status = ?, failure_code = ?, next_attempt_at = NULL,
          claimed_by = NULL, fencing_token = NULL, lease_until = NULL, updated_at = ?
        WHERE id = ? AND status = ? AND attempt_count = ?
      `).run(targetStatus, targetFailure, now,
        input.outboxId, current.status, input.expectedAttemptCount)
      if (changed.changes !== 1) throw new DeliveryStoreError('version-conflict', 'resolvable outbox changed')
      return {
        record: this.getOutbox(input.outboxId)!,
        receipt: this.getDeadLetterResolution({ kind: 'outbox', id: input.outboxId,
          attemptCount: input.expectedAttemptCount })!,
        replayed: false,
      }
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

  getModelSelectionSettlement(input: {
    operationId: string
    bindingId: string
    expected: ModelPickerState
    payload: unknown
  }): { status: 'completed' | 'pending' | 'processing'; result?: unknown } | undefined {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'operationId', 512)
    const bindingId = validateBindingText(input.bindingId, 'bindingId', 256)
    const expected = canonicalModelPickerState(input.expected)
    const payloadJson = JSON.stringify({ bindingId, expected, payload: input.payload })
    if (payloadJson === undefined || payloadJson.length > 16_384) {
      throw new DeliveryStoreError('conflict', 'model selection settlement payload is invalid or too large')
    }
    const row = this.database.prepare(`
      SELECT binding_id, payload_hash, status, result_json
      FROM model_selection_settlements WHERE operation_id = ?
    `).get(operationId) as Pick<ModelSelectionSettlementRow,
      'binding_id' | 'payload_hash' | 'status' | 'result_json'> | undefined
    if (row === undefined) return undefined
    if (row.binding_id !== bindingId || row.payload_hash !== digest(payloadJson)) {
      throw new DeliveryStoreError('idempotency-conflict', 'model selection operation was reused with a different payload')
    }
    return {
      status: row.status,
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
    }
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

  workflowTraceSourceAttestation(): Readonly<WorkflowTraceSourceAttestation> {
    this.assertOpen()
    const row = this.database.prepare(`
      SELECT generation, authority_digest FROM workflow_trace_source WHERE singleton = 1
    `).get() as { generation: number; authority_digest: string } | undefined
    if (row === undefined || !Number.isSafeInteger(row.generation) || row.generation < 1
      || !/^[a-f0-9]{64}$/u.test(row.authority_digest)) {
      throw new DeliveryStoreError('conflict', 'workflow trace source authority is corrupt')
    }
    return Object.freeze({
      sourceId: WORKFLOW_TRACE_SOURCE_ID,
      generation: row.generation,
      authorityDigest: row.authority_digest,
    })
  }

  /**
   * Apply one already-authenticated source revision. First version may be any
   * positive integer and gaps are allowed; lower versions and same-version
   * content changes fail closed.
   */
  recordWorkflowTraceRevision(input: Readonly<WorkflowTraceRevision>): {
    revision: Readonly<WorkflowTraceRevision>
    replayed: boolean
  } {
    this.assertOpen()
    const revision = validateWorkflowTraceRevision(input)
    return this.transaction(() => this.insertWorkflowTraceRevisionInTransaction(revision))
  }

  /**
   * Atomic owner command ledger + private template review + source revision.
   * Prompt text is stored only in workflow_template_registry.content_json; the
   * command receipt and Growth trace carry only references and digests.
   */
  commitOwnerWorkflowTraceCommand(input: Readonly<{
    action: 'retract' | 'upsert'
    operationId: string
    payloadDigest: string
    binding: Readonly<ConversationBinding>
    reviewInboxId: string
    sourceInboxId: string
    sourceOutboxId: string
    subjectRef: string
    occurredAt: number
    taskRef?: string
    /** Principal identity is derived below from the authenticated live binding. */
    templateContent?: Readonly<Omit<WorkflowAutomationTemplateContent, 'principalId'>>
    steps?: readonly Readonly<WorkflowStepFingerprint>[]
  }>): OwnerWorkflowTraceCommandResult {
    this.assertOpen()
    const operationId = validateBindingText(input.operationId, 'workflow operationId', 512)
    if (!/^[a-f0-9]{64}$/u.test(input.payloadDigest)
      || !/^[a-f0-9]{64}$/u.test(input.subjectRef)
      || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0
      || (input.action === 'upsert') !== (input.templateContent !== undefined
        && input.steps !== undefined && input.taskRef !== undefined)
      || (input.taskRef !== undefined && !/^[a-f0-9]{64}$/u.test(input.taskRef))) {
      throw new DeliveryStoreError('conflict', 'workflow command tuple is invalid')
    }
    return this.transaction(() => {
      const prior = this.database.prepare(`
        SELECT payload_digest, result_json FROM workflow_trace_commands WHERE operation_id = ?
      `).get(operationId) as { payload_digest: string; result_json: string } | undefined
      if (prior !== undefined) {
        if (prior.payload_digest !== input.payloadDigest) {
          throw new DeliveryStoreError('idempotency-conflict', 'workflow command was reused with different input')
        }
        let result: { revision?: unknown; template?: unknown }
        try {
          result = JSON.parse(prior.result_json) as { revision?: unknown; template?: unknown }
        } catch {
          throw new DeliveryStoreError('conflict', 'workflow command receipt is corrupt')
        }
        return Object.freeze({
          revision: validateWorkflowTraceRevision(result.revision),
          ...(result.template === undefined
            ? {}
            : { template: validateWorkflowAutomationTemplate(result.template) }),
          replayed: true,
        })
      }

      const binding = this.getBinding(input.binding.id)
      const owner = binding === undefined ? undefined : this.getPrincipal(binding.principal)
      if (binding === undefined || binding.status !== 'active'
        || binding.version !== input.binding.version || binding.generation !== input.binding.generation
        || JSON.stringify(binding.conversation) !== JSON.stringify(input.binding.conversation)
        || JSON.stringify(binding.principal) !== JSON.stringify(input.binding.principal)
        || binding.workspace !== input.binding.workspace || binding.agentPreset !== input.binding.agentPreset
        || owner?.status !== 'active' || owner.role !== 'owner') {
        throw new DeliveryStoreError('unauthorized-principal', 'workflow command owner binding changed')
      }
      const reviewInbox = this.getInbox(input.reviewInboxId)
      const sourceInbox = this.getInbox(input.sourceInboxId)
      const sourceOutbox = this.getOutbox(input.sourceOutboxId)
      if (reviewInbox?.status !== 'claimed' || reviewInbox.bindingId !== binding.id
        || sourceInbox?.status !== 'processed' || sourceInbox.bindingId !== binding.id
        || sourceOutbox === undefined || sourceOutbox.intent.bindingId !== binding.id
        || sourceOutbox.intent.replyToEventId !== sourceInbox.envelope.eventId
        || sourceOutbox.providerMessageId === undefined
        || !['accepted', 'delivered', 'read'].includes(sourceOutbox.status)
        || JSON.stringify(sourceInbox.envelope.conversation) !== JSON.stringify(binding.conversation)
        || JSON.stringify(sourceInbox.envelope.principal) !== JSON.stringify(binding.principal)
        || JSON.stringify(sourceOutbox.intent.target.conversation) !== JSON.stringify(binding.conversation)
        || JSON.stringify(sourceOutbox.intent.target.principal) !== JSON.stringify(binding.principal)) {
        throw new DeliveryStoreError('conflict', 'workflow command does not target one completed owner task')
      }

      const currentRow = this.database.prepare(`
        SELECT revision.* FROM workflow_trace_current AS current
        JOIN workflow_trace_revisions AS revision
          ON revision.subject_ref = current.subject_ref AND revision.version = current.version
        WHERE current.subject_ref = ?
      `).get(input.subjectRef) as WorkflowTraceRevisionRow | undefined
      const current = currentRow === undefined ? undefined : workflowTraceRevision(currentRow)
      const version = current === undefined ? 1 : current.version + 1
      if (!Number.isSafeInteger(version)) {
        throw new DeliveryStoreError('version-conflict', 'workflow trace version overflow')
      }

      let template: Readonly<WorkflowAutomationTemplate> | undefined
      if (input.action === 'upsert') {
        const content = validateWorkflowAutomationTemplateContent({
          ...input.templateContent,
          principalId: externalPrincipalId(binding.principal),
        })
        if (content.scope.workspace !== binding.workspace || content.scope.preset !== binding.agentPreset
          || content.ownerBindingId !== binding.id || content.deliveryBindingId !== binding.id) {
          throw new DeliveryStoreError('invalid-binding', 'workflow template does not match the owner binding')
        }
        const templateDigest = workflowAutomationTemplateContentDigest(content)
        const reviewReceipt = Object.freeze({
          contractVersion: 1 as const,
          kind: 'owner-explicit-template-review' as const,
          limitation: 'deidentification-unproven' as const,
          templateDigest,
          bindingId: binding.id,
          bindingVersion: binding.version,
          bindingGeneration: binding.generation,
          principalId: owner.id,
          reviewInboxId: reviewInbox.id,
          sourceInboxId: sourceInbox.id,
          sourceOutboxId: sourceOutbox.id,
        })
        const attestationDigest = growthObjectDigest({
          contract: 'assistant-delivery-workflow-template-review/v1',
          receipt: reviewReceipt,
        })
        const templateRef = `workflow-template:${growthObjectDigest({
          contract: 'assistant-delivery-workflow-template-ref/v1',
          templateDigest,
          reviewInboxId: reviewInbox.id,
        })}`
        const attestationId = `workflow-review:${attestationDigest}`
        template = validateWorkflowAutomationTemplate({
          templateRef,
          templateDigest,
          privacyAttestation: {
            kind: 'owner-explicit',
            limitation: 'deidentification-unproven',
            attestationId,
            attestationDigest,
          },
        })
        this.revokeCurrentWorkflowTemplateInTransaction(current, this.now())
        const now = this.now()
        this.database.prepare(`
          INSERT INTO workflow_template_registry(
            template_ref, template_digest, scope_key, workspace, preset, owner_binding_id,
            content_json, privacy_kind, privacy_attestation_id, privacy_attestation_digest,
            review_receipt_json, status, review_inbox_id, source_inbox_id, source_outbox_id,
            created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owner-explicit', ?, ?, ?, 'active', ?, ?, ?, ?, ?, 1)
        `).run(
          template.templateRef, template.templateDigest, workflowScopeKey(content.scope),
          content.scope.workspace, content.scope.preset, binding.id, JSON.stringify(content),
          template.privacyAttestation.attestationId,
          template.privacyAttestation.attestationDigest,
          JSON.stringify(reviewReceipt), reviewInbox.id, sourceInbox.id, sourceOutbox.id,
          now, now,
        )
      } else {
        this.revokeCurrentWorkflowTemplateInTransaction(current, this.now())
      }

      const payload: Omit<WorkflowTraceRevision, 'digest'> = Object.freeze({
        source: this.workflowTraceSourceAttestation(),
        scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
        subjectRef: input.subjectRef,
        version,
        disposition: input.action,
        ...(input.action === 'retract' ? {} : {
          evidence: Object.freeze({
            occurredAt: input.occurredAt,
            signal: 'owner-explicit' as const,
            objectiveStatus: 'unknown' as const,
            ownerBindingId: binding.id,
            taskRef: input.taskRef!,
            template: template!,
            steps: input.steps!,
          }),
        }),
      })
      const revision = validateWorkflowTraceRevision({
        ...payload,
        digest: workflowTraceRevisionDigest(payload),
      })
      const recorded = this.insertWorkflowTraceRevisionInTransaction(revision)
      if (recorded.replayed) {
        throw new DeliveryStoreError('version-conflict', 'new workflow command unexpectedly replayed a trace version')
      }
      const resultJson = JSON.stringify({ revision, ...(template === undefined ? {} : { template }) })
      this.database.prepare(`
        INSERT INTO workflow_trace_commands(operation_id, payload_digest, result_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(operationId, input.payloadDigest, resultJson, this.now())
      return Object.freeze({ revision, ...(template === undefined ? {} : { template }), replayed: false })
    })
  }

  /**
   * Atomically record an authenticated owner objective judgement about one
   * ordinary completed Agent turn and, only when a closed deterministic
   * deidentification catalog recognizes the source, emit its verified trace.
   *
   * The caller may not supply a prompt, task reference, template, or proof:
   * all of them are rebuilt below from the exact durable Inbox/Outbox fence.
   * A normal durable reply alone is intentionally insufficient; the owner
   * must have replied `/feedback achieved` to that exact provider message.
   */
  commitVerifiedWorkflowTraceFeedback(input: Readonly<{
    binding: Readonly<ConversationBinding>
    feedbackInboxId: string
    sourceInboxId: string
    sourceOutboxId: string
    objectiveStatus: 'achieved' | 'partial' | 'not-achieved'
  }>): VerifiedWorkflowTraceFeedbackResult {
    this.assertOpen()
    if (typeof input !== 'object' || input === null
      || !['achieved', 'partial', 'not-achieved'].includes(input.objectiveStatus)
      || typeof input.feedbackInboxId !== 'string' || typeof input.sourceInboxId !== 'string'
      || typeof input.sourceOutboxId !== 'string') {
      throw new DeliveryStoreError('conflict', 'verified workflow feedback tuple is invalid')
    }
    const feedbackInboxId = validateBindingText(input.feedbackInboxId, 'workflow feedback inbox id', 256)
    const sourceInboxId = validateBindingText(input.sourceInboxId, 'workflow source inbox id', 256)
    const sourceOutboxId = validateBindingText(input.sourceOutboxId, 'workflow source outbox id', 256)
    return this.transaction(() => {
      const binding = this.getBinding(input.binding.id)
      const owner = binding === undefined ? undefined : this.getPrincipal(binding.principal)
      if (binding === undefined || binding.status !== 'active' || binding.conversation.kind !== 'dm'
        || binding.version !== input.binding.version || binding.generation !== input.binding.generation
        || binding.sessionId !== input.binding.sessionId
        || JSON.stringify(binding.conversation) !== JSON.stringify(input.binding.conversation)
        || JSON.stringify(binding.principal) !== JSON.stringify(input.binding.principal)
        || binding.workspace !== input.binding.workspace || binding.agentPreset !== input.binding.agentPreset
        || owner?.status !== 'active' || owner.role !== 'owner') {
        throw new DeliveryStoreError('unauthorized-principal', 'verified workflow owner binding changed')
      }

      const feedbackInbox = this.getInbox(feedbackInboxId)
      const sourceInbox = this.getInbox(sourceInboxId)
      const sourceOutbox = this.getOutbox(sourceOutboxId)
      const feedbackCommand = feedbackInbox === undefined || feedbackInbox.envelope.kind !== 'command'
        ? undefined
        : parseDeliveryCommand(feedbackInbox.envelope)
      const feedback = feedbackCommand?.name !== 'feedback'
        ? undefined
        : parseFeedbackCommand(feedbackCommand.rawInput)
      if (feedbackInbox?.status !== 'claimed' || feedbackInbox.bindingId !== binding.id
        || (feedbackInbox.envelope.attachments?.length ?? 0) !== 0
        || feedback?.kind !== 'objective' || feedback.objectiveStatus !== input.objectiveStatus
        || sourceInbox?.status !== 'processed' || sourceInbox.bindingId !== binding.id
        || sourceInbox.envelope.kind !== 'text' || (sourceInbox.envelope.attachments?.length ?? 0) !== 0
        || sourceOutbox === undefined || sourceOutbox.intent.bindingId !== binding.id
        || sourceOutbox.intent.idempotencyKey !== `inbound:${sourceInbox.id}:reply`
        || sourceOutbox.intent.replyToEventId !== sourceInbox.envelope.eventId
        || !['accepted', 'delivered', 'read'].includes(sourceOutbox.status)
        || sourceOutbox.providerMessageId === undefined
        || (sourceOutbox.intent.format !== 'markdown' && sourceOutbox.intent.format !== 'plain')
        || sourceOutbox.intent.metadata !== undefined
        || sourceOutbox.intent.modelPicker !== undefined
        || sourceOutbox.intent.permissionPicker !== undefined
        || sourceOutbox.intent.approval !== undefined
        || feedbackInbox.envelope.metadata?.replyToProviderMessageId !== sourceOutbox.providerMessageId
        || JSON.stringify(feedbackInbox.envelope.conversation) !== JSON.stringify(binding.conversation)
        || JSON.stringify(feedbackInbox.envelope.principal) !== JSON.stringify(binding.principal)
        || JSON.stringify(sourceInbox.envelope.conversation) !== JSON.stringify(binding.conversation)
        || JSON.stringify(sourceInbox.envelope.principal) !== JSON.stringify(binding.principal)
        || JSON.stringify(sourceOutbox.intent.target.conversation) !== JSON.stringify(binding.conversation)
        || JSON.stringify(sourceOutbox.intent.target.principal) !== JSON.stringify(binding.principal)) {
        throw new DeliveryStoreError('conflict', 'verified workflow feedback does not target one completed owner turn')
      }

      const taskRef = growthObjectDigest({
        contract: 'assistant-delivery-verified-workflow-task-ref/v1',
        bindingId: binding.id,
        sourceInboxId: sourceInbox.id,
        sourceInboxEnvelopeHash: sourceInbox.envelopeHash,
        sourceOutboxId: sourceOutbox.id,
        sourceOutboxIntentHash: sourceOutbox.intentHash,
      })
      const taskEvidenceDigest = growthObjectDigest({
        contract: 'assistant-delivery-verified-workflow-task-evidence/v1',
        binding: {
          id: binding.id,
          version: binding.version,
          generation: binding.generation,
          workspace: binding.workspace,
          preset: binding.agentPreset,
        },
        principal: { recordId: owner.id, version: owner.version },
        source: {
          inboxId: sourceInbox.id,
          envelopeHash: sourceInbox.envelopeHash,
          outboxId: sourceOutbox.id,
          intentHash: sourceOutbox.intentHash,
          providerMessageId: sourceOutbox.providerMessageId,
        },
        feedback: {
          inboxId: feedbackInbox.id,
          envelopeHash: feedbackInbox.envelopeHash,
          objectiveStatus: input.objectiveStatus,
        },
      })
      const prior = this.database.prepare(`
        SELECT * FROM workflow_verified_task_feedback WHERE source_outbox_id = ?
      `).get(sourceOutbox.id) as WorkflowVerifiedTaskFeedbackRow | undefined
      if (prior !== undefined) {
        return this.replayVerifiedWorkflowTraceFeedback({
          row: prior,
          binding,
          ownerId: owner.id,
          feedbackInboxId: feedbackInbox.id,
          sourceInboxId: sourceInbox.id,
          sourceOutboxId: sourceOutbox.id,
          objectiveStatus: input.objectiveStatus,
          taskRef,
          taskEvidenceDigest,
        })
      }

      const descriptor = input.objectiveStatus === 'achieved'
        ? deriveDeterministicallyDeidentifiedWorkflowTemplate(sourceInbox.envelope.text)
        : undefined
      if (descriptor === undefined) {
        this.insertVerifiedWorkflowTaskFeedback({
          sourceOutboxId: sourceOutbox.id,
          sourceInboxId: sourceInbox.id,
          feedbackInboxId: feedbackInbox.id,
          binding,
          ownerId: owner.id,
          objectiveStatus: input.objectiveStatus,
          taskRef,
          taskEvidenceDigest,
        })
        return Object.freeze({
          outcome: 'no-trace',
          reason: input.objectiveStatus === 'achieved' ? 'privacy-abstained' : 'objective-not-achieved',
          replayed: false,
        })
      }

      const content = validateWorkflowAutomationTemplateContent({
        scope: { workspace: binding.workspace, preset: binding.agentPreset },
        ownerBindingId: binding.id,
        principalId: externalPrincipalId(binding.principal),
        name: descriptor.name,
        prompt: descriptor.prompt,
        schedule: descriptor.schedule,
        timeoutMs: descriptor.timeoutMs,
        toolCatalogIds: descriptor.toolCatalogIds,
        deliveryBindingId: binding.id,
      })
      const templateDigest = workflowAutomationTemplateContentDigest(content)
      const privacyReceipt = Object.freeze({
        contractVersion: 1 as const,
        kind: 'deterministic-deidentification-template-attestation' as const,
        method: 'assistant-delivery-redaction-v1' as const,
        catalogId: descriptor.catalogId,
        templateDigest,
        bindingId: binding.id,
        bindingVersion: binding.version,
        bindingGeneration: binding.generation,
        principalId: owner.id,
      })
      const attestationDigest = growthObjectDigest({
        contract: 'assistant-delivery-workflow-template-deidentification/v1',
        receipt: privacyReceipt,
      })
      const template = validateWorkflowAutomationTemplate({
        templateRef: `workflow-template:${growthObjectDigest({
          contract: 'assistant-delivery-workflow-template-ref/v2', templateDigest,
        })}`,
        templateDigest,
        privacyAttestation: {
          kind: 'deterministic-deidentification',
          method: 'assistant-delivery-redaction-v1',
          attestationId: `workflow-deidentification:${attestationDigest}`,
          attestationDigest,
        },
      })
      const existingTemplate = this.getWorkflowAutomationTemplate(template)
      if (existingTemplate !== undefined) {
        if (existingTemplate.status !== 'active'
          || JSON.stringify(existingTemplate.resolved) !== JSON.stringify({ contractVersion: 1, template, ...content })
          || existingTemplate.review.bindingId !== binding.id
          || existingTemplate.review.bindingVersion !== binding.version
          || existingTemplate.review.bindingGeneration !== binding.generation
          || existingTemplate.review.principalId !== owner.id) {
          throw new DeliveryStoreError('receipt-mismatch', 'deterministic workflow template is stale')
        }
      } else {
        const now = this.now()
        this.database.prepare(`
          INSERT INTO workflow_template_registry(
            template_ref, template_digest, scope_key, workspace, preset, owner_binding_id,
            content_json, privacy_kind, privacy_attestation_id, privacy_attestation_digest,
            review_receipt_json, status, review_inbox_id, source_inbox_id, source_outbox_id,
            created_at, updated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'deterministic-deidentification', ?, ?, ?,
            'active', ?, ?, ?, ?, ?, 1)
        `).run(
          template.templateRef, template.templateDigest, workflowScopeKey(content.scope),
          content.scope.workspace, content.scope.preset, binding.id, JSON.stringify(content),
          template.privacyAttestation.attestationId, template.privacyAttestation.attestationDigest,
          JSON.stringify(privacyReceipt), feedbackInbox.id, sourceInbox.id, sourceOutbox.id, now, now,
        )
      }

      const subjectRef = growthObjectDigest({
        contract: 'assistant-delivery-verified-workflow-subject/v1',
        bindingId: binding.id,
        sourceInboxId: sourceInbox.id,
        sourceOutboxId: sourceOutbox.id,
      })
      const payload: Omit<WorkflowTraceRevision, 'digest'> = Object.freeze({
        source: this.workflowTraceSourceAttestation(),
        scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
        subjectRef,
        version: 1,
        disposition: 'upsert' as const,
        evidence: Object.freeze({
          occurredAt: feedbackInbox.receivedAt,
          signal: 'verified-repetition' as const,
          objectiveStatus: 'achieved' as const,
          ownerBindingId: binding.id,
          taskRef,
          taskEvidenceDigest,
          template,
          steps: Object.freeze([Object.freeze({
            catalogId: 'assistant.agent-turn',
            argumentSchemaDigest: workflowArgumentShapeDigest({ prompt: descriptor.prompt }),
          })]),
        }),
      })
      const revision = validateWorkflowTraceRevision({
        ...payload,
        digest: workflowTraceRevisionDigest(payload),
      })
      const recorded = this.insertWorkflowTraceRevisionInTransaction(revision)
      if (recorded.replayed) {
        throw new DeliveryStoreError('version-conflict', 'new verified workflow feedback unexpectedly replayed')
      }
      this.insertVerifiedWorkflowTaskFeedback({
        sourceOutboxId: sourceOutbox.id,
        sourceInboxId: sourceInbox.id,
        feedbackInboxId: feedbackInbox.id,
        binding,
        ownerId: owner.id,
        objectiveStatus: input.objectiveStatus,
        taskRef,
        taskEvidenceDigest,
        revision,
        template,
      })
      return Object.freeze({ outcome: 'trace-recorded', revision, template, replayed: false })
    })
  }

  private insertVerifiedWorkflowTaskFeedback(input: Readonly<{
    sourceOutboxId: string
    sourceInboxId: string
    feedbackInboxId: string
    binding: Readonly<ConversationBinding>
    ownerId: string
    objectiveStatus: 'achieved' | 'partial' | 'not-achieved'
    taskRef: string
    taskEvidenceDigest: string
    revision?: Readonly<WorkflowTraceRevision>
    template?: Readonly<WorkflowAutomationTemplate>
  }>): void {
    if ((input.revision === undefined) !== (input.template === undefined)) {
      throw new DeliveryStoreError('conflict', 'verified workflow trace and template must agree')
    }
    if (input.revision !== undefined && (input.revision.disposition !== 'upsert'
      || input.revision.evidence?.signal !== 'verified-repetition'
      || input.revision.evidence.objectiveStatus !== 'achieved'
      || input.revision.evidence.taskRef !== input.taskRef
      || input.revision.evidence.taskEvidenceDigest !== input.taskEvidenceDigest
      || JSON.stringify(input.revision.evidence.template) !== JSON.stringify(input.template))) {
      throw new DeliveryStoreError('receipt-mismatch', 'verified workflow trace is not bound to its task receipt')
    }
    this.database.prepare(`
      INSERT INTO workflow_verified_task_feedback(
        source_outbox_id, source_inbox_id, feedback_inbox_id, binding_id, binding_version,
        binding_generation, principal_record_id, objective_status, task_ref, task_evidence_digest,
        trace_subject_ref, trace_version, trace_digest, template_ref, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceOutboxId, input.sourceInboxId, input.feedbackInboxId,
      input.binding.id, input.binding.version, input.binding.generation, input.ownerId,
      input.objectiveStatus, input.taskRef, input.taskEvidenceDigest,
      input.revision?.subjectRef ?? null, input.revision?.version ?? null,
      input.revision?.digest ?? null, input.template?.templateRef ?? null, this.now(),
    )
  }

  private replayVerifiedWorkflowTraceFeedback(input: Readonly<{
    row: Readonly<WorkflowVerifiedTaskFeedbackRow>
    binding: Readonly<ConversationBinding>
    ownerId: string
    feedbackInboxId: string
    sourceInboxId: string
    sourceOutboxId: string
    objectiveStatus: 'achieved' | 'partial' | 'not-achieved'
    taskRef: string
    taskEvidenceDigest: string
  }>): VerifiedWorkflowTraceFeedbackResult {
    const row = input.row
    if (row.source_outbox_id !== input.sourceOutboxId || row.source_inbox_id !== input.sourceInboxId
      || row.feedback_inbox_id !== input.feedbackInboxId || row.binding_id !== input.binding.id
      || row.binding_version !== input.binding.version || row.binding_generation !== input.binding.generation
      || row.principal_record_id !== input.ownerId || row.objective_status !== input.objectiveStatus
      || row.task_ref !== input.taskRef || row.task_evidence_digest !== input.taskEvidenceDigest) {
      throw new DeliveryStoreError('idempotency-conflict', 'verified workflow task already has a different owner judgement')
    }
    const traceFields = [row.trace_subject_ref, row.trace_version, row.trace_digest, row.template_ref]
    const traceFieldCount = traceFields.filter(value => value !== null).length
    if (traceFieldCount === 0) {
      return Object.freeze({
        outcome: 'no-trace',
        reason: row.objective_status === 'achieved' ? 'privacy-abstained' : 'objective-not-achieved',
        replayed: true,
      })
    }
    if (traceFieldCount !== traceFields.length || row.trace_subject_ref === null || row.trace_version === null
      || row.trace_digest === null || row.template_ref === null
      || !Number.isSafeInteger(row.trace_version) || row.trace_version < 1
      || !/^[a-f0-9]{64}$/u.test(row.trace_subject_ref)
      || !/^[a-f0-9]{64}$/u.test(row.trace_digest)) {
      throw new DeliveryStoreError('conflict', 'verified workflow task receipt is corrupt')
    }
    const traceRow = this.database.prepare(`
      SELECT * FROM workflow_trace_revisions WHERE subject_ref = ? AND version = ?
    `).get(row.trace_subject_ref, row.trace_version) as WorkflowTraceRevisionRow | undefined
    if (traceRow === undefined) {
      throw new DeliveryStoreError('conflict', 'verified workflow task trace is missing')
    }
    const revision = workflowTraceRevision(traceRow)
    const template = revision.disposition === 'upsert' ? revision.evidence?.template : undefined
    if (revision.digest !== row.trace_digest || revision.disposition !== 'upsert'
      || revision.evidence?.signal !== 'verified-repetition'
      || revision.evidence.objectiveStatus !== 'achieved'
      || revision.evidence.ownerBindingId !== input.binding.id
      || revision.evidence.taskRef !== input.taskRef
      || revision.evidence.taskEvidenceDigest !== input.taskEvidenceDigest
      || template === undefined || template.templateRef !== row.template_ref) {
      throw new DeliveryStoreError('receipt-mismatch', 'verified workflow task trace changed identity')
    }
    const storedTemplate = this.getWorkflowAutomationTemplate(template)
    if (storedTemplate === undefined
      || JSON.stringify(storedTemplate.resolved.template) !== JSON.stringify(template)) {
      throw new DeliveryStoreError('receipt-mismatch', 'verified workflow task template is missing')
    }
    return Object.freeze({ outcome: 'trace-recorded', revision, template, replayed: true })
  }

  getWorkflowAutomationTemplate(templateInput: Readonly<WorkflowAutomationTemplate>): StoredWorkflowTemplate | undefined {
    this.assertOpen()
    const template = validateWorkflowAutomationTemplate(templateInput)
    const row = this.database.prepare(`
      SELECT * FROM workflow_template_registry WHERE template_ref = ?
    `).get(template.templateRef) as WorkflowTemplateRow | undefined
    if (row === undefined) return undefined
    let contentValue: unknown
    let reviewValue: unknown
    try {
      contentValue = JSON.parse(row.content_json) as unknown
      reviewValue = JSON.parse(row.review_receipt_json) as unknown
    } catch {
      throw new DeliveryStoreError('conflict', 'workflow template registry payload is corrupt')
    }
    if (typeof reviewValue !== 'object' || reviewValue === null || Array.isArray(reviewValue)) {
      throw new DeliveryStoreError('conflict', 'workflow template review receipt is corrupt')
    }
    const review = reviewValue as Record<string, unknown>
    const content = validateWorkflowAutomationTemplateContent(contentValue)
    const receiptBindingVersion = review['bindingVersion']
    const receiptBindingGeneration = review['bindingGeneration']
    let attestationDigest: string
    if (row.privacy_kind === 'owner-explicit') {
      const exactReviewKeys = [
        'contractVersion', 'kind', 'limitation', 'templateDigest', 'bindingId', 'bindingVersion',
        'bindingGeneration', 'principalId', 'reviewInboxId', 'sourceInboxId', 'sourceOutboxId',
      ].sort()
      if (Object.keys(review).sort().some((key, index) => key !== exactReviewKeys[index])
        || Object.keys(review).length !== exactReviewKeys.length
        || review['contractVersion'] !== 1 || review['kind'] !== 'owner-explicit-template-review'
        || review['limitation'] !== 'deidentification-unproven'
        || review['templateDigest'] !== row.template_digest
        || review['bindingId'] !== row.owner_binding_id
        || review['reviewInboxId'] !== row.review_inbox_id
        || review['sourceInboxId'] !== row.source_inbox_id
        || review['sourceOutboxId'] !== row.source_outbox_id
        || typeof review['principalId'] !== 'string'
        || typeof receiptBindingVersion !== 'number' || !Number.isSafeInteger(receiptBindingVersion)
        || receiptBindingVersion < 1
        || typeof receiptBindingGeneration !== 'number' || !Number.isSafeInteger(receiptBindingGeneration)
        || receiptBindingGeneration < 1) {
        throw new DeliveryStoreError('conflict', 'workflow template review receipt columns do not match')
      }
      attestationDigest = growthObjectDigest({
        contract: 'assistant-delivery-workflow-template-review/v1',
        receipt: review,
      })
    } else if (row.privacy_kind === 'deterministic-deidentification') {
      const exactReceiptKeys = [
        'contractVersion', 'kind', 'method', 'catalogId', 'templateDigest', 'bindingId',
        'bindingVersion', 'bindingGeneration', 'principalId',
      ].sort()
      const catalogId = review['catalogId']
      const descriptor = typeof catalogId === 'string'
        ? getDeterministicallyDeidentifiedWorkflowTemplate(catalogId)
        : undefined
      if (Object.keys(review).sort().some((key, index) => key !== exactReceiptKeys[index])
        || Object.keys(review).length !== exactReceiptKeys.length
        || review['contractVersion'] !== 1
        || review['kind'] !== 'deterministic-deidentification-template-attestation'
        || review['method'] !== 'assistant-delivery-redaction-v1'
        || descriptor === undefined
        || review['templateDigest'] !== row.template_digest
        || review['bindingId'] !== row.owner_binding_id
        || typeof review['principalId'] !== 'string'
        || typeof receiptBindingVersion !== 'number' || !Number.isSafeInteger(receiptBindingVersion)
        || receiptBindingVersion < 1
        || typeof receiptBindingGeneration !== 'number' || !Number.isSafeInteger(receiptBindingGeneration)
        || receiptBindingGeneration < 1
        || content.name !== descriptor.name || content.prompt !== descriptor.prompt
        || content.schedule.kind !== descriptor.schedule.kind
        || content.schedule.expression !== descriptor.schedule.expression
        || content.schedule.timezone !== descriptor.schedule.timezone
        || content.timeoutMs !== descriptor.timeoutMs
        || JSON.stringify(content.toolCatalogIds) !== JSON.stringify(descriptor.toolCatalogIds)) {
        throw new DeliveryStoreError('conflict', 'deterministic workflow deidentification receipt is invalid')
      }
      attestationDigest = growthObjectDigest({
        contract: 'assistant-delivery-workflow-template-deidentification/v1',
        receipt: review,
      })
    } else {
      throw new DeliveryStoreError('conflict', 'workflow template privacy kind is invalid')
    }
    const storedTemplate = validateWorkflowAutomationTemplate({
      templateRef: row.template_ref,
      templateDigest: row.template_digest,
      privacyAttestation: row.privacy_kind === 'owner-explicit'
        ? {
            kind: 'owner-explicit', limitation: 'deidentification-unproven',
            attestationId: row.privacy_attestation_id,
            attestationDigest: row.privacy_attestation_digest,
          }
        : {
            kind: 'deterministic-deidentification', method: 'assistant-delivery-redaction-v1',
            attestationId: row.privacy_attestation_id,
            attestationDigest: row.privacy_attestation_digest,
          },
    })
    if (JSON.stringify(storedTemplate) !== JSON.stringify(template)
      || attestationDigest !== row.privacy_attestation_digest
      || storedTemplate.privacyAttestation.attestationId !== (row.privacy_kind === 'owner-explicit'
        ? `workflow-review:${attestationDigest}`
        : `workflow-deidentification:${attestationDigest}`)) {
      throw new DeliveryStoreError('receipt-mismatch', 'workflow template attestation is stale')
    }
    const contentBinding = this.getBinding(row.owner_binding_id)
    const resolved = validateResolvedWorkflowAutomationTemplate({
      contractVersion: 1,
      template: storedTemplate,
      ...content,
    })
    if (workflowScopeKey(content.scope) !== row.scope_key
      || content.scope.workspace !== row.workspace || content.scope.preset !== row.preset
      || content.ownerBindingId !== row.owner_binding_id
      || contentBinding === undefined
      || content.principalId !== externalPrincipalId(contentBinding.principal)
      || workflowAutomationTemplateContentDigest(content) !== row.template_digest) {
      throw new DeliveryStoreError('receipt-mismatch', 'workflow template content columns do not match')
    }
    return Object.freeze({
      resolved,
      review: Object.freeze({
        bindingId: row.owner_binding_id,
        bindingVersion: review['bindingVersion'] as number,
        bindingGeneration: review['bindingGeneration'] as number,
        principalId: review['principalId'] as string,
        reviewInboxId: row.review_inbox_id,
        sourceInboxId: row.source_inbox_id,
        sourceOutboxId: row.source_outbox_id,
      }),
      status: row.status,
      version: row.version,
    })
  }

  requeueCurrentWorkflowTraces(): number {
    this.assertOpen()
    const now = this.now()
    return this.transaction(() => {
      this.database.prepare(`
        UPDATE workflow_trace_outbox
        SET status = 'delivered', failure_code = 'superseded-revision', updated_at = ?
        WHERE status IN ('pending', 'retry_wait') AND NOT EXISTS (
          SELECT 1 FROM workflow_trace_current AS current
          WHERE current.subject_ref = workflow_trace_outbox.subject_ref
            AND current.version = workflow_trace_outbox.version
        )
      `).run(now)
      return Number(this.database.prepare(`
        UPDATE workflow_trace_outbox
        SET status = 'pending', attempt_count = 0, next_attempt_at = ?, failure_code = NULL, updated_at = ?
        WHERE (subject_ref, version) IN (
          SELECT subject_ref, version FROM workflow_trace_current
        )
      `).run(now, now).changes)
    })
  }

  enqueuePreferenceProjection(
    events: readonly Readonly<DeliveryPreferenceEvent>[],
  ): Readonly<{ batchKey: string; payloadDigest: string; replayed: boolean }> {
    this.assertOpen()
    const payload = preferenceProjectionPayload(events)
    return this.transaction(() => this.insertPreferenceProjection(payload))
  }

  /**
   * Persist an Agent reply and its content-free learning projection under one
   * SQLite commit. A process crash can therefore expose neither row or both,
   * but never a durable reply that permanently lost its completion signal.
   */
  enqueueReplyWithPreferenceProjection(
    input: OutboundIntent,
    eventsForReply: (
      reply: Readonly<OutboxRecord>,
    ) => readonly Readonly<DeliveryPreferenceEvent>[] | undefined,
  ): Readonly<{
    reply: OutboxRecord
    projection?: Readonly<{ batchKey: string; payloadDigest: string; replayed: boolean }>
  }> {
    this.assertOpen()
    if (typeof eventsForReply !== 'function') {
      throw new DeliveryStoreError('invalid-intent', 'preference projection builder is invalid')
    }
    return this.transaction(() => {
      const reply = this.enqueue(input)
      const events = eventsForReply(reply)
      if (events === undefined) return Object.freeze({ reply })
      const projection = this.insertPreferenceProjection(preferenceProjectionPayload(events))
      return Object.freeze({ reply, projection })
    })
  }

  listPendingPreferenceProjections(
    limitInput = 100,
    nowInput = this.now(),
  ): PreferenceProjectionOutboxEntry[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limitInput) || limitInput < 1 || limitInput > 1_000
      || !Number.isSafeInteger(nowInput) || nowInput < 0) {
      throw new DeliveryStoreError('conflict', 'preference projection outbox bounds are invalid')
    }
    return this.transaction(() => {
      this.normalizePreferenceProjectionLanes(nowInput)
      const legacy = this.database.prepare(`
        SELECT * FROM delivery_preference_projection_outbox
        WHERE terminal_at IS NULL AND lane_kind <> 'exact'
          AND status IN ('pending', 'retry_wait')
        ORDER BY created_at, batch_key
        LIMIT 1
      `).get() as PreferenceProjectionOutboxRow | undefined
      if (legacy !== undefined) {
        if (legacy.next_attempt_at > nowInput) return []
        return this.validPreferenceProjectionEntries([legacy], nowInput)
      }
      const rows = this.database.prepare(`
        SELECT candidate.*
        FROM delivery_preference_projection_outbox AS candidate
        WHERE candidate.terminal_at IS NULL AND candidate.lane_kind = 'exact'
          AND candidate.status IN ('pending', 'retry_wait')
          AND candidate.next_attempt_at <= ?
          AND NOT EXISTS (
            SELECT 1
            FROM delivery_preference_projection_outbox AS earlier
            WHERE earlier.terminal_at IS NULL AND earlier.lane_kind = 'exact'
              AND earlier.status IN ('pending', 'retry_wait')
              AND earlier.lane_epoch = candidate.lane_epoch
              AND earlier.lane_workspace = candidate.lane_workspace
              AND earlier.lane_preset = candidate.lane_preset
              AND earlier.lane_principal_record_id = candidate.lane_principal_record_id
              AND earlier.lane_principal_version = candidate.lane_principal_version
              AND (
                earlier.admission_sequence < candidate.admission_sequence
                OR (
                  earlier.admission_sequence = candidate.admission_sequence
                  AND (
                    earlier.created_at < candidate.created_at
                    OR (earlier.created_at = candidate.created_at
                      AND earlier.batch_key < candidate.batch_key)
                  )
                )
              )
          )
        ORDER BY candidate.next_attempt_at, candidate.admission_sequence,
          candidate.created_at, candidate.batch_key
        LIMIT ?
      `).all(nowInput, limitInput) as unknown as PreferenceProjectionOutboxRow[]
      return this.validPreferenceProjectionEntries(rows, nowInput)
    })
  }

  /** Earliest retry time among global legacy or exact owner-lane heads. */
  nextPreferenceProjectionAttemptAt(nowInput = this.now()): number | undefined {
    this.assertOpen()
    if (!Number.isSafeInteger(nowInput) || nowInput < 0) {
      throw new DeliveryStoreError('conflict', 'preference projection retry clock is invalid')
    }
    return this.transaction(() => {
      this.normalizePreferenceProjectionLanes(nowInput)
      const legacy = this.database.prepare(`
        SELECT next_attempt_at FROM delivery_preference_projection_outbox
        WHERE terminal_at IS NULL AND lane_kind <> 'exact'
          AND status IN ('pending', 'retry_wait')
        ORDER BY created_at, batch_key
        LIMIT 1
      `).get() as { next_attempt_at: number } | undefined
      if (legacy !== undefined) return legacy.next_attempt_at
      const row = this.database.prepare(`
        SELECT candidate.next_attempt_at
        FROM delivery_preference_projection_outbox AS candidate
        WHERE candidate.terminal_at IS NULL AND candidate.lane_kind = 'exact'
          AND candidate.status IN ('pending', 'retry_wait')
          AND NOT EXISTS (
            SELECT 1
            FROM delivery_preference_projection_outbox AS earlier
            WHERE earlier.terminal_at IS NULL AND earlier.lane_kind = 'exact'
              AND earlier.status IN ('pending', 'retry_wait')
              AND earlier.lane_epoch = candidate.lane_epoch
              AND earlier.lane_workspace = candidate.lane_workspace
              AND earlier.lane_preset = candidate.lane_preset
              AND earlier.lane_principal_record_id = candidate.lane_principal_record_id
              AND earlier.lane_principal_version = candidate.lane_principal_version
              AND (
                earlier.admission_sequence < candidate.admission_sequence
                OR (
                  earlier.admission_sequence = candidate.admission_sequence
                  AND (
                    earlier.created_at < candidate.created_at
                    OR (earlier.created_at = candidate.created_at
                      AND earlier.batch_key < candidate.batch_key)
                  )
                )
              )
          )
        ORDER BY candidate.next_attempt_at
        LIMIT 1
      `).get() as { next_attempt_at: number } | undefined
      return row?.next_attempt_at
    })
  }

  /**
   * A direct control may run only after every earlier projection in its exact
   * owner lane is terminal. Valid legacy rows are a global upgrade barrier
   * because their missing cursor makes a narrower comparison impossible.
   */
  hasBlockingPreferenceProjectionBefore(input: Readonly<{
    scope: Readonly<{ workspace: string; preset: string }>
    principalLineage: Readonly<{ principalRecordId: string; principalVersion: number }>
    admissionCursor: Readonly<{ epoch: string; sequence: number }>
  }>): boolean {
    this.assertOpen()
    const workspace = validateBindingText(input.scope.workspace, 'preference workspace', 4_096)
    const preset = validateBindingText(input.scope.preset, 'preference preset', 200)
    const principalRecordId = validateBindingText(
      input.principalLineage.principalRecordId,
      'preference principal record id',
      500,
    )
    if (!Number.isSafeInteger(input.principalLineage.principalVersion)
      || input.principalLineage.principalVersion < 1
      || !/^[0-9a-f]{32}$/u.test(input.admissionCursor.epoch)
      || !Number.isSafeInteger(input.admissionCursor.sequence)
      || input.admissionCursor.sequence < 1) {
      throw new DeliveryStoreError('conflict', 'preference control barrier authority is invalid')
    }
    const now = this.now()
    return this.transaction(() => {
      this.normalizePreferenceProjectionLanes(now)
      const blocker = this.database.prepare(`
        SELECT 1 AS present
        FROM delivery_preference_projection_outbox
        WHERE terminal_at IS NULL AND status IN ('pending', 'retry_wait')
          AND (
            lane_kind <> 'exact'
            OR (
              lane_epoch = ? AND lane_workspace = ? AND lane_preset = ?
              AND lane_principal_record_id = ? AND lane_principal_version = ?
              AND admission_sequence < ?
            )
          )
        LIMIT 1
      `).get(
        input.admissionCursor.epoch,
        workspace,
        preset,
        principalRecordId,
        input.principalLineage.principalVersion,
        input.admissionCursor.sequence,
      ) as { present: number } | undefined
      return blocker !== undefined
    })
  }

  completePreferenceProjection(input: {
    batchKey: string
    payloadDigest: string
  }): void {
    this.assertOpen()
    const changed = this.database.prepare(`
      DELETE FROM delivery_preference_projection_outbox
      WHERE batch_key = ? AND payload_digest = ? AND terminal_at IS NULL
    `).run(input.batchKey, input.payloadDigest)
    if (changed.changes === 1) return
    const current = this.database.prepare(`
      SELECT payload_digest, terminal_at
      FROM delivery_preference_projection_outbox WHERE batch_key = ?
    `).get(input.batchKey) as { payload_digest: string; terminal_at: number | null } | undefined
    // Another Host can append the same idempotent batch and delete it first.
    // Absence is therefore the peer-completed terminal, not a local failure.
    if (current === undefined) return
    if (current.payload_digest !== input.payloadDigest) {
      throw new DeliveryStoreError('receipt-mismatch', 'preference projection completion changed identity')
    }
    // A concurrent owner handoff terminally quarantines this exact batch. Its
    // late completion is an ACK-ignore terminal, never a reason to revive or
    // retry evidence from the retired lineage.
    if (current.terminal_at !== null) return
    throw new DeliveryStoreError('version-conflict', 'preference projection completion lost its active batch')
  }

  deferPreferenceProjection(input: {
    batchKey: string
    payloadDigest: string
    now: number
    retryAt: number
    failureCode: string
  }): void {
    this.assertOpen()
    const failureCode = validateBindingText(input.failureCode, 'preference projection failureCode', 64)
    if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.retryAt)
      || input.retryAt <= input.now) {
      throw new DeliveryStoreError('conflict', 'preference projection retry time is invalid')
    }
    const changed = this.database.prepare(`
      UPDATE delivery_preference_projection_outbox
      SET status = 'retry_wait', attempt_count = attempt_count + 1,
        next_attempt_at = ?, failure_code = ?, updated_at = ?
      WHERE batch_key = ? AND payload_digest = ? AND terminal_at IS NULL
    `).run(
      input.retryAt,
      failureCode,
      input.now,
      input.batchKey,
      input.payloadDigest,
    )
    if (changed.changes === 1) return
    const current = this.database.prepare(`
      SELECT payload_digest, terminal_at
      FROM delivery_preference_projection_outbox WHERE batch_key = ?
    `).get(input.batchKey) as { payload_digest: string; terminal_at: number | null } | undefined
    // If a peer received the authoritative receipt and removed this row while
    // our append was failing, its exact downstream commit is already enough.
    if (current === undefined) return
    if (current.payload_digest !== input.payloadDigest) {
      throw new DeliveryStoreError('receipt-mismatch', 'preference projection defer changed identity')
    }
    if (current.terminal_at !== null) return
    throw new DeliveryStoreError('version-conflict', 'preference projection defer lost its active batch')
  }

  /**
   * Revalidate one previously-read batch against the live Delivery owner.
   * Stale, legacy, poison, already-terminal, and peer-completed rows are
   * acknowledged without invoking a downstream sink.
   */
  preferenceProjectionHasCurrentOwner(input: {
    batchKey: string
    payloadDigest: string
  }): boolean {
    this.assertOpen()
    return this.transaction(() => this.currentPreferenceProjectionInTransaction(input) !== undefined)
  }

  /**
   * Linearizable projection for a process-local synchronous Preference writer.
   * Delivery's BEGIN IMMEDIATE remains held while Preference commits, giving
   * all cooperating processes the fixed Delivery -> Preference lock order.
   * A handoff therefore linearizes wholly before the callback (which is then
   * skipped) or wholly after the Preference commit and Delivery ACK.
   */
  projectPreferenceProjectionUnderOwnerFence(
    input: { batchKey: string; payloadDigest: string },
    project: (entry: Readonly<PreferenceProjectionOutboxEntry>) => void,
  ): PreferenceProjectionFenceResult {
    this.assertOpen()
    if (typeof project !== 'function') {
      throw new DeliveryStoreError('invalid-intent', 'preference projection writer is invalid')
    }
    return this.transaction(() => {
      const row = this.database.prepare(`
        SELECT * FROM delivery_preference_projection_outbox WHERE batch_key = ?
      `).get(input.batchKey) as PreferenceProjectionOutboxRow | undefined
      if (row === undefined) return 'missing'
      if (row.payload_digest !== input.payloadDigest) {
        throw new DeliveryStoreError('receipt-mismatch', 'preference projection fence changed identity')
      }
      const entry = this.currentPreferenceProjectionInTransaction(input, row)
      if (entry === undefined) return 'ignored'
      const result = project(entry) as unknown
      if (typeof result === 'object' && result !== null
        && typeof (result as { then?: unknown }).then === 'function') {
        throw new DeliveryStoreError(
          'invalid-intent',
          'preference projection fenced writer must complete synchronously',
        )
      }
      const deleted = this.database.prepare(`
        DELETE FROM delivery_preference_projection_outbox
        WHERE batch_key = ? AND payload_digest = ? AND terminal_at IS NULL
      `).run(entry.batchKey, entry.payloadDigest)
      if (deleted.changes !== 1) {
        throw new DeliveryStoreError('version-conflict', 'preference projection fenced ACK lost its batch')
      }
      return 'completed'
    })
  }

  requeuePreferenceProjections(): number {
    this.assertOpen()
    const now = this.now()
    return Number(this.database.prepare(`
      UPDATE delivery_preference_projection_outbox
      SET status = 'pending', next_attempt_at = ?, failure_code = NULL, updated_at = ?
      WHERE terminal_at IS NULL
    `).run(now, now).changes)
  }

  private normalizePreferenceProjectionLanes(now: number): void {
    const rows = this.database.prepare(`
      SELECT * FROM delivery_preference_projection_outbox
      WHERE terminal_at IS NULL
      ORDER BY created_at, batch_key
    `).all() as unknown as PreferenceProjectionOutboxRow[]
    for (const row of rows) {
      try {
        const entry = preferenceProjectionOutboxEntry(row)
        if (row.lane_kind !== 'unclassified') continue
        const changed = entry.lane === undefined
          ? this.database.prepare(`
              UPDATE delivery_preference_projection_outbox
              SET lane_kind = 'legacy', lane_epoch = NULL, lane_workspace = NULL,
                lane_preset = NULL, lane_principal_record_id = NULL,
                lane_principal_version = NULL, admission_sequence = NULL,
                updated_at = ?
              WHERE batch_key = ? AND payload_digest = ?
                AND terminal_at IS NULL AND lane_kind = 'unclassified'
            `).run(now, entry.batchKey, entry.payloadDigest)
          : this.database.prepare(`
              UPDATE delivery_preference_projection_outbox
              SET lane_kind = 'exact', lane_epoch = ?, lane_workspace = ?,
                lane_preset = ?, lane_principal_record_id = ?,
                lane_principal_version = ?, admission_sequence = ?, updated_at = ?
              WHERE batch_key = ? AND payload_digest = ?
                AND terminal_at IS NULL AND lane_kind = 'unclassified'
            `).run(
              entry.lane.epoch,
              entry.lane.workspace,
              entry.lane.preset,
              entry.lane.principalRecordId,
              entry.lane.principalVersion,
              entry.lane.admissionSequence,
              now,
              entry.batchKey,
              entry.payloadDigest,
            )
        if (changed.changes !== 1) {
          throw new DeliveryStoreError(
            'version-conflict',
            'preference projection lane normalization lost its exact batch',
          )
        }
      } catch {
        this.database.prepare(`
          UPDATE delivery_preference_projection_outbox
          SET terminal_at = ?, failure_code = 'projection-poison-row',
            attempt_count = attempt_count + 1, next_attempt_at = 9007199254740991,
            updated_at = ?
          WHERE batch_key = ? AND terminal_at IS NULL
        `).run(now, now, row.batch_key)
      }
    }
  }

  private currentPreferenceProjectionInTransaction(
    input: { batchKey: string; payloadDigest: string },
    selected?: PreferenceProjectionOutboxRow,
  ): PreferenceProjectionOutboxEntry | undefined {
    const row = selected ?? this.database.prepare(`
      SELECT * FROM delivery_preference_projection_outbox WHERE batch_key = ?
    `).get(input.batchKey) as PreferenceProjectionOutboxRow | undefined
    if (row === undefined) return undefined
    if (row.payload_digest !== input.payloadDigest) {
      throw new DeliveryStoreError('receipt-mismatch', 'preference projection owner fence changed identity')
    }
    if (row.terminal_at !== null) return undefined

    let entry: PreferenceProjectionOutboxEntry
    try {
      entry = preferenceProjectionOutboxEntry(row)
    } catch {
      this.terminalizePreferenceProjectionInTransaction(row.batch_key, 'projection-poison-row')
      return undefined
    }
    const owners = this.database.prepare(`
      SELECT id, principal_json, role, status, linked_to_id, created_at, updated_at, version
      FROM delivery_principals WHERE role = 'owner' AND status = 'active'
      ORDER BY id LIMIT 2
    `).all() as unknown as PrincipalRow[]
    let currentPrincipalId: string | undefined
    try {
      currentPrincipalId = owners.length === 1
        ? externalPrincipalId(JSON.parse(owners[0]!.principal_json) as ExternalPrincipalKey)
        : undefined
    } catch {
      currentPrincipalId = undefined
    }
    const owner = owners.length === 1 ? owners[0] : undefined
    if (row.lane_kind !== 'exact' || entry.lane === undefined || owner === undefined
      || entry.lane.principalRecordId !== owner.id
      || entry.lane.principalVersion !== owner.version
      || entry.events.some(event => event.principalId !== currentPrincipalId)) {
      this.terminalizePreferenceProjectionInTransaction(row.batch_key, 'owner-lineage-retired')
      return undefined
    }
    return entry
  }

  private terminalizePreferenceProjectionInTransaction(batchKey: string, failureCode: string): void {
    const now = this.now()
    this.database.prepare(`
      UPDATE delivery_preference_projection_outbox
      SET terminal_at = ?, failure_code = ?, next_attempt_at = 9007199254740991,
        updated_at = ?
      WHERE batch_key = ? AND terminal_at IS NULL
    `).run(now, failureCode, now, batchKey)
  }

  private validPreferenceProjectionEntries(
    rows: readonly PreferenceProjectionOutboxRow[],
    now: number,
  ): PreferenceProjectionOutboxEntry[] {
    const result: PreferenceProjectionOutboxEntry[] = []
    for (const row of rows) {
      try {
        result.push(preferenceProjectionOutboxEntry(row))
      } catch {
        this.database.prepare(`
          UPDATE delivery_preference_projection_outbox
          SET terminal_at = ?, failure_code = 'projection-poison-row',
            attempt_count = attempt_count + 1, next_attempt_at = 9007199254740991,
            updated_at = ?
          WHERE batch_key = ? AND terminal_at IS NULL
        `).run(now, now, row.batch_key)
      }
    }
    return result
  }

  private insertPreferenceProjection(payload: Readonly<{
    batchKey: string
    digest: string
    json: string
    lane?: Readonly<PreferenceProjectionLane>
  }>): Readonly<{ batchKey: string; payloadDigest: string; replayed: boolean }> {
    const existing = this.database.prepare(`
      SELECT payload_digest, events_json
      FROM delivery_preference_projection_outbox WHERE batch_key = ?
    `).get(payload.batchKey) as { payload_digest: string; events_json: string } | undefined
    if (existing !== undefined) {
      if (existing.payload_digest !== payload.digest || existing.events_json !== payload.json) {
        throw new DeliveryStoreError(
          'idempotency-conflict',
          'preference projection identity was reused with different events',
        )
      }
      return Object.freeze({
        batchKey: payload.batchKey,
        payloadDigest: payload.digest,
        replayed: true,
      })
    }
    const now = this.now()
    this.database.prepare(`
      INSERT INTO delivery_preference_projection_outbox(
        batch_key, payload_digest, events_json, status, attempt_count,
        next_attempt_at, failure_code, lane_kind, lane_epoch, lane_workspace,
        lane_preset, lane_principal_record_id, lane_principal_version,
        admission_sequence, terminal_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'pending', 0, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      payload.batchKey,
      payload.digest,
      payload.json,
      now,
      payload.lane === undefined ? 'legacy' : 'exact',
      payload.lane?.epoch ?? null,
      payload.lane?.workspace ?? null,
      payload.lane?.preset ?? null,
      payload.lane?.principalRecordId ?? null,
      payload.lane?.principalVersion ?? null,
      payload.lane?.admissionSequence ?? null,
      now,
      now,
    )
    return Object.freeze({
      batchKey: payload.batchKey,
      payloadDigest: payload.digest,
      replayed: false,
    })
  }

  listPendingWorkflowTraceRevisions(limitInput = 100, nowInput = this.now()): WorkflowTraceOutboxEntry[] {
    this.assertOpen()
    if (!Number.isSafeInteger(limitInput) || limitInput < 1 || limitInput > 1_000
      || !Number.isSafeInteger(nowInput) || nowInput < 0) {
      throw new DeliveryStoreError('conflict', 'workflow trace outbox bounds are invalid')
    }
    const rows = this.database.prepare(`
      SELECT revision.*, outbox.status, outbox.attempt_count, outbox.next_attempt_at,
        outbox.failure_code, outbox.updated_at
      FROM workflow_trace_outbox AS outbox
      JOIN workflow_trace_revisions AS revision
        ON revision.subject_ref = outbox.subject_ref AND revision.version = outbox.version
      JOIN workflow_trace_current AS current
        ON current.subject_ref = outbox.subject_ref AND current.version = outbox.version
      WHERE outbox.status IN ('pending', 'retry_wait') AND outbox.next_attempt_at <= ?
      ORDER BY outbox.next_attempt_at, outbox.updated_at, outbox.subject_ref, outbox.version
      LIMIT ?
    `).all(nowInput, limitInput) as unknown as WorkflowTraceOutboxRow[]
    const result: WorkflowTraceOutboxEntry[] = []
    for (const row of rows) {
      try {
        result.push(workflowTraceOutboxEntry(row))
      } catch {
        this.deferWorkflowTraceRevision({
          subjectRef: row.subject_ref,
          version: row.version,
          digest: row.digest,
          now: nowInput,
          retryAt: nowInput + 86_400_000,
          failureCode: 'trace-poison-row',
        })
      }
    }
    return result
  }

  completeWorkflowTraceRevision(input: {
    subjectRef: string
    version: number
    digest: string
    now?: number
  }): void {
    this.assertOpen()
    const now = input.now ?? this.now()
    const changed = this.database.prepare(`
      UPDATE workflow_trace_outbox
      SET status = 'delivered', failure_code = NULL, next_attempt_at = ?, updated_at = ?
      WHERE subject_ref = ? AND version = ? AND status IN ('pending', 'retry_wait')
        AND EXISTS (
          SELECT 1 FROM workflow_trace_revisions AS revision
          WHERE revision.subject_ref = workflow_trace_outbox.subject_ref
            AND revision.version = workflow_trace_outbox.version AND revision.digest = ?
        )
    `).run(now, now, input.subjectRef, input.version, input.digest)
    if (changed.changes !== 1) {
      const current = this.database.prepare(`
        SELECT outbox.status, revision.digest FROM workflow_trace_outbox AS outbox
        JOIN workflow_trace_revisions AS revision
          ON revision.subject_ref = outbox.subject_ref AND revision.version = outbox.version
        WHERE outbox.subject_ref = ? AND outbox.version = ?
      `).get(input.subjectRef, input.version) as { status: string; digest: string } | undefined
      if (current?.status !== 'delivered' || current.digest !== input.digest) {
        throw new DeliveryStoreError('version-conflict', 'workflow trace completion lost its exact revision')
      }
    }
  }

  deferWorkflowTraceRevision(input: {
    subjectRef: string
    version: number
    digest: string
    now: number
    retryAt: number
    failureCode: string
  }): void {
    this.assertOpen()
    const failureCode = validateBindingText(input.failureCode, 'workflow trace failureCode', 64)
    if (!Number.isSafeInteger(input.now) || !Number.isSafeInteger(input.retryAt)
      || input.retryAt <= input.now) throw new DeliveryStoreError('conflict', 'workflow trace retry time is invalid')
    const changed = this.database.prepare(`
      UPDATE workflow_trace_outbox
      SET status = 'retry_wait', attempt_count = attempt_count + 1,
        next_attempt_at = ?, failure_code = ?, updated_at = ?
      WHERE subject_ref = ? AND version = ? AND status IN ('pending', 'retry_wait')
        AND EXISTS (
          SELECT 1 FROM workflow_trace_revisions AS revision
          WHERE revision.subject_ref = workflow_trace_outbox.subject_ref
            AND revision.version = workflow_trace_outbox.version AND revision.digest = ?
        )
    `).run(input.retryAt, failureCode, input.now, input.subjectRef, input.version, input.digest)
    if (changed.changes !== 1) {
      throw new DeliveryStoreError('version-conflict', 'workflow trace defer lost its exact revision')
    }
  }

  private insertWorkflowTraceRevisionInTransaction(
    input: Readonly<WorkflowTraceRevision>,
  ): { revision: Readonly<WorkflowTraceRevision>; replayed: boolean } {
    const revision = validateWorkflowTraceRevision(input)
    const source = this.workflowTraceSourceAttestation()
    if (revision.source.sourceId !== source.sourceId
      || revision.source.generation !== source.generation
      || revision.source.authorityDigest !== source.authorityDigest) {
      throw new DeliveryStoreError('unauthorized-principal', 'workflow trace source authority changed')
    }

    const existingRow = this.database.prepare(`
      SELECT * FROM workflow_trace_revisions WHERE subject_ref = ? AND version = ?
    `).get(revision.subjectRef, revision.version) as WorkflowTraceRevisionRow | undefined
    if (existingRow !== undefined) {
      const existing = workflowTraceRevision(existingRow)
      if (existing.digest !== revision.digest
        || JSON.stringify(existing) !== JSON.stringify(revision)) {
        throw new DeliveryStoreError(
          'idempotency-conflict',
          'workflow trace version was reused with different content',
        )
      }
      const current = this.database.prepare(`
        SELECT version, digest FROM workflow_trace_current WHERE subject_ref = ?
      `).get(revision.subjectRef) as { version: number; digest: string } | undefined
      if (current === undefined || current.version < revision.version
        || (current.version === revision.version && current.digest !== revision.digest)) {
        throw new DeliveryStoreError('conflict', 'workflow trace current projection is inconsistent')
      }
      return Object.freeze({ revision: existing, replayed: true })
    }

    const current = this.database.prepare(`
      SELECT version, digest FROM workflow_trace_current WHERE subject_ref = ?
    `).get(revision.subjectRef) as { version: number; digest: string } | undefined
    if (current !== undefined && revision.version <= current.version) {
      throw new DeliveryStoreError(
        'version-conflict',
        'workflow trace version is lower than the current projection',
      )
    }

    const now = this.now()
    this.database.prepare(`
      INSERT INTO workflow_trace_revisions(
        subject_ref, version, source_generation, source_authority_digest, scope_key,
        workspace, preset, disposition, digest, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      revision.subjectRef,
      revision.version,
      revision.source.generation,
      revision.source.authorityDigest,
      workflowScopeKey(revision.scope),
      revision.scope.workspace,
      revision.scope.preset,
      revision.disposition,
      revision.digest,
      JSON.stringify(revision),
      now,
    )
    this.database.prepare(`
      INSERT INTO workflow_trace_current(
        subject_ref, version, digest, disposition, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_ref) DO UPDATE SET
        version = excluded.version,
        digest = excluded.digest,
        disposition = excluded.disposition,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
      WHERE excluded.version > workflow_trace_current.version
    `).run(
      revision.subjectRef,
      revision.version,
      revision.digest,
      revision.disposition,
      JSON.stringify(revision),
      now,
    )
    this.database.prepare(`
      INSERT INTO workflow_trace_outbox(
        subject_ref, version, status, attempt_count, next_attempt_at,
        failure_code, created_at, updated_at
      ) VALUES (?, ?, 'pending', 0, ?, NULL, ?, ?)
    `).run(revision.subjectRef, revision.version, now, now, now)
    return Object.freeze({ revision, replayed: false })
  }

  private revokeCurrentWorkflowTemplateInTransaction(
    current: Readonly<WorkflowTraceRevision> | undefined,
    now: number,
  ): void {
    const template = current?.disposition === 'upsert' ? current.evidence?.template : undefined
    if (template === undefined) return
    const row = this.database.prepare(`
      SELECT template_digest, status FROM workflow_template_registry WHERE template_ref = ?
    `).get(template.templateRef) as { template_digest: string; status: WorkflowTemplateRow['status'] } | undefined
    if (row === undefined) return
    if (row.template_digest !== template.templateDigest) {
      throw new DeliveryStoreError('receipt-mismatch', 'current workflow template identity is corrupt')
    }
    if (row.status === 'revoked') return
    const changed = this.database.prepare(`
      UPDATE workflow_template_registry
      SET status = 'revoked', updated_at = ?, version = version + 1
      WHERE template_ref = ? AND template_digest = ? AND status = 'active'
    `).run(now, template.templateRef, template.templateDigest)
    if (changed.changes !== 1) {
      throw new DeliveryStoreError('version-conflict', 'workflow template revocation lost its exact version')
    }
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
