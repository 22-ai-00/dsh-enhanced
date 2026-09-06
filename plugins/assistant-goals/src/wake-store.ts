import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import type { DeliveryPreferencePrincipalAttestation } from '@dsh-enhanced/assistant-delivery'
import { GoalStoreError } from './types.js'
import type { GoalDefinition, GoalScope, NativeGoalState } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

export interface GoalWakeIntent {
  id: string; scope: GoalScope; goalId: string; definition: GoalDefinition; native: NativeGoalState
  attestation: DeliveryPreferencePrincipalAttestation; at: number; expiresAt: number; ownerRouteId: string; budgetId: string
}
export interface GoalWake {
  intent: GoalWakeIntent; state: 'prepared' | 'scheduled' | 'dispatched' | 'succeeded' | 'unknown' | 'denied'
  definitionHash?: string; occurrenceId?: string; dispatchedAt?: number; completedAt?: number
}
type Row = { id: string; intent_json: string; state: GoalWake['state']; definition_hash: string | null; occurrence_id: string | null; dispatched_at: number | null; completed_at: number | null; scope_key: string; goal_id: string }
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u
const routePattern = /^[A-Za-z0-9][A-Za-z0-9._@/:-]{0,511}$/u
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const same = (a: unknown, b: unknown) => acceptanceDigest(a) === acceptanceDigest(b)
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }
const integer = (value: unknown, min = 0): value is number => Number.isSafeInteger(value) && (value as number) >= min
const text = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && idPattern.test(value)
const routeText = (value: unknown, max = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && routePattern.test(value)
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

function intentInput(value: GoalWakeIntent): GoalWakeIntent {
  if (!exact(value, ['id', 'scope', 'goalId', 'definition', 'native', 'attestation', 'at', 'expiresAt', 'ownerRouteId', 'budgetId']) || !text(value.id) || !text(value.goalId) || !routeText(value.ownerRouteId) || !routeText(value.budgetId)
    || !exact(value.scope, ['principalId', 'principalRecordId', 'principalVersion', 'workspace', 'preset']) || !routeText(value.scope.principalId) || !text(value.scope.principalRecordId) || !integer(value.scope.principalVersion, 1) || typeof value.scope.workspace !== 'string' || !value.scope.workspace.startsWith('/') || !text(value.scope.preset)
    || !exact(value.definition, ['version', 'digest', 'objective']) || !integer(value.definition.version, 1) || !/^[a-f0-9]{64}$/u.test(value.definition.digest) || typeof value.definition.objective !== 'string' || value.definition.objective.length < 1 || value.definition.objective.length > 16384 || value.definition.digest !== acceptanceDigest({ objective: value.definition.objective })
    || !exact(value.native, ['sessionId', 'goalId', 'revision', 'objective', 'phase', 'roundsStarted', 'maxGoalRounds', 'updatedAt']) || value.native.phase !== 'paused' || !text(value.native.sessionId) || !text(value.native.goalId) || !integer(value.native.revision, 1) || typeof value.native.objective !== 'string' || value.native.objective.length < 1 || value.native.objective.length > 16384 || !integer(value.native.roundsStarted) || !integer(value.native.maxGoalRounds, 1) || value.native.roundsStarted >= value.native.maxGoalRounds || !integer(value.native.updatedAt)
    || value.native.objective !== value.definition.objective
    || !exact(value.attestation, ['scope', 'principalId', 'principalLineage', 'bindingId', 'bindingVersion', 'bindingGeneration', 'sessionId']) || !exact(value.attestation.scope, ['workspace', 'preset']) || value.attestation.scope.workspace !== value.scope.workspace || value.attestation.scope.preset !== value.scope.preset || value.attestation.principalId !== value.scope.principalId || !exact(value.attestation.principalLineage, ['principalRecordId', 'principalVersion']) || value.attestation.principalLineage.principalRecordId !== value.scope.principalRecordId || value.attestation.principalLineage.principalVersion !== value.scope.principalVersion || value.attestation.sessionId !== value.native.sessionId || !text(value.attestation.bindingId) || !integer(value.attestation.bindingVersion, 1) || !integer(value.attestation.bindingGeneration, 1)
    || !integer(value.at) || !integer(value.expiresAt) || value.expiresAt <= value.at || value.expiresAt - value.at > 300000) fail('invalid-input')
  return freeze(JSON.parse(JSON.stringify(value)) as GoalWakeIntent)
}
function parse(value: string): unknown { try { return JSON.parse(value) } catch { return fail('schema') } }
function scopeKey(value: GoalScope): string {
  if (!plain(value) || !routeText(value.principalId) || !text(value.principalRecordId) || !integer(value.principalVersion, 1)
    || typeof value.workspace !== 'string' || !value.workspace.startsWith('/') || !text(value.preset)) fail('invalid-input')
  return acceptanceCanonicalJson({ principalId: value.principalId, principalRecordId: value.principalRecordId, principalVersion: value.principalVersion, workspace: value.workspace, preset: value.preset })
}
function wake(row: Row): GoalWake {
  const intent = intentInput(parse(row.intent_json) as GoalWakeIntent)
  if (row.id !== intent.id || row.scope_key !== acceptanceCanonicalJson(intent.scope) || row.goal_id !== intent.goalId) fail('schema')
  if (!['prepared', 'scheduled', 'dispatched', 'succeeded', 'unknown', 'denied'].includes(row.state)) fail('schema')
  const hashValid = /^[a-f0-9]{64}$/u.test(row.definition_hash ?? '')
  if (row.definition_hash !== null && !hashValid) fail('schema')
  const dispatched = row.state === 'dispatched' || row.state === 'succeeded' || row.state === 'unknown'
  const terminal = row.state === 'succeeded' || row.state === 'unknown' || row.state === 'denied'
  if (row.state === 'prepared' && row.definition_hash !== null) fail('schema')
  if ((row.state === 'scheduled' || dispatched) && !hashValid) fail('schema')
  if (dispatched) {
    if (!text(row.occurrence_id) || !integer(row.dispatched_at)
      || row.dispatched_at < intent.at || row.dispatched_at >= intent.expiresAt) fail('schema')
  } else if (row.occurrence_id !== null || row.dispatched_at !== null) fail('schema')
  if (terminal) {
    if (!integer(row.completed_at) || (dispatched && row.completed_at < row.dispatched_at!)
      || (row.state === 'succeeded' && row.completed_at >= intent.expiresAt)) fail('schema')
  } else if (row.completed_at !== null) fail('schema')
  return freeze({ intent, state: row.state, ...(row.definition_hash === null ? {} : { definitionHash: row.definition_hash }), ...(row.occurrence_id === null ? {} : { occurrenceId: row.occurrence_id }), ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }), ...(row.completed_at === null ? {} : { completedAt: row.completed_at }) })
}

export class GoalWakeStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE; CREATE TABLE goal_wakes (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','scheduled','dispatched','succeeded','unknown','denied')), definition_hash TEXT, occurrence_id TEXT, dispatched_at INTEGER, completed_at INTEGER, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL) STRICT; CREATE INDEX goal_wakes_scope_goal ON goal_wakes(scope_key, goal_id, id); PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || !same(tables, ['goal_wakes'])) fail('schema')
      const columns = (this.#database.prepare('PRAGMA table_info(goal_wakes)').all() as Array<{ name: string }>).map(row => row.name)
      const sql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_wakes'").get() as { sql: string } | undefined)?.sql
      if (!same(columns, ['id', 'intent_json', 'state', 'definition_hash', 'occurrence_id', 'dispatched_at', 'completed_at', 'scope_key', 'goal_id']) || !sql || !/\bSTRICT\b/u.test(sql)) fail('schema')
      const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok') fail('schema')
      for (const row of this.#database.prepare('SELECT id, intent_json, state, definition_hash, occurrence_id, dispatched_at, completed_at, scope_key, goal_id FROM goal_wakes').all() as Row[]) wake(row)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #get(id: string): GoalWake | undefined { const row = this.#database.prepare('SELECT id, intent_json, state, definition_hash, occurrence_id, dispatched_at, completed_at, scope_key, goal_id FROM goal_wakes WHERE id = ?').get(id) as Row | undefined; return row === undefined ? undefined : wake(row) }
  get(id: string): GoalWake | undefined { return text(id) ? this.#get(id) : fail('invalid-input') }
  prepare(input: GoalWakeIntent): GoalWake {
    const intent = intentInput(input)
    return this.#transaction(() => {
      const current = this.#get(intent.id)
      if (current !== undefined) { if (!same(current.intent, intent)) fail('conflict'); return current }
      try { this.#database.prepare("INSERT INTO goal_wakes(id, intent_json, state, scope_key, goal_id) VALUES (?, ?, 'prepared', ?, ?)").run(intent.id, JSON.stringify(intent), acceptanceCanonicalJson(intent.scope), intent.goalId) } catch { fail('conflict') }
      return this.#get(intent.id)!
    })
  }
  scheduled(id: string, definitionHash: string): GoalWake {
    if (!text(id) || !/^[a-f0-9]{64}$/u.test(definitionHash)) fail('invalid-input')
    return this.#transaction(() => {
      const current = this.#get(id); if (!current) fail('not-found')
      if (current.state === 'scheduled' && current.definitionHash === definitionHash) return current
      if (current.state !== 'prepared') fail('conflict')
      if (Number(this.#database.prepare("UPDATE goal_wakes SET state = 'scheduled', definition_hash = ? WHERE id = ? AND state = 'prepared'").run(definitionHash, id).changes) !== 1) fail('conflict')
      return this.#get(id)!
    })
  }
  dispatch(id: string, occurrenceId: string, now: number): GoalWake {
    if (!text(id) || !text(occurrenceId) || !integer(now)) fail('invalid-input')
    return this.#transaction(() => { const current = this.#get(id); if (!current) fail('not-found'); if (current.state !== 'scheduled' || now < current.intent.at || now >= current.intent.expiresAt) fail('conflict'); if (Number(this.#database.prepare("UPDATE goal_wakes SET state = 'dispatched', occurrence_id = ?, dispatched_at = ? WHERE id = ? AND state = 'scheduled'").run(occurrenceId, now, id).changes) !== 1) fail('conflict'); return this.#get(id)! })
  }
  finish(id: string, outcome: 'succeeded' | 'unknown' | 'denied', now: number): GoalWake {
    if (!text(id) || !integer(now) || !['succeeded', 'unknown', 'denied'].includes(outcome)) fail('invalid-input')
    return this.#transaction(() => { const current = this.#get(id); if (!current) fail('not-found'); if (current.state === outcome) return current; if ((outcome === 'denied' && (current.state !== 'prepared' && current.state !== 'scheduled')) || (outcome !== 'denied' && (current.state !== 'dispatched' || now < current.dispatchedAt! || (outcome === 'succeeded' && now >= current.intent.expiresAt)))) fail('conflict'); if (Number(this.#database.prepare('UPDATE goal_wakes SET state = ?, completed_at = ? WHERE id = ? AND state = ?').run(outcome, now, id, current.state).changes) !== 1) fail('conflict'); return this.#get(id)! })
  }
  listPending(): readonly GoalWake[] { return freeze((this.#database.prepare("SELECT id FROM goal_wakes WHERE state IN ('prepared', 'scheduled') ORDER BY id").all() as Array<{ id: string }>).map(row => this.#get(row.id)!)) }
  listForGoal(scope: GoalScope, goalId: string, limit = 20): readonly GoalWake[] { if (!text(goalId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-input'); return freeze((this.#database.prepare('SELECT id FROM goal_wakes WHERE scope_key = ? AND goal_id = ? ORDER BY id DESC LIMIT ?').all(scopeKey(scope), goalId, limit) as Array<{ id: string }>).map(row => this.#get(row.id)!)) }
  #transaction<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const result = operation(); this.#database.exec('COMMIT'); return result } catch (error) { this.#database.exec('ROLLBACK'); throw error } }
  close(): void { this.#database.close() }
}
