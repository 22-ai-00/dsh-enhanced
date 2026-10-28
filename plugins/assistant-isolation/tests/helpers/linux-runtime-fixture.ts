import { createHash } from 'node:crypto'
import { copyFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { hashLinuxRuntimeTree, type LinuxRuntime } from '../../src/linux-runtime.js'
import type { LinuxCgroupRoots } from '../../src/linux-cgroups.js'

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
