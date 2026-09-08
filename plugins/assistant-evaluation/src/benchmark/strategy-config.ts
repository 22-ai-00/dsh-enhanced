/** Strict, side-effect-free operator configuration for strategy-v1. */
import type { NativeModelConfig } from './native.js'
import { isAbsolute, relative } from 'node:path'
import { strategyDevelopmentCases, strategyDevelopmentTask } from './strategy-corpus.js'
import { benchmarkAssert, benchmarkInteger, benchmarkObject, benchmarkSnapshot } from './schema.js'
import type { BenchmarkBudget } from './types.js'

export interface StrategyBenchmarkConfig {
  suite: 'strategy-v1'
  id: string
  cases: readonly string[]
  persona: string
  model: NativeModelConfig
  budget: BenchmarkBudget
  execution: { modelCalls: number; maxOutputTokensPerCall: number; maxGoalRounds: number }
  repeats: number
  seed: number
  image: string
  dockerPath: string
  stepMaxDurationMs: number
  stopTimeoutMs?: number
  workspaceDirectory: string
  stateDirectory: string
}

const MAX_RATE = 1_000_000_000
const routeId = (value: unknown, field: string): void => benchmarkAssert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value), `invalid ${field}`)
const identifier = (value: unknown, field: string): void => benchmarkAssert(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value), `invalid ${field}`)
const digest = (value: unknown, field: string): void => benchmarkAssert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value), `invalid ${field}`)
const rate = (value: unknown): void => benchmarkInteger(value, 0, MAX_RATE)
const absolute = (value: unknown, field: string): void => benchmarkAssert(typeof value === 'string' && isAbsolute(value) && value.length <= 4096 && !value.includes('\u0000'), `invalid ${field}`)
const contains = (ancestor: string, descendant: string): boolean => {
  const path = relative(ancestor, descendant)
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path))
}

export function parseStrategyBenchmarkConfig(value: unknown): Readonly<StrategyBenchmarkConfig> {
  const copy = benchmarkSnapshot(value)
  const raw = benchmarkObject(copy, ['suite', 'id', 'cases', 'persona', 'model', 'budget', 'execution', 'repeats', 'seed', 'image', 'dockerPath', 'stepMaxDurationMs', 'workspaceDirectory', 'stateDirectory',
    ...((copy !== null && typeof copy === 'object' && Object.hasOwn(copy, 'stopTimeoutMs')) ? ['stopTimeoutMs'] : [])])
  benchmarkAssert(raw.suite === 'strategy-v1', 'unsupported strategy suite')
  identifier(raw.id, 'strategy benchmark id')
  benchmarkAssert(typeof raw.persona === 'string' && raw.persona.trim().length > 0 && raw.persona.length <= 32_768, 'invalid strategy persona')
  benchmarkAssert(Array.isArray(raw.cases) && raw.cases.length >= 1 && raw.cases.length <= 100, 'invalid strategy cases')
  const known = new Set(strategyDevelopmentCases().map(task => task.id)); const selected = new Set<string>()
  for (const caseId of raw.cases) { identifier(caseId, 'strategy case id'); benchmarkAssert(known.has(caseId) && !selected.has(caseId), 'cases must be unique strategy development cases'); selected.add(caseId) }

  const budget = benchmarkObject(raw.budget, ['durationMs', 'inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls']) as unknown as BenchmarkBudget
  benchmarkInteger(budget.durationMs, 1, 86_400_000)
  for (const field of ['inputTokens', 'outputTokens', 'toolCalls'] as const) benchmarkInteger(budget[field], 0, 1_000_000_000)
  if (budget.costUsdMicros !== null) benchmarkInteger(budget.costUsdMicros, 0, MAX_RATE)

  const model = benchmarkObject(raw.model, ['provider', 'model', 'temperature', 'maxOutputTokens', 'inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens', 'adapterDigest', 'tokenCounterDigest',
    ...((raw.model !== null && typeof raw.model === 'object' && Object.hasOwn(raw.model, 'inputLimitMode')) ? ['inputLimitMode'] : []),
    ...((raw.model !== null && typeof raw.model === 'object' && Object.hasOwn(raw.model, 'outputLimitMode')) ? ['outputLimitMode'] : []),
    ...((raw.model !== null && typeof raw.model === 'object' && Object.hasOwn(raw.model, 'cacheReadUsdMicrosPerMillionTokens')) ? ['cacheReadUsdMicrosPerMillionTokens'] : []),
    ...((raw.model !== null && typeof raw.model === 'object' && Object.hasOwn(raw.model, 'cacheWriteUsdMicrosPerMillionTokens')) ? ['cacheWriteUsdMicrosPerMillionTokens'] : []),
  ]) as unknown as NativeModelConfig
  routeId(model.provider, 'provider'); routeId(model.model, 'model')
  benchmarkAssert(model.temperature === null || typeof model.temperature === 'number' && Number.isFinite(model.temperature) && model.temperature >= 0 && model.temperature <= 2, 'invalid temperature')
  benchmarkAssert((model.inputLimitMode ?? 'upper-bound') === 'upper-bound' && (model.outputLimitMode ?? 'provider') === 'provider', 'strategy requires upper-bound input and provider output limits')
  benchmarkInteger(model.maxOutputTokens, 1, budget.outputTokens)
  benchmarkAssert((model.inputUsdMicrosPerMillionTokens === null) === (model.outputUsdMicrosPerMillionTokens === null), 'both token rates must be present or absent')
  if (model.inputUsdMicrosPerMillionTokens !== null) { rate(model.inputUsdMicrosPerMillionTokens); rate(model.outputUsdMicrosPerMillionTokens) }
  for (const field of ['cacheReadUsdMicrosPerMillionTokens', 'cacheWriteUsdMicrosPerMillionTokens'] as const) if (model[field] !== undefined && model[field] !== null) rate(model[field])
  digest(model.adapterDigest, 'adapter digest'); digest(model.tokenCounterDigest, 'token counter digest')
  if (budget.costUsdMicros !== null) benchmarkAssert([model.inputUsdMicrosPerMillionTokens, model.outputUsdMicrosPerMillionTokens, model.cacheReadUsdMicrosPerMillionTokens, model.cacheWriteUsdMicrosPerMillionTokens].every(value => value !== null && value !== undefined), 'priced budget requires complete tariff')

  const execution = benchmarkObject(raw.execution, ['modelCalls', 'maxOutputTokensPerCall', 'maxGoalRounds']) as StrategyBenchmarkConfig['execution']
  benchmarkInteger(execution.modelCalls, 1, 10_000); benchmarkInteger(execution.maxOutputTokensPerCall, 1, budget.outputTokens); benchmarkInteger(execution.maxGoalRounds, 1, 32)
  benchmarkAssert(model.maxOutputTokens === execution.maxOutputTokensPerCall, 'model output limit must equal strategy execution limit')
  benchmarkInteger(raw.repeats, 2, 20); benchmarkInteger(raw.seed, 0, 0xffffffff)
  benchmarkAssert(typeof raw.image === 'string' && /^sha256:[a-f0-9]{64}$/u.test(raw.image), 'invalid immutable image')
  absolute(raw.dockerPath, 'docker path'); absolute(raw.workspaceDirectory, 'workspace directory'); absolute(raw.stateDirectory, 'state directory')
  benchmarkAssert(!contains(raw.workspaceDirectory as string, raw.stateDirectory as string) && !contains(raw.stateDirectory as string, raw.workspaceDirectory as string), 'strategy state and workspaces must be separate')
  benchmarkInteger(raw.stepMaxDurationMs, 1_000, 300_000)
  benchmarkAssert((raw.stepMaxDurationMs as number) * 3 < budget.durationMs, 'strategy step duration does not fit benchmark duration')
  for (const caseId of selected) {
    const verification = strategyDevelopmentTask(caseId).verification
    benchmarkAssert(verification.maxDurationMs * verification.cases.length < (raw.stepMaxDurationMs as number), 'strategy verification does not fit execution window')
  }
  if (raw.stopTimeoutMs !== undefined) benchmarkInteger(raw.stopTimeoutMs, 1_000, 30_000)
  return copy as StrategyBenchmarkConfig
}
