/** Native, intentionally narrow AgentLoop adapter for the public development corpus. */
import { createRequire } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { LlmAdapter, LlmRuntime, createUserMessage, isAgentLoopRequest, type GenerateOptions, type TokenUsage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { developmentCases, developmentDataset, developmentPrompt, judgeDevelopmentResponse } from './corpus.js'
import { type BenchmarkExecutionRequest, type BenchmarkExecutor } from './runner.js'
import { benchmarkObject, benchmarkSnapshot, benchmarkSchedule, parseBenchmarkPlan } from './schema.js'
import type { BenchmarkBudget, BenchmarkPlan, BenchmarkObservation } from './types.js'

export interface NativeModelConfig {
  provider: string
  model: string
  temperature: number
  maxOutputTokens: number
  inputUsdMicrosPerMillionTokens: number | null
  outputUsdMicrosPerMillionTokens: number | null
  adapterDigest: string
  tokenCounterDigest: string
}
export interface NativeBenchmarkConfig {
  id: string
  cases: readonly string[]
  variants: readonly { id: string; role: 'baseline' | 'candidate'; persona: string }[]
  model: NativeModelConfig
  budget: BenchmarkBudget
  repeats: number
  seed: number
}
export interface NativeAdapterBinding {
  adapter: LlmAdapter
  inputTokenUpperBound(options: GenerateOptions): number | Promise<number>
  dispose(): void | Promise<void>
}
export type NativeAdapterFactory = (model: Readonly<NativeModelConfig>) => NativeAdapterBinding | Promise<NativeAdapterBinding>

const require = createRequire(import.meta.url)
const EMPTY_DIGEST = acceptanceDigest('native-empty-contract-v1')
const PROTOCOL = 'dsh-native-agent-loop-benchmark-v1'
const MAX_RATE = 1_000_000_000
const id = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error(`invalid ${field}`)
  return value
}
const routeId = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value)) throw new Error(`invalid ${field}`)
  return value
}
const sha = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`invalid ${field}`)
  return value
}
const integer = (value: unknown, field: string, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`invalid ${field}`)
  return value as number
}
const finite = (value: unknown, field: string, min: number, max: number): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`invalid ${field}`)
  return value
}
function validate(input: NativeBenchmarkConfig): NativeBenchmarkConfig {
  const raw = benchmarkObject(benchmarkSnapshot(input), ['id', 'cases', 'variants', 'model', 'budget', 'repeats', 'seed'])
  const copy = raw as unknown as NativeBenchmarkConfig
  id(copy.id, 'benchmark id')
  if (!Array.isArray(copy.cases) || copy.cases.length === 0 || copy.cases.length > 100) throw new Error('invalid cases')
  const known = new Set(developmentCases().map(item => item.id))
  const caseIds = new Set<string>()
  for (const value of copy.cases) { id(value, 'case id'); if (!known.has(value) || caseIds.has(value)) throw new Error('cases must be unique public development cases'); caseIds.add(value) }
  if (!Array.isArray(copy.variants) || copy.variants.length < 2 || copy.variants.length > 8) throw new Error('invalid variants')
  let baseline = 0; const variants = new Set<string>()
  for (const variant of copy.variants) {
    id(variant.id, 'variant id'); if (variants.has(variant.id) || (variant.role !== 'baseline' && variant.role !== 'candidate') || typeof variant.persona !== 'string' || variant.persona.length > 32_768) throw new Error('invalid variant')
    variants.add(variant.id); if (variant.role === 'baseline') baseline++
  }
  if (baseline !== 1) throw new Error('exactly one baseline is required')
  const model = benchmarkObject(copy.model, ['provider', 'model', 'temperature', 'maxOutputTokens', 'inputUsdMicrosPerMillionTokens', 'outputUsdMicrosPerMillionTokens', 'adapterDigest', 'tokenCounterDigest']) as unknown as NativeModelConfig
  routeId(model.provider, 'provider'); routeId(model.model, 'model'); finite(model.temperature, 'temperature', 0, 2)
  integer(model.maxOutputTokens, 'maxOutputTokens', 1, copy.budget.outputTokens)
  if ((model.inputUsdMicrosPerMillionTokens === null) !== (model.outputUsdMicrosPerMillionTokens === null)) throw new Error('both token rates must be present or absent')
  if (model.inputUsdMicrosPerMillionTokens !== null) { integer(model.inputUsdMicrosPerMillionTokens, 'input rate', 0, MAX_RATE); integer(model.outputUsdMicrosPerMillionTokens, 'output rate', 0, MAX_RATE) }
  sha(model.adapterDigest, 'adapter digest'); sha(model.tokenCounterDigest, 'token counter digest')
  const budget = benchmarkObject(copy.budget, ['durationMs', 'inputTokens', 'outputTokens', 'costUsdMicros', 'toolCalls']) as unknown as BenchmarkBudget
  integer(budget.durationMs, 'durationMs', 1, 86_400_000)
  for (const key of ['inputTokens', 'outputTokens', 'toolCalls'] as const) integer(budget[key], key, 0, 1_000_000_000)
  if (budget.costUsdMicros !== null) integer(budget.costUsdMicros, 'costUsdMicros', 0, 1_000_000_000)
  integer(copy.repeats, 'repeats', 2, 20); integer(copy.seed, 'seed', 0, 0xffffffff)
  return Object.freeze({ ...copy, model, budget })
}
function packageVersions(): Record<string, string> {
  const names = ['@deepseek-ai/cordis', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-agent-loop']
  return Object.fromEntries(names.map(name => {
    const pkg = require(`${name}/package.json`) as { version?: unknown }
    if (typeof pkg.version !== 'string') throw new Error(`unresolved runtime package ${name}`)
    return [name, pkg.version]
  }))
}
function versions(input: NativeBenchmarkConfig, persona: string) {
  return Object.freeze({
    model: acceptanceDigest(input.model), prompt: acceptanceDigest({ persona, complete: true }),
    skills: EMPTY_DIGEST, tools: EMPTY_DIGEST, policy: EMPTY_DIGEST,
    runtime: acceptanceDigest({ protocol: PROTOCOL, packages: packageVersions() }),
  })
}
export function nativeBenchmarkPlan(raw: NativeBenchmarkConfig): Readonly<BenchmarkPlan> {
  const input = validate(raw)
  const cases = developmentCases().filter(item => input.cases.includes(item.id))
  const variants = input.variants.map(variant => Object.freeze({ id: variant.id, role: variant.role, versions: versions(input, variant.persona), features: Object.freeze({ memory: false, planning: false, review: false, growth: false }) }))
  return parseBenchmarkPlan({ schemaVersion: 1, id: input.id, dataset: developmentDataset, comparison: 'capability', cases, variants, budget: input.budget, repeats: input.repeats, seed: input.seed })
}
const same = (a: unknown, b: unknown): boolean => acceptanceCanonicalJson(a) === acceptanceCanonicalJson(b)
const cost = (usage: TokenUsage, model: NativeModelConfig): number | null => {
  if (model.inputUsdMicrosPerMillionTokens === null || model.outputUsdMicrosPerMillionTokens === null) return null
  const input = BigInt(usage.inputTokens)
  const output = BigInt(usage.outputTokens)
  const micros = (input * BigInt(model.inputUsdMicrosPerMillionTokens) + output * BigInt(model.outputUsdMicrosPerMillionTokens) + 999_999n) / 1_000_000n
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cost overflow')
  return Number(micros)
}
const safeUsage = (usage: TokenUsage): boolean => [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.reasoningTokens ?? 0, usage.totalTokens ?? 0].every(value => Number.isSafeInteger(value) && value >= 0)
  && (usage.totalTokens === undefined || usage.totalTokens === usage.inputTokens + usage.outputTokens)
function assistantText(session: { snapshotEvents(): readonly unknown[] }): string | undefined {
  const event = [...session.snapshotEvents()].reverse().find((item: any) => item?.type === 'assistant/message') as any
  if (event?.data?.message?.content === undefined) return undefined
  return event.data.message.content.filter((block: any) => block?.type === 'text').map((block: any) => block.text).join('')
}
export function createNativeBenchmarkExecutor(raw: NativeBenchmarkConfig, factory: NativeAdapterFactory): BenchmarkExecutor {
  const input = validate(raw)
  const plan = nativeBenchmarkPlan(input)
  return Object.freeze({ async execute(request: BenchmarkExecutionRequest): Promise<BenchmarkObservation> {
    const expected = nativeBenchmarkPlan(input)
    const expectedCell = benchmarkSchedule(expected).find(cell => cell.id === request.cell.id)
    if (!same(plan, expected) || request.planId !== expected.id || !same(request.dataset, expected.dataset) || !same(request.budget, expected.budget)
      || !same(request.cell, expectedCell) || !same(request.task, expected.cases.find(item => item.id === request.cell.caseId)) || !same(request.variant, expected.variants.find(item => item.id === request.cell.variantId))) throw new Error('native benchmark request drift')
    if (request.signal.aborted) throw new Error('benchmark aborted')
    const costBudget = request.budget.costUsdMicros
    if (costBudget !== null && (!Number.isSafeInteger(costBudget) || costBudget < 0)) throw new Error('invalid native cost budget')
    if (costBudget !== null && input.model.inputUsdMicrosPerMillionTokens === null) throw new Error('priced budget requires token rates')
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-native-benchmark-'))
    const ctx = new Context(); let binding: NativeAdapterBinding | undefined; let handle: { dispose(): Promise<void>; agent: any } | undefined; let removeAbort: (() => void) | undefined
    let observation: BenchmarkObservation | undefined; let executionFailed = false; let executionError: unknown
    let calls = 0; let reserved = false; let reservedInput = 0; let observedUsage: TokenUsage | undefined; let unexpectedTool = false
    try {
      binding = await factory(Object.freeze({ ...input.model }))
      if (!binding || !(binding.adapter instanceof LlmAdapter) || typeof binding.inputTokenUpperBound !== 'function' || typeof binding.dispose !== 'function') throw new Error('invalid native adapter binding')
      await ctx.plugin(LlmRuntime); await ctx.plugin(SessionStore); new SessionProjectionRegistry(ctx); await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false, persona: '' }); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(AgentRegistry); await ctx.plugin(AgentLoop, { agents: [] })
      const persona = input.variants.find(item => item.id === request.variant.id)!.persona
      ctx.systemPrompt.section({ name: 'native-benchmark-persona', order: 0, text: persona, complete: true })
      ctx.systemPrompt.suppressRuntimeContext()
      ctx.on('llm/stream', async function* (options, next) {
        if (!isAgentLoopRequest(options) || calls++ !== 0 || options.provider !== input.model.provider || options.model !== input.model.model || options.temperature !== input.model.temperature || options.maxTokens !== input.model.maxOutputTokens || options.system !== persona || (options.tools?.length ?? 0) !== 0) throw new Error('native request contract violation')
        const upper = await binding!.inputTokenUpperBound(options)
        if (!Number.isSafeInteger(upper) || upper < 0 || upper > request.budget.inputTokens) throw new Error('input budget preflight failed')
        const reserve = cost({ inputTokens: upper, outputTokens: input.model.maxOutputTokens }, input.model)
        if (costBudget !== null && (reserve === null || reserve > costBudget)) throw new Error('cost budget preflight failed')
        reservedInput = upper; reserved = true
        for await (const chunk of next()) { if (chunk.type === 'usage') observedUsage = chunk.usage; if (chunk.type === 'block-end' && chunk.block.type === 'tool-call') unexpectedTool = true; yield chunk }
      })
      ctx.llm.registerAdapter([input.model.provider], binding.adapter)
      const sessionId = SessionId(`benchmark-${request.cell.id.slice(0, 48)}`)
      handle = await ctx.agents.create({
        sessionId, meta: { cwd: workspace },
        agentOptions: { provider: input.model.provider, model: input.model.model, maxTokens: input.model.maxOutputTokens }, signal: request.signal,
        setup: agentCtx => {
          agentCtx.on('agent/request', async (_payload, next) => ({
            ...await next(), provider: input.model.provider, model: input.model.model,
            temperature: input.model.temperature, maxTokens: input.model.maxOutputTokens,
          }))
        },
      })
      const abort = (): void => { handle?.agent.cancel({ kind: 'hook', reason: 'benchmark-aborted' }) }
      request.signal.addEventListener('abort', abort, { once: true }); removeAbort = () => request.signal.removeEventListener('abort', abort)
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: developmentPrompt(request.cell.caseId) }] }))
      await handle.agent.whenIdle()
      const output = assistantText(handle.agent.session)
      const usage = observedUsage
      const terminal = [...handle.agent.session.snapshotEvents()].reverse().find((item: any) => item?.type === 'turn/end') as any
      const hasExtraUsage = usage !== undefined && ((usage.cacheReadTokens ?? 0) !== 0 || (usage.cacheWriteTokens ?? 0) !== 0 || (usage.reasoningTokens ?? 0) !== 0)
      const meteredInput = usage === undefined ? 0 : usage.inputTokens
      const meteredOutput = usage === undefined ? 0 : usage.outputTokens
      const measuredCost = usage === undefined ? null : cost(usage, input.model)
      if (!reserved || calls !== 1 || unexpectedTool || output === undefined || usage === undefined || hasExtraUsage || request.signal.aborted || terminal?.data?.reason?.kind !== 'completed' || !safeUsage(usage) || usage.inputTokens > reservedInput || meteredInput > request.budget.inputTokens || meteredOutput > input.model.maxOutputTokens || meteredOutput > request.budget.outputTokens || (costBudget !== null && (measuredCost === null || measuredCost > costBudget))) throw new Error('incomplete native measurement')
      const judged = judgeDevelopmentResponse(request.cell.caseId, output)
      observation = { versions: request.variant.versions, inputDigest: request.task.inputDigest, acceptanceDigest: request.task.acceptanceDigest, verdict: judged.verdict, metrics: { inputTokens: meteredInput, outputTokens: meteredOutput, costUsdMicros: measuredCost, toolCalls: 0, rework: null, interventions: null, latencyMs: null }, evidenceDigest: judged.evidenceDigest, quiescent: true }
    } catch (error) {
      executionFailed = true; executionError = error
    }
    {
      removeAbort?.()
      const cleanups: Array<Promise<unknown>> = []
      if (handle !== undefined) cleanups.push(Promise.resolve().then(() => handle!.dispose()))
      cleanups.push(Promise.resolve().then(() => ctx.fiber.dispose()))
      if (binding !== undefined) cleanups.push(Promise.resolve().then(() => binding!.dispose()))
      cleanups.push(Promise.resolve().then(() => rm(workspace, { recursive: true, force: true })))
      const settled = await Promise.allSettled(cleanups)
      if (settled.some(result => result.status === 'rejected')) throw new Error('native benchmark cleanup failed')
    }
    if (executionFailed) throw executionError
    if (observation === undefined) throw new Error('native benchmark observation missing')
    return observation
  } })
}
