import { createHash } from 'node:crypto'
import { proactiveAttentionCohort } from './attention-tuning.js'
import type { ProactiveIntakeEvaluationHealth } from './intake-evaluation.js'

const SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const MAX_EVENT_ID_BYTES = 256
const MAX_SUMMARY_BYTES = 280
const MAX_SOURCE_TEXT_UNITS = 65_536

function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export type ProactiveIntakeStrength = 'explicit' | 'inferred' | 'ignore'
export type ProactiveIntakeStrengthReason =
  | 'allowlisted-addressed'
  | 'thread-follow-up'
  | 'allowlisted-unaddressed'
  | 'bot-capped'
  | 'not-allowlisted'
  | 'follow-up-not-allowlisted'

export type ProactiveIntakeDisposition =
  | 'filtered'
  | 'admit-explicit'
  | 'evaluate-inferred'
  | 'observe-only'

/**
 * Accepts either normalized EventTriggers/Delivery intake observations
 * (`allowlistedSender`, `explicitlyAddressed`, `inThreadWithDeliveredReport`,
 * `allowlistedFollowUp`, `observationDigest`, `summary`, `text?`) or
 * `WorkItemIntakeInput` (`senderAllowlisted`, `addressed`, `threadFollowUp`,
 * `contentDigest`).
 */
export interface ProactiveIntakeObservationInput {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'message' | 'event'
  readonly sender?: string
  readonly conversation?: Readonly<Record<string, unknown>>
  readonly senderIsBot: boolean
  readonly explicitlyAddressed?: boolean
  readonly addressed?: boolean
  readonly inThreadWithDeliveredReport?: boolean
  readonly threadFollowUp?: boolean
  readonly allowlistedSender?: boolean
  readonly senderAllowlisted?: boolean
  readonly allowlistedFollowUp?: boolean
  readonly groupMessage?: boolean
  readonly subscribed?: boolean
  readonly observationDigest?: string
  readonly contentDigest?: string
  readonly summary?: string
  readonly occurredAt: number
  readonly text?: string
  readonly sourceText?: string
}

export interface NormalizedProactiveIntakeObservation {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'message' | 'event'
  readonly senderIsBot: boolean
  readonly explicitlyAddressed: boolean
  readonly inThreadWithDeliveredReport: boolean
  readonly allowlistedSender: boolean
  readonly allowlistedFollowUp: boolean
  readonly rawThreadFollowUp: boolean
  readonly groupMessage: boolean
  readonly subscribed: boolean
  readonly observationDigest: string | null
  readonly summary?: string
  readonly occurredAt: number
  readonly verifiedText?: string
}

/** Closed `WorkItemIntakeInput` payload accepted by `assistantWorkItems.recordIntake`. */
export interface ProactiveWorkItemIntakePayload {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'message' | 'event'
  readonly senderAllowlisted: boolean
  readonly addressed: boolean
  readonly threadFollowUp: boolean
  readonly senderIsBot: boolean
  readonly groupMessage?: boolean
  readonly subscribed?: boolean
  readonly contentDigest?: string
  readonly occurredAt: number
}

export interface ProactiveIntakeRoutingOptions {
  readonly sourcePolicy?: Readonly<{ unaddressedGroupMessages?: boolean; unsubscribedEvents?: boolean }>
  readonly evaluationHealth?: Pick<ProactiveIntakeEvaluationHealth, 'enabled' | 'registered' | 'policyVersion'>
}

export interface ProactiveIntakeRoutePlan {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: 'message' | 'event'
  readonly strength: ProactiveIntakeStrength
  readonly strengthReason: ProactiveIntakeStrengthReason
  readonly disposition: ProactiveIntakeDisposition
  readonly reason: string
  readonly requiresModelEvaluation: boolean
  readonly hasVerifiedText: boolean
  readonly evaluationPolicyVersion: string | null
  readonly attentionCohort: Readonly<{ lane: string; sourceId: string }>
  readonly workItemInput: Readonly<ProactiveWorkItemIntakePayload>
}

function booleanField(value: unknown, fallback: boolean | undefined, field: string): boolean {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`assistant-proactive: intake ${field} must be a boolean`)
  return value
}

/** Validates and normalizes either rich intake observations or `WorkItemIntakeInput`. */
export function normalizeProactiveIntakeRouteInput(raw: ProactiveIntakeObservationInput): Readonly<NormalizedProactiveIntakeObservation> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('assistant-proactive: intake observation must be an object')
  }
  if (typeof raw.source !== 'string' || !SOURCE_ID.test(raw.source)) {
    throw new Error('assistant-proactive: intake source has an invalid shape')
  }
  if (typeof raw.sourceEventId !== 'string' || raw.sourceEventId.length === 0
    || raw.sourceEventId.trim() !== raw.sourceEventId || hasControl(raw.sourceEventId)
    || Buffer.byteLength(raw.sourceEventId, 'utf8') > MAX_EVENT_ID_BYTES) {
    throw new Error('assistant-proactive: intake sourceEventId is invalid')
  }
  if (raw.kind !== 'message' && raw.kind !== 'event') {
    throw new Error("assistant-proactive: intake kind must be 'message' or 'event'")
  }
  if (raw.kind === 'message' && raw.subscribed !== undefined) {
    throw new Error('assistant-proactive: intake subscribed applies to events only')
  }
  if (raw.kind === 'event' && raw.groupMessage !== undefined) {
    throw new Error('assistant-proactive: intake groupMessage applies to messages only')
  }
  if (!Number.isSafeInteger(raw.occurredAt) || raw.occurredAt < 0) {
    throw new Error('assistant-proactive: intake occurredAt must be a non-negative integer')
  }
  const allowlistedSender = booleanField(raw.allowlistedSender ?? raw.senderAllowlisted, undefined, 'allowlistedSender')
  const explicitlyAddressed = booleanField(raw.explicitlyAddressed ?? raw.addressed, undefined, 'explicitlyAddressed')
  const senderIsBot = booleanField(raw.senderIsBot, undefined, 'senderIsBot')
  const inThreadWithDeliveredReport = booleanField(raw.inThreadWithDeliveredReport, false, 'inThreadWithDeliveredReport')
  const rawThreadFollowUp = booleanField(raw.allowlistedFollowUp ?? raw.threadFollowUp, inThreadWithDeliveredReport, 'threadFollowUp')
  const allowlistedFollowUp = allowlistedSender && rawThreadFollowUp
  const groupMessage = booleanField(raw.groupMessage, false, 'groupMessage')
  const subscribed = booleanField(raw.subscribed, true, 'subscribed')

  const rawDigest = raw.observationDigest ?? raw.contentDigest
  if (rawDigest !== undefined && (typeof rawDigest !== 'string' || !SHA256_HEX.test(rawDigest))) {
    throw new Error('assistant-proactive: intake observationDigest must be a lowercase SHA-256 hex digest')
  }
  const observationDigest = rawDigest ?? null

  let summary: string | undefined
  if (raw.summary !== undefined) {
    if (typeof raw.summary !== 'string' || hasControl(raw.summary) || Buffer.byteLength(raw.summary, 'utf8') > MAX_SUMMARY_BYTES) {
      throw new Error('assistant-proactive: intake summary exceeds metadata bounds')
    }
    summary = raw.summary
  }

  const candidateText = raw.text ?? raw.sourceText
  const verifiedText = typeof candidateText === 'string'
    && candidateText.length > 0
    && candidateText.length <= MAX_SOURCE_TEXT_UNITS
    && candidateText.isWellFormed()
    && !candidateText.includes('\u0000')
    && observationDigest !== null
    && sha256Hex(candidateText) === observationDigest
    ? candidateText
    : undefined

  return Object.freeze({
    source: raw.source,
    sourceEventId: raw.sourceEventId,
    kind: raw.kind,
    senderIsBot,
    explicitlyAddressed,
    inThreadWithDeliveredReport,
    allowlistedSender,
    allowlistedFollowUp,
    rawThreadFollowUp,
    groupMessage,
    subscribed,
    observationDigest,
    ...(summary === undefined ? {} : { summary }),
    occurredAt: raw.occurredAt,
    ...(verifiedText === undefined ? {} : { verifiedText }),
  })
}

/** Projects a normalized observation into the closed `WorkItemIntakeInput` keys. */
export function toWorkItemIntakePayload(normalized: Readonly<NormalizedProactiveIntakeObservation>): Readonly<ProactiveWorkItemIntakePayload> {
  return Object.freeze({
    source: normalized.source,
    sourceEventId: normalized.sourceEventId,
    kind: normalized.kind,
    senderAllowlisted: normalized.allowlistedSender,
    addressed: normalized.explicitlyAddressed,
    threadFollowUp: normalized.allowlistedFollowUp,
    senderIsBot: normalized.senderIsBot,
    ...(normalized.kind === 'message' ? { groupMessage: normalized.groupMessage } : { subscribed: normalized.subscribed }),
    ...(normalized.observationDigest === null ? {} : { contentDigest: normalized.observationDigest }),
    occurredAt: normalized.occurredAt,
  })
}

/**
 * Pure deterministic WP20/WP12 intake routing helper. Never mutates ledgers,
 * never calls a model, and never grants execution authority.
 */
export function planProactiveIntakeRoute(
  input: ProactiveIntakeObservationInput,
  options: ProactiveIntakeRoutingOptions = {},
): Readonly<ProactiveIntakeRoutePlan> {
  const normalized = normalizeProactiveIntakeRouteInput(input)
  let strength: ProactiveIntakeStrength
  let strengthReason: ProactiveIntakeStrengthReason
  if (normalized.allowlistedSender && normalized.explicitlyAddressed) {
    [strength, strengthReason] = ['explicit', 'allowlisted-addressed']
  } else if (normalized.allowlistedSender && normalized.allowlistedFollowUp) {
    [strength, strengthReason] = ['explicit', 'thread-follow-up']
  } else if (normalized.allowlistedSender) {
    [strength, strengthReason] = ['inferred', 'allowlisted-unaddressed']
  } else if (normalized.rawThreadFollowUp || normalized.inThreadWithDeliveredReport) {
    [strength, strengthReason] = ['ignore', 'follow-up-not-allowlisted']
  } else {
    [strength, strengthReason] = ['ignore', 'not-allowlisted']
  }
  if (normalized.senderIsBot && strength === 'explicit') {
    [strength, strengthReason] = ['inferred', 'bot-capped']
  }

  const directed = normalized.explicitlyAddressed || normalized.allowlistedFollowUp
  const allowUnaddressedGroup = options.sourcePolicy?.unaddressedGroupMessages === true
  const allowUnsubscribedEvents = options.sourcePolicy?.unsubscribedEvents === true

  let disposition: ProactiveIntakeDisposition
  let reason: string
  let requiresModelEvaluation = false

  if (normalized.kind === 'message' && normalized.groupMessage && !directed && !allowUnaddressedGroup) {
    disposition = 'filtered'
    reason = 'unaddressed-group-disabled'
  } else if (normalized.kind === 'event' && !normalized.subscribed && !allowUnsubscribedEvents) {
    disposition = 'filtered'
    reason = 'unsubscribed-event-disabled'
  } else if (strength === 'ignore') {
    disposition = 'filtered'
    reason = 'strength-ignore'
  } else if (strength === 'explicit') {
    disposition = 'admit-explicit'
    reason = 'explicit-owner-signal'
  } else if (options.evaluationHealth?.enabled === true
    && options.evaluationHealth.registered === true
    && normalized.verifiedText !== undefined) {
    disposition = 'evaluate-inferred'
    reason = 'inferred-evaluator-ready'
    requiresModelEvaluation = true
  } else {
    disposition = 'observe-only'
    reason = options.evaluationHealth?.enabled === true
      ? 'inferred-awaiting-text-or-evaluator'
      : 'inferred-observe-only'
  }

  return Object.freeze({
    source: normalized.source,
    sourceEventId: normalized.sourceEventId,
    kind: normalized.kind,
    strength,
    strengthReason,
    disposition,
    reason,
    requiresModelEvaluation,
    hasVerifiedText: normalized.verifiedText !== undefined,
    evaluationPolicyVersion: options.evaluationHealth?.policyVersion ?? null,
    attentionCohort: proactiveAttentionCohort,
    workItemInput: toWorkItemIntakePayload(normalized),
  })
}
