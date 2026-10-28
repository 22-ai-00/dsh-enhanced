import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { hashLinuxRuntimeTree, validateLinuxRuntime, verifyLinuxRuntime, type LinuxRuntime } from '../src/linux-runtime.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture(): Promise<LinuxRuntime> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-linux-runtime-test-'))
  directories.push(root)
  const write = async (path: string, content: string, mode = 0o600): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 })
    await writeFile(join(root, path), content, { mode })
  }
  await write('bin/node', '#!/bin/sh\nif [ "$1" = "--version" ]; then echo v22.23.2; else echo 11.7.0; fi\n', 0o500)
  await write('pnpm/bin/pnpm.mjs', 'fixed pnpm')
  await write('pnpm-native/pnpm', '#!/bin/sh\necho 11.7.0\n', 0o500)
  await write('pnpm-native/node', await readFile(join(root, 'bin', 'node'), 'utf8'), 0o500)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm-lock.yaml', "lockfileVersion: '9.0'\n")
  await write('node_modules/typescript/package.json', '{"version":"6.0.3"}')
  await write('node_modules/@deepseek-ai/cordis/package.json', '{"version":"4.0.5"}')
  await write('node_modules/@deepseek-ai/dsh-tools/package.json', '{"version":"0.2.1-rc.2"}')
  await write('node_modules/@deepseek-ai/dsh-system-prompt/package.json', '{"version":"0.2.1-rc.2"}')
  await mkdir(join(root, 'store'), { mode: 0o700 })
  await mkdir(join(root, 'cache'), { mode: 0o700 })
  const fs = await import('node:fs/promises')
  const info = await fs.stat(root)
  const nodeSha256 = (await import('node:crypto')).createHash('sha256')
    .update(await readFile(join(root, 'bin', 'node'))).digest('hex')
  const lockSha256 = (await import('node:crypto')).createHash('sha256')
    .update(await readFile(join(root, 'pnpm-lock.yaml'))).digest('hex')
  return { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256,
    root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin', 'node'), nodeSha256,
    pnpmPath: join(root, 'pnpm', 'bin', 'pnpm.mjs'), nativePnpmRoot: join(root, 'pnpm-native'),
    nativePnpmPath: join(root, 'pnpm-native', 'pnpm'), modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'), cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5',
      tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
}

test.runIf(process.platform === 'linux')('runtime is pinned to its complete tree, package versions and executable behavior', async () => {
  const runtime = await fixture()
  await expect(verifyLinuxRuntime(runtime)).resolves.toMatchObject({ backend: 'linux-native' })
  await expect(verifyLinuxRuntime({ ...runtime, nodePath: '/usr/bin/node' })).rejects.toThrow('invalid Linux runtime')
  await writeFile(join(runtime.root.path, 'store', 'tamper'), 'changed')
  await expect(verifyLinuxRuntime(runtime)).rejects.toThrow('root differs')
  await rm(join(runtime.root.path, 'store', 'tamper'))
  await chmod(join(runtime.root.path, 'node_modules', 'typescript', 'package.json'), 0o666)
  await expect(verifyLinuxRuntime(runtime)).rejects.toThrow('file bound')
})

test.runIf(process.platform === 'linux')('runtime tree rejects external links and special files', async () => {
  const runtime = await fixture()
  await symlink('/etc/passwd', join(runtime.root.path, 'cache', 'outside'))
  await expect(hashLinuxRuntimeTree(runtime.root.path)).rejects.toThrow('link escaped root')
})

test.runIf(process.platform === 'linux')('runtime schema refuses unexpected backend and credential path', async () => {
  const runtime = await fixture()
  expect(() => validateLinuxRuntime({ ...runtime, backend: 'docker' })).toThrow('invalid Linux runtime')
  expect(() => validateLinuxRuntime({ ...runtime, cachePath: '/home/user/.npm' })).toThrow('invalid Linux runtime')
  expect(() => validateLinuxRuntime({ ...runtime, dockerPath: '/usr/bin/docker' })).toThrow('invalid Linux runtime')
})

test.runIf(process.platform === 'linux')('the release adapter Node copy must match the pinned standalone Node', async () => {
  const runtime = await fixture()
  await chmod(join(runtime.nativePnpmRoot, 'node'), 0o700)
  await writeFile(join(runtime.nativePnpmRoot, 'node'), '#!/bin/sh\necho different\n')
  await chmod(join(runtime.nativePnpmRoot, 'node'), 0o500)
  const changed = { ...runtime, root: { ...runtime.root, sha256: await hashLinuxRuntimeTree(runtime.root.path) } }
  await expect(verifyLinuxRuntime(changed)).rejects.toThrow('release Node differs')
})
