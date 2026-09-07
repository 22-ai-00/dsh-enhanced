import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { acceptanceCanonicalJson, acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

export type StrategyScope = GoalScope
export type StrategyKind = 'investigate' | 'review' | 'compare'

export interface StrategyIntent {
  id: string; goalId: string; parentRunId: string; parentSessionId: string; definitionVersion: number; definitionDigest: string
  scope: GoalScope; kind: StrategyKind; requestDigest: string; provider: string; model: string; maxChildren: number; maxDurationMs: number; createdAt: number; expiresAt: number
}

export interface StrategyRecord {
  intent: StrategyIntent; state: 'prepared' | 'starting' | 'settled' | 'unknown'; version: number
  children: Array<{ sessionId: string; stopReason: string; quiescent: boolean }>
  completedAt?: number; outcome?: 'advice' | 'execution-failed' | 'cancelled' | 'unknown'; outputDigest?: string
}

type Row = { id: string; intent_json: string; state: string; version: number; children_json: string; completed_at: number | null; outcome: string | null; output_digest: string | null; scope_key: string; goal_id: string; created_at: number }
type Settlement = { children: Array<{ sessionId: string; stopReason: string; quiescent: boolean }>; outcome: 'advice' | 'execution-failed' | 'cancelled' | 'unknown'; outputDigest?: string; quiescent: boolean }

const idPattern = /^[A-Za-z0-9_.:-]{1,512}$/u
const digestPattern = /^[a-f0-9]{64}$/u
const states = new Set<StrategyRecord['state']>(['prepared', 'starting', 'settled', 'unknown'])
const outcomes = new Set<NonNullable<StrategyRecord['outcome']>>(['advice', 'execution-failed', 'cancelled', 'unknown'])
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const parse = (value: string): unknown => { try { return JSON.parse(value) } catch { return fail('schema') } }
const same = (left: unknown, right: unknown): boolean => acceptanceDigest(left) === acceptanceDigest(right)
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const child of Object.values(value as Record<string, unknown>)) freeze(child); Object.freeze(value) }; return value }
const clone = <T>(value: T): T => freeze(JSON.parse(JSON.stringify(value)) as T)
const text = (value: unknown, maximum = 512): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximum
const time = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const positive = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maximum

function scopeInput(value: unknown): GoalScope {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 5) fail('invalid-input')
  const scope = value as GoalScope
  if (!text(scope.principalId) || !text(scope.principalRecordId) || !positive(scope.principalVersion, 1_000_000_000) || !text(scope.workspace, 4096) || !scope.workspace.startsWith('/') || !text(scope.preset)) fail('invalid-input')
  return clone({ principalId: scope.principalId, principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion, workspace: scope.workspace, preset: scope.preset })
}

function intentInput(value: unknown): StrategyIntent {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 15) fail('invalid-input')
  const input = value as StrategyIntent
  if (![input.id, input.goalId, input.parentRunId, input.parentSessionId].every(item => typeof item === 'string' && idPattern.test(item))
    || !positive(input.definitionVersion, 1_000_000_000) || !digestPattern.test(input.definitionDigest) || !digestPattern.test(input.requestDigest)
    || !(['investigate', 'review', 'compare'] as const).includes(input.kind) || !text(input.provider) || !text(input.model)
    || !positive(input.maxChildren, 2) || !positive(input.maxDurationMs, 300_000) || !time(input.createdAt) || !time(input.expiresAt)
    || input.expiresAt <= input.createdAt || input.expiresAt - input.createdAt > input.maxDurationMs) fail('invalid-input')
  const scope = scopeInput(input.scope)
  return clone({ id: input.id, goalId: input.goalId, parentRunId: input.parentRunId, parentSessionId: input.parentSessionId, definitionVersion: input.definitionVersion, definitionDigest: input.definitionDigest, scope, kind: input.kind, requestDigest: input.requestDigest, provider: input.provider, model: input.model, maxChildren: input.maxChildren, maxDurationMs: input.maxDurationMs, createdAt: input.createdAt, expiresAt: input.expiresAt })
}

function childrenInput(value: unknown, maximum: number): Array<{ sessionId: string; stopReason: string; quiescent: boolean }> {
  if (!Array.isArray(value) || value.length > maximum) fail('invalid-input')
  const children = value.map(child => {
    if (!child || typeof child !== 'object' || Array.isArray(child) || Object.keys(child).length !== 3) fail('invalid-input')
    const input = child as { sessionId: unknown; stopReason: unknown; quiescent: unknown }
    if ((typeof input.sessionId !== 'string' || !idPattern.test(input.sessionId)) || !text(input.stopReason) || typeof input.quiescent !== 'boolean') fail('invalid-input')
    return { sessionId: input.sessionId as string, stopReason: input.stopReason as string, quiescent: input.quiescent }
  })
  if (new Set(children.map(child => child.sessionId)).size !== children.length) fail('invalid-input')
  return clone(children)
}

function settlementInput(value: unknown, maxChildren: number): Settlement {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![3, 4].includes(Object.keys(value).length)) fail('invalid-input')
  const input = value as Settlement
  const keys = Object.keys(input)
  if (!keys.every(key => ['children', 'outcome', 'outputDigest', 'quiescent'].includes(key)) || !keys.includes('children') || !keys.includes('outcome') || !keys.includes('quiescent') || (keys.length === 4 && !keys.includes('outputDigest'))
    || !outcomes.has(input.outcome) || typeof input.quiescent !== 'boolean' || (input.outputDigest !== undefined && !digestPattern.test(input.outputDigest))) fail('invalid-input')
  return clone({ children: childrenInput(input.children, maxChildren), outcome: input.outcome, ...(input.outputDigest === undefined ? {} : { outputDigest: input.outputDigest }), quiescent: input.quiescent })
}

function record(row: Row): StrategyRecord {
  const intent = intentInput(parse(row.intent_json))
  if (!states.has(row.state as StrategyRecord['state']) || !positive(row.version, 1_000_000_000) || row.scope_key !== acceptanceCanonicalJson(intent.scope) || row.goal_id !== intent.goalId || row.created_at !== intent.createdAt) fail('schema')
  const children = childrenInput(parse(row.children_json), intent.maxChildren)
  const completedAt = row.completed_at === null ? undefined : time(row.completed_at) ? row.completed_at : fail('schema')
  const outcome = row.outcome === null ? undefined : outcomes.has(row.outcome as NonNullable<StrategyRecord['outcome']>) ? row.outcome as NonNullable<StrategyRecord['outcome']> : fail('schema')
  const outputDigest = row.output_digest === null ? undefined : digestPattern.test(row.output_digest) ? row.output_digest : fail('schema')
  if (row.state === 'prepared' && (children.length !== 0 || completedAt !== undefined || outcome !== undefined || outputDigest !== undefined)) fail('schema')
  if (row.state === 'starting' && (completedAt !== undefined || outcome !== undefined || outputDigest !== undefined)) fail('schema')
  if ((row.state === 'settled' || row.state === 'unknown') && (completedAt === undefined || outcome === undefined || completedAt < intent.createdAt)) fail('schema')
  if (row.state === 'unknown' && outcome !== 'unknown') fail('schema')
  return freeze({ intent, state: row.state as StrategyRecord['state'], version: row.version, children, ...(completedAt === undefined ? {} : { completedAt }), ...(outcome === undefined ? {} : { outcome }), ...(outputDigest === undefined ? {} : { outputDigest }) })
}

/** Private durable ledger. A recovered intent is terminally unknown and is never replayed. */
export class GoalStrategyStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE goal_strategy_records (id TEXT PRIMARY KEY, intent_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','starting','settled','unknown')), version INTEGER NOT NULL, children_json TEXT NOT NULL, completed_at INTEGER, outcome TEXT CHECK(outcome IN ('advice','execution-failed','cancelled','unknown')), output_digest TEXT, scope_key TEXT NOT NULL, goal_id TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT;
        CREATE INDEX goal_strategy_scope_goal_created ON goal_strategy_records(scope_key, goal_id, created_at DESC, id ASC);
        PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || !same(tables, ['goal_strategy_records'])) fail('schema')
      this.#validate()
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #validate(): void {
    const columns = (this.#database.prepare('PRAGMA table_info(goal_strategy_records)').all() as Array<{ name: string }>).map(row => row.name)
    const schema = this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_strategy_records'").get() as { sql: string } | undefined
    if (!schema || !same(columns, ['id', 'intent_json', 'state', 'version', 'children_json', 'completed_at', 'outcome', 'output_digest', 'scope_key', 'goal_id', 'created_at']) || !/\bSTRICT\b/u.test(schema.sql)) fail('schema')
    const index = this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name = 'goal_strategy_scope_goal_created'").get() as { name: string } | undefined
    if (!index) fail('schema')
    const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok') fail('schema')
    for (const row of this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at FROM goal_strategy_records').all() as Row[]) { const value = record(row); if (value.intent.id !== row.id) fail('schema') }
  }
  #get(id: string): StrategyRecord | undefined {
    const row = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at FROM goal_strategy_records WHERE id = ?').get(id) as Row | undefined
    return row === undefined ? undefined : record(row)
  }
  #write(sql: string, ...values: SQLInputValue[]): number { try { return Number(this.#database.prepare(sql).run(...values).changes) } catch { fail('conflict') } }
  prepare(input: StrategyIntent): { record: StrategyRecord; created: boolean } {
    const intent = intentInput(input)
    this.#database.exec('BEGIN IMMEDIATE;')
    try {
      const existing = this.#get(intent.id)
      if (existing) { if (!same(existing.intent, intent)) fail('conflict'); this.#database.exec('COMMIT;'); return freeze({ record: existing, created: false }) }
      this.#write("INSERT INTO goal_strategy_records(id, intent_json, state, version, children_json, scope_key, goal_id, created_at) VALUES (?, ?, 'prepared', 1, '[]', ?, ?, ?)", intent.id, JSON.stringify(intent), acceptanceCanonicalJson(intent.scope), intent.goalId, intent.createdAt)
      const result = this.#get(intent.id)!; this.#database.exec('COMMIT;'); return freeze({ record: result, created: true })
    } catch (error) { try { this.#database.exec('ROLLBACK;') } catch {} throw error }
  }
  /** Persists the provider-construction attempt before the native driver starts it. */
  dispatch(id: string, expectedVersion: number, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    if (found.state !== 'prepared' || found.version !== expectedVersion || now < found.intent.createdAt || now >= found.intent.expiresAt) fail('conflict')
    if (this.#write("UPDATE goal_strategy_records SET state = 'starting', version = version + 1 WHERE id = ? AND state = 'prepared' AND version = ?", id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  bindChild(id: string, expectedVersion: number, sessionId: string, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !idPattern.test(sessionId) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    if (found.state !== 'starting' || found.version !== expectedVersion || now < found.intent.createdAt || now >= found.intent.expiresAt || found.children.length >= found.intent.maxChildren || found.children.some(child => child.sessionId === sessionId)) fail('conflict')
    const children = [...found.children, { sessionId, stopReason: 'pending', quiescent: false }]
    if (this.#write("UPDATE goal_strategy_records SET children_json = ?, version = version + 1 WHERE id = ? AND state = 'starting' AND version = ?", JSON.stringify(children), id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  settle(id: string, expectedVersion: number, input: Settlement, now: number): StrategyRecord {
    if (!idPattern.test(id) || !positive(expectedVersion, 1_000_000_000) || !time(now)) fail('invalid-input')
    const found = this.#get(id); if (!found) fail('not-found')
    const value = settlementInput(input, found.intent.maxChildren)
    if (found.state !== 'starting' || found.version !== expectedVersion || now < found.intent.createdAt) fail('conflict')
    const bound = new Set(found.children.map(child => child.sessionId)); const settled = new Set(value.children.map(child => child.sessionId))
    if (bound.size !== settled.size || [...bound].some(sessionId => !settled.has(sessionId)) || (bound.size === 0 && value.outcome === 'advice')) fail('conflict')
    const incomplete = value.children.some(child => child.stopReason === 'pending' || !child.quiescent)
    const state = value.quiescent && !incomplete && value.outcome !== 'unknown' ? 'settled' : 'unknown'
    const outcome = state === 'settled' ? value.outcome : 'unknown'
    const outputDigest = state === 'settled' ? value.outputDigest ?? null : null
    if (this.#write('UPDATE goal_strategy_records SET state = ?, version = version + 1, children_json = ?, completed_at = ?, outcome = ?, output_digest = ? WHERE id = ? AND state = \'starting\' AND version = ?', state, JSON.stringify(value.children), now, outcome, outputDigest, id, expectedVersion) !== 1) fail('conflict')
    return this.#get(id)!
  }
  inspect(scope: StrategyScope, id: string): StrategyRecord | undefined {
    if (!idPattern.test(id)) fail('invalid-input'); const key = acceptanceCanonicalJson(scopeInput(scope))
    const row = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at FROM goal_strategy_records WHERE id = ? AND scope_key = ?').get(id, key) as Row | undefined
    return row === undefined ? undefined : record(row)
  }
  list(scope: StrategyScope, goalId: string, limit = 20): readonly StrategyRecord[] {
    if (!idPattern.test(goalId) || !positive(limit, 100)) fail('invalid-input'); const key = acceptanceCanonicalJson(scopeInput(scope))
    const rows = this.#database.prepare('SELECT id, intent_json, state, version, children_json, completed_at, outcome, output_digest, scope_key, goal_id, created_at FROM goal_strategy_records WHERE scope_key = ? AND goal_id = ? ORDER BY created_at DESC, id ASC LIMIT ?').all(key, goalId, limit) as Row[]
    return freeze(rows.map(record))
  }
  recoverIncomplete(now: number): void {
    if (!time(now)) fail('invalid-input')
    this.#write("UPDATE goal_strategy_records SET state = 'unknown', version = version + 1, completed_at = ?, outcome = 'unknown', output_digest = NULL WHERE state IN ('prepared', 'starting')", now)
  }
  close(): void { this.#database.close() }
}
