import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { automationSchemaVersion } from './sqlite.js'
import { normalizeAutomationDefinition } from './store.js'
import type { AutomationDefinition, AutomationRecord, AutomationStatus } from './types.js'

export const automationsOperatorSnapshotProtocol = 'assistant-automations-operator-snapshot/v1' as const

export type AutomationOperatorSnapshotErrorCode =
  | 'database-busy'
  | 'database-corrupt'
  | 'database-drift'
  | 'database-missing'
  | 'database-unavailable'
  | 'invalid-path'
  | 'schema-unsupported'
  | 'unsafe-parent'
  | 'unsafe-path'

export class AutomationOperatorSnapshotError extends Error {
  constructor(readonly code: AutomationOperatorSnapshotErrorCode, message: string) {
    super(message)
    this.name = 'AutomationOperatorSnapshotError'
  }
}

export interface AutomationOperatorFileIdentity {
  readonly device: string
  readonly inode: string
  readonly size: string
  readonly mtimeNs: string
  readonly digest: string
}

export interface AutomationOperatorRecord {
  readonly id: string
  readonly owner?: string
  readonly definitionHash: string
  readonly status: AutomationStatus
  readonly nextRunAt?: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly version: number
  /** Claimed or running tasks in the same SQLite snapshot. */
  readonly runningTaskCount: number
}

export interface AutomationsOperatorSnapshot {
  readonly protocol: typeof automationsOperatorSnapshotProtocol
  readonly schemaVersion: 15
  readonly database: AutomationOperatorFileIdentity
  readonly sidecars: Readonly<{
    wal: AutomationOperatorFileIdentity | null
    shm: AutomationOperatorFileIdentity | null
  }>
  /** Digest of the exact pinned main database and WAL bytes; SHM is coordination-only. */
  readonly storageDigest: string
  /** All claimed or running tasks, including any corrupt orphan rows. */
  readonly inFlightCount: number
  readonly inventoryDigest: string
  /** Complete definition inventory, including paused and deleted rows. */
  readonly records: readonly AutomationOperatorRecord[]
}

interface DefinitionRow {
  id: unknown
  system_owner: unknown
  definition_hash: unknown
  definition_json: unknown
  status: unknown
  next_run_at: unknown
  created_at: unknown
  updated_at: unknown
  version: unknown
  running_task_count: unknown
}

interface InternalAutomationOperatorRecord extends AutomationOperatorRecord {
  readonly definition: AutomationDefinition
}

interface OpenedFile {
  readonly path: string
  readonly descriptor: number
  readonly stat: BigIntStats
  readonly digest: string
}

const digestPattern = /^[a-f0-9]{64}$/u

function fail(code: AutomationOperatorSnapshotErrorCode, message: string): never {
  throw new AutomationOperatorSnapshotError(code, `automation operator snapshot: ${message}`)
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Pure canonical digest used by both writers and trusted local attestation. */
export function automationDefinitionDigest(definition: unknown): string {
  return sha256(JSON.stringify(normalizeAutomationDefinition(definition, 16 * 1024 * 1024, 10_000)))
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function canonicalText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC').trim()
    && Buffer.byteLength(value, 'utf8') <= maximum
    && ![...value].some(character => {
      const point = character.codePointAt(0) ?? 0
      return point <= 0x1f || point === 0x7f
    })
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink
}

function digestDescriptor(descriptor: number, size: bigint): string {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let position = 0n
  while (position < size) {
    const length = Number(size - position > BigInt(buffer.length) ? BigInt(buffer.length) : size - position)
    const count = readSync(descriptor, buffer, 0, length, Number(position))
    if (count <= 0) fail('database-drift', 'database file changed while hashing')
    hash.update(buffer.subarray(0, count))
    position += BigInt(count)
  }
  return hash.digest('hex')
}

function identity(file: OpenedFile): AutomationOperatorFileIdentity {
  return freeze({
    device: file.stat.dev.toString(),
    inode: file.stat.ino.toString(),
    size: file.stat.size.toString(),
    mtimeNs: file.stat.mtimeNs.toString(),
    digest: file.digest,
  })
}

interface PinnedParent {
  readonly path: string
  readonly descriptor: number
  readonly device: bigint
  readonly inode: bigint
  readonly mode: bigint
}

function pinPrivateParent(path: string): PinnedParent {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') {
      fail('unsafe-parent', 'database parent disappeared before the snapshot')
    }
    fail('unsafe-parent', 'database parent is unavailable')
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
      fail('unsafe-parent', 'database parent must be a private owner directory without symlinks')
    }
    const pinned = { path, descriptor, device: metadata.dev, inode: metadata.ino, mode: metadata.mode }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    fail('unsafe-parent', 'database parent cannot be resolved')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  throw new Error('unreachable')
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

function pinnedFileIdentityMatches(file: OpenedFile): boolean {
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

interface PinnedTemp {
  readonly path: string
  readonly descriptor: number
  readonly device: bigint
  readonly inode: bigint
}

// Inode binding is enforced through Linux /proc/self/fd. On other platforms the
// snapshot keeps its historical path-based pinning; CI still exercises that code.
const inodeBindSupported = process.platform === 'linux'
const procSelfFd = '/proc/self/fd'

/**
 * Enumerate the regular-file inodes held by THIS process, excluding the
 * descriptors the snapshot pinned itself. After the exclusion the only
 * remaining database fds are SQLite's, so a (dev,ino) match proves the
 * connection genuinely opened the pinned inode rather than an attacker's
 * same-name replacement. An attacker in another process cannot plant an fd
 * here because /proc/self/fd never lists another process's descriptors.
 */
function connectionInodes(exclude: ReadonlySet<number>): Array<{ device: bigint; inode: bigint }> {
  let entries: string[]
  try { entries = readdirSync(procSelfFd) } catch {
    fail('database-corrupt', 'cannot inspect the database connection file descriptors')
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

function assertConnectionBound(files: readonly OpenedFile[], exclude: ReadonlySet<number>): void {
  const held = connectionInodes(exclude)
  for (const file of files) {
    if (!held.some(inode => inode.device === file.stat.dev && inode.inode === file.stat.ino)) {
      fail('database-drift', 'database connection is not bound to the pinned inode')
    }
  }
}

/** Pin the private mkdtemp copy directory itself so a same-name swap cannot retarget the copies. */
function pinTempDirectory(path: string): PinnedTemp {
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const linked = lstatSync(path, { bigint: true })
    const opened = fstatSync(descriptor, { bigint: true })
    const uid = process.getuid?.()
    if (!linked.isDirectory() || linked.isSymbolicLink() || !opened.isDirectory()
      || linked.dev !== opened.dev || linked.ino !== opened.ino) {
      fail('unsafe-path', 'temporary snapshot directory cannot be pinned')
    }
    if ((opened.mode & 0o7777n) !== 0o700n || uid === undefined || opened.uid !== BigInt(uid)) {
      fail('unsafe-path', 'temporary snapshot directory must be a private owner-only 0700 directory')
    }
    const pinned = { path, descriptor, device: opened.dev, inode: opened.ino }
    descriptor = undefined
    return pinned
  } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    fail('unsafe-path', 'temporary snapshot directory cannot be pinned')
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
function copyAndPin(source: OpenedFile, targetRef: string): OpenedFile {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  let destination: number | undefined
  try {
    destination = openSync(targetRef, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let position = 0n
    while (position < source.stat.size) {
      const length = Number(source.stat.size - position > BigInt(buffer.length)
        ? BigInt(buffer.length) : source.stat.size - position)
      const count = readSync(source.descriptor, buffer, 0, length, Number(position))
      if (count <= 0) fail('database-drift', `${basename(source.path)} changed while it was copied`)
      let written = 0
      while (written < count) written += writeSync(destination!, buffer, written, count - written)
      position += BigInt(count)
    }
  } catch (error) {
    if (destination !== undefined) try { closeSync(destination) } catch {}
    if (error instanceof AutomationOperatorSnapshotError) throw error
    throw error
  }
  if (destination !== undefined) closeSync(destination)
  const copied = openPrivateFile(targetRef, 'database-drift')
  if (copied.stat.size !== source.stat.size || copied.digest !== source.digest) {
    try { closeSync(copied.descriptor) } catch {}
    fail('database-drift', `${basename(source.path)} copy does not match its pinned source`)
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
function removePinnedTemp(pinned: PinnedTemp, names: readonly string[]): void {
  const anchor = `${procSelfFd}/${pinned.descriptor}`
  for (const name of names) {
    try { unlinkSync(`${anchor}/${name}`) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        fail('database-drift', 'temporary snapshot copy cannot be removed through its pinned directory')
      }
    }
  }
  let entries: string[]
  try { entries = readdirSync(anchor) } catch {
    fail('database-drift', 'temporary snapshot directory became unavailable')
  }
  if (entries.length !== 0) fail('database-drift', 'temporary snapshot directory contains unexpected entries')
  const linked = lstatSync(pinned.path, { bigint: true })
  const opened = fstatSync(pinned.descriptor, { bigint: true })
  if (linked.dev !== pinned.device || linked.ino !== pinned.inode
    || opened.dev !== pinned.device || opened.ino !== pinned.inode) {
    fail('database-drift', 'temporary snapshot directory was retargeted before cleanup')
  }
  closeSync(pinned.descriptor)
  try {
    rmdirSync(pinned.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      fail('database-drift', 'temporary snapshot directory could not be removed')
    }
  }
}

function openPrivateFile(path: string, missing: AutomationOperatorSnapshotErrorCode): OpenedFile {
  let linked: BigIntStats
  try {
    linked = lstatSync(path, { bigint: true })
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') fail(missing, `${basename(path)} does not exist`)
    fail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  const uid = process.getuid?.()
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n
    || (linked.mode & 0o7777n) !== 0o600n
    || (uid !== undefined && linked.uid !== BigInt(uid))
    || linked.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('unsafe-path', `${basename(path)} must be one private owned regular file`)
  }
  let descriptor: number
  try {
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    fail('unsafe-path', `${basename(path)} cannot be opened safely`)
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const after = lstatSync(path, { bigint: true })
    if (!sameFile(linked, opened) || !sameFile(opened, after)) {
      fail('database-drift', `${basename(path)} changed while being opened`)
    }
    const digest = digestDescriptor(descriptor, opened.size)
    const hashed = fstatSync(descriptor, { bigint: true })
    if (!sameFile(opened, hashed)) fail('database-drift', `${basename(path)} changed while being hashed`)
    return { path, descriptor, stat: opened, digest }
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function openOptionalSidecar(path: string): OpenedFile | null {
  try {
    lstatSync(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return null
    fail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  return openPrivateFile(path, 'database-drift')
}

function assertStillIdentical(file: OpenedFile): void {
  let linked: BigIntStats
  try {
    linked = lstatSync(file.path, { bigint: true })
  } catch {
    fail('database-drift', `${basename(file.path)} disappeared during the snapshot`)
  }
  const opened = fstatSync(file.descriptor, { bigint: true })
  if (!sameFile(file.stat, opened) || !sameFile(opened, linked)
    || digestDescriptor(file.descriptor, opened.size) !== file.digest) {
    fail('database-drift', `${basename(file.path)} changed during the snapshot`)
  }
}

function assertSidecarState(path: string, before: OpenedFile | null): void {
  if (before === null) {
    try {
      lstatSync(path)
      fail('database-drift', `${basename(path)} appeared during the snapshot`)
    } catch (error) {
      if (error instanceof AutomationOperatorSnapshotError) throw error
      if (!(typeof error === 'object' && error !== null && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT')) {
        fail('database-drift', `${basename(path)} changed during the snapshot`)
      }
    }
    return
  }
  assertStillIdentical(before)
}

/**
 * Decode a Linux user-space dev_t per <sys/sysmacros.h>, preserving the full
 * bit width:
 *   major(dev) = ((dev >> 8) & 0xfff)    | ((dev >> 32) & 0xfffff000)
 *   minor(dev) = (dev & 0xff)           | ((dev >> 12) & 0xffffff00)
 */
export function decodeDeviceId(dev: bigint): { major: bigint; minor: bigint } {
  return {
    major: ((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n),
    minor: (dev & 0xffn) | ((dev >> 12n) & 0xffffff00n),
  }
}

interface LockProbeTarget {
  readonly dev: bigint
  readonly ino: bigint
}

function lockTargets(files: ReadonlyArray<OpenedFile | null>): LockProbeTarget[] {
  return files.filter((file): file is OpenedFile => file !== null)
    .map(file => ({ dev: file.stat.dev, ino: file.stat.ino }))
}

/** Parse the MAJ:MIN:INO out of one /proc/locks row, including blocked-lock rows. */
function parseLockIdentity(fields: string[]): { major: bigint; minor: bigint; inode: string } | null {
  // /proc/locks rows are "num: KIND MODE ACCESS PID MAJ:MIN:INO START END";
  // blocked locks insert "->" after the number, shifting the pid/identity by one.
  const blockedOffset = fields[1] === '->' ? 1 : 0
  const identity = fields[5 + blockedOffset]
  if (identity === undefined || !/^[0-9a-f]+:[0-9a-f]+:[0-9]+$/iu.test(identity)) return null
  const [major, minor, inode] = identity.split(':')
  if (major === undefined || minor === undefined || inode === undefined) return null
  return { major: BigInt(`0x${major}`), minor: BigInt(`0x${minor}`), inode }
}

/** Identity of a WRITE lock in one /proc/locks row; null for READ locks or malformed rows. */
export function parseWritableProcLock(line: string): { major: bigint; minor: bigint; inode: string } | null {
  const fields = line.trim().split(/\s+/u)
  // blocked locks insert "->" after the number, shifting MODE/ACCESS/pid by one.
  const blockedOffset = fields[1] === '->' ? 1 : 0
  if (fields[3 + blockedOffset] !== 'WRITE') return null
  return parseLockIdentity(fields)
}

function assertNoExclusiveWriter(targets: readonly LockProbeTarget[]): void {
  let locks: string
  try {
    locks = readFileSync('/proc/locks', 'utf8')
  } catch {
    // The lock table is the only available writer probe; never proceed when it
    // cannot be read, since a live writer could then go undetected.
    fail('database-busy', 'cannot inspect active database locks')
  }
  const decoded = targets.map(target => ({ ...decodeDeviceId(target.dev), inode: target.ino.toString() }))
  const locked = locks.split('\n').some(line => {
    const identity = parseWritableProcLock(line)
    return identity !== null && decoded.some(target => target.major === identity.major
      && target.minor === identity.minor && target.inode === identity.inode)
  })
  if (locked) fail('database-busy', 'database has an exclusive writer lock')
}

function retryExclusiveWriterProbe(targets: readonly LockProbeTarget[]): void {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assertNoExclusiveWriter(targets)
    const until = process.hrtime.bigint() + 1_000_000n
    while (process.hrtime.bigint() < until) { /* bounded race-window probe */ }
  }
}

/**
 * A hot rollback journal means an interrupted transaction may be embedded in
 * the main file; immutable=1 opens skip journal replay, so its mere presence
 * forces a busy verdict. Runs before the source is pinned or opened.
 */
function assertNoRollbackJournal(path: string): void {
  try {
    lstatSync(`${path}-journal`)
    fail('database-busy', 'database has a rollback journal')
  } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return
    fail('unsafe-path', 'rollback journal cannot be inspected')
  }
}

/** A journal appearing once the snapshot started is writer drift and must fail closed. */
function assertJournalAbsent(path: string): void {
  try {
    lstatSync(`${path}-journal`)
    fail('database-drift', 'rollback journal appeared during the snapshot')
  } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') return
    fail('database-drift', 'rollback journal cannot be inspected during the snapshot')
  }
}

function copyOpenedFile(source: OpenedFile, target: string): void {
  const buffer = Buffer.allocUnsafe(64 * 1024)
  const destination = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    let position = 0n
    while (position < source.stat.size) {
      const length = Number(source.stat.size - position > BigInt(buffer.length)
        ? BigInt(buffer.length) : source.stat.size - position)
      const count = readSync(source.descriptor, buffer, 0, length, Number(position))
      if (count <= 0) fail('database-drift', `${basename(source.path)} changed while being copied`)
      let written = 0
      while (written < count) written += writeSync(destination, buffer, written, count - written)
      position += BigInt(count)
    }
  } finally { closeSync(destination) }
  const copied = openPrivateFile(target, 'database-drift')
  try {
    if (copied.stat.size !== source.stat.size || copied.digest !== source.digest) {
      fail('database-drift', `${basename(source.path)} copy does not match its pinned source`)
    }
  } finally { closeSync(copied.descriptor) }
}

function privateDatabasePath(path: string): string {
  if (typeof path !== 'string' || path.length === 0 || !isAbsolute(path) || resolve(path) !== path
    || path === '/' || path !== path.normalize('NFC') || /[\p{Cc}]/u.test(path)) {
    fail('invalid-path', 'database path must be an absolute canonical path')
  }
  let physical: string
  let parentPhysical: string
  try { parentPhysical = realpathSync(dirname(path)) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') fail('unsafe-parent', 'database parent disappeared')
    fail('unsafe-parent', 'database parent cannot be resolved')
  }
  if (parentPhysical !== dirname(path)) {
    fail('unsafe-path', 'database path must not traverse a symbolic link')
  }
  try { physical = realpathSync(path) } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error
      && (error as { code?: unknown }).code === 'ENOENT') fail('database-missing', 'database does not exist')
    fail('unsafe-path', 'database path cannot be resolved')
  }
  if (physical !== path || parentPhysical !== dirname(path)) {
    fail('unsafe-path', 'database path must not traverse a symbolic link')
  }
  return physical
}

function parseDefinition(row: DefinitionRow): AutomationDefinition {
  if (typeof row.definition_json !== 'string'
    || Buffer.byteLength(row.definition_json, 'utf8') > 16 * 1024 * 1024
    || typeof row.definition_hash !== 'string' || !digestPattern.test(row.definition_hash)) {
    fail('database-corrupt', 'automation definition metadata is invalid')
  }
  let parsed: unknown
  try { parsed = JSON.parse(row.definition_json) } catch { fail('database-corrupt', 'automation definition JSON is invalid') }
  const definition = (() => {
    try { return normalizeAutomationDefinition(parsed, 16 * 1024 * 1024, 10_000) } catch {
      return fail('database-corrupt', 'automation definition is not canonical')
    }
  })()
  const canonical = JSON.stringify(definition)
  if (row.definition_json !== canonical || sha256(canonical) !== row.definition_hash) {
    fail('database-corrupt', 'automation definition digest is invalid')
  }
  return freeze(definition)
}

function parseRecord(row: DefinitionRow): InternalAutomationOperatorRecord {
  if (!canonicalText(row.id, 500)
    || (row.system_owner !== null && !canonicalText(row.system_owner, 200))
    || (row.status !== 'active' && row.status !== 'paused' && row.status !== 'deleted')
    || !safeInteger(row.created_at) || !safeInteger(row.updated_at) || row.updated_at < row.created_at
    || !safeInteger(row.version, 1) || !safeInteger(row.running_task_count)
    || (row.next_run_at !== null && !safeInteger(row.next_run_at))) {
    fail('database-corrupt', 'automation definition row is invalid')
  }
  if (row.status !== 'active' && row.next_run_at !== null) {
    fail('database-corrupt', 'inactive automation has a next run time')
  }
  const definition = parseDefinition(row)
  return freeze({
    id: row.id,
    ...(row.system_owner === null ? {} : { owner: row.system_owner }),
    definitionHash: row.definition_hash as string,
    definition,
    status: row.status,
    ...(row.next_run_at === null ? {} : { nextRunAt: row.next_run_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    runningTaskCount: row.running_task_count,
  })
}

function publicRecord(record: InternalAutomationOperatorRecord): AutomationOperatorRecord {
  return freeze({
    id: record.id,
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    definitionHash: record.definitionHash,
    status: record.status,
    ...(record.nextRunAt === undefined ? {} : { nextRunAt: record.nextRunAt }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
    runningTaskCount: record.runningTaskCount,
  })
}

function readSnapshot(databasePath: string): {
  snapshot: AutomationsOperatorSnapshot
  internalRecords: readonly InternalAutomationOperatorRecord[]
} {
  const path = privateDatabasePath(databasePath)
  // Pin the private parent directory for the whole snapshot so an ancestor
  // rename or a same-name directory swap cannot retarget the database path
  // between the path checks and the read.
  const pinnedParent = pinPrivateParent(dirname(path))
  const walPath = `${path}-wal`; const shmPath = `${path}-shm`
  let source: OpenedFile | undefined
  let wal: OpenedFile | null = null; let shm: OpenedFile | null = null
  let temporary: string | undefined; let temporaryPinned: PinnedTemp | undefined
  let copyFiles: readonly OpenedFile[] = []
  let database: DatabaseSync | undefined
  let transaction = false
  let result: {
    snapshot: AutomationsOperatorSnapshot
    internalRecords: readonly InternalAutomationOperatorRecord[]
  } | undefined
  let deferred: unknown
  // Descriptors the snapshot itself holds; these are excluded when proving that
  // SQLite opened the pinned inode, so the connection can never vouch for itself.
  const selfDescriptors = (): ReadonlySet<number> => new Set([
    pinnedParent.descriptor, source?.descriptor, wal?.descriptor, shm?.descriptor,
    temporaryPinned?.descriptor, ...copyFiles.map(file => file.descriptor),
  ].filter((descriptor): descriptor is number => descriptor !== undefined))
  try {
    assertNoRollbackJournal(path)
    source = openPrivateFile(path, 'database-missing')
    assertJournalAbsent(path)
    wal = openOptionalSidecar(walPath); shm = openOptionalSidecar(shmPath)
    if ((wal === null) !== (shm === null)) {
      // An exclusive WAL writer can legitimately be observed between creating
      // its WAL and SHM entries. Re-probe the lock before classifying a stable
      // orphan sidecar as source drift.
      retryExclusiveWriterProbe(lockTargets([source, wal, shm]))
      fail('database-drift', 'WAL sidecar set is incomplete')
    }
    // In WAL mode the writer's POSIX WRITE lock is held on the SHM inode
    // (byte 120), not the main database, so every sidecar inode is probed.
    assertNoExclusiveWriter(lockTargets([source, wal, shm]))
    assertJournalAbsent(path)
    assertStillIdentical(source); assertSidecarState(walPath, wal); assertSidecarState(shmPath, shm)
    // Files SQLite must prove it is reading. Without WAL that is the pinned
    // source inode; with WAL it is the pinned private replica inodes.
    let bound: readonly OpenedFile[] = []
    let target: string | URL
    if (wal === null) {
      if (inodeBindSupported) {
        // Open the pinned descriptor itself by inode (Linux) so a same-name swap
        // cannot retarget the connection; immutable=1 forbids WAL/journal access.
        target = `file://${procSelfFd}/${source.descriptor}?mode=ro&immutable=1`
      } else {
        const location = pathToFileURL(path)
        location.searchParams.set('mode', 'ro'); location.searchParams.set('immutable', '1')
        target = location
      }
      bound = [source]
    } else {
      temporary = mkdtempSync(join(tmpdir(), 'automations-operator-snapshot-'))
      const temporaryMetadata = lstatSync(temporary, { bigint: true })
      if (!temporaryMetadata.isDirectory() || temporaryMetadata.isSymbolicLink()
        || (temporaryMetadata.mode & 0o7777n) !== 0o700n
        || (process.getuid?.() !== undefined && temporaryMetadata.uid !== BigInt(process.getuid!()))) {
        fail('unsafe-path', 'temporary snapshot directory is not private')
      }
      if (inodeBindSupported) {
        temporaryPinned = pinTempDirectory(temporary)
        const anchor = `${procSelfFd}/${temporaryPinned.descriptor}`
        const mainRef = `${anchor}/automations.sqlite`
        // Only the main file and WAL are copied; a rollback journal is never
        // copied or replayed, and its appearance fails the snapshot below.
        const copiedMain = copyAndPin(source, mainRef)
        let copiedWal: OpenedFile | undefined
        try { copiedWal = copyAndPin(wal, `${mainRef}-wal`) }
        catch (error) { try { closeSync(copiedMain.descriptor) } catch {}; throw error }
        copyFiles = Object.freeze([copiedMain, copiedWal])
        target = mainRef
        bound = copyFiles
      } else {
        const copy = join(temporary, 'automations.sqlite')
        // Only the main file and WAL are copied; a rollback journal is never
        // copied or replayed, and its appearance fails the snapshot below.
        copyOpenedFile(source, copy); copyOpenedFile(wal, `${copy}-wal`); target = copy
      }
      assertStillIdentical(source); assertSidecarState(walPath, wal); assertSidecarState(shmPath, shm)
    }
    assertJournalAbsent(path)
    if (!pinnedFileIdentityMatches(source)) {
      fail('database-drift', 'database path changed before open')
    }
    database = new DatabaseSync(target, { readOnly: true })
    // The WAL/SHM fds are opened lazily on first query, so right after the
    // constructor only the main database inode can be claimed.
    if (inodeBindSupported) assertConnectionBound([bound[0]!], selfDescriptors())
    if (!pinnedFileIdentityMatches(source)) {
      fail('database-drift', 'database path changed during open')
    }
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN'); transaction = true
    const queryOnly = (database.prepare('PRAGMA query_only').get() as { query_only?: unknown }).query_only
    if (queryOnly !== 1) fail('database-unavailable', 'read-only guard was not enabled')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    if (version !== automationSchemaVersion) fail('schema-unsupported', `expected schema ${automationSchemaVersion}`)
    const check = database.prepare('PRAGMA quick_check').all() as unknown as Array<{ quick_check?: unknown }>
    if (check.length !== 1 || check[0]?.quick_check !== 'ok') fail('database-corrupt', 'SQLite quick_check failed')
    const rows = database.prepare(`
      SELECT definition.id, definition.system_owner, definition.definition_hash, definition.definition_json,
        definition.status, definition.next_run_at, definition.created_at, definition.updated_at, definition.version,
        COALESCE(SUM(CASE WHEN task.status IN ('claimed', 'running') THEN 1 ELSE 0 END), 0) AS running_task_count
      FROM automation_definitions AS definition
      LEFT JOIN automation_tasks AS task ON task.automation_id = definition.id
      GROUP BY definition.id
      ORDER BY definition.id COLLATE BINARY
    `).all() as unknown as DefinitionRow[]
    const internalRecords = freeze(rows.map(parseRecord))
    // The main query has now opened the WAL/SHM fds; re-prove every inode the
    // result depends on is still the pinned one (non-WAL keeps just the source).
    if (inodeBindSupported) assertConnectionBound(bound, selfDescriptors())
    const inFlight = database.prepare(`
      SELECT COUNT(*) AS count FROM automation_tasks WHERE status IN ('claimed', 'running')
    `).get() as { count?: unknown }
    if (!safeInteger(inFlight.count)) fail('database-corrupt', 'in-flight task count is invalid')
    const summed = internalRecords.reduce((total, record) => total + record.runningTaskCount, 0)
    if (!Number.isSafeInteger(summed) || summed !== inFlight.count) {
      fail('database-corrupt', 'in-flight tasks are not bound to the definition inventory')
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKeys.length !== 0) fail('database-corrupt', 'foreign-key integrity check failed')
    const records = freeze(internalRecords.map(publicRecord))
    database.exec('ROLLBACK'); transaction = false
    database.close(); database = undefined
    assertJournalAbsent(path)
    assertStillIdentical(source); assertSidecarState(walPath, wal); assertSidecarState(shmPath, shm)
    const storageDigest = sha256(JSON.stringify({
      protocol: 'assistant-automations/operator-storage/v1',
      database: source.digest,
      wal: wal?.digest ?? null,
    }))
    const inventoryDigest = sha256(JSON.stringify({
      protocol: automationsOperatorSnapshotProtocol,
      schemaVersion: 15 as const,
      storageDigest,
      inFlightCount: inFlight.count,
      records,
    }))
    const snapshot = freeze({
      protocol: automationsOperatorSnapshotProtocol,
      schemaVersion: 15 as const,
      database: identity(source),
      sidecars: freeze({ wal: wal === null ? null : identity(wal), shm: shm === null ? null : identity(shm) }),
      storageDigest,
      inFlightCount: inFlight.count,
      inventoryDigest,
      records,
    })
    result = { snapshot, internalRecords }
  } catch (error) {
    deferred = error
  } finally {
    if (transaction) try { database?.exec('ROLLBACK') } catch (error) { deferred ??= error }
    try { database?.close() } catch (error) { deferred ??= error }
    if (source !== undefined) {
      try {
        assertJournalAbsent(path)
        assertStillIdentical(source); assertSidecarState(walPath, wal); assertSidecarState(shmPath, shm)
      } catch (error) { deferred ??= error }
    }
    if (!pinnedParentMatches(pinnedParent)) {
      deferred = new AutomationOperatorSnapshotError(
        'unsafe-parent',
        'automation operator snapshot: database parent changed while it was inspected',
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
        removePinnedTemp(temporaryPinned, ['automations.sqlite', 'automations.sqlite-wal', 'automations.sqlite-shm'])
      } catch (error) { deferred ??= error }
    } else if (temporary !== undefined) {
      try { rmSync(temporary, { recursive: true, force: true }) } catch (error) { deferred ??= error }
    }
    try { closeSync(pinnedParent.descriptor) } catch (error) { deferred ??= error }
  }
  if (deferred !== undefined) {
    if (deferred instanceof AutomationOperatorSnapshotError) throw deferred
    const message = deferred instanceof Error ? deferred.message.toLowerCase() : ''
    if (/(?:busy|locked)/u.test(message)) return fail('database-busy', 'database is busy')
    return fail('database-corrupt', 'database cannot produce a valid snapshot')
  }
  return result!
}

/**
 * Side-effect-free, content-free operator inventory. It never creates, migrates, chmods,
 * checkpoints, or changes journal mode, and fails closed if its source drifts.
 */
export function inspectAutomationsOperatorSnapshot(databasePath: string): AutomationsOperatorSnapshot {
  return readSnapshot(databasePath).snapshot
}

/** Compatibility name for callers built against the earlier inventory proposal. */
export const inspectAutomationInventoryLocally = inspectAutomationsOperatorSnapshot

/**
 * Whether a snapshot failure is solely the legacy writable-store condition
 * "database file has not been created yet". The strict operator snapshot keeps
 * failing closed; only the list-* compatibility projections treat it as the
 * empty inventory that a fresh store would have created and returned.
 */
function isMissingDatabase(error: unknown): error is AutomationOperatorSnapshotError {
  return error instanceof AutomationOperatorSnapshotError && error.code === 'database-missing'
}

function compatibilityRecords(databasePath: string): readonly InternalAutomationOperatorRecord[] {
  try {
    return readSnapshot(databasePath).internalRecords
  } catch (error) {
    if (isMissingDatabase(error)) return Object.freeze([])
    throw error
  }
}

/** Read-only local compatibility projection; never starts the scheduler. */
export function listAutomationsLocally(databasePath: string): AutomationRecord[] {
  return compatibilityRecords(databasePath).map(record => freeze({
    id: record.id,
    ...(record.owner === undefined ? {} : { owner: record.owner }),
    definition: record.definition,
    status: record.status,
    nextRunAt: record.nextRunAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    version: record.version,
  }))
}

/** Compatibility projection retained for callers that only gate active work. */
export function listActiveAutomationsLocally(databasePath: string): AutomationRecord[] {
  return listAutomationsLocally(databasePath).filter(record => record.status === 'active')
}
