import { hashLinuxRuntimeTree, type Config, type IsolationGrant, type LinuxCgroupRoots, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { chmod, copyFile, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

const uid = process.getuid?.() ?? 1
const sha = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const runtimeRoots = new Set<string>()

/** Remove every runtime tree created through this helper. Specs call it in afterAll. */
export async function cleanupNativeIsolation(): Promise<void> {
  for (const root of runtimeRoots) {
    runtimeRoots.delete(root)
    await rm(root, { recursive: true, force: true })
  }
}

/** Build a structurally valid linux runtime tree in a private temp directory
 * so the isolation service startup verification passes. The tests only exercise
 * the actions broker, not the runner. */
async function realLinuxRuntime(): Promise<LinuxRuntime> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'actions-isolation-runtime-')))
  runtimeRoots.add(root)
  const write = async (name: string, value: string, mode = 0o444): Promise<void> => {
    await mkdir(dirname(join(root, name)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, name), value, { mode })
  }
  await write('pnpm/bin/pnpm.mjs', 'console.log("11.7.0")\n')
  await write('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o555)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  const lockBytes = await readFile(join(root, 'pnpm-lock.yaml'))
  await write('source/retained.txt', 'retained\n')
  for (const [name, version] of Object.entries({ typescript: '6.0.3', '@deepseek-ai/cordis': '4.0.5',
    '@deepseek-ai/dsh-tools': '0.2.1-rc.2', '@deepseek-ai/dsh-system-prompt': '0.2.1-rc.2' })) {
    await write(`node_modules/${name}/package.json`, JSON.stringify({ version }))
  }
  for (const name of ['bin', 'store', 'cache']) await mkdir(join(root, name), { mode: 0o700 })
  for (const name of ['bin/node', 'pnpm-native/node']) {
    await copyFile('/usr/bin/node', join(root, name)); await chmod(join(root, name), 0o555)
  }
  await symlink('retained.txt', join(root, 'source', 'internal-link'))
  const info = await lstat(root)
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: sha(lockBytes), root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin/node'), nodeSha256: sha(await readFile(join(root, 'bin/node'))), pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(root, 'pnpm-native'), nativePnpmPath: join(root, 'pnpm-native/pnpm'),
    modulesPath: join(root, 'node_modules'), storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}

function syntheticCgroupRoots(): LinuxCgroupRoots {
  return { mode: 'v1', cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${uid}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${uid}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${uid}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${uid}` }
}

/** Linux-native isolation config backed by a real (but minimal) runtime tree. */
export async function nativeIsolationConfig(stateRoot: string, grants: IsolationGrant[]): Promise<Config> {
  return { backend: 'linux-native', stateRoot,
    linux: { runtime: await realLinuxRuntime(), cgroupRoots: syntheticCgroupRoots() }, grants }
}
