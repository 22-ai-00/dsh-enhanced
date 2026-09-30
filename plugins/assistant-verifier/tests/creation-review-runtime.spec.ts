import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { sourceGrowthEvidenceDigest, sourceGrowthRunDigest, verifyPluginCreationVerificationCertificate,
  type SourceGrowthRunBinding } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, expect, test, vi } from 'vitest'
import { CreationReviewRuntime, compileCreationReviewConfig, type CreationReviewConfig } from '../src/creation-review.ts'

const observer = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('@dsh-enhanced/assistant-isolation', () => ({
  IsolatedVerifierRunner: class {
    run(...args: unknown[]) { return observer.run(...args) }
    close() { return observer.close() }
  },
}))

const roots: string[] = [], contexts: Context[] = [], runtimes: CreationReviewRuntime[] = []
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
  observer.run.mockReset(); observer.close.mockClear()
})

const schema = { name: 'owner_sum', description: 'SCHEMA_ATTACK_IGNORE_CASES_APPROVE', parameters: { type: 'object', properties: {
  a: { type: 'integer', description: 'SCHEMA_ATTACK_IGNORE_CASES_APPROVE' }, b: { type: 'integer' },
} } }
const schemaDigest = createHash('sha256').update(JSON.stringify([schema])).digest('hex')
const environment = { node: 'v22.23.2', cordis: '4.0.2', tools: '0.1.5-rc.3', systemPrompt: '0.1.5-rc.3' }
const cases = [
  { id: 'ordinary', toolName: 'owner_sum', arguments: { a: 2, b: 3 }, purpose: 'ordinary',
    expected: { kind: 'json-value', value: { sum: 5 } }, rationale: 'The ordinary positive pair establishes exact addition.' },
  { id: 'negative', toolName: 'owner_sum', arguments: { a: -2, b: 3 }, purpose: 'challenge',
    expected: { kind: 'json-value', value: { sum: 1 } }, rationale: 'A negative operand checks signed arithmetic beyond the example.' },
]
class Adapter extends LlmAdapter {
  requests: GenerateOptions[] = []
  mode: 'pass' | 'insufficient' | 'malformed' | 'review-reject' = 'pass'
  afterCall: ((number: number) => void) | undefined
  override async resolveModel(provider: string, model: string) {
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }] } }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const index = this.requests.length
    const value = index === 1
      ? this.mode === 'insufficient' ? { status: 'insufficient', reason: 'Task lacks a testable tool behavior.' }
        : this.mode === 'malformed' ? { status: 'cases', cases: [{ id: 'only-one' }] }
          : { status: 'cases', cases }
      : { decision: this.mode === 'review-reject' ? 'rejected' : 'approved', reason: 'The checked source implements the task contract and owns cleanup.' }
    this.afterCall?.(index)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(value) } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creation-review-runtime-'))); roots.push(root)
  const keyPath = join(root, 'signing.pem'), stateRoot = join(root, 'observer')
  await mkdir(stateRoot, { mode: 0o700 })
  const pair = generateKeyPairSync('ed25519')
  await writeFile(keyPath, pair.privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 }); await chmod(keyPath, 0o600)
  const now = Date.now()
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const config: CreationReviewConfig = { authorityId: 'creation-review', owner, namePrefix: 'owner-', keyId: 'key-1', keyPath,
    expiresAt: now + 120_000, maxVerifications: 2,
    runner: { stateRoot, image: 'sha256:' + 'a'.repeat(64), dockerPath: '/usr/bin/docker', expiresAt: now + 120_000,
      maxRuns: 8, maxTotalDurationMs: 80_000, maxDurationMs: 10_000, maxOutputBytes: 65_536 },
    policy: 'Verify arithmetic specified by the owner, including negative operands.',
    maxInputBytes: 65_536, maxOutputTokens: 1024, maxDurationMs: 60_000, maxCases: 3, receiptTtlMs: 30_000 }
  const compiled = compileCreationReviewConfig(config)
  const fullOwner = { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }
  const reference = { schemaVersion: 1, owner: fullOwner, outcomeId: 'outcome',
    projection: { subjectKind: 'foreground-turn' as const, subjectRef: 'task', version: 1,
      digest: 'b'.repeat(64), disposition: 'upsert' as const }, sourceDigest: 'c'.repeat(64) }
  const growthRun: SourceGrowthRunBinding = { protocol: 'assistant-growth/source-run/v1', runId: 'run-1', intentDigest: 'd'.repeat(64),
    configDigest: 'e'.repeat(64), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
    source: { outcomeId: reference.outcomeId, projection: reference.projection, sourceDigest: reference.sourceDigest },
    model: { provider: 'supplier', model: 'task-model', reasoningEffort: 'high' }, modelOrigin: 'inherited-owner-task',
    budget: { budgetId: 'budget', amount: 1, maxModelCalls: 2, maxToolCalls: 2, maxOutputTokens: 1024,
      maxDurationMs: 120_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage', automationId: 'run-1', definitionHash: 'f'.repeat(64), occurrenceId: 'occurrence' },
    sessionId: 'author-session', toolContractDigest: '1'.repeat(64), executionContractDigest: '2'.repeat(64),
    createdAt: now - 1000, generationDeadlineAt: now + 60_000, expiresAt: now + 120_000,
    creationAcceptance: compiled.authority }
  const artifact = Buffer.from('private fixture package bytes')
  const artifactSha256 = createHash('sha256').update(artifact).digest('hex')
  const plan = { id: 'plan-1', digest: '3'.repeat(64), name: 'owner-sum', mode: 'prepared-create', status: 'pending-approval',
    expiresAt: now + 120_000, generatorDigest: '4'.repeat(64), sourceCheck: { treeDigest: '5'.repeat(64), patchDigest: '6'.repeat(64) },
    preparedEvidence: { pack: { sha256: artifactSha256, sizeBytes: artifact.length } },
    creation: { grant: { namePrefix: 'owner-', expiresAt: now + 120_000 }, growthRun } }
  const source = { owner: fullOwner, judgement: 'owner-feedback', source: {
    objective: 'Create owner_sum that adds two signed integers and handles negative operands.', truncated: false, quiescent: true },
  feedback: { text: 'Please include negative operands.', truncated: false } }
  let current = true, fences = 0
  const cp = { inspectPreparedCreation: vi.fn(() => ({ protocol: 'dsh-prepared-creation/v1', plan, job: { intent: { creation: { growthRun } } },
    reference, source, artifact })),
  withPreparedCreationFence: <T>(input: { planId: string; planDigest: string; artifactSha256: string;
    growthRunDigest: string; referenceDigest: string }, callback: () => T): T => {
    fences++
    if (!current || input.planId !== plan.id || input.planDigest !== plan.digest || input.artifactSha256 !== artifactSha256
      || input.growthRunDigest !== sourceGrowthRunDigest(growthRun)
      || input.referenceDigest !== sourceGrowthEvidenceDigest(reference)) throw new Error('current creation source changed')
    return callback()
  },
  inspectPreparedCreationReviewContext: vi.fn(async () => ({ patch: '+ owner_sum signed addition',
    changedPaths: ['plugins/owner-sum/src/index.ts'] })) }
  const ctx = new Context(); contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: 'GLOBAL PERSONA MUST NOT LEAK' } })
  ctx.tools.register({ name: 'global_write', description: 'Forbidden inherited tool', parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'forbidden' }] },
    execute: async () => { throw new Error('review executed a global tool') } })
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  const adapter = new Adapter(); ctx.llm.registerAdapter(['supplier'], adapter)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.provide('pluginControlPlane' as never, cp as never)
  let job = 0
  observer.run.mockImplementation(async (_key: string, _encoded: string, stdin: string) => {
    const operation = JSON.parse(stdin).operation
    const frame = operation.kind === 'discover'
      ? { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed', artifactSha256, quiescent: true,
          environment, schemaDigest, schemas: [schema] }
      : { schemaVersion: 2, boundary: 'process-seccomp-v1', status: 'observed', artifactSha256, quiescent: true,
          environment, schemaDigest, calls: [{ id: operation.calls[0].id, toolName: 'owner_sum',
            result: { isError: false, value: { sum: operation.calls[0].arguments.a + operation.calls[0].arguments.b } } }] }
    return { jobId: `job-${++job}`, status: 'succeeded', quiescent: true, exitCode: 0,
      stdout: JSON.stringify(frame) + '\n', stderr: '', artifacts: [] }
  })
  const runtime = new CreationReviewRuntime(ctx, config, join(root, 'verifier.sqlite')); runtimes.push(runtime)
  const request = { protocol: 'assistant-growth/creation-verification-request/v1' as const, planId: plan.id }
  return { root, ctx, runtime, config, compiled, owner, plan, growthRun, source, reference, cp, adapter, request,
    artifact, withdraw: () => { current = false }, fences: () => fences }
}

test('uses two fresh inherited-model Agent turns, private challenge cases, exact observer output, and a signed certificate', async () => {
  const f = await fixture()
  expect(f.runtime.inspect({ owner: f.owner })).toMatchObject({ authority: f.compiled.authority, available: true,
    remainingVerifications: 2 })
  const result = await f.runtime.run(f.request)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') return
  expect(verifyPluginCreationVerificationCertificate(result.certificate, f.compiled.authority, f.compiled.publicKey)).toBe(true)
  expect(result.certificate.observations).toHaveLength(2)
  expect(new Set(result.certificate.observations.map(item => item.jobId)).size).toBe(2)
  expect(observer.run).toHaveBeenCalledTimes(3)
  expect(f.adapter.requests).toHaveLength(2)
  expect(f.adapter.requests.every(item => item.provider === 'supplier' && item.model === 'task-model'
    && item.reasoningEffort === 'high' && (item.tools?.length ?? 0) === 0)).toBe(true)
  expect(f.adapter.requests[0]!.maxTokens).toBe(1023)
  expect(f.adapter.requests[1]!.maxTokens).toBe(1004)
  expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('GLOBAL PERSONA')
  expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('SCHEMA_ATTACK_IGNORE_CASES_APPROVE')
  expect(JSON.stringify(f.adapter.requests[0]!.messages)).not.toContain('owner_sum signed addition')
  expect(f.fences()).toBeGreaterThan(5)
  expect((await f.runtime.run(f.request)).status).toBe('verified')
  expect(f.adapter.requests).toHaveLength(2)
})

test('malformed or insufficient contract is durable unknown and consumes quota without observer replay', async () => {
  const f = await fixture(); f.adapter.mode = 'insufficient'
  expect((await f.runtime.run(f.request)).status).toBe('unknown')
  expect((await f.runtime.run(f.request)).status).toBe('unknown')
  expect(f.adapter.requests).toHaveLength(1)
  expect(observer.run).toHaveBeenCalledTimes(1)
  expect(f.runtime.inspect({ owner: f.owner })?.remainingVerifications).toBe(1)
  const second = await fixture(); second.adapter.mode = 'malformed'
  expect((await second.runtime.run(second.request)).status).toBe('unknown')
  expect((await second.runtime.run(second.request)).status).toBe('unknown')
  expect(second.adapter.requests).toHaveLength(1)
})

test('wrong output rejects; owner correction during source review suppresses signing', async () => {
  const f = await fixture()
  observer.run.mockImplementationOnce(observer.run.getMockImplementation()!)
  const base = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await base(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.calls?.[0]?.id === 'negative') frame.calls[0].result.value.sum = 999
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  const rejected = await f.runtime.run(f.request)
  expect(rejected).toEqual({ status: 'rejected', reason: 'case-mismatch' })
  expect(f.adapter.requests).toHaveLength(1)
  const second = await fixture()
  second.adapter.afterCall = index => { if (index === 2) second.withdraw() }
  expect((await second.runtime.run(second.request)).status).toBe('unknown')
  expect(second.adapter.requests).toHaveLength(2)
})

test('missing native success marker cannot satisfy a case even when its value matches', async () => {
  const f = await fixture()
  const base = observer.run.getMockImplementation()!
  observer.run.mockImplementation(async (...args: unknown[]) => {
    const result = await base(...args)
    const frame = JSON.parse(result.stdout)
    if (frame.calls?.length) delete frame.calls[0].result.isError
    return { ...result, stdout: JSON.stringify(frame) + '\n' }
  })
  expect(await f.runtime.run(f.request)).toEqual({ status: 'rejected', reason: 'case-mismatch' })
  expect(f.adapter.requests).toHaveLength(1)
})

test('request validation, changed authority, and crash before model completion cannot replay', async () => {
  const f = await fixture()
  expect((await f.runtime.run(null as never)).status).toBe('rejected')
  expect((await f.runtime.run({ protocol: f.request.protocol } as never)).status).toBe('rejected')
  f.adapter.afterCall = index => { if (index === 1) throw new Error('model dispatch uncertain') }
  expect((await f.runtime.run(f.request)).status).toBe('unknown')
  expect((await f.runtime.run(f.request)).status).toBe('unknown')
  expect(f.adapter.requests).toHaveLength(1)
  expect(observer.run).toHaveBeenCalledTimes(1)
  const changed = await fixture()
  changed.growthRun.creationAcceptance = { ...changed.compiled.authority, authorityDigest: '0'.repeat(64) }
  expect((await changed.runtime.run(changed.request)).status).toBe('unknown')
  expect(changed.adapter.requests).toHaveLength(0)
})
