import { chmod, lstat, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { hashLinuxRuntimeTree, linuxRuntimeDigest } from '@dsh-enhanced/assistant-isolation'
import {
  materializeLinuxRsiNativeInStage, type LinuxRsiNativeMaterializeInput,
} from '../src/rsi-linux-native-materialize.js'
import type { LinuxRsiNativeRelocationProof } from '../src/rsi-linux-native-relocation.js'
import { elementMap, fixture, homePath, privateDirectory, PROFILE, readJson, releaseInventoryDigest,
  removeFixtureDirectories, sha, SOURCE_COMMIT, type Fixture } from './fixtures/linux-native-home-fixture.js'

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
const PREFIX = 'rsi Linux native materialize: '
const RELOCATION_PREFIX = 'rsi Linux native relocation: '
const RUNTIME_RELATIVE = `rsi-linux-runtimes/${PROFILE}/runtime`
const REPOSITORY_RELATIVE = `rsi-linux-repository-runtimes/${PROFILE}/runtime`
const SYSTEM_RELATIVE = `rsi-linux-repository-runtimes/${PROFILE}/system`
const BEHAVIOR_RELATIVE = `rsi-authorities/${PROFILE}/state/linux-creation-behavior/runtime`
const CREATION_RECEIPT = `rsi-linux-creation-builds/${PROFILE}/bootstrap.json`
const TOOLCHAIN_RELATIVE = `rsi-release-builds/${PROFILE}/toolchain`
const STORE_RELATIVE = `rsi-release-builds/${PROFILE}/store`
const CACHE_RELATIVE = `rsi-release-builds/${PROFILE}/cache`

beforeEach(() => {
  vi.clearAllMocks()
  mocks.validateBehavior.mockImplementation((value: unknown) => value)
  mocks.behaviorDigest.mockImplementation((value: unknown) => sha(JSON.stringify(value)))
})
afterEach(removeFixtureDirectories)

function input(ctx: Fixture, relocation?: LinuxRsiNativeRelocationProof): LinuxRsiNativeMaterializeInput {
  return { candidateHome: ctx.sourceHome, stagePhysicalHome: ctx.physicalHome, logicalHome: ctx.logicalHome,
    profile: ctx.profile, ...(relocation === undefined ? {} : { relocation }) }
}

function staged(ctx: Fixture, relativePath: string): string { return homePath(ctx.physicalHome, relativePath) }
function logical(ctx: Fixture, relativePath: string): string { return homePath(ctx.logicalHome, relativePath) }

/** The receipt root names the logical (post-cutover) path; the staged copy it
 * stands for must be the very inode the relocation recorded and hashed. */
async function expectStagedCopyMatchesRoot(ctx: Fixture, logicalPath: string,
  root: { dev: number; ino: number; sha256: string }): Promise<void> {
  expect(isAbsolute(logicalPath)).toBe(true)
  expect(logicalPath.startsWith(`${ctx.logicalHome}/`)).toBe(true)
  const physical = join(ctx.physicalHome, relative(ctx.logicalHome, logicalPath))
  const info = await lstat(physical)
  expect(info.isDirectory()).toBe(true)
  expect(info.dev).toBe(root.dev)
  expect(info.ino).toBe(root.ino)
  expect(await hashLinuxRuntimeTree(physical)).toBe(root.sha256)
}

describe('rsi Linux native materialize', () => {
  linux('exposes typed families bound to the staged Home', async () => {
    const ctx = await fixture()
    const output = await materializeLinuxRsiNativeInStage(input(ctx))
    const { family, relocation } = output
    const elements = elementMap(relocation)

    // The proof names the candidate Home it moved from and the Home pair it owns.
    expect(relocation.sourceHome).toBe(ctx.sourceHome)
    expect(relocation.physicalHome).toBe(ctx.physicalHome)
    expect(relocation.logicalHome).toBe(ctx.logicalHome)
    expect(relocation.profile).toBe(PROFILE)

    // Runtime: the typed environment keeps the prepared program identity, and its
    // root descriptor names the logical path backed by the staged copy.
    expect(family.runtime.schemaVersion).toBe(3)
    expect(family.runtime.backend).toBe('linux-native')
    expect(family.runtime.sourceCommit).toBe(SOURCE_COMMIT)
    expect(family.runtime.lockSha256).toBe(sha('lock'))
    expect(family.runtime.runtime.root.path).toBe(logical(ctx, RUNTIME_RELATIVE))
    expect(elements.get('runtime')?.logicalPath).toBe(family.runtime.runtime.root.path)
    expect(elements.get('runtime')?.physicalPath).toBe(staged(ctx, RUNTIME_RELATIVE))
    await expectStagedCopyMatchesRoot(ctx, family.runtime.runtime.root.path, family.runtime.runtime.root)

    // Repository: the same logical/backed-copy rule holds for its runtime and the
    // system snapshot it mounts.
    expect(family.repository.schemaVersion).toBe(4)
    expect(family.repository.sourceCommit).toBe(SOURCE_COMMIT)
    expect(family.repository.lockSha256).toBe(family.runtime.lockSha256)
    expect(family.repository.runtime.root.path).toBe(logical(ctx, REPOSITORY_RELATIVE))
    expect(family.repository.systemSnapshot.root.path).toBe(logical(ctx, SYSTEM_RELATIVE))
    expect(elements.get('repository-runtime')?.logicalPath).toBe(family.repository.runtime.root.path)
    expect(elements.get('system')?.logicalPath).toBe(family.repository.systemSnapshot.root.path)
    await expectStagedCopyMatchesRoot(ctx, family.repository.runtime.root.path, family.repository.runtime.root)
    await expectStagedCopyMatchesRoot(ctx, family.repository.systemSnapshot.root.path,
      family.repository.systemSnapshot.root)

    // Behavior: the relocated descriptor is the typed peer value.
    expect(family.behavior.runtime.root.path).toBe(logical(ctx, BEHAVIOR_RELATIVE))
    expect(elements.get('behavior-runtime')?.logicalPath).toBe(family.behavior.runtime.root.path)
    await expectStagedCopyMatchesRoot(ctx, family.behavior.runtime.root.path, family.behavior.runtime.root)

    // Creation build: the build-runtime digest binds the repository runtime the
    // program was prepared from, and the cgroup roots stay host paths.
    expect(family.creationBuild.schemaVersion).toBe(3)
    expect(family.creationBuild.sourceCommit).toBe(SOURCE_COMMIT)
    expect(family.creationBuild.buildRuntimeDigest).toBe(linuxRuntimeDigest(family.repository.runtime))
    expect(family.creationBuild.behavior).toEqual(family.behavior)
    expect(Object.values(family.creationBuild.cgroupRoots as unknown as Record<string, string>))
      .toContain(`/sys/fs/cgroup/cpu,cpuacct/dsh-native/uid-${process.getuid!()}`)

    // Release: pins point into the logical Home and the staged trees reproduce
    // their sealed inventory digests.
    const pins = family.release.releaseBuild
    expect(family.release.schemaVersion).toBe(2)
    expect(family.release.sourceCommit).toBe(family.repository.sourceCommit)
    expect(family.release.runtimeDigest).toBe(linuxRuntimeDigest(family.runtime.runtime))
    expect(pins.pnpmRoot.path).toBe(logical(ctx, TOOLCHAIN_RELATIVE))
    expect(pins.storeRoot.path).toBe(logical(ctx, STORE_RELATIVE))
    expect(pins.cacheRoot.path).toBe(logical(ctx, CACHE_RELATIVE))
    expect(pins.nodeExecutable.path).toBe(join(pins.pnpmRoot.path, 'node'))
    expect(pins.pnpmExecutable.path).toBe(join(pins.pnpmRoot.path, 'pnpm'))
    for (const [relativePath, pin] of [[TOOLCHAIN_RELATIVE, pins.pnpmRoot], [STORE_RELATIVE, pins.storeRoot],
      [CACHE_RELATIVE, pins.cacheRoot]] as const) {
      expect(await releaseInventoryDigest(staged(ctx, relativePath))).toBe(pin.sha256)
    }

    // The prepared source build carries the relocated repository and cgroup roots.
    expect(output.sourceBuild).toEqual({ backend: 'linux-native', repository: family.repository,
      cgroupRoots: family.creationBuild.cgroupRoots })
  })

  linux('keeps logical paths in the relocated receipts while the Home is staged', async () => {
    const ctx = await fixture()
    const output = await materializeLinuxRsiNativeInStage(input(ctx))

    const creation = await readJson(staged(ctx, CREATION_RECEIPT))
    expect(creation.dshHome).toBe(ctx.logicalHome)
    expect(creation.profile).toBe(PROFILE)
    expect(creation.sourceCommit).toBe(SOURCE_COMMIT)
    expect(creation.behavior).toEqual(output.family.behavior)
    const behavior = creation.behavior as { runtime: { root: { path: string } } }
    expect(behavior.runtime.root.path).toBe(logical(ctx, BEHAVIOR_RELATIVE))
    // The logical path is only recorded; the staged tree is what actually exists.
    expect((await lstat(staged(ctx, BEHAVIOR_RELATIVE))).isDirectory()).toBe(true)
    await expect(lstat(ctx.logicalHome)).rejects.toThrow(/ENOENT/u)

    const runtimeReceipt = await readJson(staged(ctx, `rsi-linux-runtimes/${PROFILE}/bootstrap.json`))
    expect(runtimeReceipt.dshHome).toBe(ctx.logicalHome)
    expect(runtimeReceipt.profile).toBe(PROFILE)
    const repositoryReceipt = await readJson(staged(ctx,
      `rsi-linux-repository-runtimes/${PROFILE}/bootstrap.json`))
    expect(repositoryReceipt.dshHome).toBe(ctx.logicalHome)
    const releaseReceipt = await readJson(staged(ctx, `rsi-release-builds/${PROFILE}/bootstrap.json`))
    expect(releaseReceipt.dshHome).toBe(ctx.logicalHome)
    expect((releaseReceipt.releaseBuild as { pnpmRoot: { path: string } }).pnpmRoot.path)
      .toBe(logical(ctx, TOOLCHAIN_RELATIVE))
  })

  linux('stages in place when the live logical Home already exists and is attested', async () => {
    const ctx = await fixture()
    await privateDirectory(ctx.logicalHome)
    const output = await materializeLinuxRsiNativeInStage({ ...input(ctx),
      existingLogicalHome: ctx.logicalHome })
    expect(output.relocation.logicalHome).toBe(ctx.logicalHome)
    expect((await lstat(ctx.logicalHome)).isDirectory()).toBe(true)
    expect((await readJson(staged(ctx, CREATION_RECEIPT))).dshHome).toBe(ctx.logicalHome)
    expect((await readJson(staged(ctx, `rsi-release-builds/${PROFILE}/bootstrap.json`))).dshHome)
      .toBe(ctx.logicalHome)

    // Replay keeps the same sealed proof: the attestation is staging input only.
    const replay = await materializeLinuxRsiNativeInStage({ ...input(ctx, output.relocation),
      existingLogicalHome: ctx.logicalHome })
    expect(replay).toEqual(output)
    expect(Object.keys(replay.relocation).sort()).toEqual(Object.keys(output.relocation).sort())
  })

  linux('refuses an attested existing logical Home that is absent', async () => {
    const ctx = await fixture()
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx),
      existingLogicalHome: ctx.logicalHome })).rejects.toThrow(
      new RegExp(`^${RELOCATION_PREFIX}existing logical Home is missing$`, 'u'))
    expect((await lstat(ctx.physicalHome).then(() => true, () => false))).toBe(false)
  })

  linux('hashes the candidate and staged creation receipts as written', async () => {
    const ctx = await fixture()
    const output = await materializeLinuxRsiNativeInStage(input(ctx))

    const candidatePath = join(ctx.sourceHome, CREATION_RECEIPT)
    const stagedPath = staged(ctx, CREATION_RECEIPT)
    expect(output.candidateReceiptSha256).toBe(sha(await readFile(candidatePath)))
    expect(output.receiptSha256).toBe(sha(await readFile(stagedPath)))
    // The relocation resealed the staged receipt, so the digests must differ.
    expect(output.candidateReceiptSha256).not.toBe(output.receiptSha256)
  })

  linux('re-verifies the staged trees when replaying a sealed proof', async () => {
    const ctx = await fixture()
    const first = await materializeLinuxRsiNativeInStage(input(ctx))
    // Any byte inside a proof-covered tree must invalidate the sealed proof: the
    // replay re-hashes the staged copies instead of trusting the recorded digests.
    await writeFile(join(staged(ctx, RUNTIME_RELATIVE), 'tamper.dat'), 'tampered\n')
    await expect(materializeLinuxRsiNativeInStage(input(ctx, first.relocation))).rejects.toThrow(
      new RegExp(`^${RELOCATION_PREFIX}relocated tree differs$`, 'u'))
  })

  linux('replays a sealed proof against the staged Home', async () => {
    const ctx = await fixture()
    const first = await materializeLinuxRsiNativeInStage(input(ctx))
    const replay = await materializeLinuxRsiNativeInStage(input(ctx, first.relocation))
    expect(replay).toEqual(first)

    // A second relocation without the proof would have to copy onto occupied targets.
    await expect(materializeLinuxRsiNativeInStage(input(ctx))).rejects.toThrow(
      new RegExp(`^${RELOCATION_PREFIX}.*relocation target already exists`, 'u'))
  })

  // The identity guard runs before any Linux-only copy or read, so these
  // rejections are the same on macOS and Linux.
  test('rejects a replay proof that describes another Home pair', async () => {
    const ctx = await fixture()
    const proof = { schemaVersion: 1, backend: 'linux-native', profile: PROFILE,
      sourceHome: ctx.sourceHome, physicalHome: ctx.physicalHome, logicalHome: join(ctx.logicalHome, 'other'),
      behaviorRootRelative: `rsi-authorities/${PROFILE}/state/linux-creation-behavior/runtime`,
      elements: [], digests: { runtime: '', repository: '', behavior: '', creation: '', release: '',
        relocation: '' } } as unknown as LinuxRsiNativeRelocationProof
    await expect(materializeLinuxRsiNativeInStage(input(ctx, proof))).rejects.toThrow(
      new RegExp(`^${PREFIX}.*replay relocation proof does not describe this Home pair`, 'u'))
  })

  test('rejects an existingLogicalHome that is not this logical Home', async () => {
    const ctx = await fixture()
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx),
      existingLogicalHome: join(ctx.logicalHome, 'other') })).rejects.toThrow(
      new RegExp(`^${PREFIX}.*existing logical Home is not this logical Home`, 'u'))
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx),
      existingLogicalHome: 'relative-home' })).rejects.toThrow(
      new RegExp(`^${PREFIX}invalid existing logical Home`, 'u'))
  })

  test('rejects overlapping candidate, staged and logical Homes', async () => {
    const ctx = await fixture()
    const fragment = new RegExp(`^${PREFIX}.*candidate, staged and logical Homes must be disjoint`, 'u')
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx), stagePhysicalHome: ctx.sourceHome }))
      .rejects.toThrow(fragment)
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx), stagePhysicalHome: ctx.logicalHome,
      logicalHome: ctx.logicalHome })).rejects.toThrow(fragment)
    await expect(materializeLinuxRsiNativeInStage({ ...input(ctx), logicalHome: ctx.sourceHome }))
      .rejects.toThrow(fragment)
  })

  test('rejects a missing candidate creation receipt', async () => {
    const ctx = await fixture()
    await rm(join(ctx.sourceHome, 'rsi-linux-creation-builds'), { recursive: true, force: true })
    await expect(materializeLinuxRsiNativeInStage(input(ctx))).rejects.toThrow(
      new RegExp(`^${PREFIX}.*missing creation receipt: `, 'u'))
  })

  // Receipt hardening is filesystem-only, so macOS exercises it too.
  test('rejects a candidate receipt that is not owner-private', async () => {
    const ctx = await fixture()
    await chmod(join(ctx.sourceHome, CREATION_RECEIPT), 0o644)
    await expect(materializeLinuxRsiNativeInStage(input(ctx))).rejects.toThrow(
      new RegExp(`^${PREFIX}unsafe creation receipt: `, 'u'))
  })

  test('rejects a candidate receipt symlinked over the private file', async () => {
    const ctx = await fixture()
    const path = join(ctx.sourceHome, CREATION_RECEIPT)
    const target = join(ctx.sourceHome, 'candidate-receipt-copy.json')
    await writeFile(target, await readFile(path), { mode: 0o600 })
    await rm(path)
    await symlink(target, path)
    await expect(materializeLinuxRsiNativeInStage(input(ctx))).rejects.toThrow(
      new RegExp(`^${PREFIX}unsafe creation receipt: `, 'u'))
  })
})
