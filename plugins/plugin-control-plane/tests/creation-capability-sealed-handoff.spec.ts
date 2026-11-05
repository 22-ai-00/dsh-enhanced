import { generateKeyPairSync, sign } from 'node:crypto'
import fs, { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal } from '../src/creation-capability-journal.js'
import { planSealedAdoptionHandoff, readSealedAdoptionHandoffDigest } from '../src/creation-capability-sealed-handoff.js'
import { planEmptyAdoptionHandoff, applyEmptyAdoptionHandoff } from '../src/creation-capability-empty-handoff.js'
import { roots, d, sha, tools, linuxFixture, seedSettled, seedUnsettled, staged, apply, verify, mutate, counts, cutover,
  sealedLive, type Staged } from './helpers/sealed-handoff-fixture.js'

afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

test('seals settled Docker history into an exact 0400 archive and leaves a same-inode empty live journal', () => {
  const f = staged(), original = readFileSync(f.physicalPath), inode = lstatSync(f.physicalPath).ino
  const plan = planSealedAdoptionHandoff(f.scope)
  expect(Object.isFrozen(plan.history.rows)).toBe(true)
  expect(readFileSync(f.physicalPath)).toEqual(original)
  expect(plan.history.counts).toEqual({ adoptions: 3, calls: 3, sourceArchives: 1 })
  expect(plan.history.byStatus).toEqual({ active: 1, closed: 1, rejected: 1, unknown: 0 })
  expect(plan.history.rows.map(row => [row.planId, row.status, row.reason, row.callCount, row.completedCalls, row.unknownCalls,
    row.sourceArchiveDigest !== null, row.receiptDigest !== null])).toEqual([
    ['active', 'active', null, 2, 2, 0, true, true], ['closed', 'closed', 'owner-closed', 1, 1, 0, false, true],
    ['rejected', 'rejected', 'source-drift', 0, 0, 0, false, false]])
  expect(plan.history.rows.every(row => row.certificate.protocol === 'assistant-growth/creation-verification/v1')).toBe(true)
  expect(plan.pendingReverification.map(row => row.planId)).toEqual(['active'])
  expect(plan.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(existsSync(f.archivePhysicalPath)).toBe(false)

  const proof = apply(plan)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(lstatSync(f.archivePhysicalPath).mode & 0o777).toBe(0o400)
  expect(lstatSync(dirname(f.archivePhysicalPath)).mode & 0o777).toBe(0o700)
  expect(proof.archive).toMatchObject({ logicalPath: f.archiveLogicalPath, bytes: original.length, digest: sha(original), mode: 0o400 })
  expect(lstatSync(f.physicalPath).ino).toBe(inode)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(proof.liveBusiness).toEqual({ adoptions: 0, calls: 0, sourceArchives: 0 })
  expect(proof.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(apply(plan, plan.expiresAt + 1)).toEqual(proof) // read-only acknowledgement
  expect(verify(f, plan, proof.digest)).toEqual(proof)
  expect(() => mutate(f.physicalPath, 'DELETE FROM creation_sealed_adoption_handoff')).toThrow('immutable')
  expect(() => mutate(f.physicalPath, `UPDATE creation_sealed_adoption_handoff SET proof_digest='${d('f')}'`)).toThrow('immutable')

  cutover(f)
  expect(verify(f, plan, proof.digest, f.path, f.archiveLogicalPath)).toEqual(proof)
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })).toThrow()
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.list()).toEqual([])
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
  } finally { journal.close() }
})

test('unsettled adoptions and calls are sealed as unknown, never pending and always counted', () => {
  const f = staged(seedUnsettled), plan = planSealedAdoptionHandoff(f.scope)
  expect(plan.history.counts).toEqual({ adoptions: 4, calls: 2, sourceArchives: 0 })
  expect(plan.history.byStatus).toEqual({ active: 1, closed: 0, rejected: 0, unknown: 3 })
  expect(Object.fromEntries(plan.history.rows.map(row => [row.planId, [row.originalStatus, row.status]]))).toEqual({
    authorized: ['authorized', 'unknown'], calls: ['active', 'active'], claimed: ['claimed', 'unknown'], unknown: ['unknown', 'unknown'] })
  expect(plan.history.rows.find(row => row.planId === 'calls')).toMatchObject({ callCount: 2, completedCalls: 0, unknownCalls: 2 })
  expect(plan.pendingReverification.map(row => row.planId)).toEqual(['calls'])
  expect(plan.inheritedUsage).toEqual({ adoptions: 4, calls: 2 })
  const proof = apply(plan)
  expect(proof.inheritedUsage).toEqual({ adoptions: 4, calls: 2 })
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
})

test('refuses empty history and directs the caller to the empty handoff', () => {
  const f = staged(null)
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('empty adoption handoff')
})

test('refuses an active row whose receipt no longer verifies under the old authority', () => {
  const f = staged(), db = new DatabaseSync(f.physicalPath)
  try {
    const row = db.prepare("SELECT receipt_json FROM adoptions WHERE plan_id='active'").get() as { receipt_json: string }
    const receipt = JSON.parse(row.receipt_json) as Record<string, unknown>
    const { signature: _signature, ...body } = receipt
    receipt.signature = sign(null, Buffer.from(canonicalGrowthJson(body)), generateKeyPairSync('ed25519').privateKey).toString('base64url')
    db.prepare("UPDATE adoptions SET receipt_json=? WHERE plan_id='active'").run(canonicalGrowthJson(receipt))
  } finally { db.close() }
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('receipt')
})

test('refuses an active row carrying a non-Docker certificate protocol', () => {
  const f = staged(), certificate = canonicalGrowthJson(f.certificate('active'))
  const db = new DatabaseSync(f.physicalPath)
  try { db.prepare("UPDATE adoptions SET certificate_json=?,certificate_digest=? WHERE plan_id='active'").run(certificate, sha(certificate)) }
  finally { db.close() }
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('Docker v1')
})

test.each(['adoptions', 'calls'])('refuses %s above the grant limits', table => {
  const f = staged(seedSettled, 3, 3)
  mutate(f.physicalPath, table === 'adoptions'
    ? `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('extra','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`
    : `INSERT INTO calls(plan_id,call_key,arguments_digest,status) VALUES ('closed','extra','${d('a')}','unknown')`)
  expect(() => planSealedAdoptionHandoff(f.scope)).toThrow('limits')
})

test.each(['authority','business','schema','bytes','copy','sidecar','permissions'])('rejects %s drift before archiving or swapping authority', mutation => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  if (mutation === 'authority') mutate(f.physicalPath, `UPDATE authority SET authority_digest='${d('f')}'`)
  if (mutation === 'business') mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`)
  if (mutation === 'schema') mutate(f.physicalPath, 'CREATE TABLE alien (x)')
  if (mutation === 'bytes') mutate(f.physicalPath, 'PRAGMA user_version=3; VACUUM')
  if (mutation === 'copy') { renameSync(f.physicalPath, f.physicalPath + '.before'); copyFileSync(f.physicalPath + '.before', f.physicalPath) }
  if (mutation === 'sidecar') writeFileSync(f.physicalPath + '-wal', '', { mode: 0o600 })
  if (mutation === 'permissions') chmodSync(f.physicalPath, 0o644)
  expect(() => apply(plan)).toThrow()
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  if (mutation === 'sidecar') rmSync(f.physicalPath + '-wal')
  if (mutation === 'permissions') chmodSync(f.physicalPath, 0o600)
  expect(counts(f.physicalPath)[0]).toBe(1)
  expect(() => new CreationCapabilityJournal({ path: f.physicalPath, config: f.config })).toThrow()
})

test('archive paths must be the exact sealed placement for the old authority', () => {
  const f = staged(), other = join(f.root, 'creation-adoptions.sealed', `${d('0')}.sqlite`)
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archiveLogicalPath: other })).toThrow('placement')
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archivePhysicalPath: join(f.root, 'creation-adoptions.sealed', `${f.oldDigest}.sqlite`) })).toThrow('placement')
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archivePhysicalPath: `${f.stage}/creation-adoptions.sealed/../${f.oldDigest}.sqlite` })).toThrow()
  expect(() => planSealedAdoptionHandoff({ ...f.scope, archiveLogicalPath: 'relative.sqlite' })).toThrow()
})

test('a pre-existing different archive is rejected and an identical one is accepted', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  mkdirSync(dirname(f.archivePhysicalPath), { mode: 0o700 })
  writeFileSync(f.archivePhysicalPath, 'other bytes', { mode: 0o400 })
  expect(() => apply(plan)).toThrow('differs')
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
  rmSync(f.archivePhysicalPath)
  copyFileSync(f.physicalPath, f.archivePhysicalPath); chmodSync(f.archivePhysicalPath, 0o400)
  const proof = apply(plan)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a failure between archive write and commit rolls back the live journal and the original plan retries once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), before = readFileSync(f.physicalPath)
  const original = DatabaseSync.prototype.exec, fault = new Error('injected failure after archive write')
  const exec = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: DatabaseSync, sql: string) {
    if (sql.startsWith('DELETE FROM calls')) throw fault
    return original.call(this, sql)
  })
  try { expect(() => apply(plan)).toThrow(fault) } finally { exec.mockRestore() }
  expect(readFileSync(f.archivePhysicalPath)).toEqual(before)
  expect(readFileSync(f.physicalPath)).toEqual(before)
  const proof = apply(plan)
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('verify rejects later business, archive chmod, rewrite or replacement and an untrusted proof digest', () => {
  const run = (change: (f: Staged) => void, message?: string) => {
    const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
    change(f)
    if (message) expect(() => verify(f, plan, proof.digest)).toThrow(message)
    else expect(() => verify(f, plan, proof.digest)).toThrow()
  }
  run(f => mutate(f.physicalPath, `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES ('later','unknown','{}','${d('a')}',X'01','${d('b')}','unknown')`), 'nonempty')
  run(f => chmodSync(f.archivePhysicalPath, 0o600), 'archive')
  run(f => { chmodSync(f.archivePhysicalPath, 0o600); writeFileSync(f.archivePhysicalPath, 'rewritten'); chmodSync(f.archivePhysicalPath, 0o400) }, 'archive')
  run(f => { const bytes = readFileSync(f.archivePhysicalPath); rmSync(f.archivePhysicalPath); writeFileSync(f.archivePhysicalPath, bytes, { mode: 0o400 }) }, 'archive identity')
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope); apply(plan)
  expect(() => verify(f, plan, d('f'))).toThrow('anchor')
})

test('a different transaction rehashed over the original snapshot cannot reuse the stored proof', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const { digest: _digest, ...original } = plan
  const body = { ...original, transactionId: 'another-transaction' }
  const other = { ...body, digest: sha(canonicalGrowthJson(body)) }
  expect(() => apply(other)).toThrow('proof mismatch')
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

// Journal side: inherited usage is enforced at every limit and a damaged audit fails closed.

test('inherited usage blocks claim at the adoption limit', () => {
  const f = sealedLive(seedSettled, 4, 8)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
    expect(journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact }).created).toBe(true)
    expect(journal.usage()).toEqual({ adoptions: 4, calls: 3 })
    expect(() => journal.claim({ certificate: f.certificate('over'), artifact: f.artifact })).toThrow()
    expect(journal.list().map(record => record.planId)).toEqual(['fresh'])
  } finally { journal.close() }
})

test('a sealed plan id is never claimable again under the next authority, even with budget left', () => {
  const f = sealedLive(seedSettled, 8, 8)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    for (const planId of ['active', 'closed', 'rejected']) {
      expect(() => journal.claim({ certificate: f.certificate(planId), artifact: f.artifact })).toThrow()
    }
    expect(journal.usage()).toEqual({ adoptions: 3, calls: 3 })
    expect(journal.claim({ certificate: f.certificate('active-reverified'), artifact: f.artifact }).created).toBe(true)
    expect(journal.list().map(record => record.planId)).toEqual(['active-reverified'])
  } finally { journal.close() }
})

test('inherited usage blocks claimCall at the call-record limit', () => {
  const f = sealedLive(seedSettled, 8, 4)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact }); journal.authorize('fresh', tools); journal.activate('fresh')
    expect(journal.claimCall({ planId: 'fresh', key: 'first', argumentsDigest: d('a') }).created).toBe(true)
    expect(journal.usage()).toEqual({ adoptions: 4, calls: 4 })
    expect(() => journal.claimCall({ planId: 'fresh', key: 'second', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
})

test.each(['drop-trigger', 'tamper-proof', 'tamper-usage', 'extra-object'])('journal fails closed on a %s sealed audit', kind => {
  const f = sealedLive(seedSettled, 8, 8)
  const restore = "CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON creation_sealed_adoption_handoff BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END"
  if (kind === 'drop-trigger') mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_delete')
  if (kind === 'tamper-proof') mutate(f.path, `DROP TRIGGER creation_sealed_handoff_no_update;
    UPDATE creation_sealed_adoption_handoff SET proof_json=CAST(CAST(proof_json AS BLOB)||X'0068696464656e' AS TEXT); ${restore}`)
  if (kind === 'tamper-usage') {
    // Recompute both self-digests so only the plan/history binding catches the refund.
    const db = new DatabaseSync(f.path)
    try {
      const proof = JSON.parse((db.prepare('SELECT proof_json FROM creation_sealed_adoption_handoff').get() as { proof_json: string }).proof_json)
      proof.inheritedUsage = { adoptions: 0, calls: 0 }
      const { digest: _digest, ...body } = proof
      proof.digest = sha(canonicalGrowthJson(body))
      db.exec('DROP TRIGGER creation_sealed_handoff_no_update')
      db.prepare('UPDATE creation_sealed_adoption_handoff SET proof_json=?,proof_digest=?').run(canonicalGrowthJson(proof), proof.digest)
      db.exec(restore)
    } finally { db.close() }
  }
  if (kind === 'extra-object') mutate(f.path, 'CREATE INDEX creation_sealed_extra ON creation_sealed_adoption_handoff(proof_digest)')
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
})

test('journals without a sealed audit count only live rows, including empty-handoff journals', () => {
  const f = linuxFixture(8, 8)
  seedSettled(f)
  const plain = new CreationCapabilityJournal({ path: f.path, config: f.oldConfig })
  try { expect(plain.usage()).toEqual({ adoptions: 3, calls: 3 }) } finally { plain.close() }
  const e = staged(null), plan = planEmptyAdoptionHandoff(e.scope)
  applyEmptyAdoptionHandoff(plan, { now: plan.createdAt, expectedPlanDigest: plan.digest, expectedHostAnchor: plan.hostAnchor })
  renameSync(e.path, e.path + '.old'); renameSync(e.physicalPath, e.path)
  const audited = new CreationCapabilityJournal({ path: e.path, config: e.config })
  try {
    expect(audited.usage()).toEqual({ adoptions: 0, calls: 0 })
    expect(audited.claim({ certificate: e.certificate('fresh'), artifact: e.artifact }).created).toBe(true)
    expect(audited.usage()).toEqual({ adoptions: 1, calls: 0 })
  } finally { audited.close() }
})

// Host cross-check: the journal alone cannot see an audit that was dropped as a whole.
test('readSealedAdoptionHandoffDigest returns the stored proof digest, also with later live business', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const sealed = readFileSync(f.physicalPath)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.physicalPath })).toBe(proof.digest)
  expect(readFileSync(f.physicalPath)).toEqual(sealed)
  // A stopped stage stays sidecar-free, so a later stopped verify still accepts it.
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
  cutover(f)
  const before = readFileSync(f.path)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  expect(readFileSync(f.path)).toEqual(before)
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('fresh'), artifact: f.artifact })
    // Live journal with WAL sidecars: an ordinary read-only connection sees the committed state.
    expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  } finally { journal.close() }
  const after = readFileSync(f.path)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBe(proof.digest)
  expect(readFileSync(f.path)).toEqual(after)
})

test('readSealedAdoptionHandoffDigest returns null for a wholly dropped audit and throws on a partial one', () => {
  const f = sealedLive(seedSettled, 8, 8)
  mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_delete')
  const before = readFileSync(f.path)
  expect(() => readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toThrow('unexpected audit schema')
  expect(readFileSync(f.path)).toEqual(before)
  mutate(f.path, 'DROP TRIGGER creation_sealed_handoff_no_update; DROP TABLE creation_sealed_adoption_handoff')
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toBeNull()
  // The refund the Host must catch: the journal itself now sees no inherited usage.
  const journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try { expect(journal.usage()).toEqual({ adoptions: 0, calls: 0 }) } finally { journal.close() }
  expect(() => readSealedAdoptionHandoffDigest({ physicalPath: 'relative/creation-adoptions.sqlite' })).toThrow('invalid path')
})

test('a stopped stage with a lone -wal, a lone -shm or a hot -journal is refused without creating sidecars', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  const sealed = readFileSync(f.physicalPath), all = ['-wal', '-shm', '-journal']
  for (const present of [['-wal'], ['-shm'], ['-journal'], ['-wal', '-shm', '-journal']]) {
    for (const suffix of present) writeFileSync(f.physicalPath + suffix, '', { mode: 0o600 })
    expect(() => readSealedAdoptionHandoffDigest({ physicalPath: f.physicalPath })).toThrow('journal sidecars are incomplete')
    for (const suffix of all) expect(existsSync(f.physicalPath + suffix)).toBe(present.includes(suffix))
    for (const suffix of present) rmSync(f.physicalPath + suffix)
  }
  expect(readFileSync(f.physicalPath)).toEqual(sealed)
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.physicalPath })).toBe(proof.digest)
})

test('a failure mid archive write never leaves a partial final archive and the plan retries once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  const original = fs.writeSync, fault = new Error('injected crash during archive write')
  ;(fs as { writeSync: unknown }).writeSync = (fd: number, buffer: Buffer, offset: number, length: number) => {
    original(fd, buffer, offset, Math.floor(length / 2)); throw fault
  }
  syncBuiltinESMExports()
  try { expect(() => apply(plan)).toThrow(fault) } finally { fs.writeSync = original; syncBuiltinESMExports() }
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(readdirSync(dirname(f.archivePhysicalPath))).toEqual([])
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
  const proof = apply(plan)
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('leftover archive temp files from a crash are removed and the plan retries exactly once', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  const dir = dirname(f.archivePhysicalPath), temp = (hex: string) => join(dir, `.${f.oldDigest}.sqlite.tmp-${hex.repeat(32)}`)
  mkdirSync(dir, { mode: 0o700 })
  writeFileSync(temp('a'), original.subarray(0, 100), { mode: 0o600 })
  const proof = apply(plan)
  expect(readdirSync(dir)).toEqual([`${f.oldDigest}.sqlite`])
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)

  // Crash between link() and unlink(temp): the temp is a second name of the complete 0400 archive.
  const g = staged(), gPlan = planSealedAdoptionHandoff(g.scope), gDir = dirname(g.archivePhysicalPath)
  mkdirSync(gDir, { mode: 0o700 }); copyFileSync(g.physicalPath, g.archivePhysicalPath); chmodSync(g.archivePhysicalPath, 0o400)
  linkSync(g.archivePhysicalPath, join(gDir, `.${g.oldDigest}.sqlite.tmp-${'b'.repeat(32)}`))
  const gProof = apply(gPlan)
  expect(readdirSync(gDir)).toEqual([`${g.oldDigest}.sqlite`])
  expect(verify(g, gPlan, gProof.digest)).toEqual(gProof)

  // Anything else under the temp prefix is not ours to remove.
  const h = staged(), hPlan = planSealedAdoptionHandoff(h.scope), hDir = dirname(h.archivePhysicalPath)
  mkdirSync(hDir, { mode: 0o700 }); mkdirSync(join(hDir, `.${h.oldDigest}.sqlite.tmp-${'c'.repeat(32)}`))
  expect(() => apply(hPlan)).toThrow('unsafe archive temp')
  expect(counts(h.physicalPath)).toEqual([1, 3, 3, 1])
})

/** Kill a writer inside BEGIN IMMEDIATE after it spilled the business DELETEs into the main file. */
function crashInsideTransaction(file: string) {
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=ON; PRAGMA synchronous=FULL; BEGIN IMMEDIATE; DELETE FROM calls; DELETE FROM source_archives; DELETE FROM adoptions');
    process.kill(process.pid, 'SIGKILL')`
  const result = spawnSync(process.execPath, ['-e', script, file], { encoding: 'utf8' })
  expect(result.signal).toBe('SIGKILL')
}

test('a crash inside the apply transaction leaves a hot rollback journal that the retry rolls back', () => {
  const f = staged()
  // Rollback-journal mode so the in-transaction crash leaves a real hot -journal (WAL leaves -wal/-shm).
  mutate(f.physicalPath, 'PRAGMA journal_mode=DELETE')
  const plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  crashInsideTransaction(f.physicalPath)
  expect(existsSync(f.physicalPath + '-journal')).toBe(true)
  expect(existsSync(f.physicalPath + '-wal')).toBe(false)
  expect(readFileSync(f.physicalPath).equals(original)).toBe(false)
  // Verify stays strict about any sidecar.
  expect(() => verify(f, plan, d('a'))).toThrow('sidecar')
  const proof = apply(plan)
  expect(existsSync(f.physicalPath + '-journal')).toBe(false)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(proof.plan).toEqual(plan)
  expect(proof.inheritedUsage).toEqual({ adoptions: 3, calls: 3 })
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a rollback journal beside WAL sidecars, or one that does not restore the plan snapshot, fails closed', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  writeFileSync(f.physicalPath + '-journal', '', { mode: 0o600 }); writeFileSync(f.physicalPath + '-wal', '', { mode: 0o600 })
  expect(() => apply(plan)).toThrow('sidecar')
  rmSync(f.physicalPath + '-wal'); rmSync(f.physicalPath + '-journal')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])

  const g = staged()
  mutate(g.physicalPath, 'PRAGMA journal_mode=DELETE')
  const gPlan = planSealedAdoptionHandoff(g.scope)
  mutate(g.physicalPath, 'PRAGMA user_version=3; VACUUM') // drift before the crash
  crashInsideTransaction(g.physicalPath)
  expect(() => apply(gPlan)).toThrow('plan snapshot')
  expect(existsSync(g.archivePhysicalPath)).toBe(false)
})

test('a crash inside the apply transaction on a WAL stage leaves -wal/-shm that the retry discards', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), original = readFileSync(f.physicalPath)
  crashInsideTransaction(f.physicalPath)
  expect(existsSync(f.physicalPath + '-wal')).toBe(true)
  expect(existsSync(f.physicalPath + '-journal')).toBe(false)
  expect(() => verify(f, plan, d('a'))).toThrow('sidecar')
  const proof = apply(plan)
  for (const suffix of ['-wal', '-shm', '-journal']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(readFileSync(f.archivePhysicalPath)).toEqual(original)
  expect(counts(f.physicalPath)).toEqual([1, 0, 0, 0])
  expect(apply(plan)).toEqual(proof)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test('a committed but uncheckpointed WAL apply is acknowledged on retry without a second handoff', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope), proof = apply(plan)
  // Re-create the post-commit, pre-checkpoint state: a held WAL connection that never checkpoints.
  const script = `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE; UPDATE authority SET key_id=key_id; COMMIT');
    process.kill(process.pid, 'SIGKILL')`
  const result = spawnSync(process.execPath, ['-e', script, f.physicalPath], { encoding: 'utf8' })
  expect(result.signal).toBe('SIGKILL')
  expect(existsSync(f.physicalPath + '-wal')).toBe(true)
  expect(apply(plan)).toEqual(proof)
  for (const suffix of ['-wal', '-shm']) expect(existsSync(f.physicalPath + suffix)).toBe(false)
  expect(verify(f, plan, proof.digest)).toEqual(proof)
})

test.each([['-wal'], ['-shm']])('a lone %s sidecar still fails closed', suffix => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  writeFileSync(f.physicalPath + suffix, '', { mode: 0o600 })
  expect(() => apply(plan)).toThrow('sidecar')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
  expect(counts(f.physicalPath)).toEqual([1, 3, 3, 1])
})

test('WAL recovery that does not restore the plan snapshot fails closed', () => {
  const f = staged(), plan = planSealedAdoptionHandoff(f.scope)
  mutate(f.physicalPath, "UPDATE adoptions SET reason=reason") // checkpointed drift after planning
  mutate(f.physicalPath, 'PRAGMA user_version=3; VACUUM')
  crashInsideTransaction(f.physicalPath)
  expect(() => apply(plan)).toThrow('plan snapshot')
  expect(existsSync(f.archivePhysicalPath)).toBe(false)
})

test.each(['adoptions', 'calls'])('journal fails closed when inherited %s exceed the grant', field => {
  const f = sealedLive(seedSettled, 8, 8), db = new DatabaseSync(f.path)
  try {
    // Fully re-digested audit: only the grant comparison can reject it.
    const proof = JSON.parse((db.prepare('SELECT proof_json FROM creation_sealed_adoption_handoff').get() as { proof_json: string }).proof_json)
    const value = field === 'adoptions' ? { adoptions: 9, calls: 3 } : { adoptions: 3, calls: 9 }
    proof.plan.inheritedUsage = value; proof.plan.history.counts = { ...proof.plan.history.counts, ...value }
    const { digest: _plan, ...planBody } = proof.plan
    proof.plan.digest = sha(canonicalGrowthJson(planBody))
    proof.inheritedUsage = value
    const { digest: _proof, ...body } = proof
    proof.digest = sha(canonicalGrowthJson(body))
    db.exec('DROP TRIGGER creation_sealed_handoff_no_update')
    db.prepare('UPDATE creation_sealed_adoption_handoff SET proof_json=?,proof_digest=?').run(canonicalGrowthJson(proof), proof.digest)
    db.exec("CREATE TRIGGER creation_sealed_handoff_no_update BEFORE UPDATE ON creation_sealed_adoption_handoff BEGIN SELECT RAISE(ABORT,'immutable sealed adoption handoff'); END")
  } finally { db.close() }
  expect(readSealedAdoptionHandoffDigest({ physicalPath: f.path })).toMatch(/^[a-f0-9]{64}$/u)
  expect(() => new CreationCapabilityJournal({ path: f.path, config: f.config })).toThrow()
})
