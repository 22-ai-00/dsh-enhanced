import { execFileSync } from 'node:child_process'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import type { LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { setTimeout as pause } from 'node:timers/promises'
import { prepareRsiSourceWorkspace } from '../src/rsi-source.js'
import { prepareLinuxRsiRuntime, readLinuxRsiRuntime } from '../src/rsi-linux-runtime-bootstrap.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

const archives = { nodeArchivePath: process.env.DSH_TEST_LINUX_NODE_ARCHIVE,
  pnpmArchivePath: process.env.DSH_TEST_LINUX_PNPM_ARCHIVE,
  pnpmExeArchivePath: process.env.DSH_TEST_LINUX_PNPM_EXE_ARCHIVE,
  pnpmNativeArchivePath: process.env.DSH_TEST_LINUX_PNPM_NATIVE_ARCHIVE }

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
