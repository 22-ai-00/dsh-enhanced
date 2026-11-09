import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationReviewRuntime, compileCreationReviewConfig, validateCreationReviewConfig, type CreationReviewConfig } from '../src/creation-review.ts'
import { CreationReviewStore, lineageHash, reviewPublicIdentity } from '../src/review-maintenance.ts'
import { validateRevisionReviewConfig } from '../src/revision-review.ts'
import type { LineageScope } from '../src/review-authority-lineage.ts'

const roots: string[] = [], runtimes: CreationReviewRuntime[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const binding = 'c'.repeat(64), planId = 'parent-plan'
const scopeIds = { installationId: 'installation', profileId: 'profile', logicalDatabaseScope: 'verifier/creation-reviews' }

function signed(body: Omit<PluginCreationVerificationCertificate, 'signature'>, key: KeyObject): PluginCreationVerificationCertificate {
  return { ...body, signature: sign(null, Buffer.from(canonicalGrowthJson(body)), key).toString('base64url') }
}
function database<T>(file: string, callback: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file)
  try { return callback(db) } finally { db.close() }
}

/** A-signed parent retained in the creation-review store, then handed off in place to B (runner image only). */
function fixture(signer?: KeyObject) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'creation-historical-'))); roots.push(root); chmodSync(root, 0o700)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer'), databasePath = join(root, 'verifier.sqlite')
  mkdirSync(stateRoot, { mode: 0o700 })
  const keys = generateKeyPairSync('ed25519'), now = Date.now()
  writeFileSync(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const config = (index: string): CreationReviewConfig => ({ authorityId: 'creation-review', owner, namePrefix: 'owner-', keyId: 'key-1', keyPath,
    expiresAt: now + 120_000, maxVerifications: 2,
    runner: { backend: 'macos-seatbelt' as const, stateRoot,
      runtime: { schemaVersion: 1 as const,
        platform: process.arch === 'arm64' ? 'darwin-arm64' as const : 'darwin-x64' as const,
        nodePath: join(root, `runtime-${index}/node`), nodeSha256: 'd'.repeat(64),
        modulesPath: join(root, `runtime-${index}/node_modules`),
        roots: [{ path: join(root, `runtime-${index}`), dev: 1, ino: 1, sha256: 'e'.repeat(64) }],
        versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '4.0.4', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
      expiresAt: now + 120_000,
      maxRuns: 8, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 },
    policy: 'Verify arithmetic specified by the owner.', maxInputBytes: 65_536, maxOutputTokens: 1024,
    maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 })
  const A = config('a'), B = config('b'), authorityA = compileCreationReviewConfig(A).authority
  const body: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'original-review', authority: { ...authorityA },
    plan: { id: planId, digest: binding, name: 'owner-tool', sourceTreeDigest: binding, sourcePatchDigest: binding,
      artifactSha256: binding, artifactBytes: 42, generatorDigest: binding },
    source: { referenceDigest: binding, ownerDigest: binding, growthRunDigest: binding },
    contractDigest: binding, schemaDigest: binding,
    environment: { node: 'v24.7.0', cordis: '4.0.1', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' },
    model: { provider: 'supplier', model: 'task-model' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: ['ordinary', 'challenge'].map(caseId => ({ caseId, jobId: `job-${caseId}`, operationDigest: binding, observationDigest: binding })),
    reviewDigest: binding, verifiedAt: now - 1000, expiresAt: now + 60_000,
  }
  const parent = signed(body, signer ?? keys.privateKey), file = databasePath + '.creation-reviews'
  const writer = new CreationReviewStore(file)
  try {
    writer.claim(planId, binding, A.authorityId, authorityA.authorityDigest, A.maxVerifications)
    writer.discovered(planId, binding, { retained: 'discovery' }); writer.contract(planId, binding, { cases: [] })
    writer.claimReview(planId, binding); writer.certificate(planId, binding, parent)
  } finally { writer.close() }
  const scope = (transactionId: string): LineageScope => ({ transactionId, ...scopeIds, lane: 'creation-reviews',
    oldIdentity: reviewPublicIdentity('creation-reviews', A), newIdentity: reviewPublicIdentity('creation-reviews', B),
    configurationEvidence: { old: { configurationDigest: binding, sourceDigest: binding, verificationDigest: authorityA.authorityDigest },
      current: { configurationDigest: binding, sourceDigest: 'd'.repeat(64), verificationDigest: compileCreationReviewConfig(B).authority.authorityDigest } },
    previousHeadDigest: null })
  const handoff = (transactionId = 'v2-first'): string => {
    const store = CreationReviewStore.openExistingForMaintenance(file)
    try { return lineageHash(store.applyGrantHandoffV2(store.planGrantHandoffV2(scope(transactionId)))) } finally { store.close() }
  }
  const headDigest = handoff()
  const runtime = (input: CreationReviewConfig): CreationReviewRuntime => {
    const created = new CreationReviewRuntime({} as Context, input, databasePath); runtimes.push(created); return created
  }
  const history = { headDigest, ...scopeIds }
  return { A, B, body, parent, keys, file, headDigest, history, handoff, runtime, now }
}

test('after an A→B handoff, an A-signed parent returns its retained cases only with the trusted history', () => {
  const f = fixture()
  const retained = f.runtime({ ...f.B, history: f.history }).readRetainedCases(f.parent)
  expect(retained?.certificate).toEqual(f.parent)
  expect(retained?.discovery).toEqual({ retained: 'discovery' })
  expect(f.runtime(f.B).readRetainedCases(f.parent)).toBeUndefined()
})

test('forged lineage is refused: rewritten audit proof, wrong head, rebuilt chain off the trusted head', () => {
  const f = fixture()
  expect(f.runtime({ ...f.B, history: { ...f.history, headDigest: 'f'.repeat(64) } }).readRetainedCases(f.parent)).toBeUndefined()
  database(f.file, db => {
    const proof = JSON.parse(String(db.prepare('SELECT proof FROM creation_review_grant_handoffs').get()!.proof))
    proof.plan.scope.transactionId = 'rewritten'
    db.exec('DROP TRIGGER creation_review_handoff_no_update')
    db.prepare('UPDATE creation_review_grant_handoffs SET proof=?').run(canonicalGrowthJson(proof))
    db.exec("CREATE TRIGGER creation_review_handoff_no_update BEFORE UPDATE ON creation_review_grant_handoffs BEGIN SELECT RAISE(ABORT,'immutable review handoff'); END")
  })
  expect(f.runtime({ ...f.B, history: f.history }).readRetainedCases(f.parent)).toBeUndefined()
  // Rebuild a fully self-consistent chain from scratch: only the trusted head decides.
  database(f.file, db => {
    db.exec('DROP TABLE creation_review_grant_handoffs')
    db.prepare('UPDATE grants SET digest=?').run(f.parent.authority.authorityDigest)
  })
  const rebuilt = f.handoff('v2-rebuilt')
  expect(rebuilt).not.toBe(f.headDigest)
  expect(f.runtime({ ...f.B, history: f.history }).readRetainedCases(f.parent)).toBeUndefined()
  expect(f.runtime({ ...f.B, history: { ...f.history, headDigest: rebuilt } }).readRetainedCases(f.parent)?.certificate).toEqual(f.parent)
})

test('unrelated authority and lane/scope mismatch are refused', () => {
  const f = fixture(), reader = f.runtime({ ...f.B, history: f.history })
  expect(reader.readRetainedCases(signed(f.body, generateKeyPairSync('ed25519').privateKey))).toBeUndefined()
  expect(reader.readRetainedCases(signed({ ...f.body, authority: { ...f.body.authority, authorityId: 'other-authority' } }, f.keys.privateKey))).toBeUndefined()
  for (const history of [{ ...f.history, logicalDatabaseScope: 'verifier/revision-reviews' }, { ...f.history, profileId: 'other-profile' },
    { ...f.history, installationId: 'other-installation' }]) {
    expect(f.runtime({ ...f.B, history }).readRetainedCases(f.parent)).toBeUndefined()
  }
})

test('tampered sealed row, expired current authority and a parent differing from the sealed certificate are refused', () => {
  const f = fixture(), reader = f.runtime({ ...f.B, history: f.history })
  expect(reader.readRetainedCases(signed({ ...f.body, verificationId: 'other-review' }, f.keys.privateKey))).toBeUndefined()
  vi.spyOn(Date, 'now').mockReturnValue(f.B.expiresAt)
  expect(reader.readRetainedCases(f.parent)).toBeUndefined()
  vi.restoreAllMocks()
  expect(reader.readRetainedCases(f.parent)?.certificate).toEqual(f.parent)
  database(f.file, db => {
    const data = JSON.parse(String(db.prepare('SELECT data FROM verifications WHERE plan=?').get(planId)!.data)); data.discovery = { altered: true }
    db.prepare('UPDATE verifications SET data=? WHERE plan=?').run(canonicalGrowthJson(data), planId)
  })
  expect(reader.readRetainedCases(f.parent)).toBeUndefined()
})

test('history config is strict and creation-only', () => {
  const f = fixture()
  for (const history of [{ ...f.history, headDigest: 'F'.repeat(64) }, { ...f.history, extra: true },
    { headDigest: f.headDigest, installationId: 'installation', profileId: 'profile' }, { ...f.history, profileId: '' },
    { ...f.history, installationId: 'x'.repeat(201) }]) {
    expect(() => validateCreationReviewConfig({ ...f.B, history } as CreationReviewConfig)).toThrow('creation review invalid')
  }
  expect(validateCreationReviewConfig({ ...f.B, history: f.history }).history).toEqual(f.history)
  expect(compileCreationReviewConfig({ ...f.B, history: f.history }).authority).toEqual(compileCreationReviewConfig(f.B).authority)
  expect(() => validateRevisionReviewConfig({ ...f.B, history: f.history })).toThrow('history')
})

test('a sealed row whose A-authority certificate carries a foreign signature is refused by the historical signature check', () => {
  // The handoff seals any certificate row under the old authority without verifying it, so only the
  // historical signature check stands between such a row and the regression lane.
  const f = fixture(generateKeyPairSync('ed25519').privateKey)
  expect(f.runtime({ ...f.B, history: f.history }).readRetainedCases(f.parent)).toBeUndefined()
})
