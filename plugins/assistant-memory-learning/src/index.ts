import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@dsh-enhanced/personal-memory'
import { Config, validateLearningConfig } from './config.js'
import { MemoryLearningRuntime } from './runtime.js'
import { runNativeMemoryExtraction } from './extractor.js'
import type { LearningConfig } from './types.js'
import { version } from './version.js'

declare module '@deepseek-ai/cordis' {
  interface Context { assistantMemoryLearning: AssistantMemoryLearningService }
}
export const name = 'dsh-enhanced-assistant-memory-learning'
export { Config, version, validateLearningConfig }
export type { LearningConfig } from './types.js'
export class AssistantMemoryLearningService extends Service {
  static inject = ['assistantDelivery', 'assistantEvaluation', 'assistantAutomations', 'personalMemory',
    'assistantVerifier', 'assistantPolicy', 'agents', 'sessions', 'tools', 'llm', 'systemPrompt']
  static Config = Config
  private runtime: MemoryLearningRuntime | undefined
  constructor(ctx: Context, input: LearningConfig) {
    const config = validateLearningConfig(input)
    super(ctx, 'assistantMemoryLearning')
    ctx.effect(() => {
      const runtime = new MemoryLearningRuntime(config, { delivery: ctx.assistantDelivery, evaluation: ctx.assistantEvaluation,
        automations: ctx.assistantAutomations, memory: ctx.personalMemory, verifier: ctx.assistantVerifier,
        policy: ctx.assistantPolicy, extract: request => runNativeMemoryExtraction(ctx, request) })
      runtime.start(); this.runtime = runtime
      return async () => { this.runtime = undefined; await runtime.close() }
    }, 'assistant-memory-learning.runtime')
  }
  health() {
    if (!this.runtime) throw new Error('assistant-memory-learning: unavailable')
    return this.runtime.health()
  }
}
export function apply(ctx: Context, config: LearningConfig): void { new AssistantMemoryLearningService(ctx, config) }
export default { name, Config, inject: AssistantMemoryLearningService.inject, apply, version }
