import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, TokenUsage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { GoalBudgetStore } from './budget-store.js'
import type { GoalBudgetLimits, GoalBudgetScope } from './budget-store.js'
import type { GoalExecutionRun, GoalRecord } from './types.js'

export interface GoalBudgetConfig {
  modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number
  costUsdMicros?: number; durationMs: number; maxOutputTokensPerCall: number
}

/** Host-only metering declaration for one exact route. Never supplied by a model tool. */
export interface GoalBudgetMeter {
  id: string; provider: string; model: string
  inputTokenUpperBound(options: GenerateOptions): number | Promise<number>
  /** Conservative rates must cover every input/cache and output/reasoning billing class. */
  inputUsdMicrosPerMillionTokens: number | null
  outputUsdMicrosPerMillionTokens: number | null
}

function fail(): never { throw new Error('assistant-goals: execution budget unavailable or exhausted') }
const integer = (value: unknown, max = 1_000_000_000): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
export function validateGoalBudgetConfig(input: GoalBudgetConfig): Readonly<GoalBudgetConfig> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['modelCalls', 'toolCalls', 'inputTokens', 'outputTokens', 'costUsdMicros', 'durationMs', 'maxOutputTokensPerCall'].includes(key))
    || ![input.modelCalls, input.toolCalls, input.inputTokens, input.outputTokens].every(value => integer(value))
    || (input.costUsdMicros !== undefined && !integer(input.costUsdMicros))
    || !integer(input.durationMs, 31 * 86_400_000) || input.durationMs < 1
    || !integer(input.maxOutputTokensPerCall) || input.maxOutputTokensPerCall < 1) fail()
  return Object.freeze({ ...input })
}

function cost(input: number, output: number, meter: GoalBudgetMeter): number | null {
  if (meter.inputUsdMicrosPerMillionTokens === null || meter.outputUsdMicrosPerMillionTokens === null) return null
  const amount = (BigInt(input) * BigInt(meter.inputUsdMicrosPerMillionTokens)
    + BigInt(output) * BigInt(meter.outputUsdMicrosPerMillionTokens) + 999_999n) / 1_000_000n
  if (amount > 1_000_000_000n) fail()
  return Number(amount)
}
function usage(value: TokenUsage | undefined): { inputTokens: number; outputTokens: number } {
  if (value === undefined || ![value.inputTokens, value.outputTokens, value.cacheReadTokens ?? 0,
    value.cacheWriteTokens ?? 0, value.reasoningTokens ?? 0].every(item => integer(item))) fail()
  const inputTokens = value.inputTokens + (value.cacheReadTokens ?? 0) + (value.cacheWriteTokens ?? 0)
  const outputTokens = value.outputTokens
  if (!integer(inputTokens) || (value.reasoningTokens ?? 0) > outputTokens
    || (value.totalTokens !== undefined && value.totalTokens !== inputTokens + outputTokens)) fail()
  return { inputTokens, outputTokens }
}
function requestIdentity(options: GenerateOptions): string {
  return JSON.stringify([options.provider, options.model, options.system, options.messages, options.tools, options.maxTokens])
}

function bounded<T>(operation: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const abort = () => { cleanup(); reject(new Error('assistant-goals: budget operation expired or cancelled')) }
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
  })
}

/** Durable reservations span all native rounds of a business goal, including edits and resumes. */
export class GoalBudgetRuntime {
  readonly #store: GoalBudgetStore
  readonly #meters = new Map<string, Readonly<GoalBudgetMeter>>()
  readonly #inflight = new Map<Agent, Readonly<GoalBudgetMeter>>()
  readonly #deadlines = new Map<Agent, { runId: string; timer: ReturnType<typeof setTimeout> }>()
  #active = true

  constructor(private readonly ctx: Context, path: string, readonly config: Readonly<GoalBudgetConfig>,
    private readonly current: (agent: Agent) => { record: GoalRecord; run: GoalExecutionRun; signal: AbortSignal } | undefined) {
    this.#store = new GoalBudgetStore(path)
    ctx.on('agent/request', async ({ agent }, next) => {
      const request = await next()
      const bound = this.current(agent)
      if (bound === undefined) return request
      const budget = this.inspect(bound.record)
      if (budget.modelCalls >= budget.limits.modelCalls || budget.outputTokens >= budget.limits.outputTokens) fail()
      if (this.#deadlines.get(agent)?.runId !== bound.run.intent.runId) {
        this.#clearDeadline(agent)
        const deadline = Math.min(bound.record.createdAt + config.durationMs, bound.run.intent.admission.expiresAt)
        const timer = setTimeout(() => agent.cancel({ kind: 'hook', reason: 'assistant-goals-budget-expired' }), Math.max(0, deadline - Date.now()))
        timer.unref?.()
        this.#deadlines.set(agent, { runId: bound.run.intent.runId, timer })
      }
      return { ...request, maxTokens: Math.min(request.maxTokens ?? config.maxOutputTokensPerCall,
        config.maxOutputTokensPerCall, budget.limits.outputTokens - budget.outputTokens) }
    })
    ctx.on('session/event', (session, event) => {
      if (event.type === 'turn/end') for (const agent of this.#deadlines.keys()) if (agent.session === session) this.#clearDeadline(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => this.#clearDeadline(agent))
    ctx.on('llm/stream', this.#stream.bind(this))
    ctx.on('tools/execute', async (execution, next) => {
      const agent = execution.agent
      const bound = agent === undefined ? undefined : this.current(agent)
      if (agent === undefined || bound === undefined) return await next()
      try {
        execution.signal.throwIfAborted()
        this.#store.consumeTool(this.#binding(bound.record), `goal-tool-${randomUUID()}`, Date.now())
        if (this.current(agent)?.run.intent.runId !== bound.run.intent.runId) fail()
        return await next()
      } catch (error) {
        agent.cancel({ kind: 'hook', reason: 'assistant-goals-tool-budget-rejected' })
        throw error
      }
    })
    ctx.effect(() => () => {
      this.#active = false
      for (const agent of this.#deadlines.keys()) {
        this.#clearDeadline(agent)
        agent.cancel({ kind: 'hook', reason: 'assistant-goals-budget-unloaded' })
      }
      for (const agent of this.#inflight.keys()) agent.cancel({ kind: 'hook', reason: 'assistant-goals-budget-unloaded' })
      this.#meters.clear(); this.#store.close()
    }, 'assistant-goals.budgets')
  }

  async *#stream(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const agent = this.ctx.get('agents')?.currentInitiator()
    const bound = agent === undefined ? undefined : this.current(agent)
    if (agent === undefined || bound === undefined) { yield* next(); return }
    const binding = this.#binding(bound.record)
    const meter = this.#meters.get(JSON.stringify([options.provider, options.model]))
    const deadline = Math.min(bound.record.createdAt + this.config.durationMs, bound.run.intent.admission.expiresAt)
    let ownsMeter = false
    try {
      if (meter === undefined || this.#inflight.has(agent)) fail()
      this.#assert(agent, bound.run, meter)
      if (!integer(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > this.config.maxOutputTokensPerCall) fail()
      this.#inflight.set(agent, meter)
      ownsMeter = true
      const identity = requestIdentity(options)
      const upper = await bounded(Promise.resolve(meter.inputTokenUpperBound(options)), bound.signal, deadline)
      this.#assert(agent, bound.run, meter)
      if (!integer(upper) || requestIdentity(options) !== identity) fail()
      const reservedCost = this.config.costUsdMicros === undefined ? null : cost(upper, options.maxTokens, meter)
      if (this.config.costUsdMicros !== undefined && reservedCost === null) fail()
      const id = `goal-budget-${randomUUID()}`
      this.#store.reserve(binding, { id, runId: bound.run.intent.runId, inputTokens: upper,
        outputTokens: options.maxTokens, costUsdMicros: this.config.costUsdMicros === undefined ? null : reservedCost }, Date.now())
      // No refunds on dispatch uncertainty. A process crash leaves this full reservation occupied.
      let observed: TokenUsage | undefined
      let finished = false
      const iterator = next()[Symbol.asyncIterator]()
      try {
        while (true) {
          const item = await bounded(iterator.next(), bound.signal, deadline)
          if (item.done) break
          const chunk = item.value
          this.#assert(agent, bound.run, meter)
          if (chunk.type === 'usage') observed = { ...chunk.usage }
          if (chunk.type === 'finish') {
            if (finished || !['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind)) fail()
            finished = true
          }
          yield chunk
        }
      } finally { try { void iterator.return?.().catch(() => {}) } catch {} }
      this.#assert(agent, bound.run, meter)
      if (!finished) fail()
      const measured = usage(observed)
      if (measured.inputTokens > upper || measured.outputTokens > options.maxTokens) fail()
      this.#store.settle(id, { ...measured, costUsdMicros: this.config.costUsdMicros === undefined
        ? null : cost(measured.inputTokens, measured.outputTokens, meter) }, Date.now())
    } catch (error) {
      agent.cancel({ kind: 'hook', reason: 'assistant-goals-budget-rejected' })
      throw error
    } finally { if (ownsMeter && this.#inflight.get(agent) === meter) this.#inflight.delete(agent) }
  }

  register = (input: GoalBudgetMeter): (() => void) => {
    if (!this.#active || input === null || typeof input !== 'object' || typeof input.inputTokenUpperBound !== 'function'
      || ![input.id, input.provider, input.model].every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)
      || ![input.inputUsdMicrosPerMillionTokens, input.outputUsdMicrosPerMillionTokens].every(item => item === null || integer(item))
      || (input.inputUsdMicrosPerMillionTokens === null) !== (input.outputUsdMicrosPerMillionTokens === null)) fail()
    const key = JSON.stringify([input.provider, input.model])
    if (this.#meters.has(key)) fail()
    const meter = Object.freeze({ ...input })
    this.#meters.set(key, meter)
    return () => {
      if (this.#meters.get(key) !== meter) return
      this.#meters.delete(key)
      for (const [agent, active] of this.#inflight) if (active === meter) agent.cancel({ kind: 'hook', reason: 'assistant-goals-budget-meter-unloaded' })
    }
  }
  inspect = (record: GoalRecord) => this.#store.snapshot(this.#binding(record))
  health = () => ({ enabled: true, registeredMeters: this.#meters.size, activeCalls: this.#inflight.size })
  #clearDeadline(agent: Agent): void {
    const value = this.#deadlines.get(agent)
    if (value !== undefined) { clearTimeout(value.timer); this.#deadlines.delete(agent) }
  }
  #binding(record: GoalRecord): GoalBudgetScope {
    if (!this.#active) fail()
    const binding = { scope: record.scope, goalId: record.id }
    const limits: GoalBudgetLimits = { modelCalls: this.config.modelCalls, toolCalls: this.config.toolCalls,
      inputTokens: this.config.inputTokens, outputTokens: this.config.outputTokens,
      costUsdMicros: this.config.costUsdMicros ?? null, expiresAt: record.createdAt + this.config.durationMs }
    this.#store.configure(binding, limits)
    return binding
  }
  #assert(agent: Agent, run: GoalExecutionRun, meter: Readonly<GoalBudgetMeter>): void {
    const bound = this.current(agent)
    if (!this.#active || this.ctx.get('agents')?.get(agent.id) !== agent
      || this.#meters.get(JSON.stringify([meter.provider, meter.model])) !== meter
      || bound?.run.intent.runId !== run.intent.runId
      || Date.now() >= bound.record.createdAt + this.config.durationMs) fail()
  }
}
