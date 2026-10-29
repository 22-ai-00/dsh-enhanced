import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { canonicalGrowthJson, growthObjectDigest, pluginRevisionVerificationSigningPayload,
  sourceGrowthEvidenceDigest, sourceGrowthRunDigest, verifyPluginRevisionRegressionCertificate,
  type PluginCreationVerificationCertificate, type PluginCreationVerificationLinuxExecution,
  type PluginRevisionVerificationCertificate,
  type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationReviewStore } from '../src/creation-review-store.ts'
import { CreationReviewRuntime, compileCreationReviewConfig, projectCreationSchemas,
  type CreationReviewConfig } from '../src/creation-review.ts'
import { RevisionRegressionReviewRuntime, compileRevisionRegressionReviewConfig,
  type RevisionRegressionReviewConfig } from '../src/revision-regression-review.ts'
import { LINUX_BEHAVIOR_BOUNDARY } from '../src/plugin-behavior-config.js'
import { linuxPluginBehaviorRuntimeDigest } from '../src/linux-behavior-runtime.js'

const observer = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
const deployment = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/plugin-behavior-runner.js', () => ({ PluginBehaviorRunner: class {
  run(...args: unknown[]) { return observer.run(...args) }
  close() { return observer.close() }
} }))
vi.mock('../src/linux-behavior-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/linux-behavior-runtime.js')>(),
  readLinuxPluginBehaviorDeploymentPreparation: deployment.read,
}))

const roots: string[] = [], contexts: Context[] = [],
  runtimes: Array<CreationReviewRuntime | RevisionRegressionReviewRuntime> = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  observer.run.mockReset(); observer.close.mockClear(); deployment.read.mockReset()
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
  const root = await realpath(await mkdtemp(join(tmpdir(), 'linux-revision-regression-'))); roots.push(root)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer')
  await mkdir(stateRoot, { mode: 0o700 })
  const keys = generateKeyPairSync('ed25519')
  await writeFile(keyPath, keys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const now = Date.now()
  const owner = { authorityId: 'route', authorityHash: h('a'), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const dockerRunner = { stateRoot, image: 'sha256:' + h('a'), dockerPath: await realpath(process.execPath),
    expiresAt: now + 120_000, maxRuns: 16, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 }
  const baseRoot = join(root, 'base')
  const base: LinuxRuntime = { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as LinuxRuntime['platform'],
    sourceCommit: '1'.repeat(40), lockSha256: '2'.repeat(64), root: { path: baseRoot, dev: 1, ino: 1, sha256: '3'.repeat(64) },
    nodePath: join(baseRoot, 'bin/node'), nodeSha256: '4'.repeat(64), pnpmPath: join(baseRoot, 'pnpm/bin/pnpm.mjs'),
    nativePnpmPath: join(baseRoot, 'pnpm-native/pnpm'), nativePnpmRoot: join(baseRoot, 'pnpm-native'), modulesPath: join(baseRoot, 'node_modules'),
    storePath: join(baseRoot, 'store'), cachePath: join(baseRoot, 'cache'),
    versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } }
  const cloneRoot = join(root, 'behavior/runtime')
  const cloned = { ...base, root: { ...base.root, path: cloneRoot, ino: 2, sha256: '5'.repeat(64) },
    ...Object.fromEntries(['nodePath', 'pnpmPath', 'nativePnpmPath', 'nativePnpmRoot', 'modulesPath', 'storePath', 'cachePath']
      .map(key => [key, (base[key as keyof LinuxRuntime] as string).replace(baseRoot, cloneRoot)])) }
  const descriptor = { schemaVersion: 1 as const, runtime: cloned, observer: { schemaVersion: 1 as const,
    sourceSha256: '6'.repeat(64), workerSha256: '7'.repeat(64), candidateSha256: '8'.repeat(64),
    launcherSha256: '9'.repeat(64), parentProtectSha256: 'a'.repeat(64), childProtectSha256: 'b'.repeat(64) } }
  const linuxRunner = { backend: 'linux-native' as const, stateRoot, expiresAt: now + 120_000, maxRuns: 16,
    maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536, runtime: descriptor,
    cgroupRoots: { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' } }
  const preparedDeployment = { descriptor, baseRuntimeDigest: linuxRuntimeDigest(base), preparationDigest: h('c') }
  deployment.read.mockResolvedValue(preparedDeployment)
  const common = { owner, namePrefix: 'owner-', keyId: 'owner-key', keyPath, expiresAt: now + 120_000,
    maxVerifications: 2, maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 }
  const dockerBase = { ...common, authorityId: 'regression-review', runner: dockerRunner }
  const linuxBase = { ...common, authorityId: 'regression-review', runner: linuxRunner }
  const creationConfig: CreationReviewConfig = { ...linuxBase, authorityId: 'creation-review',
    policy: 'The original owner task requires exact signed addition.', maxInputBytes: 65_536, maxOutputTokens: 1024 }
  const dockerConfig: RevisionRegressionReviewConfig = dockerBase
  const linuxConfig: RevisionRegressionReviewConfig = linuxBase
  const creation = compileCreationReviewConfig(creationConfig)
  const regression = compileRevisionRegressionReviewConfig(linuxConfig)
  const parentArtifact = Buffer.from('original adopted linux package'), candidateArtifact = Buffer.from('revised linux candidate package')
  const execution: PluginCreationVerificationLinuxExecution = { boundary: LINUX_BEHAVIOR_BOUNDARY, runtimeDigest: linuxPluginBehaviorRuntimeDigest(descriptor),
    buildRuntimeDigest: linuxRuntimeDigest(base), buildEvidenceDigest: h('d'), observerPreparationDigest: h('c') }
  const parentBody: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v3', verificationId: 'parent-check', authority: creation.authority,
    plan: { id: 'parent-plan', digest: h('b'), name: 'owner-tool', sourceTreeDigest: h('c'),
      sourcePatchDigest: h('d'), artifactSha256: sha(parentArtifact), artifactBytes: parentArtifact.length, generatorDigest: h('e') },
    source: { referenceDigest: h('f'), ownerDigest: h('a'), growthRunDigest: h('b') },
    contractDigest: growthObjectDigest(cases), schemaDigest, environment,
    model: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' },
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3 },
    sessions: { contract: 'parent-contract', sourceReview: 'parent-source-review' },
    observations: cases.map((item, index) => ({ caseId: item.id, jobId: `old-job-${index}`,
      operationDigest: growthObjectDigest({ kind: 'invoke', schemaDigest,
        calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] }), observationDigest: h('9') })),
    reviewDigest: h('8'), verifiedAt: now - 60_000, expiresAt: now - 30_000, execution,
  }
  const parentCertificate = { ...parentBody,
    signature: sign(null, Buffer.from(canonicalGrowthJson(parentBody)), keys.privateKey).toString('base64url') }
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
  const parentBinding = { planId: parentCertificate.plan.id, certificateDigest: sourceGrowthEvidenceDigest(parentCertificate),
    artifactSha256: sha(parentArtifact), sourceArchiveDigest: h('5'), sourceDigest: h('4') }
  const fullOwner = { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }
  const reference = { owner: fullOwner, sourceDigest: h('3'), outcomeId: 'outcome',
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: 'task', version: 1, digest: h('2'), disposition: 'upsert' as const } }
  const run: SourceGrowthRunBinding = { protocol: 'assistant-growth/source-run/v1', runId: 'run-1',
    intentDigest: h('1'), configDigest: h('2'), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
    source: { outcomeId: reference.outcomeId, projection: reference.projection, sourceDigest: reference.sourceDigest },
    model: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' }, modelOrigin: 'inherited-owner-task',
    revisionAcceptance: { protocol: 'assistant-growth/revision-acceptance-authority/v1', authorityId: 'revision-review',
      keyId: 'revision-key', authorityDigest: h('1'), namePrefix: 'owner-', expiresAt: now + 120_000 },
    revisionRegressionAcceptance: regression.authority,
    budget: { budgetId: 'budget', amount: 1, maxModelCalls: 4, maxToolCalls: 16,
      maxOutputTokens: 2048, maxDurationMs: 120_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'run-1', definitionHash: h('3'), occurrenceId: 'occurrence' },
    sessionId: 'author-session', toolContractDigest: h('4'), executionContractDigest: h('5'),
    createdAt: now - 1000, generationDeadlineAt: now + 60_000, expiresAt: now + 120_000 }
  const candidateBody: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-verification/v2', verificationId: 'revision-check',
    authority: run.revisionAcceptance!, parent: parentBinding,
    plan: { id: 'candidate-plan', digest: h('6'), name: 'owner-tool', sourceTreeDigest: h('7'),
      sourcePatchDigest: h('8'), artifactSha256: sha(candidateArtifact), artifactBytes: candidateArtifact.length, generatorDigest: h('e') },
    source: { referenceDigest: sourceGrowthEvidenceDigest(reference), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
      growthRunDigest: sourceGrowthRunDigest(run) }, contractDigest: growthObjectDigest(cases), schemaDigest, environment,
    model: run.model, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3 },
    sessions: { contract: 'revision-contract', sourceReview: 'revision-source' },
    observations: cases.map((item, index) => ({ caseId: item.id, jobId: `revision-job-${index}`,
      operationDigest: growthObjectDigest({ kind: 'invoke', schemaDigest,
        calls: [{ id: item.id, toolName: item.toolName, arguments: item.arguments }] }), observationDigest: growthObjectDigest({ side: 'revision', index }) })),
    reviewDigest: h('c'), verifiedAt: now - 500, expiresAt: now + 60_000, execution,
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
  const cp = { inspectPreparedRevisionRegression: vi.fn(() => snapshot),
    withPreparedRevisionRegressionFence: vi.fn(<T>(_input: unknown, callback: () => T): T => callback()),
    inspectPreparedRevisionReviewContext: vi.fn(async () => ({ patch: '+ signed addition', changedPaths: ['src/index.ts'] })) }
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('pluginControlPlane' as never, cp as never)
  const creationRuntime = new CreationReviewRuntime(ctx, creationConfig, databasePath); runtimes.push(creationRuntime)
  const makeLinuxRuntime = () => {
    const runtime = new RevisionRegressionReviewRuntime(ctx, linuxConfig, databasePath,
      certificate => creationRuntime.readRetainedCases(certificate)); runtimes.push(runtime); return runtime
  }
  const makeDockerRuntime = () => {
    const runtime = new RevisionRegressionReviewRuntime(ctx, dockerConfig, databasePath,
      certificate => creationRuntime.readRetainedCases(certificate)); runtimes.push(runtime); return runtime
  }
  let job = 0
  observer.run.mockImplementation(async ({ artifact, operation }: {
    artifact: Buffer; operation: { kind: string; calls?: { id: string; arguments: { a: number; b: number } }[] } }) => {
    const artifactSha256 = sha(artifact)
    const common = { jobId: `linux-job-${++job}`, boundary: LINUX_BEHAVIOR_BOUNDARY,
      runtimeDigest: linuxPluginBehaviorRuntimeDigest(descriptor), status: 'observed' as const, artifactSha256,
      quiescent: true as const, environment, schemaDigest }
    return operation.kind === 'discover' ? { ...common, schemas: [rawSchema] }
      : { ...common, calls: [{ id: operation.calls![0]!.id, toolName: 'owner_sum',
        result: { isError: false, value: { sum: operation.calls![0]!.arguments.a + operation.calls![0]!.arguments.b } } }] }
  })
  const request = { protocol: 'assistant-growth/revision-regression-request/v1' as const, planId: plan.id }
  return { root, ctx, creationRuntime, linuxConfig, dockerConfig, regression, cp, request, snapshot, plan,
    parentCertificate, candidateCertificate, execution, preparedDeployment, descriptor,
    makeLinuxRuntime, makeDockerRuntime }
}

test('paired Linux regression signs v2 anchoring one retained observer across the v3 parent and v2 candidate', async () => {
  const f = await fixture()
  const runtime = f.makeLinuxRuntime()
  const result = await runtime.run(f.request)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') return
  expect(result.certificate.protocol).toBe('assistant-growth/revision-regression/v2')
  expect(result.certificate.execution).toEqual({ boundary: LINUX_BEHAVIOR_BOUNDARY,
    runtimeDigest: f.execution.runtimeDigest, observerPreparationDigest: f.execution.observerPreparationDigest })
  expect(verifyPluginRevisionRegressionCertificate(result.certificate, f.regression.authority, f.regression.publicKey)).toBe(true)
  expect(deployment.read).toHaveBeenCalledWith({ runtime: f.descriptor, signal: expect.any(AbortSignal) })
  // two discoveries + one paired invocation per retained case
  expect(observer.run).toHaveBeenCalledTimes(2 + 2 * 2)
  expect(runtime.inspect({ owner: f.linuxConfig.owner })?.remainingVerifications).toBe(1)
  expect((await runtime.run(f.request)).status).toBe('verified')
  expect(observer.run).toHaveBeenCalledTimes(2 + 2 * 2)
})

test.each(['parent-v1', 'candidate-v1', 'runtime-digest', 'build-runtime-digest', 'preparation-digest'])(
  'Linux %s family mismatch is stale-source before admission, with no observer dispatch or quota use', async mode => {
    const f = await fixture()
    type MutableExec = { protocol?: string; execution?: { runtimeDigest: string; buildRuntimeDigest: string; observerPreparationDigest: string } }
    if (mode === 'parent-v1') (f.snapshot.parent.certificate as unknown as MutableExec).protocol = 'assistant-growth/creation-verification/v1'
    if (mode === 'candidate-v1') (f.snapshot.candidate.certificate as unknown as MutableExec).protocol = 'assistant-growth/revision-verification/v1'
    if (mode === 'runtime-digest') (f.snapshot.parent.certificate as unknown as MutableExec).execution!.runtimeDigest = '0'.repeat(64)
    if (mode === 'build-runtime-digest') (f.snapshot.candidate.certificate as unknown as MutableExec).execution!.buildRuntimeDigest = '0'.repeat(64)
    if (mode === 'preparation-digest') (f.snapshot.candidate.certificate as unknown as MutableExec).execution!.observerPreparationDigest = '0'.repeat(64)
    const runtime = f.makeLinuxRuntime()
    expect(await runtime.run(f.request)).toEqual({ status: 'unknown', reason: 'stale-source' })
    expect(observer.run).not.toHaveBeenCalled()
    // The cross-certificate family gate runs before the live deployment preparation is reopened.
    expect(deployment.read).not.toHaveBeenCalled()
    expect(runtime.inspect({ owner: f.linuxConfig.owner })?.remainingVerifications).toBe(2)
  })

test('a non-Linux runtime refuses v3/v2 Linux certificates without dispatching', async () => {
  const f = await fixture()
  const runtime = f.makeDockerRuntime()
  expect(await runtime.run(f.request)).toEqual({ status: 'unknown', reason: 'stale-source' })
  expect(observer.run).not.toHaveBeenCalled()
  expect(deployment.read).not.toHaveBeenCalled()
})

test.each(['deployment-descriptor', 'deployment-base', 'deployment-preparation'])(
  'Linux %s drifting from the signed candidate is stale-source before admission', async mode => {
    const f = await fixture()
    if (mode === 'deployment-descriptor') deployment.read.mockResolvedValue({ ...f.preparedDeployment,
      descriptor: { ...f.preparedDeployment.descriptor, observer: { ...f.preparedDeployment.descriptor.observer, workerSha256: '0'.repeat(64) } } })
    if (mode === 'deployment-base') deployment.read.mockResolvedValue({ ...f.preparedDeployment, baseRuntimeDigest: '0'.repeat(64) })
    if (mode === 'deployment-preparation') deployment.read.mockResolvedValue({ ...f.preparedDeployment, preparationDigest: '0'.repeat(64) })
    const runtime = f.makeLinuxRuntime()
    expect(await runtime.run(f.request)).toEqual({ status: 'unknown', reason: 'stale-source' })
    expect(observer.run).not.toHaveBeenCalled()
    expect(runtime.inspect({ owner: f.linuxConfig.owner })?.remainingVerifications).toBe(2)
  })

test('a Linux observer that returns another boundary or runtime is unknown after admission and is not replayed', async () => {
  const f = await fixture()
  const runtime = f.makeLinuxRuntime()
  observer.run.mockImplementationOnce(async () => ({ jobId: 'alien', boundary: 'process-seccomp-v1',
    runtimeDigest: '0'.repeat(64), status: 'observed', artifactSha256: sha(f.snapshot.parent.artifact),
    quiescent: true, environment, schemaDigest, schemas: [rawSchema] }))
  expect(await runtime.run(f.request)).toEqual({ status: 'unknown', reason: 'regression-unknown' })
  const calls = observer.run.mock.calls.length
  expect(calls).toBe(1)
  expect((await runtime.run(f.request)).status).toBe('unknown')
  expect(observer.run).toHaveBeenCalledTimes(calls)
  expect(runtime.inspect({ owner: f.linuxConfig.owner })?.remainingVerifications).toBe(1)
})
