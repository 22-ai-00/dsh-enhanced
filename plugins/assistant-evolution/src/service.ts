import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import Schema from '@deepseek-ai/schemastery'
import {
  canonicalEvaluationHostScope,
  evaluationLearningProjectionDigest,
  type EvaluationLearningEvidenceTuple,
  type EvaluationLearningWriterFenceResult,
  type TrustedTaskLearningProjectionReceipt,
} from '@dsh-enhanced/assistant-evaluation'
import type {
  TrustedDeliveryPresentationProducer,
  TrustedDeliveryPresentationRegistration,
} from '@dsh-enhanced/assistant-delivery'
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
import {
  EvolutionStore,
  EvolutionStoreError,
  evolutionDigest,
  supervisedGrowthAnalystProposalIdempotencyKey,
} from './store.js'
import { registerEvolutionTools } from './tools.js'
import type {
  EvolutionCreationIntent,
  EvolutionMutation,
  EvolutionProposalMutation,
  QualityEvidenceKind,
  RuleCandidate,
  StoredAutonomousRollback,
  StoredEpisode,
  StoredEvolutionApplicationReceipt,
  StoredProposal,
  StoredRule,
  SupervisedGrowthAnalystProposalInput,
  SupervisedGrowthAnalystReview,
} from './types.js'
import {
  legacyEvolutionScope,
  SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION,
} from './types.js'

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

interface DeliveryPresentationSinkRegistration {
  token: symbol
  registration: Readonly<TrustedDeliveryPresentationRegistration>
  dispose: () => void
}

function registrationOwnedByDeliveryPresentation(
  registration: Readonly<TrustedDeliveryPresentationRegistration>,
): boolean {
  const candidate = registration as Readonly<TrustedDeliveryPresentationRegistration> & Readonly<{
    owner?: Readonly<{
      ownsTrustedDeliveryPresentationRegistration(
        value: Readonly<TrustedDeliveryPresentationRegistration>,
      ): boolean
    }>
  }>
  try {
    return typeof candidate.owner === 'object' && candidate.owner !== null
      && typeof candidate.owner.ownsTrustedDeliveryPresentationRegistration === 'function'
      && candidate.owner.ownsTrustedDeliveryPresentationRegistration(registration)
  } catch {
    return false
  }
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

/** Fixed Policy subject used by the non-model supervised-growth runbook. */
export const HOST_RECOVERY_BACKGROUND_ID = 'dsh-enhanced-assistant-recovery'

/** The only Automation allowed to use the model-visible analyst capability. */
export const SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID =
  'heartbeat:supervised-growth-analyst' as const

const evolutionHostScopeBrand: unique symbol = Symbol('assistant-evolution.host-scope')

export interface EvolutionHostScope extends Readonly<{ workspace: string; preset: string }> {
  readonly [evolutionHostScopeBrand]: true
}

/** Canonical, immutable and intentionally non-serializable Host scope token. */
export function canonicalEvolutionHostScope(input: {
  workspace: string
  preset: string
}): EvolutionHostScope {
  const scopeKey = canonicalEvolutionScope(input.workspace, input.preset)
  const [workspace, preset] = JSON.parse(scopeKey) as [string, string]
  const branded = { workspace, preset } as EvolutionHostScope
  Object.defineProperty(branded, evolutionHostScopeBrand, {
    value: true, enumerable: false, configurable: false, writable: false,
  })
  return Object.freeze(branded)
}

function exactEvolutionHostScope(input: EvolutionHostScope): EvolutionHostScope {
  if (typeof input !== 'object' || input === null || !Object.isFrozen(input)
    || input[evolutionHostScopeBrand] !== true) {
    throw new AssistantEvolutionError(
      'invalid-input',
      'Host evolution operations require a canonical immutable scope',
    )
  }
  const canonical = canonicalEvolutionHostScope(input)
  if (canonical.workspace !== input.workspace || canonical.preset !== input.preset) {
    throw new AssistantEvolutionError('invalid-input', 'Host evolution scope is not canonical')
  }
  return input
}

function hostText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') {
    throw new AssistantEvolutionError('invalid-input', `${label} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes
    || hasControl(normalized)) {
    throw new AssistantEvolutionError('invalid-input', `${label} is invalid`)
  }
  return normalized
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!
    if (codePoint <= 0x1f || codePoint === 0x7f) return true
  }
  return false
}

export interface EvolutionHostOperation {
  scope: EvolutionHostScope
  /** Authenticated owner identity supplied by the Host route. */
  principal: string
  /** Exact fixed-run receipt/run identifier used for Policy budget idempotency. */
  operationId: string
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

export interface EvolutionOwnerUndoInput {
  ruleId: string
  expectedVersion: number
  /** Host-generated stable identity for exact request replay. */
  operationId: string
  ttlMs?: number
}

/** Content-free, global operational summary for local health aggregation. */
export interface AssistantEvolutionHealth {
  activeRules: number
  retiredRules: number
  pendingProposals: number
  conflictedProposals: number
  trustedEpisodes: number
  qualityEligibleEpisodes: number
  operationalEpisodes: number
  legacyQuarantinedEpisodes: number
  unattributedTrustedEpisodes: number
  unattributedQualityEligibleEpisodes: number
  lastTrustedEpisodeAt: number
  lastQualityEligibleEpisodeAt: number
  /** Last fully completed reconciliation pass; zero means none has completed. */
  lastReconciledAt: number
  autonomousRollbacks: number
  taskLearningProjections: number
  retractedTaskLearningProjections: number
  taskLearningProjectionRevisions: number
  taskLearningProjectionIntegrityErrors: number
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

/**
 * Deprecated pre-v7 free-form shape, retained only as a source-compatibility
 * type. recordEvaluationOutcome() always rejects it and never writes evidence.
 */
export interface EvaluationOutcomeInput {
  situation: string
  outcome: 'succeeded' | 'failed'
  detail: string
  evidenceKind: QualityEvidenceKind
  evaluationId: string
  idempotencyKey: string
  occurredAt: number
  workspace: string
  agentPreset: string
  automationId?: string
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
}

/** The only input accepted by the authoritative quality projection seam. */
export interface EvaluationProjectionInput {
  scope: EvolutionHostScope
  evaluationId: string
}

interface TrustedEvaluationLedger {
  getTrustedTaskLearningProjection(input: {
    scope: ReturnType<typeof canonicalEvaluationHostScope>
    outcomeId: string
  }): TrustedTaskLearningProjectionReceipt | undefined
  withTrustedLearningWriterFence<T>(input: Readonly<{
    scope: ReturnType<typeof canonicalEvaluationHostScope>
    scopeWatermark: number
    evidence: readonly Readonly<EvaluationLearningEvidenceTuple>[]
  }>, callback: () => T): EvaluationLearningWriterFenceResult<T>
}

interface AutomationQualityEvidenceReceipt {
  schemaVersion: number
  source: string
  executionKind: 'agent' | 'host'
  automationId: string
  runId: string
  definitionHash: string
  status: 'succeeded' | 'failed' | 'timed_out'
  scope: Readonly<{ workspace: string; preset: string }>
  situation: string
  occurredAt: number
  evidenceRef: Readonly<{ kind: 'automation-run'; ref: string }>
  sessionId?: string
  ruleId?: string
  guidanceVersion?: number
  proofDigest: string
}

interface AutomationQualityEvidenceResolver {
  resolveQualityEvidence(input: {
    automationId: string
    runId: string
    expectedScope: { workspace: string; preset: string }
    expectedSituation: string
    expectedOccurredAt: number
    evidenceRef: { kind: 'automation-run'; ref: string }
  }): AutomationQualityEvidenceReceipt | undefined
  validateQualityEvidence(receipt: AutomationQualityEvidenceReceipt): boolean
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
export class AssistantEvolutionService extends Service implements TrustedDeliveryPresentationProducer {
  static Config = configSchema
  static inject = ['assistantPolicy', 'assistantEvaluation']

  private readonly store: EvolutionStore
  private readonly policy: AssistantPolicyService
  private readonly context: Context
  private readonly config: Required<Config>
  private readonly now: () => number
  private delivery: EvolutionApprovalDelivery | undefined
  private readonly presentationProducerGeneration = `assistant-evolution-presentation:${randomUUID()}`
  private presentationSink: DeliveryPresentationSinkRegistration | undefined
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
    this.context = ctx
    this.policy = policy
    this.now = options.now ?? Date.now
    this.store = new EvolutionStore({
      path: this.config.databasePath,
      maxGuidanceBytes: this.config.maxRuleGuidanceBytes,
    })

    ctx.inject(['assistantDelivery'], deliveryCtx => {
      const delivery = deliveryCtx.get('assistantDelivery') as EvolutionApprovalDelivery
      this.delivery = delivery
      this.reconcileApplicationPresentations()
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
      this.presentationSink?.dispose()
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

  trustedDeliveryPresentationProducerGeneration(): string {
    this.assertActive()
    return this.presentationProducerGeneration
  }

  /**
   * Accept only the publisher minted by the exact live Delivery instance.
   * The registration is held privately; it is never surfaced to an Agent,
   * tool schema, proposal payload, or Evolution read API.
   */
  registerTrustedDeliveryPresentationSink(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): () => void {
    this.assertActive()
    if (registration.protocol !== 'assistant-delivery/trusted-presentation-producer/v1'
      || registration.producer !== 'assistant-evolution'
      || registration.generation !== this.presentationProducerGeneration
      || typeof registration.publish !== 'function'
      || !registrationOwnedByDeliveryPresentation(registration)) {
      throw new AssistantEvolutionError('forbidden', 'trusted Delivery presentation registration is invalid')
    }
    const current = this.presentationSink
    if (current !== undefined) {
      if (current.registration === registration) return current.dispose
      throw new AssistantEvolutionError('forbidden', 'trusted Delivery presentation sink is already registered')
    }
    const token = Symbol('assistant-evolution.trusted-delivery-presentation')
    let live = true
    const dispose = () => {
      if (!live) return
      live = false
      if (this.presentationSink?.token === token) this.presentationSink = undefined
    }
    this.presentationSink = Object.freeze({ token, registration, dispose })
    // Existing durable terminal receipts become eligible as soon as their
    // exact Delivery publisher appears; the local outbox remains authoritative
    // if Delivery rejects or later revokes this generation.
    this.reconcileApplicationPresentations()
    return dispose
  }

  /** Record one model-reported outcome as learning-ineligible operational audit. */
  recordEpisode(agent: Agent | undefined, input: ForegroundEpisodeInput): StoredEpisode {
    const scopeKey = this.authorize(agent, 'append', `situation:${input.situation}`)
    return this.store.recordEpisode({
      scopeKey,
      situation: input.situation,
      outcome: input.outcome,
      detail: input.detail,
      source: 'foreground',
      trust: 'self-reported',
      evidenceKind: 'operational',
      ...(input.ruleId === undefined ? {} : { claimedRuleId: input.ruleId }),
      occurredAt: input.occurredAt,
      idempotencyKey: input.idempotencyKey,
    })
  }

  /**
   * Record an execution outcome observed by trusted local infrastructure rather
   * than a model turn, for example a finished background automation run. It is
   * deliberately operational and learning-ineligible: execution success/failure
   * does not establish objective task quality.
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
      evidenceKind: trusted ? 'operational' : 'legacy-unknown',
      ...(attributed
        ? { ruleId: receipt.ruleId, guidanceVersion: receipt.guidanceVersion }
        : input.ruleId === undefined ? {} : { claimedRuleId: input.ruleId }),
    })
  }

  /**
   * Deprecated unsafe v5 shape. Free caller-supplied quality fields can never
   * produce learning-eligible evidence again; use projectEvaluationOutcome().
   */
  recordEvaluationOutcome(input: EvaluationOutcomeInput): StoredEpisode {
    this.assertActive()
    void input
    throw new AssistantEvolutionError(
      'forbidden',
      'free-form Evaluation projection is disabled; use projectEvaluationOutcome with an authoritative receipt',
    )
  }

  /**
   * Project one exact trusted Evaluation row into the learning ledger. The
   * caller cannot supply outcome, detail, kind, time, situation or attribution.
   */
  projectEvaluationOutcome(input: EvaluationProjectionInput): StoredEpisode {
    this.assertActive()
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'evaluationId,scope') {
      throw new AssistantEvolutionError(
        'invalid-input',
        'Evaluation projection accepts only an exact scope and evaluationId',
      )
    }
    const scope = exactEvolutionHostScope(input.scope)
    const evaluationId = hostText(input.evaluationId, 'evaluationId', 200)
    const receipt = this.trustedTaskLearningReceipt(scope, evaluationId)
    const projected = this.applyTrustedTaskLearningReceipt(scope, receipt)
    if (projected.episode === undefined) {
      throw new AssistantEvolutionError(
        'forbidden',
        'the canonical task revision retracts rather than upserts a behavioural learning vote',
      )
    }
    return projected.episode
  }

  /**
   * Narrow structural seam used only by Evaluation's durable outbox. The raw
   * scope is canonicalized here; quality fields are still fetched exclusively
   * from the trusted Evaluation ledger.
   */
  projectTrustedEvaluationOutcome(_input: {
    scope: Readonly<{ workspace: string; preset: string }>
    evaluationId: string
  }): never {
    this.assertActive()
    throw new AssistantEvolutionError(
      'forbidden',
      'raw Evaluation projection protocol is retired; use the versioned task-revision capability',
    )
  }

  /** Evaluation protocol v2 sink. Every success echoes the exact applied revision. */
  projectTrustedEvaluationTaskRevision(input: {
    scope: Readonly<{ workspace: string; preset: string }>
    evaluationId: string
  }): Readonly<{
    triggerOutcomeId: string
    subjectKind: 'automation-run' | 'outcome'
    subjectRef: string
    version: number
    digest: string
    scopeWatermark: number
    disposition: 'upsert' | 'retract'
    status: 'applied' | 'replayed'
  }> {
    this.assertActive()
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'evaluationId,scope'
      || typeof input.scope !== 'object' || input.scope === null || Array.isArray(input.scope)
      || Object.keys(input.scope).sort().join(',') !== 'preset,workspace') {
      throw new AssistantEvolutionError('invalid-input', 'trusted Evaluation projection input is invalid')
    }
    const evaluationId = hostText(input.evaluationId, 'evaluationId', 200)
    const scope = canonicalEvolutionHostScope(input.scope)
    const receipt = this.trustedTaskLearningReceipt(scope, evaluationId)
    const projected = this.applyTrustedTaskLearningReceipt(scope, receipt)
    return Object.freeze({
      triggerOutcomeId: evaluationId,
      subjectKind: receipt.projection.subjectKind,
      subjectRef: receipt.projection.subjectRef,
      version: receipt.projection.version,
      digest: receipt.projection.digest,
      scopeWatermark: receipt.scopeWatermark,
      disposition: receipt.projection.disposition,
      status: projected.replayed ? 'replayed' as const : 'applied' as const,
    })
  }

  /**
   * Called by Assistant Automations only after it installed the immutable
   * production execution context and bound the Policy initiator. This closes
   * the session-start ordering gap without weakening background Policy.
   */
  injectAutomationGuidance(agent: Agent, execution: Readonly<{
    mode: 'preview' | 'production'
    automationId: string
    occurrenceId: string
  }>): void {
    this.assertActive()
    const current = (agent.ctx as unknown as { get(name: string): unknown })
      .get('assistantAutomationExecution')
    const installed = current as Partial<typeof execution> | undefined
    if (typeof current !== 'object' || current === null || Array.isArray(current)
      || Object.keys(current).sort().join(',') !== 'automationId,mode,occurrenceId'
      || installed?.mode !== execution.mode
      || installed.automationId !== execution.automationId
      || installed.occurrenceId !== execution.occurrenceId
      || Object.keys(execution).sort().join(',') !== 'automationId,mode,occurrenceId'
      || execution.mode !== 'production'
      || hostText(execution.automationId, 'automationId', 500) !== execution.automationId
      || hostText(execution.occurrenceId, 'occurrenceId', 500) !== execution.occurrenceId) {
      throw new AssistantEvolutionError(
        'forbidden',
        'automation guidance requires the exact installed production execution context',
      )
    }
    this.injectGuidance(agent)
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
    return this.candidatesForScope(scopeKey)
  }

  /** Agent-free, exact-scope candidate inspection for the fixed Host runbook. */
  hostCandidates(input: EvolutionHostOperation): RuleCandidate[] {
    const scopeKey = this.authorizeHost(input, 'inspect', 'candidates')
    return this.candidatesForScope(scopeKey)
  }

  /**
   * Review exactly one adoption candidate from the dedicated production
   * analyst. The random review token is durable and bound to this occurrence;
   * no foreground or preview session can obtain one.
   */
  reviewSupervisedGrowthAdoption(
    agent: Agent | undefined,
  ): Readonly<SupervisedGrowthAnalystReview> {
    const execution = this.authorizeSupervisedGrowthAnalyst(
      agent,
      'inspect',
      'analyst-adoption',
    )
    // Even review requires the route that a later proposal will use. This
    // prevents an analyst with no owner destination from minting stale tokens.
    this.approvalRoute(agent, undefined)
    const candidate = this.candidatesForScope(execution.scopeKey)
      .filter(entry => entry.kind === 'adopt')
      .sort((left, right) => {
        const rateOrder = right.stats.failures * left.stats.total
          - left.stats.failures * right.stats.total
        return rateOrder || right.stats.failures - left.stats.failures
          || right.stats.total - left.stats.total
          || left.situation.localeCompare(right.situation)
      })[0]
    if (candidate === undefined) {
      return Object.freeze({ contractVersion: SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION })
    }
    const frozen = this.store.registerSupervisedGrowthAnalystReview({
      scopeKey: execution.scopeKey,
      occurrenceId: execution.occurrenceId,
      candidate,
      evidenceWindow: this.config.evaluationWindow,
    })
    return Object.freeze({
      contractVersion: SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION,
      candidate: Object.freeze({
        ...frozen.review.evidence,
        reviewToken: frozen.review.reviewToken,
        proposalExists: frozen.proposalExists,
      }),
    })
  }

  /**
   * Turn one frozen analyst review into the normal owner approval. Identity is
   * evidence-derived; wording changes and concurrent executions join the first
   * durable proposal instead of producing several cards.
   */
  proposeSupervisedGrowthAdoption(
    agent: Agent | undefined,
    input: SupervisedGrowthAnalystProposalInput,
  ): EvolutionProposalResult {
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'guidance,reviewToken') {
      throw new AssistantEvolutionError(
        'invalid-input',
        'analyst proposal accepts only reviewToken and guidance',
      )
    }
    const execution = this.authorizeSupervisedGrowthAnalyst(
      agent,
      'propose',
      'proposals',
    )
    const route = this.approvalRoute(agent, undefined)
    const reviewToken = hostText(input.reviewToken, 'reviewToken', 200)
    const review = this.store.getSupervisedGrowthAnalystReview(reviewToken)
    if (review === undefined || review.scopeKey !== execution.scopeKey
      || review.occurrenceId !== execution.occurrenceId) {
      throw new AssistantEvolutionError(
        'not-found',
        'analyst review token does not belong to this production execution',
      )
    }
    const evidence = review.evidence
    if (evidence.contractVersion !== SUPERVISED_GROWTH_ANALYST_CONTRACT_VERSION
      || evidence.total < this.config.minSample
      || evidence.failures / evidence.total < this.config.adoptFailureRate) {
      throw new AssistantEvolutionError('forbidden', 'analyst review no longer satisfies adoption thresholds')
    }
    const idempotencyKey = supervisedGrowthAnalystProposalIdempotencyKey({
      scopeKey: execution.scopeKey,
      situation: evidence.situation,
      evidenceDigest: evidence.evidenceDigest,
      evidenceTotal: evidence.evidenceTotal,
      contractVersion: evidence.contractVersion,
    })
    const ruleId = ruleIdFromStableMutation(evolutionDigest([
      'supervised-growth-analyst-rule/v1',
      idempotencyKey,
    ]))
    const mutation: Extract<EvolutionMutation, { op: 'adopt' }> = {
      op: 'adopt',
      ruleId,
      input: {
        scopeKey: execution.scopeKey,
        situation: evidence.situation,
        guidance: input.guidance,
      },
      baseline: {
        scopeKey: execution.scopeKey,
        situation: evidence.situation,
        failures: evidence.failures,
        total: evidence.total,
      },
      evidence: {
        sampleEpisodeIds: evidence.sampleEpisodeIds,
        digest: evidence.evidenceDigest,
        total: evidence.evidenceTotal,
        window: evidence.evidenceWindow,
        scopeWatermark: evidence.scopeWatermark,
        taskRevisions: evidence.taskRevisions,
      },
    }
    const ttlMs = this.config.defaultProposalTtlMs
    const requester = `automation:${SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID}`
    const reviewPresentation = evolutionMutationReview(mutation)
    const creationIntent: EvolutionCreationIntent = {
      idempotencyKey,
      requester,
      principal: route.principal,
      action: reviewPresentation.action,
      resource: reviewPresentation.resource,
      diff: reviewPresentation.diff,
      summary: reviewPresentation.summary,
      ttlMs,
      ...(route.dispatch === undefined ? {} : { dispatch: route.dispatch }),
    }
    const local = this.withLearningWriterFence(mutation, () => (
      this.store.createSupervisedGrowthAnalystProposal({
        reviewToken,
        scopeKey: execution.scopeKey,
        occurrenceId: execution.occurrenceId,
        requester,
        principal: route.principal,
        mutation,
        expiresAt: Date.now() + ttlMs,
        creationIntent,
      })
    ))
    if (local.proposal.policyProposalId !== undefined) {
      if (local.proposal.status !== 'pending') {
        return result(
          local.proposal,
          true,
          local.proposal.resultRuleId === undefined
            ? undefined
            : this.store.getRule(local.proposal.resultRuleId),
        )
      }
      return this.settleAttached(local.proposal, true) ?? result(local.proposal, true)
    }
    return this.submitLocalProposal(local.proposal, local.replayed)
  }

  listRules(agent: Agent | undefined, status?: 'active' | 'retired'): StoredRule[] {
    const scopeKey = this.authorize(agent, 'inspect', 'rules')
    return this.store.listRules(scopeKey, status)
  }

  /** Agent-free, exact-scope rule inspection for the fixed Host runbook. */
  hostListRules(input: EvolutionHostOperation & {
    status?: 'active' | 'retired'
  }): StoredRule[] {
    const scopeKey = this.authorizeHost(input, 'inspect', `rules:${input.status ?? 'all'}`)
    return this.store.listRules(scopeKey, input.status)
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
    const normalized = this.normalizedRollbackInput(input)
    const scopeKey = this.authorize(agent, 'rollback', `rule:${normalized.ruleId}`)
    return this.rollbackForScope(scopeKey, normalized)
  }

  /**
   * Retire one exact active rule by CAS. The Store admits only quality-eligible
   * objective/verification evidence attributed to an exact exposure receipt;
   * operational automation outcomes cannot satisfy this lane.
   */
  hostRollbackOne(input: EvolutionHostOperation & {
    ruleId: string
    expectedVersion: number
  }): EvolutionRollbackResult {
    const normalized = this.normalizedRollbackInput(input)
    const scopeKey = this.authorizeHost(input, 'rollback', `rule:${normalized.ruleId}`)
    return this.rollbackForScope(scopeKey, normalized)
  }

  /**
   * Ask the authenticated owner to remove one exact active guidance version.
   *
   * This is intentionally a proposal, not a direct rollback: the current Agent
   * supplies the exact workspace/preset scope, Delivery supplies the owner
   * principal, and Policy freezes a distinct `evolution.owner-undo` review
   * tuple. Approval can only retire the rule; it cannot revise its guidance or
   * grant authority. No regression sample is required because the owner is the
   * authority withdrawing their own earlier approval.
   */
  requestOwnerUndo(
    agent: Agent | undefined,
    input: EvolutionOwnerUndoInput,
  ): EvolutionProposalResult {
    this.assertActive()
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      throw new AssistantEvolutionError('invalid-input', 'owner undo input must be an object')
    }
    const keys = Object.keys(input).sort().join(',')
    if (keys !== 'expectedVersion,operationId,ruleId'
      && keys !== 'expectedVersion,operationId,ruleId,ttlMs') {
      throw new AssistantEvolutionError(
        'invalid-input',
        'owner undo accepts only ruleId, expectedVersion, operationId, and optional ttlMs',
      )
    }
    const scopeKey = this.authorize(agent, 'propose', 'proposals')
    const ruleId = hostText(input.ruleId, 'ruleId', 200)
    if (!/^rule-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(ruleId)) {
      throw new AssistantEvolutionError('invalid-input', 'ruleId must be an immutable server-issued rule ID')
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.expectedVersion > 1_000_000_000) {
      throw new AssistantEvolutionError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    const operationId = hostText(input.operationId, 'operationId', 500)
    const ttlMs = input.ttlMs ?? this.config.defaultProposalTtlMs
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw new AssistantEvolutionError('invalid-input', 'ttlMs must be a positive safe integer')
    }
    const targetRule = this.store.getRule(ruleId)
    if (targetRule === undefined || targetRule.scopeKey !== scopeKey) {
      throw new AssistantEvolutionError('not-found', 'evolution rule was not found in the Agent scope')
    }
    const route = this.approvalRoute(agent, undefined)
    const requester = `agent:${agent!.session.header.agentPreset}:owner-undo`
    const mutation: EvolutionMutation = {
      op: 'owner-undo',
      scopeKey,
      ruleId,
      situation: targetRule.situation,
      guidance: targetRule.guidance,
      generation: targetRule.generation,
      expectedVersion: input.expectedVersion,
      reason: 'Owner-approved immediate guidance undo.',
    }
    // operationId is the caller's retry identity. Deliberately exclude the
    // target tuple from this key so reusing one operation for another target is
    // detected as an idempotency conflict instead of creating a second card.
    const stable = evolutionDigest(['owner-undo-v1', scopeKey, route.principal, operationId])
    const idempotencyKey = `evolution-owner-undo:${stable}`
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
    const prior = this.store.getProposalByIdempotencyKey(idempotencyKey)
    if (prior === undefined) {
      if (targetRule.status !== 'active') {
        throw new AssistantEvolutionError('not-found', 'active evolution rule was not found in the Agent scope')
      }
      if (targetRule.version !== input.expectedVersion) {
        throw new AssistantEvolutionError('invalid-input', 'owner undo expectedVersion is stale')
      }
      if (this.store.ruleApprovalPrincipal(ruleId) !== route.principal) {
        throw new AssistantEvolutionError(
          'forbidden',
          'owner undo route does not match the principal who approved this guidance',
        )
      }
    }
    const local = this.store.createProposal({
      idempotencyKey,
      requester,
      principal: route.principal,
      mutation,
      // Policy proposal expiry uses the wall clock; the injectable clock is
      // reserved for deterministic ledger/audit timestamps.
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
      return this.settleAttached(local, true) ?? result(local, true)
    }
    return this.submitLocalProposal(local, false)
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
          window: this.config.evaluationWindow,
          scopeWatermark: candidate.scopeWatermark,
          taskRevisions: candidate.taskRevisions,
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
        scopeKey,
        ruleId: existing.id,
        situation: existing.situation,
        guidance: existing.guidance,
        generation: existing.generation,
        expectedVersion: existing.version,
        reason: input.mutation.reason,
        evaluation: candidate.stats,
        baseline: candidate.baseline,
        evidence: {
          sampleEpisodeIds: candidate.evidence.map(entry => entry.episodeId),
          digest: candidate.evidenceDigest,
          total: candidate.evidenceTotal,
          window: this.config.evaluationWindow,
          scopeWatermark: candidate.scopeWatermark,
          taskRevisions: candidate.taskRevisions,
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
    const local = this.withLearningWriterFence(mutation, () => this.store.createProposal({
      idempotencyKey,
      requester,
      principal: route.principal,
      mutation,
      expiresAt: Date.now() + ttlMs,
      creationIntent,
    }))
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
    const bounded = limit ?? this.config.reconcileLimit
    const queue = new Map<string, StoredProposal>()
    for (const proposal of this.store.listUnattachedProposalIntents(bounded)) {
      queue.set(proposal.proposalId, proposal)
    }
    for (const proposal of this.store.listPendingProposals(bounded)) {
      if (queue.size >= bounded) break
      queue.set(proposal.proposalId, proposal)
    }
    for (const pending of queue.values()) {
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
    this.reconcileApplicationPresentations(limit)
    this.lastReconciledAt = this.now()
    return settled
  }

  /**
   * Publish domain terminal receipts independently from proposal polling. A
   * crash after Delivery accepts but before the local ack simply republishes the
   * same revision and digest on restart.
   */
  reconcileApplicationPresentations(limit?: number): number {
    this.assertActive()
    const sink = this.presentationSink
    if (sink === undefined) return 0
    const bounded = limit ?? this.config.reconcileLimit
    let published = 0
    for (const entry of this.store.listPendingEvolutionApplicationReceipts(bounded)) {
      if (this.presentationSink?.token !== sink.token) return published
      const receipt = entry.receipt
      try {
        sink.registration.publish(this.applicationPresentation(receipt))
        this.store.settleEvolutionApplicationPublication({
          localProposalId: receipt.localProposalId,
          receiptDigest: receipt.receiptDigest,
          outcome: 'published',
        })
        published += 1
      } catch (error) {
        const code = error instanceof Error
          ? `delivery-${error.name.normalize('NFC').toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-').slice(0, 80)}`
          : 'delivery-unknown-error'
        this.store.settleEvolutionApplicationPublication({
          localProposalId: receipt.localProposalId,
          receiptDigest: receipt.receiptDigest,
          outcome: 'retry',
          error: code,
        })
      }
    }
    return published
  }

  private applicationPresentation(receipt: StoredEvolutionApplicationReceipt) {
    return Object.freeze({
      presentationKey: `approval-application:${receipt.policyProposalId}`,
      originalOutboxIdempotencyKey: `approval-card:${receipt.policyProposalId}`,
      revision: receipt.revision,
      presentation: Object.freeze({
        kind: 'approval-application' as const,
        policyProposalId: receipt.policyProposalId,
        localProposalId: receipt.localProposalId,
        applicationStatus: receipt.applicationStatus,
        operation: receipt.operation,
        terminalAt: receipt.terminalAt,
        receiptDigest: receipt.receiptDigest,
        ...(receipt.ruleId === undefined ? {} : { ruleId: receipt.ruleId }),
        ...(receipt.resultingRuleVersion === undefined
          ? {} : { resultingRuleVersion: receipt.resultingRuleVersion }),
        ...(receipt.ruleStatus === undefined ? {} : { ruleStatus: receipt.ruleStatus }),
      }),
    })
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
      const completed = this.store.completeAbandonedProposalRecovery(local.proposalId)
      return result(
        completed,
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
      let applied: ReturnType<EvolutionStore['settleProposal']>
      try {
        applied = this.withLearningWriterFence(local.mutation, () => this.store.settleProposal({
          proposalId: local.proposalId,
          policyStatus: terminal.status,
          policyVersion: terminal.version,
          reviewExpectation: local.settlementExpectation!,
        }))
      } catch (error) {
        if (!(error instanceof AssistantEvolutionError) || error.code !== 'forbidden') throw error
        // A stale/missing authoritative fence is itself the domain terminal.
        // This conflict-only transaction cannot apply a rule and therefore does
        // not need to acquire Evaluation in the reverse lock order.
        applied = this.store.settleProposal({
          proposalId: local.proposalId,
          securityConflict: true,
        })
      }
      this.reconcileApplicationPresentations()
      return result(applied.proposal, replayed || applied.replayed, applied.rule)
    } catch (error) {
      if (!(error instanceof ApprovalSettlementConflict)) throw error
      const conflict = this.store.settleProposal({
        proposalId: local.proposalId,
        securityConflict: true,
      })
      this.reconcileApplicationPresentations()
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

  /**
   * Acquire Evaluation first and Evolution only inside its synchronous callback.
   * No code holding an Evolution writer lock is allowed to call this method.
   */
  private withLearningWriterFence<T>(mutation: EvolutionMutation, callback: () => T): T {
    if (mutation.op === 'owner-undo') return callback()
    const evidence = mutation.evidence
    if (evidence === undefined || evidence.scopeWatermark === undefined
      || evidence.taskRevisions === undefined || evidence.taskRevisions.length !== evidence.total
      || evidence.taskRevisions.length < 1) {
      throw new AssistantEvolutionError(
        'forbidden',
        'evidence-dependent Evolution operations require a complete Evaluation writer fence',
      )
    }
    const scopeKey = mutation.op === 'adopt' ? mutation.input.scopeKey : mutation.scopeKey
    let scope: { workspace: string; preset: string }
    try {
      const parsed = JSON.parse(scopeKey) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 2
        || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') throw new Error('invalid')
      scope = { workspace: parsed[0], preset: parsed[1] }
    } catch {
      throw new AssistantEvolutionError('forbidden', 'Evolution evidence scope is not canonical')
    }
    const evaluation = this.context.get('assistantEvaluation') as TrustedEvaluationLedger | undefined
    if (evaluation === undefined
      || typeof evaluation.withTrustedLearningWriterFence !== 'function') {
      throw new AssistantEvolutionError(
        'forbidden',
        'authoritative Evaluation writer fence capability is unavailable',
      )
    }
    const result = evaluation.withTrustedLearningWriterFence({
      scope: canonicalEvaluationHostScope(scope),
      scopeWatermark: evidence.scopeWatermark,
      evidence: evidence.taskRevisions,
    }, callback)
    if (typeof result !== 'object' || result === null || !Object.isFrozen(result)
      || result.matched !== true) {
      const reason = typeof result === 'object' && result !== null && 'reason' in result
        ? String(result.reason)
        : 'invalid-fence-receipt'
      throw new AssistantEvolutionError(
        'forbidden',
        `Evolution evidence is stale at the authoritative writer fence: ${reason}`,
      )
    }
    return result.value
  }

  private candidatesForScope(scopeKey: string): RuleCandidate[] {
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

  private trustedTaskLearningReceipt(
    scope: EvolutionHostScope,
    evaluationId: string,
  ): TrustedTaskLearningProjectionReceipt {
    const evaluation = this.context.get('assistantEvaluation') as TrustedEvaluationLedger | undefined
    if (evaluation === undefined || typeof evaluation.getTrustedTaskLearningProjection !== 'function') {
      throw new AssistantEvolutionError('forbidden', 'authoritative assistantEvaluation lookup is unavailable')
    }
    const receipt = evaluation.getTrustedTaskLearningProjection({
      scope: canonicalEvaluationHostScope(scope),
      outcomeId: evaluationId,
    })
    if (receipt === undefined) {
      throw new AssistantEvolutionError('not-found', 'trusted Evaluation outcome was not found in the exact scope')
    }
    const scopeKey = canonicalEvolutionScope(scope.workspace, scope.preset)
    if (!Object.isFrozen(receipt) || !Object.isFrozen(receipt.scope)
      || !Object.isFrozen(receipt.projection)
      || receipt.triggerOutcomeId !== evaluationId || receipt.scopeKey !== scopeKey
      || receipt.scope.workspace !== scope.workspace
      || receipt.scope.preset !== scope.preset
      || !Number.isSafeInteger(receipt.scopeWatermark) || receipt.scopeWatermark < 1
      || (receipt.projection.subjectKind !== 'automation-run'
        && receipt.projection.subjectKind !== 'outcome')
      || hostText(receipt.projection.subjectRef, 'projection.subjectRef', 1_000)
        !== receipt.projection.subjectRef
      || !Number.isSafeInteger(receipt.projection.version) || receipt.projection.version < 1
      || receipt.projection.version > 1_000_000_000
      || !/^[a-f\d]{64}$/u.test(receipt.projection.digest)
      || (receipt.projection.disposition !== 'upsert'
        && receipt.projection.disposition !== 'retract')
      || evaluationLearningProjectionDigest(receipt) !== receipt.projection.digest) {
      throw new AssistantEvolutionError('forbidden', 'Evaluation returned a mismatched trusted receipt')
    }
    if (receipt.execution !== undefined && (!Object.isFrozen(receipt.execution)
      || !Object.isFrozen(receipt.execution.source)
      || !Object.isFrozen(receipt.execution.evaluator)
      || !Object.isFrozen(receipt.execution.evidence)
      || receipt.execution.evidence.some(entry => !Object.isFrozen(entry)))) {
      throw new AssistantEvolutionError('forbidden', 'Evaluation execution component is mutable')
    }
    if (receipt.objective !== undefined && (!Object.isFrozen(receipt.objective)
      || !Object.isFrozen(receipt.objective.source)
      || !Object.isFrozen(receipt.objective.evaluator)
      || !Object.isFrozen(receipt.objective.evidence)
      || receipt.objective.evidence.some(entry => !Object.isFrozen(entry)))) {
      throw new AssistantEvolutionError('forbidden', 'Evaluation objective component is mutable')
    }
    if (receipt.projection.disposition === 'upsert'
      && (receipt.objective === undefined
        || (receipt.objective.status !== 'achieved' && receipt.objective.status !== 'not-achieved')
        || receipt.projection.evidenceOutcomeId !== receipt.objective.outcomeId)) {
      throw new AssistantEvolutionError(
        'forbidden',
        'an upsert task revision requires one exact binary objective component',
      )
    }
    return receipt
  }

  private applyTrustedTaskLearningReceipt(
    scope: EvolutionHostScope,
    receipt: TrustedTaskLearningProjectionReceipt,
  ) {
    const scopeKey = canonicalEvolutionScope(scope.workspace, scope.preset)
    if (receipt.projection.disposition === 'retract') {
      return this.store.applyTaskLearningProjection({
        scopeKey,
        scopeWatermark: receipt.scopeWatermark,
        subjectKind: receipt.projection.subjectKind,
        subjectRef: receipt.projection.subjectRef,
        version: receipt.projection.version,
        digest: receipt.projection.digest,
        disposition: 'retract',
        situation: receipt.situation,
        occurredAt: receipt.execution?.occurredAt ?? receipt.objective?.occurredAt ?? this.now(),
      })
    }
    const objective = receipt.objective!
    const verified = this.verifiedAutomationAttribution(receipt, scopeKey)
    if (verified?.executionKind === 'host') {
      throw new AssistantEvolutionError('forbidden', 'Host runbook outcomes are not behavioural learning subjects')
    }
    return this.store.applyTaskLearningProjection({
      scopeKey,
      scopeWatermark: receipt.scopeWatermark,
      subjectKind: receipt.projection.subjectKind,
      subjectRef: receipt.projection.subjectRef,
      version: receipt.projection.version,
      digest: receipt.projection.digest,
      disposition: 'upsert',
      situation: receipt.situation,
      outcome: objective.status === 'achieved' ? 'succeeded' : 'failed',
      detail: `authoritative Evaluation objective: ${objective.status}`,
      evidenceRef: objective.outcomeId,
      occurredAt: receipt.execution?.occurredAt ?? objective.occurredAt,
      ...(verified?.attribution === undefined ? {} : verified.attribution),
    })
  }

  private verifiedAutomationAttribution(
    receipt: TrustedTaskLearningProjectionReceipt,
    scopeKey: string,
  ): Readonly<{
    executionKind: 'agent' | 'host'
    learningSubjectRef: string
    attribution?: Readonly<{ ruleId: string; guidanceVersion: number }>
  }> | undefined {
    if (receipt.projection.subjectKind !== 'automation-run') {
      return undefined
    }
    const execution = receipt.execution
    const runReferences = execution?.evidence.filter(entry => entry.kind === 'automation-run') ?? []
    if (execution === undefined || runReferences.length !== 1
      || runReferences[0]!.ref !== receipt.projection.subjectRef
      || !receipt.situation.startsWith('automation:')
      || execution.source.kind !== 'automation'
      || execution.source.id !== 'assistant-automations'
      || execution.evaluator.id !== 'assistant-automations'
      || !/^(?:terminal|host-runbook)-v[1-9][0-9]*$/u.test(execution.evaluator.version)) {
      throw new AssistantEvolutionError(
        'forbidden',
        'Evaluation receipt has no exact authoritative Automation execution component',
      )
    }
    const automationId = receipt.situation.slice('automation:'.length)
    if (automationId === '') {
      throw new AssistantEvolutionError('forbidden', 'Evaluation receipt has an invalid automation situation')
    }
    const reference = runReferences[0]!
    const resolver = this.context.get('assistantAutomations') as AutomationQualityEvidenceResolver | undefined
    if (resolver === undefined || typeof resolver.resolveQualityEvidence !== 'function'
      || typeof resolver.validateQualityEvidence !== 'function') {
      throw new AssistantEvolutionError(
        'forbidden',
        'authoritative assistantAutomations production proof is unavailable',
      )
    }
    let proof: AutomationQualityEvidenceReceipt | undefined
    let valid = false
    try {
      proof = resolver.resolveQualityEvidence({
        automationId,
        runId: reference.ref,
        expectedScope: { workspace: receipt.scope.workspace, preset: receipt.scope.preset },
        expectedSituation: receipt.situation,
        expectedOccurredAt: execution.occurredAt,
        evidenceRef: { kind: 'automation-run', ref: reference.ref },
      })
      valid = proof !== undefined && resolver.validateQualityEvidence(proof)
    } catch {
      throw new AssistantEvolutionError(
        'forbidden',
        'assistantAutomations rejected the production quality proof',
      )
    }
    if (!valid || proof === undefined || !Object.isFrozen(proof)
      || (proof.executionKind !== 'agent' && proof.executionKind !== 'host')
      || proof.automationId !== automationId || proof.runId !== reference.ref
      || proof.scope.workspace !== receipt.scope.workspace
      || proof.scope.preset !== receipt.scope.preset
      || proof.situation !== receipt.situation || proof.occurredAt !== execution.occurredAt
      || (proof.status === 'timed_out' ? 'timed-out' : proof.status) !== execution.status
      || proof.evidenceRef.kind !== 'automation-run' || proof.evidenceRef.ref !== reference.ref) {
      throw new AssistantEvolutionError(
        'forbidden',
        'assistantAutomations returned a mismatched production quality proof',
      )
    }
    const hasRule = proof.ruleId !== undefined
    const hasGuidanceVersion = proof.guidanceVersion !== undefined
    // A normal Agent automation always has a session id. Before the first rule
    // exists there is intentionally no guidance attribution; that baseline is
    // what makes bootstrap learning possible.
    if (proof.executionKind === 'host') {
      if (proof.sessionId !== undefined || hasRule || hasGuidanceVersion) {
        throw new AssistantEvolutionError('forbidden', 'Host automation proof contains Agent attribution')
      }
      return Object.freeze({
        executionKind: 'host' as const,
        learningSubjectRef: JSON.stringify(['automation-run', proof.runId]),
      })
    }
    if (!hasRule && !hasGuidanceVersion) {
      return Object.freeze({
        executionKind: 'agent' as const,
        learningSubjectRef: JSON.stringify(['automation-run', proof.runId]),
      })
    }
    if (proof.sessionId === undefined || !hasRule || !hasGuidanceVersion) {
      throw new AssistantEvolutionError('forbidden', 'automation guidance attribution proof is incomplete')
    }
    const exposure = this.store.captureGuidanceExposure(
      proof.sessionId,
      scopeKey,
      receipt.situation,
    )
    if (exposure === undefined || exposure.ruleId !== proof.ruleId
      || exposure.guidanceVersion !== proof.guidanceVersion
      || execution.occurredAt < exposure.exposedAt) {
      throw new AssistantEvolutionError(
        'forbidden',
        'automation guidance attribution does not match an exact Evolution exposure',
      )
    }
    return Object.freeze({
      executionKind: 'agent' as const,
      learningSubjectRef: JSON.stringify(['automation-run', proof.runId]),
      attribution: Object.freeze({ ruleId: exposure.ruleId, guidanceVersion: exposure.guidanceVersion }),
    })
  }

  private normalizedRollbackInput(input: {
    ruleId: string
    expectedVersion: number
  }): { ruleId: string; expectedVersion: number } {
    this.assertActive()
    if (!this.config.autonomousRollback) {
      throw new AssistantEvolutionError('forbidden', 'autonomous evolution rollback is disabled')
    }
    const ruleId = hostText(input.ruleId, 'ruleId', 200)
    if (!/^rule-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(ruleId)) {
      throw new AssistantEvolutionError('invalid-input', 'ruleId must be an immutable server-issued rule ID')
    }
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1
      || input.expectedVersion > 1_000_000_000) {
      throw new AssistantEvolutionError('invalid-input', 'expectedVersion must be a positive safe integer')
    }
    return { ruleId, expectedVersion: input.expectedVersion }
  }

  private rollbackForScope(
    scopeKey: string,
    input: { ruleId: string; expectedVersion: number },
  ): EvolutionRollbackResult {
    return this.store.rollbackRule({
      scopeKey,
      ruleId: input.ruleId,
      expectedVersion: input.expectedVersion,
      window: this.config.evaluationWindow,
      minSample: this.config.minSample,
      retireFailureRate: this.config.retireFailureRate,
      evidenceSampleLimit: this.config.maxEvidenceSamples,
    })
  }

  private authorizeHost(
    input: EvolutionHostOperation,
    action: 'inspect' | 'rollback',
    resourceId: string,
  ): string {
    this.assertActive()
    const scope = exactEvolutionHostScope(input.scope)
    const principal = hostText(input.principal, 'principal', 500)
    const operationId = hostText(input.operationId, 'operationId', 500)
    const canonicalResourceId = hostText(resourceId, 'resourceId', 500)
    const scopeKey = canonicalEvolutionScope(scope.workspace, scope.preset)
    const idempotencyDigest = createHash('sha256').update(JSON.stringify([
      HOST_RECOVERY_BACKGROUND_ID,
      scopeKey,
      principal,
      action,
      canonicalResourceId,
      operationId,
    ])).digest('hex')
    const decision = this.policy.authorize({
      subject: {
        kind: 'background',
        id: HOST_RECOVERY_BACKGROUND_ID,
        workspace: scope.workspace,
        principal,
      },
      action,
      resource: { kind: 'evolution', id: canonicalResourceId },
      context: { initiator: 'background' },
    }, { idempotencyKey: `evolution-host:${idempotencyDigest}` })
    if (decision.effect !== 'allow') {
      throw new AssistantEvolutionError('forbidden', `policy denied Host evolution ${action}`)
    }
    return scopeKey
  }

  private authorizeSupervisedGrowthAnalyst(
    agent: Agent | undefined,
    action: 'inspect' | 'propose',
    resourceId: 'analyst-adoption' | 'proposals',
  ): Readonly<{ scopeKey: string; occurrenceId: string }> {
    const scopeKey = this.authorize(agent, action, resourceId)
    const execution = (agent!.ctx as unknown as { get(name: string): unknown })
      .get('assistantAutomationExecution')
    if (typeof execution !== 'object' || execution === null || Array.isArray(execution)
      || !Object.isFrozen(execution)
      || Object.keys(execution).sort().join(',') !== 'automationId,mode,occurrenceId') {
      throw new AssistantEvolutionError(
        'forbidden',
        'adoption analyst requires the immutable Automation execution context',
      )
    }
    const installed = execution as {
      mode?: unknown
      automationId?: unknown
      occurrenceId?: unknown
    }
    if (installed.mode !== 'production'
      || installed.automationId !== SUPERVISED_GROWTH_ANALYST_AUTOMATION_ID
      || typeof installed.occurrenceId !== 'string') {
      throw new AssistantEvolutionError(
        'forbidden',
        'adoption analyst is restricted to its exact production Automation',
      )
    }
    const occurrenceId = hostText(installed.occurrenceId, 'occurrenceId', 500)
    if (occurrenceId !== installed.occurrenceId) {
      throw new AssistantEvolutionError('forbidden', 'analyst occurrence identity is not canonical')
    }
    return Object.freeze({ scopeKey, occurrenceId })
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
    if (!this.active) return
    const execution = (agent.ctx as unknown as { get(name: string): unknown })
      .get('assistantAutomationExecution')
    // Missing execution context is a normal foreground session. If a Host marks
    // the Agent as automation-scoped, only production may receive guidance or
    // write an exposure receipt. Malformed future modes fail closed as preview.
    let exactAutomationSituation: string | undefined
    if (execution !== undefined) {
      if (typeof execution !== 'object' || execution === null || Array.isArray(execution)
        || Object.keys(execution).sort().join(',') !== 'automationId,mode,occurrenceId') return
      const installed = execution as { mode?: unknown; automationId?: unknown; occurrenceId?: unknown }
      if (installed.mode !== 'production' || typeof installed.automationId !== 'string'
        || typeof installed.occurrenceId !== 'string') return
      let automationId: string
      try {
        automationId = hostText(installed.automationId, 'automationId', 500)
        hostText(installed.occurrenceId, 'occurrenceId', 500)
      } catch {
        return
      }
      exactAutomationSituation = `automation:${automationId}`
    }
    const workspace = agent.session.header.cwd
    const preset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || preset === undefined || preset.trim() === '') return
    const decision = this.policy.authorizeAgent(agent, 'snapshot', { kind: 'evolution', id: 'guidance' }, {
      idempotencyKey: `evolution-guidance:${agent.id}`,
    })
    if (decision.effect !== 'allow') return
    const scopeKey = canonicalEvolutionScope(workspace, preset)
    const sessionId = String(agent.session.id)
    const exposedCount = this.store.countGuidanceExposures(sessionId, scopeKey)
    const remaining = Math.max(0, this.config.maxInjectedRules - exposedCount)
    // Before Automation installs its execution context the session is
    // indistinguishable from foreground. With a multi-rule budget, reserve one
    // slot so the exact post-setup rule can still fit inside the global cap.
    const reserved = execution === undefined && this.config.maxInjectedRules > 1 ? 1 : 0
    const injectionLimit = Math.max(0, remaining - reserved)
    if (injectionLimit === 0) return
    const unseen = this.store.listRules(scopeKey, 'active').filter(rule => !this.store.hasGuidanceExposure(
      sessionId,
      scopeKey,
      rule.id,
      rule.generation,
    ))
    // A production Automation's exact rule must be selected before the global
    // max-rules slice. This is also safe when the post-setup hook follows an
    // earlier session-start: durable exposures remove already injected rules,
    // so the hook can still inject the previously omitted exact rule.
    const prioritized = exactAutomationSituation === undefined
      ? unseen
      : [
          ...unseen.filter(rule => rule.situation === exactAutomationSituation),
          ...unseen.filter(rule => rule.situation !== exactAutomationSituation),
        ]
    const snapshot = buildGuidanceSnapshot(prioritized, {
      maxBytes: this.config.maxGuidanceBytes,
      maxRules: injectionLimit,
      ...(exactAutomationSituation === undefined
        ? {} : { prioritySituation: exactAutomationSituation }),
    })
    if (snapshot.text === '') return
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
