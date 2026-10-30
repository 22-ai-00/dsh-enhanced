import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { inspectLinuxRunnerState, linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { parse } from 'yaml'
import * as sources from '../src/rsi-source.js'
import * as authorityRuntime from '../src/rsi-authority-runtime.js'
import * as authorityResources from '../src/rsi-authority-resources.js'
import * as nativeBase from '../src/rsi-linux-runtime-bootstrap.js'
import * as nativeRepository from '../src/rsi-linux-repository-bootstrap.js'
import * as nativeCreation from '../src/rsi-linux-creation-build.js'
import * as cgroups from '../src/rsi-linux-cgroup-roots.js'
import * as releases from '../src/rsi-release-build.js'
import * as dockerBuild from '../src/rsi-build.js'
import * as dockerCreation from '../src/rsi-creation-build.js'
import * as runnerState from '../src/rsi-linux-runner-states.js'
import { createRsiBootstrapManifest } from '../src/rsi-bootstrap-manifest.js'
import { installRsiOwnerDeployment, rsiInstallPorts, type RsiInstallPorts } from '../src/rsi-install.js'
import type { RsiSetupManifest } from '../src/rsi-profile.js'
import { runtimeConfigDigest } from '@dsh-enhanced/plugin-control-plane'
import { rsiBootstrapFixture } from './fixtures/rsi-bootstrap.js'
import { nativePreparedFixture } from './fixtures/rsi-linux-install.js'

afterEach(() => { vi.restoreAllMocks() })
const roles = {
  sourceBuild: ['linux-source-build-runner', 'repository'], creationReview: ['creation-review-runner', 'verification'],
  creationAdoption: ['creation-adoption-runner', 'verification'], revisionReview: ['revision-review-runner', 'verification'],
  revisionRegression: ['revision-regression-runner', 'verification'],
} as const

async function treeIdentity(path: string): Promise<unknown[]> {
  const rows: unknown[] = []
  const visit = async (current: string): Promise<void> => {
    const info = await lstat(current, { bigint: true })
    rows.push([current, String(info.dev), String(info.ino), String(info.mode), String(info.mtimeNs), String(info.ctimeNs),
      info.isFile() ? createHash('sha256').update(await readFile(current)).digest('hex') : undefined])
    if (info.isDirectory()) for (const name of (await readdir(current)).sort()) await visit(join(current, name))
  }
  await visit(path)
  return rows
}
function assertEmptyLedger(path: string): void {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true })
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(8)
    expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get()?.n).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS n FROM isolation_grants').get()?.n).toBe(0)
  } finally { db.close() }
}
function recordControllerHistory(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.prepare('INSERT INTO isolation_controller(singleton,owner_id,fence,expires_at) VALUES(1,?,?,?)')
      .run('previous-controller', 3, 1)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally { db.close() }
}
function assertControllerHistory(path: string): void {
  const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true })
  try {
    expect(db.prepare('SELECT owner_id,fence,expires_at FROM isolation_controller WHERE singleton=1').get())
      .toMatchObject({ owner_id: 'previous-controller', fence: 3, expires_at: 1 })
  } finally { db.close() }
}

let baseline: Awaited<ReturnType<typeof rsiBootstrapFixture>> | undefined
async function fixture() {
  if (!baseline) throw new Error('preparation baseline is unavailable')
  const base = baseline
  // Source, keys and authority programs are immutable shared fixture inputs.
  // Each case gets new empty, ungranted ledgers and a fresh candidate manifest.
  await rm(join(base.input.resources.configRoot, 'manifest.json'), { force: true })
  await rm(join(base.input.resources.stateRoot, 'native-runner-states'), { recursive: true, force: true })
  for (const [name] of Object.values(roles)) await rm(join(base.input.resources.stateRoot, name), { recursive: true, force: true })
  const native = await nativePreparedFixture(base.input.resources, base.input.source)
  const resources = base.input.resources, source = base.input.source
  const home = dirname(dirname(resources.root)), input = { dshHome: home, profile: base.input.manifest.targetProfile }
  const baseRoot = join(home, 'rsi-linux-runtimes', input.profile, 'runtime'), original = native.repository.runtime
  const runtime: LinuxRuntime = { ...structuredClone(original), root: { ...original.root, path: baseRoot, ino: original.root.ino + 10 },
    nodePath: join(baseRoot, 'bin/node'), pnpmPath: join(baseRoot, 'pnpm/bin/pnpm.mjs'), nativePnpmRoot: join(baseRoot, 'pnpm-native'),
    nativePnpmPath: join(baseRoot, 'pnpm-native/pnpm'), modulesPath: join(baseRoot, 'node_modules'),
    storePath: join(baseRoot, 'store'), cachePath: join(baseRoot, 'cache') }
  const linuxBase: nativeBase.LinuxRsiBuildEnvironment = { schemaVersion: 3, backend: 'linux-native',
    sourceCommit: source.sourceCommit, lockSha256: runtime.lockSha256, runtime }
  const nativeRelease: releases.NativeRsiReleaseBuildEnvironment = { schemaVersion: 2, backend: 'linux-native',
    sourceCommit: source.sourceCommit, runtimeDigest: linuxRuntimeDigest(runtime), releaseBuild: base.input.releaseBuild }
  const legacyConfig = base.input.manifest.controlPlane.sourceBuild!
  if ('backend' in legacyConfig) throw new Error('expected Docker baseline fixture')
  const legacy: dockerBuild.RsiBuildEnvironment = { schemaVersion: 1, sourceCommit: source.sourceCommit,
    sourceBuild: { ...legacyConfig, versioning: 'patch' } }
  const legacyCreation: dockerCreation.RsiCreationBuildEnvironment = { schemaVersion: 1, sourceCommit: source.sourceCommit,
    sourceImage: legacy.sourceBuild.image, image: 'sha256:' + 'f'.repeat(64), dockerPath: legacy.sourceBuild.dockerPath }
  const legacyRelease: releases.RsiReleaseBuildEnvironment = { schemaVersion: 1, sourceCommit: source.sourceCommit,
    image: legacy.sourceBuild.image, releaseBuild: base.input.releaseBuild }
  const spies = {
    source: vi.spyOn(sources, 'prepareRsiSourceWorkspace').mockResolvedValue(source),
    authorityRuntime: vi.spyOn(authorityRuntime, 'prepareRsiAuthorityRuntime').mockResolvedValue(base.input.runtime),
    resources: vi.spyOn(authorityResources, 'prepareRsiAuthorityResources').mockResolvedValue(resources),
    prepareBase: vi.spyOn(nativeBase, 'prepareLinuxRsiRuntime').mockResolvedValue(linuxBase),
    readBase: vi.spyOn(nativeBase, 'readLinuxRsiRuntime').mockResolvedValue(linuxBase),
    prepareRepository: vi.spyOn(nativeRepository, 'prepareLinuxRsiRepositoryRuntime').mockResolvedValue(native.repository),
    readRepository: vi.spyOn(nativeRepository, 'readLinuxRsiRepositoryRuntime').mockResolvedValue(native.repository),
    prepareCreation: vi.spyOn(nativeCreation, 'prepareLinuxRsiCreationBuildEnvironment').mockResolvedValue(native.creationBuild),
    readCreation: vi.spyOn(nativeCreation, 'readLinuxRsiCreationBuildEnvironment').mockResolvedValue(native.creationBuild),
    cgroups: vi.spyOn(cgroups, 'discoverLinuxCgroupRoots').mockResolvedValue(native.cgroupRoots),
    prepareRelease: vi.spyOn(releases, 'prepareRsiReleaseBuildEnvironment').mockResolvedValue(nativeRelease),
    readRelease: vi.spyOn(releases, 'readRsiReleaseBuildEnvironment').mockResolvedValue(nativeRelease),
    docker: vi.spyOn(dockerBuild, 'verifyRsiBuildEnvironmentReady').mockResolvedValue(legacy),
    dockerCreation: vi.spyOn(dockerCreation, 'verifyRsiCreationBuildEnvironmentReady').mockResolvedValue(legacyCreation),
    // The default spy records the call and runs the real SQLite/seal helper.
    states: vi.spyOn(runnerState, 'prepareRsiLinuxRunnerStates'),
  }
  const manifestInput = {
    dshHome: home, targetProfile: input.profile, coordinatorProfile: base.input.manifest.coordinatorProfile,
    targetEffective: base.profiles.targetEffective, owner: base.binding, resources, runtime: base.input.runtime, source,
    sourceBuild: native.sourceBuild, creationBuild: native.creationBuild, runnerStates: native.runnerStates,
    git: base.input.manifest.sourceReviews.git, now: base.input.now,
    expiresAt: base.input.manifest.controlPlane.sourceJobs!.expiresAt,
    plugins: base.input.manifest.sourceReviews.plugins,
    hostDeploymentInputs: base.input.manifest.controlPlane.sourceAdoptions!.hostDeploymentInputs!,
    observerTargets: [{ entryId: 'dsh-enhanced-assistant-delivery', module: '@dsh-enhanced/assistant-delivery', services: ['assistantDelivery'],
      configDigest: runtimeConfigDigest((parse(base.profiles.targetEffective) as Array<{ id: string; config: unknown }>)
        .find(row => row.id === 'dsh-enhanced-assistant-delivery')!.config) }],
  }
  const save = async (manifest: RsiSetupManifest): Promise<string> => {
    const bytes = JSON.stringify(manifest)
    await writeFile(join(resources.configRoot, 'manifest.json'), bytes, { mode: 0o600 })
    return bytes
  }
  const prepare = () => rsiInstallPorts.prepare(input, new AbortController().signal)
  return { base, native, resources, source, input, linuxBase, nativeRelease, legacy, legacyCreation, legacyRelease,
    spies, manifestInput, save, prepare }
}
function noNativePreparation(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.spies.prepareBase).not.toHaveBeenCalled(); expect(f.spies.prepareRepository).not.toHaveBeenCalled()
  expect(f.spies.prepareCreation).not.toHaveBeenCalled(); expect(f.spies.prepareRelease).not.toHaveBeenCalled()
}
function noNative(f: Awaited<ReturnType<typeof fixture>>): void {
  noNativePreparation(f)
  expect(f.spies.readBase).not.toHaveBeenCalled(); expect(f.spies.readRepository).not.toHaveBeenCalled()
  expect(f.spies.readCreation).not.toHaveBeenCalled(); expect(f.spies.cgroups).not.toHaveBeenCalled()
  expect(f.spies.states).not.toHaveBeenCalled()
}
async function removeRole(f: Awaited<ReturnType<typeof fixture>>, role: keyof typeof roles): Promise<void> {
  const ref = f.native.runnerStates[role]!
  await rm(ref.path)
  await rm(join(f.resources.stateRoot, roles[role][0]), { recursive: true })
}

// External environment preparation is replaced with descriptor suppliers. The
// installer branch, existing manifest validation, SQLite state and seals are real.
describe.runIf(process.platform === 'linux' && process.getuid!() > 0).sequential('actual install preparation branches', () => {
  beforeAll(async () => { baseline = await rsiBootstrapFixture() }, 30_000)
  afterAll(async () => { await baseline?.cleanup(); baseline = undefined })
  test('new installation prepares native base for release and schema4 repository for source, with five real sealed ledgers', async () => {
    const f = await fixture()
    for (const role of Object.keys(roles) as Array<keyof typeof roles>) await removeRole(f, role)
    await rm(join(f.resources.stateRoot, 'native-runner-states'), { recursive: true })
    const result = await f.prepare()
    expect(f.spies.prepareBase).toHaveBeenCalledOnce(); expect(f.spies.prepareRepository).toHaveBeenCalledOnce()
    expect(f.spies.prepareCreation).toHaveBeenCalledOnce(); expect(f.spies.prepareRelease).toHaveBeenCalledOnce()
    expect(f.spies.readBase).not.toHaveBeenCalled(); expect(f.spies.readRepository).not.toHaveBeenCalled()
    expect(f.spies.readCreation).not.toHaveBeenCalled(); expect(f.spies.readRelease).not.toHaveBeenCalled()
    expect(f.spies.docker).not.toHaveBeenCalled(); expect(f.spies.dockerCreation).not.toHaveBeenCalled()
    expect(f.spies.prepareRelease.mock.calls[0]![0].build).toEqual(f.linuxBase)
    expect(result.release).toEqual(f.nativeRelease)
    expect(result.build.sourceBuild).toEqual(f.native.sourceBuild)
    expect(result.creationBuild).toEqual(f.native.creationBuild)
    expect(f.spies.states).toHaveBeenCalledWith(f.resources, { creation: true, revision: true }, undefined)
    expect(Object.keys(result.runnerStates!).sort()).toEqual(Object.keys(roles).sort())
    for (const [role, [name, kind]] of Object.entries(roles)) {
      const ref = result.runnerStates![role as keyof typeof roles]!, stateRoot = join(f.resources.stateRoot, name)
      expect(() => inspectLinuxRunnerState({ stateRoot, stateSeal: ref, kind })).not.toThrow()
      assertEmptyLedger(join(stateRoot, 'ledger.sqlite'))
    }
  })

  test('existing complete native installation only reads and retains the original five ledger seals', async () => {
    const f = await fixture(), manifest = createRsiBootstrapManifest(f.manifestInput), bytes = await f.save(manifest)
    const before = await treeIdentity(f.resources.stateRoot), result = await f.prepare()
    noNativePreparation(f)
    expect(f.spies.readBase).toHaveBeenCalledOnce(); expect(f.spies.readRepository).toHaveBeenCalledOnce()
    expect(f.spies.readCreation).toHaveBeenCalledOnce(); expect(f.spies.readRelease.mock.calls[0]![0].build).toEqual(f.linuxBase)
    expect(f.spies.docker).not.toHaveBeenCalled(); expect(f.spies.dockerCreation).not.toHaveBeenCalled()
    expect(result.runnerStates).toEqual(f.native.runnerStates)
    expect(f.spies.states).toHaveBeenCalledWith(f.resources, { creation: true, revision: true }, manifest)
    expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
    expect(await readFile(join(f.resources.configRoot, 'manifest.json'), 'utf8')).toBe(bytes)
  })

  test('existing manifest preserves used sealed state and its controller history without resetting it', async () => {
    const f = await fixture(), manifest = createRsiBootstrapManifest(f.manifestInput), bytes = await f.save(manifest)
    const ledger = join(f.resources.stateRoot, 'revision-review-runner', 'ledger.sqlite')
    assertEmptyLedger(ledger); recordControllerHistory(ledger)
    const before = await treeIdentity(f.resources.stateRoot), result = await f.prepare()
    noNativePreparation(f)
    expect(result.runnerStates).toEqual(f.native.runnerStates)
    assertControllerHistory(ledger)
    expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
    expect(await readFile(join(f.resources.configRoot, 'manifest.json'), 'utf8')).toBe(bytes)
  })

  test('first preparation refuses used sealed state when its manifest is missing', async () => {
    const f = await fixture(), first = await f.prepare()
    const ledger = join(f.resources.stateRoot, 'revision-review-runner', 'ledger.sqlite')
    assertEmptyLedger(ledger); recordControllerHistory(ledger)
    const before = await treeIdentity(f.resources.stateRoot)
    const refs = structuredClone(first.runnerStates)
    const stop = vi.fn(async () => false), collect = vi.fn(async () => { throw new Error('unexpected input collection') })
    const coordinator = vi.fn(async () => {})
    const manifest = join(f.resources.configRoot, 'manifest.json')
    await expect(lstat(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(installRsiOwnerDeployment(f.input, { ...rsiInstallPorts, stop, collect, coordinator }))
      .rejects.toThrow(/empty|ledger|history/u)
    expect(stop).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled(); expect(coordinator).not.toHaveBeenCalled()
    assertControllerHistory(ledger)
    expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
    for (const ref of Object.values(refs!)) {
      expect(createHash('sha256').update(await readFile(ref.path)).digest('hex')).toBe(ref.sha256)
    }
    await expect(lstat(manifest)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test.each(['creation-only', 'modify-only'] as const)('preserves existing native %s scope without adding revision or creation authority', async scope => {
    const f = await fixture()
    const runnerStates: runnerState.RsiLinuxRunnerStates = { sourceBuild: f.native.runnerStates.sourceBuild }
    if (scope === 'creation-only') {
      runnerStates.creationReview = f.native.runnerStates.creationReview!
      runnerStates.creationAdoption = f.native.runnerStates.creationAdoption!
    }
    for (const role of Object.keys(roles) as Array<keyof typeof roles>) {
      if (!(role in runnerStates)) await removeRole(f, role)
    }
    const input = { ...f.manifestInput, runnerStates, enableRevision: false }
    if (scope === 'modify-only') delete (input as Partial<typeof input>).creationBuild
    const manifest = createRsiBootstrapManifest(input); await f.save(manifest)
    const before = await treeIdentity(f.resources.stateRoot), result = await f.prepare()
    noNativePreparation(f)
    expect(result.runnerStates).toEqual(runnerStates)
    expect(result.creationBuild !== undefined).toBe(scope === 'creation-only')
    expect(f.spies.readCreation).toHaveBeenCalledTimes(scope === 'creation-only' ? 1 : 0)
    expect(f.spies.states).toHaveBeenCalledWith(f.resources, { creation: scope === 'creation-only', revision: false }, manifest)
    expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
    expect(manifest.pluginRevision).toBeUndefined()
  })

  test('existing Docker uses actual readiness entrypoints without any native branch', async () => {
    const f = await fixture()
    const { runnerStates: _states, ...legacyInput } = f.manifestInput
    const manifest = createRsiBootstrapManifest({ ...legacyInput, sourceBuild: f.legacy.sourceBuild,
      creationBuild: f.legacyCreation, enableRevision: false })
    await f.save(manifest); f.spies.readRelease.mockResolvedValue(f.legacyRelease)
    const result = await f.prepare()
    noNative(f)
    expect(f.spies.docker).toHaveBeenCalledOnce(); expect(f.spies.dockerCreation).toHaveBeenCalledOnce()
    expect(f.spies.dockerCreation.mock.calls[0]![0].build).toEqual(f.legacy)
    expect(f.spies.readRelease.mock.calls[0]![0].build).toEqual(f.legacy)
    expect(result.build).toEqual(f.legacy); expect(result.creationBuild).toEqual(f.legacyCreation)
    expect(result.release).toEqual(f.legacyRelease); expect(result.runnerStates).toBeUndefined()
  })

  test.each(['source', 'creation'] as const)('missing recorded Docker %s image is not-ready before services stop', async kind => {
    const f = await fixture()
    const { runnerStates: _states, ...legacyInput } = f.manifestInput
    const manifest = createRsiBootstrapManifest({ ...legacyInput, sourceBuild: f.legacy.sourceBuild,
      creationBuild: f.legacyCreation, enableRevision: false })
    await f.save(manifest); f.spies.readRelease.mockResolvedValue(f.legacyRelease)
    const error = new dockerBuild.RsiBuildUnavailableError(`${kind} image missing`)
    if (kind === 'source') f.spies.docker.mockRejectedValueOnce(error)
    else f.spies.dockerCreation.mockRejectedValueOnce(error)
    const stop = vi.fn(async () => false), collect = vi.fn(async () => { throw new Error('unexpected installed input collection') })
    const coordinator = vi.fn(async () => {})
    const ports: RsiInstallPorts = { ...rsiInstallPorts, stop, collect, coordinator }
    const profile = join(f.input.dshHome, 'profiles', f.input.profile, 'cordis.patch.yml'), before = await readFile(profile)
    expect(await installRsiOwnerDeployment(f.input, ports)).toEqual({ mode: 'not-ready', reason: error.message })
    expect(stop).not.toHaveBeenCalled(); expect(collect).not.toHaveBeenCalled(); expect(coordinator).not.toHaveBeenCalled()
    expect(await readFile(profile)).toEqual(before); noNative(f)
  })

  test('missing existing native repository fails without falling back to prepare', async () => {
    const f = await fixture(); await f.save(createRsiBootstrapManifest(f.manifestInput))
    const before = await treeIdentity(f.resources.stateRoot)
    f.spies.readRepository.mockRejectedValueOnce(Object.assign(new Error('repository receipt missing'), { code: 'ENOENT' }))
    await expect(f.prepare()).rejects.toMatchObject({ code: 'ENOENT' })
    noNativePreparation(f)
    expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
  })

  test.each(['source-ledger', 'unused-revision-ledger', 'unused-revision-seal', 'unused-revision-root'] as const)(
    'rejects missing %s in an existing installation without reconstructing it', async missing => {
      const f = await fixture(); await f.save(createRsiBootstrapManifest(f.manifestInput))
      const sourceRoot = join(f.resources.stateRoot, 'linux-source-build-runner')
      const revisionRoot = join(f.resources.stateRoot, 'revision-review-runner')
      assertEmptyLedger(join(revisionRoot, 'ledger.sqlite'))
      const path = missing === 'source-ledger' ? join(sourceRoot, 'ledger.sqlite')
        : missing === 'unused-revision-ledger' ? join(revisionRoot, 'ledger.sqlite')
          : missing === 'unused-revision-seal' ? f.native.runnerStates.revisionReview!.path : revisionRoot
      await rm(path, { recursive: true })
      const before = await treeIdentity(f.resources.stateRoot)
      await expect(f.prepare()).rejects.toThrow()
      noNativePreparation(f)
      await expect(lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await treeIdentity(f.resources.stateRoot)).toEqual(before)
    })

  test('validates persisted creation grant before environmental preparation instead of silently accepting tampering', async () => {
    const f = await fixture(), manifest = structuredClone(createRsiBootstrapManifest(f.manifestInput))
    manifest.pluginCreation!.creation.namePrefix = 'owner-deadbeef-'
    await f.save(manifest)
    await expect(f.prepare()).rejects.toThrow('namespace')
    noNativePreparation(f)
    expect(f.spies.readBase).not.toHaveBeenCalled(); expect(f.spies.docker).not.toHaveBeenCalled()
  })
})
