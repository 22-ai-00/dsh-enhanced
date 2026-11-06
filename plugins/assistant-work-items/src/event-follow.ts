import { createHash } from 'node:crypto'
import type { WorkItemThreadClosure, WorkItemThreadSourceRegistration } from './types.js'

/**
 * Event Triggers as a followed-thread source (subscription pass-through, slice 1).
 *
 * A work item may follow `event-triggers` refs shaped
 * `<triggerId>@<afterSequence>@<configDigest>`; with `acceptHeadRef` an
 * admission may also pass `<triggerId>@head`, which is rewritten to that
 * canonical form before it is validated or stored.
 * The follow closes once the first authenticated source event after that cursor
 * exists. The event only proves something happened on the subscription, never
 * that the objective was achieved, so a closure always reports outcome
 * `unknown` and the settled outcome stays unverified.
 *
 * Everything here is passive: resolution runs inside the existing bounded
 * settlement pass, and this module adds no timers or change subscriptions.
 */
export const EVENT_TRIGGERS_FOLLOW_SOURCE = 'event-triggers'

/** Owner scope exactly as `eventTriggers.inspectOwnerSources` matches it. */
export interface EventFollowOwnerScope {
  readonly principalId: string
  readonly principalRecordId: string
  readonly principalVersion: number
  readonly workspace: string
  readonly preset: string
}

interface SourceSnapshot {
  readonly protocol: string
  readonly sourceId: string
  readonly kind: string
  readonly version: string
  readonly configDigest: string
  readonly target: { readonly automationId: string }
  readonly highWaterSequence: number
}

interface OwnerSource { readonly triggerId: string; readonly automationId: string; readonly kind: string }

/** Structural subset of the Event Triggers service; it is never imported. */
export interface EventFollowReader {
  inspectOwnerSources(scope: EventFollowOwnerScope): readonly OwnerSource[]
  sourceSnapshot(triggerId: string): Readonly<SourceSnapshot>
  firstEventAfter(snapshot: Readonly<SourceSnapshot>, afterSequence: number, deadlineAt: number): Readonly<{ sequence: number; envelope: unknown }> | undefined
}

export function eventFollowReader(value: unknown): EventFollowReader | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<EventFollowReader>
  return typeof candidate.inspectOwnerSources === 'function' && typeof candidate.sourceSnapshot === 'function'
    && typeof candidate.firstEventAfter === 'function' ? candidate as EventFollowReader : undefined
}

// Trigger ids follow Event Triggers' stable lowercase identifier shape; the
// trailing segment is the trigger's 64-hex config digest at admission.
const REF = /^([a-z0-9][a-z0-9._:-]{0,199})@(0|[1-9][0-9]{0,15})@([a-f0-9]{64})$/

export interface EventFollowRef { readonly triggerId: string; readonly afterSequence: number; readonly configDigest: string }

const HEAD_REF = /^([a-z0-9][a-z0-9._:-]{0,199})@head$/

/** Trigger id of an admission-only `<triggerId>@head` alias; never a stored ref. */
export function parseEventFollowHeadRef(ref: string): string | undefined {
  const match = typeof ref === 'string' ? HEAD_REF.exec(ref) : null
  return match === null ? undefined : match[1]!
}

/** Parse `<triggerId>@<afterSequence>@<configDigest>`; anything else is not an event follow. */
export function parseEventFollowRef(ref: string): EventFollowRef | undefined {
  const match = typeof ref === 'string' ? REF.exec(ref) : null
  if (match === null) return undefined
  const afterSequence = Number(match[2])
  return Number.isSafeInteger(afterSequence) ? { triggerId: match[1]!, afterSequence, configDigest: match[3]! } : undefined
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const input = value as Record<string, unknown>
  return `{${Object.keys(input).sort().map(key => `${JSON.stringify(key)}:${canonical(input[key])}`).join(',')}}`
}

/**
 * Same bytes as `externalEventDigest` for an envelope Event Triggers already
 * parsed and digest-checked; kept local so the optional peer is not imported.
 */
export function eventEnvelopeDigest(envelope: unknown): string {
  return createHash('sha256').update(canonical(envelope)).digest('hex')
}

/**
 * Follow protocol version carried in the generation. Event Triggers exposes its
 * package version only on per-trigger snapshots, which vanish when a trigger is
 * disabled or its observer expires, so a stable constant is used instead; an
 * Event Triggers version change surfaces per follow because `firstEventAfter`
 * only matches envelopes of the snapshot's version.
 */
export const EVENT_FOLLOW_PROTOCOL = 'v1'

/**
 * The source generation depends only on the owner identity, never on runtime
 * trigger state (observer expiry, goal retirement, automation pause, config
 * edits). Per-trigger config isolation lives in the ref's config digest, so one
 * trigger's change degrades only the follows on that trigger.
 */
export function eventFollowGeneration(owner: EventFollowOwnerScope): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([owner.principalRecordId, owner.principalVersion, owner.workspace, owner.preset]))
    .digest('hex')
  return `event-triggers/${EVENT_FOLLOW_PROTOCOL}/${digest}`
}

/**
 * Build the `event-triggers` registration. `owner` is read live on every call so
 * a revoked or changed owner route fails closed instead of reusing old scope.
 */
export function eventFollowRegistration(input: {
  readonly reader: EventFollowReader
  readonly owner: () => EventFollowOwnerScope
  readonly now?: () => number
  /** Accept the admission-only `<triggerId>@head` alias (`follows.eventTriggers.acceptHeadRef`). */
  readonly acceptHeadRef?: boolean
}): WorkItemThreadSourceRegistration {
  const { reader, owner } = input
  const now = input.now ?? Date.now
  const generation = eventFollowGeneration(owner())
  // Snapshot of one followed trigger, only while it is still an owner source
  // under the admitted config digest; other triggers' state is irrelevant.
  const ownedSnapshot = (ref: EventFollowRef): Readonly<SourceSnapshot> | undefined => {
    const scope = owner()
    if (eventFollowGeneration(scope) !== generation) return undefined
    if (!reader.inspectOwnerSources(scope).some(source => source.triggerId === ref.triggerId)) return undefined
    const snapshot = reader.sourceSnapshot(ref.triggerId)
    return snapshot.configDigest === ref.configDigest ? snapshot : undefined
  }
  // `<triggerId>@head` pins the cursor and digest from one synchronous
  // `sourceSnapshot` read inside admission (no await before the row is
  // written), so an event between the caller's own snapshot read and admission
  // cannot fail it. The canonical ref still goes through `validate`, and an
  // explicit three-part ref passes through unchanged.
  const canonicalize = (ref: string): string | undefined => {
    const triggerId = parseEventFollowHeadRef(ref)
    if (triggerId === undefined) return ref
    const scope = owner()
    if (eventFollowGeneration(scope) !== generation) return undefined
    if (!reader.inspectOwnerSources(scope).some(source => source.triggerId === triggerId)) return undefined
    const snapshot = reader.sourceSnapshot(triggerId)
    return `${triggerId}@${String(snapshot.highWaterSequence)}@${snapshot.configDigest}`
  }
  return Object.freeze({
    source: EVENT_TRIGGERS_FOLLOW_SOURCE,
    generation,
    ...(input.acceptHeadRef === true ? { canonicalize } : {}),
    // Admission-time fence: the cursor must be exactly the current high water
    // (a store-global sequence) and the digest the trigger's current config, so
    // a forged low cursor cannot close a follow on an event that already
    // existed, and a future cursor cannot be pre-armed.
    validate(ref: string): boolean {
      const parsed = parseEventFollowRef(ref)
      if (parsed === undefined) return false
      const snapshot = ownedSnapshot(parsed)
      return snapshot !== undefined && parsed.afterSequence === snapshot.highWaterSequence
    },
    resolve(ref: string): WorkItemThreadClosure | undefined {
      const parsed = parseEventFollowRef(ref)
      if (parsed === undefined) return undefined
      const snapshot = ownedSnapshot(parsed)
      if (snapshot === undefined) return undefined
      if (parsed.afterSequence > snapshot.highWaterSequence) return undefined
      // Security relies on the admission-time high-water check in `validate`:
      // this cursor is replayed from the stored ref and is trusted only because
      // admission refused any cursor below the high water at that moment.
      // Event Triggers revalidates the trigger, config digest, envelope digest
      // and signing skew for every candidate.
      const event = reader.firstEventAfter({ ...snapshot, highWaterSequence: parsed.afterSequence }, parsed.afterSequence, now())
      if (event === undefined) {
        return Object.freeze({ state: 'open' as const, outcome: 'unknown' as const, digest: `${snapshot.configDigest}@${snapshot.highWaterSequence}` })
      }
      return Object.freeze({ state: 'closed' as const, outcome: 'unknown' as const, digest: eventEnvelopeDigest(event.envelope) })
    },
  })
}
