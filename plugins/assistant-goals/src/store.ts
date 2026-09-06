import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { isAbsolute, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { GoalStoreError } from './types.js'
import type { GoalCheckpoint, GoalDefinition, GoalRecord, GoalScope, NativeGoalState } from './types.js'

const schemaVersion = 2
const message = 'goal store operation rejected'
const phases = new Set<NativeGoalState['phase']>(['active', 'paused', 'blocked', 'complete', 'cleared'])

type GoalRow = {
  id: string; scope_json: string; original_objective: string; definition_json: string; native_json: string; checkpoint_json: string
  version: number; created_at: number; updated_at: number
}

const fail = (code: ConstructorParameters<typeof GoalStoreError>[0]): never => { throw new GoalStoreError(code) }
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right)

function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) fail('unsafe-file')
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) fail('unsafe-file')
}

function privateDatabaseFiles(path: string): void {
  privateFile(path)
  // These checks reject known unsafe paths, but cannot prevent a same-UID actor
  // replacing a path after lstat and before SQLite opens it.
  for (const suffix of ['-wal', '-shm']) {
    try { privateFile(`${path}${suffix}`) } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
  }
}

export function prepareGoalStoreDatabaseFile(path: string): void {
  if (!isAbsolute(path)) fail('unsafe-file')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  privateDirectory(dirname(path))
  let present = false
  try { lstatSync(path); present = true } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') fail('unsafe-file')
  }
  if (!present) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    closeSync(descriptor)
    chmodSync(path, 0o600)
  }
  privateDatabaseFiles(path)
}

function validateSchema(database: DatabaseSync): void {
  let version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Array<{ type: string; name: string }>
  if (version === 0) {
    if (objects.length !== 0) fail('schema')
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE goal_records (
        id TEXT PRIMARY KEY, scope_json TEXT NOT NULL, original_objective TEXT NOT NULL, definition_json TEXT NOT NULL, native_json TEXT NOT NULL,
        checkpoint_json TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE goal_history (
        record_id TEXT NOT NULL REFERENCES goal_records(id) ON DELETE RESTRICT, sequence INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('native', 'checkpoint')), payload_json TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(record_id, sequence)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE goal_focus (
        scope_json TEXT NOT NULL, session_id TEXT NOT NULL, record_id TEXT NOT NULL,
        PRIMARY KEY(scope_json, session_id),
        FOREIGN KEY(record_id) REFERENCES goal_records(id) ON DELETE RESTRICT
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }
  if (version === 1) {
    const columns = (database.prepare('PRAGMA table_info(goal_records)').all() as Array<{ name: string }>).map(row => row.name)
    if (!same(columns, ['id', 'scope_json', 'original_objective', 'native_json', 'checkpoint_json', 'version', 'created_at', 'updated_at'])) fail('schema')
    database.exec('BEGIN IMMEDIATE; ALTER TABLE goal_records ADD COLUMN definition_json TEXT NOT NULL DEFAULT \'{}\';')
    const rows = database.prepare('SELECT id FROM goal_records').all() as Array<{ id: string }>
    const history = database.prepare("SELECT record_id, payload_json FROM goal_history WHERE kind = 'native' ORDER BY record_id, sequence").all() as Array<{ record_id: string; payload_json: string }>
    const natives = new Map<string, NativeGoalState[]>()
    for (const row of history) {
      const values = natives.get(row.record_id) ?? []
      values.push(nativeInput(parse(row.payload_json))); natives.set(row.record_id, values)
    }
    for (const row of rows) {
      const values = natives.get(row.id)
      if (!values || values.length === 0) fail('schema')
      const definition = definitionFromHistory(values!)
      database.prepare('UPDATE goal_records SET definition_json = ? WHERE id = ?').run(JSON.stringify(definition), row.id)
    }
    validateStoredPayloads(database)
    database.exec('PRAGMA user_version = 2; COMMIT;')
    version = 2
  }
  if (version !== 0 && version !== schemaVersion) fail('schema')
  const expected = JSON.stringify(['goal_focus', 'goal_history', 'goal_records'])
  const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
  if (JSON.stringify(tables) !== expected) fail('schema')
  const recordColumns = (database.prepare('PRAGMA table_info(goal_records)').all() as Array<{ name: string }>).map(row => row.name)
  const historyColumns = (database.prepare('PRAGMA table_info(goal_history)').all() as Array<{ name: string }>).map(row => row.name)
  const focusColumns = (database.prepare('PRAGMA table_info(goal_focus)').all() as Array<{ name: string }>).map(row => row.name)
  if (!same(recordColumns.sort(), ['id', 'scope_json', 'original_objective', 'definition_json', 'native_json', 'checkpoint_json', 'version', 'created_at', 'updated_at'].sort())
    || !same(historyColumns, ['record_id', 'sequence', 'kind', 'payload_json', 'recorded_at'])
    || !same(focusColumns, ['scope_json', 'session_id', 'record_id'])) fail('schema')
  const sql = database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string }>
  if (!sql.every(row => /\bSTRICT\b/u.test(row.sql)) || !/WITHOUT\s+ROWID/iu.test(sql.find(row => row.name === 'goal_history')?.sql ?? '')) fail('schema')
  const focusKeys = database.prepare('PRAGMA foreign_key_list(goal_focus)').all() as Array<{ table: string; from: string; to: string }>
  if (!focusKeys.some(key => key.table === 'goal_records' && key.from === 'record_id' && key.to === 'id')) fail('schema')
  const check = database.prepare('PRAGMA quick_check').get() as { quick_check: string }
  if (check.quick_check !== 'ok' || (database.prepare('PRAGMA foreign_key_check').all() as unknown[]).length !== 0) fail('schema')
}

function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') prepareGoalStoreDatabaseFile(path)
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    validateSchema(database)
    validateStoredPayloads(database)
    if (path !== ':memory:') { privateDirectory(dirname(path)); privateDatabaseFiles(path) }
    return database
  } catch (error) { database.close(); throw error }
}

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value) || !same(Object.getOwnPropertyNames(value).sort(), [...keys].sort())) fail('invalid-input')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-input')
  return value as Record<string, unknown>
}

function array(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) fail('invalid-input')
  const input = value as unknown[]
  const names = Object.getOwnPropertyNames(input)
  if (names.length !== input.length + 1 || names.at(-1) !== 'length') fail('invalid-input')
  for (let index = 0; index < input.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(input, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid-input')
  }
  return input
}

function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail('invalid-input')
  return value as string
}

function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail('invalid-input')
  return value as number
}

function scopeInput(value: unknown): GoalScope {
  const input = object(value, ['principalId', 'principalRecordId', 'principalVersion', 'workspace', 'preset'])
  const workspace = text(input.workspace, 4096)
  if (!isAbsolute(workspace)) fail('invalid-input')
  return freeze({ principalId: text(input.principalId, 512), principalRecordId: text(input.principalRecordId, 512), principalVersion: integer(input.principalVersion, 1), workspace, preset: text(input.preset, 512) })
}

function nativeInput(value: unknown): NativeGoalState {
  const input = object(value, ['sessionId', 'goalId', 'revision', 'objective', 'phase', 'roundsStarted', 'maxGoalRounds', 'updatedAt'])
  const maxGoalRounds = integer(input.maxGoalRounds, 1)
  const roundsStarted = integer(input.roundsStarted, 0)
  if (roundsStarted > maxGoalRounds || typeof input.phase !== 'string' || !phases.has(input.phase as NativeGoalState['phase'])) fail('invalid-input')
  return freeze({ sessionId: text(input.sessionId, 512), goalId: text(input.goalId, 512), revision: integer(input.revision, 1), objective: text(input.objective, 16_384), phase: input.phase as NativeGoalState['phase'], roundsStarted, maxGoalRounds, updatedAt: integer(input.updatedAt, 0) })
}

function definitionInput(value: unknown): GoalDefinition {
  const input = object(value, ['version', 'digest', 'objective'])
  const objective = text(input.objective, 16_384)
  const version = integer(input.version, 1)
  const digest = text(input.digest, 128)
  if (digest !== acceptanceDigest({ objective })) fail('invalid-input')
  return freeze({ version, digest, objective })
}

function definitionFromHistory(natives: readonly NativeGoalState[]): GoalDefinition {
  let objective = natives[0]!.objective; let version = 1
  for (const native of natives.slice(1)) {
    if (native.objective !== objective) { objective = native.objective; version += 1 }
  }
  return freeze({ version, digest: acceptanceDigest({ objective }), objective })
}

function checkpointInput(value: unknown): GoalCheckpoint {
  const input = object(value, ['nextStep', 'blockers', 'assumptions', 'evidenceRefs', 'dependencies'])
  const blockers = array(input.blockers, 16).map(item => text(item, 2000))
  const assumptions = array(input.assumptions, 16).map(item => {
    const assumption = object(item, ['statement', 'expiresAt'])
    return freeze({ statement: text(assumption.statement, 2000), expiresAt: integer(assumption.expiresAt, 0) })
  })
  const evidenceRefs = array(input.evidenceRefs, 32).map(item => text(item, 512))
  const dependencies = array(input.dependencies, 16).map(item => text(item, 512))
  if (new Set(dependencies).size !== dependencies.length) fail('invalid-input')
  return freeze({ nextStep: text(input.nextStep, 4000, 0), blockers, assumptions, evidenceRefs, dependencies })
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function parse(json: string): unknown { try { return JSON.parse(json) as unknown } catch { return fail('schema') } }
function idFor(native: NativeGoalState): string { return createHash('sha256').update(native.sessionId).update('\0').update(native.goalId).digest('hex') }
function emptyCheckpoint(): GoalCheckpoint { return freeze({ nextStep: '', blockers: [], assumptions: [], evidenceRefs: [], dependencies: [] }) }

function validateStoredPayloads(database: DatabaseSync): void {
  try {
    const records = database.prepare('SELECT id, scope_json, original_objective, definition_json, native_json, checkpoint_json, version, created_at, updated_at FROM goal_records').all() as GoalRow[]
    const byId = new Map<string, { row: GoalRow; scope: GoalScope; native: NativeGoalState; checkpoint: GoalCheckpoint; definition: GoalDefinition }>()
    for (const row of records) {
      const native = nativeInput(parse(row.native_json)); const scope = scopeInput(parse(row.scope_json)); const checkpoint = checkpointInput(parse(row.checkpoint_json)); const definition = definitionInput(parse(row.definition_json))
      if (idFor(native) !== row.id || typeof row.original_objective !== 'string' || row.original_objective.length === 0 || row.original_objective.length > 16_384
        || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.created_at) || row.created_at < 0 || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at) fail('schema')
      byId.set(row.id, { row, scope, native, checkpoint, definition })
    }
    const history = database.prepare('SELECT record_id, sequence, kind, payload_json, recorded_at FROM goal_history ORDER BY record_id, sequence').all() as Array<{ record_id: string; sequence: number; kind: string; payload_json: string; recorded_at: number }>
    const historyById = new Map<string, typeof history>()
    for (const row of history) {
      if (typeof row.record_id !== 'string' || !Number.isSafeInteger(row.sequence) || row.sequence < 1 || !Number.isSafeInteger(row.recorded_at) || row.recorded_at < 0) fail('schema')
      if (!byId.has(row.record_id)) fail('schema')
      const entries = historyById.get(row.record_id) ?? []; entries.push(row); historyById.set(row.record_id, entries)
    }
    for (const [id, stored] of byId) {
      const events = historyById.get(id)
      if (!events || events.length !== stored.row.version + 1 || events[0]?.kind !== 'native' || events[1]?.kind !== 'checkpoint') throw new GoalStoreError('schema')
      const auditEvents = events
      let currentNative: NativeGoalState | undefined; let currentCheckpoint: GoalCheckpoint | undefined; let previousNative: NativeGoalState | undefined; let recordedAt = -1
      for (const [index, event] of auditEvents.entries()) {
        if (event.sequence !== index + 1 || event.recorded_at < recordedAt) fail('schema')
        recordedAt = event.recorded_at
        if (event.kind === 'native') {
          const native = nativeInput(parse(event.payload_json))
          if (idFor(native) !== id) fail('schema')
          if (previousNative && (native.revision < previousNative.revision || native.roundsStarted < previousNative.roundsStarted
            || (native.revision === previousNative.revision && (native.sessionId !== previousNative.sessionId || native.goalId !== previousNative.goalId || native.objective !== previousNative.objective || native.phase !== previousNative.phase || native.maxGoalRounds !== previousNative.maxGoalRounds)))) fail('schema')
          currentNative = native; previousNative = native
        } else if (event.kind === 'checkpoint') {
          const checkpoint = checkpointInput(parse(event.payload_json))
          if (index === 1 && !same(checkpoint, emptyCheckpoint())) fail('schema')
          currentCheckpoint = checkpoint
        } else fail('schema')
      }
      const initialNative = nativeInput(parse(auditEvents[0]!.payload_json))
      const historyDefinition = definitionFromHistory(auditEvents.filter(event => event.kind === 'native').map(event => nativeInput(parse(event.payload_json))))
      if (!currentNative || !currentCheckpoint || initialNative.objective !== stored.row.original_objective || stored.row.created_at !== auditEvents[0]!.recorded_at
        || stored.row.updated_at !== recordedAt || !same(currentNative, stored.native) || !same(currentCheckpoint, stored.checkpoint)
        || !same(historyDefinition, stored.definition)) fail('schema')
    }
    const focus = database.prepare('SELECT scope_json, session_id, record_id FROM goal_focus').all() as Array<{ scope_json: string; session_id: string; record_id: string }>
    for (const row of focus) {
      const focusScope = scopeInput(parse(row.scope_json)); const sessionId = text(row.session_id, 512); const recordId = text(row.record_id, 512)
      const stored = byId.get(recordId)
      if (!stored || !same(stored.scope, focusScope) || sessionId.length === 0) fail('schema')
    }
  } catch (error) { if (error instanceof GoalStoreError) fail('schema'); throw error }
}

export class GoalStore {
  readonly #database: DatabaseSync

  constructor(path: string) { this.#database = openDatabase(path) }

  #transaction<T>(operation: () => T): T {
    try { this.#database.exec('BEGIN IMMEDIATE') } catch { fail('conflict') }
    try { const result = operation(); this.#database.exec('COMMIT'); return result } catch (error) { this.#database.exec('ROLLBACK'); throw error }
  }

  #read(id: string): GoalRecord | undefined {
    const row = this.#database.prepare('SELECT id, scope_json, original_objective, definition_json, native_json, checkpoint_json, version, created_at, updated_at FROM goal_records WHERE id = ?').get(id) as GoalRow | undefined
    if (!row) return undefined
    const scope = scopeInput(parse(row.scope_json)); const native = nativeInput(parse(row.native_json)); const checkpoint = checkpointInput(parse(row.checkpoint_json)); const definition = definitionInput(parse(row.definition_json))
    if (row.id !== id || !Number.isSafeInteger(row.version) || row.version < 1 || !Number.isSafeInteger(row.created_at) || row.created_at < 0 || !Number.isSafeInteger(row.updated_at) || row.updated_at < row.created_at || row.original_objective.length === 0 || row.original_objective.length > 16_384) fail('schema')
    if (idFor(native) !== id) fail('schema')
    return freeze({ id, scope, originalObjective: row.original_objective, definition, native, checkpoint, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at })
  }

  #history(id: string, kind: 'native' | 'checkpoint', payload: unknown, recordedAt: number): void {
    const sequence = (this.#database.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM goal_history WHERE record_id = ?').get(id) as { sequence: number }).sequence + 1
    this.#database.prepare('INSERT INTO goal_history(record_id, sequence, kind, payload_json, recorded_at) VALUES (?, ?, ?, ?, ?)').run(id, sequence, kind, JSON.stringify(payload), recordedAt)
  }

  #validateDependencies(scope: GoalScope, id: string, checkpoint: GoalCheckpoint): void {
    if (checkpoint.dependencies.includes(id)) fail('invalid-input')
    const records = this.#database.prepare('SELECT id FROM goal_records WHERE scope_json = ?').all(JSON.stringify(scope)) as Array<{ id: string }>
    const byId = new Map(records.map(row => [row.id, this.#read(row.id)!]))
    for (const dependency of checkpoint.dependencies) if (!byId.get(dependency) || !same(byId.get(dependency)?.scope, scope)) fail('not-found')
    const walksTo = (current: string, seen: Set<string>): boolean => {
      if (current === id) return true
      if (seen.has(current)) return false
      seen.add(current)
      return (byId.get(current)?.checkpoint.dependencies ?? []).some(next => walksTo(next, seen))
    }
    if (checkpoint.dependencies.some(dependency => walksTo(dependency, new Set()))) fail('invalid-input')
  }

  observe(scopeValue: GoalScope, nativeValue: NativeGoalState, allowCreate: boolean): GoalRecord | undefined {
    const scope = scopeInput(scopeValue); const native = nativeInput(nativeValue); const id = idFor(native)
    return this.#transaction(() => {
      const existing = this.#read(id)
      if (!existing) {
        if (!allowCreate) return undefined
        const checkpoint = emptyCheckpoint(); const createdAt = native.updatedAt
        const definition = definitionFromHistory([native])
        this.#database.prepare('INSERT INTO goal_records(id, scope_json, original_objective, definition_json, native_json, checkpoint_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, JSON.stringify(scope), native.objective, JSON.stringify(definition), JSON.stringify(native), JSON.stringify(checkpoint), 1, createdAt, createdAt)
        this.#history(id, 'native', native, createdAt); this.#history(id, 'checkpoint', checkpoint, createdAt)
        return this.#read(id)!
      }
      if (!same(existing.scope, scope)) fail('not-found')
      if (native.revision < existing.native.revision || (native.revision === existing.native.revision && native.roundsStarted < existing.native.roundsStarted)) return existing
      if (native.revision === existing.native.revision) {
        const current = existing.native
        if (native.sessionId !== current.sessionId || native.goalId !== current.goalId || native.objective !== current.objective || native.phase !== current.phase || native.maxGoalRounds !== current.maxGoalRounds) fail('conflict')
        if (same(native, current)) return existing
      }
      if (native.roundsStarted < existing.native.roundsStarted) fail('conflict')
      const updatedAt = Math.max(existing.updatedAt, native.updatedAt, Date.now())
      const definition = native.objective === existing.native.objective ? existing.definition
        : freeze({ version: existing.definition.version + 1, objective: native.objective, digest: acceptanceDigest({ objective: native.objective }) })
      const next = freeze({ ...existing, definition, native, version: existing.version + 1, updatedAt })
      this.#database.prepare('UPDATE goal_records SET definition_json = ?, native_json = ?, version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(definition), JSON.stringify(native), next.version, updatedAt, id)
      this.#history(id, 'native', native, updatedAt)
      return next
    })
  }

  get(scopeValue: GoalScope, id: string): GoalRecord | undefined {
    const scope = scopeInput(scopeValue); const record = this.#read(text(id, 512))
    return record && same(record.scope, scope) ? record : undefined
  }

  findNative(scopeValue: GoalScope, sessionIdValue: string, goalIdValue: string): GoalRecord | undefined {
    const scope = scopeInput(scopeValue)
    const sessionId = text(sessionIdValue, 512); const goalId = text(goalIdValue, 512)
    const id = createHash('sha256').update(sessionId).update('\0').update(goalId).digest('hex')
    const record = this.#read(id)
    return record && same(record.scope, scope) ? record : undefined
  }

  setFocus(scopeValue: GoalScope, sessionIdValue: string, recordIdValue: string): void {
    const scope = scopeInput(scopeValue); const sessionId = text(sessionIdValue, 512); const recordId = text(recordIdValue, 512)
    this.#transaction(() => {
      const record = this.get(scope, recordId)
      if (!record) throw new GoalStoreError('not-found')
      this.#database.prepare('INSERT INTO goal_focus(scope_json, session_id, record_id) VALUES (?, ?, ?) ON CONFLICT(scope_json, session_id) DO UPDATE SET record_id = excluded.record_id')
        .run(JSON.stringify(scope), sessionId, record.id)
    })
  }

  focused(scopeValue: GoalScope, sessionIdValue: string): GoalRecord | undefined {
    const scope = scopeInput(scopeValue); const sessionId = text(sessionIdValue, 512)
    const row = this.#database.prepare('SELECT record_id FROM goal_focus WHERE scope_json = ? AND session_id = ?').get(JSON.stringify(scope), sessionId) as { record_id: string } | undefined
    if (!row) return undefined
    return this.get(scope, text(row.record_id, 512))
  }

  list(scopeValue: GoalScope, limit = 50): readonly GoalRecord[] {
    const scope = scopeInput(scopeValue); integer(limit, 1)
    if (limit > 50) fail('invalid-input')
    const rows = this.#database.prepare('SELECT id FROM goal_records WHERE scope_json = ? ORDER BY updated_at DESC, id ASC LIMIT ?').all(JSON.stringify(scope), limit) as Array<{ id: string }>
    return freeze(rows.map(row => this.#read(row.id)!))
  }

  checkpoint(scopeValue: GoalScope, idValue: string, expectedVersion: number, checkpointValue: GoalCheckpoint): GoalRecord {
    const scope = scopeInput(scopeValue); const id = text(idValue, 512); integer(expectedVersion, 1); const checkpoint = checkpointInput(checkpointValue)
    return this.#transaction(() => {
      const found = this.#read(id)
      if (!found) throw new GoalStoreError('not-found')
      if (!same(found.scope, scope)) throw new GoalStoreError('not-found')
      const existing: GoalRecord = found
      if (existing.version !== expectedVersion) fail('conflict')
      this.#validateDependencies(scope, id, checkpoint)
      const updatedAt = Math.max(existing.updatedAt, Date.now())
      const next: GoalRecord = freeze({ ...existing, checkpoint, version: existing.version + 1, updatedAt })
      this.#database.prepare('UPDATE goal_records SET checkpoint_json = ?, version = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(checkpoint), next.version, updatedAt, id)
      this.#history(id, 'checkpoint', checkpoint, updatedAt)
      return next
    })
  }

  health(): { goals: number; awaitingVerification: number } {
    const rows = this.#database.prepare('SELECT id FROM goal_records').all() as Array<{ id: string }>
    const records = rows.map(row => this.#read(row.id)!)
    return freeze({ goals: records.length, awaitingVerification: records.filter(record => record.native.phase === 'complete').length })
  }

  close(): void { this.#database.close() }
}

export { message }
