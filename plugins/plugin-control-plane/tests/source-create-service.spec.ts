// Real public generator, Git worktrees, Control Plane/Automations/Policy and
// SQLite. Delivery/Evaluation and Docker are fixtures, not live acceptance.
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { pluginCreationVerificationSigningPayload, sourceGrowthRunDigest, SourceGrowthRunUnavailableError,
  type CreationAcceptanceAuthorityRef, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginControlPlaneService } from '../src/service.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import * as build from '../src/source-build.ts'
import * as trust from '../src/trust.ts'
import { defaultHostAttestationPolicy } from '../src/trust.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'
import { sourceGrowthRunFixture } from './helpers/source-growth-run-fixture.ts'

vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof build>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn() }))
const baselineRepository = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.resetAllMocks() })

async function fixture(withVerification = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-created-service-')))
  const { repository } = await createSourceCreationFixture(baselineRepository, join(root, 'source'))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim()
  const ctx = new Context(), statePath = join(root, 'control'), catalogPath = join(root, 'catalog.json')
  cleanup.push(async () => {
    await ctx.fiber.dispose()
    // Test cleanup proves registration ownership before removing its own tree.
    const listing = git('worktree', 'list', '--porcelain')
    for (const line of listing.split('\n')) if (line.startsWith(`worktree ${statePath}/source-worktrees/`)) {
      git('worktree', 'remove', '--force', line.slice('worktree '.length))
    }
    await rm(root, { recursive: true, force: true })
  })
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const owner = { receiptVersion: 2 as const, authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner',
    principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  const source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner,
    canonical: { scope: { workspace: root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      triggerOutcomeId: 'feedback', situation: 'foreground:task',
      objective: { outcomeId: 'feedback', status: 'not-achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
        evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: now },
      projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' } },
    judgement: 'independent-verifier', source: { sessionId: 'session', inboxId: 'inbox', objective: 'ordinary failed task',
      quiescent: true, truncated: false, modelSelectionState: 'frozen', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } }
  let activeSource: OwnerForegroundLearningTask = source
  ctx.provide('assistantDelivery' as never, { validateOwnerRoute: () => structuredClone(owner), inspectOwnerForegroundLearningTask: () => structuredClone(activeSource) })
  ctx.provide('assistantEvaluation' as never, { canonicalHostScope: (input: unknown) => input,
    withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }) })
  const signing = generateKeyPairSync('ed25519')
  const authority: CreationAcceptanceAuthorityRef = { protocol: 'assistant-growth/creation-acceptance-authority/v1',
    authorityId: 'fixture-creation-review', keyId: 'fixture-key', authorityDigest: '9'.repeat(64),
    namePrefix: 'rsi-service-', expiresAt: now + 600_000 }
  const publicKey = signing.publicKey.export({ format: 'pem', type: 'spki' }).toString()
  const verification = vi.fn<(_request: { planId: string }, _signal?: AbortSignal) => Promise<unknown>>()
    .mockResolvedValue({ status: 'unknown', reason: 'fixture-verifier-unavailable' })
  if (withVerification) ctx.provide('assistantVerifier' as never, { verifyPluginCreation: verification })
  const policy = new AssistantPolicyService(ctx, { databasePath: join(root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  const automations = new AssistantAutomationsService(ctx, { databasePath: join(root, 'automations.sqlite'), runsPath: join(root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  vi.mocked(trust.loadTrustConfig).mockResolvedValue({ schemaVersion: 4,
    installationId: '00000000-0000-4000-8000-000000000001', dshHome: root,
    ledger: { id: 'ledger', path: join(statePath, 'control.sqlite') }, catalog: { id: 'catalog', path: catalogPath },
    executor: { id: 'executor', version: '1', path: '/bin/true', sha256: 'a'.repeat(64), environmentAllowlist: [] },
    hostPolicy: defaultHostAttestationPolicy, releaseReceiptTtlMs: 30_000, approvalKeys: [], hostAttestationKeys: [], releaseKeys: [], releaseAuthorizationKeys: [] })
  const service = new PluginControlPlaneService(ctx, { statePath, catalogPath, trustPath: join(root, 'trust.json'),
    ...(withVerification ? { creationVerifications: { authority, publicKey } } : {}),
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, versioning: 'patch',
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    sourceJobs: { authorityId: 'source-grant', expiresAt: now + 600_000, maxSubmissions: 3, repository,
      ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary', budgetId: 'source-budget', budgetAmount: 1,
      creation: { id: 'owner-create', expiresAt: now + 600_000, maxCreates: 2, namePrefix: 'rsi-service-' } } })
  await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
  const store = new ControlPlaneStore({ path: join(statePath, 'control.sqlite') })
  cleanup.push(async () => store.close())
  const gap = service.recordOwnerTaskFailureGap(structuredClone(source))
  const growthRun = sourceGrowthRunFixture(store.getOwnerTaskFailureReference(gap.id)!, now)
  if (withVerification) growthRun.creationAcceptance = authority
  const inspectGrowthRun = vi.fn(() => structuredClone(growthRun))
  const unregisterGrowthRun = service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1', inspect: inspectGrowthRun })
  cleanup.push(async () => unregisterGrowthRun())
  const caller = { ownerRouteId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  const request = { repository, gapId: gap.id, name: 'rsi-service-helper', mode: 'create' as const, owner: caller, growthRun,
    files: [{ path: 'README.md', content: '# Created plugin\n' }], expectedBaseCommit: git('rev-parse', 'HEAD'),
    ttlMs: 900_000, idempotencyKey: 'create-from-task', signal: new AbortController().signal, assertCurrent: () => undefined }
  // Docker remains a fixture: these bytes exercise the Host handoff, not npm
  // publication or real package behavior.
  const packArtifact = Buffer.from('fixture-package-bytes')
  const evidence: SourcePreparedEvidence = { schemaVersion: 1, kind: 'dsh-source-prepared-evidence',
    environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'fixture', pnpmVersion: 'fixture' },
    commands: [{ command: 'pnpm', args: ['check'], exitCode: 0, durationMs: 1, logDigest: 'c'.repeat(64) }],
    pack: { name: 'dsh-enhanced-rsi-service-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: packArtifact.length,
      sha256: createHash('sha256').update(packArtifact).digest('hex') }, preparedAt: now }
  const checked: build.SourceBuildResult = { treeDigest: 'e'.repeat(64), patchDigest: 'f'.repeat(64), checkedAt: now, evidence, packArtifact }
  if (withVerification) vi.mocked(build.runDockerPreparedChecks).mockImplementation(async input => {
    const snapshot = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, process.env)
    checked.treeDigest = snapshot.checkedTreeDigest
    checked.patchDigest = snapshot.checkedPatchDigest
    return checked
  })
  else vi.mocked(build.runDockerPreparedChecks).mockResolvedValue(checked)
  return { root, repository, git, service, automations, policy, store, source, owner, request, checked, growthRun, inspectGrowthRun,
    unregisterGrowthRun, authority, signing, verification, setSource: (next: OwnerForegroundLearningTask) => { activeSource = next },
    advance: (milliseconds = 1_100) => { now += milliseconds } }
}

function signedCertificate(f: Awaited<ReturnType<typeof fixture>>, planId: string,
  privateKey: KeyObject = f.signing.privateKey,
  alter?: (body: Omit<PluginCreationVerificationCertificate, 'signature'>) => void): PluginCreationVerificationCertificate {
  const prepared = f.service.inspectPreparedCreation(planId)
  const plan = prepared.plan, source = prepared.reference
  const unsigned: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/creation-verification/v1', verificationId: 'fixture-verification', authority: f.authority,
    plan: { id: plan.id, digest: plan.digest, name: plan.name, sourceTreeDigest: plan.sourceCheck!.treeDigest,
      sourcePatchDigest: plan.sourceCheck!.patchDigest, artifactSha256: plan.preparedEvidence!.pack.sha256,
      artifactBytes: plan.preparedEvidence!.pack.sizeBytes, generatorDigest: plan.generatorDigest },
    source: { referenceDigest: controlPlaneDigest(source), ownerDigest: controlPlaneDigest(source.owner),
      growthRunDigest: sourceGrowthRunDigest(plan.creation!.growthRun!) },
    contractDigest: 'a'.repeat(64), schemaDigest: 'b'.repeat(64),
    environment: { node: 'node22', cordis: 'cordis4', tools: 'tools1', systemPrompt: 'prompt1' },
    model: plan.creation!.growthRun!.model,
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'contract-session', sourceReview: 'review-session' },
    observations: [{ caseId: 'case-one', jobId: 'job-one', operationDigest: 'c'.repeat(64), observationDigest: 'd'.repeat(64) },
      { caseId: 'case-two', jobId: 'job-two', operationDigest: 'e'.repeat(64), observationDigest: 'f'.repeat(64) }],
    reviewDigest: '1'.repeat(64), verifiedAt: Date.now(), expiresAt: Date.now() + 300_000,
  }
  alter?.(unsigned)
  return { ...unsigned, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(unsigned)), privateKey).toString('base64url') }
}

it('automatically verifies a pinned task creation after prepare and retains exact signed evidence without replay', async () => {
  const f = await fixture(true)
  expect(f.service.inspectSourceCreationAcceptanceAuthority()).toEqual(f.authority)
  f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId) }))
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getSourcePlan(planId).status).toBe('pending-approval')
  expect(f.store.getCreationVerificationStatus(planId)).toBe('verified')
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'verified', updatedAt: expect.any(Number) })
  const certificate = f.service.inspectVerifiedCreation(planId)
  expect(certificate).toMatchObject({ protocol: 'assistant-growth/creation-verification/v1', plan: { id: planId } })
  const review = await f.service.inspectPreparedCreationReviewContext(planId, new AbortController().signal)
  expect(review.changedPaths).toContain(`plugins/${f.request.name}/README.md`)
  expect(review.patch).toContain('Created plugin')
  const plan = f.store.getSourcePlan(planId), scope = [...new Set(plan.scope)].sort()
  expect(createHash('sha256').update('dsh-source-patch-v2\0')
    .update(`${plan.baseCommit}\0${JSON.stringify(scope)}\0`).update(review.patch).digest('hex'))
    .toBe(plan.sourceCheck!.patchDigest)
  expect(f.store.listPreparedSourceApprovalJobs(false, false, false, true)).toHaveLength(0)
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).toHaveBeenCalledOnce()
  expect(f.service.inspectVerifiedCreation(planId)).toEqual(certificate)
  f.owner.generation += 1
  expect(() => f.service.inspectVerifiedCreation(planId)).toThrow(/task repair source or owner changed/)
  expect(() => f.service.inspectCreationVerification(planId)).toThrow(/task repair source or owner changed/)
  f.owner.generation -= 1
  f.setSource({ ...f.source, source: { ...f.source.source, objective: 'owner corrected the original task' } })
  expect(() => f.service.inspectVerifiedCreation(planId)).toThrow(/task repair source or owner changed/)
  f.setSource(f.source)
  f.advance(300_000)
  expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
}, 60_000)

it('retains unknown verification without another native model dispatch and leaves old unpinned creates pending', async () => {
  const f = await fixture(true)
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getCreationVerificationStatus(planId)).toBe('unknown')
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'unknown', reason: 'independent-verifier-unknown' })
  expect(f.store.getCreationVerification(planId)).toBeUndefined()
  expect(f.store.listPreparedSourceApprovalJobs(false, false, false, true)).toHaveLength(0)
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).toHaveBeenCalledOnce()
  expect(f.store.getSourcePlan(planId).status).toBe('pending-approval')
}, 60_000)

it('keeps a dispatched claim visible and excludes it from continuation while the verifier is in flight', async () => {
  const f = await fixture(true)
  let finish!: (value: unknown) => void
  f.verification.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance()
  const tick = f.automations.tick()
  await vi.waitFor(() => expect(f.verification).toHaveBeenCalledOnce())
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'claimed', updatedAt: expect.any(Number) })
  expect(f.store.listPreparedSourceApprovalJobs(false, false, false, true)).toHaveLength(0)
  finish({ status: 'unknown', reason: 'schema-observation-unknown' })
  await tick; await f.automations.whenIdle()
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'unknown', reason: 'schema-observation-unknown' })
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).toHaveBeenCalledOnce()
}, 60_000)

it('stores only a bounded rejection code and does not dispatch the verifier again', async () => {
  const f = await fixture(true)
  f.verification.mockResolvedValue({ status: 'rejected', reason: 'case-mismatch' })
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'rejected', reason: 'case-mismatch' })
  expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).toHaveBeenCalledOnce()
}, 60_000)

it('does not retrofit an old run lacking the pre-author policy and rejects a changed pinned policy', async () => {
  const f = await fixture(true)
  f.growthRun.creationAcceptance = { ...f.authority, authorityDigest: '8'.repeat(64) }
  await expect(f.service.enqueueSourceJob(f.request)).rejects.toThrow(/creation acceptance policy changed/)
  delete f.growthRun.creationAcceptance
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getSourcePlan(planId).status).toBe('pending-approval')
  expect(f.store.getCreationVerificationStatus(planId)).toBeUndefined()
  expect(() => f.store.withOwnerTaskFailureGapAdmission(f.request.gapId,
    () => f.store.claimCreationVerification(planId))).toThrow(/pre-author policy binding/)
  expect(f.verification).not.toHaveBeenCalled()
  expect(f.store.listPreparedSourceApprovalJobs(false, false, false, true)).toHaveLength(0)
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).not.toHaveBeenCalled()
}, 60_000)

it('rejects a foreign signature and source correction before certificate use', async () => {
  const f = await fixture(true), foreign = generateKeyPairSync('ed25519')
  f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId, foreign.privateKey) }))
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getCreationVerificationStatus(planId)).toBe('unknown')
  expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'unknown', reason: 'independent-verification-unsettled' })
  expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
  expect(f.verification).toHaveBeenCalledOnce()
}, 60_000)

it.each(['plan', 'pack', 'reference', 'model', 'budget', 'schema', 'policy'] as const)(
  'rejects a signed certificate with a mismatched %s binding', async mismatch => {
    const f = await fixture(true)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId,
      f.signing.privateKey, body => {
        if (mismatch === 'plan') body.plan.digest = '2'.repeat(64)
        if (mismatch === 'pack') body.plan.artifactSha256 = '2'.repeat(64)
        if (mismatch === 'reference') body.source.referenceDigest = '2'.repeat(64)
        if (mismatch === 'model') body.model = { provider: 'other-provider', model: 'other-model' }
        if (mismatch === 'budget') body.budget.maxOutputTokens = 40_000
        if (mismatch === 'schema') body.schemaDigest = 'not-a-digest'
        if (mismatch === 'policy') body.authority = { ...body.authority, authorityDigest: '2'.repeat(64) }
      }) }))
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    expect(f.store.getCreationVerificationStatus(planId)).toBe('unknown')
    expect(f.store.getCreationVerification(planId)).toBeUndefined()
    expect(f.verification).toHaveBeenCalledOnce()
  }, 60_000)

it('refuses a changed prepared worktree after independent result and never replays the claim', async () => {
  const f = await fixture(true)
  f.verification.mockImplementation(async request => {
    const certificate = signedCertificate(f, request.planId)
    const plan = f.store.getSourcePlan(request.planId)
    await writeFile(join(plan.worktree, 'plugins', plan.name, 'README.md'), '# changed after check\n')
    return { status: 'verified', certificate }
  })
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getCreationVerificationStatus(planId)).toBe('unknown')
  expect(f.store.getCreationVerification(planId)).toBeUndefined()
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.verification).toHaveBeenCalledOnce()
}, 60_000)

it('runs an ordinary owner failure through native scheduling into a checked new-plugin plan', async () => {
  const f = await fixture(), originalCatalog = await readFile(join(f.repository, 'plugins/README.md'), 'utf8')
  const reserve = vi.spyOn(f.policy, 'reserve')
  expect(f.service.getSourceCreationNamespace()).toEqual({ namePrefix: 'rsi-service-' })
  const view = await f.service.inspectCreateSource({ repository: f.repository, name: f.request.name, paths: ['src/index.ts'] })
  expect(view.baseCommit).toBe(f.request.expectedBaseCommit)
  const job = await f.service.enqueueSourceJob(f.request)
  expect(job).toMatchObject({ mode: 'create', status: 'queued' })
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const completed = f.service.inspectSourceJob({ id: job.id, owner: f.request.owner })
  expect(completed.status).toBe('prepared')
  const plan = f.store.getSourcePlan(completed.planId!)
  expect(plan).toMatchObject({ mode: 'prepared-create', status: 'pending-approval', creation: { grant: { id: 'owner-create' } } })
  expect(plan.creation?.growthRun).toEqual(f.growthRun)
  expect(f.store.getSourceJob(job.id)?.intent.creation?.growthRun).toEqual(f.growthRun)
  expect(f.growthRun.model).not.toEqual(f.source.source.modelSelection)
  expect(plan.scope).toEqual(['plugins/README.md', 'plugins/rsi-service-helper', 'pnpm-lock.yaml'])
  expect(plan.preparedEvidence).toEqual(f.checked.evidence)
  const candidate = f.service.inspectPreparedCreation(plan.id)
  expect(candidate.protocol).toBe('dsh-prepared-creation/v1')
  expect(candidate.artifact).toEqual(f.checked.packArtifact)
  expect(candidate.job.id).toBe(job.id)
  expect(candidate.plan.creation?.growthRun).toEqual(f.growthRun)
  expect(candidate.source.source.modelSelection).toEqual(f.source.source.modelSelection)
  expect(candidate.reference.projection).toEqual(f.source.canonical.projection)
  expect(JSON.parse(await readFile(join(plan.worktree, 'plugins', plan.name, 'package.json'), 'utf8')).version).toBe('0.1.0')
  expect(await readFile(join(f.repository, 'plugins/README.md'), 'utf8')).toBe(originalCatalog)
  expect(reserve).toHaveBeenCalledOnce()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  expect(vi.mocked(build.runDockerPreparedChecks).mock.calls[0]![0].capturePack).toBe(true)
  f.inspectGrowthRun.mockImplementationOnce(() => ({ ...f.growthRun, budget: { ...f.growthRun.budget, amount: f.growthRun.budget.amount + 1 } }))
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('immutable binding changed')
  await f.unregisterGrowthRun()
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('producer unavailable')
  await f.automations.tick(); await f.automations.whenIdle()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  f.owner.generation += 1
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('task repair source or owner changed')
}, 30_000)

it('rejects an unbound or caller-spoofed task creation before durable enqueue', async () => {
  const f = await fixture()
  const { growthRun: _omitted, ...unbound } = f.request
  await expect(f.service.enqueueSourceJob(unbound)).rejects.toThrow('requires a frozen source growth run')
  const forged = structuredClone(f.growthRun)
  forged.budget.amount += 1
  await expect(f.service.enqueueSourceJob({ ...f.request, growthRun: forged })).rejects.toThrow('immutable binding changed')
  expect(f.store.listSourceJobs()).toHaveLength(0)
  expect(f.inspectGrowthRun).toHaveBeenCalled()
}, 30_000)

it('binds an idempotency key to the exact run and budget', async () => {
  const f = await fixture()
  const first = await f.service.enqueueSourceJob(f.request)
  expect((await f.service.enqueueSourceJob(f.request)).id).toBe(first.id)
  const replacement = structuredClone(f.growthRun)
  replacement.runId = 'usage-another-run'; replacement.native.automationId = replacement.runId
  replacement.budget.amount += 1
  f.inspectGrowthRun.mockImplementation(() => structuredClone(replacement))
  await expect(f.service.enqueueSourceJob({ ...f.request, growthRun: replacement })).rejects.toThrow('source job idempotency conflict')
  expect(f.store.getSourceJob(first.id)?.intent.creation?.growthRun).toEqual(f.growthRun)
}, 30_000)

it('keeps a queued creation pending without a producer and resumes via Host readiness nudge', async () => {
  const f = await fixture()
  const queued = await f.service.enqueueSourceJob(f.request)
  f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('queued')
  expect(build.runDockerPreparedChecks).not.toHaveBeenCalled()
  let ready = false
  const inspect = vi.fn(() => { if (!ready) throw new SourceGrowthRunUnavailableError(); return structuredClone(f.growthRun) })
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1', inspect })
  expect(f.store.getSourceJob(queued.id)?.status).toBe('queued')
  ready = true
  f.service.reconcileSourceGrowthRuns()
  expect(f.store.getSourceJob(queued.id)?.dispatchAt).toBeGreaterThan(f.store.getSourceJob(queued.id)!.createdAt + 1000)
  f.advance()
  await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('prepared')
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  f.service.reconcileSourceGrowthRuns()
  await f.automations.tick(); await f.automations.whenIdle()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  await unregister()
}, 30_000)

it('revokes and drains a claimed growth creation when its producer is disposed', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const building = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async () => { entered(); await gate; return f.checked })
  const queued = await f.service.enqueueSourceJob(f.request)
  f.advance()
  await f.automations.tick()
  await building
  let drained = false
  const disposing = f.unregisterGrowthRun().then(() => { drained = true })
  expect(f.store.getSourceJob(queued.id)?.status).toBe('unknown')
  expect(() => f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => f.growthRun })).toThrow('already registered')
  await Promise.resolve()
  expect(drained).toBe(false)
  release()
  await disposing
  await f.automations.whenIdle()
  expect(drained).toBe(true)
  expect(f.store.getSourceJob(queued.id)?.status).toBe('unknown')
  expect(f.store.getSourceJob(queued.id)?.planId).toBeUndefined()
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => f.growthRun })
  await f.automations.tick(); await f.automations.whenIdle()
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  await unregister()
}, 30_000)

it.each(['before-native-ack', 'after-native-ack'] as const)('recovers persisted queued rearm %s without a second job', async stage => {
  const f = await fixture()
  const queued = await f.service.enqueueSourceJob(f.request)
  await f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const exact = f.automations.reconcileSystemExact.bind(f.automations)
  const calls = vi.spyOn(f.automations, 'reconcileSystemExact').mockImplementationOnce(input => {
    if (stage === 'after-native-ack') exact(input)
    throw new Error('simulated crash before Control Plane definition bind')
  })
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => structuredClone(f.growthRun) })
  const pending = f.store.getSourceJob(queued.id)!
  expect(pending.definitionHash).toBeUndefined()
  expect(pending).toMatchObject({ status: 'queued',
    previousDefinitionHash: expect.stringMatching(/^[a-f0-9]{64}$/u), previousDefinitionVersion: expect.any(Number), dispatchAt: expect.any(Number) })
  f.service.reconcileSourceGrowthRuns()
  const rebound = f.store.getSourceJob(queued.id)!
  expect(rebound.status).toBe('queued')
  expect(rebound.definitionHash).toMatch(/^[a-f0-9]{64}$/u)
  expect(rebound.previousDefinitionHash).toBeUndefined()
  expect(rebound.dispatchAt).toBe(pending.dispatchAt)
  expect(calls).toHaveBeenCalledTimes(2)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('prepared')
  expect(f.store.listSourceJobs()).toHaveLength(1)
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  await unregister()
}, 30_000)

it('rearms when the new native occurrence fires before its Control Plane bind', async () => {
  const f = await fixture()
  const queued = await f.service.enqueueSourceJob(f.request)
  await f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const exact = f.automations.reconcileSystemExact.bind(f.automations)
  vi.spyOn(f.automations, 'reconcileSystemExact').mockImplementationOnce(input => {
    exact(input)
    throw new Error('simulated crash after native ACK')
  })
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => structuredClone(f.growthRun) })
  const pending = f.store.getSourceJob(queued.id)!
  expect(pending.previousDefinitionHash).toBeDefined()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const recovered = f.store.getSourceJob(queued.id)!
  expect(recovered.status).toBe('queued')
  expect(recovered.dispatchAt).toBeGreaterThan(pending.dispatchAt!)
  expect(build.runDockerPreparedChecks).not.toHaveBeenCalled()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('prepared')
  expect(f.store.listSourceJobs()).toHaveLength(1)
  expect(build.runDockerPreparedChecks).toHaveBeenCalledOnce()
  await unregister()
}, 30_000)

it('does not trust a different native definition during queued rearm recovery', async () => {
  const f = await fixture()
  const queued = await f.service.enqueueSourceJob(f.request)
  await f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  let request!: Parameters<typeof f.automations.reconcileSystemExact>[0]
  vi.spyOn(f.automations, 'reconcileSystemExact').mockImplementationOnce(input => { request = input; throw new Error('before native ACK') })
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => structuredClone(f.growthRun) })
  const pending = f.store.getSourceJob(queued.id)!
  expect(pending.previousDefinitionHash).toBeDefined()
  f.automations.reconcileSystem({ owner: request.owner, automationId: request.automationId,
    idempotencyKey: 'external-definition-drift', desiredStatus: 'active',
    definition: { ...request.definition, schedule: { kind: 'at', at: new Date(Date.now() + 10_000).toISOString() } } })
  f.service.reconcileSourceGrowthRuns()
  expect(f.store.getSourceJob(queued.id)).toMatchObject({ status: 'failed', failureCode: 'source-job-reconcile-rejected', dispatchAt: pending.dispatchAt })
  expect(f.store.getSourceJob(queued.id)?.previousDefinitionHash).toBeUndefined()
  expect(build.runDockerPreparedChecks).not.toHaveBeenCalled()
  await unregister()
}, 30_000)

it('expires an unacknowledged rearm without carrying its prior native tuple into a failed row', async () => {
  const f = await fixture()
  const queued = await f.service.enqueueSourceJob(f.request)
  await f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  vi.spyOn(f.automations, 'reconcileSystemExact').mockImplementationOnce(() => { throw new Error('native ACK unavailable') })
  const unregister = f.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1',
    inspect: () => structuredClone(f.growthRun) })
  expect(f.store.getSourceJob(queued.id)?.previousDefinitionHash).toBeDefined()
  f.advance(601_000)
  expect(f.service.inspectSourceJob({ id: queued.id, owner: f.request.owner })).toMatchObject({ status: 'failed', failureCode: 'source-job-expired' })
  expect(f.store.getSourceJob(queued.id)?.previousDefinitionHash).toBeUndefined()
  await unregister()
}, 30_000)

it.each(['manifest', 'lock', 'owner', 'artifact', 'missing-pack', 'pack-bytes'] as const)('rejects late %s drift before committing a creation plan', async drift => {
  const f = await fixture()
  vi.mocked(build.runDockerPreparedChecks).mockImplementationOnce(async input => {
    if (drift === 'manifest') await writeFile(join(input.worktree, 'plugins', input.name, 'package.json'), '{}\n')
    if (drift === 'lock') await writeFile(join(input.worktree, 'pnpm-lock.yaml'), 'tampered\n')
    if (drift === 'owner') f.owner.generation += 1
    if (drift === 'artifact') f.checked.evidence.pack.version = '9.9.9'
    if (drift === 'missing-pack') delete f.checked.packArtifact
    if (drift === 'pack-bytes') f.checked.packArtifact = Buffer.from('different-package-bytes')
    return f.checked
  })
  const job = await f.service.enqueueSourceJob(f.request)
  const worktree = f.store.getSourceJob(job.id)!.intent.worktree
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  // A claimed build with an unusable late result is unknown; it cannot replay
  // without reconciling the independently owned container outcome.
  expect(f.store.getSourceJob(job.id)?.status).toBe('unknown')
  expect(f.store.getSourceJob(job.id)?.planId).toBeUndefined()
  expect(f.git('worktree', 'list', '--porcelain')).not.toContain(`worktree ${worktree}\n`)
  expect(f.store.getGap(f.request.gapId).status).toBe('open')
}, 30_000)
