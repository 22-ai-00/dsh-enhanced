import { chmod, mkdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { RsiAuthorityResources } from '../../src/rsi-authority-resources.js'
import type { LinuxV1CgroupRoots } from '../../src/rsi-linux-cgroup-roots.js'
import type { LinuxRsiCreationBuildEnvironment } from '../../src/rsi-linux-creation-build.js'
import type { LinuxRsiRepositoryBuildEnvironment } from '../../src/rsi-linux-repository-bootstrap.js'
import type { RsiLinuxSourceBuildPreparation } from '../../src/rsi-linux-source-build.js'
import type { RsiSourceWorkspace } from '../../src/rsi-source.js'
import { prepareRsiLinuxRunnerStates, type RsiLinuxRunnerStates } from '../../src/rsi-linux-runner-states.js'

/** Shape-valid descriptors and private runner directories only. These are not
 * real toolchain bytes, kernel allocations or evidence of native readiness. */
export async function nativePreparedFixture(resources: RsiAuthorityResources, source: RsiSourceWorkspace): Promise<{
  repository: LinuxRsiRepositoryBuildEnvironment
  cgroupRoots: LinuxV1CgroupRoots
  sourceBuild: RsiLinuxSourceBuildPreparation
  creationBuild: LinuxRsiCreationBuildEnvironment
  runnerStates: RsiLinuxRunnerStates
}> {
  const ownerUid = process.getuid?.(), ownerGid = process.getgid?.()
  if (process.platform !== 'linux' || ownerUid === undefined || ownerGid === undefined || ownerUid === 0) {
    throw new Error('native descriptor fixture requires non-root Linux')
  }
  for (const name of ['linux-source-build-runner', 'creation-review-runner', 'creation-adoption-runner',
    'revision-review-runner', 'revision-regression-runner']) {
    const path = join(resources.stateRoot, name)
    await mkdir(path, { recursive: true, mode: 0o700 }); await chmod(path, 0o700)
  }
  const family = join(dirname(dirname(resources.root)), 'rsi-linux-repository-runtimes', basename(resources.root))
  const runtimeAt = (root: string, ino: number): LinuxRuntime => ({ schemaVersion: 1, backend: 'linux-native',
    platform: `linux-${process.arch}` as LinuxRuntime['platform'], sourceCommit: source.sourceCommit, lockSha256: 'b'.repeat(64),
    root: { path: root, dev: 1, ino, sha256: 'c'.repeat(64) }, nodePath: join(root, 'bin/node'), nodeSha256: 'd'.repeat(64),
    pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'), nativePnpmRoot: join(root, 'pnpm-native'), nativePnpmPath: join(root, 'pnpm-native/pnpm'),
    modulesPath: join(root, 'node_modules'), storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } })
  const runtime = runtimeAt(join(family, 'runtime'), 2)
  const repository: LinuxRsiRepositoryBuildEnvironment = { schemaVersion: 4, backend: 'linux-native',
    sourceCommit: source.sourceCommit, lockSha256: runtime.lockSha256, runtime,
    systemSnapshot: { schemaVersion: 1, root: { path: join(family, 'system'), dev: 1, ino: 3, sha256: 'e'.repeat(64) },
      manifestSha256: 'f'.repeat(64), bytes: 6, entries: 3 },
    userNamespace: { schemaVersion: 1, ownerUid, ownerGid, candidateUid: 231072, candidateGid: 231072,
      hostNamespace: { dev: 1, ino: 4 }, helpers: {
        uid: { path: '/usr/bin/newuidmap', sha256: '1'.repeat(64) }, gid: { path: '/usr/bin/newgidmap', sha256: '2'.repeat(64) } } } }
  const leaf = (controller: string): string => `/sys/fs/cgroup/${controller}/dsh-native/uid-${ownerUid}`
  const cgroupRoots: LinuxV1CgroupRoots = { mode: 'v1', cpu: leaf('cpu,cpuacct'), memory: leaf('memory'), pids: leaf('pids'), freezer: leaf('freezer') }
  const creationBuild: LinuxRsiCreationBuildEnvironment = { schemaVersion: 3, backend: 'linux-native',
    sourceCommit: source.sourceCommit, buildRuntimeDigest: linuxRuntimeDigest(runtime),
    behavior: { schemaVersion: 1, runtime: runtimeAt(join(resources.stateRoot, 'linux-creation-behavior', 'runtime'), 5),
      observer: { schemaVersion: 1, sourceSha256: '1'.repeat(64), workerSha256: '2'.repeat(64), candidateSha256: '3'.repeat(64),
        launcherSha256: '4'.repeat(64), parentProtectSha256: '5'.repeat(64), childProtectSha256: '6'.repeat(64) } },
    cgroupRoots: structuredClone(cgroupRoots) }
  const runnerStates = await prepareRsiLinuxRunnerStates(resources, { creation: true, revision: true })
  return { repository, cgroupRoots, creationBuild, sourceBuild: { backend: 'linux-native', repository, cgroupRoots }, runnerStates }
}
