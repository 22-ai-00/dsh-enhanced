import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { setTimeout as pause } from 'node:timers/promises'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import { NODE_ARCHIVES, prepareLinuxRsiRuntime, readLinuxRsiRuntime } from '../src/rsi-linux-runtime-bootstrap.js'

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) }
})

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

const archives = { nodeArchivePath: process.env.DSH_TEST_LINUX_NODE_ARCHIVE,
  pnpmArchivePath: process.env.DSH_TEST_LINUX_PNPM_ARCHIVE,
  pnpmExeArchivePath: process.env.DSH_TEST_LINUX_PNPM_EXE_ARCHIVE,
  pnpmNativeArchivePath: process.env.DSH_TEST_LINUX_PNPM_NATIVE_ARCHIVE }

const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')

/** A real source receipt and real retained files exercise reader integrity;
 * the tiny version executables avoid downloading an official toolchain. */
async function retainedFixture(nodeVersion = 'v22.23.2', blockProbes = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'dsh-linux-runtime-reader-'))
  directories.push(root)
  const dshHome = join(root, 'home'), repository = join(root, 'source'), profile = 'reader-test'
  await mkdir(dshHome, { mode: 0o700 }); await mkdir(repository, { mode: 0o700 })
  const manifests = {
    'package.json': JSON.stringify({ name: 'dsh-enhanced', version: '0.1.65', packageManager: 'pnpm@11.7.0' }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\nimporters:\n  .: {}\n",
    'pnpm-workspace.yaml': 'packages: []\n',
  }
  for (const [name, bytes] of Object.entries(manifests)) await writeFile(join(repository, name), bytes)
  const git = (...args: string[]): void => { execFileSync('/usr/bin/git', ['-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd: repository, stdio: 'pipe' }) }
  git('init', '--initial-branch=main'); git('add', '.'); git('commit', '-m', 'reader fixture')
  const source = await prepareRsiSourceWorkspace({ dshHome, profile, version: '0.1.65', sourceRepository: repository })
  const family = join(dshHome, 'rsi-linux-runtimes'), final = join(family, profile), runtimeRoot = join(final, 'runtime')
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 })
  const write = async (name: string, bytes: string, mode = 0o600): Promise<void> => {
    await mkdir(dirname(join(runtimeRoot, name)), { recursive: true, mode: 0o700 })
    await writeFile(join(runtimeRoot, name), bytes, { mode })
  }
  const blockingProbe = '#!/usr/bin/python3\nimport signal\nsignal.pause()\n'
  const node = blockProbes ? blockingProbe : `#!/bin/sh\ncase "$1" in *pnpm.mjs) echo 11.7.0;; *) echo ${nodeVersion};; esac\n`
  await write('bin/node', node, 0o500); await write('pnpm-native/node', node, 0o500)
  await write('pnpm-native/pnpm', blockProbes ? blockingProbe : '#!/bin/sh\necho 11.7.0\n', 0o500)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm/bin/pnpm.mjs', 'fixture-pnpm')
  for (const [name, bytes] of Object.entries(manifests)) await write(name, bytes)
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt'])
    await write(`node_modules/${name}/package.json`, '{"version":"1.0.0"}')
  await write('store/data', 'retained-store'); await write('cache/data', 'retained-cache')
  const { hashLinuxRuntimeTree } = await import('@dsh-enhanced/assistant-isolation')
  const info = await lstat(runtimeRoot)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: source.sourceCommit, lockSha256: sha(manifests['pnpm-lock.yaml']),
    root: { path: runtimeRoot, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(runtimeRoot) },
    nodePath: join(runtimeRoot, 'bin/node'), nodeSha256: sha(node), pnpmPath: join(runtimeRoot, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(runtimeRoot, 'pnpm-native'), nativePnpmPath: join(runtimeRoot, 'pnpm-native/pnpm'),
    modulesPath: join(runtimeRoot, 'node_modules'), storePath: join(runtimeRoot, 'store'), cachePath: join(runtimeRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
  const content = { schemaVersion: 3, backend: 'linux-native', sourceCommit: source.sourceCommit,
    lockSha256: runtime.lockSha256, runtime, dshHome, profile,
    manifestHashes: Object.fromEntries(Object.entries(manifests).sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha(bytes)])),
    archives: { node: NODE_ARCHIVES[process.arch as 'x64' | 'arm64'],
      pnpm: 'deafa7ec98a1218b6a047289b92fbe2395c1e22d3495bb711653013218ee15ee',
      pnpmExe: '0424127c10888e17ebbb3cfc0be685b2a87079ca7bc372bec0036313e3f1b4d5',
      pnpmNative: process.arch === 'x64' ? '90a6f44ad45f9ceb815ce63c55568bd14b370247c394b97f6767ef59036aca0e'
        : 'b196d44af42ae26308b5ca145091ed2febd569e6590e906fe54a223222e1c348' } }
  await writeFile(join(final, 'bootstrap.json'), JSON.stringify({ ...content, receiptDigest: sha(JSON.stringify(content)) }), { mode: 0o600 })
  return { input: { dshHome, profile, source }, family, final, runtime,
    environment: { schemaVersion: 3, backend: 'linux-native', sourceCommit: source.sourceCommit, lockSha256: runtime.lockSha256, runtime } }
}

async function retainedIdentity(path: string): Promise<unknown[]> {
  const entries: unknown[] = []
  const visit = async (current: string): Promise<void> => {
    const info = await lstat(current, { bigint: true })
    entries.push([current, String(info.dev), String(info.ino), String(info.mode), String(info.mtimeNs), String(info.ctimeNs),
      info.isFile() ? sha(await readFile(current)) : undefined])
    if (info.isDirectory()) for (const name of (await readdir(current)).sort()) await visit(join(current, name))
  }
  await visit(path)
  return entries
}

test.runIf(process.platform === 'linux')('base reader rejects a missing family without running preparation doctor or recreating it', async () => {
  const ctx = await retainedFixture()
  await rm(ctx.family, { recursive: true })
  vi.mocked(spawnSync).mockClear()
  await expect(readLinuxRsiRuntime(ctx.input)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(ctx.family)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(vi.mocked(spawnSync).mock.calls).toEqual([])
})

test.runIf(process.platform === 'linux')('base reader reopens exact retained identity without doctor, archives or file rewrites', async () => {
  const ctx = await retainedFixture(), before = await retainedIdentity(ctx.family)
  vi.mocked(spawnSync).mockClear()
  const input = { ...ctx.input, nodeArchivePath: '/missing/node.tgz', pnpmArchivePath: '/missing/pnpm.tgz',
    pnpmExeArchivePath: '/missing/exe.tgz', pnpmNativeArchivePath: '/missing/native.tgz' }
  expect(await readLinuxRsiRuntime(input)).toEqual(ctx.environment)
  expect(await readLinuxRsiRuntime(input)).toEqual(ctx.environment)
  expect(await retainedIdentity(ctx.family)).toEqual(before)
  expect(vi.mocked(spawnSync).mock.calls.length).toBeGreaterThan(0)
  expect(vi.mocked(spawnSync).mock.calls.every(([file]) => file === '/usr/bin/git')).toBe(true)
})

test.runIf(process.platform === 'linux')('base reader rejects damaged receipt and runtime bytes without repairing them', async () => {
  const ctx = await retainedFixture(), receipt = join(ctx.final, 'bootstrap.json')
  await chmod(receipt, 0o644)
  let before = await retainedIdentity(ctx.family)
  await expect(readLinuxRsiRuntime(ctx.input)).rejects.toThrow('receipt unsafe')
  expect(await retainedIdentity(ctx.family)).toEqual(before)
  await chmod(receipt, 0o600)
  await writeFile(join(ctx.runtime.storePath, 'data'), 'tampered-store')
  before = await retainedIdentity(ctx.family)
  await expect(readLinuxRsiRuntime(ctx.input)).rejects.toThrow('root differs')
  expect(await retainedIdentity(ctx.family)).toEqual(before)
})

test.runIf(process.platform === 'linux')('base reader still runs pinned executable integrity probes', async () => {
  const ctx = await retainedFixture('v99.0.0'), before = await retainedIdentity(ctx.family)
  await expect(readLinuxRsiRuntime(ctx.input)).rejects.toThrow('executable version differs')
  expect(await retainedIdentity(ctx.family)).toEqual(before)
})

test.runIf(process.platform === 'linux')('pre-cancelled base read preserves the retained family without starting verification', async () => {
  const ctx = await retainedFixture(), before = await retainedIdentity(ctx.family)
  const controller = new AbortController(), reason = new Error('cancelled before retained read')
  controller.abort(reason)
  vi.mocked(spawnSync).mockClear()
  await expect(readLinuxRsiRuntime({ ...ctx.input, signal: controller.signal })).rejects.toBe(reason)
  expect(vi.mocked(spawnSync).mock.calls).toEqual([])
  expect(await retainedIdentity(ctx.family)).toEqual(before)
})

test.runIf(process.platform === 'linux')('cancelling retained runtime verification kills real version probes without writes or rebuilding', async () => {
  const ctx = await retainedFixture('v22.23.2', true), before = await retainedIdentity(ctx.family)
  const controller = new AbortController(), probes = new Set<number>()
  let ended = false
  const pending = readLinuxRsiRuntime({ ...ctx.input, signal: controller.signal })
    .then(value => { ended = true; return { value, error: undefined } },
      (error: unknown) => { ended = true; return { value: undefined, error } })
  const live = async (pid: number): Promise<boolean> => lstat(`/proc/${pid}`)
    .then(() => true, error => { if (error.code === 'ENOENT' || error.code === 'ESRCH') return false; throw error })
  vi.mocked(spawnSync).mockClear()
  try {
    const deadline = Date.now() + 3000
    while (!ended && probes.size < 4 && Date.now() < deadline) {
      const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8'))
        .trim().split(/\s+/u).filter(Boolean).map(Number)
      for (const pid of children) {
        const command = await readFile(`/proc/${pid}/cmdline`, 'utf8')
          .catch(error => { if (error.code === 'ENOENT' || error.code === 'ESRCH') return ''; throw error })
        if (command.includes(ctx.runtime.root.path) && command.includes('\0--version\0')) probes.add(pid)
      }
      if (probes.size < 4) await pause(5)
    }
    expect(probes.size, 'the public integrity verifier must start all four real pinned version probes').toBe(4)
    const cancelledAt = Date.now()
    controller.abort(new Error('cancelled during retained integrity verification'))
    const result = await pending
    expect(result.value).toBeUndefined()
    expect(result.error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' })
    const cleanupDeadline = Date.now() + 3000
    let alive = await Promise.all([...probes].map(live))
    while (alive.some(Boolean) && Date.now() < cleanupDeadline) {
      await pause(5); alive = await Promise.all([...probes].map(live))
    }
    expect(alive).toEqual([false, false, false, false])
    expect(Date.now() - cancelledAt).toBeLessThan(3000)
    expect(await retainedIdentity(ctx.family)).toEqual(before)
    expect(vi.mocked(spawnSync).mock.calls.every(([file]) => file === '/usr/bin/git')).toBe(true)
  } finally { controller.abort(); await pending }
})

async function freshOfflineInstall(root: string, runtime: LinuxRuntime, repository: string, commit: string): Promise<void> {
  const offline = join(root, 'offline-consumer'), workspace = join(offline, 'workspace')
  const store = join(offline, 'store'), cache = join(offline, 'cache')
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await mkdir(join(offline, 'home'), { mode: 0o700 })
  const files = execFileSync('/usr/bin/git', ['ls-tree', '-r', '--name-only', commit],
    { cwd: repository, encoding: 'utf8' }).trim().split('\n').filter(path =>
    ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'].includes(path)
      || /^(?:packages|plugins)\/[a-z0-9-]+\/package\.json$/u.test(path))
  for (const file of files) {
    await mkdir(dirname(join(workspace, file)), { recursive: true, mode: 0o700 })
    await copyFile(join(runtime.root.path, file), join(workspace, file))
  }
  await expect(lstat(join(workspace, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
  // SQLite store indexes and pnpm's project registry are writable job state.
  // A real consumer gets copies; reading or installing cannot mutate the pins.
  await cp(runtime.storePath, store, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  await cp(runtime.cachePath, cache, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
  expect((await readdir(cache)).length).toBeGreaterThan(0)
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', LANG: 'C', LC_ALL: 'C' }
  const command = ['/usr/bin/bwrap', '--unshare-all', '--ro-bind', '/usr', '/usr', '--ro-bind', '/lib', '/lib',
    ...(process.arch === 'x64' ? ['--ro-bind', '/lib64', '/lib64'] : []), '--symlink', 'usr/bin', '/bin',
    '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp',
    '--ro-bind', runtime.root.path, '/runtime', '--bind', offline, '/consumer', '--chdir', '/consumer/workspace',
    '--clearenv', '--setenv', 'PATH', '/runtime/pnpm-native:/usr/bin:/bin', '--setenv', 'HOME', '/consumer/home',
    '--setenv', 'LANG', 'C', '--setenv', 'LC_ALL', 'C', '--setenv', 'CI', 'true',
    '--setenv', 'npm_config_userconfig', '/dev/null', '--setenv', 'npm_config_globalconfig', '/dev/null',
    '--setenv', 'npm_config_registry', 'https://registry.npmjs.org/',
    '--setenv', 'pnpm_config_cache_dir', '/consumer/cache', '--setenv', 'npm_config_cache_dir', '/consumer/cache',
    '/runtime/pnpm-native/pnpm', 'install', '--offline', '--frozen-lockfile', '--ignore-scripts',
    '--store-dir', '/consumer/store', '--cache-dir', '/consumer/cache',
    '--config.package-import-method=copy', '--reporter=append-only']
  const output = execFileSync(command[0]!, command.slice(1), { env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16_777_216 })
  process.stdout.write(`Fresh frozen install in network namespace, from retained store/cache only:\n${output}`)
  expect((await lstat(join(workspace, 'node_modules'))).isDirectory()).toBe(true)
  expect(await readFile(join(workspace, 'pnpm-lock.yaml'))).toEqual(await readFile(join(runtime.root.path, 'pnpm-lock.yaml')))
  expect(await readFile(join(workspace, 'pnpm-workspace.yaml'))).toEqual(await readFile(join(runtime.root.path, 'pnpm-workspace.yaml')))
  await expect(lstat(join(offline, 'home', '.cache', 'pnpm'))).rejects.toMatchObject({ code: 'ENOENT' })
  // This is the layout the existing release adapter binds as pnpmRoot.
  expect(execFileSync(join(runtime.nativePnpmRoot, 'node'), ['--version'], { env, encoding: 'utf8' }).trim()).toBe('v22.23.2')
  expect(execFileSync(runtime.nativePnpmPath, ['--version'], { env, encoding: 'utf8' }).trim()).toBe('11.7.0')
}

test.runIf(process.platform === 'linux' && Object.values(archives).every(Boolean))(
  'prepares the complete frozen runtime from pinned archives, reuses it, and refuses drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-linux-bootstrap-'))
    directories.push(root)
    const dshHome = join(root, 'home'), profile = 'runtime-test'
    await mkdir(dshHome, { mode: 0o700 })
    const repository = resolve(import.meta.dirname, '../../..')
    const version = JSON.parse(execFileSync('/usr/bin/git', ['show', 'HEAD:package.json'],
      { cwd: repository, encoding: 'utf8' })).version as string
    const source = await prepareRsiSourceWorkspace({ dshHome, profile, version, sourceRepository: repository })
    const input = { dshHome, profile, source, nodeArchivePath: archives.nodeArchivePath!,
      pnpmArchivePath: archives.pnpmArchivePath!, pnpmExeArchivePath: archives.pnpmExeArchivePath!,
      pnpmNativeArchivePath: archives.pnpmNativeArchivePath! }
    const stopped = new AbortController()
    stopped.abort()
    await expect(prepareLinuxRsiRuntime({ ...input, signal: stopped.signal })).rejects.toThrow()
    await expect(lstat(join(dshHome, 'rsi-linux-runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
    const wrongArchive = join(root, 'wrong-node.tgz')
    await writeFile(wrongArchive, 'not an official archive')
    await expect(prepareLinuxRsiRuntime({ ...input, nodeArchivePath: wrongArchive }))
      .rejects.toThrow('official archive digest differs')
    const first = await prepareLinuxRsiRuntime(input)
    expect(first).toMatchObject({ schemaVersion: 3, backend: 'linux-native', sourceCommit: source.sourceCommit,
      runtime: { backend: 'linux-native', versions: { node: 'v22.23.2', pnpm: '11.7.0' } } })
    expect(await prepareLinuxRsiRuntime(input)).toEqual(first)
    expect(await readLinuxRsiRuntime(input)).toEqual(first)
    const runtimeRoot = first.runtime.root.path
    await expect(lstat(join(runtimeRoot, '.npmrc'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(runtimeRoot, 'plugins', 'lark-channel', 'src'))).rejects.toMatchObject({ code: 'ENOENT' })
    await freshOfflineInstall(root, first.runtime, source.repository, source.sourceCommit)
    expect(await readLinuxRsiRuntime(input)).toEqual(first)
    const receiptPath = join(dshHome, 'rsi-linux-runtimes', profile, 'bootstrap.json')
    await chmod(receiptPath, 0o644)
    await expect(readLinuxRsiRuntime(input)).rejects.toThrow('receipt unsafe')
    await chmod(receiptPath, 0o600)
    expect(await readLinuxRsiRuntime(input)).toEqual(first)
    const manifestPath = join(runtimeRoot, 'package.json')
    const original = await readFile(manifestPath)
    await writeFile(manifestPath, Buffer.concat([original, Buffer.from('changed')]))
    await expect(readLinuxRsiRuntime(input)).rejects.toThrow()
    await writeFile(manifestPath, original)
    expect(await readLinuxRsiRuntime(input)).toEqual(first)
    await rm(manifestPath)
    await expect(prepareLinuxRsiRuntime(input)).rejects.toThrow()
  }, 1_200_000)

test.runIf(process.platform === 'linux' && Object.values(archives).every(Boolean))(
  'cancels a real preparation subprocess and removes its private incomplete stage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-linux-bootstrap-cancel-'))
    directories.push(root)
    const dshHome = join(root, 'home'), profile = 'cancel-test'
    await mkdir(dshHome, { mode: 0o700 })
    const repository = resolve(import.meta.dirname, '../../..')
    const version = JSON.parse(execFileSync('/usr/bin/git', ['show', 'HEAD:package.json'],
      { cwd: repository, encoding: 'utf8' })).version as string
    const source = await prepareRsiSourceWorkspace({ dshHome, profile, version, sourceRepository: repository })
    const controller = new AbortController()
    const pending = prepareLinuxRsiRuntime({ dshHome, profile, source, signal: controller.signal,
      nodeArchivePath: archives.nodeArchivePath!, pnpmArchivePath: archives.pnpmArchivePath!,
      pnpmExeArchivePath: archives.pnpmExeArchivePath!, pnpmNativeArchivePath: archives.pnpmNativeArchivePath! })
      .then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }))
    let observedPid: number | undefined
    const deadline = Date.now() + 30_000
    try {
      while (Date.now() < deadline && observedPid === undefined) {
        const children = (await readFile(`/proc/${process.pid}/task/${process.pid}/children`, 'utf8'))
          .trim().split(/\s+/u).filter(Boolean).map(Number)
        for (const pid of children) {
          const command = await readFile(`/proc/${pid}/cmdline`, 'utf8')
            .catch(error => { if (error.code === 'ENOENT' || error.code === 'ESRCH') return ''; throw error })
          if (command.includes(dshHome) && command.includes('/runtime/pnpm/bin/pnpm.mjs') && command.includes('\0fetch\0')) {
            observedPid = pid
            break
          }
        }
        if (observedPid === undefined) await pause(10)
      }
      expect(observedPid, 'a real preparation fetch process must be observed before cancellation').toBeDefined()
      const cancelledAt = Date.now()
      controller.abort()
      const result = await pending
      expect(result.value).toBeUndefined()
      expect(result.error).toBeInstanceOf(Error)
      expect(Date.now() - cancelledAt).toBeLessThan(5_000)
      await expect(lstat(`/proc/${observedPid}`)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(join(dshHome, 'rsi-linux-runtimes'))).toEqual([])
      process.stdout.write('Observed a real preparation fetch process; abort reaped it and removed the incomplete stage within 5s.\n')
    } finally { controller.abort(); await pending }
  }, 60_000)
