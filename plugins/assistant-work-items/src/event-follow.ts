import { createHash } from 'node:crypto'
import type { WorkItemThreadClosure, WorkItemThreadSourceRegistration } from './types.js'

/**
 * Event Triggers as a followed-thread source (subscription pass-through, slice 1).
 *
 * A work item may follow `event-triggers` refs shaped `<triggerId>@<afterSequence>`.
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

// Trigger ids follow Event Triggers' stable lowercase identifier shape.
const REF = /^([a-z0-9][a-z0-9._:-]{0,199})@(0|[1-9][0-9]{0,15})$/

/** Parse `<triggerId>@<afterSequence>`; anything else is not an event follow. */
export function parseEventFollowRef(ref: string): { triggerId: string; afterSequence: number } | undefined {
  const match = typeof ref === 'string' ? REF.exec(ref) : null
  if (match === null) return undefined
  const afterSequence = Number(match[2])
  return Number.isSafeInteger(afterSequence) ? { triggerId: match[1]!, afterSequence } : undefined
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
 * The source generation: Event Triggers version plus every owner trigger's
 * config digest. Any trigger config, enablement or owner change yields a new
 * generation, which degrades older follows to `generation-mismatch`.
 */
export function eventFollowGeneration(reader: EventFollowReader, owner: EventFollowOwnerScope): string {
  const parts: string[] = []
  let version = 'none'
  for (const source of [...reader.inspectOwnerSources(owner)].sort((a, b) => a.triggerId < b.triggerId ? -1 : a.triggerId > b.triggerId ? 1 : 0)) {
    const snapshot = reader.sourceSnapshot(source.triggerId)
    version = snapshot.version
    parts.push(`${source.triggerId} ${snapshot.configDigest} ${snapshot.kind} ${snapshot.target.automationId}`)
  }
  const digest = createHash('sha256').update(parts.join('\n')).digest('hex')
  return `event-triggers/${version}/${digest}`
}

/**
 * Build the `event-triggers` registration. `owner` is read live on every call so
 * a revoked or changed owner route fails closed instead of reusing old scope.
 */
export function eventFollowRegistration(input: {
  readonly reader: EventFollowReader
  readonly owner: () => EventFollowOwnerScope
  readonly now?: () => number
}): WorkItemThreadSourceRegistration {
  const { reader, owner } = input
  const now = input.now ?? Date.now
  const generation = eventFollowGeneration(reader, owner())
  const ownedSnapshot = (triggerId: string): Readonly<SourceSnapshot> | undefined => {
    const scope = owner()
    if (!reader.inspectOwnerSources(scope).some(source => source.triggerId === triggerId)) return undefined
    // A live generation change means this registration is about to be replaced.
    if (eventFollowGeneration(reader, scope) !== generation) return undefined
    return reader.sourceSnapshot(triggerId)
  }
  return Object.freeze({
    source: EVENT_TRIGGERS_FOLLOW_SOURCE,
    generation,
    // Admission-time fence: the cursor must be exactly the current high water,
    // so a forged low cursor cannot close a follow on an event that already
    // existed, and a future cursor cannot be pre-armed.
    validate(ref: string): boolean {
      const parsed = parseEventFollowRef(ref)
      if (parsed === undefined) return false
      const snapshot = ownedSnapshot(parsed.triggerId)
      return snapshot !== undefined && parsed.afterSequence === snapshot.highWaterSequence
    },
    resolve(ref: string): WorkItemThreadClosure | undefined {
      const parsed = parseEventFollowRef(ref)
      if (parsed === undefined) return undefined
      const snapshot = ownedSnapshot(parsed.triggerId)
      if (snapshot === undefined) return undefined
      if (parsed.afterSequence > snapshot.highWaterSequence) return undefined
      // Read from the admitted cursor; Event Triggers revalidates the trigger,
      // config digest, envelope digest and signing skew for every candidate.
      const event = reader.firstEventAfter({ ...snapshot, highWaterSequence: parsed.afterSequence }, parsed.afterSequence, now())
      if (event === undefined) {
        return Object.freeze({ state: 'open' as const, outcome: 'unknown' as const, digest: `${snapshot.configDigest}@${snapshot.highWaterSequence}` })
      }
      return Object.freeze({ state: 'closed' as const, outcome: 'unknown' as const, digest: eventEnvelopeDigest(event.envelope) })
    },
  })
}
