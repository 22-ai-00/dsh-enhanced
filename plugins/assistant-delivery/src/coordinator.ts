import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  permissionDispatchRecoveryFromFailureCode,
  type PermissionDispatchRecovery,
} from './session-commands.js'
import { DeliveryStoreError, type DeliveryStore } from './store.js'
import type {
  AdapterReconcileResult,
  AdapterSendResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  ConversationBinding,
  InboundEnvelope,
  ModelRouteRef,
  OutboxRecord,
} from './types.js'

function adapterKey(channel: string, account: string): string {
  return JSON.stringify([channel, account])
}

function samePrincipal(
  left: Readonly<ConversationBinding['principal']>,
  right: Readonly<ConversationBinding['principal']>,
): boolean {
  return left.channel === right.channel
    && left.account === right.account
    && left.tenant === right.tenant
    && left.user === right.user
}

function sameConversation(
  left: Readonly<ConversationBinding['conversation']>,
  right: Readonly<ConversationBinding['conversation']>,
): boolean {
  return left.channel === right.channel
    && left.account === right.account
    && left.tenant === right.tenant
    && left.kind === right.kind
    && left.chat === right.chat
    && left.thread === right.thread
}

function bindingChangedBeforeDispatch(
  claimed: Readonly<ConversationBinding>,
  current: Readonly<ConversationBinding>,
  envelope: Readonly<InboundEnvelope>,
): boolean {
  return current.id !== claimed.id
    || current.version !== claimed.version
    || current.sessionId !== claimed.sessionId
    || current.generation !== claimed.generation
    || !samePrincipal(current.principal, claimed.principal)
    || !samePrincipal(current.principal, envelope.principal)
    || !sameConversation(current.conversation, claimed.conversation)
    || !sameConversation(current.conversation, envelope.conversation)
}

function dispatchAuthorizationFailure(error: unknown):
  | 'authorization-revoked-before-dispatch'
  | 'binding-changed-before-dispatch'
  | undefined {
  if (!(error instanceof DeliveryStoreError)) return undefined
  if (error.code === 'unauthorized-principal') return 'authorization-revoked-before-dispatch'
  if (error.code === 'invalid-binding') return 'binding-changed-before-dispatch'
  return undefined
}

const adapterDisposeGraceMs = 5_000

type AdapterDisposer = () => void | Promise<void>

type AdapterStartOutcome =
  | { status: 'started'; dispose?: AdapterDisposer }
  | { status: 'failed'; error: unknown }

interface StartingAdapter {
  result: Promise<AdapterStartOutcome>
  cleanup?: Promise<void>
}

async function boundedWait<T>(operation: Promise<T>, graceMs: number): Promise<T | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), graceMs) }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

interface ActiveOperation {
  abort: AbortController
  promise: Promise<void>
}

async function abortAndBoundedDrain(
  active: Map<string, ActiveOperation>,
  leaseMs: number,
  reason: Error,
): Promise<void> {
  const snapshot = [...active.entries()]
  for (const [, entry] of snapshot) entry.abort.abort(reason)
  if (snapshot.length === 0) return

  // Abort stops lease renewal immediately. One heartbeat interval gives a
  // cooperative adapter time to unwind without allowing an uncooperative one
  // to hold service disposal (and the SQLite handle) forever.
  const graceMs = Math.max(1, Math.floor(leaseMs / 3))
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all(snapshot.map(([, entry]) => entry.promise)),
      new Promise<void>(resolve => { timeout = setTimeout(resolve, graceMs) }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    for (const [id, entry] of snapshot) {
      if (active.get(id) === entry) active.delete(id)
    }
  }
}

export class DeliveryAdapterRegistry {
  private readonly adapters = new Map<string, { adapter: DeliveryAdapter; dispose?: AdapterDisposer }>()
  private readonly starting = new Map<string, StartingAdapter>()
  private readonly stopSignal: Promise<void>
  private resolveStop!: () => void
  private stopped = false

  constructor(private readonly context: DeliveryAdapterContext) {
    this.stopSignal = new Promise(resolve => { this.resolveStop = resolve })
  }

  async register(adapter: DeliveryAdapter): Promise<() => Promise<void>> {
    if (this.stopped) throw new Error('assistant-delivery adapter registry is stopped')
    const key = adapterKey(adapter.channel, adapter.account)
    if (this.adapters.has(key) || this.starting.has(key)) {
      throw new Error(`delivery adapter ${adapter.channel}/${adapter.account} is already registered`)
    }
    const result = Promise.resolve()
      .then(() => adapter.start(this.context))
      .then<AdapterStartOutcome, AdapterStartOutcome>(
        dispose => ({ status: 'started', ...(dispose === undefined ? {} : { dispose }) }),
        error => ({ status: 'failed', error }),
      )
    const entry: StartingAdapter = { result }
    this.starting.set(key, entry)
    let dispose: AdapterDisposer | undefined
    try {
      const outcome = await Promise.race([
        result,
        this.stopSignal.then(() => ({ status: 'stopped' as const })),
      ])
      if (outcome.status === 'stopped') {
        void this.cleanupStarting(entry)
        throw new Error('assistant-delivery adapter registry is stopped')
      }
      if (outcome.status === 'failed') throw outcome.error
      dispose = outcome.dispose
      if (this.stopped) {
        await this.cleanupStarting(entry)
        throw new Error('assistant-delivery adapter registry is stopped')
      }
      if (this.starting.get(key) === entry) this.starting.delete(key)
      this.adapters.set(key, { adapter, ...(dispose === undefined ? {} : { dispose }) })
    } finally {
      if (this.starting.get(key) === entry) this.starting.delete(key)
    }
    let active = true
    return async () => {
      if (!active) return
      active = false
      const current = this.adapters.get(key)
      if (current?.adapter !== adapter) return
      this.adapters.delete(key)
      await boundedWait(Promise.resolve().then(() => current.dispose?.()), adapterDisposeGraceMs)
    }
  }

  get(channel: string, account: string): DeliveryAdapter | undefined {
    return this.adapters.get(adapterKey(channel, account))?.adapter
  }

  reconcilableUnknownRoutes(): ReadonlyArray<{ channel: string; account: string }> {
    const routes: Array<{ channel: string; account: string }> = []
    for (const { adapter } of this.adapters.values()) {
      if (adapter.capabilities.reconcileUnknownSend === true && adapter.reconcileUnknownSend !== undefined) {
        routes.push({ channel: adapter.channel, account: adapter.account })
      }
    }
    return routes
  }

  size(): number { return this.adapters.size }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.resolveStop()
    const current = [...this.adapters.values()]
    const pending = [...this.starting.values()]
    this.adapters.clear()
    await boundedWait(Promise.allSettled([
      ...current.map(entry => Promise.resolve().then(() => entry.dispose?.())),
      ...pending.map(entry => this.cleanupStarting(entry)),
    ]), adapterDisposeGraceMs)
  }

  private cleanupStarting(entry: StartingAdapter): Promise<void> {
    entry.cleanup ??= entry.result.then(async outcome => {
      if (outcome.status !== 'started') return
      const dispose = outcome.dispose
      if (dispose === undefined) return
      await boundedWait(Promise.resolve().then(() => dispose()), adapterDisposeGraceMs)
        .catch(() => undefined)
    })
    return entry.cleanup
  }
}

interface DeliveryCoordinatorOptions {
  store: DeliveryStore
  registry: DeliveryAdapterRegistry
  ownerId: string
  leaseMs: number
  maxAttempts: number
  maxConcurrency: number
  retryBaseMs: number
  retryMaxMs: number
  tickIntervalMs?: number
  now?: () => number
  random?: () => number
}

export class DeliveryCoordinator {
  private readonly active = new Map<string, ActiveOperation>()
  private readonly now: () => number
  private readonly random: () => number
  private timer: ReturnType<typeof setInterval> | undefined
  private stopping = false

  constructor(private readonly options: DeliveryCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  async tick(): Promise<void> {
    if (this.stopping) return
    this.options.store.recoverOutbox({ maxAttempts: this.options.maxAttempts })
    const available = this.options.maxConcurrency - this.active.size
    if (available <= 0) return
    const claims = this.options.store.claimOutbox({
      ownerId: this.options.ownerId,
      leaseMs: this.options.leaseMs,
      limit: available,
      maxAttempts: this.options.maxAttempts,
      unknownReconcileRoutes: this.options.registry.reconcilableUnknownRoutes(),
      excludeIds: [...this.active.keys()],
    })
    for (const claim of claims) {
      const abort = new AbortController()
      const stopHeartbeat = this.startLeaseHeartbeat(claim.record.id, claim.fencingToken, abort)
      let entry!: ActiveOperation
      const promise = this.process(claim.record, claim.fencingToken, claim.mode, abort.signal)
        .catch(() => {})
        .finally(() => {
          stopHeartbeat()
          if (this.active.get(claim.record.id) === entry) this.active.delete(claim.record.id)
        })
      entry = { abort, promise }
      this.active.set(claim.record.id, entry)
    }
  }

  start(): void {
    if (this.timer !== undefined) return
    this.stopping = false
    const interval = this.options.tickIntervalMs ?? 1_000
    this.timer = setInterval(() => void this.tick(), interval)
    this.timer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
    await abortAndBoundedDrain(this.active, this.options.leaseMs, new Error('assistant-delivery is stopping'))
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map(entry => entry.promise))
  }

  private startLeaseHeartbeat(outboxId: string, fencingToken: number, abort: AbortController): () => void {
    let active = true
    const interval = Math.max(1, Math.floor(this.options.leaseMs / 3))
    const heartbeat = setInterval(() => {
      if (!active || abort.signal.aborted) return
      try {
        if (this.options.store.renewOutboxClaim({ outboxId, ownerId: this.options.ownerId, fencingToken,
          leaseMs: this.options.leaseMs })) return
        abort.abort(new Error('assistant-delivery outbox lease was lost'))
      } catch (error) {
        abort.abort(error)
      }
    }, interval)
    heartbeat.unref?.()
    const stop = () => {
      if (!active) return
      active = false
      clearInterval(heartbeat)
      abort.signal.removeEventListener('abort', stop)
    }
    abort.signal.addEventListener('abort', stop, { once: true })
    return stop
  }

  private async process(
    record: OutboxRecord,
    fencingToken: number,
    mode: 'reconcile' | 'send',
    signal: AbortSignal,
  ): Promise<void> {
    const adapter = this.options.registry.get(record.intent.target.conversation.channel, record.intent.target.conversation.account)
    if (adapter === undefined) {
      this.finish(record, fencingToken, mode === 'reconcile'
        ? { outcome: 'unknown', failureCode: 'adapter-unavailable' }
        : { outcome: 'not-sent', failureCode: 'adapter-unavailable', retryable: true })
      return
    }
    if (!adapter.capabilities.formats.includes(record.intent.format ?? 'plain')) {
      this.finish(record, fencingToken, { outcome: 'not-sent', failureCode: 'unsupported-format', retryable: false })
      return
    }
    if (mode === 'reconcile') {
      if (!adapter.capabilities.reconcileUnknownSend || adapter.reconcileUnknownSend === undefined) {
        this.finish(record, fencingToken, { outcome: 'unknown', failureCode: 'reconcile-unsupported' })
        return
      }
      try {
        const result = await adapter.reconcileUnknownSend(record, signal)
        if (signal.aborted) return
        this.finishReconcile(record, fencingToken, result)
      } catch {
        if (signal.aborted) return
        this.finish(record, fencingToken, { outcome: 'unknown', failureCode: 'reconcile-threw' })
      }
      return
    }
    const binding = this.options.store.getBinding(record.intent.bindingId)
    if (binding?.status !== 'active') {
      this.finish(record, fencingToken, { outcome: 'not-sent', failureCode: 'binding-revoked', retryable: false })
      return
    }
    if (!sameConversation(binding.conversation, record.intent.target.conversation)
      || !samePrincipal(binding.principal, record.intent.target.principal)) {
      this.finish(record, fencingToken, {
        outcome: 'not-sent', failureCode: 'binding-target-mismatch', retryable: false,
      })
      return
    }
    let authorized: boolean
    try {
      authorized = this.options.store.isAuthorizedPrincipal(binding.principal)
    } catch {
      this.finish(record, fencingToken, {
        outcome: 'not-sent', failureCode: 'principal-authorization-check-failed', retryable: true,
      })
      return
    }
    if (!authorized) {
      this.finish(record, fencingToken, { outcome: 'not-sent', failureCode: 'principal-revoked', retryable: false })
      return
    }
    try {
      const result = await adapter.send(record.intent, signal)
      if (signal.aborted) return
      this.finish(record, fencingToken, result)
    } catch {
      if (signal.aborted) return
      this.finish(record, fencingToken, { outcome: 'unknown', failureCode: 'adapter-threw' })
    }
  }

  private finish(record: OutboxRecord, fencingToken: number, result: AdapterSendResult): void {
    if (result.outcome === 'accepted') {
      this.options.store.finishOutbox({ outboxId: record.id, ownerId: this.options.ownerId, fencingToken,
        outcome: 'accepted', providerMessageId: result.providerMessageId })
      return
    }
    if (result.outcome === 'unknown') {
      this.options.store.finishOutbox({ outboxId: record.id, ownerId: this.options.ownerId, fencingToken,
        outcome: 'unknown_after_send', failureCode: result.failureCode,
        ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }) })
      return
    }
    if (!result.retryable) {
      this.options.store.finishOutbox({ outboxId: record.id, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead', failureCode: result.failureCode })
      return
    }
    const exponential = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * (2 ** Math.max(0, record.attemptCount - 1)) * (1 + this.random()),
    )
    const delay = Math.max(exponential, result.retryAfterMs ?? 0)
    this.options.store.finishOutbox({ outboxId: record.id, ownerId: this.options.ownerId, fencingToken,
      outcome: 'retry_wait', failureCode: result.failureCode, retryAt: this.now() + Math.ceil(delay) })
  }

  private finishReconcile(record: OutboxRecord, fencingToken: number, result: AdapterReconcileResult): void {
    if (result.outcome === 'unknown') {
      this.finish(record, fencingToken, { outcome: 'unknown', failureCode: 'reconcile-inconclusive' })
      return
    }
    if (result.outcome === 'not-sent') {
      this.finish(record, fencingToken, { outcome: 'not-sent', failureCode: 'reconciled-not-sent', retryable: true })
      return
    }
    this.options.store.finishOutbox({ outboxId: record.id, ownerId: this.options.ownerId, fencingToken,
      outcome: 'accepted', providerMessageId: result.providerMessageId })
    if (result.outcome !== 'accepted') {
      this.options.store.recordReceipt({
        channel: record.intent.target.conversation.channel,
        account: record.intent.target.conversation.account,
        providerMessageId: result.providerMessageId,
        status: result.outcome,
        occurredAt: this.now(),
      })
    }
  }
}

export type InboundProcessResult =
  | { outcome: 'processed' }
  | { outcome: 'not-processed'; failureCode: string; retryable: boolean; retryAfterMs?: number }

export type InboundNotProcessedResult = Extract<InboundProcessResult, { outcome: 'not-processed' }>

/** Durable inputs admitted before an Agent turn becomes dispatch-ambiguous. */
export interface PreparedInboundMessage {
  imageAttachments: readonly ImageAttachmentRef[]
  /** Exact route admitted for this claimed turn; runtimes may omit it when they do no LLM dispatch. */
  modelRoute?: Readonly<ModelRouteRef>
  /** Durable reconciliation mode for a permission command interrupted after its dispatch fence. */
  permissionDispatchRecovery?: PermissionDispatchRecovery
}

/** Identifies the live inbox claim that owns preparation side effects. */
export interface InboundPrepareContext {
  inboxId: string
  ownerId: string
  fencingToken: number
  /** Present only when the Inbox itself proves an interrupted permission dispatch. */
  permissionDispatchRecovery?: PermissionDispatchRecovery
}

export type InboundPrepareResult =
  | { outcome: 'prepared'; message: Readonly<PreparedInboundMessage> }
  | InboundNotProcessedResult

export type MarkInboundDispatching = () => void

export interface InboundMessageProcessor {
  /**
   * Lets the processor place the durable marker immediately before its first external dispatch.
   * Explicit processors must let gate errors abort dispatch and must never dispatch after a gate error.
   */
  readonly dispatchControl?: 'explicit'
  /** Prepare durable inputs without dispatching the turn to the external Agent runtime. */
  prepare?(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    context: Readonly<InboundPrepareContext>,
  ): Promise<InboundPrepareResult>
  process(
    binding: Readonly<ConversationBinding>,
    envelope: Readonly<InboundEnvelope>,
    signal: AbortSignal,
    prepared?: Readonly<PreparedInboundMessage>,
    markDispatching?: MarkInboundDispatching,
  ): Promise<InboundProcessResult>
}

interface InboundCoordinatorOptions {
  store: DeliveryStore
  processor: () => InboundMessageProcessor | undefined
  ownerId: string
  leaseMs: number
  maxAttempts: number
  maxConcurrency: number
  retryBaseMs: number
  retryMaxMs: number
  now?: () => number
  random?: () => number
}

export class InboundCoordinator {
  private readonly active = new Map<string, ActiveOperation>()
  private readonly now: () => number
  private readonly random: () => number
  private stopping = false

  constructor(private readonly options: InboundCoordinatorOptions) {
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
  }

  async tick(): Promise<void> {
    if (this.stopping) return
    this.options.store.recoverInbox({ maxAttempts: this.options.maxAttempts })
    const available = this.options.maxConcurrency - this.active.size
    if (available <= 0) return
    const claims = this.options.store.claimInbox({ ownerId: this.options.ownerId, leaseMs: this.options.leaseMs,
      limit: available, maxAttempts: this.options.maxAttempts })
    for (const claim of claims) {
      const abort = new AbortController()
      const stopHeartbeat = this.startLeaseHeartbeat(claim.record.id, claim.fencingToken, abort)
      let entry!: ActiveOperation
      const promise = this.process(
        claim.record.id,
        claim.record.bindingId,
        claim.record.envelope,
        claim.fencingToken,
        abort.signal,
        permissionDispatchRecoveryFromFailureCode(claim.record.failureCode),
      )
        .catch(() => {})
        .finally(() => {
          stopHeartbeat()
          if (this.active.get(claim.record.id) === entry) this.active.delete(claim.record.id)
        })
      entry = { abort, promise }
      this.active.set(claim.record.id, entry)
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    await abortAndBoundedDrain(this.active, this.options.leaseMs, new Error('assistant-delivery is stopping'))
  }

  /** Abort and drain exact claims that a durable command fence made terminal. */
  async cancelUndispatchedClaims(inboxIds: readonly string[], command: 'new' | 'stop'): Promise<void> {
    const operations = [...new Set(inboxIds)]
      .map(inboxId => this.active.get(inboxId))
      .filter((entry): entry is ActiveOperation => entry !== undefined)
    if (operations.length === 0) return
    const reason = new Error(`assistant-delivery: inbox preparation cancelled by /${command}`)
    for (const operation of operations) {
      if (!operation.abort.signal.aborted) operation.abort.abort(reason)
    }
    await Promise.all(operations.map(operation => operation.promise))
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map(entry => entry.promise))
  }

  private startLeaseHeartbeat(inboxId: string, fencingToken: number, abort: AbortController): () => void {
    let active = true
    const interval = Math.max(1, Math.floor(this.options.leaseMs / 3))
    const heartbeat = setInterval(() => {
      if (!active || abort.signal.aborted) return
      try {
        if (this.options.store.renewInboxClaim({ inboxId, ownerId: this.options.ownerId, fencingToken,
          leaseMs: this.options.leaseMs })) return
        abort.abort(new Error('assistant-delivery inbox lease was lost'))
      } catch (error) {
        abort.abort(error)
      }
    }, interval)
    heartbeat.unref?.()
    const stop = () => {
      if (!active) return
      active = false
      clearInterval(heartbeat)
      abort.signal.removeEventListener('abort', stop)
    }
    abort.signal.addEventListener('abort', stop, { once: true })
    return stop
  }

  private async process(
    inboxId: string,
    bindingId: string | undefined,
    envelope: InboundEnvelope,
    fencingToken: number,
    signal: AbortSignal,
    permissionDispatchRecovery?: PermissionDispatchRecovery,
  ): Promise<void> {
    const binding = bindingId === undefined ? undefined : this.options.store.getBinding(bindingId)
    if (binding?.status === 'revoked') {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'binding-revoked' })
      return
    }
    if (binding === undefined) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'retry_wait', failureCode: 'binding-unavailable',
        retryAt: this.now() + this.options.retryBaseMs })
      return
    }
    const processor = this.options.processor()
    if (processor === undefined) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'retry_wait', failureCode: 'processor-unavailable', retryAt: this.now() + this.options.retryBaseMs })
      return
    }
    let prepared: Readonly<PreparedInboundMessage> | undefined
    if (processor.prepare !== undefined) {
      let preparation: InboundPrepareResult
      try {
        preparation = await processor.prepare(binding, envelope, signal, {
          inboxId,
          ownerId: this.options.ownerId,
          fencingToken,
          ...(permissionDispatchRecovery === undefined ? {} : { permissionDispatchRecovery }),
        })
      } catch {
        if (signal.aborted) return
        this.finishInbound(inboxId, fencingToken, {
          outcome: 'not-processed', failureCode: 'prepare-threw', retryable: true,
        })
        return
      }
      if (signal.aborted) return
      if (preparation.outcome !== 'prepared') {
        this.finishInbound(inboxId, fencingToken, preparation)
        return
      }
      prepared = preparation.message
    }
    if (signal.aborted) return
    const currentBinding = this.options.store.getBinding(binding.id)
    if (currentBinding === undefined || currentBinding.status !== 'active') {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'binding-revoked' })
      return
    }
    if (bindingChangedBeforeDispatch(binding, currentBinding, envelope)) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'binding-changed-before-dispatch' })
      return
    }
    if (!this.options.store.isAuthorizedPrincipal(currentBinding.principal)) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'authorization-revoked-before-dispatch' })
      return
    }
    const explicitDispatch = processor.dispatchControl === 'explicit'
    const dispatchBinding = {
      id: currentBinding.id,
      version: currentBinding.version,
      sessionId: currentBinding.sessionId,
      generation: currentBinding.generation,
      conversation: { ...currentBinding.conversation },
      principal: { ...currentBinding.principal },
    }
    let dispatchMarked = false
    let dispatchGateFailed = false
    let dispatchGateBindingFailure:
      | 'authorization-revoked-before-dispatch'
      | 'binding-changed-before-dispatch'
      | 'binding-revoked'
      | undefined
    let dispatchGateOpen = explicitDispatch
    const markDispatching: MarkInboundDispatching | undefined = explicitDispatch
      ? () => {
          if (!dispatchGateOpen || dispatchGateFailed) {
            throw new Error('assistant-delivery inbound dispatch gate is closed')
          }
          if (signal.aborted) throw signal.reason
          if (dispatchMarked) return
          let latestBinding: ConversationBinding | undefined
          try {
            latestBinding = this.options.store.getBinding(currentBinding.id)
          } catch (error) {
            dispatchGateFailed = true
            throw error
          }
          let authorized: boolean
          try {
            authorized = this.options.store.isAuthorizedPrincipal(dispatchBinding.principal)
          } catch (error) {
            dispatchGateFailed = true
            throw error
          }
          if (!authorized) {
            dispatchGateFailed = true
            dispatchGateBindingFailure = 'authorization-revoked-before-dispatch'
            throw new Error('assistant-delivery inbound authorization was revoked before dispatch')
          }
          if (latestBinding === undefined || latestBinding.status !== 'active') {
            dispatchGateFailed = true
            dispatchGateBindingFailure = 'binding-revoked'
            throw new Error('assistant-delivery inbound binding was revoked before dispatch')
          }
          if (bindingChangedBeforeDispatch(currentBinding, latestBinding, envelope)) {
            dispatchGateFailed = true
            dispatchGateBindingFailure = 'binding-changed-before-dispatch'
            throw new Error('assistant-delivery inbound binding changed before dispatch')
          }
          try {
            this.options.store.markInboxDispatching({
              inboxId, ownerId: this.options.ownerId, fencingToken, binding: dispatchBinding,
            })
          } catch (error) {
            dispatchGateFailed = true
            dispatchGateBindingFailure = dispatchAuthorizationFailure(error) ?? dispatchGateBindingFailure
            throw error
          }
          dispatchMarked = true
        }
      : undefined
    if (!explicitDispatch) {
      try {
        this.options.store.markInboxDispatching({
          inboxId, ownerId: this.options.ownerId, fencingToken, binding: dispatchBinding,
        })
        dispatchMarked = true
      } catch (error) {
        const failureCode = dispatchAuthorizationFailure(error)
        if (failureCode !== undefined) {
          this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
            outcome: 'dead_letter', failureCode })
        }
        // No processor call happened, so lease recovery remains the authority on
        // whether a stale or failed marker is safe to retry.
        return
      }
    }
    let result: InboundProcessResult
    try {
      result = await processor.process(currentBinding, envelope, signal, prepared, markDispatching)
    } catch {
      dispatchGateOpen = false
      if (signal.aborted) return
      if (explicitDispatch && !dispatchMarked) {
        if (dispatchGateBindingFailure !== undefined) {
          this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
            outcome: 'dead_letter', failureCode: dispatchGateBindingFailure })
          return
        }
        this.finishInbound(inboxId, fencingToken, {
          outcome: 'not-processed', failureCode: 'processor-threw-before-dispatch', retryable: true,
        })
        return
      }
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'processor-ambiguous' })
      return
    }
    dispatchGateOpen = false
    if (signal.aborted) return
    if (dispatchGateBindingFailure !== undefined) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: dispatchGateBindingFailure })
      return
    }
    if (dispatchGateFailed) {
      this.finishInbound(inboxId, fencingToken, {
        outcome: 'not-processed', failureCode: 'processor-threw-before-dispatch', retryable: true,
      })
      return
    }
    if (dispatchMarked && result.outcome !== 'processed') {
      if (permissionDispatchRecoveryFromFailureCode(result.failureCode) !== undefined) {
        this.finishInbound(inboxId, fencingToken, result)
        return
      }
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'processor-ambiguous' })
      return
    }
    this.finishInbound(inboxId, fencingToken, result)
  }

  private finishInbound(inboxId: string, fencingToken: number, result: InboundProcessResult): void {
    if (result.outcome === 'processed') {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken, outcome: 'processed' })
      return
    }
    if (!result.retryable) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: result.failureCode })
      return
    }
    const current = this.options.store.getInbox(inboxId)!
    const exponential = Math.min(this.options.retryMaxMs,
      this.options.retryBaseMs * (2 ** Math.max(0, current.attemptCount - 1)) * (1 + this.random()))
    this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
      outcome: 'retry_wait', failureCode: result.failureCode,
      retryAt: this.now() + Math.ceil(Math.max(exponential, result.retryAfterMs ?? 0)) })
  }
}
