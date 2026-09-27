import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { rsiBuildResources as io } from './rsi-build.js'
import { readRsiLocalCohort } from './rsi-local-cohort.js'
import { readRsiSourceWorkspace } from './rsi-source.js'

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const HASH = /^[a-f0-9]{64}$/u
const EXACT_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u
const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new Error(`rsi source update: ${message}`) }
const inside = (root: string, path: string): boolean => path === root || path.startsWith(`${root}${sep}`)

export interface RsiSourceUpdateCandidate {
  schemaVersion: 1
  root: string
  repository: string
  version: string
  sourceCommit: string
  sourceTree: string
  candidateConfigDigest: string
  upstreamCommit: string
  repairCommit: string
  originalBootstrapDigest: string
  originalCohortDigest: string
  receiptDigest: string
}

export interface RsiSourceUpdateInput {
  dshHome: string
  profile: string
  sourceRepository: string
  candidateRoot: string
  signal?: AbortSignal
}

function canonical(path: string, label: string): void {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path || path.includes('\0')) fail(`${label} must be canonical absolute`)
}
async function directory(path: string): Promise<void> {
  const item = await lstat(path)
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0
    || process.getuid && item.uid !== process.getuid() || await realpath(path) !== path) fail(`unsafe private directory: ${path}`)
}
async function privateFile(path: string, maximum: number): Promise<Buffer> {
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > maximum
    || (item.mode & 0o077) !== 0 || process.getuid && item.uid !== process.getuid()) fail(`unsafe private file: ${path}`)
  return io.readStable(path, maximum, true)
}
async function candidateConfigDigest(repository: string): Promise<string> {
  const path = join(repository, '.git', 'config')
  const item = await lstat(path)
  if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || item.size < 1 || item.size > 65_536
    || (item.mode & 0o022) !== 0 || process.getuid && item.uid !== process.getuid()) fail('candidate Git config is unsafe')
  return sha256(await io.readStable(path, 65_536, false))
}
function parseJson(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(`${label} is invalid`) }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`)
  return value as Record<string, unknown>
}
async function absent(path: string): Promise<boolean> {
  try { await lstat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}
function gitEnvironment(): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: '/nonexistent',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_COUNT: '0', GIT_ALLOW_PROTOCOL: 'file', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '/bin/false', GCM_INTERACTIVE: 'never',
    GIT_AUTHOR_NAME: 'DSH source update', GIT_AUTHOR_EMAIL: 'source-update@localhost',
    GIT_COMMITTER_NAME: 'DSH source update', GIT_COMMITTER_EMAIL: 'source-update@localhost',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00+0000', GIT_COMMITTER_DATE: '2000-01-01T00:00:00+0000',
    GIT_MERGE_AUTOEDIT: 'no', GIT_LFS_SKIP_SMUDGE: '1' }
}
const GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.allow=never',
  '-c', 'protocol.file.allow=always', '-c', 'credential.helper=', '-c', 'gc.auto=0',
  '-c', 'commit.gpgsign=false', '-c', 'merge.gpgsign=false'] as const
async function git(cwd: string, args: readonly string[], signal: AbortSignal): Promise<string> {
  return io.command('/usr/bin/git', [...GIT_FLAGS, '-C', cwd, ...args], gitEnvironment(), signal, 60_000, 65_536)
}
async function directRef(repository: string, name: string, signal: AbortSignal): Promise<string> {
  const value = await git(repository, ['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', name], signal)
  const fields = value.split('\0')
  if (fields.length !== 3 || fields[0] !== name || !COMMIT.test(fields[1]!) || fields[2] !== '') fail(`managed Git ref is missing or symbolic: ${name}`)
  return fields[1]!
}
async function ancestor(cwd: string, first: string, second: string, signal: AbortSignal): Promise<boolean> {
  // merge-base --is-ancestor returns 1 for a legitimate non-ancestor. The
  // explicit merge-base result avoids interpreting an arbitrary Git failure.
  const base = await git(cwd, ['merge-base', first, second], signal)
  if (!COMMIT.test(base)) fail('Git merge-base is invalid')
  return base === first
}
async function noAlternates(repository: string, bare = false): Promise<void> {
  const gitDirectory = bare ? repository : join(repository, '.git')
  const item = await lstat(gitDirectory)
  if (!item.isDirectory() || item.isSymbolicLink() || await realpath(gitDirectory) !== gitDirectory) fail('repository Git directory is not physical')
  for (const name of ['alternates', 'http-alternates']) if (!await absent(join(gitDirectory, 'objects', 'info', name))) {
    fail('external Git object alternates are forbidden')
  }
}
async function packageVersion(repository: string, ref: string, signal: AbortSignal): Promise<string> {
  const manifest = parseJson(Buffer.from(await git(repository, ['show', `${ref}:package.json`], signal)), 'candidate source package manifest')
  const candidateVersion = manifest.version
  if (manifest.name !== 'dsh-enhanced' || typeof candidateVersion !== 'string' || !EXACT_VERSION.test(candidateVersion)) {
    fail('candidate source package name or version is invalid')
  }
  return candidateVersion as string
}
async function original(input: RsiSourceUpdateInput, signal: AbortSignal) {
  const bootstrapPath = join(input.dshHome, 'rsi-sources', input.profile, 'bootstrap.json')
  const bootstrap = await privateFile(bootstrapPath, 65_536)
  const saved = parseJson(bootstrap, 'original source receipt')
  if (typeof saved.version !== 'string' || !EXACT_VERSION.test(saved.version)) fail('original source version is invalid')
  const source = await readRsiSourceWorkspace({ dshHome: input.dshHome, profile: input.profile,
    sourceRepository: input.sourceRepository, signal })
  if (source.origin.kind !== 'local-head' || source.origin.locator !== input.sourceRepository) fail('original source is not the selected local repository')
  const cohort = await readRsiLocalCohort({ dshHome: input.dshHome, profile: input.profile, source })
  await noAlternates(source.repository)
  await noAlternates(source.baseline.remote, true)
  const repairCommit = await directRef(source.repository, 'refs/dsh-source/repairs', signal)
  const bareTip = await directRef(source.baseline.remote, 'refs/heads/repairs', signal)
  if (bareTip !== repairCommit
    || !await ancestor(source.repository, source.sourceCommit, repairCommit, signal)) fail('current repair refs differ or lost their bootstrap ancestry')
  const upstreamCommit = await git(input.sourceRepository, ['rev-parse', 'HEAD'], signal)
  if (!COMMIT.test(upstreamCommit)) fail('upstream HEAD is invalid')
  await noAlternates(input.sourceRepository)
  const upstreamVersion = await packageVersion(input.sourceRepository, upstreamCommit, signal)
  return { source, cohort, originalBootstrapDigest: sha256(bootstrap), originalCohortDigest: cohort.receiptDigest,
    upstreamCommit, upstreamVersion, repairCommit }
}
async function currentOriginal(input: RsiSourceUpdateInput, expected: Awaited<ReturnType<typeof original>>, signal: AbortSignal): Promise<void> {
  const actual = await original(input, signal)
  if (actual.originalBootstrapDigest !== expected.originalBootstrapDigest
    || actual.originalCohortDigest !== expected.originalCohortDigest
    || actual.upstreamCommit !== expected.upstreamCommit || actual.repairCommit !== expected.repairCommit
    || actual.upstreamVersion !== expected.upstreamVersion
    || actual.source.sourceCommit !== expected.source.sourceCommit) fail('original source changed during preparation')
}
async function verifiedCandidate(repository: string, receipt: RsiSourceUpdateCandidate, signal: AbortSignal): Promise<void> {
  await directory(repository)
  await noAlternates(repository)
  if (await candidateConfigDigest(repository) !== receipt.candidateConfigDigest) fail('candidate Git config changed')
  if (await git(repository, ['rev-parse', '--show-toplevel'], signal) !== repository
    || await git(repository, ['rev-parse', '--show-object-format=storage'], signal) !== 'sha1'
    || await git(repository, ['symbolic-ref', 'HEAD'], signal) !== 'refs/heads/repairs'
    || await git(repository, ['rev-parse', 'HEAD'], signal) !== receipt.sourceCommit
    || await git(repository, ['rev-parse', 'HEAD^{tree}'], signal) !== receipt.sourceTree
    || await directRef(repository, 'refs/dsh-update/upstream', signal) !== receipt.upstreamCommit
    || await directRef(repository, 'refs/dsh-update/repair', signal) !== receipt.repairCommit
    || await git(repository, ['status', '--porcelain=v1', '--untracked-files=all'], signal) !== ''
    || !await ancestor(repository, receipt.upstreamCommit, receipt.sourceCommit, signal)
    || !await ancestor(repository, receipt.repairCommit, receipt.sourceCommit, signal)) fail('candidate repository differs from its receipt')
  if (await packageVersion(repository, receipt.sourceCommit, signal) !== receipt.version) fail('candidate merged package version differs from upstream')
}

/** Verify a completed immutable candidate and the original source it was prepared from. */
export async function readRsiSourceUpdate(input: RsiSourceUpdateInput): Promise<RsiSourceUpdateCandidate> {
  canonical(input.dshHome, 'DSH_HOME'); canonical(input.sourceRepository, 'source repository'); canonical(input.candidateRoot, 'candidate root')
  if (!PROFILE.test(input.profile) || inside(input.dshHome, input.candidateRoot)
    || inside(input.candidateRoot, input.dshHome) || inside(input.candidateRoot, input.sourceRepository)
    || inside(input.sourceRepository, input.candidateRoot)) fail('candidate scope is invalid')
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  await directory(dirname(input.candidateRoot))
  await directory(input.candidateRoot)
  if (JSON.stringify((await readdir(input.candidateRoot)).sort()) !== JSON.stringify(['receipt.json', 'repository'])) fail('candidate is incomplete')
  const source = await privateFile(join(input.candidateRoot, 'receipt.json'), 65_536)
  const receipt = parseJson(source, 'candidate receipt') as unknown as RsiSourceUpdateCandidate
  const { receiptDigest, ...content } = receipt
  if (receipt.schemaVersion !== 1 || receipt.root !== input.candidateRoot
    || receipt.repository !== join(input.candidateRoot, 'repository') || !EXACT_VERSION.test(String(receipt.version))
    || !COMMIT.test(String(receipt.sourceCommit)) || !COMMIT.test(String(receipt.sourceTree))
    || !HASH.test(String(receipt.candidateConfigDigest))
    || !COMMIT.test(String(receipt.upstreamCommit)) || !COMMIT.test(String(receipt.repairCommit))
    || !HASH.test(String(receipt.originalBootstrapDigest)) || !HASH.test(String(receipt.originalCohortDigest))
    || !HASH.test(String(receiptDigest)) || sha256(JSON.stringify(content)) !== receiptDigest) fail('candidate receipt differs')
  const baseline = await original(input, signal)
  if (baseline.originalBootstrapDigest !== receipt.originalBootstrapDigest
    || baseline.originalCohortDigest !== receipt.originalCohortDigest
    || baseline.upstreamCommit !== receipt.upstreamCommit || baseline.repairCommit !== receipt.repairCommit
    || baseline.upstreamVersion !== receipt.version) fail('candidate original source changed')
  await verifiedCandidate(receipt.repository, receipt, signal)
  await currentOriginal(input, baseline, signal)
  return receipt
}

/** Build a candidate outside DSH_HOME; this never changes the live source refs. */
export async function prepareRsiSourceUpdate(input: RsiSourceUpdateInput): Promise<RsiSourceUpdateCandidate> {
  canonical(input.dshHome, 'DSH_HOME'); canonical(input.sourceRepository, 'source repository'); canonical(input.candidateRoot, 'candidate root')
  if (!PROFILE.test(input.profile) || inside(input.dshHome, input.candidateRoot)
    || inside(input.candidateRoot, input.dshHome) || inside(input.candidateRoot, input.sourceRepository)
    || inside(input.sourceRepository, input.candidateRoot)) fail('candidate scope is invalid')
  await directory(dirname(input.candidateRoot))
  if (!await absent(input.candidateRoot)) return readRsiSourceUpdate(input)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(300_000)])
  const baseline = await original(input, signal)
  const stage = await mkdtemp(join(dirname(input.candidateRoot), `.${input.profile}-source-stage-`))
  let claimed: { dev: number; ino: number } | undefined
  try {
    await directory(stage)
    const repository = join(stage, 'repository'), template = join(stage, 'empty-template')
    await mkdir(repository, { mode: 0o700 }); await mkdir(template, { mode: 0o700 })
    await git(repository, ['init', '--object-format=sha1', '--initial-branch=repairs', `--template=${template}`, '.'], signal)
    await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
      input.sourceRepository, `+${baseline.upstreamCommit}:refs/dsh-update/upstream`], signal)
    await git(repository, ['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules',
      baseline.source.repository, `+${baseline.repairCommit}:refs/dsh-update/repair`], signal)
    await git(repository, ['checkout', '-B', 'repairs', baseline.repairCommit], signal)
    if (await ancestor(repository, baseline.repairCommit, baseline.upstreamCommit, signal)) {
      await git(repository, ['merge', '--ff-only', 'refs/dsh-update/upstream'], signal)
    } else if (!await ancestor(repository, baseline.upstreamCommit, baseline.repairCommit, signal)) {
      try { await git(repository, ['merge', '--no-ff', '--no-edit', '--strategy=ort', 'refs/dsh-update/upstream'], signal) }
      catch { fail('upstream and repair commits cannot be merged without conflict') }
    }
    const sourceCommit = await git(repository, ['rev-parse', 'HEAD'], signal)
    const sourceTree = await git(repository, ['rev-parse', 'HEAD^{tree}'], signal)
    if (!COMMIT.test(sourceCommit) || !COMMIT.test(sourceTree)) fail('candidate Git result is invalid')
    if (await packageVersion(repository, sourceCommit, signal) !== baseline.upstreamVersion) {
      fail('candidate merged package version differs from upstream')
    }
    const configDigest = await candidateConfigDigest(repository)
    await currentOriginal(input, baseline, signal)
    await mkdir(input.candidateRoot, { mode: 0o700 })
    const identity = await stat(input.candidateRoot); claimed = { dev: identity.dev, ino: identity.ino }
    await rename(repository, join(input.candidateRoot, 'repository'))
    const content = { schemaVersion: 1 as const, root: input.candidateRoot, repository: join(input.candidateRoot, 'repository'),
      version: baseline.upstreamVersion, sourceCommit, sourceTree, candidateConfigDigest: configDigest,
      upstreamCommit: baseline.upstreamCommit, repairCommit: baseline.repairCommit,
      originalBootstrapDigest: baseline.originalBootstrapDigest, originalCohortDigest: baseline.originalCohortDigest }
    const receipt: RsiSourceUpdateCandidate = { ...content, receiptDigest: sha256(JSON.stringify(content)) }
    await io.writeExclusive(join(input.candidateRoot, 'receipt.json'), JSON.stringify(receipt))
    await io.syncDirectory(input.candidateRoot); await io.syncDirectory(dirname(input.candidateRoot))
    return await readRsiSourceUpdate(input)
  } catch (error) {
    if (claimed) {
      const item = await lstat(input.candidateRoot).catch(() => undefined)
      if (item?.isDirectory() && item.dev === claimed.dev && item.ino === claimed.ino
        && await absent(join(input.candidateRoot, 'receipt.json'))
        && (await readdir(input.candidateRoot)).every(name => name === 'repository')) {
        await rm(input.candidateRoot, { recursive: true, force: true })
      }
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }) }
}
