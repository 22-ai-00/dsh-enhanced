import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { canonicalGrowthJson, sourceGrowthEvidenceDigest,
  verifyPluginRevisionVerificationCertificate, type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { linuxRuntimeDigest, type LinuxRuntime } from '@dsh-enhanced/assistant-isolation'
import { afterEach, expect, test, vi } from 'vitest'
import { RevisionReviewRuntime, compileRevisionReviewConfig, type RevisionReviewConfig } from '../src/revision-review.ts'
import { LINUX_BEHAVIOR_BOUNDARY } from '../src/plugin-behavior-config.js'
import { linuxPluginBehaviorRuntimeDigest } from '../src/linux-behavior-runtime.js'

const observer = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
const preparation = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../src/plugin-behavior-runner.js', () => ({ PluginBehaviorRunner: class {
  run(...args: unknown[]) { return observer.run(...args) }
  close() { return observer.close() }
} }))
vi.mock('../src/linux-behavior-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/linux-behavior-runtime.js')>(),
  readLinuxPluginBehaviorPreparation: preparation.read,
}))

const roots: string[] = [], contexts: Context[] = [], runtimes: RevisionReviewRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  observer.run.mockReset(); observer.close.mockClear(); preparation.read.mockReset()
})

const schema = { name: 'owner_sum', description: 'untrusted text', parameters: { type: 'object', properties: {
  a: { type: 'integer', description: 'ignored' }, b: { type: 'integer' },
} } }
const schemaDigest = createHash('sha256').update(JSON.stringify([schema])).digest('hex')
const environment = { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' }
const cases = [
  { id: 'ordinary', toolName: 'owner_sum', arguments: { a: 2, b: 3 }, purpose: 'ordinary' as const,
    expected: { kind: 'json-value' as const, value: { sum: 5 } }, rationale: 'The ordinary positive pair establishes exact addition.' },
  { id: 'negative', toolName: 'owner_sum', arguments: { a: -2, b: 3 }, purpose: 'challenge' as const,
    expected: { kind: 'json-value' as const, value: { sum: 1 } }, rationale: 'A negative operand checks signed arithmetic beyond the example.' },
]
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const index = this.requests.length
    const value = index === 1 ? { status: 'cases', cases }
      : { decision: 'approved', reason: 'The checked source implements the task contract and owns cleanup.' }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'linux-revision-review-'))); roots.push(root)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer')
  await mkdir(stateRoot, { mode: 0o700 })
  const pair = generateKeyPairSync('ed25519')
  await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const now = Date.now()
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const config: RevisionReviewConfig = { authorityId: 'revision-review', owner, namePrefix: 'owner-', keyId: 'key-1', keyPath,
    expiresAt: now + 120_000, maxVerifications: 2,
    runner: { stateRoot, image: 'sha256:' + 'a'.repeat(64), dockerPath: await realpath(process.execPath), expiresAt: now + 120_000,
      maxRuns: 8, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 },
    policy: 'Verify arithmetic specified by the owner, including negative operands.',
    maxInputBytes: 65_536, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 }
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
  const { stateRoot: observerRoot, expiresAt, maxRuns, maxTotalDurationMs, maxDurationMs, maxOutputBytes } = config.runner
  config.runner = { backend: 'linux-native', stateRoot: observerRoot, expiresAt, maxRuns, maxTotalDurationMs, maxDurationMs, maxOutputBytes,
    runtime: descriptor, cgroupRoots: { mode: 'v1' as const, cpu: '/sys/fs/cgroup/cpu/dsh-native/uid-1000',
      memory: '/sys/fs/cgroup/memory/dsh-native/uid-1000', pids: '/sys/fs/cgroup/pids/dsh-native/uid-1000',
      freezer: '/sys/fs/cgroup/freezer/dsh-native/uid-1000' } }
  const prepared = { descriptor, baseRuntimeDigest: linuxRuntimeDigest(base), preparationDigest: 'c'.repeat(64) }
  preparation.read.mockResolvedValue(prepared)
  const compiled = compileRevisionReviewConfig(config)
  const fullOwner = { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }
  const reference = { schemaVersion: 1, owner: fullOwner, outcomeId: 'outcome',
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: 'task', version: 1,
      digest: 'b'.repeat(64), disposition: 'upsert' as const }, sourceDigest: 'd'.repeat(64) }
  const growthRun: SourceGrowthRunBinding = { protocol: 'assistant-growth/source-run/v1', runId: 'run-1', intentDigest: 'e'.repeat(64),
    configDigest: 'f'.repeat(64), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
    source: { outcomeId: reference.outcomeId, projection: reference.projection, sourceDigest: reference.sourceDigest },
    model: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' }, modelOrigin: 'inherited-owner-task',
    budget: { budgetId: 'budget', amount: 1, maxModelCalls: 2, maxToolCalls: 2, maxOutputTokens: 1024,
      maxDurationMs: 120_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'run-1', definitionHash: '0'.repeat(64), occurrenceId: 'occurrence' },
    sessionId: 'author-session', toolContractDigest: '1'.repeat(64), executionContractDigest: '2'.repeat(64),
    createdAt: now - 1000, generationDeadlineAt: now + 60_000, expiresAt: now + 120_000,
    revisionAcceptance: compiled.authority }
  const artifact = Buffer.from('private revised fixture package bytes')
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
  const parent = { planId: 'adopted-plan-1', certificateDigest: '7'.repeat(64), artifactSha256: '8'.repeat(64),
    sourceArchiveDigest: '9'.repeat(64), sourceDigest: 'a'.repeat(64) }
  const plan = { id: 'plan-1', digest: '3'.repeat(64), name: 'owner-sum', mode: 'prepared-revise', status: 'pending-approval',
    expiresAt: now + 120_000, generatorDigest: '4'.repeat(64), sourceCheck: { treeDigest: '5'.repeat(64), patchDigest: '6'.repeat(64) },
    preparedEvidence: {
      schemaVersion: 3, kind: 'dsh-source-prepared-evidence', boundary: 'linux-native-repository-v1',
      runtimeDigest: linuxRuntimeDigest(base), executionContractDigest: '1'.repeat(64), buildScriptSha256: '2'.repeat(64),
      archive: { sizeBytes: 1234, sha256: '3'.repeat(64) }, receipt: { requestDigest: '4'.repeat(64), nativeNonce: '5'.repeat(32),
        nativeResourceId: 'linux-11111111-1111-1111-1111-111111111111', intentDigest: '6'.repeat(64), resourcesDigest: '7'.repeat(64),
        receiptDigest: '8'.repeat(64) },
      environment: { npmConfigIgnoreScripts: true, frozenLockfile: true, offline: true, nodeVersion: 'v22.23.2', pnpmVersion: '11.7.0' },
      checks: ['source-archive-integrity', 'frozen-offline-install', 'repository-pnpm-check', 'source-input-recheck', 'package-integrity'],
      pack: { sha256: artifactSha256, sizeBytes: artifact.length, name: '@owner/sum', version: '1.0.0' },
      logDigest: '9'.repeat(64), durationMs: 10, preparedAt: now },
    sourceRevision: { grant: { namePrefix: 'owner-', expiresAt: now + 120_000 }, growthRun, parent } }
  const evidenceDigest = createHash('sha256').update(canonicalGrowthJson(plan.preparedEvidence)).digest('hex')
  const source = { owner: fullOwner, judgement: 'owner-feedback', source: {
    objective: 'Revise adopted owner_sum to add signed integers and handle negative operands.', truncated: false, quiescent: true },
  feedback: { text: 'The adopted version mishandles negative operands.', truncated: false } }
  const cp = { inspectPreparedRevision: vi.fn(() => ({ protocol: 'dsh-prepared-revision/v1', plan,
    job: { intent: { revision: { growthRun, parent: structuredClone(parent) } } },
    reference, source, artifact })),
  withPreparedRevisionFence: vi.fn(<T>(_input: unknown, callback: () => T): T => callback()),
  inspectPreparedRevisionLinuxBuild: vi.fn(async () => ({ runtime: base, evidenceDigest })),
  inspectPreparedRevisionReviewContext: vi.fn(async () => ({ patch: '+ owner_sum signed addition',
    changedPaths: ['plugins/owner-sum/src/index.ts'] })) }
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true,
    systemPrompt: { personaPrefix: 'GLOBAL PERSONA MUST NOT LEAK' } })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  const adapter = new Adapter(); ctx.llm.registerAdapter(['supplier'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('pluginControlPlane' as never, cp as never)
  let job = 0
  observer.run.mockImplementation(async ({ operation }: { operation: { kind: string; calls?: { id: string; arguments: { a: number; b: number } }[] } }) => {
    const common = { jobId: `job-${++job}`, boundary: LINUX_BEHAVIOR_BOUNDARY,
      runtimeDigest: linuxPluginBehaviorRuntimeDigest(descriptor), status: 'observed' as const, artifactSha256,
      quiescent: true, environment, schemaDigest }
    return operation.kind === 'discover' ? { ...common, schemas: [schema] }
      : { ...common, calls: [{ id: operation.calls![0]!.id, toolName: 'owner_sum',
        result: { isError: false, value: { sum: operation.calls![0]!.arguments.a + operation.calls![0]!.arguments.b } } }] }
  })
  const runtime = new RevisionReviewRuntime(ctx, config, join(root, 'verifier.sqlite')); runtimes.push(runtime)
  const request = { protocol: 'assistant-growth/revision-verification-request/v1' as const, planId: plan.id }
  const execution = { boundary: LINUX_BEHAVIOR_BOUNDARY, runtimeDigest: linuxPluginBehaviorRuntimeDigest(descriptor),
    buildRuntimeDigest: linuxRuntimeDigest(base), buildEvidenceDigest: evidenceDigest,
    observerPreparationDigest: prepared.preparationDigest }
  return { root, ctx, runtime, config, compiled, owner, plan, cp, adapter, request, artifact, base, descriptor,
    prepared, preparationRoot: dirname(descriptor.runtime.root.path), execution,
    prepareBehaviorRoot: () => join(root, 'behavior') }
}

test('full Linux revision signs v2 binding the reopened build and the retained observer preparation', async () => {
  const f = await fixture()
  const result = await f.runtime.run(f.request)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') return
  expect(result.certificate.protocol).toBe('assistant-growth/revision-verification/v2')
  expect(result.certificate.execution).toEqual(f.execution)
  expect(verifyPluginRevisionVerificationCertificate(result.certificate, f.compiled.authority, f.compiled.publicKey)).toBe(true)
  expect(f.cp.inspectPreparedRevisionLinuxBuild).toHaveBeenCalledWith(f.plan.id, expect.any(AbortSignal))
  expect(preparation.read).toHaveBeenCalledWith({ runtime: f.base, root: f.prepareBehaviorRoot(), signal: expect.any(AbortSignal) })
  expect(observer.run).toHaveBeenCalledTimes(3)
  expect(f.adapter.requests).toHaveLength(2)
  expect(f.adapter.requests.every(item => item.provider === 'supplier' && item.model === 'task-model'
    && item.reasoningEffort === 'high' && (item.tools?.length ?? 0) === 0)).toBe(true)
  // Re-run reopens the live build as pre-fence freshness, but the ledger replay skips observer and model.
  expect((await f.runtime.run(f.request)).status).toBe('verified')
  expect(f.cp.inspectPreparedRevisionLinuxBuild).toHaveBeenCalledTimes(2)
  expect(observer.run).toHaveBeenCalledTimes(3)
  expect(f.adapter.requests).toHaveLength(2)
})

test.each(['missing-port', 'evidence-digest', 'build-runtime', 'preparation', 'descriptor'])(
  'Linux revision %s preflight failure is stale-source without observer or model dispatch', async mode => {
    const f = await fixture()
    if (mode === 'missing-port') Object.assign(f.cp, { inspectPreparedRevisionLinuxBuild: undefined })
    if (mode === 'evidence-digest') f.cp.inspectPreparedRevisionLinuxBuild.mockResolvedValue({ runtime: f.base, evidenceDigest: '0'.repeat(64) })
    if (mode === 'build-runtime') f.cp.inspectPreparedRevisionLinuxBuild.mockResolvedValue(
      { runtime: { ...f.base, sourceCommit: '0'.repeat(40) }, evidenceDigest: f.execution.buildEvidenceDigest })
    if (mode === 'preparation') preparation.read.mockResolvedValue({ ...f.prepared, baseRuntimeDigest: '0'.repeat(64) })
    if (mode === 'descriptor') preparation.read.mockResolvedValue({ ...f.prepared, descriptor: { ...f.descriptor,
      observer: { ...f.descriptor.observer, launcherSha256: '0'.repeat(64) } } })
    expect(await f.runtime.run(f.request)).toEqual({ status: 'unknown', reason: 'stale-source' })
    expect(observer.run).not.toHaveBeenCalled()
    expect(f.adapter.requests).toHaveLength(0)
    expect(f.runtime.inspect({ owner: f.owner })?.remainingVerifications).toBe(2)
  })

test.each(['discovery-boundary', 'discovery-runtime', 'case-boundary', 'case-runtime'])(
  'Linux revision %s mismatch is durable unknown without replay or a certificate', async mode => {
    const f = await fixture(), run = observer.run.getMockImplementation()!
    observer.run.mockImplementation(async (...args: unknown[]) => {
      const result = await run(...args) as Record<string, unknown>
      const discovery = (args[0] as { operation: { kind: string } }).operation.kind === 'discover'
      if (discovery === mode.startsWith('discovery')) {
        if (mode.endsWith('boundary')) result.boundary = 'process-seccomp-v1'
        else result.runtimeDigest = '0'.repeat(64)
      }
      return result
    })
    expect((await f.runtime.run(f.request)).status).toBe('unknown')
    const calls = observer.run.mock.calls.length, turns = f.adapter.requests.length
    expect(calls).toBe(mode.startsWith('discovery') ? 1 : 2)
    expect((await f.runtime.run(f.request)).status).toBe('unknown')
    expect(observer.run).toHaveBeenCalledTimes(calls)
    expect(f.adapter.requests).toHaveLength(turns)
    expect(f.runtime.inspect({ owner: f.owner })?.remainingVerifications).toBe(1)
  })
