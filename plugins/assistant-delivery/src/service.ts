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
  DeliveryAdapter,
  ExternalPrincipalKey,
  InboundEnvelope,
  InboxRecord,
  ModelPickerIntent,
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
    ctx.inject(['agents', 'sessions', 'llm'], runtimeCtx => this.registerInboundRuntime(new DshDeliveryRuntime(
      runtimeCtx,
      policy,
      { workspace: config.defaultWorkspace, agentPreset: config.defaultAgentPreset, policyRef: config.policyRef,
        provider: config.agentProvider, model: config.agentModel, maxOutputTokens: config.agentMaxOutputTokens,
        modelPickerTtlMs: config.modelPickerTtlMs,
        getModelSelection: conversation => this.deliveryStore.getModelSelection(conversation),
        setModelSelection: (conversation, route) => this.deliveryStore.setModelSelection(conversation, route),
        clearModelSelection: conversation => this.deliveryStore.clearModelSelection(conversation),
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
      },
    )))
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

  async settleModelSelection(input: {
    operationId: string
    callbackEventId: string
    callbackChatId: string
    bindingId: string
    principal: ExternalPrincipalKey
    provider: string
    modelProvider: string
    model: string
    reasoningEffort?: string
  }): Promise<
    | { status: 'rejected'; reason: 'invalid-effort' | 'model-unavailable' | 'provider-model-mismatch' | 'provider-unavailable' }
    | { status: 'selected'; selection: ReturnType<DeliveryStore['setModelSelection']> }
  > {
    this.assertActive()
    const binding = this.deliveryStore.getBinding(input.bindingId)
    const current = this.deliveryStore.getPrincipal(input.principal)
    if (binding?.status !== 'active' || current?.status !== 'active'
      || binding.conversation.chat !== input.callbackChatId
      || JSON.stringify(binding.principal) !== JSON.stringify(current.principal)) {
      throw new AssistantDeliveryError('missing-binding', 'model callback principal or chat does not own the active binding')
    }
    const authorization = this.policy.authorize({ subject: { kind: 'external', id: externalId(current.principal) },
      action: 'ingest', resource: { kind: 'message', id: `model-selection:${binding.id}` },
      context: { initiator: 'external' } },
    { idempotencyKey: `model-selection:${input.operationId}:${input.callbackEventId}` })
    if (authorization.effect !== 'allow') throw policyDenied(authorization)
    const enqueueReply = (text: string) => this.deliveryStore.enqueue({
      idempotencyKey: `model-selection:${input.callbackEventId}:reply`,
      bindingId: binding.id,
      target: { conversation: binding.conversation, principal: binding.principal },
      text,
      format: 'plain',
    })
    if (input.provider !== input.modelProvider) {
      enqueueReply(`分组 ${input.provider} 与模型 ${input.modelProvider}/${input.model} 不匹配，请重新发送 /model。`)
      return { status: 'rejected', reason: 'provider-model-mismatch' }
    }
    const llm = this.ctx.get('llm')
    if (llm === undefined || !llm.listProviders().some(provider => provider.id === input.provider)) {
      enqueueReply(`模型分组 ${input.provider} 当前不可用，请重新发送 /model。`)
      return { status: 'rejected', reason: 'provider-unavailable' }
    }
    let resolved: Awaited<ReturnType<typeof llm.resolveModelInfo>>
    try {
      resolved = await llm.resolveModelInfo(input.provider, input.model)
    } catch {
      enqueueReply(`模型 ${input.provider}/${input.model} 当前不可用，请重新发送 /model。`)
      return { status: 'rejected', reason: 'model-unavailable' }
    }
    if (input.reasoningEffort !== undefined
      && !resolved.reasoning?.efforts.some(effort => String(effort.id) === input.reasoningEffort)) {
      enqueueReply(`模型 ${input.provider}/${input.model} 不支持 effort “${input.reasoningEffort}”，请重新发送 /model。`)
      return { status: 'rejected', reason: 'invalid-effort' }
    }
    const selection = this.deliveryStore.setModelSelection(binding.conversation, {
      provider: input.provider,
      model: input.model,
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
    })
    enqueueReply(`已切换到 ${input.provider}/${input.model}${input.reasoningEffort === undefined
      ? '，effort：默认'
      : `，effort：${input.reasoningEffort}`}。下一条消息起生效，上下文保留。`)
    return { status: 'selected', selection }
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
    return this.deliveryStore.getModelPicker(input.operationId, input.bindingId)
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
    format?: 'model-picker' | 'plain'
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
      format: input.format ?? 'plain',
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
    await this.outbound.tick()
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await Promise.all([this.inbound.whenIdle(), this.outbound.whenIdle()])
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
    this.timer = undefined
    await Promise.all([this.inbound.stop(), this.outbound.stop()])
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantDeliveryError('disposed', 'assistant-delivery service is disposed')
  }
}

export const Config = AssistantDeliveryService.Config
