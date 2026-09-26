import { generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import * as store from '../src/store.ts'
import { controlPlaneDigest } from '../src/store.ts'
import { parsePostActivationObservation } from '../src/post-activation.ts'
import { authorizeLiveQualification, LiveQualificationAuthorityError,
  type LiveQualificationAuthorityConfig } from '../src/live-qualification-authority.ts'
import { assertLiveQualificationBatch, liveQualificationDigest, liveQualificationId,
  liveQualificationReceiptId, liveQualificationSigningPayload, parseLiveQualificationReceipt,
  validateLiveQualificationTerms, verifyLiveQualificationReceipt,
  type LiveQualificationBatch, type LiveQualificationReceipt } from '../src/live-qualification.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function fixture(status: 'achieved' | 'not-achieved' = 'achieved') {
  const now = Date.now()
  const terms = { protocol: 'dsh-bounded-live/v1' as const, maximumWindowMs: 60_000,
    minimumTasks: 1, authority: 'independent-live', keyId: 'live-key' }
  const core = {
    lane: 'a'.repeat(64), configDigest: 'b'.repeat(64), trustDigest: 'c'.repeat(64),
    planId: 'plan', planDigest: 'd'.repeat(64), installationId: 'installation',
    profilePath: '/tmp/profile', owner: {
      authorityId: 'owner-route', authorityHash: 'e'.repeat(64), principalId: 'owner',
      principalRecordId: 'record', principalVersion: 1, workspace: '/tmp', agentPreset: 'primary',
    }, terms, activationId: 'activation', fence: 1, startedAt: now - 1_000, deadlineAt: now + 59_000,
    readinessDigest: 'f'.repeat(64), hostGeneration: 2,
    votes: [{ inboxId: 'inbox-1', outcomeId: 'outcome-1', projection: {
      subjectKind: 'foreground-turn' as const, subjectRef: 'inbox-1', version: 1,
      digest: '1'.repeat(64), disposition: 'upsert' as const,
    }, sourceDigest: '2'.repeat(64), deploymentDigest: '3'.repeat(64), status, completedAt: now - 100 }],
  }
  const unsigned = { schemaVersion: 1 as const, kind: 'dsh-live-qualification' as const,
    id: liveQualificationId(core), ...core, createdAt: now, expiresAt: now + 20_000 }
  const batch: LiveQualificationBatch = { ...unsigned, digest: liveQualificationDigest(unsigned) }
  const keys = generateKeyPairSync('ed25519')
  const identity = {
    schemaVersion: 1 as const, kind: 'dsh-live-qualification-receipt' as const,
    authority: terms.authority, keyId: terms.keyId, batchId: batch.id, batchDigest: batch.digest,
    planId: batch.planId, planDigest: batch.planDigest, activationId: batch.activationId,
    fence: batch.fence, hostGeneration: batch.hostGeneration,
    disposition: status === 'achieved' ? 'qualified' as const : 'failed' as const,
    observedAt: now, expiresAt: now + 10_000,
  }
  const unsignedReceipt = { ...identity, receiptId: liveQualificationReceiptId(identity) }
  const receipt: LiveQualificationReceipt = { ...unsignedReceipt,
    signature: sign(null, Buffer.from(liveQualificationSigningPayload(unsignedReceipt)), keys.privateKey).toString('base64') }
  return { now, batch, receipt, keys }
}

function reseal(batch: LiveQualificationBatch): LiveQualificationBatch {
  const id = liveQualificationId(batch)
  const unsigned = { ...batch, id }
  return { ...unsigned, digest: liveQualificationDigest(unsigned) }
}

describe('bounded live qualification contract', () => {
  test('terms admit only finite windows and task counts with exact fields', () => {
    const { batch } = fixture()
    expect(() => validateLiveQualificationTerms(batch.terms)).not.toThrow()
    for (const invalid of [
      { ...batch.terms, maximumWindowMs: 59_999 },
      { ...batch.terms, maximumWindowMs: 86_400_001 },
      { ...batch.terms, minimumTasks: 0 },
      { ...batch.terms, minimumTasks: 33 },
      { ...batch.terms, maximumExposures: 1 },
      { ...batch.terms, protocol: 'dsh-task-observation/v1' },
    ]) expect(() => validateLiveQualificationTerms(invalid)).toThrow()
  })

  test.each(['achieved', 'not-achieved'] as const)('%s batch and domain-separated receipt verify against the exact evidence', status => {
    const { batch, receipt, keys, now } = fixture(status)
    expect(() => assertLiveQualificationBatch(batch)).not.toThrow()
    expect(parseLiveQualificationReceipt(receipt)).toEqual(receipt)
    expect(() => parsePostActivationObservation(receipt)).toThrow()
    const key = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    expect(verifyLiveQualificationReceipt(receipt, batch, key, now)).toEqual(receipt)
    expect(liveQualificationSigningPayload((({ signature: _signature, ...unsigned }) => unsigned)(receipt)))
      .toMatch(/^dsh-bounded-live\/v1\n/u)
    expect(() => verifyLiveQualificationReceipt(receipt, batch, key, receipt.expiresAt)).toThrow()
    expect(() => verifyLiveQualificationReceipt({ ...receipt, disposition: status === 'achieved' ? 'failed' : 'qualified' }, batch, key, now)).toThrow()
    expect(() => verifyLiveQualificationReceipt(receipt, { ...batch, planDigest: '9'.repeat(64) }, key, now)).toThrow()
    expect(() => verifyLiveQualificationReceipt(receipt, batch, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }), now)).toThrow()
    expect(() => verifyLiveQualificationReceipt({ ...receipt, signature: 'AA==' }, batch, key, now)).toThrow()
  })

  test('positive batch rejects duplicate inbox, insufficient tasks and a window that exceeded its maximum', () => {
    const { batch } = fixture()
    const cases = [
      reseal({ ...batch, terms: { ...batch.terms, minimumTasks: 2 } }),
      reseal({ ...batch, votes: [...batch.votes, batch.votes[0]!] }),
      reseal({ ...batch, deadlineAt: batch.startedAt + batch.terms.maximumWindowMs + 1 }),
      reseal({ ...batch, createdAt: batch.deadlineAt }),
    ]
    for (const candidate of cases) expect(() => assertLiveQualificationBatch(candidate)).toThrow()
    const failed = fixture('not-achieved').batch
    expect(() => assertLiveQualificationBatch(reseal({ ...failed, terms: { ...failed.terms, minimumTasks: 2 } }))).not.toThrow()
    expect(controlPlaneDigest(batch)).toMatch(/^[a-f0-9]{64}$/u)
  })
})

test.each(['achieved', 'not-achieved'] as const)('independent signer freezes a finite grant and %s receipt across replay', async status => {
  const { batch, keys } = fixture(status)
  const root = await mkdtemp(join(tmpdir(), 'dsh-live-authority-'))
  roots.push(root)
  const keyPath = join(root, 'key.pem'), controlDatabasePath = join(root, 'control.sqlite'), statePath = join(root, 'state.sqlite')
  await writeFile(keyPath, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const db = new DatabaseSync(controlDatabasePath)
  db.close()
  await chmod(controlDatabasePath, 0o600)
  const config: LiveQualificationAuthorityConfig = {
    schemaVersion: 1, authority: batch.terms.authority, keyId: batch.terms.keyId,
    keyPath, statePath, controlDatabasePath,
    grant: { id: 'grant', expiresAt: batch.deadlineAt, maxQualifications: 1, owner: batch.owner,
      installationId: batch.installationId, ledger: { id: 'ledger', path: controlDatabasePath },
      profilePath: batch.profilePath, packages: ['@dsh-enhanced/example'], terms: batch.terms,
      receiptTtlMs: 10_000 },
  }
  const deployment = { task: { inboxId: batch.votes[0]!.inboxId,
    owner: { principalRecordId: batch.owner.principalRecordId, principalVersion: batch.owner.principalVersion },
    scope: { workspace: batch.owner.workspace, preset: batch.owner.agentPreset } },
  readiness: { planId: batch.planId, planDigest: batch.planDigest, activationId: batch.activationId,
    fence: batch.fence, hostGeneration: batch.hostGeneration },
  execution: { completedAt: batch.votes[0]!.completedAt } }
  const reanchored = { ...batch,
    terms: { ...batch.terms, minimumTasks: status === 'achieved' ? 1 : 2 },
    votes: [{ ...batch.votes[0]!, deploymentDigest: controlPlaneDigest(deployment) }] }
  const finalBatch = reseal(reanchored)
  config.grant.terms = finalBatch.terms
  const context = { record: { batch: finalBatch, state: 'pending' as const },
    plan: { id: batch.planId, digest: batch.planDigest, status: 'awaiting-live-tasks',
      activation: { id: batch.activationId, fence: batch.fence }, candidate: { id: 'example', package: '@dsh-enhanced/example' },
      ledger: config.grant.ledger, dossier: { liveQualification: finalBatch.terms } },
    source: { owner: batch.owner }, deployments: [deployment] }
  vi.spyOn(store, 'readLiveQualificationContext').mockReturnValue(context as never)
  const finalRequest = { protocol: 'dsh-live-qualification/v1' as const,
    batchId: finalBatch.id, batchDigest: finalBatch.digest }
  context.plan.candidate.id = 'assistant-policy'
  await expect(authorizeLiveQualification(config, finalRequest)).rejects.toBeInstanceOf(LiveQualificationAuthorityError)
  context.plan.candidate.id = 'example'
  const first = await authorizeLiveQualification(config, finalRequest)
  expect(first.disposition).toBe(status === 'achieved' ? 'qualified' : 'failed')
  expect(first.batchDigest).toBe(finalBatch.digest)
  expect(verifyLiveQualificationReceipt(first, finalBatch,
    keys.publicKey.export({ type: 'spki', format: 'pem' }), first.observedAt)).toEqual(first)
  expect(await authorizeLiveQualification(config, finalRequest)).toEqual(first)
  await expect(authorizeLiveQualification({ ...config, grant: { ...config.grant, receiptTtlMs: 11_000 } }, finalRequest))
    .rejects.toBeInstanceOf(LiveQualificationAuthorityError)
  const state = new DatabaseSync(statePath, { readOnly: true })
  try { expect(state.prepare('SELECT COUNT(*) AS count FROM live_qualification_receipts').get()).toEqual({ count: 1 }) }
  finally { state.close() }
})
