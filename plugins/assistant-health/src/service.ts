import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Schema from '@deepseek-ai/schemastery'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { registerAssistantHealthTool } from './tools.js'

export const providerIds = [
  'assistantPolicy',
  'personalMemory',
  'personalWiki',
  'assistantAutomations',
  'assistantEvaluation',
  'preferenceLearning',
  'assistantEvolution',
  'assistantDelivery',
  'credentialsKeychain',
  'eventTriggers',
  'assistantRecovery',
  'assistantGrowthExperiments',
  'pluginControlPlane',
  'assistantHeartbeat',
  'larkChannel',
] as const

export type HealthProviderId = typeof providerIds[number]
export type HealthMetric = boolean | number | string
export type HealthSeverity = 'healthy' | 'degraded' | 'unhealthy'

/**
 * Public health ids are stable configuration/report vocabulary. They do not
 * necessarily equal the Cordis service registration name exposed by a
 * provider. Keep that runtime seam explicit so a renamed/public-facing id
 * cannot silently turn an installed provider into `missing`.
 */
const providerServiceNames: Readonly<Record<HealthProviderId, string>> = Object.freeze({
  assistantPolicy: 'assistantPolicy',
  personalMemory: 'personalMemory',
  personalWiki: 'personalWiki',
  assistantAutomations: 'assistantAutomations',
  assistantEvaluation: 'assistantEvaluation',
  preferenceLearning: 'assistantPreferenceLearning',
  assistantEvolution: 'assistantEvolution',
  assistantDelivery: 'assistantDelivery',
  credentialsKeychain: 'credentialsKeychain',
  eventTriggers: 'eventTriggers',
  assistantRecovery: 'assistantRecovery',
  assistantGrowthExperiments: 'assistantGrowthExperiments',
  pluginControlPlane: 'pluginControlPlane',
  assistantHeartbeat: 'assistantHeartbeat',
  larkChannel: 'larkChannel',
})

export interface Config {
  requiredProviders?: HealthProviderId[]
}

export interface ProviderHealth {
  id: HealthProviderId
  status: 'error' | 'missing' | 'ready'
  metrics: Readonly<Record<string, HealthMetric>>
}

export interface HealthAssessment {
  providerId: HealthProviderId
  severity: Exclude<HealthSeverity, 'healthy'>
  /** Stable, low-cardinality reason code. */
  code: string
}

export interface AssistantHealthReport {
  ready: boolean
  severity: HealthSeverity
  generatedAt: number
  providers: readonly ProviderHealth[]
  assessments: readonly HealthAssessment[]
  warnings: readonly string[]
}

export type AssistantHealthErrorCode =
  | 'disposed'
  | 'invalid-input'
  | 'invalid-scope'
  | 'missing-principal'
  | 'policy-denied'
export class AssistantHealthError extends Error {
  constructor(readonly code: AssistantHealthErrorCode, message: string) {
    super(message)
    this.name = 'AssistantHealthError'
  }
}

const configSchema = Schema.object({
  requiredProviders: Schema.array(Schema.union(providerIds)).default([
    'assistantPolicy', 'personalMemory', 'personalWiki', 'assistantAutomations',
  ]),
}) as Schema<Config>

type HealthMetricSpecification =
  | 'boolean'
  | 'number'
  | 'optional-boolean'
  | 'optional-bootstrap-status'
  | 'optional-code'
  | 'optional-digest'
  | 'optional-number'
  | 'optional-production-status'
  | readonly string[]

/** Fixed Policy subject used by the non-model supervised-growth runbook. */
export const HOST_RECOVERY_BACKGROUND_ID = 'dsh-enhanced-assistant-recovery'

export interface HealthHostGlobalOperation {
  /** Authenticated owner identity supplied by the Host route, never a model. */
  principal: string
  /** Exact fixed-run receipt/run identifier used for Policy budget idempotency. */
  operationId: string
}

function hostText(
  value: unknown,
  label: string,
  maxBytes: number,
  code: Extract<AssistantHealthErrorCode, 'invalid-input' | 'missing-principal'> = 'invalid-input',
): string {
  if (typeof value !== 'string') {
    throw new AssistantHealthError(code, `${label} must be a string`)
  }
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized, 'utf8') > maxBytes
    || hasControl(normalized)) {
    throw new AssistantHealthError(code, `${label} is invalid`)
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

const keys: Record<HealthProviderId, Readonly<Record<string, HealthMetricSpecification>>> = {
  assistantPolicy: { emergencyStop: 'boolean', lastAuditSequence: 'number' },
  personalMemory: { activeRecords: 'number', removedRecords: 'number', expiredRecords: 'number', pendingProposals: 'number' },
  personalWiki: { pages: 'number', lintErrors: 'number', lintWarnings: 'number', pendingProposals: 'number' },
  assistantAutomations: { activeAutomations: 'number', pausedAutomations: 'number', pendingTasks: 'number',
    runningTasks: 'number', failedRuns: 'number', unknownRuns: 'number', pendingEvaluations: 'number',
    retryingEvaluations: 'number', failedEvaluationAttempts: 'number', deadLetterEvaluations: 'number',
    oldestPendingEvaluationAt: 'number', openCircuits: 'optional-number',
    openIncidents: 'optional-number', pendingIncidentAlerts: 'optional-number' },
  assistantEvaluation: { ready: 'boolean', schemaVersion: 'number', outcomes: 'number',
    trustedOutcomes: 'number', selfReportedOutcomes: 'number', externalOutcomes: 'number',
    selfAssessments: 'number', latestOccurredAt: 'optional-number',
    taskProjections: 'optional-number', conflictedTaskProjections: 'optional-number',
    pendingProjections: 'optional-number', retryingProjections: 'optional-number',
    projectionAttempts: 'optional-number', oldestPendingProjectionAt: 'optional-number' },
  preferenceLearning: { ready: 'boolean', enabled: 'boolean', schemaVersion: 'number', signals: 'number',
    hypotheses: 'number', active: 'number', shadow: 'number', proposed: 'number',
    rolledBack: 'number', expired: 'number', lastRecordedAt: 'optional-number' },
  assistantEvolution: { activeRules: 'number', retiredRules: 'number', pendingProposals: 'number',
    conflictedProposals: 'number', trustedEpisodes: 'number', unattributedTrustedEpisodes: 'number',
    lastTrustedEpisodeAt: 'number', lastReconciledAt: 'number', autonomousRollbacks: 'number',
    qualityEligibleEpisodes: 'optional-number', operationalEpisodes: 'optional-number',
    legacyQuarantinedEpisodes: 'optional-number', unattributedQualityEligibleEpisodes: 'optional-number',
    lastQualityEligibleEpisodeAt: 'optional-number' },
  assistantDelivery: { pendingInbox: 'number', deadLetterInbox: 'number', pendingOutbox: 'number',
    deadLetterOutbox: 'number', unknownOutbox: 'number', adapters: 'number',
    actionableDeadLetterInbox: 'optional-number', resolvedDeadLetterInbox: 'optional-number',
    actionableDeadLetterOutbox: 'optional-number', resolvedDeadLetterOutbox: 'optional-number',
    actionableUnknownOutbox: 'optional-number', resolvedUnknownOutbox: 'optional-number',
    pendingPresentations: 'optional-number', deadPresentations: 'optional-number' },
  credentialsKeychain: { handles: 'number', activeLeases: 'number', failedLeases: 'number' },
  eventTriggers: { pendingEvents: 'number', deliveredEvents: 'number', triggersObserved: 'number' },
  assistantRecovery: { runningRuns: 'number', failedRuns: 'number', unknownRuns: 'number',
    incompleteSteps: 'number', staleRuns: 'number', staleSteps: 'number',
    lastSucceededAt: 'number', lastFailedAt: 'number',
    latestProductionStatus: 'optional-production-status',
    consecutiveProductionFailures: 'optional-number', lastProductionRunAt: 'optional-number',
    bootstrapStatus: 'optional-bootstrap-status', bootstrapFailureCode: 'optional-code',
    bootstrapGeneration: 'optional-number', bootstrapAttestationValid: 'optional-boolean',
    bootstrapAttestationSetDigest: 'optional-digest',
    bootstrapUpdatedAt: 'optional-number' },
  assistantGrowthExperiments: { candidates: 'number', readyCandidates: 'number',
    activeExperiments: 'number', rollbackPending: 'number', promoted: 'number',
    traceRevisions: 'number', currentTraces: 'number', exhaustedRollbacks: 'number',
    lastErrorCode: 'optional-code' },
  pluginControlPlane: { gaps: 'number', readyPlans: 'number', activeActivations: 'number',
    failed: 'number', rollbackPending: 'number' },
  assistantHeartbeat: { active: 'number', paused: 'number', empty: 'number' },
  larkChannel: { state: ['connected', 'connected-with-gap', 'connecting', 'disabled', 'disconnected', 'reconnecting'],
    gapGeneration: 'number' },
}

interface HealthSummary {
  ready: boolean
  severity: HealthSeverity
  assessments: HealthAssessment[]
  warnings: string[]
}

function operationalAssessments(
  provider: ProviderHealth,
  required: boolean,
): Array<{ severity: Exclude<HealthSeverity, 'healthy'>; code: string; blocksReadiness?: true }> {
  if (provider.status !== 'ready') return []
  const metric = (key: string): HealthMetric | undefined => provider.metrics[key]
  const output: Array<{
    severity: Exclude<HealthSeverity, 'healthy'>
    code: string
    blocksReadiness?: true
  }> = []
  const add = (
    condition: boolean,
    severity: Exclude<HealthSeverity, 'healthy'>,
    code: string,
    blocksReadiness = false,
  ) => {
    if (condition) output.push({ severity, code, ...(blocksReadiness ? { blocksReadiness: true as const } : {}) })
  }

  // Assess only current, actionable state. Lifetime ledger counters such as
  // Automations failedRuns/unknownRuns, failedEvaluationAttempts, conflictedProposals,
  // and failedLeases remain observable metrics but cannot prove that the
  // provider is unhealthy now.
  switch (provider.id) {
    case 'assistantPolicy':
      add(metric('emergencyStop') === true, 'unhealthy', 'emergency-stop', true)
      break
    case 'personalWiki':
      add((metric('lintErrors') as number) > 0, 'degraded', 'lint-errors')
      break
    case 'assistantAutomations':
      add((metric('deadLetterEvaluations') as number) > 0, 'degraded', 'evaluation-dead-letter-backlog')
      add((metric('openCircuits') as number | undefined) !== undefined
        && (metric('openCircuits') as number) > 0, 'degraded', 'open-circuit-backlog')
      add((metric('openIncidents') as number | undefined) !== undefined
        && (metric('openIncidents') as number) > 0, 'degraded', 'open-incident-backlog')
      add((metric('pendingIncidentAlerts') as number | undefined) !== undefined
        && (metric('pendingIncidentAlerts') as number) > 0, 'degraded', 'pending-incident-alerts')
      break
    case 'assistantEvaluation':
      add((metric('retryingProjections') as number | undefined) !== undefined
        && (metric('retryingProjections') as number) > 0, 'degraded', 'projection-retry-backlog')
      add((metric('conflictedTaskProjections') as number | undefined) !== undefined
        && (metric('conflictedTaskProjections') as number) > 0,
      'degraded', 'evaluation-task-conflicts')
      break
    case 'assistantRecovery':
      add(metric('latestProductionStatus') === 'failed'
        || metric('latestProductionStatus') === 'unknown',
      'degraded', 'incomplete-recovery')
      // A currently running step is not itself unhealthy. Recovery owns the
      // durable deadline/lease and will surface a terminal unknown/failed run;
      // treating every started step as degraded makes final verification
      // self-referential and permanently masks other provider failures.
      add((metric('staleRuns') as number) > 0 || (metric('staleSteps') as number) > 0,
        'degraded', 'stale-recovery-intent')
      add(metric('bootstrapStatus') === 'running', 'degraded', 'bootstrap-in-progress')
      add(metric('bootstrapStatus') === 'failed', 'unhealthy', 'bootstrap-failed', true)
      add(metric('bootstrapStatus') === 'succeeded'
        && metric('bootstrapAttestationValid') === false,
      'unhealthy', 'bootstrap-attestation-invalid', required)
      break
    case 'assistantGrowthExperiments':
      add((metric('rollbackPending') as number) > 0, 'degraded', 'growth-rollback-pending')
      add((metric('exhaustedRollbacks') as number) > 0,
        'unhealthy', 'growth-rollback-exhausted', required)
      add(metric('lastErrorCode') !== undefined, 'degraded', 'growth-runtime-error')
      break
    case 'pluginControlPlane':
      add((metric('rollbackPending') as number) > 0,
        'unhealthy', 'capability-rollback-pending', required)
      break
    case 'preferenceLearning':
      add(metric('enabled') === false && required, 'unhealthy', 'disabled', true)
      break
    case 'assistantDelivery': {
      // Delivery v9 distinguishes unresolved work from immutable terminal
      // history. Fall back to v8 raw counters during rolling upgrades.
      const actionableUnknown = metric('actionableUnknownOutbox') ?? metric('unknownOutbox')
      const actionableInbox = metric('actionableDeadLetterInbox') ?? metric('deadLetterInbox')
      const actionableOutbox = metric('actionableDeadLetterOutbox') ?? metric('deadLetterOutbox')
      add((actionableUnknown as number) > 0, 'unhealthy', 'unknown-outbox-backlog')
      add((actionableInbox as number) > 0 || (actionableOutbox as number) > 0,
        'degraded', 'dead-letter-backlog')
      add((metric('pendingPresentations') as number | undefined) !== undefined
        && (metric('pendingPresentations') as number) > 0,
      'degraded', 'presentation-backlog')
      add((metric('deadPresentations') as number | undefined) !== undefined
        && (metric('deadPresentations') as number) > 0,
      'unhealthy', 'presentation-dead-letter')
      break
    }
    case 'larkChannel': {
      const state = metric('state')
      add(state === 'connected-with-gap', 'degraded', 'connected-with-gap')
      add(state === 'connecting' || state === 'reconnecting', 'degraded', 'connection-in-progress')
      add(state === 'disconnected', required ? 'unhealthy' : 'degraded', 'disconnected', required)
      add(state === 'disabled' && required, 'unhealthy', 'disabled', true)
      break
    }
    default:
      break
  }
  return output
}

function summarize(providers: readonly ProviderHealth[], required: ReadonlySet<HealthProviderId>): HealthSummary {
  const assessments: HealthAssessment[] = []
  const warnings: string[] = []
  let ready = true
  let severity: HealthSeverity = 'healthy'
  const append = (
    providerId: HealthProviderId,
    level: Exclude<HealthSeverity, 'healthy'>,
    code: string,
    warning: string,
    blocksReadiness = false,
  ) => {
    assessments.push(Object.freeze({ providerId, severity: level, code }))
    warnings.push(warning)
    if (level === 'unhealthy') severity = 'unhealthy'
    else if (severity === 'healthy') severity = 'degraded'
    if (blocksReadiness) ready = false
  }

  for (const provider of providers) {
    const isRequired = required.has(provider.id)
    if (provider.status === 'missing') {
      if (isRequired) append(provider.id, 'unhealthy', 'required-provider-missing',
        `provider-missing:${provider.id}`, true)
      continue
    }
    if (provider.status === 'error') {
      append(provider.id, isRequired ? 'unhealthy' : 'degraded', 'health-seam-error',
        isRequired ? `provider-error:${provider.id}` : `provider-degraded:${provider.id}:health-seam-error`,
        isRequired)
      continue
    }
    for (const assessment of operationalAssessments(provider, isRequired)) {
      append(provider.id, assessment.severity, assessment.code,
        `provider-${assessment.severity}:${provider.id}:${assessment.code}`,
        assessment.blocksReadiness === true)
    }
  }
  return { ready, severity, assessments, warnings }
}

declare module '@deepseek-ai/cordis' {
  interface Context { assistantHealth: AssistantHealthService }
}

function metrics(id: HealthProviderId, value: unknown): Readonly<Record<string, HealthMetric>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid health payload')
  const input = value as Record<string, unknown>
  const output: Record<string, HealthMetric> = {}
  for (const [key, specification] of Object.entries(keys[id])) {
    const current = input[key]
    if ((specification === 'optional-number' || specification === 'optional-boolean'
      || specification === 'optional-production-status'
      || specification === 'optional-bootstrap-status' || specification === 'optional-code'
      || specification === 'optional-digest')
      && current === undefined) continue
    if (specification === 'number' || specification === 'optional-number') {
      if (!Number.isSafeInteger(current) || (current as number) < 0) throw new Error('invalid numeric health metric')
      output[key] = current as number
    } else if (specification === 'optional-production-status') {
      if (typeof current !== 'string'
        || !['none', 'running', 'succeeded', 'failed', 'unknown'].includes(current)) {
        throw new Error('invalid production health status')
      }
      output[key] = current
    } else if (specification === 'optional-bootstrap-status') {
      if (typeof current !== 'string' || !['idle', 'running', 'succeeded', 'failed'].includes(current)) {
        throw new Error('invalid bootstrap health status')
      }
      output[key] = current
    } else if (specification === 'optional-code') {
      if (typeof current !== 'string' || !/^[a-z\d][a-z\d._-]{0,63}$/u.test(current)) {
        throw new Error('invalid health reason code')
      }
      output[key] = current
    } else if (specification === 'optional-digest') {
      if (typeof current !== 'string' || !/^[a-f\d]{64}$/u.test(current)) {
        throw new Error('invalid health digest')
      }
      output[key] = current
    } else if (specification === 'boolean' || specification === 'optional-boolean') {
      if (typeof current !== 'boolean') throw new Error('invalid boolean health metric')
      output[key] = current
    } else {
      if (typeof current !== 'string' || !specification.includes(current)) throw new Error('invalid status health metric')
      output[key] = current
    }
  }
  if (id === 'assistantEvolution') {
    const projectionKeys = [
      'qualityEligibleEpisodes', 'operationalEpisodes', 'legacyQuarantinedEpisodes',
      'unattributedQualityEligibleEpisodes', 'lastQualityEligibleEpisodeAt',
    ] as const
    const projectionCount = projectionKeys.filter(key => output[key] !== undefined).length
    if (projectionCount !== 0 && projectionCount !== projectionKeys.length) {
      throw new Error('incomplete Evolution quality-evidence projection')
    }
  }
  if (id === 'assistantEvaluation') {
    const taskKeys = ['taskProjections', 'conflictedTaskProjections'] as const
    const taskCount = taskKeys.filter(key => output[key] !== undefined).length
    if (taskCount !== 0 && taskCount !== taskKeys.length) {
      throw new Error('incomplete Evaluation task projection health')
    }
    if (taskCount === taskKeys.length
      && (output.conflictedTaskProjections as number) > (output.taskProjections as number)) {
      throw new Error('inconsistent Evaluation task projection health')
    }
    const projectionKeys = ['pendingProjections', 'retryingProjections', 'projectionAttempts'] as const
    const projectionCount = projectionKeys.filter(key => output[key] !== undefined).length
    if (projectionCount !== 0 && projectionCount !== projectionKeys.length) {
      throw new Error('incomplete Evaluation projection health')
    }
    if (output.oldestPendingProjectionAt !== undefined
      && (projectionCount === 0 || output.pendingProjections === 0)) {
      throw new Error('inconsistent Evaluation oldest projection health')
    }
    if (projectionCount === projectionKeys.length
      && ((output.retryingProjections as number) > (output.pendingProjections as number)
        || (output.projectionAttempts as number) < (output.retryingProjections as number))) {
      throw new Error('inconsistent Evaluation projection health')
    }
  }
  if (id === 'assistantAutomations') {
    // openCircuits shipped one version earlier and remains independently
    // optional. The later incident/alert projection is atomic: accepting a
    // partial pair would make N and N-1 indistinguishable.
    const projectionKeys = ['openIncidents', 'pendingIncidentAlerts'] as const
    const projectionCount = projectionKeys.filter(key => output[key] !== undefined).length
    if (projectionCount !== 0 && projectionCount !== projectionKeys.length) {
      throw new Error('incomplete Automations incident projection')
    }
  }
  if (id === 'assistantDelivery') {
    const projectionKeys = [
      'actionableDeadLetterInbox', 'resolvedDeadLetterInbox',
      'actionableDeadLetterOutbox', 'resolvedDeadLetterOutbox',
      'actionableUnknownOutbox', 'resolvedUnknownOutbox',
    ] as const
    const projectionCount = projectionKeys.filter(key => output[key] !== undefined).length
    if (projectionCount !== 0 && projectionCount !== projectionKeys.length) {
      throw new Error('incomplete Delivery resolution projection')
    }
    if (projectionCount === projectionKeys.length) {
      const partitions = [
        ['deadLetterInbox', 'actionableDeadLetterInbox', 'resolvedDeadLetterInbox'],
        ['deadLetterOutbox', 'actionableDeadLetterOutbox', 'resolvedDeadLetterOutbox'],
        ['unknownOutbox', 'actionableUnknownOutbox', 'resolvedUnknownOutbox'],
      ] as const
      for (const [total, actionable, resolved] of partitions) {
        if ((output[actionable] as number) + (output[resolved] as number) !== output[total]) {
          throw new Error('inconsistent Delivery resolution projection')
        }
      }
    }
    const presentationKeys = ['pendingPresentations', 'deadPresentations'] as const
    const presentationCount = presentationKeys.filter(key => output[key] !== undefined).length
    if (presentationCount !== 0 && presentationCount !== presentationKeys.length) {
      throw new Error('incomplete Delivery presentation projection')
    }
  }
  if (id === 'assistantRecovery') {
    const projectionKeys = [
      'latestProductionStatus', 'consecutiveProductionFailures', 'lastProductionRunAt',
    ] as const
    const projectionCount = projectionKeys.filter(key => output[key] !== undefined).length
    if (projectionCount !== 0 && projectionCount !== projectionKeys.length) {
      throw new Error('incomplete Recovery production projection')
    }
    const bootstrapStatus = output.bootstrapStatus
    const bootstrapUpdatedAt = output.bootstrapUpdatedAt
    const bootstrapFailureCode = output.bootstrapFailureCode
    if ((bootstrapStatus === undefined) !== (bootstrapUpdatedAt === undefined)
      || (bootstrapStatus === 'failed') !== (bootstrapFailureCode !== undefined)) {
      throw new Error('incomplete Recovery bootstrap projection')
    }
    const attestationInputKeys = [
      'bootstrapGeneration', 'bootstrapAttestationValid',
      'bootstrapAttestationSetDigest', 'bootstrapAttestations',
    ] as const
    const attestationInputCount = attestationInputKeys.filter(key => input[key] !== undefined).length
    if (attestationInputCount !== 0 && attestationInputCount !== attestationInputKeys.length) {
      throw new Error('incomplete Recovery bootstrap attestation projection')
    }
    if (attestationInputCount === attestationInputKeys.length) {
      const attestations = input.bootstrapAttestations
      if (!Array.isArray(attestations) || attestations.length > 1_000
        || attestations.some((attestation) => {
          if (typeof attestation !== 'object' || attestation === null || Array.isArray(attestation)) return true
          const value = attestation as Record<string, unknown>
          return Object.keys(value).sort().join(',')
              !== 'activationNonce,activationPlanDigest,activationState,automationId'
            || typeof value.automationId !== 'string'
            || typeof value.activationNonce !== 'string'
            || !['active', 'paused', 'preview'].includes(String(value.activationState))
            || typeof value.activationPlanDigest !== 'string'
            || !/^[a-f\d]{64}$/u.test(value.activationPlanDigest)
        })) {
        throw new Error('invalid Recovery bootstrap attestations')
      }
    }
  }
  return Object.freeze(output)
}

export class AssistantHealthService extends Service {
  static Config = configSchema
  private readonly context: Context
  private readonly policy: AssistantPolicyService
  private readonly required: ReadonlySet<HealthProviderId>
  private readonly now: () => number
  private active = true

  constructor(ctx: Context, input: Config = {}, options: { now?: () => number } = {}) {
    super(ctx, 'assistantHealth')
    let config: Required<Config>
    try { config = configSchema(input) as Required<Config> } catch (error) {
      throw new Error(`assistant-health: invalid configuration: ${String(error)}`, { cause: error })
    }
    if (new Set(config.requiredProviders).size !== config.requiredProviders.length) {
      throw new Error('assistant-health: requiredProviders contains a duplicate')
    }
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    if (policy === undefined) throw new Error('assistant-health: assistantPolicy service is required')
    this.context = ctx
    this.policy = policy
    this.required = new Set(config.requiredProviders)
    this.now = options.now ?? Date.now
    ctx.inject(['tools'], toolsCtx => registerAssistantHealthTool(toolsCtx, this))
    ctx.effect(() => () => { this.active = false }, 'assistant-health.runtime')
  }

  liveness(): { alive: true } {
    this.assertActive()
    return { alive: true }
  }

  readiness(): { ready: boolean; warnings: string[] } {
    this.assertActive()
    const providers = this.collect()
    const summary = summarize(providers, this.required)
    return { ready: summary.ready, warnings: summary.warnings }
  }

  report(agent: Agent | undefined): AssistantHealthReport {
    this.assertActive()
    const decision = this.policy.authorizeAgent(agent, 'inspect', { kind: 'tool', id: 'assistant-health' })
    if (decision.effect !== 'allow') {
      throw new AssistantHealthError('policy-denied', `assistant-health policy denied report: ${decision.reasonCode}`)
    }
    return this.snapshot()
  }

  /**
   * Agent-free, content-free global snapshot for runbook admission and alerts.
   * It is deliberately unscoped and cannot prove a workspace-local mutation.
   * This remains detect-only: it does not expose or invoke any repair method.
   */
  hostGlobalSnapshot(input: HealthHostGlobalOperation): AssistantHealthReport {
    this.assertActive()
    if (typeof input !== 'object' || input === null || Array.isArray(input)
      || Object.keys(input).sort().join(',') !== 'operationId,principal') {
      throw new AssistantHealthError(
        'invalid-input',
        'Host global health input accepts only principal and operationId',
      )
    }
    const principal = hostText(input.principal, 'principal', 500, 'missing-principal')
    const operationId = hostText(input.operationId, 'operationId', 500)
    const digest = createHash('sha256').update(JSON.stringify([
      HOST_RECOVERY_BACKGROUND_ID,
      principal,
      operationId,
    ])).digest('hex')
    const decision = this.policy.authorize({
      subject: {
        kind: 'background',
        id: HOST_RECOVERY_BACKGROUND_ID,
        principal,
      },
      action: 'inspect',
      resource: { kind: 'tool', id: 'assistant-health:global' },
      context: { initiator: 'background' },
    }, { idempotencyKey: `assistant-health-host:${digest}` })
    if (decision.effect !== 'allow') {
      throw new AssistantHealthError(
        'policy-denied',
        `assistant-health policy denied Host global snapshot: ${decision.reasonCode}`,
      )
    }
    return this.snapshot()
  }

  private snapshot(): AssistantHealthReport {
    const providers = this.collect()
    const summary = summarize(providers, this.required)
    return Object.freeze({
      ready: summary.ready,
      severity: summary.severity,
      generatedAt: this.now(),
      providers: Object.freeze(providers),
      assessments: Object.freeze(summary.assessments),
      warnings: Object.freeze(summary.warnings),
    })
  }

  private collect(): ProviderHealth[] {
    const get = (this.context as unknown as { get(name: string): unknown }).get.bind(this.context)
    return providerIds.map(id => {
      const provider = get(providerServiceNames[id]) as { health?: () => unknown } | undefined
      if (provider === undefined) return Object.freeze({ id, status: 'missing' as const, metrics: Object.freeze({}) })
      if (typeof provider.health !== 'function') return Object.freeze({ id, status: 'error' as const, metrics: Object.freeze({}) })
      try {
        return Object.freeze({ id, status: 'ready' as const, metrics: metrics(id, provider.health()) })
      } catch {
        return Object.freeze({ id, status: 'error' as const, metrics: Object.freeze({}) })
      }
    })
  }

  private assertActive(): void {
    if (!this.active) throw new AssistantHealthError('disposed', 'assistant-health service is disposed')
  }
}

export const Config = configSchema
