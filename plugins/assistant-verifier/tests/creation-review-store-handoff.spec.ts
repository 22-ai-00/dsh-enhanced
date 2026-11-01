import { generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalGrowthJson, growthObjectDigest as digest, verifyPluginCreationVerificationCertificate, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationReviewStore } from '../src/creation-review-store.ts'
const roots: string[] = []
const oldDigest = 'a'.repeat(64), newDigest = 'b'.repeat(64), binding = 'c'.repeat(64)
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function path(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-handoff-'))); roots.push(root)
  return join(root, 'reviews.sqlite')
}
test('reproduces same-authority runner digest change rejection without maintenance', () => {
  const file = path(), store = new CreationReviewStore(file)
  try {
    store.claim('old-plan', binding, 'same-authority', oldDigest, 4)
    expect(() => store.remaining('same-authority', newDigest, 4)).toThrow('grant changed')
    expect(() => store.claim('new-plan', binding, 'same-authority', newDigest, 4)).toThrow('grant changed')
    console.log('same-authority runner digest change: remaining/claim FAIL CLOSED (grant changed or corrupt)')
  } finally { store.close() }
})

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

test.each(['creation-reviews', 'revision-reviews', 'revision-regressions'] as const)('CAS %s preserves evidence, exhausted quota, unknown and restart idempotency', lane => {
  const file = fixture(4), before = history(file)
  let store = CreationReviewStore.openExistingForMaintenance(file)
  const plan = store.planGrantHandoff({ ...scope, lane }), proof = store.applyGrantHandoff(plan)
  expect(proof.after).toMatchObject({ maximum: 4, used: 4, historyCount: 4, digest: newDigest, historyDigest: plan.before.historyDigest })
  expect(history(file)).toEqual(before)
  store.close(); store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    expect(store.applyGrantHandoff(JSON.parse(JSON.stringify(plan)))).toEqual(proof)
    expect(store.remaining(scope.authority, newDigest, 4)).toBe(0)
    expect(() => store.claim('new', binding, scope.authority, newDigest, 4)).toThrow('quota exhausted')
    expect(store.claim('claimed', binding, scope.authority, newDigest, 4)).toEqual({ state: 'unknown' })
    expect(store.claim('unknown', binding, scope.authority, newDigest, 4)).toEqual({ state: 'unknown', reason: 'uncertain' })
    expect(store.claim('rejected', binding, scope.authority, newDigest, 4)).toEqual({ state: 'rejected', reason: 'mismatch' })
    expect(store.readRetained('certificate')?.certificate).toEqual(certificate)
    expect(verifyPluginCreationVerificationCertificate(certificate, certificate.authority, publicKey)).toBe(true)
    expect(verifyPluginCreationVerificationCertificate(certificate, { ...certificate.authority, authorityDigest: newDigest }, publicKey)).toBe(false)
    expect(() => store.remaining(scope.authority, oldDigest, 4)).toThrow('grant changed')
    expect(database(file, db => db.prepare('SELECT COUNT(*) AS n FROM creation_review_grant_handoffs').get()?.n)).toBe(1)
    expect(() => database(file, db => db.exec('DELETE FROM creation_review_grant_handoffs'))).toThrow('immutable')
  } finally { store.close() }
})
test('ordinary instance cannot plan/apply maintenance or accept a new digest', () => {
  const file = fixture(), maintenance = CreationReviewStore.openExistingForMaintenance(file)
  const plan = maintenance.planGrantHandoff(scope); maintenance.close()
  const store = new CreationReviewStore(file)
  try {
    expect(() => store.planGrantHandoff(scope)).toThrow('existing-only maintenance')
    expect(() => store.applyGrantHandoff(plan)).toThrow('existing-only maintenance')
    expect(() => store.claim('new', binding, scope.authority, newDigest, 5)).toThrow('grant changed')
  } finally { store.close() }
})
test.each(['binding', 'state', 'data', 'used', 'maximum', 'digest', 'new-history', 'other-grant'])(
  'frozen plan refuses %s drift', field => {
    const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file)
    try {
      const plan = store.planGrantHandoff(scope)
      database(file, db => {
        if (field === 'binding') db.prepare("UPDATE verifications SET binding=? WHERE plan='claimed'").run('e'.repeat(64))
        if (field === 'state') db.exec("UPDATE verifications SET state='contract-claimed' WHERE plan='claimed'")
        if (field === 'data') db.exec(`UPDATE verifications SET data='{"reason":"changed"}' WHERE plan='unknown'`)
        if (field === 'used') db.exec('UPDATE grants SET used=3')
        if (field === 'maximum') db.exec('UPDATE grants SET maximum=6')
        if (field === 'digest') db.prepare('UPDATE grants SET digest=?').run('e'.repeat(64))
        if (field === 'new-history') {
          db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?)').run('extra', binding, scope.authority, 'discover-claimed', '{}'); db.exec('UPDATE grants SET used=5')
        }
        if (field === 'other-grant') {
          db.prepare('INSERT INTO grants VALUES(?,?,?,?)').run('other', oldDigest, 1, 1)
          db.prepare('INSERT INTO verifications VALUES(?,?,?,?,?)').run('other-plan', binding, 'other', 'discover-claimed', '{}')
        }
      })
      const before = history(file)
      expect(() => store.applyGrantHandoff(plan)).toThrow(); expect(history(file)).toEqual(before)
      expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined()
    } finally { store.close() }
  },
)
test('retry binds all transaction fields and refuses subsequent history growth', () => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    const plan = store.planGrantHandoff(scope); store.applyGrantHandoff(plan)
    for (const change of [{ lane: 'revision-reviews' }, { profileId: 'another' }, { installationId: 'another' },
      { configurationDigest: 'e'.repeat(64) }, { toDigest: 'f'.repeat(64) }]) {
      const { planDigest: _, ...body } = { ...plan, ...change }
      expect(() => store.applyGrantHandoff({ ...body, planDigest: digest(body) } as typeof plan)).toThrow('retry conflict')
    }
    store.claim('new-plan', binding, scope.authority, newDigest, 5)
    expect(() => store.applyGrantHandoff(plan)).toThrow('retry conflict or drift')
  } finally { store.close() }
})
test.each(['DELETE FROM grants', 'UPDATE grants SET used=0', "UPDATE grants SET maximum='bad'",
  "UPDATE verifications SET state='bogus'", "UPDATE verifications SET data='not-json'",
  'CREATE TABLE surprise(x TEXT)', 'ALTER TABLE grants ADD COLUMN surprise TEXT',
  "CREATE TRIGGER surprise AFTER UPDATE ON grants BEGIN DELETE FROM verifications; END"])(
  'refuses malformed existing ledger: %s', sql => {
    const file = fixture(); database(file, db => db.exec(sql))
    let store: CreationReviewStore | undefined
    try { expect(() => { store = CreationReviewStore.openExistingForMaintenance(file); store.planGrantHandoff(scope) }).toThrow() }
    finally { store?.close() }
  },
)
test('maintenance does not create missing database, directory, grant or schema', () => {
  const file = path()
  expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow(); expect(existsSync(file)).toBe(false)
  expect(() => CreationReviewStore.openExistingForMaintenance(join(file, 'missing'))).toThrow(); expect(existsSync(file)).toBe(false)
  writeFileSync(file, '', { mode: 0o600 })
  expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow(); expect(readFileSync(file)).toHaveLength(0)
  rmSync(file); const normal = new CreationReviewStore(file); normal.close()
  const store = CreationReviewStore.openExistingForMaintenance(file)
  try { expect(() => store.planGrantHandoff(scope)).toThrow('existing grant missing') } finally { store.close() }
})
test('file identity rejects replacement, symlink, hardlink and nonprivate modes', () => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoff(scope)
  const replacement = file + '.replacement'; copyFileSync(file, replacement); renameSync(replacement, file)
  try { expect(() => store.applyGrantHandoff(plan)).toThrow('identity changed') } finally { store.close() }
  const alias = file + '.alias'; symlinkSync(file, alias)
  expect(() => CreationReviewStore.openExistingForMaintenance(alias)).toThrow('private')
  linkSync(file, file + '.link'); expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow('private')
  rmSync(file + '.link'); chmodSync(file, 0o644); expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow('private')
})
test.each([false, true])('audit failure rolls back every write (existing audit: %s)', existing => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    if (existing) store.applyGrantHandoff(store.planGrantHandoff(scope))
    const input = { ...scope, transactionId: 'failing', toDigest: existing ? oldDigest : newDigest }, plan = store.planGrantHandoff(input)
    const prepare = DatabaseSync.prototype.prepare
    const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function(this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO creation_review_grant_handoffs')) throw new Error('injected audit failure')
      return prepare.call(this, sql)
    })
    try { expect(() => store.applyGrantHandoff(plan)).toThrow('injected audit failure') } finally { spy.mockRestore() }
    expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get()) !== undefined).toBe(existing)
    if (existing) expect(database(file, db => db.prepare('SELECT COUNT(*) AS n FROM creation_review_grant_handoffs').get()?.n)).toBe(1)
    expect(store.planGrantHandoff(input)).toEqual(plan); expect(store.remaining(scope.authority, plan.before.digest, 5)).toBe(1)
    expect(store.applyGrantHandoff(plan).after.digest).toBe(plan.toDigest)
  } finally { store.close() }
})

test('planning leaves database bytes, schema and journal mode unchanged', () => {
  const file = fixture(), bytes = readFileSync(file)
  const mode = database(file, db => db.prepare('PRAGMA journal_mode').get())
  const store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    store.planGrantHandoff(scope)
    expect(readFileSync(file)).toEqual(bytes)
    expect(database(file, db => db.prepare('PRAGMA journal_mode').get())).toEqual(mode)
    expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined()
  } finally { store.close() }
  expect(readFileSync(file)).toEqual(bytes)
})
test('all history rows are hashed independently beyond a single canonical JSON payload', () => {
  const file = fixture(), runtime = new CreationReviewStore(file)
  for (let index = 0; index < 1000; index++) runtime.claim(`many-${index}`, binding, 'many', oldDigest, 1000)
  for (let index = 0; index < 400; index++) runtime.claim(`extra-${index}`, binding, 'extra', oldDigest, 400)
  runtime.close()
  const store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    const plan = store.planGrantHandoff(scope)
    expect(plan.before.historyCount).toBe(1404)
    expect(store.applyGrantHandoff(plan).after.historyDigest).toBe(plan.before.historyDigest)
  } finally { store.close() }
})
test('audit count is finite and all successive digest handoffs preserve history', () => {
  const file = fixture(), before = history(file), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    for (let index = 0; index < 64; index++) store.applyGrantHandoff(store.planGrantHandoff({ ...scope,
      transactionId: `transaction-${index}`, toDigest: index % 2 === 0 ? newDigest : oldDigest }))
    expect(() => store.applyGrantHandoff(store.planGrantHandoff(scope))).toThrow('audit limit')
    expect(history(file)).toEqual(before)
  } finally { store.close() }
})

test('maintenance rechecks parent privacy and sidecar symlinks after planning', () => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoff(scope)
  try {
    chmodSync(dirname(file), 0o755)
    expect(() => store.applyGrantHandoff(plan)).toThrow('directory must be private')
    chmodSync(dirname(file), 0o700)
    const target = file + '.target'; writeFileSync(target, '', { mode: 0o600 })
    symlinkSync(target, file + '-journal')
    expect(() => store.applyGrantHandoff(plan)).toThrow('database must be private')
    rmSync(file + '-journal')
    expect(store.applyGrantHandoff(plan).after.digest).toBe(newDigest)
  } finally { chmodSync(dirname(file), 0o700); rmSync(file + '-journal', { force: true }); store.close() }
})
test('invalid scope, tampered plan and closed maintenance handle refuse mutation', () => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file), plan = store.planGrantHandoff(scope)
  expect(() => store.planGrantHandoff({ ...scope, lane: 'other' as typeof scope.lane })).toThrow('invalid handoff scope')
  expect(() => store.planGrantHandoff({ ...scope, toDigest: oldDigest })).toThrow('digest unchanged')
  expect(() => store.applyGrantHandoff({ ...plan, toDigest: 'f'.repeat(64) })).toThrow('invalid handoff plan')
  store.close(); expect(() => store.applyGrantHandoff(plan)).toThrow('closed')
})

test.each(['open', 'after-plan'] as const)('literal sqlite_ prefix rejects sqliteX table/trigger without mutation (%s)', stage => {
  const file = fixture(), before = history(file)
  let store: CreationReviewStore | undefined
  try {
    if (stage === 'after-plan') store = CreationReviewStore.openExistingForMaintenance(file)
    const plan = store?.planGrantHandoff(scope)
    database(file, db => db.exec(`CREATE TABLE sqliteXshadow(value TEXT);
      CREATE TRIGGER sqliteXtrigger AFTER UPDATE ON grants BEGIN INSERT INTO sqliteXshadow VALUES('unexpected mutation'); END`))
    if (plan) expect(() => store!.applyGrantHandoff(plan)).toThrow('maintenance schema changed')
    else expect(() => { store = CreationReviewStore.openExistingForMaintenance(file) }).toThrow('maintenance schema changed')
    expect(history(file)).toEqual(before)
    expect(database(file, db => db.prepare('SELECT * FROM sqliteXshadow').all())).toEqual([])
    expect(database(file, db => db.prepare('SELECT digest,maximum,used FROM grants').get()))
      .toEqual({ digest: oldDigest, maximum: 5, used: 4 })
    expect(database(file, db => db.prepare("SELECT name FROM sqlite_schema WHERE name='creation_review_grant_handoffs'").get())).toBeUndefined()
  } finally { store?.close() }
})

test('old transaction cannot retry after A-to-B-to-A-to-B maintenance history growth', () => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file), before = history(file)
  try {
    const first = store.planGrantHandoff(scope), proof = store.applyGrantHandoff(first)
    expect(store.applyGrantHandoff(first)).toEqual(proof)
    store.applyGrantHandoff(store.planGrantHandoff({ ...scope, transactionId: 'return-to-A', toDigest: oldDigest }))
    const third = store.planGrantHandoff({ ...scope, transactionId: 'back-to-B' }); store.applyGrantHandoff(third)
    expect(store.applyGrantHandoff(third).after.digest).toBe(newDigest)
    expect(() => store.applyGrantHandoff(first)).toThrow('retry conflict or drift')
    expect(history(file)).toEqual(before)
    expect(store.remaining(scope.authority, newDigest, 5)).toBe(1)
  } finally { store.close() }
})
test.each([['append', 'apply'], ['modify-prior', 'apply'], ['append', 'retry'], ['modify-prior', 'retry']] as const)(
  '%s audit change fences %s', (change, phase) => {
  const file = fixture(), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    store.applyGrantHandoff(store.planGrantHandoff(scope))
    const input = { ...scope, transactionId: 'second', toDigest: oldDigest }, next = store.planGrantHandoff(input)
    if (phase === 'retry') store.applyGrantHandoff(next)
    // Fixture corruption bypasses immutable audit triggers only to test stale-data rejection.
    database(file, db => {
      if (change === 'append') db.prepare('INSERT INTO creation_review_grant_handoffs VALUES(?,?)').run('unrelated', '{}')
      else {
        const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name='creation_review_handoff_no_update'").get()?.sql
        db.exec('DROP TRIGGER creation_review_handoff_no_update')
        db.exec("UPDATE creation_review_grant_handoffs SET proof='{}' WHERE transaction_id='upgrade-1'")
        db.exec(String(trigger))
      }
    })
    expect(() => store.applyGrantHandoff(next)).toThrow(phase === 'retry' ? 'retry conflict or drift' : 'snapshot changed')
    expect(store.remaining(scope.authority, phase === 'retry' ? oldDigest : newDigest, 5)).toBe(1)
    if (phase === 'apply') expect(database(file, db => db.prepare("SELECT transaction_id FROM creation_review_grant_handoffs WHERE transaction_id='second'").get())).toBeUndefined()
  } finally { store.close() }
})
test.each(['user_version', 'application_id'] as const)('nonzero %s is refused at open and between plan/apply', pragma => {
  const file = fixture(), before = history(file), store = CreationReviewStore.openExistingForMaintenance(file)
  try {
    const plan = store.planGrantHandoff(scope)
    database(file, db => db.exec(`PRAGMA ${pragma}=1`))
    expect(() => store.applyGrantHandoff(plan)).toThrow('metadata changed')
    expect(() => CreationReviewStore.openExistingForMaintenance(file)).toThrow('metadata changed')
    expect(history(file)).toEqual(before)
    expect(database(file, db => db.prepare('SELECT digest,maximum,used FROM grants').get()))
      .toEqual({ digest: oldDigest, maximum: 5, used: 4 })
  } finally { store.close() }
})
