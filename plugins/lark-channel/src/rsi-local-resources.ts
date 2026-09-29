import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { rsiBuildResources as io, type RsiBuildEnvironment } from './rsi-build.js'
import type { RsiReleaseBuildEnvironment } from './rsi-release-build.js'
import type { RsiLocalCohort } from './rsi-local-cohort.js'
import { readRsiLocalUpdateLocked } from './rsi-local-update.js'

const kinds = ['rsi-local-cohorts', 'rsi-builds', 'rsi-release-builds'] as const
type Kind = typeof kinds[number]
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function fail(message: string): never { throw new Error(`rsi local resources: ${message}`) }
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)
const exact = (path: string): boolean => isAbsolute(path) && resolve(path) === path && !path.includes('\0')
interface Entry { path: string; mode: number; sha256: string | null }
export interface RsiLocalResourceProof {
  schemaVersion: 1
  dshHome: string
  profile: string
  preparationDigest: string
  original: Record<Kind, string>
  candidate: Record<Kind, string>
}

/** Include modes and directories: matching file bytes alone cannot prove a
 * copied toolchain has retained its executable and private-directory contract. */
async function inventory(root: string, signal: AbortSignal): Promise<Entry[]> {
  let size = 0
  const entries: Entry[] = []
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const item = await lstat(path)
    if (entries.length >= 150_000 || item.isSymbolicLink() || (item.mode & 0o077) !== 0
      || process.getuid && item.uid !== process.getuid()) fail(`unsafe resource entry: ${path}`)
    if (item.isDirectory()) {
      await io.directory(path)
      entries.push({ path: relative(root, path), mode: item.mode & 0o777, sha256: null })
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (item.isFile() && item.nlink === 1) {
      size += item.size
      if (item.size > 268_435_456 || size > 4_294_967_296) fail('resource tree exceeds size bound')
      entries.push({ path: relative(root, path), mode: item.mode & 0o777,
        sha256: hash(await io.readStable(path, 268_435_456, true)) })
    } else fail(`resource is not a private regular file or directory: ${path}`)
  }
  await visit(root)
  return entries
}

function receipt(bytes: Buffer): Record<string, unknown> {
  const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid resource receipt')
  const { receiptDigest, ...body } = value
  if (receiptDigest !== hash(JSON.stringify(body))) fail('resource receipt digest differs')
  return body
}
function encode(body: object): string { return JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) }) }

/** Caller owns the Home lifecycle lock and has stopped all Home writers. Only
 * these three trees in the disposable stage are changed; source, profiles,
 * owner authority and ledger still require the enclosing activation transaction.
 * A crash requires discarding/recovering that stage, never reusing it as live. */
export async function stageRsiLocalUpdateResources(input: {
  logicalHome: string; stagePhysicalHome: string; profile: string; preparationRoot: string; signal?: AbortSignal
}): Promise<{ cohort: RsiLocalCohort; sourceBuild: RsiBuildEnvironment;
  releaseBuild: RsiReleaseBuildEnvironment; proof: RsiLocalResourceProof }> {
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(600_000)])
  const { logicalHome, stagePhysicalHome, profile } = input
  if (!exact(logicalHome) || !exact(stagePhysicalHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(profile)
    || await realpath(logicalHome) !== logicalHome || await realpath(stagePhysicalHome) !== stagePhysicalHome
    || inside(logicalHome, stagePhysicalHome) || inside(stagePhysicalHome, logicalHome)) fail('stage must be a distinct canonical stopped Home')
  await io.directory(stagePhysicalHome)
  const prepared = await readRsiLocalUpdateLocked({ dshHome: logicalHome, profile, root: input.preparationRoot, signal })
  if (!prepared.build || inside(stagePhysicalHome, prepared.root) || inside(prepared.root, stagePhysicalHome)) fail('stage overlaps preparation')
  const original = {} as Record<Kind, Entry[]>, candidate = {} as Record<Kind, Entry[]>
  for (const kind of kinds) {
    await io.directory(join(logicalHome, kind)); await io.directory(join(stagePhysicalHome, kind))
    await io.directory(join(prepared.candidateHome, kind))
    original[kind] = await inventory(join(logicalHome, kind, profile), signal)
    if (!isDeepStrictEqual(original[kind], await inventory(join(stagePhysicalHome, kind, profile), signal))) fail(`copied original differs: ${kind}`)
    candidate[kind] = await inventory(join(prepared.candidateHome, kind, profile), signal)
  }
  const cohortRoot = join(logicalHome, kinds[0], profile)
  const originalCohort = receipt(await io.readStable(join(cohortRoot, 'receipt.json'), 20_971_520, true))
  if (hash(JSON.stringify(originalCohort)) !== prepared.originalCohortDigest
    || typeof originalCohort.sourceRepository !== 'string' || !exact(originalCohort.sourceRepository)) fail('original cohort source differs')
  if (inside(originalCohort.sourceRepository, stagePhysicalHome)
    || inside(stagePhysicalHome, originalCohort.sourceRepository)) fail('stage overlaps upstream source repository')
  const { receiptDigest: _oldDigest, ...cohortBody } = prepared.cohort
  const cohort = JSON.parse(encode({ ...cohortBody, root: cohortRoot,
    sourceRepository: originalCohort.sourceRepository,
    packages: prepared.cohort.packages.map(item => ({ ...item, tarball: join(cohortRoot, 'artifacts', `${item.name.split('/')[1]}.tgz`) })) })) as RsiLocalCohort
  const buildBody = receipt(await io.readStable(join(prepared.candidateHome, kinds[1], profile, 'bootstrap.json'), 65_536, true))
  const sourceBuild: RsiBuildEnvironment = { ...prepared.build.sourceBuild, sourceBuild: {
    ...prepared.build.sourceBuild.sourceBuild,
    repositorySandbox: { ...prepared.build.sourceBuild.sourceBuild.repositorySandbox,
      seccompPath: join(logicalHome, kinds[1], profile, 'seccomp.json') },
  } }
  const releaseRoot = join(logicalHome, kinds[2], profile)
  const oldReleaseRoot = join(prepared.candidateHome, kinds[2], profile)
  const releaseBuild: RsiReleaseBuildEnvironment = { ...prepared.build.releaseBuild,
    releaseBuild: Object.fromEntries(Object.entries(prepared.build.releaseBuild.releaseBuild).map(([key, pin]) => [key,
      inside(oldReleaseRoot, pin.path) ? { ...pin, path: join(releaseRoot, relative(oldReleaseRoot, pin.path)) } : pin,
    ])) as unknown as RsiReleaseBuildEnvironment['releaseBuild'] }
  const releaseBody = receipt(await io.readStable(join(prepared.candidateHome, kinds[2], profile, 'bootstrap.json'), 65_536, true))
  const receipts: Record<Kind, { name: string; source: string }> = {
    'rsi-local-cohorts': { name: 'receipt.json', source: JSON.stringify(cohort) },
    'rsi-builds': { name: 'bootstrap.json', source: encode({ ...buildBody, dshHome: logicalHome,
      repository: join(logicalHome, 'rsi-sources', profile, 'checkout'), sourceBuild: sourceBuild.sourceBuild }) },
    'rsi-release-builds': { name: 'bootstrap.json', source: encode({ ...releaseBody, dshHome: logicalHome,
      releaseBuild: releaseBuild.releaseBuild }) },
  }
  const scratch = join(stagePhysicalHome, `.rsi-local-resources-${randomUUID()}`)
  await mkdir(scratch, { mode: 0o700 })
  const moved: Kind[] = [], installed: Kind[] = []
  let verified = false
  try {
    // Build all replacement trees and verify them before replacing any stage resource.
    for (const kind of kinds) {
      const next = join(scratch, kind), source = join(prepared.candidateHome, kind, profile)
      await cp(source, next, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
      if (!isDeepStrictEqual(await inventory(next, signal), candidate[kind])) fail(`resource changed during copy: ${kind}`)
      const update = receipts[kind], entry = candidate[kind].find(item => item.path === update.name)
      if (!entry || entry.sha256 === null) fail('resource receipt is missing from inventory')
      await writeFile(join(next, update.name), update.source, { mode: entry.mode })
      await chmod(join(next, update.name), entry.mode)
      candidate[kind] = candidate[kind].map(item => item.path === update.name ? { ...item, sha256: hash(update.source) } : item)
      if (!isDeepStrictEqual(await inventory(next, signal), candidate[kind])) fail(`rebased resource differs: ${kind}`)
    }
    // Revalidate the preparation and originals after copying, before stage mutation.
    if (!isDeepStrictEqual(await readRsiLocalUpdateLocked({ dshHome: logicalHome, profile, root: input.preparationRoot, signal }), prepared)) fail('preparation changed during copy')
    for (const kind of kinds) {
      if (!isDeepStrictEqual(await inventory(join(logicalHome, kind, profile), signal), original[kind])
        || !isDeepStrictEqual(await inventory(join(stagePhysicalHome, kind, profile), signal), original[kind])) fail(`original resource changed: ${kind}`)
    }
    for (const kind of kinds) {
      signal.throwIfAborted()
      await rename(join(stagePhysicalHome, kind, profile), join(scratch, `old-${kind}`)); moved.push(kind)
      await rename(join(scratch, kind), join(stagePhysicalHome, kind, profile)); installed.push(kind)
      await io.syncDirectory(join(stagePhysicalHome, kind))
    }
    const proof: RsiLocalResourceProof = { schemaVersion: 1, dshHome: logicalHome, profile,
      preparationDigest: prepared.receiptDigest,
      original: Object.fromEntries(kinds.map(kind => [kind, hash(JSON.stringify(original[kind]))])) as Record<Kind, string>,
      candidate: Object.fromEntries(kinds.map(kind => [kind, hash(JSON.stringify(candidate[kind]))])) as Record<Kind, string> }
    await verifyRsiLocalUpdateResources({ physicalHome: stagePhysicalHome, proof, signal })
    verified = true
    await rm(scratch, { recursive: true })
    return { cohort, sourceBuild, releaseBuild, proof }
  } catch (error) {
    // Once backup cleanup begins, an incomplete cleanup is not permission to
    // restore from backups that may already have been removed.
    if (verified) throw error
    // A failed restore deliberately keeps the scratch tree and surfaces the error.
    for (const kind of moved.reverse()) {
      if (installed.includes(kind)) await rm(join(stagePhysicalHome, kind, profile), { recursive: true })
      await rename(join(scratch, `old-${kind}`), join(stagePhysicalHome, kind, profile))
      await io.syncDirectory(join(stagePhysicalHome, kind))
    }
    await rm(scratch, { recursive: true })
    throw error
  }
}

export async function verifyRsiLocalUpdateResources(input: {
  physicalHome: string; proof: RsiLocalResourceProof; original?: boolean; signal?: AbortSignal
}): Promise<void> {
  const { proof, physicalHome } = input
  if (proof.schemaVersion !== 1 || !exact(physicalHome) || await realpath(physicalHome) !== physicalHome
    || !exact(proof.dshHome) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(proof.profile)
    || !/^[a-f0-9]{64}$/u.test(proof.preparationDigest)) fail('invalid resource proof binding')
  const signal = input.signal ?? new AbortController().signal
  for (const kind of kinds) {
    await io.directory(join(physicalHome, kind))
    if (hash(JSON.stringify(await inventory(join(physicalHome, kind, proof.profile), signal)))
      !== (input.original ? proof.original : proof.candidate)[kind]) fail(`resource proof differs: ${kind}`)
  }
}
