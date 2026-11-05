import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as yaml from 'yaml'
import { afterEach, expect, test } from 'vitest'
import { CreationCapabilityJournal, creationCapabilityAuthorityDigest, creationCapabilityPublicKey } from '../plugins/plugin-control-plane/src/creation-capability-journal.ts'
import type { CreationCapabilityConfig } from '../plugins/plugin-control-plane/src/creation-capability-types.ts'
import { CreationReviewStore } from '../plugins/assistant-verifier/src/creation-review-store.ts'
import { inspectOwnerCreationHistory, inspectOwnerEmptyCreationHistory } from '../scripts/install/owner-empty-creation-history.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'owner-history-v2-test-'))); roots.push(home)
  const stateRoot = join(home, 'rsi-authorities', 'owner', 'state'), statePath = join(stateRoot, 'control-plane')
  fs.mkdirSync(statePath, { recursive: true, mode: 0o700 }); fs.mkdirSync(join(home, 'assistant-verifier'), { mode: 0o700 })
  const keyPath = join(home, 'adoption.key'), keys = generateKeyPairSync('ed25519')
  fs.writeFileSync(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config: CreationCapabilityConfig = { authorityId: 'owner-adoption', keyId: 'owner-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: 'a'.repeat(64), principalId: 'channel/account/tenant/user',
      principalRecordId: 'record-1', principalVersion: 1, workspace: home, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120000, maxAdoptions: 2, maxTools: 2,
    maxCallsPerAdoption: 3, maxCallRecords: 3, maxInputBytes: 1024,
    runner: { stateRoot: join(stateRoot, 'creation-adoption-runner'), image: `runner@sha256:${'b'.repeat(64)}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120000, maxRuns: 5, maxTotalDurationMs: 30000, maxDurationMs: 10000, maxOutputBytes: 65536 } }
  fs.mkdirSync(config.runner.stateRoot, { recursive: true, mode: 0o700 })
  const reviewConfig = { authorityId: 'creation-review', keyId: 'review-key', keyPath, owner: config.owner,
    namePrefix: 'generated-', expiresAt: config.expiresAt, maxVerifications: 2, runner: config.runner,
    policy: 'owner approved', maxInputBytes: 4096, maxOutputTokens: 1024, maxDurationMs: 60000, maxCases: 2, receiptTtlMs: 60000 }
  const review = join(home, 'assistant-verifier', 'verification.sqlite.creation-reviews')
  new CreationReviewStore(review).close()
  const adoption = join(statePath, 'creation-adoptions.sqlite')
  new CreationCapabilityJournal({ path: adoption, config }).close()
  const manifest = { sourceReviews: { authorityId: 'source-review' }, pluginCreation: { reviews: reviewConfig, capabilities: config },
    controlPlane: { statePath, creationCapabilities: config } }
  const verifier = { databasePath: join(home, 'assistant-verifier', 'verification.sqlite'), sourceReviews: manifest.sourceReviews, creationReviews: reviewConfig }
  const rows = [{ id: 'dsh-enhanced-assistant-verifier', config: verifier }, { id: 'dsh-enhanced-plugin-control-plane', config: manifest.controlPlane }]
  const ownerUpdate = { homePath: home, profile: 'owner', original: { resources: { installationId: 'install-1', stateRoot }, manifest,
    effective: { targetEffective: yaml.stringify(rows) } } }
  const api = { yaml, control: { creationCapabilityAuthorityDigest, creationCapabilityPublicKey } }
  return { review, adoption, ownerUpdate, api, manifest, rows, verifier, reviewConfig }
}
function sql(file: string, statement: string) { const db = new DatabaseSync(file); try { db.exec(statement) } finally { db.close() } }
function sha(file: string) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
const classify = (f: ReturnType<typeof fixture>) => inspectOwnerCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })
const H = (c: string) => c.repeat(64)
// CHECK-valid rows: authorized/active carry tools and receipt with no reason; terminal rows carry a reason.
const adoptionRow = (plan: string, status: string) => {
  const settled = ['authorized', 'active'].includes(status), terminal = ['closed', 'unknown', 'rejected'].includes(status)
  const tools = settled ? `'[]','${H('d')}','{}'` : 'NULL,NULL,NULL'
  return `INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,tools_json,tools_digest,receipt_json,reason) VALUES('${plan}','${status}','{}','${H('a')}',X'01','${H('b')}',${tools},${terminal ? "'settled'" : 'NULL'});`
}
const call = (plan: string, key: string, status: string) =>
  `INSERT INTO calls(plan_id,call_key,arguments_digest,status) VALUES('${plan}','${key}','${H('c')}','${status}');`
const sidecars = (file: string) => [file, `${file}-wal`, `${file}-shm`].map(path => fs.existsSync(path) ? sha(path) : null)

test('empty stores classify as empty under the v2 protocol with zeroed status counts', async () => {
  const f = fixture(), result = await classify(f)
  expect(result.protocol).toBe('dsh-owner-creation-history/v2')
  expect(result.status).toBe('empty')
  expect(result.adoption.status).toBe('empty')
  expect(result.adoption.byStatus).toEqual({ claimed: 0, authorized: 0, active: 0, closed: 0, unknown: 0, rejected: 0 })
  expect(result.adoption.callsByStatus).toEqual({ claimed: 0, completed: 0, unknown: 0 })
  expect(result.reviews[0]).toMatchObject({ lane: 'creation-reviews', status: 'empty' })
  expect(result.digest).toMatch(/^[a-f0-9]{64}$/u)
})

test('v1 output is unchanged by the v2 classifier (same keys, digest stable across calls)', async () => {
  const f = fixture(), v1 = await inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })
  expect(Object.keys(v1)).toEqual(['protocol', 'status', 'installationId', 'profile', 'logicalHome', 'physicalHome', 'reviews', 'adoption', 'digest'])
  expect(v1.protocol).toBe('dsh-owner-empty-creation-history/v1')
  expect(v1.adoption).not.toHaveProperty('byStatus'); expect(v1.reviews[0]).not.toHaveProperty('byState')
  expect((await inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })).digest).toBe(v1.digest)
})

test('adoption history in every status, including unsettled ones, is sealable and leaves the source unchanged', async () => {
  const f = fixture()
  sql(f.adoption, `${['claimed', 'authorized', 'active', 'closed', 'unknown', 'rejected']
    .map((status, index) => adoptionRow(`plan-${index}`, status)).join('')}
    ${call('plan-2', 'call-a', 'completed')}${call('plan-2', 'call-b', 'unknown')}${call('plan-1', 'call-c', 'claimed')}`)
  const before = sidecars(f.adoption), result = await classify(f)
  expect(result.status).toBe('sealable')
  expect(result.adoption.status).toBe('sealable')
  expect(result.adoption.counts).toMatchObject({ adoptions: 6, calls: 3 })
  expect(result.adoption.byStatus).toEqual({ claimed: 1, authorized: 1, active: 1, closed: 1, unknown: 1, rejected: 1 })
  expect(result.adoption.callsByStatus).toEqual({ claimed: 1, completed: 1, unknown: 1 })
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0)
  expect(sum(result.adoption.byStatus)).toBe(result.adoption.counts.adoptions)
  expect(sum(result.adoption.callsByStatus)).toBe(result.adoption.counts.calls)
  expect(sidecars(f.adoption)).toEqual(before)
  // The v1 empty gate still refuses the same Home, so the empty protocol never changes meaning.
  await expect(inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })).rejects.toThrow('adoption-history-present')
})

test('rows that violate the journal CHECK constraints are refused, never archived or counted', async () => {
  const cols = 'plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,tools_json,tools_digest,receipt_json,reason'
  const row = (o: Partial<Record<string, string>>) => {
    const v = { plan_id: "'p'", status: "'closed'", certificate_json: "'{}'", certificate_digest: `'${H('a')}'`, artifact: "X'01'",
      artifact_sha: `'${H('b')}'`, tools_json: 'NULL', tools_digest: 'NULL', receipt_json: 'NULL', reason: "'settled'", ...o }
    return `INSERT INTO adoptions(${cols}) VALUES(${cols.split(',').map(c => v[c]).join(',')});`
  }
  const adoptionCases = [
    // cross-column
    row({ status: "'active'" }), row({ reason: 'NULL' }), row({ status: "'claimed'" }), row({ reason: "''" }), row({ reason: `'${'r'.repeat(65)}'` }),
    // single-column
    row({ certificate_digest: "'short'" }), row({ certificate_json: "'{not json'" }), row({ artifact: "X''" }),
    row({ artifact_sha: "'short'" }), row({ tools_json: "'{bad'" }), row({ receipt_json: "'{bad'" }),
    row({ certificate_json: `'${JSON.stringify({ x: 'y'.repeat(70000) })}'` }),
  ]
  for (const statement of adoptionCases) {
    const f = fixture()
    sql(f.adoption, `PRAGMA ignore_check_constraints=ON; ${statement}`)
    await expect(classify(f)).rejects.toThrow('adoption-row-invalid')
  }
  const callCols = 'plan_id,call_key,arguments_digest,status,result_json,job_id,foreground_json'
  const call = (o: Partial<Record<string, string>>) => {
    const v = { plan_id: "'p'", call_key: "'k'", arguments_digest: `'${H('c')}'`, status: "'completed'", result_json: 'NULL', job_id: 'NULL', foreground_json: 'NULL', ...o }
    return `INSERT INTO calls(${callCols}) VALUES(${callCols.split(',').map(c => v[c]).join(',')});`
  }
  const callCases = [call({ status: "'claimed'", job_id: "'job-1'" }), call({ status: "'claimed'", result_json: "'{}'" }),
    call({ arguments_digest: "'short'" }), call({ result_json: "'{bad'" }), call({ foreground_json: "'{bad'" })]
  for (const statement of callCases) {
    const g = fixture()
    sql(g.adoption, `${adoptionRow('p', 'active')} PRAGMA ignore_check_constraints=ON; ${statement}`)
    await expect(classify(g)).rejects.toThrow('call-row-invalid')
  }
  const h = fixture()
  sql(h.adoption, `${adoptionRow('p', 'active')} PRAGMA ignore_check_constraints=ON; INSERT INTO source_archives VALUES('p','{bad');`)
  await expect(classify(h)).rejects.toThrow('source-archive-row-invalid')
  const k = fixture()
  sql(k.adoption, `PRAGMA ignore_check_constraints=ON; ${row({ status: "'bogus'" })}`)
  await expect(classify(k)).rejects.toThrow('adoption-status-invalid')
})

test('review lanes with terminal or crash-left rows are sealable, every lane reported, sources unchanged', async () => {
  const f = fixture(), revision = { reviews: f.reviewConfig, regressions: f.reviewConfig }
  Object.assign(f.manifest, { pluginRevision: revision })
  Object.assign(f.verifier, { revisionReviews: revision.reviews, revisionRegressions: revision.regressions })
  f.ownerUpdate.original.effective.targetEffective = yaml.stringify(f.rows)
  const revisionPath = f.review.replace('creation-reviews', 'revision-reviews'), regressionPath = f.review.replace('creation-reviews', 'revision-regressions')
  new CreationReviewStore(revisionPath).close(); new CreationReviewStore(regressionPath).close()
  sql(f.review, "INSERT INTO grants VALUES('creation-review','digest',2,2); INSERT INTO verifications VALUES('old','binding','creation-review','unknown','{}'),('crashed','binding','creation-review','review-claimed','{}')")
  sql(regressionPath, "INSERT INTO verifications VALUES('reg','binding','creation-review','certificate','{}')")
  const before = [f.review, revisionPath, regressionPath].map(sidecars), result = await classify(f)
  expect(result.status).toBe('sealable')
  expect(result.adoption.status).toBe('empty')
  expect(result.reviews.map(r => [r.lane, r.status])).toEqual([['creation-reviews', 'sealable'], ['revision-reviews', 'empty'], ['revision-regressions', 'sealable']])
  expect(result.reviews[0]).toMatchObject({ counts: { grants: 1, verifications: 2 } })
  expect(result.reviews[0].byState).toMatchObject({ unknown: 1, 'review-claimed': 1, certificate: 0 })
  expect(result.reviews[2].byState).toMatchObject({ certificate: 1 })
  expect([f.review, revisionPath, regressionPath].map(sidecars)).toEqual(before)
  await expect(inspectOwnerEmptyCreationHistory({ ownerUpdate: f.ownerUpdate, api: f.api })).rejects.toThrow('review-history-present')
})

test('a status outside the reviewed enum refuses instead of being sealed', async () => {
  const f = fixture()
  sql(f.adoption, `PRAGMA ignore_check_constraints=ON; INSERT INTO adoptions(plan_id,status,certificate_json,certificate_digest,artifact,artifact_sha,reason) VALUES('x','bogus','{}','${H('a')}',X'01','${H('b')}','r');`)
  await expect(classify(f)).rejects.toThrow('adoption-status-invalid')
  const g = fixture()
  sql(g.review, "INSERT INTO verifications VALUES('old','binding','creation-review','mystery','{}')")
  await expect(classify(g)).rejects.toThrow('review-state-invalid')
})

test.each([
  ['BLOB duplicate of a valid state', "('a','b','r','unknown','{}'),('b','b','r','unknown','{}'),('c','b','r',CAST('unknown' AS BLOB),'{}')"],
  ['integer state', "('a','b','r',7,'{}')"],
  ['NUL-suffixed state', "('a','b','r','unknown'||char(0),'{}')"],
  ['invalid UTF-8 state', "('a','b','r',X'ff','{}')"],
])('review state storage %s refuses instead of miscounting', async (_label, values) => {
  const f = fixture()
  sql(f.review, `INSERT INTO verifications VALUES ${values}`)
  await expect(classify(f)).rejects.toThrow('review-state-invalid')
})

test('classification is deterministic for the same stores', async () => {
  const f = fixture()
  sql(f.adoption, adoptionRow('plan-1', 'active'))
  expect((await classify(f)).digest).toBe((await classify(f)).digest)
})
