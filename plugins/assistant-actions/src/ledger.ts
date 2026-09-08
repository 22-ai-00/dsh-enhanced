import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ActionAuthority, ActionGrant, ActionIdentity, ActionRecord, ActionResult, WorkflowRequest } from './types.js'

const schemaVersion = 2
const maxRecords = 10_000
const maxActiveActions = 2

export class ActionLedgerError extends Error {
  constructor(readonly code: 'invalid-input' | 'unsafe-file' | 'schema' | 'controller' | 'conflict' | 'limit' | 'grant' | 'state') {
    super(`action ledger rejected: ${code}`)
    this.name = 'ActionLedgerError'
  }
}

type GrantRow = { id: string; revision: number; grant_json: string; revoked: number }
type RecordRow = {
  kind: ActionRecord['kind']; id: string; identity_json: string; session_id: string; grant_id: string; idempotency_digest: string; grant_revision: number; repository: string; branch: string; expected_head_oid: string; request_digest: string
  bytes: number; expires_at: number; status: ActionRecord['status']; version: number; result_json: string | null
}

function fail(code: ActionLedgerError['code']): never { throw new ActionLedgerError(code) }
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key)
const equal = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right)

function plain(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0
}

function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!plain(value)) fail('invalid-input')
  const names = Object.getOwnPropertyNames(value).sort()
  const allowed = [...required, ...optional].sort()
  if (names.length < required.length || names.some(name => !allowed.includes(name)) || required.some(name => !own(value, name))) fail('invalid-input')
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!('value' in descriptor) || !descriptor.enumerable) fail('invalid-input')
  return value
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0 || value.length > maximum) fail('invalid-input')
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || names.at(-1) !== 'length') fail('invalid-input')
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) fail('invalid-input')
  }
  return value
}

function text(value: unknown, maximum = 4_096, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')) fail('invalid-input')
  return value
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid-input')
  return value
}

function after(now: number, duration: number): number {
  if (duration > Number.MAX_SAFE_INTEGER - now) fail('invalid-input')
  return now + duration
}

function validPath(value: unknown): string {
  const path = text(value)
  if (isAbsolute(path) || path.split('/').some(segment => segment.length === 0 || segment === '.' || segment === '..')) fail('invalid-input')
  return path
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('invalid-input'); return JSON.stringify(value) }
  if (Array.isArray(value)) return `[${array(value, 10_000).map(stableJson).join(',')}]`
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return fail('invalid-input')
}

function storedJson(value: string): unknown {
  try { return JSON.parse(value) } catch { return fail('schema') }
}

function digest(value: unknown): string {
  const result = text(value, 64)
  if (!/^[0-9a-f]{64}$/iu.test(result)) fail('invalid-input')
  return result
}

function identityInput(value: unknown): ActionIdentity {
  const input = object(value, ['principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset'])
  const workspace = text(input.workspace)
  if (!isAbsolute(workspace)) fail('invalid-input')
  return Object.freeze({ principalDigest: text(input.principalDigest), principalRecordId: text(input.principalRecordId), principalVersion: integer(input.principalVersion, 1), workspace, agentPreset: text(input.agentPreset) })
}

function grantInput(value: unknown): ActionGrant {
  const input = object(value, ['id', 'revision', 'principalDigest', 'principalRecordId', 'principalVersion', 'workspace', 'agentPreset', 'repository', 'branch', 'paths', 'credentialHandle', 'expiresAt', 'maxActions', 'maxTotalBytes'], ['repoWorkflow', 'verifiedDelivery'])
  const identity = identityInput({ principalDigest: input.principalDigest, principalRecordId: input.principalRecordId, principalVersion: input.principalVersion, workspace: input.workspace, agentPreset: input.agentPreset })
  const paths = array(input.paths, 1_000).map(validPath)
  if (paths.length === 0 || new Set(paths).size !== paths.length) fail('invalid-input')
  const workflow = input.repoWorkflow === undefined ? undefined : object(input.repoWorkflow, ['baseBranch', 'allowBranchCreate', 'allowPullRequest'])
  if (workflow && (typeof workflow.allowBranchCreate !== 'boolean' || typeof workflow.allowPullRequest !== 'boolean')) fail('invalid-input')
  const delivery = input.verifiedDelivery === undefined ? undefined : object(input.verifiedDelivery, ['ownerRouteId', 'budgetId'])
  return Object.freeze({ ...identity, id: text(input.id), revision: integer(input.revision, 1), repository: text(input.repository), branch: text(input.branch), paths, credentialHandle: text(input.credentialHandle), expiresAt: integer(input.expiresAt, 0), maxActions: integer(input.maxActions, 1, maxRecords), maxTotalBytes: integer(input.maxTotalBytes, 0), ...(workflow ? { repoWorkflow: Object.freeze({ baseBranch: text(workflow.baseBranch), allowBranchCreate: workflow.allowBranchCreate as boolean, allowPullRequest: workflow.allowPullRequest as boolean }) } : {}), ...(delivery ? { verifiedDelivery: Object.freeze({ ownerRouteId: text(delivery.ownerRouteId, 200), budgetId: text(delivery.budgetId, 200) }) } : {}) })
}

export function normalizeWorkflow(value: unknown): WorkflowRequest {
  if (plain(value) && own(value, 'operation')) {
    const input = object(value, ['operation', 'grantId', 'idempotencyKey', 'kind'], ['path', 'pullRequestNumber'])
    if (input.operation !== 'inspect' || !['repository', 'branch', 'file', 'pull-request', 'checks', 'reviews'].includes(String(input.kind))) fail('invalid-input')
    const needsPr = ['pull-request', 'checks', 'reviews'].includes(String(input.kind))
    if (own(input, 'path') !== (input.kind === 'file') || own(input, 'pullRequestNumber') !== needsPr) fail('invalid-input')
    return Object.freeze({ operation: 'inspect', grantId: text(input.grantId), idempotencyKey: text(input.idempotencyKey), kind: input.kind as import('./types.js').InspectRequest['kind'],
      ...(input.kind === 'file' ? { path: validPath(input.path) } : {}), ...(needsPr ? { pullRequestNumber: integer(input.pullRequestNumber, 1) } : {}) })
  }
  if (plain(value) && Object.prototype.hasOwnProperty.call(value, 'baseHeadOid')) {
    const input = object(value, ['grantId', 'idempotencyKey', 'baseHeadOid']); const baseHeadOid = text(input.baseHeadOid, 40)
    if (!/^[0-9a-f]{40}$/iu.test(baseHeadOid)) fail('invalid-input')
    return Object.freeze({ grantId: text(input.grantId), idempotencyKey: text(input.idempotencyKey), baseHeadOid })
  }
  if (plain(value) && Object.prototype.hasOwnProperty.call(value, 'title')) {
    const input = object(value, ['grantId', 'idempotencyKey', 'expectedHeadOid', 'title', 'body']); const expectedHeadOid = text(input.expectedHeadOid, 40)
    if (!/^[0-9a-f]{40}$/iu.test(expectedHeadOid)) fail('invalid-input')
    return Object.freeze({ grantId: text(input.grantId), idempotencyKey: text(input.idempotencyKey), expectedHeadOid, title: text(input.title, 200), body: text(input.body, 65_536, 0) })
  }
  const input = object(value, ['grantId', 'idempotencyKey', 'expectedHeadOid', 'headline', 'files'])
  const files = array(input.files, 1_000).map(item => {
    const file = object(item, ['path', 'content'])
    return Object.freeze({ path: validPath(file.path), content: text(file.content, 10_000_000, 0) })
  })
  if (files.length === 0 || new Set(files.map(file => file.path)).size !== files.length) fail('invalid-input')
  const expectedHeadOid = text(input.expectedHeadOid, 40)
  if (!/^[0-9a-f]{40}$/iu.test(expectedHeadOid)) fail('invalid-input')
  return Object.freeze({ grantId: text(input.grantId), idempotencyKey: text(input.idempotencyKey), expectedHeadOid, headline: text(input.headline), files })
}

function resultInput(value: unknown): ActionResult {
  const input = object(value, ['actionId', 'status'], ['commitOid', 'reason', 'branch', 'pullRequestNumber'])
  if (typeof input.status !== 'string' || !['succeeded', 'failed', 'unknown'].includes(input.status)) fail('invalid-input')
  if (own(input, 'commitOid')) text(input.commitOid)
  if (own(input, 'reason')) text(input.reason, 4_096)
  if (own(input, 'branch')) text(input.branch, 256)
  if (own(input, 'pullRequestNumber')) integer(input.pullRequestNumber, 1)
  return Object.freeze({ actionId: text(input.actionId), status: input.status as ActionResult['status'], ...(own(input, 'commitOid') ? { commitOid: input.commitOid as string } : {}), ...(own(input, 'reason') ? { reason: input.reason as string } : {}), ...(own(input, 'branch') ? { branch: input.branch as string } : {}), ...(own(input, 'pullRequestNumber') ? { pullRequestNumber: input.pullRequestNumber as number } : {}) })
}

function authorityInput(value: unknown): ActionAuthority {
  const input = object(value, ['ownerId', 'fence'])
  return Object.freeze({ ownerId: text(input.ownerId), fence: integer(input.fence, 1) })
}

function privateFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) fail('unsafe-file')
}

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid?.() !== undefined && stat.uid !== process.getuid?.())) fail('unsafe-file')
}

function preparePath(path: string): void {
  if (!isAbsolute(path)) fail('unsafe-file')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); chmodSync(dirname(path), 0o700); privateDirectory(dirname(path))
  let existing = false
  try { lstatSync(path); existing = true } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') fail('unsafe-file')
  }
  if (!existing) {
    const descriptor = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); closeSync(descriptor)
  }
  privateFile(path); chmodSync(path, 0o600); privateFile(path)
}

function open(path: string): DatabaseSync {
  if (path !== ':memory:') preparePath(path)
  const database = new DatabaseSync(path, { enableForeignKeyConstraints: true })
  try {
    database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    if (version === 0) database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE grants (id TEXT NOT NULL, revision INTEGER NOT NULL, grant_json TEXT NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0, 1)), PRIMARY KEY(id, revision)) STRICT, WITHOUT ROWID;
      CREATE TABLE grant_heads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0, 1)), FOREIGN KEY(id, revision) REFERENCES grants(id, revision)) STRICT;
      CREATE TABLE actions (kind TEXT NOT NULL DEFAULT 'commit' CHECK(kind IN ('commit', 'branch', 'pull-request', 'inspect')), id TEXT PRIMARY KEY, identity_json TEXT NOT NULL, session_id TEXT NOT NULL, grant_id TEXT NOT NULL, idempotency_digest TEXT NOT NULL, grant_revision INTEGER NOT NULL, repository TEXT NOT NULL, branch TEXT NOT NULL, expected_head_oid TEXT NOT NULL, request_digest TEXT NOT NULL, bytes INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared', 'dispatched', 'succeeded', 'failed', 'unknown')), version INTEGER NOT NULL, result_json TEXT, UNIQUE(identity_json, session_id, grant_id, idempotency_digest), FOREIGN KEY(grant_id, grant_revision) REFERENCES grants(id, revision)) STRICT;
      CREATE TABLE controller (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), owner_id TEXT NOT NULL, fence INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT;
      CREATE TABLE audit (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, revision INTEGER, recorded_at INTEGER NOT NULL) STRICT;
      CREATE INDEX actions_grant ON actions(grant_id, grant_revision);
      CREATE INDEX actions_destination_head ON actions(repository, branch, expected_head_oid, status);
      PRAGMA user_version = 2;
      COMMIT;`)
    if (version === 1) database.exec("BEGIN IMMEDIATE; ALTER TABLE actions ADD COLUMN kind TEXT NOT NULL DEFAULT 'commit' CHECK(kind IN ('commit', 'branch', 'pull-request', 'inspect')); PRAGMA user_version = 2; COMMIT;")
    if (![0, 1, schemaVersion].includes(version)) fail('schema')
    const tables = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>).map(row => row.name)
    if (!equal(tables, ['actions', 'audit', 'controller', 'grant_heads', 'grants'])) fail('schema')
    const strict = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ sql: string }>
    if (!strict.every(row => /\bSTRICT\b/u.test(row.sql))) fail('schema')
    const check = database.prepare('PRAGMA quick_check').get() as { quick_check: string }
    if (check.quick_check !== 'ok') fail('schema')
    const actionCount = (database.prepare('SELECT COUNT(*) AS count FROM actions').get() as { count: number }).count
    if (!Number.isSafeInteger(actionCount) || actionCount > maxRecords) fail('schema')
    if (path !== ':memory:') {
      privateFile(path)
      for (const suffix of ['-wal', '-shm']) {
        try { chmodSync(`${path}${suffix}`, 0o600); privateFile(`${path}${suffix}`) } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error
        }
      }
    }
    return database
  } catch (error) { database.close(); throw error }
}

export class ActionLedger {
  readonly #database: DatabaseSync
  readonly #now: () => number

  constructor(path: string, options: Readonly<{ now?: () => number }> = {}) {
    if (!plain(options) || Object.keys(options).some(key => key !== 'now') || (options.now !== undefined && typeof options.now !== 'function')) fail('invalid-input')
    this.#now = options.now ?? Date.now
    this.#database = open(path)
    try { this.#validateStored() } catch (error) { this.#database.close(); throw error }
  }

  #time(): number { return integer(this.#now(), 0) }
  #audit(kind: string, subjectId: string, revision: number | null, now: number): void { this.#database.prepare('INSERT INTO audit(kind, subject_id, revision, recorded_at) VALUES (?, ?, ?, ?)').run(kind, subjectId, revision, now) }
  #controller(authority: unknown, now = this.#time()): ActionAuthority {
    const input = authorityInput(authority)
    const row = this.#database.prepare('SELECT owner_id, fence, expires_at FROM controller WHERE singleton = 1').get() as { owner_id: string; fence: number; expires_at: number } | undefined
    if (!row) fail('controller')
    let owner: string; let fence: number; let expiresAt: number
    try { owner = text(row.owner_id); fence = integer(row.fence, 1); expiresAt = integer(row.expires_at, 0) } catch { fail('schema') }
    if (owner !== input.ownerId || fence !== input.fence || expiresAt <= now) fail('controller')
    return input
  }
  #grantRow(row: GrantRow): ActionGrant {
    try {
      const grant = grantInput(storedJson(row.grant_json))
      if (grant.id !== text(row.id) || grant.revision !== integer(row.revision, 1) || (row.revoked !== 0 && row.revoked !== 1)) fail('schema')
      return grant
    } catch { return fail('schema') }
  }
  #grantRevision(id: string, revision: number): ActionGrant {
    const row = this.#database.prepare('SELECT id, revision, grant_json, revoked FROM grants WHERE id = ? AND revision = ?').get(id, revision) as GrantRow | undefined
    if (!row) fail('schema')
    return this.#grantRow(row)
  }
  #row(row: RecordRow): ActionRecord {
    try {
      const id = text(row.id); const identity = identityInput(storedJson(row.identity_json)); const sessionId = text(row.session_id); const grantId = text(row.grant_id)
      const grantRevision = integer(row.grant_revision, 1); digest(row.idempotency_digest); const requestDigest = digest(row.request_digest); const bytes = integer(row.bytes, 0); const expiresAt = integer(row.expires_at, 0); const version = integer(row.version, 1)
      if (!['commit', 'branch', 'pull-request', 'inspect'].includes(row.kind)) fail('schema')
      if (!['prepared', 'dispatched', 'succeeded', 'failed', 'unknown'].includes(row.status)) fail('schema')
      const status = row.status as ActionRecord['status']; const terminal = ['succeeded', 'failed', 'unknown'].includes(status)
      if (terminal !== (row.result_json !== null)) fail('schema')
      const result = row.result_json === null ? undefined : resultInput(storedJson(row.result_json))
      if (result && (result.actionId !== id || result.status !== status)) fail('schema')
      const grant = this.#grantRevision(grantId, grantRevision)
      const grantIdentity: ActionIdentity = { principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset }
      if (!equal(identity, grantIdentity) || grant.repository !== text(row.repository) || grant.branch !== text(row.branch) || (row.kind === 'inspect' ? row.expected_head_oid !== '' : !/^[0-9a-f]{40}$/iu.test(row.expected_head_oid))) fail('schema')
      return Object.freeze({ kind: row.kind, id, identity, sessionId, grantId, grantRevision, requestDigest, bytes, expiresAt, status, version, ...(result ? { result } : {}) })
    } catch { return fail('schema') }
  }
  #currentGrant(id: string): GrantRow | undefined {
    const row = this.#database.prepare('SELECT g.id, g.revision, g.grant_json, h.revoked, g.revoked AS grant_revoked FROM grants g JOIN grant_heads h ON h.id = g.id AND h.revision = g.revision WHERE g.id = ?').get(id) as (GrantRow & { grant_revoked: number }) | undefined
    if (row && row.revoked !== row.grant_revoked) fail('schema')
    return row
  }
  #validateStored(): void {
    try {
      const grants = this.#database.prepare('SELECT id, revision, grant_json, revoked FROM grants').all() as GrantRow[]
      for (const grant of grants) this.#grantRow(grant)
      const heads = this.#database.prepare('SELECT h.id, h.revision, h.revoked, g.grant_json FROM grant_heads h JOIN grants g ON g.id = h.id AND g.revision = h.revision').all() as GrantRow[]
      if (heads.length !== (this.#database.prepare('SELECT COUNT(*) AS count FROM grant_heads').get() as { count: number }).count) fail('schema')
      for (const head of heads) { this.#grantRow(head); this.#currentGrant(head.id) }
      const controllers = this.#database.prepare('SELECT owner_id, fence, expires_at FROM controller').all() as Array<{ owner_id: unknown; fence: unknown; expires_at: unknown }>
      if (controllers.length > 1) fail('schema')
      for (const controller of controllers) { text(controller.owner_id); integer(controller.fence, 1); integer(controller.expires_at, 0) }
      const actions = this.#database.prepare('SELECT * FROM actions LIMIT 10001').all() as RecordRow[]
      if (actions.length > maxRecords) fail('schema')
      for (const action of actions) this.#row(action)
    } catch { fail('schema') }
  }

  claimController(ownerId: string, ttlMs = 30_000): ActionAuthority {
    const owner = text(ownerId); const ttl = integer(ttlMs, 1); const now = this.#time()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const current = this.#database.prepare('SELECT owner_id, fence, expires_at FROM controller WHERE singleton = 1').get() as { owner_id: string; fence: number; expires_at: number } | undefined
      if (current && current.expires_at > now) fail('controller')
      const fence = after(current ? integer(current.fence, 1) : 0, 1)
      this.#database.prepare('INSERT INTO controller(singleton, owner_id, fence, expires_at) VALUES(1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET owner_id = excluded.owner_id, fence = excluded.fence, expires_at = excluded.expires_at').run(owner, fence, after(now, ttl))
      this.#database.exec('COMMIT'); return Object.freeze({ ownerId: owner, fence })
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  renewController(authority: ActionAuthority, ttlMs = 30_000): ActionAuthority {
    const ttl = integer(ttlMs, 1); const now = this.#time(); const input = this.#controller(authority, now)
    const updated = this.#database.prepare('UPDATE controller SET expires_at = ? WHERE singleton = 1 AND owner_id = ? AND fence = ? AND expires_at > ?').run(after(now, ttl), input.ownerId, input.fence, now)
    if (updated.changes !== 1) fail('controller'); return input
  }
  hasController(authority: ActionAuthority): boolean { try { this.#controller(authority); return true } catch (error) { if (error instanceof ActionLedgerError && error.code === 'controller') return false; throw error } }
  releaseController(authority: ActionAuthority): void { const now = this.#time(); const input = this.#controller(authority, now); const result = this.#database.prepare('UPDATE controller SET expires_at = ? WHERE singleton = 1 AND owner_id = ? AND fence = ? AND expires_at > ?').run(now, input.ownerId, input.fence, now); if (result.changes !== 1) fail('controller') }

  syncGrants(values: ActionGrant[], authority: ActionAuthority): void {
    const grants = array(values, 1_000).map(grantInput); if (new Set(grants.map(grant => grant.id)).size !== grants.length) fail('invalid-input')
    const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#controller(authority, now)
      const old = this.#database.prepare('SELECT id, revision, revoked FROM grant_heads').all() as Array<{ id: string; revision: number; revoked: number }>
      for (const grant of grants) {
        const head = old.find(row => row.id === grant.id)
        if (head && grant.revision < head.revision) fail('conflict')
        if (head && grant.revision === head.revision) {
          const stored = this.#database.prepare('SELECT id, revision, grant_json, revoked FROM grants WHERE id = ? AND revision = ?').get(grant.id, grant.revision) as GrantRow | undefined
          if (!stored || head.revoked || !equal(this.#grantRow(stored), grant)) fail('conflict')
          continue
        }
        this.#database.prepare('INSERT INTO grants(id, revision, grant_json, revoked) VALUES (?, ?, ?, 0)').run(grant.id, grant.revision, stableJson(grant))
        this.#database.prepare('INSERT INTO grant_heads(id, revision, revoked) VALUES (?, ?, 0) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, revoked = 0').run(grant.id, grant.revision)
        this.#audit('grant-synced', grant.id, grant.revision, now)
      }
      const incoming = new Set(grants.map(grant => grant.id))
      for (const head of old) if (!incoming.has(head.id) && head.revoked === 0) { this.#database.prepare('UPDATE grant_heads SET revoked = 1 WHERE id = ?').run(head.id); this.#database.prepare('UPDATE grants SET revoked = 1 WHERE id = ? AND revision = ?').run(head.id, head.revision); this.#audit('grant-removed', head.id, head.revision, now) }
      this.#database.exec('COMMIT')
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  revoke(grantId: string, revision: number): void {
    const id = text(grantId); const rev = integer(revision, 1); const now = this.#time()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      const result = this.#database.prepare('UPDATE grant_heads SET revoked = 1 WHERE id = ? AND revision = ? AND revoked = 0').run(id, rev)
      if (result.changes === 1) { this.#database.prepare('UPDATE grants SET revoked = 1 WHERE id = ? AND revision = ?').run(id, rev); this.#audit('grant-revoked', id, rev, now) }
      this.#database.exec('COMMIT')
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  grant(id: string): ActionGrant | undefined { const row = this.#currentGrant(text(id)); return !row || row.revoked ? undefined : this.#grantRow(row) }

  prepare(input: Readonly<{ identity: ActionIdentity; sessionId: string; request: WorkflowRequest; bytes: number; authority: ActionAuthority; leaseMs?: number }>): { record: ActionRecord; created: boolean } {
    const args = object(input, ['identity', 'sessionId', 'request', 'bytes', 'authority'], ['leaseMs'])
    const identity = identityInput(args.identity); const sessionId = text(args.sessionId); const request = normalizeWorkflow(args.request); const bytes = integer(args.bytes, 0); const lease = own(args, 'leaseMs') ? integer(args.leaseMs, 1, 30_000) : 30_000
    const calculated = 'files' in request ? Buffer.byteLength(request.headline, 'utf8') + request.files.reduce((total, file) => total + Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(file.content, 'utf8'), 0) : Buffer.byteLength(stableJson(request), 'utf8'); if (calculated !== bytes) fail('invalid-input')
    const digest = createHash('sha256').update(stableJson(request)).digest('hex'); const idempotencyDigest = createHash('sha256').update(request.idempotencyKey).digest('hex'); const now = this.#time()
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#controller(args.authority, now)
      const keyed = this.#database.prepare('SELECT * FROM actions WHERE identity_json = ? AND session_id = ? AND grant_id = ? AND idempotency_digest = ?').get(stableJson(identity), sessionId, request.grantId, idempotencyDigest) as RecordRow | undefined
      if (keyed) {
        if (keyed.request_digest !== digest) fail('conflict')
        this.#database.exec('COMMIT'); return { record: this.#row(keyed), created: false }
      }
      const grantRow = this.#currentGrant(request.grantId); if (!grantRow || grantRow.revoked) fail('grant')
      const grant = this.#grantRow(grantRow)
      if (!equal(identity, { principalDigest: grant.principalDigest, principalRecordId: grant.principalRecordId, principalVersion: grant.principalVersion, workspace: grant.workspace, agentPreset: grant.agentPreset }) || grant.expiresAt <= now || ('files' in request && !request.files.every(file => grant.paths.includes(file.path)))) fail('grant')
      const kind = 'operation' in request ? 'inspect' : 'files' in request ? 'commit' : 'baseHeadOid' in request ? 'branch' : 'pull-request'
      if ((kind === 'branch' && !grant.repoWorkflow?.allowBranchCreate) || (kind === 'pull-request' && !grant.repoWorkflow?.allowPullRequest)
        || ('operation' in request && ((request.kind === 'file' && !grant.paths.includes(request.path!)) || (['pull-request', 'checks', 'reviews'].includes(request.kind) && !grant.repoWorkflow)))) fail('grant')
      const head = 'operation' in request ? '' : 'baseHeadOid' in request ? request.baseHeadOid : request.expectedHeadOid
      // An uncertain branch/PR creation must not be repeated with a new key or
      // head OID. Reads remain available to investigate uncertain mutations.
      if (kind !== 'inspect') {
        const uncertain = this.#database.prepare("SELECT 1 FROM actions WHERE repository = ? AND branch = ? AND kind != 'inspect' AND status IN ('dispatched', 'unknown') AND (expected_head_oid = ? OR kind = 'branch' OR (kind = 'pull-request' AND ? = 'pull-request')) LIMIT 1").get(grant.repository, grant.branch, head, kind)
        if (uncertain) fail('state')
      }
      const active = (this.#database.prepare("SELECT COUNT(*) AS count FROM actions WHERE status IN ('prepared', 'dispatched') OR (status = 'unknown' AND kind != 'inspect' AND ? != 'inspect')").get(kind) as { count: number }).count
      if (active >= maxActiveActions) fail('limit')
      const used = this.#database.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM actions WHERE grant_id = ?').get(grant.id) as { count: number; bytes: number }
      const records = (this.#database.prepare('SELECT COUNT(*) AS count FROM actions').get() as { count: number }).count
      if (records >= maxRecords || used.count >= grant.maxActions || used.bytes + bytes > grant.maxTotalBytes) fail('limit')
      const expiresAt = Math.min(after(now, lease), grant.expiresAt); const id = randomUUID()
      this.#database.prepare('INSERT INTO actions(kind, id, identity_json, session_id, grant_id, idempotency_digest, grant_revision, repository, branch, expected_head_oid, request_digest, bytes, expires_at, status, version, result_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'prepared\', 1, NULL)').run(kind, id, stableJson(identity), sessionId, grant.id, idempotencyDigest, grant.revision, grant.repository, grant.branch, head, digest, bytes, expiresAt)
      this.#audit('action-prepared', id, 1, now)
      const row = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(id) as RecordRow
      this.#database.exec('COMMIT'); return { record: this.#row(row), created: true }
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }

  dispatch(id: string, version: number, authority: ActionAuthority): ActionRecord {
    const actionId = text(id); const expected = integer(version, 1); const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#controller(authority, now)
      const row = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as RecordRow | undefined; if (!row) fail('state')
      const record = this.#row(row); if (record.status !== 'prepared' || record.version !== expected || record.expiresAt <= now) fail('state')
      const head = this.#currentGrant(record.grantId); if (!head || head.revoked || head.revision !== record.grantRevision) fail('grant')
      const grant = this.#grantRow(head); if (grant.expiresAt <= now) fail('grant')
      const changed = this.#database.prepare("UPDATE actions SET status = 'dispatched', version = version + 1 WHERE id = ? AND status = 'prepared' AND version = ?").run(actionId, expected)
      if (changed.changes !== 1) fail('state'); this.#audit('action-dispatched', actionId, expected + 1, now)
      const updated = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as RecordRow; this.#database.exec('COMMIT'); return this.#row(updated)
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }

  settle(id: string, version: number, result: ActionResult, authority: ActionAuthority): ActionRecord {
    const actionId = text(id); const expected = integer(version, 1); const outcome = resultInput(result); const now = this.#time(); if (outcome.actionId !== actionId) fail('invalid-input')
    this.#database.exec('BEGIN IMMEDIATE')
    try {
      this.#controller(authority, now)
      const row = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as RecordRow | undefined; if (!row) fail('state')
      const record = this.#row(row); if (record.version !== expected || !['prepared', 'dispatched'].includes(record.status)) fail('state')
      if (record.status === 'prepared' && outcome.status === 'succeeded') fail('state')
      const changed = this.#database.prepare('UPDATE actions SET status = ?, version = version + 1, result_json = ? WHERE id = ? AND version = ? AND status IN (\'prepared\', \'dispatched\')').run(outcome.status, stableJson(outcome), actionId, expected)
      if (changed.changes !== 1) fail('state'); this.#audit('action-settled', actionId, expected + 1, now)
      const updated = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(actionId) as RecordRow; this.#database.exec('COMMIT'); return this.#row(updated)
    } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  usable(id: string): boolean { const row = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(text(id)) as RecordRow | undefined; if (!row) return false; const record = this.#row(row); if (!['prepared', 'dispatched'].includes(record.status) || record.expiresAt <= this.#time()) return false; const head = this.#currentGrant(record.grantId); return !!head && !head.revoked && head.revision === record.grantRevision && this.#grantRow(head).expiresAt > this.#time() }
  recover(authority: ActionAuthority): number {
    const now = this.#time(); this.#database.exec('BEGIN IMMEDIATE')
    try { this.#controller(authority, now); const rows = this.#database.prepare("SELECT * FROM actions WHERE status IN ('prepared', 'dispatched')").all() as RecordRow[]; for (const row of rows) { const record = this.#row(row); const result = { actionId: record.id, status: 'unknown' as const, reason: 'controller-recovery-no-replay' }; this.#database.prepare("UPDATE actions SET status = 'unknown', version = version + 1, result_json = ? WHERE id = ? AND version = ? AND status IN ('prepared', 'dispatched')").run(stableJson(result), record.id, record.version); this.#audit('action-recovered', record.id, record.version + 1, now) } this.#database.exec('COMMIT'); return rows.length } catch (error) { try { this.#database.exec('ROLLBACK') } catch {} throw error }
  }
  get(id: string): ActionRecord | undefined { const row = this.#database.prepare('SELECT * FROM actions WHERE id = ?').get(text(id)) as RecordRow | undefined; return row && this.#row(row) }
  close(): void { this.#database.close() }
}
