import { isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { AssistantDeliveryService } from '@dsh-enhanced/assistant-delivery'
import type { AssistantPolicyService, PolicyDecision } from '@dsh-enhanced/assistant-policy'
import { AutomationArtifactStore } from './artifacts.js'
import {
  AutomationCoordinator,
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
} from './types.js'

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
}

export interface AutomationServiceProposalInput {
  idempotencyKey: string
  principal: string
  ttlMs?: number
  mutation: AutomationMutation
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
  | 'missing-identity'
  | 'policy-denied'
  | 'unauthorized-principal'

export class AssistantAutomationsError extends Error {
  constructor(readonly code: AssistantAutomationsErrorCode, message: string) {
    super(message)
    this.name = 'AssistantAutomationsError'
  }
}

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
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('assistant-automations: assistantPolicy service is required')
    this.config = config
    this.policy = policy
    this.store = new AutomationStore({ path: config.databasePath })
    this.proposalStore = new AutomationProposalStore({ path: config.databasePath })
    this.proposals = new AutomationProposalManager(this.store, this.proposalStore, policy)
    const artifacts = new AutomationArtifactStore({ rootPath: config.runsPath, maxBytes: config.maxArtifactBytes })
    const runner = new PolicyBoundRunner(policy, new DshAutomationRunner(ctx, policy))
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
      this.coordinator.setDeliveryDispatcher(delivery)
      return () => this.coordinator.setDeliveryDispatcher(undefined)
    })
    if (config.schedulerEnabled) this.coordinator.start()
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
    return this.proposals.propose({
      idempotencyKey: input.idempotencyKey,
      requester: `agent:${identity.agentPreset}`,
      principal: input.principal,
      ttlMs: input.ttlMs ?? this.config.defaultProposalTtlMs,
      mutation: input.mutation,
    })
  }

  decideProposal(input: AutomationProposalDecisionInput): AutomationProposalResult {
    this.assertActive()
    return this.proposals.decide(input)
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

  history(agent: Agent | undefined, input: { automationId?: string; limit?: number } = {}): {
    occurrences: AutomationOccurrence[]
    runs: AutomationRun[]
  } {
    this.authorizeAgent(agent, 'history', input.automationId ?? 'catalog')
    const limit = input.limit ?? 20
    return {
      occurrences: this.store.listOccurrences({
        ...(input.automationId === undefined ? {} : { automationId: input.automationId }), limit,
      }),
      runs: this.store.listRuns({
        ...(input.automationId === undefined ? {} : { automationId: input.automationId }), limit,
      }),
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

  private assertActive(): void {
    if (!this.active) throw new AssistantAutomationsError('disposed', 'assistant-automations service is disposed')
  }
}

export const Config = AssistantAutomationsService.Config
