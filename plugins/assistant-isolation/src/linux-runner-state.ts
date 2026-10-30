import { createHash, randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { IsolationLedger } from './ledger.js'

export interface LinuxRunnerStateSeal { path: string; sha256: string }
type Kind = 'repository' | 'verification'
interface FileIdentity { path: string; dev: number; ino: number }
interface SealBody {
  schemaVersion: 1
  protocol: 'dsh-linux-runner-state/v1'
  id: string
  kind: Kind
  uid: number
  stateRoot: FileIdentity
  ledger: FileIdentity
  ledgerSchemaVersion: 8
  schemaSha256: string
}
const hex = /^[a-f0-9]{64}$/u
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const canonical = (value: unknown): value is string => typeof value === 'string' && isAbsolute(value)
  && resolve(value) === value && value !== '/' && !/[\p{Cc}\\]/u.test(value)
function fail(message: string): never { throw new Error(`Linux runner state: ${message}`) }
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
    && Object.values(Object.getOwnPropertyDescriptors(value)).every(item => item.enumerable && 'value' in item)
}
function owner(): number {
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || !uid) fail('requires non-root Linux')
  return uid
}
function exists(path: string): boolean {
  try { lstatSync(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}
function syncFile(path: string, directory = false): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0))
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function privateDirectory(path: string): Stats {
  const info = lstatSync(path)
  if (!canonical(path) || realpathSync(path) !== path || !info.isDirectory() || info.isSymbolicLink()
    || info.uid !== owner() || (info.mode & 0o777) !== 0o700) fail('directory is not private and canonical')
  return info
}
function privateFile(path: string, maximum?: number): Stats {
  const info = lstatSync(path)
  if (!canonical(path) || realpathSync(path) !== path || !info.isFile() || info.isSymbolicLink()
    || info.nlink !== 1 || info.uid !== owner() || (info.mode & 0o777) !== 0o600
    || maximum !== undefined && info.size > maximum) fail('file is not private and canonical')
  return info
}
const identity = (path: string, info: Stats): FileIdentity => ({ path, dev: info.dev, ino: info.ino })
function sameIdentity(actual: Stats, expected: FileIdentity): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail('file identity differs from seal')
}
function validIdentity(value: unknown): value is FileIdentity {
  return exact(value, ['path', 'dev', 'ino']) && canonical(value.path)
    && Number.isSafeInteger(value.dev) && Number(value.dev) >= 0
    && Number.isSafeInteger(value.ino) && Number(value.ino) >= 0
}
function locations(stateRoot: string, sealPath: string, kind: Kind): void {
  owner()
  if (!canonical(stateRoot) || !canonical(sealPath) || !['repository', 'verification'].includes(kind)
    || sealPath === stateRoot || sealPath.startsWith(stateRoot + sep)
    || stateRoot.startsWith(sealPath + sep)) fail('invalid state or seal binding')
  privateDirectory(dirname(stateRoot)); privateDirectory(dirname(sealPath))
}

/** Pure shape validation. Filesystem ownership and the saved identities are
 * checked only by preparation or the strict runner's synchronous inspection. */
export function validateLinuxRunnerStateSeal(value: unknown): LinuxRunnerStateSeal {
  if (!exact(value, ['path', 'sha256']) || !canonical(value.path)
    || typeof value.sha256 !== 'string' || !hex.test(value.sha256)) fail('invalid seal reference')
  return { path: value.path, sha256: value.sha256 }
}

// immutable=1 is deliberate: a regular readOnly WAL connection can create shm
// and wal files. Only the checkpointed, fixed schema is read here, never live
// grants/jobs or a claim about their current budget. Initial-only preparation
// proves there is no pending WAL before and after checking for empty tables.
// The actual runner opens its original WAL normally after this identity gate.
function schema(path: string, empty: boolean): string {
  const info = privateFile(path)
  if (info.size < 100) fail('ledger is incomplete')
  const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true })
  try {
    if (db.prepare('PRAGMA user_version').get()?.user_version !== 8
      || db.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get()?.value !== '8') fail('ledger schema differs')
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all()
      .map(row => String(row.name))
    if (tables.join() !== ['isolation_audit', 'isolation_controller', 'isolation_grants', 'isolation_jobs', 'schema_meta', 'sqlite_sequence'].join())
      fail('ledger schema is incomplete')
    const required: Record<string, string[]> = {
      isolation_grants: ['id', 'digest', 'revision', 'expires_at', 'max_runs', 'max_total_duration_ms', 'revoked', 'revoke_reason', 'principal_digest', 'principal_record_id', 'principal_version', 'workspace', 'agent_preset'],
      isolation_jobs: ['id', 'grant_id', 'grant_revision', 'principal_digest', 'principal_record_id', 'principal_version', 'workspace', 'agent_preset', 'session_id', 'idempotency_key', 'request_digest', 'container_name', 'backend_kind', 'native_resource_id', 'native_nonce', 'deadline', 'reserved_duration_ms', 'reserved_memory_mib', 'reserved_workspace_inodes', 'reserved_storage_bytes', 'status', 'version', 'created_at', 'updated_at', 'result_json', 'dispatch_attempted', 'creation_witness_json', 'artifact_binding_json', 'linux_contract_json', 'linux_intent_json', 'linux_resources_json'],
      isolation_audit: ['sequence', 'occurred_at', 'action', 'job_id', 'grant_id', 'detail'],
      isolation_controller: ['singleton', 'owner_id', 'fence', 'expires_at'],
      schema_meta: ['key', 'value'], sqlite_sequence: ['name', 'seq'],
    }
    for (const [table, columns] of Object.entries(required)) {
      if (db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name)).join() !== columns.join())
        fail('ledger columns differ')
      if (empty && table !== 'schema_meta' && db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n !== 0)
        fail('initial-only ledger already contains authority or task history')
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM schema_meta').get()?.n !== 1) fail('ledger schema metadata differs')
    const rows = db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name').all()
    sameIdentity(privateFile(path), identity(path, info))
    return sha(JSON.stringify(rows))
  } finally { db.close() }
}

function noPendingWal(path: string): void {
  for (const suffix of ['-wal', '-shm']) {
    if (exists(path + suffix) && privateFile(path + suffix).size !== 0)
      fail('initial-only WAL state requires reconciliation')
  }
}
function emptySchema(path: string): string {
  // Immutable reads intentionally ignore WAL. They can prove empty history only
  // while both sidecars are absent or empty; a live writer never qualifies.
  noPendingWal(path)
  const digest = schema(path, true)
  noPendingWal(path)
  return digest
}

function readSeal(path: string): { body: SealBody; bytes: Buffer } {
  const before = privateFile(path, 16_384)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    sameIdentity(fstatSync(fd), identity(path, before))
    const bytes = readFileSync(fd)
    const body = JSON.parse(bytes.toString('utf8')) as unknown
    if (!exact(body, ['schemaVersion', 'protocol', 'id', 'kind', 'uid', 'stateRoot', 'ledger', 'ledgerSchemaVersion', 'schemaSha256'])
      || body.schemaVersion !== 1 || body.protocol !== 'dsh-linux-runner-state/v1'
      || typeof body.id !== 'string' || !uuid.test(body.id) || !['repository', 'verification'].includes(String(body.kind))
      || body.uid !== owner() || !validIdentity(body.stateRoot) || !validIdentity(body.ledger)
      || body.ledgerSchemaVersion !== 8 || typeof body.schemaSha256 !== 'string' || !hex.test(body.schemaSha256)) fail('seal body differs')
    sameIdentity(privateFile(path, 16_384), identity(path, before))
    return { body: body as unknown as SealBody, bytes }
  } finally { closeSync(fd) }
}

/** Existing-only inspection. A missing seal, root or ledger is never repaired. */
export function inspectLinuxRunnerState(input: { stateRoot: string; stateSeal: LinuxRunnerStateSeal; kind: Kind }): void {
  const ref = validateLinuxRunnerStateSeal(input.stateSeal)
  locations(input.stateRoot, ref.path, input.kind)
  const { body, bytes } = readSeal(ref.path)
  if (sha(bytes) !== ref.sha256 || body.kind !== input.kind || body.stateRoot.path !== input.stateRoot
    || body.ledger.path !== join(input.stateRoot, 'ledger.sqlite')) fail('seal reference or purpose differs')
  sameIdentity(privateDirectory(input.stateRoot), body.stateRoot)
  sameIdentity(privateFile(body.ledger.path), body.ledger)
  for (const suffix of ['-wal', '-shm']) if (exists(body.ledger.path + suffix)) privateFile(body.ledger.path + suffix)
  if (schema(body.ledger.path, false) !== body.schemaSha256) fail('ledger schema changed')
  sameIdentity(privateDirectory(input.stateRoot), body.stateRoot)
  sameIdentity(privateFile(body.ledger.path), body.ledger)
}

/** Initialize empty state before owner grants exist. Callers create both private
 * directories first and freeze the returned reference in the owner config.
 * An existing unsealed used ledger requires a separate authorized migration.
 * Initial installation must pass requireEmpty even when a seal already exists:
 * losing the outer owner configuration never makes used state a new install. */
export function prepareLinuxRunnerState(input: { stateRoot: string; sealPath: string; kind: Kind;
  requireEmpty?: boolean }): LinuxRunnerStateSeal {
  if (input.requireEmpty !== undefined && typeof input.requireEmpty !== 'boolean') fail('invalid initial-only requirement')
  locations(input.stateRoot, input.sealPath, input.kind)
  const root = privateDirectory(input.stateRoot)
  if (exists(input.sealPath)) {
    const { bytes } = readSeal(input.sealPath), ref = { path: input.sealPath, sha256: sha(bytes) }
    inspectLinuxRunnerState({ stateRoot: input.stateRoot, stateSeal: ref, kind: input.kind })
    if (input.requireEmpty) {
      emptySchema(join(input.stateRoot, 'ledger.sqlite'))
      inspectLinuxRunnerState({ stateRoot: input.stateRoot, stateSeal: ref, kind: input.kind })
    }
    return ref
  }
  const ledgerPath = join(input.stateRoot, 'ledger.sqlite')
  if (readdirSync(input.stateRoot).some(name => !['ledger.sqlite', 'ledger.sqlite-wal', 'ledger.sqlite-shm'].includes(name)))
    fail('unsealed state is not an empty preparation')
  noPendingWal(ledgerPath)
  if (!exists(ledgerPath)) {
    if (readdirSync(input.stateRoot).length) fail('unsealed ledger is missing')
    const reserved = openSync(ledgerPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    closeSync(reserved)
    const ledger = new IsolationLedger(ledgerPath)
    ledger.close()
  }
  const schemaSha256 = emptySchema(ledgerPath), ledger = privateFile(ledgerPath)
  sameIdentity(privateDirectory(input.stateRoot), identity(input.stateRoot, root))
  syncFile(ledgerPath); syncFile(input.stateRoot, true)
  const body: SealBody = { schemaVersion: 1, protocol: 'dsh-linux-runner-state/v1', id: randomUUID(),
    kind: input.kind, uid: owner(), stateRoot: identity(input.stateRoot, root), ledger: identity(ledgerPath, ledger),
    ledgerSchemaVersion: 8, schemaSha256 }
  const bytes = Buffer.from(JSON.stringify(body) + '\n'), temporary = join(dirname(input.sealPath), `.${randomUUID()}.tmp`)
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    writeFileSync(fd, bytes); fsyncSync(fd)
    // link is an atomic no-replace publication; never overwrite a raced seal.
    linkSync(temporary, input.sealPath)
  } finally {
    closeSync(fd)
    unlinkSync(temporary)
  }
  syncFile(dirname(input.sealPath), true)
  const ref = { path: input.sealPath, sha256: sha(bytes) }
  inspectLinuxRunnerState({ stateRoot: input.stateRoot, stateSeal: ref, kind: input.kind })
  return ref
}
