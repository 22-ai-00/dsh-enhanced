import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { GoalBudgetMeter } from '@dsh-enhanced/assistant-goals'
import { SuperRelayGoalMeteredAdapter } from './adapter.js'
import type { SuperRelayAdapterDependencies, SuperRelayCredentialResolver } from './adapter.js'
import { Config, normalizeConfig } from './config.js'
import type { SuperRelayGoalMeteredConfig } from './config.js'
import { assertCurrentContract, isSuperRelayModel, SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND, SUPER_RELAY_MODELS, SUPER_RELAY_PROVIDER, SUPER_RELAY_RESPONSES_CONTRACT } from './contract.js'
import type { SuperRelayModel } from './contract.js'
import { version } from './version.js'

export const name = 'dsh-enhanced-assistant-super-relay-budget'
export const inject = ['llm', 'assistantGoals']
export {
  Config,
  normalizeConfig,
  SuperRelayGoalMeteredAdapter,
  SUPER_RELAY_PROVIDER,
  SUPER_RELAY_MODELS,
  SUPER_RELAY_RESPONSES_CONTRACT,
  SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND,
  assertCurrentContract,
  isSuperRelayModel,
  version,
}
export type {
  SuperRelayGoalMeteredConfig,
  SuperRelayAdapterDependencies,
  SuperRelayCredentialResolver,
  SuperRelayModel,
}

function meter(model: SuperRelayModel): GoalBudgetMeter {
  return Object.freeze({
    id: `super-relay-goal-metered:${model}:v1`, provider: SUPER_RELAY_PROVIDER, model,
    inputTokenUpperBound(options: GenerateOptions) {
      assertCurrentContract()
      if (options.provider !== SUPER_RELAY_PROVIDER || options.model !== model || !Number.isSafeInteger(options.maxTokens) || options.maxTokens! < 1 || options.maxTokens! > 32_768) {
        throw new Error('assistant-super-relay-budget: meter received an invalid route or maxTokens')
      }
      return SUPER_RELAY_INPUT_TOKEN_UPPER_BOUND
    },
    // The gateway publishes no tariff; report null rather than invent a price.
    inputUsdMicrosPerMillionTokens: null, outputUsdMicrosPerMillionTokens: null,
  })
}

export function apply(ctx: Context, input?: SuperRelayGoalMeteredConfig): void {
  const config = normalizeConfig(input)
  if (!config.enabled) return
  assertCurrentContract()
  const adapter = new SuperRelayGoalMeteredAdapter(config, { credentialResolver: () => ctx.get('credentials') as SuperRelayCredentialResolver | undefined })
  const releases: Array<() => void> = []
  try {
    for (const modelId of SUPER_RELAY_MODELS) releases.push(ctx.assistantGoals.registerBudgetMeter(meter(modelId)))
    const unregisterAdapter = ctx.llm.registerAdapter([SUPER_RELAY_PROVIDER], adapter)
    ctx.effect(() => () => {
      unregisterAdapter()
      for (const release of releases.splice(0).reverse()) release()
      adapter.shutdown()
    }, 'dsh-enhanced-assistant-super-relay-budget.lifecycle')
  } catch (error) {
    for (const release of releases.reverse()) release()
    adapter.shutdown()
    throw error
  }
}

export default { name, Config, inject, apply }
