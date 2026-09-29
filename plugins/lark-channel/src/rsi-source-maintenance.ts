import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import { lstat, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { sourceMaintenanceDigest, verifySourceMaintenanceRecords,
  type SourceMaintenanceAnchor, type SourceMaintenanceRecord } from '@dsh-enhanced/plugin-control-plane'
import { rsiBuildResources as io } from './rsi-build.js'
import type { RsiSourceWorkspace } from './rsi-source.js'

const COMMIT = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new Error(`rsi source maintenance: ${message}`) }
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)
function canonical(path: string): boolean { return typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !path.includes('\0') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) fail('receipt shape differs')
  return value as Record<string, unknown>
}
async function privateFile(path: string, maximum: number): Promise<Buffer> {
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > maximum
    || (item.mode & 0o077) !== 0 || process.getuid && item.uid !== process.getuid()) fail(`unsafe private file: ${path}`)
  return io.readStable(path, maximum, true)
}
async function safeGitFile(path: string): Promise<Buffer> {
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > 65_536
    || (item.mode & 0o022) !== 0 || process.getuid && item.uid !== process.getuid()) fail('unsafe Git control file')
  return io.readStable(path, 65_536, false)
}
const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always', '-c', 'credential.helper=', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false'] as const
function gitEnvironment(): NodeJS.ProcessEnv { return { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0',
  GIT_ALLOW_PROTOCOL: 'file', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_LFS_SKIP_SMUDGE: '1',
  GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false' } }
async function git(repository: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return io.command('/usr/bin/git', [...GIT_FLAGS, '-C', repository, ...args], gitEnvironment(), signal, 60_000, 65_536)
}
async function directRef(repository: string, ref: string, signal: AbortSignal): Promise<string> {
  const value = await git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', ref], signal)
  const parts = value.split('\0')
  if (parts.length !== 3 || parts[0] !== ref || !COMMIT.test(parts[1]!) || parts[2] !== '') fail(`Git ref is missing or symbolic: ${ref}`)
  return parts[1]!
}
async function ancestor(repository: string, older: string, newer: string, signal: AbortSignal): Promise<boolean> {
  const base = await git(repository, ['merge-base', older, newer], signal)
  if (!COMMIT.test(base)) fail('Git merge base is invalid')
  return base === older
}
async function noAlternates(root: string, bare: boolean): Promise<void> {
  const gitRoot = bare ? root : join(root, '.git')
  const item = await lstat(gitRoot)
  if (!item.isDirectory() || item.isSymbolicLink() || await realpath(gitRoot) !== gitRoot) fail('Git directory is not physical')
  for (const name of ['alternates', 'http-alternates']) {
    try { await lstat(join(gitRoot, 'objects', 'info', name)); fail('external Git alternates are forbidden') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
async function packageVersion(repository: string, ref: string, signal: AbortSignal): Promise<string> {
  const value = JSON.parse(await git(repository, ['show', `${ref}:package.json`], signal)) as Record<string, unknown>
  if (value.name !== 'dsh-enhanced' || typeof value.version !== 'string' || !VERSION.test(value.version)) fail('source package version is invalid')
  return value.version as string
}
interface Original {
  bytes: Buffer
  workspace: RsiSourceWorkspace
  repository: string
  remote: string
}
async function original(logicalHome: string, physicalHome: string, profile: string): Promise<Original> {
  const logicalRoot = join(logicalHome, 'rsi-sources', profile)
  const physicalRoot = join(physicalHome, 'rsi-sources', profile)
  await io.directory(physicalRoot)
  const bytes = await privateFile(join(physicalRoot, 'bootstrap.json'), 65_536)
  const receipt = object(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'version', 'origin', 'sourceCommit',
    'repository', 'baseline', 'dshHome', 'profile', 'staticFiles', 'receiptDigest'])
  const { receiptDigest, ...content } = receipt
  const origin = object(receipt.origin, ['kind', 'locator', 'ref'])
  const baseline = object(receipt.baseline, ['ref', 'remote', 'targetBranch', 'initialCommit'])
  const files = object(receipt.staticFiles, ['checkoutConfig', 'checkoutHead', 'bareConfig', 'bareHead'])
  if (receipt.schemaVersion !== 1 || receipt.dshHome !== logicalHome || receipt.profile !== profile
    || !HASH.test(String(receiptDigest)) || hash(JSON.stringify(content)) !== receiptDigest
    || !COMMIT.test(String(receipt.sourceCommit)) || !VERSION.test(String(receipt.version))
    || receipt.repository !== join(logicalRoot, 'checkout') || origin.kind !== 'local-head'
    || !canonical(String(origin.locator)) || origin.ref !== 'HEAD'
    || baseline.ref !== 'refs/dsh-source/repairs' || baseline.remote !== join(logicalRoot, 'release.git')
    || baseline.targetBranch !== 'repairs' || baseline.initialCommit !== receipt.sourceCommit
    || Object.values(files).some(value => !HASH.test(String(value)))) fail('original source bootstrap differs')
  const repository = join(physicalRoot, 'checkout'), remote = join(physicalRoot, 'release.git')
  await io.directory(repository); await io.directory(remote)
  const actual = { checkoutConfig: hash(await safeGitFile(join(repository, '.git', 'config'))),
    checkoutHead: hash(await safeGitFile(join(repository, '.git', 'HEAD'))),
    bareConfig: hash(await safeGitFile(join(remote, 'config'))), bareHead: hash(await safeGitFile(join(remote, 'HEAD'))) }
  if (!isDeepStrictEqual(actual, files)) fail('original static Git files changed')
  const workspace: RsiSourceWorkspace = { schemaVersion: 1, version: receipt.version as string,
    origin: origin as unknown as RsiSourceWorkspace['origin'], sourceCommit: receipt.sourceCommit as string,
    repository: receipt.repository as string, baseline: baseline as unknown as RsiSourceWorkspace['baseline'] }
  return { bytes, workspace, repository, remote }
}
async function authorityAnchor(logicalHome: string, physicalHome: string, profile: string,
  workspace: RsiSourceWorkspace): Promise<SourceMaintenanceAnchor> {
  const root = join(physicalHome, 'rsi-authorities', profile)
  const bytes = await privateFile(join(root, 'bootstrap.json'), 65_536)
  const receipt = object(JSON.parse(bytes.toString('utf8')), ['schemaVersion', 'dshHome', 'profile', 'resources', 'keyDigests', 'receiptDigest'])
  const { receiptDigest, ...content } = receipt
  const resources = receipt.resources as Record<string, unknown>
  const identities = resources?.identities as Record<string, Record<string, unknown>> | undefined
  const host = identities?.host
  const keyDigests = receipt.keyDigests as Record<string, unknown>
  if (receipt.schemaVersion !== 1 || receipt.dshHome !== logicalHome || receipt.profile !== profile
    || !HASH.test(String(receiptDigest)) || hash(JSON.stringify(content)) !== receiptDigest
    || resources?.root !== join(logicalHome, 'rsi-authorities', profile)
    || resources?.stateRoot !== join(logicalHome, 'rsi-authorities', profile, 'state')
    || typeof resources.installationId !== 'string' || typeof resources.ledgerId !== 'string'
    || !host || host.keyPath !== join(logicalHome, 'rsi-authorities', profile, 'identities', 'host.pem')
    || host?.authority !== `host-${resources.installationId}` || host?.keyId !== `${host.authority}-key`
    || typeof host.publicKeyPem !== 'string' || !HASH.test(String(keyDigests?.host))) fail('Host source signing identity differs')
  const hostIdentity = host as { authority: string; keyId: string; publicKeyPem: string }
  const privateKey = await privateFile(join(root, 'identities', 'host.pem'), 16_384)
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519' || hash(privateKey) !== keyDigests.host
    || createPublicKey(key).export({ format: 'pem', type: 'spki' }).toString() !== hostIdentity.publicKeyPem) fail('Host source signing key differs')
  return { installationId: resources.installationId as string,
    ledger: { id: resources.ledgerId as string, path: join(logicalHome, 'rsi-authorities', profile, 'state', 'control-plane', 'control.sqlite') },
    repository: workspace.repository, baseline: workspace.baseline,
    hostIdentity }
}
async function trustedAnchor(logicalHome: string, physicalHome: string, profile: string,
  saved: Original): Promise<SourceMaintenanceAnchor> {
  const staged = await authorityAnchor(logicalHome, physicalHome, profile, saved.workspace)
  if (physicalHome !== await realpath(logicalHome)) {
    const live = await original(logicalHome, logicalHome, profile)
    const anchor = await authorityAnchor(logicalHome, logicalHome, profile, live.workspace)
    const authorityPath = join('rsi-authorities', profile)
    const stageAuthority = await privateFile(join(physicalHome, authorityPath, 'bootstrap.json'), 65_536)
    const liveAuthority = await privateFile(join(logicalHome, authorityPath, 'bootstrap.json'), 65_536)
    const stageKey = await privateFile(join(physicalHome, authorityPath, 'identities', 'host.pem'), 16_384)
    const liveKey = await privateFile(join(logicalHome, authorityPath, 'identities', 'host.pem'), 16_384)
    if (!saved.bytes.equals(live.bytes) || !stageAuthority.equals(liveAuthority) || !stageKey.equals(liveKey)
      || !isDeepStrictEqual(staged, anchor)) {
      fail('staged source or Host authority differs from the live installation')
    }
  }
  return staged
}
async function cohortDigest(logicalHome: string, physicalHome: string, profile: string): Promise<{ digest: string; sourceCommit: string; version: string }> {
  const bytes = await privateFile(join(physicalHome, 'rsi-local-cohorts', profile, 'receipt.json'), 16_777_216)
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  const { receiptDigest, ...content } = value
  if (value.schemaVersion !== 1 || value.root !== join(logicalHome, 'rsi-local-cohorts', profile)
    || !HASH.test(String(receiptDigest)) || hash(JSON.stringify(content)) !== receiptDigest
    || !COMMIT.test(String(value.sourceCommit)) || !VERSION.test(String(value.version))) fail('staged cohort receipt differs')
  return { digest: receiptDigest as string, sourceCommit: value.sourceCommit as string, version: value.version as string }
}
async function repoState(original: Original, records: readonly SourceMaintenanceRecord[],
  logicalHome: string, physicalHome: string, profile: string, signal: AbortSignal,
  checkCohort: boolean): Promise<RsiSourceWorkspace> {
  const { repository, remote } = original
  await noAlternates(repository, false); await noAlternates(remote, true)
  const latest = records.at(-1)
  const tip = latest?.candidateTip ?? original.workspace.sourceCommit
  if (await git(repository, ['rev-parse', '--show-toplevel'], signal) !== repository
    || await git(repository, ['rev-parse', '--show-object-format=storage'], signal) !== 'sha1'
    || await git(repository, ['symbolic-ref', 'HEAD'], signal) !== 'refs/heads/repairs'
    || await git(repository, ['rev-parse', 'HEAD'], signal) !== tip
    || await directRef(repository, 'refs/heads/repairs', signal) !== tip
    || await git(repository, ['status', '--porcelain=v1', '--untracked-files=all'], signal) !== ''
    || await git(remote, ['rev-parse', '--is-bare-repository'], signal) !== 'true'
    || await git(remote, ['symbolic-ref', 'HEAD'], signal) !== 'refs/heads/repairs'
    || await directRef(repository, 'refs/dsh-source/repairs', signal) !== await directRef(remote, 'refs/heads/repairs', signal)) {
    fail('source Git state differs from signed maintenance')
  }
  const repair = await directRef(repository, 'refs/dsh-source/repairs', signal)
  if (!await ancestor(repository, original.workspace.sourceCommit, repair, signal)
    || !await ancestor(repository, original.workspace.sourceCommit, tip, signal)
    || !await ancestor(repository, tip, repair, signal)) fail('initial or managed source history is missing')
  if (!latest) return original.workspace
  for (const record of records) {
    if (record.originalBootstrapDigest !== hash(original.bytes)
      || record.after.sourceCommit !== record.candidateTip
      || !VERSION.test(record.after.version)
      || !await ancestor(repository, record.previousTip, record.candidateTip, signal)
      || !await ancestor(repository, record.upstreamCommit, record.candidateTip, signal)
      || await git(repository, ['rev-parse', `${record.candidateTip}^{tree}`], signal) !== record.sourceTree
      || await packageVersion(repository, record.candidateTip, signal) !== record.after.version) fail('signed source history differs from Git objects')
  }
  if (checkCohort) {
    const stageCohort = await cohortDigest(logicalHome, physicalHome, profile)
    if (stageCohort.digest !== latest.after.cohortDigest || stageCohort.sourceCommit !== tip
      || stageCohort.version !== latest.after.version) fail('source maintenance cohort differs')
  }
  return { ...original.workspace, sourceCommit: tip, version: latest.after.version }
}

export interface RsiSourceMaintenanceInput {
  logicalHome: string
  physicalHome: string
  profile: string
  signal?: AbortSignal
}
function validateInput(input: RsiSourceMaintenanceInput): void {
  if (!canonical(input.logicalHome) || !canonical(input.physicalHome) || !PROFILE.test(input.profile)) fail('invalid source maintenance path')
}

/** Read a copied or live source through its physical path while all receipts retain logical Home paths. */
async function readSourceState(input: RsiSourceMaintenanceInput, checkCohort: boolean): Promise<{
  workspace: RsiSourceWorkspace; originalBootstrapDigest: string; records: readonly SourceMaintenanceRecord[]
  anchor: SourceMaintenanceAnchor
}> {
  validateInput(input)
  const physicalHome = await realpath(input.physicalHome)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  const saved = await original(input.logicalHome, physicalHome, input.profile)
  const sidecar = join(physicalHome, 'rsi-sources', input.profile, 'maintenance.json')
  let records: readonly SourceMaintenanceRecord[] = []
  let hasSidecar = true
  try { await lstat(sidecar) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    hasSidecar = false
  }
  // Resolve the Host signing anchor on every read, including a live Home with no
  // sidecar, so maintenance producers can extend the chain without re-reading it.
  const anchor = await trustedAnchor(input.logicalHome, physicalHome, input.profile, saved)
  if (hasSidecar) {
    const parsed: unknown = JSON.parse((await privateFile(sidecar, 4_194_304)).toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 256) fail('source maintenance chain is invalid')
    records = verifySourceMaintenanceRecords(parsed as SourceMaintenanceRecord[], anchor)
    const first = records[0]!
    if (first.originalBootstrapDigest !== hash(saved.bytes)
      || first.before.sourceCommit !== saved.workspace.sourceCommit || first.before.version !== saved.workspace.version) fail('source maintenance origin differs')
    for (let index = 1; index < records.length; index++) if (!await ancestor(saved.repository,
      records[index - 1]!.candidateTip, records[index]!.previousTip, signal)) {
      fail('source maintenance tip chain differs')
    }
  }
  return { workspace: await repoState(saved, records, input.logicalHome, physicalHome, input.profile, signal, checkCohort),
    originalBootstrapDigest: hash(saved.bytes), records, anchor }
}

export async function readRsiSourceMaintenance(input: RsiSourceMaintenanceInput): ReturnType<typeof readSourceState> {
  return readSourceState(input, true)
}

export interface ApplyRsiSourceMaintenanceInput extends RsiSourceMaintenanceInput {
  sourceRepository: string
  candidateRoot: string
  records: readonly SourceMaintenanceRecord[]
}

/** Mutate only an already copied, stopped Home stage. The transaction owns Store append and service activation. */
export async function applyRsiSourceMaintenanceInStage(input: ApplyRsiSourceMaintenanceInput): Promise<Awaited<ReturnType<typeof readRsiSourceMaintenance>>> {
  validateInput(input)
  if (!canonical(input.sourceRepository) || !canonical(input.candidateRoot)
    || inside(input.logicalHome, input.candidateRoot) || inside(input.physicalHome, input.candidateRoot)) fail('candidate path is invalid')
  const physicalHome = await realpath(input.physicalHome)
  if (physicalHome === await realpath(input.logicalHome)) fail('source maintenance requires a distinct stopped stage')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(300_000)])
  // The stopped transaction has already staged the next cohort. Validate the
  // previous signed source/Git state without requiring the old cohort to remain
  // at its single-generation path; the candidate and record bind its digest.
  const current = await readSourceState(input, false)
  const saved = await original(input.logicalHome, physicalHome, input.profile)
  if (saved.workspace.origin.locator !== input.sourceRepository || input.records.length !== current.records.length + 1) {
    fail('source maintenance does not extend the current installation')
  }
  const anchor = await trustedAnchor(input.logicalHome, physicalHome, input.profile, saved)
  const records = verifySourceMaintenanceRecords(input.records, anchor)
  if (records.slice(0, -1).some((record, index) => sourceMaintenanceDigest(record) !== sourceMaintenanceDigest(current.records[index]))) {
    fail('source maintenance history changed')
  }
  const record = records.at(-1)!
  const candidateBytes = await privateFile(join(input.candidateRoot, 'receipt.json'), 65_536)
  const candidate = JSON.parse(candidateBytes.toString('utf8')) as Record<string, unknown>
  const { receiptDigest, ...candidateContent } = candidate
  const candidateRepository = join(input.candidateRoot, 'repository')
  await io.directory(candidateRepository)
  await noAlternates(candidateRepository, false)
  if (candidate.schemaVersion !== 1 || candidate.root !== input.candidateRoot || candidate.repository !== candidateRepository
    || !HASH.test(String(receiptDigest)) || hash(JSON.stringify(candidateContent)) !== receiptDigest
    || !HASH.test(String(candidate.candidateConfigDigest))
    || hash(await safeGitFile(join(candidateRepository, '.git', 'config'))) !== candidate.candidateConfigDigest
    || candidate.originalBootstrapDigest !== current.originalBootstrapDigest
    || candidate.originalCohortDigest !== record.before.cohortDigest
    || candidate.repairCommit !== record.previousTip || candidate.upstreamCommit !== record.upstreamCommit
    || candidate.sourceCommit !== record.candidateTip || candidate.sourceTree !== record.sourceTree
    || candidate.version !== record.after.version || candidate.receiptDigest !== record.preparationReceiptDigest
    || record.before.sourceCommit !== current.workspace.sourceCommit || record.before.version !== current.workspace.version
    || record.after.sourceCommit !== record.candidateTip || record.originalBootstrapDigest !== current.originalBootstrapDigest
    || await git(candidateRepository, ['rev-parse', 'HEAD'], signal) !== record.candidateTip
    || await git(candidateRepository, ['rev-parse', 'HEAD^{tree}'], signal) !== record.sourceTree
    || await git(candidateRepository, ['status', '--porcelain=v1', '--untracked-files=all'], signal) !== ''
    || !await ancestor(candidateRepository, record.previousTip, record.candidateTip, signal)
    || !await ancestor(candidateRepository, record.upstreamCommit, record.candidateTip, signal)) fail('candidate differs from signed source maintenance')
  const stageCohort = await cohortDigest(input.logicalHome, physicalHome, input.profile)
  if (stageCohort.digest !== record.after.cohortDigest || stageCohort.sourceCommit !== record.candidateTip
    || stageCohort.version !== record.after.version) fail('candidate cohort differs from signed source maintenance')
  const { repository, remote } = saved
  const oldRepair = await directRef(repository, 'refs/dsh-source/repairs', signal)
  if (oldRepair !== record.previousTip || await directRef(remote, 'refs/heads/repairs', signal) !== oldRepair) fail('staged repair ref changed')
  const root = join(physicalHome, 'rsi-sources', input.profile)
  const sidecar = join(root, 'maintenance.json'), temporary = join(root, `.maintenance-${sourceMaintenanceDigest(record)}.json`)
  const transferRef = 'refs/dsh-source/maintenance-candidate'
  let fetchedCheckout = false, fetchedBare = false
  let cleanupError: unknown
  try {
    await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', candidateRepository,
      `+${record.candidateTip}:${transferRef}`], signal)
    fetchedCheckout = true
    await git(remote, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', repository,
      `+${record.candidateTip}:${transferRef}`], signal)
    fetchedBare = true
    await git(repository, ['reset', '--hard', record.candidateTip], signal)
    await git(repository, ['update-ref', 'refs/dsh-source/repairs', record.candidateTip, oldRepair], signal)
    await git(remote, ['update-ref', 'refs/heads/repairs', record.candidateTip, oldRepair], signal)
    await io.writeExclusive(temporary, JSON.stringify(records))
    await rename(temporary, sidecar)
    await io.syncDirectory(root)
  } finally {
    const cleanupSignal = AbortSignal.timeout(30_000)
    const cleanup = await Promise.allSettled([
      rm(temporary, { force: true }),
      ...(fetchedBare ? [git(remote, ['update-ref', '-d', transferRef], cleanupSignal)] : []),
      ...(fetchedCheckout ? [git(repository, ['update-ref', '-d', transferRef], cleanupSignal)] : []),
    ])
    const failure = cleanup.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') cleanupError = failure.reason
  }
  if (cleanupError) throw cleanupError
  const result = await readRsiSourceMaintenance(input)
  if (result.workspace.sourceCommit !== record.candidateTip || result.records.length !== records.length) fail('staged source maintenance readback differs')
  return result
}
