import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@dsh-enhanced/personal-memory'
import { Config, DEFAULT_LEARNING_OPERATIONAL_CONFIG, parseLearningServiceConfig, validateLearningConfig } from './config.js'
import { MemoryLearningRuntime } from './runtime.js'
import { runNativeMemoryExtraction } from './extractor.js'
import type { DormantLearningServiceConfig, LearningServiceConfig, LearningState } from './types.js'
import { version } from './version.js'

declare module '@deepseek-ai/cordis' {
  interface Context { assistantMemoryLearning: AssistantMemoryLearningService }
}
const ZERO_COUNTS: Readonly<Record<LearningState, number>> = Object.freeze({
  pending: 0,
  queued: 0,
  running: 0,
  unknown: 0,
  adopted: 0,
  rejected: 0,
  noop: 0,
  failed: 0,
  superseded: 0,
})
function isDormantConfig(value: unknown): value is DormantLearningServiceConfig {
  return value !== null && typeof value === 'object' && 'configured' in value && (value as { configured?: unknown }).configured === false
}
export const name = 'dsh-enhanced-assistant-memory-learning'
export { Config, DEFAULT_LEARNING_OPERATIONAL_CONFIG, version, validateLearningConfig }
export type { DormantLearningServiceConfig, LearningConfig, LearningConfigInput, LearningServiceConfig } from './types.js'
export class AssistantMemoryLearningService extends Service {
  static inject = ['assistantDelivery', 'assistantEvaluation', 'assistantAutomations', 'personalMemory',
    'assistantVerifier', 'assistantPolicy', 'agents', 'sessions', 'tools', 'llm', 'systemPrompt']
  static Config = Config
  private runtime: MemoryLearningRuntime | undefined
  private readonly enabled: boolean
  private readonly configured: boolean
  constructor(ctx: Context, input: LearningServiceConfig = {}) {
    const parsed = parseLearningServiceConfig(input)
    super(ctx, 'assistantMemoryLearning')
    if (isDormantConfig(parsed)) {
      this.enabled = parsed.enabled
      this.configured = false
      return
    }
    if ('enabled' in parsed && parsed.enabled === false) {
      this.enabled = false
      this.configured = true
      return
    }
    const config = validateLearningConfig(parsed)
    this.enabled = true
    this.configured = true
    ctx.effect(() => {
      const runtime = new MemoryLearningRuntime(config, { delivery: ctx.assistantDelivery, evaluation: ctx.assistantEvaluation,
        automations: ctx.assistantAutomations, memory: ctx.personalMemory, verifier: ctx.assistantVerifier,
        policy: ctx.assistantPolicy, extract: request => runNativeMemoryExtraction(ctx, request) })
      runtime.start(); this.runtime = runtime
      return async () => { this.runtime = undefined; await runtime.close() }
    }, 'assistant-memory-learning.runtime')
  }
  health() {
    if (!this.runtime) {
      return {
        enabled: this.enabled,
        configured: this.configured,
        connected: false,
        lastScanAt: null,
        lastError: null,
        counts: { ...ZERO_COUNTS },
        remainingExtractions: 0,
        available: false,
      }
    }
    return {
      configured: true,
      ...this.runtime.health(),
    }
  }
}
export function apply(ctx: Context, config: LearningServiceConfig = {}): void { new AssistantMemoryLearningService(ctx, config) }
export default { name, Config, inject: AssistantMemoryLearningService.inject, apply, version }
