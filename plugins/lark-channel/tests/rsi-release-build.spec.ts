import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { prepareRsiReleaseBuildEnvironment, readRsiReleaseBuildEnvironment } from '../src/rsi-release-build.js'
import type { RsiBuildEnvironment } from '../src/rsi-build.js'
import type { LinuxRsiBuildEnvironment } from '../src/rsi-linux-runtime-bootstrap.js'

const roots: string[] = []
const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rsi-release-build-'))); roots.push(root)
  const home = join(root, 'home'), seed = join(root, 'seed'), docker = join(root, 'docker')
  const calls = join(root, 'calls'), state = join(root, 'state'), mode = join(root, 'mode')
  for (const path of [home, join(seed, 'toolchain'), join(seed, 'store', 'v11', 'files'), join(seed, 'cache')]) {
    await mkdir(path, { recursive: true, mode: 0o700 })
  }
  await writeFile(join(seed, 'toolchain', 'package.json'), '{"version":"11.7.0"}')
  await writeFile(join(seed, 'toolchain', 'pnpm'), '#!/bin/sh\nprintf "11.7.0\\n"\n', { mode: 0o700 })
  await writeFile(join(seed, 'node'), '#!/bin/sh\nprintf "v22.23.2\\n"\n', { mode: 0o700 })
  await writeFile(join(seed, 'store', 'v11', 'index.db'), 'store-content')
  await mkdir(join(seed, 'store', 'v11', 'projects'))
  await symlink('../../../../seed', join(seed, 'store', 'v11', 'projects', 'image-project'))
  await writeFile(join(seed, 'cache', 'metadata.json'), '{"policy":"retained"}')
  await writeFile(mode, 'ready')
  await writeFile(docker, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2)
const calls=${JSON.stringify(calls)}, state=${JSON.stringify(state)}, seed=${JSON.stringify(seed)}
const mode=fs.readFileSync(${JSON.stringify(mode)},'utf8')
if (!fs.statSync(process.env.DOCKER_CONFIG).isDirectory() || process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT) process.exit(91)
fs.appendFileSync(calls, JSON.stringify(args)+'\\n')
if(args[0]==='create'){fs.writeFileSync(state,JSON.stringify({label:args[args.indexOf('--label')+1].split('=')[1]}));console.log('container-id')}
else if(args[0]==='cp') {
  if(mode==='fail')process.exit(5)
  if(mode==='wait'){setTimeout(()=>process.exit(0),30000)}
  else {
    const from=args[1].split(':').slice(1).join(':')
    const source=from.includes('pnpm-native')?'toolchain':from.endsWith('index.db')?'store/v11/index.db':from.includes('pnpm-store')?'store/v11/files':from.includes('pnpm-cache')?'cache':'node'
    if(source==='node'||source.endsWith('index.db'))fs.copyFileSync(path.join(seed,source),args[2])
    else fs.cpSync(path.join(seed,source),args[2],{recursive:true,verbatimSymlinks:true})
  }
}
else if(args[0]==='ps'){if(fs.existsSync(state))console.log('container-id')}
else if(args[0]==='inspect'){console.log(JSON.parse(fs.readFileSync(state)).label)}
else if(args[0]==='rm'){fs.rmSync(state);console.log('removed')}
else process.exit(90)
`, { mode: 0o700 })
  await chmod(docker, 0o700)
  const build: RsiBuildEnvironment = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), sourceBuild: {
    dockerPath: docker, image: `sha256:${'b'.repeat(64)}`, timeoutMs: 1_800_000,
    memoryMiB: 16_384, cpus: 8, pidsLimit: 1024, workspaceMiB: 4096, temporaryMiB: 2048, outputBytes: 65_536,
  } }
  return { root, home, seed, calls, state, mode, args: { dshHome: home, profile: 'owner', build },
    final: join(home, 'rsi-release-builds', 'owner') }
}
async function readCalls(path: string): Promise<string[][]> {
  return (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
}
const supported = process.platform === 'linux' && process.arch === 'x64' && existsSync('/usr/bin/bwrap') && existsSync('/usr/bin/tar')
describe.skipIf(!supported)('private release build preparation', () => {
  test('read-only inspection never exports or repairs missing resources', async () => {
    const f = await fixture()
    await expect(readRsiReleaseBuildEnvironment(f.args)).rejects.toThrow()
    await expect(lstat(join(f.home, 'rsi-release-builds'))).rejects.toMatchObject({ code: 'ENOENT' })
    const prepared = await prepareRsiReleaseBuildEnvironment(f.args)
    const before = await readFile(f.calls)
    expect(await readRsiReleaseBuildEnvironment(f.args)).toEqual(prepared)
    await rm(join(f.final, 'store'), { recursive: true })
    await expect(readRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('incomplete')
    expect(await readFile(f.calls)).toEqual(before)
    await expect(lstat(join(f.final, 'store'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('exports fixed image assets without starting a container, pins them through the real adapter, and replays', async () => {
    const f = await fixture()
    const result = await prepareRsiReleaseBuildEnvironment(f.args)
    expect(result.releaseBuild.pnpmRoot.path).toBe(join(f.final, 'toolchain'))
    expect(result.releaseBuild.cacheRoot.sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect((await lstat(join(f.final, 'cache', 'metadata.json'))).mode & 0o777).toBe(0o600)
    expect((await lstat(join(f.final, 'toolchain', 'node'))).mode & 0o777).toBe(0o700)
    expect((await lstat(join(f.final, 'bootstrap.json'))).mode & 0o777).toBe(0o600)
    expect(await prepareRsiReleaseBuildEnvironment(f.args)).toEqual(result)
    const calls = await readCalls(f.calls)
    expect(calls.filter(args => args[0] === 'create')).toHaveLength(1)
    expect(calls.filter(args => args[0] === 'cp')).toHaveLength(5)
    expect(await readdir(join(f.final, 'store', 'v11', 'projects'))).toEqual([])
    expect(calls.some(args => args[0] === 'start' || args[0] === 'run')).toBe(false)
    expect(calls[0]).toContain(f.args.build.sourceBuild.image)
    await expect(lstat(f.state)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual(['owner'])
  })

  test('refuses cache drift and changed source without replacing registered resources', async () => {
    const f = await fixture()
    await prepareRsiReleaseBuildEnvironment(f.args)
    await expect(prepareRsiReleaseBuildEnvironment({ ...f.args, build: { ...f.args.build, sourceCommit: 'c'.repeat(40) } }))
      .rejects.toThrow('differs from its receipt')
    await writeFile(join(f.final, 'cache', 'metadata.json'), 'drift')
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('differs from its receipt')
    expect((await readCalls(f.calls)).filter(args => args[0] === 'create')).toHaveLength(1)
  })

  test('a missing child is not treated as a new environment', async () => {
    const f = await fixture()
    await prepareRsiReleaseBuildEnvironment(f.args)
    await rm(join(f.final, 'store'), { recursive: true })
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('incomplete')
    expect((await readCalls(f.calls)).filter(args => args[0] === 'create')).toHaveLength(1)
  })

  test('failed export removes the owned container and staging without publishing', async () => {
    const f = await fixture()
    await writeFile(f.mode, 'fail')
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('subprocess failed')
    await expect(lstat(f.state)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual([])
  })

  test('rejects a linked export without following it into the host', async () => {
    const f = await fixture()
    await symlink('/etc/passwd', join(f.seed, 'cache', 'linked'))
    await expect(prepareRsiReleaseBuildEnvironment(f.args)).rejects.toThrow('unsafe entry')
    await expect(lstat(f.state)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual([])
  })

  test('cancellation drains export and still cleans the unstarted container', async () => {
    const f = await fixture(), controller = new AbortController()
    await writeFile(f.mode, 'wait')
    const timer = setTimeout(() => controller.abort(), 500)
    try { await expect(prepareRsiReleaseBuildEnvironment({ ...f.args, signal: controller.signal })).rejects.toThrow() }
    finally { clearTimeout(timer) }
    await expect(lstat(f.state)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(f.home, 'rsi-release-builds'))).toEqual([])
  })
})

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

  test('a docker plan can never be continued by a native receipt and vice versa', async () => {
    const docker = await fixture(), native = await nativeFixture()
    await prepareRsiReleaseBuildEnvironment(docker.args)
    await prepareRsiReleaseBuildEnvironment(native.args)
    await expect(readRsiReleaseBuildEnvironment({ ...native.args, build: docker.args.build }))
      .rejects.toThrow('differs from its receipt')
    await expect(readRsiReleaseBuildEnvironment({ ...docker.args, build: native.build }))
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
