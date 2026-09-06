import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalExecutionIntent, GoalExecutionRun, GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return fail('schema') } }
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }

function intentInput(value: GoalExecutionIntent): GoalExecutionIntent {
  const { runId, scope, objective, admission, task } = value ?? {} as GoalExecutionIntent
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 512 || typeof objective !== 'string' || objective.length === 0 || objective.length > 16_384
    || !scope || typeof scope.principalId !== 'string' || typeof scope.principalRecordId !== 'string' || !Number.isSafeInteger(scope.principalVersion) || scope.principalVersion < 1
    || typeof scope.workspace !== 'string' || !scope.workspace.startsWith('/') || typeof scope.preset !== 'string'
    || !admission || !Number.isSafeInteger(admission.issuedAt) || admission.issuedAt < 0 || !Number.isSafeInteger(admission.expiresAt)
    || admission.expiresAt <= admission.issuedAt || admission.expiresAt - admission.issuedAt > 300_000
    || !Number.isSafeInteger(admission.maxGoalRounds) || admission.maxGoalRounds < 1 || !Number.isSafeInteger(admission.round) || admission.round < 1 || admission.round > admission.maxGoalRounds
    || admission.authorizationDigest !== acceptanceDigest({ scope, action: 'execute', resource: { kind: 'goal', id: 'business-context' } })
    || !task || task.kind !== 'goal-step' || task.ref !== runId || !task.goal || task.goal.runId !== runId
    || [task.goal.id, task.goal.stepId, task.goal.sessionId, task.goal.nativeGoalId].some(item => typeof item !== 'string' || !/^[A-Za-z0-9_.:-]{1,512}$/u.test(item))
    || !Number.isSafeInteger(task.goal.definitionVersion) || task.goal.definitionVersion < 1 || !Number.isSafeInteger(task.goal.nativeRevision) || task.goal.nativeRevision < 1
    || task.goal.definitionDigest !== acceptanceDigest({ objective })) fail('invalid-input')
  return freeze(JSON.parse(JSON.stringify(value)) as GoalExecutionIntent)
}

function run(row: { intent_json: string; contract_id: string | null; contract_digest: string | null; dispatched_at: number | null; execution_json: string | null }): GoalExecutionRun {
  const intent = intentInput(parse(row.intent_json) as GoalExecutionIntent)
  const acceptance = row.contract_id === null && row.contract_digest === null ? undefined
    : (typeof row.contract_id === 'string' && /^[A-Za-z0-9_.:-]{1,512}$/u.test(row.contract_id) && typeof row.contract_digest === 'string' && /^[a-f0-9]{64}$/u.test(row.contract_digest)
      ? freeze({ contractId: row.contract_id, contractDigest: row.contract_digest }) : fail('schema'))
  const dispatchedAt = row.dispatched_at === null ? undefined : (Number.isSafeInteger(row.dispatched_at) && row.dispatched_at >= 0 ? row.dispatched_at : fail('schema'))
  const execution = row.execution_json === null ? undefined : parse(row.execution_json) as GoalExecutionRun['execution']
  if (execution && (execution.status !== 'succeeded' && execution.status !== 'unknown' || typeof execution.quiescent !== 'boolean' || !Number.isSafeInteger(execution.completedAt) || execution.completedAt < 0)) fail('schema')
  if (dispatchedAt !== undefined && (acceptance === undefined || dispatchedAt < intent.admission.issuedAt || dispatchedAt >= intent.admission.expiresAt)) fail('schema')
  if (execution !== undefined && (execution === null || dispatchedAt === undefined || execution.completedAt < dispatchedAt
    || (execution.status === 'succeeded' && (!execution.quiescent || execution.completedAt >= intent.admission.expiresAt)))) fail('schema')
  return freeze({ intent, ...(acceptance === undefined ? {} : { acceptance }), ...(dispatchedAt === undefined ? {} : { dispatchedAt }), ...(execution === undefined ? {} : { execution: freeze(execution) }) })
}

/** Durable, non-dispatching ledger.  A recovered dispatch is always unknown. */
export class GoalExecutionStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>
      if (version === 0 && tables.length === 0) this.#database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS goal_execution_runs (
        run_id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, contract_id TEXT UNIQUE, contract_digest TEXT,
        dispatched_at INTEGER, execution_json TEXT
      ) STRICT;
      PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || tables.length !== 1 || tables[0]?.name !== 'goal_execution_runs') fail('schema')
      const columns = (this.#database.prepare('PRAGMA table_info(goal_execution_runs)').all() as Array<{ name: string }>).map(item => item.name)
      if (!same(columns, ['run_id', 'intent_json', 'contract_id', 'contract_digest', 'dispatched_at', 'execution_json'])) fail('schema')
      for (const row of this.#database.prepare('SELECT run_id FROM goal_execution_runs').all() as Array<{ run_id: string }>) this.#get(row.run_id)
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #get(runId: string): GoalExecutionRun | undefined {
    const row = this.#database.prepare('SELECT intent_json, contract_id, contract_digest, dispatched_at, execution_json FROM goal_execution_runs WHERE run_id = ?').get(runId) as { intent_json: string; contract_id: string | null; contract_digest: string | null; dispatched_at: number | null; execution_json: string | null } | undefined
    if (row === undefined) return undefined
    const result = run(row)
    if (result.intent.runId !== runId) fail('schema')
    return result
  }
  #write(sql: string, ...parameters: SQLInputValue[]): number {
    try { return Number(this.#database.prepare(sql).run(...parameters).changes) } catch { fail('conflict') }
  }
  prepare(input: GoalExecutionIntent): GoalExecutionRun {
    const intent = intentInput(input); const existing = this.#get(intent.runId)
    if (existing !== undefined) { if (!same(existing.intent, intent)) fail('conflict'); return existing }
    this.#write('INSERT INTO goal_execution_runs(run_id, intent_json) VALUES (?, ?)', intent.runId, JSON.stringify(intent))
    return this.#get(intent.runId)!
  }
  get(runId: string): GoalExecutionRun | undefined { return typeof runId === 'string' ? this.#get(runId) : fail('invalid-input') }
  bindAcceptance(runId: string, acceptance: { contractId: string; contractDigest: string }): GoalExecutionRun {
    const found = this.#get(runId); if (!found) fail('not-found')
    if (!/^[A-Za-z0-9_.:-]{1,512}$/u.test(acceptance.contractId) || !/^[a-f0-9]{64}$/u.test(acceptance.contractDigest)) fail('invalid-input')
    if (found.acceptance) { if (!same(found.acceptance, acceptance)) fail('conflict'); return found }
    if (this.#write('UPDATE goal_execution_runs SET contract_id = ?, contract_digest = ? WHERE run_id = ? AND contract_id IS NULL AND contract_digest IS NULL', acceptance.contractId, acceptance.contractDigest, runId) !== 1) fail('conflict')
    return this.#get(runId)!
  }
  markDispatched(runId: string, now: number): GoalExecutionRun {
    const found = this.#get(runId); if (!found) fail('not-found'); if (found.acceptance === undefined || found.dispatchedAt !== undefined || found.execution !== undefined || !Number.isSafeInteger(now) || now < found.intent.admission.issuedAt || now >= found.intent.admission.expiresAt) fail('conflict')
    if (this.#write('UPDATE goal_execution_runs SET dispatched_at = ? WHERE run_id = ? AND dispatched_at IS NULL AND execution_json IS NULL', now, runId) !== 1) fail('conflict'); return this.#get(runId)!
  }
  finish(runId: string, execution: { status: 'succeeded' | 'unknown'; quiescent: boolean; completedAt: number }): GoalExecutionRun {
    const found = this.#get(runId); if (!found) fail('not-found'); if (found.dispatchedAt === undefined || !Number.isSafeInteger(execution.completedAt) || execution.completedAt < found.dispatchedAt || typeof execution.quiescent !== 'boolean' || (execution.status !== 'succeeded' && execution.status !== 'unknown')) fail('invalid-input')
    if (found.execution) { if (same(found.execution, execution)) return found; fail('conflict') }
    if (execution.status === 'succeeded' && (!execution.quiescent || execution.completedAt >= found.intent.admission.expiresAt)) fail('invalid-input')
    if (this.#write('UPDATE goal_execution_runs SET execution_json = ? WHERE run_id = ? AND execution_json IS NULL', JSON.stringify(freeze({ ...execution })), runId) !== 1) fail('conflict'); return this.#get(runId)!
  }
  getByContract(contractId: string): GoalExecutionRun | undefined { if (typeof contractId !== 'string') fail('invalid-input'); const row = this.#database.prepare('SELECT run_id FROM goal_execution_runs WHERE contract_id = ?').get(contractId) as { run_id: string } | undefined; return row ? this.#get(row.run_id) : undefined }
  listForGoal(scope: GoalScope, goalId: string): readonly GoalExecutionRun[] { return freeze((this.#database.prepare('SELECT run_id FROM goal_execution_runs').all() as Array<{ run_id: string }>).map(row => this.#get(row.run_id)!).filter(value => same(value.intent.scope, scope) && value.intent.task.goal.id === goalId)) }
  recoverIncomplete(): readonly GoalExecutionRun[] { const rows = (this.#database.prepare('SELECT run_id, dispatched_at FROM goal_execution_runs WHERE dispatched_at IS NOT NULL AND execution_json IS NULL').all() as Array<{ run_id: string; dispatched_at: number }>); const recovered: GoalExecutionRun[] = []; for (const row of rows) { const execution = JSON.stringify({ status: 'unknown', quiescent: false, completedAt: row.dispatched_at }); if (this.#write('UPDATE goal_execution_runs SET execution_json = ? WHERE run_id = ? AND execution_json IS NULL', execution, row.run_id) === 1) recovered.push(this.#get(row.run_id)!) }; return freeze(recovered) }
  close(): void { this.#database.close() }
}
