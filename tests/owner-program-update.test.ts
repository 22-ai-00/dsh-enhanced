import { expect, test } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseDocument } from 'yaml'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.js'
import { readRsiHostUpdateOverlayChain, rebaseRsiHostValue, rsiHostUpdateOverlayDigest,
  signRsiOwnerProgramUpdateOverlay, signRsiOwnerRepairOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import { applyOwnerProgramAuthorityCas, assertOwnerProgramAuthorityPreserved, assertOwnerProgramWindow,
  assertOwnerProgramBusinessDataCopied, assertOwnerProgramManifestPreserved, stageOwnerProgramUpdate,
  verifyOwnerProgramUpdate, updateOwnerProgramJournal } from '../scripts/install/owner-program-update.mjs'

const old = {
  '/private/owner/config/release.json': JSON.stringify({ grant: { id: 'release-1', expiresAt: 456,
    maxReleases: 10, policies: [{ candidateId: 'example', dshBaseline: 'old' }] } }),
  '/private/owner/config/host-authority.json': JSON.stringify({ grant: { id: 'host-1',
    notBefore: 123, expiresAt: 456, maximumReloads: 1000, owner: { principalId: 'owner-1' },
    packages: [{ path: '/old/package', sha256: 'a'.repeat(64) }],
    hostDeploymentInputs: ['package.json'] } }),
  '/private/owner/config/trust.json': JSON.stringify({ installationId: 'stable' }),
  '/private/owner/config/key.pem': 'fixed private key',
}
type FileMap = Record<string, string>

test('updates both applied service receipts for the next upgrade and preserves original journal history', () => {
  const journal = { schemaVersion: 2, stage: 'applied', manifestDigest: 'old',
    entries: ['target', 'coordinator'].map(profile => ({ profile, before: 'initial patch', after: 'old patch' })),
    units: ['target', 'coordinator'].map(profile => ({ profile, before: 'initial unit', after: 'old unit' })) }
  const transitions = ['target', 'coordinator'].map(profile => ({ profile, oldSource: 'old unit', newSource: 'new Host unit' }))
  const next = updateOwnerProgramJournal(journal, { target: 'new target', coordinator: 'new coordinator' }, 'new', transitions)
  expect(next.units.map(unit => unit.after)).toEqual(['new Host unit', 'new Host unit'])
  expect(next.units.map(unit => unit.before)).toEqual(['initial unit', 'initial unit'])
  expect(next.entries.map(entry => entry.after)).toEqual(['new target', 'new coordinator'])
  expect(journal.units[0]!.after).toBe('old unit')
  expect(() => updateOwnerProgramJournal(journal, { target: 'next', coordinator: 'next' }, 'new',
    [transitions[0], { ...transitions[1], oldSource: 'changed unit' }])).toThrow(/journal changed/)
  expect(() => updateOwnerProgramJournal(journal, { target: 'next', coordinator: 'next' }, 'new',
    [transitions[0]])).toThrow(/inventory/)
})

test('preserves finite grant identity, lifetime, limits and owner while rebasing program pins', () => {
  const next = structuredClone(old)
  const host = JSON.parse(next['/private/owner/config/host-authority.json'])
  host.grant.packages = [{ path: '/new/package', sha256: 'b'.repeat(64) }]
  next['/private/owner/config/host-authority.json'] = JSON.stringify(host)
  const release = JSON.parse(next['/private/owner/config/release.json'])
  release.grant.policies[0].dshBaseline = 'new'
  next['/private/owner/config/release.json'] = JSON.stringify(release)
  expect(() => assertOwnerProgramAuthorityPreserved(old, next)).not.toThrow()
})

for (const [name, change] of [
  ['grant id', grant => { grant.id = 'recreated' }],
  ['expiry', grant => { grant.expiresAt++ }],
  ['used limit', grant => { grant.maximumReloads++ }],
  ['owner', grant => { grant.owner.principalId = 'other' }],
]) test(`rejects changed ${name}`, () => {
  const next = structuredClone(old)
  const host = JSON.parse(next['/private/owner/config/host-authority.json'])
  change(host.grant)
  next['/private/owner/config/host-authority.json'] = JSON.stringify(host)
  expect(() => assertOwnerProgramAuthorityPreserved(old, next)).toThrow(/finite authorization changed/u)
})

test('rejects replaced credentials or authority file inventory', () => {
  expect(() => assertOwnerProgramAuthorityPreserved(old,
    { ...old, '/private/owner/config/key.pem': 'new private key' })).toThrow(/authority key changed/u)
  const next: FileMap = structuredClone(old)
  delete next['/private/owner/config/trust.json']
  expect(() => assertOwnerProgramAuthorityPreserved(old, next)).toThrow(/inventory changed/u)
})

test('stage and verify reject an unbound owner transaction before touching files', async () => {
  await expect(stageOwnerProgramUpdate({ ownerUpdate: {}, homePath: '/tmp/owner' }))
    .rejects.toThrow(/proof binding differs/u)
  await expect(verifyOwnerProgramUpdate({ ownerUpdate: {}, homePath: '/tmp/owner' }))
    .rejects.toThrow(/proof binding differs/u)
})

test('a signed repair predecessor and program update form one mixed immutable chain', () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex')
  const key = generateKeyPairSync('ed25519')
  const privateKeyPem = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const resources = { configRoot: '/private/owner/config', installationId: 'installation-1',
    identities: { host: { authority: 'host-1', keyId: 'host-key-1',
      publicKeyPem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } } as any
  const bootstrapSource = '{"standing":"receipt"}\n'
  const files = { '/private/owner/config/manifest.json': sha('old manifest') }
  const patches = { target: sha('target'), coordinator: sha('coordinator') }
  const common = { schemaVersion: 1 as const, transactionId: 'txn-1', dshHome: '/private/owner',
    targetProfile: 'target', installationId: resources.installationId,
    bootstrapDigest: sha(bootstrapSource), files, patches, runtimeReceiptDigest: sha('runtime'),
    planDigest: sha(`${JSON.stringify({ files, patches }, null, 2)}\n`),
    result: { schemaVersion: 1 as const, manifestPath: '/private/owner/config/manifest.json',
      manifestDigest: files['/private/owner/config/manifest.json'], targetProfile: 'target',
      coordinatorProfile: 'coordinator' }, issuedAt: 10,
    authority: resources.identities.host.authority, keyId: resources.identities.host.keyId }
  const before = { files, patches, runtimeReceiptDigest: sha('runtime'),
    creationReceiptDigest: sha('creation'), journalDigest: sha('journal') }
  const after = { creationReceiptDigest: sha('creation-2'), journalDigest: sha('journal-2') }
  const repair = signRsiOwnerRepairOverlay({ ...common, kind: 'rsi-owner-repair-overlay',
    sequence: 1, previousDigest: null, repair: { sourceMaintenanceDigest: sha('repair'),
      before, after, permissionPreset: 'workspace-write' } }, privateKeyPem, resources,
  bootstrapSource, [])
  const update = signRsiOwnerProgramUpdateOverlay({ ...common, kind: 'rsi-owner-program-update-overlay',
    transactionId: 'txn-2', sequence: 2, previousDigest: rsiHostUpdateOverlayDigest(repair),
    issuedAt: 11, update: { sourceMaintenanceDigest: sha('source'),
      authorityDigest: sha('authority'), hostPlanDigest: sha('host-plan'),
      before: { ...before, creationReceiptDigest: after.creationReceiptDigest,
        journalDigest: after.journalDigest }, after } }, privateKeyPem, resources,
  bootstrapSource, [repair])
  const source = JSON.stringify({ schemaVersion: 1, kind: 'rsi-host-update-overlays', records: [repair, update] })
  const chain = readRsiHostUpdateOverlayChain({ source, resources, dshHome: '/private/owner',
    profile: 'target', bootstrapSource })
  expect(chain.records).toHaveLength(2)
  expect(chain.latest).toEqual(update)
  const tampered = JSON.stringify({ schemaVersion: 1, kind: 'rsi-host-update-overlays',
    records: [repair, { ...update, update: { ...update.update, hostPlanDigest: sha('other') } }] })
  expect(() => readRsiHostUpdateOverlayChain({ source: tampered, resources,
    dshHome: '/private/owner', profile: 'target', bootstrapSource })).toThrow(/signature differs/u)
})

test('exact Host pin rebase retains standing grant expiry', () => {
  const oldPath = '/old-host/bin/dsh', nextPath = '/new-host/bin/dsh'
  const before = { grant: { id: 'standing-owner', expiresAt: 1, maxReleases: 7,
    policies: [{ candidateId: 'existing', dshBaseline: 'old-version' }] },
  executor: { path: oldPath, sha256: 'a'.repeat(64), version: 'old-version' } }
  const after = rebaseRsiHostValue(before, { oldHostRoot: '/old-host', oldHostVersion: 'old-version',
    candidateHostVersion: 'new-version', pins: { [oldPath]: { path: nextPath, sha256: 'b'.repeat(64) } } })
  expect(after.grant.id).toBe(before.grant.id)
  expect(after.grant.expiresAt).toBe(1)
  expect(after.grant.maxReleases).toBe(7)
  expect(after.grant.policies[0].dshBaseline).toBe('new-version')
  expect(after.executor).toEqual({ path: nextPath, sha256: 'b'.repeat(64), version: 'new-version' })
  expect(before.executor.path).toBe(oldPath)
})

test('expired owner is rejected before staging and cannot silently renew', () => {
  const manifest = { sourceReviews: { expiresAt: 100 }, controlPlane: { sourceJobs: { expiresAt: 100 } },
    pluginCreation: { creation: { expiresAt: 100 } } }
  expect(() => assertOwnerProgramWindow(manifest, 100)).toThrow(/expired before offline upgrade/u)
  expect(() => assertOwnerProgramWindow(manifest, 99)).not.toThrow()
})

test('manifest permits only program fields and retains owner, model, grant and budget', () => {
  const creation = { reviews: { runner: { path: '/old' }, maxVerifications: 32 },
    capabilities: { runner: { path: '/old' }, maxAdoptions: 32 },
    verifications: { authority: { digest: 'a' }, publicKey: 'standing-key' },
    creation: { id: 'standing-grant', expiresAt: 100, maxCreates: 32 } }
  const baseline = { sourceReviews: { owner: { principalId: 'owner' }, expiresAt: 100 },
    growthDriver: { provider: 'standing-model-provider', model: 'standing-model' },
    coordinator: { budgetId: 'coordinator-budget', budgetAmount: 1 },
    controlPlane: { sourceBuild: { image: 'old' }, creationVerifications: creation.verifications,
      creationCapabilities: creation.capabilities,
      runtimeObserver: { targets: [{ entryId: 'dsh-enhanced-assistant-verifier',
        configDigest: 'a'.repeat(64) }] } }, pluginCreation: creation }
  const next = structuredClone(baseline)
  next.controlPlane.sourceBuild.image = 'new'
  next.pluginCreation.reviews.runner.path = '/new'
  next.pluginCreation.capabilities.runner.path = '/new'
  next.pluginCreation.verifications.authority.digest = 'b'
  next.controlPlane.creationVerifications = structuredClone(next.pluginCreation.verifications)
  next.controlPlane.creationCapabilities = structuredClone(next.pluginCreation.capabilities)
  next.controlPlane.runtimeObserver.targets[0].configDigest = 'b'.repeat(64)
  expect(() => assertOwnerProgramManifestPreserved(baseline, next)).not.toThrow()
  const changedModel = structuredClone(next)
  changedModel.growthDriver.model = 'other-model'
  expect(() => assertOwnerProgramManifestPreserved(baseline, changedModel))
    .toThrow(/outside exact program fields/u)
  const resetGrant = structuredClone(next)
  resetGrant.pluginCreation.creation.maxCreates = 1000
  expect(() => assertOwnerProgramManifestPreserved(baseline, resetGrant))
    .toThrow(/outside exact program fields/u)
})

test('offline stage preserves owner, used policy and coordinator automation database bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-stage-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const names = ['delivery.sqlite', 'policy.sqlite', 'coordinator-automations.sqlite']
    for (const name of names) {
      const content = `retained ${name} used-budget=7 owner=stable\n`
      await writeFile(join(homePath, name), content, { mode: 0o600 })
      await writeFile(join(stageHome, name), content, { mode: 0o600 })
      await chmod(join(homePath, name), 0o600)
      await chmod(join(stageHome, name), 0o600)
    }
    const yaml = (id: string, name: string) => `- id: ${id}\n  config:\n    databasePath: ${join(homePath, name)}\n`
    const owner = { homePath, original: { effective: {
      targetEffective: yaml('dsh-enhanced-assistant-delivery', 'delivery.sqlite')
        + yaml('dsh-enhanced-assistant-policy', 'policy.sqlite'),
      coordinatorEffective: yaml('dsh-enhanced-assistant-automations', 'coordinator-automations.sqlite') } } }
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: { parseDocument } }, owner, stageHome))
      .resolves.toBeUndefined()
    await writeFile(join(stageHome, 'policy.sqlite'), 'reset used-budget=0\n', { mode: 0o600 })
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: { parseDocument } }, owner, stageHome))
      .rejects.toThrow(/staged owner\/automation\/budget database differs/u)
    expect(await readFile(join(homePath, 'policy.sqlite'), 'utf8'))
      .toContain('used-budget=7')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('staged Host authority CAS migrates digests and retains used grant count', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-cas-')))
  try {
    const home = join(root, 'home'), stage = join(root, 'stage')
    await mkdir(home, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 })
    const statePath = join(home, 'host-grant.sqlite')
    const oldConfig = { statePath, grant: { id: 'standing-host', maximumReloads: 10,
      packages: [{ path: '/old-host/plugin', sha256: 'a'.repeat(64) }] } }
    const newConfig = { ...oldConfig, grant: { ...oldConfig.grant,
      packages: [{ path: '/new-host/plugin', sha256: 'b'.repeat(64) }] } }
    const oldTrust = controlPlaneDigest({ executor: 'old' })
    const newTrust = controlPlaneDigest({ executor: 'new' })
    const database = new DatabaseSync(join(stage, 'host-grant.sqlite'))
    database.exec('CREATE TABLE systemd_host_grants (grant_id TEXT PRIMARY KEY, grant_digest TEXT, config_digest TEXT, trust_digest TEXT, used_count INTEGER)')
    database.prepare('INSERT INTO systemd_host_grants VALUES (?,?,?,?,?)')
      .run(oldConfig.grant.id, controlPlaneDigest(oldConfig.grant), controlPlaneDigest(oldConfig), oldTrust, 7)
    database.close()
    await chmod(join(stage, 'host-grant.sqlite'), 0o600)
    await applyOwnerProgramAuthorityCas({ control: { controlPlaneDigest } }, home, stage,
      oldConfig, newConfig, oldTrust, newTrust)
    const read = new DatabaseSync(join(stage, 'host-grant.sqlite'), { readOnly: true })
    const row = read.prepare('SELECT * FROM systemd_host_grants WHERE grant_id=?').get(oldConfig.grant.id)
    read.close()
    expect(row).toMatchObject({ grant_id: oldConfig.grant.id, used_count: 7,
      grant_digest: controlPlaneDigest(newConfig.grant), config_digest: controlPlaneDigest(newConfig),
      trust_digest: newTrust })
    expect(await readFile(join(stage, 'host-grant.sqlite'))).toBeDefined()
  } finally { await rm(root, { recursive: true, force: true }) }
})
