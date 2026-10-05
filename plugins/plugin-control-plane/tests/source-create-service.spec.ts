// Real public generator, Git worktrees, Control Plane/Automations/Policy and
// SQLite. Delivery/Evaluation and Docker are fixtures, not live acceptance.
import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { isSourceOwnerContinuation, pluginCreationVerificationSigningPayload, sourceGrowthRunDigest, SourceGrowthRunUnavailableError,
  type CreationAcceptanceAuthorityRef, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { ForegroundToolCallAttestation, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { afterEach, expect, it, vi } from 'vitest'
import { PluginControlPlaneService, normalizeControlPlaneConfig, type Config } from '../src/service.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import * as build from '../src/source-build.ts'
import * as trust from '../src/trust.ts'
import { defaultHostAttestationPolicy } from '../src/trust.ts'
import type { SourcePreparedEvidence } from '../src/types.ts'
import type { CreationCapabilityConfig, CreationCapabilityObservation } from '../src/creation-capability-types.ts'
import { CreationCapabilityRuntime } from '../src/creation-capability-runtime.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'
import { sourceGrowthRunFixture } from './helpers/source-growth-run-fixture.ts'

vi.mock('../src/source-build.ts', async original => ({ ...await original<typeof build>(), runDockerPreparedChecks: vi.fn() }))
vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn() }))
const runnerRun = vi.hoisted(() => vi.fn())
vi.mock('@dsh-enhanced/assistant-verifier/plugin-behavior-runner', () => ({
  PluginBehaviorRunner: class {
    run = runnerRun
    close = async () => undefined
  },
}))
const candidateSchemas = [{ name: 'read_test', description: 'candidate supplied description',
  parameters: { type: 'object', additionalProperties: false, properties: { query: { type: 'string' } }, required: ['query'] } }]
const candidateEnvironment = { node: 'v22.19.0', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' }
const candidateSchemaDigest = createHash('sha256').update(JSON.stringify(candidateSchemas)).digest('hex')
const baselineRepository = fileURLToPath(new URL('../../..', import.meta.url)).replace(/\/$/u, '')
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.resetAllMocks() })

async function fixture(withVerification = false, withAdoption = false, withRetention = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-created-service-')))
  const { repository } = await createSourceCreationFixture(baselineRepository, join(root, 'source'))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim()
  const ctx = new Context(), statePath = join(root, 'control'), catalogPath = join(root, 'catalog.json')
  let capability: CreationCapabilityConfig | undefined
  if (withAdoption) {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
    ctx.tools.register(defineTool({ name: 'existing_probe', description: 'fixture existing tool', parameters: {},
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [] }, execute: async () => ({}) }))
    const key = generateKeyPairSync('ed25519')
    const keyPath = join(root, 'adoption.key'), stateRoot = join(root, 'runner')
    await chmod(root, 0o700)
    await mkdir(stateRoot, { mode: 0o700 })
    await writeFile(keyPath, key.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    capability = { authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath,
      owner: { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
        principalVersion: 1, workspace: root, agentPreset: 'primary' }, namePrefix: 'rsi-service-',
      expiresAt: Date.now() + 600_000, maxAdoptions: 1, maxTools: 1, maxCallsPerAdoption: 2,
      maxCallRecords: 2, maxInputBytes: 1024,
      runner: { stateRoot, image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker',
        expiresAt: Date.now() + 600_000, maxRuns: 3, maxTotalDurationMs: 60_000,
        maxDurationMs: 10_000, maxOutputBytes: 65_536 } }
    if (withRetention) {
      capability.retention = { maximumLifetimeMs: 1_800_000 }
      capability.expiresAt = Date.now() + 2_000_000
      capability.runner.expiresAt = Date.now() + 2_000_000
    }
  }
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
  const source: OwnerForegroundLearningTask = { protocol: 'assistant-delivery/owner-foreground-learning/v1', owner: { ...owner },
    canonical: { scope: { workspace: root, preset: 'primary' }, scopeKey: 'scope', scopeWatermark: 1,
      triggerOutcomeId: 'feedback', situation: 'foreground:task',
      objective: { outcomeId: 'feedback', status: 'not-achieved', source: { kind: 'evaluator', id: 'assistant-verifier' },
        evaluator: { id: 'assistant-verifier', version: '1' }, evidence: [], occurredAt: now },
      projection: { subjectKind: 'foreground-turn', subjectRef: 'inbox', version: 1, digest: 'b'.repeat(64), disposition: 'upsert' } },
    judgement: 'independent-verifier', source: { sessionId: 'session', inboxId: 'inbox', objective: 'ordinary failed task',
      quiescent: true, truncated: false, modelSelectionState: 'frozen', modelSelection: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } } }
  let activeSource: OwnerForegroundLearningTask = source
  let laterSource: OwnerForegroundLearningTask | undefined
  const taskChangeListeners = new Set<() => void>()
  const foregroundCall = vi.fn<() => ForegroundToolCallAttestation | undefined>(() => undefined)
  const deliveryPorts = { validateOwnerRoute: () => structuredClone(owner),
    validateOwnerAgentForRoute: (agent: { owner?: typeof owner }) => agent.owner ? structuredClone(agent.owner) : undefined,
    inspectOwnerForegroundToolCall: foregroundCall,
    inspectOwnerForegroundLearningTask: (input: { outcomeId: string }) => {
      const selected = input.outcomeId === laterSource?.canonical.triggerOutcomeId ? laterSource : activeSource
      return isSourceOwnerContinuation(owner, selected.owner) ? structuredClone(selected) : undefined
    },
    inspectOwnerForegroundTaskSource: (input: { inboxId: string }) => input.inboxId === laterSource?.source.inboxId
      ? { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        owner: { principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion },
        binding: { id: 'next-binding', version: laterSource.owner.bindingVersion,
          generation: laterSource.owner.generation, sessionId: laterSource.source.sessionId } } : undefined }
  const evaluationPorts = { canonicalHostScope: (input: unknown) => input,
    getTrustedForegroundLearningProjection: (input: { inboxId: string }) =>
      input.inboxId === laterSource?.source.inboxId ? structuredClone(laterSource.canonical)
        : input.inboxId === activeSource.source.inboxId ? structuredClone(activeSource.canonical) : undefined,
    withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => ({ matched: true, value: callback() }),
    onTrustedTaskChange: (listener: () => void) => { taskChangeListeners.add(listener); return () => { taskChangeListeners.delete(listener) } } }
  ctx.provide('assistantDelivery' as never, deliveryPorts)
  ctx.provide('assistantEvaluation' as never, evaluationPorts)
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
  const config: Config = { statePath, catalogPath, trustPath: join(root, 'trust.json'),
    ...(withVerification ? { creationVerifications: { authority, publicKey } } : {}),
    ...(capability ? { creationCapabilities: capability } : {}),
    sourceBuild: { dockerPath: '/usr/bin/docker', image: `fixture@sha256:${'a'.repeat(64)}`, timeoutMs: 60_000, versioning: 'patch',
      memoryMiB: 128, cpus: 1, pidsLimit: 16, workspaceMiB: 64, outputBytes: 4096 },
    sourceJobs: { authorityId: 'source-grant', expiresAt: now + 600_000, maxSubmissions: 3, repository,
      ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary', budgetId: 'source-budget', budgetAmount: 1,
      creation: { id: 'owner-create', expiresAt: now + 600_000, maxCreates: 2, namePrefix: 'rsi-service-' } } }
  const service = new PluginControlPlaneService(ctx, config)
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
  return { root, repository, git, ctx, config, capability, service, automations, policy, store, source, owner,
    deliveryPorts, evaluationPorts, foregroundCall, publicKey, verification, request, checked, growthRun, inspectGrowthRun,
    unregisterGrowthRun, authority, signing, setSource: (next: OwnerForegroundLearningTask) => { activeSource = next },
    setLaterSource: (next: OwnerForegroundLearningTask) => { laterSource = next },
    notifyTaskChange: () => { for (const listener of taskChangeListeners) listener() },
    taskChangeListenerCount: () => taskChangeListeners.size,
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
  f.owner.principalVersion += 1
  expect(() => f.service.inspectVerifiedCreation(planId)).toThrow(/task repair source or owner changed/)
  expect(() => f.service.inspectCreationVerification(planId)).toThrow(/task repair source or owner changed/)
  f.owner.principalVersion -= 1
  f.setSource({ ...f.source, source: { ...f.source.source, objective: 'owner corrected the original task' } })
  expect(() => f.service.inspectVerifiedCreation(planId)).toThrow(/task repair source or owner changed/)
  f.setSource(f.source)
  f.advance(300_000)
  expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
}, 60_000)

it.each(['correction', 'withdrawal'] as const)(
  'native task creation verifies, adopts and revokes its live wrapper after %s', async change => {
    const f = await fixture(true, true)
    const reserve = vi.spyOn(f.policy, 'reserve')
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId,
      f.signing.privateKey, body => { body.schemaDigest = candidateSchemaDigest; body.environment = candidateEnvironment }) }))
    runnerRun.mockImplementation(async (input: { artifact: Buffer; operation: { kind: string;
      calls?: readonly { id: string; toolName: string }[] } }): Promise<CreationCapabilityObservation> => {
      const common = { status: 'observed' as const, quiescent: true,
        artifactSha256: createHash('sha256').update(input.artifact).digest('hex'),
        schemaDigest: candidateSchemaDigest, environment: candidateEnvironment }
      return input.operation.kind === 'discover' ? { ...common, schemas: candidateSchemas }
        : { ...common, calls: input.operation.calls!.map(call => ({ id: call.id, toolName: call.toolName,
          result: { isError: false, value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] } })) }
    })
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    expect(f.store.getSourcePlan(planId)).toMatchObject({ mode: 'prepared-create', status: 'pending-approval' })
    expect(f.store.getCreationVerificationStatus(planId)).toBe('verified')
    expect(f.taskChangeListenerCount()).toBeGreaterThan(0)
    const adopted = f.service.inspectCreatedCapability(planId)
    expect(adopted).toMatchObject({ status: 'active', aliases: [expect.stringMatching(/^evolved_rsi_service_helper_[a-f0-9]{8}_0$/u)] })
    const adoption = () => {
      const db = new DatabaseSync(join(f.config.statePath, 'creation-adoptions.sqlite'))
      try {
        const row = db.prepare('SELECT status, receipt_json FROM adoptions WHERE plan_id = ?').get(planId) as
          { status: string; receipt_json: string }
        const receipt = JSON.parse(row.receipt_json) as { expiresAt: number; adoptedAt: number }
        const calls = (db.prepare('SELECT count(*) AS count FROM calls WHERE plan_id = ?').get(planId) as { count: number }).count
        return { status: row.status, expiresAt: receipt.expiresAt, adoptedAt: receipt.adoptedAt, calls }
      } finally { db.close() }
    }
    const adoptedBefore = adoption()
    const certificate = structuredClone(f.service.inspectVerifiedCreation(planId))
    const frozenJob = structuredClone(f.store.getSourceJob(job.id)!)
    const alias = adopted!.aliases[0]!
    expect(f.ctx.tools.get(alias)).toBeDefined()
    expect(f.ctx.tools.get('existing_probe')).toBeDefined()
    expect(f.verification).toHaveBeenCalledOnce()
    expect(runnerRun).toHaveBeenCalledTimes(1)
    expect(reserve).toHaveBeenCalledOnce()
    const tool = f.ctx.tools.get(alias)!
    const signal = new AbortController().signal
    const valid = { callId: 'first-call', agent: { session: { id: 'session-1' }, owner: f.owner }, signal } as unknown as ToolRunContext
    await expect(tool.execute({ query: 'hello' }, { ...valid, agent: undefined } as unknown as ToolRunContext)).rejects.toThrow(/unavailable|authenticated/)
    await expect(tool.execute({ query: 'hello' }, { ...valid, agent: { session: { id: 'session-1' },
      owner: { ...f.owner, principalId: 'other' } } } as unknown as ToolRunContext)).rejects.toThrow(/current authorized owner/)
    expect(runnerRun).toHaveBeenCalledTimes(1)
    await expect(tool.execute({ query: 'hello' }, valid)).resolves.toEqual({ value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] })
    expect(f.service.inspectCreatedCapabilityCalls(planId)).toMatchObject([{ attribution: 'unattributed' }])
    expect(f.foregroundCall).toHaveBeenLastCalledWith({ agent: valid.agent, authorityId: 'route',
      callId: 'first-call', toolName: alias, argumentsJson: JSON.stringify({ query: 'hello' }) })
    expect(runnerRun).toHaveBeenCalledTimes(2)
    f.owner.generation += 1; f.owner.bindingVersion += 1
    expect(f.service.inspectVerifiedCreation(planId)).toEqual(certificate)
    expect(f.store.getSourceJob(job.id)?.intent).toEqual(frozenJob.intent)
    expect(f.store.getSourceJob(job.id)?.expiresAt).toBe(frozenJob.expiresAt)
    expect(adoption()).toEqual({ ...adoptedBefore, calls: 1 })
    expect(f.service.inspectCreatedCapability(planId)).toEqual(adopted)
    const nextSession = { ...valid, callId: 'second-call', agent: { session: { id: 'session-2' }, owner: { ...f.owner } } } as unknown as ToolRunContext
    f.advance(1)
    // Delivery/Evaluation are fixture peers here; the Control Plane, Git source,
    // signed certificate and adoption/call journals are real in this test.
    f.setLaterSource({ ...f.source, owner: { ...f.owner },
      canonical: { ...f.source.canonical, scopeWatermark: 2, triggerOutcomeId: 'later-feedback',
        objective: { ...f.source.canonical.objective!, outcomeId: 'later-feedback', status: 'achieved' },
        projection: { ...f.source.canonical.projection, subjectRef: 'subsequent-inbox',
          digest: '7'.repeat(64) } },
      source: { ...f.source.source, inboxId: 'subsequent-inbox', sessionId: 'session-2',
        objective: 'later ordinary task succeeded' } })
    // Contract wiring only: Delivery's real Agent/event proof is tested in its own suite.
    f.foregroundCall.mockReturnValue({ protocol: 'assistant-delivery/foreground-tool-call/v1',
      task: { protocol: 'assistant-delivery/foreground-task/v1', inboxId: 'subsequent-inbox', sessionId: 'session-2',
        scope: { workspace: f.root, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 },
        binding: { id: 'next-binding', version: f.owner.bindingVersion, generation: f.owner.generation }, dispatchedAt: Date.now() },
      turn: 2, call: { id: 'second-call', toolName: alias, eventSeq: 20, eventDigest: '8'.repeat(64),
        argumentsDigest: createHash('sha256').update(JSON.stringify({ query: 'hello-again' })).digest('hex') } })
    await expect(tool.execute({ query: 'hello-again' }, nextSession)).resolves.toEqual({ value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] })
    const callEvidence = f.service.inspectCreatedCapabilityCalls(planId)
    expect(callEvidence).toHaveLength(2)
    expect(callEvidence).toContainEqual(expect.objectContaining({ attribution: 'foreground',
      artifactSha256: f.checked.evidence.pack.sha256, schemaDigest: candidateSchemaDigest,
      foreground: expect.objectContaining({ task: expect.objectContaining({ inboxId: 'subsequent-inbox' }) }) }))
    expect(JSON.stringify(callEvidence)).not.toContain('hello-again')
    expect(JSON.stringify(callEvidence)).not.toContain('answer')
    const association = f.service.inspectCreatedCapabilityTaskAssociations(planId)
    expect(association).toMatchObject([{ planId, inboxId: 'subsequent-inbox', sessionId: 'session-2',
      callKeys: [callEvidence.find(item => item.attribution === 'foreground')!.key],
      adoptionStatus: 'active', withinSignedUseWindow: true,
      artifactSha256: f.checked.evidence.pack.sha256, schemaDigest: candidateSchemaDigest,
      task: { projection: { subjectRef: 'subsequent-inbox', disposition: 'upsert' },
        judgement: 'independent-verifier', status: 'achieved' } }])
    expect(association).toHaveLength(1)
    expect(JSON.stringify(association)).not.toMatch(/later ordinary task succeeded|hello-again|answer/)
    expect(adoption()).toEqual({ ...adoptedBefore, calls: 2 })
    expect(runnerRun).toHaveBeenCalledTimes(3)
    f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
    expect(f.verification).toHaveBeenCalledOnce()
    expect(runnerRun).toHaveBeenCalledTimes(3)
    expect(reserve).toHaveBeenCalledOnce()
    expect(f.service.inspectCreatedCapability(planId)?.status).toBe('active')
    f.setSource(change === 'correction'
      ? { ...f.source, source: { ...f.source.source, objective: 'owner corrected the original task' } }
      : { ...f.source, canonical: { ...f.source.canonical,
        projection: { ...f.source.canonical.projection, disposition: 'retract' } } })
    expect(f.service.inspectCreatedCapabilityTaskAssociations(planId)).toEqual([])
    await expect(tool.execute({ query: 'after-change' }, { ...valid, callId: 'changed-call' } as ToolRunContext)).rejects.toThrow()
    const reconcile = vi.spyOn(CreationCapabilityRuntime.prototype, 'reconcile')
    f.notifyTaskChange()
    f.notifyTaskChange()
    f.notifyTaskChange()
    await vi.waitFor(() => expect(f.service.inspectCreatedCapability(planId)?.status).toBe('closed'))
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(2))
    expect(f.ctx.tools.get(alias)).toBeUndefined()
    expect(f.ctx.tools.get('existing_probe')).toBeDefined()
    expect(runnerRun).toHaveBeenCalledTimes(3)
    await f.ctx.fiber.dispose()
    expect(reconcile).toHaveBeenCalledTimes(2)
    expect(f.taskChangeListenerCount()).toBe(0)
    f.notifyTaskChange()
  }, 60_000)

it.each(['correction', 'withdrawal'] as const)(
  'retained adoption uses the frozen artifact after plan GC, then closes on current %s', async change => {
    const f = await fixture(true, true, true)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId,
      f.signing.privateKey, body => { body.schemaDigest = candidateSchemaDigest; body.environment = candidateEnvironment }) }))
    runnerRun.mockImplementation(async (input: { artifact: Buffer; operation: { kind: string;
      calls?: readonly { id: string; toolName: string }[] } }): Promise<CreationCapabilityObservation> => {
      const common = { status: 'observed' as const, quiescent: true,
        artifactSha256: createHash('sha256').update(input.artifact).digest('hex'),
        schemaDigest: candidateSchemaDigest, environment: candidateEnvironment }
      return input.operation.kind === 'discover' ? { ...common, schemas: candidateSchemas }
        : { ...common, calls: input.operation.calls!.map(call => ({ id: call.id, toolName: call.toolName,
          result: { isError: false, value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] } })) }
    })
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    const adopted = f.service.inspectCreatedCapability(planId)!
    expect(adopted.status).toBe('active')
    const archive = f.service.inspectCreatedCapabilitySource(planId)!
    expect(archive).toMatchObject({ protocol: 'dsh-created-capability-source-archive/v1', planId,
      artifactSha256: f.checked.evidence.pack.sha256,
      source: { treeDigest: f.checked.treeDigest, patchDigest: f.checked.patchDigest } })
    expect(archive.source.files.find(file => file.path.endsWith('/README.md'))?.content).toBe('# Created plugin\n')
    expect(Object.isFrozen(archive.source.files)).toBe(true)
    const alias = adopted.aliases[0]!
    let hostCtx = f.ctx
    const execute = (callId: string) => hostCtx.tools.get(alias)!.execute({ query: 'hello' }, {
      callId, agent: { session: { id: 'session-1' }, owner: f.owner },
      signal: new AbortController().signal,
    } as unknown as ToolRunContext)
    await expect(execute('before-expiry')).resolves.toMatchObject({ value: { answer: 'ok' } })
    const producerCalls = f.inspectGrowthRun.mock.calls.length
    f.advance(901_000)
    expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
    expect(() => f.service.inspectPreparedCreation(planId)).toThrow()
    const plan = f.store.getSourcePlan(planId)
    expect(f.store.expirePreparedSourcePlan({ planId, expectedRevision: plan.revision, now: Date.now() }).status).toBe('expired')
    expect(f.store.deleteExpiredPreparedSourceArtifacts(Date.now())).toBe(1)
    expect(() => f.store.readPreparedSourceArtifact(planId)).toThrow()
    expect(f.store.getRetainedPreparedCreation(planId).job.id).toBe(job.id)
    expect(plan.worktree.startsWith(`${f.config.statePath}/source-worktrees/`)).toBe(true)
    f.git('worktree', 'remove', '--force', plan.worktree)
    expect(f.service.inspectCreatedCapabilitySource(planId)).toEqual(archive)
    expect(() => normalizeControlPlaneConfig(f.config)).not.toThrow()
    await f.unregisterGrowthRun()
    await f.ctx.fiber.dispose()
    const startHost = async () => {
      const context = new Context()
      cleanup.push(async () => context.fiber.dispose())
      await mountAgentLoopTestDependencies(context, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
      context.provide('assistantDelivery' as never, f.deliveryPorts)
      context.provide('assistantEvaluation' as never, f.evaluationPorts)
      context.provide('assistantVerifier' as never, { verifyPluginCreation: f.verification })
      new AssistantPolicyService(context, { databasePath: join(f.root, 'policy.sqlite'),
        budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
          { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: f.root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
          { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: f.root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
        ] })
      new AssistantAutomationsService(context, { databasePath: join(f.root, 'automations.sqlite'),
        runsPath: join(f.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
      return { context, service: new PluginControlPlaneService(context, f.config) }
    }
    const restored = await startHost()
    hostCtx = restored.context
    const restarted = restored.service
    await vi.waitFor(() => expect(hostCtx.tools.get(alias)).toBeDefined())
    expect(restarted.inspectCreatedCapability(planId)?.status).toBe('active')
    expect(restarted.inspectCreatedCapabilitySource(planId)).toEqual(archive)
    const originalOwner = { ...f.owner }
    f.owner.bindingVersion += 1 // Same generation must preserve the execution binding.
    expect(restarted.inspectCreatedCapabilitySource(planId)).toBeUndefined()
    Object.assign(f.owner, originalOwner)
    f.owner.generation += 1; f.owner.bindingVersion += 1 // Same owner may start a new conversation.
    expect(restarted.inspectCreatedCapabilitySource(planId)).toEqual(archive)
    f.owner.authorityHash = 'f'.repeat(64)
    expect(restarted.inspectCreatedCapabilitySource(planId)).toBeUndefined()
    f.owner.authorityHash = originalOwner.authorityHash
    f.owner.principalVersion += 2 // A → B → A still has a different authenticated owner version.
    expect(restarted.inspectCreatedCapabilitySource(planId)).toBeUndefined()
    Object.assign(f.owner, originalOwner)
    await expect(execute('after-expiry')).resolves.toMatchObject({ value: { answer: 'ok' } })
    await expect(execute('third-call')).rejects.toThrow()
    expect(f.inspectGrowthRun.mock.calls.length).toBe(producerCalls)
    expect(runnerRun).toHaveBeenCalledTimes(3)
    f.setSource(change === 'correction'
      ? { ...f.source, source: { ...f.source.source, objective: 'owner corrected the original task' } }
      : { ...f.source, canonical: { ...f.source.canonical,
        projection: { ...f.source.canonical.projection, disposition: 'retract' } } })
    await expect(execute('after-change')).rejects.toThrow()
    f.notifyTaskChange()
    await vi.waitFor(() => expect(restarted.inspectCreatedCapability(planId)?.status).toBe('closed'))
    expect(hostCtx.tools.get(alias)).toBeUndefined()
    expect(restarted.inspectCreatedCapabilitySource(planId)).toEqual(archive)
    f.advance(2_000_000)
    expect(restarted.inspectCreatedCapabilitySource(planId)).toEqual(archive)
    expect(restarted.inspectCreatedCapability(planId)?.status).toBe('closed')
    await hostCtx.fiber.dispose()
    const expiredHost = await startHost()
    hostCtx = expiredHost.context
    await vi.waitFor(() => expect(expiredHost.service.inspectCreatedCapabilitySource(planId)).toEqual(archive))
    expect(expiredHost.service.inspectCreatedCapability(planId)?.status).toBe('closed')
    expect(hostCtx.tools.get(alias)).toBeUndefined()
    expect(runnerRun).toHaveBeenCalledTimes(3)
  }, 60_000)

it('preflights independent adoption key, owner and namespace before constructing a Host service', async () => {
  const f = await fixture(true, true)
  const config = f.config, capability = f.capability!
  await writeFile(capability.keyPath, f.signing.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  expect(() => normalizeControlPlaneConfig(config)).toThrow(/signing keys must be separate/)
  const second = generateKeyPairSync('ed25519')
  await writeFile(capability.keyPath, second.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
  expect(() => normalizeControlPlaneConfig({ ...config, creationCapabilities: { ...capability,
    owner: { ...capability.owner, principalId: 'different-owner' } } })).toThrow(/does not match its authenticated creation lane/)
  expect(() => normalizeControlPlaneConfig({ ...config, creationCapabilities: { ...capability,
    namePrefix: 'other-' } })).toThrow(/does not match its authenticated creation lane/)
}, 60_000)

it.each(['schema-digest', 'environment', 'schemas'] as const)(
  'refuses %s drift between signed verification and isolated discovery without redispatch', async mismatch => {
    const f = await fixture(true, true)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId,
      f.signing.privateKey, body => { body.schemaDigest = candidateSchemaDigest; body.environment = candidateEnvironment }) }))
    runnerRun.mockImplementation(async (input: { artifact: Buffer }): Promise<CreationCapabilityObservation> => ({
      status: 'observed', quiescent: true, artifactSha256: createHash('sha256').update(input.artifact).digest('hex'),
      schemaDigest: mismatch === 'schema-digest' ? 'f'.repeat(64) : candidateSchemaDigest,
      environment: mismatch === 'environment' ? { ...candidateEnvironment, cordis: 'different' } : candidateEnvironment,
      schemas: mismatch === 'schemas' ? [{ ...candidateSchemas[0], name: 'changed_tool' }] : candidateSchemas,
    }))
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    expect(f.store.getCreationVerificationStatus(planId)).toBe('verified')
    expect(f.service.inspectCreatedCapability(planId)).toEqual({ status: 'unknown', aliases: [] })
    expect(f.ctx.tools.get('existing_probe')).toBeDefined()
    expect(runnerRun).toHaveBeenCalledTimes(1)
    f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
    expect(f.verification).toHaveBeenCalledOnce()
    expect(runnerRun).toHaveBeenCalledTimes(1)
    expect(f.service.inspectCreatedCapability(planId)?.status).toBe('unknown')
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
  let entered!: () => void
  const verifierEntered = new Promise<void>(resolve => { entered = resolve })
  let finish: ((value: unknown) => void) | undefined
  f.verification.mockImplementation(() => new Promise(resolve => { finish = resolve; entered() }))
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance()
  const tick = f.automations.tick()
  try {
    await tick
    await Promise.race([verifierEntered, f.automations.whenIdle().then(() => {
      throw new Error('native source job settled before independent verifier dispatch')
    })])
    expect(f.verification).toHaveBeenCalledOnce()
    const planId = f.store.getSourceJob(job.id)!.planId!
    expect(f.service.inspectCreationVerification(planId)).toMatchObject({ status: 'claimed', updatedAt: expect.any(Number) })
    expect(f.store.listPreparedSourceApprovalJobs(false, false, false, true)).toHaveLength(0)
  } finally {
    if (finish !== undefined) {
      finish({ status: 'unknown', reason: 'schema-observation-unknown' })
      await f.automations.whenIdle()
    }
  }
  const planId = f.store.getSourceJob(job.id)!.planId!
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
  f.owner.principalVersion += 1
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('task repair source or owner changed')
}, 30_000)

it('continues a task creation from a new session with the original owner, run and deadlines', async () => {
  const f = await fixture()
  const original = f.store.getOwnerTaskFailureReference(f.request.gapId)!.owner
  f.owner.generation += 1; f.owner.bindingVersion += 1
  const queued = await f.service.enqueueSourceJob(f.request)
  const intent = f.store.getSourceJob(queued.id)!.intent
  expect(intent.owner).toEqual(original)
  expect(intent.ownerDigest).toBe(controlPlaneDigest(original))
  expect(intent.creation?.growthRun).toEqual(f.growthRun)
  expect(intent.authority.expiresAt).toBe(f.config.sourceJobs!.expiresAt)
  expect(intent.creation?.grant.expiresAt).toBe(f.config.sourceJobs!.creation!.expiresAt)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const prepared = f.store.getSourceJob(queued.id)!
  expect(prepared.status).toBe('prepared')
  expect(f.store.getSourcePlan(prepared.planId!).creation?.growthRun).toEqual(f.growthRun)
  expect(f.service.inspectPreparedCreation(prepared.planId!).reference.owner).toEqual(original)
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
    if (drift === 'owner') f.owner.principalVersion += 1
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
