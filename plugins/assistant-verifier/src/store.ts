import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  acceptanceCanonicalJson, validateTaskAcceptanceContract, validateTaskVerificationReceipt,
} from '@dsh-enhanced/task-acceptance-contract'
import type { TaskAcceptanceContract, TaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'

export class AcceptanceStoreError extends Error {
  constructor(readonly code: 'invalid-input' | 'conflict' | 'corrupt', message: string) { super(message); this.name = 'AcceptanceStoreError' }
}

export type ExecutionStatus = 'succeeded' | 'failed' | 'timed-out' | 'cancelled' | 'unknown'
export interface Execution {
  readonly status: ExecutionStatus; readonly quiescent: boolean; readonly completedAt: number; readonly executionRef: string
}
export interface AcceptanceState {
  readonly state: 'awaiting-execution' | 'pending' | 'verifying' | 'done' | 'needs-attention'
  readonly attempts: number; readonly reason: string | null; readonly receipt: TaskVerificationReceipt | null; readonly execution: Execution | null
}
export interface AttentionState extends AcceptanceState { readonly contract: TaskAcceptanceContract }
export interface ClaimedVerification {
  readonly contract: TaskAcceptanceContract
  readonly job: Readonly<{ contractId: string; attempt: number; fencingToken: number; workerId: string; leaseUntil: number }>
  readonly execution: Execution
}

interface ContractRow { id: string; payload: string }
interface JobRow { contract_id: string; state: AcceptanceState['state']; attempts: number; fencing_token: number; worker_id: string | null; lease_until: number | null; execution: string | null; receipt: string | null; reason: string | null; retry_at: number | null }
interface OutboxRow { contract: string; receipt: string }

const MAX_ATTEMPTS = 3
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u
function fail(code: AcceptanceStoreError['code'], message: string): never { throw new AcceptanceStoreError(code, message) }
function safeTime(value: number, label: string): void { if (!Number.isSafeInteger(value) || value < 0) fail('invalid-input', `${label} is invalid`) }
function safeId(value: string, label: string): void { if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('invalid-input', `${label} is invalid`) }
function reason(value: string): void { if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value !== value.normalize('NFC').trim() || [...value].some(character => character.codePointAt(0)! < 32 || character.codePointAt(0) === 127)) fail('invalid-input', 'reason is invalid') }
function execution(value: Execution): Execution {
  if (value === null || typeof value !== 'object' || !['succeeded', 'failed', 'timed-out', 'cancelled', 'unknown'].includes(value.status) || typeof value.quiescent !== 'boolean') fail('invalid-input', 'execution is invalid')
  safeTime(value.completedAt, 'execution completedAt'); safeId(value.executionRef, 'executionRef')
  return Object.freeze({ status: value.status, quiescent: value.quiescent, completedAt: value.completedAt, executionRef: value.executionRef })
}
function parseJson(value: string, label: string): unknown { try { return JSON.parse(value) } catch { return fail('corrupt', `${label} is invalid JSON`) } }
function parseContract(value: string): TaskAcceptanceContract { try { return validateTaskAcceptanceContract(parseJson(value, 'contract')) } catch { return fail('corrupt', 'stored contract is invalid') } }
function parseReceipt(contract: TaskAcceptanceContract, value: string): TaskVerificationReceipt { try { return validateTaskVerificationReceipt(contract, parseJson(value, 'receipt')) } catch { return fail('corrupt', 'stored receipt is invalid') } }
function parseExecution(value: string): Execution { return execution(parseJson(value, 'execution') as Execution) }
function checkedJob(row: JobRow): JobRow {
  if (typeof row.contract_id !== 'string' || !IDENTIFIER.test(row.contract_id) || !['awaiting-execution', 'pending', 'verifying', 'done', 'needs-attention'].includes(row.state) || !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.attempts > MAX_ATTEMPTS || !Number.isSafeInteger(row.fencing_token) || row.fencing_token < 0 || row.fencing_token !== row.attempts || (row.worker_id !== null && (typeof row.worker_id !== 'string' || !IDENTIFIER.test(row.worker_id))) || (row.lease_until !== null && (!Number.isSafeInteger(row.lease_until) || row.lease_until < 0)) || (row.retry_at !== null && (!Number.isSafeInteger(row.retry_at) || row.retry_at < 0)) || (row.execution !== null && typeof row.execution !== 'string') || (row.receipt !== null && typeof row.receipt !== 'string') || (row.reason !== null && typeof row.reason !== 'string')) fail('corrupt', 'stored job metadata is invalid')
  if ((row.state === 'verifying') !== (row.worker_id !== null && row.lease_until !== null)) fail('corrupt', 'stored job lease/state is invalid')
  return row
}
function validatedJob(contract: TaskAcceptanceContract, row: JobRow): { row: JobRow; execution: Execution | null; receipt: TaskVerificationReceipt | null } {
  checkedJob(row)
  if (row.contract_id !== contract.id) fail('corrupt', 'stored job does not bind its contract')
  const actual = row.execution === null ? null : parseExecution(row.execution)
  const proof = row.receipt === null ? null : parseReceipt(contract, row.receipt)
  if (actual !== null && actual.completedAt < contract.issuedAt) fail('corrupt', 'stored execution predates contract')
  if (proof !== null && (actual === null || proof.startedAt < actual.completedAt)) fail('corrupt', 'stored receipt predates execution')
  if (row.reason !== null) { try { reason(row.reason) } catch { fail('corrupt', 'stored job reason is invalid') } }
  if (row.state === 'awaiting-execution') {
    if (row.attempts !== 0 || actual !== null || proof !== null || row.reason !== null || row.retry_at !== null) fail('corrupt', 'awaiting job has terminal metadata')
  } else if (row.state === 'pending') {
    if (actual === null || row.retry_at === null || row.retry_at >= contract.expiresAt || (proof !== null && proof.objectiveStatus !== 'unknown')) fail('corrupt', 'pending job metadata is invalid')
  } else if (row.state === 'verifying') {
    if (actual === null || row.attempts < 1 || (proof !== null && proof.objectiveStatus !== 'unknown')) fail('corrupt', 'verifying job metadata is invalid')
  } else if (row.state === 'done') {
    if (actual === null || proof === null || proof.objectiveStatus === 'unknown' || row.reason === null || row.retry_at !== null) fail('corrupt', 'done job lacks a known receipt')
  } else if (actual === null) {
    if (row.attempts !== 0 || proof !== null || row.reason !== 'execution-unconfirmed' || row.retry_at !== null) fail('corrupt', 'unconfirmed attention job is invalid')
  } else if (row.reason === null || row.retry_at !== null || (proof !== null && proof.objectiveStatus !== 'unknown')) fail('corrupt', 'attention job metadata is invalid')
  return { row, execution: actual, receipt: proof }
}
function privateDatabase(path: string, existing: boolean): void {
  const stat = lstatSync(path)
  const uid = process.getuid?.()
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (uid !== undefined && stat.uid !== uid)) fail('corrupt', 'database path is not a private regular file')
  if (existing && (stat.mode & 0o077) !== 0) fail('corrupt', 'database permissions are not private')
  if (!existing) chmodSync(path, 0o600)
}
function identifier(value: string): string { return `"${value.replaceAll('"', '""')}"` }
function schemaColumns(database: DatabaseSync, table: string): readonly string[] {
  return (database.prepare(`PRAGMA table_info(${identifier(table)})`).all() as unknown as Array<{ name: string }>).map(row => row.name)
}
function indexedColumns(database: DatabaseSync, table: string): readonly (readonly string[])[] {
  const indexes = database.prepare(`PRAGMA index_list(${identifier(table)})`).all() as unknown as Array<{ name: string; unique: number }>
  return indexes.filter(index => index.unique === 1).map(index => (database.prepare(`PRAGMA index_info(${identifier(index.name)})`).all() as unknown as Array<{ name: string }>).map(row => row.name))
}
function sameColumns(actual: readonly string[], expected: readonly string[]): boolean { return actual.length === expected.length && actual.every((value, index) => value === expected[index]) }
function hasForeignKey(database: DatabaseSync, table: string, from: string, target: string): boolean {
  return (database.prepare(`PRAGMA foreign_key_list(${identifier(table)})`).all() as unknown as Array<{ table: string; from: string; to: string }>).some(row => row.table === target && row.from === from && row.to === 'id')
}
function verifySchema(database: DatabaseSync): void {
  const definitions: Readonly<Record<string, readonly string[]>> = {
    acceptance_contracts: ['id', 'scope', 'owner', 'task_kind', 'task_ref', 'payload'],
    acceptance_jobs: ['contract_id', 'state', 'attempts', 'fencing_token', 'worker_id', 'lease_until', 'execution', 'receipt', 'reason', 'retry_at'],
    acceptance_receipts: ['id', 'contract_id', 'payload', 'digest'],
    acceptance_outbox: ['receipt_id', 'digest', 'contract_id', 'acknowledged'],
  }
  for (const [table, columns] of Object.entries(definitions)) if (!sameColumns(schemaColumns(database, table), columns)) fail('corrupt', `database schema is missing or changes ${table}`)
  const contractsIndexes = indexedColumns(database, 'acceptance_contracts')
  const jobIndexes = indexedColumns(database, 'acceptance_jobs')
  const receiptIndexes = indexedColumns(database, 'acceptance_receipts')
  const outboxIndexes = indexedColumns(database, 'acceptance_outbox')
  if (!contractsIndexes.some(columns => sameColumns(columns, ['id'])) || !contractsIndexes.some(columns => sameColumns(columns, ['scope', 'owner', 'task_kind', 'task_ref'])) || !jobIndexes.some(columns => sameColumns(columns, ['contract_id'])) || !receiptIndexes.some(columns => sameColumns(columns, ['id'])) || !receiptIndexes.some(columns => sameColumns(columns, ['contract_id', 'digest'])) || !outboxIndexes.some(columns => sameColumns(columns, ['receipt_id'])) || !hasForeignKey(database, 'acceptance_jobs', 'contract_id', 'acceptance_contracts') || !hasForeignKey(database, 'acceptance_receipts', 'contract_id', 'acceptance_contracts') || !hasForeignKey(database, 'acceptance_outbox', 'receipt_id', 'acceptance_receipts') || !hasForeignKey(database, 'acceptance_outbox', 'contract_id', 'acceptance_contracts')) fail('corrupt', 'database schema lacks required index or foreign key')
}

export class AcceptanceStore {
  readonly #database: DatabaseSync
  #closed = false

  constructor(path: string) {
    if (path !== ':memory:' && !isAbsolute(path)) fail('invalid-input', 'database path must be absolute')
    const existing = path !== ':memory:' && existsSync(path)
    if (path !== ':memory:') { if (existing) privateDatabase(path, true); else mkdirSync(dirname(path), { recursive: true, mode: 0o700 }) }
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
      if (path !== ':memory:') { privateDatabase(path, existing); const mode = this.#database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }; if (mode.journal_mode.toLowerCase() !== 'wal') fail('corrupt', 'database refused WAL mode') }
      const version = (this.#database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (!Number.isSafeInteger(version) || version < 0 || version > 1) fail('corrupt', 'database schema version is unsupported')
      if (version === 0 && this.#database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined) fail('corrupt', 'unversioned database is not an acceptance ledger')
      if (version === 0) this.#database.exec(`CREATE TABLE acceptance_contracts (
        id TEXT PRIMARY KEY NOT NULL, scope TEXT NOT NULL, owner TEXT NOT NULL, task_kind TEXT NOT NULL, task_ref TEXT NOT NULL,
        payload TEXT NOT NULL, UNIQUE(scope, owner, task_kind, task_ref));
        CREATE TABLE IF NOT EXISTS acceptance_jobs (
        contract_id TEXT PRIMARY KEY NOT NULL REFERENCES acceptance_contracts(id), state TEXT NOT NULL CHECK(state IN ('awaiting-execution','pending','verifying','done','needs-attention')),
        attempts INTEGER NOT NULL DEFAULT 0, fencing_token INTEGER NOT NULL DEFAULT 0, worker_id TEXT, lease_until INTEGER, execution TEXT, receipt TEXT, reason TEXT, retry_at INTEGER);
        CREATE TABLE IF NOT EXISTS acceptance_receipts (id TEXT PRIMARY KEY NOT NULL, contract_id TEXT NOT NULL REFERENCES acceptance_contracts(id), payload TEXT NOT NULL, digest TEXT NOT NULL, UNIQUE(contract_id, digest));
        CREATE TABLE IF NOT EXISTS acceptance_outbox (receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES acceptance_receipts(id), digest TEXT NOT NULL, contract_id TEXT NOT NULL REFERENCES acceptance_contracts(id), acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1)));
        PRAGMA user_version = 1;`)
      verifySchema(this.#database)
    } catch (error) { this.#database.close(); throw error }
  }

  close(): void { if (!this.#closed) { this.#closed = true; this.#database.close() } }

  accept(input: TaskAcceptanceContract): TaskAcceptanceContract {
    const contract = validateTaskAcceptanceContract(input); const payload = acceptanceCanonicalJson(contract)
    this.#transaction(() => {
      const byId = this.#database.prepare('SELECT id, payload FROM acceptance_contracts WHERE id = ?').get(contract.id) as { id: string; payload: string } | undefined
      const byTask = this.#database.prepare('SELECT id, payload FROM acceptance_contracts WHERE scope = ? AND owner = ? AND task_kind = ? AND task_ref = ?').get(contract.scope.workspace + '\0' + contract.scope.preset, contract.owner.principalRecordId + '\0' + contract.owner.principalVersion, contract.task.kind, contract.task.ref) as { id: string; payload: string } | undefined
      if (byId !== undefined || byTask !== undefined) {
        const existing = byId ?? byTask!; if (existing.id !== undefined && existing.id !== contract.id || existing.payload !== payload) fail('conflict', 'contract id or task identity is immutable')
        return
      }
      this.#database.prepare('INSERT INTO acceptance_contracts (id, scope, owner, task_kind, task_ref, payload) VALUES (?, ?, ?, ?, ?, ?)').run(contract.id, contract.scope.workspace + '\0' + contract.scope.preset, contract.owner.principalRecordId + '\0' + contract.owner.principalVersion, contract.task.kind, contract.task.ref, payload)
      this.#database.prepare("INSERT INTO acceptance_jobs (contract_id, state) VALUES (?, 'awaiting-execution')").run(contract.id)
    })
    return contract
  }

  getContract(id: string): TaskAcceptanceContract | null { safeId(id, 'contractId'); const row = this.#database.prepare('SELECT payload FROM acceptance_contracts WHERE id = ?').get(id) as ContractRow | undefined; return row === undefined ? null : parseContract(row.payload) }
  getTaskContract(identity: { scope: { workspace: string; preset: string }; owner: { principalRecordId: string; principalVersion: number }; task: { kind: 'automation-run' | 'foreground-turn'; ref: string } }): TaskAcceptanceContract | null {
    if (typeof identity.scope?.workspace !== 'string' || !isAbsolute(identity.scope.workspace) || normalize(identity.scope.workspace) !== identity.scope.workspace || typeof identity.scope.preset !== 'string' || !IDENTIFIER.test(identity.scope.preset)) fail('invalid-input', 'scope is invalid')
    safeId(identity.owner?.principalRecordId, 'owner principalRecordId'); if (!Number.isSafeInteger(identity.owner.principalVersion) || identity.owner.principalVersion < 1) fail('invalid-input', 'owner principalVersion is invalid'); if (identity.task.kind !== 'automation-run' && identity.task.kind !== 'foreground-turn') fail('invalid-input', 'task kind is invalid'); safeId(identity.task.ref, 'task ref')
    const row = this.#database.prepare('SELECT payload FROM acceptance_contracts WHERE scope = ? AND owner = ? AND task_kind = ? AND task_ref = ?').get(identity.scope.workspace + '\0' + identity.scope.preset, identity.owner.principalRecordId + '\0' + identity.owner.principalVersion, identity.task.kind, identity.task.ref) as ContractRow | undefined
    return row === undefined ? null : parseContract(row.payload)
  }

  markExecutionFinished(contractId: string, input: Execution): void {
    safeId(contractId, 'contractId'); const item = execution(input)
    this.#transaction(() => {
      const contract = this.#requireContract(contractId); const job = this.#job(contract)
      if (item.completedAt < contract.issuedAt) fail('invalid-input', 'execution completedAt predates contract')
      const serialized = acceptanceCanonicalJson(item)
      if (job.execution !== null) { if (job.execution !== serialized) fail('conflict', 'execution is immutable'); return }
      const state: AcceptanceState['state'] = item.completedAt >= contract.expiresAt ? 'needs-attention' : 'pending'
      this.#database.prepare('UPDATE acceptance_jobs SET execution = ?, state = ?, reason = ?, retry_at = ? WHERE contract_id = ?').run(serialized, state, state === 'pending' ? null : 'contract-expired', state === 'pending' ? item.completedAt : null, contractId)
    })
  }

  claimDue(input: { workerId: string; now: number; leaseMs: number }): ClaimedVerification | null {
    safeId(input.workerId, 'workerId'); safeTime(input.now, 'now'); if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1 || input.leaseMs > 305_000 || input.now > Number.MAX_SAFE_INTEGER - input.leaseMs) fail('invalid-input', 'leaseMs is invalid')
    return this.#transaction(() => {
      const row = this.#database.prepare("SELECT j.contract_id, j.state, j.attempts, j.fencing_token, j.worker_id, j.lease_until, j.execution, j.receipt, j.reason, j.retry_at, c.payload FROM acceptance_jobs j JOIN acceptance_contracts c ON c.id = j.contract_id WHERE (j.state = 'pending' AND j.retry_at <= ?) OR (j.state = 'verifying' AND j.lease_until < ?) ORDER BY j.contract_id LIMIT 1").get(input.now, input.now) as unknown as (JobRow & { payload: string }) | undefined
      if (row !== undefined) {
        const contract = parseContract(row.payload); validatedJob(contract, row); if (contract.expiresAt <= input.now || row.attempts >= MAX_ATTEMPTS) { this.#database.prepare("UPDATE acceptance_jobs SET state = 'needs-attention', worker_id = NULL, lease_until = NULL, retry_at = NULL, reason = ? WHERE contract_id = ?").run(contract.expiresAt <= input.now ? 'contract-expired' : 'attempt-limit', row.contract_id); return null }
        if (input.leaseMs < contract.bounds.maxDurationMs + 5_000) fail('invalid-input', 'leaseMs must cover contract duration plus grace')
        if (row.execution === null) fail('corrupt', 'claimable job lacks execution')
        const attempts = row.attempts + 1; const fence = row.fencing_token + 1; const leaseUntil = input.now + input.leaseMs
        this.#database.prepare("UPDATE acceptance_jobs SET state = 'verifying', attempts = ?, fencing_token = ?, worker_id = ?, lease_until = ? WHERE contract_id = ?").run(attempts, fence, input.workerId, leaseUntil, row.contract_id)
        return Object.freeze({ contract, job: Object.freeze({ contractId: row.contract_id, attempt: attempts, fencingToken: fence, workerId: input.workerId, leaseUntil }), execution: parseExecution(row.execution) })
      }
      return null
    })
  }

  finish(input: { contractId: string; workerId: string; fencingToken: number; now: number; receipt: TaskVerificationReceipt | null; reason: string; retryAt?: number }): void {
    safeId(input.contractId, 'contractId'); safeId(input.workerId, 'workerId'); safeTime(input.now, 'now'); if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) fail('invalid-input', 'fencingToken is invalid'); reason(input.reason); if (input.retryAt !== undefined) safeTime(input.retryAt, 'retryAt')
    this.#transaction(() => {
      const contract = this.#requireContract(input.contractId); const job = this.#job(contract)
      const receipt = input.receipt === null ? null : validateTaskVerificationReceipt(contract, input.receipt); const serialized = receipt === null ? null : acceptanceCanonicalJson(receipt)
      if (job.state !== 'verifying' || job.worker_id !== input.workerId || job.fencing_token !== input.fencingToken || job.lease_until === null || job.lease_until < input.now) fail('conflict', 'verification lease is no longer live')
      const actual = job.execution === null ? fail('corrupt', 'verifying job lacks execution') : parseExecution(job.execution)
      if (receipt !== null && (receipt.startedAt < actual.completedAt || receipt.completedAt > input.now || (receipt.objectiveStatus !== 'unknown' && receipt.validUntil <= input.now))) fail('invalid-input', 'receipt is outside live execution evidence')
      if (receipt !== null) this.#recordReceipt(contract, receipt, serialized!)
      const terminalKnown = receipt !== null && receipt.objectiveStatus !== 'unknown'
      const retry = !terminalKnown && input.retryAt !== undefined && input.retryAt >= input.now && input.retryAt < contract.expiresAt && job.attempts < MAX_ATTEMPTS && input.now < contract.expiresAt
      const state: AcceptanceState['state'] = terminalKnown ? 'done' : retry ? 'pending' : 'needs-attention'
      const nextReason = terminalKnown ? input.reason : retry ? input.reason : input.now >= contract.expiresAt || (input.retryAt !== undefined && input.retryAt > contract.expiresAt) ? 'contract-expired' : job.attempts >= MAX_ATTEMPTS ? 'attempt-limit' : input.reason
      this.#database.prepare('UPDATE acceptance_jobs SET state = ?, worker_id = NULL, lease_until = NULL, receipt = ?, reason = ?, retry_at = ? WHERE contract_id = ?').run(state, serialized, nextReason, retry ? input.retryAt! : null, input.contractId)
      if (receipt !== null) this.#database.prepare('INSERT OR IGNORE INTO acceptance_outbox (receipt_id, digest, contract_id) VALUES (?, ?, ?)').run(receipt.id, receipt.digest, contract.id)
    })
  }

  getState(contractId: string): AcceptanceState | null {
    safeId(contractId, 'contractId'); const row = this.#database.prepare('SELECT contract_id, state, attempts, fencing_token, worker_id, lease_until, execution, receipt, reason, retry_at FROM acceptance_jobs WHERE contract_id = ?').get(contractId) as JobRow | undefined
    if (row === undefined) return null; const contract = this.#requireContract(contractId); const checked = validatedJob(contract, row)
    return Object.freeze({ state: row.state, attempts: row.attempts, reason: row.reason, receipt: checked.receipt, execution: checked.execution })
  }

  counts(now: number): Readonly<{ awaitingExecution: number; pendingVerification: number; pendingReceipts: number; expiredReceipts: number; needsAttention: number }> {
    safeTime(now, 'now')
    const jobs = this.#database.prepare(`SELECT
      count(*) FILTER (WHERE state = 'awaiting-execution') AS awaitingExecution,
      count(*) FILTER (WHERE state IN ('pending', 'verifying')) AS pendingVerification,
      count(*) FILTER (WHERE state = 'needs-attention') AS needsAttention
      FROM acceptance_jobs`).get() as { awaitingExecution: number; pendingVerification: number; needsAttention: number }
    const receipts = this.#database.prepare(`SELECT count(*) AS pendingReceipts,
      count(*) FILTER (WHERE json_extract(r.payload, '$.validUntil') <= ?) AS expiredReceipts
      FROM acceptance_outbox o JOIN acceptance_receipts r ON r.id = o.receipt_id
      WHERE o.acknowledged = 0`).get(now) as { pendingReceipts: number; expiredReceipts: number }
    return Object.freeze({ ...jobs, ...receipts })
  }

  awaitingExecution(limit = 100, afterId = ''): readonly TaskAcceptanceContract[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-input', 'limit is invalid')
    if (afterId !== '') safeId(afterId, 'afterId')
    const rows = this.#database.prepare("SELECT j.contract_id, j.state, j.attempts, j.fencing_token, j.worker_id, j.lease_until, j.execution, j.receipt, j.reason, j.retry_at, c.payload FROM acceptance_jobs j JOIN acceptance_contracts c ON c.id = j.contract_id WHERE j.state = 'awaiting-execution' AND j.contract_id > ? ORDER BY j.contract_id LIMIT ?").all(afterId, limit) as unknown as Array<JobRow & { payload: string }>
    return Object.freeze(rows.map(row => { const contract = parseContract(row.payload); validatedJob(contract, row); return contract }))
  }

  /** Bounds recovery work while making missing terminal execution evidence actionable. */
  expireAwaiting(now: number): number {
    safeTime(now, 'now')
    return this.#transaction(() => {
      const rows = this.#database.prepare("SELECT j.contract_id, j.state, j.attempts, j.fencing_token, j.worker_id, j.lease_until, j.execution, j.receipt, j.reason, j.retry_at, c.payload FROM acceptance_jobs j JOIN acceptance_contracts c ON c.id = j.contract_id WHERE j.state = 'awaiting-execution' AND json_extract(c.payload, '$.expiresAt') <= ? ORDER BY j.contract_id LIMIT 100").all(now) as unknown as Array<JobRow & { payload: string }>
      let expired = 0
      for (const row of rows) {
        const contract = parseContract(row.payload); validatedJob(contract, row)
        if (contract.expiresAt <= now) {
          const result = this.#database.prepare("UPDATE acceptance_jobs SET state = 'needs-attention', reason = 'execution-unconfirmed' WHERE contract_id = ? AND state = 'awaiting-execution'").run(row.contract_id)
          expired += Number(result.changes)
        }
      }
      return expired
    })
  }

  listAttention(limit = 100): readonly AttentionState[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-input', 'limit is invalid')
    const rows = this.#database.prepare("SELECT j.contract_id, j.state, j.attempts, j.fencing_token, j.worker_id, j.lease_until, j.execution, j.receipt, j.reason, j.retry_at, c.payload FROM acceptance_jobs j JOIN acceptance_contracts c ON c.id = j.contract_id WHERE j.state = 'needs-attention' ORDER BY j.contract_id LIMIT ?").all(limit) as unknown as Array<JobRow & { payload: string }>
    return Object.freeze(rows.map(row => {
      const contract = parseContract(row.payload); const checked = validatedJob(contract, row)
      return Object.freeze({ contract, state: row.state, attempts: row.attempts, reason: row.reason, receipt: checked.receipt, execution: checked.execution })
    }))
  }

  pendingReceipts(limit = 100, afterId = ''): readonly { contract: TaskAcceptanceContract; receipt: TaskVerificationReceipt }[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('invalid-input', 'limit is invalid')
    if (afterId !== '') safeId(afterId, 'afterId')
    const rows = this.#database.prepare('SELECT c.payload AS contract, r.payload AS receipt FROM acceptance_outbox o JOIN acceptance_contracts c ON c.id = o.contract_id JOIN acceptance_receipts r ON r.id = o.receipt_id WHERE o.acknowledged = 0 AND o.receipt_id > ? ORDER BY o.receipt_id LIMIT ?').all(afterId, limit) as unknown as OutboxRow[]
    return Object.freeze(rows.map(row => { const contract = parseContract(row.contract); return Object.freeze({ contract, receipt: parseReceipt(contract, row.receipt) }) }))
  }
  acknowledgeReceipt(receiptId: string, digest: string): void { safeId(receiptId, 'receiptId'); if (!/^[a-f0-9]{64}$/u.test(digest)) fail('invalid-input', 'digest is invalid'); this.#transaction(() => { const row = this.#database.prepare('SELECT digest FROM acceptance_outbox WHERE receipt_id = ?').get(receiptId) as { digest: string } | undefined; if (row === undefined) fail('conflict', 'outbox receipt is absent'); if (row.digest !== digest) fail('conflict', 'outbox receipt digest differs'); this.#database.prepare('UPDATE acceptance_outbox SET acknowledged = 1 WHERE receipt_id = ?').run(receiptId) }) }

  #requireContract(id: string): TaskAcceptanceContract { const row = this.#database.prepare('SELECT payload FROM acceptance_contracts WHERE id = ?').get(id) as ContractRow | undefined; if (row === undefined) fail('conflict', 'contract is absent'); return parseContract(row.payload) }
  #job(contract: TaskAcceptanceContract): JobRow { const row = this.#database.prepare('SELECT contract_id, state, attempts, fencing_token, worker_id, lease_until, execution, receipt, reason, retry_at FROM acceptance_jobs WHERE contract_id = ?').get(contract.id) as JobRow | undefined; if (row === undefined) fail('corrupt', 'contract lacks job'); return validatedJob(contract, row).row }
  #recordReceipt(contract: TaskAcceptanceContract, receipt: TaskVerificationReceipt, serialized: string): void { const previous = this.#database.prepare('SELECT payload FROM acceptance_receipts WHERE id = ?').get(receipt.id) as { payload: string } | undefined; if (previous !== undefined && previous.payload !== serialized) fail('conflict', 'receipt id is immutable'); if (previous === undefined) this.#database.prepare('INSERT INTO acceptance_receipts (id, contract_id, payload, digest) VALUES (?, ?, ?, ?)').run(receipt.id, contract.id, serialized, receipt.digest) }
  #transaction<T>(body: () => T): T { if (this.#closed) fail('conflict', 'store is closed'); this.#database.exec('BEGIN IMMEDIATE'); try { const result = body(); this.#database.exec('COMMIT'); return result } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error } }
}
