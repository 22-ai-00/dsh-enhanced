import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { canonicalGrowthJson, type PluginCreationVerificationCertificate,
  type PluginRevisionVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { normalizeControlPlaneConfig, type Config } from '../src/index.js'
import { RevisionCapabilityJournal, revisionCapabilityPublicKey, validateRevisionCapabilityConfig,
  verifyRevisionCapabilityAdoptionReceipt } from '../src/revision-capability-journal.js'
import type { RevisionCapabilityConfig } from '../src/revision-capability-types.js'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const hex = (value: string) => createHash('sha256').update(value).digest('hex')
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const d = (value: string) => value.repeat(64)

function root(): string {
  const value = mkdtempSync(join(realpathSync(tmpdir()), 'cp-revision-capability-'))
  roots.push(value); chmodSync(value, 0o700)
  return value
}
function privateKeyFile(dir: string, name: string): { path: string; publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const pair = generateKeyPairSync('ed25519')
  const path = join(dir, name)
  writeFileSync(path, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  return { path, publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(), privateKey: pair.privateKey }
}
function ownerOf(root: string, preset = 'primary') {
  return { authorityId: 'owner-route', authorityHash: d('a'), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: preset }
}
function configOf(root: string, keyPath: string, overrides: Partial<RevisionCapabilityConfig> = {}): RevisionCapabilityConfig {
  const now = Date.now()
  return { authorityId: 'owner-revision', keyId: 'revision-key', keyPath, owner: ownerOf(root),
    namePrefix: 'rsi-revision-', expiresAt: now + 120_000, maxAdoptions: 2, maxInputBytes: 4096,
    maxCallRecords: 8, rollback: { authorityId: 'owner-revision-rollback', expiresAt: now + 120_000,
      maxRollbacks: 2 }, ...overrides }
}
function creationCertificate(planId: string, name: string, artifact: Buffer, schemaDigest: string,
  environment: PluginCreationVerificationCertificate['environment'], base = Date.now()): PluginCreationVerificationCertificate {
  const signer = generateKeyPairSync('ed25519')
  const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'verification-' + planId,
    authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1', authorityId: 'creation-review',
      keyId: 'creation-review-key', authorityDigest: d('b'), namePrefix: 'rsi-revision-', expiresAt: base + 300_000 },
    plan: { id: planId, digest: d('c'), name, sourceTreeDigest: d('d'), sourcePatchDigest: d('e'),
      artifactSha256: sha(artifact), artifactBytes: artifact.length, generatorDigest: d('f') },
    source: { referenceDigest: d('1'), ownerDigest: d('2'), growthRunDigest: d('3') },
    contractDigest: d('4'), schemaDigest, environment,
    model: { provider: 'fixture', model: 'fixture' },
    budget: { modelCalls: 2, maxOutputTokens: 1_024, maxDurationMs: 10_000, maxCases: 2 },
    sessions: { contract: 'contract-' + planId, sourceReview: 'review-' + planId },
    observations: [{ caseId: 'case-a', jobId: 'job-a-' + planId, operationDigest: d('5'), observationDigest: d('6') },
      { caseId: 'case-b', jobId: 'job-b-' + planId, operationDigest: d('7'), observationDigest: d('8') }],
    reviewDigest: d('9'), verifiedAt: base - 1_000, expiresAt: base + 120_000,
  }
  return { ...unsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(unsigned)), signer.privateKey).toString('base64url') }
}
function parentReceipt(certificate: PluginCreationVerificationCertificate, artifact: Buffer, base = Date.now()): { json: string; digest: string } {
  const unsigned = { protocol: 'dsh-created-capability-adoption/v1', authorityId: 'owner-creation',
    authorityDigest: d('a'), keyId: 'creation-key', planId: certificate.plan.id, planDigest: certificate.plan.digest,
    verificationDigest: sha(canonicalGrowthJson(certificate)), artifactSha256: sha(artifact), artifactBytes: artifact.length,
    source: certificate.source, schemaDigest: certificate.schemaDigest, toolsDigest: d('b'),
    expiresAt: base + 120_000, adoptedAt: base - 500 }
  const json = canonicalGrowthJson({ ...unsigned, signature: 'A'.repeat(86) })
  return { json, digest: sha(json) }
}
const tools = [{ originalName: 'read_test', name: 'evolved_rsi_revision_0', description: 'fixture', parameters: {
  type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] } }]

function setup(overrides: Partial<RevisionCapabilityConfig> = {}) {
  const dir = root(), key = privateKeyFile(dir, 'revision.key')
  const config = configOf(dir, key.path, overrides)
  const journal = new RevisionCapabilityJournal({ path: join(dir, 'revision-adoptions.sqlite'), config })
  return { dir, key, config, journal, path: join(dir, 'revision-adoptions.sqlite') }
}

describe('revision capability journal', () => {
  test('claims once, commits the parent and revision versions under one entry CAS and signs the receipt', () => {
    const f = setup()
    const base = Date.now(), environment = { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' }
    const parentArtifact = Buffer.from('parent artifact'), artifact = Buffer.from('revision artifact')
    const parentCertificate = creationCertificate('parent-plan', 'rsi-revision-tool', parentArtifact, d('c'), environment, base)
    const receipt = parentReceipt(parentCertificate, parentArtifact, base)
    const revisionCertificate = { ...creationCertificate('revision-plan', 'rsi-revision-tool', artifact, d('c'), environment, base),
      protocol: 'assistant-growth/revision-verification/v1' as const,
      authority: { protocol: 'assistant-growth/revision-acceptance-authority/v1' as const, authorityId: 'revision-review',
        keyId: 'revision-review-key', authorityDigest: d('e'), namePrefix: 'rsi-revision-', expiresAt: base + 200_000 },
      parent: { planId: 'parent-plan', certificateDigest: sha(canonicalGrowthJson(parentCertificate)),
        artifactSha256: sha(parentArtifact), sourceArchiveDigest: d('f'), sourceDigest: d('0') } }
    // The revision verifier signs the revision certificate; only its shape is journal-validated here.
    const { signature: _signature, ...revisionUnsigned } = revisionCertificate
    const signedRevision = { ...revisionUnsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(revisionUnsigned)),
      generateKeyPairSync('ed25519').privateKey).toString('base64url') } as PluginRevisionVerificationCertificate
    expect(() => validateRevisionCapabilityConfig(f.config)).not.toThrow()
    const claim = f.journal.claim({ planId: 'revision-plan', parentPlanId: 'parent-plan',
      certificateDigest: sha(canonicalGrowthJson(signedRevision)) })
    expect(claim.created).toBe(true)
    expect(f.journal.usage().adoptions).toBe(1)
    const adoptedAt = base + 100, expiresAt = Math.min(f.config.expiresAt, signedRevision.expiresAt)
    const entryId = 'entry-fixture'
    const receiptBody = { protocol: 'dsh-created-capability-revision-adoption/v1' as const,
      authorityId: f.config.authorityId, authorityDigest: f.journal.authorityDigest, keyId: f.config.keyId,
      planId: 'revision-plan', planDigest: signedRevision.plan.digest,
      verificationDigest: sha(canonicalGrowthJson(signedRevision)), parentPlanId: 'parent-plan',
      parentCertificateDigest: signedRevision.parent.certificateDigest, parentReceiptDigest: receipt.digest,
      parentArtifactSha256: signedRevision.parent.artifactSha256, entryId, aliasesDigest: hex(canonicalGrowthJson(tools.map(tool => tool.name))),
      artifactSha256: sha(artifact), artifactBytes: artifact.length, schemaDigest: signedRevision.schemaDigest,
      source: signedRevision.source, model: signedRevision.model,
      inFlightParentCalls: 2, expiresAt, adoptedAt }
    const adoptionReceipt = f.journal.signReceipt(receiptBody)
    expect(verifyRevisionCapabilityAdoptionReceipt(adoptionReceipt, f.journal.authorityDigest,
      f.journal.publicKey, adoptedAt)).toBe(true)
    const parentVersion = { planId: 'parent-plan', entryId, role: 'parent' as const, name: 'rsi-revision-tool',
      certificate: parentCertificate, certificateDigest: sha(canonicalGrowthJson(parentCertificate)),
      receiptJson: receipt.json, receiptDigest: receipt.digest, tools, artifact: parentArtifact,
      artifactSha256: sha(parentArtifact), schemaDigest: parentCertificate.schemaDigest,
      source: parentCertificate.source, model: parentCertificate.model, adoptedAt: base - 500, expiresAt: base + 120_000 }
    const revisionVersion = { planId: 'revision-plan', entryId, role: 'revision' as const, name: 'rsi-revision-tool',
      certificate: signedRevision, certificateDigest: sha(canonicalGrowthJson(signedRevision)),
      receiptJson: canonicalGrowthJson(adoptionReceipt), receiptDigest: sha(canonicalGrowthJson(adoptionReceipt)),
      tools, artifact, artifactSha256: sha(artifact), schemaDigest: signedRevision.schemaDigest,
      source: signedRevision.source, model: signedRevision.model, adoptedAt, expiresAt }
    const committed = f.journal.commit({ entry: { entryId, name: 'rsi-revision-tool',
      aliases: tools.map(tool => tool.name) }, parent: parentVersion, revision: revisionVersion,
      receipt: adoptionReceipt, expectedCurrentPlanId: 'parent-plan', inFlightParentCalls: 2 })
    expect(committed).toMatchObject({ status: 'active', entryId, inFlightParentCalls: 2, parentPlanId: 'parent-plan' })
    const entry = f.journal.inspectEntry(entryId)!
    expect(entry.entry).toMatchObject({ currentPlanId: 'revision-plan', parentPlanId: 'parent-plan', revision: 2 })
    expect(f.journal.inspectVersion('revision-plan')!.receiptDigest).toBe(sha(canonicalGrowthJson(adoptionReceipt)))
    // Parent CAS: a second commit for the same entry from the parent version is refused and nothing changes.
    const other = { ...revisionVersion, planId: 'revision-plan-b', certificate: signedRevision,
      receiptJson: canonicalGrowthJson({ ...adoptionReceipt, planId: 'revision-plan-b' }) }
    expect(() => f.journal.commit({ entry: { entryId, name: 'rsi-revision-tool', aliases: tools.map(tool => tool.name) },
      parent: parentVersion, revision: other, receipt: adoptionReceipt, expectedCurrentPlanId: 'parent-plan', inFlightParentCalls: 2 })).toThrow()
    expect(f.journal.inspectEntry(entryId)!.entry.currentPlanId).toBe('revision-plan')
    // Exact parent rollback restores the retained parent receipt and records one append-only event.
    const rollback = f.journal.rollback({ entryId, expectedCurrentPlanId: 'revision-plan', authorityId: f.config.rollback.authorityId })
    expect(rollback.created).toBe(true)
    expect(rollback.record).toMatchObject({ fromPlanId: 'revision-plan', toPlanId: 'parent-plan',
      parentReceiptDigest: receipt.digest, ordinal: 1 })
    expect(f.journal.inspectEntry(entryId)!.entry.currentPlanId).toBe('parent-plan')
    expect(f.journal.rollback({ entryId, expectedCurrentPlanId: 'revision-plan', authorityId: f.config.rollback.authorityId }).created).toBe(false)
    expect(f.journal.usage()).toMatchObject({ adoptions: 1, rollbacks: 1 })
    f.journal.close()
  })

  test('reopens the same ledger only under the identical authority and fails closed on schema or grant drift', () => {
    const f = setup()
    f.journal.close()
    const reopen = (config = f.config) => new RevisionCapabilityJournal({ path: f.path, config })
    const reopened = reopen()
    expect(reopened.usage().adoptions).toBe(0)
    reopened.close()
    expect(() => reopen({ ...f.config, maxAdoptions: 3 })).toThrow()
    const raw = new DatabaseSync(f.path)
    raw.exec('PRAGMA application_id=1; PRAGMA user_version=9;')
    raw.close()
    expect(() => reopen()).toThrow()
  })

  test('rejects a foreign signing key and a non-private key file during preflight', () => {
    const dir = root(), key = privateKeyFile(dir, 'revision.key')
    const config = configOf(dir, key.path)
    expect(revisionCapabilityPublicKey(config)).toContain('BEGIN PUBLIC KEY')
    chmodSync(key.path, 0o644)
    expect(() => validateRevisionCapabilityConfig(config)).toThrow()
  })
})

describe('revision adoption configuration', () => {
  function configFixture() {
    const dir = root(), base = Date.now()
    const creationKey = privateKeyFile(dir, 'creation.key'), revisionKey = privateKeyFile(dir, 'revision.key')
    const verifier = generateKeyPairSync('ed25519')
    const repository = dir
    const namePrefix = 'rsi-service-'
    return { dir, base, creationKey, revisionKey, verifier, repository, namePrefix,
      publicKey: verifier.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      creationPublicKey: creationKey.publicKey }
  }
  function configOf(f: ReturnType<typeof configFixture>, overrides: { revision?: Record<string, unknown> } = {}): Config {
    const namePrefix = f.namePrefix
    const owner = { ...ownerOf(f.dir), authorityId: 'route', principalId: 'owner', principalRecordId: 'record',
      principalVersion: 1, workspace: f.dir, agentPreset: 'primary' }
    return { catalogPath: join(f.dir, 'catalog.json'), trustPath: join(f.dir, 'trust.json'), statePath: join(f.dir, 'state'),
      sourceBuild: { dockerPath: '/usr/bin/docker', image: 'fixture@sha256:' + d('a'), timeoutMs: 60_000, memoryMiB: 128,
        cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
      sourceJobs: { authorityId: 'source-grant', expiresAt: f.base + 600_000, maxSubmissions: 2, repository: f.repository,
        ownerRouteId: owner.authorityId, principalId: 'owner', workspace: f.dir, preset: 'primary',
        budgetId: 'source-budget', budgetAmount: 1, allowedModes: ['create', 'revise-created'],
        creation: { id: 'owner-create', expiresAt: f.base + 500_000, maxCreates: 2, namePrefix },
        revision: { id: 'owner-revise', expiresAt: f.base + 500_000, maxRevisions: 2, namePrefix } } as never,
      creationVerifications: { authority: { protocol: 'assistant-growth/creation-acceptance-authority/v1',
        authorityId: 'creation-review', keyId: 'creation-review-key', authorityDigest: d('b'), namePrefix,
        expiresAt: f.base + 400_000 }, publicKey: f.publicKey },
      creationCapabilities: { authorityId: 'owner-creation', keyId: 'creation-key', keyPath: f.creationKey.path,
        owner, namePrefix, expiresAt: f.base + 300_000, maxAdoptions: 2, maxTools: 2, maxCallsPerAdoption: 4,
        maxCallRecords: 8, maxInputBytes: 1024, runner: { stateRoot: f.dir, image: 'runner@sha256:' + d('b'),
          dockerPath: '/usr/bin/docker', expiresAt: f.base + 300_000, maxRuns: 4, maxTotalDurationMs: 60_000,
          maxDurationMs: 30_000, maxOutputBytes: 65_536 } },
      revisionVerifications: { authority: { protocol: 'assistant-growth/revision-acceptance-authority/v1',
        authorityId: 'revision-review', keyId: 'revision-review-key', authorityDigest: d('c'), namePrefix,
        expiresAt: f.base + 200_000 }, publicKey: f.publicKey },
      revisionCapabilities: { authorityId: 'owner-revision', keyId: 'revision-key', keyPath: f.revisionKey.path,
        owner, namePrefix, expiresAt: f.base + 200_000, maxAdoptions: 2, maxInputBytes: 1024, maxCallRecords: 8,
        rollback: { authorityId: 'owner-revision-rollback', expiresAt: f.base + 200_000, maxRollbacks: 2 },
        ...overrides.revision } }
  }
  test('normalizes a complete finite revision adoption grant and leaves an unconfigured deployment unchanged', () => {
    const f = configFixture()
    const config = configOf(f)
    const normalized = normalizeControlPlaneConfig(config)
    expect(normalized.revisionCapabilities).toMatchObject({ authorityId: 'owner-revision',
      rollback: { authorityId: 'owner-revision-rollback', maxRollbacks: 2 } })
    const { revisionCapabilities: _omit, ...without } = config
    expect(normalizeControlPlaneConfig(without).revisionCapabilities).toBeUndefined()
  })
  test('rejects a revision adoption authority or signing key reused from acceptance, creation or rollback', () => {
    const f = configFixture()
    expect(() => normalizeControlPlaneConfig(configOf(f, { revision: { keyPath: f.creationKey.path, keyId: 'creation-key' } })))
      .toThrow('signing key must differ from acceptance and creation keys')
    expect(() => normalizeControlPlaneConfig(configOf(f, { revision: { authorityId: 'owner-creation',
      keyId: 'creation-key', keyPath: f.creationKey.path } })))
      .toThrow(/separate/)
    expect(() => normalizeControlPlaneConfig(configOf(f, { revision: { keyId: 'revision-review-key' } })))
      .toThrow('signing key must differ from acceptance and creation keys')
    expect(() => normalizeControlPlaneConfig(configOf(f, { revision: { rollback: { authorityId: 'owner-revision',
      expiresAt: f.base + 100_000, maxRollbacks: 1 } } })))
      .toThrow(/separate/)
    expect(() => normalizeControlPlaneConfig(configOf(f, { revision: { expiresAt: f.base + 400_000 } })))
      .toThrow('does not match its authenticated creation lane')
  })
  test('requires creation capabilities, revision verification and the finite revision source lane', () => {
    const f = configFixture()
    const config = configOf(f)
    const { creationCapabilities: _creation, ...withoutCreation } = config
    expect(() => normalizeControlPlaneConfig(withoutCreation))
      .toThrow('revision verification requires its separate finite grant')
    const { revisionVerifications: _verification, ...withoutVerification } = config
    const { revision: _revision, ...withoutRevisionLane } = config.sourceJobs as unknown as Record<string, unknown>
    expect(() => normalizeControlPlaneConfig({ ...withoutVerification,
      sourceJobs: withoutRevisionLane as never }))
      .toThrow('revision adoption requires creation capabilities')
  })
})
