import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { startInProcessRun } from '@deepseek-ai/dsh-subagent-in-process-driver'
import { delegationDepthOf, foldSubagentDescriptor, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest, SubagentProvider, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { GoalBudgetRuntime } from './budget.js'
import { STRATEGY_PROVIDER } from './strategy-identity.js'
import { GoalStrategyStore } from './strategy-store.js'
import type { StrategyChildDiagnostics, StrategyKind, StrategyRecord, StrategyTerminationReason } from './strategy-store.js'
import type { GoalExecutionRun, GoalRecord, GoalScope } from './types.js'

export interface GoalStrategyConfig { maxDurationMs: number; maxPromptBytes: number; maxOutputBytes: number; maxRunsPerGoal: number }
export interface GoalStrategyInput { kind: StrategyKind; question: string; context?: string }
export interface GoalStrategyResult {
  strategyId: string
  outcome: 'advice' | 'execution-failed' | 'cancelled' | 'unknown'
  advice: string[]
  terminationReason: StrategyTerminationReason
  children: Array<{ sessionId: string; stopReason: string; quiescent: boolean; diagnostics?: StrategyChildDiagnostics }>
  unverified: true
}

const defaults: GoalStrategyConfig = Object.freeze({ maxDurationMs: 30_000, maxPromptBytes: 32_768, maxOutputBytes: 16_384, maxRunsPerGoal: 16 })
const limit = (value: unknown, minimum: number, maximum: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
const plain = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)

/** Strict, side-effect-free configuration boundary used by service preauthorization. */
export function validateGoalStrategyConfig(input: Partial<GoalStrategyConfig> = {}): Readonly<GoalStrategyConfig> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
    || Object.keys(input).some(key => !['maxDurationMs', 'maxPromptBytes', 'maxOutputBytes', 'maxRunsPerGoal'].includes(key))) throw new Error('assistant-goals: invalid strategy configuration')
  const value = { ...defaults, ...input }
  if (!limit(value.maxDurationMs, 1_000, 300_000) || !limit(value.maxPromptBytes, 1_024, 65_536)
    || !limit(value.maxOutputBytes, 256, 65_536) || !limit(value.maxRunsPerGoal, 1, 32)) throw new Error('assistant-goals: invalid strategy configuration')
  return Object.freeze(value)
}

/** Detach only finite plain strings; no caller-owned objects reach a strategy child. */
export function validateGoalStrategyInput(input: unknown): Readonly<GoalStrategyInput> {
  if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) throw new Error('assistant-goals: invalid strategy input')
  const value = input as Record<string, unknown>
  if (!Object.keys(value).every(key => key === 'kind' || key === 'question' || key === 'context')
    || !(['investigate', 'review', 'compare'] as const).includes(value.kind as StrategyKind)
    || !plain(value.question, 65_536) || (value.context !== undefined && !plain(value.context, 65_536))) throw new Error('assistant-goals: invalid strategy input')
  return Object.freeze({ kind: value.kind as StrategyKind, question: value.question, ...(value.context === undefined ? {} : { context: value.context }) })
}

type Current = { record: GoalRecord; run: GoalExecutionRun; signal: AbortSignal }
type Permit = { id: string; label: string; parent: Agent; parentRunId: string; record: GoalRecord; expiresAt: number; signal: AbortSignal; provider: string; model: string; maxTokens: number | undefined; prompt: readonly ContentBlock[]; maxDepth: number; rejected: boolean; starting: boolean; toolRejections: number; child?: Agent }
type ChildState = { sessionId: string; stopReason: string; quiescent: boolean; output: 'not-observed' | 'accepted' | 'empty-or-oversized'; run?: SubagentRun; permit: Permit }

function bounded<T>(operation: Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let done = false
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
    const finish = (callback: () => void) => { if (done) return; done = true; cleanup(); callback() }
    const abort = () => finish(() => reject(new Error('assistant-goals: strategy operation expired or cancelled')))
    const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
    timer.unref?.()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    operation.then(value => finish(() => resolve(value)), error => finish(() => reject(error)))
  })
}

function outputText(output: readonly ContentBlock[], maximum: number): string | undefined {
  let text = ''
  for (const block of output) if (block.type === 'text') text += block.text
  return text.length > 0 && Buffer.byteLength(text, 'utf8') <= maximum ? text : undefined
}

function promptBlock(text: string): readonly ContentBlock[] { return Object.freeze([Object.freeze({ type: 'text' as const, text })]) }

/**
 * Host-only one-shot strategy runner. Strategy output is deliberately advice
 * only: it never feeds a verifier or changes a goal's native lifecycle.
 */
export class GoalStrategyRuntime {
  readonly #store: GoalStrategyStore
  readonly #permits = new Map<string, Permit>()
  readonly #operations = new Set<Promise<void>>()
  readonly #controllers = new Set<AbortController>()
  readonly #runs = new Set<SubagentRun>()
  readonly #disposals = new WeakMap<SubagentRun, Promise<void>>()
  readonly #guarded = new WeakSet<Agent>()
  readonly #observedToolGuards = new WeakSet<object>()
  #active = true
  #closed = false
  #removeResolver: (() => void) | undefined

  constructor(
    private readonly ctx: Context,
    path: string,
    readonly config: Readonly<GoalStrategyConfig>,
    private readonly callbacks: { current(parent: Agent): Current; budget: GoalBudgetRuntime },
  ) {
    this.#store = new GoalStrategyStore(path)
    this.#store.recoverIncomplete(Date.now())
    const provider: SubagentProvider = {
      name: STRATEGY_PROVIDER,
      capabilities: Object.freeze({ agentOptions: true, outputSchema: false, depthLimit: true, toolFilter: true, persona: true }),
      inheritsParentContext: false,
      start: request => this.#start(request),
    }
    ctx.inject(['subagents', 'tools', 'systemPrompt'], runtime => {
      const removeProvider = runtime.subagents.registerProvider(provider)
      this.#removeResolver = this.callbacks.budget.registerDelegateResolver(agent => this.#delegate(agent))
      // Agent/request changes route configuration only. The native driver
      // installs this private persona during creation, before its first prompt
      // assembly; the hidden descriptor arrives later at pre-step. This marker
      // only removes presentation, never grants budget or owner authority.
      runtime.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
        const assembly = await next()
        const marker = assembly.sections.find(section => section.name === 'deployment:persona')?.text
        if (typeof marker !== 'string' || !marker.startsWith(`${STRATEGY_PROVIDER}:`)) return assembly
        const permit = this.#permits.get(marker.slice(STRATEGY_PROVIDER.length + 1))
        if (!agent || !permit || agent.session.header.origin !== 'subagent'
          || String(agent.session.header.parentSession) !== String(permit.parent.session.id)) throw new Error('assistant-goals: strategy prompt is not admitted')
        this.#assertPermit(permit)
        return { ...assembly, tools: [], sections: assembly.sections.filter(section => !section.name.startsWith('tools:')).map(section =>
          section.name === 'deployment:persona' ? { ...section, text: 'Analyze the supplied material only. Return unverified advice; do not invoke tools or take actions.' } : section) }
      })
      // The descriptor exists before the first request. This also keeps scoped
      // tools out of the assembled prompt, while the guard denies any late call.
      runtime.on('agent/request', async ({ agent }, next) => {
        if (!this.#recognized(agent)) return await next()
        if (!this.#strategyDescriptor(agent)) throw new Error('assistant-goals: unsupported strategy descriptor')
        this.#delegate(agent)
        this.#installChildGuards(agent)
        const request = await next()
        return request
      })
      runtime.tools.guard(execution => this.#toolGuard(execution))
      ctx.effect(() => () => removeProvider(), 'assistant-goals.strategy-provider')
    })
    ctx.effect(() => async () => {
      this.#active = false
      this.#removeResolver?.(); this.#removeResolver = undefined
      for (const controller of this.#controllers) controller.abort()
      for (const run of this.#runs) void this.#dispose(run)
      for (const permit of this.#permits.values()) permit.rejected = true
      try { await bounded(Promise.allSettled(this.#operations), new AbortController().signal, Date.now() + 1_000) } catch {}
      this.#store.recoverIncomplete(Date.now())
      this.#closed = true
      this.#permits.clear()
      this.#store.close()
    }, 'assistant-goals.strategy')
  }

  list = (scope: GoalScope, goalId: string): readonly StrategyRecord[] => { this.#open(); return this.#store.list(scope, goalId) }

  async run(parent: Agent, raw: GoalStrategyInput, signal: AbortSignal): Promise<GoalStrategyResult> {
    const input = validateGoalStrategyInput(raw)
    this.#open()
    if (!this.#active || this.ctx.get('agents')?.get(parent.id) !== parent) throw new Error('assistant-goals: strategy parent is unavailable')
    const current = this.callbacks.current(parent)
    signal.throwIfAborted()
    const route = parent.options
    if (!plain(route.provider, 256) || !plain(route.model, 256)) throw new Error('assistant-goals: strategy route is unavailable')
    const prompt = this.#prompt(input)
    const personas = input.kind === 'compare' ? ['Give an independent skeptical analysis.', 'Give an independent alternative analysis.'] : ['Give a concise evidence-aware analysis.']
    const prompts = personas.map(persona => `${persona}\n\n${prompt}`)
    if (prompts.some(value => Buffer.byteLength(value, 'utf8') > this.config.maxPromptBytes)) throw new Error('assistant-goals: strategy prompt exceeds limit')
    const budget = this.callbacks.budget.inspect(current.record)
    const now = Date.now()
    const expiresAt = Math.min(current.run.intent.admission.expiresAt, budget.limits.expiresAt, now + this.config.maxDurationMs)
    if (expiresAt <= now || this.#store.list(current.record.scope, current.record.id, 32).length >= this.config.maxRunsPerGoal) throw new Error('assistant-goals: strategy admission unavailable')
    const id = `strategy-${randomUUID()}`
    const prepared = this.#store.prepare({ id, goalId: current.record.id, parentRunId: current.run.intent.runId, parentSessionId: String(parent.session.id),
      definitionVersion: current.record.definition.version, definitionDigest: current.record.definition.digest, scope: current.record.scope,
      kind: input.kind, requestDigest: acceptanceDigest(input), provider: route.provider, model: route.model,
      maxChildren: input.kind === 'compare' ? 2 : 1, maxDurationMs: expiresAt - now, createdAt: now, expiresAt })
    this.#store.dispatch(id, prepared.record.version, now)
    const controller = new AbortController()
    this.#controllers.add(controller)
    let release: (() => void) | undefined
    const lifetime = new Promise<void>(resolve => { release = resolve })
    this.#operations.add(lifetime)
    const combined = AbortSignal.any([signal, current.signal, controller.signal])
    const timer = setTimeout(() => controller.abort(), Math.max(0, expiresAt - Date.now()))
    timer.unref?.()
    // A provider may be waiting for its first stream chunk, so budget stream
    // assertions alone cannot observe a revoked owner or policy decision.
    const watchdog = setInterval(() => { try { this.#assertCurrent(parent, current) } catch { parentAuthorityChanged = true; controller.abort() } }, 50)
    watchdog.unref?.()
    const children: ChildState[] = []
    const advice: string[] = []
    const childPrompts = prompts
    let unknown = false
    let parentAuthorityChanged = false
    try {
      for (const childPrompt of childPrompts) {
        if (combined.aborted || Date.now() >= expiresAt) { unknown = true; break }
        const permit: Permit = { id, label: `strategy-${randomUUID()}`, parent, parentRunId: current.run.intent.runId, record: current.record,
          expiresAt, signal: combined, provider: route.provider, model: route.model, maxTokens: route.maxTokens,
          prompt: promptBlock(childPrompt), maxDepth: delegationDepthOf(parent) + 1, starting: false, rejected: false, toolRejections: 0 }
        this.#permits.set(permit.label, permit)
        const child: ChildState = { sessionId: 'pending', stopReason: 'pending', quiescent: false, output: 'not-observed', permit }
        children.push(child)
        try {
          const started = this.ctx.subagents.start(STRATEGY_PROVIDER, {
            label: permit.label, prompt: [...permit.prompt], parent, signal: combined,
            agentOptions: { provider: route.provider, model: route.model, ...(route.maxTokens === undefined ? {} : { maxTokens: route.maxTokens }) }, maxDepth: permit.maxDepth, toolFilter: { allow: [] },
          })
          const run = await this.#boundedStart(started, permit, combined, expiresAt)
          child.run = run; child.sessionId = String(run.id)
          const result = await bounded(run.result, combined, expiresAt)
          this.#assertPermit(permit)
          child.stopReason = result.stopReason
          if (result.stopReason === 'completed') {
            const text = outputText(result.output, this.config.maxOutputBytes)
            if (text !== undefined) { advice.push(text); child.output = 'accepted' }
            else child.output = 'empty-or-oversized'
          }
        } catch {
          if (combined.aborted || Date.now() >= expiresAt) unknown = true
          else child.stopReason = 'error'
        } finally {
          const run = child.run
          if (run !== undefined) {
            child.quiescent = await this.#dispose(run)
            if (!child.quiescent) unknown = true
          }
          permit.rejected = true
          this.#permits.delete(permit.label)
        }
      }
    } finally {
      clearTimeout(timer)
      clearInterval(watchdog)
      controller.abort()
      this.#controllers.delete(controller)
      for (const child of children) {
        child.permit.rejected = true
        this.#permits.delete(child.permit.label)
        if (child.run !== undefined && !child.quiescent) {
          child.quiescent = await this.#dispose(child.run)
          if (!child.quiescent) unknown = true
        }
      }
    }
    try {
      // Disposal is the authorization boundary: a changed owner after a result
      // makes the durable outcome unknown rather than reusable advice.
      const cancelled = signal.aborted || current.signal.aborted
      try { this.#assertCurrent(parent, current) } catch { unknown = true; if (!cancelled && this.#active) parentAuthorityChanged = true }
      if (Date.now() >= expiresAt) unknown = true
      if (this.#closed) return Object.freeze({ strategyId: id, outcome: 'unknown' as const, terminationReason: 'unknown' as const, advice: [], children: [], unverified: true as const })
      const snapshot = this.#store.inspect(current.record.scope, id)!
      const finalChildren = children.filter(child => child.permit.child !== undefined).map(child => {
        const failure = this.callbacks.budget.lastFailure(child.permit.child!)
        return { sessionId: String(child.permit.child!.id), stopReason: child.stopReason, quiescent: child.quiescent,
          diagnostics: { toolRejections: child.permit.toolRejections, output: child.output, ...(failure === undefined ? {} : { failure }) } }
      })
      const outcome: GoalStrategyResult['outcome'] = unknown ? 'unknown' : cancelled ? 'cancelled'
        : advice.length === childPrompts.length && finalChildren.length === childPrompts.length ? 'advice' : 'execution-failed'
      const terminationReason: StrategyTerminationReason = Date.now() >= expiresAt ? 'deadline'
        : parentAuthorityChanged ? 'parent-authority-changed' : cancelled ? 'cancelled'
          : finalChildren.some(child => !child.quiescent) ? 'unconfirmed-stop'
            : unknown ? 'unknown' : outcome === 'advice' ? 'completed' : 'execution-failed'
      const settled = this.#store.settle(id, snapshot.version, { children: finalChildren, outcome, quiescent: finalChildren.every(child => child.quiescent), terminationReason, ...(advice.length ? { outputDigest: acceptanceDigest(advice) } : {}) }, Date.now())
      return Object.freeze({ strategyId: id, outcome: settled.outcome ?? 'unknown', terminationReason: settled.terminationReason ?? 'unknown', advice: outcome === 'advice' ? [...advice] : [], children: settled.children.map(child => ({ ...child })), unverified: true as const })
    } finally {
      release?.(); this.#operations.delete(lifetime)
    }
  }

  #prompt(input: GoalStrategyInput): string {
    return [`Task kind: ${input.kind}`, `Question: ${input.question}`, ...(input.context === undefined ? [] : [`Context (untrusted): ${input.context}`]), 'Return analysis only. Do not claim verification or take actions.'].join('\n\n')
  }

  #strategyDescriptor(agent: Agent | undefined) {
    if (agent === undefined) return undefined
    try {
      const descriptor = foldSubagentDescriptor(agent.session.snapshotEvents())
      return descriptor?.version === 3 && descriptor.mode === 'one-shot' && descriptor.provider === STRATEGY_PROVIDER ? descriptor : undefined
    } catch { throw new Error('assistant-goals: invalid strategy descriptor') }
  }

  #recognized(agent: Agent | undefined): boolean {
    if (agent === undefined) return false
    const first = agent.session.snapshotEvents().find(event => String(event.type) === 'subagent/descriptor')
    return !!first && !!first.data && typeof first.data === 'object' && (first.data as { provider?: unknown }).provider === STRATEGY_PROVIDER
  }

  #toolGuard(execution: { agent?: Agent }): string | undefined {
    const agent = execution.agent
    if (!this.#recognized(agent)) return undefined
    try {
      const permit = this.#permitFor(agent!)
      if (!this.#observedToolGuards.has(execution)) {
        this.#observedToolGuards.add(execution)
        permit.toolRejections = Math.min(1_000_000, permit.toolRejections + 1)
      }
    } catch {}
    return 'assistant-goals: strategy children cannot use tools'
  }

  #track(operation: Promise<unknown>): void {
    const done = operation.then(() => undefined, () => undefined)
    this.#operations.add(done)
    void done.finally(() => this.#operations.delete(done))
  }

  #open(): void { if (this.#closed) throw new Error('assistant-goals: strategy runtime is closed') }

  async #dispose(run: SubagentRun): Promise<boolean> {
    let disposal = this.#disposals.get(run)
    if (disposal === undefined) {
      disposal = run.dispose()
      this.#disposals.set(run, disposal)
      this.#track(disposal.finally(() => this.#runs.delete(run)))
    }
    try { await bounded(disposal, new AbortController().signal, Date.now() + 1_000); return true } catch { return false }
  }

  async #boundedStart(started: Promise<SubagentRun>, permit: Permit, signal: AbortSignal, deadline: number): Promise<SubagentRun> {
    let timely = true
    started.then(run => {
      this.#runs.add(run)
      if (!timely || permit.rejected || !this.#active) void this.#dispose(run)
    }, () => {})
    this.#track(started)
    try { return await bounded(started, signal, deadline) } finally { timely = false }
  }

  #assertCurrent(parent: Agent, expected: Current): Current {
    if (!this.#active || this.ctx.get('agents')?.get(parent.id) !== parent) throw new Error('assistant-goals: strategy parent authorization changed')
    const current = this.callbacks.current(parent)
    if (current.signal.aborted || current.run.intent.runId !== expected.run.intent.runId || current.record.id !== expected.record.id
      || current.record.definition.version !== expected.record.definition.version || current.record.definition.digest !== expected.record.definition.digest
      || !same(current.record.scope, expected.record.scope)) throw new Error('assistant-goals: strategy parent authorization changed')
    return current
  }

  #installChildGuards(agent: Agent): void {
    if (this.#guarded.has(agent)) return
    this.#guarded.add(agent)
    // These registrations belong to the child's scope, so unloading Goals
    // cannot make an already-published strategy child tool-capable again.
    const permit = this.#permitFor(agent)
    agent.ctx.tools.guard(() => 'assistant-goals: strategy children cannot use tools')
    agent.ctx.on('agent/request', async (_payload, next) => {
      this.#assertChildPermit(agent, permit)
      const request = await next()
      this.#assertChildPermit(agent, permit)
      return request
    })
  }

  #start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const descriptor = request.descriptor
    const label = descriptor.mode === 'one-shot' ? descriptor.label : undefined
    const permit = label === undefined ? undefined : this.#permits.get(label)
    const expected = label === undefined ? undefined : snapshotSubagentDescriptor({ mode: 'one-shot', provider: STRATEGY_PROVIDER, label })
    if (!this.#active || this.#closed || permit === undefined || permit.rejected || permit.starting || request.parent !== permit.parent || expected === undefined || !same(descriptor, expected)) {
      return Promise.reject(new Error('assistant-goals: strategy provider request is not admitted'))
    }
    try { this.#assertPermit(permit) } catch { return Promise.reject(new Error('assistant-goals: strategy provider authorization changed')) }
    // Reconstruct every model-affecting field from the private permit. The
    // registry request is only an admission carrier, never authority input.
    permit.starting = true
    const started = startInProcessRun({ parent: permit.parent, signal: permit.signal, label: permit.label, prompt: [...permit.prompt],
      agentOptions: { provider: permit.provider, model: permit.model, ...(permit.maxTokens === undefined ? {} : { maxTokens: permit.maxTokens }) }, maxDepth: permit.maxDepth,
      toolFilter: { allow: [] }, persona: `${STRATEGY_PROVIDER}:${permit.label}`, descriptor: expected }, {})
    started.catch(() => { permit.rejected = true })
    return started
  }

  #assertPermit(permit: Permit): Current {
    if (!this.#active || this.#closed || permit.rejected || permit.signal.aborted || Date.now() >= permit.expiresAt
      || this.ctx.get('agents')?.get(permit.parent.id) !== permit.parent
      || !this.callbacks.budget.hasMeter({ provider: permit.provider, model: permit.model })) throw new Error('assistant-goals: strategy parent authorization changed')
    const current = this.callbacks.current(permit.parent)
    if (current.signal.aborted || current.run.intent.runId !== permit.parentRunId || current.record.id !== permit.record.id
      || current.record.definition.version !== permit.record.definition.version || current.record.definition.digest !== permit.record.definition.digest
      || !same(current.record.scope, permit.record.scope)) throw new Error('assistant-goals: strategy parent authorization changed')
    return current
  }

  #permitFor(agent: Agent): Permit {
    const descriptor = this.#strategyDescriptor(agent)
    const permit = descriptor?.label === undefined ? undefined : this.#permits.get(descriptor.label)
    if (!permit || permit.child !== agent) throw new Error('assistant-goals: strategy child is not admitted')
    return permit
  }

  #assertChildPermit(agent: Agent, permit: Permit): void {
    if (permit.child !== agent || this.ctx.get('agents')?.get(agent.id) !== agent) throw new Error('assistant-goals: strategy child authorization changed')
    this.#assertPermit(permit)
  }

  /** Synchronous budget resolver: reject recognized-but-invalid children loudly. */
  #delegate(agent: Agent): ({ parent: Agent; runId: string; signal: AbortSignal; provider: string; model: string; accountingRunId: string } | undefined) {
    const descriptor = this.#strategyDescriptor(agent)
    if (descriptor === undefined) {
      if (this.#recognized(agent)) throw new Error('assistant-goals: unsupported strategy descriptor')
      return undefined
    }
    const label = descriptor.label
    const permit = label === undefined ? undefined : this.#permits.get(label)
    if (!this.#active || this.#closed || permit === undefined || permit.rejected || (permit.child !== undefined && permit.child !== agent) || Date.now() >= permit.expiresAt
      || permit.signal.aborted || this.ctx.get('agents')?.get(agent.id) !== agent
      || String(agent.session.header.parentSession) !== String(permit.parent.session.id)
      || this.ctx.get('agents')?.get(permit.parent.id) !== permit.parent) throw new Error('assistant-goals: strategy child is not admitted')
    let current: Current
    try { current = this.#assertPermit(permit) } catch { throw new Error('assistant-goals: strategy parent authorization changed') }
    const record = this.#store.inspect(permit.record.scope, permit.id)
    if (record === undefined || record.state !== 'starting' || record.intent.expiresAt !== permit.expiresAt || record.intent.parentRunId !== permit.parentRunId
      || record.intent.parentSessionId !== String(permit.parent.session.id) || record.intent.provider !== permit.provider || record.intent.model !== permit.model
      || record.intent.definitionVersion !== permit.record.definition.version || record.intent.definitionDigest !== permit.record.definition.digest) throw new Error('assistant-goals: strategy record is unavailable')
    if (permit.child === undefined) {
      try { this.#store.bindChild(permit.id, record.version, String(agent.id), Date.now()) } catch { throw new Error('assistant-goals: strategy child binding failed') }
      permit.child = agent
      this.#installChildGuards(agent)
    } else if (!record.children.some(child => child.sessionId === String(agent.id))) throw new Error('assistant-goals: strategy child binding is unavailable')
    return { parent: permit.parent, runId: permit.parentRunId, signal: AbortSignal.any([permit.signal, current.signal]), provider: permit.provider, model: permit.model, accountingRunId: `strategy-${String(agent.id)}` }
  }
}
