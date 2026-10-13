import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { materializeHostLocalArtifacts, prepareHostLocalArtifacts,
  verifyHostLocalArtifacts, verifyHostLocalArtifactsInHome } from '../scripts/install/host-local-artifacts.mjs'
import { prepareRsiLocalCohort, readRsiLocalCohort } from '../plugins/lark-channel/src/rsi-local-cohort.js'
import { prepareRsiSourceWorkspace, readRsiSourceWorkspace } from '../plugins/lark-channel/src/rsi-source.js'
import { localCohortFixture } from '../plugins/lark-channel/tests/fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-host-artifacts-')))
  roots.push(root)
  const homePath = join(root, 'home'), sourcePreparationRoot = join(root, 'preparation')
  const installerRoot = join(root, 'installer'), auxiliaryRoot = join(root, 'auxiliary')
  const stage = join(root, 'stage'), disposable = join(root, 'disposable')
  for (const path of [homePath, sourcePreparationRoot, installerRoot, stage, disposable]) await mkdir(path, { mode: 0o700 })
  const candidateSource = join(sourcePreparationRoot, 'source', 'repository')
  const sourceCommit = 'd'.repeat(40), version = '0.1.48'
  let preparation = { schemaVersion: 1, mode: 'prepared', dshHome: homePath, profile: 'assistant',
    root: sourcePreparationRoot, receiptDigest: 'a'.repeat(64),
    source: { repository: candidateSource, sourceCommit, version },
    cohort: { bundles: ['target'] }, build: { sourceBuild: {}, releaseBuild: {} } }
  let workspace: Record<string, unknown> | undefined
  let cohort: Record<string, unknown> | undefined
  const bundleBytes = Buffer.from('isolated ACP archive bytes')
  const ports = {
    bindInstaller: async (path: string) => ({ root: path, digest: hash('reviewed-installer') }),
    loadInstaller: async () => ({
      readRsiLocalUpdateLocked: async () => preparation,
      prepareRsiLocalCohort: async (input: { dshHome: string; profile: string; source: Record<string, unknown>; bundles: string[] }) => {
        const cohortRoot = join(input.dshHome, 'rsi-local-cohorts', input.profile)
        await mkdir(join(cohortRoot, 'artifacts'), { recursive: true, mode: 0o700 })
        await writeFile(join(cohortRoot, 'artifacts', 'acp.tgz'), bundleBytes, { mode: 0o600 })
        cohort = { schemaVersion: 1, root: cohortRoot, sourceCommit, version, sourceRepository: candidateSource,
          bundles: input.bundles, packages: [{ name: '@dsh-enhanced/acp', path: 'plugins/acp', bundle: true,
            tarball: join(cohortRoot, 'artifacts', 'acp.tgz'), sha256: hash(bundleBytes),
            runtimeDependencies: [], files: [{ path: 'package.json', sha256: hash('manifest'), mode: 0o644 }] }],
          receiptDigest: 'b'.repeat(64) }
        await writeFile(join(cohortRoot, 'receipt.json'), JSON.stringify(cohort), { mode: 0o600 })
        return cohort
      },
      readRsiLocalCohort: async () => cohort,
    }),
    source: {
      prepareRsiSourceWorkspace: async (input: { dshHome: string; profile: string; sourceRepository: string }) => {
        workspace = { sourceCommit, version, origin: { locator: input.sourceRepository },
          repository: join(input.dshHome, 'rsi-sources', input.profile, 'checkout') }
        return workspace
      },
      readRsiSourceWorkspace: async () => workspace,
    },
    build: { prepareRsiLocalUpdateBuild: async () => ({ ports: { build: async () => {} }, evidence: {} }) },
  }
  const input = { sourcePreparationRoot, homePath, profile: 'assistant', installerRoot, root: auxiliaryRoot, bundles: ['acp'] }
  return { root, homePath, sourcePreparationRoot, installerRoot, auxiliaryRoot, stage, disposable,
    input, ports, get preparation() { return preparation }, set preparation(value) { preparation = value }, bundleBytes }
}

test('builds an auxiliary receipt from the exact prepared source and materializes only artifact cohorts', async () => {
  const fixtureData = await fixture()
  const proof = await prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)
  expect(proof).toMatchObject({ protocol: 'dsh-enhanced/host-local-artifacts/v1',
    sourceCommit: fixtureData.preparation.source.sourceCommit, version: fixtureData.preparation.source.version,
    bundles: ['acp'], preparationDigest: fixtureData.preparation.receiptDigest })
  expect(proof.auxiliaryProfile).toMatch(/^host-migration-[a-f0-9]{20}$/u)
  expect((await verifyHostLocalArtifacts({ proof, homePath: fixtureData.homePath }, fixtureData.ports)).cohort.receiptDigest)
    .toBe('b'.repeat(64))
  const first = await materializeHostLocalArtifacts({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.disposable }, fixtureData.ports)
  const second = await materializeHostLocalArtifacts({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)
  const artifact = first.artifacts['@dsh-enhanced/acp']
  expect(artifact).toMatchObject({ version: '0.1.48', sha256: hash(fixtureData.bundleBytes),
    tarball: join(fixtureData.homePath, 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz'),
    sourcePath: join(fixtureData.disposable, 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz') })
  expect(second.artifacts['@dsh-enhanced/acp'].tarball).toBe(artifact.tarball)
  const originalPreparation = fixtureData.preparation
  fixtureData.preparation = { ...fixtureData.preparation, receiptDigest: 'f'.repeat(64) }
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage, skipOriginal: true }, fixtureData.ports)).resolves.toMatchObject({ cohort: second.cohort })
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)).rejects.toThrow('source binding changed')
  fixtureData.preparation = originalPreparation
  expect(await readFile(join(fixtureData.homePath, 'rsi-local-cohorts', proof.auxiliaryProfile, 'receipt.json'))
    .catch(error => error.code)).toBe('ENOENT')
  await expect(materializeHostLocalArtifacts({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)).rejects.toThrow('already exists')
}, 30_000)

test('rejects preparation drift, auxiliary byte drift, and staged receipt or archive drift', async () => {
  const fixtureData = await fixture()
  const proof = await prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)
  const original = fixtureData.preparation
  fixtureData.preparation = { ...original, receiptDigest: 'f'.repeat(64) }
  await expect(verifyHostLocalArtifacts({ proof, homePath: fixtureData.homePath }, fixtureData.ports))
    .rejects.toThrow('source binding changed')
  fixtureData.preparation = original
  const auxTarball = join(fixtureData.auxiliaryRoot, 'home', 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz')
  await writeFile(auxTarball, 'tampered', { mode: 0o600 })
  await expect(verifyHostLocalArtifacts({ proof, homePath: fixtureData.homePath }, fixtureData.ports))
    .rejects.toThrow('auxiliary artifact bytes differ')
  await writeFile(auxTarball, fixtureData.bundleBytes, { mode: 0o600 })
  await materializeHostLocalArtifacts({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)
  const stageTarball = join(fixtureData.stage, 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz')
  await writeFile(stageTarball, 'tampered', { mode: 0o600 })
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)).rejects.toThrow('staged auxiliary artifact differs')
  await writeFile(stageTarball, fixtureData.bundleBytes, { mode: 0o600 })
  await writeFile(join(fixtureData.stage, 'rsi-local-cohorts', proof.auxiliaryProfile, 'receipt.json'), '{}', { mode: 0o600 })
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)).rejects.toThrow('staged auxiliary cohort differs')
}, 30_000)

test('rejects overlapping roots and bundles already in the primary candidate cohort', async () => {
  const fixtureData = await fixture()
  await expect(prepareHostLocalArtifacts({ ...fixtureData.input, root: fixtureData.sourcePreparationRoot }, fixtureData.ports))
    .rejects.toThrow('invalid auxiliary preparation identity')
  await expect(prepareHostLocalArtifacts({ ...fixtureData.input, bundles: ['target'] }, fixtureData.ports))
    .rejects.toThrow('auxiliary source preparation differs')
}, 30_000)

test('reuses verified auxiliary archives without rebuilding and rejects changed inputs', async () => {
  const fixtureData = await fixture()
  const proof = await prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)
  fixtureData.ports.build.prepareRsiLocalUpdateBuild = async () => { throw new Error('unexpected rebuild') }
  await expect(prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)).resolves.toEqual(proof)
  await expect(prepareHostLocalArtifacts({ ...fixtureData.input, bundles: ['other'] }, fixtureData.ports))
    .rejects.toThrow('inputs changed')
  const alternateRoot = join(fixtureData.root, 'alternate-auxiliary')
  await cp(fixtureData.auxiliaryRoot, alternateRoot, { recursive: true })
  await expect(prepareHostLocalArtifacts({ ...fixtureData.input, root: alternateRoot }, fixtureData.ports))
    .rejects.toThrow('inputs changed')
  fixtureData.preparation = { ...fixtureData.preparation, receiptDigest: 'f'.repeat(64) }
  await expect(prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)).rejects.toThrow('source binding changed')
}, 30_000)

test('rejects a staged artifact symlink even when it points to the verified archive', async () => {
  const fixtureData = await fixture()
  const proof = await prepareHostLocalArtifacts(fixtureData.input, fixtureData.ports)
  await materializeHostLocalArtifacts({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)
  const stageTarball = join(fixtureData.stage, 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz')
  const auxiliaryTarball = join(fixtureData.auxiliaryRoot, 'home', 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'acp.tgz')
  await rm(stageTarball)
  await symlink(auxiliaryTarball, stageTarball)
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: fixtureData.homePath,
    physicalHome: fixtureData.stage }, fixtureData.ports)).rejects.toThrow('unsafe file')
}, 30_000)

test('builds and verifies an actual auxiliary archive from the prepared Git commit', async () => {
  const sourceFixture = await localCohortFixture()
  roots.push(sourceFixture.root)
  const sourcePreparationRoot = join(sourceFixture.root, 'prepared-update')
  const candidateRepository = join(sourcePreparationRoot, 'source', 'repository')
  await mkdir(join(sourcePreparationRoot, 'source'), { recursive: true, mode: 0o700 })
  await cp(sourceFixture.source.repository, candidateRepository, { recursive: true })
  const auxiliaryRoot = join(sourceFixture.root, 'auxiliary')
  const installerRoot = sourceFixture.sourceRepository
  const preparation = { schemaVersion: 1, mode: 'prepared', dshHome: sourceFixture.home,
    profile: sourceFixture.profile, root: sourcePreparationRoot, receiptDigest: 'a'.repeat(64),
    source: { repository: candidateRepository, sourceCommit: sourceFixture.source.sourceCommit,
      version: sourceFixture.version }, cohort: { bundles: ['target'] }, build: { sourceBuild: {}, releaseBuild: {} } }
  const ports = { bindInstaller: async (path: string) => ({ root: path, digest: hash('reviewed-installer') }),
    loadInstaller: async () => ({ readRsiLocalUpdateLocked: async () => preparation,
      prepareRsiLocalCohort, readRsiLocalCohort }),
    source: { prepareRsiSourceWorkspace, readRsiSourceWorkspace },
    build: { prepareRsiLocalUpdateBuild: async () => ({ ports: sourceFixture.ports, evidence: {} }) } }
  const proof = await prepareHostLocalArtifacts({ sourcePreparationRoot, homePath: sourceFixture.home,
    profile: sourceFixture.profile, installerRoot, root: auxiliaryRoot, bundles: ['dev-only'] }, ports)
  const stage = join(sourceFixture.root, 'stage')
  await mkdir(stage, { mode: 0o700 })
  const materialized = await materializeHostLocalArtifacts({ proof, homePath: sourceFixture.home,
    physicalHome: stage }, ports)
  expect(materialized.artifacts['@dsh-enhanced/dev-only']).toMatchObject({ version: sourceFixture.version,
    tarball: join(sourceFixture.home, 'rsi-local-cohorts', proof.auxiliaryProfile, 'artifacts', 'dev-only.tgz') })
  await expect(verifyHostLocalArtifactsInHome({ proof, homePath: sourceFixture.home,
    physicalHome: stage, skipOriginal: true }, ports)).resolves.toMatchObject({ cohort: materialized.cohort })
}, 60_000)
