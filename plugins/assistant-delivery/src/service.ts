import { chmodSync, mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import Schema from '@deepseek-ai/schemastery'
import {
  approvalReviewerOf,
  isAutoReviewEscalation,
  type ApprovalReviewer,
  type ApprovalDispatchRoute,
  type AssistantPolicyService,
  type PolicyDecision,
} from '@dsh-enhanced/assistant-policy'
import {
  TRUSTED_EVALUATION_PRODUCER_PROTOCOL,
  type TrustedDeliveryEvaluationClaims,
  type TrustedDeliveryEvaluationRegistration,
} from '@dsh-enhanced/assistant-evaluation'
import {
  ASSISTANT_GROWTH_CONTRACT_VERSION,
  growthObjectDigest,
  validateResolvedWorkflowAutomationTemplate,
  validateWorkflowAutomationTemplate,
  validateWorkflowScope,
  validateWorkflowTraceProjectionReceipt,
  workflowArgumentShapeDigest,
  type GrowthWorkflowTraceSourceRegistration,
  type ResolvedWorkflowAutomationTemplate,
  type WorkflowAutomationTemplate,
  type WorkflowScope,
  type WorkflowTraceSink,
} from '@dsh-enhanced/assistant-growth-contract'
import {
  DeliveryAdapterRegistry,
  DeliveryCoordinator,
  InboundCoordinator,
  type InboundMessageProcessor,
} from './coordinator.js'
import { DeliveryStore, DeliveryStoreError, type OwnerRouteDispatchGuard } from './store.js'
import { DshDeliveryRuntime } from './agent-runtime.js'
import { InboundImageMaterializer } from './inbound-images.js'
import { registerDeliveryTools } from './tools.js'
import {
  bindingMatchesOwnerRoute,
  canonicalBackgroundSourceId as canonicalHostBackgroundSourceId,
  canonicalConversation,
  canonicalLocalOperatorId,
  canonicalOwnerRouteAuthority,
  externalPrincipalId,
  ownerRouteAuthorityHash,
  ownerRouteBindingSnapshot,
} from './canonical.js'
import { isExactDeliveryCommand, parseDeliveryCommand } from './session-commands.js'
import {
  feedbackSignalInput,
  classifyNaturalPreferenceDirective,
  observedResponseLanguage,
  type FeedbackSignalSelection,
} from './feedback-command.js'
import type { WorkflowCommand } from './workflow-command.js'
import {
  DELIVERY_PREFERENCE_PROJECTION_PROTOCOL,
  TRUSTED_DELIVERY_PRESENTATION_PRODUCER_PROTOCOL,
} from './types.js'
import type {
  ConversationBinding,
  ConversationRef,
  DeliveryAdapter,
  DeadLetterResolutionResult,
  DeliveryLearningControlAction,
  DeliveryLearningControlReceipt,
  DeliveryLearningControlRequest,
  DeliveryOwnerLineage,
  DeliveryPreferenceEvent,
  DeliveryPreferenceCompletion,
  DeliveryPreferenceFeedbackReceipt,
  DeliveryPreferenceObservation,
  DeliveryPreferenceRegistration,
  DeliveryPreferenceProducer,
  DeliveryPreferencePrincipalAttestation,
  DeliveryPreferenceTurnAttestation,
  DeliveryPresentationUpdate,
  DeliveryToolApprovalRequest,
  ExternalPrincipalKey,
  InboundEnvelope,
  InboxRecord,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  ModelSelectionResult,
  ModelSelectionSettlementInput,
  ModelSelectionTerminalResult,
  OwnerRouteAuthority,
  OwnerRouteValidationReceipt,
  OutboundIntent,
  OutboxRecord,
  PairingChallenge,
  PermissionPickerIntent,
  ResolvedOwnerRoute,
  StoredDeliveryPresentation,
  TrustedDeliveryPresentationProducer,
  TrustedDeliveryPresentationRegistration,
} from './types.js'

const trustedDeliveryPreferenceProducers = new WeakSet<object>()
const deliveryPreferenceProducerProbe = Symbol('assistant-delivery.preference-producer-probe')

/**
 * Process-local authenticity against accidental service-slot collisions. The
 * private symbol is never exported, so copying the public method shape is not
 * enough to solicit a genuine registration. This is not an OS/process sandbox
 * boundary against code already executing inside the trusted Host process.
 */
export function isTrustedDeliveryPreferenceProducer(
  value: unknown,
): value is DeliveryPreferenceProducer {
  if (typeof value !== 'object' || value === null) return false
  try {
    const probe = (value as Record<PropertyKey, unknown>)[deliveryPreferenceProducerProbe]
    if (typeof probe !== 'function') return false
    const exact = (probe as () => unknown)()
    return typeof exact === 'object' && exact !== null
      && trustedDeliveryPreferenceProducers.has(exact)
  } catch {
    return false
  }
}

const learningMetadataPrefix = 'dsh.learning.'
const automationObjectiveFeedbackFooter = [
  '',
  '---',
  '任务结果反馈：直接回复本消息并发送 `/feedback achieved`、`/feedback partial` 或 `/feedback not-achieved`。',
  '`helpful` 等只记录偏好，不会被当成任务成败。',
].join('\n')

interface AutomationDeliveryEvidenceResolver {
  resolveDeliveryEvidence(input: {
    automationId: string
    runId: string
    expectedWorkspace: string
    expectedBindingId: string
    expectedOutputDigest: string
  }): Readonly<{
    schemaVersion: 1
    source: 'assistant-automations'
    executionKind: 'agent'
    automationId: string
    runId: string
    occurrenceId: string
    workspace: string
    agentPreset: string
    bindingId: string
    situation: string
    occurredAt: number
    executionStatus: 'succeeded'
    outputDigest: string
    proofDigest: string
  }> | undefined
}

function isAutomationDeliveryEvidenceResolver(value: unknown): value is AutomationDeliveryEvidenceResolver {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<AutomationDeliveryEvidenceResolver>).resolveDeliveryEvidence === 'function'
}

function registrationOwnedByEvaluation(
  registration: Readonly<TrustedDeliveryEvaluationRegistration>,
): boolean {
  const candidate = registration as Readonly<TrustedDeliveryEvaluationRegistration> & Readonly<{
    owner?: Readonly<{
      ownsTrustedDeliveryEvaluationRegistration(
        value: Readonly<TrustedDeliveryEvaluationRegistration>,
      ): boolean
    }>
  }>
  try {
    return typeof candidate.owner === 'object' && candidate.owner !== null
      && typeof candidate.owner.ownsTrustedDeliveryEvaluationRegistration === 'function'
      && candidate.owner.ownsTrustedDeliveryEvaluationRegistration(registration)
  } catch {
    return false
  }
}

function registrationOwnedByPreference(
  registration: Readonly<DeliveryPreferenceRegistration>,
): boolean {
  try {
    return typeof registration.owner === 'object' && registration.owner !== null
      && typeof registration.owner.ownsDeliveryPreferenceRegistration === 'function'
      && registration.owner.ownsDeliveryPreferenceRegistration(registration)
  } catch {
    return false
  }
}

function isTrustedDeliveryPresentationProducer(
  value: unknown,
): value is TrustedDeliveryPresentationProducer {
  return typeof value === 'object' && value !== null
    && typeof (value as Partial<TrustedDeliveryPresentationProducer>)
      .trustedDeliveryPresentationProducerGeneration === 'function'
    && typeof (value as Partial<TrustedDeliveryPresentationProducer>)
      .registerTrustedDeliveryPresentationSink === 'function'
}

function validatePreferenceProjectionReceipts(
  receipts: unknown,
  events: readonly Readonly<DeliveryPreferenceEvent>[],
): void {
  if (!Array.isArray(receipts) || receipts.length !== events.length) {
    throw Object.assign(new Error('preference projection receipt batch is invalid'), {
      code: 'invalid-receipt',
    })
  }
  const expected = new Set(events.map(event => event.idempotencyKey))
  const received = new Set<string>()
  for (const receipt of receipts as readonly Readonly<DeliveryPreferenceFeedbackReceipt>[]) {
    if (receipt?.status !== 'recorded' || typeof receipt.idempotencyKey !== 'string'
      || !expected.has(receipt.idempotencyKey) || received.has(receipt.idempotencyKey)) {
      throw Object.assign(new Error('preference projection receipt is invalid'), {
        code: 'invalid-receipt',
      })
    }
    received.add(receipt.idempotencyKey)
  }
}

function validateLearningControlReceipt(
  value: unknown,
  request: Readonly<DeliveryLearningControlRequest>,
): asserts value is Readonly<DeliveryLearningControlReceipt> {
  if (typeof value !== 'object' || value === null) throw new Error('learning control receipt is invalid')
  const receipt = value as Partial<DeliveryLearningControlReceipt>
  if (receipt.action !== request.action || receipt.idempotencyKey !== request.idempotencyKey) {
    throw new Error('learning control receipt identity is invalid')
  }
  if (receipt.outcome === 'stale') return
  if (receipt.outcome !== 'applied' || typeof receipt.replayed !== 'boolean'
    || typeof receipt.state !== 'object' || receipt.state === null) {
    throw new Error('learning control receipt outcome is invalid')
  }
  const state = receipt.state
  if (!['active', 'disabled', 'paused'].includes(state.mode as string)
    || typeof state.administrativelyEnabled !== 'boolean'
    || !['active', 'paused'].includes(state.collectionMode as string)
    || [state.signals, state.hypotheses, state.storedActiveOverlays,
      state.effectiveActiveOverlays, state.activeOverlays, state.shadowHypotheses]
      .some(count => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error('learning control receipt state is invalid')
  }
  const expectedMode = state.administrativelyEnabled ? state.collectionMode : 'disabled'
  const expectedEffective = state.administrativelyEnabled && state.collectionMode === 'active'
    ? state.storedActiveOverlays
    : 0
  if (state.mode !== expectedMode || state.effectiveActiveOverlays !== expectedEffective
    || state.activeOverlays !== expectedEffective) {
    throw new Error('learning control receipt state gates are inconsistent')
  }
  if (request.action === 'forget'
    && (!Number.isSafeInteger(receipt.deletedSignals) || receipt.deletedSignals! < 0
      || !Number.isSafeInteger(receipt.deletedHypotheses) || receipt.deletedHypotheses! < 0)) {
    throw new Error('learning forget receipt is invalid')
  }
  if (request.action === 'explain') {
    if (!Array.isArray(receipt.explanation)) throw new Error('learning explain receipt is invalid')
    for (const item of receipt.explanation) {
      if (typeof item !== 'object' || item === null
        || typeof item.key !== 'string' || typeof item.value !== 'string'
        || !['active', 'inactive', 'rolled-back', 'shadow', 'suppressed'].includes(item.state)
        || !Number.isSafeInteger(item.version) || item.version < 1
        || [item.supportingSignals, item.contradictingSignals, item.evidenceMass]
          .some(count => !Number.isSafeInteger(count) || count < 0)) {
        throw new Error('learning explain receipt is invalid')
      }
    }
  }
  if (request.action === 'rollback'
    && (typeof receipt.rolledBack !== 'boolean'
      || (receipt.rolledBack
        ? !Number.isSafeInteger(receipt.rolledBackVersion) || receipt.rolledBackVersion! < 2
        : receipt.rolledBackVersion !== undefined))) {
    throw new Error('learning rollback receipt is invalid')
  }
}

function containsReservedLearningMetadata(metadata: Readonly<Record<string, string>> | undefined): boolean {
  return metadata !== undefined && Object.keys(metadata).some(key => key.startsWith(learningMetadataPrefix))
}

export interface Config {
  databasePath: string
  spoolPath: string
  schedulerEnabled?: boolean
  tickIntervalMs?: number
  leaseMs?: number
  maxAttempts?: number
  maxConcurrency?: number
  maxTextBytes?: number
  retryBaseMs?: number
  retryMaxMs?: number
  pairingTtlMs?: number
  pairingMaxAttempts?: number
  defaultWorkspace?: string
  defaultAgentPreset?: string
  policyRef?: string
  agentProvider?: string
  agentModel?: string
  agentMaxOutputTokens?: number
  modelPickerTtlMs?: number
  permissionPickerTtlMs?: number
  toolApprovalTtlMs?: number
  /** Host-owned stable routes. They are never exposed as Agent tools or prompt input. */
  ownerRoutes?: readonly OwnerRouteAuthority[]
}

export interface DeliveryInboundRuntime extends InboundMessageProcessor {
  createSession(input: {
    envelope: Readonly<InboundEnvelope>
    generation: number
    previous?: Readonly<ConversationBinding>
    signal: AbortSignal
  }): Promise<{ sessionId: string; workspace: string; agentPreset: string; policyRef: string }>
  /** Immediate, process-local control path; it must never wait behind the binding's Inbox lane. */
  cancelActive?(
    binding: Readonly<ConversationBinding>,
    cause: 'new' | 'stop',
  ): boolean | Promise<boolean>
}

export type AssistantDeliveryErrorCode =
  | 'disposed'
  | 'missing-binding'
  | 'policy-denied'
  | 'runtime-conflict'
  | 'runtime-unavailable'

export class AssistantDeliveryError extends Error {
  constructor(readonly code: AssistantDeliveryErrorCode, message: string) {
    super(message)
    this.name = 'AssistantDeliveryError'
  }
}

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  spoolPath: Schema.string().required(),
  schedulerEnabled: Schema.boolean().default(true),
  tickIntervalMs: Schema.number().step(1).min(100).default(1_000),
  leaseMs: Schema.number().step(1).min(1_000).default(30_000),
  maxAttempts: Schema.number().step(1).min(1).max(100).default(5),
  maxConcurrency: Schema.number().step(1).min(1).max(100).default(4),
  maxTextBytes: Schema.number().step(1).min(1).max(16 * 1024 * 1024).default(65_536),
  retryBaseMs: Schema.number().step(1).min(1).default(1_000),
  retryMaxMs: Schema.number().step(1).min(1).default(300_000),
  pairingTtlMs: Schema.number().step(1).min(1).max(86_400_000).default(600_000),
  pairingMaxAttempts: Schema.number().step(1).min(1).max(10).default(5),
  defaultWorkspace: Schema.string().default(process.cwd()),
  defaultAgentPreset: Schema.string().min(1).default('standard'),
  policyRef: Schema.string().min(1).default('owner-dm'),
  agentProvider: Schema.string().min(1).default('deepseek-official'),
  agentModel: Schema.string().min(1).default('deepseek-v4-flash'),
  agentMaxOutputTokens: Schema.number().step(1).min(1).default(8_192),
  modelPickerTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
  permissionPickerTtlMs: Schema.number().step(1).min(60_000).max(86_400_000).default(900_000),
  toolApprovalTtlMs: Schema.number().step(1).min(1_000).max(300_000).default(300_000),
  ownerRoutes: Schema.array(Schema.object({
    id: Schema.string().min(1).required(),
    conversation: Schema.object({
      channel: Schema.string().min(1).required(),
      account: Schema.string().min(1).required(),
      tenant: Schema.string().min(1).required(),
      kind: Schema.union(['dm', 'group'] as const).required(),
      chat: Schema.string().min(1).required(),
      thread: Schema.string(),
    }).required(),
    principal: Schema.object({
      channel: Schema.string().min(1).required(),
      account: Schema.string().min(1).required(),
      tenant: Schema.string().min(1).required(),
      user: Schema.string().min(1).required(),
    }).required(),
    workspace: Schema.string().min(1).required(),
    agentPreset: Schema.string().min(1).required(),
    policyRef: Schema.string().min(1).required(),
    minimumGeneration: Schema.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  })).default([]),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantDelivery: AssistantDeliveryService
  }
}

function policyDenied(decision: PolicyDecision): AssistantDeliveryError {
  return new AssistantDeliveryError('policy-denied', `assistant-delivery policy denied operation: ${decision.reasonCode}`)
}

function canonicalBackgroundSourceId(input: unknown): string {
  try {
    return canonicalHostBackgroundSourceId(input)
  } catch {
    throw new AssistantDeliveryError('runtime-conflict', 'background source identity is invalid')
  }
}

function canonicalOwnerRouteId(input: unknown): string {
  const id = canonicalBackgroundSourceId(input)
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(id)) {
    throw new AssistantDeliveryError('missing-binding', 'owner route authority id is invalid')
  }
  return id
}

function canonicalRouteIdempotencyKey(input: unknown): string {
  if (typeof input !== 'string') {
    throw new AssistantDeliveryError('runtime-conflict', 'owner route idempotency key is invalid')
  }
  const normalized = input.trim()
  const hasControl = [...normalized].some(character => {
    const code = character.codePointAt(0)!
    return code <= 0x1f || code === 0x7f
  })
  if (normalized === '' || normalized.length > 512 || hasControl) {
    throw new AssistantDeliveryError('runtime-conflict', 'owner route idempotency key is invalid')
  }
  return normalized
}

interface DeliveryEvaluationSinkRegistration {
  token: symbol
  registration: Readonly<TrustedDeliveryEvaluationRegistration>
}

interface WorkflowTraceSinkRegistration {
  token: symbol
  sink: WorkflowTraceSink
}

type DeliveryPresentationProducerId = 'assistant-automations' | 'assistant-evolution'

interface DeliveryPresentationProducerBinding {
  readonly producerId: DeliveryPresentationProducerId
  readonly producer: TrustedDeliveryPresentationProducer
  readonly generation: string
  readonly registration: Readonly<TrustedDeliveryPresentationRegistration>
  readonly dispose: () => void
}

/** One exact Policy identity shared by enqueue admission and dispatch rechecks. */
function authorizeOwnerRoute(
  policy: AssistantPolicyService,
  authority: Readonly<OwnerRouteAuthority>,
  sourceId: string,
  idempotencyKey: string,
): PolicyDecision {
  const operationDigest = createHash('sha256').update(JSON.stringify([
    sourceId, authority.id, ownerRouteAuthorityHash(authority as OwnerRouteAuthority), idempotencyKey,
  ])).digest('hex')
  return policy.authorize({ subject: { kind: 'background', id: sourceId,
    workspace: authority.workspace, principal: externalPrincipalId(authority.principal) }, action: 'send',
  resource: { kind: 'message', id: `route:${authority.id}` },
  context: { initiator: 'background' } }, { idempotencyKey: `message-route-send:${operationDigest}` })
}

function pickerIncludesRoute(picker: Readonly<ModelPickerIntent>, route: Readonly<ModelRouteRef>): boolean {
  const model = picker.models.find(candidate => candidate.provider === route.provider && candidate.id === route.model)
  return model !== undefined && (route.reasoningEffort === undefined || model.effortIds.includes(route.reasoningEffort))
}

interface ModelSelectionPayload {
  callbackEventId: string
  callbackChatId: string
  cardMessageId: string
  bindingId: string
  principal: ExternalPrincipalKey
  provider: string
  modelProvider: string
  model: string
  reasoningEffort: string | null
  expectedRevision: number
}

interface ModelSelectionWaiter {
  readonly resolve: (result: ModelSelectionTerminalResult | undefined) => void
  readonly abort: () => void
  pollTimer?: ReturnType<typeof setTimeout>
  deadlineTimer?: ReturnType<typeof setTimeout>
}

const MODEL_SELECTION_WAIT_POLL_MS = 500
const MODEL_SELECTION_WAIT_TIMEOUT_MS = 120_000

interface ApprovalSettlementInput {
  operationId: string
  callbackEventId: string
  callbackChatId: string
  bindingId: string
  principal: ExternalPrincipalKey
  proposalId: string
  expectedVersion: number
  diffHash: string
  decision: 'approved' | 'rejected'
  reason: string
}

function isModelSelectionPayload(value: unknown): value is ModelSelectionPayload {
  if (value === null || typeof value !== 'object') return false
  const payload = value as Partial<ModelSelectionPayload>
  const principal = payload.principal as Partial<ExternalPrincipalKey> | undefined
  return typeof payload.callbackEventId === 'string'
    && typeof payload.callbackChatId === 'string'
    && typeof payload.cardMessageId === 'string'
    && typeof payload.bindingId === 'string'
    && principal !== undefined
    && typeof principal.channel === 'string'
    && typeof principal.account === 'string'
    && typeof principal.tenant === 'string'
    && typeof principal.user === 'string'
    && typeof payload.provider === 'string'
    && typeof payload.modelProvider === 'string'
    && typeof payload.model === 'string'
    && (payload.reasoningEffort === null || typeof payload.reasoningEffort === 'string')
    && Number.isSafeInteger(payload.expectedRevision)
}

const toolApprovalArgumentBytes = 16 * 1024
const toolApprovalIdentityBytes = 512
const toolApprovalReasonBytes = 2 * 1024
const permissionEventTypes = [
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'assistant-policy/approval-reviewer',
] as const
const approvalOutcomes = ['allowed-once', 'rejected', 'cancelled', 'unavailable'] as const

function currentPermissionEvents(agent: Agent): ReadonlyArray<unknown> {
  const latest = new Map<string, unknown>()
  for (const event of agent.session.events) {
    const type = String(event.type)
    if (!(permissionEventTypes as readonly string[]).includes(type)) continue
    latest.set(type, { seq: event.seq, type, data: event.data })
  }
  return permissionEventTypes.map(type => latest.get(type) ?? null)
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

interface ToolApprovalAuthority {
  adapter: DeliveryAdapter
  binding: ConversationBinding
  policyEmergencyVersion: number
  reviewRoute: 'auto-escalation' | 'user'
  routeKind: 'delegated' | 'direct'
  routeToken?: symbol
  actionHash: string
  arguments: string
  callId: string
}

interface ToolApprovalCallFact {
  seq: number
  name: string
  arguments: string
  hashIdentity: readonly unknown[]
}

type ToolApprovalRoute =
  | { state: 'none' | 'invalid' }
  | { state: 'bound'; binding: ConversationBinding; kind: 'delegated' | 'direct'; token?: symbol }

function sameToolApprovalAuthority(
  left: Readonly<ToolApprovalAuthority>,
  right: Readonly<ToolApprovalAuthority> | undefined,
): boolean {
  return right !== undefined
    && right.adapter === left.adapter
    && right.binding.id === left.binding.id
    && right.binding.version === left.binding.version
    && right.binding.generation === left.binding.generation
    && right.policyEmergencyVersion === left.policyEmergencyVersion
    && right.reviewRoute === left.reviewRoute
    && right.routeKind === left.routeKind
    && right.routeToken === left.routeToken
    && right.actionHash === left.actionHash
}

function serializeCodeDispatchArguments(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? serialized : undefined
  } catch {
    return undefined
  }
}

function exactToolApprovalCall(
  events: readonly SessionEvent[],
  openTurn: SessionEvent<'turn/start'>,
  callId: string,
  toolName: string,
): ToolApprovalCallFact | undefined {
  const matches: ToolApprovalCallFact[] = []
  let settled = false
  for (const event of events) {
    if (event.seq <= openTurn.seq) continue
    if (event.type === 'tool/call'
      && event.data.turn === openTurn.data.turn
      && String(event.data.callId) === callId) {
      matches.push({
        seq: event.seq,
        name: event.data.name,
        arguments: event.data.arguments,
        hashIdentity: ['tool/call', event.seq, event.data.turn, event.data.step,
          callId, event.data.name, event.data.arguments],
      })
    }
    if (event.type === 'tool/code-dispatch-start' && String(event.data.subCallId) === callId) {
      const rootCallId = String(event.data.rootCallId)
      const parentCallId = String(event.data.parentCallId)
      const argumentsJson = serializeCodeDispatchArguments(event.data.arguments)
      if (argumentsJson === undefined
        || Buffer.byteLength(rootCallId) > toolApprovalIdentityBytes
        || Buffer.byteLength(parentCallId) > toolApprovalIdentityBytes) return undefined
      matches.push({
        seq: event.seq,
        name: event.data.name,
        arguments: argumentsJson,
        hashIdentity: ['tool/code-dispatch-start', event.seq, rootCallId, parentCallId,
          callId, event.data.name, argumentsJson],
      })
    }
    if (event.type === 'tool/result'
      && String(event.data.message.source.callId) === callId) settled = true
    if (event.type === 'tool/code-dispatch'
      && String(event.data.subCallId) === callId) settled = true
  }
  const exact = matches.length === 1 ? matches[0] : undefined
  if (exact === undefined || settled || exact.name !== toolName
    || Buffer.byteLength(exact.arguments) > toolApprovalArgumentBytes) return undefined
  return exact
}

export class AssistantDeliveryService extends Service {
  static Config = configSchema

  private readonly deliveryStore: DeliveryStore
  private readonly context: Context
  private readonly policy: AssistantPolicyService
  private readonly registry: DeliveryAdapterRegistry
  private readonly outbound: DeliveryCoordinator
  private readonly inbound: InboundCoordinator
  private readonly config: Required<Config>
  private readonly ownerRoutes: ReadonlyMap<string, Readonly<OwnerRouteAuthority>>
  private readonly ownerRouteGuard: Readonly<OwnerRouteDispatchGuard>
  private readonly ownerId = `assistant-delivery-${randomUUID()}`
  private readonly bindingFlights = new Map<string, Promise<ConversationBinding>>()
  private readonly conversationTransitions = new Map<string, Promise<void>>()
  private readonly agentApprovalBindings = new WeakMap<Agent, { bindingId: string; token: symbol }>()
  private readonly toolApprovalControllers = new Set<AbortController>()
  private readonly modelSelectionWaiters = new Map<string, Set<ModelSelectionWaiter>>()
  private preferenceFeedbackSink:
    | Readonly<{
      token: symbol
      registration: Readonly<DeliveryPreferenceRegistration>
      dispose: () => void
    }>
    | undefined
  private evaluationSink: DeliveryEvaluationSinkRegistration | undefined
  private workflowTraceSink: WorkflowTraceSinkRegistration | undefined
  private automationPresentationBinding: DeliveryPresentationProducerBinding | undefined
  private evolutionPresentationBinding: DeliveryPresentationProducerBinding | undefined
  private readonly activePresentationRegistrations = new WeakSet<object>()
  private readonly evaluationProducerGeneration = `assistant-delivery:${randomUUID()}`
  private readonly preferenceProducerGeneration = `assistant-delivery-preference:${randomUUID()}`
  private readonly preferenceTurns = new WeakMap<Agent, Readonly<DeliveryPreferenceTurnAttestation>>()
  private modelSelectionFlight: Promise<void> | undefined
  private presentationFlight: Promise<void> | undefined
  private workflowTraceFlight: Promise<void> | undefined
  private preferenceProjectionFlight: Promise<void> | undefined
  private workflowTraceRetryTimer: ReturnType<typeof setTimeout> | undefined
  private preferenceProjectionRetryTimer: ReturnType<typeof setTimeout> | undefined
  private modelSelectionRetryTimer: ReturnType<typeof setTimeout> | undefined
  private runtime: DeliveryInboundRuntime | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantDelivery')
    trustedDeliveryPreferenceProducers.add(this)
    Object.defineProperty(this, deliveryPreferenceProducerProbe, {
      value: () => this,
      enumerable: false,
      configurable: false,
      writable: false,
    })
    this.context = ctx
    let config: Required<Config>
    try {
      config = AssistantDeliveryService.Config(input) as Required<Config>
    } catch (error) {
      throw new Error(`assistant-delivery: invalid configuration: ${String(error)}`, { cause: error })
    }
    if (!isAbsolute(config.databasePath) || !isAbsolute(config.spoolPath) || !isAbsolute(config.defaultWorkspace)) {
      throw new Error('assistant-delivery: databasePath, spoolPath, and defaultWorkspace must be absolute paths')
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('assistant-delivery: assistantPolicy service is required')
    mkdirSync(config.spoolPath, { recursive: true, mode: 0o700 })
    chmodSync(config.spoolPath, 0o700)
    let ownerRoutes: OwnerRouteAuthority[]
    try {
      ownerRoutes = config.ownerRoutes.map(route => canonicalOwnerRouteAuthority(route))
    } catch (error) {
      throw new Error(`assistant-delivery: invalid owner route authority: ${String(error)}`, { cause: error })
    }
    if (new Set(ownerRoutes.map(route => route.id)).size !== ownerRoutes.length) {
      throw new Error('assistant-delivery: invalid owner route authority: duplicate id')
    }
    const frozenOwnerRoutes = Object.freeze(ownerRoutes.map(route => Object.freeze({
      ...route,
      conversation: Object.freeze({ ...route.conversation }),
      principal: Object.freeze({ ...route.principal }),
    })))
    this.config = { ...config, ownerRoutes: frozenOwnerRoutes }
    this.ownerRoutes = new Map(frozenOwnerRoutes.map(route => [route.id, route]))
    this.policy = policy
    const ownerRouteGuard: OwnerRouteDispatchGuard = {
      ownerRoutes: [...this.ownerRoutes.values()],
      authorize: ({ authority, sourceId, idempotencyKey }) =>
        authorizeOwnerRoute(this.policy, authority, sourceId, idempotencyKey).effect === 'allow',
    }
    this.ownerRouteGuard = Object.freeze(ownerRouteGuard)
    this.deliveryStore = new DeliveryStore({ path: config.databasePath, maxTextBytes: config.maxTextBytes })
    ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => {
      this.capturePreferenceTurn(agent, message.source, turn)
    })
    ctx.on('agent/inbox/discarded', ({ agent }) => {
      this.preferenceTurns.delete(agent)
    })
    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.preferenceTurns.delete(agent)
    })
    this.registry = new DeliveryAdapterRegistry({
      accept: async envelope => {
        const result = await this.acceptInbound(envelope)
        return { duplicate: result.duplicate, inboxId: result.inboxId, status: result.status }
      },
      receipt: async receipt => {
        if (!this.active) return
        this.deliveryStore.recordReceipt(receipt)
      },
    })
    const imageMaterializer = new InboundImageMaterializer({
      store: this.deliveryStore,
      registry: this.registry,
      getAttachments: () => ctx.get('attachments'),
      isAuthorized: (binding, envelope) => this.isInboundAuthorized(binding, envelope),
    })
    this.outbound = new DeliveryCoordinator({ store: this.deliveryStore, registry: this.registry,
      ownerId: this.ownerId, leaseMs: config.leaseMs, maxAttempts: config.maxAttempts,
      maxConcurrency: config.maxConcurrency, retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs,
      ownerRouteGuard: this.ownerRouteGuard,
    })
    this.inbound = new InboundCoordinator({ store: this.deliveryStore, processor: () => this.runtime,
      ownerId: this.ownerId, leaseMs: config.leaseMs, maxAttempts: config.maxAttempts,
      maxConcurrency: config.maxConcurrency, retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs })
    ctx.inject(['agents', 'sessions', 'llm'], runtimeCtx => {
      const unregister = this.registerInboundRuntime(new DshDeliveryRuntime(runtimeCtx, policy, {
        sessionNamespace: this.deliveryStore.instanceId(),
        workspace: config.defaultWorkspace, agentPreset: config.defaultAgentPreset, policyRef: config.policyRef,
        getAgentPresets: () => runtimeCtx.get('agentPresets'),
        provider: config.agentProvider, model: config.agentModel, maxOutputTokens: config.agentMaxOutputTokens,
        modelPickerTtlMs: config.modelPickerTtlMs,
        permissionPickerTtlMs: config.permissionPickerTtlMs,
        getModelSelection: conversation => this.deliveryStore.getModelSelection(conversation),
        clearStaleModelReasoningEffort: (conversation, expected) =>
          this.deliveryStore.clearStaleModelReasoningEffort({ conversation, expected }),
        imageMaterializer,
        isInboundAuthorized: (binding, envelope) => this.isInboundAuthorized(binding, envelope),
        isPermissionController: (binding, envelope) => this.isPermissionController(binding, envelope),
        isOwnerFeedbackController: (binding, envelope) =>
          this.isOwnerFeedbackController(binding, envelope),
        authorizeOwnerPreferenceFeedback: (binding, envelope, selections) =>
          this.authorizeOwnerPreferenceFeedback(binding, envelope, selections),
        dispatchPreferenceFeedback: events => this.dispatchPreferenceFeedback(events),
        replyCompletedPreferenceTurn: (agent, binding, envelope, reply) =>
          this.replyCompletedPreferenceTurn(agent, binding, envelope, reply),
        dispatchObjectiveFeedback: (binding, envelope, objectiveStatus) =>
          this.dispatchObjectiveFeedback(binding, envelope, objectiveStatus),
        dispatchWorkflowCommand: (binding, envelope, command) =>
          this.dispatchWorkflowCommand(binding, envelope, command),
        dispatchLearningCommand: (binding, envelope, action, preferenceKey) =>
          this.dispatchLearningCommand(binding, envelope, action, preferenceKey),
        authorizePermissionReply: (binding, envelope) => this.authorizePermissionReply(binding, envelope),
        beginModelCommand: conversation => this.deliveryStore.beginModelCommand(conversation),
        commitModelCommand: input => this.deliveryStore.commitModelCommand(input),
        progress: async (binding, eventId, update) => {
          const adapter = this.registry.get(binding.conversation.channel, binding.conversation.account)
          await adapter?.progress?.({
            bindingId: binding.id,
            target: { conversation: binding.conversation, principal: binding.principal },
            eventId,
            update,
          })
        },
        replyCommand: (binding, eventId, reply, idempotencyKey) => { this.replyCommand(binding, {
          idempotencyKey: idempotencyKey ?? this.inboundReplyIdempotencyKey(binding, eventId),
          text: reply.text,
          replyToEventId: eventId,
          ...(reply.format === undefined ? {} : { format: reply.format }),
          ...(reply.modelPicker === undefined ? {} : { modelPicker: reply.modelPicker }),
          ...(reply.permissionPicker === undefined ? {} : { permissionPicker: reply.permissionPicker }),
        }) },
      }))
      void this.drainModelSelectionSettlements()
      return unregister
    })
    ctx.inject(['approval'], approvalCtx => approvalCtx.on('approval/request', (request, next) =>
      this.requestToolApproval(approvalCtx, request, next)))
    ctx.inject(['tools'], toolsCtx => registerDeliveryTools(toolsCtx, this))
    // Presentation writes are intentionally reverse-bound. Delivery creates
    // the publisher closure and hands it only to the exact live domain service;
    // a public service-slot caller can no longer forge a terminal projection.
    const currentAutomations = ctx.get('assistantAutomations' as never) as unknown
    if (isTrustedDeliveryPresentationProducer(currentAutomations)) {
      this.bindPresentationProducer('assistant-automations', currentAutomations)
    }
    ctx.inject(['assistantAutomations' as never], automationsCtx => {
      const producer = automationsCtx.get('assistantAutomations' as never) as unknown
      if (!isTrustedDeliveryPresentationProducer(producer)) return
      return this.bindPresentationProducer('assistant-automations', producer)
    })
    const currentEvolution = ctx.get('assistantEvolution' as never) as unknown
    if (isTrustedDeliveryPresentationProducer(currentEvolution)) {
      this.bindPresentationProducer('assistant-evolution', currentEvolution)
    }
    ctx.inject(['assistantEvolution' as never], evolutionCtx => {
      const producer = evolutionCtx.get('assistantEvolution' as never) as unknown
      if (!isTrustedDeliveryPresentationProducer(producer)) return
      return this.bindPresentationProducer('assistant-evolution', producer)
    })
    if (config.schedulerEnabled) this.start()
    ctx.effect(() => async () => {
      this.active = false
      trustedDeliveryPreferenceProducers.delete(this)
      this.preferenceFeedbackSink = undefined
      this.evaluationSink = undefined
      this.workflowTraceSink = undefined
      this.automationPresentationBinding?.dispose()
      this.evolutionPresentationBinding?.dispose()
      this.cancelModelSelectionWaiters()
      for (const controller of this.toolApprovalControllers) {
        controller.abort(new Error('assistant-delivery is stopping'))
      }
      await this.stopInternal()
      await this.registry.stop()
      this.deliveryStore.close()
    }, 'assistant-delivery.runtime')
  }

  issuePairing(operatorId: string, principal: ExternalPrincipalKey): { challenge: PairingChallenge; code: string } {
    this.assertActive()
    const decision = this.policy.authorize({ subject: { kind: 'external', id: `local:${operatorId}` },
      action: 'pair.issue', resource: { kind: 'message', id: 'pairing' }, context: { initiator: 'foreground' } })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.issuePairing(principal, { ttlMs: this.config.pairingTtlMs,
      maxAttempts: this.config.pairingMaxAttempts })
  }

  confirmPairing(input: { challengeId: string; principal: ExternalPrincipalKey; code: string }) {
    this.assertActive()
    const decision = this.policy.authorize({ subject: { kind: 'external', id: externalPrincipalId(input.principal) },
      action: 'pair.confirm', resource: { kind: 'message', id: 'pairing' }, context: { initiator: 'external' } })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.confirmPairing(input)
  }

  linkPrincipal(input: {
    operatorId: string
    owner: ExternalPrincipalKey
    linked: ExternalPrincipalKey
    expectedLinkedVersion: number
  }) {
    this.assertActive()
    const decision = this.policy.authorize({ subject: { kind: 'external', id: `local:${input.operatorId}` },
      action: 'pair.link', resource: { kind: 'message', id: 'principal-link' }, context: { initiator: 'foreground' } })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.linkPrincipal(input)
  }

  private validateApprovalSettlement(input: ApprovalSettlementInput): {
    approval: NonNullable<OutboxRecord['intent']['approval']>
    payload: Omit<ApprovalSettlementInput, 'operationId'>
    principal: string
  } {
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active' || current.role !== 'owner'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)
      || JSON.stringify(binding.principal) !== JSON.stringify(input.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'approval callback principal or chat does not own the active binding')
    }
    const approval = this.deliveryStore.getApprovalIntent(input.operationId, input.bindingId)
    if (approval === undefined
      || approval.proposalId !== input.proposalId
      || approval.expectedVersion !== input.expectedVersion
      || approval.diffHash !== input.diffHash) {
      throw new AssistantDeliveryError('missing-binding', 'approval callback does not match a persisted approval operation')
    }
    return {
      approval,
      principal: externalPrincipalId(current.principal),
      payload: { callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId,
        bindingId: input.bindingId, principal: current.principal, proposalId: input.proposalId,
        expectedVersion: input.expectedVersion, diffHash: input.diffHash,
        decision: input.decision, reason: input.reason },
    }
  }

  settleApproval(input: ApprovalSettlementInput): ReturnType<AssistantPolicyService['decideProposal']> {
    this.assertActive()
    const { approval, payload, principal } = this.validateApprovalSettlement(input)
    if (Date.now() >= approval.expiresAt) {
      throw new AssistantDeliveryError('missing-binding', 'approval callback expired before settlement')
    }
    let settlement: ReturnType<DeliveryStore['beginApprovalSettlement']> | undefined
    try {
      settlement = this.deliveryStore.beginApprovalSettlement({ operationId: input.operationId, payload,
        createIfMissing: false })
    } catch (error) {
      if (!(error instanceof DeliveryStoreError) || error.code !== 'not-found') throw error
    }
    const proposal = this.policy.getProposal(input.proposalId)
    const immutableProposalMatches = (candidate: ReturnType<AssistantPolicyService['getProposal']>) =>
      candidate !== undefined
        && candidate.principal === principal
        && candidate.expiresAt === approval.expiresAt
        && candidate.diffHash === approval.diffHash
        && candidate.summary === approval.title
    const pendingDecision = proposal !== undefined
      && immutableProposalMatches(proposal)
      && proposal.status === 'pending'
      && Date.now() < proposal.expiresAt
      && proposal.version === approval.expectedVersion
    const terminalReplay = (candidate: ReturnType<AssistantPolicyService['getProposal']>) =>
      candidate !== undefined
        && immutableProposalMatches(candidate)
        && approval.expectedVersion < Number.MAX_SAFE_INTEGER
        && candidate.version === approval.expectedVersion + 1
        && candidate.status === input.decision
        && candidate.decidedBy === principal
        && candidate.decisionReason === input.reason
    const terminalDecision = terminalReplay(proposal)
    if (!pendingDecision && !terminalDecision) {
      throw new AssistantDeliveryError('missing-binding', 'approval proposal no longer matches the persisted operation')
    }
    if (settlement === undefined) {
      if (!pendingDecision) {
        throw new AssistantDeliveryError('missing-binding', 'terminal approval has no prior durable settlement')
      }
      settlement = this.deliveryStore.beginApprovalSettlement({ operationId: input.operationId, payload })
    }
    if (settlement.result !== undefined) {
      if (!terminalReplay(this.policy.getProposal(input.proposalId))) {
        throw new AssistantDeliveryError('missing-binding', 'completed approval no longer matches Policy')
      }
      return settlement.result as ReturnType<AssistantPolicyService['decideProposal']>
    }
    if (pendingDecision) {
      const authorization = this.policy.authorize({ subject: { kind: 'external', id: principal },
        action: 'approval.decide', resource: { kind: 'message', id: input.bindingId },
        context: { initiator: 'external' } }, { idempotencyKey: `approval-callback:${input.operationId}` })
      if (authorization.effect !== 'allow') throw policyDenied(authorization)
    }
    const result = this.policy.decideProposal({ proposalId: input.proposalId, principal,
      expectedVersion: input.expectedVersion, decision: input.decision, reason: input.reason })
    return this.deliveryStore.completeApprovalSettlement({ operationId: input.operationId,
      payloadHash: settlement.payloadHash, result }) as ReturnType<AssistantPolicyService['decideProposal']>
  }

  recoverApprovalSettlement(input: ApprovalSettlementInput): ReturnType<AssistantPolicyService['decideProposal']> | undefined {
    this.assertActive()
    const { approval, payload, principal } = this.validateApprovalSettlement(input)
    let settlement: ReturnType<DeliveryStore['beginApprovalSettlement']>
    try {
      settlement = this.deliveryStore.beginApprovalSettlement({ operationId: input.operationId, payload,
        createIfMissing: false })
    } catch (error) {
      if (error instanceof DeliveryStoreError && error.code === 'not-found') return undefined
      throw error
    }
    const proposal = this.policy.getProposal(input.proposalId)
    const exactTerminal = proposal !== undefined
      && proposal.principal === principal
      && proposal.expiresAt === approval.expiresAt
      && proposal.diffHash === approval.diffHash
      && proposal.summary === approval.title
      && approval.expectedVersion < Number.MAX_SAFE_INTEGER
      && proposal.version === approval.expectedVersion + 1
      && proposal.status === input.decision
      && proposal.decidedBy === principal
      && proposal.decisionReason === input.reason
    if (!exactTerminal) return undefined
    if (settlement.result !== undefined) {
      return settlement.result as ReturnType<AssistantPolicyService['decideProposal']>
    }
    const result = this.policy.decideProposal({ proposalId: input.proposalId, principal,
      expectedVersion: input.expectedVersion, decision: input.decision, reason: input.reason })
    return this.deliveryStore.completeApprovalSettlement({ operationId: input.operationId,
      payloadHash: settlement.payloadHash, result }) as ReturnType<AssistantPolicyService['decideProposal']>
  }

  settleModelSelection(input: ModelSelectionSettlementInput): ModelSelectionResult {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'model callback principal or chat does not own the active binding')
    }
    const record = this.deliveryStore.getModelPickerRecord(input.operationId, input.bindingId)
    const expected: ModelPickerState = {
      revision: input.expectedRevision,
      provider: input.modelProvider,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }
    if (record === undefined || !['accepted', 'delivered', 'read'].includes(record.status)
      || record.providerMessageId !== input.cardMessageId) {
      throw new AssistantDeliveryError('missing-binding', 'model picker confirmation is unavailable or invalid')
    }
    const picker = record.intent.modelPicker
    if (picker === undefined || !pickerIncludesRoute(picker, expected)) {
      throw new AssistantDeliveryError('missing-binding', 'model picker confirmation is unavailable or invalid')
    }
    const authorization = this.policy.authorize({ subject: { kind: 'external', id: externalPrincipalId(current.principal) },
      action: 'ingest', resource: { kind: 'message', id: `model-selection:${binding.id}` },
      context: { initiator: 'external' } },
    { idempotencyKey: `model-selection:${input.operationId}:${input.callbackEventId}` })
    if (authorization.effect !== 'allow') throw policyDenied(authorization)
    const payload: ModelSelectionPayload = {
      callbackEventId: input.callbackEventId,
      callbackChatId: input.callbackChatId,
      cardMessageId: input.cardMessageId,
      bindingId: input.bindingId,
      principal: current.principal,
      provider: input.provider,
      modelProvider: input.modelProvider,
      model: input.model,
      reasoningEffort: input.reasoningEffort ?? null,
      expectedRevision: input.expectedRevision,
    }
    const settlement = this.deliveryStore.beginModelSelectionSettlement({
      operationId: input.operationId,
      bindingId: input.bindingId,
      expected,
      payload,
      createIfMissing: Date.now() < picker.expiresAt,
    })
    if (settlement.result !== undefined) return settlement.result as ModelSelectionResult
    void this.drainModelSelectionSettlements()
    return { status: 'pending' }
  }

  async awaitModelSelection(
    input: ModelSelectionSettlementInput,
    signal: AbortSignal,
  ): Promise<ModelSelectionTerminalResult | undefined> {
    this.assertActive()
    const expected: ModelPickerState = {
      revision: input.expectedRevision,
      provider: input.modelProvider,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }
    const payload: ModelSelectionPayload = {
      callbackEventId: input.callbackEventId,
      callbackChatId: input.callbackChatId,
      cardMessageId: input.cardMessageId,
      bindingId: input.bindingId,
      principal: input.principal,
      provider: input.provider,
      modelProvider: input.modelProvider,
      model: input.model,
      reasoningEffort: input.reasoningEffort ?? null,
      expectedRevision: input.expectedRevision,
    }
    const read = () => this.deliveryStore.getModelSelectionSettlement({
      operationId: input.operationId, bindingId: input.bindingId, expected, payload,
    })
    const current = read()
    if (current?.result !== undefined) return current.result as ModelSelectionTerminalResult
    if (current === undefined) {
      throw new AssistantDeliveryError('missing-binding', 'model selection settlement does not exist')
    }
    if (signal.aborted) return undefined
    return await new Promise<ModelSelectionTerminalResult | undefined>((resolve, reject) => {
      let settled = false
      const finish = (result: ModelSelectionTerminalResult | undefined) => {
        if (settled) return
        settled = true
        if (waiter.pollTimer !== undefined) clearTimeout(waiter.pollTimer)
        if (waiter.deadlineTimer !== undefined) clearTimeout(waiter.deadlineTimer)
        signal.removeEventListener('abort', waiter.abort)
        const waiters = this.modelSelectionWaiters.get(input.operationId)
        waiters?.delete(waiter)
        if (waiters?.size === 0) this.modelSelectionWaiters.delete(input.operationId)
        resolve(result)
      }
      const waiter: ModelSelectionWaiter = { abort: () => finish(undefined), resolve: finish }
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        if (waiter.pollTimer !== undefined) clearTimeout(waiter.pollTimer)
        if (waiter.deadlineTimer !== undefined) clearTimeout(waiter.deadlineTimer)
        signal.removeEventListener('abort', waiter.abort)
        const currentWaiters = this.modelSelectionWaiters.get(input.operationId)
        currentWaiters?.delete(waiter)
        if (currentWaiters?.size === 0) this.modelSelectionWaiters.delete(input.operationId)
        reject(error)
      }
      const poll = () => {
        if (settled) return
        if (signal.aborted || !this.active) {
          finish(undefined)
          return
        }
        try {
          const latest = read()
          if (latest?.result !== undefined) {
            finish(latest.result as ModelSelectionTerminalResult)
            return
          }
          waiter.pollTimer = setTimeout(poll, MODEL_SELECTION_WAIT_POLL_MS)
          waiter.pollTimer.unref?.()
        } catch (error) {
          fail(error)
        }
      }
      const waiters = this.modelSelectionWaiters.get(input.operationId) ?? new Set<ModelSelectionWaiter>()
      waiters.add(waiter)
      this.modelSelectionWaiters.set(input.operationId, waiters)
      signal.addEventListener('abort', waiter.abort, { once: true })
      waiter.deadlineTimer = setTimeout(() => finish(undefined), MODEL_SELECTION_WAIT_TIMEOUT_MS)
      waiter.deadlineTimer.unref?.()
      try {
        const raced = read()
        if (raced?.result !== undefined) finish(raced.result as ModelSelectionTerminalResult)
        else if (signal.aborted || !this.active) finish(undefined)
        else {
          waiter.pollTimer = setTimeout(poll, MODEL_SELECTION_WAIT_POLL_MS)
          waiter.pollTimer.unref?.()
        }
      } catch (error) {
        fail(error)
      }
    })
  }

  advanceModelPickerForCallback(input: {
    operationId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    principal: ExternalPrincipalKey
    expected: ModelPickerState
    next: ModelRouteRef
  }): { applied: boolean; state: ModelPickerState } {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'model callback principal or chat does not own the active binding')
    }
    const record = this.deliveryStore.getModelPickerRecord(input.operationId, input.bindingId)
    if (record === undefined || !['accepted', 'delivered', 'read'].includes(record.status)
      || record.providerMessageId !== input.cardMessageId) {
      throw new AssistantDeliveryError('missing-binding', 'model picker catalog or route is unavailable')
    }
    const picker = record.intent.modelPicker
    if (picker === undefined || Date.now() >= picker.expiresAt
      || !pickerIncludesRoute(picker, input.expected) || !pickerIncludesRoute(picker, input.next)) {
      throw new AssistantDeliveryError('missing-binding', 'model picker catalog or route is unavailable')
    }
    return this.deliveryStore.advanceModelPicker({
      operationId: input.operationId,
      bindingId: input.bindingId,
      expected: input.expected,
      next: input.next,
    })
  }

  getModelPickerForCallback(input: {
    operationId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    principal: ExternalPrincipalKey
  }): ModelPickerIntent | undefined {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'model callback principal or chat does not own the active binding')
    }
    const record = this.deliveryStore.getModelPickerRecord(input.operationId, input.bindingId)
    if (record === undefined || !['accepted', 'delivered', 'read'].includes(record.status)
      || record.providerMessageId !== input.cardMessageId) return undefined
    const picker = record.intent.modelPicker
    return picker === undefined || Date.now() >= picker.expiresAt ? undefined : picker
  }

  async settlePermissionSelection(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    cardMessageId: string
    bindingId: string
    bindingVersion: number
    sessionId: string
    principal: ExternalPrincipalKey
    issuedAt: number
    expiresAt: number
    expectedStateHash: string
    emergencyStopVersion: number
    targetLevel: 'ask' | 'auto' | 'full'
  }): Promise<{ duplicate: boolean; inboxId: string; status: InboxRecord['status'] }> {
    this.assertActive()
    if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,255}$/u.test(input.callbackEventId)
      || !/^[A-Za-z0-9][A-Za-z0-9._@/-]{0,511}$/u.test(input.cardMessageId)
      || !/^[a-f0-9]{64}$/u.test(input.expectedStateHash)
      || !Number.isSafeInteger(input.bindingVersion) || input.bindingVersion < 1
      || !Number.isSafeInteger(input.emergencyStopVersion) || input.emergencyStopVersion < 0
      || !Number.isSafeInteger(input.issuedAt) || input.issuedAt < 1
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= input.issuedAt
      || (input.targetLevel !== 'ask' && input.targetLevel !== 'auto' && input.targetLevel !== 'full')) {
      throw new AssistantDeliveryError('missing-binding', 'permission picker callback shape is invalid')
    }
    const resolveController = () => {
      const emergencyStop = this.policy.getEmergencyStop()
      const binding = this.deliveryStore.getBinding(input.bindingId)
      const principal = this.deliveryStore.getPrincipal(input.principal)
      const active = binding === undefined ? undefined : this.deliveryStore.getActiveBinding(binding.conversation)
      if (binding?.status !== 'active' || active?.id !== binding.id
        || principal?.status !== 'active' || principal.role !== 'owner') return undefined
      const record = this.deliveryStore.getPermissionPickerRecord(input.operationId, input.bindingId)
      const picker = record?.intent.permissionPicker
      if (record === undefined || picker === undefined
        || binding.version !== input.bindingVersion || picker.bindingVersion !== input.bindingVersion
        || binding.sessionId !== input.sessionId || picker.sessionId !== input.sessionId
        || binding.conversation.kind !== 'dm' || binding.conversation.chat !== input.callbackChatId
        || externalPrincipalId(binding.principal) !== externalPrincipalId(input.principal)
        || externalPrincipalId(record.intent.target.principal) !== externalPrincipalId(input.principal)
        || JSON.stringify(record.intent.target.conversation) !== JSON.stringify(binding.conversation)
        || picker.operationId !== input.operationId
        || picker.issuedAt !== input.issuedAt || picker.expiresAt !== input.expiresAt
        || picker.expectedStateHash !== input.expectedStateHash
        || picker.emergencyStopVersion !== input.emergencyStopVersion
        || emergencyStop.enabled || emergencyStop.version !== picker.emergencyStopVersion
        || Date.now() >= picker.expiresAt
        || !['accepted', 'delivered', 'read'].includes(record.status)
        || record.providerMessageId !== input.cardMessageId) return undefined
      return { binding, picker, principal }
    }
    const controller = resolveController()
    if (controller === undefined) {
      throw new AssistantDeliveryError('missing-binding', 'permission picker no longer owns the active session')
    }
    const { binding, picker, principal } = controller
    const command = input.targetLevel === 'full'
      ? '/permission full confirm'
      : `/permission ${input.targetLevel}`
    const envelope: InboundEnvelope = {
      channel: binding.conversation.channel,
      account: binding.conversation.account,
      eventId: input.cardMessageId,
      occurredAt: picker.issuedAt,
      principal: { ...principal.principal },
      conversation: { ...binding.conversation },
      kind: 'command',
      text: command,
      metadata: {
        'permission-picker-operation': picker.operationId,
        'permission-picker-state': picker.expectedStateHash,
        'permission-picker-expires-at': String(picker.expiresAt),
        'permission-picker-emergency-version': String(picker.emergencyStopVersion),
        'permission-picker-callback': input.callbackEventId,
      },
    }
    if (!this.isPermissionController(binding, envelope)) {
      throw new AssistantDeliveryError('missing-binding', 'permission picker owner authorization was revoked')
    }
    const accepted = this.deliveryStore.acceptInbound(envelope)
    let inbox = accepted.record
    if (inbox.status === 'dead_letter') {
      throw new AssistantDeliveryError('runtime-conflict', 'permission picker selection previously failed')
    }
    if (!['received', 'authorized'].includes(inbox.status)) {
      return { duplicate: accepted.duplicate, inboxId: inbox.id, status: inbox.status }
    }
    return await this.runConversationTransition(binding.conversation, async () => {
      await this.recoverPendingInbound(envelope, inbox.id)
      inbox = this.deliveryStore.getInbox(inbox.id)!
      if (inbox.status === 'dead_letter') {
        throw new AssistantDeliveryError('runtime-conflict', 'permission picker selection previously failed')
      }
      if (!['received', 'authorized'].includes(inbox.status)) {
        return { duplicate: accepted.duplicate, inboxId: inbox.id, status: inbox.status }
      }
      const current = resolveController()
      if (current === undefined || !this.isPermissionController(current.binding, envelope)) {
        inbox = this.deliveryStore.deadLetterInbox(inbox.id, 'permission-session-superseded')
        throw new AssistantDeliveryError('missing-binding', 'permission picker no longer owns the active session')
      }
      if (!this.authorizePermissionReply(current.binding, envelope)) {
        inbox = this.deliveryStore.deadLetterInbox(inbox.id, 'permission-reply-authorization-denied')
        throw new AssistantDeliveryError('policy-denied', 'permission picker terminal reply authorization was denied')
      }
      const decision = this.policy.authorize({
        subject: { kind: 'external', id: externalPrincipalId(input.principal) },
        action: 'ingest',
        resource: { kind: 'message', id: `inbound:${envelope.channel}/${envelope.account}` },
        context: { initiator: 'external' },
      }, { idempotencyKey: `message-inbound:${inbox.id}` })
      if (decision.effect !== 'allow' || !this.isPermissionController(current.binding, envelope)) {
        inbox = this.deliveryStore.deadLetterInbox(inbox.id,
          decision.effect !== 'allow' ? `policy-${decision.reasonCode}` : 'permission-authorization-revoked')
        throw new AssistantDeliveryError('policy-denied', 'permission picker owner authorization was revoked')
      }
      inbox = this.deliveryStore.queueInbox(inbox.id, current.binding.id)
      return { duplicate: accepted.duplicate, inboxId: inbox.id, status: inbox.status }
    })
  }

  resolveDeadLetter(input: {
    operatorId: string
    kind: 'inbox' | 'outbox'
    id: string
    expectedAttemptCount: number
    resolution: 'cancel' | 'retry'
  }): DeadLetterResolutionResult<InboxRecord> | DeadLetterResolutionResult<OutboxRecord> {
    this.assertActive()
    let operatorId: string
    try {
      operatorId = canonicalLocalOperatorId(input.operatorId)
    } catch {
      throw new AssistantDeliveryError('runtime-conflict', 'dead-letter operator identity is invalid')
    }
    const operationDigest = createHash('sha256').update(JSON.stringify([
      operatorId, input.kind, input.id, input.expectedAttemptCount, input.resolution,
    ])).digest('hex')
    const decision = this.policy.authorize({ subject: { kind: 'external', id: `local:${operatorId}` },
      action: 'delivery.resolve', resource: { kind: 'message', id: `${input.kind}:${input.id}` },
      context: { initiator: 'foreground' } }, { idempotencyKey: `delivery-resolve:${operationDigest}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return input.kind === 'inbox'
      ? this.deliveryStore.resolveInbox({ inboxId: input.id, expectedAttemptCount: input.expectedAttemptCount,
        resolution: input.resolution, operatorId })
      : this.deliveryStore.resolveOutbox({ outboxId: input.id, expectedAttemptCount: input.expectedAttemptCount,
        resolution: input.resolution, operatorId })
  }

  registerInboundRuntime(runtime: DeliveryInboundRuntime): () => void {
    this.assertActive()
    if (this.runtime !== undefined) throw new AssistantDeliveryError('runtime-conflict', 'inbound runtime is already registered')
    this.runtime = runtime
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.runtime === runtime) this.runtime = undefined
    }
  }

  registerAdapter(adapter: DeliveryAdapter): Promise<() => Promise<void>> {
    this.assertActive()
    return this.registry.register(adapter)
  }

  currentPreferenceTurn(agent: Agent): Readonly<DeliveryPreferenceTurnAttestation> | undefined {
    this.assertActive()
    const attestation = this.preferenceTurns.get(agent)
    if (attestation === undefined
      || String(agent.session.id) !== attestation.sessionId
      || agent.session.header.cwd !== attestation.scope.workspace
      || agent.session.header.agentPreset !== attestation.scope.preset) return undefined
    const binding = this.deliveryStore.getBinding(attestation.bindingId)
    const inbox = this.deliveryStore.getInbox(attestation.sourceInboxId)
    const lineage = binding === undefined ? undefined : this.ownerLineageForBinding(binding)
    if (binding?.status !== 'active' || binding.version !== attestation.bindingVersion
      || binding.sessionId !== attestation.sessionId
      || inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || inbox.envelope.eventId !== attestation.sourceEventId
      || lineage?.principalRecordId !== attestation.principalLineage.principalRecordId
      || lineage?.principalVersion !== attestation.principalLineage.principalVersion
      || !this.isOwnerFeedbackController(binding, inbox.envelope)) return undefined
    const started = agent.session.events.some(event =>
      event.type === 'turn/start' && event.data.turn === attestation.turn)
    const ended = agent.session.events.some(event =>
      event.type === 'turn/end' && event.data.turn === attestation.turn)
    return started && !ended ? attestation : undefined
  }

  preferencePrincipalForAgent(
    agent: Agent,
  ): Readonly<DeliveryPreferencePrincipalAttestation> | undefined {
    this.assertActive()
    const sessionId = String(agent.session.id)
    const binding = this.deliveryStore.getBindingBySession(sessionId)
    const principal = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
    if (binding?.status !== 'active' || binding.sessionId !== sessionId
      || binding.workspace !== agent.session.header.cwd
      || binding.agentPreset !== agent.session.header.agentPreset
      || principal?.status !== 'active' || principal.role !== 'owner'
      || JSON.stringify(principal.principal) !== JSON.stringify(binding.principal)) return undefined
    return Object.freeze({
      scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
      principalId: externalPrincipalId(binding.principal),
      principalLineage: Object.freeze({
        principalRecordId: principal.id,
        principalVersion: principal.version,
      }),
      bindingId: binding.id,
      bindingVersion: binding.version,
      sessionId,
    })
  }

  private capturePreferenceTurn(agent: Agent, sourceInput: unknown, turnInput: unknown): void {
    if (!this.active || typeof sourceInput !== 'object' || sourceInput === null
      || !Number.isSafeInteger(turnInput) || (turnInput as number) < 0) return
    const source = sourceInput as { kind?: unknown; channel?: unknown; account?: unknown; eventId?: unknown }
    if (source.kind !== 'delivery' || typeof source.channel !== 'string'
      || typeof source.account !== 'string' || typeof source.eventId !== 'string') return
    const sessionId = String(agent.session.id)
    const binding = this.deliveryStore.getBindingBySession(sessionId)
    const inbox = this.deliveryStore.getInboxByProviderEvent(source.channel, source.account, source.eventId)
    const lineage = binding === undefined ? undefined : this.ownerLineageForBinding(binding)
    if (binding?.status !== 'active' || inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || binding.sessionId !== sessionId || binding.workspace !== agent.session.header.cwd
      || binding.agentPreset !== agent.session.header.agentPreset
      || lineage === undefined
      || !this.isOwnerFeedbackController(binding, inbox.envelope)) return
    this.preferenceTurns.set(agent, Object.freeze({
      scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
      principalId: externalPrincipalId(binding.principal),
      principalLineage: lineage,
      bindingId: binding.id,
      bindingVersion: binding.version,
      sessionId,
      sourceEventId: source.eventId,
      sourceInboxId: inbox.id,
      turn: turnInput as number,
    }))
  }

  trustedPreferenceProducerGeneration(): string {
    this.assertActive()
    return this.preferenceProducerGeneration
  }

  /** Exact process-local Preference owner registration; copied or self-asserted sinks fail. */
  registerTrustedPreferenceSink(
    registration: Readonly<DeliveryPreferenceRegistration>,
  ): () => void {
    this.assertActive()
    if (registration.protocol !== DELIVERY_PREFERENCE_PROJECTION_PROTOCOL
      || registration.producer !== 'preference-learning'
      || registration.generation !== this.preferenceProducerGeneration
      || typeof registration.append !== 'function'
      || (registration.appendSynchronously !== undefined
        && typeof registration.appendSynchronously !== 'function')
      || !registrationOwnedByPreference(registration)) {
      throw new AssistantDeliveryError('runtime-conflict', 'trusted Preference registration is invalid')
    }
    if (this.preferenceFeedbackSink !== undefined) {
      if (this.preferenceFeedbackSink.registration === registration) {
        return this.preferenceFeedbackSink.dispose
      }
      throw new AssistantDeliveryError('runtime-conflict', 'trusted Preference sink is already registered')
    }
    const token = Symbol('assistant-delivery.trusted-preference')
    let active = true
    const dispose = () => {
      if (!active) return
      active = false
      if (this.preferenceFeedbackSink?.token === token) this.preferenceFeedbackSink = undefined
    }
    this.preferenceFeedbackSink = Object.freeze({ token, registration, dispose })
    this.deliveryStore.requeuePreferenceProjections()
    void this.drainPreferenceProjections()
    return dispose
  }

  trustedEvaluationProducerGeneration(): string {
    this.assertActive()
    return this.evaluationProducerGeneration
  }

  registerTrustedDeliveryEvaluationSink(
    registration: Readonly<TrustedDeliveryEvaluationRegistration>,
  ): () => void {
    this.assertActive()
    if (registration.protocol !== TRUSTED_EVALUATION_PRODUCER_PROTOCOL
      || registration.producer !== 'assistant-delivery'
      || registration.generation !== this.evaluationProducerGeneration
      || typeof registration.issueCapability !== 'function'
      || typeof registration.append !== 'function'
      || !registrationOwnedByEvaluation(registration)) {
      throw new AssistantDeliveryError('runtime-conflict', 'trusted Evaluation registration is invalid')
    }
    if (this.evaluationSink !== undefined) {
      throw new AssistantDeliveryError('runtime-conflict', 'trusted Evaluation sink is already registered')
    }
    const token = Symbol('assistant-delivery.trusted-evaluation')
    this.evaluationSink = Object.freeze({ token, registration })
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.evaluationSink?.token === token) this.evaluationSink = undefined
    }
  }

  /**
   * Register Growth's exact private sink. Replaying current is deliberately
   * queued after this method returns so a registration receipt can never be
   * confused with synchronous projection success.
   */
  registerWorkflowTraceSink(input: Readonly<{
    contractVersion: 1
    sink: WorkflowTraceSink
  }>): GrowthWorkflowTraceSourceRegistration {
    this.assertActive()
    if (typeof input !== 'object' || input === null
      || Object.keys(input).sort().join(',') !== 'contractVersion,sink'
      || input.contractVersion !== ASSISTANT_GROWTH_CONTRACT_VERSION
      || typeof input.sink !== 'object' || input.sink === null
      || typeof input.sink.projectWorkflowTraceRevision !== 'function') {
      throw new AssistantDeliveryError('runtime-conflict', 'workflow trace sink registration is invalid')
    }
    if (this.workflowTraceSink !== undefined) {
      throw new AssistantDeliveryError('runtime-conflict', 'workflow trace sink is already registered')
    }
    const token = Symbol('assistant-delivery.workflow-trace')
    this.workflowTraceSink = Object.freeze({ token, sink: input.sink })
    const source = this.deliveryStore.workflowTraceSourceAttestation()
    let registered = true
    const receipt = Object.freeze({
      contractVersion: ASSISTANT_GROWTH_CONTRACT_VERSION,
      ...source,
      dispose: () => {
        if (!registered) return
        registered = false
        if (this.workflowTraceSink?.token === token) this.workflowTraceSink = undefined
      },
    }) satisfies GrowthWorkflowTraceSourceRegistration
    queueMicrotask(() => {
      if (!this.active || this.workflowTraceSink?.token !== token) return
      this.deliveryStore.requeueCurrentWorkflowTraces()
      void this.drainWorkflowTraces()
    })
    return receipt
  }

  resolveWorkflowAutomationTemplate(input: Readonly<{
    contractVersion: 1
    template: Readonly<WorkflowAutomationTemplate>
    scope: Readonly<WorkflowScope>
    ownerBindingId: string
  }>): Readonly<ResolvedWorkflowAutomationTemplate> {
    this.assertActive()
    if (typeof input !== 'object' || input === null
      || Object.keys(input).sort().join(',') !== 'contractVersion,ownerBindingId,scope,template'
      || input.contractVersion !== ASSISTANT_GROWTH_CONTRACT_VERSION
      || typeof input.ownerBindingId !== 'string') {
      throw new AssistantDeliveryError('runtime-conflict', 'workflow template resolution request is invalid')
    }
    const template = validateWorkflowAutomationTemplate(input.template)
    const scope = validateWorkflowScope(input.scope)
    const stored = this.deliveryStore.getWorkflowAutomationTemplate(template)
    const binding = this.deliveryStore.getBinding(input.ownerBindingId)
    const owner = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
    const principalId = binding === undefined ? undefined : externalPrincipalId(binding.principal)
    if (stored === undefined || stored.status !== 'active'
      || stored.resolved.ownerBindingId !== input.ownerBindingId
      || stored.resolved.scope.workspace !== scope.workspace
      || stored.resolved.scope.preset !== scope.preset
      || binding?.status !== 'active' || binding.workspace !== scope.workspace
      || binding.agentPreset !== scope.preset || owner?.status !== 'active' || owner.role !== 'owner'
      || stored.review.bindingId !== binding.id
      || stored.review.bindingVersion !== binding.version
      || stored.review.bindingGeneration !== binding.generation
      || stored.review.principalId !== owner.id
      || stored.resolved.principalId !== principalId) {
      throw new AssistantDeliveryError('missing-binding', 'workflow template owner review is stale')
    }
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: 'assistant-growth-experiments',
        workspace: scope.workspace, principal: externalPrincipalId(binding.principal) },
      action: 'inspect',
      resource: { kind: 'evolution', id: `workflow-template:${template.templateRef}` },
      context: { initiator: 'background' },
    }, { idempotencyKey: `workflow-template-resolve:${template.templateDigest}:${binding.version}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    // Policy evaluation is not a lock. Re-read the mutable route immediately
    // before returning private prompt material.
    const currentBinding = this.deliveryStore.getBinding(binding.id)
    const currentOwner = currentBinding === undefined
      ? undefined
      : this.deliveryStore.getPrincipal(currentBinding.principal)
    const currentTemplate = this.deliveryStore.getWorkflowAutomationTemplate(template)
    if (currentBinding?.status !== 'active' || currentBinding.version !== binding.version
      || currentBinding.generation !== binding.generation
      || currentOwner?.status !== 'active' || currentOwner.role !== 'owner'
      || currentTemplate?.status !== 'active' || currentTemplate.version !== stored.version
      || currentTemplate.review.bindingId !== currentBinding.id
      || currentTemplate.review.bindingVersion !== currentBinding.version
      || currentTemplate.review.bindingGeneration !== currentBinding.generation
      || currentTemplate.review.principalId !== currentOwner.id
      || currentTemplate.resolved.principalId !== externalPrincipalId(currentBinding.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'workflow template authority changed during resolution')
    }
    return validateResolvedWorkflowAutomationTemplate(currentTemplate.resolved)
  }

  health(): ReturnType<DeliveryStore['health']> & { adapters: number } {
    this.assertActive()
    return { ...this.deliveryStore.health(), adapters: this.registry.size() }
  }

  /** Exact process-local proof for a Delivery-minted publisher registration. */
  ownsTrustedDeliveryPresentationRegistration(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): boolean {
    return this.active && typeof registration === 'object' && registration !== null
      && this.activePresentationRegistrations.has(registration)
  }

  getDeliveryPresentation(presentationKey: string): StoredDeliveryPresentation | undefined {
    this.assertActive()
    return this.deliveryStore.getDeliveryPresentation(presentationKey)
  }

  private presentationBinding(
    producerId: DeliveryPresentationProducerId,
  ): DeliveryPresentationProducerBinding | undefined {
    return producerId === 'assistant-automations'
      ? this.automationPresentationBinding
      : this.evolutionPresentationBinding
  }

  private setPresentationBinding(
    producerId: DeliveryPresentationProducerId,
    binding: DeliveryPresentationProducerBinding | undefined,
  ): void {
    if (producerId === 'assistant-automations') this.automationPresentationBinding = binding
    else this.evolutionPresentationBinding = binding
  }

  private presentationProducerGeneration(producer: TrustedDeliveryPresentationProducer): string {
    let generation: unknown
    try {
      generation = producer.trustedDeliveryPresentationProducerGeneration()
    } catch {
      throw new AssistantDeliveryError('runtime-conflict', 'presentation producer generation is unavailable')
    }
    if (typeof generation !== 'string') {
      throw new AssistantDeliveryError('runtime-conflict', 'presentation producer generation is invalid')
    }
    const normalized = generation.normalize('NFC').trim()
    const hasControl = [...normalized].some(character => {
      const code = character.codePointAt(0)!
      return code <= 0x1f || code === 0x7f
    })
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(normalized) || hasControl) {
      throw new AssistantDeliveryError('runtime-conflict', 'presentation producer generation is invalid')
    }
    return normalized
  }

  /**
   * Delivery owns the registration and its publish closure. The producer only
   * receives that closure after it has proven this exact in-process object is
   * its expected Delivery owner; replacement and disposal revoke it eagerly.
   */
  private bindPresentationProducer(
    producerId: DeliveryPresentationProducerId,
    producer: TrustedDeliveryPresentationProducer,
  ): () => void {
    const generation = this.presentationProducerGeneration(producer)
    const current = this.presentationBinding(producerId)
    // Cordis can expose more than one proxy object for the same service
    // instance. A producer generation is minted once per concrete producer
    // lifetime, so it is the stable instance identity across those proxies.
    // Do not issue a second publisher merely because a later inject callback
    // reached the same producer through a different proxy.
    if (current?.generation === generation) return current.dispose

    let live = true
    let registration!: Readonly<TrustedDeliveryPresentationRegistration>
    registration = Object.freeze({
      protocol: TRUSTED_DELIVERY_PRESENTATION_PRODUCER_PROTOCOL,
      producer: producerId,
      generation,
      owner: this,
      publish: (input: DeliveryPresentationUpdate): StoredDeliveryPresentation => {
        this.assertCurrentPresentationProducer(producerId, producer, generation, registration, live)
        return this.publishTrustedDeliveryPresentation(producerId, input)
      },
    }) satisfies TrustedDeliveryPresentationRegistration
    this.activePresentationRegistrations.add(registration)

    let unregister: (() => void) | undefined
    let binding!: DeliveryPresentationProducerBinding
    const dispose = () => {
      if (!live) return
      live = false
      this.activePresentationRegistrations.delete(registration)
      if (this.presentationBinding(producerId) === binding) {
        this.setPresentationBinding(producerId, undefined)
      }
      unregister?.()
    }
    binding = Object.freeze({ producerId, producer, generation, registration, dispose })
    this.setPresentationBinding(producerId, binding)
    try {
      unregister = producer.registerTrustedDeliveryPresentationSink(registration)
      if (typeof unregister !== 'function') {
        throw new AssistantDeliveryError(
          'runtime-conflict',
          'presentation producer returned no registration disposer',
        )
      }
      // A reload that swaps its generation while registering cannot inherit a
      // publisher issued to the preceding instance state.
      if (this.presentationProducerGeneration(producer) !== generation) {
        throw new AssistantDeliveryError('runtime-conflict', 'presentation producer changed during registration')
      }
    } catch (error) {
      live = false
      this.activePresentationRegistrations.delete(registration)
      if (this.presentationBinding(producerId) === binding) {
        this.setPresentationBinding(producerId, current)
      }
      try {
        unregister?.()
      } catch {
        // Registration never became live, so cleanup cannot replace the
        // original registration failure.
      }
      throw error
    }
    // Do not revoke the old producer until the replacement has accepted the
    // new publisher; a reentrant durable outbox drain then has one valid owner.
    current?.dispose()
    return dispose
  }

  private assertCurrentPresentationProducer(
    producerId: DeliveryPresentationProducerId,
    producer: TrustedDeliveryPresentationProducer,
    generation: string,
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
    live: boolean,
  ): void {
    this.assertActive()
    const current = this.presentationBinding(producerId)
    if (!live || !this.activePresentationRegistrations.has(registration)
      || current?.producer !== producer || current.generation !== generation
      || current.registration !== registration
      || this.presentationProducerGeneration(producer) !== generation) {
      throw new AssistantDeliveryError('runtime-conflict', 'stale trusted presentation producer capability')
    }
  }

  private publishTrustedDeliveryPresentation(
    producerId: DeliveryPresentationProducerId,
    input: DeliveryPresentationUpdate,
  ): StoredDeliveryPresentation {
    this.assertActive()
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || typeof (input as { presentation?: unknown }).presentation !== 'object'
      || (input as { presentation?: unknown }).presentation === null
      || Array.isArray((input as { presentation?: unknown }).presentation)) {
      throw new AssistantDeliveryError('runtime-conflict', 'trusted presentation input is invalid')
    }
    const exactApproval = producerId === 'assistant-evolution'
      && input.presentation.kind === 'approval-application'
      && input.presentationKey === `approval-application:${input.presentation.policyProposalId}`
      && input.originalOutboxIdempotencyKey === `approval-card:${input.presentation.policyProposalId}`
    const incidentKey = input.presentation.kind === 'automation-incident'
      ? `automation-incident:${input.presentation.incidentId}:g${input.presentation.lifecycleGeneration}`
      : undefined
    const exactIncident = producerId === 'assistant-automations'
      && input.presentation.kind === 'automation-incident'
      && input.presentationKey === incidentKey
      && input.originalOutboxIdempotencyKey === incidentKey
      && input.revision === input.presentation.incidentRevision
    if (!exactApproval && !exactIncident) {
      throw new AssistantDeliveryError(
        'runtime-conflict',
        'presentation does not target its exact durable provider message',
      )
    }
    const stored = this.deliveryStore.publishDeliveryPresentation(input)
    void this.drainDeliveryPresentations()
    return stored
  }

  private isInboundAuthorized(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean {
    if (!this.active) return false
    const current = this.deliveryStore.getBinding(binding.id)
    const active = this.deliveryStore.getActiveBinding(envelope.conversation)
    const principal = this.deliveryStore.getPrincipal(envelope.principal)
    const envelopePrincipal = externalPrincipalId(envelope.principal)
    if (current?.status !== 'active'
      || active?.id !== current.id
      || current.version !== binding.version
      || current.sessionId !== binding.sessionId
      || current.generation !== binding.generation
      || principal?.status !== 'active'
      || externalPrincipalId(current.principal) !== envelopePrincipal
      || externalPrincipalId(binding.principal) !== envelopePrincipal
      || JSON.stringify(current.conversation) !== JSON.stringify(envelope.conversation)
      || envelope.channel !== current.conversation.channel
      || envelope.account !== current.conversation.account) {
      return false
    }
    return this.policy.evaluate({
      subject: { kind: 'external', id: envelopePrincipal },
      action: 'ingest',
      resource: { kind: 'message', id: `inbound:${envelope.channel}/${envelope.account}` },
      context: { initiator: 'external' },
    }).effect === 'allow'
  }

  private isPermissionController(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean {
    if (!this.isInboundAuthorized(binding, envelope)) return false
    const principal = this.deliveryStore.getPrincipal(binding.principal)
    if (principal?.status !== 'active' || principal.role !== 'owner') return false
    // A permission mutation and its mandatory terminal reply are one control
    // operation. Prove the exact bound Agent can reply before accepting a card
    // callback or allowing the runtime to append any permission event.
    return this.policy.evaluate({
      subject: {
        kind: 'agent',
        id: binding.agentPreset,
        workspace: binding.workspace,
        principal: externalPrincipalId(binding.principal),
      },
      action: 'reply',
      resource: { kind: 'message', id: binding.id },
      context: { initiator: 'external' },
    }).effect === 'allow'
  }

  private isOwnerFeedbackController(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean {
    if (!this.isInboundAuthorized(binding, envelope)) return false
    const principal = this.deliveryStore.getPrincipal(binding.principal)
    const inbox = this.deliveryStore.getInboxByProviderEvent(
      envelope.channel,
      envelope.account,
      envelope.eventId,
    )
    if (principal?.status !== 'active' || principal.role !== 'owner'
      || inbox?.status !== 'claimed'
      || inbox.bindingId !== binding.id
      || JSON.stringify(inbox.envelope) !== JSON.stringify(envelope)) {
      return false
    }
    return this.policy.evaluate({
      subject: {
        kind: 'agent',
        id: binding.agentPreset,
        workspace: binding.workspace,
        principal: externalPrincipalId(binding.principal),
      },
      action: 'reply',
      resource: { kind: 'message', id: binding.id },
      context: { initiator: 'external' },
    }).effect === 'allow'
  }

  private ownerLineageForBinding(
    binding: Readonly<ConversationBinding>,
  ): Readonly<DeliveryOwnerLineage> | undefined {
    const principal = this.deliveryStore.getPrincipal(binding.principal)
    if (principal?.status !== 'active' || principal.role !== 'owner'
      || JSON.stringify(principal.principal) !== JSON.stringify(binding.principal)) return undefined
    return Object.freeze({
      principalRecordId: principal.id,
      principalVersion: principal.version,
    })
  }

  private authorizeOwnerPreferenceFeedback(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    selections: readonly Readonly<FeedbackSignalSelection>[],
  ): {
    occurredAt: number
    principalLineage: Readonly<DeliveryOwnerLineage>
    admissionCursor: Readonly<import('./types.js').DeliveryAdmissionCursor>
    exposureTarget?: Readonly<{ sourceInboxId: string; sourceOutboxId: string }>
  } | undefined {
    if (!this.isOwnerFeedbackController(binding, envelope)
      || !Array.isArray(selections) || selections.length < 1 || selections.length > 16) return undefined
    const inbox = this.deliveryStore.getInboxByProviderEvent(
      envelope.channel,
      envelope.account,
      envelope.eventId,
    )
    if (inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || JSON.stringify(inbox.envelope) !== JSON.stringify(envelope)) return undefined
    const principalLineage = this.ownerLineageForBinding(binding)
    if (principalLineage === undefined) return undefined
    const subject = {
      kind: 'external' as const,
      id: externalPrincipalId(binding.principal),
      workspace: binding.workspace,
    }
    const requests = selections.map(selection => ({
      selection,
      authorization: {
        subject,
        action: 'signal',
        resource: { kind: 'preference' as const, id: `${binding.agentPreset}/${selection.preferenceKey}` },
        context: { initiator: 'external' as const },
      },
    }))
    const denied = requests.find(entry => this.policy.evaluate(entry.authorization).effect !== 'allow')
    if (denied !== undefined) {
      this.policy.authorize(denied.authorization, {
        idempotencyKey: this.preferenceSignalAuthorizationKey(
          binding,
          envelope,
          denied.authorization.resource.id,
          denied.selection.candidateValue,
        ),
        auditDetails: { bindingVersion: binding.version },
      })
      return undefined
    }
    for (const { authorization, selection } of requests) {
      const decision = this.policy.authorize(authorization, {
        idempotencyKey: this.preferenceSignalAuthorizationKey(
          binding,
          envelope,
          authorization.resource.id,
          selection.candidateValue,
        ),
        auditDetails: { bindingVersion: binding.version },
      })
      if (decision.effect !== 'allow') return undefined
    }
    // Provider clocks are not authoritative. The locally persisted Inbox time
    // is bounded by the same Host clock as Preference Learning's retention gate.
    const replyTarget = envelope.metadata?.replyToProviderMessageId
    const sourceOutbox = typeof replyTarget === 'string'
      ? this.deliveryStore.getOutboxByProviderMessage(envelope.channel, envelope.account, replyTarget)
      : undefined
    const sourceEventId = sourceOutbox?.intent.replyToEventId
    const sourceInbox = sourceEventId === undefined
      ? undefined
      : this.deliveryStore.getInboxByProviderEvent(envelope.channel, envelope.account, sourceEventId)
    const exposureTarget = sourceOutbox !== undefined
      && sourceOutbox.providerMessageId === replyTarget
      && sourceOutbox.intent.bindingId === binding.id
      && sourceInbox?.status === 'processed'
      && sourceInbox.bindingId === binding.id
      && JSON.stringify(sourceOutbox.intent.target.conversation) === JSON.stringify(binding.conversation)
      && JSON.stringify(sourceOutbox.intent.target.principal) === JSON.stringify(binding.principal)
      ? Object.freeze({ sourceInboxId: sourceInbox.id, sourceOutboxId: sourceOutbox.id })
      : undefined
    return Object.freeze({
      occurredAt: inbox.receivedAt,
      principalLineage,
      admissionCursor: inbox.admissionCursor,
      ...(exposureTarget === undefined ? {} : { exposureTarget }),
    })
  }

  private preferenceSignalAuthorizationKey(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    resourceId: string,
    candidateValue: string,
  ): string {
    const digest = createHash('sha256').update('assistant-delivery-preference-authorization-v2\0')
      .update(JSON.stringify([
        binding.id,
        binding.version,
        envelope.channel,
        envelope.account,
        envelope.eventId,
        resourceId,
        candidateValue,
      ]))
      .digest('hex')
    return `delivery-pref-auth:${digest}`
  }

  private async dispatchPreferenceFeedback(
    events: readonly Readonly<DeliveryPreferenceEvent>[],
  ): Promise<'recorded' | 'unavailable' | 'unknown'> {
    this.deliveryStore.enqueuePreferenceProjection(events)
    // Preserve the Inbox admission order through the process-local sink. A
    // later owner control must not overtake an earlier projection from another
    // binding of the same owner scope.
    await this.drainPreferenceProjections()
    return 'recorded'
  }

  private async dispatchLearningCommand(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    action: DeliveryLearningControlAction,
    preferenceKey?: string,
  ): Promise<'forbidden' | 'unavailable' | 'unknown' | Readonly<DeliveryLearningControlReceipt>> {
    if (!this.isOwnerFeedbackController(binding, envelope)) return 'forbidden'
    const inbox = this.deliveryStore.getInboxByProviderEvent(
      envelope.channel,
      envelope.account,
      envelope.eventId,
    )
    if (inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || JSON.stringify(inbox.envelope) !== JSON.stringify(envelope)) return 'forbidden'
    const principalLineage = this.ownerLineageForBinding(binding)
    if (principalLineage === undefined) return 'forbidden'
    const sink = this.preferenceFeedbackSink
    if (sink === undefined
      || sink.registration.generation !== this.preferenceProducerGeneration
      || !registrationOwnedByPreference(sink.registration)
      || typeof sink.registration.control !== 'function') return 'unavailable'
    const idempotencyKey = `delivery-learning-control-v2:${createHash('sha256')
      .update('assistant-delivery-learning-control-v2\0')
      .update(JSON.stringify([
        binding.id,
        binding.version,
        binding.sessionId,
        principalLineage.principalRecordId,
        principalLineage.principalVersion,
        inbox.admissionCursor.epoch,
        inbox.admissionCursor.sequence,
        envelope.channel,
        envelope.account,
        envelope.eventId,
        action,
        preferenceKey ?? null,
      ]))
      .digest('hex')}`
    const request: Readonly<DeliveryLearningControlRequest> = Object.freeze({
      scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
      principalId: externalPrincipalId(binding.principal),
      principalLineage,
      admissionCursor: inbox.admissionCursor,
      action,
      ...(preferenceKey === undefined ? {} : { preferenceKey }),
      occurredAt: inbox.receivedAt,
      idempotencyKey,
    })
    await this.drainPreferenceProjections()
    if (this.deliveryStore.hasBlockingPreferenceProjectionBefore(request)) return 'unknown'
    try {
      const receipt = await sink.registration.control(request)
      validateLearningControlReceipt(receipt, request)
      return receipt
    } catch {
      return 'unknown'
    }
  }

  private completedPreferenceEvents(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    reply: Readonly<OutboxRecord>,
  ): readonly Readonly<DeliveryPreferenceEvent>[] | undefined {
    const directive = envelope.kind === 'text'
      ? classifyNaturalPreferenceDirective(envelope.text)
      : undefined
    const naturalSelection = directive?.kind === 'durable-exact-selection'
      ? directive.selection
      : undefined
    // A whole-message correction is an instruction, not representative task
    // language. Keep it as one explicit signal instead of double-counting the
    // language used to express the correction.
    const candidateValue = envelope.kind === 'text' && directive?.kind === 'ordinary-content'
      ? observedResponseLanguage(envelope.text)
      : undefined
    if (!this.isOwnerFeedbackController(binding, envelope)) return undefined
    const inbox = this.deliveryStore.getInboxByProviderEvent(
      envelope.channel,
      envelope.account,
      envelope.eventId,
    )
    const durableReply = this.deliveryStore.getOutbox(reply.id)
    const principalLineage = this.ownerLineageForBinding(binding)
    if (inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || principalLineage === undefined
      || durableReply?.id !== reply.id
      || durableReply.intent.bindingId !== binding.id
      || durableReply.intent.replyToEventId !== envelope.eventId
      || durableReply.intent.idempotencyKey !== this.inboundReplyIdempotencyKey(binding, envelope.eventId)
      || JSON.stringify(durableReply.intent.target.conversation) !== JSON.stringify(binding.conversation)
      || JSON.stringify(durableReply.intent.target.principal) !== JSON.stringify(binding.principal)) {
      throw new AssistantDeliveryError(
        'runtime-conflict',
        'completed preference turn does not match its durable reply',
      )
    }
    const selections: FeedbackSignalSelection[] = []
    if (naturalSelection !== undefined) selections.push(naturalSelection)
    if (candidateValue !== undefined) selections.push({
      preferenceKey: 'response.language',
      candidateValue,
      interpretationTrust: 'typed-feedback',
    })
    const authorization = selections.length === 0
      ? undefined
      : this.authorizeOwnerPreferenceFeedback(binding, envelope, selections)
    const completion = Object.freeze({
      bindingId: binding.id,
      bindingVersion: binding.version,
      sessionId: binding.sessionId,
      sourceEventId: envelope.eventId,
      sourceInboxId: inbox.id,
      replyOutboxId: durableReply.id,
    })
    const completionDigest = createHash('sha256')
      .update('assistant-delivery-completed-preference-binding-v2\0')
      .update(JSON.stringify([
        binding.id,
        binding.version,
        binding.sessionId,
        principalLineage.principalRecordId,
        principalLineage.principalVersion,
        inbox.admissionCursor.epoch,
        inbox.admissionCursor.sequence,
        inbox.id,
        durableReply.id,
        envelope.eventId,
      ]))
      .digest('hex')
    const completionEvent: DeliveryPreferenceCompletion = Object.freeze({
      scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
      principalId: externalPrincipalId(binding.principal),
      principalLineage,
      admissionCursor: inbox.admissionCursor,
      actorTrust: 'owner-authenticated',
      source: 'delivery-completion',
      occurredAt: inbox.receivedAt,
      idempotencyKey: `delivery-completed-binding-v2:${completionDigest}`,
      completion,
    })
    const events: DeliveryPreferenceEvent[] = []
    if (naturalSelection !== undefined && authorization !== undefined) {
      events.push(completionEvent)
      events.push(feedbackSignalInput(binding, envelope, naturalSelection, authorization))
    }
    if (candidateValue !== undefined && authorization !== undefined) {
      const digest = createHash('sha256')
        .update('assistant-delivery-completed-preference-turn-v2\0')
        .update(JSON.stringify([
          binding.id,
          binding.version,
          binding.sessionId,
          principalLineage.principalRecordId,
          principalLineage.principalVersion,
          inbox.admissionCursor.epoch,
          inbox.admissionCursor.sequence,
          inbox.id,
          durableReply.id,
          envelope.eventId,
          candidateValue,
        ]))
        .digest('hex')
      const event: DeliveryPreferenceObservation = Object.freeze({
        scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
        principalId: externalPrincipalId(binding.principal),
        principalLineage,
        admissionCursor: inbox.admissionCursor,
        preferenceKey: 'response.language',
        candidateValue,
        stance: 'support',
        actorTrust: 'owner-authenticated',
        interpretationTrust: 'behavioral-inference',
        source: 'delivery-observation',
        occurredAt: inbox.receivedAt,
        idempotencyKey: `delivery-completed-turn-v2:${digest}`,
        completion,
      })
      events.push(event)
    }
    if (events.length === 0) events.push(completionEvent)
    return Object.freeze(events)
  }

  private async dispatchWorkflowCommand(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    command: Extract<WorkflowCommand, { kind: 'retract' | 'save' }>,
  ): Promise<'conflict' | 'invalid-target' | 'recorded' | 'unavailable' | 'unknown'> {
    const replyTarget = envelope.metadata?.replyToProviderMessageId
    if (typeof replyTarget !== 'string' || !this.isOwnerFeedbackController(binding, envelope)) {
      return 'invalid-target'
    }
    const reviewInbox = this.deliveryStore.getInboxByProviderEvent(
      envelope.channel,
      envelope.account,
      envelope.eventId,
    )
    const sourceOutbox = this.deliveryStore.getOutboxByProviderMessage(
      envelope.channel,
      envelope.account,
      replyTarget,
    )
    const sourceEventId = sourceOutbox?.intent.replyToEventId
    const sourceInbox = sourceEventId === undefined
      ? undefined
      : this.deliveryStore.getInboxByProviderEvent(envelope.channel, envelope.account, sourceEventId)
    if (reviewInbox?.status !== 'claimed' || reviewInbox.bindingId !== binding.id
      || sourceInbox?.status !== 'processed' || sourceInbox.bindingId !== binding.id
      || sourceInbox.envelope.kind !== 'text'
      || (sourceInbox.envelope.attachments?.length ?? 0) !== 0
      || sourceOutbox === undefined || sourceOutbox.providerMessageId !== replyTarget
      || sourceOutbox.intent.bindingId !== binding.id
      || JSON.stringify(sourceInbox.envelope.conversation) !== JSON.stringify(binding.conversation)
      || JSON.stringify(sourceInbox.envelope.principal) !== JSON.stringify(binding.principal)
      || JSON.stringify(sourceOutbox.intent.target.conversation) !== JSON.stringify(binding.conversation)
      || JSON.stringify(sourceOutbox.intent.target.principal) !== JSON.stringify(binding.principal)) {
      return 'invalid-target'
    }
    const subjectRef = growthObjectDigest({
      contract: 'assistant-delivery-owner-workflow-subject/v1',
      workspace: binding.workspace,
      preset: binding.agentPreset,
      bindingId: binding.id,
      sourceInboxId: sourceInbox.id,
      sourceOutboxId: sourceOutbox.id,
    })
    const taskRef = growthObjectDigest({
      contract: 'assistant-delivery-owner-task-ref/v1',
      workspace: binding.workspace,
      preset: binding.agentPreset,
      sourceInboxId: sourceInbox.id,
    })
    const payloadDigest = growthObjectDigest({
      contract: 'assistant-delivery-owner-workflow-command/v1',
      action: command.kind === 'save' ? 'upsert' : 'retract',
      reviewInboxId: reviewInbox.id,
      sourceInboxId: sourceInbox.id,
      sourceOutboxId: sourceOutbox.id,
      subjectRef,
      ...(command.kind === 'save'
        ? { name: command.name, cron: command.cron, timezone: command.timezone }
        : {}),
    })
    try {
      this.deliveryStore.commitOwnerWorkflowTraceCommand({
        action: command.kind === 'save' ? 'upsert' : 'retract',
        operationId: `workflow-command:${reviewInbox.id}`,
        payloadDigest,
        binding,
        reviewInboxId: reviewInbox.id,
        sourceInboxId: sourceInbox.id,
        sourceOutboxId: sourceOutbox.id,
        subjectRef,
        occurredAt: sourceInbox.receivedAt,
        ...(command.kind === 'save' ? {
          taskRef,
          templateContent: {
            scope: { workspace: binding.workspace, preset: binding.agentPreset },
            ownerBindingId: binding.id,
            name: command.name,
            prompt: sourceInbox.envelope.text,
            schedule: { kind: 'cron', expression: command.cron, timezone: command.timezone },
            timeoutMs: 60_000,
            toolCatalogIds: ['assistant.agent-turn'],
            deliveryBindingId: binding.id,
          },
          steps: [{
            catalogId: 'assistant.agent-turn',
            argumentSchemaDigest: workflowArgumentShapeDigest({ prompt: sourceInbox.envelope.text }),
          }],
        } : {}),
      })
    } catch (error) {
      if (error instanceof DeliveryStoreError) {
        if (error.code === 'idempotency-conflict' || error.code === 'version-conflict') return 'conflict'
        if (error.code === 'invalid-binding' || error.code === 'unauthorized-principal'
          || error.code === 'receipt-mismatch' || error.code === 'conflict') return 'invalid-target'
      }
      return 'invalid-target'
    }
    void this.drainWorkflowTraces()
    return 'recorded'
  }

  /**
   * Convert only an authenticated reply to one exact Automation delivery into
   * a trusted objective label. The original run timestamp is retained because
   * Evolution re-proves the immutable production run; the later Inbox is a
   * separate evidence reference, never copied as prose.
   */
  private async dispatchObjectiveFeedback(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    objectiveStatus: import('./feedback-command.js').ObjectiveFeedbackStatus,
  ): Promise<'conflict' | 'invalid-target' | 'recorded' | 'unavailable' | 'unknown'> {
    const replyTarget = envelope.metadata?.replyToProviderMessageId
    if (typeof replyTarget !== 'string') return 'invalid-target'
    if (!this.isOwnerFeedbackController(binding, envelope)) return 'invalid-target'
    const inbox = this.deliveryStore.getInboxByProviderEvent(envelope.channel, envelope.account, envelope.eventId)
    const target = this.deliveryStore.getOutboxByProviderMessage(envelope.channel, envelope.account, replyTarget)
    if (inbox?.status !== 'claimed' || inbox.bindingId !== binding.id
      || target === undefined || target.providerMessageId !== replyTarget
      || target.intent.bindingId !== binding.id
      || JSON.stringify(target.intent.target.conversation) !== JSON.stringify(binding.conversation)
      || JSON.stringify(target.intent.target.principal) !== JSON.stringify(binding.principal)) {
      return 'invalid-target'
    }
    const metadata = target.intent.metadata
    // Ordinary Agent replies have no learning metadata.  They are eligible
    // only for Delivery's local, atomic verified-workflow receipt; the Store
    // rebuilds the full Inbox/Outbox fence and abstains unless the source text
    // selects a closed deterministic-deidentification template.  Do not route
    // these judgements through Evaluation: they are task proof for workflow
    // repetition, not a cross-plugin quality vote.
    if (metadata?.['dsh.learning.kind'] !== 'automation-run') {
      const sourceEventId = target.intent.replyToEventId
      if (typeof sourceEventId !== 'string') return 'invalid-target'
      const sourceInbox = this.deliveryStore.getInboxByProviderEvent(
        envelope.channel,
        envelope.account,
        sourceEventId,
      )
      if (sourceInbox === undefined) return 'invalid-target'
      try {
        const recorded = this.deliveryStore.commitVerifiedWorkflowTraceFeedback({
          binding,
          feedbackInboxId: inbox.id,
          sourceInboxId: sourceInbox.id,
          sourceOutboxId: target.id,
          objectiveStatus,
        })
        if (recorded.outcome === 'trace-recorded') void this.drainWorkflowTraces()
        return 'recorded'
      } catch (error) {
        if (error instanceof DeliveryStoreError) {
          if (error.code === 'idempotency-conflict' || error.code === 'version-conflict') {
            return 'conflict'
          }
          if (error.code === 'invalid-binding' || error.code === 'unauthorized-principal'
            || error.code === 'receipt-mismatch' || error.code === 'conflict'
            || error.code === 'not-found') return 'invalid-target'
        }
        return 'invalid-target'
      }
    }
    const automationId = metadata?.['dsh.learning.automationId']
    const runId = metadata?.['dsh.learning.runId']
    const situation = metadata?.['dsh.learning.situation']
    const occurredAtText = metadata?.['dsh.learning.occurredAt']
    const outputDigest = metadata?.['dsh.learning.outputDigest']
    const proofDigest = metadata?.['dsh.learning.proofDigest']
    if (metadata?.['dsh.learning.schemaVersion'] !== '2'
      || metadata['dsh.learning.kind'] !== 'automation-run'
      || metadata['dsh.learning.executionStatus'] !== 'succeeded'
      || typeof automationId !== 'string' || typeof runId !== 'string'
      || typeof situation !== 'string' || situation !== `automation:${automationId}`
      || typeof outputDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(outputDigest)
      || typeof proofDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(proofDigest)
      || typeof occurredAtText !== 'string' || !/^(0|[1-9][0-9]{0,15})$/u.test(occurredAtText)) {
      return 'invalid-target'
    }
    const occurredAt = Number(occurredAtText)
    if (!Number.isSafeInteger(occurredAt) || occurredAt > inbox.receivedAt) return 'invalid-target'
    if (!target.intent.text.endsWith(automationObjectiveFeedbackFooter)) return 'invalid-target'
    const outputPreview = target.intent.text.slice(0, -automationObjectiveFeedbackFooter.length)
    if (createHash('sha256').update(outputPreview).digest('hex') !== outputDigest) return 'invalid-target'
    const resolver = this.context.get('assistantAutomations')
    if (!isAutomationDeliveryEvidenceResolver(resolver)) return 'unavailable'
    let proof: ReturnType<AutomationDeliveryEvidenceResolver['resolveDeliveryEvidence']>
    try {
      proof = resolver.resolveDeliveryEvidence({
        automationId,
        runId,
        expectedWorkspace: binding.workspace,
        expectedBindingId: binding.id,
        expectedOutputDigest: outputDigest,
      })
    } catch {
      return 'invalid-target'
    }
    if (proof === undefined || proof.schemaVersion !== 1 || proof.source !== 'assistant-automations'
      || proof.executionKind !== 'agent' || proof.executionStatus !== 'succeeded'
      || proof.automationId !== automationId || proof.runId !== runId
      || proof.workspace !== binding.workspace || proof.agentPreset !== binding.agentPreset
      || proof.bindingId !== binding.id || proof.situation !== situation
      || proof.occurredAt !== occurredAt || proof.outputDigest !== outputDigest
      || proof.proofDigest !== proofDigest) return 'invalid-target'
    const sink = this.evaluationSink
    if (sink === undefined) return 'unavailable'
    // One immutable Automation run is one learning subject. The objective
    // status and Inbox event deliberately do not enter the key: replays and
    // repeated equal judgements collapse, while an opposite judgement becomes
    // an explicit conflict instead of a second Evolution vote.
    const digest = createHash('sha256').update('assistant-delivery-objective-feedback-v2\0')
      .update(JSON.stringify([binding.workspace, binding.agentPreset, target.id, runId]))
      .digest('hex')
    const claims: TrustedDeliveryEvaluationClaims = Object.freeze({
      scope: Object.freeze({ workspace: binding.workspace, preset: binding.agentPreset }),
      situation,
      objectiveStatus,
      runId,
      outboxId: target.id,
      chatId: binding.conversation.chat,
      principalId: externalPrincipalId(binding.principal),
      bindingId: binding.id,
      occurredAt,
      idempotencyKey: `assistant-delivery:objective-feedback-v2:${digest}`,
    })
    try {
      const capabilityReceipt = sink.registration.issueCapability(claims)
      if (this.evaluationSink?.token !== sink.token) return 'unknown'
      const receipt = await Promise.resolve(sink.registration.append({
        capabilityReceipt,
        runId,
        outboxId: target.id,
        chatId: binding.conversation.chat,
        principalId: externalPrincipalId(binding.principal),
        bindingId: binding.id,
        idempotencyKey: claims.idempotencyKey,
      }))
      if (typeof receipt !== 'object' || receipt === null
        || (receipt as Partial<{ idempotencyKey: string }>).idempotencyKey !== claims.idempotencyKey) {
        return 'unknown'
      }
      return 'recorded'
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === 'idempotency-conflict') return 'conflict'
      return 'unknown'
    }
  }

  private authorizePermissionReply(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
  ): boolean {
    if (!this.isPermissionController(binding, envelope)) return false
    const decision = this.policy.authorize({
      subject: {
        kind: 'agent',
        id: binding.agentPreset,
        workspace: binding.workspace,
        principal: externalPrincipalId(binding.principal),
      },
      action: 'reply',
      resource: { kind: 'message', id: binding.id },
      context: { initiator: 'external' },
    }, { idempotencyKey: `message-reply:${this.inboundReplyIdempotencyKey(binding, envelope.eventId)}` })
    return decision.effect === 'allow' && this.isPermissionController(binding, envelope)
  }

  /**
   * Provider event ids are scoped to an adapter account, while Outbox and the
   * Policy ledger share one database-wide idempotency namespace. Anchor every
   * command reply to the accepted Inbox row, whose id is stable across reopen.
   */
  private inboundReplyIdempotencyKey(
    binding: Readonly<ConversationBinding>,
    eventId: string,
  ): string {
    const inbox = this.deliveryStore.getInboxByProviderEvent(
      binding.conversation.channel,
      binding.conversation.account,
      eventId,
    )
    if (inbox === undefined
      || (inbox.bindingId !== undefined && inbox.bindingId !== binding.id)
      || externalPrincipalId(inbox.envelope.principal) !== externalPrincipalId(binding.principal)
      || JSON.stringify(inbox.envelope.conversation) !== JSON.stringify(binding.conversation)) {
      throw new AssistantDeliveryError(
        'missing-binding',
        'control reply does not belong to a durable Inbox on the active binding',
      )
    }
    return `inbound:${inbox.id}:reply`
  }

  private hasActivePrincipal(binding: Readonly<ConversationBinding>): boolean {
    return this.deliveryStore.getPrincipal(binding.principal)?.status === 'active'
  }

  private toolApprovalRoute(agent: Agent): ToolApprovalRoute {
    const direct = this.deliveryStore.getBindingBySession(String(agent.session.id))
    const delegatedEntry = this.agentApprovalBindings.get(agent)
    const delegated = delegatedEntry === undefined
      ? undefined
      : this.deliveryStore.getBinding(delegatedEntry.bindingId)
    if (direct === undefined && delegatedEntry === undefined) return { state: 'none' }
    if ((delegatedEntry !== undefined && delegated === undefined)
      || (direct !== undefined && delegated !== undefined && direct.id !== delegated.id)) {
      return { state: 'invalid' }
    }
    const binding = direct ?? delegated
    if (binding?.status !== 'active') return { state: 'invalid' }
    return direct === undefined
      ? { state: 'bound', binding, kind: 'delegated', token: delegatedEntry!.token }
      : { state: 'bound', binding, kind: 'direct' }
  }

  private resolveToolApprovalAuthority(ctx: Context, request: Readonly<ApprovalRequest>): ToolApprovalAuthority | undefined {
    if (!this.active || request.callId === undefined) return undefined
    const emergencyStop = this.policy.getEmergencyStop()
    if (emergencyStop.enabled) return undefined
    const agents = ctx.get('agents')
    const sessions = ctx.get('sessions')
    const agent = request.agent
    const events = agent.session.events
    const reviewer = approvalReviewerOf(events)
    const reviewRoute = reviewer === 'user'
      ? 'user'
      : reviewer === 'auto-review' && isAutoReviewEscalation(request)
        ? 'auto-escalation'
        : undefined
    const sessionId = String(agent.session.id)
    const route = this.toolApprovalRoute(agent)
    if (route.state !== 'bound') return undefined
    const { binding } = route
    if (agents === undefined || sessions === undefined
      || String(agent.id) !== sessionId
      || agents.get(agent.id) !== agent
      || sessions.get(agent.id) !== agent.session
      || (route.kind === 'direct' && binding.sessionId !== sessionId)
      || agent.session.header.cwd !== binding.workspace
      || agent.session.header.agentPreset !== binding.agentPreset
      || binding.conversation.kind !== 'dm'
      || reviewRoute === undefined) {
      return undefined
    }
    const active = this.deliveryStore.getActiveBinding(binding.conversation)
    const owner = this.deliveryStore.getPrincipal(binding.principal)
    if (active?.id !== binding.id || active.version !== binding.version
      || active.sessionId !== binding.sessionId || active.generation !== binding.generation
      || JSON.stringify(active.principal) !== JSON.stringify(binding.principal)
      || JSON.stringify(active.conversation) !== JSON.stringify(binding.conversation)
      || owner?.status !== 'active' || owner.role !== 'owner'
      || JSON.stringify(owner.principal) !== JSON.stringify(binding.principal)) {
      return undefined
    }
    const callId = String(request.callId)
    if (Buffer.byteLength(callId) > toolApprovalIdentityBytes
      || Buffer.byteLength(request.toolName) > toolApprovalIdentityBytes
      || (request.reason !== undefined && Buffer.byteLength(request.reason) > toolApprovalReasonBytes)) {
      return undefined
    }
    const openTurn = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
    if (openTurn?.type !== 'turn/start') return undefined
    const call = exactToolApprovalCall(events, openTurn, callId, request.toolName)
    if (call === undefined) return undefined
    const decided = new Set(events.filter(event => event.type === 'approval/decided')
      .map(event => String(event.data.id)))
    const asked = events.filter((event): event is SessionEvent<'approval/asked'> => event.type === 'approval/asked'
      && event.seq > call.seq
      && event.seq > openTurn.seq
      && event.data.toolName === request.toolName
      && event.data.callId !== undefined
      && String(event.data.callId) === callId
      && event.data.reason === request.reason
      && !decided.has(String(event.data.id)))
    if (asked.length !== 1) return undefined
    const ask = asked[0]!
    const requestHeader = events.findLast(event => event.type === 'request/header')
    const adapter = this.registry.get(binding.conversation.channel, binding.conversation.account)
    if (adapter?.capabilities.toolApprovals !== true || adapter.requestToolApproval === undefined) return undefined
    const header = agent.session.header
    const actionHash = createHash('sha256').update(JSON.stringify([
      'assistant-delivery/tool-approval',
      3,
      ['binding', binding.id, binding.version, binding.generation, binding.sessionId,
        binding.workspace, binding.agentPreset, binding.policyRef,
        [binding.conversation.channel, binding.conversation.account, binding.conversation.tenant,
          binding.conversation.kind, binding.conversation.chat, binding.conversation.thread ?? null],
        [binding.principal.channel, binding.principal.account, binding.principal.tenant, binding.principal.user]],
      ['owner', owner.id, owner.version, owner.role, owner.status, owner.linkedToId ?? null,
        [owner.principal.channel, owner.principal.account, owner.principal.tenant, owner.principal.user]],
      ['session', header.version, sessionId, header.createdAt, header.cwd ?? null,
        header.parentSession ?? null, header.seedLength ?? null, header.origin ?? null,
        header.delegationDepth ?? null, header.agentPreset ?? null],
      ['route-kind', route.kind],
      ['review-route', reviewRoute],
      ['turn', openTurn.seq, openTurn.data.turn],
      ['call', ...call.hashIdentity],
      ['ask', ask.seq, String(ask.data.id), ask.data.toolName, String(ask.data.callId), ask.data.reason ?? null],
      ['request-route', requestHeader === undefined ? null : [requestHeader.seq,
        requestHeader.data.header.config.provider, requestHeader.data.header.config.model,
        requestHeader.data.header.config.reasoningEffort ?? null]],
      ['reviewer', reviewer],
      ['policy-emergency-stop', emergencyStop.version, emergencyStop.enabled],
      ['permission-events', currentPermissionEvents(agent)],
    ])).digest('hex')
    return { adapter, binding, reviewRoute, routeKind: route.kind,
      ...(route.token === undefined ? {} : { routeToken: route.token }),
      policyEmergencyVersion: emergencyStop.version,
      actionHash, arguments: call.arguments, callId }
  }

  private async requestToolApproval(
    ctx: Context,
    request: Readonly<ApprovalRequest>,
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    let initialRoute: ToolApprovalRoute
    try {
      initialRoute = this.toolApprovalRoute(request.agent)
    } catch {
      return 'unavailable'
    }
    if (initialRoute.state === 'none') return next()
    let reviewer: ApprovalReviewer
    try {
      reviewer = approvalReviewerOf(request.agent.session.events)
    } catch {
      return 'unavailable'
    }
    const reviewRoute = reviewer === 'user'
      ? 'user'
      : reviewer === 'auto-review' && isAutoReviewEscalation(request)
        ? 'auto-escalation'
        : undefined
    if (reviewRoute === undefined) return reviewer === 'auto-review' ? next() : 'unavailable'
    if (initialRoute.state !== 'bound') return 'unavailable'
    if (signalAborted(request.signal)) return 'cancelled'
    let authority: ToolApprovalAuthority | undefined
    try {
      authority = this.resolveToolApprovalAuthority(ctx, request)
    } catch {
      return 'unavailable'
    }
    if (authority === undefined || authority.binding.id !== initialRoute.binding.id) return 'unavailable'
    const sessions = ctx.get('sessions')
    if (sessions === undefined) return 'unavailable'
    try {
      if (!await sessions.flush(request.agent.session)) return 'unavailable'
    } catch {
      return 'unavailable'
    }
    if (signalAborted(request.signal)) return 'cancelled'
    let persisted: ToolApprovalAuthority | undefined
    try {
      persisted = this.resolveToolApprovalAuthority(ctx, request)
    } catch {
      return 'unavailable'
    }
    if (!sameToolApprovalAuthority(authority, persisted)) return 'unavailable'

    const operationId = `tool-approval:${randomUUID()}`
    const expiresAt = Date.now() + this.config.toolApprovalTtlMs
    const controller = new AbortController()
    let requestCancelled = false
    const onRequestAbort = () => {
      requestCancelled = true
      controller.abort(request.signal?.reason)
    }
    request.signal?.addEventListener('abort', onRequestAbort, { once: true })
    const aborted = new Promise<ApprovalOutcome>(resolve => {
      controller.signal.addEventListener('abort', () => {
        resolve(requestCancelled ? 'cancelled' : 'unavailable')
      }, { once: true })
    })
    const timeout = setTimeout(() => {
      controller.abort(new Error('assistant-delivery tool approval timed out'))
    }, this.config.toolApprovalTtlMs)
    timeout.unref?.()
    this.toolApprovalControllers.add(controller)
    const adapterRequest: DeliveryToolApprovalRequest = Object.freeze({
      operationId,
      bindingId: authority.binding.id,
      target: Object.freeze({
        conversation: Object.freeze({ ...authority.binding.conversation }),
        principal: Object.freeze({ ...authority.binding.principal }),
      }),
      expiresAt,
      actionHash: authority.actionHash,
      toolName: request.toolName,
      callId: authority.callId,
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      arguments: authority.arguments,
    })
    let outcome: ApprovalOutcome
    try {
      const answer = Promise.resolve()
        .then(() => authority!.adapter.requestToolApproval!(adapterRequest, controller.signal))
        .then<ApprovalOutcome, ApprovalOutcome>(value => value, () => 'unavailable')
      outcome = await Promise.race([answer, aborted])
    } finally {
      clearTimeout(timeout)
      request.signal?.removeEventListener('abort', onRequestAbort)
      this.toolApprovalControllers.delete(controller)
    }
    if (signalAborted(request.signal)) return 'cancelled'
    if (controller.signal.aborted || !this.active || Date.now() >= expiresAt) return 'unavailable'
    let current: ToolApprovalAuthority | undefined
    try {
      current = this.resolveToolApprovalAuthority(ctx, request)
    } catch {
      return 'unavailable'
    }
    if (current === undefined || !sameToolApprovalAuthority(authority, current)) return 'unavailable'
    if (outcome === 'allowed-once') {
      try {
        // The tool guard ran before the native tool raised this approval. Do not
        // consume its budget a second time, but do re-check the mutable hard stop
        // as close as possible to releasing the owner's one-shot grant.
        const emergencyStop = this.policy.getEmergencyStop()
        // The owner granted this call; a later hard-stop is a Policy veto, not
        // a user rejection. `rejected` is reserved for the signed reject action
        // because upstream otherwise renders the false claim "the user rejected".
        if (emergencyStop.enabled) return 'unavailable'
        if (emergencyStop.version !== current.policyEmergencyVersion) return 'unavailable'
      } catch {
        return 'unavailable'
      }
    }
    return (approvalOutcomes as readonly unknown[]).includes(outcome) ? outcome : 'unavailable'
  }

  async acceptInbound(envelope: InboundEnvelope): Promise<{
    duplicate: boolean
    inboxId: string
    status: InboxRecord['status']
  }> {
    this.assertActive()
    const accepted = this.deliveryStore.acceptInbound(envelope)
    let record = accepted.record
    if (!['received', 'authorized'].includes(record.status)) {
      return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
    }
    if (!this.deliveryStore.isAuthorizedPrincipal(envelope.principal)) {
      record = this.deliveryStore.deadLetterInbox(record.id, 'unauthorized-principal')
      return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
    }
    const decision = this.policy.authorize({ subject: { kind: 'external', id: externalPrincipalId(envelope.principal) },
      action: 'ingest', resource: { kind: 'message', id: `inbound:${envelope.channel}/${envelope.account}` },
      context: { initiator: 'external' } }, { idempotencyKey: `message-inbound:${record.id}` })
    if (decision.effect !== 'allow') {
      record = this.deliveryStore.deadLetterInbox(record.id, `policy-${decision.reasonCode}`)
      return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
    }
    const sessionCommand = parseDeliveryCommand(envelope)
    if (isExactDeliveryCommand(sessionCommand, 'new', 'clear')) {
      return await this.runConversationTransition(envelope.conversation, async () => {
        await this.recoverPendingInbound(envelope, record.id)
        // A provider retry can arrive while the first copy is waiting for the
        // old generation to drain. Re-read after acquiring the transition:
        // once that copy queued the command, its rotation is already complete
        // and this duplicate must not create yet another generation.
        const currentRecord = this.deliveryStore.getInbox(record.id)!
        if (!['received', 'authorized'].includes(currentRecord.status)) {
          return {
            duplicate: accepted.duplicate,
            inboxId: currentRecord.id,
            status: currentRecord.status,
          }
        }
        record = currentRecord
        const binding = await this.bindingForInbound(envelope, record.id)
        if (binding === undefined) {
          const failed = this.deliveryStore.getInbox(record.id)!
          return { duplicate: accepted.duplicate, inboxId: failed.id, status: failed.status }
        }
        // First invalidate all old work that cannot have crossed the Agent
        // dispatch gate. Then cancel and drain any turn that did cross it.
        // Rotation is last, so no fresh generation can execute beside the old.
        const fence = this.deliveryStore.cancelUndispatchedInboxBefore({
          bindingId: binding.id,
          beforeInboxId: record.id,
          failureCode: 'new-session-before-dispatch',
        })
        await this.runtime?.cancelActive?.(binding, 'new')
        await this.inbound.cancelUndispatchedClaims(fence.claimedInboxIds, 'new')
        const rotated = await this.rotateBinding(envelope, binding, record.id)
        record = this.deliveryStore.getInbox(record.id)!
        if (record.status !== 'queued' || record.bindingId !== rotated.id) {
          throw new AssistantDeliveryError(
            'runtime-conflict',
            'new-session binding committed without its command Inbox',
          )
        }
        return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
      })
    }
    if (isExactDeliveryCommand(sessionCommand, 'stop')) {
      return await this.runConversationTransition(envelope.conversation, async () => {
        await this.recoverPendingInbound(envelope, record.id)
        const currentRecord = this.deliveryStore.getInbox(record.id)!
        if (!['received', 'authorized'].includes(currentRecord.status)) {
          return {
            duplicate: accepted.duplicate,
            inboxId: currentRecord.id,
            status: currentRecord.status,
          }
        }
        record = currentRecord
        const binding = await this.bindingForInbound(envelope, record.id)
        if (binding === undefined) {
          const failed = this.deliveryStore.getInbox(record.id)!
          return { duplicate: accepted.duplicate, inboxId: failed.id, status: failed.status }
        }
        const fence = this.deliveryStore.cancelUndispatchedInboxBefore({
          bindingId: binding.id,
          beforeInboxId: record.id,
          failureCode: 'user-stopped-before-dispatch',
        })
        // Holding the transition while the live turn drains prevents a later
        // message from overtaking the durable stop acknowledgement.
        await this.runtime?.cancelActive?.(binding, 'stop')
        await this.inbound.cancelUndispatchedClaims(fence.claimedInboxIds, 'stop')
        record = this.deliveryStore.queueInbox(record.id, binding.id)
        return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
      })
    }

    // All accept-side binding decisions join this short conversation lock.
    // It serializes only durable admission (not Agent execution), and makes a
    // queued `/stop` or `/new` an unambiguous boundary for later arrivals.
    return await this.runConversationTransition(envelope.conversation, async () => {
      await this.recoverPendingInbound(envelope, record.id)
      const currentRecord = this.deliveryStore.getInbox(record.id)!
      if (!['received', 'authorized'].includes(currentRecord.status)) {
        return {
          duplicate: accepted.duplicate,
          inboxId: currentRecord.id,
          status: currentRecord.status,
        }
      }
      record = currentRecord
      const binding = await this.bindingForInbound(envelope, record.id)
      if (binding === undefined) {
        const failed = this.deliveryStore.getInbox(record.id)!
        return { duplicate: accepted.duplicate, inboxId: failed.id, status: failed.status }
      }
      record = this.deliveryStore.queueInbox(record.id, binding.id)
      return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
    })
  }

  enqueueBackground(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
    metadata?: Readonly<Record<string, string>>
  }): OutboxRecord {
    this.assertActive()
    if (containsReservedLearningMetadata(input.metadata)) {
      throw new AssistantDeliveryError(
        'runtime-conflict',
        'reserved learning metadata requires the typed Automation result seam',
      )
    }
    const binding = this.deliveryStore.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active' || !this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'delivery binding does not exist or is revoked')
    }
    if (binding.workspace !== input.workspace) {
      throw new AssistantDeliveryError('missing-binding', 'delivery workspace does not match the active binding')
    }
    const decision = this.policy.authorize({ subject: { kind: 'background', id: input.sourceId,
      workspace: input.workspace, principal: externalPrincipalId(binding.principal) }, action: 'send',
    resource: { kind: 'message', id: binding.id }, context: { initiator: 'background' } },
    { idempotencyKey: `message-send:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    if (!this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'delivery binding principal is no longer active')
    }
    return this.deliveryStore.enqueue({ idempotencyKey: input.idempotencyKey, bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal }, text: input.text,
      format: input.format ?? 'plain',
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }) })
  }

  /**
   * Dedicated Automation result lane. Every learning field is derived from an
   * authoritative Automations receipt; callers cannot supply metadata,
   * idempotency, source identity, occurrence, timestamp, or feedback text.
   */
  enqueueAutomationResult(input: {
    automationId: string
    runId: string
    workspace: string
    bindingId: string
    outputPreview: string
  }): OutboxRecord {
    this.assertActive()
    if (typeof input.outputPreview !== 'string') {
      throw new AssistantDeliveryError('runtime-conflict', 'Automation result output is invalid')
    }
    const outputDigest = createHash('sha256').update(input.outputPreview).digest('hex')
    const resolver = this.context.get('assistantAutomations')
    if (!isAutomationDeliveryEvidenceResolver(resolver)) {
      throw new AssistantDeliveryError('runtime-conflict', 'Automation delivery evidence is unavailable')
    }
    let proof: ReturnType<AutomationDeliveryEvidenceResolver['resolveDeliveryEvidence']>
    try {
      proof = resolver.resolveDeliveryEvidence({
        automationId: input.automationId,
        runId: input.runId,
        expectedWorkspace: input.workspace,
        expectedBindingId: input.bindingId,
        expectedOutputDigest: outputDigest,
      })
    } catch {
      throw new AssistantDeliveryError('runtime-conflict', 'Automation delivery evidence was rejected')
    }
    if (proof === undefined || proof.schemaVersion !== 1 || proof.source !== 'assistant-automations'
      || proof.executionKind !== 'agent' || proof.executionStatus !== 'succeeded'
      || proof.automationId !== input.automationId || proof.runId !== input.runId
      || proof.workspace !== input.workspace || proof.bindingId !== input.bindingId
      || proof.situation !== `automation:${input.automationId}`
      || proof.outputDigest !== outputDigest || !/^[a-f0-9]{64}$/u.test(proof.proofDigest)
      || !Number.isSafeInteger(proof.occurredAt) || proof.occurredAt < 0) {
      throw new AssistantDeliveryError('runtime-conflict', 'Automation delivery evidence is mismatched')
    }
    const binding = this.deliveryStore.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active' || !this.hasActivePrincipal(binding)
      || binding.workspace !== input.workspace || binding.agentPreset !== proof.agentPreset) {
      throw new AssistantDeliveryError('missing-binding', 'Automation result binding is unavailable or mismatched')
    }
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: proof.automationId,
        workspace: proof.workspace, principal: externalPrincipalId(binding.principal) },
      action: 'send', resource: { kind: 'message', id: binding.id }, context: { initiator: 'background' },
    }, { idempotencyKey: `message-send:automation:${proof.occurrenceId}:${binding.id}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    if (!this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'delivery binding principal is no longer active')
    }
    const text = `${input.outputPreview}${automationObjectiveFeedbackFooter}`
    if (Buffer.byteLength(text, 'utf8') > this.config.maxTextBytes) {
      throw new AssistantDeliveryError('runtime-conflict', 'Automation result exceeds the delivery text limit')
    }
    return this.deliveryStore.enqueue({
      idempotencyKey: `automation:${proof.occurrenceId}:${binding.id}`,
      bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal },
      text,
      format: 'markdown',
      metadata: Object.freeze({
        'dsh.learning.schemaVersion': '2',
        'dsh.learning.kind': 'automation-run',
        'dsh.learning.automationId': proof.automationId,
        'dsh.learning.runId': proof.runId,
        'dsh.learning.situation': proof.situation,
        'dsh.learning.occurredAt': String(proof.occurredAt),
        'dsh.learning.executionStatus': proof.executionStatus,
        'dsh.learning.outputDigest': proof.outputDigest,
        'dsh.learning.proofDigest': proof.proofDigest,
      }),
    })
  }

  /** Resolve the current generation of one exact Host-owned owner route. */
  resolveOwnerRoute(authorityIdInput: string): ResolvedOwnerRoute {
    this.assertActive()
    const authorityId = canonicalOwnerRouteId(authorityIdInput)
    const authority = this.ownerRoutes.get(authorityId)
    if (authority === undefined) {
      throw new AssistantDeliveryError('missing-binding', 'owner route authority is not configured')
    }
    const binding = this.deliveryStore.getActiveBinding(authority.conversation)
    const owner = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
    if (binding === undefined || binding.status !== 'active'
      || !bindingMatchesOwnerRoute(binding, authority)
      || owner?.status !== 'active' || owner.role !== 'owner') {
      throw new AssistantDeliveryError('missing-binding', 'active binding does not match owner route authority')
    }
    return {
      authorityId,
      binding,
      snapshot: ownerRouteBindingSnapshot(authority, binding),
    }
  }

  /**
   * Revalidate Recovery/other Host work against the live owner route without
   * exposing a session id, conversation id, user message or delivery content.
   */
  validateOwnerRoute(input: {
    authorityId: string
    principalId: string
    workspace: string
    agentPreset: string
  }): Readonly<OwnerRouteValidationReceipt> {
    this.assertActive()
    const resolved = this.resolveOwnerRoute(input.authorityId)
    const authority = this.ownerRoutes.get(resolved.authorityId)!
    const principalLineage = this.ownerLineageForBinding(resolved.binding)
    if (principalLineage === undefined) {
      throw new AssistantDeliveryError('missing-binding', 'owner route principal lineage is unavailable')
    }
    const expectedPrincipal = externalPrincipalId(authority.principal)
    const text = (value: unknown, label: string, maxBytes: number): string => {
      if (typeof value !== 'string') {
        throw new AssistantDeliveryError('missing-binding', `owner route ${label} is invalid`)
      }
      const normalized = value.normalize('NFC').trim()
      const hasControl = [...normalized].some(character => {
        const point = character.codePointAt(0)!
        return point <= 0x1f || point === 0x7f
      })
      if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes || hasControl) {
        throw new AssistantDeliveryError('missing-binding', `owner route ${label} is invalid`)
      }
      return normalized
    }
    const principalId = text(input.principalId, 'principal', 1_024)
    const workspace = text(input.workspace, 'workspace', 4_096)
    const agentPreset = text(input.agentPreset, 'preset', 200)
    if (principalId !== expectedPrincipal || workspace !== authority.workspace
      || agentPreset !== authority.agentPreset) {
      throw new AssistantDeliveryError('missing-binding', 'owner route authority does not match the requested scope')
    }
    return Object.freeze({
      receiptVersion: 2 as const,
      authorityId: resolved.authorityId,
      authorityHash: resolved.snapshot.authorityHash,
      principalId,
      principalRecordId: principalLineage.principalRecordId,
      principalVersion: principalLineage.principalVersion,
      workspace,
      agentPreset,
      bindingVersion: resolved.snapshot.bindingVersion,
      generation: resolved.snapshot.generation,
    })
  }

  /**
   * Enqueue against a stable Host-owned route rather than a session binding.
   * Policy is evaluated against the exact `route:<authorityId>` resource. The
   * Store re-resolves under its write transaction, so a concurrent `/new`
   * either wins completely or follows the earlier immutable Outbox receipt.
   */
  enqueueBackgroundRoute(input: {
    sourceId: string
    authorityId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
  }): OutboxRecord {
    this.assertActive()
    const sourceId = canonicalBackgroundSourceId(input.sourceId)
    const idempotencyKey = canonicalRouteIdempotencyKey(input.idempotencyKey)
    if (typeof input.text !== 'string' || Buffer.byteLength(input.text, 'utf8') > this.config.maxTextBytes
      || (input.format !== undefined && input.format !== 'markdown' && input.format !== 'plain')) {
      throw new AssistantDeliveryError('runtime-conflict', 'owner route message is invalid')
    }
    const resolved = this.resolveOwnerRoute(input.authorityId)
    const authority = this.ownerRoutes.get(resolved.authorityId)!
    const decision = authorizeOwnerRoute(this.policy, authority, sourceId, idempotencyKey)
    if (decision.effect !== 'allow') throw policyDenied(decision)
    try {
      return this.deliveryStore.enqueueOwnerRoute({
        authority,
        sourceId,
        sourceHash: createHash('sha256').update(sourceId).digest('hex'),
        idempotencyKey,
        text: input.text,
        format: input.format ?? 'plain',
      })
    } catch (error) {
      if (error instanceof DeliveryStoreError && error.code === 'invalid-binding') {
        throw new AssistantDeliveryError('missing-binding', 'owner route changed during enqueue')
      }
      throw error
    }
  }

  enqueueApproval(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    approval: NonNullable<import('./types.js').OutboundIntent['approval']>
  }): OutboxRecord {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active') {
      throw new AssistantDeliveryError('missing-binding', 'delivery binding does not exist or is revoked')
    }
    if (binding.workspace !== input.workspace) {
      throw new AssistantDeliveryError('missing-binding', 'delivery workspace does not match the active binding')
    }
    const owner = this.deliveryStore.getPrincipal(binding.principal)
    const principal = externalPrincipalId(binding.principal)
    const proposal = this.policy.getProposal(input.approval.proposalId)
    if (owner?.status !== 'active' || owner.role !== 'owner'
      || proposal === undefined || proposal.status !== 'pending' || Date.now() >= proposal.expiresAt
      || proposal.principal !== principal
      || proposal.version !== input.approval.expectedVersion
      || proposal.expiresAt !== input.approval.expiresAt
      || proposal.summary !== input.approval.title
      || proposal.diffHash !== input.approval.diffHash
      || createHash('sha256').update(input.text).digest('hex') !== proposal.diffHash) {
      throw new AssistantDeliveryError('missing-binding', 'approval card does not match its active owner and Policy proposal')
    }
    const decision = this.policy.authorize({ subject: { kind: 'background', id: input.sourceId,
      workspace: input.workspace, principal }, action: 'approval.send',
    resource: { kind: 'message', id: binding.id }, context: { initiator: 'background' } },
    { idempotencyKey: `message-approval:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.enqueue({ idempotencyKey: input.idempotencyKey, bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal }, text: input.text,
      format: 'approval', approval: input.approval })
  }

  private replyCommand(bindingInput: Readonly<ConversationBinding>, input: {
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
    modelPicker?: ModelPickerIntent
    permissionPicker?: PermissionPickerIntent
    replyToEventId: string
  }): OutboxRecord {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(bindingInput.id)
    if (binding === undefined || binding.status !== 'active' || binding.sessionId !== bindingInput.sessionId
      || !this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'control command binding does not exist or is no longer active')
    }
    const legacyInboundKey = `inbound:${input.replyToEventId}:reply`
    const idempotencyKey = input.idempotencyKey === legacyInboundKey
      ? this.inboundReplyIdempotencyKey(binding, input.replyToEventId)
      : input.idempotencyKey
    const decision = this.policy.authorize({
      subject: {
        kind: 'agent',
        id: binding.agentPreset,
        workspace: binding.workspace,
        principal: externalPrincipalId(binding.principal),
      },
      action: 'reply',
      resource: { kind: 'message', id: binding.id },
      context: { initiator: 'external' },
    }, { idempotencyKey: `message-reply:${idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    if (!this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'control command binding principal is no longer active')
    }
    const format = this.replyFormat(binding.conversation, input.format) ?? 'plain'
    return this.deliveryStore.enqueue({
      idempotencyKey,
      bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal },
      text: input.text,
      format,
      ...(input.modelPicker === undefined ? {} : { modelPicker: input.modelPicker }),
      ...(format !== 'permission-picker' || input.permissionPicker === undefined
        ? {}
        : { permissionPicker: input.permissionPicker }),
      replyToEventId: input.replyToEventId,
    })
  }

  /**
   * Answers are authored as Markdown, but the coordinator drops an intent whose format the adapter
   * does not declare (`unsupported-format`). Ask for Markdown only where the channel renders it and
   * degrade to plain text elsewhere, so a reply is never lost to a capability mismatch.
   */
  private replyFormat(
    conversation: Readonly<ConversationRef>,
    requested: 'markdown' | 'model-picker' | 'permission-picker' | 'plain' | undefined,
  ): 'markdown' | 'model-picker' | 'permission-picker' | 'plain' | undefined {
    if (requested === 'permission-picker') {
      const adapter = this.registry.get(conversation.channel, conversation.account)
      return adapter?.capabilities.formats.includes('permission-picker') === true ? requested : 'plain'
    }
    if (requested !== 'markdown') return requested
    const adapter = this.registry.get(conversation.channel, conversation.account)
    return adapter?.capabilities.formats.includes('markdown') === true ? 'markdown' : 'plain'
  }

  reply(agent: Agent | undefined, input: {
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
    modelPicker?: ModelPickerIntent
    permissionPicker?: PermissionPickerIntent
    replyToEventId?: string
  }): OutboxRecord {
    const prepared = this.prepareAgentReply(agent, input)
    return this.deliveryStore.enqueue(prepared.intent)
  }

  private async replyCompletedPreferenceTurn(
    agent: Agent,
    expectedBinding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    input: {
      text: string
      format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
      modelPicker?: ModelPickerIntent
      permissionPicker?: PermissionPickerIntent
    },
  ): Promise<'recorded' | 'unavailable' | 'unknown'> {
    const prepared = this.prepareAgentReply(agent, {
      idempotencyKey: `inbound:${envelope.eventId}:reply`,
      replyToEventId: envelope.eventId,
      ...input,
    })
    if (prepared.binding.id !== expectedBinding.id
      || prepared.binding.version !== expectedBinding.version
      || prepared.binding.sessionId !== expectedBinding.sessionId
      || JSON.stringify(envelope.conversation) !== JSON.stringify(prepared.binding.conversation)
      || JSON.stringify(envelope.principal) !== JSON.stringify(prepared.binding.principal)) {
      throw new AssistantDeliveryError(
        'missing-binding',
        'completed turn no longer belongs to its exact Delivery binding',
      )
    }
    let projected = false
    this.deliveryStore.enqueueReplyWithPreferenceProjection(prepared.intent, reply => {
      const events = this.completedPreferenceEvents(prepared.binding, envelope, reply)
      projected = events !== undefined
      return events
    })
    if (projected) await this.drainPreferenceProjections()
    return projected ? 'recorded' : 'unavailable'
  }

  private prepareAgentReply(agent: Agent | undefined, input: {
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'model-picker' | 'permission-picker' | 'plain'
    modelPicker?: ModelPickerIntent
    permissionPicker?: PermissionPickerIntent
    replyToEventId?: string
  }): Readonly<{ binding: ConversationBinding; intent: OutboundIntent }> {
    this.assertActive()
    const binding = agent === undefined ? undefined : this.deliveryStore.getBindingBySession(String(agent.session.id))
    if (agent === undefined || binding === undefined || binding.status !== 'active'
      || agent.session.header.cwd !== binding.workspace
      || agent.session.header.agentPreset !== binding.agentPreset
      || !this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'Agent session is not bound to an active delivery route')
    }
    let idempotencyKey = input.idempotencyKey
    if (input.replyToEventId !== undefined
      && input.idempotencyKey === `inbound:${input.replyToEventId}:reply`) {
      idempotencyKey = this.inboundReplyIdempotencyKey(binding, input.replyToEventId)
    }
    const decision = this.policy.authorizeAgent(agent, 'reply', { kind: 'message', id: binding.id },
      { idempotencyKey: `message-reply:${idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    if (!this.hasActivePrincipal(binding)) {
      throw new AssistantDeliveryError('missing-binding', 'Agent delivery principal is no longer active')
    }
    const format = this.replyFormat(binding.conversation, input.format) ?? 'plain'
    const intent: OutboundIntent = { idempotencyKey, bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal }, text: input.text,
      format,
      ...(input.modelPicker === undefined ? {} : { modelPicker: input.modelPicker }),
      ...(format !== 'permission-picker' || input.permissionPicker === undefined
        ? {}
        : { permissionPicker: input.permissionPicker }),
      ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }) }
    return Object.freeze({ binding, intent: Object.freeze(intent) })
  }

  history(agent: Agent | undefined, input: { limit?: number }): {
    binding: ConversationBinding
    inbox: InboxRecord[]
    outbox: OutboxRecord[]
  } {
    this.assertActive()
    const binding = agent === undefined ? undefined : this.deliveryStore.getBindingBySession(String(agent.session.id))
    if (agent === undefined || binding === undefined || binding.status !== 'active'
      || agent.session.header.cwd !== binding.workspace
      || agent.session.header.agentPreset !== binding.agentPreset) {
      throw new AssistantDeliveryError('missing-binding', 'Agent session has no active matching delivery binding')
    }
    const decision = this.policy.authorizeAgent(agent, 'history', { kind: 'message', id: binding.id })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    const query = input.limit === undefined ? { bindingId: binding.id } : { bindingId: binding.id, limit: input.limit }
    return { binding, inbox: this.deliveryStore.listInbox(query), outbox: this.deliveryStore.listOutbox(query) }
  }

  bindAgentApprovalRoute(agent: Agent | undefined, input: { bindingId: string }): () => void {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const owner = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
    if (agent === undefined || binding?.status !== 'active' || owner?.status !== 'active' || owner.role !== 'owner'
      || agent.session.header.cwd !== binding.workspace
      || agent.session.header.agentPreset !== binding.agentPreset) {
      throw new AssistantDeliveryError('missing-binding', 'Agent identity does not match an active owner approval route')
    }
    const direct = this.deliveryStore.getBindingBySession(String(agent.session.id))
    if (direct !== undefined && direct.id !== binding.id) {
      throw new AssistantDeliveryError('missing-binding', 'Agent session is already bound to another approval route')
    }
    const token = Symbol('assistant-delivery.approval-binding')
    this.agentApprovalBindings.set(agent, { bindingId: binding.id, token })
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.agentApprovalBindings.get(agent)?.token === token) this.agentApprovalBindings.delete(agent)
    }
  }

  prepareAgentApproval(agent: Agent | undefined, input: { sourceId: string }): ApprovalDispatchRoute {
    this.assertActive()
    const sourceId = input.sourceId.trim()
    const direct = agent === undefined ? undefined : this.deliveryStore.getBindingBySession(String(agent.session.id))
    const delegatedId = agent === undefined ? undefined : this.agentApprovalBindings.get(agent)?.bindingId
    const delegated = delegatedId === undefined ? undefined : this.deliveryStore.getBinding(delegatedId)
    if (direct !== undefined && delegated !== undefined && direct.id !== delegated.id) {
      throw new AssistantDeliveryError('missing-binding', 'Agent approval routes conflict')
    }
    const binding = direct ?? delegated
    const owner = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(sourceId)
      || binding?.status !== 'active' || owner?.status !== 'active' || owner.role !== 'owner'
      || agent?.session.header.cwd !== binding.workspace
      || agent.session.header.agentPreset !== binding.agentPreset) {
      throw new AssistantDeliveryError('missing-binding', 'Agent session has no authenticated active owner approval route')
    }
    return Object.freeze({ sourceId, bindingId: binding.id, workspace: binding.workspace,
      principal: externalPrincipalId(binding.principal) })
  }

  async tick(): Promise<void> {
    this.assertActive()
    await this.inbound.tick()
    await this.drainModelSelectionSettlements()
    this.drainApprovalDispatches()
    await this.outbound.tick()
    await this.drainDeliveryPresentations()
    await this.drainPreferenceProjections()
    await this.drainWorkflowTraces()
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await Promise.all([
      this.inbound.whenIdle(),
      this.outbound.whenIdle(),
      this.modelSelectionFlight,
      this.presentationFlight,
      this.preferenceProjectionFlight,
      this.workflowTraceFlight,
    ])
  }

  start(): void {
    this.assertActive()
    if (this.timer !== undefined) return
    this.timer = setInterval(() => void this.tick(), this.config.tickIntervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.assertActive()
    await this.stopInternal()
  }

  private async ensureBinding(envelope: InboundEnvelope): Promise<ConversationBinding> {
    const key = JSON.stringify(envelope.conversation)
    const existing = this.bindingFlights.get(key)
    if (existing !== undefined) return existing
    const runtime = this.runtime
    if (runtime === undefined) throw new AssistantDeliveryError('runtime-unavailable', 'inbound runtime is unavailable')
    const promise = (async () => {
      const current = this.deliveryStore.getActiveBinding(envelope.conversation)
      if (current !== undefined) return current
      const generation = this.deliveryStore.nextBindingGeneration(envelope.conversation)
      const created = await runtime.createSession({ envelope, generation, signal: new AbortController().signal })
      this.assertActive()
      return this.deliveryStore.createBinding({ conversation: envelope.conversation, principal: envelope.principal,
        workspace: created.workspace, agentPreset: created.agentPreset, sessionId: created.sessionId,
        policyRef: created.policyRef, expectedGeneration: generation })
    })().finally(() => this.bindingFlights.delete(key))
    this.bindingFlights.set(key, promise)
    return promise
  }

  private async bindingForInbound(
    envelope: InboundEnvelope,
    inboxId: string,
  ): Promise<ConversationBinding | undefined> {
    let binding = this.deliveryStore.getActiveBinding(envelope.conversation)
    if (binding === undefined) {
      if (this.runtime === undefined) {
        this.deliveryStore.deadLetterInbox(inboxId, 'runtime-unavailable')
        return undefined
      }
      binding = await this.ensureBinding(envelope)
    }
    if (externalPrincipalId(binding.principal) !== externalPrincipalId(envelope.principal)) {
      this.deliveryStore.deadLetterInbox(inboxId, 'binding-principal-mismatch')
      return undefined
    }
    return binding
  }

  /**
   * Finish admissions that survived a process exit before their queue/rotate
   * commit. The provider need not retransmit them: any later message in the
   * same conversation first drives every older received row forward in its
   * original durable Inbox order. This includes ordinary messages that were
   * already persisted behind a blocked `/stop` or `/new` transition.
   */
  private async recoverPendingInbound(
    boundary: InboundEnvelope,
    beforeInboxId: string,
  ): Promise<void> {
    while (true) {
      const pending = this.deliveryStore.findPendingInboundBefore({
        conversation: boundary.conversation,
        principal: boundary.principal,
        beforeInboxId,
      })
      if (pending === undefined) return
      if (!this.deliveryStore.isAuthorizedPrincipal(pending.envelope.principal)) {
        this.deliveryStore.deadLetterInbox(pending.id, 'unauthorized-principal')
        continue
      }
      const decision = this.policy.authorize({
        subject: { kind: 'external', id: externalPrincipalId(pending.envelope.principal) },
        action: 'ingest',
        resource: { kind: 'message', id: `inbound:${pending.envelope.channel}/${pending.envelope.account}` },
        context: { initiator: 'external' },
      }, { idempotencyKey: `message-inbound:${pending.id}` })
      if (decision.effect !== 'allow') {
        this.deliveryStore.deadLetterInbox(pending.id, `policy-${decision.reasonCode}`)
        continue
      }
      const command = parseDeliveryCommand(pending.envelope)
      const reset = isExactDeliveryCommand(command, 'new', 'clear')
      const stop = isExactDeliveryCommand(command, 'stop')
      const binding = await this.bindingForInbound(pending.envelope, pending.id)
      if (binding === undefined) continue
      if (!reset && !stop) {
        this.deliveryStore.queueInbox(pending.id, binding.id)
        continue
      }
      const fence = this.deliveryStore.cancelUndispatchedInboxBefore({
        bindingId: binding.id,
        beforeInboxId: pending.id,
        failureCode: reset ? 'new-session-before-dispatch' : 'user-stopped-before-dispatch',
      })
      const cancellationCommand = reset ? 'new' : 'stop'
      await this.runtime?.cancelActive?.(binding, cancellationCommand)
      await this.inbound.cancelUndispatchedClaims(fence.claimedInboxIds, cancellationCommand)
      if (reset) {
        await this.rotateBinding(pending.envelope, binding, pending.id)
      } else {
        this.deliveryStore.queueInbox(pending.id, binding.id)
      }
    }
  }

  private async runConversationTransition<T>(
    conversation: ConversationRef,
    task: () => Promise<T>,
  ): Promise<T> {
    const key = JSON.stringify(canonicalConversation(conversation))
    const previous = this.conversationTransitions.get(key) ?? Promise.resolve()
    let release!: () => void
    const own = new Promise<void>(resolve => { release = resolve })
    const fence = previous.catch(() => {}).then(() => own)
    this.conversationTransitions.set(key, fence)
    await previous.catch(() => {})
    try {
      return await task()
    } finally {
      release()
      if (this.conversationTransitions.get(key) === fence) this.conversationTransitions.delete(key)
    }
  }

  private async rotateBinding(
    envelope: InboundEnvelope,
    previous: ConversationBinding,
    commandInboxId: string,
  ): Promise<ConversationBinding> {
    const key = `${JSON.stringify(envelope.conversation)}:/new:${envelope.eventId}`
    const existing = this.bindingFlights.get(key)
    if (existing !== undefined) return existing
    const runtime = this.runtime
    if (runtime === undefined) throw new AssistantDeliveryError('runtime-unavailable', 'inbound runtime is unavailable')
    const promise = (async () => {
      const current = this.deliveryStore.getActiveBinding(envelope.conversation)
      if (current === undefined) throw new AssistantDeliveryError('missing-binding', 'active binding disappeared during /new')
      if (current.id !== previous.id) return current
      const generation = this.deliveryStore.nextBindingGeneration(envelope.conversation)
      if (generation !== current.generation + 1) {
        throw new AssistantDeliveryError('runtime-conflict', 'binding generation changed before /new session creation')
      }
      const created = await runtime.createSession({ envelope, generation,
        previous: current, signal: new AbortController().signal })
      this.assertActive()
      return this.deliveryStore.rotateBindingAndQueueCommand({
        bindingId: current.id,
        expectedVersion: current.version,
        sessionId: created.sessionId,
        inboxId: commandInboxId,
      }).binding
    })().finally(() => this.bindingFlights.delete(key))
    this.bindingFlights.set(key, promise)
    return promise
  }

  private async stopInternal(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.modelSelectionRetryTimer !== undefined) clearTimeout(this.modelSelectionRetryTimer)
    if (this.workflowTraceRetryTimer !== undefined) clearTimeout(this.workflowTraceRetryTimer)
    if (this.preferenceProjectionRetryTimer !== undefined) clearTimeout(this.preferenceProjectionRetryTimer)
    this.timer = undefined
    this.modelSelectionRetryTimer = undefined
    this.workflowTraceRetryTimer = undefined
    this.preferenceProjectionRetryTimer = undefined
    this.cancelModelSelectionWaiters()
    await Promise.all([
      this.inbound.stop(),
      this.outbound.stop(),
      this.modelSelectionFlight,
      this.presentationFlight,
      this.preferenceProjectionFlight,
      this.workflowTraceFlight,
    ])
  }

  private drainPreferenceProjections(): Promise<void> {
    if (this.preferenceProjectionRetryTimer !== undefined) {
      clearTimeout(this.preferenceProjectionRetryTimer)
      this.preferenceProjectionRetryTimer = undefined
    }
    if (this.preferenceProjectionFlight !== undefined) return this.preferenceProjectionFlight
    const flight = this.runPreferenceProjection()
      .finally(() => {
        if (this.preferenceProjectionFlight === flight) this.preferenceProjectionFlight = undefined
      })
    this.preferenceProjectionFlight = flight
    return flight
  }

  private async runPreferenceProjection(): Promise<void> {
    const sink = this.preferenceFeedbackSink
    if (sink === undefined) return
    let attempted = 0
    while (attempted < 100) {
      const entries = this.deliveryStore.listPendingPreferenceProjections(100 - attempted)
      if (entries.length === 0) break
      for (const entry of entries) {
        if (!this.active || this.preferenceFeedbackSink?.token !== sink.token) return
        attempted += 1
        try {
          if (sink.registration.appendSynchronously !== undefined) {
            this.deliveryStore.projectPreferenceProjectionUnderOwnerFence(entry, current => {
              if (!this.active || this.preferenceFeedbackSink?.token !== sink.token
                || !registrationOwnedByPreference(sink.registration)) {
                throw Object.assign(new Error('stale Preference projection registration'), {
                  code: 'stale-registration',
                })
              }
              const receipts = sink.registration.appendSynchronously!(current.events)
              validatePreferenceProjectionReceipts(receipts, current.events)
            })
          } else {
            // Rolling-upgrade fallback. It still rechecks immediately before
            // sink I/O; current in-process Preference registrations use the
            // synchronous path above to close the remaining check/use window.
            if (!this.deliveryStore.preferenceProjectionHasCurrentOwner(entry)) continue
            const receipts = await Promise.resolve(sink.registration.append(entry.events))
            validatePreferenceProjectionReceipts(receipts, entry.events)
            if (!this.active || this.preferenceFeedbackSink?.token !== sink.token) return
            this.deliveryStore.completePreferenceProjection({
              batchKey: entry.batchKey,
              payloadDigest: entry.payloadDigest,
            })
          }
        } catch (error) {
          if (!this.active || this.preferenceFeedbackSink?.token !== sink.token) return
          const now = Date.now()
          const retryAt = now + Math.min(
            this.config.retryMaxMs,
            this.config.retryBaseMs * (2 ** Math.min(30, entry.attemptCount)),
          )
          const code = typeof error === 'object' && error !== null && 'code' in error
            && typeof (error as { code?: unknown }).code === 'string'
            ? `sink-${(error as { code: string }).code}`.slice(0, 64)
            : 'sink-projection-failed'
          this.deliveryStore.deferPreferenceProjection({
            batchKey: entry.batchKey,
            payloadDigest: entry.payloadDigest,
            now,
            retryAt,
            failureCode: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(code)
              ? code
              : 'sink-projection-failed',
          })
        }
      }
    }
    const nextRetryAt = this.deliveryStore.nextPreferenceProjectionAttemptAt()
    if (nextRetryAt !== undefined && this.preferenceFeedbackSink?.token === sink.token
      && this.preferenceProjectionRetryTimer === undefined) {
      this.preferenceProjectionRetryTimer = setTimeout(() => {
        this.preferenceProjectionRetryTimer = undefined
        if (this.active) void this.drainPreferenceProjections()
      }, Math.max(1, Math.min(2_147_483_647, nextRetryAt - Date.now())))
      this.preferenceProjectionRetryTimer.unref?.()
    }
  }

  /** Host test/operator seam: project due trace revisions without waiting for the scheduler. */
  projectWorkflowTraces(): Promise<void> {
    this.assertActive()
    return this.drainWorkflowTraces()
  }

  private drainWorkflowTraces(): Promise<void> {
    if (this.workflowTraceRetryTimer !== undefined) {
      clearTimeout(this.workflowTraceRetryTimer)
      this.workflowTraceRetryTimer = undefined
    }
    if (this.workflowTraceFlight !== undefined) return this.workflowTraceFlight
    const flight = this.runWorkflowTraceProjection()
      .finally(() => { if (this.workflowTraceFlight === flight) this.workflowTraceFlight = undefined })
    this.workflowTraceFlight = flight
    return flight
  }

  private async runWorkflowTraceProjection(): Promise<void> {
    const registration = this.workflowTraceSink
    if (registration === undefined) return
    const entries = this.deliveryStore.listPendingWorkflowTraceRevisions(100)
    let nextRetryAt: number | undefined
    for (const entry of entries) {
      if (!this.active || this.workflowTraceSink?.token !== registration.token) return
      try {
        const candidate = await Promise.resolve(
          registration.sink.projectWorkflowTraceRevision(entry.revision),
        )
        validateWorkflowTraceProjectionReceipt(candidate, entry.revision)
        if (!this.active || this.workflowTraceSink?.token !== registration.token) return
        this.deliveryStore.completeWorkflowTraceRevision({
          subjectRef: entry.revision.subjectRef,
          version: entry.revision.version,
          digest: entry.revision.digest,
        })
      } catch (error) {
        if (!this.active || this.workflowTraceSink?.token !== registration.token) return
        const now = Date.now()
        const retryDelay = Math.min(
          this.config.retryMaxMs,
          this.config.retryBaseMs * (2 ** Math.min(30, entry.attemptCount)),
        )
        const retryAt = now + retryDelay
        const code = typeof error === 'object' && error !== null && 'code' in error
          && typeof (error as { code?: unknown }).code === 'string'
          ? `sink-${(error as { code: string }).code}`.slice(0, 64)
          : 'sink-projection-failed'
        this.deliveryStore.deferWorkflowTraceRevision({
          subjectRef: entry.revision.subjectRef,
          version: entry.revision.version,
          digest: entry.revision.digest,
          now,
          retryAt,
          failureCode: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(code)
            ? code
            : 'sink-projection-failed',
        })
        nextRetryAt = Math.min(nextRetryAt ?? retryAt, retryAt)
      }
    }
    if (nextRetryAt !== undefined && this.workflowTraceSink?.token === registration.token
      && this.workflowTraceRetryTimer === undefined) {
      this.workflowTraceRetryTimer = setTimeout(() => {
        this.workflowTraceRetryTimer = undefined
        if (this.active) void this.drainWorkflowTraces()
      }, Math.max(1, Math.min(2_147_483_647, nextRetryAt - Date.now())))
      this.workflowTraceRetryTimer.unref?.()
    }
  }

  private resolveModelSelectionWaiters(
    operationId: string,
    result: ModelSelectionTerminalResult,
  ): void {
    const waiters = this.modelSelectionWaiters.get(operationId)
    if (waiters === undefined) return
    for (const waiter of waiters) waiter.resolve(result)
  }

  private cancelModelSelectionWaiters(): void {
    for (const waiters of this.modelSelectionWaiters.values()) {
      for (const waiter of waiters) waiter.resolve(undefined)
    }
  }

  private drainApprovalDispatches(): void {
    const cursor = this.deliveryStore.getApprovalDispatchCursor()
    const dispatches = this.policy.listPendingApprovalDispatches(100, cursor.after)
    for (const dispatch of dispatches) {
      try {
        this.enqueueApproval({
          sourceId: dispatch.sourceId,
          workspace: dispatch.workspace,
          bindingId: dispatch.bindingId,
          idempotencyKey: `approval-card:${dispatch.proposalId}`,
          text: dispatch.diff,
          approval: {
            operationId: `approval:${dispatch.proposalId}`,
            proposalId: dispatch.proposalId,
            expectedVersion: dispatch.proposalVersion,
            expiresAt: dispatch.expiresAt,
            title: dispatch.summary,
            diffHash: dispatch.diffHash,
          },
        })
        this.policy.markApprovalDispatchEnqueued(dispatch.proposalId, dispatch.version)
      } catch {
        // One invalid/revoked route must not starve later durable dispatches.
      }
    }
    const last = dispatches.at(-1)
    const after = dispatches.length === 100 && last !== undefined
      ? { createdAt: last.createdAt, proposalId: last.proposalId }
      : undefined
    if (after === undefined && cursor.after === undefined) return
    try {
      this.deliveryStore.advanceApprovalDispatchCursor({ expectedVersion: cursor.version,
        ...(after === undefined ? {} : { after }) })
    } catch (error) {
      // Another Host sharing the same durable Delivery DB won the scan fence.
      if (error instanceof DeliveryStoreError && error.code === 'stale-fence') return
      throw error
    }
  }

  private drainDeliveryPresentations(): Promise<void> {
    if (this.presentationFlight !== undefined) return this.presentationFlight
    const flight = this.runDeliveryPresentations()
      .finally(() => { if (this.presentationFlight === flight) this.presentationFlight = undefined })
    this.presentationFlight = flight
    return flight
  }

  private async runDeliveryPresentations(): Promise<void> {
    const attemptedPresentationKeys: string[] = []
    for (let index = 0; index < this.config.maxConcurrency; index += 1) {
      const claimed = this.deliveryStore.claimDeliveryPresentation({
        ownerId: this.ownerId,
        leaseMs: this.config.leaseMs,
        excludePresentationKeys: attemptedPresentationKeys,
      })
      if (claimed === undefined) return
      const { presentation, fencingToken } = claimed
      attemptedPresentationKeys.push(presentation.presentationKey)
      const original = this.deliveryStore.getOutboxByIdempotencyKey(
        presentation.originalOutboxIdempotencyKey,
      )
      const finishFailure = (failureCode: string, terminal = false) => {
        // Presentation is a projection of an already-authoritative terminal
        // domain receipt. A transient provider failure must never turn that
        // receipt into a permanent lie simply because the normal message-send
        // retry budget was exhausted. Only an immutable original or revoked
        // authority can terminally fence the projection.
        const outcome = terminal ? 'dead' as const : 'retry_wait' as const
        const retryDelay = Math.min(
          this.config.retryMaxMs,
          this.config.retryBaseMs * (2 ** Math.min(30, Math.max(0, presentation.attemptCount - 1))),
        )
        try {
          this.deliveryStore.finishDeliveryPresentation({
            presentationKey: presentation.presentationKey,
            revision: presentation.revision,
            ownerId: this.ownerId,
            fencingToken,
            outcome,
            failureCode,
            ...(outcome === 'retry_wait' ? { nextAttemptAt: Date.now() + retryDelay } : {}),
          })
        } catch (error) {
          // A newer desired revision superseded this provider attempt. Its
          // pending row is authoritative and must not be overwritten by the
          // older completion.
          if (error instanceof DeliveryStoreError && error.code === 'stale-fence') return
          throw error
        }
      }
      if (original === undefined) {
        // The domain can settle before the Policy dispatch scanner creates the
        // card. Preserve the desired state without exhausting retries.
        this.deliveryStore.finishDeliveryPresentation({
          presentationKey: presentation.presentationKey,
          revision: presentation.revision,
          ownerId: this.ownerId,
          fencingToken,
          outcome: 'retry_wait',
          failureCode: 'original-message-not-created',
          nextAttemptAt: Date.now() + this.config.retryBaseMs,
        })
        continue
      }
      if (original.status === 'dead') {
        finishFailure('original-message-dead', true)
        continue
      }
      if (original.providerMessageId === undefined) {
        this.deliveryStore.finishDeliveryPresentation({
          presentationKey: presentation.presentationKey,
          revision: presentation.revision,
          ownerId: this.ownerId,
          fencingToken,
          outcome: 'retry_wait',
          failureCode: 'original-provider-message-pending',
          nextAttemptAt: Date.now() + this.config.retryBaseMs,
        })
        continue
      }
      if (presentation.presentation.kind === 'automation-incident') {
        const route = this.deliveryStore.validatePresentationOwnerRoute(original, this.ownerRouteGuard)
        if (route.kind === 'deferred') {
          finishFailure(route.failureCode)
          continue
        }
        if (route.kind !== 'authorized') {
          finishFailure(route.kind === 'denied'
            ? route.failureCode
            : 'presentation-owner-route-required', true)
          continue
        }
      } else {
        const binding = this.deliveryStore.getBinding(original.intent.bindingId)
        const principal = binding === undefined ? undefined : this.deliveryStore.getPrincipal(binding.principal)
        if (binding?.status !== 'active' || principal?.status !== 'active' || principal.role !== 'owner') {
          finishFailure('presentation-route-revoked', true)
          continue
        }
      }
      const adapter = this.registry.get(
        original.intent.target.conversation.channel,
        original.intent.target.conversation.account,
      )
      if (adapter?.updatePresentation === undefined) {
        finishFailure('presentation-adapter-unavailable')
        continue
      }
      const controller = new AbortController()
      const timeout = setTimeout(
        () => controller.abort(new Error('delivery presentation lease elapsed')),
        this.config.leaseMs,
      )
      timeout.unref?.()
      let updateError: unknown
      try {
        await adapter.updatePresentation(
          original.providerMessageId,
          presentation.presentation,
          controller.signal,
        )
      } catch (error) {
        updateError = error
      } finally {
        clearTimeout(timeout)
      }
      if (updateError !== undefined) {
        const code = updateError instanceof Error
          ? `presentation-${updateError.name.normalize('NFC').toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').slice(0, 80)}`
          : 'presentation-unknown-error'
        finishFailure(code)
        continue
      }
      try {
        this.deliveryStore.finishDeliveryPresentation({
          presentationKey: presentation.presentationKey,
          revision: presentation.revision,
          ownerId: this.ownerId,
          fencingToken,
          outcome: 'presented',
          providerMessageId: original.providerMessageId,
        })
      } catch (error) {
        if (!(error instanceof DeliveryStoreError) || error.code !== 'stale-fence') throw error
      }
    }
  }

  private drainModelSelectionSettlements(): Promise<void> {
    if (this.modelSelectionRetryTimer !== undefined) {
      clearTimeout(this.modelSelectionRetryTimer)
      this.modelSelectionRetryTimer = undefined
    }
    if (this.modelSelectionFlight !== undefined) {
      return this.modelSelectionFlight.then(() => this.drainModelSelectionSettlements())
    }
    const flight = this.runModelSelectionSettlements()
      .finally(() => { if (this.modelSelectionFlight === flight) this.modelSelectionFlight = undefined })
    this.modelSelectionFlight = flight
    return flight
  }

  private async runModelSelectionSettlements(): Promise<void> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) return
    while (this.active) {
      const claims = this.deliveryStore.claimModelSelectionSettlements({
        ownerId: this.ownerId,
        leaseMs: this.config.leaseMs,
        limit: this.config.maxConcurrency,
      })
      if (claims.length === 0) {
        const next = this.deliveryStore.nextModelSelectionClaimAt()
        if (next !== undefined && this.modelSelectionRetryTimer === undefined) {
          const delay = Math.max(1, Math.min(2_147_483_647, next - Date.now()))
          this.modelSelectionRetryTimer = setTimeout(() => {
            this.modelSelectionRetryTimer = undefined
            if (this.active) void this.drainModelSelectionSettlements()
          }, delay)
          this.modelSelectionRetryTimer.unref?.()
        }
        return
      }
      await Promise.allSettled(claims.map(async claim => {
        const finishWithoutReply = (result: ModelSelectionTerminalResult) => {
          const completed = this.deliveryStore.completeModelSelectionSettlement({
            operationId: claim.operationId,
            payloadHash: claim.payloadHash,
            result,
            ownerId: this.ownerId,
            fencingToken: claim.fencingToken,
          }) as ModelSelectionTerminalResult
          this.resolveModelSelectionWaiters(claim.operationId, completed)
          return completed
        }
        const payload = claim.payload
        if (!isModelSelectionPayload(payload) || payload.bindingId !== claim.bindingId) {
          finishWithoutReply({ status: 'rejected', reason: 'authorization-revoked' })
          return
        }
        const ownsBinding = (binding: ConversationBinding | undefined): binding is ConversationBinding => {
          const principal = this.deliveryStore.getPrincipal(payload.principal)
          return binding?.status === 'active'
            && principal?.status === 'active'
            && binding.conversation.chat === payload.callbackChatId
            && JSON.stringify(binding.principal) === JSON.stringify(principal.principal)
        }
        // The callback claim already consumed any authorization budget. Workers
        // re-evaluate current rules/emergency-stop without charging it again.
        const authorized = (binding: ConversationBinding) => this.policy.evaluate({
          subject: { kind: 'external', id: externalPrincipalId(payload.principal) },
          action: 'ingest',
          resource: { kind: 'message', id: `model-selection:${binding.id}` },
          context: { initiator: 'external' },
        }).effect === 'allow'
        const complete = (
          binding: ConversationBinding,
          result: ModelSelectionTerminalResult,
          text: string,
          selection?: ModelRouteRef,
        ) => {
          const reply = (content: string) => ({
            idempotencyKey: `model-selection:${payload.callbackEventId}:reply`,
            bindingId: binding.id,
            target: { conversation: binding.conversation, principal: binding.principal },
            text: content,
            format: 'plain' as const,
          })
          const superseded: ModelSelectionResult = { status: 'rejected', reason: 'selection-superseded' }
          const completed = this.deliveryStore.completeModelSelectionSettlement({
            operationId: claim.operationId,
            payloadHash: claim.payloadHash,
            result,
            ...(selection === undefined ? {} : { selection: { conversation: binding.conversation, route: selection } }),
            reply: reply(text),
            superseded: {
              result: superseded,
              reply: reply('该模型选择已被更晚的操作取代，未更改当前模型。'),
            },
            ownerId: this.ownerId,
            fencingToken: claim.fencingToken,
          }) as ModelSelectionTerminalResult
          this.resolveModelSelectionWaiters(claim.operationId, completed)
          return completed
        }
        const initialBinding = this.deliveryStore.getBinding(claim.bindingId)
        if (!ownsBinding(initialBinding) || !authorized(initialBinding)) {
          finishWithoutReply({ status: 'rejected', reason: 'authorization-revoked' })
          return
        }
        if (payload.provider !== payload.modelProvider) {
          complete(initialBinding, { status: 'rejected', reason: 'provider-model-mismatch' },
            `分组 ${payload.provider} 与模型 ${payload.modelProvider}/${payload.model} 不匹配，请重新发送 /model。`)
          return
        }
        if (!llm.listProviders().some(provider => provider.id === payload.provider)) {
          complete(initialBinding, { status: 'rejected', reason: 'provider-unavailable' },
            `模型分组 ${payload.provider} 当前不可用，请重新发送 /model。`)
          return
        }
        let leaseLost = false
        const renewLease = () => {
          try {
            if (!this.deliveryStore.renewModelSelectionSettlement({
              operationId: claim.operationId,
              ownerId: this.ownerId,
              fencingToken: claim.fencingToken,
              leaseMs: this.config.leaseMs,
            })) leaseLost = true
          } catch {
            leaseLost = true
          }
        }
        const heartbeat = setInterval(renewLease, Math.max(1, Math.floor(this.config.leaseMs / 3)))
        heartbeat.unref?.()
        const resolveController = new AbortController()
        let resolveTimeout: ReturnType<typeof setTimeout> | undefined
        const deadline = new Promise<never>((_resolve, reject) => {
          resolveTimeout = setTimeout(() => {
            const error = new Error('model selection resolution timed out')
            resolveController.abort(error)
            reject(error)
          }, this.config.leaseMs)
        })
        let resolved: Awaited<ReturnType<typeof llm.resolveModelInfo>> | undefined
        try {
          resolved = await Promise.race([
            llm.resolveModelInfo(payload.provider, payload.model, resolveController.signal),
            deadline,
          ])
        } catch {
          // Model availability is persisted below, after refreshing authority.
        } finally {
          if (resolveTimeout !== undefined) clearTimeout(resolveTimeout)
          clearInterval(heartbeat)
        }
        renewLease()
        if (leaseLost) return
        const binding = this.deliveryStore.getBinding(claim.bindingId)
        if (!ownsBinding(binding)) {
          finishWithoutReply({ status: 'rejected', reason: 'authorization-revoked' })
          return
        }
        if (!authorized(binding)) {
          finishWithoutReply({ status: 'rejected', reason: 'authorization-revoked' })
          return
        }
        if (resolved === undefined) {
          complete(binding, { status: 'rejected', reason: 'model-unavailable' },
            `模型 ${payload.provider}/${payload.model} 当前不可用，请重新发送 /model。`)
          return
        }
        if (payload.reasoningEffort !== null
          && !resolved.reasoning?.efforts.some(effort => String(effort.id) === payload.reasoningEffort)) {
          complete(binding, { status: 'rejected', reason: 'invalid-effort' },
            `模型 ${payload.provider}/${payload.model} 不支持 effort “${payload.reasoningEffort}”，请重新发送 /model。`)
          return
        }
        const selection: ModelRouteRef = {
          provider: payload.provider,
          model: payload.model,
          ...(payload.reasoningEffort === null ? {} : { reasoningEffort: payload.reasoningEffort }),
        }
        complete(binding, { status: 'selected', selection },
          `已切换到 ${payload.provider}/${payload.model}${payload.reasoningEffort === null
            ? '，effort：默认'
            : `，effort：${payload.reasoningEffort}`}。下一条消息起生效，上下文保留。`, selection)
      }))
    }
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantDeliveryError('disposed', 'assistant-delivery service is disposed')
  }
}

export const Config = AssistantDeliveryService.Config
