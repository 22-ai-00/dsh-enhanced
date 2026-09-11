import { createHash, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import {
  canonicalRecoveryBootstrapAttestationSet,
  RecoveryBootstrapAttestationError,
  recoveryBootstrapAttestationSetDigest,
} from './attestation.js'
import { recoverySchemaVersion } from './sqlite.js'
import type { RecoveryBootstrapAttestation, RecoveryBootstrapState } from './types.js'

export const RECOVERY_OPERATOR_SNAPSHOT_PROTOCOL
  = 'assistant-recovery/operator-snapshot/v1' as const

export type RecoveryOperatorSnapshotErrorCode
  = | 'invalid-path'
    | 'missing-parent'
    | 'missing-file'
    | 'unsafe-parent'
    | 'unsafe-file'
    | 'unsafe-wal'
    | 'unsafe-shm'
    | 'database-busy'
    | 'database-unavailable'
    | 'schema-too-old'
    | 'schema-too-new'
    | 'database-corrupt'
    | 'database-drift'
    | 'wal-drift'
    | 'shm-drift'

export class RecoveryOperatorSnapshotError extends Error {
  constructor(readonly code: RecoveryOperatorSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'RecoveryOperatorSnapshotError'
  }
}

export interface RecoveryOperatorDatabaseIdentity {
  /** Decimal OS device id captured from the opened database file. */
  readonly device: string
  /** Decimal OS inode id captured from the opened database file. */
  readonly inode: string
  readonly size: number
  /** Local consistency digest over the main database and its exact WAL bytes, if present. */
  readonly digest: string
}

export interface RecoveryOperatorSnapshot {
  readonly protocol: typeof RECOVERY_OPERATOR_SNAPSHOT_PROTOCOL
  readonly schemaVersion: typeof recoverySchemaVersion
  readonly database: RecoveryOperatorDatabaseIdentity
  readonly bootstrap: RecoveryBootstrapState
  /** Canonical SHA-256 consistency digest. It is not an authenticity attestation. */
  readonly snapshotDigest: string
}

interface BootstrapRow {
  bootstrap_status: unknown
  bootstrap_failure_code: unknown
  bootstrap_generation: unknown
  bootstrap_attestation_valid: unknown
  bootstrap_attestations_json: unknown
  bootstrap_attestation_set_digest: unknown
  updated_at: unknown
}

interface PinnedFile {
  readonly descriptor: number
  readonly path: string
  readonly device: bigint
  readonly inode: bigint
  readonly size: bigint
  readonly mode: bigint
  readonly modifiedAt: bigint
  readonly changedAt: bigint
  readonly digest: string
}

interface PinnedFiles {
  readonly database: PinnedFile
  readonly wal?: PinnedFile
  readonly shm?: PinnedFile
}

interface PinnedParent {
  readonly descriptor: number
  readonly path: string
  readonly device: bigint
  readonly inode: bigint
  readonly mode: bigint
}

interface PinnedTemp {
  readonly path: string
  readonly descriptor: number
  readonly device: bigint
  readonly inode: bigint
}

const DIGEST = /^[a-f0-9]{64}$/u
const FAILURE_CODE = /^[a-z0-9][a-z0-9.-]{0,63}$/u
const FILE_READ_BUFFER_BYTES = 64 * 1024
const inodeBindSupported = process.platform === 'linux'
const procSelfFd = '/proc/self/fd'

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
    Object.freeze(value)
  }
  return value
}

function fail(code: RecoveryOperatorSnapshotErrorCode, message: string): never {
  throw new RecoveryOperatorSnapshotError(code, message)
}

function fileExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })
}

function pinPrivateParent(path: string): PinnedParent {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      fail('missing-parent', 'assistant-recovery operator snapshot parent does not exist')
    }
    fail('unsafe-parent', 'assistant-recovery operator snapshot parent is unavailable')
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
      fail('unsafe-parent', 'assistant-recovery operator snapshot parent must be a private owner directory without symlinks')
    }
    const pinned = { descriptor, path, device: metadata.dev, inode: metadata.ino, mode: metadata.mode }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof RecoveryOperatorSnapshotError) throw error
    fail('unsafe-parent', 'assistant-recovery operator snapshot parent cannot be resolved')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  throw new Error('unreachable')
}

function connectionInodes(exclude: ReadonlySet<number>): Array<{ device: bigint; inode: bigint }> {
  let entries: string[]
  try { entries = readdirSync(procSelfFd) } catch {
    fail('database-unavailable', 'assistant-recovery cannot inspect SQLite connection descriptors')
  }
  const inodes: Array<{ device: bigint; inode: bigint }> = []
  for (const entry of entries) {
    const descriptor = Number(entry)
    if (!Number.isInteger(descriptor) || descriptor <= 2 || exclude.has(descriptor)) continue
    let metadata: BigIntStats
    try { metadata = fstatSync(descriptor, { bigint: true }) } catch { continue }
    if (metadata.isFile()) inodes.push({ device: metadata.dev, inode: metadata.ino })
  }
  return inodes
}

function assertConnectionBound(files: readonly PinnedFile[], exclude: ReadonlySet<number>): void {
  const held = connectionInodes(exclude)
  for (const file of files) {
    if (!held.some(inode => inode.device === file.device && inode.inode === file.inode)) {
      fail('database-drift', 'assistant-recovery SQLite connection is not bound to its pinned inode')
    }
  }
}

function pinTempDirectory(path: string): PinnedTemp {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const pathname = lstatSync(path, { bigint: true })
    const metadata = fstatSync(descriptor, { bigint: true })
    const uid = process.getuid?.()
    if (!pathname.isDirectory() || pathname.isSymbolicLink() || !metadata.isDirectory()
      || pathname.dev !== metadata.dev || pathname.ino !== metadata.ino
      || (metadata.mode & 0o7777n) !== 0o700n
      || uid === undefined || metadata.uid !== BigInt(uid)) {
      fail('database-unavailable', 'assistant-recovery temporary snapshot directory is unsafe')
    }
    const pinned = { path, descriptor, device: metadata.dev, inode: metadata.ino }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof RecoveryOperatorSnapshotError) throw error
    fail('database-unavailable', 'assistant-recovery temporary snapshot directory cannot be pinned')
  } finally {
    if (descriptor !== undefined) try { closeSync(descriptor) } catch {}
  }
  throw new Error('unreachable')
}

function copyAndPin(
  source: PinnedFile,
  target: string,
  driftCode: Extract<RecoveryOperatorSnapshotErrorCode, 'database-drift' | 'wal-drift'>,
): PinnedFile {
  const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES)
  let destination: number | undefined
  try {
    destination = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let position = 0n
    while (position < source.size) {
      const length = Number(source.size - position > BigInt(buffer.length) ? BigInt(buffer.length) : source.size - position)
      const count = readSync(source.descriptor, buffer, 0, length, Number(position))
      if (count <= 0) fail(driftCode, `${basename(source.path)} changed while it was copied`)
      let written = 0
      while (written < count) written += writeSync(destination, buffer, written, count - written)
      position += BigInt(count)
    }
  } finally {
    if (destination !== undefined) try { closeSync(destination) } catch {}
  }
  const copied = pinPrivateFile(target, 'unsafe-file')
  if (copied.size !== source.size || copied.digest !== source.digest) {
    try { closeSync(copied.descriptor) } catch {}
    fail(driftCode, `${basename(source.path)} private copy does not match its pinned source`)
  }
  return copied
}

function removePinnedTemp(temp: PinnedTemp): void {
  const anchor = `${procSelfFd}/${temp.descriptor}`
  for (const name of ['recovery.sqlite', 'recovery.sqlite-wal', 'recovery.sqlite-shm']) {
    try { unlinkSync(`${anchor}/${name}`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('database-drift', 'assistant-recovery private snapshot copy cannot be removed')
      }
    }
  }
  if (readdirSync(anchor).length !== 0) fail('database-drift', 'assistant-recovery private snapshot directory is not empty')
  const pathname = lstatSync(temp.path, { bigint: true })
  const metadata = fstatSync(temp.descriptor, { bigint: true })
  if (pathname.dev !== temp.device || pathname.ino !== temp.inode
    || metadata.dev !== temp.device || metadata.ino !== temp.inode) {
    fail('database-drift', 'assistant-recovery private snapshot directory was retargeted')
  }
  closeSync(temp.descriptor)
  rmdirSync(temp.path)
}

function pinnedParentMatches(parent: PinnedParent): boolean {
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

function digestDescriptor(descriptor: number, size: bigint): string {
  const digest = createHash('sha256')
  const buffer = Buffer.allocUnsafe(FILE_READ_BUFFER_BYTES)
  let offset = 0n
  while (offset < size) {
    const remaining = size - offset
    const requested = remaining > BigInt(buffer.byteLength) ? buffer.byteLength : Number(remaining)
    const count = readSync(descriptor, buffer, 0, requested, Number(offset))
    if (count <= 0) fail('database-drift', 'assistant-recovery database changed while it was inspected')
    digest.update(buffer.subarray(0, count))
    offset += BigInt(count)
  }
  return digest.digest('hex')
}

function pinPrivateFile(
  path: string,
  unsafeCode: Extract<RecoveryOperatorSnapshotErrorCode, 'unsafe-file' | 'unsafe-wal' | 'unsafe-shm'>,
): PinnedFile {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const metadata = fstatSync(descriptor, { bigint: true })
    const uid = process.getuid?.()
    if (!metadata.isFile() || metadata.nlink !== 1n
      || uid === undefined || metadata.uid !== BigInt(uid)
      || (metadata.mode & 0o7777n) !== 0o600n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      fail(unsafeCode, `assistant-recovery ${basename(path)} must be one private owner-readable regular file`)
    }
    const pinned: PinnedFile = {
      descriptor,
      path,
      device: metadata.dev,
      inode: metadata.ino,
      size: metadata.size,
      mode: metadata.mode,
      modifiedAt: metadata.mtimeNs,
      changedAt: metadata.ctimeNs,
      digest: digestDescriptor(descriptor, metadata.size),
    }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof RecoveryOperatorSnapshotError) throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (unsafeCode === 'unsafe-file') {
        fail('missing-file', 'assistant-recovery database does not exist')
      }
      fail(unsafeCode === 'unsafe-wal' ? 'wal-drift' : 'shm-drift',
        `assistant-recovery ${basename(path)} disappeared while it was inspected`)
    }
    fail(unsafeCode, `assistant-recovery ${basename(path)} could not be opened safely`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  throw new Error('unreachable')
}

function samePinnedFile(before: PinnedFile): boolean {
  try {
    const path = lstatSync(before.path, { bigint: true })
    const descriptor = fstatSync(before.descriptor, { bigint: true })
    return path.isFile() && !path.isSymbolicLink() && path.nlink === 1n
      && path.dev === before.device && path.ino === before.inode
      && descriptor.dev === before.device && descriptor.ino === before.inode
      && descriptor.size === before.size && descriptor.mode === before.mode
      && descriptor.mtimeNs === before.modifiedAt && descriptor.ctimeNs === before.changedAt
      && digestDescriptor(before.descriptor, descriptor.size) === before.digest
  } catch {
    return false
  }
}

function pinnedPathIdentityMatches(file: PinnedFile): boolean {
  try {
    const path = lstatSync(file.path, { bigint: true })
    const descriptor = fstatSync(file.descriptor, { bigint: true })
    return path.isFile() && !path.isSymbolicLink() && path.nlink === 1n
      && path.dev === file.device && path.ino === file.inode
      && descriptor.dev === file.device && descriptor.ino === file.inode
  } catch {
    return false
  }
}

function pinFiles(path: string): PinnedFiles {
  if (fileExists(`${path}-journal`)) {
    fail('database-busy', 'assistant-recovery database has an active rollback journal')
  }
  const hasWal = fileExists(`${path}-wal`)
  const hasShm = fileExists(`${path}-shm`)
  if (hasWal !== hasShm) {
    fail(hasWal ? 'shm-drift' : 'wal-drift', 'assistant-recovery WAL sidecar set is incomplete')
  }
  const database = pinPrivateFile(path, 'unsafe-file')
  try {
    if (!hasWal) return { database }
    const wal = pinPrivateFile(`${path}-wal`, 'unsafe-wal')
    try {
      const shm = pinPrivateFile(`${path}-shm`, 'unsafe-shm')
      return { database, wal, shm }
    } catch (error) {
      closeSync(wal.descriptor)
      throw error
    }
  } catch (error) {
    closeSync(database.descriptor)
    throw error
  }
}

function closePinned(files: PinnedFiles): void {
  closeSync(files.database.descriptor)
  if (files.wal !== undefined) closeSync(files.wal.descriptor)
  if (files.shm !== undefined) closeSync(files.shm.descriptor)
}

function assertNoDrift(path: string, files: PinnedFiles): void {
  if (!samePinnedFile(files.database)) {
    fail('database-drift', 'assistant-recovery database changed while it was inspected')
  }
  const hasWal = fileExists(`${path}-wal`)
  const hasShm = fileExists(`${path}-shm`)
  if ((files.wal === undefined) !== !hasWal || (files.shm === undefined) !== !hasShm) {
    if ((files.wal === undefined) !== !hasWal) fail('wal-drift', 'assistant-recovery WAL changed while it was inspected')
    fail('shm-drift', 'assistant-recovery SHM changed while it was inspected')
  }
  if (files.wal !== undefined && !samePinnedFile(files.wal)) {
    fail('wal-drift', 'assistant-recovery WAL changed while it was inspected')
  }
  // SQLite may update WAL-index lock/read-mark bytes even through a read-only
  // connection. File identity, size, mode, and timestamps still detect an
  // externally replaced, resized, or persisted SHM generation without
  // misclassifying SQLite's own transient lock bookkeeping as state mutation.
  if (files.shm !== undefined) {
    try {
      const pathState = lstatSync(files.shm.path, { bigint: true })
      const descriptorState = fstatSync(files.shm.descriptor, { bigint: true })
      if (!pathState.isFile() || pathState.isSymbolicLink() || pathState.nlink !== 1n
        || pathState.dev !== files.shm.device || pathState.ino !== files.shm.inode
        || descriptorState.dev !== files.shm.device || descriptorState.ino !== files.shm.inode
        || descriptorState.size !== files.shm.size || descriptorState.mode !== files.shm.mode
        || descriptorState.mtimeNs !== files.shm.modifiedAt || descriptorState.ctimeNs !== files.shm.changedAt) {
        fail('shm-drift', 'assistant-recovery SHM changed while it was inspected')
      }
    } catch (error) {
      if (error instanceof RecoveryOperatorSnapshotError) throw error
      fail('shm-drift', 'assistant-recovery SHM changed while it was inspected')
    }
  }
}

function boundedFailureCode(value: unknown): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string' || value !== value.normalize('NFC').trim()
    || !FAILURE_CODE.test(value)) {
    fail('database-corrupt', 'assistant-recovery bootstrap failure code is corrupt')
  }
  return value
}

function safeInteger(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    fail('database-corrupt', 'assistant-recovery bootstrap numeric state is corrupt')
  }
  return value
}

function bootstrapState(row: BootstrapRow | undefined): RecoveryBootstrapState {
  if (row === undefined || typeof row.bootstrap_attestations_json !== 'string'
    || typeof row.bootstrap_attestation_set_digest !== 'string'
    || !DIGEST.test(row.bootstrap_attestation_set_digest)) {
    fail('database-corrupt', 'assistant-recovery bootstrap singleton is corrupt')
  }
  const status = row.bootstrap_status
  if (status !== 'failed' && status !== 'idle' && status !== 'running' && status !== 'succeeded') {
    fail('database-corrupt', 'assistant-recovery bootstrap status is corrupt')
  }
  const generation = safeInteger(row.bootstrap_generation, 0)
  const updatedAt = safeInteger(row.updated_at, 0)
  if (status !== 'idle' && generation < 1) {
    fail('database-corrupt', 'assistant-recovery bootstrap generation is corrupt')
  }
  if (row.bootstrap_attestation_valid !== 0 && row.bootstrap_attestation_valid !== 1) {
    fail('database-corrupt', 'assistant-recovery bootstrap attestation validity is corrupt')
  }
  const failureCode = boundedFailureCode(row.bootstrap_failure_code)
  if ((status === 'failed') !== (failureCode !== undefined)) {
    fail('database-corrupt', 'assistant-recovery bootstrap failure state is inconsistent')
  }
  let attestations: readonly RecoveryBootstrapAttestation[]
  try {
    const parsed = JSON.parse(row.bootstrap_attestations_json) as unknown
    attestations = canonicalRecoveryBootstrapAttestationSet(
      parsed as readonly RecoveryBootstrapAttestation[],
    )
  } catch (error) {
    if (error instanceof RecoveryBootstrapAttestationError || error instanceof SyntaxError) {
      fail('database-corrupt', 'assistant-recovery bootstrap attestation set is corrupt')
    }
    throw error
  }
  const canonical = JSON.stringify(attestations)
  const actualDigest = recoveryBootstrapAttestationSetDigest(attestations)
  const storedDigest = row.bootstrap_attestation_set_digest
  const valid = row.bootstrap_attestation_valid === 1
  if (canonical !== row.bootstrap_attestations_json
    || !timingSafeEqual(Buffer.from(actualDigest), Buffer.from(storedDigest))
    || (!valid && attestations.length !== 0) || (status === 'succeeded' && !valid)) {
    fail('database-corrupt', 'assistant-recovery bootstrap attestation proof is inconsistent')
  }
  return deepFreeze({
    status,
    ...(failureCode === undefined ? {} : { failureCode }),
    generation,
    attestationValid: valid,
    attestationSetDigest: storedDigest,
    attestations,
    updatedAt,
  })
}

function storageDigest(files: PinnedFiles): string {
  return createHash('sha256').update(canonicalJson({
    protocol: 'assistant-recovery/operator-database/v1',
    database: files.database.digest,
    wal: files.wal?.digest ?? null,
  })).digest('hex')
}

function classifySqliteError(error: unknown): never {
  const message = error instanceof Error ? error.message.toLowerCase() : ''
  const sqlite = error as { errcode?: unknown }
  if (sqlite.errcode === 5 || sqlite.errcode === 6 || /(?:busy|locked)/u.test(message)) {
    fail('database-busy', 'assistant-recovery database is busy')
  }
  if (/(?:malformed|not a database|database disk image|file is encrypted|no such table|no such column|datatype mismatch|constraint)/u.test(message)) {
    fail('database-corrupt', 'assistant-recovery database is corrupt')
  }
  fail('database-unavailable', 'assistant-recovery database could not be inspected')
}

/**
 * Read the already-existing schema-v4 bootstrap state without creating,
 * migrating, chmodding, checkpointing, or changing journal mode. The returned
 * digests detect local source drift; they do not prove authenticity against a
 * same-UID process or privileged attacker.
 */
export function inspectRecoveryOperatorSnapshot(databasePath: string): RecoveryOperatorSnapshot {
  if (typeof databasePath !== 'string' || !isAbsolute(databasePath)
    || resolve(databasePath) !== databasePath || databasePath === '/'
    || hasControlCharacter(databasePath)) {
    fail('invalid-path', 'assistant-recovery operator snapshot path must be canonical and absolute')
  }
  const parent = dirname(databasePath)
  const pinnedParent = pinPrivateParent(parent)
  if (!existsSync(databasePath)) {
    closeSync(pinnedParent.descriptor)
    fail('missing-file', 'assistant-recovery database does not exist')
  }
  let physical: string
  try {
    physical = realpathSync(databasePath)
  } catch {
    closeSync(pinnedParent.descriptor)
    fail('unsafe-file', 'assistant-recovery database cannot be resolved')
  }
  if (physical !== join(parent, basename(databasePath))) {
    closeSync(pinnedParent.descriptor)
    fail('unsafe-file', 'assistant-recovery database path must not contain symlinks')
  }

  let files: PinnedFiles
  try {
    files = pinFiles(databasePath)
  } catch (error) {
    closeSync(pinnedParent.descriptor)
    throw error
  }
  let database: DatabaseSync | undefined
  let temporary: PinnedTemp | undefined
  let temporaryPath: string | undefined
  let copies: readonly PinnedFile[] = []
  let transaction = false
  let result: RecoveryOperatorSnapshot | undefined
  let deferredError: unknown
  const selfDescriptors = (): ReadonlySet<number> => new Set([
    pinnedParent.descriptor, files.database.descriptor, files.wal?.descriptor,
    files.shm?.descriptor, temporary?.descriptor, ...copies.map(file => file.descriptor),
  ].filter((descriptor): descriptor is number => descriptor !== undefined))
  try {
    let bound: readonly PinnedFile[]
    let target: string
    // A clean database is opened by its already-pinned inode. A live WAL is
    // copied into a pinned owner-only directory so SQLite never opens a source
    // pathname or writes source SHM lock/read-mark state.
    if (files.wal === undefined) {
      target = inodeBindSupported
        ? `file://${procSelfFd}/${files.database.descriptor}?mode=ro&immutable=1`
        : `${pathToFileURL(databasePath).href}?mode=ro&immutable=1`
      bound = [files.database]
    } else {
      temporaryPath = mkdtempSync(join(tmpdir(), 'assistant-recovery-operator-snapshot-'))
      temporary = pinTempDirectory(temporaryPath)
      const anchor = `${procSelfFd}/${temporary.descriptor}`
      const main = copyAndPin(files.database, `${anchor}/recovery.sqlite`, 'database-drift')
      let wal: PinnedFile | undefined
      try { wal = copyAndPin(files.wal, `${anchor}/recovery.sqlite-wal`, 'wal-drift') }
      catch (error) { try { closeSync(main.descriptor) } catch {}; throw error }
      copies = Object.freeze([main, wal])
      target = `file://${anchor}/recovery.sqlite?mode=ro`
      bound = copies
      assertNoDrift(databasePath, files)
    }
    assertNoDrift(databasePath, files)
    if (!pinnedPathIdentityMatches(files.database)) {
      fail('database-drift', 'assistant-recovery database path changed before open')
    }
    database = new DatabaseSync(target, { readOnly: true })
    if (inodeBindSupported) assertConnectionBound([bound[0]!], selfDescriptors())
    if (!pinnedPathIdentityMatches(files.database)) {
      fail('database-drift', 'assistant-recovery database path changed during open')
    }
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN')
    transaction = true
    const queryOnly = database.prepare('PRAGMA query_only').get() as { query_only?: unknown }
    if (queryOnly.query_only !== 1) fail('database-unavailable', 'assistant-recovery read-only guard was not enabled')
    const versionRow = database.prepare('PRAGMA user_version').get() as { user_version?: unknown }
    if (typeof versionRow.user_version !== 'number' || !Number.isSafeInteger(versionRow.user_version)) {
      fail('database-corrupt', 'assistant-recovery schema version is corrupt')
    }
    if (versionRow.user_version < recoverySchemaVersion) {
      fail('schema-too-old', `assistant-recovery schema ${versionRow.user_version} is older than required schema ${recoverySchemaVersion}`)
    }
    if (versionRow.user_version > recoverySchemaVersion) {
      fail('schema-too-new', `assistant-recovery schema ${versionRow.user_version} is newer than supported schema ${recoverySchemaVersion}`)
    }
    const rows = database.prepare(`
      SELECT bootstrap_status, bootstrap_failure_code, bootstrap_generation,
             bootstrap_attestation_valid, bootstrap_attestations_json,
             bootstrap_attestation_set_digest, updated_at
      FROM recovery_runtime_state WHERE singleton = 1 LIMIT 2
    `).all() as unknown as BootstrapRow[]
    if (rows.length !== 1) fail('database-corrupt', 'assistant-recovery bootstrap singleton is missing or ambiguous')
    const bootstrap = bootstrapState(rows[0])
    if (inodeBindSupported) assertConnectionBound(bound, selfDescriptors())
    assertNoDrift(databasePath, files)
    const databaseIdentity = deepFreeze({
      device: files.database.device.toString(10),
      inode: files.database.inode.toString(10),
      size: Number(files.database.size),
      digest: storageDigest(files),
    })
    const unsigned: Omit<RecoveryOperatorSnapshot, 'snapshotDigest'> = deepFreeze({
      protocol: RECOVERY_OPERATOR_SNAPSHOT_PROTOCOL,
      schemaVersion: recoverySchemaVersion,
      database: databaseIdentity,
      bootstrap,
    })
    result = deepFreeze({
      ...unsigned,
      snapshotDigest: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
    })
  } catch (error) {
    deferredError = error
  } finally {
    if (transaction) {
      try { database?.exec('ROLLBACK') } catch (error) { deferredError ??= error }
    }
    try { database?.close() } catch (error) { deferredError ??= error }
    try { assertNoDrift(databasePath, files) } catch (error) { deferredError ??= error }
    if (!pinnedParentMatches(pinnedParent)) {
      // A parent replacement invalidates every earlier pathname observation;
      // it deliberately overrides a deferred lower-level drift error.
      deferredError = new RecoveryOperatorSnapshotError(
        'unsafe-parent',
        'assistant-recovery operator snapshot parent changed while it was inspected',
      )
    }
    for (const copy of copies) try { closeSync(copy.descriptor) } catch {}
    if (temporary !== undefined) {
      try { removePinnedTemp(temporary) } catch (error) { deferredError ??= error }
    } else if (temporaryPath !== undefined) {
      try { rmSync(temporaryPath, { recursive: true, force: true }) } catch (error) { deferredError ??= error }
    }
    try { closePinned(files) } catch (error) { deferredError ??= error }
    try { closeSync(pinnedParent.descriptor) } catch (error) { deferredError ??= error }
  }
  if (deferredError !== undefined) {
    if (deferredError instanceof RecoveryOperatorSnapshotError) throw deferredError
    classifySqliteError(deferredError)
  }
  return result!
}
