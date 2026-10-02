import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { CreationCapabilityJournal, creationCapabilityPublicKey, validateCreationCapabilityConfig,
  verifyCreationCapabilityReceipt } from '../src/creation-capability-journal.js'
import type { CreationCapabilityConfig, CreationCapabilityTool } from '../src/creation-capability-types.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const d = (letter: string) => letter.repeat(64)
function fixture(maxAdoptions = 2, maxCalls = 3) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'creation-capability-')); roots.push(root); chmodSync(root, 0o700)
  const signing = generateKeyPairSync('ed25519'), verifier = generateKeyPairSync('ed25519')
  const keyPath = join(root, 'adoption.key')
  writeFileSync(keyPath, signing.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const config: CreationCapabilityConfig = {
    authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
    owner: { authorityId: 'owner', authorityHash: d('a'), principalId: 'provider/account/tenant/user',
      principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'default' },
    namePrefix: 'generated-', expiresAt: Date.now() + 120_000, maxAdoptions, maxTools: 2,
    maxCallsPerAdoption: maxCalls, maxCallRecords: maxCalls, maxInputBytes: 1024,
    runner: { stateRoot: root, image: `runner@sha256:${d('a')}`, dockerPath: '/usr/bin/docker',
      expiresAt: Date.now() + 120_000, maxRuns: 5, maxTotalDurationMs: 30_000,
      maxDurationMs: 10_000, maxOutputBytes: 65536 },
  }
  const path = join(root, 'creation-adoptions.sqlite')
  const artifact = Buffer.from('exact candidate tarball')
  function certificate(planId: string): PluginCreationVerificationCertificate {
    const now = Date.now()
    const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
      protocol: 'assistant-growth/creation-verification/v1', verificationId: `verification-${planId}`,
      authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'independent-verifier',
        keyId: 'verifier-key', authorityDigest: d('b'), namePrefix: 'generated-', expiresAt: now + 120_000 },
      plan: { id: planId, digest: d('c'), name: `generated-${planId}`, sourceTreeDigest: d('d'),
        sourcePatchDigest: d('e'), artifactSha256: createHash('sha256').update(artifact).digest('hex'),
        artifactBytes: artifact.length, generatorDigest: d('f') },
      source: { referenceDigest: d('1'), ownerDigest: d('2'), growthRunDigest: d('3') },
      contractDigest: d('4'), schemaDigest: d('5'), environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
      model: { provider: 'fixture', model: 'test' }, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
      sessions: { contract: 'contract-session', sourceReview: 'review-session' },
      observations: [{ caseId: 'first', jobId: 'job-first', operationDigest: d('6'), observationDigest: d('7') },
        { caseId: 'second', jobId: 'job-second', operationDigest: d('8'), observationDigest: d('9') }],
      reviewDigest: d('0'), verifiedAt: now - 1000, expiresAt: now + 90_000,
    }
    return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), verifier.privateKey).toString('base64url') }
  }
  return { root, config, path, artifact, certificate, signing }
}
const tools: CreationCapabilityTool[] = [{ originalName: 'echo', name: 'generated_echo', description: 'Echo', parameters: { type: 'object' } }]

test('owner key and config preflight are read-only and reject unsafe fields', () => {
  const f = fixture()
  validateCreationCapabilityConfig(f.config)
  expect(creationCapabilityPublicKey(f.config)).toContain('BEGIN PUBLIC KEY')
  expect(() => validateCreationCapabilityConfig({ ...f.config, maxAdoptions: 33 })).toThrow()
  let invoked = false
  const bad = { ...f.config }
  Object.defineProperty(bad, 'keyPath', { enumerable: true, get() { invoked = true; return f.config.keyPath } })
  expect(() => validateCreationCapabilityConfig(bad)).toThrow()
  expect(invoked).toBe(false)
})

test('accepts immutable Docker image ID or repository digest, rejecting mutable tags', () => {
  const f = fixture()
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, image: `sha256:${d('a')}` } })).not.toThrow()
  expect(() => validateCreationCapabilityConfig(f.config)).not.toThrow()
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, image: 'runner:latest' } })).toThrow()
})

test('preflight rejects budgets the actual process runner cannot start', () => {
  const f = fixture()
  for (const budget of [{ maxOutputBytes: 65535 }, { maxOutputBytes: 65537 },
    { maxDurationMs: 300001 }, { maxDurationMs: 30000, maxTotalDurationMs: 29999 }]) {
    expect(() => validateCreationCapabilityConfig({ ...f.config,
      runner: { ...f.config.runner, ...budget } })).toThrow()
  }
  expect(() => validateCreationCapabilityConfig({ ...f.config,
    runner: { ...f.config.runner, maxDurationMs: 300000, maxTotalDurationMs: 300000 } })).not.toThrow()
})

test('claim and signed adoption survive restart without restoring quota', () => {
  const f = fixture(1), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  const certificate = f.certificate('one')
  try {
    expect(journal.claim({ certificate, artifact: f.artifact }).created).toBe(true)
    expect(journal.claim({ certificate, artifact: f.artifact }).created).toBe(false)
    expect(() => journal.claim({ certificate, artifact: Buffer.from('tampered') })).toThrow()
    const record = journal.authorize('one', tools)
    expect(record.status).toBe('authorized')
    expect(record.receipt && verifyCreationCapabilityReceipt(record.receipt, journal.authorityDigest, journal.publicKey)).toBe(true)
    expect(record.receipt && verifyCreationCapabilityReceipt({ ...record.receipt, toolsDigest: d('f') }, journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(journal.activate('one').status).toBe('active')
  } finally { journal.close() }
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(reopened.inspect('one')?.status).toBe('active')
    expect(() => reopened.claim({ certificate: f.certificate('two'), artifact: f.artifact })).toThrow()
    expect(() => new CreationCapabilityJournal({ path: f.path, config: { ...f.config, maxCallsPerAdoption: 2 } })).toThrow()
  } finally { reopened.close() }
})

test('call keys bind arguments, spend finite quota, and recovered claims never dispatch again', () => {
  const f = fixture(2, 1), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one'), artifact: f.artifact })
    journal.authorize('one', tools); journal.activate('one')
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).created).toBe(true)
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).created).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('b') })).toThrow()
    expect(() => journal.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
  const reopened = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    expect(reopened.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call.status).toBe('claimed')
    reopened.recoverClaims()
    expect(reopened.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call.status).toBe('unknown')
    expect(() => reopened.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: 'late' })).toThrow()
    expect(() => reopened.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { reopened.close() }
})

test('terminal state and SQLite constraints reject reauthorization and corrupt rows', () => {
  const f = fixture(), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    const certificate = f.certificate('one')
    journal.claim({ certificate, artifact: f.artifact })
    journal.recoverClaims()
    expect(journal.inspect('one')?.status).toBe('unknown')
    expect(() => journal.authorize('one', tools)).toThrow()
    expect(journal.claim({ certificate, artifact: f.artifact }).record.status).toBe('unknown')
    const raw = new DatabaseSync(f.path)
    try { expect(() => raw.prepare("UPDATE adoptions SET status='invalid' WHERE plan_id='one'").run()).toThrow()
      raw.prepare("UPDATE adoptions SET certificate_digest=? WHERE plan_id='one'").run(d('f'))
      expect(() => journal.inspect('one')).toThrow()
    } finally { raw.close() }
  } finally { journal.close() }
})

test('completed calls retain bounded result and expired receipts cannot dispatch', () => {
  const f = fixture(), journal = new CreationCapabilityJournal({ path: f.path, config: f.config })
  try {
    journal.claim({ certificate: f.certificate('one'), artifact: f.artifact })
    const receipt = journal.authorize('one', tools).receipt!
    journal.activate('one')
    journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') })
    expect(() => journal.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: 'x'.repeat(65537) })).toThrow()
    journal.settleCall({ planId: 'one', key: 'call-1', status: 'completed', result: { value: 'ok' }, jobId: 'job-one' })
    expect(journal.claimCall({ planId: 'one', key: 'call-1', argumentsDigest: d('a') }).call)
      .toEqual({ key: 'call-1', status: 'completed', result: { value: 'ok' }, jobId: 'job-one' })
    expect(() => journal.settleCall({ planId: 'one', key: 'call-1', status: 'unknown' })).toThrow()
    vi.spyOn(Date, 'now').mockReturnValue(receipt.expiresAt)
    expect(verifyCreationCapabilityReceipt(receipt, journal.authorityDigest, journal.publicKey)).toBe(false)
    expect(() => journal.claimCall({ planId: 'one', key: 'call-2', argumentsDigest: d('a') })).toThrow()
  } finally { journal.close() }
})
