import { constants } from 'node:fs'
import { access, lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { dirname, join, posix, resolve } from 'node:path'
import type { LinuxCgroupRoots } from './linux-cgroups.js'
import { V2_UNIFIED_ROOT_PATTERN } from './linux-execution-contract.js'

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

/** Parse the caller's unified cgroup v2 path from `/proc/<pid>/cgroup`, failing
 * closed on hybrid controller memberships or non-canonical relative paths. */
export function parseLinuxV2ProcessCgroup(procCgroupText: string): string {
  let unifiedRel: string | undefined
  for (const raw of procCgroupText.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const first = line.indexOf(':')
    const second = first < 0 ? -1 : line.indexOf(':', first + 1)
    if (first < 0 || second < 0) unavailable('malformed /proc cgroup entry')
    const hierarchy = line.slice(0, first)
    const controllers = line.slice(first + 1, second)
    const relPath = line.slice(second + 1)
    if (hierarchy !== '0') {
      if (controllers !== '') unavailable('hybrid cgroup v1 membership in /proc/self/cgroup is unsupported')
      continue
    }
    if (controllers !== '') unavailable('unexpected controller token on cgroup v2 0:: entry')
    if (unifiedRel !== undefined) unavailable('multiple 0:: entries in /proc/self/cgroup')
    if (!relPath.startsWith('/') || posix.normalize(relPath) !== relPath || /[\p{Cc}\\]/u.test(relPath)
      || relPath.split('/').some(segment => segment === '..')) {
      unavailable('noncanonical cgroup v2 path in /proc/self/cgroup')
    }
    unifiedRel = relPath
  }
  if (unifiedRel === undefined) unavailable('missing unified 0:: entry in /proc/self/cgroup')
  return unifiedRel === '/' ? V2_ROOT : `${V2_ROOT}${unifiedRel}`
}

/** Compute the kernel `cgroup_procs_write_permission` common ancestor between
 * the caller's current v2 cgroup and child jobs under `unifiedRoot`, rejecting
 * internal-process or inside-job caller placement. */
export function resolveLinuxV2CommonAncestor(callerCgroupPath: string, unifiedRoot: string): string {
  if (!V2_UNIFIED_ROOT_PATTERN.test(unifiedRoot)) {
    unavailable(`unexpected delegated cgroup v2 root ${unifiedRoot}`)
  }
  if (!callerCgroupPath.startsWith(V2_ROOT) || (callerCgroupPath !== V2_ROOT && !callerCgroupPath.startsWith(`${V2_ROOT}/`))
    || posix.normalize(callerCgroupPath) !== callerCgroupPath) {
    unavailable(`invalid caller cgroup v2 path ${callerCgroupPath}`)
  }
  if (callerCgroupPath === unifiedRoot) {
    unavailable(`caller resides directly in non-leaf delegated cgroup v2 root ${unifiedRoot}; move caller into ${unifiedRoot}/host`)
  }
  if (callerCgroupPath.startsWith(`${unifiedRoot}/job-`)) {
    unavailable('caller cannot reside inside an isolated job cgroup')
  }
  const callerParts = callerCgroupPath.split('/').filter(Boolean)
  const targetParts = unifiedRoot.split('/').filter(Boolean)
  const limit = Math.min(callerParts.length, targetParts.length)
  let shared = 0
  while (shared < limit && callerParts[shared] === targetParts[shared]) shared += 1
  if (shared < 3) unavailable(`caller cgroup ${callerCgroupPath} is outside ${V2_ROOT}`)
  return `/${callerParts.slice(0, shared).join('/')}`
}

async function verifyWritableCgroupProcs(dirPath: string, label: string): Promise<void> {
  await mapUnavailableFsError(label, async () => {
    if (resolve(dirPath) !== dirPath || await realpath(dirPath) !== dirPath) unavailable('cgroup v2 ancestor directory is not canonical')
    if ((await statfs(dirPath)).type !== V2_MAGIC) unavailable('cgroup v2 ancestor directory is not a cgroup v2 filesystem')
    const procsPath = join(dirPath, 'cgroup.procs')
    const procsInfo = await lstat(procsPath)
    if (procsInfo.isSymbolicLink() || !procsInfo.isFile()) unavailable('cgroup v2 cgroup.procs interface file is invalid')
    await access(procsPath, constants.W_OK)
  })
}

/** Verify that a caller outside `user@<uid>.service` (e.g. an SSH `session-N.scope`
 * where `user-<uid>.slice/cgroup.procs` is root-owned) can enter `user@<uid>.service`
 * via `/usr/bin/systemd-run --user --scope` over the owner's private runtime dir. */
export async function verifyLinuxV2SystemdUserScopeBridge(owner: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!Number.isSafeInteger(owner) || owner <= 0) unavailable('invalid non-root owner uid for systemd --user bridge')
  await mapUnavailableFsError('systemd --user scope bridge (/usr/bin/systemd-run and /run/user)', async () => {
    for (const bin of ['/usr/bin/systemd-run', '/usr/bin/env']) {
      if (await realpath(bin) !== bin) unavailable(`${bin} is not canonical`)
      const info = await lstat(bin)
      if (!info.isFile() || info.isSymbolicLink()) unavailable(`${bin} is not a regular executable`)
      await access(bin, constants.X_OK)
    }
    const runtimeDir = `/run/user/${owner}`
    if (await realpath(runtimeDir) !== runtimeDir) unavailable(`${runtimeDir} is not canonical`)
    const dirInfo = await lstat(runtimeDir)
    if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink() || dirInfo.uid !== owner || (dirInfo.mode & 0o077) !== 0) {
      unavailable(`${runtimeDir} is not an owner-private runtime directory`)
    }
    let hasSocket = false
    for (const sockPath of [`${runtimeDir}/bus`, `${runtimeDir}/systemd/private`]) {
      try {
        const sockInfo = await lstat(sockPath)
        if (sockInfo.isSocket() && !sockInfo.isSymbolicLink() && sockInfo.uid === owner) {
          hasSocket = true
          break
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    if (!hasSocket) unavailable(`systemd --user socket unavailable under ${runtimeDir}`)
  })
}

async function verifyV2DelegatedSubtree(leaf: string, owner: number, signal?: AbortSignal): Promise<void> {
  const parent = dirname(leaf)
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
  await checkedPrivateLeafDirectory({ label: 'unified', path: leaf, owner, magic: V2_MAGIC, version: 'v2' })
  await mapUnavailableFsError(`the delegated unified root at ${leaf}`, async () => {
    await access(leaf, constants.R_OK | constants.W_OK | constants.X_OK)
    const controllers = await readControllerTokens(join(leaf, 'cgroup.controllers'), signal)
    const missing = V2_CONTROLLERS.filter(controller => !controllers.has(controller))
    if (missing.length > 0) unavailable(`delegated cgroup v2 root is missing controller(s): ${missing.join(', ')}`)
    const leafSubtree = await readControllerTokens(join(leaf, 'cgroup.subtree_control'), signal)
    const missingLeafSubtree = V2_CONTROLLERS.filter(controller => !leafSubtree.has(controller))
    if (missingLeafSubtree.length > 0) {
      unavailable(`delegated cgroup v2 root subtree_control is missing ${missingLeafSubtree.join(', ')}`)
    }
    const freezePath = join(leaf, 'cgroup.freeze')
    const freezeInfo = await lstat(freezePath)
    if (freezeInfo.isSymbolicLink() || !freezeInfo.isFile()) unavailable('cgroup.freeze is invalid in delegated cgroup v2 root')
    const freezeState = (await readFile(freezePath, { encoding: 'utf8', ...(signal ? { signal } : {}) })).trim()
    if (freezeState !== '0') unavailable('cgroup v2 freeze controller is unavailable or frozen')
    const killPath = join(leaf, 'cgroup.kill')
    const killInfo = await lstat(killPath)
    if (killInfo.isSymbolicLink() || !killInfo.isFile()) unavailable('cgroup.kill is unavailable in delegated cgroup v2 root')
  })
}

async function discoverV2CgroupRoots(lines: readonly string[], signal?: AbortSignal): Promise<LinuxV2CgroupRoots> {
  const owner = process.getuid!()
  const mount = parseLinuxV2UnifiedMount(lines)
  await mapUnavailableFsError(`cgroup v2 unified mount ${mount}`, async () => {
    if (resolve(mount) !== mount || await realpath(mount) !== mount) unavailable(`noncanonical cgroup v2 mount ${mount}`)
    if ((await statfs(mount)).type !== V2_MAGIC) unavailable(`${mount} is not a cgroup v2 filesystem`)
  })
  const procCgroup = await readFile('/proc/self/cgroup', { encoding: 'utf8', ...(signal ? { signal } : {}) })
  const callerCgroupPath = parseLinuxV2ProcessCgroup(procCgroup)
  const userServiceDir = `${mount}/user.slice/user-${owner}.slice/user@${owner}.service`
  const systemdRoot = `${userServiceDir}/dsh-native/uid-${owner}`
  const standaloneRoot = `${mount}/dsh-native/uid-${owner}`

  for (const candidate of [systemdRoot, standaloneRoot]) {
    if (callerCgroupPath === candidate) {
      unavailable(`caller resides directly in non-leaf delegated cgroup v2 root ${candidate}; move caller into ${candidate}/host`)
    }
    if (callerCgroupPath.startsWith(`${candidate}/job-`)) {
      unavailable('caller cannot reside inside an isolated job cgroup')
    }
  }

  const directCandidates = callerCgroupPath.startsWith(`${userServiceDir}/`)
    ? [systemdRoot, standaloneRoot]
    : [standaloneRoot, systemdRoot]
  let lastError: unknown

  // Pass 1: prefer a candidate where the current process already shares a writable common ancestor.
  for (const candidate of directCandidates) {
    try {
      await verifyV2DelegatedSubtree(candidate, owner, signal)
      const ancestor = resolveLinuxV2CommonAncestor(callerCgroupPath, candidate)
      await verifyWritableCgroupProcs(ancestor, `cgroup v2 common ancestor ${ancestor}/cgroup.procs (caller ${callerCgroupPath} -> ${candidate})`)
      return { mode: 'v2' as const, unified: candidate }
    } catch (error) {
      lastError = error
    }
  }

  // Pass 2: support cold-install / setup / foreground Host CLIs invoked from an
  // SSH login scope (`user-<uid>.slice/session-N.scope`) when `user-<uid>.slice`
  // is root-owned: `systemdRoot` is usable if `user@<uid>.service/cgroup.procs`
  // is owner-writable AND `/usr/bin/systemd-run --user --scope` can place keeper
  // gates inside `user@<uid>.service`. `standaloneRoot` is never returned when
  // the caller is outside `standaloneRoot` because non-root callers cannot cross
  // root-owned `/sys/fs/cgroup/cgroup.procs`.
  try {
    await verifyV2DelegatedSubtree(systemdRoot, owner, signal)
    await verifyWritableCgroupProcs(userServiceDir, `systemd user manager common ancestor ${userServiceDir}/cgroup.procs`)
    await verifyLinuxV2SystemdUserScopeBridge(owner, signal)
    return { mode: 'v2' as const, unified: systemdRoot }
  } catch (error) {
    lastError = lastError ?? error
  }

  throw lastError instanceof Error ? lastError : new RsiLinuxCgroupUnavailableError(`delegated cgroup v2 root unavailable; ${DELEGATION_HINT}`)
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
