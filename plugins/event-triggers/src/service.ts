import { createHmac, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import type { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import type { CredentialsKeychainService } from '@dsh-enhanced/credentials-keychain'
import {
  ConfigSchema,
  normalizeEventTriggersConfig,
  type Config,
  type NormalizedConfig,
  type NormalizedTrigger,
  type WebhookTriggerConfig,
} from './config.js'
import {
  defaultLookup,
  pinFileRoots,
  readFileObservation,
  readHttpJsonObservation,
  type Fetcher,
  type Lookup,
  type PinnedFileRoot,
  type SensorObservation,
} from './sensors.js'
import { EventTriggerStore } from './store.js'

export type EventTriggersErrorCode =
  | 'cooldown'
  | 'disposed'
  | 'invalid-signature'
  | 'limit'
  | 'not-found'
  | 'policy-denied'
  | 'replay'
  | 'timestamp'
  | 'ttl'

export class EventTriggersError extends Error {
  constructor(readonly code: EventTriggersErrorCode, message: string) {
    super(message)
    this.name = 'EventTriggersError'
  }
}

export interface EventTriggersServiceOptions {
  now?: () => number
  fetcher?: Fetcher
  lookup?: Lookup
  fileObserver?: typeof readFileObservation
}

interface PendingObservation {
  controller: AbortController
  promise: Promise<SensorObservation>
  operations: Set<Promise<unknown>>
  wrapperSettled: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context { eventTriggers: EventTriggersService }
}

export class EventTriggersService extends Service {
  static Config = ConfigSchema
  private readonly config: NormalizedConfig
  private readonly store: EventTriggerStore
  private readonly policy: AssistantPolicyService
  private readonly automations: AssistantAutomationsService
  private readonly credentials: CredentialsKeychainService | undefined
  private readonly triggers: ReadonlyMap<string, NormalizedTrigger>
  private readonly now: () => number
  private readonly fetcher: Fetcher | undefined
  private readonly lookup: Lookup
  private readonly fileObserver: typeof readFileObservation
  private readonly pinnedFileRoots: readonly PinnedFileRoot[]
  private readonly shutdown = new AbortController()
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private flushTimer: ReturnType<typeof setInterval> | undefined
  private pollInFlight: Promise<void> | undefined
  private flushInFlight: Promise<void> | undefined
  private pollCursor = 0
  private readonly inFlight = new Set<Promise<unknown>>()
  private readonly pendingObservations = new Map<string, PendingObservation>()
  private active = true

  constructor(ctx: Context, input: Config, options: EventTriggersServiceOptions = {}) {
    super(ctx, 'eventTriggers')
    this.config = normalizeEventTriggersConfig(input)
    const policy = ctx.get('assistantPolicy') as AssistantPolicyService | undefined
    const automations = ctx.get('assistantAutomations') as AssistantAutomationsService | undefined
    if (policy === undefined || automations === undefined) {
      throw new Error('event-triggers: assistantPolicy and assistantAutomations services are required')
    }
    this.policy = policy
    this.automations = automations
    this.credentials = ctx.get('credentialsKeychain') as CredentialsKeychainService | undefined
    if (this.config.triggers.some(trigger => trigger.kind === 'webhook') && this.credentials === undefined) {
      throw new Error('event-triggers: credentialsKeychain is required when webhook triggers are configured')
    }
    this.triggers = new Map(this.config.triggers.map(trigger => [trigger.id, trigger]))
    this.now = options.now ?? Date.now
    this.fetcher = options.fetcher
    this.lookup = options.lookup ?? defaultLookup
    this.fileObserver = options.fileObserver ?? readFileObservation
    this.pinnedFileRoots = this.config.triggers.some(trigger => trigger.kind === 'file')
      ? pinFileRoots(this.config.allowedFileRoots)
      : []
    this.store = new EventTriggerStore({ path: this.config.databasePath, now: this.now })
    this.flushTimer = setInterval(() => void this.flushPending().catch(() => {}), this.config.pollIntervalMs)
    this.flushTimer.unref?.()
    void this.flushPending().catch(() => {})
    if (this.config.pollerEnabled) {
      this.pollTimer = setInterval(() => void this.pollOnce().catch(() => {}), this.config.pollIntervalMs)
      this.pollTimer.unref?.()
      void this.pollOnce().catch(() => {})
    }
    ctx.effect(() => async () => {
      this.active = false
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
      if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
      this.shutdown.abort(new EventTriggersError('disposed', 'event-triggers service is disposed'))
      await Promise.allSettled(this.inFlight)
      this.store.close()
    }, 'event-triggers.runtime')
  }

  async pollOnce(): Promise<void> {
    this.assertActive()
    if (this.pollInFlight !== undefined) return this.pollInFlight
    const operation = this.track(Promise.resolve().then(() => this.performPollOnce()))
    this.pollInFlight = operation
    const clear = () => { if (this.pollInFlight === operation) this.pollInFlight = undefined }
    void operation.then(clear, clear)
    return operation
  }

  private async performPollOnce(): Promise<void> {
    const failures: unknown[] = []
    const enabled = this.config.triggers.filter(
      (trigger): trigger is Exclude<NormalizedTrigger, WebhookTriggerConfig> => trigger.enabled && trigger.kind !== 'webhook',
    )
    if (enabled.length > 0) {
      const start = this.pollCursor % enabled.length
      const triggers = [...enabled.slice(start), ...enabled.slice(0, start)]
      this.pollCursor = (start + 1) % enabled.length
      let next = 0
      const worker = async () => {
        while (!this.shutdown.signal.aborted) {
          const trigger = triggers[next]
          next += 1
          if (trigger === undefined) return
          try {
            await this.observeTrigger(trigger)
          } catch (error) {
            if (this.shutdown.signal.aborted) return
            this.store.markTriggerFailure(trigger.id, error, this.now())
            failures.push(error)
          }
        }
      }
      const workerCount = Math.min(this.config.pollConcurrency, triggers.length)
      const workers = await Promise.allSettled(Array.from({ length: workerCount }, worker))
      if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason
      for (const result of workers) if (result.status === 'rejected') failures.push(result.reason)
    }
    await this.startFlush()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1 && failures.every(error => error instanceof EventTriggersError && error.code === 'policy-denied')) {
      throw failures[0]
    }
    if (failures.length > 1) throw new AggregateError(failures, 'event-triggers: one or more sensors failed')
  }

  private async observeTrigger(trigger: Exclude<NormalizedTrigger, WebhookTriggerConfig>): Promise<void> {
    const resource = trigger.kind === 'file'
      ? { kind: 'filesystem' as const, id: trigger.path }
      : { kind: 'network' as const, id: trigger.url }
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: `event-triggers:${trigger.id}` },
      action: 'observe', resource, context: { initiator: 'background' },
    }, { idempotencyKey: `event-observe:${trigger.id}:${this.now()}` })
    if (decision.effect !== 'allow') {
      throw new EventTriggersError('policy-denied', `event-triggers policy denied observation: ${decision.reasonCode}`)
    }
    const observation = await this.startObservation(trigger)
    if (observation === undefined) return
    if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason
    const occurredAt = this.now()
    this.store.observe({
      triggerId: trigger.id, ...observation, occurredAt, fireWhen: trigger.fireWhen,
      debounceMs: trigger.debounceMs, cooldownMs: trigger.cooldownMs,
      maxFires: trigger.maxFires, ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
    })
    this.store.markTriggerSuccess(trigger.id, occurredAt)
  }

  /**
   * Starts at most one pure sensor read per trigger. A timed-out filesystem read
   * may be uninterruptible, so its eventual result is discarded and no durable
   * state is touched outside the bounded waiter below.
   */
  private async startObservation(
    trigger: Exclude<NormalizedTrigger, WebhookTriggerConfig>,
  ): Promise<SensorObservation | undefined> {
    if (this.pendingObservations.has(trigger.id)) return undefined
    const controller = new AbortController()
    const forwardShutdown = () => controller.abort(this.shutdown.signal.reason)
    if (this.shutdown.signal.aborted) forwardShutdown()
    else this.shutdown.signal.addEventListener('abort', forwardShutdown, { once: true })
    let entry!: PendingObservation
    const removeIfIdle = () => {
      if (entry.wrapperSettled && entry.operations.size === 0
        && this.pendingObservations.get(trigger.id) === entry) this.pendingObservations.delete(trigger.id)
    }
    const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
      entry.operations.add(operation)
      const settled = () => { entry.operations.delete(operation); removeIfIdle() }
      void operation.then(settled, settled)
      return operation
    }
    const promise = Promise.resolve().then(() => trigger.kind === 'file'
      ? this.fileObserver({ path: trigger.path, roots: this.config.allowedFileRoots,
          mode: trigger.mode, maxBytes: this.config.maxBodyBytes, pinnedRoots: this.pinnedFileRoots })
      : readHttpJsonObservation({ url: trigger.url, pointer: trigger.pointer,
          maxBodyBytes: this.config.maxBodyBytes, timeoutMs: this.config.requestTimeoutMs,
          allowedOrigins: new Set(this.config.allowedHttpOrigins), lookup: this.lookup, signal: controller.signal,
          allowIpv6: this.config.ipv6Mode === 'native-only', trackOperation,
          ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }) }))
    entry = { controller, promise, operations: new Set(), wrapperSettled: false }
    this.pendingObservations.set(trigger.id, entry)
    const wrapperSettled = () => {
      entry.wrapperSettled = true
      removeIfIdle()
    }
    void promise.then(wrapperSettled, wrapperSettled)
    const timer = setTimeout(() => {
      controller.abort(new Error(`event-triggers: observation timed out for trigger ${trigger.id}`))
    }, this.config.requestTimeoutMs)
    timer.unref?.()
    try {
      const observation = await this.raceObservation(promise, controller.signal)
      if (controller.signal.aborted) throw controller.signal.reason
      return observation
    } finally {
      clearTimeout(timer)
      this.shutdown.signal.removeEventListener('abort', forwardShutdown)
    }
  }

  private async raceObservation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw signal.reason
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const aborted = () => { cleanup(); rejectPromise(signal.reason) }
      const cleanup = () => signal.removeEventListener('abort', aborted)
      signal.addEventListener('abort', aborted, { once: true })
      void operation.then(
        value => { cleanup(); resolvePromise(value) },
        error => { cleanup(); rejectPromise(error) },
      )
    })
  }

  async flushPending(): Promise<void> {
    this.assertActive()
    return this.startFlush()
  }

  private startFlush(): Promise<void> {
    if (this.flushInFlight !== undefined) return this.flushInFlight
    const operation = this.track(Promise.resolve().then(() => this.performFlushPending()))
    this.flushInFlight = operation
    const clear = () => { if (this.flushInFlight === operation) this.flushInFlight = undefined }
    void operation.then(clear, clear)
    return operation
  }

  private async performFlushPending(): Promise<void> {
    const maximum = 2_000
    let processed = 0
    while (processed < maximum) {
      const items = this.store.pending(Math.min(100, maximum - processed))
      if (items.length === 0) return
      for (const item of items) {
        processed += 1
        const trigger = this.triggers.get(item.triggerId)
        if (trigger === undefined || !trigger.enabled) {
          this.store.quarantine(item.id, 'trigger is no longer configured or enabled')
          continue
        }
        this.store.markAttempt(item.id)
        try {
          this.automations.ingestExternal({
            sourceId: `event-triggers:${trigger.id}`,
            automationId: trigger.automationId,
            eventId: item.eventId,
            occurredAt: item.occurredAt,
          })
          this.store.markDelivered(item.id)
        } catch (error) {
          const exponent = Math.min(item.attempts, 10)
          const delay = Math.min(3_600_000, this.config.pollIntervalMs * (2 ** exponent))
          this.store.markRetry(item.id, error, this.now() + delay)
        }
      }
    }
  }

  async ingestWebhook(triggerId: string, input: {
    timestamp: string
    nonce: string
    signature: string
    body: Buffer
  }): Promise<{ accepted: true; eventId: string }> {
    this.assertActive()
    return this.track(Promise.resolve().then(() => this.performIngestWebhook(triggerId, input)))
  }

  private async performIngestWebhook(triggerId: string, input: {
    timestamp: string
    nonce: string
    signature: string
    body: Buffer
  }): Promise<{ accepted: true; eventId: string }> {
    const trigger = this.triggers.get(triggerId)
    if (trigger?.kind !== 'webhook' || !trigger.enabled) throw new EventTriggersError('not-found', 'webhook trigger was not found')
    if (input.body.byteLength > this.config.maxBodyBytes) throw new Error('event-triggers: webhook body exceeds limit')
    const receivedAt = this.now()
    const timestamp = Number(input.timestamp)
    if (!Number.isSafeInteger(timestamp) || Math.abs(receivedAt - timestamp) > trigger.maxSkewMs) {
      throw new EventTriggersError('timestamp', 'event-triggers: webhook timestamp is outside the accepted window')
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(input.nonce)) throw new EventTriggersError('replay', 'invalid webhook nonce')
    if (this.store.hasWebhookEvent(trigger.id, input.nonce)) throw new EventTriggersError('replay', 'webhook nonce was already accepted')
    if (!/^sha256=[a-f0-9]{64}$/u.test(input.signature)) {
      throw new EventTriggersError('invalid-signature', 'event-triggers: webhook signature is malformed')
    }
    await this.verifySignature(trigger, input)
    const decision = this.policy.authorize({
      subject: { kind: 'external', id: `webhook:${trigger.id}` }, action: 'accept',
      resource: { kind: 'automation', id: trigger.automationId }, context: { initiator: 'external' },
    }, { idempotencyKey: `event-webhook:${trigger.id}:${input.nonce}` })
    if (decision.effect !== 'allow') throw new EventTriggersError('policy-denied', 'event-triggers policy denied webhook')
    const accepted = this.store.acceptWebhook({
      triggerId: trigger.id, eventId: input.nonce, occurredAt: timestamp, acceptedAt: receivedAt,
      cooldownMs: trigger.cooldownMs, maxFires: trigger.maxFires,
      ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
    })
    if (!accepted.accepted) {
      throw new EventTriggersError(accepted.reason, `event-triggers: webhook event was rejected by ${accepted.reason}`)
    }
    await this.startFlush()
    return { accepted: true, eventId: accepted.event.eventId }
  }

  health(): ReturnType<EventTriggerStore['health']> { this.assertActive(); return this.store.health() }

  private async verifySignature(
    trigger: Extract<NormalizedTrigger, WebhookTriggerConfig>,
    input: { timestamp: string; nonce: string; signature: string; body: Buffer },
  ): Promise<void> {
    await this.credentials!.withSecret(this.ctx, {
      handleId: trigger.credentialHandle,
      purpose: 'verify-webhook',
      ttlMs: 10_000,
      idempotencyKey: `event-webhook-signature:${trigger.id}:${input.nonce}`,
    }, async (secret) => {
      const expected = createHmac('sha256', secret).update(`${input.timestamp}\n${input.nonce}\n`).update(input.body).digest()
      const supplied = Buffer.from(input.signature.slice('sha256='.length), 'hex')
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
        throw new EventTriggersError('invalid-signature', 'event-triggers: webhook signature is invalid')
      }
    })
  }

  private assertActive(): void {
    if (!this.active) throw new EventTriggersError('disposed', 'event-triggers service is disposed')
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation)
    const remove = () => { this.inFlight.delete(operation) }
    void operation.then(remove, remove)
    return operation
  }
}

export { ConfigSchema as Config }
