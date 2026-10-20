import { expect, test } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.js'
import { readRsiHostPatchConfig, readRsiHostUpdateOverlayChain, rebaseRsiHostValue, replaceRsiHostPatchConfig,
  rsiHostUpdateOverlayDigest,
  signRsiOwnerProgramUpdateOverlay, signRsiOwnerRepairOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import { applyOwnerProgramAuthorityCas, assertOwnerProgramAuthorityPreserved, assertOwnerProgramOriginalComposition, assertOwnerProgramWindow,
  assertOwnerProgramBusinessDataCopied, assertOwnerProgramManifestPreserved, stageOwnerProgramUpdate,
  verifyOwnerProgramUpdate, updateOwnerProgramJournal, patchConfig, replacePatchConfig } from '../scripts/install/owner-program-update.mjs'

const old = {
  '/private/owner/config/release.json': JSON.stringify({ grant: { id: 'release-1', expiresAt: 456,
    maxReleases: 10, policies: [{ candidateId: 'example', dshBaseline: 'old', capabilities: ['tool'] }] } }),
  '/private/owner/config/host-authority.json': JSON.stringify({ grant: { id: 'host-1',
    notBefore: 123, expiresAt: 456, maximumReloads: 1000, owner: { principalId: 'owner-1' },
    packages: ['@dsh-enhanced/example'], hostDeploymentInputs: ['package.json'] } }),
  '/private/owner/config/adoption.json': JSON.stringify({ grant: { id: 'adoption-1', expiresAt: 456,
    maxAdoptions: 10, owner: { principalId: 'owner-1' }, ledger: { id: 'ledger-1' },
    target: { dshHome: '/private/owner', profile: 'web' }, handoff: { coordinatorId: 'coordinator' },
    liveQualification: { id: 'qualification-1' }, hostDeploymentInputs: ['package.json'],
    executor: { id: 'executor-1', version: 'old', path: '/old/package', sha256: 'a'.repeat(64) },
    policies: [{ candidateId: 'example', dshBaseline: 'old', requires: ['signed'] }] } }),
  '/private/owner/config/trust.json': JSON.stringify({ installationId: 'stable' }),
  '/private/owner/config/key.pem': 'fixed private key',
}
type FileMap = Record<string, string>
const yamlApi = { isAlias, isMap, isScalar, isSeq, parseDocument }
const authorityRebase = { oldHostRoot: '/old', oldHostVersion: 'old', candidateHostVersion: 'new',
  pins: { '/old/package': { path: '/new/package', sha256: 'b'.repeat(64) } } }
const authorityContext = { rebase: authorityRebase, rebaseValue: rebaseRsiHostValue }

test('owner program patch updates preserve inert Loader tags through repeated verifier and control-plane writes', () => {
  const api = { readRsiHostPatchConfig, replaceRsiHostPatchConfig }
  const patch = `[
    { id: dsh-enhanced-assistant-verifier, config: { databasePath: !!js "dshHomePath('verifier/state.sqlite')", creationReviews: [], sourceReviews: [] } },
    { id: dsh-enhanced-plugin-control-plane, config: { runtimeObserver: { targets: [] } } },
    { id: personal-assistant, config: { paths: [!!js 'dshHomePath("personal/state.sqlite")'] } }
  ]`
  const verifier = patchConfig(api, patch, 'dsh-enhanced-assistant-verifier')
  expect(verifier.databasePath).toEqual({ __jsExpr: "dshHomePath('verifier/state.sqlite')" })
  const changed = replacePatchConfig(api, patch, 'dsh-enhanced-assistant-verifier', verifier,
    { ...verifier, creationReviews: [{ id: 'review-1' }] })
  const control = patchConfig(api, changed, 'dsh-enhanced-plugin-control-plane')
  const twice = replacePatchConfig(api, changed, 'dsh-enhanced-plugin-control-plane', control,
    { ...control, runtimeObserver: { targets: [{ entryId: 'dsh-enhanced-assistant-verifier' }] } })
  expect(twice.match(/!!js/g)).toHaveLength(2)
  expect(patchConfig(api, twice, 'dsh-enhanced-assistant-verifier')).toEqual({
    ...verifier, creationReviews: [{ id: 'review-1' }],
  })
  expect(() => replacePatchConfig(api, twice, 'dsh-enhanced-assistant-verifier',
    patchConfig(api, twice, 'dsh-enhanced-assistant-verifier'), { ...verifier, databasePath: '/tmp/escape.sqlite' }))
    .toThrow('tagged Loader expression')
})

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
  const release = JSON.parse(next['/private/owner/config/release.json'])
  release.grant.policies[0].dshBaseline = 'new'
  next['/private/owner/config/release.json'] = JSON.stringify(release)
  const adoption = JSON.parse(next['/private/owner/config/adoption.json'])
  adoption.grant.executor = { ...adoption.grant.executor, path: '/new/package', sha256: 'b'.repeat(64), version: 'new' }
  adoption.grant.policies[0].dshBaseline = 'new'
  next['/private/owner/config/adoption.json'] = JSON.stringify(adoption)
  expect(() => assertOwnerProgramAuthorityPreserved(old, next, authorityContext)).not.toThrow()
  expect(() => assertOwnerProgramAuthorityPreserved(old, next)).toThrow(/finite authorization changed/u)
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

for (const [name, path, change] of [
  ['adoption executor id', 'adoption', grant => { grant.executor.id = 'forged' }],
  ['adoption executor path', 'adoption', grant => { grant.executor.path = '/other/package' }],
  ['adoption executor hash', 'adoption', grant => { grant.executor.sha256 = 'c'.repeat(64) }],
  ['adoption executor version', 'adoption', grant => { grant.executor.version = 'forged' }],
  ['adoption owner', 'adoption', grant => { grant.owner.principalId = 'other' }],
  ['adoption expiry', 'adoption', grant => { grant.expiresAt++ }],
  ['adoption budget', 'adoption', grant => { grant.maxAdoptions++ }],
  ['adoption ledger', 'adoption', grant => { grant.ledger.id = 'other' }],
  ['adoption target', 'adoption', grant => { grant.target.profile = 'other' }],
  ['adoption handoff', 'adoption', grant => { grant.handoff.coordinatorId = 'other' }],
  ['adoption qualification', 'adoption', grant => { grant.liveQualification.id = 'other' }],
  ['adoption inputs', 'adoption', grant => { grant.hostDeploymentInputs.push('other') }],
  ['adoption policy', 'adoption', grant => { grant.policies[0].requires = ['unsigned'] }],
  ['release policy', 'release', grant => { grant.policies[0].capabilities = ['other'] }],
  ['Host packages', 'host-authority', grant => { grant.packages.push('other') }],
  ['Host inputs', 'host-authority', grant => { grant.hostDeploymentInputs.push('other') }],
]) test(`rejects changed ${name} under a verified Host rebase`, () => {
  const next = structuredClone(old)
  for (const basename of ['release', 'adoption']) {
    const config = JSON.parse(next[`/private/owner/config/${basename}.json`])
    config.grant.policies[0].dshBaseline = 'new'
    if (basename === 'adoption') config.grant.executor = {
      ...config.grant.executor, path: '/new/package', sha256: 'b'.repeat(64), version: 'new',
    }
    next[`/private/owner/config/${basename}.json`] = JSON.stringify(config)
  }
  const configPath = `/private/owner/config/${path}.json`
  const config = JSON.parse(next[configPath])
  change(config.grant)
  next[configPath] = JSON.stringify(config)
  expect(() => assertOwnerProgramAuthorityPreserved(old, next, authorityContext)).toThrow(/finite authorization changed/u)
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

test('original program verification accepts a SQLite checkpoint only while the DB and owner identity stay exact', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-checkpoint-')))
  const databasePath = join(root, 'delivery.sqlite')
  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
  const snapshot = async () => {
    const database = await stat(databasePath)
    const sidecar = async (suffix: string) => {
      try {
        const file = await stat(`${databasePath}${suffix}`)
        return { device: String(file.dev), inode: String(file.ino), size: String(file.size),
          digest: digest(await readFile(`${databasePath}${suffix}`)) }
      } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    }
    const wal = await sidecar('-wal'), shm = await sidecar('-shm')
    const storageDigest = digest(JSON.stringify({ main: digest(await readFile(databasePath)), wal, shm }))
    return { protocol: 'assistant-delivery/active-lark-owner-bindings-snapshot/v1', schemaVersion: 25,
      scope: { account: 'account', tenant: 'tenant', workspace: 'workspace', agentPreset: 'assistant' },
      database: { device: String(database.dev), inode: String(database.ino), size: String(database.size) },
      sidecars: { wal, shm }, storageDigest, snapshotDigest: digest(storageDigest),
      bindings: [{ id: 'binding', version: 1, owner: { id: 'owner', version: 1 } }] }
  }
  try {
    const db = new DatabaseSync(databasePath)
    try {
      db.exec('PRAGMA journal_mode=WAL; CREATE TABLE history (id INTEGER PRIMARY KEY, content TEXT); INSERT INTO history(content) VALUES (\'retained\')')
      const before = await snapshot()
      const composed = { dshDigest: digest('host'), targetEffective: 'target', coordinatorEffective: 'coordinator' }
      const ownerUpdate = { host: { dshDigest: composed.dshDigest }, original: {
        effective: { targetEffective: composed.targetEffective, coordinatorEffective: composed.coordinatorEffective },
        ownerSnapshot: before } }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      const after = await snapshot()
      expect(after.storageDigest).not.toBe(before.storageDigest)
      expect(after.database.inode).toBe(before.database.inode)
      expect(() => assertOwnerProgramOriginalComposition(composed, ownerUpdate, after)).not.toThrow()
      const rejected = [
        { ...after, database: { ...after.database, inode: String(Number(after.database.inode) + 1) } },
        { ...after, bindings: [{ ...after.bindings[0], owner: { id: 'other', version: 1 } }] },
        { ...after, bindings: [{ ...after.bindings[0], owner: { id: 'owner', version: 2 } }] },
        { ...after, bindings: [{ ...after.bindings[0], version: 2 }] },
        { ...after, scope: { ...after.scope, workspace: 'other' } },
      ]
      for (const changed of rejected) {
        expect(() => assertOwnerProgramOriginalComposition(composed, ownerUpdate, changed))
          .toThrow(/original Host composition or owner binding changed/u)
      }
      expect(() => assertOwnerProgramOriginalComposition({ ...composed, dshDigest: digest('changed') },
        ownerUpdate, after)).toThrow(/original Host composition or owner binding changed/u)
      expect(() => assertOwnerProgramOriginalComposition({ ...composed, targetEffective: 'changed' },
        ownerUpdate, after)).toThrow(/original Host composition or owner binding changed/u)
      expect(db.prepare('SELECT content FROM history').get()).toMatchObject({ content: 'retained' })
    } finally { db.close() }
    const priorIdentity = await snapshot()
    await rename(databasePath, `${databasePath}.original`)
    const replacement = new DatabaseSync(databasePath)
    replacement.exec('CREATE TABLE replacement (id INTEGER)')
    replacement.close()
    const replaced = await snapshot()
    expect(replaced.database.inode).not.toBe(priorIdentity.database.inode)
    expect(() => assertOwnerProgramOriginalComposition(
      { dshDigest: digest('host'), targetEffective: 'target', coordinatorEffective: 'coordinator' },
      { host: { dshDigest: digest('host') }, original: {
        effective: { targetEffective: 'target', coordinatorEffective: 'coordinator' },
        ownerSnapshot: priorIdentity } }, replaced))
      .toThrow(/original Host composition or owner binding changed/u)
  } finally { await rm(root, { recursive: true, force: true }) }
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

test('offline stage resolves tagged Home databases and preserves all database and WAL bytes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-stage-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const names = ['assistant-delivery/state.sqlite', 'assistant-verifier/state.sqlite',
      'assistant-policy/policy.sqlite', 'personal-memory/memory.sqlite',
      'personal-wiki/state.sqlite', 'assistant-automations/state.sqlite', 'memory-learning/state.sqlite',
      'growth.sqlite', 'coordinator-automations.sqlite']
    for (const name of names) {
      const content = `retained ${name} used-budget=7 owner=stable\n`
      await mkdir(join(homePath, name, '..'), { recursive: true, mode: 0o700 })
      await mkdir(join(stageHome, name, '..'), { recursive: true, mode: 0o700 })
      await writeFile(join(homePath, name), content, { mode: 0o600 })
      await writeFile(join(stageHome, name), content, { mode: 0o600 })
    }
    const wal = 'assistant-delivery/state.sqlite-wal'
    await writeFile(join(homePath, wal), 'retained WAL', { mode: 0o600 })
    await writeFile(join(stageHome, wal), 'retained WAL', { mode: 0o600 })
    const tagged = (id: string, name: string, quote: string) => `- id: ${id}\n  config:\n    stores:\n      - databasePath: !!js dshHomePath(${quote}${name}${quote})\n`
    const absolute = (id: string, name: string) => `- id: ${id}\n  config:\n    databasePath: ${join(homePath, name)}\n`
    const personal = `- id: dsh-enhanced-personal-assistant\n  config:\n    assistantPolicy:\n      databasePath: !!js dshHomePath('assistant-policy/policy.sqlite')\n    personalMemory:\n      databasePath: !!js dshHomePath('personal-memory/memory.sqlite')\n    personalWiki:\n      databasePath: !!js dshHomePath('personal-wiki/state.sqlite')\n    assistantAutomations: &automations\n      channels:\n        - databasePath: !!js dshHomePath('assistant-automations/state.sqlite')\n    mirroredAutomations: *automations\n`
    const owner = { homePath, original: { effective: {
      targetEffective: tagged('dsh-enhanced-assistant-delivery', 'assistant-delivery/state.sqlite', "'")
        + tagged('dsh-enhanced-assistant-verifier', 'assistant-verifier/state.sqlite', '"')
        + personal
        + absolute('dsh-enhanced-assistant-memory-learning', 'memory-learning/state.sqlite')
        + absolute('dsh-enhanced-assistant-growth-driver', 'growth.sqlite'),
      coordinatorEffective: absolute('dsh-enhanced-assistant-automations', 'coordinator-automations.sqlite') } } }
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner, stageHome))
      .resolves.toBeUndefined()
    await writeFile(join(stageHome, 'assistant-policy/policy.sqlite'), 'reset used-budget=0\n', { mode: 0o600 })
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner, stageHome))
      .rejects.toThrow(/staged owner\/automation\/budget database differs/u)
    await writeFile(join(stageHome, 'assistant-policy/policy.sqlite'),
      await readFile(join(homePath, 'assistant-policy/policy.sqlite')), { mode: 0o600 })
    await writeFile(join(stageHome, wal), 'changed WAL', { mode: 0o600 })
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner, stageHome))
      .rejects.toThrow(/staged owner\/automation\/budget database differs/u)
    expect(await readFile(join(homePath, 'assistant-policy/policy.sqlite'), 'utf8'))
      .toContain('used-budget=7')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('owner database paths reject untagged expressions, unsafe JS, traversal and symlink parents', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-paths-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage'), outside = join(root, 'outside')
    for (const path of [homePath, stageHome, outside]) await mkdir(path, { mode: 0o700 })
    const owner = (value: string) => ({ homePath, original: { effective: {
      targetEffective: `- id: dsh-enhanced-assistant-delivery\n  config:\n    databasePath: ${value}\n`,
      coordinatorEffective: '[]\n' } } })
    const unsafe = [
      `"dshHomePath('state.sqlite')"`,
      `!!js otherFunction('state.sqlite')`,
      `!!js dshHomePath('')`,
      `!!js dshHomePath('.')`,
      `!!js dshHomePath('../outside')`,
      `!!js dshHomePath('state/../outside')`,
      `!!js dshHomePath('/tmp/outside')`,
      `!!js dshHomePath('state\\outside')`,
      `!!js "dshHomePath('state\\n.sqlite')"`,
      `!!js "dshHomePath('state\\0.sqlite')"`,
      join(outside, 'state.sqlite'),
    ]
    for (const value of unsafe) {
      await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner(value), stageHome))
        .rejects.toThrow(/owner database escaped Home/u)
    }
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, {
      homePath, original: { effective: {
        targetEffective: '- id: dsh-enhanced-assistant-delivery\n  config: &loop\n    nested: *loop\n',
        coordinatorEffective: '[]\n' } } }, stageHome))
      .rejects.toThrow(/cyclic database alias/u)
    await mkdir(join(homePath, 'state'), { mode: 0o700 })
    await symlink(outside, join(stageHome, 'state'))
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi },
      owner(`!!js dshHomePath('state/delivery.sqlite')`), stageHome))
      .rejects.toThrow(/owner database escaped Home/u)
    await rm(join(stageHome, 'state'))
    await symlink(outside, join(homePath, 'escape'))
    await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi },
      owner(`!!js dshHomePath('escape/delivery.sqlite')`), stageHome))
      .rejects.toThrow(/owner database escaped Home/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('large owner databases preserve every byte and reject replacement, hard links and loose modes', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-large-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const name = 'policy.sqlite', size = 268_435_457
    const original = join(homePath, name), staged = join(stageHome, name)
    for (const path of [original, staged]) {
      const file = await open(path, 'w', 0o600)
      try { await file.truncate(size) } finally { await file.close() }
    }
    const owner = { homePath, original: { effective: {
      targetEffective: `- id: dsh-enhanced-assistant-policy\n  config:\n    databasePath: ${original}\n`,
      coordinatorEffective: '[]\n' } } }
    const verify = () => assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner, stageHome)
    await expect(verify()).resolves.toBeUndefined()
    const changed = await open(staged, 'r+')
    try { await changed.write(Buffer.from([1]), 0, 1, size - 1) } finally { await changed.close() }
    await expect(verify()).rejects.toThrow(/staged owner\/automation\/budget database differs/u)
    await rm(staged)
    await symlink(original, staged)
    await expect(verify()).rejects.toThrow(/unsafe owner database/u)
    await rm(staged)
    await link(original, staged)
    await expect(verify()).rejects.toThrow(/unsafe owner database/u)
    await rm(staged)
    await writeFile(staged, 'retained', { mode: 0o644 })
    await chmod(staged, 0o644)
    await expect(verify()).rejects.toThrow(/unsafe owner database/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('owner database digest rejects a file that changes while it is being read', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-changing-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const path = join(homePath, 'policy.sqlite'), staged = join(stageHome, 'policy.sqlite')
    for (const name of [path, staged]) {
      const file = await open(name, 'w', 0o600)
      try { await file.truncate(268_435_457) } finally { await file.close() }
    }
    const owner = { homePath, original: { effective: {
      targetEffective: `- id: dsh-enhanced-assistant-policy\n  config:\n    databasePath: ${path}\n`,
      coordinatorEffective: '[]\n' } } }
    const writer = await open(path, 'r+')
    let writing = true, next = 0
    const pending = (async () => {
      while (writing) {
        await writer.write(Buffer.from([next ^= 1]), 0, 1, 268_435_456)
        await new Promise(resolve => setTimeout(resolve, 1))
      }
    })()
    try {
      await expect(assertOwnerProgramBusinessDataCopied({ yaml: yamlApi }, owner, stageHome))
        .rejects.toThrow(/unsafe owner database/u)
    } finally { writing = false; await pending; await writer.close() }
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
