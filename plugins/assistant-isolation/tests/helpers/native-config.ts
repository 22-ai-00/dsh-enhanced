import type { Config } from '../../src/config.js'
import type { LinuxCgroupRoots } from '../../src/linux-cgroups.js'
import type { LinuxRuntime } from '../../src/linux-runtime.js'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { linuxRuntimeFixture } from './linux-runtime-fixture.js'

const uid = process.getuid?.() ?? 1

export function syntheticLinuxRuntime(): LinuxRuntime {
  const path = '/opt/dsh-native-runtime'
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: 'a'.repeat(40), lockSha256: 'b'.repeat(64), root: { path, dev: 1, ino: 2, sha256: 'c'.repeat(64) },
    nodePath: `${path}/bin/node`, nodeSha256: 'd'.repeat(64), pnpmPath: `${path}/pnpm/bin/pnpm.mjs`,
    nativePnpmRoot: `${path}/pnpm-native`, nativePnpmPath: `${path}/pnpm-native/pnpm`,
    modulesPath: `${path}/node_modules`, storePath: `${path}/store`, cachePath: `${path}/cache`,
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}

export function syntheticCgroupRoots(): LinuxCgroupRoots {
  return { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` }
}

export function nativeConfig(stateRoot = '/var/tmp/dsh-native-config', overrides: Partial<Config> = {}): Config {
  return { backend: 'linux-native', stateRoot, linux: { runtime: syntheticLinuxRuntime(), cgroupRoots: syntheticCgroupRoots() }, ...overrides }
}

/** Real runtime tree for mounts that must pass the startup runtime verification.
 * The tree is built once per worker and reused; callers only own their state root.
 * Register {@link cleanupNativeFixtures} in afterEach/afterAll for temp cleanup. */
const fixtureRoots: string[] = []
let sharedFixture: Promise<{ runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }> | undefined
export function nativeFixtureRoots(): string[] { return fixtureRoots }
export async function cleanupNativeFixtures(): Promise<void> {
  await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  sharedFixture = undefined
}
export async function nativeConfigWithRuntime(stateRoot: string, overrides: Partial<Config> = {}): Promise<Config> {
  sharedFixture ??= (async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'assistant-isolation-native-config-')))
    fixtureRoots.push(base)
    return linuxRuntimeFixture(base)
  })()
  const { runtime, cgroupRoots } = await sharedFixture
  return { backend: 'linux-native', stateRoot, linux: { runtime, cgroupRoots }, ...overrides }
}
