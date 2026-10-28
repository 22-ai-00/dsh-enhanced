import { createHash } from 'node:crypto'
import { copyFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { IsolationLedger } from '../../../assistant-isolation/lib/ledger.js'
import { hashLinuxRuntimeTree, linuxJobResourceReservation, linuxRuntimeDigest, type LinuxRepositoryRunnerConfig, type LinuxRepositoryExecutionContract, type LinuxRuntime, type LinuxCgroupRoots } from '@dsh-enhanced/assistant-isolation'

const hash = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
/** Real fixed Node; small immutable package/version fixtures, not a full dependency store. */
export async function linuxRuntimeFixture(root: string): Promise<{ runtime: LinuxRuntime; cgroupRoots: LinuxCgroupRoots }> {
  const runtimeRoot = join(root, 'runtime')
  await mkdir(runtimeRoot, { mode: 0o755 })
  const write = async (path: string, content: string, mode = 0o444): Promise<void> => {
    await mkdir(dirname(join(runtimeRoot, path)), { recursive: true, mode: 0o755 })
    await writeFile(join(runtimeRoot, path), content, { mode })
  }
  // Real Node 22 executable checks run on the Host. pnpm adapters and version
  // manifests are minimal fixture content; candidate execution uses real Node.
  await mkdir(join(runtimeRoot, 'bin'), { mode: 0o755 })
  await copyFile('/usr/bin/node', join(runtimeRoot, 'bin/node'))
  await chmod(join(runtimeRoot, 'bin/node'), 0o555)
  await write('pnpm/bin/pnpm.mjs', 'console.log("11.7.0")\n')
  await write('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o555)
  await copyFile('/usr/bin/node', join(runtimeRoot, 'pnpm-native/node'))
  await chmod(join(runtimeRoot, 'pnpm-native/node'), 0o555)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  for (const [name, version] of Object.entries({ typescript: '6.0.3', '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2', '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2' })) {
    await write(`node_modules/${name}/package.json`, JSON.stringify({ version }))
  }
  for (const name of ['store', 'cache']) await mkdir(join(runtimeRoot, name), { mode: 0o755 })
  await chmod(runtimeRoot, 0o755)
  const info = await stat(runtimeRoot)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: hash(await readFile(join(runtimeRoot, 'pnpm-lock.yaml'))),
    root: { path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(runtimeRoot) },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: hash(await readFile(join(runtimeRoot, 'bin/node'))),
    pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'), nativePnpmRoot: join(runtimeRoot, 'pnpm-native'),
    nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'), modulesPath: join(runtimeRoot, 'node_modules'),
    storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
  const uid = process.getuid!()
  return { runtime, cgroupRoots: { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` } }
}


/** Spend a finite real ledger run without dispatching candidate code. */
export function spendLinuxRepositoryRun(config: LinuxRepositoryRunnerConfig): void {
  const db = new DatabaseSync(join(config.stateRoot, 'ledger.sqlite'))
  const row = db.prepare('SELECT owner_id,fence FROM isolation_controller').get()!; db.close()
  const authority = { ownerId: String(row.owner_id), fence: Number(row.fence) }
  const contract: LinuxRepositoryExecutionContract = { schemaVersion: 2, backend: 'linux-native', profile: 'repository',
    runtimeDigest: linuxRuntimeDigest(config.runtime), limits: config.limits, cgroupRoots: config.cgroupRoots,
    keeperLimits: { memoryMiB: 256, pidsLimit: 64, cpus: 0.5 } }
  const reservation = linuxJobResourceReservation(contract), ledger = new IsolationLedger(join(config.stateRoot, 'ledger.sqlite'))
  try {
    const spent = ledger.prepare({ identity: { principalDigest: config.authorityDigest, principalRecordId: `repository:${config.authorityDigest}`,
      principalVersion: 1, workspace: config.stateRoot, agentPreset: 'repository' }, sessionId: `authority:${config.authorityDigest}`,
      grantId: 'repository', idempotencyKey: 'spent', requestDigest: 'b'.repeat(64), durationMs: config.limits.maxDurationMs, authority,
      backend: 'linux-native', linuxContract: contract, resourceReservation: { memoryMiB: reservation.memoryMiB, workspaceInodes: reservation.workspaceInodes,
        maxMemoryMiB: 32768, maxWorkspaceInodes: 3000000 }, storageBudget: { reservedBytes: reservation.storageBytes,
        maxStateBytes: 1024 ** 3, maxJobRecords: 10000, observation: { bytes: 0, observedAt: Date.now() } } }).job
    ledger.settle(spent.id, spent.version, { jobId: spent.id, status: 'failed', quiescent: true, stdout: '', stderr: '', artifacts: [] }, authority)
  } finally { ledger.close() }
}
