import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  migrateLinuxVerifierRunnerState, prepareLinuxRepositoryHandoverState, prepareLinuxVerifierHandoverState,
  prepareLinuxVerifierStagingState,
} from '@dsh-enhanced/assistant-isolation'
import { rsiBuildResources as io } from './rsi-build.js'
import type { LinuxRsiBuildEnvironment } from './rsi-linux-runtime-bootstrap.js'
import type { NativeRsiReleaseBuildEnvironment } from './rsi-release-build.js'
import { readRsiLocalUpdateSourceBuild, type LocalUpdateSourceBuild } from './rsi-local-update-build.js'
import { readRsiSourceWorkspace } from './rsi-source.js'
import { readRsiReleaseBuildEnvironment, type PreparedReleaseBuildEnvironment } from './rsi-release-build.js'
import type { RsiLocalCohort } from './rsi-local-cohort.js'
import { readRsiLocalUpdateLocked, type RsiLocalUpdatePreparation } from './rsi-local-update.js'
import {
  openLinuxRsiNativeRelocatedFamily, openLinuxRsiNativeRelocatedFamilyAt, relocateLinuxRsiNativeFamily,
  openLinuxRsiNativeRelocatedBase, openLinuxRsiNativeRelocatedBaseAt, relocateLinuxRsiNativeBase,
  inspectLinuxRsiNativeBaseAt, type LinuxRsiNativeBaseRelocationProof,
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
export { freezeLinuxRuntimeSource } from '@dsh-enhanced/assistant-isolation/native-resources'
export type { LinuxRsiNativeRelocatedFamily, LinuxRsiNativeRelocationProof, LinuxRsiNativeBaseRelocationProof }
export { openLinuxRsiNativeRelocatedBase, openLinuxRsiNativeRelocatedBaseAt, inspectLinuxRsiNativeBaseAt }

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
async function auditNativeResources(proof: Pick<LinuxRsiNativeResourceProof, 'logicalHome' | 'physicalHome' | 'profile' | 'cohortDigest'>, physicalHome: string,
  family: Pick<LinuxRsiNativeRelocatedFamily, 'runtime'>): Promise<void> {
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

/** Base-only pre-owner handover. This proof cannot authorize owner runners or
 * substitute for the full native owner-family proof above. */
export interface LinuxRsiPreOwnerNativeResourceProof {
  schemaVersion: 1
  backend: 'linux-native'
  purpose: 'pre-owner-base'
  logicalHome: string
  physicalHome: string
  profile: string
  preparationDigest: string
  cohortDigest: string
  originalBackend: 'docker' | 'linux-native'
  relocation: LinuxRsiNativeBaseRelocationProof
}
type PreOwnerStageInput = { logicalHome: string; stagePhysicalHome: string; profile: string;
  preparationRoot: string; signal?: AbortSignal }
const BASE_KINDS = ['rsi-linux-runtimes', 'rsi-release-builds', 'rsi-builds', COHORT] as const
const OWNER_KINDS = ['rsi-linux-repository-runtimes', 'rsi-linux-creation-builds', 'rsi-creation-builds'] as const
async function present(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Content comparison deliberately excludes dev/ino: a copied stage has fresh
 * inodes, while the live stock readers still verify the original native pins. */
async function baseInventory(root: string, signal: AbortSignal): Promise<Array<Entry & { link?: string }>> {
  await io.directory(root)
  const entries: Array<Entry & { link?: string }> = []
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    signal.throwIfAborted()
    const item = await lstat(path)
    if (entries.length >= MAX_ENTRIES || process.getuid && item.uid !== process.getuid()
      || !item.isSymbolicLink() && item.mode & 0o022) fail('unsafe pre-owner base entry')
    const location = relative(root, path), mode = item.mode & 0o777
    if (item.isSymbolicLink()) {
      if (item.nlink !== 1) fail('pre-owner base link must be detached')
      const link = await readlink(path)
      if (isAbsolute(link) || !inside(root, resolve(dirname(path), link)) || !inside(root, await realpath(path))) {
        fail('pre-owner base link escapes its tree')
      }
      const after = await lstat(path)
      if (!after.isSymbolicLink() || !isDeepStrictEqual(
        [item.dev, item.ino, item.uid, item.mode, item.nlink, item.size, item.mtimeMs, item.ctimeMs],
        [after.dev, after.ino, after.uid, after.mode, after.nlink, after.size, after.mtimeMs, after.ctimeMs])) {
        fail('pre-owner base link identity changed during read')
      }
      entries.push({ path: location, mode, sha256: null, link })
    } else if (item.isDirectory()) {
      entries.push({ path: location, mode, sha256: null })
      for (const name of (await readdir(path)).sort()) await visit(join(path, name))
    } else if (item.isFile() && item.nlink === 1) {
      bytes += item.size
      if (item.size > MAX_FILE_BYTES || bytes > MAX_TOTAL_BYTES) fail('pre-owner base tree exceeds size bound')
      entries.push({ path: location, mode, sha256: hash(await io.readStable(path, MAX_FILE_BYTES)) })
    } else fail('pre-owner base entry is not a detached regular file/directory')
  }
  await visit(root)
  return entries
}

async function preOwnerFamilies(home: string, profile: string): Promise<void> {
  for (const kind of OWNER_KINDS) if (await present(join(home, kind, profile))) fail('pre-owner Home contains an owner runtime family')
  const authority = join(home, 'rsi-authorities', profile)
  if (await present(authority)) {
    await io.directory(authority)
    for (const name of ['state', 'config', 'registry']) {
      const path = join(authority, name)
      if (await present(path)) { await io.directory(path); if ((await readdir(path)).length) fail('pre-owner authority is not empty') }
    }
    const catalogPath = join(authority, 'catalog.json')
    if (await present(catalogPath)) {
      const catalog = JSON.parse((await io.readStable(catalogPath, MAX_RECEIPT_BYTES, true)).toString('utf8')) as unknown
      if (!isDeepStrictEqual(catalog, { schemaVersion: 1, entries: [] })) fail('pre-owner catalog is not empty')
    }
  }
}

async function originalBase(input: PreOwnerStageInput, signal: AbortSignal): Promise<{
  backend: 'docker' | 'linux-native'; sourceBuild: LocalUpdateSourceBuild; releaseBuild: PreparedReleaseBuildEnvironment;
  trees: Map<string, Awaited<ReturnType<typeof baseInventory>> | null>
}> {
  const { logicalHome, stagePhysicalHome, profile } = input
  await preOwnerFamilies(logicalHome, profile); await preOwnerFamilies(stagePhysicalHome, profile)
  const native = await present(join(logicalHome, 'rsi-linux-runtimes', profile)), docker = await present(join(logicalHome, 'rsi-builds', profile))
  if (native === docker) fail('pre-owner original must have exactly one build backend')
  // readRsiSourceWorkspace follows an authenticated maintenance chain when one
  // exists; it does not replay the older bootstrap commit after maintenance.
  const source = await readRsiSourceWorkspace({ dshHome: logicalHome, profile, signal })
  const sourceBuild = await readRsiLocalUpdateSourceBuild({ dshHome: logicalHome, profile, source, signal })
  const backend = sourceBuild.schemaVersion === 3 && sourceBuild.backend === 'linux-native' ? 'linux-native' : 'docker'
  if ((backend === 'linux-native') !== native) fail('original backend reader differs from its tree')
  const releaseBuild = await readRsiReleaseBuildEnvironment({ dshHome: logicalHome, profile, build: sourceBuild, signal })
  const trees = new Map<string, Awaited<ReturnType<typeof baseInventory>> | null>()
  for (const kind of BASE_KINDS) {
    const live = join(logicalHome, kind, profile), stage = join(stagePhysicalHome, kind, profile)
    const exists = await present(live)
    if (exists !== await present(stage)) fail('copied original base layout differs')
    if (!exists) { trees.set(kind, null); continue }
    const original = await baseInventory(live, signal)
    if (!isDeepStrictEqual(original, await baseInventory(stage, signal))) fail('copied original base content differs')
    trees.set(kind, original)
  }
  return { backend, sourceBuild, releaseBuild, trees }
}

async function verifyPreOwnerOriginal(input: PreOwnerStageInput, frozen: Awaited<ReturnType<typeof originalBase>>,
  signal: AbortSignal): Promise<void> {
  await preOwnerFamilies(input.logicalHome, input.profile)
  const source = await readRsiSourceWorkspace({ dshHome: input.logicalHome, profile: input.profile, signal })
  const build = await readRsiLocalUpdateSourceBuild({ dshHome: input.logicalHome, profile: input.profile, source, signal })
  const release = await readRsiReleaseBuildEnvironment({ dshHome: input.logicalHome, profile: input.profile, build, signal })
  if (!isDeepStrictEqual(build, frozen.sourceBuild) || !isDeepStrictEqual(release, frozen.releaseBuild)) fail('original base receipts changed during staging')
  for (const [kind, before] of frozen.trees) {
    const path = join(input.logicalHome, kind, input.profile)
    if (before === null ? await present(path) : !await present(path) || !isDeepStrictEqual(before, await baseInventory(path, signal))) {
      fail('original base trees changed during staging')
    }
  }
}

/** All writes target the disposable stage. Old profile trees (including the
 * original cohort inode) remain under a private scratch until the final audit;
 * a later cohort or preparation failure restores them as one transaction. */
export async function stageLinuxRsiPreOwnerNativeResources(input: PreOwnerStageInput): Promise<{
  cohort: RsiLocalCohort; sourceBuild: LinuxRsiBuildEnvironment; releaseBuild: NativeRsiReleaseBuildEnvironment;
  proof: LinuxRsiPreOwnerNativeResourceProof
}> {
  const { prepared, signal } = await readPreparation(input)
  const { logicalHome, stagePhysicalHome, profile } = input
  const build = nativeBuild(prepared)
  if (build.sourceBuild.sourceCommit !== prepared.source.sourceCommit) fail('candidate runtime differs from preparation source')
  await preOwnerFamilies(prepared.candidateHome, profile)
  if (await present(join(prepared.candidateHome, 'rsi-builds', profile))) fail('native candidate also contains Docker resources')
  const original = await originalBase(input, signal)
  const scratch = join(stagePhysicalHome, `.rsi-pre-owner-native-${randomUUID()}`)
  await mkdir(scratch, { mode: 0o700 })
  const moved = new Map<string, string | null>(), missingParents = new Set<string>()
  let discarding = false
  try {
    await writeFile(join(scratch, 'transaction.json'), JSON.stringify({ schemaVersion: 1, purpose: 'pre-owner-base-stage',
      logicalHome, physicalHome: stagePhysicalHome, profile, preparationDigest: prepared.receiptDigest, originalBackend: original.backend,
      trees: [...original.trees].map(([kind, entries]) => ({ kind, inventoryDigest: entries === null ? null : hash(JSON.stringify(entries)) })) }),
    { mode: 0o600, flag: 'wx' })
    for (const kind of BASE_KINDS) {
      const parent = join(stagePhysicalHome, kind), path = join(parent, profile), backup = join(scratch, kind)
      if (!await present(parent)) missingParents.add(parent)
      if (await present(path)) { await io.directory(parent); await rename(path, backup); moved.set(path, backup) }
      else moved.set(path, null)
    }
    // stageCohort owns its own swap; give it an old-content working copy while
    // retaining the original stage tree/inode outside that helper's cleanup.
    const oldCohort = moved.get(join(stagePhysicalHome, COHORT, profile))
    if (!oldCohort) fail('original staged cohort is missing')
    await cp(oldCohort, join(stagePhysicalHome, COHORT, profile),
      { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    const relocation = await relocateLinuxRsiNativeBase({ sourceHome: prepared.candidateHome,
      physicalHome: stagePhysicalHome, logicalHome, profile, existingLogicalHome: logicalHome, signal })
    const family = await openLinuxRsiNativeRelocatedBase(relocation)
    if (family.runtime.sourceCommit !== prepared.source.sourceCommit || family.release.sourceCommit !== prepared.source.sourceCommit) fail('relocated base source differs')
    const cohort = await stageCohort({ prepared, logicalHome, stagePhysicalHome, profile, preparationRoot: input.preparationRoot, signal })
    const proof: LinuxRsiPreOwnerNativeResourceProof = { schemaVersion: 1, backend: 'linux-native', purpose: 'pre-owner-base', logicalHome,
      physicalHome: stagePhysicalHome, profile, preparationDigest: prepared.receiptDigest, cohortDigest: cohort.receiptDigest,
      originalBackend: original.backend, relocation }
    await verifyLinuxRsiPreOwnerNativeResources({ proof, physicalHome: stagePhysicalHome, signal })
    if (!isDeepStrictEqual(await readRsiLocalUpdateLocked({ dshHome: logicalHome, profile, root: input.preparationRoot, signal }), prepared)) fail('preparation changed after base staging')
    await verifyPreOwnerOriginal(input, original, signal)
    // Backups may disappear incrementally from this point. A cleanup failure
    // must retain the verified candidate, never delete it and replay partial old trees.
    discarding = true
    await rm(scratch, { recursive: true })
    return { cohort, sourceBuild: family.runtime, releaseBuild: family.release, proof }
  } catch (error) {
    if (discarding) throw new Error(`rsi Linux native resources: pre-owner backup cleanup failed after candidate verification; preserved evidence: ${scratch}`, { cause: error })
    try {
      for (const [path, backup] of [...moved].reverse()) {
        await rm(path, { recursive: true, force: true })
        if (backup !== null) await rename(backup, path)
        if (await present(dirname(path))) await io.syncDirectory(dirname(path))
      }
      for (const path of missingParents) if (await present(path) && (await readdir(path)).length === 0) await rm(path, { recursive: true })
      await rm(scratch, { recursive: true })
    } catch (rollback) {
      throw new Error(`rsi Linux native resources: pre-owner rollback incomplete; preserved evidence: ${scratch}`, { cause: new AggregateError([error, rollback]) })
    }
    throw error
  }
}

export async function verifyLinuxRsiPreOwnerNativeResources(input: {
  proof: LinuxRsiPreOwnerNativeResourceProof; physicalHome: string; signal?: AbortSignal
}): Promise<void> {
  const { proof, physicalHome } = input
  const relocation = proof?.relocation
  if (!proof || proof.schemaVersion !== 1 || proof.backend !== 'linux-native' || proof.purpose !== 'pre-owner-base'
    || !['docker', 'linux-native'].includes(proof.originalBackend) || !exact(proof.logicalHome) || !exact(proof.physicalHome)
    || !PROFILE.test(proof.profile) || !HEX.test(proof.preparationDigest) || !HEX.test(proof.cohortDigest)
    || !relocation || relocation.purpose !== 'pre-owner-base' || relocation.logicalHome !== proof.logicalHome
    || relocation.physicalHome !== proof.physicalHome || relocation.profile !== proof.profile
    || !exact(physicalHome) || await realpath(physicalHome) !== physicalHome
    || physicalHome !== proof.physicalHome && physicalHome !== proof.logicalHome) fail('invalid pre-owner native resource proof binding')
  input.signal?.throwIfAborted()
  await preOwnerFamilies(physicalHome, proof.profile)
  for (const kind of ['rsi-builds', 'rsi-creation-builds']) if (await present(join(physicalHome, kind, proof.profile))) fail('pre-owner native Home retains Docker resources')
  const family = await openLinuxRsiNativeRelocatedBaseAt(relocation, physicalHome)
  await auditNativeResources(proof, physicalHome, family)
}
