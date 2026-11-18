import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  discoverLinuxCgroupRoots,
  parseLinuxV1ControllerMounts,
  parseLinuxV2ProcessCgroup,
  parseLinuxV2UnifiedMount,
  resolveLinuxV2CommonAncestor,
  verifyLinuxV2SystemdUserScopeBridge,
  RsiLinuxCgroupUnavailableError,
  validateLinuxCgroupRoots,
  type LinuxCgroupRoots,
  type LinuxV1CgroupRoots,
  type LinuxV2CgroupRoots,
} from '../src/native-resources.js'

const v2Mountinfo = (extra: string[] = []) => [
  '22 1 8:1 / / rw,relatime - ext4 /dev/root rw',
  '29 22 0:26 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime - cgroup2 cgroup2 rw,nsdelegate,memory_recursiveprot',
  ...extra,
]

const v1Mountinfo = (extra: string[] = []) => [
  '25 22 0:23 / /sys/fs/cgroup ro,nosuid,nodev,noexec mode=755 - tmpfs tmpfs ro',
  '26 25 0:24 / /sys/fs/cgroup/cpu,cpuacct rw,nosuid,nodev,noexec - cgroup cgroup rw,cpu,cpuacct',
  '27 25 0:25 / /sys/fs/cgroup/memory rw,nosuid,nodev,noexec - cgroup cgroup rw,memory',
  '28 25 0:26 / /sys/fs/cgroup/pids rw,nosuid,nodev,noexec - cgroup cgroup rw,pids',
  '29 25 0:27 / /sys/fs/cgroup/freezer rw,nosuid,nodev,noexec - cgroup cgroup rw,freezer',
  ...extra,
]

interface PrepareHelpers {
  parsePrepareArgs(argv: string[]): { uid: number; mode: 'v1' | 'v2' | 'auto' }
  resolveMountMode(text: string, mode: 'v1' | 'v2' | 'auto'): { mode: 'v1'; v1Mounts: Record<string, string> } | { mode: 'v2'; unifiedMount: string }
  missingSubtreeControllers(controllersText: string, subtreeText: string): string[]
}

async function loadPrepareHelpers(): Promise<PrepareHelpers> {
  const scriptPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/isolation/prepare-linux-cgroups.mjs')
  return await import(pathToFileURL(scriptPath).href) as PrepareHelpers
}

describe('Linux cgroup v2 mount parsing and backwards-compatible v1 discovery', () => {
  afterEach(() => vi.restoreAllMocks())

  test('parseLinuxV2UnifiedMount resolves pure unified cgroup2 mounts', () => {
    expect(parseLinuxV2UnifiedMount(v2Mountinfo())).toBe('/sys/fs/cgroup')
    const roots: LinuxCgroupRoots[] = [
      { mode: 'v2', unified: '/sys/fs/cgroup/dsh-native/uid-1000' } satisfies LinuxV2CgroupRoots,
      {
        mode: 'v1',
        cpu: '/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-1000',
        memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000',
        pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
        freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000',
      } satisfies LinuxV1CgroupRoots,
    ]
    expect(roots.map(item => item.mode)).toEqual(['v2', 'v1'])
  })

  test('parseLinuxV2UnifiedMount fails closed on hybrid, missing, non-canonical, and ambiguous mounts', () => {
    // Hybrid systemd hierarchy (v1 controllers + /sys/fs/cgroup/unified cgroup2)
    expect(() => parseLinuxV2UnifiedMount(v1Mountinfo([
      '30 25 0:28 / /sys/fs/cgroup/unified rw,nosuid,nodev,noexec - cgroup2 cgroup2 rw',
    ]))).toThrow(RsiLinuxCgroupUnavailableError)
    // Hybrid named v1 hierarchy alongside unified root
    expect(() => parseLinuxV2UnifiedMount(v2Mountinfo([
      '30 29 0:27 / /sys/fs/cgroup/systemd rw,nosuid,nodev,noexec - cgroup cgroup rw,name=systemd',
    ]))).toThrow(/hybrid/u)
    // v1-only or empty mountinfo
    expect(() => parseLinuxV2UnifiedMount(v1Mountinfo())).toThrow(RsiLinuxCgroupUnavailableError)
    expect(() => parseLinuxV2UnifiedMount([])).toThrow(/missing/u)
    // Non-canonical cgroup2 mountpoint
    expect(() => parseLinuxV2UnifiedMount([
      '29 22 0:26 / /sys/fs/cgroup/unified rw - cgroup2 cgroup2 rw',
    ])).toThrow(/unexpected cgroup v2 mount/u)
    // Ambiguous duplicate unified mounts
    expect(() => parseLinuxV2UnifiedMount(v2Mountinfo([
      '31 29 0:29 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw',
    ]))).toThrow(/multiple cgroup v2 mounts/u)
  })

  test('parseLinuxV1ControllerMounts retains pure v1 backwards compatibility', () => {
    expect(parseLinuxV1ControllerMounts(v1Mountinfo([
      '30 25 0:28 / /sys/fs/cgroup/unified rw - cgroup2 cgroup2 rw',
    ]))).toEqual({
      cpu: '/sys/fs/cgroup/cpu,cpuacct',
      memory: '/sys/fs/cgroup/memory',
      pids: '/sys/fs/cgroup/pids',
      freezer: '/sys/fs/cgroup/freezer',
    })
  })

  test('prepare-linux-cgroups helpers parse --v1, --v2, --auto and subtree controllers cleanly', async () => {
    const helper = await loadPrepareHelpers()
    expect(helper.parsePrepareArgs(['--uid', '1000', '--v1'])).toEqual({ uid: 1000, mode: 'v1' })
    expect(helper.parsePrepareArgs(['--uid', '1000', '--v2'])).toEqual({ uid: 1000, mode: 'v2' })
    expect(helper.parsePrepareArgs(['--uid', '1000', '--auto'])).toEqual({ uid: 1000, mode: 'auto' })
    for (const invalid of [
      ['--uid', '0', '--v2'],
      ['--uid', 'abc', '--v1'],
      ['--uid', '4294967296', '--v2'],
      ['--uid', '1000', '--v3'],
      ['--uid', '1000'],
    ]) {
      expect(() => helper.parsePrepareArgs(invalid)).toThrow(/prepare Linux cgroups/u)
    }

    expect(helper.resolveMountMode(v2Mountinfo().join('\n'), 'v2')).toEqual({
      mode: 'v2',
      unifiedMount: '/sys/fs/cgroup',
    })
    expect(helper.resolveMountMode(v2Mountinfo().join('\n'), 'auto')).toEqual({
      mode: 'v2',
      unifiedMount: '/sys/fs/cgroup',
    })
    expect(helper.resolveMountMode(v1Mountinfo().join('\n'), 'auto')).toEqual({
      mode: 'v1',
      v1Mounts: {
        cpu: '/sys/fs/cgroup/cpu,cpuacct',
        memory: '/sys/fs/cgroup/memory',
        pids: '/sys/fs/cgroup/pids',
        freezer: '/sys/fs/cgroup/freezer',
      },
    })
    // Backwards-compatible --v1 still works on legacy v1 mounts
    expect(helper.resolveMountMode(v1Mountinfo([
      '30 25 0:28 / /sys/fs/cgroup/unified rw - cgroup2 cgroup2 rw',
    ]).join('\n'), 'v1').mode).toBe('v1')
    // --auto and --v2 fail closed on hybrid hierarchies
    const hybrid = v1Mountinfo([
      '30 25 0:28 / /sys/fs/cgroup/unified rw - cgroup2 cgroup2 rw',
    ]).join('\n')
    expect(() => helper.resolveMountMode(hybrid, 'v2')).toThrow(/hybrid/u)
    expect(() => helper.resolveMountMode(hybrid, 'auto')).toThrow(/hybrid/u)
    expect(() => helper.resolveMountMode('', 'auto')).toThrow(/no supported/u)

    expect(helper.missingSubtreeControllers('cpuset cpu io memory pids\n', '\n')).toEqual(['cpu', 'memory', 'pids'])
    expect(helper.missingSubtreeControllers('cpu memory pids\n', 'cpu memory\n')).toEqual(['pids'])
    expect(helper.missingSubtreeControllers('cpu memory pids io\n', 'cpu memory pids io\n')).toEqual([])
    expect(() => helper.missingSubtreeControllers('cpu memory\n', 'cpu\n')).toThrow(/pids is unavailable/u)
  })

  test('parseLinuxV2ProcessCgroup and resolveLinuxV2CommonAncestor enforce kernel v2 migration containment', () => {
    expect(parseLinuxV2ProcessCgroup('0::/dsh-native/uid-1000/host\n')).toBe('/sys/fs/cgroup/dsh-native/uid-1000/host')
    expect(parseLinuxV2ProcessCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-profile-web.service\n'))
      .toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-profile-web.service')
    expect(parseLinuxV2ProcessCgroup('0::/\n')).toBe('/sys/fs/cgroup')

    // Reject hybrid memberships, malformed lines, duplicate 0::, and path traversal
    expect(() => parseLinuxV2ProcessCgroup('4:memory:/user.slice\n0::/user.slice\n')).toThrow(/hybrid/u)
    expect(() => parseLinuxV2ProcessCgroup('0:cpu:/user.slice\n')).toThrow(/unexpected controller/u)
    expect(() => parseLinuxV2ProcessCgroup('0::/a\n0::/b\n')).toThrow(/multiple 0::/u)
    expect(() => parseLinuxV2ProcessCgroup('0::/a/../b\n')).toThrow(/noncanonical/u)
    expect(() => parseLinuxV2ProcessCgroup('')).toThrow(/missing unified 0::/u)

    // Standalone host leaf shares delegated root as common ancestor
    expect(resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/dsh-native/uid-1000/host',
      '/sys/fs/cgroup/dsh-native/uid-1000',
    )).toBe('/sys/fs/cgroup/dsh-native/uid-1000')

    // systemd --user unit shares user@<uid>.service as delegated common ancestor
    const systemdRoot = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/dsh-native/uid-1000'
    expect(validateLinuxCgroupRoots({ mode: 'v2', unified: systemdRoot })).toEqual({ mode: 'v2', unified: systemdRoot })
    expect(() => validateLinuxCgroupRoots({
      mode: 'v2',
      unified: '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/dsh-native/uid-1001',
    })).toThrow()
    expect(resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/dsh-profile-lark.service',
      systemdRoot,
    )).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service')

    // Unrelated login scope targeting standalone /sys/fs/cgroup/dsh-native/uid-1000 resolves to root /sys/fs/cgroup (which fails W_OK at kernel check)
    expect(resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/user.slice/user-1000.slice/session-1.scope',
      '/sys/fs/cgroup/dsh-native/uid-1000',
    )).toBe('/sys/fs/cgroup')

    // SSH login scope targeting systemdRoot resolves to user-1000.slice, whereas a keeper placed in user@1000.service via systemd-run --user --scope shares user@1000.service!
    expect(resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/user.slice/user-1000.slice/session-42.scope',
      systemdRoot,
    )).toBe('/sys/fs/cgroup/user.slice/user-1000.slice')
    expect(resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/run-r9876.scope',
      systemdRoot,
    )).toBe('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service')

    // Reject no-internal-processes violation (caller directly in non-leaf root) and inside-job caller
    expect(() => resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/dsh-native/uid-1000',
      '/sys/fs/cgroup/dsh-native/uid-1000',
    )).toThrow(/non-leaf/u)
    expect(() => resolveLinuxV2CommonAncestor(
      '/sys/fs/cgroup/dsh-native/uid-1000/job-abc',
      '/sys/fs/cgroup/dsh-native/uid-1000',
    )).toThrow(/isolated job cgroup/u)
  })

  test('verifyLinuxV2SystemdUserScopeBridge fails closed with RsiLinuxCgroupUnavailableError on invalid uid or missing runtime bridge', async () => {
    await expect(verifyLinuxV2SystemdUserScopeBridge(0)).rejects.toThrow(RsiLinuxCgroupUnavailableError)
    await expect(verifyLinuxV2SystemdUserScopeBridge(999_999_999)).rejects.toThrow(RsiLinuxCgroupUnavailableError)
  })

  test.runIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch))(
    'discoverLinuxCgroupRoots validates real Linux v1/v2 delegation or reports RsiLinuxCgroupUnavailableError',
    async () => {
      vi.spyOn(process, 'getuid').mockReturnValue(0)
      await expect(discoverLinuxCgroupRoots()).rejects.toThrow('never root')
      vi.restoreAllMocks()

      try {
        const roots = await discoverLinuxCgroupRoots()
        const uid = process.getuid!()
        if (roots.mode === 'v2') {
          expect([
            `/sys/fs/cgroup/dsh-native/uid-${uid}`,
            `/sys/fs/cgroup/user.slice/user-${uid}.slice/user@${uid}.service/dsh-native/uid-${uid}`,
          ]).toContain(roots.unified)
        } else {
          expect(roots.mode).toBe('v1')
          expect(Object.keys(roots).sort()).toEqual(['cpu', 'freezer', 'memory', 'mode', 'pids'])
        }
      } catch (error) {
        expect(error).toBeInstanceOf(RsiLinuxCgroupUnavailableError)
      }
    },
  )
})
