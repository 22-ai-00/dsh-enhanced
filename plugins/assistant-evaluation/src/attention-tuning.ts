import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { canonicalEvaluationScope, EvaluationStoreError } from './store.js'
import type { EvaluationScope, NotificationOutcome } from './types.js'

/**
 * WP22 slice 2: bounded, tighten-only attention tuning with exact-version
 * cohort rollback. A cohort is one notification `(lane, sourceId)` inside one
 * Evaluation scope. Versions are immutable and bound to their exact parent;
 * loosening is never adopted here (it requires a future holdout replay).
 */
export const ATTENTION_TUNING_PROTOCOL = 'assistant-evaluation/attention-tuning/v1' as const

export interface AttentionCohort { readonly lane: string; readonly sourceId: string }

/** Overlay deltas on a consumer's own profile. Every field only ever makes notifications rarer. */
export interface AttentionTuningParameters {
  /** Added to the profile's interruption cost (lowers utility). */
  readonly interruptionCostDelta: number
  /** Added to the profile's minimum utility threshold. */
  readonly minimumUtilityDelta: number
  /** Minutes added on both sides of an existing quiet window. */
  readonly quietExtensionMinutes: number
  /** Disables the noisy rule for this cohort entirely. */
  readonly muted: boolean
}

export type AttentionTuningNumericParameter = 'interruptionCostDelta' | 'minimumUtilityDelta' | 'quietExtensionMinutes'
export type AttentionTuningParameter = AttentionTuningNumericParameter | 'muted'

/** Fixed code constants; neither configuration nor a request can widen them. */
export const attentionTuningBounds: Readonly<Record<AttentionTuningNumericParameter, Readonly<{ min: number; max: number; step: number }>>> = Object.freeze({
  interruptionCostDelta: Object.freeze({ min: 0, max: 100, step: 10 }),
  minimumUtilityDelta: Object.freeze({ min: 0, max: 100, step: 10 }),
  quietExtensionMinutes: Object.freeze({ min: 0, max: 120, step: 30 }),
})

/** Fixed single-step order: cheapest reversible lever first, mute last. */
export const attentionTuningOrder: readonly AttentionTuningParameter[] = Object.freeze(['interruptionCostDelta', 'minimumUtilityDelta', 'quietExtensionMinutes', 'muted'])

export const defaultAttentionTuningParameters: AttentionTuningParameters = Object.freeze({
  interruptionCostDelta: 0, minimumUtilityDelta: 0, quietExtensionMinutes: 0, muted: false,
})

export interface AttentionCohortStats {
  readonly fromNotifiedAt: number
  readonly toNotifiedAt: number
  readonly total: number
  readonly accepted: number
  readonly reacted: number
  readonly rejected: number
  readonly expiredUnhandled: number
  /** accepted + reacted + rejected + expired-unhandled; pending/delivered/failed are undecided. */
  readonly decided: number
  /** rejected + expired-unhandled. */
  readonly negative: number
}

export interface AttentionTuningPolicy {
  readonly minSample: number
  readonly negativeRatePpm: number
  readonly muteRatePpm: number
  readonly regressionMarginPpm: number
}

export interface AttentionTuningChange {
  readonly parameter: AttentionTuningParameter
  readonly from: number | boolean
  readonly to: number | boolean
}

export type AttentionTuningProposal =
  | Readonly<{ kind: 'tighten'; change: AttentionTuningChange; parameters: AttentionTuningParameters }>
  | Readonly<{ kind: 'no-op'; reason: 'insufficient-sample' | 'below-threshold' | 'at-bound' }>

export type AttentionTuningRequestRejection =
  | 'loosening-requires-holdout'
  | 'out-of-bounds'
  | 'no-change'
  | 'not-single-step'
  | 'auto-adoption-disabled'
  | 'observation-in-progress'

export interface AttentionTuningVersion {
  readonly protocol: typeof ATTENTION_TUNING_PROTOCOL
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  readonly version: number
  readonly parentVersion: number
  readonly parentDigest: string | null
  readonly parameters: AttentionTuningParameters
  readonly basis: Readonly<{ stats: AttentionCohortStats; scopeWatermark: number }>
  readonly change: AttentionTuningChange
  readonly origin: 'auto' | 'request'
  readonly digest: string
  readonly createdAt: number
}

export interface AttentionTuningCurrent {
  readonly scopeKey: string
  readonly cohort: AttentionCohort
  /** 0 is the built-in default (no overlay). */
  readonly version: number
  readonly digest: string | null
  readonly parameters: AttentionTuningParameters
  /** `parent-fallback`/`default` mean the active version was unreadable or failed digest verification. */
  readonly source: 'active' | 'parent-fallback' | 'default'
}

export interface AttentionTuningEvent {
  readonly sequence: number
  readonly kind: 'adopted' | 'rolled-back' | 'settled' | 'request-rejected'
  readonly fromVersion: number
  readonly toVersion: number
  readonly reason: string
  readonly detail: Readonly<Record<string, unknown>>
  readonly occurredAt: number
}

export interface AttentionTuningStatus {
  readonly current: AttentionTuningCurrent
  readonly state: 'idle' | 'observing'
  readonly observeFrom?: number
  readonly observeUntil?: number
  readonly versions: readonly AttentionTuningVersion[]
  readonly events: readonly AttentionTuningEvent[]
}

export type AttentionTuningTickAction =
  | Readonly<{ action: 'adopted'; version: number; change: AttentionTuningChange }>
  | Readonly<{ action: 'rolled-back'; fromVersion: number; toVersion: number }>
  | Readonly<{ action: 'settled'; version: number }>
  | Readonly<{ action: 'observing'; version: number }>
  | Readonly<{ action: 'no-op'; reason: 'insufficient-sample' | 'below-threshold' | 'at-bound' }>

export type AttentionTuningRequestResult =
  | Readonly<{ status: 'adopted'; version: number; change: AttentionTuningChange }>
  | Readonly<{ status: 'rejected'; reason: AttentionTuningRequestRejection }>

function invalid(message: string): never {
  throw new EvaluationStoreError('invalid-input', `attention tuning: ${message}`)
}

function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
    .map(key => `${JSON.stringify(key)}:${stable(record[key])}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stable(value)).digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry)
    Object.freeze(value)
  }
  return value
}

function identifier(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.trim() !== value || /\p{Cc}/u.test(value)) {
    invalid(`${label} must be a bounded identifier`)
  }
  return value
}

export function normalizeAttentionCohort(input: unknown): AttentionCohort {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('cohort must be an object')
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'lane' && key !== 'sourceId')) invalid('cohort has unknown fields')
  return Object.freeze({ lane: identifier(record.lane, 'cohort.lane', 64), sourceId: identifier(record.sourceId, 'cohort.sourceId', 256) })
}

/** Strict shape check only; bounds and step alignment are judged separately so a request can be recorded. */
export function normalizeAttentionTuningParameters(input: unknown): AttentionTuningParameters {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid('parameters must be an object')
  const record = input as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (stable(keys) !== stable([...attentionTuningOrder].sort())) invalid('parameters must name exactly the tunable fields')
  for (const key of ['interruptionCostDelta', 'minimumUtilityDelta', 'quietExtensionMinutes'] as const) {
    if (!Number.isSafeInteger(record[key])) invalid(`${key} must be an integer`)
  }
  if (typeof record.muted !== 'boolean') invalid('muted must be a boolean')
  return Object.freeze({
    interruptionCostDelta: record.interruptionCostDelta as number,
    minimumUtilityDelta: record.minimumUtilityDelta as number,
    quietExtensionMinutes: record.quietExtensionMinutes as number,
    muted: record.muted as boolean,
  })
}

/** Clamp every numeric field into its fixed bound (snapped down to the step grid). */
export function clampAttentionTuning(input: AttentionTuningParameters): AttentionTuningParameters {
  const clamp = (key: AttentionTuningNumericParameter): number => {
    const { min, max, step } = attentionTuningBounds[key]
    const value = Math.min(max, Math.max(min, Math.trunc(input[key])))
    return min + Math.floor((value - min) / step) * step
  }
  return Object.freeze({
    interruptionCostDelta: clamp('interruptionCostDelta'),
    minimumUtilityDelta: clamp('minimumUtilityDelta'),
    quietExtensionMinutes: clamp('quietExtensionMinutes'),
    muted: input.muted === true,
  })
}

export function withinAttentionTuningBounds(input: AttentionTuningParameters): boolean {
  return stable(clampAttentionTuning(input)) === stable(input)
}

/** True when any field would make notifications more frequent than `current`. */
export function isAttentionLoosening(current: AttentionTuningParameters, next: AttentionTuningParameters): boolean {
  return next.interruptionCostDelta < current.interruptionCostDelta
    || next.minimumUtilityDelta < current.minimumUtilityDelta
    || next.quietExtensionMinutes < current.quietExtensionMinutes
    || (current.muted && !next.muted)
}

function atLeastRate(numerator: number, denominator: number, ratePpm: number): boolean {
  return BigInt(numerator) * 1_000_000n >= BigInt(ratePpm) * BigInt(denominator)
}

/**
 * Pure tighten-only tuner. With at least `minSample` decided notifications and
 * a negative (rejected + expired-unhandled) rate at or above the threshold, it
 * proposes exactly one step on the first non-maxed parameter in fixed order;
 * mute additionally requires `muteRatePpm`. Never proposes loosening.
 */
export function proposeAttentionTuning(currentInput: AttentionTuningParameters, stats: AttentionCohortStats, policy: AttentionTuningPolicy): AttentionTuningProposal {
  const current = clampAttentionTuning(currentInput)
  if (stats.decided < policy.minSample || stats.decided === 0) return deepFreeze({ kind: 'no-op', reason: 'insufficient-sample' })
  if (!atLeastRate(stats.negative, stats.decided, policy.negativeRatePpm)) return deepFreeze({ kind: 'no-op', reason: 'below-threshold' })
  for (const parameter of attentionTuningOrder) {
    if (parameter === 'muted') {
      if (current.muted || !atLeastRate(stats.negative, stats.decided, policy.muteRatePpm)) continue
      return deepFreeze({ kind: 'tighten', change: { parameter, from: false, to: true }, parameters: { ...current, muted: true } })
    }
    const { max, step } = attentionTuningBounds[parameter]
    if (current[parameter] >= max) continue
    const to = Math.min(max, current[parameter] + step)
    return deepFreeze({ kind: 'tighten', change: { parameter, from: current[parameter], to }, parameters: { ...current, [parameter]: to } })
  }
  return deepFreeze({ kind: 'no-op', reason: 'at-bound' })
}

/**
 * Regression test for an observing version: the post-adoption negative rate
 * must exceed the basis (parent-era) rate by more than the margin. Cross
 * multiplication keeps it exact; acceptances only lower the rate, so positive
 * evidence can never satisfy it.
 */
export function attentionRegressed(basis: AttentionCohortStats, post: AttentionCohortStats, policy: AttentionTuningPolicy): boolean {
  if (post.decided < policy.minSample || post.decided === 0 || basis.decided === 0) return false
  const left = BigInt(post.negative) * BigInt(basis.decided) * 1_000_000n
  const right = BigInt(basis.negative) * BigInt(post.decided) * 1_000_000n + BigInt(policy.regressionMarginPpm) * BigInt(basis.decided) * BigInt(post.decided)
  return left > right
}

/** Single-step tightening check for an explicit request. */
function singleStep(current: AttentionTuningParameters, next: AttentionTuningParameters): AttentionTuningChange | undefined {
  const changed = attentionTuningOrder.filter(key => current[key] !== next[key])
  if (changed.length !== 1) return undefined
  const parameter = changed[0]!
  if (parameter === 'muted') return { parameter, from: current.muted, to: next.muted }
  if (next[parameter] - current[parameter] !== attentionTuningBounds[parameter].step) return undefined
  return { parameter, from: current[parameter], to: next[parameter] }
}

interface VersionRow {
  scope_key: string; lane: string; source_id: string; version: number; parent_version: number
  parameters_json: string; basis_json: string; change_json: string; origin: 'auto' | 'request'; digest: string; created_at: number
}

interface HeadRow {
  scope_key: string; lane: string; source_id: string; workspace: string; preset: string
  active_version: number; latest_version: number; state: 'idle' | 'observing'
  observing_version: number | null; observe_from: number | null; observe_until: number | null; changed_at: number
}

interface EventRow {
  sequence: number; kind: AttentionTuningEvent['kind']; from_version: number; to_version: number
  reason: string; detail_json: string; occurred_at: number
}

function versionDigest(input: Omit<AttentionTuningVersion, 'digest' | 'createdAt'>): string {
  return sha256({
    protocol: input.protocol, scopeKey: input.scopeKey, cohort: input.cohort, version: input.version,
    parentVersion: input.parentVersion, parentDigest: input.parentDigest, parameters: input.parameters,
    basis: input.basis, change: input.change, origin: input.origin,
  })
}

const negativeOutcomes: readonly NotificationOutcome[] = ['rejected', 'expired-unhandled']

/**
 * Durable ledger over the same Evaluation database as the notification canon.
 * All decisions recompute inside BEGIN IMMEDIATE so concurrent ticks or a
 * restart mid-observation converge on one head.
 */
export class AttentionTuningLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(database: DatabaseSync, now: () => number) {
    this.#database = database
    this.#now = now
  }

  #transaction<T>(fn: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  /** Current-head outcome counts for one cohort, notified in [from, to). */
  stats(scopeKey: string, cohort: AttentionCohort, fromNotifiedAt: number, toNotifiedAt: number): AttentionCohortStats {
    const rows = this.#database.prepare(`SELECT h.outcome AS outcome, COUNT(*) AS count
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE h.scope_key=? AND h.occurred_at>=? AND h.occurred_at<?
        AND json_extract(r.record_json, '$.lane')=? AND json_extract(r.record_json, '$.sourceId')=?
      GROUP BY h.outcome`).all(scopeKey, fromNotifiedAt, toNotifiedAt, cohort.lane, cohort.sourceId) as { outcome: NotificationOutcome; count: number }[]
    const count = (outcome: NotificationOutcome): number => rows.find(row => row.outcome === outcome)?.count ?? 0
    const accepted = count('accepted')
    const reacted = count('reacted')
    const rejected = count('rejected')
    const expiredUnhandled = count('expired-unhandled')
    return Object.freeze({
      fromNotifiedAt, toNotifiedAt,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      accepted, reacted, rejected, expiredUnhandled,
      decided: accepted + reacted + rejected + expiredUnhandled,
      negative: negativeOutcomes.reduce((sum, outcome) => sum + count(outcome), 0),
    })
  }

  /** Scopes that have at least one notification in the cohort, plus scopes with a tuning head. */
  scopes(cohort: AttentionCohort): readonly EvaluationScope[] {
    const rows = this.#database.prepare(`SELECT DISTINCT json_extract(r.record_json, '$.scope.workspace') AS workspace,
        json_extract(r.record_json, '$.scope.preset') AS preset
      FROM evaluation_notification_outcome_heads h
      JOIN evaluation_notification_outcome_revisions r ON r.notification_id=h.notification_id AND r.version=h.version
      WHERE json_extract(r.record_json, '$.lane')=? AND json_extract(r.record_json, '$.sourceId')=?
      UNION SELECT workspace, preset FROM evaluation_attention_tuning_heads WHERE lane=? AND source_id=?
      ORDER BY workspace, preset`).all(cohort.lane, cohort.sourceId, cohort.lane, cohort.sourceId) as { workspace: string; preset: string }[]
    return Object.freeze(rows.map(row => Object.freeze({ workspace: row.workspace, preset: row.preset })))
  }

  #scopeWatermark(scopeKey: string): number {
    return (this.#database.prepare('SELECT watermark FROM evaluation_notification_watermarks WHERE scope_key=?')
      .get(scopeKey) as { watermark: number } | undefined)?.watermark ?? 0
  }

  #head(scopeKey: string, cohort: AttentionCohort): HeadRow | undefined {
    return this.#database.prepare('SELECT * FROM evaluation_attention_tuning_heads WHERE scope_key=? AND lane=? AND source_id=?')
      .get(scopeKey, cohort.lane, cohort.sourceId) as unknown as HeadRow | undefined
  }

  #row(scopeKey: string, cohort: AttentionCohort, version: number): VersionRow | undefined {
    return this.#database.prepare('SELECT * FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
      .get(scopeKey, cohort.lane, cohort.sourceId, version) as unknown as VersionRow | undefined
  }

  /** Parse and digest-verify one stored version; undefined when unreadable or tampered. */
  #verified(scopeKey: string, cohort: AttentionCohort, version: number): AttentionTuningVersion | undefined {
    const row = this.#row(scopeKey, cohort, version)
    if (row === undefined) return undefined
    try {
      const parentDigest = row.parent_version === 0 ? null : this.#row(scopeKey, cohort, row.parent_version)?.digest ?? null
      if (row.parent_version !== 0 && parentDigest === null) return undefined
      const parameters = normalizeAttentionTuningParameters(JSON.parse(row.parameters_json))
      if (!withinAttentionTuningBounds(parameters)) return undefined
      const body = {
        protocol: ATTENTION_TUNING_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, version: row.version,
        parentVersion: row.parent_version, parentDigest, parameters,
        basis: JSON.parse(row.basis_json) as AttentionTuningVersion['basis'],
        change: JSON.parse(row.change_json) as AttentionTuningChange, origin: row.origin,
      }
      if (versionDigest(body) !== row.digest) return undefined
      return deepFreeze({ ...body, digest: row.digest, createdAt: row.created_at })
    } catch {
      return undefined
    }
  }

  #versionNumbers(scopeKey: string, cohort: AttentionCohort): readonly number[] {
    return (this.#database.prepare('SELECT version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? ORDER BY version')
      .all(scopeKey, cohort.lane, cohort.sourceId) as { version: number }[]).map(row => row.version)
  }

  /**
   * Active parameters for a consumer. A version that cannot be read or fails
   * digest verification falls back along its recorded parent chain, then to
   * the built-in default; a consumer never sees an unverified overlay.
   */
  current(scopeInput: EvaluationScope, cohortInput: AttentionCohort): AttentionTuningCurrent {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    return this.#current(scopeKey, cohort)
  }

  #current(scopeKey: string, cohort: AttentionCohort): AttentionTuningCurrent {
    const active = this.#head(scopeKey, cohort)?.active_version ?? 0
    let version = active
    let fallback = false
    const seen = new Set<number>()
    while (version > 0 && !seen.has(version)) {
      seen.add(version)
      const verified = this.#verified(scopeKey, cohort, version)
      if (verified !== undefined) {
        return deepFreeze({ scopeKey, cohort: { ...cohort }, version, digest: verified.digest, parameters: { ...verified.parameters }, source: fallback ? 'parent-fallback' : 'active' })
      }
      fallback = true
      const parent = (this.#database.prepare('SELECT parent_version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
        .get(scopeKey, cohort.lane, cohort.sourceId, version) as { parent_version: unknown } | undefined)?.parent_version
      version = Number.isSafeInteger(parent) && (parent as number) >= 0 && (parent as number) < version ? parent as number : 0
    }
    return deepFreeze({ scopeKey, cohort: { ...cohort }, version: 0, digest: null, parameters: { ...defaultAttentionTuningParameters }, source: active === 0 ? 'active' : 'default' })
  }

  status(scopeInput: EvaluationScope, cohortInput: AttentionCohort, eventLimit = 50): AttentionTuningStatus {
    const { scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const head = this.#head(scopeKey, cohort)
    const versions = this.#versionNumbers(scopeKey, cohort)
      .map(version => this.#verified(scopeKey, cohort, version)).filter(value => value !== undefined)
    const events = (this.#database.prepare(`SELECT sequence, kind, from_version, to_version, reason, detail_json, occurred_at
      FROM evaluation_attention_tuning_events WHERE scope_key=? AND lane=? AND source_id=? ORDER BY sequence DESC LIMIT ?`)
      .all(scopeKey, cohort.lane, cohort.sourceId, eventLimit) as unknown as EventRow[]).reverse().map(row => ({
      sequence: row.sequence, kind: row.kind, fromVersion: row.from_version, toVersion: row.to_version,
      reason: row.reason, detail: JSON.parse(row.detail_json) as Record<string, unknown>, occurredAt: row.occurred_at,
    }))
    return deepFreeze({
      current: this.#current(scopeKey, cohort),
      state: head?.state ?? 'idle',
      ...(head?.observe_from == null ? {} : { observeFrom: head.observe_from }),
      ...(head?.observe_until == null ? {} : { observeUntil: head.observe_until }),
      versions, events,
    })
  }

  #event(scopeKey: string, cohort: AttentionCohort, kind: AttentionTuningEvent['kind'], fromVersion: number, toVersion: number,
    reason: string, detail: Record<string, unknown>, idempotencyKey: string | null, now: number): void {
    this.#database.prepare(`INSERT INTO evaluation_attention_tuning_events
      (scope_key, lane, source_id, kind, from_version, to_version, reason, detail_json, idempotency_key, occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(idempotency_key) DO NOTHING`)
      .run(scopeKey, cohort.lane, cohort.sourceId, kind, fromVersion, toVersion, reason, stable(detail), idempotencyKey, now)
  }

  #adopt(scope: EvaluationScope, scopeKey: string, cohort: AttentionCohort, head: HeadRow | undefined, current: AttentionTuningCurrent,
    proposal: Extract<AttentionTuningProposal, { kind: 'tighten' }>, stats: AttentionCohortStats, origin: 'auto' | 'request',
    observationMs: number, now: number): number {
    // Parent is the verified version the consumer is actually running.
    const parentVersion = current.version
    const scopeWatermark = this.#scopeWatermark(scopeKey)
    const idempotencyKey = `adopt:${sha256([scopeKey, cohort.lane, cohort.sourceId, parentVersion, current.digest, scopeWatermark, proposal.change, origin])}`
    const existing = this.#database.prepare('SELECT version FROM evaluation_attention_tuning_versions WHERE idempotency_key=?')
      .get(idempotencyKey) as { version: number } | undefined
    if (existing !== undefined) return existing.version
    const version = (head?.latest_version ?? 0) + 1
    const body = {
      protocol: ATTENTION_TUNING_PROTOCOL, scopeKey, cohort: { lane: cohort.lane, sourceId: cohort.sourceId }, version,
      parentVersion, parentDigest: current.digest, parameters: proposal.parameters,
      basis: { stats, scopeWatermark }, change: proposal.change, origin,
    }
    const digest = versionDigest(body)
    this.#database.prepare(`INSERT INTO evaluation_attention_tuning_versions
      (scope_key, lane, source_id, version, parent_version, parameters_json, basis_json, change_json, origin, digest, idempotency_key, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(scopeKey, cohort.lane, cohort.sourceId, version, parentVersion,
      stable(body.parameters), stable(body.basis), stable(body.change), origin, digest, idempotencyKey, now)
    const observeUntil = now + observationMs
    if (head === undefined) {
      this.#database.prepare(`INSERT INTO evaluation_attention_tuning_heads
        (scope_key, lane, source_id, workspace, preset, active_version, latest_version, state, observing_version, observe_from, observe_until, changed_at)
        VALUES (?,?,?,?,?,?,?, 'observing', ?,?,?,?)`).run(scopeKey, cohort.lane, cohort.sourceId, scope.workspace, scope.preset,
        version, version, version, now, observeUntil, now)
    } else {
      this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET active_version=?, latest_version=?, state='observing',
        observing_version=?, observe_from=?, observe_until=?, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
        .run(version, version, version, now, observeUntil, now, scopeKey, cohort.lane, cohort.sourceId)
    }
    this.#event(scopeKey, cohort, 'adopted', parentVersion, version, origin === 'auto' ? 'negative-rate-threshold' : 'owner-request',
      { digest, change: proposal.change, stats, scopeWatermark }, idempotencyKey, now)
    return version
  }

  /**
   * One deterministic step for one cohort: monitor an observing version
   * (rollback to its exact parent on regression, settle at window end), or
   * when idle propose and adopt a single bounded tightening step.
   */
  tick(scopeInput: EvaluationScope, cohortInput: AttentionCohort, policy: AttentionTuningPolicy,
    options: Readonly<{ observationMs: number; evaluationWindowMs: number }>): AttentionTuningTickAction {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    return this.#transaction(() => {
      const now = this.#now()
      const head = this.#head(scopeKey, cohort)
      if (head?.state === 'observing') {
        const observed = head.observing_version!
        const version = this.#verified(scopeKey, cohort, observed)
        const post = this.stats(scopeKey, cohort, head.observe_from!, now + 1)
        // An unverifiable observing version is reverted exactly like a regression.
        if (version === undefined || attentionRegressed(version.basis.stats, post, policy)) {
          const parent = (this.#database.prepare('SELECT parent_version FROM evaluation_attention_tuning_versions WHERE scope_key=? AND lane=? AND source_id=? AND version=?')
            .get(scopeKey, cohort.lane, cohort.sourceId, observed) as { parent_version: number } | undefined)?.parent_version ?? 0
          this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET active_version=?, state='idle', observing_version=NULL,
            observe_from=NULL, observe_until=NULL, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
            .run(parent, now, scopeKey, cohort.lane, cohort.sourceId)
          this.#event(scopeKey, cohort, 'rolled-back', observed, parent, version === undefined ? 'version-unverifiable' : 'negative-rate-regressed',
            { basis: version?.basis.stats ?? null, post }, `rollback:${sha256([scopeKey, cohort.lane, cohort.sourceId, observed, parent])}`, now)
          return Object.freeze({ action: 'rolled-back' as const, fromVersion: observed, toVersion: parent })
        }
        if (now >= head.observe_until!) {
          this.#database.prepare(`UPDATE evaluation_attention_tuning_heads SET state='idle', observing_version=NULL,
            observe_from=NULL, observe_until=NULL, changed_at=? WHERE scope_key=? AND lane=? AND source_id=?`)
            .run(now, scopeKey, cohort.lane, cohort.sourceId)
          this.#event(scopeKey, cohort, 'settled', observed, observed, 'observation-complete', { post },
            `settle:${sha256([scopeKey, cohort.lane, cohort.sourceId, observed, head.observe_from])}`, now)
          return Object.freeze({ action: 'settled' as const, version: observed })
        }
        return Object.freeze({ action: 'observing' as const, version: observed })
      }
      const current = this.#current(scopeKey, cohort)
      // Evidence is only counted since the last change, so an adopted or
      // rolled-back version is never re-judged on its predecessor's sample.
      const from = Math.max(0, head?.changed_at ?? 0, now - options.evaluationWindowMs)
      const stats = this.stats(scopeKey, cohort, from, now + 1)
      const proposal = proposeAttentionTuning(current.parameters, stats, policy)
      if (proposal.kind === 'no-op') return Object.freeze({ action: 'no-op' as const, reason: proposal.reason })
      const version = this.#adopt(scope, scopeKey, cohort, head, current, proposal, stats, 'auto', options.observationMs, now)
      return Object.freeze({ action: 'adopted' as const, version, change: proposal.change })
    })
  }

  /**
   * Explicit parameter request. Any loosening field is rejected with
   * `loosening-requires-holdout` and recorded; so is every other rejection.
   * A single in-bounds tightening step is adopted with an observation window.
   */
  request(scopeInput: EvaluationScope, cohortInput: AttentionCohort, parametersInput: unknown,
    options: Readonly<{ enabled: boolean; observationMs: number; evaluationWindowMs: number }>): AttentionTuningRequestResult {
    const { scope, scopeKey } = canonicalEvaluationScope(scopeInput)
    const cohort = normalizeAttentionCohort(cohortInput)
    const requested = normalizeAttentionTuningParameters(parametersInput)
    return this.#transaction(() => {
      const now = this.#now()
      const head = this.#head(scopeKey, cohort)
      const current = this.#current(scopeKey, cohort)
      const change = singleStep(current.parameters, requested)
      const reason: AttentionTuningRequestRejection | undefined = isAttentionLoosening(current.parameters, requested) ? 'loosening-requires-holdout'
        : !withinAttentionTuningBounds(requested) ? 'out-of-bounds'
          : stable(requested) === stable(current.parameters) ? 'no-change'
            : change === undefined ? 'not-single-step'
              : !options.enabled ? 'auto-adoption-disabled'
                : head?.state === 'observing' ? 'observation-in-progress'
                  : undefined
      if (reason !== undefined || change === undefined) {
        const code = reason ?? 'not-single-step'
        this.#event(scopeKey, cohort, 'request-rejected', current.version, current.version, code,
          { current: current.parameters, requested }, null, now)
        return Object.freeze({ status: 'rejected' as const, reason: code })
      }
      const stats = this.stats(scopeKey, cohort, Math.max(0, head?.changed_at ?? 0, now - options.evaluationWindowMs), now + 1)
      const version = this.#adopt(scope, scopeKey, cohort, head, current, { kind: 'tighten', change, parameters: requested }, stats,
        'request', options.observationMs, now)
      return deepFreeze({ status: 'adopted' as const, version, change })
    })
  }

  counts(): Readonly<{ versions: number; events: number }> {
    const versions = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_attention_tuning_versions').get() as { count: number }
    const events = this.#database.prepare('SELECT COUNT(*) AS count FROM evaluation_attention_tuning_events').get() as { count: number }
    return { versions: versions.count, events: events.count }
  }
}
