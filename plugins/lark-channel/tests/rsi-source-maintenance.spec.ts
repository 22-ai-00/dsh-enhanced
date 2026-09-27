import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cp, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { signSourceMaintenanceRecord, sourceMaintenanceDigest, type SourceMaintenanceRecord } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { prepareRsiLocalCohort, type RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { prepareRsiSourceWorkspace, readRsiSourceWorkspace } from '../src/rsi-source.js'
import { applyRsiSourceMaintenanceInStage, readRsiSourceMaintenance } from '../src/rsi-source-maintenance.js'
import { prepareRsiSourceUpdate, type RsiSourceUpdateCandidate } from '../src/rsi-source-update.js'
import { localCohortFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function git(cwd: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
async function commit(cwd: string, file: string, contents: string): Promise<string> {
  await writeFile(join(cwd, file), contents)
  git(cwd, 'add', file)
  git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', file)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function fixture() {
  const f = await localCohortFixture(); roots.push(f.root)
  const original = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile,
    source: f.source, bundles: ['target'] }, f.ports)
  const resources = await prepareRsiAuthorityResources({ dshHome: f.home, profile: f.profile })
  const key = await readFile(join(f.home, 'rsi-authorities', f.profile, 'identities', 'host.pem'), 'utf8')
  const bootstrap = await readFile(join(f.home, 'rsi-sources', f.profile, 'bootstrap.json'))
  return { ...f, original, resources, key, bootstrap }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function prepared(f: Fixture, ordinal: number): Promise<{ candidate: RsiSourceUpdateCandidate; cohort: RsiLocalCohort }> {
  const candidate = await prepareRsiSourceUpdate({ dshHome: f.home, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: join(f.root, `candidate-${ordinal}`) })
  const candidateHome = join(f.root, `candidate-home-${ordinal}`)
  await mkdir(candidateHome, { mode: 0o700 })
  const workspace = await prepareRsiSourceWorkspace({ dshHome: candidateHome, profile: f.profile,
    version: candidate.version, sourceRepository: candidate.repository })
  const cohort = await prepareRsiLocalCohort({ dshHome: candidateHome, profile: f.profile,
    source: workspace, bundles: f.original.bundles }, f.ports)
  return { candidate, cohort }
}
async function stageCohort(f: Fixture, stage: string, candidate: RsiSourceUpdateCandidate, cohort: RsiLocalCohort) {
  const root = join(f.home, 'rsi-local-cohorts', f.profile)
  const artifacts = join(stage, 'rsi-local-cohorts', f.profile, 'artifacts')
  await rm(artifacts, { recursive: true })
  await mkdir(artifacts, { mode: 0o700 })
  const packages = [] as RsiLocalCohort['packages']
  for (const item of cohort.packages) {
    const tarball = join(root, 'artifacts', `${item.name.split('/')[1]}.tgz`)
    await copyFile(item.tarball, join(artifacts, `${item.name.split('/')[1]}.tgz`))
    packages.push({ ...item, tarball })
  }
  const content = { schemaVersion: 1 as const, root, sourceCommit: candidate.sourceCommit,
    version: candidate.version, sourceRepository: f.sourceRepository,
    allowBuilds: cohort.allowBuilds, bundles: cohort.bundles, packages }
  const result: RsiLocalCohort = { ...content, receiptDigest: hash(JSON.stringify(content)) }
  await writeFile(join(stage, 'rsi-local-cohorts', f.profile, 'receipt.json'), JSON.stringify(result))
  return result
}
function record(f: Fixture, candidate: RsiSourceUpdateCandidate, before: { sourceCommit: string; version: string; cohortDigest: string },
  after: RsiLocalCohort, sequence: number, previous?: SourceMaintenanceRecord,
  transactionId = `source-update-${sequence}`): SourceMaintenanceRecord {
  return signSourceMaintenanceRecord({ schemaVersion: 1, kind: 'dsh-source-maintenance',
    transactionId, installationId: f.resources.installationId,
    ledger: { id: f.resources.ledgerId, path: join(f.home, 'rsi-authorities', f.profile, 'state', 'control-plane', 'control.sqlite') },
    repository: f.source.repository, baseline: f.source.baseline, sequence,
    previousDigest: previous ? sourceMaintenanceDigest(previous) : null,
    previousTip: candidate.repairCommit, candidateTip: candidate.sourceCommit, upstreamCommit: candidate.upstreamCommit,
    sourceTree: candidate.sourceTree, preparationReceiptDigest: candidate.receiptDigest,
    originalBootstrapDigest: hash(f.bootstrap), before,
    after: { sourceCommit: candidate.sourceCommit, version: candidate.version, cohortDigest: after.receiptDigest },
    host: null, issuedAt: Date.now() + sequence, authority: f.resources.identities.host.authority,
    keyId: f.resources.identities.host.keyId }, f.key)
}

test('migrates only stopped copied Git, preserves original bootstrap, and reads a signed current version', async () => {
  const f = await fixture()
  const paths = ['package.json', ...f.original.packages.map(item => `${item.path}/package.json`)]
  for (const path of paths) {
    const source = join(f.sourceRepository, path), manifest = JSON.parse(await readFile(source, 'utf8')) as Record<string, unknown>
    manifest.version = '0.1.49'
    await writeFile(source, `${JSON.stringify(manifest, null, 2)}\n`)
  }
  git(f.sourceRepository, 'add', '.')
  git(f.sourceRepository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'new version')
  const next = await prepared(f, 1), stage = join(f.root, 'stage-1')
  await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, next.candidate, next.cohort)
  const signed = record(f, next.candidate, { sourceCommit: f.source.sourceCommit,
    version: f.source.version, cohortDigest: f.original.receiptDigest }, nextCohort, 1)
  await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [signed] })
  expect((await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: stage, profile: f.profile })).workspace)
    .toMatchObject({ sourceCommit: next.candidate.sourceCommit, version: '0.1.49',
      baseline: { initialCommit: f.source.sourceCommit } })
  expect(await readFile(join(stage, 'rsi-sources', f.profile, 'bootstrap.json'))).toEqual(f.bootstrap)
  expect(git(f.source.repository, 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
  expect(git(join(stage, 'rsi-sources', f.profile, 'checkout'), 'for-each-ref', '--format=%(refname)',
    'refs/dsh-source/maintenance-candidate')).toBe('')
  expect(git(join(stage, 'rsi-sources', f.profile, 'release.git'), 'for-each-ref', '--format=%(refname)',
    'refs/dsh-source/maintenance-candidate')).toBe('')
  expect((await readFile(join(f.home, 'rsi-local-cohorts', f.profile, 'receipt.json'), 'utf8')))
    .toContain(f.original.receiptDigest)
  await rename(f.home, join(f.root, 'original-home'))
  await rename(stage, f.home)
  expect(await readRsiSourceWorkspace({ dshHome: f.home, profile: f.profile,
    sourceRepository: f.sourceRepository, version: '0.1.49' })).toMatchObject({
      sourceCommit: next.candidate.sourceCommit, baseline: { initialCommit: f.source.sourceCommit } })
}, 60_000)

test('accepts advanced repair refs and a second signed stage update without rewriting initial identity', async () => {
  const f = await fixture()
  await commit(f.sourceRepository, 'upstream-one.txt', 'first upstream\n')
  const first = await prepared(f, 1), stageOne = join(f.root, 'stage-1')
  await cp(f.home, stageOne, { recursive: true })
  const firstCohort = await stageCohort(f, stageOne, first.candidate, first.cohort)
  const signedOne = record(f, first.candidate, { sourceCommit: f.source.sourceCommit,
    version: f.source.version, cohortDigest: f.original.receiptDigest }, firstCohort, 1)
  await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stageOne, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: first.candidate.root, records: [signedOne] })
  await rename(f.home, join(f.root, 'original-home'))
  await rename(stageOne, f.home)

  const clone = join(f.root, 'repair-clone')
  execFileSync('/usr/bin/git', ['clone', '--no-hardlinks', '--quiet', join(f.home, 'rsi-sources', f.profile, 'checkout'), clone])
  const repair = await commit(clone, 'repair.txt', 'owner repair\n')
  const checkout = join(f.home, 'rsi-sources', f.profile, 'checkout')
  const bare = join(f.home, 'rsi-sources', f.profile, 'release.git')
  git(checkout, 'fetch', clone, `+${repair}:refs/dsh-source/repairs`)
  git(bare, 'fetch', clone, `+${repair}:refs/heads/repairs`)
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first.candidate.sourceCommit)
  expect((await readRsiSourceWorkspace({ dshHome: f.home, profile: f.profile })).sourceCommit).toBe(first.candidate.sourceCommit)
  await commit(f.sourceRepository, 'upstream-two.txt', 'second upstream\n')
  const second = await prepared(f, 2)
  expect(second.candidate.repairCommit).toBe(repair)
  const stageTwo = join(f.root, 'stage-2')
  await cp(f.home, stageTwo, { recursive: true })
  const secondCohort = await stageCohort(f, stageTwo, second.candidate, second.cohort)
  const signedTwo = record(f, second.candidate, { sourceCommit: first.candidate.sourceCommit,
    version: first.candidate.version, cohortDigest: firstCohort.receiptDigest }, secondCohort, 2, signedOne)
  const result = await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stageTwo, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: second.candidate.root, records: [signedOne, signedTwo] })
  expect(result.workspace.sourceCommit).toBe(second.candidate.sourceCommit)
  expect(result.workspace.baseline.initialCommit).toBe(f.source.sourceCommit)
  expect(result.records).toHaveLength(2)
  expect(git(checkout, 'rev-parse', 'HEAD')).toBe(first.candidate.sourceCommit)
}, 90_000)

test('rejects self-signed foreign maintenance and never modifies the live Home', async () => {
  const f = await fixture()
  await commit(f.sourceRepository, 'upstream.txt', 'updated\n')
  const next = await prepared(f, 1), stage = join(f.root, 'stage')
  await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, next.candidate, next.cohort)
  const signed = record(f, next.candidate, { sourceCommit: f.source.sourceCommit,
    version: f.source.version, cohortDigest: f.original.receiptDigest }, nextCohort, 1)
  await expect(applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: f.home, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [signed] }))
    .rejects.toThrow('distinct stopped stage')
  const forged = { ...signed, publicKeyPem: `${signed.publicKeyPem}foreign` }
  await expect(applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [forged] }))
    .rejects.toThrow()
  expect(git(f.source.repository, 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
  expect(git(join(stage, 'rsi-sources', f.profile, 'checkout'), 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
}, 60_000)

test('rejects a copied Home whose Host signing identity was replaced and self-signed', async () => {
  const f = await fixture()
  await commit(f.sourceRepository, 'upstream.txt', 'updated\n')
  const next = await prepared(f, 1), stage = join(f.root, 'stage-foreign')
  await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, next.candidate, next.cohort)
  const pair = generateKeyPairSync('ed25519')
  const foreignKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const foreignPublic = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const authorityRoot = join(stage, 'rsi-authorities', f.profile)
  const authorityPath = join(authorityRoot, 'bootstrap.json')
  const bootstrap = JSON.parse(await readFile(authorityPath, 'utf8')) as {
    resources: { identities: { host: { publicKeyPem: string } } }
    keyDigests: { host: string }
    receiptDigest: string
  }
  bootstrap.resources.identities.host.publicKeyPem = foreignPublic
  bootstrap.keyDigests.host = hash(foreignKey)
  const { receiptDigest: _oldDigest, ...content } = bootstrap
  await writeFile(authorityPath, JSON.stringify({ ...content, receiptDigest: hash(JSON.stringify(content)) }))
  await writeFile(join(authorityRoot, 'identities', 'host.pem'), foreignKey)
  const forged = record({ ...f, key: foreignKey }, next.candidate, { sourceCommit: f.source.sourceCommit,
    version: f.source.version, cohortDigest: f.original.receiptDigest }, nextCohort, 1)
  await expect(applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [forged] }))
    .rejects.toThrow('staged source or Host authority differs')
  expect(git(join(stage, 'rsi-sources', f.profile, 'checkout'), 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
}, 60_000)

test('an existing sidecar cannot fall back to the initial source when its Host key is missing', async () => {
  const f = await fixture(), stage = join(f.root, 'stage-missing-key')
  await cp(f.home, stage, { recursive: true })
  await writeFile(join(stage, 'rsi-sources', f.profile, 'maintenance.json'), '[{}]', { mode: 0o600 })
  await rm(join(stage, 'rsi-authorities', f.profile, 'identities', 'host.pem'))
  await expect(readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: stage, profile: f.profile }))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(git(join(stage, 'rsi-sources', f.profile, 'checkout'), 'rev-parse', 'HEAD')).toBe(f.source.sourceCommit)
})

test('a signed transaction ID cannot choose the temporary receipt path', async () => {
  const f = await fixture()
  await commit(f.sourceRepository, 'upstream.txt', 'updated\n')
  const next = await prepared(f, 1), stage = join(f.root, 'stage-path')
  await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, next.candidate, next.cohort)
  const signed = record(f, next.candidate, { sourceCommit: f.source.sourceCommit,
    version: f.source.version, cohortDigest: f.original.receiptDigest }, nextCohort, 1, undefined, '../../outside')
  await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [signed] })
  await expect(readFile(join(stage, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(git(join(stage, 'rsi-sources', f.profile, 'checkout'), 'for-each-ref', '--format=%(refname)',
    'refs/dsh-source/maintenance-candidate')).toBe('')
  expect(git(join(stage, 'rsi-sources', f.profile, 'release.git'), 'for-each-ref', '--format=%(refname)',
    'refs/dsh-source/maintenance-candidate')).toBe('')
}, 60_000)
