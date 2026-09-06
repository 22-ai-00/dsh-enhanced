import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceCanonicalJson } from '@dsh-enhanced/task-acceptance-contract'
import { BenchmarkError, benchmarkInteger, benchmarkPlanDigest, benchmarkResultParser, benchmarkSchedule, benchmarkSnapshot, parseBenchmarkPlan } from './schema.js'
import type { BenchmarkCell, BenchmarkPlan, BenchmarkResult } from './types.js'

const schemaVersion = 1
const tableColumns: Readonly<Record<string, readonly string[]>> = Object.freeze({
  benchmark_journal_plans: ['id', 'digest', 'plan_json', 'cells_json'],
  benchmark_journal_intents: ['plan_id', 'cell_id', 'cell_json', 'started_at'],
  benchmark_journal_results: ['plan_id', 'cell_id', 'result_json'],
})

type PlanRow = { id: string; digest: string; plan_json: string; cells_json: string }
type IntentRow = { cell_id: string; cell_json: string; started_at: number }
type ResultRow = { cell_id: string; result_json: string }
type CompiledPlan = { digest: string; cells: readonly BenchmarkCell[]; positions: ReadonlyMap<string, number>; parseResult: (value: unknown) => BenchmarkResult }

function databaseError(message: string): never { throw new BenchmarkError(message) }

function assertPrivateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) databaseError('benchmark database must be one regular, unlinked file')
  if ((stat.mode & 0o077) !== 0) databaseError('benchmark database permissions must be 0600')
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) databaseError('benchmark database must be owned by the current OS user')
}

function prepareFile(path: string): void {
  if (!isAbsolute(path)) databaseError('benchmark database path must be absolute or :memory:')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  if (!existsSync(path)) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    closeSync(descriptor)
    chmodSync(path, 0o600)
  }
  assertPrivateFile(path)
}

function json(value: string, label: string): unknown {
  try { return JSON.parse(value) as unknown } catch { return databaseError(`invalid ${label} JSON in benchmark journal`) }
}

function schemaTables(database: DatabaseSync): readonly string[] {
  return (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(row => row.name)
}

function schemaObjects(database: DatabaseSync): readonly { type: string; name: string }[] {
  return database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all() as Array<{ type: string; name: string }>
}

function validateSchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  if (version > schemaVersion) databaseError(`benchmark schema ${version} is newer than supported schema ${schemaVersion}`)
  const initialObjects = schemaObjects(database)
  if (version === 0) {
    if (initialObjects.length !== 0) databaseError('non-empty benchmark schema version zero is not supported')
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
      CREATE TABLE benchmark_journal_plans (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, plan_json TEXT NOT NULL, cells_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE benchmark_journal_intents (
        plan_id TEXT PRIMARY KEY REFERENCES benchmark_journal_plans(id) ON DELETE RESTRICT,
        cell_id TEXT NOT NULL, cell_json TEXT NOT NULL, started_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE benchmark_journal_results (
        plan_id TEXT NOT NULL REFERENCES benchmark_journal_plans(id) ON DELETE RESTRICT,
        cell_id TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY (plan_id, cell_id)
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 1;
    `)
      database.exec('COMMIT')
    } catch (error) {
      database.exec('ROLLBACK')
      throw error
    }
  }
  if (version !== 0 && version !== schemaVersion) databaseError(`unsupported benchmark schema ${version}`)
  const actualTables = schemaTables(database)
  const expectedTables = Object.keys(tableColumns).sort()
  if (acceptanceCanonicalJson(actualTables) !== acceptanceCanonicalJson(expectedTables)) databaseError('incomplete or unrecognized benchmark schema version one')
  for (const [table, expected] of Object.entries(tableColumns)) {
    const actual = (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name)
    if (acceptanceCanonicalJson(actual) !== acceptanceCanonicalJson(expected)) databaseError('incomplete benchmark schema version one')
  }
  const tableSql = new Map((database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string }>).map(row => [row.name, row.sql]))
  if (![...tableSql.values()].every(sql => /\bSTRICT\b/u.test(sql)) || !/WITHOUT\s+ROWID/iu.test(tableSql.get('benchmark_journal_results') ?? '')) {
    databaseError('benchmark schema version one must use strict tables and a without-rowid result key')
  }
  const columns = (table: string) => database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  const primaryKey = (table: string) => columns(table).filter(column => column.pk > 0).sort((left, right) => left.pk - right.pk).map(column => column.name)
  if (!same(primaryKey('benchmark_journal_plans'), ['id']) || !same(primaryKey('benchmark_journal_intents'), ['plan_id'])
    || !same(primaryKey('benchmark_journal_results'), ['plan_id', 'cell_id'])) databaseError('benchmark schema version one lacks required primary keys')
  const foreignKeys = (table: string) => database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{ table: string; from: string; to: string }>
  if (!foreignKeys('benchmark_journal_intents').some(key => key.table === 'benchmark_journal_plans' && key.from === 'plan_id' && key.to === 'id')
    || !foreignKeys('benchmark_journal_results').some(key => key.table === 'benchmark_journal_plans' && key.from === 'plan_id' && key.to === 'id')) databaseError('benchmark schema version one lacks required foreign keys')
  const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND type <> 'table'").all() as Array<{ type: string; name: string }>
  if (objects.some(object => object.type !== 'index')) databaseError('benchmark schema version one contains unsupported objects')
  const quickCheck = database.prepare('PRAGMA quick_check').get() as { quick_check: string }
  if (quickCheck.quick_check !== 'ok' || (database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length !== 0) databaseError('benchmark journal integrity check failed')
}

function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') prepareFile(path)
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    validateSchema(database)
    if (path !== ':memory:') assertPrivateFile(path)
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function same(left: unknown, right: unknown): boolean { return acceptanceCanonicalJson(left) === acceptanceCanonicalJson(right) }

export class BenchmarkStore {
  readonly #database: DatabaseSync
  readonly #compiled = new Map<string, CompiledPlan>()

  constructor(path: string) { this.#database = openDatabase(path) }

  #transaction<T>(operation: () => T): T {
    try {
      this.#database.exec('BEGIN IMMEDIATE')
    } catch {
      throw new BenchmarkError('benchmark journal transaction unavailable')
    }
    try {
      const value = operation()
      this.#database.exec('COMMIT')
      return value
    } catch (error) {
      this.#database.exec('ROLLBACK')
      throw error
    }
  }

  #row(id: string): PlanRow {
    const row = this.#database.prepare('SELECT id, digest, plan_json, cells_json FROM benchmark_journal_plans WHERE id = ?').get(id) as PlanRow | undefined
    if (!row) databaseError(`benchmark plan ${id} was not found`)
    return row
  }

  #readPlan(id: string): Readonly<BenchmarkPlan> {
    const row = this.#row(id)
    const plan = parseBenchmarkPlan(json(row.plan_json, 'plan'))
    const digest = benchmarkPlanDigest(plan)
    if (plan.id !== id || row.digest !== digest) databaseError('benchmark journal plan digest does not match its manifest')
    const compiled = this.#compile(plan, digest)
    if (row.cells_json !== JSON.stringify(compiled.cells)) databaseError('benchmark journal contains an invalid schedule')
    return plan
  }

  #compile(plan: BenchmarkPlan, digest = benchmarkPlanDigest(plan)): CompiledPlan {
    const cached = this.#compiled.get(plan.id)
    if (cached?.digest === digest) return cached
    const cells = benchmarkSchedule(plan)
    const compiled: CompiledPlan = Object.freeze({
      digest, cells, positions: new Map(cells.map((cell, index) => [cell.id, index])), parseResult: benchmarkResultParser(plan),
    })
    this.#compiled.set(plan.id, compiled)
    return compiled
  }

  #readResults(plan: BenchmarkPlan): readonly BenchmarkResult[] {
    const compiled = this.#compile(plan)
    const rows = this.#database.prepare('SELECT cell_id, result_json FROM benchmark_journal_results WHERE plan_id = ?').all(plan.id) as ResultRow[]
    const seen = new Set<string>()
    const parsed = rows.map(row => {
      const result = compiled.parseResult(json(row.result_json, 'result'))
      if (result.cell.id !== row.cell_id || seen.has(row.cell_id)) databaseError('benchmark journal contains duplicate or mismatched results')
      seen.add(row.cell_id)
      return result
    })
    return Object.freeze(parsed.sort((left, right) => compiled.positions.get(left.cell.id)! - compiled.positions.get(right.cell.id)!))
  }

  create(input: BenchmarkPlan): void {
    const plan = parseBenchmarkPlan(input)
    const digest = benchmarkPlanDigest(plan)
    const cells = this.#compile(plan, digest).cells
    this.#transaction(() => {
      const row = this.#database.prepare('SELECT id, digest, plan_json, cells_json FROM benchmark_journal_plans WHERE id = ?').get(plan.id) as PlanRow | undefined
      if (row) {
        const existing = this.#readPlan(plan.id)
        if (row.digest !== digest || !same(existing, plan)) databaseError('benchmark plan id already has different frozen content')
        return
      }
      this.#database.prepare('INSERT INTO benchmark_journal_plans(id, digest, plan_json, cells_json) VALUES (?, ?, ?, ?)')
        .run(plan.id, digest, acceptanceCanonicalJson(plan), JSON.stringify(cells))
    })
  }

  plan(id: string): Readonly<BenchmarkPlan> { return this.#readPlan(id) }

  results(id: string): readonly BenchmarkResult[] { return this.#readResults(this.#readPlan(id)) }

  start(id: string, input: BenchmarkCell, now: number): boolean {
    benchmarkInteger(now)
    return this.#transaction(() => {
      const plan = this.#readPlan(id)
      const cells = this.#compile(plan).cells
      const cell = benchmarkSnapshot(input)
      const scheduled = cells.find(candidate => candidate.id === cell.id)
      if (!scheduled || !same(scheduled, cell)) databaseError('benchmark cell is not an exact scheduled cell')
      const results = this.#readResults(plan)
      if (results.some(result => result.cell.id === cell.id)) return false
      if (results.some(result => result.status === 'unknown')) databaseError('benchmark plan has an unknown terminal result and cannot continue')
      const intent = this.#database.prepare('SELECT cell_id, cell_json, started_at FROM benchmark_journal_intents WHERE plan_id = ?').get(id) as IntentRow | undefined
      if (intent) {
        const stored = benchmarkSnapshot(json(intent.cell_json, 'running intent')) as BenchmarkCell
        if (intent.cell_id !== stored.id || !cells.some(candidate => same(candidate, stored))) databaseError('benchmark journal contains an invalid running intent')
        databaseError('benchmark plan has a running intent and cannot be started again')
      }
      const completed = new Set(results.map(result => result.cell.id))
      const first = cells.find(candidate => !completed.has(candidate.id))
      if (!first || first.id !== cell.id) databaseError('benchmark cell is not the first unfinished scheduled cell')
      this.#database.prepare('INSERT INTO benchmark_journal_intents(plan_id, cell_id, cell_json, started_at) VALUES (?, ?, ?, ?)')
        .run(id, cell.id, acceptanceCanonicalJson(cell), now)
      return true
    })
  }

  finish(id: string, input: BenchmarkResult): void {
    this.#transaction(() => {
      const plan = this.#readPlan(id)
      const result = this.#compile(plan).parseResult(input)
      const prior = this.#database.prepare('SELECT cell_id, result_json FROM benchmark_journal_results WHERE plan_id = ? AND cell_id = ?').get(id, result.cell.id) as ResultRow | undefined
      if (prior) {
        const stored = this.#compile(plan).parseResult(json(prior.result_json, 'result'))
        if (prior.cell_id === result.cell.id && same(stored, result)) return
        databaseError('benchmark result replay has different content')
      }
      const intent = this.#database.prepare('SELECT cell_id, cell_json, started_at FROM benchmark_journal_intents WHERE plan_id = ?').get(id) as IntentRow | undefined
      if (!intent) databaseError('benchmark result has no running intent')
      const cell = benchmarkSnapshot(json(intent.cell_json, 'running intent')) as BenchmarkCell
      if (intent.cell_id !== cell.id || !same(cell, result.cell) || result.startedAt !== intent.started_at) databaseError('benchmark result does not match its running intent or started time')
      this.#database.prepare('INSERT INTO benchmark_journal_results(plan_id, cell_id, result_json) VALUES (?, ?, ?)')
        .run(id, result.cell.id, acceptanceCanonicalJson(result))
      this.#database.prepare('DELETE FROM benchmark_journal_intents WHERE plan_id = ?').run(id)
    })
  }

  interrupt(id: string, now: number): void {
    benchmarkInteger(now)
    this.#transaction(() => {
      const plan = this.#readPlan(id)
      const intent = this.#database.prepare('SELECT cell_id, cell_json, started_at FROM benchmark_journal_intents WHERE plan_id = ?').get(id) as IntentRow | undefined
      if (!intent) return
      const cell = benchmarkSnapshot(json(intent.cell_json, 'running intent')) as BenchmarkCell
      if (intent.cell_id !== cell.id || !this.#compile(plan).cells.some(candidate => same(candidate, cell))) databaseError('benchmark journal contains an invalid running intent')
      if (now < intent.started_at) databaseError('benchmark interruption precedes its started time')
      const result = this.#compile(plan).parseResult({
        cell, status: 'unknown', verdict: 'unknown', metrics: {
          inputTokens: null, outputTokens: null, costUsdMicros: null, toolCalls: null, rework: null, interventions: null, latencyMs: null,
        }, evidenceDigest: null, reason: 'interrupted', startedAt: intent.started_at, completedAt: now,
      })
      this.#database.prepare('INSERT INTO benchmark_journal_results(plan_id, cell_id, result_json) VALUES (?, ?, ?)')
        .run(id, cell.id, acceptanceCanonicalJson(result))
      this.#database.prepare('DELETE FROM benchmark_journal_intents WHERE plan_id = ?').run(id)
    })
  }

  close(): void { this.#database.close() }
}
