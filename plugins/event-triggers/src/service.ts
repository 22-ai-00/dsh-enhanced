import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import {
  canonicalExternalEventEnvelope,
  externalEventDigest,
  parseExternalEventEnvelope,
  type ExternalEventEnvelope,
} from '@dsh-enhanced/assistant-automations/external-event'
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
import type { EventSourceReader, EventSourceSnapshot, SourceEvent } from './source.js'
import { version } from './version.js'
import { EventSourceObservers } from './observer.js'
import { readGitHubRepositoryObservation } from './github-sensor.js'

export type EventTriggersErrorCode =
  | 'cooldown'
  | 'disposed'
  | 'invalid-signature'
  | 'limit'
  | 'not-found'
  | 'policy-denied'
  | 'replay'
  | 'source-changed'
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

declare module '@deepseek-ai/cordis' {
  interface Context { eventTriggers: EventTriggersService }
}

export class EventTriggersService extends Service implements EventSourceReader {
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
  private readonly sourceChangeListeners = new Set<() => void>()
  private readonly observers: EventSourceObservers
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
    if (this.config.triggers.some(trigger => (trigger.kind === 'webhook' || trigger.kind === 'github-repository')) && this.credentials === undefined) {
      throw new Error('event-triggers: credentialsKeychain is required for authenticated triggers')
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
    this.observers = new EventSourceObservers(ctx, this.config.triggers.filter(trigger => trigger.observer !== undefined).map(trigger => ({ triggerId: trigger.id, automationId: trigger.automationId, configDigest: this.triggerConfigDigest(trigger), owner: trigger.observer!, lifetime: trigger.observerLifetime })), this.store)
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
      this.sourceChangeListeners.clear()
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
      : { kind: 'network' as const, id: trigger.kind === 'github-repository' ? `https://api.github.com/repos/${trigger.repository}` : trigger.url }
    this.observers.assertCurrent(trigger.id)
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: `event-triggers:${trigger.id}`, ...(trigger.observer ? { workspace: trigger.observer.workspace, principal: trigger.observer.principalId } : {}) },
      action: 'observe', resource, context: { initiator: 'background' },
    }, { idempotencyKey: `event-observe:${trigger.id}:${randomUUID()}` })
    if (decision.effect !== 'allow') {
      throw new EventTriggersError('policy-denied', `event-triggers policy denied observation: ${decision.reasonCode}`)
    }
    const observation = await this.startObservation(trigger)
    if (observation === undefined) return
    if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason
    this.observers.assertCurrent(trigger.id)
    const occurredAt = this.now()
    const produced = this.store.observe({
      triggerId: trigger.id, ...observation, occurredAt, fireWhen: trigger.fireWhen,
      debounceMs: trigger.debounceMs, cooldownMs: trigger.cooldownMs,
      maxFires: trigger.maxFires, ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
      envelope: (eventId, revision) => this.envelope({
        trigger, eventId, occurredAt, receivedAt: occurredAt, fingerprint: observation.fingerprint,
        revision, timeBasis: 'observed', method: trigger.kind === 'file' ? 'local-observation' : 'https-observation',
      }),
    })
    if (produced.length > 0) this.notifySourceChanges()
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
      : trigger.kind === 'github-repository' ? this.readGitHubObservation(trigger, controller, trackOperation)
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

  private async readGitHubObservation(trigger: Extract<NormalizedTrigger, { kind: 'github-repository' }>, controller: AbortController, trackOperation: import('./sensors.js').OperationTracker): Promise<SensorObservation> {
    const guard = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      this.assertActive(); this.observers.assertCurrent(trigger.id)
      const decision = this.policy.evaluate({ subject: { kind: 'background', id: `event-triggers:${trigger.id}`, workspace: trigger.observer.workspace, principal: trigger.observer.principalId },
        action: 'observe', resource: { kind: 'network', id: `https://api.github.com/repos/${trigger.repository}` }, context: { initiator: 'background' } })
      if (decision.effect !== 'allow') throw new EventTriggersError('policy-denied', 'GitHub observation permission ended')
    }
    guard()
    const timer = setInterval(() => { try { guard() } catch (error) { controller.abort(error) } }, 25)
    timer.unref?.()
    try {
      return await this.credentials!.withSecret(this.ctx, { handleId: trigger.credentialHandle, purpose: 'github.observe',
        ttlMs: Math.max(1_000, Math.min(30_000, this.config.requestTimeoutMs)), idempotencyKey: `event-github:${trigger.id}:${randomUUID()}` }, async (token, leaseSignal) => {
        guard()
        const result = await readGitHubRepositoryObservation({ repository: trigger.repository, branch: trigger.branch, baseBranch: trigger.baseBranch, token,
          maxBodyBytes: this.config.maxBodyBytes, timeoutMs: Math.min(30_000, this.config.requestTimeoutMs), signal: AbortSignal.any([controller.signal, leaseSignal]),
          lookup: this.lookup, ...(this.fetcher ? { fetcher: this.fetcher } : {}), allowIpv6: this.config.ipv6Mode === 'native-only', trackOperation, beforeRequest: guard })
        guard(); return result
      })
    } finally { clearInterval(timer) }
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
    try {
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
          if (item.envelope === undefined) {
            this.store.quarantine(item.id, 'legacy event has no provenance; operator must verify its historical target')
            continue
          }
          this.store.markAttempt(item.id)
          try {
            this.observers.assertCurrent(trigger.id)
            const envelope = parseExternalEventEnvelope(JSON.parse(item.envelope.canonical))
            if (externalEventDigest(envelope) !== item.envelope.digest
              || envelope.source.id !== `event-triggers:${trigger.id}`
              || envelope.source.version !== version
              || envelope.source.configDigest !== this.triggerConfigDigest(trigger)
              || envelope.target.automationId !== trigger.automationId
              || envelope.event.id !== item.eventId) {
              this.store.quarantine(item.id, 'event provenance no longer matches the configured trigger')
              continue
            }
            this.automations.ingestExternal({
              sourceId: `event-triggers:${trigger.id}`,
              automationId: trigger.automationId,
              eventId: item.eventId,
              occurredAt: item.occurredAt,
              envelope,
            })
            this.store.markDelivered(item.id)
          } catch (error) {
            const exponent = Math.min(item.attempts, 10)
            const delay = Math.min(3_600_000, this.config.pollIntervalMs * (2 ** exponent))
            this.store.markRetry(item.id, error, this.now() + delay)
          }
        }
      }
    } finally {
      this.notifySourceChanges()
    }
  }

  async ingestWebhook(triggerId: string, input: {
    timestamp: string
    nonce: string
    signature: string
    body: Buffer
  }): Promise<{ accepted: true; eventId: string }> {
    this.assertActive()
    if (!Buffer.isBuffer(input.body) || input.body.byteLength > this.config.maxBodyBytes) {
      throw new Error('event-triggers: webhook body exceeds limit')
    }
    const snapshot = Object.freeze({
      timestamp: input.timestamp,
      nonce: input.nonce,
      signature: input.signature,
      body: Buffer.from(input.body),
    })
    return this.track(Promise.resolve().then(() => this.performIngestWebhook(triggerId, snapshot)))
  }

  private async performIngestWebhook(triggerId: string, input: {
    timestamp: string
    nonce: string
    signature: string
    body: Buffer
  }): Promise<{ accepted: true; eventId: string }> {
    const trigger = this.triggers.get(triggerId)
    if (trigger?.kind !== 'webhook' || !trigger.enabled) throw new EventTriggersError('not-found', 'webhook trigger was not found')
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
      envelope: (eventId, revision) => this.envelope({
        trigger, eventId, occurredAt: timestamp, receivedAt, fingerprint: createHash('sha256').update(input.body).digest('hex'),
        revision: revision.slice('webhook:'.length), timeBasis: 'source-signed', method: 'hmac-sha256',
      }),
    })
    if (!accepted.accepted) {
      throw new EventTriggersError(accepted.reason, `event-triggers: webhook event was rejected by ${accepted.reason}`)
    }
    this.notifySourceChanges()
    await this.startFlush()
    return { accepted: true, eventId: accepted.event.eventId }
  }

  health(): ReturnType<EventTriggerStore['health']> { this.assertActive(); return this.store.health() }

  /** Public task metadata for exact owner/scope discovery; never returns credentials or read payloads. */
  inspectOwnerSources = (scope: { principalId: string; principalRecordId: string; principalVersion: number; workspace: string; preset: string }) => {
    this.assertActive()
    return Object.freeze(this.config.triggers.flatMap(trigger => {
      const owner = trigger.observer
      if (!owner || !trigger.enabled || owner.principalId !== scope.principalId || owner.principalRecordId !== scope.principalRecordId
        || owner.principalVersion !== scope.principalVersion || owner.workspace !== scope.workspace || owner.preset !== scope.preset) return []
      try { this.observers.assertCurrent(trigger.id) } catch { return [] }
      return [Object.freeze({ triggerId: trigger.id, automationId: trigger.automationId, kind: trigger.kind, expiresAt: owner.expiresAt,
        ...(trigger.kind === 'github-repository' ? { repository: trigger.repository, branch: trigger.branch } : {}) })]
    }))
  }

  sourceSnapshot(triggerId: string): Readonly<EventSourceSnapshot> {
    this.assertActive()
    const trigger = this.sourceTrigger(triggerId)
    return Object.freeze({
      protocol: 'dsh-event-source/v1' as const,
      sourceId: `event-triggers:${trigger.id}`,
      kind: trigger.kind,
      version,
      configDigest: this.triggerConfigDigest(trigger),
      target: Object.freeze({ automationId: trigger.automationId }),
      highWaterSequence: this.store.sourceHighWaterSequence(),
    })
  }

  firstEventAfter(
    snapshot: Readonly<EventSourceSnapshot>, afterSequence: number, deadlineAt: number,
  ): Readonly<SourceEvent> | undefined {
    this.assertActive()
    if (!Number.isSafeInteger(afterSequence) || afterSequence < snapshot.highWaterSequence
      || !Number.isSafeInteger(deadlineAt) || deadlineAt < 0) {
      throw new EventTriggersError('source-changed', 'event-triggers: event source cursor or deadline is invalid')
    }
    const triggerId = this.assertSnapshotCurrent(snapshot)
    const throughSequence = this.store.sourceHighWaterSequence()
    let cursor = afterSequence
    while (true) {
      const candidates = this.store.sourceCandidatesAfter({
        triggerId, afterSequence: cursor, throughSequence, deadlineAt, sourceId: snapshot.sourceId,
        kind: snapshot.kind, version: snapshot.version, configDigest: snapshot.configDigest,
        automationId: snapshot.target.automationId,
      })
      if (candidates.length === 0) return undefined
      for (const item of candidates) {
        cursor = item.sequence
        try {
          const envelope = parseExternalEventEnvelope(JSON.parse(item.canonical))
          if (externalEventDigest(envelope) !== item.digest
            || !this.matchesSnapshot(envelope, snapshot, item.eventId)
            || envelope.event.receivedAt > deadlineAt
            || this.isSourceSignedOutsideSkew(triggerId, envelope)) continue
          return Object.freeze({ sequence: item.sequence, envelope })
        } catch {
          // A malformed or non-provenance row has no authority for source reads.
        }
      }
      if (candidates.length < 100) return undefined
    }
  }

  subscribeSourceChanges(listener: () => void): () => void {
    this.assertActive()
    this.sourceChangeListeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.sourceChangeListeners.delete(listener)
    }
  }

  claimGoalSource = (input: import('./store.js').GoalSourceClaim): boolean => this.observers.claimGoalSource(input)
  retireGoalSource = (input: import('./store.js').GoalSourceClaim): boolean => this.observers.retireGoalSource(input)
  canSettleGoalSource = (input: import('./store.js').GoalSourceClaim): boolean => {
    this.assertActive()
    const trigger = this.triggers.get(input.triggerId)
    return trigger !== undefined && trigger.enabled && this.observers.canSettleGoalSource(input)
  }

  private sourceTrigger(triggerId: string): NormalizedTrigger {
    const trigger = this.triggers.get(triggerId)
    if (trigger === undefined || !trigger.enabled) {
      throw new EventTriggersError('source-changed', 'event-triggers: event source is no longer configured or enabled')
    }
    this.observers.assertCurrent(trigger.id)
    return trigger
  }

  private assertSnapshotCurrent(snapshot: Readonly<EventSourceSnapshot>): string {
    if (snapshot.protocol !== 'dsh-event-source/v1'
      || typeof snapshot.sourceId !== 'string'
      || !Number.isSafeInteger(snapshot.highWaterSequence) || snapshot.highWaterSequence < 0
      || !/^[a-f0-9]{64}$/u.test(snapshot.configDigest)
      || typeof snapshot.version !== 'string'
      || typeof snapshot.target?.automationId !== 'string') {
      throw new EventTriggersError('source-changed', 'event-triggers: event source snapshot is invalid')
    }
    const prefix = 'event-triggers:'
    if (!snapshot.sourceId.startsWith(prefix)) {
      throw new EventTriggersError('source-changed', 'event-triggers: event source snapshot is invalid')
    }
    const triggerId = snapshot.sourceId.slice(prefix.length)
    const trigger = this.sourceTrigger(triggerId)
    if (snapshot.kind !== trigger.kind || snapshot.version !== version
      || snapshot.configDigest !== this.triggerConfigDigest(trigger)
      || snapshot.target.automationId !== trigger.automationId) {
      throw new EventTriggersError('source-changed', 'event-triggers: event source configuration changed')
    }
    return triggerId
  }

  private matchesSnapshot(
    envelope: Readonly<ExternalEventEnvelope>, snapshot: Readonly<EventSourceSnapshot>, eventId: string,
  ): boolean {
    return envelope.source.id === snapshot.sourceId
      && envelope.source.kind === snapshot.kind
      && envelope.source.version === snapshot.version
      && envelope.source.configDigest === snapshot.configDigest
      && envelope.target.automationId === snapshot.target.automationId
      && envelope.event.id === eventId
  }

  private isSourceSignedOutsideSkew(triggerId: string, envelope: Readonly<ExternalEventEnvelope>): boolean {
    const trigger = this.triggers.get(triggerId)
    return trigger?.kind === 'webhook'
      && (envelope.observation.timeBasis !== 'source-signed'
        || Math.abs(envelope.event.receivedAt - envelope.event.occurredAt) > trigger.maxSkewMs)
  }

  private notifySourceChanges(): void {
    // Snapshot once so a callback cannot extend this notification by subscribing again.
    const listeners = [...this.sourceChangeListeners]
    for (const listener of listeners) {
      try { listener() } catch {}
    }
  }

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

  private triggerConfigDigest(trigger: NormalizedTrigger): string {
    const { observerLifetime, ...legacy } = trigger
    return createHash('sha256').update(stableJson(observerLifetime === 'shared' ? legacy : trigger)).digest('hex')
  }

  private envelope(input: {
    trigger: NormalizedTrigger
    eventId: string
    occurredAt: number
    receivedAt: number
    fingerprint: string
    revision: string
    timeBasis: 'observed' | 'source-signed'
    method: 'local-observation' | 'https-observation' | 'hmac-sha256'
  }): Readonly<{ canonical: string; digest: string }> {
    const observationDigest = /^[a-f0-9]{64}$/u.test(input.fingerprint)
      ? input.fingerprint
      : /^sha256:[a-f0-9]{64}$/u.test(input.fingerprint)
        ? input.fingerprint.slice('sha256:'.length)
        : createHash('sha256').update(input.fingerprint).digest('hex')
    const envelope: ExternalEventEnvelope = {
      protocol: 'dsh-external-event/v1',
      source: {
        id: `event-triggers:${input.trigger.id}`,
        kind: input.trigger.kind,
        version,
        configDigest: this.triggerConfigDigest(input.trigger),
      },
      event: { id: input.eventId, occurredAt: input.occurredAt, receivedAt: input.receivedAt },
      observation: { digest: observationDigest, revision: input.revision, timeBasis: input.timeBasis },
      trust: { method: input.method, content: 'untrusted' },
      target: { automationId: input.trigger.automationId },
      deduplicationKey: `event-triggers:${input.trigger.id}:${input.eventId}`,
    }
    const parsed = parseExternalEventEnvelope(envelope)
    return Object.freeze({ canonical: canonicalExternalEventEnvelope(parsed), digest: externalEventDigest(parsed) })
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
