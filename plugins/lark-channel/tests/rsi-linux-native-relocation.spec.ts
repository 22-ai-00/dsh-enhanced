import { chmod, lstat, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest, verifyLinuxRuntime,
  type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { relocateLinuxRsiNativeFamily, verifyLinuxRsiNativeRelocation,
  type LinuxRsiNativeRelocationElement, type LinuxRsiNativeRelocationProof } from '../src/rsi-linux-native-relocation.js'
import { readRsiReleaseBuildEnvironment } from '../src/rsi-release-build.js'
import { elementMap, fixture, hex, homePath, privateDirectory, PROFILE, readJson, receiptDigest, relocate,
  releaseInventoryDigest, removeFixtureDirectories, reseal, sha, SOURCE_COMMIT, seal, structuralCopy, write,
  writeReceipt } from './fixtures/linux-native-home-fixture.js'

const mocks = vi.hoisted(() => ({ validateBehavior: vi.fn(), behaviorDigest: vi.fn() }))
const PEER = '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  // Only the optional behavior peer is faked; every other resolution (the
  // Control Plane release adapter used by the stock reader) stays real.
  return { ...actual,
    createRequire: (url: string) => Object.assign(
      () => ({ validateLinuxPluginBehaviorRuntime: mocks.validateBehavior,
        linuxPluginBehaviorRuntimeDigest: mocks.behaviorDigest }),
      { resolve: (specifier: string) => specifier === PEER ? specifier : actual.createRequire(url).resolve(specifier) }),
  }
})

const linux = test.runIf(process.platform === 'linux')
const PREFIX = 'rsi Linux native relocation: '

beforeEach(() => {
  vi.clearAllMocks()
  mocks.validateBehavior.mockImplementation((value: unknown) => value)
  mocks.behaviorDigest.mockImplementation((value: unknown) => sha(JSON.stringify(value)))
})
afterEach(removeFixtureDirectories)

function expectFailure(promise: Promise<unknown>, fragment?: string): Promise<void> {
  return expect(promise).rejects.toThrow(fragment === undefined ? new RegExp(`^${PREFIX}`)
    : new RegExp(`^${PREFIX}.*${fragment}`, 'u'))
}

describe('rsi Linux native relocation', () => {
  linux('relocates the five receipt-bound families into a fresh physical Home', async () => {
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
      'release-toolchain': 'rsi-release-builds/unit/toolchain',
      'release-store': 'rsi-release-builds/unit/store',
      'release-cache': 'rsi-release-builds/unit/cache',
    }
    expect([...elements.keys()]).toEqual(['runtime', 'repository-runtime', 'system', 'behavior-runtime',
      'release-toolchain', 'release-store', 'release-cache'])
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

    const releaseReceipt = await readJson(homePath(ctx.physicalHome, 'rsi-release-builds/unit/bootstrap.json'))
    expect(releaseReceipt.dshHome).toBe(ctx.logicalHome)
    expect(releaseReceipt.runtimeDigest).toBe(linuxRuntimeDigest(
      runtimeReceipt.runtime as LinuxRuntime))
    expect(receiptDigest(releaseReceipt)).toBe(proof.digests.release)
    const releaseBuild = releaseReceipt.releaseBuild as Record<string, { path: string; sha256: string }>
    expect(releaseBuild.sandboxExecutable!.path).toBe('/usr/bin/bwrap')
    expect(releaseBuild.pnpmRoot!.path).toBe(join(ctx.logicalHome, 'rsi-release-builds/unit/toolchain'))
    expect(releaseBuild.storeRoot!.path).toBe(join(ctx.logicalHome, 'rsi-release-builds/unit/store'))
    expect(releaseBuild.cacheRoot!.path).toBe(join(ctx.logicalHome, 'rsi-release-builds/unit/cache'))
    expect(await releaseInventoryDigest(homePath(ctx.physicalHome, 'rsi-release-builds/unit/store')))
      .toBe(releaseBuild.storeRoot!.sha256)

    const { runtime: r, repository: p, behavior: b, creation: c, release: l } = proof.digests
    expect(proof.digests.relocation)
      .toBe(sha(JSON.stringify({ ...proof,
        digests: { runtime: r, repository: p, behavior: b, creation: c, release: l } })))
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

  linux('accepts the relocated release family through the stock reader after the cutover rename', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    await verifyLinuxRsiNativeRelocation(proof)
    await rename(ctx.physicalHome, ctx.logicalHome)
    const runtime = (await readJson(join(ctx.logicalHome, 'rsi-linux-runtimes/unit/bootstrap.json')))
      .runtime as LinuxRuntime
    const release = await readRsiReleaseBuildEnvironment({
      dshHome: ctx.logicalHome, profile: PROFILE,
      build: { schemaVersion: 3, backend: 'linux-native', sourceCommit: SOURCE_COMMIT,
        lockSha256: runtime.lockSha256, runtime },
    })
    expect(release).toMatchObject({ schemaVersion: 2, backend: 'linux-native',
      sourceCommit: SOURCE_COMMIT, runtimeDigest: linuxRuntimeDigest(runtime) })
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

  linux('refuses a missing release build family', async () => {
    const ctx = await fixture()
    await rm(join(ctx.sourceHome, 'rsi-release-builds'), { recursive: true, force: true })
    await expectFailure(relocate(ctx), 'source release family differs')
  })

  linux('refuses a source release pin that no longer matches its tree', async () => {
    const ctx = await fixture()
    const path = homePath(ctx.sourceHome, 'rsi-release-builds/unit/bootstrap.json')
    const receipt = await readJson(path)
    const build = receipt.releaseBuild as Record<string, { path: string; sha256: string }>
    build.storeRoot!.sha256 = hex('tampered-store')
    await writeReceipt(path, seal(receipt))
    await expectFailure(relocate(ctx), 'source release pnpm store differs')
  })

  linux('refuses a source release receipt that records another Home', async () => {
    const ctx = await fixture()
    const path = homePath(ctx.sourceHome, 'rsi-release-builds/unit/bootstrap.json')
    const receipt = await readJson(path)
    receipt.dshHome = join(ctx.sourceHome, 'elsewhere')
    await writeReceipt(path, seal(receipt))
    await expectFailure(relocate(ctx), 'source release receipt differs')
  })

  linux('rejects a relocated release receipt whose recorded Home was rewritten', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    const path = homePath(ctx.physicalHome, 'rsi-release-builds/unit/bootstrap.json')
    const receipt = await readJson(path)
    receipt.dshHome = ctx.sourceHome
    await writeReceipt(path, receipt)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated release receipt digest differs')
  })

  linux('rejects byte tampering of a copied release tree', async () => {
    const ctx = await fixture()
    const proof = await relocate(ctx)
    await write(homePath(ctx.physicalHome, 'rsi-release-builds/unit/store/v11/projects/registry.json'),
      '{"projects":["tampered"]}\n', 0o444)
    await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'relocated tree differs')
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
          ['release-toolchain', 'rsi-release-builds/unit/toolchain'],
          ['release-store', 'rsi-release-builds/unit/store'],
          ['release-cache', 'rsi-release-builds/unit/cache'],
        ].map(([name, suffix]) => ({
          name: name as LinuxRsiNativeRelocationElement['name'],
          logicalPath: join(ctx.logicalHome, suffix!),
          physicalPath: join(ctx.physicalHome, suffix!),
          dev: 1, ino: 2, sha256: hex(`proof:${name}`), entries: 1, bytes: 1,
        })),
        digests: {
          runtime: hex('digest-runtime'), repository: hex('digest-repository'),
          behavior: hex('digest-behavior'), creation: hex('digest-creation'),
          release: hex('digest-release'), relocation: '',
        },
      }
      reseal(proof)
      await expectFailure(verifyLinuxRsiNativeRelocation(proof), 'verification requires Linux')
    })
  }
})
