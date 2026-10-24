import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ConversationRef, ExternalPrincipalKey, ModelRouteRef } from './types.js'

/** This is an operation journal, not another Agent or task scheduler. */
export type RestartStatus = 'requested' | 'checkpoint' | 'ready' | 'restarting' | 'restarted'
  | 'resuming' | 'completed' | 'failed' | 'cancelled'

export interface RestartBindingSnapshot {
  id: string
  version: number
  generation: number
  sessionId: string
  workspace: string
  preset: string
  policyRef: string
  authorityHash: string
  conversation: ConversationRef
  principal: ExternalPrincipalKey
}

export interface RestartTaskInput {
  inboxId: string
  eventId: string
  binding: RestartBindingSnapshot
  owner: { principalRecordId: string; principalVersion: number }
  /** The exact invocation that admitted the original foreground task. */
  sourceInvocationId: string
  maxModelRequests: number
  maxToolCalls: number
  maxOutputTokens: number
  capabilityDigest: string
  deadline: number
}

export interface RestartTask extends RestartTaskInput {
  createdAt: number
  model?: ModelRouteRef
  modelRequests: number
  toolCalls: number
}

export interface RestartCheckpoint {
  sessionEventCount: number
  sessionDigest: string
  continuationMessageId: string
  continuationTextDigest: string
}

export interface RestartRecord {
  id: string
  inboxId: string
  requestKey: string
  reason: string
  status: RestartStatus
  sourceInvocationId: string
  restartInvocationId?: string
  restartHolderId?: string
  continuationHolderId?: string
  checkpoint?: RestartCheckpoint
  failureCode?: string
  createdAt: number
  updatedAt: number
}

export type RestartStoreErrorCode = 'invalid' | 'conflict' | 'not-found' | 'deadline'
  | 'budget' | 'corrupt' | 'closed'

export class RestartStoreError extends Error {
  constructor(readonly code: RestartStoreErrorCode, message: string) {
    super(message)
    this.name = 'RestartStoreError'
  }
}

interface RestartStoreOptions {
  path: string
  now?: () => number
  readOnly?: boolean
}

interface TaskRow {
  inbox_id: string; task_json: string; model_json: string | null
  model_requests: number; tool_calls: number; created_at: number
}

interface IneligibleRow { reason: string; marked_at: number }

interface RequestRow {
  id: string; inbox_id: string; request_key: string; reason: string; status: string
  source_invocation_id: string; restart_invocation_id: string | null
  restart_holder_id: string | null; continuation_holder_id: string | null
  checkpoint_json: string | null; failure_code: string | null
  created_at: number; updated_at: number
}

const statuses = new Set<RestartStatus>([
  'requested', 'checkpoint', 'ready', 'restarting', 'restarted',
  'resuming', 'completed', 'failed', 'cancelled',
])
const activeStatuses = ['requested', 'checkpoint', 'ready', 'restarting', 'restarted', 'resuming'] as const
const digestPattern = /^[a-f0-9]{64}$/u
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u

function invalid(message: string): never { throw new RestartStoreError('invalid', message) }
function conflict(message: string): never { throw new RestartStoreError('conflict', message) }
function corrupt(message: string): never { throw new RestartStoreError('corrupt', message) }

function identifier(value: string, label: string): string {
  if (typeof value !== 'string' || !identifierPattern.test(value)) invalid(`${label} is not a bounded identifier`)
  return value
}

function boundedText(value: string, label: string, maxBytes: number): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0
    || Buffer.byteLength(value, 'utf8') > maxBytes
    || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    invalid(`${label} is invalid`)
  }
  return value
}

function positive(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid(`${label} is invalid`)
  return value
}

function nonnegative(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) invalid(`${label} is invalid`)
  return value
}

function digest(value: string, label: string): string {
  if (typeof value !== 'string' || !digestPattern.test(value)) invalid(`${label} must be SHA-256 hex`)
  return value
}

function normalizePrincipal(value: ExternalPrincipalKey): ExternalPrincipalKey {
  return {
    channel: identifier(value.channel, 'principal channel'),
    account: identifier(value.account, 'principal account'),
    tenant: identifier(value.tenant, 'principal tenant'),
    user: identifier(value.user, 'principal user'),
  }
}

function normalizeConversation(value: ConversationRef): ConversationRef {
  const conversation = {
    channel: identifier(value.channel, 'conversation channel'),
    account: identifier(value.account, 'conversation account'),
    tenant: identifier(value.tenant, 'conversation tenant'),
    kind: value.kind,
    chat: identifier(value.chat, 'conversation chat'),
    ...(value.thread === undefined ? {} : { thread: identifier(value.thread, 'conversation thread') }),
  }
  if (conversation.kind !== 'dm' && conversation.kind !== 'group') invalid('conversation kind is invalid')
  return conversation
}

function normalizeTask(input: RestartTaskInput): RestartTaskInput {
  const binding = input.binding
  const principal = normalizePrincipal(binding.principal)
  const conversation = normalizeConversation(binding.conversation)
  if (conversation.channel !== principal.channel || conversation.account !== principal.account
    || conversation.tenant !== principal.tenant) invalid('binding route does not match principal')
  const task = {
    inboxId: identifier(input.inboxId, 'inbox ID'),
    eventId: identifier(input.eventId, 'provider event ID'),
    binding: {
      id: identifier(binding.id, 'binding ID'),
      version: positive(binding.version, 'binding version'),
      generation: positive(binding.generation, 'binding generation'),
      sessionId: identifier(binding.sessionId, 'session ID'),
      workspace: boundedText(binding.workspace, 'workspace', 2_048),
      preset: identifier(binding.preset, 'agent preset'),
      policyRef: identifier(binding.policyRef, 'binding policy reference'),
      authorityHash: digest(binding.authorityHash, 'owner authority hash'),
      conversation, principal,
    },
    owner: {
      principalRecordId: identifier(input.owner.principalRecordId, 'owner row ID'),
      principalVersion: positive(input.owner.principalVersion, 'owner row version'),
    },
    sourceInvocationId: identifier(input.sourceInvocationId, 'source invocation'),
    maxModelRequests: positive(input.maxModelRequests, 'model request budget', 10_000),
    maxToolCalls: positive(input.maxToolCalls, 'tool call budget', 10_000),
    maxOutputTokens: positive(input.maxOutputTokens, 'output token cap', 1_000_000),
    capabilityDigest: digest(input.capabilityDigest, 'capability digest'),
    deadline: positive(input.deadline, 'absolute deadline'),
  }
  return task
}

function normalizeModel(input: ModelRouteRef): ModelRouteRef {
  return {
    provider: identifier(input.provider, 'model provider'),
    model: identifier(input.model, 'model ID'),
    ...(input.reasoningEffort === undefined ? {}
      : { reasoningEffort: identifier(input.reasoningEffort, 'reasoning effort') }),
  }
}

function normalizeCheckpoint(input: RestartCheckpoint): RestartCheckpoint {
  return {
    sessionEventCount: nonnegative(input.sessionEventCount, 'Session event count'),
    sessionDigest: digest(input.sessionDigest, 'Session digest'),
    continuationMessageId: identifier(input.continuationMessageId, 'continuation message ID'),
    continuationTextDigest: digest(input.continuationTextDigest, 'continuation text digest'),
  }
}

function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
function currentUid(): number {
  const uid = process.getuid?.()
  if (uid === undefined) invalid('restart journal requires a POSIX owner identity')
  return uid
}

/** Refuse symlinks, hardlinks, world-visible state, and state belonging to another UID. */
function assertPrivate(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || stat.uid !== currentUid() || (stat.mode & 0o077) !== 0) {
    throw new RestartStoreError('invalid', `unsafe restart journal: ${path}`)
  }
}

function taskFromRow(row: TaskRow): RestartTask {
  try {
    const parsed: unknown = JSON.parse(row.task_json)
    const normalized = normalizeTask(parsed as RestartTaskInput)
    if (JSON.stringify(normalized) !== row.task_json || normalized.inboxId !== row.inbox_id
      || !Number.isSafeInteger(row.model_requests) || row.model_requests < 0
      || !Number.isSafeInteger(row.tool_calls) || row.tool_calls < 0
      || !Number.isSafeInteger(row.created_at) || row.created_at < 0) corrupt('restart task row changed')
    let model: ModelRouteRef | undefined
    if (row.model_json !== null) {
      model = normalizeModel(JSON.parse(row.model_json) as ModelRouteRef)
      if (JSON.stringify(model) !== row.model_json) corrupt('restart model row changed')
    }
    return { ...normalized, createdAt: row.created_at, ...(model === undefined ? {} : { model }),
      modelRequests: row.model_requests, toolCalls: row.tool_calls }
  } catch (error) {
    if (error instanceof RestartStoreError && error.code === 'corrupt') throw error
    corrupt('restart task row is unreadable')
  }
}

function requestFromRow(row: RequestRow): RestartRecord {
  try {
    const status = row.status as RestartStatus
    if (!statuses.has(status) || !Number.isSafeInteger(row.created_at)
      || !Number.isSafeInteger(row.updated_at) || row.created_at < 0 || row.updated_at < row.created_at) {
      corrupt('restart request row changed')
    }
    const checkpoint = row.checkpoint_json === null ? undefined
      : normalizeCheckpoint(JSON.parse(row.checkpoint_json) as RestartCheckpoint)
    if (checkpoint !== undefined && JSON.stringify(checkpoint) !== row.checkpoint_json) corrupt('restart checkpoint changed')
    if (row.id !== `restart_${hash(`${row.inbox_id}\0${row.request_key}`).slice(0, 32)}`
      || (['checkpoint', 'ready', 'restarting', 'restarted', 'resuming', 'completed'].includes(status)
        && checkpoint === undefined)
      || (status === 'restarting' && row.restart_holder_id === null)
      || (['restarted', 'resuming', 'completed'].includes(status) && row.restart_invocation_id === null)
      || (['resuming', 'completed'].includes(status) && row.continuation_holder_id === null)
      || (status === 'failed' && row.failure_code === null)
      || (status !== 'failed' && row.failure_code !== null)) corrupt('restart request transition proof changed')
    return {
      id: identifier(row.id, 'restart ID'), inboxId: identifier(row.inbox_id, 'inbox ID'),
      requestKey: identifier(row.request_key, 'restart key'), reason: boundedText(row.reason, 'reason', 240),
      status, sourceInvocationId: identifier(row.source_invocation_id, 'source invocation'),
      ...(row.restart_invocation_id === null ? {} : { restartInvocationId: identifier(row.restart_invocation_id, 'restart invocation') }),
      ...(row.restart_holder_id === null ? {} : { restartHolderId: identifier(row.restart_holder_id, 'restart holder') }),
      ...(row.continuation_holder_id === null ? {} : { continuationHolderId: identifier(row.continuation_holder_id, 'continuation holder') }),
      ...(checkpoint === undefined ? {} : { checkpoint }),
      ...(row.failure_code === null ? {} : { failureCode: identifier(row.failure_code, 'failure code') }),
      createdAt: row.created_at, updatedAt: row.updated_at,
    }
  } catch (error) {
    if (error instanceof RestartStoreError && error.code === 'corrupt') throw error
    corrupt('restart request row is unreadable')
  }
}

const taskSelect = `SELECT inbox_id, task_json, model_json, model_requests, tool_calls, created_at
  FROM restart_tasks`
const restartApplicationId = 0x44534852
const requestSelect = `SELECT id, inbox_id, request_key, reason, status, source_invocation_id,
  restart_invocation_id, restart_holder_id, continuation_holder_id, checkpoint_json,
  failure_code, created_at, updated_at FROM restart_requests`

export class RestartStore {
  private readonly database: DatabaseSync
  private readonly now: () => number
  private readonly readOnly: boolean
  private closed = false

  constructor(options: RestartStoreOptions) {
    if (!isAbsolute(options.path)) invalid('restart journal path must be absolute')
    const parent = dirname(options.path)
    if (!options.readOnly) mkdirSync(parent, { recursive: true, mode: 0o700 })
    const directory = lstatSync(parent)
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== currentUid()
      || (directory.mode & 0o077) !== 0) invalid('restart journal parent is not private')
    let existed = true
    try { assertPrivate(options.path) } catch (error) {
      if (options.readOnly || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      existed = false
    }
    this.readOnly = options.readOnly ?? false
    this.now = options.now ?? Date.now
    this.database = new DatabaseSync(options.path, { readOnly: this.readOnly })
    try {
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
      const initialVersion = this.database.prepare('PRAGMA user_version').get() as { user_version: number }
      const initialApplication = this.database.prepare('PRAGMA application_id').get() as { application_id: number }
      if (initialVersion.user_version === 1) {
        if (initialApplication.application_id !== restartApplicationId) corrupt('restart journal identity changed')
      } else if (initialVersion.user_version !== 0 || existed || this.readOnly) {
        corrupt('unsupported restart journal schema')
      }
      if (!this.readOnly) {
        chmodSync(options.path, 0o600)
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
      }
      assertPrivate(options.path)
      for (const extension of ['-wal', '-shm']) {
        try { assertPrivate(`${options.path}${extension}`) } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (initialVersion.user_version === 0) this.database.exec(`
        CREATE TABLE IF NOT EXISTS restart_tasks (
          inbox_id TEXT PRIMARY KEY, task_json TEXT NOT NULL, model_json TEXT,
          model_requests INTEGER NOT NULL DEFAULT 0 CHECK(model_requests >= 0),
          tool_calls INTEGER NOT NULL DEFAULT 0 CHECK(tool_calls >= 0),
          created_at INTEGER NOT NULL CHECK(created_at >= 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS restart_requests (
          id TEXT PRIMARY KEY, inbox_id TEXT NOT NULL UNIQUE REFERENCES restart_tasks(inbox_id),
          request_key TEXT NOT NULL UNIQUE, reason TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('requested','checkpoint','ready','restarting','restarted','resuming','completed','failed','cancelled')),
          source_invocation_id TEXT NOT NULL, restart_invocation_id TEXT,
          restart_holder_id TEXT, continuation_holder_id TEXT, checkpoint_json TEXT,
          failure_code TEXT, created_at INTEGER NOT NULL CHECK(created_at >= 0),
          updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS restart_request_status ON restart_requests(status,created_at,id);
        CREATE TABLE IF NOT EXISTS restart_budget_events (
          inbox_id TEXT NOT NULL REFERENCES restart_tasks(inbox_id), kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
          operation_id TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('observed','reserved')),
          reserved_at INTEGER NOT NULL CHECK(reserved_at >= 0),
          PRIMARY KEY(inbox_id,kind,operation_id)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS restart_ineligible (
          inbox_id TEXT PRIMARY KEY REFERENCES restart_tasks(inbox_id),
          reason TEXT NOT NULL, marked_at INTEGER NOT NULL CHECK(marked_at >= 0)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS restart_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES restart_requests(id),
          event TEXT NOT NULL, at INTEGER NOT NULL CHECK(at >= 0)
        ) STRICT;
        CREATE TRIGGER IF NOT EXISTS restart_events_no_update BEFORE UPDATE ON restart_events BEGIN SELECT RAISE(ABORT,'immutable restart event'); END;
        CREATE TRIGGER IF NOT EXISTS restart_events_no_delete BEFORE DELETE ON restart_events BEGIN SELECT RAISE(ABORT,'immutable restart event'); END;
        CREATE TRIGGER IF NOT EXISTS restart_budget_no_update BEFORE UPDATE ON restart_budget_events BEGIN SELECT RAISE(ABORT,'immutable restart reservation'); END;
        CREATE TRIGGER IF NOT EXISTS restart_budget_no_delete BEFORE DELETE ON restart_budget_events BEGIN SELECT RAISE(ABORT,'immutable restart reservation'); END;
        CREATE TRIGGER IF NOT EXISTS restart_ineligible_no_update BEFORE UPDATE ON restart_ineligible BEGIN SELECT RAISE(ABORT,'immutable restart ineligibility'); END;
        CREATE TRIGGER IF NOT EXISTS restart_ineligible_no_delete BEFORE DELETE ON restart_ineligible BEGIN SELECT RAISE(ABORT,'immutable restart ineligibility'); END;
      `)
      if (initialVersion.user_version === 0) {
        this.database.exec(`PRAGMA application_id = ${restartApplicationId}; PRAGMA user_version = 1;`)
      }
      for (const [name, kind] of [
        ['restart_tasks', 'table'], ['restart_requests', 'table'],
        ['restart_budget_events', 'table'], ['restart_ineligible', 'table'], ['restart_events', 'table'],
        ['restart_events_no_update', 'trigger'], ['restart_events_no_delete', 'trigger'],
        ['restart_budget_no_update', 'trigger'], ['restart_budget_no_delete', 'trigger'],
        ['restart_ineligible_no_update', 'trigger'], ['restart_ineligible_no_delete', 'trigger'],
      ] as const) {
        const object = this.database.prepare(`SELECT type, sql FROM sqlite_master WHERE name = ?`)
          .get(name) as { type: string; sql: string } | undefined
        if (object?.type !== kind || typeof object.sql !== 'string'
          || (kind === 'table' && !object.sql.endsWith('STRICT'))) {
          corrupt(`restart journal ${name} schema is missing`)
        }
      }
      for (const [table, expected] of [
        ['restart_budget_events', ['inbox_id', 'kind', 'operation_id', 'phase', 'reserved_at']],
        ['restart_ineligible', ['inbox_id', 'reason', 'marked_at']],
      ] as const) {
        const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]
        if (JSON.stringify(columns.map(column => column.name)) !== JSON.stringify(expected)) {
          corrupt(`restart journal ${table} columns changed`)
        }
      }
    } catch (error) {
      this.database.close()
      throw error
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new RestartStoreError('closed', 'restart journal is closed')
  }

  private write<T>(fn: () => T): T {
    this.assertOpen()
    if (this.readOnly) invalid('restart journal is read only')
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const value = fn()
      this.database.exec('COMMIT')
      return value
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    }
  }

  private task(inboxId: string): RestartTask | undefined {
    const row = this.database.prepare(`${taskSelect} WHERE inbox_id = ?`).get(inboxId) as TaskRow | undefined
    if (row === undefined) return undefined
    const task = taskFromRow(row)
    const counts = this.database.prepare(`SELECT
      COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END),0) AS model_count,
      COALESCE(SUM(CASE WHEN kind = 'tool' THEN 1 ELSE 0 END),0) AS tool_count
      FROM restart_budget_events WHERE inbox_id = ?`).get(inboxId) as { model_count: number; tool_count: number }
    if (counts.model_count !== task.modelRequests || counts.tool_count !== task.toolCalls) {
      corrupt('restart budget reservations changed')
    }
    return task
  }

  getTask(inboxId: string): RestartTask | undefined {
    this.assertOpen()
    return this.task(identifier(inboxId, 'inbox ID'))
  }

  private ineligibility(inboxId: string): IneligibleRow | undefined {
    const row = this.database.prepare(`SELECT reason,marked_at FROM restart_ineligible WHERE inbox_id = ?`)
      .get(inboxId) as IneligibleRow | undefined
    if (row !== undefined) {
      try {
        boundedText(row.reason, 'ineligibility reason', 120)
        nonnegative(row.marked_at, 'ineligibility time')
      } catch { corrupt('restart ineligibility record changed') }
    }
    return row
  }

  private markIneligibleWithinWrite(inboxId: string, reason: string): void {
    if (this.task(inboxId) === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
    const prior = this.ineligibility(inboxId)
    if (prior !== undefined) return
    if (this.getRequestForTask(inboxId) !== undefined) conflict('restart request already exists')
    this.database.prepare(`INSERT INTO restart_ineligible(inbox_id,reason,marked_at) VALUES(?,?,?)`)
      .run(inboxId, reason, nonnegative(this.now(), 'clock'))
  }

  markIneligible(inboxId: string, reason: string): void {
    identifier(inboxId, 'inbox ID')
    boundedText(reason, 'ineligibility reason', 120)
    this.write(() => this.markIneligibleWithinWrite(inboxId, reason))
  }

  isEligible(inboxId: string): boolean {
    this.assertOpen()
    const task = this.task(identifier(inboxId, 'inbox ID'))
    if (task === undefined || this.ineligibility(inboxId) !== undefined) return false
    if (this.getRequestForTask(inboxId) !== undefined) return false
    return task.model !== undefined && this.now() < task.deadline
      && task.modelRequests < task.maxModelRequests && task.toolCalls <= task.maxToolCalls
  }

  beginTask(input: RestartTaskInput): RestartTask {
    const task = normalizeTask(input)
    return this.write(() => {
      const prior = this.task(task.inboxId)
      if (prior !== undefined) {
        if (JSON.stringify(normalizeTask(prior)) !== JSON.stringify(task)) conflict('restart task identity or budget changed')
        return prior
      }
      const now = nonnegative(this.now(), 'clock')
      this.database.prepare(`INSERT INTO restart_tasks(inbox_id,task_json,created_at) VALUES(?,?,?)`)
        .run(task.inboxId, JSON.stringify(task), now)
      return this.task(task.inboxId)!
    })
  }

  captureModel(inboxId: string, input: ModelRouteRef): RestartTask {
    identifier(inboxId, 'inbox ID')
    const model = normalizeModel(input)
    return this.write(() => {
      const current = this.task(inboxId)
      if (current === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
      if (current.model !== undefined) {
        if (JSON.stringify(current.model) !== JSON.stringify(model)) conflict('frozen model route changed')
        return current
      }
      this.database.prepare(`UPDATE restart_tasks SET model_json = ? WHERE inbox_id = ? AND model_json IS NULL`)
        .run(JSON.stringify(model), inboxId)
      return this.task(inboxId)!
    })
  }

  /** A supplier change ends recovery eligibility without interrupting normal work. */
  observeModel(inboxId: string, input: ModelRouteRef): RestartTask {
    identifier(inboxId, 'inbox ID')
    const model = normalizeModel(input)
    return this.write(() => {
      const current = this.task(inboxId)
      if (current === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
      if (this.getRequestForTask(inboxId) !== undefined) conflict('restart request blocks ordinary model observation')
      if (current.model === undefined) {
        this.database.prepare(`UPDATE restart_tasks SET model_json = ? WHERE inbox_id = ? AND model_json IS NULL`)
          .run(JSON.stringify(model), inboxId)
      } else if (JSON.stringify(current.model) !== JSON.stringify(model)) {
        this.markIneligibleWithinWrite(inboxId, 'model-drift')
      }
      return this.task(inboxId)!
    })
  }

  /** Normal foreground calls are observed durably, even after recovery becomes impossible. */
  observe(inboxId: string, kind: 'model' | 'tool', operationId: string): RestartTask {
    identifier(inboxId, 'inbox ID')
    identifier(operationId, 'operation ID')
    if (kind !== 'model' && kind !== 'tool') invalid('observation kind is invalid')
    return this.write(() => {
      const current = this.task(inboxId)
      if (current === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
      if (this.getRequestForTask(inboxId) !== undefined) conflict('restart request blocks ordinary observations')
      const prior = this.database.prepare(`SELECT phase FROM restart_budget_events
        WHERE inbox_id = ? AND kind = ? AND operation_id = ?`).get(inboxId, kind, operationId) as { phase: string } | undefined
      if (prior !== undefined) {
        if (prior.phase !== 'observed') conflict('operation was reserved for recovery')
        return current
      }
      const column = kind === 'model' ? 'model_requests' : 'tool_calls'
      const count = kind === 'model' ? current.modelRequests : current.toolCalls
      if (count >= Number.MAX_SAFE_INTEGER) corrupt('restart task observation counter overflow')
      this.database.prepare(`UPDATE restart_tasks SET ${column} = ${column} + 1 WHERE inbox_id = ?`).run(inboxId)
      this.database.prepare(`INSERT INTO restart_budget_events(inbox_id,kind,operation_id,phase,reserved_at) VALUES(?,?,?,'observed',?)`)
        .run(inboxId, kind, operationId, nonnegative(this.now(), 'clock'))
      return this.task(inboxId)!
    })
  }

  /** A held request/tool reservation is never refunded after an unknown result. */
  reserve(inboxId: string, kind: 'model' | 'tool', operationId: string): RestartTask {
    identifier(inboxId, 'inbox ID')
    identifier(operationId, 'operation ID')
    if (kind !== 'model' && kind !== 'tool') invalid('reservation kind is invalid')
    return this.write(() => {
      const current = this.task(inboxId)
      if (current === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
      if (current.model === undefined) conflict('model route is not frozen')
      const restart = this.getRequestForTask(inboxId)
      if (restart?.status !== 'resuming') conflict('only an accepted continuation may reserve work')
      const prior = this.database.prepare(`SELECT phase FROM restart_budget_events
        WHERE inbox_id = ? AND kind = ? AND operation_id = ?`).get(inboxId, kind, operationId) as { phase: string } | undefined
      if (prior !== undefined) {
        if (prior.phase !== 'reserved') conflict('operation was observed before recovery')
        return current
      }
      if (this.now() >= current.deadline) throw new RestartStoreError('deadline', 'task deadline has elapsed')
      const count = kind === 'model' ? current.modelRequests : current.toolCalls
      const maximum = kind === 'model' ? current.maxModelRequests : current.maxToolCalls
      if (count >= maximum) throw new RestartStoreError('budget', `${kind} task budget exhausted`)
      const column = kind === 'model' ? 'model_requests' : 'tool_calls'
      this.database.prepare(`UPDATE restart_tasks SET ${column} = ${column} + 1 WHERE inbox_id = ?`).run(inboxId)
      this.database.prepare(`INSERT INTO restart_budget_events(inbox_id,kind,operation_id,phase,reserved_at) VALUES(?,?,?,'reserved',?)`)
        .run(inboxId, kind, operationId, nonnegative(this.now(), 'clock'))
      return this.task(inboxId)!
    })
  }

  private requestById(id: string): RestartRecord | undefined {
    const row = this.database.prepare(`${requestSelect} WHERE id = ?`).get(id) as RequestRow | undefined
    if (row === undefined) return undefined
    const request = requestFromRow(row)
    const task = this.task(request.inboxId)
    if (task === undefined || request.sourceInvocationId !== task.sourceInvocationId) {
      corrupt('restart request task lineage changed')
    }
    if (this.ineligibility(request.inboxId) !== undefined) corrupt('ineligible task has a restart request')
    return request
  }

  getRequest(id: string): RestartRecord | undefined {
    this.assertOpen()
    return this.requestById(identifier(id, 'restart ID'))
  }

  getRequestForTask(inboxId: string): RestartRecord | undefined {
    this.assertOpen()
    const row = this.database.prepare(`${requestSelect} WHERE inbox_id = ?`)
      .get(identifier(inboxId, 'inbox ID')) as RequestRow | undefined
    return row === undefined ? undefined : this.requestById(row.id)
  }

  request(inboxId: string, input: { reason: string; requestKey: string }): RestartRecord {
    identifier(inboxId, 'inbox ID')
    const requestKey = identifier(input.requestKey, 'restart request key')
    const reason = boundedText(input.reason, 'restart reason', 240)
    return this.write(() => {
      const task = this.task(inboxId)
      if (task === undefined) throw new RestartStoreError('not-found', 'restart task is missing')
      const prior = this.getRequestForTask(inboxId)
      if (prior !== undefined) {
        if (prior.requestKey !== requestKey || prior.reason !== reason) conflict('restart request identity changed')
        return prior
      }
      if (task.model === undefined) conflict('restart requires frozen actual model')
      const now = nonnegative(this.now(), 'clock')
      if (now >= task.deadline) throw new RestartStoreError('deadline', 'task deadline has elapsed')
      if (this.ineligibility(inboxId) !== undefined) conflict('task is not eligible for restart')
      if (task.modelRequests >= task.maxModelRequests || task.toolCalls > task.maxToolCalls) {
        throw new RestartStoreError('budget', 'task has no bounded continuation budget')
      }
      const id = `restart_${hash(`${inboxId}\0${requestKey}`).slice(0, 32)}`
      this.database.prepare(`INSERT INTO restart_requests(id,inbox_id,request_key,reason,status,source_invocation_id,created_at,updated_at)
        VALUES(?,?,?,?,'requested',?,?,?)`).run(id, inboxId, requestKey, reason, task.sourceInvocationId, now, now)
      this.event(id, 'requested', now)
      return this.requestById(id)!
    })
  }

  private event(id: string, name: string, now: number): void {
    this.database.prepare(`INSERT INTO restart_events(request_id,event,at) VALUES(?,?,?)`).run(id, name, now)
  }

  private transition(id: string, expected: readonly RestartStatus[], next: RestartStatus,
    fields: Readonly<Record<string, string | number | null>> = {}): RestartRecord {
    return this.write(() => {
      const current = this.requestById(id)
      if (current === undefined) throw new RestartStoreError('not-found', 'restart request is missing')
      if (!expected.includes(current.status)) conflict(`restart transition ${current.status} → ${next} refused`)
      const now = nonnegative(this.now(), 'clock')
      const task = this.task(current.inboxId)
      if (task === undefined) corrupt('restart task is missing')
      if (next !== 'cancelled' && next !== 'failed' && next !== 'completed' && now >= task.deadline) {
        throw new RestartStoreError('deadline', 'task deadline has elapsed')
      }
      const assignments = ['status = ?', 'updated_at = ?', ...Object.keys(fields).map(key => `${key} = ?`)].join(', ')
      const params = [next, now, ...Object.values(fields), id, current.status]
      const result = this.database.prepare(`UPDATE restart_requests SET ${assignments} WHERE id = ? AND status = ?`).run(...params)
      if (result.changes !== 1) conflict('restart transition lost its compare-and-set')
      this.event(id, next, now)
      return this.requestById(id)!
    })
  }

  checkpoint(id: string, input: RestartCheckpoint): RestartRecord {
    identifier(id, 'restart ID')
    const checkpoint = normalizeCheckpoint(input)
    const current = this.getRequest(id)
    if (current?.status === 'checkpoint' && JSON.stringify(current.checkpoint) === JSON.stringify(checkpoint)) return current
    return this.transition(id, ['requested'], 'checkpoint', { checkpoint_json: JSON.stringify(checkpoint) })
  }

  ready(id: string): RestartRecord {
    identifier(id, 'restart ID')
    const current = this.getRequest(id)
    if (current?.status === 'ready') return current
    if (current?.checkpoint === undefined) conflict('restart checkpoint is missing')
    return this.transition(id, ['checkpoint'], 'ready')
  }

  claimRestart(id: string, input: { holderId: string; invocationId: string }): RestartRecord {
    identifier(id, 'restart ID')
    const holder = identifier(input.holderId, 'restart holder')
    const invocation = identifier(input.invocationId, 'current invocation')
    const current = this.getRequest(id)
    if (current?.sourceInvocationId !== invocation) conflict('restart source invocation changed')
    if (current?.status === 'restarting') {
      if (current.restartHolderId !== holder) conflict('restart already claimed by another holder')
      return current
    }
    return this.transition(id, ['ready'], 'restarting', { restart_holder_id: holder })
  }

  /** Observation only: this never grants another restart dispatch. */
  markRestarted(id: string, input: { invocationId: string }): RestartRecord {
    identifier(id, 'restart ID')
    const invocation = identifier(input.invocationId, 'new invocation')
    const current = this.getRequest(id)
    if (current === undefined) throw new RestartStoreError('not-found', 'restart request is missing')
    if (invocation === current.sourceInvocationId) conflict('restart did not produce a new invocation')
    if (current.status === 'restarted' && current.restartInvocationId === invocation) return current
    // A supervisor may die before writing its dispatch receipt after systemd has
    // already restarted the target. A fresh invocation proves the event without
    // giving another supervisor a second command grant.
    return this.transition(id, ['ready', 'restarting'], 'restarted', { restart_invocation_id: invocation })
  }

  claimContinuation(id: string, input: { holderId: string; invocationId: string }): RestartRecord {
    identifier(id, 'restart ID')
    const holder = identifier(input.holderId, 'continuation holder')
    const invocation = identifier(input.invocationId, 'continuation invocation')
    const current = this.getRequest(id)
    if (current?.restartInvocationId !== invocation) conflict('continuation invocation is not the accepted restart')
    if (current?.status === 'resuming') {
      if (current.continuationHolderId !== holder) conflict('continuation already claimed')
      return current
    }
    if (current?.checkpoint === undefined) conflict('continuation checkpoint is missing')
    return this.transition(id, ['restarted'], 'resuming', { continuation_holder_id: holder })
  }

  complete(id: string): RestartRecord {
    identifier(id, 'restart ID')
    const current = this.getRequest(id)
    if (current?.status === 'completed') return current
    return this.transition(id, ['resuming'], 'completed')
  }

  fail(id: string, code: string): RestartRecord {
    identifier(id, 'restart ID')
    const failureCode = identifier(code, 'failure code')
    const current = this.getRequest(id)
    if (current?.status === 'failed' && current.failureCode === failureCode) return current
    return this.transition(id, activeStatuses, 'failed', { failure_code: failureCode })
  }

  cancelForBinding(bindingId: string): RestartRecord[] {
    identifier(bindingId, 'binding ID')
    this.assertOpen()
    const rows = this.database.prepare(`SELECT r.id FROM restart_requests AS r
      JOIN restart_tasks AS t ON t.inbox_id = r.inbox_id
      WHERE json_extract(t.task_json, '$.binding.id') = ?
        AND r.status IN ('requested','checkpoint','ready','restarting','restarted','resuming')
      ORDER BY r.created_at,r.id`).all(bindingId) as unknown as { id: string }[]
    return rows.map(row => {
      const current = this.getRequest(row.id)
      if (current === undefined || this.getTask(current.inboxId)?.binding.id !== bindingId) corrupt('cancel target changed')
      return this.transition(current.id, activeStatuses, 'cancelled')
    })
  }

  listRequests(input: { statuses?: readonly RestartStatus[]; limit?: number; after?: { createdAt: number; id: string } } = {}): RestartRecord[] {
    this.assertOpen()
    const statusesInput = input.statuses ?? activeStatuses
    if (statusesInput.length === 0 || statusesInput.some(status => !statuses.has(status))) invalid('restart statuses are invalid')
    const limit = input.limit ?? 100
    positive(limit, 'restart page size', 1_000)
    const placeholders = statusesInput.map(() => '?').join(',')
    const cursor = input.after
    if (cursor !== undefined) { nonnegative(cursor.createdAt, 'restart cursor time'); identifier(cursor.id, 'restart cursor ID') }
    const rows = this.database.prepare(`${requestSelect} WHERE status IN (${placeholders})
      ${cursor === undefined ? '' : 'AND (created_at > ? OR (created_at = ? AND id > ?))'} ORDER BY created_at,id LIMIT ?`)
      .all(...statusesInput, ...(cursor === undefined ? [] : [cursor.createdAt, cursor.createdAt, cursor.id]), limit) as unknown as RequestRow[]
    return rows.map(row => {
      const request = this.requestById(row.id)
      if (request === undefined) corrupt('restart request vanished during scan')
      return request
    })
  }

  /** Count durable restart dispatch claims for an external global circuit breaker. */
  countDispatchedSince(sinceMs: number): number {
    this.assertOpen()
    nonnegative(sinceMs, 'dispatch window start')
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM restart_events
      WHERE event = 'restarting' AND at >= ?`).get(sinceMs) as { count: number }
    return nonnegative(row.count, 'restart dispatch count')
  }

  hasReservation(inboxId: string, kind: 'model' | 'tool', operationId: string): boolean {
    this.assertOpen()
    identifier(inboxId, 'inbox ID')
    identifier(operationId, 'operation ID')
    if (kind !== 'model' && kind !== 'tool') invalid('reservation kind is invalid')
    return this.database.prepare(`SELECT 1 FROM restart_budget_events
      WHERE inbox_id = ? AND kind = ? AND operation_id = ? AND phase = 'reserved'`)
      .get(inboxId, kind, operationId) !== undefined
  }

  activeRequestForBinding(bindingId: string): RestartRecord | undefined {
    identifier(bindingId, 'binding ID')
    this.assertOpen()
    const row = this.database.prepare(`SELECT r.id FROM restart_requests AS r
      JOIN restart_tasks AS t ON t.inbox_id = r.inbox_id
      WHERE json_extract(t.task_json, '$.binding.id') = ?
        AND r.status IN ('requested','checkpoint','ready','restarting','restarted','resuming')
      ORDER BY r.created_at,r.id LIMIT 1`).get(bindingId) as { id: string } | undefined
    if (row === undefined) return undefined
    const request = this.getRequest(row.id)
    if (request === undefined || this.getTask(request.inboxId)?.binding.id !== bindingId) corrupt('active request changed')
    return request
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.database.close()
  }
}
