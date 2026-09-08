import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { acceptanceDigest } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantSkillsService } from '../src/service.ts'

const cleanups: (() => Promise<void>)[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cli = fileURLToPath(new URL('../lib/holdout-cli.js', import.meta.url))
const candidateImage = process.env.DSH_ISOLATION_TEST_IMAGE ?? ''
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function agent(ctx: Context, workspace: string): Agent {
  const id = SessionId('external-owner'), session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false, cwd: workspace, agentPreset: 'primary' })
  const value: Agent = { id, options: { provider: 'fixture', model: 'fixture' }, session, inbox: new Inbox(session, { inserted() {}, discarded() {}, claimed() {} }), ctx: undefined as unknown as Context, status: 'idle', cancel() {}, whenIdle: async () => {}, runMaintenance: task => task(new AbortController().signal), send() {}, followup() {}, steer() {}, inject() {} }
  ;(value as unknown as { ctx: Context }).ctx = createScope(ctx, value).ctx; session.append('turn/start', { turn: 1 }); return value
}

test('skill_qualify uses one external process attempt, persists unknown, and does not expose authority configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-holdout-service-')), stateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-state-')), cancelledStateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-cancel-state-'))
  await chmod(stateRoot, 0o700); await chmod(cancelledStateRoot, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(stateRoot, { recursive: true, force: true }), () => rm(cancelledStateRoot, { recursive: true, force: true }))
  const script = join(root, 'authority.mjs'), marker = join(root, 'attempts')
  await writeFile(script, `import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], 'x'); process.stdout.write(JSON.stringify({event:'ready',protocol:'assistant-skills/holdout-ipc/v1'})+'\\n'); for await (const _line of process.stdin) { if (process.argv[3] !== 'hold') process.stdout.write(JSON.stringify({id:'request-1',ok:false})+'\\n') }`, { mode: 0o700 })
  const ctx = new Context(), owner = agent(ctx, root), scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  cleanups.push(() => ctx.fiber.restart())
  ctx.provide('agents' as never, { get: () => owner, list: () => [owner] } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), currentPreferenceTurn: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }) } as never)
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: 'allow' }), authorizeAgent: () => ({ effect: 'allow' }) } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'goal', definition: { version: 1, digest: digest('goal'), objective: 'write' }, sessionId: String(owner.session.id), nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: digest('contract'), receiptDigest: digest('receipt'), verifiedAt: Date.now(), validUntil: Date.now() + 60000 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content: 'printf bad' } }], failedObservations: [] }
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  ctx.tools.register(defineTool({ name: 'write', description: 'fixture', parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'ok' }))
  const keys = generateKeyPairSync('ed25519')
  const execution = { image: `sha256:${'a'.repeat(64)}`, dockerPath: '/usr/bin/docker', command: '/bin/sh /workspace/artifact', artifactPath: 'result.sh', expiresAt: Date.now() + 60000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 1000, verificationDurationMs: 1 }
  const plugin = await ctx.plugin(AssistantSkillsService, { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], externalHoldouts: [{ id: 'external', version: 1, scope, execution: { ...execution, stateRoot }, authority: { executable: process.execPath, args: [script, marker], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: digest('dataset') }, maxComparisons: 1 }, { id: 'cancelled', version: 1, scope, execution: { ...execution, stateRoot: cancelledStateRoot }, authority: { executable: process.execPath, args: [script, marker, 'hold'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: digest('dataset') }, maxComparisons: 1 }] })
  cleanups.push(() => plugin.dispose())
  const execute = (name: string, toolArguments: object, signal = new AbortController().signal) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: toolArguments, signal, agent: owner })
  const json = async (name: string, toolArguments: object) => JSON.parse(((await execute(name, toolArguments)).value as { context: string }).context)
  await json('skill_save', { goal_id: 'goal', name: 'saved', description: 'save', bindings_json: '[]', expected_version: 0 })
  source.steps[0]!.arguments = { file_path: 'result.sh', content: 'cat' }
  const candidate = await json('skill_candidate', { goal_id: 'goal', name: 'saved', description: 'candidate', bindings_json: '[]', parent_version: 1, reason: 'test', trigger: 'test' })
  const first = await execute('skill_qualify', { candidate_id: candidate.id, profile_id: 'external', invocation_id: 'once' })
  expect(first.isError).toBe(true)
  expect(JSON.parse(((await execute('skill_qualify', { candidate_id: candidate.id, profile_id: 'external', invocation_id: 'once' })).value as { context: string }).context)).toMatchObject({ state: 'unknown', candidateId: candidate.id })
  expect(await readFile(marker, 'utf8')).toBe('x')
  const cancelled = new AbortController(), interrupted = execute('skill_qualify', { candidate_id: candidate.id, profile_id: 'cancelled', invocation_id: 'cancel-once' }, cancelled.signal)
  await expect.poll(() => readFile(marker, 'utf8')).toBe('xx'); cancelled.abort(); expect((await interrupted).isError).toBe(true)
  expect(JSON.parse(((await execute('skill_qualify', { candidate_id: candidate.id, profile_id: 'cancelled', invocation_id: 'cancel-once' })).value as { context: string }).context)).toMatchObject({ state: 'unknown', candidateId: candidate.id }); expect(await readFile(marker, 'utf8')).toBe('xx')
  const status = await json('skill_comparison_status', {})
  expect(status).toEqual(expect.arrayContaining([{ id: 'external', version: 1, expiresAt: expect.any(Number), maxComparisons: 1 }, { id: 'cancelled', version: 1, expiresAt: expect.any(Number), maxComparisons: 1 }])); expect(JSON.stringify(status)).not.toMatch(/publicKey|datasetDigest|authority\.mjs|stateRoot/u)
})

test.skipIf(!/^sha256:[a-f0-9]{64}$/u.test(candidateImage)).each(['complete', 'policy-revoked'] as const)('real CLI qualification %s persists across service restart without another authority process', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'external-holdout-positive-')), stateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-positive-state-'))
  await chmod(stateRoot, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(stateRoot, { recursive: true, force: true }))
  const keyPair = generateKeyPairSync('ed25519'), data = { id: 'synthetic-echo', version: '1', cases: ['replay', 'evaluation', 'regression'].map((kind, index) => ({ id: `case-${index}`, kind, stdin: `${kind}\\n`, expectedStdout: `${kind}\\n`, expectedExitCode: 0 })) }
  const key = join(root, 'key.pem'), dataset = join(root, 'dataset.json'), authorityConfig = join(root, 'authority.json'), marker = join(root, 'starts'), hook = join(root, 'mark-start.mjs')
  await writeFile(key, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 }); await writeFile(dataset, JSON.stringify(data), { mode: 0o600 })
  await writeFile(authorityConfig, JSON.stringify({ datasetPath: dataset, privateKeyPath: key, statePath: join(root, 'authority.sqlite'), limits: { maxToolCalls: 2, maxOutputBytes: 1024 } }), { mode: 0o600 })
  const held = join(root, 'cell-held'), release = join(root, 'release-cell')
  await writeFile(hook, `import { appendFileSync, writeFileSync, existsSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x');
    if (${JSON.stringify(scenario)} === 'policy-revoked') { const original = process.stdout.write.bind(process.stdout); process.stdout.write = function(chunk, ...args) { let data; try { data=JSON.parse(String(chunk)) } catch {}
      if (data?.value?.cellId === 'cell-1') { writeFileSync(${JSON.stringify(held)}, 'held'); const timer=setInterval(()=>{ if(existsSync(${JSON.stringify(release)})) {clearInterval(timer);original(chunk,...args)} },10); return true } return original(chunk,...args) } }`, { mode: 0o600 })
  const ctx = new Context(), owner = agent(ctx, root), scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  cleanups.push(() => ctx.fiber.restart()); ctx.provide('agents' as never, { get: () => owner, list: () => [owner] } as never)
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), currentPreferenceTurn: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }) } as never)
  let policyAllowed = true
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorizeAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }) } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'goal', definition: { version: 1, digest: digest('goal'), objective: 'synthetic echo' }, sessionId: String(owner.session.id), nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: digest('contract'), receiptDigest: digest('receipt'), verifiedAt: Date.now(), validUntil: Date.now() + 60000 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content: 'printf wrong' } }], failedObservations: [] }
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source } as never)
  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  ctx.tools.register(defineTool({ name: 'write', description: 'fixture', parameters: { file_path: { type: 'string', required: true }, content: { type: 'string', required: true } }, output: { schema: { type: 'string' }, render: () => [] }, execute: async () => 'ok' }))
  const config = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['write'], externalHoldouts: [{ id: 'positive', version: 1, scope, execution: { image: candidateImage, dockerPath: '/usr/bin/docker', stateRoot, command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 120000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 20000, verificationDurationMs: 10000 }, authority: { executable: process.execPath, args: ['--import', hook, cli, '--config', authorityConfig], publicKey: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), datasetDigest: acceptanceDigest(data) }, maxComparisons: 1 as const }] }
  let plugin = await ctx.plugin(AssistantSkillsService, config); cleanups.push(() => plugin.dispose())
  const execute = (name: string, toolArguments: object) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: toolArguments, signal: new AbortController().signal, agent: owner })
  const json = async (name: string, toolArguments: object) => JSON.parse(((await execute(name, toolArguments)).value as { context: string }).context)
  await json('skill_save', { goal_id: 'goal', name: 'saved', description: 'save', bindings_json: '[]', expected_version: 0 }); source.steps[0]!.arguments = { file_path: 'result.sh', content: 'cat' }
  const candidate = await json('skill_candidate', { goal_id: 'goal', name: 'saved', description: 'candidate', bindings_json: '[]', parent_version: 1, reason: 'synthetic test', trigger: 'test' })
  const pending = execute('skill_qualify', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once' })
  if (scenario === 'policy-revoked') {
    await expect.poll(async () => readFile(held, 'utf8').catch(() => '')).toBe('held')
    policyAllowed = false; await writeFile(release, 'release')
    expect((await pending).isError).toBe(true)
    policyAllowed = true
    const stopped = await json('skill_qualify', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once' })
    expect(stopped).toMatchObject({ state: 'unknown', candidateId: candidate.id })
    await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
    expect(await json('skill_comparison_status', { comparison_id: stopped.id })).toEqual(stopped)
    expect(await readFile(marker, 'utf8')).toBe('x')
    return
  }
  const completed = await pending; expect(completed.isError).toBe(false)
  const qualified = JSON.parse((completed.value as { context: string }).context)
  expect(qualified).toMatchObject({ state: 'complete', candidateId: candidate.id, result: { modelCalls: 0, promotionAuthorized: false, quality: { candidateChecksPassed: true, evaluationGain: 1, criticalRegressionsPassed: true } } })
  expect(await readFile(marker, 'utf8')).toBe('x'); expect(await json('skill_comparison_status', { comparison_id: qualified.id })).toMatchObject({ id: qualified.id, state: 'complete' })
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  expect(await json('skill_qualify', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once' })).toEqual(qualified); expect(await readFile(marker, 'utf8')).toBe('x')
}, 180000)
