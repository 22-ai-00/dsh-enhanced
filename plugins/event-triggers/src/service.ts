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
  readFileObservation,
  readHttpJsonObservation,
  type Fetcher,
  type Lookup,
} from './sensors.js'
import { EventTriggerStore } from './store.js'

export type EventTriggersErrorCode =
  | 'disposed'
  | 'invalid-signature'
  | 'not-found'
  | 'policy-denied'
  | 'replay'
  | 'timestamp'

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
  private readonly fetcher: Fetcher
  private readonly lookup: Lookup
  private timer: ReturnType<typeof setInterval> | undefined
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
    this.fetcher = options.fetcher ?? fetch
    this.lookup = options.lookup ?? defaultLookup
    this.store = new EventTriggerStore({ path: this.config.databasePath, now: this.now })
    if (this.config.pollerEnabled) {
      this.timer = setInterval(() => void this.pollOnce().catch(() => {}), this.config.pollIntervalMs)
      this.timer.unref?.()
      void this.pollOnce().catch(() => {})
    } else {
      void this.flushPending().catch(() => {})
    }
    ctx.effect(() => () => {
      this.active = false
      if (this.timer !== undefined) clearInterval(this.timer)
      this.store.close()
    }, 'event-triggers.runtime')
  }

  async pollOnce(): Promise<void> {
    this.assertActive()
    for (const trigger of this.config.triggers) {
      if (!trigger.enabled || trigger.kind === 'webhook') continue
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
      const observation = trigger.kind === 'file'
        ? await readFileObservation({ path: trigger.path, roots: this.config.allowedFileRoots,
            mode: trigger.mode, maxBytes: this.config.maxBodyBytes })
        : await readHttpJsonObservation({ url: trigger.url, pointer: trigger.pointer,
            maxBodyBytes: this.config.maxBodyBytes, timeoutMs: this.config.requestTimeoutMs,
            allowedHosts: new Set(this.config.allowedHttpHosts), fetcher: this.fetcher, lookup: this.lookup })
      const occurredAt = this.now()
      this.store.observe({
        triggerId: trigger.id, ...observation, occurredAt, fireWhen: trigger.fireWhen,
        debounceMs: trigger.debounceMs, cooldownMs: trigger.cooldownMs,
        maxFires: trigger.maxFires, ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
      })
    }
    await this.flushPending()
  }

  async flushPending(): Promise<void> {
    this.assertActive()
    for (const item of this.store.pending()) {
      const trigger = this.triggers.get(item.triggerId)
      if (trigger === undefined || !trigger.enabled) continue
      this.store.markAttempt(item.id)
      this.automations.ingestExternal({
        sourceId: `event-triggers:${trigger.id}`,
        automationId: trigger.automationId,
        eventId: item.eventId,
        occurredAt: item.occurredAt,
      })
      this.store.markDelivered(item.id)
    }
  }

  async ingestWebhook(triggerId: string, input: {
    timestamp: string
    nonce: string
    signature: string
    body: Buffer
  }): Promise<{ accepted: true; eventId: string }> {
    this.assertActive()
    const trigger = this.triggers.get(triggerId)
    if (trigger?.kind !== 'webhook' || !trigger.enabled) throw new EventTriggersError('not-found', 'webhook trigger was not found')
    if (input.body.byteLength > this.config.maxBodyBytes) throw new Error('event-triggers: webhook body exceeds limit')
    const timestamp = Number(input.timestamp)
    if (!Number.isSafeInteger(timestamp) || Math.abs(this.now() - timestamp) > trigger.maxSkewMs) {
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
      triggerId: trigger.id, eventId: input.nonce, occurredAt: timestamp, maxFires: trigger.maxFires,
      ...(trigger.ttlMs === undefined ? {} : { ttlMs: trigger.ttlMs }),
    })
    if (!accepted.accepted || accepted.event === undefined) throw new EventTriggersError('replay', 'webhook event was not accepted')
    await this.flushPending()
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
}

export { ConfigSchema as Config }
