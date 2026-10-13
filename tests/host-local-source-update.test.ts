import { afterEach, expect, test, vi } from 'vitest'
import { chmod, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  bind: vi.fn(), assert: vi.fn(), load: vi.fn(),
  auxVerify: vi.fn(), auxMaterialize: vi.fn(), auxVerifyHome: vi.fn(),
}))
vi.mock('../scripts/install/local-source-maintenance.mjs', () => ({
  bindLocalSourceInstaller: mocks.bind,
  assertLocalSourceInstaller: mocks.assert,
  loadLocalSourceInstaller: mocks.load,
}))
vi.mock('../scripts/install/host-local-artifacts.mjs', () => ({
  prepareHostLocalArtifacts: vi.fn(),
  verifyHostLocalArtifacts: mocks.auxVerify,
  materializeHostLocalArtifacts: mocks.auxMaterialize,
  verifyHostLocalArtifactsInHome: mocks.auxVerifyHome,
}))

import { prepareHostLocalSourceUpdate, stageHostLocalSourceUpdate,
  stageResourcesForPreparation, verifyHostLocalSourceUpdate,
  finalizeHostLocalSourceUpdate } from '../scripts/install/host-local-source-update.mjs'

const roots: string[] = []
afterEach(async () => {
  vi.resetAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-source-')))
  roots.push(root)
  const homePath = join(root, 'home'), profile = 'assistant', preparationRoot = join(root, 'prepared')
  const installerRoot = join(root, 'installer'), disposableHome = join(root, 'disposable'), stageHome = join(root, 'stage')
  for (const path of [homePath, preparationRoot, installerRoot]) await mkdir(path, { mode: 0o700 })
  for (const path of ['rsi-authorities/assistant/config', 'rsi-sources/assistant', 'rsi-coordinators',
    'profiles/assistant', 'rsi-local-cohorts/assistant/artifacts']) await mkdir(join(homePath, path), { recursive: true, mode: 0o700 })
  for (const path of ['rsi-authorities/assistant/bootstrap.json', 'rsi-sources/assistant/bootstrap.json',
    '.rsi-coordinator-54a0e8c17b9b8aee.json']) {
    await writeFile(join(homePath, path), 'private', { mode: 0o600 })
  }
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    await writeFile(join(homePath, 'profiles/assistant', name), name === 'package.json'
      ? JSON.stringify({ dependencies: { '@dsh-enhanced/assistant-policy': '0.1.48' } }) : 'metadata', { mode: 0o644 })
  }
  const marker = `.rsi-coordinator-${(await import('node:crypto')).createHash('sha256').update(profile).digest('hex').slice(0, 16)}.json`
  await rm(join(homePath, '.rsi-coordinator-54a0e8c17b9b8aee.json'))
  await writeFile(join(homePath, marker), 'private', { mode: 0o600 })
  await cp(homePath, disposableHome, { recursive: true })
  await cp(homePath, stageHome, { recursive: true })
  await chmod(disposableHome, 0o700)
  await chmod(stageHome, 0o700)
  await mkdir(join(stageHome, 'profiles', profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane'),
    { recursive: true, mode: 0o700 })
  const originalSource = { workspace: { version: '0.1.48', sourceCommit: '1'.repeat(40) },
    originalBootstrapDigest: 'a'.repeat(64), records: [], anchor: { installationId: 'installation' } }
  const preOwner = { mode: 'pre-owner', anchor: originalSource.anchor, records: originalSource.records,
    workspace: originalSource.workspace, preparedCoordinator: { profile: 'rsi-assistant', receiptDigest: 'b'.repeat(64), cohortDigest: 'c'.repeat(64) } }
  const originalCohort = { receiptDigest: 'c'.repeat(64), version: '0.1.48', sourceRepository: join(root, 'source') }
  const candidateHome = join(preparationRoot, 'home')
  const candidatePackage = { name: '@dsh-enhanced/assistant-policy', sha256: 'd'.repeat(64),
    runtimeDependencies: [], files: [{ path: 'package.json', sha256: 'e'.repeat(64), mode: 0o644 }] }
  const preparedCohort = { root: join(candidateHome, 'rsi-local-cohorts', profile), receiptDigest: 'f'.repeat(64),
    version: '0.1.49', sourceCommit: '2'.repeat(40), packages: [{ ...candidatePackage,
      tarball: join(candidateHome, 'rsi-local-cohorts', profile, 'artifacts', 'assistant-policy.tgz') }] }
  const preparation = { receiptDigest: '9'.repeat(64), originalCohortDigest: originalCohort.receiptDigest,
    candidateHome, cohort: preparedCohort, source: { sourceCommit: preparedCohort.sourceCommit, root: join(preparationRoot, 'source') } }
  const stagedCohort = { ...preparedCohort, root: join(homePath, 'rsi-local-cohorts', profile),
    receiptDigest: '8'.repeat(64), packages: [{ ...candidatePackage,
      tarball: join(homePath, 'rsi-local-cohorts', profile, 'artifacts', 'assistant-policy.tgz') }] }
  const record = { host: null, before: { cohortDigest: originalCohort.receiptDigest },
    after: { cohortDigest: stagedCohort.receiptDigest } }
  const stagedSources = new Map<string, unknown>()
  const runtime = { packageVersion: '0.1.48', root: join(homePath, 'rsi-authority-runtimes', profile) }
  const runtimeReceipts = new Map<string, unknown>()
  const api = {
    readRsiLocalUpdateLocked: vi.fn(async () => preparation),
    assertRsiPreOwnerInstallation: vi.fn(async () => preOwner),
    readRsiSourceMaintenance: vi.fn(async ({ physicalHome }: { physicalHome: string }) => stagedSources.get(physicalHome) ?? originalSource),
    readRsiLocalCohort: vi.fn(async () => originalCohort),
    stageRsiLocalUpdateResources: vi.fn(async ({ stagePhysicalHome }: { stagePhysicalHome: string }) => {
      await writeFile(join(stagePhysicalHome, 'rsi-local-cohorts', profile, 'receipt.json'),
        JSON.stringify(stagedCohort), { mode: 0o600 })
      return { cohort: stagedCohort,
        proof: { schemaVersion: 1, preparationDigest: preparation.receiptDigest } }
    }),
    produceRsiLocalSourceMaintenance: vi.fn(async () => record),
    applyRsiSourceMaintenanceInStage: vi.fn(async ({ physicalHome }: { physicalHome: string }) => {
      stagedSources.set(physicalHome, { ...originalSource,
        workspace: { version: stagedCohort.version, sourceCommit: stagedCohort.sourceCommit }, records: [record] })
      await writeFile(join(physicalHome, 'rsi-sources', profile, 'maintenance.json'), 'signed', { mode: 0o600 })
    }),
    verifyRsiLocalUpdateResources: vi.fn(async () => undefined),
    readRsiAuthorityRuntimeReceipt: vi.fn(async ({ physicalHome }: { physicalHome: string }) => runtimeReceipts.get(physicalHome)
      ?? { runtime, receiptDigest: '5'.repeat(64) }),
    replaceRsiAuthorityRuntimeInStage: vi.fn(async ({ physicalHome }: { physicalHome: string }) => {
      const candidateRuntime = { ...runtime, packageVersion: '0.1.49' }
      runtimeReceipts.set(physicalHome, { runtime: candidateRuntime, receiptDigest: '6'.repeat(64) })
      return candidateRuntime
    }),
  }
  mocks.bind.mockResolvedValue({ root: installerRoot, digest: 'installer' })
  mocks.load.mockResolvedValue(api)
  return { root, homePath, profile, preparationRoot, installerRoot, disposableHome, stageHome,
    api, record, stagedCohort, candidatePackage, stagedSources }
}

test('binds reviewed pre-owner source and rebases authenticated artifacts for disposable preparation', async () => {
  const setup = await fixture()
  await mkdir(join(setup.homePath, 'profiles', 'node_modules'), { mode: 0o755 })
  const proof = await prepareHostLocalSourceUpdate(setup)
  expect(proof.original.preOwner.preparedCoordinator).toBeTruthy()
  expect(Object.keys(proof.candidateArtifacts)).toEqual([setup.candidatePackage.name])
  const result = await stageResourcesForPreparation({ proof: JSON.parse(JSON.stringify(proof)),
    homePath: setup.homePath, disposableHome: setup.disposableHome })
  expect(result.cohort.receiptDigest).toBe(setup.stagedCohort.receiptDigest)
  expect(result.candidateArtifacts[setup.candidatePackage.name]).toMatchObject({
    sha256: setup.candidatePackage.sha256,
    runtimeDependencies: setup.candidatePackage.runtimeDependencies,
    files: setup.candidatePackage.files,
    tarball: join(setup.homePath, 'rsi-local-cohorts', setup.profile, 'artifacts', 'assistant-policy.tgz'),
    sourcePath: join(setup.disposableHome, 'rsi-local-cohorts', setup.profile, 'artifacts', 'assistant-policy.tgz'),
  })
  expect(setup.api.produceRsiLocalSourceMaintenance).not.toHaveBeenCalled()
})

test('signs host-null source maintenance before package changes and verifies candidate chain', async () => {
  const setup = await fixture()
  const proof = await prepareHostLocalSourceUpdate(setup)
  const signed = await stageHostLocalSourceUpdate({ proof, homePath: setup.homePath, stageHome: setup.stageHome })
  expect(signed.record.host).toBeNull()
  expect(signed.stagedCohortDigest).toBe(setup.stagedCohort.receiptDigest)
  expect(setup.api.produceRsiLocalSourceMaintenance).toHaveBeenCalledWith(expect.objectContaining({
    maintenanceMode: 'pre-owner', preparedCoordinator: true,
  }))
  await verifyHostLocalSourceUpdate({ proof: signed, homePath: setup.homePath,
    physicalHome: setup.stageHome, selection: 'candidate' })
  expect(setup.api.verifyRsiLocalUpdateResources).toHaveBeenCalled()
  const finalized = await finalizeHostLocalSourceUpdate({ proof: signed, homePath: setup.homePath,
    stageHome: setup.stageHome })
  expect(finalized.candidateRuntime.receiptDigest).toBe('6'.repeat(64))
  expect(setup.api.replaceRsiAuthorityRuntimeInStage).toHaveBeenCalledWith(expect.objectContaining({
    logicalHome: setup.homePath, physicalHome: setup.stageHome }), expect.objectContaining({
    packageRoot: join(setup.stageHome, 'profiles', setup.profile, 'node_modules', '@dsh-enhanced', 'plugin-control-plane'),
  }))
})

test('rejects unexpected authority owners and candidate authority mutation', async () => {
  const setup = await fixture()
  await mkdir(join(setup.homePath, 'rsi-authorities', 'other'), { mode: 0o700 })
  await expect(prepareHostLocalSourceUpdate(setup)).rejects.toThrow(/other rsi-authorities/u)
  await rm(join(setup.homePath, 'rsi-authorities', 'other'), { recursive: true })
  const proof = await prepareHostLocalSourceUpdate(setup)
  const signed = await stageHostLocalSourceUpdate({ proof, homePath: setup.homePath, stageHome: setup.stageHome })
  await writeFile(join(setup.stageHome, 'rsi-authorities', 'assistant', 'config', 'grant'), 'changed', { mode: 0o600 })
  await expect(verifyHostLocalSourceUpdate({ proof: signed, homePath: setup.homePath,
    physicalHome: setup.stageHome, selection: 'candidate' })).rejects.toThrow(/candidate authority/u)
})

test('requires an explicit auxiliary preparation for enhanced roots absent from the candidate cohort', async () => {
  const setup = await fixture()
  await mkdir(join(setup.homePath, 'profiles', 'acp'), { mode: 0o700 })
  await writeFile(join(setup.homePath, 'profiles', 'acp', 'package.json'), JSON.stringify({
    dependencies: { '@dsh-enhanced/acp': '0.1.48' },
  }), { mode: 0o644 })
  await expect(prepareHostLocalSourceUpdate(setup)).rejects.toThrow(/explicit auxiliary preparation root/u)
})

test('rejects a candidate cohort receipt whose digest no longer matches signed maintenance', async () => {
  const setup = await fixture()
  const proof = await prepareHostLocalSourceUpdate(setup)
  const signed = await stageHostLocalSourceUpdate({ proof, homePath: setup.homePath, stageHome: setup.stageHome })
  await writeFile(join(setup.stageHome, 'rsi-local-cohorts', setup.profile, 'receipt.json'),
    JSON.stringify({ ...setup.stagedCohort, receiptDigest: '0'.repeat(64) }), { mode: 0o600 })
  await expect(verifyHostLocalSourceUpdate({ proof: signed, homePath: setup.homePath,
    physicalHome: setup.stageHome, selection: 'candidate' })).rejects.toThrow(/candidate cohort receipt/u)
})

test('retains the primary locator for byte-identical auxiliary closure packages', async () => {
  const setup = await fixture()
  const prepared = await prepareHostLocalSourceUpdate(setup)
  const proof = { ...prepared, auxiliary: { protocol: 'verified-auxiliary' } }
  const name = setup.candidatePackage.name
  const duplicate = { ...prepared.candidateArtifacts[name], name: undefined,
    tarball: join(setup.homePath, 'rsi-local-cohorts', 'host-migration-test', 'artifacts', 'assistant-policy.tgz'),
    sourcePath: join(setup.disposableHome, 'rsi-local-cohorts', 'host-migration-test', 'artifacts', 'assistant-policy.tgz') }
  mocks.auxMaterialize.mockResolvedValue({ artifacts: { [name]: duplicate } })
  mocks.auxVerifyHome.mockResolvedValue({ artifacts: { [name]: duplicate } })
  const staged = await stageResourcesForPreparation({ proof, homePath: setup.homePath,
    disposableHome: setup.disposableHome })
  expect(staged.candidateArtifacts[name]).toMatchObject({
    tarball: prepared.candidateArtifacts[name].tarball,
    sourcePath: join(setup.disposableHome, 'rsi-local-cohorts', setup.profile, 'artifacts', 'assistant-policy.tgz'),
  })
  const signed = await stageHostLocalSourceUpdate({ proof, homePath: setup.homePath, stageHome: setup.stageHome })
  expect(signed.stagedArtifacts[name].tarball).toBe(prepared.candidateArtifacts[name].tarball)
  expect(mocks.auxVerify).toHaveBeenCalled()
  expect(mocks.auxMaterialize).toHaveBeenCalledTimes(2)
  expect(mocks.auxVerifyHome).toHaveBeenCalled()
})

test.each([
  ['package name', { name: '@dsh-enhanced/other' }],
  ['version', { version: '0.1.50' }],
  ['archive digest', { sha256: '0'.repeat(64) }],
  ['file inventory', { files: [{ path: 'package.json', sha256: '0'.repeat(64), mode: 0o644 }] }],
  ['runtime dependencies', { runtimeDependencies: ['@dsh-enhanced/other'] }],
])('rejects overlapping auxiliary packages with different %s', async (_label, changed) => {
  const setup = await fixture()
  const prepared = await prepareHostLocalSourceUpdate(setup)
  const proof = { ...prepared, auxiliary: { protocol: 'verified-auxiliary' } }
  const name = setup.candidatePackage.name
  mocks.auxMaterialize.mockResolvedValue({ artifacts: { [name]: {
    ...prepared.candidateArtifacts[name], ...changed,
    tarball: join(setup.homePath, 'rsi-local-cohorts', 'host-migration-test', 'artifacts', 'assistant-policy.tgz'),
  } } })
  await expect(stageResourcesForPreparation({ proof, homePath: setup.homePath,
    disposableHome: setup.disposableHome })).rejects.toThrow(/conflicting candidate artifact/u)
})
