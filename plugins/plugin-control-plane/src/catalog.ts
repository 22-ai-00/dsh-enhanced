import { spawnSync } from 'node:child_process'
import { closeSync, constants, fstatSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { openTrustedCatalogCommitInterpreter } from './catalog-interpreter.js'

export interface CatalogRegistryArtifact {
  /** Owner-authorized registry identity that produced this immutable object. */
  id: string
  /** Canonical absolute file URL for the local immutable registry root. */
  locator: string
  /** Canonical absolute file URL for this package/version tarball. */
  reference: string
}

export interface CatalogEntry extends CatalogPackage {
  id: string
  capabilities: string[]
  /** Additional top-level bundles that must be installed with this candidate. */
  requires: readonly CatalogPackage[]
  authorities: string[]
  dshBaseline: string
}

export interface CatalogPackage {
  package: string
  version: string
  integrity: string
  /** Optional for compatibility with historical registry package entries. */
  registry?: CatalogRegistryArtifact
}

export interface CapabilityCatalog { schemaVersion: 1; entries: CatalogEntry[] }
export interface LoadedCapabilityCatalog {
  catalog: CapabilityCatalog
  digest: string
  provenance: 'owner-provided-integrity-pinned'
}

export interface CatalogAdmissionInput {
  catalog: { id: string; path: string }
  registry: { id: string; locator: string }
  installationId: string
  operationId: string
  plan: { id: string; digest: string; revision: number }
  release: { id: string; fence: number }
  expectedBeforeCatalogDigest: string
  expectedAfterCatalogDigest: string
  registryReference: string
  artifactStatementDigest: string
  artifactSignature: string
  verificationEvidenceDigest: string
  candidate: unknown
}

export interface CatalogAdmissionEvidence {
  kind: 'catalog-admission'
  admissionId: string
  catalogId: string
  beforeCatalogDigest: string
  afterCatalogDigest: string
  registryReference: string
  artifactStatementDigest: string
  artifactSignatureDigest: string
  verificationEvidenceDigest: string
  candidate: CatalogEntry
}

export interface CatalogAdmissionResult {
  /** Exact receipt evidence. `replayed` is deliberately kept outside it. */
  evidence: CatalogAdmissionEvidence
  replayed: boolean
}

export interface CatalogAdmissionPreview {
  beforeCatalogDigest: string
  afterCatalogDigest: string
  catalog: CapabilityCatalog
  candidate: CatalogEntry
}

/** Fault-injection points for durability tests. Production callers omit this. */
export interface CatalogAdmissionDurabilityHooks {
  afterTemporaryFileSync?(temporaryPath: string): void | Promise<void>
  afterJournalSync?(journalPath: string): void | Promise<void>
  beforeAtomicRename?(catalogPath: string, temporaryPath: string): void | Promise<void>
  afterAtomicRename?(catalogPath: string): void | Promise<void>
}

interface CatalogAdmissionTransitionJournal {
  schemaVersion: 1
  transitionId: string
  bindingDigest: string
  evidence: CatalogAdmissionEvidence
}

interface CatalogAdmissionAttemptNames {
  desired: string
  stage: string
  before: string
  reverseMarker: string
}

interface CatalogAdmissionAttemptJournal {
  schemaVersion: 2
  transitionId: string
  bindingDigest: string
  evidence: CatalogAdmissionEvidence
  attemptId: string
  catalogPath: string
  attemptDirectoryName: string
  names: CatalogAdmissionAttemptNames
  parent: { dev: string; ino: string }
  expectedBefore: { dev: string; ino: string; fileDigest: string }
  desired: { dev: string; ino: string; fileDigest: string }
  rollback: { dev: string; ino: string; fileDigest: string }
}

type CatalogAdmissionJournal = CatalogAdmissionTransitionJournal

interface CatalogAdmissionTestHooks {
  /** Test-only delay inside the broker immediately after its first exchange. */
  afterExchangePauseMilliseconds?: number
  /** Test-only delay after reverse preconditions are verified. */
  beforeReverseExchangePauseMilliseconds?: number
}

export class CatalogAdmissionError extends Error {
  constructor(readonly code: 'conflict' | 'invalid-input' | 'unsafe-catalog', message: string) {
    super(`plugin-control-plane catalog-admission[${code}]: ${message}`)
    this.name = 'CatalogAdmissionError'
  }
}

const idPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const packagePattern = /^@[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/u
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const integrityPattern = /^sha512-[A-Za-z0-9+/=]+$/u
const digestPattern = /^[a-f0-9]{64}$/u
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const signaturePattern = /^[A-Za-z0-9+/]+={0,2}$/u
const maximumCatalogBytes = 1_048_576
const O_TMPFILE = 0o20200000
const catalogCommitInterpreterLauncher = '/usr/bin/python3'
/**
 * Linux reference commit broker. The fixed system launcher is resolved to a
 * canonical root-owned interpreter, which is opened O_NOFOLLOW, hashed before
 * and after use, and executed through its retained /proc fd with a minimal
 * fixed environment and no shell. The
 * desired and rollback files are O_TMPFILE descriptors; pathname hooks never
 * select the bytes exchanged into the catalog. renameat2(RENAME_EXCHANGE)
 * permits immediate verification and rollback if the target changed.
 *
 * Unix mode bits do not isolate mutually hostile processes sharing one uid. A
 * production deployment that treats a continuously racing same-uid process
 * as an adversary must place this broker and catalog parent under a separate
 * uid (or otherwise make the parent unwritable to workers). This local helper
 * closes deterministic pathname replacement seams and fails closed when the
 * required Linux fd/syscall facilities are unavailable.
 */
const catalogCommitHelper = String.raw`
import ctypes, hashlib, os, stat, sys, time
AT_FDCWD = -100
AT_SYMLINK_FOLLOW = 0x400
RENAME_EXCHANGE = 0x2
def die(message):
    raise RuntimeError(message)
def safe_name(value):
    if not value or value in (".", "..") or "/" in value or "\0" in value:
        die("invalid catalog commit name")
    return value.encode()
def same(left, right):
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)
def stable(left, right):
    return same(left, right) and (left.st_size, left.st_mtime_ns, left.st_ctime_ns) == (right.st_size, right.st_mtime_ns, right.st_ctime_ns)
def digest_fd(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    result = hashlib.sha256()
    while True:
        chunk = os.read(fd, 65536)
        if not chunk: break
        result.update(chunk)
    os.lseek(fd, 0, os.SEEK_SET)
    return result.hexdigest()
def ensure_link(libc, descriptor, directory_fd, name, metadata, digest):
    source = ("/proc/self/fd/%d" % descriptor).encode()
    if libc.linkat(AT_FDCWD, source, directory_fd, name, AT_SYMLINK_FOLLOW) != 0:
        if ctypes.get_errno() != 17:
            die("could not link catalog attempt descriptor: errno %d" % ctypes.get_errno())
        if not matches(snapshot_name(directory_fd, name), metadata, digest):
            die("catalog attempt name belongs to an unknown inode")
def signal_reverse_window(attempt_fd, marker):
    try:
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=attempt_fd)
    except FileExistsError:
        return
    try: os.fsync(fd)
    finally: os.close(fd)
    os.fsync(attempt_fd)
def snapshot_name(directory_fd, name):
    before = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=directory_fd)
    try:
        opened = os.fstat(fd)
        digest = digest_fd(fd)
    finally:
        os.close(fd)
    after = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    if not stable(before, opened) or not stable(opened, after):
        die("catalog pathname changed while it was verified")
    return (after, digest)
def matches(snapshot, metadata, digest):
    return same(snapshot[0], metadata) and snapshot[1] == digest
if sys.version_info < (3, 8):
    die("Python 3.8 or newer is required")
if sys.platform != "linux" or len(sys.argv) < 2:
    die("unsupported catalog commit platform")
desired_fd, catalog_fd, attempt_fd, before_fd, parent_fd = 3, 4, 5, 6, 8
desired = os.fstat(desired_fd)
catalog = os.fstat(catalog_fd)
before_copy = os.fstat(before_fd)
if not stat.S_ISREG(desired.st_mode) or not stat.S_ISREG(catalog.st_mode) or not stat.S_ISREG(before_copy.st_mode) \
        or not stat.S_ISDIR(os.fstat(attempt_fd).st_mode) or not stat.S_ISDIR(os.fstat(parent_fd).st_mode) \
        or not os.path.isdir("/proc/self/fd"):
    die("descriptor filesystem is unavailable")
libc = ctypes.CDLL(None, use_errno=True)
mode = sys.argv[1]
if mode == "prepare":
    if len(sys.argv) != 8: die("invalid prepare request")
    desired_digest, expected_digest = sys.argv[2], sys.argv[3]
    expected_dev, expected_ino = int(sys.argv[4]), int(sys.argv[5])
    desired_name, before_name = safe_name(sys.argv[6]), safe_name(sys.argv[7])
    if digest_fd(desired_fd) != desired_digest: die("desired catalog digest changed")
    if (catalog.st_dev, catalog.st_ino) != (expected_dev, expected_ino) or digest_fd(catalog_fd) != expected_digest:
        die("catalog descriptor identity changed")
    if (before_copy.st_mode & 0o777) != 0o600 or digest_fd(before_fd) != expected_digest:
        die("catalog rollback descriptor is invalid")
    ensure_link(libc, desired_fd, attempt_fd, desired_name, desired, desired_digest)
    ensure_link(libc, before_fd, attempt_fd, before_name, before_copy, expected_digest)
    os.fsync(attempt_fd)
    print("{}")
elif mode == "commit":
    if len(sys.argv) != 12: die("invalid commit request")
    expected_dev, expected_ino = int(sys.argv[2]), int(sys.argv[3])
    expected_digest, desired_digest = sys.argv[4], sys.argv[5]
    desired_name, before_name, target, reverse_marker = (safe_name(value) for value in sys.argv[6:10])
    stage_name = safe_name("stage")
    try: pause_ms, reverse_pause_ms = int(sys.argv[10]), int(sys.argv[11])
    except ValueError: die("invalid exchange pause")
    if pause_ms < 0 or pause_ms > 1000 or reverse_pause_ms < 0 or reverse_pause_ms > 1000:
        die("invalid exchange pause")
    renameat2 = getattr(libc, "renameat2", None)
    if renameat2 is None: die("renameat2 is unavailable")
    if (catalog.st_dev, catalog.st_ino) != (expected_dev, expected_ino) or digest_fd(catalog_fd) != expected_digest:
        die("catalog descriptor identity changed")
    if digest_fd(desired_fd) != desired_digest: die("desired catalog digest changed")
    if (before_copy.st_mode & 0o777) != 0o600 or digest_fd(before_fd) != expected_digest:
        die("catalog rollback descriptor is invalid")
    desired_snapshot = snapshot_name(attempt_fd, desired_name)
    before_snapshot = snapshot_name(attempt_fd, before_name)
    if not matches(desired_snapshot, desired, desired_digest): die("catalog desired attempt changed before exchange")
    if not matches(before_snapshot, before_copy, expected_digest): die("catalog before-state recovery changed before exchange")
    if renameat2(attempt_fd, desired_name, parent_fd, target, RENAME_EXCHANGE) != 0:
        die("catalog exchange failed: errno %d" % ctypes.get_errno())
    # Rename the displaced inode away from the reusable desired name. This
    # preserves the exact desired inode at a stable name for retries while the
    # stage name carries whatever was atomically displaced from canonical.
    os.rename(desired_name, stage_name, src_dir_fd=attempt_fd, dst_dir_fd=attempt_fd)
    if pause_ms: time.sleep(pause_ms / 1000.0)
    current = snapshot_name(parent_fd, target)
    displaced = snapshot_name(attempt_fd, stage_name)
    if matches(current, desired, desired_digest) and matches(displaced, catalog, expected_digest):
        os.fsync(parent_fd); os.fsync(attempt_fd); print("{}")
    elif not matches(displaced, catalog, expected_digest):
        target_now = snapshot_name(parent_fd, target); attempt_now = snapshot_name(attempt_fd, stage_name)
        if not matches(target_now, desired, desired_digest) or not matches(attempt_now, displaced[0], displaced[1]):
            die("catalog changed after exchange; journal-named attempt files were preserved")
        if reverse_pause_ms:
            signal_reverse_window(attempt_fd, reverse_marker); time.sleep(reverse_pause_ms / 1000.0)
        if renameat2(attempt_fd, stage_name, parent_fd, target, RENAME_EXCHANGE) != 0:
            die("catalog reverse exchange failed; journal-named attempt files were preserved")
        restored = snapshot_name(parent_fd, target); reverse_displaced = snapshot_name(attempt_fd, stage_name)
        os.fsync(parent_fd); os.fsync(attempt_fd)
        if matches(restored, displaced[0], displaced[1]) and matches(reverse_displaced, desired, desired_digest):
            die("competing catalog was restored by exact reverse exchange")
        die("catalog changed during reverse exchange; journal-named attempt files were preserved")
    else:
        die("catalog target changed after exchange and was left untouched; journal-named attempt files were preserved")
else:
    die("unsupported catalog commit mode")
`

function openCatalogCommitInterpreter(): number {
  if (process.platform !== 'linux') {
    throw new CatalogAdmissionError('unsafe-catalog', 'descriptor-backed catalog commits require Linux procfs')
  }
  try {
    realpathSync('/proc/self/fd')
    return openTrustedCatalogCommitInterpreter(catalogCommitInterpreterLauncher).descriptor
  } catch (error) {
    if (error instanceof CatalogAdmissionError) throw error
    const detail = error instanceof Error ? `: ${error.message}` : ''
    throw new CatalogAdmissionError('unsafe-catalog', `catalog commit interpreter is unavailable or unsafe${detail}`)
  }
}

function descriptorSnapshot(descriptor: number): { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; sha256: string } {
  const metadata = fstatSync(descriptor, { bigint: true })
  if (!metadata.isFile() || metadata.size < 1n || metadata.size > 32n * 1_024n * 1_024n) {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog commit interpreter has an invalid executable image')
  }
  const bytes = Buffer.alloc(Number(metadata.size)); let offset = 0
  while (offset < bytes.length) {
    const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (count === 0) throw new CatalogAdmissionError('unsafe-catalog', 'catalog commit interpreter ended early')
    offset += count
  }
  return { dev: metadata.dev, ino: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
    sha256: createHash('sha256').update(bytes).digest('hex') }
}

function runCatalogCommitHelper(mode: 'prepare' | 'commit', desired: FileHandle, catalog: FileHandle, attemptDirectory: FileHandle,
  beforeCopy: FileHandle, parentDirectory: FileHandle, arguments_: readonly string[]): void {
  const interpreter = openCatalogCommitInterpreter()
  try {
    const before = descriptorSnapshot(interpreter)
    const result = spawnSync('/proc/self/fd/7', ['-I', '-S', '-E', '-c', catalogCommitHelper, mode, ...arguments_], {
      env: { LANG: 'C', LC_ALL: 'C' }, shell: false, encoding: 'utf8', maxBuffer: 16_384,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe', desired.fd, catalog.fd, attemptDirectory.fd, beforeCopy.fd, interpreter, parentDirectory.fd],
    })
    const after = descriptorSnapshot(interpreter)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.sha256 !== after.sha256) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog commit interpreter changed during execution')
    }
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
      const detail = result.stderr.trim().split('\n').at(-1)?.slice(0, 1_000)
      throw new CatalogAdmissionError('conflict', `descriptor-backed catalog ${mode} failed${detail === undefined || detail === '' ? '' : `: ${detail}`}`)
    }
    let output: unknown
    try { output = JSON.parse(result.stdout) as unknown } catch {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog commit helper returned invalid output')
    }
    if (typeof output !== 'object' || output === null || Array.isArray(output)
      || Object.keys(output).length !== 0) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog commit helper returned an invalid result')
    }
  } finally { closeSync(interpreter) }
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.normalize('NFC').trim() === '') throw new Error(`plugin-control-plane: ${label} must be a non-empty string`)
  return value.normalize('NFC').trim()
}

function textList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw new Error(`plugin-control-plane: ${label} must be a non-empty string array`)
  }
  return [...new Set(value.map(item => item.normalize('NFC').trim()))].sort()
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  if (Object.keys(value).sort().join('\0') !== [...fields].sort().join('\0')) {
    throw new Error(`plugin-control-plane: ${label} has unknown or missing fields`)
  }
}

function canonicalFileUrl(value: unknown, label: string): { url: string; path: string } {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_000
    || value !== value.normalize('NFC').trim() || value.includes('\0') || value.includes('\r') || value.includes('\n')) {
    throw new Error(`plugin-control-plane: ${label} must be a canonical absolute file URL`)
  }
  let url: URL
  let path: string
  try {
    url = new URL(value)
    path = fileURLToPath(url)
  } catch {
    throw new Error(`plugin-control-plane: ${label} must be a canonical absolute file URL`)
  }
  if (url.protocol !== 'file:' || url.username !== '' || url.password !== '' || url.host !== ''
    || url.search !== '' || url.hash !== '' || !isAbsolute(path) || path === '/' || resolve(path) !== path
    || pathToFileURL(path).href !== value) {
    throw new Error(`plugin-control-plane: ${label} must be a canonical absolute file URL`)
  }
  return { url: value, path }
}

function catalogRegistry(value: unknown, packageName: string, version: string, label: string): CatalogRegistryArtifact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin-control-plane: ${label}.registry must be an object`)
  }
  const item = value as Record<string, unknown>
  exactFields(item, ['id', 'locator', 'reference'], `${label}.registry`)
  const id = text(item.id, `${label}.registry.id`)
  if (!identityPattern.test(id)) throw new Error(`plugin-control-plane: ${label}.registry.id is invalid`)
  if (typeof item.locator !== 'string') throw new Error(`plugin-control-plane: ${label}.registry.locator is invalid`)
  let protocol: string
  try { protocol = new URL(item.locator).protocol } catch { throw new Error(`plugin-control-plane: ${label}.registry.locator is invalid`) }
  if (protocol === 'file:') {
    const locator = canonicalFileUrl(item.locator, `${label}.registry.locator`)
    const reference = canonicalFileUrl(item.reference, `${label}.registry.reference`)
    const suffix = relative(locator.path, reference.path)
    if (suffix === '' || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)
      || reference.path !== join(locator.path, 'packages', encodeURIComponent(packageName), version, 'package.tgz')) {
      throw new Error(`plugin-control-plane: ${label}.registry.reference must be the package's immutable object under its registry locator`)
    }
    return Object.freeze({ id, locator: locator.url, reference: reference.url })
  }
  let locator: URL
  try { locator = new URL(item.locator) } catch { throw new Error(`plugin-control-plane: ${label}.registry.locator is invalid`) }
  if (locator.protocol !== 'https:' || locator.username !== '' || locator.password !== '' || locator.search !== '' || locator.hash !== ''
    || (locator.href !== item.locator && locator.href !== `${item.locator}/`) || item.reference !== `${packageName}@${version}`) {
    throw new Error(`plugin-control-plane: ${label}.registry must use a bounded HTTPS registry package reference`)
  }
  return Object.freeze({ id, locator: item.locator, reference: item.reference })
}

function catalogPackage(value: unknown, label: string): CatalogPackage {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`plugin-control-plane: ${label} must be an object`)
  }
  const item = value as Partial<CatalogPackage>
  const packageName = text(item.package, `${label}.package`)
  const version = text(item.version, `${label}.version`)
  const integrity = text(item.integrity, `${label}.integrity`)
  if (!packagePattern.test(packageName) || !versionPattern.test(version) || !integrityPattern.test(integrity)) {
    throw new Error(`plugin-control-plane: ${label} must pin package, exact version, and sha512 integrity`)
  }
  const registry = item.registry === undefined ? undefined : catalogRegistry(item.registry, packageName, version, label)
  return Object.freeze({ package: packageName, version, integrity, ...(registry === undefined ? {} : { registry }) })
}

function catalogRequirements(value: unknown, primary: CatalogPackage, label: string): readonly CatalogPackage[] {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new Error(`plugin-control-plane: ${label}.requires must be an array`)
  const seen = new Set<string>([primary.package])
  const entries = value.map((raw, index) => {
    const requirement = catalogPackage(raw, `${label}.requires[${index}]`)
    if (seen.has(requirement.package)) throw new Error(`plugin-control-plane: ${label}.requires contains duplicate package ${requirement.package}`)
    seen.add(requirement.package)
    return requirement
  })
  return Object.freeze(entries.sort((left, right) => left.package.localeCompare(right.package)))
}

export function parseCatalog(value: unknown): CapabilityCatalog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('plugin-control-plane: catalog must be an object')
  const input = value as Partial<CapabilityCatalog>
  if (input.schemaVersion !== 1 || !Array.isArray(input.entries)) throw new Error('plugin-control-plane: unsupported catalog schema')
  const seen = new Set<string>()
  const entries = input.entries.map(raw => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('plugin-control-plane: catalog entry must be an object')
    const item = raw as Partial<CatalogEntry>
    const id = text(item.id, 'entry id')
    const primary = catalogPackage(item, id)
    const baseline = text(item.dshBaseline, `${id}.dshBaseline`)
    if (!idPattern.test(id) || seen.has(id)) throw new Error(`plugin-control-plane: invalid or duplicate entry id ${id}`)
    if (!versionPattern.test(baseline)) throw new Error(`plugin-control-plane: entry ${id}.dshBaseline must be an exact DSH version`)
    seen.add(id)
    return Object.freeze({ id, ...primary, requires: catalogRequirements(item.requires, primary, id), dshBaseline: baseline,
      capabilities: textList(item.capabilities, `${id}.capabilities`), authorities: textList(item.authorities, `${id}.authorities`) })
  })
  return Object.freeze({ schemaVersion: 1, entries: Object.freeze(entries) as CatalogEntry[] })
}

function catalogDigest(catalog: CapabilityCatalog): string {
  return createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function admissionText(value: unknown, label: string, pattern: RegExp, maximum = 2_000): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum || !pattern.test(value)) {
    throw new CatalogAdmissionError('invalid-input', `${label} is invalid`)
  }
  return value
}

function admissionInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new CatalogAdmissionError('invalid-input', `${label} must be a positive safe integer`)
  return Number(value)
}

function exactCandidate(value: unknown): CatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CatalogAdmissionError('invalid-input', 'candidate must be an object')
  const item = value as Record<string, unknown>
  const fields = ['authorities', 'capabilities', 'dshBaseline', 'id', 'integrity', 'package',
    ...(item.registry === undefined ? [] : ['registry']), 'requires', 'version'].sort()
  if (Object.keys(item).sort().join('\0') !== fields.join('\0')) {
    throw new CatalogAdmissionError('invalid-input', 'candidate has unknown or missing fields')
  }
  try {
    return parseCatalog({ schemaVersion: 1, entries: [value] }).entries[0]!
  } catch (error) {
    throw new CatalogAdmissionError('invalid-input', error instanceof Error ? error.message : 'candidate is invalid')
  }
}

export function assertCatalogIdentity(catalog: CapabilityCatalog): void {
  const packages = new Set<string>()
  for (const entry of catalog.entries) {
    if (packages.has(entry.package)) {
      throw new CatalogAdmissionError('conflict', `catalog contains duplicate package identity ${entry.package}`)
    }
    packages.add(entry.package)
    exactSha512(entry.integrity, `${entry.id}.integrity`)
    for (const requirement of entry.requires) exactSha512(requirement.integrity, `${entry.id}.requires integrity`)
  }
}

function exactSha512(value: string, label: string): void {
  const encoded = value.slice('sha512-'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== encoded) {
    throw new CatalogAdmissionError('invalid-input', `${label} must be a canonical 64-byte sha512 integrity`)
  }
}

async function canonicalOwnerCatalogPath(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || path === '/' || resolve(path) !== path) {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog path must be absolute and normalized')
  }
  let actual: string
  try { actual = await realpath(path) } catch {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog path must identify an existing canonical owner file')
  }
  if (actual !== path) throw new CatalogAdmissionError('unsafe-catalog', 'catalog path must not traverse symbolic links')
  return path
}

async function openOwnerCatalogDirectory(path: string): Promise<FileHandle> {
  let actual: string
  try { actual = await realpath(path) } catch {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog directory must exist')
  }
  if (actual !== path) throw new CatalogAdmissionError('unsafe-catalog', 'catalog directory must not traverse symbolic links')
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat(); const uid = process.getuid?.()
    if (!metadata.isDirectory() || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid)) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog directory must be owner-controlled and not group/world writable')
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function acquireKernelAdmissionLock(handle: FileHandle): void {
  const interpreter = openCatalogCommitInterpreter()
  try {
    const before = descriptorSnapshot(interpreter)
    const result = spawnSync('/proc/self/fd/4', ['-I', '-S', '-E', '-c',
      'import fcntl; fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)'], {
      env: { LANG: 'C', LC_ALL: 'C' }, shell: false, encoding: 'utf8', timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe', handle.fd, interpreter],
    })
    const after = descriptorSnapshot(interpreter)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.sha256 !== after.sha256) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog lock interpreter changed during execution')
    }
    if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
      throw new CatalogAdmissionError('conflict', 'another live catalog admission owns the kernel lock')
    }
  } finally { closeSync(interpreter) }
}

async function openAdmissionJournalDirectory(catalogPath: string, parent: FileHandle): Promise<{ path: string; handle: FileHandle }> {
  const path = join(dirname(catalogPath), `.${basename(catalogPath)}.admissions`)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await parent.sync()
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat(); const uid = process.getuid?.()
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 || (uid !== undefined && metadata.uid !== uid)
      || await realpath(path) !== path) throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal directory is unsafe')
    return { path, handle }
  } catch (error) { await handle.close(); throw error }
}

async function openAttemptDirectory(journalDirectory: { path: string; handle: FileHandle }, name: string): Promise<{ path: string; handle: FileHandle }> {
  const path = join(journalDirectory.path, name)
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await journalDirectory.handle.sync()
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const metadata = await handle.stat(); const uid = process.getuid?.()
    if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700 || (uid !== undefined && metadata.uid !== uid)
      || await realpath(path) !== path) throw new CatalogAdmissionError('unsafe-catalog', 'catalog attempt directory is unsafe')
    return { path, handle }
  } catch (error) { await handle.close(); throw error }
}

function journalRecord(input: CatalogAdmissionInput, catalogPath: string, candidate: CatalogEntry,
  evidence: CatalogAdmissionEvidence): CatalogAdmissionJournal {
  const binding = admissionBinding(input, catalogPath, candidate)
  return Object.freeze({ schemaVersion: 1, transitionId: binding.transitionId, bindingDigest: binding.bindingDigest, evidence })
}

function attemptId(bindingDigest: string): string {
  return createHash('sha256').update(`dsh-catalog-attempt-v2\0${bindingDigest}`).digest('hex')
}

function attemptDirectoryName(catalogPath: string, id: string): string {
  return `.${basename(catalogPath)}.admission-${id}`
}

function attemptJournalRecord(input: CatalogAdmissionInput, catalogPath: string, candidate: CatalogEntry,
  evidence: CatalogAdmissionEvidence, before: { dev: bigint; ino: bigint; fileDigest: string },
  desired: { dev: bigint; ino: bigint; fileDigest: string }, rollback: { dev: bigint; ino: bigint; fileDigest: string },
  parent: { dev: bigint; ino: bigint }): CatalogAdmissionAttemptJournal {
  const binding = admissionBinding(input, catalogPath, candidate)
  const id = attemptId(binding.bindingDigest)
  return Object.freeze({
    schemaVersion: 2, transitionId: binding.transitionId, bindingDigest: binding.bindingDigest, evidence, attemptId: id, catalogPath,
    attemptDirectoryName: attemptDirectoryName(catalogPath, id),
    names: { desired: 'desired', stage: 'stage', before: 'before', reverseMarker: 'reverse-ready' },
    parent: { dev: String(parent.dev), ino: String(parent.ino) },
    expectedBefore: { dev: String(before.dev), ino: String(before.ino), fileDigest: before.fileDigest },
    desired: { dev: String(desired.dev), ino: String(desired.ino), fileDigest: desired.fileDigest },
    rollback: { dev: String(rollback.dev), ino: String(rollback.ino), fileDigest: rollback.fileDigest },
  })
}

async function readAdmissionJournal(path: string): Promise<CatalogAdmissionJournal | CatalogAdmissionAttemptJournal | undefined> {
  let handle: FileHandle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    const metadata = await handle.stat(); const uid = process.getuid?.()
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600
      || (uid !== undefined && metadata.uid !== uid) || metadata.size < 1 || metadata.size > maximumCatalogBytes) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal is unsafe')
    }
    let value: unknown
    try { value = JSON.parse(await handle.readFile({ encoding: 'utf8' })) as unknown } catch {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal is corrupt')
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal is corrupt')
    const item = value as Record<string, unknown>
    const common = typeof item.transitionId === 'string' && digestPattern.test(item.transitionId)
      && typeof item.bindingDigest === 'string' && digestPattern.test(item.bindingDigest)
      && typeof item.evidence === 'object' && item.evidence !== null
    const v1 = item.schemaVersion === 1
      && Object.keys(item).sort().join('\0') === ['bindingDigest', 'evidence', 'schemaVersion', 'transitionId'].join('\0')
    const names = item.names as Partial<CatalogAdmissionAttemptNames> | undefined
    const safeAttemptName = (name: unknown): name is string => typeof name === 'string' && /^[a-z][a-z-]{0,31}$/u.test(name)
    const identity = (entry: unknown): boolean => typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      && Object.keys(entry).sort().join('\0') === ['dev', 'fileDigest', 'ino'].join('\0')
      && typeof (entry as Record<string, unknown>).dev === 'string' && /^\d+$/u.test(String((entry as Record<string, unknown>).dev))
      && typeof (entry as Record<string, unknown>).ino === 'string' && /^\d+$/u.test(String((entry as Record<string, unknown>).ino))
      && typeof (entry as Record<string, unknown>).fileDigest === 'string' && digestPattern.test(String((entry as Record<string, unknown>).fileDigest))
    const v2 = item.schemaVersion === 2
      && Object.keys(item).sort().join('\0') === ['attemptDirectoryName', 'attemptId', 'bindingDigest', 'catalogPath', 'desired', 'evidence', 'expectedBefore', 'names', 'parent', 'rollback', 'schemaVersion', 'transitionId'].join('\0')
      && typeof item.attemptId === 'string' && digestPattern.test(item.attemptId)
      && typeof item.catalogPath === 'string' && isAbsolute(item.catalogPath) && resolve(item.catalogPath) === item.catalogPath
      && typeof item.attemptDirectoryName === 'string' && item.attemptDirectoryName === attemptDirectoryName(item.catalogPath, item.attemptId)
      && names !== undefined && Object.keys(names).sort().join('\0') === ['before', 'desired', 'reverseMarker', 'stage'].join('\0')
      && safeAttemptName(names.desired) && safeAttemptName(names.stage) && safeAttemptName(names.before) && safeAttemptName(names.reverseMarker)
      && identity(item.expectedBefore) && identity(item.desired) && identity(item.rollback)
      && typeof item.parent === 'object' && item.parent !== null && !Array.isArray(item.parent)
      && Object.keys(item.parent).sort().join('\0') === ['dev', 'ino'].join('\0')
      && typeof (item.parent as Record<string, unknown>).dev === 'string' && /^\d+$/u.test(String((item.parent as Record<string, unknown>).dev))
      && typeof (item.parent as Record<string, unknown>).ino === 'string' && /^\d+$/u.test(String((item.parent as Record<string, unknown>).ino))
    if (v2) {
      if (item.attemptId !== attemptId(String(item.bindingDigest))) {
        throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission attempt journal identity is corrupt')
      }
    }
    if (!common || (!v1 && !v2)) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal is corrupt')
    }
    return item as unknown as CatalogAdmissionJournal | CatalogAdmissionAttemptJournal
  } finally { await handle.close() }
}

async function persistAdmissionJournal(directory: { path: string; handle: FileHandle }, record: CatalogAdmissionJournal | CatalogAdmissionAttemptJournal,
  hooks: CatalogAdmissionDurabilityHooks): Promise<string> {
  const path = join(directory.path, record.schemaVersion === 1
    ? `${record.transitionId}.json`
    : `${record.transitionId}.attempt-${record.attemptId}.json`)
  const existing = await readAdmissionJournal(path)
  if (existing !== undefined) {
    if (canonical(existing) !== canonical(record)) throw new CatalogAdmissionError('conflict', 'catalog transition is already bound to a different admission operation')
    return path
  }
  let handle: FileHandle | undefined
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8')
    await handle.sync()
    const metadata = await handle.stat(); const uid = process.getuid?.()
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o777) !== 0o600 || (uid !== undefined && metadata.uid !== uid)) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal is unsafe')
    }
    const pathMetadata = await lstat(path)
    if (pathMetadata.dev !== metadata.dev || pathMetadata.ino !== metadata.ino || pathMetadata.isSymbolicLink()) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission journal path changed during creation')
    }
    await directory.handle.sync()
    await hooks.afterJournalSync?.(path)
    return path
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = await readAdmissionJournal(path)
      if (raced !== undefined && canonical(raced) === canonical(record)) return path
      throw new CatalogAdmissionError('conflict', 'catalog transition journal lost its create-only race')
    }
    throw error
  } finally { await handle?.close() }
}

async function admissionAttemptJournal(directory: { path: string }, transitionId: string): Promise<CatalogAdmissionAttemptJournal | undefined> {
  const matches = (await readdir(directory.path, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith(`${transitionId}.attempt-`) && entry.name.endsWith('.json'))
  if (matches.length > 1) throw new CatalogAdmissionError('conflict', 'catalog transition has multiple durable attempts')
  if (matches.length === 0) return undefined
  const journal = await readAdmissionJournal(join(directory.path, matches[0]!.name))
  if (journal?.schemaVersion !== 2 || journal.transitionId !== transitionId) {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog admission attempt journal is corrupt')
  }
  return journal
}

async function validateAttemptArtifacts(directory: { path: string }, journal: CatalogAdmissionAttemptJournal, state: 'before' | 'after'): Promise<void> {
  const parent = await lstat(dirname(journal.catalogPath), { bigint: true })
  if (!parent.isDirectory() || String(parent.dev) !== journal.parent.dev || String(parent.ino) !== journal.parent.ino) {
    throw new CatalogAdmissionError('conflict', 'catalog attempt parent does not match its durable identity')
  }
  const attemptPath = join(directory.path, journal.attemptDirectoryName)
  const metadata = await lstat(attemptPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new CatalogAdmissionError('conflict', 'catalog attempt artifacts do not match the durable journal')
  }
  const names = await readdir(attemptPath)
  if (names.some(name => !Object.values(journal.names).includes(name))) {
    throw new CatalogAdmissionError('conflict', 'catalog attempt contains an untracked recovery artifact')
  }
  if (!names.includes(journal.names.before)) {
    throw new CatalogAdmissionError('conflict', 'catalog attempt is missing its durable before-state recovery')
  }
  const hasDesired = names.includes(journal.names.desired); const hasStage = names.includes(journal.names.stage)
  if (state === 'before' && (!hasDesired || hasStage)) {
    throw new CatalogAdmissionError('conflict', 'catalog before-state attempt has an invalid state carrier')
  }
  if (state === 'after' && hasDesired === hasStage) {
    throw new CatalogAdmissionError('conflict', 'catalog after-state attempt must have exactly one state carrier')
  }
  const carrier = state === 'before' ? journal.names.desired : hasStage ? journal.names.stage : journal.names.desired
  if (!names.includes(carrier)) throw new CatalogAdmissionError('conflict', 'catalog attempt is missing its durable state carrier')
  const expected: Record<string, { dev: string; ino: string; fileDigest: string }> = {
    [journal.names.before]: journal.rollback,
    [carrier]: state === 'before' ? journal.desired : journal.expectedBefore,
  }
  for (const [name, identity] of Object.entries(expected)) {
    const handle = await open(join(attemptPath, name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const file = await handle.stat({ bigint: true }); const bytes = await handle.readFile()
      if (!file.isFile() || String(file.dev) !== identity.dev || String(file.ino) !== identity.ino
        || createHash('sha256').update(bytes).digest('hex') !== identity.fileDigest) {
        throw new CatalogAdmissionError('conflict', `catalog attempt ${name} does not match its durable inode and digest`)
      }
    } finally { await handle.close() }
  }
}

async function openOwnerCatalog(path: string): Promise<FileHandle> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    throw new CatalogAdmissionError('unsafe-catalog', 'catalog must be an owner-owned regular file without symbolic links')
  }
  try {
    const metadata = await handle.stat(); const uid = process.getuid?.()
    const pathMetadata = await lstat(path)
    if (!metadata.isFile() || pathMetadata.isSymbolicLink() || metadata.nlink !== 1
      || metadata.dev !== pathMetadata.dev || metadata.ino !== pathMetadata.ino
      || (metadata.mode & 0o777) !== 0o600 || (uid !== undefined && metadata.uid !== uid)) {
      throw new CatalogAdmissionError('unsafe-catalog', 'catalog must be owner-owned mode 0600 with one canonical link')
    }
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function loadOwnerCatalogSnapshot(path: string): Promise<{ catalog: CapabilityCatalog; digest: string; fileDigest: string; dev: bigint; ino: bigint }> {
  const handle = await openOwnerCatalog(path)
  try {
    const metadata = await handle.stat({ bigint: true })
    if (metadata.size > BigInt(maximumCatalogBytes)) throw new CatalogAdmissionError('invalid-input', 'catalog exceeds 1 MiB')
    const source = await handle.readFile({ encoding: 'utf8' })
    if (Buffer.byteLength(source) > maximumCatalogBytes) throw new CatalogAdmissionError('invalid-input', 'catalog exceeds 1 MiB')
    let catalog: CapabilityCatalog
    try { catalog = parseCatalog(JSON.parse(source) as unknown) } catch (error) {
      throw new CatalogAdmissionError('invalid-input', error instanceof Error ? error.message : 'catalog is invalid')
    }
    assertCatalogIdentity(catalog)
    return { catalog, digest: catalogDigest(catalog), fileDigest: createHash('sha256').update(source).digest('hex'),
      dev: metadata.dev, ino: metadata.ino }
  } finally { await handle.close() }
}

function compareVersions(left: string, right: string): number {
  const parsed = (value: string): { core: bigint[]; prerelease: string[] | undefined } => {
    const [withoutBuild = ''] = value.split('+', 1); const [core = '', prerelease] = withoutBuild.split('-', 2)
    return { core: core.split('.').map(part => BigInt(part)), prerelease: prerelease?.split('.') }
  }
  const a = parsed(left); const b = parsed(right)
  for (let index = 0; index < 3; index += 1) {
    const leftPart = a.core[index]!; const rightPart = b.core[index]!
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1
  }
  if (a.prerelease === undefined || b.prerelease === undefined) return a.prerelease === b.prerelease ? 0 : a.prerelease === undefined ? 1 : -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]; const rightPart = b.prerelease[index]
    if (leftPart === undefined || rightPart === undefined) return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1
    if (leftPart === rightPart) continue
    const leftNumeric = /^\d+$/u.test(leftPart); const rightNumeric = /^\d+$/u.test(rightPart)
    if (leftNumeric && rightNumeric) return BigInt(leftPart) < BigInt(rightPart) ? -1 : 1
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return leftPart < rightPart ? -1 : 1
  }
  return 0
}

function exactEntry(left: CatalogEntry, right: CatalogEntry): boolean { return canonical(left) === canonical(right) }

function candidateCatalog(before: CapabilityCatalog, candidate: CatalogEntry): CapabilityCatalog {
  const sameId = before.entries.find(entry => entry.id === candidate.id)
  const samePackage = before.entries.find(entry => entry.package === candidate.package)
  if (sameId !== undefined || samePackage !== undefined) {
    if (sameId !== undefined && samePackage !== undefined && sameId === samePackage && exactEntry(sameId, candidate)) return before
    if (sameId === undefined || samePackage === undefined || sameId !== samePackage) {
      throw new CatalogAdmissionError('conflict', `candidate ${candidate.id}/${candidate.package} conflicts with an existing catalog identity`)
    }
    const comparison = compareVersions(candidate.version, sameId.version)
    if (comparison < 0) throw new CatalogAdmissionError('conflict', `candidate ${candidate.id} would downgrade ${candidate.package} from ${sameId.version} to ${candidate.version}`)
    if (comparison === 0) throw new CatalogAdmissionError('conflict', `candidate ${candidate.id}/${candidate.package}@${candidate.version} conflicts with the existing version`)
    return parseCatalog({ schemaVersion: 1, entries: before.entries.map(entry => entry === sameId ? candidate : entry) })
  }
  return parseCatalog({ schemaVersion: 1, entries: [...before.entries, candidate] })
}

/** Pure deterministic transition used while constructing the signed request. */
export function previewCatalogAdmission(current: unknown, rawCandidate: unknown): CatalogAdmissionPreview {
  let catalog: CapabilityCatalog
  try { catalog = parseCatalog(current) } catch (error) {
    throw new CatalogAdmissionError('invalid-input', error instanceof Error ? error.message : 'catalog is invalid')
  }
  assertCatalogIdentity(catalog)
  const candidate = exactCandidate(rawCandidate)
  exactSha512(candidate.integrity, `${candidate.id}.integrity`)
  for (const requirement of candidate.requires) exactSha512(requirement.integrity, `${candidate.id}.requires integrity`)
  const after = candidateCatalog(catalog, candidate)
  return Object.freeze({ beforeCatalogDigest: catalogDigest(catalog), afterCatalogDigest: catalogDigest(after), catalog: after, candidate })
}

function admissionBinding(input: CatalogAdmissionInput, catalogPath: string, candidate: CatalogEntry): {
  transitionId: string; bindingDigest: string; artifactSignatureDigest: string
} {
  const catalogId = admissionText(input.catalog.id, 'catalog.id', identityPattern)
  const installationId = admissionText(input.installationId, 'installationId', identityPattern)
  const operationId = admissionText(input.operationId, 'operationId', identityPattern)
  const planId = admissionText(input.plan.id, 'plan.id', identityPattern)
  const planDigest = admissionText(input.plan.digest, 'plan.digest', digestPattern)
  const planRevision = admissionInteger(input.plan.revision, 'plan.revision')
  const releaseId = admissionText(input.release.id, 'release.id', identityPattern)
  const releaseFence = admissionInteger(input.release.fence, 'release.fence')
  const verificationEvidenceDigest = admissionText(input.verificationEvidenceDigest, 'verificationEvidenceDigest', digestPattern)
  const artifactStatementDigest = admissionText(input.artifactStatementDigest, 'artifactStatementDigest', digestPattern)
  const registryReference = admissionText(input.registryReference, 'registryReference', /^.+$/u)
  if (registryReference.includes('\0') || registryReference.includes('\r') || registryReference.includes('\n')) {
    throw new CatalogAdmissionError('invalid-input', 'registryReference is invalid')
  }
  const artifactSignature = admissionText(input.artifactSignature, 'artifactSignature', signaturePattern, 16_384)
  const signatureBytes = Buffer.from(artifactSignature, 'base64')
  if (signatureBytes.length === 0 || signatureBytes.toString('base64') !== artifactSignature) {
    throw new CatalogAdmissionError('invalid-input', 'artifactSignature is not canonical base64')
  }
  const artifactSignatureDigest = createHash('sha256').update(signatureBytes).digest('hex')
  const transitionId = createHash('sha256').update(canonical({
    schemaVersion: 1, catalog: { id: catalogId, path: catalogPath }, registry: {
      id: admissionText(input.registry.id, 'registry.id', identityPattern),
      locator: admissionText(input.registry.locator, 'registry.locator', /^.+$/u),
    },
    expectedBeforeCatalogDigest: admissionText(input.expectedBeforeCatalogDigest, 'expectedBeforeCatalogDigest', digestPattern),
    expectedAfterCatalogDigest: admissionText(input.expectedAfterCatalogDigest, 'expectedAfterCatalogDigest', digestPattern),
    candidate,
  })).digest('hex')
  const bindingDigest = createHash('sha256').update(canonical({
    schemaVersion: 1, transitionId, installationId, operationId,
    plan: { id: planId, digest: planDigest, revision: planRevision }, release: { id: releaseId, fence: releaseFence },
    registryReference, artifactStatementDigest, artifactSignatureDigest, verificationEvidenceDigest,
  })).digest('hex')
  return { transitionId, bindingDigest, artifactSignatureDigest }
}

function admissionEvidence(input: CatalogAdmissionInput, catalogPath: string, candidate: CatalogEntry,
  beforeCatalogDigest: string, afterCatalogDigest: string): CatalogAdmissionEvidence {
  const binding = admissionBinding(input, catalogPath, candidate)
  const admissionId = `catalog-admission-${binding.bindingDigest}`
  return Object.freeze({ kind: 'catalog-admission', admissionId, catalogId: input.catalog.id, beforeCatalogDigest, afterCatalogDigest,
    registryReference: input.registryReference, artifactStatementDigest: input.artifactStatementDigest,
    artifactSignatureDigest: binding.artifactSignatureDigest, verificationEvidenceDigest: input.verificationEvidenceDigest, candidate })
}

/** Derives the receipt identity from the complete request-bound admission. */
export function catalogAdmissionId(input: CatalogAdmissionInput): string {
  const candidate = exactCandidate(input.candidate)
  const path = input.catalog.path
  if (typeof path !== 'string' || !isAbsolute(path) || path === '/' || resolve(path) !== path) {
    throw new CatalogAdmissionError('invalid-input', 'catalog.path must be an absolute normalized path')
  }
  return admissionEvidence(input, path, candidate, input.expectedBeforeCatalogDigest, input.expectedAfterCatalogDigest).admissionId
}

/**
 * Atomically admits one independently verified candidate into the canonical
 * owner-private catalog. The expected digest is a request-bound CAS fence.
 * Every writer of this owner catalog must use this helper (or honor its shared
 * lock); POSIX rename alone cannot conditionally replace an arbitrary writer.
 */
export async function admitCatalogCandidate(input: CatalogAdmissionInput,
  hooks: CatalogAdmissionDurabilityHooks = {}): Promise<CatalogAdmissionResult> {
  const testHooks = hooks as CatalogAdmissionDurabilityHooks & CatalogAdmissionTestHooks
  const exchangePause = testHooks.afterExchangePauseMilliseconds ?? 0
  const reverseExchangePause = testHooks.beforeReverseExchangePauseMilliseconds ?? 0
  if (!Number.isInteger(exchangePause) || exchangePause < 0 || exchangePause > 1_000
    || !Number.isInteger(reverseExchangePause) || reverseExchangePause < 0 || reverseExchangePause > 1_000) {
    throw new CatalogAdmissionError('invalid-input', 'catalog admission exchange pause must be an integer from 0 through 1000')
  }
  const expectedBeforeCatalogDigest = admissionText(input.expectedBeforeCatalogDigest, 'expectedBeforeCatalogDigest', digestPattern)
  const expectedAfterCatalogDigest = admissionText(input.expectedAfterCatalogDigest, 'expectedAfterCatalogDigest', digestPattern)
  if (expectedBeforeCatalogDigest === expectedAfterCatalogDigest) {
    throw new CatalogAdmissionError('invalid-input', 'catalog admission must authorize one exact catalog change')
  }
  const candidate = exactCandidate(input.candidate)
  if (candidate.registry === undefined || candidate.registry.id !== input.registry.id
    || candidate.registry.locator !== input.registry.locator || candidate.registry.reference !== input.registryReference) {
    throw new CatalogAdmissionError('invalid-input', 'candidate registry identity and reference must bind the verified release artifact')
  }
  if (candidate.registry.reference.startsWith('file:')) {
    try { canonicalFileUrl(candidate.registry.reference, 'candidate.registry.reference') } catch (error) {
      throw new CatalogAdmissionError('invalid-input', error instanceof Error ? error.message : 'candidate registry reference is invalid')
    }
  }
  const catalogPath = await canonicalOwnerCatalogPath(input.catalog.path)
  const evidence = admissionEvidence(input, catalogPath, candidate, expectedBeforeCatalogDigest, expectedAfterCatalogDigest)
  const directoryPath = dirname(catalogPath)
  const directory = await openOwnerCatalogDirectory(directoryPath)
  let journalDirectory: Awaited<ReturnType<typeof openAdmissionJournalDirectory>> | undefined
  let attemptDirectory: Awaited<ReturnType<typeof openAttemptDirectory>> | undefined
  let operationError: unknown
  let cleanupError: unknown
  let result: CatalogAdmissionResult | undefined
  try {
    journalDirectory = await openAdmissionJournalDirectory(catalogPath, directory)
    acquireKernelAdmissionLock(directory)
    const journal = journalRecord(input, catalogPath, candidate, evidence)
    const journalPath = join(journalDirectory.path, `${journal.transitionId}.json`)
    const before = await loadOwnerCatalogSnapshot(catalogPath)
    if (before.digest === expectedAfterCatalogDigest) {
      const exact = before.catalog.entries.find(entry => entry.id === candidate.id && entry.package === candidate.package)
      if (exact === undefined || !exactEntry(exact, candidate)) {
        throw new CatalogAdmissionError('conflict', 'catalog has the expected after digest without the exact candidate')
      }
      const existingJournal = await readAdmissionJournal(journalPath)
      const attemptJournal = await admissionAttemptJournal(journalDirectory, journal.transitionId)
      if (attemptJournal !== undefined) await validateAttemptArtifacts(journalDirectory, attemptJournal, 'after')
      if (existingJournal?.schemaVersion === 1 && attemptJournal === undefined) {
        throw new CatalogAdmissionError('conflict', 'catalog after-state is missing its request-bound v2 attempt journal')
      }
      const durableJournal = attemptJournal ?? existingJournal
      if (durableJournal === undefined) {
        throw new CatalogAdmissionError('conflict', 'catalog after-state has no exact request-bound admission journal')
      } else if (durableJournal.bindingDigest !== journal.bindingDigest
        || durableJournal.transitionId !== journal.transitionId || canonical(durableJournal.evidence) !== canonical(journal.evidence)) {
        throw new CatalogAdmissionError('conflict', 'catalog transition belongs to a different admission operation')
      }
      result = Object.freeze({ evidence, replayed: true })
    } else {
      if (before.digest !== expectedBeforeCatalogDigest) {
        throw new CatalogAdmissionError('conflict', `catalog digest changed before admission (expected ${expectedBeforeCatalogDigest}, observed ${before.digest})`)
      }
      const existingAttempt = await admissionAttemptJournal(journalDirectory, journal.transitionId)
      if (existingAttempt !== undefined) {
        await validateAttemptArtifacts(journalDirectory, existingAttempt, 'before')
        throw new CatalogAdmissionError('conflict', `catalog admission has a durable unresolved attempt: ${existingAttempt.attemptDirectoryName}`)
      }
      const preview = previewCatalogAdmission(before.catalog, candidate)
      if (preview.afterCatalogDigest !== expectedAfterCatalogDigest || preview.beforeCatalogDigest !== expectedBeforeCatalogDigest) {
        throw new CatalogAdmissionError('conflict', 'request expected after digest does not match the deterministic catalog transition')
      }
      const next = preview.catalog
      await persistAdmissionJournal(journalDirectory, journal, hooks)

      const serialized = `${JSON.stringify(next, null, 2)}\n`
      if (Buffer.byteLength(serialized) > maximumCatalogBytes) throw new CatalogAdmissionError('invalid-input', 'admitted catalog would exceed 1 MiB')
      const desiredFileDigest = createHash('sha256').update(serialized).digest('hex')
      const names: CatalogAdmissionAttemptNames = { desired: 'desired', stage: 'stage', before: 'before', reverseMarker: 'reverse-ready' }
      let temporary: FileHandle | undefined
      let beforeCopy: FileHandle | undefined
      let expectedCatalog: FileHandle | undefined
      try {
        try { temporary = await open(`/proc/self/fd/${directory.fd}`, constants.O_RDWR | O_TMPFILE, 0o600) } catch {
          throw new CatalogAdmissionError('unsafe-catalog', 'catalog filesystem does not support descriptor-backed temporary files')
        }
        try { beforeCopy = await open(`/proc/self/fd/${directory.fd}`, constants.O_RDWR | O_TMPFILE, 0o600) } catch {
          throw new CatalogAdmissionError('unsafe-catalog', 'catalog filesystem does not support descriptor-backed rollback files')
        }
        await temporary.writeFile(serialized, 'utf8')
        await temporary.sync()
        expectedCatalog = await openOwnerCatalog(catalogPath)
        const originalBytes = Buffer.alloc(Number((await expectedCatalog.stat()).size))
        let originalOffset = 0
        while (originalOffset < originalBytes.length) {
          const chunk = await expectedCatalog.read(originalBytes, originalOffset, originalBytes.length - originalOffset, originalOffset)
          if (chunk.bytesRead === 0) throw new CatalogAdmissionError('conflict', 'catalog descriptor ended during rollback snapshot')
          originalOffset += chunk.bytesRead
        }
        if (createHash('sha256').update(originalBytes).digest('hex') !== before.fileDigest) {
          throw new CatalogAdmissionError('conflict', 'catalog bytes changed while preparing rollback')
        }
        await beforeCopy.writeFile(originalBytes); await beforeCopy.sync()
        const temporaryMetadata = await temporary.stat({ bigint: true }); const beforeCopyMetadata = await beforeCopy.stat({ bigint: true })
        const parentMetadata = await directory.stat({ bigint: true }); const uid = process.getuid?.()
        if (!temporaryMetadata.isFile() || temporaryMetadata.nlink !== 0n || (temporaryMetadata.mode & 0o777n) !== 0o600n
          || (uid !== undefined && temporaryMetadata.uid !== BigInt(uid))) {
          throw new CatalogAdmissionError('unsafe-catalog', 'unnamed temporary catalog is not an owner-private regular file')
        }
        const deterministicAttemptId = attemptId(journal.bindingDigest)
        attemptDirectory = await openAttemptDirectory(journalDirectory, attemptDirectoryName(catalogPath, deterministicAttemptId))
        const temporaryPath = join(attemptDirectory.path, names.desired)
        const attemptJournal = attemptJournalRecord(input, catalogPath, candidate, evidence, before,
          { dev: temporaryMetadata.dev, ino: temporaryMetadata.ino, fileDigest: desiredFileDigest },
          { dev: beforeCopyMetadata.dev, ino: beforeCopyMetadata.ino, fileDigest: before.fileDigest },
          { dev: parentMetadata.dev, ino: parentMetadata.ino })
        await persistAdmissionJournal(journalDirectory, attemptJournal, hooks)
        runCatalogCommitHelper('prepare', temporary, expectedCatalog, attemptDirectory.handle, beforeCopy, directory,
          [desiredFileDigest, before.fileDigest, String(before.dev), String(before.ino), names.desired, names.before])
        await hooks.afterTemporaryFileSync?.(temporaryPath)
        await hooks.beforeAtomicRename?.(catalogPath, temporaryPath)
        runCatalogCommitHelper('commit', temporary, expectedCatalog, attemptDirectory.handle, beforeCopy, directory,
          [String(before.dev), String(before.ino), before.fileDigest, desiredFileDigest, names.desired, names.before,
            basename(catalogPath), names.reverseMarker, String(exchangePause), String(reverseExchangePause)])
        await hooks.afterAtomicRename?.(catalogPath)
      } finally {
        await expectedCatalog?.close()
        await temporary?.close()
        await beforeCopy?.close()
        // Attempt names live in a durable request-bound directory. They are
        // never removed by pathname after another writer could replace them.
      }

      const after = await loadOwnerCatalogSnapshot(catalogPath)
      if (after.digest !== expectedAfterCatalogDigest) {
        throw new CatalogAdmissionError('conflict', 'catalog changed after atomic admission')
      }
      const admitted = after.catalog.entries.find(entry => entry.id === candidate.id)
      if (admitted === undefined || !exactEntry(admitted, candidate)) {
        throw new CatalogAdmissionError('conflict', 'catalog re-read does not contain the exact admitted candidate')
      }
      result = Object.freeze({ evidence, replayed: false })
    }
  } catch (error) {
    operationError = error
  } finally {
    try { await attemptDirectory?.handle.close() } catch (error) { cleanupError ??= error }
    try { await journalDirectory?.handle.close() } catch (error) { cleanupError ??= error }
    try { await directory.close() } catch (error) { cleanupError ??= error }
  }
  if (operationError !== undefined) throw operationError
  if (cleanupError !== undefined) throw cleanupError
  return result!
}

export async function loadCatalog(path: string): Promise<CapabilityCatalog> {
  const metadata = await lstat(path)
  const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
    || (metadata.mode & 0o022) !== 0 || (uid !== undefined && metadata.uid !== uid)
    || await realpath(path) !== resolve(path)) {
    throw new Error('plugin-control-plane: owner catalog must be an owner-owned regular file without writable aliases or symlink traversal')
  }
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > maximumCatalogBytes) throw new Error('plugin-control-plane: catalog exceeds 1 MiB')
  return parseCatalog(JSON.parse(source) as unknown)
}

/**
 * Package-local example used by documentation and tests. It is deliberately
 * not a runtime fallback or trust source because it is not signature-verified.
 * Runtime discovery requires an owner-provided, integrity-pinned regular file.
 */
export const exampleIntegrityPinnedCatalog: CapabilityCatalog = parseCatalog({
  schemaVersion: 1,
  entries: [
    {
      id: 'coding-subscription-provider',
      capabilities: ['coding agent', 'codex', 'claude code', 'cursor', 'grok'],
      package: '@dsh-enhanced/coding-subscription-provider', version: '0.1.3',
      integrity: 'sha512-LMyIzx2NJrK7+ExsoB049fkLi4rJncYBU8Mn56ssWNBoW+LqtuzlofymwBHL2In7UPwHG3V+7MxBE0MjkrWmlQ==',
      authorities: ['filesystem: local coding-client credentials', 'subprocess: locally installed coding clients', 'network: configured provider route'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'traex-acp-provider',
      capabilities: ['coding agent', 'traex', 'acp', 'reasoning effort'],
      package: '@dsh-enhanced/traex-acp-provider', version: '0.1.3',
      integrity: 'sha512-qGoYNAcO/uNHw/WMzOTD6q3Z8hIC7HwMGrp996BrJGB5HpUayuz58oCjyYQQ+caREnb8vESS9DoaW5nOGpB9sA==',
      authorities: ['subprocess: local TraeX ACP client', 'network: TraeX-managed provider route'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'assistant-health',
      capabilities: ['health', 'readiness', 'liveness', 'diagnostics'],
      package: '@dsh-enhanced/assistant-health', version: '0.1.3',
      integrity: 'sha512-GcNqvjjSul+jrx52dFzxsKASPXUeMDi+ia40DXXI77rZQaqWc6O49iOPCXkrbo43pbsZmCY5cpjb1zLtWLkuQA==',
      authorities: ['read-only: mounted service health and diagnostics'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'assistant-heartbeat',
      capabilities: ['heartbeat', 'proactive check-in', 'active hours'],
      package: '@dsh-enhanced/assistant-heartbeat', version: '0.1.3',
      integrity: 'sha512-wXTOl2LAGg3fvnZ9rxiQTv6w8nxLsjODA74V5QipoYitm2hezx30obPQBWqEtpTym3dvC7AEVBTqgRLDWt+Ycw==',
      authorities: ['persistent schedule state', 'agent invocation during configured active hours'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'event-triggers',
      capabilities: ['events', 'webhook', 'file watch', 'https polling'],
      package: '@dsh-enhanced/event-triggers', version: '0.1.3',
      integrity: 'sha512-iMl6zwuYwFpqLq0nIGW59mcQlDvu8370ex9FRtTW7WwW5Ab40Hk7cbHTJ2UpZQj0yEBi0lraVD0t7boXopfigg==',
      authorities: ['filesystem: configured watched paths', 'network: configured HTTPS endpoints', 'network ingress: HMAC webhook endpoint'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'memory-wiki-bridge',
      capabilities: ['memory', 'wiki', 'knowledge promotion'],
      package: '@dsh-enhanced/memory-wiki-bridge', version: '0.1.3',
      integrity: 'sha512-vvsh72xDsxcyUZHT67T/nJgtN+h2uiXVG3ez+BovzFR/owFtLWjELbFZeV2TVvQJARRizcdEFqq6mIawCOovZw==',
      authorities: ['filesystem: configured personal Wiki vault', 'persistent proposal state'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'lark-assistant',
      capabilities: ['lark', 'feishu', 'chat channel', 'resident assistant'],
      package: '@dsh-enhanced/lark-channel', version: '0.1.3',
      integrity: 'sha512-CWwxX1cW2PYldWz/p3+EMG1VRwu1EzKyFS984sMq/tzY0a1TGjgZsLNOn0EHq2hpwCBdZd861gnmmKTqF7nwng==',
      requires: [
        { package: '@dsh-enhanced/assistant-delivery', version: '0.1.3', integrity: 'sha512-ZgPV8CYY0L5X7rUHG4b9/ulPlQi5PNnrDi8LPpTPj+y8Mc5oE7bbZQnKpniGkjEftmWK16GRlhx+A9Z00sYsTw==' },
        { package: '@dsh-enhanced/credentials-keychain', version: '0.1.3', integrity: 'sha512-g8OOFqnDwd0/SRldZmWN6f6FScD1llN+jdjRu4lLmZ1xdQ6nOacEGvUK4l1rCa89xNWkJVFdgQLuOC/e2VbDXw==' },
      ],
      authorities: ['network: Lark WebSocket and API', 'credentials: OS keychain/secret store', 'resident process: current-user service'],
      dshBaseline: '0.1.0-rc.8',
    },
    {
      id: 'supervised-evolution',
      capabilities: ['supervised growth', 'evolution', 'behaviour guidance'],
      package: '@dsh-enhanced/assistant-evolution', version: '0.1.3',
      integrity: 'sha512-WeerqdqJuqUNqCPb/QtTuvF4amJ3YlS/mJ0QoUlqt5Bygso2nz6K4o2vDF4MaDaIhjpuCR0KTiqFLXXQHAEEEg==',
      requires: [
        { package: '@dsh-enhanced/assistant-delivery', version: '0.1.3', integrity: 'sha512-ZgPV8CYY0L5X7rUHG4b9/ulPlQi5PNnrDi8LPpTPj+y8Mc5oE7bbZQnKpniGkjEftmWK16GRlhx+A9Z00sYsTw==' },
        { package: '@dsh-enhanced/credentials-keychain', version: '0.1.3', integrity: 'sha512-g8OOFqnDwd0/SRldZmWN6f6FScD1llN+jdjRu4lLmZ1xdQ6nOacEGvUK4l1rCa89xNWkJVFdgQLuOC/e2VbDXw==' },
        { package: '@dsh-enhanced/lark-channel', version: '0.1.3', integrity: 'sha512-CWwxX1cW2PYldWz/p3+EMG1VRwu1EzKyFS984sMq/tzY0a1TGjgZsLNOn0EHq2hpwCBdZd861gnmmKTqF7nwng==' },
        { package: '@dsh-enhanced/traex-acp-provider', version: '0.1.3', integrity: 'sha512-qGoYNAcO/uNHw/WMzOTD6q3Z8hIC7HwMGrp996BrJGB5HpUayuz58oCjyYQQ+caREnb8vESS9DoaW5nOGpB9sA==' },
      ],
      authorities: ['network: Lark approval channel', 'credentials: OS keychain/secret store', 'subprocess: local TraeX ACP client', 'persistent guidance and approval state'],
      dshBaseline: '0.1.0-rc.8',
    },
  ],
})

export async function loadCatalogWithMetadata(path: string): Promise<LoadedCapabilityCatalog> {
  const catalog = await loadCatalog(path)
  return Object.freeze({ catalog, digest: catalogDigest(catalog), provenance: 'owner-provided-integrity-pinned' })
}

export function discover(catalog: CapabilityCatalog, capability: string): CatalogEntry[] {
  const terms = capability.normalize('NFC').toLocaleLowerCase('en-US').trim().split(/\s+/u).filter(Boolean)
  if (terms.length === 0 || terms.length > 12) throw new Error('plugin-control-plane: capability query must contain 1..12 terms')
  return catalog.entries.filter(entry => {
    const haystack = `${entry.id} ${entry.capabilities.join(' ')}`.toLocaleLowerCase('en-US')
    return terms.every(term => haystack.includes(term))
  })
}

export function candidateDigest(entry: CatalogEntry, profile: string): string {
  return createHash('sha256').update(JSON.stringify({ entry, profile })).digest('hex')
}
