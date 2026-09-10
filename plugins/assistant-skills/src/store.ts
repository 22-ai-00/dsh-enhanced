import { closeSync, constants, lstatSync, mkdirSync, openSync, chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { validateFailureCaptureProvenance, type FailureCaptureProvenance, type SkillDefinition } from './definition.js'

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
  failureProvenance?: FailureCaptureProvenance
  expiresAt: number
  state: 'pending' | 'activated' | 'rejected'
  createdAt: number
  updatedAt: number
  activatedVersion?: number
  trialRunId?: string
  activationComparisonId?: string
  deploymentId?: string
  acceptanceDigest?: string
  activationWatchDigest?: string
  activationWatchId?: string
}
export interface SkillComparisonIdentity { sessionId: string; candidateId: string; parentDigest: string; profileId: string; profileDigest: string; invocationId: string }
export interface SkillComparison extends SkillComparisonIdentity { id: string; state: 'running' | 'complete' | 'unknown'; result: unknown | null; createdAt: number; updatedAt: number }
export type SkillWatchProofVersion = 'sole-skill-run/v1'
export interface SkillWatchTaskFamily { goalDefinitionDigest: string; outcomeProfile: { id: string; version: number; digest: string } }
export interface SkillWatchObservation { runId: string; receiptDigest: string; objectiveStatus: 'achieved' | 'not-achieved'; verifiedAt: number; validUntil: number; executionTraceDigest: string; taskFamilyDigest?: string }
export interface SkillWatch {
  id: string; scope: object; routeReceipt: unknown; afterRunRowId: number; ownerRouteId: string; skillName: string; version: number; definitionDigest: string; fallbackVersion: number; fallbackDigest: string
  expiresAt: number; maxRuns: number; failureThreshold: number; state: 'watching' | 'rolled-back' | 'expired' | 'revoked' | 'superseded' | 'exhausted'
  runIds: readonly string[]; observations: readonly SkillWatchObservation[]; createdAt: number; updatedAt: number; rollbackVersion?: number; proofVersion?: SkillWatchProofVersion; taskFamily?: SkillWatchTaskFamily
}
export interface SkillWatchInput { ownerRouteId: string; skillName: string; version: number; fallbackVersion: number; expiresAt: number; maxRuns: number; failureThreshold: number }
export interface SkillDeploymentInput { ownerRouteId: string; expiresAt: number; maxRuns: number; canaryRuns: number }
export interface SkillDeploymentAdmission { protocol: 'assistant-skills/canary-admission/v1'; skillName: string; parentDefinitionDigest: string; candidateDefinitionDigest: string; taskFamily: SkillWatchTaskFamily }
export interface SkillDeployment {
  id: string; scope: object; candidateId: string; comparisonId: string; qualificationDigest: string; admissionDigest: string; candidateDefinitionDigest: string; routeReceipt: unknown; ownerRouteId: string
  skillName: string; version: number; definitionDigest: string; parentVersion: number; watchId: string; taskFamily: SkillWatchTaskFamily
  expiresAt: number; maxRuns: number; canaryRuns: number; runIds: string[]
  state: 'canary' | 'promoted' | 'blocked' | 'expired' | 'revoked' | 'rolled-back' | 'superseded'
  createdAt: number; updatedAt: number
}
export interface SkillCapture {
  id: string; scope: object; routeReceipt: unknown; ownerRouteId: string; goalId: string; sessionId: string
  nativeGoalId: string; name: string; description: string; parentVersion: number; parentDigest: string | null; definitionDigest: string
  expiresAt: number; state: 'pending' | 'captured' | 'revoked' | 'expired' | 'unsupported' | 'unknown'; candidateId?: string; detail?: string; createdAt: number; updatedAt: number
}
export interface SkillCaptureInput { ownerRouteId: string; goalId: string; sessionId: string; nativeGoalId: string; name: string; description: string; parentVersion: number; expiresAt: number }
export interface SkillCandidateOptions { expectedVersion: number; reason: string; trigger: string; expiresAt: number; failureProvenance?: FailureCaptureProvenance }

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
function deploymentId(scope: unknown, candidateId: string, comparisonId: string, qualificationDigest: string, admission: SkillDeploymentAdmission, input: SkillDeploymentInput, routeReceipt: unknown): string { return `skill-deployment-${acceptanceDigest([scope, candidateId, comparisonId, qualificationDigest, admission, input, routeReceipt])}` }
function definitionValid(definition: unknown): definition is SkillDefinition { return !!definition && typeof definition === 'object' && (definition as SkillDefinition).protocol === 'assistant-skills/definition/v1' && name((definition as SkillDefinition).name) && json(definition) }
function digest(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) }
function recordWithDigest(value: unknown, field: string, expected: string): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
    && Object.hasOwn(value, field) && (value as Record<string, unknown>)[field] === expected
}
function deploymentAdmission(value: unknown): value is SkillDeploymentAdmission {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !json(value)) return false
  const admission = value as SkillDeploymentAdmission
  return Object.keys(admission).length === 5 && admission.protocol === 'assistant-skills/canary-admission/v1' && name(admission.skillName)
    && digest(admission.parentDefinitionDigest) && digest(admission.candidateDefinitionDigest) && !!admission.taskFamily
    && Object.keys(admission.taskFamily).length === 2 && digest(admission.taskFamily.goalDefinitionDigest) && !!admission.taskFamily.outcomeProfile
    && Object.keys(admission.taskFamily.outcomeProfile).length === 3 && text(admission.taskFamily.outcomeProfile.id, 256)
    && version(admission.taskFamily.outcomeProfile.version) && digest(admission.taskFamily.outcomeProfile.digest)
}
function candidateOptions(value: unknown): value is SkillCandidateOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Object.keys(descriptors)
  return keys.every(key => ['expectedVersion', 'reason', 'trigger', 'expiresAt', 'failureProvenance'].includes(key))
    && ['expectedVersion', 'reason', 'trigger', 'expiresAt'].every(key => keys.includes(key))
    && Object.values(descriptors).every(descriptor => descriptor.enumerable && 'value' in descriptor)
}

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
      CREATE TABLE IF NOT EXISTS skill_deployments(scope_key TEXT NOT NULL,id TEXT NOT NULL,deployment_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('canary','promoted','blocked','expired','revoked','rolled-back','superseded')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS skill_captures(scope_key TEXT NOT NULL,id TEXT NOT NULL,capture_json TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('pending','captured','revoked','expired','unsupported','unknown')),PRIMARY KEY(scope_key,id)) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS skill_definitions_current ON skill_definitions(scope_key,name,version DESC);
      CREATE INDEX IF NOT EXISTS skill_runs_scope ON skill_runs(scope_key,id);
      CREATE INDEX IF NOT EXISTS skill_watches_scope_state ON skill_watches(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_deployments_scope_state ON skill_deployments(scope_key,state);
      CREATE INDEX IF NOT EXISTS skill_captures_scope_state ON skill_captures(scope_key,state);
`)
    this.#db.prepare("UPDATE skill_runs SET state='unknown', run_json=json_set(run_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.prepare("UPDATE skill_watches SET state='revoked', watch_json=json_set(watch_json, '$.state', 'revoked', '$.updatedAt', ?) WHERE state='watching' AND (coalesce(json_extract(watch_json, '$.proofVersion'), '')<>'sole-skill-run/v1' OR EXISTS (SELECT 1 FROM skill_deployments deployment WHERE deployment.scope_key=skill_watches.scope_key AND json_extract(deployment.deployment_json, '$.watchId')=skill_watches.id AND deployment.state IN ('canary','promoted') AND (length(coalesce(json_extract(deployment.deployment_json, '$.admissionDigest'), ''))<>64 OR coalesce(json_extract(deployment.deployment_json, '$.admissionDigest'), '') GLOB '*[^0-9a-f]*' OR length(coalesce(json_extract(deployment.deployment_json, '$.candidateDefinitionDigest'), ''))<>64 OR coalesce(json_extract(deployment.deployment_json, '$.candidateDefinitionDigest'), '') GLOB '*[^0-9a-f]*' OR coalesce(json_type(deployment.deployment_json, '$.taskFamily'), '')<>'object' OR coalesce(json_type(skill_watches.watch_json, '$.taskFamily'), '')<>'object')))").run(Date.now())
    this.#db.prepare("UPDATE skill_deployments SET state='blocked', deployment_json=json_set(deployment_json, '$.state', 'blocked', '$.updatedAt', ?) WHERE state IN ('canary','promoted') AND (length(coalesce(json_extract(deployment_json, '$.admissionDigest'), ''))<>64 OR coalesce(json_extract(deployment_json, '$.admissionDigest'), '') GLOB '*[^0-9a-f]*' OR length(coalesce(json_extract(deployment_json, '$.candidateDefinitionDigest'), ''))<>64 OR coalesce(json_extract(deployment_json, '$.candidateDefinitionDigest'), '') GLOB '*[^0-9a-f]*' OR coalesce(json_type(deployment_json, '$.taskFamily'), '')<>'object' OR NOT EXISTS (SELECT 1 FROM skill_watches watch WHERE watch.scope_key=skill_deployments.scope_key AND watch.id=json_extract(skill_deployments.deployment_json, '$.watchId') AND json_extract(watch.watch_json, '$.proofVersion')='sole-skill-run/v1' AND json_type(watch.watch_json, '$.taskFamily')='object'))").run(Date.now())
    this.#db.prepare("UPDATE skill_deployments SET state='blocked', deployment_json=json_set(deployment_json, '$.state', 'blocked', '$.updatedAt', ?) WHERE state IN ('canary','promoted') AND EXISTS (SELECT 1 FROM json_each(skill_deployments.deployment_json, '$.runIds') claimed JOIN skill_runs run ON run.id=claimed.value AND run.scope_key=skill_deployments.scope_key WHERE run.state IN ('unknown','failed'))").run(Date.now())
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
  stageCandidate(scope: object, definition: SkillDefinition, options: SkillCandidateOptions): SkillCandidate {
    const key = scopeKey(scope)
    if (!definitionValid(definition) || !candidateOptions(options) || !version(options.expectedVersion, true) || !text(options.reason, 1024) || !text(options.trigger, 1024)
      || !Number.isSafeInteger(options.expiresAt) || options.expiresAt <= Date.now() || options.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000) fail('assistant-skills: invalid candidate')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, definition.name)
      if (current?.retired || (current?.version ?? 0) !== options.expectedVersion || options.expectedVersion === 0 && current) fail('assistant-skills: version conflict')
      const parentDigest = current ? acceptanceDigest(current) : null
      const failureProvenance = options.failureProvenance === undefined ? undefined : this.#candidateFailureProvenance(scope, definition, options.expectedVersion, parentDigest, current, options.failureProvenance)
      // Keep the legacy identity formula byte-for-byte when provenance is absent.
      const identity = [scope, definition, options.expectedVersion, parentDigest, options.reason, options.trigger]
      const id = `skill-candidate-${acceptanceDigest(failureProvenance === undefined ? identity : [...identity, failureProvenance])}`
      const existing = this.#candidate(key, id)
      if (existing) {
        if (existing.state !== 'pending') fail('assistant-skills: candidate conflict')
        this.#db.exec('COMMIT'); return clone(existing)
      }
      const now = Date.now(); const candidate: SkillCandidate = { id, definition: clone(definition), parentVersion: options.expectedVersion, parentDigest, reason: options.reason, trigger: options.trigger,
        ...(failureProvenance === undefined ? {} : { failureProvenance }), expiresAt: options.expiresAt, state: 'pending', createdAt: now, updatedAt: now }
      this.#putCandidate(key, candidate); this.#db.exec('COMMIT'); return clone(candidate)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getCandidate(scope: object, id: string): SkillCandidate | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid candidate reference')
    const candidate = this.#candidate(key, id)
    if (candidate !== undefined) this.#assertCandidateFailureProvenance(scope, candidate)
    return candidate === undefined ? undefined : clone(candidate)
  }
  listCandidates(scope: object): SkillCandidate[] {
    const key = scopeKey(scope)
    return (this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? ORDER BY id').all(key) as { candidate_json: string }[]).map(row => {
      const candidate = JSON.parse(row.candidate_json) as SkillCandidate
      this.#assertCandidateFailureProvenance(scope, candidate)
      return clone(candidate)
    })
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
      this.#assertCandidateFailureProvenance(scope, candidate)
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
      this.#assertCandidateFailureProvenance(scope, candidate)
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
      const createdWatch = watch && this.#createWatch(scope, watch.input, watch.routeReceipt, 'sole-skill-run/v1')
      const saved: SkillCandidate = { ...candidate, state: 'activated', activatedVersion: activated.version, trialRunId, acceptanceDigest: receipt, updatedAt: Date.now(),
        ...(createdWatch ? { activationWatchDigest: watchDigest!, activationWatchId: createdWatch.id } : {}) }
      this.#putCandidate(key, saved); this.#db.exec('COMMIT'); return clone(activated)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  activateQualifiedCandidate(scope: object, candidateId: string, comparisonId: string, qualificationDigest: string, admission: SkillDeploymentAdmission, input: SkillDeploymentInput, routeReceipt: unknown): { definition: StoredSkillDefinition; deployment: SkillDeployment } {
    const key = scopeKey(scope)
    if (!text(candidateId, 128) || !text(comparisonId, 128) || !/^[a-f0-9]{64}$/u.test(qualificationDigest) || !deploymentAdmission(admission) || !input || !text(input.ownerRouteId, 128)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 86400000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.canaryRuns) || input.canaryRuns < 1 || input.canaryRuns > input.maxRuns
      || !routeReceipt || !json(routeReceipt)) fail('assistant-skills: invalid qualified activation')
    const admissionDigest = acceptanceDigest(admission), id = deploymentId(scope, candidateId, comparisonId, qualificationDigest, admission, input, routeReceipt)
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#deployment(key, id)
      if (existing) {
        const definition = this.get(scope, existing.skillName, existing.version)
        if (!definition) fail('assistant-skills: deployment conflict')
        this.#db.exec('COMMIT'); return { definition, deployment: clone(existing) }
      }
      const candidate = this.#candidate(key, candidateId)
      const comparison = this.#comparison(key, comparisonId)
      if (candidate) this.#assertCandidateFailureProvenance(scope, candidate)
      if (!candidate || candidate.state !== 'pending' || candidate.expiresAt <= Date.now() || candidate.parentVersion <= 0 || !comparison || comparison.state !== 'complete'
        || comparison.candidateId !== candidateId || !json(comparison.result) || acceptanceDigest(comparison.result) !== qualificationDigest
        || !recordWithDigest(comparison.result, 'admissionDigest', admissionDigest)
        || candidate.definition.name !== admission.skillName || acceptanceDigest(candidate.definition) !== admission.candidateDefinitionDigest
        || candidate.definition.source.goal.definition.digest !== admission.taskFamily.goalDefinitionDigest) fail('assistant-skills: qualification unavailable')
      const current = this.#latest(key, candidate.definition.name)
      if (!current || current.retired || current.version !== candidate.parentVersion || acceptanceDigest(current) !== candidate.parentDigest
        || admission.parentDefinitionDigest !== candidate.parentDigest) fail('assistant-skills: version conflict')
      const definition = this.#newDefinition(candidate.definition, candidate.parentVersion + 1, candidate.parentVersion)
      this.#insertDefinition(key, definition)
      const watch = this.#createWatch(scope, { ownerRouteId: input.ownerRouteId, skillName: definition.name, version: definition.version, fallbackVersion: candidate.parentVersion, expiresAt: input.expiresAt, maxRuns: input.maxRuns, failureThreshold: 1 }, routeReceipt, 'sole-skill-run/v1', admission.taskFamily)
      const now = Date.now()
      const deployment: SkillDeployment = { id, scope: clone(scope), candidateId, comparisonId, qualificationDigest, admissionDigest, candidateDefinitionDigest: admission.candidateDefinitionDigest, taskFamily: clone(admission.taskFamily), routeReceipt: clone(routeReceipt), ownerRouteId: input.ownerRouteId, skillName: definition.name, version: definition.version,
        definitionDigest: acceptanceDigest(definition), parentVersion: candidate.parentVersion, watchId: watch.id, expiresAt: input.expiresAt, maxRuns: input.maxRuns, canaryRuns: input.canaryRuns, runIds: [], state: 'canary', createdAt: now, updatedAt: now }
      this.#putDeployment(key, deployment)
      this.#putCandidate(key, { ...candidate, state: 'activated', activatedVersion: definition.version, activationComparisonId: comparisonId, deploymentId: id, updatedAt: now })
      this.#db.exec('COMMIT'); return { definition: clone(definition), deployment: clone(deployment) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  getDeployment(scope: object, id: string): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    const deployment = this.#deployment(key, id); return deployment === undefined ? undefined : clone(deployment)
  }
  deploymentForVersion(scope: object, skillName: string, wantedVersion: number): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!name(skillName) || !version(wantedVersion)) fail('assistant-skills: invalid deployment reference')
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    const deployment = rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.skillName === skillName && value.version === wantedVersion)
    return deployment === undefined ? undefined : clone(deployment)
  }
  listDeployments(scope?: object): SkillDeployment[] {
    const rows = scope === undefined ? this.#db.prepare('SELECT deployment_json FROM skill_deployments ORDER BY id').all() : this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=? ORDER BY id').all(scopeKey(scope))
    return (rows as { deployment_json: string }[]).map(row => clone(JSON.parse(row.deployment_json) as SkillDeployment))
  }
  reconcileDeployment(scope: object, id: string): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    this.#db.exec('BEGIN IMMEDIATE'); try { const deployment = this.#deployment(key, id); const saved = deployment && this.#reconcileDeployment(key, deployment); this.#db.exec('COMMIT'); return saved && clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stopDeployment(scope: object, id: string, state: Extract<SkillDeployment['state'], 'blocked' | 'revoked'>): SkillDeployment | undefined {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment reference')
    this.#db.exec('BEGIN IMMEDIATE'); try { const deployment = this.#deployment(key, id); if (!deployment || deployment.state !== 'canary' && deployment.state !== 'promoted') { this.#db.exec('COMMIT'); return deployment && clone(deployment) }; const saved = { ...deployment, state, updatedAt: Date.now() }; this.#putDeployment(key, saved); this.#db.exec('COMMIT'); return clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  assertDeploymentRun(scope: object, id: string): SkillDeployment {
    const key = scopeKey(scope); if (!text(id, 128)) fail('assistant-skills: invalid deployment run')
    const deployment = this.#deploymentsForRun(key, id)[0]
    if (!deployment || deployment.state !== 'canary' && deployment.state !== 'promoted' || deployment.expiresAt <= Date.now()) fail('assistant-skills: deployment unavailable')
    const active = this.#latest(key, deployment.skillName)
    if (!active || active.retired || active.version !== deployment.version || acceptanceDigest(active) !== deployment.definitionDigest) fail('assistant-skills: deployment unavailable')
    return clone(deployment)
  }
  rollback(scope: object, skillName: string, expectedVersion: number, targetVersion: number): StoredSkillDefinition {
    const key = scopeKey(scope); if (!name(skillName) || !version(expectedVersion) || !version(targetVersion)) fail('assistant-skills: invalid skill reference')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#latest(key, skillName)
      const failureCandidate = this.#activatedFailureCandidate(key, skillName, expectedVersion)
      const target = this.get(scope, skillName, targetVersion)
      if (failureCandidate) {
        const provenance = this.#assertCandidateFailureProvenance(scope, failureCandidate)
        if (!provenance || !target || target.retired || provenance.rollbackTarget.name !== skillName || provenance.rollbackTarget.version !== targetVersion
          || provenance.rollbackTarget.digest !== acceptanceDigest(target)) fail('assistant-skills: failure rollback target changed')
      }
      if (current && !current.retired && current.version === expectedVersion + 1 && current.parentVersion === expectedVersion && current.restoredFromVersion === targetVersion) {
        this.#db.exec('COMMIT'); return clone(current)
      }
      if (!current || current.retired || current.version !== expectedVersion || current.parentVersion !== targetVersion) fail('assistant-skills: version conflict')
      if (!target || target.retired) fail('assistant-skills: version conflict')
      const restored = this.#newDefinition(target, expectedVersion + 1, expectedVersion, targetVersion)
      this.#insertDefinition(key, restored); this.#db.exec('COMMIT'); return clone(restored)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown): SkillWatch {
    this.#db.exec('BEGIN IMMEDIATE')
    try { const watch = this.#createWatch(scope, input, routeReceipt, 'sole-skill-run/v1'); this.#db.exec('COMMIT'); return watch }
    catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  #createWatch(scope: object, input: SkillWatchInput, routeReceipt: unknown, proofVersion: SkillWatchProofVersion, taskFamily?: SkillWatchTaskFamily): SkillWatch {
    const key = scopeKey(scope)
    if (!input || !routeReceipt || !json(routeReceipt) || !text(input.ownerRouteId, 128) || !name(input.skillName) || !version(input.version) || !version(input.fallbackVersion)
      || !Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000
      || !Number.isSafeInteger(input.maxRuns) || input.maxRuns < 1 || input.maxRuns > 100 || !Number.isSafeInteger(input.failureThreshold) || input.failureThreshold < 1 || input.failureThreshold > input.maxRuns) fail('assistant-skills: invalid watch')
    const active = this.#latest(key, input.skillName), fallback = this.get(scope, input.skillName, input.fallbackVersion)
    if (!active || active.retired || active.version !== input.version || active.parentVersion !== input.fallbackVersion || !fallback || fallback.retired) fail('assistant-skills: watch version conflict')
    const id = watchId(scope, input), existing = this.#watch(key, id)
    if (taskFamily !== undefined && (!deploymentAdmission({ protocol: 'assistant-skills/canary-admission/v1', skillName: input.skillName, parentDefinitionDigest: acceptanceDigest(fallback), candidateDefinitionDigest: acceptanceDigest(active), taskFamily }))) fail('assistant-skills: invalid watch task family')
    if (existing) { if (existing.proofVersion !== proofVersion || acceptanceDigest(existing.taskFamily ?? null) !== acceptanceDigest(taskFamily ?? null)) fail('assistant-skills: watch proof conflict'); return clone(existing) }
    const now = Date.now(); const afterRunRowId = (this.#db.prepare('SELECT coalesce(max(rowid),0) AS rowId FROM skill_runs').get() as { rowId: number }).rowId
    const watch: SkillWatch = { id, scope: clone(scope), routeReceipt: clone(routeReceipt), afterRunRowId, ownerRouteId: input.ownerRouteId, skillName: input.skillName, version: input.version, definitionDigest: acceptanceDigest(active), fallbackVersion: input.fallbackVersion, fallbackDigest: acceptanceDigest(fallback), expiresAt: input.expiresAt, maxRuns: input.maxRuns, failureThreshold: input.failureThreshold, state: 'watching', runIds: [], observations: [], createdAt: now, updatedAt: now, proofVersion, ...(taskFamily === undefined ? {} : { taskFamily: clone(taskFamily) }) }
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
    const key = scopeKey(scope); if (!text(id, 128) || !text(observation.runId, 128) || !/^[a-f0-9]{64}$/u.test(observation.receiptDigest) || !['achieved', 'not-achieved'].includes(observation.objectiveStatus) || !Number.isSafeInteger(observation.verifiedAt) || !Number.isSafeInteger(observation.validUntil)
      || !/^[a-f0-9]{64}$/u.test(observation.executionTraceDigest) || observation.taskFamilyDigest !== undefined && !/^[a-f0-9]{64}$/u.test(observation.taskFamilyDigest)) fail('assistant-skills: invalid watch observation')
    this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      const deployment = this.#deploymentForWatch(key, watch.id)
      if (deployment !== undefined && (watch.taskFamily === undefined || observation.taskFamilyDigest !== acceptanceDigest(watch.taskFamily)) || !watch.runIds.includes(observation.runId)
        || watch.observations.some(value => value.receiptDigest === observation.receiptDigest || value.runId === observation.runId
          || observation.executionTraceDigest !== undefined && value.executionTraceDigest === observation.executionTraceDigest)
        || observation.verifiedAt < watch.createdAt || observation.verifiedAt > Date.now() || observation.validUntil <= Date.now()) { this.#db.exec('COMMIT'); return clone(watch) }
      const saved = { ...watch, observations: [...watch.observations, clone(observation)], updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved)
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  stopWatch(scope: object, id: string, state: Extract<SkillWatch['state'], 'expired' | 'revoked' | 'superseded' | 'exhausted'>): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }; const saved = { ...watch, state, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  rollbackWatch(scope: object, id: string): SkillWatch | undefined {
    const key = scopeKey(scope); this.#db.exec('BEGIN IMMEDIATE'); try { const watch = this.#watch(key, id); if (!watch || watch.state !== 'watching') { this.#db.exec('COMMIT'); return watch && clone(watch) }
      if (watch.expiresAt <= Date.now()) { const saved = { ...watch, state: 'expired' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved) }
      const deployment = this.#deploymentForWatch(key, watch.id)
      // Public standalone watches have no operator-pinned task family. They
      // retain useful outcome observations, but can never supply mutation
      // authority. Only the exact watch created by a qualified canary
      // deployment may append a rollback version.
      if (!deployment || !watch.taskFamily || !['canary', 'promoted', 'blocked'].includes(deployment.state)
        || deployment.watchId !== watch.id || deployment.skillName !== watch.skillName || deployment.version !== watch.version
        || deployment.definitionDigest !== watch.definitionDigest || acceptanceDigest(deployment.taskFamily) !== acceptanceDigest(watch.taskFamily)) {
        this.#db.exec('COMMIT'); return clone(watch)
      }
      const taskFamilyDigest = acceptanceDigest(watch.taskFamily)
      const failures = watch.observations.filter(value => value.objectiveStatus === 'not-achieved' && value.taskFamilyDigest === taskFamilyDigest).length
      if (failures < watch.failureThreshold) { this.#db.exec('COMMIT'); return clone(watch) }
      const current = this.#latest(key, watch.skillName), target = this.get(scope, watch.skillName, watch.fallbackVersion)
      const failureCandidate = this.#activatedFailureCandidate(key, watch.skillName, watch.version)
      if (failureCandidate) {
        const provenance = this.#assertCandidateFailureProvenance(scope, failureCandidate)
        if (!provenance || !target || provenance.rollbackTarget.name !== watch.skillName || provenance.rollbackTarget.version !== watch.fallbackVersion
          || provenance.rollbackTarget.digest !== acceptanceDigest(target)) {
          const saved = { ...watch, state: 'superseded' as const, updatedAt: Date.now() }; this.#putWatch(key, saved); this.#db.exec('COMMIT'); return clone(saved)
        }
      }
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
      if (input.candidateId === undefined) {
        const active = this.#latest(key, input.skillName)
        if (!active || active.retired || active.version !== input.version) fail('assistant-skills: inactive skill version')
        const deployment = this.#deploymentForVersion(key, input.skillName, input.version)
        if (deployment) {
          const reconciled = this.#reconcileDeployment(key, deployment)
          if (reconciled.state !== 'canary' && reconciled.state !== 'promoted' || reconciled.expiresAt <= Date.now()) fail('assistant-skills: deployment unavailable')
          if (acceptanceDigest(active) !== reconciled.definitionDigest || reconciled.runIds.length >= reconciled.maxRuns || reconciled.state === 'canary' && reconciled.runIds.length >= reconciled.canaryRuns) fail('assistant-skills: deployment quota exhausted')
          this.#putDeployment(key, { ...reconciled, runIds: [...reconciled.runIds, id], updatedAt: Date.now() })
        }
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
      if (state === 'failed' || state === 'unknown') {
        for (const deployment of this.#deploymentsForRun(key, id)) {
          if (deployment.state === 'canary' || deployment.state === 'promoted') this.#putDeployment(key, { ...deployment, state: 'blocked', updatedAt: Date.now() })
        }
      }
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
      preconditions: definition.preconditions, compensation: definition.compensation,
      ...(definition.fileObservations === undefined ? {} : { fileObservations: definition.fileObservations }),
      ...(definition.runExpansions === undefined ? {} : { runExpansions: definition.runExpansions }) }
    return { ...clone(clean), version: savedVersion, parentVersion, retired: false, createdAt: now, updatedAt: now, ...(restoredFromVersion === undefined ? {} : { restoredFromVersion }) }
  }
  #insertDefinition(key: string, saved: StoredSkillDefinition): void {
    this.#db.prepare('INSERT INTO skill_definitions VALUES(?,?,?,?,?,?,?)').run(key, saved.name, saved.version, 0, JSON.stringify(saved), saved.createdAt, saved.updatedAt)
  }
  #candidate(key: string, id: string): SkillCandidate | undefined {
    const row = this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=? AND id=?').get(key, id) as { candidate_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.candidate_json) as SkillCandidate
  }
  #candidateFailureProvenance(scope: object, definition: SkillDefinition, expectedVersion: number, parentDigest: string | null, parent: StoredSkillDefinition | undefined, value: unknown): FailureCaptureProvenance {
    const provenance = validateFailureCaptureProvenance(value) as FailureCaptureProvenance
    const parentTools = [...new Set(parent?.steps.map(step => step.toolName) ?? [])].sort()
    const candidateTools = [...new Set(definition.steps.map(step => step.toolName))].sort()
    if (!parent || expectedVersion < 1 || parentDigest === null || acceptanceDigest(parent) !== parentDigest || acceptanceDigest(provenance.trigger.scope) !== acceptanceDigest(scope)
      || provenance.parent.name !== definition.name || provenance.parent.version !== expectedVersion || provenance.parent.digest !== parentDigest
      || provenance.rollbackTarget.name !== definition.name || provenance.rollbackTarget.version !== expectedVersion || provenance.rollbackTarget.digest !== parentDigest
      || provenance.candidate.name !== definition.name || provenance.candidate.definitionDigest !== acceptanceDigest(definition)
      || provenance.repair.sourceDigest !== acceptanceDigest(definition.source) || provenance.repair.acceptanceDigest !== acceptanceDigest(definition.source.acceptance)
      || acceptanceDigest(provenance.repair.goal) !== acceptanceDigest(definition.source.goal)
      || acceptanceDigest(provenance.permissionDelta.parent) !== acceptanceDigest(parentTools)
      || acceptanceDigest(provenance.permissionDelta.candidate) !== acceptanceDigest(candidateTools)) fail('assistant-skills: invalid failure candidate provenance')
    return clone(provenance)
  }
  #assertCandidateFailureProvenance(scope: object, candidate: SkillCandidate): FailureCaptureProvenance | undefined {
    if (candidate.failureProvenance === undefined) return undefined
    const parent = this.#latest(scopeKey(scope), candidate.definition.name)
    return this.#candidateFailureProvenance(scope, candidate.definition, candidate.parentVersion, candidate.parentDigest,
      parent?.version === candidate.parentVersion ? parent : this.get(scope, candidate.definition.name, candidate.parentVersion), candidate.failureProvenance)
  }
  #activatedFailureCandidate(key: string, skillName: string, activatedVersion: number): SkillCandidate | undefined {
    const rows = this.#db.prepare('SELECT candidate_json FROM skill_candidates WHERE scope_key=?').all(key) as { candidate_json: string }[]
    const matches = rows.map(row => JSON.parse(row.candidate_json) as SkillCandidate).filter(candidate => candidate.state === 'activated' && candidate.activatedVersion === activatedVersion
      && candidate.definition.name === skillName && candidate.failureProvenance !== undefined)
    if (matches.length > 1) fail('assistant-skills: failure candidate audit conflict')
    return matches[0]
  }
  #capture(key: string, id: string): SkillCapture | undefined { const row = this.#db.prepare('SELECT capture_json FROM skill_captures WHERE scope_key=? AND id=?').get(key, id) as { capture_json: string } | undefined; return row ? JSON.parse(row.capture_json) as SkillCapture : undefined }
  #watch(key: string, id: string): SkillWatch | undefined { const row = this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND id=?').get(key, id) as { watch_json: string } | undefined; return row ? JSON.parse(row.watch_json) as SkillWatch : undefined }
  #watches(key: string, state: SkillWatch['state']): SkillWatch[] { return (this.#db.prepare('SELECT watch_json FROM skill_watches WHERE scope_key=? AND state=?').all(key, state) as { watch_json: string }[]).map(row => JSON.parse(row.watch_json) as SkillWatch) }
  #putWatch(key: string, watch: SkillWatch): void { this.#db.prepare('INSERT INTO skill_watches(scope_key,id,watch_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET watch_json=excluded.watch_json,state=excluded.state').run(key, watch.id, JSON.stringify(watch), watch.state) }
  #deployment(key: string, id: string): SkillDeployment | undefined { const row = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=? AND id=?').get(key, id) as { deployment_json: string } | undefined; return row ? JSON.parse(row.deployment_json) as SkillDeployment : undefined }
  #deploymentForVersion(key: string, skillName: string, wantedVersion: number): SkillDeployment | undefined {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.skillName === skillName && value.version === wantedVersion)
  }
  #deploymentForWatch(key: string, id: string): SkillDeployment | undefined {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).find(value => value.watchId === id)
  }
  #deploymentsForRun(key: string, run: string): SkillDeployment[] {
    const rows = this.#db.prepare('SELECT deployment_json FROM skill_deployments WHERE scope_key=?').all(key) as { deployment_json: string }[]
    return rows.map(row => JSON.parse(row.deployment_json) as SkillDeployment).filter(value => value.runIds.includes(run))
  }
  #putDeployment(key: string, deployment: SkillDeployment): void { this.#db.prepare('INSERT INTO skill_deployments(scope_key,id,deployment_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET deployment_json=excluded.deployment_json,state=excluded.state').run(key, deployment.id, JSON.stringify(deployment), deployment.state) }
  #comparison(key: string, id: string): SkillComparison | undefined { const row = this.#db.prepare('SELECT comparison_json FROM skill_comparisons WHERE scope_key=? AND id=?').get(key, id) as { comparison_json: string } | undefined; return row ? JSON.parse(row.comparison_json) as SkillComparison : undefined }
  #reconcileDeployment(key: string, deployment: SkillDeployment): SkillDeployment {
    if (deployment.state !== 'canary' && deployment.state !== 'promoted' && deployment.state !== 'blocked') return deployment
    let state: SkillDeployment['state'] | undefined
    const watch = this.#watch(key, deployment.watchId)
    const active = this.#latest(key, deployment.skillName)
    if (watch?.state === 'rolled-back' && watch.skillName === deployment.skillName && watch.version === deployment.version && watch.definitionDigest === deployment.definitionDigest) state = 'rolled-back'
    else if (deployment.state === 'blocked') return deployment
    else if (deployment.expiresAt <= Date.now()) state = 'expired'
    else if (!active || active.retired || active.version !== deployment.version || acceptanceDigest(active) !== deployment.definitionDigest) state = 'superseded'
    else if (!watch || watch.skillName !== deployment.skillName || watch.version !== deployment.version || watch.definitionDigest !== deployment.definitionDigest || watch.maxRuns !== deployment.maxRuns || watch.failureThreshold !== 1) state = 'superseded'
    else if (watch.proofVersion !== 'sole-skill-run/v1' || !watch.taskFamily || acceptanceDigest(watch.taskFamily) !== acceptanceDigest(deployment.taskFamily)) state = 'blocked'
    else if (watch.state === 'expired') state = 'expired'
    else if (watch.state === 'revoked') state = 'revoked'
    else if (watch.state === 'superseded') state = 'superseded'
    else if (deployment.runIds.some(id => { const run = this.#run(key, id); return !run || run.state === 'failed' || run.state === 'unknown' })) state = 'blocked'
    else if (watch.observations.some(value => value.objectiveStatus === 'not-achieved' && value.taskFamilyDigest === acceptanceDigest(deployment.taskFamily))) state = 'blocked'
    else if (deployment.state === 'canary' && new Set(watch.observations.filter(value => value.objectiveStatus === 'achieved' && value.taskFamilyDigest === acceptanceDigest(deployment.taskFamily)
      && value.validUntil > Date.now() && deployment.runIds.includes(value.runId)).map(value => value.runId)).size >= deployment.canaryRuns) state = 'promoted'
    if (!state || state === deployment.state) return deployment
    const saved = { ...deployment, state, updatedAt: Date.now() }; this.#putDeployment(key, saved); return saved
  }
  #putCandidate(key: string, candidate: SkillCandidate): void {
    this.#db.prepare('INSERT INTO skill_candidates(scope_key,id,candidate_json) VALUES(?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET candidate_json=excluded.candidate_json').run(key, candidate.id, JSON.stringify(candidate))
  }
  #putCapture(key: string, capture: SkillCapture): void { this.#db.prepare('INSERT INTO skill_captures(scope_key,id,capture_json,state) VALUES(?,?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET capture_json=excluded.capture_json,state=excluded.state').run(key, capture.id, JSON.stringify(capture), capture.state) }
  #run(key: string, id: string): SkillRun | undefined {
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE scope_key=? AND id=?').get(key, id) as { run_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.run_json) as SkillRun
  }
  #validateClaim(_scope: object, input: SkillRunClaim): void {
    if (!input || !text(input.invocationId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 512) || !name(input.skillName) || !version(input.version) || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || !json(input.inputs)
      || input.goalExecutionRunId !== undefined && !text(input.goalExecutionRunId, 256) || input.goalDefinitionDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.goalDefinitionDigest) || input.nativeGoalId !== undefined && !text(input.nativeGoalId, 256) || input.candidateId !== undefined && !text(input.candidateId, 128)
      || input.candidateId !== undefined && input.goalExecutionRunId === undefined) fail('assistant-skills: invalid invocation')
    if (input.candidateId !== undefined) return
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
