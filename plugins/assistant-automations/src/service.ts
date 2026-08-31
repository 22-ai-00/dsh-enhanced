import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type {
  AssistantDeliveryService,
  DeliveryPresentationUpdate,
  TrustedDeliveryPresentationProducer,
  TrustedDeliveryPresentationRegistration,
} from '@dsh-enhanced/assistant-delivery'
import type {
  StoredOutcome,
  TrustedAutomationEvaluationProducer,
  TrustedAutomationEvaluationClaims,
  TrustedAutomationEvaluationRegistration,
} from '@dsh-enhanced/assistant-evaluation'
import {
  canonicalEvaluationHostScope,
  type AssistantEvaluationService,
} from '@dsh-enhanced/assistant-evaluation'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import {
  canonicalGrowthJson,
  growthObjectDigest,
  WORKFLOW_MODEL_TURN_CATALOG_ID,
  validateGrowthAutomationApprovalReceipt,
  validateGrowthAutomationApprovalRequest,
  validateGrowthAutomationArtifactRequest,
  validateGrowthAutomationProposalReceipt,
  validateGrowthAutomationProposalRequest,
  validateGrowthCanaryInspectionReceipt,
  validateGrowthCanaryInspectionRequest,
  validateGrowthCanaryReceipt,
  validateGrowthPromotionReceipt,
  validateGrowthReplayReceipt,
  validateGrowthRollbackReceipt,
  validateGrowthShadowReceipt,
  validateResolvedWorkflowAutomationTemplate,
  withGrowthPortReceiptDigest,
  type GrowthAutomationApprovalReceipt,
  type GrowthAutomationApprovalRequest,
  type GrowthAutomationArtifactRequest,
  type GrowthAutomationPort,
  type GrowthAutomationProposalReceipt,
  type GrowthAutomationProposalRequest,
  type GrowthCanaryInspectionReceipt,
  type GrowthCanaryInspectionRequest,
  type GrowthCanaryReceipt,
  type GrowthExperimentIdentity,
  type GrowthPromotionReceipt,
  type GrowthReplayReceipt,
  type GrowthRollbackReceipt,
  type GrowthShadowReceipt,
  type WorkflowTemplateResolver,
} from '@dsh-enhanced/assistant-growth-contract'
import { AutomationArtifactStore } from './artifacts.js'
import { HostAutomationExecutorRegistry } from './host-executors.js'
import {
  GROWTH_AUTOMATION_OWNER,
  GrowthAutomationStore,
  type GrowthArtifactRecord,
} from './growth.js'
import {
  AutomationCoordinator,
  type AutomationDeliveryDispatcher,
  type AutomationOutcomeRecorder,
  type AutomationRunner,
  type AutomationRunnerInput,
} from './coordinator.js'
import { AutomationProposalManager, AutomationProposalStore } from './proposals.js'
import { DshAutomationRunner, HostAutomationRunner, RoutedAutomationRunner } from './runner.js'
import { AutomationStore } from './store.js'
import { registerAutomationTools } from './tools.js'
import type {
  AutomationMutation,
  AutomationCircuitCanaryReceipt,
  AutomationCircuitProbeReceipt,
  AutomationDeliveryEvidenceReceipt,
  AgentAutomationDefinition,
  AutomationDefinition,
  AutomationEvaluationOutcome,
  AutomationOccurrence,
  AutomationProposalDecisionInput,
  AutomationProposalResult,
  AutomationRecord,
  AutomationRun,
  AutomationQualityEvidenceReceipt,
  MisfirePolicy,
  OverlapPolicy,
  RetrySafety,
  SystemOwnedAutomationHealthProjection,
  SystemOwnedAutomationIdentityProjection,
  SystemOwnedAutomationPauseReceipt,
  HostAutomationExecutor,
} from './types.js'
import { isHostAutomationDefinition } from './types.js'

export interface AutomationProposalDefaults {
  provider: string
  model: string
  /** Maximum tool set from which a model may request an immutable subset. */
  allowedTools: string[]
  timeoutMs: number
  maxOutputTokens: number
  maxToolCalls: number
  misfireKind: MisfirePolicy['kind']
  misfireLimit: number
  overlap: OverlapPolicy
  retrySafety: RetrySafety
  maxRetries: number
  budgetId: string
  budgetAmount: number
}

export type AutomationProposalMutation =
  | {
      op: 'create'
      automationId: string
      definition: Pick<AgentAutomationDefinition, 'allowedTools' | 'name' | 'prompt' | 'schedule'>
        & Partial<AgentAutomationDefinition>
    }
  | Exclude<AutomationMutation, { op: 'create' }>

export interface Config {
  databasePath: string
  runsPath: string
  schedulerEnabled?: boolean
  tickIntervalMs?: number
  dutyLeaseMs?: number
  taskLeaseMs?: number
  misfireGraceMs?: number
  maxCatchUp?: number
  maxConcurrency?: number
  maxArtifactBytes?: number
  defaultProposalTtlMs?: number
  /**
   * Poll interval for committing proposals that were approved out of band, for
   * example on an approval card after the originating turn ended. This runs even
   * when `schedulerEnabled` is false, because approving a paused automation must
   * still take effect. `0` disables the timer.
   */
  reconcileIntervalMs?: number
  /** Maximum locally pending proposals inspected per reconcile pass. */
  reconcileLimit?: number
  /** Safe default: every unattended occurrence must reserve a configured Policy budget. */
  allowUnbudgetedExecution?: boolean
  /** Trusted authority and execution bounds used for model-proposed definitions. */
  proposalDefaults?: AutomationProposalDefaults
}

export interface AutomationServiceProposalInput {
  idempotencyKey: string
  /** Headless-only compatibility. When Delivery is present this must exactly match its owner. */
  principal?: string
  mutation: AutomationProposalMutation
}

function registrationOwnedByEvaluation(
  registration: Readonly<TrustedAutomationEvaluationRegistration>,
): boolean {
  const candidate = registration as Readonly<TrustedAutomationEvaluationRegistration> & Readonly<{
    owner?: Readonly<{
      ownsTrustedAutomationEvaluationRegistration(
        value: Readonly<TrustedAutomationEvaluationRegistration>,
      ): boolean
    }>
  }>
  try {
    return typeof candidate.owner === 'object' && candidate.owner !== null
      && typeof candidate.owner.ownsTrustedAutomationEvaluationRegistration === 'function'
      && candidate.owner.ownsTrustedAutomationEvaluationRegistration(registration)
  } catch {
    return false
  }
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

interface DeliveryPresentationSinkRegistration {
  token: symbol
  registration: Readonly<TrustedDeliveryPresentationRegistration>
  dispose: () => void
}

/**
 * Bounded view of one proposal awaiting a decision. Deliberately excludes the
 * prompt, principal, and any host path so it is safe to surface to a model.
 */
export interface PendingAutomationProposal {
  proposalId: string
  automationId: string
  operation: AutomationMutation['op']
  expiresAt: number
  version: number
  attachedToPolicy: boolean
}

export interface SystemAutomationReconcileInput {
  owner: string
  automationId: string
  idempotencyKey: string
  desiredStatus?: 'active' | 'paused'
  definition: AutomationDefinition
}

export type AssistantAutomationsErrorCode =
  | 'disposed'
  | 'invalid-input'
  | 'invalid-proposal'
  | 'missing-identity'
  | 'missing-approval-route'
  | 'not-found'
  | 'policy-denied'
  | 'runtime-conflict'
  | 'unauthorized-principal'

export class AssistantAutomationsError extends Error {
  constructor(readonly code: AssistantAutomationsErrorCode, message: string) {
    super(message)
    this.name = 'AssistantAutomationsError'
  }
}

const proposalDefaults = Object.freeze<AutomationProposalDefaults>({
  provider: 'deepseek-official',
  model: 'deepseek-chat',
  allowedTools: [],
  timeoutMs: 60_000,
  maxOutputTokens: 512,
  maxToolCalls: 0,
  misfireKind: 'latest',
  misfireLimit: 1,
  overlap: 'skip',
  retrySafety: 'never',
  maxRetries: 0,
  budgetId: 'assistant-automations-proposals',
  budgetAmount: 1,
})

const routeText = Schema.string().pattern(/^[^\s\p{Cc}]{1,500}$/u)
const boundedId = Schema.string().pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u)
const proposalDefaultsSchema = Schema.object({
  provider: routeText.required(),
  model: routeText.required(),
  allowedTools: Schema.array(boundedId).max(100).required(),
  timeoutMs: Schema.number().step(1).min(1_000).max(86_400_000).required(),
  maxOutputTokens: Schema.number().step(1).min(1).max(1_000_000).required(),
  maxToolCalls: Schema.number().step(1).min(0).max(10_000).required(),
  misfireKind: Schema.union([
    Schema.const('skip'), Schema.const('latest'), Schema.const('bounded-replay'),
  ]).required(),
  misfireLimit: Schema.number().step(1).min(1).max(100).required(),
  overlap: Schema.union([
    Schema.const('skip'), Schema.const('queue-one'), Schema.const('cancel-previous'),
  ]).required(),
  retrySafety: Schema.union([Schema.const('never'), Schema.const('idempotent')]).required(),
  maxRetries: Schema.number().step(1).min(0).max(10).required(),
  budgetId: boundedId.required(),
  budgetAmount: Schema.number().step(1).min(1).max(10_000_000).required(),
}).default(proposalDefaults)

const configSchema = Schema.object({
  databasePath: Schema.string().required(),
  runsPath: Schema.string().required(),
  schedulerEnabled: Schema.boolean().default(false),
  tickIntervalMs: Schema.number().step(1).min(1_000).default(5_000),
  dutyLeaseMs: Schema.number().step(1).min(3_000).default(15_000),
  taskLeaseMs: Schema.number().step(1).min(3_000).default(30_000),
  misfireGraceMs: Schema.number().step(1).min(0).default(60_000),
  maxCatchUp: Schema.number().step(1).min(1).max(1_000).default(100),
  maxConcurrency: Schema.number().step(1).min(1).max(100).default(1),
  maxArtifactBytes: Schema.number().step(1).min(128).max(16 * 1024 * 1024).default(1_048_576),
  defaultProposalTtlMs: Schema.number().step(1).min(1).default(900_000),
  reconcileIntervalMs: Schema.number().step(1).min(0).default(15_000),
  reconcileLimit: Schema.number().step(1).min(1).max(1_000).default(50),
  allowUnbudgetedExecution: Schema.boolean().default(false),
  proposalDefaults: proposalDefaultsSchema,
}) as Schema<Config>

declare module '@deepseek-ai/cordis' {
  interface Context {
    assistantAutomations: AssistantAutomationsService
  }
}

function policyError(decision: PolicyDecision): AssistantAutomationsError {
  return new AssistantAutomationsError(
    'policy-denied',
    `assistant-automations policy denied operation: ${decision.reasonCode}`,
  )
}

function growthIdentity(input: Readonly<GrowthExperimentIdentity>): Readonly<GrowthExperimentIdentity> {
  return Object.freeze({
    contractVersion: 1,
    operationId: input.operationId,
    experimentId: input.experimentId,
    candidateId: input.candidateId,
    candidateRevision: input.candidateRevision,
    candidateDigest: input.candidateDigest,
  })
}

function boundedGrowthKey(prefix: string, value: unknown): string {
  return `${prefix}:${growthObjectDigest(value)}`
}

const growthEffectBlockerAttestation = Object.freeze({
  contract: 'assistant-automations-effect-blocker/v1' as const,
  blockedEffects: Object.freeze(['delivery', 'tool-execution'] as const),
  implementationDigest: growthObjectDigest({
    contract: 'assistant-automations-growth-effect-blocker-implementation/v1',
    immutablePausedTaskAdmission: true,
    executionMode: 'preview',
    supportedWorkflowKind: 'model-turn-only',
    validatedOrchestrationStep: WORKFLOW_MODEL_TURN_CATALOG_ID,
    runnerToolAllowlist: [],
    terminalDelivery: 'suppressed',
  }),
})

class PolicyBoundRunner implements AutomationRunner {
  constructor(
    private readonly policy: AssistantPolicyService,
    private readonly delegate: AutomationRunner,
  ) {}

  run(input: AutomationRunnerInput) {
    const decision = this.policy.authorize({
      subject: {
        kind: 'background',
        id: input.automation.id,
        workspace: input.automation.definition.workspace,
        principal: input.automation.definition.principal,
      },
      action: 'execute',
      resource: { kind: 'automation', id: input.automation.id },
      context: { initiator: 'background' },
    }, { idempotencyKey: `automation-execute:${input.occurrence.id}` })
    if (decision.effect !== 'allow') {
      const host = isHostAutomationDefinition(input.automation.definition)
      return Promise.resolve({
        outcome: 'cancelled' as const,
        output: `policy denied background execution: ${decision.reasonCode}`,
        usage: {},
        diagnostic: Object.freeze({
          schemaVersion: 1 as const,
          failureClass: 'policy' as const,
          failurePhase: 'preflight' as const,
          failureCode: 'policy-denied',
          promptSubmissionState: host ? 'not-applicable' as const : 'not-submitted' as const,
          sideEffectState: 'none' as const,
          retryability: 'after-intervention' as const,
          budgetSettlementState: input.automation.definition.budgetId === undefined
            ? 'not-required' as const
            : 'not-reserved' as const,
        }),
      })
    }
    return this.delegate.run(input)
  }
}

export class AssistantAutomationsService extends Service implements
  TrustedAutomationEvaluationProducer, TrustedDeliveryPresentationProducer, GrowthAutomationPort {
  static Config = configSchema

  private readonly store: AutomationStore
  private readonly proposalStore: AutomationProposalStore
  private readonly growthStore: GrowthAutomationStore
  private readonly proposals: AutomationProposalManager
  private readonly policy: AssistantPolicyService
  private readonly coordinator: AutomationCoordinator
  private readonly hostExecutors = new HostAutomationExecutorRegistry()
  private readonly config: Required<Config>
  private readonly evaluationProducerGeneration = `assistant-automations:${randomUUID()}`
  private readonly presentationProducerGeneration = `assistant-automations-presentation:${randomUUID()}`
  private evaluationSink:
    | Readonly<{ token: symbol; registration: Readonly<TrustedAutomationEvaluationRegistration> }>
    | undefined
  private presentationSink: DeliveryPresentationSinkRegistration | undefined
  private approvalDelivery: Pick<
    AssistantDeliveryService,
    'prepareAgentApproval' | 'prepareWorkflowApproval'
  > | undefined
  private workflowTemplateResolver: WorkflowTemplateResolver | undefined
  private evaluation: AssistantEvaluationService | undefined
  private active = true

  constructor(ctx: Context, input: Config) {
    super(ctx, 'assistantAutomations')
    let config: Required<Config>
    try {
      config = AssistantAutomationsService.Config(input) as Required<Config>
    } catch (error) {
      throw new Error(`assistant-automations: invalid configuration: ${String(error)}`, { cause: error })
    }
    if (!isAbsolute(config.databasePath) || !isAbsolute(config.runsPath)) {
      throw new Error('assistant-automations: databasePath and runsPath must be absolute paths')
    }
    if (new Set(config.proposalDefaults.allowedTools).size !== config.proposalDefaults.allowedTools.length) {
      throw new Error('assistant-automations: invalid configuration: proposalDefaults.allowedTools contains a duplicate')
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('assistant-automations: assistantPolicy service is required')
    this.config = config
    this.policy = policy
    const initialDelivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    this.approvalDelivery = initialDelivery
    this.workflowTemplateResolver = initialDelivery
    this.evaluation = ctx.get('assistantEvaluation') as AssistantEvaluationService | undefined
    this.store = new AutomationStore({ path: config.databasePath })
    this.proposalStore = new AutomationProposalStore({ path: config.databasePath })
    this.growthStore = new GrowthAutomationStore(config.databasePath)
    this.proposals = new AutomationProposalManager(this.store, this.proposalStore, policy)
    const artifacts = new AutomationArtifactStore({ rootPath: config.runsPath, maxBytes: config.maxArtifactBytes })
    const runner = new PolicyBoundRunner(policy, new RoutedAutomationRunner(
      new DshAutomationRunner(ctx, policy, {
        allowUnbudgetedExecution: config.allowUnbudgetedExecution,
      }),
      new HostAutomationRunner(this.hostExecutors, policy, {
        allowUnbudgetedExecution: config.allowUnbudgetedExecution,
      }),
    ))
    this.coordinator = new AutomationCoordinator({
      store: this.store,
      artifacts,
      runner,
      ownerId: `assistant-automations-${randomUUID()}`,
      dutyLeaseMs: config.dutyLeaseMs,
      taskLeaseMs: config.taskLeaseMs,
      misfireGraceMs: config.misfireGraceMs,
      maxCatchUp: config.maxCatchUp,
      maxConcurrency: config.maxConcurrency,
      tickIntervalMs: config.tickIntervalMs,
      hostExecutors: this.hostExecutors,
    })
    if (initialDelivery !== undefined) {
      this.coordinator.setDeliveryDispatcher(this.deliveryDispatcher(initialDelivery))
    }
    ctx.inject(['assistantDelivery'], deliveryCtx => {
      const delivery = deliveryCtx.get('assistantDelivery') as AssistantDeliveryService
      this.approvalDelivery = delivery
      this.workflowTemplateResolver = delivery
      this.coordinator.setDeliveryDispatcher(this.deliveryDispatcher(delivery))
      return () => {
        if (this.approvalDelivery === delivery) {
          this.approvalDelivery = undefined
          if (this.workflowTemplateResolver === delivery) this.workflowTemplateResolver = undefined
          this.coordinator.setDeliveryDispatcher(undefined)
        }
      }
    })
    ctx.inject(['assistantEvaluation'], evaluationCtx => {
      const evaluation = evaluationCtx.get('assistantEvaluation') as AssistantEvaluationService
      this.evaluation = evaluation
      return () => {
        if (this.evaluation === evaluation) this.evaluation = undefined
      }
    })
    // Optional: when a learning plugin is composed, finished runs become evidence.
    // The binding is one-way and structural, so the scheduler works identically
    // whether or not assistant-evolution is installed.
    ctx.inject(['assistantEvolution'], evolutionCtx => {
      const recorder = evolutionCtx.get('assistantEvolution') as AutomationOutcomeRecorder
      this.coordinator.setOutcomeRecorder(recorder)
      return () => this.coordinator.setOutcomeRecorder(undefined)
    })
    // Evaluation attaches in the opposite direction through the private
    // producer capability below.  Passing the public Evaluation service to the
    // coordinator would let an ordinary caller self-assert `trust: trusted`.
    if (config.schedulerEnabled) this.coordinator.start()
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
      }, 'assistant-automations.reconcile')
    }
    ctx.inject(['tools'], toolsCtx => registerAutomationTools(toolsCtx, this))
    ctx.effect(() => async () => {
      this.active = false
      this.evaluationSink = undefined
      this.presentationSink?.dispose()
      this.coordinator.setEvaluationRecorder(undefined)
      await this.coordinator.stop()
      this.proposalStore.close()
      this.growthStore.close()
      this.store.close()
    }, 'assistant-automations.runtime')
  }

  trustedEvaluationProducerGeneration(): string {
    this.assertActive()
    return this.evaluationProducerGeneration
  }

  trustedDeliveryPresentationProducerGeneration(): string {
    this.assertActive()
    return this.presentationProducerGeneration
  }

  /**
   * Delivery creates this publisher and can revoke it on either service's
   * reload. Automations retains it only as a private coordinator adapter; no
   * Agent, Automation definition, or public Delivery dispatcher can mint one.
   */
  registerTrustedDeliveryPresentationSink(
    registration: Readonly<TrustedDeliveryPresentationRegistration>,
  ): () => void {
    this.assertActive()
    if (registration.protocol !== 'assistant-delivery/trusted-presentation-producer/v1'
      || registration.producer !== 'assistant-automations'
      || registration.generation !== this.presentationProducerGeneration
      || typeof registration.publish !== 'function'
      || !registrationOwnedByDeliveryPresentation(registration)) {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Delivery presentation registration is invalid')
    }
    const current = this.presentationSink
    if (current !== undefined) {
      if (current.registration === registration) return current.dispose
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Delivery presentation sink is already registered')
    }
    const token = Symbol('assistant-automations.trusted-delivery-presentation')
    let live = true
    const dispose = () => {
      if (!live) return
      live = false
      if (this.presentationSink?.token === token) this.presentationSink = undefined
    }
    this.presentationSink = Object.freeze({ token, registration, dispose })
    return dispose
  }

  private deliveryDispatcher(delivery: AssistantDeliveryService): AutomationDeliveryDispatcher {
    return Object.freeze({
      enqueueBackground: (input: Parameters<AutomationDeliveryDispatcher['enqueueBackground']>[0]) =>
        delivery.enqueueBackground(input),
      enqueueAutomationResult: (input: Parameters<NonNullable<
        AutomationDeliveryDispatcher['enqueueAutomationResult']
      >>[0]) => delivery.enqueueAutomationResult(input),
      enqueueBackgroundRoute: (input: Parameters<NonNullable<
        AutomationDeliveryDispatcher['enqueueBackgroundRoute']
      >>[0]) => delivery.enqueueBackgroundRoute(input),
      // This is a closure over the private registration rather than a method
      // taken from the public Delivery service object.
      publishDeliveryPresentation: (input: DeliveryPresentationUpdate) =>
        this.publishAutomationIncidentPresentation(input),
    })
  }

  private publishAutomationIncidentPresentation(
    input: DeliveryPresentationUpdate,
  ): { status: string } {
    this.assertActive()
    const sink = this.presentationSink
    if (sink === undefined) {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Delivery presentation sink is unavailable')
    }
    return sink.registration.publish(input)
  }

  /**
   * Bind the one exact Evaluation instance allowed to consume this service's
   * durable terminal outbox.  The registration object is a process-local
   * capability; it is never exposed as a model tool or accepted from payload
   * data.
   */
  registerTrustedAutomationEvaluationSink(
    registration: Readonly<TrustedAutomationEvaluationRegistration>,
  ): () => void {
    this.assertActive()
    if (registration.protocol !== 'assistant-evaluation/trusted-producer/v1'
      || registration.producer !== 'assistant-automations'
      || registration.generation !== this.evaluationProducerGeneration
      || typeof registration.issueCapability !== 'function'
      || typeof registration.append !== 'function'
      || !registrationOwnedByEvaluation(registration)) {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Evaluation registration is invalid')
    }
    if (this.evaluationSink !== undefined) {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Evaluation sink is already registered')
    }
    const token = Symbol('assistant-automations.trusted-evaluation')
    this.evaluationSink = Object.freeze({ token, registration })
    this.coordinator.setEvaluationRecorder(Object.freeze({
      append: (outcome: AutomationEvaluationOutcome) => this.appendTrustedEvaluation(token, outcome),
    }))
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.evaluationSink?.token !== token) return
      this.evaluationSink = undefined
      this.coordinator.setEvaluationRecorder(undefined)
    }
  }

  private appendTrustedEvaluation(token: symbol, outcome: AutomationEvaluationOutcome): StoredOutcome {
    this.assertActive()
    const sink = this.evaluationSink
    const runEvidence = outcome.evidence.filter(entry => entry.kind === 'automation-run')
    const automationId = outcome.situation.startsWith('automation:')
      ? outcome.situation.slice('automation:'.length)
      : ''
    const runId = runEvidence[0]?.ref
    const proof = runId === undefined ? undefined : this.store.getProvenProductionRun(runId)
    const expectedExecutionStatus = proof?.run.status === 'timed_out'
      ? 'timed-out'
      : proof?.run.status
    const hostObjectiveProven = proof !== undefined
      && isHostAutomationDefinition(proof.automation.definition)
      && (proof.run.status === 'succeeded'
        || proof.run.status === 'failed' || proof.run.status === 'timed_out')
    const expectedObjectiveStatus = proof === undefined || !hostObjectiveProven
      ? 'unknown'
      : proof.run.status === 'succeeded' ? 'achieved' : 'not-achieved'
    const expectedEvaluatorVersion = hostObjectiveProven ? 'host-runbook-v1' : 'terminal-v1'
    if (sink?.token !== token || outcome.executionMode !== 'production'
      || automationId === '' || runEvidence.length !== 1
      || runId === undefined || proof === undefined
      || proof.run.automationId !== automationId
      || proof.automation.definition.workspace !== outcome.scope.workspace
      || proof.automation.definition.agentPreset !== outcome.scope.preset
      || outcome.situation !== `automation:${automationId}`
      || outcome.executionStatus !== expectedExecutionStatus
      || outcome.objectiveStatus !== expectedObjectiveStatus
      || outcome.occurredAt !== proof.run.createdAt
      || outcome.idempotencyKey !== `assistant-automations:terminal:${runId}:v1`
      || outcome.evaluator.version !== expectedEvaluatorVersion
      || outcome.source.kind !== 'automation' || outcome.source.id !== 'assistant-automations'
      || outcome.trust !== 'trusted' || outcome.evaluator.id !== 'assistant-automations') {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Evaluation outbox payload is invalid')
    }
    const claims: TrustedAutomationEvaluationClaims = Object.freeze({
      scope: Object.freeze({ ...outcome.scope }),
      automationId,
      situation: outcome.situation,
      runId,
      executionMode: 'production',
      executionStatus: outcome.executionStatus,
      objectiveStatus: outcome.objectiveStatus,
      deliveryStatus: outcome.deliveryStatus,
      metrics: Object.freeze({ ...outcome.metrics }),
      occurredAt: outcome.occurredAt,
      idempotencyKey: outcome.idempotencyKey,
      evaluatorVersion: outcome.evaluator.version,
    })
    const capabilityReceipt = sink.registration.issueCapability(claims)
    if (this.evaluationSink?.token !== token) {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Evaluation capability became stale')
    }
    const receipt = sink.registration.append({
      capabilityReceipt,
      automationId,
      runId: claims.runId,
      idempotencyKey: claims.idempotencyKey,
    })
    if (receipt.idempotencyKey !== claims.idempotencyKey
      || receipt.source.kind !== 'automation' || receipt.source.id !== 'assistant-automations'
      || receipt.trust !== 'trusted') {
      throw new AssistantAutomationsError('runtime-conflict', 'trusted Evaluation receipt is invalid')
    }
    return receipt
  }

  /**
   * Re-prove Delivery's mutable owner/template authority immediately before a
   * Growth phase can submit a model turn, expose production output, or promote
   * the definition. Rollback deliberately does not use this gate: losing the
   * old owner route must never prevent reducing authority.
   */
  private hasShadowEffectBlocker(run: Readonly<Pick<AutomationRun,
    'deliveryRef' | 'deliveryStatus' | 'evidenceStatus' | 'executionMode' | 'usage'>>): boolean {
    // Preview execution has no Delivery lane at all. `undefined` is the
    // durable Store representation of that structural no-send state; a
    // pending/enqueued/suppressed delivery record is not interchangeable with
    // a preview blocker and must fail closed here.
    return run.executionMode === 'preview'
      && run.deliveryStatus === undefined
      && run.deliveryRef === undefined
      && run.evidenceStatus === 'suppressed'
      && run.usage['toolCalls'] === 0
  }

  private requireLiveGrowthArtifact(
    artifact: Readonly<GrowthArtifactRecord>,
  ): Readonly<AutomationRecord> {
    const resolver = this.workflowTemplateResolver
    if (resolver === undefined || typeof resolver.resolveWorkflowAutomationTemplate !== 'function') {
      throw new AssistantAutomationsError('runtime-conflict', 'Delivery template authority is unavailable')
    }
    const live = validateResolvedWorkflowAutomationTemplate(resolver.resolveWorkflowAutomationTemplate({
      contractVersion: 1,
      template: {
        templateRef: artifact.templateRef,
        templateDigest: artifact.templateDigest,
        privacyAttestation: artifact.privacyAttestation,
      },
      scope: { workspace: artifact.workspace, preset: artifact.preset },
      ownerBindingId: artifact.ownerBindingId,
    }))
    const definition = this.store.get(artifact.automationId)
    const observedCatalog = [...new Set(artifact.steps.map(step => step.catalogId))].sort()
    const exact = definition !== undefined && definition.owner === GROWTH_AUTOMATION_OWNER
      && !isHostAutomationDefinition(definition.definition)
      && canonicalGrowthJson(live.template) === canonicalGrowthJson({
        templateRef: artifact.templateRef,
        templateDigest: artifact.templateDigest,
        privacyAttestation: artifact.privacyAttestation,
      })
      && live.scope.workspace === artifact.workspace && live.scope.preset === artifact.preset
      && live.ownerBindingId === artifact.ownerBindingId && live.principalId === artifact.principalId
      && canonicalGrowthJson(live.toolCatalogIds) === canonicalGrowthJson(observedCatalog)
      && definition.definition.name === live.name && definition.definition.prompt === live.prompt
      && canonicalGrowthJson(definition.definition.schedule) === canonicalGrowthJson(live.schedule)
      && definition.definition.workspace === live.scope.workspace
      && definition.definition.agentPreset === live.scope.preset
      && definition.definition.timeoutMs === live.timeoutMs
      && canonicalGrowthJson(definition.definition.allowedTools) === canonicalGrowthJson([])
      && definition.definition.maxToolCalls === 0
      && definition.definition.principal === live.principalId
      && definition.definition.approvalBindingId === live.ownerBindingId
      && definition.definition.deliveryBindingId === live.deliveryBindingId
      && this.store.getDefinitionHash(definition.id) === artifact.definitionHash
    if (!exact || definition === undefined) {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'Growth owner, template, or materialized Automation changed before execution',
      )
    }
    return definition
  }

  async requestWorkflowAutomation(
    inputValue: Readonly<GrowthAutomationProposalRequest>,
  ): Promise<GrowthAutomationProposalReceipt> {
    this.assertActive()
    const input = validateGrowthAutomationProposalRequest(inputValue)
    const replay = this.growthStore.beginOperation('approval-proposal', input)
    if (replay !== undefined) return validateGrowthAutomationProposalReceipt(replay, growthIdentity(input))
    const resolver = this.workflowTemplateResolver
    if (resolver === undefined || typeof resolver.resolveWorkflowAutomationTemplate !== 'function') {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'Growth materialization requires the private Delivery workflow template resolver',
      )
    }
    const resolved = validateResolvedWorkflowAutomationTemplate(resolver.resolveWorkflowAutomationTemplate({
      contractVersion: 1,
      template: input.template,
      scope: input.scope,
      ownerBindingId: input.ownerBindingId,
    }))
    if (canonicalGrowthJson(resolved.template) !== canonicalGrowthJson(input.template)
      || canonicalGrowthJson(resolved.scope) !== canonicalGrowthJson(input.scope)
      || resolved.ownerBindingId !== input.ownerBindingId) {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'Delivery resolved a different workflow template or owner scope',
      )
    }
    const approvalDelivery = this.approvalDelivery
    if (approvalDelivery === undefined || typeof approvalDelivery.prepareWorkflowApproval !== 'function') {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'Growth approval requires the private Delivery v2 approval route resolver',
      )
    }
    const dispatch = approvalDelivery.prepareWorkflowApproval({
      sourceId: GROWTH_AUTOMATION_OWNER,
      contractVersion: 1,
      template: input.template,
      scope: input.scope,
      ownerBindingId: input.ownerBindingId,
    })
    if (dispatch.routeVersion !== 2
      || dispatch.sourceId !== GROWTH_AUTOMATION_OWNER
      || dispatch.bindingId !== resolved.ownerBindingId
      || dispatch.workspace !== resolved.scope.workspace
      || dispatch.principal !== resolved.principalId) {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'Delivery resolved a different workflow approval route',
      )
    }
    const requestedCatalog = [...resolved.toolCatalogIds]
    const observedCatalog = [...new Set(input.steps.map(step => step.catalogId))].sort()
    if (canonicalGrowthJson(observedCatalog) !== canonicalGrowthJson(requestedCatalog)) {
      throw new AssistantAutomationsError(
        'invalid-proposal',
        'Growth workflow catalog must exactly match its observed step catalog',
      )
    }
    const orchestrationSteps = input.steps.filter(
      step => step.catalogId === WORKFLOW_MODEL_TURN_CATALOG_ID,
    )
    const requestedTools = requestedCatalog.filter(id => id !== WORKFLOW_MODEL_TURN_CATALOG_ID)
    // The current shadow executor has a real empty tool plane, so it can prove
    // delivery/tool effects are impossible only for Delivery's built-in model
    // turn. A tool-bearing workflow remains representable in the trace contract
    // but cannot enter approval until a Host-owned per-step interception receipt
    // exists; zero observed calls is never treated as that proof.
    if (orchestrationSteps.length !== 1 || input.steps.length !== 1 || requestedTools.length !== 0) {
      throw new AssistantAutomationsError(
        'invalid-proposal',
        'Growth shadow currently supports only one assistant.agent-turn step and fails closed for tool workflows',
      )
    }
    if (requestedTools.some(tool => !this.config.proposalDefaults.allowedTools.includes(tool))
      || new Set(requestedTools).size !== requestedTools.length
      || canonicalGrowthJson([...new Set(input.steps.map(step => step.catalogId))].sort())
        !== canonicalGrowthJson(requestedCatalog)) {
      throw new AssistantAutomationsError(
        'invalid-proposal',
        'Growth workflow catalog must exactly match observed steps and configured trusted tools',
      )
    }
    const defaults = this.config.proposalDefaults
    const misfire: MisfirePolicy = defaults.misfireKind === 'bounded-replay'
      ? { kind: 'bounded-replay', limit: defaults.misfireLimit }
      : { kind: defaults.misfireKind }
    const definition: AgentAutomationDefinition = Object.freeze({
      name: resolved.name,
      prompt: resolved.prompt,
      schedule: resolved.schedule,
      workspace: resolved.scope.workspace,
      agentPreset: resolved.scope.preset,
      provider: defaults.provider,
      model: defaults.model,
      allowedTools: Object.freeze(requestedTools),
      timeoutMs: resolved.timeoutMs,
      maxOutputTokens: defaults.maxOutputTokens,
      maxToolCalls: 0,
      misfire,
      overlap: defaults.overlap,
      retrySafety: defaults.retrySafety,
      maxRetries: defaults.maxRetries,
      principal: resolved.principalId,
      budgetId: defaults.budgetId,
      budgetAmount: defaults.budgetAmount,
      approvalBindingId: resolved.ownerBindingId,
      deliveryBindingId: resolved.deliveryBindingId,
    })
    const automationId = this.growthStore.automationId(input)
    const artifactId = this.growthStore.artifactId(input)
    const diff = JSON.stringify({
      contract: 'assistant-growth-approval-diff/v2',
      artifactId,
      automationId,
      candidateId: input.candidateId,
      candidateRevision: input.candidateRevision,
      candidateDigest: input.candidateDigest,
      template: input.template,
      scope: input.scope,
      ownerBindingId: input.ownerBindingId,
      exactBehavior: {
        name: resolved.name,
        prompt: resolved.prompt,
        schedule: resolved.schedule,
        timeoutMs: resolved.timeoutMs,
        provider: defaults.provider,
        model: defaults.model,
        maxOutputTokens: defaults.maxOutputTokens,
        orchestrationCatalogIds: resolved.toolCatalogIds,
        executableTools: requestedTools,
        approvalBindingId: resolved.ownerBindingId,
        deliveryBindingId: resolved.deliveryBindingId,
      },
      initialState: 'paused',
    }, null, 2)
    const approval = this.policy.recoverOrCreateProposal({
      idempotencyKey: boundedGrowthKey('growth-approval', growthIdentity(input)),
      requester: GROWTH_AUTOMATION_OWNER,
      principal: resolved.principalId,
      action: 'create',
      resource: { kind: 'automation', id: automationId },
      diff,
      summary: 'Approve learned workflow as a paused Automation',
      notAfter: input.deadlineAt,
      dispatch,
    })
    if (approval.kind === 'abandoned') {
      const receipt = withGrowthPortReceiptDigest({
        ...growthIdentity(input), outcome: 'expired' as const,
      })
      return validateGrowthAutomationProposalReceipt(
        this.growthStore.completeOperation('approval-proposal', input, receipt),
        growthIdentity(input),
      )
    }
    const automation = this.reconcileSystem({
      owner: GROWTH_AUTOMATION_OWNER,
      automationId,
      idempotencyKey: boundedGrowthKey('growth-materialize', growthIdentity(input)),
      desiredStatus: 'paused',
      definition,
    })
    const stored = this.growthStore.upsertArtifact({
      request: input,
      resolved,
      automation,
      proposalId: approval.proposal.proposalId,
      approvalDiffHash: approval.proposal.diffHash,
      policyStatus: approval.proposal.status,
    })
    const receipt = approval.proposal.status === 'approved'
      ? withGrowthPortReceiptDigest({
          ...growthIdentity(input),
          outcome: 'approved-paused' as const,
          proposalId: approval.proposal.proposalId,
          artifactId: stored.artifactId,
          artifactVersion: stored.definitionVersion,
          artifactDigest: stored.definitionHash,
        })
      : approval.proposal.status === 'pending'
        ? withGrowthPortReceiptDigest({
            ...growthIdentity(input),
            outcome: 'approval-pending' as const,
            proposalId: approval.proposal.proposalId,
          })
        : withGrowthPortReceiptDigest({
            ...growthIdentity(input),
            outcome: approval.proposal.status as 'expired' | 'rejected',
            proposalId: approval.proposal.proposalId,
          })
    return validateGrowthAutomationProposalReceipt(
      this.growthStore.completeOperation('approval-proposal', input, receipt),
      growthIdentity(input),
    )
  }

  async settleWorkflowAutomation(
    inputValue: Readonly<GrowthAutomationApprovalRequest>,
  ): Promise<GrowthAutomationApprovalReceipt> {
    this.assertActive()
    const input = validateGrowthAutomationApprovalRequest(inputValue)
    const replay = this.growthStore.beginOperation('approval-settlement', input)
    if (replay !== undefined) return validateGrowthAutomationApprovalReceipt(replay, growthIdentity(input))
    const artifact = this.growthStore.byExperiment(input.experimentId)
    const proposal = this.policy.getProposal(input.proposalId)
    const definition = artifact === undefined ? undefined : this.store.get(artifact.automationId)
    const exact = artifact !== undefined && artifact.proposalId === input.proposalId
      && artifact.candidateId === input.candidateId
      && artifact.candidateRevision === input.candidateRevision
      && artifact.candidateDigest === input.candidateDigest
      && proposal?.requester === GROWTH_AUTOMATION_OWNER
      && proposal.principal === artifact.principalId
      && proposal.action === 'create'
      && proposal.resource.kind === 'automation'
      && proposal.resource.id === artifact.automationId
      && proposal.diffHash === artifact.approvalDiffHash
      && proposal.expiresAt === artifact.deadlineAt
      && definition?.owner === GROWTH_AUTOMATION_OWNER
      && definition.status === 'paused'
      && definition.version === artifact.definitionVersion
      && this.store.getDefinitionHash(artifact.automationId) === artifact.definitionHash
    if (!exact || artifact === undefined || proposal === undefined) {
      const receipt = withGrowthPortReceiptDigest({
        ...growthIdentity(input), outcome: 'conflicted' as const, proposalId: input.proposalId,
      })
      return validateGrowthAutomationApprovalReceipt(
        this.growthStore.completeOperation('approval-settlement', input, receipt),
        growthIdentity(input),
      )
    }
    if (proposal.status === 'approved') {
      const resolver = this.workflowTemplateResolver
      if (resolver === undefined || typeof resolver.resolveWorkflowAutomationTemplate !== 'function') {
        throw new AssistantAutomationsError('runtime-conflict', 'Delivery template authority is unavailable')
      }
      const live = validateResolvedWorkflowAutomationTemplate(resolver.resolveWorkflowAutomationTemplate({
        contractVersion: 1,
        template: {
          templateRef: artifact.templateRef,
          templateDigest: artifact.templateDigest,
          privacyAttestation: artifact.privacyAttestation,
        },
        scope: { workspace: artifact.workspace, preset: artifact.preset },
        ownerBindingId: artifact.ownerBindingId,
      }))
      if (live.template.templateRef !== artifact.templateRef
        || live.template.templateDigest !== artifact.templateDigest
        || canonicalGrowthJson(live.template.privacyAttestation)
          !== canonicalGrowthJson(artifact.privacyAttestation)
        || live.scope.workspace !== artifact.workspace || live.scope.preset !== artifact.preset
        || live.principalId !== artifact.principalId
        || live.deliveryBindingId !== definition.definition.deliveryBindingId
        || live.ownerBindingId !== definition.definition.approvalBindingId) {
        throw new AssistantAutomationsError('runtime-conflict', 'Growth owner route changed before approval settlement')
      }
    }
    this.growthStore.updateApproval(artifact.artifactId, input.proposalId, proposal.status)
    const receipt = proposal.status === 'approved'
      ? withGrowthPortReceiptDigest({
          ...growthIdentity(input), outcome: 'approved-paused' as const, proposalId: input.proposalId,
          artifactId: artifact.artifactId, artifactVersion: artifact.definitionVersion,
          artifactDigest: artifact.definitionHash,
        })
      : proposal.status === 'pending'
        ? withGrowthPortReceiptDigest({
            ...growthIdentity(input), outcome: 'approval-pending' as const, proposalId: input.proposalId,
          })
        : withGrowthPortReceiptDigest({
            ...growthIdentity(input), outcome: proposal.status, proposalId: input.proposalId,
          })
    return validateGrowthAutomationApprovalReceipt(
      this.growthStore.completeOperation('approval-settlement', input, receipt),
      growthIdentity(input),
    )
  }

  replayWorkflowAutomation(inputValue: Readonly<GrowthAutomationArtifactRequest>): GrowthReplayReceipt {
    this.assertActive()
    const input = validateGrowthAutomationArtifactRequest(inputValue)
    const replay = this.growthStore.beginOperation('replay', input)
    if (replay !== undefined) return validateGrowthReplayReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    if (artifact.state !== 'paused') {
      throw new AssistantAutomationsError('runtime-conflict', 'replay requires an exact paused artifact')
    }
    this.requireLiveGrowthArtifact(artifact)
    // This is a content-free historical replay: it checks the immutable
    // Delivery→Growth evidence window and never schedules or executes anything.
    const replayDigest = growthObjectDigest({
      contract: 'assistant-automations-growth-replay/v1',
      evidenceDigest: artifact.evidenceDigest,
      evidenceCount: artifact.evidenceCount,
      templateDigest: artifact.templateDigest,
      steps: artifact.steps,
    })
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: artifact.evidenceCount > 0 ? 'passed' as const : 'failed' as const,
      replayDigest,
    })
    return validateGrowthReplayReceipt(
      this.growthStore.completeOperation('replay', input, receipt), input,
    )
  }

  async shadowWorkflowAutomation(inputValue: Readonly<GrowthAutomationArtifactRequest>): Promise<GrowthShadowReceipt> {
    this.assertActive()
    const input = validateGrowthAutomationArtifactRequest(inputValue)
    const replay = this.growthStore.beginOperation('shadow', input)
    if (replay !== undefined) return validateGrowthShadowReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    this.requireLiveGrowthArtifact(artifact)
    const task = this.growthStore.createExecutionTask({ artifact, operationId: input.operationId, kind: 'shadow' })
    let run = this.store.getRun(`run-${task.taskId}`)
    if (run === undefined) {
      await this.coordinator.tick()
      await this.coordinator.whenIdle()
      run = this.store.getRun(`run-${task.taskId}`)
    }
    if (run === undefined || !this.hasShadowEffectBlocker(run)) {
      throw new AssistantAutomationsError(
        'runtime-conflict',
        'shadow execution lacks durable delivery/tool effect-blocker proof',
      )
    }
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: run.status === 'succeeded' ? 'passed' as const : 'failed' as const,
      effectsBlocked: true as const,
      effectBlockerAttestation: growthEffectBlockerAttestation,
      shadowDigest: growthObjectDigest({
        contract: 'assistant-automations-growth-shadow/v1',
        runId: run.id,
        status: run.status,
        definitionHash: run.definitionHash,
        implementationDigest: growthEffectBlockerAttestation.implementationDigest,
      }),
    })
    return validateGrowthShadowReceipt(
      this.growthStore.completeOperation('shadow', input, receipt), input,
    )
  }

  async canaryWorkflowAutomation(inputValue: Readonly<GrowthAutomationArtifactRequest>): Promise<GrowthCanaryReceipt> {
    this.assertActive()
    const input = validateGrowthAutomationArtifactRequest(inputValue)
    const replay = this.growthStore.beginOperation('canary', input)
    if (replay !== undefined) return validateGrowthCanaryReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    this.requireLiveGrowthArtifact(artifact)
    const task = this.growthStore.createExecutionTask({ artifact, operationId: input.operationId, kind: 'canary' })
    let run = this.store.getRun(`run-${task.taskId}`)
    if (run === undefined) {
      await this.coordinator.tick()
      await this.coordinator.whenIdle()
      run = this.store.getRun(`run-${task.taskId}`)
    }
    if (run === undefined || run.executionMode !== 'production') {
      throw new AssistantAutomationsError('runtime-conflict', 'canary exposure has no durable production run')
    }
    this.growthStore.recordCanaryRun(artifact.artifactId, run)
    const terminalFailure = run.status !== 'succeeded'
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: terminalFailure ? 'failed' as const : 'pending' as const,
      exposureCount: 1 as const,
      exposureOperationId: `${input.experimentId}:canary`,
    })
    return validateGrowthCanaryReceipt(
      this.growthStore.completeOperation('canary', input, receipt), input,
    )
  }

  inspectWorkflowCanary(
    inputValue: Readonly<GrowthCanaryInspectionRequest>,
  ): GrowthCanaryInspectionReceipt {
    this.assertActive()
    const input = validateGrowthCanaryInspectionRequest(inputValue)
    const replay = this.growthStore.beginOperation('canary-inspection', input)
    if (replay !== undefined) return validateGrowthCanaryInspectionReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    const run = artifact.canaryRunId === undefined ? undefined : this.store.getRun(artifact.canaryRunId)
    if (artifact.canaryTaskId === undefined || artifact.canaryRunId === undefined || run === undefined
      || run.taskId !== artifact.canaryTaskId || run.executionMode !== 'production') {
      throw new AssistantAutomationsError('runtime-conflict', 'canary inspection has no exact exposure proof')
    }
    let proof: ReturnType<AssistantEvaluationService['getTrustedOutcome']>
    const evaluation = this.evaluation
    if (evaluation !== undefined && run.status === 'succeeded') {
      const scope = canonicalEvaluationHostScope({ workspace: artifact.workspace, preset: artifact.preset })
      const matches = evaluation.query({
        scope,
        situation: `automation:${artifact.automationId}`,
        objectiveStatus: 'achieved',
        trust: 'trusted',
        limit: 100,
      }).filter(outcome => outcome.evidence.some(entry =>
        entry.kind === 'automation-run' && entry.ref === run.id))
      if (matches.length === 1) {
        proof = evaluation.getTrustedOutcome({ scope, outcomeId: matches[0]!.id })
      }
    }
    const passed = proof !== undefined && proof.trust === 'trusted'
      && proof.objectiveStatus === 'achieved'
      && proof.evidence.some(entry => entry.kind === 'automation-run' && entry.ref === run.id)
    const failed = run.status !== 'succeeded'
    const evaluationDigest = !passed ? undefined : growthObjectDigest({
      contract: 'assistant-automations-growth-evaluation-proof/v1',
      id: proof!.id,
      scopeKey: proof!.scopeKey,
      situation: proof!.situation,
      objectiveStatus: proof!.objectiveStatus,
      trust: proof!.trust,
      evidence: proof!.evidence,
      occurredAt: proof!.occurredAt,
      evaluator: proof!.evaluator,
    })
    if (passed) {
      this.growthStore.recordCanaryEvaluation({
        artifactId: artifact.artifactId,
        runId: run.id,
        evaluationId: proof!.id,
        evaluationDigest: evaluationDigest!,
      })
    }
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: passed ? 'passed' as const : failed ? 'failed' as const : 'pending' as const,
      exposureCount: 1 as const,
      exposureOperationId: input.exposureOperationId,
      ...(passed ? {
        evaluationDigest: evaluationDigest!,
        evaluationTrust: 'trusted' as const,
        objectiveStatus: 'achieved' as const,
      } : {}),
    })
    return validateGrowthCanaryInspectionReceipt(
      this.growthStore.completeOperation('canary-inspection', input, receipt), input,
    )
  }

  promoteWorkflowAutomation(inputValue: Readonly<GrowthAutomationArtifactRequest>): GrowthPromotionReceipt {
    this.assertActive()
    const input = validateGrowthAutomationArtifactRequest(inputValue)
    const replay = this.growthStore.beginOperation('promotion', input)
    if (replay !== undefined) return validateGrowthPromotionReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    if (artifact.state !== 'canary-pending' || artifact.canaryRunId === undefined
      || artifact.canaryEvaluationId === undefined || artifact.canaryEvaluationDigest === undefined) {
      throw new AssistantAutomationsError('runtime-conflict', 'promotion requires the exact canary artifact')
    }
    const definition = this.requireLiveGrowthArtifact(artifact)
    if (definition === undefined || definition.owner !== GROWTH_AUTOMATION_OWNER
      || this.store.getDefinitionHash(definition.id) !== input.artifactDigest
      || !((definition.status === 'paused' && definition.version === input.artifactVersion)
        || (definition.status === 'active' && definition.version === input.artifactVersion + 1))) {
      throw new AssistantAutomationsError('runtime-conflict', 'promotion artifact changed before exact CAS')
    }
    const promoted = definition.status === 'active'
      ? definition
      : this.reconcileSystem({
          owner: GROWTH_AUTOMATION_OWNER,
          automationId: definition.id,
          idempotencyKey: boundedGrowthKey('growth-promote', input),
          desiredStatus: 'active',
          definition: definition.definition,
        })
    const stored = this.growthStore.completePromotion({ request: input, automation: promoted })
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: 'promoted' as const,
      resultingArtifactVersion: stored.definitionVersion,
      resultingArtifactDigest: stored.definitionHash,
    })
    return validateGrowthPromotionReceipt(
      this.growthStore.completeOperation('promotion', input, receipt), input,
    )
  }

  rollbackWorkflowAutomation(inputValue: Readonly<GrowthAutomationArtifactRequest>): GrowthRollbackReceipt {
    this.assertActive()
    const input = validateGrowthAutomationArtifactRequest(inputValue)
    const replay = this.growthStore.beginOperation('rollback', input)
    if (replay !== undefined) return validateGrowthRollbackReceipt(replay, input)
    const artifact = this.growthStore.requireArtifact(input)
    let automation = this.store.get(artifact.automationId)
    if (automation === undefined || automation.owner !== GROWTH_AUTOMATION_OWNER
      || this.store.getDefinitionHash(automation.id) !== input.artifactDigest
      || !((automation.status === 'active' && automation.version === input.artifactVersion)
        || (automation.status === 'paused'
          && (automation.version === input.artifactVersion
            || automation.version === input.artifactVersion + 1)))) {
      throw new AssistantAutomationsError('runtime-conflict', 'rollback artifact changed before exact CAS')
    }
    if (automation.status === 'active') {
      this.store.pauseSystemOwned({
        owner: GROWTH_AUTOMATION_OWNER,
        operationId: boundedGrowthKey('growth-rollback-pause', input),
        automationId: automation.id,
        definitionHash: input.artifactDigest,
        expectedVersion: input.artifactVersion,
      })
      automation = this.store.get(automation.id)!
    }
    this.growthStore.completeRollback({ request: input, automation })
    const receipt = withGrowthPortReceiptDigest({
      ...growthIdentity(input),
      artifactId: input.artifactId,
      artifactVersion: input.artifactVersion,
      artifactDigest: input.artifactDigest,
      outcome: 'rolled-back' as const,
    })
    return validateGrowthRollbackReceipt(
      this.growthStore.completeOperation('rollback', input, receipt), input,
    )
  }

  propose(agent: Agent | undefined, input: AutomationServiceProposalInput): AutomationProposalResult {
    const identity = this.authorizeAgent(agent, 'propose', input.mutation.automationId, `automation-propose:${input.idempotencyKey}`)
    const approval = this.resolveApprovalRoute(agent, identity, input.principal)
    let mutation: AutomationMutation
    if (input.mutation.op === 'create') {
      const requestedTools = input.mutation.definition.allowedTools
      if (!Array.isArray(requestedTools)
        || requestedTools.some(tool => typeof tool !== 'string'
          || !this.config.proposalDefaults.allowedTools.includes(tool))
        || new Set(requestedTools).size !== requestedTools.length) {
        throw new AssistantAutomationsError(
          'invalid-proposal',
          'automation proposal allowed tools must be a unique subset of proposalDefaults.allowedTools',
        )
      }
      const defaults = this.config.proposalDefaults
      const misfire: MisfirePolicy = defaults.misfireKind === 'bounded-replay'
        ? { kind: 'bounded-replay', limit: defaults.misfireLimit }
        : { kind: defaults.misfireKind }
      mutation = {
        op: 'create',
        automationId: input.mutation.automationId,
        definition: {
          name: input.mutation.definition.name,
          prompt: input.mutation.definition.prompt,
          schedule: input.mutation.definition.schedule,
          workspace: identity.workspace,
          agentPreset: identity.agentPreset,
          provider: defaults.provider,
          model: defaults.model,
          allowedTools: requestedTools,
          timeoutMs: defaults.timeoutMs,
          maxOutputTokens: defaults.maxOutputTokens,
          maxToolCalls: defaults.maxToolCalls,
          misfire,
          overlap: defaults.overlap,
          retrySafety: defaults.retrySafety,
          maxRetries: defaults.maxRetries,
          principal: approval.principal,
          budgetId: defaults.budgetId,
          budgetAmount: defaults.budgetAmount,
          ...(approval.dispatch === undefined ? {} : { deliveryBindingId: approval.dispatch.bindingId }),
        },
      }
    } else {
      const current = this.store.get(input.mutation.automationId)
      if (current !== undefined && (current.definition.workspace !== identity.workspace
        || current.definition.agentPreset !== identity.agentPreset
        || current.definition.principal !== approval.principal
        || (current.definition.approvalBindingId ?? current.definition.deliveryBindingId)
          !== approval.dispatch?.bindingId)) {
        throw new AssistantAutomationsError(
          'missing-approval-route',
          'automation lifecycle proposal does not match the immutable owner route',
        )
      }
      mutation = input.mutation
    }
    return this.proposals.propose({
      idempotencyKey: input.idempotencyKey,
      requester: `agent:${identity.agentPreset}`,
      principal: approval.principal,
      ...(approval.dispatch === undefined ? {} : { dispatch: approval.dispatch }),
      ttlMs: this.config.defaultProposalTtlMs,
      mutation,
    })
  }

  decideProposal(input: AutomationProposalDecisionInput): AutomationProposalResult {
    this.assertActive()
    return this.proposals.decide(input)
  }

  /**
   * Commit proposals whose policy decision settled after the originating turn.
   * Without this, an approval granted on a chat card would leave the automation
   * proposal pending forever. Safe to call repeatedly.
   */
  reconcileProposals(limit?: number): AutomationProposalResult[] {
    this.assertActive()
    return this.proposals.reconcile(limit ?? this.config.reconcileLimit)
  }

  /**
   * List proposals still awaiting a decision, so a turn can tell the owner what
   * it already asked for instead of silently re-proposing the same change.
   *
   * Bounded metadata only: no prompts, principals, or host paths.
   */
  listPendingProposals(agent: Agent | undefined, limit?: number): PendingAutomationProposal[] {
    this.authorizeAgent(agent, 'inspect', 'pending-proposals')
    const bounded = Math.min(limit ?? this.config.reconcileLimit, this.config.reconcileLimit)
    return this.proposalStore.listPending(bounded).map(proposal => Object.freeze({
      proposalId: proposal.proposalId,
      automationId: proposal.mutation.automationId,
      operation: proposal.mutation.op,
      expiresAt: proposal.expiresAt,
      version: proposal.version,
      attachedToPolicy: proposal.policyProposalId !== undefined,
    }))
  }

  getProposal(proposalId: string, principal: string): AutomationProposalResult | undefined {
    this.assertActive()
    const stored = this.proposalStore.get(proposalId)
    if (stored === undefined) return undefined
    if (stored.principal !== principal) {
      throw new AssistantAutomationsError('unauthorized-principal', 'automation proposal belongs to another principal')
    }
    return this.proposals.get(proposalId)
  }

  list(agent: Agent | undefined): AutomationRecord[] {
    this.authorizeAgent(agent, 'list', 'catalog')
    return this.store.list()
  }

  history(agent: Agent | undefined, input: {
    automationId?: string
    runId?: string
    limit?: number
  } = {}): {
    occurrences: AutomationOccurrence[]
    runs: AutomationRun[]
  } {
    const identity = this.authorizeAgent(agent, 'history', input.automationId ?? 'catalog')
    if (input.runId !== undefined && input.automationId !== undefined) {
      throw new AssistantAutomationsError('invalid-input', 'history accepts runId or automationId, not both')
    }
    const limit = input.limit ?? 20
    if (input.runId !== undefined) {
      if (!/^run-task-occ-[a-f0-9]{64}$/u.test(input.runId)) {
        throw new AssistantAutomationsError('invalid-input', 'runId is not a canonical Automation run id')
      }
      const run = this.store.getRun(input.runId)
      const snapshot = run === undefined ? undefined : this.store.getRunExecutionSnapshot(run.id)
      const sameScope = snapshot !== undefined
        && resolve(snapshot.definition.workspace.normalize('NFC')) === resolve(identity.workspace.normalize('NFC'))
        && snapshot.definition.agentPreset.normalize('NFC').trim()
          === identity.agentPreset.normalize('NFC').trim()
      if (run === undefined || !sameScope) {
        // Do not reveal whether a cross-scope run exists.
        throw new AssistantAutomationsError('not-found', 'automation run was not found in the current Agent scope')
      }
      const occurrence = this.store.getOccurrence(run.occurrenceId)
      if (occurrence === undefined) {
        throw new AssistantAutomationsError('not-found', 'automation run occurrence was not found')
      }
      return { occurrences: [occurrence], runs: [run] }
    }
    const runs = this.store.listRunsForExecutionScope({
      ...identity,
      ...(input.automationId === undefined ? {} : { automationId: input.automationId }),
      limit,
    })
    return {
      occurrences: runs.flatMap(value => {
        const occurrence = this.store.getOccurrence(value.occurrenceId)
        return occurrence === undefined ? [] : [occurrence]
      }),
      runs,
    }
  }

  async runDry(agent: Agent | undefined, input: { automationId: string; idempotencyKey: string }): Promise<{
    occurrence: AutomationOccurrence
    run: AutomationRun
  }> {
    this.authorizeAgent(agent, 'run-dry', input.automationId, `automation-dry:${input.idempotencyKey}`)
    const occurrence = this.store.createManual({
      automationId: input.automationId,
      requestId: `dry:${input.idempotencyKey}`,
      dryRun: true,
    })
    let run = this.store.listRuns({ automationId: input.automationId, limit: 1_000 })
      .find(value => value.occurrenceId === occurrence.id)
    if (run === undefined) {
      await this.coordinator.tick()
      await this.coordinator.whenIdle()
      run = this.store.listRuns({ automationId: input.automationId, limit: 1_000 })
        .find(value => value.occurrenceId === occurrence.id)
    }
    if (run === undefined) throw new Error('assistant-automations: dry-run task was not claimed by this duty owner')
    return { occurrence: this.store.getOccurrence(occurrence.id)!, run }
  }

  /** Exact Host-only preview lane for one system-owned immutable definition. */
  async runSystemDry(input: {
    owner: string
    automationId: string
    definitionHash: string
    idempotencyKey: string
  }): Promise<{ occurrence: AutomationOccurrence; run: AutomationRun }> {
    this.assertActive()
    const current = this.store.get(input.automationId)
    if (current === undefined || current.owner !== input.owner) {
      throw new AssistantAutomationsError('not-found', 'system automation was not found for the exact owner')
    }
    if (this.store.getDefinitionHash(input.automationId) !== input.definitionHash) {
      throw new AssistantAutomationsError('invalid-input', 'system dry-run definition hash is stale')
    }
    const decision = this.policy.authorize({
      subject: {
        kind: 'background', id: input.owner,
        workspace: current.definition.workspace, principal: current.definition.principal,
      },
      action: 'run-dry',
      resource: { kind: 'automation', id: input.automationId },
      context: { initiator: 'background' },
    }, { idempotencyKey: [
      'automation-system-dry', input.owner, input.automationId,
      input.definitionHash, input.idempotencyKey,
    ].join(':') })
    if (decision.effect !== 'allow') throw policyError(decision)
    const occurrence = this.store.createManual({
      automationId: input.automationId,
      requestId: `system-dry:${input.owner}:${input.definitionHash}:${input.idempotencyKey}`,
      dryRun: true,
    })
    let run = this.store.listRuns({ automationId: input.automationId, limit: 1_000 })
      .find(value => value.occurrenceId === occurrence.id)
    if (run === undefined) {
      await this.coordinator.tick()
      await this.coordinator.whenIdle()
      run = this.store.listRuns({ automationId: input.automationId, limit: 1_000 })
        .find(value => value.occurrenceId === occurrence.id)
    }
    if (run === undefined) {
      throw new Error('assistant-automations: system dry-run was not claimed by this duty owner')
    }
    return { occurrence: this.store.getOccurrence(occurrence.id)!, run }
  }

  ingestExternal(input: {
    sourceId: string
    automationId: string
    eventId: string
    occurredAt: number
  }): AutomationOccurrence {
    this.assertActive()
    const automation = this.store.get(input.automationId)
    const decision = this.policy.authorize({
      subject: {
        kind: 'external',
        id: input.sourceId,
        ...(automation === undefined ? {} : { workspace: automation.definition.workspace }),
      },
      action: 'ingest',
      resource: { kind: 'automation', id: input.automationId },
      context: { initiator: 'external' },
    }, { idempotencyKey: `automation-event:${input.sourceId}:${input.eventId}` })
    if (decision.effect !== 'allow') throw policyError(decision)
    return this.store.ingestExternal({
      automationId: input.automationId,
      externalEventId: `${input.sourceId}:${input.eventId}`,
      occurredAt: input.occurredAt,
    })
  }

  reconcileSystem(input: SystemAutomationReconcileInput): AutomationRecord {
    this.assertActive()
    if (input.owner.trim() === '') {
      throw new AssistantAutomationsError('missing-identity', 'system automation owner is required')
    }
    const decision = this.policy.authorize({
      subject: {
        kind: 'background',
        id: input.owner,
        workspace: input.definition.workspace,
        principal: input.definition.principal,
      },
      action: 'reconcile',
      resource: { kind: 'automation', id: input.automationId },
      context: { initiator: 'background' },
    }, { idempotencyKey: `automation-reconcile:${input.owner}:${input.idempotencyKey}` })
    if (decision.effect !== 'allow') throw policyError(decision)
    return this.store.reconcileSystemOwned(input)
  }

  async tick(): Promise<void> {
    this.assertActive()
    await this.coordinator.tick()
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await this.coordinator.whenIdle()
  }

  health(): ReturnType<AutomationStore['health']> {
    this.assertActive()
    return this.store.health()
  }

  /** Host-only, content-free projection for recovery/runbook controllers. */
  inspectSystemOwned(input: {
    owner: string
    automationId: string
  }): SystemOwnedAutomationHealthProjection {
    this.assertActive()
    return this.store.inspectSystemOwned(input)
  }

  /** Host-only bounded identity inventory; definitions and scopes never leave the store. */
  listSystemOwned(input: {
    owner: string
    limit?: number
  }): readonly SystemOwnedAutomationIdentityProjection[] {
    this.assertActive()
    return this.store.listSystemOwned(input)
  }

  /** Host-only exact CAS used by fleet owners to retire removed jobs safely. */
  pauseSystemOwned(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedVersion: number
  }): SystemOwnedAutomationPauseReceipt {
    this.assertActive()
    const current = this.store.get(input.automationId)
    if (current === undefined || current.owner !== input.owner) {
      throw new AssistantAutomationsError(
        'not-found',
        'system-owned automation was not found for the exact owner',
      )
    }
    if (this.store.getDefinitionHash(input.automationId) !== input.definitionHash) {
      throw new AssistantAutomationsError(
        'invalid-input',
        'system pause definition hash does not match the current automation definition',
      )
    }
    const decision = this.policy.authorize({
      subject: {
        kind: 'background', id: input.owner,
        workspace: current.definition.workspace, principal: current.definition.principal,
      },
      action: 'reconcile',
      resource: { kind: 'automation', id: input.automationId },
      context: { initiator: 'background' },
    }, { idempotencyKey: [
      'automation-system-pause', input.owner, input.automationId,
      input.definitionHash, input.expectedVersion, input.operationId,
    ].join(':') })
    if (decision.effect !== 'allow') throw policyError(decision)
    return this.store.pauseSystemOwned(input)
  }

  resolveQualityEvidence(input: Parameters<AutomationStore['resolveQualityEvidence']>[0]):
    AutomationQualityEvidenceReceipt | undefined {
    this.assertActive()
    return this.store.resolveQualityEvidence(input)
  }

  resolveDeliveryEvidence(input: Parameters<AutomationStore['resolveDeliveryEvidence']>[0]):
    AutomationDeliveryEvidenceReceipt | undefined {
    this.assertActive()
    return this.store.resolveDeliveryEvidence(input)
  }

  validateQualityEvidence(receipt: AutomationQualityEvidenceReceipt): boolean {
    this.assertActive()
    return this.store.validateQualityEvidence(receipt)
  }

  /** Process-local Host executor registration; never exposed as a model tool. */
  registerHostExecutor(executor: HostAutomationExecutor): () => void {
    this.assertActive()
    return this.hostExecutors.register(executor)
  }

  /**
   * Host/operator seam for one exact circuit repair. This is deliberately not
   * registered as a model tool. The current immutable definition hash must
   * still match, so an old repaired hash cannot clear a newer definition or an
   * ABA-reverted definition behind the operator's back.
   */
  probeCircuit(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedCircuitVersion: number
    leaseMs?: number
  }): AutomationCircuitProbeReceipt {
    this.assertActive()
    const current = this.store.get(input.automationId)
    if (current === undefined || current.owner !== input.owner) {
      throw new AssistantAutomationsError(
        'not-found',
        'system-owned circuit was not found for the exact owner',
      )
    }
    if (this.store.getDefinitionHash(input.automationId) !== input.definitionHash) {
      throw new AssistantAutomationsError(
        'invalid-input',
        'circuit probe definition hash does not match the current automation definition',
      )
    }
    const decision = this.policy.authorize({
      subject: {
        kind: 'background', id: input.owner,
        workspace: current.definition.workspace, principal: current.definition.principal,
      },
      action: 'repair',
      resource: { kind: 'automation', id: `${input.automationId}:circuit:${input.definitionHash}` },
      context: { initiator: 'background' },
    }, { idempotencyKey: [
      'automation-circuit-probe', input.owner, input.automationId,
      input.definitionHash, input.expectedCircuitVersion, input.operationId,
    ].join(':') })
    if (decision.effect !== 'allow') throw policyError(decision)
    const leaseMs = input.leaseMs
      ?? Math.min(86_400_000, Math.max(this.config.taskLeaseMs, current.definition.timeoutMs))
    return this.store.armCircuitProbe({
      owner: input.owner,
      operationId: input.operationId,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      expectedVersion: input.expectedCircuitVersion,
      now: Date.now(),
      leaseMs,
    })
  }

  /**
   * Recovery seam that atomically arms an exact circuit and schedules its one
   * production canary. Unlike probeCircuit(), callers cannot leave a durable
   * half-open circuit without a corresponding task.
   */
  probeCircuitAndScheduleCanary(input: {
    owner: string
    operationId: string
    automationId: string
    definitionHash: string
    expectedCircuitVersion: number
    leaseMs?: number
  }): AutomationCircuitCanaryReceipt {
    this.assertActive()
    const current = this.store.get(input.automationId)
    if (current === undefined || current.owner !== input.owner) {
      throw new AssistantAutomationsError(
        'not-found',
        'system-owned circuit was not found for the exact owner',
      )
    }
    if (this.store.getDefinitionHash(input.automationId) !== input.definitionHash) {
      throw new AssistantAutomationsError(
        'invalid-input',
        'circuit canary definition hash does not match the current automation definition',
      )
    }
    const decision = this.policy.authorize({
      subject: {
        kind: 'background', id: input.owner,
        workspace: current.definition.workspace, principal: current.definition.principal,
      },
      action: 'repair',
      resource: { kind: 'automation', id: `${input.automationId}:circuit:${input.definitionHash}` },
      context: { initiator: 'background' },
    }, { idempotencyKey: [
      'automation-circuit-canary', input.owner, input.automationId,
      input.definitionHash, input.expectedCircuitVersion, input.operationId,
    ].join(':') })
    if (decision.effect !== 'allow') throw policyError(decision)
    const leaseMs = input.leaseMs
      ?? Math.min(86_400_000, Math.max(this.config.taskLeaseMs, current.definition.timeoutMs))
    return this.store.probeCircuitAndScheduleCanary({
      owner: input.owner,
      operationId: input.operationId,
      automationId: input.automationId,
      definitionHash: input.definitionHash,
      expectedVersion: input.expectedCircuitVersion,
      now: Date.now(),
      leaseMs,
    })
  }

  start(): void {
    this.assertActive()
    this.coordinator.start()
  }

  async stop(): Promise<void> {
    this.assertActive()
    await this.coordinator.stop()
  }

  async cancel(taskId: string): Promise<void> {
    this.assertActive()
    await this.coordinator.cancel(taskId)
  }

  private authorizeAgent(
    agent: Agent | undefined,
    action: string,
    resourceId: string,
    idempotencyKey?: string,
  ): { workspace: string; agentPreset: string } {
    this.assertActive()
    if (agent === undefined) throw new AssistantAutomationsError('missing-identity', 'automation operation requires an Agent')
    const workspace = agent.session.header.cwd
    const agentPreset = agent.session.header.agentPreset
    if (workspace === undefined || !isAbsolute(workspace) || agentPreset === undefined || agentPreset.trim() === '') {
      throw new AssistantAutomationsError('missing-identity', 'automation operation requires absolute workspace and preset')
    }
    const decision = this.policy.authorizeAgent(
      agent,
      action,
      { kind: 'automation', id: resourceId },
      idempotencyKey === undefined ? {} : { idempotencyKey },
    )
    if (decision.effect !== 'allow') throw policyError(decision)
    return { workspace, agentPreset }
  }

  private resolveApprovalRoute(
    agent: Agent | undefined,
    identity: { workspace: string; agentPreset: string },
    explicitPrincipal: string | undefined,
  ): {
      principal: string
      dispatch?: ReturnType<AssistantDeliveryService['prepareAgentApproval']>
    } {
    const delivery = this.approvalDelivery
    if (delivery === undefined) {
      if (explicitPrincipal === undefined || explicitPrincipal.trim() === '') {
        throw new AssistantAutomationsError(
          'missing-approval-route',
          'automation proposal requires an authenticated Delivery route or explicit trusted headless principal',
        )
      }
      return { principal: explicitPrincipal }
    }
    const dispatch = delivery.prepareAgentApproval(agent, {
      sourceId: 'dsh-enhanced-assistant-automations',
    })
    if (dispatch.routeVersion !== 2
      || dispatch.sourceId !== 'dsh-enhanced-assistant-automations'
      || dispatch.workspace !== identity.workspace
      || dispatch.bindingId.trim() === ''
      || dispatch.principal.trim() === '') {
      throw new AssistantAutomationsError(
        'missing-approval-route',
        'automation proposal Delivery approval route does not match the current Agent workspace',
      )
    }
    if (explicitPrincipal !== undefined && explicitPrincipal !== dispatch.principal) {
      throw new AssistantAutomationsError(
        'unauthorized-principal',
        'automation proposal principal does not match the authenticated Delivery owner',
      )
    }
    return { principal: dispatch.principal, dispatch }
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantAutomationsError('disposed', 'assistant-automations service is disposed')
  }
}

export const Config = AssistantAutomationsService.Config
