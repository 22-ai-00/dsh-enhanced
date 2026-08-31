import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { cp, lstat, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { Ed25519ApprovalAuthority, loadPrivateApprovalInput, parseApprovalReceipt } from './approval.js'
import { Ed25519HostAttestationAuthority, parseHostAttestationReceipt } from './attestation.js'
import { invokeConfiguredHostAttestor, prepareConfiguredHostAttestation, prepareManualHostAttestation } from './host-attestor.js'
import { discover, loadCatalogWithMetadata, type CatalogPackage } from './catalog.js'
import { verifyApprovedPackagesInLockfile } from './lockfile.js'
import { ControlPlaneStore } from './store.js'
import { inheritedEnvironment, inspectTrustedExecutable, loadTrustConfig, resolveTrustKey, type PluginControlTrustConfig } from './trust.js'
import type { HostAttestationReceipt, PlanStatus, PluginActivationPlan, PluginSourcePlan } from './types.js'

const pluginPattern = /^[a-z0-9][a-z0-9-]{0,63}$/u
const leaseMs = 30_000

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

async function commandTrust(argv: readonly string[]): Promise<PluginControlTrustConfig> {
  if (argv.includes('--trust') || argv.includes('--approval-public-key') || argv.includes('--authority') || argv.includes('--key-id')
    || argv.includes('--state') || argv.includes('--dsh-home') || argv.includes('--attestor') || argv.includes('--attestor-path')) {
    throw new ControlPlaneCliError('INVALID_ARGUMENT', 'command-supplied trust roots or ledgers are forbidden')
  }
  return loadTrustConfig(defaultTrustPath())
}

function exactPackages(plan: PluginActivationPlan): CatalogPackage[] { return [...plan.dossier.packages] }

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

async function runBounded(input: { executable: string; args: readonly string[]; cwd?: string; environment: NodeJS.ProcessEnv;
  store?: ControlPlaneStore; plan?: PluginActivationPlan; capture?: boolean }): Promise<string> {
  const execute = async (): Promise<string> => {
    const before = input.plan === undefined ? undefined : await inspectTrustedExecutable(input.executable, input.plan.executor.sha256)
    let result = ''
    let failure: unknown
    try {
      result = await new Promise((resolvePromise, reject) => {
        const child = spawn(input.executable, [...input.args], { cwd: input.cwd, env: input.environment, stdio: ['ignore', 'pipe', 'ignore'], shell: false })
        const chunks: Buffer[] = []; let bytes = 0; let outputLimit = false; let timedOut = false
        child.stdout.on('data', (chunk: Buffer) => {
          if (!input.capture) return
          bytes += chunk.length
          if (bytes > 65_536) { outputLimit = true; child.kill('SIGKILL') } else chunks.push(chunk)
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
    if (before !== undefined) {
      const after = await inspectTrustedExecutable(input.executable, input.plan!.executor.sha256)
      if (after.device !== before.device || after.inode !== before.inode) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor changed while a command was running')
    }
    if (failure !== undefined) throw failure
    return result
  }
  return input.store !== undefined && input.plan !== undefined
    ? input.store.withActivationFileSystemGuard({ planId: input.plan.id, expectedRevision: input.plan.revision,
      fence: input.plan.activation!.fence, status: input.plan.status, leaseMs }, execute)
    : execute()
}

function paths(plan: PluginActivationPlan): { stageProfile: string; stagePath: string; backupPath: string } {
  if (plan.activation === undefined) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'activation identity is missing')
  const suffix = plan.activation.id.replace(/[^A-Za-z0-9-]/gu, '').slice(-36)
  const stageProfile = `stage-${suffix}`
  return { stageProfile, stagePath: join(plan.target.dshHome, 'profiles', stageProfile),
    backupPath: join(plan.target.dshHome, 'profiles', `.${plan.profile}.plugin-backup-${suffix}`) }
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

async function activate(argv: readonly string[]): Promise<void> {
  const trust = await commandTrust(argv)
  const store = new ControlPlaneStore({ path: trust.ledger.path })
  let lock: ProfileLock | undefined
  try {
    let plan = store.getPlan(option(argv, '--plan-id')); assertPlanTrust(plan, trust)
    if (plan.status === 'activated') { process.stdout.write(`${JSON.stringify(plan)}\n`); return }
    plan = store.claimActivation({ planId: plan.id, expectedRevision: integerOption(argv, '--expected-revision'), leaseMs })
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
      const version = (await runBounded({ executable: trust.executor.path, args: ['--version'], environment, store, plan, capture: true })).trim()
      if (version !== plan.candidate.dshBaseline) throw new ControlPlaneCliError('ACTIVATION_BINDING', 'registered executor baseline differs from the approved dossier')
      await runBounded({ executable: trust.executor.path, args: ['plugin', '--profile', activationPaths.stageProfile, 'add',
        ...exactPackages(plan).map(item => `${item.package}@${item.version}`)], environment, store, plan })
      verifyApprovedPackagesInLockfile(await readSafeFile(join(activationPaths.stagePath, 'pnpm-lock.yaml'), 8 * 1024 * 1024), exactPackages(plan))
      // Configuration materialization is a staging integrity check only. It is
      // deliberately not called readiness, reload, shadow, canary or health.
      await runBounded({ executable: trust.executor.path, args: ['--profile', activationPaths.stageProfile, '--dump-config'], environment, store, plan })
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
      plan = store.claimActivation({ planId: plan.id, expectedRevision: plan.revision, leaseMs }); lock = await acquireProfileLock(store, plan)
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
      output = store.claimActivation({ planId: output.id, expectedRevision: output.revision, leaseMs }); lock = await acquireProfileLock(store, output)
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

async function localCommand(command: 'git' | 'pnpm', args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv, capture = false): Promise<string> {
  return runBounded({ executable: await executable(command, environment), args, cwd, environment, capture })
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
      generatorDigest, scope: [`plugins/${name}`], ttlMs: 900_000, idempotencyKey: option(argv, '--idempotency-key') })
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
    if (await realpath(plan.repository) !== plan.repository || await realpath(plan.worktree) !== plan.worktree) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source paths changed')
    const environment = inheritedEnvironment(trust)
    if ((await localCommand('git', ['rev-parse', 'HEAD'], plan.worktree, environment, true)).trim() !== plan.baseCommit
      || createHash('sha256').update(await readSafeFile(join(plan.repository, 'scripts', 'create-plugin.mjs'), 1_048_576)).digest('hex') !== plan.generatorDigest
      || (await localCommand('git', ['status', '--porcelain'], plan.worktree, environment, true)).trim() !== '') throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source plan base, generator or clean-worktree binding changed')
    plan = store.beginSourceChecks({ planId: plan.id, expectedRevision: plan.revision })
    try {
      await localCommand('pnpm', ['create:plugin', plan.name], plan.worktree, environment)
      await localCommand('pnpm', ['check'], plan.worktree, environment)
      const changes = (await localCommand('git', ['status', '--porcelain'], plan.worktree, environment, true)).split('\n').filter(Boolean)
      if (changes.some(line => !plan!.scope.some(scope => line.slice(3).startsWith(`${scope}/`) || line.slice(3) === scope))) throw new ControlPlaneCliError('SOURCE_BOUNDARY', 'source generator changed files outside its approved scope')
      plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: true })
    } catch (error) {
      plan = store.finishSourceChecks({ planId: plan.id, expectedRevision: plan.revision, succeeded: false })
      throw error
    }
    process.stdout.write(`${JSON.stringify(plan)}\n`)
  } finally { store.close() }
}

export async function runPluginControl(argv = process.argv.slice(2)): Promise<void> {
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
  throw new ControlPlaneCliError('INVALID_ARGUMENT', 'usage: dsh-plugin-control <discover|show|approve|activate|host-request|probe|attest|source-plan|scaffold>')
}
