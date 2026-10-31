import { createHash } from 'node:crypto'
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm,
  symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, verifyLinuxRuntime,
  type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import type { LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { relocateLinuxRsiNativeFamily, verifyLinuxRsiNativeRelocation,
  type LinuxRsiNativeRelocationElement, type LinuxRsiNativeRelocationProof } from '../src/rsi-linux-native-relocation.js'

const mocks = vi.hoisted(() => ({ validateBehavior: vi.fn(), behaviorDigest: vi.fn() }))
vi.mock('node:module', async importOriginal => ({
  ...await importOriginal<typeof import('node:module')>(),
  createRequire: () => Object.assign(
    () => ({ validateLinuxPluginBehaviorRuntime: mocks.validateBehavior,
      linuxPluginBehaviorRuntimeDigest: mocks.behaviorDigest }),
    { resolve: (specifier: string) => specifier }),
}))

const linux = test.runIf(process.platform === 'linux')
const directories: string[] = []
const PREFIX = 'rsi Linux native relocation: '
const PROFILE = 'unit'
const SOURCE_COMMIT = '1'.repeat(40)
const sha = (value: Buffer | string): string => createHash('sha256').update(value).digest('hex')
const hex = (label: string): string => sha(`fixture:${label}`)

beforeEach(() => {
  vi.clearAllMocks()
  mocks.validateBehavior.mockImplementation((value: unknown) => value)
  mocks.behaviorDigest.mockImplementation((value: unknown) => sha(JSON.stringify(value)))
})
afterEach(async () => { for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true }) })

function expectFailure(promise: Promise<unknown>, fragment?: string): Promise<void> {
  return expect(promise).rejects.toThrow(fragment === undefined ? new RegExp(`^${PREFIX}`)
    : new RegExp(`^${PREFIX}.*${fragment}`, 'u'))
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await chmod(path, 0o700)
}

async function write(path: string, bytes: string, mode = 0o600): Promise<void> {
  // Tampering must work on read-only fixture files, so make the owner writable first.
  await chmod(path, 0o600).catch(() => undefined)
  await writeFile(path, bytes, { mode })
  await chmod(path, mode)
}

/** A minimal immutable toolchain tree: layout the LinuxRuntime invariants require. */
async function runtimeTree(root: string, label: string): Promise<void> {
  await privateDirectory(root)
  for (const name of ['bin', 'pnpm', 'pnpm/bin', 'pnpm-native', 'node_modules', 'store', 'cache']) {
    await mkdir(join(root, name), { recursive: true, mode: 0o755 })
    await chmod(join(root, name), 0o755)
  }
  // The stock reader executes the toolchain, so these stand-ins answer --version.
  const nodeScript = '#!/bin/sh\ncase "$*" in *pnpm.mjs*) echo 11.7.0 ;; *) echo v22.23.2 ;; esac\n'
  await write(join(root, 'bin/node'), nodeScript, 0o555)
  await write(join(root, 'pnpm/bin/pnpm.mjs'), '#!/bin/sh\necho 11.7.0\n', 0o444)
  await write(join(root, 'pnpm-native/pnpm'), '#!/bin/sh\necho 11.7.0\n', 0o555)
  await write(join(root, 'pnpm-native/node'), nodeScript, 0o555)
  await write(join(root, 'pnpm-native/package.json'),
    JSON.stringify({ name: '@pnpm/exe', version: '11.7.0' }), 0o444)
  await write(join(root, 'pnpm-lock.yaml'), 'lock', 0o444)
  for (const name of ['typescript', '@deepseek-ai/cordis', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-system-prompt']) {
    await mkdir(join(root, 'node_modules', name), { recursive: true })
    await write(join(root, 'node_modules', name, 'package.json'), JSON.stringify({ version: '1.0.0' }), 0o444)
  }
  await write(join(root, 'node_modules/index.js'), `export default ${JSON.stringify(label)}\n`, 0o444)
  await write(join(root, 'store/data'), `store-${label}`, 0o444)
  await write(join(root, 'cache/data'), `cache-${label}`, 0o444)
  await symlink('bin/node', join(root, 'node-link'))
}

async function runtimeFor(root: string): Promise<LinuxRuntime> {
  const info = await lstat(root)
  return {
    schemaVersion: 1,
    backend: 'linux-native',
    platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: SOURCE_COMMIT,
    lockSha256: sha('lock'),
    root: { path: root, dev: info.dev, ino: info.ino, sha256: await hashLinuxRuntimeTree(root) },
    nodePath: join(root, 'bin/node'),
    nodeSha256: sha(await readFile(join(root, 'bin/node'))),
    pnpmPath: join(root, 'pnpm/bin/pnpm.mjs'),
    nativePnpmRoot: join(root, 'pnpm-native'),
    nativePnpmPath: join(root, 'pnpm-native/pnpm'),
    modulesPath: join(root, 'node_modules'),
    storePath: join(root, 'store'),
    cachePath: join(root, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '1.0.0', cordis: '1.0.0',
      tools: '1.0.0', systemPrompt: '1.0.0' },
  }
}

function behaviorFor(runtime: LinuxRuntime): LinuxPluginBehaviorRuntime {
  return {
    schemaVersion: 1,
    runtime,
    observer: {
      schemaVersion: 1,
      sourceSha256: hex('observer-source'),
      workerSha256: hex('observer-worker'),
      candidateSha256: hex('observer-candidate'),
      launcherSha256: hex('observer-launcher'),
      parentProtectSha256: hex('observer-parent'),
      childProtectSha256: hex('observer-child'),
    },
  }
}

function seal(content: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(content)) if (key !== 'receiptDigest') base[key] = value
  return { ...base, receiptDigest: sha(JSON.stringify(base)) }
}

function receiptDigest(receipt: Record<string, unknown>): string {
  const content: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(receipt)) if (key !== 'receiptDigest') content[key] = value
  return sha(JSON.stringify(content))
}

async function writeReceipt(path: string, receipt: Record<string, unknown>, mode = 0o600): Promise<void> {
  await write(path, JSON.stringify(receipt), mode)
}

interface Fixture {
  sourceHome: string
  physicalHome: string
  logicalHome: string
  profile: string
  trees: { runtime: string; repository: string; system: string; behavior: string }
}

/** Build the four receipt-bound families a prepared Linux-native Home carries. */
async function fixture(): Promise<Fixture> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'dsh-linux-relocation-test-'))
  directories.push(parent)
  const sourceHome = join(parent, 'source-home')
  await privateDirectory(sourceHome)
  const family = (name: string): string => join(sourceHome, name, PROFILE)
  const runtimeFamily = family('rsi-linux-runtimes')
  const repositoryFamily = family('rsi-linux-repository-runtimes')
  const behaviorFamily = join(sourceHome, 'rsi-authorities', PROFILE, 'state', 'linux-creation-behavior')
  const creationFamily = family('rsi-linux-creation-builds')
  const trees = {
    runtime: join(runtimeFamily, 'runtime'),
    repository: join(repositoryFamily, 'runtime'),
    system: join(repositoryFamily, 'system'),
    behavior: join(behaviorFamily, 'runtime'),
  }
  for (const directory of [runtimeFamily, repositoryFamily, behaviorFamily, creationFamily]) {
    await privateDirectory(directory)
  }
  await runtimeTree(trees.runtime, 'runtime')
  await runtimeTree(trees.repository, 'repository')
  await runtimeTree(trees.system, 'system')
  await runtimeTree(trees.behavior, 'behavior')

  const runtime = await runtimeFor(trees.runtime)
  await writeReceipt(join(runtimeFamily, 'bootstrap.json'), seal({
    schemaVersion: 3,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: runtime.lockSha256,
    runtime,
    manifestHashes: { node: hex('manifest-node'), pnpm: hex('manifest-pnpm') },
    archives: { node: hex('archive-node'), pnpm: hex('archive-pnpm'),
      pnpmExe: hex('archive-pnpm-exe'), pnpmNative: hex('archive-pnpm-native') },
  }))

  const repositoryRuntime = await runtimeFor(trees.repository)
  const systemInfo = await lstat(trees.system)
  const snapshot = {
    schemaVersion: 1,
    root: { path: trees.system, dev: systemInfo.dev, ino: systemInfo.ino,
      sha256: await hashLinuxRuntimeTree(trees.system) },
    manifestSha256: hex('system-manifest'),
    bytes: 4,
    entries: 2,
  }
  const userNamespace = {
    schemaVersion: 1,
    ownerUid: process.getuid!(),
    ownerGid: process.getgid!(),
    candidateUid: 100_000,
    candidateGid: 100_000,
    hostNamespace: { dev: 11, ino: 12 },
    helpers: { uid: { path: '/usr/bin/newuidmap', sha256: hex('newuidmap') },
      gid: { path: '/usr/bin/newgidmap', sha256: hex('newgidmap') } },
  }
  await writeReceipt(join(repositoryFamily, 'bootstrap.json'), seal({
    schemaVersion: 4,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: repositoryRuntime.lockSha256,
    ownerUid: userNamespace.ownerUid,
    ownerGid: userNamespace.ownerGid,
    sourceDigest: hex('source-digest'),
    nodeArchiveDigest: hex('node-archive'),
    npmVersion: '11.7.0',
    baseRuntimeDigest: linuxRuntimeDigest(runtime),
    runtimeDigest: linuxRuntimeDigest(repositoryRuntime),
    systemSnapshotDigest: sha(JSON.stringify(snapshot)),
    userNamespaceDigest: sha(JSON.stringify(userNamespace)),
    runtime: repositoryRuntime,
    systemSnapshot: snapshot,
    userNamespace,
  }))

  const descriptor = behaviorFor(await runtimeFor(trees.behavior))
  const behaviorReceipt = seal({
    schemaVersion: 1,
    baseRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    compilerSha256: hex('compiler'),
    descriptor,
  })
  await writeReceipt(join(behaviorFamily, 'behavior.json'), behaviorReceipt, 0o444)

  const cgroupRoots = {
    mode: 'v1',
    cpu: `/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${process.getuid!()}`,
    memory: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid!()}`,
    pids: `/sys/fs/cgroup/pids/dsh-native/uid-${process.getuid!()}`,
    freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${process.getuid!()}`,
  }
  await writeReceipt(join(creationFamily, 'bootstrap.json'), seal({
    schemaVersion: 3,
    backend: 'linux-native',
    dshHome: sourceHome,
    profile: PROFILE,
    sourceCommit: SOURCE_COMMIT,
    lockSha256: runtime.lockSha256,
    buildRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    repositoryRuntimeDigest: linuxRuntimeDigest(repositoryRuntime),
    preparationDigest: behaviorReceipt.receiptDigest as string,
    behaviorDigest: sha(JSON.stringify(descriptor)),
    systemSnapshotDigest: sha(JSON.stringify(snapshot)),
    userNamespaceDigest: sha(JSON.stringify(userNamespace)),
    cgroupRoots,
    behavior: descriptor,
  }))

  return {
    sourceHome,
    physicalHome: join(parent, 'stage-home'),
    logicalHome: join(parent, 'logical-home'),
    profile: PROFILE,
    trees,
  }
}

async function relocate(ctx: Fixture): Promise<LinuxRsiNativeRelocationProof> {
  return relocateLinuxRsiNativeFamily({
    sourceHome: ctx.sourceHome, physicalHome: ctx.physicalHome,
    logicalHome: ctx.logicalHome, profile: ctx.profile,
  })
}

function elementMap(proof: LinuxRsiNativeRelocationProof): Map<string, LinuxRsiNativeRelocationElement> {
  return new Map(proof.elements.map(item => [item.name, item]))
}

/** Recompute the relocation digest so narrower checks can be exercised alone. */
function reseal(proof: LinuxRsiNativeRelocationProof): void {
  const { runtime, repository, behavior, creation } = proof.digests
  const content = { ...proof, digests: { runtime, repository, behavior, creation } }
  proof.digests = { ...content.digests, relocation: sha(JSON.stringify(content)) }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

function homePath(home: string, relativePath: string): string {
  return join(home, ...relativePath.split('/'))
}

/** Copy a tree preserving only what hashLinuxRuntimeTree records: names, types, modes, bytes. */
async function structuralCopy(source: string, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 })
  const info = await lstat(source)
  for (const name of (await readdir(source)).sort()) {
    const from = join(source, name), to = join(destination, name), child = await lstat(from)
    if (child.isSymbolicLink()) await symlink(await readlink(from), to)
    else if (child.isDirectory()) await structuralCopy(from, to)
    else { await copyFile(from, to); await chmod(to, child.mode & 0o777) }
  }
  await chmod(destination, info.mode & 0o777)
}

describe('rsi Linux native relocation', () => {
  linux('relocates the four receipt-bound families into a fresh physical Home', async () => {
    const ctx = await fixture()
    const before = await hashLinuxRuntimeTree(ctx.trees.runtime)
    const proof = await relocate(ctx)
    expect(proof.schemaVersion).toBe(1)
    expect(proof.backend).toBe('linux-native')
    expect(proof.profile).toBe(PROFILE)
    expect(proof.sourceHome).toBe(ctx.sourceHome)
    expect(proof.physicalHome).toBe(ctx.physicalHome)
    expect(proof.logicalHome).toBe(ctx.logicalHome)
    expect(proof.behaviorRootRelative).toBe('rsi-authorities/unit/state/linux-creation-behavior/runtime')

    const elements = elementMap(proof)
    const expected: Record<string, string> = {
      runtime: 'rsi-linux-runtimes/unit/runtime',
      'repository-runtime': 'rsi-linux-repository-runtimes/unit/runtime',
      system: 'rsi-linux-repository-runtimes/unit/system',
      'behavior-runtime': 'rsi-authorities/unit/state/linux-creation-behavior/runtime',
    }
    expect([...elements.keys()]).toEqual(['runtime', 'repository-runtime', 'system', 'behavior-runtime'])
    for (const [name, suffix] of Object.entries(expected)) {
      const item = elements.get(name)!
      expect(item.physicalPath).toBe(join(ctx.physicalHome, suffix))
      expect(item.logicalPath).toBe(join(ctx.logicalHome, suffix))
      expect(item.entries).toBeGreaterThan(0)
      expect(item.bytes).toBeGreaterThan(0)
      const info = await lstat(item.physicalPath)
      expect([info.dev, info.ino]).toEqual([item.dev, item.ino])
      expect(await hashLinuxRuntimeTree(item.physicalPath)).toBe(item.sha256)
    }
    expect(elements.get('runtime')!.sha256).toBe(before)
    const sourceInfo = await lstat(ctx.trees.runtime)
    expect([elements.get('runtime')!.dev, elements.get('runtime')!.ino])
      .not.toEqual([sourceInfo.dev, sourceInfo.ino])
    expect(await hashLinuxRuntimeTree(ctx.trees.runtime)).toBe(before)

    const runtimeReceipt = await readJson(homePath(ctx.physicalHome, 'rsi-linux-runtimes/unit/bootstrap.json'))
    expect(runtimeReceipt.dshHome).toBe(ctx.logicalHome)
    const runtime = runtimeReceipt.runtime as { root: { path: string } }
    expect(runtime.root.path).toBe(join(ctx.logicalHome, 'rsi-linux-runtimes/unit/runtime'))
    expect(receiptDigest(runtimeReceipt)).toBe(proof.digests.runtime)

    const repositoryReceipt = await readJson(homePath(ctx.physicalHome,
      'rsi-linux-repository-runtimes/unit/bootstrap.json'))
    expect(repositoryReceipt.dshHome).toBe(ctx.logicalHome)
    expect((repositoryReceipt.runtime as { root: { path: string } }).root.path)
      .toBe(join(ctx.logicalHome, 'rsi-linux-repository-runtimes/unit/runtime'))
    expect((repositoryReceipt.systemSnapshot as { root: { path: string } }).root.path)
      .toBe(join(ctx.logicalHome, 'rsi-linux-repository-runtimes/unit/system'))
    expect(receiptDigest(repositoryReceipt)).toBe(proof.digests.repository)

    const behaviorReceipt = await readJson(homePath(ctx.physicalHome,
      'rsi-authorities/unit/state/linux-creation-behavior/behavior.json'))
    expect((behaviorReceipt.descriptor as { runtime: { root: { path: string } } }).runtime.root.path)
      .toBe(join(ctx.logicalHome, 'rsi-authorities/unit/state/linux-creation-behavior/runtime'))
    expect(receiptDigest(behaviorReceipt)).toBe(proof.digests.behavior)

    const creationReceipt = await readJson(homePath(ctx.physicalHome, 'rsi-linux-creation-builds/unit/bootstrap.json'))
    expect(creationReceipt.dshHome).toBe(ctx.logicalHome)
    expect(receiptDigest(creationReceipt)).toBe(proof.digests.creation)

    const { runtime: r, repository: p, behavior: b, creation: c } = proof.digests
    expect(proof.digests.relocation)
      .toBe(sha(JSON.stringify({ ...proof, digests: { runtime: r, repository: p, behavior: b, creation: c } })))
    await verifyLinuxRsiNativeRelocation(proof)
    expect(await lstat(ctx.logicalHome).then(() => true, () => false)).toBe(false)
  })

  linux('verifies the relocated runtime through the stock reader after the cutover rename', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    await verifyLinuxRsiNativeRelocation(proof)
    await rename(ctx.physicalHome, ctx.logicalHome)
    const receipt = await readJson(join(ctx.logicalHome, 'rsi-linux-runtimes/unit/bootstrap.json'))
    await expect(verifyLinuxRuntime(receipt.runtime as LinuxRuntime)).resolves.toMatchObject({ backend: 'linux-native' })
    const repository = await readJson(join(ctx.logicalHome, 'rsi-linux-repository-runtimes/unit/bootstrap.json'))
    await expect(verifyLinuxRuntime(repository.runtime as LinuxRuntime)).resolves.toMatchObject({ backend: 'linux-native' })
  })

  linux('refuses an existing target family directory', async () => {
    const ctx = await fixture()
    await privateDirectory(ctx.physicalHome)
    await privateDirectory(join(ctx.physicalHome, 'rsi-linux-runtimes/unit'))
    await expectFailure(relocate(ctx), 'target')
  })

  linux('refuses an overlapping physical Home', async () => {
    const ctx = await fixture()
    await expectFailure(relocateLinuxRsiNativeFamily({ sourceHome: ctx.sourceHome,
      physicalHome: join(ctx.sourceHome, 'stage'), logicalHome: ctx.logicalHome, profile: ctx.profile }))
  })

  linux('refuses a source receipt that records another Home', async () => {
    const ctx = await fixture()
    const path = homePath(ctx.sourceHome, 'rsi-linux-runtimes/unit/bootstrap.json')
    const receipt = await readJson(path)
    receipt.dshHome = join(ctx.sourceHome, 'elsewhere')
    await writeReceipt(path, seal(receipt))
    await expectFailure(relocate(ctx), 'source runtime receipt differs')
  })

  linux('refuses a tampered source receipt digest', async () => {
    const ctx = await fixture()
    const path = homePath(ctx.sourceHome, 'rsi-linux-runtimes/unit/bootstrap.json')
    const receipt = await readJson(path)
    receipt.sourceCommit = '2'.repeat(40)
    await writeReceipt(path, receipt)
    await expectFailure(relocate(ctx), 'source runtime receipt digest differs')
  })

  linux('refuses a source tree that no longer matches its recorded root hash', async () => {
    const ctx = await fixture()
    await write(join(ctx.trees.runtime, 'store/data'), 'mutated-store-bytes', 0o644)
    await expectFailure(relocate(ctx), 'source tree digest differs')
  })

  linux('refuses a source tree symlink that escapes the root', async () => {
    const ctx = await fixture()
    await write(join(ctx.sourceHome, 'outside-secret'), 'outside', 0o600)
    await symlink(join(ctx.sourceHome, 'outside-secret'), join(ctx.trees.runtime, 'escape'))
    await expectFailure(relocate(ctx), 'source tree differs')
  })

  linux('rejects byte tampering of a copied tree', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    const target = join(ctx.physicalHome, 'rsi-linux-runtimes/unit/runtime/store/data')
    await write(target, 'tampered-copy-bytes', 0o644)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated tree differs')
  })

  linux('rejects mode tampering of a copied tree', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    await chmod(join(ctx.physicalHome, 'rsi-linux-repository-runtimes/unit/runtime/node_modules/index.js'), 0o600)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated tree differs')
  })

  linux('rejects a copied tree that was moved and replaced, changing dev and ino', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    const original = join(ctx.physicalHome, 'rsi-linux-runtimes/unit/runtime')
    await rename(original, `${original}-moved`)
    await structuralCopy(`${original}-moved`, original)
    expect(await hashLinuxRuntimeTree(original)).toBe(elementMap(proof).get('runtime')!.sha256)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated tree differs')
  })

  linux('rejects a proof whose logical path is not the exact prefix substitution', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    expect(proof.elements[0]).toBeDefined()
    proof.elements[0]!.logicalPath = join(ctx.logicalHome, 'other', 'runtime')
    reseal(proof)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocation element paths differ')
  })

  linux('rejects a physical receipt whose recorded digest no longer matches', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    const path = join(ctx.physicalHome, 'rsi-linux-runtimes/unit/bootstrap.json')
    const receipt = await readJson(path)
    receipt.sourceCommit = '3'.repeat(40)
    await writeReceipt(path, receipt)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated runtime receipt digest differs')
  })

  if (process.platform !== 'linux') {
    test('identity validation fails as a plain Error without touching the filesystem', async () => {
      const ctx = await fixture()
      const error = await relocateLinuxRsiNativeFamily({ sourceHome: ctx.sourceHome,
        physicalHome: ctx.physicalHome, logicalHome: ctx.logicalHome, profile: 'bad profile' })
        .catch((reason: unknown) => reason)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).constructor).toBe(Error)
      expect((error as Error).message.startsWith(PREFIX)).toBe(true)
      expect(await lstat(ctx.physicalHome).then(() => true, () => false)).toBe(false)
    })

    test('Linux-only operations fail gracefully off Linux', async () => {
      const ctx = await fixture()
      await expectFailure(relocate(ctx), 'requires Linux')
      const proof: LinuxRsiNativeRelocationProof = {
        schemaVersion: 1,
        backend: 'linux-native',
        profile: PROFILE,
        sourceHome: ctx.sourceHome,
        physicalHome: ctx.physicalHome,
        logicalHome: ctx.logicalHome,
        behaviorRootRelative: 'rsi-authorities/unit/state/linux-creation-behavior/runtime',
        elements: [
          ['runtime', 'rsi-linux-runtimes/unit/runtime'],
          ['repository-runtime', 'rsi-linux-repository-runtimes/unit/runtime'],
          ['system', 'rsi-linux-repository-runtimes/unit/system'],
          ['behavior-runtime', 'rsi-authorities/unit/state/linux-creation-behavior/runtime'],
        ].map(([name, suffix]) => ({
          name: name as LinuxRsiNativeRelocationElement['name'],
          logicalPath: join(ctx.logicalHome, suffix!),
          physicalPath: join(ctx.physicalHome, suffix!),
          dev: 1, ino: 2, sha256: hex(`proof:${name}`), entries: 1, bytes: 1,
        })),
        digests: {
          runtime: hex('digest-runtime'), repository: hex('digest-repository'),
          behavior: hex('digest-behavior'), creation: hex('digest-creation'), relocation: '',
        },
      }
      reseal(proof)
      await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'verification requires Linux')
    })
  }
})
