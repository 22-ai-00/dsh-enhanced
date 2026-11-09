// Native isolation descriptors for benchmark configuration and lifecycle tests.
//
// The Docker artifact backend was removed; every execution profile now carries a
// fixed linux-native runtime and current-UID cgroup v1 roots. Construction and
// admission tests only need structurally valid descriptors, so these fixtures
// avoid touching the filesystem. Tests that really start an isolated process are
// gated by DSH_ISOLATION_TEST_NATIVE_RUNTIME, which must point to a JSON file
// containing a prepared descriptor: { runtime, cgroupRoots } (or { linux: {...} }).
import { readFileSync } from 'node:fs'
import type { LinuxCgroupRoots, LinuxRuntime } from '@dsh-enhanced/assistant-isolation'

const hex = (letter: string): string => letter.repeat(64)

/** Structurally valid runtime descriptor rooted at an arbitrary absolute path. */
export function syntheticLinuxRuntime(root: string): LinuxRuntime {
  return {
    schemaVersion: 1,
    backend: 'linux-native',
    platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40),
    lockSha256: hex('a'),
    root: { path: `${root}/runtime`, dev: 1, ino: 2, sha256: hex('b') },
    nodePath: `${root}/runtime/bin/node`,
    nodeSha256: hex('c'),
    pnpmPath: `${root}/runtime/pnpm/bin/pnpm.mjs`,
    nativePnpmRoot: `${root}/runtime/pnpm-native`,
    nativePnpmPath: `${root}/runtime/pnpm-native/pnpm`,
    modulesPath: `${root}/runtime/node_modules`,
    storePath: `${root}/runtime/store`,
    cachePath: `${root}/runtime/cache`,
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
  }
}

/** Current-UID cgroup v1 roots in the canonical dsh-native layout. */
export function syntheticCgroupRoots(): LinuxCgroupRoots {
  const uid = process.getuid!()
  return { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` }
}

/** Path to a real prepared runtime descriptor for live execution tests, if provided. */
export const liveNativeRuntime = (): string | undefined => process.env.DSH_ISOLATION_TEST_NATIVE_RUNTIME

export interface NativeExecutionDescriptor { backend: 'linux-native'; runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }

/** Real descriptor from the live environment when present, otherwise a synthetic one. */
export function nativeExecution(root: string): NativeExecutionDescriptor {
  const source = liveNativeRuntime()
  if (source === undefined) return { backend: 'linux-native', runtime: syntheticLinuxRuntime(root), cgroupRoots: syntheticCgroupRoots() }
  const parsed = JSON.parse(readFileSync(source, 'utf8')) as {
    runtime?: unknown; cgroupRoots?: unknown; linux?: { runtime?: unknown; cgroupRoots?: unknown }
  }
  const runtime = parsed.runtime ?? parsed.linux?.runtime
  const cgroupRoots = parsed.cgroupRoots ?? parsed.linux?.cgroupRoots
  if (runtime === undefined || cgroupRoots === undefined) throw new Error('DSH_ISOLATION_TEST_NATIVE_RUNTIME must describe runtime and cgroupRoots')
  return { backend: 'linux-native', runtime: runtime as LinuxRuntime, cgroupRoots: cgroupRoots as LinuxCgroupRoots }
}
