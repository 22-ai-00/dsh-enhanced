import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { cp, copyFile, lstat, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { controlPlaneDigest, signSourceMaintenanceRecord, verifySourceMaintenanceRecords, sourceMaintenanceDigest, type SourceMaintenanceRecord } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { prepareRsiLocalCohort, type RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { prepareRsiSourceWorkspace, readRsiSourceWorkspace } from '../src/rsi-source.js'
import { applyRsiSourceMaintenanceInStage, readRsiSourceMaintenance, readRsiSourceMaintenanceSnapshot } from '../src/rsi-source-maintenance.js'
import { prepareRsiSourceUpdate, type RsiSourceUpdateCandidate } from '../src/rsi-source-update.js'
import { rsiBuildResources as io } from '../src/rsi-build.js'
import { localCohortFixture } from './fixtures/rsi-local-cohort.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
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

test('migrates only stopped copied Git, preserves original bootstrap, and reads a signed current version', { timeout: 120_000 }, async () => {
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

test('accepts advanced repair refs and a second signed stage update without rewriting initial identity', { timeout: 120_000 }, async () => {
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

// Independently mirror scripts/install/local-source-maintenance.mjs selection's
// existing digest encoder, not controlPlaneDigest/sourceMaintenanceDigest.
function legacySnapshotCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(legacySnapshotCanonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${legacySnapshotCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
function snapshotDigest(state: Awaited<ReturnType<typeof readRsiSourceMaintenance>>): string {
  return hash(legacySnapshotCanonical({ anchor: state.anchor, records: state.records,
    workspace: state.workspace, originalBootstrapDigest: state.originalBootstrapDigest }))
}
async function renamedSnapshot() {
  const f = await fixture(), state = await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: f.home, profile: f.profile })
  const expectedStateDigest = snapshotDigest(state), physicalHome = join(f.root, 'renamed-original'), before = await lstat(f.home)
  await rename(f.home, physicalHome)
  expect((await lstat(physicalHome)).ino).toBe(before.ino)
  return { ...f, state, input: { logicalHome: f.home, physicalHome, profile: f.profile, expectedStateDigest } }
}
async function signedSnapshot() {
  const f = await fixture(); await commit(f.sourceRepository, 'snapshot-upstream.txt', 'snapshot upstream\n')
  const next = await prepared(f, 1), stage = join(f.root, 'snapshot-stage')
  await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, next.candidate, next.cohort)
  const signed = record(f, next.candidate, { sourceCommit: f.source.sourceCommit, version: f.source.version, cohortDigest: f.original.receiptDigest }, nextCohort, 1)
  await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: next.candidate.root, records: [signed] })
  await rename(f.home, join(f.root, 'older-original')); await rename(stage, f.home)
  const state = await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: f.home, profile: f.profile })
  const physicalHome = join(f.root, 'renamed-current'), expectedStateDigest = snapshotDigest(state)
  await rename(f.home, physicalHome)
  return { ...f, signed, state, input: { logicalHome: f.home, physicalHome, profile: f.profile, expectedStateDigest } }
}

test('explicit frozen snapshot reads the same-inode renamed original while the ordinary reader still refuses', async () => {
  const f = await renamedSnapshot()
  await expect(readRsiSourceMaintenance(f.input)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readRsiSourceMaintenanceSnapshot(f.input)).toEqual(f.state)
}, 60_000)

test('snapshot validates the actual signed maintenance/Git/cohort chain after original-renamed crash', async () => {
  const f = await signedSnapshot()
  expect(f.state.records).toHaveLength(1)
  expect(await readRsiSourceMaintenanceSnapshot(f.input)).toEqual(f.state)
  await expect(readRsiSourceMaintenance(f.input)).rejects.toMatchObject({ code: 'ENOENT' })
}, 60_000)

test('snapshot uses the exact legacy lexical encoder including additional Host fields', async () => {
  const f = await fixture(), path = join(f.home, 'rsi-authorities', f.profile, 'bootstrap.json')
  const receipt = JSON.parse(await readFile(path, 'utf8')) as { resources: { identities: { host: Record<string, unknown> } }; receiptDigest: string }
  receipt.resources.identities.host['_extra'] = { Z: 1, a: 2 }
  const { receiptDigest: _digest, ...body } = receipt
  await writeFile(path, JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) }))
  const state = await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: f.home, profile: f.profile })
  const expectedStateDigest = snapshotDigest(state)
  expect(controlPlaneDigest(state)).not.toBe(expectedStateDigest)
  const physicalHome = join(f.root, 'renamed-extra'); await rename(f.home, physicalHome)
  expect(await readRsiSourceMaintenanceSnapshot({ logicalHome: f.home, physicalHome, profile: f.profile, expectedStateDigest })).toEqual(state)
}, 60_000)

test('snapshot requires an explicit exact frozen digest and never silently falls back', async () => {
  const f = await renamedSnapshot()
  for (const expectedStateDigest of [undefined, '', 'bad', '0'.repeat(64)]) {
    await expect(readRsiSourceMaintenanceSnapshot({ ...f.input, expectedStateDigest: expectedStateDigest as string })).rejects.toThrow(expectedStateDigest?.length === 64 ? 'frozen source snapshot digest differs' : 'explicit frozen state digest')
  }
}, 60_000)

test('snapshot refuses a live or dangling logical Home and unsafe physical aliases/overlap', async () => {
  const f = await renamedSnapshot()
  await mkdir(f.home, { mode: 0o700 })
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow('absent logical Home')
  await rm(f.home, { recursive: true }); await symlink('absent-target', f.home)
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow('absent logical Home')
  await rm(f.home); const alias = join(f.root, 'physical-link'); await symlink(f.input.physicalHome, alias)
  await expect(readRsiSourceMaintenanceSnapshot({ ...f.input, physicalHome: alias })).rejects.toThrow('unsafe directory')
  await expect(readRsiSourceMaintenanceSnapshot({ ...f.input, physicalHome: f.home })).rejects.toThrow('frozen snapshot binding')
  await expect(readRsiSourceMaintenanceSnapshot({ ...f.input, physicalHome: f.input.physicalHome + '/' })).rejects.toThrow('invalid source maintenance path')
}, 60_000)

test('snapshot rejects a logical Home which reappears during real Git verification', async () => {
  const f = await renamedSnapshot(), command = io.command
  let recreated = false
  vi.spyOn(io, 'command').mockImplementation(async (...args) => {
    const result = await command(...args)
    if (!recreated) { recreated = true; await mkdir(f.home, { mode: 0o700 }) }
    return result
  })
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow('absent logical Home')
  expect(recreated).toBe(true); expect((await lstat(f.home)).isDirectory()).toBe(true)
}, 60_000)

test.each(['source', 'host-key', 'cohort'] as const)('snapshot refuses tampered physical %s', async kind => {
  const f = await renamedSnapshot()
  if (kind === 'source') await writeFile(join(f.input.physicalHome, 'rsi-sources', f.profile, 'checkout', 'unexpected.txt'), 'untracked change')
  else if (kind === 'host-key') {
    const pair = generateKeyPairSync('ed25519'); await writeFile(join(f.input.physicalHome, 'rsi-authorities', f.profile, 'identities', 'host.pem'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }))
  } else {
    const path = join(f.input.physicalHome, 'rsi-local-cohorts', f.profile, 'receipt.json'), receipt = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const { receiptDigest: _old, ...body } = receipt; body.sourceCommit = 'f'.repeat(40)
    await writeFile(path, JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) }))
  }
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow(kind === 'source' ? 'source Git state differs' : kind === 'host-key' ? 'Host source signing key differs' : 'snapshot source/cohort identity differs')
}, 60_000)

test('snapshot refuses a tampered signed chain', async () => {
  const f = await signedSnapshot(), path = join(f.input.physicalHome, 'rsi-sources', f.profile, 'maintenance.json')
  const records = JSON.parse(await readFile(path, 'utf8')) as SourceMaintenanceRecord[]; records[0]!.preparationReceiptDigest = 'f'.repeat(64)
  await writeFile(path, JSON.stringify(records))
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow('source maintenance')
}, 60_000)

test('a new valid Host key and fully re-signed chain cannot impersonate the old frozen anchor', async () => {
  const f = await signedSnapshot(), root = join(f.input.physicalHome, 'rsi-authorities', f.profile), path = join(root, 'bootstrap.json')
  const pair = generateKeyPairSync('ed25519'), privateKey = pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), publicKey = pair.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const receipt = JSON.parse(await readFile(path, 'utf8')) as { resources: { identities: { host: { publicKeyPem: string } } }; keyDigests: { host: string }; receiptDigest: string }
  receipt.resources.identities.host.publicKeyPem = publicKey; receipt.keyDigests.host = hash(privateKey)
  const { receiptDigest: _old, ...body } = receipt
  await writeFile(path, JSON.stringify({ ...body, receiptDigest: hash(JSON.stringify(body)) })); await writeFile(join(root, 'identities', 'host.pem'), privateKey)
  const { publicKeyPem: _publicKey, signature: _signature, ...unsigned } = f.signed
  const forged = signSourceMaintenanceRecord(unsigned, privateKey), anchor = { ...f.state.anchor, hostIdentity: { ...f.state.anchor.hostIdentity, publicKeyPem: publicKey } }
  expect(verifySourceMaintenanceRecords([forged], anchor)).toHaveLength(1)
  await writeFile(join(f.input.physicalHome, 'rsi-sources', f.profile, 'maintenance.json'), JSON.stringify([forged]))
  await expect(readRsiSourceMaintenanceSnapshot(f.input)).rejects.toThrow('frozen source snapshot digest differs')
}, 60_000)
