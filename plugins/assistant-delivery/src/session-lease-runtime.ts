import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionLease, SessionLeaseClaim, SessionLeaseTarget } from './session-lease-types.js'

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
  #settle(): void {
    if (!this.#closed || this.#released) return
    const quiescent = this.#pending === 0 && [...this.agents.values()].every(Boolean)
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
  #live = true
  constructor(private readonly ctx: Context, private readonly port: SessionLeasePort) {
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
  failedResume(sessionId: string): void {
    // The supported AgentLoop factory awaits its private teardown before rejecting setup/resume.
    const lease = this.#active.get(sessionId)
    if (lease !== undefined) for (const agent of lease.agents.keys()) lease.disposed(agent)
  }
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
