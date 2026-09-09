import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FileTools from '@deepseek-ai/dsh-tool-fs'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import { Context } from '@deepseek-ai/cordis'
import { Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { generateKeyPairSync, createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, test } from 'vitest'
import { createTaskAcceptanceContract, createTaskVerificationReceipt } from '@dsh-enhanced/task-acceptance-contract'
import { AssistantSkillsService } from '../src/service.ts'
import { generatorDigest } from '../src/prospective-holdout.ts'

const cleanups: (() => Promise<void>)[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const cli = fileURLToPath(new URL('../lib/holdout-cli.js', import.meta.url))
const candidateImage = process.env.DSH_HOLDOUT_TEST_IMAGE ?? ''
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
  await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FsPolicy); await ctx.plugin(FileTools)
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

test.skipIf(!/^sha256:[a-f0-9]{64}$/u.test(candidateImage))('real prospective CLI qualification enters canary once and retries without another authority process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-holdout-positive-')), stateRoot = await mkdtemp(join(tmpdir(), 'external-holdout-positive-state-'))
  await chmod(stateRoot, 0o700); cleanups.push(() => rm(root, { recursive: true, force: true }), () => rm(stateRoot, { recursive: true, force: true }))
  const keyPair = generateKeyPairSync('ed25519')
  const key = join(root, 'key.pem'), authorityConfig = join(root, 'authority.json'), marker = join(root, 'starts'), hook = join(root, 'mark-start.mjs')
  await writeFile(key, keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  await writeFile(authorityConfig, JSON.stringify({ prospective: { generator: 'order-summary/v1' }, privateKeyPath: key, statePath: join(root, 'authority.sqlite'), limits: { maxToolCalls: 2, maxOutputBytes: 1024 } }), { mode: 0o600 })
  await writeFile(hook, `import { appendFileSync } from 'node:fs'; appendFileSync(${JSON.stringify(marker)}, 'x')`, { mode: 0o600 })
  const ctx = new Context(), owner = agent(ctx, root), scope = { principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, preset: 'primary' }
  cleanups.push(() => ctx.fiber.restart()); ctx.provide('agents' as never, { get: () => owner, list: () => [owner] } as never)
  const route = { authorityId: 'owner-route', principalId: 'owner', principalRecordId: 'record', principalVersion: 1, workspace: root, agentPreset: 'primary', bindingVersion: 1, generation: 1 }
  ctx.provide('assistantDelivery' as never, { preferencePrincipalForAgent: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), currentPreferenceTurn: () => ({ principalId: 'owner', principalLineage: { principalRecordId: 'record', principalVersion: 1 }, scope: { workspace: root, preset: 'primary' } }), validateOwnerRoute: (input: typeof route) => input.authorityId === route.authorityId && input.principalId === route.principalId && input.workspace === route.workspace && input.agentPreset === route.agentPreset ? route : undefined } as never)
  let policyAllowed = true
  ctx.provide('assistantPolicy' as never, { evaluateAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorizeAgent: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), evaluate: () => ({ effect: policyAllowed ? 'allow' : 'deny' }), authorize: () => ({ effect: policyAllowed ? 'allow' : 'deny' }) } as never)
  const source = { protocol: 'assistant-goals/verified-workflow-source/v1' as const, scope, goal: { id: 'goal', definition: { version: 1, digest: digest('goal'), objective: 'synthetic echo' }, sessionId: String(owner.session.id), nativeGoalId: 'native' }, runId: 'run', turn: 1, acceptance: { contractId: 'contract', contractDigest: digest('contract'), receiptDigest: digest('receipt'), verifiedAt: Date.now(), validUntil: Date.now() + 60000 }, steps: [{ id: 'write', toolName: 'write', arguments: { file_path: 'result.sh', content: 'printf wrong' } }], failedObservations: [] }
  const snapshots = new Map<string, unknown>()
  ctx.provide('assistantVerifier' as never, {} as never)
  ctx.provide('assistantGoals' as never, { inspectVerifiedWorkflowSource: () => source,
    inspectWorkflowRunContext: (_agent: Agent, goalId: string) => ({ scope, goalId, sessionId: String(owner.session.id), goalExecutionRunId: `execution-${goalId}`, nativeGoalId: `native-${goalId}`, definition: { version: 1, digest: digest(goalId) } }),
    inspectOwnerGoalExecution: (input: { goalId: string }) => snapshots.get(input.goalId) ?? {} } as never)
  // Explicit independent-acceptance fixtures exercise the production watch consumer.
  // CLI qualification above/below executes real programs; these Goal outcomes do not claim a real verifier run.
  const acceptRun = (run: { goalId: string; goalExecutionRunId: string }, achieved: boolean) => {
    const now = Date.now(), goal = { id: run.goalId, definitionVersion: 1, definitionDigest: digest(run.goalId), sessionId: String(owner.session.id), nativeGoalId: `native-${run.goalId}` }
    const contract = createTaskAcceptanceContract({ protocol: 'task-acceptance/v3', id: `outcome-${run.goalId}`, task: { kind: 'goal-outcome', ref: `assessment-${run.goalId}`, goal: { ...goal, assessmentId: `assessment-${run.goalId}` } },
      scope: { workspace: root, preset: 'primary' }, owner: { principalRecordId: 'record', principalVersion: 1 }, objective: 'Fixture: verify the reused result', profile: { id: 'fixture', version: 1, digest: digest('fixture') },
      criteria: [{ id: 'result', kind: 'target-readback', authority: { id: 'fixture', digest: digest('fixture') }, objectId: 'output', expected: [{ pointer: '/ready', value: true }] }], issuedAt: now - 1000, expiresAt: now + 60000, bounds: { maxDurationMs: 1000, maxEvidenceBytes: 4096 } })
    const receipt = createTaskVerificationReceipt(contract, { protocol: 'task-verification/v3', id: `receipt-${run.goalId}`, contractId: contract.id, contractDigest: contract.digest, scope: contract.scope, owner: contract.owner, task: contract.task,
      results: [{ criterionId: 'result', status: achieved ? 'passed' : 'failed', reason: 'explicit-engineering-fixture', evidence: [] }], startedAt: now, completedAt: now, validUntil: now + 60000 })
    const execution = { status: 'succeeded', quiescent: true, completedAt: now }
    snapshots.set(run.goalId, { storedGoal: { id: run.goalId, scope, definition: { version: 1, digest: goal.definitionDigest }, nativeAtLastObservation: { sessionId: goal.sessionId, goalId: goal.nativeGoalId } },
      executionRuns: [{ intent: { runId: run.goalExecutionRunId, scope, task: { kind: 'goal-step', goal } }, dispatchedAt: now - 1000, execution }],
      outcomeAssessments: [{ triggerRunId: run.goalExecutionRunId, contract, dispatchedAt: now - 1000, execution }],
      acceptedTasks: [{ contractId: contract.id, state: 'done', contract, receipt, verifierExecutionObservation: { ...execution, executionRef: contract.task.ref } }] })
    ctx.emit('assistant-verifier/receipt', { taskKind: 'goal-outcome' } as never)
  }

  await ctx.plugin(SystemPrompt); await ctx.plugin(ToolRuntime, { mode: 'native' }); await ctx.plugin(SkillRegistry)
  await ctx.plugin(LocalFileSystem, { cwd: root }); await ctx.plugin(FsPolicy); await ctx.plugin(FileTools)
  const config = { databasePath: join(root, 'skills.sqlite'), allowedTools: ['read', 'write'], externalHoldouts: [{ id: 'positive', version: 1, scope, execution: { image: candidateImage, dockerPath: '/usr/bin/docker', stateRoot, command: '/bin/sh /workspace/artifact < /workspace/input', artifactPath: 'result.sh', expiresAt: Date.now() + 120000, repeats: 2, maxToolCalls: 2, maxBytes: 4096, maxOutputBytes: 1024, cellDurationMs: 20000, verificationDurationMs: 10000 }, authority: { executable: process.execPath, args: ['--import', hook, cli, '--config', authorityConfig], publicKey: keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(), generatorDigest }, maxComparisons: 1 as const }] }
  let plugin = await ctx.plugin(AssistantSkillsService, config); cleanups.push(() => plugin.dispose())
  const execute = (name: string, toolArguments: object) => owner.ctx.get('tools')!.execute({ callId: ToolCallId(`call-${Math.random()}`), name, arguments: toolArguments, signal: new AbortController().signal, agent: owner })
  const json = async (name: string, toolArguments: object) => JSON.parse(((await execute(name, toolArguments)).value as { context: string }).context)
  await json('skill_save', { goal_id: 'goal', name: 'saved', description: 'save', bindings_json: '[]', expected_version: 0 }); source.steps[0]!.arguments = { file_path: 'result.sh', content: "node -e 'let s=\"\";process.stdin.on(\"data\",c=>s+=c).on(\"end\",()=>{const t={};for(const o of JSON.parse(s))if(o.status!==\"cancelled\")t[o.currency]=(t[o.currency]||0)+o.cents;const r={};for(const k of Object.keys(t).sort())r[k]=t[k];process.stdout.write(JSON.stringify(r)+\"\\n\")})'" }
  const candidate = await json('skill_candidate', { goal_id: 'goal', name: 'saved', description: 'candidate', bindings_json: '[]', parent_version: 1, reason: 'synthetic test', trigger: 'test' })
  const expiresAt = Date.now() + 60000
  const completed = await execute('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 }); expect(completed.isError).toBe(false)
  const deployed = JSON.parse((completed.value as { context: string }).context)
  expect(deployed).toMatchObject({ replayed: false, definition: { version: 2 }, deployment: { state: 'canary', comparisonId: expect.any(String), ownerRouteId: route.authorityId } })
  expect(await readFile(marker, 'utf8')).toBe('x'); expect(await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).toMatchObject({ id: deployed.deployment.id, state: 'canary' })
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  expect(await json('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 })).toMatchObject({ replayed: true, deployment: { id: deployed.deployment.id, state: 'canary' } }); expect(await readFile(marker, 'utf8')).toBe('x')
  const firstRun = await json('skill_run', { goal_id: 'canary-goal', name: 'saved', version: 2, inputs_json: '{}', invocation_id: 'first-use' })
  expect(firstRun.state).toBe('succeeded'); expect(await readFile(join(root, 'result.sh'), 'utf8')).toContain('JSON.parse')
  expect((await execute('skill_run', { goal_id: 'too-early', name: 'saved', version: 2, inputs_json: '{}', invocation_id: 'too-early' })).isError).toBe(true)
  expect((await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).runIds).toEqual([firstRun.id])
  acceptRun(firstRun, true)
  await expect.poll(async () => (await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).state).toBe('promoted')
  await plugin.dispose(); plugin = await ctx.plugin(AssistantSkillsService, config)
  const laterRun = await json('skill_run', { goal_id: 'later-goal', name: 'saved', version: 2, inputs_json: '{}', invocation_id: 'second-use' })
  expect(laterRun.state).toBe('succeeded')
  expect((await execute('skill_run', { goal_id: 'over-quota', name: 'saved', version: 2, inputs_json: '{}', invocation_id: 'over-quota' })).isError).toBe(true)
  acceptRun(laterRun, false)
  await expect.poll(async () => (await json('skill_deployment_status', { deployment_id: deployed.deployment.id })).state).toBe('rolled-back')
  expect((await json('skill_status', {}))[0].version).toBe(3)
  const retry = await json('skill_canary', { candidate_id: candidate.id, profile_id: 'positive', invocation_id: 'once', owner_route_id: route.authorityId, expires_at: expiresAt, max_runs: 2, canary_runs: 1 })
  expect(retry).toMatchObject({ replayed: true, deployment: { state: 'rolled-back' } })
  expect((await json('skill_status', {}))[0].version).toBe(3); expect(await readFile(marker, 'utf8')).toBe('x')
}, 180000)
