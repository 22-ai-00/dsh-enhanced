import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { canonicalGrowthJson, growthObjectDigest, pluginRevisionVerificationSigningPayload,
  sourceGrowthEvidenceDigest, sourceGrowthRunDigest, verifyPluginRevisionRegressionCertificate,
  type PluginCreationVerificationCertificate, type PluginRevisionVerificationCertificate,
  type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationReviewStore } from '../src/creation-review-store.ts'
import { CreationReviewRuntime, compileCreationReviewConfig, projectCreationSchemas,
  type CreationReviewConfig } from '../src/creation-review.ts'
import { RevisionRegressionReviewRuntime, compileRevisionRegressionReviewConfig,
  type RevisionRegressionReviewConfig } from '../src/revision-regression-review.ts'
import { AssistantVerifierService } from '../src/service.ts'

const observer = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('@dsh-enhanced/assistant-isolation', () => ({ IsolatedVerifierRunner: class {
  run(...args: unknown[]) { return observer.run(...args) }
  close() { return observer.close() }
} }))

const roots: string[] = [], contexts: Context[] = [], runtimes: Array<CreationReviewRuntime | RevisionRegressionReviewRuntime> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  observer.run.mockReset(); observer.close.mockClear()
})

const h = (letter: string) => letter.repeat(64)
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const rawSchema = { name: 'owner_sum', description: 'untrusted text', parameters: { type: 'object', properties: {
  a: { type: 'integer', description: 'ignored' }, b: { type: 'integer' },
} } }
const schemas = projectCreationSchemas([rawSchema])
const schemaDigest = sha(Buffer.from(JSON.stringify([rawSchema])))
const environment = { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' }
const cases = [
  { id: 'ordinary', toolName: 'owner_sum', arguments: { a: 2, b: 3 }, purpose: 'ordinary' as const,
    expected: { kind: 'json-value' as const, value: { sum: 5 } }, rationale: 'The ordinary pair establishes exact addition.' },
  { id: 'negative', toolName: 'owner_sum', arguments: { a: -2, b: 3 }, purpose: 'challenge' as const,
    expected: { kind: 'json-value' as const, value: { sum: 1 } }, rationale: 'A negative operand challenges signed addition.' },
]

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'revision-regression-'))); roots.push(root)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer')
  await mkdir(stateRoot, { mode: 0o700 })
  const keys = generateKeyPairSync('ed25519')
  await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const now = Date.now()
  const owner = { authorityId: 'route', authorityHash: h('a'), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const base = { owner, namePrefix: 'owner-', keyId: 'owner-key', keyPath, expiresAt: now + 120_000,
    maxVerifications: 2, runner: { stateRoot, image: 'sha256:' + h('a'), dockerPath: '/usr/bin/docker',
      expiresAt: now + 120_000, maxRuns: 20, maxTotalDurationMs: 80_000,
      maxDurationMs: 10_000, maxOutputBytes: 65_536 }, maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 }
  const creationConfig: CreationReviewConfig = { ...base, authorityId: 'creation-review',
    policy: 'The original owner task requires exact signed addition.', maxInputBytes: 65_536, maxOutputTokens: 1024 }
  const regressionConfig: RevisionRegressionReviewConfig = { ...base, authorityId: 'regression-review' }
  const creation = compileCreationReviewConfig(creationConfig), regression = compileRevisionRegressionReviewConfig(regressionConfig)
  const parentArtifact = Buffer.from('original adopted package'), candidateArtifact = Buffer.from('revised candidate package')
  const parentBody: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'parent-check', authority: creation.authority,
    plan: { id: 'parent-plan', digest: h('b'), name: 'owner-tool', sourceTreeDigest: h('c'),
      sourcePatchDigest: h('d'), artifactSha256: sha(parentArtifact), artifactBytes: parentArtifact.length,
      generatorDigest: h('e') },
    source: { referenceDigest: h('f'), ownerDigest: h('a'), growthRunDigest: h('b') },
    contractDigest: growthObjectDigest(cases), schemaDigest, environment,
    model: { provider: 'supplier', model: 'parent-model' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3 },
    sessions: { contract: 'parent-contract', sourceReview: 'parent-source-review' },
    observations: cases.map((item, index) => ({ caseId: item.id, jobId: `old-job-${index}`,
      operationDigest: growthObjectDigest({ kind: 'invoke', schemaDigest,
        calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] }), observationDigest: h('9') })),
    reviewDigest: h('8'), verifiedAt: now - 60_000, expiresAt: now - 30_000,
  }
  const parentCertificate = { ...parentBody, signature: sign(null, Buffer.from(canonicalGrowthJson(parentBody)), keys.privateKey).toString('base64url') }
  const databasePath = join(root, 'verifier.sqlite')
  const oldStore = new CreationReviewStore(databasePath + '.creation-reviews')
  const oldBinding = h('7')
  oldStore.claim(parentCertificate.plan.id, oldBinding, creationConfig.authorityId, creation.authority.authorityDigest, 2)
  oldStore.discovered(parentCertificate.plan.id, oldBinding, { jobId: 'old-discovery', schemaDigest, schemas, environment })
  oldStore.contract(parentCertificate.plan.id, oldBinding, { cases, outputDigest: h('6'), sessionId: parentCertificate.sessions.contract })
  for (const observation of parentCertificate.observations) {
    oldStore.claimCase(parentCertificate.plan.id, oldBinding, observation.caseId, observation.operationDigest)
    oldStore.observation(parentCertificate.plan.id, oldBinding, observation.caseId, observation)
  }
  oldStore.claimReview(parentCertificate.plan.id, oldBinding)
  oldStore.certificate(parentCertificate.plan.id, oldBinding, parentCertificate)
  oldStore.close()
  const parentBinding = { planId: parentCertificate.plan.id,
    certificateDigest: sourceGrowthEvidenceDigest(parentCertificate), artifactSha256: sha(parentArtifact),
    sourceArchiveDigest: h('5'), sourceDigest: h('4') }
  const fullOwner = { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }
  const reference = { owner: fullOwner, sourceDigest: h('3'), outcomeId: 'outcome',
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: 'task', version: 1,
      digest: h('2'), disposition: 'upsert' as const } }
  const run: SourceGrowthRunBinding = { protocol: 'assistant-growth/source-run/v1', runId: 'run-1',
    intentDigest: h('1'), configDigest: h('2'), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
    source: { outcomeId: reference.outcomeId, projection: reference.projection, sourceDigest: reference.sourceDigest },
    model: { provider: 'supplier', model: 'new-task-model' }, modelOrigin: 'inherited-owner-task',
    revisionAcceptance: { protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: 'revision-review',
      keyId: 'revision-key', authorityDigest: h('1'), namePrefix: 'owner-', expiresAt: now + 120_000 },
    revisionRegressionAcceptance: regression.authority,
    budget: { budgetId: 'budget', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 120_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'run-1', definitionHash: h('3'), occurrenceId: 'occurrence' },
    sessionId: 'author-session', toolContractDigest: h('4'), executionContractDigest: h('5'),
    createdAt: now - 1000, generationDeadlineAt: now + 60_000, expiresAt: now + 120_000 }
  const candidateBody: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-verification/v1', verificationId: 'revision-check',
    authority: run.revisionAcceptance!, parent: parentBinding,
    plan: { id: 'candidate-plan', digest: h('6'), name: 'owner-tool', sourceTreeDigest: h('7'),
      sourcePatchDigest: h('8'), artifactSha256: sha(candidateArtifact), artifactBytes: candidateArtifact.length,
      generatorDigest: h('e') },
    source: { referenceDigest: sourceGrowthEvidenceDigest(reference), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
      growthRunDigest: sourceGrowthRunDigest(run) }, contractDigest: h('9'), schemaDigest, environment, model: run.model,
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3 },
    sessions: { contract: 'revision-contract', sourceReview: 'revision-source' },
    observations: cases.map((item, index) => ({ caseId: item.id, jobId: `revision-job-${index}`,
      operationDigest: h('a'), observationDigest: h('b') })), reviewDigest: h('c'),
    verifiedAt: now - 500, expiresAt: now + 60_000,
  }
  const candidateCertificate = { ...candidateBody, signature: sign(null,
    Buffer.from(pluginRevisionVerificationSigningPayload(candidateBody)), keys.privateKey).toString('base64url') }
  const plan = { id: candidateCertificate.plan.id, digest: candidateCertificate.plan.digest, name: candidateCertificate.plan.name,
    mode: 'prepared-revise', status: 'pending-approval', expiresAt: now + 120_000,
    sourceRevision: { grant: { expiresAt: now + 120_000 }, growthRun: run, parent: parentBinding } }
  const snapshot = { protocol: 'dsh-prepared-revision-regression/v1' as const, plan,
    job: { intent: { revision: { growthRun: run, parent: parentBinding } } }, reference,
    candidate: { certificate: candidateCertificate, artifact: candidateArtifact, sourceDigest: h('d') },
    parent: { binding: parentBinding, certificate: parentCertificate, artifact: parentArtifact } }
  let current = true, fenceCount = 0
  const cp = { inspectPreparedRevisionRegression: vi.fn(() => snapshot),
    withPreparedRevisionRegressionFence: <T>(input: { planId: string; planDigest: string; artifactSha256: string;
      growthRunDigest: string; referenceDigest: string; parentDigest: string; candidateVerificationDigest: string;
      sourceDigest: string; regressionAuthorityDigest: string }, callback: () => T): T => {
      fenceCount++
      if (!current || input.planId !== plan.id || input.planDigest !== plan.digest
        || input.artifactSha256 !== sha(candidateArtifact) || input.growthRunDigest !== sourceGrowthRunDigest(run)
        || input.referenceDigest !== sourceGrowthEvidenceDigest(reference)
        || input.parentDigest !== sourceGrowthEvidenceDigest(parentBinding)
        || input.candidateVerificationDigest !== sourceGrowthEvidenceDigest(candidateCertificate)
        || input.sourceDigest !== snapshot.candidate.sourceDigest
        || input.regressionAuthorityDigest !== sourceGrowthEvidenceDigest(regression.authority)) throw new Error('source changed')
      return callback()
    },
    inspectPreparedRevisionReviewContext: vi.fn(async () => ({ patch: '+ signed addition', changedPaths: ['src/index.ts'] })) }
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('pluginControlPlane' as never, cp as never)
  const creationRuntime = new CreationReviewRuntime(ctx, creationConfig, databasePath); runtimes.push(creationRuntime)
  const regressionRuntime = new RevisionRegressionReviewRuntime(ctx, regressionConfig, databasePath,
    certificate => creationRuntime.readRetainedCases(certificate)); runtimes.push(regressionRuntime)
  let job = 0
  observer.run.mockImplementation(async (_key: string, encoded: string, stdin: string) => {
    const artifactSha256 = sha(Buffer.from(encoded, 'base64'))
    const operation = JSON.parse(stdin).operation
    const result = operation.kind === 'discover'
      ? { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed', artifactSha256, quiescent: true,
          environment, schemaDigest, schemas: [rawSchema] }
      : { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed', artifactSha256, quiescent: true,
          environment, schemaDigest, calls: [{ id: operation.calls[0].id, toolName: 'owner_sum',
            result: { isError: false, value: { sum: operation.calls[0].arguments.a + operation.calls[0].arguments.b },
              content: [{ type: 'text', text: artifactSha256 }] } }] }
    return { jobId: `new-job-${++job}`, status: 'succeeded', quiescent: true, exitCode: 0,
      stdout: JSON.stringify(result) + '\n', stderr: '', artifacts: [] }
  })
  const request = { protocol: 'assistant-growth/revision-regression-request/v1' as const, planId: plan.id }
  return { root, databasePath, ctx, creationRuntime, regressionRuntime, creationConfig, regressionConfig, creation, regression,
    parentCertificate, candidateCertificate, snapshot, cp, observer, request, plan,
    withdraw: () => { current = false }, fences: () => fenceCount }
}

test('replays retained private challenge cases against both artifacts without another model turn', async () => {
  const f = await fixture()
  expect(f.regressionRuntime.inspect({ owner: f.regressionConfig.owner })).toMatchObject({
    authority: f.regression.authority, remainingVerifications: 2 })
  const result = await f.regressionRuntime.run(f.request)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') return
  expect(verifyPluginRevisionRegressionCertificate(result.certificate,
    f.regression.authority, f.regression.publicKey)).toBe(true)
  expect(result.certificate.contractDigest).toBe(f.parentCertificate.contractDigest)
  expect(result.certificate.candidateVerificationDigest).toBe(sourceGrowthEvidenceDigest(f.candidateCertificate))
  expect(result.certificate.observations).toHaveLength(2)
  expect(result.certificate.observations[0]!.parent.observationDigest)
    .not.toBe(result.certificate.observations[0]!.candidate.observationDigest)
  expect(observer.run).toHaveBeenCalledTimes(6)
  expect(f.creationRuntime.inspect({ owner: f.creationConfig.owner })?.remainingVerifications).toBe(1)
  expect(f.regressionRuntime.inspect({ owner: f.regressionConfig.owner })?.remainingVerifications).toBe(1)
  expect(f.fences()).toBeGreaterThan(8)
  expect((await f.regressionRuntime.run(f.request)).status).toBe('verified')
  expect(observer.run).toHaveBeenCalledTimes(6)
})

test('a candidate regression rejects while an uncertain invocation consumes quota without replay', async () => {
  const rejected = await fixture()
  const original = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await original(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.calls?.[0]?.id === 'negative' && frame.artifactSha256 === rejected.snapshot.candidate.certificate.plan.artifactSha256) {
      frame.calls[0].result.value.sum = 999
    }
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  expect(await rejected.regressionRuntime.run(rejected.request)).toEqual({ status: 'rejected', reason: 'candidate-regression' })
  const uncertain = await fixture()
  observer.run.mockClear()
  const base = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    if (observer.run.mock.calls.length === 3) throw new Error('Docker outcome unknown')
    return base(...args)
  })
  expect((await uncertain.regressionRuntime.run(uncertain.request)).status).toBe('unknown')
  const count = observer.run.mock.calls.length
  expect((await uncertain.regressionRuntime.run(uncertain.request)).status).toBe('unknown')
  expect(observer.run.mock.calls.length).toBe(count)
  expect(uncertain.regressionRuntime.inspect({ owner: uncertain.regressionConfig.owner })?.remainingVerifications).toBe(1)
})

test('missing or changed old cases and a changed new-task fence cannot reach behavior runner', async () => {
  const unavailable = await fixture()
  await unavailable.creationRuntime.close()
  expect((await unavailable.regressionRuntime.run(unavailable.request)).status).toBe('unknown')
  expect(observer.run).not.toHaveBeenCalled()
  const altered = await fixture()
  const database = new DatabaseSync(altered.databasePath + '.creation-reviews')
  try {
    const row = database.prepare('SELECT data FROM verifications WHERE plan=?').get(altered.parentCertificate.plan.id) as { data: string }
    const data = JSON.parse(row.data)
    data.contract.cases[0].expected.value.sum = 999
    database.prepare('UPDATE verifications SET data=? WHERE plan=?').run(canonicalGrowthJson(data), altered.parentCertificate.plan.id)
  } finally { database.close() }
  expect((await altered.regressionRuntime.run(altered.request)).status).toBe('unknown')
  expect(observer.run).not.toHaveBeenCalled()
  const fenced = await fixture()
  fenced.withdraw()
  expect((await fenced.regressionRuntime.run(fenced.request)).status).toBe('unknown')
  expect(observer.run).not.toHaveBeenCalled()
  const incompatible = await fixture()
  const base = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await base(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.schemas && frame.artifactSha256 === incompatible.snapshot.candidate.certificate.plan.artifactSha256) {
      frame.schemas[0].parameters.properties.b.type = 'string'
      frame.schemaDigest = sha(Buffer.from(JSON.stringify(frame.schemas)))
    }
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  expect(await incompatible.regressionRuntime.run(incompatible.request)).toEqual({ status: 'rejected', reason: 'schema-or-environment-mismatch' })
})

test('expired parent certificate remains historical evidence while an expired regression authority fails closed', async () => {
  const historical = await fixture()
  expect(historical.parentCertificate.expiresAt).toBeLessThan(Date.now())
  expect(historical.creationRuntime.readRetainedCases(historical.parentCertificate)).toBeDefined()
  expect(historical.creationRuntime.readRetainedCases({ ...historical.parentCertificate, signature: 'invalid' })).toBeUndefined()
  expect((await historical.regressionRuntime.run(historical.request)).status).toBe('verified')
  const expired = await fixture()
  observer.run.mockClear()
  expired.snapshot.plan.sourceRevision.growthRun.revisionRegressionAcceptance = {
    ...expired.regression.authority, expiresAt: Date.now() - 1 }
  expect((await expired.regressionRuntime.run(expired.request)).status).toBe('unknown')
  expect(observer.run).not.toHaveBeenCalled()
})

test('missing private parent record and cold-restarted unknown claim cannot dispatch Docker', async () => {
  const missing = await fixture()
  const database = new DatabaseSync(missing.databasePath + '.creation-reviews')
  try { database.prepare('DELETE FROM verifications WHERE plan=?').run(missing.parentCertificate.plan.id) }
  finally { database.close() }
  expect((await missing.regressionRuntime.run(missing.request)).status).toBe('unknown')
  expect(observer.run).not.toHaveBeenCalled()

  const uncertain = await fixture()
  observer.run.mockClear()
  const base = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    if (observer.run.mock.calls.length === 3) throw new Error('isolated invocation uncertain')
    return base(...args)
  })
  expect((await uncertain.regressionRuntime.run(uncertain.request)).status).toBe('unknown')
  const dispatched = observer.run.mock.calls.length
  await uncertain.regressionRuntime.close()
  const restarted = new RevisionRegressionReviewRuntime(uncertain.ctx, uncertain.regressionConfig,
    uncertain.databasePath, parent => uncertain.creationRuntime.readRetainedCases(parent))
  runtimes.push(restarted)
  expect((await restarted.run(uncertain.request)).status).toBe('unknown')
  expect(observer.run.mock.calls.length).toBe(dispatched)
  expect(restarted.inspect({ owner: uncertain.regressionConfig.owner })?.remainingVerifications).toBe(1)
})

test('fresh environment mismatch and failed parent held-out case reject the candidate', async () => {
  const changedEnvironment = await fixture()
  const first = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await first(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.schemas && frame.artifactSha256 === changedEnvironment.snapshot.candidate.certificate.plan.artifactSha256) {
      frame.environment.node = 'v23.0.0'
    }
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  expect(await changedEnvironment.regressionRuntime.run(changedEnvironment.request))
    .toEqual({ status: 'rejected', reason: 'schema-or-environment-mismatch' })

  const failedParent = await fixture()
  const second = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await second(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.calls?.[0] && frame.artifactSha256 === failedParent.snapshot.parent.binding.artifactSha256) {
      frame.calls[0].result.value.sum = 999
    }
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  expect(await failedParent.regressionRuntime.run(failedParent.request))
    .toEqual({ status: 'rejected', reason: 'parent-baseline-mismatch' })
})

test('service exposes only a Host method while the regression peer is mounted and drains on disposal', async () => {
  const f = await fixture()
  const ctx = new Context(); contexts.push(ctx)
  const service = new AssistantVerifierService(ctx, { databasePath: join(f.root, 'service.sqlite'),
    tickIntervalMs: 0, revisionRegressions: f.regressionConfig })
  expect(service.inspectRevisionRegressionAcceptanceAuthority({ owner: f.regressionConfig.owner })).toBeUndefined()
  expect(await service.verifyPluginRevisionRegression(f.request)).toEqual({ status: 'unknown', reason: 'verification-unavailable' })
  const provider = ctx.plugin({ name: 'regression-peer', apply(peer: Context) {
    peer.provide('pluginControlPlane' as never, f.cp as never)
  } })
  await provider; await new Promise(resolve => setImmediate(resolve))
  expect(service.inspectRevisionRegressionAcceptanceAuthority({ owner: f.regressionConfig.owner })?.available).toBe(true)
  expect((await service.verifyPluginRevisionRegression(f.request)).status).toBe('unknown')
  await provider.dispose(); await new Promise(resolve => setImmediate(resolve))
  expect(service.inspectRevisionRegressionAcceptanceAuthority({ owner: f.regressionConfig.owner })).toBeUndefined()
})
