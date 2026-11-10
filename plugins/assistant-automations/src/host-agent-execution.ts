import { types } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { AutomationRunnerInput, AutomationRunnerResult } from './coordinator.js'
import { runHostNativeAgent, type DshAutomationRunnerOptions } from './native-agent-execution.js'
import type { HostAgentAuthorizationFence, HostAgentExecutionContract, HostAgentExecutionResult, HostAutomationExecutorInput } from './types.js'

/** Codepoint order, independent of host locale. Includes the complete schema objects. */
export function hostAgentToolSchemaDigest(schemas: readonly { name: string }[]): string {
  const names = schemas.map(schema => schema.name)
  if (names.some(name => typeof name !== 'string' || name.length === 0) || new Set(names).size !== names.length) throw new Error('assistant-automations: invalid tool schema names')
  return acceptanceDigest([...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}
function contractSnapshot(value: HostAgentExecutionContract): Readonly<HostAgentExecutionContract> {
  const contract = structuredClone(value)
  const keys = ['provider','model','reasoningEffort','prompt','allowedTools','toolSchemaDigest','maxModelCalls','maxToolCalls','maxOutputTokens','timeoutMs','acceptance']
  if (Object.keys(contract).some(key => !keys.includes(key)) || typeof contract.provider !== 'string' || !contract.provider.trim()
    || typeof contract.model !== 'string' || !contract.model.trim() || typeof contract.prompt !== 'string' || !contract.prompt.trim()
    || Buffer.byteLength(contract.prompt) > 65536 || contract.reasoningEffort !== undefined && (typeof contract.reasoningEffort !== 'string' || !contract.reasoningEffort.trim())
    || !Array.isArray(contract.allowedTools) || contract.allowedTools.some(name => typeof name !== 'string' || !name.trim())
    || new Set(contract.allowedTools).size !== contract.allowedTools.length || !/^[a-f0-9]{64}$/u.test(contract.toolSchemaDigest)
    || !Number.isSafeInteger(contract.maxModelCalls) || contract.maxModelCalls < 1 || contract.maxModelCalls > 100
    || !Number.isSafeInteger(contract.maxToolCalls) || contract.maxToolCalls < 0 || contract.maxToolCalls > 1000
    || !Number.isSafeInteger(contract.maxOutputTokens) || contract.maxOutputTokens < 1 || contract.maxOutputTokens > 131072
    || !Number.isSafeInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 3600000) throw new Error('assistant-automations: invalid Host Agent contract')
  const { acceptance, reasoningEffort, ...required } = contract
  if (acceptance !== undefined && (acceptance === null || typeof acceptance !== 'object'
    || Object.keys(acceptance).length !== 3 || !['required', 'objective', 'sourceDigest'].every(key => Object.hasOwn(acceptance, key))
    || acceptance.required !== true || typeof acceptance.objective !== 'string' || !acceptance.objective.trim()
    || Buffer.byteLength(acceptance.objective, 'utf8') > 8_192 || acceptance.objective.includes('\0')
    || typeof acceptance.sourceDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(acceptance.sourceDigest))) {
    throw new Error('assistant-automations: invalid Host Agent acceptance requirement')
  }
  return Object.freeze({ ...required, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), allowedTools: Object.freeze([...contract.allowedTools].sort()),
    ...(acceptance === undefined ? {} : { acceptance: Object.freeze(acceptance) }) })
}
function authorizationSnapshot(value: HostAgentAuthorizationFence): Readonly<HostAgentAuthorizationFence> {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('assistant-automations: invalid authorization fence')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(value).length !== 2 || !['signal','assertCurrent'].every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key]!, 'value'))) throw new Error('assistant-automations: authorization fence requires own data fields')
  const signal: unknown = descriptors.signal!.value, callback: unknown = descriptors.assertCurrent!.value
  if (typeof callback !== 'function' || types.isProxy(callback) || types.isAsyncFunction(callback)) throw new Error('assistant-automations: authorization fence must be synchronous')
  try { Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!.call(signal) } catch { throw new Error('assistant-automations: authorization fence signal is invalid') }
  return Object.freeze({ signal: signal as AbortSignal, assertCurrent: callback as () => void })
}
interface Invocation {
  readonly input: AutomationRunnerInput
  readonly controller: AbortController
  readonly signal: AbortSignal
  readonly markObjectiveUnverified?: () => void
  active: boolean
  consumed: boolean
  pending?: Promise<AutomationRunnerResult>
  drain?: Promise<void>
  finished?: boolean
  result?: AutomationRunnerResult
  observed?: AutomationRunnerResult
  readObservation?: () => AutomationRunnerResult
}
/** Internal capability owner. This object and its runner key never leave the service. */
export class HostAgentExecutions {
  readonly #key = Object.freeze({})
  readonly #invocations = new WeakMap<object, Invocation>()
  readonly #live = new Set<Invocation>()
  #active = true
  #accepting = true
  constructor(private readonly ctx: Context, private readonly policy: AssistantPolicyService,
    private readonly prepareAcceptance: NonNullable<DshAutomationRunnerOptions['prepareAcceptance']>) {}
  runnerKey(): object { return this.#key }
  open(key: object, invocation: Readonly<HostAutomationExecutorInput>, input: AutomationRunnerInput, freshReservation: boolean, publish: (result: AutomationRunnerResult) => void): (() => Promise<AutomationRunnerResult | undefined>) | undefined {
    if (key !== this.#key || !this.#active || !this.#accepting || !freshReservation || input.occurrence.dryRun || input.task.attemptCount !== 1
      || input.automation.definition.retrySafety !== 'never' || input.automation.definition.maxRetries !== 0
      || input.automation.definition.budgetId === undefined || input.signal.aborted || invocation.signal.aborted) return undefined
    const controller = new AbortController()
    const snapshot = JSON.parse(JSON.stringify({ automation: input.automation, occurrence: input.occurrence, task: input.task, sessionId: input.sessionId })) as Omit<AutomationRunnerInput, 'signal'>
    const state: Invocation = { input: { ...snapshot, signal: input.signal }, controller, signal: AbortSignal.any([invocation.signal, controller.signal]), active: true, consumed: false,
      ...(input.markObjectiveUnverified === undefined ? {} : { markObjectiveUnverified: input.markObjectiveUnverified }) }
    this.#invocations.set(invocation, state); this.#live.add(state)
    return async () => {
      observeInvocation(state)
      state.active = false
      this.#invocations.delete(invocation)
      state.controller.abort('host-executor-ended')
      try {
        if (state.pending) await drainInvocation(state)
        if (state.consumed && !state.finished) throw new Error('assistant-automations: executor abandoned its Agent execution')
        return state.result
      } finally {
        observeInvocation(state)
        const receipt = state.result ?? state.observed
        if (receipt !== undefined) publish(receipt)
        this.#live.delete(state)
      }
    }
  }
  run(invocation: HostAutomationExecutorInput, value: HostAgentExecutionContract, authorization?: HostAgentAuthorizationFence): Promise<Readonly<HostAgentExecutionResult>> {
    const execution = this.execute(invocation, value, authorization)
    void execution.catch(() => {})
    return execution
  }
  private async execute(invocation: HostAutomationExecutorInput, value: HostAgentExecutionContract, authorization?: HostAgentAuthorizationFence): Promise<Readonly<HostAgentExecutionResult>> {
    const state = this.#invocations.get(invocation)
    if (!this.#active || !this.#accepting || !state?.active || state.consumed || state.signal.aborted) throw new Error('assistant-automations: exact live reserved Host invocation is required')
    const fence = authorization === undefined ? undefined : authorizationSnapshot(authorization)
    const contract = contractSnapshot(value)
    if (contract.acceptance !== undefined && fence === undefined) throw new Error('assistant-automations: required Host Agent acceptance needs an authorization fence')
    if (contract.timeoutMs > state.input.automation.definition.timeoutMs) throw new Error('assistant-automations: Host Agent deadline exceeds occurrence contract')
    const contractDigest = acceptanceDigest(contract)
    const now = Date.now(), startedAt = state.input.task.updatedAt
    const occurrenceDeadlineAt = startedAt + state.input.automation.definition.timeoutMs
    if (!Number.isSafeInteger(startedAt) || startedAt > now || !Number.isSafeInteger(occurrenceDeadlineAt)) throw new Error('assistant-automations: Host occurrence start time is invalid')
    const deadlineAt = Math.min(occurrenceDeadlineAt, now + contract.timeoutMs)
    const deadline = new AbortController()
    const signal = AbortSignal.any([state.signal, deadline.signal, ...(fence === undefined ? [] : [fence.signal])])
    // Contract cloning can invoke getters which synchronously consume or revoke this invocation.
    if (!this.#active || !this.#accepting || this.#invocations.get(invocation) !== state
      || !state.active || state.consumed || state.signal.aborted) throw new Error('assistant-automations: exact live reserved Host invocation is required')
    const check = () => {
      if (Date.now() >= deadlineAt) deadline.abort('host-agent-deadline')
      signal.throwIfAborted()
      if (!this.#active || !this.#accepting || this.#invocations.get(invocation) !== state || !state.active) throw new Error('assistant-automations: Host Agent invocation is no longer active')
    }
    check()
    state.consumed = true
    // Publish the monotonic reduction before any await/create/model call. The
    // coordinator can commit an abort result before this invocation drains.
    state.markObjectiveUnverified?.()
    const authorize = fence === undefined ? undefined : () => {
      try {
        check()
        const result: unknown = fence.assertCurrent()
        // Best-effort rejection observation for ordinary built-in Promises, not hostile constructor/species objects.
        if (types.isPromise(result)) void Promise.prototype.then.call(result, () => {}, () => {})
        if (result !== undefined) throw new Error('assistant-automations: authorization fence must return synchronously without a value')
        check()
      } catch (error) {
        state.active = false
        this.#invocations.delete(invocation)
        state.controller.abort('host-agent-authorization-revoked')
        throw error
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    let removeAbort: (() => void) | undefined
    try {
      authorize?.()
      timer = setTimeout(() => deadline.abort('host-agent-deadline'), Math.max(0, deadlineAt - Date.now()))
      timer.unref?.()
      const pending = runHostNativeAgent(this.ctx, this.policy, state.input, contract, contractDigest, signal, Object.freeze({ deadlineAt, check, ...(authorize === undefined ? {} : { authorize }),
        observe: (read: () => AutomationRunnerResult) => { if (state.active && !signal.aborted) state.readObservation = read } }), this.prepareAcceptance)
      state.pending = pending
      // Observe rejection even when a faulty executor drops its returned promise.
      void pending.catch(() => {})
      const cancelled = new Promise<never>((_, reject) => {
        const abort = () => reject(new Error('assistant-automations: Host Agent interrupted'))
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true })
        removeAbort = () => signal.removeEventListener('abort', abort)
      })
      const result = await Promise.race([pending, cancelled])
      authorize?.()
      check()
      const snapshot = snapshotResult(result)
      check()
      state.result = contract.acceptance === undefined ? snapshot : Object.freeze({ ...snapshot,
        usage: Object.freeze({ ...snapshot.usage, hostAcceptanceExecutionContractDigest: contractDigest,
          hostAcceptanceNativeOutcome: snapshot.outcome, hostAcceptanceSourceDigest: contract.acceptance.sourceDigest }) })
      state.finished = true
      return Object.freeze({ ...snapshot, contractDigest })
    } finally { removeAbort?.(); clearTimeout(timer); if (signal.aborted) await drainInvocation(state) }
  }
  suspend(): void {
    this.#accepting = false
    for (const state of this.#live) { state.active = false; state.controller.abort('automations-stopped') }
  }
  resume(): void { if (this.#active) this.#accepting = true }
  async drain(): Promise<void> { await Promise.all([...this.#live].map(async state => { if (state.pending) await drainInvocation(state) })) }
  async dispose(): Promise<void> { this.#active = false; this.suspend(); await this.drain() }
}
/** Audit-only lower bound, sampled even when authorization or teardown is no longer confirmed. */
function observeInvocation(state: Invocation): void {
  try {
    const observation = state.readObservation?.()
    if (!observation || observation.sessionId !== state.input.sessionId) return
    const usage: Record<string, unknown> = { observedPartial: true }
    for (const [key, value] of Object.entries(observation.usage)) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) continue
      const prior = state.observed?.usage[key]
      usage[key] = typeof prior === 'number' ? Math.max(prior, value) : value
    }
    state.observed = snapshotResult({ outcome: 'unknown', output: '', sessionId: observation.sessionId,
      usage, quiescent: false })
  } catch { /* Retain any prior observation; missing audit data never authorizes success. */ }
}
function snapshotResult(result: AutomationRunnerResult): AutomationRunnerResult {
  const descriptors = Object.getOwnPropertyDescriptors(result)
  const allowed = new Set(['outcome','output','usage','sessionId','diagnostic','quiescent'])
  if (Reflect.ownKeys(result).some(key => typeof key !== 'string' || !allowed.has(key))
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
    || !['outcome','output','usage'].every(key => Object.hasOwn(descriptors, key))) throw new Error('assistant-automations: native receipt shape is invalid')
  const body = Object.fromEntries(Object.entries(descriptors).filter(([key, descriptor]) => descriptor.value !== undefined || ['outcome','output','usage'].includes(key))
    .map(([key, descriptor]) => [key, descriptor.value]))
  const detached = JSON.parse(acceptanceCanonicalJson(body)) as AutomationRunnerResult
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== 'object') return
    for (const item of Object.values(value)) freeze(item)
    Object.freeze(value)
  }
  freeze(detached)
  return detached
}
function drainInvocation(state: Invocation): Promise<void> {
  // Do not cache empty success: consumption may not have started yet.
  if (!state.pending) return Promise.resolve()
  return state.drain ??= boundedDrain(state.pending)
}
async function boundedDrain(pending: Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([pending.then(() => {}, () => {}), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('assistant-automations: Host Agent teardown unconfirmed')), 2000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
