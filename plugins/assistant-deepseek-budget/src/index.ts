import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { GoalBudgetMeter } from '@dsh-enhanced/assistant-goals'
import { DeepSeekGoalMeteredAdapter, type DeepSeekCredentialResolver } from './adapter.js'
import { Config, normalizeConfig, type DeepSeekGoalMeteredConfig } from './config.js'
import { assertCurrentContract, DEEPSEEK_INPUT_TOKEN_UPPER_BOUND, DEEPSEEK_MODELS, DEEPSEEK_PROVIDER } from './contract.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-deepseek-budget'
export const inject = ['llm', 'assistantGoals']
export { Config, DeepSeekGoalMeteredAdapter, DEEPSEEK_INPUT_TOKEN_UPPER_BOUND, DEEPSEEK_MODELS, DEEPSEEK_PROVIDER, version }
export { DEEPSEEK_CHAT_COMPLETIONS_CONTRACT } from './contract.js'
export type { DeepSeekGoalMeteredConfig }

function meter(model: typeof DEEPSEEK_MODELS[number]): GoalBudgetMeter {
  return Object.freeze({
    id: `deepseek-goal-metered:${model}:v1`, provider: DEEPSEEK_PROVIDER, model,
    inputTokenUpperBound(options: GenerateOptions) {
      assertCurrentContract()
      if (options.provider !== DEEPSEEK_PROVIDER || options.model !== model || !Number.isSafeInteger(options.maxTokens) || options.maxTokens! < 1 || options.maxTokens! > 32_768) {
        throw new Error('assistant-deepseek-budget: meter received an invalid route or maxTokens')
      }
      return DEEPSEEK_INPUT_TOKEN_UPPER_BOUND
    },
    inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null,
  })
}

export function apply(ctx: Context, input?: DeepSeekGoalMeteredConfig): void {
  const config = normalizeConfig(input)
  if (!config.enabled) return
  assertCurrentContract()
  const adapter = new DeepSeekGoalMeteredAdapter(config, { credentialResolver: () => ctx.get('credentials') as DeepSeekCredentialResolver | undefined })
  const releases: Array<() => void> = []
  try {
    for (const modelId of DEEPSEEK_MODELS) releases.push(ctx.assistantGoals.registerBudgetMeter(meter(modelId)))
    const unregisterAdapter = ctx.llm.registerAdapter([DEEPSEEK_PROVIDER], adapter)
    ctx.effect(() => () => {
      unregisterAdapter()
      for (const release of releases.splice(0).reverse()) release()
      adapter.shutdown()
    }, 'dsh-enhanced-assistant-deepseek-budget.lifecycle')
  } catch (error) {
    for (const release of releases.reverse()) release()
    adapter.shutdown()
    throw error
  }
}

export default { name, Config, inject, apply }
