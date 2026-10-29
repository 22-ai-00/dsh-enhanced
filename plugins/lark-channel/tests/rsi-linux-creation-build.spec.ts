import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { RsiLinuxCgroupUnavailableError } from '../src/rsi-linux-cgroup-roots.js'
import { LinuxRsiRuntimeUnavailableError } from '../src/rsi-linux-runtime-bootstrap.js'
import { prepareLinuxRsiCreationBuildEnvironment, readLinuxRsiCreationBuildEnvironment,
  RsiLinuxCreationBuildUnavailableError, type LinuxRsiCreationPrepareInput } from '../src/rsi-linux-creation-build.js'

const mocks = vi.hoisted(() => ({
  repository: vi.fn(), cgroup: vi.fn(), prepareBehavior: vi.fn(), deployment: vi.fn(), behaviorDigest: vi.fn(),
}))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => Object.assign(
    () => ({ prepareLinuxPluginBehaviorRuntime: mocks.prepareBehavior,
      readLinuxPluginBehaviorDeploymentPreparation: mocks.deployment,
      linuxPluginBehaviorRuntimeDigest: mocks.behaviorDigest }),
    { resolve: (specifier: string) => specifier }),
}))
vi.mock('../src/rsi-linux-repository-bootstrap.js', () => ({ prepareLinuxRsiRepositoryRuntime: mocks.repository }))
vi.mock('../src/rsi-linux-cgroup-roots.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/rsi-linux-cgroup-roots.js')>(),
  discoverLinuxCgroupRoots: mocks.cgroup,
}))

const directories: string[] = []
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const cgroupRoots = () => ({ mode: 'v1' as const,
  cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${process.getuid!()}`,
  memory: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid!()}`,
  pids: `/sys/fs/cgroup/pids/dsh-native/uid-${process.getuid!()}`,
  freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${process.getuid!()}` })
const behaviorFor = (runtime: LinuxRuntime): LinuxPluginBehaviorRuntime => ({ schemaVersion: 1, runtime,
  observer: { schemaVersion: 1, sourceSha256: 's'.repeat(64), workerSha256: 'w'.repeat(64),
    candidateSha256: 'c'.repeat(64), launcherSha256: 'l'.repeat(64),
    parentProtectSha256: 'p'.repeat(64), childProtectSha256: 'd'.repeat(64) } })

interface Context {
  input: LinuxRsiCreationPrepareInput
  parent: string
  final: string
  behaviorRoot: string
  repository: { schemaVersion: 4; backend: 'linux-native'; sourceCommit: string; lockSha256: string
    runtime: LinuxRuntime; systemSnapshot: Record<string, unknown>; userNamespace: Record<string, unknown> }
  roots: ReturnType<typeof cgroupRoots>
}

async function fixture(): Promise<Context> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'dsh-linux-creation-test-'))
  directories.push(parent)
  const home = join(parent, 'home'), base = join(parent, 'base'), stateRoot = join(home, 'rsi-authorities', 'unit', 'state')
  await mkdir(stateRoot, { recursive: true, mode: 0o700 }); await chmod(home, 0o700)
  const write = async (name: string, content: string, mode = 0o600): Promise<void> => {
    const path = join(base, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode })
  }
  const node = '#!/bin/sh\necho v22.23.2\n'
  await write('bin/node', node, 0o500); await write('pnpm-native/node', node, 0o500)
  await write('pnpm-native/pnpm', '#!/bin/sh\necho 11.7.0\n', 0o500)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm/bin/pnpm.mjs', 'fixture-pnpm'); await write('pnpm-lock.yaml', 'fixture-lock')
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt'])
    await write(`node_modules/${name}/package.json`, '{"version":"1.0.0"}')
  await write('store/data', 'retained-store'); await write('cache/data', 'retained-cache')
  const info = await lstat(base)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: sha('fixture-lock'), root: { path: base, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(base) },
    nodePath: join(base, 'bin/node'), nodeSha256: sha(node), pnpmPath: join(base, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(base, 'pnpm-native'), nativePnpmPath: join(base, 'pnpm-native/pnpm'), modulesPath: join(base, 'node_modules'),
    storePath: join(base, 'store'), cachePath: join(base, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
  const input: LinuxRsiCreationPrepareInput = { dshHome: home, profile: 'unit', stateRoot, source: { schemaVersion: 1, version: '0.1.65',
    origin: { kind: 'local-head', locator: parent, ref: 'HEAD' }, sourceCommit: runtime.sourceCommit, repository: parent,
    baseline: { ref: 'refs/dsh-source/repairs', remote: join(parent, 'release.git'), targetBranch: 'repairs', initialCommit: runtime.sourceCommit } } }
  const repository = { schemaVersion: 4 as const, backend: 'linux-native' as const, sourceCommit: runtime.sourceCommit,
    lockSha256: runtime.lockSha256, runtime,
    systemSnapshot: { schemaVersion: 1, root: { path: join(parent, 'system'), dev: 3, ino: 4, sha256: 't'.repeat(64) } },
    userNamespace: { schemaVersion: 1, ownerUid: process.getuid!(), ownerGid: process.getgid!() } }
  return { input, parent, final: join(home, 'rsi-linux-creation-builds', 'unit'),
    behaviorRoot: join(stateRoot, 'linux-creation-behavior'), repository, roots: cgroupRoots() }
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.prepareBehavior.mockImplementation(async ({ runtime, root }: { runtime: LinuxRuntime; root: string }) => {
    await mkdir(root, { recursive: true, mode: 0o700 }); return behaviorFor(runtime)
  })
  mocks.deployment.mockImplementation(async ({ runtime }: { runtime: LinuxPluginBehaviorRuntime }) => ({
    descriptor: runtime, baseRuntimeDigest: linuxRuntimeDigest(runtime.runtime),
    preparationDigest: sha(`prep:${JSON.stringify(runtime)}`) }))
  mocks.behaviorDigest.mockImplementation((value: LinuxPluginBehaviorRuntime) => sha(`behavior:${JSON.stringify(value)}`))
})
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

test.runIf(process.platform === 'linux')('prepares the shared behavior runtime once and replays the immutable receipt', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  const env = await prepareLinuxRsiCreationBuildEnvironment(ctx.input)
  expect(Object.keys(env).sort()).toEqual(['backend', 'behavior', 'cgroupRoots', 'schemaVersion', 'sourceCommit'])
  expect(env).toMatchObject({ schemaVersion: 3, backend: 'linux-native', sourceCommit: ctx.repository.sourceCommit })
  expect(env.behavior.runtime).toEqual(ctx.repository.runtime)
  expect((await lstat(ctx.final)).mode & 0o777).toBe(0o700)
  expect((await lstat(join(ctx.final, 'bootstrap.json'))).mode & 0o777).toBe(0o600)
  expect(await readdir(ctx.final)).toEqual(['bootstrap.json'])
  expect(mocks.prepareBehavior).toHaveBeenCalledTimes(1)
  expect(mocks.prepareBehavior.mock.calls[0]![0]!.root).toBe(ctx.behaviorRoot)
  expect((await lstat(ctx.behaviorRoot)).isDirectory()).toBe(true)
  // Replay re-runs repository and cgroup discovery but never recompiles or re-downloads.
  expect(await prepareLinuxRsiCreationBuildEnvironment(ctx.input)).toEqual(env)
  expect(await readLinuxRsiCreationBuildEnvironment(ctx.input)).toEqual(env)
  expect(mocks.repository).toHaveBeenCalledTimes(3); expect(mocks.cgroup).toHaveBeenCalledTimes(3)
  expect(mocks.prepareBehavior).toHaveBeenCalledTimes(1)
  expect(mocks.deployment).toHaveBeenCalledTimes(3)
  expect(await readdir(join(ctx.parent, 'home', 'rsi-linux-creation-builds'))).toEqual(['unit'])
})

test.runIf(process.platform === 'linux')('cgroup or repository drift invalidates the retained receipt', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  await prepareLinuxRsiCreationBuildEnvironment(ctx.input)
  mocks.cgroup.mockResolvedValueOnce({ ...ctx.roots, pids: `${ctx.roots.pids}-changed` })
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow('receipt differs')
  mocks.repository.mockResolvedValueOnce({ ...ctx.repository, lockSha256: sha('other-lock') })
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow('receipt differs')
  expect(mocks.prepareBehavior).toHaveBeenCalledTimes(1)
})

test.runIf(process.platform === 'linux')('a tampered receipt fails closed and keeps the behavior environment out of the projection', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  await prepareLinuxRsiCreationBuildEnvironment(ctx.input)
  const receiptPath = join(ctx.final, 'bootstrap.json')
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Record<string, unknown>
  await chmod(receiptPath, 0o600)
  await writeFile(receiptPath, JSON.stringify({ ...receipt, behaviorDigest: 'z'.repeat(64) }), { mode: 0o600 })
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow('receipt differs')
  await expect(readLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow('receipt differs')
})

test.runIf(process.platform === 'linux')('cgroup and fixed-runtime unavailability pass through as the same not-ready classes', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository)
  mocks.cgroup.mockRejectedValueOnce(new RsiLinuxCgroupUnavailableError('delegation missing; rerun x'))
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toBeInstanceOf(RsiLinuxCgroupUnavailableError)
  mocks.repository.mockReset()
  mocks.repository.mockRejectedValueOnce(new LinuxRsiRuntimeUnavailableError('fixed runtime digest differs'))
  mocks.cgroup.mockResolvedValue(ctx.roots)
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toBeInstanceOf(LinuxRsiRuntimeUnavailableError)
  expect(await readdir(join(ctx.parent, 'home', 'rsi-linux-creation-builds'))).toEqual([])
})

test.runIf(process.platform === 'linux')('missing compiler or subordinate allocations report not-ready without leaving a candidate', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  mocks.prepareBehavior.mockRejectedValueOnce(Object.assign(new Error('spawn /usr/bin/cc ENOENT'), { code: 'ENOENT' }))
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input))
    .rejects.toMatchObject({ name: 'Error', code: 'rsi-linux-creation-build-unavailable' })
  mocks.prepareBehavior.mockRejectedValueOnce(Object.assign(new Error('spawn /usr/bin/cc ENOENT'), { code: 'ENOENT' }))
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow(/compile Linux behavior runtime/u)
  mocks.repository.mockReset()
  mocks.repository.mockRejectedValueOnce(new Error('subordinate uid allocation is unavailable'))
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toBeInstanceOf(RsiLinuxCreationBuildUnavailableError)
  const builds = join(ctx.parent, 'home', 'rsi-linux-creation-builds')
  expect(await readdir(builds)).toEqual([])
})

test.runIf(process.platform === 'linux')('integrity and compiler exit failures stay hard errors and are not downgraded', async () => {
  const ctx = await fixture()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  mocks.prepareBehavior.mockRejectedValueOnce(new Error('compiler exit status 1'))
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).rejects.toThrow('compiler exit status 1')
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).resolves.toBeDefined()
})

test.runIf(process.platform === 'linux')('abort while compiling removes only the fresh stage and never publishes a receipt', async () => {
  const ctx = await fixture()
  const controller = new AbortController()
  mocks.repository.mockResolvedValue(ctx.repository); mocks.cgroup.mockResolvedValue(ctx.roots)
  mocks.prepareBehavior.mockImplementationOnce(async () => {
    controller.abort(new Error('cancelled creation build')); throw controller.signal.reason
  })
  await expect(prepareLinuxRsiCreationBuildEnvironment({ ...ctx.input, signal: controller.signal }))
    .rejects.toThrow('cancelled creation build')
  const builds = join(ctx.parent, 'home', 'rsi-linux-creation-builds')
  expect(await readdir(builds)).toEqual([])
  // A later unaborted run still converges.
  mocks.prepareBehavior.mockImplementation(async ({ runtime, root }: { runtime: LinuxRuntime; root: string }) => {
    await mkdir(root, { recursive: true, mode: 0o700 }); return behaviorFor(runtime)
  })
  await expect(prepareLinuxRsiCreationBuildEnvironment(ctx.input)).resolves.toBeDefined()
})

test.runIf(process.platform === 'linux')('a missing behavior peer is a fatal opt-in gap, not an environment not-ready result', async () => {
  const ctx = await fixture()
  vi.resetModules()
  vi.doMock('node:module', async importOriginal => ({ ...(await importOriginal<typeof import('node:module')>()),
    createRequire: () => Object.assign(() => ({}), { resolve: () => {
      const error = new Error("cannot find module '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'")
      ;(error as NodeJS.ErrnoException).code = 'MODULE_NOT_FOUND'; throw error
    } }) }))
  try {
    const mod = await import('../src/rsi-linux-creation-build.js')
    await expect(mod.prepareLinuxRsiCreationBuildEnvironment(ctx.input))
      .rejects.toThrow(/opted-in Linux plugin creation requires installed peer/u)
    await expect(mod.prepareLinuxRsiCreationBuildEnvironment(ctx.input))
      .rejects.not.toBeInstanceOf(RsiLinuxCreationBuildUnavailableError)
  } finally { vi.doUnmock('node:module'); vi.resetModules() }
})
