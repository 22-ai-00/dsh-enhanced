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
  createdAt: number
  updatedAt: number
}
export interface SkillRunClaim {
  invocationId: string; goalId: string; sessionId: string; skillName: string; version: number; inputs: Readonly<Record<string, unknown>>
  candidateId?: string; goalExecutionRunId?: string
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
}

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
      CREATE INDEX IF NOT EXISTS skill_definitions_current ON skill_definitions(scope_key,name,version DESC);
      CREATE INDEX IF NOT EXISTS skill_runs_scope ON skill_runs(scope_key,id);
`)
    this.#db.prepare("UPDATE skill_runs SET state='unknown', run_json=json_set(run_json, '$.state', 'unknown', '$.updatedAt', ?) WHERE state='running'").run(Date.now())
    this.#db.exec("CREATE UNIQUE INDEX IF NOT EXISTS skill_runs_one_active ON skill_runs(scope_key,json_extract(identity_json,'$.sessionId'),json_extract(identity_json,'$.goalId')) WHERE state='running'")
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
  activateCandidate(scope: object, id: string, trialRunId: string, receipt: string): StoredSkillDefinition {
    const key = scopeKey(scope)
    if (!text(id, 128) || !text(trialRunId, 128) || !text(receipt, 1024)) fail('assistant-skills: invalid candidate activation')
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const candidate = this.#candidate(key, id); if (!candidate) fail('assistant-skills: candidate missing')
      if (candidate.state === 'activated') {
        if (candidate.trialRunId !== trialRunId || candidate.acceptanceDigest !== receipt || !candidate.activatedVersion) fail('assistant-skills: candidate conflict')
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
      const saved: SkillCandidate = { ...candidate, state: 'activated', activatedVersion: activated.version, trialRunId, acceptanceDigest: receipt, updatedAt: Date.now() }
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
  claim(scope: object, input: SkillRunClaim): { claimed: boolean; run: SkillRun } {
    const key = scopeKey(scope); this.#validateClaim(scope, input)
    const id = runId(scope, input.sessionId, input.invocationId)
    const identity = clone({ invocationId: input.invocationId, goalId: input.goalId, sessionId: input.sessionId, skillName: input.skillName, version: input.version, inputs: input.inputs,
      ...(input.candidateId === undefined ? {} : { candidateId: input.candidateId, goalExecutionRunId: input.goalExecutionRunId }) })
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      if (input.candidateId !== undefined) this.#validateTrialClaim(key, input)
      const existing = this.#db.prepare('SELECT identity_json,run_json FROM skill_runs WHERE id=? AND scope_key=?').get(id, key) as { identity_json: string; run_json: string } | undefined
      if (existing) {
        if (acceptanceDigest(identity) !== acceptanceDigest(JSON.parse(existing.identity_json))) fail('assistant-skills: invocation conflict')
        this.#db.exec('COMMIT'); return { claimed: false, run: clone(JSON.parse(existing.run_json) as SkillRun) }
      }
      const now = Date.now(); const run: SkillRun = { id, ...identity, state: 'running', steps: [], createdAt: now, updatedAt: now }
      this.#db.prepare('INSERT INTO skill_runs VALUES(?,?,?,?,?)').run(id, key, JSON.stringify(identity), JSON.stringify(run), run.state)
      this.#db.exec('COMMIT'); return { claimed: true, run: clone(run) }
    } catch (error) { try { this.#db.exec('ROLLBACK') } catch {} throw error }
  }
  finish(scope: object, id: string, state: Exclude<SkillRunState, 'running'>, steps: readonly SkillRunStep[]): SkillRun {
    const key = scopeKey(scope)
    if (!text(id, 128) || !['succeeded', 'failed', 'unknown'].includes(state)) fail('assistant-skills: invalid run completion')
    this.#validateSteps(steps)
    const current = this.getRun(scope, id)
    if (!current || current.state !== 'running') fail('assistant-skills: run state conflict')
    const completed: SkillRun = { ...current, state, steps: clone(steps), updatedAt: Date.now() }
    if (this.#db.prepare("UPDATE skill_runs SET state=?,run_json=? WHERE id=? AND scope_key=? AND state='running'").run(state, JSON.stringify(completed), id, key).changes !== 1) fail('assistant-skills: run state conflict')
    return clone(completed)
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
  #putCandidate(key: string, candidate: SkillCandidate): void {
    this.#db.prepare('INSERT INTO skill_candidates(scope_key,id,candidate_json) VALUES(?,?,?) ON CONFLICT(scope_key,id) DO UPDATE SET candidate_json=excluded.candidate_json').run(key, candidate.id, JSON.stringify(candidate))
  }
  #run(key: string, id: string): SkillRun | undefined {
    const row = this.#db.prepare('SELECT run_json FROM skill_runs WHERE scope_key=? AND id=?').get(key, id) as { run_json: string } | undefined
    return row === undefined ? undefined : JSON.parse(row.run_json) as SkillRun
  }
  #validateClaim(scope: object, input: SkillRunClaim): void {
    if (!input || !text(input.invocationId, 256) || !text(input.goalId, 256) || !text(input.sessionId, 512) || !name(input.skillName) || !version(input.version) || !input.inputs || typeof input.inputs !== 'object' || Array.isArray(input.inputs) || !json(input.inputs)
      || (input.candidateId === undefined) !== (input.goalExecutionRunId === undefined) || input.candidateId !== undefined && (!text(input.candidateId, 128) || !text(input.goalExecutionRunId, 256))) fail('assistant-skills: invalid invocation')
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
