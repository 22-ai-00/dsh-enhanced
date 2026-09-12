import { createHash } from 'node:crypto'
import { chmodSync, closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { basename, dirname, isAbsolute, normalize } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  brokerGrantAuthorityDigest,
  brokerRequestDigest,
  canonicalBrokerJson,
  createBrokerGrantProjection,
  normalizeBrokerGrantAuthority,
  type BrokerClientRequest,
  type BrokerGrantProjection,
  type BrokerGrantAuthorityUnsigned,
  type BrokerSuccessResult,
} from './broker-protocol.js'

const SCHEMA_VERSION = 1
const MAX_RECORDS = 10_000
const MAX_GRANTS = 1_000
const DIGEST = /^[0-9a-f]{64}$/u

export type BrokerTerminalStatus = 'succeeded' | 'failed' | 'unknown'
export type BrokerRequestStatus = 'prepared' | 'dispatched' | BrokerTerminalStatus
export type BrokerInspectKind = 'repository' | 'branch' | 'file' | 'pull-request' | 'checks' | 'reviews'

export interface ExternalGitHubGrant extends BrokerGrantAuthorityUnsigned {
  digest: string
}

export type ExternalGitHubGrantUnsigned = Omit<ExternalGitHubGrant, 'digest'>
export type ExternalGrantMirror = BrokerGrantProjection
export interface BrokerAuthority { ownerId: string; fence: number; generation: number }
export interface BrokerLedgerOutcome {
  status: BrokerTerminalStatus
  dispatched: boolean
  result: BrokerSuccessResult | null
  error: { code: string } | null
  completedAt: number
}
export interface BrokerLedgerRecord {
  actionId: string
  requestId: string
  clientKeyId: string
  owner: BrokerClientRequest['owner']
  sessionId: string
  agentId: string
  rootCallId: string
  callId: string
  grantId: string
  grantRevision: number
  grantDigest: string
  requestDigest: string
  operation: 'commit' | 'inspect'
  repository: string
  branch: string
  expectedHeadOid: string | null
  payloadDigest: string
  budgetReservationId: string
  bytes: number
  costUnits: number
  deadline: number
  policyEpoch: number
  emergencyEpoch: number
  generation: number
  status: BrokerRequestStatus
  version: number
  outcome?: BrokerLedgerOutcome
}
export interface BrokerControlSnapshot {
  instanceId: string
  generation: number
  controlVersion: number
  policyEpoch: number
  emergencyEpoch: number
  stopped: boolean
  draining: boolean
}
export interface BrokerControlMutation extends BrokerControlSnapshot { abortActionIds: readonly string[] }
export type BrokerAdminMutation =
  | { operation: 'stop'; expectedControlVersion: number; reason: string }
  | { operation: 'resume'; expectedControlVersion: number; expectedGeneration: number; reason: string }
  | { operation: 'revoke'; expectedControlVersion: number; grantId: string; grantRevision: number; grantDigest: string; policyEpoch: number; emergencyEpoch: number; reason: string }

export class BrokerLedgerError extends Error {
  constructor(readonly code: 'invalid-input' | 'unsafe-file' | 'schema' | 'controller' | 'conflict' | 'limit' | 'grant' | 'state' | 'stopped') {
    super('assistant-actions external broker ledger rejected: ' + code)
    this.name = 'BrokerLedgerError'
  }
}

type MetaRow = { instance_id: string; generation: number; controller_fence: number; control_version: number; policy_epoch: number; emergency_epoch: number; stopped: number; draining: number }
type GrantRow = { id: string; revision: number; digest: string; grant_json: string; revoked: number; created_at: number }
type RequestRow = {
  action_id: string; request_id: string; client_key_id: string; owner_json: string; session_id: string; agent_id: string; root_call_id: string; call_id: string; grant_id: string; grant_revision: number; grant_digest: string
  request_digest: string; operation: string; repository: string; branch: string; expected_head_oid: string | null; payload_digest: string; budget_reservation_id: string; bytes: number; cost_units: number
  deadline: number; policy_epoch: number; emergency_epoch: number; generation: number; status: string; version: number; dispatched_at: number | null; result_json: string | null
}
type CredentialLeaseRow = { action_id: string; credential_id: string; purpose: string; status: string; issued_at: number; expires_at: number; settled_at: number | null; version: number }
type AdminNonceRow = { admin_key_id: string; nonce_digest: string; request_digest: string; expires_at: number }

function fail(code: BrokerLedgerError['code']): never { throw new BrokerLedgerError(code) }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!plain(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(value, key))) fail('invalid-input')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-input')
  return value
}
function text(value: unknown, maximum = 4_096): string { if (typeof value !== 'string' || value.length < 1 || value.length > maximum || /[\p{Cc}]/u.test(value)) fail('invalid-input'); return value }
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid-input'); return value }
function digest(value: unknown): string { const output = text(value, 64); if (!DIGEST.test(output)) fail('invalid-input'); return output }
function json(value: string): unknown { try { return JSON.parse(value) } catch { return fail('schema') } }
function equal(left: unknown, right: unknown): boolean { return canonicalBrokerJson(left) === canonicalBrokerJson(right) }

function owner(value: unknown): ExternalGitHubGrant['owner'] {
  const input = exact(value, ['principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'preset', 'bindingId', 'bindingVersion', 'bindingGeneration'])
  const workspace = text(input.workspace)
  if (!isAbsolute(workspace) || normalize(workspace) !== workspace) fail('invalid-input')
  return Object.freeze({ principalDigest: digest(input.principalDigest), principalRecordId: text(input.principalRecordId), principalVersion: integer(input.principalVersion, 1), workspace, preset: text(input.preset), bindingId: text(input.bindingId), bindingVersion: integer(input.bindingVersion, 1), bindingGeneration: integer(input.bindingGeneration, 1) })
}
function normalizeGrantUnsigned(value: unknown): ExternalGitHubGrantUnsigned {
  try {
    const grant = normalizeBrokerGrantAuthority(value)
    // v1 has no base-branch authority, so PR/check/review reads cannot be
    // scoped with the existing GitHub transport and are rejected at config
    // admission, never after a durable dispatch.
    if (grant.allowedInspectKinds.some(kind => !['repository', 'branch', 'file'].includes(kind))) fail('invalid-input')
    return grant
  } catch { return fail('invalid-input') }
}
export function externalGrantMirror(grant: ExternalGitHubGrantUnsigned): ExternalGrantMirror {
  return createBrokerGrantProjection(normalizeGrantUnsigned(grant))
}
export function brokerGrantDigest(grant: ExternalGitHubGrantUnsigned): string { return brokerGrantAuthorityDigest(normalizeGrantUnsigned(grant) as BrokerGrantAuthorityUnsigned) }
export function withBrokerGrantDigest(grant: ExternalGitHubGrantUnsigned): ExternalGitHubGrant { const normalized = normalizeGrantUnsigned(grant); return Object.freeze({ ...normalized, digest: brokerGrantDigest(normalized) }) }
export function normalizeBrokerGrant(value: unknown): ExternalGitHubGrant {
  const input = exact(value, ['protocol', 'id', 'revision', 'digest', 'clientKeyId', 'owner', 'sessionId', 'destination', 'credentialId', 'expiresAt', 'maxActions', 'maxTotalBytes', 'maxCostUnits', 'allowedOperations', 'allowedInspectKinds', 'client', 'source', 'policyEpoch', 'emergencyEpoch'])
  const { digest: claimed, ...unsigned } = input
  const normalized = normalizeGrantUnsigned(unsigned)
  const expected = brokerGrantDigest(normalized)
  if (digest(claimed) !== expected) fail('invalid-input')
  return Object.freeze({ ...normalized, digest: expected })
}

function sameNode(left: BigIntStats, right: BigIntStats): boolean { return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink }
function safeAncestorChain(value: string, uid: number, gid: number): void {
  let cursor = value, leaf = true
  for (;;) {
    const stat = lstatSync(cursor, { bigint: true }), mode = Number(stat.mode & 0o7777n), owner = Number(stat.uid), group = Number(stat.gid)
    const stickyRoot = owner === 0 && (mode & 0o1000) !== 0 && (mode & 0o022) !== 0
    if (realpathSync(cursor) !== cursor || stat.isSymbolicLink() || !stat.isDirectory() || !stickyRoot && (mode & 0o022) !== 0
      || leaf && (owner !== uid || group !== gid || mode !== 0o700)) fail('unsafe-file')
    const parent = dirname(cursor); if (parent === cursor) return
    cursor = parent; leaf = false
  }
}
function privateFile(value: string): void { const stat = lstatSync(value, { bigint: true }); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || Number(stat.mode & 0o7777n) !== 0o600 || (process.geteuid?.() !== undefined && stat.uid !== BigInt(process.geteuid()))) fail('unsafe-file') }
function exists(value: string): boolean { try { lstatSync(value); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } }
interface PinnedDatabasePath { sqlitePath: string; parentDescriptor: number; fileDescriptor: number; parent: BigIntStats; file: BigIntStats }
function prepareDatabasePath(value: string): PinnedDatabasePath {
  if (!isAbsolute(value) || normalize(value) !== value) fail('unsafe-file')
  const uid = process.geteuid?.(), gid = process.getegid?.()
  if (process.platform !== 'linux' || uid === undefined || gid === undefined) fail('unsafe-file')
  const parentPath = dirname(value); safeAncestorChain(parentPath, uid, gid)
  let parentDescriptor: number | undefined, fileDescriptor: number | undefined
  try {
    parentDescriptor = openSync(parentPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const parent = fstatSync(parentDescriptor, { bigint: true }), visibleParent = lstatSync(parentPath, { bigint: true })
    if (!parent.isDirectory() || !sameNode(parent, visibleParent)) fail('unsafe-file')
    const anchored = "/proc/self/fd/" + parentDescriptor + "/" + basename(value)
    if (!exists(value)) { const created = openSync(anchored, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(created) }
    fileDescriptor = openSync(anchored, constants.O_RDWR | constants.O_NOFOLLOW)
    const file = fstatSync(fileDescriptor, { bigint: true }), visibleFile = lstatSync(value, { bigint: true })
    if (!file.isFile() || file.nlink !== 1n || Number(file.mode & 0o7777n) !== 0o600 || file.uid !== BigInt(uid) || !sameNode(file, visibleFile)) fail('unsafe-file')
    return { sqlitePath: anchored, parentDescriptor, fileDescriptor, parent, file }
  } catch (error) { if (fileDescriptor !== undefined) closeSync(fileDescriptor); if (parentDescriptor !== undefined) closeSync(parentDescriptor); throw error }
}
function pinnedPathMatches(databasePath: string, pinned: PinnedDatabasePath): boolean {
  try {
    const parent = fstatSync(pinned.parentDescriptor, { bigint: true }), visibleParent = lstatSync(dirname(databasePath), { bigint: true })
    const file = fstatSync(pinned.fileDescriptor, { bigint: true }), visibleFile = lstatSync(databasePath, { bigint: true })
    return sameNode(parent, pinned.parent) && sameNode(parent, visibleParent) && sameNode(file, pinned.file) && sameNode(file, visibleFile)
  } catch { return false }
}
interface OpenedDatabase { database: DatabaseSync; parentDescriptor?: number }
function openDatabase(databasePath: string, instanceId: string, beforeOpen?: () => void): OpenedDatabase {
  const pinned = databasePath === ':memory:' ? undefined : prepareDatabasePath(databasePath)
  let database: DatabaseSync | undefined
  try {
    beforeOpen?.()
    database = new DatabaseSync(pinned?.sqlitePath ?? databasePath, { enableForeignKeyConstraints: true })
    if (pinned && !pinnedPathMatches(databasePath, pinned)) fail('unsafe-file')
    database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 0) {
      database.exec([
        'BEGIN IMMEDIATE',
        'CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance_id TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>=0), controller_fence INTEGER NOT NULL CHECK(controller_fence>=0), control_version INTEGER NOT NULL CHECK(control_version>=0), policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=0), emergency_epoch INTEGER NOT NULL CHECK(emergency_epoch>=0), stopped INTEGER NOT NULL CHECK(stopped IN (0,1)), draining INTEGER NOT NULL CHECK(draining IN (0,1))) STRICT',
        'CREATE TABLE controller (singleton INTEGER PRIMARY KEY CHECK(singleton=1), owner_id TEXT NOT NULL, fence INTEGER NOT NULL CHECK(fence>=1), generation INTEGER NOT NULL CHECK(generation>=1), expires_at INTEGER NOT NULL CHECK(expires_at>=0)) STRICT',
        'CREATE TABLE grants (id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1), digest TEXT NOT NULL, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), created_at INTEGER NOT NULL CHECK(created_at>=0), PRIMARY KEY(id,revision), UNIQUE(digest)) STRICT, WITHOUT ROWID',
        'CREATE TABLE grant_heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)), FOREIGN KEY(id,revision) REFERENCES grants(id,revision)) STRICT',
        "CREATE TABLE requests (action_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, client_key_id TEXT NOT NULL, owner_json TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT NOT NULL, root_call_id TEXT NOT NULL, call_id TEXT NOT NULL, grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, grant_digest TEXT NOT NULL, request_digest TEXT NOT NULL, operation TEXT NOT NULL CHECK(operation IN ('commit','inspect')), repository TEXT NOT NULL, branch TEXT NOT NULL, expected_head_oid TEXT, payload_digest TEXT NOT NULL, budget_reservation_id TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0), cost_units INTEGER NOT NULL CHECK(cost_units>=0), deadline INTEGER NOT NULL CHECK(deadline>=1), policy_epoch INTEGER NOT NULL CHECK(policy_epoch>=0), emergency_epoch INTEGER NOT NULL CHECK(emergency_epoch>=0), generation INTEGER NOT NULL CHECK(generation>=1), status TEXT NOT NULL CHECK(status IN ('prepared','dispatched','succeeded','failed','unknown')), version INTEGER NOT NULL CHECK(version>=1), dispatched_at INTEGER, result_json TEXT, UNIQUE(client_key_id,request_id), UNIQUE(client_key_id,action_id), UNIQUE(client_key_id,budget_reservation_id), FOREIGN KEY(grant_id,grant_revision) REFERENCES grants(id,revision), CHECK((status IN ('prepared','dispatched') AND result_json IS NULL) OR (status IN ('succeeded','failed','unknown') AND result_json IS NOT NULL)), CHECK((status='prepared' AND dispatched_at IS NULL) OR status!='prepared')) STRICT",
        "CREATE TABLE credential_leases (action_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK(purpose IN ('github.commit','github.inspect')), status TEXT NOT NULL CHECK(status IN ('active','completed','failed','revoked')), issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, settled_at INTEGER, version INTEGER NOT NULL, FOREIGN KEY(action_id) REFERENCES requests(action_id), CHECK((status='active' AND settled_at IS NULL) OR (status!='active' AND settled_at IS NOT NULL))) STRICT",
        'CREATE TABLE admin_nonces (admin_key_id TEXT NOT NULL, nonce_digest TEXT NOT NULL, request_digest TEXT NOT NULL, expires_at INTEGER NOT NULL CHECK(expires_at>=1), PRIMARY KEY(admin_key_id,nonce_digest)) STRICT, WITHOUT ROWID',
        'CREATE TABLE audit (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER, recorded_at INTEGER NOT NULL, previous_digest TEXT NOT NULL, digest TEXT NOT NULL UNIQUE) STRICT',
        'CREATE INDEX requests_grant_budget ON requests(grant_id,dispatched_at,status)',
        'CREATE INDEX requests_status ON requests(status)',
      ].join(';'))
      database.prepare('INSERT INTO meta VALUES(1,?,0,0,0,0,0,0,0)').run(instanceId)
      database.exec('PRAGMA user_version=1; COMMIT')
    }
    if (version !== 0 && version !== SCHEMA_VERSION) fail('schema')
    const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    if (!equal(tables, ['admin_nonces', 'audit', 'controller', 'credential_leases', 'grant_heads', 'grants', 'meta', 'requests'])) fail('schema')
    const schemas = database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ sql: string }>
    if (!schemas.every(row => /\bSTRICT\b/u.test(row.sql))) fail('schema')
    const expectedColumns: Readonly<Record<string, readonly string[]>> = {
      admin_nonces: ['admin_key_id', 'nonce_digest', 'request_digest', 'expires_at'],
      audit: ['sequence', 'kind', 'subject_id', 'revision', 'recorded_at', 'previous_digest', 'digest'],
      controller: ['singleton', 'owner_id', 'fence', 'generation', 'expires_at'],
      credential_leases: ['action_id', 'credential_id', 'purpose', 'status', 'issued_at', 'expires_at', 'settled_at', 'version'],
      grant_heads: ['id', 'revision', 'revoked'], grants: ['id', 'revision', 'digest', 'grant_json', 'revoked', 'created_at'],
      meta: ['singleton', 'instance_id', 'generation', 'controller_fence', 'control_version', 'policy_epoch', 'emergency_epoch', 'stopped', 'draining'],
      requests: ['action_id', 'request_id', 'client_key_id', 'owner_json', 'session_id', 'agent_id', 'root_call_id', 'call_id', 'grant_id', 'grant_revision', 'grant_digest', 'request_digest', 'operation', 'repository', 'branch', 'expected_head_oid', 'payload_digest', 'budget_reservation_id', 'bytes', 'cost_units', 'deadline', 'policy_epoch', 'emergency_epoch', 'generation', 'status', 'version', 'dispatched_at', 'result_json'],
    }
    for (const [table, expected] of Object.entries(expectedColumns)) {
      const columns = (database.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(table) as Array<{ name: string }>).map(row => row.name)
      if (!equal(columns, expected)) fail('schema')
    }
    const indexes = (database.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    if (!indexes.includes('requests_grant_budget') || !indexes.includes('requests_status')) fail('schema')
    if ((database.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check !== 'ok') fail('schema')
    if (databasePath !== ':memory:') {
      if (!pinned || !pinnedPathMatches(databasePath, pinned)) fail('unsafe-file')
      privateFile(databasePath)
      for (const suffix of ['-wal', '-shm']) if (exists(databasePath + suffix)) {
        const anchored = pinned.sqlitePath + suffix
        chmodSync(anchored, 0o600); privateFile(databasePath + suffix)
        const anchoredStat = lstatSync(anchored, { bigint: true }), visibleStat = lstatSync(databasePath + suffix, { bigint: true })
        if (!sameNode(anchoredStat, visibleStat)) fail('unsafe-file')
      }
      safeAncestorChain(dirname(databasePath), Number(pinned.parent.uid), Number(pinned.parent.gid))
      if (!pinnedPathMatches(databasePath, pinned)) fail('unsafe-file')
      closeSync(pinned.fileDescriptor)
    }
    return { database, ...(pinned ? { parentDescriptor: pinned.parentDescriptor } : {}) }
  } catch (error) { database?.close(); if (pinned) { try { closeSync(pinned.fileDescriptor) } catch {}; try { closeSync(pinned.parentDescriptor) } catch {} } throw error }
}

export function brokerPayloadBytes(request: BrokerClientRequest): number { return Buffer.byteLength(canonicalBrokerJson(request.payload), 'utf8') }
export const brokerLedgerRequestDigest = brokerRequestDigest
function outcome(value: unknown, record?: Pick<BrokerLedgerRecord, 'operation' | 'repository' | 'branch' | 'expectedHeadOid'>): BrokerLedgerOutcome {
  const input = exact(value, ['status', 'dispatched', 'result', 'error', 'completedAt'])
  if (!['succeeded', 'failed', 'unknown'].includes(String(input.status)) || typeof input.dispatched !== 'boolean') fail('invalid-input')
  const status = input.status as BrokerTerminalStatus
  if (status === 'succeeded') {
    if (!input.dispatched || input.error !== null || !plain(input.result)) fail('invalid-input')
    if (record && (input.result.operation !== record.operation || input.result.repository !== record.repository || input.result.branch !== record.branch || record.operation === 'commit' && input.result.parentOid !== record.expectedHeadOid)) fail('state')
  } else {
    if (input.result !== null || !plain(input.error) || Object.keys(input.error).length !== 1 || typeof input.error.code !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/u.test(input.error.code)) fail('invalid-input')
    if (status === 'unknown' && !input.dispatched) fail('invalid-input')
  }
  return Object.freeze({ status, dispatched: input.dispatched, result: input.result as BrokerSuccessResult | null, error: input.error as { code: string } | null, completedAt: integer(input.completedAt, 1) })
}

export class ExternalBrokerLedger {
  readonly #database: DatabaseSync
  readonly #parentDescriptor: number | undefined
  readonly #now: () => number
  #closed = false
  constructor(databasePath: string, instanceId: string, options: { now?: () => number; beforeDatabaseOpen?: () => void } = {}) {
    text(instanceId, 128)
    if (!plain(options) || Object.keys(options).some(key => !['now', 'beforeDatabaseOpen'].includes(key)) || options.now !== undefined && typeof options.now !== 'function' || options.beforeDatabaseOpen !== undefined && typeof options.beforeDatabaseOpen !== 'function') fail('invalid-input')
    this.#now = options.now ?? Date.now
    const opened = openDatabase(databasePath, instanceId, options.beforeDatabaseOpen)
    this.#database = opened.database; this.#parentDescriptor = opened.parentDescriptor
    try { this.#validateStored(instanceId) } catch (error) { this.#database.close(); if (this.#parentDescriptor !== undefined) closeSync(this.#parentDescriptor); throw error }
  }
  #time(): number { return integer(this.#now()) }
  #meta(): MetaRow { const row = this.#database.prepare('SELECT * FROM meta WHERE singleton=1').get() as MetaRow | undefined; if (!row) fail('schema'); this.#validateMeta(row); return row }
  #validateMeta(row: MetaRow): void { text(row.instance_id, 128); integer(row.generation); integer(row.controller_fence); integer(row.control_version); integer(row.policy_epoch); integer(row.emergency_epoch); if (![0, 1].includes(row.stopped) || ![0, 1].includes(row.draining)) fail('schema') }
  #authority(value: BrokerAuthority, now = this.#time()): BrokerAuthority {
    if (!plain(value) || Object.keys(value).length !== 3) fail('invalid-input')
    const ownerId = text(value.ownerId); const fence = integer(value.fence, 1); const generation = integer(value.generation, 1)
    const row = this.#database.prepare('SELECT owner_id,fence,generation,expires_at FROM controller WHERE singleton=1').get() as { owner_id: string; fence: number; generation: number; expires_at: number } | undefined
    if (!row || row.owner_id !== ownerId || row.fence !== fence || row.generation !== generation || row.expires_at <= now || this.#meta().generation !== generation) fail('controller')
    return Object.freeze({ ownerId, fence, generation })
  }
  #grant(row: GrantRow): ExternalGitHubGrant { try { const grant = normalizeBrokerGrant(json(row.grant_json)); if (grant.id !== row.id || grant.revision !== row.revision || grant.digest !== row.digest || ![0, 1].includes(row.revoked) || !Number.isSafeInteger(row.created_at)) fail('schema'); return grant } catch { return fail('schema') } }
  #head(id: string): (GrantRow & { head_revoked: number }) | undefined { const row = this.#database.prepare('SELECT g.*,h.revoked AS head_revoked FROM grant_heads h JOIN grants g ON g.id=h.id AND g.revision=h.revision WHERE h.id=?').get(id) as (GrantRow & { head_revoked: number }) | undefined; if (row && row.revoked !== row.head_revoked) fail('schema'); return row }
  #row(row: RequestRow): BrokerLedgerRecord {
    try {
      const status = row.status as BrokerRequestStatus
      if (!['prepared', 'dispatched', 'succeeded', 'failed', 'unknown'].includes(status)) fail('schema')
      const terminal = ['succeeded', 'failed', 'unknown'].includes(status)
      if (terminal !== (row.result_json !== null) || status === 'prepared' && row.dispatched_at !== null || status === 'dispatched' && row.dispatched_at === null) fail('schema')
      const record: BrokerLedgerRecord = { actionId: text(row.action_id), requestId: text(row.request_id), clientKeyId: text(row.client_key_id), owner: owner(json(row.owner_json)), sessionId: text(row.session_id), agentId: text(row.agent_id), rootCallId: text(row.root_call_id), callId: text(row.call_id), grantId: text(row.grant_id), grantRevision: integer(row.grant_revision, 1), grantDigest: digest(row.grant_digest), requestDigest: digest(row.request_digest), operation: row.operation as 'commit' | 'inspect', repository: text(row.repository), branch: text(row.branch), expectedHeadOid: row.expected_head_oid, payloadDigest: digest(row.payload_digest), budgetReservationId: text(row.budget_reservation_id), bytes: integer(row.bytes), costUnits: integer(row.cost_units), deadline: integer(row.deadline, 1), policyEpoch: integer(row.policy_epoch), emergencyEpoch: integer(row.emergency_epoch), generation: integer(row.generation, 1), status, version: integer(row.version, 1) }
      if (!['commit', 'inspect'].includes(record.operation) || (record.operation === 'commit') !== (record.expectedHeadOid !== null) || record.expectedHeadOid !== null && !/^[0-9a-f]{40,128}$/u.test(record.expectedHeadOid)) fail('schema')
      const grantRow = this.#database.prepare('SELECT * FROM grants WHERE id=? AND revision=?').get(record.grantId, record.grantRevision) as GrantRow | undefined
      if (!grantRow) fail('schema')
      const grant = this.#grant(grantRow)
      if (grant.digest !== record.grantDigest || grant.clientKeyId !== record.clientKeyId || !equal(grant.owner, record.owner) || grant.sessionId !== record.sessionId || grant.destination.repository !== record.repository || grant.destination.branch !== record.branch || grant.policyEpoch !== record.policyEpoch || grant.emergencyEpoch !== record.emergencyEpoch) fail('schema')
      if (terminal) {
        record.outcome = outcome(json(row.result_json!), record)
        if (record.outcome.dispatched !== (row.dispatched_at !== null)) fail('schema')
      }
      return Object.freeze(record)
    } catch { return fail('schema') }
  }
  #audit(kind: string, subjectId: string, revision: number | null, now: number): void {
    const previous = (this.#database.prepare('SELECT digest FROM audit ORDER BY sequence DESC LIMIT 1').get() as { digest: string } | undefined)?.digest ?? '0'.repeat(64)
    const sequence = (this.#database.prepare('SELECT COALESCE(MAX(sequence),0)+1 AS value FROM audit').get() as { value: number }).value
    const next = createHash('sha256').update(canonicalBrokerJson({ sequence, kind, subjectId, revision, recordedAt: now, previous })).digest('hex')
    this.#database.prepare('INSERT INTO audit(sequence,kind,subject_id,revision,recorded_at,previous_digest,digest) VALUES(?,?,?,?,?,?,?)').run(sequence, kind, subjectId, revision, now, previous, next)
  }
  #validateStored(instanceId: string): void {
    try {
      const meta = this.#meta(); if (meta.instance_id !== instanceId) fail('schema')
      const grants = this.#database.prepare('SELECT * FROM grants').all() as GrantRow[]; if (grants.length > MAX_GRANTS) fail('schema'); for (const grant of grants) this.#grant(grant)
      const heads = (this.#database.prepare('SELECT COUNT(*) AS count FROM grant_heads').get() as { count: number }).count
      const joined = this.#database.prepare('SELECT g.*,h.revoked AS head_revoked FROM grant_heads h JOIN grants g ON g.id=h.id AND g.revision=h.revision').all() as Array<GrantRow & { head_revoked: number }>
      if (heads !== joined.length || joined.some(row => row.revoked !== row.head_revoked)) fail('schema')
      const rows = this.#database.prepare('SELECT * FROM requests LIMIT 10001').all() as RequestRow[]; if (rows.length > MAX_RECORDS) fail('schema'); for (const row of rows) this.#row(row)
      const controllers = this.#database.prepare('SELECT owner_id,fence,generation,expires_at FROM controller').all() as Array<{ owner_id: unknown; fence: unknown; generation: unknown; expires_at: unknown }>
      if (controllers.length > 1) fail('schema')
      for (const controller of controllers) { text(controller.owner_id); integer(controller.fence, 1); integer(controller.generation, 1); integer(controller.expires_at) }
      const leases = this.#database.prepare('SELECT * FROM credential_leases').all() as CredentialLeaseRow[]
      for (const lease of leases) {
        const action = rows.find(row => row.action_id === text(lease.action_id)); if (!action || text(lease.credential_id, 128) !== this.#grant(this.#database.prepare('SELECT * FROM grants WHERE id=? AND revision=?').get(action.grant_id, action.grant_revision) as GrantRow).credentialId) fail('schema')
        if (!['github.commit', 'github.inspect'].includes(lease.purpose) || lease.purpose !== (action.operation === 'commit' ? 'github.commit' : 'github.inspect') || !['active', 'completed', 'failed', 'revoked'].includes(lease.status)) fail('schema')
        const issuedAt = integer(lease.issued_at); const expiresAt = integer(lease.expires_at, 1); integer(lease.version, 1)
        if (expiresAt <= issuedAt || (lease.status === 'active') !== (lease.settled_at === null) || lease.status === 'active' && action.status !== 'dispatched' || lease.status === 'completed' && action.status !== 'succeeded') fail('schema')
        if (lease.settled_at !== null) integer(lease.settled_at)
      }
      const nonces = this.#database.prepare('SELECT * FROM admin_nonces').all() as AdminNonceRow[]
      for (const nonce of nonces) { text(nonce.admin_key_id, 128); digest(nonce.nonce_digest); digest(nonce.request_digest); integer(nonce.expires_at, 1) }
      const audits = this.#database.prepare('SELECT * FROM audit ORDER BY sequence').all() as Array<{ sequence: number; kind: string; subject_id: string; revision: number | null; recorded_at: number; previous_digest: string; digest: string }>
      let previous = '0'.repeat(64)
      for (let index = 0; index < audits.length; index++) { const item = audits[index]!; const expected = createHash('sha256').update(canonicalBrokerJson({ sequence: item.sequence, kind: item.kind, subjectId: item.subject_id, revision: item.revision, recordedAt: item.recorded_at, previous })).digest('hex'); if (item.sequence !== index + 1 || item.previous_digest !== previous || item.digest !== expected) fail('schema'); previous = item.digest }
    } catch { fail('schema') }
  }
  #snapshot(meta = this.#meta()): BrokerControlSnapshot { return Object.freeze({ instanceId: meta.instance_id, generation: meta.generation, controlVersion: meta.control_version, policyEpoch: meta.policy_epoch, emergencyEpoch: meta.emergency_epoch, stopped: meta.stopped === 1, draining: meta.draining === 1 }) }

  claimController(ownerId: string, ttlMs = 30_000): BrokerAuthority {
    const ownerIdValue = text(ownerId); const ttl = integer(ttlMs, 1, 300_000); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database.prepare('SELECT * FROM controller WHERE singleton=1').get() as { owner_id: string; fence: number; generation: number; expires_at: number } | undefined
      if (current && current.expires_at > now) fail('controller')
      const meta = this.#meta(); const fence = integer(meta.controller_fence + 1, 1); const generation = integer(meta.generation + 1, 1)
      this.#database.prepare('UPDATE meta SET generation=?,controller_fence=?,draining=0 WHERE singleton=1').run(generation, fence)
      this.#database.prepare('INSERT INTO controller VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET owner_id=excluded.owner_id,fence=excluded.fence,generation=excluded.generation,expires_at=excluded.expires_at').run(ownerIdValue, fence, generation, now + ttl)
      this.#recoverRows(now); this.#audit('controller-claimed', ownerIdValue, fence, now); this.#database.exec('COMMIT')
      return Object.freeze({ ownerId: ownerIdValue, fence, generation })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  renewController(authority: BrokerAuthority, ttlMs = 30_000): void { const now = this.#time(); const current = this.#authority(authority, now); const changed = this.#database.prepare('UPDATE controller SET expires_at=? WHERE singleton=1 AND owner_id=? AND fence=? AND generation=? AND expires_at>?').run(now + integer(ttlMs, 1, 300_000), current.ownerId, current.fence, current.generation, now); if (changed.changes !== 1) fail('controller') }
  hasController(authority: BrokerAuthority): boolean { try { this.#authority(authority); return true } catch { return false } }
  releaseController(authority: BrokerAuthority): void { const current = this.#authority(authority); this.#database.prepare('DELETE FROM controller WHERE singleton=1 AND owner_id=? AND fence=? AND generation=?').run(current.ownerId, current.fence, current.generation) }
  #recoverRows(now: number): void {
    const rows = this.#database.prepare("SELECT * FROM requests WHERE status IN ('prepared','dispatched')").all() as RequestRow[]
    for (const row of rows) this.#terminalize(row, now, row.status === 'dispatched' ? 'restart-after-dispatch' : 'restart-before-dispatch')
    this.#database.prepare("UPDATE credential_leases SET status='revoked',settled_at=?,version=version+1 WHERE status='active'").run(now)
  }

  syncGrants(values: readonly ExternalGitHubGrant[], policyEpoch: number, authority: BrokerAuthority): BrokerControlMutation {
    if (!Array.isArray(values) || values.length > MAX_GRANTS) fail('invalid-input')
    const grants = values.map(normalizeBrokerGrant); if (new Set(grants.map(grant => grant.id)).size !== grants.length) fail('invalid-input')
    const nextEpoch = integer(policyEpoch); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now); const meta = this.#meta(); if (nextEpoch < meta.policy_epoch || grants.some(grant => grant.policyEpoch !== nextEpoch || grant.emergencyEpoch !== meta.emergency_epoch)) fail('grant')
      const supplied = new Set(grants.map(grant => grant.id)); let changed = nextEpoch !== meta.policy_epoch; const abort = new Set<string>()
      for (const grant of grants) {
        const head = this.#head(grant.id)
        if (head && grant.revision < head.revision) fail('conflict')
        if (head && grant.revision === head.revision) { if (head.digest !== grant.digest || head.revoked || head.head_revoked) fail('conflict'); continue }
        this.#database.prepare('INSERT INTO grants VALUES(?,?,?,?,0,?)').run(grant.id, grant.revision, grant.digest, canonicalBrokerJson(grant), now)
        this.#database.prepare('INSERT INTO grant_heads VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,revoked=0').run(grant.id, grant.revision)
        changed = true; this.#audit('grant-synced', grant.id, grant.revision, now)
        for (const row of this.#terminalizeGrant(grant.id, now, 'grant-replaced')) if (row.status === 'unknown') abort.add(row.actionId)
      }
      const heads = this.#database.prepare('SELECT id,revision,revoked FROM grant_heads').all() as Array<{ id: string; revision: number; revoked: number }>
      for (const head of heads) if (!supplied.has(head.id) && head.revoked === 0) {
        this.#database.prepare('UPDATE grant_heads SET revoked=1 WHERE id=? AND revision=?').run(head.id, head.revision); this.#database.prepare('UPDATE grants SET revoked=1 WHERE id=? AND revision=?').run(head.id, head.revision); changed = true; this.#audit('grant-removed', head.id, head.revision, now)
        for (const row of this.#terminalizeGrant(head.id, now, 'grant-removed')) if (row.status === 'unknown') abort.add(row.actionId)
      }
      if (changed) this.#database.prepare('UPDATE meta SET policy_epoch=?,control_version=control_version+1 WHERE singleton=1').run(nextEpoch)
      const snapshot = this.#snapshot(); this.#database.exec('COMMIT'); return Object.freeze({ ...snapshot, abortActionIds: Object.freeze([...abort]) })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  grant(id: string): ExternalGitHubGrant | undefined { const row = this.#head(text(id)); return row && !row.head_revoked ? this.#grant(row) : undefined }

  #checkRequest(request: BrokerClientRequest, grant: ExternalGitHubGrant, meta: MetaRow, now: number): number {
    if (meta.stopped || meta.draining) fail('stopped')
    if (request.clientKeyId !== grant.clientKeyId || request.grantRevision !== grant.revision || request.grantDigest !== grant.digest || !equal(request.owner, grant.owner) || request.sessionId !== grant.sessionId || !equal(request.source, grant.source)
      || !equal(request.client, grant.client)
      || request.broker.kind !== 'github-broker' || request.broker.instanceId !== meta.instance_id || request.broker.generation !== meta.generation
      || request.destination.classification !== 'github-repository' || request.destination.repository !== grant.destination.repository || request.destination.branch !== grant.destination.branch
      || request.policyEpoch !== grant.policyEpoch || request.policyEpoch !== meta.policy_epoch || request.emergencyEpoch !== grant.emergencyEpoch || request.emergencyEpoch !== meta.emergency_epoch
      || request.deadline <= now || request.deadline > grant.expiresAt || grant.expiresAt <= now || !grant.allowedOperations.includes(request.operation)) fail('grant')
    if (request.operation === 'commit') { if (!('files' in request.payload) || request.payload.files.some(file => !grant.destination.paths.includes(file.path))) fail('grant') }
    else if (!('kind' in request.payload) || !grant.allowedInspectKinds.includes(request.payload.kind) || request.payload.kind === 'file' && (!request.payload.path || !grant.destination.paths.includes(request.payload.path))) fail('grant')
    const bytes = brokerPayloadBytes(request)
    const costUnits = request.operation === 'inspect' && 'kind' in request.payload && ['checks', 'reviews'].includes(request.payload.kind) ? 2 : 1
    if (request.budget.actions !== 1 || request.budget.bytes !== bytes || request.budget.costMetric !== 'github-api-units' || request.budget.maxCostUnits !== costUnits || bytes > grant.maxTotalBytes || costUnits > grant.maxCostUnits) fail('limit')
    return bytes
  }
  prepare(request: BrokerClientRequest, authority: BrokerAuthority): { record: BrokerLedgerRecord; created: boolean } {
    const now = this.#time(); const requestDigest = brokerLedgerRequestDigest(request); this.#database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(request.actionId) as RequestRow | undefined
      if (existing) {
        const record = this.#row(existing)
        if (record.requestDigest !== requestDigest || record.clientKeyId !== request.clientKeyId) fail('conflict')
        // Exact terminal history is immutable readback and remains available
        // after grant expiry/revocation or controller handover. A nonterminal
        // row can still advance, so it must pass the current fence and grant.
        if (!record.outcome) { this.#authority(authority, now); const current = this.#head(request.grantId); if (!current || current.revoked || current.head_revoked) fail('grant'); this.#checkRequest(request, this.#grant(current), this.#meta(), now) }
        this.#database.exec('COMMIT'); return { record, created: false }
      }
      this.#authority(authority, now); const meta = this.#meta()
      const head = this.#head(request.grantId); if (!head || head.revoked || head.head_revoked) fail('grant'); const grant = this.#grant(head); const bytes = this.#checkRequest(request, grant, meta, now)
      const collision = this.#database.prepare('SELECT request_digest FROM requests WHERE client_key_id=? AND (request_id=? OR budget_reservation_id=?)').get(request.clientKeyId, request.requestId, request.budget.reservationId) as { request_digest: string } | undefined
      if (collision) fail('conflict')
      const count = (this.#database.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count; if (count >= MAX_RECORDS) fail('limit')
      const used = this.#database.prepare("SELECT COUNT(*) AS actions,COALESCE(SUM(bytes),0) AS bytes,COALESCE(SUM(cost_units),0) AS cost FROM requests WHERE grant_id=? AND (status='prepared' OR dispatched_at IS NOT NULL)").get(grant.id) as { actions: number; bytes: number; cost: number }
      const costUnits = request.budget.maxCostUnits
      if (used.actions + 1 > grant.maxActions || used.bytes + bytes > grant.maxTotalBytes || used.cost + costUnits > grant.maxCostUnits) fail('limit')
      this.#database.prepare('INSERT INTO requests(action_id,request_id,client_key_id,owner_json,session_id,agent_id,root_call_id,call_id,grant_id,grant_revision,grant_digest,request_digest,operation,repository,branch,expected_head_oid,payload_digest,budget_reservation_id,bytes,cost_units,deadline,policy_epoch,emergency_epoch,generation,status,version,dispatched_at,result_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,NULL,NULL)').run(request.actionId, request.requestId, request.clientKeyId, canonicalBrokerJson(request.owner), request.sessionId, request.agentId, request.rootCallId, request.callId, grant.id, grant.revision, grant.digest, requestDigest, request.operation, grant.destination.repository, grant.destination.branch, request.operation === 'commit' && 'expectedHeadOid' in request.payload ? request.payload.expectedHeadOid : null, request.payloadDigest, request.budget.reservationId, bytes, costUnits, request.deadline, request.policyEpoch, request.emergencyEpoch, meta.generation, 'prepared')
      this.#audit('request-prepared', request.actionId, 1, now); const row = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(request.actionId) as RequestRow
      this.#database.exec('COMMIT'); return { record: this.#row(row), created: true }
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  dispatch(actionId: string, version: number, requestDigestValue: string, credentialId: string, leaseExpiresAt: number, authority: BrokerAuthority): BrokerLedgerRecord {
    const id = text(actionId); const expected = integer(version, 1); const expectedDigest = digest(requestDigestValue); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now); const meta = this.#meta(); if (meta.stopped || meta.draining) fail('stopped')
      const row = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(id) as RequestRow | undefined; if (!row) fail('state'); const record = this.#row(row)
      if (record.status !== 'prepared' || record.version !== expected || record.requestDigest !== expectedDigest || record.deadline <= now || record.generation !== meta.generation || record.policyEpoch !== meta.policy_epoch || record.emergencyEpoch !== meta.emergency_epoch) fail('state')
      const head = this.#head(record.grantId); if (!head || head.revoked || head.head_revoked || head.revision !== record.grantRevision || head.digest !== record.grantDigest) fail('grant'); const grant = this.#grant(head)
      if (grant.expiresAt <= now || grant.credentialId !== credentialId || leaseExpiresAt <= now || leaseExpiresAt > record.deadline || leaseExpiresAt > grant.expiresAt) fail('grant')
      const changed = this.#database.prepare("UPDATE requests SET status='dispatched',version=version+1,dispatched_at=? WHERE action_id=? AND status='prepared' AND version=? AND request_digest=?").run(now, id, expected, expectedDigest)
      if (changed.changes !== 1) fail('state')
      this.#database.prepare("INSERT INTO credential_leases VALUES(?,?,?,'active',?,?,NULL,1)").run(id, credentialId, record.operation === 'commit' ? 'github.commit' : 'github.inspect', now, leaseExpiresAt)
      this.#audit('request-dispatched', id, expected + 1, now); const updated = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(id) as RequestRow
      this.#database.exec('COMMIT'); return this.#row(updated)
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  settle(actionId: string, version: number, requestDigestValue: string, value: BrokerLedgerOutcome, authority: BrokerAuthority): BrokerLedgerRecord {
    const id = text(actionId); const expected = integer(version, 1); const expectedDigest = digest(requestDigestValue); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now); const row = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(id) as RequestRow | undefined; if (!row) fail('state'); const record = this.#row(row)
      if (record.requestDigest !== expectedDigest) fail('conflict')
      if (record.outcome) { this.#database.exec('COMMIT'); return record }
      if (record.version !== expected || !['prepared', 'dispatched'].includes(record.status)) fail('state')
      const normalized = outcome(value, record); if (record.status === 'prepared' && normalized.dispatched || record.status === 'dispatched' && !normalized.dispatched) fail('state')
      const changed = this.#database.prepare('UPDATE requests SET status=?,version=version+1,result_json=? WHERE action_id=? AND version=? AND status=?').run(normalized.status, canonicalBrokerJson(normalized), id, expected, record.status)
      if (changed.changes !== 1) fail('state')
      if (record.status === 'dispatched') this.#database.prepare("UPDATE credential_leases SET status=?,settled_at=?,version=version+1 WHERE action_id=? AND status='active'").run(normalized.status === 'succeeded' ? 'completed' : 'failed', now, id)
      this.#audit('request-settled', id, expected + 1, now); const updated = this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(id) as RequestRow
      this.#database.exec('COMMIT'); return this.#row(updated)
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  failPrepared(actionId: string, version: number, requestDigestValue: string, code: string, authority: BrokerAuthority): BrokerLedgerRecord { return this.settle(actionId, version, requestDigestValue, { status: 'failed', dispatched: false, result: null, error: { code }, completedAt: Math.max(1, this.#time()) }, authority) }
  status(clientKeyId: string, actionId: string, requestDigestValue: string): BrokerLedgerRecord | undefined { const row = this.#database.prepare('SELECT * FROM requests WHERE client_key_id=? AND action_id=?').get(text(clientKeyId), text(actionId)) as RequestRow | undefined; if (!row) return undefined; const record = this.#row(row); if (record.requestDigest !== digest(requestDigestValue)) fail('conflict'); return record }
  terminalizeActive(reason: string, authority: BrokerAuthority): BrokerControlMutation {
    const code = text(reason, 128); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now)
      const rows = this.#database.prepare("SELECT * FROM requests WHERE status IN ('prepared','dispatched')").all() as RequestRow[]
      const abort: string[] = []
      for (const row of rows) { const result = this.#terminalize(row, now, code); if (result.status === 'unknown') abort.push(result.actionId) }
      const snapshot = this.#snapshot(); this.#database.exec('COMMIT')
      return Object.freeze({ ...snapshot, abortActionIds: Object.freeze(abort) })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  consumeAdminNonce(adminKeyId: string, nonce: string, requestDigestValue: string, expiresAt: number, authority: BrokerAuthority): void {
    const key = text(adminKeyId, 128); const nonceDigest = createHash('sha256').update(text(nonce, 128)).digest('hex'); const requestDigest = digest(requestDigestValue); const expiry = integer(expiresAt, 1); const now = this.#time()
    if (expiry <= now) fail('invalid-input')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now)
      this.#database.prepare('DELETE FROM admin_nonces WHERE expires_at<=?').run(now)
      const existing = this.#database.prepare('SELECT request_digest FROM admin_nonces WHERE admin_key_id=? AND nonce_digest=?').get(key, nonceDigest) as { request_digest: string } | undefined
      if (existing) fail('conflict')
      this.#database.prepare('INSERT INTO admin_nonces VALUES(?,?,?,?)').run(key, nonceDigest, requestDigest, expiry)
      this.#audit('admin-nonce-consumed', key, null, now); this.#database.exec('COMMIT')
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  applyAdminMutation(input: Readonly<{ adminKeyId: string; nonce: string; requestDigest: string; expiresAt: number; mutation: BrokerAdminMutation; authority: BrokerAuthority }>): BrokerControlMutation {
    if (!plain(input) || Object.keys(input).length !== 6 || !plain(input.mutation)) fail('invalid-input')
    const key = text(input.adminKeyId, 128); const nonceDigest = createHash('sha256').update(text(input.nonce, 128)).digest('hex')
    const requestDigest = digest(input.requestDigest); const expiresAt = integer(input.expiresAt, 1); const now = this.#time()
    if (expiresAt <= now) fail('invalid-input')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(input.authority, now)
      this.#database.prepare('DELETE FROM admin_nonces WHERE expires_at<=?').run(now)
      if (this.#database.prepare('SELECT 1 FROM admin_nonces WHERE admin_key_id=? AND nonce_digest=?').get(key, nonceDigest)) fail('conflict')
      const meta = this.#meta(); const expected = integer(input.mutation.expectedControlVersion)
      if (meta.control_version !== expected) fail('conflict')
      const abort: string[] = []
      if (input.mutation.operation === 'stop' || input.mutation.operation === 'resume') {
        if (input.mutation.operation === 'resume' && integer(input.mutation.expectedGeneration, 1) !== meta.generation) fail('controller')
        text(input.mutation.reason, 256)
        this.#database.prepare('UPDATE meta SET control_version=control_version+1,emergency_epoch=emergency_epoch+1,stopped=? WHERE singleton=1').run(input.mutation.operation === 'stop' ? 1 : 0)
        const rows = this.#database.prepare("SELECT * FROM requests WHERE status IN ('prepared','dispatched')").all() as RequestRow[]
        for (const row of rows) { const result = this.#terminalize(row, now, input.mutation.operation === 'stop' ? 'emergency-stop' : 'emergency-epoch-advanced'); if (result.status === 'unknown') abort.push(result.actionId) }
        this.#audit(input.mutation.operation === 'stop' ? 'emergency-stopped' : 'emergency-resumed', input.mutation.reason, expected + 1, now)
      } else {
        text(input.mutation.reason, 256); const id = text(input.mutation.grantId); const revision = integer(input.mutation.grantRevision, 1)
        const head = this.#head(id)
        if (!head || head.revision !== revision || head.digest !== digest(input.mutation.grantDigest) || meta.policy_epoch !== integer(input.mutation.policyEpoch) || meta.emergency_epoch !== integer(input.mutation.emergencyEpoch)) fail('grant')
        this.#database.prepare('UPDATE grant_heads SET revoked=1 WHERE id=? AND revision=?').run(id, revision)
        this.#database.prepare('UPDATE grants SET revoked=1 WHERE id=? AND revision=?').run(id, revision)
        for (const row of this.#terminalizeGrant(id, now, 'grant-revoked')) if (row.status === 'unknown') abort.push(row.actionId)
        this.#database.prepare('UPDATE meta SET control_version=control_version+1 WHERE singleton=1').run()
        this.#audit('grant-revoked', id, revision, now)
      }
      this.#database.prepare('INSERT INTO admin_nonces VALUES(?,?,?,?)').run(key, nonceDigest, requestDigest, expiresAt)
      this.#audit('admin-nonce-consumed', key, null, now)
      const snapshot = this.#snapshot(); this.#database.exec('COMMIT')
      return Object.freeze({ ...snapshot, abortActionIds: Object.freeze(abort) })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  #terminalize(row: RequestRow, now: number, code: string): BrokerLedgerRecord {
    const record = this.#row(row); const dispatched = record.status === 'dispatched'; const normalized: BrokerLedgerOutcome = { status: dispatched ? 'unknown' : 'failed', dispatched, result: null, error: { code }, completedAt: Math.max(1, now) }
    const changed = this.#database.prepare('UPDATE requests SET status=?,version=version+1,result_json=? WHERE action_id=? AND version=? AND status=?').run(normalized.status, canonicalBrokerJson(normalized), record.actionId, record.version, record.status)
    if (changed.changes !== 1) fail('state')
    this.#database.prepare("UPDATE credential_leases SET status='revoked',settled_at=?,version=version+1 WHERE action_id=? AND status='active'").run(now, record.actionId)
    this.#audit('request-invalidated', record.actionId, record.version + 1, now)
    return this.#row(this.#database.prepare('SELECT * FROM requests WHERE action_id=?').get(record.actionId) as RequestRow)
  }
  #terminalizeGrant(grantId: string, now: number, code: string): BrokerLedgerRecord[] { const rows = this.#database.prepare("SELECT * FROM requests WHERE grant_id=? AND status IN ('prepared','dispatched')").all(grantId) as RequestRow[]; return rows.map(row => this.#terminalize(row, now, code)) }
  #control(expectedControlVersion: number, stopped: boolean, reason: string, authority: BrokerAuthority): BrokerControlMutation {
    const expected = integer(expectedControlVersion); text(reason, 256); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now); const meta = this.#meta(); if (meta.control_version !== expected) fail('conflict')
      this.#database.prepare('UPDATE meta SET control_version=control_version+1,emergency_epoch=emergency_epoch+1,stopped=? WHERE singleton=1').run(stopped ? 1 : 0)
      const rows = this.#database.prepare("SELECT * FROM requests WHERE status IN ('prepared','dispatched')").all() as RequestRow[]; const abort: string[] = []
      for (const row of rows) { const result = this.#terminalize(row, now, stopped ? 'emergency-stop' : 'emergency-epoch-advanced'); if (result.status === 'unknown') abort.push(result.actionId) }
      this.#audit(stopped ? 'emergency-stopped' : 'emergency-resumed', reason, expected + 1, now); const snapshot = this.#snapshot(); this.#database.exec('COMMIT'); return Object.freeze({ ...snapshot, abortActionIds: Object.freeze(abort) })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  stop(expectedControlVersion: number, reason: string, authority: BrokerAuthority): BrokerControlMutation { return this.#control(expectedControlVersion, true, reason, authority) }
  resume(expectedControlVersion: number, reason: string, authority: BrokerAuthority): BrokerControlMutation { return this.#control(expectedControlVersion, false, reason, authority) }
  beginDrain(expectedControlVersion: number, reason: string, authority: BrokerAuthority): BrokerControlMutation {
    const expected = integer(expectedControlVersion); text(reason, 256); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try { this.#authority(authority, now); const meta = this.#meta(); if (meta.draining === 1) { this.#database.exec('COMMIT'); return Object.freeze({ ...this.#snapshot(meta), abortActionIds: Object.freeze([]) }) } if (meta.control_version !== expected) fail('conflict'); this.#database.prepare('UPDATE meta SET control_version=control_version+1,draining=1 WHERE singleton=1').run(); this.#audit('drain-started', reason, expected + 1, now); const snapshot = this.#snapshot(); this.#database.exec('COMMIT'); return Object.freeze({ ...snapshot, abortActionIds: Object.freeze([]) }) } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  revoke(grantId: string, revision: number, expectedControlVersion: number, reason: string, authority: BrokerAuthority): BrokerControlMutation {
    const id = text(grantId); const expectedRevision = integer(revision, 1); const expectedControl = integer(expectedControlVersion); text(reason, 256); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#authority(authority, now); const meta = this.#meta(); if (meta.control_version !== expectedControl) fail('conflict'); const head = this.#head(id); if (!head || head.revision !== expectedRevision) fail('grant')
      this.#database.prepare('UPDATE grant_heads SET revoked=1 WHERE id=? AND revision=?').run(id, expectedRevision); this.#database.prepare('UPDATE grants SET revoked=1 WHERE id=? AND revision=?').run(id, expectedRevision)
      const abort: string[] = []; for (const row of this.#terminalizeGrant(id, now, 'grant-revoked')) if (row.status === 'unknown') abort.push(row.actionId)
      this.#database.prepare('UPDATE meta SET control_version=control_version+1 WHERE singleton=1').run(); this.#audit('grant-revoked', id, expectedRevision, now); const snapshot = this.#snapshot(); this.#database.exec('COMMIT'); return Object.freeze({ ...snapshot, abortActionIds: Object.freeze(abort) })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  snapshot(): BrokerControlSnapshot { return this.#snapshot() }
  close(): void { if (this.#closed) return; this.#closed = true; try { this.#database.close() } finally { if (this.#parentDescriptor !== undefined) closeSync(this.#parentDescriptor) } }
}
