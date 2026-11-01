import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  migrateLinuxVerifierRunnerState, prepareLinuxRepositoryHandoverState, prepareLinuxVerifierHandoverState,
  prepareLinuxVerifierStagingState,
} from '@dsh-enhanced/assistant-isolation'
import { rsiBuildResources as io } from './rsi-build.js'
import type { LinuxRsiBuildEnvironment } from './rsi-linux-runtime-bootstrap.js'
import type { NativeRsiReleaseBuildEnvironment } from './rsi-release-build.js'
import type { RsiLocalCohort } from './rsi-local-cohort.js'
import { readRsiLocalUpdateLocked, type RsiLocalUpdatePreparation } from './rsi-local-update.js'
import {
  openLinuxRsiNativeRelocatedFamily, openLinuxRsiNativeRelocatedFamilyAt, relocateLinuxRsiNativeFamily,
  type LinuxRsiNativeRelocatedFamily, type LinuxRsiNativeRelocationProof,
} from './rsi-linux-native-relocation.js'
import { compileRsiLinuxSourceBuild } from './rsi-linux-source-build.js'
import { prepareRsiLinuxRunnerStates, validateRsiLinuxRunnerStates } from './rsi-linux-runner-states.js'

export {
  // Reviewed installer seams of the linux-native owner program transaction,
  // re-exported here so the installer allowlist only needs this module name.
  compileRsiLinuxSourceBuild,
  migrateLinuxVerifierRunnerState,
  prepareLinuxRepositoryHandoverState,
  prepareLinuxVerifierHandoverState,
  prepareLinuxVerifierStagingState,
  prepareRsiLinuxRunnerStates,
  validateRsiLinuxRunnerStates,
}
export type { LinuxRsiNativeRelocatedFamily, LinuxRsiNativeRelocationProof }

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const HEX = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const COHORT = 'rsi-local-cohorts'
const DOCKER_KINDS = ['rsi-builds', 'rsi-release-builds', 'rsi-creation-builds'] as const
const MAX_ENTRIES = 150_000
const MAX_FILE_BYTES = 268_435_456
const MAX_TOTAL_BYTES = 4_294_967_296
const MAX_RECEIPT_BYTES = 20_971_520

function fail(message: string): never { throw new Error(`rsi Linux native resources: ${message}`) }
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const exact = (path: unknown): path is string => typeof path === 'string' && isAbsolute(path)
  && resolve(path) === path && !path.includes('\0')
const inside = (root: string, path: string): boolean => path === root || path.startsWith(root + sep)

interface Entry { path: string; mode: number; sha256: string | null }

/** Native candidate resources. No Docker image receipt is staged; the built
 * runtime/repository/behavior/creation/release families are relocated into the
 * stopped stage Home by `stageLinuxRsiNativeResources` instead. */
export interface LinuxRsiNativeResourceProof {
  schemaVersion: 1
  backend: 'linux-native'
  logicalHome: string
  physicalHome: string
  profile: string
  preparationDigest: string
  cohortDigest: string
  relocation: LinuxRsiNativeRelocationProof
}

/** Include modes and directories: matching file bytes alone cannot prove a
 * copied toolchain has retained its executable and private-directory contract. */
async function inventory(root: string, signal: AbortSignal): Promise<Entry[]> {
  let size = 0
  const entries: Entry[] = []
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const item = await lstat(path)
    if (entries.length >= MAX_ENTRIES || item.isSymbolicLink() || (item.mode & 0o077) !== 0
      || process.getuid && item.uid !== process.getuid()) fail(`unsafe resource entry: ${path}`)
    if (item.isDirectory()) {
      await io.directory(path)
      entries.push({ path: relative(root, path), mode: item.mode & 0o777, sha256: null })
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (item.isFile() && item.nlink === 1) {
      size += item.size
      if (item.size > MAX_FILE_BYTES || size > MAX_TOTAL_BYTES) fail('resource tree exceeds size bound')
      entries.push({ path: relative(root, path), mode: item.mode & 0o777,
        sha256: hash(await io.readStable(path, MAX_FILE_BYTES, true)) })
    } else fail(`resource is not a private regular file or directory: ${path}`)
  }
  await visit(root)
  return entries
}

function receipt(bytes: Buffer): Record<string, unknown> {
  const value = JSON.parse(bytes.toString('utf8')) as unknown
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid native resource receipt')
  const record = value as Record<string, unknown>
  const { receiptDigest, ...body } = record
  if (receiptDigest !== hash(JSON.stringify(body))) fail('native resource receipt digest differs')
  return record
}
function encode(body: object): string { return JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) }) }

function nativeBuild(preparation: RsiLocalUpdatePreparation): {
  sourceBuild: LinuxRsiBuildEnvironment
  releaseBuild: NativeRsiReleaseBuildEnvironment
} {
  const build = preparation.build ?? fail('preparation has no candidate build evidence')
  const sourceBuild = build.sourceBuild
  if (sourceBuild.schemaVersion !== 3 || sourceBuild.backend !== 'linux-native') {
    fail('candidate build is not a Linux native runtime')
  }
  const releaseBuild = build.releaseBuild
  if (releaseBuild.schemaVersion !== 2 || releaseBuild.backend !== 'linux-native') {
    fail('candidate release is not a Linux native release build')
  }
  if (releaseBuild.sourceCommit !== sourceBuild.sourceCommit) fail('candidate release source differs')
  return { sourceBuild, releaseBuild }
}

async function readPreparation(input: {
  logicalHome: string; stagePhysicalHome: string; profile: string; preparationRoot: string; signal?: AbortSignal
}): Promise<{ prepared: RsiLocalUpdatePreparation; signal: AbortSignal }> {
  const { logicalHome, stagePhysicalHome, profile } = input
  if (!exact(logicalHome) || !exact(stagePhysicalHome) || !exact(input.preparationRoot) || !PROFILE.test(profile)
    || stagePhysicalHome === logicalHome || inside(logicalHome, stagePhysicalHome)
    || inside(stagePhysicalHome, logicalHome)
    || await realpath(logicalHome) !== logicalHome || await realpath(stagePhysicalHome) !== stagePhysicalHome
    || inside(input.preparationRoot, stagePhysicalHome) || inside(stagePhysicalHome, input.preparationRoot)) {
    fail('stage must be a distinct canonical stopped Home outside the preparation root')
  }
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(600_000)])
  await io.directory(stagePhysicalHome)
  const prepared = await readRsiLocalUpdateLocked({ dshHome: logicalHome, profile, root: input.preparationRoot, signal })
  nativeBuild(prepared)
  return { prepared, signal }
}

/** Replace the stage Home's cohort tree with the prepared candidate cohort,
 * rebased onto the logical Home so no receipt ever records a disposable path.
 * Only `rsi-local-cohorts` changes; the live Home and the prepared candidate
 * Home are verified unchanged immediately before the rename swap. */
async function stageCohort(input: {
  prepared: RsiLocalUpdatePreparation; logicalHome: string; stagePhysicalHome: string; profile: string
  preparationRoot: string; signal: AbortSignal
}): Promise<RsiLocalCohort> {
  const { prepared, logicalHome, stagePhysicalHome, profile, signal } = input
  await io.directory(join(logicalHome, COHORT))
  await io.directory(join(stagePhysicalHome, COHORT))
  await io.directory(join(prepared.candidateHome, COHORT))
  const original = await inventory(join(logicalHome, COHORT, profile), signal)
  if (!isDeepStrictEqual(original, await inventory(join(stagePhysicalHome, COHORT, profile), signal))) {
    fail('copied original cohort differs')
  }
  const candidate = await inventory(join(prepared.candidateHome, COHORT, profile), signal)
  const cohortRoot = join(logicalHome, COHORT, profile)
  const originalCohort = receipt(await io.readStable(join(cohortRoot, 'receipt.json'), MAX_RECEIPT_BYTES, true))
  if (originalCohort.receiptDigest !== prepared.originalCohortDigest
    || typeof originalCohort.sourceRepository !== 'string' || !exact(originalCohort.sourceRepository)) {
    fail('original cohort source differs')
  }
  if (inside(originalCohort.sourceRepository, stagePhysicalHome)
    || inside(stagePhysicalHome, originalCohort.sourceRepository)) fail('stage overlaps upstream source repository')
  const { receiptDigest: _oldDigest, ...cohortBody } = prepared.cohort
  const cohort = JSON.parse(encode({ ...cohortBody, root: cohortRoot,
    sourceRepository: originalCohort.sourceRepository,
    packages: prepared.cohort.packages.map(item => ({ ...item,
      tarball: join(cohortRoot, 'artifacts', `${item.name.split('/')[1]}.tgz`) })) })) as RsiLocalCohort
  const scratch = join(stagePhysicalHome, `.rsi-linux-native-cohort-${randomUUID()}`)
  await mkdir(scratch, { mode: 0o700 })
  let moved = false
  try {
    const next = join(scratch, COHORT)
    await cp(join(prepared.candidateHome, COHORT, profile), next,
      { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    if (!isDeepStrictEqual(await inventory(next, signal), candidate)) fail('cohort changed during copy')
    const entry = candidate.find(item => item.path === 'receipt.json')
    if (!entry || entry.sha256 === null) fail('cohort receipt is missing from the inventory')
    const bytes = JSON.stringify(cohort)
    await writeFile(join(next, 'receipt.json'), bytes, { mode: entry.mode })
    await chmod(join(next, 'receipt.json'), entry.mode)
    const expected = candidate.map(item => item.path === 'receipt.json' ? { ...item, sha256: hash(bytes) } : item)
    if (!isDeepStrictEqual(await inventory(next, signal), expected)) fail('rebased cohort differs')
    if (!isDeepStrictEqual(await readRsiLocalUpdateLocked({ dshHome: logicalHome, profile,
      root: input.preparationRoot, signal }), prepared)) fail('preparation changed during copy')
    if (!isDeepStrictEqual(await inventory(join(logicalHome, COHORT, profile), signal), original)
      || !isDeepStrictEqual(await inventory(join(stagePhysicalHome, COHORT, profile), signal), original)) {
      fail('original cohort changed')
    }
    await rename(join(stagePhysicalHome, COHORT, profile), join(scratch, 'old'))
    moved = true
    await rename(next, join(stagePhysicalHome, COHORT, profile))
    await io.syncDirectory(join(stagePhysicalHome, COHORT))
    await rm(scratch, { recursive: true })
    return cohort
  } catch (error) {
    if (moved) {
      await rm(join(stagePhysicalHome, COHORT, profile), { recursive: true })
      await rename(join(scratch, 'old'), join(stagePhysicalHome, COHORT, profile))
      await io.syncDirectory(join(stagePhysicalHome, COHORT))
    }
    await rm(scratch, { recursive: true })
    throw error
  }
}

/** Remove one Docker-era build tree from the stopped stage Home. A linux-native
 * stage must hold exactly one backend: `readRsiLocalUpdateSourceBuild` refuses a
 * Home carrying both the Docker and the native receipts. */
async function dropDockerTree(stagePhysicalHome: string, profile: string, kind: string): Promise<void> {
  const root = join(stagePhysicalHome, kind)
  const missing = (error: NodeJS.ErrnoException): undefined => {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
  if (await lstat(root).catch(missing) === undefined) return
  await io.directory(root)
  const path = join(root, profile)
  const item = await lstat(path).catch(missing)
  if (item === undefined) return
  if (!item.isDirectory() || item.isSymbolicLink() || (item.mode & 0o077) !== 0
    || process.getuid && item.uid !== process.getuid()) fail(`unsafe staged ${kind} tree`)
  await rm(path, { recursive: true })
  await io.syncDirectory(root)
}

/** Preparation-phase handover for a linux-native candidate. The disposable Home
 * only receives the rebased cohort that the profile preparation reads; the
 * native families are relocated later, in the stopped stage Home, so a
 * preparation failure can never publish a half-built runtime. */
export async function prepareLinuxRsiNativeResources(input: {
  logicalHome: string; stagePhysicalHome: string; profile: string; preparationRoot: string; signal?: AbortSignal
}): Promise<{ cohort: RsiLocalCohort }> {
  const { prepared, signal } = await readPreparation(input)
  const cohort = await stageCohort({ prepared, logicalHome: input.logicalHome,
    stagePhysicalHome: input.stagePhysicalHome, profile: input.profile,
    preparationRoot: input.preparationRoot, signal })
  return { cohort }
}

/** Stage-phase handover for a linux-native candidate: drop the Docker-era build
 * trees, stage the rebased cohort, then relocate the independently verified
 * native families into the stopped stage Home. The returned proof is the only
 * record the cutover and every later verification read. */
export async function stageLinuxRsiNativeResources(input: {
  logicalHome: string; stagePhysicalHome: string; profile: string; preparationRoot: string; signal?: AbortSignal
}): Promise<{ cohort: RsiLocalCohort; family: LinuxRsiNativeRelocatedFamily; proof: LinuxRsiNativeResourceProof }> {
  const { prepared, signal } = await readPreparation(input)
  const { logicalHome, stagePhysicalHome, profile } = input
  for (const kind of DOCKER_KINDS) await dropDockerTree(stagePhysicalHome, profile, kind)
  const cohort = await stageCohort({ prepared, logicalHome, stagePhysicalHome, profile,
    preparationRoot: input.preparationRoot, signal })
  const relocation = await relocateLinuxRsiNativeFamily({ sourceHome: prepared.candidateHome,
    physicalHome: stagePhysicalHome, logicalHome, profile, existingLogicalHome: logicalHome, signal })
  const family = await openLinuxRsiNativeRelocatedFamily(relocation)
  if (family.runtime.sourceCommit !== prepared.source.sourceCommit) fail('relocated runtime source differs')
  if (family.creationBuild.sourceCommit !== prepared.source.sourceCommit) fail('relocated creation build source differs')
  const proof: LinuxRsiNativeResourceProof = { schemaVersion: 1, backend: 'linux-native', logicalHome,
    physicalHome: stagePhysicalHome, profile, preparationDigest: prepared.receiptDigest,
    cohortDigest: cohort.receiptDigest, relocation }
  await auditNativeResources(proof, stagePhysicalHome, family)
  return { cohort, family, proof }
}

/** Verify a staged or already-cut-over native resource proof. `physicalHome` may
 * be the sealed stage Home or the logical Home the trees were renamed into: the
 * rename preserves the sealed dev/ino and content identity, and the cohort
 * receipt always records logical paths. */
export async function verifyLinuxRsiNativeResources(input: {
  proof: LinuxRsiNativeResourceProof; physicalHome: string; signal?: AbortSignal
}): Promise<void> {
  const { proof } = input
  if (!relocationProof(proof) || !exact(proof.logicalHome) || !exact(proof.physicalHome)
    || !PROFILE.test(proof.profile) || !HEX.test(proof.preparationDigest) || !HEX.test(proof.cohortDigest)) {
    fail('invalid native resource proof binding')
  }
  const physicalHome = input.physicalHome
  if (!exact(physicalHome) || await realpath(physicalHome) !== physicalHome) {
    fail('invalid native resource physical Home')
  }
  if (physicalHome !== proof.physicalHome && physicalHome !== proof.logicalHome) {
    fail('native resource proof does not describe this physical Home')
  }
  input.signal?.throwIfAborted()
  // Re-hashes the relocated families from physical Home only; the logical Home is
  // never read here, so post-cutover verification stays a pure stage/Home check.
  const family = await openLinuxRsiNativeRelocatedFamilyAt(proof.relocation, physicalHome)
  await auditNativeResources(proof, physicalHome, family)
}

function relocationProof(proof: LinuxRsiNativeResourceProof): LinuxRsiNativeRelocationProof | undefined {
  const value = (proof as { relocation?: unknown }).relocation
  if (value === null || typeof value !== 'object') return undefined
  const relocation = value as Partial<LinuxRsiNativeRelocationProof>
  if (relocation.schemaVersion !== 1 || relocation.backend !== 'linux-native'
    || relocation.logicalHome !== proof.logicalHome || relocation.physicalHome !== proof.physicalHome
    || relocation.profile !== proof.profile) return undefined
  return relocation as LinuxRsiNativeRelocationProof
}

/** Cheap, non-family checks shared by the stage handover and every later
 * verification: the rebased cohort receipt and its packaged tarballs. */
async function auditNativeResources(proof: LinuxRsiNativeResourceProof, physicalHome: string,
  family: LinuxRsiNativeRelocatedFamily): Promise<void> {
  const cohortRoot = join(proof.logicalHome, COHORT, proof.profile)
  const stageRoot = join(physicalHome, COHORT, proof.profile)
  if (physicalHome !== proof.physicalHome && physicalHome !== proof.logicalHome) {
    fail('native resource proof does not describe this physical Home')
  }
  await io.directory(join(physicalHome, COHORT))
  const cohort = receipt(await io.readStable(join(stageRoot, 'receipt.json'), MAX_RECEIPT_BYTES, true))
  if (cohort.receiptDigest !== proof.cohortDigest) fail('staged cohort receipt digest differs')
  if (cohort.root !== cohortRoot || !Array.isArray(cohort.packages) || !COMMIT.test(String(cohort.sourceCommit))) {
    fail('staged cohort receipt differs')
  }
  if (cohort.sourceCommit !== family.runtime.sourceCommit) fail('staged cohort source differs')
  for (const item of cohort.packages as unknown[]) {
    if (item === null || typeof item !== 'object') fail('staged cohort package differs')
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.tarball !== 'string'
      || typeof entry.sha256 !== 'string' || !HEX.test(entry.sha256)) fail('staged cohort package differs')
    const expected = join(cohortRoot, 'artifacts', `${entry.name.split('/')[1]}.tgz`)
    if (entry.tarball !== expected) fail('staged cohort package path differs')
    const digest = hash(await io.readStable(join(stageRoot, 'artifacts', basename(expected)), MAX_FILE_BYTES, true))
    if (digest !== entry.sha256) fail(`staged cohort package differs: ${entry.name}`)
  }
}
