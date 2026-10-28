import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, rmdir, statfs, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { LinuxCgroupLease, type LinuxCgroupDirectory, type LinuxCgroupIdentity, type LinuxCgroupSnapshot } from './linux-cgroups.js'
import { linuxExecutionContractDigest, linuxExecutionIntentDigest, linuxExecutionResourcesDigest,
  linuxExecutionPartialCleanupProofDigest, validateLinuxExecutionPartialCleanupProof,
  validateLinuxExecutionContract, validateLinuxExecutionIntent, validateLinuxExecutionResources,
  type LinuxExecutionContract, type LinuxExecutionIntent, type LinuxExecutionResources, type LinuxReceiptBinding,
  type LinuxExecutionPartialCleanupProof } from './linux-execution-contract.js'
import { runLinuxNamespace, type LinuxCandidateIdentity } from './linux-namespace.js'
import type { IsolationFile, IsolationResult } from './types.js'

export interface LinuxExecutionReceipt {
  schemaVersion: 1
  intent: LinuxExecutionIntent
  resources: LinuxExecutionResources
  result: IsolationResult
  completedAt: number
  receiptDigest: string
}
interface Context { stateRoot: string; contract: LinuxExecutionContract; intent: LinuxExecutionIntent }
interface Journal {
  schemaVersion: 1
  intent: LinuxExecutionIntent
  creator: LinuxCgroupIdentity
  phase: 'prepared' | 'creating-worker' | 'creating-keeper' | 'recorded' | 'keeper-admitted' | 'worker-admitted' | 'running' | 'settled' | 'prestart-quiesced' | 'unknown'
  worker: LinuxCgroupSnapshot | null
  keeper: LinuxCgroupSnapshot | null
  workerIdentity: LinuxCgroupIdentity | null
  keeperIdentity: LinuxCgroupIdentity | null
  namespace: LinuxCgroupDirectory | null
  result: IsolationResult | null
}
const active = new Set<string>()
// This is a drain witness, never an execution grant. It permits only cleanup
// after this exact Host has awaited every internal create/admit continuation.
// Failure to retain a witness is conservative: durable recovery waits for death.
const completedRuns = new Map<string, string>()
const MAX_COMPLETED_RUNS = 4096
const controllers = ['cpu', 'memory', 'pids', 'freezer'] as const
const MAX_RECORD_BYTES = 14 * 1024 * 1024
const phases = ['prepared', 'creating-worker', 'creating-keeper', 'recorded', 'keeper-admitted', 'worker-admitted', 'running', 'settled', 'prestart-quiesced', 'unknown']
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
  if (bytes > ctx.contract.limits.maxArtifactBytes) fail('result artifacts exceed bounds')
}
async function readJournal(ctx: Context): Promise<Journal> {
  const value = await readRecord(paths(ctx).journal)
  keys(value, ['schemaVersion', 'intent', 'creator', 'phase', 'worker', 'keeper', 'workerIdentity', 'keeperIdentity', 'namespace', 'result'])
  if (value.schemaVersion !== 1 || canonical(value.intent) !== canonical(ctx.intent) || !phases.includes(value.phase as string)) fail('journal intent or phase differs')
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
  if (value.keeper && !value.worker || value.phase === 'prepared' && (value.worker || value.keeper || value.namespace || value.result)
    || ['recorded', 'keeper-admitted', 'worker-admitted', 'running', 'settled'].includes(value.phase as string) && (!value.worker || !value.keeper)
    || value.phase === 'settled' && (!value.result || !(value.result as IsolationResult).quiescent)) fail('journal phase fields differ')
  if (value.workerIdentity && (!value.worker || !value.keeperIdentity) || value.keeperIdentity && (!value.keeper || !value.namespace)
    || value.namespace && !value.keeper
    || ['prepared', 'creating-worker', 'creating-keeper', 'recorded'].includes(value.phase as string) && (value.workerIdentity || value.keeperIdentity || value.namespace || value.result)
    || value.phase === 'creating-worker' && (value.worker || value.keeper)
    || value.phase === 'creating-keeper' && (!value.worker || value.keeper)
    || value.phase === 'keeper-admitted' && (!value.keeperIdentity || value.workerIdentity || value.result)
    || ['worker-admitted', 'running'].includes(value.phase as string) && (!value.workerIdentity || value.result)) fail('journal phase fields differ')
  if (value.phase === 'prestart-quiesced' && (value.worker && value.keeper || value.workerIdentity || value.keeperIdentity || value.namespace
    || !value.result || !(value.result as IsolationResult).quiescent || (value.result as IsolationResult).status === 'succeeded')) fail('partial cleanup journal differs')
  return value as unknown as Journal
}
function resources(journal: Journal, ctx: Context): LinuxExecutionResources | undefined {
  return journal.worker && journal.keeper ? validateLinuxExecutionResources({ schemaVersion: 1,
    intentDigest: linuxExecutionIntentDigest(ctx.intent), worker: journal.worker, keeper: journal.keeper }, ctx.intent, ctx.contract) : undefined
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
export async function prepareLinuxExecutionIntent(input: { stateRoot: string; contract: LinuxExecutionContract;
  job: { id: string; requestDigest: string; nativeResourceId: string; nativeNonce: string; deadline: number } }): Promise<LinuxExecutionIntent> {
  const uid = platform(), contract = validateLinuxExecutionContract(input.contract)
  if (contract.cgroupRoots.mode !== 'v1') fail('cgroup v2 process placement is not yet verified')
  if (input.job.deadline <= Date.now() || !positive(input.job.deadline) || contract.limits.workspaceMiB > 4096 || contract.limits.maxDurationMs > 1_800_000) fail('invalid execution deadline or namespace limits')
  const intent = validateLinuxExecutionIntent({ schemaVersion: 1, jobId: input.job.id, requestDigest: input.job.requestDigest,
    nativeResourceId: input.job.nativeResourceId, nativeNonce: input.job.nativeNonce,
    contractDigest: linuxExecutionContractDigest(contract), bootId: await boot(), uid, deadline: input.job.deadline,
    namespacePath: join(input.stateRoot, 'namespaces', `namespace-${input.job.id}-${input.job.nativeNonce}`),
    workerNonce: randomBytes(16).toString('hex'), keeperNonce: randomBytes(16).toString('hex'), roots: await rootsIdentity(contract) }, contract)
  await setup(input.stateRoot)
  const creator = await currentIdentity(process.pid)
  if (!creator) fail('Host identity unavailable')
  const ctx = { stateRoot: input.stateRoot, contract, intent }
  await checkLive(ctx)
  if (await exists(intent.namespacePath) || await exists(paths(ctx).receipt) || await exists(paths(ctx).partial)) fail('execution identity already exists')
  await writeRecord(paths(ctx).journal, { schemaVersion: 1, intent, creator, phase: 'prepared', worker: null, keeper: null,
    workerIdentity: null, keeperIdentity: null, namespace: null, result: null } satisfies Journal, true)
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
async function cleanLease(lease: LinuxCgroupLease): Promise<void> {
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
        if (!/^(?:workspace|tmp|shm|identity|immutable(?:\/(?:usr|lib|lib64|runtime(?:\/(?:[0-9]|1[0-5]))?))?)$/u.test(name)) fail('unexpected namespace directory')
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
  keys(value, ['schemaVersion', 'intent', 'resources', 'result', 'completedAt', 'receiptDigest'])
  if (value.schemaVersion !== 1 || canonical(value.intent) !== canonical(ctx.intent) || !positive(value.completedAt)
    || value.completedAt < 1 || value.completedAt > Date.now() + 1000 || typeof value.receiptDigest !== 'string') fail('receipt binding differs')
  const complete = validateLinuxExecutionResources(value.resources, ctx.intent, ctx.contract)
  validateResult(value.result, ctx)
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
  journal.phase = 'settled'; journal.result = result
  await writeRecord(paths(ctx).journal, journal)
  const body = { schemaVersion: 1 as const, intent: ctx.intent, resources: complete, result, completedAt: Date.now() }
  const receipt: LinuxExecutionReceipt = { ...body, receiptDigest: digest(body) }
  if (repairIncomplete) await repairPlaceholder(paths(ctx).receipt)
  await writeRecord(paths(ctx).receipt, receipt, true)
  return receipt
}

export async function runLinuxExecution(input: Context & { argv: readonly string[]; files: readonly IsolationFile[];
  artifacts?: readonly string[]; readOnlyRoots?: readonly string[]; signal: AbortSignal;
  recordResources: (value: LinuxExecutionResources) => Promise<void>; authorizeStart: () => Promise<boolean> | boolean }): Promise<{
    result: IsolationResult; resources?: LinuxExecutionResources; receipt?: LinuxExecutionReceipt; partialProof?: LinuxExecutionPartialCleanupProof
  }> {
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
    let cleanup: Promise<void> | undefined
    const stopGroups = (): Promise<void> => {
      admissionAbort.abort()
      return cleanup ??= (async () => {
        const outcomes = await Promise.allSettled([worker ? cleanLease(worker) : Promise.resolve(), keeper ? cleanLease(keeper) : Promise.resolve()])
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
      await boundedAdmission(() => input.recordResources(complete!), input.signal, executionDeadline)
      await checkLive(ctx, input.signal)
      if (Date.now() >= executionDeadline) fail('execution authority ended')
      const admit = async (kind: 'worker' | 'keeper', candidate: LinuxCandidateIdentity): Promise<void> => {
        await checkLive(ctx, admissionSignal)
        const expected = kind === 'keeper' ? 'recorded' : 'keeper-admitted'
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
        if (kind === 'worker') {
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
      const raw = await runLinuxNamespace({ stateRoot: join(ctx.stateRoot, 'namespaces'), namespaceId: `${ctx.intent.jobId}-${ctx.intent.nativeNonce}`,
        argv: args.argv, files: args.files, artifacts: args.artifacts, readOnlyRoots: args.readOnlyRoots,
        workspaceBytes: ctx.contract.limits.workspaceMiB * 1024 * 1024, workspaceInodes: ctx.contract.limits.workspaceInodes,
        tmpBytes: Math.max(1, Math.min(64, ctx.contract.limits.memoryMiB / 4)) * 1024 * 1024, tmpInodes: ctx.contract.limits.workspaceInodes,
        timeoutMs: Math.max(1, executionDeadline - Date.now()),
        maxOutputBytes: ctx.contract.limits.maxOutputBytes, maxArtifactBytes: ctx.contract.limits.maxArtifactBytes,
        profile: ctx.contract.profile, signal: input.signal, beforeKeeperStart: identity => trackedAdmit('keeper', identity),
        beforeStart: identity => trackedAdmit('worker', identity), afterExit: async () => { await cleanLease(worker!) }, onStop: stopGroups })
      result = { jobId: ctx.intent.jobId, status: raw.status, quiescent: false, stdout: raw.stdout, stderr: raw.stderr,
        artifacts: raw.artifacts, ...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode }), ...(raw.reason ? { reason: raw.reason.slice(0, 8192) } : {}) }
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
    validateResult(result, ctx)
    let receipt: LinuxExecutionReceipt | undefined
    let partialProof: LinuxExecutionPartialCleanupProof | undefined
    if (result.quiescent && complete) receipt = await persistReceipt(ctx, journal, complete, result)
    else if (result.quiescent) partialProof = await persistPartialProof(ctx, journal, result)
    else { journal.phase = 'unknown'; journal.result = result; await writeRecord(key, journal) }
    finalized = !!receipt || !!partialProof
    return { result, ...(complete ? { resources: complete } : {}), ...(receipt ? { receipt } : {}), ...(partialProof ? { partialProof } : {}) }
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
  const receipt = await readLinuxExecutionReceipt(ctx)
  if (receipt) { completedRuns.delete(paths(ctx).journal); return { quiescent: true, resources: receipt.resources, receipt } }
  const partialProof = await readLinuxExecutionPartialCleanupProof(ctx)
  if (partialProof) { completedRuns.delete(paths(ctx).journal); return { quiescent: true, partialProof } }
  const key = paths(ctx).journal
  if (!await creatorCanReconcile(ctx, journal)) return { quiescent: false, ...(complete ? { resources: complete } : {}) }
  // creatorCanReconcile awaits /proc. Claim again synchronously after that
  // await, so two same-Host recoveries cannot both enter cleanup/persistence.
  if (active.has(key)) return { quiescent: false, ...(complete ? { resources: complete } : {}) }
  active.add(key)
  let finalizing = false
  try {
    const outcomes = await Promise.allSettled((['worker', 'keeper'] as const).map(async kind => {
      const snapshot = journal[kind]
      if (snapshot) await cleanLease(await LinuxCgroupLease.recover(snapshot))
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
    const recovered = await persistReceipt(ctx, journal, complete, result, true)
    completedRuns.delete(key)
    return { quiescent: true, resources: complete, receipt: recovered }
  } catch (error) {
    // A terminal rename may already be visible even when its directory fsync
    // failed. Preserve that journal/receipt pair for strict validation on the
    // next attempt; overwriting either would destroy an otherwise valid proof.
    if (finalizing) return { quiescent: false, ...(complete ? { resources: complete } : {}) }
    journal.phase = 'unknown'
    journal.result = { jobId: ctx.intent.jobId, status: 'unknown', quiescent: false, stdout: '', stderr: '', artifacts: [],
      reason: `recovery cleanup unproven: ${error instanceof Error ? error.message : 'unknown failure'}`.slice(0, 8192) }
    await writeRecord(key, journal)
    return { quiescent: false, ...(complete ? { resources: complete } : {}) }
  } finally { active.delete(key) }
}
