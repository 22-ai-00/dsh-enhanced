import { chmod, mkdtemp, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { LinuxRsiBuildEnvironment } from '../src/rsi-linux-runtime-bootstrap.js'
import type { RsiLocalCohort } from '../src/rsi-local-cohort.js'
import type { LinuxRsiNativeRelocationProof } from '../src/rsi-linux-native-relocation.js'
import {
  prepareLinuxRsiNativeResources, stageLinuxRsiNativeResources, verifyLinuxRsiNativeResources,
  type LinuxRsiNativeResourceProof,
} from '../src/rsi-linux-native-resources.js'
import { readRsiLocalUpdateLocked, type RsiLocalUpdatePreparation } from '../src/rsi-local-update.js'
import type { NativeRsiReleaseBuildEnvironment } from '../src/rsi-release-build.js'
import { fixture, privateDirectory, PROFILE, readJson, removeFixtureDirectories, sha,
  SOURCE_COMMIT, write, type Fixture } from './fixtures/linux-native-home-fixture.js'

// The preparation reader owns its own trust boundary (see rsi-local-update.spec);
// these tests drive the native handover over real cohort trees, real copies and a
// real rename(2) cutover. Only the optional behavior peer and the reader are faked.
const mocks = vi.hoisted(() => ({ validateBehavior: vi.fn(), behaviorDigest: vi.fn() }))
const PEER = '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  return { ...actual,
    createRequire: (url: string) => Object.assign(
      () => ({ validateLinuxPluginBehaviorRuntime: mocks.validateBehavior,
        linuxPluginBehaviorRuntimeDigest: mocks.behaviorDigest }),
      { resolve: (specifier: string) => specifier === PEER ? specifier : actual.createRequire(url).resolve(specifier) }),
  }
})
vi.mock('../src/rsi-local-update.js', () => ({ readRsiLocalUpdateLocked: vi.fn() }))
const reader = vi.mocked(readRsiLocalUpdateLocked)

const linux = test.runIf(process.platform === 'linux')
const PREFIX = 'rsi Linux native resources: '
const COHORT = 'rsi-local-cohorts'
const extras: string[] = []

beforeEach(() => {
  vi.clearAllMocks()
  mocks.validateBehavior.mockImplementation((value: unknown) => value)
  mocks.behaviorDigest.mockImplementation((value: unknown) => sha(JSON.stringify(value)))
})
afterEach(async () => {
  reader.mockReset()
  await Promise.all(extras.splice(0).map(path => rm(path, { recursive: true, force: true })))
  await removeFixtureDirectories()
})

/** Build the two native build receipts a prepared linux-native candidate carries. */
function nativeBuild(): { sourceBuild: LinuxRsiBuildEnvironment; releaseBuild: NativeRsiReleaseBuildEnvironment } {
  return {
    sourceBuild: { schemaVersion: 3, backend: 'linux-native', sourceCommit: SOURCE_COMMIT,
      lockSha256: sha('lock'), runtime: {} } as unknown as LinuxRsiBuildEnvironment,
    releaseBuild: { schemaVersion: 2, backend: 'linux-native', sourceCommit: SOURCE_COMMIT,
      runtimeDigest: sha('runtime') } as unknown as NativeRsiReleaseBuildEnvironment,
  }
}

interface CohortSeed {
  /** Directory that physically holds the tree. */
  physical: string
  /** Path the receipt records, which stays logical for a copied stage Home. */
  root: string
  sourceRepository: string
  version: string
  tarball: string
}

async function seedCohort(seed: CohortSeed): Promise<RsiLocalCohort> {
  await privateDirectory(seed.physical)
  await privateDirectory(join(seed.physical, 'artifacts'))
  await write(join(seed.physical, 'artifacts', 'target.tgz'), seed.tarball)
  const body = {
    schemaVersion: 1,
    root: seed.root,
    sourceCommit: SOURCE_COMMIT,
    version: seed.version,
    sourceRepository: seed.sourceRepository,
    allowBuilds: { koffi: true },
    bundles: ['target'],
    packages: [{ name: '@dsh-enhanced/target', path: 'plugins/target', bundle: true,
      runtimeDependencies: [], tarball: join(seed.root, 'artifacts', 'target.tgz'),
      sha256: sha(seed.tarball),
      files: [{ path: 'lib/index.js', mode: 0o644, sha256: sha('export {}') }] }],
  }
  const record = { ...body, receiptDigest: sha(JSON.stringify(body)) }
  await write(join(seed.physical, 'receipt.json'), JSON.stringify(record))
  return record as unknown as RsiLocalCohort
}

interface PreparedState {
  prepared: RsiLocalUpdatePreparation
  preparationRoot: string
  originalCohortDigest: string
  sourceRepository: string
}

/** Seed the live logical Home, its stopped stage copy and the prepared candidate,
 * then return the preparation receipt the stage handover re-reads. */
async function preparation(ctx: Fixture,
  build: unknown = nativeBuild()): Promise<PreparedState> {
  await privateDirectory(ctx.logicalHome)
  await privateDirectory(ctx.physicalHome)
  const parent = dirname(ctx.logicalHome)
  const preparationRoot = join(parent, 'preparation')
  const sourceRepository = join(parent, 'upstream')
  await privateDirectory(preparationRoot)
  await privateDirectory(sourceRepository)
  const logicalRoot = join(ctx.logicalHome, COHORT, PROFILE)
  const original = await seedCohort({ physical: logicalRoot, root: logicalRoot,
    sourceRepository, version: '0.1.48', tarball: 'original-tarball' })
  await seedCohort({ physical: join(ctx.physicalHome, COHORT, PROFILE), root: logicalRoot,
    sourceRepository, version: '0.1.48', tarball: 'original-tarball' })
  const cohort = await seedCohort({ physical: join(ctx.sourceHome, COHORT, PROFILE),
    root: join(ctx.sourceHome, COHORT, PROFILE),
    sourceRepository: join(ctx.sourceHome, 'source', 'checkout'),
    version: '0.1.49', tarball: 'candidate-tarball' })
  const body = {
    schemaVersion: 1 as const, mode: 'prepared' as const, dshHome: ctx.logicalHome, profile: PROFILE,
    root: preparationRoot, candidateHome: ctx.sourceHome,
    originalCohortDigest: original.receiptDigest, source: { sourceCommit: SOURCE_COMMIT },
    cohort, build,
  }
  const prepared = { ...body, receiptDigest: sha(JSON.stringify(body)) } as unknown as RsiLocalUpdatePreparation
  reader.mockResolvedValue(prepared)
  return { prepared, preparationRoot, originalCohortDigest: original.receiptDigest, sourceRepository }
}

function stageInput(ctx: Fixture, state: PreparedState) {
  return { logicalHome: ctx.logicalHome, stagePhysicalHome: ctx.physicalHome, profile: PROFILE,
    preparationRoot: state.preparationRoot }
}

async function refusal(value: Promise<unknown> | (() => Promise<unknown>), message: string): Promise<void> {
  await expect(typeof value === 'function' ? value() : value).rejects.toThrow(`${PREFIX}${message}`)
}

/** A canonical Home pair with no seeded preparation, for input-only refusals. */
async function tempHomes(): Promise<{ root: string; logicalHome: string; stage: string;
  preparationRoot: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-native-resources-')))
  extras.push(root)
  const logicalHome = join(root, 'home'), stage = join(root, 'stage')
  const preparationRoot = join(root, 'preparation')
  for (const path of [logicalHome, stage, preparationRoot]) await privateDirectory(path)
  return { root, logicalHome, stage, preparationRoot }
}

describe('rsi Linux native resources input contract', () => {
  test('refuses an unusable stage Home pair before reading the preparation', async () => {
    const homes = await tempHomes()
    await refusal(stageLinuxRsiNativeResources({ ...homes, stagePhysicalHome: homes.logicalHome,
      profile: PROFILE }), 'stage must be a distinct canonical stopped Home outside the preparation root')
    await refusal(stageLinuxRsiNativeResources({ ...homes, stagePhysicalHome: `${homes.stage}/`,
      profile: PROFILE }), 'stage must be a distinct canonical stopped Home outside the preparation root')
    await refusal(stageLinuxRsiNativeResources({ ...homes, stagePhysicalHome: homes.stage,
      profile: '../owner' }), 'stage must be a distinct canonical stopped Home outside the preparation root')
    // A preparation root nested in the stopped Home cannot be rebound atomically.
    await refusal(stageLinuxRsiNativeResources({ ...homes, stagePhysicalHome: homes.stage,
      preparationRoot: join(homes.stage, 'preparation'), profile: PROFILE }),
    'stage must be a distinct canonical stopped Home outside the preparation root')
    expect(reader).not.toHaveBeenCalled()
  })

  test('requires every candidate build receipt to be linux-native', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx, { sourceBuild: { schemaVersion: 2, backend: 'docker',
      sourceCommit: SOURCE_COMMIT }, releaseBuild: nativeBuild().releaseBuild })
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, state)),
      'candidate build is not a Linux native runtime')
    const dockerRelease = await preparation(ctx, { ...nativeBuild(),
      releaseBuild: { schemaVersion: 1, backend: 'docker', sourceCommit: SOURCE_COMMIT } })
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, dockerRelease)),
      'candidate release is not a Linux native release build')
    const foreignCommit = await preparation(ctx, { ...nativeBuild(),
      releaseBuild: { ...nativeBuild().releaseBuild, sourceCommit: '2'.repeat(40) } })
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, foreignCommit)),
      'candidate release source differs')
    const missing = await preparation(ctx, null)
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, missing)),
      'preparation has no candidate build evidence')
  })

  test('audits the proof binding without trusting its claims', async () => {
    const homes = await tempHomes()
    const relocation = { schemaVersion: 1, backend: 'linux-native', logicalHome: homes.logicalHome,
      physicalHome: homes.stage, profile: PROFILE, sourceHome: join(homes.root, 'candidate'),
      behaviorRootRelative: `rsi-authorities/${PROFILE}/state/linux-creation-behavior/runtime`,
      elements: [], digests: {} } as unknown as LinuxRsiNativeRelocationProof
    const proof = { schemaVersion: 1, backend: 'linux-native', logicalHome: homes.logicalHome,
      physicalHome: homes.stage, profile: PROFILE, preparationDigest: sha('preparation'),
      cohortDigest: sha('cohort'), relocation } as unknown as LinuxRsiNativeResourceProof
    await refusal(verifyLinuxRsiNativeResources({ proof: { ...proof,
      relocation: { ...relocation, logicalHome: homes.stage } }, physicalHome: homes.stage }),
    'invalid native resource proof binding')
    await refusal(verifyLinuxRsiNativeResources({ proof: { ...proof, profile: 'bad profile' },
      physicalHome: homes.stage }), 'invalid native resource proof binding')
    const foreign = join(homes.root, 'foreign')
    await privateDirectory(foreign)
    await refusal(verifyLinuxRsiNativeResources({ proof, physicalHome: foreign }),
      'native resource proof does not describe this physical Home')
    await refusal(verifyLinuxRsiNativeResources({ proof, physicalHome: `/${'x'.repeat(8)}/../missing` }),
      'invalid native resource physical Home')
  })
})

describe('rsi Linux native resources handover', () => {
  linux('stages the rebased cohort without publishing native families prematurely', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    const { cohort } = await prepareLinuxRsiNativeResources(stageInput(ctx, state))
    const cohortRoot = join(ctx.logicalHome, COHORT, PROFILE)
    expect(cohort.root).toBe(cohortRoot)
    const { receiptDigest: rebasedDigest, ...rebased } = cohort
    expect(rebasedDigest).toBe(sha(JSON.stringify(rebased)))
    expect(rebasedDigest).not.toBe(state.prepared.cohort.receiptDigest)
    expect(cohort.packages[0]?.tarball).toBe(join(cohortRoot, 'artifacts', 'target.tgz'))
    expect(cohort.sourceCommit).toBe(SOURCE_COMMIT)
    expect(cohort.version).toBe('0.1.49')
    const staged = await readJson(join(ctx.physicalHome, COHORT, PROFILE, 'receipt.json'))
    expect(staged.root).toBe(cohortRoot)
    expect(staged.sourceRepository).toBe(state.sourceRepository)
    expect(staged.receiptDigest).toBe(cohort.receiptDigest)
    expect(JSON.stringify(staged)).not.toContain(ctx.sourceHome)
    // The disposable candidate keeps its own receipt: stage never edits the source.
    const candidate = await readJson(join(ctx.sourceHome, COHORT, PROFILE, 'receipt.json'))
    expect(candidate.root).toBe(join(ctx.sourceHome, COHORT, PROFILE))
    // Nothing native is published before the stage phase.
    await expect(readdir(join(ctx.physicalHome, 'rsi-linux-runtimes'))).rejects.toThrow(/ENOENT/u)
    expect(reader).toHaveBeenCalledWith({ dshHome: ctx.logicalHome, profile: PROFILE,
      root: state.preparationRoot, signal: expect.any(AbortSignal) })
  })

  linux('drops the Docker-era build trees and relocates the native families', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    // A stopped Docker-era stage Home carries one build tree per Docker epoch.
    for (const kind of ['rsi-builds', 'rsi-release-builds', 'rsi-creation-builds']) {
      await privateDirectory(join(ctx.physicalHome, kind, PROFILE))
      await write(join(ctx.physicalHome, kind, PROFILE, 'bootstrap.json'), '{"docker":true}')
    }
    const { cohort, family, proof } = await stageLinuxRsiNativeResources(stageInput(ctx, state))
    // The Docker-era build trees are gone; the native release family now owns
    // rsi-release-builds/<profile> with a linux-native receipt instead.
    expect(await readdir(join(ctx.physicalHome, 'rsi-builds'))).toEqual([])
    expect(await readdir(join(ctx.physicalHome, 'rsi-creation-builds'))).toEqual([])
    const release = await readJson(join(ctx.physicalHome, 'rsi-release-builds', PROFILE, 'bootstrap.json'))
    expect(release).toMatchObject({ schemaVersion: 2, backend: 'linux-native', profile: PROFILE })
    expect(family.runtime.sourceCommit).toBe(SOURCE_COMMIT)
    expect(family.creationBuild.sourceCommit).toBe(SOURCE_COMMIT)
    expect(proof).toMatchObject({ schemaVersion: 1, backend: 'linux-native',
      logicalHome: ctx.logicalHome, physicalHome: ctx.physicalHome, profile: PROFILE,
      preparationDigest: state.prepared.receiptDigest, cohortDigest: cohort.receiptDigest })
    expect(proof.relocation.sourceHome).toBe(ctx.sourceHome)
    expect(proof.relocation.elements.map(item => item.name).sort()).toEqual(
      ['behavior-runtime', 'release-cache', 'release-store', 'release-toolchain', 'repository-runtime',
        'runtime', 'system'])
    await expect(verifyLinuxRsiNativeResources({ proof, physicalHome: ctx.physicalHome })).resolves.toBeUndefined()
    expect(await readdir(join(ctx.physicalHome, 'rsi-linux-runtimes', PROFILE))).toContain('runtime')
    expect(await readdir(join(ctx.physicalHome, 'rsi-linux-creation-builds', PROFILE)))
      .toContain('bootstrap.json')
  })

  linux('refuses an unsafe or divergent stopped stage Home', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    await privateDirectory(join(ctx.physicalHome, 'rsi-builds', PROFILE))
    await chmod(join(ctx.physicalHome, 'rsi-builds', PROFILE), 0o755)
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, state)), 'unsafe staged rsi-builds tree')
    await chmod(join(ctx.physicalHome, 'rsi-builds', PROFILE), 0o700)

    const divergent = await fixture()
    const divergentState = await preparation(divergent)
    await write(join(divergent.physicalHome, COHORT, PROFILE, 'artifacts', 'target.tgz'), 'tampered')
    await refusal(() => stageLinuxRsiNativeResources(stageInput(divergent, divergentState)),
      'copied original cohort differs')
  })

  linux('refuses a preparation that drifted during the cohort swap', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    reader.mockReset()
    reader.mockResolvedValueOnce(state.prepared)
    reader.mockResolvedValueOnce({ ...state.prepared, receiptDigest: sha('drifted') })
    await refusal(() => stageLinuxRsiNativeResources(stageInput(ctx, state)),
      'preparation changed during copy')
    // The rollback restored the stopped stage Home's original cohort.
    const restored = await readJson(join(ctx.physicalHome, COHORT, PROFILE, 'receipt.json'))
    expect(restored.receiptDigest).toBe(state.originalCohortDigest)
  })

  linux('verifies the same proof after the rename(2) cutover', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    const { proof } = await stageLinuxRsiNativeResources(stageInput(ctx, state))
    // The cutover renames the stopped stage Home over the retired original Home,
    // so dev/ino and the sealed content identity survive under the logical path.
    const retired = join(dirname(ctx.logicalHome), 'retired-home')
    await rename(ctx.logicalHome, retired)
    await rename(ctx.physicalHome, ctx.logicalHome)
    await expect(verifyLinuxRsiNativeResources({ proof, physicalHome: ctx.logicalHome })).resolves.toBeUndefined()
    expect(await readdir(join(ctx.logicalHome, 'rsi-linux-runtimes', PROFILE))).toContain('runtime')
    await expect(verifyLinuxRsiNativeResources({ proof, physicalHome: retired }))
      .rejects.toThrow(`${PREFIX}native resource proof does not describe this physical Home`)
  })

  linux('refuses tampered cohorts and unbound physical Homes', async () => {
    const ctx = await fixture()
    const state = await preparation(ctx)
    const { proof } = await stageLinuxRsiNativeResources(stageInput(ctx, state))
    await refusal(verifyLinuxRsiNativeResources({ proof: { ...proof,
      cohortDigest: 'f'.repeat(64) }, physicalHome: ctx.physicalHome }),
    'staged cohort receipt digest differs')
    const tarball = join(ctx.physicalHome, COHORT, PROFILE, 'artifacts', 'target.tgz')
    await chmod(tarball, 0o600)
    await writeFile(tarball, 'tampered')
    await refusal(verifyLinuxRsiNativeResources({ proof, physicalHome: ctx.physicalHome }),
      'staged cohort package differs: @dsh-enhanced/target')
    const unrebased = await readJson(join(ctx.physicalHome, COHORT, PROFILE, 'receipt.json'))
    expect(JSON.stringify(unrebased)).not.toContain(ctx.physicalHome)
    const stagedRoot = join(ctx.physicalHome, COHORT, PROFILE)
    const foreign = join(stagedRoot, 'receipt.json')
    await write(foreign, JSON.stringify({ ...unrebased, root: stagedRoot }))
    await refusal(verifyLinuxRsiNativeResources({ proof, physicalHome: ctx.physicalHome }),
      'native resource receipt digest differs')
  })
})
