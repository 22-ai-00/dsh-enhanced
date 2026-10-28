import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, statfs, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { LinuxCgroupLease, type LinuxCgroupDirectory, type LinuxCgroupIdentity, type LinuxCgroupSnapshot } from './linux-cgroups.js'
import { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxExecutionResourcesDigest,
  linuxExecutionPartialCleanupProofDigest, validateLinuxExecutionPartialCleanupProof,
  validateLinuxExecutionContract, validateLinuxExecutionIntent, validateLinuxExecutionResources,
  type LinuxExecutionContract, type LinuxExecutionIntent, type LinuxExecutionResources, type LinuxReceiptBinding,
  type LinuxExecutionPartialCleanupProof, type LinuxExecutionIntentV1, type LinuxRepositoryExecutionContract, type LinuxRepositoryExecutionIntent } from './linux-execution-contract.js'
import { runLinuxNamespace, runLinuxRepositoryNamespace, type LinuxCandidateIdentity } from './linux-namespace.js'
import type { IsolationFile, IsolationResult } from './types.js'
import { pruneResult, validateRetention } from './storage-policy.js'
import { verifyLinuxSystemSnapshot } from './linux-system-snapshot.js'
import { inspectLinuxRepositoryCandidate, inspectLinuxUserNamespace, linuxRepositoryImplementationDigest, validateLinuxRepositoryCandidateWitness,
  validateLinuxUserNamespaceWitness, verifyLinuxUserNamespaceMapping,
  type LinuxUserNamespaceWitness, type LinuxRepositoryCandidateWitness } from './linux-user-namespace.js'

export interface LinuxExecutionReceiptV1 {
  schemaVersion: 1
  intent: LinuxExecutionIntentV1
  resources: LinuxExecutionResources
  result: IsolationResult
  completedAt: number
  receiptDigest: string
}
export interface LinuxRepositoryArtifactSummary { path: string; bytes: number; sha256: string }
export interface LinuxRepositoryArtifact { path: string; bytes: Buffer; sha256: string }
export interface LinuxRepositoryExecutionReceipt extends Omit<LinuxExecutionReceiptV1, 'schemaVersion' | 'intent'> {
  schemaVersion: 2 | 3
  intent: LinuxRepositoryExecutionIntent
  repositoryArtifacts: LinuxRepositoryArtifactSummary[]
}
export type LinuxExecutionReceipt = LinuxExecutionReceiptV1 | LinuxRepositoryExecutionReceipt
export interface LinuxRepositoryExecutionContext { stateRoot: string; contract: LinuxRepositoryExecutionContract; intent: LinuxRepositoryExecutionIntent }
export interface LinuxRepositoryExecutionRequest {
  argv: readonly string[]
  archive: { bytes: Uint8Array; sha256: string }
  artifacts: readonly string[]
  readOnlyRoots?: readonly string[]
}
interface Context { stateRoot: string; contract: LinuxExecutionContract; intent: LinuxExecutionIntent }
interface Journal {
  schemaVersion: 1 | 2 | 3
  intent: LinuxExecutionIntent
  creator: LinuxCgroupIdentity
  phase: 'prepared' | 'creating-worker' | 'creating-keeper' | 'recorded' | 'keeper-admitted' | 'user-namespace-ready' | 'worker-admitted' | 'candidate-ready' | 'running' | 'settled' | 'prestart-quiesced' | 'unknown'
  worker: LinuxCgroupSnapshot | null
  keeper: LinuxCgroupSnapshot | null
  workerIdentity: LinuxCgroupIdentity | null
  keeperIdentity: LinuxCgroupIdentity | null
  namespace: LinuxCgroupDirectory | null
  result: IsolationResult | null
  repositoryArtifacts?: LinuxRepositoryArtifactSummary[] | null
  userNamespace?: LinuxUserNamespaceWitness | null
  candidateIdentity?: LinuxRepositoryCandidateWitness | null
}
const active = new Set<string>()
// This is a drain witness, never an execution grant. It permits only cleanup
// after this exact Host has awaited every internal create/admit continuation.
// Failure to retain a witness is conservative: durable recovery waits for death.
const completedRuns = new Map<string, string>()
const MAX_COMPLETED_RUNS = 4096
const controllers = ['cpu', 'memory', 'pids', 'freezer'] as const
const MAX_RECORD_BYTES = 14 * 1024 * 1024
const phases = ['prepared', 'creating-worker', 'creating-keeper', 'recorded', 'keeper-admitted', 'user-namespace-ready', 'worker-admitted', 'candidate-ready', 'running', 'settled', 'prestart-quiesced', 'unknown']
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
    : JSON.stringify(value)
const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex')
function fail(message: string): never { throw new Error(`linux execution: ${message}`) }
function keys(value: unknown, expected: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join() !== [...expected].sort().join()) fail('record fields differ')
}
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const boot = async (): Promise<string> => (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().toLowerCase()
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true } catch (error) { if (missing(error)) return false; throw error } }
function platform(): number {
  const uid = process.getuid?.()
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || !uid) fail('requires non-root Linux x64/arm64')
  return uid
}
async function privateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || /[\p{Cc}\\]/u.test(path) || await realpath(path) !== path) fail('state path is not canonical')
  const info = await lstat(path)
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== platform() || (info.mode & 0o077) !== 0) fail('state directory is not owner-private')
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function childDirectory(parent: string, name: string): Promise<void> {
  await privateDirectory(parent)
  try { await mkdir(join(parent, name), { mode: 0o700 }); await syncDirectory(parent) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await privateDirectory(join(parent, name))
}
async function setup(stateRoot: string): Promise<void> {
  await privateDirectory(stateRoot)
  for (const name of ['jobs', 'receipts', 'namespaces']) await childDirectory(stateRoot, name)
}
function paths(ctx: Context): { journal: string; receipt: string; partial: string } {
  const name = `${ctx.intent.jobId}-${ctx.intent.nativeNonce}.json`
  return { journal: join(ctx.stateRoot, 'jobs', name), receipt: join(ctx.stateRoot, 'receipts', name),
    partial: join(ctx.stateRoot, 'receipts', name.replace(/\.json$/u, '.partial.json')) }
}
async function readRecord(path: string): Promise<unknown> {
  await privateDirectory(dirname(path))
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat(), named = await lstat(path)
    if (!info.isFile() || info.uid !== platform() || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1
      || info.size <= 0 || info.size > MAX_RECORD_BYTES || info.dev !== named.dev || info.ino !== named.ino || named.isSymbolicLink()) fail('private record identity differs')
    const bytes = await handle.readFile()
    const after = await handle.stat()
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('private record changed while reading')
    return JSON.parse(bytes.toString('utf8')) as unknown
  } finally { await handle.close() }
}
async function emptyPlaceholder(path: string): Promise<LinuxCgroupDirectory | undefined> {
  await privateDirectory(dirname(path))
  let handle
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) { if (missing(error)) return undefined; throw error }
  try {
    const info = await handle.stat(), named = await lstat(path)
    if (!info.isFile() || info.uid !== platform() || (info.mode & 0o7777) !== 0o600 || info.nlink !== 1
      || named.isSymbolicLink() || named.dev !== info.dev || named.ino !== info.ino || named.nlink !== 1
      || named.uid !== info.uid || named.mode !== info.mode || named.size !== info.size) fail('receipt placeholder identity differs')
    const after = await handle.stat()
    if (after.nlink !== 1 || after.size !== info.size || after.ctimeMs !== info.ctimeMs || after.mode !== info.mode || after.uid !== info.uid) fail('receipt placeholder changed')
    return info.size === 0 ? { path, dev: info.dev, ino: info.ino } : undefined
  } finally { await handle.close() }
}
async function repairPlaceholder(path: string): Promise<void> {
  if (!await exists(path)) return
  const identity = await emptyPlaceholder(path)
  if (!identity) fail('refusing to replace nonempty receipt')
  const info = await lstat(path)
  if (!info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino || info.size !== 0 || info.nlink !== 1
    || info.uid !== platform() || (info.mode & 0o7777) !== 0o600) fail('receipt placeholder changed')
  await unlink(path)
  await syncDirectory(dirname(path))
}
async function writeRecord(path: string, value: unknown, fresh = false): Promise<void> {
  await privateDirectory(dirname(path))
  const data = JSON.stringify(value)
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES) fail('private record exceeds bounds')
  // Reserve initial identity exclusively. A crash before rename leaves an invalid
  // record, which fails closed; no external creation has been authorized yet.
  if (fresh) {
    const reservation = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await reservation.sync() } finally { await reservation.close() }
    await syncDirectory(dirname(path))
  } else await readRecord(path)
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await handle.writeFile(data); await handle.sync() } finally { await handle.close() }
  try { await rename(temporary, path); await syncDirectory(dirname(path)) }
  finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
}
async function currentIdentity(pid: number): Promise<LinuxCgroupIdentity | undefined> {
  try {
    const [raw, status, bootId] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/status`, 'utf8'), boot()])
    const fields = raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/u)
    const uid = /^Uid:\s+(\d+)/mu.exec(status)
    if (!uid || !/^[1-9][0-9]*$/u.test(fields[19] ?? '')) fail('process identity unavailable')
    if (fields[0] === 'Z' || fields[0] === 'X') return undefined
    return { pid, startTicks: fields[19]!, uid: Number(uid[1]), bootId }
  } catch (error) { if (missing(error) || (error as NodeJS.ErrnoException).code === 'ESRCH') return undefined; throw error }
}
function validateIdentity(value: unknown, intent: LinuxExecutionIntent): asserts value is LinuxCgroupIdentity {
  keys(value, ['pid', 'startTicks', 'uid', 'bootId'])
  if (!positive(value.pid) || typeof value.startTicks !== 'string' || !/^[1-9][0-9]{0,63}$/u.test(value.startTicks)
    || value.uid !== intent.uid || value.bootId !== intent.bootId) fail('journal process identity differs')
}
async function rootsIdentity(contract: LinuxExecutionContract, expected?: LinuxExecutionIntent): Promise<Record<string, LinuxCgroupDirectory>> {
  if (contract.cgroupRoots.mode !== 'v1') fail('cgroup v2 process placement is not yet verified')
  const entries: Record<string, LinuxCgroupDirectory> = {}
  const mountinfo = (await readFile('/proc/self/mountinfo', 'utf8')).split('\n')
  for (const key of controllers) {
    const path = contract.cgroupRoots[key], info = await lstat(path)
    const mount = path.split('/').slice(0, 5).join('/')
    if (await realpath(path) !== path || !info.isDirectory() || info.isSymbolicLink() || info.uid !== platform() || (info.mode & 0o022) !== 0
      || (await statfs(path)).type !== 0x27e0eb || mountinfo.filter(line => {
        const [before, after] = line.split(' - '), fields = before?.split(' '), fs = after?.split(' ')
        return fields?.[4] === mount && fs?.[0] === 'cgroup' && fs[2]?.split(',').includes(key)
      }).length !== 1) fail('delegated root identity differs')
    entries[key] = { path, dev: info.dev, ino: info.ino }
    if (expected && canonical(entries[key]) !== canonical(expected.roots[key])) fail('delegated root changed')
  }
  return entries
}
async function context(input: Context): Promise<Context> {
  platform()
  const contract = validateLinuxExecutionContract(input.contract), intent = validateLinuxExecutionIntent(input.intent, contract)
  await privateDirectory(input.stateRoot)
  for (const name of ['jobs', 'receipts', 'namespaces']) await privateDirectory(join(input.stateRoot, name))
  if (intent.uid !== platform() || intent.namespacePath !== join(input.stateRoot, 'namespaces', `namespace-${intent.jobId}-${intent.nativeNonce}`)) fail('intent state path differs')
  if (await boot() !== intent.bootId) fail('boot changed; recovery remains unknown')
  await rootsIdentity(contract, intent)
  return { stateRoot: input.stateRoot, contract, intent }
}
function validateSnapshot(value: unknown, kind: 'worker' | 'keeper', ctx: Context): asserts value is LinuxCgroupSnapshot {
  keys(value, ['schemaVersion', 'mode', 'bootId', 'jobId', 'nonce', 'uid', 'deadline', 'limits', 'directories'])
  const expectedLimits = kind === 'worker' ? { memoryMiB: ctx.contract.limits.memoryMiB, pidsLimit: ctx.contract.limits.pidsLimit, cpus: ctx.contract.limits.cpus } : ctx.contract.keeperLimits
  const nonce = kind === 'worker' ? ctx.intent.workerNonce : ctx.intent.keeperNonce
  if (value.schemaVersion !== 1 || value.mode !== 'v1' || value.bootId !== ctx.intent.bootId || value.jobId !== ctx.intent.jobId
    || value.nonce !== nonce || value.uid !== ctx.intent.uid || value.deadline !== ctx.intent.deadline || canonical(value.limits) !== canonical(expectedLimits)) fail('snapshot binding differs')
  keys(value.directories, controllers)
  for (const key of controllers) {
    const item = value.directories[key], parent = ctx.intent.roots[key]!
    keys(item, ['path', 'dev', 'ino'])
    if (item.path !== join(parent.path, `job-${ctx.intent.jobId}-${nonce}`) || item.dev !== parent.dev || !positive(item.ino) || item.ino === parent.ino) fail('snapshot directory differs')
  }
}
function validateResult(value: unknown, ctx: Context): asserts value is IsolationResult {
  if (!value || typeof value !== 'object') fail('invalid result')
  const item = value as Record<string, unknown>
  keys(item, ['jobId', 'status', 'quiescent', 'stdout', 'stderr', 'artifacts', ...(Object.hasOwn(item, 'exitCode') ? ['exitCode'] : []), ...(Object.hasOwn(item, 'reason') ? ['reason'] : [])])
  if (item.jobId !== ctx.intent.jobId || !['succeeded', 'failed', 'cancelled', 'timed-out', 'unknown'].includes(item.status as string)
    || typeof item.quiescent !== 'boolean' || typeof item.stdout !== 'string' || typeof item.stderr !== 'string'
    || !item.stdout.isWellFormed() || !item.stderr.isWellFormed() || Buffer.byteLength(item.stdout) + Buffer.byteLength(item.stderr) > ctx.contract.limits.maxOutputBytes
    || !Array.isArray(item.artifacts) || item.artifacts.length > ctx.contract.limits.maxFiles
    || Object.hasOwn(item, 'reason') && (typeof item.reason !== 'string' || item.reason.length > 8192)
    || Object.hasOwn(item, 'exitCode') && (!Number.isSafeInteger(item.exitCode) || (item.exitCode as number) < 0 || (item.exitCode as number) > 255)) fail('result bounds differ')
  let bytes = 0
  const names = new Set<string>()
  for (const artifact of item.artifacts) {
    keys(artifact, ['path', 'content'])
    if (typeof artifact.path !== 'string' || !safePath(artifact.path) || names.has(artifact.path) || typeof artifact.content !== 'string' || !artifact.content.isWellFormed()) fail('invalid result artifact')
    names.add(artifact.path); bytes += Buffer.byteLength(artifact.content)
  }
  if (bytes > ctx.contract.limits.maxArtifactBytes || ctx.contract.schemaVersion !== 1 && item.artifacts.length !== 0) fail('result artifacts exceed bounds')
}
async function readJournal(ctx: Context): Promise<Journal> {
  const value = await readRecord(paths(ctx).journal)
  keys(value, ['schemaVersion', 'intent', 'creator', 'phase', 'worker', 'keeper', 'workerIdentity', 'keeperIdentity', 'namespace', 'result', ...(ctx.intent.schemaVersion !== 1 ? ['repositoryArtifacts'] : []), ...(ctx.intent.schemaVersion === 3 ? ['userNamespace', 'candidateIdentity'] : [])])
  if (value.schemaVersion !== ctx.intent.schemaVersion || canonical(value.intent) !== canonical(ctx.intent) || !phases.includes(value.phase as string)) fail('journal intent or phase differs')
  validateIdentity(value.creator, ctx.intent)
  for (const kind of ['worker', 'keeper'] as const) {
    if (value[kind] !== null) validateSnapshot(value[kind], kind, ctx)
    const identity = value[`${kind}Identity`]
    if (identity !== null) validateIdentity(identity, ctx.intent)
  }
  if (value.namespace !== null) {
    keys(value.namespace, ['path', 'dev', 'ino'])
    if (value.namespace.path !== ctx.intent.namespacePath || !Number.isSafeInteger(value.namespace.dev) || !positive(value.namespace.ino)) fail('namespace journal identity differs')
  }
  if (value.result !== null) validateResult(value.result, ctx)
  if (ctx.intent.schemaVersion !== 1) {
    if (value.phase === 'settled') validateArtifactSummaries(value.repositoryArtifacts, ctx)
    else if (value.repositoryArtifacts !== null) fail('repository journal artifact phase differs')
  }
  if (ctx.contract.schemaVersion === 3) {
    if (value.userNamespace !== null) {
      const witness = validateLinuxUserNamespaceWitness(value.userNamespace)
      if (witness.bootId !== ctx.intent.bootId || canonical(witness.mapping) !== canonical(ctx.contract.userNamespace)
        || !value.keeperIdentity || !value.namespace) fail('journal namespace witness differs')
    }
    if (value.candidateIdentity !== null) {
      if (!value.userNamespace || !value.workerIdentity) fail('candidate witness lacks namespace admission')
      validateLinuxRepositoryCandidateWitness(value.candidateIdentity, value.userNamespace as LinuxUserNamespaceWitness)
    }
    if (['prepared', 'creating-worker', 'creating-keeper', 'recorded', 'keeper-admitted', 'prestart-quiesced'].includes(value.phase as string)
        && (value.userNamespace || value.candidateIdentity)
      || ['user-namespace-ready', 'worker-admitted'].includes(value.phase as string) && value.candidateIdentity
      || ['user-namespace-ready', 'worker-admitted', 'candidate-ready', 'running'].includes(value.phase as string) && !value.userNamespace
      || ['candidate-ready', 'running'].includes(value.phase as string) && !value.candidateIdentity
      || value.result && (value.result as IsolationResult).status === 'succeeded' && (!value.candidateIdentity || !value.userNamespace)) fail('journal candidate admission differs')
  } else if (['user-namespace-ready', 'candidate-ready'].includes(value.phase as string)) fail('legacy journal used a mapped admission phase')
  if (value.keeper && !value.worker || value.phase === 'prepared' && (value.worker || value.keeper || value.namespace || value.result)
    || ['recorded', 'keeper-admitted', 'user-namespace-ready', 'worker-admitted', 'candidate-ready', 'running', 'settled'].includes(value.phase as string) && (!value.worker || !value.keeper)
    || value.phase === 'settled' && (!value.result || !(value.result as IsolationResult).quiescent)) fail('journal phase fields differ')
  if (value.workerIdentity && (!value.worker || !value.keeperIdentity) || value.keeperIdentity && (!value.keeper || !value.namespace)
    || value.namespace && !value.keeper
    || ['prepared', 'creating-worker', 'creating-keeper', 'recorded'].includes(value.phase as string) && (value.workerIdentity || value.keeperIdentity || value.namespace || value.result)
    || value.phase === 'creating-worker' && (value.worker || value.keeper)
    || value.phase === 'creating-keeper' && (!value.worker || value.keeper)
    || ['keeper-admitted', 'user-namespace-ready'].includes(value.phase as string) && (!value.keeperIdentity || value.workerIdentity || value.result)
    || ['worker-admitted', 'candidate-ready', 'running'].includes(value.phase as string) && (!value.workerIdentity || value.result)) fail('journal phase fields differ')
  if (value.phase === 'prestart-quiesced' && (value.worker && value.keeper || value.workerIdentity || value.keeperIdentity || value.namespace
    || !value.result || !(value.result as IsolationResult).quiescent || (value.result as IsolationResult).status === 'succeeded')) fail('partial cleanup journal differs')
  return value as unknown as Journal
}
function resources(journal: Journal, ctx: Context): LinuxExecutionResources | undefined {
  return journal.worker && journal.keeper ? validateLinuxExecutionResources({ schemaVersion: ctx.contract.schemaVersion === 3 ? 2 : 1,
    intentDigest: linuxExecutionIntentDigest(ctx.intent), worker: journal.worker, keeper: journal.keeper,
    ...(ctx.contract.schemaVersion === 3 ? { userNamespace: journal.userNamespace && journal.keeperIdentity
      ? { witness: journal.userNamespace, keeperGate: journal.keeperIdentity } : null } : {}) }, ctx.intent, ctx.contract) : undefined
}
async function creatorCanReconcile(ctx: Context, journal: Journal): Promise<boolean> {
  if (active.has(paths(ctx).journal)) return false
  const creator = await currentIdentity(journal.creator.pid)
  if (!creator || canonical(creator) !== canonical(journal.creator)) return true
  return creator.pid === process.pid && canonical(await currentIdentity(process.pid)) === canonical(journal.creator)
    && completedRuns.get(paths(ctx).journal) === drainWitness(ctx, journal)
}
function drainWitness(ctx: Context, journal: Journal): string {
  return digest({ intentDigest: linuxExecutionIntentDigest(ctx.intent), creator: journal.creator })
}
async function readOptionalReceipt(ctx: Context, journal: Journal, path: string): Promise<unknown | undefined> {
  try { return await readRecord(path) }
  catch (error) {
    if (missing(error)) return undefined
    // The exclusive fresh-file reservation is the sole recoverable malformed
    // record. Nonempty/corrupt, linked or writable receipts stay untouched.
    if (await emptyPlaceholder(path) && await creatorCanReconcile(ctx, journal)) return undefined
    throw error
  }
}
function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && !isAbsolute(path) && !/[\p{Cc}\\]/u.test(path)
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}
async function checkLive(ctx: Context, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || Date.now() >= ctx.intent.deadline) fail('execution authority ended')
  if (await boot() !== ctx.intent.bootId) fail('boot changed')
  await rootsIdentity(ctx.contract, ctx.intent)
  if (signal?.aborted || Date.now() >= ctx.intent.deadline) fail('execution authority ended')
}
async function boundedAdmission<T>(operation: () => Promise<T>, signal: AbortSignal, deadline: number): Promise<T> {
  if (signal.aborted || Date.now() >= deadline) fail('execution authority ended')
  let abort: () => void = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const ended = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('linux execution: execution authority ended'))
    timer = setTimeout(abort, Math.max(1, deadline - Date.now()))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  try { return await Promise.race([Promise.resolve().then(operation), ended]) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
}

/** Persists intent without creating cgroups or admitting a process. The Host must
 * persist this value in its ledger and mark dispatch before calling run(). */
interface PrepareInput { stateRoot: string; contract: LinuxExecutionContract;
  job: { id: string; requestDigest: string; nativeResourceId: string; nativeNonce: string; deadline: number } }
export async function prepareLinuxExecutionIntent(input: PrepareInput): Promise<LinuxExecutionIntent> {
  if (input.contract.schemaVersion !== 1) fail('repository authority requires the repository API')
  return await prepareIntent(input)
}
async function prepareIntent(input: PrepareInput, repository?: LinuxRepositoryExecutionIntent['repository']): Promise<LinuxExecutionIntent> {
  const uid = platform(), contract = validateLinuxExecutionContract(input.contract)
  if (contract.cgroupRoots.mode !== 'v1') fail('cgroup v2 process placement is not yet verified')
  if (input.job.deadline <= Date.now() || !positive(input.job.deadline) || contract.limits.workspaceMiB > (contract.schemaVersion !== 1 ? 8192 : 4096) || contract.limits.maxDurationMs > 1_800_000) fail('invalid execution deadline or namespace limits')
  const intent = validateLinuxExecutionIntent({ schemaVersion: contract.schemaVersion, ...(repository ? { repository } : {}), jobId: input.job.id, requestDigest: input.job.requestDigest,
    nativeResourceId: input.job.nativeResourceId, nativeNonce: input.job.nativeNonce,
    contractDigest: linuxExecutionContractDigest(contract), bootId: await boot(), uid, deadline: input.job.deadline,
    namespacePath: join(input.stateRoot, 'namespaces', `namespace-${input.job.id}-${input.job.nativeNonce}`),
    workerNonce: randomBytes(16).toString('hex'), keeperNonce: randomBytes(16).toString('hex'), roots: await rootsIdentity(contract) }, contract)
  await setup(input.stateRoot)
  if (contract.schemaVersion !== 1) await childDirectory(input.stateRoot, 'artifacts')
  const creator = await currentIdentity(process.pid)
  if (!creator) fail('Host identity unavailable')
  const ctx = { stateRoot: input.stateRoot, contract, intent }
  await checkLive(ctx)
  if (await exists(intent.namespacePath) || await exists(paths(ctx).receipt) || await exists(paths(ctx).partial)) fail('execution identity already exists')
  await writeRecord(paths(ctx).journal, { schemaVersion: intent.schemaVersion, ...(intent.schemaVersion !== 1 ? { repositoryArtifacts: null } : {}), intent, creator, phase: 'prepared', worker: null, keeper: null,
    workerIdentity: null, keeperIdentity: null, namespace: null, result: null,
    ...(intent.schemaVersion === 3 ? { userNamespace: null, candidateIdentity: null } : {}) } satisfies Journal, true)
  return intent
}

async function absentGroups(ctx: Context): Promise<boolean> {
  for (const nonce of [ctx.intent.workerNonce, ctx.intent.keeperNonce]) for (const root of Object.values(ctx.intent.roots)) {
    if (await exists(join(root.path, `job-${ctx.intent.jobId}-${nonce}`))) return false
  }
  return true
}
async function removeUnrecorded(ctx: Context, nonce: string): Promise<void> {
  // An interrupted create may lack a snapshot. Its durable nonce authorizes only
  // absence/empty-directory proof, never signaling an unidentified process.
  for (const root of Object.values(ctx.intent.roots).reverse()) {
    await rootsIdentity(ctx.contract, ctx.intent)
    const path = join(root.path, `job-${ctx.intent.jobId}-${nonce}`)
    if (!(await exists(path))) continue
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ctx.intent.uid || info.dev !== root.dev
      || (info.mode & 0o022) !== 0 || await realpath(path) !== path || (await statfs(path)).type !== 0x27e0eb) fail('unrecorded cgroup identity differs')
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.some(entry => entry.isDirectory() || entry.isSymbolicLink()) || (await readFile(join(path, 'cgroup.procs'), 'utf8')).trim() !== '') fail('unrecorded cgroup is not provably empty')
    const after = await lstat(path)
    if (info.dev !== after.dev || info.ino !== after.ino) fail('unrecorded cgroup changed')
    await rmdir(path)
  }
}
class LinuxImplementationChangedError extends Error {}
function checkImplementation(ctx: Context): void {
  if (ctx.contract.schemaVersion !== 3) return
  let matches = false
  try { matches = linuxRepositoryImplementationDigest() === ctx.contract.implementationDigest }
  catch { /* Unavailable packaged bytes cannot grant cleanup authority. */ }
  if (!matches) throw new LinuxImplementationChangedError('linux execution: repository identity implementation changed')
}
async function cleanLease(lease: LinuxCgroupLease, ctx: Context): Promise<void> {
  // Recovery and a still-running Host use the same frozen implementation
  // authority as dispatch. Changed helpers cannot inherit an old job's kill grant.
  checkImplementation(ctx)
  // A v1 pidfd helper has its own three-second subprocess cap. Leave room for
  // that helper inside the namespace primitive's five-second stop callback.
  if (!await lease.terminateAndProve(1_000) || !await lease.removeWhenEmpty()) fail('cgroup cleanup unproven')
}
async function cleanNamespace(ctx: Context, journal: Journal): Promise<void> {
  const path = ctx.intent.namespacePath
  if (!await exists(path)) return
  await privateDirectory(path)
  const info = await lstat(path)
  if (journal.namespace && (info.dev !== journal.namespace.dev || info.ino !== journal.namespace.ino)) fail('namespace directory changed')
  // After every cgroup has gone, private mounts are gone too. Only the fixed
  // keeper's small staging skeleton may remain on the Host filesystem.
  let count = 0, bytes = 0
  const walk = async (directory: string, relative: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name
      if (++count > 80) fail('namespace staging inventory exceeds bounds')
      const target = join(directory, entry.name), item = await lstat(target)
      if (item.isSymbolicLink() || item.uid !== ctx.intent.uid || (item.mode & 0o022) !== 0 || item.dev !== info.dev) fail('namespace staging identity differs')
      if (item.isDirectory()) {
        if (!/^(?:workspace|tmp|shm|input|identity|immutable(?:\/(?:usr|lib|lib64|runtime(?:\/(?:[0-9]|1[0-5]))?))?)$/u.test(name)) fail('unexpected namespace directory')
        await walk(target, name)
      } else {
        if (!item.isFile() || item.nlink !== 1 || !/^(?:seccomp\.bpf|identity\/(?:passwd|group|nsswitch\.conf|hosts))$/u.test(name)) fail('unexpected namespace file')
        bytes += item.size
        if (bytes > 70_000) fail('namespace staging files exceed bounds')
      }
    }
  }
  await walk(path, '')
  await rm(path, { recursive: true })
  await syncDirectory(dirname(path))
  if (await exists(path)) fail('namespace cleanup unproven')
}
function receiptValue(ctx: Context, journal: Journal, value: unknown): LinuxExecutionReceipt {
  keys(value, ['schemaVersion', 'intent', 'resources', 'result', 'completedAt', 'receiptDigest', ...(ctx.intent.schemaVersion !== 1 ? ['repositoryArtifacts'] : [])])
  if (value.schemaVersion !== ctx.intent.schemaVersion || canonical(value.intent) !== canonical(ctx.intent) || !positive(value.completedAt)
    || value.completedAt < 1 || value.completedAt > Date.now() + 1000 || typeof value.receiptDigest !== 'string') fail('receipt binding differs')
  const complete = validateLinuxExecutionResources(value.resources, ctx.intent, ctx.contract)
  validateResult(value.result, ctx)
  if (ctx.intent.schemaVersion !== 1) {
    validateArtifactSummaries(value.repositoryArtifacts, ctx)
    if ((value.result.status !== 'succeeded' && value.repositoryArtifacts.length !== 0)
      || value.result.status === 'succeeded' && canonical(value.repositoryArtifacts.map(item => item.path)) !== canonical((ctx.intent as LinuxRepositoryExecutionIntent).repository.artifacts)) fail('receipt artifact outcome differs')
    if (canonical(value.repositoryArtifacts) !== canonical(journal.repositoryArtifacts)) fail('receipt artifact summaries differ')
  }
  const { receiptDigest, ...body } = value
  if (!value.result.quiescent || journal.phase !== 'settled' || canonical(value.result) !== canonical(journal.result)
    || canonical(complete) !== canonical(resources(journal, ctx)) || receiptDigest !== digest(body)) fail('receipt content differs')
  return value as unknown as LinuxExecutionReceipt
}
export function linuxExecutionReceiptBinding(receipt: LinuxExecutionReceipt): LinuxReceiptBinding {
  const { receiptDigest, ...body } = receipt
  if (receiptDigest !== digest(body)) fail('receipt digest differs')
  return { requestDigest: receipt.intent.requestDigest, nativeNonce: receipt.intent.nativeNonce,
    nativeResourceId: receipt.intent.nativeResourceId, intentDigest: linuxExecutionIntentDigest(receipt.intent),
    resourcesDigest: linuxExecutionResourcesDigest(receipt.resources), receiptDigest }
}
/** A private receipt alone never proves cleanup: recheck roots, boot and actual absence. */
export async function readLinuxExecutionReceipt(input: Context): Promise<LinuxExecutionReceipt | undefined> {
  const ctx = await context(input), journal = await readJournal(ctx)
  const raw = await readOptionalReceipt(ctx, journal, paths(ctx).receipt)
  if (raw === undefined) return undefined
  const receipt = receiptValue(ctx, journal, raw)
  if (!await absentGroups(ctx) || await exists(ctx.intent.namespacePath)) fail('receipt resources still present')
  return receipt
}
export async function readLinuxExecutionPartialCleanupProof(input: Context): Promise<LinuxExecutionPartialCleanupProof | undefined> {
  const ctx = await context(input), journal = await readJournal(ctx)
  const raw = await readOptionalReceipt(ctx, journal, paths(ctx).partial)
  if (raw === undefined) return undefined
  const proof = validateLinuxExecutionPartialCleanupProof(raw)
  if (journal.phase !== 'prestart-quiesced' || resources(journal, ctx) || proof.jobId !== ctx.intent.jobId
    || proof.requestDigest !== ctx.intent.requestDigest || proof.nativeResourceId !== ctx.intent.nativeResourceId
    || proof.nativeNonce !== ctx.intent.nativeNonce || proof.intentDigest !== linuxExecutionIntentDigest(ctx.intent)
    || proof.observedAt > Date.now() + 1000 || !await absentGroups(ctx) || await exists(ctx.intent.namespacePath)) fail('partial cleanup proof differs')
  return proof
}
async function persistPartialProof(ctx: Context, journal: Journal, result: IsolationResult, repairIncomplete = false): Promise<LinuxExecutionPartialCleanupProof> {
  if (!result.quiescent || resources(journal, ctx) || journal.workerIdentity || journal.keeperIdentity || journal.namespace
    || !await absentGroups(ctx) || await exists(ctx.intent.namespacePath)) fail('cannot prove prestart cleanup')
  journal.phase = 'prestart-quiesced'; journal.result = result
  await writeRecord(paths(ctx).journal, journal)
  const body = { schemaVersion: 1 as const, jobId: ctx.intent.jobId, requestDigest: ctx.intent.requestDigest,
    nativeResourceId: ctx.intent.nativeResourceId, nativeNonce: ctx.intent.nativeNonce, intentDigest: linuxExecutionIntentDigest(ctx.intent),
    observedAt: Date.now(), workerAbsent: true as const, keeperAbsent: true as const, namespaceAbsent: true as const }
  const proof = validateLinuxExecutionPartialCleanupProof({ ...body, proofDigest: linuxExecutionPartialCleanupProofDigest(body) })
  if (repairIncomplete) await repairPlaceholder(paths(ctx).partial)
  await writeRecord(paths(ctx).partial, proof, true)
  return proof
}
async function persistReceipt(ctx: Context, journal: Journal, complete: LinuxExecutionResources, result: IsolationResult, repairIncomplete = false): Promise<LinuxExecutionReceipt> {
  if (!result.quiescent || !await absentGroups(ctx) || await exists(ctx.intent.namespacePath)) fail('cannot receipt unproven cleanup')
  if (canonical(complete) !== canonical(resources(journal, ctx))
    || ctx.contract.schemaVersion === 3 && result.status === 'succeeded' && (!journal.userNamespace || !journal.candidateIdentity)) fail('cannot receipt missing admission')
  if (ctx.intent.schemaVersion !== 1 && journal.repositoryArtifacts == null) journal.repositoryArtifacts = []
  journal.phase = 'settled'; journal.result = result
  await writeRecord(paths(ctx).journal, journal)
  const body = { schemaVersion: ctx.intent.schemaVersion, intent: ctx.intent, resources: complete, result, completedAt: Date.now(),
    ...(ctx.intent.schemaVersion !== 1 ? { repositoryArtifacts: journal.repositoryArtifacts } : {}) }
  const receipt = { ...body, receiptDigest: digest(body) } as LinuxExecutionReceipt
  if (repairIncomplete) await repairPlaceholder(paths(ctx).receipt)
  await writeRecord(paths(ctx).receipt, receipt, true)
  return receipt
}

/** Host-only result retention. The synchronous callback must persist the ledger
 * marker before either private evidence copy is replaced. A mixed pair after a
 * crash is independently verifiable against that marker and can be retried. */
export async function retainLinuxExecutionResult(input: Context & { resources: LinuxExecutionResources;
  result: IsolationResult; fenced: () => boolean; compact: () => IsolationResult | undefined }): Promise<number> {
  const ctx = await context(input), locations = paths(ctx)
  if (ctx.contract.schemaVersion !== 1) fail('repository receipts require repository retention')
  const complete = validateLinuxExecutionResources(input.resources, ctx.intent, ctx.contract)
  const intentDigest = linuxExecutionIntentDigest(ctx.intent), resourcesDigest = linuxExecutionResourcesDigest(complete)
  if (!input.fenced() || active.has(locations.journal) || input.result.jobId !== ctx.intent.jobId || !input.result.quiescent
    || !['succeeded', 'failed', 'cancelled', 'timed-out'].includes(input.result.status)) fail('retention authority differs')
  if (!await absentGroups(ctx) || await exists(ctx.intent.namespacePath)) fail('retention resources still present')
  const originals = await Promise.all([readRecord(locations.journal), readRecord(locations.receipt)])
  if ((originals[0] as Record<string, unknown>).kind !== 'result-pruned'
    && (originals[1] as Record<string, unknown>).kind !== 'result-pruned') {
    receiptValue(ctx, await readJournal(ctx), originals[1])
  }
  const resultMatches = (value: unknown, expected: IsolationResult): void => {
    validateResult(value, ctx)
    const matched = expected.retention ? pruneResult(value, expected.retention.prunedAt) : value
    if (!matched || canonical(matched) !== canonical(expected)) fail('retention result differs')
  }
  let receiptDigest: string | undefined
  for (let index = 0; index < originals.length; index++) {
    const value = originals[index] as Record<string, unknown>
    if (value.kind === 'result-pruned') {
      keys(value, ['schemaVersion', 'kind', 'record', 'intentDigest', 'resourcesDigest', 'receiptDigest', 'originalRecordDigest', 'result', 'tombstoneDigest'])
      const { tombstoneDigest, ...body } = value
      if (value.schemaVersion !== 1 || value.record !== (index === 0 ? 'journal' : 'receipt')
        || value.intentDigest !== intentDigest || value.resourcesDigest !== resourcesDigest
        || !input.result.retention || !validateRetention(input.result.retention)
        || canonical(value.result) !== canonical(input.result) || tombstoneDigest !== digest(body)
        || typeof value.receiptDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.receiptDigest)
        || typeof value.originalRecordDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(value.originalRecordDigest)) fail('retention tombstone differs')
    } else if (index === 0) {
      const journal = await readJournal(ctx)
      if (digest(journal) !== digest(value) || journal.phase !== 'settled'
        || canonical(resources(journal, ctx)) !== canonical(complete)) fail('retention journal differs')
      resultMatches(journal.result, input.result)
    } else {
      keys(value, ['schemaVersion', 'intent', 'resources', 'result', 'completedAt', 'receiptDigest'])
      const { receiptDigest: recordedDigest, ...body } = value
      if (value.schemaVersion !== 1 || canonical(value.intent) !== canonical(ctx.intent)
        || canonical(validateLinuxExecutionResources(value.resources, ctx.intent, ctx.contract)) !== canonical(complete)
        || !positive(value.completedAt) || value.completedAt > Date.now() + 1000 || recordedDigest !== digest(body)) fail('retention receipt differs')
      resultMatches(value.result, input.result)
    }
    if (index === 1 || value.kind === 'result-pruned') {
      if (receiptDigest && receiptDigest !== value.receiptDigest) fail('retention receipt identity differs')
      receiptDigest = value.receiptDigest as string
    }
  }
  if (!input.fenced()) fail('retention authority ended')
  const retained = input.compact()
  if (!retained?.retention || !validateRetention(retained.retention)
    || canonical(retained) !== canonical(input.result.retention ? input.result : pruneResult(input.result, retained.retention.prunedAt))) fail('retention marker not persisted')
  let removedBytes = 0
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index] as Record<string, unknown>
    if (original.kind === 'result-pruned') continue
    const path = index === 0 ? locations.journal : locations.receipt
    const body = { schemaVersion: 1, kind: 'result-pruned', record: index === 0 ? 'journal' : 'receipt',
      intentDigest, resourcesDigest, receiptDigest, originalRecordDigest: digest(original), result: retained }
    const tombstone = { ...body, tombstoneDigest: digest(body) }
    const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(JSON.stringify(tombstone)); await handle.sync() } finally { await handle.close() }
      // Recheck the exact file and controller/version immediately before rename.
      if (digest(await readRecord(path)) !== digest(original) || !input.fenced()) fail('retention evidence changed')
      await rename(temporary, path)
      await syncDirectory(dirname(path))
      removedBytes += Math.max(0, Buffer.byteLength(JSON.stringify(original)) - Buffer.byteLength(JSON.stringify(tombstone)))
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
  }
  return removedBytes
}

type RunInput = Context & { argv: readonly string[]; files: readonly IsolationFile[];
  artifacts?: readonly string[]; readOnlyRoots?: readonly string[]; signal: AbortSignal;
  recordResources: (value: LinuxExecutionResources) => Promise<void>; authorizeStart: () => Promise<boolean> | boolean }
type RunOutcome = { result: IsolationResult; resources?: LinuxExecutionResources; receipt?: LinuxExecutionReceipt; partialProof?: LinuxExecutionPartialCleanupProof }
export async function runLinuxExecution(input: RunInput): Promise<RunOutcome> {
  if (input.contract.schemaVersion !== 1) fail('repository authority requires the repository API')
  return await runExecution(input)
}
async function runExecution(input: RunInput, archive?: { bytes: Buffer; sha256: string }): Promise<RunOutcome> {
  const ctx = await context(input), key = paths(ctx).journal
  if (completedRuns.has(key)) fail('execution is single-use; drained runs are recovery-only')
  if (active.has(key)) fail('execution is already owned')
  active.add(key)
  let ownedJournal: Journal | undefined, drained = false, finalized = false
  try {
    const journal = await readJournal(ctx), creator = await currentIdentity(process.pid)
    if (journal.phase !== 'prepared' || canonical(creator) !== canonical(journal.creator)) fail('execution is single-use and bound to its creating Host')
    ownedJournal = journal
    let worker: LinuxCgroupLease | undefined, keeper: LinuxCgroupLease | undefined, complete: LinuxExecutionResources | undefined
    const executionDeadline = Math.min(ctx.intent.deadline, Date.now() + ctx.contract.limits.maxDurationMs)
    const admissionAbort = new AbortController()
    const admissionSignal = AbortSignal.any([input.signal, admissionAbort.signal])
    const admissions = new Set<Promise<void>>()
    let result: IsolationResult = { jobId: ctx.intent.jobId, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [] }
    let binaryArtifacts: LinuxRepositoryArtifact[] = []
    let cleanup: Promise<void> | undefined
    const stopGroups = (): Promise<void> => {
      admissionAbort.abort()
      return cleanup ??= (async () => {
        const outcomes = await Promise.allSettled([worker ? cleanLease(worker, ctx) : Promise.resolve(), keeper ? cleanLease(keeper, ctx) : Promise.resolve()])
        const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
        if (errors.length) throw new AggregateError(errors.map(item => item.reason), 'cgroup cleanup unproven')
      })()
    }
    try {
      const args = structuredClone({ argv: input.argv, files: input.files, artifacts: input.artifacts ?? [], readOnlyRoots: input.readOnlyRoots ?? [] })
      if (typeof input.recordResources !== 'function' || typeof input.authorizeStart !== 'function') fail('missing Host admission callbacks')
      if (!Array.isArray(args.argv) || args.argv.length < 1 || args.argv.length > 64
        || !args.argv.every((arg, index) => typeof arg === 'string' && arg.length <= 65_536 && !arg.includes('\0')
          && (index !== 0 || isAbsolute(arg) && resolve(arg) === arg && !/[\r\n]/u.test(arg)))) fail('invalid command')
      if (!Array.isArray(args.files) || args.files.length > ctx.contract.limits.maxFiles
        || args.files.some(file => !file || typeof file.path !== 'string' || !safePath(file.path) || typeof file.content !== 'string' || !file.content.isWellFormed())
        || args.files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0) > ctx.contract.limits.maxInputBytes
        || !Array.isArray(args.artifacts) || args.artifacts.length > ctx.contract.limits.maxFiles
        || args.artifacts.some(path => typeof path !== 'string' || !safePath(path))
        || new Set(args.artifacts).size !== args.artifacts.length) fail('input exceeds contract bounds')
      const names = args.files.map(file => file.path)
      if (new Set(names).size !== names.length || names.some(name => names.some(other => other !== name && other.startsWith(`${name}/`)))) fail('input paths collide')
      if (!Array.isArray(args.readOnlyRoots) || args.readOnlyRoots.length > 16) fail('invalid runtime roots')
      for (const root of args.readOnlyRoots) {
        if (typeof root !== 'string' || !isAbsolute(root) || root === '/' || resolve(root) !== root || /[\p{Cc}\\]/u.test(root)
          || await realpath(root) !== root) fail('unsafe runtime root')
        if (root === ctx.stateRoot || root.startsWith(ctx.stateRoot + sep) || ctx.stateRoot.startsWith(root + sep)) fail('runtime root overlaps private state')
        const info = await lstat(root)
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== ctx.intent.uid || (info.mode & 0o022) !== 0) fail('unsafe runtime root')
      }
      if (ctx.contract.schemaVersion === 3) {
        checkImplementation(ctx)
        const system = ctx.contract.systemSnapshot.root.path
        if (system === ctx.stateRoot || system.startsWith(ctx.stateRoot + sep) || ctx.stateRoot.startsWith(system + sep)) fail('system snapshot overlaps private state')
        await verifyLinuxUserNamespaceMapping(ctx.contract.userNamespace)
        await verifyLinuxSystemSnapshot(ctx.contract.systemSnapshot)
      }
      await checkLive(ctx, input.signal)
      journal.phase = 'creating-worker'; await writeRecord(key, journal)
      await checkLive(ctx, input.signal)
      worker = await LinuxCgroupLease.create({ roots: ctx.contract.cgroupRoots, jobId: ctx.intent.jobId, nonce: ctx.intent.workerNonce,
        limits: { memoryMiB: ctx.contract.limits.memoryMiB, pidsLimit: ctx.contract.limits.pidsLimit, cpus: ctx.contract.limits.cpus }, deadline: ctx.intent.deadline })
      journal.worker = worker.snapshot; journal.phase = 'creating-keeper'; await writeRecord(key, journal)
      await checkLive(ctx, input.signal)
      keeper = await LinuxCgroupLease.create({ roots: ctx.contract.cgroupRoots, jobId: ctx.intent.jobId, nonce: ctx.intent.keeperNonce,
        limits: ctx.contract.keeperLimits, deadline: ctx.intent.deadline })
      journal.keeper = keeper.snapshot; journal.phase = 'recorded'; await writeRecord(key, journal)
      complete = resources(journal, ctx)!
      // Version 3 publishes its immutable resource binding only after the Host
      // observes the kernel namespace anchor. The private journal already owns
      // both groups; pre-anchor failures can retain a negative null-anchor receipt.
      if (ctx.contract.schemaVersion !== 3) await boundedAdmission(() => input.recordResources(complete!), input.signal, executionDeadline)
      await checkLive(ctx, input.signal)
      if (Date.now() >= executionDeadline) fail('execution authority ended')
      const admit = async (kind: 'worker' | 'keeper', candidate: LinuxCandidateIdentity): Promise<void> => {
        await checkLive(ctx, admissionSignal)
        const expected = kind === 'keeper' ? 'recorded' : ctx.contract.schemaVersion === 3 ? 'user-namespace-ready' : 'keeper-admitted'
        if ((await readJournal(ctx)).phase !== expected || cleanup) fail('admission phase closed')
        const identity = await currentIdentity(candidate.pid)
        if (!identity || identity.startTicks !== String(candidate.startTicks) || identity.bootId !== ctx.intent.bootId || identity.uid !== ctx.intent.uid) fail('candidate gate identity differs')
        if (kind === 'keeper') {
          const info = await lstat(ctx.intent.namespacePath)
          await privateDirectory(ctx.intent.namespacePath)
          journal.namespace = { path: ctx.intent.namespacePath, dev: info.dev, ino: info.ino }
        }
        if (cleanup) fail('admission phase closed')
        journal[`${kind}Identity`] = identity
        journal.phase = kind === 'keeper' ? 'keeper-admitted' : 'worker-admitted'
        await writeRecord(key, journal)
        await checkLive(ctx, admissionSignal)
        if (cleanup) fail('admission phase closed')
        await (kind === 'keeper' ? keeper! : worker!).admit(identity)
        await checkLive(ctx, admissionSignal)
        if (kind === 'worker' && ctx.contract.schemaVersion !== 3) {
          const authorized = await boundedAdmission(async () => await input.authorizeStart(), admissionSignal, executionDeadline)
          if (authorized !== true) fail('Host start authorization withdrawn')
          await checkLive(ctx, admissionSignal)
          if (cleanup || (await readJournal(ctx)).phase !== 'worker-admitted') fail('start phase closed')
          journal.phase = 'running'; await writeRecord(key, journal)
          await checkLive(ctx, admissionSignal)
        }
      }
      const trackedAdmit = (kind: 'worker' | 'keeper', identity: LinuxCandidateIdentity): Promise<void> => {
        const pending = admit(kind, identity)
        admissions.add(pending)
        void pending.then(() => admissions.delete(pending), () => admissions.delete(pending))
        return pending
      }
      const track = (operation: () => Promise<void>): Promise<void> => {
        const pending = operation()
        admissions.add(pending)
        void pending.then(() => admissions.delete(pending), () => admissions.delete(pending))
        return pending
      }
      const mapped = ctx.contract.schemaVersion === 3 ? {
        userNamespace: ctx.contract.userNamespace, systemSnapshot: ctx.contract.systemSnapshot,
        onUserNamespaceReady: (identity: LinuxCandidateIdentity): Promise<void> => track(async () => {
          await checkLive(ctx, admissionSignal)
          if (ctx.contract.schemaVersion !== 3 || cleanup || (await readJournal(ctx)).phase !== 'keeper-admitted'
            || !journal.keeperIdentity) fail('namespace admission phase closed')
          const witness = await inspectLinuxUserNamespace(ctx.contract.userNamespace, identity)
          const observed = await keeper!.observe()
          if (Object.values(observed.processes).some(pids => !pids.includes(identity.pid))) fail('keeper namespace escaped resource groups')
          await checkLive(ctx, admissionSignal)
          if (cleanup) fail('namespace admission phase closed')
          worker!.bindUserNamespace({ witness })
          keeper!.bindUserNamespace({ witness, outsideGate: journal.keeperIdentity })
          journal.userNamespace = witness; journal.phase = 'user-namespace-ready'
          await writeRecord(key, journal)
          complete = resources(journal, ctx)!
          await boundedAdmission(() => input.recordResources(complete!), admissionSignal, executionDeadline)
          await checkLive(ctx, admissionSignal)
          if (cleanup || (await readJournal(ctx)).phase !== 'user-namespace-ready') fail('namespace admission phase closed')
        }),
        beforeCandidateExec: (identity: LinuxCandidateIdentity): Promise<void> => track(async () => {
          await checkLive(ctx, admissionSignal)
          if (cleanup || (await readJournal(ctx)).phase !== 'worker-admitted' || !journal.userNamespace) fail('candidate admission phase closed')
          const witness = await inspectLinuxRepositoryCandidate(journal.userNamespace, identity)
          const observed = await worker!.observe()
          if (Object.values(observed.processes).some(pids => !pids.includes(identity.pid))) fail('candidate escaped resource groups')
          await checkLive(ctx, admissionSignal)
          if (cleanup) fail('candidate admission phase closed')
          journal.candidateIdentity = witness; journal.phase = 'candidate-ready'
          await writeRecord(key, journal)
          const authorized = await boundedAdmission(async () => await input.authorizeStart(), admissionSignal, executionDeadline)
          if (authorized !== true) fail('Host start authorization withdrawn')
          await checkLive(ctx, admissionSignal)
          if (cleanup || (await readJournal(ctx)).phase !== 'candidate-ready') fail('candidate admission phase closed')
          journal.phase = 'running'; await writeRecord(key, journal)
          await checkLive(ctx, admissionSignal)
        }),
      } : {}
      const namespaceInput = { stateRoot: join(ctx.stateRoot, 'namespaces'), namespaceId: `${ctx.intent.jobId}-${ctx.intent.nativeNonce}`,
        argv: args.argv, artifacts: args.artifacts, readOnlyRoots: args.readOnlyRoots,
        workspaceBytes: ctx.contract.limits.workspaceMiB * 1024 * 1024, workspaceInodes: ctx.contract.limits.workspaceInodes,
        tmpBytes: (ctx.contract.schemaVersion !== 1 ? ctx.contract.limits.tmpMiB : Math.max(1, Math.min(64, ctx.contract.limits.memoryMiB / 4))) * 1024 * 1024,
        tmpInodes: ctx.contract.schemaVersion !== 1 ? ctx.contract.limits.tmpInodes : ctx.contract.limits.workspaceInodes,
        timeoutMs: Math.max(1, executionDeadline - Date.now()),
        maxOutputBytes: ctx.contract.limits.maxOutputBytes, maxArtifactBytes: ctx.contract.limits.maxArtifactBytes,
        signal: input.signal, beforeKeeperStart: (identity: LinuxCandidateIdentity) => trackedAdmit('keeper', identity),
        beforeStart: (identity: LinuxCandidateIdentity) => trackedAdmit('worker', identity), afterExit: async () => { await cleanLease(worker!, ctx) }, onStop: stopGroups }
      const raw = archive ? await runLinuxRepositoryNamespace({ ...namespaceInput, ...mapped, archive })
        : await runLinuxNamespace({ ...namespaceInput, files: args.files, profile: ctx.contract.profile })
      if (archive) binaryArtifacts = (raw.artifacts as LinuxRepositoryArtifact[]).map(item => ({ ...item, bytes: Buffer.from(item.bytes) }))
      result = { jobId: ctx.intent.jobId, status: raw.status, quiescent: false, stdout: raw.stdout, stderr: raw.stderr,
        artifacts: archive ? [] : raw.artifacts as IsolationFile[], ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }), ...(raw.reason ? { reason: raw.reason.slice(0, 8192) } : {}) }
    } catch (error) {
      result.reason = (error instanceof Error ? error.message : 'execution failed').slice(0, 8192)
      result.status = input.signal.aborted ? 'cancelled' : Date.now() >= executionDeadline ? 'timed-out' : 'unknown'
    }
    try {
      await stopGroups()
      await rootsIdentity(ctx.contract, ctx.intent)
      if (!journal.worker) await removeUnrecorded(ctx, ctx.intent.workerNonce)
      if (!journal.keeper) await removeUnrecorded(ctx, ctx.intent.keeperNonce)
      if (!await absentGroups(ctx)) fail('cgroup absence unproven')
      await cleanNamespace(ctx, journal)
      result.quiescent = true
    } catch (error) {
      result = { ...result, status: 'unknown', quiescent: false, artifacts: [],
        reason: `${result.reason ?? ''}; cleanup unproven: ${error instanceof Error ? error.message : 'unknown'}`.slice(0, 8192) }
    }
    // No internal create/admit continuation may survive the terminal journal.
    // boundedAdmission detaches only the Host callback, never a gate operation.
    await Promise.allSettled(admissions)
    drained = true
    // A failed namespace journal sync can occur after its atomic rename. Build
    // the terminal resource binding from the owned journal, never the earlier
    // pre-anchor snapshot. No null-anchor binding can authorize candidate START.
    complete = resources(journal, ctx)
    validateResult(result, ctx)
    let receipt: LinuxExecutionReceipt | undefined
    let partialProof: LinuxExecutionPartialCleanupProof | undefined
    if (result.quiescent && complete) {
      if (ctx.intent.schemaVersion !== 1) {
        if (result.status === 'succeeded' && canonical(binaryArtifacts.map(item => item.path)) !== canonical(ctx.intent.repository.artifacts)) fail('repository artifacts differ from declared paths')
        journal.repositoryArtifacts = await writeArtifactSpool(ctx, result.status === 'succeeded' ? binaryArtifacts : [])
      }
      receipt = await persistReceipt(ctx, journal, complete, result)
    }
    else if (result.quiescent) partialProof = await persistPartialProof(ctx, journal, result)
    else { journal.phase = 'unknown'; journal.result = result; await writeRecord(key, journal) }
    finalized = !!receipt || !!partialProof
    return { result, ...(complete && (complete.schemaVersion !== 2 || complete.userNamespace || result.quiescent) ? { resources: complete } : {}),
      ...(receipt ? { receipt } : {}), ...(partialProof ? { partialProof } : {}) }
  } finally {
    if (finalized) completedRuns.delete(key)
    else if (ownedJournal && drained && (completedRuns.has(key) || completedRuns.size < MAX_COMPLETED_RUNS)) completedRuns.set(key, drainWitness(ctx, ownedJournal))
    active.delete(key)
  }
}

/** Recovery never dispatches. A still-live creator may resume a pending create,
 * irrespective of controller lease expiry, so it cannot be reclaimed here. */
export async function reconcileLinuxExecution(input: Context): Promise<{ quiescent: boolean; resources?: LinuxExecutionResources;
  receipt?: LinuxExecutionReceipt; partialProof?: LinuxExecutionPartialCleanupProof }> {
  const ctx = await context(input), journal = await readJournal(ctx), complete = resources(journal, ctx)
  // A null anchor is only a negative, quiescent outcome. Publishing it while a
  // creator can still establish its anchor would freeze the wrong ledger binding.
  const admitted = complete && (complete.schemaVersion !== 2 || complete.userNamespace) ? complete : undefined
  const receipt = await readLinuxExecutionReceipt(ctx)
  if (receipt) { completedRuns.delete(paths(ctx).journal); return { quiescent: true, resources: receipt.resources, receipt } }
  const partialProof = await readLinuxExecutionPartialCleanupProof(ctx)
  if (partialProof) { completedRuns.delete(paths(ctx).journal); return { quiescent: true, partialProof } }
  // Keep the original journal, witness and uncertain body untouched when a
  // replacement implementation cannot exercise this job's cleanup authority.
  try { checkImplementation(ctx) }
  catch { return { quiescent: false, ...(admitted ? { resources: admitted } : {}) } }
  const key = paths(ctx).journal
  if (!await creatorCanReconcile(ctx, journal)) return { quiescent: false, ...(admitted ? { resources: admitted } : {}) }
  // creatorCanReconcile awaits /proc. Claim again synchronously after that
  // await, so two same-Host recoveries cannot both enter cleanup/persistence.
  if (active.has(key)) return { quiescent: false, ...(admitted ? { resources: admitted } : {}) }
  active.add(key)
  let finalizing = false
  try {
    const outcomes = await Promise.allSettled((['worker', 'keeper'] as const).map(async kind => {
      const snapshot = journal[kind]
      if (snapshot) await cleanLease(await LinuxCgroupLease.recover(snapshot, journal.userNamespace ? {
        witness: journal.userNamespace, ...(kind === 'keeper' && journal.keeperIdentity ? { outsideGate: journal.keeperIdentity } : {}),
      } : undefined), ctx)
      else await removeUnrecorded(ctx, kind === 'worker' ? ctx.intent.workerNonce : ctx.intent.keeperNonce)
    }))
    const errors = outcomes.filter((item): item is PromiseRejectedResult => item.status === 'rejected')
    if (errors.length) throw new AggregateError(errors.map(item => item.reason), errors.map(item => item.reason instanceof Error ? item.reason.message : 'unknown cleanup failure').join('; '))
    await rootsIdentity(ctx.contract, ctx.intent)
    if (!await absentGroups(ctx)) fail('recovered resource absence unproven')
    await cleanNamespace(ctx, journal)
    finalizing = true
    const result: IsolationResult = { jobId: ctx.intent.jobId, status: 'unknown', quiescent: true, stdout: '', stderr: '', artifacts: [], reason: 'Host execution interrupted; task outcome remains unknown' }
    if (!complete) {
      const proof = await persistPartialProof(ctx, journal, result, true)
      completedRuns.delete(key)
      return { quiescent: true, partialProof: proof }
    }
    if (ctx.intent.schemaVersion !== 1) { await removeArtifactSpool(ctx); journal.repositoryArtifacts = [] }
    const recovered = await persistReceipt(ctx, journal, complete, result, true)
    completedRuns.delete(key)
    return { quiescent: true, resources: complete, receipt: recovered }
  } catch (error) {
    if (error instanceof LinuxImplementationChangedError || error instanceof AggregateError
      && error.errors.some(item => item instanceof LinuxImplementationChangedError)) return { quiescent: false, ...(admitted ? { resources: admitted } : {}) }
    // A terminal rename may already be visible even when its directory fsync
    // failed. Preserve that journal/receipt pair for strict validation on the
    // next attempt; overwriting either would destroy an otherwise valid proof.
    if (finalizing) return { quiescent: false, ...(admitted ? { resources: admitted } : {}) }
    journal.phase = 'unknown'
    journal.result = { jobId: ctx.intent.jobId, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [],
      reason: `recovery cleanup unproven: ${error instanceof Error ? error.message : 'unknown failure'}`.slice(0, 8192) }
    await writeRecord(key, journal)
    return { quiescent: false, ...(admitted ? { resources: admitted } : {}) }
  } finally { active.delete(key) }
}

function validateArtifactSummaries(value: unknown, ctx: Context): asserts value is LinuxRepositoryArtifactSummary[] {
  if (ctx.intent.schemaVersion === 1 || !Array.isArray(value) || value.length > ctx.contract.limits.maxFiles) fail('invalid repository summaries')
  let total = 0
  const names = new Set<string>()
  for (const item of value) {
    keys(item, ['path', 'bytes', 'sha256'])
    if (typeof item.path !== 'string' || !ctx.intent.repository.artifacts.includes(item.path) || names.has(item.path)
      || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)) fail('repository artifact binding differs')
    total += item.bytes as number; names.add(item.path)
  }
  if (total > ctx.contract.limits.maxArtifactBytes) fail('repository artifacts exceed bounds')
}
function spoolPath(ctx: Context): string { return join(ctx.stateRoot, 'artifacts', `${ctx.intent.jobId}-${ctx.intent.nativeNonce}`) }
async function writeArtifactSpool(ctx: Context, artifacts: LinuxRepositoryArtifact[]): Promise<LinuxRepositoryArtifactSummary[]> {
  const summaries = artifacts.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: item.sha256 }))
  validateArtifactSummaries(summaries, ctx)
  for (const item of artifacts) if (!Buffer.isBuffer(item.bytes) || createHash('sha256').update(item.bytes).digest('hex') !== item.sha256) fail('repository artifact digest differs')
  if (!artifacts.length) return []
  await privateDirectory(join(ctx.stateRoot, 'artifacts'))
  const directory = spoolPath(ctx)
  await mkdir(directory, { mode: 0o700 })
  await syncDirectory(dirname(directory))
  await privateDirectory(directory)
  for (let index = 0; index < artifacts.length; index++) {
    const target = join(directory, `${index}.bin`), temporary = `${target}.${randomBytes(16).toString('hex')}.tmp`
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(artifacts[index]!.bytes); await handle.sync() } finally { await handle.close() }
      if (await exists(target)) fail('repository spool identity already exists')
      await rename(temporary, target)
      await syncDirectory(directory)
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error }) }
  }
  return summaries
}
async function readArtifactSpool(ctx: Context, summaries: LinuxRepositoryArtifactSummary[]): Promise<LinuxRepositoryArtifact[]> {
  validateArtifactSummaries(summaries, ctx)
  if (!summaries.length) return []
  const directory = spoolPath(ctx)
  await privateDirectory(join(ctx.stateRoot, 'artifacts'))
  await privateDirectory(directory)
  const entries = await readdir(directory)
  if (canonical(entries.sort()) !== canonical(summaries.map((_, index) => `${index}.bin`).sort())) fail('repository spool inventory differs')
  const result: LinuxRepositoryArtifact[] = []
  for (let index = 0; index < summaries.length; index++) {
    const item = summaries[index]!, path = join(directory, `${index}.bin`)
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat(), named = await lstat(path)
      if (!info.isFile() || named.isSymbolicLink() || info.uid !== ctx.intent.uid || (info.mode & 0o7777) !== 0o600
        || info.nlink !== 1 || info.size !== item.bytes || named.dev !== info.dev || named.ino !== info.ino) fail('repository spool identity differs')
      const bytes = Buffer.alloc(item.bytes)
      let offset = 0
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset)
        if (part.bytesRead === 0) fail('repository spool truncated')
        offset += part.bytesRead
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail('repository spool grew')
      const after = await handle.stat()
      if (bytes.length !== item.bytes || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs
        || after.nlink !== 1 || createHash('sha256').update(bytes).digest('hex') !== item.sha256) fail('repository spool digest differs')
      result.push({ path: item.path, bytes, sha256: item.sha256 })
    } finally { await handle.close() }
  }
  return result
}
/** Only recovery after proven cgroup/namespace absence can discard an orphan
 * spool. The inventory is bounded and never follows a caller-controlled link. */
async function removeArtifactSpool(ctx: Context): Promise<void> {
  await privateDirectory(join(ctx.stateRoot, 'artifacts'))
  const directory = spoolPath(ctx)
  if (!await exists(directory)) return
  await privateDirectory(directory)
  const entries = await readdir(directory)
  let total = 0
  if (entries.length > 256) fail('orphan spool inventory exceeds bounds')
  for (const name of entries) {
    if (!/^(?:[0-9]|[1-9][0-9]|1[01][0-9]|12[0-7])\.bin(?:\.[a-f0-9]{32}\.tmp)?$/u.test(name)) fail('orphan spool entry differs')
    const info = await lstat(join(directory, name))
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== ctx.intent.uid || (info.mode & 0o7777) !== 0o600
      || info.nlink !== 1 || info.size > ctx.contract.limits.maxArtifactBytes) fail('orphan spool identity differs')
    total += info.size
    if (total > 2 * ctx.contract.limits.maxArtifactBytes) fail('orphan spool exceeds bounds')
  }
  for (const name of entries) await unlink(join(directory, name))
  await rmdir(directory)
  await syncDirectory(dirname(directory))
}
function repositoryRequest(input: LinuxRepositoryExecutionRequest, contract: LinuxRepositoryExecutionContract): {
  request: LinuxRepositoryExecutionRequest & { archive: { bytes: Buffer; sha256: string } }
  binding: LinuxRepositoryExecutionIntent['repository']
} {
  if (!input.archive || !(input.archive.bytes instanceof Uint8Array) || input.archive.bytes.byteLength < 1
    || input.archive.bytes.byteLength > contract.limits.maxInputBytes) fail('repository archive exceeds bounds')
  // Snapshot all caller-owned values before the first asynchronous operation.
  const request = { argv: [...input.argv], artifacts: [...input.artifacts], readOnlyRoots: [...(input.readOnlyRoots ?? [])],
    archive: { bytes: Buffer.from(input.archive.bytes), sha256: input.archive.sha256 } }
  if (!/^[a-f0-9]{64}$/u.test(request.archive.sha256)
    || createHash('sha256').update(request.archive.bytes).digest('hex') !== request.archive.sha256
    || request.argv.length < 1 || request.argv.length > 64
    || request.argv.some((arg, index) => typeof arg !== 'string' || arg.length > 65_536 || arg.includes('\0')
      || index === 0 && (!isAbsolute(arg) || resolve(arg) !== arg || /[\r\n]/u.test(arg)))
    || request.artifacts.length > contract.limits.maxFiles || request.artifacts.some(item => typeof item !== 'string' || !safePath(item))
    || new Set(request.artifacts).size !== request.artifacts.length || request.readOnlyRoots.length > 16
    || request.readOnlyRoots.some(root => typeof root !== 'string' || !isAbsolute(root) || root === '/' || resolve(root) !== root || /[\p{Cc}\\]/u.test(root))) fail('repository request differs')
  const archive = { bytes: request.archive.bytes.length, sha256: request.archive.sha256 }
  const binding = { archive, artifacts: request.artifacts,
    executionDigest: digest({ argv: request.argv, archive, artifacts: request.artifacts, readOnlyRoots: request.readOnlyRoots }) }
  return { request, binding }
}
export async function prepareLinuxRepositoryIntent(input: PrepareInput & LinuxRepositoryExecutionRequest & {
  contract: LinuxRepositoryExecutionContract
}): Promise<LinuxRepositoryExecutionIntent> {
  const contract = validateLinuxExecutionContract(input.contract)
  if (contract.schemaVersion === 1) fail('repository contract required')
  const { binding } = repositoryRequest(input, contract)
  return await prepareIntent({ ...input, contract }, binding) as LinuxRepositoryExecutionIntent
}
/** Binary bytes are returned only after successful receipt validation and fresh
 * kernel absence checks. Reopening a completed identity only reads its receipt. */
export async function readLinuxRepositoryReceipt(input: LinuxRepositoryExecutionContext): Promise<{
  receipt: LinuxRepositoryExecutionReceipt; artifacts: LinuxRepositoryArtifact[]
} | undefined> {
  if (![2, 3].includes(input.contract.schemaVersion) || ![2, 3].includes(input.intent.schemaVersion)) fail('repository context required')
  const ctx = await context(input), receipt = await readLinuxExecutionReceipt(ctx)
  if (!receipt) return undefined
  if (receipt.schemaVersion === 1) fail('repository receipt required')
  if (receipt.result.status !== 'succeeded' && receipt.repositoryArtifacts.length) fail('unsuccessful receipt contains artifacts')
  const artifacts = receipt.result.status === 'succeeded' ? await readArtifactSpool(ctx, receipt.repositoryArtifacts) : []
  const verified = await readLinuxExecutionReceipt(ctx)
  if (verified?.receiptDigest !== receipt.receiptDigest) fail('repository receipt changed')
  return { receipt, artifacts }
}
export type LinuxRepositoryExecutionOutcome = Omit<RunOutcome, 'receipt'> & { receipt?: LinuxRepositoryExecutionReceipt; artifacts: LinuxRepositoryArtifact[] }
export async function runLinuxRepositoryExecution(input: LinuxRepositoryExecutionContext & LinuxRepositoryExecutionRequest & {
  signal: AbortSignal; recordResources: (value: LinuxExecutionResources) => Promise<void>; authorizeStart: () => Promise<boolean> | boolean
}): Promise<LinuxRepositoryExecutionOutcome> {
  const contract = validateLinuxExecutionContract(input.contract)
  if (contract.schemaVersion === 1 || ![2, 3].includes(input.intent.schemaVersion)) fail('repository context required')
  const { request, binding } = repositoryRequest(input, contract)
  if (canonical(binding) !== canonical(input.intent.repository)) fail('repository request binding differs')
  const ctx = { stateRoot: input.stateRoot, contract, intent: input.intent }
  const existing = await readLinuxRepositoryReceipt(ctx)
  if (existing) return { result: existing.receipt.result, resources: existing.receipt.resources, ...existing }
  const outcome = await runExecution({ ...input, ...ctx, ...request, files: [] }, request.archive)
  const settled = outcome.receipt ? await readLinuxRepositoryReceipt(ctx) : undefined
  const { receipt, ...rest } = outcome
  if (receipt && receipt.schemaVersion === 1) fail('repository receipt required')
  return { ...rest, ...(receipt ? { receipt } : {}), artifacts: settled?.artifacts ?? [] }
}
export async function reconcileLinuxRepositoryExecution(input: LinuxRepositoryExecutionContext): Promise<{
  quiescent: boolean; resources?: LinuxExecutionResources; receipt?: LinuxRepositoryExecutionReceipt;
  partialProof?: LinuxExecutionPartialCleanupProof; artifacts: LinuxRepositoryArtifact[]
}> {
  if (![2, 3].includes(input.contract.schemaVersion) || ![2, 3].includes(input.intent.schemaVersion)) fail('repository context required')
  const outcome = await reconcileLinuxExecution(input)
  const settled = outcome.receipt ? await readLinuxRepositoryReceipt(input) : undefined
  const { receipt, ...rest } = outcome
  if (receipt && receipt.schemaVersion === 1) fail('repository receipt required')
  return { ...rest, ...(receipt ? { receipt } : {}), artifacts: settled?.artifacts ?? [] }
}
