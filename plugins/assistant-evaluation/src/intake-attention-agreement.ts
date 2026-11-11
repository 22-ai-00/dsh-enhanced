/**
 * WP22: read-only agreement between WP20 intake judgments and the attention
 * outcome ledger.
 *
 * The only join that exists is intake admission → work item → result
 * notification (`workItemId` on the outcome record) → owner outcome. An
 * observe-mode `would-admit` never creates an item, so it never reaches a
 * notification and cannot be measured here; only auto-admitted items are.
 * Nothing is written, adopted or sent; the result is observational.
 */
import { createHash } from 'node:crypto'
import { canonicalEvaluationScope } from './store.js'
import type { NotificationOutcome, NotificationOutcomeRecord } from './types.js'
import { notificationOutcomes } from './types.js'

export const INTAKE_ATTENTION_AGREEMENT_PROTOCOL = 'assistant-evaluation/intake-attention-agreement/v1' as const
/** Notifications with a work item scanned per call; more is reported as `truncated`. */
export const INTAKE_ATTENTION_AGREEMENT_SCAN_LIMIT = 1_000

/** Structural mirror of WorkItems' `inspectIntakeProvenance`; Evaluation keeps no runtime dependency on WorkItems. */
export interface IntakeProvenanceSource {
  inspectIntakeProvenance(itemId: string): unknown
}

export function isIntakeProvenanceSource(value: unknown): value is IntakeProvenanceSource {
  return typeof value === 'object' && value !== null
    && typeof (value as { inspectIntakeProvenance?: unknown }).inspectIntakeProvenance === 'function'
}

const LEVELS = ['ignore', 'digest', 'notify', 'accept'] as const
type IntakeLevel = typeof LEVELS[number]

interface IntakeProvenance { itemId: string; level: IntakeLevel; mode: 'observe' | 'auto' }

/**
 * Validate one peer answer; anything malformed, or an item of another owner
 * scope, counts as unresolved, never as a match. A notification sender may
 * name any work item id, so the item's own scope must equal the metric's.
 */
function provenance(value: unknown, itemId: string, scopeKey: string): IntakeProvenance | null | 'invalid' | 'foreign' {
  if (value === undefined) return null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'invalid'
  const item = value as Record<string, unknown>
  if (item.protocol !== 'work-items/intake-provenance/v1' || item.itemId !== itemId || item.wouldAccept !== true
    || !(LEVELS as readonly unknown[]).includes(item.level) || (item.mode !== 'observe' && item.mode !== 'auto')) return 'invalid'
  const scope = item.scope as { workspace?: unknown; preset?: unknown } | null | undefined
  let key: string
  try {
    key = canonicalEvaluationScope({ workspace: scope?.workspace as string, preset: scope?.preset as string }).scopeKey
  } catch { return 'invalid' }
  if (key !== scopeKey) return 'foreign'
  return { itemId, level: item.level as IntakeLevel, mode: item.mode }
}

/** Owner outcomes that confirm the intake judgment, that contradict it, and that decide nothing yet. */
const POSITIVE: ReadonlySet<NotificationOutcome> = new Set(['accepted', 'reacted'])
const NEGATIVE: ReadonlySet<NotificationOutcome> = new Set(['rejected', 'expired-unhandled'])

export interface IntakeAttentionAgreementCell {
  readonly notifications: number
  readonly items: number
  readonly outcomes: Readonly<Record<NotificationOutcome, number>>
  /** accepted + reacted */
  readonly agreed: number
  /** rejected + expired-unhandled */
  readonly disagreed: number
  /** agreed / (agreed + disagreed) in ppm; null without any decided notification. */
  readonly agreementPpm: number | null
}

export interface IntakeAttentionAgreement {
  readonly protocol: typeof INTAKE_ATTENTION_AGREEMENT_PROTOCOL
  readonly causal: false
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly fromNotifiedAt: number
  readonly toNotifiedAt: number
  /** Current notification heads in the window that name a work item, at most the scan limit. */
  readonly scanned: number
  readonly truncated: boolean
  /** No WorkItems peer exposes `inspectIntakeProvenance`: every item is unresolved. */
  readonly provenanceAvailable: boolean
  /** Notifications whose item was not admitted from intake (explicit decisions, continuations). */
  readonly notIntake: number
  /** Notifications whose provenance read threw (WorkItems unavailable or intake ledger off) or was malformed. */
  readonly unresolved: number
  /** Notifications naming a work item of another owner scope; never attributed to this one. */
  readonly foreign: number
  readonly intake: IntakeAttentionAgreementCell
  readonly byLevel: Readonly<Partial<Record<IntakeLevel, IntakeAttentionAgreementCell>>>
}

class Cell {
  notifications = 0
  readonly items = new Set<string>()
  readonly outcomes = Object.fromEntries(notificationOutcomes.map(outcome => [outcome, 0])) as Record<NotificationOutcome, number>
  add(itemId: string, outcome: NotificationOutcome) {
    this.notifications += 1
    this.items.add(itemId)
    this.outcomes[outcome] += 1
  }
  freeze(): IntakeAttentionAgreementCell {
    let agreed = 0, disagreed = 0
    for (const outcome of notificationOutcomes) {
      if (POSITIVE.has(outcome)) agreed += this.outcomes[outcome]
      if (NEGATIVE.has(outcome)) disagreed += this.outcomes[outcome]
    }
    const decided = agreed + disagreed
    return Object.freeze({
      notifications: this.notifications,
      items: this.items.size,
      outcomes: Object.freeze({ ...this.outcomes }),
      agreed,
      disagreed,
      agreementPpm: decided === 0 ? null : Math.round(agreed * 1_000_000 / decided),
    })
  }
}

/**
 * Aggregate `records` (current heads, each naming a work item) by the intake
 * judgment behind its item. Provenance is read once per item; a throwing or
 * malformed answer leaves that item unresolved.
 */
export function computeIntakeAttentionAgreement(input: Readonly<{
  scope: Readonly<{ workspace: string; preset: string }>
  fromNotifiedAt: number
  toNotifiedAt: number
  records: readonly NotificationOutcomeRecord[]
  truncated: boolean
  source: IntakeProvenanceSource | undefined
}>): IntakeAttentionAgreement {
  const { scopeKey } = canonicalEvaluationScope(input.scope)
  const resolved = new Map<string, IntakeProvenance | null | 'invalid' | 'foreign'>()
  const resolve = (itemId: string) => {
    if (!resolved.has(itemId)) {
      let value: IntakeProvenance | null | 'invalid' | 'foreign' = 'invalid'
      if (input.source !== undefined) {
        try { value = provenance(input.source.inspectIntakeProvenance(itemId), itemId, scopeKey) } catch { value = 'invalid' }
      }
      resolved.set(itemId, value)
    }
    return resolved.get(itemId)!
  }
  const intake = new Cell()
  const byLevel = new Map<IntakeLevel, Cell>()
  let notIntake = 0, unresolved = 0, foreign = 0
  for (const record of input.records) {
    const itemId = record.workItemId
    if (itemId === undefined) continue
    const found = resolve(itemId)
    if (found === 'invalid') { unresolved += 1; continue }
    if (found === 'foreign') { foreign += 1; continue }
    if (found === null) { notIntake += 1; continue }
    intake.add(itemId, record.outcome)
    let cell = byLevel.get(found.level)
    if (cell === undefined) byLevel.set(found.level, cell = new Cell())
    cell.add(itemId, record.outcome)
  }
  return Object.freeze({
    protocol: INTAKE_ATTENTION_AGREEMENT_PROTOCOL,
    causal: false,
    scope: Object.freeze({ workspace: input.scope.workspace, preset: input.scope.preset }),
    fromNotifiedAt: input.fromNotifiedAt,
    toNotifiedAt: input.toNotifiedAt,
    scanned: input.records.length,
    truncated: input.truncated,
    provenanceAvailable: input.source !== undefined,
    notIntake,
    unresolved,
    foreign,
    intake: intake.freeze(),
    byLevel: Object.freeze(Object.fromEntries(LEVELS.flatMap(level => {
      const cell = byLevel.get(level)
      return cell === undefined ? [] : [[level, cell.freeze()]]
    }))),
  })
}

/**
 * WP22 E1: durable, append-only agreement snapshots.
 *
 * The persisted record is the same observational read as
 * `computeIntakeAttentionAgreement`, plus the bucket it was computed for. It is
 * never a causal claim and never an authorization input. The digest covers the
 * scope, the exact window, the fixed configuration version and all counts, but
 * not `computedAt`: repeated ticks inside one interval therefore replay the
 * same digest instead of appending duplicates. A late outcome revision that
 * changes the counts is appended as a new digest for the same window (immutable
 * history), never as an update.
 */
export const INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL = 'assistant-evaluation/intake-attention-agreement-snapshot/v1' as const
export const INTAKE_ATTENTION_AGREEMENT_HISTORY_PROTOCOL = 'assistant-evaluation/intake-attention-agreement-history/v1' as const
/** Fixed configuration generation mixed into the digest; bump only with a semantic change. */
export const INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION = 1

export interface IntakeAttentionAgreementSnapshotInput {
  readonly agreement: IntakeAttentionAgreement
  readonly computedAt: number
  /** Look-back used to select the notification window. */
  readonly windowMs: number
  /** Fixed per-call notification scan limit. */
  readonly scanLimit: number
}

export interface IntakeAttentionAgreementSnapshot {
  readonly protocol: typeof INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL
  readonly snapshotVersion: typeof INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION
  readonly causal: false
  readonly scope: Readonly<{ workspace: string; preset: string }>
  readonly fromNotifiedAt: number
  readonly toNotifiedAt: number
  readonly computedAt: number
  readonly windowMs: number
  readonly scanLimit: number
  readonly truncated: boolean
  readonly provenanceAvailable: boolean
  readonly notIntake: number
  readonly unresolved: number
  readonly foreign: number
  readonly intake: IntakeAttentionAgreementCell
  readonly byLevel: Readonly<Partial<Record<IntakeLevel, IntakeAttentionAgreementCell>>>
  /** sha256 over the immutable content below; excludes `computedAt` so a replay is stable. */
  readonly digest: string
}

export interface IntakeAttentionAgreementHistory {
  readonly protocol: typeof INTAKE_ATTENTION_AGREEMENT_HISTORY_PROTOCOL
  readonly causal: false
  readonly scope: Readonly<{ workspace: string; preset: string }>
  /** Newest first; immutable snapshots of earlier buckets are never rewritten. */
  readonly snapshots: readonly IntakeAttentionAgreementSnapshot[]
}

/** Deterministic JSON with sorted object keys; arrays keep their order. */
function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonical(item)).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

/** The immutable content covered by the snapshot digest (no observation clock, no digest). */
export type IntakeAttentionAgreementSnapshotContent = Omit<IntakeAttentionAgreementSnapshot, 'digest' | 'computedAt'>

/** Digest of one snapshot's immutable content; exported for restart validation. */
export function intakeAttentionAgreementSnapshotDigest(content: IntakeAttentionAgreementSnapshotContent): string {
  return createHash('sha256').update(canonical(content)).digest('hex')
}

/** One immutable snapshot from the current read model. */
export function createIntakeAttentionAgreementSnapshot(input: IntakeAttentionAgreementSnapshotInput): IntakeAttentionAgreementSnapshot {
  const { agreement } = input
  if (!Number.isSafeInteger(input.computedAt) || input.computedAt < 0) throw new Error('agreement snapshot computedAt is invalid')
  if (!Number.isSafeInteger(input.windowMs) || input.windowMs < 60_000) throw new Error('agreement snapshot windowMs is invalid')
  if (!Number.isSafeInteger(input.scanLimit) || input.scanLimit < 1) throw new Error('agreement snapshot scanLimit is invalid')
  const content: IntakeAttentionAgreementSnapshotContent = {
    protocol: INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_PROTOCOL,
    snapshotVersion: INTAKE_ATTENTION_AGREEMENT_SNAPSHOT_VERSION,
    causal: false as const,
    scope: agreement.scope,
    fromNotifiedAt: agreement.fromNotifiedAt,
    toNotifiedAt: agreement.toNotifiedAt,
    windowMs: input.windowMs,
    scanLimit: input.scanLimit,
    truncated: agreement.truncated,
    provenanceAvailable: agreement.provenanceAvailable,
    notIntake: agreement.notIntake,
    unresolved: agreement.unresolved,
    foreign: agreement.foreign,
    intake: agreement.intake,
    byLevel: agreement.byLevel,
  }
  return Object.freeze({
    ...content,
    computedAt: input.computedAt,
    digest: intakeAttentionAgreementSnapshotDigest(content),
  })
}
