/**
 * Host-only accounting for a single strategy benchmark cell.  This intentionally
 * observes the complete Context (foreground, parent and strategy-child calls),
 * rather than relying on a Goal's inner budget.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { NativeAdapterBinding, NativeModelConfig } from './native.js'
import type { BenchmarkBudget } from './types.js'
import { normalizeTokenUsage, tokenUsageCost, tokenUsageReserveCost, type NormalizedTokenUsage } from './usage.js'

export type StrategyMeterPhase = 'preflight' | 'reserved' | 'streaming' | 'settled' | 'retained' | 'rejected'
export type StrategyMeterReason = 'cancelled' | 'disposed' | 'request-contract' | 'input-bound' | 'shared-budget' | 'stream' | 'usage' | 'cost' | 'tool-budget'
export interface StrategyBenchmarkRequestTrace {
  readonly id: number
  readonly sessionId: string | null
  readonly agentId: string | null
  readonly startedAt: number
  readonly completedAt: number | null
  readonly phase: StrategyMeterPhase
  readonly dispatched: boolean
  readonly reservedInputTokens: number
  readonly reservedOutputTokens: number
  readonly reservedCostUsdMicros: number | null
  readonly usage: Readonly<NormalizedTokenUsage> | null
  readonly reason: StrategyMeterReason | null
}
export interface StrategyBenchmarkMeterSnapshot {
  readonly observationMode: 'enforced-upper-bound-provider-output'
  readonly budget: Readonly<BenchmarkBudget>
  readonly modelCalls: number
  readonly toolCalls: number
  readonly activeToolCalls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsdMicros: number | null
  readonly heldModelCalls: number
  readonly heldInputTokens: number
  readonly heldOutputTokens: number
  readonly heldCostUsdMicros: number | null
  readonly traces: readonly StrategyBenchmarkRequestTrace[]
}
export interface StrategyBenchmarkMeter {
  /** Pass this to the cell factory and every hand-built request signal. */
  readonly signal: AbortSignal
  snapshot(): Readonly<StrategyBenchmarkMeterSnapshot>
  /** Fails unless every dispatched request has trustworthy final usage and no reservation remains. */
  assertComplete(): void
  dispose(): void
}
export interface StrategyBenchmarkMeterInput {
  readonly budget: Readonly<BenchmarkBudget>
  readonly modelCalls: number
  readonly maxOutputTokens: number
  readonly model: Readonly<NativeModelConfig>
  readonly binding: Readonly<NativeAdapterBinding>
  readonly signal: AbortSignal
}

const MAX = 1_000_000_000
const valid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX
const fail = (reason: string): never => { throw new Error(`strategy benchmark meter: ${reason}`) }
const frozen = <T>(value: T): Readonly<T> => Object.freeze(value)
const sum = (a: number, b: number): number => { if (a > MAX - b) fail('budget overflow'); return a + b }
function clockBound<T>(value: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => done(() => reject(new Error('strategy benchmark meter: cancelled or timed out')))
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    const done = (complete: () => void): void => { clearTimeout(timer); signal.removeEventListener('abort', abort); complete() }
    signal.addEventListener('abort', abort, { once: true })
    value.then(result => done(() => resolve(result)), error => done(() => reject(error)))
    if (signal.aborted) abort()
  })
}
function metadata(ctx: Context, options: GenerateOptions): { sessionId: string | null; agentId: string | null } {
  // GenerateOptions.sessionId covers auxiliary calls; currentInitiator cross-checks native AgentLoop calls.
  const agent = (ctx.get('agents' as never) as { currentInitiator?: () => unknown } | undefined)?.currentInitiator?.() as { id?: unknown; session?: { id?: unknown } } | undefined
  const sessionId = options.sessionId === undefined ? (typeof agent?.session?.id === 'string' ? agent.session.id : null) : String(options.sessionId)
  return { sessionId, agentId: typeof agent?.id === 'string' ? agent.id : null }
}
function checkInput(input: StrategyBenchmarkMeterInput): void {
  const { budget, model, binding } = input
  if (!valid(input.modelCalls) || input.modelCalls < 1 || input.modelCalls > 10_000 || !valid(input.maxOutputTokens) || input.maxOutputTokens < 1
    || !valid(budget.durationMs) || budget.durationMs < 1 || !valid(budget.inputTokens) || !valid(budget.outputTokens)
    || !valid(budget.toolCalls) || (budget.costUsdMicros !== null && !valid(budget.costUsdMicros))
    || (model.inputLimitMode ?? 'upper-bound') !== 'upper-bound' || (model.outputLimitMode ?? 'provider') !== 'provider'
    || model.maxOutputTokens !== input.maxOutputTokens || input.maxOutputTokens > budget.outputTokens || typeof binding.inputTokenUpperBound !== 'function') fail('invalid enforced observation configuration')
  if ((model.inputUsdMicrosPerMillionTokens === null) !== (model.outputUsdMicrosPerMillionTokens === null)) fail('incomplete tariff')
  if (budget.costUsdMicros !== null && [model.inputUsdMicrosPerMillionTokens, model.outputUsdMicrosPerMillionTokens, model.cacheReadUsdMicrosPerMillionTokens, model.cacheWriteUsdMicrosPerMillionTokens].some(rate => rate === null || rate === undefined)) fail('priced budget needs complete tariff')
}

/**
 * Install before any cell work. It rejects estimate/observed modes at setup;
 * there is deliberately no best-effort observation-only fallback in v1.
 */
export function installStrategyBenchmarkMeter(ctx: Context, input: StrategyBenchmarkMeterInput): Readonly<StrategyBenchmarkMeter> {
  checkInput(input)
  const budget = frozen({ ...input.budget })
  const model = frozen({ ...input.model })
  const countInput = input.binding.inputTokenUpperBound!.bind(input.binding)
  const maxCalls = input.modelCalls
  const outputCap = input.maxOutputTokens
  const deadline = Date.now() + budget.durationMs
  const controller = new AbortController()
  const meterSignal = AbortSignal.any([input.signal, controller.signal])
  const deadlineTimer = setTimeout(() => controller.abort(new Error('strategy benchmark meter timed out')), budget.durationMs)
  deadlineTimer.unref?.()
  let live = true; let calls = 0; let tools = 0; let activeTools = 0; let measuredInput = 0; let measuredOutput = 0; let toolRejected = false
  let measuredCost: number | null = budget.costUsdMicros === null ? null : 0
  let heldCalls = 0; let heldInput = 0; let heldOutput = 0; let heldCost: number | null = budget.costUsdMicros === null ? null : 0
  const traces: Array<{ id: number; sessionId: string | null; agentId: string | null; startedAt: number; completedAt: number | null; phase: StrategyMeterPhase; dispatched: boolean; reservedInputTokens: number; reservedOutputTokens: number; reservedCostUsdMicros: number | null; usage: Readonly<NormalizedTokenUsage> | null; reason: StrategyMeterReason | null }> = []
  const attemptCap = maxCalls + 1
  const nativeAgents = new Map<string, { cancel(input: { kind: 'hook'; reason: string }): void }>()
  const cancelNative = (): void => { for (const agent of nativeAgents.values()) try { agent.cancel({ kind: 'hook', reason: 'strategy-benchmark-meter-cancelled' }) } catch {} }
  meterSignal.addEventListener('abort', cancelNative, { once: true })
  function reject(trace: typeof traces[number], reason: StrategyMeterReason): never {
    trace.phase = 'rejected'; trace.reason = reason; trace.completedAt = Date.now()
    return fail(reason)
  }
  const stream = async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const requestSignal = options.signal === undefined ? meterSignal : AbortSignal.any([meterSignal, options.signal])
    if (traces.length >= attemptCap) fail('request attempt cap exceeded')
    const trace: typeof traces[number] = { id: traces.length + 1, ...metadata(ctx, options), startedAt: Date.now(), completedAt: null, phase: 'preflight', dispatched: false, reservedInputTokens: 0, reservedOutputTokens: 0, reservedCostUsdMicros: null, usage: null, reason: null }
    traces.push(trace)
    if (trace.sessionId !== null) {
      const agent = (ctx.get('agents' as never) as { get?(id: string): unknown } | undefined)?.get?.(trace.sessionId) as { cancel?(input: { kind: 'hook'; reason: string }): void } | undefined
      if (typeof agent?.cancel === 'function') nativeAgents.set(trace.sessionId, agent as { cancel(input: { kind: 'hook'; reason: string }): void })
    }
    if (!live) reject(trace, 'disposed')
    if (meterSignal.aborted || options.signal?.aborted || Date.now() > deadline) reject(trace, 'cancelled')
    if (options.provider !== model.provider || options.model !== model.model || options.maxTokens !== outputCap || options.temperature !== (model.temperature ?? undefined)) reject(trace, 'request-contract')
    let upper: number
    try { upper = await clockBound(Promise.resolve(countInput(options)), requestSignal, deadline) } catch { return reject(trace, 'input-bound') }
    // The awaited counter may have crossed a cancellation, disposal, or route-change boundary.
    if (!live) reject(trace, 'disposed')
    if (meterSignal.aborted || options.signal?.aborted || Date.now() > deadline) reject(trace, 'cancelled')
    if (options.provider !== model.provider || options.model !== model.model || options.maxTokens !== outputCap || options.temperature !== (model.temperature ?? undefined) || !valid(upper) || upper > budget.inputTokens) return reject(trace, 'input-bound')
    const reserveCost = tokenUsageReserveCost(upper, outputCap, model)
    if (budget.costUsdMicros !== null && reserveCost === null) reject(trace, 'cost')
    if (calls + heldCalls >= maxCalls || sum(measuredInput, heldInput) > budget.inputTokens - upper
      || sum(measuredOutput, heldOutput) > budget.outputTokens - outputCap
      || (budget.costUsdMicros !== null && (measuredCost === null || heldCost === null || reserveCost === null || measuredCost + heldCost > budget.costUsdMicros - reserveCost))) reject(trace, 'shared-budget')
    heldCalls++; heldInput += upper; heldOutput += outputCap; if (heldCost !== null && reserveCost !== null) heldCost += reserveCost
    trace.phase = 'reserved'; trace.reservedInputTokens = upper; trace.reservedOutputTokens = outputCap; trace.reservedCostUsdMicros = reserveCost
    let usage: TokenUsage | undefined; let finished = false; let iterator: AsyncIterator<StreamChunk> | undefined
    try {
      // GenerateOptions is deep-frozen by native AgentLoop. We never mutate it:
      // cancellation reaches native adapters by cancelling the session's actual Agent.
      iterator = next()[Symbol.asyncIterator](); trace.dispatched = true; trace.phase = 'streaming'
      while (true) {
        const item = await clockBound(iterator.next(), requestSignal, deadline)
        if (item.done) break
        if (finished) reject(trace, 'stream')
        if (item.value.type === 'usage') {
          if (usage !== undefined || finished) reject(trace, 'usage')
          usage = { ...item.value.usage }
        }
        if (item.value.type === 'finish') { if (finished || usage === undefined || !['stop', 'tool-calls', 'max-tokens'].includes(item.value.reason.kind)) reject(trace, 'stream'); finished = true }
        yield item.value
      }
      if (!live) reject(trace, 'disposed')
      if (requestSignal.aborted || !finished) reject(trace, 'cancelled')
      const normalized = usage === undefined ? undefined : normalizeTokenUsage(usage)
      if (!normalized) return reject(trace, 'usage')
      if (normalized.inputTokens > upper || normalized.outputTokens > outputCap) return reject(trace, 'usage')
      const cost = tokenUsageCost(normalized, model)
      if (budget.costUsdMicros !== null && (cost === null || measuredCost === null || cost > budget.costUsdMicros - measuredCost)) reject(trace, 'cost')
      heldCalls--; heldInput -= upper; heldOutput -= outputCap; if (heldCost !== null && reserveCost !== null) heldCost -= reserveCost
      calls++; measuredInput = sum(measuredInput, normalized.inputTokens); measuredOutput = sum(measuredOutput, normalized.outputTokens)
      if (measuredCost !== null && cost !== null) measuredCost = sum(measuredCost, cost)
      trace.usage = frozen({ ...normalized }); trace.phase = 'settled'; trace.completedAt = Date.now()
    } catch (error) {
      // Reservation intentionally remains held: a thrown/aborted/late stream cannot prove no bill.
      if (trace.phase !== 'settled') { trace.phase = 'retained'; trace.reason = meterSignal.aborted ? 'cancelled' : live ? 'stream' : 'disposed'; trace.completedAt = Date.now() }
      throw error
    } finally {
      try { void iterator?.return?.().catch(() => {}) } catch {}
      if (trace.phase === 'reserved' || trace.phase === 'streaming') { trace.phase = 'retained'; trace.reason = live ? 'stream' : 'disposed'; trace.completedAt = Date.now() }
    }
  }
  ctx.on('llm/stream', stream)
  ctx.on('tools/execute', async (execution, next) => {
    if (!live || meterSignal.aborted || Date.now() > deadline || execution.signal.aborted || tools >= budget.toolCalls) { toolRejected = true; fail('tool-budget') }
    if (execution.agent !== undefined) nativeAgents.set(String(execution.agent.id), execution.agent)
    tools++; activeTools++ // Tool failure is still an attempted external action.
    try { return await next() } finally { activeTools-- }
  })
  const snapshot = (): Readonly<StrategyBenchmarkMeterSnapshot> => frozen({ observationMode: 'enforced-upper-bound-provider-output', budget,
    modelCalls: calls, toolCalls: tools, activeToolCalls: activeTools, inputTokens: measuredInput, outputTokens: measuredOutput, costUsdMicros: measuredCost,
    heldModelCalls: heldCalls, heldInputTokens: heldInput, heldOutputTokens: heldOutput, heldCostUsdMicros: heldCost,
    traces: frozen(traces.map(trace => frozen({ ...trace, usage: trace.usage === null ? null : frozen({ ...trace.usage }) }))) })
  const assertComplete = (): void => {
    const value = snapshot()
    if (meterSignal.aborted || !live || Date.now() >= deadline || value.modelCalls === 0 || toolRejected || activeTools !== 0 || value.heldModelCalls !== 0 || value.traces.some(trace => trace.phase !== 'settled')
      || value.modelCalls > maxCalls || value.toolCalls > budget.toolCalls || value.inputTokens > budget.inputTokens || value.outputTokens > budget.outputTokens
      || (budget.costUsdMicros !== null && (value.costUsdMicros === null || value.costUsdMicros > budget.costUsdMicros))) fail('incomplete benchmark meter measurement')
  }
  const dispose = (): void => { if (!live) return; live = false; clearTimeout(deadlineTimer); controller.abort(new Error('strategy benchmark meter disposed')); cancelNative() }
  ctx.effect(() => () => dispose(), 'assistant-evaluation.strategy-benchmark-meter')
  return frozen({ signal: meterSignal, snapshot, assertComplete, dispose })
}
