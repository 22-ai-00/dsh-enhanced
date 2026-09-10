import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync,
  linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const ISOLATION_AUDIT_ARCHIVE_PROTOCOL = 'dsh-isolation-audit-archive/v1' as const

const LEDGER_SCHEMA = 6
const DEFAULT_BATCH_SIZE = 100
const MAX_BATCH_SIZE = 1_000
const MAX_TEXT_LENGTH = 16_384
const MAX_ARCHIVE_FILE_BYTES = 32 * 1_024 * 1_024
const ARCHIVE_PREFIX = 'isolation-audit-v1-'
const ARCHIVE_SUFFIX = '.ndjson'
const CONTROL_FILE = '.archive-control.sqlite'
const DIGEST = /^[a-f0-9]{64}$/u
const ARCHIVE_FILE = /^isolation-audit-v1-([a-f0-9]{64})\.ndjson$/u
const TEMP_FILE = /^\.isolation-audit-v1-([a-f0-9]{64})\.[1-9][0-9]*\.[0-9a-f-]{36}\.tmp$/u
const CONTROL_FILES = new Set([CONTROL_FILE, `${CONTROL_FILE}-journal`, `${CONTROL_FILE}-wal`, `${CONTROL_FILE}-shm`])
const ARCHIVE_INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export type IsolationAuditArchiveErrorCode = 'conflict' | 'invalid-input' | 'invalid-path' | 'invalid-source' | 'invalid-archive' | 'io'

export class IsolationAuditArchiveError extends Error {
  constructor(readonly code: IsolationAuditArchiveErrorCode, message: string = code) {
    super(message)
    this.name = 'IsolationAuditArchiveError'
  }
}

export interface IsolationAuditArchiveManifest {
  readonly archiveInstanceId: string
  readonly count: number
  readonly firstSequence: number
  readonly lastSequence: number
  readonly ledgerSchema: 6
  readonly previousDigest: string | null
  readonly protocol: typeof ISOLATION_AUDIT_ARCHIVE_PROTOCOL
  readonly snapshotThroughSequence: number
  readonly sourceStateRootDigest: string
  readonly type: 'manifest'
  readonly version: 1
}

export interface IsolationAuditArchiveRecord {
  readonly action: string
  readonly detail: string
  readonly grantId: string | null
  readonly jobId: string | null
  readonly occurredAt: number
  readonly sequence: number
}

export interface IsolationAuditArchiveVerification {
  readonly valid: true
  readonly protocol: typeof ISOLATION_AUDIT_ARCHIVE_PROTOCOL
  readonly fileCount: number
  readonly archiveInstanceId: string
  readonly recordCount: number
  readonly highestSequence: number
  readonly snapshotThroughSequence: number
  readonly headDigest: string
  readonly sourceStateRootDigest: string
}

export interface IsolationAuditArchiveResult {
  readonly createdFiles: readonly string[]
  readonly createdRecords: number
  readonly verification: IsolationAuditArchiveVerification
}

type AuditRow = { sequence: unknown; occurred_at: unknown; action: unknown; job_id: unknown; grant_id: unknown; detail: unknown }
type ArchiveFile = { name: string; digest: string; manifest: IsolationAuditArchiveManifest; records: IsolationAuditArchiveRecord[] }
type InternalArchiveVerification = Omit<IsolationAuditArchiveVerification, 'archiveInstanceId' | 'headDigest' | 'sourceStateRootDigest'> & { archiveInstanceId: string | null; headDigest: string | null; sourceStateRootDigest: string | null }
type VerifiedArchive = { files: ArchiveFile[]; verification: InternalArchiveVerification }
type SecureDirectory = { path: string; descriptor: number; device: bigint; inode: bigint }
type ControlFileIdentity = { path: string; device: bigint; inode: bigint; owner: bigint }
type ArchiveControl = { database: DatabaseSync; archiveInstanceId: string; sourceStateRootDigest: string; file: ControlFileIdentity }

function fail(code: IsolationAuditArchiveErrorCode, message?: string): never { throw new IsolationAuditArchiveError(code, message) }
function safeNatural(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0 }
function safePositive(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0 }
function plain(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype }
function rowObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}
function boundedText(value: unknown, nullable = false): value is string | null {
  return (nullable && value === null) || (typeof value === 'string' && value.length > 0 && value.length <= MAX_TEXT_LENGTH)
}
function boundedDetail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= MAX_ARCHIVE_FILE_BYTES
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) freeze(item)
    Object.freeze(value)
  }
  return value
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('invalid-archive', 'archive JSON contains a non-safe integer'); return JSON.stringify(value) }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (!plain(value)) fail('invalid-archive', 'archive JSON must contain only plain data')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function digest(content: Buffer | string): string { return createHash('sha256').update(content).digest('hex') }
function sameInode(left: { dev: bigint | number; ino: bigint | number }, right: { dev: bigint | number; ino: bigint | number }): boolean {
  return BigInt(left.dev) === BigInt(right.dev) && BigInt(left.ino) === BigInt(right.ino)
}

function secureDirectory(path: string, label: string): SecureDirectory {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path === '/' || /[\p{Cc}]/u.test(path)) fail('invalid-path', `${label} must be an absolute normalized directory`)
  let descriptor: number | undefined
  try {
    const entry = lstatSync(path, { bigint: true })
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid?.() ?? -1) || (entry.mode & 0o7777n) !== 0o700n || realpathSync.native(path) !== path) fail('invalid-path', `${label} must be a canonical private owned directory`)
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true }); const after = lstatSync(path, { bigint: true })
    if (!opened.isDirectory() || opened.uid !== entry.uid || (opened.mode & 0o7777n) !== 0o700n || !sameInode(entry, opened) || !sameInode(opened, after)) fail('invalid-path', `${label} changed while being opened`)
    return { path, descriptor, device: opened.dev, inode: opened.ino }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error instanceof IsolationAuditArchiveError) throw error
    fail('invalid-path', `${label} is unavailable`)
  }
}
function closeDirectory(directory: SecureDirectory): void { closeSync(directory.descriptor) }
function stillSameDirectory(directory: SecureDirectory): void {
  try {
    const opened = fstatSync(directory.descriptor, { bigint: true }); const linked = lstatSync(directory.path, { bigint: true })
    if (!sameInode(opened, linked) || opened.dev !== directory.device || opened.ino !== directory.inode) fail('invalid-path', 'archive directory changed during operation')
  } catch (error) { if (error instanceof IsolationAuditArchiveError) throw error; fail('invalid-path', 'archive directory changed during operation') }
}
function disjoint(left: string, right: string): boolean {
  if (left === right) return false
  const leftToRight = relative(left, right); const rightToLeft = relative(right, left)
  return (leftToRight.startsWith('..') || isAbsolute(leftToRight)) && (rightToLeft.startsWith('..') || isAbsolute(rightToLeft))
}

function inspectPrivateFile(path: string, label: string, maximum = Number.MAX_SAFE_INTEGER): { descriptor: number; size: number } {
  let descriptor: number | undefined
  try {
    const before = lstatSync(path, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o7777n) !== 0o600n || before.size > BigInt(maximum)) fail('invalid-archive', `${label} must be one bounded private owned regular file`)
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true }); const after = lstatSync(path, { bigint: true })
    if (!opened.isFile() || opened.nlink !== 1n || opened.uid !== before.uid || (opened.mode & 0o7777n) !== 0o600n || opened.size !== before.size || !sameInode(before, opened) || !sameInode(opened, after)) fail('invalid-archive', `${label} changed while being opened`)
    return { descriptor, size: Number(opened.size) }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error instanceof IsolationAuditArchiveError) throw error
    fail('invalid-archive', `${label} is unavailable`)
  }
}
function readPrivateFile(path: string, label: string, maximum = Number.MAX_SAFE_INTEGER): Buffer {
  const opened = inspectPrivateFile(path, label, maximum)
  try {
    const content = readFileSync(opened.descriptor)
    const after = fstatSync(opened.descriptor, { bigint: true })
    if (content.byteLength !== opened.size || after.size !== BigInt(opened.size) || after.nlink !== 1n) fail('invalid-archive', `${label} changed while being read`)
    return content
  } finally { closeSync(opened.descriptor) }
}
function validateControlArtifact(path: string, name: string): void {
  if (!existsSync(path)) return
  const opened = inspectPrivateFile(path, name)
  closeSync(opened.descriptor)
}
function controlFileIdentity(path: string): ControlFileIdentity {
  const opened = inspectPrivateFile(path, 'archive control database')
  try {
    const stat = fstatSync(opened.descriptor, { bigint: true })
    return { path, device: stat.dev, inode: stat.ino, owner: stat.uid }
  } finally { closeSync(opened.descriptor) }
}
function validateLockedControlPath(identity: ControlFileIdentity): void {
  try {
    const linked = lstatSync(identity.path, { bigint: true })
    if (!linked.isFile() || linked.isSymbolicLink() || linked.nlink !== 1n || linked.uid !== identity.owner || (linked.mode & 0o7777n) !== 0o600n
      || linked.dev !== identity.device || linked.ino !== identity.inode) fail('invalid-archive', 'archive control database changed while locked')
  } catch (error) {
    if (error instanceof IsolationAuditArchiveError) throw error
    fail('invalid-archive', 'archive control database changed while locked')
  }
}

function decodeManifest(value: unknown): IsolationAuditArchiveManifest {
  const keys = ['archiveInstanceId', 'count', 'firstSequence', 'lastSequence', 'ledgerSchema', 'previousDigest', 'protocol', 'snapshotThroughSequence', 'sourceStateRootDigest', 'type', 'version']
  if (!plain(value) || !exactKeys(value, keys) || typeof value.archiveInstanceId !== 'string' || !ARCHIVE_INSTANCE_ID.test(value.archiveInstanceId) || typeof value.sourceStateRootDigest !== 'string' || !DIGEST.test(value.sourceStateRootDigest) || !safeNatural(value.count) || value.count > MAX_BATCH_SIZE
    || !safePositive(value.firstSequence) || !safeNatural(value.lastSequence) || value.ledgerSchema !== LEDGER_SCHEMA
    || (value.previousDigest !== null && (typeof value.previousDigest !== 'string' || !DIGEST.test(value.previousDigest)))
    || value.protocol !== ISOLATION_AUDIT_ARCHIVE_PROTOCOL || !safeNatural(value.snapshotThroughSequence) || value.type !== 'manifest' || value.version !== 1) fail('invalid-archive', 'invalid audit archive manifest')
  if (value.count === 0) {
    if (value.firstSequence !== 1 || value.lastSequence !== 0 || value.snapshotThroughSequence !== 0 || value.previousDigest !== null) fail('invalid-archive', 'invalid audit archive genesis manifest')
  } else if (value.lastSequence !== value.firstSequence + value.count - 1 || value.lastSequence > value.snapshotThroughSequence) fail('invalid-archive', 'inconsistent audit archive manifest bounds')
  return freeze({ archiveInstanceId: value.archiveInstanceId, count: value.count, firstSequence: value.firstSequence, lastSequence: value.lastSequence, ledgerSchema: 6, previousDigest: value.previousDigest, protocol: ISOLATION_AUDIT_ARCHIVE_PROTOCOL, snapshotThroughSequence: value.snapshotThroughSequence, sourceStateRootDigest: value.sourceStateRootDigest, type: 'manifest', version: 1 })
}
function decodeRecord(value: unknown): IsolationAuditArchiveRecord {
  const keys = ['action', 'detail', 'grantId', 'jobId', 'occurredAt', 'sequence']
  if (!plain(value) || !exactKeys(value, keys) || !boundedText(value.action) || !boundedDetail(value.detail) || !boundedText(value.grantId, true) || !boundedText(value.jobId, true) || !safeNatural(value.occurredAt) || !safePositive(value.sequence)) fail('invalid-archive', 'invalid audit archive record')
  return freeze({ action: value.action, detail: value.detail, grantId: value.grantId, jobId: value.jobId, occurredAt: value.occurredAt, sequence: value.sequence }) as IsolationAuditArchiveRecord
}
function parseArchiveFile(directory: string, name: string, expectedDigest: string): ArchiveFile {
  const content = readPrivateFile(join(directory, name), `archive file ${name}`, MAX_ARCHIVE_FILE_BYTES)
  if (content.byteLength === 0 || content[content.byteLength - 1] !== 0x0a) fail('invalid-archive', `archive file ${name} is truncated`)
  const calculated = digest(content)
  if (calculated !== expectedDigest) fail('invalid-archive', `archive file ${name} digest does not match its filename`)
  const text = content.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(content) || text.includes('\r')) fail('invalid-archive', `archive file ${name} is not canonical UTF-8 NDJSON`)
  const lines = text.slice(0, -1).split('\n')
  if (lines.some(line => line.length === 0)) fail('invalid-archive', `archive file ${name} has an empty NDJSON line`)
  let rawManifest: unknown
  try { rawManifest = JSON.parse(lines[0]!) } catch { fail('invalid-archive', `archive file ${name} has malformed JSON`) }
  if (canonical(rawManifest) !== lines[0]) fail('invalid-archive', `archive file ${name} manifest is not canonical JSON`)
  const manifest = decodeManifest(rawManifest)
  const records: IsolationAuditArchiveRecord[] = []
  for (const line of lines.slice(1)) {
    let raw: unknown
    try { raw = JSON.parse(line) } catch { fail('invalid-archive', `archive file ${name} has malformed JSON`) }
    if (canonical(raw) !== line) fail('invalid-archive', `archive file ${name} record is not canonical JSON`)
    records.push(decodeRecord(raw))
  }
  if (records.length !== manifest.count) fail('invalid-archive', `archive file ${name} count does not match its records`)
  if (records.length > 0 && (records[0]!.sequence !== manifest.firstSequence || records.at(-1)!.sequence !== manifest.lastSequence)) fail('invalid-archive', `archive file ${name} record bounds do not match its manifest`)
  for (let index = 0; index < records.length; index += 1) if (records[index]!.sequence !== manifest.firstSequence + index) fail('invalid-archive', `archive file ${name} has a sequence gap or reorder`)
  return { name, digest: expectedDigest, manifest, records }
}

function readControlIdentity(directory: SecureDirectory): { archiveInstanceId: string; sourceStateRootDigest: string } | null {
  const path = join(directory.path, CONTROL_FILE)
  if (!existsSync(path)) return null
  const opened = inspectPrivateFile(path, 'archive control database'); closeSync(opened.descriptor)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(path, { readOnly: true }); database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    const row = database.prepare('SELECT archive_instance_id, source_state_root_digest FROM archive_control WHERE singleton=1').get() as { archive_instance_id?: unknown; source_state_root_digest?: unknown } | undefined
    if (version !== 1 || typeof row?.archive_instance_id !== 'string' || !ARCHIVE_INSTANCE_ID.test(row.archive_instance_id) || typeof row.source_state_root_digest !== 'string' || !DIGEST.test(row.source_state_root_digest)) fail('invalid-archive', 'invalid archive control identity')
    database.exec('COMMIT')
    return { archiveInstanceId: row.archive_instance_id, sourceStateRootDigest: row.source_state_root_digest }
  } catch (error) {
    try { database?.exec('ROLLBACK') } catch {}
    if (error instanceof IsolationAuditArchiveError) throw error
    return fail('invalid-archive', 'invalid archive control database')
  } finally { database?.close() }
}

function verifyArchive(directory: SecureDirectory, expectedIdentity?: { archiveInstanceId: string; sourceStateRootDigest: string }, allowIncompleteTail = false, allowUninitialized = false, lockedControl?: ControlFileIdentity): VerifiedArchive {
  stillSameDirectory(directory)
  const parsed: ArchiveFile[] = []
  let names: string[]
  try { names = readdirSync(directory.path) } catch { fail('invalid-archive', 'archive directory cannot be read') }
  for (const name of names) {
    const match = ARCHIVE_FILE.exec(name)
    if (match) { parsed.push(parseArchiveFile(directory.path, name, match[1]!)); continue }
    if (CONTROL_FILES.has(name)) {
      if (name === CONTROL_FILE && lockedControl !== undefined) validateLockedControlPath(lockedControl)
      else validateControlArtifact(join(directory.path, name), name)
      continue
    }
    if (TEMP_FILE.test(name)) { validateControlArtifact(join(directory.path, name), name); continue }
    fail('invalid-archive', `unknown file in audit archive: ${name}`)
  }
  const controlIdentity = expectedIdentity ?? readControlIdentity(directory) ?? undefined
  if (parsed.length === 0) {
    if (!allowUninitialized || controlIdentity === undefined) fail('invalid-archive', 'audit archive has no genesis file')
    return { files: [], verification: freeze({ valid: true, protocol: ISOLATION_AUDIT_ARCHIVE_PROTOCOL, fileCount: 0, archiveInstanceId: controlIdentity.archiveInstanceId, recordCount: 0, highestSequence: 0, snapshotThroughSequence: 0, headDigest: null, sourceStateRootDigest: controlIdentity.sourceStateRootDigest }) }
  }
  const genesis = parsed.filter(file => file.manifest.previousDigest === null)
  if (genesis.length !== 1) fail('invalid-archive', 'audit archive must have exactly one chain root')
  const successors = new Map<string, ArchiveFile>()
  for (const file of parsed) if (file.manifest.previousDigest !== null) {
    if (successors.has(file.manifest.previousDigest)) fail('invalid-archive', 'audit archive contains a fork')
    successors.set(file.manifest.previousDigest, file)
  }
  const ordered: ArchiveFile[] = []
  const consumed = new Set<string>()
  let current: ArchiveFile | undefined = genesis[0]
  while (current) {
    if (consumed.has(current.digest)) fail('invalid-archive', 'audit archive contains a cycle')
    consumed.add(current.digest); ordered.push(current); current = successors.get(current.digest)
  }
  if (consumed.size !== parsed.length) fail('invalid-archive', 'audit archive contains an orphan or invalid previous digest')
  let expectedSequence = 1; let snapshotThroughSequence = 0; let recordCount = 0
  for (let fileIndex = 0; fileIndex < ordered.length; fileIndex += 1) {
    const file = ordered[fileIndex]!; const { manifest } = file
    if (manifest.archiveInstanceId !== ordered[0]!.manifest.archiveInstanceId) fail('invalid-archive', 'audit archive instance identity changed within the chain')
    if (manifest.sourceStateRootDigest !== ordered[0]!.manifest.sourceStateRootDigest) fail('invalid-archive', 'audit archive source identity changed within the chain')
    if (fileIndex === 0 && manifest.count === 0) {
      if (ordered.length > 1 && ordered[1]!.manifest.firstSequence !== 1) fail('invalid-archive', 'audit archive does not continue after genesis')
    } else {
      if (manifest.count === 0 || manifest.firstSequence !== expectedSequence) fail('invalid-archive', 'audit archive has a gap, reorder, or duplicate sequence')
      expectedSequence = manifest.lastSequence + 1; recordCount += manifest.count
    }
    if (manifest.snapshotThroughSequence < snapshotThroughSequence) fail('invalid-archive', 'audit archive snapshot high-water regressed')
    snapshotThroughSequence = manifest.snapshotThroughSequence
  }
  const head = ordered.at(-1)!
  const highestSequence = expectedSequence - 1
  if (!allowIncompleteTail && head.manifest.snapshotThroughSequence !== highestSequence) fail('invalid-archive', 'audit archive has an incomplete snapshot tail')
  const archiveInstanceId = ordered[0]!.manifest.archiveInstanceId
  const sourceStateRootDigest = ordered[0]!.manifest.sourceStateRootDigest
  if (controlIdentity !== undefined && (controlIdentity.archiveInstanceId !== archiveInstanceId || controlIdentity.sourceStateRootDigest !== sourceStateRootDigest)) fail('invalid-archive', 'archive chain identity differs from its control identity')
  return { files: ordered, verification: freeze({ valid: true, protocol: ISOLATION_AUDIT_ARCHIVE_PROTOCOL, fileCount: ordered.length, archiveInstanceId, recordCount, highestSequence, snapshotThroughSequence, headDigest: head.digest, sourceStateRootDigest }) }
}

/** Verify a complete local hash chain. External anchoring is required to detect valid tail deletion or full recomputation. */
export function verifyIsolationAuditArchive(archiveDirectory: string): IsolationAuditArchiveVerification {
  const directory = secureDirectory(archiveDirectory, 'isolation audit archive directory')
  try {
    const verification = verifyArchive(directory).verification
    if (verification.archiveInstanceId === null || verification.headDigest === null || verification.sourceStateRootDigest === null) fail('invalid-archive', 'audit archive has no anchorable genesis')
    return verification as IsolationAuditArchiveVerification
  } finally { closeDirectory(directory) }
}

function ensureControlFile(directory: SecureDirectory): ControlFileIdentity {
  const path = join(directory.path, CONTROL_FILE)
  if (!existsSync(path)) {
    let descriptor: number | undefined
    try { descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fchmodSync(descriptor, 0o600); fsyncSync(descriptor) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') fail('io', 'cannot create archive control database') }
    finally { if (descriptor !== undefined) closeSync(descriptor) }
    fsyncSync(directory.descriptor)
  }
  return controlFileIdentity(path)
}
function recoverTemporaryPublications(directory: SecureDirectory): void {
  let changed = false
  for (const name of readdirSync(directory.path)) {
    const match = TEMP_FILE.exec(name)
    if (!match) continue
    const temporaryPath = join(directory.path, name)
    let temporary
    try { temporary = lstatSync(temporaryPath, { bigint: true }) } catch { continue }
    if (!temporary.isFile() || temporary.isSymbolicLink() || temporary.uid !== BigInt(process.getuid?.() ?? -1) || (temporary.mode & 0o7777n) !== 0o600n || (temporary.nlink !== 1n && temporary.nlink !== 2n)) fail('invalid-archive', `unsafe archive temporary file ${name}`)
    if (temporary.nlink === 2n) {
      const targetName = `${ARCHIVE_PREFIX}${match[1]!}${ARCHIVE_SUFFIX}`
      const targetPath = join(directory.path, targetName)
      let target
      try { target = lstatSync(targetPath, { bigint: true }) } catch { fail('invalid-archive', `archive temporary hardlink ${name} has no matching target`) }
      if (!target.isFile() || target.isSymbolicLink() || target.nlink !== 2n || target.uid !== temporary.uid || (target.mode & 0o7777n) !== 0o600n || !sameInode(temporary, target)) fail('invalid-archive', `archive temporary hardlink ${name} does not match its target`)
      let descriptor: number | undefined
      try {
        descriptor = openSync(temporaryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        const opened = fstatSync(descriptor, { bigint: true }); const after = lstatSync(temporaryPath, { bigint: true })
        if (!sameInode(temporary, opened) || !sameInode(opened, after) || opened.nlink !== 2n) fail('invalid-archive', `archive temporary hardlink ${name} changed while being opened`)
        const content = readFileSync(descriptor)
        if (content.byteLength > MAX_ARCHIVE_FILE_BYTES || digest(content) !== match[1]) fail('invalid-archive', `archive temporary hardlink ${name} has invalid content`)
      } finally { if (descriptor !== undefined) closeSync(descriptor) }
    }
    try { unlinkSync(temporaryPath); changed = true } catch { fail('io', `cannot remove archive temporary file ${name}`) }
    if (temporary.nlink === 2n) { const final = inspectPrivateFile(join(directory.path, `${ARCHIVE_PREFIX}${match[1]!}${ARCHIVE_SUFFIX}`), 'recovered archive file', MAX_ARCHIVE_FILE_BYTES); closeSync(final.descriptor) }
  }
  if (changed) fsyncSync(directory.descriptor)
}
function beginArchiveControl(directory: SecureDirectory, sourceStateRootDigest: string): ArchiveControl {
  // All open/close based checks on the main control inode must happen before
  // BEGIN IMMEDIATE. POSIX process locks may be released by closing any fd for
  // that inode, even when SQLite owns a different descriptor.
  const file = ensureControlFile(directory)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(file.path)
    database.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;')
    database.exec('BEGIN IMMEDIATE;')
    const version = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
    if (version === 0) {
      const archiveInstanceId = randomUUID()
      database.exec('CREATE TABLE archive_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), archive_instance_id TEXT NOT NULL, source_state_root_digest TEXT NOT NULL) STRICT;')
      database.prepare('INSERT INTO archive_control(singleton, archive_instance_id, source_state_root_digest) VALUES (1, ?, ?)').run(archiveInstanceId, sourceStateRootDigest)
      database.exec('PRAGMA user_version=1; COMMIT; BEGIN IMMEDIATE;')
    } else if (version !== 1) fail('invalid-archive', 'unsupported archive control database')
    validateLockedControlPath(file)
    const row = database.prepare('SELECT archive_instance_id, source_state_root_digest FROM archive_control WHERE singleton=1').get() as { archive_instance_id?: unknown; source_state_root_digest?: unknown } | undefined
    if (typeof row?.archive_instance_id !== 'string' || !ARCHIVE_INSTANCE_ID.test(row.archive_instance_id) || row.source_state_root_digest !== sourceStateRootDigest) fail('conflict', 'archive is bound to another isolation state root')
    return { database, archiveInstanceId: row.archive_instance_id, sourceStateRootDigest, file }
  } catch (error) {
    try { database?.exec('ROLLBACK') } catch {}
    database?.close()
    if (error instanceof IsolationAuditArchiveError) throw error
    fail('io', 'cannot lock archive control database')
  }
}

function validateLedgerFile(state: SecureDirectory): { path: string; descriptor: number } {
  const path = join(state.path, 'ledger.sqlite')
  try {
    const inspected = inspectPrivateFile(path, 'isolation ledger')
    return { path, descriptor: inspected.descriptor }
  } catch (error) {
    if (error instanceof IsolationAuditArchiveError) fail('invalid-source', error.message)
    throw error
  }
}
function validateLedgerSnapshot(database: DatabaseSync): number {
  const userVersion = (database.prepare('PRAGMA user_version').get() as { user_version?: unknown }).user_version
  const schema = database.prepare("SELECT value FROM schema_meta WHERE key='schema-version'").get() as { value?: unknown } | undefined
  if (userVersion !== LEDGER_SCHEMA || schema?.value !== String(LEDGER_SCHEMA)) fail('invalid-source', 'isolation ledger schema 6 is required')
  const highWater = (database.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='isolation_audit'), 0) AS sequence").get() as { sequence?: unknown }).sequence
  if (!safeNatural(highWater)) fail('invalid-source', 'isolation audit high-water is invalid')
  const bounds = database.prepare('SELECT COUNT(*) AS count, COALESCE(MIN(sequence), 0) AS first_sequence, COALESCE(MAX(sequence), 0) AS last_sequence FROM isolation_audit').get() as { count?: unknown; first_sequence?: unknown; last_sequence?: unknown }
  if (!safeNatural(bounds.count) || bounds.count !== highWater || bounds.first_sequence !== (highWater === 0 ? 0 : 1) || bounds.last_sequence !== highWater) fail('invalid-source', 'isolation audit sequence history is incomplete')
  return highWater
}
function openLedgerSnapshot(state: SecureDirectory): { database: DatabaseSync; descriptor: number; highWater: number } {
  const ledger = validateLedgerFile(state)
  let database: DatabaseSync | undefined
  try {
    database = new DatabaseSync(ledger.path, { readOnly: true })
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000; BEGIN;')
    const linked = lstatSync(ledger.path, { bigint: true }); const opened = fstatSync(ledger.descriptor, { bigint: true })
    if (!sameInode(linked, opened)) fail('invalid-source', 'isolation ledger changed while being opened')
    return { database, descriptor: ledger.descriptor, highWater: validateLedgerSnapshot(database) }
  } catch (error) {
    try { database?.exec('ROLLBACK') } catch {}
    database?.close(); closeSync(ledger.descriptor)
    if (error instanceof IsolationAuditArchiveError) throw error
    return fail('invalid-source', error instanceof Error ? error.message : 'isolation ledger is unavailable')
  }
}
function preflightLedger(state: SecureDirectory): void {
  const snapshot = openLedgerSnapshot(state)
  try { snapshot.database.exec('COMMIT') } catch (error) { return fail('invalid-source', error instanceof Error ? error.message : 'isolation ledger preflight failed') }
  finally { snapshot.database.close(); closeSync(snapshot.descriptor) }
}
function rowRecord(row: AuditRow, expectedSequence: number): IsolationAuditArchiveRecord {
  if (!rowObject(row) || !exactKeys(row, ['sequence', 'occurred_at', 'action', 'job_id', 'grant_id', 'detail']) || row.sequence !== expectedSequence
    || !safePositive(row.sequence) || !safeNatural(row.occurred_at) || !boundedText(row.action) || !boundedDetail(row.detail) || !boundedText(row.job_id, true) || !boundedText(row.grant_id, true)) fail('invalid-source', 'isolation audit contains an invalid or discontinuous row')
  return freeze({ action: row.action, detail: row.detail, grantId: row.grant_id, jobId: row.job_id, occurredAt: row.occurred_at, sequence: row.sequence }) as IsolationAuditArchiveRecord
}
function recordsEqual(left: IsolationAuditArchiveRecord, right: IsolationAuditArchiveRecord): boolean { return canonical(left) === canonical(right) }
function makeManifest(archiveInstanceId: string, sourceStateRootDigest: string, firstSequence: number, lastSequence: number, count: number, snapshotThroughSequence: number, previousDigest: string | null): IsolationAuditArchiveManifest {
  return freeze({ archiveInstanceId, count, firstSequence, lastSequence, ledgerSchema: 6, previousDigest, protocol: ISOLATION_AUDIT_ARCHIVE_PROTOCOL, snapshotThroughSequence, sourceStateRootDigest, type: 'manifest', version: 1 })
}
function encodeFile(manifest: IsolationAuditArchiveManifest, records: readonly IsolationAuditArchiveRecord[]): Buffer {
  return Buffer.from(`${[canonical(manifest), ...records.map(record => canonical(record))].join('\n')}\n`, 'utf8')
}
function publish(directory: SecureDirectory, content: Buffer): { name: string; created: boolean; digest: string } {
  stillSameDirectory(directory)
  if (content.byteLength > MAX_ARCHIVE_FILE_BYTES) fail('invalid-source', 'one audit record exceeds the archive file bound')
  const contentDigest = digest(content); const name = `${ARCHIVE_PREFIX}${contentDigest}${ARCHIVE_SUFFIX}`; const target = join(directory.path, name)
  if (existsSync(target)) {
    if (!readPrivateFile(target, `archive file ${name}`, MAX_ARCHIVE_FILE_BYTES).equals(content)) fail('conflict', `conflicting archive target ${name}`)
    stillSameDirectory(directory)
    return { name, created: false, digest: contentDigest }
  }
  const temporaryName = `.${ARCHIVE_PREFIX}${contentDigest}.${process.pid}.${randomUUID()}.tmp`; const temporary = join(directory.path, temporaryName)
  let descriptor: number | undefined; let linked = false
  try {
    descriptor = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    fchmodSync(descriptor, 0o600)
    let offset = 0; while (offset < content.length) offset += writeSync(descriptor, content, offset, content.length - offset)
    fsyncSync(descriptor)
    const staged = fstatSync(descriptor, { bigint: true })
    const stagedPath = lstatSync(temporary, { bigint: true })
    if (!staged.isFile() || staged.uid !== BigInt(process.getuid?.() ?? -1) || (staged.mode & 0o7777n) !== 0o600n || staged.nlink !== 1n || staged.size !== BigInt(content.length) || !sameInode(staged, stagedPath)) fail('io', 'unsafe archive temporary file')
    closeSync(descriptor); descriptor = undefined
    try {
      linkSync(temporary, target); linked = true
      const source = lstatSync(temporary, { bigint: true }); const destination = lstatSync(target, { bigint: true })
      if (!sameInode(source, destination) || source.nlink !== 2n || destination.nlink !== 2n) fail('io', 'archive publication link is unsafe')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!readPrivateFile(target, `archive file ${name}`, MAX_ARCHIVE_FILE_BYTES).equals(content)) fail('conflict', `conflicting archive target ${name}`)
    }
    unlinkSync(temporary)
    fsyncSync(directory.descriptor)
    if (linked) { const final = inspectPrivateFile(target, `archive file ${name}`, MAX_ARCHIVE_FILE_BYTES); closeSync(final.descriptor) }
    stillSameDirectory(directory)
    return { name, created: linked, digest: contentDigest }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { if (existsSync(temporary)) unlinkSync(temporary) } catch {}
    if (error instanceof IsolationAuditArchiveError) throw error
    fail('io', `cannot publish audit archive file ${name}`)
  }
}
function validateOptions(options: { stateRoot: string; archiveDirectory: string; batchSize?: number }): { stateRoot: string; archiveDirectory: string; batchSize: number } {
  if (!plain(options) || !exactKeys(options, options.batchSize === undefined ? ['stateRoot', 'archiveDirectory'] : ['stateRoot', 'archiveDirectory', 'batchSize'])
    || typeof options.stateRoot !== 'string' || typeof options.archiveDirectory !== 'string') fail('invalid-input', 'invalid audit archive options')
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  if (!safePositive(batchSize) || batchSize > MAX_BATCH_SIZE) fail('invalid-input', 'audit archive batch size must be between 1 and 1000')
  return { stateRoot: options.stateRoot, archiveDirectory: options.archiveDirectory, batchSize }
}

/** Copy a fixed, read-only ledger snapshot into immutable, content-addressed archive batches. */
export function archiveIsolationAudit(options: { stateRoot: string; archiveDirectory: string; batchSize?: number }): IsolationAuditArchiveResult {
  const input = validateOptions(options)
  const state = secureDirectory(input.stateRoot, 'isolation state root')
  let archive: SecureDirectory | undefined; let control: DatabaseSync | undefined; let ledgerDescriptor: number | undefined; let database: DatabaseSync | undefined; let transaction = false
  try {
    archive = secureDirectory(input.archiveDirectory, 'isolation audit archive directory')
    if (!disjoint(state.path, archive.path) || (state.device === archive.device && state.inode === archive.inode)) fail('invalid-path', 'state root and archive directory must be disjoint')
    // Do not initialize or bind an archive when the requested source cannot
    // first prove that it is a complete schema-6 audit ledger. The locked
    // snapshot below repeats these checks authoritatively.
    preflightLedger(state)
    const controlLock = beginArchiveControl(archive, digest(state.path)); control = controlLock.database
    recoverTemporaryPublications(archive)
    const existing = verifyArchive(archive, controlLock, true, true, controlLock.file)
    const snapshot = openLedgerSnapshot(state); database = snapshot.database; ledgerDescriptor = snapshot.descriptor; transaction = true
    const highWater = snapshot.highWater
    if (existing.verification.highestSequence > highWater || existing.verification.snapshotThroughSequence > highWater) fail('conflict', 'archive does not match this isolation ledger')
    let archivedIndex = 0
    for (const file of existing.files) for (const record of file.records) {
      const row = database.prepare('SELECT sequence, occurred_at, action, job_id, grant_id, detail FROM isolation_audit WHERE sequence=?').get(record.sequence) as AuditRow | undefined
      if (!row || !recordsEqual(record, rowRecord(row, record.sequence))) fail('conflict', 'archived audit prefix differs from the isolation ledger')
      archivedIndex += 1
    }
    if (archivedIndex !== existing.verification.highestSequence) fail('invalid-archive', 'archive record count is inconsistent')
    const createdFiles: string[] = []; let createdRecords = 0; let afterSequence = existing.verification.highestSequence; let previousDigest = existing.verification.headDigest
    if (highWater === 0 && previousDigest === null) {
      const publication = publish(archive, encodeFile(makeManifest(controlLock.archiveInstanceId, controlLock.sourceStateRootDigest, 1, 0, 0, 0, null), []))
      if (publication.created) createdFiles.push(publication.name)
      previousDigest = publication.digest
    }
    while (afterSequence < highWater) {
      const rows = database.prepare('SELECT sequence, occurred_at, action, job_id, grant_id, detail FROM isolation_audit WHERE sequence>? AND sequence<=? ORDER BY sequence ASC LIMIT ?').all(afterSequence, highWater, input.batchSize) as AuditRow[]
      if (rows.length === 0) fail('invalid-source', 'isolation audit has a sequence gap')
      const decoded = rows.map((row, index) => rowRecord(row, afterSequence + index + 1))
      let cursor = 0
      while (cursor < decoded.length) {
        const records: IsolationAuditArchiveRecord[] = []
        while (cursor < decoded.length && records.length < input.batchSize) {
          const candidate = decoded[cursor]!
          const next = [...records, candidate]
          const provisional = makeManifest(controlLock.archiveInstanceId, controlLock.sourceStateRootDigest, next[0]!.sequence, next.at(-1)!.sequence, next.length, highWater, previousDigest)
          if (encodeFile(provisional, next).byteLength > MAX_ARCHIVE_FILE_BYTES) { if (records.length === 0) fail('invalid-source', 'one audit record exceeds the archive file bound'); break }
          records.push(candidate); cursor += 1
        }
        const manifest = makeManifest(controlLock.archiveInstanceId, controlLock.sourceStateRootDigest, records[0]!.sequence, records.at(-1)!.sequence, records.length, highWater, previousDigest)
        const publication = publish(archive, encodeFile(manifest, records))
        if (publication.created) { createdFiles.push(publication.name); createdRecords += records.length }
        previousDigest = publication.digest; afterSequence = records.at(-1)!.sequence
      }
    }
    const verification = verifyArchive(archive, controlLock, false, false, controlLock.file).verification
    if (verification.highestSequence !== highWater || verification.headDigest !== previousDigest || verification.archiveInstanceId === null || verification.sourceStateRootDigest === null) fail('invalid-archive', 'published archive failed final verification')
    stillSameDirectory(archive)
    database.exec('COMMIT'); transaction = false
    control.exec('COMMIT')
    stillSameDirectory(archive)
    return freeze({ createdFiles: freeze(createdFiles), createdRecords, verification: verification as IsolationAuditArchiveVerification })
  } catch (error) {
    if (transaction) try { database?.exec('ROLLBACK') } catch {}
    try { control?.exec('ROLLBACK') } catch {}
    if (error instanceof IsolationAuditArchiveError) throw error
    return fail('io', error instanceof Error ? error.message : 'audit archive failed')
  } finally {
    database?.close()
    if (ledgerDescriptor !== undefined) closeSync(ledgerDescriptor)
    control?.close()
    if (archive) closeDirectory(archive)
    closeDirectory(state)
  }
}
