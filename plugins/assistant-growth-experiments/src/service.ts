import { isAbsolute } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import {
  growthPortReceiptDigest,
  validateGrowthAutomationApprovalReceipt,
  validateGrowthAutomationProposalReceipt,
  validateGrowthCanaryInspectionReceipt,
  validateGrowthCanaryReceipt,
  validateGrowthPromotionReceipt,
  validateGrowthReplayReceipt,
  validateGrowthRollbackReceipt,
  validateGrowthShadowReceipt,
  validateGrowthWorkflowTraceSourceRegistration,
} from '@dsh-enhanced/assistant-growth-contract'
import { GrowthExperimentsStore, GrowthExperimentsStoreError } from './store.js'
import type {
  GrowthArtifactIdentity,
  GrowthAutomationArtifactRequest,
  GrowthAutomationPort,
  GrowthExperiment,
  GrowthExperimentConfig,
  GrowthExperimentHealth,
  GrowthExperimentIdentity,
  GrowthWorkflowTraceSourcePort,
  WorkflowTraceSourceAttestation,
  WorkflowCandidate,
  WorkflowTraceRevision,
} from './types.js'

export type AssistantGrowthExperimentsConfig = GrowthExperimentConfig

export const Config = Schema.object({
  databasePath: Schema.string().required(),
  tickIntervalMs: Schema.number().step(1).min(0).max(86_400_000).default(5_000),
  minRepeatedSuccesses: Schema.number().step(1).min(2).max(100).default(3),
  maxBatchSize: Schema.number().step(1).min(1).max(1_000).default(10),
  maxExperimentDurationMs: Schema.number().step(1).min(1_000).max(31_536_000_000).default(604_800_000),
  maxOperationAttempts: Schema.number().step(1).min(1).max(100).default(8),
  retryBaseMs: Schema.number().step(1).min(1).max(86_400_000).default(1_000),
  retryMaxMs: Schema.number().step(1).min(1).max(86_400_000).default(60_000),
}) as Schema<GrowthExperimentConfig>

type NormalizedConfig = Required<GrowthExperimentConfig>

export type AssistantGrowthExperimentsErrorCode =
  | 'disposed'
  | 'invalid-input'
  | 'service-unavailable'

export class AssistantGrowthExperimentsError extends Error {
  constructor(readonly code: AssistantGrowthExperimentsErrorCode, message: string) {
    super(message)
    this.name = 'AssistantGrowthExperimentsError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantGrowthExperiments: AssistantGrowthExperimentsService }
}

export { growthPortReceiptDigest }

function identity(experiment: GrowthExperiment): GrowthExperimentIdentity {
  return Object.freeze({
    contractVersion: 1,
    operationId: experiment.operationId,
    experimentId: experiment.id,
    candidateId: experiment.candidateId,
    candidateRevision: experiment.candidateRevision,
    candidateDigest: experiment.candidateDigest,
  })
}

function artifact(experiment: GrowthExperiment): GrowthArtifactIdentity {
  if (experiment.artifactId === undefined || experiment.artifactVersion === undefined
    || experiment.artifactDigest === undefined) {
    throw new AssistantGrowthExperimentsError('invalid-input', 'experiment has no paused artifact')
  }
  return Object.freeze({
    artifactId: experiment.artifactId,
    artifactVersion: experiment.artifactVersion,
    artifactDigest: experiment.artifactDigest,
  })
}

function requireMethod(value: unknown, method: string, provider: string): void {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null
    || typeof (value as Record<string, unknown>)[method] !== 'function') {
    throw new AssistantGrowthExperimentsError('service-unavailable', `${provider}.${method} is required`)
  }
}

function stableErrorCode(error: unknown): string {
  const value = ((typeof error === 'object' || typeof error === 'function') && error !== null
    && typeof (error as { code?: unknown }).code === 'string')
    ? (error as { code: string }).code
    : 'operation-failed'
  const normalized = value.normalize('NFC').trim().toLowerCase()
  return /^[a-z\d][a-z\d.-]{0,63}$/u.test(normalized) ? normalized : 'operation-failed'
}

export class AssistantGrowthExperimentsService extends Service {
  static Config = Config
  static inject = ['assistantAutomations', 'assistantDelivery']

  private readonly config: NormalizedConfig
  private readonly store: GrowthExperimentsStore
  private readonly automations: GrowthAutomationPort
  private readonly now: () => number
  private unregisterTraceSource: (() => void) | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private flight: Promise<void> | undefined
  private rerunRequested = false
  private active = true

  constructor(ctx: Context, input: GrowthExperimentConfig, options: { now?: () => number } = {}) {
    super(ctx, 'assistantGrowthExperiments')
    let config: NormalizedConfig
    try {
      config = Config(input) as NormalizedConfig
    } catch (error) {
      throw new AssistantGrowthExperimentsError('invalid-input', `invalid configuration: ${String(error)}`)
    }
    if (!isAbsolute(config.databasePath) || config.retryMaxMs < config.retryBaseMs) {
      throw new AssistantGrowthExperimentsError('invalid-input', 'database path or retry bounds are invalid')
    }
    const automations = ctx.get('assistantAutomations' as never) as unknown
    for (const method of ['requestWorkflowAutomation', 'settleWorkflowAutomation',
      'replayWorkflowAutomation', 'shadowWorkflowAutomation', 'canaryWorkflowAutomation',
      'inspectWorkflowCanary', 'promoteWorkflowAutomation', 'rollbackWorkflowAutomation']) {
      requireMethod(automations, method, 'assistantAutomations')
    }
    const delivery = ctx.get('assistantDelivery' as never) as unknown
    requireMethod(delivery, 'registerWorkflowTraceSink', 'assistantDelivery')
    this.config = config
    this.now = options.now ?? Date.now
    this.automations = automations as GrowthAutomationPort
    this.store = new GrowthExperimentsStore({
      path: config.databasePath,
      minRepeatedSuccesses: config.minRepeatedSuccesses,
      now: this.now,
    })
    let registeredSource: WorkflowTraceSourceAttestation | undefined
    try {
      const registration = (delivery as GrowthWorkflowTraceSourcePort).registerWorkflowTraceSink({
        contractVersion: 1,
        sink: Object.freeze({
          projectWorkflowTraceRevision: (revision: Readonly<WorkflowTraceRevision>) => {
            if (registeredSource === undefined
              || revision.source.sourceId !== registeredSource.sourceId
              || revision.source.generation !== registeredSource.generation
              || revision.source.authorityDigest !== registeredSource.authorityDigest) {
              throw new AssistantGrowthExperimentsError(
                'invalid-input',
                'workflow trace does not match the authenticated Delivery registration',
              )
            }
            const receipt = this.store.projectWorkflowTraceRevision(revision)
            this.scheduleTick()
            return receipt
          },
        }),
      })
      const validatedRegistration = validateGrowthWorkflowTraceSourceRegistration(registration)
      registeredSource = Object.freeze({ sourceId: validatedRegistration.sourceId,
        generation: validatedRegistration.generation, authorityDigest: validatedRegistration.authorityDigest })
      this.unregisterTraceSource = () => registration.dispose()
    } catch (error) {
      this.store.close()
      throw error
    }
    if (config.tickIntervalMs > 0) {
      this.timer = setInterval(() => { this.scheduleTick() }, config.tickIntervalMs)
      this.timer.unref?.()
    }
    ctx.effect(() => async () => {
      this.active = false
      if (this.timer !== undefined) clearInterval(this.timer)
      this.unregisterTraceSource?.()
      await this.flight
      this.store.close()
    }, 'assistant-growth-experiments.runtime')
  }

  health(): GrowthExperimentHealth {
    this.assertActive()
    return this.store.health()
  }

  getCandidate(id: string): WorkflowCandidate | undefined {
    this.assertActive()
    return this.store.getCandidate(id)
  }

  getExperiment(id: string): GrowthExperiment | undefined {
    this.assertActive()
    return this.store.getExperiment(id)
  }

  beginCandidateExperiment(candidateId: string): GrowthExperiment {
    this.assertActive()
    const value = this.store.beginReadyExperiment({
      candidateId,
      maxDurationMs: this.config.maxExperimentDurationMs,
    })
    this.scheduleTick()
    return value
  }

  async tick(): Promise<void> {
    this.assertActive()
    if (this.flight !== undefined) {
      this.rerunRequested = true
      return this.flight
    }
    this.flight = (async () => {
      do {
        this.rerunRequested = false
        await this.drain()
      } while (this.rerunRequested && this.active)
    })().finally(() => { this.flight = undefined })
    return this.flight
  }

  async whenIdle(): Promise<void> {
    await this.flight
  }

  private async drain(): Promise<void> {
    let hadError = false
    const ready = this.store.listCandidates({ state: 'ready', limit: this.config.maxBatchSize })
    for (const candidate of ready) {
      try {
        this.store.beginReadyExperiment({
          candidateId: candidate.id,
          maxDurationMs: this.config.maxExperimentDurationMs,
        })
      } catch (error) {
        if (!(error instanceof GrowthExperimentsStoreError && error.code === 'version-conflict')) throw error
      }
    }
    const rows = this.store.listRunnableExperiments(this.now(), this.config.maxBatchSize)
    for (const row of rows) {
      if (!this.active) return
      try {
        await this.process(row)
      } catch (error) {
        if (error instanceof GrowthExperimentsStoreError && error.code === 'version-conflict') continue
        hadError = true
        this.store.recordError(stableErrorCode(error))
        this.defer(row.id, error)
      }
    }
    if (!hadError) this.store.recordError(undefined)
  }

  private async process(snapshot: GrowthExperiment): Promise<void> {
    let current = this.store.getExperiment(snapshot.id)
    if (current === undefined || current.version !== snapshot.version) return
    if (current.state === 'approval-pending') {
      if (this.now() > current.deadlineAt) {
        this.store.transitionExperiment({ experimentId: current.id, expectedVersion: current.version,
          expectedState: current.state, state: 'expired', terminalCode: 'deadline-exceeded' })
        return
      }
      current = this.store.transitionExperiment({
        experimentId: current.id, expectedVersion: current.version, expectedState: current.state,
        state: 'approval-requesting', operationKind: 'approval-settlement',
        operationId: `${current.id}:approval-settlement:${current.version + 1}`,
        ...(current.proposalId === undefined ? {} : { proposalId: current.proposalId }),
      })
    }
    if (this.now() > current.deadlineAt && current.state !== 'approval-requesting'
      && current.state !== 'rollback-pending') {
      this.store.requestRollback({ experimentId: current.id, expectedVersion: current.version,
        code: 'deadline-exceeded' })
      return
    }
    switch (current.operationKind) {
      case 'approval-proposal':
      case 'approval-settlement': await this.approval(current); return
      case 'replay': await this.replay(current); return
      case 'shadow': await this.shadow(current); return
      case 'canary': await this.canary(current, false); return
      case 'canary-inspection': await this.canary(current, true); return
      case 'promotion': await this.promotion(current); return
      case 'rollback': await this.rollback(current); return
      default: throw new AssistantGrowthExperimentsError('invalid-input', 'active experiment lacks a durable operation intent')
    }
  }

  private candidateFor(experiment: GrowthExperiment): WorkflowCandidate {
    const value = this.store.getCandidate(experiment.candidateId)
    if (value === undefined || value.revision !== experiment.candidateRevision
      || value.evidenceDigest !== experiment.candidateDigest || value.state !== 'running') {
      throw new GrowthExperimentsStoreError('version-conflict', 'candidate evidence changed')
    }
    return value
  }

  private artifactRequest(experiment: GrowthExperiment): GrowthAutomationArtifactRequest {
    return Object.freeze({ ...identity(experiment), ...artifact(experiment) })
  }

  private async approval(experiment: GrowthExperiment): Promise<void> {
    const candidate = this.store.getCandidate(experiment.candidateId)
    const stale = candidate === undefined || candidate.revision !== experiment.candidateRevision
      || candidate.evidenceDigest !== experiment.candidateDigest || candidate.state !== 'running'
      || experiment.terminalCode === 'evidence-superseded'
    const raw = experiment.operationKind === 'approval-proposal'
      ? await this.automations.requestWorkflowAutomation(Object.freeze({
          ...identity(experiment),
          initialState: 'paused',
          scope: experiment.candidateSnapshot.scope,
          ownerBindingId: experiment.candidateSnapshot.ownerBindingId,
          evidenceDigest: experiment.candidateDigest,
          evidenceCount: experiment.candidateSnapshot.evidenceCount,
          template: experiment.candidateSnapshot.template,
          steps: experiment.candidateSnapshot.steps,
          deadlineAt: experiment.deadlineAt,
        }))
      : await this.automations.settleWorkflowAutomation(Object.freeze({
          ...identity(experiment), proposalId: experiment.proposalId!,
        }))
    const receipt = experiment.operationKind === 'approval-proposal'
      ? validateGrowthAutomationProposalReceipt(raw, identity(experiment))
      : validateGrowthAutomationApprovalReceipt(raw, identity(experiment))
    if (receipt.outcome === 'approved-paused') {
      const next = stale || this.now() > experiment.deadlineAt ? 'rollback-pending' : 'replay-pending'
      this.store.transitionExperiment({
        experimentId: experiment.id, expectedVersion: experiment.version, expectedState: experiment.state,
        state: next, operationKind: next === 'rollback-pending' ? 'rollback' : 'replay',
        operationId: `${experiment.id}:${next === 'rollback-pending' ? 'rollback' : 'replay'}`,
        proposalId: receipt.proposalId,
        artifact: { id: receipt.artifactId, version: receipt.artifactVersion, digest: receipt.artifactDigest },
        ...(stale ? { terminalCode: 'evidence-superseded' } : {}),
      })
      return
    }
    if (receipt.outcome === 'approval-pending' && !stale && this.now() <= experiment.deadlineAt) {
      this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
        expectedState: experiment.state, state: 'approval-pending', proposalId: receipt.proposalId,
        nextAttemptAt: this.now() + this.config.retryBaseMs })
      return
    }
    const state = stale ? 'conflicted' : receipt.outcome === 'approval-pending' || receipt.outcome === 'expired'
      ? 'expired' : receipt.outcome
    this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state,
      ...(receipt.proposalId === undefined ? {} : { proposalId: receipt.proposalId }),
      terminalCode: stale ? 'evidence-superseded' : `approval-${receipt.outcome}` })
  }

  private async replay(experiment: GrowthExperiment): Promise<void> {
    this.candidateFor(experiment)
    const request = this.artifactRequest(experiment)
    const receipt = validateGrowthReplayReceipt(
      await this.automations.replayWorkflowAutomation(request), request,
    )
    this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state: receipt.outcome === 'passed' ? 'shadow-pending' : 'rollback-pending',
      operationKind: receipt.outcome === 'passed' ? 'shadow' : 'rollback',
      operationId: `${experiment.id}:${receipt.outcome === 'passed' ? 'shadow' : 'rollback'}`,
      ...((receipt.outcome as string) === 'failed' ? { terminalCode: 'replay-failed' } : {}),
    })
  }

  private async shadow(experiment: GrowthExperiment): Promise<void> {
    this.candidateFor(experiment)
    const request = this.artifactRequest(experiment)
    const receipt = validateGrowthShadowReceipt(
      await this.automations.shadowWorkflowAutomation(request), request,
    )
    this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state: receipt.outcome === 'passed' ? 'canary-pending' : 'rollback-pending',
      operationKind: receipt.outcome === 'passed' ? 'canary' : 'rollback',
      operationId: `${experiment.id}:${receipt.outcome === 'passed' ? 'canary' : 'rollback'}`,
      ...((receipt.outcome as string) === 'failed' ? { terminalCode: 'shadow-failed' } : {}),
    })
  }

  private async canary(experiment: GrowthExperiment, inspection: boolean): Promise<void> {
    this.candidateFor(experiment)
    let current = experiment
    if (!inspection && current.canaryExposureCount === 0) {
      current = this.store.markCanaryIssued({ experimentId: current.id, expectedVersion: current.version })
    }
    const request = this.artifactRequest(current)
    const inspectionRequest = Object.freeze({
      ...request, exposureOperationId: `${current.id}:canary`,
    })
    const raw = inspection
      ? await this.automations.inspectWorkflowCanary(inspectionRequest)
      : await this.automations.canaryWorkflowAutomation(request)
    const receipt = inspection
      ? validateGrowthCanaryInspectionReceipt(raw, inspectionRequest)
      : validateGrowthCanaryReceipt(raw, request)
    if (receipt.outcome === 'pending') {
      this.store.transitionExperiment({ experimentId: current.id, expectedVersion: current.version,
        expectedState: current.state, state: 'canary-pending', operationKind: 'canary-inspection',
        operationId: `${current.id}:canary-inspection:${current.version + 1}`,
        canaryExposureCount: 1, nextAttemptAt: this.now() + this.config.retryBaseMs })
      return
    }
    this.store.transitionExperiment({ experimentId: current.id, expectedVersion: current.version,
      expectedState: current.state, state: receipt.outcome === 'passed' ? 'promotion-pending' : 'rollback-pending',
      operationKind: receipt.outcome === 'passed' ? 'promotion' : 'rollback',
      operationId: `${current.id}:${receipt.outcome === 'passed' ? 'promotion' : 'rollback'}`,
      ...((receipt.outcome as string) === 'failed' ? { terminalCode: 'canary-failed' } : {}),
    })
  }

  private async promotion(experiment: GrowthExperiment): Promise<void> {
    this.candidateFor(experiment)
    const request = this.artifactRequest(experiment)
    const receipt = validateGrowthPromotionReceipt(
      await this.automations.promoteWorkflowAutomation(request), request,
    )
    this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state: 'promoted', terminalCode: 'trusted-canary-promoted',
      artifact: {
        id: experiment.artifactId!,
        version: receipt.resultingArtifactVersion,
        digest: receipt.resultingArtifactDigest,
      },
    })
  }

  private async rollback(experiment: GrowthExperiment): Promise<void> {
    const request = this.artifactRequest(experiment)
    validateGrowthRollbackReceipt(
      await this.automations.rollbackWorkflowAutomation(request), request,
    )
    this.store.transitionExperiment({ experimentId: experiment.id, expectedVersion: experiment.version,
      expectedState: experiment.state, state: 'rolled-back', terminalCode: experiment.terminalCode ?? 'rolled-back' })
  }

  private defer(experimentId: string, error: unknown): void {
    const current = this.store.getExperiment(experimentId)
    if (current === undefined || ['conflicted', 'expired', 'promoted', 'rejected', 'rolled-back']
      .includes(current.state)) return
    const attempts = current.attemptCount + 1
    if (attempts >= this.config.maxOperationAttempts && current.state !== 'approval-requesting') {
      if (current.state === 'rollback-pending') {
        this.store.recordOperationFailure({ experimentId: current.id, expectedVersion: current.version,
          code: 'rollback-retry-budget-exhausted', nextAttemptAt: this.now() + this.config.retryMaxMs })
      } else {
        this.store.requestRollback({ experimentId: current.id, expectedVersion: current.version,
          code: 'operation-retry-budget-exhausted' })
      }
      return
    }
    const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * (2 ** Math.min(attempts - 1, 20)))
    this.store.recordOperationFailure({ experimentId: current.id, expectedVersion: current.version,
      code: stableErrorCode(error), nextAttemptAt: this.now() + delay })
  }

  private scheduleTick(): void {
    void this.tick().catch(error => {
      if (this.active) this.store.recordError(stableErrorCode(error))
    })
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantGrowthExperimentsError('disposed', 'service is disposed')
  }
}
