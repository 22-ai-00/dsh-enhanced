import { createPrivateKey, sign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal } from '../src/creation-capability-journal.js'
import { planSealedAdoptionHandoff, readSealedReverificationSource } from '../src/creation-capability-sealed-handoff.js'
import { roots, d, sha, seedSettled, seedUnsettled, staged, apply, verify, cutover, type Fixture } from './helpers/sealed-handoff-fixture.js'

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const RESTORE = "CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON creation_sealed_adoption_handoff BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END"
const SIDECARS = ['-wal', '-shm', '-journal']
type File = { path: string; content: string }

function sealed(seed: (f: Fixture) => void = seedSettled, live = true) {
  const f = staged(seed), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  if (live) cutover(f)
  const physicalPath = live ? f.path : f.physicalPath, archivePath = live ? f.archiveLogicalPath : f.archivePhysicalPath
  const read = (input: { expectedProofDigest?: string; planId?: string; physicalPath?: string } = {}) =>
    readSealedReverificationSource({ physicalPath, expectedProofDigest: proof.digest, planId: 'active', ...input })
  return { ...f, plan, proof, physicalPath, archivePath, read }
}
/** Rewrites the stored proof with every self-digest recomputed; only the returned digest anchors it. */
function rewriteProof(file: string, change: (plan: { history: { rows: Record<string, unknown>[] } }) => void): string {
  const db = new DatabaseSync(file)
  try {
    const proof = JSON.parse((db.prepare('SELECT proof_json FROM creation_sealed_adoption_handoff').get() as { proof_json: string }).proof_json)
    change(proof.plan)
    proof.plan.history.rowsDigest = sha(canonicalGrowthJson(proof.plan.history.rows))
    const { digest: _plan, ...planBody } = proof.plan
    proof.plan.digest = sha(canonicalGrowthJson(planBody))
    const { digest: _proof, ...body } = proof
    proof.digest = sha(canonicalGrowthJson(body))
    db.exec('DROP TRIGGER creation_sealed_handoff_no_update')
    db.prepare('UPDATE creation_sealed_adoption_handoff SET proof_json=?,proof_digest=?').run(canonicalGrowthJson(proof), proof.digest)
    db.exec(RESTORE)
    return proof.digest as string
  } finally { db.close() }
}
/** Docker-era journal whose active source archive was altered before sealing, so archive bytes stay consistent. */
function tamperedSource(change: (item: Record<string, unknown>, f: Fixture) => void) {
  return (f: Fixture) => {
    seedSettled(f)
    const db = new DatabaseSync(f.path)
    try {
      const row = db.prepare("SELECT archive_json FROM source_archives WHERE plan_id='active'").get() as { archive_json: string }
      const item = JSON.parse(row.archive_json) as Record<string, unknown>
      change(item, f)
      db.prepare("UPDATE source_archives SET archive_json=? WHERE plan_id='active'").run(canonicalGrowthJson(item))
    } finally { db.close() }
  }
}
const resign = (item: Record<string, unknown>, f: Fixture) => {
  const { signature: _signature, ...body } = item
  item.signature = sign(null, Buffer.from(`dsh-created-capability-source-archive-v1\0${canonicalGrowthJson(body)}`),
    createPrivateKey(readFileSync(f.oldConfig.keyPath))).toString('base64url')
}

test('reads only candidate source of a pending tool from a cut-over sealed live journal', async () => {
  const extra: File[] = [{ path: 'tests/index.spec.ts', content: 'test\n' }, { path: 'README.md', content: '# active\n' },
    { path: 'package.json', content: '{}\n' }]
  const s = sealed(f => seedSettled(f, extra))
  const archive = readFileSync(s.archivePath)
  const files = [{ path: 'README.md', content: '# active\n' }, { path: 'src/index.ts', content: 'export const answer = 42\n' },
    { path: 'tests/index.spec.ts', content: 'test\n' }]
  const expected = { planId: 'active', name: 'generated-active', files, filesDigest: sha(canonicalGrowthJson(files)),
    archiveRowDigest: s.plan.history.rows.find(row => row.planId === 'active')!.sourceArchiveDigest, oldAuthorityDigest: s.oldDigest }
  const result = s.read()
  expect(result).toEqual(expected)
  expect(Object.isFrozen(result.files)).toBe(true)
  // A running Host journal with WAL sidecars and later live business still reads the same provenance.
  const journal = new CreationCapabilityJournal({ path: s.path, config: s.config })
  try {
    journal.claim({ certificate: s.certificate('fresh'), artifact: s.artifact })
    expect(existsSync(`${s.path}-wal`)).toBe(true)
    expect(s.read()).toEqual(expected)
  } finally { journal.close() }
  expect(readFileSync(s.archivePath)).toEqual(archive)
  for (const suffix of SIDECARS) expect(existsSync(s.archivePath + suffix)).toBe(false)
  expect((await import('../src/index.js')).readSealedReverificationSource).toBe(readSealedReverificationSource)
})

test('a stopped stage read creates no sidecars and leaves journal and archive bytes unchanged', () => {
  const s = sealed(seedSettled, false)
  const journal = readFileSync(s.physicalPath), archive = readFileSync(s.archivePath)
  expect(s.read().planId).toBe('active')
  for (const file of [s.physicalPath, s.archivePath]) for (const suffix of SIDECARS) expect(existsSync(file + suffix)).toBe(false)
  expect(readFileSync(s.physicalPath)).toEqual(journal)
  expect(readFileSync(s.archivePath)).toEqual(archive)
  expect(verify(s, s.plan, s.proof.digest)).toEqual(s.proof)
})

test('rejects an untrusted proof digest and invalid inputs', () => {
  const s = sealed()
  expect(() => s.read({ expectedProofDigest: d('f') })).toThrow('external proof anchor mismatch')
  expect(() => s.read({ expectedProofDigest: 'nothex' })).toThrow('invalid expected proof digest')
  expect(() => s.read({ planId: '../active' })).toThrow('invalid plan id')
  expect(() => s.read({ physicalPath: 'relative/creation-adoptions.sqlite' })).toThrow('invalid path')
  expect(() => s.read({ physicalPath: s.archivePath })).toThrow('invalid physical journal')
})

test('rejects plan ids that are not pending reverification and pending rows without archived source', () => {
  const s = sealed(f => { seedSettled(f); seedUnsettled(f) }, true)
  expect(s.plan.pendingReverification.map(row => row.planId).sort()).toEqual(['active', 'calls'])
  for (const planId of ['closed', 'rejected', 'unknown', 'claimed', 'authorized', 'missing'])
    expect(() => s.read({ planId })).toThrow('plan is not pending reverification')
  expect(() => s.read({ planId: 'calls' })).toThrow('no archived source')
  expect(s.read().planId).toBe('active')
})

test('rejects a pending row whose sealed status is not active', () => {
  const s = sealed()
  const digest = rewriteProof(s.path, plan => { plan.history.rows.find(row => row.planId === 'active')!.status = 'closed' })
  expect(() => s.read({ expectedProofDigest: digest })).toThrow('sealed row is not active')
})

test.each([
  ['mode', (file: string) => chmodSync(file, 0o600), 'archive mismatch'],
  ['digest', (file: string) => { chmodSync(file, 0o600); writeFileSync(file, Buffer.concat([readFileSync(file), Buffer.from([0])])); chmodSync(file, 0o400) }, 'archive mismatch'],
  ['inode', (file: string) => { const bytes = readFileSync(file); rmSync(file); writeFileSync(file, bytes, { mode: 0o400 }) }, 'archive identity mismatch'],
  ['symlink', (file: string) => { renameSync(file, `${file}.moved`); symlinkSync(`${file}.moved`, file) }, 'unsafe file'],
] as const)('rejects archive %s drift', (_kind, change, message) => {
  const s = sealed()
  change(s.archivePath)
  expect(() => s.read()).toThrow(message)
})

test('rejects an archive row whose sha differs from the sealed row and a sealed digest with no archive row', () => {
  const s = sealed(f => { seedSettled(f); seedUnsettled(f) })
  const mismatch = rewriteProof(s.path, plan => { plan.history.rows.find(row => row.planId === 'active')!.sourceArchiveDigest = d('a') })
  expect(() => s.read({ expectedProofDigest: mismatch })).toThrow('archived source digest mismatch')
  const missing = rewriteProof(s.path, plan => { plan.history.rows.find(row => row.planId === 'calls')!.sourceArchiveDigest = d('a') })
  expect(() => s.read({ expectedProofDigest: missing, planId: 'calls' })).toThrow('no archived source')
})

test('verifies the archived source signature and authority under the old authority', () => {
  const flipped = sealed(tamperedSource(item => {
    const signature = item.signature as string
    item.signature = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1)
  }))
  expect(() => flipped.read()).toThrow('archived source signature mismatch')
  const authority = sealed(tamperedSource((item, f) => { item.authorityDigest = d('0'); resign(item, f) }))
  expect(() => authority.read()).toThrow('archived source authority mismatch')
})

test.each(['scripts/run.sh', 'src/package.json', 'docs/README.md'])('rejects an archived file outside candidate authority: %s', path => {
  const s = sealed(f => seedSettled(f, [{ path, content: 'x\n' }]))
  expect(() => s.read()).toThrow('outside candidate authority')
})

test('rejects an archived executable file instead of silently dropping its mode', () => {
  const s = sealed(f => seedSettled(f, [{ path: 'src/run.ts', content: 'export {}\n', mode: '100755' }]))
  expect(() => s.read()).toThrow('archived source file mode')
})

test('rejects a re-signed archive whose file bytes no longer match their recorded hashes', () => {
  const s = sealed(tamperedSource((item, f) => {
    const source = item.source as { files: { content: string }[] }
    source.files[0]!.content = 'export const answer = 43\n'
    resign(item, f)
  }))
  expect(() => s.read()).toThrow('archived source is invalid')
})

test('rejects a byte-identical copy of the live journal on a new inode', () => {
  const s = sealed()
  const copy = s.physicalPath + '.copy'
  copyFileSync(s.physicalPath, copy); chmodSync(copy, statSync(s.physicalPath).mode & 0o777)
  renameSync(copy, s.physicalPath)
  expect(() => s.read()).toThrow('journal file identity mismatch')
})
