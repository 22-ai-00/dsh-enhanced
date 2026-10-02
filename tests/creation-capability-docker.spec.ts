import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sourceGrowthEvidenceDigest, verifyPluginCreationVerificationCertificate } from '@dsh-enhanced/assistant-growth-contract'
import { AssistantPolicyService } from '@dsh-enhanced/assistant-policy'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { CreationCapabilityJournal, verifyCreationCapabilityReceipt } from '../plugins/plugin-control-plane/src/creation-capability-journal.js'
import { CreationCapabilityRuntime } from '../plugins/plugin-control-plane/src/creation-capability-runtime.js'
import type { CreationCapabilityConfig, CreationCapabilityPorts } from '../plugins/plugin-control-plane/src/creation-capability-types.js'
import { compileCreationReviewConfig, type CreationReviewConfig } from '../plugins/assistant-verifier/src/creation-review.js'
import { AssistantVerifierService } from '../plugins/assistant-verifier/src/service.js'

// Actual certificate, exact tgz, Docker observer, SQLite journal, Cordis ToolRuntime
// and native Agent. Task source, model supplier and owner-current ports are fixtures;
// this is not evidence of an ordinary owner deployment or task-quality gain.
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const hash = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')
const cases = [
  { id: 'ordinary-case', purpose: 'ordinary', toolName: 'reverse_text', arguments: { text: 'ordinary' },
    expected: { kind: 'text', text: 'yranidro' }, rationale: 'Reverse Unicode code points.' },
  { id: 'unicode-challenge', purpose: 'challenge', toolName: 'reverse_text', arguments: { text: 'A🐢b' },
    expected: { kind: 'text', text: 'b🐢A' }, rationale: 'Check a distinct mixed Unicode input.' },
]

class Supplier extends LlmAdapter {
  requests: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string) { return { provider, id: model, name: model } }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(this.requests.length === 1
      ? { status: 'cases', cases }
      : { decision: 'approved', reason: 'The implementation reverses Unicode code points for both independent checks.' }) } }
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

async function fixture() {
  const image = process.env.DSH_PLUGIN_OBSERVER_TEST_IMAGE
  expect(image).toMatch(/^sha256:[a-f0-9]{64}$/u)
  const root = await realpath(await mkdtemp(join(tmpdir(), 'creation-capability-docker-')))
  await chmod(root, 0o700)
  const ctx = new Context()
  cleanup.push(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: { personaPrefix: '' }, tools: { mode: 'native' } })
  const expectedAlias = `evolved_owner_reverse_${hash('created-plan').slice(0, 8)}_0`
  await ctx.plugin(AssistantPolicyService, { databasePath: join(root, 'policy.sqlite'), toolDefaultEffect: 'deny',
    rules: [{ id: 'allow-exact-created-alias', effect: 'allow', actions: ['execute'],
      resource: { kind: 'tool', id: expectedAlias } },
    { id: 'allow-existing-probe', effect: 'allow', actions: ['execute'],
      resource: { kind: 'tool', id: 'ordinary_probe' } }] })
  const supplier = new Supplier()
  ctx.llm.registerAdapter(['creation-supplier'], supplier)
  await ctx.plugin(AgentLoop, { agents: [] })
  const owner = { authorityId: 'route', authorityHash: 'a'.repeat(64), principalId: 'owner', principalRecordId: 'record',
    principalVersion: 1, workspace: root, agentPreset: 'main' }
  const reviewerKey = join(root, 'review-signing.pem'), adoptionKey = join(root, 'adoption-signing.pem')
  await writeFile(reviewerKey, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(adoptionKey, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const reviewRoot = join(root, 'review-runner'), adoptionRoot = join(root, 'adoption-runner')
  await mkdir(reviewRoot, { mode: 0o700 }); await mkdir(adoptionRoot, { mode: 0o700 })
  const now = Date.now(), expiresAt = now + 600_000
  const reviewConfig: CreationReviewConfig = { authorityId: 'independent-review', owner, namePrefix: 'owner-',
    keyId: 'review-key', keyPath: reviewerKey, expiresAt, maxVerifications: 1,
    policy: 'Accept deterministic text processing and a distinct Unicode challenge.',
    runner: { stateRoot: reviewRoot, image: image!, dockerPath: '/usr/bin/docker', expiresAt, maxRuns: 3,
      maxTotalDurationMs: 90_000, maxDurationMs: 30_000, maxOutputBytes: 65_536 },
    maxInputBytes: 65_536, maxOutputTokens: 2048, maxDurationMs: 180_000, maxCases: 2, receiptTtlMs: 300_000 }
  const compiled = compileCreationReviewConfig(reviewConfig)
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
  async execute(args) { return Array.from(args.text).reverse().join('') } })
export default { name: 'owner-reverse', inject: ['tools'], apply(ctx) { ctx.tools.register(tool) } }
`
  const artifact = packedPlugin(source)
  const reference = { owner: fullOwner, sourceDigest: growthRun.source.sourceDigest, outcomeId: 'owner-feedback', projection }
  const snapshot = { protocol: 'dsh-prepared-creation/v1',
    plan: { id: 'created-plan', digest: '3'.repeat(64), name: 'owner-reverse', mode: 'prepared-create', status: 'pending-approval',
      expiresAt, generatorDigest: '4'.repeat(64), sourceCheck: { treeDigest: '5'.repeat(64), patchDigest: '6'.repeat(64) },
      preparedEvidence: { pack: { sha256: hash(artifact), sizeBytes: artifact.length } },
      creation: { grant: { namePrefix: 'owner-', expiresAt }, growthRun } },
    job: { intent: { creation: { growthRun } } }, reference,
    source: { owner: fullOwner, judgement: 'owner-feedback', source: {
      objective: 'Provide a tool that reverses text by Unicode code points. Example: ordinary becomes yranidro.',
      truncated: false, quiescent: true } }, artifact }
  ctx.provide('pluginControlPlane' as never, { inspectPreparedCreation: () => snapshot,
    withPreparedCreationFence: (_input: unknown, callback: () => unknown) => callback(),
    inspectPreparedCreationReviewContext: async () => ({ patch: source, changedPaths: ['plugins/owner-reverse/src/index.ts'] }) } as never)
  const verifier = new AssistantVerifierService(ctx, { databasePath: join(root, 'verifier.sqlite'),
    tickIntervalMs: 0, creationReviews: reviewConfig })
  await vi.waitFor(() => expect(verifier.inspectCreationAcceptanceAuthority({ owner })?.available).toBe(true))
  const reviewed = await verifier.verifyPluginCreation({ protocol: 'assistant-growth/creation-verification-request/v1', planId: 'created-plan' })
  expect(reviewed.status, reviewed.status === 'verified' ? '' : reviewed.reason).toBe('verified')
  if (reviewed.status !== 'verified') throw new Error('independent certificate missing')
  const certificate = reviewed.certificate
  expect(verifyPluginCreationVerificationCertificate(certificate, compiled.authority, compiled.publicKey)).toBe(true)
  expect(certificate.observations).toHaveLength(2)
  const capabilityConfig: CreationCapabilityConfig = { authorityId: 'owner-adoption', keyId: 'adoption-key', keyPath: adoptionKey,
    owner, namePrefix: 'owner-', expiresAt, maxAdoptions: 1, maxTools: 2, maxCallsPerAdoption: 2,
    maxCallRecords: 2, maxInputBytes: 1024,
    runner: { stateRoot: adoptionRoot, image: image!, dockerPath: '/usr/bin/docker', expiresAt, maxRuns: 3,
      maxTotalDurationMs: 90_000, maxDurationMs: 30_000, maxOutputBytes: 65_536 } }
  const journalPath = join(root, 'creation-adoptions.sqlite')
  let sourceCurrent = true
  const handle = await ctx.agents.create({ sessionId: SessionId('created-capability-agent'),
    meta: { cwd: root, agentPreset: 'main' }, agentOptions: { provider: 'creation-supplier', model: 'task-model' } })
  cleanup.push(async () => { await handle.dispose() })
  const unbind = ctx.assistantPolicy.bindInitiator(handle.agent, 'background')
  cleanup.push(async () => { unbind() })
  handle.agent.session.append('approval/policy', { policy: 'never' })
  handle.agent.session.append('assistant-policy/approval-reviewer', { reviewer: 'none' })
  const append = handle.agent.session.append as unknown as (type: string, data: unknown) => unknown
  append.call(handle.agent.session, 'sandbox/mode', { mode: 'danger-full-access' })
  const ports: CreationCapabilityPorts = {
    inspect: planId => {
      if (planId !== certificate.plan.id || !sourceCurrent) throw new Error('source corrected or withdrawn')
      return { certificate, artifact, owner }
    },
    recheck: async () => { if (!sourceCurrent) throw new Error('source corrected or withdrawn') },
    withCurrent: (_record, callback) => {
      if (!sourceCurrent) throw new Error('source corrected or withdrawn')
      return callback()
    },
    assertCaller: (_record, execution) => {
      if (!sourceCurrent || execution.agent !== handle.agent || ctx.agents.get(handle.agent.id) !== handle.agent
        || execution.agent.session.id !== handle.agent.session.id) throw new Error('owner Agent is no longer current')
    },
  }
  const journal = () => new CreationCapabilityJournal({ path: journalPath, config: capabilityConfig })
  const runtime = (owned: CreationCapabilityJournal) => new CreationCapabilityRuntime({ ctx, config: capabilityConfig,
    journal: owned, ports })
  const jobs = () => {
    const db = new DatabaseSync(join(adoptionRoot, 'ledger.sqlite'), { readOnly: true })
    try { return (db.prepare('SELECT COUNT(*) AS n FROM isolation_jobs').get() as { n: number }).n }
    finally { db.close() }
  }
  ctx.tools.register({ name: 'ordinary_probe', description: 'Existing native Host tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    execute: async () => 'still alive' })
  return { ctx, owner, handle, supplier, certificate, artifact, expectedAlias, journal, runtime, jobs, source,
    revoke: () => { sourceCurrent = false } }
}

describe.runIf(process.env.DSH_PLUGIN_OBSERVER_REAL_DOCKER === '1')('created capability with real Docker and native tools', () => {
  test('adopts independently checked tgz, serves Unicode calls, persists quota/cache and unloads on correction', async () => {
    const f = await fixture()
    const firstJournal = f.journal()
    const first = f.runtime(firstJournal)
    cleanup.push(async () => { await first.close() })
    await first.start()
    expect(first.eligible('created-plan')).toBe(true)
    await first.adopt('created-plan', new AbortController().signal)
    const adopted = first.inspectStatus('created-plan')
    expect(adopted?.status).toBe('active')
    const alias = adopted!.aliases[0]!
    expect(alias).toBe(f.expectedAlias)
    expect(f.ctx.tools.get(alias)).toBeDefined()
    const receipt = firstJournal.inspect('created-plan')!.receipt!
    expect(verifyCreationCapabilityReceipt(receipt, firstJournal.authorityDigest, firstJournal.publicKey)).toBe(true)
    expect(firstJournal.inspect('created-plan')?.certificate.plan.artifactSha256).toBe(hash(f.artifact))
    const discoveredJobs = f.jobs()
    expect(discoveredJobs).toBe(1)
    const call = async (callId: string, text: string) => f.handle.agent.ctx.tools.execute({
      callId: callId as never, name: alias, arguments: { text }, agent: f.handle.agent,
      signal: new AbortController().signal })
    const unicode = await call('unicode-1', 'A🐢b')
    expect(unicode.isError, unicode.isError ? unicode.error.message : '').toBe(false)
    if (unicode.isError) throw new Error('native created tool did not return a value')
    expect(unicode.value).toEqual({ value: 'b🐢A', content: [{ type: 'text', text: 'b🐢A' }] })
    expect(f.jobs()).toBe(discoveredJobs + 1)
    const repeated = await call('unicode-1', 'A🐢b')
    expect(repeated.isError).toBe(false)
    expect(f.jobs()).toBe(discoveredJobs + 1)
    const changedArguments = await call('unicode-1', 'different input')
    expect(changedArguments.isError).toBe(true)
    expect(f.jobs()).toBe(discoveredJobs + 1)
    const ordinary = await call('ordinary-2', 'ordinary')
    expect(ordinary.isError).toBe(false)
    if (!ordinary.isError) expect(ordinary.value).toEqual({ value: 'yranidro', content: [{ type: 'text', text: 'yranidro' }] })
    expect(f.jobs()).toBe(discoveredJobs + 2)
    const overQuota = await call('third-3', 'another')
    expect(overQuota.isError).toBe(true)
    expect(f.jobs()).toBe(discoveredJobs + 2)
    await first.close()
    const secondJournal = f.journal()
    const second = f.runtime(secondJournal)
    cleanup.push(async () => { await second.close() })
    await second.start()
    expect(second.inspectStatus('created-plan')).toMatchObject({ status: 'active', aliases: [alias] })
    expect(second.eligible('created-plan')).toBe(false)
    expect(f.jobs()).toBe(discoveredJobs + 2)
    const cachedAfterRestart = await call('unicode-1', 'A🐢b')
    expect(cachedAfterRestart.isError).toBe(false)
    expect(f.jobs()).toBe(discoveredJobs + 2)
    f.revoke()
    const corrected = await call('unicode-1', 'A🐢b')
    expect(corrected.isError).toBe(true)
    expect(f.jobs()).toBe(discoveredJobs + 2)
    await second.reconcile()
    expect(second.inspectStatus('created-plan')?.status).toBe('closed')
    expect(f.ctx.tools.get(alias)).toBeUndefined()
    expect(f.ctx.tools.get('ordinary_probe')).toBeDefined()
    const probe = await f.handle.agent.ctx.tools.execute({ callId: 'ordinary-probe' as never, name: 'ordinary_probe',
      arguments: {}, agent: f.handle.agent, signal: new AbortController().signal })
    expect(probe.isError).toBe(false)
    if (!probe.isError) expect(probe.value).toBe('still alive')
    expect(f.jobs()).toBe(discoveredJobs + 2)
    expect(f.supplier.requests).toHaveLength(2)
  }, 300_000)
})
