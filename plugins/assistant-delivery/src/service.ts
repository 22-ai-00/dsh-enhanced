import { chmodSync, mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import {
  DeliveryAdapterRegistry,
  DeliveryCoordinator,
  InboundCoordinator,
  type InboundMessageProcessor,
} from './coordinator.js'
import { DeliveryStore } from './store.js'
import { DshDeliveryRuntime } from './agent-runtime.js'
import { registerDeliveryTools } from './tools.js'
import type {
  ConversationBinding,
  ConversationRef,
  DeliveryAdapter,
  ExternalPrincipalKey,
  InboundEnvelope,
  InboxRecord,
  ModelPickerIntent,
  ModelPickerState,
  ModelRouteRef,
  OutboxRecord,
  PairingChallenge,
} from './types.js'

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
}

export interface DeliveryInboundRuntime extends InboundMessageProcessor {
  createSession(input: {
    envelope: Readonly<InboundEnvelope>
    generation: number
    previous?: Readonly<ConversationBinding>
    signal: AbortSignal
  }): Promise<{ sessionId: string; workspace: string; agentPreset: string; policyRef: string }>
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
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantDelivery: AssistantDeliveryService
  }
}

function policyDenied(decision: PolicyDecision): AssistantDeliveryError {
  return new AssistantDeliveryError('policy-denied', `assistant-delivery policy denied operation: ${decision.reasonCode}`)
}

function externalId(principal: ExternalPrincipalKey): string {
  return `${principal.channel}/${principal.account}/${principal.tenant}/${principal.user}`
}

function pickerIncludesRoute(picker: Readonly<ModelPickerIntent>, route: Readonly<ModelRouteRef>): boolean {
  const model = picker.models.find(candidate => candidate.provider === route.provider && candidate.id === route.model)
  return model !== undefined && (route.reasoningEffort === undefined || model.effortIds.includes(route.reasoningEffort))
}

type ModelSelectionResult =
  | { status: 'pending' }
  | { status: 'rejected'; reason: 'authorization-revoked' | 'invalid-effort' | 'model-unavailable' | 'provider-model-mismatch' | 'provider-unavailable' | 'selection-superseded' }
  | { status: 'selected'; selection: ModelRouteRef }

interface ModelSelectionPayload {
  callbackEventId: string
  callbackChatId: string
  bindingId: string
  principal: ExternalPrincipalKey
  provider: string
  modelProvider: string
  model: string
  reasoningEffort: string | null
  expectedRevision: number
}

function isModelSelectionPayload(value: unknown): value is ModelSelectionPayload {
  if (value === null || typeof value !== 'object') return false
  const payload = value as Partial<ModelSelectionPayload>
  const principal = payload.principal as Partial<ExternalPrincipalKey> | undefined
  return typeof payload.callbackEventId === 'string'
    && typeof payload.callbackChatId === 'string'
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

export class AssistantDeliveryService extends Service {
  static Config = configSchema

  private readonly deliveryStore: DeliveryStore
  private readonly policy: AssistantPolicyService
  private readonly registry: DeliveryAdapterRegistry
  private readonly outbound: DeliveryCoordinator
  private readonly inbound: InboundCoordinator
  private readonly config: Required<Config>
  private readonly ownerId = `assistant-delivery-${randomUUID()}`
  private readonly bindingFlights = new Map<string, Promise<ConversationBinding>>()
  private modelSelectionFlight: Promise<void> | undefined
  private modelSelectionRetryTimer: ReturnType<typeof setTimeout> | undefined
  private runtime: DeliveryInboundRuntime | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantDelivery')
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
    this.config = config
    this.policy = policy
    this.deliveryStore = new DeliveryStore({ path: config.databasePath, maxTextBytes: config.maxTextBytes })
    this.registry = new DeliveryAdapterRegistry({
      accept: async envelope => {
        const result = await this.acceptInbound(envelope)
        return { duplicate: result.duplicate, inboxId: result.inboxId, status: result.status }
      },
      receipt: async receipt => { this.deliveryStore.recordReceipt(receipt) },
    })
    this.outbound = new DeliveryCoordinator({ store: this.deliveryStore, registry: this.registry,
      ownerId: this.ownerId, leaseMs: config.leaseMs, maxAttempts: config.maxAttempts,
      maxConcurrency: config.maxConcurrency, retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs })
    this.inbound = new InboundCoordinator({ store: this.deliveryStore, processor: () => this.runtime,
      ownerId: this.ownerId, leaseMs: config.leaseMs, maxAttempts: config.maxAttempts,
      maxConcurrency: config.maxConcurrency, retryBaseMs: config.retryBaseMs, retryMaxMs: config.retryMaxMs })
    ctx.inject(['agents', 'sessions', 'llm'], runtimeCtx => {
      const unregister = this.registerInboundRuntime(new DshDeliveryRuntime(runtimeCtx, policy, {
        workspace: config.defaultWorkspace, agentPreset: config.defaultAgentPreset, policyRef: config.policyRef,
        getAgentPresets: () => runtimeCtx.get('agentPresets'),
        provider: config.agentProvider, model: config.agentModel, maxOutputTokens: config.agentMaxOutputTokens,
        modelPickerTtlMs: config.modelPickerTtlMs,
        getModelSelection: conversation => this.deliveryStore.getModelSelection(conversation),
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
        replyCommand: (binding, eventId, reply) => { this.replyCommand(binding, {
          idempotencyKey: `inbound:${eventId}:reply`,
          text: reply.text,
          replyToEventId: eventId,
          ...(reply.format === undefined ? {} : { format: reply.format }),
          ...(reply.modelPicker === undefined ? {} : { modelPicker: reply.modelPicker }),
        }) },
        reply: (agent, eventId, reply) => { this.reply(agent, {
          idempotencyKey: `inbound:${eventId}:reply`,
          text: reply.text,
          replyToEventId: eventId,
          ...(reply.format === undefined ? {} : { format: reply.format }),
          ...(reply.modelPicker === undefined ? {} : { modelPicker: reply.modelPicker }),
        }) },
      }))
      void this.drainModelSelectionSettlements()
      return unregister
    })
    ctx.inject(['tools'], toolsCtx => registerDeliveryTools(toolsCtx, this))
    if (config.schedulerEnabled) this.start()
    ctx.effect(() => async () => {
      this.active = false
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
    const decision = this.policy.authorize({ subject: { kind: 'external', id: externalId(input.principal) },
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

  settleApproval(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    bindingId: string
    principal: ExternalPrincipalKey
    proposalId: string
    expectedVersion: number
    decision: 'approved' | 'rejected'
    reason: string
  }): ReturnType<AssistantPolicyService['decideProposal']> {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'approval callback principal or chat does not own the active binding')
    }
    const payload = { callbackEventId: input.callbackEventId, callbackChatId: input.callbackChatId, bindingId: input.bindingId,
      principal: current.principal, proposalId: input.proposalId, expectedVersion: input.expectedVersion,
      decision: input.decision, reason: input.reason }
    const settlement = this.deliveryStore.beginApprovalSettlement({ operationId: input.operationId, payload })
    if (settlement.result !== undefined) {
      return settlement.result as ReturnType<AssistantPolicyService['decideProposal']>
    }
    const principal = externalId(current.principal)
    const authorization = this.policy.authorize({ subject: { kind: 'external', id: principal },
      action: 'approval.decide', resource: { kind: 'message', id: input.bindingId },
      context: { initiator: 'external' } }, { idempotencyKey: `approval-callback:${input.operationId}` })
    if (authorization.effect !== 'allow') throw policyDenied(authorization)
    const result = this.policy.decideProposal({ proposalId: input.proposalId, principal,
      expectedVersion: input.expectedVersion, decision: input.decision, reason: input.reason })
    return this.deliveryStore.completeApprovalSettlement({ operationId: input.operationId,
      payloadHash: settlement.payloadHash, result }) as ReturnType<AssistantPolicyService['decideProposal']>
  }

  settleModelSelection(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    bindingId: string
    principal: ExternalPrincipalKey
    provider: string
    modelProvider: string
    model: string
    reasoningEffort?: string
    expectedRevision: number
  }): ModelSelectionResult {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'model callback principal or chat does not own the active binding')
    }
    const picker = this.deliveryStore.getModelPicker(input.operationId, input.bindingId)
    const expected: ModelPickerState = {
      revision: input.expectedRevision,
      provider: input.modelProvider,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    }
    if (picker === undefined || !pickerIncludesRoute(picker, expected)) {
      throw new AssistantDeliveryError('missing-binding', 'model picker confirmation is unavailable or invalid')
    }
    const authorization = this.policy.authorize({ subject: { kind: 'external', id: externalId(current.principal) },
      action: 'ingest', resource: { kind: 'message', id: `model-selection:${binding.id}` },
      context: { initiator: 'external' } },
    { idempotencyKey: `model-selection:${input.operationId}:${input.callbackEventId}` })
    if (authorization.effect !== 'allow') throw policyDenied(authorization)
    const payload: ModelSelectionPayload = {
      callbackEventId: input.callbackEventId,
      callbackChatId: input.callbackChatId,
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

  advanceModelPickerForCallback(input: {
    operationId: string
    callbackChatId: string
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
    const picker = this.deliveryStore.getModelPicker(input.operationId, input.bindingId)
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
    const picker = this.deliveryStore.getModelPicker(input.operationId, input.bindingId)
    return picker === undefined || Date.now() >= picker.expiresAt ? undefined : picker
  }

  resolveDeadLetter(input: {
    operatorId: string
    kind: 'inbox' | 'outbox'
    id: string
    expectedAttemptCount: number
    resolution: 'cancel' | 'retry'
  }): InboxRecord | OutboxRecord {
    this.assertActive()
    const decision = this.policy.authorize({ subject: { kind: 'external', id: `local:${input.operatorId}` },
      action: 'delivery.resolve', resource: { kind: 'message', id: `${input.kind}:${input.id}` },
      context: { initiator: 'foreground' } }, { idempotencyKey: `delivery-resolve:${input.kind}:${input.id}:${input.expectedAttemptCount}:${input.resolution}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return input.kind === 'inbox'
      ? this.deliveryStore.resolveInbox({ inboxId: input.id, expectedAttemptCount: input.expectedAttemptCount,
        resolution: input.resolution })
      : this.deliveryStore.resolveOutbox({ outboxId: input.id, expectedAttemptCount: input.expectedAttemptCount,
        resolution: input.resolution })
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

  health(): ReturnType<DeliveryStore['health']> & { adapters: number } {
    this.assertActive()
    return { ...this.deliveryStore.health(), adapters: this.registry.size() }
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
    const decision = this.policy.authorize({ subject: { kind: 'external', id: externalId(envelope.principal) },
      action: 'ingest', resource: { kind: 'message', id: `inbound:${envelope.channel}/${envelope.account}` },
      context: { initiator: 'external' } }, { idempotencyKey: `message-inbound:${record.id}` })
    if (decision.effect !== 'allow') {
      record = this.deliveryStore.deadLetterInbox(record.id, `policy-${decision.reasonCode}`)
      return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
    }
    let binding = this.deliveryStore.getActiveBinding(envelope.conversation)
    if (binding === undefined) {
      if (this.runtime === undefined) {
        record = this.deliveryStore.deadLetterInbox(record.id, 'runtime-unavailable')
        return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
      }
      binding = await this.ensureBinding(envelope)
    }
    if (envelope.kind === 'command' && envelope.text.trim() === '/new') {
      binding = await this.rotateBinding(envelope, binding)
    }
    record = this.deliveryStore.queueInbox(record.id, binding.id)
    return { duplicate: accepted.duplicate, inboxId: record.id, status: record.status }
  }

  enqueueBackground(input: {
    sourceId: string
    workspace: string
    bindingId: string
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'plain'
  }): OutboxRecord {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    if (binding === undefined || binding.status !== 'active') {
      throw new AssistantDeliveryError('missing-binding', 'delivery binding does not exist or is revoked')
    }
    const decision = this.policy.authorize({ subject: { kind: 'background', id: input.sourceId,
      workspace: input.workspace, principal: externalId(binding.principal) }, action: 'send',
    resource: { kind: 'message', id: binding.id }, context: { initiator: 'background' } },
    { idempotencyKey: `message-send:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.enqueue({ idempotencyKey: input.idempotencyKey, bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal }, text: input.text,
      format: input.format ?? 'plain' })
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
    const decision = this.policy.authorize({ subject: { kind: 'background', id: input.sourceId,
      workspace: input.workspace, principal: externalId(binding.principal) }, action: 'approval.send',
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
    format?: 'markdown' | 'model-picker' | 'plain'
    modelPicker?: ModelPickerIntent
    replyToEventId: string
  }): OutboxRecord {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(bindingInput.id)
    if (binding === undefined || binding.status !== 'active' || binding.sessionId !== bindingInput.sessionId) {
      throw new AssistantDeliveryError('missing-binding', 'control command binding does not exist or is no longer active')
    }
    const decision = this.policy.authorize({
      subject: { kind: 'agent', id: binding.agentPreset, workspace: binding.workspace },
      action: 'reply',
      resource: { kind: 'message', id: binding.id },
      context: { initiator: 'external' },
    }, { idempotencyKey: `message-reply:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.enqueue({
      idempotencyKey: input.idempotencyKey,
      bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal },
      text: input.text,
      format: input.format ?? 'plain',
      ...(input.modelPicker === undefined ? {} : { modelPicker: input.modelPicker }),
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
    requested: 'markdown' | 'model-picker' | 'plain' | undefined,
  ): 'markdown' | 'model-picker' | 'plain' | undefined {
    if (requested !== 'markdown') return requested
    const adapter = this.registry.get(conversation.channel, conversation.account)
    return adapter?.capabilities.formats.includes('markdown') === true ? 'markdown' : 'plain'
  }

  reply(agent: Agent | undefined, input: {
    idempotencyKey: string
    text: string
    format?: 'markdown' | 'model-picker' | 'plain'
    modelPicker?: ModelPickerIntent
    replyToEventId?: string
  }): OutboxRecord {
    this.assertActive()
    const binding = agent === undefined ? undefined : this.deliveryStore.getBindingBySession(String(agent.session.id))
    if (binding === undefined || binding.status !== 'active') {
      throw new AssistantDeliveryError('missing-binding', 'Agent session is not bound to an active delivery route')
    }
    const decision = this.policy.authorizeAgent(agent, 'reply', { kind: 'message', id: binding.id },
      { idempotencyKey: `message-reply:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    return this.deliveryStore.enqueue({ idempotencyKey: input.idempotencyKey, bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal }, text: input.text,
      format: this.replyFormat(binding.conversation, input.format) ?? 'plain',
      ...(input.modelPicker === undefined ? {} : { modelPicker: input.modelPicker }),
      ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }) })
  }

  history(agent: Agent | undefined, input: { limit?: number }): {
    binding: ConversationBinding
    inbox: InboxRecord[]
    outbox: OutboxRecord[]
  } {
    this.assertActive()
    const binding = agent === undefined ? undefined : this.deliveryStore.getBindingBySession(String(agent.session.id))
    if (binding === undefined) throw new AssistantDeliveryError('missing-binding', 'Agent session has no delivery binding')
    const decision = this.policy.authorizeAgent(agent, 'history', { kind: 'message', id: binding.id })
    if (decision.effect !== 'allow') throw policyDenied(decision)
    const query = input.limit === undefined ? { bindingId: binding.id } : { bindingId: binding.id, limit: input.limit }
    return { binding, inbox: this.deliveryStore.listInbox(query), outbox: this.deliveryStore.listOutbox(query) }
  }

  async tick(): Promise<void> {
    this.assertActive()
    await this.inbound.tick()
    await this.drainModelSelectionSettlements()
    await this.outbound.tick()
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await Promise.all([this.inbound.whenIdle(), this.outbound.whenIdle(), this.modelSelectionFlight])
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
      const created = await runtime.createSession({ envelope, generation: 1, signal: new AbortController().signal })
      return this.deliveryStore.createBinding({ conversation: envelope.conversation, principal: envelope.principal,
        workspace: created.workspace, agentPreset: created.agentPreset, sessionId: created.sessionId,
        policyRef: created.policyRef })
    })().finally(() => this.bindingFlights.delete(key))
    this.bindingFlights.set(key, promise)
    return promise
  }

  private async rotateBinding(envelope: InboundEnvelope, previous: ConversationBinding): Promise<ConversationBinding> {
    const key = `${JSON.stringify(envelope.conversation)}:/new:${envelope.eventId}`
    const existing = this.bindingFlights.get(key)
    if (existing !== undefined) return existing
    const runtime = this.runtime
    if (runtime === undefined) throw new AssistantDeliveryError('runtime-unavailable', 'inbound runtime is unavailable')
    const promise = (async () => {
      const current = this.deliveryStore.getActiveBinding(envelope.conversation)
      if (current === undefined) throw new AssistantDeliveryError('missing-binding', 'active binding disappeared during /new')
      if (current.id !== previous.id) return current
      const created = await runtime.createSession({ envelope, generation: current.generation + 1,
        previous: current, signal: new AbortController().signal })
      return this.deliveryStore.rotateBinding({ bindingId: current.id, expectedVersion: current.version,
        sessionId: created.sessionId })
    })().finally(() => this.bindingFlights.delete(key))
    this.bindingFlights.set(key, promise)
    return promise
  }

  private async stopInternal(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer)
    if (this.modelSelectionRetryTimer !== undefined) clearTimeout(this.modelSelectionRetryTimer)
    this.timer = undefined
    this.modelSelectionRetryTimer = undefined
    await Promise.all([this.inbound.stop(), this.outbound.stop(), this.modelSelectionFlight])
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
        const finishWithoutReply = (result: ModelSelectionResult) =>
          this.deliveryStore.completeModelSelectionSettlement({
            operationId: claim.operationId,
            payloadHash: claim.payloadHash,
            result,
            ownerId: this.ownerId,
            fencingToken: claim.fencingToken,
          }) as ModelSelectionResult
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
          subject: { kind: 'external', id: externalId(payload.principal) },
          action: 'ingest',
          resource: { kind: 'message', id: `model-selection:${binding.id}` },
          context: { initiator: 'external' },
        }).effect === 'allow'
        const complete = (
          binding: ConversationBinding,
          result: ModelSelectionResult,
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
          return this.deliveryStore.completeModelSelectionSettlement({
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
          }) as ModelSelectionResult
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
