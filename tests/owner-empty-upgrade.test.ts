import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { CreationCapabilityJournal } from '../plugins/plugin-control-plane/src/creation-capability-journal.js'
import { inspectOwnerEmptyCreationHistory } from '../scripts/install/owner-empty-creation-history.mjs'
import { stageOwnerEmptyAdoptionHandoff, verifyOwnerEmptyAdoptionHandoff } from '../scripts/install/owner-empty-adoption-handoff.mjs'
import { readRsiHostUpdateOverlayChain, signRsiOwnerProgramUpdateOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import { ownerFixture, api } from './fixtures/empty-owner-fixture.js'
const control = api.control
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (letter: string) => letter.repeat(64)
const stageInput = (f: Awaited<ReturnType<typeof ownerFixture>>) => ({ ownerUpdate: f.ownerUpdate, stageHome: f.stageHome,
  transactionId: 'transaction-1', manifest: f.nextManifest, candidateCreation: f.candidateCreation,
  stageHistory: f.stageHistory, source: f.source, sourceBuild: f.sourceBuild, api })

test('publishes the explicit maintenance peer without adding a model runtime switch', () => {
  for (const name of ['creationCapabilityPublicKey','planEmptyAdoptionHandoff','applyEmptyAdoptionHandoff','verifyEmptyAdoptionHandoff']) {
    expect(typeof control[name as keyof typeof control]).toBe('function')
  }
})

test('real stopped stage CAS, cutover rename and new constructor preserve the original source and all grant terms', async () => {
  const f = await ownerFixture(), before = readFileSync(f.path), packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  expect(readFileSync(f.path)).toEqual(before)
  expect(packet.plan.oldIdentity.config).toEqual(f.oldConfig)
  expect(packet.plan.nextIdentity.config).toEqual(f.config)
  const next = { transactionId: 'transaction-1', emptyAdoptionHandoff: packet }
  await verifyOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.stageHome, stoppedEmptyAdoption: true, api })
  renameSync(f.root, f.root + '.old'); roots.push(f.root + '.old'); renameSync(f.stageHome, f.root)
  await verifyOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.root, stoppedEmptyAdoption: true, api })
  new CreationCapabilityJournal({ path: f.path, config: f.config }).close()
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })).toThrow()
  expect(readFileSync(f.root + '.old/control-plane/creation-adoptions.sqlite')).toEqual(before)
})

test('an empty journal whose authority predates a runner.image re-pin migrates from the stored row', async () => {
  let stale: Awaited<ReturnType<typeof ownerFixture>>['oldConfig'] | undefined
  const f = await ownerFixture(undefined, { journalConfig: g => (stale = { ...g.oldConfig, runner: { ...g.oldConfig.runner, image: `runner@sha256:${d('9')}` } }) })
  expect(f.stageHistory.adoption.staleConfig).toEqual(stale)
  const packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  expect(packet.plan.oldIdentity.config).toEqual(stale)
  expect(packet.plan.nextIdentity.config).toEqual(f.config)
  const next = { transactionId: 'transaction-1', emptyAdoptionHandoff: packet }
  await verifyOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.stageHome, stoppedEmptyAdoption: true, api })
  const drifted = structuredClone(next)
  drifted.emptyAdoptionHandoff.plan.oldIdentity.config.runner.maxRuns += 1
  await expect(verifyOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: drifted, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.stageHome, stoppedEmptyAdoption: false, api })).rejects.toThrow('signed handoff or current authority differs')
  const g = await ownerFixture(undefined, { journalConfig: h => ({ ...h.oldConfig, runner: { ...h.oldConfig.runner, image: `runner@sha256:${d('8')}` } }) })
  await expect(stageOwnerEmptyAdoptionHandoff({ ...stageInput(g), stageHistory: { ...g.stageHistory,
    adoption: { ...g.stageHistory.adoption, staleConfig: undefined } } })).rejects.toThrow('source history scope changed')
})

test('uses actual maintenance time rather than the original long-lived grant creation time', async () => {
  const f = await ownerFixture(); Object.assign(f.ownerUpdate.original, { now: 1 })
  const started = Date.now(), packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  expect(packet.plan.createdAt).toBeGreaterThanOrEqual(started)
  expect(packet.plan.expiresAt).toBeLessThanOrEqual(packet.plan.createdAt + 300_000)
  expect(packet.plan.oldIdentity.config.expiresAt).toBe(f.oldConfig.expiresAt)
})

test('late nonempty stage state refuses before adoption mutation and retains the source', async () => {
  const f = await ownerFixture(), before = readFileSync(f.path)
  const db = new DatabaseSync(join(f.stageHome, 'control-plane/creation-adoptions.sqlite'))
  db.exec(`INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('late','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`); db.close()
  await expect(inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, physicalHome: f.stageHome, api })).rejects.toThrow('adoption-history-present')
  await expect(stageOwnerEmptyAdoptionHandoff(stageInput(f))).rejects.toThrow('nonempty')
  expect(readFileSync(f.path)).toEqual(before)
})

test('never treats a stage WAL residue as permission to delete or checkpoint it', async () => {
  const f = await ownerFixture(), sidecar = join(f.stageHome, 'control-plane/creation-adoptions.sqlite-wal')
  writeFileSync(sidecar, '', { mode: 0o600 })
  await expect(stageOwnerEmptyAdoptionHandoff(stageInput(f))).rejects.toThrow('sidecar')
  expect(existsSync(sidecar)).toBe(true)
})

test('ordinary poststart verification permits later business but explicit stopped acceptance rejects it', async () => {
  const f = await ownerFixture(), packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  const next = { transactionId: 'transaction-1', emptyAdoptionHandoff: packet }
  const db = new DatabaseSync(join(f.stageHome, 'control-plane/creation-adoptions.sqlite'))
  db.exec(`INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`); db.close()
  const input = { ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.stageHome, api }
  await expect(verifyOwnerEmptyAdoptionHandoff({ ...input, stoppedEmptyAdoption: false })).resolves.toBeUndefined()
  await expect(verifyOwnerEmptyAdoptionHandoff({ ...input, stoppedEmptyAdoption: true })).rejects.toThrow('nonempty')
})

test('rollback discards only the modified stage and leaves the source old authority fully usable', async () => {
  const f = await ownerFixture(), before = readFileSync(f.path)
  await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  rmSync(f.stageHome, { recursive: true })
  expect(readFileSync(f.path)).toEqual(before)
  new CreationCapabilityJournal({ path: f.path, config: f.oldConfig }).close()
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
})

test.each(['plan','metadata','transaction','current-config'])('refuses %s tamper with an anchored packet', async mutation => {
  const f = await ownerFixture(), packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  const copied = structuredClone(packet), metadata = structuredClone(packet.metadata), manifest = structuredClone(f.nextManifest)
  if (mutation === 'plan') copied.plan.createdAt += 1
  if (mutation === 'metadata') metadata.proofDigest = d('f')
  if (mutation === 'transaction') copied.metadata.transactionId = 'another'
  if (mutation === 'current-config') manifest.controlPlane.creationCapabilities.maxAdoptions += 1
  await expect(verifyOwnerEmptyAdoptionHandoff({ ownerUpdate: f.ownerUpdate,
    ownerUpdateNext: { transactionId: 'transaction-1', emptyAdoptionHandoff: copied }, manifest,
    metadata, physicalHome: f.stageHome, stoppedEmptyAdoption: false, api })).rejects.toThrow()
})

test('signs exact optional empty metadata, rejects tampering, and still decodes older owner overlays', async () => {
  const f = await ownerFixture(), packet = await stageOwnerEmptyAdoptionHandoff(stageInput(f))
  const keys = generateKeyPairSync('ed25519'), resources = { ...f.ownerUpdate.original.resources,
    identities: { host: { authority: 'host-authority', keyId: 'host-key',
      publicKeyPem: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString() } } }
  const manifestPath = join(resources.configRoot, 'manifest.json'), files = { [manifestPath]: d('a') }
  const patches = { assistant: d('b'), coordinator: d('c') }
  const input = { schemaVersion: 1 as const, kind: 'rsi-owner-program-update-overlay' as const,
    transactionId: 'transaction-1', dshHome: f.root, targetProfile: 'assistant', installationId: resources.installationId,
    sequence: 1, previousDigest: null, bootstrapDigest: createHash('sha256').update('bootstrap').digest('hex'),
    files, patches, runtimeReceiptDigest: d('d'), planDigest: d('e'),
    result: { schemaVersion: 1 as const, manifestPath, manifestDigest: files[manifestPath]!, targetProfile: 'assistant', coordinatorProfile: 'coordinator' },
    update: { sourceMaintenanceDigest: d('a'), authorityDigest: d('b'), hostPlanDigest: d('c'),
      before: { files, patches, runtimeReceiptDigest: d('d'), creationReceiptDigest: d('e'), journalDigest: d('f') },
      after: { creationReceiptDigest: d('a'), journalDigest: d('b') } },
    issuedAt: Date.now(), authority: resources.identities.host.authority, keyId: resources.identities.host.keyId }
  const key = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const sign = (value: unknown) => signRsiOwnerProgramUpdateOverlay(value as Parameters<typeof signRsiOwnerProgramUpdateOverlay>[0],
    key, resources as Parameters<typeof signRsiOwnerProgramUpdateOverlay>[2], 'bootstrap', [])
  const read = (record: unknown) => readRsiHostUpdateOverlayChain({ source: JSON.stringify({ schemaVersion: 1,
    kind: 'rsi-host-update-overlays', records: [record] }), resources: resources as Parameters<typeof readRsiHostUpdateOverlayChain>[0]['resources'],
    dshHome: f.root, profile: 'assistant', bootstrapSource: 'bootstrap' })
  expect(read(sign(input)).records).toHaveLength(1)
  const signed = sign({ ...input, update: { ...input.update, emptyAdoptionHandoff: packet.metadata } })
  expect(read(signed).latest).toEqual(signed)
  expect(() => read({ ...signed, update: { ...signed.update, emptyAdoptionHandoff: { ...packet.metadata, proofDigest: d('f') } } }))
    .toThrow('signature')
  for (const metadata of [{ ...packet.metadata, unexpected: true }, { ...packet.metadata, logicalPath: '/elsewhere/creation-adoptions.sqlite' },
    { ...packet.metadata, transactionId: 'other' }, { ...packet.metadata, fileIdentity: { ...packet.metadata.fileIdentity, nlink: 2 } }]) {
    expect(() => sign({ ...input, update: { ...input.update, emptyAdoptionHandoff: metadata } })).toThrow('metadata')
  }
})
