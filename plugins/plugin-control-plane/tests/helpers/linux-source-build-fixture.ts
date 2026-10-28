import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { vi } from 'vitest'
import { linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import type { LinuxRepositoryRunner, LinuxRepositoryRunnerRequest } from '@dsh-enhanced/assistant-isolation'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxSourceBuildConfig } from '../../src/source-build.js'

export function linuxSourceConfig(): LinuxSourceBuildConfig {
  const root = '/approved/runtime'
  return { backend: 'linux-native', stateRoot: '/approved/state', authorityDigest: 'a'.repeat(64),
    expiresAt: Date.now() + 60000, maxRuns: 2, maxTotalDurationMs: 120000, timeoutMs: 60000, outputBytes: 4096,
    memoryMiB: 512, cpus: 1, pidsLimit: 64, workspaceMiB: 128, temporaryMiB: 64, workspaceInodes: 4096, temporaryInodes: 4096,
    cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${process.getuid?.()}`,
      memory: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid?.()}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${process.getuid?.()}`,
      freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${process.getuid?.()}` },
    runtime: { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
      sourceCommit: 'b'.repeat(40), lockSha256: 'c'.repeat(64), root: { path: root, dev: 1, ino: 2, sha256: 'd'.repeat(64) },
      nodePath: root + '/bin/node', nodeSha256: 'e'.repeat(64), pnpmPath: root + '/pnpm/bin/pnpm.mjs',
      nativePnpmPath: root + '/pnpm-native/pnpm', nativePnpmRoot: root + '/pnpm-native', modulesPath: root + '/node_modules',
      storePath: root + '/store', cachePath: root + '/cache',
      versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4', tools: '1', systemPrompt: '1' } } }
}


/** A transport fixture, never a claim that the candidate passed repository checks. */
export function linuxMockRunner(settings: LinuxSourceBuildConfig,
  inspect?: (request: LinuxRepositoryRunnerRequest, archive: Buffer) => Promise<void> | void) {
  const run = vi.fn(async (_key: string, request: LinuxRepositoryRunnerRequest, loadArchive: (signal: AbortSignal) => Promise<Uint8Array>) => {
    const archive = Buffer.from(await loadArchive(new AbortController().signal))
    await inspect?.(request, archive)
    const plugin = request.argv.find((arg: string) => arg.startsWith('PLUGIN_ROOT='))!.slice('PLUGIN_ROOT='.length)
    const manifest = JSON.parse(execFileSync('/usr/bin/tar', ['-xOf', '-', plugin + '/package.json'],
      { input: archive, encoding: 'utf8' })) as { name: string; version: string }
    const bytes = Buffer.from([0, 255, 128, 10]), sha256 = createHash('sha256').update(bytes).digest('hex')
    return { result: { jobId: 'fixture-job', status: 'succeeded', quiescent: true, exitCode: 0,
      stdout: `DSH_PREPARED_PACK\tfixture-${manifest.version}.tgz\t${bytes.length}\t${sha256}\tv22.23.2\t11.7.0\n`, stderr: '' },
    artifacts: [{ path: '.dsh-native-artifact/package.tgz', bytes, sha256 }],
    receiptBinding: { requestDigest: 'a'.repeat(64), nativeNonce: 'b'.repeat(32),
      nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111', intentDigest: 'c'.repeat(64),
      resourcesDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
    contractDigest: 'f'.repeat(64), runtimeDigest: linuxRuntimeDigest(settings.runtime) }
  })
  return { run, runner: { run, runtimeDigest: linuxRuntimeDigest(settings.runtime), contractDigest: 'f'.repeat(64) } as unknown as LinuxRepositoryRunner }
}
