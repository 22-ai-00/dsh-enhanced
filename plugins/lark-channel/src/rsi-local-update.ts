import { createHash } from 'node:crypto'
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io } from './rsi-build.js'
import { prepareRsiLocalCohort, readRsiLocalCohort, verifyRsiLocalInstalledPackages,
  type RsiLocalCohort, type RsiLocalCohortPorts } from './rsi-local-cohort.js'
import { prepareRsiSourceWorkspace } from './rsi-source.js'
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
