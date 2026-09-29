import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { ControlPlaneStore, controlPlaneDigest, hostMaintenanceDigest, parseSourceMaintenanceRecord,
  sourceMaintenanceDigest, verifySourceMaintenanceRecords,
  type HostAttestationReceipt, type PluginActivationPlan } from '@dsh-enhanced/plugin-control-plane'
import { prepareRsiAuthorityResources } from '../src/rsi-authority-resources.js'
import { produceRsiLocalSourceMaintenance } from '../src/rsi-local-activation.js'
import { prepareRsiLocalCohort, type RsiLocalCohort } from '../src/rsi-local-cohort.js'
import { prepareRsiLocalUpdate } from '../src/rsi-local-update.js'
import { applyRsiSourceMaintenanceInStage, readRsiSourceMaintenance } from '../src/rsi-source-maintenance.js'
import { installFixture, localCohortFixture } from './fixtures/rsi-local-cohort.js'

vi.mock('../../plugin-control-plane/src/release.ts', async original => ({
  ...await original<Record<string, unknown>>(), invokeSourceReleaseAdapter: vi.fn(),
}))

// Runtime imports reuse the real cross-package owner-release/readiness fixture
// without making its source files part of this package's TypeScript rootDir.
const releaseHelpers = await import(new URL('../../plugin-control-plane/tests/helpers/source-release-runner.ts', import.meta.url).href) as {
  fixture(ownerBound: boolean, input: { root: string; databasePath: string; installationId: string; ledgerId: string;
    repository: string }): Promise<{ store: ControlPlaneStore }>
}
const runtimeHelpers = await import(new URL('../../plugin-control-plane/tests/helpers/runtime-epoch.ts', import.meta.url).href) as {
  createRuntimeEpochFixture(input: { releaseFixture: unknown; profile: string;
    readinessKey: { authority: string; keyId: string; privateKeyPem: string } }): Promise<{
      plan: PluginActivationPlan; coordinator: ControlPlaneStore; signed: { receipt: HostAttestationReceipt }
    }>
  cleanupRuntimeEpochFixtures(): Promise<void>
}
const roots: string[] = []
afterEach(async () => {
  await runtimeHelpers.cleanupRuntimeEpochFixtures()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
function git(repository: string, ...args: string[]): string {
  return execFileSync('/usr/bin/git', ['-C', repository, ...args], { encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}
function sql(path: string, callback: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(path)
  try { callback(database); database.exec('PRAGMA wal_checkpoint(TRUNCATE)') }
  finally { database.close() }
}
async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {}
  async function visit(directory: string): Promise<void> {
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) await visit(path)
      else if (item.isFile()) result[path.slice(root.length)] = hash(await readFile(path))
      else throw new Error(`unexpected snapshot entry: ${path}`)
    }
  }
  await visit(root)
  return result
}
async function stageCohort(f: { home: string; profile: string; sourceRepository: string }, stage: string,
  prepared: RsiLocalCohort): Promise<RsiLocalCohort> {
  const root = join(f.home, 'rsi-local-cohorts', f.profile), stagedRoot = join(stage, 'rsi-local-cohorts', f.profile)
  await rm(stagedRoot, { recursive: true })
  await cp(prepared.root, stagedRoot, { recursive: true })
  const { receiptDigest: _digest, ...cohort } = prepared
  const content = { ...cohort, root, sourceRepository: f.sourceRepository,
    packages: cohort.packages.map(item => ({ ...item, tarball: join(root, 'artifacts', `${item.name.split('/')[1]}.tgz`) })) }
  const next = { ...content, receiptDigest: hash(JSON.stringify(content)) }
  await writeFile(join(stagedRoot, 'receipt.json'), JSON.stringify(next))
  return next
}
async function fixture(watched = false) {
  const f = await localCohortFixture(); roots.push(f.root)
  const original = await prepareRsiLocalCohort({ dshHome: f.home, profile: f.profile,
    source: f.source, bundles: ['target'] }, f.ports)
  await installFixture(f, original, undefined, `home/profiles/${f.profile}`)
  const resources = await prepareRsiAuthorityResources({ dshHome: f.home, profile: f.profile })
  const ledger = join(resources.stateRoot, 'control-plane', 'control.sqlite')
  await mkdir(join(resources.stateRoot, 'control-plane'), { mode: 0o700 })
  const store = new ControlPlaneStore({ path: ledger }); store.close()
  let watchedPlan: PluginActivationPlan | undefined
  let readiness: HostAttestationReceipt | undefined
  if (watched) {
    const release = await releaseHelpers.fixture(true, { root: f.home, databasePath: ledger,
      installationId: resources.installationId, ledgerId: resources.ledgerId,
      // This deployment's historical release is unrelated to the owner source
      // being maintained; its fake release commit cannot form a Git edge here.
      repository: join(f.home, 'historical-release') })
    const runtime = await runtimeHelpers.createRuntimeEpochFixture({ releaseFixture: release, profile: f.profile,
      readinessKey: { authority: resources.identities.host.authority, keyId: resources.identities.host.keyId,
        privateKeyPem: await readFile(resources.identities.host.keyPath, 'utf8') } })
    runtime.coordinator.close()
    watchedPlan = runtime.plan; readiness = runtime.signed.receipt
    sql(ledger, () => {})
  }
  await writeFile(join(f.sourceRepository, 'upstream.txt'), 'upstream update\n')
  git(f.sourceRepository, 'add', 'upstream.txt')
  git(f.sourceRepository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'upstream')
  const preparation = await prepareRsiLocalUpdate({ dshHome: f.home, profile: f.profile,
    sourceRepository: f.sourceRepository }, f.ports)
  const live = await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: f.home, profile: f.profile })
  const stage = join(f.root, 'stage')
  await cp(f.home, stage, { recursive: true })
  const stageLedger = join(stage, 'rsi-authorities', f.profile, 'state', 'control-plane', 'control.sqlite')
  const nextCohort = await stageCohort(f, stage, preparation.cohort)
  const input = { logicalHome: f.home, profile: f.profile, preparation, live, stagePhysicalHome: stage, nextCohort }
  return { ...f, resources, original, preparation, live, stage, ledger, stageLedger, watchedPlan, readiness, input }
}

test('produces a verifiable unanchored Host signature without writing either Home or ledger', async () => {
  const f = await fixture(), originalHome = await snapshot(f.home), originalStage = await snapshot(f.stage)
  const record = await produceRsiLocalSourceMaintenance(f.input)
  expect(parseSourceMaintenanceRecord(record)).toEqual(record)
  expect(verifySourceMaintenanceRecords([record], f.live.anchor)).toEqual([record])
  expect(record).toMatchObject({ host: null, sequence: 1, previousDigest: null,
    installationId: f.resources.installationId, ledger: f.live.anchor.ledger, repository: f.source.repository,
    previousTip: f.source.sourceCommit, candidateTip: f.preparation.source.sourceCommit,
    before: { sourceCommit: f.source.sourceCommit, version: f.source.version, cohortDigest: f.original.receiptDigest },
    after: { sourceCommit: f.preparation.source.sourceCommit, version: f.preparation.source.version,
      cohortDigest: f.input.nextCohort.receiptDigest }, authority: f.resources.identities.host.authority,
    keyId: f.resources.identities.host.keyId, publicKeyPem: f.resources.identities.host.publicKeyPem })
  expect(await snapshot(f.home)).toEqual(originalHome)
  expect(await snapshot(f.stage)).toEqual(originalStage)
}, 60_000)

test('extends a previously applied signed Git and ledger chain with the exact prior digest', async () => {
  const f = await fixture(), originalHome = await snapshot(f.home)
  const first = await produceRsiLocalSourceMaintenance(f.input)
  await applyRsiSourceMaintenanceInStage({ logicalHome: f.home, physicalHome: f.stage, profile: f.profile,
    sourceRepository: f.sourceRepository, candidateRoot: f.preparation.source.root, records: [first] })
  sql(f.stageLedger, database => database.prepare('INSERT INTO source_maintenance VALUES (?,?,?,?,?,?)')
    .run(first.repository, first.sequence, first.transactionId, null, JSON.stringify(first), sourceMaintenanceDigest(first)))
  const archive = join(f.root, 'original-home')
  await rename(f.home, archive); await rename(f.stage, f.home)
  await writeFile(join(f.sourceRepository, 'second-upstream.txt'), 'second update\n')
  git(f.sourceRepository, 'add', 'second-upstream.txt')
  git(f.sourceRepository, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'second upstream')
  const preparation = await prepareRsiLocalUpdate({ dshHome: f.home, profile: f.profile,
    sourceRepository: f.sourceRepository }, f.ports)
  const live = await readRsiSourceMaintenance({ logicalHome: f.home, physicalHome: f.home, profile: f.profile })
  const stage = join(f.root, 'second-stage'); await cp(f.home, stage, { recursive: true })
  const nextCohort = await stageCohort(f, stage, preparation.cohort), currentHome = await snapshot(f.home)
  const input = { ...f.input, live, preparation, stagePhysicalHome: stage, nextCohort }
  const second = await produceRsiLocalSourceMaintenance(input)
  expect(second).toMatchObject({ sequence: 2, previousDigest: sourceMaintenanceDigest(first),
    previousTip: first.candidateTip, before: first.after, originalBootstrapDigest: first.originalBootstrapDigest })
  expect(verifySourceMaintenanceRecords([first, second], live.anchor)).toEqual([first, second])
  await expect(produceRsiLocalSourceMaintenance({ ...input, now: () => first.issuedAt - 1 })).rejects.toThrow('clock moved backwards')
  await expect(produceRsiLocalSourceMaintenance({ ...input, preparation: { ...preparation,
    originalCohortDigest: 'f'.repeat(64) } })).rejects.toThrow('signed current cohort')
  expect(await snapshot(f.home)).toEqual(currentHome)
  expect(await snapshot(archive)).toEqual(originalHome)
}, 60_000)

test.each(['missing', 'old-schema', 'corrupt', 'missing-table'] as const)('rejects a %s stage ledger without creating or migrating it', async kind => {
  const f = await fixture(), originalHome = await snapshot(f.home)
  if (kind === 'missing') await rm(f.stageLedger)
  else if (kind === 'old-schema') sql(f.stageLedger, database => database.exec('PRAGMA user_version=27'))
  else if (kind === 'missing-table') sql(f.stageLedger, database => database.exec('DROP TABLE activation_watch'))
  else await writeFile(f.stageLedger, 'broken SQLite database')
  const originalStage = await snapshot(f.stage)
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow()
  expect(await snapshot(f.home)).toEqual(originalHome)
  expect(await snapshot(f.stage)).toEqual(originalStage)
}, 60_000)

test('rejects live/stage source history drift and a live ledger that diverges from its signed sidecar', async () => {
  const f = await fixture(), record = await produceRsiLocalSourceMaintenance(f.input)
  const originalHome = await snapshot(f.home)
  const insert = (path: string) => sql(path, database => database.prepare('INSERT INTO source_maintenance VALUES (?,?,?,?,?,?)')
    .run(record.repository, record.sequence, record.transactionId, null, JSON.stringify(record), sourceMaintenanceDigest(record)))
  insert(f.stageLedger)
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('staged ledger and live sidecar')
  expect(await snapshot(f.home)).toEqual(originalHome)
  insert(f.ledger)
  const driftedHome = await snapshot(f.home)
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('live ledger and sidecar')
  expect(await snapshot(f.home)).toEqual(driftedHome)
}, 60_000)

test('rejects foreign and unsafe staged signing keys and stale preparation bindings', async () => {
  const f = await fixture(), originalHome = await snapshot(f.home)
  const path = join(f.stage, 'rsi-authorities', f.profile, 'identities', 'host.pem'), originalKey = await readFile(path)
  const foreignKey = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  await writeFile(path, foreignKey)
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('staged Host key does not match')
  await writeFile(path, originalKey); await chmod(path, 0o644)
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('unsafe Host key')
  await chmod(path, 0o600)
  await expect(produceRsiLocalSourceMaintenance({ ...f.input, preparation: { ...f.preparation,
    source: { ...f.preparation.source, repairCommit: 'b'.repeat(40) } } })).rejects.toThrow('current source chain tip')
  await expect(produceRsiLocalSourceMaintenance({ ...f.input, stagePhysicalHome: f.home })).rejects.toThrow('distinct stopped copy')
  await expect(produceRsiLocalSourceMaintenance({ ...f.input, nextCohort: { ...f.input.nextCohort,
    sourceCommit: f.source.sourceCommit } })).rejects.toThrow('next cohort does not match')
  await expect(produceRsiLocalSourceMaintenance({ ...f.input, now: () => 0 })).rejects.toThrow('invalid signing time')
  expect(await snapshot(f.home)).toEqual(originalHome)
}, 60_000)

test('rejects unfinished source work in the stopped stage ledger', async () => {
  const f = await fixture(), originalHome = await snapshot(f.home)
  const store = new ControlPlaneStore({ path: f.stageLedger })
  try {
    const gap = store.recordGap({ idempotencyKey: 'unfinished-gap', capability: 'unfinished', context: 'pending source work',
      expectedValue: 1, frequency: 1, estimatedCost: 1, risk: 0 })
    store.createSourcePlan({ gapId: gap.id, name: 'unfinished', repository: f.source.repository,
      worktree: join(f.root, 'unfinished-worktree'), baseCommit: f.source.sourceCommit,
      generatorDigest: 'a'.repeat(64), scope: ['plugins/README.md', 'plugins/unfinished'],
      ttlMs: 60_000, idempotencyKey: 'unfinished-plan' })
  } finally { store.close() }
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('unsettled source work')
  expect(await snapshot(f.home)).toEqual(originalHome)
}, 60_000)

test('binds a watched deployment to the original applied readiness signed by the installed Host', async () => {
  const f = await fixture(true), originalHome = await snapshot(f.home), originalStage = await snapshot(f.stage)
  const record = await produceRsiLocalSourceMaintenance(f.input)
  expect(record.host).toEqual({ planId: f.watchedPlan!.id, planDigest: f.watchedPlan!.digest,
    readinessOperationId: f.readiness!.operationId, readinessReceiptDigest: hostMaintenanceDigest(f.readiness!) })
  expect(verifySourceMaintenanceRecords([record], f.live.anchor)).toEqual([record])
  expect(await snapshot(f.home)).toEqual(originalHome)
  expect(await snapshot(f.stage)).toEqual(originalStage)
}, 60_000)

test('rejects watched deployment drift even when live and stage classify the same plan', async () => {
  const f = await fixture(true), originalHome = await snapshot(f.home)
  sql(f.stageLedger, database => database.prepare('UPDATE adoption_handoffs SET created_at=created_at+1 WHERE plan_id=?').run(f.watchedPlan!.id))
  await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow('watched Host deployments differ')
  expect(await snapshot(f.home)).toEqual(originalHome)
}, 60_000)

test.each(['missing-readiness', 'forged-signature', 'foreign-issuer', 'unwatched', 'pending'] as const)(
  'rejects %s watched state instead of signing host:null', async kind => {
    const f = await fixture(true), originalHome = await snapshot(f.home)
    sql(f.stageLedger, database => {
      if (kind === 'missing-readiness') database.prepare("DELETE FROM host_attestations WHERE plan_id=? AND phase='readiness'").run(f.watchedPlan!.id)
      else if (kind === 'unwatched') database.prepare('DELETE FROM activation_watch WHERE plan_id=?').run(f.watchedPlan!.id)
      else if (kind === 'pending') database.prepare("UPDATE activation_plans SET status='awaiting-readiness' WHERE id=?").run(f.watchedPlan!.id)
      else {
        const receipt = { ...f.readiness!, ...(kind === 'foreign-issuer' ? { authority: 'foreign' } : { signature: Buffer.alloc(64).toString('base64') }) }
        database.prepare("UPDATE host_attestation_operations SET receipt_json=?,receipt_digest=? WHERE plan_id=? AND phase='readiness'")
          .run(JSON.stringify(receipt), controlPlaneDigest(receipt), f.watchedPlan!.id)
        database.prepare("UPDATE host_attestations SET receipt_json=?,receipt_digest=? WHERE plan_id=? AND phase='readiness'")
          .run(JSON.stringify(receipt), controlPlaneDigest(receipt), f.watchedPlan!.id)
      }
    })
    await expect(produceRsiLocalSourceMaintenance(f.input)).rejects.toThrow()
    expect(await snapshot(f.home)).toEqual(originalHome)
  }, 60_000)
