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
import { inspectRevisionCapabilityBenefitWindow } from '../src/revision-capability-feedback.js'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'

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
      sourceBuild: { ...linuxSourceConfig(), stateRoot: join(f.dir, 'native-state'),
        expiresAt: f.base + 600_000, maxTotalDurationMs: 120_000, timeoutMs: 60_000,
        userNamespace: { schemaVersion: 1, ownerUid: process.getuid!(), ownerGid: process.getgid!(),
          candidateUid: process.getuid!() + 65536, candidateGid: process.getgid!() + 65536,
          hostNamespace: { dev: 1, ino: 7 }, helpers: { uid: { path: '/usr/bin/newuidmap', sha256: d('1') },
            gid: { path: '/usr/bin/newgidmap', sha256: d('2') } } },
        systemSnapshot: { schemaVersion: 1, root: { path: join(f.dir, 'system'), dev: 1, ino: 3, sha256: d('3') },
          manifestSha256: d('4'), bytes: 4096, entries: 16 } },
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
        maxCallRecords: 8, maxInputBytes: 1024, runner: { backend: 'linux-native' as const,
          runtime: { schemaVersion: 1 as const, runtime: { schemaVersion: 1 as const, backend: 'linux-native' as const,
            platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64',
            sourceCommit: '1'.repeat(40), lockSha256: d('e'), root: { path: join(f.dir, 'observer-runtime'), dev: 1, ino: 2, sha256: d('f') },
            nodePath: join(f.dir, 'observer-runtime/bin/node'), nodeSha256: 'a'.repeat(64),
            pnpmPath: join(f.dir, 'observer-runtime/pnpm/bin/pnpm.mjs'),
            nativePnpmPath: join(f.dir, 'observer-runtime/pnpm-native/pnpm'),
            nativePnpmRoot: join(f.dir, 'observer-runtime/pnpm-native'),
            modulesPath: join(f.dir, 'observer-runtime/node_modules'),
            storePath: join(f.dir, 'observer-runtime/store'), cachePath: join(f.dir, 'observer-runtime/cache'),
            versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
          observer: { schemaVersion: 1 as const, sourceSha256: 'b'.repeat(64), workerSha256: 'c'.repeat(64), candidateSha256: 'd'.repeat(64),
            launcherSha256: 'e'.repeat(64), parentProtectSha256: 'f'.repeat(64), childProtectSha256: '0'.repeat(64) } },
          cgroupRoots: { mode: 'v1' as const, cpu: `/sys/fs/cgroup/cpu/dsh-native/uid-${process.getuid!()}`,
            memory: `/sys/fs/cgroup/memory/dsh-native/uid-${process.getuid!()}`, pids: `/sys/fs/cgroup/pids/dsh-native/uid-${process.getuid!()}`,
            freezer: `/sys/fs/cgroup/freezer/dsh-native/uid-${process.getuid!()}` },
          stateRoot: f.dir, expiresAt: f.base + 300_000, maxRuns: 4, maxTotalDurationMs: 60_000,
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

describe('revision call foreground attribution and benefit evidence', () => {
  function committed() {
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
    const { signature: _signature, ...revisionUnsigned } = revisionCertificate
    const signedRevision = { ...revisionUnsigned, signature: sign(null, Buffer.from(canonicalGrowthJson(revisionUnsigned)),
      generateKeyPairSync('ed25519').privateKey).toString('base64url') } as PluginRevisionVerificationCertificate
    f.journal.claim({ planId: 'revision-plan', parentPlanId: 'parent-plan',
      certificateDigest: sha(canonicalGrowthJson(signedRevision)) })
    const adoptedAt = base + 100, expiresAt = Math.min(f.config.expiresAt, signedRevision.expiresAt)
    const entryId = 'entry-fixture'
    const adoptionReceipt = f.journal.signReceipt({ protocol: 'dsh-created-capability-revision-adoption/v1' as const,
      authorityId: f.config.authorityId, authorityDigest: f.journal.authorityDigest, keyId: f.config.keyId,
      planId: 'revision-plan', planDigest: signedRevision.plan.digest,
      verificationDigest: sha(canonicalGrowthJson(signedRevision)), parentPlanId: 'parent-plan',
      parentCertificateDigest: signedRevision.parent.certificateDigest, parentReceiptDigest: receipt.digest,
      parentArtifactSha256: signedRevision.parent.artifactSha256, entryId,
      aliasesDigest: hex(canonicalGrowthJson(tools.map(tool => tool.name))), artifactSha256: sha(artifact),
      artifactBytes: artifact.length, schemaDigest: signedRevision.schemaDigest, source: signedRevision.source,
      model: signedRevision.model, inFlightParentCalls: 0, expiresAt, adoptedAt })
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
    f.journal.commit({ entry: { entryId, name: 'rsi-revision-tool', aliases: tools.map(tool => tool.name) },
      parent: parentVersion, revision: revisionVersion, receipt: adoptionReceipt,
      expectedCurrentPlanId: 'parent-plan', inFlightParentCalls: 0 })
    return { f, entryId, adoptedAt, expiresAt }
  }
  function foreground(f: ReturnType<typeof committed>['f'], callId: string, inboxId = 'inbox-' + callId) {
    const sessionId = 'session-1', toolName = tools[0]!.name, argumentsText = '{"query":"hello"}'
    const argumentsDigest = sha(argumentsText)
    const key = sha(canonicalGrowthJson({ entryId: 'entry-fixture', sessionId, callId, toolName }))
    return { key, argumentsDigest, witness: { protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId,
        scope: { workspace: f.config.owner.workspace, preset: f.config.owner.agentPreset },
        owner: { principalRecordId: f.config.owner.principalRecordId, principalVersion: f.config.owner.principalVersion },
        binding: { id: 'binding-' + callId, version: 1, generation: 1 }, dispatchedAt: Date.now() - 10 },
      turn: 1, call: { id: callId, toolName, eventSeq: 1, eventDigest: d('1'), argumentsDigest } } }
  }
  test('records the exact foreground call witness and exposes it as benefit evidence', () => {
    const { f, entryId, adoptedAt } = committed()
    const call = foreground(f, 'call-one')
    f.journal.claimCall({ entryId, key: call.key, argumentsDigest: call.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: call.witness as never })
    f.journal.settleCall({ entryId, key: call.key, status: 'completed', result: { ok: true } })
    const evidence = f.journal.listCallEvidence(entryId)[0]!
    expect(evidence).toMatchObject({ attribution: 'foreground', role: 'revision', adoptedAt,
      artifactSha256: sha(Buffer.from('revision artifact')), schemaDigest: d('c') })
    expect(evidence.foreground).toEqual(call.witness)
    const benefit = f.journal.listBenefitCallEvidence('revision-plan')
    expect(benefit).toHaveLength(1)
    expect(benefit[0]).toMatchObject({ key: call.key, attribution: 'foreground', status: 'completed' })
    // Unattributed calls are retained but can never be benefit evidence rows.
    const plain = foreground(f, 'call-two')
    f.journal.claimCall({ entryId, key: plain.key, argumentsDigest: plain.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan' })
    expect(f.journal.listCallEvidence(entryId)[1]).toMatchObject({ key: plain.key, attribution: 'unattributed' })
    // A witness for another key/arguments is rejected at write time.
    const wrong = foreground(f, 'call-three')
    expect(() => f.journal.claimCall({ entryId, key: wrong.key, argumentsDigest: sha('other'),
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: wrong.witness as never })).toThrow()
    f.journal.close()
  })
  test('migrates a schema 1 call row without inventing foreground attribution', () => {
    const { f, entryId } = committed()
    const call = foreground(f, 'legacy-call')
    f.journal.claimCall({ entryId, key: call.key, argumentsDigest: call.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: call.witness as never })
    f.journal.settleCall({ entryId, key: call.key, status: 'completed', result: { ok: true } })
    f.journal.close()
    const raw = new DatabaseSync(f.path)
    try {
      raw.exec(`BEGIN IMMEDIATE;
        ALTER TABLE calls RENAME TO calls_v2;
        CREATE TABLE calls (entry_id TEXT NOT NULL REFERENCES entries(entry_id), call_key TEXT NOT NULL, version_plan_id TEXT NOT NULL,
          tool_alias TEXT NOT NULL, arguments_digest TEXT NOT NULL CHECK(length(arguments_digest)=64),
          status TEXT NOT NULL CHECK(status IN ('claimed','completed','unknown')),
          result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND length(result_json)<=65536)),
          claimed_at INTEGER NOT NULL, settled_at INTEGER, PRIMARY KEY(entry_id, call_key),
          CHECK((status='claimed' AND result_json IS NULL AND settled_at IS NULL) OR status IN ('completed','unknown'))) STRICT, WITHOUT ROWID;
        INSERT INTO calls (entry_id, call_key, version_plan_id, tool_alias, arguments_digest, status, result_json, claimed_at, settled_at)
          SELECT entry_id, call_key, version_plan_id, tool_alias, arguments_digest, status, result_json, claimed_at, settled_at FROM calls_v2;
        DROP TABLE calls_v2;
        PRAGMA user_version=1;
        COMMIT;`)
    } finally { raw.close() }
    const reopened = new RevisionCapabilityJournal({ path: f.path, config: f.config })
    expect(reopened.listCallEvidence(entryId)[0]).toMatchObject({ key: call.key, attribution: 'unattributed' })
    expect(reopened.listBenefitCallEvidence('revision-plan')[0]?.foreground).toBeUndefined()
    const next = foreground(f, 'post-migration')
    reopened.claimCall({ entryId, key: next.key, argumentsDigest: next.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: next.witness as never })
    expect(reopened.listCallEvidence(entryId).find(item => item.key === next.key)).toMatchObject({ attribution: 'foreground' })
    reopened.close()
  })

  test('real foreground call rows produce one candidate window', async () => {
    const { f, entryId } = committed()
    await new Promise(resolve => setTimeout(resolve, 150))
    const argumentsText = '{"query":"hello"}'
    const call = (callId: string, inboxId: string) => {
      const sessionId = 'session-1', toolName = tools[0]!.name
      const argumentsDigest = sha(argumentsText)
      const key = sha(canonicalGrowthJson({ entryId, sessionId, callId, toolName }))
      const foreground = { protocol: 'assistant-delivery/foreground-tool-call/v1',
        task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId, sessionId,
          scope: { workspace: f.config.owner.workspace, preset: f.config.owner.agentPreset },
          owner: { principalRecordId: f.config.owner.principalRecordId, principalVersion: f.config.owner.principalVersion },
          binding: { id: 'binding-' + callId, version: 1, generation: 1 }, dispatchedAt: Date.now() - 5 },
        turn: 1, call: { id: callId, toolName, eventSeq: 1, eventDigest: d('1'), argumentsDigest } }
      return { key, argumentsDigest, inboxId, callId, foreground }
    }
    const first = call('call-one', 'inbox-one'), second = call('call-two', 'inbox-two')
    for (const item of [first, second]) {
      f.journal.claimCall({ entryId, key: item.key, argumentsDigest: item.argumentsDigest,
        toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: item.foreground as never })
      f.journal.settleCall({ entryId, key: item.key, status: 'completed', result: { ok: true } })
    }
    const version = f.journal.inspectVersion('revision-plan')!
    const calls = f.journal.listBenefitCallEvidence('revision-plan')
    expect(calls).toHaveLength(2)
    const learning = (inboxId: string) => {
      const item = calls.find(entry => entry.foreground?.task.inboxId === inboxId)!.foreground!
      return { protocol: 'assistant-delivery/owner-foreground-learning/v1' as const,
        owner: { ...f.config.owner, bindingVersion: 1, generation: 1 },
        canonical: { scope: { workspace: f.config.owner.workspace, preset: f.config.owner.agentPreset },
          scopeKey: 'scope', scopeWatermark: 1, triggerOutcomeId: 'outcome-' + inboxId,
          situation: 'foreground:task', objective: { outcomeId: 'objective-' + inboxId, status: 'achieved' as const,
            source: { kind: 'evaluator' as const, id: 'assistant-verifier' },
            evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: Date.now() },
          projection: { subjectKind: 'foreground-turn' as const, subjectRef: inboxId, version: 1,
            digest: d('4'), disposition: 'upsert' as const } },
        judgement: 'independent-verifier' as const,
        source: { sessionId: item.task.sessionId, inboxId, objective: 'ordinary task', quiescent: true,
          truncated: false, modelSelectionState: 'frozen' as const, modelSelection: { provider: 'supplier', model: 'task-model' } } }
    }
    const heads = new Map(calls.map(entry => [entry.foreground!.task.inboxId,
      learning(entry.foreground!.task.inboxId)]))
    const evaluation = {
      canonicalHostScope: (input: unknown) => input,
      getTrustedForegroundLearningProjection: (input: { inboxId: string }) => heads.get(input.inboxId)?.canonical,
      withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }),
      inspectTrustedOutcomeMetrics: () => ({ inputTokens: 10, outputTokens: 5 }),
    }
    const delivery = {
      inspectOwnerForegroundLearningTask: (input: { outcomeId: string }) =>
        [...heads.values()].find(item => item.canonical.triggerOutcomeId === input.outcomeId),
      inspectOwnerForegroundTaskSource: (input: { inboxId: string }) => {
        const item = calls.find(entry => entry.foreground?.task.inboxId === input.inboxId)
        if (item === undefined) return undefined
        return { authorityId: f.config.owner.authorityId, authorityHash: f.config.owner.authorityHash,
          principalId: f.config.owner.principalId,
          owner: { principalRecordId: f.config.owner.principalRecordId, principalVersion: f.config.owner.principalVersion },
          binding: { id: item.foreground!.task.binding.id, version: 1, generation: 1,
            sessionId: item.foreground!.task.sessionId },
          execution: { quiescent: true, dispatchedAt: Date.now() - 1_000, completedAt: Date.now() } }
      },
    }
    const sample = { version: { planId: version.planId, entryId: version.entryId, role: version.role,
      name: version.name, adoptedAt: version.adoptedAt, expiresAt: version.expiresAt,
      receiptDigest: version.receiptDigest, artifactSha256: version.artifactSha256,
      schemaDigest: version.schemaDigest, tools: version.tools }, calls }
    const stats = inspectRevisionCapabilityBenefitWindow({ sample, windowStart: version.adoptedAt,
      windowEnd: Date.now() + 1_000, owner: f.config.owner, evaluation: evaluation as never,
      delivery: delivery as never })!
    expect(stats).toMatchObject({ artifactSha256: version.artifactSha256, taskRevisions: 2,
      failed: 0, correctedOrWithdrawn: 0 })
    expect(stats.latencyMsTotal).toBeGreaterThan(0)
    expect(stats.tokensTotal).toBe(30)
    f.journal.close()
  })

  test('re-claiming the identical witness is byte-stable and a tampered row fails closed', () => {
    const { f, entryId } = committed()
    const call = foreground(f, 'stable-call')
    const first = f.journal.claimCall({ entryId, key: call.key, argumentsDigest: call.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: call.witness as never })
    expect(first.created).toBe(true)
    const again = f.journal.claimCall({ entryId, key: call.key, argumentsDigest: call.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan', foreground: call.witness as never })
    expect(again).toEqual({ created: false, call: first.call })
    expect(() => f.journal.claimCall({ entryId, key: call.key, argumentsDigest: call.argumentsDigest,
      toolAlias: tools[0]!.name, versionPlanId: 'revision-plan' })).toThrow()
    f.journal.close()
    const raw = new DatabaseSync(f.path)
    try {
      raw.exec("UPDATE calls SET foreground_json=json_set(foreground_json,'$.task.sessionId','other-session')")
    } finally { raw.close() }
    const reopened = new RevisionCapabilityJournal({ path: f.path, config: f.config })
    expect(() => reopened.listCallEvidence(entryId)).toThrow()
    reopened.close()
  })

  test('fails closed when a schema 2 journal carries an unknown extra call column', () => {
    const { f } = committed()
    f.journal.close()
    const raw = new DatabaseSync(f.path)
    try { raw.exec('ALTER TABLE calls ADD COLUMN extra_evidence TEXT') } finally { raw.close() }
    expect(() => new RevisionCapabilityJournal({ path: f.path, config: f.config })).toThrow()
  })
})
