import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import type {
  AssistantDeliveryService,
} from '@dsh-enhanced/assistant-delivery'
import type {
  ApprovalDispatchRouteV2,
  AssistantPolicyService,
  PolicyDecision,
} from '@dsh-enhanced/assistant-policy'
import { MemoryPromotionCancelledError, MemoryProposalManager } from './proposals.js'
import {
  memoryPrincipalDigest,
  MemoryStore,
} from './store.js'
import {
  PreferenceMemoryPromotionBridge,
  preferencePromotionMutation,
  preferencePromotionNamespace,
} from './promotion.js'
import { registerMemoryTools } from './tools.js'
import type {
  MemoryAgentContext,
  MemoryEntryInput,
  MemoryIdentity,
  MemoryImportBatchResult,
  MemoryMutation,
  MemoryOwnerNamespace,
  MemoryProposalDecisionInput,
  MemoryProposalResult,
  MemoryRecord,
  MemorySearchHit,
  MemorySnapshot,
  StoredMemoryProposal,
} from './types.js'
import {
  withPreferenceMemoryPromotionSubmissionDigest,
  type PreferenceMemoryPromotionCancellationReceipt,
  type PreferenceMemoryPromotionCancellationRequest,
  type PreferenceMemoryPromotionRequest,
  type PreferenceMemoryPromotionResult,
  type PreferenceMemoryPromotionResultAck,
  type PreferenceMemoryPromotionSubmissionReceipt,
} from '@dsh-enhanced/assistant-growth-contract'

export interface Config {
  databasePath: string
  approvalMode?: 'delivery-or-headless' | 'delivery-required'
  maxContentBytes?: number
  maxRecordsPerIdentity?: number
  searchLimit?: number
  snapshotLimit?: number
  snapshotMaxBytes?: number
  snapshotMaxTokens?: number
  defaultProposalTtlMs?: number
  maxImportRecords?: number
  /**
   * Poll interval for committing proposals that were approved out of band, for
   * example on an approval card after the originating turn ended. `0` disables
   * the timer; `reconcileProposals()` can still be driven by a trusted host.
   */
  reconcileIntervalMs?: number
  /** Maximum locally pending proposals inspected per reconcile pass. */
  reconcileLimit?: number
}

export interface ServiceSearchRequest {
  query: string
  limit?: number
  authorizationIdempotencyKey?: string
}

export interface ServiceProposalInput {
  idempotencyKey: string
  /** Trusted headless fallback. Agent-facing calls derive this from Delivery. */
  principal?: string
  ttlMs?: number
  mutation: MemoryMutation
}

export interface ServiceImportInput {
  json: string
  idempotencyKey: string
  /** Trusted headless fallback. Agent-facing calls derive this from Delivery. */
  principal?: string
  ttlMs?: number
}

export type PersonalMemoryErrorCode =
  | 'disposed'
  | 'identity-mismatch'
  | 'invalid-import'
  | 'missing-identity'
  | 'missing-approval-route'
  | 'not-found'
  | 'policy-denied'
  | 'unauthorized-principal'

export class PersonalMemoryError extends Error {
  constructor(readonly code: PersonalMemoryErrorCode, message: string) {
    super(message)
    this.name = 'PersonalMemoryError'
  }
}

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  approvalMode: Schema.union(['delivery-or-headless', 'delivery-required'] as const)
    .default('delivery-required'),
  maxContentBytes: Schema.number().step(1).min(1).default(4_096),
  maxRecordsPerIdentity: Schema.number().step(1).min(1).default(1_000),
  searchLimit: Schema.number().step(1).min(1).max(100).default(20),
  snapshotLimit: Schema.number().step(1).min(1).max(100).default(20),
  snapshotMaxBytes: Schema.number().step(1).min(1).default(8_192),
  snapshotMaxTokens: Schema.number().step(1).min(1).default(2_048),
  defaultProposalTtlMs: Schema.number().step(1).min(1).default(900_000),
  maxImportRecords: Schema.number().step(1).min(1).max(1_000).default(100),
  reconcileIntervalMs: Schema.number()
    .step(1)
    .min(0)
    .max(2_147_483_647)
    .default(15_000),
  reconcileLimit: Schema.number().step(1).min(1).max(1_000).default(50),
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    personalMemory: PersonalMemoryService
  }
}

function decisionError(decision: PolicyDecision): PersonalMemoryError {
  return new PersonalMemoryError('policy-denied', `personal-memory policy denied operation: ${decision.reasonCode}`)
}

const APPROVAL_SOURCE_ID = 'dsh-enhanced-personal-memory'

export class PersonalMemoryService extends Service {
  static Config = configSchema

  private readonly memoryStore: MemoryStore
  private readonly proposals: MemoryProposalManager
  private readonly policy: AssistantPolicyService
  private delivery: Pick<AssistantDeliveryService,
    'prepareAgentApproval' | 'preferencePrincipalForAgent' | 'prepareOwnerApprovalForPreference'> | undefined
  private readonly promotionBridge: PreferenceMemoryPromotionBridge
  private readonly headlessNamespaces = new WeakMap<Agent, MemoryOwnerNamespace>()
  private readonly config: Required<Config>
  private readonly sessionSnapshots = new WeakMap<Agent, MemorySnapshot>()
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'personalMemory')
    let config: Required<Config>
    try {
      config = PersonalMemoryService.Config(input) as Required<Config>
    } catch (error) {
      throw new Error(`personal-memory: invalid configuration: ${String(error)}`, { cause: error })
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('personal-memory: assistantPolicy service is required')
    this.config = config
    this.policy = policy
    this.delivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    this.memoryStore = new MemoryStore({
      path: config.databasePath,
      maxContentBytes: config.maxContentBytes,
      maxRecordsPerIdentity: config.maxRecordsPerIdentity,
    })
    this.proposals = new MemoryProposalManager(
      this.memoryStore,
      policy,
      proposal => this.validatePromotionOwner(proposal),
    )
    this.promotionBridge = new PreferenceMemoryPromotionBridge({
      submit: request => this.submitPreferencePromotion(request),
      cancel: request => this.cancelPreferencePromotion(request),
      list: limit => this.listPromotionResults(limit),
      acknowledge: ack => this.acknowledgePromotionResult(ack),
    })

    ctx.inject(['assistantDelivery'], (deliveryCtx) => {
      const delivery = deliveryCtx.get('assistantDelivery') as AssistantDeliveryService
      this.delivery = delivery
      return () => {
        if (this.delivery === delivery) this.delivery = undefined
      }
    })
    const currentPreference = ctx.get('assistantPreferenceLearning' as never) as unknown
    this.promotionBridge.bind(currentPreference)
    ctx.inject(['assistantPreferenceLearning' as never], preferenceCtx => {
      const producer = preferenceCtx.get('assistantPreferenceLearning' as never) as unknown
      if (producer === currentPreference) return
      return this.promotionBridge.bind(producer)
    })

    ctx.effect(() => () => {
      this.active = false
      this.promotionBridge.dispose()
      this.memoryStore.close()
    }, 'personal-memory.database')
    if (config.reconcileIntervalMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          // A reconcile pass must never take the service down; the next tick retries.
          try {
            this.reconcileProposals()
          } catch {
            // Intentionally ignored: the authoritative state stays in the ledger.
          }
        }, config.reconcileIntervalMs)
        timer.unref?.()
        return () => clearInterval(timer)
      }, 'personal-memory.reconcile')
    }
    ctx.on('agent/session-start', ({ agent }) => {
      this.injectSessionSnapshot(agent)
    })
    ctx.inject(['tools'], (toolsCtx) => {
      registerMemoryTools(toolsCtx, this)
    })
  }

  search(agent: Agent | undefined, request: ServiceSearchRequest): MemorySearchHit[] {
    this.assertActive()
    this.agentScope(agent)
    const authorizationOptions = request.authorizationIdempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.authorizationIdempotencyKey }
    const decision = this.policy.authorizeAgent(
      agent,
      'search',
      { kind: 'memory', id: 'visible' },
      authorizationOptions,
    )
    if (decision.effect !== 'allow') throw decisionError(decision)
    const context = this.agentContext(agent)
    return this.memoryStore.search({
      context,
      query: request.query,
      limit: request.limit ?? this.config.searchLimit,
    })
  }

  /**
   * Narrow background-review seam.  Its trust/kind/sensitivity filters are
   * service-owned so a maintenance Agent cannot widen them through tool args.
   */
  searchConfirmedGuidance(agent: Agent | undefined, request: ServiceSearchRequest): MemorySearchHit[] {
    this.assertActive()
    const context = this.agentContext(agent)
    const authorizationOptions = request.authorizationIdempotencyKey === undefined
      ? {}
      : { idempotencyKey: request.authorizationIdempotencyKey }
    const decision = this.policy.authorizeAgent(
      agent,
      'search',
      { kind: 'memory', id: 'visible' },
      authorizationOptions,
    )
    if (decision.effect !== 'allow') throw decisionError(decision)
    return this.memoryStore.search({
      context,
      query: request.query,
      limit: request.limit ?? this.config.searchLimit,
      kinds: ['instruction', 'preference'],
      trusts: ['user-confirmed'],
      sensitivities: ['private'],
    })
  }

  read(agent: Agent | undefined, request: { ids: readonly string[] }): MemoryRecord[] {
    this.assertActive()
    const context = this.agentContext(agent)
    const decision = this.policy.authorizeAgent(agent, 'read', { kind: 'memory', id: 'selected' }, {
      idempotencyKey: `memory-read:${request.ids.join(':')}`,
    })
    if (decision.effect !== 'allow') throw decisionError(decision)
    try {
      return this.memoryStore.read(context, request.ids)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'not-found') {
        throw new PersonalMemoryError('not-found', error.message)
      }
      throw error
    }
  }

  propose(agent: Agent | undefined, input: ServiceProposalInput): MemoryProposalResult {
    this.assertActive()
    const scope = this.agentScope(agent)
    const approval = this.resolveApprovalRoute(agent, scope, input.principal)
    const context: MemoryAgentContext = { ...scope, namespace: approval.namespace }
    this.assertMutationIdentity(context, input.mutation)
    const decision = this.policy.authorizeAgent(agent, 'propose', {
      kind: 'memory', id: input.mutation.op,
    }, { idempotencyKey: `memory-propose:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw decisionError(decision)
    const ttlMs = input.ttlMs ?? this.config.defaultProposalTtlMs
    return this.proposals.propose({
      idempotencyKey: input.idempotencyKey,
      requester: `agent:${context.agentPreset}`,
      principal: approval.principal,
      namespace: context.namespace,
      ...(approval.dispatch === undefined ? {} : { dispatch: approval.dispatch }),
      ttlMs,
      mutation: input.mutation,
    })
  }

  decideProposal(input: MemoryProposalDecisionInput): MemoryProposalResult {
    this.assertActive()
    return this.proposals.decide(input)
  }

  /**
   * Commit proposals whose policy decision settled after the originating turn.
   * Without this, an approval granted on a chat card would leave the memory
   * proposal pending forever. Safe to call repeatedly.
   */
  reconcileProposals(limit?: number): MemoryProposalResult[] {
    this.assertActive()
    return this.proposals.reconcile(limit ?? this.config.reconcileLimit)
  }

  exportJson(agent: Agent | undefined): string {
    this.assertActive()
    const context = this.agentContext(agent)
    const decision = this.policy.authorizeAgent(agent, 'export', { kind: 'memory', id: 'visible' }, {
      idempotencyKey: `memory-export:${String(agent?.id)}`,
    })
    if (decision.effect !== 'allow') throw decisionError(decision)
    return JSON.stringify(this.memoryStore.exportDocument(context), null, 2)
  }

  proposeImport(agent: Agent | undefined, input: ServiceImportInput): MemoryImportBatchResult {
    this.assertActive()
    const scope = this.agentScope(agent)
    let decoded: unknown
    try {
      decoded = JSON.parse(input.json)
    } catch (error) {
      throw new PersonalMemoryError('invalid-import', `memory import is not valid JSON: ${String(error)}`)
    }
    const document = decoded as {
      format?: unknown
      version?: unknown
      records?: unknown
    }
    if (typeof document !== 'object' || document === null
      || document.format !== 'dsh-personal-memory'
      || document.version !== 1
      || !Array.isArray(document.records)
      || document.records.length > this.config.maxImportRecords) {
      throw new PersonalMemoryError('invalid-import', 'memory import format, version, or record count is invalid')
    }
    const approval = this.resolveApprovalRoute(agent, scope, input.principal)
    const context: MemoryAgentContext = { ...scope, namespace: approval.namespace }
    let mutations: MemoryMutation[]
    try {
      mutations = document.records.map((value) => {
        if (typeof value !== 'object' || value === null) throw new Error('record must be an object')
        const record = value as { identity?: unknown; entry?: unknown }
        const mutation = this.memoryStore.normalizeMutation({
          op: 'add',
          identity: record.identity as MemoryIdentity,
          entry: record.entry as MemoryEntryInput,
        }, { namespace: context.namespace })
        this.assertMutationIdentity(context, mutation)
        return mutation
      })
    } catch (error) {
      throw new PersonalMemoryError('invalid-import', `memory import record is invalid: ${String(error)}`)
    }
    const proposals = mutations.map((mutation, index) => this.propose(agent, {
      idempotencyKey: `${input.idempotencyKey}:${index}`,
      ...(input.principal === undefined ? {} : { principal: input.principal }),
      ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
      mutation,
    }))
    return Object.freeze({ proposals: Object.freeze(proposals) })
  }

  getProposal(proposalId: string, principal: string): MemoryProposalResult | undefined {
    this.assertActive()
    const proposal = this.proposals.getProposal(proposalId)
    if (proposal === undefined) return undefined
    const stored = this.memoryStore.getProposal(proposalId)
    if (stored?.principal !== principal) {
      throw new PersonalMemoryError('unauthorized-principal', 'memory proposal is bound to another principal')
    }
    return proposal
  }

  health(): ReturnType<MemoryStore['health']> {
    this.assertActive()
    return this.memoryStore.health()
  }

  /** Trusted producer registration hook; intentionally not exposed as a model tool. */
  bindPreferencePromotionProducer(producer: unknown): (() => void) | undefined {
    this.assertActive()
    return this.promotionBridge.bind(producer)
  }

  private submitPreferencePromotion(
    request: Readonly<PreferenceMemoryPromotionRequest>,
  ): Readonly<PreferenceMemoryPromotionSubmissionReceipt> {
    this.assertActive()
    const namespace = preferencePromotionNamespace(request, memoryPrincipalDigest(request.principalId))
    const mutation = preferencePromotionMutation(request)
    const now = Date.now()
    const ttlMs = Math.max(1, request.deadlineAt - Math.min(request.observedAt, now))
    const promotion = Object.freeze({
      promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest,
      scope: request.scope,
      ownerGeneration: request.ownerGeneration,
    })
    const base = {
      idempotencyKey: request.idempotencyKey,
      requester: 'preference-learning',
      principal: request.principalId,
      namespace,
      ttlMs,
      notAfter: request.deadlineAt,
      promotion,
      mutation,
    }
    let proposal: MemoryProposalResult
    try {
      if (request.deadlineAt <= now) {
        proposal = this.proposals.rejectPromotionBeforePolicy({
          ...base,
          promotion: { ...promotion, prePolicyStatus: 'expired' },
        }, 'expired')
      } else {
      const route = this.delivery?.prepareOwnerApprovalForPreference({
        sourceId: APPROVAL_SOURCE_ID,
        scope: request.scope,
        principalId: request.principalId,
        principalLineage: request.principalLineage,
        ownerGeneration: request.ownerGeneration,
      })
        if (route === undefined) {
          throw new PersonalMemoryError(
            'missing-approval-route',
            'Preference promotion requires the trusted Delivery owner-route resolver',
          )
        }
        if ('kind' in route) {
          proposal = this.proposals.rejectPromotionBeforePolicy({
            ...base,
            promotion: { ...promotion, prePolicyStatus: 'stale-owner' },
          }, 'stale-owner')
        } else {
          if (!this.routeMatchesPromotion(route, request)) {
            throw new PersonalMemoryError(
              'unauthorized-principal',
              'Preference promotion Delivery route changed its frozen owner authority',
            )
          }
          proposal = this.proposals.propose({ ...base, dispatch: route })
        }
      }
    } catch (error) {
      if (error instanceof MemoryPromotionCancelledError) {
        throw Object.assign(new Error('Preference promotion was durably cancelled'), {
          code: 'promotion-cancelled', receipt: error.receipt,
        })
      }
      throw error
    }
    return withPreferenceMemoryPromotionSubmissionDigest({
      contractVersion: 1 as const,
      promotionId: request.promotionId,
      promotionGeneration: request.promotionGeneration,
      requestDigest: request.requestDigest,
      outcome: proposal.replayed ? 'replayed' as const : 'accepted' as const,
      memoryProposalId: proposal.proposalId,
    })
  }

  private cancelPreferencePromotion(
    request: Readonly<PreferenceMemoryPromotionCancellationRequest>,
  ): Readonly<PreferenceMemoryPromotionCancellationReceipt> {
    this.assertActive()
    return this.memoryStore.cancelPromotionBeforeOrAfterSubmit(request).receipt
  }

  private listPromotionResults(limit: number): readonly Readonly<PreferenceMemoryPromotionResult>[] {
    this.assertActive()
    return this.memoryStore.listPendingPromotionResults(limit).map(result => {
      const common = {
        contractVersion: 1 as const,
        promotionId: result.promotionId,
        promotionGeneration: result.promotionGeneration,
        requestDigest: result.requestDigest,
        resultVersion: result.resultVersion,
        occurredAt: result.occurredAt,
        receiptDigest: result.receiptDigest,
      }
      if (result.status === 'stale-owner') return Object.freeze({ ...common, status: result.status })
      if (result.status === 'rejected') {
        return Object.freeze({
          ...common, status: result.status, rejectionKind: 'owner-explicit' as const,
          memoryProposalId: result.memoryProposalId,
          memoryProposalVersion: result.memoryProposalVersion,
        })
      }
      if (result.status === 'confirmed') {
        if (result.memoryRecordId === undefined || result.memoryRecordVersion === undefined
          || result.memoryRecordDigest === undefined) {
          throw new PersonalMemoryError('not-found', 'confirmed promotion result lost its Memory record')
        }
        return Object.freeze({
          ...common, status: result.status,
          memoryProposalId: result.memoryProposalId,
          memoryProposalVersion: result.memoryProposalVersion,
          memoryRecordId: result.memoryRecordId,
          memoryRecordVersion: result.memoryRecordVersion,
          memoryRecordDigest: result.memoryRecordDigest,
        })
      }
      return Object.freeze({
        ...common, status: result.status,
        memoryProposalId: result.memoryProposalId,
        memoryProposalVersion: result.memoryProposalVersion,
      })
    })
  }

  private acknowledgePromotionResult(ack: Readonly<PreferenceMemoryPromotionResultAck>): void {
    this.assertActive()
    const result = this.memoryStore.getPromotionResult(
      ack.promotionId,
      ack.promotionGeneration,
      ack.resultVersion,
    )
    if (result === undefined || result.receiptDigest !== ack.receiptDigest) {
      throw new PersonalMemoryError('not-found', 'Preference promotion result acknowledgement changed identity')
    }
    this.memoryStore.completePromotionResult(result)
  }

  private validatePromotionOwner(proposal: StoredMemoryProposal): 'current' | 'stale-owner' {
    if (proposal.promotion === undefined || proposal.namespace.mode !== 'delivery') return 'current'
    const result = this.delivery?.prepareOwnerApprovalForPreference({
      sourceId: APPROVAL_SOURCE_ID,
      scope: proposal.promotion.scope,
      principalId: proposal.principal,
      principalLineage: {
        principalRecordId: proposal.namespace.principalRecordId,
        principalVersion: proposal.namespace.principalVersion,
      },
      ownerGeneration: proposal.promotion.ownerGeneration,
    })
    if (result === undefined) {
      throw new PersonalMemoryError('missing-approval-route', 'Preference promotion owner resolver is unavailable')
    }
    if ('kind' in result) return 'stale-owner'
    return this.routeMatchesProposal(result, proposal) ? 'current' : 'stale-owner'
  }

  private injectSessionSnapshot(agent: Agent): void {
    if (this.sessionSnapshots.has(agent)) return
    let context: MemoryAgentContext
    try {
      context = this.agentContext(agent)
    } catch (error) {
      if (error instanceof PersonalMemoryError && error.code === 'missing-identity') return
      throw error
    }
    const decision = this.policy.authorizeAgent(agent, 'snapshot', { kind: 'memory', id: 'visible' }, {
      idempotencyKey: `memory-snapshot:${agent.id}`,
    })
    if (decision.effect !== 'allow') return
    const snapshot = this.memoryStore.snapshot({
      context,
      limit: this.config.snapshotLimit,
      maxBytes: this.config.snapshotMaxBytes,
      maxTokens: this.config.snapshotMaxTokens,
    })
    this.sessionSnapshots.set(agent, snapshot)
    if (snapshot.text === '') return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: snapshot.text }],
      source: { kind: 'plugin', plugin: 'personal-memory' },
    }))
  }

  private assertMutationIdentity(context: MemoryAgentContext, mutation: MemoryMutation): void {
    const identity = mutation.identity
    if (identity.scope === 'workspace' && identity.workspace !== context.workspace) {
      throw new PersonalMemoryError('identity-mismatch', 'workspace memory must target the current workspace')
    }
    if (identity.owner === 'agent' && identity.agentPreset !== context.agentPreset) {
      throw new PersonalMemoryError('identity-mismatch', 'agent memory must target the current agent preset')
    }
  }

  private resolveApprovalRoute(
    agent: Agent | undefined,
    context: Readonly<{ workspace: string; agentPreset: string }>,
    explicitPrincipal: string | undefined,
  ): {
    principal: string
    namespace: MemoryOwnerNamespace
    dispatch?: ReturnType<AssistantDeliveryService['prepareAgentApproval']>
  } {
    if (this.delivery === undefined) {
      if (this.config.approvalMode === 'delivery-required') {
        throw new PersonalMemoryError(
          'missing-approval-route',
          'memory proposal requires an authenticated Delivery owner route',
        )
      }
      if (explicitPrincipal === undefined || explicitPrincipal.trim() === '') {
        throw new PersonalMemoryError(
          'missing-approval-route',
          'memory proposal requires an authenticated Delivery route or an explicit trusted headless principal',
        )
      }
      const principalDigest = memoryPrincipalDigest(explicitPrincipal)
      const namespace: MemoryOwnerNamespace = Object.freeze({
        mode: 'headless',
        principalDigest,
        lineageId: `headless:${principalDigest}`,
        lineageVersion: 1,
      })
      if (agent !== undefined) this.headlessNamespaces.set(agent, namespace)
      return { principal: explicitPrincipal, namespace }
    }
    const dispatch = this.delivery.prepareAgentApproval(agent, {
      sourceId: APPROVAL_SOURCE_ID,
    })
    if (dispatch.routeVersion !== 2
      || dispatch.sourceId !== APPROVAL_SOURCE_ID
      || dispatch.workspace !== context.workspace
      || dispatch.bindingId.trim() === ''
      || dispatch.principal.trim() === '') {
      throw new PersonalMemoryError(
        'missing-approval-route',
        'memory proposal Delivery route does not match the current agent workspace',
      )
    }
    if (explicitPrincipal !== undefined && explicitPrincipal !== dispatch.principal) {
      throw new PersonalMemoryError(
        'unauthorized-principal',
        'memory proposal principal does not match the authenticated Delivery owner',
      )
    }
    const namespace: MemoryOwnerNamespace = Object.freeze({
      mode: 'delivery',
      principalDigest: memoryPrincipalDigest(dispatch.principal),
      principalRecordId: dispatch.principalRecordId,
      principalVersion: dispatch.principalVersion,
    })
    return { principal: dispatch.principal, namespace, dispatch }
  }

  private agentContext(
    agent: Agent | undefined,
    explicitHeadlessPrincipal?: string,
  ): MemoryAgentContext {
    const scope = this.agentScope(agent)
    const attestation = agent !== undefined
      && typeof this.delivery?.preferencePrincipalForAgent === 'function'
      ? this.delivery.preferencePrincipalForAgent(agent)
      : undefined
    if (attestation !== undefined
      && attestation.scope.workspace === scope.workspace
      && attestation.scope.preset === scope.agentPreset) {
      return {
        ...scope,
        namespace: {
          mode: 'delivery',
          principalDigest: memoryPrincipalDigest(attestation.principalId),
          principalRecordId: attestation.principalLineage.principalRecordId,
          principalVersion: attestation.principalLineage.principalVersion,
        },
      }
    }
    const headless = agent === undefined ? undefined : this.headlessNamespaces.get(agent)
    if (this.delivery === undefined && headless !== undefined) return { ...scope, namespace: headless }
    if (this.delivery === undefined && this.config.approvalMode === 'delivery-or-headless'
      && explicitHeadlessPrincipal !== undefined && explicitHeadlessPrincipal.trim() !== '') {
      const principalDigest = memoryPrincipalDigest(explicitHeadlessPrincipal)
      const namespace: MemoryOwnerNamespace = Object.freeze({
        mode: 'headless',
        principalDigest,
        lineageId: `headless:${principalDigest}`,
        lineageVersion: 1,
      })
      if (agent !== undefined) this.headlessNamespaces.set(agent, namespace)
      return { ...scope, namespace }
    }
    throw new PersonalMemoryError(
      'missing-identity',
      'memory operation requires a current authenticated owner namespace',
    )
  }

  private agentScope(agent: Agent | undefined): { workspace: string; agentPreset: string } {
    if (agent === undefined) throw new PersonalMemoryError('missing-identity', 'memory operation requires an agent')
    const workspace = agent.session.header.cwd
    const agentPreset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || agentPreset === undefined || agentPreset === '') {
      throw new PersonalMemoryError('missing-identity', 'memory operation requires an absolute workspace and agent preset')
    }
    return { workspace, agentPreset }
  }

  private routeMatchesPromotion(
    route: Readonly<ApprovalDispatchRouteV2>,
    request: Readonly<PreferenceMemoryPromotionRequest>,
  ): boolean {
    return route.routeVersion === 2
      && route.sourceId === APPROVAL_SOURCE_ID
      && route.workspace === request.scope.workspace
      && route.principal === request.principalId
      && route.principalRecordId === request.principalLineage.principalRecordId
      && route.principalVersion === request.principalLineage.principalVersion
      && route.bindingGeneration === request.ownerGeneration
  }

  private routeMatchesProposal(
    route: Readonly<ApprovalDispatchRouteV2>,
    proposal: Readonly<StoredMemoryProposal>,
  ): boolean {
    if (proposal.namespace.mode !== 'delivery' || proposal.promotion === undefined) return false
    return route.routeVersion === 2
      && route.sourceId === APPROVAL_SOURCE_ID
      && route.workspace === proposal.promotion.scope.workspace
      && route.principal === proposal.principal
      && route.principalRecordId === proposal.namespace.principalRecordId
      && route.principalVersion === proposal.namespace.principalVersion
      && route.bindingGeneration === proposal.promotion.ownerGeneration
  }

  private assertActive(): void {
    if (!this.active) throw new PersonalMemoryError('disposed', 'personal-memory service is disposed')
  }
}
