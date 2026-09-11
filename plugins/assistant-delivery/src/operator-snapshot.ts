import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { canonicalConversation, canonicalPrincipal } from './canonical.js'
import { deliverySchemaVersion } from './sqlite.js'
import type { ConversationBinding, DeliveryPrincipal, ExternalPrincipalKey } from './types.js'

export interface ActiveWebOwnerBindingQuery {
  databasePath: string
  sessionId: string
  expectedPrincipal: ExternalPrincipalKey
  workspace: string
  agentPreset: string
}

export interface ActiveWebOwnerBindingSnapshot {
  readonly binding: Readonly<ConversationBinding>
  readonly owner: Readonly<DeliveryPrincipal>
}

export type ActiveWebOwnerBindingInspection =
  | Readonly<{ status: 'matched'; snapshot: ActiveWebOwnerBindingSnapshot }>
  | Readonly<{ status: 'unavailable' | 'mismatch' | 'busy' }>

type Row = {
  binding_id: string; conversation_json: string; binding_principal_json: string; workspace: string; agent_preset: string
  session_id: string; generation: number; policy_ref: string; binding_status: string; binding_created_at: number; binding_updated_at: number; binding_version: number
  owner_id: string; owner_principal_json: string; owner_role: string; owner_status: string; linked_to_id: string | null; owner_created_at: number; owner_updated_at: number; owner_version: number
  lease_state: string | null
}

function unavailable(): ActiveWebOwnerBindingInspection { return Object.freeze({ status: 'unavailable' }) }
function mismatch(): ActiveWebOwnerBindingInspection { return Object.freeze({ status: 'mismatch' }) }
function policyRef(value: unknown): value is string {
  return typeof value === 'string' && value === value.normalize('NFC').trim() && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 256 && ![...value].some(character => (character.codePointAt(0) ?? 0) <= 0x1f || character.codePointAt(0) === 0x7f)
}
function privateDatabase(path: string): string | undefined {
  try {
    if (!isAbsolute(path)) return undefined
    const entry = lstatSync(path)
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || (entry.mode & 0o077) !== 0) return undefined
    const parent = realpathSync(dirname(path)); const resolved = realpathSync(path)
    if (resolved !== join(parent, basename(path))) return undefined
    const directory = statSync(parent)
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0) return undefined
    return resolved
  } catch { return undefined }
}
function number(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min }
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
function identifier(value: unknown, prefix: string): value is string { return typeof value === 'string' && new RegExp(`^${prefix}[0-9a-f-]{8,}$`, 'u').test(value) }

function inspectRow(input: ActiveWebOwnerBindingQuery, expected: ExternalPrincipalKey, row: Row): ActiveWebOwnerBindingInspection {
  if (row.lease_state !== null && row.lease_state !== 'released') return Object.freeze({ status: 'busy' })
  const conversation = canonicalConversation(JSON.parse(row.conversation_json))
  const bindingPrincipal = canonicalPrincipal(JSON.parse(row.binding_principal_json))
  const ownerPrincipal = canonicalPrincipal(JSON.parse(row.owner_principal_json))
  const expectedConversation = { channel: 'web', account: expected.account, tenant: expected.tenant, kind: 'dm' as const, chat: input.sessionId }
  if (row.conversation_json !== JSON.stringify(conversation) || row.binding_principal_json !== JSON.stringify(bindingPrincipal) || row.owner_principal_json !== JSON.stringify(ownerPrincipal)
    || !equal(conversation, expectedConversation) || row.session_id !== input.sessionId || !identifier(row.binding_id, 'binding_') || !identifier(row.owner_id, 'principal_')
    || bindingPrincipal.channel !== 'web' || !equal(bindingPrincipal, expected) || !equal(ownerPrincipal, expected)
    || row.binding_status !== 'active' || row.owner_role !== 'owner' || row.owner_status !== 'active' || row.linked_to_id !== null
    || row.workspace !== input.workspace || row.agent_preset !== input.agentPreset || !policyRef(row.policy_ref)
    || ![row.generation, row.binding_version, row.owner_version].every(value => number(value, 1))
    || ![row.binding_created_at, row.binding_updated_at, row.owner_created_at, row.owner_updated_at].every(value => number(value))) return mismatch()
  const binding: ConversationBinding = Object.freeze({ id: row.binding_id, conversation: Object.freeze(conversation), principal: Object.freeze(bindingPrincipal), workspace: row.workspace,
    agentPreset: row.agent_preset, sessionId: row.session_id, generation: row.generation, policyRef: row.policy_ref, status: 'active', createdAt: row.binding_created_at, updatedAt: row.binding_updated_at, version: row.binding_version })
  const owner: DeliveryPrincipal = Object.freeze({ id: row.owner_id, principal: Object.freeze(ownerPrincipal), role: 'owner', status: 'active', createdAt: row.owner_created_at, updatedAt: row.owner_updated_at, version: row.owner_version })
  return Object.freeze({ status: 'matched', snapshot: Object.freeze({ binding, owner }) })
}

/**
 * Opens an already-existing Delivery database read-only. It never invokes the Delivery migrator,
 * creates a database, pairs an owner, reads message content, or acquires a Session lease.
 */
export function inspectActiveWebOwnerBindingLocally(input: ActiveWebOwnerBindingQuery): ActiveWebOwnerBindingInspection {
  let expected: ExternalPrincipalKey
  try {
    expected = canonicalPrincipal(input.expectedPrincipal)
    if (expected.channel !== 'web' || !isAbsolute(input.workspace) || typeof input.agentPreset !== 'string' || input.agentPreset.length === 0 || typeof input.sessionId !== 'string' || input.sessionId.length === 0) return mismatch()
  } catch { return mismatch() }
  const path = privateDatabase(input.databasePath)
  if (path === undefined) return unavailable()
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100')
    database.exec('BEGIN')
    const version = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
    if (version.user_version !== deliverySchemaVersion) return unavailable()
    const rows = database.prepare(`
      SELECT binding.id AS binding_id, binding.conversation_json, binding.principal_json AS binding_principal_json,
        binding.workspace, binding.agent_preset, binding.session_id, binding.generation, binding.policy_ref,
        binding.status AS binding_status, binding.created_at AS binding_created_at, binding.updated_at AS binding_updated_at, binding.version AS binding_version,
        owner.id AS owner_id, owner.principal_json AS owner_principal_json, owner.role AS owner_role, owner.status AS owner_status,
        owner.linked_to_id, owner.created_at AS owner_created_at, owner.updated_at AS owner_updated_at, owner.version AS owner_version,
        lease.state AS lease_state
      FROM conversation_bindings AS binding
      JOIN delivery_principals AS owner ON owner.id = binding.principal_id
      LEFT JOIN delivery_session_leases AS lease ON lease.session_id = binding.session_id
      WHERE binding.session_id = ?
      LIMIT 2
    `).all(input.sessionId) as Row[]
    if (rows.length !== 1) return mismatch()
    const row = rows[0]!
    return inspectRow(input, expected, row)
  } catch (error) {
    if (error instanceof Error && /(?:busy|locked)/iu.test(error.message)) return Object.freeze({ status: 'busy' })
    return unavailable()
  } finally {
    try { database?.exec('ROLLBACK') } catch {}
    try { database?.close() } catch {}
  }
}


export type ActiveIdleWebOwnerBindingsInspection =
  | Readonly<{ status: 'matched'; snapshots: readonly ActiveWebOwnerBindingSnapshot[] }>
  | Readonly<{ status: 'unavailable'; reason: 'invalid-scope' | 'snapshot-unavailable' | 'too-many-sessions' }>

/** Bounded operator discovery in one read-only snapshot; it creates no sessions or bindings. */
export function listActiveIdleWebOwnerBindingsLocally(input: Omit<ActiveWebOwnerBindingQuery, 'sessionId'>): ActiveIdleWebOwnerBindingsInspection {
  let expected: ExternalPrincipalKey
  try {
    expected = canonicalPrincipal(input.expectedPrincipal)
    if (expected.channel !== 'web' || !isAbsolute(input.workspace) || typeof input.agentPreset !== 'string' || !input.agentPreset) return { status: 'unavailable', reason: 'invalid-scope' }
  } catch { return { status: 'unavailable', reason: 'invalid-scope' } }
  const path = privateDatabase(input.databasePath)
  if (!path) return { status: 'unavailable', reason: 'snapshot-unavailable' }
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true })
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 100; BEGIN')
    if ((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !== deliverySchemaVersion) return { status: 'unavailable', reason: 'snapshot-unavailable' }
    const rows = database.prepare(`
      SELECT binding.id AS binding_id, binding.conversation_json, binding.principal_json AS binding_principal_json,
        binding.workspace, binding.agent_preset, binding.session_id, binding.generation, binding.policy_ref,
        binding.status AS binding_status, binding.created_at AS binding_created_at, binding.updated_at AS binding_updated_at, binding.version AS binding_version,
        owner.id AS owner_id, owner.principal_json AS owner_principal_json, owner.role AS owner_role, owner.status AS owner_status,
        owner.linked_to_id, owner.created_at AS owner_created_at, owner.updated_at AS owner_updated_at, owner.version AS owner_version,
        lease.state AS lease_state
      FROM conversation_bindings AS binding
      JOIN delivery_principals AS owner ON owner.id = binding.principal_id
      LEFT JOIN delivery_session_leases AS lease ON lease.session_id = binding.session_id
      WHERE owner.principal_json = ? AND binding.workspace = ? AND binding.agent_preset = ?
        AND owner.role = 'owner' AND owner.status = 'active' AND binding.status = 'active'
        AND (lease.state IS NULL OR lease.state = 'released')
      ORDER BY binding.session_id LIMIT 101
    `).all(JSON.stringify(expected), input.workspace, input.agentPreset) as Row[]
    if (rows.length > 100) return { status: 'unavailable', reason: 'too-many-sessions' }
    const snapshots: ActiveWebOwnerBindingSnapshot[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      if (seen.has(row.session_id)) return { status: 'unavailable', reason: 'snapshot-unavailable' }
      const checked = inspectRow({ ...input, sessionId: row.session_id }, expected, row)
      if (checked.status !== 'matched') return { status: 'unavailable', reason: 'snapshot-unavailable' }
      seen.add(row.session_id); snapshots.push(checked.snapshot)
    }
    return Object.freeze({ status: 'matched', snapshots: Object.freeze(snapshots) })
  } catch { return { status: 'unavailable', reason: 'snapshot-unavailable' } }
  finally { try { database?.exec('ROLLBACK') } catch {} try { database?.close() } catch {} }
}

export const activeLarkOwnerBindingsSnapshotProtocol
  = 'assistant-delivery/active-lark-owner-bindings-snapshot/v1' as const

export interface ActiveLarkOwnerBindingsQuery {
  databasePath: string
  account: string
  tenant: string
  workspace: string
  agentPreset: string
}

export interface DeliveryOperatorFileIdentity {
  readonly device: string
  readonly inode: string
  readonly size: string
  readonly mtimeNs: string
  readonly digest: string
}

/** Full durable authority metadata for one matching binding; no message content is exposed. */
export interface ActiveLarkOwnerBinding extends Readonly<ConversationBinding> {
  readonly owner: Readonly<DeliveryPrincipal>
}

export interface ActiveLarkOwnerBindingsSnapshot {
  readonly protocol: typeof activeLarkOwnerBindingsSnapshotProtocol
  readonly schemaVersion: typeof deliverySchemaVersion
  readonly scope: Readonly<Omit<ActiveLarkOwnerBindingsQuery, 'databasePath'>>
  readonly database: DeliveryOperatorFileIdentity
  readonly sidecars: Readonly<{
    wal: DeliveryOperatorFileIdentity | null
    shm: DeliveryOperatorFileIdentity | null
  }>
  /** Digest of the exact main database and WAL bytes represented by this snapshot. */
  readonly storageDigest: string
  /** Bounded, binary-id-ordered complete set of exact active owner Lark DM matches. */
  readonly bindings: readonly ActiveLarkOwnerBinding[]
  /** Canonical SHA-256 consistency digest; this is not an authenticity attestation. */
  readonly snapshotDigest: string
}

export type ActiveLarkOwnerBindingsSnapshotErrorCode
  = | 'invalid-path'
    | 'invalid-scope'
    | 'database-missing'
    | 'unsafe-path'
    | 'unsafe-parent'
    | 'database-busy'
    | 'schema-unsupported'
    | 'database-corrupt'
    | 'database-drift'
    | 'too-many-bindings'

export class ActiveLarkOwnerBindingsSnapshotError extends Error {
  constructor(readonly code: ActiveLarkOwnerBindingsSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'ActiveLarkOwnerBindingsSnapshotError'
  }
}

interface OperatorFile {
  readonly path: string
  readonly descriptor: number
  readonly stat: BigIntStats
  readonly digest: string
}

interface OperatorPinnedParent {
  readonly path: string
  readonly descriptor: number
  readonly device: bigint
  readonly inode: bigint
  readonly mode: bigint
}

interface OperatorPinnedTemp {
  readonly path: string
  readonly descriptor: number
  readonly device: bigint
  readonly inode: bigint
}

interface LarkOwnerRow extends Row {
  conversation_hash: unknown
  principal_id: unknown
  owner_key_hash: unknown
}

const operatorDigestPattern = /^[a-f0-9]{64}$/u
const operatorKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,255}$/u
const operatorMaximumBindings = 100
const operatorBufferBytes = 64 * 1024

function operatorFail(code: ActiveLarkOwnerBindingsSnapshotErrorCode, message: string): never {
  throw new ActiveLarkOwnerBindingsSnapshotError(code, `delivery Lark owner snapshot: ${message}`)
}

function operatorFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) operatorFreeze(child)
    Object.freeze(value)
  }
  return value
}

function operatorCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(operatorCanonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${operatorCanonicalJson(record[key])}`).join(',')}}`
}

function operatorSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function operatorSameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
}

function operatorDigestDescriptor(descriptor: number, size: bigint): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(operatorBufferBytes)
  let position = 0n
  while (position < size) {
    const remaining = size - position
    const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
    const count = readSync(descriptor, buffer, 0, length, Number(position))
    if (count <= 0) operatorFail('database-drift', 'a storage file changed while it was hashed')
    hash.update(buffer.subarray(0, count)); position += BigInt(count)
  }
  return hash.digest('hex')
}

function operatorFileIdentity(file: OperatorFile): DeliveryOperatorFileIdentity {
  return operatorFreeze({
    device: file.stat.dev.toString(), inode: file.stat.ino.toString(), size: file.stat.size.toString(),
    mtimeNs: file.stat.mtimeNs.toString(), digest: file.digest,
  })
}

function operatorPinPrivateParent(path: string): OperatorPinnedParent {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      operatorFail('database-missing', 'database parent disappeared before the snapshot')
    }
    operatorFail('unsafe-parent', 'database parent is unavailable')
  }
  try {
    const pathname = lstatSync(path, { bigint: true })
    const metadata = fstatSync(descriptor, { bigint: true })
    const uid = process.getuid?.()
    const physical = realpathSync(path)
    if (!pathname.isDirectory() || pathname.isSymbolicLink() || !metadata.isDirectory()
      || pathname.dev !== metadata.dev || pathname.ino !== metadata.ino || physical !== path
      || uid === undefined || metadata.uid !== BigInt(uid)
      || (metadata.mode & 0o7077n) !== 0n || (metadata.mode & 0o500n) !== 0o500n) {
      operatorFail('unsafe-parent', 'database parent must be a private owner directory without symlinks')
    }
    const pinned = { path, descriptor, device: metadata.dev, inode: metadata.ino, mode: metadata.mode }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
    operatorFail('unsafe-parent', 'database parent cannot be resolved')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  throw new Error('unreachable')
}

function operatorPinnedParentMatches(parent: OperatorPinnedParent): boolean {
  try {
    const pathname = lstatSync(parent.path, { bigint: true })
    const descriptor = fstatSync(parent.descriptor, { bigint: true })
    return pathname.isDirectory() && !pathname.isSymbolicLink() && descriptor.isDirectory()
      && pathname.dev === parent.device && pathname.ino === parent.inode
      && descriptor.dev === parent.device && descriptor.ino === parent.inode
      && descriptor.mode === parent.mode
  } catch {
    return false
  }
}

// Inode binding is enforced through Linux /proc/self/fd. On other platforms the
// snapshot keeps its historical path-based pinning; CI still exercises that code.
const operatorInodeBindSupported = process.platform === 'linux'
const operatorProcSelfFd = '/proc/self/fd'

/**
 * Enumerate the regular-file inodes held by THIS process, excluding the
 * descriptors the snapshot pinned itself. After the exclusion the only
 * remaining database fds are SQLite's, so a (dev,ino) match proves the
 * connection genuinely opened the pinned inode rather than an attacker's
 * same-name replacement. An attacker in another process cannot plant an fd
 * here because /proc/self/fd never lists another process's descriptors.
 */
function operatorConnectionInodes(exclude: ReadonlySet<number>): Array<{ device: bigint; inode: bigint }> {
  let entries: string[]
  try { entries = readdirSync(operatorProcSelfFd) } catch {
    operatorFail('database-corrupt', 'cannot inspect the database connection file descriptors')
  }
  const inodes: Array<{ device: bigint; inode: bigint }> = []
  for (const entry of entries) {
    const descriptor = Number(entry)
    if (!Number.isInteger(descriptor) || descriptor <= 2 || exclude.has(descriptor)) continue
    let stat: BigIntStats
    try { stat = fstatSync(descriptor, { bigint: true }) } catch { continue } // transient/closed fd
    if (stat.isFile()) inodes.push({ device: stat.dev, inode: stat.ino })
  }
  return inodes
}

function operatorAssertConnectionBound(files: readonly OperatorFile[], exclude: ReadonlySet<number>): void {
  const held = operatorConnectionInodes(exclude)
  for (const file of files) {
    if (!held.some(inode => inode.device === file.stat.dev && inode.inode === file.stat.ino)) {
      operatorFail('database-drift', 'database connection is not bound to the pinned inode')
    }
  }
}

/** Pin the private mkdtemp copy directory itself so a same-name swap cannot retarget the copies. */
function operatorPinTempDirectory(path: string): OperatorPinnedTemp {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const linked = lstatSync(path, { bigint: true })
    const opened = fstatSync(descriptor, { bigint: true })
    const uid = process.getuid?.()
    if (!linked.isDirectory() || linked.isSymbolicLink() || !opened.isDirectory()
      || linked.dev !== opened.dev || linked.ino !== opened.ino
      || (opened.mode & 0o7777n) !== 0o700n
      || uid === undefined || opened.uid !== BigInt(uid)) {
      operatorFail('unsafe-path', 'temporary snapshot directory cannot be pinned')
    }
    const pinned = { path, descriptor, device: opened.dev, inode: opened.ino }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
    operatorFail('unsafe-path', 'temporary snapshot directory cannot be pinned')
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
  }
  throw new Error('unreachable')
}

/**
 * Materialise one private byte-for-byte copy THROUGH the pinned directory fd
 * (`/proc/self/fd/<dirfd>/<name>`), then reopen it O_NOFOLLOW through the same
 * anchor and keep that descriptor open. Neither the create, the verify, the
 * SQLite open, or the cleanup ever resolve a swappable path component, so a
 * same-name directory swap cannot retarget the replica. The returned file is
 * left open and must be closed by the caller.
 */
function operatorCopyAndPin(source: OperatorFile, targetRef: string): OperatorFile {
  const buffer = Buffer.allocUnsafe(operatorBufferBytes)
  let destination: number | undefined
  try {
    destination = openSync(targetRef, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let position = 0n
    while (position < source.stat.size) {
      const remaining = source.stat.size - position
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
      const count = readSync(source.descriptor, buffer, 0, length, Number(position))
      if (count <= 0) operatorFail('database-drift', `${basename(source.path)} changed while it was copied`)
      let written = 0
      while (written < count) written += writeSync(destination!, buffer, written, count - written)
      position += BigInt(count)
    }
  } catch (error) {
    if (destination !== undefined) try { closeSync(destination) } catch {}
    if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
    throw error
  }
  if (destination !== undefined) closeSync(destination)
  const copied = operatorOpenPrivateFile(targetRef, false)
  if (copied.stat.size !== source.stat.size || copied.digest !== source.digest) {
    try { closeSync(copied.descriptor) } catch {}
    operatorFail('database-drift', `${basename(source.path)} copy does not match its pinned source`)
  }
  return copied
}

/**
 * Remove the replica THROUGH the pinned directory fd, unlinking only the fixed
 * names SQLite could create. The directory itself is rmdir'd by path only after
 * the pinned fd proves the path still names the same empty inode; a swapped or
 * non-empty directory is left untouched and the snapshot fails closed rather
 * than recursively deleting an attacker-controlled replacement.
 */
function operatorRemovePinnedTemp(pinned: OperatorPinnedTemp, names: readonly string[]): void {
  const anchor = `${operatorProcSelfFd}/${pinned.descriptor}`
  for (const name of names) {
    try { unlinkSync(`${anchor}/${name}`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        operatorFail('database-drift', 'temporary snapshot copy cannot be removed through its pinned directory')
      }
    }
  }
  let entries: string[]
  try { entries = readdirSync(anchor) } catch {
    operatorFail('database-drift', 'temporary snapshot directory became unavailable')
  }
  if (entries.length !== 0) operatorFail('database-drift', 'temporary snapshot directory contains unexpected entries')
  const linked = lstatSync(pinned.path, { bigint: true })
  const opened = fstatSync(pinned.descriptor, { bigint: true })
  if (linked.dev !== pinned.device || linked.ino !== pinned.inode
    || opened.dev !== pinned.device || opened.ino !== pinned.inode) {
    operatorFail('database-drift', 'temporary snapshot directory was retargeted before cleanup')
  }
  closeSync(pinned.descriptor)
  try {
    rmdirSync(pinned.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      operatorFail('database-drift', 'temporary snapshot directory could not be removed')
    }
  }
}

function operatorOpenPrivateFile(path: string, missing: boolean): OperatorFile {
  let linked: BigIntStats
  try { linked = lstatSync(path, { bigint: true }) } catch (error) {
    if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') operatorFail('database-missing', 'database does not exist')
    operatorFail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  const uid = process.getuid?.()
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n
    || (linked.mode & 0o7777n) !== 0o600n
    || (uid !== undefined && linked.uid !== BigInt(uid))
    || linked.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    operatorFail('unsafe-path', `${basename(path)} must be one private owned regular file`)
  }
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)) } catch {
    operatorFail('unsafe-path', `${basename(path)} cannot be opened safely`)
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true }); const after = lstatSync(path, { bigint: true })
    if (!operatorSameFile(linked, opened) || !operatorSameFile(opened, after)) {
      operatorFail('database-drift', `${basename(path)} changed while it was opened`)
    }
    const digest = operatorDigestDescriptor(descriptor, opened.size)
    if (!operatorSameFile(opened, fstatSync(descriptor, { bigint: true }))) {
      operatorFail('database-drift', `${basename(path)} changed while it was hashed`)
    }
    return { path, descriptor, stat: opened, digest }
  } catch (error) {
    closeSync(descriptor); throw error
  }
}

function operatorOptionalFile(path: string): OperatorFile | null {
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    operatorFail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  return operatorOpenPrivateFile(path, false)
}

function operatorPinnedFileIdentityMatches(file: OperatorFile): boolean {
  try {
    const pathname = lstatSync(file.path, { bigint: true })
    const opened = fstatSync(file.descriptor, { bigint: true })
    return pathname.isFile() && !pathname.isSymbolicLink()
      && pathname.dev === file.stat.dev && pathname.ino === file.stat.ino
      && opened.dev === file.stat.dev && opened.ino === file.stat.ino
  } catch {
    return false
  }
}

function operatorAssertUnchanged(file: OperatorFile): void {
  try {
    const linked = lstatSync(file.path, { bigint: true }); const opened = fstatSync(file.descriptor, { bigint: true })
    if (!operatorSameFile(file.stat, linked) || !operatorSameFile(file.stat, opened)
      || operatorDigestDescriptor(file.descriptor, opened.size) !== file.digest) {
      operatorFail('database-drift', `${basename(file.path)} changed during the snapshot`)
    }
  } catch (error) {
    if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
    operatorFail('database-drift', `${basename(file.path)} changed during the snapshot`)
  }
}

function operatorAssertSidecar(path: string, file: OperatorFile | null): void {
  if (file !== null) return operatorAssertUnchanged(file)
  try {
    lstatSync(path); operatorFail('database-drift', `${basename(path)} appeared during the snapshot`)
  } catch (error) {
    if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      operatorFail('database-drift', `${basename(path)} changed during the snapshot`)
    }
  }
}

function operatorDatabasePath(path: unknown): string {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/'
    || path !== path.normalize('NFC') || /[\p{Cc}]/u.test(path)) {
    operatorFail('invalid-path', 'database path must be canonical and absolute')
  }
  let physical: string
  try { physical = realpathSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') operatorFail('database-missing', 'database does not exist')
    operatorFail('unsafe-path', 'database path cannot be resolved')
  }
  let parentPhysical: string
  try { parentPhysical = realpathSync(dirname(path)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') operatorFail('database-missing', 'database parent disappeared')
    operatorFail('unsafe-path', 'database parent cannot be resolved')
  }
  if (physical !== path || parentPhysical !== dirname(path)) {
    operatorFail('unsafe-path', 'database path must not traverse a symbolic link')
  }
  return physical
}

function operatorScope(input: ActiveLarkOwnerBindingsQuery): Readonly<Omit<ActiveLarkOwnerBindingsQuery, 'databasePath'>> {
  const validKey = (value: unknown) => typeof value === 'string' && value === value.normalize('NFC').trim()
    && operatorKeyPattern.test(value)
  const validText = (value: unknown, maximum: number) => typeof value === 'string' && value.length > 0
    && value === value.normalize('NFC').trim() && Buffer.byteLength(value, 'utf8') <= maximum
    && !/[\p{Cc}]/u.test(value)
  if (!validKey(input.account) || !validKey(input.tenant)
    || !validText(input.workspace, 4_096) || !isAbsolute(input.workspace) || resolve(input.workspace) !== input.workspace
    || !validText(input.agentPreset, 128)) operatorFail('invalid-scope', 'query scope is invalid')
  return operatorFreeze({ account: input.account, tenant: input.tenant, workspace: input.workspace, agentPreset: input.agentPreset })
}

function operatorCopyFile(source: OperatorFile, target: string): void {
  const buffer = Buffer.allocUnsafe(operatorBufferBytes)
  let destination: number | undefined
  try {
    destination = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let position = 0n
    while (position < source.stat.size) {
      const remaining = source.stat.size - position
      const length = Number(remaining > BigInt(buffer.length) ? BigInt(buffer.length) : remaining)
      const count = readSync(source.descriptor, buffer, 0, length, Number(position))
      if (count <= 0) operatorFail('database-drift', `${basename(source.path)} changed while it was copied`)
      let written = 0
      while (written < count) written += writeSync(destination, buffer, written, count - written)
      position += BigInt(count)
    }
  } finally {
    if (destination !== undefined) closeSync(destination)
  }
  // Close the write window, then re-open the private copy as an independent
  // file and prove its bytes equal the pinned source before it is ever read.
  const copied = operatorOpenPrivateFile(target, false)
  try {
    if (copied.stat.size !== source.stat.size || copied.digest !== source.digest) {
      operatorFail('database-drift', `${basename(source.path)} copy does not match its pinned source`)
    }
  } finally { closeSync(copied.descriptor) }
}

function operatorText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC').trim()
    && Buffer.byteLength(value, 'utf8') <= maximum && !/[\p{Cc}]/u.test(value)
}

function operatorInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function operatorBinding(row: LarkOwnerRow, scope: ActiveLarkOwnerBindingsSnapshot['scope']): ActiveLarkOwnerBinding {
  let conversation: ReturnType<typeof canonicalConversation>; let principal: ReturnType<typeof canonicalPrincipal>
  try {
    if (typeof row.conversation_json !== 'string' || typeof row.binding_principal_json !== 'string'
      || typeof row.owner_principal_json !== 'string') throw new Error('invalid JSON metadata')
    conversation = canonicalConversation(JSON.parse(row.conversation_json))
    principal = canonicalPrincipal(JSON.parse(row.binding_principal_json))
    const ownerPrincipal = canonicalPrincipal(JSON.parse(row.owner_principal_json))
    if (row.conversation_json !== JSON.stringify(conversation)
      || row.binding_principal_json !== JSON.stringify(principal)
      || row.owner_principal_json !== JSON.stringify(ownerPrincipal)
      || !equal(principal, ownerPrincipal)) throw new Error('non-canonical identity metadata')
  } catch { return operatorFail('database-corrupt', 'a matching binding has invalid canonical identity metadata') }
  if (conversation.channel !== 'lark' || conversation.account !== scope.account
    || conversation.tenant !== scope.tenant || conversation.kind !== 'dm' || conversation.thread !== undefined
    || principal.channel !== 'lark' || principal.account !== scope.account || principal.tenant !== scope.tenant
    || row.workspace !== scope.workspace || row.agent_preset !== scope.agentPreset
    || row.binding_status !== 'active' || row.owner_role !== 'owner' || row.owner_status !== 'active'
    || row.linked_to_id !== null || !identifier(row.binding_id, 'binding_') || !identifier(row.owner_id, 'principal_')
    || row.principal_id !== row.owner_id || !operatorDigestPattern.test(String(row.conversation_hash))
    || !operatorDigestPattern.test(String(row.owner_key_hash))
    || row.conversation_hash !== operatorSha256(row.conversation_json)
    || row.owner_key_hash !== operatorSha256(row.owner_principal_json)
    || !operatorText(row.session_id, 512) || !operatorText(row.policy_ref, 256)
    || !operatorInteger(row.generation, 1) || !operatorInteger(row.binding_version, 1)
    || !operatorInteger(row.owner_version, 1) || !operatorInteger(row.binding_created_at)
    || !operatorInteger(row.binding_updated_at) || row.binding_updated_at < row.binding_created_at
    || !operatorInteger(row.owner_created_at) || !operatorInteger(row.owner_updated_at)
    || row.owner_updated_at < row.owner_created_at) {
    operatorFail('database-corrupt', 'a matching binding row is inconsistent')
  }
  const owner: DeliveryPrincipal = { id: row.owner_id, principal, role: 'owner', status: 'active',
    createdAt: row.owner_created_at, updatedAt: row.owner_updated_at, version: row.owner_version }
  return operatorFreeze({
    id: row.binding_id, conversation, principal, workspace: row.workspace, agentPreset: row.agent_preset,
    sessionId: row.session_id, generation: row.generation, policyRef: row.policy_ref, status: 'active',
    createdAt: row.binding_created_at, updatedAt: row.binding_updated_at, version: row.binding_version, owner,
  })
}

function operatorClassifySqlite(error: unknown): never {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const code = (error as { errcode?: unknown }).errcode
  if (code === 5 || code === 6 || /(?:busy|locked)/u.test(message)) operatorFail('database-busy', 'database is busy')
  operatorFail('database-corrupt', 'database cannot produce a valid snapshot')
}

/**
 * Produces one exact, content-free Lark owner-DM inventory without opening a
 * writable connection to the source. A temporary private byte-for-byte view
 * is used when WAL state exists so SQLite cannot update the source WAL index.
 */
export function inspectActiveLarkOwnerBindingsLocally(input: ActiveLarkOwnerBindingsQuery): ActiveLarkOwnerBindingsSnapshot {
  const scope = operatorScope(input); const path = operatorDatabasePath(input.databasePath)
  // Pin the private parent directory for the whole snapshot so an ancestor
  // rename or a same-name directory swap cannot retarget the database path
  // between the path checks and the read.
  const pinnedParent = operatorPinPrivateParent(dirname(path)); const walPath = `${path}-wal`; const shmPath = `${path}-shm`
  let source: OperatorFile | undefined
  let wal: OperatorFile | null = null; let shm: OperatorFile | null = null
  let temporaryPath: string | undefined; let temporaryPinned: OperatorPinnedTemp | undefined
  let copyFiles: readonly OperatorFile[] = []
  let database: DatabaseSync | undefined; let transaction = false; let deferred: unknown
  let result: ActiveLarkOwnerBindingsSnapshot | undefined
  // Descriptors the snapshot itself holds; these are excluded when proving that
  // SQLite opened the pinned inode, so the connection can never vouch for itself.
  const selfDescriptors = (): ReadonlySet<number> => new Set([
    pinnedParent.descriptor, source?.descriptor, wal?.descriptor, shm?.descriptor,
    temporaryPinned?.descriptor, ...copyFiles.map(file => file.descriptor),
  ].filter((descriptor): descriptor is number => descriptor !== undefined))
  try {
    try { lstatSync(`${path}-journal`); operatorFail('database-busy', 'database has a rollback journal') } catch (error) {
      if (error instanceof ActiveLarkOwnerBindingsSnapshotError) throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') operatorFail('unsafe-path', 'rollback journal cannot be inspected')
    }
    source = operatorOpenPrivateFile(path, true)
    wal = operatorOptionalFile(walPath); shm = operatorOptionalFile(shmPath)
    if ((wal === null) !== (shm === null)) operatorFail('database-drift', 'WAL sidecar set is incomplete')
    operatorAssertUnchanged(source); operatorAssertSidecar(walPath, wal); operatorAssertSidecar(shmPath, shm)
    // Files SQLite must prove it is reading. Without WAL that is the pinned
    // source inode; with WAL it is the pinned private replica inodes.
    let bound: readonly OperatorFile[] = []
    let target: string
    if (wal === null) {
      // Open the pinned descriptor itself by inode (Linux) so a same-name swap
      // cannot retarget the connection; immutable=1 forbids WAL/journal access.
      target = operatorInodeBindSupported
        ? `file://${operatorProcSelfFd}/${source.descriptor}?mode=ro&immutable=1`
        : `${pathToFileURL(path).href}?immutable=1`
      bound = [source]
    } else {
      temporaryPath = mkdtempSync(join(tmpdir(), 'delivery-operator-snapshot-'))
      const temporaryMetadata = lstatSync(temporaryPath, { bigint: true })
      const temporaryUid = process.getuid?.()
      if (!temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink()
        || (temporaryMetadata.mode & 0o7777n) !== 0o700n
        || (temporaryUid !== undefined && temporaryMetadata.uid !== BigInt(temporaryUid))) {
        operatorFail('unsafe-path', 'temporary snapshot directory is not private')
      }
      if (operatorInodeBindSupported) {
        temporaryPinned = operatorPinTempDirectory(temporaryPath)
        const anchor = `${operatorProcSelfFd}/${temporaryPinned.descriptor}`
        const mainRef = `${anchor}/delivery.sqlite`
        const copiedMain = operatorCopyAndPin(source, mainRef)
        let copiedWal: OperatorFile | undefined
        try { copiedWal = operatorCopyAndPin(wal, `${mainRef}-wal`) }
        catch (error) { try { closeSync(copiedMain.descriptor) } catch {}; throw error }
        copyFiles = Object.freeze([copiedMain, copiedWal])
        target = mainRef
        bound = copyFiles
      } else {
        const copy = join(temporaryPath, 'delivery.sqlite')
        operatorCopyFile(source, copy); operatorCopyFile(wal, `${copy}-wal`); target = copy
      }
      operatorAssertUnchanged(source); operatorAssertSidecar(walPath, wal); operatorAssertSidecar(shmPath, shm)
    }
    if (!operatorPinnedFileIdentityMatches(source)) {
      operatorFail('database-drift', 'database path changed before open')
    }
    database = new DatabaseSync(target, { readOnly: true })
    // The WAL/SHM fds are opened lazily on first query, so right after the
    // constructor only the main database inode can be claimed.
    if (operatorInodeBindSupported) operatorAssertConnectionBound([bound[0]!], selfDescriptors())
    if (!operatorPinnedFileIdentityMatches(source)) {
      operatorFail('database-drift', 'database path changed during open')
    }
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN'); transaction = true
    const queryOnly = database.prepare('PRAGMA query_only').get() as { query_only?: unknown }
    if (queryOnly.query_only !== 1) operatorFail('database-corrupt', 'read-only guard was not enabled')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    if (version !== deliverySchemaVersion) operatorFail('schema-unsupported', `expected schema ${deliverySchemaVersion}`)
    const quick = database.prepare('PRAGMA quick_check').all() as unknown as Array<{ quick_check?: unknown }>
    if (quick.length !== 1 || quick[0]?.quick_check !== 'ok') operatorFail('database-corrupt', 'SQLite quick_check failed')
    if (database.prepare('PRAGMA foreign_key_check').all().length !== 0) operatorFail('database-corrupt', 'foreign-key integrity check failed')
    const rows = database.prepare(`
      SELECT binding.id AS binding_id, binding.conversation_hash, binding.conversation_json,
        binding.principal_id, binding.principal_json AS binding_principal_json, binding.workspace,
        binding.agent_preset, binding.session_id, binding.generation, binding.policy_ref,
        binding.status AS binding_status, binding.created_at AS binding_created_at,
        binding.updated_at AS binding_updated_at, binding.version AS binding_version,
        owner.id AS owner_id, owner.key_hash AS owner_key_hash, owner.principal_json AS owner_principal_json,
        owner.role AS owner_role, owner.status AS owner_status, owner.linked_to_id,
        owner.created_at AS owner_created_at, owner.updated_at AS owner_updated_at, owner.version AS owner_version,
        NULL AS lease_state
      FROM conversation_bindings AS binding
      JOIN delivery_principals AS owner ON owner.id = binding.principal_id
      WHERE binding.status = 'active' AND owner.role = 'owner' AND owner.status = 'active'
        AND binding.workspace = ? AND binding.agent_preset = ?
        AND json_extract(owner.principal_json, '$.channel') = 'lark'
        AND json_extract(owner.principal_json, '$.account') = ?
        AND json_extract(owner.principal_json, '$.tenant') = ?
        AND json_extract(binding.conversation_json, '$.channel') = 'lark'
        AND json_extract(binding.conversation_json, '$.account') = ?
        AND json_extract(binding.conversation_json, '$.tenant') = ?
        AND json_extract(binding.conversation_json, '$.kind') = 'dm'
      ORDER BY binding.id COLLATE BINARY
      LIMIT ?
    `).all(scope.workspace, scope.agentPreset, scope.account, scope.tenant, scope.account, scope.tenant, operatorMaximumBindings + 1) as unknown as LarkOwnerRow[]
    if (rows.length > operatorMaximumBindings) operatorFail('too-many-bindings', `more than ${operatorMaximumBindings} bindings match`)
    // The main query has now opened the WAL/SHM fds; re-prove every inode the
    // result depends on is still the pinned one (non-WAL keeps just the source).
    if (operatorInodeBindSupported) operatorAssertConnectionBound(bound, selfDescriptors())
    const bindings = operatorFreeze(rows.map(row => operatorBinding(row, scope)))
    database.exec('ROLLBACK'); transaction = false; database.close(); database = undefined
    operatorAssertUnchanged(source); operatorAssertSidecar(walPath, wal); operatorAssertSidecar(shmPath, shm)
    const databaseIdentity = operatorFileIdentity(source)
    const sidecars = operatorFreeze({ wal: wal === null ? null : operatorFileIdentity(wal), shm: shm === null ? null : operatorFileIdentity(shm) })
    const storageDigest = operatorSha256(operatorCanonicalJson({
      protocol: 'assistant-delivery/operator-storage/v1', database: source.digest, wal: wal?.digest ?? null,
    }))
    const unsigned: Omit<ActiveLarkOwnerBindingsSnapshot, 'snapshotDigest'> = operatorFreeze({
      protocol: activeLarkOwnerBindingsSnapshotProtocol, schemaVersion: deliverySchemaVersion, scope,
      database: databaseIdentity, sidecars, storageDigest, bindings,
    })
    result = operatorFreeze({ ...unsigned, snapshotDigest: operatorSha256(operatorCanonicalJson(unsigned)) })
  } catch (error) { deferred = error } finally {
    if (transaction) try { database?.exec('ROLLBACK') } catch (error) { deferred ??= error }
    try { database?.close() } catch (error) { deferred ??= error }
    if (source !== undefined) {
      try { operatorAssertUnchanged(source); operatorAssertSidecar(walPath, wal); operatorAssertSidecar(shmPath, shm) } catch (error) { deferred ??= error }
    }
    if (!operatorPinnedParentMatches(pinnedParent)) {
      deferred = new ActiveLarkOwnerBindingsSnapshotError(
        'unsafe-parent',
        'delivery Lark owner snapshot: database parent changed while it was inspected',
      )
    }
    for (const file of [shm, wal, source]) if (file !== null && file !== undefined) {
      try { closeSync(file.descriptor) } catch {}
    }
    for (const file of copyFiles) {
      try { closeSync(file.descriptor) } catch {}
    }
    if (temporaryPinned !== undefined) {
      try {
        operatorRemovePinnedTemp(temporaryPinned, ['delivery.sqlite', 'delivery.sqlite-wal', 'delivery.sqlite-shm'])
      } catch (error) { deferred ??= error }
    } else if (temporaryPath !== undefined) {
      try { rmSync(temporaryPath, { recursive: true, force: true }) } catch (error) { deferred ??= error }
    }
    try { closeSync(pinnedParent.descriptor) } catch (error) { deferred ??= error }
  }
  if (deferred !== undefined) {
    if (deferred instanceof ActiveLarkOwnerBindingsSnapshotError) throw deferred
    operatorClassifySqlite(deferred)
  }
  return result!
}
