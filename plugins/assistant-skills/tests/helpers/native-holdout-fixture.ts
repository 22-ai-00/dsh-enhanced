// Synthetic native descriptors for holdout/comparison configuration tests.
//
// The Docker artifact backend was removed; every execution profile now carries
// a fixed linux-native runtime and cgroup roots. Config-validation tests only
// need a structurally valid descriptor, so these fixtures avoid touching the
// filesystem. Live execution tests must provide a real prepared runtime via
// DSH_ISOLATION_TEST_NATIVE_RUNTIME and stay skipped otherwise.
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

/** Native execution descriptor base for HoldoutExecutionConfig. */
export function nativeExecution(stateRoot: string) {
  return { backend: 'linux-native' as const, runtime: syntheticLinuxRuntime(stateRoot), cgroupRoots: syntheticCgroupRoots(), stateRoot,
    command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh',
    expiresAt: Date.now() + 60_000, repeats: 2, maxToolCalls: 2, maxBytes: 65_536, maxOutputBytes: 65_536,
    cellDurationMs: 30_000, verificationDurationMs: 10_000 }
}

/** Path to a real prepared runtime for live execution tests, if provided. */
export const liveNativeRuntime = (): string | undefined => process.env.DSH_ISOLATION_TEST_NATIVE_RUNTIME
