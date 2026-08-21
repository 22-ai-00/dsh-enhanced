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
  'assistantDelivery',
  'credentialsKeychain',
  'eventTriggers',
  'assistantHeartbeat',
  'larkChannel',
] as const

export type HealthProviderId = typeof providerIds[number]
export type HealthMetric = boolean | number | string

export interface Config {
  requiredProviders?: HealthProviderId[]
}

export interface ProviderHealth {
  id: HealthProviderId
  status: 'error' | 'missing' | 'ready'
  metrics: Readonly<Record<string, HealthMetric>>
}

export interface AssistantHealthReport {
  ready: boolean
  generatedAt: number
  providers: readonly ProviderHealth[]
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

const keys: Record<HealthProviderId, Readonly<Record<string, 'boolean' | 'number' | readonly string[]>>> = {
  assistantPolicy: { emergencyStop: 'boolean', lastAuditSequence: 'number' },
  personalMemory: { activeRecords: 'number', removedRecords: 'number', expiredRecords: 'number', pendingProposals: 'number' },
  personalWiki: { pages: 'number', lintErrors: 'number', lintWarnings: 'number', pendingProposals: 'number' },
  assistantAutomations: { activeAutomations: 'number', pausedAutomations: 'number', pendingTasks: 'number',
    runningTasks: 'number', failedRuns: 'number', unknownRuns: 'number' },
  assistantDelivery: { pendingInbox: 'number', deadLetterInbox: 'number', pendingOutbox: 'number',
    deadLetterOutbox: 'number', unknownOutbox: 'number', adapters: 'number' },
  credentialsKeychain: { handles: 'number', activeLeases: 'number', failedLeases: 'number' },
  eventTriggers: { pendingEvents: 'number', deliveredEvents: 'number', triggersObserved: 'number' },
  assistantHeartbeat: { active: 'number', paused: 'number', empty: 'number' },
  larkChannel: { state: ['connected', 'connected-with-gap', 'connecting', 'disabled', 'disconnected', 'reconnecting'],
    gapGeneration: 'number' },
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
    if (specification === 'number') {
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
    const warnings = providers
      .filter(item => this.required.has(item.id) && item.status !== 'ready')
      .map(item => `provider-${item.status}:${item.id}`)
    return { ready: warnings.length === 0, warnings }
  }

  report(agent: Agent | undefined): AssistantHealthReport {
    this.assertActive()
    const decision = this.policy.authorizeAgent(agent, 'inspect', { kind: 'tool', id: 'assistant-health' })
    if (decision.effect !== 'allow') {
      throw new AssistantHealthError('policy-denied', `assistant-health policy denied report: ${decision.reasonCode}`)
    }
    const providers = this.collect()
    const warnings = providers
      .filter(item => this.required.has(item.id) && item.status !== 'ready')
      .map(item => `provider-${item.status}:${item.id}`)
    return Object.freeze({
      ready: warnings.length === 0,
      generatedAt: this.now(),
      providers: Object.freeze(providers),
      warnings: Object.freeze(warnings) as unknown as string[],
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
