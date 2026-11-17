import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { LinuxCgroupRoots } from './linux-cgroups.js'

/** Read-only discovery of the delegated cgroup v1 or unified cgroup v2 roots
 * created by the root-run scripts/isolation/prepare-linux-cgroups.mjs command.
 * Discovery never creates, remounts, synthesizes v2 roots or falls back to
 * rlimit/host-PID containment: a missing, hybrid or ambiguous delegation is an
 * environment gap reported as not-ready so installation stops before granting
 * any finite behavior authority. */
const V1_MAGIC = 0x27e0eb
const V2_MAGIC = 0x63677270
const CONTROLLERS = ['cpu', 'memory', 'pids', 'freezer'] as const
const V2_CONTROLLERS = ['cpu', 'memory', 'pids'] as const
const V2_ROOT = '/sys/fs/cgroup'
type Controller = typeof CONTROLLERS[number]
const MOUNT_PATTERN = /^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+$/u
const DELEGATION_HINT = 'rerun scripts/isolation/prepare-linux-cgroups.mjs --uid <owner uid> --auto as root'

export class RsiLinuxCgroupUnavailableError extends Error {
  readonly code = 'rsi-linux-cgroup-unavailable'
  constructor(message: string) { super(`rsi linux cgroup unavailable: ${message}`) }
}

function fail(message: string): never { throw new Error(`rsi linux cgroup roots: ${message}`) }
function unavailable(message: string): never { throw new RsiLinuxCgroupUnavailableError(`${message}; ${DELEGATION_HINT}`) }

export type LinuxV1CgroupRoots = Extract<LinuxCgroupRoots, { mode: 'v1' }>
export type LinuxV2CgroupRoots = Extract<LinuxCgroupRoots, { mode: 'v2' }>
export type { LinuxCgroupRoots }

/** Parse cgroup v1 controller mounts from /proc/self/mountinfo using the same
 * split/field rules as the delegation command. Each required controller must
 * have exactly one mount; cgroup2, other hierarchies and non-/sys/fs/cgroup
 * mountpoints are ignored. */
export function parseLinuxV1ControllerMounts(lines: readonly string[]): Record<Controller, string> {
  const mounts = new Map<Controller, string>()
  for (const line of lines) {
    const [before, after] = line.split(' - ')
    const fields = before?.split(' '), filesystem = after?.split(' ')
    if (filesystem?.[0] !== 'cgroup' || !fields?.[4]?.startsWith('/sys/fs/cgroup/')) continue
    const options = filesystem[2]?.split(',') ?? []
    for (const controller of CONTROLLERS) {
      if (!options.includes(controller)) continue
      if (mounts.has(controller)) unavailable(`multiple ${controller} cgroup mounts are ambiguous`)
      mounts.set(controller, fields[4]!)
    }
  }
  if (mounts.size !== CONTROLLERS.length) {
    const missing = CONTROLLERS.filter(controller => !mounts.has(controller)).join(', ')
    unavailable(`cgroup v1 controllers are not all mounted (missing ${missing})`)
  }
  return Object.fromEntries(CONTROLLERS.map(controller => [controller, mounts.get(controller)!])) as Record<Controller, string>
}

function classifyMountinfo(lines: readonly string[]): { v1Mounts: string[]; v2Mounts: string[] } {
  const v1Mounts: string[] = []
  const v2Mounts: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const sep = line.indexOf(' - ')
    if (sep < 0) continue
    const before = line.slice(0, sep).split(' ')
    const after = line.slice(sep + 3).split(' ')
    const mount = before[4]
    const fsType = after[0]
    if (!mount || !fsType) continue
    if (fsType === 'cgroup') v1Mounts.push(mount)
    else if (fsType === 'cgroup2') v2Mounts.push(mount)
  }
  return { v1Mounts, v2Mounts }
}

/** Parse the unified cgroup v2 mount from /proc/self/mountinfo, failing closed
 * on hybrid v1/v2 hierarchies, missing mounts, non-canonical paths or multiple
 * cgroup2 mounts. */
export function parseLinuxV2UnifiedMount(lines: readonly string[]): string {
  const { v1Mounts, v2Mounts } = classifyMountinfo(lines)
  if (v1Mounts.length > 0 && v2Mounts.length > 0) unavailable('hybrid cgroup v1/v2 hierarchy is unsupported')
  if (v1Mounts.length > 0) unavailable('cgroup v2 unified mount is unavailable alongside cgroup v1 mounts')
  for (const mount of v2Mounts) {
    if (mount !== V2_ROOT) unavailable(`unexpected cgroup v2 mount ${mount}`)
  }
  if (v2Mounts.length === 0) unavailable('cgroup v2 unified mount at /sys/fs/cgroup is missing')
  if (v2Mounts.length > 1) unavailable('multiple cgroup v2 mounts at /sys/fs/cgroup are ambiguous')
  return V2_ROOT
}

async function mapUnavailableFsError<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof RsiLinuxCgroupUnavailableError) throw error
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      unavailable(`${label} is unavailable (${code})`)
    }
    throw error
  }
}

async function checkedPrivateLeafDirectory(input: {
  label: string; path: string; owner: number; magic: number; version: 'v1' | 'v2'
}): Promise<string> {
  const { label, path, owner, magic, version } = input
  return mapUnavailableFsError(`the delegated ${label} root at ${path}`, async () => {
    if (resolve(path) !== path || await realpath(path) !== path) unavailable(`the delegated ${label} root is not canonical`)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) unavailable(`the delegated ${label} root is not a private directory`)
    if (info.uid !== owner) unavailable(`the delegated ${label} root is not owned by uid ${owner}`)
    if ((info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700) unavailable(`the delegated ${label} root is not mode 0700`)
    if ((await statfs(path)).type !== magic) unavailable(`the delegated ${label} root is not a cgroup ${version} filesystem`)
    return path
  })
}

async function checkedV1Leaf(input: { controller: Controller; mount: string; lines: readonly string[]; signal?: AbortSignal }): Promise<string> {
  const { controller, mount, lines } = input
  input.signal?.throwIfAborted()
  if (typeof process.getuid !== 'function') fail('process identity is unavailable')
  const owner = process.getuid()
  const path = `${mount}/dsh-native/uid-${owner}`
  const matching = lines.filter(line => {
    const [before, after] = line.split(' - ')
    const fields = before?.split(' '), filesystem = after?.split(' ')
    return fields?.[4] === mount && filesystem?.[0] === 'cgroup'
      && (filesystem[2]?.split(',') ?? []).includes(controller)
  })
  if (matching.length !== 1) unavailable(`the ${controller} controller mount identity is not unique`)
  return checkedPrivateLeafDirectory({ label: controller, path, owner, magic: V1_MAGIC, version: 'v1' })
}

async function discoverV1CgroupRoots(lines: readonly string[], signal?: AbortSignal): Promise<LinuxV1CgroupRoots> {
  const mounts = parseLinuxV1ControllerMounts(lines)
  const roots = {} as Record<Controller, string>
  for (const controller of CONTROLLERS) {
    const mount = mounts[controller]!
    if (!MOUNT_PATTERN.test(mount)) unavailable(`unexpected ${controller} controller mount ${mount}`)
    await mapUnavailableFsError(`the ${controller} controller mount ${mount}`, async () => {
      if ((await statfs(mount)).type !== V1_MAGIC) unavailable(`${mount} is not a cgroup v1 filesystem`)
    })
    roots[controller] = await checkedV1Leaf({ controller, mount, lines, ...(signal ? { signal } : {}) })
  }
  if (new Set(CONTROLLERS.map(controller => roots[controller])).size !== CONTROLLERS.length) {
    unavailable('delegated controller roots are not distinct hierarchies')
  }
  return { mode: 'v1' as const, cpu: roots.cpu!, memory: roots.memory!, pids: roots.pids!, freezer: roots.freezer! }
}

async function readControllerTokens(path: string, signal?: AbortSignal): Promise<Set<string>> {
  const raw = await readFile(path, { encoding: 'utf8', ...(signal ? { signal } : {}) })
  return new Set(raw.trim().split(/\s+/u).filter(Boolean))
}

async function discoverV2CgroupRoots(lines: readonly string[], signal?: AbortSignal): Promise<LinuxV2CgroupRoots> {
  const owner = process.getuid!()
  const mount = parseLinuxV2UnifiedMount(lines)
  await mapUnavailableFsError(`cgroup v2 unified mount ${mount}`, async () => {
    if (resolve(mount) !== mount || await realpath(mount) !== mount) unavailable(`noncanonical cgroup v2 mount ${mount}`)
    if ((await statfs(mount)).type !== V2_MAGIC) unavailable(`${mount} is not a cgroup v2 filesystem`)
  })
  const parent = `${mount}/dsh-native`
  await mapUnavailableFsError(`cgroup v2 parent directory at ${parent}`, async () => {
    if (resolve(parent) !== parent || await realpath(parent) !== parent) unavailable('cgroup v2 parent directory is not canonical')
    const info = await lstat(parent)
    if (!info.isDirectory() || info.isSymbolicLink()) unavailable('cgroup v2 parent directory is invalid')
    if (info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o005) !== 0o005) {
      unavailable('cgroup v2 parent directory permissions differ')
    }
    if ((await statfs(parent)).type !== V2_MAGIC) unavailable('cgroup v2 parent directory is not a cgroup v2 filesystem')
    const subtree = await readControllerTokens(join(parent, 'cgroup.subtree_control'), signal)
    const missing = V2_CONTROLLERS.filter(controller => !subtree.has(controller))
    if (missing.length > 0) unavailable(`cgroup v2 parent subtree_control is missing ${missing.join(', ')}`)
  })
  const leaf = `${parent}/uid-${owner}`
  await checkedPrivateLeafDirectory({ label: 'unified', path: leaf, owner, magic: V2_MAGIC, version: 'v2' })
  await mapUnavailableFsError(`the delegated unified root at ${leaf}`, async () => {
    await access(leaf, constants.R_OK | constants.W_OK | constants.X_OK)
    const controllers = await readControllerTokens(join(leaf, 'cgroup.controllers'), signal)
    const missing = V2_CONTROLLERS.filter(controller => !controllers.has(controller))
    if (missing.length > 0) unavailable(`delegated cgroup v2 root is missing controller(s): ${missing.join(', ')}`)
    const freezePath = join(leaf, 'cgroup.freeze')
    const freezeInfo = await lstat(freezePath)
    if (freezeInfo.isSymbolicLink() || !freezeInfo.isFile()) unavailable('cgroup.freeze is invalid in delegated cgroup v2 root')
    const freezeState = (await readFile(freezePath, { encoding: 'utf8', ...(signal ? { signal } : {}) })).trim()
    if (freezeState !== '0') unavailable('cgroup v2 freeze controller is unavailable or frozen')
  })
  return { mode: 'v2' as const, unified: leaf }
}

export async function discoverLinuxCgroupRoots(input: { signal?: AbortSignal } = {}): Promise<LinuxCgroupRoots> {
  input.signal?.throwIfAborted()
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    fail('cgroup delegation discovery requires Linux x64/arm64')
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    fail('cgroup delegation must be discovered as the non-root owner, never root')
  }
  const lines = (await readFile('/proc/self/mountinfo', { encoding: 'utf8', signal: input.signal })).split('\n')
  const { v1Mounts, v2Mounts } = classifyMountinfo(lines)
  if (v1Mounts.length > 0 && v2Mounts.length > 0) unavailable('hybrid cgroup v1/v2 hierarchy is unsupported')
  if (v1Mounts.length === 0 && v2Mounts.length === 0) unavailable('no supported Linux cgroup hierarchy is mounted')
  if (v2Mounts.length > 0) return await discoverV2CgroupRoots(lines, input.signal)
  return await discoverV1CgroupRoots(lines, input.signal)
}
