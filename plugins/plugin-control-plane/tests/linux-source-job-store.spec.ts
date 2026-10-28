import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { pluginCreationVerificationSigningPayload, sourceGrowthRunDigest,
  type CreationAcceptanceAuthorityRef, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { ControlPlaneStore, MODIFY_GENERATOR_DIGEST, controlPlaneDigest } from '../src/store.ts'
import type { SourceBuildConfig } from '../src/source-build.ts'
import type { SourceJobIntent } from '../src/source-job-types.ts'
import type { LinuxSourcePreparedEvidence, PluginSourcePlan, SourcePreparedEvidence } from '../src/types.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'
import { sourceGrowthRunFixture } from './helpers/source-growth-run-fixture.ts'

// These are ledger/admission fixtures. They do not claim real repository execution.
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const hex = (value: string) => createHash('sha256').update(value).digest('hex')
const now = 1_800_000_000_000
const bytes = Buffer.from([0, 255, 128, 10])
const id = `source-job-${'d'.repeat(64)}`
type Backend = 'docker' | 'macos-seatbelt' | 'linux-native'
const signing = generateKeyPairSync('ed25519')
const creationAcceptance: CreationAcceptanceAuthorityRef = { protocol: 'assistant-growth/creation-acceptance-authority/v1',
  authorityId: 'creation-verifier', keyId: 'creation-key', authorityDigest: hex('verifier'), namePrefix: 'agent-', expiresAt: now + 60_000 }

function build(backend: Backend): SourceBuildConfig {
  if (backend === 'linux-native') return { ...linuxSourceConfig(), expiresAt: now + 600_000 }
  if (backend === 'docker') return { dockerPath: '/usr/bin/docker', image: `example@sha256:${hex('image')}`,
    timeoutMs: 60_000, memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 }
  return { backend, runtime: { schemaVersion: 1, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
    nodePath: '/private/node/bin/node', nodeSha256: hex('node'), modulesPath: '/private/modules',
    roots: [{ path: '/private/node', dev: 1, ino: 2, sha256: hex('root') }, { path: '/private/modules', dev: 1, ino: 3, sha256: hex('modules') }],
    versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '4.0.4', tools: '0.2.0-rc.2', systemPrompt: '0.2.0-rc.2' } },
  stateRoot: '/private/state', authorityDigest: hex('authority'), expiresAt: now + 600_000,
  maxRuns: 2, maxTotalDurationMs: 120_000, timeoutMs: 60_000, outputBytes: 4096 }
}

function linuxEvidence(): LinuxSourcePreparedEvidence {
  return { schemaVersion: 3, kind: 'dsh-source-prepared-evidence', boundary: 'linux-native-repository-v1',
    runtimeDigest: hex('runtime'), executionContractDigest: hex('contract'), buildScriptSha256: hex('script'),
    archive: { sizeBytes: 10240, sha256: hex('archive') },
    receipt: { requestDigest: hex('request'), nativeNonce: 'b'.repeat(32), nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111',
      intentDigest: hex('intent'), resourcesDigest: hex('resources'), receiptDigest: hex('receipt') },
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.23.2', pnpmVersion: '11.7.0' },
    checks: ['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'],
    pack: { name: 'agent-helper.tgz', version: '1.0.0', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
    logDigest: hex('logs'), durationMs: 1, preparedAt: now + 1 }
}
function evidence(schema: 1 | 2 | 3): SourcePreparedEvidence {
  const linux = linuxEvidence(), pack = { ...linux.pack, sha256: createHash('sha256').update(bytes).digest('hex') }
  if (schema === 3) return { ...linux, pack }
  if (schema === 2) return { schemaVersion: 2, kind: linux.kind, boundary: 'macos-seatbelt-single-process-v1',
    runtimeDigest: hex('runtime'), fixedCompilerSha256: hex('compiler'), checks: ['semantic-typecheck', 'js-declaration-emit', 'host-safe-pack'], pack, preparedAt: now + 1 }
  return { schemaVersion: 1, kind: linux.kind, environment: linux.environment,
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: hex('logs') }], pack, preparedAt: now + 1 }
}

async function fixture(backend: Backend = 'linux-native', mode: 'modify' | 'create' | 'revise-created' = 'create', withVerification = false) {
  const root = await mkdtemp(join(tmpdir(), 'linux-source-job-store-')); roots.push(root)
  const path = join(root, 'state.sqlite'), store = new ControlPlaneStore({ path, now: () => now })
  const owner = { receiptVersion: 2 as const, authorityId: 'owner-route', authorityHash: hex('owner'), principalId: 'owner',
    principalRecordId: 'owner-record', principalVersion: 1, workspace: '/workspace', agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const gap = store.recordOwnerTaskFailureGap({ schemaVersion: 1, owner, outcomeId: 'owner-outcome', sourceDigest: hex('source'),
    projection: { subjectKind: 'foreground-turn', subjectRef: 'owner-inbox', version: 1, digest: hex('projection'), disposition: 'upsert' } })
  const run = sourceGrowthRunFixture(store.getOwnerTaskFailureReference(gap.id)!, now)
  if (withVerification) run.creationAcceptance = creationAcceptance
  const generatorDigest = mode === 'modify' ? MODIFY_GENERATOR_DIGEST : hex('generator')
  const creation = { grant: { id: 'owner-create', namePrefix: 'agent-', maxCreates: 1, expiresAt: now + 60_000 }, generatorDigest, growthRun: run }
  const revision = { grant: { id: 'owner-revise', namePrefix: 'agent-', maxRevisions: 1, expiresAt: now + 60_000 }, generatorDigest,
    parent: { planId: 'source-parent', certificateDigest: hex('certificate'), artifactSha256: hex('artifact'), sourceArchiveDigest: hex('source-archive'), sourceDigest: hex('parent-source') },
    growthRun: { ...run, revisionAcceptance: { protocol: 'assistant-growth/revision-acceptance-authority/v1' as const,
      authorityId: 'revision-verifier', keyId: 'key', authorityDigest: hex('verifier'), namePrefix: 'agent-', expiresAt: now + 60_000 } } }
  const source: SourceJobIntent = { authority: { id: 'source-authority', digest: hex('authority'), expiresAt: now + 60_000, maxSubmissions: 2 },
    owner, ownerDigest: controlPlaneDigest(owner), trustDigest: hex('trust'), repository: '/repository', name: 'agent-helper',
    gapId: gap.id, gapRevision: gap.revision, gapDigest: controlPlaneDigest(gap), baseCommit: 'a'.repeat(40),
    files: [{ path: 'src/index.ts', content: 'export {}\n' }], ttlMs: 60_000, build: build(backend),
    worktree: `/worktree/worktree-job-${'d'.repeat(64)}`,
    ...(backend === 'docker' ? { containerName: `dsh-${id}` } : { nativeResource: { backend, key: id } }),
    ...(mode === 'create' ? { mode, creation } : mode === 'revise-created' ? { mode, revision } : {}) }
  const fence = <T>(callback: () => T) => store.withOwnerTaskFailureGapAdmission(gap.id, callback)
  const enqueue = (intent = source) => fence(() => store.enqueueSourceJob({ id, automationId: id, idempotencyKey: 'linux:job', intent }))
  const claim = () => { const queued = enqueue(); const bound = store.bindSourceJobDefinition({ id, revision: queued.revision, definitionHash: hex('definition') });
    return fence(() => store.claimSourceJob({ id, revision: bound.revision, definitionHash: hex('definition'), occurrenceId: 'occurrence' })) }
  const completion = (schema: 1 | 2 | 3 = 3) => { const running = claim(); return { gapId: gap.id, name: source.name,
    repository: source.repository, worktree: source.worktree, baseCommit: source.baseCommit, generatorDigest,
    scope: mode === 'modify' ? ['plugins/agent-helper'] : ['plugins/agent-helper', 'plugins/README.md', 'pnpm-lock.yaml'],
    mode: mode === 'modify' ? 'modify' as const : mode === 'create' ? 'prepared-create' as const : 'prepared-revise' as const,
    ...(mode === 'create' ? { creation } : mode === 'revise-created' ? { revision } : {}), ttlMs: source.ttlMs, idempotencyKey: 'linux:plan',
    sourceJob: { jobId: id, jobRevision: running.revision, occurrenceId: 'occurrence' },
    prepared: { treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: now + 1, evidence: evidence(schema) } } }
  return { path, store, source, enqueue, claim, completion, fence }
}

function signedCertificate(f: Awaited<ReturnType<typeof fixture>>, plan: PluginSourcePlan,
  version: 1 | 2 | 3): PluginCreationVerificationCertificate {
  const reference = f.store.getOwnerTaskFailureReference(plan.gapId)!, prepared = plan.preparedEvidence!
  const body: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: `assistant-growth/creation-verification/v${version}`, verificationId: 'fixture-verification', authority: creationAcceptance,
    plan: { id: plan.id, digest: plan.digest, name: plan.name, sourceTreeDigest: plan.sourceCheck!.treeDigest,
      sourcePatchDigest: plan.sourceCheck!.patchDigest, artifactSha256: prepared.pack.sha256,
      artifactBytes: prepared.pack.sizeBytes, generatorDigest: plan.generatorDigest },
    source: { referenceDigest: controlPlaneDigest(reference), ownerDigest: controlPlaneDigest(reference.owner),
      growthRunDigest: sourceGrowthRunDigest(plan.creation!.growthRun!) },
    contractDigest: hex('contract'), schemaDigest: hex('schema'),
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
    model: plan.creation!.growthRun!.model,
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 30_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: ['one', 'two'].map(caseId => ({ caseId, jobId: `job-${caseId}`,
      operationDigest: hex(`operation-${caseId}`), observationDigest: hex(`observation-${caseId}`) })),
    reviewDigest: hex('review'), verifiedAt: now, expiresAt: now + 30_000,
    ...(version === 1 ? {} : { execution: version === 2
      ? { boundary: 'macos-seatbelt-single-process-v1' as const, runtimeDigest: hex('runtime'), buildEvidenceDigest: controlPlaneDigest(prepared) }
      : { boundary: 'linux-native-process-seccomp-v1' as const, runtimeDigest: hex('behavior-runtime'), buildRuntimeDigest: hex('runtime'),
        buildEvidenceDigest: controlPlaneDigest(prepared), observerPreparationDigest: hex('observer-preparation') } }),
  }
  return { ...body, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(body)), signing.privateKey).toString('base64url') }
}

function persistCertificate(database: DatabaseSync, certificate: PluginCreationVerificationCertificate): void {
  // Recompute the outer digest so reads must check the prepared binding itself.
  database.prepare(`UPDATE source_creation_verifications SET status='verified',certificate_json=?,certificate_digest=? WHERE plan_id=?`)
    .run(JSON.stringify(certificate), controlPlaneDigest(certificate), certificate.plan.id)
}

describe('creation verification exact prepared execution binding', () => {
  const matrix = (['docker', 'macos-seatbelt', 'linux-native'] as const).flatMap((backend, index) =>
    ([1, 2, 3] as const).map(version => [backend, index + 1 as 1 | 2 | 3, version, version === index + 1] as const))
  it.each(matrix)('binds %s/schema%s only to certificate v%s on write and read (accepted=%s)', async (backend, schema, version, accepted) => {
    const f = await fixture(backend, 'create', true)
    try {
      const request = f.completion(schema)
      const plan = f.fence(() => f.store.createSourcePlan({ ...request, preparedArtifact: bytes })).result
      const certificate = signedCertificate(f, plan, version)
      f.fence(() => f.store.claimCreationVerification(plan.id))
      const database = new DatabaseSync(f.path)
      try {
        if (!accepted) {
          expect(() => f.fence(() => f.store.recordCreationVerification(certificate))).toThrow(/does not match exact prepared source/)
          expect(f.store.getCreationVerificationStatus(plan.id)).toBe('claimed')
          persistCertificate(database, certificate)
          expect(() => f.store.getCreationVerification(plan.id)).toThrow(/does not match exact prepared source/)
          return
        }
        f.fence(() => f.store.recordCreationVerification(certificate))
        expect(f.store.getCreationVerification(plan.id)).toEqual(certificate)
        const read = f.store.getCreationVerification(plan.id)!
        read.plan.name = 'agent-mutated'
        if (read.execution) read.execution.runtimeDigest = hex('mutated-runtime')
        expect(f.store.getCreationVerification(plan.id)).toEqual(certificate)
        const rows = () => ['source_creation_verifications', 'source_plans', 'source_jobs', 'source_creation_grants', 'operation_receipts']
          .map(table => database.prepare(`SELECT * FROM ${table}`).all())
        const original = rows()
        f.store.close()
        const reopened = new ControlPlaneStore({ path: f.path, now: () => now + 1_000_000 })
        try {
          // Historical reads do not renew expiry, consume grants or rewrite evidence.
          expect(reopened.getCreationVerification(plan.id)).toEqual(certificate)
          expect(rows()).toEqual(original)
        } finally { reopened.close() }
      } finally { database.close() }
    } finally { try { f.store.close() } catch {} }
  })

  const tampering = (['macos-seatbelt', 'linux-native'] as const).flatMap(backend =>
    (['runtime', 'build-evidence'] as const).map(field => [backend, field] as const))
  it.each(tampering)('rejects %s certificate %s mismatch on write and corrupted readback', async (backend, field) => {
    const f = await fixture(backend, 'create', true), version = backend === 'macos-seatbelt' ? 2 : 3
    try {
      const request = f.completion(version)
      const plan = f.fence(() => f.store.createSourcePlan({ ...request, preparedArtifact: bytes })).result
      const certificate = signedCertificate(f, plan, version)
      f.fence(() => { f.store.claimCreationVerification(plan.id); f.store.recordCreationVerification(certificate) })
      const changed = structuredClone(certificate)
      if (field === 'build-evidence') changed.execution!.buildEvidenceDigest = hex('other-evidence')
      else if (changed.execution!.boundary === 'linux-native-process-seccomp-v1') changed.execution!.buildRuntimeDigest = hex('other-runtime')
      else changed.execution!.runtimeDigest = hex('other-runtime')
      expect(() => f.fence(() => f.store.recordCreationVerification(changed))).toThrow(/does not match exact prepared source/)
      const database = new DatabaseSync(f.path)
      try {
        persistCertificate(database, changed)
        expect(() => f.store.getCreationVerification(plan.id)).toThrow(/does not match exact prepared source/)
      } finally { database.close() }
    } finally { f.store.close() }
  })

  it.each(['receipt', 'archive', 'execution-contract', 'build-script', 'logs'] as const)(
    'binds Linux full prepared evidence including %s beyond artifact and runtime', async field => {
      const f = await fixture('linux-native', 'create', true)
      try {
        const request = f.completion(3)
        const plan = f.fence(() => f.store.createSourcePlan({ ...request, preparedArtifact: bytes })).result
        const certificate = signedCertificate(f, plan, 3), changedEvidence = structuredClone(plan.preparedEvidence!) as LinuxSourcePreparedEvidence
        if (field === 'receipt') changedEvidence.receipt.receiptDigest = hex('other-receipt')
        if (field === 'archive') changedEvidence.archive.sha256 = hex('other-archive')
        if (field === 'execution-contract') changedEvidence.executionContractDigest = hex('other-contract')
        if (field === 'build-script') changedEvidence.buildScriptSha256 = hex('other-script')
        if (field === 'logs') changedEvidence.logDigest = hex('other-logs')
        certificate.execution!.buildEvidenceDigest = controlPlaneDigest(changedEvidence)
        f.fence(() => f.store.claimCreationVerification(plan.id))
        expect(() => f.fence(() => f.store.recordCreationVerification(certificate))).toThrow(/does not match exact prepared source/)
        const database = new DatabaseSync(f.path)
        try {
          persistCertificate(database, certificate)
          expect(() => f.store.getCreationVerification(plan.id)).toThrow(/does not match exact prepared source/)
        } finally { database.close() }
      } finally { f.store.close() }
    })
})

describe('three backend durable source compatibility', () => {
  it.each(['modify', 'create', 'revise-created'] as const)('round trips Linux %s without changing intent, operation or evidence digest', async mode => {
    const f = await fixture('linux-native', mode)
    try {
      const request = f.completion(), before = f.store.getSourceJob(id)!
      const receipt = f.fence(() => f.store.createSourcePlan(request)), plan = receipt.result
      expect(plan.preparedEvidence).toEqual(evidence(3))
      expect(plan.sourceCheck).toEqual({ treeDigest: hex('tree'), patchDigest: hex('patch'), checkedAt: now + 1 })
      expect(f.store.getSourceJob(id)).toMatchObject({ status: 'prepared', intentDigest: before.intentDigest, intent: before.intent })
      f.store.close()
      const reopened = new ControlPlaneStore({ path: f.path, now: () => now })
      try {
        expect(reopened.getSourcePlan(plan.id)).toEqual(plan)
        expect(reopened.getSourceJob(id)).toEqual({ ...before, status: 'prepared', revision: before.revision + 1, planId: plan.id })
        expect(reopened.withOwnerTaskFailureGapAdmission(f.source.gapId, () => reopened.createSourcePlan(request))).toEqual(receipt)
      } finally { reopened.close() }
    } finally { try { f.store.close() } catch {} }
  })

  const matrix = (['docker', 'macos-seatbelt', 'linux-native'] as const).flatMap((backend, index) =>
    ([1, 2, 3] as const).map(schema => [backend, schema, schema === index + 1] as const))
  it.each(matrix)('binds %s exclusively to evidence schema %s (accepted=%s)', async (backend, schema, accepted) => {
    const f = await fixture(backend)
    try {
      const request = f.completion(schema)
      if (!accepted) {
        expect(() => f.fence(() => f.store.createSourcePlan(request))).toThrow()
        expect(f.store.getSourceJob(id)?.status).toBe('running')
        return
      }
      const receipt = f.fence(() => f.store.createSourcePlan(request)), before = f.store.getSourceJob(id)
      const raw = new DatabaseSync(f.path)
      const rows = () => ({ plan: raw.prepare('SELECT * FROM source_plans').get(), job: raw.prepare('SELECT * FROM source_jobs').get(),
        operations: raw.prepare('SELECT * FROM operation_receipts').all(), authority: raw.prepare('SELECT * FROM source_job_authorities').all(),
        grants: raw.prepare('SELECT * FROM source_creation_grants').all() })
      try {
        const original = rows()
        f.store.close()
        const reopened = new ControlPlaneStore({ path: f.path, now: () => now })
        try { expect(reopened.getSourcePlan(receipt.result.id)).toEqual(receipt.result); expect(reopened.getSourceJob(id)).toEqual(before); expect(rows()).toEqual(original) }
        finally { reopened.close() }
      } finally { raw.close() }
    } finally { try { f.store.close() } catch {} }
  })

  const resources = (['docker', 'macos-seatbelt', 'linux-native'] as const).flatMap(backend =>
    (['docker', 'macos-seatbelt', 'linux-native'] as const).map(resource => [backend, resource] as const))
  it.each(resources)('accepts only %s resource identity for its matching backend (%s)', async (backend, resource) => {
    const f = await fixture(backend)
    try {
      const input = structuredClone(f.source)
      delete input.nativeResource; delete input.containerName
      if (resource === 'docker') input.containerName = `dsh-${id}`
      else input.nativeResource = { backend: resource, key: id }
      if (resource === backend) expect(f.enqueue(input).intent).toEqual(input)
      else { expect(() => f.enqueue(input)).toThrow(); expect(f.store.listSourceJobs(100)).toEqual([]) }
    } finally { f.store.close() }
  })

  it('requires a running durable Linux job for schema3 modify evidence', async () => {
    const f = await fixture('linux-native', 'modify')
    try {
      const { sourceJob: _sourceJob, ...request } = f.completion()
      expect(() => f.fence(() => f.store.createSourcePlan(request))).toThrow(/matching durable source job/)
      expect(f.store.getSourceJob(id)?.status).toBe('running')
    } finally { f.store.close() }
  })

  it.each(['unknown-backend', 'wrong-resource', 'docker-resource', 'wrong-key', 'mac-modify'] as const)('rejects %s before accepting a job', async kind => {
    const f = await fixture('linux-native', kind === 'mac-modify' ? 'modify' : 'create')
    try {
      const input = structuredClone(f.source)
      if (kind === 'unknown-backend') (input.build as unknown as { backend: string }).backend = 'unknown'
      if (kind === 'wrong-resource') input.nativeResource!.backend = 'macos-seatbelt'
      if (kind === 'docker-resource') { delete input.nativeResource; input.containerName = `dsh-${id}` }
      if (kind === 'wrong-key') input.nativeResource!.key = `source-job-${'e'.repeat(64)}`
      if (kind === 'mac-modify') { input.build = build('macos-seatbelt'); input.nativeResource!.backend = 'macos-seatbelt' }
      expect(() => f.enqueue(input)).toThrow()
      expect(f.store.listSourceJobs(100)).toEqual([])
    } finally { f.store.close() }
  })

  it.each(['schema', 'nonce', 'resource', 'receipt-size', 'receipt-digest', 'archive-zero', 'archive-overflow', 'archive-hash', 'pack-size', 'pack-hash', 'offline', 'checks'] as const)(
    'rejects malformed Linux %s without committing a plan', async kind => {
      const f = await fixture()
      try {
        const request = f.completion(), value = request.prepared.evidence as LinuxSourcePreparedEvidence
        if (kind === 'schema') (value as unknown as { schemaVersion: number }).schemaVersion = 4
        if (kind === 'nonce') value.receipt.nativeNonce = 'a'.repeat(31)
        if (kind === 'resource') value.receipt.nativeResourceId = 'linux-not-a-uuid'
        if (kind === 'receipt-size') Object.assign(value.receipt, { sizeBytes: 1 })
        if (kind === 'receipt-digest') value.receipt.receiptDigest = 'z'.repeat(64)
        if (kind === 'archive-zero') value.archive.sizeBytes = 0
        if (kind === 'archive-overflow') value.archive.sizeBytes = 64 * 1024 * 1024 + 1
        if (kind === 'archive-hash') value.archive.sha256 = 'z'.repeat(64)
        if (kind === 'pack-size') value.pack.sizeBytes = 0
        if (kind === 'pack-hash') value.pack.sha256 = 'z'.repeat(64)
        if (kind === 'offline') (value.environment as { offline: boolean }).offline = false
        if (kind === 'checks') (value.checks as unknown as string[])[2] = 'semantic-typecheck'
        expect(() => f.fence(() => f.store.createSourcePlan(request))).toThrow()
        expect(f.store.getSourceJob(id)?.status).toBe('running')
      } finally { f.store.close() }
    })

  it.each(['size', 'hash', 'valid'] as const)('binds retained binary artifact %s to exact Linux pack evidence', async kind => {
    const f = await fixture()
    try {
      const request = f.completion(), artifact = kind === 'size' ? bytes.subarray(0, 3) : kind === 'hash' ? Buffer.from([1, 2, 3, 4]) : bytes
      const create = () => f.fence(() => f.store.createSourcePlan({ ...request, preparedArtifact: artifact }))
      if (kind !== 'valid') { expect(create).toThrow(/artifact differs/); return }
      const plan = create().result
      expect(f.fence(() => f.store.readPreparedSourceArtifact(plan.id))).toEqual(bytes)
      const raw = new DatabaseSync(f.path)
      try {
        raw.prepare('UPDATE source_prepared_artifacts SET bytes=?').run(Buffer.from([1, 2, 3, 4]))
        expect(() => f.fence(() => f.store.readPreparedSourceArtifact(plan.id))).toThrow(/bytes are corrupt/)
      } finally { raw.close() }
    } finally { f.store.close() }
  })

  it('binds every Linux receipt and archive field into the persisted plan digest', async () => {
    const f = await fixture()
    try {
      const request = f.completion(), plan = f.fence(() => f.store.createSourcePlan(request)).result, raw = new DatabaseSync(f.path)
      try {
        const stored = JSON.stringify(plan.preparedEvidence)
        for (const field of ['nativeNonce', 'receiptDigest', 'archive'] as const) {
          const changed = JSON.parse(stored) as LinuxSourcePreparedEvidence
          if (field === 'archive') changed.archive.sha256 = hex('other-archive')
          else changed.receipt[field] = field === 'nativeNonce' ? 'c'.repeat(32) : hex('other-receipt')
          raw.prepare('UPDATE source_plans SET prepared_evidence_json=? WHERE id=?').run(JSON.stringify(changed), plan.id)
          expect(() => f.store.getSourcePlan(plan.id)).toThrow(/digest-mismatched/)
        }
      } finally { raw.close() }
    } finally { f.store.close() }
  })
})
