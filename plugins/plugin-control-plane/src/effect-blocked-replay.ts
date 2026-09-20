import { randomBytes } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { ToolExecution, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { createRuntimeSampler } from './runtime-observer.js'
import { runtimeConfigDigest, validateRuntimeObserverConfig, type RuntimeObservation, type RuntimeObserverConfig } from './runtime-observer-protocol.js'

type Agent = NonNullable<ToolExecutionInput['agent']>
export type ReplayCase =
  | { id: string; kind: 'tool'; name: string; arguments: Record<string, unknown> }
  | { id: string; kind: 'delivery'; text: string }
export interface EffectBlockedReplayInput {
  /** A fresh, idle native Agent owned by the caller. This operation consumes it. */
  handle: { agent: Agent; dispose(): Promise<void> }
  operationId: string
  requestDigest: string
  cases: readonly ReplayCase[]
  expiresAt: number
  signal: AbortSignal
}
export interface ReplayAttempt {
  caseId: string
  kind: 'tool' | 'delivery'
  callId: string
  inputDigest: string
  blockedAt: 'native-tool-guard' | 'delivery-reply-admission'
  observedAt: number
  resultDigest: string
}
export interface EffectBlockedReplayResult {
  schemaVersion: 1
  kind: 'dsh-effect-blocked-replay-observation'
  operationId: string
  requestDigest: string
  caseDigest: string
  sessionId: string
  runtime: RuntimeObservation
  runtimeDigest: string
  attempts: ReplayAttempt[]
  completedAt: number
  quiescent: true
}
interface ReplyBlock {
  contract: 'assistant-delivery/reply-replay-block/v1'
  snapshot(): { operationId: string; status: string; invalidated: boolean; attempts: readonly { sequence: number; operationId: string; inputDigest: string; observedAt: number; blocked: true }[] }
  close(): void
}
interface DeliveryPort {
  blockAgentRepliesForReplay(agent: Agent, config: { operationId: string; maximumAttempts: number; expiresAt: number }): ReplyBlock
  reply(agent: Agent, input: { idempotencyKey: string; text: string; format: 'plain' }): unknown
}
interface RunState {
  abort: AbortController
  expected?: { callId: string; name: string; inputDigest: string }
  observed?: { observedAt: number; inputDigest: string }
  violation: boolean
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u
const DENIAL = 'plugin-control-plane: effect-blocked replay tool denial'
function fail(message: string): never { throw new Error(`effect-blocked replay: ${message}`) }

/** Runtime identity excludes freshness/challenge fields, never entry/provider epochs. */
export function replayRuntimeDigest(sample: RuntimeObservation): string {
  return runtimeConfigDigest({ observerId: sample.observerId, observerConfigDigest: sample.observerConfigDigest,
    processId: sample.processId, invocationId: sample.invocationId, profilePath: sample.profilePath, entries: sample.entries })
}

export function validateReplayCases(input: unknown): { cases: ReplayCase[]; caseDigest: string } {
  // Validate before taking ownership. JSON getters, cycles and oversized input
  // are rejected by the bounded digest, then cloned to freeze the case set.
  const caseDigest = runtimeConfigDigest(input)
  const cases = structuredClone(input)
  if (!Array.isArray(cases) || cases.length < 2 || cases.length > 32
    || !cases.some(value => value?.kind === 'tool') || !cases.some(value => value?.kind === 'delivery')) fail('two to 32 cases of both effect classes required')
  const ids = new Set<string>()
  for (const item of cases) {
    if (!item || typeof item.id !== 'string' || !ID.test(item.id) || ids.has(item.id)) fail('case identity is invalid or repeated')
    ids.add(item.id)
    if (item.kind === 'tool') {
      if (typeof item.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u.test(item.name)
        || !item.arguments || typeof item.arguments !== 'object' || Array.isArray(item.arguments)
        || Object.keys(item).sort().join(',') !== 'arguments,id,kind,name') fail('tool case invalid')
    } else if (item.kind === 'delivery') {
      if (typeof item.text !== 'string' || !item.text.length || Buffer.byteLength(item.text) > 4096
        || Object.keys(item).sort().join(',') !== 'id,kind,text') fail('delivery case invalid')
    } else fail('unknown effect class')
  }
  return { cases, caseDigest }
}

/**
 * Host-only finite rehearsal. It issues no Host attestation and never changes an
 * activation plan. Native monotonic guards block tool bodies; the current
 * Delivery provider blocks actual reply admission before any Outbox write.
 * This is not an OS sandbox or a guarantee about arbitrary plugin JS/hooks.
 */
export class EffectBlockedReplayRuntime {
  private readonly states = new WeakMap<Agent, RunState>()
  private readonly operations = new Set<string>()
  private readonly flights = new Set<Promise<unknown>>()
  private readonly cancellations = new Set<AbortController>()
  private readonly sample: (challenge: string) => RuntimeObservation
  private readonly config: RuntimeObserverConfig
  private readonly providers: Array<{ name: string; implementation: unknown; store: unknown }>
  private closed = false

  constructor(private readonly ctx: Context, input: RuntimeObserverConfig) {
    validateRuntimeObserverConfig(input)
    this.config = structuredClone(input)
    if (ctx.agent !== undefined) fail('runtime must belong to a Host Fiber, not an Agent')
    if (typeof ctx.tools?.guard !== 'function' || !ctx.get('loader', false)) fail('native Tools and Loader required')
    this.delivery()
    this.providers = ['tools', 'loader', 'assistantDelivery', 'agents'].map(name => {
      const implementation = ctx.reflect.store[ctx[Context.isolate][name]!]
      if (!implementation) fail(`missing ${name} provider`)
      return { name, implementation, store: implementation!.fiber.store }
    })
    this.sample = createRuntimeSampler(ctx, this.config)
    ctx.effect(() => {
      const remove = ctx.tools.guard(execution => this.guard(execution))
      return async () => {
        this.closed = true
        for (const abort of this.cancellations) abort.abort()
        // Keep the monotonic guard until all admitted native calls settle.
        await Promise.allSettled(this.flights)
        remove()
      }
    }, 'plugin-control-plane.effect-blocked-replay')
  }

  private delivery(): DeliveryPort {
    const value = this.ctx.get('assistantDelivery' as never, false) as unknown as DeliveryPort | undefined
    if (!value || typeof value.blockAgentRepliesForReplay !== 'function' || typeof value.reply !== 'function') fail('current Delivery replay admission API required')
    return value!
  }

  private guard(execution: Readonly<ToolExecution>): string | undefined {
    if (!execution.agent) return
    const state = this.states.get(execution.agent)
    if (!state) return
    const expected = state.expected
    const inputDigest = runtimeConfigDigest(execution.arguments)
    if (!expected || state.observed || expected.callId !== execution.callId || expected.name !== execution.name
      || expected.inputDigest !== inputDigest || state.abort.signal.aborted || this.closed) {
      state.violation = true
      state.abort.abort()
    } else state.observed = { observedAt: Date.now(), inputDigest }
    // Tombstones stay in the WeakMap after success, failure or cancellation.
    return DENIAL
  }

  run(input: EffectBlockedReplayInput): Promise<EffectBlockedReplayResult> {
    if (this.closed || this.operations.size >= 1024 || typeof input.operationId !== 'string' || !ID.test(input.operationId)
      || !/^[a-f0-9]{64}$/u.test(input.requestDigest) || this.operations.has(input.operationId)) fail('closed, duplicate or invalid operation')
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 60_000) fail('deadline must be within 60 seconds')
    const { cases, caseDigest } = validateReplayCases(input.cases)
    const agent = input.handle.agent
    if (!agent || typeof input.handle.dispose !== 'function' || agent.status !== 'idle'
      || agent.ctx.agent !== agent || this.states.has(agent)) fail('fresh idle native Agent handle required')
    if (agent.inbox.hasPending || agent.session.snapshotEvents().some(event =>
      ['turn/start', 'user/message', 'assistant/message', 'tool/result'].includes(event.type))) fail('replay requires an unused Agent session')
    this.assertProviders()
    if (this.ctx.agents.get(agent.id) !== agent) fail('Agent is not registered in this Host')
    for (const name of ['tools', 'assistantDelivery']) {
      if (agent.ctx.reflect.store[agent.ctx[Context.isolate][name]!] !== this.ctx.reflect.store[this.ctx[Context.isolate][name]!]) fail(`Agent ${name} realm differs from replay Host`)
    }
    input.signal.throwIfAborted()
    const state: RunState = { abort: new AbortController(), violation: false }
    this.states.set(agent, state); this.operations.add(input.operationId); this.cancellations.add(state.abort)
    const flight = this.execute({ ...input, cases }, caseDigest, state)
    this.flights.add(flight)
    void flight.finally(() => { this.flights.delete(flight); this.cancellations.delete(state.abort) }).catch(() => {})
    return flight
  }

  private async execute(input: EffectBlockedReplayInput, caseDigest: string, state: RunState): Promise<EffectBlockedReplayResult> {
    const agent = input.handle.agent
    const cancel = () => state.abort.abort()
    input.signal.addEventListener('abort', cancel, { once: true })
    const timer = setTimeout(cancel, Math.max(1, input.expiresAt - Date.now()))
    let block: ReplyBlock | undefined
    let result: EffectBlockedReplayResult | undefined
    const assertCurrent = () => {
      state.abort.signal.throwIfAborted()
      if (this.closed || state.violation || Date.now() >= input.expiresAt || agent.status !== 'idle' || agent.inbox.hasPending) fail('replay was interrupted or changed')
      this.assertProviders()
    }
    try {
      assertCurrent()
      const runtime = this.sample(randomBytes(32).toString('hex'))
      if (!runtime.entries.every(entry => entry.active)) fail('candidate or dependency is inactive')
      const runtimeDigest = replayRuntimeDigest(runtime)
      const stable = () => {
        assertCurrent()
        if (replayRuntimeDigest(this.sample(randomBytes(32).toString('hex'))) !== runtimeDigest) fail('candidate/provider generation changed')
      }
      const delivery = this.delivery()
      block = delivery.blockAgentRepliesForReplay(agent, { operationId: input.operationId,
        maximumAttempts: input.cases.filter(item => item.kind === 'delivery').length, expiresAt: input.expiresAt })
      if (block.contract !== 'assistant-delivery/reply-replay-block/v1') fail('reply blocker contract mismatch')
      const attempts: ReplayAttempt[] = []
      for (const item of input.cases) {
        stable()
        const callId = `${input.operationId}:${item.id}`
        if (item.kind === 'tool') {
          const inputDigest = runtimeConfigDigest(item.arguments)
          state.expected = { callId, name: item.name, inputDigest }; delete state.observed
          const outcome = await agent.ctx.tools.execute({ callId: callId as ToolExecutionInput['callId'], name: item.name,
            arguments: item.arguments, agent, signal: state.abort.signal })
          delete state.expected
          stable()
          const observed = this.states.get(agent)?.observed
          if (!observed || !outcome.isError || outcome.error.message !== DENIAL) throw new Error('effect-blocked replay: native monotonic denial was not observed')
          attempts.push({ caseId: item.id, kind: item.kind, callId, inputDigest, blockedAt: 'native-tool-guard',
            observedAt: observed.observedAt, resultDigest: runtimeConfigDigest(outcome) })
        } else {
          const before = block.snapshot()
          const reply = { idempotencyKey: callId, text: item.text, format: 'plain' as const }
          const inputDigest = runtimeConfigDigest({ ...reply, modelPicker: null, permissionPicker: null, replyToEventId: null })
          let denied = false
          try { this.delivery().reply(agent, reply) } catch (error) {
            denied = error instanceof Error && 'code' in error && error.code === 'reply-replay-blocked'
              && 'operationId' in error && error.operationId === input.operationId
          }
          const after = block.snapshot(); const attempt = after.attempts.at(-1)
          stable()
          if (!denied || before.invalidated || after.invalidated || before.status !== 'active' || !['active', 'attempt-limit'].includes(after.status) || after.operationId !== input.operationId
            || after.attempts.length !== before.attempts.length + 1 || !attempt || !attempt.blocked
            || attempt.sequence !== after.attempts.length || attempt.operationId !== input.operationId || attempt.inputDigest !== inputDigest) {
            throw new Error('effect-blocked replay: actual Delivery reply denial was not observed')
          }
          attempts.push({ caseId: item.id, kind: item.kind, callId, inputDigest,
            blockedAt: 'delivery-reply-admission', observedAt: attempt.observedAt, resultDigest: runtimeConfigDigest(attempt) })
        }
      }
      stable()
      result = { schemaVersion: 1, kind: 'dsh-effect-blocked-replay-observation', operationId: input.operationId,
        requestDigest: input.requestDigest, caseDigest, sessionId: String(agent.session.id), runtime, runtimeDigest,
        attempts, completedAt: Date.now(), quiescent: true }
    } finally {
      delete state.expected
      block?.close()
      state.abort.abort()
      clearTimeout(timer); input.signal.removeEventListener('abort', cancel)
      // The caller hands over the native ownership capability, not a bare
      // cached Agent. No observation escapes before that Agent is reclaimed.
      await input.handle.dispose()
    }
    if (!result || state.violation || block?.snapshot().invalidated) fail('unsettled or extra replay calls')
    if (this.closed || input.signal.aborted || Date.now() >= input.expiresAt) fail('replay expired during Agent cleanup')
    this.assertProviders()
    if (this.ctx.agents.get(agent.id) !== undefined) fail('native Agent was not reclaimed')
    if (replayRuntimeDigest(this.sample(randomBytes(32).toString('hex'))) !== result!.runtimeDigest) fail('candidate changed during Agent cleanup')
    result!.completedAt = Date.now()
    return structuredClone(result)
  }

  /** Cached observations remain usable only in this exact sampler/provider generation. */
  isCurrent(result: EffectBlockedReplayResult): boolean {
    if (this.closed) return false
    try {
      this.assertProviders()
      return replayRuntimeDigest(this.sample(randomBytes(32).toString('hex'))) === result.runtimeDigest
    } catch { return false }
  }

  private assertProviders(): void {
    for (const provider of this.providers) {
      const current = this.ctx.reflect.store[this.ctx[Context.isolate][provider.name]!]
      if (current !== provider.implementation || current?.fiber.store !== provider.store) fail(`${provider.name} provider changed`)
    }
  }
}
