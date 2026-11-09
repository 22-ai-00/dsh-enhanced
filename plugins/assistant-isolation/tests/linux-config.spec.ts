import { describe, expect, test } from 'vitest'
import { Config, defaultLimits, validateConfig } from '../src/config.js'
import { linuxJobResourceReservation, type LinuxExecutionContract } from '../src/linux-execution-contract.js'
import type { LinuxRuntime } from '../src/linux-runtime.js'
import { plannedStorageBytes } from '../src/storage-policy.js'
import { nativeConfig } from './helpers/native-config.js'

const uid = process.getuid?.() ?? 1
function runtime(): LinuxRuntime {
  const path = '/opt/dsh-native-runtime'
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: `${path}/bin/node`, nodeSha256: 'd'.repeat(64), pnpmPath: `${path}/pnpm/bin/pnpm.mjs`,
    nativePnpmRoot: `${path}/pnpm-native`, nativePnpmPath: `${path}/pnpm-native/pnpm`,
    modulesPath: `${path}/node_modules`, storePath: `${path}/store`, cachePath: `${path}/cache`,
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}
const native = (): Config => ({ backend: 'linux-native', stateRoot: '/var/tmp/dsh-native-config', linux: { runtime: runtime(),
  cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } } })
function synchronous(value: unknown) {
  const result = Config['~standard'].validate(value)
  expect(result).not.toBeInstanceOf(Promise)
  if (result instanceof Promise) throw new Error('asynchronous config validation')
  return result
}

test('rejects a legacy or missing backend synchronously without any Docker lookup', () => {
  expect(synchronous({}).issues).toBeDefined()
  expect(synchronous({ backend: 'docker', image: 'sha256:' + 'a'.repeat(64) }).issues).toBeDefined()
  expect(synchronous({ backend: 'arbitrary' }).issues).toBeDefined()
})

describe.skipIf(process.platform !== 'linux' || uid === 0)('public Linux configuration admission', () => {
  test('validates synchronously and never requires a Docker socket or image', () => {
    const grants = [{ id: 'finite', revision: 1, principalDigest: 'a'.repeat(64), principalRecordId: 'owner', principalVersion: 1,
      workspace: '/workspace', agentPreset: 'default', expiresAt: Date.now() + 1000, maxRuns: 1, maxTotalDurationMs: 1000 }]
    const input = nativeConfig('/var/tmp/dsh-native-config', { grants })
    expect(validateConfig(input)).toMatchObject({ backend: 'linux-native', grants })
    expect(synchronous(input).issues).toBeUndefined()
  })

  test.each(['missing', 'runtime-drift', 'v2', 'other-uid', 'overlap'] as const)('Loader rejects %s synchronously', mode => {
    const input = native()
    if (mode === 'missing') {
      const { linux: _linux, ...withoutLinux } = input
      expect(synchronous(withoutLinux).issues).toBeDefined()
      return
    }
    if (mode === 'runtime-drift') input.linux.runtime.nodePath = '/usr/bin/node'
    if (mode === 'v2') input.linux.cgroupRoots = { mode: 'v2', unified: `/sys/fs/cgroup/dsh-native/uid-${uid}` }
    if (mode === 'other-uid') input.linux.cgroupRoots = { mode: 'v1', cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-99999',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-99999', pids: '/sys/fs/cgroup/pids/dsh-native/uid-99999', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-99999' }
    if (mode === 'overlap') input.stateRoot = input.linux.runtime.root.path + '/state'
    expect(synchronous(input).issues).toBeDefined()
  })

  test('admits exact memory/inode/storage reservations and rejects one unit less', () => {
    const input: Config = { ...native(), limits: { maxArtifactBytes: 1_048_576 } }, contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', profile: 'ordinary',
      runtimeDigest: 'a'.repeat(64), limits: { ...defaultLimits, ...input.limits }, keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: input.linux!.cgroupRoots }
    const reservation = linuxJobResourceReservation(contract)
    expect(reservation).toEqual({ memoryMiB: 513, workspaceInodes: 12320, storageBytes: 3 * plannedStorageBytes(contract.limits) })
    input.maxReservedMemoryMiB = reservation.memoryMiB
    input.maxReservedWorkspaceInodes = reservation.workspaceInodes
    input.storage = { maxStateBytes: reservation.storageBytes }
    expect(synchronous(input).issues).toBeUndefined()
    expect(synchronous({ ...input, maxReservedMemoryMiB: reservation.memoryMiB - 1 }).issues).toBeDefined()
    expect(synchronous({ ...input, maxReservedWorkspaceInodes: reservation.workspaceInodes - 1 }).issues).toBeDefined()
    expect(synchronous({ ...input, storage: { maxStateBytes: reservation.storageBytes - 1 } }).issues).toBeDefined()
  })

  test('reserves the rounded worker tmp mount as well as keeper and shared memory', () => {
    const input = native()
    const contract: LinuxExecutionContract = { schemaVersion: 1, backend: 'linux-native', profile: 'ordinary', runtimeDigest: 'a'.repeat(64),
      limits: { ...defaultLimits, memoryMiB: 129 }, keeperLimits: { memoryMiB: 128, pidsLimit: 64, cpus: 0.5 }, cgroupRoots: input.linux!.cgroupRoots }
    expect(linuxJobResourceReservation(contract).memoryMiB).toBe(129 + 64 + 33 + 1 + 128)
  })
})
