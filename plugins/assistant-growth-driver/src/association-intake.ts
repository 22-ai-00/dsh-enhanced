import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { GoalScope } from '@dsh-ray/assistant-goals'
import type { GrowthAuthority } from './deposit.js'

const CORDIS_ORIGINAL = Symbol.for('cordis.original')
const DIGEST_HEX = /^[a-f0-9]{64}$/u
const MAX_SCAN_CANDIDATES = 64

export interface AssociationCandidateGoalLocator {
  readonly goalId: string
  readonly sessionId: string
}

export interface AssociationSkillCandidateInput {
  readonly candidateId: string
  readonly ownerScopeKey: string
  readonly clusterId: string
  readonly signatureDigest: string
  readonly name: string
  readonly description: string
  readonly toolSequence: readonly string[]
  readonly sharedEntities: readonly string[]
  readonly memberTaskIds: readonly string[]
  readonly goalLocators: readonly AssociationCandidateGoalLocator[]
  readonly similarity: number
  readonly wp04Verified: true
  readonly status: 'pending'
  readonly createdAt: number
  readonly updatedAt: number
  readonly digest: string
}

export interface AssociationIntakeSummary {
  readonly enabled: boolean
  readonly considered: number
  readonly ingested: number
  readonly rejectedUnverified: number
  readonly candidateIds: readonly string[]
}

export interface ReadAssociationCandidatesResult {
  readonly candidates: readonly AssociationSkillCandidateInput[]
  readonly summary: AssociationIntakeSummary
}

interface AssociationIntakePort {
  readonly enabled?: boolean
  listSkillCandidates?: (
    ownerScopeKey: string,
    options?: { readonly status?: 'pending' | 'staged' | 'dismissed'; readonly limit?: number },
  ) => readonly unknown[]
}

function boundedPrintable(value: unknown, maxBytes: number, allowWhitespaceFormatting = false): string | null {
  if (typeof value !== 'string') return null
  const text = value.normalize('NFC').trim()
  if (text.length === 0 || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > maxBytes) return null
  if ([...text].some(char => {
    const code = char.codePointAt(0)!
    if (allowWhitespaceFormatting && (code === 0x0a || code === 0x09)) return false
    return code <= 0x1f || code === 0x7f
  })) return null
  return text
}

function boundedStringList(
  value: unknown,
  minItems: number,
  maxItems: number,
  maxItemBytes: number,
  label: string,
): readonly string[] {
  if (!Array.isArray(value) || value.length < minItems || value.length > maxItems) {
    throw new Error(`assistant-growth-driver: association candidate requires bounded ${label}`)
  }
  const out: string[] = []
  for (const item of value) {
    const text = boundedPrintable(item, maxItemBytes)
    if (text === null) {
      throw new Error(`assistant-growth-driver: invalid association candidate ${label} entry`)
    }
    out.push(text)
  }
  return Object.freeze(out)
}

function sanitizeGoalLocators(value: unknown): readonly AssociationCandidateGoalLocator[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error('assistant-growth-driver: association candidate requires bounded goalLocators')
  }
  const out: AssociationCandidateGoalLocator[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('assistant-growth-driver: invalid association candidate goalLocator')
    }
    const raw = entry as Record<string, unknown>
    const goalId = boundedPrintable(raw.goalId, 256)
    const sessionId = boundedPrintable(raw.sessionId, 256)
    if (goalId === null || sessionId === null) {
      throw new Error('assistant-growth-driver: invalid association candidate goalLocator fields')
    }
    const key = `${sessionId}\0${goalId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(Object.freeze({ goalId, sessionId }))
  }
  return Object.freeze(out)
}

function digestAssociationCandidate(candidate: Omit<AssociationSkillCandidateInput, 'digest'>): string {
  return createHash('sha256').update(JSON.stringify({
    candidateId: candidate.candidateId,
    ownerScopeKey: candidate.ownerScopeKey,
    clusterId: candidate.clusterId,
    signatureDigest: candidate.signatureDigest,
    name: candidate.name,
    description: candidate.description,
    toolSequence: candidate.toolSequence,
    sharedEntities: candidate.sharedEntities,
    memberTaskIds: candidate.memberTaskIds,
    goalLocators: candidate.goalLocators,
    similarity: candidate.similarity,
    wp04Verified: true,
    status: 'pending',
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  })).digest('hex')
}

/**
 * Compute the canonical delivery ownerScopeKey matching assistant-association's
 * `computeOwnerScopeKey` in `delivery` mode without creating a runtime dependency.
 */
export function computeAssociationOwnerScopeKey(scope: GoalScope): string {
  const principalDigest = createHash('sha256').update(scope.principalId, 'utf8').digest('hex')
  return createHash('sha256')
    .update(
      JSON.stringify([
        'delivery',
        principalDigest,
        scope.principalRecordId,
        scope.principalVersion,
        scope.workspace,
        scope.preset,
      ]),
      'utf8',
    )
    .digest('hex')
}

/**
 * Validate a candidate surfaced by `assistant-association` before admitting it
 * into growth-driver prompt context. Only strictly `status === 'pending'` and
 * `wp04Verified === true` candidates with bounded sanitized fields are accepted.
 */
export function assertAssociationCandidateInput(value: unknown): AssociationSkillCandidateInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('assistant-growth-driver: association candidate must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.status !== 'pending') {
    throw new Error(`assistant-growth-driver: refusing non-pending association candidate (status=${String(raw.status)})`)
  }
  if (raw.wp04Verified !== true) {
    throw new Error(`assistant-growth-driver: refusing unverified association candidate (wp04Verified=${String(raw.wp04Verified)})`)
  }
  const candidateId = boundedPrintable(raw.candidateId, 128)
  const ownerScopeKey = boundedPrintable(raw.ownerScopeKey, 128)
  const clusterId = boundedPrintable(raw.clusterId, 128)
  const signatureDigest = typeof raw.signatureDigest === 'string' && DIGEST_HEX.test(raw.signatureDigest)
    ? raw.signatureDigest
    : null
  const name = boundedPrintable(raw.name, 128)
  const description = boundedPrintable(raw.description, 2_048, true)
  const similarity = typeof raw.similarity === 'number' && Number.isFinite(raw.similarity) && raw.similarity >= 0 && raw.similarity <= 1
    ? raw.similarity
    : null
  const createdAt = typeof raw.createdAt === 'number' && Number.isSafeInteger(raw.createdAt) && raw.createdAt >= 0
    ? raw.createdAt
    : null
  const updatedAt = typeof raw.updatedAt === 'number' && Number.isSafeInteger(raw.updatedAt) && raw.updatedAt >= 0
    ? raw.updatedAt
    : null
  if (
    candidateId === null
    || ownerScopeKey === null
    || clusterId === null
    || signatureDigest === null
    || name === null
    || description === null
    || similarity === null
    || createdAt === null
    || updatedAt === null
  ) {
    throw new Error('assistant-growth-driver: invalid association candidate fields')
  }
  const toolSequence = boundedStringList(raw.toolSequence, 1, 32, 128, 'toolSequence')
  const sharedEntities = boundedStringList(raw.sharedEntities, 0, 32, 128, 'sharedEntities')
  const memberTaskIds = boundedStringList(raw.memberTaskIds, 1, 64, 256, 'memberTaskIds')
  const goalLocators = sanitizeGoalLocators(raw.goalLocators)
  const base = {
    candidateId,
    ownerScopeKey,
    clusterId,
    signatureDigest,
    name,
    description,
    toolSequence,
    sharedEntities,
    memberTaskIds,
    goalLocators,
    similarity,
    wp04Verified: true as const,
    status: 'pending' as const,
    createdAt,
    updatedAt,
  }
  const digest = digestAssociationCandidate(base)
  if (raw.digest !== undefined && raw.digest !== digest) {
    throw new Error('assistant-growth-driver: association candidate digest mismatch')
  }
  return Object.freeze({ ...base, digest })
}

function unwrapAssociation(ctx: Context): AssociationIntakePort | undefined {
  const service = ctx.get('assistantAssociation' as never, false) as
    | (AssociationIntakePort & { [CORDIS_ORIGINAL]?: AssociationIntakePort })
    | undefined
  if (service === undefined) return undefined
  return service[CORDIS_ORIGINAL] ?? service
}

function emptyDisabledResult(): ReadAssociationCandidatesResult {
  return Object.freeze({
    candidates: Object.freeze([]),
    summary: Object.freeze({
      enabled: false,
      considered: 0,
      ingested: 0,
      rejectedUnverified: 0,
      candidateIds: Object.freeze([]),
    }),
  })
}

/**
 * Bounded, read-only ingestion of WP04-verified pending skill candidates from
 * `assistant-association`. Gracefully returns an empty disabled result when
 * `assistantAssociation` is absent or disabled, and strictly rejects unverified,
 * non-pending, cross-scope, or malformed candidates.
 */
export function readAssociationCandidates(
  ctx: Context,
  authority: GrowthAuthority,
  maxCandidates: number,
): ReadAssociationCandidatesResult {
  authority.assertCurrent()
  const limit = Number.isSafeInteger(maxCandidates) ? Math.min(Math.max(1, maxCandidates), 10) : 3
  const assoc = unwrapAssociation(ctx)
  if (
    assoc === undefined
    || typeof assoc.listSkillCandidates !== 'function'
    || (assoc.enabled !== undefined && assoc.enabled !== true)
  ) {
    return emptyDisabledResult()
  }

  const ownerScopeKey = computeAssociationOwnerScopeKey(authority.scope)
  const scanLimit = Math.min(Math.max(limit * 4, 20), MAX_SCAN_CANDIDATES)
  let rawCandidates: readonly unknown[]
  try {
    rawCandidates = assoc.listSkillCandidates(ownerScopeKey, { status: 'pending', limit: scanLimit })
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (code === 'disabled' || code === 'disposed') {
      return emptyDisabledResult()
    }
    throw error
  }

  const candidates: AssociationSkillCandidateInput[] = []
  const seenIds = new Set<string>()
  let considered = 0
  let rejectedUnverified = 0

  if (Array.isArray(rawCandidates)) {
    for (const candidate of rawCandidates) {
      if (candidates.length >= limit || considered >= MAX_SCAN_CANDIDATES) break
      considered += 1
      let validated: AssociationSkillCandidateInput
      try {
        validated = assertAssociationCandidateInput(candidate)
      } catch {
        rejectedUnverified += 1
        continue
      }
      if (validated.ownerScopeKey !== ownerScopeKey) {
        rejectedUnverified += 1
        continue
      }
      if (seenIds.has(validated.candidateId)) continue
      authority.assertCurrent()
      seenIds.add(validated.candidateId)
      candidates.push(validated)
    }
  }

  authority.assertCurrent()
  const frozenCandidates = Object.freeze(candidates)
  const candidateIds = Object.freeze(frozenCandidates.map(item => item.candidateId))
  return Object.freeze({
    candidates: frozenCandidates,
    summary: Object.freeze({
      enabled: true,
      considered,
      ingested: frozenCandidates.length,
      rejectedUnverified,
      candidateIds,
    }),
  })
}
