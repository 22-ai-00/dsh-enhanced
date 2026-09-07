import { randomUUID } from 'node:crypto'
import type { Context, FiberState } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentSetup, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionLease, SessionLeaseClaim, SessionLeaseTarget } from './session-lease-types.js'

// Cordis publishes this as an erased const enum. Keep the value type-checked
// against its exact member without requiring a nonexistent runtime export.
const activeFiberState: FiberState.ACTIVE = 2

export interface SessionLeasePort {
  leaseMs: number
  /** Whether this durable Session is Delivery-owned and must have a local execution lease. */
  requiresLease(sessionId: string): boolean
  claim(target: SessionLeaseTarget, holderId: string, leaseMs: number): SessionLeaseClaim
  dispatch(lease: SessionLease): boolean
  valid(lease: SessionLease): boolean
  renew(lease: SessionLease, leaseMs: number): boolean
  finish(lease: SessionLease, input: { quiescent: boolean }): boolean
}
export class SessionLeaseUnavailable extends Error {
  constructor(readonly kind: 'busy' | 'unknown' | 'denied') {
    super(`assistant-delivery: session execution ${kind}`)
  }
}

/** One process-local owner of a durable token. Unknown is never a takeover grant. */
export class SessionExecutionLease {
  readonly controller = new AbortController()
  readonly agents = new Map<Agent, boolean>()
  #closed = false
  #released = false
  #pending = 0
  #unobservedCleanup = false
  #timer: ReturnType<typeof setInterval>
  #removeAbort: () => void
  constructor(readonly token: SessionLease, private readonly port: SessionLeasePort,
    outer: AbortSignal, private readonly released: () => void) {
    const abort = () => this.cancel(outer.reason)
    outer.addEventListener('abort', abort, { once: true })
    this.#removeAbort = () => outer.removeEventListener('abort', abort)
    this.#timer = setInterval(() => {
      try { if (port.renew(token, port.leaseMs)) return } catch {}
      this.cancel()
    }, Math.max(1, Math.floor(port.leaseMs / 3)))
    this.#timer.unref?.()
    if (outer.aborted) abort()
  }
  get signal(): AbortSignal { return this.controller.signal }
  assert(): void {
    if (this.#closed || this.#released || this.signal.aborted) throw new SessionLeaseUnavailable('denied')
    try { if (this.port.valid(this.token)) return } catch {}
    this.cancel()
    throw new SessionLeaseUnavailable('denied')
  }
  assertAgent(agent: Agent): void {
    this.assert()
    if (this.agents.get(agent) !== false) throw new SessionLeaseUnavailable('denied')
  }
  dispatch(): void {
    this.assert()
    if (!this.port.dispatch(this.token)) { this.cancel(); throw new SessionLeaseUnavailable('denied') }
  }
  attach(agent: Agent): void { this.assert(); this.agents.set(agent, false) }
  disposed(agent: Agent): void {
    if (this.agents.has(agent)) this.agents.set(agent, true)
    this.#settle()
  }
  enter(): () => void {
    this.assert()
    this.#pending += 1
    let done = false
    return () => { if (done) return; done = true; this.#pending -= 1; this.#settle() }
  }
  cancel(reason: unknown = new SessionLeaseUnavailable('denied')): void {
    if (!this.signal.aborted) this.controller.abort(reason)
    for (const [agent, disposed] of this.agents) if (!disposed) {
      try { agent.cancel({ kind: 'hook', reason: 'assistant-delivery-session-lease-lost' }) } catch {}
    }
  }
  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearInterval(this.#timer)
    this.#removeAbort()
    this.#settle()
  }
  /** A rejected cold resume can leave an unobservable, abort-raced load behind. */
  abandonConstruction(): void {
    this.#unobservedCleanup = true
    this.cancel()
    this.close()
  }
  #settle(): void {
    if (!this.#closed || this.#released) return
    const quiescent = !this.#unobservedCleanup && this.#pending === 0 && [...this.agents.values()].every(Boolean)
    try {
      if (this.port.finish(this.token, { quiescent }) && quiescent) {
        this.#released = true
        this.released()
      }
    } catch { /* Store outage keeps the durable dispatched/unknown fence occupied. */ }
  }
}

/** Shared by bound foreground work and unbound Session construction; wake must use this same port. */
export class DeliverySessionLeases {
  readonly #active = new Map<string, SessionExecutionLease>()
  readonly #agents = new WeakMap<Agent, SessionExecutionLease>()
  #factoryGeneration = 0
  #live = true
  constructor(private readonly ctx: Context, private readonly port: SessionLeasePort) {
    // Cordis synchronously notifies availability transitions and replacement.
    // A new live provider must not make an old factory's abort look settled.
    ctx.on('internal/service', name => {
      if (name === 'agentLoop') this.#factoryGeneration += 1
    })
    const nativeInput = ({ agent, message }: { agent: Agent; message: UserMessage }): void => {
      // Web can borrow the exact live Agent, not just resume a second object.
      // Native direct-user ingress is not a Delivery owner admission. Invalidate
      // the whole lease so a queued/steered turn cannot run after cancellation.
      if (message.source === undefined || message.source.kind === 'user') this.#agents.get(agent)?.cancel()
    }
    ctx.on('agent/inbox/inserted', nativeInput, { prepend: true })
    ctx.on('agent/inbox/claimed', nativeInput, { prepend: true })
    ctx.on('agent/request', async ({ agent }, next) => {
      this.#assertAgent(agent)
      const result = await next()
      this.#assertAgent(agent)
      return result
    }, { prepend: true })
    ctx.on('tools/pre-execute', async ({ agent }, next) => {
      this.#assertAgent(agent)
      const result = await next()
      this.#assertAgent(agent)
      return result
    }, { prepend: true })
    ctx.on('tools/execute', async ({ agent }, next) => {
      const lease = this.#assertAgent(agent)
      const done = lease?.enter()
      try {
        const result = await next()
        this.#assertAgent(agent)
        return result
      } finally { done?.() }
    }, { prepend: true })
    ctx.inject(['tools'], runtime => runtime.tools.guard(({ agent }) => {
      try { this.#assertAgent(agent); return undefined }
      catch { return 'assistant-delivery: session lease no longer authorizes this tool' }
    }))
    ctx.on('llm/stream', this.#stream.bind(this), { prepend: true })
    ctx.effect(() => () => {
      this.#live = false
      for (const lease of this.#active.values()) { lease.cancel(); lease.close() }
    }, 'assistant-delivery.session-leases')
  }
  get leaseMs(): number { return this.port.leaseMs }

  /**
   * Use the host's one factory and the caller's ownership scope. These methods
   * only consume an already admitted lease; they do not authorize Web input.
   */
  create(owner: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const agents = owner.reflect.trace(this.ctx.agents)
    return this.#construct(owner, 'create', String(options.sessionId), options, (setup, signal) =>
      agents.create({ ...options, setup, signal }))
  }
  resume(owner: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const agents = owner.reflect.trace(this.ctx.agents)
    return this.#construct(owner, 'resume', String(options.resumeSessionId), options, (setup, signal) =>
      agents.resume({ ...options, setup, signal }))
  }

  async #construct(owner: Context, kind: 'create' | 'resume', sessionId: string, options: { setup?: AgentSetup; signal?: AbortSignal },
    factory: (setup: AgentSetup, signal: AbortSignal) => Promise<AgentHandle>): Promise<AgentHandle> {
    const lease = this.#active.get(sessionId)
    if (lease === undefined) throw new SessionLeaseUnavailable('denied')
    lease.assert()
    options.signal?.throwIfAborted()
    const ownerAbort = new AbortController()
    let constructing = true
    const unwatchOwner = owner.effect(() => () => {
      if (constructing) ownerAbort.abort(new SessionLeaseUnavailable('denied'))
    }, 'assistant-delivery.agent-construction')
    const signal = AbortSignal.any([lease.signal, ownerAbort.signal, ...(options.signal === undefined ? [] : [options.signal])])
    const factoryGeneration = this.#factoryGeneration
    const nativeFactory = this.ctx.get('agentLoop' as never) !== undefined
    // A cold persistence load may not have produced an Agent yet. It still
    // occupies the lease until the factory settles and native rollback drains.
    let finishConstruction: (() => void) | undefined
    let prepared: Agent | undefined
    let native: AgentHandle | undefined
    try {
      finishConstruction = lease.enter()
      native = await factory(async agentCtx => {
        const agent = agentCtx.agent
        if (agent === undefined || String(agent.session.id) !== sessionId) throw new SessionLeaseUnavailable('denied')
        lease.attach(agent)
        this.#agents.set(agent, lease)
        prepared = agent
        const setup = await options.setup?.(agentCtx)
        lease.assertAgent(agent)
        // Preserve the native setup commit and revalidate at publication, not
        // just before the last async setup operation returns.
        return { commit: () => {
          lease.assertAgent(agent)
          setup?.commit()
          lease.assertAgent(agent)
        } }
      }, signal)
      if (native.agent !== prepared) throw new SessionLeaseUnavailable('denied')
      lease.assertAgent(native.agent)
      const handle = native
      let disposal: Promise<void> | undefined
      const drain = (): Promise<void> => disposal ??= Promise.resolve().then(() => handle.dispose())
        .then(() => lease.disposed(handle.agent))
      let detached = false
      // Controller consumers may retain only the Agent. The owner's fiber
      // must still await the native memoized disposer, not merely observe an
      // idle status or a registry notification. This also covers concurrent
      // teardown by the upstream factory's own owner effect.
      const detachOwner = owner.effect(() => async () => {
        if (detached) return
        detached = true
        lease.cancel()
        lease.close()
        await drain()
      }, 'assistant-delivery.owned-agent')
      return { agent: handle.agent, dispose: async () => {
        await drain()
        if (!detached) { detached = true; await detachOwner() }
      } }
    } catch (error) {
      // rc.1 races prepare against caller, owner and factory cancellation.
      // Only an unchanged live native factory + live owner + non-aborted
      // caller rules out all three abort branches. Otherwise the rejected
      // public Promise says nothing about late preparation cleanup. Error
      // names/text are deliberately not a settlement or release capability.
      const loadSettled = nativeFactory && this.#live && !signal.aborted
        && owner.fiber.state === activeFiberState
        && factoryGeneration === this.#factoryGeneration
        && this.ctx.get('agentLoop' as never) !== undefined
      if (kind === 'resume' && prepared === undefined && !loadSettled) lease.abandonConstruction()
      // Once setup has received an Agent, rc.1 awaits its native rollback.
      // Unpublished setup has no agent/disposed event: remember its exact
      // object rather than marking every Agent with the same Session disposed.
      if (native !== undefined) await native.dispose()
      if (prepared !== undefined) lease.disposed(prepared)
      throw error
    } finally {
      constructing = false
      try { await unwatchOwner() } finally { finishConstruction?.() }
    }
  }
  open(target: SessionLeaseTarget, signal: AbortSignal): SessionExecutionLease {
    if (!this.#live) throw new SessionLeaseUnavailable('denied')
    signal.throwIfAborted()
    const claim = this.port.claim(target, `delivery-session-${randomUUID()}`, this.port.leaseMs)
    if (claim.kind !== 'claimed') throw new SessionLeaseUnavailable(claim.kind)
    const lease = new SessionExecutionLease(claim.lease, this.port, signal, () => {
      if (this.#active.get(claim.lease.sessionId) === lease) this.#active.delete(claim.lease.sessionId)
    })
    this.#active.set(claim.lease.sessionId, lease)
    return lease
  }
  attach(agent: Agent): void {
    const lease = this.#active.get(String(agent.session.id))
    if (lease === undefined) throw new SessionLeaseUnavailable('denied')
    lease.attach(agent)
    this.#agents.set(agent, lease)
  }
  assert(sessionId: string): void {
    const lease = this.#active.get(sessionId)
    if (lease === undefined) throw new SessionLeaseUnavailable('denied')
    lease.assert()
  }
  cancel(sessionId: string, reason: unknown): void { this.#active.get(sessionId)?.cancel(reason) }
  disposed(agent: Agent): void { this.#agents.get(agent)?.disposed(agent) }
  async *#stream(_options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const agent = this.ctx.get('agents')?.currentInitiator()
    const lease = this.#assertAgent(agent)
    const done = lease?.enter()
    try {
      for await (const chunk of next()) { this.#assertAgent(agent); yield chunk }
      this.#assertAgent(agent)
    } finally { done?.() }
  }
  #assertAgent(agent: Agent | undefined): SessionExecutionLease | undefined {
    if (agent === undefined) return undefined
    const lease = this.#agents.get(agent)
    if (lease !== undefined) {
      lease.assertAgent(agent)
      return lease
    }
    try {
      if (!this.port.requiresLease(String(agent.session.id))) return undefined
    } catch {
      // A failed ownership lookup must not grant native/Web execution.
    }
    try { agent.cancel({ kind: 'hook', reason: 'assistant-delivery-session-lease-required' }) } catch {}
    throw new SessionLeaseUnavailable('denied')
  }
}
