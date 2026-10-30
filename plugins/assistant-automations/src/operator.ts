import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync, rmdirSync, unlinkSync, writeSync } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { automationSchemaVersion } from './sqlite.js'
import { assertNoMacProcessConnection, macCleanupPinnedDirectory, macConnectionInodes, macExclusiveWriter } from './operator-macos.js'
import { normalizeAutomationDefinition } from './store.js'
import type { AutomationDefinition, AutomationRecord, AutomationStatus } from './types.js'

export const automationRetirementSnapshotProtocol = 'assistant-automations/retirement-snapshot/v1' as const

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
  readonly schemaVersion: 16
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

/** Privileged upgrade proof: definitions can contain task prompts and authority. */
export interface AutomationRetirementDefinitionRecord extends AutomationOperatorRecord {
  readonly definition: AutomationDefinition
  readonly createIdempotencyKeyDigest: string
  /** Exact typed original columns, excluding only status/next-run/update/version. */
  readonly immutableDigest: string
}

export interface AutomationRetirementReceipt {
  readonly owner: string
  readonly automationId: string
  readonly operationId: string
  readonly definitionHash: string
  readonly expectedVersion: number
  readonly definitionVersion: number
  readonly automationStatus: 'paused'
  readonly reason: 'owner-revoked'
  readonly evidenceDigest: string
  readonly retiredAt: number
}

export interface AutomationRetirementHistoryTable {
  readonly name: string
  readonly rowCount: number
  readonly digest: string
}

export interface AutomationRetirementSchemaEntry {
  readonly type: 'table' | 'index' | 'trigger'
  readonly name: string
  readonly table: string
  /** Exact SQLite schema SQL; implicit indexes have null SQL. */
  readonly sql: string | null
}

export interface AutomationRetirementSnapshot {
  readonly protocol: typeof automationRetirementSnapshotProtocol
  readonly schemaVersion: 15 | 16
  readonly database: AutomationOperatorFileIdentity
  readonly sidecars: AutomationsOperatorSnapshot['sidecars']
  readonly storageDigest: string
  readonly inFlightCount: number
  readonly records: readonly AutomationRetirementDefinitionRecord[]
  readonly retirements: readonly AutomationRetirementReceipt[]
  readonly historyTables: readonly AutomationRetirementHistoryTable[]
  readonly schemaEntries: readonly AutomationRetirementSchemaEntry[]
  readonly schemaDigest: string
  readonly snapshotDigest: string
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

// Linux and macOS prove the SQLite connection's dev/inode through their own
// process descriptor directories. Other platforms retain path-based pinning.
const inodeBindSupported = process.platform === 'linux' || process.platform === 'darwin'
const procSelfFd = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd'

/**
 * Enumerate the regular-file inodes held by THIS process, excluding the
 * descriptors the snapshot pinned itself. After the exclusion the only
 * remaining database fds are SQLite's, so a (dev,ino) match proves the
 * connection genuinely opened the pinned inode rather than an attacker's
 * same-name replacement. An attacker in another process cannot plant an fd
 * here because these directories never list another process's descriptors.
 */
function connectionInodes(exclude: ReadonlySet<number>): Array<{ device: bigint; inode: bigint }> {
  if (process.platform === 'darwin') {
    try { return macConnectionInodes(exclude) } catch { fail('database-drift', 'cannot inspect the database connection file descriptors') }
  }
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

/** Require SQLite's own newly opened descriptors, not another connection in this process. */
function assertFreshConnectionBound(files: readonly OpenedFile[], prior: ReadonlySet<number>): void {
  if (process.platform !== 'linux') return
  let entries: string[]
  try { entries = readdirSync(procSelfFd) } catch {
    fail('database-drift', 'cannot inspect the database connection file descriptors')
  }
  const fresh = entries.flatMap(entry => {
    const descriptor = Number(entry)
    if (!Number.isInteger(descriptor) || descriptor <= 2 || prior.has(descriptor)) return []
    try {
      const stat = fstatSync(descriptor, { bigint: true })
      return stat.isFile() ? [{ device: stat.dev, inode: stat.ino }] : []
    } catch { return [] }
  })
  for (const file of files) {
    if (!fresh.some(inode => inode.device === file.stat.dev && inode.inode === file.stat.ino)) {
      fail('database-drift', 'database connection is not bound to a newly opened pinned inode')
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

function pinnedTempMatches(pinned: PinnedTemp): boolean {
  try {
    const linked = lstatSync(pinned.path, { bigint: true })
    const opened = fstatSync(pinned.descriptor, { bigint: true })
    return linked.isDirectory() && !linked.isSymbolicLink() && opened.isDirectory()
      && linked.dev === pinned.device && linked.ino === pinned.inode
      && opened.dev === pinned.device && opened.ino === pinned.inode
      && (opened.mode & 0o7777n) === 0o700n
  } catch { return false }
}

/**
 * Materialise a private byte-for-byte copy and keep its verified descriptor.
 * Linux passes a pinned /proc/self/fd directory reference. macOS checks the
 * pinned parent before/after path creation and proves SQLite opened this copy
 * by inode; an intervening replacement fails closed. The returned file must
 * be closed by the caller.
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
 * Remove only fixed replica names through the pinned directory (Linux /proc
 * reference or macOS helper fchdir). The empty directory is rmdir'd by path
 * only after an identity check; any detected swap retains the replacement.
 * This final check/rmdir is not atomic against a same-owner instantaneous swap.
 */
function removePinnedTemp(pinned: PinnedTemp, names: readonly string[]): void {
  if (process.platform === 'darwin') {
    try {
      try { macCleanupPinnedDirectory({ dev: pinned.device, ino: pinned.inode, descriptor: pinned.descriptor }) }
      catch { fail('database-drift', 'temporary snapshot copy cannot be removed through its pinned directory') }
      if (!pinnedTempMatches(pinned) || readdirSync(pinned.path).length !== 0) {
        fail('database-drift', 'temporary snapshot directory was retargeted before cleanup')
      }
    } finally {
      // Failure keeps the private directory for reconciliation, without leaking its fd.
      try { closeSync(pinned.descriptor) } catch {}
    }
    try { rmdirSync(pinned.path) } catch { fail('database-drift', 'temporary snapshot directory could not be removed') }
    return
  }
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

/** Pin a live SQLite file without reading its bytes: WAL content can advance during a read transaction. */
function openLiveFile(path: string, missing: AutomationOperatorSnapshotErrorCode): OpenedFile {
  let linked: BigIntStats
  try { linked = lstatSync(path, { bigint: true }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') fail(missing, `${basename(path)} does not exist`)
    fail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  const uid = process.getuid?.()
  if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n
    || (linked.mode & 0o7777n) !== 0o600n || uid === undefined || linked.uid !== BigInt(uid)) {
    fail('unsafe-path', `${basename(path)} must be one private owned regular file`)
  }
  let descriptor: number
  try { descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch {
    fail('unsafe-path', `${basename(path)} cannot be opened safely`)
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!sameLiveIdentity(linked, opened) || !sameLiveIdentity(opened, lstatSync(path, { bigint: true }))) {
      fail('database-drift', `${basename(path)} changed while being opened`)
    }
    return { path, descriptor, stat: opened, digest: '' }
  } catch (error) { closeSync(descriptor); throw error }
}

function sameLiveIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && !right.isSymbolicLink() && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.mode === right.mode && left.nlink === right.nlink
}

function assertLiveIdentity(file: OpenedFile): void {
  try {
    if (!sameLiveIdentity(file.stat, fstatSync(file.descriptor, { bigint: true }))
      || !sameLiveIdentity(file.stat, lstatSync(file.path, { bigint: true }))) {
      fail('database-drift', `${basename(file.path)} changed during the read`)
    }
  } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    fail('database-drift', `${basename(file.path)} disappeared during the read`)
  }
}

function openOptionalLiveSidecar(path: string): OpenedFile | null {
  try { lstatSync(path) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    fail('unsafe-path', `${basename(path)} cannot be inspected`)
  }
  return openLiveFile(path, 'database-drift')
}

function assertLiveSidecar(path: string, file: OpenedFile | null): void {
  if (file !== null) return assertLiveIdentity(file)
  try { lstatSync(path); fail('database-drift', `${basename(path)} appeared during the read`) } catch (error) {
    if (error instanceof AutomationOperatorSnapshotError) throw error
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail('database-drift', `${basename(path)} cannot be inspected`)
  }
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
  readonly descriptor: number
}

function lockTargets(files: ReadonlyArray<OpenedFile | null>): LockProbeTarget[] {
  return files.filter((file): file is OpenedFile => file !== null)
    .map(file => ({ dev: file.stat.dev, ino: file.stat.ino, descriptor: file.descriptor }))
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
  if (process.platform === 'darwin') {
    try { if (macExclusiveWriter(targets)) fail('database-busy', 'database has an exclusive writer lock') }
    catch (error) { if (error instanceof AutomationOperatorSnapshotError) throw error; fail('database-busy', 'cannot inspect active database locks') }
    return
  }
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

const retirementColumns: Readonly<Record<string, string>> = {
  "automation_attempts": "attempt_number:INTEGER automation_snapshot_hash:TEXT automation_snapshot_json:TEXT created_at:INTEGER failure_code:TEXT fencing_token:INTEGER finished_at:INTEGER id:TEXT owner_id:TEXT session_id:TEXT started_at:INTEGER status:TEXT task_id:TEXT updated_at:INTEGER",
  "automation_changes": "automation_id:TEXT created_at:INTEGER expected_version:INTEGER idempotency_key:TEXT input_hash:TEXT operation:TEXT result_json:TEXT",
  "automation_circuit_operations": "automation_id:TEXT created_at:INTEGER definition_hash:TEXT expected_circuit_version:INTEGER input_hash:TEXT lease_ms:INTEGER operation_id:TEXT result_json:TEXT system_owner:TEXT",
  "automation_circuits": "automation_id:TEXT definition_hash:TEXT failure_class:TEXT failure_code:TEXT failure_phase:TEXT opened_at:INTEGER probe_lease_until:INTEGER probe_task_id:TEXT probe_token:TEXT state:TEXT updated_at:INTEGER version:INTEGER",
  "automation_definitions": "create_idempotency_key:TEXT created_at:INTEGER definition_hash:TEXT definition_json:TEXT id:TEXT next_run_at:INTEGER status:TEXT system_owner:TEXT updated_at:INTEGER version:INTEGER",
  "automation_evaluation_outbox": "attempt_count:INTEGER created_at:INTEGER id:TEXT last_error_code:TEXT last_failure_at:INTEGER next_attempt_at:INTEGER observation_kind:TEXT payload_json:TEXT run_id:TEXT status:TEXT updated_at:INTEGER",
  "automation_growth_artifacts": "approval_diff_hash:TEXT artifact_id:TEXT automation_id:TEXT canary_evaluation_digest:TEXT canary_evaluation_id:TEXT canary_evaluation_proof_json:TEXT canary_run_id:TEXT canary_task_id:TEXT candidate_digest:TEXT candidate_id:TEXT candidate_revision:INTEGER created_at:INTEGER deadline_at:INTEGER definition_hash:TEXT definition_version:INTEGER evidence_count:INTEGER evidence_digest:TEXT experiment_id:TEXT owner_binding_id:TEXT preset:TEXT principal_id:TEXT privacy_attestation_json:TEXT proposal_id:TEXT shadow_task_id:TEXT state:TEXT steps_json:TEXT template_digest:TEXT template_ref:TEXT updated_at:INTEGER workspace:TEXT",
  "automation_growth_operations": "created_at:INTEGER operation_id:TEXT operation_kind:TEXT payload_digest:TEXT receipt_json:TEXT status:TEXT updated_at:INTEGER",
  "automation_incidents": "alert_ref:TEXT alert_status:TEXT automation_id:TEXT definition_hash:TEXT failure_class:TEXT failure_code:TEXT failure_phase:TEXT id:TEXT lifecycle_generation:INTEGER notification_route_id:TEXT opened_at:INTEGER presentation_revision:INTEGER resolved_at:INTEGER retryability:TEXT run_id:TEXT side_effect_state:TEXT stage:TEXT state:TEXT updated_at:INTEGER version:INTEGER",
  "automation_occurrences": "automation_id:TEXT created_at:INTEGER dry_run:INTEGER external_event_digest:TEXT external_event_json:TEXT id:TEXT reason:TEXT scheduled_at:INTEGER status:TEXT trigger_key:TEXT trigger_kind:TEXT updated_at:INTEGER",
  "automation_proposals": "change_hash:TEXT change_json:TEXT created_at:INTEGER dispatch_json:TEXT expires_at:INTEGER id:TEXT idempotency_key:TEXT policy_proposal_id:TEXT principal:TEXT requester:TEXT result_automation_id:TEXT status:TEXT ttl_ms:INTEGER updated_at:INTEGER version:INTEGER",
  "automation_runs": "artifact_ref:TEXT attempt_id:TEXT automation_id:TEXT created_at:INTEGER definition_hash:TEXT delivery_ref:TEXT delivery_status:TEXT diagnostic_json:TEXT evidence_json:TEXT evidence_status:TEXT execution_mode:TEXT id:TEXT occurrence_id:TEXT output_preview:TEXT session_id:TEXT status:TEXT task_id:TEXT updated_at:INTEGER usage_json:TEXT",
  "automation_system_reconciles": "automation_id:TEXT created_at:INTEGER idempotency_key:TEXT input_hash:TEXT result_json:TEXT system_owner:TEXT",
  "automation_system_retirements": "automation_id:TEXT definition_hash:TEXT definition_version:INTEGER evidence_digest:TEXT expected_version:INTEGER operation_id:TEXT reason:TEXT retired_at:INTEGER system_owner:TEXT",
  "automation_task_acceptance": "binding_generation:INTEGER binding_id:TEXT binding_version:INTEGER contract_digest:TEXT contract_id:TEXT dispatched_at:INTEGER preset:TEXT principal_record_id:TEXT principal_version:INTEGER quiescent:INTEGER submitted:INTEGER task_id:TEXT workspace:TEXT",
  "automation_tasks": "attempt_count:INTEGER automation_id:TEXT cancel_requested:INTEGER claimed_by:TEXT created_at:INTEGER fencing_token:INTEGER id:TEXT lease_until:INTEGER occurrence_id:TEXT status:TEXT updated_at:INTEGER",
  "duty_lease": "fencing_token:INTEGER lease_until:INTEGER owner_id:TEXT singleton:INTEGER updated_at:INTEGER"
}

const retirementIndexes: Readonly<Record<string, string>> = {
  "automation_circuit_operation_scope": "automation_circuit_operations",
  "automation_due": "automation_definitions",
  "automation_evaluation_dispatch": "automation_evaluation_outbox",
  "automation_growth_artifact_state": "automation_growth_artifacts",
  "automation_incident_alert_outbox": "automation_incidents",
  "automation_occurrence_history": "automation_occurrences",
  "automation_open_circuits": "automation_circuits",
  "automation_open_incidents": "automation_incidents",
  "automation_task_claim": "automation_tasks"
}

const retirementAdditions: Readonly<Record<string, string>> = {
  "automation_system_retirements": "CREATE TABLE automation_system_retirements (\n    system_owner TEXT NOT NULL,\n    automation_id TEXT NOT NULL,\n    operation_id TEXT NOT NULL UNIQUE,\n    definition_hash TEXT NOT NULL CHECK(length(definition_hash) = 64),\n    expected_version INTEGER NOT NULL CHECK(expected_version >= 1),\n    definition_version INTEGER NOT NULL CHECK(definition_version = expected_version + 1),\n    reason TEXT NOT NULL CHECK(reason = 'owner-revoked'),\n    evidence_digest TEXT NOT NULL CHECK(length(evidence_digest) = 64),\n    retired_at INTEGER NOT NULL CHECK(retired_at >= 0),\n    PRIMARY KEY(system_owner, automation_id)\n  ) STRICT",
  "automation_retired_no_activate_insert": "CREATE TRIGGER automation_retired_no_activate_insert BEFORE INSERT ON automation_definitions\n    WHEN NEW.status = 'active' AND EXISTS (\n      SELECT 1 FROM automation_system_retirements WHERE system_owner = NEW.system_owner AND automation_id = NEW.id\n    ) BEGIN SELECT RAISE(ABORT, 'system automation is retired'); END",
  "automation_retired_no_activate_update": "CREATE TRIGGER automation_retired_no_activate_update BEFORE UPDATE ON automation_definitions\n    WHEN NEW.status = 'active' AND EXISTS (\n      SELECT 1 FROM automation_system_retirements WHERE system_owner = NEW.system_owner AND automation_id = NEW.id\n    ) BEGIN SELECT RAISE(ABORT, 'system automation is retired'); END",
  "automation_retirements_no_delete": "CREATE TRIGGER automation_retirements_no_delete BEFORE DELETE ON automation_system_retirements\n    BEGIN SELECT RAISE(ABORT, 'system retirement is permanent'); END",
  "automation_retirements_no_update": "CREATE TRIGGER automation_retirements_no_update BEFORE UPDATE ON automation_system_retirements\n    BEGIN SELECT RAISE(ABORT, 'system retirement is immutable'); END"
}

function normalizedSchemaSql(sql: string): string {
  // Whitespace normalization must never rewrite string or quoted identifier bytes.
  return sql.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|\s+/gu,
    token => /^\s/u.test(token) ? ' ' : token).trim()
}

function inspectRetirementSchema(database: DatabaseSync, version: 15 | 16): readonly AutomationRetirementSchemaEntry[] {
  const raw = database.prepare(`SELECT type, name, tbl_name AS "table", sql
    FROM sqlite_schema ORDER BY type COLLATE BINARY, name COLLATE BINARY`).all()
  const entries: AutomationRetirementSchemaEntry[] = []
  const expectedTables = Object.keys(retirementColumns).filter(name => version === 16 || name !== 'automation_system_retirements')
  const seenTables = new Set<string>(); const seenIndexes = new Set<string>(); const seenAdditions = new Set<string>()
  for (const row of raw) {
    if ((row.type !== 'table' && row.type !== 'index' && row.type !== 'trigger')
      || typeof row.name !== 'string' || typeof row.table !== 'string'
      || (row.sql !== null && typeof row.sql !== 'string') || !expectedTables.includes(row.table)) {
      fail('schema-unsupported', 'unreviewed schema entry')
    }
    const entry = row as unknown as AutomationRetirementSchemaEntry
    if (entry.type === 'table') {
      if (entry.name !== entry.table || entry.sql === null || !expectedTables.includes(entry.name)) {
        fail('schema-unsupported', 'unreviewed table')
      }
      const columns = database.prepare(`PRAGMA table_xinfo("${entry.name}")`).all()
      if (columns.some(column => column.hidden !== 0)
        || columns.map(column => `${column.name}:${column.type}`).sort().join(' ') !== retirementColumns[entry.name]) {
        fail('schema-unsupported', 'unreviewed table columns')
      }
      seenTables.add(entry.name)
    } else if (entry.type === 'index') {
      if (entry.sql === null) {
        if (!new RegExp(`^sqlite_autoindex_${entry.table}_[1-9][0-9]*$`, 'u').test(entry.name)) {
          fail('schema-unsupported', 'unreviewed implicit index')
        }
      } else if (retirementIndexes[entry.name] !== entry.table) fail('schema-unsupported', 'unreviewed index')
      else seenIndexes.add(entry.name)
    }
    const addition = retirementAdditions[entry.name]
    if (entry.type === 'trigger' || addition !== undefined) {
      if (version !== 16 || addition === undefined || entry.sql === null
        || normalizedSchemaSql(entry.sql) !== normalizedSchemaSql(addition)) {
        fail('schema-unsupported', 'retirement schema protection is missing or changed')
      }
      seenAdditions.add(entry.name)
    }
    entries.push({ type: entry.type, name: entry.name, table: entry.table, sql: entry.sql })
  }
  const tableKinds = database.prepare('PRAGMA table_list').all().filter(row => row.schema === 'main' && row.name !== 'sqlite_schema')
  if (expectedTables.some(name => !seenTables.has(name))
    || Object.keys(retirementIndexes).some(name => !seenIndexes.has(name))
    || (version === 16 && Object.keys(retirementAdditions).some(name => !seenAdditions.has(name)))
    || tableKinds.length !== expectedTables.length
    || tableKinds.some(row => row.type !== 'table' || row.strict !== 1)) {
    fail('schema-unsupported', 'reviewed schema is incomplete')
  }
  return freeze(entries)
}

/** Length framing and type tags make NULL/text/BLOB/integers/reals unambiguous. */
function typedRowDigest(table: string, columns: readonly string[], row: Record<string, unknown>): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ protocol: 'assistant-automations/retirement-row/v1', table, columns }))
  for (let index = 0; index < columns.length; index++) {
    const kind = row[`t${index}`]; const value = row[`v${index}`]
    let bytes: Buffer
    if (kind === 'null' && value === null) bytes = Buffer.alloc(0)
    else if (kind === 'integer' && typeof value === 'bigint') bytes = Buffer.from(value.toString(), 'ascii')
    else if (kind === 'real' && typeof value === 'number') {
      bytes = Buffer.allocUnsafe(8); bytes.writeDoubleBE(value)
    } else if ((kind === 'text' || kind === 'blob') && value instanceof Uint8Array) bytes = Buffer.from(value)
    else return fail('database-corrupt', 'history value has an unsupported SQLite representation')
    hash.update(`\0${kind}:${bytes.length}:`); hash.update(bytes)
  }
  return hash.digest('hex')
}

function typedProjection(columns: readonly string[]): string {
  return columns.map((column, index) => `typeof("${column}") AS "t${index}",
    CASE WHEN typeof("${column}") = 'text' THEN CAST("${column}" AS BLOB) ELSE "${column}" END AS "v${index}"`).join(', ')
}

function inspectHistoryTable(database: DatabaseSync, name: string): AutomationRetirementHistoryTable {
  // Sort columns independently of migration-era physical column order. Every
  // actual column is included; inspectRetirementSchema validated the full set.
  const columns = retirementColumns[name]!.split(' ').map(column => column.split(':')[0]!)
  const statement = database.prepare(`SELECT ${typedProjection(columns)} FROM "${name}"`)
  statement.setReadBigInts(true)
  const rows: string[] = []
  // Bound memory by fixed-size digests, not stored task/message bodies. Sorting
  // row hashes defines a canonical multiset and supports WITHOUT ROWID tables.
  for (const row of statement.iterate()) rows.push(typedRowDigest(name, columns, row))
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ protocol: 'assistant-automations/retirement-table/v1', name, columns, rowCount: rows.length }))
  for (const digest of rows.sort()) hash.update(`\0${digest}`)
  return freeze({ name, rowCount: rows.length, digest: hash.digest('hex') })
}

function inspectRetirementDefinitions(
  database: DatabaseSync, records: readonly InternalAutomationOperatorRecord[],
): readonly AutomationRetirementDefinitionRecord[] {
  const columns = ['id', 'system_owner', 'definition_hash', 'definition_json', 'created_at', 'create_idempotency_key']
  const statement = database.prepare(`SELECT create_idempotency_key, ${typedProjection(columns)}
    FROM automation_definitions WHERE id = ?`)
  statement.setReadBigInts(true)
  return freeze(records.map(record => {
    const row = statement.get(record.id)
    if (row === undefined || !canonicalText(row.create_idempotency_key, 500)) {
      return fail('database-corrupt', 'definition creation identity is invalid')
    }
    // SQLite TEXT decoding must not collapse distinct malformed UTF-8 bytes
    // into the same JavaScript replacement characters in the public inventory.
    for (const [index, value] of [record.id, record.owner ?? null, record.definitionHash,
      JSON.stringify(record.definition), null, row.create_idempotency_key].entries()) {
      if (index === 4 || value === null) continue
      const bytes = row[`v${index}`]
      if (!(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(Buffer.from(value))) {
        return fail('database-corrupt', 'definition text bytes are not canonical UTF-8')
      }
    }
    const createIdempotencyKeyDigest = typedRowDigest('automation_definitions/create-idempotency-key',
      ['create_idempotency_key'], { t0: row.t5, v0: row.v5 })
    return { ...record, createIdempotencyKeyDigest, immutableDigest: typedRowDigest('automation_definitions', columns, row) }
  }))
}

function retirementDeleteIsRecorded(
  database: DatabaseSync, record: InternalAutomationOperatorRecord, definitionVersion: number,
): boolean {
  // changeApproved(delete) is the only legal transition after retirement: one
  // version increment, the same definition/owner, and its atomic change receipt.
  // Match the exact stored bytes of the writer's public AutomationRecord so an
  // arbitrary deleted status, version or timestamp cannot stand in for that API.
  if (record.status !== 'deleted' || record.version !== definitionVersion + 1) return false
  const result = JSON.stringify({
    id: record.id, ...(record.owner === undefined ? {} : { owner: record.owner }),
    definition: record.definition, status: record.status, createdAt: record.createdAt,
    updatedAt: record.updatedAt, version: record.version,
  })
  const changes = database.prepare(`SELECT input_hash FROM automation_changes
    WHERE automation_id = ? AND operation = 'delete' AND expected_version = ?
      AND created_at = ? AND CAST(result_json AS BLOB) = ? LIMIT 2`)
    .all(record.id, definitionVersion, record.updatedAt, Buffer.from(result))
  return changes.length === 1 && typeof changes[0]?.input_hash === 'string' && digestPattern.test(changes[0].input_hash)
}

function inspectRetirements(database: DatabaseSync, records: readonly InternalAutomationOperatorRecord[]): readonly AutomationRetirementReceipt[] {
  const definitions = new Map(records.map(record => [record.id, record]))
  const operations = new Set<string>(); const tuples = new Set<string>()
  return freeze(database.prepare(`SELECT *, CAST(system_owner AS BLOB) AS owner_bytes,
    CAST(automation_id AS BLOB) AS automation_bytes, CAST(operation_id AS BLOB) AS operation_bytes
    FROM automation_system_retirements
    ORDER BY system_owner COLLATE BINARY, automation_id COLLATE BINARY`).all().map(row => {
    if (!canonicalText(row.system_owner, 200) || !canonicalText(row.automation_id, 500)
      || !canonicalText(row.operation_id, 500) || typeof row.definition_hash !== 'string' || !digestPattern.test(row.definition_hash)
      || !safeInteger(row.expected_version, 1) || !safeInteger(row.definition_version, 2)
      || row.definition_version !== row.expected_version + 1 || row.reason !== 'owner-revoked'
      || typeof row.evidence_digest !== 'string' || !digestPattern.test(row.evidence_digest) || !safeInteger(row.retired_at)) {
      return fail('database-corrupt', 'system retirement receipt is invalid')
    }
    for (const [value, bytes] of [[row.system_owner, row.owner_bytes], [row.automation_id, row.automation_bytes],
      [row.operation_id, row.operation_bytes]]) {
      if (typeof value !== 'string' || !(bytes instanceof Uint8Array) || !Buffer.from(bytes).equals(Buffer.from(value))) {
        return fail('database-corrupt', 'retirement text bytes are not canonical UTF-8')
      }
    }
    const record = definitions.get(row.automation_id)
    const tuple = JSON.stringify([row.system_owner, row.automation_id])
    if (operations.has(row.operation_id) || tuples.has(tuple)) {
      return fail('database-corrupt', 'system retirement receipt identity is duplicated')
    }
    // Permanent markers outlive physical definition deletion. If the row still
    // exists, accept only the exact retired state or its recorded formal delete.
    if (record !== undefined && (record.owner !== row.system_owner || record.definitionHash !== row.definition_hash
      || record.nextRunAt !== undefined
      || !(record.status === 'paused' && record.version === row.definition_version && record.updatedAt === row.retired_at
        || retirementDeleteIsRecorded(database, record, row.definition_version)))) {
      return fail('database-corrupt', 'system retirement receipt is not bound to its exact definition')
    }
    operations.add(row.operation_id); tuples.add(tuple)
    return {
      owner: row.system_owner, automationId: row.automation_id, operationId: row.operation_id,
      definitionHash: row.definition_hash, expectedVersion: row.expected_version, definitionVersion: row.definition_version,
      automationStatus: 'paused' as const, reason: 'owner-revoked' as const, evidenceDigest: row.evidence_digest, retiredAt: row.retired_at,
    }
  }))
}

function retirementContents(database: DatabaseSync, version: 15 | 16, records: readonly InternalAutomationOperatorRecord[]) {
  const schemaEntries = inspectRetirementSchema(database, version)
  const schemaDigest = sha256(JSON.stringify({ protocol: 'assistant-automations/retirement-schema/v1', schemaEntries }))
  const historyTables = Object.keys(retirementColumns).filter(name => name !== 'automation_definitions'
    && name !== 'automation_system_retirements').sort().map(name => inspectHistoryTable(database, name))
  return freeze({
    records: inspectRetirementDefinitions(database, records),
    retirements: version === 15 ? [] : inspectRetirements(database, records),
    historyTables, schemaEntries, schemaDigest,
  })
}

interface OperatorReadResult {
  snapshot: AutomationsOperatorSnapshot
  internalRecords: readonly InternalAutomationOperatorRecord[]
}

function readSnapshot(databasePath: string, retirement: true): AutomationRetirementSnapshot
function readSnapshot(databasePath: string, retirement?: false): OperatorReadResult
function readSnapshot(databasePath: string, retirement = false): OperatorReadResult | AutomationRetirementSnapshot {
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
  let result: OperatorReadResult | AutomationRetirementSnapshot | undefined
  let deferred: unknown
  // Descriptors the snapshot itself holds; these are excluded when proving that
  // SQLite opened the pinned inode, so the connection can never vouch for itself.
  const selfDescriptors = (): ReadonlySet<number> => new Set([
    pinnedParent.descriptor, source?.descriptor, wal?.descriptor, shm?.descriptor,
    temporaryPinned?.descriptor, ...copyFiles.map(file => file.descriptor),
  ].filter((descriptor): descriptor is number => descriptor !== undefined))
  try {
    if (process.platform === 'darwin') {
      // Closing any descriptor of a SQLite inode can release this process's POSIX locks.
      // Check without opening the source, including both WAL sidecars.
      try { assertNoMacProcessConnection([path, walPath, shmPath]) }
      catch { fail('database-busy', 'database is open in this process or descriptors cannot be inspected') }
    }
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
      if (process.platform === 'linux') {
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
      } else if (process.platform === 'darwin') {
        temporaryPinned = pinTempDirectory(temporary)
        const copy = join(temporary, 'automations.sqlite')
        if (!pinnedTempMatches(temporaryPinned)) fail('database-drift', 'temporary snapshot directory changed before copy')
        const copiedMain = copyAndPin(source, copy)
        let copiedWal: OpenedFile | undefined
        try { copiedWal = copyAndPin(wal, `${copy}-wal`) }
        catch (error) { try { closeSync(copiedMain.descriptor) } catch {}; throw error }
        copyFiles = Object.freeze([copiedMain, copiedWal])
        if (!pinnedTempMatches(temporaryPinned) || !copyFiles.every(pinnedFileIdentityMatches)) {
          fail('database-drift', 'temporary snapshot copy changed before SQLite open')
        }
        target = copy
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
    if (version !== automationSchemaVersion && !(retirement && version === 15)) {
      fail('schema-unsupported', retirement ? 'expected schema 15 or 16' : `expected schema ${automationSchemaVersion}`)
    }
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
    const proof = retirement ? retirementContents(database, version as 15 | 16, internalRecords) : undefined
    // History scans can lazily open SQLite resources as well.
    if (inodeBindSupported) assertConnectionBound(bound, selfDescriptors())
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
      schemaVersion: 16 as const,
      storageDigest,
      inFlightCount: inFlight.count,
      records,
    }))
    const snapshot = freeze({
      protocol: automationsOperatorSnapshotProtocol,
      schemaVersion: 16 as const,
      database: identity(source),
      sidecars: freeze({ wal: wal === null ? null : identity(wal), shm: shm === null ? null : identity(shm) }),
      storageDigest,
      inFlightCount: inFlight.count,
      inventoryDigest,
      records,
    })
    if (proof !== undefined) {
      const semantic = {
        protocol: automationRetirementSnapshotProtocol,
        schemaVersion: version as 15 | 16,
        storageDigest,
        inFlightCount: inFlight.count,
        ...proof,
      }
      result = freeze({
        ...semantic,
        database: identity(source),
        sidecars: freeze({ wal: wal === null ? null : identity(wal), shm: shm === null ? null : identity(shm) }),
        snapshotDigest: sha256(JSON.stringify(semantic)),
      })
    } else result = { snapshot, internalRecords }
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
    } else if (temporary !== undefined && process.platform !== 'darwin') {
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

/**
 * Privileged read-only v15/v16 upgrade proof. Never migrates or opens a writable
 * SQLite handle. History bodies remain private; their exact typed bytes are hashed.
 */
export function inspectAutomationRetirementSnapshot(databasePath: string): AutomationRetirementSnapshot {
  return readSnapshot(databasePath, true)
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

/**
 * Read current active registrations through SQLite's own consistent read transaction.
 * The source WAL/SHM must already exist as a safe pair. SQLite may coordinate
 * readers through the existing SHM file; this is not a byte-for-byte backup.
 */
export function listActiveAutomationsForReadiness(databasePath: string): AutomationRecord[] {
  const path = privateDatabasePath(databasePath)
  const parent = pinPrivateParent(dirname(path))
  const walPath = `${path}-wal`; const shmPath = `${path}-shm`
  let source: OpenedFile | undefined
  let wal: OpenedFile | null = null; let shm: OpenedFile | null = null
  let database: DatabaseSync | undefined
  let transaction = false
  let records: AutomationRecord[] | undefined
  let deferred: unknown
  let priorDescriptors: ReadonlySet<number> = new Set()
  const selfDescriptors = (): ReadonlySet<number> => new Set([
    parent.descriptor, source?.descriptor, wal?.descriptor, shm?.descriptor,
  ].filter((fd): fd is number => fd !== undefined))
  try {
    if (process.platform === 'darwin') {
      try { assertNoMacProcessConnection([path, walPath, shmPath]) } catch {
        fail('database-busy', 'database is open in this process or descriptors cannot be inspected')
      }
    }
    assertNoRollbackJournal(path)
    source = openLiveFile(path, 'database-missing')
    wal = openOptionalLiveSidecar(walPath); shm = openOptionalLiveSidecar(shmPath)
    if ((wal === null) !== (shm === null)) fail('database-drift', 'WAL sidecar set is incomplete')
    if (wal === null) {
      // SQLite's read-only WAL open can create a new SHM. Refuse that state
      // before opening, while still supporting a quiescent rollback database.
      const header = Buffer.alloc(2)
      if (readSync(source.descriptor, header, 0, 2, 18) !== 2 || header[0] === 2 || header[1] === 2) {
        fail('database-busy', 'WAL database has no existing coordination sidecars')
      }
    }
    assertJournalAbsent(path)
    assertLiveIdentity(source); assertLiveSidecar(walPath, wal); assertLiveSidecar(shmPath, shm)
    if (process.platform === 'linux') {
      priorDescriptors = new Set(readdirSync(procSelfFd).map(Number).filter(descriptor => {
        if (!Number.isInteger(descriptor) || descriptor <= 2) return false
        try { return fstatSync(descriptor, { bigint: true }).isFile() } catch { return false }
      }))
      const held = connectionInodes(selfDescriptors())
      if ([source, wal, shm].filter((file): file is OpenedFile => file !== null && file !== undefined)
        .some(file => held.some(inode => inode.device === file.stat.dev && inode.inode === file.stat.ino))) {
        fail('database-busy', 'database is already open in this process')
      }
    }
    const location = pathToFileURL(path)
    location.searchParams.set('mode', 'ro')
    database = new DatabaseSync(location, { readOnly: true })
    if (inodeBindSupported) assertConnectionBound([source], selfDescriptors())
    assertFreshConnectionBound([source], priorDescriptors)
    database.exec('PRAGMA query_only = ON; PRAGMA busy_timeout = 0; BEGIN'); transaction = true
    const queryOnly = (database.prepare('PRAGMA query_only').get() as { query_only?: unknown }).query_only
    if (queryOnly !== 1) fail('database-unavailable', 'read-only guard was not enabled')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    if (version !== automationSchemaVersion) fail('schema-unsupported', `expected schema ${automationSchemaVersion}`)
    const rows = database.prepare(`
      SELECT id, system_owner, definition_hash, definition_json, status, next_run_at,
        created_at, updated_at, version, 0 AS running_task_count
      FROM automation_definitions WHERE status = 'active' ORDER BY id COLLATE BINARY
    `).all() as unknown as DefinitionRow[]
    records = rows.map(row => {
      const record = parseRecord(row)
      return freeze({
        id: record.id,
        ...(record.owner === undefined ? {} : { owner: record.owner }),
        definition: record.definition,
        status: record.status,
        nextRunAt: record.nextRunAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        version: record.version,
      })
    })
    const bound = [source, ...(wal === null ? [] : [wal, shm!])]
    if (inodeBindSupported) assertConnectionBound(bound, selfDescriptors())
    assertFreshConnectionBound(bound, priorDescriptors)
    assertJournalAbsent(path)
    assertLiveIdentity(source); assertLiveSidecar(walPath, wal); assertLiveSidecar(shmPath, shm)
    database.exec('ROLLBACK'); transaction = false
    database.close(); database = undefined
  } catch (error) { deferred = error } finally {
    if (transaction) try { database?.exec('ROLLBACK') } catch (error) { deferred ??= error }
    try { database?.close() } catch (error) { deferred ??= error }
    if (source !== undefined) {
      try {
        assertJournalAbsent(path)
        assertLiveIdentity(source); assertLiveSidecar(walPath, wal); assertLiveSidecar(shmPath, shm)
      } catch (error) { deferred ??= error }
    }
    if (!pinnedParentMatches(parent)) {
      deferred = new AutomationOperatorSnapshotError('unsafe-parent',
        'automation operator snapshot: database parent changed while it was inspected')
    }
    for (const file of [shm, wal, source]) if (file != null) try { closeSync(file.descriptor) } catch {}
    try { closeSync(parent.descriptor) } catch (error) { deferred ??= error }
  }
  if (deferred !== undefined) {
    if (deferred instanceof AutomationOperatorSnapshotError) throw deferred
    const message = deferred instanceof Error ? deferred.message.toLowerCase() : ''
    if (/(?:busy|locked)/u.test(message)) fail('database-busy', 'database is busy')
    fail('database-corrupt', 'database cannot produce valid active registrations')
  }
  return records!
}
