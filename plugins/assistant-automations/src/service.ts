import { isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import { AutomationArtifactStore } from './artifacts.js'
import {
  AutomationCoordinator,
  type AutomationEvaluationRecorder,
  type AutomationOutcomeRecorder,
  type AutomationRunner,
  type AutomationRunnerInput,
} from './coordinator.js'
import { AutomationProposalManager, AutomationProposalStore } from './proposals.js'
import { DshAutomationRunner } from './runner.js'
import { AutomationStore } from './store.js'
import { registerAutomationTools } from './tools.js'
import type {
  AutomationMutation,
  AutomationDefinition,
  AutomationOccurrence,
  AutomationProposalDecisionInput,
  AutomationProposalResult,
  AutomationRecord,
  AutomationRun,
  MisfirePolicy,
  OverlapPolicy,
  RetrySafety,
} from './types.js'

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
      definition: Pick<AutomationDefinition, 'allowedTools' | 'name' | 'prompt' | 'schedule'>
        & Partial<AutomationDefinition>
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
      return Promise.resolve({
        outcome: 'cancelled' as const,
        output: `policy denied background execution: ${decision.reasonCode}`,
        usage: {},
      })
    }
    return this.delegate.run(input)
  }
}

export class AssistantAutomationsService extends Service {
  static Config = configSchema

  private readonly store: AutomationStore
  private readonly proposalStore: AutomationProposalStore
  private readonly proposals: AutomationProposalManager
  private readonly policy: AssistantPolicyService
  private readonly coordinator: AutomationCoordinator
  private readonly config: Required<Config>
  private approvalDelivery: Pick<AssistantDeliveryService, 'prepareAgentApproval'> | undefined
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
    this.approvalDelivery = ctx.get('assistantDelivery') as AssistantDeliveryService | undefined
    this.store = new AutomationStore({ path: config.databasePath })
    this.proposalStore = new AutomationProposalStore({ path: config.databasePath })
    this.proposals = new AutomationProposalManager(this.store, this.proposalStore, policy)
    const artifacts = new AutomationArtifactStore({ rootPath: config.runsPath, maxBytes: config.maxArtifactBytes })
    const runner = new PolicyBoundRunner(policy, new DshAutomationRunner(ctx, policy, {
      allowUnbudgetedExecution: config.allowUnbudgetedExecution,
    }))
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
    })
    ctx.inject(['assistantDelivery'], deliveryCtx => {
      const delivery = deliveryCtx.get('assistantDelivery') as AssistantDeliveryService
      this.approvalDelivery = delivery
      this.coordinator.setDeliveryDispatcher(delivery)
      return () => {
        if (this.approvalDelivery === delivery) this.approvalDelivery = undefined
        this.coordinator.setDeliveryDispatcher(undefined)
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
    // Evaluation has an independent durable outbox. Installing or restarting it
    // later cannot be hidden by Evolution's already-recorded evidence state.
    ctx.inject(['assistantEvaluation'], evaluationCtx => {
      const recorder = evaluationCtx.get('assistantEvaluation') as AutomationEvaluationRecorder
      this.coordinator.setEvaluationRecorder(recorder)
      return () => this.coordinator.setEvaluationRecorder(undefined)
    })
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
      await this.coordinator.stop()
      this.proposalStore.close()
      this.store.close()
    }, 'assistant-automations.runtime')
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
        || current.definition.deliveryBindingId !== approval.dispatch?.bindingId)) {
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
    if (dispatch.sourceId !== 'dsh-enhanced-assistant-automations'
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
