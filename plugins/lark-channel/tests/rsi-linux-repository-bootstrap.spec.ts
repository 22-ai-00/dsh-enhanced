import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { LinuxRuntime, LinuxSystemSnapshot, LinuxUserNamespaceMapping } from '@dsh-enhanced/assistant-isolation'
import type { LinuxRsiBootstrapInput } from '../src/rsi-linux-runtime-bootstrap.js'

const mocks = vi.hoisted(() => ({ base: vi.fn(), readBase: vi.fn(), archive: vi.fn(), snapshot: vi.fn(), mapping: vi.fn(), verifyMapping: vi.fn(), abi: vi.fn() }))
vi.mock('@dsh-enhanced/assistant-isolation', async importOriginal => ({
  ...await importOriginal<typeof import('@dsh-enhanced/assistant-isolation')>(),
  prepareLinuxSystemSnapshot: mocks.snapshot,
  readLinuxUserNamespaceMapping: mocks.mapping,
  verifyLinuxUserNamespaceMapping: mocks.verifyMapping,
  verifyLinuxSystemSnapshotRuntimeDependencies: mocks.abi,
}))
vi.mock('../src/rsi-linux-runtime-bootstrap.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/rsi-linux-runtime-bootstrap.js')>(),
  prepareLinuxRsiRuntime: mocks.base, readLinuxRsiRuntime: mocks.readBase, officialArchive: mocks.archive,
}))
import { hashLinuxRuntimeTree, verifyLinuxRuntime, verifyLinuxSystemSnapshot } from '@dsh-enhanced/assistant-isolation'
import { prepareLinuxRsiRepositoryRuntime, readLinuxRsiRepositoryRuntime } from '../src/rsi-linux-repository-bootstrap.js'

const directories: string[] = []
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const mapping: LinuxUserNamespaceMapping = { schemaVersion: 1, ownerUid: process.getuid!(), ownerGid: process.getgid!(), candidateUid: 100000,
  candidateGid: 100000, hostNamespace: { dev: 1, ino: 2 }, helpers: { uid: { path: '/usr/bin/newuidmap', sha256: 'a'.repeat(64) },
    gid: { path: '/usr/bin/newgidmap', sha256: 'b'.repeat(64) } } }

async function snapshotFixture(root: string): Promise<LinuxSystemSnapshot> {
  await mkdir(root, { mode: 0o755 }); await chmod(root, 0o755)
  await writeFile(join(root, 'system-file'), 'system', { mode: 0o444 }); await chmod(join(root, 'system-file'), 0o444)
  const encoded = JSON.stringify({ schemaVersion: 1, platform: `linux-${process.arch}`, tools: {}, origins: [
    { path: '/system-file', source: '/system-file', sourceMode: 0o644, kind: 'file', mode: 0o444, size: 6, sha256: sha('system') },
  ] }) + '\n'
  await writeFile(join(root, '.dsh-system-manifest.json'), encoded, { mode: 0o444 }); await chmod(join(root, '.dsh-system-manifest.json'), 0o444)
  const info = await lstat(root)
  return { schemaVersion: 1, root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    manifestSha256: sha(encoded), bytes: Buffer.byteLength(encoded) + 6, entries: 3 }
}
async function fixture(): Promise<{ input: LinuxRsiBootstrapInput; runtime: LinuxRuntime; archive: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'dsh-repository-bootstrap-test-')); directories.push(parent)
  const home = join(parent, 'home'), root = join(parent, 'base')
  await mkdir(home, { mode: 0o700 }); await chmod(home, 0o700)
  await mkdir(root, { mode: 0o700 })
  const write = async (name: string, content: string, mode = 0o600): Promise<void> => {
    const path = join(root, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 }); await writeFile(path, content, { mode })
  }
  const node = '#!/bin/sh\ncase "$1" in *npm-cli.js|*npx-cli.js) echo 10.9.9;; *pnpm.mjs) echo 11.7.0;; *) echo v22.23.2;; esac\n'
  await write('bin/node', node, 0o500); await write('pnpm-native/node', node, 0o500)
  await write('pnpm-native/pnpm', '#!/bin/sh\necho 11.7.0\n', 0o500)
  await write('pnpm-native/package.json', '{"name":"@pnpm/exe","version":"11.7.0"}')
  await write('pnpm/bin/pnpm.mjs', 'fixture-pnpm'); await write('pnpm-lock.yaml', 'fixture-lock')
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-system-prompt']) await write(`node_modules/${name}/package.json`, '{"version":"1.0.0"}')
  await write('store/data', 'retained-store'); await write('cache/data', 'retained-cache')
  const info = await lstat(root)
  const runtime: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: sha('fixture-lock'), root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin/node'), nodeSha256: sha(node), pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(root, 'pnpm-native'), nativePnpmPath: join(root, 'pnpm-native/pnpm'), modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'), cachePath: join(root, 'cache'), versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0', tools: '1.0.0', systemPrompt: '1.0.0' } }
  const input: LinuxRsiBootstrapInput = { dshHome: home, profile: 'unit', source: { schemaVersion: 1, version: '0.1.65',
    origin: { kind: 'local-head', locator: parent, ref: 'HEAD' }, sourceCommit: runtime.sourceCommit, repository: parent,
    baseline: { ref: 'refs/dsh-source/repairs', remote: join(parent, 'release.git'), targetBranch: 'repairs', initialCommit: runtime.sourceCommit } } }
  const archive = join(parent, 'fixture-node.tgz'), pack = join(parent, 'pack'), prefix = `node-v22.23.2-linux-${process.arch}`
  const npm = join(pack, prefix, 'lib/node_modules/npm')
  await mkdir(join(npm, 'bin'), { recursive: true, mode: 0o755 })
  await writeFile(join(npm, 'package.json'), '{"name":"npm","version":"10.9.9"}', { mode: 0o644 })
  for (const name of ['npm', 'npx']) await writeFile(join(npm, 'bin', `${name}-cli.js`), 'fixture-cli', { mode: 0o755 })
  execFileSync('/usr/bin/tar', ['-czf', archive, '-C', pack, prefix])
  const base = { schemaVersion: 3, backend: 'linux-native', sourceCommit: runtime.sourceCommit, lockSha256: runtime.lockSha256, runtime }
  mocks.base.mockResolvedValue(base); mocks.readBase.mockResolvedValue(base)
  mocks.archive.mockImplementation(async (_path, _url, _expected, _maximum, stage: string) => {
    const path = join(stage, 'fixture-node.tgz'); await copyFile(archive, path); return path
  })
  return { input, runtime, archive }
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.snapshot.mockImplementation(snapshotFixture)
  mocks.mapping.mockResolvedValue(mapping); mocks.verifyMapping.mockImplementation(async value => value)
  mocks.abi.mockImplementation(async (snapshot, runtime) => { await verifyLinuxSystemSnapshot(snapshot); await verifyLinuxRuntime(runtime) })
})
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

async function retainedTree(path: string): Promise<unknown[]> {
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

test.runIf(process.platform === 'linux')('existing-only reader never constructs a missing repository family or receipt', async () => {
  const { input } = await fixture(), parent = join(input.dshHome, 'rsi-linux-repository-runtimes')
  await expect(readLinuxRsiRepositoryRuntime(input)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(lstat(parent)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(mocks.base).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
  await mkdir(parent, { mode: 0o700 })
  await expect(readLinuxRsiRepositoryRuntime(input)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(parent)).toEqual([])
  await prepareLinuxRsiRepositoryRuntime(input)
  await rm(join(parent, input.profile, 'bootstrap.json'))
  const before = await retainedTree(parent)
  vi.clearAllMocks()
  await expect(readLinuxRsiRepositoryRuntime(input)).rejects.toThrow('inventory differs')
  expect(await retainedTree(parent)).toEqual(before)
  expect(mocks.base).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
})

test.runIf(process.platform === 'linux')('existing-only reader preserves identity and metadata while verifying retained inputs', async () => {
  const { input } = await fixture(), result = await prepareLinuxRsiRepositoryRuntime(input)
  const parent = join(input.dshHome, 'rsi-linux-repository-runtimes'), before = await retainedTree(parent)
  vi.clearAllMocks()
  expect(await readLinuxRsiRepositoryRuntime(input)).toEqual(result)
  expect(await readLinuxRsiRepositoryRuntime(input)).toEqual(result)
  expect(await retainedTree(parent)).toEqual(before)
  expect(mocks.readBase).toHaveBeenCalledTimes(2); expect(mocks.mapping).toHaveBeenCalledTimes(2)
  expect(mocks.abi).toHaveBeenCalledTimes(2); expect(mocks.verifyMapping).toHaveBeenCalledTimes(2)
  expect(mocks.base).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
})

test.runIf(process.platform === 'linux')('existing-only reader rejects runtime drift without repairing it', async () => {
  const { input } = await fixture(), result = await prepareLinuxRsiRepositoryRuntime(input)
  const path = join(result.runtime.storePath, 'data')
  await chmod(path, 0o644); await writeFile(path, 'tampered-store'); await chmod(path, 0o444)
  const parent = join(input.dshHome, 'rsi-linux-repository-runtimes'), before = await retainedTree(parent)
  vi.clearAllMocks()
  await expect(readLinuxRsiRepositoryRuntime(input)).rejects.toThrow('root differs')
  expect(await retainedTree(parent)).toEqual(before)
  expect(mocks.base).not.toHaveBeenCalled(); expect(mocks.archive).not.toHaveBeenCalled()
  expect(mocks.snapshot).not.toHaveBeenCalled()
})

test.runIf(process.platform === 'linux')('separate readable clone retains immutable old runtime, official npm entry layout and idempotent receipt', async () => {
  const { input, runtime } = await fixture(), before = await hashLinuxRuntimeTree(runtime.root.path)
  const result = await prepareLinuxRsiRepositoryRuntime(input)
  expect(result).toMatchObject({ schemaVersion: 4, sourceCommit: runtime.sourceCommit, userNamespace: mapping })
  const final = join(input.dshHome, 'rsi-linux-repository-runtimes', input.profile)
  expect(result.runtime.root.path).toBe(join(final, 'runtime'))
  expect(result.systemSnapshot.root.path).toBe(join(final, 'system'))
  expect(mocks.snapshot).toHaveBeenCalledWith(expect.any(String), expect.any(AbortSignal), expect.objectContaining({
    nodeSha256: runtime.nodeSha256, sourceCommit: runtime.sourceCommit,
  }))
  expect((await lstat(final)).mode & 0o777).toBe(0o700)
  expect((await lstat(result.runtime.root.path)).mode & 0o777).toBe(0o755)
  expect((await lstat(result.runtime.nodePath)).mode & 0o777).toBe(0o555)
  expect((await lstat(join(result.runtime.storePath, 'data'))).mode & 0o777).toBe(0o444)
  expect((await lstat(runtime.nodePath)).mode & 0o777).toBe(0o500)
  expect((await lstat(result.runtime.nodePath)).ino).not.toBe((await lstat(runtime.nodePath)).ino)
  await expect(verifyLinuxSystemSnapshot(result.systemSnapshot)).resolves.toEqual(result.systemSnapshot)
  expect(await prepareLinuxRsiRepositoryRuntime(input)).toEqual(result)
  expect(mocks.snapshot).toHaveBeenCalledTimes(1); expect(mocks.archive).toHaveBeenCalledTimes(1)
  expect(await hashLinuxRuntimeTree(runtime.root.path)).toBe(before)
  expect(await readdir(join(input.dshHome, 'rsi-linux-repository-runtimes'))).toEqual([input.profile])
})

test.runIf(process.platform === 'linux')('actual clone drift and system drift invalidate reuse without recopying', async () => {
  const { input } = await fixture(), result = await prepareLinuxRsiRepositoryRuntime(input)
  const path = join(result.runtime.storePath, 'data')
  await chmod(path, 0o644); await writeFile(path, 'tampered-store'); await chmod(path, 0o444)
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('root differs')
  await chmod(path, 0o644); await writeFile(path, 'retained-store'); await chmod(path, 0o444)
  const system = join(result.systemSnapshot.root.path, 'system-file')
  await chmod(system, 0o644); await writeFile(system, 'evil!!'); await chmod(system, 0o444)
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('file differs')
  expect(mocks.snapshot).toHaveBeenCalledTimes(1)
})

test.runIf(process.platform === 'linux')('unsafe receipt permissions and mismatched source or mapping fail closed', async () => {
  const { input } = await fixture(); await prepareLinuxRsiRepositoryRuntime(input)
  const receipt = join(input.dshHome, 'rsi-linux-repository-runtimes', input.profile, 'bootstrap.json')
  await chmod(receipt, 0o644)
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('unsafe repository receipt')
  await chmod(receipt, 0o600)
  await expect(prepareLinuxRsiRepositoryRuntime({ ...input, source: { ...input.source, sourceCommit: '2'.repeat(40) } })).rejects.toThrow('receipt differs')
  mocks.mapping.mockResolvedValue({ ...mapping, candidateUid: mapping.candidateUid + 1 })
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('receipt differs')
})

test.runIf(process.platform === 'linux')('invalid identity and unavailable mapping stop before base preparation', async () => {
  const { input } = await fixture()
  await expect(prepareLinuxRsiRepositoryRuntime({ ...input, profile: '../escape' })).rejects.toThrow('invalid bootstrap identity')
  expect(mocks.mapping).not.toHaveBeenCalled()
  mocks.mapping.mockRejectedValueOnce(new Error('allocation unavailable'))
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('allocation unavailable')
  expect(mocks.base).not.toHaveBeenCalled()
  await expect(lstat(join(input.dshHome, 'rsi-linux-repository-runtimes'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test.runIf(process.platform === 'linux')('legacy destination and unsafe parent are preserved', async () => {
  const { input } = await fixture(), parent = join(input.dshHome, 'rsi-linux-repository-runtimes')
  await mkdir(join(parent, input.profile), { recursive: true, mode: 0o700 })
  await writeFile(join(parent, input.profile, 'legacy'), 'keep')
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('inventory differs')
  expect(await readFile(join(parent, input.profile, 'legacy'), 'utf8')).toBe('keep')
  await chmod(parent, 0o755)
  await expect(prepareLinuxRsiRepositoryRuntime(input)).rejects.toThrow('unsafe private directory')
})

test.runIf(process.platform === 'linux')('abort after cloning and npm extraction removes only fresh stage', async () => {
  const { input, runtime } = await fixture(), controller = new AbortController()
  mocks.snapshot.mockImplementationOnce(async (root: string) => {
    expect((await lstat(join(dirname(root), 'runtime/bin/npm'))).isSymbolicLink()).toBe(true)
    controller.abort(new Error('cancelled repository bootstrap')); throw controller.signal.reason
  })
  await expect(prepareLinuxRsiRepositoryRuntime({ ...input, signal: controller.signal })).rejects.toThrow('cancelled repository bootstrap')
  expect(await readdir(join(input.dshHome, 'rsi-linux-repository-runtimes'))).toEqual([])
  expect(await hashLinuxRuntimeTree(runtime.root.path)).toBe(runtime.root.sha256)
})

test.runIf(process.platform === 'linux')('cached unpinned archive is rejected by the real shared digest helper and stage is removed', async () => {
  const { input, archive } = await fixture()
  const actual = await vi.importActual<typeof import('../src/rsi-linux-runtime-bootstrap.js')>('../src/rsi-linux-runtime-bootstrap.js')
  mocks.archive.mockImplementationOnce(actual.officialArchive)
  await expect(prepareLinuxRsiRepositoryRuntime({ ...input, nodeArchivePath: archive })).rejects.toThrow('official archive digest differs')
  expect(await readdir(join(input.dshHome, 'rsi-linux-repository-runtimes'))).toEqual([])
})
