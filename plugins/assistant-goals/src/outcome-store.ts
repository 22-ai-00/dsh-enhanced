import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest, validateTaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalDefinition, GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

/** The immutable acceptance policy for one semantic definition of a goal. */
export interface GoalOutcomeDefinition {
  readonly scope: GoalScope
  readonly goalId: string
  readonly definition: GoalDefinition
  readonly sessionId: string
  readonly nativeGoalId: string
  readonly template: TaskAcceptanceContract
}

export interface GoalOutcomeAssessment {
  readonly definition: GoalOutcomeDefinition
  readonly contract: TaskAcceptanceContract
  readonly triggerRunId?: string
  readonly dispatchedAt?: number
  readonly execution?: { readonly status: 'succeeded' | 'unknown'; readonly quiescent: boolean; readonly completedAt: number }
}

type Contract = Extract<TaskAcceptanceContract, { protocol: 'task-acceptance/v3' }>
type DefinitionRow = { scope_key: string; goal_id: string; definition_version: number; definition_json: string }
type AssessmentRow = { assessment_id: string; definition_json: string; contract_id: string; contract_json: string; trigger_run_id: string | null; dispatched_at: number | null; execution_json: string | null; scope_key: string; goal_id: string; definition_version: number; issued_at: number; created_seq: number }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
const DIGEST = /^[a-f0-9]{64}$/u
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)
const integer = (value: unknown, min = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min
const text = (value: unknown): value is string => typeof value === 'string' && ID.test(value)
const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const freeze = <T>(value: T): T => { if (value && typeof value === 'object' && !Object.isFrozen(value)) { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return fail('schema') } }

function scope(value: unknown): GoalScope {
  if (!exact(value, ['principalId', 'principalRecordId', 'principalVersion', 'workspace', 'preset']) || !text(value.principalId) || !text(value.principalRecordId)
    || !integer(value.principalVersion, 1) || typeof value.workspace !== 'string' || !value.workspace.startsWith('/') || value.workspace.length > 4096 || !text(value.preset)) fail('invalid-input')
  return freeze({ principalId: value.principalId, principalRecordId: value.principalRecordId, principalVersion: value.principalVersion, workspace: value.workspace, preset: value.preset })
}
function definition(value: unknown): GoalDefinition {
  if (!exact(value, ['version', 'digest', 'objective']) || !integer(value.version, 1) || typeof value.objective !== 'string' || value.objective.length < 1 || value.objective.length > 16_384 || typeof value.digest !== 'string' || !DIGEST.test(value.digest) || value.digest !== acceptanceDigest({ objective: value.objective })) fail('invalid-input')
  return freeze({ version: value.version, digest: value.digest, objective: value.objective })
}
function scopeKey(value: GoalScope): string { return acceptanceCanonicalJson(scope(value)) }

/** Validate the full shared wire format before applying goal-specific fences. */
function contract(value: unknown, code: 'invalid-input' | 'schema' = 'invalid-input'): Contract {
  let parsed: TaskAcceptanceContract
  try { parsed = validateTaskAcceptanceContract(value) } catch { return fail(code) }
  if (parsed.protocol !== 'task-acceptance/v3' || parsed.task.kind !== 'goal-outcome' || parsed.task.ref !== parsed.task.goal.assessmentId) fail(code)
  return parsed
}
function outcomeDefinition(value: unknown): GoalOutcomeDefinition {
  if (!exact(value, ['scope', 'goalId', 'definition', 'sessionId', 'nativeGoalId', 'template']) || !text(value.goalId) || !text(value.sessionId) || !text(value.nativeGoalId)) fail('invalid-input')
  const result = { scope: scope(value.scope), goalId: value.goalId, definition: definition(value.definition), sessionId: value.sessionId, nativeGoalId: value.nativeGoalId, template: contract(value.template) } as GoalOutcomeDefinition
  validateContract(result, contract(result.template))
  return freeze(result)
}
function validateContract(value: GoalOutcomeDefinition, item: Contract): void {
  if (item.objective !== value.definition.objective || item.scope.workspace !== value.scope.workspace || item.scope.preset !== value.scope.preset
    || item.owner.principalRecordId !== value.scope.principalRecordId || item.owner.principalVersion !== value.scope.principalVersion
    || item.task.goal.id !== value.goalId || item.task.goal.definitionVersion !== value.definition.version || item.task.goal.definitionDigest !== value.definition.digest
    || item.task.goal.sessionId !== value.sessionId || item.task.goal.nativeGoalId !== value.nativeGoalId) fail('invalid-input')
}
function assessment(row: AssessmentRow, bound?: GoalOutcomeDefinition): GoalOutcomeAssessment {
  const input = outcomeDefinition(parse(row.definition_json))
  const item = contract(parse(row.contract_json), 'schema')
  if (row.scope_key !== scopeKey(input.scope) || row.goal_id !== input.goalId || row.definition_version !== input.definition.version || !integer(row.created_seq, 1) || row.assessment_id !== item.task.ref || row.assessment_id !== item.task.goal.assessmentId || row.contract_id !== item.id || row.issued_at !== item.issuedAt || (bound !== undefined && !same(input, bound))) fail('schema')
  validateContract(input, item)
  const template = contract(input.template, 'schema')
  if (!same(item.criteria, template.criteria) || !same(item.profile, template.profile) || !same(item.bounds, template.bounds) || item.expiresAt !== template.expiresAt) fail('schema')
  const triggerRunId = row.trigger_run_id === null ? undefined : text(row.trigger_run_id) ? row.trigger_run_id : fail('schema')
  const dispatchedAt = row.dispatched_at === null ? undefined : integer(row.dispatched_at) ? row.dispatched_at : fail('schema')
  const execution = row.execution_json === null ? undefined : parse(row.execution_json) as GoalOutcomeAssessment['execution']
  if (dispatchedAt !== undefined && (dispatchedAt < item.issuedAt || dispatchedAt >= item.expiresAt)) fail('schema')
  if (execution !== undefined && (!exact(execution, ['status', 'quiescent', 'completedAt']) || (execution.status !== 'succeeded' && execution.status !== 'unknown') || typeof execution.quiescent !== 'boolean' || (execution.status === 'unknown' && execution.quiescent) || !integer(execution.completedAt) || dispatchedAt === undefined || execution.completedAt < dispatchedAt || (execution.status === 'succeeded' && (!execution.quiescent || execution.completedAt >= item.expiresAt)))) fail('schema')
  return freeze({ definition: input, contract: item, ...(triggerRunId === undefined ? {} : { triggerRunId }), ...(dispatchedAt === undefined ? {} : { dispatchedAt }), ...(execution === undefined ? {} : { execution: freeze(execution) }) })
}

/** A private durable ledger for whole-goal acceptance assessment. */
export class GoalOutcomeStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE goal_outcome_definitions (scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, definition_version INTEGER NOT NULL, definition_json TEXT NOT NULL, PRIMARY KEY(scope_key, goal_id, definition_version)) STRICT, WITHOUT ROWID;
        CREATE TABLE goal_outcome_assessments (assessment_id TEXT PRIMARY KEY, definition_json TEXT NOT NULL, contract_id TEXT NOT NULL UNIQUE, contract_json TEXT NOT NULL, trigger_run_id TEXT, dispatched_at INTEGER, execution_json TEXT, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, definition_version INTEGER NOT NULL, issued_at INTEGER NOT NULL, created_seq INTEGER NOT NULL, FOREIGN KEY(scope_key, goal_id, definition_version) REFERENCES goal_outcome_definitions(scope_key, goal_id, definition_version) ON DELETE RESTRICT) STRICT;
        CREATE INDEX goal_outcome_scope_goal_issued ON goal_outcome_assessments(scope_key, goal_id, issued_at DESC, created_seq DESC);
        CREATE UNIQUE INDEX goal_outcome_trigger_run ON goal_outcome_assessments(scope_key, goal_id, definition_version, trigger_run_id) WHERE trigger_run_id IS NOT NULL;
        PRAGMA user_version = 2; COMMIT;`)
      else if (version === 1 && same(tables, ['goal_outcome_assessments', 'goal_outcome_definitions'])) {
        this.#database.exec('BEGIN IMMEDIATE;')
        try {
          this.#database.exec('ALTER TABLE goal_outcome_assessments ADD COLUMN created_seq INTEGER NOT NULL DEFAULT 0; UPDATE goal_outcome_assessments SET created_seq = rowid WHERE created_seq = 0; CREATE INDEX goal_outcome_scope_goal_issued_v2 ON goal_outcome_assessments(scope_key, goal_id, issued_at DESC, created_seq DESC); CREATE UNIQUE INDEX goal_outcome_trigger_run ON goal_outcome_assessments(scope_key, goal_id, definition_version, trigger_run_id) WHERE trigger_run_id IS NOT NULL; PRAGMA user_version = 2; COMMIT;')
        } catch (error) { this.#database.exec('ROLLBACK'); throw error }
      } else if (version !== 2 || !same(tables, ['goal_outcome_assessments', 'goal_outcome_definitions'])) fail('schema')
      const definitions = (this.#database.prepare('PRAGMA table_info(goal_outcome_definitions)').all() as Array<{ name: string }>).map(row => row.name)
      const assessments = (this.#database.prepare('PRAGMA table_info(goal_outcome_assessments)').all() as Array<{ name: string }>).map(row => row.name)
      const sql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_outcome_assessments'").get() as { sql: string } | undefined)?.sql
      if (!same(definitions, ['scope_key', 'goal_id', 'definition_version', 'definition_json']) || !same(assessments, ['assessment_id', 'definition_json', 'contract_id', 'contract_json', 'trigger_run_id', 'dispatched_at', 'execution_json', 'scope_key', 'goal_id', 'definition_version', 'issued_at', 'created_seq']) || !sql || !/\bSTRICT\b/u.test(sql)) fail('schema')
      if ((this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') fail('schema')
      for (const row of this.#database.prepare('SELECT scope_key, goal_id, definition_version, definition_json FROM goal_outcome_definitions').all() as DefinitionRow[]) this.#definition(row)
      for (const row of this.#database.prepare('SELECT assessment_id, definition_json, contract_id, contract_json, trigger_run_id, dispatched_at, execution_json, scope_key, goal_id, definition_version, issued_at, created_seq FROM goal_outcome_assessments').all() as AssessmentRow[]) {
        const found = assessment(row)
        const bound = this.#getDefinition(found.definition.scope, found.definition.goalId, found.definition.definition.version)
        if (bound === undefined) fail('schema')
        assessment(row, bound)
      }
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #write(sql: string, ...values: SQLInputValue[]): number { try { return Number(this.#database.prepare(sql).run(...values).changes) } catch { fail('conflict') } }
  #definition(row: DefinitionRow): GoalOutcomeDefinition {
    const value = outcomeDefinition(parse(row.definition_json))
    if (row.scope_key !== scopeKey(value.scope) || row.goal_id !== value.goalId || row.definition_version !== value.definition.version) fail('schema')
    return value
  }
  #getDefinition(scopeValue: GoalScope, goalId: string, definitionVersion: number): GoalOutcomeDefinition | undefined {
    const row = this.#database.prepare('SELECT scope_key, goal_id, definition_version, definition_json FROM goal_outcome_definitions WHERE scope_key = ? AND goal_id = ? AND definition_version = ?').get(scopeKey(scopeValue), goalId, definitionVersion) as DefinitionRow | undefined
    return row === undefined ? undefined : this.#definition(row)
  }
  #get(id: string): GoalOutcomeAssessment | undefined {
    const row = this.#database.prepare('SELECT assessment_id, definition_json, contract_id, contract_json, trigger_run_id, dispatched_at, execution_json, scope_key, goal_id, definition_version, issued_at, created_seq FROM goal_outcome_assessments WHERE assessment_id = ?').get(id) as AssessmentRow | undefined
    if (row === undefined) return undefined
    const parsed = assessment(row)
    const bound = this.#getDefinition(parsed.definition.scope, parsed.definition.goalId, parsed.definition.definition.version)
    return bound === undefined ? fail('schema') : assessment(row, bound)
  }
  #transaction<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const value = operation(); this.#database.exec('COMMIT'); return value } catch (error) { this.#database.exec('ROLLBACK'); throw error } }
  bind(input: GoalOutcomeDefinition): GoalOutcomeDefinition {
    const value = outcomeDefinition(input)
    return this.#transaction(() => {
      const current = this.#getDefinition(value.scope, value.goalId, value.definition.version)
      if (current !== undefined) { if (!same(current, value)) fail('conflict'); return current }
      this.#write('INSERT INTO goal_outcome_definitions(scope_key, goal_id, definition_version, definition_json) VALUES (?, ?, ?, ?)', scopeKey(value.scope), value.goalId, value.definition.version, JSON.stringify(value))
      return this.#getDefinition(value.scope, value.goalId, value.definition.version)!
    })
  }
  getDefinition(scopeValue: GoalScope, goalId: string, definitionVersion: number): GoalOutcomeDefinition | undefined { if (!text(goalId) || !integer(definitionVersion, 1)) fail('invalid-input'); return this.#getDefinition(scope(scopeValue), goalId, definitionVersion) }
  prepare(input: GoalOutcomeDefinition, contractValue: TaskAcceptanceContract, triggerRunId?: string): GoalOutcomeAssessment {
    const value = outcomeDefinition(input); const item = contract(contractValue)
    if (triggerRunId !== undefined && !text(triggerRunId)) fail('invalid-input')
    validateContract(value, item)
    const template = contract(value.template)
    if (!same(item.criteria, template.criteria) || !same(item.profile, template.profile) || !same(item.bounds, template.bounds) || item.expiresAt !== template.expiresAt) fail('conflict')
    return this.#transaction(() => {
      const bound = this.#getDefinition(value.scope, value.goalId, value.definition.version)
      if (bound === undefined || !same(bound, value)) fail('conflict')
      const byTrigger = triggerRunId === undefined ? undefined : this.getByTriggerRun(value.scope, value.goalId, value.definition.version, triggerRunId)
      if (byTrigger !== undefined && (!same(byTrigger.definition, value) || !same(byTrigger.contract, item))) fail('conflict')
      if (byTrigger !== undefined) return byTrigger
      const current = this.#get(item.task.ref)
      if (current !== undefined) { if (!same(current.definition, value) || !same(current.contract, item) || current.triggerRunId !== triggerRunId) fail('conflict'); return current }
      const created = (this.#database.prepare('SELECT COALESCE(MAX(created_seq), 0) + 1 AS value FROM goal_outcome_assessments').get() as { value: number }).value
      if (!integer(created, 1)) fail('conflict')
      this.#write('INSERT INTO goal_outcome_assessments(assessment_id, definition_json, contract_id, contract_json, trigger_run_id, scope_key, goal_id, definition_version, issued_at, created_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', item.task.ref, JSON.stringify(value), item.id, JSON.stringify(item), triggerRunId ?? null, scopeKey(value.scope), value.goalId, value.definition.version, item.issuedAt, created)
      return this.#get(item.task.ref)!
    })
  }
  get(assessmentId: string): GoalOutcomeAssessment | undefined { return text(assessmentId) ? this.#get(assessmentId) : fail('invalid-input') }
  getByContract(contractId: string): GoalOutcomeAssessment | undefined { if (!text(contractId)) fail('invalid-input'); const row = this.#database.prepare('SELECT assessment_id FROM goal_outcome_assessments WHERE contract_id = ?').get(contractId) as { assessment_id: string } | undefined; return row === undefined ? undefined : this.#get(row.assessment_id) }
  getByTriggerRun(scopeValue: GoalScope, goalId: string, definitionVersion: number, triggerRunId: string): GoalOutcomeAssessment | undefined {
    if (!text(goalId) || !integer(definitionVersion, 1) || !text(triggerRunId)) fail('invalid-input')
    const row = this.#database.prepare('SELECT assessment_id FROM goal_outcome_assessments WHERE scope_key = ? AND goal_id = ? AND definition_version = ? AND trigger_run_id = ?').get(scopeKey(scope(scopeValue)), goalId, definitionVersion, triggerRunId) as { assessment_id: string } | undefined
    return row === undefined ? undefined : this.#get(row.assessment_id)
  }
  markDispatched(assessmentId: string, now: number): GoalOutcomeAssessment {
    if (!text(assessmentId) || !integer(now)) fail('invalid-input')
    return this.#transaction(() => { const current = this.#get(assessmentId); if (!current || current.dispatchedAt !== undefined || current.execution !== undefined || now < current.contract.issuedAt || now >= current.contract.expiresAt) fail('conflict'); if (this.#write('UPDATE goal_outcome_assessments SET dispatched_at = ? WHERE assessment_id = ? AND dispatched_at IS NULL AND execution_json IS NULL', now, assessmentId) !== 1) fail('conflict'); return this.#get(assessmentId)! })
  }
  finish(assessmentId: string, execution: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number }): GoalOutcomeAssessment {
    if (!text(assessmentId) || !exact(execution, ['status', 'quiescent', 'completedAt']) || (execution.status !== 'succeeded' && execution.status !== 'unknown') || typeof execution.quiescent !== 'boolean' || (execution.status === 'unknown' && execution.quiescent) || !integer(execution.completedAt)) fail('invalid-input')
    return this.#transaction(() => { const current = this.#get(assessmentId); if (!current || current.dispatchedAt === undefined || execution.completedAt < current.dispatchedAt) fail('conflict'); if (current.execution !== undefined) { if (same(current.execution, execution)) return current; fail('conflict') }; if (execution.status === 'succeeded' && (!execution.quiescent || execution.completedAt >= current.contract.expiresAt)) fail('conflict'); if (this.#write('UPDATE goal_outcome_assessments SET execution_json = ? WHERE assessment_id = ? AND execution_json IS NULL', JSON.stringify(freeze({ ...execution })), assessmentId) !== 1) fail('conflict'); return this.#get(assessmentId)! })
  }
  /**
   * An explicit owner/runtime recovery fence.  Construction stays read-only so an
   * inspector cannot turn a live assessment owned by another Host into unknown.
   */
  recoverIncomplete(now = Date.now()): number {
    if (!integer(now)) fail('invalid-input')
    return this.#transaction(() => {
      const rows = this.#database.prepare('SELECT assessment_id FROM goal_outcome_assessments WHERE dispatched_at IS NOT NULL AND execution_json IS NULL').all() as Array<{ assessment_id: string }>
      let recovered = 0
      for (const row of rows) {
        const current = this.#get(row.assessment_id)
        if (!current || current.dispatchedAt === undefined || current.execution !== undefined || now < current.dispatchedAt) fail('conflict')
        const execution = JSON.stringify({ status: 'unknown', quiescent: false, completedAt: now })
        if (this.#write('UPDATE goal_outcome_assessments SET execution_json = ? WHERE assessment_id = ? AND dispatched_at IS NOT NULL AND execution_json IS NULL', execution, row.assessment_id) === 1) recovered += 1
      }
      return recovered
    })
  }
  list(scopeValue: GoalScope, goalId: string, limit = 20): readonly GoalOutcomeAssessment[] {
    if (!text(goalId) || !integer(limit, 1) || limit > 100) fail('invalid-input')
    const rows = this.#database.prepare('SELECT assessment_id FROM goal_outcome_assessments WHERE scope_key = ? AND goal_id = ? ORDER BY issued_at DESC, created_seq DESC LIMIT ?').all(scopeKey(scope(scopeValue)), goalId, limit) as Array<{ assessment_id: string }>
    return freeze(rows.map(row => this.#get(row.assessment_id)!))
  }
  close(): void { this.#database.close() }
}
