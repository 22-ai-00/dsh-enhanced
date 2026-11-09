import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { prepareRsiReleaseBuildEnvironment, readRsiReleaseBuildEnvironment } from '../src/rsi-release-build.js'
import type { LinuxRsiBuildEnvironment } from '../src/rsi-linux-runtime-bootstrap.js'

const roots: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
/** Minimal schema 3 Linux runtime that survives verifyLinuxRuntime(): shell
 * stubs stand in for the pinned Node/pnpm ELFs, and the whole-tree digest is
 * computed exactly as production does. */
async function nativeFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-release-native-'))); roots.push(root)
  const home = join(root, 'home'), runtimeRoot = join(root, 'runtime')
  await mkdir(home, { recursive: true, mode: 0o700 }); await mkdir(runtimeRoot, { mode: 0o700 })
  const write = async (name: string, content: string, mode = 0o600): Promise<void> => {
    const path = join(runtimeRoot, name)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, content, { mode })
  }
  const node = '#!/bin/sh\ncase "$1" in *pnpm.mjs) printf "11.7.0\\n";; *) printf "v22.23.2\\n";; esac\n'
  await write('bin/node', node, 0o700)
  await write('pnpm-native/node', node, 0o700)
  await write('pnpm-native/pnpm', '#!/bin/sh\nprintf "11.7.0\\n"\n', 0o700)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm/bin/pnpm.mjs', "process.stdout.write('11.7.0\\n')\n")
  await write('pnpm-lock.yaml', 'fixture-lock')
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) {
    await write(`node_modules/${name}/package.json`, '{"version":"1.0.0"}')
  }
  await write('store/v11/index.db', 'store-content')
  await write('store/v11/files/placeholder', 'store-file')
  await write('cache/metadata.json', '{"policy":"retained"}')
  const info = await lstat(runtimeRoot)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native',
    platform: `linux-${process.arch}` as LinuxRuntime['platform'], sourceCommit: 'a'.repeat(40),
    lockSha256: digest('fixture-lock'),
    root: { path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(runtimeRoot) },
    nodePath: join(runtimeRoot, 'bin', 'node'), nodeSha256: digest(node),
    pnpmPath: join(runtimeRoot, 'pnpm', 'bin', 'pnpm.mjs'),
    nativePnpmRoot: join(runtimeRoot, 'pnpm-native'), nativePnpmPath: join(runtimeRoot, 'pnpm-native', 'pnpm'),
    modulesPath: join(runtimeRoot, 'node_modules'), storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
  const build: LinuxRsiBuildEnvironment = { schemaVersion: 3, backend: 'linux-native',
    sourceCommit: 'a'.repeat(40), lockSha256: runtime.lockSha256, runtime }
  const args = { dshHome: home, profile: 'owner', build }
  return { root, home, runtime, runtimeRoot, build, args, final: join(home, 'rsi-release-builds', 'owner') }
}

const supported = process.platform === 'linux' && process.arch === 'x64' && existsSync('/usr/bin/bwrap') && existsSync('/usr/bin/tar')
describe.skipIf(!supported)('native release build preparation', () => {
  test('copies the three pinned trees from the verified runtime without Docker and replays', async () => {
    const f = await nativeFixture()
    const result = await prepareRsiReleaseBuildEnvironment(f.args)
    expect(result).toMatchObject({ schemaVersion: 2, backend: 'linux-native', sourceCommit: 'a'.repeat(40),
      runtimeDigest: linuxRuntimeDigest(f.runtime) })
    expect('image' in result).toBe(false)
    expect(result.releaseBuild.pnpmRoot.path).toBe(join(f.final, 'toolchain'))
    expect(result.releaseBuild.nodeExecutable.path).toBe(join(f.final, 'toolchain', 'node'))
    expect(result.releaseBuild.pnpmExecutable.path).toBe(join(f.final, 'toolchain', 'pnpm'))
    expect(result.releaseBuild.storeRoot.path).toBe(join(f.final, 'store'))
    expect(result.releaseBuild.cacheRoot.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect((await lstat(join(f.final, 'cache', 'metadata.json'))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(f.final, 'toolchain', 'node'))).mode & 0o777).toBe(0o700)
    expect((await lstat(join(f.final, 'toolchain', 'pnpm'))).mode & 0o777).toBe(0o700)
    expect((await lstat(join(f.final, 'bootstrap.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(join(f.final, 'store', 'v11', 'projects'))).toEqual([])
    expect(await prepareRsiReleaseBuildEnvironment(f.args)).toEqual(result)
    expect(await readRsiReleaseBuildEnvironment(f.args)).toEqual(result)
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual(['owner'])
  })

  test('native read-only inspection never copies or repairs missing resources', async () => {
    const f = await nativeFixture()
    await expect(readRsiReleaseBuildEnvironment(f.args)).rejects.toThrow()
    await expect(lstat(join(f.home, 'rsi-release-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
    await prepareRsiReleaseBuildEnvironment(f.args)
    await rm(join(f.final, 'store'), { recursive: true })
    await expect(readRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('incomplete')
    await expect(lstat(join(f.final, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('a historical Docker plan is rejected and never migrated implicitly', async () => {
    const native = await nativeFixture()
    const legacy = { schemaVersion: 1 as const, sourceCommit: 'a'.repeat(40), sourceBuild: {
      dockerPath: '/usr/bin/docker', image: `sha256:${'b'.repeat(64)}`, timeoutMs: 1_800_000,
      memoryMiB: 16_384, cpus: 8, pidsLimit: 1024, workspaceMiB: 4096, temporaryMiB: 2048, outputBytes: 65_536 } }
    await expect(prepareRsiReleaseBuildEnvironment({ ...native.args, build: legacy }))
      .rejects.toThrow('no longer supported')
    await prepareRsiReleaseBuildEnvironment(native.args)
    await expect(readRsiReleaseBuildEnvironment({ ...native.args, build: legacy }))
      .rejects.toThrow('differs from its receipt')
  })

  test('runtime tree drift is rejected before any tree is published', async () => {
    const f = await nativeFixture()
    await writeFile(join(f.runtimeRoot, 'cache', 'metadata.json'), '{"policy":"drifted"}', { mode: 0o600 })
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('Linux runtime root differs')
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual([])
    // The failed attempt must not leave a half-published environment to resume.
    await expect(lstat(join(f.home, 'rsi-release-builds', 'owner'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('an escaping link in the runtime is rejected without following it into the host', async () => {
    const f = await nativeFixture()
    await symlink('/etc/passwd', join(f.runtimeRoot, 'cache', 'linked'))
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow(/link escaped root|unsafe entry/u)
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual([])
  })
})
