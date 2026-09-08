import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { AcceptanceHandle } from './acceptance.js'
import { externalPrincipalId, canonicalPrincipal } from './canonical.js'
import type { DeliveryStore } from './store.js'
import { DeliverySessionLeases, SessionLeaseUnavailable, type SessionExecutionLease } from './session-lease-runtime.js'
import type { ConversationBinding, DeliveryOwnerLineage, ExternalPrincipalKey, InboundEnvelope } from './types.js'

export interface NativeWebOwnerConfig {
  principal: ExternalPrincipalKey
  workspace: string
  preset: string
  maxExecutionMs?: number
}
export interface NativeWebOwnerAccess {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  resume(options: ResumeAgentOptions): Promise<AgentHandle>
  get(sessionId: string): Agent | undefined
  assertSession(sessionId: string): void
  ownsSession(sessionId: string): boolean
  prompt<T>(input: { sessionId: string; requestId: string; text: string; content: readonly unknown[] },
    invoke: () => Promise<T>, signal: AbortSignal): Promise<T>
  notifications(sessionId: string): ReadonlyArray<{ id: string; text: string; createdAt: number }>
  dispose(): Promise<void>
}
interface OwnerPort {
  assertActive(): void
  policyRef: string
  leaseMs: number
  prepare(binding: ConversationBinding, envelope: InboundEnvelope): AcceptanceHandle | undefined
  complete(handle: AcceptanceHandle, input: { status: 'succeeded' | 'failed' | 'cancelled' | 'unknown'; quiescent: boolean }): Promise<void>
  claimed(agent: Agent, envelope: InboundEnvelope, turn: number): void
  released(): void
  notifications(binding: ConversationBinding): ReadonlyArray<{ id: string; text: string; createdAt: number }>
}
interface Execution {
  handle: AgentHandle
  lease: SessionExecutionLease
  closing?: Promise<void>
  deadlineAt: number
  input?: {
    inboxId: string
    fencingToken: number
    envelope: InboundEnvelope
    acceptance?: AcceptanceHandle
    permit: { inserted(): boolean; dispose(): void }
    turn?: number
    completed?: boolean
    admitting: boolean
  }
}
type NativeGoalLookup = {
  get(agent: Agent): { phase: string, activation: string } | undefined
}
type AssistantGoalsLifecycleLookup = { hasPendingExecutionSettlement?(agent: Agent): boolean }

/** Fixed single-owner Host capability. No RPC payload may choose its principal or scope. */
export class NativeWebOwner implements NativeWebOwnerAccess {
  readonly #config: Readonly<NativeWebOwnerConfig>
  readonly #lineage: DeliveryOwnerLineage
  readonly #controller = new AbortController()
  readonly #entries = new Map<string, Execution>()
  readonly #ownerId = `native-web-${randomUUID()}`
  readonly #timer: ReturnType<typeof setInterval>
  #disposed = false
  constructor(private readonly ownerCtx: Context,
    private readonly store: DeliveryStore, private readonly leases: DeliverySessionLeases,
    private readonly policy: AssistantPolicyService, private readonly port: OwnerPort, config: NativeWebOwnerConfig) {
    const principal = canonicalPrincipal(config.principal)
    if (principal.channel !== 'web' || !isAbsolute(config.workspace) || !config.preset.trim()
      || !Number.isSafeInteger(config.maxExecutionMs ?? 300_000) || (config.maxExecutionMs ?? 300_000) < 1 || (config.maxExecutionMs ?? 300_000) > 300_000) {
      throw new Error('assistant-delivery: Web owner requires an explicit Web identity and absolute scope')
    }
    this.#config = Object.freeze({ principal: Object.freeze(principal), workspace: config.workspace, preset: config.preset, maxExecutionMs: config.maxExecutionMs ?? 300_000 })
    const owner = store.getPrincipal(principal)
    if (owner?.status !== 'active' || owner.role !== 'owner') {
      throw new Error('assistant-delivery: pair this Web owner locally before enabling its Controller')
    }
    this.#lineage = { principalRecordId: owner.id, principalVersion: owner.version }
    // Idle Agents yield the durable lane to Automations/Delivery. Active input
    // claims renew alongside their Session lease; neither timer dispatches work.
    this.#timer = setInterval(() => {
      for (const [id, entry] of this.#entries) {
        if (entry.closing !== undefined) continue
        try {
          if (Date.now() >= entry.deadlineAt) throw new SessionLeaseUnavailable('denied')
          this.assertSession(id)
          entry.lease.assertAgent(entry.handle.agent)
          if (entry.input !== undefined && !store.renewInboxClaim({ inboxId: entry.input.inboxId,
            ownerId: this.#ownerId, fencingToken: entry.input.fencingToken, leaseMs: port.leaseMs })) {
            throw new SessionLeaseUnavailable('denied')
          }
          if (entry.input?.admitting !== true && entry.handle.agent.status === 'idle' && !entry.handle.agent.inbox.hasPending
            && !this.#awaitingNativeGoal(entry.handle.agent)) void this.#close(id, entry)
        } catch { entry.lease.cancel(); void this.#close(id, entry) }
      }
    }, Math.max(1, Math.min(100, Math.floor(port.leaseMs / 3))))
    this.#timer.unref?.()
    ownerCtx.effect(() => () => this.dispose(), 'assistant-delivery.native-web-owner')
  }
  #assertOwner(): void {
    this.port.assertActive()
    this.#controller.signal.throwIfAborted()
    const owner = this.store.getPrincipal(this.#config.principal)
    if (owner?.id !== this.#lineage.principalRecordId || owner.version !== this.#lineage.principalVersion
      || owner.status !== 'active' || owner.role !== 'owner') throw new SessionLeaseUnavailable('denied')
  }
  #binding(sessionId: string): ConversationBinding {
    this.#assertOwner()
    const binding = this.store.getBindingBySession(sessionId)
    if (binding?.status !== 'active' || binding.workspace !== this.#config.workspace
      || binding.agentPreset !== this.#config.preset
      || externalPrincipalId(binding.principal) !== externalPrincipalId(this.#config.principal)) {
      throw new SessionLeaseUnavailable('denied')
    }
    return binding
  }
  /** An armed active Goal is owned by the native round driver after this turn's idle edge. */
  #awaitingNativeGoal(agent: Agent): boolean {
    const goals = this.ownerCtx.get('goals' as never) as unknown as NativeGoalLookup | undefined
    if (goals === undefined) return false
    const goal = goals.get(agent)
    return goal?.phase === 'active' && goal.activation === 'armed'
      || (this.ownerCtx.get('assistantGoals' as never) as unknown as AssistantGoalsLifecycleLookup | undefined)
        ?.hasPendingExecutionSettlement?.(agent) === true
  }
  assertSession(sessionId: string): void { this.#binding(sessionId) }
  ownsSession(sessionId: string): boolean { try { this.assertSession(sessionId); return true } catch { return false } }
  notifications(sessionId: string): ReadonlyArray<{ id: string; text: string; createdAt: number }> { return this.port.notifications(this.#binding(sessionId)) }
  get(sessionId: string): Agent | undefined {
    this.#assertOwner()
    const entry = this.#entries.get(sessionId)
    if (entry === undefined) return undefined
    this.assertSession(sessionId)
    if (entry.closing !== undefined) throw new SessionLeaseUnavailable('busy')
    entry.lease.assertAgent(entry.handle.agent)
    return entry.handle.agent
  }
  async create(options: CreateAgentOptions): Promise<AgentHandle> {
    this.#assertOwner()
    const sessionId = String(options.sessionId)
    if (options.meta?.cwd !== this.#config.workspace || options.meta?.agentPreset !== this.#config.preset
      || sessionId === 'undefined' || this.store.getBindingBySession(sessionId) !== undefined) {
      throw new SessionLeaseUnavailable('denied')
    }
    const conversation = { channel: 'web', account: this.#config.principal.account,
      tenant: this.#config.principal.tenant, kind: 'dm' as const, chat: sessionId }
    const lease = this.leases.open({ kind: 'construction', sessionId, conversation,
      principal: this.#config.principal, workspace: this.#config.workspace, agentPreset: this.#config.preset, generation: 1 },
    AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.#config.maxExecutionMs!)]))
    let handle: AgentHandle | undefined
    try {
      lease.dispatch()
      handle = await this.leases.create(this.ownerCtx, { ...options, setup: this.#setup(options.setup) })
      if (!await this.ownerCtx.sessions.flush(handle.agent.session)) throw new Error('assistant-delivery: Web Session was not durable')
      this.#assertOwner()
      this.store.createBinding({ conversation, principal: this.#config.principal, workspace: this.#config.workspace,
          agentPreset: this.#config.preset, sessionId, policyRef: this.port.policyRef, expectedGeneration: 1, constructionLease: lease.token })
      return this.#track(sessionId, lease, handle)
    } catch (error) {
      lease.cancel(); lease.close()
      if (handle !== undefined) void handle.dispose().catch(() => {})
      throw error
    }
  }
  async resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    const binding = this.#binding(String(options.resumeSessionId))
    const lease = this.leases.open({ kind: 'bound', binding }, AbortSignal.any([this.#controller.signal, AbortSignal.timeout(this.#config.maxExecutionMs!)]))
    let handle: AgentHandle | undefined
    try {
      lease.dispatch()
      handle = await this.leases.resume(this.ownerCtx, { ...options, setup: this.#setup(options.setup) })
      this.#binding(binding.sessionId)
      return this.#track(binding.sessionId, lease, handle)
    } catch (error) {
      lease.cancel(); lease.close()
      if (handle !== undefined) void handle.dispose().catch(() => {})
      throw error
    }
  }
  #setup(original: CreateAgentOptions['setup']): NonNullable<CreateAgentOptions['setup']> {
    return async ctx => {
      this.#assertOwner()
      const agent = ctx.agent
      if (agent === undefined || agent.session.header.cwd !== this.#config.workspace
        || agent.session.header.agentPreset !== this.#config.preset) throw new SessionLeaseUnavailable('denied')
      ctx.effect(() => this.policy.bindInitiator(agent, 'external', externalPrincipalId(this.#config.principal)))
      const prepared = await original?.(ctx)
      return { commit: () => { this.#assertOwner(); prepared?.commit?.(); this.#assertOwner() } }
    }
  }
  #track(id: string, lease: SessionExecutionLease, handle: AgentHandle): AgentHandle {
    const entry: Execution = { lease, handle, deadlineAt: Date.now() + this.#config.maxExecutionMs! }
    this.#entries.set(id, entry)
    return { agent: handle.agent, dispose: () => this.#close(id, entry) }
  }
  async prompt<T>(input: { sessionId: string; requestId: string; text: string; content: readonly unknown[] },
    invoke: () => Promise<T>, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    if (!input.content.length || input.content.some(part => typeof part !== 'object' || part === null
      || (part as { type?: unknown }).type !== 'text' || typeof (part as { text?: unknown }).text !== 'string')) {
      throw new Error('assistant-delivery: native Web owner currently accepts text input only')
    }
    if (input.text !== input.content.map(part => (part as { text: string }).text).join('')) throw new Error('assistant-delivery: native input text does not match its content')
    const binding = this.#binding(input.sessionId)
    const entry = this.#entries.get(input.sessionId)
    if (entry === undefined || entry.closing !== undefined || entry.input !== undefined
      || entry.handle.agent.status !== 'idle' || entry.handle.agent.inbox.hasPending) throw new SessionLeaseUnavailable('busy')
    const envelope: InboundEnvelope = { channel: 'web', account: this.#config.principal.account,
      eventId: input.requestId, occurredAt: Date.now(), principal: binding.principal,
      conversation: binding.conversation, kind: 'text', text: input.text,
      metadata: { 'native.content.sha256': createHash('sha256').update(JSON.stringify(input.content)).digest('hex') } }
    const accepted = this.store.claimNativeInbox({ envelope, binding, ownerLineage: this.#lineage, ownerId: this.#ownerId, leaseMs: this.port.leaseMs })
    if (accepted.duplicate || accepted.fencingToken === undefined) throw new Error('assistant-delivery: native input already admitted; inspect its Session')
    const claim = { inboxId: accepted.record.id, ownerId: this.#ownerId, fencingToken: accepted.fencingToken }
    let acceptance: AcceptanceHandle | undefined
    try {
      const decision = this.policy.authorize({ subject: { kind: 'external', id: externalPrincipalId(binding.principal) },
        action: 'ingest', resource: { kind: 'message', id: `inbound:web/${envelope.account}` },
        context: { initiator: 'external' } }, { idempotencyKey: `message-inbound:${claim.inboxId}` })
      if (decision.effect !== 'allow') throw new SessionLeaseUnavailable('denied')
      acceptance = this.port.prepare(binding, envelope)
      this.#assertOwner()
      signal.throwIfAborted()
      const permit = this.leases.admitNativeInput(entry.handle.agent, { requestId: input.requestId, content: input.content,
        onClaimed: turn => {
          this.#binding(input.sessionId)
          if (entry.input === undefined) throw new SessionLeaseUnavailable('denied')
          entry.input.turn = turn
          this.port.claimed(entry.handle.agent, envelope, turn)
        } })
      entry.input = { ...claim, envelope, ...(acceptance === undefined ? {} : { acceptance }), permit, admitting: true }
      this.store.markInboxDispatching({ ...claim, binding })
      entry.lease.assert()
      const result = await invoke()
      entry.input!.admitting = false
      if (!permit.inserted()) throw new Error('assistant-delivery: native prompt did not insert its exact admitted message')
      entry.lease.assertAgent(entry.handle.agent)
      return result
    } catch (error) {
      if (entry.input !== undefined) { entry.lease.cancel(); await this.#close(input.sessionId, entry) }
      else {
        if (acceptance !== undefined) await this.port.complete(acceptance, { status: 'failed', quiescent: true })
        this.store.finishInbox({ ...claim, outcome: 'dead_letter', failureCode: 'native-input-rejected' })
      }
      throw error
    }
  }
  #close(id: string, entry: Execution): Promise<void> {
    return entry.closing ??= this.#drain(id, entry).catch(() => {
      // A Store or sink outage retains its fenced claim for recovery, never replay.
      entry.lease.cancel(); entry.lease.close()
    })
  }
  async #drain(id: string, entry: Execution): Promise<void> {
    if (entry.input?.turn !== undefined) {
      const terminal = entry.handle.agent.session.snapshotEvents().findLast(event =>
        event.type === 'turn/end' && event.data.turn === entry.input!.turn)
      if (terminal?.type === 'turn/end') entry.input.completed = terminal.data.reason.kind === 'completed'
    }
    const succeeded = entry.input?.completed === true && !entry.lease.signal.aborted
    entry.lease.cancel()
    entry.lease.close()
    let timeout: ReturnType<typeof setTimeout> | undefined
    const quiescent = await Promise.race([
      entry.handle.dispose().then(() => true, () => false),
      new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 5_000) }),
    ])
    clearTimeout(timeout)
    entry.input?.permit.dispose()
    if (entry.input !== undefined) {
      const status = !quiescent ? 'unknown' : succeeded ? 'succeeded' : entry.input.completed === false ? 'failed' : 'cancelled'
      if (entry.input.acceptance !== undefined) await this.port.complete(entry.input.acceptance, { status, quiescent })
      this.store.finishInbox({ inboxId: entry.input.inboxId, ownerId: this.#ownerId, fencingToken: entry.input.fencingToken,
        outcome: succeeded && quiescent ? 'processed' : 'dead_letter',
        ...(succeeded && quiescent ? {} : { failureCode: quiescent ? 'native-input-failed' : 'processor-ambiguous' }) })
    }
    if (this.#entries.get(id) === entry) this.#entries.delete(id)
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    clearInterval(this.#timer)
    this.#controller.abort()
    try { await Promise.all([...this.#entries].map(([id, entry]) => this.#close(id, entry))) }
    finally { this.port.released() }
  }
}
