/** Host-only strategy benchmark building blocks; no model-visible tools are registered. */
import type { Context } from '@deepseek-ai/cordis'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { NativeAdapterBinding, NativeModelConfig } from './native.js'
import type { BenchmarkExecutionRequest } from './runner.js'
import { installStrategyBenchmarkMeter } from './strategy-meter.js'
import { strategyBenchmarkRequestLimits, type StrategyBenchmarkPlan } from './strategy-plan.js'

export * from './strategy-plan.js'
export * from './strategy-meter.js'
export * from './strategy-owner.js'
export * from './strategy-goal-runtime.js'
export * from './strategy-evidence.js'

/** Request identity and call/output budgets are checked before installing the cell meter. */
export function installStrategyBenchmarkRequestMeter(ctx: Context, plan: StrategyBenchmarkPlan,
  request: BenchmarkExecutionRequest, model: Readonly<NativeModelConfig>, binding: Readonly<NativeAdapterBinding>) {
  const limits = strategyBenchmarkRequestLimits(plan, request)
  if (acceptanceDigest(model) !== request.variant.versions.model) throw new Error('strategy benchmark model configuration drift')
  return installStrategyBenchmarkMeter(ctx, { budget: request.budget, modelCalls: limits.modelCalls,
    maxOutputTokens: limits.maxOutputTokensPerCall, model, binding, signal: request.signal })
}
