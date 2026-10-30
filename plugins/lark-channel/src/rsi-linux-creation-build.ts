import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { rsiBuildResources as io } from './rsi-build.js'
import { discoverLinuxCgroupRoots, RsiLinuxCgroupUnavailableError, type LinuxV1CgroupRoots } from './rsi-linux-cgroup-roots.js'
import { prepareLinuxRsiRepositoryRuntime, readLinuxRsiRepositoryRuntime,
  type LinuxRsiRepositoryBuildEnvironment } from './rsi-linux-repository-bootstrap.js'
import { LinuxRsiRuntimeUnavailableError, type LinuxRsiBootstrapInput } from './rsi-linux-runtime-bootstrap.js'

/** Creation family, schema 3: the Linux native behavior runtime. The Docker
 * image receipt stays schema 1 and the macOS Seatbelt receipt schema 2. */
export interface LinuxRsiCreationBuildEnvironment {
  schemaVersion: 3
  backend: 'linux-native'
  sourceCommit: string
  behavior: LinuxPluginBehaviorRuntime
  cgroupRoots: LinuxV1CgroupRoots
  /** Original schema4 base, already verified against the behavior preparation.
   * The installer requires this binding; generic legacy setup callers may omit it. */
  buildRuntimeDigest?: string
}

export interface LinuxRsiCreationPrepareInput extends LinuxRsiBootstrapInput {
  /** Authority state root; the single shared behavior runtime is prepared
   * under `<stateRoot>/linux-creation-behavior` and reused by both the review
   * and adoption runners. */
  stateRoot: string
}

/** Missing host prerequisites (cgroup delegation, user-namespace subordinate
 * allocations, the C compiler, the fixed runtime) stop installation as
 * not-ready. Integrity and identity failures stay hard Error failures. */
export class RsiLinuxCreationBuildUnavailableError extends Error {
  readonly code = 'rsi-linux-creation-build-unavailable'
  constructor(message: string) { super(`rsi Linux creation build unavailable: ${message}`) }
}

interface LinuxBehaviorPeer {
  prepareLinuxPluginBehaviorRuntime(input: { runtime: LinuxRuntime; root: string; signal?: AbortSignal }): Promise<LinuxPluginBehaviorRuntime>
  readLinuxPluginBehaviorDeploymentPreparation(input: { runtime: LinuxPluginBehaviorRuntime; signal?: AbortSignal }):
    Promise<{ descriptor: LinuxPluginBehaviorRuntime; baseRuntimeDigest: string; preparationDigest: string }>
  linuxPluginBehaviorRuntimeDigest(value: LinuxPluginBehaviorRuntime): string
}

interface Receipt extends LinuxRsiCreationBuildEnvironment {
  dshHome: string
  profile: string
  lockSha256: string
  buildRuntimeDigest: string
  preparationDigest: string
  behaviorDigest: string
  repositoryRuntimeDigest: string
  systemSnapshotDigest: string
  userNamespaceDigest: string
  receiptDigest: string
}

const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const PEER_SPECIFIER = '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
const SUBORDINATE_PATTERN = /^subordinate \S+ allocation is unavailable$/u
// Sorted exact receipt content (everything except receiptDigest itself).
const CONTENT_KEYS = ['backend', 'behavior', 'behaviorDigest', 'buildRuntimeDigest', 'cgroupRoots', 'dshHome',
  'lockSha256', 'preparationDigest', 'profile', 'repositoryRuntimeDigest', 'schemaVersion', 'sourceCommit',
  'systemSnapshotDigest', 'userNamespaceDigest'].sort()
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const digest = (value: unknown): string => sha(JSON.stringify(value))
const canonical = (value: string): boolean => isAbsolute(value) && resolve(value) === value && !value.includes('\0')

function fail(message: string): never { throw new Error(`rsi Linux creation build: ${message}`) }
async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

const requirePeer = createRequire(import.meta.url)
/** The verifier behavior runtime is an optional peer loaded only when Linux
 * native creation is actually prepared; a missing peer is a fatal opt-in gap,
 * not an environment not-ready condition. */
function behaviorPeer(): LinuxBehaviorPeer {
  try { requirePeer.resolve(PEER_SPECIFIER) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
      || (error as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      fail(`opted-in Linux plugin creation requires installed peer ${PEER_SPECIFIER}`)
    }
    throw error
  }
  const peer = requirePeer(PEER_SPECIFIER) as Partial<LinuxBehaviorPeer>
  if (typeof peer.prepareLinuxPluginBehaviorRuntime !== 'function'
    || typeof peer.readLinuxPluginBehaviorDeploymentPreparation !== 'function'
    || typeof peer.linuxPluginBehaviorRuntimeDigest !== 'function') {
    fail('installed Linux behavior runtime peer is unavailable; update the assistant-verifier peer')
  }
  return peer as LinuxBehaviorPeer
}

/** Map missing host prerequisites to the not-ready error. Abort reasons,
 * cgroup/runtime unavailable errors and integrity failures pass through. */
async function environmentGap<T>(label: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  try { return await operation() }
  catch (error) {
    if (error instanceof RsiLinuxCgroupUnavailableError || error instanceof LinuxRsiRuntimeUnavailableError) throw error
    if (signal.aborted) throw error
    const code = (error as NodeJS.ErrnoException).code
    const message = (error as Error).message ?? ''
    if (code === 'ENOENT' || SUBORDINATE_PATTERN.test(message)) {
      throw new RsiLinuxCreationBuildUnavailableError(`${label}: ${message}`)
    }
    throw error
  }
}

function project(receipt: Receipt): LinuxRsiCreationBuildEnvironment {
  return { schemaVersion: 3, backend: 'linux-native', sourceCommit: receipt.sourceCommit,
    behavior: receipt.behavior, cgroupRoots: receipt.cgroupRoots, buildRuntimeDigest: receipt.buildRuntimeDigest }
}

async function validateIdentity(input: LinuxRsiCreationPrepareInput): Promise<void> {
  input.signal?.throwIfAborted()
  if (!canonical(input.dshHome) || !PROFILE.test(input.profile) || !canonical(input.stateRoot)
    || input.stateRoot === '/' || input.source.schemaVersion !== 1
    || !COMMIT.test(input.source.sourceCommit)) fail('invalid creation bootstrap identity')
  await io.directory(input.dshHome)
  await io.directory(input.stateRoot)
}

async function replayExisting(input: LinuxRsiCreationPrepareInput, final: string,
  repository: LinuxRsiRepositoryBuildEnvironment, cgroupRoots: LinuxV1CgroupRoots,
  peer: LinuxBehaviorPeer, signal: AbortSignal): Promise<LinuxRsiCreationBuildEnvironment> {
  await io.directory(final)
  if (!isDeepStrictEqual(await readdir(final), ['bootstrap.json'])) fail('behavior workspace incomplete or unexpected')
  const receipt = JSON.parse((await io.readStable(join(final, 'bootstrap.json'), 65_536, true)).toString('utf8')) as Receipt
  const { receiptDigest, ...content } = receipt
  if (Object.keys(content).sort().join() !== CONTENT_KEYS.join()
    || digest(content) !== receiptDigest || receipt.schemaVersion !== 3 || receipt.backend !== 'linux-native'
    || receipt.dshHome !== input.dshHome || receipt.profile !== input.profile
    || receipt.sourceCommit !== input.source.sourceCommit || receipt.lockSha256 !== repository.lockSha256
    || !isDeepStrictEqual(receipt.cgroupRoots, cgroupRoots)) fail('Linux creation receipt differs')
  const runtimeDigest = linuxRuntimeDigest(repository.runtime)
  // The deployment reopen binds the retained observer even when the build-time
  // base receipt is later retired; it never invokes the compiler or Docker.
  const deployment = await environmentGap('reopen Linux behavior preparation', signal,
    () => peer.readLinuxPluginBehaviorDeploymentPreparation({ runtime: receipt.behavior, signal }))
  if (receipt.repositoryRuntimeDigest !== runtimeDigest
    || receipt.systemSnapshotDigest !== digest(repository.systemSnapshot)
    || receipt.userNamespaceDigest !== digest(repository.userNamespace)
    || receipt.buildRuntimeDigest !== deployment.baseRuntimeDigest
    || receipt.buildRuntimeDigest !== runtimeDigest
    || receipt.preparationDigest !== deployment.preparationDigest
    || !isDeepStrictEqual(receipt.behavior, deployment.descriptor)
    || receipt.behaviorDigest !== peer.linuxPluginBehaviorRuntimeDigest(deployment.descriptor)) {
    fail('Linux creation receipt differs from the prepared repository or behavior runtime')
  }
  signal.throwIfAborted()
  return project(receipt)
}

/** Caller holds the DSH_HOME lifecycle lock. Prepare or replay the immutable
 * Linux native behavior runtime used for creation review and adoption. */
export async function prepareLinuxRsiCreationBuildEnvironment(input: LinuxRsiCreationPrepareInput):
  Promise<LinuxRsiCreationBuildEnvironment> {
  await validateIdentity(input)
  const peer = behaviorPeer()
  const behaviorRoot = join(input.stateRoot, 'linux-creation-behavior')
  const parent = join(input.dshHome, 'rsi-linux-creation-builds')
  try { await mkdir(parent, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  await io.directory(parent)
  const final = join(parent, input.profile)
  const signal = AbortSignal.any([input.signal ?? new AbortController().signal, AbortSignal.timeout(2_400_000)])
  const stage = await mkdtemp(join(parent, `.${input.profile}-stage-`))
  await chmod(stage, 0o700)
  let claimed: { dev: number; ino: number } | undefined
  try {
    // schema4: fresh readable clone of the schema3 base, npm layout, system
    // snapshot and subordinate user-namespace mapping.
    const repository = await environmentGap('prepare Linux repository runtime', signal, () => prepareLinuxRsiRepositoryRuntime({
      dshHome: input.dshHome, profile: input.profile, source: input.source, signal,
      ...(input.nodeArchivePath ? { nodeArchivePath: input.nodeArchivePath } : {}),
      ...(input.pnpmArchivePath ? { pnpmArchivePath: input.pnpmArchivePath } : {}),
      ...(input.pnpmExeArchivePath ? { pnpmExeArchivePath: input.pnpmExeArchivePath } : {}),
      ...(input.pnpmNativeArchivePath ? { pnpmNativeArchivePath: input.pnpmNativeArchivePath } : {}),
    }))
    const cgroupRoots = await discoverLinuxCgroupRoots({ signal })
    if (await exists(final)) return await replayExisting(input, final, repository, cgroupRoots, peer, signal)
    // The single shared observer runtime; its sibling lock and rollback live
    // in the verifier peer. A missing /usr/bin/cc is a not-ready host gap.
    const descriptor = await environmentGap('compile Linux behavior runtime', signal,
      () => peer.prepareLinuxPluginBehaviorRuntime({ runtime: repository.runtime, root: behaviorRoot, signal }))
    const deployment = await peer.readLinuxPluginBehaviorDeploymentPreparation({ runtime: descriptor, signal })
    const runtimeDigest = linuxRuntimeDigest(repository.runtime)
    if (!isDeepStrictEqual(deployment.descriptor, descriptor)
      || deployment.baseRuntimeDigest !== runtimeDigest) fail('behavior preparation is not bound to the repository runtime')
    signal.throwIfAborted()
    const content: Omit<Receipt, 'receiptDigest'> = {
      schemaVersion: 3, backend: 'linux-native', sourceCommit: input.source.sourceCommit,
      behavior: descriptor, cgroupRoots, dshHome: input.dshHome, profile: input.profile,
      lockSha256: repository.lockSha256, buildRuntimeDigest: deployment.baseRuntimeDigest,
      preparationDigest: deployment.preparationDigest,
      behaviorDigest: peer.linuxPluginBehaviorRuntimeDigest(descriptor),
      repositoryRuntimeDigest: runtimeDigest, systemSnapshotDigest: digest(repository.systemSnapshot),
      userNamespaceDigest: digest(repository.userNamespace),
    }
    await mkdir(final, { mode: 0o700 })
    const identity = await stat(final); claimed = { dev: identity.dev, ino: identity.ino }
    await io.writeExclusive(join(final, 'bootstrap.json'),
      Buffer.from(JSON.stringify({ ...content, receiptDigest: digest(content) })))
    await io.syncDirectory(final); await io.syncDirectory(parent)
    return project({ ...content, receiptDigest: digest(content) })
  } catch (error) {
    if (claimed) {
      const current = await lstat(final).catch(() => undefined)
      if (current?.isDirectory() && current.dev === claimed.dev && current.ino === claimed.ino
        && (await readdir(final)).every(name => name === 'bootstrap.json')) await rm(final, { recursive: true, force: true })
    }
    throw error
  } finally { await rm(stage, { recursive: true, force: true }); await io.syncDirectory(parent) }
}

/** Verify an existing Linux creation family without preparing missing inputs.
 * Fixed runtime integrity probes, read-only cgroup discovery and retained
 * observer verification remain part of reopening the recorded receipts. */
export async function readLinuxRsiCreationBuildEnvironment(input: LinuxRsiCreationPrepareInput):
  Promise<LinuxRsiCreationBuildEnvironment> {
  await validateIdentity(input)
  const peer = behaviorPeer()
  const parent = join(input.dshHome, 'rsi-linux-creation-builds'), final = join(parent, input.profile)
  const signal = input.signal ?? new AbortController().signal
  await io.directory(parent)
  const repository = await readLinuxRsiRepositoryRuntime({
    dshHome: input.dshHome, profile: input.profile, source: input.source, signal,
  })
  const cgroupRoots = await discoverLinuxCgroupRoots({ signal })
  return await replayExisting(input, final, repository, cgroupRoots, peer, signal)
}
