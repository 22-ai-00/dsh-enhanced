import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AssistantDreamingService, IdeaEvent } from '@dsh-ray/assistant-dreaming'
import type { GrowthAuthority } from './deposit.js'

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const DIGEST_HEX = /^[a-f0-9]{64}$/u
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u
const MAX_SCAN_IDEAS = 64

export interface ValidatedDreamIdeaInput {
  readonly id: string
  readonly state: 'validated'
  readonly lane: string
  readonly dayKey: string
  readonly createdAt: number
  readonly summary: string
  readonly detail: string
  readonly evidenceRefs: readonly string[]
  readonly digest: string
}

export interface DreamingIntakeSummary {
  readonly enabled: boolean
  readonly considered: number
  readonly ingested: number
  readonly rejectedUnvalidated: number
  readonly ideaIds: readonly string[]
}

export interface ReadValidatedDreamIdeasResult {
  readonly ideas: readonly ValidatedDreamIdeaInput[]
  readonly summary: DreamingIntakeSummary
}

type DreamingIntakePort = Partial<Pick<
  AssistantDreamingService,
  'health' | 'inspectIdeas' | 'inspectValidatedIdeas' | 'inspectIdeaEvents'
>>

function boundedPrintable(value: unknown, maxBytes: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFC').trim()
  if (text.length === 0 || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > maxBytes) return null
  if ([...text].some(char => {
    const code = char.codePointAt(0)!
    return (code <= 0x1f && code !== 0x0a && code !== 0x09) || code === 0x7f
  })) return null
  return text
}

function digestValidatedIdea(idea: Omit<ValidatedDreamIdeaInput, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({
    id: idea.id,
    lane: idea.lane,
    dayKey: idea.dayKey,
    createdAt: idea.createdAt,
    state: 'validated',
    summary: idea.summary,
    detail: idea.detail,
    evidenceRefs: idea.evidenceRefs,
  })).digest('hex')
}

/**
 * Validate a candidate idea before admitting it into growth-driver prompt or
 * wake context. Only strictly `state === 'validated'` ideas with bounded fields
 * and digest-format evidence references are ever accepted.
 */
export function assertValidatedDreamIdeaInput(value: unknown): ValidatedDreamIdeaInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assistant-growth-driver: dreaming idea must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.state !== 'validated') {
    throw new Error(`assistant-growth-driver: refusing unvalidated dreaming idea (state=${String(raw.state)})`)
  }
  const id = boundedPrintable(raw.id, 128)
  const lane = boundedPrintable(raw.lane, 128)
  const dayKey = typeof raw.dayKey === 'string' && DAY_KEY.test(raw.dayKey) ? raw.dayKey : null
  const createdAt = typeof raw.createdAt === 'number' && Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0
    ? raw.createdAt
    : null
  const summary = boundedPrintable(raw.summary, 2_048)
  const detail = boundedPrintable(raw.detail, 8_192)
  if (id === null || lane === null || dayKey === null || createdAt === null || summary === null || detail === null) {
    throw new Error('assistant-growth-driver: invalid validated dreaming idea fields')
  }
  if (!Array.isArray(raw.evidenceRefs) || raw.evidenceRefs.length === 0 || raw.evidenceRefs.length > 16) {
    throw new Error('assistant-growth-driver: validated dreaming idea requires bounded evidenceRefs')
  }
  const evidenceRefs: string[] = []
  for (const ref of raw.evidenceRefs) {
    if (typeof ref !== 'string' || !DIGEST_HEX.test(ref)) {
      throw new Error('assistant-growth-driver: invalid dreaming evidenceRef digest')
    }
    evidenceRefs.push(ref)
  }
  const base = {
    id,
    state: 'validated' as const,
    lane,
    dayKey,
    createdAt,
    summary,
    detail,
    evidenceRefs: Object.freeze(evidenceRefs),
  }
  const digest = digestValidatedIdea(base)
  if (raw.digest !== undefined && raw.digest !== digest) {
    throw new Error('assistant-growth-driver: dreaming idea digest mismatch')
  }
  return Object.freeze({ ...base, digest })
}

function hasOwnerValidationAudit(events: readonly IdeaEvent[]): boolean {
  if (!Array.isArray(events) || events.length === 0) return false
  const last = events[events.length - 1]
  if (last === undefined || last.state !== 'validated') return false
  return events.some(event => event?.state === 'validated' && event?.actor === 'owner')
}

function unwrapDreaming(ctx: Context): DreamingIntakePort | undefined {
  const service = ctx.get('assistantDreaming' as never, false) as
    | (DreamingIntakePort & { [CORDIS_ORIGINAL]?: DreamingIntakePort })
    | undefined
  if (service === undefined) return undefined
  return service[CORDIS_ORIGINAL] ?? service
}

/**
 * Bounded, read-only ingestion of owner-validated dreaming ideas.
 * Strictly ignores any idea that is not `state === 'validated'` (or lacks an
 * owner validation audit event when `inspectIdeaEvents` is available).
 */
export function readValidatedDreamIdeas(
  ctx: Context,
  authority: GrowthAuthority,
  maxIdeas: number,
): ReadValidatedDreamIdeasResult {
  authority.assertCurrent()
  const limit = Number.isSafeInteger(maxIdeas) ? Math.min(Math.max(1, maxIdeas), 10) : 3
  const dreaming = unwrapDreaming(ctx)
  if (dreaming === undefined || typeof dreaming.health !== 'function') {
    return Object.freeze({
      ideas: Object.freeze([]),
      summary: Object.freeze({
        enabled: false,
        considered: 0,
        ingested: 0,
        rejectedUnvalidated: 0,
        ideaIds: Object.freeze([]),
      }),
    })
  }
  const health = dreaming.health()
  if (health === null || typeof health !== 'object' || health.enabled !== true) {
    return Object.freeze({
      ideas: Object.freeze([]),
      summary: Object.freeze({
        enabled: false,
        considered: 0,
        ingested: 0,
        rejectedUnvalidated: 0,
        ideaIds: Object.freeze([]),
      }),
    })
  }

  const scanLimit = Math.min(Math.max(limit * 4, 20), MAX_SCAN_IDEAS)
  const rawCandidates = typeof dreaming.inspectValidatedIdeas === 'function'
    ? dreaming.inspectValidatedIdeas(scanLimit)
    : typeof dreaming.inspectIdeas === 'function'
      ? dreaming.inspectIdeas(scanLimit)
      : []

  const ideas: ValidatedDreamIdeaInput[] = []
  const seenIds = new Set<string>()
  let considered = 0
  let rejectedUnvalidated = 0

  if (Array.isArray(rawCandidates)) {
    for (const candidate of rawCandidates) {
      if (ideas.length >= limit || considered >= MAX_SCAN_IDEAS) break
      considered += 1
      let validated: ValidatedDreamIdeaInput
      try {
        validated = assertValidatedDreamIdeaInput(candidate)
      } catch {
        rejectedUnvalidated += 1
        continue
      }
      if (seenIds.has(validated.id)) continue
      if (typeof dreaming.inspectIdeaEvents === 'function') {
        const events = dreaming.inspectIdeaEvents(validated.id, 32)
        if (!hasOwnerValidationAudit(events)) {
          rejectedUnvalidated += 1
          continue
        }
      }
      authority.assertCurrent()
      seenIds.add(validated.id)
      ideas.push(validated)
    }
  }

  authority.assertCurrent()
  const frozenIdeas = Object.freeze(ideas)
  const ideaIds = Object.freeze(frozenIdeas.map(item => item.id))
  return Object.freeze({
    ideas: frozenIdeas,
    summary: Object.freeze({
      enabled: true,
      considered,
      ingested: frozenIdeas.length,
      rejectedUnvalidated,
      ideaIds,
    }),
  })
}
