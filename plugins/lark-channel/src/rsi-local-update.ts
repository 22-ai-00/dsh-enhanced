import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io, readRsiBuildEnvironment } from './rsi-build.js'
import { readRsiReleaseBuildEnvironment } from './rsi-release-build.js'
import { prepareRsiLocalCohort, readRsiLocalCohort, verifyRsiLocalInstalledPackages,
  type RsiLocalCohort, type RsiLocalCohortPorts } from './rsi-local-cohort.js'
import { prepareRsiSourceWorkspace, readRsiSourceWorkspace } from './rsi-source.js'
import { prepareRsiSourceUpdate, readRsiSourceUpdate, type RsiSourceUpdateCandidate } from './rsi-source-update.js'
import { withDshHomeLifecycleLock } from './setup.js'
import { prepareRsiLocalUpdateBuild } from './rsi-local-update-build.js'

const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const fail = (message: string): never => { throw new Error(`rsi local update: ${message}`) }
const profileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
export interface RsiLocalUpdateInput { dshHome: string; profile: string; sourceRepository: string; signal?: AbortSignal }
export interface RsiLocalUpdatePreparation {
  schemaVersion: 1
  mode: 'prepared'
  dshHome: string
  profile: string
  root: string
  candidateHome: string
  originalCohortDigest: string
  source: RsiSourceUpdateCandidate
  cohort: RsiLocalCohort
  build: Awaited<ReturnType<typeof prepareRsiLocalUpdateBuild>>['evidence'] | null
  receiptDigest: string
}

/** Caller owns the original Home lifecycle lock. Reading a completed candidate
 * never creates missing resources and does not run candidate build scripts. */
export async function readRsiLocalUpdateLocked(input: { dshHome: string; profile: string; root: string;
  signal?: AbortSignal }): Promise<RsiLocalUpdatePreparation> {
  if (process.platform !== 'linux' || !profileName.test(input.profile)
    || !isAbsolute(input.dshHome) || resolve(input.dshHome) !== input.dshHome
    || !isAbsolute(input.root) || resolve(input.root) !== input.root
    || await realpath(input.dshHome) !== input.dshHome || await realpath(input.root) !== input.root) fail('invalid preparation identity')
  await io.directory(input.dshHome, false)
  const parent = join(dirname(input.dshHome), `.dsh-rsi-local-updates-${hash(input.dshHome).slice(0, 16)}`)
  if (dirname(input.root) !== parent) fail('preparation is outside its bound parent')
  await io.directory(parent); await io.directory(input.root)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(180_000)])
  signal.throwIfAborted()
  const raw = await io.readStable(join(input.root, 'receipt.json'), 20_971_520, true)
  const saved = JSON.parse(raw.toString('utf8')) as RsiLocalUpdatePreparation
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)
    || !isDeepStrictEqual(Object.keys(saved).sort(), ['schemaVersion', 'mode', 'dshHome', 'profile', 'root',
      'candidateHome', 'originalCohortDigest', 'source', 'cohort', 'build', 'receiptDigest'].sort())) fail('prepared update receipt is invalid')
  const { receiptDigest, ...body } = saved
  if (receiptDigest !== hash(JSON.stringify(body)) || saved.schemaVersion !== 1 || saved.mode !== 'prepared'
    || saved.dshHome !== input.dshHome || saved.profile !== input.profile || saved.root !== input.root
    || saved.candidateHome !== join(input.root, 'home') || !saved.build) fail('prepared update receipt binding differs')
  if (!isDeepStrictEqual((await readdir(input.root)).sort(), ['home', 'receipt.json', 'source'])) fail('unexpected preparation contents')
  const original = await readRsiLocalCohort(input)
  if (saved.originalCohortDigest !== original.receiptDigest) fail('prepared update no longer matches installed cohort')
  const sourceInput = { dshHome: input.dshHome, profile: input.profile, sourceRepository: original.sourceRepository,
    candidateRoot: join(input.root, 'source'), signal }
  const source = await readRsiSourceUpdate(sourceInput)
  const identity = hash(JSON.stringify({ preparation: 'isolated-build-v1', home: input.dshHome, profile: input.profile,
    original: original.receiptDigest, upstreamCommit: source.upstreamCommit, repairCommit: source.repairCommit }))
  if (join(parent, identity) !== input.root || !isDeepStrictEqual(saved.source, source)) fail('prepared source differs')
  const workspace = await readRsiSourceWorkspace({ dshHome: saved.candidateHome, profile: input.profile,
    sourceRepository: source.repository, signal })
  if (workspace.sourceCommit !== source.sourceCommit || workspace.version !== source.version) fail('candidate workspace differs from prepared source')
  const cohort = await readRsiLocalCohort({ dshHome: saved.candidateHome, profile: input.profile, source: workspace })
  const sourceBuild = await readRsiBuildEnvironment({ dshHome: saved.candidateHome, profile: input.profile, source: workspace, signal })
  const releaseBuild = await readRsiReleaseBuildEnvironment({ dshHome: saved.candidateHome, profile: input.profile, build: sourceBuild, signal })
  if (!isDeepStrictEqual(saved.cohort, cohort) || !isDeepStrictEqual(saved.build, { sourceBuild, releaseBuild })) fail('prepared build or cohort differs')
  await verifyRsiLocalInstalledPackages({ cohort: original, profilePath: join(input.dshHome, 'profiles', input.profile) })
  if (!isDeepStrictEqual(await readRsiSourceUpdate(sourceInput), source)
    || !isDeepStrictEqual(await readRsiLocalCohort(input), original)
    || !(await io.readStable(join(input.root, 'receipt.json'), 20_971_520, true)).equals(raw)) fail('preparation or original changed during verification')
  signal.throwIfAborted()
  return saved
}

export async function readRsiLocalUpdate(input: Parameters<typeof readRsiLocalUpdateLocked>[0]): Promise<RsiLocalUpdatePreparation> {
  return withDshHomeLifecycleLock(input.dshHome, () => readRsiLocalUpdateLocked(input))
}

async function privateDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(path)
}
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
async function commit(repository: string, ref: string, signal: AbortSignal): Promise<string> {
  const value = await io.command('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never',
    '-C', repository, 'rev-parse', '--verify', `${ref}^{commit}`],
  { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_COUNT: '0', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' }, signal, 15_000, 1024)
  if (!/^[a-f0-9]{40}$/u.test(value)) fail('source ref is not an exact commit')
  return value
}

/** Build a reusable update candidate without stopping or changing the installed
 * Agent. Activation must separately reconcile signed history and migrate the
 * candidate into a stopped Home transaction; this receipt does not authorize it. */
export async function prepareRsiLocalUpdate(input: RsiLocalUpdateInput,
  ports?: RsiLocalCohortPorts): Promise<RsiLocalUpdatePreparation> {
  if (process.platform !== 'linux' || !profileName.test(input.profile)
    || !isAbsolute(input.dshHome) || resolve(input.dshHome) !== input.dshHome
    || !isAbsolute(input.sourceRepository) || resolve(input.sourceRepository) !== input.sourceRepository
    || await realpath(input.dshHome) !== input.dshHome
    || await realpath(input.sourceRepository) !== input.sourceRepository) fail('invalid local update identity')
  await io.directory(input.dshHome, false)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(2_400_000)])
  return withDshHomeLifecycleLock(input.dshHome, async () => {
    const original = await readRsiLocalCohort(input)
    if (original.sourceRepository !== input.sourceRepository) fail('update source differs from installed cohort')
    const profilePath = join(input.dshHome, 'profiles', input.profile)
    await verifyRsiLocalInstalledPackages({ cohort: original, profilePath })
    const upstreamCommit = await commit(input.sourceRepository, 'HEAD', signal)
    const repository = join(input.dshHome, 'rsi-sources', input.profile, 'checkout')
    const repairCommit = await commit(repository, 'refs/dsh-source/repairs', signal)
    const identity = hash(JSON.stringify({ preparation: 'isolated-build-v1', home: input.dshHome, profile: input.profile,
      original: original.receiptDigest, upstreamCommit, repairCommit }))
    // Outside Home so preparing/building never changes an active Agent's input
    // tree. Each exact upstream/repair pair has a distinct immutable directory.
    const parent = join(dirname(input.dshHome), `.dsh-rsi-local-updates-${hash(input.dshHome).slice(0, 16)}`)
    if (parent === input.sourceRepository || parent.startsWith(input.sourceRepository + '/')) fail('preparation directory would modify the source repository')
    await privateDirectory(parent)
    const root = join(parent, identity)
    await privateDirectory(root)
    const candidateHome = join(root, 'home'), receiptPath = join(root, 'receipt.json')
    const sourceInput = { ...input, candidateRoot: join(root, 'source'), signal }
    const source = await prepareRsiSourceUpdate(sourceInput)
    if (source.upstreamCommit !== upstreamCommit || source.repairCommit !== repairCommit) fail('source changed during preparation')
    await privateDirectory(candidateHome)
    const workspace = await prepareRsiSourceWorkspace({ dshHome: candidateHome, profile: input.profile,
      version: source.version, sourceRepository: source.repository, signal })
    if (workspace.sourceCommit !== source.sourceCommit) fail('candidate checkout differs from merged source')
    const builder = ports ? undefined : await prepareRsiLocalUpdateBuild({ dshHome: candidateHome,
      profile: input.profile, source: workspace, signal })
    const cohort = await prepareRsiLocalCohort({ dshHome: candidateHome, profile: input.profile,
      source: workspace, bundles: original.bundles, signal }, ports ?? builder!.ports)
    const verifyOriginal = async () => {
      if (!isDeepStrictEqual(await readRsiSourceUpdate(sourceInput), source)
        || !isDeepStrictEqual(await readRsiLocalCohort(input), original)) fail('installed source or cohort changed during build')
      await verifyRsiLocalInstalledPackages({ cohort: original, profilePath })
      signal.throwIfAborted()
    }
    await verifyOriginal()
    const content = { schemaVersion: 1 as const, mode: 'prepared' as const, dshHome: input.dshHome,
      profile: input.profile, root, candidateHome, originalCohortDigest: original.receiptDigest, source, cohort,
      build: builder?.evidence ?? null }
    const result = { ...content, receiptDigest: hash(JSON.stringify(content)) }
    if (await exists(receiptPath)) {
      const existing = JSON.parse((await io.readStable(receiptPath, 20_971_520, true)).toString('utf8')) as unknown
      if (!isDeepStrictEqual(existing, result)) fail('prepared update receipt differs')
    } else {
      await io.writeExclusive(receiptPath, JSON.stringify(result)); await io.syncDirectory(root)
    }
    if (!isDeepStrictEqual((await readdir(root)).sort(), ['home', 'receipt.json', 'source'])) fail('unexpected preparation contents')
    // The caller may inspect a completed receipt, but a stale candidate can
    // never be treated as permission to overwrite newer source or task state.
    await verifyOriginal()
    return result
  })
}
