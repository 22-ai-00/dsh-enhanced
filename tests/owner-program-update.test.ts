import { ownerFixture } from './fixtures/empty-owner-fixture.js'
import { expect, test } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, link, mkdir, mkdtemp, open, readdir, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { controlPlaneDigest } from '../plugins/plugin-control-plane/src/store.js'
import { runtimeConfigDigest } from '../plugins/plugin-control-plane/src/runtime-observer-protocol.js'
import { compilePolicy, evaluatePolicy } from '../plugins/assistant-policy/src/evaluator.js'
import { readRsiHostPatchConfig, readRsiHostUpdateOverlayChain, rebaseRsiHostValue, replaceRsiHostPatchConfig,
  rsiHostUpdateOverlayDigest,
  signRsiOwnerProgramUpdateOverlay, signRsiOwnerRepairOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import { bindLocalSourceInstaller } from '../scripts/install/local-source-maintenance.mjs'
import { ownerProviderEditEquivalent } from '../scripts/install/owner-source-repair.mjs'
import { applyOwnerProgramAuthorityCas, assertOwnerProgramAuthorityPreserved, assertOwnerProgramOriginalComposition, assertOwnerProgramWindow,
  assertOwnerProgramBusinessDataCopied, assertOwnerProgramManifestPreserved, assertNativeStageRelocation,
  freezeNativeRunnerStates, migrateNativeVerifierGrants, validateNativeOwnerProgramRunnerStates,
  prepareOwnerProgramCreation, stageOwnerProgramUpdate, inspectOwnerProgramEmptyCreationStage,
  assertOwnerProgramRestartManifestPreserved, compileOwnerProgramRestartConfig, frozenRestartConfig,
  ownerProgramRestartRule,
  readOwnerProgramRestartConfig, validateOwnerProgramRestartConfig,
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

test('carries an owner model-provider edit and rejects any other drift from the signed patch', () => {
  const signed = `- id: dsh-enhanced-personal-assistant
  config: { databasePath: !!js "dshHomePath('personal/state.sqlite')" }
- id: llm-pi-ai
  name: llm-pi-ai
  config:
    defaultProvider: super-relay
    providers:
      super-relay: { api: openai-completions, baseURL: https://relay.example.invalid/v1, contextWindow: 200000 }
- id: dsh-enhanced-plugin-control-plane
  config: { runtimeObserver: { targets: [] } }
`
  const edited = signed.replace('{ api: openai-completions, baseURL: https://relay.example.invalid/v1, contextWindow: 200000 }',
    `{ api: anthropic-messages, baseURL: https://relay.example.invalid, contextWindow: 1000000 }
      benchmark-gateway-default: { api: openai-completions, apiKeyEnv: BENCH_KEY, models: [glm-5.3-flash, deepseek-v4-flash] }`)
  const check = (current: string) => ownerProviderEditEquivalent({ yaml: yamlApi, signed, current })
  expect(check(signed)).toBe(true)
  expect(check(edited)).toBe(true)
  expect(check(edited.replace('defaultProvider: super-relay', 'defaultProvider: benchmark-gateway-default'))).toBe(false)
  expect(check(edited.replace('name: llm-pi-ai', 'name: other'))).toBe(false)
  expect(check(edited.replace('targets: []', 'targets: [x]'))).toBe(false)
  expect(check(edited.replace("dshHomePath('personal/state.sqlite')", "dshHomePath('escape.sqlite')"))).toBe(false)
  expect(check(edited.replace('models: [glm-5.3-flash, deepseek-v4-flash]', 'models: !!js "process.exit()"'))).toBe(false)
  expect(check(edited.replace('apiKeyEnv: BENCH_KEY', 'apiKeyEnv: &key BENCH_KEY'))).toBe(false)
  const reordered = edited.split('\n- id: ')
  expect(check([reordered[0], reordered[2], reordered[1]].join('\n- id: '))).toBe(false)
  expect(check('not: [valid')).toBe(false)
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
  const revision = { reviews: { runner: { path: '/old-review' }, maxVerifications: 32 },
    regressions: { runner: { path: '/old-regression' }, maxVerifications: 32 },
    revision: { id: 'revision-source-standing', expiresAt: 100, maxRevisions: 32,
      namePrefix: 'owner-standing-' },
    verifications: { authority: { digest: 'c' }, publicKey: 'revision-key' },
    regressionVerifications: { authority: { digest: 'd' }, publicKey: 'revision-key' } }
  const baseline = { sourceReviews: { owner: { principalId: 'owner' }, expiresAt: 100 },
    growthDriver: { provider: 'standing-model-provider', model: 'standing-model' },
    coordinator: { budgetId: 'coordinator-budget', budgetAmount: 1 },
    controlPlane: { sourceBuild: { image: 'old' }, creationVerifications: creation.verifications,
      creationCapabilities: creation.capabilities,
      revisionVerifications: revision.verifications,
      revisionRegressions: revision.regressionVerifications,
      runtimeObserver: { targets: [{ entryId: 'dsh-enhanced-assistant-verifier',
        configDigest: 'a'.repeat(64) }] } }, pluginCreation: creation, pluginRevision: revision }
  const next = structuredClone(baseline)
  next.controlPlane.sourceBuild.image = 'new'
  next.pluginCreation.reviews.runner.path = '/new'
  next.pluginCreation.capabilities.runner.path = '/new'
  next.pluginCreation.verifications.authority.digest = 'b'
  next.pluginRevision.reviews.runner.path = '/new-review'
  next.pluginRevision.regressions.runner.path = '/new-regression'
  next.pluginRevision.verifications.authority.digest = 'e'
  next.pluginRevision.regressionVerifications.authority.digest = 'f'
  next.controlPlane.creationVerifications = structuredClone(next.pluginCreation.verifications)
  next.controlPlane.creationCapabilities = structuredClone(next.pluginCreation.capabilities)
  next.controlPlane.revisionVerifications = structuredClone(next.pluginRevision.verifications)
  next.controlPlane.revisionRegressions = structuredClone(next.pluginRevision.regressionVerifications)
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
  const resetRevision = structuredClone(next)
  resetRevision.pluginRevision.revision.expiresAt = 10_000
  expect(() => assertOwnerProgramManifestPreserved(baseline, resetRevision))
    .toThrow(/outside exact program fields/u)
  const splitMirror = structuredClone(next)
  splitMirror.controlPlane.revisionRegressions = structuredClone(revision.regressionVerifications)
  expect(() => assertOwnerProgramManifestPreserved(baseline, splitMirror))
    .toThrow(/revision authority mirror differs/u)
  const droppedRevision = structuredClone(next)
  delete droppedRevision.pluginRevision
  expect(() => assertOwnerProgramManifestPreserved(baseline, droppedRevision))
    .toThrow(/revision authority disappeared/u)
})

test('manifest binds the native launch digest to the recompiled program', () => {
  const baseline = { sourceReviews: { owner: { principalId: 'owner' }, expiresAt: 100 },
    controlPlane: { sourceBuild: { image: 'old' },
      creationVerifications: { authority: { digest: 'a' }, publicKey: 'standing-key' },
      creationCapabilities: { runner: { image: 'old' } },
      runtimeObserver: { targets: [{ entryId: 'dsh-enhanced-assistant-verifier', configDigest: 'a'.repeat(64) }] } },
    pluginCreation: { reviews: { runner: { image: 'old' } }, capabilities: { runner: { image: 'old' } },
      verifications: { authority: { digest: 'a' }, publicKey: 'standing-key' },
      creation: { id: 'standing-grant', expiresAt: 100, maxCreates: 32 } } }
  const next = structuredClone(baseline)
  next.controlPlane.sourceBuild = { schemaVersion: 3, backend: 'linux-native', sourceCommit: 'a'.repeat(40) }
  next.pluginCreation.reviews.runner = { backend: 'linux-native', stateRoot: '/state/review',
    runtime: { runtime: { node: '/bin/node' } }, cgroupRoots: { cpu: '/cpu' } }
  next.pluginCreation.capabilities.runner = { backend: 'linux-native', stateRoot: '/state/adoption',
    runtime: { runtime: { node: '/bin/node' } }, cgroupRoots: { cpu: '/cpu' } }
  next.controlPlane.creationVerifications = structuredClone(next.pluginCreation.verifications)
  next.controlPlane.creationCapabilities = structuredClone(next.pluginCreation.capabilities)
  next.linuxBuild = { schemaVersion: 1,
    sourceBuildDigest: controlPlaneDigest(next.controlPlane.sourceBuild),
    behaviorRuntimeDigest: controlPlaneDigest(next.pluginCreation.reviews.runner.runtime) }
  expect(() => assertOwnerProgramManifestPreserved(baseline, next, controlPlaneDigest)).not.toThrow()
  const forgedSource = structuredClone(next)
  forgedSource.linuxBuild.sourceBuildDigest = controlPlaneDigest({ backend: 'linux-native', other: true })
  expect(() => assertOwnerProgramManifestPreserved(baseline, forgedSource, controlPlaneDigest))
    .toThrow(/linux build binding differs/u)
  const forgedBehavior = structuredClone(next)
  forgedBehavior.linuxBuild.behaviorRuntimeDigest = controlPlaneDigest({ runtime: { node: '/bin/other' } })
  expect(() => assertOwnerProgramManifestPreserved(baseline, forgedBehavior, controlPlaneDigest))
    .toThrow(/linux build binding differs/u)
  const widened = structuredClone(next)
  widened.linuxBuild.sourceCommit = 'b'.repeat(40)
  expect(() => assertOwnerProgramManifestPreserved(baseline, widened, controlPlaneDigest))
    .toThrow(/linux build binding differs/u)
  const dockerSource = structuredClone(next)
  dockerSource.controlPlane.sourceBuild = { image: 'old' }
  expect(() => assertOwnerProgramManifestPreserved(baseline, dockerSource, controlPlaneDigest))
    .toThrow(/linux build binding differs/u)
  expect(() => assertOwnerProgramManifestPreserved(baseline, next))
    .toThrow(/requires the control-plane digest/u)
  const sealed = structuredClone(baseline)
  sealed.linuxBuild = structuredClone(next.linuxBuild)
  const removed = structuredClone(next)
  delete removed.linuxBuild
  expect(() => assertOwnerProgramManifestPreserved(sealed, removed, controlPlaneDigest))
    .toThrow(/linux build binding disappeared/u)
  expect(() => assertOwnerProgramManifestPreserved(baseline, removed, controlPlaneDigest))
    .toThrow(/binding is required for the native repository backend/u)
})

test('owner-private restart config fixes one route, database, finite budgets and explicit tools', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-restart-')))
  const home = join(root, 'home'), input = join(root, 'restart.json')
  await mkdir(home, { mode: 0o700 })
  const delivery = { databasePath: join(home, 'assistant-delivery', 'state.sqlite'),
    ownerRoutes: [{ id: 'owner-route' }] }
  const restart = { databasePath: join(home, 'assistant-delivery', 'restart.sqlite'),
    ownerRouteId: 'owner-route', maxModelRequests: 12, maxToolCalls: 24,
    taskTimeoutMs: 300_000, allowedTools: ['delivery_reply', 'delivery_status'] }
  try {
    await writeFile(input, JSON.stringify(restart), { mode: 0o600 })
    expect(await readOwnerProgramRestartConfig(input, home, delivery)).toEqual(restart)
    for (const changed of [
      { ...restart, ownerRouteId: 'other' },
      { ...restart, databasePath: join(root, 'escape.sqlite') },
      { ...restart, maxModelRequests: 257 },
      { ...restart, maxToolCalls: 1025 },
      { ...restart, taskTimeoutMs: 3_600_001 },
      { ...restart, allowedTools: ['delivery_reply', 'delivery_reply'] },
      { ...restart, allowedTools: ['tool_*'] },
      { ...restart, surprise: true },
    ]) expect(() => validateOwnerProgramRestartConfig(changed, home, delivery)).toThrow(/restart config exceeds/u)
    expect(() => validateOwnerProgramRestartConfig(restart, home, { ...delivery,
      ownerRoutes: [{ id: 'owner-route' }, { id: 'other' }] })).toThrow(/restart config exceeds/u)
    expect(() => validateOwnerProgramRestartConfig(restart, home, { ...delivery, restart }))
      .toThrow(/restart config exceeds/u)
    await chmod(input, 0o644)
    await expect(readOwnerProgramRestartConfig(input, home, delivery)).rejects.toThrow(/unsafe file/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('restart manifest permits only the derived Delivery observer digest', () => {
  const home = '/private/owner'
  const restart = { databasePath: `${home}/assistant-delivery/restart.sqlite`, ownerRouteId: 'owner-route',
    maxModelRequests: 12, maxToolCalls: 24, taskTimeoutMs: 300_000, allowedTools: ['delivery_reply'] }
  const originalDelivery = { databasePath: `${home}/assistant-delivery/state.sqlite`,
    ownerRoutes: [{ id: 'owner-route' }] }
  const personal = { assistantPolicy: { rules: [{ id: 'rsi-owner-maintenance-restart', effect: 'allow',
    subject: { kind: 'agent', id: 'standard', workspace: '/private/work', principal: 'lark/primary/personal/user' },
    actions: ['maintenance.restart'], resource: { kind: 'message', id: 'maintenance:owner-route' },
    context: { initiators: ['external'] } }] } }
  const targetPatch = `[
    { id: dsh-enhanced-assistant-delivery, config: ${JSON.stringify({ ...originalDelivery, restart })} },
    { id: dsh-enhanced-personal-assistant, config: ${JSON.stringify(personal)} }
  ]`
  const digest = runtimeConfigDigest({ ...originalDelivery, restart })
  const creation = { reviews: { runner: { path: '/old' } },
    capabilities: { runner: { path: '/old' }, maxAdoptions: 2 },
    verifications: { authority: { digest: 'a' } } }
  const before = { controlPlane: { sourceBuild: { image: 'old' },
    creationVerifications: creation.verifications, creationCapabilities: creation.capabilities,
    runtimeObserver: { targets: [
      { entryId: 'dsh-enhanced-assistant-delivery', configDigest: 'a'.repeat(64) },
      { entryId: 'dsh-enhanced-personal-assistant', configDigest: 'a'.repeat(64) },
      { entryId: 'dsh-enhanced-assistant-verifier', configDigest: 'a'.repeat(64) },
    ] } }, pluginCreation: creation }
  const after = structuredClone(before)
  after.controlPlane.runtimeObserver.targets[0]!.configDigest = digest
  after.controlPlane.runtimeObserver.targets[1]!.configDigest = runtimeConfigDigest(personal)
  const api = { readRsiHostPatchConfig, control: { runtimeConfigDigest } }
  expect(() => assertOwnerProgramRestartManifestPreserved(before, after, restart, targetPatch, api)).not.toThrow()
  const unrelated = structuredClone(after)
  unrelated.controlPlane.runtimeObserver.targets.push({ entryId: 'other', configDigest: 'b'.repeat(64) })
  expect(() => assertOwnerProgramRestartManifestPreserved(before, unrelated, restart, targetPatch, api))
    .toThrow(/runtime observer identity changed/u)
  const forged = structuredClone(after)
  forged.controlPlane.runtimeObserver.targets[0]!.configDigest = 'b'.repeat(64)
  expect(() => assertOwnerProgramRestartManifestPreserved(before, forged, restart, targetPatch, api))
    .toThrow(/restart Delivery observer digest differs/u)
  const other = structuredClone(after)
  other.pluginCreation.capabilities.maxAdoptions = 10
  expect(() => assertOwnerProgramRestartManifestPreserved(before, other, restart, targetPatch, api))
    .toThrow(/outside exact program fields/u)
})

test('restart compiler changes only Delivery config and its Control Plane observer digest', () => {
  const home = '/private/owner'
  const principal = { channel: 'lark', account: 'primary', tenant: 'personal', user: 'user' }
  const conversation = { channel: 'lark', account: 'primary', tenant: 'personal', kind: 'dm', chat: 'chat' }
  const ownerRoute = { id: 'owner-route', principal, conversation, workspace: '/private/work',
    agentPreset: 'standard', policyRef: 'owner-dm' }
  const delivery = { databasePath: `${home}/assistant-delivery/state.sqlite`,
    ownerRoutes: [ownerRoute] }
  const personal = { assistantPolicy: { rules: [{ id: 'existing', effect: 'deny' }] } }
  const restart = { databasePath: `${home}/assistant-delivery/restart.sqlite`, ownerRouteId: 'owner-route',
    maxModelRequests: 12, maxToolCalls: 24, taskTimeoutMs: 300_000, allowedTools: ['delivery_reply'] }
  const patch = `[
    { id: dsh-enhanced-assistant-delivery, config: ${JSON.stringify(delivery)} },
    { id: dsh-enhanced-personal-assistant, config: ${JSON.stringify(personal)} },
    { id: unrelated, config: { value: !!js "dshHomePath('unrelated/state.sqlite')" } }
  ]`
  const originalDigest = runtimeConfigDigest(delivery)
  const original = { ownerSnapshot: { bindings: [{ id: 'binding-1', status: 'active',
    owner: { status: 'active', role: 'owner' }, workspace: ownerRoute.workspace,
    agentPreset: ownerRoute.agentPreset, policyRef: ownerRoute.policyRef, conversation, principal }] },
  manifest: { sourceReviews: { owner: { principalId: 'lark/primary/personal/user' } } } }
  const manifest = { controlPlane: { runtimeObserver: { targets: [
    { entryId: 'dsh-enhanced-assistant-delivery', configDigest: originalDigest },
    { entryId: 'dsh-enhanced-personal-assistant', configDigest: runtimeConfigDigest(personal) },
    { entryId: 'unrelated', configDigest: 'a'.repeat(64) },
  ] } } }
  const api = { readRsiHostPatchConfig, replaceRsiHostPatchConfig, control: { runtimeConfigDigest } }
  expect(compileOwnerProgramRestartConfig(api, patch, structuredClone(manifest), undefined, home, original)).toBe(patch)
  const next = structuredClone(manifest)
  const compiled = compileOwnerProgramRestartConfig(api, patch, next, restart, home, original)
  expect(patchConfig(api, compiled, 'dsh-enhanced-assistant-delivery')).toEqual({ ...delivery, restart })
  expect(patchConfig(api, compiled, 'dsh-enhanced-personal-assistant').assistantPolicy.rules).toEqual([
    personal.assistantPolicy.rules[0],
    { id: 'rsi-owner-maintenance-restart', effect: 'allow',
      subject: { kind: 'agent', id: 'standard', workspace: '/private/work',
        principal: 'lark/primary/personal/user' }, actions: ['maintenance.restart'],
      resource: { kind: 'message', id: 'maintenance:owner-route' }, context: { initiators: ['external'] } },
  ])
  const rule = patchConfig(api, compiled, 'dsh-enhanced-personal-assistant').assistantPolicy.rules[1]
  const policy = compilePolicy([rule])
  const request = { subject: { kind: 'agent', id: 'standard', workspace: '/private/work',
    principal: 'lark/primary/personal/user' }, action: 'maintenance.restart',
  resource: { kind: 'message', id: 'maintenance:owner-route' }, context: { initiator: 'external' } }
  expect(evaluatePolicy(policy, request).effect).toBe('allow')
  const rotated = structuredClone(original)
  rotated.ownerSnapshot.bindings[0]!.id = 'binding-rotated'
  expect(ownerProgramRestartRule(rotated, delivery, restart)).toEqual(rule)
  for (const changed of [
    { ...request, resource: { kind: 'message', id: 'maintenance:other-route' } },
    { ...request, subject: { ...request.subject, principal: 'lark/primary/personal/other' } },
    { ...request, subject: { ...request.subject, workspace: '/private/other' } },
    { ...request, context: { initiator: 'background' } },
  ]) expect(evaluatePolicy(policy, changed).effect).toBe('deny')
  expect(compiled).toContain('!!js')
  expect(next.controlPlane.runtimeObserver.targets).toEqual([
    { entryId: 'dsh-enhanced-assistant-delivery', configDigest: runtimeConfigDigest({ ...delivery, restart }) },
    { entryId: 'dsh-enhanced-personal-assistant',
      configDigest: runtimeConfigDigest(patchConfig(api, compiled, 'dsh-enhanced-personal-assistant')) },
    manifest.controlPlane.runtimeObserver.targets[2],
  ])
  const drift = structuredClone(manifest)
  drift.controlPlane.runtimeObserver.targets[0]!.configDigest = 'b'.repeat(64)
  expect(() => compileOwnerProgramRestartConfig(api, patch, drift, restart, home, original))
    .toThrow(/existing Delivery or Policy observer digest differs/u)
})

test('frozen restart proof rejects resumed config content or digest drift', () => {
  const home = '/private/owner'
  const delivery = { databasePath: `${home}/assistant-delivery/state.sqlite`,
    ownerRoutes: [{ id: 'owner-route' }] }
  const restart = validateOwnerProgramRestartConfig({
    databasePath: `${home}/assistant-delivery/restart.sqlite`, ownerRouteId: 'owner-route',
    maxModelRequests: 12, maxToolCalls: 24, taskTimeoutMs: 300_000, allowedTools: ['delivery_reply'],
  }, home, delivery)
  const proof = { homePath: home, profile: 'assistant', restartConfigSourcePath: '/private/restart.json',
    restartConfig: restart, restartConfigDigest: createHash('sha256').update(JSON.stringify(restart)).digest('hex'),
    original: { patches: { assistant: `[{ id: dsh-enhanced-assistant-delivery, config: ${JSON.stringify(delivery)} }]` } } }
  const api = { readRsiHostPatchConfig }
  expect(frozenRestartConfig(proof, api)).toEqual(restart)
  expect(() => frozenRestartConfig({ ...proof, restartConfig: { ...restart, maxToolCalls: 25 } }, api))
    .toThrow(/restart config digest differs/u)
  expect(() => frozenRestartConfig({ ...proof, restartConfigDigest: 'a'.repeat(64) }, api))
    .toThrow(/restart config digest differs/u)
  expect(() => frozenRestartConfig({ ...proof, restartConfigSourcePath: '../restart.json' }, api))
    .toThrow(/restart config proof differs/u)
  expect(frozenRestartConfig({ homePath: home }, api)).toBeUndefined()
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

const ownerInstallerModules = ['rsi-authority-resources', 'rsi-authority-runtime', 'rsi-source-maintenance',
  'rsi-creation-build', 'rsi-source', 'rsi-build', 'rsi-local-update-build', 'rsi-release-build',
  'rsi-profile', 'rsi-host-update', 'rsi-plugin-creation', 'rsi-install', 'rsi-service-environment',
  'systemd', 'rsi-authority-config', 'rsi-bootstrap-manifest', 'rsi-setup', 'rsi-install-inputs',
  'rsi-local-cohort', 'rsi-linux-creation-build', 'rsi-linux-native-materialize',
  'rsi-linux-source-build', 'rsi-linux-native-resources', 'rsi-plugin-revision']

const installerStub = (body: string) => `import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const fixture = async () => JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'))
const record = async (seam, input) => writeFile(join(root, 'calls.jsonl'),
  JSON.stringify({ seam, input }) + '\\n', { flag: 'a' })
${body}`

/** A minimal reviewed installer tree whose lib modules answer from a fixture.
 * The creation seams are recording stubs, so backend selection is testable on
 * every platform; the native seam itself is covered by its own module tests. */
async function ownerCreationInstaller(fixture: Record<string, unknown>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-creation-')))
  const lib = join(root, 'plugins/lark-channel/lib')
  const control = join(root, 'node_modules/@dsh-enhanced/plugin-control-plane')
  const yamlModule = join(root, 'node_modules/yaml')
  for (const directory of [lib, control, yamlModule, join(root, 'packages'),
    join(root, 'scripts/install')]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
  }
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  await writeFile(join(root, 'pnpm-lock.yaml'), 'fixture-lock')
  await writeFile(join(root, 'plugins/lark-channel/package.json'), '{"type":"module"}')
  await writeFile(join(yamlModule, 'package.json'), '{"name":"yaml","version":"2.0.0","main":"index.js"}')
  await writeFile(join(yamlModule, 'index.js'), 'module.exports = { parse: () => [], stringify: () => "" }\n')
  await writeFile(join(control, 'package.json'), JSON.stringify({ name: '@dsh-enhanced/plugin-control-plane',
    type: 'module', main: 'index.js', exports: { '.': './index.js', './package.json': './package.json' } }))
  await writeFile(join(control, 'index.js'),
    "import { createHash } from 'node:crypto'\nexport const controlPlaneDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')\n")
  const seam = (directory: string, body: string) => `export async function ${body}(input) {
  await record('${directory}', input)
  const tree = join(input.dshHome, '${directory}', input.profile)
  await mkdir(tree, { recursive: true, mode: 0o700 })
  await writeFile(join(tree, 'bootstrap.json'), '{"seam":"${directory}"}', { mode: 0o600 })
  return (await fixture()).creationBuild
}`
  const bodies: Record<string, string> = {
    'rsi-source': 'export async function readRsiSourceWorkspace() { return (await fixture()).source }',
    'rsi-local-update-build': 'export async function readRsiLocalUpdateSourceBuild() { return (await fixture()).build }',
    'rsi-creation-build': seam('rsi-creation-builds', 'prepareRsiCreationBuildEnvironment'),
    'rsi-linux-creation-build': seam('rsi-linux-creation-builds',
      'prepareLinuxRsiCreationBuildEnvironment'),
  }
  for (const name of ownerInstallerModules) {
    await writeFile(join(lib, `${name}.js`), installerStub(bodies[name] ?? 'export {}'))
  }
  await writeFile(join(root, 'fixture.json'), JSON.stringify(fixture))
  return { root, binding: await bindLocalSourceInstaller(root) }
}

function ownerProgramUpdate(installer: { root: string, binding: unknown }, originalBuild: unknown) {
  const hostPlan = {}
  return { protocol: 'dsh-enhanced/host-owner-program-update/v1', homePath: join(installer.root, 'home'),
    installer: installer.binding, hostPlan,
    hostPlanDigest: createHash('sha256').update(JSON.stringify(hostPlan)).digest('hex'),
    profile: 'assistant',
    original: { build: originalBuild, source: { workspace: { sourceCommit: 'a'.repeat(40) } } } }
}

const candidateSource = (commit: string) => ({ sourceCommit: commit, workspace: { revision: 'candidate' } })
const candidateBuild = (backend: 'docker' | 'linux-native', commit: string) => backend === 'docker'
  ? { schemaVersion: 1, sourceCommit: commit } : { schemaVersion: 3, backend, sourceCommit: commit,
    lockSha256: 'c'.repeat(64) }
const creationBuild = (backend: 'docker' | 'linux-native', commit: string) => backend === 'docker'
  ? { schemaVersion: 1, sourceBuild: { sourceCommit: commit } }
  : { schemaVersion: 3, backend, sourceCommit: commit, behavior: {}, cgroupRoots: [] }

async function recordedSeams(root: string) {
  const lines = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n')
  return lines.map(line => JSON.parse(line) as { seam: string, input: Record<string, unknown> })
}

async function emptyOwnerCreationEntry() {
  const source = candidateSource('b'.repeat(40))
  const build = candidateBuild('linux-native', source.sourceCommit)
  const creation = creationBuild('linux-native', source.sourceCommit)
  const installer = await ownerCreationInstaller({ source, build, creationBuild: creation })
  const candidateHome = join(installer.root, 'candidate')
  await mkdir(candidateHome, { mode: 0o700 })
  const real = await ownerFixture()
  const library = new URL('../plugins/plugin-control-plane/lib/', import.meta.url)
  await writeFile(join(installer.root, 'node_modules/@dsh-enhanced/plugin-control-plane/index.js'),
    `export * from ${JSON.stringify(new URL('index.js', library).href)};
`
    + `export { creationCapabilityPublicKey } from ${JSON.stringify(new URL('creation-capability-journal.js', library).href)};
`
    + `export { planEmptyAdoptionHandoff, applyEmptyAdoptionHandoff, verifyEmptyAdoptionHandoff } from ${JSON.stringify(new URL('creation-capability-empty-handoff.js', library).href)};
`)
  await writeFile(join(installer.root, 'node_modules/yaml/index.js'),
    `module.exports = require(${JSON.stringify(new URL('../node_modules/yaml', import.meta.url).pathname)})`)
  installer.binding = await bindLocalSourceInstaller(installer.root)
  const base = ownerProgramUpdate(installer, candidateBuild('docker', 'a'.repeat(40)))
  const ownerUpdate = { ...base, homePath: real.ownerUpdate.homePath,
    original: { ...real.ownerUpdate.original, ...base.original } }

  return { source, build, creation, installer, candidateHome, ownerUpdate, real }
}

test('prepareOwnerProgramCreation performs the reviewed Docker -> linux-native backend transition', async () => {
  const { source, build, creation, installer, candidateHome, ownerUpdate } = await emptyOwnerCreationEntry()
  try {
    const result = await prepareOwnerProgramCreation({ ownerUpdate, candidateHome, source,
      sourceBuild: build })
    expect(result).toMatchObject({ schemaVersion: 1, backend: 'linux-native',
      backendTransition: 'docker->linux-native', candidateHome, candidateSource: source,
      candidateBuild: build, creationBuild: creation })
    const seams = await recordedSeams(installer.root)
    expect(seams.map(call => call.seam)).toEqual(['rsi-linux-creation-builds'])
    expect(seams[0].input).toMatchObject({ dshHome: candidateHome, profile: 'assistant',
      stateRoot: join(candidateHome, 'rsi-authorities', 'assistant', 'state') })
    expect((await stat(join(candidateHome, 'rsi-authorities', 'assistant', 'state'))).mode & 0o777)
      .toBe(0o700)
    expect(result.receiptSha256).toBe(createHash('sha256').update(await readFile(
      join(candidateHome, 'rsi-linux-creation-builds', 'assistant', 'bootstrap.json'))).digest('hex'))
  } finally { await rm(installer.root, { recursive: true, force: true }) }
})

test('prepareOwnerProgramCreation refuses a native installation moving back to a Docker candidate', async () => {
  const source = candidateSource('b'.repeat(40))
  const installer = await ownerCreationInstaller({ source, build: candidateBuild('docker', source.sourceCommit),
    creationBuild: creationBuild('docker', source.sourceCommit) })
  try {
    const candidateHome = join(installer.root, 'candidate')
    await mkdir(candidateHome, { mode: 0o700 })
    const ownerUpdate = ownerProgramUpdate(installer, candidateBuild('linux-native', 'a'.repeat(40)))
    await expect(prepareOwnerProgramCreation({ ownerUpdate, candidateHome, source,
      sourceBuild: candidateBuild('docker', source.sourceCommit) }))
      .rejects.toThrow(/candidate build backend differs from the original installation/u)
    await expect(readFile(join(installer.root, 'calls.jsonl')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(installer.root, { recursive: true, force: true }) }
})

test('prepareOwnerProgramCreation keeps the Docker creation seam and omits a backend transition', async () => {
  const source = candidateSource('b'.repeat(40))
  const build = candidateBuild('docker', source.sourceCommit)
  const creation = creationBuild('docker', source.sourceCommit)
  const installer = await ownerCreationInstaller({ source, build, creationBuild: creation })
  try {
    const candidateHome = join(installer.root, 'candidate')
    await mkdir(candidateHome, { mode: 0o700 })
    const ownerUpdate = ownerProgramUpdate(installer, candidateBuild('docker', 'a'.repeat(40)))
    const result = await prepareOwnerProgramCreation({ ownerUpdate, candidateHome, source,
      sourceBuild: build })
    expect(result).not.toHaveProperty('backendTransition')
    expect(result).not.toHaveProperty('backend')
    expect(result).toMatchObject({ schemaVersion: 1, candidateHome, candidateSource: source,
      candidateBuild: build, creationBuild: creation })
    const seams = await recordedSeams(installer.root)
    expect(seams.map(call => call.seam)).toEqual(['rsi-creation-builds'])
    expect(result.receiptSha256).toBe(createHash('sha256').update(await readFile(
      join(candidateHome, 'rsi-creation-builds', 'assistant', 'bootstrap.json'))).digest('hex'))
  } finally { await rm(installer.root, { recursive: true, force: true }) }
})

test('native stage dispatch requires the sealed C2-C relocation proof before any write', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-gate-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const ownerUpdate = { homePath, profile: 'assistant' }
    let error: (Error & { code?: string }) | undefined
    try {
      assertNativeStageRelocation(ownerUpdate, { native: true, profile: 'assistant', transactionId: 'tx-1' })
    } catch (caught) { error = caught as Error & { code?: string } }
    expect(error?.code).toBe('rsi-linux-native-stage-relocation-unavailable')
    expect(error?.message).toMatch(/C2-C relocated-family proof/u)
    expect(error?.message).toMatch(/native resource staging/u)
    expect(error?.message).toMatch(/nothing has been written for transaction tx-1/u)
    // The refusal happens before the materializer/freeze seams and before any
    // owner manifest, overlay or journal write.
    expect(await readdir(stageHome)).toEqual([])
    expect(await readdir(homePath)).toEqual([])
    expect(() => assertNativeStageRelocation({ ...ownerUpdate,
      nativeRelocation: { schemaVersion: 1, backend: 'linux-native' } },
    { native: true, profile: 'assistant', transactionId: 'tx-1' })).not.toThrow()
    expect(() => assertNativeStageRelocation(ownerUpdate,
      { native: false, profile: 'assistant', transactionId: 'tx-1' })).not.toThrow()
    // A full stageOwnerProgramUpdate fixture needs the complete owner Home,
    // control-plane ledger and overlay chain, so the dispatch ordering is
    // pinned against the reviewed call site as well.
    const script = await readFile(new URL('../scripts/install/owner-program-update.mjs', import.meta.url), 'utf8')
    const gateAt = script.lastIndexOf('assertNativeStageRelocation(ownerUpdate, { native, profile, transactionId })')
    expect(gateAt).toBeGreaterThan(script.indexOf(
      "fail('candidate creation build backend differs from the candidate source build')"))
    expect(gateAt).toBeLessThan(script.indexOf('await api.materializeLinuxRsiNativeInStage('))
  } finally { await rm(root, { recursive: true, force: true }) }
})

const refusalOf = (run: () => unknown) => {
  try { run() } catch (error) { return error as Error & { code?: string } }
  throw new Error('expected the native handover seam to refuse')
}
const nativeCommit = 'b'.repeat(40)
const nativeResources = (home: string) => ({ schemaVersion: 1, root: home,
  stateRoot: join(home, 'state') })
const nativeSource = { schemaVersion: 1, sourceCommit: nativeCommit }
const nativeCreation = {
  sourceBuild: { backend: 'linux-native', repository: { schemaVersion: 4, backend: 'linux-native',
    sourceCommit: nativeCommit, lockSha256: 'c'.repeat(64) }, cgroupRoots: [] },
  family: { creationBuild: { schemaVersion: 3, backend: 'linux-native', sourceCommit: nativeCommit } },
}
const nativeSealPath = (home: string, name: string) => join(home, 'state', 'native-runner-states',
  `${name}.json`)
const nativeSeal = (home: string, name: string) => ({ path: nativeSealPath(home, name),
  sha256: 'd'.repeat(64) })
// A staged fresh seal: the migration re-reads it from the staged copy, so the
// fixture publishes the exact body whose digest the frozen record carries.
const stagedNativeSeal = async (stageHome: string, home: string, name: string) => {
  const body = JSON.stringify({ schemaVersion: 1, protocol: 'dsh-linux-runner-state/v1',
    id: `verification:${name}`, kind: 'verification', uid: 1000,
    stateRoot: { path: join(home, 'state', name), dev: 1, ino: 2 },
    ledger: { path: join(home, 'state', name, 'ledger.sqlite'), dev: 1, ino: 3 },
    ledgerSchemaVersion: 9, schemaSha256: 'e'.repeat(64) })
  const staged = join(stageHome, 'state', 'native-runner-states', `${name}.json`)
  await mkdir(join(stageHome, 'state', 'native-runner-states'), { recursive: true, mode: 0o700 })
  await writeFile(staged, body, { mode: 0o600 })
  return { path: nativeSealPath(home, name), sha256: createHash('sha256').update(body).digest('hex') }
}
const freezeInput = (root: string, homePath: string, stageHome: string) => ({ profile: 'assistant',
  transactionId: 'tx-native', stageHome, homePath, resources: nativeResources(homePath),
  source: nativeSource, owner: { principalId: 'owner-1' }, now: 1_000, expiresAt: 2_000,
  creation: nativeCreation, api: {} })

test('native revision authority is frozen and recompiled inside the native stage', async () => {
  const script = await readFile(new URL('../scripts/install/owner-program-update.mjs', import.meta.url), 'utf8')
  // The revision runner states are frozen with the creation ones, from the
  // revision flag the manifest itself decides.
  expect(script).toContain('const revision = original.manifest.pluginRevision !== undefined')
  expect(script).toContain(
    "if (revision && !native) fail('owner profile revision requires the linux-native candidate backend')")
  expect(script).toContain('expiresAt: original.manifest.sourceReviews.expiresAt, revision, creation, api })')
  // The reviewed revision setup is compiled from the creation build and frozen
  // revision seals, then mirrored into the manifest and the verifier patch.
  const setup = script.indexOf('api.createRsiPluginRevisionSetup({')
  expect(setup).toBeGreaterThan(script.indexOf('api.createRsiPluginCreationSetup({'))
  expect(setup).toBeLessThan(script.indexOf('migrateNativeVerifierGrants({ transactionId, stageHome'))
  expect(script).toContain('build: frozen.creationBuild')
  expect(script).toContain('expiresAt: freshCreation.creation.expiresAt')
  expect(script).toContain('review: frozen.seals.revisionReview')
  expect(script).toContain('regression: frozen.seals.revisionRegression')
  expect(script).toContain('manifest.pluginRevision = programRevision(manifest.pluginRevision, freshRevision)')
  expect(script).toContain(
    'manifest.controlPlane.revisionVerifications = manifest.pluginRevision.verifications')
  expect(script).toContain(
    'manifest.controlPlane.revisionRegressions = manifest.pluginRevision.regressionVerifications')
  expect(script).toContain("fail('source revision grant changed')")
  expect(script).toContain("fail('revision finite grant or review authority changed')")
  expect(script).toContain('revisionReviews: manifest.pluginRevision.reviews')
  expect(script).toContain('revisionRegressions: manifest.pluginRevision.regressions')
  // The removed deferred-slice gate must not come back.
  expect(script).not.toContain('assertNativeRevisionAvailable')
  expect(script).not.toContain('rsi-linux-native-revision-unavailable')
  const relocationGateAt = script.lastIndexOf(
    'assertNativeStageRelocation(ownerUpdate, { native, profile, transactionId })')
  expect(relocationGateAt).toBeGreaterThan(-1)
  expect(relocationGateAt).toBeLessThan(script.indexOf('await api.materializeLinuxRsiNativeInStage('))
})

test('native runner-state freeze refuses invalid inputs before touching the staged Home', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-freeze-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, homePath) })).message)
      .toMatch(/invalid Home pair/u)
    expect(refusalOf(() => freezeNativeRunnerStates(
      { ...freezeInput(root, homePath, homePath), stageHome: join(homePath, 'stage') })).message)
      .toMatch(/invalid Home pair/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      resources: { schemaVersion: 1, root: '/elsewhere', stateRoot: '/elsewhere/state' } })).message)
      .toMatch(/owner authority resources do not describe the state root/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      source: { schemaVersion: 1, sourceCommit: 'nope' } })).message)
      .toMatch(/source, owner or authority lifetime is incomplete/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      expiresAt: 1_000 })).message)
      .toMatch(/source, owner or authority lifetime is incomplete/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      creation: { ...nativeCreation, sourceBuild: { ...nativeCreation.sourceBuild,
        repository: { ...nativeCreation.sourceBuild.repository, schemaVersion: 3 } } } })).message)
      .toMatch(/not the relocated linux-native build environment/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      revision: 'yes' })).message).toMatch(/the revision role flag is not a boolean/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      revision: true, api: { prepareLinuxRepositoryHandoverState: () => ({}),
        compileRsiLinuxSourceBuild: () => ({}), prepareLinuxVerifierStagingState: () => ({}) } })).message)
      .toMatch(/does not expose the reviewed createRsiPluginRevisionSetup seam/u)
    // A missing reviewed native-resources seam fails closed and names it.
    expect(refusalOf(() => freezeNativeRunnerStates(freezeInput(root, homePath, stageHome))).message)
      .toMatch(/prepareLinuxRepositoryHandoverState seam \(rsi-linux-native-resources/u)
    expect(await readdir(stageHome)).toEqual([])
    expect(await readdir(homePath)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native runner-state freeze seals the repository before compiling and then the verifiers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-handover-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const order: string[] = []
    const repositorySeal = nativeSeal(homePath, 'linux-source-build-runner')
    const reviewSeal = nativeSeal(homePath, 'creation-review-runner')
    const adoptionSeal = nativeSeal(homePath, 'creation-adoption-runner')
    const revisionReviewSeal = nativeSeal(homePath, 'revision-review-runner')
    const revisionRegressionSeal = nativeSeal(homePath, 'revision-regression-runner')
    const compiled = { schemaVersion: 3, backend: 'linux-native', stateSeal: repositorySeal }
    const api = {
      prepareLinuxRepositoryHandoverState: (input: Record<string, unknown>) => {
        order.push('repository')
        expect(input).toEqual({ stageStateRoot: join(stageHome, 'state', 'linux-source-build-runner'),
          stageSealPath: join(stageHome, 'state', 'native-runner-states',
            'linux-source-build-runner.json'),
          liveStateRoot: join(homePath, 'state', 'linux-source-build-runner'),
          liveSealPath: nativeSealPath(homePath, 'linux-source-build-runner') })
        return repositorySeal
      },
      compileRsiLinuxSourceBuild: (input: Record<string, unknown>) => {
        order.push('compile')
        expect(input).toMatchObject({ prepared: nativeCreation.sourceBuild, resources:
          nativeResources(homePath), source: nativeSource, owner: { principalId: 'owner-1' },
        now: 1_000, expiresAt: 2_000, stateSeal: repositorySeal })
        return compiled
      },
      createRsiPluginRevisionSetup: () => ({ reviews: {}, regressions: {} }),
      prepareLinuxVerifierStagingState: (input: Record<string, unknown>) => {
        order.push(String(input.name))
        const seals: Record<string, unknown> = { 'creation-review-runner': reviewSeal,
          'creation-adoption-runner': adoptionSeal, 'revision-review-runner': revisionReviewSeal,
          'revision-regression-runner': revisionRegressionSeal }
        const grant = { principalDigest: 'a'.repeat(64), revision: 1, expiresAt: 2_000,
          maxRuns: 160, maxTotalDurationMs: 4_800_000 }
        return { mode: 'handover', seal: seals[String(input.name)], grant }
      },
    }
    const frozen = freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome), revision: true,
      api })
    expect(order).toEqual(['repository', 'compile', 'creation-review-runner',
      'creation-adoption-runner', 'revision-review-runner', 'revision-regression-runner'])
    expect(frozen.sourceBuild).toBe(compiled)
    expect(frozen.creationBuild).toBe(nativeCreation.family.creationBuild)
    expect(frozen.seals).toEqual({ review: reviewSeal, adoption: adoptionSeal,
      revisionReview: revisionReviewSeal, revisionRegression: revisionRegressionSeal })
    expect(frozen.modes).toEqual({ review: 'handover', adoption: 'handover',
      revisionReview: 'handover', revisionRegression: 'handover' })
    expect(Object.isFrozen(frozen) && Object.isFrozen(frozen.seals)
      && Object.isFrozen(frozen.verifierGrants)).toBe(true)
    // Without the revision flag the manifest keeps the deferred Docker-era
    // revision authority untouched instead of sealing unreferenced roles.
    const creationOnly = freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome), api })
    expect(Object.keys(creationOnly.seals)).toEqual(['review', 'adoption'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a verifier role with no Docker-era history is sealed fresh, not handed over', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-fresh-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const repositorySeal = nativeSeal(homePath, 'source-build-runner')
    const reviewSeal = nativeSeal(homePath, 'creation-review-runner')
    const adoptionSeal = nativeSeal(homePath, 'creation-adoption-runner')
    const compiled = { schemaVersion: 1 }
    const grant = { principalDigest: 'a'.repeat(64), revision: 1, expiresAt: 2_000, maxRuns: 1_024,
      maxTotalDurationMs: 86_400_000 }
    const api = {
      prepareLinuxRepositoryHandoverState: () => repositorySeal,
      compileRsiLinuxSourceBuild: () => compiled,
      // The reviewed seam decides from the staged tree; the installer only
      // records the mode and refuses to read a grant out of a fresh role.
      prepareLinuxVerifierStagingState: (input: Record<string, unknown>) =>
        input.name === 'creation-review-runner'
          ? { mode: 'fresh', seal: reviewSeal }
          : { mode: 'handover', seal: adoptionSeal, grant },
    }
    const frozen = freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome), api })
    expect(frozen.sourceBuild).toBe(compiled)
    expect(frozen.modes).toEqual({ review: 'fresh', adoption: 'handover' })
    expect(frozen.seals).toEqual({ review: reviewSeal, adoption: adoptionSeal })
    expect(Object.keys(frozen.verifierGrants)).toEqual(['adoption'])
    expect(frozen.verifierGrants.adoption).toBe(grant)
    // A fresh role never claims a Docker-era grant and every role records its
    // mode, so a seam that silently changes the path cannot pass unnoticed.
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      api: { ...api, prepareLinuxVerifierStagingState: () =>
        ({ mode: 'fresh', seal: reviewSeal, grant }) } })).message)
      .toMatch(/the fresh creation-review-runner staging state carries a Docker-era owner grant/u)
    expect(refusalOf(() => freezeNativeRunnerStates({ ...freezeInput(root, homePath, stageHome),
      api: { ...api, prepareLinuxVerifierStagingState: () => ({ seal: reviewSeal }) } })).message)
      .toMatch(/not sealed as a fresh native runner or a Docker-era handover/u)
    expect(await readdir(stageHome)).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native verifier grant migration rewrites the Docker-era grants with the frozen seals', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-migrate-')))
  try {
    const homePath = join(root, 'home'), stageHome = join(root, 'stage')
    await mkdir(homePath, { mode: 0o700 }); await mkdir(stageHome, { mode: 0o700 })
    const oldDigest = 'a'.repeat(64), newDigest = 'b'.repeat(64)
    const reviewSeal = await stagedNativeSeal(stageHome, homePath, 'creation-review-runner')
    const adoptionSeal = nativeSeal(homePath, 'creation-adoption-runner')
    const calls: Record<string, unknown>[] = []
    const api = {
      creationAdoptionAuthorityDigest: ({ capabilities }: { capabilities: { fresh?: boolean } }) =>
        capabilities.fresh ? newDigest : oldDigest,
      migrateLinuxVerifierRunnerState: (input: Record<string, unknown>) => {
        calls.push(input)
        return { seal: input.existingSeal, jobsMigrated: 2, activeSettled: 1 }
      },
    }
    const original = { manifest: { controlPlane: {
      creationVerifications: { authority: { authorityDigest: oldDigest } },
      creationCapabilities: { fresh: false } } } }
    const latest = { reviews: { runner: { stateSeal: reviewSeal, expiresAt: 5_000, maxRuns: 160,
      maxTotalDurationMs: 4_800_000 } },
    verifications: { authority: { authorityDigest: newDigest } },
    capabilities: { fresh: true,
      runner: { stateSeal: adoptionSeal, expiresAt: 5_000, maxRuns: 1_024, maxTotalDurationMs: 86_400_000 } } }
    const frozen = { seals: { review: reviewSeal, adoption: adoptionSeal },
      modes: { review: 'handover', adoption: 'handover' },
      verifierGrants: { review: { principalDigest: oldDigest }, adoption: { principalDigest: oldDigest } } }
    const migrate = (overrides: Record<string, unknown> = {}) => migrateNativeVerifierGrants({
      transactionId: 'tx-3', stageHome, homePath, resources: nativeResources(homePath), original,
      freshCreation: latest, frozen, api, now: 4_000, ...overrides })
    const migrated = migrate()
    expect(calls.map(call => call.name))
      .toEqual(['creation-review-runner', 'creation-adoption-runner'])
    expect(calls[0]).toEqual({ name: 'creation-review-runner',
      stageStateRoot: join(stageHome, 'state', 'creation-review-runner'),
      stageSealPath: join(stageHome, 'state', 'native-runner-states', 'creation-review-runner.json'),
      liveStateRoot: join(homePath, 'state', 'creation-review-runner'),
      liveSealPath: nativeSealPath(homePath, 'creation-review-runner'),
      oldAuthorityDigest: oldDigest, newAuthorityDigest: newDigest,
      existingSeal: reviewSeal, expiresAt: 5_000, maxRuns: 160,
      maxTotalDurationMs: 4_800_000, now: 4_000 })
    expect(calls[1]).toMatchObject({ name: 'creation-adoption-runner', maxRuns: 1_024,
      newAuthorityDigest: newDigest, existingSeal: adoptionSeal })
    expect(migrated).toMatchObject({ review: { seal: reviewSeal, mode: 'handover',
      jobsMigrated: 2, activeSettled: 1 }, adoption: { seal: adoptionSeal } })
    // A manifest that already carries a revision migrates all four verifier
    // grants, so the native Home never keeps a Docker-era revision runner.
    const revisionReviewSeal = nativeSeal(homePath, 'revision-review-runner')
    const revisionRegressionSeal = nativeSeal(homePath, 'revision-regression-runner')
    const revisionDigest = 'c'.repeat(64), nextRevisionDigest = 'd'.repeat(64)
    const revisionOriginal = { manifest: { controlPlane: {
      ...original.manifest.controlPlane,
      revisionVerifications: { authority: { authorityDigest: revisionDigest } },
      revisionRegressions: { authority: { authorityDigest: revisionDigest } } } } }
    const freshRevision = {
      reviews: { runner: { stateSeal: revisionReviewSeal, expiresAt: 6_000, maxRuns: 160,
        maxTotalDurationMs: 4_800_000 } },
      verifications: { authority: { authorityDigest: nextRevisionDigest } },
      regressions: { runner: { stateSeal: revisionRegressionSeal, expiresAt: 6_000, maxRuns: 320,
        maxTotalDurationMs: 9_600_000 } },
      regressionVerifications: { authority: { authorityDigest: nextRevisionDigest } } }
    calls.length = 0
    const revisionFrozen = { seals: { ...frozen.seals, revisionReview: revisionReviewSeal,
      revisionRegression: revisionRegressionSeal },
    modes: { ...frozen.modes, revisionReview: 'handover', revisionRegression: 'handover' },
    verifierGrants: { ...frozen.verifierGrants,
      revisionReview: { principalDigest: revisionDigest },
      revisionRegression: { principalDigest: revisionDigest } } }
    const revisionMigrated = migrate({ original: revisionOriginal, freshRevision,
      frozen: revisionFrozen })
    expect(calls.map(call => call.name)).toEqual(['creation-review-runner',
      'creation-adoption-runner', 'revision-review-runner', 'revision-regression-runner'])
    expect(calls[2]).toMatchObject({ name: 'revision-review-runner', maxRuns: 160,
      oldAuthorityDigest: revisionDigest, newAuthorityDigest: nextRevisionDigest,
      existingSeal: revisionReviewSeal })
    expect(calls[3]).toMatchObject({ name: 'revision-regression-runner', maxRuns: 320,
      oldAuthorityDigest: revisionDigest, newAuthorityDigest: nextRevisionDigest,
      existingSeal: revisionRegressionSeal })
    expect(revisionMigrated).toMatchObject({ revisionReview: { seal: revisionReviewSeal },
      revisionRegression: { seal: revisionRegressionSeal } })
    expect(refusalOf(() => migrate({ original: revisionOriginal, freshRevision,
      frozen: { ...revisionFrozen, seals: { ...revisionFrozen.seals,
        revisionRegression: adoptionSeal } } })).message)
      .toMatch(/the frozen seal is not the one the compiled revision authority binds/u)
    expect(refusalOf(() => migrate({ original: revisionOriginal, freshRevision,
      frozen: { ...revisionFrozen, verifierGrants: { ...revisionFrozen.verifierGrants,
        revisionReview: { principalDigest: 'e'.repeat(64) } } } })).message)
      .toMatch(/the staged grant is not the live Docker-era owner grant/u)
    expect(refusalOf(() => migrate({ original: revisionOriginal,
      freshRevision: { ...freshRevision, verifications: { authority: {} } },
      frozen: revisionFrozen })).message)
      .toMatch(/compiled revisionReview verifier authority digest is unavailable/u)
    expect(refusalOf(() => migrate({ original: { manifest: { controlPlane: {
      ...original.manifest.controlPlane,
      revisionRegressions: { authority: { authorityDigest: revisionDigest } } } } },
    freshRevision, frozen: revisionFrozen })).message)
      .toMatch(/the original manifest carries no revisionReview verifier authority digest/u)
    // The staged grant must still be the one the freeze sealed.
    expect(refusalOf(() => migrate({ frozen: { ...frozen,
      verifierGrants: { review: { principalDigest: 'e'.repeat(64) }, adoption: frozen.verifierGrants.adoption } } }))
      .message).toMatch(/the staged grant is not the live Docker-era owner grant/u)
    // Validation is two-pass: a later refusal must not leave the review grant
    // already rewritten in the staged Home.
    const before = calls.length
    expect(refusalOf(() => migrate({ frozen: { ...frozen,
      verifierGrants: { review: frozen.verifierGrants.review,
        adoption: { principalDigest: 'f'.repeat(64) } } } })).message)
      .toMatch(/the staged grant is not the live Docker-era owner grant/u)
    expect(calls.length).toBe(before)
    // The compiled authority must bind the frozen seal.
    expect(refusalOf(() => migrate({ freshCreation: { ...latest, reviews: { ...latest.reviews,
      runner: { ...latest.reviews.runner, stateSeal: adoptionSeal } } } })).message)
      .toMatch(/the frozen seal is not the one the compiled creation authority binds/u)
    // The original manifest must carry the Docker-era review digest.
    expect(refusalOf(() => migrate({ original: { manifest: { controlPlane: {
      creationCapabilities: { fresh: false } } } } })).message)
      .toMatch(/staged owner creation authority is incomplete: the original manifest carries no review/u)
    // A role the Docker-era Home never ran is staged fresh: its empty sealed
    // ledger is already the state a fresh install publishes, so there is no
    // Docker-era grant to rewrite and no job history to fence.
    calls.length = 0
    const freshFrozen = { seals: frozen.seals, modes: { review: 'fresh', adoption: 'handover' },
      verifierGrants: { adoption: frozen.verifierGrants.adoption } }
    const freshMigrated = migrate({ frozen: freshFrozen })
    expect(calls.map(call => call.name)).toEqual(['creation-adoption-runner'])
    expect(freshMigrated).toMatchObject({ review: { seal: reviewSeal, mode: 'fresh',
      jobsMigrated: 0, activeSettled: 0 }, adoption: { mode: 'handover' } })
    // The fresh path re-reads the staged seal, so a seal replaced after the
    // freeze is refused instead of riding the frozen in-memory handle.
    const stagedReviewSeal = join(stageHome, 'state', 'native-runner-states',
      'creation-review-runner.json')
    const sealedBytes = await readFile(stagedReviewSeal)
    await writeFile(stagedReviewSeal, '{"replaced":true}', { mode: 0o600 })
    expect(refusalOf(() => migrate({ frozen: freshFrozen })).message)
      .toMatch(/the freshly prepared staged seal is not the frozen reference/u)
    await rm(stagedReviewSeal)
    expect(refusalOf(() => migrate({ frozen: freshFrozen })).message)
      .toMatch(/the freshly prepared staged seal is missing from the staging copy/u)
    await mkdir(join(stageHome, 'state', 'native-runner-states'), { recursive: true, mode: 0o700 })
    await writeFile(stagedReviewSeal, sealedBytes, { mode: 0o600 })
    // A fresh role must not claim a Docker-era grant, a handed-over role must
    // keep one, and every role must record which path it took.
    expect(refusalOf(() => migrate({ frozen: { ...freshFrozen,
      verifierGrants: { ...freshFrozen.verifierGrants, review: { principalDigest: oldDigest } } } })).message)
      .toMatch(/the freshly prepared staging state carries a Docker-era owner grant/u)
    expect(refusalOf(() => migrate({ frozen: { seals: frozen.seals,
      verifierGrants: frozen.verifierGrants } })).message)
      .toMatch(/does not record whether the role was handed over or freshly prepared/u)
    expect(refusalOf(() => migrate({ frozen: { seals: frozen.seals,
      modes: { review: 'handover', adoption: 'fresh' } } })).message)
      .toMatch(/the handed-over staging state carries no Docker-era owner grant/u)
    // A missing reviewed handover seam fails closed and names it.
    expect(refusalOf(() => migrate({ api: { creationAdoptionAuthorityDigest: api.creationAdoptionAuthorityDigest } }))
      .message).toMatch(/does not expose the reviewed handover seams/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the cut-over linux-native manifest re-inspects its runner-state references', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'owner-program-native-ready-')))
  try {
    const homePath = join(root, 'home')
    await mkdir(homePath, { mode: 0o700 })
    const resources = nativeResources(homePath)
    const ownerUpdate = { original: { resources } }
    const seal = nativeSeal(homePath, 'creation-review-runner')
    const manifest = { controlPlane: { sourceBuild: { schemaVersion: 3, backend: 'linux-native',
      stateSeal: seal } }, pluginCreation: { reviews: { runner: { stateSeal: seal } } } }
    const calls: unknown[][] = []
    const api = { prepareRsiLinuxRunnerStates: async (...input: unknown[]) => {
      calls.push(input)
      return { sourceBuild: seal, creationReview: seal, creationAdoption: seal }
    } }
    // The live manifest is the only source of references and the reviewed
    // existing-only seam does the inspection; the installer adds no repair.
    expect(await validateNativeOwnerProgramRunnerStates(api, ownerUpdate, manifest)).toBeUndefined()
    expect(calls).toEqual([[resources, { creation: true, revision: false }, manifest]])
    // A Docker-era or non-native manifest keeps the untouched readiness path.
    await validateNativeOwnerProgramRunnerStates(api, ownerUpdate,
      { controlPlane: { sourceBuild: { schemaVersion: 2, backend: 'docker' } } })
    await validateNativeOwnerProgramRunnerStates(api, ownerUpdate, { controlPlane: {} })
    expect(calls).toHaveLength(1)
    // An installed installer tree without the reviewed seam cannot prove a
    // linux-native cutover, so readiness fails closed instead of trusting it.
    await expect(validateNativeOwnerProgramRunnerStates({}, ownerUpdate, manifest))
      .rejects.toThrow(/the cut-over owner manifest is linux-native but this installer cannot re-inspect/u)
    // A live Home whose seals were deleted or replaced after the cutover stops
    // readiness; the inspected error keeps its original cause.
    await expect(validateNativeOwnerProgramRunnerStates({ prepareRsiLinuxRunnerStates: async () => {
      throw new Error('Linux runner state: seal reference or purpose differs')
    } }, ownerUpdate, manifest)).rejects
      .toThrow(/do not re-inspect on the live Home: Linux runner state: seal reference or purpose differs/u)
    // The re-inspection only trusts authority resources that actually describe
    // a state root, and a native manifest must carry creation authority.
    await expect(validateNativeOwnerProgramRunnerStates(api,
      { original: { resources: { ...resources, stateRoot: join(homePath, 'other') } } }, manifest))
      .rejects.toThrow(/the owner authority resources do not describe a state root/u)
    await expect(validateNativeOwnerProgramRunnerStates(api, ownerUpdate,
      { controlPlane: { sourceBuild: { backend: 'linux-native' } } }))
      .rejects.toThrow(/carries no creation authority for its runner-state references/u)
    expect(calls).toHaveLength(1)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('the native handover seams stay ordered around the creation authority', async () => {
  const script = await readFile(new URL('../scripts/install/owner-program-update.mjs', import.meta.url), 'utf8')
  const repository = script.indexOf('api.prepareLinuxRepositoryHandoverState(location(')
  const compile = script.indexOf('api.compileRsiLinuxSourceBuild({')
  const review = script.indexOf('api.prepareLinuxVerifierStagingState({ name, ...location(name) })')
  expect(repository).toBeGreaterThan(-1)
  expect(repository).toBeLessThan(compile)
  expect(compile).toBeLessThan(review)
  const setup = script.indexOf('api.createRsiPluginCreationSetup({')
  const revisionSetup = script.indexOf('api.createRsiPluginRevisionSetup({')
  const migrated = script.indexOf('migrateNativeVerifierGrants({ transactionId, stageHome')
  const capabilities = script.indexOf(
    'manifest.controlPlane.creationCapabilities = manifest.pluginCreation.capabilities')
  const frozenCall = script.indexOf('const frozen = native ? freezeNativeRunnerStates({')
  expect(frozenCall).toBeGreaterThan(script.indexOf('await api.materializeLinuxRsiNativeInStage('))
  expect(frozenCall).toBeLessThan(script.indexOf('manifest.controlPlane.sourceBuild ='))
  expect(migrated).toBeGreaterThan(setup)
  expect(revisionSetup).toBeGreaterThan(setup)
  expect(revisionSetup).toBeLessThan(migrated)
  expect(migrated).toBeGreaterThan(capabilities)
  expect(migrated).toBeLessThan(script.indexOf(
    "fail('owner model, memory, budget, or service scope changed')"))
  // The seals and grants the handover produces stay out of the persisted
  // manifest; the revision authority mirrors the creation one.
  const persisted = script.split('\n').filter(line =>
    /^\s*manifest\.(controlPlane|linuxBuild|pluginCreation|pluginRevision)/u.test(line))
  expect(persisted.some(line => /stateSeal|creationSeals|verifierGrants/u.test(line))).toBe(false)
  expect(persisted.some(line => /manifest\.pluginRevision\.(reviews|regressions)\b/u.test(line)))
    .toBe(false)
  expect(persisted.some(line => /revisionVerifications|revisionRegressions/u.test(line))).toBe(true)
  // The reviewed installer allowlist stays mirrored by this test's stub tree.
  const names = script.match(/const names = \[([\s\S]*?)\]/u)?.[1] ?? ''
  expect([...names.matchAll(/'([a-z0-9-]+)'/gu)].map(match => match[1]))
    .toEqual(ownerInstallerModules)
})


test.each(['unknown','closed','rejected'])('classifies %s creation history as sealable without touching the source journal', async status => {
  const f = await emptyOwnerCreationEntry()
  try {
    const db = new DatabaseSync(f.real.path)
    db.exec(`INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('past','${status}','{}','${'a'.repeat(64)}',X'01','${'b'.repeat(64)}','retained')`); db.close()
    const before = await readFile(f.real.path)
    const prepared = await prepareOwnerProgramCreation({ ownerUpdate: f.ownerUpdate, candidateHome: f.candidateHome,
      source: f.source, sourceBuild: f.build })
    // Business history is sealed later by the stopped stage; the empty v1 record must not be produced.
    expect(prepared.emptyCreationHistory).toBeUndefined()
    expect(prepared.creationHistory).toMatchObject({ protocol: 'dsh-owner-creation-history/v2', status: 'sealable',
      adoption: { status: 'sealable', counts: { adoptions: 1 } } })
    expect(prepared.creationHistory.adoption.byStatus[status]).toBe(1)
    expect(await readFile(f.real.path)).toEqual(before)
  } finally { await rm(f.installer.root, { recursive: true, force: true }) }
})

test('non-empty review history with an empty adoption journal is classified for the review handoff, not refused', async () => {
  const f = await emptyOwnerCreationEntry()
  try {
    const review = join(f.real.root, 'verifier.sqlite.creation-reviews')
    const db = new DatabaseSync(review)
    db.exec("INSERT INTO verifications VALUES('old','binding','creation-review','unknown','{}')"); db.close()
    const before = await readFile(review)
    const result = await prepareOwnerProgramCreation({ ownerUpdate: f.ownerUpdate, candidateHome: f.candidateHome,
      source: f.source, sourceBuild: f.build })
    // The adoption journal alone picks the adoption seam; the review lane is reported for the review handoff.
    expect(result.creationHistory).toBeUndefined()
    expect(result.emptyCreationHistory).toMatchObject({ protocol: 'dsh-owner-creation-history/v2', status: 'sealable',
      adoption: { status: 'empty' } })
    expect(result.emptyCreationHistory.reviews.find((item: { lane: string }) => item.lane === 'creation-reviews'))
      .toMatchObject({ status: 'sealable' })
    // Preparation only classifies: the live review lane is never written.
    expect(await readFile(review)).toEqual(before)
  } finally { await rm(f.installer.root, { recursive: true, force: true }) }
})

test('refuses a configured missing review store and native-to-native updates before candidate writes', async () => {
  const f = await emptyOwnerCreationEntry()
  try {
    await rm(join(f.real.root, 'verifier.sqlite.creation-reviews'))
    await expect(prepareOwnerProgramCreation({ ownerUpdate: f.ownerUpdate, candidateHome: f.candidateHome,
      source: f.source, sourceBuild: f.build })).rejects.toThrow('review-database-missing')
    expect(await readdir(f.candidateHome)).toEqual([])
    f.ownerUpdate.original.build = candidateBuild('linux-native', 'a'.repeat(40))
    await expect(prepareOwnerProgramCreation({ ownerUpdate: f.ownerUpdate, candidateHome: f.candidateHome,
      source: f.source, sourceBuild: f.build })).rejects.toThrow('native updates require a separate lineage contract')
    expect(await readdir(f.candidateHome)).toEqual([])
  } finally { await rm(f.installer.root, { recursive: true, force: true }) }
})


test('the authenticated outer stage gate rechecks real copied history without creating any native resources', async () => {
  const f = await emptyOwnerCreationEntry()
  try {
    const input = { ownerUpdate: f.ownerUpdate, physicalHome: f.real.stageHome, installer: f.installer.binding }
    expect((await inspectOwnerProgramEmptyCreationStage(input)).status).toBe('empty')
    expect(await readdir(f.candidateHome)).toEqual([])
    await expect(inspectOwnerProgramEmptyCreationStage({ ...input, physicalHome: f.real.root })).rejects.toThrow('separate Docker-origin stage')
    const path = join(f.real.stageHome, 'control-plane/creation-adoptions.sqlite')
    const db = new DatabaseSync(path)
    db.exec(`INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('late','unknown','{}','${'a'.repeat(64)}',X'01','${'b'.repeat(64)}','retained')`); db.close()
    // A late stopped-stage adoption is classified for sealing, never silently treated as empty.
    expect((await inspectOwnerProgramEmptyCreationStage(input)).status).toBe('sealable')
    expect(await readdir(f.candidateHome)).toEqual([])
  } finally { await rm(f.installer.root, { recursive: true, force: true }) }
})
