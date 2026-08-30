import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import type {
  ApprovalDispatchRoute,
  ApprovalProposalRecoveryInput,
  ApprovalProposalResult,
  ApprovalProposalSnapshot,
  AssistantPolicyService,
} from '@dsh-enhanced/assistant-policy'
import {
  ApprovalSettlementConflict,
  validateApprovalSettlement,
} from '@dsh-enhanced/assistant-policy'
import { buildGuidance, buildGuidanceSnapshot } from './guidance.js'
import { evolutionMutationReview } from './review.js'
import { EvolutionStore, EvolutionStoreError, evolutionDigest } from './store.js'
import { registerEvolutionTools } from './tools.js'
import type {
  EvolutionCreationIntent,
  EvolutionMutation,
  EvolutionProposalMutation,
  RuleCandidate,
  StoredAutonomousRollback,
  StoredEpisode,
  StoredProposal,
  StoredRule,
} from './types.js'
import { legacyEvolutionScope } from './types.js'

export interface Config {
  databasePath: string
  /** Recent episodes per situation considered when judging a rule. */
  evaluationWindow?: number
  /** Minimum observations before any candidate is emitted. */
  minSample?: number
  /** Failure rate at or above which a situation becomes an adopt candidate. */
  adoptFailureRate?: number
  /** Failure rate at or above which an active rule becomes a retire candidate. */
  retireFailureRate?: number
  maxCandidates?: number
  /** Bounded newest-first episode details shown for each candidate. */
  maxEvidenceSamples?: number
  /** Active rules injected per session. */
  maxInjectedRules?: number
  /** Byte ceiling for the injected guidance block. */
  maxGuidanceBytes?: number
  maxRuleGuidanceBytes?: number
  defaultProposalTtlMs?: number
  /** Poll interval for committing decisions settled after the originating turn. */
  reconcileIntervalMs?: number
  reconcileLimit?: number
  /**
   * Permit the narrow evidence-gated rollback lane. This only enables the code
   * path; Policy must independently allow exact `rollback` actions.
   */
  autonomousRollback?: boolean
}

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  evaluationWindow: Schema.number().step(1).min(1).max(10_000).default(20),
  minSample: Schema.number().step(1).min(1).max(10_000).default(5),
  adoptFailureRate: Schema.number().min(0).max(1).default(0.4),
  retireFailureRate: Schema.number().min(0).max(1).default(0.4),
  maxCandidates: Schema.number().step(1).min(1).max(100).default(10),
  maxEvidenceSamples: Schema.number().step(1).min(1).max(50).default(8),
  maxInjectedRules: Schema.number().step(1).min(1).max(100).default(12),
  maxGuidanceBytes: Schema.number().step(1).min(1).max(65_536).default(4_096),
  maxRuleGuidanceBytes: Schema.number().step(1).min(1).max(16_384).default(2_048),
  defaultProposalTtlMs: Schema.number().step(1).min(1).default(900_000),
  reconcileIntervalMs: Schema.number().step(1).min(0).default(15_000),
  reconcileLimit: Schema.number().step(1).min(1).max(1_000).default(50),
  autonomousRollback: Schema.boolean().default(false),
}) as Schema<Config>

const evolutionApprovalSource = 'dsh-enhanced-assistant-evolution'

interface EvolutionApprovalDelivery {
  prepareAgentApproval(agent: Agent | undefined, input: { sourceId: string }): ApprovalDispatchRoute
}

export type AssistantEvolutionErrorCode =
  | 'disposed'
  | 'forbidden'
  | 'invalid-input'
  | 'missing-identity'
  | 'not-found'

export class AssistantEvolutionError extends Error {
  constructor(readonly code: AssistantEvolutionErrorCode, message: string) {
    super(message)
    this.name = 'AssistantEvolutionError'
  }
}

export interface EvolutionProposalResult {
  proposalId: string
  policyProposalId: string
  status: StoredProposal['status']
  version: number
  replayed: boolean
  rule: StoredRule | undefined
}

export interface EvolutionRollbackResult {
  rollback: StoredAutonomousRollback
  rule: StoredRule
  replayed: boolean
}

/** Content-free, global operational summary for local health aggregation. */
export interface AssistantEvolutionHealth {
  activeRules: number
  retiredRules: number
  pendingProposals: number
  conflictedProposals: number
  trustedEpisodes: number
  unattributedTrustedEpisodes: number
  lastTrustedEpisodeAt: number
  /** Last fully completed reconciliation pass; zero means none has completed. */
  lastReconciledAt: number
  autonomousRollbacks: number
}

export interface ForegroundEpisodeInput {
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  /** Model-reported association retained as an untrusted claim only. */
  ruleId?: string
  source?: 'foreground'
  occurredAt: number
  idempotencyKey: string
}

export function canonicalEvolutionScope(workspace: string, preset: string): string {
  const normalizedPreset = preset.normalize('NFC').trim()
  if (!isAbsolute(workspace) || normalizedPreset === '') {
    throw new AssistantEvolutionError(
      'missing-identity',
      'evolution scope requires absolute workspace and non-empty preset',
    )
  }
  return JSON.stringify([resolve(workspace.normalize('NFC')), normalizedPreset])
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantEvolution: AssistantEvolutionService }
}

function result(
  proposal: StoredProposal,
  replayed: boolean,
  rule: StoredRule | undefined = undefined,
): EvolutionProposalResult {
  return Object.freeze({
    proposalId: proposal.proposalId,
    policyProposalId: proposal.policyProposalId ?? '',
    status: proposal.status,
    version: proposal.version,
    replayed,
    rule,
  })
}

function ruleIdFromStableMutation(stable: string): string {
  const hex = createHash('sha256').update(`assistant-evolution-rule:${stable}`).digest('hex')
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return `rule-${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-`
    + `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Approval-gated behavioural self-evolution.
 *
 * The loop is: observe outcomes, detect candidate rule changes, ask the owner, and
 * only then let an approved rule shape future sessions as injected advisory
 * context. Three boundaries are structural rather than cosmetic:
 *
 * - **No self-adoption.** New or changed guidance is always an
 *   `assistant-policy` proposal. The only optional autonomous mutation removes
 *   an exact active rule after Host-recomputed regression evidence; it can never
 *   create or revise guidance.
 * - **No privilege growth.** Guidance is injected as data and policy never reads
 *   the rule table, so a rule can change approach but never authority.
 * - **No in-place revision.** Replacement is always retire-then-adopt. A rollback
 *   may remove the old rule, but the replacement still needs its own approval,
 *   so an old decision can never silently cover new guidance.
 */
export class AssistantEvolutionService extends Service {
  static Config = configSchema
  static inject = ['assistantPolicy']

  private readonly store: EvolutionStore
  private readonly policy: AssistantPolicyService
  private readonly config: Required<Config>
  private readonly injected = new WeakSet<Agent>()
  private readonly now: () => number
  private delivery: EvolutionApprovalDelivery | undefined
  private active = true
  private lastReconciledAt = 0

  constructor(ctx: Context, input: Config, options: { now?: () => number } = {}) {
    super(ctx, 'assistantEvolution')
    try {
      this.config = configSchema(input) as Required<Config>
    } catch (error) {
      throw new Error(`assistant-evolution: invalid configuration: ${String(error)}`, { cause: error })
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('assistant-evolution: assistantPolicy service is required')
    this.policy = policy
    this.now = options.now ?? Date.now
    this.store = new EvolutionStore({
      path: this.config.databasePath,
      maxGuidanceBytes: this.config.maxRuleGuidanceBytes,
    })

    ctx.inject(['assistantDelivery'], deliveryCtx => {
      const delivery = deliveryCtx.get('assistantDelivery') as EvolutionApprovalDelivery
      this.delivery = delivery
      return () => {
        if (this.delivery === delivery) this.delivery = undefined
      }
    })

    ctx.inject(['tools'], toolsCtx => registerEvolutionTools(toolsCtx, this))
    ctx.on('agent/session-start', ({ agent }) => {
      // Injection must never break session startup; a missing guidance block is
      // strictly better than an unstartable assistant.
      try {
        this.injectGuidance(agent)
      } catch (error) {
        if (!(error instanceof AssistantEvolutionError || error instanceof EvolutionStoreError)) throw error
      }
    })
    ctx.effect(() => () => {
      this.active = false
      this.store.close()
    }, 'assistant-evolution.database')
    if (this.config.reconcileIntervalMs > 0) {
      ctx.effect(() => {
        const timer = setInterval(() => {
          try {
            this.reconcileProposals()
          } catch {
            // Intentionally ignored: the authoritative state stays in the ledger.
          }
        }, this.config.reconcileIntervalMs)
        timer.unref?.()
        return () => clearInterval(timer)
      }, 'assistant-evolution.reconcile')
    }
  }

  /** Aggregate health seam. It never returns content, identities, scopes, or paths. */
  health(): Readonly<AssistantEvolutionHealth> {
    this.assertActive()
    return Object.freeze({
      ...this.store.health(),
      lastReconciledAt: this.lastReconciledAt,
    })
  }

  /** Record one observed outcome as evidence. */
  recordEpisode(agent: Agent | undefined, input: ForegroundEpisodeInput): StoredEpisode {
    const scopeKey = this.authorize(agent, 'append', `situation:${input.situation}`)
    return this.store.recordEpisode({
      scopeKey,
      situation: input.situation,
      outcome: input.outcome,
      detail: input.detail,
      source: 'foreground',
      trust: 'self-reported',
      ...(input.ruleId === undefined ? {} : { claimedRuleId: input.ruleId }),
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    })
  }

  /**
   * Record an outcome observed by trusted local infrastructure rather than a model
   * turn, for example a finished background automation run.
   *
   * There is no Agent to authorize here, so this is deliberately narrow: it can
   * only append evidence. It cannot adopt, retire, or read rules, so an automation
   * still cannot change its own behaviour without an owner decision.
   */
  recordAutomationOutcome(input: {
    situation: string
    outcome: 'succeeded' | 'failed'
    detail: string
    idempotencyKey: string
    occurredAt: number
    workspace?: string
    agentPreset?: string
    automationId?: string
    runId?: string
    sessionId?: string
    ruleId?: string
    guidanceVersion?: number
  }): StoredEpisode {
    this.assertActive()
    const trusted = input.workspace !== undefined && input.agentPreset !== undefined
      && isAbsolute(input.workspace) && input.agentPreset.trim() !== ''
    const scopeKey = trusted
      ? canonicalEvolutionScope(input.workspace!, input.agentPreset!)
      : legacyEvolutionScope
    const automationId = input.automationId?.normalize('NFC').trim()
    const expectedSituation = automationId === undefined || automationId === ''
      ? undefined
      : `automation:${automationId}`
    const receipt = trusted && expectedSituation !== undefined && input.sessionId !== undefined
      ? this.store.captureGuidanceExposure(input.sessionId, scopeKey, expectedSituation)
      : undefined
    const attributed = receipt !== undefined
      && input.situation.normalize('NFC').trim() === expectedSituation
      && input.ruleId === receipt.ruleId
      && input.guidanceVersion === receipt.guidanceVersion
      && input.occurredAt >= receipt.exposedAt
    return this.store.recordEpisode({
      situation: input.situation,
      outcome: input.outcome,
      detail: input.detail,
      idempotencyKey: input.idempotencyKey,
      occurredAt: input.occurredAt,
      scopeKey,
      source: 'automation',
      trust: trusted ? 'trusted' : 'legacy',
      ...(attributed
        ? { ruleId: receipt.ruleId, guidanceVersion: receipt.guidanceVersion }
        : input.ruleId === undefined ? {} : { claimedRuleId: input.ruleId }),
    })
  }

  /** Query an exact post-injection receipt for trusted automation attribution. */
  async captureAutomationExposure(input: {
    workspace: string
    agentPreset: string
    automationId: string
    sessionId: string
  }): Promise<{ ruleId: string; guidanceVersion: number } | undefined> {
    this.assertActive()
    const automationId = input.automationId.normalize('NFC').trim()
    if (!isAbsolute(input.workspace) || input.agentPreset.trim() === '' || automationId === ''
      || input.sessionId === '' || input.sessionId.trim() !== input.sessionId) return undefined
    const scopeKey = canonicalEvolutionScope(input.workspace, input.agentPreset)
    const receipt = this.store.captureGuidanceExposure(
      input.sessionId,
      scopeKey,
      `automation:${automationId}`,
    )
    return receipt === undefined
      ? undefined
      : Object.freeze({ ruleId: receipt.ruleId, guidanceVersion: receipt.guidanceVersion })
  }

  /** Candidate rule changes implied by current evidence. Never auto-applied. */
  candidates(agent: Agent | undefined): RuleCandidate[] {
    const scopeKey = this.authorize(agent, 'inspect', 'candidates')
    return this.store.candidates({
      scopeKey,
      window: this.config.evaluationWindow,
      minSample: this.config.minSample,
      adoptFailureRate: this.config.adoptFailureRate,
      retireFailureRate: this.config.retireFailureRate,
      limit: this.config.maxCandidates,
      evidenceSampleLimit: this.config.maxEvidenceSamples,
    })
  }

  listRules(agent: Agent | undefined, status?: 'active' | 'retired'): StoredRule[] {
    const scopeKey = this.authorize(agent, 'inspect', 'rules')
    return this.store.listRules(scopeKey, status)
  }

  /**
   * Remove one exact active guidance generation through the opt-in low-risk lane.
   *
   * The model identifies only the immutable rule and its observed version. This
   * method derives scope from the Agent, authorizes the exact Policy action, and
   * delegates the evidence/risk/reason decision to one transactional Host path.
   */
  rollback(agent: Agent | undefined, input: {
    ruleId: string
    expectedVersion: number
  }): EvolutionRollbackResult {
    this.assertActive()
    if (!this.config.autonomousRollback) {
      throw new AssistantEvolutionError('forbidden', 'autonomous evolution rollback is disabled')
    }
    const ruleId = input.ruleId.normalize('NFC').trim()
    if (!/^rule-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(ruleId)) {
      throw new AssistantEvolutionError('invalid-input', 'ruleId must be an immutable server-issued rule ID')
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.expectedVersion > 1_000_000_000) {
      throw new AssistantEvolutionError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const scopeKey = this.authorize(agent, 'rollback', `rule:${ruleId}`)
    return this.store.rollbackRule({
      scopeKey,
      ruleId,
      expectedVersion: input.expectedVersion,
      window: this.config.evaluationWindow,
      minSample: this.config.minSample,
      retireFailureRate: this.config.retireFailureRate,
      evidenceSampleLimit: this.config.maxEvidenceSamples,
    })
  }

  /**
   * Propose adopting or retiring a rule. Returns a pending proposal; the owner
   * decides through the normal approval surface.
   */
  propose(agent: Agent | undefined, input: {
    mutation: EvolutionProposalMutation
    /** Trusted headless compatibility only; model-visible tools never accept it. */
    principal?: string
    ttlMs?: number
  }): EvolutionProposalResult {
    // The capability gate is deliberately static so deployments can authorize
    // this service method with one exact rule. The owner-approval proposal below
    // still freezes the exact situation/rule target in its immutable resource.
    const scopeKey = this.authorize(agent, 'propose', 'proposals')
    const ttlMs = input.ttlMs ?? this.config.defaultProposalTtlMs
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new AssistantEvolutionError('invalid-input', 'ttlMs must be a positive safe integer')
    }
    const requester = `agent:${agent!.session.header.agentPreset}`
    let mutation: EvolutionMutation
    let generation: number | undefined
    if (input.mutation.op === 'adopt') {
      const situation = input.mutation.input.situation.normalize('NFC').trim()
      const candidate = this.store.candidates({
        scopeKey,
        window: this.config.evaluationWindow,
        minSample: this.config.minSample,
        adoptFailureRate: this.config.adoptFailureRate,
        retireFailureRate: this.config.retireFailureRate,
        limit: this.config.maxCandidates,
        evidenceSampleLimit: this.config.maxEvidenceSamples,
      }).find(entry => entry.kind === 'adopt' && entry.situation === situation)
      if (candidate === undefined) {
        throw new AssistantEvolutionError('invalid-input', 'no adopt candidate exists for that scoped situation')
      }
      generation = this.store.nextGeneration(scopeKey, situation)
      mutation = {
        op: 'adopt',
        input: { scopeKey, situation, guidance: input.mutation.input.guidance },
        baseline: candidate.stats,
        evidence: {
          sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
          digest: candidate.evidenceDigest,
          total: candidate.evidenceTotal,
        },
      }
    } else {
      const existing = this.store.getRule(input.mutation.ruleId)
      if (existing === undefined || existing.scopeKey !== scopeKey || existing.status !== 'active') {
        throw new AssistantEvolutionError('not-found', 'evolution rule was not found in the Agent scope')
      }
      if (input.mutation.expectedVersion !== existing.version) {
        throw new AssistantEvolutionError('invalid-input', 'retire expectedVersion does not match the active rule')
      }
      const candidate = this.store.retirementCandidate({
        scopeKey,
        ruleId: existing.id,
        window: this.config.evaluationWindow,
        minSample: this.config.minSample,
        retireFailureRate: this.config.retireFailureRate,
        evidenceSampleLimit: this.config.maxEvidenceSamples,
      })
      if (candidate === undefined || candidate.ruleId !== existing.id || candidate.baseline === undefined) {
        throw new AssistantEvolutionError(
          'invalid-input',
          'no retire candidate with sufficient exact attributed evidence exists for that scoped rule',
        )
      }
      mutation = {
        op: 'retire',
        ruleId: existing.id,
        expectedVersion: existing.version,
        reason: input.mutation.reason,
        evaluation: candidate.stats,
        baseline: candidate.baseline,
        evidence: {
          sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
          digest: candidate.evidenceDigest,
          total: candidate.evidenceTotal,
        },
      }
    }
    const stable = evolutionDigest({ mutation, generation })
    if (mutation.op === 'adopt') mutation = { ...mutation, ruleId: ruleIdFromStableMutation(stable) }
    const idempotencyKey = `evolution:${stable}`
    const route = this.approvalRoute(agent, input.principal)
    const review = evolutionMutationReview(mutation)
    const creationIntent: EvolutionCreationIntent = {
      idempotencyKey,
      requester,
      principal: route.principal,
      action: review.action,
      resource: review.resource,
      diff: review.diff,
      summary: review.summary,
      ttlMs,
      ...(route.dispatch === undefined ? {} : { dispatch: route.dispatch }),
    }
    const local = this.store.createProposal({
      idempotencyKey,
      requester,
      principal: route.principal,
      mutation,
      expiresAt: Date.now() + ttlMs,
      creationIntent,
    })
    if (local.policyProposalId !== undefined) {
      if (local.status !== 'pending') {
        return result(
          local,
          true,
          local.resultRuleId === undefined ? undefined : this.store.getRule(local.resultRuleId),
        )
      }
      return this.settleAttached(local, true)
        ?? result(local, true)
    }
    return this.submitLocalProposal(local, false)
  }

  /**
   * Commit proposals whose policy decision settled after the originating turn.
   * Without this, an approval granted on a chat card would leave the rule change
   * pending forever. Safe to call repeatedly.
   */
  reconcileProposals(limit?: number): EvolutionProposalResult[] {
    this.assertActive()
    const settled: EvolutionProposalResult[] = []
    for (const pending of this.store.listPendingProposals(limit ?? this.config.reconcileLimit)) {
      try {
        const result = pending.policyProposalId === undefined
          ? this.submitLocalProposal(pending, false)
          : this.settleAttached(pending, false)
        if (result === undefined || result.status === 'pending') {
          this.store.deferPendingProposal(pending.proposalId)
          continue
        }
        settled.push(result)
      } catch {
        // One unavailable Policy route must not starve later rows in this bounded
        // lane. The durable intent remains pending and rotates behind its peers.
        this.store.deferPendingProposal(pending.proposalId)
      }
    }
    this.lastReconciledAt = this.now()
    return settled
  }

  private submitLocalProposal(local: StoredProposal, replayed: boolean): EvolutionProposalResult {
    const intent = local.creationIntent
    if (intent === undefined) {
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(conflict.proposal, replayed || conflict.replayed, conflict.rule)
    }
    const recoveryInput: ApprovalProposalRecoveryInput = {
      idempotencyKey: intent.idempotencyKey,
      requester: intent.requester,
      principal: intent.principal,
      action: intent.action,
      resource: intent.resource,
      diff: intent.diff,
      summary: intent.summary,
      notAfter: local.expiresAt,
      ...(intent.dispatch === undefined ? {} : { dispatch: intent.dispatch }),
    }
    const recovered = this.policy.recoverOrCreateProposal(recoveryInput)
    if (recovered.kind === 'abandoned') {
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(
        conflict.proposal,
        replayed || recovered.replayed || conflict.replayed,
        conflict.rule,
      )
    }
    const decision = recovered.proposal
    const snapshot = this.policy.getProposal(decision.proposalId)
    if (snapshot === undefined) {
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(conflict.proposal, replayed || conflict.replayed, conflict.rule)
    }
    return this.attachPolicySnapshot(local, intent, snapshot, replayed || decision.replayed)
  }

  private attachPolicySnapshot(
    local: StoredProposal,
    intent: EvolutionCreationIntent,
    snapshot: ApprovalProposalSnapshot,
    replayed: boolean,
  ): EvolutionProposalResult {
    const expectedLifecycleVersion = snapshot.status === 'pending' ? 1 : 2
    const expectedDiffHash = createHash('sha256').update(intent.diff).digest('hex')
    if (snapshot.requester !== intent.requester || snapshot.principal !== intent.principal
      || snapshot.action !== intent.action || snapshot.resource.kind !== intent.resource.kind
      || snapshot.resource.id !== intent.resource.id || snapshot.summary !== intent.summary
      || snapshot.diffHash !== expectedDiffHash || snapshot.version !== expectedLifecycleVersion
      || !Number.isSafeInteger(snapshot.expiresAt) || snapshot.expiresAt < 0) {
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(conflict.proposal, replayed || conflict.replayed, conflict.rule)
    }
    const expectation = {
      proposalId: snapshot.proposalId,
      requester: intent.requester,
      principal: intent.principal,
      action: intent.action,
      resource: intent.resource,
      summary: intent.summary,
      diff: intent.diff,
      expiresAt: snapshot.expiresAt,
      // Policy creation is always v1, including a terminal v2 replay after a
      // cross-database crash.
      expectedVersion: 1,
    }
    const attached = this.store.attachPolicy(local.proposalId, snapshot.proposalId, expectation)
    if (snapshot.status === 'pending') return result(attached, replayed)
    return this.settleAttached(attached, replayed) ?? result(attached, replayed)
  }

  private settleAttached(
    local: StoredProposal,
    replayed: boolean,
  ): EvolutionProposalResult | undefined {
    if (local.policyProposalId === undefined || local.settlementExpectation === undefined) {
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(conflict.proposal, replayed || conflict.replayed, conflict.rule)
    }
    const snapshot: ApprovalProposalSnapshot | undefined = this.policy.getProposal(local.policyProposalId)
    if (snapshot?.status === 'pending') return undefined
    try {
      const terminal = validateApprovalSettlement(snapshot, local.settlementExpectation)
      const applied = this.store.settleProposal({
        proposalId: local.proposalId,
        policyStatus: terminal.status,
        policyVersion: terminal.version,
        reviewExpectation: local.settlementExpectation,
      })
      return result(applied.proposal, replayed || applied.replayed, applied.rule)
    } catch (error) {
      if (!(error instanceof ApprovalSettlementConflict)) throw error
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      return result(conflict.proposal, replayed || conflict.replayed, conflict.rule)
    }
  }

  private approvalRoute(
    agent: Agent | undefined,
    explicitPrincipal: string | undefined,
  ): { principal: string; dispatch?: ApprovalDispatchRoute } {
    if (this.delivery !== undefined) {
      const dispatch = this.delivery.prepareAgentApproval(agent, { sourceId: evolutionApprovalSource })
      const workspace = agent?.session.header.cwd
      if (dispatch.sourceId !== evolutionApprovalSource || dispatch.workspace !== workspace
        || dispatch.principal.trim() === '') {
        throw new AssistantEvolutionError('invalid-input', 'authenticated approval route does not match the Agent')
      }
      if (explicitPrincipal !== undefined && explicitPrincipal !== dispatch.principal) {
        throw new AssistantEvolutionError('invalid-input', 'explicit principal does not match the approval route owner')
      }
      return { principal: dispatch.principal, dispatch }
    }
    const principal = explicitPrincipal?.normalize('NFC').trim()
    if (principal === undefined || principal === '') {
      throw new AssistantEvolutionError(
        'missing-identity',
        'evolution proposal requires an authenticated approval route or trusted headless principal',
      )
    }
    return { principal }
  }

  /** Guidance block for the current active rules, as injected into a session. */
  guidance(agent?: Agent): string {
    this.assertActive()
    if (agent === undefined) return ''
    const scopeKey = this.authorize(agent, 'snapshot', 'guidance')
    return this.guidanceForScope(scopeKey)
  }

  private guidanceForScope(scopeKey: string): string {
    return buildGuidance(this.store.listRules(scopeKey, 'active'), {
      maxBytes: this.config.maxGuidanceBytes,
      maxRules: this.config.maxInjectedRules,
    })
  }

  private injectGuidance(agent: Agent): void {
    if (!this.active || this.injected.has(agent)) return
    const workspace = agent.session.header.cwd
    const preset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || preset === undefined || preset.trim() === '') return
    const decision = this.policy.authorizeAgent(agent, 'snapshot', { kind: 'evolution', id: 'guidance' }, {
      idempotencyKey: `evolution-guidance:${agent.id}`,
    })
    if (decision.effect !== 'allow') return
    const scopeKey = canonicalEvolutionScope(workspace, preset)
    const sessionId = String(agent.session.id)
    const unseen = this.store.listRules(scopeKey, 'active').filter(rule => !this.store.hasGuidanceExposure(
      sessionId,
      scopeKey,
      rule.id,
      rule.generation,
    ))
    const snapshot = buildGuidanceSnapshot(unseen, {
      maxBytes: this.config.maxGuidanceBytes,
      maxRules: this.config.maxInjectedRules,
    })
    if (snapshot.text === '') {
      this.injected.add(agent)
      return
    }
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: snapshot.text }],
      source: { kind: 'plugin', plugin: 'assistant-evolution' },
    }))
    for (const rule of snapshot.rules) {
      this.store.recordGuidanceExposure({
        sessionId,
        scopeKey,
        situation: rule.situation,
        ruleId: rule.id,
        guidanceVersion: rule.generation,
      })
    }
    this.injected.add(agent)
  }

  private authorize(agent: Agent | undefined, action: string, resourceId: string): string {
    this.assertActive()
    if (agent === undefined) {
      throw new AssistantEvolutionError('missing-identity', 'evolution operation requires an Agent')
    }
    const workspace = agent.session.header.cwd
    const preset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || preset === undefined || preset.trim() === '') {
      throw new AssistantEvolutionError('missing-identity', 'evolution operation requires absolute workspace and preset')
    }
    const decision = this.policy.authorizeAgent(agent, action, { kind: 'evolution', id: resourceId })
    if (decision.effect !== 'allow') {
      throw new AssistantEvolutionError('forbidden', `policy denied evolution ${action}`)
    }
    return canonicalEvolutionScope(workspace, preset)
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantEvolutionError('disposed', 'assistant-evolution service is disposed')
  }
}

export type { ApprovalProposalResult }
