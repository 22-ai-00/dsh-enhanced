import { closeSync, constants, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { SkillDefinition } from './definition.js'

export type SkillRunState = 'running' | 'succeeded' | 'failed' | 'unknown'
export interface SkillRunStep { id: string; state: 'succeeded' | 'failed' | 'unknown'; detail?: string }
export interface SkillRun {
  id: string
  invocationId: string
  goalId: string
  sessionId: string
  skillName: string
  version: number
  inputs: Readonly<Record<string, unknown>>
  state: SkillRunState
  steps: readonly SkillRunStep[]
  candidateId?: string
  goalExecutionRunId?: string
  goalDefinitionDigest?: string
  nativeGoalId?: string
  createdAt: number
  updatedAt: number
}
export interface SkillRunClaim {
  invocationId: string; goalId: string; sessionId: string; skillName: string; version: number; inputs: Readonly<Record<string, unknown>>
  candidateId?: string; goalExecutionRunId?: string; goalDefinitionDigest?: string; nativeGoalId?: string
}
export interface StoredSkillDefinition extends SkillDefinition { version: number; parentVersion: number | null; retired: boolean; createdAt: number; updatedAt: number; restoredFromVersion?: number }
export interface SkillCandidate {
  id: string
  definition: SkillDefinition
  parentVersion: number
  parentDigest: string | null
  reason: string
  trigger: string
  expiresAt: number
  state: 'pending' | 'activated' | 'rejected'
  createdAt: number
  updatedAt: number
  activatedVersion?: number
  trialRunId?: string
  acceptanceDigest?: string
  activationWatchDigest?: string
  activationWatchId?: string
}
export interface SkillComparisonIdentity { sessionId: string; candidateId: string; parentDigest: string; profileId: string; profileDigest: string; invocationId: string }
export interface SkillComparison extends SkillComparisonIdentity { id: string; state: 'running' | 'complete' | 'unknown'; result: unknown | null; createdAt: number; updatedAt: number }
export interface SkillWatchObservation { runId: string; receiptDigest: string; objectiveStatus: 'achieved' | 'not-achieved'; verifiedAt: number; validUntil: number }
export interface SkillWatch {
  id: string; scope: object; routeReceipt: unknown; afterRunRowId: number; ownerRouteId: string; skillName: string; version: number; definitionDigest: string; fallbackVersion: number; fallbackDigest: string
  expiresAt: number; maxRuns: number; failureThreshold: number; state: 'watching' | 'rolled-back' | 'expired' | 'revoked' | 'superseded' | 'exhausted'
  runIds: readonly string[]; observations: readonly SkillWatchObservation[]; createdAt: number; updatedAt: number; rollbackVersion?: number
}
export interface SkillWatchInput { ownerRouteId: string; skillName: string; version: number; fallbackVersion: number; expiresAt: number; maxRuns: number; failureThreshold: number }
export interface SkillCapture {
  id: string; scope: object; routeReceipt: unknown; ownerRouteId: string; goalId: string; sessionId: string
  nativeGoalId: string; name: string; description: string; parentVersion: number; parentDigest: string | null; definitionDigest: string
  expiresAt: number; state: 'pending' | 'captured' | 'revoked' | 'expired' | 'unsupported' | 'unknown'; candidateId?: string; detail?: string; createdAt: number; updatedAt: number
}
export interface SkillCaptureInput { ownerRouteId: string; goalId: string; sessionId: string; nativeGoalId: string; name: string; description: string; parentVersion: number; expiresAt: number }

function fail(message = 'assistant-skills: store operation rejected'): never { throw new Error(message) }
function json(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !('value' in descriptor) || !json(descriptor.value)) return false
    }
    return true
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  return Object.keys(value).every(key => {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') return false
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && 'value' in descriptor && json(descriptor.value)
  })
}
function clone<T>(value: T): T { if (!json(value)) fail('assistant-skills: invalid JSON value'); return JSON.parse(JSON.stringify(value)) as T }
function scopeKey(scope: unknown): string { if (!scope || typeof scope !== 'object' || Array.isArray(scope) || !json(scope)) fail('assistant-skills: invalid scope'); return acceptanceDigest(scope) }
function name(value: unknown): value is string { return typeof value === 'string' && /^[a-z](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(value) }
function version(value: unknown, allowZero = false): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= 1_000_000_000 }
function text(value: unknown, maximum = 512): value is string { return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{Cc}]/u.test(value) }
function runId(scope: unknown, sessionId: string, invocationId: string): string { return `skill-run-${acceptanceDigest([scope, sessionId, invocationId])}` }
function comparisonId(scope: unknown, sessionId: string, invocationId: string): string { return `skill-comparison-${acceptanceDigest([scope, sessionId, invocationId])}` }
function watchId(scope: unknown, input: SkillWatchInput): string { return `skill-watch-${acceptanceDigest([scope, input])}` }
function definitionValid(definition: unknown): definition is SkillDefinition { return !!definition && typeof definition === 'object' && (definition as SkillDefinition).protocol === 'assistant-skills/definition/v1' && name((definition as SkillDefinition).name) && json(definition) }

function privatePath(path: string): void {
  if (!isAbsolute(path)) fail('assistant-skills: database path must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const directory = lstatSync(dirname(path))
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0) fail('assistant-skills: unsafe database directory')
  try { lstatSync(path) } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); chmodSync(path, 0o600)
  }
  for (const item of [path, `${path}-wal`, `${path}-shm`]) {
    try { const stat = lstatSync(item); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) fail('assistant-skills: unsafe database file') } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
    }
  }
}

/** Owner-scoped immutable definitions and no-replay invocation receipts. */
export class SkillStore {
  readonly #db: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') privatePath(path)
    this.#db = new DatabaseSync(path)
    this.#db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=250;
      CREATE TABLE IF NOT EXISTS skill_definitions(scope_key TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL, retired INTEGER NOT NULL, definition_json TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(scope_key,name,version)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_runs(id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, identity_json TEXT NOT NULL, run_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('running','succeeded','failed','unknown'))) STRICT;
      CREATE TABLE IF NOT EXISTS skill_candidates(scope_key TEXT NOT NULL, id TEXT NOT NULL, candidate_json TEXT NOT NULL, PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_comparisons(scope_key TEXT NOT NULL,id TEXT NOT NULL,profile_id TEXT NOT NULL,identity_json TEXT NOT NULL,comparison_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('running','complete','unknown')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_watches(scope_key TEXT NOT NULL,id TEXT NOT NULL,watch_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('watching','rolled-back','expired','revoked','superseded','exhausted')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_captures(scope_key TEXT NOT NULL,id TEXT NOT NULL,capture_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','captured','revoked','expired','unsupported','unknown')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS skill_definitions_current ON skill_definitions(scope_key,name,version DESC);
      CREATE INDEX IF NOT EXISTS skill_runs_scope ON skill_runs(scope_key,id);
      CREATE INDEX IF NOT EXISTS skill_watches_scope_state ON skill_watches(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_captures_scope_state ON skill_captures(scope_key,state);
`)
    this.#db.prepare("UPDATE skill_runs SET state='unknown', run_json=json_set(run_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.prepare("UPDATE skill_comparisons SET state='unknown', comparison_json=json_set(comparison_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_runs_one_active ON skill_runs(scope_key,json_extract(identity_json,'$.sessionId'),json_extract(identity_json,'$.goalId')) WHERE state='running'")
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_comparisons_one_active ON skill_comparisons(scope_key) WHERE state='running'")
  }
  close(): void { this.#db.close() }
  save(scope: object, definition: SkillDefinition, expectedVersion = 0): StoredSkillDefinition {
    const key = scopeKey(scope)
    if (!definitionValid(definition) || !version(expectedVersion, true)) fail('assistant-skills: invalid definition')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, definition.name)
      if ((current?.version ?? 0) !== expectedVersion) fail('assistant-skills: version conflict')
      const saved = this.#newDefinition(definition, expectedVersion + 1, current?.version ?? null)
      this.#insertDefinition(key, saved)
      this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  list(scope: object): StoredSkillDefinition[] {
    const key = scopeKey(scope)
    return (this.#db.prepare(`SELECT definition_json FROM skill_definitions current WHERE scope_key=? AND retired=0
      AND version=(SELECT MAX(version) FROM skill_definitions versions WHERE versions.scope_key=current.scope_key AND versions.name=current.name) ORDER BY name`).all(key) as { definition_json: string }[])
      .map(row => clone(JSON.parse(row.definition_json) as StoredSkillDefinition))
  }
  get(scope: object, skillName: string, wantedVersion?: number): StoredSkillDefinition | undefined {
    const key = scopeKey(scope); if (!name(skillName) || wantedVersion !== undefined && !version(wantedVersion)) fail('assistant-skills: invalid skill reference')
    if (wantedVersion === undefined) {
      const current = this.#latest(key, skillName)
      return current === undefined || current.retired ? undefined : clone(current)
    }
    const row = this.#db.prepare('SELECT definition_json FROM skill_definitions WHERE scope_key=? AND name=? AND version=?').get(key, skillName, wantedVersion)
    return row === undefined ? undefined : clone(JSON.parse((row as { definition_json: string }).definition_json) as StoredSkillDefinition)
  }
  retire(scope: object, skillName: string, expectedVersion: number): StoredSkillDefinition {
    const key = scopeKey(scope); if (!name(skillName) || !version(expectedVersion)) fail('assistant-skills: invalid skill reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, skillName)
      if (!current || current.version !== expectedVersion || current.retired) fail('assistant-skills: version conflict')
      const now = Date.now(); const retired = { ...current, retired: true, updatedAt: now }
      if (this.#db.prepare('UPDATE skill_definitions SET retired=1, definition_json=?, updated_at=? WHERE scope_key=? AND name=? AND version=? AND retired=0').run(JSON.stringify(retired), now, key, skillName, expectedVersion).changes !== 1) fail('assistant-skills: version conflict')
      this.#db.exec('COMMIT'); return clone(retired)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stageCandidate(scope: object, definition: SkillDefinition, options: { expectedVersion: number; reason: string; trigger: string; expiresAt: number }): SkillCandidate {
    const key = scopeKey(scope)
    if (!definitionValid(definition) || !options || !version(options.expectedVersion, true) || !text(options.reason, 1024) || !text(options.trigger, 1024)
      || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000) fail('assistant-skills: invalid candidate')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, definition.name)
      if (current?.retired || (current?.version ?? 0) !== options.expectedVersion || options.expectedVersion === 0 && current) fail('assistant-skills: version conflict')
      const parentDigest = current ? acceptanceDigest(current) : null
      const id = `skill-candidate-${acceptanceDigest([scope, definition, options.expectedVersion, parentDigest, options.reason, options.trigger])}`
      const existing = this.#candidate(key, id)
      if (existing) {
        if (existing.state !== 'pending') fail('assistant-skills: candidate conflict')
        this.#db.exec('COMMIT'); return clone(existing)
      }
      const now = Date.now(); const candidate: SkillCandidate = { id, definition: clone(definition), parentVersion: options.expectedVersion, parentDigest, reason: options.reason, trigger: options.trigger, expiresAt: options.expiresAt, state: 'pending', createdAt: now, updatedAt: now }
      this.#putCandidate(key, candidate); this.#db.exec('COMMIT'); return clone(candidate)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getCandidate(scope: object, id: string): SkillCandidate | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid candidate reference')
    const candidate = this.#candidate(key, id); return candidate === undefined ? undefined : clone(candidate)
  }
  listCandidates(scope: object): SkillCandidate[] {
    const key = scopeKey(scope)
    return (this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? ORDER BY id').all(key) as { candidate_json: string }[]).map(row => clone(JSON.parse(row.candidate_json) as SkillCandidate))
  }
  createCapture(scope: object, input: SkillCaptureInput, routeReceipt: unknown, definitionDigest: string): SkillCapture {
    const key = scopeKey(scope)
    if (!input || !text(input.ownerRouteId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 256) || !text(input.nativeGoalId, 256) || !name(input.name) || !text(input.description, 512)
      || !version(input.parentVersion, true) || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000 || !/^[a-f0-9]{64}$/u.test(definitionDigest)) fail('assistant-skills: invalid capture')
    this.#db.exec('BEGIN IMMEDIATE'); try {
      const current = this.#latest(key, input.name), parentDigest = current ? acceptanceDigest(current) : null
      if (current?.retired || (current?.version ?? 0) !== input.parentVersion || (input.parentVersion === 0 && current) || parentDigest !== (input.parentVersion ? parentDigest : null)) fail('assistant-skills: version conflict')
      const id = `skill-capture-${acceptanceDigest([scope, input, parentDigest, definitionDigest])}`, existing = this.#capture(key, id)
      if (existing) { this.#db.exec('COMMIT'); return clone(existing) }
      const now = Date.now(), capture: SkillCapture = { id, scope: clone(scope), routeReceipt: clone(routeReceipt), ownerRouteId: input.ownerRouteId, goalId: input.goalId, sessionId: input.sessionId, nativeGoalId: input.nativeGoalId, name: input.name, description: input.description, parentVersion: input.parentVersion, parentDigest, definitionDigest, expiresAt: input.expiresAt, state: 'pending', createdAt: now, updatedAt: now }
      this.#putCapture(key, capture); this.#db.exec('COMMIT'); return clone(capture)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  listCaptures(scope?: object): SkillCapture[] {
    const rows = scope === undefined ? this.#db.prepare("SELECT capture_json FROM skill_captures WHERE state='pending' ORDER BY id").all() : this.#db.prepare('SELECT capture_json FROM skill_captures WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { capture_json: string }[]).map(row => clone(JSON.parse(row.capture_json) as SkillCapture))
  }
  finishCapture(scope: object, id: string, state: Exclude<SkillCapture['state'], 'pending' | 'captured'>, detail?: string): SkillCapture {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const capture = this.#capture(key, id); if (!capture) fail('assistant-skills: capture missing'); if (capture.state === 'pending') this.#putCapture(key, { ...capture, state, ...(detail ? { detail } : {}), updatedAt: Date.now() }); this.#db.exec('COMMIT'); return clone(this.#capture(key, id)!) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  captureCandidate(scope: object, id: string, definition: SkillDefinition): SkillCapture {
    const key = scopeKey(scope); if (!definitionValid(definition)) fail('assistant-skills: invalid capture definition')
    this.#db.exec('BEGIN IMMEDIATE'); try {
      const capture = this.#capture(key, id); if (!capture) fail('assistant-skills: capture missing'); if (capture.state === 'captured') { this.#db.exec('COMMIT'); return clone(capture) }
      if (capture.state !== 'pending' || capture.expiresAt <= Date.now()) fail('assistant-skills: capture unavailable')
      const current = this.#latest(key, capture.name)
      if (current?.retired || (current?.version ?? 0) !== capture.parentVersion || (current ? acceptanceDigest(current) : null) !== capture.parentDigest || definition.source.goal.id !== capture.goalId || definition.source.goal.sessionId !== capture.sessionId || definition.source.goal.nativeGoalId !== capture.nativeGoalId || definition.source.goal.definition.digest !== capture.definitionDigest) fail('assistant-skills: capture changed')
      const reason = 'Owner-preauthorized automatic capture.', trigger = `owner-route:${capture.ownerRouteId}`
      const candidateId = `skill-candidate-${acceptanceDigest([scope, definition, capture.parentVersion, capture.parentDigest, reason, trigger])}`
      const candidate = this.#candidate(key, candidateId) ?? { id: candidateId, definition: clone(definition), parentVersion: capture.parentVersion, parentDigest: capture.parentDigest, reason, trigger, expiresAt: capture.expiresAt, state: 'pending' as const, createdAt: Date.now(), updatedAt: Date.now() }
      if (candidate.state !== 'pending') fail('assistant-skills: candidate conflict')
      this.#putCandidate(key, candidate)
      const saved = { ...capture, state: 'captured' as const, candidateId: candidate.id, updatedAt: Date.now() }; this.#putCapture(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rejectCandidate(scope: object, id: string): SkillCandidate {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid candidate reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#candidate(key, id); if (!candidate) fail('assistant-skills: candidate missing')
      if (candidate.state === 'activated') fail('assistant-skills: candidate conflict')
      if (candidate.state === 'pending') { candidate.state = 'rejected'; candidate.updatedAt = Date.now(); this.#putCandidate(key, candidate) }
      this.#db.exec('COMMIT'); return clone(candidate)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  activateCandidate(scope: object, id: string, trialRunId: string, receipt: string, watch?: { input: SkillWatchInput; routeReceipt: unknown }): StoredSkillDefinition {
    const key = scopeKey(scope)
    const watchDigest = watch === undefined ? undefined : acceptanceDigest(clone(watch))
    if (!text(id, 128) || !text(trialRunId, 128) || !text(receipt, 1024)) fail('assistant-skills: invalid candidate activation')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#candidate(key, id); if (!candidate) fail('assistant-skills: candidate missing')
      if (candidate.state === 'activated') {
        if (candidate.trialRunId !== trialRunId || candidate.acceptanceDigest !== receipt || !candidate.activatedVersion
          || candidate.activationWatchDigest !== watchDigest) fail('assistant-skills: candidate conflict')
        const activated = this.get(scope, candidate.definition.name, candidate.activatedVersion)
        if (!activated) fail('assistant-skills: candidate conflict')
        this.#db.exec('COMMIT'); return activated
      }
      if (candidate.state !== 'pending' || candidate.expiresAt <= Date.now()) fail('assistant-skills: candidate unavailable')
      const current = this.#latest(key, candidate.definition.name)
      if (current?.retired || (current?.version ?? 0) !== candidate.parentVersion || (current ? acceptanceDigest(current) : null) !== candidate.parentDigest) fail('assistant-skills: version conflict')
      const run = this.#run(key, trialRunId)
      if (!run || run.state !== 'succeeded' || run.candidateId !== id || !run.goalExecutionRunId) fail('assistant-skills: trial acceptance required')
      const activated = this.#newDefinition(candidate.definition, candidate.parentVersion + 1, candidate.parentVersion || null)
      this.#insertDefinition(key, activated)
      if (watch && (watch.input.skillName !== activated.name || watch.input.version !== activated.version || watch.input.fallbackVersion !== candidate.parentVersion)) fail('assistant-skills: activation watch conflict')
      // The definition, candidate and exact-version watch share this writer
      // transaction. A failed watch cannot leave an unobserved active version.
      const createdWatch = watch && this.#createWatch(scope, watch.input, watch.routeReceipt)
      const saved: SkillCandidate = { ...candidate, state: 'activated', activatedVersion: activated.version, trialRunId, acceptanceDigest: receipt, updatedAt: Date.now(),
        ...(createdWatch ? { activationWatchDigest: watchDigest!, activationWatchId: createdWatch.id } : {}) }
      this.#putCandidate(key, saved); this.#db.exec('COMMIT'); return clone(activated)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rollback(scope: object, skillName: string, expectedVersion: number, targetVersion: number): StoredSkillDefinition {
    const key = scopeKey(scope); if (!name(skillName) || !version(expectedVersion) || !version(targetVersion)) fail('assistant-skills: invalid skill reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, skillName)
      if (current && !current.retired && current.version === expectedVersion + 1 && current.parentVersion === expectedVersion && current.restoredFromVersion === targetVersion) {
        this.#db.exec('COMMIT'); return clone(current)
      }
      if (!current || current.retired || current.version !== expectedVersion || current.parentVersion !== targetVersion) fail('assistant-skills: version conflict')
      const target = this.get(scope, skillName, targetVersion)
      if (!target || target.retired) fail('assistant-skills: version conflict')
      const restored = this.#newDefinition(target, expectedVersion + 1, expectedVersion, targetVersion)
      this.#insertDefinition(key, restored); this.#db.exec('COMMIT'); return clone(restored)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown): SkillWatch {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const watch = this.#createWatch(scope, input, routeReceipt); this.#db.exec('COMMIT'); return watch }
    catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown): SkillWatch {
    const key = scopeKey(scope)
    if (!input || !routeReceipt || !json(routeReceipt) || !text(input.ownerRouteId, 128) || !name(input.skillName) || !version(input.version) || !version(input.fallbackVersion)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.failureThreshold) || input.failureThreshold < 1 || input.failureThreshold > input.maxRuns) fail('assistant-skills: invalid watch')
    const active = this.#latest(key, input.skillName), fallback = this.get(scope, input.skillName, input.fallbackVersion)
    if (!active || active.retired || active.version !== input.version || active.parentVersion !== input.fallbackVersion || !fallback || fallback.retired) fail('assistant-skills: watch version conflict')
    const id = watchId(scope, input), existing = this.#watch(key, id)
    if (existing) return clone(existing)
    const now = Date.now(); const afterRunRowId = (this.#db.prepare('SELECT coalesce(max(rowid),0) AS rowId FROM skill_runs').get() as { rowId: number }).rowId
    const watch: SkillWatch = { id, scope: clone(scope), routeReceipt: clone(routeReceipt), afterRunRowId, ownerRouteId: input.ownerRouteId, skillName: input.skillName, version: input.version, definitionDigest: acceptanceDigest(active), fallbackVersion: input.fallbackVersion, fallbackDigest: acceptanceDigest(fallback), expiresAt: input.expiresAt, maxRuns: input.maxRuns, failureThreshold: input.failureThreshold, state: 'watching', runIds: [], observations: [], createdAt: now, updatedAt: now }
    this.#putWatch(key, watch); return clone(watch)
  }
  listWatches(scope?: object): SkillWatch[] {
    const rows = scope === undefined ? this.#db.prepare('SELECT watch_json FROM skill_watches WHERE state=\'watching\' ORDER BY id').all() : this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { watch_json: string }[]).map(row => clone(JSON.parse(row.watch_json) as SkillWatch))
  }
  #attachWatchRun(scope: object, run: SkillRun): void {
    const key = scopeKey(scope); if (run.state !== 'succeeded' || !run.goalExecutionRunId || run.candidateId !== undefined) return
    for (const watch of this.#watches(key, 'watching')) {
      if (watch.expiresAt <= Date.now()) { this.#putWatch(key, { ...watch, state: 'expired', updatedAt: Date.now() }); continue }
      const rowId = (this.#db.prepare('SELECT rowid AS rowId FROM skill_runs WHERE id=?').get(run.id) as { rowId: number } | undefined)?.rowId
      if (!Number.isSafeInteger(watch.afterRunRowId) || rowId === undefined || rowId <= watch.afterRunRowId || run.createdAt < watch.createdAt || watch.skillName !== run.skillName || watch.version !== run.version || watch.definitionDigest !== acceptanceDigest(this.get(scope, run.skillName, run.version))) continue
      if (watch.runIds.includes(run.id)) continue
      if (watch.runIds.length >= watch.maxRuns) continue
      this.#putWatch(key, { ...watch, runIds: [...watch.runIds, run.id], updatedAt: Date.now() })
    }
  }
  observeWatch(scope: object, id: string, observation: SkillWatchObservation): SkillWatch | undefined {
    const key = scopeKey(scope); if (!text(id, 128) || !text(observation.runId, 128) || !/^[a-f0-9]{64}$/u.test(observation.receiptDigest) || !['achieved', 'not-achieved'].includes(observation.objectiveStatus) || !Number.isSafeInteger(observation.verifiedAt) || !Number.isSafeInteger(observation.validUntil)) fail('assistant-skills: invalid watch observation')
    this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      if (!watch.runIds.includes(observation.runId) || watch.observations.some(value => value.receiptDigest === observation.receiptDigest || value.runId === observation.runId) || observation.verifiedAt < watch.createdAt || observation.verifiedAt > Date.now() || observation.validUntil <= Date.now()) { this.#db.exec('COMMIT'); return clone(watch) }
      const saved = { ...watch, observations: [...watch.observations, clone(observation)], updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stopWatch(scope: object, id: string, state: Extract<SkillWatch['state'], 'expired' | 'revoked' | 'superseded' | 'exhausted'>): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }; const saved = { ...watch, state, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rollbackWatch(scope: object, id: string): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      if (watch.expiresAt <= Date.now()) { const saved = { ...watch, state: 'expired' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) }
      const failures = watch.observations.filter(value => value.objectiveStatus === 'not-achieved').length
      if (failures < watch.failureThreshold) { this.#db.exec('COMMIT'); return clone(watch) }
      const current = this.#latest(key, watch.skillName), target = this.get(scope, watch.skillName, watch.fallbackVersion)
      if (!current || current.retired || current.version !== watch.version || acceptanceDigest(current) !== watch.definitionDigest || current.parentVersion !== watch.fallbackVersion || !target || target.retired || acceptanceDigest(target) !== watch.fallbackDigest) { const saved = { ...watch, state: 'superseded' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) }
      const restored = this.#newDefinition(target, current.version + 1, current.version, watch.fallbackVersion)
      this.#insertDefinition(key, restored); const saved = { ...watch, state: 'rolled-back' as const, rollbackVersion: restored.version, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  claim(scope: object, input: SkillRunClaim): { claimed: boolean; run: SkillRun } {
    const key = scopeKey(scope); this.#validateClaim(scope, input)
    const id = runId(scope, input.sessionId, input.invocationId)
    const identity = clone({ invocationId: input.invocationId, goalId: input.goalId, sessionId: input.sessionId, skillName: input.skillName, version: input.version, inputs: input.inputs, ...(input.goalExecutionRunId === undefined ? {} : { goalExecutionRunId: input.goalExecutionRunId }),
      ...(input.goalDefinitionDigest === undefined ? {} : { goalDefinitionDigest: input.goalDefinitionDigest }), ...(input.nativeGoalId === undefined ? {} : { nativeGoalId: input.nativeGoalId }), ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId }) })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (input.candidateId !== undefined) this.#validateTrialClaim(key, input)
      const existing = this.#db.prepare('SELECT identity_json,run_json FROM skill_runs WHERE id=? AND scope_key=?').get(id, key) as { identity_json: string; run_json: string } | undefined
      if (existing) {
        if (acceptanceDigest(identity) !== acceptanceDigest(JSON.parse(existing.identity_json))) fail('assistant-skills: invocation conflict')
        this.#db.exec('COMMIT'); return { claimed: false, run: clone(JSON.parse(existing.run_json) as SkillRun) }
      }
      const unresolved = this.#db.prepare("SELECT run_json FROM skill_runs WHERE scope_key=? AND json_extract(identity_json,'$.sessionId')=? AND json_extract(identity_json,'$.goalId')=? AND json_extract(identity_json,'$.skillName')=? AND json_extract(identity_json,'$.version')=? AND coalesce(json_extract(identity_json,'$.candidateId'),'')=coalesce(?, '') AND state IN ('running','unknown') LIMIT 1")
        .get(key, input.sessionId, input.goalId, input.skillName, input.version, input.candidateId ?? null) as { run_json: string } | undefined
      if (unresolved) fail('assistant-skills: unresolved invocation for this Goal; inspect skill_status, do not replay')
      const now = Date.now(); const run: SkillRun = { id, ...identity, state: 'running', steps: [], createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?)').run(id, key, JSON.stringify(identity), JSON.stringify(run), run.state)
      this.#db.exec('COMMIT'); return { claimed: true, run: clone(run) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  finish(scope: object, id: string, state: Exclude<SkillRunState, 'running'>, steps: readonly SkillRunStep[]): SkillRun {
    const key = scopeKey(scope)
    if (!text(id, 128) || !['succeeded', 'failed', 'unknown'].includes(state)) fail('assistant-skills: invalid run completion')
    this.#validateSteps(steps)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.getRun(scope, id)
      if (!current || current.state !== 'running') fail('assistant-skills: run state conflict')
      const completed: SkillRun = { ...current, state, steps: clone(steps), updatedAt: Date.now() }
      if (this.#db.prepare("UPDATE skill_runs SET state=?,run_json=? WHERE id=? AND scope_key=? AND state='running'").run(state, JSON.stringify(completed), id, key).changes !== 1) fail('assistant-skills: run state conflict')
      this.#attachWatchRun(scope, completed)
      this.#db.exec('COMMIT'); return clone(completed)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }

  checkpoint(scope: object, id: string, steps: readonly SkillRunStep[]): SkillRun {
    const key = scopeKey(scope); this.#validateSteps(steps)
    const current = this.getRun(scope, id)
    if (!current || current.state !== 'running') fail('assistant-skills: run state conflict')
    const updated: SkillRun = { ...current, steps: clone(steps), updatedAt: Date.now() }
    if (this.#db.prepare("UPDATE skill_runs SET run_json=? WHERE id=? AND scope_key=? AND state='running'").run(JSON.stringify(updated), id, key).changes !== 1) fail('assistant-skills: run state conflict')
    return clone(updated)
  }
  getRun(scope: object, id: string): SkillRun | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid run reference')
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE id=? AND scope_key=?').get(id, key) as { run_json: string } | undefined
    return row === undefined ? undefined : clone(JSON.parse(row.run_json) as SkillRun)
  }
  claimComparison(scope: object, identity: SkillComparisonIdentity, maxComparisons: number): { claimed: boolean; comparison: SkillComparison } {
    const key = scopeKey(scope)
    if (!identity || !text(identity.sessionId) || !text(identity.candidateId, 128) || !/^[a-f0-9]{64}$/u.test(identity.parentDigest) || !text(identity.profileId) || !/^[a-f0-9]{64}$/u.test(identity.profileDigest) || !text(identity.invocationId) || !Number.isSafeInteger(maxComparisons) || maxComparisons < 1 || maxComparisons > 100) fail('assistant-skills: invalid comparison')
    const id = comparisonId(scope, identity.sessionId, identity.invocationId); this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#db.prepare('SELECT identity_json,comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key, id) as { identity_json: string; comparison_json: string } | undefined
      if (existing) { if (acceptanceDigest(JSON.parse(existing.identity_json)) !== acceptanceDigest(identity)) fail('assistant-skills: comparison conflict'); this.#db.exec('COMMIT'); return { claimed: false, comparison: clone(JSON.parse(existing.comparison_json) as SkillComparison) } }
      const candidate = this.#candidate(key, identity.candidateId); const current = candidate && this.#latest(key, candidate.definition.name)
      if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now() || candidate.parentVersion <= 0 || candidate.parentDigest !== identity.parentDigest || !current || current.retired || current.version !== candidate.parentVersion || acceptanceDigest(current) !== candidate.parentDigest) fail('assistant-skills: candidate unavailable')
      const used = (this.#db.prepare('SELECT count(*) AS count FROM skill_comparisons WHERE scope_key=? AND profile_id=?').get(key, identity.profileId) as { count: number }).count
      if (used >= maxComparisons) fail('assistant-skills: comparison budget exhausted')
      const now = Date.now(); const comparison: SkillComparison = { id, ...clone(identity), state: 'running', result: null, createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_comparisons VALUES(?,?,?,?,?,?)').run(key,id,identity.profileId,JSON.stringify(identity),JSON.stringify(comparison),'running'); this.#db.exec('COMMIT'); return { claimed: true, comparison: clone(comparison) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getComparison(scope: object, id: string): SkillComparison | undefined { const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid comparison reference'); const row = this.#db.prepare('SELECT comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key,id) as { comparison_json: string } | undefined; return row ? clone(JSON.parse(row.comparison_json) as SkillComparison) : undefined }
  finishComparison(scope: object, id: string, state: 'complete' | 'unknown', result: unknown): SkillComparison { const key = scopeKey(scope); if (!text(id,128) || !['complete','unknown'].includes(state) || !json(result)) fail('assistant-skills: invalid comparison'); const current = this.getComparison(scope,id); if (!current || current.state !== 'running') fail('assistant-skills: comparison state conflict'); const saved = { ...current, state, result: clone(result), updatedAt: Date.now() }; if (this.#db.prepare("UPDATE skill_comparisons SET state=?,comparison_json=? WHERE scope_key=? AND id=? AND state='running'").run(state,JSON.stringify(saved),key,id).changes !== 1) fail('assistant-skills: comparison state conflict'); return clone(saved) }
  #latest(key: string, skillName: string): StoredSkillDefinition | undefined {
    const row = this.#db.prepare('SELECT definition_json FROM skill_definitions WHERE scope_key=? AND name=? ORDER BY version DESC LIMIT 1').get(key, skillName) as { definition_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.definition_json) as StoredSkillDefinition
  }
  #newDefinition(definition: SkillDefinition, savedVersion: number, parentVersion: number | null, restoredFromVersion?: number): StoredSkillDefinition {
    const now = Date.now()
    const clean: SkillDefinition = { protocol: definition.protocol, name: definition.name, description: definition.description, source: definition.source, inputs: definition.inputs, steps: definition.steps,
      preconditions: definition.preconditions, compensation: definition.compensation }
    return { ...clone(clean), version: savedVersion, parentVersion, retired: false, createdAt: now, updatedAt: now, ...(restoredFromVersion === undefined ? {} : { restoredFromVersion }) }
  }
  #insertDefinition(key: string, saved: StoredSkillDefinition): void {
    this.#db.prepare('INSERT INTO skill_definitions VALUES(?,?,?,?,?,?,?)').run(key, saved.name, saved.version, 0, JSON.stringify(saved), saved.createdAt, saved.updatedAt)
  }
  #candidate(key: string, id: string): SkillCandidate | undefined {
    const row = this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? AND id=?').get(key, id) as { candidate_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.candidate_json) as SkillCandidate
  }
  #capture(key: string, id: string): SkillCapture | undefined { const row = this.#db.prepare('SELECT capture_json FROM skill_captures WHERE scope_key=? AND id=?').get(key, id) as { capture_json: string } | undefined; return row ? JSON.parse(row.capture_json) as SkillCapture : undefined }
  #watch(key: string, id: string): SkillWatch | undefined { const row = this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND id=?').get(key, id) as { watch_json: string } | undefined; return row ? JSON.parse(row.watch_json) as SkillWatch : undefined }
  #watches(key: string, state: SkillWatch['state']): SkillWatch[] { return (this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND state=?').all(key, state) as { watch_json: string }[]).map(row => JSON.parse(row.watch_json) as SkillWatch) }
  #putWatch(key: string, watch: SkillWatch): void { this.#db.prepare('INSERT INTO skill_watches(scope_key,id,watch_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET watch_json=excluded.watch_json,state=excluded.state').run(key, watch.id, JSON.stringify(watch), watch.state) }
  #putCandidate(key: string, candidate: SkillCandidate): void {
    this.#db.prepare('INSERT INTO skill_candidates(scope_key,id,candidate_json) VALUES(?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET candidate_json=excluded.candidate_json').run(key, candidate.id, JSON.stringify(candidate))
  }
  #putCapture(key: string, capture: SkillCapture): void { this.#db.prepare('INSERT INTO skill_captures(scope_key,id,capture_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET capture_json=excluded.capture_json,state=excluded.state').run(key, capture.id, JSON.stringify(capture), capture.state) }
  #run(key: string, id: string): SkillRun | undefined {
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE scope_key=? AND id=?').get(key, id) as { run_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.run_json) as SkillRun
  }
  #validateClaim(scope: object, input: SkillRunClaim): void {
    if (!input || !text(input.invocationId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 512) || !name(input.skillName) || !version(input.version) || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || !json(input.inputs)
      || input.goalExecutionRunId !== undefined && !text(input.goalExecutionRunId, 256) || input.goalDefinitionDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.goalDefinitionDigest) || input.nativeGoalId !== undefined && !text(input.nativeGoalId, 256) || input.candidateId !== undefined && !text(input.candidateId, 128)
      || input.candidateId !== undefined && input.goalExecutionRunId === undefined) fail('assistant-skills: invalid invocation')
    if (input.candidateId !== undefined) {
      return
    }
    const active = this.get(scope, input.skillName)
    if (!active || active.version !== input.version) fail('assistant-skills: inactive skill version')
  }
  #validateTrialClaim(key: string, input: SkillRunClaim): void {
    const candidate = this.#candidate(key, input.candidateId!)
    if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now()) fail('assistant-skills: candidate unavailable')
    const current = this.#latest(key, candidate.definition.name)
    if (current?.retired || (current?.version ?? 0) !== candidate.parentVersion || (current ? acceptanceDigest(current) : null) !== candidate.parentDigest
      || input.skillName !== candidate.definition.name || input.version !== candidate.parentVersion + 1) fail('assistant-skills: candidate conflict')
  }
  #validateSteps(steps: readonly SkillRunStep[]): void {
    if (!Array.isArray(steps) || steps.length > 32 || steps.some(step => !step || !text(step.id, 256) || !['succeeded', 'failed', 'unknown'].includes(step.state) || step.detail !== undefined && !text(step.detail, 4096)) || new Set(steps.map(step => step.id)).size !== steps.length) fail('assistant-skills: invalid run completion')
  }
}
