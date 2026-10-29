import { lstat, readFile, realpath, statfs } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { LinuxCgroupRoots } from '@dsh-enhanced/assistant-isolation'

/** Read-only discovery of the four cgroup v1 delegation roots created by the
 * root-run scripts/isolation/prepare-linux-cgroups.mjs delegation command.
 * Discovery never creates, remounts, synthesizes v2 roots or falls back to
 * rlimit/host-PID containment: a missing or ambiguous delegation is an
 * environment gap reported as not-ready so installation stops before granting
 * any finite behavior authority. */
const V1_MAGIC = 0x27e0eb
const CONTROLLERS = ['cpu', 'memory', 'pids', 'freezer'] as const
type Controller = typeof CONTROLLERS[number]
const MOUNT_PATTERN = /^\/sys\/fs\/cgroup\/[A-Za-z0-9_,]+$/u
const DELEGATION_HINT = 'rerun scripts/isolation/prepare-linux-cgroups.mjs --uid <owner uid> --v1 as root'

export class RsiLinuxCgroupUnavailableError extends Error {
  readonly code = 'rsi-linux-cgroup-unavailable'
  constructor(message: string) { super(`rsi linux cgroup unavailable: ${message}`) }
}

function fail(message: string): never { throw new Error(`rsi linux cgroup roots: ${message}`) }
function unavailable(message: string): never { throw new RsiLinuxCgroupUnavailableError(`${message}; ${DELEGATION_HINT}`) }

export type LinuxV1CgroupRoots = Extract<LinuxCgroupRoots, { mode: 'v1' }>

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

/** The delegated leaf mirrors the delegation command's strict leaf contract:
 * canonical real path, no symlink, owned by the invoking non-root user, exactly
 * mode 0700 and a cgroup v1 filesystem reached through exactly one mountinfo
 * entry for this controller. */
async function checkedLeaf(input: { controller: Controller; mount: string; lines: readonly string[]; signal?: AbortSignal }): Promise<string> {
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
  try {
    if (resolve(path) !== path || await realpath(path) !== path) unavailable(`the delegated ${controller} root is not canonical`)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) unavailable(`the delegated ${controller} root is not a private directory`)
    if (info.uid !== owner) unavailable(`the delegated ${controller} root is not owned by uid ${owner}`)
    if ((info.mode & 0o077) !== 0 || (info.mode & 0o700) !== 0o700) unavailable(`the delegated ${controller} root is not mode 0700`)
    if ((await statfs(path)).type !== V1_MAGIC) unavailable(`the delegated ${controller} root is not a cgroup v1 filesystem`)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (error instanceof RsiLinuxCgroupUnavailableError) throw error
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
      unavailable(`the delegated ${controller} root at ${path} is unavailable (${code})`)
    }
    throw error
  }
  return path
}

export async function discoverLinuxCgroupRoots(input: { signal?: AbortSignal } = {}): Promise<LinuxV1CgroupRoots> {
  input.signal?.throwIfAborted()
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) {
    fail('cgroup v1 delegation discovery requires Linux x64/arm64')
  }
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    fail('cgroup delegation must be discovered as the non-root owner, never root')
  }
  const lines = (await readFile('/proc/self/mountinfo', { encoding: 'utf8', signal: input.signal })).split('\n')
  const mounts = parseLinuxV1ControllerMounts(lines)
  const roots = {} as Record<Controller, string>
  for (const controller of CONTROLLERS) {
    const mount = mounts[controller]!
    if (!MOUNT_PATTERN.test(mount)) unavailable(`unexpected ${controller} controller mount ${mount}`)
    try {
      if ((await statfs(mount)).type !== V1_MAGIC) unavailable(`${mount} is not a cgroup v1 filesystem`)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM') {
        unavailable(`the ${controller} controller mount ${mount} is unavailable (${code})`)
      }
      throw error
    }
    roots[controller] = await checkedLeaf({ controller, mount, lines, ...(input.signal ? { signal: input.signal } : {}) })
  }
  if (new Set(CONTROLLERS.map(controller => roots[controller])).size !== CONTROLLERS.length) {
    unavailable('delegated controller roots are not distinct hierarchies')
  }
  return { mode: 'v1' as const, cpu: roots.cpu!, memory: roots.memory!, pids: roots.pids!, freezer: roots.freezer! }
}
