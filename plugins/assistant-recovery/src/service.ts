import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type {
  AssistantAutomationsService,
  HostAutomationDefinition,
  HostAutomationExecutorInput,
} from '@dsh-enhanced/assistant-automations'
import type { AssistantEvaluationService } from '@dsh-enhanced/assistant-evaluation'
import type { AssistantEvolutionService } from '@dsh-enhanced/assistant-evolution'
import type { AssistantHealthService } from '@dsh-enhanced/assistant-health'
import {
  RECOVERY_EXECUTOR_CONTRACT_VERSION,
  RECOVERY_EXECUTOR_ID,
  RecoveryAutomationExecutor,
} from './automation-executor.js'
import { RECOVERY_CATALOG_DIGEST } from './catalog.js'
import {
  ConfigSchema,
  normalizeRecoveryConfig,
  type Config as RecoveryConfig,
  type NormalizedConfig,
  type NormalizedRecoveryJob,
} from './config.js'
import { RecoveryExecutor } from './executor.js'
import {
  HostRecoveryRunbookPort,
  RECOVERY_SYSTEM_OWNER,
  type RecoveryRuntimePorts,
} from './port.js'
import { RECOVERY_DEADLINE_GRACE_MS, RecoveryStore } from './store.js'
import {
  RECOVERY_RUNBOOK_ID,
  RECOVERY_RUNBOOK_VERSION,
  type RecoveryBootstrapAttestation,
  type RecoveryHealth,
} from './types.js'

export type AssistantRecoveryErrorCode =
  | 'disposed'
  | 'missing-preview'
  | 'preview-failed'
  | 'service-unavailable'

export class AssistantRecoveryError extends Error {
  constructor(readonly code: AssistantRecoveryErrorCode, message: string) {
    super(message)
    this.name = 'AssistantRecoveryError'
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantRecovery: AssistantRecoveryService }
}

const PREVIEW_AT = '9999-12-31T23:59:59.999Z'

export function recoveryAutomationId(jobId: string): string {
  return `recovery:${jobId}`
}

function scopeDigest(job: NormalizedRecoveryJob): string {
  return createHash('sha256').update(JSON.stringify([job.workspace, job.preset])).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function timeoutMs(maxStepDurationMs: number): number {
  // Seven catalog steps each have independently bounded plan + execute phases.
  return Math.min(86_400_000, maxStepDurationMs * 14 + RECOVERY_DEADLINE_GRACE_MS)
}

/** Build the only Host definition Recovery is allowed to reconcile. */
export function recoveryAutomationDefinition(
  job: NormalizedRecoveryJob,
  maxStepDurationMs: number,
  mode: 'preview' | 'production',
): HostAutomationDefinition {
  return Object.freeze({
    name: `Assistant recovery: ${job.id}`,
    schedule: mode === 'preview'
      ? Object.freeze({ kind: 'at' as const, at: PREVIEW_AT })
      : Object.freeze({ kind: 'cron' as const, expression: job.cron, timezone: job.timezone }),
    workspace: job.workspace,
    agentPreset: job.preset,
    timeoutMs: timeoutMs(maxStepDurationMs),
    misfire: Object.freeze({ kind: 'latest' as const }),
    overlap: 'skip',
    // One expired runner lease may be resumed because every mutating step has
    // an exact durable intent and an idempotent downstream operation receipt.
    retrySafety: 'idempotent',
    maxRetries: 1,
    principal: job.principal,
    ...(job.budgetId === undefined ? {} : { budgetId: job.budgetId, budgetAmount: job.budgetAmount! }),
    execution: Object.freeze({
      kind: 'host' as const,
      executorId: RECOVERY_EXECUTOR_ID,
      executorContractVersion: RECOVERY_EXECUTOR_CONTRACT_VERSION,
      runbookId: RECOVERY_RUNBOOK_ID,
      runbookVersion: RECOVERY_RUNBOOK_VERSION,
      catalogDigest: RECOVERY_CATALOG_DIGEST,
      targetScope: Object.freeze({ workspace: job.workspace, preset: job.preset }),
      scopeDigest: scopeDigest(job),
      ownerRouteId: job.ownerRouteId,
      activationNonce: job.activationNonce,
    }),
  })
}

/** Exact preview attestation key for the full production control plan. */
export function recoveryActivationPlanDigest(
  job: NormalizedRecoveryJob,
  maxStepDurationMs: number,
  authorityHash: string,
): string {
  if (!/^[a-f\d]{64}$/u.test(authorityHash)) {
    throw new AssistantRecoveryError(
      'service-unavailable',
      'assistant-recovery requires a valid stable owner-route authority hash',
    )
  }
  return stableDigest({
    contract: 'assistant-recovery-activation/v2',
    owner: RECOVERY_SYSTEM_OWNER,
    automationId: recoveryAutomationId(job.id),
    authorityHash,
    maxStepDurationMs,
    productionDefinition: recoveryAutomationDefinition(job, maxStepDurationMs, 'production'),
  })
}

function resolveOwnerRouteAuthority(
  job: NormalizedRecoveryJob,
  delivery: RecoveryRuntimePorts['delivery'],
): string {
  const receipt = delivery.validateOwnerRoute({
    authorityId: job.ownerRouteId,
    principalId: job.principal,
    workspace: job.workspace,
    agentPreset: job.preset,
  })
  if (receipt.receiptVersion !== 2
    || receipt.authorityId !== job.ownerRouteId
    || receipt.principalId !== job.principal
    || receipt.workspace !== job.workspace
    || receipt.agentPreset !== job.preset
    || typeof receipt.principalRecordId !== 'string'
    || receipt.principalRecordId.normalize('NFC').trim() !== receipt.principalRecordId
    || receipt.principalRecordId === ''
    || Buffer.byteLength(receipt.principalRecordId, 'utf8') > 500
    || !Number.isSafeInteger(receipt.principalVersion) || receipt.principalVersion < 1
    || typeof receipt.authorityHash !== 'string'
    || !/^[a-f\d]{64}$/u.test(receipt.authorityHash)
    || !Number.isSafeInteger(receipt.bindingVersion) || receipt.bindingVersion < 1
    || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1) {
    throw new AssistantRecoveryError(
      'service-unavailable',
      `assistant-recovery owner route ${job.ownerRouteId} returned an invalid receipt`,
    )
  }
  return receipt.authorityHash
}

function requiredService<T>(ctx: Context, name: string): T {
  const service = ctx.get(name as never) as T | undefined
  if (service === undefined) {
    throw new AssistantRecoveryError('service-unavailable', `assistant-recovery requires ${name}`)
  }
  return service
}

function requireHostSeams(
  provider: string,
  service: unknown,
  methods: readonly string[],
): void {
  const value = service as Record<string, unknown>
  const missing = methods.find(method => typeof value[method] !== 'function')
  if (missing !== undefined) {
    throw new AssistantRecoveryError(
      'service-unavailable',
      `assistant-recovery requires ${provider}.${missing}`,
    )
  }
}

function stableErrorCode(error: unknown, fallback: string): string {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof code !== 'string') return fallback
  const normalized = code.normalize('NFC').trim().toLowerCase()
  return /^[a-z\d][a-z\d.-]{0,63}$/u.test(normalized) ? normalized : fallback
}

export class AssistantRecoveryService extends Service {
  static Config = ConfigSchema
  static inject = [
    'assistantAutomations',
    'assistantDelivery',
    'assistantEvaluation',
    'assistantEvolution',
    'assistantPreferenceLearning',
    'assistantHealth',
  ]

  private readonly config: NormalizedConfig
  private readonly store: RecoveryStore
  private readonly automations: AssistantAutomationsService
  private readonly activationPlanDigests: ReadonlyMap<string, string>
  private readonly automationExecutor: RecoveryAutomationExecutor
  private readonly unregisterExecutor: () => void
  private readonly bootstrap: Promise<void>
  private active = true

  constructor(ctx: Context, input: RecoveryConfig) {
    super(ctx, 'assistantRecovery')
    this.config = normalizeRecoveryConfig(input)
    this.store = new RecoveryStore({
      path: this.config.databasePath,
      maxStepDurationMs: this.config.maxStepDurationMs,
      deadlineGraceMs: RECOVERY_DEADLINE_GRACE_MS,
    })
    const bootstrapGeneration = (() => {
      try {
        return this.store.beginBootstrap({
          attestationValid: false,
          attestations: Object.freeze([]),
        }).generation
      } catch (error) {
        this.store.close()
        throw error
      }
    })()

    // A production definition is never created active until the same immutable
    // authority tuple completed a preview under the configured activation nonce.
    try {
      this.automations = requiredService<AssistantAutomationsService>(ctx, 'assistantAutomations')
      const delivery = requiredService<RecoveryRuntimePorts['delivery']>(ctx, 'assistantDelivery')
      const evaluation = requiredService<AssistantEvaluationService>(ctx, 'assistantEvaluation')
      const evolution = requiredService<AssistantEvolutionService>(ctx, 'assistantEvolution')
      const preference = requiredService<RecoveryRuntimePorts['preference']>(
        ctx,
        'assistantPreferenceLearning',
      )
      const health = requiredService<AssistantHealthService>(ctx, 'assistantHealth')
      requireHostSeams('assistantAutomations', this.automations, [
        'inspectSystemOwned', 'listSystemOwned', 'pauseSystemOwned',
        'probeCircuitAndScheduleCanary', 'reconcileSystem', 'registerHostExecutor', 'runSystemDry',
      ])
      requireHostSeams('assistantDelivery', delivery, ['validateOwnerRoute'])
      requireHostSeams('assistantEvaluation', evaluation, [
        'health', 'peekPendingProjection', 'reconcileProjection',
      ])
      requireHostSeams('assistantEvolution', evolution, [
        'hostCandidates', 'hostListRules', 'hostRollbackOne',
      ])
      requireHostSeams('assistantPreferenceLearning', preference, [
        'health', 'hostActivationCandidate', 'hostActivateOne', 'hostMaintainOne',
        'hostOwnerFence', 'hostReview',
      ])
      requireHostSeams('assistantHealth', health, ['hostGlobalSnapshot'])
      const authorityHashes = new Map<string, string>()
      for (const job of this.config.jobs) {
        try {
          authorityHashes.set(
            recoveryAutomationId(job.id),
            resolveOwnerRouteAuthority(job, delivery),
          )
        } catch (error) {
          this.pauseUnattestedJob(job)
          throw error
        }
      }
      this.activationPlanDigests = new Map(this.config.jobs.map(job => {
        const automationId = recoveryAutomationId(job.id)
        const authorityHash = authorityHashes.get(automationId)
        if (authorityHash === undefined) {
          throw new AssistantRecoveryError(
            'service-unavailable',
            `assistant-recovery job ${job.id} has no owner-route authority attestation`,
          )
        }
        return [
          automationId,
          recoveryActivationPlanDigest(job, this.config.maxStepDurationMs, authorityHash),
        ]
      }))
      const bootstrapAttestations: readonly RecoveryBootstrapAttestation[]
        = this.config.jobs.map(job => Object.freeze({
          automationId: recoveryAutomationId(job.id),
          activationState: job.activationState,
          activationNonce: job.activationNonce,
          activationPlanDigest: this.activationPlanDigests.get(recoveryAutomationId(job.id))!,
        }))
      this.store.attestBootstrap({
        expectedGeneration: bootstrapGeneration,
        attestations: bootstrapAttestations,
      })
      for (const job of this.config.jobs) {
        if (job.activationState === 'active' && this.previewFor(job) === undefined) {
          this.pauseUnattestedJob(job)
          throw new AssistantRecoveryError(
            'missing-preview',
            `assistant-recovery job ${job.id} requires a successful preview before activation`,
          )
        }
      }
      const jobs = new Map(this.config.jobs.map(job => [recoveryAutomationId(job.id), job]))
      const runtime: RecoveryRuntimePorts = {
        automations: this.automations, delivery, evaluation, evolution, preference, health,
      }
      const runbookPort = new HostRecoveryRunbookPort(
        jobs,
        runtime,
        this.activationPlanDigests,
        authorityHashes,
      )
      this.automationExecutor = new RecoveryAutomationExecutor(
        new RecoveryExecutor(this.store, runbookPort, this.config.maxStepDurationMs),
        (input: HostAutomationExecutorInput) => {
          const value = this.activationPlanDigests.get(input.automationId)
          if (value === undefined) {
            throw new AssistantRecoveryError('service-unavailable', 'automation has no activation plan')
          }
          return value
        },
      )
      this.unregisterExecutor = this.automations.registerHostExecutor(this.automationExecutor)
      const previewJobs: NormalizedRecoveryJob[] = []
      try {
        this.pauseRemovedJobs(new Set(jobs.keys()))
        // Production/paused reconciliation is synchronous. Configuration,
        // ownership or Policy failures therefore abort plugin activation rather
        // than leaving a deceptively healthy, inert Recovery service.
        for (const job of this.config.jobs) {
          if (job.activationState === 'preview') {
            // Pause every preview definition synchronously before any preview
            // runs. If an earlier job fails, later jobs cannot retain an old
            // active production schedule while bootstrap short-circuits.
            this.reconcilePreviewPaused(job)
            previewJobs.push(job)
          } else this.reconcileProduction(job, job.activationState)
        }
      } catch (error) {
        this.unregisterExecutor()
        throw error
      }
      this.bootstrap = this.runPreviews(previewJobs).then(() => {
        this.store.completeBootstrap({
          expectedGeneration: bootstrapGeneration,
          status: 'succeeded',
        })
      }, (error: unknown) => {
        this.store.completeBootstrap({
          expectedGeneration: bootstrapGeneration,
          status: 'failed',
          failureCode: stableErrorCode(error, 'preview-bootstrap-failed'),
        })
        throw error
      })
      void this.bootstrap.catch((error: unknown) => {
        ctx.logger.error(`assistant-recovery bootstrap failed: ${stableErrorCode(error, 'preview-bootstrap-failed')}`)
      })
    } catch (error) {
      try {
        this.store.completeBootstrap({
          expectedGeneration: bootstrapGeneration,
          status: 'failed',
          failureCode: stableErrorCode(error, 'service-bootstrap-failed'),
        })
      } catch {
        // The activation error remains authoritative if observability fails.
      }
      this.store.close()
      throw error
    }

    ctx.effect(() => async () => {
      this.active = false
      this.unregisterExecutor()
      await Promise.allSettled([this.bootstrap])
      await this.automationExecutor.whenIdle()
      this.store.close()
    }, 'assistant-recovery.runtime')
  }

  health(): RecoveryHealth {
    this.assertActive()
    return this.store.health()
  }

  async whenIdle(): Promise<void> {
    this.assertActive()
    await this.bootstrap
    await this.automationExecutor.whenIdle()
  }

  private previewFor(job: NormalizedRecoveryJob) {
    const activationPlanDigest = this.activationPlanDigests.get(recoveryAutomationId(job.id))
    if (activationPlanDigest === undefined) {
      throw new AssistantRecoveryError(
        'service-unavailable',
        `assistant-recovery job ${job.id} has no activation plan`,
      )
    }
    return this.store.findSuccessfulPreview({
      automationId: recoveryAutomationId(job.id),
      targetScope: { workspace: job.workspace, preset: job.preset },
      principal: job.principal,
      ownerRouteId: job.ownerRouteId,
      activationNonce: job.activationNonce,
      activationPlanDigest,
      catalogDigest: job.catalogDigest,
    })
  }

  private async runPreviews(jobs: readonly NormalizedRecoveryJob[]): Promise<void> {
    for (const job of jobs) {
      if (!this.active) throw new AssistantRecoveryError('disposed', 'assistant-recovery service is disposed')
      await this.runPreview(job)
    }
  }

  private reconcileProduction(job: NormalizedRecoveryJob, state: 'active' | 'paused'): void {
    const definition = recoveryAutomationDefinition(job, this.config.maxStepDurationMs, 'production')
    this.automations.reconcileSystem({
      owner: RECOVERY_SYSTEM_OWNER,
      automationId: recoveryAutomationId(job.id),
      idempotencyKey: this.reconcileIdempotencyKey(job, state, definition, 'production'),
      desiredStatus: state,
      definition,
    })
  }

  private reconcilePreviewPaused(job: NormalizedRecoveryJob): void {
    const definition = recoveryAutomationDefinition(job, this.config.maxStepDurationMs, 'preview')
    this.automations.reconcileSystem({
      owner: RECOVERY_SYSTEM_OWNER,
      automationId: recoveryAutomationId(job.id),
      idempotencyKey: this.reconcileIdempotencyKey(job, 'paused', definition, 'preview-paused'),
      desiredStatus: 'paused',
      definition,
    })
  }

  private pauseRemovedJobs(desiredAutomationIds: ReadonlySet<string>): void {
    const inventory = this.automations.listSystemOwned({ owner: RECOVERY_SYSTEM_OWNER, limit: 1_000 })
    if (inventory.length === 1_000) {
      throw new AssistantRecoveryError(
        'service-unavailable',
        'assistant-recovery system-owned inventory reached its safe reconciliation bound',
      )
    }
    for (const current of inventory) {
      if (desiredAutomationIds.has(current.automationId) || current.automationStatus !== 'active') continue
      const operationId = `recovery-remove:v1:${stableDigest({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId: current.automationId,
        definitionHash: current.definitionHash,
        expectedVersion: current.definitionVersion,
      })}`
      const receipt = this.automations.pauseSystemOwned({
        owner: RECOVERY_SYSTEM_OWNER,
        operationId,
        automationId: current.automationId,
        definitionHash: current.definitionHash,
        expectedVersion: current.definitionVersion,
      })
      if (receipt.operationId !== operationId
        || receipt.owner !== RECOVERY_SYSTEM_OWNER
        || receipt.automationId !== current.automationId
        || receipt.definitionHash !== current.definitionHash
        || receipt.expectedVersion !== current.definitionVersion
        || receipt.definitionVersion !== current.definitionVersion + 1
        || receipt.automationStatus !== 'paused') {
        throw new AssistantRecoveryError(
          'service-unavailable',
          'assistant-recovery received an invalid removed-job pause receipt',
        )
      }
    }
  }

  private pauseUnattestedJob(job: NormalizedRecoveryJob): void {
    const automationId = recoveryAutomationId(job.id)
    let current: ReturnType<AssistantAutomationsService['inspectSystemOwned']>
    try {
      current = this.automations.inspectSystemOwned({ owner: RECOVERY_SYSTEM_OWNER, automationId })
    } catch (error) {
      if (stableErrorCode(error, 'inspect-failed') === 'not-found') return
      throw error
    }
    if (current.automationStatus !== 'active') return
    const operationId = `recovery-unattested:v1:${stableDigest({
      owner: RECOVERY_SYSTEM_OWNER,
      automationId,
      definitionHash: current.definitionHash,
      expectedVersion: current.definitionVersion,
    })}`
    const receipt = this.automations.pauseSystemOwned({
      owner: RECOVERY_SYSTEM_OWNER,
      operationId,
      automationId,
      definitionHash: current.definitionHash,
      expectedVersion: current.definitionVersion,
    })
    if (receipt.operationId !== operationId
      || receipt.owner !== RECOVERY_SYSTEM_OWNER
      || receipt.automationId !== automationId
      || receipt.definitionHash !== current.definitionHash
      || receipt.expectedVersion !== current.definitionVersion
      || receipt.definitionVersion !== current.definitionVersion + 1
      || receipt.automationStatus !== 'paused') {
      throw new AssistantRecoveryError(
        'service-unavailable',
        'assistant-recovery received an invalid unattested-job pause receipt',
      )
    }
  }

  private async runPreview(job: NormalizedRecoveryJob): Promise<void> {
    const automationId = recoveryAutomationId(job.id)
    const definition = recoveryAutomationDefinition(job, this.config.maxStepDurationMs, 'preview')
    let activationAttempted = false
    let failure: { error: unknown; code: string } | undefined
    try {
      activationAttempted = true
      this.automations.reconcileSystem({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId,
        idempotencyKey: this.reconcileIdempotencyKey(job, 'active', definition, 'preview-active'),
        desiredStatus: 'active',
        definition,
      })
      const projection = this.automations.inspectSystemOwned({ owner: RECOVERY_SYSTEM_OWNER, automationId })
      const result = await this.automations.runSystemDry({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId,
        definitionHash: projection.definitionHash,
        idempotencyKey: `recovery-preview:${job.activationNonce}:${projection.definitionHash}`,
      })
      if (result.occurrence.dryRun !== true || result.run.executionMode !== 'preview'
        || result.occurrence.status !== 'succeeded' || result.run.status !== 'succeeded') {
        throw new AssistantRecoveryError(
          'preview-failed',
          `assistant-recovery preview ${job.id} finished as ${result.run.status}`,
        )
      }
      if (this.previewFor(job) === undefined) {
        throw new AssistantRecoveryError(
          'preview-failed',
          `assistant-recovery preview ${job.id} did not attest the current activation plan`,
        )
      }
    } catch (error) {
      failure = { error, code: stableErrorCode(error, 'preview-bootstrap-failed') }
      this.recordControlFailure(job, 'preview', failure.code)
    }
    if (activationAttempted) {
      try {
        this.automations.reconcileSystem({
          owner: RECOVERY_SYSTEM_OWNER,
          automationId,
          idempotencyKey: this.reconcileIdempotencyKey(job, 'paused', definition, 'preview-paused'),
          desiredStatus: 'paused',
          definition,
        })
      } catch (error) {
        if (failure === undefined) {
          failure = { error, code: stableErrorCode(error, 'preview-pause-failed') }
          this.recordControlFailure(job, 'preview', failure.code)
        }
      }
    }
    if (failure !== undefined) throw failure.error
  }

  private recordControlFailure(
    job: NormalizedRecoveryJob,
    executionMode: 'preview' | 'production',
    resultCode: string,
  ): void {
    try {
      const activationPlanDigest = this.activationPlanDigests.get(recoveryAutomationId(job.id))
      if (activationPlanDigest === undefined) return
      const definition = recoveryAutomationDefinition(
        job,
        this.config.maxStepDurationMs,
        executionMode === 'preview' ? 'preview' : 'production',
      )
      const definitionHash = stableDigest(definition)
      const run = this.store.beginRun({
        occurrenceId: `recovery-control-${stableDigest({
          automationId: recoveryAutomationId(job.id),
          executionMode,
          resultCode,
          activationPlanDigest,
        })}`,
        automationId: recoveryAutomationId(job.id),
        definitionHash,
        executionMode,
        targetScope: { workspace: job.workspace, preset: job.preset },
        principal: job.principal,
        ownerRouteId: job.ownerRouteId,
        activationNonce: job.activationNonce,
        activationPlanDigest,
        catalogDigest: job.catalogDigest,
      }).run
      if (run.status === 'running') {
        this.store.completeRun({
          runId: run.id,
          expectedVersion: run.version,
          status: 'failed',
          resultCode,
        })
      }
    } catch {
      // The original bootstrap error remains authoritative. A secondary
      // observability write must never mask it or invent a contradictory state.
    }
  }

  private reconcileIdempotencyKey(
    job: NormalizedRecoveryJob,
    desiredStatus: 'active' | 'paused',
    definition: HostAutomationDefinition,
    stage: 'preview-active' | 'preview-paused' | 'production',
  ): string {
    const automationId = recoveryAutomationId(job.id)
    let current: Readonly<Record<string, unknown>>
    try {
      const projection = this.automations.inspectSystemOwned({ owner: RECOVERY_SYSTEM_OWNER, automationId })
      current = Object.freeze({
        status: projection.automationStatus,
        definitionHash: projection.definitionHash,
        definitionVersion: projection.definitionVersion,
      })
    } catch (error) {
      if (stableErrorCode(error, 'inspect-failed') !== 'not-found') throw error
      current = Object.freeze({ missing: true })
    }
    return `recovery-reconcile:v1:${stableDigest({
      stage,
      owner: RECOVERY_SYSTEM_OWNER,
      automationId,
      desiredStatus,
      definition,
      current,
    })}`
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantRecoveryError('disposed', 'assistant-recovery service is disposed')
  }
}

export const Config = AssistantRecoveryService.Config
