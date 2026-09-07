import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalScope } from './types.js'
import { prepareGoalStoreDatabaseFile } from './store.js'

export interface GoalBudgetLimits { modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsdMicros: number | null; expiresAt: number }
export interface GoalBudgetScope { scope: GoalScope; goalId: string }
export interface GoalBudgetReservation { id: string; runId: string; inputTokens: number; outputTokens: number; costUsdMicros: number | null; state: 'held' | 'settled'; reservedAt: number; settledAt?: number }
export interface GoalBudgetSnapshot { limits: GoalBudgetLimits; modelCalls: number; toolCalls: number; inputTokens: number; outputTokens: number; costUsdMicros: number | null; heldCalls: number }

type Row = { id: string; run_id: string; input_tokens_reserved: number; output_tokens_reserved: number; cost_usd_micros_reserved: number | null; state: string; reserved_at: number; input_tokens_actual: number | null; output_tokens_actual: number | null; cost_usd_micros_actual: number | null; settled_at: number | null }
type LimitRow = { model_calls: number; tool_calls: number; input_tokens: number; output_tokens: number; cost_usd_micros: number | null; expires_at: number }
const max = 1_000_000_000
const idPattern = /^[A-Za-z0-9_.:-]{1,512}$/u
function fail(code: ConstructorParameters<typeof GoalStoreError>[0]): never { throw new GoalStoreError(code) }
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { for (const item of Object.values(value as Record<string, unknown>)) freeze(item); Object.freeze(value) }; return value }
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= max
const time = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

function scopeInput(value: GoalBudgetScope): GoalBudgetScope {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !value.scope || typeof value.scope !== 'object' || !idPattern.test(value.goalId ?? '')) fail('invalid-input')
  const scope = value.scope
  if (Object.keys(scope).length !== 5 || ![scope.principalId, scope.principalRecordId, scope.workspace, scope.preset].every(item => typeof item === 'string' && item.length > 0 && item.length <= 4096)
    || !scope.workspace.startsWith('/') || !Number.isSafeInteger(scope.principalVersion) || scope.principalVersion < 1 || scope.principalVersion > max) fail('invalid-input')
  return freeze({ scope: { principalId: scope.principalId, principalRecordId: scope.principalRecordId, principalVersion: scope.principalVersion, workspace: scope.workspace, preset: scope.preset }, goalId: value.goalId })
}

function limitsInput(value: GoalBudgetLimits): GoalBudgetLimits {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 6 || !integer(value.modelCalls) || !integer(value.toolCalls) || !integer(value.inputTokens) || !integer(value.outputTokens)
    || !(value.costUsdMicros === null || integer(value.costUsdMicros)) || !time(value.expiresAt)) fail('invalid-input')
  return freeze({ modelCalls: value.modelCalls, toolCalls: value.toolCalls, inputTokens: value.inputTokens, outputTokens: value.outputTokens, costUsdMicros: value.costUsdMicros, expiresAt: value.expiresAt })
}

function requestInput(value: { id: string; runId: string; inputTokens: number; outputTokens: number; costUsdMicros: number | null }) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 5 || !idPattern.test(value.id ?? '') || !idPattern.test(value.runId ?? '') || !integer(value.inputTokens) || !integer(value.outputTokens) || !(value.costUsdMicros === null || integer(value.costUsdMicros))) fail('invalid-input')
  return freeze({ id: value.id, runId: value.runId, inputTokens: value.inputTokens, outputTokens: value.outputTokens, costUsdMicros: value.costUsdMicros })
}
function actualInput(value: { inputTokens: number; outputTokens: number; costUsdMicros: number | null }) {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 3 || !integer(value.inputTokens) || !integer(value.outputTokens) || !(value.costUsdMicros === null || integer(value.costUsdMicros))) fail('invalid-input')
  return freeze({ inputTokens: value.inputTokens, outputTokens: value.outputTokens, costUsdMicros: value.costUsdMicros })
}
function rowReservation(row: Row): GoalBudgetReservation {
  if (!idPattern.test(row.id) || !idPattern.test(row.run_id) || !integer(row.input_tokens_reserved) || !integer(row.output_tokens_reserved) || !(row.cost_usd_micros_reserved === null || integer(row.cost_usd_micros_reserved)) || !time(row.reserved_at)) fail('schema')
  if (row.state === 'held' && row.input_tokens_actual === null && row.output_tokens_actual === null && row.cost_usd_micros_actual === null && row.settled_at === null) return freeze({ id: row.id, runId: row.run_id, inputTokens: row.input_tokens_reserved, outputTokens: row.output_tokens_reserved, costUsdMicros: row.cost_usd_micros_reserved, state: 'held', reservedAt: row.reserved_at })
  if (row.state === 'settled' && integer(row.input_tokens_actual) && integer(row.output_tokens_actual) && time(row.settled_at) && row.settled_at >= row.reserved_at
    && row.input_tokens_actual <= row.input_tokens_reserved && row.output_tokens_actual <= row.output_tokens_reserved
    && ((row.cost_usd_micros_reserved === null && row.cost_usd_micros_actual === null) || (integer(row.cost_usd_micros_reserved) && integer(row.cost_usd_micros_actual) && row.cost_usd_micros_actual <= row.cost_usd_micros_reserved))) return freeze({ id: row.id, runId: row.run_id, inputTokens: row.input_tokens_actual, outputTokens: row.output_tokens_actual, costUsdMicros: row.cost_usd_micros_actual, state: 'settled', reservedAt: row.reserved_at, settledAt: row.settled_at })
  fail('schema')
}

/** Private durable budget ledger. Held reservations deliberately survive restart. */
export class GoalBudgetStore {
  readonly #database: DatabaseSync
  constructor(path: string) {
    if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    this.#database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      const tables = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
      if (version === 0 && tables.length === 0) this.#database.exec(`BEGIN IMMEDIATE;
        CREATE TABLE goal_budget_limits (scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, model_calls INTEGER NOT NULL, tool_calls INTEGER NOT NULL, input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, cost_usd_micros INTEGER, expires_at INTEGER NOT NULL, PRIMARY KEY(scope_json, goal_id)) STRICT, WITHOUT ROWID;
        CREATE TABLE goal_budget_reservations (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, run_id TEXT NOT NULL, input_tokens_reserved INTEGER NOT NULL, output_tokens_reserved INTEGER NOT NULL, cost_usd_micros_reserved INTEGER, state TEXT NOT NULL CHECK(state IN ('held','settled')), reserved_at INTEGER NOT NULL, input_tokens_actual INTEGER, output_tokens_actual INTEGER, cost_usd_micros_actual INTEGER, settled_at INTEGER, FOREIGN KEY(scope_json, goal_id) REFERENCES goal_budget_limits(scope_json, goal_id)) STRICT;
        CREATE TABLE goal_budget_tools (id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, goal_id TEXT NOT NULL, consumed_at INTEGER NOT NULL, FOREIGN KEY(scope_json, goal_id) REFERENCES goal_budget_limits(scope_json, goal_id)) STRICT;
        CREATE TABLE goal_budget_request_ids (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('reserve','tool'))) STRICT;
        CREATE INDEX goal_budget_reservations_scope_goal ON goal_budget_reservations(scope_json, goal_id);
        CREATE INDEX goal_budget_tools_scope_goal ON goal_budget_tools(scope_json, goal_id);
        PRAGMA user_version = 1; COMMIT;`)
      else if (version !== 1 || !equal(tables, ['goal_budget_limits', 'goal_budget_request_ids', 'goal_budget_reservations', 'goal_budget_tools'])) fail('schema')
      this.#validate()
      if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
    } catch (error) { this.#database.close(); throw error }
  }
  #key(binding: GoalBudgetScope): [GoalBudgetScope, string] { const result = scopeInput(binding); return [result, acceptanceCanonicalJson(result.scope)] }
  #limit(key: string, goalId: string): LimitRow | undefined { return this.#database.prepare('SELECT model_calls, tool_calls, input_tokens, output_tokens, cost_usd_micros, expires_at FROM goal_budget_limits WHERE scope_json = ? AND goal_id = ?').get(key, goalId) as LimitRow | undefined }
  #limits(row: LimitRow): GoalBudgetLimits { return limitsInput({ modelCalls: row.model_calls, toolCalls: row.tool_calls, inputTokens: row.input_tokens, outputTokens: row.output_tokens, costUsdMicros: row.cost_usd_micros, expiresAt: row.expires_at }) }
  #snapshot(key: string, goalId: string): GoalBudgetSnapshot {
    const limits = this.#limit(key, goalId); if (!limits) fail('not-found'); const parsed = this.#limits(limits)
    const count = this.#database.prepare("SELECT COUNT(*) AS model_calls, COALESCE(SUM(CASE WHEN state = 'held' THEN 1 ELSE 0 END), 0) AS held_calls, COALESCE(SUM(CASE WHEN state = 'held' THEN input_tokens_reserved ELSE input_tokens_actual END), 0) AS input_tokens, COALESCE(SUM(CASE WHEN state = 'held' THEN output_tokens_reserved ELSE output_tokens_actual END), 0) AS output_tokens, COALESCE(SUM(CASE WHEN state = 'held' THEN COALESCE(cost_usd_micros_reserved, 0) ELSE COALESCE(cost_usd_micros_actual, 0) END), 0) AS cost_usd_micros FROM goal_budget_reservations WHERE scope_json = ? AND goal_id = ?").get(key, goalId) as { model_calls: number; held_calls: number; input_tokens: number; output_tokens: number; cost_usd_micros: number }
    const tool = this.#database.prepare('SELECT COUNT(*) AS tool_calls FROM goal_budget_tools WHERE scope_json = ? AND goal_id = ?').get(key, goalId) as { tool_calls: number }
    if (![count.model_calls, count.held_calls, count.input_tokens, count.output_tokens, count.cost_usd_micros, tool.tool_calls].every(integer)) fail('schema')
    return freeze({ limits: parsed, modelCalls: count.model_calls, toolCalls: tool.tool_calls, inputTokens: count.input_tokens, outputTokens: count.output_tokens, costUsdMicros: parsed.costUsdMicros === null ? null : count.cost_usd_micros, heldCalls: count.held_calls })
  }
  #validate(): void {
    const expected: Record<string, readonly string[]> = { goal_budget_limits: ['scope_json', 'goal_id', 'model_calls', 'tool_calls', 'input_tokens', 'output_tokens', 'cost_usd_micros', 'expires_at'], goal_budget_reservations: ['id', 'scope_json', 'goal_id', 'run_id', 'input_tokens_reserved', 'output_tokens_reserved', 'cost_usd_micros_reserved', 'state', 'reserved_at', 'input_tokens_actual', 'output_tokens_actual', 'cost_usd_micros_actual', 'settled_at'], goal_budget_tools: ['id', 'scope_json', 'goal_id', 'consumed_at'], goal_budget_request_ids: ['id', 'kind'] }
    for (const [table, columns] of Object.entries(expected)) {
      const actual = (this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
      const schema = this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined
      if (!schema || !equal(actual, columns) || !/\bSTRICT\b/u.test(schema.sql)) fail('schema')
    }
    const limitSql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_budget_limits'").get() as { sql: string }).sql
    if (!/WITHOUT\s+ROWID/iu.test(limitSql) || !/PRIMARY\s+KEY\s*\(\s*scope_json\s*,\s*goal_id\s*\)/iu.test(limitSql)) fail('schema')
    for (const table of ['goal_budget_reservations', 'goal_budget_tools', 'goal_budget_request_ids']) {
      const primary = (this.#database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>).filter(row => row.pk === 1).map(row => row.name)
      if (!equal(primary, ['id'])) fail('schema')
    }
    const reservationSql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_budget_reservations'").get() as { sql: string }).sql
    const requestSql = (this.#database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'goal_budget_request_ids'").get() as { sql: string }).sql
    if (!/CHECK\s*\(\s*state\s+IN\s*\(\s*'held'\s*,\s*'settled'\s*\)\s*\)/iu.test(reservationSql)
      || !/CHECK\s*\(\s*kind\s+IN\s*\(\s*'reserve'\s*,\s*'tool'\s*\)\s*\)/iu.test(requestSql)) fail('schema')
    const reservationsForeignKeys = this.#database.prepare('PRAGMA foreign_key_list(goal_budget_reservations)').all() as Array<{ table: string; from: string; to: string }>
    const toolsForeignKeys = this.#database.prepare('PRAGMA foreign_key_list(goal_budget_tools)').all() as Array<{ table: string; from: string; to: string }>
    if (!reservationsForeignKeys.some(row => row.table === 'goal_budget_limits' && row.from === 'scope_json' && row.to === 'scope_json')
      || !reservationsForeignKeys.some(row => row.table === 'goal_budget_limits' && row.from === 'goal_id' && row.to === 'goal_id')
      || !toolsForeignKeys.some(row => row.table === 'goal_budget_limits' && row.from === 'scope_json' && row.to === 'scope_json')
      || !toolsForeignKeys.some(row => row.table === 'goal_budget_limits' && row.from === 'goal_id' && row.to === 'goal_id')) fail('schema')
    const indexes = (this.#database.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND name IN ('goal_budget_reservations_scope_goal', 'goal_budget_tools_scope_goal') ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    if (!equal(indexes, ['goal_budget_reservations_scope_goal', 'goal_budget_tools_scope_goal'])) fail('schema')
    const check = this.#database.prepare('PRAGMA quick_check').get() as { quick_check: string }; if (check.quick_check !== 'ok' || (this.#database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length !== 0) fail('schema')
    const limitRows = this.#database.prepare('SELECT scope_json, goal_id FROM goal_budget_limits').all() as Array<{ scope_json: string; goal_id: string }>
    const configured = new Map<string, GoalBudgetLimits>()
    for (const row of limitRows) {
      let scope: unknown; try { scope = JSON.parse(row.scope_json) } catch { fail('schema') }
      const binding = scopeInput({ scope: scope as GoalScope, goalId: row.goal_id })
      if (acceptanceCanonicalJson(binding.scope) !== row.scope_json) fail('schema')
      configured.set(`${row.scope_json}\u0000${row.goal_id}`, this.#limits(this.#limit(row.scope_json, row.goal_id)!))
    }
    const ids = this.#database.prepare("SELECT id, kind FROM goal_budget_request_ids").all() as Array<{ id: string; kind: string }>
    for (const item of ids) {
      const source = item.kind === 'reserve' ? 'goal_budget_reservations' : item.kind === 'tool' ? 'goal_budget_tools' : undefined
      if (!source || !idPattern.test(item.id)) fail('schema')
      const count = (this.#database.prepare(`SELECT COUNT(*) AS count FROM ${source} WHERE id = ?`).get(item.id) as { count: number }).count
      if (count !== 1) fail('schema')
    }
    for (const row of this.#database.prepare('SELECT * FROM goal_budget_reservations').all() as Array<Row & { scope_json: string; goal_id: string }>) {
      rowReservation(row)
      const limits = configured.get(`${row.scope_json}\u0000${row.goal_id}`)
      const request = (this.#database.prepare("SELECT COUNT(*) AS count FROM goal_budget_request_ids WHERE id = ? AND kind = 'reserve'").get(row.id) as { count: number }).count
      if (!limits || request !== 1 || row.reserved_at >= limits.expiresAt || (limits.costUsdMicros !== null && row.cost_usd_micros_reserved === null)) fail('schema')
    }
    for (const row of this.#database.prepare('SELECT id, scope_json, goal_id, consumed_at FROM goal_budget_tools').all() as Array<{ id: string; scope_json: string; goal_id: string; consumed_at: number }>) {
      const limits = configured.get(`${row.scope_json}\u0000${row.goal_id}`)
      const request = (this.#database.prepare("SELECT COUNT(*) AS count FROM goal_budget_request_ids WHERE id = ? AND kind = 'tool'").get(row.id) as { count: number }).count
      if (!limits || !idPattern.test(row.id) || !time(row.consumed_at) || row.consumed_at >= limits.expiresAt || request !== 1) fail('schema')
    }
    for (const row of limitRows) {
      const snapshot = this.#snapshot(row.scope_json, row.goal_id)
      if (snapshot.modelCalls > snapshot.limits.modelCalls || snapshot.toolCalls > snapshot.limits.toolCalls || snapshot.inputTokens > snapshot.limits.inputTokens || snapshot.outputTokens > snapshot.limits.outputTokens || (snapshot.limits.costUsdMicros !== null && snapshot.costUsdMicros! > snapshot.limits.costUsdMicros)) fail('schema')
    }
  }
  configure(binding: GoalBudgetScope, limits: GoalBudgetLimits): GoalBudgetSnapshot {
    const [input, key] = this.#key(binding); const value = limitsInput(limits); const existing = this.#limit(key, input.goalId)
    if (existing) { if (!equal(this.#limits(existing), value)) fail('conflict'); return this.#snapshot(key, input.goalId) }
    try { this.#database.prepare('INSERT INTO goal_budget_limits(scope_json, goal_id, model_calls, tool_calls, input_tokens, output_tokens, cost_usd_micros, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(key, input.goalId, value.modelCalls, value.toolCalls, value.inputTokens, value.outputTokens, value.costUsdMicros, value.expiresAt) } catch { fail('conflict') }
    return this.#snapshot(key, input.goalId)
  }
  /** Read-only candidate view. It never inserts limits, requests, or reservations. */
  preview(binding: GoalBudgetScope, limits: GoalBudgetLimits): GoalBudgetSnapshot {
    const [input, key] = this.#key(binding); const candidate = limitsInput(limits); const existing = this.#limit(key, input.goalId)
    if (existing === undefined) return freeze({ limits: candidate, modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, costUsdMicros: candidate.costUsdMicros === null ? null : 0, heldCalls: 0 })
    if (!equal(this.#limits(existing), candidate)) fail('conflict')
    return this.#snapshot(key, input.goalId)
  }
  reserve(binding: GoalBudgetScope, request: { id: string; runId: string; inputTokens: number; outputTokens: number; costUsdMicros: number | null }, now: number): GoalBudgetReservation {
    const [input, key] = this.#key(binding)
    const value = requestInput(request)
    if (!time(now)) fail('invalid-input')
    this.#database.exec('BEGIN IMMEDIATE;')
    try {
      const snapshot = this.#snapshot(key, input.goalId)
      if (now >= snapshot.limits.expiresAt
        || (snapshot.limits.costUsdMicros !== null && value.costUsdMicros === null)
        || snapshot.modelCalls + 1 > snapshot.limits.modelCalls
        || snapshot.inputTokens + value.inputTokens > snapshot.limits.inputTokens
        || snapshot.outputTokens + value.outputTokens > snapshot.limits.outputTokens
        || (snapshot.limits.costUsdMicros !== null && snapshot.costUsdMicros! + value.costUsdMicros! > snapshot.limits.costUsdMicros)) fail('conflict')
      this.#database.prepare("INSERT INTO goal_budget_request_ids(id, kind) VALUES (?, 'reserve')").run(value.id)
      this.#database.prepare("INSERT INTO goal_budget_reservations(id, scope_json, goal_id, run_id, input_tokens_reserved, output_tokens_reserved, cost_usd_micros_reserved, state, reserved_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'held', ?)")
        .run(value.id, key, input.goalId, value.runId, value.inputTokens, value.outputTokens, value.costUsdMicros, now)
      this.#database.exec('COMMIT;')
    } catch (error) {
      try { this.#database.exec('ROLLBACK;') } catch {}
      if (error instanceof GoalStoreError) throw error
      fail('conflict')
    }
    return this.#reservation(value.id)!
  }
  #reservation(id: string): GoalBudgetReservation | undefined { const row = this.#database.prepare('SELECT * FROM goal_budget_reservations WHERE id = ?').get(id) as Row | undefined; return row === undefined ? undefined : rowReservation(row) }
  settle(id: string, actual: { inputTokens: number; outputTokens: number; costUsdMicros: number | null }, now: number): GoalBudgetReservation {
    if (!idPattern.test(id) || !time(now)) fail('invalid-input')
    const value = actualInput(actual)
    const found = this.#reservation(id)
    if (!found) fail('not-found')
    if (found.state === 'settled') {
      if (equal({ inputTokens: found.inputTokens, outputTokens: found.outputTokens, costUsdMicros: found.costUsdMicros }, value)) return found
      fail('conflict')
    }
    if (value.inputTokens > found.inputTokens || value.outputTokens > found.outputTokens || !((found.costUsdMicros === null && value.costUsdMicros === null) || (found.costUsdMicros !== null && value.costUsdMicros !== null && value.costUsdMicros <= found.costUsdMicros))) fail('invalid-input')
    if (now < found.reservedAt) fail('invalid-input')
    try {
      const result = this.#database.prepare("UPDATE goal_budget_reservations SET state = 'settled', input_tokens_actual = ?, output_tokens_actual = ?, cost_usd_micros_actual = ?, settled_at = ? WHERE id = ? AND state = 'held'")
        .run(value.inputTokens, value.outputTokens, value.costUsdMicros, now, id)
      if (Number(result.changes) !== 1) fail('conflict')
    } catch (error) {
      if (error instanceof GoalStoreError) throw error
      fail('conflict')
    }
    return this.#reservation(id)!
  }
  consumeTool(binding: GoalBudgetScope, id: string, now: number): GoalBudgetSnapshot {
    const [input, key] = this.#key(binding)
    if (!idPattern.test(id) || !time(now)) fail('invalid-input')
    this.#database.exec('BEGIN IMMEDIATE;')
    try {
      const snapshot = this.#snapshot(key, input.goalId)
      if (now >= snapshot.limits.expiresAt || snapshot.toolCalls + 1 > snapshot.limits.toolCalls) fail('conflict')
      this.#database.prepare("INSERT INTO goal_budget_request_ids(id, kind) VALUES (?, 'tool')").run(id)
      this.#database.prepare('INSERT INTO goal_budget_tools(id, scope_json, goal_id, consumed_at) VALUES (?, ?, ?, ?)').run(id, key, input.goalId, now)
      this.#database.exec('COMMIT;')
    } catch (error) {
      try { this.#database.exec('ROLLBACK;') } catch {}
      if (error instanceof GoalStoreError) throw error
      fail('conflict')
    }
    return this.#snapshot(key, input.goalId)
  }
  snapshot(binding: GoalBudgetScope): GoalBudgetSnapshot { const [input, key] = this.#key(binding); return this.#snapshot(key, input.goalId) }
  close(): void { this.#database.close() }
}
