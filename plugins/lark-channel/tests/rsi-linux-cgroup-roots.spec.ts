import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverLinuxCgroupRoots, parseLinuxV1ControllerMounts,
  RsiLinuxCgroupUnavailableError } from '../src/rsi-linux-cgroup-roots.js'

const line = (mount: string, options: string, type = 'cgroup'): string =>
  `30 29 0:31 / ${mount} rw,nosuid,nodev,noexec,relatime shared:16 - ${type} ${type} rw,${options}`

const validMountinfo = (): string[] => [
  '29 20 0:25 / /sys/fs/cgroup ro,nosuid,nodev,noexec shared:9 - tmpfs tmpfs ro,size=4096k,mode=755',
  line('/sys/fs/cgroup/systemd', 'xattr,name=systemd'),
  line('/sys/fs/cgroup/net_cls,net_prio', 'net_cls,net_prio'),
  line('/sys/fs/cgroup/perf_event', 'perf_event'),
  line('/sys/fs/cgroup/freezer', 'freezer'),
  line('/sys/fs/cgroup/hugetlb', 'hugetlb'),
  line('/sys/fs/cgroup/cpu,cpuacct', 'cpu,cpuacct'),
  line('/sys/fs/cgroup/blkio', 'blkio'),
  line('/sys/fs/cgroup/devices', 'devices'),
  line('/sys/fs/cgroup/pids', 'pids'),
  line('/sys/fs/cgroup/memory', 'memory'),
  line('/sys/fs/cgroup/cpuset', 'cpuset'),
  '31 29 0:38 / /sys/fs/cgroup/unified rw,nosuid,nodev,noexec shared:23 - cgroup2 cgroup2 rw,nsdelegate',
  '18 25 0:5 / /somewhere/else rw shared:1 - cgroup cgroup rw,memory',
]

describe('parseLinuxV1ControllerMounts', () => {
  it('discovers exactly the four required v1 controller mounts', () => {
    expect(parseLinuxV1ControllerMounts(validMountinfo())).toEqual({
      cpu: '/sys/fs/cgroup/cpu,cpuacct', memory: '/sys/fs/cgroup/memory',
      pids: '/sys/fs/cgroup/pids', freezer: '/sys/fs/cgroup/freezer',
    })
  })

  it('ignores cgroup2, tmpfs and cgroup mounts outside /sys/fs/cgroup', () => {
    const mounts = parseLinuxV1ControllerMounts(validMountinfo())
    expect(Object.values(mounts).every(path => path.startsWith('/sys/fs/cgroup/'))).toBe(true)
  })

  it('reports not-ready when a required controller is not mounted', () => {
    const lines = validMountinfo().filter(entry => !entry.includes('rw,pids'))
    expect(() => parseLinuxV1ControllerMounts(lines))
      .toThrow(RsiLinuxCgroupUnavailableError)
    expect(() => parseLinuxV1ControllerMounts(lines))
      .toThrow(/missing pids/u)
  })

  it('reports not-ready on ambiguous duplicate controller mounts', () => {
    const lines = [...validMountinfo(), line('/sys/fs/cgroup/cpu', 'cpu')]
    expect(() => parseLinuxV1ControllerMounts(lines)).toThrow(/multiple cpu cgroup mounts/u)
  })

  it('reports not-ready on an empty mountinfo', () => {
    expect(() => parseLinuxV1ControllerMounts([])).toThrow(RsiLinuxCgroupUnavailableError)
  })
})

describe('discoverLinuxCgroupRoots', () => {
  afterEach(() => vi.restoreAllMocks())

  it.runIf(process.platform === 'linux')('refuses to discover delegation as root', () => {
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    expect(discoverLinuxCgroupRoots()).rejects.toThrow('never root')
  })

  it.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))('returns a strict v1 root set or a not-ready environment error, never a fallback', async () => {
    try {
      const roots = await discoverLinuxCgroupRoots()
      expect(roots.mode).toBe('v1')
      expect(Object.keys(roots).sort()).toEqual(['cpu', 'freezer', 'memory', 'mode', 'pids'])
      const owner = process.getuid!()
      const leaf = new RegExp(`^/sys/fs/cgroup/[A-Za-z0-9_,]+/dsh-native/uid-${owner}$`, 'u')
      for (const path of [roots.cpu, roots.memory, roots.pids, roots.freezer]) expect(path).toMatch(leaf)
      expect(new Set([roots.cpu, roots.memory, roots.pids, roots.freezer]).size).toBe(4)
    } catch (error) {
      // On hosts without the root-run delegation (CI workstations) discovery is
      // not-ready; any other error class would mean probing created or guessed.
      expect(error).toBeInstanceOf(RsiLinuxCgroupUnavailableError)
    }
  })
})
