import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationReviewStore } from '../plugins/assistant-verifier/src/creation-review-store.ts'
import { lineageHash, type ReviewPublicIdentity } from '../plugins/assistant-verifier/src/review-authority-lineage.ts'
import { stageOwnerReviewGrantHandoffs, verifyOwnerReviewGrantHandoffs } from '../scripts/install/owner-review-grant-handoff.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
const oldDigest = 'a'.repeat(64), newDigest = 'b'.repeat(64), binding = 'c'.repeat(64), authorityId = 'owner-creation-review'
const keys = generateKeyPairSync('ed25519'), now = Date.now()
const publicKey = keys.publicKey.export({ format: 'pem', type: 'spki' }).toString()
const api = { verifier: { CreationReviewStore, lineageHash } }
const evidence = { old: { configurationDigest: binding, sourceDigest: binding, verificationDigest: binding },
  current: { configurationDigest: newDigest, sourceDigest: newDigest, verificationDigest: newDigest } }

function identity(authorityDigest: string, maximum = 4): ReviewPublicIdentity {
  return { authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId, authorityDigest,
    keyId: 'owner-key', namePrefix: 'owner-', expiresAt: now + 120_000 }, publicKey,
  keyFingerprint: createHash('sha256').update(createPublicKey(publicKey).export({ format: 'der', type: 'spki' })).digest('hex'),
  owner: { authorityId: 'owner-authority', authorityHash: binding, principalId: 'owner', principalRecordId: 'owner-record',
    principalVersion: 1, workspace: '/owner/workspace', agentPreset: 'owner-preset' }, maximum,
  runner: { logicalStateRoot: '/home/owner/.dsh/state/creation-review-runner', maxRuns: 100, maxTotalDurationMs: 600000,
    maxDurationMs: 60000, maxOutputBytes: 65536, expiresAt: now + 120000 },
  budget: { policy: 'exact owner approved review', maxInputBytes: 4096, maxOutputTokens: 1024, maxDurationMs: 60000, maxCases: 2, receiptTtlMs: 60000 } }
}
function certificate(plan: string): PluginCreationVerificationCertificate {
  const body: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: `review-${plan}`, authority: identity(oldDigest).authority as PluginCreationVerificationCertificate['authority'],
    plan: { id: plan, digest: oldDigest, name: 'owner-tool', sourceTreeDigest: binding, sourcePatchDigest: binding,
      artifactSha256: binding, artifactBytes: 42, generatorDigest: binding },
    source: { referenceDigest: binding, ownerDigest: binding, growthRunDigest: binding }, contractDigest: binding, schemaDigest: binding,
    environment: { node: 'v24.7.0', cordis: '4.0.1', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
    model: { provider: 'original-supplier', model: 'original-task-model' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: ['ordinary', 'challenge'].map(caseId => ({ caseId, jobId: `job-${caseId}`, operationDigest: binding, observationDigest: binding })),
    reviewDigest: binding, verifiedAt: now - 1000, expiresAt: now + 60_000,
  }
  return { ...body, signature: sign(null, Buffer.from(canonicalGrowthJson(body)), keys.privateKey).toString('base64url') }
}
function lanePath(lane = 'creation-reviews') {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'owner-review-handoff-'))); roots.push(root)
  return join(root, `verification.sqlite.${lane}`)
}
/** Real store history: certificate, unknown and crash-left review-claimed rows (used=3 of 4). */
function historyLane() {
  const file = lanePath(), store = new CreationReviewStore<unknown>(file)
  try {
    store.claim('certificate', binding, authorityId, oldDigest, 4)
    store.discovered('certificate', binding, { schema: true }); store.contract('certificate', binding, { cases: [] })
    store.claimReview('certificate', binding); store.certificate('certificate', binding, certificate('certificate'))
    store.claim('unknown', binding, authorityId, oldDigest, 4); store.unknown('unknown', binding, 'uncertain')
    store.claim('crashed', binding, authorityId, oldDigest, 4)
    store.discovered('crashed', binding, {}); store.contract('crashed', binding, { cases: [] }); store.claimReview('crashed', binding)
  } finally { store.close() }
  return file
}
const entry = (physicalPath: string, lane = 'creation-reviews', nextIdentity = identity(newDigest)) => ({
  lane, physicalPath, logicalDatabaseScope: 'verifier/reviews', oldIdentity: identity(oldDigest), nextIdentity, configurationEvidence: evidence })
const stage = (lanes: ReturnType<typeof entry>[], transactionId = 'owner-upgrade-1') =>
  stageOwnerReviewGrantHandoffs({ lanes, api, transactionId, installationId: 'install-1', profileId: 'owner', now })
function db<T>(file: string, callback: (handle: DatabaseSync) => T): T { const handle = new DatabaseSync(file); try { return callback(handle) } finally { handle.close() } }
const rows = (file: string) => db(file, h => h.prepare('SELECT * FROM verifications ORDER BY plan').all())
const grants = (file: string) => db(file, h => h.prepare('SELECT * FROM grants').all())
const audits = (file: string) => db(file, h => h.prepare('SELECT COUNT(*) AS n FROM creation_review_grant_handoffs').get()!.n)
const bytes = (file: string) => [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]
  .map(path => fs.existsSync(path) ? createHash('sha256').update(fs.readFileSync(path)).digest('hex') : null)
async function rejects(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => undefined, (e: unknown) => e) as (Error & { code?: string }) | undefined
  expect(error?.code).toBe(code); expect(error?.message).toBe(`owner review grant handoff: ${code}`)
  return error!
}

test('history lane is handed off in place: quota, rows and old evidence kept; only the new identity can claim', async () => {
  const file = historyLane(), before = rows(file)
  const result = await stage([entry(file)])
  expect(result.protocol).toBe('dsh-owner-review-grant-handoffs/v1')
  expect(result.lanes).toEqual([{ lane: 'creation-reviews', status: 'handed-off', headDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    grants: [{ authority: authorityId, maximum: 4, used: 3 }] }])
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/u)
  expect(grants(file)).toEqual([{ authority: authorityId, digest: newDigest, maximum: 4, used: 3 }])
  expect(rows(file)).toEqual(before); expect(audits(file)).toBe(1)
  await expect(verifyOwnerReviewGrantHandoffs({ result, lanes: [entry(file)], api })).resolves.toMatchObject({ digest: result.digest })
  const stat = fs.lstatSync(file)
  const old = CreationReviewStore.resolveHistoricalCertificate(file, { headDigest: result.lanes[0].headDigest!, currentIdentity: identity(newDigest),
    currentFileIdentity: { dev: stat.dev, ino: stat.ino }, installationId: 'install-1', profileId: 'owner', lane: 'creation-reviews',
    logicalDatabaseScope: 'verifier/reviews', planId: 'certificate', now })
  expect(old.identity).toEqual(identity(oldDigest))
  const live = new CreationReviewStore<unknown>(file)
  try {
    expect(() => live.claim('late-old', binding, authorityId, oldDigest, 4)).toThrow('grant changed or corrupt')
    expect(live.claim('late-new', binding, authorityId, newDigest, 4)).toEqual({ state: 'new' })
  } finally { live.close() }
})

test('retry with the same transaction and identities returns the identical result without a second audit row', async () => {
  const file = historyLane(), first = await stage([entry(file)])
  const snapshot = bytes(file), second = await stage([entry(file)])
  expect(second).toEqual(first); expect(audits(file)).toBe(1); expect(bytes(file)).toEqual(snapshot)
  await rejects(stage([entry(file, 'creation-reviews', identity('e'.repeat(64)))]), 'review-handoff-retry-conflict')
  expect(audits(file)).toBe(1)
})

test('empty lane is reported empty and its bytes are untouched', async () => {
  const history = historyLane(), empty = lanePath('revision-reviews')
  new CreationReviewStore(empty).close()
  const before = bytes(empty), result = await stage([entry(history), entry(empty, 'revision-reviews')])
  expect(result.lanes[1]).toEqual({ lane: 'revision-reviews', status: 'empty', headDigest: null, grants: [] })
  expect(bytes(empty)).toEqual(before)
  await expect(verifyOwnerReviewGrantHandoffs({ result, lanes: [entry(history), entry(empty, 'revision-reviews')], api })).resolves.toBeTruthy()
})

test.each([
  ['used above maximum', 'UPDATE grants SET used=5'],
  ['negative used', 'UPDATE grants SET used=-1'],
  ['negative maximum', 'UPDATE grants SET maximum=-1, used=0'],
  ['zero used', 'UPDATE grants SET used=0'],
  ['zero maximum', 'UPDATE grants SET maximum=0, used=0'],
  ['maximum above 1000', 'UPDATE grants SET maximum=1001'],
  ['fractional used', 'UPDATE grants SET used=1.5'],
  ['fractional maximum', 'UPDATE grants SET maximum=4.5'],
  // INTEGER affinity coerces '3' to 3, so only non-numeric text and BLOB stay non-integer.
  ['text used', "UPDATE grants SET used='three'"],
  ['blob used', "UPDATE grants SET used=X'03'"],
])('%s is refused before any write', async (_label, statement) => {
  const file = historyLane()
  db(file, h => h.exec(statement))
  const before = bytes(file)
  await rejects(stage([entry(file)]), 'review-grant-range-invalid')
  expect(bytes(file)).toEqual(before)
})

test('identity change other than authorityDigest is refused by the verifier scope check and leaves the lane unchanged', async () => {
  const file = historyLane(), before = bytes(file), next = identity(newDigest)
  next.owner = { ...next.owner, principalVersion: 2 }
  const error = await rejects(stage([entry(file, 'creation-reviews', next)]), 'review-handoff-rejected')
  expect(String((error.cause as Error).message)).toBe('review lineage: stable identity changed')
  expect(bytes(file)).toEqual(before)
})

test('a verification row rewritten between the pre-read and the post-read is refused', async () => {
  const tamper = (path: string) => db(path, h => h.exec("UPDATE verifications SET data=json_set(data,'$.reason','tampered') WHERE plan='unknown'"))
  // Spy store: another writer rewrites one non-certificate row's bytes at the given step.
  const spying = (step: 'planGrantHandoffV2' | 'applyGrantHandoffV2') => ({ verifier: { lineageHash, CreationReviewStore: {
    openExistingForMaintenance(path: string) {
      const store = CreationReviewStore.openExistingForMaintenance(path)
      const real = (store[step] as (input: never) => unknown).bind(store)
      ;(store as unknown as Record<string, unknown>)[step] = (input: never) => { const result = real(input); tamper(path); return result }
      return store
    } } } })
  const run = (file: string, step: 'planGrantHandoffV2' | 'applyGrantHandoffV2') => stageOwnerReviewGrantHandoffs({
    lanes: [entry(file)], api: spying(step), transactionId: 'owner-upgrade-1', installationId: 'install-1', profileId: 'owner', now })
  // After the plan: the verifier's own apply-time seal check refuses before any CAS.
  const planned = historyLane(), count = rows(planned).length
  await rejects(run(planned, 'planGrantHandoffV2'), 'review-handoff-rejected')
  expect(rows(planned)).toHaveLength(count); expect(grants(planned)[0]).toMatchObject({ digest: oldDigest })
  // After the apply: only the installer's raw row digest sees the change.
  const applied = historyLane()
  await rejects(run(applied, 'applyGrantHandoffV2'), 'review-lane-changed')
})

test('verify detects tampered used, a wrong result digest and a forged head', async () => {
  const file = historyLane(), result = await stage([entry(file)])
  await rejects(verifyOwnerReviewGrantHandoffs({ result: { ...result, digest: 'f'.repeat(64) }, lanes: [entry(file)], api }), 'review-handoff-digest-mismatch')
  const { digest: _, ...body } = result, forgedLanes = [{ ...result.lanes[0], headDigest: 'f'.repeat(64) }]
  const forged = { ...body, lanes: forgedLanes }
  const restamped = { ...forged, digest: createHash('sha256').update(canonicalGrowthJson(forged)).digest('hex') }
  await rejects(verifyOwnerReviewGrantHandoffs({ result: restamped, lanes: [entry(file)], api }), 'review-head-mismatch')
  db(file, h => h.exec('UPDATE grants SET used=2'))
  await rejects(verifyOwnerReviewGrantHandoffs({ result, lanes: [entry(file)], api }), 'review-grant-changed')
})
