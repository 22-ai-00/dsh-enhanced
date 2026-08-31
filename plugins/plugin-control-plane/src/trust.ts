import { constants as fsConstants } from 'node:fs'
import { lstat, open, readFile, realpath, type FileHandle } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createHash, createPublicKey } from 'node:crypto'
import type { HostAttestationPolicy, SourceReleaseAdapterIdentity, SourceReleasePhase } from './types.js'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u
const ENVIRONMENT = /^[A-Z][A-Z0-9_]{0,63}$/u
const FORBIDDEN_ENVIRONMENT = /(AUTH|COOKIE|CREDENTIAL|KEY|PASS|SECRET|TOKEN)/u
const EXECUTION_CONTROL_ENVIRONMENT = /^(?:BASH_ENV|ENV|IFS|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|PERL5LIB|PERL5OPT|PYTHONHOME|PYTHONPATH|RUBYLIB|RUBYOPT|SHELLOPTS|ZDOTDIR)$/u

export interface TrustKey {
  authority: string
  keyId: string
  publicKeyPem: string
}

export interface PluginControlTrustConfig {
  schemaVersion: 1 | 2 | 3 | 4
  installationId: string
  dshHome: string
  ledger: { id: string; path: string }
  executor: {
    id: string
    version: string
    path: string
    sha256: string
    environmentAllowlist: readonly string[]
  }
  hostPolicy: HostAttestationPolicy
  hostAttestor?: {
    id: string
    version: string
    path: string
    sha256: string
    interpreter: { path: string; sha256: string } | null
    environmentAllowlist: readonly string[]
    authority: string
    keyId: string
    timeoutMs: number
  }
  catalog: { id: string; path: string }
  releaseRegistry?: { id: string; locator: string }
  releaseReceiptTtlMs: number
  releaseAdapters?: Partial<Record<SourceReleasePhase, SourceReleaseAdapterIdentity & {
    environmentAllowlist: readonly string[]
    timeoutMs: number
  }>>
  approvalKeys: readonly TrustKey[]
  hostAttestationKeys: readonly TrustKey[]
  releaseKeys: readonly TrustKey[]
  releaseAuthorizationKeys: readonly TrustKey[]
}

export interface TrustedExecutableSnapshot { device: bigint; inode: bigint; sha256: string }
export interface OpenTrustedExecutable { path: string; handle: FileHandle; snapshot: TrustedExecutableSnapshot }

export class TrustConfigError extends Error {
  constructor(readonly code: 'invalid-config' | 'unsafe-file', message: string) {
    super(message)
    this.name = 'TrustConfigError'
  }
}

export const defaultHostAttestationPolicy: HostAttestationPolicy = Object.freeze({
  readinessMinimumChecks: 1,
  effectBlockedMinimumDeliveryAttempts: 1,
  effectBlockedMinimumToolExecutionAttempts: 1,
  shadowMinimumSamples: 1,
  shadowMaximumMismatches: 0,
  canaryMinimumSamples: 1,
  canaryMaximumFailures: 0,
  soakMinimumWindowMs: 60_000,
  soakMinimumSamples: 10,
  soakMaximumFailureRate: 0,
  healthMinimumChecks: 1,
  healthMaximumFailures: 0,
  receiptTtlMs: 30_000,
})

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TrustConfigError('invalid-config', `${label} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new TrustConfigError('invalid-config', `${label} has unknown or missing fields`)
}

function text(value: unknown, label: string, maximum = 500): string {
  if (typeof value !== 'string') throw new TrustConfigError('invalid-config', `${label} must be text`)
  const normalized = value.normalize('NFC').trim()
  if (normalized === '' || Buffer.byteLength(normalized) > maximum || [...normalized].some(character => {
    const point = character.codePointAt(0)!
    return point <= 0x1f || point === 0x7f
  })) throw new TrustConfigError('invalid-config', `${label} must be bounded printable text`)
  return normalized
}

function keys(value: unknown, label: string): readonly TrustKey[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) throw new TrustConfigError('invalid-config', `${label} must contain 1..32 keys`)
  const seen = new Set<string>()
  return Object.freeze(value.map((raw, index) => {
    const item = record(raw, `${label}[${index}]`)
    exactKeys(item, ['authority', 'keyId', 'publicKeyPem'], `${label}[${index}]`)
    const authority = text(item.authority, `${label}.authority`, 128)
    const keyId = text(item.keyId, `${label}.keyId`, 128)
    if (typeof item.publicKeyPem !== 'string') throw new TrustConfigError('invalid-config', `${label}.publicKeyPem must be text`)
    const publicKeyPem = item.publicKeyPem.trim()
    if (Buffer.byteLength(publicKeyPem) > 8_192 || publicKeyPem.includes('\0')) throw new TrustConfigError('invalid-config', `${label}.publicKeyPem is invalid`)
    if (!ID.test(authority) || !ID.test(keyId) || seen.has(`${authority}\0${keyId}`)) throw new TrustConfigError('invalid-config', `${label} contains an invalid or duplicate authority/key id`)
    seen.add(`${authority}\0${keyId}`)
    try {
      const key = createPublicKey(publicKeyPem)
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519')
    } catch { throw new TrustConfigError('invalid-config', `${label} must contain Ed25519 public keys`) }
    return Object.freeze({ authority, keyId, publicKeyPem })
  }))
}

function keyFingerprint(key: TrustKey): string {
  const der = createPublicKey(key.publicKeyPem).export({ format: 'der', type: 'spki' })
  return createHash('sha256').update(der).digest('hex')
}

function assertIndependentKeySets(left: readonly TrustKey[], right: readonly TrustKey[], label: string): void {
  for (const first of left) for (const second of right) {
    if ((first.authority === second.authority && first.keyId === second.keyId) || keyFingerprint(first) === keyFingerprint(second)) {
      throw new TrustConfigError('invalid-config', `${label} must not reuse an authority/key identity or public key`)
    }
  }
}

async function assertOwnerPrivateFile(path: string): Promise<void> {
  const metadata = await lstat(path)
  const uid = process.getuid?.()
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0
    || (uid !== undefined && metadata.uid !== uid) || await realpath(path) !== resolve(path)) {
    throw new TrustConfigError('unsafe-file', 'trust config must be one owner-owned 0600 regular file without symlink traversal')
  }
  const parent = await lstat(dirname(path))
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
    || (uid !== undefined && parent.uid !== uid) || await realpath(dirname(path)) !== resolve(dirname(path))) {
    throw new TrustConfigError('unsafe-file', 'trust config directory must be owner-owned and private')
  }
}

async function readAt(handle: FileHandle, size: bigint): Promise<Buffer> {
  const bytes = Buffer.alloc(Number(size)); let offset = 0
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== bytes.length) throw new TrustConfigError('unsafe-file', 'trusted executable changed or was truncated while reading')
  return bytes
}

async function snapshotOpenTrustedExecutable(path: string, handle: FileHandle, expectedSha256: string): Promise<TrustedExecutableSnapshot> {
  const before = await handle.stat({ bigint: true }); const pathBefore = await lstat(path, { bigint: true }); const uid = process.getuid?.()
  const expectedUid = uid === undefined ? undefined : BigInt(uid)
  if (!before.isFile() || before.nlink !== 1n || before.size > 268_435_456n || (before.mode & 0o111n) === 0n
    || (before.mode & 0o022n) !== 0n || (expectedUid !== undefined && before.uid !== 0n && before.uid !== expectedUid)
    || !pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.dev !== before.dev || pathBefore.ino !== before.ino) {
    throw new TrustConfigError('unsafe-file', 'trusted executable must be one bounded non-writable root- or owner-owned executable regular file')
  }
  const bytes = await readAt(handle, before.size); const sha256 = createHash('sha256').update(bytes).digest('hex')
  const after = await handle.stat({ bigint: true }); const pathAfter = await lstat(path, { bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || sha256 !== expectedSha256) {
    throw new TrustConfigError('unsafe-file', 'trusted executable identity or digest changed during verification')
  }
  return Object.freeze({ device: before.dev, inode: before.ino, sha256 })
}

export async function openTrustedExecutable(path: string, expectedSha256: string): Promise<OpenTrustedExecutable> {
  if (!isAbsolute(path) || await realpath(path) !== resolve(path)) throw new TrustConfigError('unsafe-file', 'trusted executable path must be canonical')
  const directory = await lstat(dirname(path)); const uid = process.getuid?.()
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) !== 0
    || (uid !== undefined && directory.uid !== 0 && directory.uid !== uid)) {
    throw new TrustConfigError('unsafe-file', 'trusted executable directory must not be writable by another principal')
  }
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const snapshot = await snapshotOpenTrustedExecutable(path, handle, expectedSha256)
    return Object.freeze({ path, handle, snapshot })
  } catch (error) { await handle.close(); throw error }
}

export async function verifyOpenTrustedExecutable(value: OpenTrustedExecutable): Promise<TrustedExecutableSnapshot> {
  const current = await snapshotOpenTrustedExecutable(value.path, value.handle, value.snapshot.sha256)
  if (current.device !== value.snapshot.device || current.inode !== value.snapshot.inode) {
    throw new TrustConfigError('unsafe-file', 'trusted executable descriptor identity changed during execution')
  }
  return current
}

export async function inspectTrustedExecutable(path: string, expectedSha256: string): Promise<TrustedExecutableSnapshot> {
  const executable = await openTrustedExecutable(path, expectedSha256)
  try { return executable.snapshot } finally { await executable.handle.close() }
}

function environmentAllowlist(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > 32) throw new TrustConfigError('invalid-config', `${label} must be an array`)
  const result = [...new Set(value.map(raw => text(raw, label, 64)))]
  if (result.some(name => !ENVIRONMENT.test(name) || FORBIDDEN_ENVIRONMENT.test(name) || EXECUTION_CONTROL_ENVIRONMENT.test(name))) {
    throw new TrustConfigError('invalid-config', `${label} contains an invalid or secret-bearing variable`)
  }
  return Object.freeze(result)
}

function policy(value: unknown): HostAttestationPolicy {
  const item = record(value, 'hostPolicy')
  const fields = ['readinessMinimumChecks', 'effectBlockedMinimumDeliveryAttempts', 'effectBlockedMinimumToolExecutionAttempts',
    'shadowMinimumSamples', 'shadowMaximumMismatches', 'canaryMinimumSamples', 'canaryMaximumFailures', 'soakMinimumWindowMs',
    'soakMinimumSamples', 'soakMaximumFailureRate', 'healthMinimumChecks', 'healthMaximumFailures', 'receiptTtlMs'] as const
  exactKeys(item, fields, 'hostPolicy')
  const positive = (name: typeof fields[number], minimum: number, maximum: number): number => {
    const raw = item[name]
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) {
      throw new TrustConfigError('invalid-config', `hostPolicy.${name} is outside its accepted range`)
    }
    return raw
  }
  const rate = item.soakMaximumFailureRate
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new TrustConfigError('invalid-config', 'hostPolicy.soakMaximumFailureRate must be between zero and one')
  }
  return Object.freeze({
    readinessMinimumChecks: positive('readinessMinimumChecks', 1, 1_000_000),
    effectBlockedMinimumDeliveryAttempts: positive('effectBlockedMinimumDeliveryAttempts', 1, 1_000_000),
    effectBlockedMinimumToolExecutionAttempts: positive('effectBlockedMinimumToolExecutionAttempts', 1, 1_000_000),
    shadowMinimumSamples: positive('shadowMinimumSamples', 1, 1_000_000),
    shadowMaximumMismatches: positive('shadowMaximumMismatches', 0, 1_000_000),
    canaryMinimumSamples: positive('canaryMinimumSamples', 1, 1_000_000),
    canaryMaximumFailures: positive('canaryMaximumFailures', 0, 1_000_000),
    soakMinimumWindowMs: positive('soakMinimumWindowMs', 1, 86_400_000),
    soakMinimumSamples: positive('soakMinimumSamples', 1, 10_000_000),
    soakMaximumFailureRate: rate,
    healthMinimumChecks: positive('healthMinimumChecks', 1, 1_000_000),
    healthMaximumFailures: positive('healthMaximumFailures', 0, 1_000_000),
    receiptTtlMs: positive('receiptTtlMs', 1_000, 300_000),
  })
}

type TrustedReleaseAdapter = NonNullable<PluginControlTrustConfig['releaseAdapters']>[SourceReleasePhase]

async function externalAdapter(value: unknown, label: string, trustedKeys: readonly TrustKey[]): Promise<NonNullable<TrustedReleaseAdapter>> {
  const item = record(value, label)
  exactKeys(item, ['id', 'version', 'path', 'sha256', 'interpreter', 'environmentAllowlist', 'authority', 'keyId', 'timeoutMs'], label)
  const id = text(item.id, `${label}.id`, 128); const version = text(item.version, `${label}.version`, 64)
  const pathInput = text(item.path, `${label}.path`, 2_000); const sha256 = text(item.sha256, `${label}.sha256`, 64).toLowerCase()
  const authority = text(item.authority, `${label}.authority`, 128); const keyId = text(item.keyId, `${label}.keyId`, 128)
  if (!ID.test(id) || !VERSION.test(version) || !isAbsolute(pathInput) || !/^[a-f0-9]{64}$/u.test(sha256)
    || !ID.test(authority) || !ID.test(keyId) || !Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1_000 || Number(item.timeoutMs) > 300_000) {
    throw new TrustConfigError('invalid-config', `${label} identity, digest, authority or timeout is invalid`)
  }
  const path = await realpath(pathInput)
  if (path !== resolve(pathInput)) throw new TrustConfigError('invalid-config', `${label} path must be canonical`)
  await inspectTrustedExecutable(path, sha256)
  const firstLine = (await readFile(path)).subarray(0, 512).toString('utf8').split('\n', 1)[0] ?? ''
  let interpreter: SourceReleaseAdapterIdentity['interpreter'] = null
  if (firstLine.startsWith('#!')) {
    const raw = record(item.interpreter, `${label}.interpreter`); exactKeys(raw, ['path', 'sha256'], `${label}.interpreter`)
    const interpreterPathInput = text(raw.path, `${label}.interpreter.path`, 2_000)
    const interpreterSha256 = text(raw.sha256, `${label}.interpreter.sha256`, 64).toLowerCase()
    if (!isAbsolute(interpreterPathInput) || !/^[a-f0-9]{64}$/u.test(interpreterSha256)) throw new TrustConfigError('invalid-config', `${label} interpreter binding is invalid`)
    const interpreterPath = await realpath(interpreterPathInput)
    if (interpreterPath !== resolve(interpreterPathInput) || firstLine !== `#!${interpreterPath}`) {
      throw new TrustConfigError('invalid-config', `${label} script must use its exact canonical pinned interpreter without arguments`)
    }
    await inspectTrustedExecutable(interpreterPath, interpreterSha256)
    interpreter = Object.freeze({ path: interpreterPath, sha256: interpreterSha256 })
  } else if (item.interpreter !== null) throw new TrustConfigError('invalid-config', `${label} native executable must set interpreter to null`)
  if (!trustedKeys.some(key => key.authority === authority && key.keyId === keyId)) throw new TrustConfigError('invalid-config', `${label} authority/key is not pre-registered`)
  return Object.freeze({ id, version, path, sha256, interpreter,
    environmentAllowlist: environmentAllowlist(item.environmentAllowlist, `${label}.environmentAllowlist`),
    authority, keyId, timeoutMs: Number(item.timeoutMs) })
}

async function independent(left: TrustedReleaseAdapter | undefined, right: TrustedReleaseAdapter | undefined, label: string,
  trustedKeys: readonly TrustKey[]): Promise<void> {
  if (left === undefined || right === undefined) return
  const leftFile = await lstat(left.path, { bigint: true }); const rightFile = await lstat(right.path, { bigint: true })
  const leftKey = trustedKeys.find(key => key.authority === left.authority && key.keyId === left.keyId)!
  const rightKey = trustedKeys.find(key => key.authority === right.authority && key.keyId === right.keyId)!
  const leftInterpreter = left.interpreter === null ? undefined : await lstat(left.interpreter.path, { bigint: true })
  const rightInterpreter = right.interpreter === null ? undefined : await lstat(right.interpreter.path, { bigint: true })
  const sameIdentity = (first: { dev: bigint; ino: bigint } | undefined, second: { dev: bigint; ino: bigint } | undefined): boolean =>
    first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino
  if (left.id === right.id || left.authority === right.authority || left.path === right.path
    || sameIdentity(leftFile, rightFile)
    || sameIdentity(leftFile, rightInterpreter) || sameIdentity(leftInterpreter, rightFile)
    || keyFingerprint(leftKey) === keyFingerprint(rightKey)) {
    throw new TrustConfigError('invalid-config', `${label} must use independent executable and signing authority/key`)
  }
}

export async function loadTrustConfig(pathInput: string): Promise<PluginControlTrustConfig> {
  const path = resolve(pathInput)
  await assertOwnerPrivateFile(path)
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > 65_536) throw new TrustConfigError('invalid-config', 'trust config exceeds 64 KiB')
  let parsed: unknown
  try { parsed = JSON.parse(source) as unknown } catch { throw new TrustConfigError('invalid-config', 'trust config is not valid JSON') }
  const root = record(parsed, 'trust config')
  if (root.schemaVersion === 1) exactKeys(root, ['schemaVersion', 'installationId', 'dshHome', 'ledger', 'executor', 'approvalKeys', 'hostAttestationKeys'], 'trust config')
  else if (root.schemaVersion === 2) exactKeys(root, ['schemaVersion', 'installationId', 'dshHome', 'ledger', 'executor', 'hostPolicy', 'hostAttestor', 'approvalKeys', 'hostAttestationKeys'], 'trust config')
  else if (root.schemaVersion === 3) exactKeys(root, ['schemaVersion', 'installationId', 'dshHome', 'ledger', 'executor', 'hostPolicy', 'hostAttestor',
    'catalog', 'releaseRegistry', 'releaseReceiptTtlMs', 'releaseAdapters', 'approvalKeys', 'hostAttestationKeys', 'releaseKeys'], 'trust config')
  else if (root.schemaVersion === 4) exactKeys(root, ['schemaVersion', 'installationId', 'dshHome', 'ledger', 'executor', 'hostPolicy', 'hostAttestor',
    'catalog', 'releaseRegistry', 'releaseReceiptTtlMs', 'releaseAdapters', 'approvalKeys', 'hostAttestationKeys', 'releaseKeys',
    'releaseAuthorizationKeys'], 'trust config')
  else throw new TrustConfigError('invalid-config', 'unsupported trust config schema')
  const installationId = text(root.installationId, 'installationId', 36).toLowerCase()
  if (!UUID.test(installationId)) throw new TrustConfigError('invalid-config', 'installationId must be a UUID')
  const dshHomeInput = text(root.dshHome, 'dshHome', 2_000)
  if (!isAbsolute(dshHomeInput) || await realpath(dshHomeInput) !== resolve(dshHomeInput)) throw new TrustConfigError('invalid-config', 'dshHome must be an existing canonical directory')
  const ledgerInput = record(root.ledger, 'ledger'); exactKeys(ledgerInput, ['id', 'path'], 'ledger')
  const ledgerId = text(ledgerInput.id, 'ledger.id', 36).toLowerCase(); const ledgerPathInput = text(ledgerInput.path, 'ledger.path', 2_000)
  if (!UUID.test(ledgerId) || !isAbsolute(ledgerPathInput) || await realpath(dirname(ledgerPathInput)) !== resolve(dirname(ledgerPathInput))) {
    throw new TrustConfigError('invalid-config', 'ledger id/path must identify one canonical control-plane directory')
  }
  const ledgerPath = resolve(ledgerPathInput)
  const executorInput = record(root.executor, 'executor')
  exactKeys(executorInput, ['id', 'version', 'path', 'sha256', 'environmentAllowlist'], 'executor')
  const executorId = text(executorInput.id, 'executor.id', 128)
  const executorVersion = text(executorInput.version, 'executor.version', 64)
  const executorPathInput = text(executorInput.path, 'executor.path', 2_000)
  const executorSha256 = text(executorInput.sha256, 'executor.sha256', 64).toLowerCase()
  if (!ID.test(executorId) || !VERSION.test(executorVersion) || !isAbsolute(executorPathInput)
    || !/^[a-f0-9]{64}$/u.test(executorSha256)) throw new TrustConfigError('invalid-config', 'executor identity/version/path/digest is invalid')
  const executorPath = await realpath(executorPathInput)
  if (executorPath !== resolve(executorPathInput)) throw new TrustConfigError('invalid-config', 'executor path must be canonical')
  await inspectTrustedExecutable(executorPath, executorSha256)
  const executorEnvironmentAllowlist = environmentAllowlist(executorInput.environmentAllowlist, 'executor.environmentAllowlist')
  const approvalKeys = keys(root.approvalKeys, 'approvalKeys'); const hostAttestationKeys = keys(root.hostAttestationKeys, 'hostAttestationKeys')
  const releaseKeys = root.schemaVersion === 3 || root.schemaVersion === 4 ? keys(root.releaseKeys, 'releaseKeys') : Object.freeze([])
  const releaseAuthorizationKeys = root.schemaVersion === 4 ? keys(root.releaseAuthorizationKeys, 'releaseAuthorizationKeys') : Object.freeze([])
  if (root.schemaVersion === 4) {
    assertIndependentKeySets(releaseAuthorizationKeys, approvalKeys, 'release authorization and source approval keys')
    assertIndependentKeySets(releaseAuthorizationKeys, releaseKeys, 'release authorization and adapter receipt keys')
    assertIndependentKeySets(approvalKeys, releaseKeys, 'source approval and adapter receipt keys')
  }
  const hostPolicy = root.schemaVersion === 2 || root.schemaVersion === 3 || root.schemaVersion === 4 ? policy(root.hostPolicy) : defaultHostAttestationPolicy
  let hostAttestor: PluginControlTrustConfig['hostAttestor']
  if ((root.schemaVersion === 2 || root.schemaVersion === 3 || root.schemaVersion === 4) && root.hostAttestor !== null) {
    const item = record(root.hostAttestor, 'hostAttestor')
    exactKeys(item, ['id', 'version', 'path', 'sha256', 'interpreter', 'environmentAllowlist', 'authority', 'keyId', 'timeoutMs'], 'hostAttestor')
    const id = text(item.id, 'hostAttestor.id', 128); const version = text(item.version, 'hostAttestor.version', 64)
    const pathInput = text(item.path, 'hostAttestor.path', 2_000); const sha256 = text(item.sha256, 'hostAttestor.sha256', 64).toLowerCase()
    const authority = text(item.authority, 'hostAttestor.authority', 128); const keyId = text(item.keyId, 'hostAttestor.keyId', 128)
    if (!ID.test(id) || !VERSION.test(version) || !isAbsolute(pathInput) || !/^[a-f0-9]{64}$/u.test(sha256)
      || !ID.test(authority) || !ID.test(keyId) || !Number.isSafeInteger(item.timeoutMs) || Number(item.timeoutMs) < 1_000 || Number(item.timeoutMs) > 300_000) {
      throw new TrustConfigError('invalid-config', 'hostAttestor identity, digest, authority or timeout is invalid')
    }
    const attestorPath = await realpath(pathInput)
    if (attestorPath !== resolve(pathInput)) throw new TrustConfigError('invalid-config', 'hostAttestor path must be canonical')
    await inspectTrustedExecutable(attestorPath, sha256)
    const firstLine = (await readFile(attestorPath)).subarray(0, 512).toString('utf8').split('\n', 1)[0] ?? ''
    let interpreter: NonNullable<PluginControlTrustConfig['hostAttestor']>['interpreter'] = null
    if (firstLine.startsWith('#!')) {
      const interpreterInput = record(item.interpreter, 'hostAttestor.interpreter')
      exactKeys(interpreterInput, ['path', 'sha256'], 'hostAttestor.interpreter')
      const interpreterPathInput = text(interpreterInput.path, 'hostAttestor.interpreter.path', 2_000)
      const interpreterSha256 = text(interpreterInput.sha256, 'hostAttestor.interpreter.sha256', 64).toLowerCase()
      if (!isAbsolute(interpreterPathInput) || !/^[a-f0-9]{64}$/u.test(interpreterSha256)) {
        throw new TrustConfigError('invalid-config', 'hostAttestor interpreter binding is invalid')
      }
      const interpreterPath = await realpath(interpreterPathInput)
      if (interpreterPath !== resolve(interpreterPathInput) || firstLine !== `#!${interpreterPath}`) {
        throw new TrustConfigError('invalid-config', 'script attestor must use its exact canonical pinned interpreter without arguments')
      }
      await inspectTrustedExecutable(interpreterPath, interpreterSha256)
      interpreter = Object.freeze({ path: interpreterPath, sha256: interpreterSha256 })
    } else if (item.interpreter !== null) throw new TrustConfigError('invalid-config', 'native hostAttestor must set interpreter to null')
    if (!hostAttestationKeys.some(key => key.authority === authority && key.keyId === keyId)) {
      throw new TrustConfigError('invalid-config', 'hostAttestor signing authority/key is not pre-registered')
    }
    hostAttestor = Object.freeze({ id, version, path: attestorPath, sha256, interpreter,
      environmentAllowlist: environmentAllowlist(item.environmentAllowlist, 'hostAttestor.environmentAllowlist'),
      authority, keyId, timeoutMs: Number(item.timeoutMs) })
  }
  let catalog: PluginControlTrustConfig['catalog'] = Object.freeze({ id: 'legacy-default-catalog', path: join(resolve(dshHomeInput), 'plugin-control', 'catalog.json') })
  let releaseRegistry: PluginControlTrustConfig['releaseRegistry']
  let releaseReceiptTtlMs = 30_000
  let releaseAdapters: PluginControlTrustConfig['releaseAdapters']
  if (root.schemaVersion === 3 || root.schemaVersion === 4) {
    const catalogInput = record(root.catalog, 'catalog'); exactKeys(catalogInput, ['id', 'path'], 'catalog')
    const catalogId = text(catalogInput.id, 'catalog.id', 128); const catalogPathInput = text(catalogInput.path, 'catalog.path', 2_000)
    if (!ID.test(catalogId) || !isAbsolute(catalogPathInput) || await realpath(catalogPathInput) !== resolve(catalogPathInput)) {
      throw new TrustConfigError('invalid-config', 'catalog id/path must identify one canonical owner catalog')
    }
    catalog = Object.freeze({ id: catalogId, path: resolve(catalogPathInput) })
    const registryInput = record(root.releaseRegistry, 'releaseRegistry'); exactKeys(registryInput, ['id', 'locator'], 'releaseRegistry')
    const registryId = text(registryInput.id, 'releaseRegistry.id', 128); const registryLocator = text(registryInput.locator, 'releaseRegistry.locator', 2_000)
    if (!ID.test(registryId)) throw new TrustConfigError('invalid-config', 'releaseRegistry id is invalid')
    releaseRegistry = Object.freeze({ id: registryId, locator: registryLocator })
    if (!Number.isSafeInteger(root.releaseReceiptTtlMs) || Number(root.releaseReceiptTtlMs) < 1_000 || Number(root.releaseReceiptTtlMs) > 300_000) {
      throw new TrustConfigError('invalid-config', 'releaseReceiptTtlMs is outside its accepted range')
    }
    releaseReceiptTtlMs = Number(root.releaseReceiptTtlMs)
    const adapterInput = record(root.releaseAdapters, 'releaseAdapters')
    const phases: readonly SourceReleasePhase[] = ['pr', 'review', 'merge', 'build', 'sign', 'publish', 'registry-verify', 'catalog-admission']
    exactKeys(adapterInput, phases, 'releaseAdapters')
    const parsedAdapters: Partial<Record<SourceReleasePhase, NonNullable<TrustedReleaseAdapter>>> = {}
    for (const phase of phases) if (adapterInput[phase] !== null) parsedAdapters[phase] = await externalAdapter(adapterInput[phase], `releaseAdapters.${phase}`, releaseKeys)
    for (let left = 0; left < phases.length; left += 1) {
      for (let right = left + 1; right < phases.length; right += 1) {
        await independent(parsedAdapters[phases[left]!], parsedAdapters[phases[right]!],
          `${phases[left]} and ${phases[right]} release adapters`, releaseKeys)
      }
    }
    releaseAdapters = Object.freeze(parsedAdapters)
  }
  return Object.freeze({
    schemaVersion: root.schemaVersion,
    installationId,
    dshHome: resolve(dshHomeInput),
    ledger: Object.freeze({ id: ledgerId, path: ledgerPath }),
    executor: Object.freeze({ id: executorId, version: executorVersion, path: executorPath,
      sha256: executorSha256, environmentAllowlist: executorEnvironmentAllowlist }),
    hostPolicy,
    ...(hostAttestor === undefined ? {} : { hostAttestor }),
    catalog,
    ...(releaseRegistry === undefined ? {} : { releaseRegistry }),
    releaseReceiptTtlMs,
    ...(releaseAdapters === undefined ? {} : { releaseAdapters }),
    approvalKeys,
    hostAttestationKeys,
    releaseKeys,
    releaseAuthorizationKeys,
  })
}

export function resolveTrustKey(config: PluginControlTrustConfig, purpose: 'approval' | 'host-attestation' | 'release' | 'release-authorization', authority: string, keyId: string): TrustKey {
  const source = purpose === 'approval' ? config.approvalKeys : purpose === 'host-attestation'
    ? config.hostAttestationKeys : purpose === 'release' ? config.releaseKeys : config.releaseAuthorizationKeys
  const result = source.find(item => item.authority === authority && item.keyId === keyId)
  if (result === undefined) throw new TrustConfigError('invalid-config', `${purpose} authority/key is not pre-registered`)
  return result
}

export function inheritedEnvironment(config: PluginControlTrustConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of config.executor.environmentAllowlist) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  environment.DSH_HOME = config.dshHome
  return environment
}

export function inheritedHostAttestorEnvironment(config: PluginControlTrustConfig): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of config.hostAttestor?.environmentAllowlist ?? []) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

export function inheritedReleaseAdapterEnvironment(config: PluginControlTrustConfig, phase: SourceReleasePhase): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of config.releaseAdapters?.[phase]?.environmentAllowlist ?? []) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}
