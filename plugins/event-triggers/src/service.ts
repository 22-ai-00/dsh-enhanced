import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { isAbsolute, resolve } from 'node:path'
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
  type WebhookAuthMode,
  type WebhookTriggerConfig,
} from './config.js'
import {
  defaultLookup,
  pinFileRoots,
  readFileObservation,
  readHttpJsonObservation,
  type Fetcher,
  type Lookup,
  type OperationTracker,
  type PinnedFileRoot,
  type SensorObservation,
} from './sensors.js'
import { EventTriggerStore, EventTriggerStoreError, type GoalSourceClaim, type TriggerCursor, type TriggerOutboxEvent } from './store.js'
import type { EventSourceReader, EventSourceSnapshot, SourceEvent } from './source.js'
import { version } from './version.js'
import { EventSourceObservers, type GoalSourceDetachEvent, type GoalSourceUnsubscribeHook, type GoalSourceUnsubscribeInput } from './observer.js'
import { EventIntakeAdapter, buildEventIntakeObservation, buildEventIntakeSummary, type EventIntakeObserver } from './intake.js'
import { readGitHubRepositoryObservation } from './github-sensor.js'
import { readLarkCalendarObservation, type LarkCalendarPageReader } from './lark-calendar-sensor.js'
import { readTaskSystemObservation } from './task-system-sensor.js'
import { readCalendarObservation } from './calendar-sensor.js'
import { readEmailObservation } from './email-sensor.js'
import type { RepositoryEventObservationPort } from './actions-port.js'

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

function isKeychainPolicyDeniedError(error: unknown): boolean {
  return error instanceof Error
    && error.name === 'CredentialsKeychainError'
    && (error as { code?: unknown }).code === 'policy-denied'
}

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
  larkCalendarReader?: LarkCalendarPageReader
  intakeObserver?: EventIntakeObserver
}

export interface OwnerOutboxScope {
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly preset: string
}

export interface OwnerOutboxEventSummary {
  readonly sequence: number
  readonly triggerId: string
  readonly triggerKind: NormalizedTrigger['kind']
  readonly automationId: string
  readonly eventId: string
  readonly occurredAt: number
  readonly title: string
  readonly summary: string
  readonly envelopeDigest: string
  readonly observationDigest: string
  readonly ttlMs?: number
  readonly entities: readonly string[]
}

export interface InspectOwnerOutboxEventsInput {
  readonly scope: OwnerOutboxScope
  readonly afterSequence?: number
  readonly limit?: number
}

export interface InspectOwnerOutboxEventsResult {
  readonly items: readonly OwnerOutboxEventSummary[]
  readonly nextSequence: number
  readonly hasMore: boolean
}

function isTerminalGoalChangedPayload(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true
  const change = (payload as { change?: unknown }).change
  if (!change || typeof change !== 'object') return true
  const operation = (change as { operation?: unknown }).operation
  const phase = ((change as { goal?: unknown }).goal as { phase?: unknown } | undefined)?.phase
  if (operation === 'complete' || operation === 'clear' || operation === 'block') return true
  if (phase === 'complete' || phase === 'cleared' || phase === 'blocked') return true
  return operation === undefined && phase === undefined
}

interface LarkChannelCalendarService extends LarkCalendarPageReader {}

interface PendingObservation {
  controller: AbortController
  promise: Promise<ExtendedObservation>
  operations: Set<Promise<unknown>>
  wrapperSettled: boolean
}

interface ExtendedObservation extends SensorObservation {
  readonly notModified?: boolean
  readonly nextCursor?: TriggerCursor
}

export interface WebhookListenAddress {
  readonly host: string
  readonly port: number
  readonly basePath: string
}

type EnvelopeKind = 'file' | 'http-json' | 'webhook' | 'github-repository' | 'lark-calendar'

function envelopeSourceKind(trigger: NormalizedTrigger): EnvelopeKind {
  if (trigger.kind === 'task-system' || trigger.kind === 'calendar' || trigger.kind === 'email') {
    return 'http-json'
  }
  return trigger.kind
}

function resolveLarkCalendarWindow(
  trigger: Extract<NormalizedTrigger, { kind: 'lark-calendar' }>,
  nowMs: number,
): { startTime: number; endTime: number } {
  if (trigger.startTime !== undefined && trigger.endTime !== undefined) {
    return { startTime: trigger.startTime, endTime: trigger.endTime }
  }
  const rawSec = Math.floor(nowMs / 1_000)
  const step = trigger.windowStepSeconds
  const baseSec = step !== undefined ? Math.floor(rawSec / step) * step : rawSec
  const startTime = Math.max(0, baseSec - (trigger.lookbackSeconds ?? 0))
  const endTime = baseSec + (trigger.lookaheadSeconds ?? 0)
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime < 0 || endTime <= startTime) {
    throw new Error('event-triggers: Lark calendar rolling window is empty at current time')
  }
  return { startTime, endTime }
}

function sha256Digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
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
  private readonly larkCalendarReader: LarkCalendarPageReader | undefined
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
  private readonly scopedSourceListeners = new Map<() => void, Readonly<{ triggerId?: string; goalId?: string }>>()
  private readonly intakeAdapter: EventIntakeAdapter
  private readonly observers: EventSourceObservers
  private readonly webhookRoutes = new Map<string, Extract<NormalizedTrigger, { kind: 'webhook' }>>()
  private webhookServer: Server | undefined
  private webhookListenPromise: Promise<WebhookListenAddress | undefined> | undefined
  private resolvedWebhookAddress: WebhookListenAddress | undefined
  private activeWebhookRequests = 0
  private goalReconcileQueued = false
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
    const needsCredentials = this.config.triggers.some(trigger =>
      trigger.kind === 'webhook'
      || ((trigger.kind === 'github-repository' || trigger.kind === 'task-system' || trigger.kind === 'calendar' || trigger.kind === 'email')
        && trigger.credentialHandle !== undefined && trigger.credentialHandle !== ''),
    )
    if (needsCredentials && this.credentials === undefined) {
      throw new Error('event-triggers: credentialsKeychain is required for authenticated triggers')
    }
    if (this.config.triggers.some(trigger => trigger.kind === 'github-repository' && trigger.externalGrant !== undefined)) this.currentAssistantActions()
    this.larkCalendarReader = options.larkCalendarReader ?? ctx.get('larkChannel') as LarkChannelCalendarService | undefined
    if (this.config.triggers.some(trigger => trigger.kind === 'lark-calendar') && this.larkCalendarReader === undefined) {
      throw new Error('event-triggers: larkChannel is required for Lark calendar triggers')
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
    this.intakeAdapter = new EventIntakeAdapter(ctx, options.intakeObserver)
    this.observers = new EventSourceObservers(
      ctx,
      this.config.triggers.filter(trigger => trigger.observer !== undefined).map(trigger => ({
        triggerId: trigger.id,
        automationId: trigger.automationId,
        configDigest: this.triggerConfigDigest(trigger),
        owner: trigger.observer!,
        lifetime: trigger.observerLifetime,
      })),
      this.store,
      { onSourceDetached: event => this.handleSourceDetached(event) },
    )
    const unsubGoalChanged = (ctx as unknown as {
      on?: (event: string, listener: (payload?: unknown) => void) => (() => void) | undefined
    }).on?.('goal/changed', payload => {
      if (!this.active || !isTerminalGoalChangedPayload(payload) || this.goalReconcileQueued) return
      this.goalReconcileQueued = true
      queueMicrotask(() => {
        this.goalReconcileQueued = false
        if (this.active) this.observers.reconcileGoalSources()
      })
    })
    this.flushTimer = setInterval(() => void this.flushPending().catch(() => {}), this.config.pollIntervalMs)
    this.flushTimer.unref?.()
    void this.flushPending().catch(() => {})
    if (this.config.pollerEnabled) {
      this.pollTimer = setInterval(() => void this.pollOnce().catch(() => {}), this.config.pollIntervalMs)
      this.pollTimer.unref?.()
      void this.pollOnce().catch(() => {})
    }
    if (this.config.webhookListen?.enabled) {
      this.startWebhookListener(this.config.webhookListen)
    }
    ctx.effect(() => async () => {
      this.active = false
      await this.closeWebhookListener()
      unsubGoalChanged?.()
      if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
      if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
      this.shutdown.abort(new EventTriggersError('disposed', 'event-triggers service is disposed'))
      await Promise.allSettled(this.inFlight)
      this.intakeAdapter.dispose()
      this.scopedSourceListeners.clear()
      this.sourceChangeListeners.clear()
      this.store.close()
    }, 'event-triggers.runtime')
  }

  whenWebhookListening(): Promise<WebhookListenAddress | undefined> {
    this.assertActive()
    return this.webhookListenPromise ?? Promise.resolve(undefined)
  }

  webhookAddress(): WebhookListenAddress | undefined {
    this.assertActive()
    return this.resolvedWebhookAddress
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
    // A dedicated source that durably retired after a trusted goal completion
    // has no future observation authority.  It is intentionally absent from
    // health failures; changed bindings and every non-terminal denial still
    // take the normal fail-closed path below.
    if (this.observers.isRetiredGoalSource(trigger.id)) return
    const resource = trigger.kind === 'file'
      ? { kind: 'filesystem' as const, id: trigger.path }
      : { kind: 'network' as const, id: trigger.kind === 'github-repository' ? `https://api.github.com/repos/${trigger.repository}`
        : trigger.kind === 'lark-calendar' ? `lark-calendar:${trigger.calendarId}` : trigger.url }
    try {
      this.observers.assertCurrent(trigger.id)
    } catch (error) {
      // `assertCurrent()` can itself discover and durably retire a completed
      // goal between the inexpensive admission check above and Policy.  That
      // closed state is not a failed sensor observation.
      if (this.observers.isRetiredGoalSource(trigger.id)) return
      throw error
    }
    const decision = this.policy.authorize({
      subject: { kind: 'background', id: `event-triggers:${trigger.id}`, ...(trigger.observer ? { workspace: trigger.observer.workspace, principal: trigger.observer.principalId } : {}) },
      action: 'observe', resource, context: { initiator: 'background' },
    }, { idempotencyKey: `event-observe:${trigger.id}:${randomUUID()}` })
    if (decision.effect !== 'allow') {
      throw new EventTriggersError('policy-denied', `event-triggers policy denied observation: ${decision.reasonCode}`)
    }
    let observation: ExtendedObservation | undefined
    const hasBaseline = this.store.hasTriggerState(trigger.id)
    const priorCursor = (trigger.kind === 'task-system' || trigger.kind === 'calendar' || trigger.kind === 'email')
      ? this.store.getTriggerCursor(trigger.id)
      : undefined
    try {
      observation = await this.startObservation(trigger, priorCursor, hasBaseline)
    } catch (error) {
      // Retirement may race a bounded sensor/broker read.  Suppress only its
      // late result, after the durable matching retirement is visible.
      if (this.observers.isRetiredGoalSource(trigger.id)) return
      throw error
    }
    if (observation === undefined) return
    if (this.shutdown.signal.aborted) throw this.shutdown.signal.reason
    if (this.observers.isRetiredGoalSource(trigger.id)) return
    this.observers.assertCurrent(trigger.id)
    const occurredAt = this.now()
    const produced = this.store.observe({
      triggerId: trigger.id,
      fingerprint: observation.fingerprint,
      truthy: observation.truthy,
      occurredAt,
      fireWhen: trigger.fireWhen,
      debounceMs: trigger.debounceMs,
      cooldownMs: trigger.cooldownMs,
      maxFires: trigger.maxFires,
      ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
      ...(observation.notModified ? { notModified: true } : {}),
      ...(observation.nextCursor === undefined ? {} : { cursor: observation.nextCursor }),
      envelope: (eventId, revision) => this.envelope({
        trigger, eventId, occurredAt, receivedAt: occurredAt, fingerprint: observation.fingerprint,
        revision, timeBasis: 'observed', method: trigger.kind === 'file' ? 'local-observation' : 'https-observation',
      }),
    })
    if (produced.length > 0) {
      this.emitIntakeForOutbox(trigger, produced)
      this.notifySourceChanges()
    }
    this.store.markTriggerSuccess(trigger.id, occurredAt)
  }

  /**
   * Starts at most one pure sensor read per trigger. A timed-out filesystem read
   * may be uninterruptible, so its eventual result is discarded and no durable
   * state is touched outside the bounded waiter below.
   */
  private async startObservation(
    trigger: Exclude<NormalizedTrigger, WebhookTriggerConfig>,
    priorCursor?: Readonly<TriggerCursor>,
    hasBaseline = false,
  ): Promise<ExtendedObservation | undefined> {
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
      : trigger.kind === 'lark-calendar' ? this.readLarkCalendarObservation(trigger, controller)
      : trigger.kind === 'task-system' ? this.readTaskSystemTriggerObservation(trigger, controller, trackOperation, priorCursor, hasBaseline)
      : trigger.kind === 'calendar' ? this.readCalendarTriggerObservation(trigger, controller, trackOperation, priorCursor, hasBaseline)
      : trigger.kind === 'email' ? this.readEmailTriggerObservation(trigger, controller, trackOperation, priorCursor, hasBaseline)
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
      if (trigger.externalGrant !== undefined) return await this.readExternalGitHubObservation(trigger, controller, guard)
      return await this.credentials!.withSecret(this.ctx, { handleId: trigger.credentialHandle!, purpose: 'github.observe',
        ttlMs: Math.max(1_000, Math.min(30_000, this.config.requestTimeoutMs)), idempotencyKey: `event-github:${trigger.id}:${randomUUID()}` }, async (token, leaseSignal) => {
        guard()
        const result = await readGitHubRepositoryObservation({ repository: trigger.repository, branch: trigger.branch, baseBranch: trigger.baseBranch, ...(trigger.deliveryMode === undefined ? {} : { deliveryMode: trigger.deliveryMode }), token,
          maxBodyBytes: this.config.maxBodyBytes, timeoutMs: Math.min(30_000, this.config.requestTimeoutMs), signal: AbortSignal.any([controller.signal, leaseSignal]),
          lookup: this.lookup, ...(this.fetcher ? { fetcher: this.fetcher } : {}), allowIpv6: this.config.ipv6Mode === 'native-only', trackOperation, beforeRequest: guard })
        guard(); return result
      })
    } finally { clearInterval(timer) }
  }

  private async readExternalGitHubObservation(trigger: Extract<NormalizedTrigger, { kind: 'github-repository' }>, controller: AbortController, guard: () => void): Promise<SensorObservation> {
    const grant = trigger.externalGrant!
    const claim = this.store.goalSourceClaim(trigger.id)
    if (claim?.retiredAt !== undefined) throw new Error('event-triggers: external GitHub goal source is retired')
    const owner = trigger.observer
    if (owner === undefined || trigger.observerLifetime !== 'goal') throw new Error('event-triggers: external GitHub observer is invalid')
    const input = Object.freeze({ version: 1 as const, triggerId: trigger.id, grantId: grant.id, grantRevision: grant.revision, grantDigest: grant.digest,
      repository: trigger.repository, branch: trigger.branch, baseBranch: trigger.baseBranch, ...(trigger.deliveryMode === undefined ? {} : { deliveryMode: trigger.deliveryMode }),
      owner: Object.freeze({ workspace: owner.workspace, preset: owner.preset, principalId: owner.principalId, principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, ownerRouteId: owner.ownerRouteId, expiresAt: owner.expiresAt, budgetId: owner.budgetId }),
      ...(claim === undefined ? {} : { goal: Object.freeze({ id: claim.goalId, sessionId: claim.native.sessionId, nativeGoalId: claim.native.goalId, definitionVersion: claim.definition.version, definitionDigest: claim.definition.digest }) }),
    })
    guard()
    const actions = this.currentAssistantActions()
    const observed = await actions.readRepositoryEventObservation(input, controller.signal)
    guard()
    // Cordis creates a new traceable Service proxy on each lookup. Provider
    // replacement unloads this owned injection and aborts its observations;
    // compare neither those proxies nor methods bound through them.
    this.currentAssistantActions()
    if (!observed || observed.protocol !== 'assistant-actions/repository-event/v1' || observed.truthy !== true
      || typeof observed.fingerprint !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(observed.fingerprint)) {
      throw new Error('event-triggers: assistantActions returned an invalid repository observation')
    }
    return Object.freeze({ fingerprint: observed.fingerprint, truthy: true })
  }

  private currentAssistantActions(): RepositoryEventObservationPort {
    const actions = this.ctx.get('assistantActions') as RepositoryEventObservationPort | undefined
    if (!actions || typeof actions.readRepositoryEventObservation !== 'function') throw new Error('event-triggers: active assistantActions repository observation service is required')
    return actions
  }

  private async readLarkCalendarObservation(trigger: Extract<NormalizedTrigger, { kind: 'lark-calendar' }>, controller: AbortController): Promise<SensorObservation> {
    const guard = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      this.assertActive(); this.observers.assertCurrent(trigger.id)
      const decision = this.policy.evaluate({ subject: { kind: 'background', id: `event-triggers:${trigger.id}`, workspace: trigger.observer.workspace, principal: trigger.observer.principalId },
        action: 'observe', resource: { kind: 'network', id: `lark-calendar:${trigger.calendarId}` }, context: { initiator: 'background' } })
      if (decision.effect !== 'allow') throw new EventTriggersError('policy-denied', 'Lark calendar observation permission ended')
    }
    guard()
    const timer = setInterval(() => { try { guard() } catch (error) { controller.abort(error) } }, 25)
    timer.unref?.()
    try {
      const { startTime, endTime } = resolveLarkCalendarWindow(trigger, this.now())
      const result = await readLarkCalendarObservation(this.larkCalendarReader!, {
        calendarId: trigger.calendarId, startTime, endTime,
        pageSize: trigger.pageSize, maxPages: trigger.maxPages, maxEvents: trigger.maxEvents,
        signal: controller.signal, beforeRequest: guard,
      })
      guard()
      return result
    } finally { clearInterval(timer) }
  }

  private async runNetworkGuard<T>(
    trigger: Extract<NormalizedTrigger, { kind: 'task-system' | 'calendar' | 'email' }>,
    purpose: 'task-system.observe' | 'calendar.observe' | 'email.observe',
    controller: AbortController,
    run: (token: string | undefined, signal: AbortSignal, guard: () => void) => Promise<T>,
  ): Promise<T> {
    const guard = () => {
      if (controller.signal.aborted) throw controller.signal.reason
      this.assertActive()
      if (trigger.observer !== undefined) this.observers.assertCurrent(trigger.id)
      const decision = this.policy.evaluate({
        subject: {
          kind: 'background',
          id: `event-triggers:${trigger.id}`,
          ...(trigger.observer ? { workspace: trigger.observer.workspace, principal: trigger.observer.principalId } : {}),
        },
        action: 'observe',
        resource: { kind: 'network', id: trigger.url },
        context: { initiator: 'background' },
      })
      if (decision.effect !== 'allow') {
        throw new EventTriggersError('policy-denied', `${trigger.kind} observation permission ended`)
      }
    }
    guard()
    const timer = setInterval(() => { try { guard() } catch (error) { controller.abort(error) } }, 25)
    timer.unref?.()
    try {
      if (trigger.credentialHandle !== undefined && trigger.credentialHandle !== '') {
        return await this.credentials!.withSecret(this.ctx, {
          handleId: trigger.credentialHandle,
          purpose,
          ttlMs: Math.max(1_000, Math.min(30_000, this.config.requestTimeoutMs)),
          idempotencyKey: `event-${trigger.kind}:${trigger.id}:${randomUUID()}`,
        }, async (token, leaseSignal) => {
          guard()
          const result = await run(token, AbortSignal.any([controller.signal, leaseSignal]), guard)
          guard()
          return result
        })
      }
      const result = await run(undefined, controller.signal, guard)
      guard()
      return result
    } finally {
      clearInterval(timer)
    }
  }

  private async readTaskSystemTriggerObservation(
    trigger: Extract<NormalizedTrigger, { kind: 'task-system' }>,
    controller: AbortController,
    trackOperation: OperationTracker,
    cursor?: Readonly<TriggerCursor>,
    hasBaseline = false,
  ): Promise<ExtendedObservation> {
    return this.runNetworkGuard(trigger, 'task-system.observe', controller, (token, signal, guard) =>
      readTaskSystemObservation({
        url: trigger.url,
        itemsPointer: trigger.itemsPointer,
        ...(trigger.fields === undefined ? {} : { fields: trigger.fields }),
        ...(trigger.statusFilter === undefined ? {} : { statusFilter: trigger.statusFilter }),
        ...(trigger.assigneeFilter === undefined ? {} : { assigneeFilter: trigger.assigneeFilter }),
        ...(trigger.since === undefined ? {} : { since: trigger.since }),
        maxItems: trigger.maxItems,
        ...(token === undefined ? {} : { token }),
        authScheme: trigger.authScheme,
        ...(cursor === undefined ? {} : { cursor }),
        hasBaseline,
        maxBodyBytes: this.config.maxBodyBytes,
        timeoutMs: this.config.requestTimeoutMs,
        allowedOrigins: new Set(this.config.allowedHttpOrigins),
        allowIpv6: this.config.ipv6Mode === 'native-only',
        lookup: this.lookup,
        ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }),
        trackOperation,
        signal,
        beforeRequest: guard,
      }),
    )
  }

  private async readCalendarTriggerObservation(
    trigger: Extract<NormalizedTrigger, { kind: 'calendar' }>,
    controller: AbortController,
    trackOperation: OperationTracker,
    cursor?: Readonly<TriggerCursor>,
    hasBaseline = false,
  ): Promise<ExtendedObservation> {
    return this.runNetworkGuard(trigger, 'calendar.observe', controller, (token, signal, guard) =>
      readCalendarObservation({
        url: trigger.url,
        format: trigger.format,
        ...(trigger.itemsPointer === undefined ? {} : { itemsPointer: trigger.itemsPointer }),
        ...(trigger.window === undefined ? {} : { window: trigger.window }),
        ...(trigger.windowParams === undefined ? {} : { windowParams: trigger.windowParams }),
        maxEvents: trigger.maxEvents,
        ...(token === undefined ? {} : { token }),
        ...(cursor === undefined ? {} : { cursor }),
        hasBaseline,
        now: this.now,
        maxBodyBytes: this.config.maxBodyBytes,
        timeoutMs: this.config.requestTimeoutMs,
        allowedOrigins: new Set(this.config.allowedHttpOrigins),
        allowIpv6: this.config.ipv6Mode === 'native-only',
        lookup: this.lookup,
        ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }),
        trackOperation,
        signal,
        beforeRequest: guard,
      }),
    )
  }

  private async readEmailTriggerObservation(
    trigger: Extract<NormalizedTrigger, { kind: 'email' }>,
    controller: AbortController,
    trackOperation: OperationTracker,
    cursor?: Readonly<TriggerCursor>,
    hasBaseline = false,
  ): Promise<ExtendedObservation> {
    return this.runNetworkGuard(trigger, 'email.observe', controller, (token, signal, guard) =>
      readEmailObservation({
        url: trigger.url,
        protocol: trigger.protocol,
        ...(trigger.accountId === undefined ? {} : { accountId: trigger.accountId }),
        ...(trigger.mailboxId === undefined ? {} : { mailboxId: trigger.mailboxId }),
        ...(trigger.messagesPointer === undefined ? {} : { messagesPointer: trigger.messagesPointer }),
        ...(trigger.fromFilter === undefined ? {} : { fromFilter: trigger.fromFilter }),
        ...(trigger.subjectContains === undefined ? {} : { subjectContains: trigger.subjectContains }),
        unreadOnly: trigger.unreadOnly,
        maxMessages: trigger.maxMessages,
        ...(token === undefined ? {} : { token }),
        ...(cursor === undefined ? {} : { cursor }),
        hasBaseline,
        maxBodyBytes: this.config.maxBodyBytes,
        timeoutMs: this.config.requestTimeoutMs,
        allowedOrigins: new Set(this.config.allowedHttpOrigins),
        allowIpv6: this.config.ipv6Mode === 'native-only',
        lookup: this.lookup,
        ...(this.fetcher === undefined ? {} : { fetcher: this.fetcher }),
        trackOperation,
        signal,
        beforeRequest: guard,
      }),
    )
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

  private startWebhookListener(listenConfig: NonNullable<NormalizedConfig['webhookListen']>): void {
    const basePath = listenConfig.basePath
    for (const trigger of this.config.triggers) {
      if (trigger.kind !== 'webhook' || !trigger.enabled) continue
      const route = trigger.path ?? `${basePath === '/' ? '' : basePath}/${trigger.id}`
      this.webhookRoutes.set(route, trigger)
    }
    const server = createServer((req, res) => {
      void this.track(this.handleWebhookHttpRequest(req, res))
    })
    server.maxConnections = Math.max(16, listenConfig.maxConcurrentRequests + 16)
    server.requestTimeout = this.config.requestTimeoutMs
    server.headersTimeout = Math.min(10_000, this.config.requestTimeoutMs)
    this.webhookServer = server

    this.webhookListenPromise = new Promise<WebhookListenAddress | undefined>((resolveListen, rejectListen) => {
      let settled = false
      const onShutdown = () => {
        if (settled) return
        settled = true
        server.removeListener('error', onError)
        server.removeListener('listening', onListening)
        try { server.close() } catch {}
        rejectListen(this.shutdown.signal.reason ?? new EventTriggersError('disposed', 'event-triggers service is disposed'))
      }
      const onError = (error: Error) => {
        if (settled) return
        settled = true
        this.shutdown.signal.removeEventListener('abort', onShutdown)
        server.removeListener('listening', onListening)
        try { server.close() } catch {}
        rejectListen(error)
      }
      const onListening = () => {
        if (settled) return
        settled = true
        this.shutdown.signal.removeEventListener('abort', onShutdown)
        server.removeListener('error', onError)
        if (!this.active || this.shutdown.signal.aborted) {
          try { server.close() } catch {}
          rejectListen(new EventTriggersError('disposed', 'event-triggers service is disposed'))
          return
        }
        const rawAddr = server.address()
        if (rawAddr === null || typeof rawAddr === 'string') {
          rejectListen(new Error('event-triggers: unexpected webhook server address'))
          return
        }
        const resolved = Object.freeze({
          host: rawAddr.address,
          port: rawAddr.port,
          basePath,
        })
        this.resolvedWebhookAddress = resolved
        resolveListen(resolved)
      }
      if (this.shutdown.signal.aborted) {
        onShutdown()
        return
      }
      this.shutdown.signal.addEventListener('abort', onShutdown, { once: true })
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(listenConfig.port, listenConfig.host)
    })
    void this.webhookListenPromise.catch(() => {})
  }

  private async closeWebhookListener(): Promise<void> {
    const server = this.webhookServer
    if (server === undefined) return
    await this.webhookListenPromise?.catch(() => {})
    if (!server.listening) return
    server.closeIdleConnections?.()
    const drainTimeoutMs = this.config.webhookListen?.drainTimeoutMs ?? 5_000
    await new Promise<void>((resolveClose) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        resolveClose()
      }
      server.close(() => done())
      timer = setTimeout(() => {
        timer = undefined
        server.closeAllConnections?.()
        done()
      }, drainTimeoutMs)
      timer.unref?.()
    })
  }

  private async handleWebhookHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sendJson = (
      status: number,
      body: Record<string, unknown>,
      extraHeaders?: Record<string, string>,
      onFlushed?: () => void,
    ) => {
      if (res.writableEnded || res.destroyed) {
        onFlushed?.()
        return
      }
      const payload = JSON.stringify(body)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': String(Buffer.byteLength(payload, 'utf8')),
        ...extraHeaders,
      })
      res.end(payload, onFlushed)
    }

    if (!this.active || this.shutdown.signal.aborted) {
      sendJson(503, { error: 'service-unavailable' })
      return
    }
    const maxConcurrent = this.config.webhookListen?.maxConcurrentRequests ?? 64
    if (this.activeWebhookRequests >= maxConcurrent) {
      sendJson(503, { error: 'overloaded' })
      return
    }
    this.activeWebhookRequests += 1
    try {
      const rawUrl = req.url ?? '/'
      if (!rawUrl.startsWith('/') || rawUrl.startsWith('//') || rawUrl.startsWith('/\\')) {
        sendJson(400, { error: 'invalid-url' })
        return
      }
      const queryIndex = rawUrl.indexOf('?')
      const hashIndex = rawUrl.indexOf('#')
      const pathEnd = queryIndex === -1
        ? (hashIndex === -1 ? rawUrl.length : hashIndex)
        : (hashIndex === -1 ? queryIndex : Math.min(queryIndex, hashIndex))
      const rawPath = rawUrl.slice(0, pathEnd)
      if (rawPath.includes('\\')) {
        sendJson(400, { error: 'invalid-url' })
        return
      }
      const hasDotSegment = rawPath.split('/').some((segment) => {
        if (segment === '.' || segment === '..') return true
        try {
          const decoded = decodeURIComponent(segment)
          return decoded === '.' || decoded === '..'
        } catch {
          return true
        }
      })
      if (hasDotSegment) {
        sendJson(400, { error: 'invalid-url' })
        return
      }
      let parsedUrl: URL
      try {
        parsedUrl = new URL(rawUrl, 'http://localhost')
      } catch {
        sendJson(400, { error: 'invalid-url' })
        return
      }
      if (parsedUrl.hostname !== 'localhost') {
        sendJson(400, { error: 'invalid-url' })
        return
      }
      let pathname = parsedUrl.pathname
      if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
      const trigger = this.webhookRoutes.get(pathname)
      if (trigger === undefined) {
        sendJson(404, { error: 'not-found' })
        return
      }
      if (req.method !== 'POST') {
        sendJson(405, { error: 'method-not-allowed' }, { allow: 'POST' })
        return
      }

      const rawHeaderValues = new Map<string, string[]>()
      for (let index = 0; index + 1 < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index]!.toLowerCase()
        const value = req.rawHeaders[index + 1]!
        const list = rawHeaderValues.get(name)
        if (list === undefined) rawHeaderValues.set(name, [value])
        else list.push(value)
      }

      const readSingleHeader = (name: string): { present: boolean; valid: boolean; value?: string } => {
        const lower = name.toLowerCase()
        const rawList = rawHeaderValues.get(lower)
        if (rawList !== undefined) {
          if (rawList.length > 1) return { present: true, valid: false }
          const trimmed = rawList[0]!.trim()
          if (trimmed.length === 0) return { present: false, valid: true }
          return { present: true, valid: true, value: trimmed }
        }
        const raw = req.headers[lower]
        if (raw === undefined) return { present: false, valid: true }
        if (Array.isArray(raw)) return { present: true, valid: false }
        const trimmed = raw.trim()
        if (trimmed.length === 0) return { present: false, valid: true }
        return { present: true, valid: true, value: trimmed }
      }

      const contentLengthHeader = readSingleHeader('content-length')
      if (!contentLengthHeader.valid) {
        sendJson(400, { error: 'malformed-headers' })
        return
      }
      if (contentLengthHeader.present) {
        const declared = Number(contentLengthHeader.value)
        if (!Number.isSafeInteger(declared) || declared < 0) {
          sendJson(400, { error: 'invalid-content-length' })
          return
        }
        if (declared > this.config.maxBodyBytes) {
          req.pause()
          sendJson(413, { error: 'payload-too-large' }, { connection: 'close' }, () => {
            if (!req.destroyed) req.destroy()
          })
          return
        }
      }

      const bodyResult = await this.readIncomingWebhookBody(req)
      if (!bodyResult.ok) {
        if (bodyResult.status === 413) {
          sendJson(413, { error: bodyResult.error }, { connection: 'close' }, () => {
            if (!req.destroyed) req.destroy()
          })
        } else {
          sendJson(bodyResult.status, { error: bodyResult.error })
        }
        return
      }

      const authMode: WebhookAuthMode = trigger.authMode ?? 'hmac-sha256'
      let accepted: { accepted: true; eventId: string }

      if (authMode === 'hmac-sha256') {
        const sigHeader = readSingleHeader('x-dsh-signature')
        const tsHeader = readSingleHeader('x-dsh-timestamp')
        const nonceHeader = readSingleHeader('x-dsh-nonce')
        if (!sigHeader.valid || !tsHeader.valid || !nonceHeader.valid) {
          sendJson(400, { error: 'malformed-headers' })
          return
        }
        if (!sigHeader.present) {
          sendJson(401, { error: 'invalid-signature' })
          return
        }
        if (!tsHeader.present || !nonceHeader.present) {
          sendJson(400, { error: 'missing-headers' })
          return
        }
        accepted = await this.performIngestWebhook(trigger.id, {
          timestamp: tsHeader.value!,
          nonce: nonceHeader.value!,
          signature: sigHeader.value!,
          body: bodyResult.body,
        })
      } else {
        const nonceHeader = readSingleHeader('x-dsh-nonce')
        const webhookIdHeader = readSingleHeader('x-webhook-id')
        const tsHeader = readSingleHeader('x-dsh-timestamp')
        let token: string | undefined
        if (authMode === 'bearer') {
          const authHeader = readSingleHeader('authorization')
          if (!authHeader.valid || !nonceHeader.valid || !webhookIdHeader.valid || !tsHeader.valid) {
            sendJson(400, { error: 'malformed-headers' })
            return
          }
          const match = authHeader.value !== undefined ? /^Bearer\s+(\S+)$/iu.exec(authHeader.value) : null
          if (!match) {
            sendJson(401, { error: 'invalid-signature' })
            return
          }
          token = match[1]!
        } else {
          const headerName = (trigger.secretHeader ?? 'x-dsh-secret').toLowerCase()
          const secretHeader = readSingleHeader(headerName)
          if (!secretHeader.valid || !nonceHeader.valid || !webhookIdHeader.valid || !tsHeader.valid) {
            sendJson(400, { error: 'malformed-headers' })
            return
          }
          if (!secretHeader.present) {
            sendJson(401, { error: 'invalid-signature' })
            return
          }
          token = secretHeader.value!
        }

        const nonce = nonceHeader.value ?? webhookIdHeader.value ?? randomUUID()
        if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(nonce)) {
          sendJson(400, { error: 'invalid-nonce' })
          return
        }
        const receivedAt = this.now()
        const timestamp = tsHeader.value !== undefined ? Number(tsHeader.value) : receivedAt
        if (!Number.isSafeInteger(timestamp) || timestamp < 0 || Math.abs(receivedAt - timestamp) > trigger.maxSkewMs) {
          sendJson(401, { error: 'timestamp' })
          return
        }
        accepted = await this.performIngestTokenWebhook(trigger, {
          token,
          nonce,
          timestamp,
          receivedAt,
          body: bodyResult.body,
        })
      }

      sendJson(202, { accepted: true, eventId: accepted.eventId })
    } catch (error) {
      if (error instanceof EventTriggersError) {
        const status = error.code === 'invalid-signature' || error.code === 'timestamp' ? 401
          : error.code === 'policy-denied' ? 403
          : error.code === 'not-found' ? 404
          : error.code === 'replay' || error.code === 'source-changed' ? 409
          : error.code === 'ttl' ? 410
          : error.code === 'cooldown' || error.code === 'limit' ? 429
          : 503
        sendJson(status, { error: error.code })
        return
      }
      if (isKeychainPolicyDeniedError(error)) {
        sendJson(403, { error: 'policy-denied' })
        return
      }
      sendJson(500, { error: 'internal-error' })
    } finally {
      this.activeWebhookRequests -= 1
    }
  }

  private readIncomingWebhookBody(req: IncomingMessage): Promise<
    | { ok: true; body: Buffer }
    | { ok: false; status: number; error: string }
  > {
    return new Promise((resolveBody) => {
      const chunks: Buffer[] = []
      let total = 0
      let finished = false
      const cleanup = () => {
        clearTimeout(timer)
        this.shutdown.signal.removeEventListener('abort', onAbort)
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        req.removeListener('aborted', onAborted)
      }
      const finish = (result: { ok: true; body: Buffer } | { ok: false; status: number; error: string }) => {
        if (finished) return
        finished = true
        cleanup()
        resolveBody(result)
      }
      const onAbort = () => {
        req.destroy()
        finish({ ok: false, status: 503, error: 'service-unavailable' })
      }
      const timer = setTimeout(() => {
        req.destroy()
        finish({ ok: false, status: 408, error: 'request-timeout' })
      }, this.config.requestTimeoutMs)
      timer.unref?.()

      const onData = (chunk: Buffer | string) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        total += buf.byteLength
        if (total > this.config.maxBodyBytes) {
          chunks.length = 0
          req.pause()
          finish({ ok: false, status: 413, error: 'payload-too-large' })
          return
        }
        chunks.push(buf)
      }
      const onEnd = () => finish({ ok: true, body: Buffer.concat(chunks, total) })
      const onError = () => finish({ ok: false, status: 400, error: 'bad-request' })
      const onAborted = () => finish({ ok: false, status: 400, error: 'request-aborted' })

      if (this.shutdown.signal.aborted) {
        onAbort()
        return
      }
      this.shutdown.signal.addEventListener('abort', onAbort, { once: true })
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('error', onError)
      req.once('aborted', onAborted)
    })
  }

  private async performIngestTokenWebhook(
    trigger: Extract<NormalizedTrigger, { kind: 'webhook' }>,
    input: { token: string; nonce: string; timestamp: number; receivedAt: number; body: Buffer },
  ): Promise<{ accepted: true; eventId: string }> {
    await this.credentials!.withSecret(this.ctx, {
      handleId: trigger.credentialHandle,
      purpose: 'verify-webhook',
      ttlMs: 10_000,
      idempotencyKey: `event-webhook-token:${trigger.id}:${randomUUID()}`,
    }, async (secret) => {
      const expected = sha256Digest(secret)
      const supplied = sha256Digest(input.token)
      if (!timingSafeEqual(supplied, expected)) {
        throw new EventTriggersError('invalid-signature', 'event-triggers: webhook credential is invalid')
      }
    })
    if (this.store.hasWebhookEvent(trigger.id, input.nonce)) {
      throw new EventTriggersError('replay', 'webhook nonce was already accepted')
    }
    const decision = this.policy.authorize({
      subject: { kind: 'external', id: `webhook:${trigger.id}` }, action: 'accept',
      resource: { kind: 'automation', id: trigger.automationId }, context: { initiator: 'external' },
    }, { idempotencyKey: `event-webhook:${trigger.id}:${input.nonce}` })
    if (decision.effect !== 'allow') throw new EventTriggersError('policy-denied', 'event-triggers policy denied webhook')
    if (trigger.observer !== undefined) {
      if (this.observers.isRetiredGoalSource(trigger.id)) {
        throw new EventTriggersError('source-changed', 'event-triggers: observer goal source is retired')
      }
      this.observers.assertCurrent(trigger.id)
    }
    const accepted = this.store.acceptWebhook({
      triggerId: trigger.id, eventId: input.nonce, occurredAt: input.timestamp, acceptedAt: input.receivedAt,
      cooldownMs: trigger.cooldownMs, maxFires: trigger.maxFires,
      ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
      envelope: (eventId, revision) => this.envelope({
        trigger, eventId, occurredAt: input.timestamp, receivedAt: input.receivedAt,
        fingerprint: createHash('sha256').update(input.body).digest('hex'),
        revision: revision.slice('webhook:'.length), timeBasis: 'source-signed', method: 'hmac-sha256',
      }),
    })
    if (!accepted.accepted) {
      throw new EventTriggersError(accepted.reason, `event-triggers: webhook event was rejected by ${accepted.reason}`)
    }
    this.emitIntakeForOutbox(trigger, [accepted.event])
    this.notifySourceChanges()
    await this.startFlush()
    return { accepted: true, eventId: accepted.event.eventId }
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
    if (input.timestamp.trim().length === 0 || !Number.isSafeInteger(timestamp) || timestamp < 0 || Math.abs(receivedAt - timestamp) > trigger.maxSkewMs) {
      throw new EventTriggersError('timestamp', 'event-triggers: webhook timestamp is outside the accepted window')
    }
    if (!/^[A-Za-z0-9._:-]{1,200}$/u.test(input.nonce)) throw new EventTriggersError('replay', 'invalid webhook nonce')
    if (!/^sha256=[a-f0-9]{64}$/u.test(input.signature)) {
      throw new EventTriggersError('invalid-signature', 'event-triggers: webhook signature is malformed')
    }
    await this.verifySignature(trigger, input)
    if (this.store.hasWebhookEvent(trigger.id, input.nonce)) throw new EventTriggersError('replay', 'webhook nonce was already accepted')
    const decision = this.policy.authorize({
      subject: { kind: 'external', id: `webhook:${trigger.id}` }, action: 'accept',
      resource: { kind: 'automation', id: trigger.automationId }, context: { initiator: 'external' },
    }, { idempotencyKey: `event-webhook:${trigger.id}:${input.nonce}` })
    if (decision.effect !== 'allow') throw new EventTriggersError('policy-denied', 'event-triggers policy denied webhook')
    if (trigger.observer !== undefined) {
      if (this.observers.isRetiredGoalSource(trigger.id)) {
        throw new EventTriggersError('source-changed', 'event-triggers: observer goal source is retired')
      }
      this.observers.assertCurrent(trigger.id)
    }
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
    this.emitIntakeForOutbox(trigger, [accepted.event])
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

  /**
   * Host-only paginated outbox reader scoped strictly to current owner-bound
   * triggers. Validates envelope provenance digests and projects sanitized
   * metadata only (never credentials, tokens, headers, or unredacted bodies).
   */
  inspectOwnerOutboxEvents = (input: InspectOwnerOutboxEventsInput): InspectOwnerOutboxEventsResult => {
    this.assertActive()
    if (!input || typeof input !== 'object' || !input.scope || typeof input.scope !== 'object') {
      throw new EventTriggerStoreError('invalid-input', 'owner outbox inspection requires a scope')
    }
    const { scope } = input
    if (
      typeof scope.principalId !== 'string' || scope.principalId.length === 0
      || typeof scope.principalRecordId !== 'string' || scope.principalRecordId.length === 0
      || !Number.isSafeInteger(scope.principalVersion) || scope.principalVersion < 1
      || typeof scope.workspace !== 'string' || !isAbsolute(scope.workspace)
      || typeof scope.preset !== 'string' || scope.preset.length === 0
    ) {
      throw new EventTriggerStoreError('invalid-input', 'owner outbox scope is invalid')
    }
    const afterSequence = input.afterSequence ?? 0
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new EventTriggerStoreError('invalid-input', 'afterSequence must be a non-negative safe integer')
    }
    const rawLimit = input.limit ?? 50
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1) {
      throw new EventTriggerStoreError('invalid-input', 'limit must be a positive safe integer')
    }
    const limit = Math.min(rawLimit, 200)
    const normalizedWorkspace = resolve(scope.workspace)

    const matchedTriggers = new Map<string, NormalizedTrigger>()
    for (const trigger of this.config.triggers) {
      const owner = trigger.observer
      if (
        !owner
        || !trigger.enabled
        || owner.principalId !== scope.principalId
        || owner.principalRecordId !== scope.principalRecordId
        || owner.principalVersion !== scope.principalVersion
        || resolve(owner.workspace) !== normalizedWorkspace
        || owner.preset !== scope.preset
      ) {
        continue
      }
      if (this.observers.isRetiredGoalSource(trigger.id)) continue
      try {
        this.observers.assertCurrent(trigger.id)
      } catch {
        continue
      }
      matchedTriggers.set(trigger.id, trigger)
    }

    if (matchedTriggers.size === 0) {
      return Object.freeze({ items: Object.freeze([]), nextSequence: afterSequence, hasMore: false })
    }

    const page = this.store.outboxRowsForTriggersAfter({
      triggerIds: [...matchedTriggers.keys()],
      afterSequence,
      limit,
    })

    let nextSequence = afterSequence
    const items: OwnerOutboxEventSummary[] = []
    for (const row of page.rows) {
      if (row.sequence > nextSequence) nextSequence = row.sequence
      const trigger = matchedTriggers.get(row.triggerId)
      if (trigger === undefined || row.canonical === null || row.digest === null) continue
      let envelope: ExternalEventEnvelope
      try {
        envelope = parseExternalEventEnvelope(JSON.parse(row.canonical))
      } catch {
        continue
      }
      if (
        externalEventDigest(envelope) !== row.digest
        || envelope.source.id !== `event-triggers:${trigger.id}`
        || envelope.source.kind !== envelopeSourceKind(trigger)
        || envelope.target.automationId !== trigger.automationId
        || envelope.event.id !== row.eventId
        || envelope.event.occurredAt !== row.occurredAt
      ) {
        continue
      }
      items.push(this.projectSanitizedOutboxEvent(trigger, row.sequence, row.digest, envelope))
    }

    return Object.freeze({
      items: Object.freeze(items),
      nextSequence,
      hasMore: page.hasMore,
    })
  }

  private projectSanitizedOutboxEvent(
    trigger: NormalizedTrigger,
    sequence: number,
    envelopeDigest: string,
    envelope: Readonly<ExternalEventEnvelope>,
  ): OwnerOutboxEventSummary {
    const summaryLabel = trigger.intake?.summaryLabel
    const summary = buildEventIntakeSummary({
      trigger,
      envelope,
      ...(summaryLabel === undefined ? {} : { summaryLabel }),
    })
    const title = summaryLabel ?? (
      trigger.kind === 'github-repository' ? `${trigger.kind}:${trigger.repository}`
        : trigger.kind === 'lark-calendar' ? `${trigger.kind}:${trigger.calendarId}`
          : (trigger.kind === 'http-json' || trigger.kind === 'task-system' || trigger.kind === 'calendar' || trigger.kind === 'email')
            ? `${trigger.kind}:${new URL(trigger.url).origin}`
            : `${trigger.kind}:${trigger.id}`
    )
    const entityCandidates = new Set<string>([trigger.id, trigger.kind, trigger.automationId])
    if (summaryLabel !== undefined) entityCandidates.add(summaryLabel)
    if (trigger.kind === 'github-repository') {
      entityCandidates.add(trigger.repository)
      entityCandidates.add(trigger.branch)
      entityCandidates.add(trigger.baseBranch)
    } else if (trigger.kind === 'lark-calendar') {
      entityCandidates.add(trigger.calendarId)
    } else if (trigger.kind === 'http-json' || trigger.kind === 'task-system' || trigger.kind === 'calendar' || trigger.kind === 'email') {
      entityCandidates.add(new URL(trigger.url).origin)
    }
    return Object.freeze({
      sequence,
      triggerId: trigger.id,
      triggerKind: trigger.kind,
      automationId: trigger.automationId,
      eventId: envelope.event.id,
      occurredAt: envelope.event.occurredAt,
      title,
      summary,
      envelopeDigest,
      observationDigest: envelope.observation.digest,
      ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
      entities: Object.freeze([...entityCandidates]),
    })
  }

  sourceSnapshot(triggerId: string): Readonly<EventSourceSnapshot> {
    this.assertActive()
    const trigger = this.sourceTrigger(triggerId)
    return Object.freeze({
      protocol: 'dsh-event-source/v1' as const,
      sourceId: `event-triggers:${trigger.id}`,
      kind: envelopeSourceKind(trigger),
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

  subscribeSourceChanges(listener: () => void, options?: { triggerId?: string; goalId?: string }): () => void {
    this.assertActive()
    if (options?.triggerId !== undefined && this.observers.isRetiredGoalSource(options.triggerId)) {
      return () => {}
    }
    this.sourceChangeListeners.add(listener)
    if (options !== undefined && (options.triggerId !== undefined || options.goalId !== undefined)) {
      this.scopedSourceListeners.set(listener, Object.freeze({
        ...(options.triggerId === undefined ? {} : { triggerId: options.triggerId }),
        ...(options.goalId === undefined ? {} : { goalId: options.goalId }),
      }))
    }
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.sourceChangeListeners.delete(listener)
      this.scopedSourceListeners.delete(listener)
    }
  }

  registerIntakeObserver = (observer: EventIntakeObserver): (() => void) => {
    this.assertActive()
    return this.intakeAdapter.registerObserver(observer)
  }

  registerUnsubscribeHook = (hook: GoalSourceUnsubscribeHook): (() => void) => {
    this.assertActive()
    return this.observers.registerUnsubscribeHook(hook)
  }

  unsubscribeGoalSources = (input: GoalSourceUnsubscribeInput): readonly string[] => {
    this.assertActive()
    return this.observers.unsubscribeGoalSources(input)
  }

  claimGoalSource = (input: GoalSourceClaim): boolean => this.observers.claimGoalSource(input)
  retireGoalSource = (input: GoalSourceClaim): boolean => this.observers.retireGoalSource(input)
  isRetiredGoalSource = (triggerId: string): boolean => {
    this.assertActive()
    return this.observers.isRetiredGoalSource(triggerId)
  }
  canSettleGoalSource = (input: GoalSourceClaim): boolean => {
    this.assertActive()
    const trigger = this.triggers.get(input.triggerId)
    return trigger !== undefined && trigger.enabled && this.observers.canSettleGoalSource(input)
  }

  private handleSourceDetached(event: Readonly<GoalSourceDetachEvent>): void {
    const pending = this.pendingObservations.get(event.triggerId)
    if (pending !== undefined) {
      pending.controller.abort(new EventTriggersError('source-changed', `event-triggers: source ${event.triggerId} detached (${event.reason})`))
    }
    for (const [listener, meta] of this.scopedSourceListeners.entries()) {
      const triggerMatch = meta.triggerId === undefined || meta.triggerId === event.triggerId
      const goalMatch = meta.goalId === undefined || (event.goalId !== undefined && meta.goalId === event.goalId)
      if (triggerMatch && goalMatch && (meta.triggerId !== undefined || meta.goalId !== undefined)) {
        this.scopedSourceListeners.delete(listener)
        this.sourceChangeListeners.delete(listener)
      }
    }
  }

  private emitIntakeForOutbox(trigger: NormalizedTrigger, items: readonly TriggerOutboxEvent[]): void {
    if (!this.active || trigger.intake?.enabled !== true || items.length === 0) return
    if (this.observers.isRetiredGoalSource(trigger.id)) return
    let receipt
    try {
      receipt = this.observers.attestedRouteReceipt(trigger.id)
    } catch {
      return
    }
    if (receipt === undefined) return
    for (const item of items) {
      if (item.envelope === undefined) continue
      try {
        const envelope = parseExternalEventEnvelope(JSON.parse(item.envelope.canonical))
        if (externalEventDigest(envelope) !== item.envelope.digest) continue
        const observation = buildEventIntakeObservation({
          trigger,
          receipt,
          sequence: item.sequence,
          envelope,
          envelopeDigest: item.envelope.digest,
        })
        this.intakeAdapter.emit(observation)
      } catch {
        // Best-effort intake adapter emission never breaks outbox/sensor flow.
      }
    }
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
    if (snapshot.kind !== envelopeSourceKind(trigger) || snapshot.version !== version
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
      idempotencyKey: `event-webhook-signature:${trigger.id}:${randomUUID()}`,
    }, async (secret) => {
      const expected = createHmac('sha256', secret).update(`${input.timestamp}\n${input.nonce}\n`).update(input.body).digest()
      const supplied = Buffer.from(input.signature.slice('sha256='.length), 'hex')
      if (supplied.byteLength !== expected.byteLength || !timingSafeEqual(supplied, expected)) {
        throw new EventTriggersError('invalid-signature', 'event-triggers: webhook signature is invalid')
      }
    })
  }

  private triggerConfigDigest(trigger: NormalizedTrigger): string {
    const {
      observerLifetime,
      deliveryMode,
      intake,
      path,
      authMode,
      secretHeader,
      startTime,
      endTime,
      lookbackSeconds,
      lookaheadSeconds,
      windowStepSeconds,
      ...legacy
    } = trigger as NormalizedTrigger & {
      deliveryMode?: 'commit' | 'pull-request'
      intake?: import('./config.js').NormalizedTriggerIntake
      path?: string
      authMode?: WebhookAuthMode
      secretHeader?: string
      startTime?: number
      endTime?: number
      lookbackSeconds?: number
      lookaheadSeconds?: number
      windowStepSeconds?: number
    }
    // Absent deliveryMode, default shared observerLifetime, omitted/disabled
    // intake, and absent/default webhook or rolling-window fields are excluded so
    // prior source claims and envelopes keep exact digests.
    const value = {
      ...legacy,
      ...(observerLifetime === 'shared' ? {} : { observerLifetime }),
      ...(deliveryMode === undefined ? {} : { deliveryMode }),
      ...(intake === undefined ? {} : { intake }),
      ...(trigger.kind === 'webhook'
        ? {
            ...(path === undefined ? {} : { path }),
            ...(authMode === undefined || authMode === 'hmac-sha256' ? {} : { authMode }),
            ...(secretHeader === undefined ? {} : { secretHeader }),
          }
        : trigger.kind === 'file'
          ? (path === undefined ? {} : { path })
          : {}),
      ...(startTime === undefined ? {} : { startTime }),
      ...(endTime === undefined ? {} : { endTime }),
      ...(lookbackSeconds === undefined ? {} : { lookbackSeconds }),
      ...(lookaheadSeconds === undefined ? {} : { lookaheadSeconds }),
      ...(windowStepSeconds === undefined ? {} : { windowStepSeconds }),
    }
    return createHash('sha256').update(stableJson(value)).digest('hex')
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
        kind: envelopeSourceKind(input.trigger),
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
