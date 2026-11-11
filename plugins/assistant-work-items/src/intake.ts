import { createHash } from 'node:crypto'
import type { WorkItemErrorCode } from './types.ts'
import { WorkItemError } from './types.ts'

/**
 * Deterministic intake ledger (WP20 slice 1).
 *
 * One durable row per `(source, sourceEventId)` records what the Host decided
 * about an inbound item, from normalized metadata only. Nothing here reads a
 * message body, calls a model, admits a work item or dispatches anything: the
 * row is audit evidence that a later, evaluated slice can build on.
 */

export type WorkItemIntakeKind = 'message' | 'event'
export type WorkItemIntakeDecision = 'stored' | 'duplicate' | 'filtered'
export type WorkItemIntakeStrength = 'explicit' | 'inferred' | 'ignore'
export type WorkItemIntakeStrengthReason =
  | 'allowlisted-addressed'
  | 'thread-follow-up'
  | 'allowlisted-unaddressed'
  | 'bot-capped'
  | 'not-allowlisted'
  | 'follow-up-not-allowlisted'
export type WorkItemIntakeReason =
  | 'strength-explicit'
  | 'strength-inferred'
  | 'strength-ignore'
  | 'duplicate-content'
  | 'unaddressed-group-disabled'
  | 'unsubscribed-event-disabled'

/**
 * Optional acceptance reference supplied by the intake producer for one
 * inferred candidate. It is a handle only, never a contract body or verdict;
 * `admitDecision` re-reads the contract from the verifier before creating work.
 */
export interface WorkItemIntakeAcceptance {
  readonly contractId: string
  readonly contractDigest: string
}

/** Authenticated objective text for one inferred candidate; bounded and digest-bound. */
export interface WorkItemIntakeObjective {
  readonly text: string
  readonly digest: string
}

/**
 * Host-normalized metadata for one inbound item.
 *
 * The field list is closed: any other key (for example `text` or `body`) is
 * rejected, so a caller cannot hand message content to the ledger by mistake.
 * `contentDigest` is an optional SHA-256 hex digest the Host computed over the
 * content it already holds; it is the only content-derived value accepted.
 * `objective`/`objectiveDigest` and `acceptance` are optional producer
 * extensions for the inferred auto-admission path; they are validated here,
 * never copied into the intake ledger, and only the bounded in-memory hint
 * carries them to admission.
 */
export interface WorkItemIntakeInput {
  /** Host-registered inbound source, e.g. `lark-channel`. */
  readonly source: string
  /** Stable source-local event id; the replay key together with `source`. */
  readonly sourceEventId: string
  readonly kind: WorkItemIntakeKind
  readonly senderAllowlisted: boolean
  /** The item addresses the assistant (mention, direct message, command). */
  readonly addressed: boolean
  /**
   * The item follows up on a thread the ledger already tracks as work. Only an
   * allowlisted sender's follow-up is explicit; any other follow-up is ignored.
   */
  readonly threadFollowUp: boolean
  readonly senderIsBot: boolean
  /** Messages only: posted in a group conversation. Defaults to `false`. */
  readonly groupMessage?: boolean
  /** Events only: the owner subscribed to this event type. Defaults to `true`. */
  readonly subscribed?: boolean
  readonly contentDigest?: string
  readonly occurredAt: number
  /** Original objective text; requires `objectiveDigest` and an equal `contentDigest`. */
  readonly objective?: string
  /** SHA-256 hex of `objective`; must equal `contentDigest`. */
  readonly objectiveDigest?: string
  /** Optional verifier contract handle the producer prepared for this candidate. */
  readonly acceptance?: WorkItemIntakeAcceptance
}

/** Per-source owner opt-ins; every flag defaults to off. */
export interface WorkItemIntakeSourcePolicy {
  readonly unaddressedGroupMessages: boolean
  readonly unsubscribedEvents: boolean
}

export interface WorkItemIntakeSignals {
  readonly senderAllowlisted: boolean
  readonly addressed: boolean
  readonly threadFollowUp: boolean
  readonly senderIsBot: boolean
  readonly groupMessage: boolean
  readonly subscribed: boolean
}

/** Normalized input plus the Host-computed grade and pre-dedup decision. */
export interface WorkItemIntakeCandidate {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: WorkItemIntakeKind
  readonly signals: WorkItemIntakeSignals
  readonly strength: WorkItemIntakeStrength
  readonly strengthReason: WorkItemIntakeStrengthReason
  /** `stored` may still become `duplicate` inside the store transaction. */
  readonly decision: 'stored' | 'filtered'
  readonly reason: WorkItemIntakeReason
  readonly contentDigest: string | null
  readonly metadataDigest: string
  readonly occurredAt: number
}

export interface WorkItemIntakeRecord {
  readonly source: string
  readonly sourceEventId: string
  readonly kind: WorkItemIntakeKind
  readonly decision: WorkItemIntakeDecision
  readonly reason: WorkItemIntakeReason
  readonly strength: WorkItemIntakeStrength
  readonly strengthReason: WorkItemIntakeStrengthReason
  readonly signals: WorkItemIntakeSignals
  readonly contentDigest: string | null
  readonly metadataDigest: string
  readonly occurredAt: number
  readonly recordedAt: number
}

export interface WorkItemIntakeResult {
  readonly record: WorkItemIntakeRecord
  /** True when the `(source, sourceEventId)` row already existed. */
  readonly replayed: boolean
  /** Replay only: the replayed metadata digest differs from the original. */
  readonly metadataChanged?: true
}

const INPUT_KEYS = ['source', 'sourceEventId', 'kind', 'senderAllowlisted', 'addressed', 'threadFollowUp', 'senderIsBot',
  'groupMessage', 'subscribed', 'contentDigest', 'occurredAt', 'objective', 'objectiveDigest', 'acceptance'] as const
export const INTAKE_SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/u
const SHA256_HEX = /^[0-9a-f]{64}$/u
const MAX_EVENT_ID_BYTES = 256
// C0/C1 controls and line/paragraph separators never belong in an id.
function hasControl(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0)!
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}
const DISABLED_POLICY: WorkItemIntakeSourcePolicy = Object.freeze({ unaddressedGroupMessages: false, unsubscribedEvents: false })

/** Hard cap for the original objective text; over-limit input is rejected, never truncated. */
export const MAX_INTAKE_OBJECTIVE_BYTES = 2_048
const ACCEPTANCE_CONTRACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const ACCEPTANCE_KEYS = ['contractDigest', 'contractId'] as const

function fail(code: WorkItemErrorCode, message: string): never {
  throw new WorkItemError(code, message)
}

/**
 * Validate the optional original objective carried by an intake producer.
 *
 * The text is bounded, has no NUL/control ambiguity, is digest-bound to itself
 * and to the authenticated `contentDigest`, and — when the observer also hands
 * over the transient source text — must equal it byte for byte. The caller
 * keeps it only in the bounded in-memory admission hint; it is never written to
 * the intake ledger.
 */
export function intakeObjectiveOf(raw: WorkItemIntakeInput, sourceText?: string): WorkItemIntakeObjective | undefined {
  const value = raw as unknown as Record<string, unknown>
  const objective = value['objective'], digest = value['objectiveDigest']
  if (objective === undefined && digest === undefined) return undefined
  if (objective === undefined || digest === undefined) fail('invalid-input', 'intake objective and objectiveDigest must be supplied together')
  if (typeof objective !== 'string' || objective.length === 0 || !objective.isWellFormed()
    || Buffer.byteLength(objective, 'utf8') > MAX_INTAKE_OBJECTIVE_BYTES || objective.includes('\u0000')) {
    fail('invalid-input', `intake objective must be 1-${MAX_INTAKE_OBJECTIVE_BYTES} UTF-8 bytes without NUL or lone surrogates`)
  }
  if (typeof digest !== 'string' || !SHA256_HEX.test(digest) || createHash('sha256').update(objective, 'utf8').digest('hex') !== digest) {
    fail('invalid-input', 'intake objectiveDigest must be the SHA-256 hex of the objective')
  }
  if (value['contentDigest'] !== digest) fail('invalid-input', 'intake objectiveDigest must equal contentDigest')
  if (sourceText !== undefined && sourceText !== objective) fail('invalid-input', 'intake objective must equal the authenticated source text')
  return Object.freeze({ text: objective, digest })
}

/** Validate the optional verifier contract handle; ids/digests only, nothing else. */
export function intakeAcceptanceOf(raw: WorkItemIntakeInput): WorkItemIntakeAcceptance | undefined {
  const value = raw as unknown as Record<string, unknown>
  const acceptance = value['acceptance']
  if (acceptance === undefined) return undefined
  if (acceptance === null || typeof acceptance !== 'object' || Array.isArray(acceptance)
    || Object.getPrototypeOf(acceptance) !== Object.prototype) fail('invalid-input', 'intake acceptance must be a plain object')
  const record = acceptance as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.length !== ACCEPTANCE_KEYS.length || keys.some((key, index) => key !== ACCEPTANCE_KEYS[index])) {
    fail('invalid-input', 'intake acceptance accepts exactly contractId and contractDigest')
  }
  const contractId = record['contractId'], contractDigest = record['contractDigest']
  if (typeof contractId !== 'string' || !ACCEPTANCE_CONTRACT_ID.test(contractId)) fail('invalid-input', 'intake acceptance contractId is invalid')
  if (typeof contractDigest !== 'string' || !SHA256_HEX.test(contractDigest)) fail('invalid-input', 'intake acceptance contractDigest is invalid')
  return Object.freeze({ contractId, contractDigest })
}

function flag(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') fail('invalid-input', `intake ${field} must be a boolean`)
  return value
}

/**
 * Grade one item's strength from normalized metadata.
 *
 * The allowlist scopes both explicit paths: an allowlisted sender that
 * addresses the assistant, or follows up on a tracked work thread, is
 * `explicit`; allowlisted but otherwise unaddressed is `inferred`; anything
 * else, including a non-allowlisted follow-up, is `ignore`. A bot sender is
 * never stronger than `inferred`.
 */
export function gradeIntakeStrength(signals: Pick<WorkItemIntakeSignals, 'senderAllowlisted' | 'addressed' | 'threadFollowUp' | 'senderIsBot'>):
  { readonly strength: WorkItemIntakeStrength; readonly reason: WorkItemIntakeStrengthReason } {
  let strength: WorkItemIntakeStrength
  let reason: WorkItemIntakeStrengthReason
  if (signals.senderAllowlisted && signals.addressed) [strength, reason] = ['explicit', 'allowlisted-addressed']
  else if (signals.senderAllowlisted && signals.threadFollowUp) [strength, reason] = ['explicit', 'thread-follow-up']
  else if (signals.senderAllowlisted) [strength, reason] = ['inferred', 'allowlisted-unaddressed']
  else if (signals.threadFollowUp) [strength, reason] = ['ignore', 'follow-up-not-allowlisted']
  else [strength, reason] = ['ignore', 'not-allowlisted']
  if (signals.senderIsBot && strength === 'explicit') [strength, reason] = ['inferred', 'bot-capped']
  return Object.freeze({ strength, reason })
}

/** Stable digest over the normalized metadata only; never over content. */
function metadataDigest(fields: Record<string, unknown>): string {
  const canonical = JSON.stringify(Object.keys(fields).sort().map(key => [key, fields[key]]))
  return createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Validate one input and compute its grade and pre-dedup decision.
 *
 * An `ignore` grade is `filtered`. Source opt-in filters then apply: a group
 * message that is neither addressed nor an allowlisted follow-up, or an
 * unsubscribed event, is `filtered` unless the owner enabled that source.
 * Everything else is `stored` (metadata only).
 */
export function classifyIntake(raw: WorkItemIntakeInput, policy: WorkItemIntakeSourcePolicy = DISABLED_POLICY): WorkItemIntakeCandidate {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid-input', 'intake input must be an object')
  const value = raw as unknown as Record<string, unknown>
  for (const key of Object.keys(value)) {
    if (!(INPUT_KEYS as readonly string[]).includes(key)) fail('invalid-input', `intake input contains unknown field ${key}`)
  }
  const source = value['source']
  if (typeof source !== 'string' || !INTAKE_SOURCE_ID.test(source)) fail('invalid-input', 'intake source has an invalid shape')
  const eventId = value['sourceEventId']
  if (typeof eventId !== 'string' || eventId.length === 0 || eventId !== eventId.trim() || hasControl(eventId)
    || Buffer.byteLength(eventId, 'utf8') > MAX_EVENT_ID_BYTES) {
    fail('invalid-input', `intake sourceEventId must be 1-${MAX_EVENT_ID_BYTES} bytes without control characters`)
  }
  const kind = value['kind']
  if (kind !== 'message' && kind !== 'event') fail('invalid-input', "intake kind must be 'message' or 'event'")
  if (kind === 'message' && value['subscribed'] !== undefined) fail('invalid-input', 'intake subscribed applies to events only')
  if (kind === 'event' && value['groupMessage'] !== undefined) fail('invalid-input', 'intake groupMessage applies to messages only')
  const signals: WorkItemIntakeSignals = Object.freeze({
    senderAllowlisted: flag(value['senderAllowlisted'], 'senderAllowlisted'),
    addressed: flag(value['addressed'], 'addressed'),
    threadFollowUp: flag(value['threadFollowUp'], 'threadFollowUp'),
    senderIsBot: flag(value['senderIsBot'], 'senderIsBot'),
    groupMessage: flag(value['groupMessage'], 'groupMessage', false),
    subscribed: flag(value['subscribed'], 'subscribed', true),
  })
  const rawDigest = value['contentDigest']
  if (rawDigest !== undefined && (typeof rawDigest !== 'string' || !SHA256_HEX.test(rawDigest))) {
    fail('invalid-input', 'intake contentDigest must be a lowercase SHA-256 hex digest')
  }
  const contentDigest = rawDigest === undefined ? null : rawDigest
  const occurredAt = value['occurredAt']
  if (typeof occurredAt !== 'number' || !Number.isSafeInteger(occurredAt) || occurredAt < 0) fail('invalid-input', 'intake occurredAt must be a non-negative integer')
  const grade = gradeIntakeStrength(signals)
  let decision: 'stored' | 'filtered' = grade.strength === 'ignore' ? 'filtered' : 'stored'
  let reason: WorkItemIntakeReason = grade.strength === 'explicit' ? 'strength-explicit' : grade.strength === 'inferred' ? 'strength-inferred' : 'strength-ignore'
  // A follow-up counts as addressed only for an allowlisted sender.
  const directed = signals.addressed || (signals.threadFollowUp && signals.senderAllowlisted)
  if (kind === 'message' && signals.groupMessage && !directed && !policy.unaddressedGroupMessages) {
    [decision, reason] = ['filtered', 'unaddressed-group-disabled']
  } else if (kind === 'event' && !signals.subscribed && !policy.unsubscribedEvents) {
    [decision, reason] = ['filtered', 'unsubscribed-event-disabled']
  }
  return Object.freeze({
    source,
    sourceEventId: eventId,
    kind,
    signals,
    strength: grade.strength,
    strengthReason: grade.reason,
    decision,
    reason,
    contentDigest,
    metadataDigest: metadataDigest({ source, sourceEventId: eventId, kind, ...signals, contentDigest, occurredAt }),
    occurredAt,
  })
}

/** Resolve the owner opt-ins for one source; unknown sources stay fully off. */
export function intakeSourcePolicy(sources: Readonly<Record<string, WorkItemIntakeSourcePolicy>> | undefined, source: string): WorkItemIntakeSourcePolicy {
  if (sources === undefined || !Object.hasOwn(sources, source)) return DISABLED_POLICY
  return sources[source]!
}
