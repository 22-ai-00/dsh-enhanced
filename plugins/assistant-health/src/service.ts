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
  'assistantHeartbeat',
  'larkChannel',
] as const

export type HealthProviderId = typeof providerIds[number]
export type HealthMetric = boolean | number | string
export type HealthSeverity = 'healthy' | 'degraded' | 'unhealthy'

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

export type AssistantHealthErrorCode = 'disposed' | 'policy-denied'
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

type HealthMetricSpecification = 'boolean' | 'number' | 'optional-number' | readonly string[]

const keys: Record<HealthProviderId, Readonly<Record<string, HealthMetricSpecification>>> = {
  assistantPolicy: { emergencyStop: 'boolean', lastAuditSequence: 'number' },
  personalMemory: { activeRecords: 'number', removedRecords: 'number', expiredRecords: 'number', pendingProposals: 'number' },
  personalWiki: { pages: 'number', lintErrors: 'number', lintWarnings: 'number', pendingProposals: 'number' },
  assistantAutomations: { activeAutomations: 'number', pausedAutomations: 'number', pendingTasks: 'number',
    runningTasks: 'number', failedRuns: 'number', unknownRuns: 'number', pendingEvaluations: 'number',
    retryingEvaluations: 'number', failedEvaluationAttempts: 'number', deadLetterEvaluations: 'number',
    oldestPendingEvaluationAt: 'number' },
  assistantEvaluation: { ready: 'boolean', schemaVersion: 'number', outcomes: 'number',
    trustedOutcomes: 'number', selfReportedOutcomes: 'number', externalOutcomes: 'number',
    selfAssessments: 'number', latestOccurredAt: 'optional-number' },
  preferenceLearning: { ready: 'boolean', enabled: 'boolean', schemaVersion: 'number', signals: 'number',
    hypotheses: 'number', active: 'number', shadow: 'number', proposed: 'number',
    rolledBack: 'number', expired: 'number', lastRecordedAt: 'optional-number' },
  assistantEvolution: { activeRules: 'number', retiredRules: 'number', pendingProposals: 'number',
    conflictedProposals: 'number', trustedEpisodes: 'number', unattributedTrustedEpisodes: 'number',
    lastTrustedEpisodeAt: 'number', lastReconciledAt: 'number', autonomousRollbacks: 'number' },
  assistantDelivery: { pendingInbox: 'number', deadLetterInbox: 'number', pendingOutbox: 'number',
    deadLetterOutbox: 'number', unknownOutbox: 'number', adapters: 'number' },
  credentialsKeychain: { handles: 'number', activeLeases: 'number', failedLeases: 'number' },
  eventTriggers: { pendingEvents: 'number', deliveredEvents: 'number', triggersObserved: 'number' },
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
  // failedRuns, unknownRuns, failedEvaluationAttempts, conflictedProposals,
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
      break
    case 'preferenceLearning':
      add(metric('enabled') === false && required, 'unhealthy', 'disabled', true)
      break
    case 'assistantDelivery':
      add((metric('unknownOutbox') as number) > 0, 'unhealthy', 'unknown-outbox-backlog')
      add((metric('deadLetterInbox') as number) > 0 || (metric('deadLetterOutbox') as number) > 0,
        'degraded', 'dead-letter-backlog')
      break
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
    if (specification === 'optional-number' && current === undefined) continue
    if (specification === 'number' || specification === 'optional-number') {
      if (!Number.isSafeInteger(current) || (current as number) < 0) throw new Error('invalid numeric health metric')
      output[key] = current as number
    } else if (specification === 'boolean') {
      if (typeof current !== 'boolean') throw new Error('invalid boolean health metric')
      output[key] = current
    } else {
      if (typeof current !== 'string' || !specification.includes(current)) throw new Error('invalid status health metric')
      output[key] = current
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
      const provider = get(id) as { health?: () => unknown } | undefined
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
