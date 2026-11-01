import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type {
  WorkItemClaimRecord,
  WorkItemClaimState,
  WorkItemDeliveryState,
  WorkItemDispatchRecord,
  WorkItemDispatchState,
  WorkItemEventRecord,
  WorkItemOwnerEvidence,
  WorkItemRecord,
  WorkItemReportRecord,
  WorkItemReportStatus,
  WorkItemScope,
  WorkItemState,
} from './types.ts'
import { CLAIMABLE_STATES, OPEN_STATES, WorkItemError } from './types.ts'

const SCHEMA_VERSION = 2
const MEMORY_DATABASE = ':memory:'

type Row = Record<string, unknown>

/** Every durable item column, in insert order. */
const ITEM_COLUMNS = [
  'id', 'dedup_key', 'dedup_bucket', 'source_id', 'kind', 'external_id', 'title', 'brief', 'brief_truncated',
  'origin_binding_id', 'acceptance_ref', 'workspace', 'agent_preset', 'principal_id', 'principal_record_id',
  'principal_version', 'binding_version', 'owner_generation', 'owner_route_id', 'scope_expires_at', 'worker_automation_id',
  'state', 'state_reason', 'attempt', 'max_attempts', 'lease_until', 'lease_run_id', 'occurrence_id', 'work_dir',
  'last_report_status', 'observed', 'created_at', 'updated_at',
] as const

/** Same columns projected with camelCase aliases for row decoding. */
const ITEM_ALIASES = ITEM_COLUMNS.map(column => {
  const name = column.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
  return name === column ? column : `${column} AS ${name}`
}).join(', ')

const INSERT_ITEM = `INSERT INTO work_item(${ITEM_COLUMNS.join(', ')}) VALUES (${ITEM_COLUMNS.map(() => '?').join(', ')})`

const REPORTABLE_STATES: readonly WorkItemState[] = ['claimed', 'working', 'waiting']

function fail(code: ConstructorParameters<typeof WorkItemError>[0], message: string, detail?: string): never {
  throw new WorkItemError(code, message, detail)
}

function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
    fail('storage', 'work-item database file is not private')
  }
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) {
    fail('storage', 'work-item database directory is not private')
  }
}

/** Create a mode-0700 directory and prove it is not a link or group-writable. */
export function preparePrivateDirectory(path: string): void {
  if (!isAbsolute(path)) fail('storage', 'private directory path must be absolute')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  privateDirectory(path)
  chmodSync(path, 0o700)
}

/** Create the SQLite file with mode 0600 before SQLite opens it. */
export function prepareDatabaseFile(path: string): void {
  if (!isAbsolute(path)) fail('storage', 'database path must be absolute')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  privateDirectory(dirname(path))
  let present = false
  try {
    lstatSync(path)
    present = true
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') fail('storage', 'database path is unsafe')
  }
  if (!present) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    closeSync(descriptor)
    chmodSync(path, 0o600)
  }
  privateFile(path)
  for (const suffix of ['-wal', '-shm']) {
    try {
      privateFile(`${path}${suffix}`)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
  }
}

function validateSchema(database: DatabaseSync): void {
  const version = (database.prepare('PRAGMA user_version').get() as Row)['user_version'] as number
  const objects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all() as Row[]
  if (version === 0) {
    if (objects.length !== 0) fail('storage', 'new work-item database is not empty')
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE work_item (
        id TEXT PRIMARY KEY, dedup_key TEXT NOT NULL, dedup_bucket INTEGER NOT NULL,
        source_id TEXT NOT NULL, kind TEXT NOT NULL, external_id TEXT NOT NULL,
        title TEXT NOT NULL, brief TEXT NOT NULL, brief_truncated INTEGER NOT NULL CHECK(brief_truncated IN (0, 1)),
        origin_binding_id TEXT NOT NULL, acceptance_ref TEXT,
        workspace TEXT NOT NULL, agent_preset TEXT NOT NULL,
        principal_id TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL,
        binding_version INTEGER NOT NULL, owner_generation INTEGER NOT NULL, owner_route_id TEXT NOT NULL,
        scope_expires_at INTEGER NOT NULL,
        worker_automation_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('queued', 'claimed', 'working', 'waiting', 'ready', 'blocked', 'failed', 'dropped')),
        state_reason TEXT,
        attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        lease_until INTEGER, lease_run_id TEXT, occurrence_id TEXT,
        work_dir TEXT NOT NULL,
        last_report_status TEXT CHECK(last_report_status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
        observed INTEGER NOT NULL CHECK(observed IN (0, 1)),
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(dedup_key, dedup_bucket)
      ) STRICT;
      CREATE TABLE work_item_event (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        sequence INTEGER NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL,
        detail TEXT, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, sequence)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE work_item_claim (
        claim_id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
      CREATE TABLE work_item_report (
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('progress', 'waiting', 'ready', 'blocked', 'failed')),
        summary TEXT NOT NULL, truncated INTEGER NOT NULL CHECK(truncated IN (0, 1)),
        artifact_paths TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
        delivery_key TEXT NOT NULL UNIQUE,
        delivery_state TEXT CHECK(delivery_state IN ('pending', 'sent', 'failed', 'unknown')),
        delivery_id TEXT, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(item_id, revision)
      ) STRICT;
      CREATE TABLE work_item_dispatch (
        item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE RESTRICT,
        automation_id TEXT NOT NULL, event_id TEXT NOT NULL,
        occurred_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending', 'dispatched', 'failed')),
        occurrence_id TEXT, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE(automation_id, event_id)
      ) STRICT;
      CREATE TABLE work_item_schema_meta (
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      INSERT INTO work_item_schema_meta(key, value) VALUES ('schema_version', '2');
      PRAGMA user_version = 2;
      COMMIT;
    `)
    return
  }
  if (version === 1) {
    // A run may legitimately reclaim an expired lease, which needs a fresh claim
    // row for the same run. Rebuild the claim table without the (item, run) key
    // and add a surrogate `claim_id`; every existing row maps to a new id.
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE work_item_claim RENAME TO work_item_claim_v1;
      CREATE TABLE work_item_claim (
        claim_id INTEGER PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE RESTRICT,
        run_id TEXT NOT NULL, occurrence_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'released', 'expired')),
        leased_until INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
        SELECT item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at FROM work_item_claim_v1;
      DROP TABLE work_item_claim_v1;
      CREATE INDEX work_item_claim_run_idx ON work_item_claim(run_id);
      UPDATE work_item_schema_meta SET value = '2' WHERE key = 'schema_version';
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }
  if (version !== 1 && version !== SCHEMA_VERSION) fail('storage', `unsupported work-item schema version ${String(version)}`)
  const expected = JSON.stringify(['work_item', 'work_item_claim', 'work_item_dispatch', 'work_item_event', 'work_item_report', 'work_item_schema_meta'])
  const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Row[]).map(row => String(row['name']))
  if (JSON.stringify(tables) !== expected) fail('storage', 'work-item database schema is not the expected shape')
}

function optString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value)
}

function optNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value)
}

function itemFromRow(row: Row): WorkItemRecord {
  const scope: WorkItemScope = Object.freeze({
    workspace: String(row['workspace']),
    preset: String(row['agentPreset']),
    principalId: String(row['principalId']),
    ownerRouteId: String(row['ownerRouteId']),
    expiresAt: Number(row['scopeExpiresAt']),
  })
  const owner: WorkItemOwnerEvidence = Object.freeze({
    principalRecordId: String(row['principalRecordId']),
    principalVersion: Number(row['principalVersion']),
    workspace: String(row['workspace']),
    agentPreset: String(row['agentPreset']),
    bindingVersion: Number(row['bindingVersion']),
    generation: Number(row['ownerGeneration']),
  })
  return Object.freeze({
    id: String(row['id']),
    dedupKey: String(row['dedupKey']),
    dedupBucket: Number(row['dedupBucket']),
    sourceId: String(row['sourceId']),
    kind: String(row['kind']),
    externalId: String(row['externalId']),
    title: String(row['title']),
    brief: String(row['brief']),
    briefTruncated: Number(row['briefTruncated']) === 1,
    originBindingId: String(row['originBindingId']),
    acceptanceRef: optString(row['acceptanceRef']),
    scope,
    owner,
    workerAutomationId: String(row['workerAutomationId']),
    state: String(row['state']) as WorkItemState,
    stateReason: optString(row['stateReason']),
    attempt: Number(row['attempt']),
    maxAttempts: Number(row['maxAttempts']),
    leaseUntil: optNumber(row['leaseUntil']),
    leaseRunId: optString(row['leaseRunId']),
    occurrenceId: optString(row['occurrenceId']),
    workDir: String(row['workDir']),
    lastReportStatus: optString(row['lastReportStatus']) as WorkItemReportStatus | null,
    observed: Number(row['observed']) === 1,
    createdAt: Number(row['createdAt']),
    updatedAt: Number(row['updatedAt']),
  })
}

function claimFromRow(row: Row): WorkItemClaimRecord {
  return Object.freeze({
    claimId: Number(row['claim_id']),
    itemId: String(row['item_id']),
    runId: String(row['run_id']),
    occurrenceId: String(row['occurrence_id']),
    state: String(row['state']) as WorkItemClaimState,
    leasedUntil: Number(row['leased_until']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  })
}

function reportFromRow(row: Row): WorkItemReportRecord {
  return Object.freeze({
    itemId: String(row['item_id']),
    revision: Number(row['revision']),
    status: String(row['status']) as WorkItemReportStatus,
    summary: String(row['summary']),
    truncated: Number(row['truncated']) === 1,
    artifactPaths: Object.freeze(JSON.parse(String(row['artifact_paths'])) as string[]),
    idempotencyKey: String(row['idempotency_key']),
    deliveryKey: String(row['delivery_key']),
    deliveryState: optString(row['delivery_state']) as WorkItemDeliveryState | null,
    deliveryId: optString(row['delivery_id']),
    recordedAt: Number(row['recorded_at']),
  })
}

function dispatchFromRow(row: Row): WorkItemDispatchRecord {
  return Object.freeze({
    itemId: String(row['item_id']),
    automationId: String(row['automation_id']),
    eventId: String(row['event_id']),
    occurredAt: Number(row['occurred_at']),
    state: String(row['state']) as WorkItemDispatchState,
    occurrenceId: optString(row['occurrence_id']),
    reason: optString(row['reason']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  })
}

export interface ClaimResult {
  readonly item: WorkItemRecord
  readonly claim: WorkItemClaimRecord
  readonly replayed: boolean
}

export interface ReportResult {
  readonly item: WorkItemRecord
  readonly report: WorkItemReportRecord
  readonly replayed: boolean
}

export interface ReclaimResult {
  readonly requeued: readonly string[]
  readonly blocked: readonly string[]
}

export interface WorkItemStoreStats {
  readonly schemaVersion: number
  readonly items: number
  readonly openItems: number
  readonly reports: number
  readonly dispatches: number
}

/**
 * Single-writer SQLite ledger.
 *
 * Every mutation runs inside `BEGIN IMMEDIATE`; the database file is created
 * 0600 next to a 0700 directory, WAL keeps readers unblocked, and schema
 * upgrades are bounded to the single-writer upgrade boundary at open time.
 */
export class WorkItemStore {
  readonly #database: DatabaseSync
  readonly #statements = new Map<string, ReturnType<DatabaseSync['prepare']>>()
  readonly #now: () => number
  #closed = false

  constructor(path: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? (() => Date.now())
    if (path !== MEMORY_DATABASE) prepareDatabaseFile(path)
    this.#database = new DatabaseSync(path)
    if (path !== MEMORY_DATABASE) {
      this.#database.exec('PRAGMA journal_mode = WAL;')
      this.#database.exec('PRAGMA synchronous = FULL;')
    }
    this.#database.exec('PRAGMA foreign_keys = ON;')
    this.#database.exec('PRAGMA busy_timeout = 5000;')
    try {
      validateSchema(this.#database)
    } catch (error) {
      this.#database.close()
      throw error
    }
  }

  #statement(sql: string): ReturnType<DatabaseSync['prepare']> {
    const cached = this.#statements.get(sql)
    if (cached !== undefined) return cached
    const statement = this.#database.prepare(sql)
    this.#statements.set(sql, statement)
    return statement
  }

  #transaction<T>(work: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = work()
      this.#database.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.#database.exec('ROLLBACK')
      } catch {
        // Keep the original failure; a broken transaction is surfaced via health.
      }
      throw error
    }
  }

  #appendEvent(itemId: string, kind: string, actor: string, detail: unknown, now: number): void {
    const next = this.#statement('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM work_item_event WHERE item_id = ?').get(itemId) as Row
    this.#statement('INSERT INTO work_item_event(item_id, sequence, kind, actor, detail, recorded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(itemId, Number(next['next']), kind, actor, detail === undefined ? null : JSON.stringify(detail), now)
  }

  #requireItem(itemId: string): WorkItemRecord {
    const item = this.findItemById(itemId)
    if (item === undefined) fail('not-found', 'work item does not exist')
    return item
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#statements.clear()
    this.#database.close()
  }

  get closed(): boolean {
    return this.#closed
  }

  stats(): WorkItemStoreStats {
    const count = (sql: string): number => Number((this.#statement(sql).get() as Row)['count'])
    return Object.freeze({
      schemaVersion: Number((this.#database.prepare('PRAGMA user_version').get() as Row)['user_version']),
      items: count('SELECT COUNT(*) AS count FROM work_item'),
      openItems: count(`SELECT COUNT(*) AS count FROM work_item WHERE observed = 0 AND state IN ('queued', 'claimed', 'working', 'waiting')`),
      reports: count('SELECT COUNT(*) AS count FROM work_item_report'),
      dispatches: count('SELECT COUNT(*) AS count FROM work_item_dispatch'),
    })
  }

  findItemById(itemId: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE id = ?`).get(itemId) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  findItemByDedup(dedupKey: string, dedupBucket: number): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE dedup_key = ? AND dedup_bucket = ?`).get(dedupKey, dedupBucket) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  /**
   * Latest item admitted for one canonical dedup key, across all windows.
   *
   * The dedup window forgets history when a bucket rolls over; this lookup is
   * what lets a correction or withdrawal of an already-settled signal stay
   * settled instead of reviving a completed item.
   */
  findLatestItemByDedupKey(dedupKey: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE dedup_key = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(dedupKey) as Row | undefined
    return row === undefined ? undefined : itemFromRow(row)
  }

  /** Read one durable key/value row from the schema-meta table. */
  meta(key: string): string | null {
    const row = this.#statement('SELECT value FROM work_item_schema_meta WHERE key = ?').get(key) as Row | undefined
    return row === undefined ? null : String(row['value'])
  }

  /** Persist one durable key/value row; no schema change is required for it. */
  setMeta(key: string, value: string): void {
    this.#statement(
      'INSERT INTO work_item_schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  findItemByOccurrence(occurrenceId: string): WorkItemRecord | undefined {
    const row = this.#statement(`SELECT ${ITEM_ALIASES} FROM work_item WHERE occurrence_id = ?`).get(occurrenceId) as Row | undefined
    if (row !== undefined) return itemFromRow(row)
    const dispatch = this.#statement('SELECT item_id FROM work_item_dispatch WHERE occurrence_id = ?').get(occurrenceId) as Row | undefined
    return dispatch === undefined ? undefined : this.findItemById(String(dispatch['item_id']))
  }

  listItems(options: { states?: readonly WorkItemState[]; includeObserved?: boolean; limit?: number } = {}): readonly WorkItemRecord[] {
    const limit = options.limit ?? 50
    const states = options.states
    const includeObserved = options.includeObserved ?? false
    let sql = `SELECT ${ITEM_ALIASES} FROM work_item`
    const conditions: string[] = []
    const parameters: Array<string | number> = []
    if (states !== undefined && states.length > 0) {
      conditions.push(`state IN (${states.map(() => '?').join(', ')})`)
      parameters.push(...states)
    }
    if (!includeObserved) conditions.push('observed = 0')
    if (conditions.length > 0) sql += ` WHERE ${conditions.join(' AND ')}`
    sql += ' ORDER BY created_at DESC, id DESC LIMIT ?'
    parameters.push(limit)
    return Object.freeze((this.#statement(sql).all(...parameters) as Row[]).map(itemFromRow))
  }

  lastAdmitAt(kind?: string): number | null {
    const row = kind === undefined
      ? this.#statement('SELECT MAX(created_at) AS latest FROM work_item').get() as Row
      : this.#statement('SELECT MAX(created_at) AS latest FROM work_item WHERE kind = ?').get(kind) as Row
    return optNumber(row['latest'])
  }

  /** Latest successful dispatch timestamp, for bounded health reporting. */
  lastDispatchedAt(): number | null {
    const row = this.#statement(
      "SELECT MAX(updated_at) AS latest FROM work_item_dispatch WHERE state = 'dispatched'",
    ).get() as Row
    return optNumber(row['latest'])
  }

  countItemsSince(createdAt: number): number {
    const row = this.#statement('SELECT COUNT(*) AS count FROM work_item WHERE created_at >= ? AND observed = 0').get(createdAt) as Row
    return Number(row['count'])
  }

  countOpenItems(): number {
    const row = this.#statement(`SELECT COUNT(*) AS count FROM work_item WHERE observed = 0 AND state IN ('queued', 'claimed', 'working', 'waiting')`).get() as Row
    return Number(row['count'])
  }

  countDispatchUnknown(): number {
    const row = this.#statement("SELECT COUNT(*) AS count FROM work_item_dispatch WHERE state = 'failed' AND reason = 'unknown_after_send'").get() as Row
    return Number(row['count'])
  }

  /**
   * Insert one admitted item, its lifecycle event and its single dispatch row
   * in one transaction. A crash between these writes is impossible.
   */
  admitItem(record: WorkItemRecord, event: { kind: string; actor: string; detail?: unknown }, dispatch: WorkItemDispatchRecord): void {
    this.#transaction(() => {
      this.#statement(INSERT_ITEM).run(
        record.id, record.dedupKey, record.dedupBucket, record.sourceId, record.kind, record.externalId,
        record.title, record.brief, record.briefTruncated ? 1 : 0, record.originBindingId, record.acceptanceRef,
        record.scope.workspace, record.scope.preset, record.scope.principalId,
        record.owner.principalRecordId, record.owner.principalVersion, record.owner.bindingVersion, record.owner.generation,
        record.scope.ownerRouteId, record.scope.expiresAt, record.workerAutomationId, record.state, record.stateReason,
        record.attempt, record.maxAttempts, record.leaseUntil, record.leaseRunId, record.occurrenceId,
        record.workDir, record.lastReportStatus, record.observed ? 1 : 0, record.createdAt, record.updatedAt,
      )
      this.#appendEvent(record.id, event.kind, event.actor, event.detail, record.createdAt)
      this.#statement(`
        INSERT INTO work_item_dispatch(item_id, automation_id, event_id, occurred_at, state, occurrence_id, reason, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(dispatch.itemId, dispatch.automationId, dispatch.eventId, dispatch.occurredAt, dispatch.state, dispatch.occurrenceId, dispatch.reason, dispatch.createdAt, dispatch.updatedAt)
    })
  }

  appendEvent(itemId: string, kind: string, actor: string, detail?: unknown): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      this.#appendEvent(itemId, kind, actor, detail, now)
    })
  }

  events(itemId: string): readonly WorkItemEventRecord[] {
    return Object.freeze((this.#statement('SELECT item_id, sequence, kind, actor, detail, recorded_at FROM work_item_event WHERE item_id = ? ORDER BY sequence').all(itemId) as Row[]).map(row => Object.freeze({
      itemId: String(row['item_id']),
      sequence: Number(row['sequence']),
      kind: String(row['kind']),
      actor: String(row['actor']),
      detail: optString(row['detail']),
      recordedAt: Number(row['recorded_at']),
    })))
  }

  getDispatch(itemId: string): WorkItemDispatchRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_dispatch WHERE item_id = ?').get(itemId) as Row | undefined
    return row === undefined ? undefined : dispatchFromRow(row)
  }

  listOpenDispatches(limit: number): readonly WorkItemDispatchRecord[] {
    return Object.freeze((this.#statement(`
      SELECT * FROM work_item_dispatch
      WHERE state = 'pending'
      ORDER BY created_at ASC LIMIT ?
    `).all(limit) as Row[]).map(dispatchFromRow))
  }

  markDispatchDispatched(itemId: string, occurrenceId: string): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      this.#statement("UPDATE work_item_dispatch SET state = 'dispatched', occurrence_id = ?, reason = NULL, updated_at = ? WHERE item_id = ?")
        .run(occurrenceId, now, itemId)
      this.#statement('UPDATE work_item SET occurrence_id = ?, updated_at = ? WHERE id = ?').run(occurrenceId, now, itemId)
      this.#appendEvent(itemId, 'dispatched', 'admission', { occurrenceId }, now)
    })
  }

  markDispatchFailed(itemId: string, reason: string): void {
    const now = this.#now()
    this.#transaction(() => {
      this.#requireItem(itemId)
      this.#statement("UPDATE work_item_dispatch SET state = 'failed', reason = ?, updated_at = ? WHERE item_id = ?").run(reason, now, itemId)
      this.#appendEvent(itemId, 'dispatch-failed', 'admission', { reason }, now)
    })
  }

  /**
   * Reclaim every claim whose lease elapsed. Lazy by design: no timer owns
   * recovery, so a host that was down simply reclaims on the next touch.
   *
   * The expired claim is retired explicitly, the item returns to `queued` and
   * its dispatch row is re-armed so the normal wake path can hand the item to a
   * fresh occurrence. A re-queued item that nobody wakes would otherwise stay
   * queued forever, counted against `maxOpenItems`.
   */
  reclaimExpired(): ReclaimResult {
    const now = this.#now()
    const rows = this.#statement(`
      SELECT ${ITEM_ALIASES} FROM work_item
      WHERE state IN ('claimed', 'working') AND lease_until IS NOT NULL AND lease_until <= ?
      ORDER BY lease_until ASC
    `).all(now) as Row[]
    const requeued: string[] = []
    const blocked: string[] = []
    for (const row of rows) {
      const item = itemFromRow(row)
      const tryReclaim = (): 'requeued' | 'blocked' | 'skipped' => this.#transaction(() => {
        const current = this.#requireItem(item.id)
        if (current.leaseUntil === null || current.leaseUntil > now) return 'skipped'
        if (current.state !== 'claimed' && current.state !== 'working') return 'skipped'
        const exhausted = current.attempt >= current.maxAttempts
        const expiredRunIds = (this.#statement("SELECT run_id FROM work_item_claim WHERE item_id = ? AND state = 'active'").all(current.id) as Row[])
          .map(claim => String(claim['run_id']))
        this.#statement("UPDATE work_item_claim SET state = 'expired', updated_at = ? WHERE item_id = ? AND state = 'active'").run(now, current.id)
        this.#appendEvent(current.id, 'claim-expired', 'recovery', { reason: 'lease-expired', runIds: expiredRunIds, attempt: current.attempt }, now)
        if (exhausted) {
          this.#statement("UPDATE work_item SET state = 'blocked', state_reason = 'retry-exhausted', lease_until = NULL, lease_run_id = NULL, updated_at = ? WHERE id = ?")
            .run(now, current.id)
          this.#appendEvent(current.id, 'blocked', 'recovery', { reason: 'retry-exhausted', attempt: current.attempt }, now)
          return 'blocked'
        }
        this.#statement("UPDATE work_item SET state = 'queued', state_reason = 'lease-expired', lease_until = NULL, lease_run_id = NULL, updated_at = ? WHERE id = ?")
          .run(now, current.id)
        // Put the dispatch row back in the only state `wakePending()` scans, so
        // recovery is driven by the ordinary wake path rather than a side door.
        this.#statement("UPDATE work_item_dispatch SET state = 'pending', occurrence_id = NULL, reason = 'lease-expired', updated_at = ? WHERE item_id = ?")
          .run(now, current.id)
        this.#appendEvent(current.id, 'reclaimed', 'recovery', { reason: 'lease-expired', attempt: current.attempt }, now)
        return 'requeued'
      })
      const outcome = tryReclaim()
      if (outcome === 'requeued') requeued.push(item.id)
      else if (outcome === 'blocked') blocked.push(item.id)
    }
    return Object.freeze({ requeued: Object.freeze(requeued), blocked: Object.freeze(blocked) })
  }

  /** Latest claim for one run; a re-claim after expiry appends a newer row. */
  findClaimByRun(runId: string): WorkItemClaimRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_claim WHERE run_id = ? ORDER BY claim_id DESC LIMIT 1').get(runId) as Row | undefined
    return row === undefined ? undefined : claimFromRow(row)
  }

  activeClaim(itemId: string): WorkItemClaimRecord | undefined {
    const row = this.#statement("SELECT * FROM work_item_claim WHERE item_id = ? AND state = 'active'").get(itemId) as Row | undefined
    return row === undefined ? undefined : claimFromRow(row)
  }

  /**
   * Compare-and-swap claim.
   *
   * A repeated claim from the same run replays the existing claim only while
   * that claim is still active, so a tool retry after transport loss is safe.
   * Once the lease elapsed the claim is retired and the same run obtains a new
   * claim row (and a new attempt), instead of replaying a dead lease forever.
   * A competing run loses with `claim-conflict`.
   */
  claim(input: { itemId: string; runId: string; occurrenceId: string; leaseMs: number }): ClaimResult {
    this.reclaimExpired()
    const outcome = this.#transaction(() => {
      const item = this.#requireItem(input.itemId)
      if (item.observed) fail('invalid-state', 'observed items cannot be claimed')
      const now = this.#now()
      const existing = this.findClaimByRun(input.runId)
      if (existing !== undefined && existing.itemId !== item.id) fail('claim-conflict', 'run already claimed another item')
      if (existing !== undefined && existing.state === 'active' && existing.leasedUntil > now) {
        return { exhausted: false as const, result: Object.freeze({ item, claim: existing, replayed: true }) }
      }
      if (existing !== undefined && existing.state === 'active') {
        // Retire the dead lease before a new row is appended, so the item never
        // carries two active claims.
        this.#statement("UPDATE work_item_claim SET state = 'expired', updated_at = ? WHERE claim_id = ?").run(now, existing.claimId)
        this.#appendEvent(item.id, 'claim-expired', 'worker', { reason: 'lease-expired', runId: input.runId, claimId: existing.claimId }, now)
      }
      if (!CLAIMABLE_STATES.includes(item.state)) fail('claim-conflict', `item is ${item.state}, not claimable`)
      if (item.attempt >= item.maxAttempts) {
        this.#statement("UPDATE work_item SET state = 'blocked', state_reason = 'retry-exhausted', updated_at = ? WHERE id = ?").run(now, item.id)
        this.#appendEvent(item.id, 'blocked', 'claim', { reason: 'retry-exhausted' }, now)
        // Commit the terminal transition, then fail: throwing inside the
        // transaction would roll the durable blocked state back.
        return { exhausted: true as const }
      }
      const attempt = item.attempt + 1
      const leasedUntil = now + input.leaseMs
      this.#statement(`
        UPDATE work_item SET state = 'claimed', state_reason = NULL, attempt = ?, lease_until = ?, lease_run_id = ?, updated_at = ?
        WHERE id = ?
      `).run(attempt, leasedUntil, input.runId, now, item.id)
      this.#statement(`
        INSERT INTO work_item_claim(item_id, run_id, occurrence_id, state, leased_until, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?)
      `).run(item.id, input.runId, input.occurrenceId, leasedUntil, now, now)
      this.#appendEvent(item.id, 'claimed', 'worker', { runId: input.runId, occurrenceId: input.occurrenceId, attempt }, now)
      const claim = this.findClaimByRun(input.runId)
      if (claim === undefined) fail('storage', 'claim row disappeared after insert')
      return { exhausted: false as const, result: Object.freeze({ item: this.#requireItem(item.id), claim, replayed: false }) }
    })
    if (outcome.exhausted) fail('retry-exhausted', 'work item exhausted its attempt budget')
    return outcome.result
  }

  reportCount(itemId: string): number {
    const row = this.#statement('SELECT COUNT(*) AS count FROM work_item_report WHERE item_id = ?').get(itemId) as Row
    return Number(row['count'])
  }

  lastReport(itemId: string): WorkItemReportRecord | undefined {
    const row = this.#statement('SELECT * FROM work_item_report WHERE item_id = ? ORDER BY revision DESC LIMIT 1').get(itemId) as Row | undefined
    return row === undefined ? undefined : reportFromRow(row)
  }

  reports(itemId: string): readonly WorkItemReportRecord[] {
    return Object.freeze((this.#statement('SELECT * FROM work_item_report WHERE item_id = ? ORDER BY revision ASC').all(itemId) as Row[]).map(reportFromRow))
  }

  /**
   * Append one report revision under the active claim, then apply the state
   * transition for that status.
   *
   * The caller's idempotency key is scoped to the claim row, so identical text
   * reported by different claims (or different items) is not mistaken for a
   * replay, while a retried call on the same claim returns the stored revision.
   */
  report(input: {
    itemId: string
    runId: string
    status: WorkItemReportStatus
    summary: string
    truncated: boolean
    artifactPaths: readonly string[]
    idempotencyKey: string
    maxReports: number
    leaseMs: number
  }): ReportResult {
    return this.#transaction(() => {
      const item = this.#requireItem(input.itemId)
      const claim = this.findClaimByRun(input.runId)
      if (claim === undefined || claim.itemId !== item.id) {
        fail('claim-conflict', 'report requires a claim for this item')
      }
      const idempotencyKey = `${input.idempotencyKey}\0${item.id}\0${String(claim.claimId)}`
      const duplicate = this.#statement('SELECT * FROM work_item_report WHERE idempotency_key = ?').get(idempotencyKey) as Row | undefined
      if (duplicate !== undefined) {
        const report = reportFromRow(duplicate)
        if (report.itemId !== item.id) fail('claim-conflict', 'idempotency key already belongs to another item')
        return Object.freeze({ item, report, replayed: true })
      }
      const now = this.#now()
      if (claim.state === 'expired') fail('claim-expired', 'claim lease elapsed; reclaim the item before reporting')
      if (claim.state !== 'active') fail('claim-conflict', 'report requires the active claim for this item')
      if (item.leaseRunId !== input.runId || item.leaseUntil === null || item.leaseUntil <= now) {
        fail('claim-expired', 'claim lease elapsed; reclaim the item before reporting')
      }
      if (!REPORTABLE_STATES.includes(item.state)) fail('invalid-state', `item is ${item.state}, not reportable`)
      if (this.reportCount(item.id) >= input.maxReports) fail('report-limit', 'work item reached maxReportsPerItem')
      const next = this.#statement('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM work_item_report WHERE item_id = ?').get(item.id) as Row
      const revision = Number(next['next'])
      const deliveryKey = `work-item-report:${item.id}:${String(revision)}`
      this.#statement(`
        INSERT INTO work_item_report(item_id, revision, status, summary, truncated, artifact_paths, idempotency_key, delivery_key, delivery_state, delivery_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      `).run(item.id, revision, input.status, input.summary, input.truncated ? 1 : 0, JSON.stringify(input.artifactPaths), idempotencyKey, deliveryKey, now)

      let nextState: WorkItemState
      let reason: string | null = null
      switch (input.status) {
        case 'progress':
          nextState = 'working'
          break
        case 'waiting':
          nextState = 'waiting'
          break
        case 'ready':
          nextState = 'ready'
          break
        case 'blocked':
          nextState = 'blocked'
          reason = 'reported-blocked'
          break
        case 'failed':
          nextState = 'failed'
          reason = 'reported-failed'
          break
      }
      if (nextState === 'working') {
        const lease = now + input.leaseMs
        this.#statement('UPDATE work_item SET state = ?, state_reason = NULL, lease_until = ?, last_report_status = ?, updated_at = ? WHERE id = ?')
          .run(nextState, lease, input.status, now, item.id)
        this.#statement('UPDATE work_item_claim SET leased_until = ?, updated_at = ? WHERE claim_id = ?')
          .run(lease, now, claim.claimId)
      } else {
        this.#statement('UPDATE work_item SET state = ?, state_reason = ?, lease_until = NULL, last_report_status = ?, updated_at = ? WHERE id = ?')
          .run(nextState, reason, input.status, now, item.id)
        this.#statement('UPDATE work_item_claim SET state = ?, updated_at = ? WHERE claim_id = ?')
          .run(input.status === 'waiting' ? 'released' : 'completed', now, claim.claimId)
      }
      this.#appendEvent(item.id, 'reported', 'worker', { revision, status: input.status }, now)
      const stored = this.#statement('SELECT * FROM work_item_report WHERE item_id = ? AND revision = ?').get(item.id, revision) as Row
      return Object.freeze({ item: this.#requireItem(item.id), report: reportFromRow(stored), replayed: false })
    })
  }

  setReportDelivery(itemId: string, revision: number, state: WorkItemDeliveryState, deliveryId: string | null): void {
    this.#transaction(() => {
      this.#statement('UPDATE work_item_report SET delivery_state = ?, delivery_id = ? WHERE item_id = ? AND revision = ?')
        .run(state, deliveryId, itemId, revision)
    })
  }

  /** Terminal item states map to terminal claim states. */
  static claimStateFor(report: WorkItemReportStatus): WorkItemClaimState {
    return report === 'waiting' ? 'released' : report === 'progress' ? 'active' : 'completed'
  }

  /** Open states are exposed for admission accounting and tests. */
  static openStates(): readonly WorkItemState[] {
    return OPEN_STATES
  }
}
