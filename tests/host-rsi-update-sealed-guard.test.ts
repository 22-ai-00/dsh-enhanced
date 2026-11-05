import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { planSealedAdoptionHandoff, readSealedAdoptionHandoffDigest } from '../plugins/plugin-control-plane/src/creation-capability-sealed-handoff.js'
import { roots, apply, mutate, sealedLive, seedSettled, staged } from '../plugins/plugin-control-plane/tests/helpers/sealed-handoff-fixture.js'
import { assertSealedAdoptionAuditPresent, sealedAdoptionModule, sealedAdoptionProofDigestRequirement,
  verifySealedAdoptionChain } from '../scripts/install/host-rsi-update.mjs'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const program = (update: Record<string, unknown>) => ({ kind: 'rsi-owner-program-update-overlay', update })
const sealed = (proofDigest: string) => program({ sealedAdoptionHandoff: { protocol: 'dsh-owner-sealed-adoption-handoff/v1', proofDigest } })

test('chains without a sealed handoff carry no sealed audit requirement', () => {
  expect(sealedAdoptionProofDigestRequirement([])).toBeUndefined()
  expect(sealedAdoptionProofDigestRequirement([program({ emptyAdoptionHandoff: {} }), { kind: 'rsi-owner-repair-overlay' },
    { kind: 'rsi-host-update-overlay' }])).toBeUndefined()
  expect(() => sealedAdoptionProofDigestRequirement(undefined as never)).toThrow('chain is invalid')
})

test('a sealed handoff anywhere in the chain requires its signed proof digest, the latest one winning', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64)
  expect(sealedAdoptionProofDigestRequirement([sealed(a)])).toBe(a)
  // A later Host overlay does not end the requirement.
  expect(sealedAdoptionProofDigestRequirement([sealed(a), { kind: 'rsi-host-update-overlay' }])).toBe(a)
  expect(sealedAdoptionProofDigestRequirement([sealed(a), { kind: 'rsi-host-update-overlay' }, sealed(b),
    { kind: 'rsi-host-update-overlay' }])).toBe(b)
  expect(() => sealedAdoptionProofDigestRequirement([sealed('not-a-digest')])).toThrow('proof digest is invalid')
})

test('the injected reader must return exactly the signed digest', async () => {
  const expected = 'c'.repeat(64), physicalPath = '/home/x/creation-adoptions.sqlite'
  const seen: unknown[] = []
  await expect(assertSealedAdoptionAuditPresent({ readDigest: (input: unknown) => { seen.push(input); return expected },
    physicalPath, expected })).resolves.toBeUndefined()
  expect(seen).toEqual([{ physicalPath }])
  await expect(assertSealedAdoptionAuditPresent({ readDigest: () => null, physicalPath, expected })).rejects.toThrow('lost the signed sealed audit')
  await expect(assertSealedAdoptionAuditPresent({ readDigest: () => 'd'.repeat(64), physicalPath, expected })).rejects.toThrow('replaced the signed sealed audit')
  await expect(assertSealedAdoptionAuditPresent({ readDigest: () => { throw new Error('unexpected audit schema') }, physicalPath, expected }))
    .rejects.toThrow('audit is unreadable: unexpected audit schema')
  // An older installed control plane lacks the reader and cannot verify a sealed chain.
  await expect(assertSealedAdoptionAuditPresent({ readDigest: undefined, physicalPath, expected })).rejects.toThrow('readSealedAdoptionHandoffDigest is unavailable')
  await expect(assertSealedAdoptionAuditPresent({ readDigest: () => expected, physicalPath, expected: undefined as never })).rejects.toThrow('proof digest is invalid')
})

test('the real reader accepts a sealed stopped stage without creating sidecars and refuses a dropped or foreign audit', async () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const before = readFileSync(f.physicalPath)
  await assertSealedAdoptionAuditPresent({ readDigest: readSealedAdoptionHandoffDigest, physicalPath: f.physicalPath, expected: proof.digest })
  expect(readFileSync(f.physicalPath)).toEqual(before)
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  await expect(assertSealedAdoptionAuditPresent({ readDigest: readSealedAdoptionHandoffDigest, physicalPath: f.physicalPath,
    expected: 'e'.repeat(64) })).rejects.toThrow('replaced the signed sealed audit')

  const live = sealedLive(seedSettled, 8, 8)
  const digest = readSealedAdoptionHandoffDigest({ physicalPath: live.path })!
  await assertSealedAdoptionAuditPresent({ readDigest: readSealedAdoptionHandoffDigest, physicalPath: live.path, expected: digest })
  mutate(live.path, 'DROP TRIGGER creation_sealed_handoff_no_delete; DROP TRIGGER creation_sealed_handoff_no_update; DROP TABLE creation_sealed_adoption_handoff')
  await expect(assertSealedAdoptionAuditPresent({ readDigest: readSealedAdoptionHandoffDigest, physicalPath: live.path, expected: digest }))
    .rejects.toThrow('lost the signed sealed audit')
})

/** A logical Home whose bytes live in a different physical directory, as for a stage or after the swap. */
function layout(journalSource: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sealed-host-wiring-'))); roots.push(root)
  const homePath = join(root, 'home'), physicalHome = join(root, 'staged-home'), stateRoot = join(homePath, 'state')
  const journal = join(physicalHome, 'state', 'control-plane', 'creation-adoptions.sqlite')
  mkdirSync(dirname(journal), { recursive: true, mode: 0o700 })
  copyFileSync(journalSource, journal); chmodSync(journal, statSync(journalSource).mode & 0o777)
  return { homePath, physicalHome, stateRoot, journal }
}
const controlPlaneRoot = resolve(import.meta.dirname, '../plugins/plugin-control-plane')

test('the Host update wiring reads the mapped physical journal through the installed control-plane module', async () => {
  const live = sealedLive(seedSettled, 8, 8)
  const digest = readSealedAdoptionHandoffDigest({ physicalPath: live.path })!
  const l = layout(live.path), records = [sealed(digest), { kind: 'rsi-host-update-overlay' }]
  const modules = { sealedAdoption: () => sealedAdoptionModule(controlPlaneRoot) }
  // Intact: passes, which also proves the module path and the logical-to-physical mapping (the
  // logical Home holds no journal, so reading it unmapped would refuse).
  await expect(verifySealedAdoptionChain({ records, ...l, modules })).resolves.toBeUndefined()
  expect(existsSync(join(l.stateRoot, 'control-plane'))).toBe(false)
  // No sealed handoff: the module is never loaded.
  await expect(verifySealedAdoptionChain({ records: [{ kind: 'rsi-host-update-overlay' }], ...l,
    modules: { sealedAdoption: () => { throw new Error('must not load') } } })).resolves.toBeUndefined()
  // The scanner keeps refusing a sealed chain.
  await expect(verifySealedAdoptionChain({ records, ...l, modules, sourceOnly: true })).rejects.toThrow('scanner source inspection')
  // A cohort without the module file cannot verify.
  const old = mkdtempSync(join(tmpdir(), 'sealed-old-cohort-')); roots.push(old)
  await expect(sealedAdoptionModule(old)).resolves.toBeUndefined()
  await expect(verifySealedAdoptionChain({ records, ...l, modules: { sealedAdoption: () => sealedAdoptionModule(old) } }))
    .rejects.toThrow('readSealedAdoptionHandoffDigest is unavailable')
  // A foreign signed digest and a dropped audit are both refused.
  await expect(verifySealedAdoptionChain({ records: [sealed('f'.repeat(64))], ...l, modules })).rejects.toThrow('replaced the signed sealed audit')
  mutate(l.journal, 'DROP TRIGGER creation_sealed_handoff_no_delete; DROP TRIGGER creation_sealed_handoff_no_update; DROP TABLE creation_sealed_adoption_handoff')
  await expect(verifySealedAdoptionChain({ records, ...l, modules })).rejects.toThrow('lost the signed sealed audit')
})

test('every ownerConfiguration readiness path runs the sealed check before any early return', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../scripts/install/host-rsi-update.mjs'), 'utf8')
  const body = source.slice(source.indexOf('async function ownerConfiguration('))
  const call = body.indexOf('await verifySealedAdoptionChain({ records: overlay.records')
  expect(call).toBeGreaterThan(0)
  const firstReturn = body.search(/\breturn\b/u)
  expect(firstReturn === -1 || call < firstReturn).toBe(true)
  expect(source).toContain('const sealedAdoption = () => sealedAdoptionModule(cp)')
})
