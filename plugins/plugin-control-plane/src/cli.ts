import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, lstatSync } from 'node:fs'
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Ed25519ApprovalAuthority, loadPrivateApprovalInput, parseApprovalReceipt } from './approval.js'
import { Ed25519HostAttestationAuthority, parseHostAttestationReceipt } from './attestation.js'
import { invokeConfiguredHostAttestor, prepareConfiguredHostAttestation, prepareManualHostAttestation } from './host-attestor.js'
import { discover, loadCatalogWithMetadata, previewCatalogAdmission, type CatalogPackage } from './catalog.js'
import { verifyApprovedPackagesInLockfile } from './lockfile.js'
import { Ed25519SourcePublishReconciliationAuthority, Ed25519SourceReleaseAuthority, Ed25519SourceReleaseAuthorizationAuthority,
  invokeSourcePublishReconciliationAdapter, invokeSourceReleaseAdapter, parseSourcePublishReconciliationReceipt,
  parseSourceReleaseAuthorization, parseSourceReleaseReceipt } from './release.js'
import { ControlPlaneStore, expectedSourceRelease } from './store.js'
import { inheritedEnvironment, loadTrustConfig, openTrustedExecutable, resolveTrustKey, verifyOpenTrustedExecutable,
  type OpenTrustedExecutable, type PluginControlTrustConfig } from './trust.js'
import type { ApprovalReceipt, HostAttestationReceipt, PlanStatus, PluginActivationPlan, PluginSourcePlan, SourcePublishReconciliationReceipt,
  SourceReleaseAuthorization, SourceReleaseAuthorizationAuthority, SourceReleaseReceipt } from './types.js'

const pluginPattern = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const leaseMs = 30_000
const pluginCatalogScope = 'plugins/README.md'
const maximumActivationArtifactBytes = 268_435_456

export type ControlPlaneCliErrorCode =
  | 'ACTIVATION_BINDING'
  | 'EXECUTOR_FAILED'
  | 'EXECUTOR_OUTPUT_LIMIT'
  | 'EXECUTOR_TIMEOUT'
  | 'FILESYSTEM_STATE'
  | 'HOST_ATTESTATION_REQUIRED'
  | 'HOST_ATTESTOR_NOT_CONFIGURED'
  | 'INVALID_ARGUMENT'
  | 'LOCK_CONFLICT'
  | 'SOURCE_BOUNDARY'

export class ControlPlaneCliError extends Error {
  constructor(readonly code: ControlPlaneCliErrorCode, message: string) {
    super(`plugin-control-plane[${code}]: ${message}`)
    this.name = 'ControlPlaneCliError'
  }
}

function option(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name); const value = index === -1 ? undefined : argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new ControlPlaneCliError('INVALID_ARGUMENT', `${name} is required`)
  return value
}

function optionalOption(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name); if (index === -1) return undefined
  const value = argv[index + 1]; if (value === undefined || value.startsWith('--')) throw new ControlPlaneCliError('INVALID_ARGUMENT', `${name} requires a value`)
  return value
}

function integerOption(argv: readonly string[], name: string): number {
  const result = Number(option(argv, name))
  if (!Number.isSafeInteger(result) || result < 1) throw new ControlPlaneCliError('INVALID_ARGUMENT', `${name} must be a positive integer`)
  return result
}

function defaultDshHome(): string {
  const value = process.env.DSH_HOME ?? join(process.env.HOME ?? '', '.dsh')
  if (!isAbsolute(value)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'DSH_HOME must be absolute')
  return resolve(value)
}

function defaultCatalogPath(): string { return join(defaultDshHome(), 'plugin-control', 'catalog.json') }
function defaultTrustPath(dshHome = defaultDshHome()): string { return join(dshHome, 'plugin-control', 'trust.json') }

function rejectCommandSuppliedTrust(argv: readonly string[]): void {
  const forbidden = ['--trust', '--approval-public-key', '--authority', '--key-id', '--state', '--dsh-home', '--attestor',
    '--attestor-path', '--credential', '--password', '--private-key', '--registry-token', '--signing-key', '--token']
  if (forbidden.some(name => argv.includes(name))) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'command-supplied trust roots or ledgers are forbidden')
  }
}

async function commandTrust(argv: readonly string[]): Promise<PluginControlTrustConfig> {
  rejectCommandSuppliedTrust(argv)
  return loadTrustConfig(defaultTrustPath())
}

function exactPackages(plan: PluginActivationPlan): CatalogPackage[] { return [...plan.dossier.packages] }

function localArtifactReference(item: CatalogPackage): string | undefined {
  if (item.registry === undefined) return undefined
  try { return new URL(item.registry.reference).protocol === 'file:' ? item.registry.reference : undefined } catch { return undefined }
}

async function assertDirectory(path: string, allowMissing = false): Promise<void> {
  try {
    const value = await lstat(path)
    if (!value.isDirectory() || value.isSymbolicLink() || await realpath(path) !== resolve(path)) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'activation directory is not canonical')
  } catch (error) {
    if (allowMissing && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try { await assertDirectory(path); return true } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function readSafeFile(path: string, maximum: number): Promise<string> {
  const value = await lstat(path)
  const uid = process.getuid?.()
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || value.size > maximum
    || (uid !== undefined && value.uid !== uid && value.uid !== 0) || await realpath(path) !== resolve(path)) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', 'input must be one bounded trusted regular file')
  }
  return readFile(path, 'utf8')
}

async function readOwnerPrivateFile(path: string, maximum: number): Promise<string> {
  const value = await lstat(path); const uid = process.getuid?.()
  if (!value.isFile() || value.isSymbolicLink() || value.nlink !== 1 || (value.mode & 0o077) !== 0
    || (uid !== undefined && value.uid !== uid) || await realpath(path) !== resolve(path)) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release input must be one canonical owner-private regular file')
  }
  const source = await readFile(path, 'utf8')
  if (Buffer.byteLength(source) > maximum) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release input exceeds its size bound')
  return source
}

interface ProfileLock { path: string; handle: FileHandle; payload: string; device: bigint; inode: bigint }

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true
  try { process.kill(pid, 0); return true } catch (error) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH')
  }
}

async function acquireProfileLock(store: ControlPlaneStore, plan: PluginActivationPlan): Promise<ProfileLock> {
  if (plan.activation === undefined) throw new ControlPlaneCliError('LOCK_CONFLICT', 'activation has no fence')
  const lockPath = join(plan.target.dshHome, 'profiles', `.plugin-control-${plan.target.profile}.lock`)
  const payload = `${JSON.stringify({ schemaVersion: 1, planId: plan.id, activationId: plan.activation.id,
    fence: plan.activation.fence, pid: process.pid, nonce: randomUUID() })}\n`
  const create = async (): Promise<ProfileLock> => {
    const handle = await open(lockPath, 'wx', 0o600)
    try {
      await handle.writeFile(payload, 'utf8'); await handle.sync()
      const metadata = await handle.stat({ bigint: true })
      return { path: lockPath, handle, payload, device: metadata.dev, inode: metadata.ino }
    } catch (error) { await handle.close(); await rm(lockPath, { force: true }); throw error }
  }
  return store.withActivationFileSystemGuard({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation.fence, status: plan.status, leaseMs }, async () => {
    try { return await create() } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error
      const metadata = await lstat(lockPath, { bigint: true }); const uid = process.getuid?.()
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || (metadata.mode & 0o077n) !== 0n
        || (uid !== undefined && metadata.uid !== BigInt(uid))) throw new ControlPlaneCliError('LOCK_CONFLICT', 'profile lock is unsafe')
      let old: unknown
      try { old = JSON.parse(await readFile(lockPath, 'utf8')) as unknown } catch { throw new ControlPlaneCliError('LOCK_CONFLICT', 'profile lock is corrupt') }
      const pid = typeof old === 'object' && old !== null && 'pid' in old ? Number(old.pid) : Number.NaN
      if (!Number.isSafeInteger(pid) || processIsAlive(pid)) throw new ControlPlaneCliError('LOCK_CONFLICT', 'profile lock owner may still be executing')
      const stale = `${lockPath}.stale-${randomUUID()}`
      await rename(lockPath, stale)
      const moved = await lstat(stale, { bigint: true })
      if (moved.dev !== metadata.dev || moved.ino !== metadata.ino) throw new ControlPlaneCliError('LOCK_CONFLICT', 'profile lock identity changed during stale recovery')
      try { return await create() } finally { await rm(stale, { force: true }) }
    }
  })
}

async function releaseProfileLock(store: ControlPlaneStore, lock: ProfileLock): Promise<void> {
  try {
    await store.withExclusiveWrite(async () => {
      const current = await lstat(lock.path, { bigint: true })
      const held = await lock.handle.stat({ bigint: true })
      if (current.dev !== held.dev || current.ino !== held.ino || current.dev !== lock.device || current.ino !== lock.inode
        || current.nlink !== 1n || await readFile(lock.path, 'utf8') !== lock.payload) {
        throw new ControlPlaneCliError('LOCK_CONFLICT', 'profile lock identity changed before release')
      }
      await rm(lock.path)
    })
  } finally { await lock.handle.close() }
}

function assertPlanTrust(plan: PluginActivationPlan, trust: PluginControlTrustConfig): void {
  if (plan.installationId !== trust.installationId || plan.target.dshHome !== trust.dshHome
    || plan.executor.id !== trust.executor.id || plan.executor.version !== trust.executor.version
    || plan.executor.path !== trust.executor.path || plan.executor.sha256 !== trust.executor.sha256
    || plan.ledger.id !== trust.ledger.id || plan.ledger.path !== trust.ledger.path
    || plan.target.profilePath !== join(trust.dshHome, 'profiles', plan.profile)) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'plan does not match the registered installation, ledger, target, and executor')
  }
}

async function openCurrentTrustedExecutable(path: string, trustedRunningNode: boolean): Promise<OpenTrustedExecutable> {
  const canonical = await realpath(path); const metadata = await lstat(canonical)
  if (!metadata.isFile() || metadata.size > maximumActivationArtifactBytes) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor interpreter is not a bounded regular file')
  }
  if (!trustedRunningNode && metadata.uid !== 0) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor interpreter must be root-owned')
  }
  const expectedSha256 = createHash('sha256').update(await readFile(canonical)).digest('hex')
  const executable = await openTrustedExecutable(canonical, expectedSha256)
  if (trustedRunningNode) {
    const running = await stat('/proc/self/exe', { bigint: true })
    if (executable.snapshot.device !== running.dev || executable.snapshot.inode !== running.ino) {
      await executable.handle.close()
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor Node interpreter is not the running trusted runtime')
    }
  }
  return executable
}

async function verifyPinnedDescriptor(value: OpenTrustedExecutable): Promise<void> {
  const metadata = await value.handle.stat({ bigint: true })
  if (!metadata.isFile() || metadata.nlink > 1n || metadata.dev !== value.snapshot.device || metadata.ino !== value.snapshot.inode
    || metadata.size > BigInt(maximumActivationArtifactBytes) || (metadata.mode & 0o111n) === 0n || (metadata.mode & 0o022n) !== 0n) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executable descriptor changed while a command was running')
  }
  const bytes = Buffer.alloc(Number(metadata.size)); let offset = 0
  while (offset < bytes.length) {
    const result = await value.handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  if (offset !== bytes.length || createHash('sha256').update(bytes).digest('hex') !== value.snapshot.sha256) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executable descriptor bytes changed while a command was running')
  }
}

async function executorInterpreter(executable: OpenTrustedExecutable): Promise<{
  executable: OpenTrustedExecutable; arguments: readonly string[]
} | undefined> {
  const prefix = Buffer.alloc(512); const { bytesRead } = await executable.handle.read(prefix, 0, prefix.length, 0)
  const line = prefix.subarray(0, bytesRead).toString('utf8').split('\n', 1)[0] ?? ''
  if (!line.startsWith('#!')) return undefined
  const declaration = line.slice(2).trim()
  const separator = declaration.search(/\s/u)
  let path = separator === -1 ? declaration : declaration.slice(0, separator)
  let argument = separator === -1 ? undefined : declaration.slice(separator).trim()
  if (!isAbsolute(path) || path.includes('\0') || argument?.includes('\0')) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor has an unsupported interpreter declaration')
  }
  if (path === '/usr/bin/env') {
    if (argument === 'node') path = process.execPath
    else if (argument === 'bash') path = '/usr/bin/bash'
    else throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor env interpreter is unsupported')
    argument = undefined
  } else {
    path = await realpath(path)
  }
  const interpreter = await openCurrentTrustedExecutable(path, path === process.execPath)
  const interpreterPrefix = Buffer.alloc(2); const current = await interpreter.handle.read(interpreterPrefix, 0, 2, 0)
  if (current.bytesRead === 2 && interpreterPrefix.toString('utf8') === '#!') {
    await interpreter.handle.close()
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor interpreter must be a native executable')
  }
  return { executable: interpreter, arguments: argument === undefined ? [] : [argument] }
}

async function runBounded(input: { executable: string; args: readonly string[]; cwd?: string; environment: NodeJS.ProcessEnv;
  store?: ControlPlaneStore; plan?: PluginActivationPlan; capture?: boolean; maximumOutput?: number;
  pinnedExecutable?: OpenTrustedExecutable; pinnedInterpreter?: Awaited<ReturnType<typeof executorInterpreter>> }): Promise<string> {
  const execute = async (): Promise<string> => {
    const ownedExecutable = input.plan === undefined || input.pinnedExecutable !== undefined ? undefined
      : await openTrustedExecutable(input.executable, input.plan.executor.sha256)
    const executable = input.pinnedExecutable ?? ownedExecutable
    let interpreter = input.pinnedInterpreter
    let result = ''
    let failure: unknown
    try {
      if (executable !== undefined && interpreter === undefined) interpreter = await executorInterpreter(executable)
      result = await new Promise((resolvePromise, reject) => {
        let command = input.executable
        let stdio: Array<'ignore' | 'pipe' | number> = ['ignore', 'pipe', 'ignore']
        if (executable !== undefined) {
          assertDescriptorFileSystem('registered executor')
          const executableFd = stdio.length
          stdio = [...stdio, executable.handle.fd]
          if (interpreter === undefined) command = `/proc/self/fd/${executableFd}`
          else {
            const interpreterFd = stdio.length
            stdio = [...stdio, interpreter.executable.handle.fd]
            command = `/proc/self/fd/${interpreterFd}`
          }
        }
        let commandArguments = [...input.args]
        if (executable !== undefined && interpreter !== undefined) {
          commandArguments = [...interpreter.arguments, `/proc/self/fd/${3}`, ...commandArguments]
        }
        const child = spawn(command, commandArguments, { cwd: input.cwd, env: input.environment, stdio, shell: false })
        const chunks: Buffer[] = []; let bytes = 0; let outputLimit = false; let timedOut = false
        child.stdout!.on('data', (chunk: Buffer) => {
          if (!input.capture) return
          bytes += chunk.length
          if (bytes > (input.maximumOutput ?? 65_536)) { outputLimit = true; child.kill('SIGKILL') } else chunks.push(chunk)
        })
        const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 60_000)
        child.once('error', () => { clearTimeout(timeout); reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'registered executor could not start')) })
        child.once('close', code => {
          clearTimeout(timeout)
          if (timedOut) reject(new ControlPlaneCliError('EXECUTOR_TIMEOUT', 'registered executor exceeded its deadline'))
          else if (outputLimit) reject(new ControlPlaneCliError('EXECUTOR_OUTPUT_LIMIT', 'registered executor exceeded its output bound'))
          else if (code !== 0) reject(new ControlPlaneCliError('EXECUTOR_FAILED', 'registered executor returned a non-zero status'))
          else resolvePromise(input.capture ? Buffer.concat(chunks).toString('utf8') : '')
        })
      })
    } catch (error) { failure = error }
    try {
      if (executable !== undefined) await verifyPinnedDescriptor(executable)
      if (interpreter !== undefined) await verifyOpenTrustedExecutable(interpreter.executable)
    } catch {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor changed while a command was running')
    } finally {
      if (input.pinnedInterpreter === undefined && interpreter !== undefined) await interpreter.executable.handle.close()
      await ownedExecutable?.handle.close()
    }
    if (failure !== undefined) throw failure
    return result
  }
  return input.store !== undefined && input.plan !== undefined
    ? input.store.withActivationFileSystemGuard({ planId: input.plan.id, expectedRevision: input.plan.revision,
      fence: input.plan.activation!.fence, status: input.plan.status, leaseMs }, execute)
    : execute()
}

function assertDescriptorFileSystem(label: string): void {
  if (process.platform !== 'linux') throw new ControlPlaneCliError('ACTIVATION_BINDING', `${label} requires Linux descriptor pinning`)
  try {
    const metadata = lstatSync('/proc/self/fd')
    if (!metadata.isDirectory()) throw new Error('not a directory')
  } catch { throw new ControlPlaneCliError('ACTIVATION_BINDING', `${label} requires /proc/self/fd`) }
}

function paths(plan: PluginActivationPlan): { stageProfile: string; stagePath: string; backupPath: string } {
  if (plan.activation === undefined) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation identity is missing')
  const suffix = plan.activation.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
  const stageProfile = `stage-${suffix}`
  return { stageProfile, stagePath: join(plan.target.dshHome, 'profiles', stageProfile),
    backupPath: join(plan.target.dshHome, 'profiles', `.${plan.profile}.plugin-backup-${suffix}`) }
}

interface ActivationArtifactSnapshot {
  package: CatalogPackage
  handle: FileHandle
  path: string
  device: bigint
  inode: bigint
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  sha512: Buffer
}

function within(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
  try { await directory.sync() } finally { await directory.close() }
}

function descriptorReference(handle: FileHandle): string {
  assertDescriptorFileSystem('local artifact activation')
  return `/proc/${process.pid}/fd/${handle.fd}`
}

async function verifyActivationArtifactSnapshot(snapshot: ActivationArtifactSnapshot): Promise<void> {
  const before = await snapshot.handle.stat({ bigint: true })
  if (!before.isFile() || before.nlink > 1n || before.dev !== snapshot.device || before.ino !== snapshot.inode
    || before.size !== snapshot.size || before.mtimeNs !== snapshot.mtimeNs || (before.mode & 0o222n) !== 0n) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation artifact changed while the executor was reading it')
  }
  const bytes = Buffer.alloc(Number(snapshot.size)); let offset = 0
  while (offset < bytes.length) {
    const result = await snapshot.handle.read(bytes, offset, bytes.length - offset, offset)
    if (result.bytesRead === 0) break
    offset += result.bytesRead
  }
  const after = await snapshot.handle.stat({ bigint: true })
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeNs !== before.mtimeNs
    || after.ctimeNs !== before.ctimeNs || after.mode !== before.mode || after.nlink !== before.nlink || BigInt(offset) !== snapshot.size
    || !createHash('sha512').update(bytes).digest().equals(snapshot.sha512)) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation artifact bytes changed while the executor was reading them')
  }
}

async function closeActivationArtifactSnapshots(snapshots: readonly ActivationArtifactSnapshot[]): Promise<void> {
  await Promise.all(snapshots.map(async snapshot => snapshot.handle.close()))
}

async function snapshotLocalArtifact(plan: PluginActivationPlan, item: CatalogPackage): Promise<ActivationArtifactSnapshot> {
  const registry = item.registry
  if (registry === undefined) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact registry binding is missing')
  let sourcePath: string
  let registryRoot: string
  try { sourcePath = fileURLToPath(registry.reference); registryRoot = fileURLToPath(registry.locator) } catch {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact reference must be a canonical file URL')
  }
  if (pathToFileURL(sourcePath).href !== registry.reference || pathToFileURL(registryRoot).href !== registry.locator
    || !isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath || !isAbsolute(registryRoot) || resolve(registryRoot) !== registryRoot
    || !within(registryRoot, sourcePath)) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact escapes its bound registry')
  }
  const handle = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const before = await handle.stat({ bigint: true }); const uid = process.getuid?.()
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximumActivationArtifactBytes)
      || (before.mode & 0o022n) !== 0n || (uid !== undefined && before.uid !== BigInt(uid) && before.uid !== 0n)) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact is not one bounded non-writable regular file')
    }
    const parentPath = dirname(sourcePath); const canonicalParent = await realpath(parentPath); const parent = await lstat(parentPath)
    if (canonicalParent !== parentPath || !parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) !== 0
      || (uid !== undefined && parent.uid !== uid && parent.uid !== 0)) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact parent directory is not trusted')
    }
    bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true }); const pathAfter = await lstat(sourcePath, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino
      || BigInt(bytes.length) !== before.size) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact changed during verification')
  } finally { await handle.close() }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== item.integrity) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'local artifact bytes do not match the approved integrity')
  const cacheRoot = join(plan.target.dshHome, 'plugin-control', 'activation-artifacts')
  await mkdir(cacheRoot, { recursive: true, mode: 0o700 }); await assertDirectory(cacheRoot)
  const cacheMetadata = await lstat(cacheRoot); const uid = process.getuid?.()
  if ((cacheMetadata.mode & 0o077) !== 0 || (uid !== undefined && cacheMetadata.uid !== uid)) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', 'activation artifact cache is not owner-private')
  }
  const activationId = plan.activation?.id
  if (activationId === undefined) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation identity is missing')
  const activationDirectory = join(cacheRoot, activationId.replace(/[^A-Za-z0-9-]/gu, ''))
  try { await mkdir(activationDirectory, { mode: 0o700 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await assertDirectory(activationDirectory)
  const directoryMetadata = await lstat(activationDirectory)
  if ((directoryMetadata.mode & 0o077) !== 0 || (uid !== undefined && directoryMetadata.uid !== uid)) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', 'activation artifact directory is not owner-private')
  }
  const destination = join(activationDirectory, `${createHash('sha256').update(item.package).digest('hex')}.tgz`)
  let output: FileHandle | undefined
  try {
    output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o400)
    await output.writeFile(bytes); await output.sync(); await output.close(); output = undefined
    await syncDirectory(activationDirectory); await syncDirectory(cacheRoot)
  } catch (error) {
    await output?.close().catch(() => undefined)
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') { await rm(destination, { force: true }); throw error }
    const existing = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const metadata = await existing.stat(); const current = await existing.readFile()
      if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o222) !== 0 || current.length !== bytes.length
        || !createHash('sha512').update(current).digest().equals(createHash('sha512').update(bytes).digest())) {
        throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation artifact cache conflicts with the approved bytes')
      }
    } finally { await existing.close() }
  }
  const pinned = await open(destination, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  try {
    const metadata = await pinned.stat({ bigint: true }); const current = await pinned.readFile()
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size !== BigInt(bytes.length) || (metadata.mode & 0o222n) !== 0n
      || !createHash('sha512').update(current).digest().equals(createHash('sha512').update(bytes).digest())) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation artifact cache does not retain the approved bytes')
    }
    const reference = pathToFileURL(descriptorReference(pinned)).href
    return { package: { ...item, registry: { ...registry, reference } }, handle: pinned, path: destination, device: metadata.dev,
      inode: metadata.ino, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
      sha512: createHash('sha512').update(current).digest() }
  } catch (error) { await pinned.close(); throw error }
}

async function activationPackages(plan: PluginActivationPlan): Promise<{ packages: CatalogPackage[]; snapshots: ActivationArtifactSnapshot[] }> {
  const snapshots: ActivationArtifactSnapshot[] = []
  try {
    for (const item of exactPackages(plan)) {
      if (localArtifactReference(item) !== undefined) snapshots.push(await snapshotLocalArtifact(plan, item))
    }
    const byPackage = new Map(snapshots.map(snapshot => [snapshot.package.package, snapshot]))
    return { packages: exactPackages(plan).map(item => byPackage.get(item.package)?.package ?? item), snapshots }
  } catch (error) { await closeActivationArtifactSnapshots(snapshots); throw error }
}

function installSpec(item: CatalogPackage): string {
  return localArtifactReference(item) ?? `${item.package}@${item.version}`
}

async function verifyInstalledPackages(profilePath: string, packages: readonly CatalogPackage[]): Promise<void> {
  for (const item of packages) {
    const manifestPath = join(profilePath, 'node_modules', ...item.package.split('/'), 'package.json')
    let raw: unknown
    try {
      const canonical = await realpath(manifestPath)
      const modulesRoot = join(profilePath, 'node_modules')
      if (!within(modulesRoot, canonical)) throw new Error('manifest escapes node_modules')
      const handle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const before = await handle.stat({ bigint: true }); const uid = process.getuid?.()
        if (!before.isFile() || before.size < 1n || before.size > 1_048_576n || (before.mode & 0o022n) !== 0n
          || (uid !== undefined && before.uid !== BigInt(uid) && before.uid !== 0n)) throw new Error('manifest is unsafe')
        const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size) throw new Error('manifest changed')
        raw = JSON.parse(bytes.toString('utf8')) as unknown
      } finally { await handle.close() }
    } catch {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', `installed package ${item.package} has no trusted manifest`)
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || !('name' in raw) || !('version' in raw)
      || raw.name !== item.package || raw.version !== item.version) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', `installed package ${item.package} has the wrong name or version`)
    }
  }
}

async function fencedMutation<T>(store: ControlPlaneStore, plan: PluginActivationPlan, action: () => Promise<T>): Promise<T> {
  return store.withActivationFileSystemGuard({ planId: plan.id, expectedRevision: plan.revision,
    fence: plan.activation!.fence, status: plan.status, leaseMs }, action)
}

async function restoreTarget(store: ControlPlaneStore, plan: PluginActivationPlan, backupPath: string): Promise<void> {
  const originallyExisted = plan.activation?.targetOriginallyExisted
  if (originallyExisted === undefined) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'activation target baseline is missing')
  const backupExists = await directoryExists(backupPath)
  const targetExists = await directoryExists(plan.target.profilePath)
  if (originallyExisted) {
    if (backupExists) {
      await fencedMutation(store, plan, async () => {
        await rm(plan.target.profilePath, { recursive: true, force: true })
        await rename(backupPath, plan.target.profilePath)
      })
    } else if (!targetExists) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'original target and its backup are both missing')
  } else {
    if (backupExists) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'a backup exists for a target recorded as originally absent')
    if (targetExists) await fencedMutation(store, plan, () => rm(plan.target.profilePath, { recursive: true, force: true }))
  }
}

function advance(store: ControlPlaneStore, plan: PluginActivationPlan, to: PlanStatus, failureCode?: string): PluginActivationPlan {
  return store.advanceActivation({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence,
    from: plan.status, to, ...(failureCode === undefined ? {} : { failureCode }) })
}

async function finishRollback(store: ControlPlaneStore, plan: PluginActivationPlan, lock: ProfileLock): Promise<PluginActivationPlan> {
  const activationPaths = paths(plan)
  await restoreTarget(store, plan, activationPaths.backupPath)
  await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
  const terminal = advance(store, plan, 'rolled-back')
  await releaseProfileLock(store, lock)
  return terminal
}

async function approve(argv: readonly string[]): Promise<void> {
  if (argv.includes('--approved-by')) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'approval trust roots cannot be supplied by the approving command')
  }
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const receipt = parseApprovalReceipt(JSON.parse(await loadPrivateApprovalInput(resolve(option(argv, '--approval-receipt')), 32_768)) as unknown)
    const kind = option(argv, '--kind')
    const common = { planId: option(argv, '--plan-id'), expectedRevision: integerOption(argv, '--expected-revision'), receipt,
      resolveAuthority: (value: typeof receipt) => { const key = resolveTrustKey(trust, 'approval', value.authority, value.keyId); return new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId) },
      idempotencyKey: `approval:${receipt.approvalId}` }
    const result = kind === 'activation' ? await store.approve(common) : kind === 'source' ? await store.approveSource(common)
      : (() => { throw new ControlPlaneCliError('INVALID_ARGUMENT', '--kind must be activation or source') })()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { store.close() }
}

function activationApprovalAuthority(trust: PluginControlTrustConfig, receipt: ApprovalReceipt): Ed25519ApprovalAuthority {
  const key = resolveTrustKey(trust, 'approval', receipt.authority, receipt.keyId)
  return new Ed25519ApprovalAuthority(key.publicKeyPem, key.authority, key.keyId, () => receipt.decidedAt)
}

async function activate(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  let lock: ProfileLock | undefined
  try {
    let plan = store.getPlan(option(argv, '--plan-id')); assertPlanTrust(plan, trust)
    if (plan.status === 'activated') { process.stdout.write(`${JSON.stringify(plan)}\n`); return }
    plan = await store.claimActivation({ planId: plan.id, expectedRevision: integerOption(argv, '--expected-revision'), leaseMs,
      resolveApprovalAuthority: receipt => activationApprovalAuthority(trust, receipt) })
    lock = await acquireProfileLock(store, plan)
    const activationPaths = paths(plan)
    if (plan.status === 'rollback-pending') { process.stdout.write(`${JSON.stringify(await finishRollback(store, plan, lock))}\n`); lock = undefined; return }
    if (plan.status === 'commit-pending') {
      await fencedMutation(store, plan, () => rm(activationPaths.backupPath, { recursive: true, force: true }))
      await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
      process.stdout.write(`${JSON.stringify(advance(store, plan, 'activated'))}\n`); return
    }
    if (plan.status !== 'staging') throw new ControlPlaneCliError('HOST_ATTESTATION_REQUIRED', 'activation is awaiting a signed Host attestation')
    await assertDirectory(trust.dshHome); await assertDirectory(join(trust.dshHome, 'profiles')); await assertDirectory(plan.target.profilePath, true)
    const environment = inheritedEnvironment(trust)
    try {
      if (plan.activation?.targetOriginallyExisted === undefined) {
        if (await directoryExists(activationPaths.backupPath) || await directoryExists(activationPaths.stagePath)) {
          throw new ControlPlaneCliError('FILESYSTEM_STATE', 'unbound activation residue requires owner recovery')
        }
        plan = store.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision,
          fence: plan.activation!.fence, existed: await directoryExists(plan.target.profilePath) })
      }
      await restoreTarget(store, plan, activationPaths.backupPath)
      await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
      if (plan.activation!.targetOriginallyExisted) {
        await stat(plan.target.profilePath)
        await fencedMutation(store, plan, () => cp(plan.target.profilePath, activationPaths.stagePath, { recursive: true, force: false, errorOnExist: true }))
      }
      const activationArtifacts = await fencedMutation(store, plan, () => activationPackages(plan))
      let pinnedExecutor: OpenTrustedExecutable | undefined
      let pinnedInterpreter: Awaited<ReturnType<typeof executorInterpreter>>
      try {
        pinnedExecutor = await openTrustedExecutable(trust.executor.path, plan.executor.sha256)
        pinnedInterpreter = await executorInterpreter(pinnedExecutor)
        const executor = { pinnedExecutable: pinnedExecutor, pinnedInterpreter }
        const version = (await runBounded({ executable: trust.executor.path, args: ['--version'], environment, store, plan, capture: true, ...executor })).trim()
        if (version !== plan.candidate.dshBaseline) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor baseline differs from the approved dossier')
        await runBounded({ executable: trust.executor.path, args: ['plugin', '--profile', activationPaths.stageProfile, 'add',
          ...activationArtifacts.packages.map(installSpec)], environment, store, plan, ...executor })
        await Promise.all(activationArtifacts.snapshots.map(verifyActivationArtifactSnapshot))
        const lockfileSource = await readSafeFile(join(activationPaths.stagePath, 'pnpm-lock.yaml'), 8 * 1024 * 1024)
        verifyApprovedPackagesInLockfile(lockfileSource, activationArtifacts.packages, activationPaths.stagePath)
        await verifyInstalledPackages(activationPaths.stagePath, activationArtifacts.packages)
        // Configuration materialization is a staging integrity check only. It is
        // deliberately not called readiness, reload, shadow, canary or health.
        await runBounded({ executable: trust.executor.path, args: ['--profile', activationPaths.stageProfile, '--dump-config'],
          environment, store, plan, ...executor })
      } finally {
        await closeActivationArtifactSnapshots(activationArtifacts.snapshots)
        if (pinnedInterpreter !== undefined) await pinnedInterpreter.executable.handle.close()
        await pinnedExecutor?.handle.close()
      }
      if (plan.activation!.targetOriginallyExisted) await fencedMutation(store, plan, () => rename(plan.target.profilePath, activationPaths.backupPath))
      await fencedMutation(store, plan, () => rename(activationPaths.stagePath, plan.target.profilePath))
      plan = advance(store, plan, 'awaiting-reload')
      process.stdout.write(`${JSON.stringify(plan)}\n`)
    } catch (error) {
      plan = advance(store, plan, 'rollback-pending', error instanceof ControlPlaneCliError ? error.code.toLowerCase().replaceAll('_', '-') : 'activation-failed')
      await finishRollback(store, plan, lock); lock = undefined
      throw error
    }
  } finally { if (lock !== undefined) await releaseProfileLock(store, lock); store.close() }
}

async function attest(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  let lock: ProfileLock | undefined
  try {
    const receipt = parseHostAttestationReceipt(JSON.parse(await loadPrivateApprovalInput(resolve(option(argv, '--receipt')), 32_768)) as unknown)
    const planId = option(argv, '--plan-id'); const expectedRevision = integerOption(argv, '--expected-revision')
    const expectedFence = integerOption(argv, '--expected-fence'); const initial = store.getPlan(planId); assertPlanTrust(initial, trust)
    const resolveAuthority = (value: typeof receipt): Ed25519HostAttestationAuthority => {
      const key = resolveTrustKey(trust, 'host-attestation', value.authority, value.keyId)
      return new Ed25519HostAttestationAuthority(key.publicKeyPem, key.authority, key.keyId)
    }
    await store.runHostAttestationOperation({ operationId: receipt.operationId, expectedRevision, expectedFence,
      execute: async () => receipt, resolveAuthority })
    const result = await store.applyHostAttestation({ planId, expectedRevision, expectedFence, receipt,
      idempotencyKey: `host-attestation:${receipt.operationId}`, resolveAuthority })
    let plan = store.getPlan(result.result.id); assertPlanTrust(plan, trust)
    if (plan.status === 'rollback-pending' || plan.status === 'commit-pending') {
      plan = await store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs,
        resolveApprovalAuthority: receipt => activationApprovalAuthority(trust, receipt) }); lock = await acquireProfileLock(store, plan)
      if (plan.status === 'rollback-pending') { plan = await finishRollback(store, plan, lock); lock = undefined }
      else {
        const activationPaths = paths(plan)
        await fencedMutation(store, plan, () => rm(activationPaths.backupPath, { recursive: true, force: true }))
        await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
        plan = advance(store, plan, 'activated')
      }
    }
    process.stdout.write(`${JSON.stringify({ ...result, result: plan })}\n`)
  } finally { if (lock !== undefined) await releaseProfileLock(store, lock); store.close() }
}

async function hostRequest(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const plan = store.getPlan(option(argv, '--plan-id')); assertPlanTrust(plan, trust)
    if (plan.revision !== integerOption(argv, '--expected-revision') || plan.activation?.fence !== integerOption(argv, '--expected-fence')) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'manual Host request targets a stale revision/fence')
    }
    process.stdout.write(`${JSON.stringify(prepareManualHostAttestation(store, plan, trust).request)}\n`)
  } finally { store.close() }
}

async function probe(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  if (trust.hostAttestor === undefined) throw new ControlPlaneCliError('HOST_ATTESTOR_NOT_CONFIGURED', 'deployment has no owner-configured Host attestor; activation remains awaiting its current phase')
  const store = new ControlPlaneStore({ path: trust.ledger.path }); let lock: ProfileLock | undefined
  try {
    const plan = store.getPlan(option(argv, '--plan-id')); assertPlanTrust(plan, trust)
    const expectedRevision = integerOption(argv, '--expected-revision'); const expectedFence = integerOption(argv, '--expected-fence')
    if (plan.revision !== expectedRevision || plan.activation?.fence !== expectedFence) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'configured Host probe targets a stale revision/fence')
    }
    const operation = prepareConfiguredHostAttestation(store, plan, trust)
    const resolveAuthority = (value: HostAttestationReceipt): Ed25519HostAttestationAuthority => {
      const key = resolveTrustKey(trust, 'host-attestation', value.authority, value.keyId)
      return new Ed25519HostAttestationAuthority(key.publicKeyPem, key.authority, key.keyId)
    }
    const receipt = await store.runHostAttestationOperation({ operationId: operation.operationId, expectedRevision, expectedFence,
      execute: request => invokeConfiguredHostAttestor(trust, request), resolveAuthority })
    const result = await store.applyHostAttestation({ planId: plan.id, expectedRevision, expectedFence, receipt,
      idempotencyKey: `host-attestation:${operation.operationId}`, resolveAuthority })
    let output = result.result
    if (output.status === 'rollback-pending' || output.status === 'commit-pending') {
      output = await store.claimActivation({ planId: output.id, expectedRevision: output.revision, leaseMs,
        resolveApprovalAuthority: receipt => activationApprovalAuthority(trust, receipt) }); lock = await acquireProfileLock(store, output)
      if (output.status === 'rollback-pending') { output = await finishRollback(store, output, lock); lock = undefined }
      else {
        const activationPaths = paths(output)
        await fencedMutation(store, output, () => rm(activationPaths.backupPath, { recursive: true, force: true }))
        await fencedMutation(store, output, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
        output = advance(store, output, 'activated')
      }
    }
    process.stdout.write(`${JSON.stringify({ ...result, result: output })}\n`)
  } finally { if (lock !== undefined) await releaseProfileLock(store, lock); store.close() }
}

async function executable(command: 'git' | 'pnpm', environment: NodeJS.ProcessEnv): Promise<string> {
  const candidates = command === 'git' ? ['/usr/bin/git', '/bin/git'] : [join(dirname(process.execPath), 'pnpm'),
    ...(environment.PATH ?? '').split(delimiter).filter(isAbsolute).map(directory => join(directory, 'pnpm'))]
  const uid = process.getuid?.()
  for (const candidate of candidates) {
    try {
      const canonical = await realpath(candidate); const value = await lstat(canonical); const directory = await lstat(dirname(canonical))
      if (value.isFile() && !value.isSymbolicLink() && (value.mode & 0o111) !== 0 && (value.mode & 0o022) === 0
        && (uid === undefined || value.uid === 0 || value.uid === uid) && directory.isDirectory() && (directory.mode & 0o002) === 0) return canonical
    } catch { /* next */ }
  }
  throw new ControlPlaneCliError('SOURCE_BOUNDARY', `registered local ${command} executable is unavailable`)
}

async function localCommand(command: 'git' | 'pnpm', args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, capture = false, maximumOutput?: number): Promise<string> {
  return runBounded({ executable: await executable(command, environment), args, cwd, environment, capture,
    ...(maximumOutput === undefined ? {} : { maximumOutput }) })
}

function sourceScope(name: string): readonly string[] { return [pluginCatalogScope, `plugins/${name}`].sort() }

function assertExactSourceScope(plan: PluginSourcePlan): void {
  const expected = sourceScope(plan.name)
  if (plan.scope.length !== expected.length || plan.scope.some((value, index) => value !== expected[index])) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan scope does not match the exact generator outputs')
  }
}

async function changedSourcePaths(worktree: string, baseCommit: string, environment: NodeJS.ProcessEnv): Promise<readonly string[]> {
  const tracked = await localCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--no-renames',
    '--name-only', '-z', baseCommit, '--'], worktree, environment, true, 8_388_608)
  const untracked = await localCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--others',
    '--exclude-standard', '-z'], worktree, environment, true, 8_388_608)
  return [...new Set(`${tracked}${untracked}`.split('\0').filter(Boolean))].sort()
}

function sourcePathAllowed(path: string, plan: PluginSourcePlan): boolean {
  const pluginRoot = `plugins/${plan.name}`
  return path === pluginCatalogScope || path === pluginRoot || path.startsWith(`${pluginRoot}/`)
}

export async function checkedSourceSnapshot(worktree: string, baseCommit: string, scopeInput: readonly string[], environment: NodeJS.ProcessEnv): Promise<{
  checkedTreeDigest: string; checkedPatchDigest: string
}> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-plugin-control-index-'))
  try {
    const scope = [...new Set(scopeInput.map(value => value.normalize('NFC').trim()))].sort()
    if (scope.length === 0 || scope.some(value => value === '')) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'checked source scope is invalid')
    const snapshotEnvironment = { ...environment, GIT_INDEX_FILE: join(temporary, 'index') }
    await localCommand('git', ['read-tree', baseCommit], worktree, snapshotEnvironment)
    await localCommand('git', ['--literal-pathspecs', 'add', '--all', '--', ...scope], worktree, snapshotEnvironment)
    const tree = await localCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'ls-files', '--stage', '-z',
      '--', ...scope], worktree, snapshotEnvironment, true, 8_388_608)
    const patch = await localCommand('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', 'diff', '--cached', '--binary',
      '--full-index', '--no-color', baseCommit, '--', ...scope], worktree, snapshotEnvironment, true, 8_388_608)
    const binding = `${baseCommit}\0${JSON.stringify(scope)}\0`
    return {
      checkedTreeDigest: createHash('sha256').update('dsh-source-tree-v2\0').update(binding).update(tree).digest('hex'),
      checkedPatchDigest: createHash('sha256').update('dsh-source-patch-v2\0').update(binding).update(patch).digest('hex'),
    }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

async function sourcePlan(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const repository = await realpath(resolve(option(argv, '--repository'))); const worktree = await realpath(resolve(option(argv, '--worktree')))
    const name = option(argv, '--name'); if (!pluginPattern.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
    const environment = inheritedEnvironment(trust)
    const worktrees = (await localCommand('git', ['worktree', 'list', '--porcelain'], repository, environment, true)).split('\n')
      .filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
    if (worktrees.length < 2 || worktrees[0] === worktree || !worktrees.includes(worktree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan requires a linked non-primary worktree')
    const baseCommit = (await localCommand('git', ['rev-parse', 'HEAD'], worktree, environment, true)).trim()
    const generator = join(repository, 'scripts', 'create-plugin.mjs'); const generatorDigest = createHash('sha256').update(await readSafeFile(generator, 1_048_576)).digest('hex')
    const output = store.createSourcePlan({ gapId: option(argv, '--gap-id'), repository, worktree, baseCommit, name,
      generatorDigest, scope: sourceScope(name), ttlMs: 900_000, idempotencyKey: option(argv, '--idempotency-key') })
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } finally { store.close() }
}

async function scaffold(argv: readonly string[]): Promise<void> {
  if (argv.includes('--owner-approved')) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'source execution requires a signed source plan')
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  let plan: PluginSourcePlan | undefined
  try {
    plan = store.getSourcePlan(option(argv, '--plan-id'))
    if (plan.status !== 'approved' || plan.revision !== integerOption(argv, '--expected-revision')) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'exact approved source plan revision is required')
    assertExactSourceScope(plan)
    if (await realpath(plan.repository) !== plan.repository || await realpath(plan.worktree) !== plan.worktree) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source paths changed')
    const environment = inheritedEnvironment(trust)
    if ((await localCommand('git', ['rev-parse', 'HEAD'], plan.worktree, environment, true)).trim() !== plan.baseCommit
      || createHash('sha256').update(await readSafeFile(join(plan.repository, 'scripts', 'create-plugin.mjs'), 1_048_576)).digest('hex') !== plan.generatorDigest
      || (await localCommand('git', ['status', '--porcelain'], plan.worktree, environment, true)).trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan base, generator or clean-worktree binding changed')
    plan = store.beginSourceChecks({ planId: plan.id, expectedRevision: plan.revision })
    try {
      await localCommand('pnpm', ['create:plugin', plan.name], plan.worktree, environment)
      await localCommand('pnpm', ['check'], plan.worktree, environment)
      const changes = await changedSourcePaths(plan.worktree, plan.baseCommit, environment)
      const outsideScope = changes.find(path => !sourcePathAllowed(path, plan!))
      if (outsideScope !== undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `source generator changed files outside its approved scope: ${JSON.stringify(outsideScope)}`)
      const checked = await checkedSourceSnapshot(plan.worktree, plan.baseCommit, plan.scope, environment)
      plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: true, ...checked })
    } catch (error) {
      plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: false })
      throw error
    }
    process.stdout.write(`${JSON.stringify(plan)}\n`)
  } finally { store.close() }
}

function assertReleaseCommand(argv: readonly string[]): void {
  if (argv.includes('--phase')) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'release phase is derived from durable plan status')
}

function assertSourceReleaseTrust(plan: PluginSourcePlan, trust: PluginControlTrustConfig): void {
  if (trust.schemaVersion !== 4 || trust.releaseRegistry === undefined || plan.release === undefined) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source release requires schema-v4 owner trust, exact catalog, registry, and durable release identity')
  }
}

function releaseAuthority(trust: PluginControlTrustConfig, receipt: SourceReleaseReceipt): Ed25519SourceReleaseAuthority {
  const key = resolveTrustKey(trust, 'release', receipt.authority, receipt.keyId)
  return new Ed25519SourceReleaseAuthority(key.publicKeyPem, key.authority, key.keyId, Date.now, (authority, keyId) => {
    const verifier = trust.releaseAdapters?.['registry-verify']
    if (verifier === undefined || verifier.authority !== authority || verifier.keyId !== keyId) return undefined
    return resolveTrustKey(trust, 'release', authority, keyId).publicKeyPem
  })
}

function reconciliationAuthority(trust: PluginControlTrustConfig, receipt: SourcePublishReconciliationReceipt):
Ed25519SourcePublishReconciliationAuthority {
  const key = resolveTrustKey(trust, 'release', receipt.authority, receipt.keyId)
  return new Ed25519SourcePublishReconciliationAuthority(key.publicKeyPem, key.authority, key.keyId)
}

function releaseAuthorizationAuthority(trust: PluginControlTrustConfig, authorization: SourceReleaseAuthorization | undefined):
SourceReleaseAuthorizationAuthority {
  if (authorization === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source release authorization is missing')
  const key = resolveTrustKey(trust, 'release-authorization', authorization.authority, authorization.keyId)
  const authority = new Ed25519SourceReleaseAuthorizationAuthority(key.publicKeyPem, key.authority, key.keyId)
  return { verify: (value, plan) => {
    const { signatureDigest: _signatureDigest, ...signed } = value as SourceReleaseAuthorization & { signatureDigest?: string }
    return authority.verify(signed, plan)
  } }
}

async function prepareRelease(store: ControlPlaneStore, trust: PluginControlTrustConfig, plan: PluginSourcePlan) {
  assertSourceReleaseTrust(plan, trust)
  const expected = expectedSourceRelease(plan.status)
  if (expected === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan is not awaiting a release phase')
  const adapter = trust.releaseAdapters?.[expected.phase]
  if (adapter === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', `no owner-configured adapter is registered for ${expected.phase}`)
  const adapterIdentity = { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256,
    interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId }
  let catalog: { id: string; path: string; expectedBeforeDigest?: string; expectedAfterDigest?: string } =
    { id: trust.catalog.id, path: trust.catalog.path }
  if (expected.phase === 'catalog-admission') {
    const loaded = await loadCatalogWithMetadata(trust.catalog.path)
    const preview = previewCatalogAdmission(loaded.catalog, store.sourceReleaseCandidate(plan.id))
    catalog = { ...catalog, expectedBeforeDigest: preview.beforeCatalogDigest, expectedAfterDigest: preview.afterCatalogDigest }
  }
  return store.prepareSourceReleaseOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
    installationId: trust.installationId, ledger: trust.ledger, registry: trust.releaseRegistry!, catalog, adapter: adapterIdentity,
    receiptTtlMs: trust.releaseReceiptTtlMs, resolveAuthorizationAuthority: value => releaseAuthorizationAuthority(trust, value) })
}

async function releaseStart(argv: readonly string[]): Promise<void> {
  assertReleaseCommand(argv)
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const authorization = parseSourceReleaseAuthorization(JSON.parse(await readOwnerPrivateFile(resolve(option(argv, '--authorization')), 65_536)) as unknown)
    const result = await store.startSourceRelease({ planId: option(argv, '--plan-id'), expectedRevision: integerOption(argv, '--expected-revision'),
      authorization, resolveAuthority: value => releaseAuthorizationAuthority(trust, value),
      idempotencyKey: `source-release-authorization:${authorization.authorizationId}` })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { store.close() }
}

async function releaseRequest(argv: readonly string[]): Promise<void> {
  assertReleaseCommand(argv)
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const plan = store.getSourcePlan(option(argv, '--plan-id'))
    if (plan.revision !== integerOption(argv, '--expected-revision') || plan.release?.fence !== integerOption(argv, '--expected-fence')) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release request targets a stale revision/fence')
    }
    process.stdout.write(`${JSON.stringify((await prepareRelease(store, trust, plan)).request)}\n`)
  } finally { store.close() }
}

async function releaseStep(argv: readonly string[]): Promise<void> {
  assertReleaseCommand(argv)
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const plan = store.getSourcePlan(option(argv, '--plan-id')); const expectedRevision = integerOption(argv, '--expected-revision')
    const expectedFence = integerOption(argv, '--expected-fence')
    if (plan.revision !== expectedRevision || plan.release?.fence !== expectedFence) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release step targets a stale revision/fence')
    const operation = await prepareRelease(store, trust, plan)
    const receipt = await store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision, expectedFence,
      execute: request => invokeSourceReleaseAdapter(trust, request), resolveAuthority: value => releaseAuthority(trust, value),
      resolveAuthorizationAuthority: value => releaseAuthorizationAuthority(trust, value) })
    const result = await store.applySourceRelease({ planId: plan.id, expectedRevision, expectedFence, receipt,
      resolveAuthority: value => releaseAuthority(trust, value), idempotencyKey: `source-release:${operation.operationId}` })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { store.close() }
}

async function releaseAttest(argv: readonly string[]): Promise<void> {
  assertReleaseCommand(argv)
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const plan = store.getSourcePlan(option(argv, '--plan-id')); const expectedRevision = integerOption(argv, '--expected-revision')
    const expectedFence = integerOption(argv, '--expected-fence')
    if (plan.revision !== expectedRevision || plan.release?.fence !== expectedFence) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release receipt targets a stale revision/fence')
    const operation = await prepareRelease(store, trust, plan)
    const receipt = parseSourceReleaseReceipt(JSON.parse(await readOwnerPrivateFile(resolve(option(argv, '--receipt')), 262_144)) as unknown)
    if (receipt.operationId !== operation.operationId) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'release receipt does not target the durable operation')
    await store.runSourceReleaseOperation({ operationId: operation.operationId, expectedRevision, expectedFence, execute: async () => receipt,
      resolveAuthority: value => releaseAuthority(trust, value),
      resolveAuthorizationAuthority: value => releaseAuthorizationAuthority(trust, value) })
    const result = await store.applySourceRelease({ planId: plan.id, expectedRevision, expectedFence, receipt,
      resolveAuthority: value => releaseAuthority(trust, value), idempotencyKey: `source-release:${operation.operationId}` })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { store.close() }
}

async function releaseReconcile(argv: readonly string[]): Promise<void> {
  assertReleaseCommand(argv)
  if (argv.includes('--observation')) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'unsigned registry observations are forbidden')
  const trust = await commandTrust(argv); const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const plan = store.getSourcePlan(option(argv, '--plan-id')); const expectedRevision = integerOption(argv, '--expected-revision')
    const expectedFence = integerOption(argv, '--expected-fence'); assertSourceReleaseTrust(plan, trust)
    if (plan.revision !== expectedRevision || plan.release?.fence !== expectedFence || plan.status !== 'publish-ambiguous') {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'publish reconciliation targets a stale or non-ambiguous release')
    }
    const adapter = trust.releaseAdapters?.['registry-verify']
    if (adapter === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'publish reconciliation requires the independent registry verifier')
    const adapterIdentity = { id: adapter.id, version: adapter.version, path: adapter.path, sha256: adapter.sha256,
      interpreter: adapter.interpreter, authority: adapter.authority, keyId: adapter.keyId }
    const operation = await store.prepareSourcePublishReconciliation({ planId: plan.id, expectedRevision, expectedFence,
      installationId: trust.installationId, ledger: trust.ledger, registry: trust.releaseRegistry!, adapter: adapterIdentity,
      receiptTtlMs: trust.releaseReceiptTtlMs, resolveAuthorizationAuthority: value => releaseAuthorizationAuthority(trust, value) })
    const receiptPath = optionalOption(argv, '--receipt')
    const supplied = receiptPath === undefined ? undefined : parseSourcePublishReconciliationReceipt(
      JSON.parse(await readOwnerPrivateFile(resolve(receiptPath), 262_144)) as unknown)
    if (supplied !== undefined && supplied.operationId !== operation.operationId) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'publish reconciliation receipt does not target the durable operation')
    }
    const receipt = await store.runSourcePublishReconciliation({ operationId: operation.operationId, expectedRevision, expectedFence,
      execute: supplied === undefined ? request => invokeSourcePublishReconciliationAdapter(trust, request) : async () => supplied,
      resolveAuthority: value => reconciliationAuthority(trust, value),
      resolveAuthorizationAuthority: value => releaseAuthorizationAuthority(trust, value) })
    const result = await store.reconcileSourcePublish({ planId: plan.id, expectedRevision, expectedFence, receipt,
      resolveAuthority: value => reconciliationAuthority(trust, value), idempotencyKey: `source-publish-reconciliation:${operation.operationId}` })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally { store.close() }
}

export async function runPluginControl(argv = process.argv.slice(2)): Promise<void> {
  rejectCommandSuppliedTrust(argv)
  const command = argv[0]
  if (command === 'discover') {
    const loaded = await loadCatalogWithMetadata(resolve(optionalOption(argv, '--catalog') ?? defaultCatalogPath()))
    process.stdout.write(`${JSON.stringify({ provenance: loaded.provenance, digest: loaded.digest, candidates: discover(loaded.catalog, option(argv, '--capability')) })}\n`); return
  }
  if (command === 'show') {
    const trust = await commandTrust(argv)
    const store = new ControlPlaneStore({ path: trust.ledger.path })
    try { process.stdout.write(`${JSON.stringify(option(argv, '--kind') === 'source' ? store.getSourcePlan(option(argv, '--plan-id')) : store.getPlan(option(argv, '--plan-id')))}\n`) } finally { store.close() }
    return
  }
  if (command === 'approve') return approve(argv)
  if (command === 'activate') return activate(argv)
  if (command === 'host-request') return hostRequest(argv)
  if (command === 'probe') return probe(argv)
  if (command === 'attest') return attest(argv)
  if (command === 'source-plan') return sourcePlan(argv)
  if (command === 'scaffold') return scaffold(argv)
  if (command === 'release-start') return releaseStart(argv)
  if (command === 'release-request') return releaseRequest(argv)
  if (command === 'release-step') return releaseStep(argv)
  if (command === 'release-attest') return releaseAttest(argv)
  if (command === 'release-reconcile') return releaseReconcile(argv)
  throw new ControlPlaneCliError('INVALID_ARGUMENT', 'usage: dsh-plugin-control <discover|show|approve|activate|host-request|probe|attest|source-plan|scaffold|release-start|release-request|release-step|release-attest|release-reconcile>')
}
