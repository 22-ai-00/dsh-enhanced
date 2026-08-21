import type { DeliveryStore } from './store.js'
import type {
  AdapterReconcileResult,
  AdapterSendResult,
  DeliveryAdapter,
  DeliveryAdapterContext,
  ConversationBinding,
  InboundEnvelope,
  OutboxRecord,
} from './types.js'

function adapterKey(channel: string, account: string): string {
  return JSON.stringify([channel, account])
}

export class DeliveryAdapterRegistry {
  private readonly adapters = new Map<string, { adapter: DeliveryAdapter; dispose?: () => void | Promise<void> }>()
  private stopped = false

  constructor(private readonly context: DeliveryAdapterContext) {}

  async register(adapter: DeliveryAdapter): Promise<() => Promise<void>> {
    if (this.stopped) throw new Error('assistant-delivery adapter registry is stopped')
    const key = adapterKey(adapter.channel, adapter.account)
    if (this.adapters.has(key)) throw new Error(`delivery adapter ${adapter.channel}/${adapter.account} is already registered`)
    const dispose = await adapter.start(this.context)
    this.adapters.set(key, { adapter, ...(dispose === undefined ? {} : { dispose }) })
    let active = true
    return async () => {
      if (!active) return
      active = false
      const current = this.adapters.get(key)
      if (current?.adapter !== adapter) return
      this.adapters.delete(key)
      await current.dispose?.()
    }
  }

  get(channel: string, account: string): DeliveryAdapter | undefined {
    return this.adapters.get(adapterKey(channel, account))?.adapter
  }

  size(): number { return this.adapters.size }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const current = [...this.adapters.values()]
    this.adapters.clear()
    await Promise.all(current.map(async entry => entry.dispose?.()))
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
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>()
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
    })
    for (const claim of claims) {
      const abort = new AbortController()
      const promise = this.process(claim.record, claim.fencingToken, claim.mode, abort.signal)
        .catch(() => {})
        .finally(() => this.active.delete(claim.record.id))
      this.active.set(claim.record.id, { abort, promise })
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
    for (const current of this.active.values()) current.abort.abort(new Error('assistant-delivery is stopping'))
    await this.whenIdle()
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map(entry => entry.promise))
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
        this.finishReconcile(record, fencingToken, result)
      } catch {
        this.finish(record, fencingToken, { outcome: 'unknown', failureCode: 'reconcile-threw' })
      }
      return
    }
    try {
      this.finish(record, fencingToken, await adapter.send(record.intent, signal))
    } catch {
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

export interface InboundMessageProcessor {
  process(binding: Readonly<ConversationBinding>, envelope: Readonly<InboundEnvelope>, signal: AbortSignal):
  Promise<InboundProcessResult>
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
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>()
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
      const promise = this.process(claim.record.id, claim.record.bindingId, claim.record.envelope, claim.fencingToken, abort.signal)
        .catch(() => {})
        .finally(() => this.active.delete(claim.record.id))
      this.active.set(claim.record.id, { abort, promise })
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    for (const current of this.active.values()) current.abort.abort(new Error('assistant-delivery is stopping'))
    await this.whenIdle()
  }

  async whenIdle(): Promise<void> {
    while (this.active.size > 0) await Promise.all([...this.active.values()].map(entry => entry.promise))
  }

  private async process(
    inboxId: string,
    bindingId: string | undefined,
    envelope: InboundEnvelope,
    fencingToken: number,
    signal: AbortSignal,
  ): Promise<void> {
    const binding = bindingId === undefined ? undefined : this.options.store.getBinding(bindingId)
    const processor = this.options.processor()
    if (binding === undefined || binding.status !== 'active' || processor === undefined) {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'retry_wait', failureCode: binding === undefined ? 'binding-unavailable' : 'processor-unavailable',
        retryAt: this.now() + this.options.retryBaseMs })
      return
    }
    let result: InboundProcessResult
    try {
      this.options.store.markInboxDispatching({ inboxId, ownerId: this.options.ownerId, fencingToken })
      result = await processor.process(binding, envelope, signal)
    } catch {
      this.options.store.finishInbox({ inboxId, ownerId: this.options.ownerId, fencingToken,
        outcome: 'dead_letter', failureCode: 'processor-ambiguous' })
      return
    }
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
