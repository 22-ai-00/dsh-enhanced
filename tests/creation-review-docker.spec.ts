import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { sourceGrowthEvidenceDigest, verifyPluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { compileCreationReviewConfig, type CreationReviewConfig } from '../plugins/assistant-verifier/src/creation-review.js'
import { AssistantVerifierService } from '../plugins/assistant-verifier/src/service.js'

// Real native Agent + packaged plugin + actual process observer. Task source and
// supplier are controlled regression fixtures; this does not prove ordinary-use
// quality, Control Plane preparation, owner authorization or deployment.
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

const cases = [
  { id: 'ordinary-case', purpose: 'ordinary', toolName: 'reverse_text', arguments: { text: 'ordinary' },
    expected: { kind: 'text', text: 'yranidro' }, rationale: 'Reverse the task example by Unicode code points.' },
  { id: 'unicode-challenge', purpose: 'challenge', toolName: 'reverse_text', arguments: { text: 'A🐢b' },
    expected: { kind: 'text', text: 'b🐢A' }, rationale: 'An unseen mixed Unicode input checks the requested code-point behavior.' },
]
class Supplier extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(this.requests.length === 1
      ? { status: 'cases', cases }
      : { decision: 'approved', reason: 'Task specifies code-point reversal; cases and the scoped plugin agree.' }) } }
    yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 200 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function packedPlugin(source: string): Buffer {
  const entries = { 'package/package.json': JSON.stringify({ name: 'owner-reverse', version: '0.1.0', type: 'module', main: './lib/index.js' }),
    'package/lib/index.js': source }
  const records: Buffer[] = []
  for (const [name, text] of Object.entries(entries)) {
    const bytes = Buffer.from(text), header = Buffer.alloc(512)
    header.write(name); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136)
    header.fill(32, 148, 156); header.write('0', 156); header.write('ustar\0', 257); header.write('00', 263)
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}
async function fixture(broken: boolean) {
  const image = process.env.DSH_PLUGIN_OBSERVER_TEST_IMAGE
  expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creation-review-docker-'))), ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), rules: [] })
  const supplier = new Supplier()
  ctx.llm.registerAdapter(['creation-supplier'], supplier)
  await ctx.plugin(AgentLoop, { agents: [] })
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const keyPath = join(root, 'signing.pem')
  await writeFile(keyPath, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const now = Date.now(), expiresAt = now + 600_000
  const config: CreationReviewConfig = { authorityId: 'creation-review', owner, namePrefix: 'owner-', keyId: 'review-key', keyPath,
    expiresAt, maxVerifications: 1, policy: 'Accept only deterministic text processing; require distinct inputs and a Unicode challenge.',
    runner: { stateRoot: root, image: image!, dockerPath: '/usr/bin/docker', expiresAt, maxRuns: 3,
      maxTotalDurationMs: 90_000, maxDurationMs: 30_000, maxOutputBytes: 65_536 },
    maxInputBytes: 65_536, maxOutputTokens: 2048, maxDurationMs: 180_000, maxCases: 2, receiptTtlMs: 60_000 }
  const compiled = compileCreationReviewConfig(config)
  const fullOwner = { ...owner, receiptVersion: 2, bindingVersion: 1, generation: 1 }
  const projection = { subjectKind: 'foreground-turn' as const, subjectRef: 'ordinary-task', version: 1,
    digest: 'b'.repeat(64), disposition: 'upsert' as const }
  const model = { provider: 'creation-supplier', model: 'task-model' }
  const growthRun = { protocol: 'assistant-growth/source-run/v1' as const, runId: 'source-growth', intentDigest: 'c'.repeat(64),
    configDigest: 'd'.repeat(64), ownerDigest: sourceGrowthEvidenceDigest(fullOwner),
    source: { outcomeId: 'owner-feedback', projection, sourceDigest: 'e'.repeat(64) }, model,
    modelOrigin: 'inherited-owner-task' as const, creationAcceptance: compiled.authority,
    budget: { budgetId: 'growth-budget', amount: 1, maxModelCalls: 3, maxToolCalls: 5, maxOutputTokens: 2048,
      maxDurationMs: 30_000, maxPlansPerWake: 1 },
    native: { owner: 'assistant-growth-usage' as const, automationId: 'source-growth', definitionHash: 'f'.repeat(64), occurrenceId: 'occurrence' },
    sessionId: 'author-session', toolContractDigest: '1'.repeat(64), executionContractDigest: '2'.repeat(64),
    createdAt: now, generationDeadlineAt: now + 30_000, expiresAt }
  const source = `import { defineTool } from '@deepseek-ai/dsh-tools'
const tool = defineTool({ name: 'reverse_text', description: 'Reverse text by Unicode code points.',
  parameters: { text: { type: 'string', required: true } },
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args) { return ${broken ? "'yranidro'" : "Array.from(args.text).reverse().join('')"} } })
export default { name: 'owner-reverse', inject: ['tools'], apply(ctx) { ctx.tools.register(tool) } }
`
  const artifact = packedPlugin(source)
  const reference = { owner: fullOwner, sourceDigest: growthRun.source.sourceDigest, outcomeId: 'owner-feedback', projection }
  const snapshot = { protocol: 'dsh-prepared-creation/v1',
    plan: { id: 'created-plan', digest: '3'.repeat(64), name: 'owner-reverse', mode: 'prepared-create', status: 'pending-approval',
      expiresAt, generatorDigest: '4'.repeat(64), sourceCheck: { treeDigest: '5'.repeat(64), patchDigest: '6'.repeat(64) },
      preparedEvidence: { pack: { sha256: createHash('sha256').update(artifact).digest('hex'), sizeBytes: artifact.length } },
      creation: { grant: { namePrefix: 'owner-', expiresAt }, growthRun } },
    job: { intent: { creation: { growthRun } } }, reference,
    source: { owner: fullOwner, judgement: 'owner-feedback', source: {
      objective: 'Provide a tool that reverses text by Unicode code points. Example: ordinary becomes yranidro.', truncated: false, quiescent: true } }, artifact }
  const fence = vi.fn((_input: unknown, callback: () => unknown) => callback())
  const reviewContext = vi.fn(async () => ({ patch: source, changedPaths: ['plugins/owner-reverse/src/index.ts'] }))
  ctx.provide('pluginControlPlane' as never, { inspectPreparedCreation: () => snapshot,
    withPreparedCreationFence: fence, inspectPreparedCreationReviewContext: reviewContext } as never)
  const service = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'), tickIntervalMs: 0, creationReviews: config })
  await vi.waitFor(() => expect(service.inspectCreationAcceptanceAuthority({ owner })?.available).toBe(true))
  return { service, supplier, compiled, reviewContext, fence, artifact }
}

describe.runIf(process.env.DSH_PLUGIN_OBSERVER_REAL_DOCKER === '1')('task-derived creation verification with real Docker', () => {
  test('signs actual outputs from independent candidate processes and reuses the durable certificate', async () => {
    const f = await fixture(false)
    const request = { protocol: 'assistant-growth/creation-verification-request/v1' as const, planId: 'created-plan' }
    const result = await f.service.verifyPluginCreation(request)
    expect(result.status, result.status === 'verified' ? '' : result.reason).toBe('verified')
    if (result.status !== 'verified') throw new Error('certificate missing')
    expect(verifyPluginCreationVerificationCertificate(result.certificate, f.compiled.authority, f.compiled.publicKey)).toBe(true)
    expect(result.certificate.observations).toHaveLength(2)
    expect(new Set(result.certificate.observations.map(row => row.jobId)).size).toBe(2)
    expect(result.certificate.plan.artifactSha256).toBe(createHash('sha256').update(f.artifact).digest('hex'))
    expect(f.supplier.requests).toHaveLength(2)
    expect(f.supplier.requests.every(request => request.provider === 'creation-supplier' && request.model === 'task-model'
      && (request.tools?.length ?? 0) === 0)).toBe(true)
    expect(JSON.stringify(f.supplier.requests[0]!.messages)).not.toContain('async execute')
    expect(f.reviewContext).toHaveBeenCalledTimes(1)
    expect(await f.service.verifyPluginCreation(request)).toEqual(result)
    expect(f.supplier.requests).toHaveLength(2)
  }, 180_000)

  test('rejects an implementation that memorizes the source example but fails the private challenge', async () => {
    const f = await fixture(true)
    const result = await f.service.verifyPluginCreation({ protocol: 'assistant-growth/creation-verification-request/v1', planId: 'created-plan' })
    expect(result.status).toBe('rejected')
    expect(result.status !== 'verified' && result.reason).toBe('case-mismatch')
    expect(f.supplier.requests).toHaveLength(1)
    expect(f.reviewContext).not.toHaveBeenCalled()
  }, 180_000)
})
