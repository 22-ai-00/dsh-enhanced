import { closeSync, constants, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { reminderContentDigest, type ReminderContent } from './reminder.js'
import { attentionOverlay, tuneProfile, type AttentionOverlay } from './attention-tuning.js'
import type { ProactiveGoalLifecycleReason, ProactiveGoalSourceLink } from './goal-lifecycle.js'
import type {
  OpportunityDecision,
  OpportunityEvaluation,
  OpportunityInput,
  OpportunityProfile,
  OpportunityScope,
  ProactiveDynamicSignals,
  ProactiveDynamicUtilityBreakdown,
  ProactiveOpportunityFilter,
  ProactiveRuntimeContext,
} from './types.js'

export const RECENT_NOTIFICATION_WINDOW_MS = 3_600_000
export const URGENCY_WINDOW_MS = 900_000
export const ACTIVE_IDLE_THRESHOLD_MS = 60_000
export const IDLE_DISCOUNT_START_MS = 600_000
export const IDLE_DISCOUNT_FULL_MS = 3_600_000
export const MAX_ACTIVITY_PENALTY = 15
export const MAX_IDLE_DISCOUNT = 10
export const PENALTY_PER_RECENT_NOTIFICATION = 5
export const MAX_FREQUENCY_PENALTY = 40
export const MAX_URGENCY_BONUS = 20
export const MAX_ACCEPTANCE_BONUS = 15
export const MAX_ACCEPTANCE_PENALTY = 20
const DEFAULT_EXPLICIT_ACCEPTANCE_SAMPLES = 10

const RUNTIME_CONTEXT_KEYS = [
  'userActive',
  'idleDurationMs',
  'recentNotificationCount',
  'urgencyPpm',
  'acceptanceRatePpm',
  'acceptanceSamples',
] as const
const DYNAMIC_SIGNAL_KEYS = [
  ...RUNTIME_CONTEXT_KEYS,
  'remainingTtlMs',
  'acceptedCount',
  'rejectedCount',
  'overlayInterruptionCostDelta',
] as const

const max = 1_000_000_000
const integer = (value: unknown, limit = max): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\s\p{Cc}]/u.test(value)
const content = (value: unknown, limit = 65_536): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\p{Cc}]/u.test(value.replace(/[\r\n]/gu, ''))
const freeze = <T>(value: T): Readonly<T> => Object.freeze(JSON.parse(JSON.stringify(value)) as T)
function fail(message = 'assistant-proactive: invalid opportunity input'): never { throw new Error(message) }

export function privatePath(path: string): void {
  if (!isAbsolute(path)) fail('assistant-proactive: databasePath must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path)); if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0) fail('assistant-proactive: unsafe database directory')
  try { lstatSync(path) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); chmodSync(path, 0o600)
  }
  for (const item of [path, `${path}-wal`, `${path}-shm`]) {
    try { const stat = lstatSync(item); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('assistant-proactive: unsafe database file') } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

export function validateProfile(input: OpportunityProfile): Readonly<OpportunityProfile> {
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['preparation', 'id', 'mode', 'expectedBenefit', 'successPpm', 'executionCost', 'interruptionCost', 'possibleLoss', 'minimumUtility', 'mergeWindowMs', 'cooldownMs', 'rejectionCooldownMs', 'quietHours', 'maxDecisionsPerGoal', 'maxExecutionsPerGoal', 'maxRemindersPerGoal'].includes(key))
    || !text(input.id) || !['prepare', 'remind', 'execute'].includes(input.mode) || input.successPpm > 1_000_000
    || ![input.expectedBenefit, input.successPpm, input.executionCost, input.interruptionCost, input.possibleLoss, input.minimumUtility, input.mergeWindowMs, input.cooldownMs, input.rejectionCooldownMs, input.maxDecisionsPerGoal, input.maxExecutionsPerGoal, input.maxRemindersPerGoal].every(value => integer(value))) fail('assistant-proactive: invalid profile')
  if (input.quietHours !== undefined) {
    const quiet = input.quietHours
    if (!quiet || typeof quiet !== 'object' || Object.keys(quiet).length !== 3 || typeof quiet.timezone !== 'string' || quiet.timezone.length > 128 || !integer(quiet.startMinute, 1439) || !integer(quiet.endMinute, 1439) || quiet.startMinute === quiet.endMinute) fail('assistant-proactive: invalid quiet hours')
    try { Intl.DateTimeFormat('en-US', { timeZone: quiet.timezone }).format() } catch { fail('assistant-proactive: invalid quiet hours') }
  }
  if (input.preparation !== undefined) {
    const p = input.preparation
    if (input.mode !== 'prepare' || !p || typeof p !== 'object' || Object.keys(p).length !== 5
      || ![p.provider, p.model, p.budgetId].every(value => text(value, 512))
      || !integer(p.maxOutputTokens, 32_768) || p.maxOutputTokens < 1
      || !integer(p.timeoutMs, 300_000) || p.timeoutMs < 1_000) fail('assistant-proactive: invalid preparation settings')
  }
  // BigInt makes the product exact before the bounded public number conversion.
  const utility = BigInt(input.expectedBenefit) * BigInt(input.successPpm) / 1_000_000n - BigInt(input.executionCost) - BigInt(input.interruptionCost) - BigInt(input.possibleLoss)
  if (utility < BigInt(-Number.MAX_SAFE_INTEGER) || utility > BigInt(Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: unsafe utility')
  return freeze({ ...input, ...(input.quietHours === undefined ? {} : { quietHours: { ...input.quietHours } }) })
}

function scopeKey(scope: OpportunityScope): string {
  if (!scope || typeof scope !== 'object' || Object.keys(scope).length !== 5 || ![scope.principalId, scope.principalRecordId, scope.preset].every(item => text(item, 4096)) || !content(scope.workspace, 4096) || !integer(scope.principalVersion) || scope.principalVersion < 1 || !scope.workspace.startsWith('/')) fail()
  return JSON.stringify({ principalId: scope.principalId, principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion, workspace: scope.workspace, preset: scope.preset })
}
function validateInput(input: OpportunityInput): void {
  if (!input || typeof input !== 'object' || ![input.waitId, input.profileId, input.goalId, input.sessionId, input.definitionDigest, input.nativeGoalId, input.ownerRouteId, input.sourceDigest, input.sourceId, input.event.id, input.event.digest].every(value => text(value)) || !content(input.objective)
    || input.event.observationDigest !== undefined && (typeof input.event.observationDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(input.event.observationDigest))
    || !integer(input.nativeRevision) || !integer(input.event.sequence) || !integer(input.event.occurredAt, Number.MAX_SAFE_INTEGER) || !integer(input.expiresAt, Number.MAX_SAFE_INTEGER)) fail()
  scopeKey(input.scope)
}
function reminderContent(input: OpportunityInput): ReminderContent & Pick<OpportunityDecision, 'goalId'> {
  return { goalId: input.goalId, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision,
    sourceId: input.sourceId, sourceDigest: input.sourceDigest, eventDigest: input.event.digest, eventObservationDigest: input.event.observationDigest }
}
function plainRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(message)
  const proto = Object.getPrototypeOf(value) as unknown
  if (proto !== Object.prototype && proto !== null) fail(message)
  if (Object.getOwnPropertySymbols(value).length !== 0) fail(message)
  return value as Record<string, unknown>
}

export function validateRuntimeContext(context: unknown): Readonly<ProactiveRuntimeContext> | undefined {
  if (context === undefined) return undefined
  const record = plainRecord(context, 'assistant-proactive: invalid runtime context')
  for (const key of Object.keys(record)) {
    if (!(RUNTIME_CONTEXT_KEYS as readonly string[]).includes(key)) fail('assistant-proactive: invalid runtime context')
  }
  const normalized: {
    userActive?: boolean
    idleDurationMs?: number
    recentNotificationCount?: number
    urgencyPpm?: number
    acceptanceRatePpm?: number
    acceptanceSamples?: number
  } = {}
  if (record['userActive'] !== undefined) {
    if (typeof record['userActive'] !== 'boolean') fail('assistant-proactive: invalid runtime context')
    normalized.userActive = record['userActive']
  }
  if (record['idleDurationMs'] !== undefined) {
    if (!integer(record['idleDurationMs'], Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid runtime context')
    normalized.idleDurationMs = record['idleDurationMs']
  }
  if (record['recentNotificationCount'] !== undefined) {
    if (!integer(record['recentNotificationCount'], Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid runtime context')
    normalized.recentNotificationCount = record['recentNotificationCount']
  }
  if (record['urgencyPpm'] !== undefined) {
    if (!integer(record['urgencyPpm'], 1_000_000)) fail('assistant-proactive: invalid runtime context')
    normalized.urgencyPpm = record['urgencyPpm']
  }
  if (record['acceptanceRatePpm'] !== undefined) {
    if (!integer(record['acceptanceRatePpm'], 1_000_000)) fail('assistant-proactive: invalid runtime context')
    normalized.acceptanceRatePpm = record['acceptanceRatePpm']
  }
  if (record['acceptanceSamples'] !== undefined) {
    if (!integer(record['acceptanceSamples'], Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid runtime context')
    normalized.acceptanceSamples = record['acceptanceSamples']
  }
  return Object.freeze(normalized)
}

function validateDynamicSignals(signals: unknown): ProactiveDynamicSignals {
  if (signals === undefined) return {}
  const record = plainRecord(signals, 'assistant-proactive: invalid dynamic utility signals')
  for (const key of Object.keys(record)) {
    if (!(DYNAMIC_SIGNAL_KEYS as readonly string[]).includes(key)) fail('assistant-proactive: invalid dynamic utility signals')
  }
  const base = validateRuntimeContext({
    ...(record['userActive'] === undefined ? {} : { userActive: record['userActive'] }),
    ...(record['idleDurationMs'] === undefined ? {} : { idleDurationMs: record['idleDurationMs'] }),
    ...(record['recentNotificationCount'] === undefined ? {} : { recentNotificationCount: record['recentNotificationCount'] }),
    ...(record['urgencyPpm'] === undefined ? {} : { urgencyPpm: record['urgencyPpm'] }),
    ...(record['acceptanceRatePpm'] === undefined ? {} : { acceptanceRatePpm: record['acceptanceRatePpm'] }),
    ...(record['acceptanceSamples'] === undefined ? {} : { acceptanceSamples: record['acceptanceSamples'] }),
  }) ?? {}
  let remainingTtlMs: number | undefined
  if (record['remainingTtlMs'] !== undefined) {
    const rawTtl = record['remainingTtlMs']
    if (typeof rawTtl !== 'number' || !Number.isSafeInteger(rawTtl)) fail('assistant-proactive: invalid dynamic utility signals')
    remainingTtlMs = rawTtl
  }
  let acceptedCount: number | undefined
  if (record['acceptedCount'] !== undefined) {
    if (!integer(record['acceptedCount'], Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid dynamic utility signals')
    acceptedCount = record['acceptedCount']
  }
  let rejectedCount: number | undefined
  if (record['rejectedCount'] !== undefined) {
    if (!integer(record['rejectedCount'], Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid dynamic utility signals')
    rejectedCount = record['rejectedCount']
  }
  let overlayInterruptionCostDelta: number | undefined
  if (record['overlayInterruptionCostDelta'] !== undefined) {
    if (!integer(record['overlayInterruptionCostDelta'], max)) fail('assistant-proactive: invalid dynamic utility signals')
    overlayInterruptionCostDelta = record['overlayInterruptionCostDelta']
  }
  return {
    ...base,
    ...(remainingTtlMs === undefined ? {} : { remainingTtlMs }),
    ...(acceptedCount === undefined ? {} : { acceptedCount }),
    ...(rejectedCount === undefined ? {} : { rejectedCount }),
    ...(overlayInterruptionCostDelta === undefined ? {} : { overlayInterruptionCostDelta }),
  }
}

function clampSafeInteger(value: bigint): number {
  const minSafe = BigInt(-Number.MAX_SAFE_INTEGER)
  const maxSafe = BigInt(Number.MAX_SAFE_INTEGER)
  if (value < minSafe) return -Number.MAX_SAFE_INTEGER
  if (value > maxSafe) return Number.MAX_SAFE_INTEGER
  return Number(value)
}

/**
 * Bounded, deterministic WP12 dynamic utility & interruption cost calculation.
 * Neutral signals (no activity/idle signal, 0 recent notifications, unbounded/long TTL,
 * empty feedback history) produce 0 adjustment so behavior matches the static formula.
 */
export function computeDynamicUtility(
  profile: OpportunityProfile,
  signals: ProactiveDynamicSignals = {},
): Readonly<ProactiveDynamicUtilityBreakdown> {
  if (!profile || typeof profile !== 'object'
    || !integer(profile.expectedBenefit, Number.MAX_SAFE_INTEGER)
    || !integer(profile.successPpm, 1_000_000)
    || !integer(profile.executionCost, Number.MAX_SAFE_INTEGER)
    || !integer(profile.interruptionCost, Number.MAX_SAFE_INTEGER)
    || !integer(profile.possibleLoss, Number.MAX_SAFE_INTEGER)) {
    fail('assistant-proactive: invalid profile')
  }
  const checked = validateDynamicSignals(signals)
  const overlayDelta = checked.overlayInterruptionCostDelta ?? 0
  const baseInterruptionCost = Math.max(0, profile.interruptionCost - overlayDelta)

  // 1. User activity / idle duration (idle discount applies only to base profile interruptionCost, never overlay delta)
  let activityAdjustment = 0
  if (checked.userActive === true || (checked.idleDurationMs !== undefined && checked.idleDurationMs < ACTIVE_IDLE_THRESHOLD_MS)) {
    activityAdjustment = MAX_ACTIVITY_PENALTY
  } else if (checked.idleDurationMs !== undefined && checked.idleDurationMs >= IDLE_DISCOUNT_START_MS) {
    const span = IDLE_DISCOUNT_FULL_MS - IDLE_DISCOUNT_START_MS
    const elapsed = Math.min(checked.idleDurationMs - IDLE_DISCOUNT_START_MS, span)
    const rawDiscount = Math.floor((MAX_IDLE_DISCOUNT * elapsed) / span)
    const maxDiscount = Math.min(MAX_IDLE_DISCOUNT, baseInterruptionCost)
    activityAdjustment = -Math.min(maxDiscount, rawDiscount)
  }

  // 2. Recent notification frequency / rate
  const recentCount = Math.min(1_000_000, Math.max(0, checked.recentNotificationCount ?? 0))
  const frequencyPenalty = Math.min(MAX_FREQUENCY_PENALTY, recentCount * PENALTY_PER_RECENT_NOTIFICATION)

  const effectiveInterruptionCost = Math.max(0, profile.interruptionCost + activityAdjustment + frequencyPenalty)
  const interruptionDelta = effectiveInterruptionCost - profile.interruptionCost

  // 3. Urgency / remaining TTL
  let urgencyBonus = 0
  if (checked.urgencyPpm !== undefined) {
    urgencyBonus = Math.floor((MAX_URGENCY_BONUS * checked.urgencyPpm) / 1_000_000)
  } else if (checked.remainingTtlMs !== undefined && checked.remainingTtlMs >= 0 && checked.remainingTtlMs < URGENCY_WINDOW_MS) {
    urgencyBonus = Math.floor((MAX_URGENCY_BONUS * (URGENCY_WINDOW_MS - checked.remainingTtlMs)) / URGENCY_WINDOW_MS)
  }

  // 4. Historical acceptance rate (Laplace-smoothed, cold-start neutral)
  let accepted = checked.acceptedCount ?? 0
  let rejected = checked.rejectedCount ?? 0
  if (checked.acceptanceRatePpm !== undefined) {
    const extSamples = checked.acceptanceSamples ?? DEFAULT_EXPLICIT_ACCEPTANCE_SAMPLES
    if (extSamples > 0) {
      const extAccepted = Math.round((checked.acceptanceRatePpm * extSamples) / 1_000_000)
      const extRejected = extSamples - extAccepted
      accepted = Math.max(accepted, extAccepted)
      rejected = Math.max(rejected, extRejected)
    }
  }
  const totalFeedback = BigInt(accepted) + BigInt(rejected)
  let acceptanceAdjustment = 0
  if (totalFeedback > 0n) {
    const smoothedPpm = Number(((BigInt(accepted) + 1n) * 1_000_000n) / (totalFeedback + 2n))
    const rawDelta = Math.trunc(((smoothedPpm - 500_000) * 40) / 500_000)
    acceptanceAdjustment = Math.max(-MAX_ACCEPTANCE_PENALTY, Math.min(MAX_ACCEPTANCE_BONUS, rawDelta))
  }

  const baseUtilityBig =
    (BigInt(profile.expectedBenefit) * BigInt(profile.successPpm)) / 1_000_000n
    - BigInt(profile.executionCost)
    - BigInt(profile.interruptionCost)
    - BigInt(profile.possibleLoss)
  const effectiveUtilityBig =
    baseUtilityBig
    - BigInt(interruptionDelta)
    + BigInt(urgencyBonus)
    + BigInt(acceptanceAdjustment)

  return Object.freeze({
    baseUtility: clampSafeInteger(baseUtilityBig),
    baseInterruptionCost,
    effectiveInterruptionCost,
    activityAdjustment,
    frequencyPenalty,
    urgencyBonus,
    acceptanceAdjustment,
    effectiveUtility: clampSafeInteger(effectiveUtilityBig),
  })
}
function minuteAt(now: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now))
  const get = (name: string) => Number(parts.find(part => part.type === name)?.value)
  return get('hour') * 60 + get('minute')
}
function quiet(now: number, profile: OpportunityProfile): boolean {
  const value = profile.quietHours; if (!value) return false
  const minute = minuteAt(now, value.timezone)
  return value.startMinute < value.endMinute ? minute >= value.startMinute && minute < value.endMinute : minute >= value.startMinute || minute < value.endMinute
}
function quietEndsAt(now: number, profile: OpportunityProfile): number {
  for (let offset = 60_000; offset <= 25 * 60 * 60_000; offset += 60_000) if (!quiet(now + offset, profile)) return now + offset
  fail('assistant-proactive: quiet hours did not end')
}

/** Durable, owner-scoped opportunity accounting. Utility is an operator estimate, not a probability or a bill. */
export class OpportunityEngine {
  readonly #db: DatabaseSync
  readonly #profiles = new Map<string, Readonly<OpportunityProfile>>()
  readonly #now: () => number
  #overlay: AttentionOverlay | undefined
  constructor(path: string, profiles: readonly OpportunityProfile[], options: { now?: () => number } = {}) {
    if (!Array.isArray(profiles)) fail('assistant-proactive: profiles must be an array')
    for (const item of profiles) { const profile = validateProfile(item); if (this.#profiles.has(profile.id)) fail('assistant-proactive: duplicate profile'); this.#profiles.set(profile.id, profile) }
    this.#now = options.now ?? Date.now
    if (path !== ':memory:') privatePath(path)
    this.#db = new DatabaseSync(path)
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 250;
      CREATE TABLE IF NOT EXISTS proactive_profiles(scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, profile_id TEXT NOT NULL, profile_json TEXT NOT NULL, PRIMARY KEY(scope_json, goal_id, profile_id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS proactive_decisions(id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, profile_id TEXT NOT NULL, payload_json TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS proactive_events(scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, profile_id TEXT NOT NULL, source_id TEXT NOT NULL, event_sequence INTEGER NOT NULL, event_digest TEXT NOT NULL, decision_id TEXT NOT NULL REFERENCES proactive_decisions(id), PRIMARY KEY(scope_json, goal_id, profile_id, source_id, event_sequence, event_digest)) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS proactive_decisions_goal ON proactive_decisions(scope_json, goal_id, profile_id);
      CREATE TABLE IF NOT EXISTS proactive_reminders(scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, source_id TEXT NOT NULL, content_digest TEXT NOT NULL, decision_id TEXT NOT NULL REFERENCES proactive_decisions(id), queued INTEGER NOT NULL DEFAULT 0 CHECK(queued IN (0, 1)), PRIMARY KEY(scope_json, goal_id, source_id)) STRICT, WITHOUT ROWID;`)
    // Pre-release development databases may hold the table without `queued`; add it in place.
    if (!(this.#db.prepare('PRAGMA table_info(proactive_reminders)').all() as Array<{ name: string }>).some(column => column.name === 'queued'))
      this.#db.exec('ALTER TABLE proactive_reminders ADD COLUMN queued INTEGER NOT NULL DEFAULT 0 CHECK(queued IN (0, 1))')
  }
  /**
   * `overlay` is an optional verified tighten-only Evaluation attention version.
   * It is applied to the frozen goal profile for this evaluation only and is
   * never persisted into the profile snapshot.
   */
  evaluate(input: OpportunityInput, overlay?: unknown, runtimeContext?: ProactiveRuntimeContext): OpportunityEvaluation {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      this.#overlay = attentionOverlay(overlay)
      const context = validateRuntimeContext(runtimeContext)
      const value = this.#evaluate(input, context)
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      try { this.#db.exec('ROLLBACK') } catch {}
      throw error
    } finally {
      this.#overlay = undefined
    }
  }
  #evaluate(input: OpportunityInput, context?: ProactiveRuntimeContext): OpportunityEvaluation {
    validateInput(input); const now = this.#now(); if (!integer(now, Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid clock')
    const scope = scopeKey(input.scope); const profile = tuneProfile(this.#profile(scope, input.goalId, input.profileId), this.#overlay)
    let cachedUtility: number | undefined
    const currentUtility = () => cachedUtility ?? (cachedUtility = this.#dynamicUtility(scope, input, profile, now, context))
    const existing = this.#event(scope, input)
    if (existing) {
      if (!this.#sameIdentity(existing, input)) fail('assistant-proactive: event identity conflict')
      if (now >= input.expiresAt) return this.#terminal(existing, 'consume', 'suppress', 'expired', now)
      const rejected = this.#latestRejected(scope, input.goalId, profile.id)
      if (rejected && rejected.id !== existing.id && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#terminal(existing, 'consume', 'suppress', 'rejected-cooldown', now)
      if (existing.state === 'pending' && now >= existing.eligibleAt) return this.#mature(scope, existing, input, profile, now, context)
      return freeze({ disposition: existing.mode === 'execute' && existing.state === 'decided' ? 'execute' : existing.state === 'pending' ? 'defer' : 'consume', decision: existing })
    }
    if (this.#sequenceConflict(scope, input)) fail('assistant-proactive: event sequence conflict')
    const latest = this.#latest(scope, input.goalId, profile.id, input.sourceId)
    if (latest && input.event.sequence < latest.eventSequence) return freeze({ disposition: 'consume', decision: latest })
    if (now >= input.expiresAt) return this.#save(scope, input, profile, 'consume', 'suppress', 'expired', now, now, currentUtility())
    const rejected = this.#latestRejected(scope, input.goalId, profile.id)
    if (rejected && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#save(scope, input, profile, 'consume', 'suppress', 'rejected-cooldown', now, now, currentUtility())
    if (latest?.state === 'pending' && this.#sameIdentity(latest, input) && now < latest.eligibleAt) return this.#merge(scope, latest, input, now)
    if (latest?.state === 'pending' && this.#sameIdentity(latest, input)) return this.#mature(scope, latest, input, profile, now, context)
    const counts = this.#counts(scope, input.goalId)
    if (counts.ledger >= profile.maxDecisionsPerGoal || profile.mode === 'execute' && counts.executions >= profile.maxExecutionsPerGoal || profile.mode === 'remind' && counts.reminders >= profile.maxRemindersPerGoal) return this.#budgetProjection(input, profile, now, currentUtility())
    if (this.#muted(profile)) return this.#save(scope, input, profile, 'consume', 'suppress', 'attention-muted', now, now, currentUtility())
    if (quiet(now, profile)) return this.#save(scope, input, profile, 'defer', 'suppress', 'quiet-hours', now, quietEndsAt(now, profile), currentUtility())
    if (currentUtility() < profile.minimumUtility) return this.#save(scope, input, profile, 'consume', 'suppress', 'below-threshold', now, now, currentUtility())
    if (latest && now < latest.updatedAt + profile.cooldownMs) return this.#save(scope, input, profile, 'consume', 'suppress', 'cooldown', now, now, currentUtility())
    if (profile.mergeWindowMs > 0) return this.#save(scope, input, profile, 'defer', 'suppress', 'coalescing', now, now + profile.mergeWindowMs, currentUtility())
    if (profile.mode === 'remind' && this.#unchangedReminder(scope, reminderContent(input))) return this.#save(scope, input, profile, 'consume', 'suppress', 'unchanged', now, now, currentUtility())
    return this.#save(scope, input, profile, profile.mode === 'execute' ? 'execute' : 'consume', profile.mode, profile.mode === 'execute' ? 'execution' : profile.mode === 'remind' ? 'reminder' : 'prepared', now, now, currentUtility())
  }
  feedback(id: string, scopeInput: OpportunityScope, feedback: 'accepted' | 'rejected'): OpportunityDecision {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
    if (!text(id) || !['accepted', 'rejected'].includes(feedback)) fail(); const scope = scopeKey(scopeInput); const found = this.#decision(id)
    if (!found || scopeKey(found.scope) !== scope || found.state !== 'decided') fail('assistant-proactive: opportunity decision is unavailable')
    const next = freeze({ ...found, state: 'closed' as const, feedback, updatedAt: this.#now() })
    this.#put(next); this.#db.exec('COMMIT'); return next
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  get(id: string): OpportunityDecision | undefined {
    if (!text(id)) fail()
    return this.#decision(id)
  }
  list(scopeInput: OpportunityScope, goalId?: string): readonly OpportunityDecision[] {
    const scope = scopeKey(scopeInput); if (goalId !== undefined && !text(goalId)) fail()
    const rows = this.#db.prepare(`SELECT payload_json FROM proactive_decisions WHERE scope_json = ? ${goalId === undefined ? '' : 'AND goal_id = ?'} ORDER BY json_extract(payload_json, '$.firstObservedAt'), id`).all(...(goalId === undefined ? [scope] : [scope, goalId])) as Array<{ payload_json: string }>
    return freeze(rows.map(row => this.#parse(row.payload_json))) as readonly OpportunityDecision[]
  }
  listScopes(): readonly OpportunityScope[] {
    const rows = this.#db.prepare('SELECT DISTINCT scope_json FROM proactive_decisions').all() as Array<{ scope_json: string }>
    return freeze(rows.map(row => JSON.parse(row.scope_json) as OpportunityScope)) as readonly OpportunityScope[]
  }
  listAll(filter: ProactiveOpportunityFilter = {}): readonly OpportunityDecision[] {
    const conditions: string[] = []
    const params: (string | number)[] = []
    if (filter.scope !== undefined) {
      conditions.push('scope_json = ?')
      params.push(scopeKey(filter.scope))
    }
    if (filter.workspace !== undefined) {
      if (!content(filter.workspace, 4096) || !filter.workspace.startsWith('/')) fail()
      conditions.push("json_extract(scope_json, '$.workspace') = ?")
      params.push(filter.workspace)
    }
    if (filter.preset !== undefined) {
      if (!text(filter.preset, 4096)) fail()
      conditions.push("json_extract(scope_json, '$.preset') = ?")
      params.push(filter.preset)
    }
    if (filter.principalId !== undefined) {
      if (!text(filter.principalId, 4096)) fail()
      conditions.push("json_extract(scope_json, '$.principalId') = ?")
      params.push(filter.principalId)
    }
    if (filter.goalId !== undefined) {
      if (!text(filter.goalId)) fail()
      conditions.push('goal_id = ?')
      params.push(filter.goalId)
    }
    if (filter.state !== undefined) {
      if (!['pending', 'decided', 'closed'].includes(filter.state)) fail()
      conditions.push("json_extract(payload_json, '$.state') = ?")
      params.push(filter.state)
    }
    if (filter.mode !== undefined) {
      if (!['prepare', 'remind', 'execute', 'suppress'].includes(filter.mode)) fail()
      conditions.push("json_extract(payload_json, '$.mode') = ?")
      params.push(filter.mode)
    }
    const limit = typeof filter.limit === 'number' && Number.isSafeInteger(filter.limit) && filter.limit > 0
      ? Math.min(filter.limit, 500) : 100
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const rows = this.#db.prepare(`SELECT payload_json FROM proactive_decisions ${where} ORDER BY json_extract(payload_json, '$.updatedAt') DESC, rowid DESC LIMIT ?`).all(...params, limit) as Array<{ payload_json: string }>
    return freeze(rows.map(row => this.#parse(row.payload_json))) as readonly OpportunityDecision[]
  }
  profileSnapshot(scope: OpportunityScope, goalId: string, profileId: string): Readonly<OpportunityProfile> {
    const row = this.#db.prepare('SELECT profile_json FROM proactive_profiles WHERE scope_json = ? AND goal_id = ? AND profile_id = ?').get(scopeKey(scope), goalId, profileId) as { profile_json: string } | undefined
    if (!row) fail('assistant-proactive: frozen goal profile unavailable')
    return validateProfile(JSON.parse(row.profile_json) as OpportunityProfile)
  }
  closeWait(waitId: string, scope: OpportunityScope, reason: 'expired' | 'cancelled'): void {
    if (!text(waitId) || !['expired', 'cancelled'].includes(reason)) fail()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const decision of this.list(scope)) if (decision.waitId === waitId && decision.state === 'pending') this.#terminal(decision, 'consume', 'suppress', reason, this.#now())
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  sourcesForWait(waitId: string, scopeInput: OpportunityScope): readonly ProactiveGoalSourceLink[] {
    if (!text(waitId)) fail()
    return collectSourceLinks(this.list(scopeInput).filter(decision => decision.waitId === waitId))
  }
  sourcesForGoal(scopeInput: OpportunityScope, goalId: string): readonly ProactiveGoalSourceLink[] {
    if (!text(goalId)) fail()
    return collectSourceLinks(this.list(scopeInput, goalId))
  }
  listByNativeGoal(nativeGoalId: string, sessionId?: string): readonly OpportunityDecision[] {
    if (!text(nativeGoalId)) fail()
    if (sessionId !== undefined && !text(sessionId)) fail()
    const sql = sessionId === undefined
      ? "SELECT payload_json FROM proactive_decisions WHERE json_extract(payload_json, '$.nativeGoalId') = ? ORDER BY json_extract(payload_json, '$.updatedAt') DESC, rowid DESC LIMIT 64"
      : "SELECT payload_json FROM proactive_decisions WHERE json_extract(payload_json, '$.nativeGoalId') = ? AND json_extract(payload_json, '$.sessionId') = ? ORDER BY json_extract(payload_json, '$.updatedAt') DESC, rowid DESC LIMIT 64"
    const rows = (sessionId === undefined
      ? this.#db.prepare(sql).all(nativeGoalId)
      : this.#db.prepare(sql).all(nativeGoalId, sessionId)) as Array<{ payload_json: string }>
    return freeze(rows.map(row => this.#parse(row.payload_json))) as readonly OpportunityDecision[]
  }
  closeGoal(scopeInput: OpportunityScope, goalId: string, reason: ProactiveGoalLifecycleReason): readonly OpportunityDecision[] {
    if (!text(goalId) || !['completed', 'cancelled', 'expired', 'retired'].includes(reason)) fail()
    const terminalReason = reason === 'expired' ? 'expired' : 'cancelled'
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const closed: OpportunityDecision[] = []
      for (const decision of this.list(scopeInput, goalId)) {
        if (decision.state === 'pending') {
          closed.push(this.#terminal(decision, 'consume', 'suppress', terminalReason, this.#now()).decision)
        }
      }
      this.#db.exec('COMMIT')
      return freeze(closed) as readonly OpportunityDecision[]
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  /** Delivery accepted (queued) this decision's reminder; a later replay past its send window keeps the dedupe. */
  confirmReminder(decision: Readonly<Pick<OpportunityDecision, 'id' | 'scope' | 'goalId' | 'sourceId'>>): void {
    this.#db.prepare('UPDATE proactive_reminders SET queued = 1 WHERE scope_json = ? AND goal_id = ? AND source_id = ? AND decision_id = ?').run(scopeKey(decision.scope), decision.goalId, decision.sourceId, decision.id)
  }
  /**
   * This decision's reminder was never accepted by Delivery and its send window has closed, so it must not
   * count as seen. Only the unconfirmed row this decision wrote is removed; a newer reminder is left alone.
   */
  releaseReminder(decision: Readonly<Pick<OpportunityDecision, 'id' | 'scope' | 'goalId' | 'sourceId'>>): void {
    this.#db.prepare('DELETE FROM proactive_reminders WHERE scope_json = ? AND goal_id = ? AND source_id = ? AND decision_id = ? AND queued = 0').run(scopeKey(decision.scope), decision.goalId, decision.sourceId, decision.id)
  }
  close(): void { this.#db.close() }
  #muted(profile: Readonly<OpportunityProfile>): boolean { return profile.mode === 'remind' && this.#overlay?.parameters.muted === true }
  /** Records which attention version shaped a decision; absent when no overlay applied. */
  #attention(profile: Readonly<OpportunityProfile>): Pick<OpportunityDecision, 'attentionTuning'> {
    return this.#overlay && profile.mode === 'remind' ? { attentionTuning: freeze({ version: this.#overlay.version, digest: this.#overlay.digest }) } : {}
  }
  #tag(existing: OpportunityDecision, profile: Readonly<OpportunityProfile>): OpportunityDecision {
    const { attentionTuning: _previous, ...rest } = existing
    return { ...rest, ...this.#attention(profile) }
  }
  #profile(scope: string, goalId: string, profileId: string): Readonly<OpportunityProfile> {
    const row = this.#db.prepare('SELECT profile_json FROM proactive_profiles WHERE scope_json = ? AND goal_id = ? AND profile_id = ?').get(scope, goalId, profileId) as { profile_json: string } | undefined
    if (row) return validateProfile(JSON.parse(row.profile_json) as OpportunityProfile)
    const configured = this.#profiles.get(profileId); if (!configured) fail('assistant-proactive: unknown profile')
    const prior = this.#db.prepare('SELECT profile_json FROM proactive_profiles WHERE scope_json = ? AND goal_id = ?').all(scope, goalId) as Array<{ profile_json: string }>
    const bounds = prior.map(item => validateProfile(JSON.parse(item.profile_json) as OpportunityProfile))
    const profile = { ...configured, maxDecisionsPerGoal: Math.min(configured.maxDecisionsPerGoal, ...bounds.map(item => item.maxDecisionsPerGoal)), maxExecutionsPerGoal: Math.min(configured.maxExecutionsPerGoal, ...bounds.map(item => item.maxExecutionsPerGoal)), maxRemindersPerGoal: Math.min(configured.maxRemindersPerGoal, ...bounds.map(item => item.maxRemindersPerGoal)) }
    this.#db.prepare('INSERT INTO proactive_profiles VALUES (?, ?, ?, ?)').run(scope, goalId, profileId, JSON.stringify(profile)); return profile
  }
  #parse(value: string): OpportunityDecision { try { return freeze(JSON.parse(value) as OpportunityDecision) as OpportunityDecision } catch { fail('assistant-proactive: corrupt database') } }
  #decision(id: string): OpportunityDecision | undefined { const row = this.#db.prepare('SELECT payload_json FROM proactive_decisions WHERE id = ?').get(id) as { payload_json: string } | undefined; return row ? this.#parse(row.payload_json) : undefined }
  #event(scope: string, input: OpportunityInput): OpportunityDecision | undefined { const row = this.#db.prepare('SELECT decision_id FROM proactive_events WHERE scope_json = ? AND goal_id = ? AND profile_id = ? AND source_id = ? AND event_sequence = ? AND event_digest = ?').get(scope, input.goalId, input.profileId, input.sourceId, input.event.sequence, input.event.digest) as { decision_id: string } | undefined; return row ? this.#decision(row.decision_id) : undefined }
  #sequenceConflict(scope: string, input: OpportunityInput): boolean { return this.#db.prepare('SELECT 1 AS found FROM proactive_events WHERE scope_json = ? AND goal_id = ? AND profile_id = ? AND source_id = ? AND event_sequence = ? LIMIT 1').get(scope, input.goalId, input.profileId, input.sourceId, input.event.sequence) !== undefined }
  #latest(scope: string, goalId: string, profileId: string, sourceId: string): OpportunityDecision | undefined { const row = this.#db.prepare("SELECT payload_json FROM proactive_decisions WHERE scope_json = ? AND goal_id = ? AND profile_id = ? AND json_extract(payload_json, '$.sourceId') = ? ORDER BY json_extract(payload_json, '$.eventSequence') DESC, json_extract(payload_json, '$.updatedAt') DESC LIMIT 1").get(scope, goalId, profileId, sourceId) as { payload_json: string } | undefined; return row ? this.#parse(row.payload_json) : undefined }
  #latestRejected(scope: string, goalId: string, profileId: string): OpportunityDecision | undefined { const row = this.#db.prepare("SELECT payload_json FROM proactive_decisions WHERE scope_json = ? AND goal_id = ? AND profile_id = ? AND json_extract(payload_json, '$.feedback') = 'rejected' ORDER BY json_extract(payload_json, '$.updatedAt') DESC LIMIT 1").get(scope, goalId, profileId) as { payload_json: string } | undefined; return row ? this.#parse(row.payload_json) : undefined }
  #counts(scope: string, goalId: string): { ledger: number; executions: number; reminders: number } {
    const rows = this.list(JSON.parse(scope) as OpportunityScope, goalId)
    return { ledger: rows.length, executions: rows.filter(value => value.mode === 'execute').length, reminders: rows.filter(value => value.mode === 'remind').length }
  }
  #merge(scope: string, existing: OpportunityDecision, input: OpportunityInput, now: number): OpportunityEvaluation {
    const next = input.event.sequence > existing.eventSequence ? freeze({ ...existing, waitId: input.waitId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, eventObservationDigest: input.event.observationDigest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, updatedAt: now, observations: existing.observations + 1 }) : freeze({ ...existing, updatedAt: now, observations: existing.observations + 1 })
    this.#put(next); this.#link(scope, input, next.id); return freeze({ disposition: 'defer', decision: next })
  }
  #recentNotifications(scope: string, now: number): number {
    const windowStart = Math.max(0, now - RECENT_NOTIFICATION_WINDOW_MS)
    const row = this.#db.prepare(
      "SELECT count(*) AS count FROM proactive_decisions WHERE scope_json = ? AND json_extract(payload_json, '$.mode') IN ('remind', 'execute') AND json_extract(payload_json, '$.state') IN ('decided', 'closed') AND json_extract(payload_json, '$.updatedAt') >= ? AND json_extract(payload_json, '$.updatedAt') <= ?",
    ).get(scope, windowStart, now) as { count: number } | undefined
    return row && Number.isSafeInteger(row.count) && row.count >= 0 ? row.count : 0
  }
  #acceptanceHistory(scope: string): { accepted: number; rejected: number } {
    const row = this.#db.prepare(
      "SELECT COALESCE(SUM(CASE WHEN json_extract(payload_json, '$.feedback') = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted, COALESCE(SUM(CASE WHEN json_extract(payload_json, '$.feedback') = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected FROM proactive_decisions WHERE scope_json = ? AND json_extract(payload_json, '$.feedback') IN ('accepted', 'rejected')",
    ).get(scope) as { accepted: number; rejected: number } | undefined
    return {
      accepted: row && Number.isSafeInteger(row.accepted) && row.accepted >= 0 ? row.accepted : 0,
      rejected: row && Number.isSafeInteger(row.rejected) && row.rejected >= 0 ? row.rejected : 0,
    }
  }
  #dynamicUtility(
    scope: string,
    input: OpportunityInput,
    profile: Readonly<OpportunityProfile>,
    now: number,
    context?: ProactiveRuntimeContext,
  ): number {
    const ttlDiff = BigInt(input.expiresAt) - BigInt(now)
    const remainingTtlMs = ttlDiff < 0n ? -1 : ttlDiff < BigInt(URGENCY_WINDOW_MS) ? Number(ttlDiff) : undefined
    const dbRecent = this.#recentNotifications(scope, now)
    const recentNotificationCount = context?.recentNotificationCount !== undefined
      ? Math.max(dbRecent, context.recentNotificationCount)
      : dbRecent
    const history = this.#acceptanceHistory(scope)
    const overlayInterruptionCostDelta = profile.mode === 'remind' ? (this.#overlay?.parameters.interruptionCostDelta ?? 0) : 0
    return computeDynamicUtility(profile, {
      ...context,
      recentNotificationCount,
      ...(remainingTtlMs === undefined ? {} : { remainingTtlMs }),
      acceptedCount: history.accepted,
      rejectedCount: history.rejected,
      overlayInterruptionCostDelta,
    }).effectiveUtility
  }
  #mature(scope: string, existing: OpportunityDecision, input: OpportunityInput, profile: OpportunityProfile, now: number, context?: ProactiveRuntimeContext): OpportunityEvaluation {
    if (now >= input.expiresAt) return this.#terminal(existing, 'consume', 'suppress', 'expired', now)
    const rejected = this.#latestRejected(scope, input.goalId, profile.id)
    if (rejected && rejected.id !== existing.id && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#terminal(existing, 'consume', 'suppress', 'rejected-cooldown', now)
    if (this.#muted(profile)) {
      const muted = freeze({ ...this.#tag(existing, profile), state: 'decided' as const, mode: 'suppress' as const, reason: 'attention-muted' as const, updatedAt: now })
      this.#put(muted); return freeze({ disposition: 'consume', decision: muted })
    }
    if (quiet(now, profile)) {
      const delayed = freeze({ ...this.#tag(existing, profile), reason: 'quiet-hours' as const, updatedAt: now, eligibleAt: quietEndsAt(now, profile) })
      this.#put(delayed); return freeze({ disposition: 'defer', decision: delayed })
    }
    const currentUtility = this.#dynamicUtility(scope, input, profile, now, context)
    if (currentUtility < profile.minimumUtility) {
      const suppressed = freeze({ ...this.#tag(existing, profile), state: 'decided' as const, mode: 'suppress' as const, reason: 'below-threshold' as const, utility: currentUtility, updatedAt: now })
      this.#put(suppressed); return freeze({ disposition: 'consume', decision: suppressed })
    }
    const counts = this.#counts(scope, input.goalId)
    const budget = counts.ledger > profile.maxDecisionsPerGoal || profile.mode === 'execute' && counts.executions >= profile.maxExecutionsPerGoal || profile.mode === 'remind' && counts.reminders >= profile.maxRemindersPerGoal
    // Compare the content of the latest coalesced observation, i.e. what this decision will actually report.
    const observed: OpportunityDecision = { ...this.#tag(existing, profile), ...(input.event.sequence > existing.eventSequence ? { eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, eventObservationDigest: input.event.observationDigest, observations: existing.observations + 1 } : {}) }
    const unchanged = !budget && profile.mode === 'remind' && this.#unchangedReminder(scope, observed)
    const mode = budget || unchanged ? 'suppress' as const : profile.mode
    const reason = budget ? 'budget' as const : unchanged ? 'unchanged' as const : profile.mode === 'execute' ? 'execution' as const : profile.mode === 'remind' ? 'reminder' as const : 'prepared' as const
    const next = freeze({ ...observed, mode, state: 'decided' as const, reason, utility: currentUtility, updatedAt: now })
    this.#put(next); this.#link(scope, input, next.id); if (mode === 'remind') this.#remember(scope, next)
    return freeze({ disposition: mode === 'execute' ? 'execute' : 'consume', decision: next })
  }
  #save(scope: string, input: OpportunityInput, profile: OpportunityProfile, disposition: OpportunityEvaluation['disposition'], mode: OpportunityDecision['mode'], reason: OpportunityDecision['reason'], now: number, eligibleAt: number, evaluatedUtility: number): OpportunityEvaluation {
    if (this.#counts(scope, input.goalId).ledger >= profile.maxDecisionsPerGoal) return this.#budgetProjection(input, profile, now, evaluatedUtility)
    const decision = freeze({ id: `opportunity-${randomUUID()}`, waitId: input.waitId, profileId: profile.id, scope: input.scope, goalId: input.goalId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, eventObservationDigest: input.event.observationDigest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, mode, state: eligibleAt > now ? 'pending' as const : 'decided' as const, reason, utility: evaluatedUtility, firstObservedAt: now, updatedAt: now, eligibleAt, expiresAt: input.expiresAt, observations: 1, ...this.#attention(profile) })
    this.#put(decision); this.#link(scope, input, decision.id); if (mode === 'remind') this.#remember(scope, decision); return freeze({ disposition, decision })
  }
  /**
   * One reminder per goal source until what the owner would read changes or the owner answers it. Durable in
   * the same transaction as the decision, so a restart neither forgets nor re-sends an unchanged reminder.
   */
  #unchangedReminder(scope: string, value: ReminderContent & Pick<OpportunityDecision, 'goalId'>): boolean {
    const row = this.#db.prepare('SELECT content_digest, decision_id FROM proactive_reminders WHERE scope_json = ? AND goal_id = ? AND source_id = ?').get(scope, value.goalId, value.sourceId) as { content_digest: string; decision_id: string } | undefined
    if (!row || row.content_digest !== reminderContentDigest(value)) return false
    return this.#decision(row.decision_id)?.feedback === undefined
  }
  #remember(scope: string, decision: OpportunityDecision): void {
    this.#db.prepare('INSERT INTO proactive_reminders(scope_json, goal_id, source_id, content_digest, decision_id, queued) VALUES (?, ?, ?, ?, ?, 0) ON CONFLICT(scope_json, goal_id, source_id) DO UPDATE SET content_digest = excluded.content_digest, decision_id = excluded.decision_id, queued = 0').run(scope, decision.goalId, decision.sourceId, reminderContentDigest(decision), decision.id)
  }
  #put(decision: OpportunityDecision): void { this.#db.prepare('INSERT INTO proactive_decisions(id, scope_json, goal_id, profile_id, payload_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json').run(decision.id, scopeKey(decision.scope), decision.goalId, decision.profileId, JSON.stringify(decision)) }
  #link(scope: string, input: OpportunityInput, id: string): void { this.#db.prepare('INSERT OR IGNORE INTO proactive_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(scope, input.goalId, input.profileId, input.sourceId, input.event.sequence, input.event.digest, id) }
  #terminal(existing: OpportunityDecision, disposition: OpportunityEvaluation['disposition'], mode: OpportunityDecision['mode'], reason: OpportunityDecision['reason'], now: number): OpportunityEvaluation { const next = freeze({ ...existing, mode, reason, state: 'decided' as const, updatedAt: now }); if (existing.state === 'pending') this.#put(next); return freeze({ disposition, decision: next }) }
  #budgetProjection(input: OpportunityInput, profile: OpportunityProfile, now: number, evaluatedUtility: number): OpportunityEvaluation { return freeze({ disposition: 'consume', decision: freeze({ id: `opportunity-budget-${input.event.digest}`, waitId: input.waitId, profileId: profile.id, scope: input.scope, goalId: input.goalId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, eventObservationDigest: input.event.observationDigest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, mode: 'suppress' as const, state: 'decided' as const, reason: 'budget' as const, utility: evaluatedUtility, firstObservedAt: now, updatedAt: now, eligibleAt: now, expiresAt: input.expiresAt, observations: 0 }) }) }
  #sameIdentity(value: OpportunityDecision, input: OpportunityInput): boolean { return value.waitId === input.waitId && value.sessionId === input.sessionId && value.nativeGoalId === input.nativeGoalId && value.nativeRevision === input.nativeRevision && value.ownerRouteId === input.ownerRouteId && value.sourceId === input.sourceId && value.sourceDigest === input.sourceDigest && value.definitionDigest === input.definitionDigest && value.objective === input.objective && value.expiresAt === input.expiresAt && value.goalId === input.goalId && sameScope(value.scope, input.scope) }
}
function sameScope(left: OpportunityScope, right: OpportunityScope): boolean { return scopeKey(left) === scopeKey(right) }
function collectSourceLinks(decisions: readonly OpportunityDecision[]): readonly ProactiveGoalSourceLink[] {
  const links: ProactiveGoalSourceLink[] = []
  const seen = new Set<string>()
  for (const decision of decisions) {
    const key = `${decision.goalId}\0${decision.sourceId}\0${decision.sourceDigest}\0${decision.definitionDigest}`
    if (seen.has(key)) continue
    seen.add(key)
    links.push({
      scope: decision.scope,
      goalId: decision.goalId,
      waitId: decision.waitId,
      sourceId: decision.sourceId,
      sourceDigest: decision.sourceDigest,
      definitionDigest: decision.definitionDigest,
      nativeGoalId: decision.nativeGoalId,
      nativeRevision: decision.nativeRevision,
    })
  }
  return freeze(links) as readonly ProactiveGoalSourceLink[]
}
