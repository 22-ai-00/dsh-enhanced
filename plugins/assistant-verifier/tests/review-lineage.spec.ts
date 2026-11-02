import { lanePublicKey, revisionFixture, regressionFixture } from './lane-fixtures.ts'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, verifyPluginCreationVerificationCertificate, verifyPluginRevisionVerificationCertificate, verifyPluginRevisionRegressionCertificate, validateRevisionAcceptanceAuthorityRef, validateRevisionRegressionAcceptanceAuthorityRef, type PluginCreationVerificationCertificate, type RevisionRegressionAcceptanceAuthorityRef } from '@dsh-enhanced/assistant-growth-contract'
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { lineageHash, type LineageScope, type ReviewPublicIdentity, type TrustedHistoryRequest } from '../src/review-authority-lineage.ts'
import { CreationReviewStore } from '../src/creation-review-store.ts'
const roots: string[] = []
const oldDigest = 'a'.repeat(64), newDigest = 'b'.repeat(64), binding = 'c'.repeat(64)
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-lineage-'))); roots.push(root)
  return join(root, 'reviews.sqlite')
}
const scope = { transactionId: 'upgrade-1', installationId: 'installation', profileId: 'profile',
  lane: 'creation-reviews' as const, configurationDigest: 'd'.repeat(64), authority: 'same-authority', toDigest: newDigest }
  const keys = generateKeyPairSync('ed25519'), now = Date.now()
  const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const body: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'original-docker-review',
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: scope.authority,
      authorityDigest: oldDigest, keyId: 'original-owner-key', namePrefix: 'owner-', expiresAt: now + 120_000 },
    plan: { id: 'certificate', digest: oldDigest, name: 'owner-tool', sourceTreeDigest: binding,
      sourcePatchDigest: binding, artifactSha256: binding, artifactBytes: 42, generatorDigest: binding },
    source: { referenceDigest: binding, ownerDigest: binding, growthRunDigest: binding },
    contractDigest: binding, schemaDigest: binding,
    environment: { node: 'v24.7.0', cordis: '4.0.1', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
    model: { provider: 'original-supplier', model: 'original-task-model' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: ['ordinary', 'challenge'].map(caseId => ({ caseId, jobId: `docker-job-${caseId}`,
      operationDigest: binding, observationDigest: binding })),
    reviewDigest: binding, verifiedAt: now - 1000, expiresAt: now + 60_000,
  }
  const certificate = { ...body, signature: sign(null, Buffer.from(canonicalGrowthJson(body)), keys.privateKey).toString('base64url') }
function fixture(maximum = 5) {
  const file = path(), store = new CreationReviewStore<unknown>(file)
  store.claim('claimed', binding, scope.authority, oldDigest, maximum)
  store.claim('unknown', binding, scope.authority, oldDigest, maximum); store.unknown('unknown', binding, 'uncertain')
  store.claim('rejected', binding, scope.authority, oldDigest, maximum); store.reject('rejected', binding, 'mismatch')
  store.claim('certificate', binding, scope.authority, oldDigest, maximum)
  store.discovered('certificate', binding, { schema: true }); store.contract('certificate', binding, { cases: [] })
  store.claimReview('certificate', binding); store.certificate('certificate', binding, certificate); store.close()
  return file
}
function database<T>(file: string, callback: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try { return callback(db) } finally { db.close() }
}
function history(file: string) { return database(file, db => db.prepare('SELECT * FROM verifications ORDER BY plan').all()) }


function identity(authorityDigest: string): ReviewPublicIdentity {
  return { authority: { ...certificate.authority, authorityDigest }, publicKey,
    keyFingerprint: createHash('sha256').update(createPublicKey(publicKey).export({ format: 'der', type: 'spki' })).digest('hex'),
    owner: { authorityId: 'owner-authority', authorityHash: binding, principalId: 'owner', principalRecordId: 'owner-record',
      principalVersion: 1, workspace: '/owner/workspace', agentPreset: 'owner-preset' }, maximum: 8,
    runner: { logicalStateRoot: '/home/owner/.dsh/state/creation-review-runner', maxRuns: 100, maxTotalDurationMs: 600000, maxDurationMs: 60000, maxOutputBytes: 65536, expiresAt: now + 120000 },
    budget: { policy: 'exact owner approved review', maxInputBytes: 4096, maxOutputTokens: 1024,
      maxDurationMs: 60000, maxCases: 2, receiptTtlMs: 60000 } }
}
function v2scope(lane: LineageScope['lane'] = 'creation-reviews'): LineageScope {
  return { transactionId: 'v2-first', installationId: 'installation', profileId: 'profile', lane,
    logicalDatabaseScope: 'verifier/reviews', oldIdentity: identity(oldDigest), newIdentity: identity(newDigest),
    configurationEvidence: { old: { configurationDigest: binding, sourceDigest: binding, verificationDigest: binding },
      current: { configurationDigest: newDigest, sourceDigest: newDigest, verificationDigest: newDigest } }, previousHeadDigest: null }
}
function request(file: string, proof: unknown, currentIdentity = identity(newDigest), planId = 'certificate'): TrustedHistoryRequest {
  const stat = lstatSync(file)
  return { headDigest: lineageHash(proof), currentIdentity, currentFileIdentity: { dev: stat.dev, ino: stat.ino },
    installationId: 'installation', profileId: 'profile', lane: 'creation-reviews', logicalDatabaseScope: 'verifier/reviews', planId, now }
}
function append(file: string, plan: string, digest: string, certIdentity = identity(digest)): void {
  const store = new CreationReviewStore<unknown>(file)
  try {
    store.claim(plan, binding, scope.authority, digest, 8)
    store.discovered(plan, binding, {}); store.contract(plan, binding, { cases: [] }); store.claimReview(plan, binding)
    const { signature: _, ...unsigned } = { ...certificate, authority: certIdentity.authority, plan: { ...certificate.plan, id: plan } }
    store.certificate(plan, binding, { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), keys.privateKey).toString('base64url') })
  } finally { store.close() }
}
function handoff(file: string, s = v2scope()) {
  const store = CreationReviewStore.openExistingForMaintenance(file)
  try { const plan = store.planGrantHandoffV2(s); return store.applyGrantHandoffV2(plan) } finally { store.close() }
}

test.each(['creation-reviews'] as const)('v2 %s preserves old evidence, quota/history and restart retry', lane => {
  const file = fixture(8), before = history(file), store = CreationReviewStore.openExistingForMaintenance(file)
  const plan = store.planGrantHandoffV2(v2scope(lane)), proof = store.applyGrantHandoffV2(plan)
  expect(plan.seals.map(s => s.planId)).toEqual(['certificate']); expect(history(file)).toEqual(before)
  expect(proof.after).toMatchObject({ used: 4, maximum: 8 }); store.close()
  const retry = CreationReviewStore.openExistingForMaintenance(file)
  try { expect(retry.applyGrantHandoffV2(plan)).toEqual(proof) } finally { retry.close() }
  const result = CreationReviewStore.resolveHistoricalCertificate(file, { ...request(file, proof), lane })
  expect(result.identity).toEqual(identity(oldDigest)); expect(result.certificate).toEqual(certificate)
  expect(verifyPluginCreationVerificationCertificate(result.certificate, result.identity.authority as typeof certificate.authority, result.identity.publicKey, certificate.verifiedAt)).toBe(true)
  expect(history(file)).toEqual(before)
})
test('legal append and existing-connection live WAL read preserve seals without business writes', () => {
  const file = fixture(8), proof = handoff(file), live = new CreationReviewStore(file)
  try {
    live.claim('live-new', binding, scope.authority, newDigest, 8)
    const before = history(file), audit = database(file, db => db.prepare('SELECT * FROM creation_review_grant_handoffs').all())
    expect(live.resolveHistoricalCertificate(request(file, proof)).certificate).toEqual(certificate)
    expect(history(file)).toEqual(before)
    expect(database(file, db => db.prepare('SELECT * FROM creation_review_grant_handoffs').all())).toEqual(audit)
    expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow('checkpoint')
  } finally { live.close() }
})
test('A→B→C authorized stage copy and rename preserve origins without laundering late A', () => {
  const original = fixture(8), first = handoff(original)
  append(original, 'B-certificate', newDigest); append(original, 'late-A', newDigest, identity(oldDigest))
  const staged = path(); copyFileSync(original, staged)
  const C = identity('e'.repeat(64)), second = handoff(staged, { ...v2scope(), transactionId: 'v2-second', oldIdentity: identity(newDigest), newIdentity: C, previousHeadDigest: lineageHash(first) })
  expect(second.plan.seals.map(s => s.planId)).toEqual(['B-certificate'])
  expect(CreationReviewStore.resolveHistoricalCertificate(staged, request(staged, second, C)).identity).toEqual(identity(oldDigest))
  expect(CreationReviewStore.resolveHistoricalCertificate(staged, request(staged, second, C, 'B-certificate')).identity).toEqual(identity(newDigest))
  expect(() => CreationReviewStore.resolveHistoricalCertificate(staged, request(staged, second, C, 'late-A'))).toThrow('unsealed')
  const renamed = staged + '.cutover'; renameSync(staged, renamed)
  const contents = readFileSync(renamed)
  expect(CreationReviewStore.resolveHistoricalCertificate(renamed, request(renamed, second, C)).identity).toEqual(identity(oldDigest))
  expect(readFileSync(renamed)).toEqual(contents)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(renamed, request(renamed, first))).toThrow('head file')
  const unauthorized = path(); copyFileSync(renamed, unauthorized)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(unauthorized, request(unauthorized, second, C))).toThrow('head file')
  const D = identity('f'.repeat(64))
  const third = handoff(renamed, { ...v2scope(), transactionId: 'v2-third', oldIdentity: C, newIdentity: D, previousHeadDigest: lineageHash(second) })
  expect(third.plan.seals).toEqual([])
  expect(CreationReviewStore.resolveHistoricalCertificate(renamed, request(renamed, third, D)).identity).toEqual(identity(oldDigest))
  expect(CreationReviewStore.resolveHistoricalCertificate(renamed, request(renamed, third, D, 'B-certificate')).identity).toEqual(identity(newDigest))
  const store = CreationReviewStore.openExistingForMaintenance(renamed)
  try { expect(() => store.applyGrantHandoffV2(second.plan)).toThrow('file changed') } finally { store.close() }
})
test.each(['owner', 'key', 'expiry', 'prefix', 'maximum', 'policy', 'budget', 'runner-budget', 'runner-expiry', 'private', 'unknown-field'])('rejects identity expansion/invalid %s', field => {
  const file = fixture(8), s = v2scope()
  if (field === 'owner') s.newIdentity.owner.principalVersion++
  if (field === 'key') s.newIdentity.publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'pem', type: 'spki' }).toString()
  if (field === 'expiry') s.newIdentity.authority.expiresAt++
  if (field === 'prefix') s.newIdentity.authority.namePrefix = 'other-'
  if (field === 'maximum') s.newIdentity.maximum++
  if (field === 'policy' && 'policy' in s.newIdentity.budget) s.newIdentity.budget.policy = 'allow everything'
  if (field === 'budget' && 'maxOutputTokens' in s.newIdentity.budget) s.newIdentity.budget.maxOutputTokens++
  if (field === 'runner-budget') s.newIdentity.runner.maxRuns++
  if (field === 'runner-expiry') s.newIdentity.runner.expiresAt++
  if (field === 'private') s.newIdentity.publicKey = keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  if (field === 'unknown-field') Object.assign(s.newIdentity, { privateKey: keys.privateKey })
  const store = CreationReviewStore.openExistingForMaintenance(file), before = history(file)
  try { expect(() => store.planGrantHandoffV2(s)).toThrow(); expect(history(file)).toEqual(before) } finally { store.close() }
})
test.each(['head', 'grant', 'owner', 'scope', 'file', 'expired', 'row', 'unknown-fill', 'late-cert'])('resolution rejects %s drift', field => {
  const file = fixture(8), proof = handoff(file), req = request(file, proof)
  if (field === 'head') req.headDigest = binding
  if (field === 'owner') req.currentIdentity.owner.principalVersion++
  if (field === 'scope') req.profileId = 'other-profile'
  if (field === 'file') req.currentFileIdentity.ino++
  if (field === 'expired') req.now = req.currentIdentity.authority.expiresAt
  if (field === 'grant') database(file, db => db.prepare('UPDATE grants SET digest=?').run(binding))
  if (field === 'row') database(file, db => {
    const data = JSON.parse(String(db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data)); data.cases = { altered: true }
    db.prepare("UPDATE verifications SET data=? WHERE plan='certificate'").run(canonicalGrowthJson(data))
  })
  if (field === 'unknown-fill') {
    const data = database(file, db => db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data)
    database(file, db => db.prepare("UPDATE verifications SET state='certificate',data=? WHERE plan='unknown'").run(data!)); req.planId = 'unknown'
  }
  if (field === 'late-cert') { append(file, 'late', newDigest, identity(oldDigest)); req.planId = 'late' }
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, req)).toThrow()
})
test('v1 opaque audit never seeds v2 historical trust', () => {
  const file = fixture(8), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    const proof = store.applyGrantHandoff(store.planGrantHandoff(scope))
    expect(() => store.planGrantHandoffV2({ ...v2scope(), oldIdentity: identity(newDigest), newIdentity: identity('e'.repeat(64)) })).toThrow('v1')
    expect(() => store.resolveHistoricalCertificate(request(file, proof))).toThrow('v1')
  } finally { store.close() }
})
test('plan/apply reject added history and ABA without partial grant/audit commit', () => {
  const file = fixture(8), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoffV2(v2scope())
  append(file, 'new-history', oldDigest)
  expect(() => store.applyGrantHandoffV2(plan)).toThrow('snapshot'); expect(store.remaining(scope.authority, oldDigest, 8)).toBe(3)
  expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined(); store.close()
  const first = handoff(file)
  expect(() => handoff(file, { ...v2scope(), transactionId: 'ABA', oldIdentity: identity(newDigest), newIdentity: identity(oldDigest), previousHeadDigest: lineageHash(first) })).toThrow('ABA')
})

test.each(['revision-reviews', 'revision-regressions'] as const)('real %s protocol and signing domain survive exact lineage', lane => {
  const signed = lane === 'revision-reviews' ? revisionFixture() : regressionFixture()
  if (signed.authority.protocol === 'assistant-growth/revision-acceptance-authority/v1') validateRevisionAcceptanceAuthorityRef(signed.authority)
  else validateRevisionRegressionAcceptanceAuthorityRef(signed.authority)
  const file = path(), writer = new CreationReviewStore<unknown>(file)
  writer.claim(signed.plan.id, binding, signed.authority.authorityId, oldDigest, 8)
  writer.discovered(signed.plan.id, binding, {}); writer.contract(signed.plan.id, binding, { cases: [] }); writer.claimReview(signed.plan.id, binding)
  writer.certificate(signed.plan.id, binding, signed)
  writer.claim('unknown', binding, signed.authority.authorityId, oldDigest, 8); writer.unknown('unknown', binding, 'uncertain'); writer.close()
  const old = { ...identity(oldDigest), authority: signed.authority, publicKey: lanePublicKey,
    keyFingerprint: createHash('sha256').update(createPublicKey(lanePublicKey).export({ format: 'der', type: 'spki' })).digest('hex') }
  old.runner.expiresAt = signed.authority.expiresAt
  if (lane === 'revision-regressions') old.budget = { maxDurationMs: 60000, maxCases: 2, receiptTtlMs: 60000 }
  const current = { ...structuredClone(old), authority: { ...old.authority, authorityDigest: newDigest } }
  const s = { ...v2scope(lane), oldIdentity: old, newIdentity: current }
  const proof = handoff(file, s)
  const resolved = CreationReviewStore.resolveHistoricalCertificate<unknown>(file, { ...request(file, proof, current, signed.plan.id), lane })
  expect(resolved.certificate).toEqual(signed); expect(resolved.identity).toEqual(old)
  if (signed.protocol === 'assistant-growth/revision-verification/v1') expect(verifyPluginRevisionVerificationCertificate(resolved.certificate, old.authority as typeof signed.authority, old.publicKey, signed.verifiedAt)).toBe(true)
  else expect(verifyPluginRevisionRegressionCertificate(resolved.certificate, old.authority as RevisionRegressionAcceptanceAuthorityRef, old.publicKey, signed.verifiedAt)).toBe(true)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, { ...request(file, proof, current, signed.plan.id), lane: 'creation-reviews' })).toThrow('lane mismatch')
  const nextCertificate = lane === 'revision-reviews' ? revisionFixture(newDigest, 'B-certificate') : regressionFixture(newDigest, 'B-certificate')
  const newWriter = new CreationReviewStore<unknown>(file)
  newWriter.claim('B-certificate', binding, old.authority.authorityId, newDigest, 8)
  newWriter.discovered('B-certificate', binding, {}); newWriter.contract('B-certificate', binding, { cases: [] }); newWriter.claimReview('B-certificate', binding)
  newWriter.certificate('B-certificate', binding, nextCertificate); newWriter.close()
  const staged = path(); copyFileSync(file, staged)
  const C = { ...structuredClone(current), authority: { ...current.authority, authorityDigest: 'e'.repeat(64) } }
  const second = handoff(staged, { ...s, transactionId: 'lane-second', oldIdentity: current, newIdentity: C, previousHeadDigest: lineageHash(proof) })
  const D = { ...structuredClone(current), authority: { ...current.authority, authorityDigest: 'f'.repeat(64) } }
  const third = handoff(staged, { ...s, transactionId: 'lane-third', oldIdentity: C, newIdentity: D, previousHeadDigest: lineageHash(second) })
  expect(CreationReviewStore.resolveHistoricalCertificate(staged, { ...request(staged, third, D, signed.plan.id), lane }).identity).toEqual(old)
  expect(CreationReviewStore.resolveHistoricalCertificate(staged, { ...request(staged, third, D, 'B-certificate'), lane }).identity).toEqual(current)

})

test('1000 terminal seals are bounded without truncation and exhausted grant remains exhausted', () => {
  const file = fixture(8)
  database(file, db => {
    const data = JSON.parse(String(db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data))
    db.exec('DELETE FROM verifications; UPDATE grants SET maximum=1000,used=1000; BEGIN')
    const insert = db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?)')
    for (let i = 0; i < 1000; i++) {
      const id = `certificate-${String(i).padStart(4, '0')}`
      const { signature: _, ...unsigned } = { ...certificate, plan: { ...certificate.plan, id } }
      const signed = { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), keys.privateKey).toString('base64url') }
      insert.run(id, binding, scope.authority, 'certificate', canonicalGrowthJson({ ...data, certificate: signed }))
    }
    db.exec('COMMIT')
  })
  const s = v2scope(); s.oldIdentity.maximum = 1000; s.newIdentity.maximum = 1000
  s.oldIdentity.runner.maxRuns = 10000; s.newIdentity.runner.maxRuns = 10000
  const proof = handoff(file, s)
  expect(proof.plan.seals).toHaveLength(1000)
  expect(proof.plan.members).toHaveLength(1000)
  expect(() => canonicalGrowthJson(proof)).not.toThrow()
  expect(Buffer.byteLength(canonicalGrowthJson(proof.plan.seals))).toBeLessThanOrEqual(262144)
  const store = new CreationReviewStore(file)
  try {
    expect(store.remaining(scope.authority, newDigest, 1000)).toBe(0)
    expect(() => store.claim('over-budget', binding, scope.authority, newDigest, 1000)).toThrow('exhausted')
  } finally { store.close() }
  const invalid = v2scope(); invalid.oldIdentity.maximum = 1001; invalid.newIdentity.maximum = 1001
  const maintenance = CreationReviewStore.openExistingForMaintenance(file)
  try { expect(() => maintenance.planGrantHandoffV2(invalid)).toThrow('limit') } finally { maintenance.close() }
})
test('audit write failure rolls back grant CAS and audit schema, then restart applies once', () => {
  const file = fixture(8), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoffV2(v2scope())
  const original = DatabaseSync.prototype.prepare
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
    if (sql.startsWith('INSERT INTO creation_review_grant_handoffs')) throw new Error('injected audit write failure')
    return original.call(this, sql)
  })
  try { expect(() => store.applyGrantHandoffV2(plan)).toThrow('audit write failure') } finally { spy.mockRestore(); store.close() }
  expect(database(file, db => db.prepare('SELECT digest FROM grants').get()!.digest)).toBe(oldDigest)
  expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined()
  const restarted = CreationReviewStore.openExistingForMaintenance(file)
  try { expect(restarted.applyGrantHandoffV2(plan).after.digest).toBe(newDigest) } finally { restarted.close() }
})
test('retry after fresh history refuses and broken predecessor cannot be a trusted head', () => {
  const file = fixture(8), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoffV2(v2scope()), first = store.applyGrantHandoffV2(plan)
  append(file, 'fresh-B', newDigest)
  expect(() => store.applyGrantHandoffV2(plan)).toThrow('retry drift'); store.close()
  expect(() => handoff(file, { ...v2scope(), transactionId: 'broken', oldIdentity: identity(newDigest), newIdentity: identity('e'.repeat(64)), previousHeadDigest: binding })).toThrow('broken chain')
  const second = handoff(file, { ...v2scope(), transactionId: 'second', oldIdentity: identity(newDigest), newIdentity: identity('e'.repeat(64)), previousHeadDigest: lineageHash(first) })
  database(file, db => { db.exec('DROP TRIGGER creation_review_handoff_no_delete'); db.prepare('DELETE FROM creation_review_grant_handoffs WHERE transaction_id=?').run('v2-first'); db.exec("CREATE TRIGGER creation_review_handoff_no_delete BEFORE DELETE ON creation_review_grant_handoffs BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END") })
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, second, identity('e'.repeat(64))))).toThrow('broken chain')
})

test('next handoff refuses drift in inherited A row rather than resealing or losing it', () => {
  const file = fixture(8), first = handoff(file)
  database(file, db => {
    const data = JSON.parse(String(db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data)); data.cases = { altered: true }
    db.prepare("UPDATE verifications SET data=? WHERE plan='certificate'").run(canonicalGrowthJson(data))
  })
  expect(() => handoff(file, { ...v2scope(), transactionId: 'next', oldIdentity: identity(newDigest), newIdentity: identity('e'.repeat(64)), previousHeadDigest: lineageHash(first) })).toThrow('inherited seal')
})

test.each(['plan', 'binding', 'authority', 'state', 'data'] as const)('NUL before plan is rejected from raw verifications.%s bytes', column => {
  const file = fixture(8)
  database(file, db => db.exec(`UPDATE verifications SET ${column}=${column}||char(0)||'hidden' WHERE plan='certificate'`))
  expect(() => {
    const store = CreationReviewStore.openExistingForMaintenance(file)
    try { store.planGrantHandoffV2(v2scope()) } finally { store.close() }
  }).toThrow()
})
test.each(['plan', 'binding', 'authority', 'state', 'data'] as const)('NUL plan-to-apply %s drift cannot evade exact snapshot', column => {
  const file = fixture(8), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoffV2(v2scope())
  database(file, db => db.exec(`UPDATE verifications SET ${column}=${column}||char(0)||'hidden' WHERE plan='certificate'`))
  try { expect(() => store.applyGrantHandoffV2(plan)).toThrow() } finally { store.close() }
})
test.each(['plan', 'binding', 'authority', 'state', 'data'] as const)('NUL after head %s drift cannot resolve a sealed row', column => {
  const file = fixture(8), proof = handoff(file)
  database(file, db => db.exec(`UPDATE verifications SET ${column}=${column}||char(0)||'hidden' WHERE plan='certificate'`))
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow()
})
test('NUL audit proof suffix cannot be hidden from historical reads', () => {
  const file = fixture(8), proof = handoff(file)
  database(file, db => {
    db.exec('DROP TRIGGER creation_review_handoff_no_update')
    db.exec("UPDATE creation_review_grant_handoffs SET proof=proof||char(0)||'hidden'")
    db.exec("CREATE TRIGGER creation_review_handoff_no_update BEFORE UPDATE ON creation_review_grant_handoffs BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END")
  })
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow()
})
function replaceWithSigned(file: string, plan: string, signedIdentity: ReviewPublicIdentity): void {
  const { signature: _, ...unsigned } = { ...certificate, authority: signedIdentity.authority, plan: { ...certificate.plan, id: plan } }
  const signed = { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), keys.privateKey).toString('base64url') }
  expect(verifyPluginCreationVerificationCertificate(signed, signedIdentity.authority as typeof certificate.authority, publicKey, signed.verifiedAt)).toBe(true)
  database(file, db => db.prepare("UPDATE verifications SET state='certificate',data=? WHERE plan=?")
    .run(canonicalGrowthJson({ discovery: {}, contract: { cases: [] }, cases: {}, certificate: signed }), plan))
}
test.each(['claimed', 'unknown', 'rejected'])('old members: %s cannot gain historical eligibility using a valid B signature', planId => {
  const file = fixture(8), first = handoff(file)
  replaceWithSigned(file, planId, identity(newDigest))
  const C = identity('e'.repeat(64)), second = handoff(file, { ...v2scope(), transactionId: 'member-next', oldIdentity: identity(newDigest), newIdentity: C, previousHeadDigest: lineageHash(first) })
  expect(second.plan.seals.some(s => s.planId === planId)).toBe(false)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, second, C, planId))).toThrow()
})
test('old members: previously unsealed late A cannot be laundered with a valid C signature', () => {
  const file = fixture(8), first = handoff(file)
  append(file, 'late-A-member', newDigest, identity(oldDigest))
  const C = identity('e'.repeat(64)), second = handoff(file, { ...v2scope(), transactionId: 'member-second', oldIdentity: identity(newDigest), newIdentity: C, previousHeadDigest: lineageHash(first) })
  replaceWithSigned(file, 'late-A-member', C)
  const D = identity('f'.repeat(64)), third = handoff(file, { ...v2scope(), transactionId: 'member-third', oldIdentity: C, newIdentity: D, previousHeadDigest: lineageHash(second) })
  expect(third.plan.seals.some(s => s.planId === 'late-A-member')).toBe(false)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, third, D, 'late-A-member'))).toThrow()
})

test.each(['authority', 'digest'] as const)('raw grants.%s NUL is rejected before plan and after head', column => {
  for (const after of [false, true]) {
    const file = fixture(8), proof = after ? handoff(file) : undefined
    database(file, db => db.exec(`UPDATE grants SET ${column}=${column}||char(0)||'hidden'`))
    if (proof) expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow()
    else expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow()
  }
})
test('audit transaction ID NUL, invalid UTF-8 data and escaped JSON NUL are distinguished', () => {
  const invalid = fixture(8)
  database(invalid, db => db.exec("UPDATE verifications SET data=CAST(X'7BFF7D' AS TEXT) WHERE plan='certificate'"))
  expect(() => CreationReviewStore.openExistingForMaintenance(invalid)).toThrow('UTF-8')
  const escaped = fixture(8)
  database(escaped, db => {
    const data = JSON.parse(String(db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data)); data.cases = { text: 'allowed\0json' }
    db.prepare("UPDATE verifications SET data=? WHERE plan='certificate'").run(canonicalGrowthJson(data))
  })
  const escapedProof = handoff(escaped)
  expect(CreationReviewStore.resolveHistoricalCertificate(escaped, request(escaped, escapedProof)).certificate).toEqual(certificate)
  const file = fixture(8), proof = handoff(file)
  database(file, db => {
    db.exec('DROP TRIGGER creation_review_handoff_no_update')
    db.exec("UPDATE creation_review_grant_handoffs SET transaction_id=transaction_id||char(0)||'hidden'")
    db.exec("CREATE TRIGGER creation_review_handoff_no_update BEFORE UPDATE ON creation_review_grant_handoffs BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END")
  })
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow()
})
test('nonterminal recovery may record unknown while old membership stays consumed and ineligible', () => {
  const file = fixture(8), first = handoff(file), writer = new CreationReviewStore(file)
  writer.unknown('claimed', binding, 'restart uncertainty'); writer.close()
  const C = identity('e'.repeat(64)), second = handoff(file, { ...v2scope(), transactionId: 'recovery-next', oldIdentity: identity(newDigest), newIdentity: C, previousHeadDigest: lineageHash(first) })
  expect(second.plan.members).toEqual(first.plan.members)
  expect(second.after.used).toBe(first.after.used)
  expect(second.plan.seals).toEqual([])
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, second, C, 'claimed'))).toThrow()
})
test('64 distinct v2 links resolve original history; 65th rejects without changing grant/audit', () => {
  const file = fixture(8)
  let old = identity(oldDigest), previous: string | null = null, proof: ReturnType<typeof handoff> | undefined
  for (let i = 1; i <= 64; i++) {
    const current = identity(createHash('sha256').update(`lineage-authority-${i}`).digest('hex'))
    proof = handoff(file, { ...v2scope(), transactionId: `chain-${i}`, oldIdentity: old, newIdentity: current, previousHeadDigest: previous })
    previous = lineageHash(proof); old = current
  }
  expect(CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof!, old)).identity).toEqual(identity(oldDigest))
  const before = readFileSync(file)
  expect(() => handoff(file, { ...v2scope(), transactionId: 'chain-65', oldIdentity: old, newIdentity: identity(binding), previousHeadDigest: previous })).toThrow()
  expect(readFileSync(file)).toEqual(before)
  expect(database(file, db => db.prepare('SELECT COUNT(*) AS n FROM creation_review_grant_handoffs').get()!.n)).toBe(64)
})

test('aggregate seal bytes over cap reject without truncation or grant mutation', () => {
  const file = fixture(8)
  database(file, db => {
    const data = JSON.parse(String(db.prepare("SELECT data FROM verifications WHERE plan='certificate'").get()!.data))
    db.exec('DELETE FROM verifications; UPDATE grants SET maximum=1000,used=1000; BEGIN')
    const insert = db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?)')
    for (let i = 0; i < 1000; i++) {
      const id = `certificate-${String(i).padStart(4, '0')}-${'x'.repeat(183)}`
      const { signature: _, ...unsigned } = { ...certificate, plan: { ...certificate.plan, id } }
      const signed = { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), keys.privateKey).toString('base64url') }
      insert.run(id, binding, scope.authority, 'certificate', canonicalGrowthJson({ ...data, certificate: signed }))
    }
    db.exec('COMMIT')
  })
  const s = v2scope(); s.oldIdentity.maximum = 1000; s.newIdentity.maximum = 1000
  s.oldIdentity.runner.maxRuns = 10000; s.newIdentity.runner.maxRuns = 10000
  const store = CreationReviewStore.openExistingForMaintenance(file)
  try { expect(() => store.planGrantHandoffV2(s)).toThrow('seal bytes bound'); expect(store.remaining(scope.authority, oldDigest, 1000)).toBe(0) } finally { store.close() }
  expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined()
})
test('deleting an old nonterminal member and reducing used cannot reset the next handoff budget', () => {
  const file = fixture(8), first = handoff(file)
  database(file, db => db.exec("DELETE FROM verifications WHERE plan='unknown'; UPDATE grants SET used=used-1"))
  expect(() => handoff(file, { ...v2scope(), transactionId: 'removed-member', oldIdentity: identity(newDigest), newIdentity: identity('e'.repeat(64)), previousHeadDigest: lineageHash(first) })).toThrow('membership removed')
})

test('raw audit proof whitespace drift is refused even when canonical proof hash stays unchanged', () => {
  const file = fixture(8), proof = handoff(file)
  database(file, db => {
    db.exec('DROP TRIGGER creation_review_handoff_no_update')
    db.exec("UPDATE creation_review_grant_handoffs SET proof=' '||proof")
    db.exec("CREATE TRIGGER creation_review_handoff_no_update BEFORE UPDATE ON creation_review_grant_handoffs BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END")
  })
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow('noncanonical audit proof')
})
test('resolve rejects removed old member even if legal append keeps count and used above head usage', () => {
  const file = fixture(8), proof = handoff(file)
  append(file, 'legal-new-B', newDigest)
  database(file, db => db.exec("DELETE FROM verifications WHERE plan='unknown'; UPDATE grants SET used=used-1"))
  expect(database(file, db => db.prepare('SELECT used FROM grants').get()!.used)).toBe(proof.after.used)
  expect(() => CreationReviewStore.resolveHistoricalCertificate(file, request(file, proof))).toThrow('membership removed')
})
