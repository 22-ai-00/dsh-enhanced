import { createHash } from 'node:crypto'
import type {
  AssistantAutomationsService,
  SystemOwnedAutomationHealthProjection,
} from '@dsh-enhanced/assistant-automations'
import {
  canonicalEvaluationHostScope,
  type AssistantEvaluationService,
} from '@dsh-enhanced/assistant-evaluation'
import {
  canonicalEvolutionHostScope,
  type AssistantEvolutionService,
  type RuleCandidate,
  type StoredRule,
} from '@dsh-enhanced/assistant-evolution'
import type {
  AssistantHealthReport,
  AssistantHealthService,
} from '@dsh-enhanced/assistant-health'
import {
  canonicalPreferenceHostScope,
  type PreferenceLearningService,
} from '@dsh-enhanced/preference-learning'
import type {
  RecoveryActionReceipt,
  RecoveryExecutionContext,
  RecoveryRunbookPort,
  RecoveryStepPlan,
} from './executor.js'
import { RecoveryPortError } from './executor.js'
import type { NormalizedRecoveryJob } from './config.js'
import {
  RECOVERY_RUNBOOK_VERSION,
  type RecoveryPreferenceMaintenanceAction,
  type RecoveryStepAction,
  type RecoveryStepId,
} from './types.js'

export const RECOVERY_SYSTEM_OWNER = 'dsh-enhanced-assistant-recovery' as const

/**
 * Evaluation owns the cross-ledger claim/settle receipt.  Keeping this
 * structural lets Recovery remain compatible while the optional projection
 * outbox is rolled out independently from the core Evaluation ledger.
 */
export interface RecoveryEvaluationProjectionPort {
  peekPendingProjection?(input: {
    scope: ReturnType<typeof canonicalEvaluationHostScope>
  }): { evaluationId: string; attemptCount: number } | undefined
  reconcileProjection?(input: {
    scope: ReturnType<typeof canonicalEvaluationHostScope>
    evaluationId: string
    operationId: string
  }): Promise<{ evaluationId: string; status: 'deferred' | 'recorded'; attemptCount: number }>
}

export interface RecoveryRuntimePorts {
  automations: Pick<AssistantAutomationsService, 'inspectSystemOwned'> & {
    /** Atomic durable arm + production canary seam. Arm-only repair is unsafe. */
    probeCircuitAndScheduleCanary?: (input: {
      owner: string
      operationId: string
      automationId: string
      definitionHash: string
      expectedCircuitVersion: number
      leaseMs?: number
    }) => {
      operationId: string
      circuit: {
        automationId: string
        definitionHash: string
        state: string
        version: number
      }
      occurrenceId: string
      taskId: string
      executionMode: 'production'
      replayed: boolean
    }
  }
  delivery: {
    validateOwnerRoute(input: {
      authorityId: string
      principalId: string
      workspace: string
      agentPreset: string
    }): Readonly<{
      receiptVersion: 2
      authorityId: string
      authorityHash: string
      principalId: string
      principalRecordId: string
      principalVersion: number
      workspace: string
      agentPreset: string
      bindingVersion: number
      generation: number
    }>
  }
  evaluation: Pick<AssistantEvaluationService, 'health'> & RecoveryEvaluationProjectionPort
  evolution: Pick<AssistantEvolutionService,
    'hostCandidates' | 'hostListRules' | 'hostRollbackOne'>
  preference: Pick<PreferenceLearningService,
    'health' | 'hostActivationCandidate' | 'hostActivateOne' | 'hostMaintainOne' | 'hostReview'> & {
    hostOwnerFence(input: {
      scope: ReturnType<typeof canonicalPreferenceHostScope>
      principal: string
      principalLineage: Readonly<{ principalRecordId: string; principalVersion: number }>
      operationId: string
    }): Readonly<{
      ownerGeneration: number
      principalLineage: Readonly<{ principalRecordId: string; principalVersion: number }>
    }>
  }
  health: Pick<AssistantHealthService, 'hostGlobalSnapshot'>
}

const STABLE_CODE = /^[a-z\d][a-z\d.-]{0,63}$/u

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function operationId(context: RecoveryExecutionContext, stepId: RecoveryStepId, phase: 'execute' | 'plan'): string {
  return `recovery:${phase}:${RECOVERY_RUNBOOK_VERSION}:${context.occurrenceId}:${stepId}`
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RecoveryPortError('execution-cancelled', 'none')
}

function serviceCode(error: unknown, fallback: string): string {
  const candidate = typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined
  if (typeof candidate !== 'string') return fallback
  const normalized = candidate.normalize('NFC').trim().toLowerCase()
  return STABLE_CODE.test(normalized) ? normalized : fallback
}

function portFailure(error: unknown, fallback: string, possibleEffect: boolean): never {
  if (error instanceof RecoveryPortError) throw error
  const code = serviceCode(error, fallback)
  const provenPreEffect = [
    'conflict', 'disabled', 'disposed', 'forbidden', 'idempotency-conflict',
    'invalid-input', 'invalid-scope', 'missing-binding', 'missing-principal', 'not-found',
    'policy-denied', 'unauthorized-principal', 'unattested-signal', 'version-conflict',
  ].includes(code)
  throw new RecoveryPortError(code, possibleEffect && !provenPreEffect ? 'possible' : 'none')
}

function exactJob(
  context: RecoveryExecutionContext,
  jobs: ReadonlyMap<string, NormalizedRecoveryJob>,
  activationPlanDigests: ReadonlyMap<string, string>,
): NormalizedRecoveryJob {
  const job = jobs.get(context.automationId)
  if (job === undefined) throw new RecoveryPortError('automation-not-configured', 'none')
  const planDigest = activationPlanDigests.get(context.automationId)
  if (job.workspace !== context.targetScope.workspace
    || job.preset !== context.targetScope.preset
    || job.principal !== context.principal
    || job.ownerRouteId !== context.ownerRouteId
    || job.activationNonce !== context.activationNonce
    || planDigest === undefined
    || planDigest !== context.activationPlanDigest
    || job.catalogDigest !== context.catalogDigest) {
    throw new RecoveryPortError('authority-scope-mismatch', 'none')
  }
  if (context.executionMode === 'production' && job.activationState !== 'active') {
    throw new RecoveryPortError('production-not-active', 'none')
  }
  if (context.executionMode === 'preview' && job.activationState !== 'preview') {
    throw new RecoveryPortError('preview-not-enabled', 'none')
  }
  return job
}

function projectionState(projection: SystemOwnedAutomationHealthProjection): Readonly<Record<string, unknown>> {
  return Object.freeze({
    owner: projection.owner,
    automationId: projection.automationId,
    automationStatus: projection.automationStatus,
    definitionHash: projection.definitionHash,
    definitionVersion: projection.definitionVersion,
    currentCircuit: projection.currentCircuit === undefined ? null : {
      definitionHash: projection.currentCircuit.definitionHash,
      state: projection.currentCircuit.state,
      failureClass: projection.currentCircuit.failureClass,
      failurePhase: projection.currentCircuit.failurePhase,
      failureCode: projection.currentCircuit.failureCode,
      version: projection.currentCircuit.version,
    },
  })
}

function healthState(report: AssistantHealthReport): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ready: report.ready,
    severity: report.severity,
    providers: report.providers.map(provider => ({
      id: provider.id,
      status: provider.status,
      metrics: provider.metrics,
    })),
    assessments: report.assessments.map(value => ({
      providerId: value.providerId,
      severity: value.severity,
      code: value.code,
    })),
  })
}

function assertRequiredProviders(
  report: AssistantHealthReport,
  phase: 'admission' | 'verification',
): void {
  const byId = new Map(report.providers.map(provider => [provider.id, provider.status]))
  const required = [
    'assistantAutomations', 'assistantEvaluation', 'preferenceLearning',
    'assistantEvolution', 'assistantRecovery',
  ] as const
  const admissionRepairable = new Set([
    'assistantAutomations:open-circuit-backlog',
    'assistantAutomations:open-incident-backlog',
    'assistantEvaluation:projection-retry-backlog',
    'assistantRecovery:bootstrap-in-progress',
    'assistantRecovery:incomplete-recovery',
  ])
  const unexpectedAssessment = report.assessments.find(assessment => {
    if (assessment.severity !== 'degraded') return true
    const key = `${assessment.providerId}:${assessment.code}`
    return phase === 'admission'
      ? !admissionRepairable.has(key)
      : key !== 'assistantRecovery:bootstrap-in-progress'
  })
  const internallyInconsistentDegraded = report.severity === 'degraded'
    && report.assessments.length === 0
  if (!report.ready
    || report.severity === 'unhealthy'
    || unexpectedAssessment !== undefined
    || internallyInconsistentDegraded
    || required.some(id => byId.get(id) !== 'ready')) {
    throw new RecoveryPortError('health-not-ready', 'none')
  }
}

function candidateState(candidates: readonly RuleCandidate[]): readonly Readonly<Record<string, unknown>>[] {
  return candidates.map(candidate => Object.freeze({
    kind: candidate.kind,
    situation: candidate.situation,
    ruleId: candidate.ruleId ?? null,
    failures: candidate.stats.failures,
    total: candidate.stats.total,
    evidenceDigest: candidate.evidenceDigest,
    evidenceTotal: candidate.evidenceTotal,
  }))
}

function ruleState(rules: readonly StoredRule[]): readonly Readonly<Record<string, unknown>>[] {
  return rules.map(rule => Object.freeze({
    id: rule.id,
    situation: rule.situation,
    generation: rule.generation,
    status: rule.status,
    version: rule.version,
  }))
}

function validateOwnerRoute(
  context: RecoveryExecutionContext,
  delivery: RecoveryRuntimePorts['delivery'],
  expectedAuthorityHash: string,
): ReturnType<RecoveryRuntimePorts['delivery']['validateOwnerRoute']> {
  const receipt = delivery.validateOwnerRoute({
    authorityId: context.ownerRouteId,
    principalId: context.principal,
    workspace: context.targetScope.workspace,
    agentPreset: context.targetScope.preset,
  })
  const principalRecordIdValid = typeof receipt.principalRecordId === 'string'
    && receipt.principalRecordId === receipt.principalRecordId.normalize('NFC').trim()
    && receipt.principalRecordId !== ''
    && Buffer.byteLength(receipt.principalRecordId, 'utf8') <= 500
    && ![...receipt.principalRecordId].some((character) => {
      const point = character.codePointAt(0)!
      return point <= 0x1f || point === 0x7f
    })
  if (receipt.receiptVersion !== 2
    || receipt.authorityId !== context.ownerRouteId
    || receipt.principalId !== context.principal
    || !principalRecordIdValid
    || !Number.isSafeInteger(receipt.principalVersion) || receipt.principalVersion < 1
    || receipt.workspace !== context.targetScope.workspace
    || receipt.agentPreset !== context.targetScope.preset
    || !Number.isSafeInteger(receipt.bindingVersion) || receipt.bindingVersion < 1
    || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
    || typeof receipt.authorityHash !== 'string' || !/^[a-f\d]{64}$/u.test(receipt.authorityHash)) {
    throw new RecoveryPortError('owner-route-receipt-invalid', 'none')
  }
  if (!/^[a-f\d]{64}$/u.test(expectedAuthorityHash)
    || receipt.authorityHash !== expectedAuthorityHash) {
    throw new RecoveryPortError('owner-route-authority-mismatch', 'none')
  }
  return receipt
}

function routePrincipalLineage(
  route: ReturnType<RecoveryRuntimePorts['delivery']['validateOwnerRoute']>,
): Readonly<{ principalRecordId: string; principalVersion: number }> {
  return Object.freeze({
    principalRecordId: route.principalRecordId,
    principalVersion: route.principalVersion,
  })
}

function exactMaintenanceAction(
  action: Extract<RecoveryStepAction, { kind: 'maintain-preferences' }>,
): RecoveryPreferenceMaintenanceAction {
  const raw = action as {
    ownerGeneration?: unknown
    principalLineage?: unknown
  }
  const lineage = raw.principalLineage as {
    principalRecordId?: unknown
    principalVersion?: unknown
  } | undefined
  if (!Number.isSafeInteger(raw.ownerGeneration) || (raw.ownerGeneration as number) < 1
    || typeof lineage !== 'object' || lineage === null
    || typeof lineage.principalRecordId !== 'string'
    || !Number.isSafeInteger(lineage.principalVersion) || (lineage.principalVersion as number) < 1) {
    throw new RecoveryPortError('preference-maintenance-action-unfenced', 'none')
  }
  return action as RecoveryPreferenceMaintenanceAction
}

function exactPreferenceOwnerFence(
  value: unknown,
  principalLineage: Readonly<{ principalRecordId: string; principalVersion: number }>,
): ReturnType<RecoveryRuntimePorts['preference']['hostOwnerFence']> {
  const raw = value as {
    ownerGeneration?: unknown
    principalLineage?: {
      principalRecordId?: unknown
      principalVersion?: unknown
    }
  } | null
  if (raw === null || typeof raw !== 'object'
    || !Number.isSafeInteger(raw.ownerGeneration) || (raw.ownerGeneration as number) < 1
    || raw.principalLineage === null || typeof raw.principalLineage !== 'object'
    || raw.principalLineage.principalRecordId !== principalLineage.principalRecordId
    || raw.principalLineage.principalVersion !== principalLineage.principalVersion) {
    throw new RecoveryPortError('preference-maintenance-fence-receipt-invalid', 'none')
  }
  return value as ReturnType<RecoveryRuntimePorts['preference']['hostOwnerFence']>
}

function exactMaintenanceReceipt(
  value: unknown,
  action: RecoveryPreferenceMaintenanceAction,
): ReturnType<RecoveryRuntimePorts['preference']['hostMaintainOne']> {
  const raw = value as {
    deletedSignals?: unknown
    ownerGeneration?: unknown
    principalLineageId?: unknown
    principalLineageVersion?: unknown
    replayed?: unknown
  } | null
  if (raw === null || typeof raw !== 'object'
    || !Number.isSafeInteger(raw.deletedSignals) || (raw.deletedSignals as number) < 0
    || (raw.deletedSignals as number) > action.limit
    || raw.ownerGeneration !== action.ownerGeneration
    || raw.principalLineageId !== action.principalLineage.principalRecordId
    || raw.principalLineageVersion !== action.principalLineage.principalVersion
    || typeof raw.replayed !== 'boolean') {
    throw new RecoveryPortError('preference-maintenance-receipt-invalid', 'possible')
  }
  return value as ReturnType<RecoveryRuntimePorts['preference']['hostMaintainOne']>
}

/**
 * Concrete, model-free adapter over the narrow Host seams of the learning
 * services. Planning may inspect only the configured scope; mutations are
 * exact CAS/idempotent operations selected before Recovery persists intent.
 */
export class HostRecoveryRunbookPort implements RecoveryRunbookPort {
  private readonly jobs: ReadonlyMap<string, NormalizedRecoveryJob>
  private readonly activationPlanDigests: ReadonlyMap<string, string>
  private readonly authorityHashes: ReadonlyMap<string, string>

  constructor(
    jobs: ReadonlyMap<string, NormalizedRecoveryJob>,
    private readonly runtime: RecoveryRuntimePorts,
    activationPlanDigests: ReadonlyMap<string, string>,
    authorityHashes: ReadonlyMap<string, string>,
  ) {
    this.jobs = new Map(jobs)
    this.activationPlanDigests = new Map(activationPlanDigests)
    this.authorityHashes = new Map(authorityHashes)
  }

  private validateOwnerRoute(
    context: RecoveryExecutionContext,
  ): ReturnType<RecoveryRuntimePorts['delivery']['validateOwnerRoute']> {
    const expectedAuthorityHash = this.authorityHashes.get(context.automationId)
    if (expectedAuthorityHash === undefined) {
      throw new RecoveryPortError('owner-route-authority-missing', 'none')
    }
    return validateOwnerRoute(context, this.runtime.delivery, expectedAuthorityHash)
  }

  async plan(
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    signal: AbortSignal,
  ): Promise<RecoveryStepPlan> {
    throwIfAborted(signal)
    exactJob(context, this.jobs, this.activationPlanDigests)
    switch (stepId) {
      case 'authority-admission': return this.planAuthority(context, signal)
      case 'ledger-reconcile': return this.planLedger(context)
      case 'retention-maintenance': return this.planRetention(context)
      case 't1-effects': return this.planPreferenceActivation(context)
      case 'regression-rollback': return this.planEvolutionRollback(context)
      case 'incident-review': return this.planCircuitProbe(context)
      case 'verification': return this.planVerification(context, signal)
    }
  }

  async execute(
    context: RecoveryExecutionContext,
    stepId: RecoveryStepId,
    action: RecoveryStepAction,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<RecoveryActionReceipt> {
    throwIfAborted(signal)
    exactJob(context, this.jobs, this.activationPlanDigests)
    switch (action.kind) {
      case 'verify-authority': return this.verifyAuthority(context, idempotencyKey, signal)
      case 'project-evaluation': return this.projectEvaluation(context, action, idempotencyKey, signal)
      case 'maintain-preferences': return this.maintainPreferences(context, action, idempotencyKey, signal)
      case 'activate-preference': return this.activatePreference(context, action, idempotencyKey, signal)
      case 'rollback-evolution': return this.rollbackEvolution(context, action, idempotencyKey, signal)
      case 'probe-automation-circuit': return this.probeCircuit(context, action, idempotencyKey, signal)
      case 'verify-health': return this.verifyHealth(context, idempotencyKey, signal)
      case 'noop': return Object.freeze({
        status: 'noop', resultCode: action.reasonCode, afterDigest: digest({ stepId, action }),
      })
    }
  }

  private planAuthority(context: RecoveryExecutionContext, signal: AbortSignal): RecoveryStepPlan {
    try {
      const projection = this.runtime.automations.inspectSystemOwned({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId: context.automationId,
      })
      if (projection.definitionHash !== context.definitionHash || projection.automationStatus !== 'active') {
        throw new RecoveryPortError('automation-definition-mismatch', 'none')
      }
      const report = this.runtime.health.hostGlobalSnapshot({
        principal: context.principal,
        operationId: operationId(context, 'authority-admission', 'plan'),
      })
      const route = this.validateOwnerRoute(context)
      throwIfAborted(signal)
      assertRequiredProviders(report, 'admission')
      return Object.freeze({
        action: { kind: 'verify-authority' as const },
        beforeDigest: digest({
          job: exactJob(context, this.jobs, this.activationPlanDigests),
          projection: projectionState(projection),
          health: healthState(report),
          route,
        }),
      })
    } catch (error) {
      portFailure(error, 'authority-admission-failed', false)
    }
  }

  private planLedger(context: RecoveryExecutionContext): RecoveryStepPlan {
    try {
      const capable = typeof this.runtime.evaluation.peekPendingProjection === 'function'
        && typeof this.runtime.evaluation.reconcileProjection === 'function'
      const target = capable
        ? this.runtime.evaluation.peekPendingProjection!({
            scope: canonicalEvaluationHostScope(context.targetScope),
          })
        : undefined
      const action: RecoveryStepAction = !capable
        ? { kind: 'noop', reasonCode: 'projection-seam-unavailable' }
        : target === undefined
          ? { kind: 'noop', reasonCode: 'no-quality-projection' }
          : { kind: 'project-evaluation', evaluationId: target.evaluationId }
      return Object.freeze({
        action,
        beforeDigest: digest({
          scope: context.targetScope,
          evaluation: this.runtime.evaluation.health(),
          target: target ?? null,
          capable,
        }),
      })
    } catch (error) {
      portFailure(error, 'projection-plan-failed', false)
    }
  }

  private planRetention(context: RecoveryExecutionContext): RecoveryStepPlan {
    try {
      const route = this.validateOwnerRoute(context)
      const principalLineage = routePrincipalLineage(route)
      const ownerFence = exactPreferenceOwnerFence(
        this.runtime.preference.hostOwnerFence({
          scope: canonicalPreferenceHostScope(context.targetScope),
          principal: context.principal,
          principalLineage,
          operationId: operationId(context, 'retention-maintenance', 'plan'),
        }),
        principalLineage,
      )
      return Object.freeze({
        action: {
          kind: 'maintain-preferences' as const,
          limit: 1 as const,
          ownerGeneration: ownerFence.ownerGeneration,
          principalLineage,
        },
        beforeDigest: digest({
          scope: context.targetScope,
          health: this.runtime.preference.health(),
          route,
          ownerFence,
        }),
      })
    } catch (error) {
      portFailure(error, 'preference-maintenance-plan-failed', false)
    }
  }

  private planPreferenceActivation(context: RecoveryExecutionContext): RecoveryStepPlan {
    try {
      const route = this.validateOwnerRoute(context)
      const principalLineage = routePrincipalLineage(route)
      const candidate = this.runtime.preference.hostActivationCandidate({
        scope: canonicalPreferenceHostScope(context.targetScope),
        principal: context.principal,
        principalLineage,
        operationId: operationId(context, 't1-effects', 'plan'),
      })
      let action: RecoveryStepAction
      if (candidate === undefined) {
        action = { kind: 'noop', reasonCode: 'no-preference-candidate' }
      } else {
        if (!Number.isSafeInteger(candidate.ownerGeneration) || candidate.ownerGeneration < 1
          || candidate.principalLineage.principalRecordId !== principalLineage.principalRecordId
          || candidate.principalLineage.principalVersion !== principalLineage.principalVersion) {
          throw new RecoveryPortError('preference-activation-candidate-receipt-invalid', 'none')
        }
        action = {
          kind: 'activate-preference',
          hypothesisId: candidate.hypothesisId,
          expectedVersion: candidate.expectedVersion,
          ownerGeneration: candidate.ownerGeneration,
          principalLineage,
        }
      }
      return Object.freeze({
        action,
        beforeDigest: digest({ scope: context.targetScope, route, candidate: candidate ?? null }),
      })
    } catch (error) {
      portFailure(error, 'preference-plan-failed', false)
    }
  }

  private planEvolutionRollback(context: RecoveryExecutionContext): RecoveryStepPlan {
    try {
      const host = {
        scope: canonicalEvolutionHostScope(context.targetScope),
        principal: context.principal,
        operationId: operationId(context, 'regression-rollback', 'plan'),
      }
      const candidates = this.runtime.evolution.hostCandidates(host)
      const rules = this.runtime.evolution.hostListRules({ ...host, status: 'active' })
      const target = candidates
        .filter(candidate => candidate.kind === 'retire' && candidate.ruleId !== undefined)
        .sort((left, right) => left.ruleId!.localeCompare(right.ruleId!))[0]
      const rule = target === undefined ? undefined : rules.find(value => value.id === target.ruleId)
      const action: RecoveryStepAction = rule === undefined
        ? { kind: 'noop', reasonCode: 'no-regression-candidate' }
        : { kind: 'rollback-evolution', ruleId: rule.id, expectedVersion: rule.version }
      return Object.freeze({
        action,
        beforeDigest: digest({
          scope: context.targetScope,
          candidates: candidateState(candidates),
          rules: ruleState(rules),
        }),
      })
    } catch (error) {
      portFailure(error, 'evolution-plan-failed', false)
    }
  }

  private planCircuitProbe(context: RecoveryExecutionContext): RecoveryStepPlan {
    try {
      if (typeof this.runtime.automations.probeCircuitAndScheduleCanary !== 'function') {
        return Object.freeze({
          action: { kind: 'noop' as const, reasonCode: 'circuit-canary-seam-unavailable' },
          beforeDigest: digest({ capable: false }),
        })
      }
      const candidates = [...this.jobs.keys()]
        .filter(automationId => automationId !== context.automationId)
        .sort()
        .map(automationId => this.runtime.automations.inspectSystemOwned({
          owner: RECOVERY_SYSTEM_OWNER,
          automationId,
        }))
        .filter(projection => projection.automationStatus === 'active'
          && projection.currentCircuit?.state === 'open')
        .map(projection => ({ projection, circuit: projection.currentCircuit! }))
      const target = candidates[0]
      const action: RecoveryStepAction = target === undefined
        ? { kind: 'noop', reasonCode: 'no-circuit-candidate' }
        : {
            kind: 'probe-automation-circuit',
            automationId: target.projection.automationId,
            definitionHash: target.circuit.definitionHash,
            expectedVersion: target.circuit.version,
          }
      return Object.freeze({
        action,
        beforeDigest: digest(candidates.map(value => projectionState(value.projection))),
      })
    } catch (error) {
      portFailure(error, 'circuit-plan-failed', false)
    }
  }

  private planVerification(context: RecoveryExecutionContext, signal: AbortSignal): RecoveryStepPlan {
    try {
      const report = this.runtime.health.hostGlobalSnapshot({
        principal: context.principal,
        operationId: operationId(context, 'verification', 'plan'),
      })
      const route = this.validateOwnerRoute(context)
      throwIfAborted(signal)
      return Object.freeze({
        action: { kind: 'verify-health' as const },
        beforeDigest: digest({ health: healthState(report), route }),
      })
    } catch (error) {
      portFailure(error, 'health-plan-failed', false)
    }
  }

  private verifyAuthority(
    context: RecoveryExecutionContext,
    idempotencyKey: string,
    signal: AbortSignal,
  ): RecoveryActionReceipt {
    try {
      const projection = this.runtime.automations.inspectSystemOwned({
        owner: RECOVERY_SYSTEM_OWNER,
        automationId: context.automationId,
      })
      if (projection.definitionHash !== context.definitionHash || projection.automationStatus !== 'active') {
        throw new RecoveryPortError('automation-definition-mismatch', 'none')
      }
      const report = this.runtime.health.hostGlobalSnapshot({
        principal: context.principal,
        operationId: idempotencyKey,
      })
      const route = this.validateOwnerRoute(context)
      throwIfAborted(signal)
      assertRequiredProviders(report, 'admission')
      return Object.freeze({
        status: 'succeeded',
        resultCode: 'authority-verified',
        afterDigest: digest({ projection: projectionState(projection), health: healthState(report), route }),
      })
    } catch (error) {
      portFailure(error, 'authority-verification-failed', false)
    }
  }

  private async projectEvaluation(
    context: RecoveryExecutionContext,
    action: Extract<RecoveryStepAction, { kind: 'project-evaluation' }>,
    idempotencyKey: string,
    _signal: AbortSignal,
  ): Promise<RecoveryActionReceipt> {
    if (typeof this.runtime.evaluation.reconcileProjection !== 'function') {
      throw new RecoveryPortError('projection-seam-unavailable', 'none')
    }
    try {
      this.validateOwnerRoute(context)
      const result = await this.runtime.evaluation.reconcileProjection({
        scope: canonicalEvaluationHostScope(context.targetScope),
        evaluationId: action.evaluationId,
        operationId: idempotencyKey,
      })
      if (result.evaluationId !== action.evaluationId
        || !Number.isSafeInteger(result.attemptCount) || result.attemptCount < 0
        || (result.status !== 'recorded' && result.status !== 'deferred')) {
        throw new RecoveryPortError('projection-receipt-invalid', 'possible')
      }
      if (result.status === 'deferred') {
        throw new RecoveryPortError('projection-deferred', 'possible')
      }
      return Object.freeze({
        status: 'succeeded',
        resultCode: 'quality-projected',
        afterDigest: digest(result),
      })
    } catch (error) {
      portFailure(error, 'projection-reconcile-failed', true)
    }
  }

  private maintainPreferences(
    context: RecoveryExecutionContext,
    rawAction: Extract<RecoveryStepAction, { kind: 'maintain-preferences' }>,
    idempotencyKey: string,
    _signal: AbortSignal,
  ): RecoveryActionReceipt {
    try {
      const action = exactMaintenanceAction(rawAction)
      const route = this.validateOwnerRoute(context)
      if (action.principalLineage.principalRecordId !== route.principalRecordId
        || action.principalLineage.principalVersion !== route.principalVersion) {
        throw new RecoveryPortError('owner-route-lineage-mismatch', 'none')
      }
      const result = exactMaintenanceReceipt(
        this.runtime.preference.hostMaintainOne({
          scope: canonicalPreferenceHostScope(context.targetScope),
          principal: context.principal,
          principalLineage: action.principalLineage,
          ownerGeneration: action.ownerGeneration,
          operationId: idempotencyKey,
        }),
        action,
      )
      return Object.freeze({
        status: result.deletedSignals === 0 ? 'noop' : 'succeeded',
        resultCode: result.deletedSignals === 0 ? 'no-expired-preference' : 'preference-retained',
        afterDigest: digest(result),
      })
    } catch (error) {
      portFailure(error, 'preference-maintenance-failed', true)
    }
  }

  private activatePreference(
    context: RecoveryExecutionContext,
    action: Extract<RecoveryStepAction, { kind: 'activate-preference' }>,
    idempotencyKey: string,
    _signal: AbortSignal,
  ): RecoveryActionReceipt {
    try {
      const scope = canonicalPreferenceHostScope(context.targetScope)
      const route = this.validateOwnerRoute(context)
      if (action.principalLineage.principalRecordId !== route.principalRecordId
        || action.principalLineage.principalVersion !== route.principalVersion) {
        throw new RecoveryPortError('owner-route-lineage-mismatch', 'none')
      }
      // Do not re-peek here. On crash-after-commit the candidate is no longer
      // pending, while hostActivateOne's operation receipt is exactly what can
      // prove and replay the prior mutation.
      const result = this.runtime.preference.hostActivateOne({
        scope,
        principal: context.principal,
        principalLineage: action.principalLineage,
        ownerGeneration: action.ownerGeneration,
        operationId: idempotencyKey,
        hypothesisId: action.hypothesisId,
        expectedVersion: action.expectedVersion,
      })
      if (result.hypothesisId !== action.hypothesisId
        || result.expectedVersion !== action.expectedVersion
        || result.resultVersion !== action.expectedVersion + 1
        || result.ownerGeneration !== action.ownerGeneration
        || result.principalLineageId !== action.principalLineage.principalRecordId
        || result.principalLineageVersion !== action.principalLineage.principalVersion
        || typeof result.replayed !== 'boolean') {
        throw new RecoveryPortError('preference-activation-receipt-invalid', 'possible')
      }
      return Object.freeze({
        status: 'succeeded', resultCode: 'preference-activated', afterDigest: digest(result),
      })
    } catch (error) {
      portFailure(error, 'preference-activation-failed', true)
    }
  }

  private rollbackEvolution(
    context: RecoveryExecutionContext,
    action: Extract<RecoveryStepAction, { kind: 'rollback-evolution' }>,
    idempotencyKey: string,
    _signal: AbortSignal,
  ): RecoveryActionReceipt {
    try {
      const scope = canonicalEvolutionHostScope(context.targetScope)
      this.validateOwnerRoute(context)
      // The Evolution store recomputes evidence/CAS on first execution and
      // returns its immutable rollback receipt on replay. A fresh candidate
      // lookup here would incorrectly reject a successful prior retirement.
      const result = this.runtime.evolution.hostRollbackOne({
        scope,
        principal: context.principal,
        operationId: idempotencyKey,
        ruleId: action.ruleId,
        expectedVersion: action.expectedVersion,
      })
      if (result.rollback.ruleId !== action.ruleId
        || result.rollback.expectedVersion !== action.expectedVersion
        || result.rollback.resultVersion !== action.expectedVersion + 1
        || result.rule.id !== action.ruleId
        || result.rule.version !== result.rollback.resultVersion
        || result.rule.status !== 'retired'
        || typeof result.replayed !== 'boolean'
        || !/^[a-f\d]{64}$/u.test(result.rollback.evidence.digest)) {
        throw new RecoveryPortError('evolution-rollback-receipt-invalid', 'possible')
      }
      return Object.freeze({
        status: 'succeeded', resultCode: 'evolution-rolled-back', afterDigest: digest({
          ruleId: result.rule.id,
          version: result.rule.version,
          replayed: result.replayed,
          evidenceDigest: result.rollback.evidence.digest,
        }),
      })
    } catch (error) {
      portFailure(error, 'evolution-rollback-failed', true)
    }
  }

  private probeCircuit(
    context: RecoveryExecutionContext,
    action: Extract<RecoveryStepAction, { kind: 'probe-automation-circuit' }>,
    idempotencyKey: string,
    _signal: AbortSignal,
  ): RecoveryActionReceipt {
    if (typeof this.runtime.automations.probeCircuitAndScheduleCanary !== 'function') {
      throw new RecoveryPortError('circuit-canary-seam-unavailable', 'none')
    }
    try {
      this.validateOwnerRoute(context)
      // The sink atomically arms the exact circuit and durably schedules a
      // production canary. Replaying this operation never re-inspects `open`.
      const result = this.runtime.automations.probeCircuitAndScheduleCanary({
        owner: RECOVERY_SYSTEM_OWNER,
        operationId: idempotencyKey,
        automationId: action.automationId,
        definitionHash: action.definitionHash,
        expectedCircuitVersion: action.expectedVersion,
      })
      if (result.operationId !== idempotencyKey
        || result.circuit.automationId !== action.automationId
        || result.circuit.definitionHash !== action.definitionHash
        || result.circuit.state !== 'half-open'
        || result.circuit.version !== action.expectedVersion + 1
        || result.executionMode !== 'production'
        || typeof result.occurrenceId !== 'string' || result.occurrenceId === ''
        || typeof result.taskId !== 'string' || result.taskId === ''
        || typeof result.replayed !== 'boolean') {
        throw new RecoveryPortError('circuit-canary-receipt-invalid', 'possible')
      }
      return Object.freeze({
        status: 'succeeded', resultCode: 'circuit-canary-scheduled', afterDigest: digest({
          operationId: result.operationId,
          automationId: result.circuit.automationId,
          definitionHash: result.circuit.definitionHash,
          state: result.circuit.state,
          version: result.circuit.version,
          canary: {
            occurrenceId: result.occurrenceId,
            taskId: result.taskId,
            executionMode: result.executionMode,
          },
          replayed: result.replayed,
        }),
      })
    } catch (error) {
      portFailure(error, 'circuit-probe-failed', true)
    }
  }

  private verifyHealth(
    context: RecoveryExecutionContext,
    idempotencyKey: string,
    signal: AbortSignal,
  ): RecoveryActionReceipt {
    try {
      const report = this.runtime.health.hostGlobalSnapshot({
        principal: context.principal,
        operationId: idempotencyKey,
      })
      const route = this.validateOwnerRoute(context)
      throwIfAborted(signal)
      assertRequiredProviders(report, 'verification')
      return Object.freeze({
        status: 'succeeded', resultCode: 'health-verified', afterDigest: digest({
          health: healthState(report), route,
        }),
      })
    } catch (error) {
      portFailure(error, 'health-verification-failed', false)
    }
  }
}
