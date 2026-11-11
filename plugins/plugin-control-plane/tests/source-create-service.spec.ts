// Mechanical split of the former source-create-service.spec.ts (part 1): Linux creation
// receipts, creation planning, revision admission/recovery and pre-dispatch revision faults.

import { execFileSync } from 'node:child_process'
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { AssistantAutomationsService } from '@dsh-enhanced/assistant-automations'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { isSourceOwnerContinuation, pluginCreationVerificationSigningPayload, anySourceGrowthRunDigest as sourceGrowthRunDigest, SourceGrowthRunUnavailableError, verifyPluginRevisionVerificationCertificate, pluginRevisionVerificationSigningPayload, type RevisionRegressionAcceptanceAuthorityRef, type RevisionAcceptanceAuthorityRef, type PluginRevisionVerificationCertificate, growthObjectDigest, type SourceGrowthRunBinding, type CreationAcceptanceAuthorityRef, type PluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import type { ForegroundToolCallAttestation, OwnerForegroundLearningTask } from '@dsh-enhanced/assistant-delivery'
import { linuxRuntimeDigest, type LinuxRepositoryRunnerConfig, type LinuxRepositoryRunnerResult, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { AssistantVerifierService, compileRevisionReviewConfig, type PluginBehaviorRunnerInput, type RevisionReviewConfig } from '@dsh-enhanced/assistant-verifier'
import { linuxPluginBehaviorRuntimeDigest, type LinuxPluginBehaviorRuntime } from '@dsh-enhanced/assistant-verifier/linux-behavior-runtime'
import { afterEach, expect, it, vi } from 'vitest'
import { runPluginControl } from '../src/cli.ts'
import { PluginControlPlaneService, normalizeControlPlaneConfig, type Config } from '../src/service.ts'
import { ControlPlaneStore, controlPlaneDigest } from '../src/store.ts'
import { checkedSourceSnapshot } from '../src/source-workspace.ts'
import * as build from '../src/source-build.ts'
import * as trust from '../src/trust.ts'
import { defaultHostAttestationPolicy } from '../src/trust.ts'
import type { LinuxSourcePreparedEvidence } from '../src/types.ts'
import * as linuxBuild from '../src/linux-source-build.ts'
import { linuxSourceConfig } from './helpers/linux-source-build-fixture.ts'
import type { CreationCapabilityConfig, CreationCapabilityObservation } from '../src/creation-capability-types.ts'
import { CreationCapabilityRuntime } from '../src/creation-capability-runtime.ts'
import { createSourceCreationFixture } from './helpers/source-creation-fixture.ts'
import { sourceGrowthRunFixture } from './helpers/source-growth-run-fixture.ts'


vi.mock('../src/linux-source-build.ts', async original => ({ ...await original<typeof linuxBuild>(), runLinuxPreparedChecks: vi.fn() }))

vi.mock('../src/trust.ts', async original => ({ ...await original<typeof trust>(), loadTrustConfig: vi.fn() }))

const linuxTransport = vi.hoisted(() => ({ inspect: vi.fn<() => Promise<LinuxRepositoryRunnerResult | undefined>>(),
  run: vi.fn(), close: vi.fn(async () => undefined), verify: vi.fn(async (runtime: LinuxRuntime) => runtime),
  adoptionVerify: vi.fn(async () => undefined) }))

vi.mock('@dsh-enhanced/assistant-verifier/linux-behavior-runtime', async original => ({
  ...await original<typeof import('@dsh-enhanced/assistant-verifier/linux-behavior-runtime')>(),
  verifyLinuxPluginBehaviorAdoptionRuntime: linuxTransport.adoptionVerify,
}))

vi.mock('@dsh-enhanced/assistant-isolation', async original => ({ ...await original<typeof import('@dsh-enhanced/assistant-isolation')>(),
  verifyLinuxRuntime: linuxTransport.verify,
  LinuxRepositoryRunner: class {
    contractDigest = 'f'.repeat(64)
    runtimeDigest: string
    run = linuxTransport.run
    inspectSuccessfulExecution = linuxTransport.inspect
    close = linuxTransport.close
    constructor(config: LinuxRepositoryRunnerConfig) { this.runtimeDigest = linuxRuntimeDigest(config.runtime) }
  },
}))

const runnerRun = vi.hoisted(() => vi.fn())

// Both CP's package export and Verifier's relative import resolve to this
// built module. Stub only observation, leaving the reviewer and signer real.
vi.mock('../../assistant-verifier/lib/plugin-behavior-runner.js', () => ({
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


class InstructionReviewAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const value = this.requests.length === 1 ? {
      status: 'cases',
      cases: [
        { id: 'ordinary', toolName: 'read_test', arguments: { query: 'existing item' }, purpose: 'ordinary',
          expected: { kind: 'json-value', value: { answer: 'ok' } }, rationale: 'An existing item exercises the ordinary read behavior.' },
        { id: 'challenge', toolName: 'read_test', arguments: { query: '' }, purpose: 'challenge',
          expected: { kind: 'json-value', value: { answer: 'ok' } }, rationale: 'An empty query checks that the fixture preserves its bounded result.' },
      ],
    } : { decision: 'approved', reason: 'The revised documentation matches the observed read behavior.' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}


async function fixture(withVerification = false, withAdoption = false, withRetention = false, withRevision = false, withRegression = false, _withLinux = false, withWorkItems = false, withRealRevisionReview = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cp-created-service-')))
  const { repository } = await createSourceCreationFixture(baselineRepository, join(root, 'source'))
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim()
  const ctx = new Context(), statePath = join(root, 'control'), catalogPath = join(root, 'catalog.json')
  let capability: CreationCapabilityConfig | undefined
  if (withAdoption) {
    await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' },
      ...(withRealRevisionReview ? { workingDirectory: true as const } : {}) })
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
      runner: { backend: 'linux-native' as const, stateRoot,
        runtime: { schemaVersion: 1, runtime: { schemaVersion: 1, backend: 'linux-native', platform: `linux-${process.arch}` as 'linux-x64' | 'linux-arm64',
          sourceCommit: '1'.repeat(40), lockSha256: 'a'.repeat(64), root: { path: '/approved/observer-runtime', dev: 1, ino: 2, sha256: 'b'.repeat(64) },
          nodePath: '/approved/observer-runtime/bin/node', nodeSha256: 'c'.repeat(64), pnpmPath: '/approved/observer-runtime/pnpm/bin/pnpm.mjs',
          nativePnpmPath: '/approved/observer-runtime/pnpm-native/pnpm', nativePnpmRoot: '/approved/observer-runtime/pnpm-native',
          modulesPath: '/approved/observer-runtime/node_modules', storePath: '/approved/observer-runtime/store', cachePath: '/approved/observer-runtime/cache',
          versions: { node: 'v22.23.2', pnpm: '11.7.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
        observer: { schemaVersion: 1, sourceSha256: 'd'.repeat(64), workerSha256: 'e'.repeat(64), candidateSha256: 'f'.repeat(64),
          launcherSha256: '0'.repeat(64), parentProtectSha256: '1'.repeat(64), childProtectSha256: '2'.repeat(64) } } as LinuxPluginBehaviorRuntime,
        cgroupRoots: { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000', memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000',
          pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000', freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' },
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
    inspectOwnerModelSelection: () => structuredClone(source.source.modelSelection),
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
  let evaluationWriterHeld = false
  const evaluationPorts = { canonicalHostScope: (input: unknown) => input,
    getTrustedForegroundLearningProjection: (input: { inboxId: string }) =>
      input.inboxId === laterSource?.source.inboxId ? structuredClone(laterSource.canonical)
        : input.inboxId === activeSource.source.inboxId ? structuredClone(activeSource.canonical) : undefined,
    withTrustedCanonicalTaskWriterFence: (_input: unknown, callback: () => unknown) => {
      if (evaluationWriterHeld) throw new Error('Evaluation writer fence is not reentrant')
      evaluationWriterHeld = true
      const fenceDb = new DatabaseSync(join(root, 'evaluation-writer-fence.sqlite'))
      try { fenceDb.exec('BEGIN IMMEDIATE'); const value = callback(); fenceDb.exec('COMMIT'); return { matched: true, value } }
      finally { fenceDb.close(); evaluationWriterHeld = false }
    },
    listTrustedTaskLearningProjections: () => {
      const heads = [activeSource, ...(laterSource ? [laterSource] : [])].map(item => structuredClone(item.canonical))
      return { items: heads.map((receipt, index) => ({ watermark: index + 1, receipt })),
        nextCursor: { scopeKey: 'scope', watermark: heads.length }, scopeWatermark: activeSource.canonical.scopeWatermark, hasMore: false }
    },
    withTrustedCanonicalScopeWriterFence: (input: { scopeWatermark: number }, callback: () => unknown) =>
      input.scopeWatermark === activeSource.canonical.scopeWatermark ? { matched: true, value: callback() } : { matched: false },
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
  let revisionAuthority: RevisionAcceptanceAuthorityRef = { ...authority, protocol: 'assistant-growth/revision-acceptance-authority/v1',
    authorityId: 'fixture-revision-review', authorityDigest: '8'.repeat(64) }
  const revisionVerification = vi.fn<(_request: { planId: string }, _signal?: AbortSignal) => Promise<unknown>>()
    .mockResolvedValue({ status: 'unknown', reason: 'fixture-verifier-unavailable' })
  const regressionAuthority: RevisionRegressionAcceptanceAuthorityRef = { ...revisionAuthority,
    protocol: 'assistant-growth/revision-regression-acceptance-authority/v1', authorityId: 'fixture-regression-review', authorityDigest: '4'.repeat(64) }
  const regressionVerification = vi.fn<(_request: { planId: string }, _signal?: AbortSignal) => Promise<unknown>>()
    .mockResolvedValue({ status: 'unknown', reason: 'fixture-verifier-unavailable' })
  if (withVerification && !withRealRevisionReview) ctx.provide('assistantVerifier' as never, { verifyPluginCreation: verification,
    verifyPluginRevision: revisionVerification, verifyPluginRevisionRegression: regressionVerification })
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
    ...(withRevision ? { revisionVerifications: { authority: revisionAuthority, publicKey } } : {}),
    ...(withRegression ? { revisionRegressions: { authority: regressionAuthority, publicKey } } : {}),
    sourceBuild: { ...linuxSourceConfig(), stateRoot: join(root, 'linux-build'), expiresAt: now + 600_000,
      userNamespace: { schemaVersion: 1, ownerUid: process.getuid!(), ownerGid: process.getgid!(),
        candidateUid: process.getuid!() + 65536, candidateGid: process.getgid!() + 65536,
        hostNamespace: { dev: 1, ino: 7 }, helpers: { uid: { path: '/usr/bin/newuidmap', sha256: '1'.repeat(64) },
          gid: { path: '/usr/bin/newgidmap', sha256: '2'.repeat(64) } } },
      systemSnapshot: { schemaVersion: 1, root: { path: '/approved/system', dev: 1, ino: 3, sha256: '3'.repeat(64) },
        manifestSha256: '4'.repeat(64), bytes: 4096, entries: 16 } },
    sourceJobs: { authorityId: 'source-grant', expiresAt: now + 600_000, maxSubmissions: 3, repository,
      ownerRouteId: 'route', principalId: 'owner', workspace: root, preset: 'primary', budgetId: 'source-budget', budgetAmount: 1,
      ...(withRevision ? { revision: { id: 'owner-revise', expiresAt: now + 600_000, maxRevisions: 1, namePrefix: 'rsi-service-' } } : {}),
      creation: { id: 'owner-create', expiresAt: now + 600_000, maxCreates: 2, namePrefix: 'rsi-service-' } } }
  if (capability) {
    const build = config.sourceBuild as build.LinuxSourceBuildConfig, base = build.runtime
    const runtimeRoot = '/approved/observer-runtime'
    const runtime: LinuxPluginBehaviorRuntime = { schemaVersion: 1, runtime: { ...base,
      root: { ...base.root, path: runtimeRoot, ino: 10, sha256: '1'.repeat(64) },
      nodePath: runtimeRoot + '/bin/node', pnpmPath: runtimeRoot + '/pnpm/bin/pnpm.mjs',
      nativePnpmPath: runtimeRoot + '/pnpm-native/pnpm', nativePnpmRoot: runtimeRoot + '/pnpm-native',
      modulesPath: runtimeRoot + '/node_modules', storePath: runtimeRoot + '/store', cachePath: runtimeRoot + '/cache',
    }, observer: { schemaVersion: 1, sourceSha256: '2'.repeat(64), workerSha256: '3'.repeat(64), candidateSha256: '4'.repeat(64),
      launcherSha256: '5'.repeat(64), parentProtectSha256: '6'.repeat(64), childProtectSha256: '7'.repeat(64) } }
    const previous = capability.runner
    capability.runner = { backend: 'linux-native', runtime, cgroupRoots: build.cgroupRoots,
      stateRoot: previous.stateRoot, expiresAt: previous.expiresAt, maxRuns: previous.maxRuns,
      maxTotalDurationMs: previous.maxTotalDurationMs, maxDurationMs: previous.maxDurationMs, maxOutputBytes: previous.maxOutputBytes }
  }
  if (withRevision) {
    git('branch', '-M', 'dev')
    const remote = join(root, 'managed-source.git')
    execFileSync('/usr/bin/git', ['clone', '--bare', repository, remote], { stdio: 'pipe' })
    await chmod(remote, 0o700)
    config.sourceJobs!.baseline = { ref: 'refs/dsh-source/fixture', remote, targetBranch: 'dev', initialCommit: git('rev-parse', 'HEAD') }
  }
  if (withWorkItems) {
    config.sourceJobs!.allowedModes = ['create']
    config.sourceJobs!.maxSubmissions = 1
    config.sourceJobs!.creation!.maxCreates = 1
    config.sourceJobs!.creation!.workItemFailures = true
    if (config.creationCapabilities) config.creationCapabilities.workItemFailures = true
  }
  let realRevisionReview: { adapter: InstructionReviewAdapter; verifier: AssistantVerifierService; databasePath: string } | undefined
  if (withRealRevisionReview) {
    if (!capability || !('backend' in capability.runner) || capability.runner.backend !== 'linux-native') {
      throw new Error('instruction review fixture requires the Linux behavior descriptor')
    }
    const keyPath = join(root, 'instruction-review-key.pem')
    const stateRoot = join(root, 'revision-observer')
    await mkdir(stateRoot, { mode: 0o700 })
    const reviewKeys = generateKeyPairSync('ed25519')
    await writeFile(keyPath, reviewKeys.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 })
    const review: RevisionReviewConfig = {
      authorityId: 'fixture-real-revision-review', keyId: 'revision-review-key', keyPath,
      owner: { authorityId: owner.authorityId, authorityHash: owner.authorityHash, principalId: owner.principalId,
        principalRecordId: owner.principalRecordId, principalVersion: owner.principalVersion, workspace: owner.workspace, agentPreset: owner.agentPreset },
      namePrefix: authority.namePrefix, expiresAt: now + 600_000, maxVerifications: 1,
      runner: { ...capability.runner, stateRoot, expiresAt: now + 600_000,
        maxRuns: 3, maxTotalDurationMs: 30_000, maxDurationMs: 10_000 },
      policy: 'Check ordinary and empty queries for the read_test tool and review the actual revision patch.',
      maxInputBytes: 65_536, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2, receiptTtlMs: 30_000,
    }
    const compiled = compileRevisionReviewConfig(review)
    revisionAuthority = compiled.authority
    config.revisionVerifications = { authority: revisionAuthority, publicKey: compiled.publicKey }
    const adapter = new InstructionReviewAdapter()
    ctx.llm.registerAdapter(['supplier'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const databasePath = join(root, 'verifier.sqlite')
    const verifier = new AssistantVerifierService(ctx, { databasePath, tickIntervalMs: 0, revisionReviews: compiled.config })
    vi.spyOn(verifier, 'verifyPluginCreation').mockImplementation((request, signal) =>
      verification(request, signal) as ReturnType<AssistantVerifierService['verifyPluginCreation']>)
    realRevisionReview = { adapter, verifier, databasePath }
  }
  const service = new PluginControlPlaneService(ctx, config)
  await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
  const store = new ControlPlaneStore({ path: join(statePath, 'control.sqlite') })
  cleanup.push(async () => store.close())
  const gap = service.recordOwnerTaskFailureGap(structuredClone(source))
  const growthRun = sourceGrowthRunFixture(store.getOwnerTaskFailureReference(gap.id)!, now)
  if (withVerification) growthRun.creationAcceptance = authority
  const inspectGrowthRun = vi.fn<(_request: { runId: string; intentDigest: string }) => SourceGrowthRunBinding | undefined>(() => structuredClone(growthRun))
  const unregisterGrowthRun = service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1', inspect: inspectGrowthRun })
  cleanup.push(async () => unregisterGrowthRun())
  const caller = { ownerRouteId: 'route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  const request = { repository, gapId: gap.id, name: 'rsi-service-helper', mode: 'create' as const, owner: caller, growthRun,
    files: [{ path: 'README.md', content: '# Created plugin\n' }], expectedBaseCommit: git('rev-parse', 'HEAD'),
    ttlMs: 900_000, idempotencyKey: 'create-from-task', signal: new AbortController().signal, assertCurrent: () => undefined }
  // The build is a mock: these bytes exercise the Host handoff, not npm
  // publication or real package behavior.
  const packArtifact = Buffer.from('fixture-package-bytes')
  const pack = { name: 'dsh-enhanced-rsi-service-helper-0.1.0.tgz', version: '0.1.0', sizeBytes: packArtifact.length,
    sha256: createHash('sha256').update(packArtifact).digest('hex') }
  const buildEnvironment = { npmConfigIgnoreScripts: true as const, frozenLockfile: true as const, offline: true,
    nodeVersion: 'fixture', pnpmVersion: 'fixture' }
  const configBuild = config.sourceBuild as build.LinuxSourceBuildConfig
  const stdout = 'fixture-success\n', stderr = ''
  const linuxEvidence: LinuxSourcePreparedEvidence = { schemaVersion: 3, kind: 'dsh-source-prepared-evidence',
    boundary: 'linux-native-repository-v1', runtimeDigest: linuxRuntimeDigest(configBuild.runtime), executionContractDigest: 'f'.repeat(64),
    buildScriptSha256: createHash('sha256').update(linuxBuild.LINUX_PREPARED_SOURCE_BUILD_SCRIPT).digest('hex'),
    archive: { sizeBytes: 10240, sha256: 'a'.repeat(64) },
    receipt: { requestDigest: 'a'.repeat(64), nativeNonce: 'b'.repeat(32),
      nativeResourceId: 'linux-11111111-1111-4111-8111-111111111111', intentDigest: 'c'.repeat(64),
      resourcesDigest: 'd'.repeat(64), receiptDigest: 'e'.repeat(64) },
    environment: { ...buildEnvironment, offline: true },
    checks: ['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'],
    pack, logDigest: createHash('sha256').update(stdout + '\0' + stderr).digest('hex'), durationMs: 1, preparedAt: now }
  const checked: build.SourceBuildResult<LinuxSourcePreparedEvidence> = {
    treeDigest: 'e'.repeat(64), patchDigest: 'f'.repeat(64), checkedAt: now, evidence: linuxEvidence, packArtifact }
  const linuxChecked: build.SourceBuildResult<LinuxSourcePreparedEvidence> = checked
  let linuxExecution: LinuxRepositoryRunnerResult | undefined
  {
    const preparedLinux = linuxChecked
    vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementation(async input => {
      const snapshot = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, process.env)
      preparedLinux.treeDigest = snapshot.checkedTreeDigest
      preparedLinux.patchDigest = snapshot.checkedPatchDigest
      return preparedLinux
    })
    linuxExecution = { result: { jobId: 'native-build', status: 'succeeded', quiescent: true, exitCode: 0, stdout, stderr, artifacts: [] },
      artifacts: [{ path: linuxBuild.LINUX_SOURCE_PACK_PATH, sha256: pack.sha256, bytes: packArtifact }],
      receiptBinding: linuxEvidence.receipt, runtimeDigest: linuxEvidence.runtimeDigest, contractDigest: linuxEvidence.executionContractDigest }
    linuxTransport.inspect.mockResolvedValue(linuxExecution)
    linuxTransport.verify.mockImplementation(async runtime => runtime)
  }
  return { root, repository, git, ctx, config, capability, service, automations, policy, store, source, owner,
    deliveryPorts, evaluationPorts, foregroundCall, publicKey, verification, realRevisionReview, request, checked, linuxChecked, linuxExecution, growthRun, inspectGrowthRun,
    unregisterGrowthRun, authority, signing, revisionAuthority, revisionVerification, regressionAuthority, regressionVerification, setSource: (next: OwnerForegroundLearningTask) => { activeSource = next },
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
  const build = f.config.sourceBuild
  const linuxBuildBackend = !!build && 'backend' in build && build.backend === 'linux-native'
  const unsignedBase: Omit<PluginCreationVerificationCertificate, 'signature'> = {
    protocol: linuxBuildBackend ? 'assistant-growth/creation-verification/v3' : 'assistant-growth/creation-verification/v1',
    verificationId: 'fixture-verification', authority: f.authority,
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
  alter?.(unsignedBase)
  const unsigned = unsignedBase
  if (unsigned.protocol === 'assistant-growth/creation-verification/v3' && unsigned.execution === undefined
    && build && 'backend' in build && build.backend === 'linux-native') {
    const runner = f.capability?.runner
    const runtimeDigest = runner && 'backend' in runner && runner.backend === 'linux-native'
      ? linuxPluginBehaviorRuntimeDigest(runner.runtime) : linuxRuntimeDigest(build.runtime)
    unsigned.execution = { boundary: 'linux-native-process-seccomp-v1',
      runtimeDigest,
      buildRuntimeDigest: f.linuxChecked?.evidence.runtimeDigest ?? 'b'.repeat(64),
      buildEvidenceDigest: f.linuxChecked ? controlPlaneDigest(f.linuxChecked.evidence) : 'c'.repeat(64),
      observerPreparationDigest: '2'.repeat(64) }
  }
  return { ...unsigned, signature: sign(null, Buffer.from(pluginCreationVerificationSigningPayload(unsigned)), privateKey).toString('base64url') }
}


function signedAdoptionCertificate(f: Awaited<ReturnType<typeof fixture>>, planId: string): PluginCreationVerificationCertificate {
  return signedCertificate(f, planId, f.signing.privateKey, body => {
    body.schemaDigest = candidateSchemaDigest; body.environment = candidateEnvironment
    const runner = f.capability?.runner
    if (runner && 'backend' in runner && runner.backend === 'linux-native') {
      body.protocol = 'assistant-growth/creation-verification/v3'
      body.execution = { boundary: 'linux-native-process-seccomp-v1', runtimeDigest: linuxPluginBehaviorRuntimeDigest(runner.runtime),
        buildRuntimeDigest: f.linuxChecked!.evidence.runtimeDigest,
        buildEvidenceDigest: controlPlaneDigest(f.linuxChecked!.evidence), observerPreparationDigest: '2'.repeat(64) }
    }
  })
}


function installCandidateRunner(f: Awaited<ReturnType<typeof fixture>>): void {
  runnerRun.mockImplementation(async (input: { artifact: Buffer; operation: { kind: string;
    calls?: readonly { id: string; toolName: string }[] } }): Promise<CreationCapabilityObservation> => {
    const configured = f.capability!.runner
    const common = { status: 'observed' as const, quiescent: true,
      artifactSha256: createHash('sha256').update(input.artifact).digest('hex'),
      schemaDigest: candidateSchemaDigest, environment: candidateEnvironment,
      ...('backend' in configured && configured.backend === 'linux-native'
        ? { boundary: 'linux-native-process-seccomp-v1' as const, runtimeDigest: linuxPluginBehaviorRuntimeDigest(configured.runtime) } : {}) }
    return input.operation.kind === 'discover' ? { ...common, schemas: candidateSchemas }
      : { ...common, calls: input.operation.calls!.map(call => ({ id: call.id, toolName: call.toolName,
        result: { isError: false, value: { answer: 'ok' }, content: [{ type: 'text', text: 'ok' }] } })) }
  })
}


async function startCapabilityHost(f: Awaited<ReturnType<typeof fixture>>, verifierExtras: Record<string, unknown> = {}) {
  const context = new Context()
  cleanup.push(async () => context.fiber.dispose())
  await mountAgentLoopTestDependencies(context, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  context.provide('assistantDelivery' as never, f.deliveryPorts)
  context.provide('assistantEvaluation' as never, f.evaluationPorts)
  context.provide('assistantVerifier' as never, { verifyPluginCreation: f.verification, ...verifierExtras })
  new AssistantPolicyService(context, { databasePath: join(f.root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: f.root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: f.root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  new AssistantAutomationsService(context, { databasePath: join(f.root, 'automations.sqlite'),
    runsPath: join(f.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  return { context, service: new PluginControlPlaneService(context, f.config) }
}


it.skipIf(process.platform !== 'linux' || !process.getuid?.())('restores fresh Linux v1 adoption after its build reader is initialized without redispatch or renewed call quota', async () => {
  // Real Git preparation, adoption, cold source checks and restored calls share
  // this case's budget, like the neighboring durable-adoption tests (60s).
  const began = performance.now(), timings: Record<string, { durationMs: number; atMs: number }> = {}
  let phase = 'fixture', failedPhase = '', failure: unknown
  const measured = async <T>(name: string, work: () => Promise<T>, remaining = 55_000 - (performance.now() - began)): Promise<T> => {
    phase = name
    const entered = performance.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([work(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} exceeded the bounded adoption recovery budget`)), Math.max(1, remaining))
      })])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      timings[name] = { durationMs: Math.round(performance.now() - entered), atMs: Math.round(entered - began) }
    }
  }
  let releaseReceipt = () => {}, restoreStart = () => {}, closeRuntime: (() => Promise<void>) | undefined
  try {
    const f = await measured('fixture', () => fixture(true, true, false, false, false, true))
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedAdoptionCertificate(f, request.planId) }))
    installCandidateRunner(f)
    const { planId, adopted, alias, execution, calls, reads } = await measured('first-adopt-call', async () => {
      const job = await f.service.enqueueSourceJob(f.request)
      f.advance(); await f.automations.tick(); await f.automations.whenIdle()
      const planId = f.store.getSourceJob(job.id)!.planId!, adopted = f.service.inspectCreatedCapability(planId)!
      expect(adopted.status).toBe('active')
      const alias = adopted.aliases[0]!, execution = (callId: string) => ({ callId,
        agent: { session: { id: 'session-1' }, owner: f.owner }, signal: new AbortController().signal }) as unknown as ToolRunContext
      await expect(f.ctx.tools.get(alias)!.execute({ query: 'hello' }, execution('cached'))).resolves.toMatchObject({ value: { answer: 'ok' } })
      return { planId, adopted, alias, execution, calls: f.service.inspectCreatedCapabilityCalls(planId), reads: linuxTransport.inspect.mock.calls.length }
    })
    await measured('dispose-first-host', () => f.ctx.fiber.dispose())
    let receiptEntered!: () => void, observeStartup!: (promise: Promise<void>) => void
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve })
    const inspectingReceipt = new Promise<void>(resolve => { receiptEntered = resolve })
    const startup = new Promise<void>(resolve => { observeStartup = resolve })
    // Attach a handler immediately, including when Host construction itself fails.
    void startup.catch(() => undefined)
    const originalStart = CreationCapabilityRuntime.prototype.start
    const start = vi.spyOn(CreationCapabilityRuntime.prototype, 'start').mockImplementation(function (this: CreationCapabilityRuntime) {
      closeRuntime = this.close.bind(this)
      const pending = originalStart.call(this)
      observeStartup(pending)
      return pending
    })
    restoreStart = () => start.mockRestore()
    linuxTransport.inspect.mockImplementationOnce(async () => {
      receiptEntered()
      await receiptGate
      return f.linuxExecution
    })
    const restored = await measured('construct-restored-host', () => startCapabilityHost(f))
    const unregister = restored.service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1', inspect: f.inspectGrowthRun })
    cleanup.push(unregister)
    await measured('receipt-enter', () => Promise.race([inspectingReceipt, startup.then(() => {
      throw new Error('creation startup completed before original Linux build receipt inspection')
    })]))
    // Cold restore must not publish readiness or aliases while the receipt read
    // is pending. Startup includes mounting and the subsequent authority recheck.
    expect(restored.service.inspectCreatedCapability(planId)).toBeUndefined()
    expect(restored.service.canEnqueueSource()).toBe(false)
    expect(restored.context.tools.get(alias)).toBeUndefined()
    releaseReceipt()
    await measured('startup-complete', () => startup)
    restoreStart()
    expect(restored.context.tools.get(alias)).toBeDefined()
    expect(restored.service.inspectCreatedCapability(planId)).toEqual(adopted)
    expect(restored.service.inspectCreatedCapabilityCalls(planId)).toEqual(calls)
    expect(linuxTransport.inspect.mock.calls.length).toBeGreaterThan(reads)
    await measured('restored-calls', async () => {
      await expect(restored.context.tools.get(alias)!.execute({ query: 'hello' }, execution('cached'))).resolves.toMatchObject({ value: { answer: 'ok' } })
      await expect(restored.context.tools.get(alias)!.execute({ query: 'next' }, execution('second'))).resolves.toMatchObject({ value: { answer: 'ok' } })
      await expect(restored.context.tools.get(alias)!.execute({ query: 'third' }, execution('third'))).rejects.toThrow()
    })
    expect(runnerRun).toHaveBeenCalledTimes(3)
    expect(f.verification).toHaveBeenCalledOnce()
    expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
    expect(linuxTransport.run).not.toHaveBeenCalled()
  } catch (error) { failure = error; failedPhase = phase }
  finally {
    // Release the test gate before cancelling the real runtime so disposal can
    // drain an in-flight receipt read; restore the prototype even after failure.
    releaseReceipt()
    restoreStart()
    try { if (closeRuntime) await measured('cancel-restored-runtime', closeRuntime, 4_000) }
    catch (error) { failure = new AggregateError(failure === undefined ? [error] : [failure, error], 'adoption recovery cleanup failed') }
  }
  const diagnostics = JSON.stringify({ failedPhase, elapsedMs: Math.round(performance.now() - began), timings,
    receiptReads: linuxTransport.inspect.mock.calls.length, runtimeChecks: linuxTransport.verify.mock.calls.length })
  if (failure !== undefined) throw new Error(`adoption recovery ${diagnostics}: ${String(failure)}`, { cause: failure })
  console.info('adoption recovery phases', diagnostics)
}, 60_000)


// The transport is controlled here; real native receipt/behavior acceptance is
// separate. The generator, owner fence, source jobs, artifact store and signing are real.
it.skipIf(process.platform !== 'linux' || !process.getuid?.())('verifies Linux creation through its original build receipt without replay or adoption', async () => {
  const f = await fixture(true, false, false, false, false, true)
  const { userNamespace: _mapping, systemSnapshot: _snapshot, ...legacy } = f.config.sourceBuild as build.LinuxSourceBuildConfig
  expect(() => normalizeControlPlaneConfig({ ...f.config, sourceBuild: legacy })).toThrow(/dual-UID repository boundary/)
  const { creationVerifications: _verification, ...preparationOnly } = f.config
  expect(() => normalizeControlPlaneConfig({ ...preparationOnly, sourceBuild: legacy })).not.toThrow()
  f.verification.mockImplementation(async request => {
    const inspected = await f.service.inspectPreparedCreationLinuxBuild(request.planId, new AbortController().signal)
    expect(inspected).toEqual({ runtime: (f.config.sourceBuild as build.LinuxSourceBuildConfig).runtime,
      evidenceDigest: controlPlaneDigest(f.linuxChecked!.evidence) })
    return { status: 'verified', certificate: signedCertificate(f, request.planId, f.signing.privateKey, unsigned => {
      unsigned.protocol = 'assistant-growth/creation-verification/v3'
      unsigned.execution = { boundary: 'linux-native-process-seccomp-v1', runtimeDigest: '1'.repeat(64),
        buildRuntimeDigest: f.linuxChecked!.evidence.runtimeDigest, buildEvidenceDigest: inspected.evidenceDigest,
        observerPreparationDigest: '2'.repeat(64) }
    }) }
  })
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!
  expect(f.store.getCreationVerificationStatus(planId)).toBe('verified')
  const certificate = f.service.inspectVerifiedCreation(planId)
  expect(certificate).toMatchObject({ protocol: 'assistant-growth/creation-verification/v3', execution: {
    buildRuntimeDigest: f.linuxChecked!.evidence.runtimeDigest, buildEvidenceDigest: controlPlaneDigest(f.linuxChecked!.evidence) } })
  expect(linuxTransport.inspect).toHaveBeenCalledExactlyOnceWith(job.id, expect.any(AbortSignal))
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  const before = f.store.getSourceJob(job.id)
  await f.service.inspectPreparedCreationLinuxBuild(planId, new AbortController().signal)
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(job.id)).toEqual(before)
  expect(f.service.inspectVerifiedCreation(planId)).toEqual(certificate)
  expect(f.verification).toHaveBeenCalledOnce()
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  expect(f.config.creationCapabilities).toBeUndefined()
})


it.skipIf(process.platform !== 'linux' || !process.getuid?.()).each([
  'missing', 'receipt', 'runtime', 'contract', 'unknown', 'live', 'exit', 'path', 'artifact', 'extra-artifact', 'log',
] as const)('rejects Linux creation when original build evidence is %s', async fault => {
  const f = await fixture(true, false, false, false, false, true)
  const job = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const planId = f.store.getSourceJob(job.id)!.planId!, execution = structuredClone(f.linuxExecution!)
  if (fault === 'receipt') execution.receiptBinding!.receiptDigest = '0'.repeat(64)
  if (fault === 'runtime') execution.runtimeDigest = '0'.repeat(64)
  if (fault === 'contract') execution.contractDigest = '0'.repeat(64)
  if (fault === 'unknown') execution.result.status = 'unknown'
  if (fault === 'live') execution.result.quiescent = false
  if (fault === 'exit') execution.result.exitCode = 1
  if (fault === 'path') execution.artifacts[0]!.path = 'different.tgz'
  if (fault === 'artifact') execution.artifacts[0]!.bytes[0] = execution.artifacts[0]!.bytes[0]! ^ 1
  if (fault === 'extra-artifact') execution.artifacts.push(execution.artifacts[0]!)
  if (fault === 'log') execution.result.stdout = 'different\n'
  linuxTransport.inspect.mockResolvedValue(fault === 'missing' ? undefined : execution)
  const before = f.store.getSourceJob(job.id)
  await expect(f.service.inspectPreparedCreationLinuxBuild(planId, new AbortController().signal)).rejects.toThrow(/original Linux build receipt or artifact changed/)
  expect(f.store.getSourceJob(job.id)).toEqual(before)
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  expect(linuxTransport.run).not.toHaveBeenCalled()
})


it.skipIf(process.platform !== 'linux' || !process.getuid?.()).each(['cancel', 'owner', 'expiry', 'trust'] as const)(
  'fences Linux build receipt reads against concurrent %s changes', async fault => {
    const f = await fixture(true, false, false, false, false, true)
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!, abort = new AbortController()
    linuxTransport.inspect.mockImplementationOnce(async () => {
      if (fault === 'cancel') abort.abort(new Error('fixture cancelled'))
      if (fault === 'owner') f.owner.principalVersion += 1
      if (fault === 'expiry') f.advance(700_000)
      if (fault === 'trust') {
        const original = await trust.loadTrustConfig(f.config.trustPath)
        vi.mocked(trust.loadTrustConfig).mockResolvedValue({ ...original, installationId: '00000000-0000-4000-8000-000000000002' })
      }
      return f.linuxExecution
    })
    await expect(f.service.inspectPreparedCreationLinuxBuild(planId, abort.signal)).rejects.toThrow()
    expect(linuxTransport.run).not.toHaveBeenCalled()
    expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  })


it.skipIf(process.platform !== 'linux' || !process.getuid?.())('preflights matching Linux build and adoption backends and retains undelivered authority gates', async () => {
  const f = await fixture(true, true, false, false, false, true)
  expect(() => normalizeControlPlaneConfig(f.config)).not.toThrow()
  const build = f.config.sourceBuild as build.LinuxSourceBuildConfig
  const { userNamespace: _mapping, systemSnapshot: _snapshot, ...legacy } = build
  expect(() => normalizeControlPlaneConfig({ ...f.config, sourceBuild: legacy })).toThrow(/dual-UID/)
  const runner = f.capability!.runner
  const seatbeltRunner = { backend: 'macos-seatbelt' as const,
    runtime: { schemaVersion: 1 as const, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
      nodePath: '/private/node/bin/node', nodeSha256: '1'.repeat(64), modulesPath: '/private/modules',
      roots: [{ path: '/private/node', dev: 1, ino: 2, sha256: '2'.repeat(64) }, { path: '/private/modules', dev: 1, ino: 3, sha256: '3'.repeat(64) }],
      versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
    stateRoot: runner.stateRoot, expiresAt: runner.expiresAt, maxRuns: runner.maxRuns,
    maxTotalDurationMs: runner.maxTotalDurationMs, maxDurationMs: runner.maxDurationMs, maxOutputBytes: runner.maxOutputBytes }
  expect(() => normalizeControlPlaneConfig({ ...f.config,
    creationCapabilities: { ...f.capability!, runner: seatbeltRunner } })).toThrow(/SOURCE_BOUNDARY|matching execution backends|invalid plugin behavior/)
  const seatbeltBuild: build.SourceBuildConfig = { backend: 'macos-seatbelt',
    runtime: { schemaVersion: 1, platform: `darwin-${process.arch}` as 'darwin-arm64' | 'darwin-x64',
      nodePath: '/private/node/bin/node', nodeSha256: '1'.repeat(64), modulesPath: '/private/modules',
      roots: [{ path: '/private/node', dev: 1, ino: 2, sha256: '2'.repeat(64) }, { path: '/private/modules', dev: 1, ino: 3, sha256: '3'.repeat(64) }],
      versions: { node: 'v24.22.0', typescript: '6.0.3', cordis: '4.0.5', tools: '0.2.1-rc.2', systemPrompt: '0.2.1-rc.2' } },
    stateRoot: '/private/state', authorityDigest: 'a'.repeat(64), expiresAt: Date.now() + 600_000,
    maxRuns: 2, maxTotalDurationMs: 120_000, timeoutMs: 60_000, outputBytes: 4096, versioning: 'patch' }
  expect(() => normalizeControlPlaneConfig({ ...f.config, sourceBuild: seatbeltBuild })).toThrow(/SOURCE_BOUNDARY|matching execution backends|native source build/)
  expect(() => normalizeControlPlaneConfig({ ...f.config,
    revisionVerifications: { authority: f.revisionAuthority, publicKey: f.publicKey } }))
    .toThrow(/revision verification requires its separate finite grant/)
  expect(() => normalizeControlPlaneConfig({ ...f.config, sourceAdoptions: {} as NonNullable<Config['sourceAdoptions']> }))
    .toThrow(/invalid source adoption config/)
})


it.skipIf(process.platform !== 'linux' || !process.getuid?.()).each(['protocol', 'build-runtime', 'build-evidence'] as const)(
  'rejects a signed Linux creation certificate with mismatched %s provenance before discovery', async fault => {
    const f = await fixture(true, true, false, false, false, true)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedCertificate(f, request.planId,
      f.signing.privateKey, body => {
        // A legacy v1 certificate claims no execution provenance, so it cannot
        // match the schema-3 Linux prepared evidence.
        if (fault === 'protocol') { body.protocol = 'assistant-growth/creation-verification/v1'; return }
        const certificate = signedAdoptionCertificate(f, request.planId)
        body.protocol = certificate.protocol
        body.execution = { ...certificate.execution!,
          ...(fault === 'build-runtime' ? { buildRuntimeDigest: '0'.repeat(64) } : { buildEvidenceDigest: '0'.repeat(64) }) }
      }) }))
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    expect(f.service.inspectVerifiedCreation(planId)).toBeUndefined()
    expect(f.store.getCreationVerificationStatus(planId)).toBe('unknown')
    expect(f.service.inspectCreatedCapability(planId)).toBeUndefined()
    expect(runnerRun).not.toHaveBeenCalled()
    expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
    expect(linuxTransport.run).not.toHaveBeenCalled()
  })


it.skipIf(process.platform !== 'linux' || !process.getuid?.()).each(['missing', 'receipt'] as const)(
  'fresh Linux adoption rechecks the original successful build after discovery and closes %s receipts without redispatch', async fault => {
    const f = await fixture(true, true, false, false, false, true)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedAdoptionCertificate(f, request.planId) }))
    installCandidateRunner(f)
    const originalRun = runnerRun.getMockImplementation()!
    runnerRun.mockImplementation(async input => {
      const result = await originalRun(input)
      const changed = structuredClone(f.linuxExecution!)
      changed.receiptBinding!.receiptDigest = '0'.repeat(64)
      linuxTransport.inspect.mockResolvedValue(fault === 'missing' ? undefined : changed)
      return result
    })
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!, frozenJob = structuredClone(f.store.getSourceJob(job.id))
    expect(f.service.inspectCreatedCapability(planId)).toEqual({ status: 'unknown', aliases: [] })
    expect(linuxTransport.inspect).toHaveBeenCalledTimes(2)
    expect(runnerRun).toHaveBeenCalledOnce()
    f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
    expect(f.store.getSourceJob(job.id)).toEqual(frozenJob)
    expect(f.verification).toHaveBeenCalledOnce()
    expect(runnerRun).toHaveBeenCalledOnce()
    expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
    expect(linuxTransport.run).not.toHaveBeenCalled()
  })


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
  expect(certificate).toMatchObject({ protocol: 'assistant-growth/creation-verification/v3', plan: { id: planId } })
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
    // Linux adoption observations must carry the same execution boundary and
    // runtime digest as the signed v3 certificate.
    installCandidateRunner(f)
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
    const ordinaryUse = f.service.inspectCreatedCapabilityOrdinaryUseReport(planId)
    expect(ordinaryUse).toMatchObject({ protocol: 'dsh-created-capability-ordinary-use-report/v1', causal: false, planId,
      minimumSamples: 5, associationsDigest: controlPlaneDigest(association), unknown: { inboxes: 0 },
      overall: { quality: { status: 'insufficient', samples: 1, achieved: 1, notAchieved: 0 },
        callLatency: { status: 'insufficient', samples: 1 }, taskLatency: { status: 'unmeasured', samples: 0 } },
      strata: [{ model: { state: 'frozen', provider: 'supplier', model: 'task-model', reasoningEffort: 'high' } }],
      regressions: { status: 'unmeasured' }, cost: { status: 'unmeasured' } })
    expect(JSON.stringify(ordinaryUse)).not.toMatch(/later ordinary task succeeded|hello-again|answer|subsequent-inbox/)
    // The fixture source has no execution record, so the later task cannot be placed in a window.
    expect(f.service.inspectCreatedCapabilityAvailabilityAttribution(planId)).toMatchObject({
      protocol: 'dsh-created-capability-availability-attribution/v1', causal: false, planId,
      population: { scanned: 2, counted: 0, excluded: { trigger: 1, unverified: 1 } },
      concurrentAdoptions: { status: 'none', count: 0 }, direction: 'insufficient' })
    expect(f.service.inspectCreatedCapabilityOrdinaryUseTrend(planId)).toMatchObject({
      protocol: 'dsh-created-capability-ordinary-use-trend/v1', causal: false, planId, windowMs: 7 * 24 * 60 * 60 * 1000,
      population: { scanned: 2, counted: 0, excluded: { trigger: 1, unverified: 1 } },
      cohorts: { treatedSessions: 0, controlSessions: 0 }, strata: [], flags: ['no-control-cohort', 'partial-window'] })
    expect(f.service.inspectCreatedCapabilityOrdinaryUseTrend(planId, { windowMs: 0 })).toBeUndefined()
    const sealed = f.service.sealCreatedCapabilityOrdinaryUseTrendSnapshot(planId)
    expect(sealed).toMatchObject({ created: true, record: { sequence: 1, snapshot: { causal: false, planId,
      trendDigest: controlPlaneDigest(f.service.inspectCreatedCapabilityOrdinaryUseTrend(planId)), models: [],
      flags: ['no-control-cohort', 'partial-window'] } } })
    expect(f.service.sealCreatedCapabilityOrdinaryUseTrendSnapshot(planId)).toEqual({ created: false, record: sealed!.record })
    expect(f.service.sealCreatedCapabilityOrdinaryUseTrendSnapshot(planId, { windowMs: 0 })).toBeUndefined()
    expect(f.service.inspectCreatedCapabilityOrdinaryUseTrendSnapshots({ planId })?.items).toEqual([sealed!.record])
    expect(f.service.inspectCreatedCapabilityOrdinaryUseTrendSnapshots({ limit: 101 })).toBeUndefined()
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
    expect(f.service.inspectCreatedCapabilityOrdinaryUseReport(planId)).toBeUndefined()
    expect(f.service.inspectCreatedCapabilityAvailabilityAttribution(planId)).toBeUndefined()
    expect(f.service.inspectCreatedCapabilityOrdinaryUseTrend(planId)).toBeUndefined()
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


it.for([
  { backend: 'docker', change: 'correction' }, { backend: 'docker', change: 'withdrawal' },
  { backend: 'linux-native', change: 'correction' }, { backend: 'linux-native', change: 'withdrawal' },
] as const)(
  'retained $backend adoption uses the frozen artifact after plan GC, then closes on current $change', { timeout: 60_000 }, async ({ backend, change }, context) => {
    const linux = backend === 'linux-native'
    if (linux && (process.platform !== 'linux' || !process.getuid?.())) context.skip()
    const f = await fixture(true, true, true, false, false, linux)
    f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedAdoptionCertificate(f, request.planId) }))
    installCandidateRunner(f)
    const job = await f.service.enqueueSourceJob(f.request)
    f.advance(); await f.automations.tick(); await f.automations.whenIdle()
    const planId = f.store.getSourceJob(job.id)!.planId!
    const adopted = f.service.inspectCreatedCapability(planId)!
    expect(adopted.status).toBe('active')
    const archive = f.service.inspectCreatedCapabilitySource(planId)!
    const checked = linux ? f.linuxChecked! : f.checked
    expect(archive).toMatchObject({ protocol: 'dsh-created-capability-source-archive/v1', planId,
      artifactSha256: checked.evidence.pack.sha256,
      source: { treeDigest: checked.treeDigest, patchDigest: checked.patchDigest } })
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
    const originalBuildReads = linuxTransport.inspect.mock.calls.length
    const originalRuntimeReads = linuxTransport.verify.mock.calls.length
    f.advance(901_000)
    if (linux) {
      linuxTransport.inspect.mockRejectedValue(new Error('expired original build authority must not be read'))
      linuxTransport.verify.mockRejectedValue(new Error('expired base runtime must not be read'))
    }
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
    const startHost = () => startCapabilityHost(f)
    const restored = await startHost()
    hostCtx = restored.context
    const restarted = restored.service
    await vi.waitFor(() => expect(restarted.inspectCreatedCapability(planId)?.status).toBe('active'))
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
    await expect(execute('after-expiry')).resolves.toMatchObject({ value: { answer: 'ok' } })
    await expect(execute('third-call')).rejects.toThrow()
    expect(f.inspectGrowthRun.mock.calls.length).toBe(producerCalls)
    expect(runnerRun).toHaveBeenCalledTimes(3)
    if (linux) {
      expect(linuxTransport.inspect).toHaveBeenCalledTimes(originalBuildReads)
      expect(linuxTransport.verify).toHaveBeenCalledTimes(originalRuntimeReads)
      expect(linuxTransport.adoptionVerify).toHaveBeenCalled()
      expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
      expect(linuxTransport.run).not.toHaveBeenCalled()
    }
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
  })


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
  if (candidate.protocol !== 'dsh-prepared-creation/v1') throw new Error('legacy fixture requires v1 handoff')
  expect(candidate.source.source.modelSelection).toEqual(f.source.source.modelSelection)
  expect(candidate.reference.projection).toEqual(f.source.canonical.projection)
  expect(JSON.parse(await readFile(join(plan.worktree, 'plugins', plan.name, 'package.json'), 'utf8')).version).toBe('0.1.0')
  expect(await readFile(join(f.repository, 'plugins/README.md'), 'utf8')).toBe(originalCatalog)
  expect(reserve).toHaveBeenCalledOnce()
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  expect(vi.mocked(linuxBuild.runLinuxPreparedChecks).mock.calls[0]![0].capturePack).toBe(true)
  f.inspectGrowthRun.mockImplementationOnce(() => ({ ...f.growthRun, budget: { ...f.growthRun.budget, amount: f.growthRun.budget.amount + 1 } }))
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('immutable binding changed')
  await f.unregisterGrowthRun()
  expect(() => f.service.inspectPreparedCreation(plan.id)).toThrow('producer unavailable')
  await f.automations.tick(); await f.automations.whenIdle()
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
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
  await f.unregisterGrowthRun()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('queued')
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
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
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  f.service.reconcileSourceGrowthRuns()
  await f.automations.tick(); await f.automations.whenIdle()
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
  await unregister()
}, 30_000)


it('revokes and drains a claimed growth creation when its producer is disposed', async () => {
  const f = await fixture()
  let entered!: () => void, release!: () => void
  const building = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(async () => { entered(); await gate; return f.checked })
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
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
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
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
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
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.store.getSourceJob(queued.id)?.status).toBe('prepared')
  expect(f.store.listSourceJobs()).toHaveLength(1)
  expect(linuxBuild.runLinuxPreparedChecks).toHaveBeenCalledOnce()
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
  expect(linuxBuild.runLinuxPreparedChecks).not.toHaveBeenCalled()
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
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(async input => {
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


function signedRevisionCertificate(f: Awaited<ReturnType<typeof fixture>>, planId: string,
  alter?: (body: Omit<PluginRevisionVerificationCertificate, 'signature'>) => void): PluginRevisionVerificationCertificate {
  const prepared = f.service.inspectPreparedRevision(planId)
  if (prepared.protocol !== 'dsh-prepared-revision/v1' && prepared.protocol !== 'dsh-prepared-revision/v2') {
    throw new Error('signed revision certificate fixture only covers task-failure revisions')
  }
  const { plan, reference } = prepared
  const growthRun = plan.sourceRevision!.growthRun
  if (!growthRun) throw new Error('task-failure revision fixture must pin a growth run')
  const body: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
    protocol: 'assistant-growth/revision-verification/v1', verificationId: 'fixture-revision', authority: f.revisionAuthority,
    parent: plan.sourceRevision!.parent,
    plan: { id: plan.id, digest: plan.digest, name: plan.name, sourceTreeDigest: plan.sourceCheck!.treeDigest,
      sourcePatchDigest: plan.sourceCheck!.patchDigest, artifactSha256: plan.preparedEvidence!.pack.sha256,
      artifactBytes: plan.preparedEvidence!.pack.sizeBytes, generatorDigest: plan.generatorDigest },
    source: { referenceDigest: controlPlaneDigest(reference), ownerDigest: controlPlaneDigest(reference.owner),
      growthRunDigest: sourceGrowthRunDigest(growthRun) },
    contractDigest: 'a'.repeat(64), schemaDigest: candidateSchemaDigest, environment: candidateEnvironment,
    model: growthRun.model,
    budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
    sessions: { contract: 'revision-contract', sourceReview: 'revision-source' },
    observations: [{ caseId: 'case-one', jobId: 'revision-job-one', operationDigest: 'c'.repeat(64), observationDigest: 'd'.repeat(64) },
      { caseId: 'case-two', jobId: 'revision-job-two', operationDigest: 'e'.repeat(64), observationDigest: 'f'.repeat(64) }],
    reviewDigest: '1'.repeat(64), verifiedAt: Date.now(), expiresAt: Date.now() + 300_000,
  }
  const runner = f.capability?.runner
  if (runner && 'backend' in runner && runner.backend === 'linux-native') {
    body.protocol = 'assistant-growth/revision-verification/v2'
    body.execution = { boundary: 'linux-native-process-seccomp-v1', runtimeDigest: linuxPluginBehaviorRuntimeDigest(runner.runtime),
      buildRuntimeDigest: plan.preparedEvidence!.schemaVersion === 3 ? plan.preparedEvidence!.runtimeDigest : '0'.repeat(64),
      buildEvidenceDigest: controlPlaneDigest(plan.preparedEvidence), observerPreparationDigest: '2'.repeat(64) }
  }
  alter?.(body)
  return { ...body, signature: sign(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), f.signing.privateKey).toString('base64url') }
}


async function revisionFixture(withRegression = false, withLinux = false, withRealRevisionReview = false) {
  const f = await fixture(true, true, true, true, withRegression, withLinux, false, withRealRevisionReview)
  f.verification.mockImplementation(async request => ({ status: 'verified', certificate: signedAdoptionCertificate(f, request.planId) }))
  installCandidateRunner(f)
  const initial = await f.service.enqueueSourceJob(f.request)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const parentPlanId = f.store.getSourceJob(initial.id)!.planId!
  expect(f.service.inspectCreatedCapability(parentPlanId)?.status).toBe('active')
  const archive = f.service.inspectCreatedCapabilitySource(parentPlanId)!
  const next: OwnerForegroundLearningTask = { ...structuredClone(f.source),
    canonical: { ...structuredClone(f.source.canonical), triggerOutcomeId: 'revision-feedback', situation: 'foreground:revision-task',
      objective: { ...f.source.canonical.objective!, outcomeId: 'revision-feedback' },
      projection: { ...f.source.canonical.projection, subjectRef: 'revision-inbox', digest: '7'.repeat(64) } },
    source: { ...structuredClone(f.source.source), inboxId: 'revision-inbox', sessionId: 'revision-session',
      objective: 'new ordinary task fails while using the created helper',
      modelSelection: { provider: 'new-task-supplier', model: 'new-task-model', reasoningEffort: 'medium' } } }
  f.setLaterSource(next)
  const gap = f.service.recordOwnerTaskFailureGap(next)
  const growthRun = sourceGrowthRunFixture(f.store.getOwnerTaskFailureReference(gap.id)!, Date.now(), next.source.modelSelection!, 'inherited-owner-task')
  growthRun.runId = 'usage-source-revise'; growthRun.native.automationId = growthRun.runId
  growthRun.intentDigest = '6'.repeat(64); growthRun.revisionAcceptance = f.revisionAuthority
  if (withRegression) growthRun.revisionRegressionAcceptance = f.regressionAuthority
  f.inspectGrowthRun.mockImplementation(request => request.runId === growthRun.runId ? structuredClone(growthRun) : structuredClone(f.growthRun))
  const request = { ...f.request, mode: 'revise-created' as const, parentPlanId, gapId: gap.id, growthRun,
    idempotencyKey: 'revise-from-new-task', files: [{ path: 'README.md', content: '# Revised helper\n' }] }
  return { ...f, parentPlanId, archive, next, revisionRun: growthRun, revisionRequest: request }
}


it('routes a CLI owner instruction through native scheduling and the independent Verifier to a signed v3 result', async () => {
  const f = await revisionFixture(false, true, true)
  const review = f.realRevisionReview!
  await vi.waitFor(() => expect(review.verifier.inspectRevisionAcceptanceAuthority({
    owner: f.capability!.owner,
  })).toMatchObject({ available: true, remainingVerifications: 1, authority: f.revisionAuthority }))

  const candidateArtifact = Buffer.from('fixture-revision-package-bytes')
  const candidateArtifactSha256 = createHash('sha256').update(candidateArtifact).digest('hex')
  expect(candidateArtifactSha256).not.toBe(f.archive.artifactSha256)
  vi.mocked(linuxBuild.runLinuxPreparedChecks).mockImplementationOnce(async input => {
    const snapshot = await checkedSourceSnapshot(input.worktree, input.baseCommit, input.scope, process.env)
    return { ...f.linuxChecked, treeDigest: snapshot.checkedTreeDigest, patchDigest: snapshot.checkedPatchDigest,
      packArtifact: candidateArtifact, evidence: { ...f.linuxChecked.evidence,
        pack: { ...f.linuxChecked.evidence.pack, sha256: candidateArtifactSha256, sizeBytes: candidateArtifact.length } } }
  })

  runnerRun.mockClear()
  runnerRun.mockImplementation(async (input: PluginBehaviorRunnerInput) => {
    const common = { status: 'observed' as const, quiescent: true, jobId: `fixture-revision-observation-${runnerRun.mock.calls.length}`,
      artifactSha256: createHash('sha256').update(input.artifact).digest('hex'),
      schemaDigest: candidateSchemaDigest, environment: candidateEnvironment }
    return input.operation.kind === 'discover' ? { ...common, schemas: candidateSchemas }
      : { ...common, calls: input.operation.calls.map(call => ({ id: call.id, toolName: call.toolName,
        result: { isError: false, value: { answer: 'ok' } } })) }
  })

  const filesDir = join(f.root, 'instruction-files')
  await mkdir(filesDir, { mode: 0o700 })
  await writeFile(join(filesDir, 'README.md'), '# Revised helper under independent review\n')
  const args = ['source', 'revision-enqueue', '--plan-id', f.parentPlanId, '--plugin-name', f.request.name,
    '--files-dir', filesDir, '--expected-base-commit', f.request.expectedBaseCommit,
    '--idempotency-key', 'real-instruction-review', '--ttl-ms', '900000']
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  let requestId: string
  try {
    await runPluginControl(args)
    const queued = JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as { requestId: string; status: string }
    expect(queued.status).toBe('pending')
    requestId = queued.requestId
  } finally { stdout.mockRestore() }
  expect(f.store.getOwnerInstructionRequest(requestId)).toMatchObject({ status: 'pending', planId: f.parentPlanId })

  const tick = async (ms: number) => { f.advance(ms); await f.automations.tick(); await f.automations.whenIdle() }
  await tick(0)
  await tick(60_000)
  const accepted = f.store.getOwnerInstructionRequest(requestId)!
  expect(accepted).toMatchObject({ status: 'accepted', jobId: expect.any(String), instructionId: expect.any(String) })
  await tick(1_100)
  await tick(60_000)

  const jobs = f.store.listSourceJobs().filter(job => job.intent.ownerInstruction?.instructionId === accepted.instructionId)
  expect(jobs).toHaveLength(1)
  expect(jobs[0]).toMatchObject({ id: accepted.jobId, status: 'prepared', planId: expect.any(String) })
  const planId = jobs[0]!.planId!
  if (f.store.inspectRevisionVerificationRecord(planId) === undefined) {
    // This wake may just have activated the paused continuation. Its first
    // due time is computed from activation, so advance to the next cron slot.
    expect(review.adapter.requests).toHaveLength(0)
    expect(runnerRun).not.toHaveBeenCalled()
    await tick(60_000)
  }
  const verification = f.store.inspectRevisionVerificationRecord(planId)
  expect(verification, JSON.stringify({
    verification, modelCalls: review.adapter.requests.length, observations: runnerRun.mock.calls.length,
  })).toMatchObject({ status: 'verified' })
  expect(f.store.listPreparedSourcePlans().filter(plan => plan.mode === 'prepared-revise').map(plan => plan.id)).toEqual([planId])
  const prepared = f.service.inspectPreparedRevision(planId)
  if (prepared.protocol !== 'dsh-prepared-revision/v3') throw new Error('owner instruction handoff absent')
  const { plan, source, artifact } = prepared
  expect(artifact).toEqual(candidateArtifact)
  const certificate = f.store.getRevisionVerification(planId)!
  expect(certificate).toMatchObject({
    protocol: 'assistant-growth/revision-verification/v3',
    authority: f.revisionAuthority,
    source: { instructionDigest: controlPlaneDigest(f.store.getOwnerInstruction(accepted.instructionId!)),
      ownerDigest: growthObjectDigest(f.owner) },
    parent: { ...plan.sourceRevision!.parent, planId: f.parentPlanId, sourceArchiveDigest: controlPlaneDigest(f.archive) },
    plan: { id: planId, digest: plan.digest, name: plan.name, sourceTreeDigest: plan.sourceCheck!.treeDigest,
      sourcePatchDigest: plan.sourceCheck!.patchDigest, artifactSha256: candidateArtifactSha256,
      artifactBytes: candidateArtifact.length, generatorDigest: plan.generatorDigest },
    model: source.reviewModel, schemaDigest: candidateSchemaDigest, environment: candidateEnvironment,
    observations: [{ caseId: 'ordinary', jobId: 'fixture-revision-observation-2' },
      { caseId: 'challenge', jobId: 'fixture-revision-observation-3' }],
  })
  expect(certificate).not.toHaveProperty('execution')
  expect(verifyPluginRevisionVerificationCertificate(certificate, f.revisionAuthority, f.config.revisionVerifications!.publicKey)).toBe(true)
  expect(f.service.inspectVerifiedRevision(planId)).toEqual(certificate)
  expect(f.service.inspectCreatedCapabilityRevisionCandidate(planId)).toBeUndefined()
  expect(() => f.store.getRetainedPreparedRevision(planId)).toThrow('retained revision requires an owner task failure gap')
  expect(review.adapter.requests).toHaveLength(2)
  expect(review.adapter.requests.map(({ provider, model, tools }) => ({ provider, model, toolCount: tools?.length ?? 0 }))).toEqual([
    { provider: 'supplier', model: 'task-model', toolCount: 0 }, { provider: 'supplier', model: 'task-model', toolCount: 0 },
  ])
  expect(runnerRun.mock.calls.map(([input]) => (input as PluginBehaviorRunnerInput).operation.kind)).toEqual(['discover', 'invoke', 'invoke'])
  for (const [input] of runnerRun.mock.calls) expect((input as PluginBehaviorRunnerInput).artifact).toEqual(candidateArtifact)
  expect(f.revisionVerification).not.toHaveBeenCalled()
  const verifierLedger = new DatabaseSync(review.databasePath + '.revision-reviews', { readOnly: true })
  try {
    const row = verifierLedger.prepare('SELECT state, data FROM verifications WHERE plan = ?').get(planId)
    expect(row?.state).toBe('certificate')
    expect(JSON.parse(String(row?.data)).certificate).toEqual(certificate)
  } finally { verifierLedger.close() }
  // Full native scheduling plus the independent Verifier; it needs ~25-27s even when
  // the package runs alone, so keep real headroom instead of racing the default bound.
}, 90_000)


it('recovers an owner instruction across admission interruptions and verifies its one durable revision', async () => {
  const f = await revisionFixture()
  const recorded = f.store.recordOwnerInstructionRequest({
    planId: f.parentPlanId, pluginName: f.request.name, expectedBaseCommit: f.request.expectedBaseCommit,
    files: f.revisionRequest.files, ttlMs: 900_000, createdAt: Date.now(), idempotencyKey: 'owner-instruction-recovery',
  })
  const admit = vi.spyOn(f.service, 'enqueueSourceJob')
    .mockRejectedValueOnce(new DOMException('fixture interrupted after recording instruction', 'TimeoutError'))
  const settle = vi.spyOn(ControlPlaneStore.prototype, 'acceptOwnerInstructionRequest')
    .mockImplementationOnce(() => { throw new Error('fixture interrupted after enqueue') })
  const tick = async (ms = 60_000) => { f.advance(ms); await f.automations.tick(); await f.automations.whenIdle() }
  await f.automations.tick(); await f.automations.whenIdle()
  await tick()
  expect(admit).toHaveBeenCalledOnce()
  expect(f.store.getOwnerInstructionRequest(recorded.requestId)).toMatchObject({ status: 'pending', claimGeneration: 1 })
  const instructionId = 'instruction-' + createHash('sha256').update(f.config.sourceJobs!.authorityId).update('\0')
    .update(recorded.idempotencyKey).digest('hex').slice(0, 32)
  const instruction = f.store.getOwnerInstruction(instructionId)!
  expect(instruction).toMatchObject({ createdAt: recorded.createdAt, expiresAt: recorded.expiresAt })

  f.revisionVerification.mockImplementation(async request => {
    const prepared = f.service.inspectPreparedRevision(request.planId)
    expect(prepared.protocol).toBe('dsh-prepared-revision/v3')
    if (prepared.protocol !== 'dsh-prepared-revision/v3') throw new Error('owner instruction handoff absent')
    const { plan } = prepared
    const body: Omit<PluginRevisionVerificationCertificate, 'signature'> = {
      protocol: 'assistant-growth/revision-verification/v3', verificationId: 'fixture-instruction-revision',
      authority: f.revisionAuthority, parent: plan.sourceRevision!.parent,
      plan: { id: plan.id, digest: plan.digest, name: plan.name, sourceTreeDigest: plan.sourceCheck!.treeDigest,
        sourcePatchDigest: plan.sourceCheck!.patchDigest, artifactSha256: plan.preparedEvidence!.pack.sha256,
        artifactBytes: plan.preparedEvidence!.pack.sizeBytes, generatorDigest: plan.generatorDigest },
      source: { instructionDigest: prepared.source.instruction.digest, ownerDigest: growthObjectDigest(prepared.source.owner) },
      model: prepared.source.reviewModel, contractDigest: 'a'.repeat(64), schemaDigest: candidateSchemaDigest,
      environment: candidateEnvironment, budget: { modelCalls: 2, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 2 },
      sessions: { contract: 'instruction-contract', sourceReview: 'instruction-review' },
      observations: [{ caseId: 'case-one', jobId: 'instruction-job-one', operationDigest: 'c'.repeat(64), observationDigest: 'd'.repeat(64) },
        { caseId: 'case-two', jobId: 'instruction-job-two', operationDigest: 'e'.repeat(64), observationDigest: 'f'.repeat(64) }],
      reviewDigest: '1'.repeat(64), verifiedAt: Date.now(), expiresAt: Date.now() + 30_000,
    }
    return { status: 'verified', certificate: { ...body,
      signature: sign(null, Buffer.from(pluginRevisionVerificationSigningPayload(body)), f.signing.privateKey).toString('base64url') } }
  })
  await tick()
  expect(settle).toHaveBeenCalledOnce()
  expect(f.store.getOwnerInstructionRequest(recorded.requestId)).toMatchObject({ status: 'claimed', claimGeneration: 2 })
  const jobs = () => f.store.listSourceJobs(100).filter(job => job.intent.ownerInstruction?.instructionId === instructionId)
  expect(jobs()).toHaveLength(1)
  const id = jobs()[0]!.id
  await tick(1_100)
  expect(f.store.getSourceJob(id)).toMatchObject({ status: 'prepared' })
  const planId = f.store.getSourceJob(id)!.planId!
  await tick()
  await tick(241_000)
  // Advance once more if the wake just enabled the continuation for its next cron slot.
  await tick()
  expect(f.store.getOwnerInstructionRequest(recorded.requestId)).toMatchObject({
    status: 'accepted', claimGeneration: 3, instructionId, jobId: id,
  })
  expect(jobs()).toHaveLength(1)
  expect(f.store.getOwnerInstruction(instructionId)).toEqual(instruction)
  expect(f.revisionVerification).toHaveBeenCalledOnce()
  expect(f.store.getRevisionVerification(planId)).toMatchObject({
    protocol: 'assistant-growth/revision-verification/v3',
    source: { instructionDigest: controlPlaneDigest(instruction) },
  })
  expect(f.service.inspectCreatedCapabilityRevisionCandidate(planId)).toBeUndefined()
  expect(() => f.store.getRetainedPreparedRevision(planId)).toThrow('retained revision requires an owner task failure gap')
  expect(f.store.listPreparedSourcePlans()).toContainEqual(f.store.getSourcePlan(planId))
  const raw = new DatabaseSync(join(f.config.statePath, 'control.sqlite'))
  try {
    raw.prepare('UPDATE source_owner_instructions SET expires_at = ? WHERE instruction_id = ?')
      .run(instruction.expiresAt + 1, instructionId)
    expect(() => f.store.listPreparedSourcePlans()).toThrow('prepared revision requires a current exact owner instruction')
  } finally {
    raw.prepare('UPDATE source_owner_instructions SET expires_at = ? WHERE instruction_id = ?')
      .run(instruction.expiresAt, instructionId)
    raw.close()
  }
}, 30_000)


it('rejects an orphaned request if restart refuses native activation after definition binding', async () => {
  const f = await revisionFixture()
  const request = f.store.recordOwnerInstructionRequest({
    planId: f.parentPlanId, pluginName: f.request.name, expectedBaseCommit: f.request.expectedBaseCommit,
    files: f.revisionRequest.files, ttlMs: 900_000, createdAt: Date.now(), idempotencyKey: 'owner-instruction-unactivated',
  })
  const jobId = 'source-job-' + createHash('sha256').update(f.config.sourceJobs!.authorityId)
    .update('\0').update(request.idempotencyKey).digest('hex')
  const reconcile = AssistantAutomationsService.prototype.reconcileSystem
  const activate = vi.spyOn(AssistantAutomationsService.prototype, 'reconcileSystem').mockImplementation(function (this: AssistantAutomationsService, input) {
    if (input.automationId === jobId && input.desiredStatus === 'active') throw new Error('fixture activation refused')
    return reconcile.call(this, input)
  })
  // Stop short of either failure acknowledgement, as if the Host exited
  // after binding the paused definition but before native activation.
  const settle = vi.spyOn(ControlPlaneStore.prototype, 'settleSourceJob')
    .mockImplementationOnce(() => { throw new Error('fixture interrupted before job failure settlement') })
  const reject = vi.spyOn(ControlPlaneStore.prototype, 'rejectOwnerInstructionRequest')
    .mockImplementationOnce(() => { throw new Error('fixture interrupted before request failure settlement') })
  await f.automations.tick(); await f.automations.whenIdle()
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(settle).toHaveBeenCalledWith(expect.objectContaining({ id: jobId, failureCode: 'source-job-registration-rejected' }))
  expect(reject).toHaveBeenCalledOnce()
  expect(f.store.getSourceJob(jobId)).toMatchObject({ status: 'queued', definitionHash: expect.any(String) })
  expect(f.store.getSourceJob(jobId)?.occurrenceId).toBeUndefined()
  expect(f.store.getOwnerInstructionRequest(request.requestId)).toMatchObject({ status: 'claimed', claimGeneration: 1 })
  settle.mockRestore()
  reject.mockRestore()

  const restarted = await restartRegressionHost(f)
  expect(f.store.getSourceJob(jobId)).toMatchObject({
    status: 'failed', failureCode: 'source-job-reconcile-rejected', definitionHash: expect.any(String),
  })
  expect(f.store.getSourceJob(jobId)?.occurrenceId).toBeUndefined()
  f.advance(301_000); await restarted.automations.tick(); await restarted.automations.whenIdle()
  f.advance(60_000); await restarted.automations.tick(); await restarted.automations.whenIdle()
  expect(f.store.getOwnerInstructionRequest(request.requestId)).toMatchObject({
    status: 'rejected', claimGeneration: 2, failureCode: 'source-job-registration-rejected', instructionId: null, jobId: null,
  })
  expect(activate.mock.calls.filter(([input]) => input.automationId === jobId && input.desiredStatus === 'active')).toHaveLength(2)
  expect(f.store.listSourceJobs().filter(job => job.idempotencyKey === request.idempotencyKey)).toHaveLength(1)
  expect(f.revisionVerification).not.toHaveBeenCalled()
}, 30_000)


it('new ordinary task independently verifies a durable parent-bound revision without renewing creation or execution grants', async () => {
  const f = await revisionFixture()
  const alias = f.service.inspectCreatedCapability(f.parentPlanId)!.aliases[0]!
  const readParentReceipt = () => {
    const db = new DatabaseSync(join(f.config.statePath, 'creation-adoptions.sqlite'))
    try { return db.prepare('SELECT receipt_json FROM adoptions WHERE plan_id=?').get(f.parentPlanId)?.receipt_json }
    finally { db.close() }
  }
  const parentReceipt = readParentReceipt()
  // Historical source survives an owner correction that shuts down the old execution grant.
  f.setSource({ ...f.source, source: { ...f.source.source, objective: 'owner corrected old trigger' } })
  f.notifyTaskChange()
  await vi.waitFor(() => expect(f.ctx.tools.get(alias)).toBeUndefined())
  expect(f.service.inspectCreatedCapabilityRevisionTargets()).toEqual([{ parentPlanId: f.parentPlanId,
    name: f.request.name, parentSourceDigest: f.archive.source.digest }])
  const context = await f.service.inspectRevisionSource({ repository: f.repository, name: f.request.name, parentPlanId: f.parentPlanId,
    paths: ['README.md'], baseCommit: f.request.expectedBaseCommit, signal: new AbortController().signal })
  expect(context.contents).toEqual(f.request.files)
  f.revisionVerification.mockImplementation(async request => ({ status: 'verified', certificate: signedRevisionCertificate(f, request.planId) }))
  const queued = await f.service.enqueueSourceJob(f.revisionRequest)
  expect(await f.service.enqueueSourceJob(f.revisionRequest)).toEqual(queued)
  f.advance(); await f.automations.tick(); await f.automations.whenIdle()
  const job = f.store.getSourceJob(queued.id)!
  expect(job.status).toBe('prepared')
  const planId = job.planId!
  expect(f.store.getSourcePlan(planId)).toMatchObject({ mode: 'prepared-revise', revision: 1,
    sourceRevision: { parent: { planId: f.parentPlanId }, growthRun: { model: f.next.source.modelSelection } } })
  const certificate = f.service.inspectVerifiedRevision(planId)!
  expect(certificate).toMatchObject({ protocol: 'assistant-growth/revision-verification/v2',
    parent: { planId: f.parentPlanId, sourceArchiveDigest: controlPlaneDigest(f.archive) }, model: f.next.source.modelSelection })
  expect(f.revisionVerification).toHaveBeenCalledOnce()
  const candidate = f.service.inspectCreatedCapabilityRevisionCandidate(planId)!
  expect(candidate.source.files.find(file => file.path.endsWith('/README.md'))?.content).toBe('# Revised helper\n')
  expect(f.service.inspectCreatedCapability(planId)).toBeUndefined()
  expect(f.ctx.tools.get(alias)).toBeUndefined()
  expect(readParentReceipt()).toBe(parentReceipt)
  const db = new DatabaseSync(join(f.config.statePath, 'control.sqlite'))
  try {
    expect(db.prepare('SELECT creates FROM source_creation_grants').get()?.creates).toBe(1)
    expect(db.prepare('SELECT revisions FROM source_revision_grants').get()?.revisions).toBe(1)
    expect(db.prepare('SELECT submissions FROM source_job_authorities').get()?.submissions).toBe(2)
  } finally { db.close() }
  f.advance(60_000); await f.automations.tick(); await f.automations.whenIdle()
  expect(f.revisionVerification).toHaveBeenCalledOnce()
  const reopened = new ControlPlaneStore({ path: join(f.config.statePath, 'control.sqlite') })
  try { expect(reopened.getRevisionVerification(planId)).toEqual(certificate); expect(reopened.readRevisionSource(planId)).toEqual(candidate.source) }
  finally { reopened.close() }
  // Historical data survives expiry, removal of prepared artifacts/worktrees,
  // withdrawal of the new trigger and a complete Host/Cordis cold restart.
  f.advance(901_000)
  const removed = await f.service.gcPreparedSourceWorktrees()
  expect(removed.removed).toContain(f.store.getSourcePlan(planId).worktree)
  expect(() => f.store.readPreparedSourceArtifact(planId)).toThrow()
  expect(f.service.inspectCreatedCapabilityRevisionCandidate(planId)).toEqual(candidate)
  f.setLaterSource({ ...f.next, canonical: { ...f.next.canonical,
    projection: { ...f.next.canonical.projection, disposition: 'retract' } } })
  f.notifyTaskChange()
  expect(f.service.inspectCreatedCapabilityRevisionCandidate(planId)).toEqual(candidate)
  await f.unregisterGrowthRun()
  await f.ctx.fiber.dispose()
  const restored = new Context()
  cleanup.push(async () => restored.fiber.dispose())
  await mountAgentLoopTestDependencies(restored, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  restored.provide('assistantDelivery' as never, f.deliveryPorts)
  restored.provide('assistantEvaluation' as never, f.evaluationPorts)
  restored.provide('assistantVerifier' as never, { verifyPluginCreation: f.verification, verifyPluginRevision: f.revisionVerification })
  new AssistantPolicyService(restored, { databasePath: join(f.root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: f.root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: f.root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  const restoredAutomations = new AssistantAutomationsService(restored, { databasePath: join(f.root, 'automations.sqlite'),
    runsPath: join(f.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const restarted = new PluginControlPlaneService(restored, f.config)
  await vi.waitFor(() => expect(restarted.inspectCreatedCapabilityRevisionCandidate(planId)).toEqual(candidate))
  expect(restarted.inspectCreatedCapabilitySource(f.parentPlanId)).toEqual(f.archive)
  expect(restarted.inspectCreatedCapability(planId)).toBeUndefined()
  expect(restored.tools.get(alias)).toBeUndefined()
  await restoredAutomations.tick(); await restoredAutomations.whenIdle()
  expect(f.revisionVerification).toHaveBeenCalledOnce()
  expect(readParentReceipt()).toBe(parentReceipt)
  f.owner.generation += 1; f.owner.bindingVersion += 1
  expect(restarted.inspectCreatedCapabilityRevisionCandidate(planId)).toEqual(candidate)
  f.owner.principalVersion += 1
  expect(restarted.inspectCreatedCapabilityRevisionCandidate(planId)).toBeUndefined()
}, 60_000)


it.each(['expired', 'parent', 'model', 'authority', 'new-task', 'quota'] as const)('revision %s fails before native dispatch without spending old creation or adoption grants', async fault => {
  const f = await revisionFixture()
  const parentReceipt = f.service.inspectCreatedCapability(f.parentPlanId)
  const beforeBuilds = vi.mocked(linuxBuild.runLinuxPreparedChecks).mock.calls.length
  let request = f.revisionRequest
  if (fault === 'expired') f.advance(601_000)
  if (fault === 'parent') request = { ...request, parentPlanId: 'missing-parent' }
  if (fault === 'model') request = { ...request, growthRun: { ...request.growthRun, model: { provider: 'other', model: 'other' } } }
  if (fault === 'authority') request = { ...request, growthRun: { ...request.growthRun,
    revisionAcceptance: { ...f.revisionAuthority, authorityDigest: '0'.repeat(64) } } }
  if (fault === 'new-task') f.setLaterSource({ ...f.next, source: { ...f.next.source, objective: 'corrected task' } })
  if (fault === 'quota') {
    await f.service.enqueueSourceJob(request)
    request = { ...request, idempotencyKey: 'second-revision' }
  }
  await expect(f.service.enqueueSourceJob(request)).rejects.toThrow()
  expect(vi.mocked(linuxBuild.runLinuxPreparedChecks).mock.calls.length).toBe(beforeBuilds)
  expect(f.revisionVerification).not.toHaveBeenCalled()
  expect(f.service.inspectCreatedCapability(f.parentPlanId)).toEqual(parentReceipt)
  const db = new DatabaseSync(join(f.config.statePath, 'control.sqlite'))
  try {
    expect(db.prepare('SELECT creates FROM source_creation_grants').get()?.creates).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS n FROM source_jobs WHERE json_extract(intent_json,\'$.mode\')=\'revise-created\'').get()?.n).toBe(fault === 'quota' ? 1 : 0)
    expect(db.prepare('SELECT SUM(revisions) AS n FROM source_revision_grants').get()?.n ?? 0).toBe(fault === 'quota' ? 1 : 0)
  } finally { db.close() }
}, 60_000)



async function restartRegressionHost(f: Awaited<ReturnType<typeof revisionFixture>>) {
  await f.unregisterGrowthRun()
  await f.ctx.fiber.dispose()
  const restored = new Context()
  cleanup.push(async () => restored.fiber.dispose())
  await mountAgentLoopTestDependencies(restored, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  restored.provide('assistantDelivery' as never, f.deliveryPorts)
  restored.provide('assistantEvaluation' as never, f.evaluationPorts)
  restored.provide('assistantVerifier' as never, { verifyPluginCreation: f.verification,
    verifyPluginRevision: f.revisionVerification, verifyPluginRevisionRegression: f.regressionVerification })
  new AssistantPolicyService(restored, { databasePath: join(f.root, 'policy.sqlite'),
    budgets: [{ id: 'source-budget', metric: 'automation-runs', limit: 3, periodMs: 60_000, scope: 'global' }], rules: [
      { id: 'reconcile', effect: 'allow', subject: { kind: 'background', id: 'plugin-control-plane-source', workspace: f.root, principal: 'owner' }, actions: ['reconcile'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
      { id: 'execute', effect: 'allow', subject: { kind: 'background', id: '*', workspace: f.root, principal: 'owner' }, actions: ['execute'], resource: { kind: 'automation', id: '*' }, context: { initiators: ['background'] } },
    ] })
  const automations = new AssistantAutomationsService(restored, { databasePath: join(f.root, 'automations.sqlite'),
    runsPath: join(f.root, 'runs'), schedulerEnabled: false, reconcileIntervalMs: 0 })
  const service = new PluginControlPlaneService(restored, f.config)
  await vi.waitFor(() => expect(service.canEnqueueSource()).toBe(true))
  const unregister = service.registerSourceGrowthRunProducer({ protocol: 'assistant-growth-source-run-producer/v1', inspect: f.inspectGrowthRun })
  cleanup.push(async () => unregister())
  return { ctx: restored, service, automations }
}
