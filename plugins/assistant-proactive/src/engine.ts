import { closeSync, constants, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { OpportunityDecision, OpportunityEvaluation, OpportunityInput, OpportunityProfile, OpportunityScope } from './types.js'

const max = 1_000_000_000
const integer = (value: unknown, limit = max): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= limit
const text = (value: unknown, limit = 4096): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\s\p{Cc}]/u.test(value)
const content = (value: unknown, limit = 65_536): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\p{Cc}]/u.test(value)
const freeze = <T>(value: T): Readonly<T> => Object.freeze(JSON.parse(JSON.stringify(value)) as T)
function fail(message = 'assistant-proactive: invalid opportunity input'): never { throw new Error(message) }

function privatePath(path: string): void {
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
  if (!input || typeof input !== 'object' || Object.keys(input).some(key => !['id', 'mode', 'expectedBenefit', 'successPpm', 'executionCost', 'interruptionCost', 'possibleLoss', 'minimumUtility', 'mergeWindowMs', 'cooldownMs', 'rejectionCooldownMs', 'quietHours', 'maxDecisionsPerGoal', 'maxExecutionsPerGoal', 'maxRemindersPerGoal'].includes(key))
    || !text(input.id) || !['prepare', 'remind', 'execute'].includes(input.mode) || input.successPpm > 1_000_000
    || ![input.expectedBenefit, input.successPpm, input.executionCost, input.interruptionCost, input.possibleLoss, input.minimumUtility, input.mergeWindowMs, input.cooldownMs, input.rejectionCooldownMs, input.maxDecisionsPerGoal, input.maxExecutionsPerGoal, input.maxRemindersPerGoal].every(value => integer(value))) fail('assistant-proactive: invalid profile')
  if (input.quietHours !== undefined) {
    const quiet = input.quietHours
    if (!quiet || typeof quiet !== 'object' || Object.keys(quiet).length !== 3 || typeof quiet.timezone !== 'string' || quiet.timezone.length > 128 || !integer(quiet.startMinute, 1439) || !integer(quiet.endMinute, 1439) || quiet.startMinute === quiet.endMinute) fail('assistant-proactive: invalid quiet hours')
    try { Intl.DateTimeFormat('en-US', { timeZone: quiet.timezone }).format() } catch { fail('assistant-proactive: invalid quiet hours') }
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
    || !integer(input.nativeRevision) || !integer(input.event.sequence) || !integer(input.event.occurredAt, Number.MAX_SAFE_INTEGER) || !integer(input.expiresAt, Number.MAX_SAFE_INTEGER)) fail()
  scopeKey(input.scope)
}
function utility(profile: OpportunityProfile): number { return Number(BigInt(profile.expectedBenefit) * BigInt(profile.successPpm) / 1_000_000n - BigInt(profile.executionCost) - BigInt(profile.interruptionCost) - BigInt(profile.possibleLoss)) }
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
      CREATE INDEX IF NOT EXISTS proactive_decisions_goal ON proactive_decisions(scope_json, goal_id, profile_id);`)
  }
  evaluate(input: OpportunityInput): OpportunityEvaluation {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const value = this.#evaluate(input); this.#db.exec('COMMIT'); return value } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #evaluate(input: OpportunityInput): OpportunityEvaluation {
    validateInput(input); const now = this.#now(); if (!integer(now, Number.MAX_SAFE_INTEGER)) fail('assistant-proactive: invalid clock')
    const scope = scopeKey(input.scope); const profile = this.#profile(scope, input.goalId, input.profileId)
    const existing = this.#event(scope, input)
    if (existing) {
      if (!this.#sameIdentity(existing, input)) fail('assistant-proactive: event identity conflict')
      if (now >= input.expiresAt) return this.#terminal(existing, 'consume', 'suppress', 'expired', now)
      const rejected = this.#latestRejected(scope, input.goalId, profile.id)
      if (rejected && rejected.id !== existing.id && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#terminal(existing, 'consume', 'suppress', 'rejected-cooldown', now)
      if (existing.state === 'pending' && now >= existing.eligibleAt) return this.#mature(scope, existing, input, profile, now)
      return freeze({ disposition: existing.mode === 'execute' && existing.state === 'decided' ? 'execute' : existing.state === 'pending' ? 'defer' : 'consume', decision: existing })
    }
    if (this.#sequenceConflict(scope, input)) fail('assistant-proactive: event sequence conflict')
    const latest = this.#latest(scope, input.goalId, profile.id, input.sourceId)
    if (latest && input.event.sequence < latest.eventSequence) return freeze({ disposition: 'consume', decision: latest })
    if (now >= input.expiresAt) return this.#save(scope, input, profile, 'consume', 'suppress', 'expired', now, now)
    const rejected = this.#latestRejected(scope, input.goalId, profile.id)
    if (rejected && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#save(scope, input, profile, 'consume', 'suppress', 'rejected-cooldown', now, now)
    if (latest?.state === 'pending' && this.#sameIdentity(latest, input) && now < latest.eligibleAt) return this.#merge(scope, latest, input, now)
    if (latest?.state === 'pending' && this.#sameIdentity(latest, input)) return this.#mature(scope, latest, input, profile, now)
    const counts = this.#counts(scope, input.goalId)
    if (counts.ledger >= profile.maxDecisionsPerGoal || profile.mode === 'execute' && counts.executions >= profile.maxExecutionsPerGoal || profile.mode === 'remind' && counts.reminders >= profile.maxRemindersPerGoal) return this.#budgetProjection(input, profile, now)
    if (quiet(now, profile)) return this.#save(scope, input, profile, 'defer', 'suppress', 'quiet-hours', now, quietEndsAt(now, profile))
    if (utility(profile) < profile.minimumUtility) return this.#save(scope, input, profile, 'consume', 'suppress', 'below-threshold', now, now)
    if (latest && now < latest.updatedAt + profile.cooldownMs) return this.#save(scope, input, profile, 'consume', 'suppress', 'cooldown', now, now)
    if (profile.mergeWindowMs > 0) return this.#save(scope, input, profile, 'defer', 'suppress', 'coalescing', now, now + profile.mergeWindowMs)
    return this.#save(scope, input, profile, profile.mode === 'execute' ? 'execute' : 'consume', profile.mode, profile.mode === 'execute' ? 'execution' : profile.mode === 'remind' ? 'reminder' : 'prepared', now, now)
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
  list(scopeInput: OpportunityScope, goalId?: string): readonly OpportunityDecision[] {
    const scope = scopeKey(scopeInput); if (goalId !== undefined && !text(goalId)) fail()
    const rows = this.#db.prepare(`SELECT payload_json FROM proactive_decisions WHERE scope_json = ? ${goalId === undefined ? '' : 'AND goal_id = ?'} ORDER BY json_extract(payload_json, '$.firstObservedAt'), id`).all(...(goalId === undefined ? [scope] : [scope, goalId])) as Array<{ payload_json: string }>
    return freeze(rows.map(row => this.#parse(row.payload_json))) as readonly OpportunityDecision[]
  }
  closeWait(waitId: string, scope: OpportunityScope, reason: 'expired' | 'cancelled'): void {
    if (!text(waitId) || !['expired', 'cancelled'].includes(reason)) fail()
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      for (const decision of this.list(scope)) if (decision.waitId === waitId && decision.state === 'pending') this.#terminal(decision, 'consume', 'suppress', reason, this.#now())
      this.#db.exec('COMMIT')
    } catch (error) { this.#db.exec('ROLLBACK'); throw error }
  }
  close(): void { this.#db.close() }
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
    const next = input.event.sequence > existing.eventSequence ? freeze({ ...existing, waitId: input.waitId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, updatedAt: now, observations: existing.observations + 1 }) : freeze({ ...existing, updatedAt: now, observations: existing.observations + 1 })
    this.#put(next); this.#link(scope, input, next.id); return freeze({ disposition: 'defer', decision: next })
  }
  #mature(scope: string, existing: OpportunityDecision, input: OpportunityInput, profile: OpportunityProfile, now: number): OpportunityEvaluation {
    if (now >= input.expiresAt) return this.#terminal(existing, 'consume', 'suppress', 'expired', now)
    const rejected = this.#latestRejected(scope, input.goalId, profile.id)
    if (rejected && rejected.id !== existing.id && now < rejected.updatedAt + profile.rejectionCooldownMs) return this.#terminal(existing, 'consume', 'suppress', 'rejected-cooldown', now)
    if (quiet(now, profile)) {
      const delayed = freeze({ ...existing, reason: 'quiet-hours' as const, updatedAt: now, eligibleAt: quietEndsAt(now, profile) })
      this.#put(delayed); return freeze({ disposition: 'defer', decision: delayed })
    }
    if (utility(profile) < profile.minimumUtility) {
      const suppressed = freeze({ ...existing, state: 'decided' as const, mode: 'suppress' as const, reason: 'below-threshold' as const, updatedAt: now })
      this.#put(suppressed); return freeze({ disposition: 'consume', decision: suppressed })
    }
    const counts = this.#counts(scope, input.goalId)
    const budget = counts.ledger > profile.maxDecisionsPerGoal || profile.mode === 'execute' && counts.executions >= profile.maxExecutionsPerGoal || profile.mode === 'remind' && counts.reminders >= profile.maxRemindersPerGoal
    const mode = budget ? 'suppress' as const : profile.mode
    const reason = budget ? 'budget' as const : profile.mode === 'execute' ? 'execution' as const : profile.mode === 'remind' ? 'reminder' as const : 'prepared' as const
    const next = freeze({ ...existing, ...(input.event.sequence > existing.eventSequence ? { eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, observations: existing.observations + 1 } : {}), mode, state: 'decided' as const, reason, updatedAt: now })
    this.#put(next); this.#link(scope, input, next.id)
    return freeze({ disposition: mode === 'execute' ? 'execute' : 'consume', decision: next })
  }
  #save(scope: string, input: OpportunityInput, profile: OpportunityProfile, disposition: OpportunityEvaluation['disposition'], mode: OpportunityDecision['mode'], reason: OpportunityDecision['reason'], now: number, eligibleAt: number): OpportunityEvaluation {
    if (this.#counts(scope, input.goalId).ledger >= profile.maxDecisionsPerGoal) return this.#budgetProjection(input, profile, now)
    const decision = freeze({ id: `opportunity-${randomUUID()}`, waitId: input.waitId, profileId: profile.id, scope: input.scope, goalId: input.goalId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, mode, state: eligibleAt > now ? 'pending' as const : 'decided' as const, reason, utility: utility(profile), firstObservedAt: now, updatedAt: now, eligibleAt, expiresAt: input.expiresAt, observations: 1 })
    this.#put(decision); this.#link(scope, input, decision.id); return freeze({ disposition, decision })
  }
  #put(decision: OpportunityDecision): void { this.#db.prepare('INSERT INTO proactive_decisions(id, scope_json, goal_id, profile_id, payload_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json').run(decision.id, scopeKey(decision.scope), decision.goalId, decision.profileId, JSON.stringify(decision)) }
  #link(scope: string, input: OpportunityInput, id: string): void { this.#db.prepare('INSERT OR IGNORE INTO proactive_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(scope, input.goalId, input.profileId, input.sourceId, input.event.sequence, input.event.digest, id) }
  #terminal(existing: OpportunityDecision, disposition: OpportunityEvaluation['disposition'], mode: OpportunityDecision['mode'], reason: OpportunityDecision['reason'], now: number): OpportunityEvaluation { const next = freeze({ ...existing, mode, reason, state: 'decided' as const, updatedAt: now }); if (existing.state === 'pending') this.#put(next); return freeze({ disposition, decision: next }) }
  #budgetProjection(input: OpportunityInput, profile: OpportunityProfile, now: number): OpportunityEvaluation { return freeze({ disposition: 'consume', decision: freeze({ id: `opportunity-budget-${input.event.digest}`, waitId: input.waitId, profileId: profile.id, scope: input.scope, goalId: input.goalId, sessionId: input.sessionId, ownerRouteId: input.ownerRouteId, sourceId: input.sourceId, eventId: input.event.id, eventSequence: input.event.sequence, eventDigest: input.event.digest, sourceDigest: input.sourceDigest, objective: input.objective, definitionDigest: input.definitionDigest, nativeGoalId: input.nativeGoalId, nativeRevision: input.nativeRevision, mode: 'suppress' as const, state: 'decided' as const, reason: 'budget' as const, utility: utility(profile), firstObservedAt: now, updatedAt: now, eligibleAt: now, expiresAt: input.expiresAt, observations: 0 }) }) }
  #sameIdentity(value: OpportunityDecision, input: OpportunityInput): boolean { return value.waitId === input.waitId && value.sessionId === input.sessionId && value.nativeGoalId === input.nativeGoalId && value.nativeRevision === input.nativeRevision && value.ownerRouteId === input.ownerRouteId && value.sourceId === input.sourceId && value.sourceDigest === input.sourceDigest && value.definitionDigest === input.definitionDigest && value.objective === input.objective && value.expiresAt === input.expiresAt && value.goalId === input.goalId && sameScope(value.scope, input.scope) }
}
function sameScope(left: OpportunityScope, right: OpportunityScope): boolean { return scopeKey(left) === scopeKey(right) }
