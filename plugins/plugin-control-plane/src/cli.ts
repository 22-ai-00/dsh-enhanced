import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants as fsConstants, lstatSync } from 'node:fs'
import { cp, lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Ed25519ApprovalAuthority, loadPrivateApprovalInput, parseApprovalReceipt } from './approval.js'
import { Ed25519HostAttestationAuthority, parseHostAttestationReceipt } from './attestation.js'
import { invokeConfiguredHostAttestor, prepareConfiguredHostAttestation, prepareManualHostAttestation } from './host-attestor.js'
import { Ed25519ActivationRetractionAuthority, Ed25519PostActivationObservationAuthority,
  parseActivationRetraction, parsePostActivationObservation } from './post-activation.js'
import { discover, loadCatalogWithMetadata, previewCatalogAdmission, type CatalogPackage } from './catalog.js'
import { fetchRegistryArtifact, RegistryFetchError } from './registry-fetch.js'
import { verifyApprovedPackagesInLockfile } from './lockfile.js'
import { Ed25519SourcePublishReconciliationAuthority, Ed25519SourceReleaseAuthority, Ed25519SourceReleaseAuthorizationAuthority,
  invokeSourcePublishReconciliationAdapter, invokeSourceReleaseAdapter, parseSourcePublishReconciliationReceipt,
  parseSourceReleaseAuthorization, parseSourceReleaseReceipt } from './release.js'
import { ControlPlaneStore, controlPlaneDigest, expectedSourceRelease } from './store.js'
import { ControlPlaneCliError } from './errors.js'
import { changedSourcePaths, checkedSourceSnapshot, gcPreparedModifyWorktrees, runLocalCommand, sourcePathAllowed } from './source-workspace.js'
import { inheritedEnvironment, loadTrustConfig, openTrustedExecutable, resolveTrustKey, verifyOpenTrustedExecutable,
  type OpenTrustedExecutable, type PluginControlTrustConfig } from './trust.js'
import type { ActivationRetractionAuthority, ActivationRetractionReceipt, ApprovalReceipt, HostAttestationReceipt,
  PlanStatus, PluginActivationPlan, PluginSourcePlan, PostActivationObservationAuthority, PostActivationObservationReceipt,
  SourcePublishReconciliationReceipt, SourceReleaseAuthorization, SourceReleaseAuthorizationAuthority, SourceReleaseReceipt } from './types.js'

const pluginPattern = /^(?=.{1,64}$)[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u
const leaseMs = 30_000
const pluginCatalogScope = 'plugins/README.md'
const maximumActivationArtifactBytes = 268_435_456

// checkedSourceSnapshot stays importable from this module for the CLI test
// suite; the implementation now lives in source-workspace.ts.
export { checkedSourceSnapshot }

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

const rollbackCoreFiles = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'] as const

async function captureRollbackBaseline(plan: PluginActivationPlan): Promise<readonly { path: string; sha256: string | null }[]> {
  if (!plan.activation?.targetOriginallyExisted) return []
  return Promise.all(rollbackCoreFiles.map(async name => {
    const path = join(plan.target.profilePath, name)
    let observed = false
    try {
      const pathname = await lstat(path, { bigint: true }); observed = true
      const uid = process.getuid?.()
      if (!pathname.isFile() || pathname.nlink !== 1n || pathname.size > 16n * 1024n * 1024n || (pathname.mode & 0o022n) !== 0n
        || (uid !== undefined && pathname.uid !== 0n && pathname.uid !== BigInt(uid)) || await realpath(path) !== path) {
        throw new ControlPlaneCliError('FILESYSTEM_STATE', 'rollback baseline file is unsafe')
      }
      const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
      try {
        const before = await handle.stat({ bigint: true })
        if (!before.isFile() || before.dev !== pathname.dev || before.ino !== pathname.ino || before.size !== pathname.size
          || before.mtimeNs !== pathname.mtimeNs || before.ctimeNs !== pathname.ctimeNs) {
          throw new ControlPlaneCliError('FILESYSTEM_STATE', 'rollback baseline pathname changed')
        }
        const bytes = await handle.readFile(); const after = await handle.stat({ bigint: true }); const finalPath = await lstat(path, { bigint: true })
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs || BigInt(bytes.length) !== before.size || before.dev !== finalPath.dev
          || before.ino !== finalPath.ino || await realpath(path) !== path) {
          throw new ControlPlaneCliError('FILESYSTEM_STATE', 'rollback baseline file changed during read')
        }
        return { path, sha256: createHash('sha256').update(bytes).digest('hex') }
      } finally { await handle.close() }
    }
    catch (error) {
      if (!observed && typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return { path, sha256: null }
      throw error
    }
  }))
}

async function verifyRollbackBaseline(plan: PluginActivationPlan): Promise<void> {
  const baseline = plan.activation?.targetBaselineFiles
  if (baseline === undefined || baseline.length !== (plan.activation?.targetOriginallyExisted ? 3 : 0)) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', 'activation rollback baseline is missing')
  }
  const actual = await captureRollbackBaseline(plan)
  if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
    throw new ControlPlaneCliError('FILESYSTEM_STATE', 'restored profile does not match its durable rollback baseline')
  }
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

const profilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

// Mirrors the service-layer canonical target rule: the profiles directory and
// the target profile must be one canonical non-symlinked directory tree under
// the owner-bound DSH_HOME (a still-missing profile is accepted only when its
// parent directory is itself canonical).
async function canonicalProfileTarget(trust: PluginControlTrustConfig, profile: string): Promise<PluginActivationPlan['target']> {
  if (!profilePattern.test(profile) || profile.normalize('NFC').trim() !== profile) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'profile must already be bounded canonical text')
  }
  const profiles = join(trust.dshHome, 'profiles')
  if (await realpath(profiles) !== resolve(profiles)) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'profiles directory is not canonical')
  const profilePath = join(profiles, profile)
  try {
    const metadata = await lstat(profilePath)
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(profilePath) !== resolve(profilePath)) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'target profile must be a canonical directory')
    }
  } catch (error) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error
    if (await realpath(dirname(profilePath)) !== resolve(dirname(profilePath)) || basename(profilePath) !== profile) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'missing target profile parent is not canonical')
    }
  }
  return Object.freeze({ dshHome: trust.dshHome, profile, profilePath })
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
  return await pinActivationArtifactBytes(plan, item, registry, bytes)
}

// Shared terminus for both artifact source paths (a local file URL and a
// downloaded registry object): the approved bytes are materialized into an
// owner-private 0400 cache, then reopened through a pinned file descriptor so
// the package manager only ever reads /proc/self/fd/N while the control plane
// re-verifies the bytes after the executor returns.
async function pinActivationArtifactBytes(plan: PluginActivationPlan, item: CatalogPackage,
  registry: NonNullable<CatalogPackage['registry']>, bytes: Buffer): Promise<ActivationArtifactSnapshot> {
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

// Remote counterpart of snapshotLocalArtifact. The catalog-approved package
// is fetched from the single owner-bound release registry over pinned TLS,
// authorized with a bearer token read from the owner process (never from the
// trust file or the executor allowlist), and accepted solely on equality with
// the catalog-approved sha512 integrity. The verified bytes then take the
// identical 0400-cache + file-descriptor path as a local artifact.
async function downloadRegistryArtifact(trust: PluginControlTrustConfig, plan: PluginActivationPlan,
  item: CatalogPackage): Promise<ActivationArtifactSnapshot> {
  const registry = item.registry
  if (registry === undefined) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'package registry binding is missing')
  const bound = trust.releaseRegistry
  if (bound === undefined || bound.id !== registry.id || bound.locator !== registry.locator) {
    throw new ControlPlaneCliError('ACTIVATION_BINDING', 'package registry is not the owner-bound release registry')
  }
  let bytes: Buffer
  try {
    const fetched = await fetchRegistryArtifact({ registry: bound, packageName: item.package, version: item.version, expectedIntegrity: item.integrity }, process.env)
    bytes = fetched.bytes
    if (registry.reference.startsWith('https:') && fetched.reference !== registry.reference) {
      throw new ControlPlaneCliError('ACTIVATION_BINDING', 'remote artifact reference does not match the approved exact HTTPS reference')
    }
  } catch (error) {
    if (error instanceof ControlPlaneCliError) throw error
    if (error instanceof RegistryFetchError) throw new ControlPlaneCliError('ACTIVATION_BINDING', error.message)
    throw error
  }
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
  if (integrity !== item.integrity) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'remote artifact bytes do not match the approved integrity')
  return await pinActivationArtifactBytes(plan, item, registry, bytes)
}

async function activationPackages(trust: PluginControlTrustConfig, plan: PluginActivationPlan): Promise<{ packages: CatalogPackage[]; snapshots: ActivationArtifactSnapshot[] }> {
  const snapshots: ActivationArtifactSnapshot[] = []
  try {
    for (const item of exactPackages(plan)) {
      if (localArtifactReference(item) !== undefined) snapshots.push(await snapshotLocalArtifact(plan, item))
      else if (item.registry !== undefined) snapshots.push(await downloadRegistryArtifact(trust, plan, item))
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
  const observed = plan.activation?.failureCode?.startsWith('post-activation-') === true
  if (observed) {
    await restoreObservedTarget(store, plan)
  } else await restoreTarget(store, plan, activationPaths.backupPath)
  await fencedMutation(store, plan, () => verifyRollbackBaseline(plan))
  if (!observed) await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
  const terminal = plan.activation?.hostRecoveryRequired
    ? store.markRollbackProfileRestored({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation.fence })
    : advance(store, plan, 'rolled-back')
  if (observed) await cleanupRestoredStage(store, terminal)
  await releaseProfileLock(store, lock)
  return terminal
}

async function profileFilesAt(plan: PluginActivationPlan, path: string): Promise<readonly { path: string; sha256: string | null }[]> {
  await assertDirectory(path)
  const files = await captureRollbackBaseline({ ...plan, target: { ...plan.target, profilePath: path },
    activation: { ...plan.activation!, targetOriginallyExisted: true } })
  return files.map((file, index) => ({ path: join(plan.target.profilePath, rollbackCoreFiles[index]!), sha256: file.sha256 }))
}

/** A closed quality watch may restore only the exact deployment it observed. */
async function restoreObservedTarget(store: ControlPlaneStore, plan: PluginActivationPlan): Promise<void> {
  const { backupPath, stagePath } = paths(plan)
  await fencedMutation(store, plan, async () => {
    const installed = store.getActivationInstalledBaseline(plan.id)
    const baseline = plan.activation?.targetBaselineFiles
    if (installed === undefined || baseline === undefined) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'post-activation rollback checkpoints are unavailable')
    }
    const matches = async (path: string, expected: typeof installed): Promise<void> => {
      if (JSON.stringify(await profileFilesAt(plan, path)) !== JSON.stringify(expected)) {
        throw new ControlPlaneCliError('FILESYSTEM_STATE', 'post-activation profile files changed; rollback requires reconciliation')
      }
    }
    const backupExists = await directoryExists(backupPath)
    const targetExists = await directoryExists(plan.target.profilePath)
    const staged = await directoryExists(stagePath)
    // The old target is moved aside before its replacement. A crash between
    // either rename can resume without deleting an unverified profile.
    if (plan.activation!.targetOriginallyExisted) {
      if (!backupExists) {
        if (!targetExists || !staged) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'retained rollback backup is missing')
        await matches(plan.target.profilePath, baseline)
        if (staged) await matches(stagePath, installed)
        await syncDirectory(join(plan.target.dshHome, 'profiles'))
        return
      }
      await matches(backupPath, baseline)
    } else if (backupExists) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'unexpected rollback backup for an absent baseline')
    if (staged) await matches(stagePath, installed)
    if (targetExists) {
      await matches(plan.target.profilePath, installed)
      if (staged) throw new ControlPlaneCliError('FILESYSTEM_STATE', 'both rollback target and staged candidate exist')
      await rename(plan.target.profilePath, stagePath)
    } else if (!staged) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'observed deployment and recovery stage are both missing')
    }
    if (plan.activation!.targetOriginallyExisted) await rename(backupPath, plan.target.profilePath)
    await syncDirectory(join(plan.target.dshHome, 'profiles'))
  })
}

async function cleanupRestoredStage(store: ControlPlaneStore, plan: PluginActivationPlan): Promise<void> {
  await store.withExclusiveWrite(async () => {
    const current = store.getPlan(plan.id)
    if (!current.activation?.rollbackProfileRestored || current.activation.fence !== plan.activation?.fence) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'rollback restoration marker changed before stage cleanup')
    }
    const { stagePath } = paths(current)
    if (!await directoryExists(stagePath)) return
    const installed = store.getActivationInstalledBaseline(current.id)
    if (installed === undefined || JSON.stringify(await profileFilesAt(current, stagePath)) !== JSON.stringify(installed)) {
      throw new ControlPlaneCliError('FILESYSTEM_STATE', 'restored rollback stage changed; cleanup requires reconciliation')
    }
    await rm(stagePath, { recursive: true, force: true })
  })
}

async function cleanupRetiredBackups(store: ControlPlaneStore, plan: PluginActivationPlan): Promise<void> {
  await store.withExclusiveWrite(async () => {
    for (const retired of store.listRetiredActivationBackups(plan.id)) {
      const { backupPath } = paths(retired)
      if (await directoryExists(backupPath)) await rm(backupPath, { recursive: true, force: true })
    }
  })
}

async function finishCommit(store: ControlPlaneStore, plan: PluginActivationPlan): Promise<PluginActivationPlan> {
  const baselineFiles = await fencedMutation(store, plan, () => profileFilesAt(plan, plan.target.profilePath))
  store.recordActivationInstalledBaseline({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence, baselineFiles })
  await fencedMutation(store, plan, () => rm(paths(plan).stagePath, { recursive: true, force: true }))
  const committed = advance(store, plan, 'activated')
  await cleanupRetiredBackups(store, committed)
  return committed
}

async function rollbackClosedWatch(store: ControlPlaneStore, trust: PluginControlTrustConfig, planId: string): Promise<PluginActivationPlan> {
  let plan = store.getPlan(planId)
  assertPlanTrust(plan, trust)
  plan = store.beginPostActivationRollback({ planId, expectedRevision: plan.revision })
  if (plan.activation?.rollbackProfileRestored) await cleanupRestoredStage(store, plan)
  if (plan.status === 'rolled-back') return plan
  if (!plan.activation?.rollbackProfileRestored) {
    plan = await store.claimActivation({ planId, expectedRevision: plan.revision, leaseMs,
      resolveApprovalAuthority: receipt => activationApprovalAuthority(trust, receipt) })
    let lock: ProfileLock | undefined = await acquireProfileLock(store, plan)
    try { plan = await finishRollback(store, plan, lock); lock = undefined }
    finally { if (lock !== undefined) await releaseProfileLock(store, lock) }
  }
  if (trust.hostAttestor === undefined) return plan
  const operation = prepareConfiguredHostAttestation(store, plan, trust)
  const resolveAuthority = (receipt: HostAttestationReceipt): Ed25519HostAttestationAuthority => {
    const key = resolveTrustKey(trust, 'host-attestation', receipt.authority, receipt.keyId)
    return new Ed25519HostAttestationAuthority(key.publicKeyPem, key.authority, key.keyId)
  }
  const receipt = await store.runHostAttestationOperation({ operationId: operation.operationId,
    expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
    execute: request => invokeConfiguredHostAttestor(trust, request), resolveAuthority })
  return (await store.applyHostAttestation({ planId, expectedRevision: plan.revision, expectedFence: plan.activation!.fence,
    receipt, idempotencyKey: `host-attestation:${operation.operationId}`, resolveAuthority })).result
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
    if (plan.status === 'activated') { await cleanupRetiredBackups(store, plan); process.stdout.write(`${JSON.stringify(plan)}\n`); return }
    if (plan.status === 'rollback-pending' && plan.activation?.rollbackProfileRestored) {
      if (plan.revision !== integerOption(argv, '--expected-revision')) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation targets a stale revision')
      process.stdout.write(`${JSON.stringify(plan)}\n`); return
    }
    plan = await store.claimActivation({ planId: plan.id, expectedRevision: integerOption(argv, '--expected-revision'), leaseMs,
      resolveApprovalAuthority: receipt => activationApprovalAuthority(trust, receipt) })
    lock = await acquireProfileLock(store, plan)
    const activationPaths = paths(plan)
    if (plan.status === 'rollback-pending') { process.stdout.write(`${JSON.stringify(await finishRollback(store, plan, lock))}\n`); lock = undefined; return }
    if (plan.status === 'commit-pending') {
      process.stdout.write(`${JSON.stringify(await finishCommit(store, plan))}\n`); return
    }
    if (plan.status !== 'staging') throw new ControlPlaneCliError('HOST_ATTESTATION_REQUIRED', 'activation is awaiting a signed Host attestation')
    await assertDirectory(trust.dshHome); await assertDirectory(join(trust.dshHome, 'profiles')); await assertDirectory(plan.target.profilePath, true)
    const environment = inheritedEnvironment(trust)
    try {
      if (plan.activation?.targetOriginallyExisted === undefined) {
        if (await directoryExists(activationPaths.backupPath) || await directoryExists(activationPaths.stagePath)) {
          throw new ControlPlaneCliError('FILESYSTEM_STATE', 'unbound activation residue requires owner recovery')
        }
        const existed = await directoryExists(plan.target.profilePath)
        const baselineFiles = existed ? await fencedMutation(store, plan, () => captureRollbackBaseline({ ...plan, activation: { ...plan.activation!, targetOriginallyExisted: true } })) : []
        plan = store.recordActivationTargetBaseline({ planId: plan.id, expectedRevision: plan.revision,
          fence: plan.activation!.fence, existed, baselineFiles })
      }
      await restoreTarget(store, plan, activationPaths.backupPath)
      await fencedMutation(store, plan, () => rm(activationPaths.stagePath, { recursive: true, force: true }))
      if (plan.activation!.targetOriginallyExisted) {
        await stat(plan.target.profilePath)
        await fencedMutation(store, plan, () => cp(plan.target.profilePath, activationPaths.stagePath, { recursive: true, force: false, errorOnExist: true }))
      }
      const activationArtifacts = await fencedMutation(store, plan, () => activationPackages(trust, plan))
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
      plan = store.markActivationHostExposure({ planId: plan.id, expectedRevision: plan.revision, fence: plan.activation!.fence })
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
        plan = await finishCommit(store, plan)
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
    if (argv.includes('--prepare-only')) {
      process.stdout.write(`${JSON.stringify(operation.request)}\n`)
      return
    }
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
        output = await finishCommit(store, output)
      }
    }
    process.stdout.write(`${JSON.stringify({ ...result, result: output })}\n`)
  } finally { if (lock !== undefined) await releaseProfileLock(store, lock); store.close() }
}

async function watchObserve(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const receipt = parsePostActivationObservation(JSON.parse(await loadPrivateApprovalInput(resolve(option(argv, '--receipt')), 32_768)) as unknown)
    assertPlanTrust(store.getPlan(receipt.planId), trust)
    const result = await store.recordPostActivationObservation({
      receipt,
      ...(argv.includes('--expected-revision') ? { expectedRevision: integerOption(argv, '--expected-revision') } : {}),
      resolveAuthority: (value: PostActivationObservationReceipt): PostActivationObservationAuthority => {
        const key = resolveTrustKey(trust, 'host-attestation', value.authority, value.keyId)
        return new Ed25519PostActivationObservationAuthority(key.publicKeyPem, key.authority, key.keyId)
      },
      idempotencyKey: `post-activation-observation:${receipt.observationId}` })
    const activation = receipt.disposition === 'regressed' ? await rollbackClosedWatch(store, trust, receipt.planId) : undefined
    process.stdout.write(`${JSON.stringify({ ...result, ...(activation === undefined ? {} : { activation }) })}\n`)
  } finally { store.close() }
}

async function watchRetract(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const receipt = parseActivationRetraction(JSON.parse(await loadPrivateApprovalInput(resolve(option(argv, '--receipt')), 32_768)) as unknown)
    assertPlanTrust(store.getPlan(receipt.planId), trust)
    const result = await store.retractActivation({
      receipt,
      ...(argv.includes('--expected-revision') ? { expectedRevision: integerOption(argv, '--expected-revision') } : {}),
      resolveAuthority: (value: ActivationRetractionReceipt): ActivationRetractionAuthority => {
        const key = resolveTrustKey(trust, 'approval', value.authority, value.keyId)
        return new Ed25519ActivationRetractionAuthority(key.publicKeyPem, key.authority, key.keyId)
      },
      idempotencyKey: `activation-retraction:${receipt.retractionId}` })
    const activation = await rollbackClosedWatch(store, trust, receipt.planId)
    process.stdout.write(`${JSON.stringify({ ...result, activation })}\n`)
  } finally { store.close() }
}

async function watchShow(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const planId = optionalOption(argv, '--plan-id')
    if (planId !== undefined) {
      assertPlanTrust(store.getPlan(planId), trust)
      process.stdout.write(`${JSON.stringify({ watch: store.getActivationWatch(planId),
        evidence: store.listActivationWatchEvidence(planId) })}\n`)
    } else {
      process.stdout.write(`${JSON.stringify({ watches: store.listActivationWatches(
        argv.includes('--limit') ? integerOption(argv, '--limit') : undefined) })}\n`)
    }
  } finally { store.close() }
}

function sourceScope(name: string): readonly string[] { return [pluginCatalogScope, `plugins/${name}`].sort() }

function assertExactSourceScope(plan: PluginSourcePlan): void {
  const expected = sourceScope(plan.name)
  if (plan.scope.length !== expected.length || plan.scope.some((value, index) => value !== expected[index])) {
    throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan scope does not match the exact generator outputs')
  }
}

async function sourcePlan(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const repository = await realpath(resolve(option(argv, '--repository'))); const worktree = await realpath(resolve(option(argv, '--worktree')))
    const name = option(argv, '--name'); if (!pluginPattern.test(name)) throw new ControlPlaneCliError('INVALID_ARGUMENT', 'plugin name is invalid')
    const environment = inheritedEnvironment(trust)
    const worktrees = (await runLocalCommand('git', ['worktree', 'list', '--porcelain'], repository, environment, { capture: true })).split('\n')
      .filter(line => line.startsWith('worktree ')).map(line => resolve(line.slice('worktree '.length)))
    if (worktrees.length < 2 || worktrees[0] === worktree || !worktrees.includes(worktree)) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan requires a linked non-primary worktree')
    const baseCommit = (await runLocalCommand('git', ['rev-parse', 'HEAD'], worktree, environment, { capture: true })).trim()
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
    if (plan.mode !== 'create') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'scaffold only serves create source plans; modify plans are verified, not locally scaffolded')
    if (plan.status !== 'approved' || plan.revision !== integerOption(argv, '--expected-revision')) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'exact approved source plan revision is required')
    assertExactSourceScope(plan)
    if (await realpath(plan.repository) !== plan.repository || await realpath(plan.worktree) !== plan.worktree) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source paths changed')
    const environment = inheritedEnvironment(trust)
    if ((await runLocalCommand('git', ['rev-parse', 'HEAD'], plan.worktree, environment, { capture: true })).trim() !== plan.baseCommit
      || createHash('sha256').update(await readSafeFile(join(plan.repository, 'scripts', 'create-plugin.mjs'), 1_048_576)).digest('hex') !== plan.generatorDigest
      || (await runLocalCommand('git', ['status', '--porcelain'], plan.worktree, environment, { capture: true })).trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan base, generator or clean-worktree binding changed')
    plan = store.beginSourceChecks({ planId: plan.id, expectedRevision: plan.revision })
    try {
      // Uncaptured commands: stdout is drained and discarded without a byte
      // bound, exactly like the legacy localCommand scaffold path.
      await runLocalCommand('pnpm', ['create:plugin', plan.name], plan.worktree, environment)
      await runLocalCommand('pnpm', ['check'], plan.worktree, environment)
      const changes = await changedSourcePaths(plan.worktree, plan.baseCommit, environment)
      const outsideScope = changes.find(path => !sourcePathAllowed(path, plan!.name, plan!.mode))
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

async function sourceVerifyPrepared(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const planId = option(argv, '--plan-id')
    const expectedRevision = integerOption(argv, '--expected-revision')
    const plan = store.getSourcePlan(planId)
    if (plan.mode !== 'modify') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'verify-prepared only serves modify source plans; create plans are locally scaffolded')
    if (plan.status !== 'approved' || plan.revision !== expectedRevision) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'exact approved modify source plan revision is required')
    }
    if (plan.sourceCheck === undefined) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'approved modify plan is missing its bound checked digests')
    if (plan.scope.length !== 1 || plan.scope[0] !== `plugins/${plan.name}`) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'modify plan scope must be exactly its own plugin tree')
    }
    if (await realpath(plan.repository) !== plan.repository || await realpath(plan.worktree) !== plan.worktree) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared source paths drifted from their canonical bindings')
    }
    const environment = inheritedEnvironment(trust)
    // The prepared patch lives in the worktree as deliberately uncommitted
    // changes, so a clean-tree assertion would reject every valid plan. The
    // owner-side proof is instead: nobody committed over the base commit, every
    // changed/untracked path stays inside the plugin scope, and the tree/patch
    // digests recomputed on this exact directory equal the bound checked
    // digests byte for byte.
    if ((await runLocalCommand('git', ['rev-parse', 'HEAD'], plan.worktree, environment, { capture: true })).trim() !== plan.baseCommit) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'prepared worktree HEAD drifted from the bound base commit')
    }
    const changes = await changedSourcePaths(plan.worktree, plan.baseCommit, environment)
    const outsideScope = changes.find(path => !sourcePathAllowed(path, plan.name, plan.mode))
    if (outsideScope !== undefined) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', `prepared modification holds files outside its approved scope: ${JSON.stringify(outsideScope)}`)
    }
    const checked = await checkedSourceSnapshot(plan.worktree, plan.baseCommit, plan.scope, environment)
    if (checked.checkedTreeDigest !== plan.sourceCheck.treeDigest
      || checked.checkedPatchDigest !== plan.sourceCheck.patchDigest) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'recomputed prepared digests do not match the bound checked digests')
    }
    const receipt = store.verifyPreparedSourcePlan({ planId: plan.id, expectedRevision: plan.revision,
      recheckedTreeDigest: checked.checkedTreeDigest, recheckedPatchDigest: checked.checkedPatchDigest })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } finally { store.close() }
}

async function sourceGc(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    // The ledger path is owner-bound to <statePath>/control.sqlite; command
    // callers are forbidden from supplying a state root, so derive it here.
    const result = await gcPreparedModifyWorktrees({ store, statePath: dirname(trust.ledger.path),
      environment: inheritedEnvironment(trust), now: Date.now() })
    process.stdout.write(`${JSON.stringify(result)}\n`)
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
  // Only {id, locator} leaves the owner host: caPins/tokenEnvironment are
  // activation-side local trust roots and must never reach a release adapter.
  const releaseRegistry = { id: trust.releaseRegistry!.id, locator: trust.releaseRegistry!.locator }
  return store.prepareSourceReleaseOperation({ planId: plan.id, expectedRevision: plan.revision, expectedFence: plan.release!.fence,
    installationId: trust.installationId, ledger: trust.ledger, registry: releaseRegistry, catalog, adapter: adapterIdentity,
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
      installationId: trust.installationId, ledger: trust.ledger,
      registry: { id: trust.releaseRegistry!.id, locator: trust.releaseRegistry!.locator }, adapter: adapterIdentity,
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

async function activationPlan(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  try {
    const sourcePlanId = option(argv, '--source-plan')
    const profile = option(argv, '--profile')
    const idempotencyKey = option(argv, '--idempotency-key')
    const ttlMs = optionalOption(argv, '--ttl-ms') === undefined ? 900_000 : integerOption(argv, '--ttl-ms')
    const source = store.getSourcePlan(sourcePlanId)
    if (source.status !== 'release-complete') {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'activation plan requires a release-complete source plan')
    }
    const released = store.sourceReleaseCandidate(sourcePlanId)
    const loaded = await loadCatalogWithMetadata(trust.catalog.path)
    const admitted = loaded.catalog.entries.find(entry => entry.id === released.id)
    if (admitted === undefined
      || controlPlaneDigest({ schemaVersion: 1, entries: [admitted] }) !== controlPlaneDigest({ schemaVersion: 1, entries: [released] })) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'released candidate is not the exact admitted owner catalog entry')
    }
    if (!discover(loaded.catalog, source.gapSnapshot.capability).some(entry => entry.id === released.id)) {
      throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'admitted candidate does not match the released gap capability')
    }
    const target = await canonicalProfileTarget(trust, profile)
    const receipt = store.createPlan({ candidate: admitted, catalog: { digest: loaded.digest, provenance: loaded.provenance },
      matchedCapabilities: admitted.capabilities, profile, target, installationId: trust.installationId, ledger: trust.ledger,
      executor: { id: trust.executor.id, version: trust.executor.version, path: trust.executor.path, sha256: trust.executor.sha256 },
      ttlMs, gapId: source.gapId, idempotencyKey })
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
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
  if (command === 'watch-observe') return watchObserve(argv)
  if (command === 'watch-retract') return watchRetract(argv)
  if (command === 'watch-show') return watchShow(argv)
  if (command === 'source-plan') return sourcePlan(argv)
  if (command === 'scaffold') return scaffold(argv)
  if (command === 'source') {
    if (argv[1] === 'verify-prepared') return sourceVerifyPrepared(argv)
    if (argv[1] === 'gc') return sourceGc(argv)
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'usage: dsh-plugin-control source <verify-prepared|gc>')
  }
  if (command === 'release-start') return releaseStart(argv)
  if (command === 'release-request') return releaseRequest(argv)
  if (command === 'release-step') return releaseStep(argv)
  if (command === 'release-attest') return releaseAttest(argv)
  if (command === 'release-reconcile') return releaseReconcile(argv)
  if (command === 'activation-plan') return activationPlan(argv)
  throw new ControlPlaneCliError('INVALID_ARGUMENT', 'usage: dsh-plugin-control <discover|show|approve|activate|host-request|probe|attest|watch-observe|watch-retract|watch-show|source-plan|scaffold|source verify-prepared|source gc|release-start|release-request|release-step|release-attest|release-reconcile|activation-plan>')
}
