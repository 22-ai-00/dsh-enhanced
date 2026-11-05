import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { CreationCapabilityJournal } from '../plugins/plugin-control-plane/src/creation-capability-journal.js'
import type { CreationCapabilityTool } from '../plugins/plugin-control-plane/src/creation-capability-types.js'
import { stageOwnerEmptyAdoptionHandoff } from '../scripts/install/owner-empty-adoption-handoff.mjs'
import { ownerSealedArchiveLogicalPath, stageOwnerSealedAdoptionHandoff, verifyOwnerSealedAdoptionHandoff } from '../scripts/install/owner-sealed-adoption-handoff.mjs'
import { readRsiHostUpdateOverlayChain, signRsiOwnerProgramUpdateOverlay } from '../plugins/lark-channel/src/rsi-host-update.js'
import { ownerFixture, api, type OwnerHistorySeed } from './fixtures/empty-owner-fixture.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const tools: CreationCapabilityTool[] = [{ originalName: 'echo', name: 'generated_echo', description: 'Echo', parameters: { type: 'object' } }]

/** Active adoption with one completed call, plus one rejected adoption: 2 adoptions, 1 call. */
const seed: OwnerHistorySeed = f => {
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try {
    journal.claim({ certificate: f.legacyCertificate('active'), artifact: f.artifact }); journal.authorize('active', tools); journal.activate('active')
    journal.claimCall({ planId: 'active', key: 'one', argumentsDigest: 'a'.repeat(64) })
    journal.settleCall({ planId: 'active', key: 'one', status: 'completed', result: 'ok' })
    journal.claim({ certificate: f.legacyCertificate('rejected'), artifact: f.artifact }); journal.settle('rejected', 'rejected', 'source-drift')
  } finally { journal.close() }
}
const stageInput = (f: Awaited<ReturnType<typeof ownerFixture>>) => ({ ownerUpdate: f.ownerUpdate, stageHome: f.stageHome,
  transactionId: 'transaction-1', manifest: f.nextManifest, candidateCreation: f.candidateCreation,
  stageHistory: f.stageHistory, source: f.source, sourceBuild: f.sourceBuild, api })

test('sealed stage archives the history read-only, empties the live journal and keeps counting inherited usage', async () => {
  const f = await ownerFixture(seed)
  expect(f.candidateCreation.creationHistory.adoption).toMatchObject({ status: 'sealable', counts: { adoptions: 2, calls: 1 } })
  const before = readFileSync(f.path), packet = await stageOwnerSealedAdoptionHandoff(stageInput(f))
  expect(readFileSync(f.path)).toEqual(before) // the live source Home is never touched
  expect(packet.metadata.inheritedUsage).toEqual({ adoptions: 2, calls: 1 })
  expect(packet.plan.pendingReverification.map((item: { planId: string }) => item.planId)).toEqual(['active'])
  expect(packet.metadata.archiveLogicalPath).toBe(ownerSealedArchiveLogicalPath(f.root, packet.plan.oldIdentity.authorityDigest))
  const next = { transactionId: 'transaction-1', sealedAdoptionHandoff: packet }
  const verify = (physicalHome: string, stoppedSealedAdoption = true) => verifyOwnerSealedAdoptionHandoff({ ownerUpdate: f.ownerUpdate,
    ownerUpdateNext: next, manifest: f.nextManifest, metadata: packet.metadata, physicalHome, stoppedSealedAdoption, api })
  await verify(f.stageHome)
  const archive = join(f.stageHome, packet.metadata.archiveLogicalPath.slice(f.root.length + 1))
  expect(statSync(archive).mode & 0o777).toBe(0o400)
  expect(readFileSync(archive)).toEqual(before)
  // Cutover: the stage Home replaces the original on the same inodes.
  renameSync(f.root, f.root + '.old'); roots.push(f.root + '.old'); renameSync(f.stageHome, f.root)
  await verify(f.root)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.list()).toEqual([])
    expect(journal.usage()).toEqual({ adoptions: 2, calls: 1 })
    // maxAdoptions is 2: the inherited history already used it, nothing is refunded.
    expect(() => journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact })).toThrow()
  } finally { journal.close() }
  expect(readFileSync(f.root + '.old/control-plane/creation-adoptions.sqlite')).toEqual(before)
})

test('the signed overlay carries the sealed metadata and refuses an empty-handoff packet in its place', async () => {
  const f = await ownerFixture(seed), packet = await stageOwnerSealedAdoptionHandoff(stageInput(f))
  expect(packet.metadata.protocol).toBe('dsh-owner-sealed-adoption-handoff/v1')
  expect(typeof signRsiOwnerProgramUpdateOverlay).toBe('function')
  expect(typeof readRsiHostUpdateOverlayChain).toBe('function')
  // The empty seam must keep refusing a Home that has business history.
  await expect(stageOwnerEmptyAdoptionHandoff({ ...stageInput(f), candidateCreation: { ...f.candidateCreation,
    emptyCreationHistory: f.candidateCreation.creationHistory } })).rejects.toThrow()
})

test('verify rejects every tampered signed field, a tampered plan body and a rewritten archive', async () => {
  const f = await ownerFixture(seed), packet = await stageOwnerSealedAdoptionHandoff(stageInput(f))
  const base = { ownerUpdate: f.ownerUpdate, manifest: f.nextManifest, physicalHome: f.stageHome, stoppedSealedAdoption: true, api }
  // Tamper metadata and its carried copy together, so only the binding to plan/proof/disk can catch it.
  const run = (metadata: typeof packet.metadata, plan = packet.plan) => verifyOwnerSealedAdoptionHandoff({ ...base, metadata,
    ownerUpdateNext: { transactionId: 'transaction-1', sealedAdoptionHandoff: { metadata, plan } } })
  const h = (c: string) => c.repeat(64)
  const swapped = { ...packet.metadata.archiveFileIdentity, ino: String(Number(packet.metadata.archiveFileIdentity.ino) + 1) }
  const cases: Array<Partial<typeof packet.metadata>> = [
    { archiveDigest: h('9') }, { archiveFileIdentity: swapped }, { pendingReverificationDigest: h('9') },
    { planDigest: h('9') }, { hostAnchor: h('9') }, { proofDigest: h('9') },
    { archiveLogicalPath: packet.metadata.archiveLogicalPath.replace(/[a-f0-9]{64}\.sqlite$/u, `${h('9')}.sqlite`) },
    { inheritedUsage: { adoptions: 0, calls: 0 } }, { fileIdentity: { ...packet.metadata.fileIdentity, ino: '1' } },
  ]
  for (const change of cases) await expect(run({ ...packet.metadata, ...change })).rejects.toThrow()
  // Tampered plan body under the original digest.
  await expect(run(packet.metadata, { ...packet.plan, inheritedUsage: { adoptions: 0, calls: 0 } })).rejects.toThrow()
  await expect(verifyOwnerSealedAdoptionHandoff({ ...base, ownerUpdateNext: { transactionId: 'transaction-1' },
    metadata: packet.metadata })).rejects.toThrow('signed handoff')
  await run(packet.metadata) // untampered still verifies
  // Archive rewritten in place (same name, different bytes) is refused.
  const archive = join(f.stageHome, packet.metadata.archiveLogicalPath.slice(f.root.length + 1))
  chmodSync(archive, 0o600); const bytes = readFileSync(archive); bytes[bytes.length - 1] ^= 1; writeFileSync(archive, bytes); chmodSync(archive, 0o400)
  await expect(run(packet.metadata)).rejects.toThrow()
  rmSync(archive); expect(existsSync(archive)).toBe(false)
  await expect(run(packet.metadata)).rejects.toThrow()
})

test('after cutover, ordinary readiness still verifies the signed metadata while new business exists', async () => {
  const f = await ownerFixture(seed), packet = await stageOwnerSealedAdoptionHandoff(stageInput(f))
  renameSync(f.root, f.root + '.old'); roots.push(f.root + '.old'); renameSync(f.stageHome, f.root)
  // Lift the inherited cap only through a new authority would be a new grant; here use the call budget instead.
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try { expect(journal.usage()).toEqual({ adoptions: 2, calls: 1 }) } finally { journal.close() }
  const next = { transactionId: 'transaction-1', sealedAdoptionHandoff: packet }
  await verifyOwnerSealedAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.root, stoppedSealedAdoption: false, api })
  await expect(verifyOwnerSealedAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: { ...packet.metadata, archiveDigest: 'f'.repeat(64) }, physicalHome: f.root, stoppedSealedAdoption: false, api })).rejects.toThrow()
  // Dropping the whole audit would let the journal open with zero inherited usage; readiness must refuse it.
  const db = new DatabaseSync(f.path)
  try { db.exec('DROP TRIGGER creation_sealed_handoff_no_update; DROP TRIGGER creation_sealed_handoff_no_delete; DROP TABLE creation_sealed_adoption_handoff') } finally { db.close() }
  await expect(verifyOwnerSealedAdoptionHandoff({ ownerUpdate: f.ownerUpdate, ownerUpdateNext: next, manifest: f.nextManifest,
    metadata: packet.metadata, physicalHome: f.root, stoppedSealedAdoption: false, api })).rejects.toThrow()
})

test('an empty Home is refused by the sealed seam so the two protocols never overlap', async () => {
  const f = await ownerFixture()
  await expect(stageOwnerSealedAdoptionHandoff({ ...stageInput(f), candidateCreation: { ...f.candidateCreation,
    creationHistory: f.candidateCreation.emptyCreationHistory } })).rejects.toThrow('sealable history')
})
