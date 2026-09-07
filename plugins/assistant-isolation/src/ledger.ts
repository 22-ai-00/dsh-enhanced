import { validateGoalArtifactAdmission } from '@dsh-enhanced/task-acceptance-contract'
import { chmodSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { processExited, sameDaemonWitness, validateCreationWitness, type CreationWitness, type DaemonWitness } from './runtime-witness.js'
import type { SystemdBinding } from './daemon-binding.js'
import { receiptData, type IsolationCleanupReceipt } from './cleanup-receipt.js'
import { pruneResult, validateRetention } from './storage-policy.js'
import type { IsolationArtifactBinding, IsolationGrant, IsolationIdentity, IsolationJob, IsolationResult, IsolationStatus, IsolationStorageBudget } from './types.js'

export type IsolationLedgerErrorCode = 'conflict' | 'invalid-input' | 'invalid-path' | 'invalid-state' | 'not-found' | 'schema' | 'schema-too-new' | 'unauthorized'

export class IsolationLedgerError extends Error {
  constructor(readonly code: IsolationLedgerErrorCode, message: string = code) { super(message); this.name = 'IsolationLedgerError' }
}
export interface IsolationControllerAuthority { ownerId: string; fence: number }

const schemaVersion = 6
const outputMaximum = 1_048_576
const artifactMaximum = 128
const textMaximum = 16_384
function fail(code: IsolationLedgerErrorCode, message?: string): never { throw new IsolationLedgerError(code, message) }
const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const safePositive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= Number.MAX_SAFE_INTEGER
const safeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= Number.MAX_SAFE_INTEGER
const positiveTime = (value: unknown): value is number => safeTime(value) && (value as number) > 0
const text = (value: unknown, maximumLength = textMaximum): value is string => typeof value === 'string' && value.length > 0 && value.length <= maximumLength
const frozen = <T>(value: T): T => { if (value && typeof value === 'object') { for (const entry of Object.values(value as Record<string, unknown>)) frozen(entry); Object.freeze(value) }; return value }
const onlyKeys = (value: object, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key))

function identity(value: IsolationIdentity): IsolationIdentity {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 5
    || !text(value.principalDigest) || !text(value.principalRecordId) || !safePositive(value.principalVersion)
    || !text(value.workspace) || !text(value.agentPreset)) fail('invalid-input', 'invalid isolation identity')
  return frozen({ principalDigest: value.principalDigest, principalRecordId: value.principalRecordId, principalVersion: value.principalVersion, workspace: value.workspace, agentPreset: value.agentPreset })
}

function grant(value: IsolationGrant): IsolationGrant {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 10 || !text(value.id) || !safePositive(value.revision)
    || !positiveTime(value.expiresAt) || !safePositive(value.maxRuns) || !safePositive(value.maxTotalDurationMs)) fail('invalid-input', 'invalid isolation grant')
  return frozen({ ...identity({ principalDigest: value.principalDigest, principalRecordId: value.principalRecordId, principalVersion: value.principalVersion, workspace: value.workspace, agentPreset: value.agentPreset }), id: value.id, revision: value.revision, expiresAt: value.expiresAt, maxRuns: value.maxRuns, maxTotalDurationMs: value.maxTotalDurationMs })
}

function artifactBinding(value: IsolationArtifactBinding): IsolationArtifactBinding {
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !onlyKeys(value, ['admission', 'paths'])
    || !Array.isArray(value.paths) || value.paths.length > 128 || new Set(value.paths).size !== value.paths.length
    || value.paths.some(path => !text(path, 4096) || isAbsolute(path) || normalize(path) !== path || path === '.' || path.split(/[\\/]/u).includes('..') || /[\p{Cc}]/u.test(path))) fail('invalid-input', 'invalid artifact binding')
  return frozen({ admission: validateGoalArtifactAdmission(value.admission), paths: [...value.paths] })
}

function grantDigest(value: IsolationGrant): string { return JSON.stringify(value) }

function result(value: IsolationResult, allowRetention = false): IsolationResult {
  if (!value || typeof value !== 'object' || !text(value.jobId) || !['succeeded', 'failed', 'cancelled', 'timed-out', 'unknown'].includes(value.status)
    || typeof value.quiescent !== 'boolean' || typeof value.stdout !== 'string' || typeof value.stderr !== 'string'
    || value.stdout.length > outputMaximum || value.stderr.length > outputMaximum || !Array.isArray(value.artifacts) || value.artifacts.length > artifactMaximum
    || (value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || value.exitCode < -1_000_000 || value.exitCode > 1_000_000))
    || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.length > textMaximum))
    || !value.artifacts.every(item => item && typeof item === 'object' && typeof item.path === 'string' && item.path.length <= textMaximum && typeof item.content === 'string' && item.content.length <= outputMaximum)) fail('invalid-input', 'invalid isolation result')
  const retention = value.retention === undefined ? undefined : validateRetention(value.retention)
  if (value.retention !== undefined && (!allowRetention || !retention || value.status === 'unknown' || !value.quiescent || value.stdout !== '' || value.stderr !== '' || value.artifacts.length !== 0)) fail('invalid-input', 'invalid pruned isolation result')
  return frozen({ jobId: value.jobId, status: value.status, quiescent: value.quiescent, ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }), stdout: value.stdout, stderr: value.stderr, artifacts: value.artifacts.map(item => ({ path: item.path, content: item.content })), ...(value.reason === undefined ? {} : { reason: value.reason }), ...(retention ? { retention } : {}) })
}

type GrantRow = { id: string; digest: string; revision: number; expires_at: number; max_runs: number; max_total_duration_ms: number; revoked: number; principal_digest: string; principal_record_id: string; principal_version: number; workspace: string; agent_preset: string }
type JobRow = { id: string; grant_id: string; grant_revision: number; principal_digest: string; principal_record_id: string; principal_version: number; workspace: string; agent_preset: string; session_id: string; idempotency_key: string; request_digest: string; container_name: string; deadline: number; reserved_duration_ms: number; reserved_memory_mib: number; reserved_workspace_inodes: number; reserved_storage_bytes: number; status: IsolationStatus; version: number; created_at: number; updated_at: number; result_json: string | null; dispatch_attempted: number; creation_witness_json: string | null; artifact_binding_json: string | null }
type ResourceReservation = { memoryMiB: number; workspaceInodes: number; maxMemoryMiB: number; maxWorkspaceInodes: number }

function open(path: string): DatabaseSync {
  if (path !== ':memory:' && !isAbsolute(path)) fail('invalid-path', 'isolation ledger path must be absolute')
  if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700) }
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;')
    if (path !== ':memory:') {
      const row = database.prepare('PRAGMA journal_mode = WAL').get() as { journal_mode: string }
      if (row.journal_mode.toLowerCase() !== 'wal') fail('schema', 'isolation ledger refused WAL')
    }
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version > schemaVersion) fail('schema-too-new')
    if (version === 0) database.exec(`PRAGMA auto_vacuum = INCREMENTAL; VACUUM; BEGIN IMMEDIATE;
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      INSERT INTO schema_meta(key, value) VALUES ('schema-version', '6');
      CREATE TABLE isolation_grants (id TEXT PRIMARY KEY, digest TEXT NOT NULL, revision INTEGER NOT NULL, expires_at INTEGER NOT NULL, max_runs INTEGER NOT NULL, max_total_duration_ms INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), revoke_reason TEXT, principal_digest TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL) STRICT;
      CREATE TABLE isolation_jobs (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, principal_digest TEXT NOT NULL, principal_record_id TEXT NOT NULL, principal_version INTEGER NOT NULL, workspace TEXT NOT NULL, agent_preset TEXT NOT NULL, session_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL, container_name TEXT NOT NULL UNIQUE, deadline INTEGER NOT NULL, reserved_duration_ms INTEGER NOT NULL, reserved_memory_mib INTEGER NOT NULL DEFAULT 0, reserved_workspace_inodes INTEGER NOT NULL DEFAULT 0, reserved_storage_bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL CHECK(status IN ('prepared','running','succeeded','failed','cancelled','timed-out','unknown')), version INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, result_json TEXT, dispatch_attempted INTEGER NOT NULL DEFAULT 0 CHECK(dispatch_attempted IN (0,1)), creation_witness_json TEXT, artifact_binding_json TEXT, UNIQUE(principal_digest, principal_record_id, principal_version, workspace, agent_preset, session_id, grant_id, idempotency_key)) STRICT;
      CREATE INDEX isolation_jobs_grant ON isolation_jobs(grant_id);
      CREATE INDEX isolation_jobs_recoverable ON isolation_jobs(status, updated_at);
      CREATE TABLE isolation_audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, occurred_at INTEGER NOT NULL, action TEXT NOT NULL, job_id TEXT, grant_id TEXT, detail TEXT NOT NULL) STRICT;
      CREATE TABLE isolation_controller (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      PRAGMA user_version = 6; COMMIT;`)
    if (version === 1) database.exec(`BEGIN IMMEDIATE;
      ALTER TABLE isolation_jobs ADD COLUMN reserved_memory_mib INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE isolation_jobs ADD COLUMN reserved_workspace_inodes INTEGER NOT NULL DEFAULT 0;
      UPDATE schema_meta SET value='2' WHERE key='schema-version';
      PRAGMA user_version = 2; COMMIT;`)
    // Old prepared/running records cannot prove that no supervisor was spawned.
    if (version === 1 || version === 2) database.exec(`BEGIN IMMEDIATE;
      ALTER TABLE isolation_jobs ADD COLUMN dispatch_attempted INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_attempted IN (0,1));
      ALTER TABLE isolation_jobs ADD COLUMN creation_witness_json TEXT;
      UPDATE schema_meta SET value='3' WHERE key='schema-version';
      PRAGMA user_version = 3; COMMIT;`)
    if ([1, 2, 3].includes(version)) database.exec(`BEGIN IMMEDIATE; UPDATE schema_meta SET value='4' WHERE key='schema-version'; PRAGMA user_version=4; COMMIT;`)
    if ([1, 2, 3, 4].includes(version)) database.exec(`BEGIN IMMEDIATE; ALTER TABLE isolation_jobs ADD COLUMN reserved_storage_bytes INTEGER NOT NULL DEFAULT 0; UPDATE schema_meta SET value='5' WHERE key='schema-version'; PRAGMA user_version=5; COMMIT;`)
    if ([1, 2, 3, 4, 5].includes(version)) database.exec(`BEGIN IMMEDIATE; ALTER TABLE isolation_jobs ADD COLUMN artifact_binding_json TEXT; UPDATE schema_meta SET value='6' WHERE key='schema-version'; PRAGMA user_version=6; COMMIT;`)
    database.exec("CREATE INDEX IF NOT EXISTS isolation_artifact_contract ON isolation_jobs(json_extract(artifact_binding_json, '$.admission.contractId')) WHERE artifact_binding_json IS NOT NULL")
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== schemaVersion) fail('schema')
    if (path !== ':memory:') chmodSync(path, 0o600)
    return database
  } catch (error) { database.close(); throw error }
}

/** Durable Host-owned authorization and job state. This database is never mounted in workers. */
export class IsolationLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number
  constructor(path: string, { now = Date.now }: { now?: () => number } = {}) { this.#database = open(path); this.#now = now }
  #transaction<T>(operation: () => T): T { this.#database.exec('BEGIN IMMEDIATE'); try { const value = operation(); this.#database.exec('COMMIT'); return value } catch (error) { try { this.#database.exec('ROLLBACK') } catch {}; throw error } }
  #nowValue(): number { const value = this.#now(); if (!safeTime(value)) fail('invalid-input', 'clock returned invalid time'); return value }
  #grant(id: string): GrantRow | undefined { return this.#database.prepare('SELECT * FROM isolation_grants WHERE id = ?').get(id) as GrantRow | undefined }
  #job(id: string): IsolationJob | undefined { const row = this.#database.prepare('SELECT * FROM isolation_jobs WHERE id = ?').get(id) as JobRow | undefined; return row ? this.#decodeJob(row) : undefined }
  #audit(now: number, action: string, jobId: string | null, grantId: string | null, detail: string): void { this.#database.prepare('INSERT INTO isolation_audit(occurred_at, action, job_id, grant_id, detail) VALUES (?, ?, ?, ?, ?)').run(now, action, jobId, grantId, detail) }
  #authority(value: IsolationControllerAuthority | undefined): IsolationControllerAuthority | undefined {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object' || Object.keys(value).length !== 2 || !text(value.ownerId) || !safePositive(value.fence)) fail('invalid-input', 'invalid controller authority')
    return frozen({ ownerId: value.ownerId, fence: value.fence })
  }
  #requireController(value: IsolationControllerAuthority | undefined, now: number): void {
    if (!value) return
    const row = this.#database.prepare('SELECT owner_id, fence, expires_at FROM isolation_controller WHERE singleton=1').get() as { owner_id: string; fence: number; expires_at: number } | undefined
    if (!row || row.owner_id !== value.ownerId || row.fence !== value.fence || !safeTime(row.expires_at) || row.expires_at <= now) fail('unauthorized', 'controller lease is absent, expired, or fenced')
  }
  #decodeJob(row: JobRow): IsolationJob {
    const jobIdentity = identity({ principalDigest: row.principal_digest, principalRecordId: row.principal_record_id, principalVersion: row.principal_version, workspace: row.workspace, agentPreset: row.agent_preset })
    if (!text(row.id) || !text(row.grant_id) || !safePositive(row.grant_revision) || !text(row.session_id) || !text(row.idempotency_key) || !text(row.request_digest) || !text(row.container_name) || !positiveTime(row.deadline) || !safePositive(row.reserved_duration_ms) || !safeTime(row.reserved_memory_mib) || !safeTime(row.reserved_workspace_inodes) || !safeTime(row.reserved_storage_bytes) || !safePositive(row.version) || !safeTime(row.created_at) || !safeTime(row.updated_at) || row.updated_at < row.created_at || !['prepared', 'running', 'succeeded', 'failed', 'cancelled', 'timed-out', 'unknown'].includes(row.status)) fail('schema')
    if (![0, 1].includes(row.dispatch_attempted)) fail('schema')
    let witness: CreationWitness | undefined
    if (row.creation_witness_json !== null) {
      try { witness = validateCreationWitness(JSON.parse(row.creation_witness_json)) } catch { fail('schema') }
      if (!row.dispatch_attempted) fail('schema')
    }
    let binding: IsolationArtifactBinding | undefined
    if (row.artifact_binding_json !== null) { try { binding = artifactBinding(JSON.parse(row.artifact_binding_json)) } catch { fail('schema') } }
    let parsed: IsolationResult | undefined
    if (row.result_json !== null) { try { parsed = result(JSON.parse(row.result_json) as IsolationResult, true) } catch { fail('schema') }; if (parsed.jobId !== row.id || (row.status === 'prepared' || row.status === 'running') || parsed.status !== row.status) fail('schema') }
    else if (row.status !== 'prepared' && row.status !== 'running') fail('schema')
    return frozen({ ...(binding ? { artifactBinding: binding } : {}), id: row.id, grantId: row.grant_id, grantRevision: row.grant_revision, identity: jobIdentity, sessionId: row.session_id, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, containerName: row.container_name, deadline: row.deadline, reservedDurationMs: row.reserved_duration_ms, reservedMemoryMiB: row.reserved_memory_mib, reservedWorkspaceInodes: row.reserved_workspace_inodes, reservedStorageBytes: row.reserved_storage_bytes, dispatchAttempted: row.dispatch_attempted === 1, ...(witness ? { creationWitness: witness } : {}), status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at, ...(parsed ? { result: parsed } : {}) })
  }
  syncGrants(grants: IsolationGrant[], authority?: IsolationControllerAuthority): void {
    if (!Array.isArray(grants)) fail('invalid-input')
    const values = grants.map(grant); const controller = this.#authority(authority); const ids = new Set<string>(); if (values.some(item => ids.has(item.id) || !ids.add(item.id))) fail('invalid-input', 'duplicate grant')
    this.#transaction(() => { const now = this.#nowValue(); this.#requireController(controller, now); const seen = new Set(values.map(item => item.id))
      for (const value of values) { const current = this.#grant(value.id); const digest = grantDigest(value)
        if (current && value.revision < current.revision) fail('conflict', 'grant revision is stale')
        if (current && value.revision === current.revision) { if (current.digest !== digest) fail('conflict', 'grant revision digest differs'); continue }
        if (current) this.#database.prepare('UPDATE isolation_grants SET digest=?, revision=?, expires_at=?, max_runs=?, max_total_duration_ms=?, revoked=0, revoke_reason=NULL, principal_digest=?, principal_record_id=?, principal_version=?, workspace=?, agent_preset=? WHERE id=?').run(digest, value.revision, value.expiresAt, value.maxRuns, value.maxTotalDurationMs, value.principalDigest, value.principalRecordId, value.principalVersion, value.workspace, value.agentPreset, value.id)
        else this.#database.prepare('INSERT INTO isolation_grants(id,digest,revision,expires_at,max_runs,max_total_duration_ms,revoked,principal_digest,principal_record_id,principal_version,workspace,agent_preset) VALUES (?,?,?,?,?,?,0,?,?,?,?,?)').run(value.id, digest, value.revision, value.expiresAt, value.maxRuns, value.maxTotalDurationMs, value.principalDigest, value.principalRecordId, value.principalVersion, value.workspace, value.agentPreset)
        this.#audit(now, 'grant-synced', null, value.id, `revision:${value.revision}`)
      }
      for (const row of this.#database.prepare('SELECT id, revision, revoked FROM isolation_grants').all() as Array<{ id: string; revision: number; revoked: number }>) if (!seen.has(row.id) && row.revoked === 0) { this.#database.prepare('UPDATE isolation_grants SET revoked=1, revoke_reason=? WHERE id=?').run('removed-from-config', row.id); this.#audit(now, 'grant-revoked', null, row.id, 'removed-from-config') }
    })
  }
  prepare(input: { identity: IsolationIdentity; sessionId: string; grantId: string; idempotencyKey: string; requestDigest: string; durationMs: number; maxActiveJobs?: number; authority?: IsolationControllerAuthority; resourceReservation?: ResourceReservation; storageBudget?: IsolationStorageBudget; artifactBinding?: IsolationArtifactBinding }): { job: IsolationJob; created: boolean } {
    if (!input || typeof input !== 'object' || ![6, 7, 8, 9, 10, 11].includes(Object.keys(input).length) || !onlyKeys(input, ['identity', 'sessionId', 'grantId', 'idempotencyKey', 'requestDigest', 'durationMs', 'maxActiveJobs', 'authority', 'resourceReservation', 'storageBudget', 'artifactBinding']) || !text(input.sessionId) || !text(input.grantId) || !text(input.idempotencyKey) || !text(input.requestDigest) || !safePositive(input.durationMs) || (input.maxActiveJobs !== undefined && !safePositive(input.maxActiveJobs))) fail('invalid-input')
    const binding = input.artifactBinding === undefined ? undefined : artifactBinding(input.artifactBinding)
    const reservation = input.resourceReservation === undefined ? undefined : input.resourceReservation
    if (reservation !== undefined && (!reservation || typeof reservation !== 'object' || Object.keys(reservation).length !== 4 || !onlyKeys(reservation, ['memoryMiB', 'workspaceInodes', 'maxMemoryMiB', 'maxWorkspaceInodes']) || !safePositive(reservation.memoryMiB) || !safePositive(reservation.workspaceInodes) || !safePositive(reservation.maxMemoryMiB) || !safePositive(reservation.maxWorkspaceInodes) || reservation.memoryMiB > reservation.maxMemoryMiB || reservation.workspaceInodes > reservation.maxWorkspaceInodes)) fail('invalid-input', 'invalid resource reservation')
    const storage = input.storageBudget
    if (storage !== undefined && (!storage || typeof storage !== 'object' || !onlyKeys(storage, ['maxStateBytes', 'maxJobRecords', 'reservedBytes', 'observation']) || ![3, 4].includes(Object.keys(storage).length) || !safePositive(storage.maxStateBytes) || !safePositive(storage.maxJobRecords) || !safePositive(storage.reservedBytes) || (storage.observation !== undefined && (!storage.observation || typeof storage.observation !== 'object' || Object.keys(storage.observation).length !== 2 || !onlyKeys(storage.observation, ['bytes', 'observedAt']) || !safeTime(storage.observation.bytes) || !safeTime(storage.observation.observedAt))))) fail('invalid-input', 'invalid storage budget')
    const who = identity(input.identity); const controller = this.#authority(input.authority)
    return this.#transaction(() => { const now = this.#nowValue(); this.#requireController(controller, now); const existing = this.#database.prepare('SELECT * FROM isolation_jobs WHERE principal_digest=? AND principal_record_id=? AND principal_version=? AND workspace=? AND agent_preset=? AND session_id=? AND grant_id=? AND idempotency_key=?').get(who.principalDigest, who.principalRecordId, who.principalVersion, who.workspace, who.agentPreset, input.sessionId, input.grantId, input.idempotencyKey) as JobRow | undefined
      if (existing) { const job = this.#decodeJob(existing); if (job.requestDigest !== input.requestDigest) fail('conflict', 'idempotency key has a different request digest'); return { job, created: false } }
      const current = this.#grant(input.grantId)
      if (!current || current.revoked || current.expires_at <= now || current.principal_digest !== who.principalDigest || current.principal_record_id !== who.principalRecordId || current.principal_version !== who.principalVersion || current.workspace !== who.workspace || current.agent_preset !== who.agentPreset) fail('unauthorized')
      if (input.maxActiveJobs !== undefined) {
        const active = this.#database.prepare("SELECT COUNT(*) AS count FROM isolation_jobs WHERE status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0)").get() as { count: number }
        if (!safeTime(active.count) || active.count >= input.maxActiveJobs) fail('unauthorized', 'active isolation job limit reached')
      }
      const usage = this.#database.prepare('SELECT COUNT(*) AS runs, COALESCE(SUM(reserved_duration_ms), 0) AS duration FROM isolation_jobs WHERE grant_id=?').get(input.grantId) as { runs: number; duration: number }
      if (!safeTime(usage.runs) || !safeTime(usage.duration) || usage.runs >= current.max_runs || input.durationMs > current.max_total_duration_ms || usage.duration > current.max_total_duration_ms - input.durationMs) fail('unauthorized', 'grant budget exhausted')
      if (reservation) {
        const occupied = "status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0)"
        const legacy = this.#database.prepare(`SELECT COUNT(*) AS count FROM isolation_jobs WHERE (${occupied}) AND (reserved_memory_mib = 0 OR reserved_workspace_inodes = 0)`).get() as { count: number }
        if (!safeTime(legacy.count) || legacy.count > 0) fail('unauthorized', 'active legacy job has no resource reservation')
        const resources = this.#database.prepare(`SELECT COALESCE(SUM(reserved_memory_mib), 0) AS memory, COALESCE(SUM(reserved_workspace_inodes), 0) AS inodes FROM isolation_jobs WHERE ${occupied}`).get() as { memory: number; inodes: number }
        if (!safeTime(resources.memory) || !safeTime(resources.inodes) || resources.memory > reservation.maxMemoryMiB - reservation.memoryMiB || resources.inodes > reservation.maxWorkspaceInodes - reservation.workspaceInodes) fail('unauthorized', 'isolation resource pool exhausted')
      }
      if (storage) {
        const observation = storage.observation
        if (!observation) fail('unauthorized', 'storage observation unavailable')
        if (observation.observedAt > now || now - observation.observedAt > 5_000) fail('invalid-input', 'storage observation is stale')
        const records = this.#database.prepare('SELECT COUNT(*) AS count FROM isolation_jobs').get() as { count: number }
        if (!safeTime(records.count) || records.count >= storage.maxJobRecords) fail('unauthorized', 'isolation job record limit reached')
        const occupied = "status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0)"
        const legacy = this.#database.prepare(`SELECT COUNT(*) AS count FROM isolation_jobs WHERE (${occupied}) AND reserved_storage_bytes = 0`).get() as { count: number }
        if (!safeTime(legacy.count) || legacy.count > 0) fail('unauthorized', 'active legacy job has no storage reservation')
        const reservations = this.#database.prepare(`SELECT COALESCE(SUM(reserved_storage_bytes), 0) AS bytes FROM isolation_jobs WHERE ${occupied}`).get() as { bytes: number }
        if (!safeTime(reservations.bytes)) fail('schema')
        const reserved = reservations.bytes + storage.reservedBytes
        // SQLite reusable pages cannot cover staging growth outside the database.
        // Keep the whole future allocation even when that double-counts reusable space.
        if (!safeTime(reserved) || observation.bytes > storage.maxStateBytes || reserved > storage.maxStateBytes - observation.bytes) fail('unauthorized', 'isolation storage budget exhausted')
      }
      const id = randomUUID(); const deadline = Math.min(now + input.durationMs, current.expires_at)
      this.#database.prepare("INSERT INTO isolation_jobs(id,grant_id,grant_revision,principal_digest,principal_record_id,principal_version,workspace,agent_preset,session_id,idempotency_key,request_digest,container_name,deadline,reserved_duration_ms,reserved_memory_mib,reserved_workspace_inodes,reserved_storage_bytes,dispatch_attempted,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0, 'prepared',1,?,?)").run(id, input.grantId, current.revision, who.principalDigest, who.principalRecordId, who.principalVersion, who.workspace, who.agentPreset, input.sessionId, input.idempotencyKey, input.requestDigest, `dsh-isolation-${id}`, deadline, input.durationMs, reservation?.memoryMiB ?? 0, reservation?.workspaceInodes ?? 0, storage?.reservedBytes ?? 0, now, now)
      if (binding) this.#database.prepare('UPDATE isolation_jobs SET artifact_binding_json=? WHERE id=?').run(JSON.stringify(binding), id)
      this.#audit(now, 'job-prepared', id, input.grantId, `revision:${current.revision}${reservation ? `;reservation:memoryMiB:${reservation.memoryMiB},workspaceInodes:${reservation.workspaceInodes}` : ''}${storage ? `;storageBytes:${storage.reservedBytes}` : ''}`)
      return { job: this.#job(id)!, created: true }
    })
  }
  /** Commit the crash boundary before a supervisor can receive create authority. */
  markDispatched(jobId: string, expectedVersion: number, authority: IsolationControllerAuthority): IsolationJob {
    if (!text(jobId) || !safePositive(expectedVersion)) fail('invalid-input')
    const controller = this.#authority(authority)
    if (!controller) fail('invalid-input')
    return this.#transaction(() => {
      const now = this.#nowValue()
      this.#requireController(controller, now)
      const job = this.#job(jobId)
      if (!job) fail('not-found')
      if (job.version !== expectedVersion) fail('conflict')
      if (job.status !== 'prepared' || job.dispatchAttempted || !this.usable(jobId)) fail('invalid-state')
      const changed = this.#database.prepare("UPDATE isolation_jobs SET dispatch_attempted=1, version=version+1, updated_at=? WHERE id=? AND version=? AND status='prepared' AND dispatch_attempted=0").run(now, jobId, expectedVersion)
      if (changed.changes !== 1) fail('conflict')
      this.#audit(now, 'supervisor-spawn-intent', jobId, job.grantId, 'create-authority-may-be-dispatched')
      return this.#job(jobId)!
    })
  }
  start(jobId: string, expectedVersion: number, authority?: IsolationControllerAuthority): IsolationJob {
    if (!text(jobId) || !safePositive(expectedVersion)) fail('invalid-input')
    const controller = this.#authority(authority)
    return this.#transaction(() => { const now = this.#nowValue(); this.#requireController(controller, now); const job = this.#job(jobId); if (!job) fail('not-found'); if (job.version !== expectedVersion) fail('conflict', 'job version differs'); if (job.status !== 'prepared') fail('invalid-state')
      const current = this.#grant(job.grantId)
      if (!current || current.revoked || current.revision !== job.grantRevision || current.expires_at <= now || job.deadline <= now || current.principal_digest !== job.identity.principalDigest || current.principal_record_id !== job.identity.principalRecordId || current.principal_version !== job.identity.principalVersion || current.workspace !== job.identity.workspace || current.agent_preset !== job.identity.agentPreset) fail('unauthorized')
      const changed = this.#database.prepare("UPDATE isolation_jobs SET status='running', dispatch_attempted=1, version=version+1, updated_at=? WHERE id=? AND version=? AND status='prepared'").run(now, jobId, expectedVersion)
      if (changed.changes !== 1) fail('conflict'); this.#audit(now, 'job-started', jobId, job.grantId, 'running'); return this.#job(jobId)!
    })
  }
  settle(jobId: string, expectedVersion: number, input: IsolationResult, authority?: IsolationControllerAuthority, creationWitness?: CreationWitness): IsolationJob {
    if (!text(jobId) || !safePositive(expectedVersion)) fail('invalid-input'); const value = result(input); if (value.jobId !== jobId || (value.status !== 'unknown' && !value.quiescent)) fail('invalid-input', 'result job id differs or non-unknown result is not quiescent')
    let witness: CreationWitness | undefined
    if (creationWitness !== undefined) {
      try { witness = validateCreationWitness(creationWitness) } catch { fail('invalid-input') }
      if (value.status !== 'unknown' || value.quiescent) fail('invalid-input')
    }
    if (value.reason === 'docker-creation-unconfirmed' && value.quiescent) fail('invalid-input')
    const controller = this.#authority(authority)
    return this.#transaction(() => { const now = this.#nowValue(); this.#requireController(controller, now); const job = this.#job(jobId); if (!job) fail('not-found'); if (job.version !== expectedVersion) fail('conflict', 'job version differs')
      if (witness && !job.dispatchAttempted) fail('invalid-state')
      if (job.dispatchAttempted && value.status === 'unknown' && value.quiescent) fail('invalid-state', 'dispatch requires independent quiescence evidence')
      if (job.status !== 'prepared' && job.status !== 'running') {
        if (job.result && equal(job.result, value)) return job
        const cleanup = !job.dispatchAttempted && job.result?.reason !== 'docker-creation-unconfirmed' && job.status === 'unknown' && job.result?.status === 'unknown' && job.result.quiescent === false && value.status === 'unknown' && value.quiescent === true
          && equal({ ...job.result, quiescent: true }, value)
        if (!cleanup) fail('invalid-state')
        const changed = this.#database.prepare("UPDATE isolation_jobs SET result_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status='unknown'").run(JSON.stringify(value), now, jobId, expectedVersion)
        if (changed.changes !== 1) fail('conflict'); this.#audit(now, 'job-quiesced', jobId, job.grantId, 'unknown'); return this.#job(jobId)!
      }
      const changed = this.#database.prepare('UPDATE isolation_jobs SET status=?, result_json=?, creation_witness_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status IN (\'prepared\',\'running\')').run(value.status, JSON.stringify(value), witness ? JSON.stringify(witness) : null, now, jobId, expectedVersion)
      if (changed.changes !== 1) fail('conflict'); this.#audit(now, 'job-settled', jobId, job.grantId, value.status); return this.#job(jobId)!
    })
  }
  /** Host-only release after exact cleanup; outcome and origin evidence remain immutable. */
  settleReconciledUnknown(jobId: string, expectedVersion: number, proof: {
    original: CreationWitness; current: DaemonWitness; currentBinding?: SystemdBinding; checkedAt: number; cleanup: IsolationCleanupReceipt
  }, authority: IsolationControllerAuthority): IsolationJob {
    if (!text(jobId) || !safePositive(expectedVersion) || !proof || !safeTime(proof.checkedAt)) fail('invalid-input')
    let original: CreationWitness
    let current: DaemonWitness
    try {
      original = validateCreationWitness(proof.original)
      current = validateCreationWitness({ daemon: proof.current, supervisor: proof.current.process,
        ...(proof.currentBinding ? { binding: proof.currentBinding } : {}) }).daemon
    } catch { fail('invalid-input') }
    const controller = this.#authority(authority)
    if (!controller) fail('invalid-input')
    return this.#transaction(() => {
      const now = this.#nowValue()
      this.#requireController(controller, now)
      if (proof.checkedAt > now || now - proof.checkedAt > 5_000) fail('invalid-input', 'cleanup proof expired')
      const job = this.#job(jobId)
      if (!job) fail('not-found')
      if (job.version !== expectedVersion || !equal(job.creationWitness, original)) fail('conflict')
      if (!job.dispatchAttempted || job.status !== 'unknown' || !job.result || job.result.quiescent
        || original.requestsSettled !== true || !processExited(original.supervisor)) fail('invalid-state')
      if (original.daemon.engineId !== current.engineId || original.daemon.dockerPath !== current.dockerPath
        || original.daemon.socketPath !== current.socketPath || original.daemon.pidFile !== current.pidFile) fail('invalid-state')
      if (!sameDaemonWitness(original.daemon, current)) fail('invalid-state', 'daemon generation changed')
      const cleanup = receiptData(proof.cleanup)
      if (!cleanup || cleanup.containerName !== job.containerName || cleanup.dockerPath !== current.dockerPath
        || cleanup.socketPath !== current.socketPath || cleanup.checkedAt > now || now - cleanup.checkedAt > 5_000) fail('invalid-input', 'exact resource cleanup receipt required')
      const mode = 'requests-settled'
      const changed = this.#database.prepare("UPDATE isolation_jobs SET result_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status='unknown'")
        .run(JSON.stringify({ ...job.result, quiescent: true }), now, jobId, expectedVersion)
      if (changed.changes !== 1) fail('conflict')
      this.#audit(now, 'job-quiesced', jobId, job.grantId, JSON.stringify({ mode, checkedAt: proof.checkedAt, original, current, cleanup,
        ...(proof.currentBinding ? { currentBinding: proof.currentBinding } : {}) }))
      return this.#job(jobId)!
    })
  }
  revoke(grantId: string, revision: number, reason: string): void {
    if (!text(grantId) || !safePositive(revision) || !text(reason)) fail('invalid-input')
    this.#transaction(() => { const current = this.#grant(grantId); if (!current) fail('not-found'); if (revision < current.revision) fail('conflict', 'grant revision is stale'); if (revision > current.revision) fail('conflict', 'grant revision is unknown')
      if (!current.revoked) { const now = this.#nowValue(); this.#database.prepare('UPDATE isolation_grants SET revoked=1, revoke_reason=? WHERE id=?').run(reason, grantId); this.#audit(now, 'grant-revoked', null, grantId, reason) }
    })
  }
  claimController(ownerId: string, ttlMs: number): IsolationControllerAuthority {
    if (!text(ownerId) || !safePositive(ttlMs)) fail('invalid-input')
    return this.#transaction(() => { const now = this.#nowValue(); const expiresAt = now + ttlMs; if (!safeTime(expiresAt)) fail('invalid-input'); const current = this.#database.prepare('SELECT owner_id, fence, expires_at FROM isolation_controller WHERE singleton=1').get() as { owner_id: string; fence: number; expires_at: number } | undefined
      if (current && (!safePositive(current.fence) || !safeTime(current.expires_at))) fail('schema')
      if (current && current.expires_at > now && current.owner_id !== ownerId) fail('unauthorized', 'controller is owned by another host')
      const fence = current ? (current.owner_id === ownerId && current.expires_at > now ? current.fence : current.fence + 1) : 1
      if (!safePositive(fence)) fail('schema')
      if (current) this.#database.prepare('UPDATE isolation_controller SET owner_id=?, fence=?, expires_at=? WHERE singleton=1').run(ownerId, fence, expiresAt)
      else this.#database.prepare('INSERT INTO isolation_controller(singleton,owner_id,fence,expires_at) VALUES (1,?,?,?)').run(ownerId, fence, expiresAt)
      this.#audit(now, 'controller-claimed', null, null, `fence:${fence}`); return frozen({ ownerId, fence })
    })
  }
  renewController(authority: IsolationControllerAuthority, ttlMs: number): boolean {
    const controller = this.#authority(authority); if (!controller || !safePositive(ttlMs)) fail('invalid-input')
    return this.#transaction(() => { const now = this.#nowValue(); const expiresAt = now + ttlMs; if (!safeTime(expiresAt)) fail('invalid-input'); const changed = this.#database.prepare('UPDATE isolation_controller SET expires_at=? WHERE singleton=1 AND owner_id=? AND fence=? AND expires_at>?').run(expiresAt, controller.ownerId, controller.fence, now); return changed.changes === 1 })
  }
  releaseController(authority: IsolationControllerAuthority): void {
    const controller = this.#authority(authority); if (!controller) fail('invalid-input')
    this.#transaction(() => { const now = this.#nowValue(); const changed = this.#database.prepare('UPDATE isolation_controller SET expires_at=? WHERE singleton=1 AND owner_id=? AND fence=? AND expires_at>?').run(now, controller.ownerId, controller.fence, now); if (changed.changes === 1) this.#audit(now, 'controller-released', null, null, `fence:${controller.fence}`) })
  }
  hasController(authority: IsolationControllerAuthority): boolean { const controller = this.#authority(authority); if (!controller) return false; const row = this.#database.prepare('SELECT owner_id, fence, expires_at FROM isolation_controller WHERE singleton=1').get() as { owner_id: string; fence: number; expires_at: number } | undefined; return !!row && row.owner_id === controller.ownerId && row.fence === controller.fence && safeTime(row.expires_at) && row.expires_at > this.#nowValue() }
  get(jobId: string): IsolationJob | undefined { if (!text(jobId)) fail('invalid-input'); return this.#job(jobId) }
  recoverable(afterId = ''): IsolationJob[] { return (this.#database.prepare("SELECT * FROM isolation_jobs WHERE id > ? AND (status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0)) ORDER BY id ASC LIMIT 1000").all(afterId) as JobRow[]).map(row => this.#decodeJob(row)).filter(job => job.status === 'prepared' || job.status === 'running' || job.result?.quiescent === false) }
  retentionCandidates(cutoff: number, afterId = '', limit = 16): Array<{ id: string; version: number }> {
    if (!safeTime(cutoff) || typeof afterId !== 'string' || afterId.length > textMaximum || !safePositive(limit) || limit > 1_000) fail('invalid-input')
    const rows = this.#database.prepare("SELECT id, version FROM isolation_jobs WHERE id > ? AND updated_at <= ? AND status IN ('succeeded','failed','cancelled','timed-out') AND result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 1 AND json_extract(result_json, '$.retention') IS NULL ORDER BY id ASC LIMIT ?").all(afterId, cutoff, limit) as Array<{ id: string; version: number }>
    if (!rows.every(row => text(row.id) && safePositive(row.version))) fail('schema')
    return rows.map(row => frozen({ id: row.id, version: row.version }))
  }
  compactResult(id: string, expectedVersion: number, cutoff: number, authority: IsolationControllerAuthority): { changed: boolean; removedBytes: number } {
    if (!text(id) || !safePositive(expectedVersion) || !safeTime(cutoff)) fail('invalid-input')
    const controller = this.#authority(authority); if (!controller) fail('invalid-input')
    return this.#transaction(() => {
      const now = this.#nowValue(); this.#requireController(controller, now)
      const job = this.#job(id)
      if (!job) fail('not-found')
      if (job.version !== expectedVersion) fail('conflict')
      if (job.updatedAt > cutoff || !['succeeded', 'failed', 'cancelled', 'timed-out'].includes(job.status) || !job.result || !job.result.quiescent || job.result.retention) return { changed: false, removedBytes: 0 }
      // Candidate eligibility is based on the job timestamp; pruning itself is deterministic.
      const compacted = pruneResult(job.result, now)
      if (!compacted) return { changed: false, removedBytes: 0 }
      const before = Buffer.byteLength(JSON.stringify(job.result), 'utf8')
      const after = Buffer.byteLength(JSON.stringify(compacted), 'utf8')
      const removedBytes = Math.max(0, before - after)
      const changed = this.#database.prepare("UPDATE isolation_jobs SET result_json=?, version=version+1, updated_at=? WHERE id=? AND version=? AND status IN ('succeeded','failed','cancelled','timed-out')").run(JSON.stringify(compacted), now, id, expectedVersion)
      if (changed.changes !== 1) fail('conflict')
      this.#audit(now, 'job-result-pruned', id, job.grantId, JSON.stringify({ original: compacted.retention!.original, prunedAt: compacted.retention!.prunedAt, version: expectedVersion }))
      return { changed: true, removedBytes }
    })
  }
  storageStats(): { jobRecords: number; reusableBytes: number; activeReservedBytes: number; legacyActiveJobs: number } {
    const counts = this.#database.prepare("SELECT COUNT(*) AS jobRecords, COALESCE(SUM(CASE WHEN status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0) THEN reserved_storage_bytes ELSE 0 END), 0) AS activeReservedBytes, COUNT(CASE WHEN (status IN ('prepared','running') OR (result_json IS NOT NULL AND json_extract(result_json, '$.quiescent') = 0)) AND reserved_storage_bytes = 0 THEN 1 END) AS legacyActiveJobs FROM isolation_jobs").get() as { jobRecords: number; activeReservedBytes: number; legacyActiveJobs: number }
    const pages = this.#database.prepare('PRAGMA page_size').get() as { page_size: number }
    const free = this.#database.prepare('PRAGMA freelist_count').get() as { freelist_count: number }
    if (!safeTime(counts.jobRecords) || !safeTime(counts.activeReservedBytes) || !safeTime(counts.legacyActiveJobs) || !safePositive(pages.page_size) || !safeTime(free.freelist_count) || free.freelist_count > Math.floor(Number.MAX_SAFE_INTEGER / pages.page_size)) fail('schema')
    return frozen({ jobRecords: counts.jobRecords, reusableBytes: free.freelist_count * pages.page_size, activeReservedBytes: counts.activeReservedBytes, legacyActiveJobs: counts.legacyActiveJobs })
  }
  maintainStorage(authority: IsolationControllerAuthority): { checkpoint: 'complete' | 'busy'; reclaimMode: 'incremental' | 'page-reuse' } {
    const controller = this.#authority(authority); if (!controller) fail('invalid-input')
    const now = this.#nowValue(); this.#requireController(controller, now)
    const auto = this.#database.prepare('PRAGMA auto_vacuum').get() as { auto_vacuum: number }
    if (auto.auto_vacuum !== 0 && auto.auto_vacuum !== 2) fail('schema')
    let checkpoint: 'complete' | 'busy' = 'complete'
    try {
      this.#database.exec('PRAGMA busy_timeout = 0')
      const initial = this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
      if (!initial || initial.busy !== 0) checkpoint = 'busy'
      else if (auto.auto_vacuum === 2) {
        this.#database.exec('PRAGMA incremental_vacuum(64)')
        const final = this.#database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy?: number } | undefined
        if (!final || final.busy !== 0) checkpoint = 'busy'
      }
    } finally { this.#database.exec('PRAGMA busy_timeout = 5000') }
    this.#requireController(controller, this.#nowValue())
    return frozen({ checkpoint, reclaimMode: auto.auto_vacuum === 2 ? 'incremental' : 'page-reuse' })
  }
  /** Newer declared output attempts mask older success, including failed/unknown attempts. */
  acceptedArtifactJob(contractId: string, contractDigest: string, path: string): IsolationJob | undefined {
    if (!text(contractId) || !/^[0-9a-f]{64}$/.test(contractDigest) || !text(path, 4096)) fail('invalid-input')
    const row = this.#database.prepare("SELECT * FROM isolation_jobs WHERE artifact_binding_json IS NOT NULL AND json_extract(artifact_binding_json, '$.admission.contractId')=? AND EXISTS (SELECT 1 FROM json_each(artifact_binding_json, '$.paths') WHERE value=?) ORDER BY rowid DESC LIMIT 1").get(contractId, path) as JobRow | undefined
    if (!row) return undefined
    const job = this.#decodeJob(row)
    if (job.artifactBinding?.admission.contractDigest !== contractDigest) fail('conflict', 'artifact contract digest differs')
    return job
  }

  /** Read-only current grant check for the exact native tool preauthorization. */
  permitsGrant(value: IsolationIdentity, grantId: string): boolean {
    const requested = identity(value)
    const current = this.#grant(grantId)
    return !!current && current.revoked === 0 && current.expires_at > this.#nowValue()
      && current.principal_digest === requested.principalDigest && current.principal_record_id === requested.principalRecordId
      && current.principal_version === requested.principalVersion && current.workspace === requested.workspace
      && current.agent_preset === requested.agentPreset
  }
  usable(jobId: string): boolean { const job = this.#job(jobId); if (!job || !['prepared', 'running'].includes(job.status) || job.deadline <= this.#nowValue()) return false; const current = this.#grant(job.grantId); return !!current && !current.revoked && current.revision === job.grantRevision && current.expires_at > this.#nowValue() && current.principal_digest === job.identity.principalDigest && current.principal_record_id === job.identity.principalRecordId && current.principal_version === job.identity.principalVersion && current.workspace === job.identity.workspace && current.agent_preset === job.identity.agentPreset }
  close(): void { this.#database.close() }
}
