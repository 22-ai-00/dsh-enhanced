import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ExternalEventEnvelope } from '@dsh-enhanced/assistant-automations/external-event'
import type { OwnerRouteValidationReceipt } from '@dsh-enhanced/assistant-delivery'
import type { NormalizedTrigger } from './config.js'

export const EVENT_TRIGGERS_INTAKE_SOURCE = 'event-triggers' as const
export const MAX_EVENT_INTAKE_EVENT_ID_BYTES = 256
export const MAX_EVENT_INTAKE_SUMMARY_BYTES = 280
export const MAX_EVENT_INTAKE_SOURCE_TEXT = 65_536
const MAX_EVENT_INTAKE_OBSERVERS = 16
const MAX_DEDUPED_INTAKE_KEYS = 4_096
const SHA256_HEX = /^[0-9a-f]{64}$/u

export interface EventIntakeConversation {
  readonly kind: 'event-source'
  readonly chat: string
  readonly workspace: string
  readonly preset: string
}

/**
 * Normalized, metadata/digest-bounded intake observation emitted by opted-in
 * `EventSourceObservers` triggers. Secrets, credentials and unverified raw
 * response bodies never enter this payload.
 */
export interface EventIntakeObservation {
  readonly source: typeof EVENT_TRIGGERS_INTAKE_SOURCE
  readonly sourceEventId: string
  readonly kind: 'event'
  readonly triggerId: string
  readonly triggerKind: NormalizedTrigger['kind']
  readonly automationId: string
  readonly sequence: number
  readonly sender: string
  readonly conversation: Readonly<EventIntakeConversation>
  readonly senderIsBot: boolean
  readonly explicitlyAddressed: boolean
  readonly inThreadWithDeliveredReport: boolean
  readonly allowlistedSender: boolean
  readonly allowlistedFollowUp: boolean
  readonly subscribed: boolean
  readonly observationDigest: string
  readonly envelopeDigest: string
  readonly summary: string
  readonly occurredAt: number
  /** Present only when an authenticated text hashes to `observationDigest`. */
  readonly text?: string
}

export interface EventIntakeObserver {
  readonly protocol: 1
  readonly observe: (observation: Readonly<EventIntakeObservation>) => void
}

/**
 * Exact closed `WorkItemIntakeInput` structural projection accepted by
 * `@dsh-enhanced/assistant-work-items`'s `recordIntake(input, sourceText?)`.
 */
export interface WorkItemIntakeRecordInput {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'event'
  readonly senderAllowlisted: boolean
  readonly addressed: boolean
  readonly threadFollowUp: boolean
  readonly senderIsBot: boolean
  readonly subscribed: boolean
  readonly contentDigest: string
  readonly occurredAt: number
}

export interface WorkItemsIntakePort {
  recordIntake?(input: WorkItemIntakeRecordInput, sourceText?: string): unknown
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function stripControls(value: string): string {
  return [...value.normalize('NFC')]
    .map(char => {
      const code = char.codePointAt(0)!
      return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029 ? ' ' : char
    })
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
}

function boundUtf8(value: string, maxBytes: number): string {
  const clean = stripControls(value)
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean
  let output = ''
  let bytes = 0
  for (const char of clean) {
    const charBytes = Buffer.byteLength(char, 'utf8')
    if (bytes + charBytes > maxBytes) break
    output += char
    bytes += charBytes
  }
  return output.trim()
}

function authenticatesText(text: unknown, digest: string): text is string {
  return typeof text === 'string'
    && text.length > 0
    && text.length <= MAX_EVENT_INTAKE_SOURCE_TEXT
    && text.isWellFormed()
    && !text.includes('\u0000')
    && sha256Hex(text) === digest
}

/**
 * Deterministic source-local event id within `assistant-work-items`'s 256-byte
 * `sourceEventId` cap without control characters.
 */
export function boundEventIntakeId(triggerId: string, eventId: string): string {
  const cleanTrigger = stripControls(triggerId)
  const cleanEvent = stripControls(eventId)
  if (cleanTrigger.length === 0 || cleanEvent.length === 0) {
    throw new Error('event-triggers: intake triggerId and eventId must be non-empty')
  }
  const direct = `${cleanTrigger}/${cleanEvent}`
  if (Buffer.byteLength(direct, 'utf8') <= MAX_EVENT_INTAKE_EVENT_ID_BYTES) return direct
  const hash = sha256Hex(`${cleanTrigger}\0${cleanEvent}`)
  const bounded = `${boundUtf8(cleanTrigger, 120)}~${hash.slice(0, 16)}/${boundUtf8(cleanEvent, 110)}`
  return Buffer.byteLength(bounded, 'utf8') <= MAX_EVENT_INTAKE_EVENT_ID_BYTES
    ? bounded
    : `event/${hash}`
}

/** Metadata-only summary for one event observation; omits secrets and raw bodies. */
export function buildEventIntakeSummary(input: {
  trigger: NormalizedTrigger
  envelope: Readonly<ExternalEventEnvelope>
  summaryLabel?: string
}): string {
  const { trigger, envelope } = input
  const parts: string[] = [`${trigger.kind}:${trigger.id}`]
  if (input.summaryLabel !== undefined) parts.push(`label=${input.summaryLabel}`)
  if (trigger.kind === 'github-repository') {
    parts.push(`repo=${trigger.repository}`, `branch=${trigger.branch}`, `mode=${trigger.deliveryMode ?? 'pull-request'}`)
  } else if (trigger.kind === 'lark-calendar') {
    parts.push(`calendar=${trigger.calendarId}`, `window=${trigger.startTime}..${trigger.endTime}`)
  } else if (trigger.kind === 'http-json') {
    parts.push(`origin=${new URL(trigger.url).origin}`)
  } else if (trigger.kind === 'file') {
    parts.push(`mode=${trigger.mode}`)
  } else {
    parts.push('method=hmac-sha256')
  }
  parts.push(`rev=${envelope.observation.revision}`, `digest=${envelope.observation.digest.slice(0, 12)}`)
  return boundUtf8(parts.join(' '), MAX_EVENT_INTAKE_SUMMARY_BYTES)
}

/** Builds a frozen, metadata/digest-bounded intake observation from one attested event. */
export function buildEventIntakeObservation(input: {
  trigger: NormalizedTrigger
  receipt: Readonly<OwnerRouteValidationReceipt>
  sequence: number
  envelope: Readonly<ExternalEventEnvelope>
  envelopeDigest: string
  allowlistedSender?: boolean
  explicitlyAddressed?: boolean
  inThreadWithDeliveredReport?: boolean
  senderIsBot?: boolean
  subscribed?: boolean
  text?: string
}): Readonly<EventIntakeObservation> {
  const { trigger, receipt, envelope } = input
  const observationDigest = envelope.observation.digest
  if (!SHA256_HEX.test(observationDigest) || !SHA256_HEX.test(input.envelopeDigest)) {
    throw new Error('event-triggers: intake observation requires valid SHA-256 digests')
  }
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) {
    throw new Error('event-triggers: intake observation requires a positive event sequence')
  }
  if (!Number.isSafeInteger(envelope.event.occurredAt) || envelope.event.occurredAt < 0) {
    throw new Error('event-triggers: intake observation requires a valid occurredAt timestamp')
  }
  const allowlistedSender = input.allowlistedSender ?? true
  const inThreadWithDeliveredReport = input.inThreadWithDeliveredReport ?? false
  const allowlistedFollowUp = allowlistedSender && inThreadWithDeliveredReport
  const verifiedText = authenticatesText(input.text, observationDigest) ? input.text : undefined
  const summaryLabel = trigger.intake?.summaryLabel
  return Object.freeze({
    source: EVENT_TRIGGERS_INTAKE_SOURCE,
    sourceEventId: boundEventIntakeId(trigger.id, envelope.event.id),
    kind: 'event' as const,
    triggerId: trigger.id,
    triggerKind: trigger.kind,
    automationId: trigger.automationId,
    sequence: input.sequence,
    sender: receipt.principalId,
    conversation: Object.freeze({
      kind: 'event-source' as const,
      chat: trigger.id,
      workspace: resolve(receipt.workspace),
      preset: receipt.agentPreset,
    }),
    senderIsBot: input.senderIsBot ?? false,
    explicitlyAddressed: input.explicitlyAddressed ?? false,
    inThreadWithDeliveredReport,
    allowlistedSender,
    allowlistedFollowUp,
    subscribed: input.subscribed ?? trigger.intake?.subscribed ?? true,
    observationDigest,
    envelopeDigest: input.envelopeDigest,
    summary: buildEventIntakeSummary({ trigger, envelope, ...(summaryLabel === undefined ? {} : { summaryLabel }) }),
    occurredAt: envelope.event.occurredAt,
    ...(verifiedText === undefined ? {} : { text: verifiedText }),
  })
}

/** Projects a normalized observation to `assistant-work-items`'s closed `WorkItemIntakeInput` keys. */
export function toWorkItemIntakeInput(observation: Readonly<EventIntakeObservation>): Readonly<WorkItemIntakeRecordInput> {
  return Object.freeze({
    source: observation.source,
    sourceEventId: observation.sourceEventId,
    kind: 'event' as const,
    senderAllowlisted: observation.allowlistedSender,
    addressed: observation.explicitlyAddressed,
    threadFollowUp: observation.allowlistedFollowUp,
    senderIsBot: observation.senderIsBot,
    subscribed: observation.subscribed,
    contentDigest: observation.observationDigest,
    occurredAt: observation.occurredAt,
  })
}

/**
 * Deduplicated, best-effort emission bridge from opted-in `event-triggers`
 * observers to `assistantWorkItems.recordIntake(...)` and Host observers.
 */
export class EventIntakeAdapter {
  private readonly observers = new Set<EventIntakeObserver>()
  private readonly emittedKeys = new Set<string>()
  private active = true

  constructor(private readonly ctx: Context, initialObserver?: EventIntakeObserver) {
    if (initialObserver !== undefined) this.registerObserver(initialObserver)
  }

  registerObserver(observer: EventIntakeObserver): () => void {
    if (!this.active) throw new Error('event-triggers: intake adapter is disposed')
    if (!observer || typeof observer !== 'object' || observer.protocol !== 1 || typeof observer.observe !== 'function') {
      throw new Error('event-triggers: invalid event intake observer')
    }
    if (this.observers.size >= MAX_EVENT_INTAKE_OBSERVERS && !this.observers.has(observer)) {
      throw new Error('event-triggers: maximum intake observers registered')
    }
    this.observers.add(observer)
    let live = true
    return () => {
      if (!live) return
      live = false
      this.observers.delete(observer)
    }
  }

  emit(observation: Readonly<EventIntakeObservation>): boolean {
    if (!this.active) return false
    const key = `${observation.source}\0${observation.sourceEventId}`
    if (this.emittedKeys.has(key)) return false
    this.emittedKeys.add(key)
    while (this.emittedKeys.size > MAX_DEDUPED_INTAKE_KEYS) {
      const oldest = this.emittedKeys.values().next().value
      if (oldest === undefined) break
      this.emittedKeys.delete(oldest)
    }
    for (const observer of Array.from(this.observers)) {
      try {
        observer.observe(observation)
      } catch {
        // Intake observation is best-effort and never breaks sensor admission.
      }
    }
    try {
      const workItems = this.ctx.get('assistantWorkItems' as never, false) as WorkItemsIntakePort | undefined
      if (typeof workItems?.recordIntake === 'function') {
        const input = toWorkItemIntakeInput(observation)
        const sourceText = observation.text !== undefined && authenticatesText(observation.text, observation.observationDigest)
          ? observation.text
          : undefined
        if (sourceText === undefined) workItems.recordIntake(input)
        else workItems.recordIntake(input, sourceText)
      }
    } catch (error) {
      this.ctx.logger?.debug?.(`event-triggers: intake observation dropped: ${String(error)}`)
    }
    return true
  }

  dispose(): void {
    this.active = false
    this.observers.clear()
    this.emittedKeys.clear()
  }
}
